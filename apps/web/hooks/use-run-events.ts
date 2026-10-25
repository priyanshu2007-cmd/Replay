'use client';

import { useEffect, useRef, useState } from 'react';
import { RunEvent, RunEventSchema, sseUrl } from '@/lib/api';

/**
 * SSE hook: opens one EventSource per run, replays history, then streams
 * live events. De-duplicates by seq, reconnects with bounded backoff while
 * the run is not terminal, and stops when the server sends stream_closed.
 * If the stream stays down for 20s, falls back to polling the run endpoint
 * every 3s (reported as mode: 'polling'). No duplicate timeline entries.
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

export interface UseRunEvents {
  events: RunEvent[];
  mode: StreamMode;
}

const POLL_INTERVAL_MS = 3000;
const FALLBACK_AFTER_MS = 20_000;

export function useRunEvents(runId: string, enabled: boolean): UseRunEvents {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [mode, setMode] = useState<StreamMode>('connecting');
  const seenSeq = useRef<Set<number>>(new Set());
  const attempt = useRef(0);
  const connectedAt = useRef(0);

  useEffect(() => {
    if (!enabled) return;
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
        setEvents((prev) => [...prev, parsed].sort((a, b) => a.seq - b.seq));
      } catch {
        // malformed event, skip it rather than breaking the stream
      }
    }

    async function pollOnce() {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/events-page`, { cache: 'no-store' });
        if (!res.ok) return;
        const body = (await res.json()) as { events: Array<{ seq: number; [k: string]: unknown }> };
        for (const ev of body.events) {
          if (seenSeq.current.has(ev.seq)) continue;
          seenSeq.current.add(ev.seq);
          const parsed = RunEventSchema.safeParse(ev);
          if (parsed.success) {
            const p = parsed.data;
            setEvents((prev) => [...prev, p].sort((a, b) => a.seq - b.seq));
          }
        }
      } catch {
        // keep polling; the UI shows "polling"
      }
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
      });
      es.onerror = () => {
        es?.close();
        if (closedByServer || disposed) return;
        attempt.current += 1;
        const delay = Math.min(1000 * 2 ** (attempt.current - 1), 15000);
        setMode('reconnecting');
        // If the stream has been down for 20s since it last worked, poll instead.
        if (connectedAt.current && Date.now() - connectedAt.current > FALLBACK_AFTER_MS) {
          startPolling();
          return;
        }
        if (!connectedAt.current && attempt.current >= 2) {
          // Never connected: give the stream a bounded window, then poll.
          if (!modeTimer) {
            modeTimer = setTimeout(() => {
              if (!closedByServer && !disposed && attempt.current > 0) startPolling();
            }, FALLBACK_AFTER_MS);
          }
        }
        retryTimer = setTimeout(connect, delay);
      };
    }

    connect();
    return () => {
      disposed = true;
      closedByServer = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (modeTimer) clearTimeout(modeTimer);
      if (pollTimer) clearInterval(pollTimer);
      es?.close();
    };
  }, [runId, enabled]);

  return { events, mode };
}
