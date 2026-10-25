/**
 * Bounded Watcher evaluation (pnpm eval:watcher).
 * For every samples/videos/<id>.webm with a matching samples/<id>/expected.json:
 *   extract frames -> run the Watcher live -> compare first_failure_timestamp_s
 *   against the fixture within ±2s, and check the defect was identified at all.
 * Missing videos, missing ffmpeg, or a missing/unauthorized key are reported as
 * BLOCKED and never counted as model failures.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VideoProcessor } from '../packages/video/src/index.js';
import { analyzeBugVideo, MAX_FRAMES_PER_REQUEST, resolveApiKey, WatcherFrame } from '../packages/agents/src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal .env loader (dotenv is not a dependency of every host package). */
async function loadEnvFile(envPath: string): Promise<void> {
  try {
    const raw = await fs.readFile(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // no .env — environment must come from the process
  }
}
const SAMPLES_DIR = path.join(ROOT, 'samples');
const VIDEOS_DIR = path.join(SAMPLES_DIR, 'videos');
const TOLERANCE_S = 2.0;

interface ExpectedFixture {
  id: string;
  title: string;
  failure_timestamp_s: number;
}

async function loadFixtures(): Promise<Map<string, ExpectedFixture>> {
  const map = new Map<string, ExpectedFixture>();
  const entries = await fs.readdir(SAMPLES_DIR, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const fixturePath = path.join(SAMPLES_DIR, e.name, 'expected.json');
    const rawText = await fs.readFile(fixturePath, 'utf8').catch(err => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; // e.g. samples/videos/
      throw err;
    });
    if (rawText === null) continue;
    try {
      const raw = JSON.parse(rawText) as ExpectedFixture;
      map.set(raw.id ?? e.name, raw);
    } catch {
      console.error(`MAP ERROR: cannot parse fixture ${fixturePath}`);
      process.exitCode = 1;
    }
  }
  return map;
}

async function loadVideos(): Promise<string[]> {
  try {
    const files = await fs.readdir(VIDEOS_DIR);
    return files.filter(f => f.endsWith('.webm') || f.endsWith('.mp4')).sort();
  } catch {
    return [];
  }
}

function videoId(fileName: string): string {
  return path.basename(fileName, path.extname(fileName));
}

async function main() {
  await loadEnvFile(path.join(ROOT, '.env'));
  console.log('=== Watcher Evaluation (±2s tolerance) ===');
  const fixtures = await loadFixtures();
  const videos = await loadVideos();

  // Mapping: every video must map to exactly one fixture
  let mapErrors = 0;
  for (const v of videos) {
    const id = videoId(v);
    if (!fixtures.has(id)) {
      console.error(`MAP ERROR: video ${v} has no samples/${id}/expected.json fixture`);
      mapErrors++;
    }
  }
  if (mapErrors > 0) process.exitCode = 1;

  const withVideos = [...fixtures.values()].filter(f => videos.some(v => videoId(v) === f.id));
  const withoutVideos = [...fixtures.values()].filter(f => !videos.some(v => videoId(v) === f.id));
  for (const f of withoutVideos) {
    console.log(`BLOCKED  ${f.id}: no video in samples/videos/ — not evaluated (not a model failure)`);
  }

  if (withVideos.length === 0) {
    console.log('\nNo evaluable samples (videos missing). Nothing to run.');
    return;
  }

  // Prerequisites — BLOCKED, not failure, when absent
  if (!(await VideoProcessor.checkFfmpeg())) {
    for (const f of withVideos) console.log(`BLOCKED  ${f.id}: ffmpeg not installed — frame extraction impossible`);
    console.log('\nResult: 0 evaluated, all BLOCKED on missing ffmpeg.');
    return;
  }
  if (!resolveApiKey('watcher')) {
    for (const f of withVideos) console.log(`BLOCKED  ${f.id}: no watcher API key configured`);
    console.log('\nResult: 0 evaluated, all BLOCKED on missing credential.');
    return;
  }

  // One live Watcher run per sample — no retries, no repeats
  let pass = 0;
  let fail = 0;
  let blocked = 0;
  for (const fixture of withVideos) {
    const videoPath = path.join(VIDEOS_DIR, videos.find(v => videoId(v) === fixture.id)!);
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `replay-eval-${fixture.id}-`));
    try {
      const frames = await VideoProcessor.extractFrames(videoPath, tmp);
      let selected: WatcherFrame[] = frames.map(f => ({
        timestampS: f.timestampS,
        jpegBase64: '', // filled below
      }));
      if (selected.length > MAX_FRAMES_PER_REQUEST) {
        const stride = Math.ceil(selected.length / MAX_FRAMES_PER_REQUEST);
        selected = selected.filter((_, i) => i % stride === 0);
      }
      const withBytes: WatcherFrame[] = [];
      for (const f of frames) {
        if (!selected.some(s => s.timestampS === f.timestampS)) continue;
        const b64 = (await fs.readFile(f.filePath)).toString('base64');
        withBytes.push({ timestampS: f.timestampS, jpegBase64: b64 });
      }
      const result = await analyzeBugVideo({ frames: withBytes, route: `/?bug=${fixture.id}` });
      const dt = Math.abs(result.report.first_failure_timestamp_s - fixture.failure_timestamp_s);
      const identified = result.report.defect_found;
      const tsOk = dt <= TOLERANCE_S;
      if (identified && tsOk) {
        pass++;
        console.log(`PASS     ${fixture.id}: defect found, failure t=${result.report.first_failure_timestamp_s}s (expected ${fixture.failure_timestamp_s}s, Δ${dt.toFixed(1)}s), confidence ${result.report.confidence}`);
      } else {
        fail++;
        console.log(`FAIL     ${fixture.id}: ${identified ? `failure t=${result.report.first_failure_timestamp_s}s Δ${dt.toFixed(1)}s > ${TOLERANCE_S}s` : 'defect_found=false'} — "${result.report.summary.slice(0, 60)}"`);
      }
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (/401|403|429|503|ResourceExhausted|rate/i.test(msg)) {
        blocked++;
        console.log(`BLOCKED  ${fixture.id}: provider unavailable — ${msg.slice(0, 100)}`);
      } else {
        fail++;
        console.log(`FAIL     ${fixture.id}: ${msg.slice(0, 120)}`);
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  console.log(`\nResult: ${pass} pass, ${fail} fail, ${blocked} blocked (of ${withVideos.length} with videos).`);
  if (fail > 0) process.exitCode = 1;
}

main().catch(err => {
  console.error('Fatal:', (err as Error).message);
  process.exit(1);
});
