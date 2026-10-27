import * as fs from 'node:fs';
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
import {
  getRunRepository,
  isKnownSampleId,
  KNOWN_SAMPLE_IDS,
  RunRepository,
} from './runs.js';
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
const DATA_DIR = process.env.REPLAY_DATA_DIR || REPO_ROOT;

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

// Static fallback metadata for serverless deploys without the samples dir.
const SAMPLE_TITLES: Record<string, { title: string; observedBehavior: string }> = {
  'cart-nan': {
    title: 'Cart total becomes NaN after clearing quantity field',
    observedBehavior: "Clearing the quantity input field causes the cart total and subtotal to display '$NaN'.",
  },
  'double-discount': {
    title: 'Double-clicking Apply applies the discount twice',
    observedBehavior: 'Double-clicking Apply stacks the coupon twice, applying 20% discount ($20.00 off $100).',
  },
  'string-sort': {
    title: 'String-based sort places $100 before $20',
    observedBehavior: 'Products are sorted lexicographically: Mechanical Keyboard ($100) appears before Ergonomic Mouse ($20).',
  },
  'empty-email': {
    title: 'Checkout accepts an empty email address',
    observedBehavior: 'Checkout proceeds without email validation and shows Order Confirmed for an empty email address.',
  },
  'quantity-reset': {
    title: 'Quantity resets after page navigation',
    observedBehavior: 'Switching to Catalog and returning to Cart resets item quantity back to 1.',
  },
};

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
      const rightMostRaw = hops[hops.length - 1];
      const rightMostIp = normalizeIpCandidate(rightMostRaw);
      if (rightMostIp) {
        // If explicit multi-hop TRUSTED_PROXY_IPS are configured, walk right-to-left
        // skipping known intermediate proxies to find the first untrusted client hop.
        const explicitProxies = (process.env.TRUSTED_PROXY_IPS ?? '')
          .split(',')
          .map((s) => normalizeIpCandidate(s))
          .filter(Boolean);
        if (explicitProxies.length > 0 && hops.length > 1) {
          for (let i = hops.length - 1; i >= 0; i--) {
            const candidate = normalizeIpCandidate(hops[i]);
            if (!candidate) break;
            if (!explicitProxies.includes(candidate) || i === 0) {
              return candidate;
            }
          }
        }
        return rightMostIp;
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
  const runRateLimit = options?.runRateLimit ?? 5;
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
      let meta: any = { id };
      try {
        if (fs.existsSync(expectedPath)) {
          meta = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
        } else if (process.env.VERCEL) {
          // Serverless bundle ships no samples dir: honest static metadata.
          meta = SAMPLE_TITLES[id] ? { ...SAMPLE_TITLES[id], id } : { id };
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

        fs.writeFileSync(filePath, buffer);

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

  // Readiness: what the demo actually depends on, cached 30s. Unlike /health
  // this answers "can a run work right now", and fails honestly per check.
  let readyCache: { at: number; body: Record<string, unknown> } | null = null;
  app.get('/api/ready', async (c) => {
    if (readyCache && Date.now() - readyCache.at < 30_000) {
      return c.json(readyCache.body);
    }
    const checks: Record<string, string> = {};
    if (process.env.DATABASE_URL) {
      try {
        const probe = new URL(process.env.DATABASE_URL);
        checks.database = `configured (${probe.host})`;
      } catch {
        checks.database = 'error';
      }
    } else {
      checks.database = 'memory-fallback';
    }
    checks.modelKey = process.env.NEBIUS_API_KEY || process.env.NEBIUS_API_KEY_LOCATOR ? 'present' : 'missing';
    checks.ffmpeg = 'checked-on-worker'; // verified per-run by the live Watcher gate
    const body = { status: 'ok', checks };
    readyCache = { at: Date.now(), body };
    return c.json(body);
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
          }, 150);
          if (typeof pollInterval.unref === 'function') pollInterval.unref();

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
