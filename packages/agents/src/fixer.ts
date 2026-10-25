import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type OpenAI from 'openai';
import {
  BugReport,
  BugReportSchema,
  FixerOutput,
  FixerOutputSchema,
  LocatorOutput,
  LocatorOutputSchema,
  ReproducerOutput,
  ReproducerOutputSchema,
} from '@replay/shared';
import { LlmClient, ModelMetrics, resolveApiKey, resolveModel } from './llm.js';
import { RepoBundle } from './packer.js';

export const FIXER_PROMPT_VERSION = 'v1';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

const PROMPT_CANDIDATES = [
  path.join(moduleDir, '../prompts/fixer.md'),
  path.join(moduleDir, '../../prompts/fixer.md'),
];

/** Load the versioned Fixer system prompt from packages/agents/prompts/fixer.md. */
export function loadFixerPrompt(): string {
  for (const p of PROMPT_CANDIDATES) {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  throw new Error('fixer.md not found in packages/agents/prompts/');
}

export interface FixerInput {
  bugReport: BugReport;
  locatorOutput: LocatorOutput;
  reproducerOutput: ReproducerOutput;
  bundle: RepoBundle;
  attempts?: number;
}

export interface FixerDeps {
  client?: Pick<LlmClient, 'callJson'>;
  model?: string;
}

export interface FixerResult {
  output: FixerOutput;
  metrics: ModelMetrics;
  promptVersion: string;
  model: string;
}

const FORBIDDEN_FILE_PATTERNS = [
  /\btests?\//i,
  /\.spec\.[jt]sx?$/i,
  /\.test\.[jt]sx?$/i,
  /playwright\.config/i,
  /vite\.config/i,
  /tsconfig/i,
  /package\.json$/i,
  /\.env/i,
  /\.lock$/i,
  /pnpm-lock/i,
];

/** Validate that the patch targets authorized application code and does not alter tests or config. */
export function validatePatchSafety(
  output: FixerOutput,
  bundle: RepoBundle
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!output.fixed) {
    errors.push('Fixer indicated it could not produce a fix (fixed: false)');
    return { valid: false, errors };
  }

  const targetFile = output.target_file.replace(/^\/+/, '');

  // 1. Must target an existing file in packed repository
  const packedFile = bundle.files.find(f => f.path === targetFile);
  if (!packedFile) {
    errors.push(`Target file "${targetFile}" does not exist in the packed repository bundle`);
  }

  // 2. Reject edits to tests, config, or package manifests
  for (const pat of FORBIDDEN_FILE_PATTERNS) {
    if (pat.test(targetFile)) {
      errors.push(`Editing file "${targetFile}" is prohibited by safety policy (tests, configs, and package manifests cannot be modified)`);
      break;
    }
  }

  // 3. Must provide either an original_snippet matching target file content, or a valid unified diff
  if (output.original_snippet) {
    const normSource = packedFile ? packedFile.content.replace(/\r\n/g, '\n') : '';
    const normSnippet = output.original_snippet.replace(/\r\n/g, '\n').trim();
    if (normSource && !normSource.includes(normSnippet)) {
      errors.push(`Original snippet does not match content in ${targetFile}`);
    }
  } else if (!output.patch || output.patch.trim().length === 0) {
    errors.push('Patch must provide either original_snippet or unified diff patch');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/** Construct messages sent to the Fixer model. */
export function buildFixerMessages(input: FixerInput): OpenAI.Chat.ChatCompletionMessageParam[] {
  const report = BugReportSchema.parse(input.bugReport);
  const locator = LocatorOutputSchema.parse(input.locatorOutput);
  const repro = ReproducerOutputSchema.parse(input.reproducerOutput);

  const parts: string[] = [
    `=== BUG REPORT ===\n${JSON.stringify(report, null, 2)}`,
    `=== LOCATOR CODE CONTEXT ===\nSuspects:\n${JSON.stringify(locator.suspects, null, 2)}`,
    `=== FAILING REPRODUCTION TEST ===\nTest Name: ${repro.test_name}\nTarget Assertion: ${repro.assertion}\nFailure Message: ${repro.failure_message}\nTest Code:\n${repro.test_code}`,
    `=== PACKED REPOSITORY (${input.bundle.metadata.includedFileCount} files) ===\n${input.bundle.bundleText || '(empty)'}`,
  ];

  return [
    { role: 'system', content: loadFixerPrompt() },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

/**
 * Propose a surgical bug fix for the verified defect.
 */
export async function proposeFix(input: FixerInput, deps: FixerDeps = {}): Promise<FixerResult> {
  const messages = buildFixerMessages(input);
  const client = deps.client ?? new LlmClient({ apiKey: resolveApiKey('fixer') });
  const model = deps.model ?? resolveModel('fixer');

  const res = await client.callJson<FixerOutput>(model, messages, FixerOutputSchema, {
    temperature: 0.1,
    enableThinking: false,
  });

  const safety = validatePatchSafety(res.data, input.bundle);
  if (!safety.valid) {
    throw new Error(`Proposed patch failed safety validation: ${safety.errors.join('; ')}`);
  }

  return {
    output: res.data,
    metrics: res.metrics,
    promptVersion: FIXER_PROMPT_VERSION,
    model,
  };
}

/**
 * Apply a FixerOutput patch to a directory (such as an isolated sandbox workspace).
 */
export async function applyPatchToDirectory(
  workDir: string,
  output: FixerOutput
): Promise<{ applied: boolean; filePath: string; originalContent: string; newContent: string }> {
  const targetFile = output.target_file.replace(/^\/+/, '');
  const fullPath = path.join(workDir, targetFile);

  const stat = await fs.promises.stat(fullPath).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new Error(`Target file ${fullPath} not found in workspace`);
  }

  const originalContent = await fs.promises.readFile(fullPath, 'utf8');

  let newContent = originalContent;

  if (output.original_snippet && output.replacement_snippet !== undefined) {
    const normOriginal = originalContent.replace(/\r\n/g, '\n');
    const normSnippet = output.original_snippet.replace(/\r\n/g, '\n').trim();

    if (normOriginal.includes(normSnippet)) {
      newContent = normOriginal.replace(normSnippet, output.replacement_snippet.replace(/\r\n/g, '\n').trim());
    } else {
      // Line-level whitespace-tolerant matching
      const origLines = normOriginal.split('\n');
      const snipLines = normSnippet.split('\n');
      const replLines = output.replacement_snippet.replace(/\r\n/g, '\n').split('\n');

      let matchIdx = -1;
      for (let i = 0; i <= origLines.length - snipLines.length; i++) {
        let matches = true;
        for (let j = 0; j < snipLines.length; j++) {
          const o = origLines[i + j];
          const s = snipLines[j];
          if (o === undefined || s === undefined || o.trim() !== s.trim()) {
            matches = false;
            break;
          }
        }
        if (matches) {
          matchIdx = i;
          break;
        }
      }

      if (matchIdx === -1) {
        throw new Error(`Cannot apply patch: original snippet not found in ${targetFile}`);
      }

      const origMatchLine = origLines[matchIdx] ?? '';
      const snipMatchLine = snipLines[0] ?? '';
      const baseIndent = origMatchLine.match(/^\s*/)?.[0] ?? '';
      const snipIndent = snipMatchLine.match(/^\s*/)?.[0] ?? '';
      const delta = baseIndent.length - snipIndent.length;

      const adjustedReplLines = replLines.map((line) => {
        if (!line.trim()) return '';
        if (delta > 0) return ' '.repeat(delta) + line;
        if (delta < 0 && line.startsWith(' '.repeat(-delta))) return line.slice(-delta);
        return line;
      });

      const updatedLines = [
        ...origLines.slice(0, matchIdx),
        ...adjustedReplLines,
        ...origLines.slice(matchIdx + snipLines.length),
      ];
      newContent = updatedLines.join('\n');
    }
  } else if (output.patch) {
    // Basic unified diff hunk applicator
    // If snippet wasn't given, try extracting from patch diff
    const removeLines: string[] = [];
    const addLines: string[] = [];
    for (const l of output.patch.split('\n')) {
      if (l.startsWith('-') && !l.startsWith('---')) removeLines.push(l.slice(1).trim());
      if (l.startsWith('+') && !l.startsWith('+++')) addLines.push(l.slice(1).trim());
    }
    if (removeLines.length > 0) {
      const targetStr = removeLines.join('\n');
      const replaceStr = addLines.join('\n');
      if (originalContent.includes(targetStr)) {
        newContent = originalContent.replace(targetStr, replaceStr);
      }
    }
  }

  if (newContent === originalContent) {
    throw new Error(`Patch produced no content changes for ${targetFile}`);
  }

  await fs.promises.writeFile(fullPath, newContent, 'utf8');

  return {
    applied: true,
    filePath: fullPath,
    originalContent,
    newContent,
  };
}
