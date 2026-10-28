'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { STAGES, type RunEvent, type RunStage, type RunState } from '@/lib/api';
import { ModelBadge, STAGE_MODEL } from '@/components/ui/badge';

/**
 * Agent timeline. One row per pipeline stage, driven only by real events:
 * a stage is running when its start event exists without a completion,
 * done when completed, failed when the pipeline failed there. Rows enter
 * with a short fade as events arrive. Per-stage token counts are not
 * emitted by the pipeline today, so they are not invented here.
 */

type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked';

const STATUS_DOT: Record<StageStatus, string> = {
  pending: 'bg-border-strong',
  running: 'bg-progress animate-pulse motion-reduce:animate-none',
  done: 'bg-pass',
  failed: 'bg-fail-fill',
  blocked: 'bg-progress',
};

const TERMINAL_STATES = new Set<RunState>(['fixed', 'reproduced_only', 'unreproduced', 'failed']);

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function payloadLines(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string') {
      lines.push(`${key}: ${value}`);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      lines.push(`${key}: ${String(value)}`);
    } else if (typeof value === 'object') {
      const summary = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
        .slice(0, 3)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(', ');
      if (summary) lines.push(`${key}: ${summary}`);
    }
  }
  return lines;
}

export function Timeline({
  events,
  currentStage,
  loading = false,
  error = null,
  onRetry,
  runState,
}: {
  events: RunEvent[];
  currentStage: RunStage | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  runState?: RunState;
}) {
  const [openStage, setOpenStage] = useState<RunStage | null>(null);

  const byStage = new Map<RunStage, RunEvent[]>();
  for (const stage of STAGES) byStage.set(stage, []);
  for (const ev of events) {
    byStage.get(ev.stage)?.push(ev);
  }

  const pipelineFailed = events.some((e) => e.event_type === 'pipeline_failed');

  function statusOf(stage: RunStage): StageStatus {
    const list = byStage.get(stage) ?? [];
    const started = list.some(
      (e) =>
        e.event_type.endsWith('_started') ||
        e.event_type === 'run_created' ||
        e.event_type === 'pipeline_started',
    );
    const completed = list.some((e) => e.event_type.endsWith('_completed'));
    // A fixture fallback means the live model was unavailable for this stage:
    // the run continues on fixtures, shown as amber "fallback", never green.
    const fixtureFallback = list.some((e) => e.event_type.endsWith('_fixture_fallback'));
    // A stage failed when a model error or attempt error landed there, or the
    // pipeline failed while this stage was the last one running.
    const stageError = list.some(
      (e) => e.event_type.endsWith('_model_error') || e.event_type === 'fix_attempt_error',
    );
    if (stageError || (pipelineFailed && currentStage === stage && !completed)) return 'failed';
    if (completed && fixtureFallback) return 'blocked';
    if (completed) return 'done';
    if (started) return 'running';
    return 'pending';
  }

  // Auto-expand a stage the moment it fails; collapse again on recovery.
  useEffect(() => {
    const failed = STAGES.find((stage) => statusOf(stage) === 'failed');
    if (failed) setOpenStage(failed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);

  function elapsedOf(stage: RunStage): string | null {
    const list = byStage.get(stage) ?? [];
    const start = list.find((e) => e.event_type.endsWith('_started'));
    const end = list.find((e) => e.event_type.endsWith('_completed'));
    if (!start || !end) return null;
    return fmtMs(new Date(end.timestamp).getTime() - new Date(start.timestamp).getTime());
  }

  function tokensOf(stage: RunStage): number | null {
    const end = (byStage.get(stage) ?? []).find((e) => e.event_type.endsWith('_completed'));
    const tokens = end?.payload?.tokens;
    return typeof tokens === 'number' && tokens > 0 ? tokens : null;
  }

  function costOf(stage: RunStage): string | null {
    const end = (byStage.get(stage) ?? []).find((e) => e.event_type.endsWith('_completed'));
    const cost = end?.payload?.estimated_cost_usd;
    if (typeof cost === 'string' && cost.trim().length > 0 && cost !== '0.0000') return cost;
    if (typeof cost === 'number' && cost > 0) return cost.toFixed(4);
    return null;
  }

  if (loading && events.length === 0) {
    return (
      <section aria-label="Agent timeline" className="rounded-m border border-border-subtle bg-panel p-3">
        <div className="mb-2 flex items-center justify-between border-b border-border-subtle pb-2">
          <span className="font-mono text-[12px] text-muted">Loading stage events...</span>
          <span className="h-2 w-2 animate-pulse rounded-full bg-progress motion-reduce:animate-none" />
        </div>
        <ol className="divide-y divide-border-subtle">
          {STAGES.map((stage) => (
            <li key={stage} className="flex items-center gap-3 py-2.5 opacity-50">
              <span className="h-2 w-2 rounded-full bg-border-strong" />
              <span className="w-20 font-mono text-[13px] text-muted">{stage}</span>
              <span className="ml-auto font-mono text-[11px] text-muted">loading...</span>
            </li>
          ))}
        </ol>
      </section>
    );
  }

  if (error && events.length === 0) {
    return (
      <section aria-label="Agent timeline" className="rounded-m border border-fail-fill/40 bg-panel p-4">
        <p className="mb-1 font-mono text-[13px] text-fail-text">{error}</p>
        <p className="mb-3 text-[12px] text-muted">Could not load historical events for this run.</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-s border border-border-subtle bg-canvas px-3 py-1 font-mono text-[12px] text-primary hover:border-border-strong"
          >
            Retry loading events
          </button>
        )}
      </section>
    );
  }

  if (!loading && !error && events.length === 0 && runState && TERMINAL_STATES.has(runState)) {
    return (
      <section aria-label="Agent timeline" className="rounded-m border border-border-subtle bg-panel p-4 text-center">
        <p className="mb-1 font-mono text-[13px] text-secondary">No historical events recorded</p>
        <p className="text-[12px] text-muted">No pipeline stage events were found for this run.</p>
      </section>
    );
  }

  return (
    <section aria-label="Agent timeline" className="rounded-m border border-border-subtle bg-panel">
      <ol className="divide-y divide-border-subtle">
        {STAGES.map((stage) => {
          const status = statusOf(stage);
          const stageEvents = byStage.get(stage) ?? [];
          const elapsed = elapsedOf(stage);
          const tokens = tokensOf(stage);
          const cost = costOf(stage);
          const open = openStage === stage;
          return (
            <li
              key={stage}
              data-stage={stage}
              data-status={status}
              className={status === 'pending' ? 'opacity-50' : ''}
            >
              <div className="flex items-center gap-3 px-3 py-2.5">
                <button
                  type="button"
                  aria-expanded={open}
                  aria-label={`${stage} details`}
                  disabled={stageEvents.length === 0}
                  onClick={() => setOpenStage(open ? null : stage)}
                  className="flex h-6 w-6 items-center justify-center rounded-s text-muted transition-colors duration-150 ease-out hover:text-primary disabled:pointer-events-none disabled:opacity-30"
                >
                  {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                </button>
                <span
                  aria-hidden
                  className={`h-2 w-2 shrink-0 rounded-full transition-colors duration-200 ease-out ${STATUS_DOT[status]}`}
                />
                <span className="w-20 font-mono text-[13px] text-primary">{stage}</span>
                {STAGE_MODEL[stage] && <ModelBadge model={STAGE_MODEL[stage]!} />}
                <span className="ml-auto flex items-center gap-3 font-mono text-[12px] text-secondary">
                  {tokens !== null && <span className="text-muted">{tokens.toLocaleString()} tok</span>}
                  {cost !== null && (
                    <span className="text-muted" title="Estimated cost">
                      ${cost} est.
                    </span>
                  )}
                  {elapsed && <span>{elapsed}</span>}
                  <span className={status === 'failed' ? 'text-fail-text' : ''}>
                    {status === 'blocked' ? 'fallback' : status}
                  </span>
                </span>
              </div>
              {open && stageEvents.length > 0 && (
                <div className="animate-[fadein_200ms_ease-out] border-t border-border-subtle bg-canvas px-3 py-2 motion-reduce:animate-none">
                  <ul className="flex flex-col gap-1.5">
                    {stageEvents.map((ev) => (
                      <li key={ev.seq} className="font-mono text-[12px] leading-relaxed text-secondary">
                        <span className="text-muted">{new Date(ev.timestamp).toLocaleTimeString()} </span>
                        <span className="text-primary">{ev.event_type}</span>
                        {payloadLines(ev.payload).slice(0, 4).map((line) => (
                          <span key={line} className="block pl-3 text-secondary">
                            {line}
                          </span>
                        ))}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
