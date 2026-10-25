'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Evidence card: the recording's failure frame (captured from the real
 * video at the Watcher's timestamp) beside the same-symptom verdict.
 * The pipeline does not store test screenshots today, so the second panel
 * shows the verdict and its reason instead of pretending one exists.
 */
export function EvidenceCard({
  videoSrc,
  failureTimestampS,
  verdict,
}: {
  videoSrc: string | null;
  failureTimestampS: number | null;
  verdict: { same_defect: boolean; reason: string; confidence?: number } | null;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [frame, setFrame] = useState<string | null>(null);

  useEffect(() => {
    setFrame(null);
    if (!videoSrc || failureTimestampS === null) return;
    const v = videoRef.current;
    if (!v) return;
    function capture() {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = Math.round((640 * (v!.videoHeight || 360)) / (v!.videoWidth || 640));
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(v!, 0, 0, canvas.width, canvas.height);
      setFrame(canvas.toDataURL('image/jpeg', 0.85));
      v!.removeEventListener('seeked', capture);
    }
    v.addEventListener('seeked', capture);
    v.currentTime = failureTimestampS;
    return () => v.removeEventListener('seeked', capture);
  }, [videoSrc, failureTimestampS]);

  return (
    <section aria-label="Evidence" className="grid gap-4 rounded-m border border-border-subtle bg-panel p-4 sm:grid-cols-2">
      <div>
        <h3 className="mb-2 text-[13px] font-medium text-primary">Failure frame from the recording</h3>
        {frame ? (
          // eslint-disable-next-line @next/next/no-img-element -- canvas capture, not a remote image
          <img src={frame} alt={`Frame at ${failureTimestampS?.toFixed(1)}s where the defect is visible`} className="w-full rounded-s border border-border-subtle" />
        ) : (
          <div className="flex aspect-video items-center justify-center rounded-s border border-dashed border-border-strong text-[13px] text-muted">
            {failureTimestampS === null ? 'Waiting for the Watcher result.' : 'Seeking the failure frame.'}
          </div>
        )}
        <video ref={videoRef} src={videoSrc ?? undefined} muted playsInline preload="metadata" className="hidden" aria-hidden />
      </div>
      <div>
        <h3 className="mb-2 text-[13px] font-medium text-primary">Same-symptom verification</h3>
        {verdict ? (
          <div className="flex h-full flex-col gap-2 rounded-s border border-border-subtle bg-canvas p-3">
            <p className={`font-mono text-[13px] font-medium ${verdict.same_defect ? 'text-pass' : 'text-fail-text'}`}>
              {verdict.same_defect ? 'SAME DEFECT' : 'DIFFERENT DEFECT'}
            </p>
            <p className="text-[13px] leading-relaxed text-secondary">{verdict.reason}</p>
            {verdict.confidence !== undefined && (
              <p className="mt-auto font-mono text-[12px] text-muted">confidence {verdict.confidence.toFixed(2)}</p>
            )}
          </div>
        ) : (
          <div className="flex aspect-video items-center justify-center rounded-s border border-dashed border-border-strong text-[13px] text-muted">
            The visual comparison runs after the reproduction test.
          </div>
        )}
      </div>
    </section>
  );
}
