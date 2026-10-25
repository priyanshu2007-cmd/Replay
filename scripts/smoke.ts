import OpenAI from 'openai';
import * as dotenv from 'dotenv';
import { AgentRole, resolveApiKey, resolveModel, NVIDIA_BASE_URL_DEFAULT } from '../packages/agents/src/llm.js';

dotenv.config();

interface CheckResult {
  name: string;
  ok: boolean;
  ms: number;
  detail: string;
}

const results: CheckResult[] = [];

function client(role: AgentRole): OpenAI {
  const apiKey = resolveApiKey(role);
  if (!apiKey) throw new Error(`No API key resolved for role '${role}'`);
  return new OpenAI({
    apiKey,
    baseURL: process.env.NVIDIA_BASE_URL || NVIDIA_BASE_URL_DEFAULT,
    timeout: 45_000,
    maxRetries: 0,
  });
}

function errDetail(err: unknown): string {
  const e = err as { status?: number; message?: string };
  const status = e?.status ?? 'n/a';
  const msg = String(e?.message ?? err).slice(0, 160).replace(/\s+/g, ' ');
  return `HTTP ${status}: ${msg}`;
}

function usage(u: OpenAI.CompletionUsage | undefined): string {
  return u && typeof u.total_tokens === 'number' ? `tokens ${u.total_tokens}` : 'tokens n/a';
}

async function runCheck(name: string, fn: () => Promise<string>): Promise<void> {
  const start = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - start, detail });
    console.log(`  PASS  ${name} — ${Date.now() - start}ms — ${detail}`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - start, detail: errDetail(err) });
    console.log(`  FAIL  ${name} — ${Date.now() - start}ms — ${errDetail(err)}`);
  }
}

function validateEchoJson(raw: string): void {
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const parsed = JSON.parse(stripped) as { status?: unknown; n?: unknown };
  if (parsed.status !== 'ok' || typeof parsed.n !== 'number') {
    throw new Error(`shape mismatch: ${JSON.stringify(parsed).slice(0, 80)}`);
  }
}

async function main() {
  console.log('=== Replay — NVIDIA Build API Smoke Test ===');
  console.log(`Base URL: ${process.env.NVIDIA_BASE_URL || NVIDIA_BASE_URL_DEFAULT}`);

  // 1. Environment — report presence only, never values
  const roles: AgentRole[] = ['watcher', 'verifier', 'locator', 'reproducer', 'fixer', 'reporter'];
  const keyState = roles.map(r => `${r}:${resolveApiKey(r) ? 'SET' : '-'}`).join('  ');
  console.log(`Keys  ${keyState}  NVIDIA_API_KEY:${process.env.NVIDIA_API_KEY ? 'SET' : '-'}`);
  if (!roles.some(r => resolveApiKey(r))) {
    console.error('FATAL: no NVIDIA_API_KEY and no per-role key set. Live checks blocked.');
    process.exit(1);
  }

  // 2+3. Minimal text completion per unique model, each with its designated key.
  // verifier shares watcher's model+key, fixer shares reproducer's — noted, not re-billed.
  const pingRoles: AgentRole[] = ['watcher', 'locator', 'reproducer', 'reporter'];
  for (const role of pingRoles) {
    await runCheck(`ping ${role} (${resolveModel(role)})`, async () => {
      const res = await client(role).chat.completions.create({
        model: resolveModel(role),
        messages: [{ role: 'user', content: 'Respond with the single word READY.' }],
        // Reasoning models burn tokens before the answer; 512 keeps content non-empty for all roles
        max_tokens: 512,
        temperature: 0.1,
      });
      const text = res.choices[0]?.message?.content?.trim() ?? '';
      if (!text) throw new Error('empty completion');
      const good = text.includes('READY') ? '' : ' [note: READY not in output]';
      return `"${text.slice(0, 60)}"${good} ${usage(res.usage)}`;
    });
  }

  // 4. Vision: image input on the Watcher model (1x1 red PNG as data URL)
  const RED_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await runCheck('vision watcher (image input)', async () => {
    const res = await client('watcher').chat.completions.create({
      model: resolveModel('watcher'),
      max_tokens: 64,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is the dominant color of this image? Answer in one word.' },
            { type: 'image_url', image_url: { url: RED_PNG } },
          ],
        },
      ],
    });
    const text = res.choices[0]?.message?.content?.trim() ?? '';
    if (!text) throw new Error('empty completion');
    return `"${text.slice(0, 60)}" ${usage(res.usage)}`;
  });

  // 5. Tool calling on the Reproducer/Fixer model (Ultra)
  await runCheck('tool-calling reproducer (ultra)', async () => {
    const res = await client('reproducer').chat.completions.create({
      model: resolveModel('reproducer'),
      temperature: 0,
      max_tokens: 512,
      messages: [{ role: 'user', content: 'Call the ping tool now.' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'ping',
            description: 'Harmless test tool. Reply with pong.',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
    });
    const msg = res.choices[0]?.message as { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } | undefined;
    if (msg?.tool_calls?.length) {
      const c = msg.tool_calls[0];
      return `tool_call ${c.function?.name}(${c.function?.arguments ?? ''}) ${usage(res.usage)}`;
    }
    throw new Error(`no tool_calls; content="${String(msg?.content ?? '').slice(0, 80)}"`);
  });

  // 6. JSON discipline on the Reporter model: strict prompt + shape validation, then response_format probe
  await runCheck('json+shape reporter (strict prompt)', async () => {
    const res = await client('reporter').chat.completions.create({
      model: resolveModel('reporter'),
      temperature: 0,
      max_tokens: 512,
      messages: [{ role: 'user', content: 'Return only JSON matching {"status":"ok","n":42}. No other text, no markdown.' }],
    });
    validateEchoJson(res.choices[0]?.message?.content?.trim() ?? '');
    return `parsed+validated ${usage(res.usage)}`;
  });
  await runCheck('json_mode reporter (response_format)', async () => {
    const res = await client('reporter').chat.completions.create({
      model: resolveModel('reporter'),
      temperature: 0,
      max_tokens: 512,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: 'Return only JSON matching {"status":"ok","n":7}.' }],
    });
    validateEchoJson(res.choices[0]?.message?.content?.trim() ?? '');
    return `response_format json_object accepted ${usage(res.usage)}`;
  });

  const failed = results.filter(r => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  if (failed.length) {
    console.log(`Failed: ${failed.map(f => f.name).join(', ')}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal smoke error:', (err as Error)?.message ?? err);
  process.exit(1);
});
