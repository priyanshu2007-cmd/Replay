import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { BugReportSchema, FixerOutputSchema, LocatorOutputSchema, ReproducerOutputSchema } from '@replay/shared';
import {
  applyPatchToDirectory,
  buildFixerMessages,
  loadFixerPrompt,
  proposeFix,
  validatePatchSafety,
} from './fixer.js';
import { RepoBundle } from './packer.js';

const MOCK_BUNDLE: RepoBundle = {
  repoRoot: '/fake/repo',
  files: [
    {
      path: 'src/App.tsx',
      content: 'const val = parseInt(rawValue, 10);\nsetCart(val);',
      numberedContent: '1: const val = parseInt(rawValue, 10);\n2: setCart(val);',
      lineCount: 2,
      byteSize: 50,
      truncated: false,
      redactedCount: 0,
    },
    {
      path: 'src/products.ts',
      content: 'export const PRODUCTS = [];',
      numberedContent: '1: export const PRODUCTS = [];',
      lineCount: 1,
      byteSize: 27,
      truncated: false,
      redactedCount: 0,
    },
  ],
  skippedFiles: [],
  bundleText: '=== FILE: src/App.tsx ===\n...',
  metadata: {
    includedFileCount: 2,
    skippedFileCount: 0,
    truncatedFileCount: 0,
    redactedSecretCount: 0,
    totalChars: 100,
    estimatedTokens: 25,
  },
};

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

const MOCK_LOCATOR_OUTPUT = LocatorOutputSchema.parse({
  suspects: [
    {
      file: 'src/App.tsx',
      start_line: 1,
      end_line: 2,
      symbol: 'handleQuantityChange',
      confidence: 0.95,
      symptom_link: 'parseInt without fallback produces NaN',
      evidence: 'const val = parseInt(rawValue, 10);',
    },
  ],
  suggested_test_selectors: ['cart-item-qty-prod-mouse', 'cart-total'],
  route: '/?bug=cart-nan',
});

const MOCK_REPRODUCER_OUTPUT = ReproducerOutputSchema.parse({
  reproduced: true,
  test_name: 'reproduce: cart total becomes NaN after clearing quantity',
  assertion: "await expect(page.getByTestId('cart-total')).not.toHaveText('$NaN')",
  failure_message: "Expected not '$NaN', received '$NaN'",
  test_code: "import { test, expect } from '@playwright/test'; test('cart-nan', async ({ page }) => {});",
});

test('loadFixerPrompt loads versioned prompt containing surgical fix instructions', () => {
  const prompt = loadFixerPrompt();
  assert.ok(prompt.includes('Fixer'));
  assert.ok(prompt.includes('Surgical patch only'));
  assert.ok(prompt.includes('Forbidden targets'));
});

test('validatePatchSafety accepts surgical edit to authorized source file', () => {
  const validOutput = FixerOutputSchema.parse({
    fixed: true,
    target_file: 'src/App.tsx',
    original_snippet: 'const val = parseInt(rawValue, 10);',
    replacement_snippet: 'const val = parseInt(rawValue, 10) || 0;',
    patch: '--- a/src/App.tsx\n+++ b/src/App.tsx',
    explanation: 'Fallback to 0 when rawValue is empty string to prevent NaN.',
    attempts: 1,
  });

  const res = validatePatchSafety(validOutput, MOCK_BUNDLE);
  assert.equal(res.valid, true);
  assert.equal(res.errors.length, 0);
});

test('validatePatchSafety rejects edits to tests, config, or out-of-scope files', () => {
  // 1. Edit to test file
  const testEdit = FixerOutputSchema.parse({
    fixed: true,
    target_file: 'tests/baseline.spec.ts',
    original_snippet: 'expect(true).toBe(true)',
    replacement_snippet: 'expect(true).toBe(false)',
    patch: '',
    explanation: 'Modifying test',
    attempts: 1,
  });
  const res1 = validatePatchSafety(testEdit, MOCK_BUNDLE);
  assert.equal(res1.valid, false);
  assert.ok(res1.errors.some(e => e.includes('prohibited')));

  // 2. Edit to package.json
  const pkgEdit = FixerOutputSchema.parse({
    fixed: true,
    target_file: 'package.json',
    original_snippet: '"name": "app"',
    replacement_snippet: '"name": "app-fixed"',
    patch: '',
    explanation: 'Modifying package.json',
    attempts: 1,
  });
  const res2 = validatePatchSafety(pkgEdit, MOCK_BUNDLE);
  assert.equal(res2.valid, false);

  // 3. Edit to nonexistent file
  const missingEdit = FixerOutputSchema.parse({
    fixed: true,
    target_file: 'src/NonExistent.tsx',
    original_snippet: 'code',
    replacement_snippet: 'fixed',
    patch: '',
    explanation: 'Missing file',
    attempts: 1,
  });
  const res3 = validatePatchSafety(missingEdit, MOCK_BUNDLE);
  assert.equal(res3.valid, false);
  assert.ok(res3.errors.some(e => e.includes('does not exist')));

  // 4. Original snippet not found in target file
  const mismatchSnippet = FixerOutputSchema.parse({
    fixed: true,
    target_file: 'src/App.tsx',
    original_snippet: 'THIS_STRING_DOES_NOT_EXIST_IN_APP_TSX',
    replacement_snippet: 'fixed',
    patch: '',
    explanation: 'Snippet mismatch',
    attempts: 1,
  });
  const res4 = validatePatchSafety(mismatchSnippet, MOCK_BUNDLE);
  assert.equal(res4.valid, false);
  assert.ok(res4.errors.some(e => e.includes('Original snippet does not match')));
});

test('applyPatchToDirectory surgically modifies target file in temporary directory', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-patch-test-'));
  try {
    const srcDir = path.join(tmpDir, 'src');
    await fs.mkdir(srcDir, { recursive: true });
    const targetPath = path.join(srcDir, 'App.tsx');
    await fs.writeFile(targetPath, 'line 1\nconst qty = parseInt(val, 10);\nline 3\n', 'utf8');

    const output = FixerOutputSchema.parse({
      fixed: true,
      target_file: 'src/App.tsx',
      original_snippet: 'const qty = parseInt(val, 10);',
      replacement_snippet: 'const qty = parseInt(val, 10) || 0;',
      patch: '',
      explanation: 'Safe parse fallback',
      attempts: 1,
    });

    const result = await applyPatchToDirectory(tmpDir, output);
    assert.equal(result.applied, true);
    assert.ok(result.newContent.includes('const qty = parseInt(val, 10) || 0;'));

    // Check on disk
    const onDisk = await fs.readFile(targetPath, 'utf8');
    assert.equal(onDisk, 'line 1\nconst qty = parseInt(val, 10) || 0;\nline 3\n');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('proposeFix calls mock LlmClient and returns validated FixerResult', async () => {
  const mockClient = {
    async callJson<T>() {
      return {
        data: {
          fixed: true,
          target_file: 'src/App.tsx',
          original_snippet: 'const val = parseInt(rawValue, 10);',
          replacement_snippet: 'const val = parseInt(rawValue, 10) || 0;',
          patch: '--- a/src/App.tsx\n+++ b/src/App.tsx',
          explanation: 'Provide 0 fallback on empty string input.',
          attempts: 1,
        } as unknown as T,
        rawText: '{}',
        metrics: { promptTokens: 100, completionTokens: 40, totalTokens: 140, durationMs: 150, model: 'mock-fixer' },
      };
    },
  };

  const res = await proposeFix(
    {
      bugReport: MOCK_BUG_REPORT,
      locatorOutput: MOCK_LOCATOR_OUTPUT,
      reproducerOutput: MOCK_REPRODUCER_OUTPUT,
      bundle: MOCK_BUNDLE,
    },
    { client: mockClient, model: 'mock-fixer' }
  );

  assert.equal(res.output.fixed, true);
  assert.equal(res.output.target_file, 'src/App.tsx');
  assert.equal(res.model, 'mock-fixer');
});

test('buildFixerMessages constructs deterministic user message with context', () => {
  const messages = buildFixerMessages({
    bugReport: MOCK_BUG_REPORT,
    locatorOutput: MOCK_LOCATOR_OUTPUT,
    reproducerOutput: MOCK_REPRODUCER_OUTPUT,
    bundle: MOCK_BUNDLE,
  });

  assert.equal(messages.length, 2);
  const sysMsg = messages[0];
  const userMsg = messages[1];
  assert.ok(sysMsg && userMsg);
  assert.equal(sysMsg.role, 'system');
  assert.equal(userMsg.role, 'user');
  const userContent = String(userMsg.content);
  assert.ok(userContent.includes('Cart total becomes NaN'));
  assert.ok(userContent.includes('handleQuantityChange'));
});

// --- Workspace path guard (security) ---
import { resolveSafeWorkspacePath } from './fixer.js';

test('resolveSafeWorkspacePath rejects traversal, absolute escapes and protected files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-guard-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'App.tsx'), 'x');
  await fs.writeFile(path.join(root, 'package.json'), '{}');
  await fs.writeFile(path.join(root, '.env'), 'SECRET=1');

  // Valid path resolves inside the root
  const ok = await resolveSafeWorkspacePath(root, 'src/App.tsx');
  assert.equal(ok, await fs.realpath(path.resolve(root, 'src/App.tsx')));

  // Traversal escapes rejected
  await assert.rejects(resolveSafeWorkspacePath(root, '../../etc/passwd'), /outside the workspace/);
  await assert.rejects(resolveSafeWorkspacePath(root, 'src/../../../etc/passwd'), /outside the workspace/);
  await assert.rejects(resolveSafeWorkspacePath(root, '/etc/passwd'), /outside the workspace/);

  // Protected files rejected
  await assert.rejects(resolveSafeWorkspacePath(root, 'package.json'), /protected file/);
  await assert.rejects(resolveSafeWorkspacePath(root, '.env'), /protected/);
  await assert.rejects(resolveSafeWorkspacePath(root, 'node_modules/x/index.js'), /protected path/);
  await assert.rejects(resolveSafeWorkspacePath(root, 'tests/anything.spec.ts'), /protected path/);
});
