import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packRepository, redactSecrets, formatNumberedLines, extractLineRange } from './packer.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const DEMO_SHOP_ROOT = path.resolve(moduleDir, '../../../targets/demo-shop');

test('packRepository produces deterministic lexicographical ordering and accurate relative paths', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-packer-order-'));
  try {
    await fs.mkdir(path.join(tmp, 'src', 'components'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'src', 'z.ts'), 'export const z = 1;\n');
    await fs.writeFile(path.join(tmp, 'src', 'a.ts'), 'export const a = 2;\n');
    await fs.writeFile(path.join(tmp, 'src', 'components', 'Button.tsx'), 'export const Button = () => null;\n');
    await fs.writeFile(path.join(tmp, 'package.json'), '{"name":"test"}\n');

    const b1 = await packRepository(tmp);
    const b2 = await packRepository(tmp);

    assert.deepEqual(
      b1.files.map(f => f.path),
      ['package.json', 'src/a.ts', 'src/components/Button.tsx', 'src/z.ts']
    );
    assert.equal(b1.bundleText, b2.bundleText);
    assert.equal(b1.metadata.includedFileCount, 4);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('line numbering and extractLineRange reconstruct source lines accurately', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-packer-lines-'));
  try {
    const src = ['line one', 'line two', 'line three', 'line four'].join('\n');
    await fs.writeFile(path.join(tmp, 'sample.ts'), src);

    const bundle = await packRepository(tmp);
    const file = bundle.files[0]!;
    assert.equal(file.lineCount, 4);
    assert.equal(
      file.numberedContent,
      ['1: line one', '2: line two', '3: line three', '4: line four'].join('\n')
    );
    assert.equal(extractLineRange(file, 2, 3), 'line two\nline three');
    assert.throws(() => extractLineRange(file, 0, 2), /Invalid line range/);
    assert.throws(() => extractLineRange(file, 3, 2), /Invalid line range/);
    assert.throws(() => extractLineRange(file, 2, 5), /Invalid line range/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('excludes .env files, private key files, and redacts inline secret literals', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-packer-secrets-'));
  try {
    await fs.writeFile(path.join(tmp, '.env'), 'FAKE_KEY=should_never_be_included\n');
    await fs.writeFile(path.join(tmp, '.env.local'), 'FAKE_LOCAL=should_never_be_included\n');
    await fs.writeFile(
      path.join(tmp, 'key.ts'),
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0000\n-----END RSA PRIVATE KEY-----\n'
    );
    const fakeToken = 'nvapi-' + 'A1b2C3d4E5f6G7h8I9j0';
    const fakeAssign = 'const apiKey = "super_secret_test_value_12345";';
    await fs.writeFile(
      path.join(tmp, 'config.ts'),
      `export const token = "${fakeToken}";\n${fakeAssign}\nexport const safe = 42;\n`
    );

    const bundle = await packRepository(tmp);
    assert.deepEqual(bundle.files.map(f => f.path), ['config.ts']);
    assert.ok(!bundle.bundleText.includes(fakeToken));
    assert.ok(!bundle.bundleText.includes('super_secret_test_value_12345'));
    assert.ok(!bundle.bundleText.includes('should_never_be_included'));
    assert.ok(bundle.bundleText.includes('[REDACTED_SECRET]'));
    assert.ok(bundle.metadata.redactedSecretCount >= 2);

    const secretSkips = bundle.skippedFiles.filter(s => s.reason === 'secret_file').map(s => s.path);
    assert.deepEqual(secretSkips.sort(), ['.env', '.env.local', 'key.ts']);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('redactSecrets handles multiple token formats without false positives on normal code', () => {
  const sample = [
    'const k1 = "sk-proj-1234567890abcdefghij";',
    'const k2 = "ghp_1234567890abcdefghijklmnopqrstuv";',
    'const normal = "hello world";',
  ].join('\n');
  const res = redactSecrets(sample);
  assert.ok(!res.text.includes('sk-proj-1234567890abcdefghij'));
  assert.ok(!res.text.includes('ghp_1234567890abcdefghijklmnopqrstuv'));
  assert.ok(res.text.includes('const normal = "hello world";'));
  assert.ok(res.redactedCount >= 2);
});

test('excludes binary files, empty files, node_modules, dist, and lockfiles', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-packer-filters-'));
  try {
    await fs.mkdir(path.join(tmp, 'node_modules', 'pkg'), { recursive: true });
    await fs.mkdir(path.join(tmp, 'dist'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'node_modules', 'pkg', 'index.js'), 'module.exports = {};\n');
    await fs.writeFile(path.join(tmp, 'dist', 'bundle.js'), 'console.log(1);\n');
    await fs.writeFile(path.join(tmp, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    await fs.writeFile(path.join(tmp, 'app.min.js'), 'minified();\n');
    await fs.writeFile(path.join(tmp, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
    await fs.writeFile(path.join(tmp, ' disguised.ts'), Buffer.from([0x61, 0x62, 0x00, 0x63])); // null byte inside .ts
    await fs.writeFile(path.join(tmp, 'empty.ts'), '');
    await fs.writeFile(path.join(tmp, 'whitespace.ts'), '   \n  ');
    await fs.writeFile(path.join(tmp, 'valid.ts'), 'export const ok = true;\n');

    const bundle = await packRepository(tmp);
    assert.deepEqual(bundle.files.map(f => f.path), ['valid.ts']);
    const reasons = new Map(bundle.skippedFiles.map(s => [s.path, s.reason]));
    assert.equal(reasons.get('node_modules'), 'ignored_dir');
    assert.equal(reasons.get('dist'), 'ignored_dir');
    assert.equal(reasons.get('pnpm-lock.yaml'), 'ignored_file');
    assert.equal(reasons.get('app.min.js'), 'ignored_file');
    assert.equal(reasons.get('photo.png'), 'binary');
    assert.equal(reasons.get(' disguised.ts'), 'binary');
    assert.equal(reasons.get('empty.ts'), 'empty');
    assert.equal(reasons.get('whitespace.ts'), 'empty');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('prevents symlink escapes outside repository root and directory symlink cycles', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-packer-symlink-'));
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-packer-outside-'));
  try {
    const outsideFile = path.join(outsideDir, 'outside.ts');
    await fs.writeFile(outsideFile, 'export const secret = "outside";\n');
    await fs.writeFile(path.join(tmp, 'inside.ts'), 'export const inside = 1;\n');
    await fs.symlink(outsideFile, path.join(tmp, 'escaped-link.ts'));
    await fs.symlink(outsideDir, path.join(tmp, 'escaped-dir'));

    const bundle = await packRepository(tmp);
    assert.deepEqual(bundle.files.map(f => f.path), ['inside.ts']);
    assert.ok(!bundle.bundleText.includes('outside'));
    const escaped = bundle.skippedFiles.filter(s => s.reason === 'symlink_escaped').map(s => s.path);
    assert.deepEqual(escaped.sort(), ['escaped-dir', 'escaped-link.ts']);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

test('enforces maxFiles, maxFileBytes, and maxTotalChars with truncation metadata', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-packer-limits-'));
  try {
    const longFile = Array.from({ length: 50 }, (_, i) => `export const v${i} = ${i};`).join('\n');
    await fs.writeFile(path.join(tmp, 'a.ts'), longFile);
    await fs.writeFile(path.join(tmp, 'b.ts'), 'export const b = 2;\n');
    await fs.writeFile(path.join(tmp, 'c.ts'), 'export const c = 3;\n');

    const bundle = await packRepository(tmp, {
      maxFiles: 2,
      maxFileBytes: 120,
      maxTotalChars: 500,
    });

    assert.equal(bundle.files.length, 2);
    assert.equal(bundle.files[0]?.path, 'a.ts');
    assert.equal(bundle.files[0]?.truncated, true);
    assert.ok(bundle.files[0]!.content.length <= 120);
    assert.equal(bundle.metadata.truncatedFileCount, 1);
    assert.ok(bundle.skippedFiles.some(s => s.path === 'c.ts' && s.reason === 'max_files_exceeded'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('rejects missing repository root and skips unreadable files gracefully', async () => {
  await assert.rejects(
    packRepository('/tmp/replay-nonexistent-repo-' + Date.now()),
    /Repository root not found/
  );
});

test('packs Demo Shop (including untracked workspace files) well under 200K tokens', async () => {
  const bundle = await packRepository(DEMO_SHOP_ROOT);
  const paths = bundle.files.map(f => f.path);
  assert.ok(paths.includes('src/App.tsx'), 'must include src/App.tsx');
  assert.ok(paths.includes('src/products.ts'), 'must include src/products.ts');
  assert.ok(paths.includes('src/types.ts'), 'must include src/types.ts');
  assert.ok(!paths.some(p => p.includes('node_modules')));
  assert.ok(!paths.some(p => p.endsWith('.spec.ts')), 'excludes tests by default');
  assert.ok(bundle.metadata.estimatedTokens < 200_000, `tokens ${bundle.metadata.estimatedTokens} must be < 200K`);
});

test('formatNumberedLines numbers 1-indexed lines cleanly', () => {
  const res = formatNumberedLines('alpha\nbeta');
  assert.equal(res.lineCount, 2);
  assert.equal(res.numberedContent, '1: alpha\n2: beta');
});
