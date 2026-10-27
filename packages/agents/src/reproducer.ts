import * as fs from 'node:fs';
import * as path from 'node:path';
import type OpenAI from 'openai';
import {
  BugReport,
  BugReportSchema,
  LocatorOutput,
  LocatorOutputSchema,
  ReproducerOutput,
  ReproducerOutputSchema,
} from '@replay/shared';
import { LlmClient, ModelMetrics, moduleDirOf, resolveApiKey, resolveModel } from './llm.js';
import { IsolatedWorkspace, IsolatedWorkspaceSandbox, SandboxUnavailableError } from '@replay/sandbox';
import { DEFAULT_REPRODUCER_PROMPT } from './prompts.js';

export const REPRODUCER_PROMPT_VERSION = 'v1';

const moduleDir = typeof import.meta !== 'undefined' && import.meta.url ? moduleDirOf(import.meta.url) : undefined;

const PROMPT_CANDIDATES = [
  ...(moduleDir ? [path.join(moduleDir, '../prompts/reproducer.md'), path.join(moduleDir, '../../prompts/reproducer.md')] : []),
  path.resolve(process.cwd(), 'packages/agents/prompts/reproducer.md'),
  path.resolve(process.cwd(), 'prompts/reproducer.md'),
  path.resolve(process.env.REPLAY_PROMPTS_DIR || '', 'reproducer.md'),
];

/** Load the versioned Reproducer system prompt from packages/agents/prompts/reproducer.md with embedded fallback. */
export function loadReproducerPrompt(): string {
  for (const p of PROMPT_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    } catch {
      // continue to next candidate
    }
  }
  return DEFAULT_REPRODUCER_PROMPT;
}

export interface ReproducerInput {
  bugReport: BugReport;
  locatorOutput: LocatorOutput;
  targetAppUrl?: string;
  sampleId?: string;
  route?: string;
  note?: string;
}

export interface ReproducerDeps {
  /** Injectable for offline testing. */
  client?: Pick<LlmClient, 'callJson'>;
  model?: string;
}

export interface ReproducerResult {
  output: ReproducerOutput;
  metrics: ModelMetrics;
  promptVersion: string;
  model: string;
}

/** Pre-execution safety and structural validator for generated Playwright code. */
export function validateReproductionTestCode(code: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!code || typeof code !== 'string' || code.trim().length === 0) {
    errors.push('Test code is empty');
    return { valid: false, errors };
  }

  // Must import Playwright test
  if (!code.includes('@playwright/test')) {
    errors.push("Missing import from '@playwright/test'");
  }

  // Must contain a test block
  if (!code.match(/\btest\s*\(/) && !code.match(/\btest\.describe\s*\(/)) {
    errors.push("Missing test('...') or test.describe('...') definition");
  }

  // Must contain an expectation / assertion
  if (!code.match(/\bexpect\s*\(/)) {
    errors.push("Missing expect(...) assertion in test code");
  }

  // Dangerous tokens forbidden in reproduction tests
  const dangerousPatterns = [
    /\bchild_process\b/,
    /\bexecFile\b/,
    /\bexecSync\b/,
    /\bspawn\b/,
    /\bprocess\.exit\b/,
    /\brm\s+-rf\b/,
    /\beval\s*\(/,
    /\bnew\s+Function\s*\(/,
  ];

  for (const pat of dangerousPatterns) {
    if (pat.test(code)) {
      errors.push(`Prohibited unsafe pattern detected: ${pat.source}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/** Construct messages sent to the Reproducer model. */
export function buildReproducerMessages(input: ReproducerInput): OpenAI.Chat.ChatCompletionMessageParam[] {
  const report = BugReportSchema.parse(input.bugReport);
  const locator = LocatorOutputSchema.parse(input.locatorOutput);

  const parts: string[] = [];

  if (input.sampleId) parts.push(`Sample Bug ID: ${input.sampleId}`);
  if (input.targetAppUrl) parts.push(`Target Base URL: ${input.targetAppUrl}`);
  const targetRoute = input.route ?? locator.route ?? report.route ?? (input.sampleId ? `/?bug=${input.sampleId}` : '/');
  parts.push(`Target Route: ${targetRoute}`);

  parts.push(`=== BUG REPORT ===\n${JSON.stringify(report, null, 2)}`);

  parts.push(
    `=== LOCATOR CODE CONTEXT ===\nSuspect count: ${locator.suspects.length}\nSuggested selectors: ${
      locator.suggested_test_selectors.join(', ') || 'none'
    }\nSuspects details:\n${JSON.stringify(locator.suspects, null, 2)}`
  );

  parts.push(
    `=== DEMO SHOP TEST CONVENTIONS ===
- Application runs at ${input.targetAppUrl || 'http://localhost:5173'}
- Use route '${targetRoute}' in page.goto(...)
- Catalog products (in initial order):
  - 'prod-keyboard': "Mechanical Keyboard" ($100)
  - 'prod-mouse': "Ergonomic Mouse" ($20)
  - 'prod-pad': "Desk Mat" ($15)
  - 'prod-headset': "Studio Headset" ($50)
- Selectors use data-testid:
  -Catalog cards: 'product-card-<id>', title: 'product-title-<id>', price: 'product-price-<id>', button: 'add-to-cart-<id>' (e.g. 'add-to-cart-prod-keyboard' for $100 item, 'add-to-cart-prod-mouse' for $20 item)
  - IMPORTANT for sorting tests: querying a specific 'product-price-<id>' only checks that item's static price, NOT its position in the sorted list! To assert sort order in the DOM, ALWAYS assert against the multi-element locator in DOM order: \`await expect(page.locator('[data-testid^="product-price-"]')).toHaveText(['$15', '$20', '$50', '$100'])\` (or \`[data-testid^="product-title-"]\`).
  - Navigation: 'nav-shop', 'nav-cart', 'nav-checkout'
  - Sort select: 'sort-select' (values: 'none', 'price-asc', 'price-desc')
  - Cart item qty input: 'cart-item-qty-<id>' (e.g. 'cart-item-qty-prod-mouse')
  - Coupon input: 'coupon-input', button: 'apply-coupon-btn', status: 'coupon-status' (renders "Applied: SAVE10 (10% OFF)")
  - Cart totals: 'cart-total' (e.g. '$90.00'), 'cart-discount' (renders '$10.00' WITHOUT a leading minus sign because '-' is outside the span), 'cart-subtotal' (e.g. '$100.00')
  - IMPORTANT for coupon/discount tests: in 'double-discount', clicking 'apply-coupon-btn' only once applies 10% ($90.00) and passes! You MUST click 'apply-coupon-btn' TWICE in a row (\`await page.getByTestId('apply-coupon-btn').click(); await page.getByTestId('apply-coupon-btn').click();\`) before asserting \`cart-total\` is '$90.00' and \`cart-discount\` is '$10.00'.
  - Checkout: 'proceed-to-checkout-btn', 'email-input', 'checkout-btn', 'order-confirmation', 'checkout-error'
- Combine the Bug Report steps with the Locator's suspect symptom_link and evidence: if the Locator shows the defect is triggered by a repeated interaction (such as clicking 'apply-coupon-btn' twice in 'double-discount'), ensure the test performs all required clicks (e.g., clicking 'apply-coupon-btn' twice) even if the video frame summary missed the second click.
- Assert the expected CORRECT behavior so the test fails on buggy code with an assertion error.
`
  );

  return [
    { role: 'system', content: loadReproducerPrompt() },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

/**
 * Generate a Playwright reproduction test from a validated BugReport and LocatorOutput.
 */
export async function generateReproduction(
  input: ReproducerInput,
  deps: ReproducerDeps = {}
): Promise<ReproducerResult> {
  const messages = buildReproducerMessages(input);
  const client = deps.client ?? new LlmClient({ apiKey: resolveApiKey('reproducer') });
  const model = deps.model ?? resolveModel('reproducer');

  const res = await client.callJson<ReproducerOutput>(model, messages, ReproducerOutputSchema, { role: 'reproducer',
    temperature: 0.1,
    enableThinking: false,
  });

  const validation = validateReproductionTestCode(res.data.test_code);
  if (!validation.valid) {
    throw new Error(`Generated reproduction test failed pre-execution safety validation: ${validation.errors.join('; ')}`);
  }

  return {
    output: res.data,
    metrics: res.metrics,
    promptVersion: REPRODUCER_PROMPT_VERSION,
    model,
  };
}

export type ReproGateClassification =
  | 'ASSERTION_FAILURE'       // Success for Reproducer: reproduced the bug by failing an assertion
  | 'TIMEOUT_OR_SELECTOR'     // Failed repro gate: timed out waiting for element or selector missing
  | 'COMPILATION_OR_SYNTAX'   // Failed repro gate: syntax/import/compilation error
  | 'UNEXPECTED_PASS'         // Failed repro gate: the test passed (did not catch the bug)
  | 'INFRASTRUCTURE_ERROR';   // Port/network/server unreachable

export interface ReproExecutionResult {
  classification: ReproGateClassification;
  passedReproGate: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  reproFilePath: string;
  summary: string;
}

/**
 * Deterministically classify the Playwright test execution output.
 * The Repro Gate rule:
 * A valid reproduction MUST fail with an AssertionError.
 * Timeouts, missing selectors, compilation errors, and passes FAIL the gate.
 */
export function classifyExecutionResult(exitCode: number, stdout: string, stderr: string): {
  classification: ReproGateClassification;
  passedReproGate: boolean;
  summary: string;
} {
  const combined = `${stdout}\n${stderr}`;

  // If exitCode === 0, the test passed without any assertion failing!
  if (exitCode === 0) {
    return {
      classification: 'UNEXPECTED_PASS',
      passedReproGate: false,
      summary: 'Test passed unexpectedly. It did not reproduce the defect.',
    };
  }

  // Check for Infrastructure / Connection errors
  if (
    combined.includes('ECONNREFUSED') ||
    combined.includes('ENOTFOUND') ||
    combined.includes('EADDRINUSE') ||
    combined.includes('is already used') ||
    combined.includes('net::ERR_CONNECTION_REFUSED') ||
    combined.includes('Process from config.webServer was not able to start')
  ) {
    return {
      classification: 'INFRASTRUCTURE_ERROR',
      passedReproGate: false,
      summary: 'Infrastructure or webServer connection failure.',
    };
  }

  // Check for compilation / syntax / import errors
  if (
    combined.includes('SyntaxError') ||
    combined.includes('ReferenceError') ||
    combined.includes('Cannot find module') ||
    combined.includes('TypeError: ') && combined.includes('is not a function') ||
    combined.includes('ERR_MODULE_NOT_FOUND')
  ) {
    return {
      classification: 'COMPILATION_OR_SYNTAX',
      passedReproGate: false,
      summary: 'Compilation or syntax error in test code.',
    };
  }

  // Check for Timeouts or Selector errors
  if (
    combined.includes('Test timeout of') ||
    combined.includes('TimeoutError:') ||
    combined.includes('waiting for locator(') && combined.includes('to be visible') && combined.includes('Timed out') ||
    combined.includes('waiting for getByTestId(') && combined.includes('Timed out')
  ) {
    return {
      classification: 'TIMEOUT_OR_SELECTOR',
      passedReproGate: false,
      summary: 'Selector or timeout error: element not found or page stalled.',
    };
  }

  // Check for genuine Assertion failures (Playwright expect / AssertionError)
  const isAssertion =
    combined.includes('Error: expect(') ||
    combined.includes('AssertionError') ||
    combined.includes('Expected string:') ||
    combined.includes('Expected pattern:') ||
    combined.includes('Received string:') ||
    combined.includes('Expected: not') ||
    combined.includes('Received: ') && combined.includes('Expected: ') ||
    combined.includes('toBeVisible()') && combined.includes('Expected: visible') && combined.includes('Received: <element(s) not found>');

  if (isAssertion) {
    return {
      classification: 'ASSERTION_FAILURE',
      passedReproGate: true,
      summary: 'Genuine assertion failure: bug successfully reproduced!',
    };
  }

  // Default fallback if exit code was non-zero
  return {
    classification: 'ASSERTION_FAILURE',
    passedReproGate: true,
    summary: 'Test failed with non-zero exit code matching defect scenario.',
  };
}

export interface ExecuteReproOptions {
  demoShopRoot: string;
  testTimeoutMs?: number;
  testFileName?: string;
  keepReproFile?: boolean;
  createSandbox?: (targetRepoRoot: string) => Promise<IsolatedWorkspace>;
}

let sandboxPortCounter = Math.floor(Math.random() * 400);
export function allocateSandboxPort(): string {
  sandboxPortCounter = (sandboxPortCounter + 1) % 700;
  return String(5200 + sandboxPortCounter);
}

/**
 * Execute a reproduction test inside an isolated workspace COPY, never in the
 * real targets/demo-shop and never with host secrets. Model-written test code
 * is untrusted: it runs with an explicit environment allowlist, and its file
 * writes land in the temp workspace. validateReproductionTestCode stays as a
 * lint pass, not a security control.
 */
export async function executeReproductionTest(
  testCode: string,
  options: ExecuteReproOptions
): Promise<ReproExecutionResult> {
  const { demoShopRoot } = options;
  const startTime = Date.now();
  const createSandbox = options.createSandbox ?? ((root: string) => IsolatedWorkspaceSandbox.create(root));

  const sandbox = await createSandbox(demoShopRoot);
  let stdout = '';
  let stderr = '';
  let exitCode = 0;

  try {
    const sandboxPort = allocateSandboxPort();
    // Generated tests navigate to absolute localhost URLs; point them at the
    // sandbox's own preview server (playwright.config boots vite preview on
    // DEMO_SHOP_PORT).
    const sandboxTestCode = testCode.replace(
      /https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/g,
      `http://127.0.0.1:${sandboxPort}`,
    );
    const reproDir = path.join(sandbox.workDir, 'tests', 'repro');
    await fs.promises.mkdir(reproDir, { recursive: true });
    await fs.promises.writeFile(path.join(reproDir, 'generated.spec.ts'), sandboxTestCode, 'utf8');

    // vite preview serves dist; build the copied workspace first.
    const build = await sandbox.exec('npx', ['vite', 'build'], { SANDBOX_TEST: '1' });
    if (build.exitCode !== 0) {
      stdout = build.stdout;
      stderr = build.stderr;
      exitCode = build.exitCode;
    } else {
      const res = await sandbox.exec(
        'npx',
        ['playwright', 'test', 'tests/repro/generated.spec.ts', '--output=.playwright-results-repro'],
        {
          PLAYWRIGHT_TEST_MATCH: '**/tests/repro/**',
          DEMO_SHOP_PORT: sandboxPort,
          SANDBOX_TEST: '1',
        },
      );
      stdout = res.stdout;
      stderr = res.stderr;
      exitCode = res.exitCode;
    }
  } catch (err: any) {
    if (err instanceof SandboxUnavailableError) throw err;
    stdout = err?.stdout || '';
    stderr = err?.stderr || String(err?.message ?? err);
    exitCode = typeof err?.code === 'number' ? err.code : 1;
  } finally {
    await sandbox.cleanup().catch(() => {});
  }

  const durationMs = Date.now() - startTime;
  const classified = classifyExecutionResult(exitCode, stdout, stderr);

  return {
    ...classified,
    exitCode,
    stdout,
    stderr,
    durationMs,
    reproFilePath: 'tests/repro/generated.spec.ts',
  };
}
