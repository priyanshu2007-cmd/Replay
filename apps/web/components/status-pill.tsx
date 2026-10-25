import type { RunState } from '@/lib/api';

/**
 * The verdict surface. Red only means a failing test, green only a verified
 * pass. The pill is the only element allowed to use these colors at full
 * strength. The run view passes `announce` so the final verdict is announced
 * once via aria-live; table rows and compact contexts never announce.
 */

const CONFIG: Record<RunState, { label: string; className: string }> = {
  queued: { label: 'QUEUED', className: 'border-border-strong text-secondary' },
  running: { label: 'RUNNING', className: 'border-progress text-progress' },
  reproduced_only: { label: 'REPRODUCED, NOT FIXED', className: 'border-fail-fill text-fail-text' },
  fixed: { label: 'PASSING', className: 'border-pass text-pass' },
  unreproduced: { label: 'COULD NOT REPRODUCE', className: 'border-border-strong text-secondary' },
  failed: { label: 'FAILED', className: 'border-fail-fill text-fail-text' },
};

export function StatusPill({
  state,
  large = false,
  announce = false,
}: {
  state: RunState;
  large?: boolean;
  announce?: boolean;
}) {
  const config = CONFIG[state];
  return (
    <span
      aria-live={announce ? 'polite' : undefined}
      className={`inline-flex items-center rounded-s border bg-panel font-mono font-medium uppercase tracking-wide transition-colors duration-200 ease-out ${
        large ? 'h-9 px-3 text-[14px]' : 'h-7 px-2 text-[12px]'
      } ${config.className}`}
    >
      {config.label}
    </span>
  );
}
