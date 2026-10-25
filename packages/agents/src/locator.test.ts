import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  locateSuspects,
  loadLocatorPrompt,
  buildLocatorMessages,
  fixtureToBugReport,
  SampleFixture,
} from './locator.js';
import { RepoBundle, formatNumberedLines } from './packer.js';
import { LlmClient } from './llm.js';
import { BugReport } from '@replay/shared';

interface CallRecord {
  model: string;
  messages: unknown[];
}

type FakeClient = Pick<LlmClient, 'callJson'> & { calls: CallRecord[] };

function fakeClient(rawModelOutput: string | (() => string)): FakeClient {
  const calls: CallRecord[] = [];
  const fake = {
    calls,
    callJson: async (
      model: string,
      messages: unknown[],
      schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { issues?: Array<{ message: string }>; message: string } } }
    ) => {
      calls.push({ model, messages });
      const raw = typeof rawModelOutput === 'function' ? rawModelOutput() : rawModelOutput;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        throw new Error(`Invalid JSON syntax: ${(e as Error).message}`);
      }
      const validated = schema.safeParse(parsed);
      if (!validated.success) {
        const msg = validated.error?.issues?.map(i => i.message).join('; ') || validated.error?.message || 'invalid';
        throw new Error(`Schema validation failed: ${msg}`);
      }
      return {
        data: validated.data,
        rawText: raw,
        metrics: { promptTokens: 120, completionTokens: 45, totalTokens: 165, durationMs: 85, model },
      };
    },
  };
  return fake as unknown as FakeClient;
}

function throwingClient(message: string): FakeClient {
  return {
    calls: [],
    callJson: async () => {
      throw new Error(message);
    },
  } as unknown as FakeClient;
}

function makeTestBundle(): RepoBundle {
  const appContent = [
    'import React from "react";',
    'export function App() {',
    '  const handleQuantityChange = (productId: string, rawValue: string) => {',
    '    const qty = parseInt(rawValue, 10);',
    '    return qty;',
    '  };',
    '  return <input data-testid="cart-item-qty" />;',
    '}',
  ].join('\n');
  const { numberedContent, lineCount } = formatNumberedLines(appContent);
  return {
    repoRoot: '/tmp/fake-repo',
    files: [
      {
        path: 'src/App.tsx',
        content: appContent,
        numberedContent,
        lineCount,
        byteSize: Buffer.byteLength(appContent),
        truncated: false,
        redactedCount: 0,
      },
    ],
    skippedFiles: [],
    bundleText: `=== FILE: src/App.tsx (lines 1-${lineCount}) ===\n${numberedContent}`,
    metadata: {
      includedFileCount: 1,
      skippedFileCount: 0,
      truncatedFileCount: 0,
      redactedSecretCount: 0,
      totalChars: numberedContent.length,
      estimatedTokens: Math.ceil(numberedContent.length / 4),
    },
  };
}

const SAMPLE_BUG_REPORT: BugReport = {
  defect_found: true,
  summary: 'Cart total becomes NaN after clearing quantity field',
  steps: [{ timestamp_s: 8.0, description: 'User clears quantity input field' }],
  first_failure_timestamp_s: 8.0,
  expected_behavior: 'Clearing quantity treats value as 0 and keeps numeric total',
  actual_behavior: 'Cart total displays $NaN',
  visible_text: ['$NaN'],
  route: '/#cart',
  confidence: 0.95,
};

test('valid LocatorOutput with grounded file, line range, and source evidence passes', async () => {
  const validPayload = JSON.stringify({
    suspects: [
      {
        file: 'src/App.tsx',
        start_line: 3,
        end_line: 6,
        symbol: 'handleQuantityChange',
        confidence: 0.92,
        symptom_link:
          'Direct source evidence shows parseInt(rawValue, 10) without NaN fallback; hypothesis: empty input produces NaN.',
        evidence: 'const qty = parseInt(rawValue, 10);',
      },
    ],
    suggested_test_selectors: ['cart-item-qty'],
    route: '/#cart',
  });
  const fc = fakeClient(validPayload);
  const res = await locateSuspects({ bugReport: SAMPLE_BUG_REPORT, bundle: makeTestBundle() }, { client: fc });
  assert.equal(res.output.suspects.length, 1);
  assert.equal(res.output.suspects[0]?.file, 'src/App.tsx');
  assert.equal(res.output.suspects[0]?.symbol, 'handleQuantityChange');
  assert.equal(res.promptVersion, 'v1');
  assert.equal(res.metrics.totalTokens, 165);
});

test('rejects candidate path not present in the packed bundle', async () => {
  const badPathPayload = JSON.stringify({
    suspects: [
      {
        file: 'src/NonExistent.tsx',
        start_line: 1,
        end_line: 3,
        symbol: 'missingFn',
        confidence: 0.8,
        symptom_link: 'Hypothesis only',
        evidence: 'const qty = parseInt(rawValue, 10);',
      },
    ],
    suggested_test_selectors: [],
    route: '/#cart',
  });
  const fc = fakeClient(badPathPayload);
  await assert.rejects(
    locateSuspects({ bugReport: SAMPLE_BUG_REPORT, bundle: makeTestBundle() }, { client: fc }),
    /does not exist in packed repository bundle/
  );
});

test('rejects invalid line ranges (out of bounds or start_line > end_line)', async () => {
  const outOfBoundsPayload = JSON.stringify({
    suspects: [
      {
        file: 'src/App.tsx',
        start_line: 3,
        end_line: 99,
        symbol: 'handleQuantityChange',
        confidence: 0.8,
        symptom_link: 'Hypothesis only',
        evidence: 'const qty = parseInt(rawValue, 10);',
      },
    ],
    suggested_test_selectors: [],
    route: '/#cart',
  });
  const fc1 = fakeClient(outOfBoundsPayload);
  await assert.rejects(
    locateSuspects({ bugReport: SAMPLE_BUG_REPORT, bundle: makeTestBundle() }, { client: fc1 }),
    /Invalid line range 3-99/
  );

  const invertedRangePayload = JSON.stringify({
    suspects: [
      {
        file: 'src/App.tsx',
        start_line: 6,
        end_line: 3,
        symbol: 'handleQuantityChange',
        confidence: 0.8,
        symptom_link: 'Hypothesis only',
        evidence: 'const qty = parseInt(rawValue, 10);',
      },
    ],
    suggested_test_selectors: [],
    route: '/#cart',
  });
  const fc2 = fakeClient(invertedRangePayload);
  await assert.rejects(
    locateSuspects({ bugReport: SAMPLE_BUG_REPORT, bundle: makeTestBundle() }, { client: fc2 }),
    /Invalid line range 6-3/
  );
});

test('rejects suspect whose evidence does not match actual source content in the line range', async () => {
  const badEvidencePayload = JSON.stringify({
    suspects: [
      {
        file: 'src/App.tsx',
        start_line: 3,
        end_line: 6,
        symbol: 'handleQuantityChange',
        confidence: 0.85,
        symptom_link: 'Fabricated quote',
        evidence: 'const fabricated = Number.NaN;',
      },
    ],
    suggested_test_selectors: [],
    route: '/#cart',
  });
  const fc = fakeClient(badEvidencePayload);
  await assert.rejects(
    locateSuspects({ bugReport: SAMPLE_BUG_REPORT, bundle: makeTestBundle() }, { client: fc }),
    /does not match source content/
  );
});

test('handles ambiguous reports with low confidence and missing relevant source code (empty suspects)', async () => {
  const emptySuspectsPayload = JSON.stringify({
    suspects: [],
    suggested_test_selectors: [],
    route: null,
  });
  const fcEmpty = fakeClient(emptySuspectsPayload);
  const resEmpty = await locateSuspects({ bugReport: SAMPLE_BUG_REPORT, bundle: makeTestBundle() }, { client: fcEmpty });
  assert.deepEqual(resEmpty.output.suspects, []);

  const uncertainPayload = JSON.stringify({
    suspects: [
      {
        file: 'src/App.tsx',
        start_line: 2,
        end_line: 7,
        symbol: 'App',
        confidence: 0.25,
        symptom_link: 'Uncertain: only partial UI input element is visible in packed source.',
        evidence: 'export function App() {',
      },
    ],
    suggested_test_selectors: ['cart-item-qty'],
    route: null,
  });
  const fcUncertain = fakeClient(uncertainPayload);
  const resUncertain = await locateSuspects(
    { bugReport: SAMPLE_BUG_REPORT, bundle: makeTestBundle() },
    { client: fcUncertain }
  );
  assert.equal(resUncertain.output.suspects[0]?.confidence, 0.25);
});

test('enforces bounded candidate count (max 5 suspects)', async () => {
  const item = {
    file: 'src/App.tsx',
    start_line: 3,
    end_line: 6,
    symbol: 'handleQuantityChange',
    confidence: 0.5,
    symptom_link: 'Candidate',
    evidence: 'const qty = parseInt(rawValue, 10);',
  };
  const tooManyPayload = JSON.stringify({
    suspects: [item, item, item, item, item, item],
    suggested_test_selectors: [],
    route: null,
  });
  const fc = fakeClient(tooManyPayload);
  await assert.rejects(
    locateSuspects({ bugReport: SAMPLE_BUG_REPORT, bundle: makeTestBundle() }, { client: fc }),
    /Schema validation failed/
  );
});

test('rejects malformed JSON and schema-incomplete outputs', async () => {
  const fcMalformed = fakeClient('not valid json {');
  await assert.rejects(
    locateSuspects({ bugReport: SAMPLE_BUG_REPORT, bundle: makeTestBundle() }, { client: fcMalformed }),
    /Invalid JSON/
  );

  const fcIncomplete = fakeClient(JSON.stringify({ suspects: [{ file: 'src/App.tsx' }] }));
  await assert.rejects(
    locateSuspects({ bugReport: SAMPLE_BUG_REPORT, bundle: makeTestBundle() }, { client: fcIncomplete }),
    /Schema validation failed/
  );
});

test('propagates provider auth failures (401/403) and rate limits (429/503)', async () => {
  const fc403 = throwingClient('HTTP 403: Forbidden');
  await assert.rejects(
    locateSuspects({ bugReport: SAMPLE_BUG_REPORT, bundle: makeTestBundle() }, { client: fc403 }),
    /403/
  );

  const fc429 = throwingClient('HTTP 429: Too Many Requests');
  await assert.rejects(
    locateSuspects({ bugReport: SAMPLE_BUG_REPORT, bundle: makeTestBundle() }, { client: fc429 }),
    /429/
  );
});

test('buildLocatorMessages and loadLocatorPrompt construct deterministic prompt and payload', () => {
  const prompt = loadLocatorPrompt();
  assert.ok(prompt.includes('Locator — v1'));
  assert.ok(prompt.includes('suspects'));
  assert.ok(prompt.includes('evidence'));
  assert.ok(prompt.includes('Never invent file paths'));

  const msgs = buildLocatorMessages({
    bugReport: SAMPLE_BUG_REPORT,
    bundle: makeTestBundle(),
    note: 'Triggered when backspacing quantity',
    route: '/?bug=cart-nan',
  });
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0]?.role, 'system');
  assert.equal(msgs[1]?.role, 'user');
  const userContent = String(msgs[1]?.content);
  assert.ok(userContent.includes('Reporter note: Triggered when backspacing quantity'));
  assert.ok(userContent.includes('Known target route: /?bug=cart-nan'));
  assert.ok(userContent.includes('=== BUG REPORT ==='));
  assert.ok(userContent.includes('=== FILE: src/App.tsx (lines 1-8) ==='));
});

test('fixtureToBugReport maps symptom fields and never leaks guilty_file or guilty_symbol', () => {
  const fixture: SampleFixture = {
    id: 'cart-nan',
    title: 'Cart total becomes NaN after clearing quantity field',
    failure_timestamp_s: 8.0,
    guilty_file: 'src/App.tsx',
    guilty_symbol: 'handleQuantityChange',
    expected_behavior: 'Clearing quantity keeps total numeric.',
    observed_behavior: 'Cart total displays $NaN.',
    route: '/#cart',
  };
  const report = fixtureToBugReport(fixture);
  const serialized = JSON.stringify(report);
  assert.equal(report.defect_found, true);
  assert.equal(report.summary, fixture.title);
  assert.equal(report.first_failure_timestamp_s, 8.0);
  assert.equal(report.expected_behavior, fixture.expected_behavior);
  assert.equal(report.actual_behavior, fixture.observed_behavior);
  assert.ok(!serialized.includes('src/App.tsx'), 'must not leak guilty_file into BugReport');
  assert.ok(!serialized.includes('handleQuantityChange'), 'must not leak guilty_symbol into BugReport');
});
