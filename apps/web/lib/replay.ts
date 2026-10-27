'use client';

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { RunEvent, RunEventSchema, RunDetail, RunDetailSchema, Sample, SampleSchema } from '@/lib/api';

/**
 * Replay mode: used when NEXT_PUBLIC_API_URL is empty or the backend health
 * check fails. Reads stored sample runs from Supabase with the anon key
 * (RLS limited to is_sample = true) and plays their events at recorded
 * speed. Never fakes a live run.
 *
 * When Supabase is not configured either, callers get null and must show
 * the honest offline state.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

export function replayConfigured(): boolean {
  return SUPABASE_URL !== '' && SUPABASE_ANON_KEY !== '';
}

function client(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

export async function listReplaySamples(): Promise<Sample[] | null> {
  if (!replayConfigured()) return null;
  const { data, error } = await client().from('runs').select('id, video_key').eq('is_sample', true);
  if (error || !data) return null;
  // Sample metadata lives with the app; stored runs only carry the video key.
  return data
    .filter((row): row is { id: string; video_key: string } => Boolean(row.video_key))
    .map((row) =>
      SampleSchema.parse({
        id: row.video_key,
        title: row.video_key,
        recordingAvailable: true,
      }),
    );
}

export async function getReplayRun(runId: string): Promise<RunDetail | null> {
  if (!replayConfigured()) return null;
  const { data, error } = await client().from('runs').select('*').eq('id', runId).maybeSingle();
  if (error || !data) return null;
  const parsed = RunDetailSchema.safeParse(data);
  if (parsed.success) return parsed.data;
  const row = data as Record<string, unknown>;
  const normalized = {
    id: row.id,
    targetId: row.targetId ?? row.target_id ?? 'demo-shop',
    state: row.state,
    stage: row.stage,
    isSample: Boolean(row.isSample ?? row.is_sample),
    videoKey: String(row.videoKey ?? row.video_key ?? ''),
    note: (row.note as string | null) ?? null,
    outputs: (row.outputs as Record<string, unknown>) ?? {
      bugReport: row.bug_report ?? null,
      suspects: row.suspects ?? null,
      generatedTest: row.generated_test ?? null,
      beforeTestResult: row.before_test_result ?? null,
      sameSymptomVerdict: row.same_symptom_verdict ?? null,
      diff: row.diff ?? null,
      afterTestResult: row.after_test_result ?? null,
      suiteResult: row.suite_result ?? null,
      reportMarkdown: row.report_markdown ?? null,
    },
    metrics: (row.metrics as Record<string, unknown>) ?? {
      totalTokens: typeof row.total_tokens === 'number' ? row.total_tokens : null,
      estimatedCostUsd: typeof row.estimated_cost_usd === 'string' ? row.estimated_cost_usd : null,
      durationMs: typeof row.duration_ms === 'number' ? row.duration_ms : null,
    },
    createdAt: String(row.createdAt ?? row.created_at ?? new Date().toISOString()),
    updatedAt: String(row.updatedAt ?? row.updated_at ?? new Date().toISOString()),
    completedAt: (row.completedAt ?? row.completed_at ?? null) as string | null,
  };
  const retry = RunDetailSchema.safeParse(normalized);
  return retry.success ? retry.data : null;
}

export async function getReplayEvents(runId: string): Promise<RunEvent[] | null> {
  if (!replayConfigured()) return null;
  const { data, error } = await client()
    .from('run_events')
    .select('*')
    .eq('run_id', runId)
    .order('seq', { ascending: true });
  if (error || !data) return null;
  return data
    .map((row) => RunEventSchema.safeParse(row))
    .filter((r) => r.success)
    .map((r) => (r as { success: true; data: RunEvent }).data);
}
