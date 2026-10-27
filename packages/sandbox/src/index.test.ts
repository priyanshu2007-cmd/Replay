import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DockerSandbox,
  IsolatedWorkspaceSandbox,
  SandboxUnavailableError,
  sanitizeSandboxEnv,
} from './index.js';

test('sandbox exec exposes only the allowlisted environment (no host secrets or injected secret keys)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-sandbox-test-'));
  await fs.writeFile(path.join(tmp, '.env'), 'NEBIUS_API_KEY=leaked-from-file\n', 'utf8');
  await fs.writeFile(path.join(tmp, 'app.txt'), 'safe-file\n', 'utf8');

  const sandbox = await IsolatedWorkspaceSandbox.create(tmp);
  try {
    assert.equal(sandbox.backend, 'host');
    // Verify .env was NOT copied into the sandbox workspace
    await assert.rejects(fs.stat(path.join(sandbox.workDir, '.env')));

    const res = await sandbox.exec(
      'node',
      [
        '-e',
        'console.log(JSON.stringify({ k: process.env.NEBIUS_API_KEY ?? null, s: process.env.SUPABASE_SERVICE_ROLE_KEY ?? null, d: process.env.DATABASE_URL ?? null, customSecret: process.env.MY_SECRET_TOKEN ?? null, port: process.env.DEMO_SHOP_PORT ?? null, ci: process.env.CI ?? null }))',
      ],
      {
        NEBIUS_API_KEY: 'attempted-override-key',
        SUPABASE_SERVICE_ROLE_KEY: 'attempted-service-role',
        DATABASE_URL: 'postgresql://secret',
        MY_SECRET_TOKEN: 'shh',
        DEMO_SHOP_PORT: '5179',
      }
    );
    assert.equal(res.exitCode, 0);
    const parsed = JSON.parse(res.stdout) as {
      k: string | null;
      s: string | null;
      d: string | null;
      customSecret: string | null;
      port: string | null;
      ci: string | null;
    };
    assert.equal(parsed.k, null, 'NEBIUS_API_KEY must not reach sandboxed code');
    assert.equal(parsed.s, null, 'SUPABASE_SERVICE_ROLE_KEY must not reach sandboxed code');
    assert.equal(parsed.d, null, 'DATABASE_URL must not reach sandboxed code');
    assert.equal(parsed.customSecret, null, 'Arbitrary secret env must be stripped');
    assert.equal(parsed.port, '5179', 'Approved DEMO_SHOP_PORT env is allowed');
    assert.equal(parsed.ci, '1');
  } finally {
    await sandbox.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('sandbox creation fails closed in production when Docker is unavailable', async () => {
  const saved = {
    allowHost: process.env.REPLAY_ALLOW_HOST_SANDBOX,
    nodeEnv: process.env.NODE_ENV,
    mode: process.env.REPLAY_SANDBOX_MODE,
  };
  process.env.REPLAY_ALLOW_HOST_SANDBOX = '0';
  process.env.NODE_ENV = 'production';
  delete process.env.REPLAY_SANDBOX_MODE;

  const unavailableDocker = async () => {
    throw new Error('Cannot connect to the Docker daemon');
  };

  try {
    await assert.rejects(
      IsolatedWorkspaceSandbox.create(os.tmpdir(), { dockerExec: unavailableDocker }),
      (err: unknown) => err instanceof SandboxUnavailableError
    );
  } finally {
    process.env.REPLAY_ALLOW_HOST_SANDBOX = saved.allowHost;
    process.env.NODE_ENV = saved.nodeEnv;
    process.env.REPLAY_SANDBOX_MODE = saved.mode;
  }
});

test('serverless environment refuses host execution even if REPLAY_ALLOW_HOST_SANDBOX=1 is set', async () => {
  const saved = {
    allowHost: process.env.REPLAY_ALLOW_HOST_SANDBOX,
    vercel: process.env.VERCEL,
  };
  process.env.REPLAY_ALLOW_HOST_SANDBOX = '1';
  process.env.VERCEL = '1';

  const unavailableDocker = async () => {
    throw new Error('No Docker on serverless');
  };

  try {
    await assert.rejects(
      IsolatedWorkspaceSandbox.create(os.tmpdir(), { dockerExec: unavailableDocker }),
      (err: unknown) => err instanceof SandboxUnavailableError
    );
  } finally {
    if (saved.allowHost === undefined) delete process.env.REPLAY_ALLOW_HOST_SANDBOX;
    else process.env.REPLAY_ALLOW_HOST_SANDBOX = saved.allowHost;
    if (saved.vercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = saved.vercel;
  }
});

test('production selects DockerSandbox when available, enforces security flags, and never falls back to host on container error', async () => {
  const tmpSrc = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-docker-src-'));
  await fs.mkdir(path.join(tmpSrc, 'node_modules', 'dummy'), { recursive: true });
  await fs.writeFile(path.join(tmpSrc, 'index.js'), 'console.log(1);\n', 'utf8');

  const dockerCalls: Array<{ file: string; args: string[] }> = [];
  let shouldFailRun = false;

  const mockDockerExec = async (file: string, args: string[]) => {
    dockerCalls.push({ file, args });
    if (args[0] === 'info') {
      return { stdout: 'Server Version: 27.0', stderr: '' };
    }
    if (args[0] === 'run') {
      if (shouldFailRun) {
        const err: any = new Error('Container command failed');
        err.code = 2;
        err.stdout = 'test assertion failed';
        err.stderr = 'AssertionError';
        throw err;
      }
      return { stdout: 'container-ok', stderr: '' };
    }
    if (args[0] === 'rm') {
      return { stdout: '', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  const savedNodeEnv = process.env.NODE_ENV;
  const savedAllowHost = process.env.REPLAY_ALLOW_HOST_SANDBOX;
  process.env.NODE_ENV = 'production';
  delete process.env.REPLAY_ALLOW_HOST_SANDBOX;

  try {
    const sandbox = await IsolatedWorkspaceSandbox.create(tmpSrc, {
      dockerExec: mockDockerExec,
    });
    assert.equal(sandbox.backend, 'docker');

    const res1 = await sandbox.exec('npx', ['playwright', 'test'], {
      NEBIUS_API_KEY: 'must-not-pass',
      DEMO_SHOP_PORT: '5179',
    });
    assert.equal(res1.exitCode, 0);
    assert.equal(res1.stdout, 'container-ok');

    const runCall = dockerCalls.find((c) => c.args[0] === 'run');
    assert.ok(runCall, 'Docker run must be called');
    assert.ok(runCall.args.includes('--network') && runCall.args.includes('none'), 'Network must be disabled by default');
    assert.ok(runCall.args.includes('--user') && runCall.args.includes('pwuser'), 'Must run as non-root pwuser');
    assert.ok(runCall.args.includes('--cap-drop') && runCall.args.includes('ALL'), 'Must drop capabilities');
    assert.ok(runCall.args.includes('--security-opt') && runCall.args.includes('no-new-privileges'));
    assert.ok(!runCall.args.some((a) => a.includes('NEBIUS_API_KEY')), 'Secrets must not be passed to container');
    assert.ok(runCall.args.some((a) => a === 'DEMO_SHOP_PORT=5179'), 'Approved env must be passed to container');
    assert.ok(
      runCall.args.some((a) => a.endsWith(':/workspace/node_modules:ro')),
      'node_modules must be mounted read-only in container'
    );

    // Verify container error returns failure result and NEVER falls back to host
    shouldFailRun = true;
    const res2 = await sandbox.exec('node', ['-e', 'process.exit(0)']);
    assert.equal(res2.exitCode, 2);
    assert.equal(res2.stderr, 'AssertionError');

    // Verify docker rm -f cleanup was invoked for both runs
    const rmCalls = dockerCalls.filter((c) => c.args[0] === 'rm' && c.args[1] === '-f');
    assert.equal(rmCalls.length, 2);

    const workDirPath = sandbox.workDir;
    await sandbox.cleanup();
    await assert.rejects(fs.stat(workDirPath), 'Workspace temp directory must be removed on cleanup');
  } finally {
    process.env.NODE_ENV = savedNodeEnv;
    if (savedAllowHost === undefined) delete process.env.REPLAY_ALLOW_HOST_SANDBOX;
    else process.env.REPLAY_ALLOW_HOST_SANDBOX = savedAllowHost;
    await fs.rm(tmpSrc, { recursive: true, force: true });
  }
});

test('DockerSandbox rejects root user, host networking, and sensitive bind mounts (docker.sock, /etc, .env)', async () => {
  const noopExec = async () => ({ stdout: '', stderr: '' });

  await assert.rejects(
    DockerSandbox.run({
      image: 'alpine',
      command: ['echo'],
      user: 'root',
      execFn: noopExec,
    }),
    /Root execution is prohibited/
  );

  await assert.rejects(
    DockerSandbox.run({
      image: 'alpine',
      command: ['echo'],
      networkMode: 'host' as any,
      execFn: noopExec,
    }),
    /Host network mode is prohibited/
  );

  for (const badHostPath of ['/var/run/docker.sock', '/etc/passwd', '/', '/app/.env']) {
    await assert.rejects(
      DockerSandbox.run({
        image: 'alpine',
        command: ['echo'],
        bindMounts: [{ hostPath: badHostPath, containerPath: '/mnt/target' }],
        execFn: noopExec,
      }),
      (err: unknown) => err instanceof SandboxUnavailableError
    );
  }
});

test('DockerSandbox cleans up container on timeout and cancellation', async () => {
  const removedContainers: string[] = [];
  const timeoutExec = async (_file: string, args: string[]) => {
    if (args[0] === 'run') {
      const err: any = new Error('Command timed out');
      err.killed = true;
      err.signal = 'SIGTERM';
      throw err;
    }
    if (args[0] === 'rm' && args[1] === '-f' && args[2]) {
      removedContainers.push(args[2]);
    }
    return { stdout: '', stderr: '' };
  };

  const res = await DockerSandbox.run({
    image: 'mcr.microsoft.com/playwright:v1.50.1-noble',
    command: ['sleep', '999'],
    timeoutMs: 50,
    execFn: timeoutExec,
  });

  assert.equal(res.timedOut, true);
  assert.equal(res.exitCode, 124);
  assert.equal(removedContainers.length, 1);
  assert.ok(removedContainers[0]!.startsWith('replay-sandbox-'));
});

test('sanitizeSandboxEnv strips credentials and preserves safe test variables', () => {
  const out = sanitizeSandboxEnv({
    NEBIUS_API_KEY: 'secret-1',
    NVIDIA_API_KEY_WATCHER: 'secret-2',
    SUPABASE_SERVICE_ROLE_KEY: 'secret-3',
    DATABASE_URL: 'postgres://user:pass@host/db',
    AWS_SECRET_ACCESS_KEY: 'secret-4',
    CUSTOM_PASSWORD: 'secret-5',
    DEMO_SHOP_PORT: '5179',
    PLAYWRIGHT_TEST_MATCH: '**/tests/repro/**',
    SANDBOX_TEST: '1',
  });
  assert.equal(out.NEBIUS_API_KEY, undefined);
  assert.equal(out.NVIDIA_API_KEY_WATCHER, undefined);
  assert.equal(out.SUPABASE_SERVICE_ROLE_KEY, undefined);
  assert.equal(out.DATABASE_URL, undefined);
  assert.equal(out.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(out.CUSTOM_PASSWORD, undefined);
  assert.equal(out.DEMO_SHOP_PORT, '5179');
  assert.equal(out.PLAYWRIGHT_TEST_MATCH, '**/tests/repro/**');
  assert.equal(out.SANDBOX_TEST, '1');
});
