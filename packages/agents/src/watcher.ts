import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type OpenAI from 'openai';
import { BugReport, BugReportSchema } from '@replay/shared';
import { LlmClient, ModelMetrics, resolveApiKey, resolveModel } from './llm.js';

export const WATCHER_PROMPT_VERSION = 'v1';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

const PROMPT_CANDIDATES = [
  // src/watcher.ts and dist/watcher.js are both one level below packages/agents/prompts
  path.join(moduleDir, '../prompts/watcher.md'),
  path.join(moduleDir, '../../prompts/watcher.md'),
];

/** Load the versioned Watcher system prompt from packages/agents/prompts/watcher.md. */
export function loadWatcherPrompt(): string {
  for (const p of PROMPT_CANDIDATES) {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  throw new Error('watcher.md not found in packages/agents/prompts/');
}

export interface WatcherFrame {
  /** Frame timestamp in seconds within the recording. */
  timestampS: number;
  /** Raw JPEG frame bytes as base64 (no data: prefix). */
  jpegBase64: string;
}

export interface WatcherInput {
  frames: WatcherFrame[];
  note?: string;
  route?: string;
}

export interface WatcherDeps {
  /** Injectable for offline tests. Defaults to a live client using the watcher role's key. */
  client?: Pick<LlmClient, 'callJson'>;
  model?: string;
  maxFrames?: number;
}

export interface WatcherResult {
  report: BugReport;
  metrics: ModelMetrics;
  promptVersion: string;
  model: string;
}

/** Plan budget: ~40 frames per run. */
export const MAX_FRAMES_PER_REQUEST = 40;

/**
 * Analyze timestamped recording frames and return a validated BugReport.
 * Frames are sorted chronologically, labeled `t=X.Xs`, and sent as base64 JPEG
 * data-URL image parts — never as filesystem paths. Malformed or schema-invalid
 * model output is rejected by the client's bounded validation retry.
 */
export async function analyzeBugVideo(input: WatcherInput, deps: WatcherDeps = {}): Promise<WatcherResult> {
  const frames = [...input.frames].sort((a, b) => a.timestampS - b.timestampS);
  if (frames.length === 0) {
    throw new Error('Watcher requires at least one frame');
  }
  const maxFrames = deps.maxFrames ?? MAX_FRAMES_PER_REQUEST;
  if (frames.length > maxFrames) {
    throw new Error(`Too many frames for one Watcher request: ${frames.length} > ${maxFrames}. Batch or downsample first.`);
  }

  const client = deps.client ?? new LlmClient({ apiKey: resolveApiKey('watcher') });
  const model = deps.model ?? resolveModel('watcher');

  const content: OpenAI.Chat.ChatCompletionContentPart[] = [];
  if (input.note) content.push({ type: 'text', text: `Reporter note: ${input.note}` });
  if (input.route) content.push({ type: 'text', text: `Known target route: ${input.route}` });
  for (const f of frames) {
    content.push({ type: 'text', text: `t=${f.timestampS.toFixed(1)}s` });
    content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${f.jpegBase64}` } });
  }

  const res = await client.callJson<BugReport>(
    model,
    [
      { role: 'system', content: loadWatcherPrompt() },
      { role: 'user', content },
    ],
    BugReportSchema
  );

  return { report: res.data, metrics: res.metrics, promptVersion: WATCHER_PROMPT_VERSION, model };
}
