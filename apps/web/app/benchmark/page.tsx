'use client';

import { useEffect, useState } from 'react';
import { StatusPill } from '@/components/status-pill';
import { Skeleton } from '@/components/ui/skeleton';
import { listRuns, type RunSummary } from '@/lib/api';

/**
 * Benchmark: every run the API knows about, including failures. Numbers are
 * real or absent; nothing is aggregated that the API does not provide.
 */
export default function BenchmarkPage() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listRuns(100)
      .then(({ runs: list }) => {
        if (!cancelled) setRuns(list);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
      <h1 className="text-page text-primary">Benchmark</h1>
      <p className="mt-1 text-[14px] text-secondary">
        Every run, including the ones that failed. No sample is hidden from these numbers.
      </p>

      {error && (
        <p role="alert" className="mt-6 rounded-s border border-fail-fill px-3 py-2 text-[13px] text-fail-text">
          Could not load runs: {error}. Check that the API is running.
        </p>
      )}

      {runs === null && !error && (
        <div className="mt-6 flex flex-col gap-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      )}

      {runs !== null && runs.length === 0 && (
        <p className="mt-6 rounded-s border border-border-subtle bg-panel px-4 py-6 text-[13px] text-secondary">
          No runs yet. Start one from a sample on the home page, or run the sample evaluation with
          pnpm eval:watcher to generate benchmark records.
        </p>
      )}

      {runs !== null && runs.length > 0 && (() => {
        const reproduced = runs.filter((r) => ['fixed', 'reproduced_only'].includes(r.state)).length;
        const fixed = runs.filter((r) => r.state === 'fixed').length;
        const durations = runs.map((r) => r.durationMs).filter((d): d is number => d !== null).sort((a, b) => a - b);
        const median = durations.length > 0 ? durations[Math.floor(durations.length / 2)]! : null;
        return (
          <div className="mt-4 flex flex-wrap gap-6 rounded-m border border-border-subtle bg-panel px-4 py-3 font-mono text-[13px] text-secondary">
            <span>{runs.length} runs</span>
            <span>reproduced {Math.round((reproduced / runs.length) * 100)}%</span>
            <span>fixed {Math.round((fixed / runs.length) * 100)}%</span>
            {median !== null && <span>median {(median / 1000).toFixed(1)}s</span>}
          </div>
        );
      })()}

      {runs !== null && runs.length > 0 && (
        <div className="mt-6 overflow-x-auto rounded-m border border-border-subtle">
          <table className="w-full min-w-[640px] border-collapse text-left">
            <caption className="sr-only">All runs with their outcomes</caption>
            <thead>
              <tr className="border-b border-border-subtle bg-panel">
                <th scope="col" className="px-3 py-2 font-mono text-[12px] font-medium text-muted">run</th>
                <th scope="col" className="px-3 py-2 font-mono text-[12px] font-medium text-muted">sample</th>
                <th scope="col" className="px-3 py-2 font-mono text-[12px] font-medium text-muted">outcome</th>
                <th scope="col" className="px-3 py-2 font-mono text-[12px] font-medium text-muted">stage reached</th>
                <th scope="col" className="px-3 py-2 font-mono text-[12px] font-medium text-muted">duration</th>
                <th scope="col" className="px-3 py-2 font-mono text-[12px] font-medium text-muted">created</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-b border-border-subtle last:border-b-0">
                  <td className="px-3 py-2 font-mono text-[12px] text-secondary">
                    <a href={`/runs/${r.id}`} className="text-accent underline">
                      {r.id.slice(0, 8)}
                    </a>
                  </td>
                  <td className="px-3 py-2 font-mono text-[12px] text-secondary">{r.videoKey}</td>
                  <td className="px-3 py-2">
                    <StatusPill state={r.state} />
                  </td>
                  <td className="px-3 py-2 font-mono text-[12px] text-secondary">{r.stage}</td>
                  <td className="px-3 py-2 font-mono text-[12px] text-secondary">
                    {r.durationMs !== null ? `${(r.durationMs / 1000).toFixed(1)}s` : ''}
                  </td>
                  <td className="px-3 py-2 font-mono text-[12px] text-secondary">
                    {new Date(r.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
