'use client';

import { useRef, useState } from 'react';
import type { Sample } from '@/lib/api';
import { Button } from '@/components/ui/button';

/**
 * Sample card: the thumbnail is the real bug recording (first frame via
 * preload=metadata, muted preview on hover or click). Nothing here is illustrative.
 * Static video playback remains available even when the backend is offline.
 */
export function SampleCard({
  sample,
  onRun,
  disabled,
  disabledReason,
  busy,
  executionMode,
}: {
  sample: Sample;
  onRun: (id: string) => void;
  disabled: boolean;
  disabledReason?: string;
  busy: boolean;
  executionMode?: 'live' | 'recorded_sample_replay' | 'fixture_assisted' | 'read_only';
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [mediaError, setMediaError] = useState(false);
  const [playing, setPlaying] = useState(false);

  const canPlayVideo = sample.recordingAvailable && !mediaError;
  const runDisabled = disabled || busy || !canPlayVideo;

  function togglePreview() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      void v.play().then(() => setPlaying(true)).catch(() => {});
    } else {
      v.pause();
      setPlaying(false);
    }
  }

  return (
    <article className="flex flex-col overflow-hidden rounded-m border border-border-subtle bg-panel">
      <div
        className="relative aspect-video bg-raised"
        onMouseEnter={() => {
          const v = videoRef.current;
          if (!v) return;
          void v.play().then(() => setPlaying(true)).catch(() => {});
        }}
        onMouseLeave={() => {
          const v = videoRef.current;
          if (!v) return;
          v.pause();
          v.currentTime = 0.8;
          setPlaying(false);
        }}
      >
        {canPlayVideo ? (
          <>
            <video
              ref={videoRef}
              src={`/samples/${sample.id}.webm#t=0.8`}
              muted
              playsInline
              preload="metadata"
              onClick={togglePreview}
              onError={() => setMediaError(true)}
              aria-label={`Sample bug recording: ${sample.title}`}
              className="h-full w-full cursor-pointer object-cover"
            />
            <button
              type="button"
              onClick={togglePreview}
              aria-label={playing ? `Pause preview for ${sample.title}` : `Play preview for ${sample.title}`}
              className="absolute bottom-2 right-2 rounded-s border border-border-subtle bg-panel/90 px-2 py-0.5 font-mono text-[11px] text-secondary backdrop-blur-xs transition-colors hover:border-border-strong hover:text-primary"
            >
              {playing ? 'Pause' : 'Preview'}
            </button>
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-[12px] text-muted">
            Recording not available
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-[14px] font-medium leading-snug text-primary">{sample.title}</h3>
          {executionMode === 'recorded_sample_replay' && (
            <span
              title="Serverless mode loads the pre-verified Demo Shop pipeline artifact for this sample"
              className="shrink-0 rounded-s border border-border-subtle bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-secondary"
            >
              verified replay
            </span>
          )}
        </div>
        <p className="font-mono text-[12px] text-muted">{sample.id}</p>
        {sample.observedBehavior && (
          <p className="mt-1 line-clamp-2 text-[13px] text-secondary">{sample.observedBehavior}</p>
        )}
        <div className="mt-auto pt-3">
          <Button
            variant="primary"
            disabled={runDisabled}
            onClick={() => onRun(sample.id)}
            className="w-full"
          >
            {busy ? 'Starting' : 'Run sample'}
          </Button>
          {runDisabled && !busy && (
            <p className="mt-1.5 text-[11px] text-muted">
              {!canPlayVideo
                ? 'Sample recording file is unavailable.'
                : disabledReason ?? 'Backend API is currently unreachable.'}
            </p>
          )}
        </div>
      </div>
    </article>
  );
}
