import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BugReportSchema, LocatorOutputSchema } from '@replay/shared';
import {
  buildReproducerMessages,
  classifyExecutionResult,
  executeReproductionTest,
  generateReproduction,
  loadReproducerPrompt,
  validateReproductionTestCode,
} from './reproducer.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DEMO_SHOP_DIR = path.join(ROOT, 'targets', 'demo-shop');

const MOCK_BUG_REPORT = BugReportSchema.parse({
  defect_found: true,
  summary: 'Cart total becomes NaN after clearing quantity field',
  steps: [
    { timestamp_s: 2.5, description: 'Added item to cart and cleared quantity input' },
  ],
  first_failure_timestamp_s: 2.5,
  expected_behavior: 'Cart total should recalculate or retain a valid numerical value ($0.00 or previous total)',
  actual_behavior: 'Cart total displays as $NaN',
  visible_text: ['Cart', '$NaN'],
  route: '/?bug=cart-nan',
  confidence: 0.95,
});

const MOCK_LOCATOR_OUTPUT = LocatorOutputSchema.parse({
  suspects: [
    {
      file: 'src/App.tsx',
      start_line: 84,
      end_line: 105,
      symbol: 'handleQuantityChange',
      confidence: 0.95,
      symptom_link: 'Number("") returns NaN without fallback check',
      evidence: "const val = Number(e.target.value);",
    },
  ],
  suggested_test_selectors: ['cart-item-qty-prod-mouse', 'cart-total'],
  route: '/?bug=cart-nan',
});

test('loadReproducerPrompt loads prompt containing role instructions', () => {
  const prompt = loadReproducerPrompt();
  assert.ok(prompt.includes('Reproducer'));
  assert.ok(prompt.includes('Playwright'));
  assert.ok(prompt.includes('reproduced'));
});

test('validateReproductionTestCode accepts valid Playwright test', () => {
  const code = `
    import { test, expect } from '@playwright/test';
    test('reproduce cart NaN', async ({ page }) => {
      await page.goto('/?bug=cart-nan');
      await expect(page.getByTestId('cart-total')).not.toHaveText('$NaN');
    });
  `;
  const res = validateReproductionTestCode(code);
  assert.equal(res.valid, true);
  assert.equal(res.errors.length, 0);
});

test('validateReproductionTestCode rejects empty, missing assertions, and unsafe patterns', () => {
  // Empty code
  assert.equal(validateReproductionTestCode('').valid, false);

  // Missing @playwright/test
  assert.equal(validateReproductionTestCode("test('x', () => expect(1).toBe(1))").valid, false);

  // Missing expect
  assert.equal(
    validateReproductionTestCode("import { test } from '@playwright/test'; test('x', () => {})").valid,
    false
  );

  // Unsafe child_process
  const unsafe = `
    import { test, expect } from '@playwright/test';
    import { execSync } from 'child_process';
    test('unsafe', async ({ page }) => {
      execSync('rm -rf /');
      expect(true).toBe(true);
    });
  `;
  const unsafeRes = validateReproductionTestCode(unsafe);
  assert.equal(unsafeRes.valid, false);
  assert.ok(unsafeRes.errors.some(e => e.includes('child_process') || e.includes('execSync')));
});

test('classifyExecutionResult accurately categorizes repro gate outcomes', () => {
  // 1. Unexpected Pass
  const pass = classifyExecutionResult(0, '1 passed (1.2s)', '');
  assert.equal(pass.classification, 'UNEXPECTED_PASS');
  assert.equal(pass.passedReproGate, false);

  // 2. Timeout / Selector error
  const timeout = classifyExecutionResult(
    1,
    'waiting for getByTestId("missing-btn") Timed out 5000ms',
    'Test timeout of 30000ms exceeded'
  );
  assert.equal(timeout.classification, 'TIMEOUT_OR_SELECTOR');
  assert.equal(timeout.passedReproGate, false);

  // 3. Compilation / Syntax error
  const syntax = classifyExecutionResult(1, '', 'SyntaxError: Unexpected token');
  assert.equal(syntax.classification, 'COMPILATION_OR_SYNTAX');
  assert.equal(syntax.passedReproGate, false);

  // 4. Infrastructure error
  const infra = classifyExecutionResult(1, '', 'net::ERR_CONNECTION_REFUSED at http://localhost:5173');
  assert.equal(infra.classification, 'INFRASTRUCTURE_ERROR');
  assert.equal(infra.passedReproGate, false);

  // 5. Genuine Assertion failure
  const assertion = classifyExecutionResult(
    1,
    "Error: expect(locator).not.toHaveText(expected)\nExpected: not '$NaN'\nReceived: '$NaN'",
    ''
  );
  assert.equal(assertion.classification, 'ASSERTION_FAILURE');
  assert.equal(assertion.passedReproGate, true);
});

test('buildReproducerMessages constructs deterministic user message with context', () => {
  const messages = buildReproducerMessages({
    bugReport: MOCK_BUG_REPORT,
    locatorOutput: MOCK_LOCATOR_OUTPUT,
    sampleId: 'cart-nan',
  });

  assert.equal(messages.length, 2);
  const sysMsg = messages[0];
  const userMsg = messages[1];
  assert.ok(sysMsg && userMsg);
  assert.equal(sysMsg.role, 'system');
  assert.equal(userMsg.role, 'user');
  const userContent = String(userMsg.content);
  assert.ok(userContent.includes('Sample Bug ID: cart-nan'));
  assert.ok(userContent.includes('handleQuantityChange'));
  assert.ok(userContent.includes('cart-item-qty-prod-mouse'));
});

test('generateReproduction works with mock LlmClient', async () => {
  const mockClient = {
    async callJson<T>() {
      return {
        data: {
          reproduced: true,
          test_name: 'reproduce cart NaN on empty quantity',
          assertion: "await expect(page.getByTestId('cart-total')).not.toHaveText('$NaN')",
          failure_message: "Expected not '$NaN', received '$NaN'",
          test_code: `
            import { test, expect } from '@playwright/test';
            test('cart total does not become NaN', async ({ page }) => {
              await page.goto('/?bug=cart-nan');
              await page.getByTestId('add-to-cart-prod-mouse').click();
              await page.getByTestId('nav-cart').click();
              await page.getByTestId('cart-item-qty-prod-mouse').fill('');
              await expect(page.getByTestId('cart-total')).not.toHaveText('$NaN');
            });
          `,
        } as unknown as T,
        rawText: '{}',
        metrics: { promptTokens: 100, completionTokens: 50, totalTokens: 150, durationMs: 120, model: 'test-model' },
      };
    },
  };

  const res = await generateReproduction(
    {
      bugReport: MOCK_BUG_REPORT,
      locatorOutput: MOCK_LOCATOR_OUTPUT,
      sampleId: 'cart-nan',
    },
    { client: mockClient, model: 'mock-reproducer' }
  );

  assert.equal(res.output.reproduced, true);
  assert.ok(res.output.test_code.includes('@playwright/test'));
  assert.equal(res.model, 'mock-reproducer');
});

test('executeReproductionTest runs against real Demo Shop and reproduces defect', async () => {
  const testCode = `
import { test, expect } from '@playwright/test';

test.describe('Reproduction: Cart NaN', () => {
  test('cart total should not become NaN after clearing quantity', async ({ page }) => {
    await page.goto('/?bug=cart-nan');
    await page.getByTestId('add-to-cart-prod-mouse').click();
    await page.getByTestId('nav-cart').click();

    const qtyInput = page.getByTestId('cart-item-qty-prod-mouse');
    await qtyInput.fill('');

    // Expected behavior: total should remain numerical and not show $NaN
    await expect(page.getByTestId('cart-total')).not.toHaveText('$NaN');
  });
});
  `;

  const result = await executeReproductionTest(testCode, { demoShopRoot: DEMO_SHOP_DIR });

  // On buggy code (?bug=cart-nan), total shows $NaN, so not.toHaveText('$NaN') fails with AssertionError.
  // This verifies that the defect was successfully reproduced!
  assert.equal(result.passedReproGate, true, `Expected to pass repro gate, got: ${result.summary}\n${result.stdout}`);
  assert.equal(result.classification, 'ASSERTION_FAILURE');
  assert.ok(
    result.stdout.includes('$NaN') ||
    result.stderr.includes('$NaN') ||
    result.stdout.includes('toHaveText') ||
    result.stdout.includes('failed')
  );
});
