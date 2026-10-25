import assert from 'node:assert/strict';
import test from 'node:test';
import { BugReportSchema, ReproducerOutputSchema } from '@replay/shared';
import {
  buildVerifierMessages,
  loadVerifierPrompt,
  verifyExecutionDeterministically,
  verifyReproduction,
} from './verifier.js';
import { ReproExecutionResult } from './reproducer.js';

const MOCK_BUG_REPORT = BugReportSchema.parse({
  defect_found: true,
  summary: 'Cart total becomes NaN after clearing quantity field',
  steps: [{ timestamp_s: 2.5, description: 'Cleared quantity input' }],
  first_failure_timestamp_s: 2.5,
  expected_behavior: 'Cart total should be a valid number ($0.00)',
  actual_behavior: 'Cart total displays as $NaN',
  visible_text: ['Cart', '$NaN'],
  route: '/?bug=cart-nan',
  confidence: 0.95,
});

const MOCK_REPRODUCER_OUTPUT = ReproducerOutputSchema.parse({
  reproduced: true,
  test_name: 'reproduce: cart total becomes NaN after clearing quantity',
  assertion: "await expect(page.getByTestId('cart-total')).not.toHaveText('$NaN')",
  failure_message: "Expected not '$NaN', received '$NaN'",
  test_code: "import { test, expect } from '@playwright/test'; test('cart-nan', async ({ page }) => {});",
});

test('loadVerifierPrompt loads versioned prompt', () => {
  const prompt = loadVerifierPrompt();
  assert.ok(prompt.includes('Verifier'));
  assert.ok(prompt.includes('GENUINE_REPRODUCTION'));
  assert.ok(prompt.includes('UNEXPECTED_PASS'));
});

test('verifyExecutionDeterministically classifies UNEXPECTED_PASS when exitCode is 0', () => {
  const execResult: ReproExecutionResult = {
    classification: 'UNEXPECTED_PASS',
    passedReproGate: false,
    exitCode: 0,
    stdout: '1 passed (1.2s)',
    stderr: '',
    durationMs: 1200,
    reproFilePath: '/tmp/test.spec.ts',
    summary: 'Test passed unexpectedly.',
  };

  const res = verifyExecutionDeterministically({
    bugReport: MOCK_BUG_REPORT,
    reproducerOutput: MOCK_REPRODUCER_OUTPUT,
    executionResult: execResult,
  });

  assert.equal(res.same_defect, false);
  assert.equal(res.classification, 'UNEXPECTED_PASS');
});

test('verifyExecutionDeterministically classifies INFRASTRUCTURE_FAILURE on network/server errors', () => {
  const execResult: ReproExecutionResult = {
    classification: 'INFRASTRUCTURE_ERROR',
    passedReproGate: false,
    exitCode: 1,
    stdout: '',
    stderr: 'net::ERR_CONNECTION_REFUSED at http://localhost:5173',
    durationMs: 500,
    reproFilePath: '/tmp/test.spec.ts',
    summary: 'Infrastructure or webServer connection failure.',
  };

  const res = verifyExecutionDeterministically({
    bugReport: MOCK_BUG_REPORT,
    reproducerOutput: MOCK_REPRODUCER_OUTPUT,
    executionResult: execResult,
  });

  assert.equal(res.same_defect, false);
  assert.equal(res.classification, 'INFRASTRUCTURE_FAILURE');
});

test('verifyExecutionDeterministically classifies COMPILATION_OR_RUNTIME_ERROR on syntax/module errors', () => {
  const execResult: ReproExecutionResult = {
    classification: 'COMPILATION_OR_SYNTAX',
    passedReproGate: false,
    exitCode: 1,
    stdout: '',
    stderr: 'SyntaxError: Unexpected identifier',
    durationMs: 300,
    reproFilePath: '/tmp/test.spec.ts',
    summary: 'Compilation or syntax error in test code.',
  };

  const res = verifyExecutionDeterministically({
    bugReport: MOCK_BUG_REPORT,
    reproducerOutput: MOCK_REPRODUCER_OUTPUT,
    executionResult: execResult,
  });

  assert.equal(res.same_defect, false);
  assert.equal(res.classification, 'COMPILATION_OR_RUNTIME_ERROR');
});

test('verifyExecutionDeterministically classifies SELECTOR_OR_TIMEOUT on element timeouts', () => {
  const execResult: ReproExecutionResult = {
    classification: 'TIMEOUT_OR_SELECTOR',
    passedReproGate: false,
    exitCode: 1,
    stdout: 'waiting for getByTestId("missing-button") Timed out 5000ms',
    stderr: 'Test timeout of 30000ms exceeded',
    durationMs: 30000,
    reproFilePath: '/tmp/test.spec.ts',
    summary: 'Selector or timeout error: element not found or page stalled.',
  };

  const res = verifyExecutionDeterministically({
    bugReport: MOCK_BUG_REPORT,
    reproducerOutput: MOCK_REPRODUCER_OUTPUT,
    executionResult: execResult,
  });

  assert.equal(res.same_defect, false);
  assert.equal(res.classification, 'SELECTOR_OR_TIMEOUT');
});

test('verifyExecutionDeterministically detects genuine reproduction matching defect symptoms', () => {
  const execResult: ReproExecutionResult = {
    classification: 'ASSERTION_FAILURE',
    passedReproGate: true,
    exitCode: 1,
    stdout: "Error: expect(locator).not.toHaveText(expected)\nExpected: not '$NaN'\nReceived: '$NaN'",
    stderr: '',
    durationMs: 4000,
    reproFilePath: '/tmp/test.spec.ts',
    summary: 'Genuine assertion failure: bug successfully reproduced!',
  };

  const res = verifyExecutionDeterministically({
    bugReport: MOCK_BUG_REPORT,
    reproducerOutput: MOCK_REPRODUCER_OUTPUT,
    executionResult: execResult,
  });

  assert.equal(res.same_defect, true);
  assert.equal(res.classification, 'GENUINE_REPRODUCTION');
  assert.ok(res.reason.includes('nan'));
});

test('verifyExecutionDeterministically rejects assertion failure unrelated to bug report', () => {
  const execResult: ReproExecutionResult = {
    classification: 'ASSERTION_FAILURE',
    passedReproGate: true,
    exitCode: 1,
    stdout: "Error: expect(locator).toHaveTitle(expected)\nExpected: 'Store'\nReceived: 'Welcome Page'",
    stderr: '',
    durationMs: 2500,
    reproFilePath: '/tmp/test.spec.ts',
    summary: 'Failed title check.',
  };

  const res = verifyExecutionDeterministically({
    bugReport: MOCK_BUG_REPORT,
    reproducerOutput: MOCK_REPRODUCER_OUTPUT,
    executionResult: execResult,
  });

  assert.equal(res.same_defect, false);
  assert.equal(res.classification, 'UNRELATED_ASSERTION_FAILURE');
});

test('verifyReproduction prevents AI model from overriding contradictory execution evidence', async () => {
  const passedExec: ReproExecutionResult = {
    classification: 'UNEXPECTED_PASS',
    passedReproGate: false,
    exitCode: 0,
    stdout: '1 passed',
    stderr: '',
    durationMs: 1000,
    reproFilePath: '/tmp/test.spec.ts',
    summary: 'Test passed.',
  };

  // Mock model hallucinating same_defect: true
  const hallucinatingClient = {
    async callJson<T>() {
      return {
        data: {
          same_defect: true,
          classification: 'GENUINE_REPRODUCTION',
          reason: 'Model hallucination: I think this reproduced it even though exit code was 0',
          confidence: 0.99,
        } as unknown as T,
        rawText: '{}',
        metrics: { promptTokens: 10, completionTokens: 10, totalTokens: 20, durationMs: 50, model: 'test' },
      };
    },
  };

  const res = await verifyReproduction(
    {
      bugReport: MOCK_BUG_REPORT,
      reproducerOutput: MOCK_REPRODUCER_OUTPUT,
      executionResult: passedExec,
    },
    { client: hallucinatingClient }
  );

  // Invariant holds: deterministic gate overrides model hallucination!
  assert.equal(res.output.same_defect, false);
  assert.equal(res.output.classification, 'UNEXPECTED_PASS');
});

test('buildVerifierMessages formats prompt with bug report, test code, and execution logs', () => {
  const execResult: ReproExecutionResult = {
    classification: 'ASSERTION_FAILURE',
    passedReproGate: true,
    exitCode: 1,
    stdout: "Received '$NaN'",
    stderr: '',
    durationMs: 2000,
    reproFilePath: '/tmp/test.spec.ts',
    summary: 'Assertion failed.',
  };

  const messages = buildVerifierMessages({
    bugReport: MOCK_BUG_REPORT,
    reproducerOutput: MOCK_REPRODUCER_OUTPUT,
    executionResult: execResult,
  });

  assert.equal(messages.length, 2);
  const sysMsg = messages[0];
  const userMsg = messages[1];
  assert.ok(sysMsg && userMsg);
  assert.equal(sysMsg.role, 'system');
  assert.equal(userMsg.role, 'user');
  const userContent = String(userMsg.content);
  assert.ok(userContent.includes('Cart total becomes NaN'));
  assert.ok(userContent.includes("Received '$NaN'"));
});
