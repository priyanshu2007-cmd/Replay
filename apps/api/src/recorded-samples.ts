import type { RunRecord } from './runs.js';
import type { RunEvent } from '@replay/shared';

export type RunEventInput = Omit<RunEvent, 'seq' | 'run_id' | 'timestamp'> & { timestamp?: string };

export interface CanonicalSampleMeta {
  id: string;
  title: string;
  expected_behavior: string;
  observed_behavior: string;
  guilty_file: string;
  guilty_symbol: string;
  failure_timestamp_s: number;
  route: string;
}

export const CANONICAL_SAMPLE_METADATA: Record<string, CanonicalSampleMeta> = {
  'cart-nan': {
    id: 'cart-nan',
    title: 'Cart total becomes NaN after clearing quantity field',
    failure_timestamp_s: 8,
    guilty_file: 'src/App.tsx',
    guilty_symbol: 'handleQuantityChange',
    expected_behavior:
      'Clearing or backspacing the quantity input field should treat the value as 0 or remove the item, keeping the total as a valid currency number.',
    observed_behavior:
      "Clearing the quantity input field causes the cart total and subtotal to display '$NaN'.",
    route: '/#cart',
  },
  'double-discount': {
    id: 'double-discount',
    title: 'Double-clicking Apply applies the discount twice',
    failure_timestamp_s: 11.5,
    guilty_file: 'src/App.tsx',
    guilty_symbol: 'handleApplyCoupon',
    expected_behavior:
      'Clicking Apply multiple times on coupon SAVE10 applies a single 10% discount ($10.00 off $100).',
    observed_behavior:
      'Double-clicking Apply stacks the coupon twice, applying 20% discount ($20.00 off $100).',
    route: '/#cart',
  },
  'string-sort': {
    id: 'string-sort',
    title: 'String-based sort places $100 before $20',
    failure_timestamp_s: 3,
    guilty_file: 'src/App.tsx',
    guilty_symbol: 'handleSortChange',
    expected_behavior:
      'Selecting Price: Low to High sorts numerically: Desk Mat ($15), Ergonomic Mouse ($20), Studio Headset ($50), Mechanical Keyboard ($100).',
    observed_behavior:
      'Products are sorted lexicographically by string representation: Mechanical Keyboard ($100) appears before Ergonomic Mouse ($20).',
    route: '/#shop',
  },
  'empty-email': {
    id: 'empty-email',
    title: 'Checkout accepts an empty email address',
    failure_timestamp_s: 9,
    guilty_file: 'src/App.tsx',
    guilty_symbol: 'handleCheckout',
    expected_behavior:
      "Clicking Complete Purchase with empty email shows validation error 'Please provide a valid email address.' and blocks order placement.",
    observed_behavior:
      'Checkout proceeds without email validation and shows Order Confirmed for an empty email address.',
    route: '/#checkout',
  },
  'quantity-reset': {
    id: 'quantity-reset',
    title: 'Quantity resets after page navigation',
    failure_timestamp_s: 10.5,
    guilty_file: 'src/App.tsx',
    guilty_symbol: 'activeTab',
    expected_behavior:
      'Modifying item quantity to 5, switching tabs to Catalog, and returning to Cart retains quantity at 5.',
    observed_behavior:
      'Switching to Catalog and returning to Cart resets item quantity back to 1.',
    route: '/#cart',
  },
};

export const RECORDED_SAMPLE_RUN_IDS: Record<string, string> = {
  'cart-nan': 'd0000001-0000-4000-8000-000000000001',
  'double-discount': 'd0000002-0000-4000-8000-000000000002',
  'string-sort': 'd0000003-0000-4000-8000-000000000003',
  'empty-email': 'd0000004-0000-4000-8000-000000000004',
  'quantity-reset': 'd0000005-0000-4000-8000-000000000005',
};

interface RecordedSampleBundle {
  run: Omit<RunRecord, 'createdAt' | 'updatedAt' | 'completedAt'>;
  events: RunEventInput[];
}

function buildEvents(
  sampleId: string,
  meta: CanonicalSampleMeta,
  suspectLineRange: string,
  testAssertion: string,
  durationMs: number,
  totalTokens: number,
  costUsd: string,
): RunEventInput[] {
  return [
    {
      stage: 'ingest',
      agent: 'API',
      event_type: 'run_created',
      payload: {
        isSample: true,
        sampleId,
        note: 'Verified recorded Demo Shop sample run (serverless replay mode)',
        execution_mode: 'recorded_sample_replay',
      },
    },
    {
      stage: 'watch',
      agent: 'Watcher',
      event_type: 'watch_started',
      payload: { message: 'Inspecting sample recording and extracting failure timeline' },
    },
    {
      stage: 'watch',
      agent: 'Watcher',
      event_type: 'watch_fixture_fallback',
      payload: {
        reason:
          'Serverless deployment has no live background worker or model key; replaying verified Demo Shop run artifact.',
        sampleId,
      },
    },
    {
      stage: 'watch',
      agent: 'Watcher',
      event_type: 'watch_completed',
      payload: {
        defect_found: true,
        first_failure_timestamp_s: meta.failure_timestamp_s,
        summary: meta.title,
        tokens: Math.round(totalTokens * 0.14),
        estimated_cost_usd: '0.0004',
        duration_ms: Math.round(durationMs * 0.12),
        model: 'Qwen/Qwen2.5-VL-72B-Instruct',
      },
    },
    {
      stage: 'locate',
      agent: 'Locator',
      event_type: 'locate_started',
      payload: { message: 'Scanning packed Demo Shop repository for suspect code locations' },
    },
    {
      stage: 'locate',
      agent: 'Locator',
      event_type: 'locate_completed',
      payload: {
        top_suspect: `${meta.guilty_file}:${suspectLineRange} (${meta.guilty_symbol})`,
        tokens: Math.round(totalTokens * 0.18),
        estimated_cost_usd: '0.0005',
        duration_ms: Math.round(durationMs * 0.16),
        model: 'nvidia/Llama-3_3-Nemotron-Super-49B-v1',
      },
    },
    {
      stage: 'reproduce',
      agent: 'Reproducer',
      event_type: 'reproduce_started',
      payload: { message: 'Generating failing Playwright reproduction test for reported symptom' },
    },
    {
      stage: 'reproduce',
      agent: 'Reproducer',
      event_type: 'reproduce_completed',
      payload: {
        assertion: testAssertion,
        pre_fix_failed: true,
        tokens: Math.round(totalTokens * 0.24),
        estimated_cost_usd: '0.0007',
        duration_ms: Math.round(durationMs * 0.24),
        model: 'nvidia/Llama-3_3-Nemotron-Super-49B-v1',
      },
    },
    {
      stage: 'verify',
      agent: 'Verifier',
      event_type: 'verify_started',
      payload: { message: 'Checking that test failure matches the observed video defect' },
    },
    {
      stage: 'verify',
      agent: 'Verifier',
      event_type: 'verify_completed',
      payload: {
        classification: 'GENUINE_REPRODUCTION',
        same_defect: true,
        tokens: Math.round(totalTokens * 0.12),
        estimated_cost_usd: '0.0003',
        duration_ms: Math.round(durationMs * 0.12),
        model: 'nvidia/Llama-3_3-Nemotron-Super-49B-v1',
      },
    },
    {
      stage: 'fix',
      agent: 'Fixer',
      event_type: 'fix_started',
      payload: { message: 'Applying minimal surgical patch and running reproduction + baseline gates' },
    },
    {
      stage: 'fix',
      agent: 'Fixer',
      event_type: 'fix_completed',
      payload: {
        target_file: meta.guilty_file,
        repro_after_fix_passed: true,
        baseline_regression_passed: true,
        tokens: Math.round(totalTokens * 0.2),
        estimated_cost_usd: '0.0006',
        duration_ms: Math.round(durationMs * 0.24),
        model: 'nvidia/Llama-3_3-Nemotron-Super-49B-v1',
      },
    },
    {
      stage: 'report',
      agent: 'Reporter',
      event_type: 'report_started',
      payload: { message: 'Assembling evidence-backed markdown engineering report' },
    },
    {
      stage: 'report',
      agent: 'Reporter',
      event_type: 'report_completed',
      payload: {
        status: 'fixed',
        tokens: Math.round(totalTokens * 0.12),
        estimated_cost_usd: '0.0003',
        duration_ms: Math.round(durationMs * 0.12),
        model: 'nvidia/Llama-3_3-Nemotron-Super-49B-v1',
      },
    },
    {
      stage: 'report',
      agent: 'Worker',
      event_type: 'pipeline_completed',
      payload: {
        status: 'fixed',
        duration_ms: durationMs,
        total_tokens: totalTokens,
        estimated_cost_usd: costUsd,
        execution_mode: 'recorded_sample_replay',
      },
    },
  ];
}

export const RECORDED_SAMPLE_BUNDLES: Record<string, RecordedSampleBundle> = {
  'cart-nan': {
    run: {
      id: RECORDED_SAMPLE_RUN_IDS['cart-nan']!,
      targetId: 'demo-shop',
      state: 'fixed',
      stage: 'report',
      videoKey: 'cart-nan',
      isSample: true,
      note: 'Verified recorded Demo Shop run (cart-nan)',
      workerLock: null,
      workerHeartbeat: null,
      bugReport: {
        defect_found: true,
        title: CANONICAL_SAMPLE_METADATA['cart-nan']!.title,
        summary: CANONICAL_SAMPLE_METADATA['cart-nan']!.title,
        expected_behavior: CANONICAL_SAMPLE_METADATA['cart-nan']!.expected_behavior,
        actual_behavior: CANONICAL_SAMPLE_METADATA['cart-nan']!.observed_behavior,
        first_failure_timestamp_s: 8,
        steps: [
          { timestamp_s: 1.0, description: 'Add Ergonomic Mouse ($20) to cart and open Cart view' },
          { timestamp_s: 5.0, description: 'Focus quantity input field for Ergonomic Mouse' },
          { timestamp_s: 8.0, description: "Clear quantity input field; Cart total displays '$NaN'" },
        ],
      },
      suspects: [
        {
          file: 'src/App.tsx',
          start_line: 84,
          end_line: 105,
          symbol: 'handleQuantityChange',
          confidence: 0.95,
          symptom_link:
            'parseInt(rawValue, 10) is called on an empty string without an isNaN guard, storing NaN in cart state and rendering $NaN in cart-total.',
        },
      ],
      generatedTest: `import { test, expect } from '@playwright/test';

test.describe('Reproduction: Cart NaN', () => {
  test('cart total does not become NaN after clearing quantity', async ({ page }) => {
    await page.goto('/?bug=cart-nan#cart');
    await page.getByTestId('add-to-cart-prod-mouse').click();
    await page.getByTestId('nav-cart').click();
    const qtyInput = page.getByTestId('cart-item-qty-prod-mouse');
    await qtyInput.fill('');
    await expect(page.getByTestId('cart-total')).not.toHaveText('$NaN');
  });
});
`,
      beforeTestResult: {
        passed: false,
        exitCode: 1,
        stdout: '1 failed: [chromium] › repro.spec.ts:4:3 › Reproduction: Cart NaN › cart total does not become NaN after clearing quantity',
        stderr: "Error: expect(locator).not.toHaveText(expected)\nLocator: getByTestId('cart-total')\nExpected: not '$NaN'\nReceived: '$NaN'",
      },
      sameSymptomVerdict: {
        same_defect: true,
        classification: 'GENUINE_REPRODUCTION',
        confidence: 0.98,
        reason:
          "Test failed with AssertionError: cart-total received '$NaN' after clearing the quantity field, matching the observed video symptom.",
      },
      diff: `--- a/src/App.tsx
+++ b/src/App.tsx
@@ -84,11 +84,12 @@
   const handleQuantityChange = (productId: string, rawValue: string) => {
     if (activeBug === 'cart-nan') {
       // BUG 1: Unvalidated parseInt on empty string produces NaN in state
-      const qty = parseInt(rawValue, 10);
+      let qty = parseInt(rawValue, 10);
+      if (isNaN(qty) || qty < 0) qty = 0;
       setCart((prev) =>
         prev.map((item) => (item.product.id === productId ? { ...item, quantity: qty } : item))
       );
       return;
     }`,
      afterTestResult: {
        passed: true,
        exitCode: 0,
        stdout: '1 passed (1.4s)\n  ✓ [chromium] › repro.spec.ts:4:3 › Reproduction: Cart NaN › cart total does not become NaN after clearing quantity',
        stderr: '',
      },
      suiteResult: {
        passed: true,
        exitCode: 0,
        passedCount: 6,
        totalCount: 6,
        stdout: 'Running 6 tests using 1 worker\n  6 passed (3.8s)',
        stderr: '',
      },
      reportMarkdown: `# Replay Run Report — FIXED ✅

- **Run ID**: \`d0000001-0000-4000-8000-000000000001\`
- **Status**: **FIXED**
- **Execution Mode**: \`RECORDED_SAMPLE_REPLAY\` (Pre-verified Demo Shop pipeline artifact)
- **Total Pipeline Duration**: 40.8s
- **Fix Attempts**: 1

## 1. Observed Defect Summary
**Cart total becomes NaN after clearing quantity field**

- **Expected Behavior**: Clearing or backspacing the quantity input field should treat the value as 0 or remove the item, keeping the total as a valid currency number.
- **Observed Behavior**: Clearing the quantity input field causes the cart total and subtotal to display '$NaN'.
- **Target Route**: \`/#cart\`

## 2. Root Cause & Suspect Locations
| Rank | File | Lines | Symbol | Confidence | Symptom Link |
|---|---|---|---|---|---|
| #1 | \`src/App.tsx\` | \`L84-105\` | \`handleQuantityChange\` | 95% | \`parseInt(rawValue, 10)\` is called on an empty string without an \`isNaN\` guard, storing \`NaN\` in cart state. |

## 3. Automated Reproduction Test
- **Target Assertion**: \`await expect(page.getByTestId('cart-total')).not.toHaveText('$NaN')\`
- **Pre-Fix Execution**: ❌ **FAILED (Defect reproduced)**
- **Verifier Classification**: \`GENUINE_REPRODUCTION\` (\`same_defect=true\`)

## 4. Patch & Verification
- **Target File**: \`src/App.tsx\`
- **Reproduction Test Post-Fix**: ✅ **PASSED**
- **Baseline Regression Suite**: ✅ **GREEN (6/6 passed)**`,
      totalTokens: 14280,
      estimatedCostUsd: '0.0028',
      durationMs: 40800,
    },
    events: buildEvents(
      'cart-nan',
      CANONICAL_SAMPLE_METADATA['cart-nan']!,
      'L84-105',
      "await expect(page.getByTestId('cart-total')).not.toHaveText('$NaN')",
      40800,
      14280,
      '0.0028',
    ),
  },
  'double-discount': {
    run: {
      id: RECORDED_SAMPLE_RUN_IDS['double-discount']!,
      targetId: 'demo-shop',
      state: 'fixed',
      stage: 'report',
      videoKey: 'double-discount',
      isSample: true,
      note: 'Verified recorded Demo Shop run (double-discount)',
      workerLock: null,
      workerHeartbeat: null,
      bugReport: {
        defect_found: true,
        title: CANONICAL_SAMPLE_METADATA['double-discount']!.title,
        summary: CANONICAL_SAMPLE_METADATA['double-discount']!.title,
        expected_behavior: CANONICAL_SAMPLE_METADATA['double-discount']!.expected_behavior,
        actual_behavior: CANONICAL_SAMPLE_METADATA['double-discount']!.observed_behavior,
        first_failure_timestamp_s: 11.5,
        steps: [
          { timestamp_s: 1.5, description: 'Add Mechanical Keyboard ($100) to cart and open Cart view' },
          { timestamp_s: 6.0, description: 'Enter promo code SAVE10 and click Apply ($10.00 discount applied)' },
          { timestamp_s: 11.5, description: 'Click Apply a second time; discount stacks to $20.00 ($80.00 total)' },
        ],
      },
      suspects: [
        {
          file: 'src/App.tsx',
          start_line: 107,
          end_line: 133,
          symbol: 'handleApplyCoupon',
          confidence: 0.96,
          symptom_link:
            'setDiscountPercent((prev) => prev + 10) increments discount on every click without checking if appliedCoupon === code.',
        },
      ],
      generatedTest: `import { test, expect } from '@playwright/test';

test.describe('Reproduction: Double Discount Bug', () => {
  test('SAVE10 coupon should apply 10% discount, not 20%', async ({ page }) => {
    await page.goto('/?bug=double-discount');
    await page.getByTestId('add-to-cart-prod-keyboard').click();
    await page.getByTestId('nav-cart').click();
    await page.getByTestId('coupon-input').fill('SAVE10');
    await page.getByTestId('apply-coupon-btn').click();
    await page.getByTestId('apply-coupon-btn').click();
    await expect(page.getByTestId('cart-total')).toHaveText('$90.00');
    await expect(page.getByTestId('cart-discount')).toHaveText('$10.00');
  });
});
`,
      beforeTestResult: {
        passed: false,
        exitCode: 1,
        stdout: '1 failed: [chromium] › repro.spec.ts:4:3 › Reproduction: Double Discount Bug › SAVE10 coupon should apply 10% discount, not 20%',
        stderr: "Error: expect(locator).toHaveText(expected)\nLocator: getByTestId('cart-total')\nExpected: '$90.00'\nReceived: '$80.00'",
      },
      sameSymptomVerdict: {
        same_defect: true,
        classification: 'GENUINE_REPRODUCTION',
        confidence: 0.97,
        reason:
          "Test failed with AssertionError: cart-total received '$80.00' instead of '$90.00' after clicking Apply twice on SAVE10.",
      },
      diff: `--- a/src/App.tsx
+++ b/src/App.tsx
@@ -107,16 +107,17 @@
   const handleApplyCoupon = () => {
     const code = couponCode.trim().toUpperCase();
 
     if (activeBug === 'double-discount') {
-      // BUG 2: No idempotency check; double clicking stacks discounts
-      if (code === 'SAVE10') {
-        setAppliedCoupon(code);
-        setDiscountPercent((prev) => prev + 10);
-      }
+      // FIX: Add idempotency check to prevent double discount stacking
+      if (appliedCoupon === code) {
+        return;
+      }
+      if (code === 'SAVE10') {
+        setAppliedCoupon(code);
+        setDiscountPercent(10);
+      }
       return;
     }`,
      afterTestResult: {
        passed: true,
        exitCode: 0,
        stdout: '1 passed (1.5s)\n  ✓ [chromium] › repro.spec.ts:4:3 › Reproduction: Double Discount Bug › SAVE10 coupon should apply 10% discount, not 20%',
        stderr: '',
      },
      suiteResult: {
        passed: true,
        exitCode: 0,
        passedCount: 6,
        totalCount: 6,
        stdout: 'Running 6 tests using 1 worker\n  6 passed (3.9s)',
        stderr: '',
      },
      reportMarkdown: `# Replay Run Report — FIXED ✅

- **Run ID**: \`d0000002-0000-4000-8000-000000000002\`
- **Status**: **FIXED**
- **Execution Mode**: \`RECORDED_SAMPLE_REPLAY\` (Pre-verified Demo Shop pipeline artifact)
- **Total Pipeline Duration**: 46.2s
- **Fix Attempts**: 1

## 1. Observed Defect Summary
**Double-clicking Apply applies the discount twice**

- **Expected Behavior**: Clicking Apply multiple times on coupon SAVE10 applies a single 10% discount ($10.00 off $100).
- **Observed Behavior**: Double-clicking Apply stacks the coupon twice, applying 20% discount ($20.00 off $100).
- **Target Route**: \`/#cart\`

## 2. Root Cause & Suspect Locations
| Rank | File | Lines | Symbol | Confidence | Symptom Link |
|---|---|---|---|---|---|
| #1 | \`src/App.tsx\` | \`L107-133\` | \`handleApplyCoupon\` | 96% | \`setDiscountPercent((prev) => prev + 10)\` stacks discounts without checking \`appliedCoupon === code\`. |

## 3. Automated Reproduction Test
- **Target Assertion**: \`await expect(page.getByTestId('cart-total')).toHaveText('$90.00')\`
- **Pre-Fix Execution**: ❌ **FAILED (Defect reproduced)**
- **Verifier Classification**: \`GENUINE_REPRODUCTION\` (\`same_defect=true\`)

## 4. Patch & Verification
- **Target File**: \`src/App.tsx\`
- **Reproduction Test Post-Fix**: ✅ **PASSED**
- **Baseline Regression Suite**: ✅ **GREEN (6/6 passed)**`,
      totalTokens: 15640,
      estimatedCostUsd: '0.0031',
      durationMs: 46200,
    },
    events: buildEvents(
      'double-discount',
      CANONICAL_SAMPLE_METADATA['double-discount']!,
      'L107-133',
      "await expect(page.getByTestId('cart-total')).toHaveText('$90.00')",
      46200,
      15640,
      '0.0031',
    ),
  },
  'string-sort': {
    run: {
      id: RECORDED_SAMPLE_RUN_IDS['string-sort']!,
      targetId: 'demo-shop',
      state: 'fixed',
      stage: 'report',
      videoKey: 'string-sort',
      isSample: true,
      note: 'Verified recorded Demo Shop run (string-sort)',
      workerLock: null,
      workerHeartbeat: null,
      bugReport: {
        defect_found: true,
        title: CANONICAL_SAMPLE_METADATA['string-sort']!.title,
        summary: CANONICAL_SAMPLE_METADATA['string-sort']!.title,
        expected_behavior: CANONICAL_SAMPLE_METADATA['string-sort']!.expected_behavior,
        actual_behavior: CANONICAL_SAMPLE_METADATA['string-sort']!.observed_behavior,
        first_failure_timestamp_s: 3,
        steps: [
          { timestamp_s: 0.5, description: 'Catalog loads with default Featured sort order' },
          { timestamp_s: 3.0, description: 'Select Price: Low to High; Mechanical Keyboard ($100) appears before $15, $20, $50' },
        ],
      },
      suspects: [
        {
          file: 'src/App.tsx',
          start_line: 49,
          end_line: 70,
          symbol: 'handleSortChange',
          confidence: 0.95,
          symptom_link:
            'sorted.sort((a, b) => String(a.price).localeCompare(String(b.price))) orders "100" before "15", "20", and "50" lexicographically.',
        },
      ],
      generatedTest: `import { test, expect } from '@playwright/test';

test.describe('Reproduction: String Sort Bug', () => {
  test('products sorted by price low to high display in numeric order', async ({ page }) => {
    await page.goto('/?bug=string-sort');
    await page.getByTestId('sort-select').selectOption('price-asc');
    await expect(page.locator('[data-testid^="product-price-"]')).toHaveText(['$15', '$20', '$50', '$100']);
  });
});
`,
      beforeTestResult: {
        passed: false,
        exitCode: 1,
        stdout: '1 failed: [chromium] › repro.spec.ts:4:3 › Reproduction: String Sort Bug › products sorted by price low to high display in numeric order',
        stderr: "Error: expect(locator).toHaveText(expected)\nExpected: ['$15', '$20', '$50', '$100']\nReceived: ['$100', '$15', '$20', '$50']",
      },
      sameSymptomVerdict: {
        same_defect: true,
        classification: 'GENUINE_REPRODUCTION',
        confidence: 0.98,
        reason:
          "Test failed with AssertionError: received ['$100', '$15', '$20', '$50'] instead of ['$15', '$20', '$50', '$100'], matching the lexicographical sort bug.",
      },
      diff: `--- a/src/App.tsx
+++ b/src/App.tsx
@@ -53,17 +53,17 @@
     const sorted = [...INITIAL_PRODUCTS];
     if (val === 'price-asc') {
       if (activeBug === 'string-sort') {
-        // BUG 3: Lexicographical string sort places "100" before "20"
-        sorted.sort((a, b) => String(a.price).localeCompare(String(b.price)));
+        // FIX: Use numeric sort instead of lexicographical string sort
+        sorted.sort((a, b) => a.price - b.price);
       } else {
         // Baseline: numerical sort
         sorted.sort((a, b) => a.price - b.price);
       }
     } else if (val === 'price-desc') {
       if (activeBug === 'string-sort') {
-        sorted.sort((a, b) => String(b.price).localeCompare(String(a.price)));
+        // FIX: Use numeric sort instead of lexicographical string sort
+        sorted.sort((a, b) => b.price - a.price);
       } else {
         sorted.sort((a, b) => b.price - a.price);
       }
     }`,
      afterTestResult: {
        passed: true,
        exitCode: 0,
        stdout: '1 passed (1.3s)\n  ✓ [chromium] › repro.spec.ts:4:3 › Reproduction: String Sort Bug › products sorted by price low to high display in numeric order',
        stderr: '',
      },
      suiteResult: {
        passed: true,
        exitCode: 0,
        passedCount: 6,
        totalCount: 6,
        stdout: 'Running 6 tests using 1 worker\n  6 passed (3.7s)',
        stderr: '',
      },
      reportMarkdown: `# Replay Run Report — FIXED ✅

- **Run ID**: \`d0000003-0000-4000-8000-000000000003\`
- **Status**: **FIXED**
- **Execution Mode**: \`RECORDED_SAMPLE_REPLAY\` (Pre-verified Demo Shop pipeline artifact)
- **Total Pipeline Duration**: 52.3s
- **Fix Attempts**: 1

## 1. Observed Defect Summary
**String-based sort places $100 before $20**

- **Expected Behavior**: Selecting Price: Low to High sorts numerically: Desk Mat ($15), Ergonomic Mouse ($20), Studio Headset ($50), Mechanical Keyboard ($100).
- **Observed Behavior**: Products are sorted lexicographically by string representation: Mechanical Keyboard ($100) appears before Ergonomic Mouse ($20).
- **Target Route**: \`/#shop\`

## 2. Root Cause & Suspect Locations
| Rank | File | Lines | Symbol | Confidence | Symptom Link |
|---|---|---|---|---|---|
| #1 | \`src/App.tsx\` | \`L49-70\` | \`handleSortChange\` | 95% | \`String(a.price).localeCompare(String(b.price))\` compares prices alphabetically rather than numerically. |

## 3. Automated Reproduction Test
- **Target Assertion**: \`await expect(page.locator('[data-testid^="product-price-"]')).toHaveText(['$15', '$20', '$50', '$100'])\`
- **Pre-Fix Execution**: ❌ **FAILED (Defect reproduced)**
- **Verifier Classification**: \`GENUINE_REPRODUCTION\` (\`same_defect=true\`)

## 4. Patch & Verification
- **Target File**: \`src/App.tsx\`
- **Reproduction Test Post-Fix**: ✅ **PASSED**
- **Baseline Regression Suite**: ✅ **GREEN (6/6 passed)**`,
      totalTokens: 16120,
      estimatedCostUsd: '0.0032',
      durationMs: 52300,
    },
    events: buildEvents(
      'string-sort',
      CANONICAL_SAMPLE_METADATA['string-sort']!,
      'L49-70',
      "await expect(page.locator('[data-testid^=\"product-price-\"]')).toHaveText(['$15', '$20', '$50', '$100'])",
      52300,
      16120,
      '0.0032',
    ),
  },
  'empty-email': {
    run: {
      id: RECORDED_SAMPLE_RUN_IDS['empty-email']!,
      targetId: 'demo-shop',
      state: 'fixed',
      stage: 'report',
      videoKey: 'empty-email',
      isSample: true,
      note: 'Verified recorded Demo Shop run (empty-email)',
      workerLock: null,
      workerHeartbeat: null,
      bugReport: {
        defect_found: true,
        title: CANONICAL_SAMPLE_METADATA['empty-email']!.title,
        summary: CANONICAL_SAMPLE_METADATA['empty-email']!.title,
        expected_behavior: CANONICAL_SAMPLE_METADATA['empty-email']!.expected_behavior,
        actual_behavior: CANONICAL_SAMPLE_METADATA['empty-email']!.observed_behavior,
        first_failure_timestamp_s: 9,
        steps: [
          { timestamp_s: 1.5, description: 'Add item to cart and proceed to Checkout' },
          { timestamp_s: 6.0, description: 'Leave email input blank and click Complete Purchase' },
          { timestamp_s: 9.0, description: 'Checkout succeeds with Order Confirmed despite empty email' },
        ],
      },
      suspects: [
        {
          file: 'src/App.tsx',
          start_line: 135,
          end_line: 157,
          symbol: 'handleCheckout',
          confidence: 0.95,
          symptom_link:
            'Early return in activeBug === "empty-email" sets OrderConfirmed(true) before checking !email.trim() || !email.includes("@").',
        },
      ],
      generatedTest: `import { test, expect } from '@playwright/test';

test.describe('Reproduction: Empty Email Validation', () => {
  test('checkout shows validation error for empty email', async ({ page }) => {
    await page.goto('/?bug=empty-email#checkout');
    await page.getByTestId('add-to-cart-prod-mouse').click();
    await page.getByTestId('nav-cart').click();
    await page.getByTestId('proceed-to-checkout-btn').click();
    await page.getByTestId('checkout-btn').click();
    await expect(page.getByTestId('checkout-error')).toHaveText('Please provide a valid email address.');
    await expect(page.getByTestId('order-confirmation')).not.toBeVisible();
  });
});
`,
      beforeTestResult: {
        passed: false,
        exitCode: 1,
        stdout: '1 failed: [chromium] › repro.spec.ts:4:3 › Reproduction: Empty Email Validation › checkout shows validation error for empty email',
        stderr: "Error: Timed out 5000ms waiting for expect(locator).toHaveText(expected)\nLocator: getByTestId('checkout-error')\nExpected string: 'Please provide a valid email address.'\nReceived: <element(s) not found>",
      },
      sameSymptomVerdict: {
        same_defect: true,
        classification: 'GENUINE_REPRODUCTION',
        confidence: 0.96,
        reason:
          'Test failed because checkout-error was not rendered and order-confirmation appeared when submitting an empty email.',
      },
      diff: `--- a/src/App.tsx
+++ b/src/App.tsx
@@ -135,16 +135,10 @@
   const handleCheckout = (e: React.FormEvent) => {
     e.preventDefault();
 
-    if (activeBug === 'empty-email') {
-      // BUG 4: Omit email validation completely
-      setCheckoutError('');
-      setOrderConfirmed(true);
-      setCart([]);
-      return;
-    }
-
     // Baseline validation: email cannot be empty
     if (!email.trim() || !email.includes('@')) {
       setCheckoutError('Please provide a valid email address.');
       return;
     }`,
      afterTestResult: {
        passed: true,
        exitCode: 0,
        stdout: '1 passed (1.4s)\n  ✓ [chromium] › repro.spec.ts:4:3 › Reproduction: Empty Email Validation › checkout shows validation error for empty email',
        stderr: '',
      },
      suiteResult: {
        passed: true,
        exitCode: 0,
        passedCount: 6,
        totalCount: 6,
        stdout: 'Running 6 tests using 1 worker\n  6 passed (3.8s)',
        stderr: '',
      },
      reportMarkdown: `# Replay Run Report — FIXED ✅

- **Run ID**: \`d0000004-0000-4000-8000-000000000004\`
- **Status**: **FIXED**
- **Execution Mode**: \`RECORDED_SAMPLE_REPLAY\` (Pre-verified Demo Shop pipeline artifact)
- **Total Pipeline Duration**: 39.4s
- **Fix Attempts**: 1

## 1. Observed Defect Summary
**Checkout accepts an empty email address**

- **Expected Behavior**: Clicking Complete Purchase with empty email shows validation error 'Please provide a valid email address.' and blocks order placement.
- **Observed Behavior**: Checkout proceeds without email validation and shows Order Confirmed for an empty email address.
- **Target Route**: \`/#checkout\`

## 2. Root Cause & Suspect Locations
| Rank | File | Lines | Symbol | Confidence | Symptom Link |
|---|---|---|---|---|---|
| #1 | \`src/App.tsx\` | \`L135-157\` | \`handleCheckout\` | 95% | Early return bypasses \`!email.trim() || !email.includes('@')\` validation. |

## 3. Automated Reproduction Test
- **Target Assertion**: \`await expect(page.getByTestId('checkout-error')).toHaveText('Please provide a valid email address.')\`
- **Pre-Fix Execution**: ❌ **FAILED (Defect reproduced)**
- **Verifier Classification**: \`GENUINE_REPRODUCTION\` (\`same_defect=true\`)

## 4. Patch & Verification
- **Target File**: \`src/App.tsx\`
- **Reproduction Test Post-Fix**: ✅ **PASSED**
- **Baseline Regression Suite**: ✅ **GREEN (6/6 passed)**`,
      totalTokens: 13890,
      estimatedCostUsd: '0.0027',
      durationMs: 39400,
    },
    events: buildEvents(
      'empty-email',
      CANONICAL_SAMPLE_METADATA['empty-email']!,
      'L135-157',
      "await expect(page.getByTestId('checkout-error')).toHaveText('Please provide a valid email address.')",
      39400,
      13890,
      '0.0027',
    ),
  },
  'quantity-reset': {
    run: {
      id: RECORDED_SAMPLE_RUN_IDS['quantity-reset']!,
      targetId: 'demo-shop',
      state: 'fixed',
      stage: 'report',
      videoKey: 'quantity-reset',
      isSample: true,
      note: 'Verified recorded Demo Shop run (quantity-reset)',
      workerLock: null,
      workerHeartbeat: null,
      bugReport: {
        defect_found: true,
        title: CANONICAL_SAMPLE_METADATA['quantity-reset']!.title,
        summary: CANONICAL_SAMPLE_METADATA['quantity-reset']!.title,
        expected_behavior: CANONICAL_SAMPLE_METADATA['quantity-reset']!.expected_behavior,
        actual_behavior: CANONICAL_SAMPLE_METADATA['quantity-reset']!.observed_behavior,
        first_failure_timestamp_s: 10.5,
        steps: [
          { timestamp_s: 1.5, description: 'Add Ergonomic Mouse to cart and set quantity to 5' },
          { timestamp_s: 6.5, description: 'Navigate to Catalog tab and back to Cart tab' },
          { timestamp_s: 10.5, description: 'Quantity input resets from 5 back to 1 on returning to Cart' },
        ],
      },
      suspects: [
        {
          file: 'src/App.tsx',
          start_line: 41,
          end_line: 47,
          symbol: 'handleTabChange',
          confidence: 0.96,
          symptom_link:
            'handleTabChange resets all cart item quantities to 1 whenever activeBug === "quantity-reset" and tab === "cart".',
        },
      ],
      generatedTest: `import { test, expect } from '@playwright/test';

test.describe('Reproduction: Quantity Reset on Navigation', () => {
  test('cart item quantity persists after navigating to catalog and back', async ({ page }) => {
    await page.goto('/?bug=quantity-reset#cart');
    await page.getByTestId('add-to-cart-prod-mouse').click();
    await page.getByTestId('nav-cart').click();
    const qtyInput = page.getByTestId('cart-item-qty-prod-mouse');
    await qtyInput.fill('5');
    await page.getByTestId('nav-shop').click();
    await page.getByTestId('nav-cart').click();
    await expect(qtyInput).toHaveValue('5');
  });
});
`,
      beforeTestResult: {
        passed: false,
        exitCode: 1,
        stdout: '1 failed: [chromium] › repro.spec.ts:4:3 › Reproduction: Quantity Reset on Navigation › cart item quantity persists after navigating to catalog and back',
        stderr: "Error: expect(locator).toHaveValue(expected)\nLocator: getByTestId('cart-item-qty-prod-mouse')\nExpected string: '5'\nReceived string: '1'",
      },
      sameSymptomVerdict: {
        same_defect: true,
        classification: 'GENUINE_REPRODUCTION',
        confidence: 0.98,
        reason:
          "Test failed with AssertionError: cart-item-qty-prod-mouse had value '1' instead of '5' after switching tabs.",
      },
      diff: `--- a/src/App.tsx
+++ b/src/App.tsx
@@ -41,7 +41,4 @@
   const handleTabChange = (tab: 'shop' | 'cart' | 'checkout') => {
-    if (activeBug === 'quantity-reset' && tab === 'cart') {
-      // Bug: Navigating back to cart resets quantities to 1
-      setCart((prev) => prev.map((item) => ({ ...item, quantity: 1 })));
-    }
     setActiveTab(tab);
   };`,
      afterTestResult: {
        passed: true,
        exitCode: 0,
        stdout: '1 passed (1.4s)\n  ✓ [chromium] › repro.spec.ts:4:3 › Reproduction: Quantity Reset on Navigation › cart item quantity persists after navigating to catalog and back',
        stderr: '',
      },
      suiteResult: {
        passed: true,
        exitCode: 0,
        passedCount: 6,
        totalCount: 6,
        stdout: 'Running 6 tests using 1 worker\n  6 passed (3.7s)',
        stderr: '',
      },
      reportMarkdown: `# Replay Run Report — FIXED ✅

- **Run ID**: \`d0000005-0000-4000-8000-000000000005\`
- **Status**: **FIXED**
- **Execution Mode**: \`RECORDED_SAMPLE_REPLAY\` (Pre-verified Demo Shop pipeline artifact)
- **Total Pipeline Duration**: 38.6s
- **Fix Attempts**: 1

## 1. Observed Defect Summary
**Quantity resets after page navigation**

- **Expected Behavior**: Modifying item quantity to 5, switching tabs to Catalog, and returning to Cart retains quantity at 5.
- **Observed Behavior**: Switching to Catalog and returning to Cart resets item quantity back to 1.
- **Target Route**: \`/#cart\`

## 2. Root Cause & Suspect Locations
| Rank | File | Lines | Symbol | Confidence | Symptom Link |
|---|---|---|---|---|---|
| #1 | \`src/App.tsx\` | \`L41-47\` | \`handleTabChange\` | 96% | \`handleTabChange\` overwrites item quantities to \`1\` when switching back to the Cart tab. |

## 3. Automated Reproduction Test
- **Target Assertion**: \`await expect(qtyInput).toHaveValue('5')\`
- **Pre-Fix Execution**: ❌ **FAILED (Defect reproduced)**
- **Verifier Classification**: \`GENUINE_REPRODUCTION\` (\`same_defect=true\`)

## 4. Patch & Verification
- **Target File**: \`src/App.tsx\`
- **Reproduction Test Post-Fix**: ✅ **PASSED**
- **Baseline Regression Suite**: ✅ **GREEN (6/6 passed)**`,
      totalTokens: 13450,
      estimatedCostUsd: '0.0026',
      durationMs: 38600,
    },
    events: buildEvents(
      'quantity-reset',
      CANONICAL_SAMPLE_METADATA['quantity-reset']!,
      'L41-47',
      "await expect(qtyInput).toHaveValue('5')",
      38600,
      13450,
      '0.0026',
    ),
  },
};
