'use client';

import { useEffect, useRef, useState } from 'react';
import { RunEvent, RunEventSchema, sseUrl } from '@/lib/api';

/**
 * SSE hook: opens one EventSource per run, replays history, then streams
 * live events. De-duplicates by seq, reconnects with backoff while the run
 * is not terminal, and stops when the server sends stream_closed.
 * No polling on top.
 */

// Every event type the pipeline and API emit (from apps/api/src and packages/agents/src/pipeline.ts).
const EVENT_TYPES = [
  'run_created',
  'ingest_started',
  'ingest_completed',
  'watch_started',
  'watch_fixture_fallback',
  'watch_completed',
  'locate_started',
  'locate_completed',
  'reproduce_started',
  'reproduce_completed',
  'verify_started',
  'verify_completed',
  'fix_started',
  'fix_attempt_started',
  'fix_attempt_failed',
  'fix_attempt_succeeded',
  'fix_attempt_error',
  'fix_completed',
  'report_started',
  'report_completed',
  'pipeline_completed',
  'pipeline_failed',
  'stream_closed',
] as const;

export interface UseRunEvents {
  events: RunEvent[];
  status: 'connecting' | 'open' | 'reconnecting' | 'closed';
}

export function useRunEvents(runId: string, enabled: boolean): UseRunEvents {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [status, setStatus] = useState<UseRunEvents['status']>('connecting');
  const seenSeq = useRef<Set<number>>(new Set());
  const attempt = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | undefined;
    let closedByServer = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    function ingest(event: MessageEvent) {
      try {
        const parsed = RunEventSchema.parse(JSON.parse(event.data));
        if (seenSeq.current.has(parsed.seq)) return;
        seenSeq.current.add(parsed.seq);
        setEvents((prev) => [...prev, parsed].sort((a, b) => a.seq - b.seq));
      } catch {
        // malformed event, skip it rather than breaking the stream
      }
    }

    function connect() {
      es = new EventSource(sseUrl(runId));
      es.onopen = () => {
        attempt.current = 0;
        setStatus('open');
      };
      for (const type of EVENT_TYPES) {
        if (type === 'stream_closed') continue;
        es.addEventListener(type, ingest as EventListener);
      }
      es.addEventListener('stream_closed', () => {
        closedByServer = true;
        setStatus('closed');
        es?.close();
      });
      es.onerror = () => {
        es?.close();
        if (closedByServer) return;
        attempt.current += 1;
        const delay = Math.min(1000 * 2 ** (attempt.current - 1), 15000);
        setStatus('reconnecting');
        retryTimer = setTimeout(connect, delay);
      };
    }

    connect();
    return () => {
      closedByServer = true;
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
    };
  }, [runId, enabled]);

  return { events, status };
}
