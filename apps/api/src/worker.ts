import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { runPipeline, PipelineOptions, PipelineRunResult } from '@replay/agents';
import { RunEvent, RunState } from '@replay/shared';
import { getRunRepository, RunRecord, RunRepository, isKnownSampleId } from './runs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');

dotenv.config({ path: path.join(REPO_ROOT, '.env') });

export interface WorkerOptions {
  workerId?: string;
  pollIntervalMs?: number;
  staleTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  repoRoot?: string;
  repository?: RunRepository;
  maxFixAttempts?: number;
}

export class Worker {
  readonly workerId: string;
  private pollIntervalMs: number;
  private staleTimeoutMs: number;
  private heartbeatIntervalMs: number;
  private repoRoot: string;
  private repo: RunRepository;
  private maxFixAttempts: number;

  private isRunning = false;
  private isProcessing = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private staleTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private currentRunId: string | null = null;

  constructor(options?: WorkerOptions) {
    this.workerId = options?.workerId || `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
    this.pollIntervalMs = options?.pollIntervalMs || 1000;
    this.staleTimeoutMs = options?.staleTimeoutMs || 300000; // 5 minutes
    this.heartbeatIntervalMs = options?.heartbeatIntervalMs || 10000; // 10 seconds
    this.repoRoot = options?.repoRoot || REPO_ROOT;
    this.repo = options?.repository || getRunRepository();
    this.maxFixAttempts = options?.maxFixAttempts || 2;
  }

  get activeRunId(): string | null {
    return this.currentRunId;
  }

  get running(): boolean {
    return this.isRunning;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log(`[Replay Worker] Started worker ${this.workerId}`);

    // Initial stale recovery
    try {
      const recovered = await this.repo.recoverStaleRuns(this.staleTimeoutMs);
      if (recovered > 0) {
        console.log(`[Replay Worker] Recovered ${recovered} stale runs at startup`);
      }
    } catch (err) {
      console.warn('[Replay Worker] Stale recovery check error:', err);
    }

    // Start background recovery sweep every 60 seconds
    this.staleTimer = setInterval(async () => {
      try {
        await this.repo.recoverStaleRuns(this.staleTimeoutMs);
      } catch (err) {
        console.warn('[Replay Worker] Periodic stale recovery failed:', err);
      }
    }, 60000);

    // Start poll loop
    this.scheduleNextPoll(0);
  }

  private scheduleNextPoll(delayMs = this.pollIntervalMs): void {
    if (!this.isRunning) return;
    this.pollTimer = setTimeout(async () => {
      await this.pollOnce();
      this.scheduleNextPoll();
    }, delayMs);
  }

  async pollOnce(): Promise<RunRecord | null> {
    if (!this.isRunning || this.isProcessing) return null;

    try {
      const claimed = await this.repo.claimQueuedRun(this.workerId);
      if (!claimed) return null;

      this.isProcessing = true;
      this.currentRunId = claimed.id;
      console.log(`[Replay Worker ${this.workerId}] Claimed run ${claimed.id} (sample=${claimed.isSample}, key=${claimed.videoKey})`);

      await this.processRun(claimed);
      return claimed;
    } catch (err) {
      console.error(`[Replay Worker ${this.workerId}] Error in poll loop:`, err);
      return null;
    } finally {
      this.isProcessing = false;
      this.currentRunId = null;
      this.stopHeartbeat();
    }
  }

  private startHeartbeat(runId: string): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.repo.recordHeartbeat(runId, this.workerId);
      } catch (err) {
        console.warn(`[Replay Worker ${this.workerId}] Heartbeat update failed for ${runId}:`, err);
      }
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async processRun(run: RunRecord): Promise<void> {
    this.startHeartbeat(run.id);

    const startTime = Date.now();
    const targetRepo = path.resolve(this.repoRoot, 'targets/demo-shop');

    let sampleId: string | undefined;
    let videoPath: string;

    if (run.isSample && isKnownSampleId(run.videoKey)) {
      sampleId = run.videoKey;
      videoPath = path.resolve(this.repoRoot, `samples/videos/${sampleId}.webm`);
    } else {
      videoPath = path.isAbsolute(run.videoKey)
        ? run.videoKey
        : path.resolve(this.repoRoot, run.videoKey);
    }

    await this.repo.addEvent(run.id, {
      stage: 'ingest',
      agent: 'Worker',
      event_type: 'pipeline_started',
      payload: {
        workerId: this.workerId,
        targetRepo,
        videoPath,
        sampleId: sampleId ?? null,
      },
    });

    try {
      const pipelineOptions: PipelineOptions = {
        targetRepoRoot: targetRepo,
        sampleId,
        videoPath,
        maxFixAttempts: this.maxFixAttempts,
        runId: run.id,
        artifactsDir: path.resolve(this.repoRoot, `artifacts/runs/${run.id}`),
        onEvent: async (event: RunEvent) => {
          await this.repo.addEvent(run.id, {
            seq: event.seq,
            stage: event.stage,
            agent: event.agent,
            event_type: event.event_type,
            payload: event.payload,
            timestamp: event.timestamp,
          });
          await this.repo.updateRun(run.id, { stage: event.stage });
        },
      };

      const result: PipelineRunResult = await runPipeline(pipelineOptions);
      const durationMs = Date.now() - startTime;

      console.log(`[Replay Worker ${this.workerId}] Pipeline finished for ${run.id} with status: ${result.status} in ${durationMs}ms`);

      const finalState: RunState = result.status;
      await this.repo.updateRun(run.id, {
        state: finalState,
        stage: 'report',
        bugReport: result.bugReport,
        suspects: result.locatorOutput?.suspects ?? null,
        generatedTest: result.reproducerOutput?.test_code ?? null,
        beforeTestResult: result.reproducerOutput?.failure_message ?? null,
        sameSymptomVerdict: result.verifierOutput ?? null,
        diff: result.fixerOutput?.patch ?? null,
        afterTestResult: { passed: result.reproAfterFixPassed },
        suiteResult: { passed: result.baselineRegressionPassed },
        reportMarkdown: result.reporterOutput.markdown_report,
        durationMs,
        completedAt: new Date(),
        workerLock: null,
      });

      await this.repo.addEvent(run.id, {
        stage: 'report',
        agent: 'Worker',
        event_type: 'pipeline_completed',
        payload: {
          status: finalState,
          durationMs,
          reproPassed: result.reproAfterFixPassed,
          baselinePassed: result.baselineRegressionPassed,
        },
      });
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      console.error(`[Replay Worker ${this.workerId}] Pipeline failed for run ${run.id}:`, err);

      await this.repo.updateRun(run.id, {
        state: 'failed',
        durationMs,
        completedAt: new Date(),
        workerLock: null,
      });

      await this.repo.addEvent(run.id, {
        stage: run.stage,
        agent: 'Worker',
        event_type: 'pipeline_failed',
        payload: {
          error: err?.message || String(err),
          durationMs,
        },
      });
    } finally {
      this.stopHeartbeat();
    }
  }

  async stop(): Promise<void> {
    console.log(`[Replay Worker ${this.workerId}] Shutting down...`);
    this.isRunning = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
    this.stopHeartbeat();

    // Release active lock if interrupted
    if (this.currentRunId) {
      try {
        console.log(`[Replay Worker ${this.workerId}] Releasing lock on active run ${this.currentRunId}`);
        await this.repo.releaseRunLock(this.currentRunId, this.workerId, 'queued');
      } catch (err) {
        console.error(`[Replay Worker ${this.workerId}] Failed to release lock on run ${this.currentRunId}:`, err);
      }
      this.currentRunId = null;
    }

    console.log(`[Replay Worker ${this.workerId}] Stopped cleanly.`);
  }
}

// Standalone execution entrypoint
if (process.env.NODE_ENV !== 'test' && !process.env.REPLAY_STANDALONE_DISABLED) {
  const isDirectRun = process.argv[1]?.endsWith('worker.ts') || process.argv[1]?.endsWith('worker.js');
  if (isDirectRun) {
    const worker = new Worker();
    worker.start().catch((err) => {
      console.error('[Replay Worker] Fatal error:', err);
      process.exit(1);
    });

    const shutdown = async (signal: string) => {
      console.log(`[Replay Worker] Received ${signal}`);
      await worker.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }
}
