import { test, describe, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { clientIp, createServer } from './server.js';
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

    test('rate limiting is shared across API instances and persisted repositories', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-ratelimit-'));
      const persistPath = path.join(tmpDir, 'runs.json');
      try {
        const repoA = new MemoryRunRepository({ persistPath });
        const repoB = new MemoryRunRepository({ persistPath });
        const appA = createServer({ repository: repoA, repoRoot: REPO_ROOT, runRateLimit: 2 });
        const appB = createServer({ repository: repoB, repoRoot: REPO_ROOT, runRateLimit: 2 });

        const r1 = await appA.request('/api/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sampleId: 'cart-nan' }),
        });
        assert.equal(r1.status, 201);

        const r2 = await appB.request('/api/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sampleId: 'double-discount' }),
        });
        assert.equal(r2.status, 201);

        // 3rd request on either instance must be blocked by the shared store
        const r3 = await appA.request('/api/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sampleId: 'string-sort' }),
        });
        assert.equal(r3.status, 429);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test('rate limit store failure fails closed with 503 on run creation', async () => {
      const brokenRepo = new MemoryRunRepository();
      brokenRepo.checkRateLimit = async () => {
        throw new Error('database connection lost');
      };
      const brokenApp = createServer({ repository: brokenRepo, repoRoot: REPO_ROOT, runRateLimit: 5 });
      const res = await brokenApp.request('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sampleId: 'cart-nan' }),
      });
      assert.equal(res.status, 503);
      const body: any = await res.json();
      assert.equal(body.error, 'Service unavailable');
    });

    test('clientIp resolves real client IP through trusted proxy and blocks spoofing on direct connections', () => {
      const prevTrust = process.env.TRUST_PROXY;
      const prevProxies = process.env.TRUSTED_PROXY_IPS;
      try {
        process.env.TRUST_PROXY = '1';
        delete process.env.TRUSTED_PROXY_IPS;

        // 1. Trusted Docker/Caddy proxy (172.18.0.2) with spoofed first hop + real client hop
        const trustedCtx = {
          env: { incoming: { socket: { remoteAddress: '::ffff:172.18.0.2' } } },
          req: {
            header: (n: string) =>
              n.toLowerCase() === 'x-forwarded-for' ? '1.1.1.1, 203.0.113.45' : undefined,
          },
        };
        assert.equal(clientIp(trustedCtx), '203.0.113.45');

        // 2. Direct untrusted peer (198.51.100.99) spoofing X-Forwarded-For and X-Real-IP
        const untrustedCtx = {
          env: { incoming: { socket: { remoteAddress: '198.51.100.99' } } },
          req: {
            header: (n: string) => {
              if (n.toLowerCase() === 'x-forwarded-for') return '10.0.0.1, 203.0.113.1';
              if (n.toLowerCase() === 'x-real-ip') return '203.0.113.2';
              return undefined;
            },
          },
        };
        assert.equal(clientIp(untrustedCtx), '198.51.100.99');

        // 3. IPv6 client and fd00::/8 ULA proxy support
        const ipv6Ctx = {
          env: { incoming: { socket: { remoteAddress: 'fd00::10' } } },
          req: {
            header: (n: string) =>
              n.toLowerCase() === 'x-forwarded-for' ? '[2001:DB8::ABCD]:443' : undefined,
          },
        };
        assert.equal(clientIp(ipv6Ctx), '2001:db8::abcd');

        // 4. Malformed X-Forwarded-For falls back to valid X-Real-IP or socket address
        const malformedCtx = {
          env: { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
          req: {
            header: (n: string) => {
              if (n.toLowerCase() === 'x-forwarded-for') return '203.0.113.5, garbage-not-an-ip';
              if (n.toLowerCase() === 'x-real-ip') return '203.0.113.88';
              return undefined;
            },
          },
        };
        assert.equal(clientIp(malformedCtx), '203.0.113.88');

        // 5. TRUST_PROXY=0 ignores forwarded headers even from localhost
        process.env.TRUST_PROXY = '0';
        assert.equal(clientIp(trustedCtx), '172.18.0.2');
      } finally {
        if (prevTrust === undefined) delete process.env.TRUST_PROXY;
        else process.env.TRUST_PROXY = prevTrust;
        if (prevProxies === undefined) delete process.env.TRUSTED_PROXY_IPS;
        else process.env.TRUSTED_PROXY_IPS = prevProxies;
      }
    });
  });

  describe('Upload validation and cleanup', () => {
    test('POST /api/runs rejects zero-byte upload with 400', async () => {
      const formData = new FormData();
      const emptyBlob = new Blob([], { type: 'video/webm' });
      formData.append('file', emptyBlob, 'empty.webm');

      const res = await app.request('/api/runs', {
        method: 'POST',
        body: formData,
      });
      assert.equal(res.status, 400);
      const body: any = await res.json();
      assert.equal(body.error, 'Empty file');
    });

    test('POST /api/runs cleans up uploaded file on disk if repository createRun throws', async () => {
      const failingRepo = new MemoryRunRepository();
      failingRepo.createRun = async () => {
        throw new Error('DB insert failed');
      };
      const failingApp = createServer({ repository: failingRepo, repoRoot: REPO_ROOT });
      const uploadDir = path.resolve(REPO_ROOT, 'artifacts/uploads');
      const beforeFiles = fs.existsSync(uploadDir) ? new Set(fs.readdirSync(uploadDir)) : new Set<string>();

      const formData = new FormData();
      const validWebm = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04])], {
        type: 'video/webm',
      });
      formData.append('file', validWebm, 'cleanup-test.webm');

      const res = await failingApp.request('/api/runs', {
        method: 'POST',
        body: formData,
      });
      assert.equal(res.status, 500);

      const afterFiles = fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir) : [];
      const leaked = afterFiles.filter((f) => !beforeFiles.has(f));
      assert.deepEqual(leaked, [], 'Failed upload run creation must not leave orphan files on disk');
    });
  });

  describe('SSE connection caps, reconnects, and cross-process live events', () => {
    test('400 and 404 responses on /api/runs/:id/events do not consume SSE connection slots', async () => {
      for (let i = 0; i < 10; i++) {
        const r400 = await app.request('/api/runs/not-a-uuid/events');
        assert.equal(r400.status, 400);
        const r404 = await app.request('/api/runs/00000000-0000-0000-0000-000000000000/events');
        assert.equal(r404.status, 404);
      }

      const run = await repo.createRun({ videoKey: 'cart-nan', isSample: true });
      await repo.updateRun(run.id, { state: 'fixed' });
      const okRes = await app.request(`/api/runs/${run.id}/events`);
      assert.equal(okRes.status, 200);
      await okRes.text();
    });

    test('Last-Event-ID header resumes SSE stream without duplicate or skipped events', async () => {
      const run = await repo.createRun({ videoKey: 'cart-nan', isSample: true });
      await repo.addEvent(run.id, {
        stage: 'ingest',
        agent: 'API',
        event_type: 'run_created',
        payload: { step: 1 },
      });
      await repo.addEvent(run.id, {
        stage: 'watch',
        agent: 'Watcher',
        event_type: 'watch_completed',
        payload: { step: 2 },
      });
      await repo.updateRun(run.id, { state: 'fixed' });

      const res = await app.request(`/api/runs/${run.id}/events`, {
        headers: { 'Last-Event-ID': '1' },
      });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(!text.includes('event: run_created'), 'seq 1 should not be resent when Last-Event-ID is 1');
      assert.ok(text.includes('event: watch_completed'), 'seq 2 must be sent');
      assert.ok(text.includes('event: stream_closed'));
    });

    test('real separate child worker process emits live events received over SSE in order and closes stream on completion', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-crossproc-sse-'));
      const persistPath = path.join(tmpDir, 'runs.json');
      try {
        const sharedRepo = new MemoryRunRepository({ persistPath });
        const sseApp = createServer({ repository: sharedRepo, repoRoot: REPO_ROOT });

        const run = await sharedRepo.createRun({ videoKey: 'cart-nan', isSample: true });
        await sharedRepo.addEvent(run.id, {
          stage: 'ingest',
          agent: 'API',
          event_type: 'run_created',
          payload: { isSample: true },
        });

        // Start SSE request while run is still queued
        const sseResponsePromise = sseApp.request(`/api/runs/${run.id}/events`);

        // Spawn a real separate Node process acting as the Worker writing to persistPath
        const workerScript = `
          import { MemoryRunRepository } from ${JSON.stringify(path.resolve(__dirname, './runs.ts'))};
          const repo = new MemoryRunRepository({ persistPath: ${JSON.stringify(persistPath)} });
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          await sleep(120);
          const claimed = await repo.claimQueuedRun('child-worker-1');
          if (!claimed) process.exit(2);
          await repo.addEvent(claimed.id, { stage: 'ingest', agent: 'Worker', event_type: 'pipeline_started', payload: {} });
          await sleep(80);
          await repo.addEvent(claimed.id, { stage: 'watch', agent: 'watcher', event_type: 'watch_completed', payload: { summary: 'NaN total' } });
          await sleep(80);
          await repo.addEvent(claimed.id, { stage: 'report', agent: 'reporter', event_type: 'report_completed', payload: { status: 'fixed' } });
          await repo.updateRun(claimed.id, { state: 'fixed', stage: 'report', completedAt: new Date() });
          await repo.addEvent(claimed.id, { stage: 'report', agent: 'Worker', event_type: 'pipeline_completed', payload: { status: 'fixed' } });
        `;

        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', workerScript], {
          cwd: REPO_ROOT,
          stdio: 'pipe',
        });

        const childExitPromise = new Promise<void>((resolve, reject) => {
          if (child.exitCode !== null) {
            return child.exitCode === 0 ? resolve() : reject(new Error(`Child exited ${child.exitCode}`));
          }
          child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Child exited ${code}`))));
          child.on('error', reject);
        });

        const [res] = await Promise.all([sseResponsePromise, childExitPromise]);
        assert.equal(res.status, 200);
        const bodyText = await res.text();

        assert.ok(bodyText.includes('event: run_created'));
        assert.ok(bodyText.includes('event: pipeline_started'));
        assert.ok(bodyText.includes('event: watch_completed'));
        assert.ok(bodyText.includes('event: report_completed'));
        assert.ok(bodyText.includes('event: pipeline_completed'));
        assert.ok(bodyText.includes('event: stream_closed'));

        // Verify strict monotonic sequence IDs without duplicates
        const ids = Array.from(bodyText.matchAll(/^id: (\d+)$/gm)).map((m) => Number(m[1]));
        assert.deepEqual(ids, [1, 2, 3, 4, 5]);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
