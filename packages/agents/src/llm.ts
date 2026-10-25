import OpenAI from 'openai';
import { z } from 'zod';

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
}

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
  async callJson<T>(
    model: string,
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    opts: CallJsonOptions = {}
  ): Promise<LlmResponse<T>> {
    const temperature = opts.temperature ?? 0.1;
    const jsonMode = opts.jsonMode !== false;
    const extraBody =
      opts.enableThinking === false ? { chat_template_kwargs: { enable_thinking: false } } : {};
    const startTime = Date.now();

    const response = await this.openai.chat.completions.create({
      model,
      messages,
      temperature,
      ...(jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
      ...extraBody,
    });

    const durationMs = Date.now() - startTime;
    const choice = response.choices[0];
    const rawContent = choice?.message?.content || '';

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
      return this.retryJson(model, messages, rawContent, `Invalid JSON syntax: ${parseErr.message}`, schema, metrics, jsonMode, extraBody);
    }

    const validated = schema.safeParse(parsedJson);
    if (!validated.success) {
      const errorMsg = validated.error.issues
        .map(i => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      return this.retryJson(model, messages, rawContent, `Schema validation failed: ${errorMsg}`, schema, metrics, jsonMode, extraBody);
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
    extraBody: Record<string, unknown> = {}
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

    const response = await this.openai.chat.completions.create({
      model,
      messages: repairMessages,
      temperature: 0.1,
      ...(jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
      ...extraBody,
    });

    const durationMs = Date.now() - startTime;
    const choice = response.choices[0];
    const rawContent = choice?.message?.content || '';

    const totalMetrics: ModelMetrics = {
      promptTokens: initialMetrics.promptTokens + (response.usage?.prompt_tokens ?? 0),
      completionTokens: initialMetrics.completionTokens + (response.usage?.completion_tokens ?? 0),
      totalTokens: initialMetrics.totalTokens + (response.usage?.total_tokens ?? 0),
      durationMs: initialMetrics.durationMs + durationMs,
      model,
    };

    const parsedJson = JSON.parse(stripJsonFence(rawContent));
    const validated = schema.parse(parsedJson);

    return {
      data: validated,
      rawText: rawContent,
      metrics: totalMetrics,
    };
  }
}
