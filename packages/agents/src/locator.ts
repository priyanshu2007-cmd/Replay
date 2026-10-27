import * as fs from 'node:fs';
import * as path from 'node:path';
import type OpenAI from 'openai';
import { z } from 'zod';
import { BugReport, BugReportSchema, LocatorOutput, LocatorOutputSchema } from '@replay/shared';
import { LlmClient, ModelMetrics, moduleDirOf, resolveApiKey, resolveModel } from './llm.js';
import { PackedFile, RepoBundle } from './packer.js';
import { DEFAULT_LOCATOR_PROMPT } from './prompts.js';

export const LOCATOR_PROMPT_VERSION = 'v1';

const moduleDir = typeof import.meta !== 'undefined' && import.meta.url ? moduleDirOf(import.meta.url) : undefined;

const PROMPT_CANDIDATES = [
  ...(moduleDir ? [path.join(moduleDir, '../prompts/locator.md'), path.join(moduleDir, '../../prompts/locator.md')] : []),
  path.resolve(process.cwd(), 'packages/agents/prompts/locator.md'),
  path.resolve(process.cwd(), 'prompts/locator.md'),
  path.resolve(process.env.REPLAY_PROMPTS_DIR || '', 'locator.md'),
];

/** Load the versioned Locator system prompt from packages/agents/prompts/locator.md with embedded fallback. */
export function loadLocatorPrompt(): string {
  for (const p of PROMPT_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    } catch {
      // continue to next candidate
    }
  }
  return DEFAULT_LOCATOR_PROMPT;
}

/** Schema for samples/<id>/expected.json fixtures. */
export const SampleFixtureSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  failure_timestamp_s: z.number().nonnegative(),
  guilty_file: z.string().min(1),
  guilty_symbol: z.string().min(1),
  expected_behavior: z.string().min(1),
  observed_behavior: z.string().min(1),
  route: z.string().nullable().default(null),
});
export type SampleFixture = z.infer<typeof SampleFixtureSchema>;

/**
 * Deterministic mapping from a validated sample fixture to a BugReport.
 * Intentionally omits `guilty_file` and `guilty_symbol` so the Locator receives
 * only symptom-level evidence (as it would from the Watcher).
 */
export function fixtureToBugReport(fixture: SampleFixture): BugReport {
  const validated = SampleFixtureSchema.parse(fixture);
  return BugReportSchema.parse({
    defect_found: true,
    summary: validated.title,
    steps: [
      {
        timestamp_s: validated.failure_timestamp_s,
        description: validated.observed_behavior,
      },
    ],
    first_failure_timestamp_s: validated.failure_timestamp_s,
    expected_behavior: validated.expected_behavior,
    actual_behavior: validated.observed_behavior,
    visible_text: [],
    route: validated.route,
    confidence: 1.0,
  });
}

export interface LocatorInput {
  bugReport: BugReport;
  bundle: RepoBundle;
  note?: string;
  route?: string;
}

export interface LocatorDeps {
  /** Injectable for offline tests. Defaults to a live client using the locator role's key. */
  client?: Pick<LlmClient, 'callJson'>;
  model?: string;
}

export interface LocatorResult {
  output: LocatorOutput;
  metrics: ModelMetrics;
  promptVersion: string;
  model: string;
}

function normalizeSnippet(text: string): string {
  return text
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*\d+:\s*/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build a Zod schema that enforces both the shared LocatorOutputSchema contract
 * and grounded source verification against the packed repository bundle:
 *  1. Every candidate file path must exist in `bundle.files`.
 *  2. Every `start_line..end_line` range must be within `1..file.lineCount`.
 *  3. Every candidate must include `evidence` matching the actual source lines in `start_line..end_line`.
 */
export function buildGroundedLocatorSchema(bundle: RepoBundle): z.ZodType<LocatorOutput, z.ZodTypeDef, unknown> {
  const fileMap = new Map<string, PackedFile>();
  for (const f of bundle.files) {
    fileMap.set(f.path, f);
  }

  return LocatorOutputSchema.superRefine((data, ctx) => {
    data.suspects.forEach((suspect, index) => {
      const packedFile = fileMap.get(suspect.file);
      if (!packedFile) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['suspects', index, 'file'],
          message: `Candidate file "${suspect.file}" does not exist in packed repository bundle`,
        });
        return;
      }

      if (
        suspect.start_line < 1 ||
        suspect.end_line < suspect.start_line ||
        suspect.end_line > packedFile.lineCount
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['suspects', index, 'start_line'],
          message: `Invalid line range ${suspect.start_line}-${suspect.end_line} for ${suspect.file} (valid lines: 1..${packedFile.lineCount})`,
        });
        return;
      }

      const fileLines = packedFile.content.split(/\r?\n/);
      const winStart = Math.max(0, suspect.start_line - 1 - 5);
      const winEnd = Math.min(fileLines.length, suspect.end_line + 5);
      const sliceText = fileLines.slice(winStart, winEnd).join('\n');
      const normSlice = normalizeSnippet(sliceText);

      if (!suspect.evidence || suspect.evidence.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['suspects', index, 'evidence'],
          message: `Missing required source evidence quote for ${suspect.file}:${suspect.start_line}-${suspect.end_line}`,
        });
        return;
      }

      const normEvidence = normalizeSnippet(suspect.evidence);
      if (!normEvidence || !normSlice.includes(normEvidence)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['suspects', index, 'evidence'],
          message: `Evidence "${suspect.evidence}" does not match source content in ${suspect.file}:${suspect.start_line}-${suspect.end_line} (actual lines: ${normSlice.slice(0, 200)}). Copy one exact line from within start_line..end_line without ellipses.`,
        });
      }
    });
  });
}

/** Pure: construct the system + user messages sent to the Locator model. */
export function buildLocatorMessages(input: LocatorInput): OpenAI.Chat.ChatCompletionMessageParam[] {
  const report = BugReportSchema.parse(input.bugReport);
  const parts: string[] = [];

  if (input.note) parts.push(`Reporter note: ${input.note}`);
  if (input.route ?? report.route) parts.push(`Known target route: ${input.route ?? report.route}`);
  parts.push(`=== BUG REPORT ===\n${JSON.stringify(report, null, 2)}`);
  parts.push(
    `=== PACKED REPOSITORY (${input.bundle.metadata.includedFileCount} files) ===\n${
      input.bundle.bundleText || '(no source files in bundle)'
    }`
  );

  return [
    { role: 'system', content: loadLocatorPrompt() },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

/**
 * Run the Locator agent on a validated BugReport and packed repository bundle.
 * Rejects any output that fails schema validation or cites non-existent paths,
 * out-of-bounds line ranges, or unverified source evidence.
 */
export async function locateSuspects(input: LocatorInput, deps: LocatorDeps = {}): Promise<LocatorResult> {
  const messages = buildLocatorMessages(input);
  const client = deps.client ?? new LlmClient({ apiKey: resolveApiKey('locator') });
  const model = deps.model ?? resolveModel('locator');
  const schema = buildGroundedLocatorSchema(input.bundle);

  const res = await client.callJson<LocatorOutput>(model, messages, schema, { role: 'locator',
    temperature: 0.1,
    enableThinking: false,
  });

  return {
    output: res.data,
    metrics: res.metrics,
    promptVersion: LOCATOR_PROMPT_VERSION,
    model,
  };
}
