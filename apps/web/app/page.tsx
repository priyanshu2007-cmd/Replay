'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { SampleCard } from '@/components/sample-card';
import { UploadDropzone } from '@/components/upload-dropzone';
import { Skeleton } from '@/components/ui/skeleton';
import { API_BASE, checkHealth, createSampleRun, getSamples, type Sample } from '@/lib/api';
import { listReplaySamples } from '@/lib/replay';

type Mode =
  | { kind: 'checking' }
  | { kind: 'live' }
  | { kind: 'replay' }
  | { kind: 'offline' };

export default function HomePage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>({ kind: 'checking' });
  const [samples, setSamples] = useState<Sample[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modelsKeyMissing, setModelsKeyMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function init() {
      if (API_BASE === '') {
        // No API configured: replay mode (Supabase) or honest offline state.
        const replaySamples = await listReplaySamples();
        if (cancelled) return;
        setMode({ kind: replaySamples ? 'replay' : 'offline' });
        setSamples(replaySamples ?? []);
        return;
      }
      const health = await checkHealth();
      if (cancelled) return;
      setModelsKeyMissing(health.ok && health.modelsKeyConfigured === false);
      if (!health.ok) {
        const replaySamples = await listReplaySamples();
        if (cancelled) return;
        setMode({ kind: replaySamples ? 'replay' : 'offline' });
        setSamples(replaySamples ?? []);
        return;
      }
      setMode({ kind: 'live' });
      try {
        const { samples: s } = await getSamples();
        if (!cancelled) setSamples(s);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, []);

  async function runSample(id: string) {
    if (mode.kind !== 'live') return;
    setBusyId(id);
    setError(null);
    try {
      const run = await createSampleRun(id);
      router.push(`/runs/${run.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusyId(null);
    }
  }

  const offline = mode.kind === 'replay' || mode.kind === 'offline';
  const offlineReason =
    mode.kind === 'offline'
      ? 'The backend is not reachable and no recorded runs are stored.'
      : 'The backend is not reachable. Uploads need the live API.';

  return (
    <div className="mx-auto max-w-6xl px-4 pb-16">
      {offline && (
        <div className="mt-4 rounded-s border border-border-subtle bg-panel px-4 py-3">
          <p className="text-[13px] text-secondary">{offlineReason}</p>
        </div>
      )}
      {modelsKeyMissing && (
        <p className="mt-4 rounded-s border border-border-subtle bg-panel px-3 py-2 text-[12px] text-muted">
          Live model analysis is not configured on this backend (no model API key set). Sample runs will use
          recorded fixtures for the Watch stage.
        </p>
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
          <UploadDropzone disabled={offline} disabledReason={offlineReason} />
        </div>
      </section>

      <section aria-labelledby="samples-heading" className="pb-4">
        <div className="mb-4 flex items-baseline justify-between">
          <h2 id="samples-heading" className="text-[20px] font-semibold text-primary">
            Sample bugs
          </h2>
          <p className="font-mono text-[12px] text-muted">one click starts a real run</p>
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
                busy={busyId === sample.id}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
