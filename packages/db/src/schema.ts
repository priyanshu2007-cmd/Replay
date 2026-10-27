import { pgTable, text, timestamp, uuid, integer, boolean, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';

export const targets = pgTable('targets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  repoPath: text('repo_path').notNull(),
  sandboxImage: text('sandbox_image').notNull(),
  localBaseUrl: text('local_base_url').notNull(),
  testCommand: text('test_command').default('pnpm test').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const runs = pgTable('runs', {
  id: uuid('id').defaultRandom().primaryKey(),
  targetId: text('target_id').references(() => targets.id).notNull(),
  videoKey: text('video_key').notNull(),
  note: text('note'),
  state: text('state').notNull().default('queued'), // queued, running, reproduced_only, fixed, unreproduced, failed
  stage: text('stage').notNull().default('ingest'), // ingest, watch, locate, reproduce, verify, fix, report
  isSample: boolean('is_sample').default(false).notNull(),
  workerLock: text('worker_lock'),
  workerHeartbeat: timestamp('worker_heartbeat', { withTimezone: true }),
  
  // Model & Pipeline outputs
  bugReport: jsonb('bug_report'),
  suspects: jsonb('suspects'),
  generatedTest: text('generated_test'),
  beforeTestResult: jsonb('before_test_result'),
  sameSymptomVerdict: jsonb('same_symptom_verdict'),
  diff: text('diff'),
  afterTestResult: jsonb('after_test_result'),
  suiteResult: jsonb('suite_result'),
  reportMarkdown: text('report_markdown'),

  // Execution Metrics
  totalTokens: integer('total_tokens'),
  estimatedCostUsd: text('estimated_cost_usd'),
  durationMs: integer('duration_ms'),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => [
  index('runs_state_idx').on(table.state),
  index('runs_target_idx').on(table.targetId),
  index('runs_is_sample_idx').on(table.isSample),
  index('runs_created_at_idx').on(table.createdAt),
]);

export const runEvents = pgTable('run_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  runId: uuid('run_id').references(() => runs.id, { onDelete: 'cascade' }).notNull(),
  seq: integer('seq').notNull(),
  stage: text('stage').notNull(),
  agent: text('agent').notNull(),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('run_events_run_seq_idx').on(table.runId, table.seq),
  index('run_events_run_id_idx').on(table.runId),
]);

export const artifacts = pgTable('artifacts', {
  id: uuid('id').defaultRandom().primaryKey(),
  runId: uuid('run_id').references(() => runs.id, { onDelete: 'cascade' }).notNull(),
  kind: text('kind').notNull(), // video, frame, screenshot, trace, report
  storageKey: text('storage_key').notNull(),
  frameTimestampS: text('frame_timestamp_s'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('artifacts_run_id_idx').on(table.runId),
  index('artifacts_kind_idx').on(table.kind),
]);

export const rateLimitHits = pgTable('rate_limit_hits', {
  id: uuid('id').defaultRandom().primaryKey(),
  bucketKey: text('bucket_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('rate_limit_hits_bucket_created_idx').on(table.bucketKey, table.createdAt),
]);
