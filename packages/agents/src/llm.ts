import OpenAI from 'openai';
import { z } from 'zod';

export const NVIDIA_BASE_URL_DEFAULT = 'https://integrate.api.nvidia.com/v1';

export type AgentRole = 'watcher' | 'verifier' | 'locator' | 'reproducer' | 'fixer' | 'reporter';

export interface AgentModelConfig {
  /** Default NVIDIA Build catalog model ID; override via MODEL_<ROLE> env. */
  model: string;
  /** Env var holding this role's designated NVIDIA API key. */
  apiKeyEnv: string;
}

// Central role→model map: the single source of truth every agent reads.
// Keys are paired with models, not roles: verifier shares the watcher's key/model,
// fixer shares the reproducer's. Resolution is per-call so tests can vary env safely.
export const AGENT_MODEL_DEFAULTS: Record<AgentRole, AgentModelConfig> = {
  watcher: { model: 'nvidia/nemotron-3.5-super-vl-120b-a12b', apiKeyEnv: 'NVIDIA_API_KEY_WATCHER' },
  verifier: { model: 'nvidia/nemotron-3.5-super-vl-120b-a12b', apiKeyEnv: 'NVIDIA_API_KEY_VERIFIER' },
  locator: { model: 'nvidia/nemotron-3.5-lightning-30b-a3b', apiKeyEnv: 'NVIDIA_API_KEY_LOCATOR' },
  reproducer: { model: 'nvidia/nemotron-3-ultra-550b-a55b', apiKeyEnv: 'NVIDIA_API_KEY_REPRODUCER' },
  fixer: { model: 'nvidia/nemotron-3-ultra-550b-a55b', apiKeyEnv: 'NVIDIA_API_KEY_FIXER' },
  reporter: { model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', apiKeyEnv: 'NVIDIA_API_KEY_REPORTER' },
};

export function resolveModel(role: AgentRole): string {
  return process.env[`MODEL_${role.toUpperCase()}`] || AGENT_MODEL_DEFAULTS[role].model;
}

export function resolveApiKey(role?: AgentRole): string | undefined {
  if (role) {
    const roleKey = process.env[AGENT_MODEL_DEFAULTS[role].apiKeyEnv];
    if (roleKey) return roleKey;
  }
  return process.env.NVIDIA_API_KEY || undefined;
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
    const baseURL = config?.baseURL || process.env.NVIDIA_BASE_URL || NVIDIA_BASE_URL_DEFAULT;

    if (!apiKey) {
      throw new Error('NVIDIA_API_KEY (or a per-role NVIDIA_API_KEY_<ROLE>) is required to initialize LlmClient');
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
