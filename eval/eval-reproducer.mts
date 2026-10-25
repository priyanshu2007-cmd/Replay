/**
 * End-to-end live demonstration of Reproducer agent on cart-nan:
 * 1. Takes the validated Locator output for cart-nan.
 * 2. Calls the live NVIDIA Nemotron-3 Ultra model (nvidia/nemotron-3-ultra-550b-a55b).
 * 3. Validates the generated Playwright test code.
 * 4. Executes the generated test against Demo Shop via Playwright.
 * 5. Verifies it reproduces the defect (passes the Repro Gate with ASSERTION_FAILURE).
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateReproduction,
  executeReproductionTest,
  fixtureToBugReport,
  locateSuspects,
  packRepository,
  SampleFixtureSchema,
} from '../packages/agents/src/index.js';
import * as fs from 'node:fs/promises';

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
  console.log('=== Live Reproducer End-to-End Run (cart-nan) ===');
  await loadEnvFile(path.join(ROOT, '.env'));

  const rawFixture = JSON.parse(await fs.readFile(SAMPLE_PATH, 'utf8'));
  const fixture = SampleFixtureSchema.parse(rawFixture);
  const bugReport = fixtureToBugReport(fixture);

  console.log('1. Packing Demo Shop repository...');
  const bundle = await packRepository(DEMO_SHOP_DIR);

  console.log('2. Running Locator on packed repository...');
  const locatorRes = await locateSuspects({ bugReport, bundle });
  console.log(`   Locator found ${locatorRes.output.suspects.length} suspect(s).`);
  console.log(`   #1 Suspect: ${locatorRes.output.suspects[0]?.file}:${locatorRes.output.suspects[0]?.start_line}-${locatorRes.output.suspects[0]?.end_line} (${locatorRes.output.suspects[0]?.symbol})`);

  console.log('\n3. Calling live Reproducer model (nvidia/nemotron-3-ultra-550b-a55b)...');
  const reproRes = await generateReproduction({
    bugReport,
    locatorOutput: locatorRes.output,
    sampleId: fixture.id,
    targetAppUrl: 'http://localhost:5173',
    route: '/?bug=cart-nan',
  });

  console.log(`   Reproduced flag: ${reproRes.output.reproduced}`);
  console.log(`   Test name: ${reproRes.output.test_name}`);
  console.log(`   Assertion: ${reproRes.output.assertion}`);
  console.log(`   Model metrics: ${reproRes.metrics.durationMs}ms, ${reproRes.metrics.totalTokens} tokens`);

  console.log('\n4. Executing generated test against real Demo Shop...');
  console.log('--- Generated Test Code ---');
  console.log(reproRes.output.test_code.trim());
  console.log('---------------------------');

  const execRes = await executeReproductionTest(reproRes.output.test_code, {
    demoShopRoot: DEMO_SHOP_DIR,
    testTimeoutMs: 30_000,
  });

  console.log(`\n5. Repro Gate Result:`);
  console.log(`   Classification: ${execRes.classification}`);
  console.log(`   Passed Repro Gate: ${execRes.passedReproGate ? 'YES' : 'NO'}`);
  console.log(`   Execution Duration: ${execRes.durationMs}ms`);
  console.log(`   Summary: ${execRes.summary}`);

  if (execRes.passedReproGate) {
    console.log('\nSUCCESS: Defect was faithfully reproduced against the real browser application!');
  } else {
    console.error(`\nFAILED repro gate: ${execRes.summary}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal live reproducer run error:', err);
  process.exit(1);
});
