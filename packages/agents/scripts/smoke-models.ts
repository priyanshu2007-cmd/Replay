import * as fs from 'node:fs';
import * as path from 'node:path';
import { OpenAI } from 'openai';
import {
  AGENT_MODEL_DEFAULTS,
  NEBIUS_BASE_URL_DEFAULT,
  resolveApiKey,
  resolveModel,
  toLlmError,
  type AgentRole,
} from '../src/llm.js';

/**
 * One tiny live call per agent role against Nebius Token Factory.
 * Prints role, model, latency and ok/provider error. Never prints the key.
 * Requires NEBIUS_API_KEY (or per-role NEBIUS_API_KEY_<ROLE>) in .env.
 */

async function loadEnvFile(envPath: string): Promise<void> {
  try {
    const raw = await fs.promises.readFile(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
      }
    }
  } catch {
    // no .env
  }
}

async function main() {
  await loadEnvFile(path.resolve(process.cwd(), '../../.env'));
  console.log('=== Replay — Nebius Token Factory model smoke ===');
  console.log(`Base URL: ${process.env.NEBIUS_BASE_URL || NEBIUS_BASE_URL_DEFAULT}`);

  const roles: AgentRole[] = ['watcher', 'verifier', 'locator', 'reproducer', 'fixer', 'reporter'];
  const keyPresent = roles.map((r) => `${r}:${resolveApiKey(r) ? 'SET' : '-'}`).join('  ');
  console.log(`Keys  ${keyState(keyPresent)}`);

  const uniqueRoles: AgentRole[] = ['watcher', 'locator', 'reproducer', 'reporter'];
  let failures = 0;

  for (const role of uniqueRoles) {
    const model = resolveModel(role);
    const apiKey = resolveApiKey(role);
    if (!apiKey) {
      console.log(`FAIL  ${role} (${model}) — no API key configured (set NEBIUS_API_KEY or NEBIUS_API_KEY_${role.toUpperCase()})`);
      failures++;
      continue;
    }
    const client = new OpenAI({
      apiKey,
      baseURL: process.env.NEBIUS_BASE_URL || NEBIUS_BASE_URL_DEFAULT,
      timeout: 45_000,
      maxRetries: 0,
    });
    const start = Date.now();
    try {
      const res = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: 'Respond with the single word READY.' }],
        max_tokens: 256,
        temperature: 0.1,
      });
      const text = res.choices[0]?.message?.content?.trim() ?? '';
      console.log(`OK    ${role} (${model}) — ${Date.now() - start}ms — "${text.slice(0, 40)}" tokens ${res.usage?.total_tokens ?? 'n/a'}`);
    } catch (err) {
      const e = toLlmError(err, role, model);
      console.log(`FAIL  ${role} (${model}) — ${Date.now() - start}ms — ${e.code}${e.status ? ` HTTP ${e.status}` : ''}: ${e.message.slice(0, 120)}`);
      failures++;
    }
  }

  console.log(`\n${uniqueRoles.length - failures}/${uniqueRoles.length} roles OK`);
  if (failures > 0) process.exit(1);
}

function keyState(s: string): string {
  return s;
}

void main();
