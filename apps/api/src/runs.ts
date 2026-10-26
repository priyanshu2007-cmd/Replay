import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { RunEvent, RunStage, RunState } from '@replay/shared';
import { createDb, runs, runEvents, DbClient } from '@replay/db';
import { eq, asc, desc, lt, and } from 'drizzle-orm';

export interface RunRecord {
  id: string;
  targetId: string;
  videoKey: string;
  note: string | null;
  state: RunState;
  stage: RunStage;
  isSample: boolean;
  workerLock: string | null;
  workerHeartbeat: Date | null;
  bugReport: any | null;
  suspects: any | null;
  generatedTest: string | null;
  beforeTestResult: any | null;
  sameSymptomVerdict: any | null;
  diff: string | null;
  afterTestResult: any | null;
  suiteResult: any | null;
  reportMarkdown: string | null;
  totalTokens: number | null;
  estimatedCostUsd: string | null;
  durationMs: number | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface CreateRunInput {
  targetId?: string;
  videoKey: string;
  note?: string;
  isSample?: boolean;
}

export interface RunRepository {
  createRun(input: CreateRunInput): Promise<RunRecord>;
  getRun(id: string): Promise<RunRecord | null>;
  listRuns(limit?: number): Promise<RunRecord[]>;
  updateRun(id: string, updates: Partial<RunRecord>): Promise<RunRecord | null>;
  claimQueuedRun(workerId: string): Promise<RunRecord | null>;
  recordHeartbeat(runId: string, workerId: string): Promise<void>;
  releaseRunLock(runId: string, workerId: string, nextState?: RunState): Promise<void>;
  recoverStaleRuns(staleTimeoutMs: number): Promise<number>;
  addEvent(runId: string, event: Omit<RunEvent, 'seq' | 'run_id' | 'timestamp'> & { timestamp?: string }): Promise<RunEvent>;
  getEvents(runId: string): Promise<RunEvent[]>;
  subscribeEvents(runId: string, listener: (event: RunEvent) => void): () => void;
}

/**
 * Safety net for event payloads reaching every client: replace any string that
 * looks like an absolute server path with a relative label.
 */
function REPO_ROOT_DATA(): string {
  return process.env.REPLAY_DATA_DIR || process.cwd();
}

function sanitizeEventPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const looksAbsolute = /^\/(Users|home|app|tmp|root|var)\b|^\\\\|^C:\\\\/i;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string' && looksAbsolute.test(value)) {
      out[key] = value.split('/').pop() || '[path]';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = sanitizeEventPayload(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export const KNOWN_SAMPLE_IDS = [
  'cart-nan',
  'double-discount',
  'string-sort',
  'empty-email',
  'quantity-reset',
] as const;

export type SampleId = typeof KNOWN_SAMPLE_IDS[number];

export function isKnownSampleId(id: string): id is SampleId {
  return (KNOWN_SAMPLE_IDS as readonly string[]).includes(id);
}

export interface SampleDefinition {
  id: SampleId;
  title: string;
  targetId: string;
  videoPath: string;
  expectedPath: string;
}

export function getSampleDefinition(id: SampleId, repoRoot = process.cwd()): SampleDefinition {
  return {
    id,
    title: id,
    targetId: 'demo-shop',
    videoPath: path.resolve(repoRoot, `samples/videos/${id}.webm`),
    expectedPath: path.resolve(repoRoot, `samples/${id}/expected.json`),
  };
}

/**
 * Thread-safe In-Memory Run Repository with optional JSON file backup.
 * Provides full fidelity when PostgreSQL is unconfigured or in tests.
 */
export class MemoryRunRepository implements RunRepository {
  private runs = new Map<string, RunRecord>();
  private events = new Map<string, RunEvent[]>();
  private emitter = new EventEmitter();
  private persistPath?: string;

  constructor(options?: { persistPath?: string }) {
    this.persistPath = options?.persistPath;
    this.emitter.setMaxListeners(100);
    if (this.persistPath) {
      this.loadFromFile();
    }
  }

  private loadFromFile(): void {
    if (!this.persistPath) return;
    try {
      if (fs.existsSync(this.persistPath)) {
        const raw = fs.readFileSync(this.persistPath, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data.runs)) {
          for (const r of data.runs) {
            this.runs.set(r.id, {
              ...r,
              createdAt: new Date(r.createdAt),
              updatedAt: new Date(r.updatedAt),
              workerHeartbeat: r.workerHeartbeat ? new Date(r.workerHeartbeat) : null,
              completedAt: r.completedAt ? new Date(r.completedAt) : null,
            });
          }
        }
        if (data.events && typeof data.events === 'object') {
          for (const [runId, evList] of Object.entries(data.events)) {
            if (Array.isArray(evList)) {
              this.events.set(runId, evList as RunEvent[]);
            }
          }
        }
      }
    } catch {
      // Ignore corrupted or missing local cache
    }
  }

  private saveToFile(): void {
    if (!this.persistPath) return;
    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = {
        runs: Array.from(this.runs.values()),
        events: Object.fromEntries(this.events.entries()),
      };
      fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2), 'utf8');
    } catch {
      // Best-effort cache save
    }
  }

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    const id = randomUUID();
    const now = new Date();
    const record: RunRecord = {
      id,
      targetId: input.targetId || 'demo-shop',
      videoKey: input.videoKey,
      note: input.note || null,
      state: 'queued',
      stage: 'ingest',
      isSample: Boolean(input.isSample),
      workerLock: null,
      workerHeartbeat: null,
      bugReport: null,
      suspects: null,
      generatedTest: null,
      beforeTestResult: null,
      sameSymptomVerdict: null,
      diff: null,
      afterTestResult: null,
      suiteResult: null,
      reportMarkdown: null,
      totalTokens: null,
      estimatedCostUsd: null,
      durationMs: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };

    this.runs.set(id, record);
    this.events.set(id, []);
    this.saveToFile();
    return record;
  }

  async getRun(id: string): Promise<RunRecord | null> {
    const record = this.runs.get(id);
    return record ? { ...record } : null;
  }

  async listRuns(limit = 50): Promise<RunRecord[]> {
    const list = Array.from(this.runs.values());
    const sorted = list
      .sort((a, b) => {
        const diff = b.createdAt.getTime() - a.createdAt.getTime();
        if (diff !== 0) return diff;
        return list.indexOf(b) - list.indexOf(a);
      })
      .slice(0, limit);
    return sorted.map((r) => ({ ...r }));
  }

  async updateRun(id: string, updates: Partial<RunRecord>): Promise<RunRecord | null> {
    const current = this.runs.get(id);
    if (!current) return null;

    const updated: RunRecord = {
      ...current,
      ...updates,
      updatedAt: new Date(),
    };
    this.runs.set(id, updated);
    this.saveToFile();
    return { ...updated };
  }

  async claimQueuedRun(workerId: string): Promise<RunRecord | null> {
    // Find oldest queued run
    const candidates = Array.from(this.runs.values())
      .filter((r) => r.state === 'queued' && !r.workerLock)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    if (candidates.length === 0 || !candidates[0]) return null;
    const run = candidates[0];

    const now = new Date();
    const updated: RunRecord = {
      ...run,
      state: 'running',
      workerLock: workerId,
      workerHeartbeat: now,
      updatedAt: now,
    };
    this.runs.set(run.id, updated);
    this.saveToFile();
    return { ...updated };
  }

  async recordHeartbeat(runId: string, workerId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    if (run.workerLock !== workerId) return;

    run.workerHeartbeat = new Date();
    run.updatedAt = new Date();
    this.saveToFile();
  }

  async releaseRunLock(runId: string, workerId: string, nextState?: RunState): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    if (run.workerLock !== workerId) return;

    run.workerLock = null;
    if (nextState) {
      run.state = nextState;
    }
    run.updatedAt = new Date();
    this.saveToFile();
  }

  async recoverStaleRuns(staleTimeoutMs: number): Promise<number> {
    const cutoff = Date.now() - staleTimeoutMs;
    let recovered = 0;

    for (const run of this.runs.values()) {
      if (run.state === 'running' && run.workerLock) {
        const lastBeat = run.workerHeartbeat ? run.workerHeartbeat.getTime() : run.updatedAt.getTime();
        if (lastBeat < cutoff) {
          run.state = 'failed';
          run.workerLock = null;
          run.updatedAt = new Date();
          recovered++;

          await this.addEvent(run.id, {
            stage: run.stage,
            agent: 'Worker',
            event_type: 'worker_timeout_recovered',
            payload: {
              reason: `Run timed out with no heartbeat for ${Math.round(staleTimeoutMs / 1000)}s`,
              previousWorker: run.workerLock,
            },
          });
        }
      }
    }

    if (recovered > 0) {
      this.saveToFile();
    }
    return recovered;
  }

  async addEvent(
    runId: string,
    event: Omit<RunEvent, 'seq' | 'run_id' | 'timestamp'> & { timestamp?: string }
  ): Promise<RunEvent> {
    let list = this.events.get(runId);
    if (!list) {
      list = [];
      this.events.set(runId, list);
    }

    // The repository owns seq: monotonic per run, gap-free under concurrency
    // (Node runs this block on one thread).
    const seq = list.length > 0 ? (list[list.length - 1]!.seq ?? 0) + 1 : 1;
    const fullEvent: RunEvent = {
      run_id: runId,
      seq,
      stage: event.stage,
      agent: event.agent,
      event_type: event.event_type,
      payload: sanitizeEventPayload(event.payload),
      timestamp: event.timestamp ?? new Date().toISOString(),
    };

    list.push(fullEvent);
    this.emitter.emit(`events:${runId}`, fullEvent);
    this.saveToFile();
    return fullEvent;
  }

  async getEvents(runId: string): Promise<RunEvent[]> {
    const list = this.events.get(runId) || [];
    return [...list].sort((a, b) => a.seq - b.seq);
  }

  subscribeEvents(runId: string, listener: (event: RunEvent) => void): () => void {
    const eventName = `events:${runId}`;
    this.emitter.on(eventName, listener);
    return () => {
      this.emitter.off(eventName, listener);
    };
  }

  // Clear everything for isolated unit tests
  clear(): void {
    this.runs.clear();
    this.events.clear();
  }
}

/**
 * PostgreSQL Run Repository using Drizzle ORM.
 * Implements atomic FOR UPDATE SKIP LOCKED job claiming and ACID transactions.
 */
export class PostgresRunRepository implements RunRepository {
  private db: DbClient;
  private emitter = new EventEmitter();

  constructor(db: DbClient) {
    this.db = db;
    this.emitter.setMaxListeners(100);
  }

  private mapRowToRun(row: any): RunRecord {
    return {
      id: row.id,
      targetId: row.targetId,
      videoKey: row.videoKey,
      note: row.note ?? null,
      state: row.state as RunState,
      stage: row.stage as RunStage,
      isSample: Boolean(row.isSample),
      workerLock: row.workerLock ?? null,
      workerHeartbeat: row.workerHeartbeat ? new Date(row.workerHeartbeat) : null,
      bugReport: row.bugReport ?? null,
      suspects: row.suspects ?? null,
      generatedTest: row.generatedTest ?? null,
      beforeTestResult: row.beforeTestResult ?? null,
      sameSymptomVerdict: row.sameSymptomVerdict ?? null,
      diff: row.diff ?? null,
      afterTestResult: row.afterTestResult ?? null,
      suiteResult: row.suiteResult ?? null,
      reportMarkdown: row.reportMarkdown ?? null,
      totalTokens: row.totalTokens ?? null,
      estimatedCostUsd: row.estimatedCostUsd ?? null,
      durationMs: row.durationMs ?? null,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
      completedAt: row.completedAt ? new Date(row.completedAt) : null,
    };
  }

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    const [row] = await this.db
      .insert(runs)
      .values({
        targetId: input.targetId || 'demo-shop',
        videoKey: input.videoKey,
        note: input.note || null,
        state: 'queued',
        stage: 'ingest',
        isSample: Boolean(input.isSample),
      })
      .returning();

    return this.mapRowToRun(row);
  }

  async getRun(id: string): Promise<RunRecord | null> {
    const rows = await this.db.select().from(runs).where(eq(runs.id, id)).limit(1);
    return rows.length > 0 ? this.mapRowToRun(rows[0]) : null;
  }

  async listRuns(limit = 50): Promise<RunRecord[]> {
    const rows = await this.db
      .select()
      .from(runs)
      .orderBy(desc(runs.createdAt))
      .limit(limit);

    return rows.map((r) => this.mapRowToRun(r));
  }

  async updateRun(id: string, updates: Partial<RunRecord>): Promise<RunRecord | null> {
    const setValues: Record<string, any> = {
      updatedAt: new Date(),
    };

    if (updates.state !== undefined) setValues.state = updates.state;
    if (updates.stage !== undefined) setValues.stage = updates.stage;
    if (updates.workerLock !== undefined) setValues.workerLock = updates.workerLock;
    if (updates.workerHeartbeat !== undefined) setValues.workerHeartbeat = updates.workerHeartbeat;
    if (updates.bugReport !== undefined) setValues.bugReport = updates.bugReport;
    if (updates.suspects !== undefined) setValues.suspects = updates.suspects;
    if (updates.generatedTest !== undefined) setValues.generatedTest = updates.generatedTest;
    if (updates.beforeTestResult !== undefined) setValues.beforeTestResult = updates.beforeTestResult;
    if (updates.sameSymptomVerdict !== undefined) setValues.sameSymptomVerdict = updates.sameSymptomVerdict;
    if (updates.diff !== undefined) setValues.diff = updates.diff;
    if (updates.afterTestResult !== undefined) setValues.afterTestResult = updates.afterTestResult;
    if (updates.suiteResult !== undefined) setValues.suiteResult = updates.suiteResult;
    if (updates.reportMarkdown !== undefined) setValues.reportMarkdown = updates.reportMarkdown;
    if (updates.totalTokens !== undefined) setValues.totalTokens = updates.totalTokens;
    if (updates.estimatedCostUsd !== undefined) setValues.estimatedCostUsd = updates.estimatedCostUsd;
    if (updates.durationMs !== undefined) setValues.durationMs = updates.durationMs;
    if (updates.completedAt !== undefined) setValues.completedAt = updates.completedAt;

    const rows = await this.db
      .update(runs)
      .set(setValues)
      .where(eq(runs.id, id))
      .returning();

    return rows.length > 0 ? this.mapRowToRun(rows[0]) : null;
  }

  async claimQueuedRun(workerId: string): Promise<RunRecord | null> {
    // Transaction with FOR UPDATE SKIP LOCKED
    const claimed = await this.db.transaction(async (tx) => {
      const candidates = await tx
        .select()
        .from(runs)
        .where(eq(runs.state, 'queued'))
        .orderBy(asc(runs.createdAt))
        .limit(1)
        .for('update', { skipLocked: true });

      if (candidates.length === 0 || !candidates[0]) return null;

      const candidate = candidates[0];
      const now = new Date();
      const [updated] = await tx
        .update(runs)
        .set({
          state: 'running',
          workerLock: workerId,
          workerHeartbeat: now,
          updatedAt: now,
        })
        .where(eq(runs.id, candidate.id))
        .returning();

      return updated;
    });

    return claimed ? this.mapRowToRun(claimed) : null;
  }

  async recordHeartbeat(runId: string, workerId: string): Promise<void> {
    await this.db
      .update(runs)
      .set({
        workerHeartbeat: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(runs.id, runId), eq(runs.workerLock, workerId)));
  }

  async releaseRunLock(runId: string, workerId: string, nextState?: RunState): Promise<void> {
    const values: Record<string, any> = {
      workerLock: null,
      updatedAt: new Date(),
    };
    if (nextState) {
      values.state = nextState;
    }

    await this.db
      .update(runs)
      .set(values)
      .where(and(eq(runs.id, runId), eq(runs.workerLock, workerId)));
  }

  async recoverStaleRuns(staleTimeoutMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - staleTimeoutMs);
    const staleRows = await this.db
      .select({ id: runs.id, stage: runs.stage, workerLock: runs.workerLock })
      .from(runs)
      .where(and(eq(runs.state, 'running'), lt(runs.workerHeartbeat, cutoff)));

    if (staleRows.length === 0) return 0;

    for (const row of staleRows) {
      await this.db
        .update(runs)
        .set({
          state: 'failed',
          workerLock: null,
          updatedAt: new Date(),
        })
        .where(eq(runs.id, row.id));

      await this.addEvent(row.id, {
        stage: row.stage as RunStage,
        agent: 'Worker',
        event_type: 'worker_timeout_recovered',
        payload: {
          reason: `Run timed out with no heartbeat for ${Math.round(staleTimeoutMs / 1000)}s`,
          previousWorker: row.workerLock,
        },
      });
    }

    return staleRows.length;
  }

  async addEvent(
    runId: string,
    event: Omit<RunEvent, 'seq' | 'run_id' | 'timestamp'> & { timestamp?: string }
  ): Promise<RunEvent> {
    // Atomic, race-free seq: one transaction holds an advisory lock on the run
    // and computes max(seq)+1 in the same INSERT. No SELECT-then-INSERT race.
    const timestamp = event.timestamp ?? new Date().toISOString();
    const inserted = await (this.db as unknown as {
      $client: { begin: (fn: (tx: any) => Promise<any>) => Promise<any> };
    }).$client.begin(async (tx: any) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${runId}))`;
      const rows = await tx`
        INSERT INTO run_events (run_id, seq, stage, agent, event_type, payload, created_at)
        SELECT ${runId}, COALESCE(MAX(seq), 0) + 1, ${event.stage}, ${event.agent},
               ${event.event_type}, ${JSON.stringify(sanitizeEventPayload(event.payload))}::jsonb,
               ${new Date(timestamp)}
        FROM run_events WHERE run_id = ${runId}
        RETURNING seq, created_at`;
      return rows[0];
    });

    const nextSeq = Number(inserted?.seq ?? 1);

    const fullEvent: RunEvent = {
      run_id: runId,
      seq: nextSeq,
      stage: event.stage,
      agent: event.agent,
      event_type: event.event_type,
      payload: event.payload,
      timestamp,
    };

    this.emitter.emit(`events:${runId}`, fullEvent);
    return fullEvent;
  }

  async getEvents(runId: string): Promise<RunEvent[]> {
    const rows = await this.db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(asc(runEvents.seq));

    return rows.map((r) => ({
      run_id: r.runId,
      seq: r.seq,
      stage: r.stage as RunStage,
      agent: r.agent,
      event_type: r.eventType,
      payload: r.payload as Record<string, unknown>,
      timestamp: new Date(r.createdAt).toISOString(),
    }));
  }

  subscribeEvents(runId: string, listener: (event: RunEvent) => void): () => void {
    const eventName = `events:${runId}`;
    this.emitter.on(eventName, listener);
    return () => {
      this.emitter.off(eventName, listener);
    };
  }
}

// Global active repository singleton
let currentRepo: RunRepository | null = null;

export function getRunRepository(): RunRepository {
  if (currentRepo) return currentRepo;

  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl && dbUrl.trim() !== '') {
    // A configured database is a promise: never silently fall back to memory,
    // or runs "disappear" between API and worker processes.
    currentRepo = new PostgresRunRepository(createDb(dbUrl));
    return currentRepo;
  }

  const persistPath = path.resolve(process.env.REPLAY_DATA_DIR || REPO_ROOT_DATA(), 'artifacts/runs.json');
  currentRepo = new MemoryRunRepository({ persistPath });
  return currentRepo;
}

export function setRunRepository(repo: RunRepository | null): void {
  currentRepo = repo;
}
