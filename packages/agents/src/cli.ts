#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunEvent } from '@replay/shared';
import { runPipeline } from './pipeline.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');

async function loadDotEnv(): Promise<void> {
  const envPath = path.join(REPO_ROOT, '.env');
  try {
    const raw = await fs.promises.readFile(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      const key = m?.[1];
      const val = m?.[2];
      if (key && val !== undefined && process.env[key] === undefined) {
        process.env[key] = val.replace(/^["']|["']$/g, '').trim();
      }
    }
  } catch {
    // .env is optional
  }
}

function printUsage(): void {
  console.log(`
Replay CLI — Drop a bug video. Get a failing test and a verified fix.

Usage:
  pnpm replay <input> [options]
  node packages/agents/dist/cli.js <input> [options]

Arguments:
  <input>               Path to recording (.webm), fixture (.json), or sample ID (e.g. cart-nan)

Options:
  --target <dir>        Path to target repository (default: targets/demo-shop)
  --sample <id>         Explicit sample ID (e.g. cart-nan, double-discount)
  --report-out <path>   Write final Markdown report to specified path
  --max-attempts <n>    Maximum fix attempts in sandbox (default: 2)
  --json                Output result as JSON only
  -h, --help            Show this help message

Examples:
  pnpm replay cart-nan
  pnpm replay samples/cart-nan/recording.webm
  pnpm replay samples/cart-nan/expected.json --target targets/demo-shop
`);
}

async function main(): Promise<void> {
  await loadDotEnv();

  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    printUsage();
    process.exit(0);
  }

  let input: string | undefined;
  let targetRepo = path.join(REPO_ROOT, 'targets', 'demo-shop');
  let sampleId: string | undefined;
  let reportOut: string | undefined;
  let maxAttempts = 2;
  let jsonMode = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === '--target' && i + 1 < args.length) {
      targetRepo = path.resolve(args[++i]!);
    } else if (arg === '--sample' && i + 1 < args.length) {
      sampleId = args[++i]!;
    } else if (arg === '--report-out' && i + 1 < args.length) {
      reportOut = path.resolve(args[++i]!);
    } else if (arg === '--max-attempts' && i + 1 < args.length) {
      maxAttempts = parseInt(args[++i]!, 10) || 2;
    } else if (arg === '--json') {
      jsonMode = true;
    } else if (!arg.startsWith('-') && !input) {
      input = arg;
    }
  }

  if (!input && !sampleId) {
    console.error('Error: Please provide a video path, fixture path, or sample ID.');
    printUsage();
    process.exit(1);
  }

  let videoPath: string | undefined;
  if (input) {
    if (input.endsWith('.webm') || input.endsWith('.mp4')) {
      videoPath = path.resolve(input);
    } else if (input.endsWith('.json')) {
      const match = input.match(/samples\/([^/]+)/);
      if (match) sampleId = match[1];
    } else {
      sampleId = input;
    }
  }

  if (sampleId && !videoPath) {
    const candidateVideo = path.join(REPO_ROOT, 'samples', 'videos', `${sampleId}.webm`);
    if (fs.existsSync(candidateVideo)) {
      videoPath = candidateVideo;
    }
  }

  if (!jsonMode) {
    console.log('╔══════════════════════════════════════════════════════════════════╗');
    console.log('║       Replay — Autonomous Bug Reproduction & Verification       ║');
    console.log('╚══════════════════════════════════════════════════════════════════╝');
    console.log(`Target:      ${targetRepo}`);
    if (sampleId) console.log(`Sample:      ${sampleId}`);
    if (videoPath) console.log(`Video:       ${videoPath}`);
    console.log('');
  }

  const onEvent = (event: RunEvent) => {
    if (jsonMode) return;
    const stage = `[${event.stage.toUpperCase()}]`.padEnd(12);
    const agent = `<${event.agent}>`.padEnd(14);
    const type = event.event_type;

    let detail = '';
    if (type === 'locate_completed') {
      const top = event.payload.top_suspect as { file?: string; symbol?: string; start_line?: number; end_line?: number } | null;
      detail = top ? `Top culprit: ${top.file}:${top.start_line}-${top.end_line} (${top.symbol})` : 'No suspects';
    } else if (type === 'reproduce_completed') {
      detail = `Test: "${event.payload.test_name}"`;
    } else if (type === 'verify_completed') {
      detail = `Verdict: ${event.payload.classification} (same_defect=${event.payload.same_defect})`;
    } else if (type === 'fix_attempt_succeeded') {
      detail = `Attempt ${event.payload.attempt}: Patch verified green in sandbox!`;
    } else if (type === 'fix_attempt_failed') {
      detail = `Attempt ${event.payload.attempt}: ${event.payload.reason}`;
    } else if (type === 'report_completed') {
      detail = `Status: ${String(event.payload.status).toUpperCase()}`;
    } else if (event.payload.summary) {
      detail = String(event.payload.summary);
    }

    console.log(`  ${stage} ${agent} ${type} ${detail ? '→ ' + detail : ''}`);
  };

  try {
    const result = await runPipeline(
      {
        targetRepoRoot: targetRepo,
        sampleId,
        videoPath,
        maxFixAttempts: maxAttempts,
        onEvent,
        artifactsDir: path.join(REPO_ROOT, 'artifacts'),
      },
      {}
    );

    if (reportOut) {
      await fs.promises.mkdir(path.dirname(reportOut), { recursive: true });
      await fs.promises.writeFile(reportOut, result.reporterOutput.markdown_report, 'utf8');
    }

    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('\n================ Pipeline Execution Summary ================');
      console.log(`Overall Status:          ${result.status.toUpperCase()}`);
      console.log(`Run ID:                  ${result.runId}`);
      console.log(`Duration:                ${(result.durationMs / 1000).toFixed(1)}s`);
      console.log(`Video Analysis Mode:     ${result.videoAnalysis}`);
      console.log(`Pre-Fix Test Failed:     ${result.reproBeforeFixFailed ? 'YES (Reproduction confirmed)' : 'NO'}`);
      console.log(`Post-Fix Test Passed:    ${result.reproAfterFixPassed ? 'YES (Defect fixed)' : 'NO'}`);
      console.log(`Baseline Suite Green:    ${result.baselineRegressionPassed ? 'YES (No regressions)' : 'NO'}`);
      console.log(`Fix Attempts:            ${result.attempts}`);
      console.log(`Artifacts Path:          ./artifacts/reports/${result.runId}.md`);
      if (reportOut) {
        console.log(`Report Written To:       ${reportOut}`);
      }
      console.log('============================================================\n');

      if (result.status === 'fixed') {
        console.log('SUCCESS: Bug was autonomously reproduced, verified, fixed, and confirmed green.');
        process.exit(0);
      } else {
        console.log(`COMPLETED WITH STATUS: ${result.status.toUpperCase()}`);
        process.exit(result.status === 'reproduced_only' ? 0 : 1);
      }
    }
  } catch (err: any) {
    if (jsonMode) {
      console.error(JSON.stringify({ error: err?.message || String(err) }));
    } else {
      console.error('\nFatal Pipeline Error:', err?.message || err);
    }
    process.exit(1);
  }
}

main();
