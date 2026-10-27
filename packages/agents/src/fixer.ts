import * as fs from 'node:fs';
import * as path from 'node:path';
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
import { LlmClient, ModelMetrics, moduleDirOf, resolveApiKey, resolveModel } from './llm.js';
import { RepoBundle } from './packer.js';
import { DEFAULT_FIXER_PROMPT } from './prompts.js';

export const FIXER_PROMPT_VERSION = 'v1';

const moduleDir = typeof import.meta !== 'undefined' && import.meta.url ? moduleDirOf(import.meta.url) : undefined;

const PROMPT_CANDIDATES = [
  ...(moduleDir ? [path.join(moduleDir, '../prompts/fixer.md'), path.join(moduleDir, '../../prompts/fixer.md')] : []),
  path.resolve(process.cwd(), 'packages/agents/prompts/fixer.md'),
  path.resolve(process.cwd(), 'prompts/fixer.md'),
  path.resolve(process.env.REPLAY_PROMPTS_DIR || '', 'fixer.md'),
];

/** Load the versioned Fixer system prompt from packages/agents/prompts/fixer.md with embedded fallback. */
export function loadFixerPrompt(): string {
  for (const p of PROMPT_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    } catch {
      // continue to next candidate
    }
  }
  return DEFAULT_FIXER_PROMPT;
}

export interface FixerInput {
  bugReport: BugReport;
  locatorOutput: LocatorOutput;
  reproducerOutput: ReproducerOutput;
  bundle: RepoBundle;
  attempts?: number;
  previousAttemptError?: string;
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
  /\b__tests__\//i,
  /\.spec\.[cm]?[jt]sx?$/i,
  /\.test\.[cm]?[jt]sx?$/i,
  /playwright\.config/i,
  /vite\.config/i,
  /vitest\.config/i,
  /tsconfig/i,
  /package(-lock)?\.json$/i,
  /\.env/i,
  /\.lock$/i,
  /pnpm-lock/i,
  /pnpm-workspace/i,
  /\.(pem|key|p12|pfx|crt|cer)$/i,
  /(^|\/)(id_rsa|id_ed25519|id_ecdsa|id_dsa)$/i,
  /(^|\/)node_modules(\/|$)/i,
  /(^|\/)\.git(\/|$)/i,
];

/**
 * Extract all file paths referenced in unified diff headers (`--- a/...` / `+++ b/...`),
 * ignoring `/dev/null`.
 */
export function extractUnifiedDiffPaths(patchText: string): string[] {
  if (!patchText || typeof patchText !== 'string') return [];
  const paths: string[] = [];
  for (const rawLine of patchText.split(/\r?\n/)) {
    if (!rawLine.startsWith('--- ') && !rawLine.startsWith('+++ ')) continue;
    let spec = rawLine.slice(4).trim();
    const tabIdx = spec.indexOf('\t');
    if (tabIdx !== -1) spec = spec.slice(0, tabIdx).trim();
    if (!spec || spec === '/dev/null' || spec === 'a/dev/null' || spec === 'b/dev/null') continue;
    if ((spec.startsWith('a/') || spec.startsWith('b/')) && !spec.startsWith('a//') && !spec.startsWith('b//')) {
      spec = spec.slice(2);
    }
    paths.push(spec);
  }
  return paths;
}

/**
 * Validate syntactic safety of a candidate relative path before any filesystem call.
 */
function validateCandidateRelativePathSyntax(relativePath: string): string | null {
  if (typeof relativePath !== 'string' || relativePath.trim().length === 0) {
    return 'Rejected empty path outside the workspace';
  }
  if (relativePath.includes('\0')) {
    return 'Rejected null-byte path outside the workspace';
  }
  if (/^[a-zA-Z]:/.test(relativePath)) {
    return `Rejected drive-prefixed path outside the workspace: ${relativePath}`;
  }
  if (/^(\\\\+|\/\/+)/.test(relativePath)) {
    return `Rejected UNC path outside the workspace: ${relativePath}`;
  }
  if (relativePath.startsWith('/') || relativePath.startsWith('\\') || path.isAbsolute(relativePath)) {
    return `Rejected absolute path outside the workspace: ${relativePath}`;
  }
  if (relativePath.includes('\\')) {
    return `Rejected Windows-style path separator outside the workspace: ${relativePath}`;
  }
  const segments = relativePath.split('/');
  if (segments.some((seg) => seg === '..' || seg === '.' || seg.length === 0)) {
    return `Rejected traversal or malformed path outside the workspace: ${relativePath}`;
  }
  return null;
}

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

  const syntaxErr = validateCandidateRelativePathSyntax(output.target_file);
  if (syntaxErr) {
    errors.push(syntaxErr);
    return { valid: false, errors };
  }

  const targetFile = output.target_file;

  // Validate any unified diff headers to reject multi-file or traversal headers
  const diffPaths = extractUnifiedDiffPaths(output.patch);
  for (const dp of diffPaths) {
    const dpErr = validateCandidateRelativePathSyntax(dp);
    if (dpErr) {
      errors.push(`Invalid path in unified diff header "${dp}": ${dpErr}`);
    } else if (dp !== targetFile) {
      errors.push(`Unified diff references "${dp}" which does not match target_file "${targetFile}"`);
    }
  }

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
      const origLines = normSource.split('\n');
      const snipLines = normSnippet.split('\n');
      let lineMatch = false;
      for (let i = 0; i <= origLines.length - snipLines.length; i++) {
        let ok = true;
        for (let j = 0; j < snipLines.length; j++) {
          if ((origLines[i + j]?.trim() ?? '') !== (snipLines[j]?.trim() ?? '')) {
            ok = false;
            break;
          }
        }
        if (ok) {
          lineMatch = true;
          break;
        }
      }
      if (!lineMatch) {
        errors.push(`Original snippet does not match content in ${targetFile}`);
      }
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
  if (input.previousAttemptError) {
    parts.push(
      `=== PREVIOUS FIX ATTEMPT FAILED (Attempt ${Math.max(1, (input.attempts ?? 2) - 1)}) ===\n${input.previousAttemptError}\nProduce a corrected, minimal patch that resolves this failure while keeping all baseline tests green.`
    );
  }

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

  const res = await client.callJson<FixerOutput>(model, messages, FixerOutputSchema, { role: 'fixer',
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


/** Paths an agent-provided patch may never touch, relative to the workspace root. */
const PROTECTED_PATH_PARTS = ['node_modules', '.git', 'tests', '__tests__', '.ssh', '.aws', '.vercel', '.github'];
const PROTECTED_PATH_PATTERNS: RegExp[] = [
  /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?)$/i,
  /(^|\/)\.env(\..+)?$/i,
  /(^|\/)(playwright|vite|vitest|jest|next|postcss|tailwind|eslint)\.config\.[cm]?[jt]sx?$/i,
  /(^|\/)tsconfig(\..+)?\.json$/i,
  /\.(spec|test)\.[cm]?[jt]sx?$/i,
  /\.(pem|key|p12|pfx|crt|cer|der)$/i,
  /(^|\/)(id_rsa|id_ed25519|id_ecdsa|id_dsa|authorized_keys|known_hosts)$/i,
  /(^|\/)Dockerfile(\..+)?$/i,
  /(^|\/)docker-compose(\..+)?\.ya?ml$/i,
];

function checkProtectedRelativePath(relFromRoot: string, rawInput: string): void {
  const parts = relFromRoot.split(path.sep);
  if (parts.some((p) => PROTECTED_PATH_PARTS.includes(p))) {
    throw new Error(`Rejected protected path: ${rawInput}`);
  }
  const normalizedPosix = '/' + parts.join('/');
  if (PROTECTED_PATH_PATTERNS.some((re) => re.test(normalizedPosix))) {
    throw new Error(`Rejected protected file: ${rawInput}`);
  }
}

function isStrictlyInsideRoot(rootReal: string, targetPath: string): boolean {
  if (targetPath === rootReal) return false;
  const rel = path.relative(rootReal, targetPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return targetPath.startsWith(rootReal + path.sep);
}

/**
 * Resolve an agent-supplied file path inside the workspace and refuse anything
 * that escapes it (traversal, absolute paths, Windows/UNC/drive paths, null bytes,
 * symlinks escaping the workspace or pointing into node_modules/protected paths,
 * and protected files). Also validates the nearest existing parent directory for
 * paths that do not exist yet.
 */
export async function resolveSafeWorkspacePath(workDir: string, relativePath: string): Promise<string> {
  if (typeof workDir !== 'string' || workDir.trim().length === 0 || workDir.includes('\0')) {
    throw new Error('Rejected invalid workspace root');
  }
  const syntaxError = validateCandidateRelativePathSyntax(relativePath);
  if (syntaxError) {
    throw new Error(syntaxError);
  }

  const rootReal = await fs.promises.realpath(workDir);
  const candidate = path.resolve(rootReal, relativePath);
  if (!isStrictlyInsideRoot(rootReal, candidate)) {
    throw new Error(`Rejected path outside the workspace: ${relativePath}`);
  }

  const relFromRoot = path.relative(rootReal, candidate);
  checkProtectedRelativePath(relFromRoot, relativePath);

  const parts = relFromRoot.split(path.sep);
  let existingAncestor = rootReal;
  let existingDepth = 0;

  // Walk each segment from rootReal to candidate to detect symlinks at any level
  for (let i = 0; i < parts.length; i++) {
    const curr = path.join(rootReal, ...parts.slice(0, i + 1));
    let lst: fs.Stats | null = null;
    try {
      lst = await fs.promises.lstat(curr);
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        break;
      }
      throw err;
    }

    if (lst.isSymbolicLink()) {
      const linkReal = await fs.promises.realpath(curr).catch(() => null);
      if (!linkReal || !isStrictlyInsideRoot(rootReal, linkReal)) {
        throw new Error(`Rejected symlink escape outside the workspace: ${relativePath}`);
      }
      const linkRel = path.relative(rootReal, linkReal);
      try {
        checkProtectedRelativePath(linkRel, relativePath);
      } catch {
        throw new Error(`Rejected symlink to protected path: ${relativePath}`);
      }
    }

    if (i === parts.length - 1) {
      const targetStat = await fs.promises.stat(curr).catch(() => null);
      if (!targetStat || !targetStat.isFile()) {
        throw new Error(`Rejected non-file target: ${relativePath}`);
      }
    } else {
      const dirStat = await fs.promises.stat(curr).catch(() => null);
      if (!dirStat || !dirStat.isDirectory()) {
        throw new Error(`Rejected non-directory parent component: ${relativePath}`);
      }
    }

    existingAncestor = curr;
    existingDepth = i + 1;
  }

  // Validate canonical nearest existing ancestor directory
  const ancestorReal = await fs.promises.realpath(existingAncestor);
  if (ancestorReal !== rootReal && !isStrictlyInsideRoot(rootReal, ancestorReal)) {
    throw new Error(`Rejected parent directory symlink escape outside the workspace: ${relativePath}`);
  }
  if (ancestorReal !== rootReal) {
    checkProtectedRelativePath(path.relative(rootReal, ancestorReal), relativePath);
  }

  // If the full path exists, resolve its canonical path and re-verify containment + protection
  if (existingDepth === parts.length) {
    const real = await fs.promises.realpath(candidate).catch(() => null);
    if (!real || !isStrictlyInsideRoot(rootReal, real)) {
      throw new Error(`Rejected symlink escape outside the workspace: ${relativePath}`);
    }
    checkProtectedRelativePath(path.relative(rootReal, real), relativePath);
    return real;
  }

  const remainingParts = parts.slice(existingDepth);
  const resolvedNewPath = path.join(ancestorReal, ...remainingParts);
  if (!isStrictlyInsideRoot(rootReal, resolvedNewPath)) {
    throw new Error(`Rejected path outside the workspace: ${relativePath}`);
  }
  checkProtectedRelativePath(path.relative(rootReal, resolvedNewPath), relativePath);
  return resolvedNewPath;
}

export interface ApplyPatchOptions {
  allowCreate?: boolean;
}

/**
 * Apply a FixerOutput patch to a directory (such as an isolated sandbox workspace).
 */
export async function applyPatchToDirectory(
  workDir: string,
  output: FixerOutput,
  options: ApplyPatchOptions = {}
): Promise<{ applied: boolean; filePath: string; originalContent: string; newContent: string }> {
  // 1. Validate all unified diff header paths BEFORE reading or touching any file.
  // Rejects multi-file diffs or invalid paths appearing after a valid entry.
  const diffPaths = extractUnifiedDiffPaths(output.patch);
  for (const dp of diffPaths) {
    await resolveSafeWorkspacePath(workDir, dp);
    if (dp !== output.target_file) {
      throw new Error(`Rejected multi-file or mismatched diff target "${dp}" (expected "${output.target_file}")`);
    }
  }

  // 2. Canonicalize and validate the target path.
  const rootReal = await fs.promises.realpath(workDir);
  const fullPath = await resolveSafeWorkspacePath(workDir, output.target_file);

  const lstat = await fs.promises.lstat(fullPath).catch((err: any) => (err?.code === 'ENOENT' ? null : Promise.reject(err)));
  if (lstat?.isSymbolicLink()) {
    throw new Error(`Rejected symlink target at write boundary: ${output.target_file}`);
  }

  let originalContent = '';
  let isNewFile = false;

  if (!lstat) {
    const isDevNullDiff = typeof output.patch === 'string' && /^---\s+(\/dev\/null|a\/dev\/null)\b/m.test(output.patch);
    if (!options.allowCreate && !isDevNullDiff) {
      throw new Error(`Target file ${fullPath} not found in workspace`);
    }
    isNewFile = true;
  } else {
    if (!lstat.isFile()) {
      throw new Error(`Target file ${fullPath} is not a regular file`);
    }
    originalContent = await fs.promises.readFile(fullPath, 'utf8');
  }

  let newContent = originalContent;

  if (isNewFile) {
    if (output.replacement_snippet) {
      newContent = output.replacement_snippet.replace(/\r\n/g, '\n');
    } else if (output.patch) {
      const addLines: string[] = [];
      for (const l of output.patch.split(/\r?\n/)) {
        if (l.startsWith('+') && !l.startsWith('+++')) addLines.push(l.slice(1));
      }
      newContent = addLines.join('\n');
    }
  } else if (output.original_snippet && output.replacement_snippet !== undefined) {
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
        throw new Error(`Cannot apply patch: original snippet not found in ${output.target_file}`);
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
    throw new Error(`Patch produced no content changes for ${output.target_file}`);
  }

  // 3. Revalidate canonical path and parent directories right at the write boundary
  if (isNewFile) {
    const parentDir = path.dirname(fullPath);
    await fs.promises.mkdir(parentDir, { recursive: true });
    const parentReal = await fs.promises.realpath(parentDir);
    if (parentReal !== rootReal && !isStrictlyInsideRoot(rootReal, parentReal)) {
      throw new Error(`Rejected parent directory escape at write boundary: ${output.target_file}`);
    }
  }

  const revalidatedPath = await resolveSafeWorkspacePath(workDir, output.target_file);
  const preWriteLstat = await fs.promises.lstat(revalidatedPath).catch((err: any) => (err?.code === 'ENOENT' ? null : Promise.reject(err)));
  if (preWriteLstat?.isSymbolicLink()) {
    throw new Error(`Rejected symlink target at write boundary: ${output.target_file}`);
  }

  const noFollowFlag = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  const openFlags = fs.constants.O_WRONLY | fs.constants.O_TRUNC | (isNewFile ? fs.constants.O_CREAT | fs.constants.O_EXCL : 0) | noFollowFlag;
  const fh = await fs.promises.open(revalidatedPath, openFlags, 0o644);
  try {
    await fh.writeFile(newContent, 'utf8');
  } finally {
    await fh.close();
  }

  return {
    applied: true,
    filePath: revalidatedPath,
    originalContent,
    newContent,
  };
}
