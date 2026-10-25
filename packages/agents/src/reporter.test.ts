import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { BugReport, ReporterOutputSchema } from '@replay/shared';
import {
  buildDeterministicMarkdownReport,
  generateReport,
  loadReporterPrompt,
  REPORTER_PROMPT_VERSION,
  ReportInputData,
} from './reporter.js';
import { LlmClient, LlmResponse } from './llm.js';

const SAMPLE_BUG_REPORT: BugReport = {
  defect_found: true,
  summary: 'Cart total becomes NaN after clearing quantity field',
  steps: [
    { timestamp_s: 2, description: 'Added mouse to cart' },
    { timestamp_s: 5, description: 'Navigated to cart' },
    { timestamp_s: 8, description: 'Cleared quantity input' },
  ],
  first_failure_timestamp_s: 8,
  expected_behavior: 'Total should remain a valid currency number ($0.00).',
  actual_behavior: "Total displays '$NaN'.",
  visible_text: ['Cart', '$NaN'],
  route: '/#cart',
  confidence: 0.98,
};

const SAMPLE_INPUT_DATA: ReportInputData = {
  runId: '11111111-2222-3333-4444-555555555555',
  status: 'fixed',
  videoAnalysis: 'fixture_assisted',
  bugReport: SAMPLE_BUG_REPORT,
  locatorOutput: {
    suspects: [
      {
        file: 'src/App.tsx',
        start_line: 84,
        end_line: 105,
        symbol: 'handleQuantityChange',
        confidence: 0.95,
        symptom_link: 'Unvalidated parseInt on empty string',
        evidence: 'const qty = parseInt(rawValue, 10);',
      },
    ],
    suggested_test_selectors: ['nav-cart', 'cart-total'],
    route: '/#cart',
  },
  reproducerOutput: {
    reproduced: true,
    test_name: 'reproduce cart total becomes NaN',
    assertion: "expect(page.getByTestId('cart-total')).not.toHaveText('$NaN')",
    failure_message: "Expected not: '$NaN', Received: '$NaN'",
    test_code: "import { test, expect } from '@playwright/test';\ntest('repro', async () => {});",
  },
  verifierOutput: {
    same_defect: true,
    classification: 'GENUINE_REPRODUCTION',
    reason: 'Assertion failed with $NaN matching defect report',
    confidence: 1,
  },
  fixerOutput: {
    fixed: true,
    target_file: 'src/App.tsx',
    explanation: 'Safely parse integer and fallback to 0 when input is cleared.',
    original_snippet: 'const qty = parseInt(rawValue, 10);',
    replacement_snippet: 'let qty = parseInt(rawValue, 10); if (isNaN(qty)) qty = 0;',
    patch: 'diff --git a/src/App.tsx b/src/App.tsx',
    attempts: 1,
  },
  reproBeforeFixFailed: true,
  reproAfterFixPassed: true,
  baselineRegressionPassed: true,
  attempts: 1,
  durationMs: 34200,
  blockedStages: ['Live video extraction omitted: using fixture-assisted clip metadata'],
};

describe('Reporter Agent', () => {
  it('loadReporterPrompt loads versioned prompt', () => {
    const prompt = loadReporterPrompt();
    assert.ok(prompt.includes('Reporter — v1'));
    assert.ok(prompt.includes('executive_summary'));
    assert.equal(REPORTER_PROMPT_VERSION, 'v1');
  });

  it('buildDeterministicMarkdownReport includes all critical evidence sections', () => {
    const md = buildDeterministicMarkdownReport(SAMPLE_INPUT_DATA);

    assert.ok(md.includes('# Replay Run Report — FIXED'));
    assert.ok(md.includes('11111111-2222-3333-4444-555555555555'));
    assert.ok(md.includes('FIXTURE_ASSISTED'));
    assert.ok(md.includes('34.2s'));
    assert.ok(md.includes('Cart total becomes NaN after clearing quantity field'));
    assert.ok(md.includes('handleQuantityChange'));
    assert.ok(md.includes('src/App.tsx'));
    assert.ok(md.includes('L84-105'));
    assert.ok(md.includes('GENUINE_REPRODUCTION'));
    assert.ok(md.includes('Safely parse integer and fallback to 0'));
    assert.ok(md.includes('Reproduction Test Post-Fix**: ✅ **PASSED'));
    assert.ok(md.includes('Baseline Regression Suite**: ✅ **GREEN'));
    assert.ok(md.includes('Live video extraction omitted'));
  });

  it('generateReport produces schema-valid ReporterOutput without LLM (offline mode)', async () => {
    const res = await generateReport(SAMPLE_INPUT_DATA, { skipLlm: true });
    assert.ok(res.output);

    const validated = ReporterOutputSchema.parse(res.output);
    assert.equal(validated.run_id, '11111111-2222-3333-4444-555555555555');
    assert.equal(validated.status, 'fixed');
    assert.equal(validated.video_analysis, 'fixture_assisted');
    assert.equal(validated.culprit_locations.length, 1);
    assert.equal(validated.culprit_locations[0]?.file, 'src/App.tsx');
    assert.equal(validated.verification.repro_after_fix_passed, true);
    assert.equal(validated.verification.baseline_regression_passed, true);
    assert.equal(validated.verification.baseline_tests_passed, 6);
    assert.equal(validated.verification.baseline_tests_total, 6);
  });

  it('generateReport incorporates LLM response when client is provided', async () => {
    const mockLlmClient = {
      async callJson<T>(): Promise<LlmResponse<T>> {
        return {
          data: {
            title: 'fix: handle empty quantity field in cart',
            executive_summary: 'Surgical fix applied to handleQuantityChange preventing NaN propagation in cart state.',
          } as T,
          rawText: '',
          metrics: {
            promptTokens: 100,
            completionTokens: 25,
            totalTokens: 125,
            durationMs: 400,
            model: 'test-model',
          },
        };
      },
    } as unknown as LlmClient;

    const res = await generateReport(SAMPLE_INPUT_DATA, { client: mockLlmClient });
    assert.equal(res.output.title, 'fix: handle empty quantity field in cart');
    assert.ok(res.output.executive_summary.includes('Surgical fix applied to handleQuantityChange'));
  });

  it('buildDeterministicMarkdownReport reports unreproduced and failed runs accurately', () => {
    const failedData: ReportInputData = {
      ...SAMPLE_INPUT_DATA,
      status: 'unreproduced',
      reproBeforeFixFailed: false,
      reproAfterFixPassed: false,
      baselineRegressionPassed: false,
      verifierOutput: {
        same_defect: false,
        classification: 'UNEXPECTED_PASS',
        reason: 'Test passed unexpectedly on buggy code',
        confidence: 1,
      },
      fixerOutput: undefined,
      errors: ['Reproduction test did not fail'],
    };

    const md = buildDeterministicMarkdownReport(failedData);
    assert.ok(md.includes('# Replay Run Report — UNREPRODUCED ❌'));
    assert.ok(md.includes('UNEXPECTED_PASS'));
    assert.ok(md.includes('No verified patch was applied.'));
    assert.ok(md.includes('Error**: Reproduction test did not fail'));
  });
});
