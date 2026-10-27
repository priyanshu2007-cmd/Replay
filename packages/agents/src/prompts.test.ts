import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  loadWatcherPrompt,
  loadLocatorPrompt,
  loadReproducerPrompt,
  loadVerifierPrompt,
  loadFixerPrompt,
  loadReporterPrompt,
  DEFAULT_WATCHER_PROMPT,
  DEFAULT_LOCATOR_PROMPT,
  DEFAULT_REPRODUCER_PROMPT,
  DEFAULT_VERIFIER_PROMPT,
  DEFAULT_FIXER_PROMPT,
  DEFAULT_REPORTER_PROMPT,
} from './index.js';

test('prompt loaders return non-empty strings with version headers', () => {
  const watcher = loadWatcherPrompt();
  const locator = loadLocatorPrompt();
  const reproducer = loadReproducerPrompt();
  const verifier = loadVerifierPrompt();
  const fixer = loadFixerPrompt();
  const reporter = loadReporterPrompt();

  assert.ok(watcher.includes('# Watcher — v1'));
  assert.ok(locator.includes('# Locator — v1'));
  assert.ok(reproducer.includes('# Reproducer — v1'));
  assert.ok(verifier.includes('# Verifier — v1'));
  assert.ok(fixer.includes('# Fixer — v1'));
  assert.ok(reporter.includes('# Reporter — v1'));
});

test('embedded prompt constants are fully formed and match schema expectations', () => {
  assert.ok(DEFAULT_WATCHER_PROMPT.includes('defect_found'));
  assert.ok(DEFAULT_LOCATOR_PROMPT.includes('suspects'));
  assert.ok(DEFAULT_REPRODUCER_PROMPT.includes('test_code'));
  assert.ok(DEFAULT_VERIFIER_PROMPT.includes('GENUINE_REPRODUCTION'));
  assert.ok(DEFAULT_FIXER_PROMPT.includes('patch'));
  assert.ok(DEFAULT_REPORTER_PROMPT.includes('executive_summary'));
});

test('prompt loading survives execution when cwd is outside the repo without errors', () => {
  const origCwd = process.cwd();
  try {
    process.chdir('/tmp');
    assert.doesNotThrow(() => {
      const w = loadWatcherPrompt();
      const l = loadLocatorPrompt();
      const r = loadReproducerPrompt();
      const v = loadVerifierPrompt();
      const f = loadFixerPrompt();
      const rep = loadReporterPrompt();
      assert.ok(w.length > 100);
      assert.ok(l.length > 100);
      assert.ok(r.length > 100);
      assert.ok(v.length > 100);
      assert.ok(f.length > 100);
      assert.ok(rep.length > 100);
    });
  } finally {
    process.chdir(origCwd);
  }
});
