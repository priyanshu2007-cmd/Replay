/**
 * End-to-end live demonstration of the Fix-and-Verify Pipeline on cart-nan:
 * 1. Takes symptom fields from samples/cart-nan/expected.json
 * 2. Packs Demo Shop repository
 * 3. Runs Locator (Nemotron Lightning) -> locates culprit in src/App.tsx
 * 4. Runs Reproducer (Nemotron Ultra) -> generates Playwright reproduction test
 * 5. Executes initial test -> proves defect fails with AssertionError ($NaN)
 * 6. Runs Verifier -> confirms genuine reproduction
 * 7. Runs Fixer (Nemotron Ultra) -> generates surgical patch
 * 8. Applies patch in an isolated sandbox workspace (leaves primary working tree untouched)
 * 9. Rebuilds app in sandbox and runs reproduction test -> verifies it PASSES
 * 10. Runs Demo Shop baseline suite in sandbox -> verifies NO regressions (all 6 pass)
 * 11. Cleans up sandbox and returns structured report
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fixtureToBugReport,
  runFixAndVerifyPipeline,
  SampleFixtureSchema,
} from '../packages/agents/src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO_SHOP_DIR = path.join(ROOT, 'targets', 'demo-shop');
const SAMPLE_PATH = path.join(ROOT, 'samples', 'cart-nan', 'expected.json');

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
    // no .env
  }
}

async function main() {
  console.log('=== Replay — End-to-End Fix-and-Verify Pipeline (cart-nan) ===');
  await loadEnvFile(path.join(ROOT, '.env'));

  const rawFixture = JSON.parse(await fs.readFile(SAMPLE_PATH, 'utf8'));
  const fixture = SampleFixtureSchema.parse(rawFixture);
  const bugReport = fixtureToBugReport(fixture);

  console.log(`Target: ${fixture.id} ("${fixture.title}")`);
  console.log('Running autonomous Fix-and-Verify pipeline...\n');

  const startTime = Date.now();
  const result = await runFixAndVerifyPipeline(bugReport, {
    targetRepoRoot: DEMO_SHOP_DIR,
    sampleId: fixture.id,
    targetAppUrl: 'http://127.0.0.1:5173',
    maxFixAttempts: 2,
  });
  const durationMs = Date.now() - startTime;

  console.log('\n=== Pipeline Execution Summary ===');
  console.log(`Overall Status:             ${result.status.toUpperCase()}`);
  console.log(`Total Duration:             ${durationMs}ms`);
  console.log(`Pre-Fix Defect Failure:     ${result.reproBeforeFixFailed ? 'YES (Reproduction confirmed)' : 'NO'}`);
  console.log(`Verifier Classification:    ${result.verifierOutput.classification} (same_defect=${result.verifierOutput.same_defect})`);
  console.log(`Post-Fix Repro Passed:      ${result.reproAfterFixPassed ? 'YES (Defect resolved)' : 'NO'}`);
  console.log(`Baseline Suite Green:       ${result.baselineRegressionPassed ? 'YES (No regressions)' : 'NO'}`);
  console.log(`Fix Attempts:               ${result.attempts}`);
  console.log(`Summary:                    ${result.summary}`);

  if (result.fixerOutput) {
    console.log('\n=== Verified Patch Details ===');
    console.log(`Target File: ${result.fixerOutput.target_file}`);
    console.log(`Explanation: ${result.fixerOutput.explanation}`);
    if (result.fixerOutput.original_snippet) {
      console.log('--- Original Code ---');
      console.log(result.fixerOutput.original_snippet.trim());
      console.log('--- Replacement Code ---');
      console.log(result.fixerOutput.replacement_snippet.trim());
    }
  }

  if (result.status === 'fixed') {
    console.log('\nSUCCESS: Bug was autonomously reproduced, verified, fixed in isolated sandbox, and regression-tested!');
  } else {
    console.error(`\nFAILED: Pipeline finished with status ${result.status}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal pipeline evaluation error:', err);
  process.exit(1);
});
