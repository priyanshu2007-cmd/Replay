import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeBugVideo, loadWatcherPrompt, MAX_FRAMES_PER_REQUEST, WatcherFrame } from './watcher.js';
import { LlmClient } from './llm.js';

interface CallRecord {
  model: string;
  messages: unknown[];
}

type FakeClient = Pick<LlmClient, 'callJson'> & { calls: CallRecord[] };

/**
 * Fake callJson client: parses and Zod-validates like the real one's happy
 * path, so watcher wiring (prompt, message shape, schema) is exercised
 * offline. Provider behavior (retry, network) is NOT under test here.
 */
function fakeClient(rawModelOutput: string | (() => string)): FakeClient {
  const calls: CallRecord[] = [];
  const fake = {
    calls,
    callJson: async (
      model: string,
      messages: unknown[],
      schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { message: string } } }
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
        throw new Error(`Schema validation failed: ${validated.error?.message ?? 'invalid'}`);
      }
      return {
        data: validated.data,
        rawText: raw,
        metrics: { promptTokens: 10, completionTokens: 5, totalTokens: 15, durationMs: 42, model },
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

const VALID_REPORT = JSON.stringify({
  defect_found: true,
  summary: 'Cart total shows $NaN after the quantity field is cleared',
  steps: [{ timestamp_s: 7.0, description: 'User clears the quantity field', visible_text: '' }],
  first_failure_timestamp_s: 8.0,
  expected_behavior: 'Total stays a valid number',
  actual_behavior: 'Total displays $NaN',
  visible_text: ['$NaN'],
  route: '/',
  confidence: 0.9,
});

const NO_DEFECT_REPORT = JSON.stringify({
  defect_found: false,
  summary: 'No defect visible; interactions appear to behave normally',
  steps: [{ timestamp_s: 2.0, description: 'User browses products', visible_text: 'Demo Gear Shop' }],
  first_failure_timestamp_s: 0,
  expected_behavior: 'No defect established from the frames',
  actual_behavior: 'No defect established from the frames',
  visible_text: [],
  route: null,
  confidence: 0.2,
});

function frames(n = 3): WatcherFrame[] {
  return Array.from({ length: n }, (_, i) => ({ timestampS: i * 0.5, jpegBase64: `aGVsbG8=${i}` }));
}

type ContentPart = { type: string; text?: string; image_url?: { url: string } };

function firstCall(fc: FakeClient): CallRecord {
  const call = fc.calls[0];
  assert.ok(call, 'expected at least one model call');
  return call;
}

function userContentOf(call: CallRecord): ContentPart[] {
  const userMsg = call.messages.find(m => (m as { role: string }).role === 'user') as { content: ContentPart[] };
  return userMsg.content;
}

test('valid BugReport parses and passes through with metrics', async () => {
  const fc = fakeClient(VALID_REPORT);
  const result = await analyzeBugVideo({ frames: frames(), note: 'broke when clearing qty' }, { client: fc });
  assert.equal(result.report.defect_found, true);
  assert.equal(result.report.first_failure_timestamp_s, 8.0);
  assert.equal(result.metrics.totalTokens, 15);
  assert.equal(result.promptVersion, 'v1');
});

test('frames are labeled with ascending timestamps and sent as JPEG data URLs', async () => {
  const fc = fakeClient(VALID_REPORT);
  await analyzeBugVideo(
    { frames: [{ timestampS: 2.0, jpegBase64: 'QUE=' }, { timestampS: 0.0, jpegBase64: 'QUI=' }] },
    { client: fc }
  );
  const parts = userContentOf(firstCall(fc));
  const labels = parts.filter(p => p.type === 'text' && p.text?.startsWith('t=')).map(p => p.text);
  assert.deepEqual(labels, ['t=0.0s', 't=2.0s']); // input was out of order — sorted chronologically
  const images = parts.filter(p => p.type === 'image_url');
  assert.equal(images.length, 2);
  assert.ok(images.every(i => i.image_url?.url.startsWith('data:image/jpeg;base64,')));
  assert.ok(images.every(i => !i.image_url?.url.startsWith('/'))); // no filesystem paths passed as URLs
});

test('reporter note and route are included as text parts', async () => {
  const fc = fakeClient(VALID_REPORT);
  await analyzeBugVideo({ frames: frames(), note: 'note-here', route: '/?bug=cart-nan' }, { client: fc });
  const texts = userContentOf(firstCall(fc)).filter(p => p.type === 'text').map(p => p.text);
  assert.ok(texts.some(t => t === 'Reporter note: note-here'));
  assert.ok(texts.some(t => t === 'Known target route: /?bug=cart-nan'));
});

test('explicit no-defect result is a successful return, not an error', async () => {
  const fc = fakeClient(NO_DEFECT_REPORT);
  const result = await analyzeBugVideo({ frames: frames() }, { client: fc });
  assert.equal(result.report.defect_found, false);
  assert.equal(result.report.confidence, 0.2);
});

test('malformed JSON from the model is rejected', async () => {
  const fc = fakeClient('{not json at all');
  await assert.rejects(analyzeBugVideo({ frames: frames() }, { client: fc }), /Invalid JSON/);
});

test('schema-invalid model output is rejected (missing required fields)', async () => {
  const fc = fakeClient(JSON.stringify({ summary: 'no required fields' }));
  await assert.rejects(analyzeBugVideo({ frames: frames() }, { client: fc }), /Schema validation/);
});

test('empty frame list fails before any model call', async () => {
  const fc = fakeClient(VALID_REPORT);
  await assert.rejects(analyzeBugVideo({ frames: [] }, { client: fc }), /at least one frame/);
  assert.equal(fc.calls.length, 0);
});

test('frame budget is enforced', async () => {
  const fc = fakeClient(VALID_REPORT);
  const tooMany = Array.from({ length: MAX_FRAMES_PER_REQUEST + 1 }, (_, i) => ({ timestampS: i * 0.5, jpegBase64: 'eHg=' }));
  await assert.rejects(analyzeBugVideo({ frames: tooMany }, { client: fc }), /Too many frames/);
});

test('provider auth failure (403) propagates', async () => {
  const fc = throwingClient('HTTP 403: 403 status code (no body)');
  await assert.rejects(analyzeBugVideo({ frames: frames() }, { client: fc }), /403/);
});

test('provider rate limit (429/503) propagates', async () => {
  const fc = throwingClient('HTTP 503: ResourceExhausted');
  await assert.rejects(analyzeBugVideo({ frames: frames() }, { client: fc }), /503/);
});

test('versioned prompt file loads and carries the exact contract', () => {
  const prompt = loadWatcherPrompt();
  assert.ok(prompt.length > 200);
  assert.ok(prompt.includes('Return ONLY JSON') || prompt.includes('Return only JSON'));
  for (const field of [
    'defect_found',
    'first_failure_timestamp_s',
    'expected_behavior',
    'actual_behavior',
    'timestamp_s',
    'visible_text',
    'route',
    'confidence',
  ]) {
    assert.ok(prompt.includes(field), `prompt must mention ${field}`);
  }
  assert.ok(prompt.includes('Never guess at code'));
});

test('all 5 sample recordings exist, have valid WebM headers, and map 1:1 to expected.json fixtures', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const samplesDir = path.join(root, 'samples');
  const videosDir = path.join(samplesDir, 'videos');
  const expectedIds = ['cart-nan', 'double-discount', 'empty-email', 'quantity-reset', 'string-sort'];

  const videoFiles = fs.readdirSync(videosDir).filter(f => f.endsWith('.webm')).sort();
  assert.deepEqual(videoFiles, expectedIds.map(id => `${id}.webm`));

  for (const id of expectedIds) {
    const videoPath = path.join(videosDir, `${id}.webm`);
    const stat = fs.statSync(videoPath);
    assert.ok(stat.size > 10_000, `${id}.webm should be non-empty`);
    const header = Buffer.alloc(4);
    const fd = fs.openSync(videoPath, 'r');
    fs.readSync(fd, header, 0, 4, 0);
    fs.closeSync(fd);
    assert.equal(header.toString('hex'), '1a45dfa3', `${id}.webm must have EBML/WebM magic header`);

    const fixturePath = path.join(samplesDir, id, 'expected.json');
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
      id: string;
      failure_timestamp_s: number;
      guilty_file: string;
      expected_behavior: string;
      observed_behavior: string;
    };
    assert.equal(fixture.id, id);
    assert.ok(typeof fixture.failure_timestamp_s === 'number' && fixture.failure_timestamp_s > 0);
    assert.ok(fixture.expected_behavior.length > 0);
    assert.ok(fixture.observed_behavior.length > 0);
  }
});
