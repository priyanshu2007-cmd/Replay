import { test, describe, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { Worker } from './worker.js';
import { MemoryRunRepository } from './runs.js';

describe('Replay Background Worker', () => {
  let repo: MemoryRunRepository;

  beforeEach(() => {
    repo = new MemoryRunRepository();
  });

  describe('Job claiming and concurrency protection', () => {
    test('Worker atomically claims queued run and ignores runs claimed by others', async () => {
      const run1 = await repo.createRun({ videoKey: 'cart-nan', isSample: true });
      const run2 = await repo.createRun({ videoKey: 'double-discount', isSample: true });

      const workerA = new Worker({ workerId: 'worker-A', repository: repo });
      const workerB = new Worker({ workerId: 'worker-B', repository: repo });

      // Worker A claims first
      const claimedA = await repo.claimQueuedRun(workerA.workerId);
      assert.ok(claimedA);
      assert.equal(claimedA.id, run1.id);
      assert.equal(claimedA.state, 'running');
      assert.equal(claimedA.workerLock, 'worker-A');

      // Worker B claims next
      const claimedB = await repo.claimQueuedRun(workerB.workerId);
      assert.ok(claimedB);
      assert.equal(claimedB.id, run2.id);
      assert.equal(claimedB.state, 'running');
      assert.equal(claimedB.workerLock, 'worker-B');

      // No more queued runs
      const claimedNone = await repo.claimQueuedRun(workerA.workerId);
      assert.equal(claimedNone, null);
    });

    test('Claimed run cannot be claimed again until lock is released', async () => {
      const run = await repo.createRun({ videoKey: 'cart-nan', isSample: true });

      const claimed1 = await repo.claimQueuedRun('worker-1');
      assert.ok(claimed1);
      assert.equal(claimed1.workerLock, 'worker-1');

      // Attempt second claim
      const claimed2 = await repo.claimQueuedRun('worker-2');
      assert.equal(claimed2, null);

      // Release lock and reset state to queued
      await repo.releaseRunLock(run.id, 'worker-1', 'queued');

      // Now worker-2 can claim
      const claimed3 = await repo.claimQueuedRun('worker-2');
      assert.ok(claimed3);
      assert.equal(claimed3.workerLock, 'worker-2');
    });
  });

  describe('Worker Heartbeat and Stale Run Recovery', () => {
    test('recordHeartbeat updates heartbeat timestamp', async () => {
      const run = await repo.createRun({ videoKey: 'cart-nan', isSample: true });
      await repo.claimQueuedRun('worker-1');

      const initial = await repo.getRun(run.id);
      assert.ok(initial?.workerHeartbeat);

      // Record heartbeat
      await repo.recordHeartbeat(run.id, 'worker-1');
      const updated = await repo.getRun(run.id);
      assert.ok(updated?.workerHeartbeat);
      assert.ok(updated.workerHeartbeat.getTime() >= initial.workerHeartbeat.getTime());
    });

    test('recoverStaleRuns recovers abandoned runs with dead heartbeats', async () => {
      const run = await repo.createRun({ videoKey: 'cart-nan', isSample: true });
      await repo.claimQueuedRun('dead-worker');

      // Simulate dead worker: set heartbeat to 10 minutes ago
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      await repo.updateRun(run.id, {
        workerHeartbeat: tenMinutesAgo,
        updatedAt: tenMinutesAgo,
      });

      // Run recovery with 5 minute threshold
      const recoveredCount = await repo.recoverStaleRuns(5 * 60 * 1000);
      assert.equal(recoveredCount, 1);

      const recoveredRun = await repo.getRun(run.id);
      assert.ok(recoveredRun);
      assert.equal(recoveredRun.state, 'failed');
      assert.equal(recoveredRun.workerLock, null);

      // Verify event was recorded
      const events = await repo.getEvents(run.id);
      const timeoutEvent = events.find((e) => e.event_type === 'worker_timeout_recovered');
      assert.ok(timeoutEvent);
      assert.equal(timeoutEvent.agent, 'Worker');
    });

    test('Active runs with recent heartbeat are not recovered', async () => {
      const run = await repo.createRun({ videoKey: 'cart-nan', isSample: true });
      await repo.claimQueuedRun('active-worker');

      // Run recovery with 5 minute threshold
      const recoveredCount = await repo.recoverStaleRuns(5 * 60 * 1000);
      assert.equal(recoveredCount, 0);

      const activeRun = await repo.getRun(run.id);
      assert.equal(activeRun?.state, 'running');
      assert.equal(activeRun?.workerLock, 'active-worker');
    });
  });

  describe('Worker Lifecycle and Graceful Shutdown', () => {
    test('start() starts polling and stop() cleanly halts and releases locks', async () => {
      await repo.createRun({ videoKey: 'cart-nan', isSample: true });
      const worker = new Worker({
        workerId: 'lifecycle-worker',
        repository: repo,
        pollIntervalMs: 50,
      });

      await worker.start();
      assert.equal(worker.running, true);

      // Stop worker
      await worker.stop();
      assert.equal(worker.running, false);
      assert.equal(worker.activeRunId, null);
    });

    test('Interrupted worker releases lock back to queued state on stop()', async () => {
      const run = await repo.createRun({ videoKey: 'cart-nan', isSample: true });
      const worker = new Worker({
        workerId: 'stopping-worker',
        repository: repo,
      });

      // Claim run directly
      await repo.claimQueuedRun(worker.workerId);

      // Force worker internal activeRunId
      (worker as any).currentRunId = run.id;

      await worker.stop();

      const runAfterStop = await repo.getRun(run.id);
      assert.ok(runAfterStop);
      assert.equal(runAfterStop.state, 'queued');
      assert.equal(runAfterStop.workerLock, null);
    });
  });
});
