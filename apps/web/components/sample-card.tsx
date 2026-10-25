'use client';

import { useRef } from 'react';
import type { Sample } from '@/lib/api';
import { Button } from '@/components/ui/button';

/**
 * Sample card: the thumbnail is the real bug recording (first frame via
 * preload=metadata, muted preview on hover). Nothing here is illustrative.
 */
export function SampleCard({
  sample,
  onRun,
  disabled,
  busy,
}: {
  sample: Sample;
  onRun: (id: string) => void;
  disabled: boolean;
  busy: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  return (
    <article className="flex flex-col overflow-hidden rounded-m border border-border-subtle bg-panel">
      <div
        className="relative aspect-video bg-raised"
        onMouseEnter={() => void videoRef.current?.play().catch(() => {})}
        onMouseLeave={() => {
          const v = videoRef.current;
          if (!v) return;
          v.pause();
          v.currentTime = 0;
        }}
      >
        {sample.recordingAvailable ? (
          <video
            ref={videoRef}
            src={`/samples/${sample.id}.webm#t=0.8`}
            muted
            playsInline
            preload="metadata"
            aria-hidden
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-[12px] text-muted">
            Recording not available
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-4">
        <h3 className="text-[14px] font-medium leading-snug text-primary">{sample.title}</h3>
        <p className="font-mono text-[12px] text-muted">{sample.id}</p>
        {sample.observedBehavior && (
          <p className="mt-1 line-clamp-2 text-[13px] text-secondary">{sample.observedBehavior}</p>
        )}
        <div className="mt-auto pt-3">
          <Button
            variant="primary"
            disabled={disabled || busy || !sample.recordingAvailable}
            onClick={() => onRun(sample.id)}
            className="w-full"
          >
            {busy ? 'Starting' : 'Run sample'}
          </Button>
        </div>
      </div>
    </article>
  );
}
