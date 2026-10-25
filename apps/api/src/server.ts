import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import {
  getRunRepository,
  isKnownSampleId,
  KNOWN_SAMPLE_IDS,
  RunRepository,
} from './runs.js';
import { Worker } from './worker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');

dotenv.config({ path: path.join(REPO_ROOT, '.env') });

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
const ALLOWED_MIME_TYPES = new Set([
  'video/webm',
  'video/mp4',
  'video/quicktime',
  'video/x-matroska',
]);

const CreateJsonRunSchema = z.object({
  sampleId: z.string().optional(),
  note: z.string().max(1000).optional(),
  targetId: z.string().default('demo-shop'),
});

// Abuse protection (plan: ~5 run submissions per IP per hour). Instance-scoped
// with an override for tests; in-memory, so restarts reset it.
const RUN_RATE_WINDOW_MS = 60 * 60 * 1000;

export function createServer(options?: { repository?: RunRepository; repoRoot?: string; runRateLimit?: number }) {
  const repo = options?.repository || getRunRepository();
  const repoRoot = options?.repoRoot || REPO_ROOT;
  const runRateLimit = options?.runRateLimit ?? 5;
  const runAttempts = new Map<string, number[]>();

  function runRateLimited(ip: string): boolean {
    const now = Date.now();
    const recent = (runAttempts.get(ip) ?? []).filter((t) => now - t < RUN_RATE_WINDOW_MS);
    if (recent.length >= runRateLimit) {
      runAttempts.set(ip, recent);
      return true;
    }
    recent.push(now);
    runAttempts.set(ip, recent);
    return false;
  }

  const app = new Hono();

  // CORS Middleware
  const isProd = process.env.NODE_ENV === 'production';
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim())
    : ['http://localhost:3000', 'http://localhost:5173'];

  app.use('*', cors({
    origin: isProd ? allowedOrigins : '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  }));

  // Health Endpoint (supports both /health and /api/health)
  const healthHandler = (c: any) => {
    return c.json({
      status: 'ok',
      service: 'replay-api',
      timestamp: new Date().toISOString(),
      services: {
        api: 'healthy',
        database: process.env.DATABASE_URL ? 'configured' : 'fallback-memory',
        storage: process.env.SUPABASE_URL ? 'configured' : 'local-disk',
        nvidia: process.env.NVIDIA_API_KEY || process.env.NVIDIA_API_KEY_LOCATOR ? 'configured' : 'missing',
      },
      availableSamples: KNOWN_SAMPLE_IDS,
      limits: {
        maxUploadBytes: MAX_UPLOAD_BYTES,
        allowedMimeTypes: Array.from(ALLOWED_MIME_TYPES),
      },
    });
  };

  app.get('/health', healthHandler);
  app.get('/api/health', healthHandler);

  // List Available Samples
  app.get('/api/samples', (c) => {
    const samples = KNOWN_SAMPLE_IDS.map((id) => {
      const expectedPath = path.resolve(repoRoot, `samples/${id}/expected.json`);
      let meta: any = { id };
      try {
        if (fs.existsSync(expectedPath)) {
          meta = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
        }
      } catch {
        // Fallback to basic sample ID
      }
      return {
        id,
        title: meta.title || id,
        expectedBehavior: meta.expected_behavior,
        observedBehavior: meta.observed_behavior,
        guiltyFile: meta.guilty_file,
        guiltySymbol: meta.guilty_symbol,
        recordingAvailable: fs.existsSync(path.resolve(repoRoot, `samples/videos/${id}.webm`)),
      };
    });

    return c.json({ samples });
  });

  // Create a Run (JSON or Multipart Form)
  app.post('/api/runs', async (c) => {
    try {
      const clientIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
      if (runRateLimited(clientIp)) {
        return c.json({
          error: 'Rate limit exceeded',
          message: `Too many runs from this address. The limit is ${runRateLimit} runs per hour.`,
        }, 429);
      }

      const contentType = c.req.header('content-type') || '';

      // 1. Multipart Form Data (Uploads)
      if (contentType.includes('multipart/form-data')) {
        const body = await c.req.parseBody();
        const file = body['file'];
        const note = typeof body['note'] === 'string' ? body['note'].slice(0, 1000) : undefined;
        const sampleId = typeof body['sampleId'] === 'string' ? body['sampleId'] : undefined;

        // If sampleId specified in multipart, validate sample ID
        if (sampleId) {
          if (!isKnownSampleId(sampleId)) {
            return c.json({
              error: 'Invalid sample ID',
              message: `Unknown sample "${sampleId}". Must be one of: ${KNOWN_SAMPLE_IDS.join(', ')}`,
            }, 400);
          }

          const run = await repo.createRun({
            targetId: 'demo-shop',
            videoKey: sampleId,
            note,
            isSample: true,
          });

          await repo.addEvent(run.id, {
            stage: 'ingest',
            agent: 'API',
            event_type: 'run_created',
            payload: { isSample: true, sampleId, note: note ?? null },
          });

          return c.json({
            id: run.id,
            state: run.state,
            stage: run.stage,
            isSample: true,
            videoKey: run.videoKey,
            note: run.note,
            createdAt: run.createdAt.toISOString(),
          }, 201);
        }

        // Validate uploaded file
        if (!file || typeof file !== 'object' || !('arrayBuffer' in file)) {
          return c.json({
            error: 'Missing file',
            message: 'Multipart request must include a "file" field containing a video recording',
          }, 400);
        }

        const size = (file as any).size;
        const mimeType = (file as any).type || 'application/octet-stream';

        if (size > MAX_UPLOAD_BYTES) {
          return c.json({
            error: 'Payload too large',
            message: `Video exceeds maximum upload size of ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`,
          }, 413);
        }

        if (!ALLOWED_MIME_TYPES.has(mimeType)) {
          return c.json({
            error: 'Unsupported media type',
            message: `Media type "${mimeType}" is not supported. Supported: ${Array.from(ALLOWED_MIME_TYPES).join(', ')}`,
          }, 415);
        }

        const runId = randomUUID();
        const ext = mimeType === 'video/mp4' ? 'mp4' : 'webm';
        const uploadDir = path.resolve(repoRoot, 'artifacts/uploads');
        if (!fs.existsSync(uploadDir)) {
          fs.mkdirSync(uploadDir, { recursive: true });
        }

        const filePath = path.resolve(uploadDir, `${runId}.${ext}`);
        const buffer = Buffer.from(await (file as any).arrayBuffer());
        fs.writeFileSync(filePath, buffer);

        const run = await repo.createRun({
          targetId: 'demo-shop',
          videoKey: filePath,
          note,
          isSample: false,
        });

        await repo.addEvent(run.id, {
          stage: 'ingest',
          agent: 'API',
          event_type: 'run_created',
          payload: {
            isSample: false,
            videoSize: size,
            mimeType,
            savedPath: filePath,
            note: note ?? null,
          },
        });

        return c.json({
          id: run.id,
          state: run.state,
          stage: run.stage,
          isSample: false,
          videoKey: filePath,
          note: run.note,
          createdAt: run.createdAt.toISOString(),
        }, 201);
      }

      // 2. JSON Request
      let jsonBody: any = {};
      try {
        jsonBody = await c.req.json();
      } catch {
        return c.json({
          error: 'Invalid JSON',
          message: 'Failed to parse JSON request body',
        }, 400);
      }

      const parseResult = CreateJsonRunSchema.safeParse(jsonBody);
      if (!parseResult.success) {
        return c.json({
          error: 'Validation failed',
          details: parseResult.error.flatten(),
        }, 400);
      }

      const { sampleId, note, targetId } = parseResult.data;

      if (!sampleId) {
        return c.json({
          error: 'Missing sample ID or file',
          message: `Either provide "sampleId" (${KNOWN_SAMPLE_IDS.join(', ')}) or upload a video via multipart/form-data`,
        }, 400);
      }

      if (!isKnownSampleId(sampleId)) {
        return c.json({
          error: 'Invalid sample ID',
          message: `Unknown sample "${sampleId}". Must be one of: ${KNOWN_SAMPLE_IDS.join(', ')}`,
        }, 400);
      }

      const run = await repo.createRun({
        targetId: targetId || 'demo-shop',
        videoKey: sampleId,
        note,
        isSample: true,
      });

      await repo.addEvent(run.id, {
        stage: 'ingest',
        agent: 'API',
        event_type: 'run_created',
        payload: { isSample: true, sampleId, note: note ?? null },
      });

      return c.json({
        id: run.id,
        state: run.state,
        stage: run.stage,
        isSample: true,
        videoKey: run.videoKey,
        note: run.note,
        createdAt: run.createdAt.toISOString(),
      }, 201);
    } catch (err: any) {
      console.error('[Replay API] Error creating run:', err);
      return c.json({
        error: 'Internal server error',
        message: 'Failed to create run',
      }, 500);
    }
  });

  // List Runs
  app.get('/api/runs', async (c) => {
    const limitQuery = c.req.query('limit');
    const limit = limitQuery ? Math.min(Math.max(Number(limitQuery) || 50, 1), 100) : 50;

    const runsList = await repo.listRuns(limit);
    return c.json({
      runs: runsList.map((r) => ({
        id: r.id,
        targetId: r.targetId,
        state: r.state,
        stage: r.stage,
        isSample: r.isSample,
        videoKey: r.videoKey,
        note: r.note,
        durationMs: r.durationMs,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      })),
      total: runsList.length,
    });
  });

  // Get Single Run Details
  app.get('/api/runs/:id', async (c) => {
    const id = c.req.param('id');
    const run = await repo.getRun(id);

    if (!run) {
      return c.json({ error: 'Run not found', message: `No run found with ID ${id}` }, 404);
    }

    return c.json({
      id: run.id,
      targetId: run.targetId,
      state: run.state,
      stage: run.stage,
      isSample: run.isSample,
      videoKey: run.videoKey,
      note: run.note,
      outputs: {
        bugReport: run.bugReport,
        suspects: run.suspects,
        generatedTest: run.generatedTest,
        beforeTestResult: run.beforeTestResult,
        sameSymptomVerdict: run.sameSymptomVerdict,
        diff: run.diff,
        afterTestResult: run.afterTestResult,
        suiteResult: run.suiteResult,
        reportMarkdown: run.reportMarkdown,
      },
      metrics: {
        totalTokens: run.totalTokens,
        estimatedCostUsd: run.estimatedCostUsd,
        durationMs: run.durationMs,
      },
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
      completedAt: run.completedAt ? run.completedAt.toISOString() : null,
    });
  });

  // Server-Sent Events (SSE) Stream
  app.get('/api/runs/:id/events', async (c) => {
    const id = c.req.param('id');
    const run = await repo.getRun(id);

    if (!run) {
      return c.json({ error: 'Run not found', message: `No run found with ID ${id}` }, 404);
    }

    return streamSSE(c, async (stream) => {
      // 1. Replay history first in chronological sequence order
      const existingEvents = await repo.getEvents(id);
      for (const ev of existingEvents) {
        await stream.writeSSE({
          event: ev.event_type,
          data: JSON.stringify(ev),
          id: String(ev.seq),
        });
      }

      // Check if run is already completed / terminated
      const terminalStates = new Set(['fixed', 'reproduced_only', 'unreproduced', 'failed']);
      const currentRun = await repo.getRun(id);
      if (currentRun && terminalStates.has(currentRun.state)) {
        await stream.writeSSE({
          event: 'stream_closed',
          data: JSON.stringify({ reason: 'run_terminal', state: currentRun.state }),
          id: 'done',
        });
        return;
      }

      // 2. Subscribe to live events
      let unsubscribeHandler: (() => void) | undefined;

      const eventPromise = new Promise<void>((resolve) => {
        unsubscribeHandler = repo.subscribeEvents(id, async (liveEvent) => {
          try {
            await stream.writeSSE({
              event: liveEvent.event_type,
              data: JSON.stringify(liveEvent),
              id: String(liveEvent.seq),
            });

            // If pipeline or run completes, close stream
            if (
              liveEvent.event_type === 'pipeline_completed' ||
              liveEvent.event_type === 'pipeline_failed' ||
              liveEvent.stage === 'report'
            ) {
              await stream.writeSSE({
                event: 'stream_closed',
                data: JSON.stringify({ reason: 'pipeline_finished' }),
                id: 'done',
              });
              resolve();
            }
          } catch {
            resolve();
          }
        });
      });

      // Keep stream alive with periodic comment pings until closed or client disconnects
      const pingInterval = setInterval(async () => {
        try {
          await stream.writeSSE({
            event: 'ping',
            data: JSON.stringify({ t: Date.now() }),
            id: 'ping',
          });
        } catch {
          clearInterval(pingInterval);
          unsubscribeHandler?.();
        }
      }, 15000);

      stream.onAbort(() => {
        clearInterval(pingInterval);
        unsubscribeHandler?.();
      });

      await eventPromise;
      clearInterval(pingInterval);
      unsubscribeHandler?.();
    });
  });

  return app;
}

const defaultApp = createServer();
const port = Number(process.env.PORT || 3001);

if (process.env.NODE_ENV !== 'test' && !process.env.REPLAY_STANDALONE_DISABLED) {
  const isDirectRun = process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js');
  if (isDirectRun) {
    console.log(`[Replay API] Server listening on http://localhost:${port}`);
    serve({
      fetch: defaultApp.fetch,
      port,
    });

    // Local mode: with the in-memory repository the standalone worker process
    // cannot see runs created here, so run one worker in-process. Postgres
    // deployments (docker compose) run the separate worker instead and can
    // disable this with REPLAY_INLINE_WORKER=0.
    if (!process.env.DATABASE_URL && process.env.REPLAY_INLINE_WORKER !== '0') {
      const inlineWorker = new Worker({ repoRoot: REPO_ROOT });
      void inlineWorker.start();
    }
  }
}

export default defaultApp;
