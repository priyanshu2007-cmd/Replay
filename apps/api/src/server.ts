import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { RunEvent } from '@replay/shared';
import { redactSecretText } from '@replay/agents';
import {
  getRunRepository,
  isKnownSampleId,
  KNOWN_SAMPLE_IDS,
  RunRepository,
} from './runs.js';
import { CANONICAL_SAMPLE_METADATA } from './recorded-samples.js';
import { Worker } from './worker.js';

// Repo root: filesystem-relative paths only matter outside serverless hosts.
// Walk upward to locate pnpm-workspace.yaml so both src and dist resolve cleanly.
function computeRepoRoot(): string {
  if (process.env.REPLAY_WORKSPACE_ROOT) return path.resolve(process.env.REPLAY_WORKSPACE_ROOT);
  if (process.env.VERCEL) return process.cwd();
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through to process.cwd() walk
  }
  let cwd = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(cwd, 'pnpm-workspace.yaml'))) return cwd;
    const parent = path.dirname(cwd);
    if (parent === cwd) break;
    cwd = parent;
  }
  return process.cwd();
}
const REPO_ROOT = computeRepoRoot();
// Serverless hosts (Vercel) have a read-only repo: transient uploads and run
// artifacts must live in a writable data dir (e.g. REPLAY_DATA_DIR=/tmp).
const DATA_DIR = process.env.REPLAY_DATA_DIR || (process.env.VERCEL ? os.tmpdir() : REPO_ROOT);

if (fs.existsSync(path.join(REPO_ROOT, '.env'))) {
  dotenv.config({ path: path.join(REPO_ROOT, '.env') });
}

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
const ALLOWED_MIME_TYPES = new Set([
  'video/webm',
  'video/mp4',
  'video/quicktime',
  'video/x-matroska',
]);

function findSampleVideoPath(repoRoot: string, id: string): string | null {
  const candidates = [
    path.resolve(repoRoot, `samples/videos/${id}.webm`),
    path.resolve(repoRoot, `apps/web/public/samples/${id}.webm`),
    path.resolve(repoRoot, `public/samples/${id}.webm`),
  ];
  if (repoRoot === REPO_ROOT) {
    candidates.push(
      path.resolve(process.cwd(), `public/samples/${id}.webm`),
      path.resolve(process.cwd(), `apps/web/public/samples/${id}.webm`),
    );
  }
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && stat.size > 0) {
        return candidate;
      }
    } catch {
      // continue checking next candidate
    }
  }
  return null;
}

function isSampleRecordingAvailable(repoRoot: string, id: string): boolean {
  if (findSampleVideoPath(repoRoot, id) !== null) {
    return true;
  }
  // On Vercel serverless deployments, public/samples/<id>.webm is verified at
  // build time by copy-monaco.mjs and served directly by Vercel's static CDN.
  if (Boolean(process.env.VERCEL) && repoRoot === REPO_ROOT && isKnownSampleId(id)) {
    return true;
  }
  return false;
}

const CreateJsonRunSchema = z.object({
  sampleId: z.string().optional(),
  note: z.string().max(1000).optional(),
  targetId: z.enum(['demo-shop']).default('demo-shop'),
});

/**
 * Client IP for rate limiting and caps. Never trust X-Forwarded-For from an
 * untrusted peer: only when TRUST_PROXY=1 AND the socket peer is a trusted
 * private/configured proxy address do we inspect X-Forwarded-For / X-Real-IP.
 */
const PRIVATE_RANGES = /^(10\.|127\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i;

function normalizeIpCandidate(raw: string | undefined): string {
  if (!raw) return '';
  let trimmed = raw.trim();
  if (!trimmed) return '';
  // Strip bracketed IPv6 with port: [2001:db8::1]:8080 -> 2001:db8::1
  const bracketMatch = trimmed.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketMatch && bracketMatch[1]) {
    trimmed = bracketMatch[1];
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(trimmed)) {
    // Strip IPv4 port: 203.0.113.9:54321 -> 203.0.113.9
    trimmed = trimmed.replace(/:\d+$/, '');
  }
  trimmed = trimmed.replace(/^::ffff:/i, '');
  // Strip IPv6 zone index (%eth0) before validation
  const zoneIdx = trimmed.indexOf('%');
  const withoutZone = zoneIdx !== -1 ? trimmed.slice(0, zoneIdx) : trimmed;
  if (isIP(withoutZone) === 0) return '';
  return withoutZone.toLowerCase();
}

function isTrustedProxyAddr(ip: string): boolean {
  if (!ip) return false;
  const configured = (process.env.TRUSTED_PROXY_IPS ?? '')
    .split(',')
    .map((s) => normalizeIpCandidate(s))
    .filter(Boolean);
  if (configured.length > 0) {
    return configured.includes(ip);
  }
  return PRIVATE_RANGES.test(ip);
}

export function clientIp(c: { env: unknown; req: { header: (n: string) => string | undefined } }): string {
  const incoming = c.env as unknown as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  const rawSocketAddr = incoming?.incoming?.socket?.remoteAddress || '';
  const socketAddr = normalizeIpCandidate(rawSocketAddr);

  if (process.env.TRUST_PROXY === '1' && isTrustedProxyAddr(socketAddr)) {
    const fwd = c.req.header('x-forwarded-for');
    if (fwd) {
      const hops = fwd.split(',').map((h) => h.trim()).filter(Boolean);
      for (let i = hops.length - 1; i >= 0; i--) {
        const candidate = normalizeIpCandidate(hops[i]);
        if (!candidate) continue;
        if (!isTrustedProxyAddr(candidate) || i === 0) {
          return candidate;
        }
      }
    }
    const realIp = normalizeIpCandidate(c.req.header('x-real-ip'));
    if (realIp) return realIp;
  }
  return socketAddr || 'local';
}

// Abuse protection (plan: ~5 run submissions per IP per hour). Shared via
// RunRepository when available, with bounded in-memory fallback.
const RUN_RATE_WINDOW_MS = 60 * 60 * 1000;

export function createServer(options?: { repository?: RunRepository; repoRoot?: string; runRateLimit?: number }) {
  const repo = options?.repository || getRunRepository();
  const repoRoot = options?.repoRoot || REPO_ROOT;
  const envRateLimit = Number(process.env.REPLAY_RATE_LIMIT_MAX);
  const runRateLimit = options?.runRateLimit ?? (Number.isFinite(envRateLimit) && envRateLimit > 0 ? envRateLimit : 5);
  const runAttempts = new Map<string, number[]>();

  async function checkRunRateLimit(ip: string): Promise<'allowed' | 'exceeded' | 'unavailable'> {
    if (typeof repo.checkRateLimit === 'function') {
      try {
        const res = await repo.checkRateLimit(`runs:${ip}`, runRateLimit, RUN_RATE_WINDOW_MS);
        return res.allowed ? 'allowed' : 'exceeded';
      } catch (err) {
        console.error('[Replay API] Shared rate limit store error (failing closed):', (err as Error)?.message);
        return 'unavailable';
      }
    }
    const now = Date.now();
    if (runAttempts.size > 5_000) {
      for (const [k, ts] of runAttempts.entries()) {
        const valid = ts.filter((t) => now - t < RUN_RATE_WINDOW_MS);
        if (valid.length === 0) runAttempts.delete(k);
        else runAttempts.set(k, valid);
      }
    }
    const recent = (runAttempts.get(ip) ?? []).filter((t) => now - t < RUN_RATE_WINDOW_MS);
    if (recent.length >= runRateLimit) {
      runAttempts.set(ip, recent);
      return 'exceeded';
    }
    recent.push(now);
    runAttempts.set(ip, recent);
    return 'allowed';
  }

  const app = new Hono();

  // CORS Middleware
  const isProd = process.env.NODE_ENV === 'production';
  // Validated per request, not at import: builds and tests have no runtime env.
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (isProd && allowedOrigins.length === 0) {
    console.error('[Replay API] ALLOWED_ORIGINS is not set; external cross-origin requests will be refused.');
  }

  function isSameOriginOrAllowed(c: any): boolean {
    const origin = c.req.header('origin');
    if (!origin) return true; // Same-origin GET, navigation, or internal fetch
    if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) return true;
    const host = c.req.header('host') || c.req.header('x-forwarded-host');
    if (host && (origin === `https://${host}` || origin === `http://${host}`)) return true;
    if (process.env.VERCEL && (origin.endsWith('.vercel.app') || origin === 'https://vercel.app')) return true;
    return false;
  }

  app.use('*', cors({
    origin: (origin, c) => {
      if (!origin) return '*';
      if (!isProd) return origin;
      if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) return origin;
      const host = c.req.header('host') || c.req.header('x-forwarded-host');
      if (host && (origin === `https://${host}` || origin === `http://${host}`)) return origin;
      if (process.env.VERCEL && (origin.endsWith('.vercel.app') || origin === 'https://vercel.app')) return origin;
      return null;
    },
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  }));

  // Production safety gate: refuse untrusted cross-origin requests.
  // Same-origin requests, health checks, and configured allowed origins are always permitted.
  app.use('/api/*', async (c, next) => {
    const reqPath = c.req.path;
    if (reqPath === '/api/health' || reqPath === '/health') {
      await next();
      return;
    }
    if (isProd && !isSameOriginOrAllowed(c)) {
      if (allowedOrigins.length === 0) {
        return c.json({ error: 'Service unavailable', message: 'Cross-origin access is not enabled for this deployment.' }, 503);
      }
      return c.json({ error: 'Forbidden', message: 'Cross-origin request not allowed.' }, 403);
    }
    await next();
    return;
  });

  // Reject oversized request bodies before any parsing (upload limit + headroom).
  app.use('*', bodyLimit({
    maxSize: MAX_UPLOAD_BYTES + 64 * 1024,
    onError: (c) => c.json({
      error: 'Payload too large',
      message: `Request body exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB upload limit.`,
    }, 413),
  }));

  app.onError((err, c) => {
    console.error('[Replay API] Request error:', err?.message || err);
    return c.json({
      error: 'Internal Server Error',
      message: redactSecretText(err?.message || 'An unexpected error occurred'),
    }, 500);
  });

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
        nebius: process.env.NEBIUS_API_KEY || process.env.NEBIUS_API_KEY_LOCATOR ? 'configured' : 'missing',
      },
      availableSamples: KNOWN_SAMPLE_IDS,
      models: {
        provider: 'nebius-token-factory',
        keyConfigured: Boolean(process.env.NEBIUS_API_KEY || process.env.NEBIUS_API_KEY_LOCATOR),
        roles: {
          watcher: process.env.NEBIUS_API_KEY || process.env.NEBIUS_API_KEY_WATCHER ? 'key-present' : 'no-key',
          locator: process.env.NEBIUS_API_KEY || process.env.NEBIUS_API_KEY_LOCATOR ? 'key-present' : 'no-key',
          reproducer: process.env.NEBIUS_API_KEY || process.env.NEBIUS_API_KEY_REPRODUCER ? 'key-present' : 'no-key',
          reporter: process.env.NEBIUS_API_KEY || process.env.NEBIUS_API_KEY_REPORTER ? 'key-present' : 'no-key',
        },
        note: 'Live model verification: pnpm smoke:models',
      },
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
      const canonical = CANONICAL_SAMPLE_METADATA[id];
      let meta: Record<string, any> = canonical ? { ...canonical } : { id };
      try {
        if (fs.existsSync(expectedPath)) {
          meta = { ...meta, ...JSON.parse(fs.readFileSync(expectedPath, 'utf8')) };
        }
      } catch {
        // Fallback to canonical sample metadata
      }
      return {
        id,
        title: meta.title || id,
        expectedBehavior: meta.expected_behavior ?? meta.expectedBehavior,
        observedBehavior: meta.observed_behavior ?? meta.observedBehavior,
        guiltyFile: meta.guilty_file ?? meta.guiltyFile,
        guiltySymbol: meta.guilty_symbol ?? meta.guiltySymbol,
        recordingAvailable: isSampleRecordingAvailable(repoRoot, id),
      };
    });

    return c.json({ samples });
  });

  // Create a Run (JSON or Multipart Form)
  app.post('/api/runs', async (c) => {
    try {
      const rateCheck = await checkRunRateLimit(clientIp(c));
      if (rateCheck === 'exceeded') {
        return c.json({
          error: 'Rate limit exceeded',
          message: `Too many runs from this address. The limit is ${runRateLimit} runs per hour.`,
        }, 429);
      }
      if (rateCheck === 'unavailable') {
        return c.json({
          error: 'Service unavailable',
          message: 'Rate limit store is temporarily unavailable. Please try again shortly.',
        }, 503);
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

          if (Boolean(process.env.VERCEL) && !process.env.DATABASE_URL && typeof repo.materializeRecordedSampleRun === 'function') {
            const recorded = await repo.materializeRecordedSampleRun(sampleId, note);
            if (recorded) {
              return c.json({
                id: recorded.id,
                state: recorded.state,
                stage: recorded.stage,
                isSample: true,
                videoKey: recorded.videoKey,
                note: recorded.note,
                executionMode: 'recorded_sample_replay',
                createdAt: recorded.createdAt.toISOString(),
              }, 201);
            }
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

        if (typeof size !== 'number' || size <= 0) {
          return c.json({
            error: 'Empty file',
            message: 'Uploaded video file cannot be empty (0 bytes).',
          }, 400);
        }

        if (size > MAX_UPLOAD_BYTES) {
          return c.json({
            error: 'Payload too large',
            message: `Video exceeds maximum upload size of ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`,
          }, 413);
        }

        // Content sniffing: the client MIME type is not trusted.
        const head = Buffer.from(await (file as any).slice(0, 16).arrayBuffer());
        const isWebm = head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
        const isMp4MovMkv = head.length >= 8 && head.subarray(4, 8).toString('latin1') === 'ftyp';
        if (!isWebm && !isMp4MovMkv) {
          return c.json({
            error: 'Unsupported media type',
            message: 'File content does not look like a supported video (WebM/MP4/MOV/MKV).',
          }, 415);
        }

        if (!ALLOWED_MIME_TYPES.has(mimeType)) {
          return c.json({
            error: 'Unsupported media type',
            message: `Media type "${mimeType}" is not supported. Supported: ${Array.from(ALLOWED_MIME_TYPES).join(', ')}`,
          }, 415);
        }

        const runId = randomUUID();
        const ext = mimeType === 'video/mp4' ? 'mp4' : 'webm';
        const uploadDir = path.resolve(DATA_DIR, 'artifacts/uploads');
        if (!fs.existsSync(uploadDir)) {
          fs.mkdirSync(uploadDir, { recursive: true });
        }

        const filePath = path.resolve(uploadDir, `${runId}.${ext}`);
        // Relative key: containers/hosts resolve it against REPLAY_DATA_DIR,
        // so the worker finds the file without seeing an absolute path.
        const relativeKey = `uploads/${runId}.${ext}`;
        const buffer = Buffer.from(await (file as any).arrayBuffer());
        if (buffer.length === 0) {
          return c.json({
            error: 'Empty file',
            message: 'Uploaded video file cannot be empty (0 bytes).',
          }, 400);
        }

        // Exclusive create, owner-only: the upload name is unpredictable but never overwrite or share it.
        fs.writeFileSync(filePath, buffer, { flag: 'wx', mode: 0o600 });

        let run;
        try {
          run = await repo.createRun({
            targetId: 'demo-shop',
            videoKey: relativeKey,
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

          if (Boolean(process.env.VERCEL) && !process.env.DATABASE_URL) {
            run = (await repo.updateRun(run.id, {
              state: 'failed',
              stage: 'ingest',
              completedAt: new Date(),
            })) ?? run;
            await repo.addEvent(run.id, {
              stage: 'ingest',
              agent: 'Worker',
              event_type: 'pipeline_failed',
              payload: {
                code: 'serverless_worker_unavailable',
                error:
                  'Custom video execution requires a persistent background worker, FFmpeg, Docker/Playwright sandbox, and NEBIUS_API_KEY. On this serverless deployment, use the five verified Demo Shop sample bugs or connect an external worker via DATABASE_URL.',
              },
            });
          }
        } catch (dbErr) {
          try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          } catch {
            // Best-effort cleanup of orphaned upload
          }
          throw dbErr;
        }

        // Opaque key: absolute server paths never leave the API.
        return c.json({
          id: run.id,
          state: run.state,
          stage: run.stage,
          isSample: false,
          videoKey: 'upload',
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

      if (Boolean(process.env.VERCEL) && !process.env.DATABASE_URL && typeof repo.materializeRecordedSampleRun === 'function') {
        const recorded = await repo.materializeRecordedSampleRun(sampleId, note);
        if (recorded) {
          return c.json({
            id: recorded.id,
            state: recorded.state,
            stage: recorded.stage,
            isSample: true,
            videoKey: recorded.videoKey,
            note: recorded.note,
            executionMode: 'recorded_sample_replay',
            createdAt: recorded.createdAt.toISOString(),
          }, 201);
        }
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
      console.error('[Replay API] Error creating run:', (err as Error)?.message ?? err);
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

    const runsList = (await repo.listRuns(limit)).filter((r) => r.isSample);
    return c.json({
      runs: runsList.map((r) => ({
        id: r.id,
        targetId: r.targetId,
        state: r.state,
        stage: r.stage,
        isSample: r.isSample,
        // Opaque key: sample ids only; uploaded absolute paths never leave the server.
        videoKey: isKnownSampleId(r.videoKey) ? r.videoKey : 'upload',
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
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return c.json({ error: 'Invalid run id', message: 'Run id must be a UUID' }, 400);
    }
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
      executionMode: run.executionMode ?? (run.id.startsWith('d0000001') ? 'recorded_sample_replay' : 'live'),
      videoKey: isKnownSampleId(run.videoKey) ? run.videoKey : 'upload',
      note: run.isSample ? run.note : null,
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

  // Readiness: what the demo actually depends on, cached 5s. Unlike /health
  // this answers "can a run work right now", and fails honestly per check.
  let readyCache: { at: number; body: Record<string, unknown> } | null = null;
  app.get('/api/ready', async (c) => {
    if (readyCache && Date.now() - readyCache.at < 5_000) {
      return c.json(readyCache.body);
    }
    const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
    const hasModelKey = Boolean(process.env.NEBIUS_API_KEY || process.env.NEBIUS_API_KEY_LOCATOR);
    const sampleAssetsReady = KNOWN_SAMPLE_IDS.every((id) => isSampleRecordingAvailable(repoRoot, id));
    const checks: Record<string, string> = {
      api: 'healthy',
      sampleAssets: sampleAssetsReady ? 'available' : 'missing',
    };
    let hasDatabase = false;
    if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== '') {
      try {
        new URL(process.env.DATABASE_URL);
        checks.database = 'configured';
        hasDatabase = true;
      } catch {
        checks.database = 'error';
      }
    } else {
      checks.database = 'memory-fallback';
    }
    checks.storage = process.env.SUPABASE_URL
      ? 'configured'
      : isServerless
        ? 'ephemeral-tmp'
        : 'local-disk';
    const workerMode =
      isServerless && !hasDatabase
        ? 'unavailable-serverless'
        : hasDatabase
          ? 'external-db-queue'
          : process.env.REPLAY_INLINE_WORKER === '0'
            ? 'disabled'
            : 'inline-local';
    checks.worker = workerMode;
    checks.modelKey = hasModelKey ? 'present' : 'missing';
    checks.sandbox = isServerless
      ? 'unavailable-serverless'
      : process.env.REPLAY_SANDBOX_MODE === 'docker'
        ? 'docker'
        : 'local-workspace';
    checks.ffmpeg = isServerless ? 'unavailable-serverless' : 'checked-on-worker';

    const canExecuteLiveRun = Boolean(!isServerless && hasModelKey && workerMode !== 'disabled');
    const canReplayRecordedSamples = sampleAssetsReady;
    const executionMode = canExecuteLiveRun
      ? 'live'
      : isServerless && canReplayRecordedSamples
        ? 'recorded_sample_replay'
        : !isServerless && workerMode !== 'disabled'
          ? 'fixture_assisted'
          : 'read_only';

    const blockers: string[] = [];
    if (!hasModelKey) {
      blockers.push('Model API key (NEBIUS_API_KEY) is not configured on this deployment.');
    }
    if (isServerless && !hasDatabase) {
      blockers.push(
        'Serverless runtime (Vercel) does not run a persistent background worker or Docker/Playwright sandbox; sample runs use verified recorded Demo Shop artifacts.',
      );
    }
    if (!sampleAssetsReady) {
      blockers.push('One or more sample video recordings are missing.');
    }

    const body = {
      status: sampleAssetsReady ? 'ok' : 'degraded',
      executionMode,
      canExecuteLiveRun,
      canReplayRecordedSamples,
      blockers,
      checks,
    };
    readyCache = { at: Date.now(), body };
    return c.json(body);
  });

  // Stream or redirect to the recording video for a run.
  app.get('/api/runs/:id/video', async (c) => {
    const id = c.req.param('id');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return c.json({ error: 'Invalid run id', message: 'Run id must be a UUID' }, 400);
    }
    const run = await repo.getRun(id);
    if (!run) {
      return c.json({ error: 'Run not found', message: `No run found with ID ${id}` }, 404);
    }

    let videoPath: string | null = null;
    let contentType = 'video/webm';

    if (run.isSample && isKnownSampleId(run.videoKey)) {
      videoPath = findSampleVideoPath(repoRoot, run.videoKey);
      if (!videoPath && process.env.VERCEL) {
        return c.redirect(`/samples/${run.videoKey}.webm`, 307);
      }
    } else if (!run.isSample && typeof run.videoKey === 'string') {
      const uploadsRoot = path.resolve(DATA_DIR, 'artifacts/uploads');
      const candidate = path.resolve(DATA_DIR, 'artifacts', run.videoKey);
      if (candidate.startsWith(uploadsRoot + path.sep)) {
        videoPath = candidate;
        if (candidate.endsWith('.mp4')) contentType = 'video/mp4';
      }
    }

    const notFound = () =>
      c.json(
        { error: 'Recording not found', message: 'Video recording is not available on disk for this run.' },
        404,
      );
    if (!videoPath) return notFound();

    // One open, then fstat/read on the same descriptor: no check-then-use race. Upload paths are
    // server-created and containment-checked above.
    let fd: number;
    try {
      fd = fs.openSync(videoPath, 'r');
    } catch {
      return notFound();
    }
    try {
      const total = fs.fstatSync(fd).size;
      const readSlice = (start: number, end: number) => {
        const chunk = Buffer.alloc(end - start + 1);
        const n = fs.readSync(fd, chunk, 0, chunk.length, start);
        return chunk.subarray(0, n);
      };
      const range = c.req.header('range');
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (match) {
          const start = match[1] ? parseInt(match[1], 10) : 0;
          const end = match[2] ? Math.min(parseInt(match[2], 10), total - 1) : total - 1;
          if (start >= 0 && start <= end && end < total) {
            const chunk = readSlice(start, end);
            return new Response(chunk, {
              status: 206,
              headers: {
                'Content-Type': contentType,
                'Content-Length': String(chunk.length),
                'Content-Range': `bytes ${start}-${end}/${total}`,
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'public, max-age=3600',
              },
            });
          }
        }
      }
      const buf = total > 0 ? readSlice(0, total - 1) : Buffer.alloc(0);
      return new Response(buf, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(total),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    } finally {
      fs.closeSync(fd);
    }
  });

  // Polling fallback for the events stream (used when SSE is unavailable).
  app.get('/api/runs/:id/events-page', async (c) => {
    const id = c.req.param('id');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return c.json({ error: 'Invalid run id', message: 'Run id must be a UUID' }, 400);
    }
    const run = await repo.getRun(id);
    if (!run) {
      return c.json({ error: 'Run not found', message: `No run found with ID ${id}` }, 404);
    }
    const events = await repo.getEvents(id);
    return c.json({ events });
  });

  // Rerun an existing run: re-queue the same video/target as a fresh run.
  app.post('/api/runs/:id/rerun', async (c) => {
    const id = c.req.param('id');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return c.json({ error: 'Invalid run id', message: 'Run id must be a UUID' }, 400);
    }
    const rateCheck = await checkRunRateLimit(clientIp(c));
    if (rateCheck === 'exceeded') {
      return c.json({
        error: 'Rate limit exceeded',
        message: `Too many runs from this address. The limit is ${runRateLimit} runs per hour.`,
      }, 429);
    }
    if (rateCheck === 'unavailable') {
      return c.json({
        error: 'Service unavailable',
        message: 'Rate limit store is temporarily unavailable. Please try again shortly.',
      }, 503);
    }
    const run = await repo.getRun(id);
    if (!run) {
      return c.json({ error: 'Run not found', message: `No run found with ID ${id}` }, 404);
    }
    if (
      run.isSample &&
      isKnownSampleId(run.videoKey) &&
      Boolean(process.env.VERCEL) &&
      !process.env.DATABASE_URL &&
      typeof repo.materializeRecordedSampleRun === 'function'
    ) {
      const recorded = await repo.materializeRecordedSampleRun(run.videoKey, run.note ?? undefined);
      if (recorded) {
        return c.json({
          id: recorded.id,
          state: recorded.state,
          stage: recorded.stage,
          executionMode: 'recorded_sample_replay',
        }, 201);
      }
    }
    const created = await repo.createRun({
      targetId: run.targetId,
      videoKey: run.videoKey,
      note: run.note ?? undefined,
      isSample: run.isSample,
    });
    await repo.addEvent(created.id, {
      stage: 'ingest',
      agent: 'API',
      event_type: 'run_created',
      payload: { rerun_of: id, isSample: run.isSample, videoKey: run.videoKey },
    });
    return c.json({
      id: created.id,
      state: created.state,
      stage: created.stage,
    }, 201);
  });

  // Server-Sent Events (SSE) Stream — capped per client to bound resources.
  const sseConnections = new Map<string, number>();
  const SSE_CAP_PER_IP = 5;
  const SSE_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

  app.get('/api/runs/:id/events', async (c) => {
    const id = c.req.param('id');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return c.json({ error: 'Invalid run id', message: 'Run id must be a UUID' }, 400);
    }
    const run = await repo.getRun(id);
    if (!run) {
      return c.json({ error: 'Run not found', message: `No run found with ID ${id}` }, 404);
    }

    // Cap is counted only for streams that actually start; every exit path
    // below decrements exactly once via finally.
    const streamIp = clientIp(c);
    const open = sseConnections.get(streamIp) ?? 0;
    if (open >= SSE_CAP_PER_IP) {
      return c.json({ error: 'Too many connections', message: 'SSE connection limit reached. Close other run views.' }, 429);
    }
    sseConnections.set(streamIp, open + 1);

    try {
      return await streamSSE(c, async (stream) => {
        const lastEventHeader = Number(c.req.header('last-event-id') || c.req.query('afterSeq') || 0);
        let lastSentSeq = Number.isFinite(lastEventHeader) && lastEventHeader > 0 ? Math.floor(lastEventHeader) : 0;

        const terminalStates = new Set(['fixed', 'reproduced_only', 'unreproduced', 'failed']);
        const pending: RunEvent[] = [];
        let flushing = false;
        let closed = false;
        let finishStream: (() => void) | undefined;

        const donePromise = new Promise<void>((resolve) => {
          finishStream = () => {
            if (!closed) {
              closed = true;
              resolve();
            }
          };
        });

        const flushQueue = async () => {
          if (flushing || closed) return;
          flushing = true;
          try {
            while (pending.length > 0 && !closed) {
              pending.sort((a, b) => a.seq - b.seq);
              const ev = pending.shift()!;
              if (ev.seq <= lastSentSeq) continue;
              lastSentSeq = ev.seq;

              await stream.writeSSE({
                event: ev.event_type,
                data: JSON.stringify(ev),
                id: String(ev.seq),
              });

              if (
                ev.event_type === 'pipeline_completed' ||
                ev.event_type === 'pipeline_failed'
              ) {
                await stream.writeSSE({
                  event: 'stream_closed',
                  data: JSON.stringify({ reason: 'pipeline_finished' }),
                });
                finishStream?.();
                return;
              }
            }
          } catch {
            finishStream?.();
          } finally {
            flushing = false;
          }
        };

        const enqueueEvent = (ev: RunEvent) => {
          if (closed || ev.seq <= lastSentSeq) return;
          if (!pending.some((p) => p.seq === ev.seq)) {
            pending.push(ev);
          }
          void flushQueue();
        };

        // Subscribe FIRST, then load history so no in-flight event is missed.
        const unsubscribe = repo.subscribeEvents(id, (liveEvent) => {
          enqueueEvent(liveEvent);
        });

        try {
          for (const ev of await repo.getEvents(id)) {
            if (ev.seq > lastSentSeq && !pending.some((p) => p.seq === ev.seq)) {
              pending.push(ev);
            }
          }
          await flushQueue();
          if (closed) return;

          const currentRun = await repo.getRun(id);
          if (currentRun && terminalStates.has(currentRun.state)) {
            // Flush any final events emitted right before run state flipped
            for (const ev of await repo.getEvents(id)) {
              if (ev.seq > lastSentSeq && !pending.some((p) => p.seq === ev.seq)) {
                pending.push(ev);
              }
            }
            await flushQueue();
            if (!closed) {
              await stream.writeSSE({
                event: 'stream_closed',
                data: JSON.stringify({ reason: 'run_terminal', state: currentRun.state }),
              });
              finishStream?.();
            }
            return;
          }

          await stream.writeSSE({ retry: 3000, data: '' });

          // Cross-process safety poll: catches events and terminal state changes
          // persisted by an external worker process even if EventEmitter is local.
          const pollInterval = setInterval(async () => {
            if (closed) return;
            try {
              const allEvents = await repo.getEvents(id);
              for (const ev of allEvents) {
                if (ev.seq > lastSentSeq && !pending.some((p) => p.seq === ev.seq)) {
                  pending.push(ev);
                }
              }
              await flushQueue();
              if (closed) return;

              const latestRun = await repo.getRun(id);
              if (latestRun && terminalStates.has(latestRun.state)) {
                const finalEvents = await repo.getEvents(id);
                for (const ev of finalEvents) {
                  if (ev.seq > lastSentSeq && !pending.some((p) => p.seq === ev.seq)) {
                    pending.push(ev);
                  }
                }
                await flushQueue();
                if (!closed) {
                  await stream.writeSSE({
                    event: 'stream_closed',
                    data: JSON.stringify({ reason: 'run_terminal', state: latestRun.state }),
                  });
                  finishStream?.();
                }
              }
            } catch {
              finishStream?.();
            }
          }, 100);

          const pingInterval = setInterval(async () => {
            if (closed) return;
            try {
              await stream.writeSSE({ event: 'ping', data: JSON.stringify({ t: Date.now() }) });
            } catch {
              finishStream?.();
            }
          }, 15000);
          if (typeof pingInterval.unref === 'function') pingInterval.unref();

          stream.onAbort(() => {
            finishStream?.();
          });

          const idleTimer = setTimeout(() => {
            try {
              void stream.writeSSE({ event: 'stream_closed', data: JSON.stringify({ reason: 'idle_timeout' }) });
            } catch {
              // stream already gone
            }
            finishStream?.();
          }, SSE_IDLE_TIMEOUT_MS);
          if (typeof idleTimer.unref === 'function') idleTimer.unref();

          await donePromise;
          clearInterval(pollInterval);
          clearInterval(pingInterval);
          clearTimeout(idleTimer);
        } finally {
          unsubscribe();
        }
      });
    } finally {
      const remaining = Math.max(0, (sseConnections.get(streamIp) ?? 1) - 1);
      if (remaining === 0) {
        sseConnections.delete(streamIp);
      } else {
        sseConnections.set(streamIp, remaining);
      }
    }
  });

  return app;
}

const defaultApp = createServer();
const port = Number(process.env.PORT || 3001);

if (process.env.NODE_ENV !== 'test' && !process.env.REPLAY_STANDALONE_DISABLED && !process.env.VERCEL) {
  const isDirectRun = /server\.(ts|js|cjs)$/.test(process.argv[1] ?? '');
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
