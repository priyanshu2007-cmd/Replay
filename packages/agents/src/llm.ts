import OpenAI from 'openai';
import { z } from 'zod';
import * as path from 'node:path';

export const NEBIUS_BASE_URL_DEFAULT = 'https://api.tokenfactory.nebius.com/v1/';

export type AgentRole = 'watcher' | 'verifier' | 'locator' | 'reproducer' | 'fixer' | 'reporter';

export interface AgentModelConfig {
  /** Default Token Factory model ID; override via MODEL_<ROLE> env. */
  model: string;
  /** Env var holding this role's API key override. */
  apiKeyEnv: string;
}

// Central role→model map: the single source of truth every agent reads.
// IDs are the Token Factory catalog entries from the build plan; verify live
// with `pnpm smoke:models` once NEBIUS_API_KEY is set.
export const AGENT_MODEL_DEFAULTS: Record<AgentRole, AgentModelConfig> = {
  watcher: { model: 'nvidia/Nemotron-3.5-Super-VL', apiKeyEnv: 'NEBIUS_API_KEY_WATCHER' },
  verifier: { model: 'nvidia/Nemotron-3.5-Super-VL', apiKeyEnv: 'NEBIUS_API_KEY_VERIFIER' },
  locator: { model: 'nvidia/Nemotron-3_5-Lightning', apiKeyEnv: 'NEBIUS_API_KEY_LOCATOR' },
  reproducer: { model: 'nvidia/Nemotron-3-Ultra-550b-a55b', apiKeyEnv: 'NEBIUS_API_KEY_REPRODUCER' },
  fixer: { model: 'nvidia/Nemotron-3-Ultra-550b-a55b', apiKeyEnv: 'NEBIUS_API_KEY_FIXER' },
  reporter: { model: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B', apiKeyEnv: 'NEBIUS_API_KEY_REPORTER' },
};

export function resolveModel(role: AgentRole): string {
  return process.env[`MODEL_${role.toUpperCase()}`] || AGENT_MODEL_DEFAULTS[role].model;
}

export function resolveApiKey(role?: AgentRole): string | undefined {
  if (role) {
    const roleKey = process.env[AGENT_MODEL_DEFAULTS[role].apiKeyEnv];
    if (roleKey) return roleKey;
  }
  return process.env.NEBIUS_API_KEY || undefined;
}

/** Provider errors are surfaced, classified and redacted, never swallowed. */
export type LlmErrorCode = 'auth' | 'model_not_found' | 'rate_limited' | 'unreachable' | 'bad_output' | 'unknown';

export class LlmError extends Error {
  constructor(
    message: string,
    readonly code: LlmErrorCode,
    readonly role: AgentRole | 'unknown',
    readonly model: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(redactSecretText(message));
    this.name = 'LlmError';
  }
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|nvapi|napi)[-_][A-Za-z0-9_-]{8,}/g,
  /Bearer\s+\S+/gi,
  /\beyJ[A-Za-z0-9_-]{10,}/g,
];

export function redactSecretText(text: string): string {
  return SECRET_PATTERNS.reduce((acc, p) => acc.replace(p, '[redacted]'), text);
}

/** Classify a raw provider/SDK error into an LlmError with a stable code. */
export function toLlmError(err: unknown, role: AgentRole | 'unknown', model: string): LlmError {
  const e = err as { status?: number; code?: string; message?: string; name?: string };
  const status = e?.status;
  const raw = String(e?.message ?? err);
  if (status === 401 || status === 403) return new LlmError(raw || 'API key rejected', 'auth', role, model, status);
  if (status === 404) return new LlmError(raw || 'Model not found', 'model_not_found', role, model, status);
  if (status === 429) return new LlmError(raw || 'Rate limited', 'rate_limited', role, model, status, true);
  if (status && status >= 500) return new LlmError(raw, 'unreachable', role, model, status, true);
  if (e?.name === 'TimeoutError' || /timeout|ECONNREFUSED|ENOTFOUND|fetch failed|network/i.test(raw)) {
    return new LlmError(raw, 'unreachable', role, model, undefined, true);
  }
  return new LlmError(raw, 'unknown', role, model, status);
}

export interface LlmConfig {
  apiKey?: string;
  baseURL?: string;
  timeoutMs?: number;
}

export interface ModelMetrics {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
  model: string;
}

export interface LlmResponse<T> {
  data: T;
  rawText: string;
  metrics: ModelMetrics;
}

export interface CallJsonOptions {
  temperature?: number;
  /** Set false for models that reject response_format json_object; strict prompt + Zod still enforce shape. */
  jsonMode?: boolean;
  /** Set false on NVIDIA NIM hybrid models (e.g. Lightning) to disable long thinking traces that stall non-streaming calls. */
  enableThinking?: boolean;
  /** Which agent is calling: drives error classification and the token cap. */
  role?: AgentRole;
  /** Output cap. Per-role defaults below; env MODEL_<ROLE>_MAX_TOKENS overrides. */
  maxTokens?: number;
}

/** Output budgets per role (reasoning models burn tokens before the answer). */
const ROLE_MAX_TOKENS: Record<AgentRole, number> = {
  watcher: 2000,
  verifier: 2000,
  locator: 2000,
  reproducer: 4000,
  fixer: 4000,
  reporter: 1500,
};

function maxTokensFor(role: AgentRole | undefined, override?: number): number {
  if (override) return override;
  if (role) {
    const env = process.env[`MODEL_${role.toUpperCase()}_MAX_TOKENS`];
    if (env && Number(env) > 0) return Number(env);
    return ROLE_MAX_TOKENS[role];
  }
  return 2000;
}

const RETRY_DELAYS_MS = [1000, 3000];

/**
 * Directory of the calling module, or undefined when running from a CJS
 * bundle where import.meta is empty (esbuild shims it to undefined).
 * Callers must fall back to process.cwd()-relative or embedded resources.
 */
export function moduleDirOf(importMetaUrl: string | undefined): string | undefined {
  try {
    // Lazy import to avoid pulling node:url into browser-ish contexts.
    const { fileURLToPath } = require('node:url');
    if (!importMetaUrl) return undefined;
    return path.dirname(fileURLToPath(importMetaUrl));
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms + Math.floor(Math.random() * 250)));

function stripJsonFence(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
}

export class LlmClient {
  private openai: OpenAI;

  constructor(config?: LlmConfig) {
    const apiKey = config?.apiKey || resolveApiKey();
    const baseURL = config?.baseURL || process.env.NEBIUS_BASE_URL || NEBIUS_BASE_URL_DEFAULT;

    if (!apiKey) {
      throw new Error('NEBIUS_API_KEY (or a per-role NEBIUS_API_KEY_<ROLE>) is required to initialize LlmClient');
    }

    this.openai = new OpenAI({
      apiKey,
      baseURL,
      timeout: config?.timeoutMs ?? 90_000,
      // maxRetries 0: surface provider errors and rate limits honestly instead of masking them
      maxRetries: 0,
    });
  }

  /**
   * Call model requesting JSON and validate with Zod schema.
   * If validation fails, retries at most once with the exact validation error attached.
   */
  /**
   * Call a model for JSON with classification, bounded retries and validation.
   * Provider errors become LlmError (auth/model_not_found/rate_limited/
   * unreachable); retryable codes back off 1s/3s. Empty output and a second
   * validation failure become bad_output. Every failure is classified, none
   * silently swallowed.
   */
  async callJson<T>(
    model: string,
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    opts: CallJsonOptions = {}
  ): Promise<LlmResponse<T>> {
    const role = opts.role ?? 'unknown';
    let lastError: LlmError | undefined;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0 && lastError) {
        await sleep(RETRY_DELAYS_MS[attempt - 1]!);
      }
      try {
        return await this.callJsonOnce<T>(model, messages, schema, opts);
      } catch (err) {
        lastError = err instanceof LlmError ? err : toLlmError(err, role, model);
        if (!lastError.retryable || attempt === RETRY_DELAYS_MS.length) break;
      }
    }
    throw lastError ?? new LlmError('Model call failed', 'unknown', role, model);
  }

  private async callJsonOnce<T>(
    model: string,
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    opts: CallJsonOptions & { role?: AgentRole | 'unknown' } = {}
  ): Promise<LlmResponse<T>> {
    const role = opts.role ?? 'unknown';
    const temperature = opts.temperature ?? 0.1;
    const jsonMode = opts.jsonMode !== false;
    const extraBody =
      opts.enableThinking === false ? { chat_template_kwargs: { enable_thinking: false } } : {};
    const startTime = Date.now();

    let response: OpenAI.Chat.ChatCompletion;
    try {
      response = await this.openai.chat.completions.create({
        model,
        messages,
        temperature,
        max_tokens: maxTokensFor(role === 'unknown' ? undefined : role as AgentRole, opts.maxTokens),
        ...(jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
        ...extraBody,
      });
    } catch (err) {
      throw toLlmError(err, role as AgentRole, model);
    }

    const durationMs = Date.now() - startTime;
    const choice = response.choices[0];
    const rawContent = choice?.message?.content || '';
    if (!rawContent.trim()) {
      throw new LlmError(
        `Model returned empty content (finish_reason: ${choice?.finish_reason ?? 'unknown'})`,
        'bad_output', role as AgentRole, model,
      );
    }

    const metrics: ModelMetrics = {
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      totalTokens: response.usage?.total_tokens ?? 0,
      durationMs,
      model,
    };

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(stripJsonFence(rawContent));
    } catch (parseErr: any) {
      // Retry once with error context
      return this.retryJson(model, messages, rawContent, `Invalid JSON syntax: ${parseErr.message}`, schema, metrics, jsonMode, extraBody, role);
    }

    const validated = schema.safeParse(parsedJson);
    if (!validated.success) {
      const errorMsg = validated.error.issues
        .map(i => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      return this.retryJson(model, messages, rawContent, `Schema validation failed: ${errorMsg}`, schema, metrics, jsonMode, extraBody, role);
    }

    return {
      data: validated.data,
      rawText: rawContent,
      metrics,
    };
  }

  private async retryJson<T>(
    model: string,
    originalMessages: OpenAI.Chat.ChatCompletionMessageParam[],
    invalidOutput: string,
    errorDetails: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    initialMetrics: ModelMetrics,
    jsonMode: boolean,
    extraBody: Record<string, unknown> = {},
    role: AgentRole | 'unknown' = 'unknown'
  ): Promise<LlmResponse<T>> {
    const startTime = Date.now();
    const repairMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      ...originalMessages,
      { role: 'assistant', content: invalidOutput },
      {
        role: 'user',
        content: `Your previous output had validation errors: ${errorDetails}. Please output strictly valid JSON conforming to the schema. Output JSON only.`
      }
    ];

    let response: OpenAI.Chat.ChatCompletion;
    try {
      response = await this.openai.chat.completions.create({
        model,
        messages: repairMessages,
        temperature: 0.1,
        max_tokens: maxTokensFor(role === 'unknown' ? undefined : role as AgentRole),
        ...(jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
        ...extraBody,
      });
    } catch (err) {
      throw toLlmError(err, role as AgentRole, model);
    }

    const durationMs = Date.now() - startTime;
    const choice = response.choices[0];
    const rawContent = choice?.message?.content || '';
    if (!rawContent.trim()) {
      throw new LlmError('Model returned empty content on the validation retry', 'bad_output', role, model);
    }

    const totalMetrics: ModelMetrics = {
      promptTokens: initialMetrics.promptTokens + (response.usage?.prompt_tokens ?? 0),
      completionTokens: initialMetrics.completionTokens + (response.usage?.completion_tokens ?? 0),
      totalTokens: initialMetrics.totalTokens + (response.usage?.total_tokens ?? 0),
      durationMs: initialMetrics.durationMs + durationMs,
      model,
    };

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(stripJsonFence(rawContent));
      return {
        data: schema.parse(parsedJson),
        rawText: rawContent,
        metrics: totalMetrics,
      };
    } catch (err) {
      // Second failure: deterministic bad_output, with a redacted output head.
      const detail = err instanceof z.ZodError
        ? 'schema validation failed'
        : 'invalid JSON';
      throw new LlmError(
        `Model output ${detail} after retry. Output head: ${redactSecretText(rawContent).slice(0, 300)}`,
        'bad_output', role as AgentRole, model,
      );
    }
  }
}
