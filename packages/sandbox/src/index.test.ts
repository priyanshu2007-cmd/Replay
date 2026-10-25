import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { IsolatedWorkspaceSandbox, SandboxUnavailableError } from './index.js';

test('sandbox exec exposes only the allowlisted environment (no host secrets)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-sandbox-test-'));
  const sandbox = await IsolatedWorkspaceSandbox.create(tmp);
  try {
    const res = await sandbox.exec('node', [
      '-e',
      'console.log(JSON.stringify({ k: process.env.NEBIUS_API_KEY ?? null, s: process.env.SUPABASE_SERVICE_ROLE_KEY ?? null, d: process.env.DATABASE_URL ?? null, ci: process.env.CI ?? null }))',
    ]);
    assert.equal(res.exitCode, 0);
    const parsed = JSON.parse(res.stdout) as { k: string | null; s: string | null; d: string | null; ci: string | null };
    assert.equal(parsed.k, null, 'NEBIUS_API_KEY must not reach sandboxed code');
    assert.equal(parsed.s, null, 'SUPABASE_SERVICE_ROLE_KEY must not reach sandboxed code');
    assert.equal(parsed.d, null, 'DATABASE_URL must not reach sandboxed code');
    assert.equal(parsed.ci, '1');
  } finally {
    await sandbox.cleanup();
  }
});

test('sandbox creation fails closed in production without the explicit flag', async () => {
  const saved = { env: process.env.REPLAY_ALLOW_HOST_SANDBOX, nodeEnv: process.env.NODE_ENV };
  process.env.REPLAY_ALLOW_HOST_SANDBOX = '0';
  process.env.NODE_ENV = 'production';
  try {
    await assert.rejects(
      IsolatedWorkspaceSandbox.create(os.tmpdir()),
      (err: unknown) => err instanceof SandboxUnavailableError,
    );
  } finally {
    process.env.REPLAY_ALLOW_HOST_SANDBOX = saved.env;
    process.env.NODE_ENV = saved.nodeEnv;
  }
});
