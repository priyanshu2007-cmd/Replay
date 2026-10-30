import { z } from 'zod';

/**
 * Typed client for the Replay API (apps/api). Every response is parsed with
 * Zod against the shapes the server actually returns; no endpoint is invented.
 * NEXT_PUBLIC_API_URL empty means live mode is off and the app runs in
 * replay mode (see lib/replay.ts).
 */

export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

export const RunStateSchema = z.enum([
  'queued',
  'running',
  'reproduced_only',
  'fixed',
  'unreproduced',
  'failed',
]);
export type RunState = z.infer<typeof RunStateSchema>;

export const RunStageSchema = z.enum([
  'ingest',
  'watch',
  'locate',
  'reproduce',
  'verify',
  'fix',
  'report',
]);
export type RunStage = z.infer<typeof RunStageSchema>;

export const STAGES: RunStage[] = ['ingest', 'watch', 'locate', 'reproduce', 'verify', 'fix', 'report'];

export const SampleSchema = z.object({
  id: z.string(),
  title: z.string(),
  expectedBehavior: z.string().optional(),
  observedBehavior: z.string().optional(),
  guiltyFile: z.string().optional(),
  guiltySymbol: z.string().optional(),
  recordingAvailable: z.boolean(),
});
export type Sample = z.infer<typeof SampleSchema>;

const Iso = z.string();

export const RunSummarySchema = z.object({
  id: z.string(),
  targetId: z.string(),
  state: RunStateSchema,
  stage: RunStageSchema,
  isSample: z.boolean(),
  executionMode: z.string().optional(),
  videoKey: z.string(),
  note: z.string().nullable().optional(),
  durationMs: z.number().nullable(),
  createdAt: Iso,
  updatedAt: Iso,
  completedAt: Iso.nullable(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const BugReportSchema = z
  .object({
    defect_found: z.boolean().optional(),
    summary: z.string().optional(),
    steps: z
      .array(
        z.object({
          timestamp_s: z.number(),
          description: z.string(),
          visible_text: z.string().optional(),
        }),
      )
      .optional()
      .default([]),
    first_failure_timestamp_s: z.number().optional(),
    expected_behavior: z.string().optional(),
    actual_behavior: z.string().optional(),
  })
  .nullable();

export const SuspectSchema = z.object({
  file: z.string(),
  start_line: z.number(),
  end_line: z.number(),
  symbol: z.string(),
  confidence: z.number(),
  symptom_link: z.string(),
});
export type Suspect = z.infer<typeof SuspectSchema>;

const Jsonish = z.any().nullable();

export const RunDetailSchema = z.object({
  id: z.string(),
  targetId: z.string(),
  state: RunStateSchema,
  stage: RunStageSchema,
  isSample: z.boolean(),
  executionMode: z.string().optional(),
  videoKey: z.string(),
  note: z.string().nullable(),
  outputs: z.object({
    bugReport: BugReportSchema,
    suspects: z.array(SuspectSchema).nullable(),
    generatedTest: z.string().nullable(),
    beforeTestResult: Jsonish,
    sameSymptomVerdict: z
      .object({ same_defect: z.boolean(), reason: z.string(), confidence: z.number().optional() })
      .nullable()
      .catch(null),
    diff: z.string().nullable(),
    afterTestResult: Jsonish,
    suiteResult: Jsonish,
    reportMarkdown: z.string().nullable(),
  }),
  metrics: z.object({
    totalTokens: z.number().nullable(),
    estimatedCostUsd: z.string().nullable(),
    durationMs: z.number().nullable(),
  }),
  createdAt: Iso,
  updatedAt: Iso,
  completedAt: Iso.nullable(),
});
export type RunDetail = z.infer<typeof RunDetailSchema>;

export const RunEventSchema = z.object({
  run_id: z.string(),
  seq: z.number(),
  stage: RunStageSchema,
  event_type: z.string(),
  agent: z.string(),
  payload: z.record(z.unknown()),
  timestamp: z.string(),
});
export type RunEvent = z.infer<typeof RunEventSchema>;

export const HealthSchema = z.object({
  status: z.string(),
  availableSamples: z.array(z.string()),
  limits: z.object({ maxUploadBytes: z.number(), allowedMimeTypes: z.array(z.string()) }),
  models: z
    .object({
      keyConfigured: z.boolean(),
      roles: z.record(z.string()),
      note: z.string().optional(),
    })
    .partial({ roles: true, note: true })
    .optional(),
});

export const ReadySchema = z.object({
  status: z.string(),
  executionMode: z
    .enum(['live', 'recorded_sample_replay', 'fixture_assisted', 'read_only'])
    .optional(),
  canExecuteLiveRun: z.boolean().optional(),
  canReplayRecordedSamples: z.boolean().optional(),
  blockers: z.array(z.string()).optional().default([]),
  checks: z.record(z.string()).optional().default({}),
});
export type ReadyPayload = z.infer<typeof ReadySchema>;

export const CreateRunResponseSchema = z.object({
  id: z.string(),
  state: RunStateSchema,
  stage: RunStageSchema,
});
export type CreateRunResponse = z.infer<typeof CreateRunResponseSchema>;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { ...init, cache: 'no-store' });
  if (!res.ok) {
    let message = `Request failed with status ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      message = body.message || body.error || message;
    } catch {
      // no JSON body, keep the status message
    }
    throw new ApiError(message, res.status);
  }
  const json: unknown = await res.json();
  return schema.parse(json);
}

export function getSamples(): Promise<{ samples: Sample[] }> {
  return request('/api/samples', z.object({ samples: z.array(SampleSchema) }));
}

export function getRun(id: string): Promise<RunDetail> {
  return request(`/api/runs/${encodeURIComponent(id)}`, RunDetailSchema);
}

export function listRuns(limit = 50): Promise<{ runs: RunSummary[] }> {
  return request(`/api/runs?limit=${limit}`, z.object({ runs: z.array(RunSummarySchema) }));
}

export interface HealthStatus {
  ok: boolean;
  modelsKeyConfigured?: boolean;
}

export async function checkHealth(): Promise<HealthStatus> {
  try {
    const res = await fetch(`${API_BASE}/api/health`, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false };
    const parsed = HealthSchema.partial({ availableSamples: true, limits: true }).parse(await res.json());
    return { ok: true, modelsKeyConfigured: parsed.models?.keyConfigured };
  } catch {
    return { ok: false };
  }
}

export interface ReadyStatus extends ReadyPayload {
  ok: boolean;
}

export async function checkReady(): Promise<ReadyStatus> {
  try {
    const res = await fetch(`${API_BASE}/api/ready`, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      return {
        ok: false,
        status: 'offline',
        blockers: ['The API readiness endpoint returned an error.'],
        checks: {},
      };
    }
    const parsed = ReadySchema.parse(await res.json());
    return { ok: true, ...parsed };
  } catch {
    return {
      ok: false,
      status: 'offline',
      blockers: ['The API readiness endpoint could not be reached.'],
      checks: {},
    };
  }
}

/** Start a run from a known sample. Server answers are final. */
export function createSampleRun(sampleId: string, note?: string): Promise<CreateRunResponse> {
  return request('/api/runs', CreateRunResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sampleId, note }),
  });
}

/** Upload a video file. The server validates size and type again. */
export async function uploadVideo(file: File, note?: string): Promise<CreateRunResponse> {
  const body = new FormData();
  body.set('file', file);
  if (note) body.set('note', note);
  return request('/api/runs', CreateRunResponseSchema, { method: 'POST', body });
}

export function rerunRun(id: string): Promise<CreateRunResponse> {
  return request(`/api/runs/${encodeURIComponent(id)}/rerun`, CreateRunResponseSchema, { method: 'POST' });
}

export function pollEvents(id: string): Promise<{ events: RunEvent[] }> {
  return request(`/api/runs/${encodeURIComponent(id)}/events-page`, z.object({ events: z.array(RunEventSchema) }));
}

export function sseUrl(runId: string): string {
  return `${API_BASE}/api/runs/${encodeURIComponent(runId)}/events`;
}
