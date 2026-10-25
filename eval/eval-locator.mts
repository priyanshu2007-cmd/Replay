/**
 * Bounded, fixture-assisted Locator evaluation (pnpm eval:locator).
 * Note: Live video-to-Watcher extraction remains blocked on host ffmpeg and the
 * Watcher API key, so this evaluation derives BugReport inputs deterministically
 * from validated symptom fields in samples/<id>/expected.json (without leaking
 * guilty_file or guilty_symbol into the prompt) and runs the Locator against
 * the packed Demo Shop repository.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocatorOutputSchema } from '../packages/shared/src/index.js';
import {
  fixtureToBugReport,
  locateSuspects,
  packRepository,
  resolveApiKey,
  SampleFixture,
  SampleFixtureSchema,
} from '../packages/agents/src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLES_DIR = path.join(ROOT, 'samples');
const DEMO_SHOP_DIR = path.join(ROOT, 'targets', 'demo-shop');

/** Grounded handler line spans in targets/demo-shop/src/App.tsx for each planted bug. */
const GROUNDED_LINE_RANGES: Record<string, { start: number; end: number; symbols: string[] }> = {
  'cart-nan': { start: 84, end: 105, symbols: ['handleQuantityChange'] },
  'double-discount': { start: 107, end: 133, symbols: ['handleApplyCoupon'] },
  'string-sort': { start: 49, end: 70, symbols: ['handleSortChange'] },
  'empty-email': { start: 135, end: 157, symbols: ['handleCheckout'] },
  'quantity-reset': { start: 14, end: 47, symbols: ['activeTab', 'handleTabChange', 'cart'] },
};

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
    // no .env — rely on process environment
  }
}

async function loadValidatedFixtures(): Promise<SampleFixture[]> {
  const entries = await fs.readdir(SAMPLES_DIR, { withFileTypes: true });
  const fixtures: SampleFixture[] = [];

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const fixturePath = path.join(SAMPLES_DIR, e.name, 'expected.json');
    const rawText = await fs.readFile(fixturePath, 'utf8').catch(err => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    });
    if (rawText === null) continue;

    const parsed = JSON.parse(rawText);
    const validated = SampleFixtureSchema.parse(parsed);
    fixtures.push(validated);
  }

  return fixtures.sort((a, b) => a.id.localeCompare(b.id));
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return Math.max(aStart, bStart) <= Math.min(aEnd, bEnd);
}

async function main() {
  await loadEnvFile(path.join(ROOT, '.env'));
  console.log('=== Locator Evaluation (Fixture-Assisted BugReport -> Packed Demo Shop) ===');
  console.log('Note: Input BugReports are mapped from fixture symptom fields only (not live video Watcher output).');

  const fixtures = await loadValidatedFixtures();
  const bundle = await packRepository(DEMO_SHOP_DIR);
  console.log(
    `Packed Demo Shop: ${bundle.metadata.includedFileCount} files (${bundle.files.map(f => f.path).join(', ')}), ` +
      `${bundle.metadata.totalChars} chars (~${bundle.metadata.estimatedTokens} tokens), ` +
      `${bundle.metadata.skippedFileCount} skipped, ${bundle.metadata.redactedSecretCount} secrets redacted.\n`
  );

  if (!resolveApiKey('locator')) {
    for (const f of fixtures) {
      console.log(`BLOCKED  ${f.id}: no locator API key configured`);
    }
    console.log('\nResult: 0 evaluated, all BLOCKED on missing locator credential.');
    return;
  }

  const fileLineMap = new Map(bundle.files.map(f => [f.path, f.lineCount]));

  let schemaValidCount = 0;
  let pathValidCount = 0;
  let rangeValidCount = 0;
  let top3FileHitCount = 0;
  let top3GroundedHitCount = 0;
  let blockedCount = 0;
  let failCount = 0;

  for (const fixture of fixtures) {
    const bugReport = fixtureToBugReport(fixture);
    try {
      const res = await locateSuspects({ bugReport, bundle });
      const schemaOk = LocatorOutputSchema.safeParse(res.output).success;
      if (schemaOk) schemaValidCount++;

      const suspects = res.output.suspects;
      const allPathsExist =
        suspects.length > 0 && suspects.every(s => fileLineMap.has(s.file));
      if (allPathsExist) pathValidCount++;

      const allRangesValid =
        suspects.length > 0 &&
        suspects.every(s => {
          const maxLine = fileLineMap.get(s.file);
          return maxLine !== undefined && s.start_line >= 1 && s.end_line >= s.start_line && s.end_line <= maxLine;
        });
      if (allRangesValid) rangeValidCount++;

      const top3 = suspects.slice(0, 3);
      const fileHitRank = top3.findIndex(s => s.file === fixture.guilty_file);
      const top3FileHit = fileHitRank !== -1;
      if (top3FileHit) top3FileHitCount++;

      const grounded = GROUNDED_LINE_RANGES[fixture.id];
      const groundedHitRank = top3.findIndex(s => {
        if (s.file !== fixture.guilty_file) return false;
        const symbolMatch =
          s.symbol === fixture.guilty_symbol ||
          (grounded?.symbols.includes(s.symbol) ?? false);
        const lineOverlap = grounded
          ? rangesOverlap(s.start_line, s.end_line, grounded.start, grounded.end)
          : false;
        return symbolMatch || lineOverlap;
      });
      const top3GroundedHit = groundedHitRank !== -1;
      if (top3GroundedHit) top3GroundedHitCount++;

      const topSuspect = suspects[0];
      const topDesc = topSuspect
        ? `#1 ${topSuspect.file}:${topSuspect.start_line}-${topSuspect.end_line} (${topSuspect.symbol}, conf=${topSuspect.confidence})`
        : 'none';

      if (schemaOk && allPathsExist && allRangesValid && top3FileHit && top3GroundedHit) {
        console.log(
          `PASS     ${fixture.id}: schema=OK path=OK lines=OK file_rank=#${fileHitRank + 1} grounded_rank=#${groundedHitRank + 1} | ${topDesc} | ${res.metrics.durationMs}ms (${res.metrics.totalTokens} tok)`
        );
      } else {
        failCount++;
        console.log(
          `FAIL     ${fixture.id}: schema=${schemaOk ? 'OK' : 'FAIL'} path=${allPathsExist ? 'OK' : 'FAIL'} lines=${allRangesValid ? 'OK' : 'FAIL'} top3_file=${top3FileHit} top3_grounded=${top3GroundedHit} | ${topDesc}`
        );
      }
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (/401|403|429|503|ResourceExhausted|rate|timeout|Connection error|ECONN|ETIMEDOUT/i.test(msg)) {
        blockedCount++;
        console.log(`BLOCKED  ${fixture.id}: provider error — ${msg.slice(0, 120)}`);
      } else {
        failCount++;
        console.log(`FAIL     ${fixture.id}: ${msg.slice(0, 140)}`);
      }
    }
  }

  const evaluated = fixtures.length - blockedCount;
  console.log('\n=== Summary ===');
  console.log(`Samples evaluated (fixture-assisted): ${evaluated}/${fixtures.length} (${blockedCount} blocked)`);
  console.log(`Schema validity:                      ${schemaValidCount}/${evaluated}`);
  console.log(`Path validity (in real repo):         ${pathValidCount}/${evaluated}`);
  console.log(`Line-range & evidence validity:       ${rangeValidCount}/${evaluated}`);
  console.log(`Top-3 guilty file relevance:          ${top3FileHitCount}/${evaluated}`);
  console.log(`Top-3 grounded symbol/line relevance: ${top3GroundedHitCount}/${evaluated}`);

  if (failCount > 0) process.exitCode = 1;
}

main().catch(err => {
  console.error('Fatal:', (err as Error).message);
  process.exit(1);
});
