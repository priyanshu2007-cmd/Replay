'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { VideoPanel, type VideoStep } from '@/components/video-panel';
import { Timeline } from '@/components/timeline';
import { CodeTabs } from '@/components/code-tabs';
import { EvidenceCard } from '@/components/evidence-card';
import { ReportView } from '@/components/report-view';
import { StatusPill } from '@/components/status-pill';
import { Skeleton } from '@/components/ui/skeleton';
import { ReplayBanner } from '@/components/replay-banner';
import { getRun, type RunDetail, type RunStage } from '@/lib/api';
import { useRunEvents } from '@/hooks/use-run-events';
import { getReplayEvents, getReplayRun } from '@/lib/replay';

const TERMINAL = new Set(['fixed', 'reproduced_only', 'unreproduced', 'failed']);

export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [replay, setReplay] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seekTo, setSeekTo] = useState<number | null>(null);
  const soughtFailure = useRef(false);

  useEffect(() => {
    void params.then((p) => setRunId(p.id));
  }, [params]);

  const fetchRun = useCallback(async (id: string) => {
    try {
      const detail = await getRun(id);
      setRun(detail);
      setError(null);
    } catch (liveErr) {
      // Live failed: try stored sample runs (replay mode), else report honestly.
      const stored = await getReplayRun(id);
      if (stored) {
        setRun(stored);
        setReplay(true);
        return;
      }
      setError((liveErr as Error).message || 'Could not load this run.');
    }
  }, []);

  useEffect(() => {
    if (runId) void fetchRun(runId);
  }, [runId, fetchRun]);

  const liveStream = runId !== null && run !== null && !replay && !TERMINAL.has(run.state);
  const { events, status: sseStatus } = useRunEvents(runId ?? '', liveStream);

  // Replay mode: load stored events once.
  const [replayEvents, setReplayEvents] = useState<ReturnType<typeof Object> | null>(null);
  useEffect(() => {
    if (!replay || !runId) return;
    void getReplayEvents(runId).then((stored) => {
      if (stored) setReplayEvents(stored as never);
    });
  }, [replay, runId]);

  const allEvents = replay ? ((replayEvents as never) as typeof events) : events;

  // Refresh the run when the pipeline finishes or the Watcher completes
  // (the BugReport with steps and the failure timestamp arrives then).
  useEffect(() => {
    if (allEvents.some((e) => e.event_type === 'pipeline_completed' || e.event_type === 'pipeline_failed') && runId) {
      void fetchRun(runId);
    }
    const watchDone = allEvents.find((e) => e.event_type === 'watch_completed');
    if (watchDone && runId) void fetchRun(runId);
  }, [allEvents, runId, fetchRun]);

  // Jump the video to the failure frame once, when it is known.
  const failureTs = run?.outputs.bugReport?.first_failure_timestamp_s ?? null;
  useEffect(() => {
    if (failureTs !== null && !soughtFailure.current) {
      soughtFailure.current = true;
      setSeekTo(failureTs);
    }
  }, [failureTs]);

  // Tell the mascot what the pipeline is doing (it maps stages to moods).
  const runStage = run?.stage ?? null;
  const runState = run?.state ?? null;
  useEffect(() => {
    if (!runStage) return;
    window.dispatchEvent(new CustomEvent('replay:mascot', { detail: { kind: 'stage', stage: runStage } }));
  }, [runStage]);
  useEffect(() => {
    if (!runState || !TERMINAL.has(runState)) return;
    window.dispatchEvent(new CustomEvent('replay:mascot', { detail: { kind: 'state', state: runState } }));
  }, [runState]);

  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16">
        <h1 className="text-page text-primary">Run not found</h1>
        <p className="mt-2 text-[14px] text-secondary">{error}</p>
        <Link href="/" className="mt-4 inline-block text-[14px] text-accent underline">
          Back to home
        </Link>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-6">
        <Skeleton className="mb-4 h-9 w-64" />
        <div className="grid gap-4 lg:grid-cols-[4fr_4fr_5fr]">
          <Skeleton className="aspect-video w-full" />
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  const bug = run.outputs.bugReport;
  const steps: VideoStep[] =
    bug?.summary !== undefined && Array.isArray((bug as { steps?: Array<{ timestamp_s: number; description: string }> }).steps)
      ? ((bug as { steps: Array<{ timestamp_s: number; description: string }> }).steps ?? []).map((s) => ({
          timestampS: s.timestamp_s,
          description: s.description,
        }))
      : [];
  const videoSrc = run.isSample && /^[a-z0-9-]+$/.test(run.videoKey) ? `/samples/${run.videoKey}.webm` : null;
  const tokens = run.metrics.totalTokens;
  const cost = run.metrics.estimatedCostUsd;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      {replay && <ReplayBanner />}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Link
          href="/"
          aria-label="Back to home"
          className="flex h-8 w-8 items-center justify-center rounded-s text-secondary transition-colors duration-150 ease-out hover:text-primary"
        >
          <ArrowLeft size={16} aria-hidden />
        </Link>
        <h1 className="font-mono text-[14px] text-secondary">{run.id}</h1>
        <StatusPill state={run.state} large announce />
        <div className="ml-auto flex items-center gap-4 font-mono text-[12px] text-secondary">
          {tokens !== null && <span>{tokens.toLocaleString()} tokens</span>}
          {cost !== null && <span>${cost} est.</span>}
          {run.metrics.durationMs !== null && <span>{(run.metrics.durationMs / 1000).toFixed(1)}s</span>}
          {sseStatus === 'reconnecting' && <span className="text-progress">reconnecting</span>}
        </div>
      </div>

      {run.state === 'queued' && (
        <p className="mb-4 rounded-s border border-border-subtle bg-panel px-3 py-2 text-[13px] text-secondary">
          Waiting for a worker to claim this run. In local mode the API runs one automatically; with Postgres,
          start the worker with pnpm dev:worker.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[4fr_4fr_5fr]">
        <VideoPanel src={videoSrc} steps={steps} failureTimestampS={failureTs} seekTo={seekTo} />
        <Timeline events={allEvents} currentStage={(run.stage as RunStage) ?? null} />
        <CodeTabs run={run} />
      </div>

      <div className="mt-4 grid gap-4">
        <EvidenceCard videoSrc={videoSrc} failureTimestampS={failureTs} verdict={run.outputs.sameSymptomVerdict} />
        <ReportView run={run} />
      </div>
    </div>
  );
}
