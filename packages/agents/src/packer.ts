import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface PackRepoOptions {
  /** Maximum number of files to include. Default 100. */
  maxFiles?: number;
  /** Maximum bytes per file before line-safe truncation. Default 65536 (64 KB). */
  maxFileBytes?: number;
  /** Maximum total characters across the packed bundle. Default 400000 (~100K tokens, well under 200K limit). */
  maxTotalChars?: number;
  /** Include test files (*.spec.*, *.test.*, tests/). Default false so Locator targets app source. */
  includeTests?: boolean;
}

export interface PackedFile {
  /** POSIX relative path from repoRoot (e.g. "src/App.tsx"). */
  path: string;
  /** UTF-8 source text (with any detected inline secrets redacted). */
  content: string;
  /** 1-indexed line-numbered text ("1: ..."). */
  numberedContent: string;
  /** Total number of lines included in content. */
  lineCount: number;
  /** Original file size in bytes on disk. */
  byteSize: number;
  /** True if the file was truncated to fit maxFileBytes or maxTotalChars. */
  truncated: boolean;
  /** Number of inline secret literals redacted from this file. */
  redactedCount: number;
}

export type SkipReason =
  | 'ignored_dir'
  | 'ignored_file'
  | 'secret_file'
  | 'binary'
  | 'empty'
  | 'unreadable'
  | 'symlink_escaped'
  | 'max_files_exceeded'
  | 'max_context_exceeded';

export interface SkippedFile {
  path: string;
  reason: SkipReason;
}

export interface RepoBundle {
  repoRoot: string;
  files: PackedFile[];
  skippedFiles: SkippedFile[];
  bundleText: string;
  metadata: {
    includedFileCount: number;
    skippedFileCount: number;
    truncatedFileCount: number;
    redactedSecretCount: number;
    totalChars: number;
    estimatedTokens: number;
  };
}

const ALWAYS_IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.pnpm-store',
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  'test-results',
  'playwright-report',
  'blob-report',
  '.turbo',
  '.cache',
  '.vscode',
  '.idea',
  '.agents',
  '.claude',
  'ai-agent-toolkit',
  'samples',
  'scripts',
]);

const TEST_DIRS = new Set(['tests', '__tests__', 'e2e', 'cypress']);

const ALWAYS_IGNORED_FILES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  '.DS_Store',
  'Thumbs.db',
  '.gitignore',
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.avif',
  '.pdf', '.webm', '.mp4', '.mov', '.avi', '.mkv', '.mp3', '.wav', '.ogg',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.7z',
  '.wasm', '.sqlite', '.db', '.exe', '.dll', '.so', '.dylib', '.bin',
]);

const ALLOWED_TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.html', '.css', '.scss', '.less',
  '.md', '.txt', '.yaml', '.yml', '.toml', '.sql', '.graphql', '.svg',
]);

const PRIVATE_KEY_HEADER_RE = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/;

const SECRET_PATTERNS: RegExp[] = [
  /\bnvapi-[A-Za-z0-9_-]{12,}\b/g,
  /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /((?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|password|passwd|client[_-]?secret)\s*[:=]\s*['"])([^'"\s]{8,})(['"])/gi,
  /(^[ \t]*(?:export[ \t]+)?[A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*['"]?)([^\s'"#]{8,})(['"]?)/gm,
];

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function isSecretFileName(baseName: string): boolean {
  const lower = baseName.toLowerCase();
  if (lower === '.env' || lower.startsWith('.env.')) return true;
  if (lower.endsWith('.pem') || lower.endsWith('.key') || lower.endsWith('.p12') || lower.endsWith('.pfx')) return true;
  if (lower === 'id_rsa' || lower === 'id_ed25519' || lower.startsWith('id_rsa.') || lower.startsWith('id_ed25519.')) return true;
  if (lower.includes('credentials') && lower.endsWith('.json')) return true;
  if (lower === 'secrets.json' || lower === 'secrets.yaml' || lower === 'secrets.yml') return true;
  return false;
}

function isTestFileName(baseName: string): boolean {
  const lower = baseName.toLowerCase();
  return (
    lower.endsWith('.spec.ts') ||
    lower.endsWith('.spec.tsx') ||
    lower.endsWith('.test.ts') ||
    lower.endsWith('.test.tsx') ||
    lower.endsWith('.spec.js') ||
    lower.endsWith('.test.js') ||
    lower.startsWith('playwright.config.')
  );
}

function isIgnoredFileName(baseName: string, includeTests: boolean): boolean {
  if (ALWAYS_IGNORED_FILES.has(baseName)) return true;
  if (baseName.startsWith('.') && baseName !== '.env.example') return true;
  const lower = baseName.toLowerCase();
  if (lower.endsWith('.min.js') || lower.endsWith('.min.css') || lower.endsWith('.map') || lower.endsWith('.log')) {
    return true;
  }
  if (!includeTests && isTestFileName(baseName)) return true;
  return false;
}

async function loadGitignoreNames(repoRoot: string): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const raw = await fs.readFile(path.join(repoRoot, '.gitignore'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
      const clean = trimmed.replace(/^\/+|\/+$/g, '');
      if (clean && !clean.includes('*')) out.add(clean);
    }
  } catch {
    // No .gitignore or unreadable — built-in exclusions still apply
  }
  return out;
}

/** Pure: redact inline secret patterns without logging or retaining raw values. */
export function redactSecrets(input: string): { text: string; redactedCount: number } {
  let text = input;
  let redactedCount = 0;

  for (const pattern of SECRET_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    text = text.replace(re, (...args: unknown[]) => {
      redactedCount++;
      // Pattern with 3 capture groups: prefix, secret, suffix
      if (typeof args[1] === 'string' && typeof args[2] === 'string' && typeof args[3] === 'string') {
        return `${args[1]}[REDACTED_SECRET]${args[3]}`;
      }
      return '[REDACTED_SECRET]';
    });
  }

  return { text, redactedCount };
}

/** Pure: format 1-based line numbers for source text. */
export function formatNumberedLines(content: string): { numberedContent: string; lineCount: number } {
  const lines = content.split(/\r?\n/);
  const numbered = lines.map((line, i) => `${i + 1}: ${line}`).join('\n');
  return { numberedContent: numbered, lineCount: lines.length };
}

/** Pure: extract 1-indexed inclusive line range [startLine, endLine] from a PackedFile. */
export function extractLineRange(file: PackedFile, startLine: number, endLine: number): string {
  const lines = file.content.split(/\r?\n/);
  if (startLine < 1 || endLine < startLine || endLine > lines.length) {
    throw new Error(`Invalid line range ${startLine}-${endLine} for ${file.path} (1..${lines.length})`);
  }
  return lines.slice(startLine - 1, endLine).join('\n');
}

function truncateToByteLimit(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  const sliced = buf.subarray(0, maxBytes).toString('utf8');
  const lastNewline = sliced.lastIndexOf('\n');
  const clean = lastNewline > 0 ? sliced.slice(0, lastNewline) : sliced;
  return { text: clean, truncated: true };
}

/**
 * Deterministic, security-hardened Repository Packer.
 * Walks a target repository without mutating it, enforces symlink/path boundaries,
 * filters secrets/binaries/build artifacts, and returns line-numbered source files.
 */
export async function packRepository(repoRoot: string, options: PackRepoOptions = {}): Promise<RepoBundle> {
  const maxFiles = options.maxFiles ?? 100;
  const maxFileBytes = options.maxFileBytes ?? 64 * 1024;
  const maxTotalChars = options.maxTotalChars ?? 400_000;
  const includeTests = options.includeTests ?? false;

  const stat = await fs.stat(repoRoot).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Repository root not found or not a directory: ${repoRoot}`);
  }

  const realRepoRoot = await fs.realpath(repoRoot);
  const gitignoreEntries = await loadGitignoreNames(realRepoRoot);

  const skippedFiles: SkippedFile[] = [];
  const candidateRelPaths: string[] = [];

  async function walk(currentDir: string, relDir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      if (relDir) skippedFiles.push({ path: relDir, reason: 'unreadable' });
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      const fullPath = path.join(currentDir, entry.name);

      // Guard against any path traversal segments
      if (relPath.startsWith('..') || relPath.split('/').includes('..')) {
        skippedFiles.push({ path: relPath, reason: 'symlink_escaped' });
        continue;
      }

      const lstat = await fs.lstat(fullPath).catch(() => null);
      if (!lstat) {
        skippedFiles.push({ path: relPath, reason: 'unreadable' });
        continue;
      }

      if (lstat.isSymbolicLink()) {
        const realTarget = await fs.realpath(fullPath).catch(() => null);
        if (
          !realTarget ||
          (realTarget !== realRepoRoot && !realTarget.startsWith(realRepoRoot + path.sep))
        ) {
          skippedFiles.push({ path: relPath, reason: 'symlink_escaped' });
          continue;
        }
        const targetStat = await fs.stat(realTarget).catch(() => null);
        if (!targetStat || targetStat.isDirectory()) {
          // Do not follow directory symlinks to avoid cycles
          skippedFiles.push({ path: relPath, reason: 'symlink_escaped' });
          continue;
        }
      }

      if (lstat.isDirectory()) {
        if (
          ALWAYS_IGNORED_DIRS.has(entry.name) ||
          entry.name.startsWith('.') ||
          entry.name.endsWith('-results') ||
          entry.name.endsWith('-report') ||
          (!includeTests && TEST_DIRS.has(entry.name)) ||
          gitignoreEntries.has(entry.name) ||
          gitignoreEntries.has(relPath)
        ) {
          skippedFiles.push({ path: relPath, reason: 'ignored_dir' });
          continue;
        }
        await walk(fullPath, relPath);
        continue;
      }

      if (!lstat.isFile() && !lstat.isSymbolicLink()) {
        continue;
      }

      if (isSecretFileName(entry.name)) {
        skippedFiles.push({ path: relPath, reason: 'secret_file' });
        continue;
      }

      if (isIgnoredFileName(entry.name, includeTests) || gitignoreEntries.has(entry.name) || gitignoreEntries.has(relPath)) {
        skippedFiles.push({ path: relPath, reason: 'ignored_file' });
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) {
        skippedFiles.push({ path: relPath, reason: 'binary' });
        continue;
      }

      if (ext && !ALLOWED_TEXT_EXTENSIONS.has(ext)) {
        skippedFiles.push({ path: relPath, reason: 'ignored_file' });
        continue;
      }

      candidateRelPaths.push(toPosix(relPath));
    }
  }

  await walk(realRepoRoot, '');
  candidateRelPaths.sort((a, b) => a.localeCompare(b));

  const files: PackedFile[] = [];
  let totalChars = 0;
  let truncatedFileCount = 0;
  let redactedSecretCount = 0;

  for (const relPath of candidateRelPaths) {
    if (files.length >= maxFiles) {
      skippedFiles.push({ path: relPath, reason: 'max_files_exceeded' });
      continue;
    }

    const fullPath = path.join(realRepoRoot, ...relPath.split('/'));
    let rawBuf: Buffer;
    try {
      rawBuf = await fs.readFile(fullPath);
    } catch {
      skippedFiles.push({ path: relPath, reason: 'unreadable' });
      continue;
    }

    if (rawBuf.byteLength === 0) {
      skippedFiles.push({ path: relPath, reason: 'empty' });
      continue;
    }

    // Null byte in first 8 KB indicates binary content
    const probeLen = Math.min(rawBuf.byteLength, 8192);
    if (rawBuf.subarray(0, probeLen).includes(0)) {
      skippedFiles.push({ path: relPath, reason: 'binary' });
      continue;
    }

    const rawText = rawBuf.toString('utf8');
    if (rawText.trim().length === 0) {
      skippedFiles.push({ path: relPath, reason: 'empty' });
      continue;
    }

    if (PRIVATE_KEY_HEADER_RE.test(rawText)) {
      skippedFiles.push({ path: relPath, reason: 'secret_file' });
      continue;
    }

    const { text: redactedText, redactedCount } = redactSecrets(rawText);
    const { text: byteBoundedText, truncated: byteTruncated } = truncateToByteLimit(redactedText, maxFileBytes);

    const remainingBudget = maxTotalChars - totalChars;
    if (remainingBudget <= 0) {
      skippedFiles.push({ path: relPath, reason: 'max_context_exceeded' });
      continue;
    }

    let finalContent = byteBoundedText;
    let truncated = byteTruncated;
    if (finalContent.length > remainingBudget) {
      const sliced = finalContent.slice(0, remainingBudget);
      const lastNl = sliced.lastIndexOf('\n');
      finalContent = lastNl > 0 ? sliced.slice(0, lastNl) : sliced;
      if (finalContent.trim().length === 0) {
        skippedFiles.push({ path: relPath, reason: 'max_context_exceeded' });
        continue;
      }
      truncated = true;
    }

    const { numberedContent, lineCount } = formatNumberedLines(finalContent);
    if (truncated) truncatedFileCount++;
    redactedSecretCount += redactedCount;
    totalChars += finalContent.length;

    files.push({
      path: relPath,
      content: finalContent,
      numberedContent,
      lineCount,
      byteSize: rawBuf.byteLength,
      truncated,
      redactedCount,
    });
  }

  skippedFiles.sort((a, b) => a.path.localeCompare(b.path));

  const sections = files.map(
    f =>
      `=== FILE: ${f.path} (lines 1-${f.lineCount}${f.truncated ? ', truncated' : ''}) ===\n${f.numberedContent}`
  );
  const bundleText = sections.join('\n\n');

  return {
    repoRoot: realRepoRoot,
    files,
    skippedFiles,
    bundleText,
    metadata: {
      includedFileCount: files.length,
      skippedFileCount: skippedFiles.length,
      truncatedFileCount,
      redactedSecretCount,
      totalChars: bundleText.length,
      estimatedTokens: Math.ceil(bundleText.length / 4),
    },
  };
}
