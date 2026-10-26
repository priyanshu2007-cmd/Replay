# Replay: Master Build Prompt

Use this prompt at the root of the Replay Git repository in OpenCode, Claude Code, Codex, or another repository-aware coding agent. Keep the PDF Replay: Hackathon Build Plan available to the agent. This prompt is intentionally milestone-driven: do not ask an AI to generate the whole system in one giant pass.

## ROLE AND MISSION
Act as the senior staff engineer, test engineer, security reviewer, and product designer responsible for implementing Replay, a hackathon-ready AI bug-reproduction and verified-fix platform.

Replay turns a short screen recording of a web-app defect into:
1. a timestamped bug report;
2. ranked, source-verified code suspects;
3. a Playwright test that fails for the same defect for the right reason;
4. a minimal application-code patch;
5. a real passing reproduction test and existing test suite, or an honest not_fixed outcome;
6. an evidence-based Markdown report.

The product's promise is: “Drop a bug video. Get a failing test and a verified fix.”

The most important principle is truthful execution: never claim a bug was reproduced or fixed unless the corresponding test actually ran and the result was recorded. A generated diff, model answer, mocked tool, or assumed pass is not proof.

## SOURCE OF TRUTH AND DECISIONS
1. Read the complete Replay: Hackathon Build Plan.pdf if it exists in the workspace. Treat its intended product, stack, agent roles, gates, screen requirements, and benchmark honesty as the requirements baseline.
2. Inspect repository state before editing: git status, current branch, all relevant package manifests, workspace config, lockfile, environment examples, tests, CI, Docker setup, existing AGENTS.md, AI_TOOLKIT.md, and project-specific agent/skill instructions. Follow existing repository rules. If a Ponytail or equivalent engineering skill is configured, use its inspect-first, minimal-change, verify-each-change process.
3. Do not assume the repository is empty. Reuse working code and preserve architecture unless there is evidence a change is necessary.
4. If the PDF, existing code, official provider docs, and package APIs conflict, do not silently guess. Add the smallest clear entry to docs/IMPLEMENTATION_DECISIONS.md describing the conflict, the chosen resolution, and the reason. Prefer the PDF's intent while choosing one consistent implementation.
5. Before relying on model IDs, SDK behavior, provider image support, tool calling, free-tier quotas, or deployment settings, verify them with a small real smoke test and the provider's current official documentation. Do not silently substitute a different provider or model.
6. Never commit secrets. .env.example contains names and safe placeholders only. Never print API keys or service-role keys in logs.

## NON-NEGOTIABLE ENGINEERING RULES
- TypeScript end to end, strict mode, Node.js 22 LTS as the plan's baseline, pnpm workspaces, Zod validation for all external/model-generated data.
- Use the plan's stack unless a real incompatibility is found: Next.js + Tailwind + shadcn/ui for the web app; Hono for API/SSE; a separate worker process; OpenAI-compatible openai SDK for Nebius Token Factory; Supabase Postgres and Storage; Drizzle ORM; ffmpeg for frame extraction; Repomix or a bounded equivalent for repository packing; ripgrep for source search; Playwright Test; Docker sandbox.
- Keep prompts versioned under packages/agents/prompts/. Each model agent has one job, a strict output schema, short testable rules, explicit limits, and an honest unknown/failure result.
- Prefer small, complete, reviewable changes. Do not perform unrelated refactors, add unnecessary dependencies, or overwrite existing user work.
- After every meaningful change, run the narrowest relevant test, then the relevant package build/typecheck/lint. At phase boundaries run the broader suite.
- No dead controls, fake progress, decorative stats presented as real, dummy test logs, invented run data, or hard-coded “success” states.
- Use explicit loading, empty, offline, queued, running, reproduced-only, fixed, unreproduced, failed, and partial-evidence states.
- Model/tool output is untrusted input. Parse and validate it; never execute free-form model text directly as shell commands.
- Never edit tests, package files, Playwright config, or build config from the Fixer agent. The Fixer may patch application files only.
- Do not weaken assertions to make tests pass. A valid reproduction fails because the expected behavior is violated, not due to timeout, bad selector, syntax error, missing app, or infrastructure failure.
- A fix is verified only when both the generated reproduction test and the pre-existing suite pass after the patch.
- Store every stage, model call, tool call, result, token count, latency, and actual cost that is available. If cost or token usage is unavailable, represent it as unavailable, not zero.
- Never use a mocked provider, mocked sandbox, or fake test result to claim an end-to-end milestone is complete. Unit tests may mock dependencies, but the live integration acceptance test must run real services.
- If an essential external credential, account, Docker daemon, or deployed resource is unavailable, finish the parts that can be verified locally, identify the blocker, and give the exact next action. Never mark blocked work as done.

## ARCHITECTURE
Implement one coherent TypeScript monorepo. Use apps/api for the Hono API and worker unless the existing repository already has a consistent alternative; do not maintain two competing API locations. The web app is apps/web. Keep the target app isolated from the Replay UI.

Suggested structure:
replay/
  AGENTS.md
  README.md
  LICENSE
  .env.example
  pnpm-workspace.yaml
  package.json
  tsconfig.base.json
  docker-compose.yml
  apps/
    web/                         # Next.js UI deployed to Vercel
    api/                         # Hono server and separate worker entrypoint
      src/server.ts
      src/worker.ts
  packages/
    agents/
      prompts/                   # watcher, locator, reproducer, fixer, verifier, reporter
      src/llm.ts
      src/runAgent.ts
      src/schemas.ts
      src/pipeline.ts
      src/tools/
    sandbox/                     # isolated Docker execution and lifecycle
    video/                       # ffmpeg frame extraction
    storage/                     # server-side Supabase Storage helpers
    db/                          # Drizzle schema, migrations, queries
    shared/                      # shared Zod schemas and event types if useful
  targets/
    demo-shop/                   # React + Vite application with planted bugs
  sandbox-images/
    Dockerfile.demo-shop
  samples/                       # videos and expected.json files
  eval/
    run-benchmark.ts
  scripts/
    smoke.ts
  docs/
    IMPLEMENTATION_DECISIONS.md
    MASTER_BUILD_PROMPT.md

## PHASED EXECUTION PLAN
Treat the source plan's 36 steps as acceptance gates. Do not start a later phase while the earlier phase's gate is failing. A phase is complete only with recorded command output or equivalent test evidence.

- Phase 0: Repository audit and implementation contract
- Phase A: Setup (Accounts, Smoke test, Monorepo scaffold, Database and storage)
- Phase B: Demo Shop (React+Vite target, Baseline tests, 5 planted bugs, Sample videos)
- Phase C: Perception (Frame extraction, LLM client, Watcher, Repo packer, Locator)
- Phase D: Action agents and CLI (Docker sandbox, Agent tools, Reproducer, Verifier, Fixer, Reporter, CLI pipeline)
- Phase E: Backend (Worker queue, Hono API + SSE, Uploads & samples)
- Phase F: Frontend (Design system, Home, Video timeline, Live SSE trace, Panels, Replay mode, Benchmark & How)
- Phase G: Ship (Deploy, Benchmark run, Hallway test, Video demo, Submission)
