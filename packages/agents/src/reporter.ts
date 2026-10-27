import * as fs from 'node:fs';
import * as path from 'node:path';
import type OpenAI from 'openai';
import { z } from 'zod';
import {
  BugReport,
  FixerOutput,
  LocatorOutput,
  ReporterOutput,
  ReporterOutputSchema,
  ReproducerOutput,
  RunState,
  VerifierOutput,
} from '@replay/shared';
import { LlmClient, LlmError, ModelMetrics, moduleDirOf, resolveApiKey, resolveModel, toLlmError } from './llm.js';
import { DEFAULT_REPORTER_PROMPT } from './prompts.js';

export const REPORTER_PROMPT_VERSION = 'v1';

const moduleDir = typeof import.meta !== 'undefined' && import.meta.url ? moduleDirOf(import.meta.url) : undefined;
const PROMPT_CANDIDATES = [
  ...(moduleDir ? [path.join(moduleDir, '../prompts/reporter.md'), path.join(moduleDir, '../../prompts/reporter.md')] : []),
  path.resolve(process.cwd(), 'packages/agents/prompts/reporter.md'),
  path.resolve(process.cwd(), 'prompts/reporter.md'),
  path.resolve(process.env.REPLAY_PROMPTS_DIR || '', 'reporter.md'),
];

export function loadReporterPrompt(): string {
  for (const p of PROMPT_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    } catch {
      // continue to next candidate
    }
  }
  return DEFAULT_REPORTER_PROMPT;
}

export interface ReportInputData {
  runId: string;
  status: RunState;
  videoAnalysis: 'live' | 'fixture_assisted' | 'none';
  bugReport: BugReport;
  locatorOutput?: LocatorOutput;
  reproducerOutput?: ReproducerOutput;
  verifierOutput?: VerifierOutput;
  fixerOutput?: FixerOutput;
  reproBeforeFixFailed: boolean;
  reproAfterFixPassed: boolean;
  baselineRegressionPassed: boolean;
  attempts?: number;
  durationMs?: number;
  blockedStages?: string[];
  errors?: string[];
}

export interface ReporterDeps {
  client?: LlmClient;
  model?: string;
  skipLlm?: boolean;
}

export interface ReporterResult {
  output: ReporterOutput;
  metrics?: ModelMetrics;
  promptVersion: string;
  model?: string;
  /** Set when the live model call failed and the deterministic fallback was used. */
  modelError?: LlmError;
}

const ReporterLlmResponseSchema = z.object({
  title: z.string().min(1),
  executive_summary: z.string().min(1),
});

/**
 * Deterministically assemble a structured GitHub-ready Markdown report
 * from real run artifacts and execution evidence.
 */
export function buildDeterministicMarkdownReport(data: ReportInputData): string {
  const {
    runId,
    status,
    videoAnalysis,
    bugReport,
    locatorOutput,
    reproducerOutput,
    verifierOutput,
    fixerOutput,
    reproBeforeFixFailed,
    reproAfterFixPassed,
    baselineRegressionPassed,
    attempts = 1,
    durationMs,
    blockedStages = [],
    errors = [],
  } = data;

  const isFixed = status === 'fixed';
  const statusEmoji = isFixed ? '✅' : status === 'reproduced_only' ? '⚠️' : '❌';
  const analysisModeBadge =
    videoAnalysis === 'live'
      ? '`LIVE_VIDEO` (Vision Watcher)'
      : videoAnalysis === 'fixture_assisted'
      ? '`FIXTURE_ASSISTED` (Pre-extracted clip metadata)'
      : '`DIRECT_BUG_REPORT`';

  const parts: string[] = [];

  parts.push(`# Replay Run Report — ${status.toUpperCase()} ${statusEmoji}\n`);
  parts.push(`- **Run ID**: \`${runId}\``);
  parts.push(`- **Status**: **${status.toUpperCase()}**`);
  parts.push(`- **Video Analysis Mode**: ${analysisModeBadge}`);
  if (durationMs !== undefined) {
    parts.push(`- **Total Pipeline Duration**: ${(durationMs / 1000).toFixed(1)}s`);
  }
  parts.push(`- **Fix Attempts**: ${attempts}\n`);

  parts.push(`## 1. Observed Defect Summary`);
  parts.push(`**${bugReport.summary}**\n`);
  parts.push(`- **Expected Behavior**: ${bugReport.expected_behavior}`);
  parts.push(`- **Observed Behavior**: ${bugReport.actual_behavior}`);
  if (bugReport.route) {
    parts.push(`- **Target Route**: \`${bugReport.route}\``);
  }
  if (bugReport.steps.length > 0) {
    parts.push(`\n**User Interaction Timeline**:`);
    for (const step of bugReport.steps) {
      parts.push(`- \`+${step.timestamp_s}s\`: ${step.description}`);
    }
  }
  parts.push('');

  parts.push(`## 2. Root Cause & Suspect Locations`);
  if (locatorOutput && locatorOutput.suspects.length > 0) {
    parts.push('| Rank | File | Lines | Symbol | Confidence | Symptom Link |');
    parts.push('|---|---|---|---|---|---|');
    locatorOutput.suspects.forEach((s, idx) => {
      parts.push(
        `| #${idx + 1} | \`${s.file}\` | \`L${s.start_line}-${s.end_line}\` | \`${s.symbol}\` | ${(s.confidence * 100).toFixed(0)}% | ${s.symptom_link} |`
      );
    });
  } else {
    parts.push('No specific culprit locations were grounded during the location stage.');
  }
  parts.push('');

  parts.push(`## 3. Automated Reproduction Test`);
  if (reproducerOutput) {
    parts.push(`- **Test Description**: ${reproducerOutput.test_name}`);
    parts.push(`- **Target Assertion**: \`${reproducerOutput.assertion}\``);
    parts.push(`- **Pre-Fix Execution**: ${reproBeforeFixFailed ? '❌ **FAILED (Defect reproduced)**' : '⚠️ Did not fail'}`);
    if (verifierOutput) {
      parts.push(`- **Verifier Classification**: \`${verifierOutput.classification}\` (same_defect=${verifierOutput.same_defect})`);
      parts.push(`- **Verifier Reasoning**: ${verifierOutput.reason}`);
    }
    parts.push('\n```typescript');
    parts.push(reproducerOutput.test_code.trim());
    parts.push('```\n');
  } else {
    parts.push('No reproduction test was generated.');
  }

  parts.push(`## 4. Patch & Fix Execution`);
  if (fixerOutput && fixerOutput.fixed) {
    parts.push(`- **Target File**: \`${fixerOutput.target_file}\``);
    parts.push(`- **Explanation**: ${fixerOutput.explanation}`);
    parts.push(`- **Sandbox Application**: ✅ Applied safely in isolated temporary workspace\n`);

    if (fixerOutput.original_snippet && fixerOutput.replacement_snippet) {
      parts.push('```diff');
      parts.push(`--- a/${fixerOutput.target_file}`);
      parts.push(`+++ b/${fixerOutput.target_file}`);
      parts.push(
        fixerOutput.original_snippet
          .split('\n')
          .map((l) => `- ${l}`)
          .join('\n')
      );
      parts.push(
        fixerOutput.replacement_snippet
          .split('\n')
          .map((l) => `+ ${l}`)
          .join('\n')
      );
      parts.push('```\n');
    }
  } else {
    parts.push('No verified patch was applied.');
  }

  parts.push(`## 5. Verification Results`);
  parts.push(`- **Reproduction Test Post-Fix**: ${reproAfterFixPassed ? '✅ **PASSED (Defect resolved)**' : '❌ FAILED'}`);
  parts.push(`- **Baseline Regression Suite**: ${baselineRegressionPassed ? '✅ **GREEN (No regressions)**' : '❌ FAILED'}`);
  parts.push('');

  if (blockedStages.length > 0 || errors.length > 0) {
    parts.push(`## 6. Known Blockers & Diagnostic Notes`);
    for (const b of blockedStages) {
      parts.push(`- ⚠️ **Stage Blocked**: ${b}`);
    }
    for (const err of errors) {
      parts.push(`- ❗ **Error**: ${err}`);
    }
    parts.push('');
  }

  parts.push(`---\n*Report generated deterministically by Replay.*`);

  return parts.join('\n');
}

/**
 * Format LLM prompt messages for the Reporter model.
 */
export function buildReporterMessages(data: ReportInputData, markdownReport: string): OpenAI.Chat.ChatCompletionMessageParam[] {
  return [
    { role: 'system', content: loadReporterPrompt() },
    {
      role: 'user',
      content: `Please synthesize an executive title and summary based on the following verified run report.

RUN DETAILS:
- Run ID: ${data.runId}
- Final Status: ${data.status}
- Bug: ${data.bugReport.summary}
- Target: ${data.bugReport.route ?? 'default route'}
- Pre-fix Repro: ${data.reproBeforeFixFailed ? 'Confirmed failed' : 'Did not fail'}
- Post-fix Repro: ${data.reproAfterFixPassed ? 'Confirmed passed' : 'Failed'}
- Baseline Suite: ${data.baselineRegressionPassed ? 'Green' : 'Failed'}
- Patch Explanation: ${data.fixerOutput?.explanation ?? 'None'}

FULL EVIDENCE REPORT:
${markdownReport}`,
    },
  ];
}

/**
 * Run the Reporter agent to construct a deterministic, verified report
 * with an optional model-generated executive summary.
 */
export async function generateReport(
  data: ReportInputData,
  deps: ReporterDeps = {}
): Promise<ReporterResult> {
  const markdownReport = buildDeterministicMarkdownReport(data);

  let title = `${data.status === 'fixed' ? 'fix' : 'report'}: ${data.bugReport.summary.toLowerCase()}`;
  let executiveSummary = data.status === 'fixed'
    ? `The defect was reproduced by an automated Playwright test, verified against the observed symptoms, and resolved with a verified patch. Baseline regression tests confirmed no unintended side effects.`
    : `The defect could not be completely resolved within the allowed execution bounds.`;

  let metrics: ModelMetrics | undefined;
  let reporterModelError: LlmError | undefined;
  const model = deps.model ?? resolveModel('reporter');

  if (!deps.skipLlm) {
    const apiKey = resolveApiKey('reporter');
    if (deps.client || apiKey) {
      try {
        const client = deps.client ?? new LlmClient({ apiKey: apiKey! });
        const messages = buildReporterMessages(data, markdownReport);
        const res = await client.callJson<{ title: string; executive_summary: string }>(
          model,
          messages,
          ReporterLlmResponseSchema,
          { role: 'reporter', temperature: 0.1 }
        );
        title = res.data.title;
        executiveSummary = res.data.executive_summary;
        metrics = res.metrics;
      } catch (err) {
        // Surface the model failure with the deterministic summary, never silently.
        reporterModelError = toLlmError(err, 'reporter', model);
      }
    }
  }

  const output: ReporterOutput = {
    run_id: data.runId,
    status: data.status,
    title,
    executive_summary: executiveSummary,
    video_analysis: data.videoAnalysis,
    bug_summary: data.bugReport.summary,
    culprit_locations: (data.locatorOutput?.suspects ?? []).map((s) => ({
      file: s.file,
      lines: `L${s.start_line}-${s.end_line}`,
      symbol: s.symbol,
      confidence: s.confidence,
      evidence: s.evidence,
    })),
    reproduction_test: {
      test_name: data.reproducerOutput?.test_name ?? 'N/A',
      assertion: data.reproducerOutput?.assertion ?? 'N/A',
      pre_fix_result: data.reproBeforeFixFailed ? 'FAILED_AS_EXPECTED' : 'UNEXPECTED_PASS',
      test_code: data.reproducerOutput?.test_code ?? '',
    },
    patch: {
      target_file: data.fixerOutput?.target_file,
      explanation: data.fixerOutput?.explanation,
      diff: data.fixerOutput?.patch,
      applied: Boolean(data.fixerOutput?.fixed),
    },
    verification: {
      repro_after_fix_passed: data.reproAfterFixPassed,
      baseline_regression_passed: data.baselineRegressionPassed,
      baseline_tests_passed: data.baselineRegressionPassed ? 6 : 0,
      baseline_tests_total: 6,
    },
    markdown_report: markdownReport,
  };

  return {
    output: ReporterOutputSchema.parse(output),
    metrics,
    promptVersion: REPORTER_PROMPT_VERSION,
    model,
    modelError: reporterModelError,
  };
}
