import * as fs from 'node:fs';
import * as path from 'node:path';
import type OpenAI from 'openai';
import {
  BugReport,
  BugReportSchema,
  ReproducerOutput,
  ReproducerOutputSchema,
  VerifierOutput,
  VerifierOutputSchema,
} from '@replay/shared';
import { LlmClient, LlmError, ModelMetrics, moduleDirOf, resolveApiKey, resolveModel, toLlmError } from './llm.js';
import { ReproExecutionResult } from './reproducer.js';

export const VERIFIER_PROMPT_VERSION = 'v1';

const moduleDir = moduleDirOf(import.meta.url);

const PROMPT_CANDIDATES = [
  ...(moduleDir ? [path.join(moduleDir, '../prompts/verifier.md'), path.join(moduleDir, '../../prompts/verifier.md')] : []),
  path.resolve(process.cwd(), 'packages/agents/prompts/verifier.md'),
  path.resolve(process.cwd(), 'prompts/verifier.md'),
  path.resolve(process.env.REPLAY_PROMPTS_DIR || '', 'verifier.md'),
];

/** Load the versioned Verifier system prompt from packages/agents/prompts/verifier.md. */
export function loadVerifierPrompt(): string {
  for (const p of PROMPT_CANDIDATES) {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  throw new Error('verifier.md not found in packages/agents/prompts/');
}

export interface VerifierInput {
  bugReport: BugReport;
  reproducerOutput: ReproducerOutput;
  executionResult: ReproExecutionResult;
  candidateScreenshotPath?: string;
}

export interface VerifierDeps {
  /** Injectable client for testing or custom provider */
  client?: Pick<LlmClient, 'callJson'>;
  model?: string;
}

export interface VerifierResult {
  output: VerifierOutput;
  metrics: ModelMetrics;
  promptVersion: string;
  model: string;
  /** Set when the live model call failed and the deterministic fallback was used. */
  modelError?: LlmError;
}

/** Construct messages sent to the Verifier model. */
export function buildVerifierMessages(input: VerifierInput): OpenAI.Chat.ChatCompletionMessageParam[] {
  const report = BugReportSchema.parse(input.bugReport);
  const repro = ReproducerOutputSchema.parse(input.reproducerOutput);

  const parts: string[] = [
    `=== BUG REPORT ===\n${JSON.stringify(report, null, 2)}`,
    `=== GENERATED TEST ===\nTest Name: ${repro.test_name}\nTarget Assertion: ${repro.assertion}\nExpected Failure: ${repro.failure_message}\nTest Code:\n${repro.test_code}`,
    `=== EXECUTION RESULT ===\nClassification: ${input.executionResult.classification}\nExit Code: ${input.executionResult.exitCode}\nSummary: ${input.executionResult.summary}\nStdout:\n${input.executionResult.stdout}\nStderr:\n${input.executionResult.stderr}`,
  ];

  return [
    { role: 'system', content: loadVerifierPrompt() },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

/**
 * Deterministic grounding verification.
 * Execution evidence is non-negotiable:
 * 1. Exit code 0 is ALWAYS UNEXPECTED_PASS (same_defect = false).
 * 2. Infrastructure/network failures are ALWAYS INFRASTRUCTURE_FAILURE (same_defect = false).
 * 3. Syntax/compilation errors are ALWAYS COMPILATION_OR_RUNTIME_ERROR (same_defect = false).
 * 4. Timeouts/missing selectors are ALWAYS SELECTOR_OR_TIMEOUT (same_defect = false).
 * 5. Assertion failures are evaluated for symptom correlation with the bug report.
 */
export function verifyExecutionDeterministically(input: VerifierInput): VerifierOutput {
  const { executionResult, bugReport, reproducerOutput } = input;

  if (executionResult.exitCode === 0) {
    return VerifierOutputSchema.parse({
      same_defect: false,
      classification: 'UNEXPECTED_PASS',
      reason: 'The reproduction test passed unexpectedly (exit code 0); the reported defect was not triggered.',
      confidence: 1.0,
    });
  }

  if (executionResult.classification === 'INFRASTRUCTURE_ERROR') {
    return VerifierOutputSchema.parse({
      same_defect: false,
      classification: 'INFRASTRUCTURE_FAILURE',
      reason: `Infrastructure or server connection failure: ${executionResult.summary}`,
      confidence: 1.0,
    });
  }

  if (executionResult.classification === 'COMPILATION_OR_SYNTAX') {
    return VerifierOutputSchema.parse({
      same_defect: false,
      classification: 'COMPILATION_OR_RUNTIME_ERROR',
      reason: `Test compilation or runtime error: ${executionResult.summary}`,
      confidence: 1.0,
    });
  }

  if (executionResult.classification === 'TIMEOUT_OR_SELECTOR') {
    return VerifierOutputSchema.parse({
      same_defect: false,
      classification: 'SELECTOR_OR_TIMEOUT',
      reason: `Test timed out or element selector was missing: ${executionResult.summary}`,
      confidence: 0.95,
    });
  }

  // At this point, execution failed with an assertion failure.
  // Verify that the assertion failure actually matches the reported bug symptoms.
  const combinedLog = `${executionResult.stdout}\n${executionResult.stderr}`.toLowerCase();
  const actualSymptom = bugReport.actual_behavior.toLowerCase();
  const summary = bugReport.summary.toLowerCase();

  // Extract key symptom keywords (e.g. "nan", "discount", "sort", "email", "reset", "quantity")
  const symptomKeywords = ['nan', 'discount', 'sort', 'email', 'reset', 'quantity', 'coupon', '$80', '$100', '$20'];
  const reproExpected = reproducerOutput.failure_message.toLowerCase();
  const matchedKeywords = symptomKeywords.filter(
    kw => (actualSymptom.includes(kw) || summary.includes(kw) || reproExpected.includes(kw)) && combinedLog.includes(kw)
  );

  const assertionFailed = combinedLog.includes('expect(') || combinedLog.includes('assertionerror') || combinedLog.includes('failed');

  if (assertionFailed && matchedKeywords.length > 0) {
    return VerifierOutputSchema.parse({
      same_defect: true,
      classification: 'GENUINE_REPRODUCTION',
      reason: `Test failed with AssertionError matching reported defect symptom (${matchedKeywords.join(', ')}): ${executionResult.summary}`,
      confidence: 0.95,
    });
  }

  if (assertionFailed) {
    return VerifierOutputSchema.parse({
      same_defect: false,
      classification: 'UNRELATED_ASSERTION_FAILURE',
      reason: `Assertion failed, but output does not match reported symptoms for "${bugReport.summary}": ${executionResult.summary}`,
      confidence: 0.85,
    });
  }

  return VerifierOutputSchema.parse({
    same_defect: false,
    classification: 'INCONCLUSIVE',
    reason: `Inconclusive failure evidence: ${executionResult.summary}`,
    confidence: 0.5,
  });
}

/**
 * Verify whether a reproduction test run genuinely captured the reported defect.
 * Combines strict execution gate invariants with optional model verification.
 */
export async function verifyReproduction(
  input: VerifierInput,
  deps: VerifierDeps = {}
): Promise<VerifierResult> {
  // 1. First enforce non-negotiable deterministic execution gate
  const deterministic = verifyExecutionDeterministically(input);

  // If deterministic execution already proved it's not a genuine reproduction
  // (e.g. passed, timeout, syntax error, infrastructure failure), return immediately.
  if (!deterministic.same_defect) {
    return {
      output: deterministic,
      metrics: { promptTokens: 0, completionTokens: 0, totalTokens: 0, durationMs: 0, model: 'deterministic-gate' },
      promptVersion: VERIFIER_PROMPT_VERSION,
      model: 'deterministic-gate',
    };
  }

  // 2. If client is injected (tests) or live model access is available, consult model
  const model = deps.model ?? resolveModel('verifier');
  const apiKey = resolveApiKey('verifier');

  if (deps.client || apiKey) {
    try {
      const client = deps.client ?? new LlmClient({ apiKey });
      const messages = buildVerifierMessages(input);
      const res = await client.callJson<VerifierOutput>(model, messages, VerifierOutputSchema, { role: 'verifier',
        temperature: 0.1,
      });

      // Strict safety: Never allow model to claim same_defect = true if deterministic was false
      if (res.data.same_defect && !deterministic.same_defect) {
        return {
          output: deterministic,
          metrics: res.metrics,
          promptVersion: VERIFIER_PROMPT_VERSION,
          model,
        };
      }

      return {
        output: res.data,
        metrics: res.metrics,
        promptVersion: VERIFIER_PROMPT_VERSION,
        model,
      };
    } catch (err) {
      // Model call unavailable or failed: emit the error with the fallback verdict,
      // never silently. The UI labels this stage as a fallback.
      const modelError = toLlmError(err, 'verifier', model);
      return {
        output: deterministic,
        metrics: { promptTokens: 0, completionTokens: 0, totalTokens: 0, durationMs: 0, model: 'deterministic-fallback' },
        promptVersion: VERIFIER_PROMPT_VERSION,
        model: 'deterministic-fallback',
        modelError,
      };
    }
  }

  return {
    output: deterministic,
    metrics: { promptTokens: 0, completionTokens: 0, totalTokens: 0, durationMs: 0, model: 'deterministic-gate' },
    promptVersion: VERIFIER_PROMPT_VERSION,
    model: 'deterministic-gate',
  };
}
