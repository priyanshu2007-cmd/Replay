# Replay — Project Build Tracker & Status

This document tracks progress across all phases defined in `docs/HACKATHON_BUILD_PLAN.txt` (36 steps across 7 phases + Phase 0).

---

## Phase 0 — Repository Audit
Track repository inspection, architecture mapping, baseline tests, environment checks and identified blockers.

- [x] **Step 0.1 Architecture mapping & doc reconciliation** — `DONE`
  - Reconciled discrepancies in `docs/IMPLEMENTATION_DECISIONS.md`: 5 planted bugs (not 4), dual-entrypoint backend `apps/api` (`server.ts` + `worker.ts`), Node v24 LTS compatibility, NVIDIA Build inference keys.
- [x] **Step 0.2 Environment checks & toolchain verification** — `DONE`
  - Verified Node v24.18.0, pnpm 12.15.0.
  - Documented environment blockers: Host missing `ffmpeg` and Colima/Docker socket inactive.
- [x] **Step 0.3 Baseline test inspection** — `DONE`
  - Validated clean monorepo builds and typechecks across all packages.

---

## Phase A — Foundation (Steps 1–4)
Track account and credit setup, model smoke tests, monorepo setup, database schema and storage.

- [x] **Step 1 Accounts and credits** — `DONE`
  - Configured NVIDIA Build API keys in `.env` (`NVIDIA_API_KEY_LOCATOR`, `NVIDIA_API_KEY_REPRODUCER`, `NVIDIA_API_KEY_FIXER`, `NVIDIA_API_KEY_REPORTER`).
  - *Blocker Note:* Supabase production credentials unconfigured in local `.env` (using local mock/fallback).
- [x] **Step 2 Model smoke test** — `DONE`
  - Verified inference endpoints for Nemotron-3.5-Lightning, Nemotron-3-Ultra-550b, Nemotron-3-Nano-Omni.
- [x] **Step 3 Monorepo scaffold** — `DONE`
  - Configured pnpm workspaces with strict TypeScript, `apps/api`, `apps/web`, `packages/*`, and `targets/demo-shop`. `pnpm -r typecheck` passes.
- [/] **Step 4 Database and storage** — `PARTIAL`
  - `packages/db`: Drizzle schema for `targets`, `runs`, `run_events`, `artifacts` implemented.
  - `packages/storage`: Supabase Storage wrapper implemented.
  - *Blocker / Action Needed:* `DATABASE_URL` and `SUPABASE_URL` not set in `.env`; local in-memory/file storage fallback implemented for zero-dependency execution.

---

## Phase B — Demo Shop and Test Fixtures (Steps 5–8)
Track the Demo Shop, baseline tests, all five planted bugs, expected fixtures and genuine sample recordings.

- [x] **Step 5 Demo Shop app** — `DONE`
  - Built full React + Vite e-commerce app with cart, coupons, checkout, sorting in `targets/demo-shop`.
- [x] **Step 6 Baseline tests** — `DONE`
  - 6 Playwright baseline tests in `targets/demo-shop/tests/baseline.spec.ts` passing on clean state.
- [x] **Step 7 Plant bugs** — `DONE`
  - Planted all 5 benchmark bugs: `cart-nan`, `double-discount`, `string-sort`, `empty-email`, `quantity-reset`.
  - Bug suite `targets/demo-shop/tests/bugs.spec.ts` reproduces all 5 bugs deterministically.
- [x] **Step 8 Record samples** — `DONE`
  - Genuine WebM recordings and `expected.json` fixtures in `samples/` for all 5 bugs.

---

## Phase C — Video and Localization (Steps 9–13)
Track frame extraction, LLM client and schemas, Watcher, Repository Packer and Locator, including live versus offline verification.

- [ ] **Step 9 Frame extractor** — `BLOCKED`
  - Implementation ready in `packages/video/src/extractor.ts`.
  - *Blocker:* `ffmpeg` binary not installed on host PATH.
  - *Action Needed:* `brew install ffmpeg` to extract frames from video uploads.
- [x] **Step 10 LLM client and schemas** — `DONE`
  - `packages/agents/src/llm.ts`: Structured outputs, per-role model mapping, retries, and schema validation.
  - `packages/shared/src/schemas.ts`: Shared Zod schemas for BugReport, Suspects, TestResult, Patch, Events.
- [ ] **Step 11 Watcher agent** — `BLOCKED`
  - Implementation in `packages/agents/src/watcher.ts`.
  - *Blocker:* `NVIDIA_API_KEY_WATCHER` missing and FFmpeg not installed. Works via fixture-assisted input.
- [x] **Step 12 Repo packer** — `DONE`
  - `packages/agents/src/packer.ts`: Packs target repo with line numbers and token budget limits (<200K tokens).
- [x] **Step 13 Locator agent** — `DONE`
  - `packages/agents/src/locator.ts`: Evaluated against all 5 samples with 100% Top-3 accuracy (tested live with Nemotron-3.5-Lightning).

---

## Phase D — Reproduction and Fixing (Steps 14–20)
Track sandbox lifecycle, agent tools, orchestration and events, Reproducer, Verifier, Fixer, pipeline, CLI and Reporter.

- [x] **Step 14 Sandbox runner** — `DONE`
  - `packages/sandbox/src/index.ts`: Workspace isolation with temp directories and child processes.
- [x] **Step 15 Agent tools** — `DONE`
  - Safe tools (`read_file`, `search_code`, `write_test`, `run_test`, `apply_patch`, `run_suite`) with strict path guards.
- [x] **Step 16 Tool loop and events** — `DONE`
  - Typed `RunEvent` pipeline with sequence numbers and timestamps.
- [x] **Step 17 Reproducer + repro gate** — `DONE`
  - `packages/agents/src/reproducer.ts`: Generates focused Playwright reproduction tests. Rejects compilation errors and timeouts.
- [x] **Step 18 Same-symptom check (Verifier)** — `DONE`
  - `packages/agents/src/verifier.ts`: Classifies test failures (`GENUINE_REPRODUCTION`, `UNEXPECTED_PASS`, `UNRELATED_ASSERTION_FAILURE`, etc.).
- [x] **Step 19 Fixer + fix gate** — `DONE`
  - `packages/agents/src/fixer.ts`: Generates surgical code patches. Fix verified only when repro test and baseline suite pass.
- [x] **Step 20 Pipeline + CLI + Reporter** — `DONE`
  - `packages/agents/src/pipeline.ts`: End-to-end orchestration.
  - `packages/agents/src/cli.ts`: `pnpm replay <sampleId>` CLI.
  - `packages/agents/src/reporter.ts`: Produces comprehensive Markdown reports with token and latency metrics. Verified live on `cart-nan` (status: `FIXED`).

---

## Phase E — Worker and API (Steps 21–23)
Track worker processing, API endpoints, SSE events, uploads, sample selection, persistence and integration tests.

- [x] **Step 21 Worker** — `DONE`
  - Built `apps/api/src/worker.ts` & `apps/api/src/runs.ts`.
  - Atomic run claiming (`FOR UPDATE SKIP LOCKED` for PostgreSQL; atomic queue with lock tracking for memory fallback).
  - Background pipeline execution using `runPipeline`, stage transition events, heartbeat management, stale timeout recovery, bounded retries, and graceful `SIGINT`/`SIGTERM` shutdown.
  - Verified by 7 deterministic unit tests in `apps/api/src/worker.test.ts`.
- [x] **Step 22 API + SSE** — `DONE`
  - Built `apps/api/src/server.ts` with Hono.
  - Implemented endpoints: `GET /health`, `GET /api/health`, `POST /api/runs`, `GET /api/runs`, `GET /api/runs/:id`, `GET /api/runs/:id/events` (SSE streaming history then live events).
  - CORS, structured error schemas, Zod validation, and path traversal protection.
  - Verified by 15 deterministic unit tests in `apps/api/src/server.test.ts`.
- [x] **Step 23 Uploads and samples** — `DONE`
  - Supported creating runs from the 5 golden samples (`cart-nan`, `double-discount`, `string-sort`, `empty-email`, `quantity-reset`).
  - Supported video file uploads (`multipart/form-data`) with MIME validation (`video/webm`, `video/mp4`), 50MB file size limit, and UUID sanitized destination filenames in `./artifacts/uploads/`.
  - Verified by multipart and upload validation test cases.

---

## Phase F — Frontend (Steps 24–30)
Track the design system, homepage, run workspace, video panel and timeline, code and test panels, replay interaction, benchmark view and how-it-works page.

- [x] **Step 24 Design system** — `DONE`
  - Tokens in `apps/web/app/globals.css` (dark default + full light theme, one variable set, computed contrast in `docs/design/ui-ux-design.md`); Geist Sans/Mono; component inventory (buttons, input, dropzone, sample card, model badge, stage row, status pill, code/diff/terminal panels, evidence card, skeletons, empty/error states) with keyboard, focus and reduced-motion states.
  - `/dev/components` reference page (development-only in production builds).
  - Design docs in `docs/design/` (research, ui-ux, userflow, mascot); HIG reviewer applied pre-build and post-build, findings + statuses in `docs/design/design-review.md`; slop sweep clean (no emoji, em dashes, banned words, gradients, glass, stock imagery).
- [x] **Step 25 Home page** — `DONE`
  - Real samples from `GET /api/samples` with genuine recording previews (poster at 0.8s, hover playback); one click creates a run via `POST /api/runs` and navigates to the workspace.
  - Upload dropzone: client validation of type, 50 MB size and 30 s duration (read from media metadata), server answer final; optional note.
  - No stats strip (no `/api/stats` endpoint exists; nothing invented).
- [x] **Step 26 Video panel** — `DONE`
  - Native player with real recording, step markers from the Watcher BugReport, red failure marker, auto-seek to failure on `watch_completed`, Space/J/K keyboard scoped to the panel.
- [/] **Step 27 Agent timeline** — `PARTIAL`
  - SSE client (`hooks/use-run-events.ts`): typed events, seq de-dup, bounded exponential backoff reconnect, stops on `stream_closed`, no polling.
  - Stage rows from real events: status dot (pending/running/done/failed/blocked via fixture-fallback), model badge, per-stage elapsed, expandable event payloads. Run-level tokens/cost/duration in the header.
  - Remaining: per-stage token/cost breakdown awaits pipeline event payloads (not emitted today); deliberately not invented.
- [x] **Step 28 Code, test, evidence panels** — `DONE`
  - Monaco (lazy, client-only) for Test and Diff; Suspects with file/lines/symbol/confidence; Terminal from real before/after/suite results; evidence card captures the real failure frame from the recording and shows the stored same-symptom verdict; report rendered as Markdown with Copy as GitHub issue and Download test actions.
- [/] **Step 29 Replay mode** — `PARTIAL`
  - Live/replay divergence implemented: empty `NEXT_PUBLIC_API_URL` or failed health check switches Home to replay/offline modes with the recorded-run banner and upload disabled with a reason (`lib/replay.ts` reads Supabase anon, `is_sample` only).
  - Remaining: unverified against a real Supabase project (no Supabase credentials configured); without it the honest offline state is shown. No fake completed runs.
- [x] **Step 30 Benchmark and How pages** — `DONE`
  - Benchmark table from real run records (id, sample, outcome pill, stage, duration, created) including failures; empty state explains how to generate results.
  - How page: pipeline diagram, model-per-stage table from the actual configuration (NVIDIA Build models), honesty paragraph.
- [x] **Mascot (Reel)** — `DONE`
  - Definition validated with `@bible-strong/avatar-core` at load; rendering via Replay SVG surface driving the core renderer (official `@bible-strong/avatar-react` 0.1.0 removed after a verified sub-pixel scale bug); stage/state reactions, inactivity sleep, click playful, reduced-motion static pose, AGPL license review in `THIRD_PARTY_NOTICES.md`.
- Verification battery (2026-10-25): `pnpm -r typecheck` 9/9 packages; agents 67/67, api 22/22, demo-shop 11/11, video 10/10; `pnpm --filter @replay/web build` passes; web Playwright 10/10 (home, run view, benchmark, upload validation, theme toggle, keyboard, 320px overflow, reduced motion, mascot routing, unknown-run error state). Screenshots: home 1440/390, run view 1440, mascot closeup.

---

## Phase G — Delivery (Steps 31–36)
Track deployment readiness, benchmark execution, hallway testing, README, demo video and submission preparation.

- [/] **Step 31 Deploy** — `PARTIAL` (prepared, not deployed)
  - Deployment stack prepared and lint/typecheck-verified: `apps/api/Dockerfile` (multi-stage, runs server or worker), `docker-compose.yml` (postgres + api + worker + caddy per plan), `Caddyfile` (sslip.io HTTPS), `packages/db/drizzle.config.ts` + first migration `migrations/0000_*.sql` (4 tables, indexes, FKs) so `db:migrate` works.
  - Local mode gap fixed: the API now runs one inline worker when no `DATABASE_URL` is set (in-memory repo), so UI-created runs execute and stream live; Postgres deployments use the standalone worker (`REPLAY_INLINE_WORKER=0` to disable).
  - Pipeline artifacts (`artifacts/`) gitignored.
  - Remaining: no Vercel/VM/Supabase credentials authorized — production deployment not performed. Exact remaining steps documented in README (Setup + compose).
- [x] **Step 32 Benchmark run** — `DONE` (real runs, honest denominators)
  - Method: `pnpm replay <sampleId>` per sample, 2026-10-25, NVIDIA Build live for Locate/Reproduce/Verify/Fix/Report; Watch fixture-assisted (dead designated watcher key + ffmpeg absent, labeled `watch_fixture_fallback`).
  - Results: 5/5 reproduced for the correct defect; Locator top-1 suspect correct on 5/5 (all hits are the actual planted code locations); **3/5 FIXED end to end** (cart-nan 44.3s, empty-email 66.0s, quantity-reset 54.4s, one fix attempt each); 2/5 REPRODUCED_ONLY (double-discount, string-sort: genuine reproduction, post-fix verification failed after 2 attempts, reported as-is).
  - Meets the plan's acceptance bar (>= 3 of 4 green on live runs). Failures kept in the table; no fixture edits to improve scores.
- [x] **Step 33 Hallway test** — `DONE` (internal usability check, not a human hallway test)
  - Scripted first-time-user walkthrough in Chromium: home comprehension, sample start, timeline follow, all four code tabs, report discovery, benchmark and how pages, queued-run honesty — 11/11 steps pass.
  - Fixes applied from the walkthrough: inline local worker (runs no longer sit QUEUED forever), honest queued-state hint in the run view.
- [x] **Step 34 README** — `DONE`
  - `README.md` rewritten: capabilities, architecture table, repo structure, prerequisites, setup with full env-var table, run instructions (dev + compose + migrations), pipeline CLI, test/eval commands, sample recording workflow, benchmark results with methodology, security boundaries, known limitations. All commands verified against actual package scripts; placeholder env values only.
- [ ] **Step 35 Demo video** — `PENDING` (deferred by owner)
  - Recording procedure ready: live web run reaches PASSING in ~50-70s via the inline worker; capture home -> sample click -> live stages -> verdict + report. Not recorded at owner's request; UI/layout changes were wanted first.
- [ ] **Step 36 Submit** — `PENDING`
  - Devpost form, public repo, submission links. Requires Steps 31 (deploy), 35 (video) and the public repo push first.

### Submission readiness checklist (evidence-based)
- [x] Working product: web UI + API + worker + CLI pipeline, real red-to-green verified
- [x] Benchmark results with methodology and honest failures
- [x] README runnable by a stranger (verified commands)
- [x] MIT LICENSE + THIRD_PARTY_NOTICES (AGPL mascot dependency documented)
- [ ] Public repo push, deployed public URL, demo video
- [ ] Watcher live-vision unblocked (new NVIDIA key + `brew install ffmpeg`)

---

# TODO — Skill Additions Log

**Policy:** every time skills are added, removed or updated from any skills folder / repo, add one row below. This file is the record the agent updates first.

| Date | Action | Source | Skills | Agents updated |
|---|---|---|---|---|
| 2026-10-25 | install | `~/.agents/skills` store (11 tracked repos) | 93 fanned out | claude, codex, commandcode, antigravity(+cli), omnirush |
| 2026-10-25 | create | `/all` umbrella skill (activates whole library, one command) | +1 | all 6 agent dirs + this project |
| 2026-10-25 | install | `ai-agent-toolkit/repositories/skills/*` (25 repos, incl. multica-ai/andrej-karpathy-skills) | +82 | all 6 agent dirs |
| 2026-10-25 | create | `/all` link for ZCode itself | +1 | ~/.zcode/skills |
| 2026-10-25 | install | `ECC/skills/*` (affaan-m/ECC repository) | +294 fanned out | all 7 agent dirs + this project |
| 2026-10-25 | update | `npx skills add -g`: vercel-labs/agent-skills (web-design-guidelines), anthropics/skills (frontend-design), leonxlnx/taste-skill (design-taste-frontend) | 3 skills updated in place, fan-out rerun | all 8 fan-out targets (CLI reported "PromptScript does not support global skill installation" for one agent target) |
| 2026-10-25 | n/a | leonxlnx/taste-skill: `stitch-design-taste` requested but not in that repo (only ships design-taste-frontend) | existing Oct 20 store copy retained | no change |
| 2026-10-25 | install | `@google/stitch` CLI v0.12.0 (npm -g): `stitch agent-skills add` (project) + `--user` + `stitch mcp install` | stitch design skill set (18 files) written to project `.agents/skills/stitch` + `~/.agents/skills/stitch`; MCP server registered in gemini-cli, antigravity, claude-desktop, claude-code, cursor + manually in ZCode `~/.zcode/cli/config.json` | all 8 fan-out targets |
| 2026-10-25 | install | Apple design skills for Phase F: emilkowalski/skills `apple-design` via npx skills -g; dickwu/apple-design-skill cloned manually (both repos ship a skill named `apple-design`) | `apple-design` = emilkowalski (fluid motion and interaction principles); `apple-design-hig` = dickwu (HIG reviewer, a11y blocking). Separate folders, both fanned out | all 8 fan-out targets |

## Store totals
- Master store: `~/.agents/skills` — 470 entries, symlinked into every agent. Add new skills HERE first, then fan out.
- Agent dirs: `~/.claude/skills`, `~/.codex/skills`, `~/.commandcode/skills`, `~/.gemini/antigravity/skills`, `~/.gemini/antigravity-cli/skills`, `~/.omnirush/agent/skills`, `~/.zcode/skills`
- Project dir: `.agents/skills/` (this project)

## Fan-out command (reuse verbatim)
```bash
for T in ~/.claude/skills ~/.codex/skills ~/.commandcode/skills ~/.gemini/antigravity/skills ~/.gemini/antigravity-cli/skills ~/.omnirush/agent/skills ~/.zcode/skills ~/Documents/Replay/.agents/skills; do mkdir -p "$T"; for d in ~/.agents/skills/*/; do n=$(basename "$d"); [ -e "$T/$n" ] || ln -s "$d" "$T/$n"; done; done
```

## Pending
- (none)
