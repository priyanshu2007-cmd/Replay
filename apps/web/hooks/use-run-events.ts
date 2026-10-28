'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RunEvent, RunEventSchema, sseUrl, API_BASE } from '@/lib/api';

/**
 * SSE hook: loads persisted event history, de-duplicates by sequence number,
 * opens one EventSource per run for live runs, and stops when the server
 * sends stream_closed or when the run is terminal.
 * If the stream stays down for 20s, falls back to polling the events-page
 * endpoint every 3s (reported as mode: 'polling').
 * Terminal runs load the full persisted history without holding an open SSE stream.
 */

const EVENT_TYPES = [
  'run_created',
  'pipeline_started',
  'ingest_started',
  'ingest_completed',
  'watch_started',
  'watch_fixture_fallback',
  'watch_model_error',
  'watch_completed',
  'locate_started',
  'locate_model_error',
  'locate_completed',
  'reproduce_started',
  'reproduce_model_error',
  'reproduce_completed',
  'verify_started',
  'verify_model_error',
  'verify_completed',
  'fix_started',
  'fix_attempt_started',
  'fix_attempt_failed',
  'fix_attempt_error',
  'fix_attempt_succeeded',
  'fix_model_error',
  'fix_completed',
  'report_started',
  'report_model_error',
  'report_completed',
  'pipeline_completed',
  'pipeline_failed',
  'stream_closed',
] as const;

export type StreamMode = 'connecting' | 'live' | 'reconnecting' | 'polling' | 'closed';

export interface UseRunEventsOptions {
  liveStream?: boolean;
  enabled?: boolean;
}

export interface UseRunEvents {
  events: RunEvent[];
  mode: StreamMode;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

const POLL_INTERVAL_MS = 3000;
const FALLBACK_AFTER_MS = 20_000;

export function useRunEvents(
  runId: string,
  optionsOrLiveStream?: boolean | UseRunEventsOptions,
): UseRunEvents {
  const liveStream =
    typeof optionsOrLiveStream === 'boolean'
      ? optionsOrLiveStream
      : optionsOrLiveStream?.liveStream ?? false;
  const enabled =
    typeof optionsOrLiveStream === 'boolean'
      ? true
      : optionsOrLiveStream?.enabled ?? Boolean(runId);

  const [events, setEvents] = useState<RunEvent[]>([]);
  const [mode, setMode] = useState<StreamMode>(liveStream ? 'connecting' : 'closed');
  const [loading, setLoading] = useState<boolean>(Boolean(runId && enabled));
  const [error, setError] = useState<string | null>(null);

  const seenSeq = useRef<Set<number>>(new Set());
  const activeRunIdRef = useRef<string>(runId);
  const attempt = useRef(0);
  const connectedAt = useRef(0);

  // Synchronously reset sequence filter and attempts when runId changes
  if (activeRunIdRef.current !== runId) {
    activeRunIdRef.current = runId;
    seenSeq.current.clear();
    attempt.current = 0;
    connectedAt.current = 0;
  }

  const fetchHistory = useCallback(async (): Promise<boolean> => {
    if (!runId || !enabled) return false;
    try {
      const res = await fetch(`${API_BASE}/api/runs/${encodeURIComponent(runId)}/events-page`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        if (res.status === 404) {
          setError('Run not found');
        } else {
          setError(`Failed to load event history (${res.status})`);
        }
        return false;
      }
      const body = (await res.json()) as { events?: unknown[] };
      if (Array.isArray(body.events)) {
        const parsedList: RunEvent[] = [];
        for (const ev of body.events) {
          const parsed = RunEventSchema.safeParse(ev);
          if (parsed.success) {
            parsedList.push(parsed.data);
          }
        }
        setEvents((prev) => {
          const map = new Map<number, RunEvent>();
          for (const ev of prev) map.set(ev.seq, ev);
          for (const ev of parsedList) {
            seenSeq.current.add(ev.seq);
            map.set(ev.seq, ev);
          }
          return Array.from(map.values()).sort((a, b) => a.seq - b.seq);
        });
        setError(null);
      }
      return true;
    } catch (err) {
      setError((err as Error).message || 'Failed to load event history');
      return false;
    } finally {
      setLoading(false);
    }
  }, [runId, enabled]);

  useEffect(() => {
    if (!enabled || !runId) {
      setEvents([]);
      setMode('closed');
      setLoading(false);
      setError(null);
      return;
    }

    let es: EventSource | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let modeTimer: ReturnType<typeof setTimeout> | undefined;
    let closedByServer = false;
    let disposed = false;

    function ingest(raw: string) {
      try {
        const parsed = RunEventSchema.parse(JSON.parse(raw));
        if (seenSeq.current.has(parsed.seq)) return;
        seenSeq.current.add(parsed.seq);
        setEvents((prev) => {
          if (prev.some((e) => e.seq === parsed.seq)) return prev;
          return [...prev, parsed].sort((a, b) => a.seq - b.seq);
        });
      } catch {
        // malformed event, skip
      }
    }

    async function pollOnce() {
      if (disposed) return;
      await fetchHistory();
    }

    function startPolling() {
      if (pollTimer || disposed) return;
      setMode('polling');
      void pollOnce();
      pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
    }

    function connect() {
      if (disposed || closedByServer) return;
      es = new EventSource(sseUrl(runId));
      es.onopen = () => {
        attempt.current = 0;
        connectedAt.current = Date.now();
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = undefined;
        }
        setMode('live');
      };
      for (const type of EVENT_TYPES) {
        if (type === 'stream_closed') continue;
        es.addEventListener(type, (e) => ingest((e as MessageEvent).data));
      }
      es.addEventListener('stream_closed', () => {
        closedByServer = true;
        setMode('closed');
        es?.close();
        if (pollTimer) clearInterval(pollTimer);
        void fetchHistory();
      });
      es.onerror = () => {
        es?.close();
        if (closedByServer || disposed) return;
        attempt.current += 1;
        const delay = Math.min(1000 * 2 ** (attempt.current - 1), 15000);
        setMode('reconnecting');
        if (connectedAt.current && Date.now() - connectedAt.current > FALLBACK_AFTER_MS) {
          startPolling();
          return;
        }
        if (!connectedAt.current && attempt.current >= 2) {
          if (!modeTimer) {
            modeTimer = setTimeout(() => {
              if (!closedByServer && !disposed && attempt.current > 0) startPolling();
            }, FALLBACK_AFTER_MS);
          }
        }
        retryTimer = setTimeout(connect, delay);
      };
    }

    // Always fetch historical events
    setLoading(true);
    void fetchHistory();

    // Stream live events only when active/non-terminal
    if (liveStream) {
      connect();
    } else {
      setMode('closed');
    }

    return () => {
      disposed = true;
      closedByServer = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (modeTimer) clearTimeout(modeTimer);
      if (pollTimer) clearInterval(pollTimer);
      es?.close();
    };
  }, [runId, enabled, liveStream, fetchHistory]);

  const reload = useCallback(async () => {
    setLoading(true);
    await fetchHistory();
  }, [fetchHistory]);

  return { events, mode, loading, error, reload };
}
