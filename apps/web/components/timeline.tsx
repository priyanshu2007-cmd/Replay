'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { STAGES, type RunEvent, type RunStage } from '@/lib/api';
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

export function Timeline({ events, currentStage }: { events: RunEvent[]; currentStage: RunStage | null }) {
  const [openStage, setOpenStage] = useState<RunStage | null>(null);

  const byStage = new Map<RunStage, RunEvent[]>();
  for (const stage of STAGES) byStage.set(stage, []);
  for (const ev of events) {
    byStage.get(ev.stage)?.push(ev);
  }

  const pipelineFailed = events.some((e) => e.event_type === 'pipeline_failed');

  function statusOf(stage: RunStage): StageStatus {
    const list = byStage.get(stage) ?? [];
    const started = list.some((e) => e.event_type.endsWith('_started') || e.event_type === 'run_created');
    const completed = list.some((e) => e.event_type.endsWith('_completed'));
    // A fixture fallback means the live model was unavailable for this stage:
    // the run continues on fixtures, which is a blocked live dependency, not a failure.
    const fixtureFallback = list.some((e) => e.event_type.endsWith('_fixture_fallback'));
    if (completed && fixtureFallback) return 'blocked';
    if (completed) return 'done';
    if (started) return pipelineFailed && currentStage === stage ? 'failed' : 'running';
    return 'pending';
  }

  function elapsedOf(stage: RunStage): string | null {
    const list = byStage.get(stage) ?? [];
    const start = list.find((e) => e.event_type.endsWith('_started'));
    const end = list.find((e) => e.event_type.endsWith('_completed'));
    if (!start || !end) return null;
    return fmtMs(new Date(end.timestamp).getTime() - new Date(start.timestamp).getTime());
  }

  return (
    <section aria-label="Agent timeline" className="rounded-m border border-border-subtle bg-panel">
      <ol className="divide-y divide-border-subtle">
        {STAGES.map((stage) => {
          const status = statusOf(stage);
          const stageEvents = byStage.get(stage) ?? [];
          const elapsed = elapsedOf(stage);
          const open = openStage === stage;
          return (
            <li key={stage} className={status === 'pending' ? 'opacity-50' : ''}>
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
                <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full transition-colors duration-200 ease-out ${STATUS_DOT[status]}`} />
                <span className="w-20 font-mono text-[13px] text-primary">{stage}</span>
                {STAGE_MODEL[stage] && <ModelBadge model={STAGE_MODEL[stage]!} />}
                <span className="ml-auto flex items-center gap-3 font-mono text-[12px] text-secondary">
                  {elapsed && <span>{elapsed}</span>}
                  <span className="capitalize">{status === 'done' ? 'done' : status}</span>
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
