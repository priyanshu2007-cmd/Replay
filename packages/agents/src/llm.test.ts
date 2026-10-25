import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_MODEL_DEFAULTS, resolveApiKey, resolveModel, LlmClient, AgentRole } from './llm.js';

const ROLES: AgentRole[] = ['watcher', 'verifier', 'locator', 'reproducer', 'fixer', 'reporter'];
const ENV_VARS = [
  'NEBIUS_API_KEY',
  'NEBIUS_BASE_URL',
  ...ROLES.map(r => `NEBIUS_API_KEY_${r.toUpperCase()}`),
  ...ROLES.map(r => `MODEL_${r.toUpperCase()}`),
];

function withCleanEnv<T>(fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const v of ENV_VARS) {
    saved.set(v, process.env[v]);
    delete process.env[v];
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('role map covers all six roles with exact Token Factory catalog defaults', () => {
  withCleanEnv(() => {
    assert.deepEqual(Object.keys(AGENT_MODEL_DEFAULTS).sort(), [...ROLES].sort());
    assert.equal(resolveModel('watcher'), 'nvidia/Nemotron-3.5-Super-VL');
    assert.equal(resolveModel('verifier'), 'nvidia/Nemotron-3.5-Super-VL');
    assert.equal(resolveModel('locator'), 'nvidia/Nemotron-3_5-Lightning');
    assert.equal(resolveModel('reproducer'), 'nvidia/Nemotron-3-Ultra-550b-a55b');
    assert.equal(resolveModel('fixer'), 'nvidia/Nemotron-3-Ultra-550b-a55b');
    assert.equal(resolveModel('reporter'), 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B');
  });
});

test('MODEL_<ROLE> env overrides the default model id', () => {
  withCleanEnv(() => {
    process.env.MODEL_LOCATOR = 'custom/model-id';
    assert.equal(resolveModel('locator'), 'custom/model-id');
    delete process.env.MODEL_LOCATOR;
    assert.equal(resolveModel('locator'), 'nvidia/Nemotron-3_5-Lightning');
  });
});

test('key resolution: per-role key wins, NEBIUS_API_KEY is the fallback, none yields undefined', () => {
  withCleanEnv(() => {
    assert.equal(resolveApiKey(), undefined);
    assert.equal(resolveApiKey('watcher'), undefined);

    process.env.NEBIUS_API_KEY_LOCATOR = 'role-key';
    assert.equal(resolveApiKey('locator'), 'role-key');
    assert.equal(resolveApiKey('watcher'), undefined);

    process.env.NEBIUS_API_KEY = 'global-key';
    assert.equal(resolveApiKey('watcher'), 'global-key');
    assert.equal(resolveApiKey(), 'global-key');
    assert.equal(resolveApiKey('locator'), 'role-key');
  });
});

test('LlmClient refuses to construct without any NVIDIA key', () => {
  withCleanEnv(() => {
    assert.throws(() => new LlmClient(), /NEBIUS_API_KEY/);
  });
});

test('LlmClient accepts explicit config even when env is empty', () => {
  withCleanEnv(() => {
    const c = new LlmClient({ apiKey: 'test-key', baseURL: 'http://localhost:9/v1' });
    assert.ok(c instanceof LlmClient);
  });
});
