'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ChevronDown, ChevronUp } from 'lucide-react';
import { VideoPanel, type VideoStep } from '@/components/video-panel';
import { Timeline } from '@/components/timeline';
import { CodeTabs } from '@/components/code-tabs';
import { EvidenceCard } from '@/components/evidence-card';
import { ReportView } from '@/components/report-view';
import { StatusPill } from '@/components/status-pill';
import { Skeleton } from '@/components/ui/skeleton';
import { ReplayBanner } from '@/components/replay-banner';
import { API_BASE, getRun, rerunRun, type RunDetail, type RunStage, type RunEvent } from '@/lib/api';
import { useRunEvents } from '@/hooks/use-run-events';
import { getReplayEvents, getReplayRun } from '@/lib/replay';
import type { AgentActivityItem } from '@/components/mascot/mascot.config';

const TERMINAL = new Set(['fixed', 'reproduced_only', 'unreproduced', 'failed']);

/** Plain-English causes for model-error codes shown in the error panel. */
const CAUSE_COPY: Record<string, string> = {
  auth: 'The model API key was rejected. Check NEBIUS_API_KEY.',
  model_not_found: 'The model ID is not available on the provider. Check MODEL_<ROLE> values.',
  rate_limited: 'The provider rate limit was hit. Retry shortly.',
  unreachable: 'The model provider could not be reached. Check network and NEBIUS_BASE_URL.',
  bad_output: 'The model returned unusable output after a bounded retry.',
  unknown: 'The model call failed for an unexpected reason.',
};

const STAGE_WORDS: Record<RunStage, string> = {
  ingest: 'Preparing the recording',
  watch: 'Watching the recording',
  locate: 'Locating suspect code',
  reproduce: 'Writing a Playwright test',
  verify: 'Comparing the failure evidence',
  fix: 'Patching the code',
  report: 'Writing the report',
};

interface ErrorInfo {
  stage: RunStage;
  code: string | null;
  model: string | null;
  message: string;
}

export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [replay, setReplay] = useState(false);
  const [replayEvents, setReplayEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [seekTo, setSeekTo] = useState<number | null>(null);
  const [rerunning, setRerunning] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const [activeCodeTab, setActiveCodeTab] = useState('suspects');
  const soughtFailure = useRef(false);
  const fetchedWatch = useRef(false);
  const fetchedDone = useRef(false);

  useEffect(() => {
    function onFocusPanel(e: Event) {
      const tab = (e as CustomEvent<{ tab?: string }>).detail?.tab;
      if (!tab) return;
      if (tab === 'report') {
        document.getElementById('report')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (['suspects', 'test', 'diff', 'terminal'].includes(tab)) {
        setActiveCodeTab(tab);
      }
    }
    window.addEventListener('replay:focus-panel', onFocusPanel);
    return () => window.removeEventListener('replay:focus-panel', onFocusPanel);
  }, []);

  useEffect(() => {
    void params.then((p) => setRunId(p.id));
  }, [params]);

  const fetchRun = useCallback(async (id: string) => {
    try {
      const detail = await getRun(id);
      setRun(detail);
      setError(null);
    } catch (liveErr) {
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

  const isTerminal = run !== null && TERMINAL.has(run.state);
  const liveStream = runId !== null && run !== null && !replay && !isTerminal;
  const {
    events,
    mode: streamMode,
    loading: eventsLoading,
    error: eventsError,
    reload: reloadEvents,
  } = useRunEvents(runId ?? '', {
    liveStream,
    enabled: Boolean(runId),
  });

  // Replay mode: load stored events once, play them at recorded speed (capped gaps).
  useEffect(() => {
    if (!replay || !runId) return;
    let cancelled = false;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    void getReplayEvents(runId).then((stored) => {
      if (cancelled || !stored || stored.length === 0) return;
      // Play back at recorded pace, capping long gaps at 2s.
      let acc = 0;
      let prev = 0;
      const timed = stored.map((ev) => {
        const t = new Date(ev.timestamp).getTime();
        const delta = prev === 0 ? 0 : Math.min((t - prev) / 4, 2000);
        prev = t;
        acc += delta;
        return { ev, at: acc };
      });
      setReplayEvents([]);
      for (const { ev, at } of timed) {
        const tid = setTimeout(() => {
          if (!cancelled) {
            setReplayEvents((prevEvents) => [...prevEvents, ev]);
          }
        }, at);
        timers.push(tid);
      }
    });
    return () => {
      cancelled = true;
      for (const tid of timers) clearTimeout(tid);
    };
  }, [replay, runId]);

  const allEvents = replay ? replayEvents : events;

  // The current stage comes from the latest event, not the (stale) run record.
  const currentStage: RunStage | null =
    allEvents.length > 0 ? allEvents[allEvents.length - 1]!.stage : (run?.stage as RunStage) ?? null;

  // Refetch the run at meaningful points only: once when the Watcher finishes,
  // once when the pipeline completes or fails.
  useEffect(() => {
    if (!runId) return;
    if (!fetchedWatch.current && allEvents.some((e) => e.event_type === 'watch_completed')) {
      fetchedWatch.current = true;
      void fetchRun(runId);
    }
    const done = allEvents.find(
      (e) => e.event_type === 'pipeline_completed' || e.event_type === 'pipeline_failed',
    );
    if (done && !fetchedDone.current) {
      fetchedDone.current = true;
      void fetchRun(runId);
    }
  }, [allEvents, runId, fetchRun]);

  // Jump the video to the failure frame once, when it is known.
  const failureTs = run?.outputs.bugReport?.first_failure_timestamp_s ?? null;
  useEffect(() => {
    if (failureTs !== null && !soughtFailure.current) {
      soughtFailure.current = true;
      setSeekTo(failureTs);
    }
  }, [failureTs]);

  // Aggregate the first model/stage error for the panel.
  const errorInfo: ErrorInfo | null = useMemo(() => {
    const modelErr = allEvents.find((e) => e.event_type.endsWith('_model_error'));
    if (modelErr) {
      const payload = modelErr.payload as { code?: string; model?: string; message?: string };
      return {
        stage: modelErr.stage,
        code: payload.code ?? null,
        model: payload.model ?? null,
        message: payload.message ?? 'Unknown model error.',
      };
    }
    const failed = [...allEvents].reverse().find((e) => e.event_type === 'pipeline_failed');
    if (failed) {
      const payload = failed.payload as { error?: string; code?: string; stage?: string; model?: string };
      return {
        stage: failed.stage,
        code: payload.code ?? null,
        model: payload.model ?? null,
        message: payload.error ?? 'The pipeline failed.',
      };
    }
    return null;
  }, [allEvents]);

  const hadFallback = allEvents.some((e) => e.event_type.endsWith('_fixture_fallback'));

  // Mascot reactions and live context synchronization.
  const stageKey = currentStage;
  useEffect(() => {
    if (!stageKey) return;
    window.dispatchEvent(
      new CustomEvent('replay:mascot', {
        detail: { kind: 'stage', stage: stageKey, runId: runId ?? undefined, fallback: hadFallback },
      }),
    );
  }, [stageKey, runId, hadFallback]);

  const stateKey = run?.state ?? null;
  useEffect(() => {
    if (!stateKey || !TERMINAL.has(stateKey)) return;
    const afterResult = run?.outputs.afterTestResult as { passed?: boolean } | null;
    const suiteResult = run?.outputs.suiteResult as { passed?: boolean } | null;
    const reproAfterFixPassed =
      typeof afterResult?.passed === 'boolean' ? afterResult.passed : stateKey === 'fixed';
    const baselineRegressionPassed =
      typeof suiteResult?.passed === 'boolean' ? suiteResult.passed : stateKey === 'fixed';
    window.dispatchEvent(
      new CustomEvent('replay:mascot', {
        detail: {
          kind: 'state',
          state: stateKey,
          runId: runId ?? undefined,
          reproAfterFixPassed,
          baselineRegressionPassed,
          errorMessage: errorInfo?.message ?? null,
          fallback: hadFallback,
        },
      }),
    );
  }, [stateKey, runId, run, errorInfo, hadFallback]);

  useEffect(() => {
    if (!runId) return;
    const agentRoles: Array<{ name: AgentActivityItem['name']; stage: AgentActivityItem['stage'] }> = [
      { name: 'Watcher', stage: 'watch' },
      { name: 'Locator', stage: 'locate' },
      { name: 'Reproducer', stage: 'reproduce' },
      { name: 'Verifier', stage: 'verify' },
      { name: 'Fixer', stage: 'fix' },
      { name: 'Reporter', stage: 'report' },
    ];
    const pipelineFailed = allEvents.some((e) => e.event_type === 'pipeline_failed');
    const agentItems: AgentActivityItem[] = agentRoles.map(({ name, stage }) => {
      const stageEvs = allEvents.filter((e) => e.stage === stage);
      const started = stageEvs.some((e) => e.event_type.endsWith('_started'));
      const completed = stageEvs.some((e) => e.event_type.endsWith('_completed'));
      const fallback = stageEvs.some((e) => e.event_type.endsWith('_fixture_fallback'));
      const errored = stageEvs.some(
        (e) => e.event_type.endsWith('_model_error') || e.event_type === 'fix_attempt_error',
      );
      let status: AgentActivityItem['status'] = 'pending';
      if (errored || (pipelineFailed && currentStage === stage && !completed)) status = 'failed';
      else if (completed && fallback) status = 'fallback';
      else if (completed) status = 'done';
      else if (started) status = 'running';
      return { name, stage, status };
    });

    const afterResult = run?.outputs.afterTestResult as { passed?: boolean } | null;
    const suiteResult = run?.outputs.suiteResult as { passed?: boolean } | null;
    const topSuspectObj = run?.outputs.suspects?.[0];
    const topSuspect = topSuspectObj
      ? `${topSuspectObj.file}:L${topSuspectObj.start_line}-${topSuspectObj.end_line} (${topSuspectObj.symbol})`
      : null;

    window.dispatchEvent(
      new CustomEvent('replay:mascot', {
        detail: {
          kind: 'context',
          runId,
          stage: currentStage,
          state: run?.state && TERMINAL.has(run.state) ? run.state : null,
          runStateRaw: run?.state ?? null,
          fallback: hadFallback,
          reproAfterFixPassed: typeof afterResult?.passed === 'boolean' ? afterResult.passed : run?.state === 'fixed',
          baselineRegressionPassed: typeof suiteResult?.passed === 'boolean' ? suiteResult.passed : run?.state === 'fixed',
          errorMessage: errorInfo?.message ?? null,
          agents: agentItems,
          bugSummary: run?.outputs.bugReport?.summary ?? null,
          topSuspect,
          hasDiff: Boolean(run?.outputs.diff),
          verifierReason: run?.outputs.sameSymptomVerdict?.reason ?? null,
        },
      }),
    );
  }, [runId, allEvents, currentStage, run, hadFallback, errorInfo]);

  const retry = useCallback(async () => {
    if (!runId || rerunning) return;
    setRerunning(true);
    try {
      const next = await rerunRun(runId);
      soughtFailure.current = false;
      fetchedWatch.current = false;
      fetchedDone.current = false;
      window.location.href = `/runs/${next.id}`;
    } catch (err) {
      setError((err as Error).message);
      setRerunning(false);
    }
  }, [runId, rerunning]);

  useEffect(() => {
    function onMascotAction(e: Event) {
      const action = (e as CustomEvent<{ action?: string }>).detail?.action;
      if (action === 'retry-run') {
        void retry();
      }
    }
    window.addEventListener('replay:mascot-action', onMascotAction);
    return () => window.removeEventListener('replay:mascot-action', onMascotAction);
  }, [retry]);

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
    Array.isArray((bug as { steps?: Array<{ timestamp_s: number; description: string }> })?.steps)
      ? ((bug as { steps: Array<{ timestamp_s: number; description: string }> }).steps ?? []).map((s) => ({
          timestampS: s.timestamp_s,
          description: s.description,
        }))
      : [];
  const videoSrc =
    run.isSample && /^[a-z0-9-]+$/.test(run.videoKey)
      ? `/samples/${run.videoKey}.webm`
      : `${API_BASE}/api/runs/${encodeURIComponent(run.id)}/video`;
  const tokens = run.metrics.totalTokens;
  const cost = run.metrics.estimatedCostUsd;

  const isRecordedReplay = replay || run.executionMode === 'recorded_sample_replay';
  const isLive = run.executionMode === 'live';

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      {isRecordedReplay && <ReplayBanner />}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Link
          href="/"
          aria-label="Back to home"
          className="flex h-8 w-8 items-center justify-center rounded-s text-secondary transition-colors duration-150 ease-out hover:text-primary"
        >
          <ArrowLeft size={16} aria-hidden />
        </Link>
        <h1 className="font-mono text-[14px] text-secondary">{run.id.slice(0, 8)}</h1>
        <StatusPill state={run.state} large fallback={hadFallback} />
        {isRecordedReplay && (
          <span className="rounded-s border border-border-subtle bg-canvas px-2 py-0.5 font-mono text-[11px] text-secondary">
            Demo Replay
          </span>
        )}
        {isLive && (
          <span className="rounded-s border border-border-strong bg-raised px-2 py-0.5 font-mono text-[11px] text-primary">
            Live Run
          </span>
        )}
        {currentStage && !TERMINAL.has(run.state) && (
          <span className="text-[13px] text-secondary">
            {STAGE_WORDS[currentStage] ?? currentStage}
          </span>
        )}
        <div className="ml-auto flex items-center gap-4 font-mono text-[12px] text-secondary">
          {tokens !== null && <span>{tokens.toLocaleString()} tokens</span>}
          {cost !== null && <span>${cost} est.</span>}
          {run.metrics.durationMs !== null && <span>{(run.metrics.durationMs / 1000).toFixed(1)}s</span>}
          {streamMode === 'reconnecting' && <span className="text-progress">reconnecting</span>}
          {streamMode === 'polling' && <span className="text-progress">live stream lost, polling</span>}
        </div>
      </div>

      {errorInfo && (
        <section aria-label="Run error" className="mb-4 rounded-m border border-fail-fill bg-panel p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[13px] font-medium uppercase text-fail-text">
              {errorInfo.stage} failed
            </span>
            {errorInfo.code && (
              <span className="font-mono text-[12px] text-secondary">{errorInfo.code}</span>
            )}
            {errorInfo.model && (
              <span className="font-mono text-[12px] text-secondary">{errorInfo.model}</span>
            )}
            <button
              type="button"
              onClick={() => setRawOpen((v) => !v)}
              aria-expanded={rawOpen}
              className="ml-auto flex items-center gap-1 text-[12px] text-secondary hover:text-primary"
            >
              Details {rawOpen ? <ChevronUp size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
            </button>
          </div>
          <p className="mt-1.5 text-[13px] text-primary">
            {errorInfo.code ? (CAUSE_COPY[errorInfo.code] ?? CAUSE_COPY.unknown) : 'The run failed. See details.'}
          </p>
          {rawOpen && (
            <pre className="mt-2 max-h-48 overflow-auto rounded-s border border-border-subtle bg-canvas p-2 font-mono text-[11px] leading-relaxed text-secondary">
              {errorInfo.message}
            </pre>
          )}
          <button
            type="button"
            onClick={retry}
            disabled={rerunning}
            className="mt-3 inline-flex h-9 items-center rounded-s bg-accent px-3 text-[13px] font-medium text-accent-ink transition-opacity duration-150 ease-out hover:opacity-90 disabled:opacity-40"
          >
            {rerunning ? 'Starting rerun' : 'Retry run'}
          </button>
        </section>
      )}

      {run.state === 'queued' && (
        <p className="mb-4 rounded-s border border-border-subtle bg-panel px-3 py-2 text-[13px] text-secondary">
          Waiting for a worker to claim this run. In local mode the API runs one automatically; with Postgres,
          start the worker with pnpm dev:worker.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[4fr_4fr_5fr]">
        <VideoPanel src={videoSrc} steps={steps} failureTimestampS={failureTs} seekTo={seekTo} />
        <Timeline
          events={allEvents}
          currentStage={currentStage}
          loading={eventsLoading && allEvents.length === 0}
          error={eventsError}
          onRetry={reloadEvents}
          runState={run.state}
        />
        <CodeTabs run={run} activeTab={activeCodeTab} onTabChange={setActiveCodeTab} />
      </div>

      <div className="mt-4 grid gap-4">
        <EvidenceCard videoSrc={videoSrc} failureTimestampS={failureTs} verdict={run.outputs.sameSymptomVerdict} />
        <ReportView run={run} />
      </div>
    </div>
  );
}
