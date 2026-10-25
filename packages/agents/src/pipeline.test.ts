import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BugReportSchema } from '@replay/shared';
import { runFixAndVerifyPipeline } from './pipeline.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DEMO_SHOP_DIR = path.join(ROOT, 'targets', 'demo-shop');

const CART_NAN_REPORT = BugReportSchema.parse({
  defect_found: true,
  summary: 'Cart total becomes NaN after clearing quantity field',
  steps: [{ timestamp_s: 2.5, description: 'Cleared quantity input' }],
  first_failure_timestamp_s: 2.5,
  expected_behavior: 'Cart total should recalculate or retain a valid number ($0.00)',
  actual_behavior: 'Cart total displays as $NaN',
  visible_text: ['Cart', '$NaN'],
  route: '/?bug=cart-nan',
  confidence: 0.95,
});

test('runFixAndVerifyPipeline stops early when reproduction fails verification', async () => {
  // Mock reproducer producing a passing test (so execution doesn't fail with defect)
  const mockReproClient = {
    async callJson<T>() {
      return {
        data: {
          reproduced: true,
          test_name: 'dummy pass',
          assertion: 'expect(true).toBe(true)',
          failure_message: 'none',
          test_code: `
            import { test, expect } from '@playwright/test';
            test('pass', async () => { expect(1).toBe(1); });
          `,
        } as unknown as T,
        rawText: '{}',
        metrics: { promptTokens: 10, completionTokens: 10, totalTokens: 20, durationMs: 10, model: 'test' },
      };
    },
  };

  const mockLocatorClient = {
    async callJson<T>() {
      return {
        data: {
          suspects: [
            {
              file: 'src/App.tsx',
              start_line: 84,
              end_line: 93,
              symbol: 'handleQuantityChange',
              confidence: 0.95,
              symptom_link: 'parseInt without fallback produces NaN',
              evidence: 'const qty = parseInt(rawValue, 10);',
            },
          ],
          suggested_test_selectors: ['cart-item-qty-prod-mouse', 'cart-total'],
          route: '/?bug=cart-nan',
        } as unknown as T,
        rawText: '{}',
        metrics: { promptTokens: 10, completionTokens: 10, totalTokens: 20, durationMs: 10, model: 'test' },
      };
    },
  };

  const result = await runFixAndVerifyPipeline(
    CART_NAN_REPORT,
    {
      targetRepoRoot: DEMO_SHOP_DIR,
      sampleId: 'cart-nan',
    },
    {
      locatorDeps: { client: mockLocatorClient },
      reproducerDeps: { client: mockReproClient },
    }
  );

  // Verifier detects UNEXPECTED_PASS and aborts before fixer is ever called!
  assert.equal(result.status, 'unreproduced');
  assert.equal(result.verifierOutput?.same_defect, false);
  assert.equal(result.verifierOutput?.classification, 'UNEXPECTED_PASS');
  assert.equal(result.attempts, 0);
  assert.equal(result.fixerOutput, undefined);

});

test('runFixAndVerifyPipeline executes end-to-end and fixes cart-nan in isolated sandbox', async () => {
  // Provide mock clients for locator, reproducer, and fixer to test deterministic pipeline execution
  const mockLocatorClient = {
    async callJson<T>() {
      return {
        data: {
          suspects: [
            {
              file: 'src/App.tsx',
              start_line: 84,
              end_line: 93,
              symbol: 'handleQuantityChange',
              confidence: 0.95,
              symptom_link: 'parseInt without fallback produces NaN',
              evidence: 'const qty = parseInt(rawValue, 10);',
            },
          ],
          suggested_test_selectors: ['cart-item-qty-prod-mouse', 'cart-total'],
          route: '/?bug=cart-nan',
        } as unknown as T,
        rawText: '{}',
        metrics: { promptTokens: 100, completionTokens: 50, totalTokens: 150, durationMs: 50, model: 'test' },
      };
    },
  };

  const mockReproClient = {
    async callJson<T>() {
      return {
        data: {
          reproduced: true,
          test_name: 'cart total does not become NaN',
          assertion: "await expect(page.getByTestId('cart-total')).not.toHaveText('$NaN')",
          failure_message: "Expected not '$NaN', received '$NaN'",
          test_code: `
import { test, expect } from '@playwright/test';

test.describe('Reproduction: Cart NaN', () => {
  test('cart total does not become NaN after clearing quantity', async ({ page }) => {
    await page.goto('/?bug=cart-nan');
    await page.getByTestId('add-to-cart-prod-mouse').click();
    await page.getByTestId('nav-cart').click();
    const qtyInput = page.getByTestId('cart-item-qty-prod-mouse');
    await qtyInput.fill('');
    await expect(page.getByTestId('cart-total')).not.toHaveText('$NaN');
  });
});
          `,
        } as unknown as T,
        rawText: '{}',
        metrics: { promptTokens: 100, completionTokens: 50, totalTokens: 150, durationMs: 50, model: 'test' },
      };
    },
  };

  // The surgical fix: validates rawValue and falls back to 0
  const mockFixerClient = {
    async callJson<T>() {
      return {
        data: {
          fixed: true,
          target_file: 'src/App.tsx',
          explanation: 'Validate integer parsing and fallback to 0 when input is empty string.',
          original_snippet: `    if (activeBug === 'cart-nan') {
      // BUG 1: Unvalidated parseInt on empty string produces NaN in state
      const qty = parseInt(rawValue, 10);
      setCart((prev) =>
        prev.map((item) => (item.product.id === productId ? { ...item, quantity: qty } : item))
      );
      return;
    }`,
          replacement_snippet: `    if (activeBug === 'cart-nan') {
      let qty = parseInt(rawValue, 10);
      if (isNaN(qty) || qty < 0) qty = 0;
      setCart((prev) =>
        prev.map((item) => (item.product.id === productId ? { ...item, quantity: qty } : item))
      );
      return;
    }`,
          patch: '--- a/src/App.tsx\n+++ b/src/App.tsx',
          attempts: 1,
        } as unknown as T,
        rawText: '{}',
        metrics: { promptTokens: 200, completionTokens: 100, totalTokens: 300, durationMs: 100, model: 'test' },
      };
    },
  };

  const result = await runFixAndVerifyPipeline(
    CART_NAN_REPORT,
    {
      targetRepoRoot: DEMO_SHOP_DIR,
      sampleId: 'cart-nan',
      maxFixAttempts: 1,
    },
    {
      locatorDeps: { client: mockLocatorClient },
      reproducerDeps: { client: mockReproClient },
      fixerDeps: { client: mockFixerClient },
    }
  );

  // 1. Defect was verified before fix (failed with AssertionError)
  assert.equal(result.reproBeforeFixFailed, true);
  assert.equal(result.verifierOutput?.same_defect, true);

  // 2. Patch applied in sandbox made the repro test pass!
  assert.equal(result.reproAfterFixPassed, true);

  // 3. Baseline tests in sandbox remained green!
  assert.equal(result.baselineRegressionPassed, true);

  // 4. Overall status is 'fixed'
  assert.equal(result.status, 'fixed');
  assert.ok(result.summary.includes('successfully reproduced, verified, and fixed'));

  // 5. Reporter output is present and validated
  assert.ok(result.reporterOutput);
  assert.equal(result.reporterOutput.status, 'fixed');
  assert.equal(result.reporterOutput.verification.repro_after_fix_passed, true);
  assert.equal(result.reporterOutput.verification.baseline_regression_passed, true);
  assert.ok(result.reporterOutput.markdown_report.includes('Replay Run Report — FIXED'));
});

test('runPipeline emits chronological RunEvents across stages and validates sequence', async () => {
  const events: any[] = [];
  const mockLocatorClient = {
    async callJson<T>() {
      return {
        data: {
          suspects: [{ file: 'src/App.tsx', start_line: 84, end_line: 93, symbol: 'handleQuantityChange', confidence: 0.95, symptom_link: 'link' }],
          suggested_test_selectors: [],
          route: '/?bug=cart-nan',
        } as unknown as T,
        rawText: '{}',
        metrics: { promptTokens: 10, completionTokens: 10, totalTokens: 20, durationMs: 10, model: 'test' },
      };
    },
  };

  const mockReproClient = {
    async callJson<T>() {
      return {
        data: {
          reproduced: true,
          test_name: 'test pass',
          assertion: 'expect(1).toBe(1)',
          failure_message: '',
          test_code: "import { test, expect } from '@playwright/test'; test('t', async () => { expect(1).toBe(1); });",
        } as unknown as T,
        rawText: '{}',
        metrics: { promptTokens: 10, completionTokens: 10, totalTokens: 20, durationMs: 10, model: 'test' },
      };
    },
  };

  const res = await runFixAndVerifyPipeline(
    CART_NAN_REPORT,
    {
      targetRepoRoot: DEMO_SHOP_DIR,
      sampleId: 'cart-nan',
      onEvent: (e) => {
        events.push(e);
      },
    },
    {
      locatorDeps: { client: mockLocatorClient },
      reproducerDeps: { client: mockReproClient },
    }
  );

  assert.ok(events.length >= 5);
  // Verify sequential ordering
  for (let i = 0; i < events.length; i++) {
    assert.equal(events[i].seq, i + 1);
    assert.equal(events[i].run_id, res.runId);
  }
  const stages = events.map(e => e.stage);
  assert.ok(stages.includes('ingest'));
  assert.ok(stages.includes('watch'));
  assert.ok(stages.includes('locate'));
  assert.ok(stages.includes('reproduce'));
  assert.ok(stages.includes('verify'));
  assert.ok(stages.includes('report'));
  assert.equal(res.status, 'unreproduced');
});

