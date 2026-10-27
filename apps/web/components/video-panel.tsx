'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface VideoStep {
  timestampS: number;
  description: string;
}

/**
 * Video panel: native player plus a marker strip. Steps come from the
 * Watcher's BugReport, the red marker from the failure timestamp. Space
 * toggles play, J and K move between steps (on the panel, not globally).
 */
export function VideoPanel({
  src,
  steps,
  failureTimestampS,
  seekTo,
}: {
  src: string | null;
  steps: VideoStep[];
  failureTimestampS: number | null;
  /** External seek requests (e.g. jump to failure once the Watcher finishes). */
  seekTo: number | null;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [activeStep, setActiveStep] = useState(-1);

  const seek = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = t;
    void v.play().catch(() => {});
  }, []);

  useEffect(() => {
    if (seekTo !== null) seek(seekTo);
  }, [seekTo, seek]);

  const markers: Array<{ t: number; label: string; kind: 'step' | 'failure' }> = [
    ...steps.map((s, i) => ({ t: s.timestampS, label: `${i + 1}`, kind: 'step' as const })),
    ...(failureTimestampS !== null ? [{ t: failureTimestampS, label: 'failure', kind: 'failure' as const }] : []),
  ].sort((a, b) => a.t - b.t);

  function move(delta: number) {
    if (markers.length === 0) return;
    const next = Math.min(Math.max(activeStep + delta, 0), markers.length - 1);
    setActiveStep(next);
    seek(markers[next]!.t);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      const v = videoRef.current;
      if (!v) return;
      if (v.paused) void v.play().catch(() => {});
      else v.pause();
    } else if (e.key === 'j') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'k') {
      e.preventDefault();
      move(1);
    }
  }

  return (
    <section
      aria-label="Bug recording"
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-2 rounded-m border border-border-subtle bg-panel p-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      {src ? (
        <video
          ref={videoRef}
          src={src}
          controls
          playsInline
          preload="metadata"
          className="aspect-video w-full rounded-s bg-black"
        />
      ) : (
        <div className="flex aspect-video w-full items-center justify-center rounded-s bg-raised text-[13px] text-muted">
          No recording is available for this run.
        </div>
      )}
      {markers.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Timeline markers">
          {markers.map((m, i) => (
            <button
              key={`${m.kind}-${m.t}`}
              type="button"
              aria-pressed={activeStep === i}
              onClick={() => {
                setActiveStep(i);
                seek(m.t);
              }}
              className={`h-7 min-w-11 rounded-s border px-2 font-mono text-[12px] transition-colors duration-150 ease-out ${
                m.kind === 'failure'
                  ? 'border-fail-fill text-fail-text'
                  : 'border-border-subtle text-secondary hover:border-border-strong hover:text-primary'
              } ${activeStep === i ? 'bg-raised text-primary' : ''}`}
            >
              {m.kind === 'failure' ? `${m.t.toFixed(1)}s` : `${m.label} ${m.t.toFixed(1)}s`}
            </button>
          ))}
        </div>
      )}
      <p className="font-mono text-[12px] text-muted">Space play or pause. J and K move between steps.</p>
    </section>
  );
}
