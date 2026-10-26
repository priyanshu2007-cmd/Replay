import { test, describe, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './server.js';
import { MemoryRunRepository } from './runs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');

describe('Replay API Server', () => {
  let repo: MemoryRunRepository;
  let app: ReturnType<typeof createServer>;

  beforeEach(() => {
    repo = new MemoryRunRepository();
    app = createServer({ repository: repo, repoRoot: REPO_ROOT });
  });

  describe('Health endpoints', () => {
    test('GET /health returns healthy status and available samples', async () => {
      const res = await app.request('/health');
      assert.equal(res.status, 200);

      const body: any = await res.json();
      assert.equal(body.status, 'ok');
      assert.equal(body.service, 'replay-api');
      assert.ok(Array.isArray(body.availableSamples));
      assert.ok(body.availableSamples.includes('cart-nan'));
      assert.ok(body.availableSamples.includes('double-discount'));
    });

    test('GET /api/health behaves identically to /health', async () => {
      const res = await app.request('/api/health');
      assert.equal(res.status, 200);

      const body: any = await res.json();
      assert.equal(body.status, 'ok');
      assert.equal(body.services.api, 'healthy');
    });
  });

  describe('Samples endpoint', () => {
    test('GET /api/samples returns 5 planted bug samples with metadata', async () => {
      const res = await app.request('/api/samples');
      assert.equal(res.status, 200);

      const body: any = await res.json();
      assert.ok(Array.isArray(body.samples));
      assert.equal(body.samples.length, 5);

      const cartNan = body.samples.find((s: any) => s.id === 'cart-nan');
      assert.ok(cartNan, 'cart-nan sample should exist');
      assert.ok(cartNan.title.includes('NaN'));
      assert.equal(cartNan.guiltyFile, 'src/App.tsx');
      assert.equal(cartNan.recordingAvailable, true);
    });
  });

  describe('Run creation via JSON', () => {
    test('POST /api/runs with valid sampleId creates queued run', async () => {
      const res = await app.request('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sampleId: 'cart-nan',
          note: 'Evaluating cart total NaN bug',
        }),
      });

      assert.equal(res.status, 201);
      const data: any = await res.json();

      assert.ok(data.id);
      assert.equal(data.state, 'queued');
      assert.equal(data.stage, 'ingest');
      assert.equal(data.isSample, true);
      assert.equal(data.videoKey, 'cart-nan');
      assert.equal(data.note, 'Evaluating cart total NaN bug');

      // Verify stored in repository
      const stored = await repo.getRun(data.id);
      assert.ok(stored);
      assert.equal(stored.state, 'queued');

      // Verify run_created event was emitted
      const events = await repo.getEvents(data.id);
      assert.equal(events.length, 1);
      assert.equal(events[0]?.event_type, 'run_created');
      assert.equal(events[0]?.stage, 'ingest');
    });

    test('POST /api/runs with invalid sampleId returns 400', async () => {
      const res = await app.request('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sampleId: 'unknown-sample-id',
        }),
      });

      assert.equal(res.status, 400);
      const data: any = await res.json();
      assert.equal(data.error, 'Invalid sample ID');
      assert.ok(data.message.includes('Must be one of'));
    });

    test('POST /api/runs with missing sampleId returns 400', async () => {
      const res = await app.request('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          note: 'No sample specified',
        }),
      });

      assert.equal(res.status, 400);
      const data: any = await res.json();
      assert.equal(data.error, 'Missing sample ID or file');
    });

    test('POST /api/runs with malformed JSON returns 400', async () => {
      const res = await app.request('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{ malformed json',
      });

      assert.equal(res.status, 400);
      const data: any = await res.json();
      assert.equal(data.error, 'Invalid JSON');
    });
  });

  describe('Run creation via Multipart Video Upload', () => {
    test('POST /api/runs with valid webm upload creates queued run', async () => {
      const formData = new FormData();
      const dummyVideo = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81])], {
        type: 'video/webm',
      });
      formData.append('file', dummyVideo, 'bug_recording.webm');
      formData.append('note', 'Uploaded customer recording');

      const res = await app.request('/api/runs', {
        method: 'POST',
        body: formData,
      });

      assert.equal(res.status, 201);
      const data: any = await res.json();

      assert.ok(data.id);
      assert.equal(data.state, 'queued');
      assert.equal(data.isSample, false);
      // Privacy contract: uploads return an opaque key and no reporter note.
      assert.equal(data.videoKey, 'upload');
      assert.equal(data.note, undefined);

      // The API must not reveal where the file lives; the stored path stays
      // server-side (the response carried the opaque 'upload' key above).
    });

    test('POST /api/runs rejects unsupported file mime type with 415', async () => {
      const formData = new FormData();
      const textFile = new Blob(['console.log("hello");'], { type: 'text/javascript' });
      formData.append('file', textFile, 'exploit.js');

      const res = await app.request('/api/runs', {
        method: 'POST',
        body: formData,
      });

      assert.equal(res.status, 415);
      const data: any = await res.json();
      assert.equal(data.error, 'Unsupported media type');
    });

    test('POST /api/runs with multipart sampleId works directly', async () => {
      const formData = new FormData();
      formData.append('sampleId', 'double-discount');
      formData.append('note', 'Uploaded via form with sample selection');

      const res = await app.request('/api/runs', {
        method: 'POST',
        body: formData,
      });

      assert.equal(res.status, 201);
      const data: any = await res.json();
      assert.equal(data.isSample, true);
      assert.equal(data.videoKey, 'double-discount');
    });
  });

  describe('Run Listing and Retrieval', () => {
    test('GET /api/runs lists only sample runs, without notes', async () => {
      await repo.createRun({ videoKey: 'cart-nan', note: 'First', isSample: true });
      await repo.createRun({ videoKey: 'double-discount', note: 'Second', isSample: true });
      await repo.createRun({ videoKey: '/abs/path/upload.webm', note: 'Private upload', isSample: false });

      const res = await app.request('/api/runs');
      assert.equal(res.status, 200);

      const data: any = await res.json();
      assert.equal(data.total, 2, 'non-sample runs must not be listed');
      assert.equal(data.runs[0].note, undefined, 'notes must not appear in public listings');
      assert.ok(!JSON.stringify(data).includes('/abs/path'), 'absolute paths must never leak');
    });

    test('GET /api/runs/:id retrieves run details and outputs', async () => {
      const run = await repo.createRun({
        videoKey: 'cart-nan',
        note: 'Inspect outputs',
        isSample: true,
      });

      await repo.updateRun(run.id, {
        state: 'fixed',
        stage: 'report',
        diff: '--- a/src/App.tsx\n+++ b/src/App.tsx',
        durationMs: 42000,
        completedAt: new Date(),
      });

      const res = await app.request(`/api/runs/${run.id}`);
      assert.equal(res.status, 200);

      const data: any = await res.json();
      assert.equal(data.id, run.id);
      assert.equal(data.state, 'fixed');
      assert.equal(data.stage, 'report');
      assert.equal(data.outputs.diff, '--- a/src/App.tsx\n+++ b/src/App.tsx');
      assert.equal(data.metrics.durationMs, 42000);
    });

    test('GET /api/runs/:id returns 404 for unknown run ID', async () => {
      const res = await app.request('/api/runs/00000000-0000-0000-0000-000000000000');
      assert.equal(res.status, 404);

      const data: any = await res.json();
      assert.equal(data.error, 'Run not found');
    });
  });

  describe('Server-Sent Events (SSE) Stream', () => {
    test('GET /api/runs/:id/events returns 404 for unknown run ID', async () => {
      const res = await app.request('/api/runs/00000000-0000-0000-0000-000000000000/events');
      assert.equal(res.status, 404);
    });

    test('GET /api/runs/:id/events streams historical and terminal events', async () => {
      const run = await repo.createRun({ videoKey: 'cart-nan', isSample: true });

      // Add two historical events
      await repo.addEvent(run.id, {
        stage: 'ingest',
        agent: 'API',
        event_type: 'run_created',
        payload: { sampleId: 'cart-nan' },
      });

      await repo.addEvent(run.id, {
        stage: 'locate',
        agent: 'Locator',
        event_type: 'suspects_found',
        payload: { count: 3 },
      });

      // Mark run terminal
      await repo.updateRun(run.id, { state: 'fixed' });

      const res = await app.request(`/api/runs/${run.id}/events`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/event-stream');

      const bodyText = await res.text();
      assert.ok(bodyText.includes('event: run_created'));
      assert.ok(bodyText.includes('event: suspects_found'));
      assert.ok(bodyText.includes('event: stream_closed'));
    });
  });

  describe('rate limiting', () => {
    test('POST /api/runs returns 429 after the configured limit', async () => {
      const limited = createServer({ repository: repo, repoRoot: REPO_ROOT, runRateLimit: 2 });
      for (let i = 0; i < 2; i++) {
        const res = await limited.request('/api/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sampleId: 'cart-nan' }),
        });
        assert.equal(res.status, 201);
      }
      const blocked = await limited.request('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sampleId: 'cart-nan' }),
      });
      assert.equal(blocked.status, 429);
      const body = (await blocked.json()) as { error: string };
      assert.equal(body.error, 'Rate limit exceeded');
    });
  });
});
