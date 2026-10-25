import { z } from 'zod';

export const StepSchema = z.object({
  timestamp_s: z.number().nonnegative(),
  description: z.string().min(1),
  visible_text: z.string().optional(),
});
export type Step = z.infer<typeof StepSchema>;

export const BugReportSchema = z.object({
  defect_found: z.boolean(),
  summary: z.string().min(1),
  steps: z.array(StepSchema),
  first_failure_timestamp_s: z.number().nonnegative(),
  expected_behavior: z.string().min(1),
  actual_behavior: z.string().min(1),
  visible_text: z.array(z.string()).default([]),
  route: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1),
});
export type BugReport = z.infer<typeof BugReportSchema>;

export const SuspectSchema = z.object({
  file: z.string().min(1),
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
  symbol: z.string().min(1),
  confidence: z.number().min(0).max(1),
  symptom_link: z.string().min(1),
  evidence: z.string().min(1).optional(),
});
export type Suspect = z.infer<typeof SuspectSchema>;

export const LocatorOutputSchema = z.object({
  suspects: z.array(SuspectSchema).max(5),
  suggested_test_selectors: z.array(z.string()).default([]),
  route: z.string().nullable().default(null),
});
export type LocatorOutput = z.infer<typeof LocatorOutputSchema>;

export const ReproducerOutputSchema = z.object({
  reproduced: z.boolean(),
  test_name: z.string().min(1),
  assertion: z.string(),
  failure_message: z.string(),
  test_code: z.string(),
});
export type ReproducerOutput = z.infer<typeof ReproducerOutputSchema>;

export const VerifierClassificationSchema = z.enum([
  'GENUINE_REPRODUCTION',
  'UNEXPECTED_PASS',
  'UNRELATED_ASSERTION_FAILURE',
  'SELECTOR_OR_TIMEOUT',
  'COMPILATION_OR_RUNTIME_ERROR',
  'INFRASTRUCTURE_FAILURE',
  'INCONCLUSIVE',
]);
export type VerifierClassification = z.infer<typeof VerifierClassificationSchema>;

export const VerifierOutputSchema = z.object({
  same_defect: z.boolean(),
  classification: VerifierClassificationSchema.default('GENUINE_REPRODUCTION'),
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1),
});
export type VerifierOutput = z.infer<typeof VerifierOutputSchema>;

export const FixerOutputSchema = z.object({
  fixed: z.boolean(),
  target_file: z.string().min(1).default('src/App.tsx'),
  original_snippet: z.string().default(''),
  replacement_snippet: z.string().default(''),
  patch: z.string().default(''),
  explanation: z.string().min(1),
  attempts: z.number().int().nonnegative().default(1),
});
export type FixerOutput = z.infer<typeof FixerOutputSchema>;

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

export const RunEventSchema = z.object({
  run_id: z.string().uuid(),
  seq: z.number().int().positive(),
  stage: RunStageSchema,
  event_type: z.string().min(1),
  agent: z.string().min(1),
  payload: z.record(z.unknown()),
  timestamp: z.string().datetime(),
});
export type RunEvent = z.infer<typeof RunEventSchema>;

export const TargetConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  repo_path: z.string().min(1),
  sandbox_image: z.string().min(1),
  local_base_url: z.string().url(),
  test_command: z.string().default('pnpm test'),
});
export type TargetConfig = z.infer<typeof TargetConfigSchema>;

export const CulpritLocationSchema = z.object({
  file: z.string().min(1),
  lines: z.string().min(1),
  symbol: z.string().min(1),
  confidence: z.number().min(0).max(1),
  evidence: z.string().optional(),
});
export type CulpritLocation = z.infer<typeof CulpritLocationSchema>;

export const ReporterOutputSchema = z.object({
  run_id: z.string().min(1),
  status: RunStateSchema,
  title: z.string().min(1),
  executive_summary: z.string().min(1),
  video_analysis: z.enum(['live', 'fixture_assisted', 'none']),
  bug_summary: z.string().min(1),
  culprit_locations: z.array(CulpritLocationSchema),
  reproduction_test: z.object({
    test_name: z.string().min(1),
    assertion: z.string(),
    pre_fix_result: z.string(),
    test_code: z.string(),
  }),
  patch: z.object({
    target_file: z.string().optional(),
    explanation: z.string().optional(),
    diff: z.string().optional(),
    applied: z.boolean(),
  }),
  verification: z.object({
    repro_after_fix_passed: z.boolean(),
    baseline_regression_passed: z.boolean(),
    baseline_tests_passed: z.number().int().nonnegative(),
    baseline_tests_total: z.number().int().nonnegative(),
  }),
  markdown_report: z.string().min(1),
});
export type ReporterOutput = z.infer<typeof ReporterOutputSchema>;

