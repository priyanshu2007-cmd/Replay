'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { SampleCard } from '@/components/sample-card';
import { UploadDropzone } from '@/components/upload-dropzone';
import { Skeleton } from '@/components/ui/skeleton';
import {
  checkHealth,
  checkReady,
  createSampleRun,
  getSamples,
  type ReadyStatus,
  type Sample,
} from '@/lib/api';
import { listReplaySamples } from '@/lib/replay';

type Mode =
  | { kind: 'checking' }
  | { kind: 'live' }
  | { kind: 'replay' }
  | { kind: 'offline' };

const FALLBACK_STATIC_SAMPLES: Sample[] = [
  {
    id: 'cart-nan',
    title: 'Cart total becomes NaN after clearing quantity field',
    observedBehavior: "Subtotal, Total, and Proceed to Checkout button display '$NaN' when quantity input is cleared.",
    recordingAvailable: true,
  },
  {
    id: 'double-discount',
    title: 'Double-clicking Apply applies the discount twice',
    observedBehavior: 'Clicking Apply twice stacks SAVE10 to 20% ($20.00 off) instead of staying at 10% ($10.00 off).',
    recordingAvailable: true,
  },
  {
    id: 'string-sort',
    title: 'String-based sort places $100 before $20',
    observedBehavior: "Lexicographical sort places Mechanical Keyboard ($100) first when sorting by 'Price: Low to High'.",
    recordingAvailable: true,
  },
  {
    id: 'empty-email',
    title: 'Checkout accepts an empty email address',
    observedBehavior: 'Clicking Complete Purchase with an empty email field skips validation and shows Order Confirmed.',
    recordingAvailable: true,
  },
  {
    id: 'quantity-reset',
    title: 'Quantity resets after page navigation',
    observedBehavior: 'Switching from Cart to Catalog and back resets item quantities to 1.',
    recordingAvailable: true,
  },
];

export default function HomePage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>({ kind: 'checking' });
  const [samples, setSamples] = useState<Sample[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modelsKeyMissing, setModelsKeyMissing] = useState(false);
  const [readyStatus, setReadyStatus] = useState<ReadyStatus | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const runningRef = useRef(false);

  const refreshReadiness = useCallback(async () => {
    setRechecking(true);
    try {
      const [health, ready] = await Promise.all([checkHealth(), checkReady()]);
      setReadyStatus(ready);
      setModelsKeyMissing(health.ok && health.modelsKeyConfigured === false);

      if (health.ok) {
        setMode({ kind: 'live' });
        try {
          const { samples: s } = await getSamples();
          setSamples(s);
          setError(null);
          window.dispatchEvent(
            new CustomEvent('replay:mascot', {
              detail: {
                kind: 'home_context',
                mode: 'live',
                executionMode: ready.executionMode ?? 'live',
                canExecuteLiveRun: ready.canExecuteLiveRun ?? !modelsKeyMissing,
                canReplayRecordedSamples: ready.canReplayRecordedSamples ?? true,
                modelsKeyMissing: health.modelsKeyConfigured === false,
                blockers: ready.blockers ?? [],
                samplesCount: s.length,
              },
            }),
          );
        } catch (err) {
          setError((err as Error).message);
        }
      } else {
        const replaySamples = await listReplaySamples();
        const nextKind = replaySamples ? 'replay' : 'offline';
        const fallbackSamples = replaySamples && replaySamples.length > 0 ? replaySamples : FALLBACK_STATIC_SAMPLES;
        setMode({ kind: nextKind });
        setSamples(fallbackSamples);
        window.dispatchEvent(
          new CustomEvent('replay:mascot', {
            detail: {
              kind: 'home_context',
              mode: nextKind,
              executionMode: 'read_only',
              canExecuteLiveRun: false,
              canReplayRecordedSamples: Boolean(replaySamples && replaySamples.length > 0),
              modelsKeyMissing: true,
              blockers: ['The backend API is not reachable.'],
              samplesCount: fallbackSamples.length,
            },
          }),
        );
      }
    } finally {
      setRechecking(false);
    }
  }, [modelsKeyMissing]);

  useEffect(() => {
    void refreshReadiness();
  }, [refreshReadiness]);

  const runSample = useCallback(
    async (id: string) => {
      if (mode.kind !== 'live' || runningRef.current) return;
      runningRef.current = true;
      setBusyId(id);
      setError(null);
      try {
        const run = await createSampleRun(id);
        router.push(`/runs/${run.id}`);
      } catch (err) {
        setError((err as Error).message);
        setBusyId(null);
        runningRef.current = false;
      }
    },
    [mode.kind, router],
  );

  useEffect(() => {
    function onMascotAction(e: Event) {
      const detail = (e as CustomEvent<{ action?: string; sampleId?: string }>).detail;
      if (!detail?.action) return;
      if (detail.action === 'scroll-samples') {
        document.getElementById('samples-heading')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (detail.action === 'run-sample') {
        void runSample(detail.sampleId || 'cart-nan');
      } else if (detail.action === 'recheck-ready') {
        void refreshReadiness();
      } else if (detail.action === 'open-upload') {
        window.dispatchEvent(new CustomEvent('replay:open-upload'));
      }
    }
    window.addEventListener('replay:mascot-action', onMascotAction);
    return () => window.removeEventListener('replay:mascot-action', onMascotAction);
  }, [runSample, refreshReadiness]);

  const offline = mode.kind === 'replay' || mode.kind === 'offline';
  const offlineReason =
    mode.kind === 'offline'
      ? 'The backend is not reachable and no recorded runs are stored.'
      : 'The backend is not reachable. Uploads need the live API.';
  const isServerlessReplay = readyStatus?.executionMode === 'recorded_sample_replay';
  const serverlessUploadNotice = isServerlessReplay
    ? 'Note: Custom video execution requires an external worker + sandbox; sample bugs below run pre-verified Demo Shop replays.'
    : null;

  return (
    <div className="mx-auto max-w-6xl px-4 pb-16">
      {offline && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-s border border-border-subtle bg-panel px-4 py-3">
          <p className="text-[13px] text-secondary">{offlineReason}</p>
          <button
            type="button"
            onClick={() => void refreshReadiness()}
            disabled={rechecking}
            className="rounded-s border border-border-subtle bg-canvas px-2.5 py-1 font-mono text-[11px] text-primary hover:border-border-strong disabled:opacity-40"
          >
            {rechecking ? 'Checking...' : 'Retry API readiness'}
          </button>
        </div>
      )}
      {!offline && (modelsKeyMissing || isServerlessReplay) && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-s border border-border-subtle bg-panel px-3 py-2">
          <p className="text-[12px] text-muted">
            {isServerlessReplay
              ? 'Serverless Demo Mode: Live model key / background Docker worker are not attached to this Vercel instance. Clicking Run sample loads the pre-verified Demo Shop pipeline run and event stream.'
              : 'Live model analysis is not configured on this backend (no model API key set). Sample runs will use recorded fixtures for the Watch stage.'}
          </p>
          <button
            type="button"
            onClick={() => void refreshReadiness()}
            disabled={rechecking}
            className="shrink-0 rounded-s border border-border-subtle bg-canvas px-2.5 py-1 font-mono text-[11px] text-secondary hover:border-border-strong hover:text-primary disabled:opacity-40"
          >
            {rechecking ? 'Checking...' : 'Recheck readiness'}
          </button>
        </div>
      )}
      <section className="grid gap-8 py-10 md:grid-cols-7 md:py-14">
        <div className="flex flex-col justify-center gap-4 md:col-span-4">
          <h1 className="text-display text-primary">Drop a bug video. Get a failing test and a verified fix.</h1>
          <p className="max-w-[52ch] text-[16px] leading-relaxed text-secondary">
            Replay watches the recording, writes a Playwright test that fails the same way, patches the code, and
            proves the fix by running the test again. Every result comes from a real run in a sandbox, with NVIDIA Nemotron models on
            Nebius Token Factory.
          </p>
        </div>
        <div className="md:col-span-3">
          <UploadDropzone
            disabled={offline}
            disabledReason={offlineReason}
            serverlessUploadNotice={serverlessUploadNotice}
          />
        </div>
      </section>

      <section aria-labelledby="samples-heading" className="pb-4">
        <div className="mb-4 flex items-baseline justify-between">
          <h2 id="samples-heading" className="text-[20px] font-semibold text-primary">
            Sample bugs
          </h2>
          <p className="font-mono text-[12px] text-muted">
            {isServerlessReplay ? 'one click opens a verified sample run' : 'one click starts a real run'}
          </p>
        </div>

        {error && (
          <p role="alert" className="mb-4 rounded-s border border-fail-fill px-3 py-2 text-[13px] text-fail-text">
            {error}
          </p>
        )}

        {samples === null && mode.kind === 'live' ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="aspect-[4/3] w-full" />
            ))}
          </div>
        ) : samples !== null && samples.length === 0 ? (
          <p className="rounded-s border border-border-subtle bg-panel px-4 py-6 text-[13px] text-secondary">
            No samples are available yet. Start the API, or check back after sample runs are recorded.
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {samples?.map((sample) => (
              <SampleCard
                key={sample.id}
                sample={sample}
                onRun={runSample}
                disabled={mode.kind !== 'live'}
                disabledReason={offlineReason}
                busy={busyId === sample.id}
                executionMode={readyStatus?.executionMode}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
