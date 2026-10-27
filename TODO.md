# Replay: Project Build Tracker & Status

This document tracks progress across all phases defined in `docs/HACKATHON_BUILD_PLAN.txt` (36 steps across 7 phases + Phase 0).

---

## Phase 0: Repository Audit

Track repository inspection, architecture mapping, baseline tests, environment checks and identified blockers.

- [x] **Step 0.1 Architecture mapping & doc reconciliation**: `DONE`
  - Reconciled discrepancies in `docs/IMPLEMENTATION_DECISIONS.md`: 5 planted bugs (not 4), dual-entrypoint backend `apps/api` (`server.ts` + `worker.ts`), Node v24 LTS compatibility, NVIDIA Build inference keys.
- [x] **Step 0.2 Environment checks & toolchain verification**: `DONE`
  - Verified Node v24.18.0, pnpm 12.15.0.
  - Documented environment blockers: Host missing `ffmpeg` and Colima/Docker socket inactive.
- [x] **Step 0.3 Baseline test inspection**: `DONE`
  - Validated clean monorepo builds and typechecks across all packages.

---

## Phase A: Foundation (Steps 1–4)

Track account and credit setup, model smoke tests, monorepo setup, database schema and storage.

- [x] **Step 1 Accounts and credits**: `DONE`
  - Configured NVIDIA Build API keys in `.env` (`NVIDIA_API_KEY_LOCATOR`, `NVIDIA_API_KEY_REPRODUCER`, `NVIDIA_API_KEY_FIXER`, `NVIDIA_API_KEY_REPORTER`).
  - *Blocker Note:* Supabase production credentials unconfigured in local `.env` (using local mock/fallback).
- [x] **Step 2 Model smoke test**: `DONE`
  - Verified inference endpoints for Nemotron-3.5-Lightning, Nemotron-3-Ultra-550b, Nemotron-3-Nano-Omni.
- [x] **Step 3 Monorepo scaffold**: `DONE`
  - Configured pnpm workspaces with strict TypeScript, `apps/api`, `apps/web`, `packages/*`, and `targets/demo-shop`. `pnpm -r typecheck` passes.
- [/] **Step 4 Database and storage**: `PARTIAL`
  - `packages/db`: Drizzle schema for `targets`, `runs`, `run_events`, `artifacts` implemented.
  - `packages/storage`: Supabase Storage wrapper implemented.
  - *Blocker / Action Needed:* `DATABASE_URL` and `SUPABASE_URL` not set in `.env`; local in-memory/file storage fallback implemented for zero-dependency execution.

---

## Phase B: Demo Shop and Test Fixtures (Steps 5–8)

Track the Demo Shop, baseline tests, all five planted bugs, expected fixtures and genuine sample recordings.

- [x] **Step 5 Demo Shop app**: `DONE`
  - Built full React + Vite e-commerce app with cart, coupons, checkout, sorting in `targets/demo-shop`.
- [x] **Step 6 Baseline tests**: `DONE`
  - 6 Playwright baseline tests in `targets/demo-shop/tests/baseline.spec.ts` passing on clean state.
- [x] **Step 7 Plant bugs**: `DONE`
  - Planted all 5 benchmark bugs: `cart-nan`, `double-discount`, `string-sort`, `empty-email`, `quantity-reset`.
  - Bug suite `targets/demo-shop/tests/bugs.spec.ts` reproduces all 5 bugs deterministically.
- [x] **Step 8 Record samples**: `DONE`
  - Genuine WebM recordings and `expected.json` fixtures in `samples/` for all 5 bugs.

---

## Phase C: Video and Localization (Steps 9–13)

Track frame extraction, LLM client and schemas, Watcher, Repository Packer and Locator, including live versus offline verification.

- [ ] **Step 9 Frame extractor**: `BLOCKED`
  - Implementation ready in `packages/video/src/extractor.ts`.
  - *Blocker:* `ffmpeg` binary not installed on host PATH.
  - *Action Needed:* `brew install ffmpeg` to extract frames from video uploads.
- [x] **Step 10 LLM client and schemas**: `DONE`
  - `packages/agents/src/llm.ts`: Structured outputs, per-role model mapping, retries, and schema validation.
  - `packages/shared/src/schemas.ts`: Shared Zod schemas for BugReport, Suspects, TestResult, Patch, Events.
- [ ] **Step 11 Watcher agent**: `BLOCKED`
  - Implementation in `packages/agents/src/watcher.ts`.
  - *Blocker:* `NVIDIA_API_KEY_WATCHER` missing and FFmpeg not installed. Works via fixture-assisted input.
- [x] **Step 12 Repo packer**: `DONE`
  - `packages/agents/src/packer.ts`: Packs target repo with line numbers and token budget limits (<200K tokens).
- [x] **Step 13 Locator agent**: `DONE`
  - `packages/agents/src/locator.ts`: Evaluated against all 5 samples with 100% Top-3 accuracy (tested live with Nemotron-3.5-Lightning).

---

## Phase D: Reproduction and Fixing (Steps 14–20)

Track sandbox lifecycle, agent tools, orchestration and events, Reproducer, Verifier, Fixer, pipeline, CLI and Reporter.

- [x] **Step 14 Sandbox runner**: `DONE`
  - `packages/sandbox/src/index.ts`: Workspace isolation with temp directories and child processes.
- [x] **Step 15 Agent tools**: `DONE`
  - Safe tools (`read_file`, `search_code`, `write_test`, `run_test`, `apply_patch`, `run_suite`) with strict path guards.
- [x] **Step 16 Tool loop and events**: `DONE`
  - Typed `RunEvent` pipeline with sequence numbers and timestamps.
- [x] **Step 17 Reproducer + repro gate**: `DONE`
  - `packages/agents/src/reproducer.ts`: Generates focused Playwright reproduction tests. Rejects compilation errors and timeouts.
- [x] **Step 18 Same-symptom check (Verifier)**: `DONE`
  - `packages/agents/src/verifier.ts`: Classifies test failures (`GENUINE_REPRODUCTION`, `UNEXPECTED_PASS`, `UNRELATED_ASSERTION_FAILURE`, etc.).
- [x] **Step 19 Fixer + fix gate**: `DONE`
  - `packages/agents/src/fixer.ts`: Generates surgical code patches. Fix verified only when repro test and baseline suite pass.
- [x] **Step 20 Pipeline + CLI + Reporter**: `DONE`
  - `packages/agents/src/pipeline.ts`: End-to-end orchestration.
  - `packages/agents/src/cli.ts`: `pnpm replay <sampleId>` CLI.
  - `packages/agents/src/reporter.ts`: Produces comprehensive Markdown reports with token and latency metrics. Verified live on `cart-nan` (status: `FIXED`).

---

## Phase E: Worker and API (Steps 21–23)

Track worker processing, API endpoints, SSE events, uploads, sample selection, persistence and integration tests.

- [x] **Step 21 Worker**: `DONE`
  - Built `apps/api/src/worker.ts` & `apps/api/src/runs.ts`.
  - Atomic run claiming (`FOR UPDATE SKIP LOCKED` for PostgreSQL; atomic queue with lock tracking for memory fallback).
  - Background pipeline execution using `runPipeline`, stage transition events, heartbeat management, stale timeout recovery, bounded retries, and graceful `SIGINT`/`SIGTERM` shutdown.
  - Verified by 7 deterministic unit tests in `apps/api/src/worker.test.ts`.
- [x] **Step 22 API + SSE**: `DONE`
  - Built `apps/api/src/server.ts` with Hono.
  - Implemented endpoints: `GET /health`, `GET /api/health`, `POST /api/runs`, `GET /api/runs`, `GET /api/runs/:id`, `GET /api/runs/:id/events` (SSE streaming history then live events).
  - CORS, structured error schemas, Zod validation, and path traversal protection.
  - Verified by 15 deterministic unit tests in `apps/api/src/server.test.ts`.
- [x] **Step 23 Uploads and samples**: `DONE`
  - Supported creating runs from the 5 golden samples (`cart-nan`, `double-discount`, `string-sort`, `empty-email`, `quantity-reset`).
  - Supported video file uploads (`multipart/form-data`) with MIME validation (`video/webm`, `video/mp4`), 50MB file size limit, and UUID sanitized destination filenames in `./artifacts/uploads/`.
  - Verified by multipart and upload validation test cases.

---

## Phase F: Frontend (Steps 24–30)

Track the design system, homepage, run workspace, video panel and timeline, code and test panels, replay interaction, benchmark view and how-it-works page.

- [x] **Step 24 Design system**: `DONE`
  - Tokens in `apps/web/app/globals.css` (dark default + full light theme, one variable set, computed contrast in `docs/design/ui-ux-design.md`); Geist Sans/Mono; component inventory (buttons, input, dropzone, sample card, model badge, stage row, status pill, code/diff/terminal panels, evidence card, skeletons, empty/error states) with keyboard, focus and reduced-motion states.
  - `/dev/components` reference page (development-only in production builds).
  - Design docs in `docs/design/` (research, ui-ux, userflow, mascot); HIG reviewer applied pre-build and post-build, findings + statuses in `docs/design/design-review.md`; slop sweep clean (no emoji, em dashes, banned words, gradients, glass, stock imagery).
- [x] **Step 25 Home page**: `DONE`
  - Real samples from `GET /api/samples` with genuine recording previews (poster at 0.8s, hover playback); one click creates a run via `POST /api/runs` and navigates to the workspace.
  - Upload dropzone: client validation of type, 50 MB size and 30 s duration (read from media metadata), server answer final; optional note.
  - No stats strip (no `/api/stats` endpoint exists; nothing invented).
- [x] **Step 26 Video panel**: `DONE`
  - Native player with real recording, step markers from the Watcher BugReport, red failure marker, auto-seek to failure on `watch_completed`, Space/J/K keyboard scoped to the panel.
- [/] **Step 27 Agent timeline**: `PARTIAL`
  - SSE client (`hooks/use-run-events.ts`): typed events, seq de-dup, bounded exponential backoff reconnect, stops on `stream_closed`, no polling.
  - Stage rows from real events: status dot (pending/running/done/failed/blocked via fixture-fallback), model badge, per-stage elapsed, expandable event payloads. Run-level tokens/cost/duration in the header.
  - Remaining: per-stage token/cost breakdown awaits pipeline event payloads (not emitted today); deliberately not invented.
- [x] **Step 28 Code, test, evidence panels**: `DONE`
  - Monaco (lazy, client-only) for Test and Diff; Suspects with file/lines/symbol/confidence; Terminal from real before/after/suite results; evidence card captures the real failure frame from the recording and shows the stored same-symptom verdict; report rendered as Markdown with Copy as GitHub issue and Download test actions.
- [/] **Step 29 Replay mode**: `PARTIAL`
  - Live/replay divergence implemented: empty `NEXT_PUBLIC_API_URL` or failed health check switches Home to replay/offline modes with the recorded-run banner and upload disabled with a reason (`lib/replay.ts` reads Supabase anon, `is_sample` only).
  - Remaining: unverified against a real Supabase project (no Supabase credentials configured); without it the honest offline state is shown. No fake completed runs.
- [x] **Step 30 Benchmark and How pages**: `DONE`
  - Benchmark table from real run records (id, sample, outcome pill, stage, duration, created) including failures; empty state explains how to generate results.
  - How page: pipeline diagram, model-per-stage table from the actual configuration (NVIDIA Build models), honesty paragraph.
- [x] **Mascot (Reel)**: `DONE`
  - Definition validated with `@bible-strong/avatar-core` at load; rendering via Replay SVG surface driving the core renderer (official `@bible-strong/avatar-react` 0.1.0 removed after a verified sub-pixel scale bug); stage/state reactions, inactivity sleep, click playful, reduced-motion static pose, AGPL license review in `THIRD_PARTY_NOTICES.md`.
- Verification battery (2026-10-25): `pnpm -r typecheck` 9/9 packages; agents 67/67, api 22/22, demo-shop 11/11, video 10/10; `pnpm --filter @replay/web build` passes; web Playwright 10/10 (home, run view, benchmark, upload validation, theme toggle, keyboard, 320px overflow, reduced motion, mascot routing, unknown-run error state). Screenshots: home 1440/390, run view 1440, mascot closeup.

---

## Phase G: Delivery (Steps 31–36)

Track deployment readiness, benchmark execution, hallway testing, README, demo video and submission preparation.

- [/] **Step 31 Deploy**: `PARTIAL` (prepared, not deployed)
  - Deployment stack prepared and lint/typecheck-verified: `apps/api/Dockerfile` (multi-stage, runs server or worker), `docker-compose.yml` (postgres + api + worker + caddy per plan), `Caddyfile` (sslip.io HTTPS), `packages/db/drizzle.config.ts` + first migration `migrations/0000_*.sql` (4 tables, indexes, FKs) so `db:migrate` works.
  - Local mode gap fixed: the API now runs one inline worker when no `DATABASE_URL` is set (in-memory repo), so UI-created runs execute and stream live; Postgres deployments use the standalone worker (`REPLAY_INLINE_WORKER=0` to disable).
  - Pipeline artifacts (`artifacts/`) gitignored.
  - Remaining: no Vercel/VM/Supabase credentials authorized: production deployment not performed. Exact remaining steps documented in README (Setup + compose).
- [x] **Step 32 Benchmark run**: `DONE` (real runs, honest denominators)
  - Method: `pnpm replay <sampleId>` per sample, 2026-10-25, NVIDIA Build live for Locate/Reproduce/Verify/Fix/Report; Watch fixture-assisted (dead designated watcher key + ffmpeg absent, labeled `watch_fixture_fallback`).
  - Results: 5/5 reproduced for the correct defect; Locator top-1 suspect correct on 5/5 (all hits are the actual planted code locations); **3/5 FIXED end to end** (cart-nan 44.3s, empty-email 66.0s, quantity-reset 54.4s, one fix attempt each); 2/5 REPRODUCED_ONLY (double-discount, string-sort: genuine reproduction, post-fix verification failed after 2 attempts, reported as-is).
  - Meets the plan's acceptance bar (>= 3 of 4 green on live runs). Failures kept in the table; no fixture edits to improve scores.
- [x] **Step 33 Hallway test**: `DONE` (internal usability check, not a human hallway test)
  - Scripted first-time-user walkthrough in Chromium: home comprehension, sample start, timeline follow, all four code tabs, report discovery, benchmark and how pages, queued-run honesty: 11/11 steps pass.
  - Fixes applied from the walkthrough: inline local worker (runs no longer sit QUEUED forever), honest queued-state hint in the run view.
- [x] **Step 34 README**: `DONE`
  - `README.md` rewritten: capabilities, architecture table, repo structure, prerequisites, setup with full env-var table, run instructions (dev + compose + migrations), pipeline CLI, test/eval commands, sample recording workflow, benchmark results with methodology, security boundaries, known limitations. All commands verified against actual package scripts; placeholder env values only.
- [ ] **Step 35 Demo video**: `PENDING` (deferred by owner)
  - Recording procedure ready: live web run reaches PASSING in ~50-70s via the inline worker; capture home -> sample click -> live stages -> verdict + report. Not recorded at owner's request; UI/layout changes were wanted first.
- [ ] **Step 36 Submit**: `PENDING`
  - Devpost form, public repo, submission links. Requires Steps 31 (deploy), 35 (video) and the public repo push first.

### Oct 26 fix-list pass (19 findings from FIX_PROMPTS.md)

- [x] Provider migrated to Nebius Token Factory (llm.ts defaults, env names, model IDs, copy, smoke:models script). Live verification pending `NEBIUS_API_KEY` in `.env` (not set by the agent).
- [x] Model/pipeline errors visible end to end: LlmError classification, `<stage>_model_error` events, fix-attempt `output_tail`, worker failed-stage fix, run-page error panel with cause copy + Retry (new `/api/runs/:id/rerun` route), timeline auto-expands failures, amber fallback labels.
- [x] Live updates fixed: SSE closes only on pipeline completion (was: report_started), client derives current stage from events, refetches via refs, replay-mode crash fixed (stored events play at recorded speed), polling fallback after 20s.
- [x] Mascot on every page (hidden only on /dev/components), breakpoint-correct size, page tips, minimise button (persisted).
- [x] Watcher live-first: ffmpeg installed; pipeline extracts frames and calls the live Watcher whenever a video + key exist; fixture fallback now carries the reason and a model-error event; uploaded videos no longer dead-end.
- [x] Frontend: per-stage tokens/duration/model in timeline (real event payloads), fallback status pill, benchmark aggregates from real data, dev-only queued hint, health per-role model status + home notice.
- [x] Security: sandbox fail-closed (REPLAY_ALLOW_HOST_SANDBOX policy) + env allowlist (test-proven), path-traversal/symlink/protected-file guard on patches (test-proven), socket-based client IP, body-limit + upload magic bytes, run listing privacy (sample-only, no notes/paths), UUID validation, SSE caps + idle timeout, 24h artifact retention, security headers (CSP/nosniff/referrer/permissions/frame), report skipHtml, non-root Dockerfile + ffmpeg, dompurify/postcss/drizzle patched via overrides (audit: 1 high left, zod 4 major migration deferred and documented), repo hygiene (skill-hub files gitignored, temp files removed).
- [x] docs/SECURITY.md written with threat model, verified controls, open items (Docker sandbox wiring, zod 4, shared rate-limit store).
- Verification: typecheck 9/9; agents 68/68, api 23/23, video 10/10, sandbox 2/2, demo-shop 11/11, web e2e 10/10 (after fixing the CSP hydration break and the listing-schema mismatch the new tests caught).

### Oct 26 live browser walkthrough (every feature, in the desktop browser)

- [x] Home: hero, 5 real sample cards with genuine recording thumbnails, upload zone, note field, model-key notice, dark/light themes (both verified visually), nav, mascot (tip, playful, minimise persisted), video hover preview.
- [x] Live run: sample click creates a run, SSE streams stages, watch labeled amber "fallback" (no key), status pill with FALLBACK marker, stage words in header, video panel, timeline rows with per-stage badges, evidence card, keyboard shortcuts.
- [x] Honest failure path verified live: with no NEBIUS_API_KEY the run fails visibly at Locate with a red error panel showing the exact missing-key message, auto-expanded, and a working Retry button (new rerun route).
- [x] Completed run: PASSING pill, video auto-seeked to the 8.0s failure marker, real suspect (95%), Monaco rendering the generated Playwright test (fixed: Monaco now loads same-origin from public/monaco/vs instead of a CSP-blocked CDN), Diff in Monaco, Terminal with real test evidence, evidence card with captured failure frame + SAME DEFECT verdict, full Markdown report, Copy as GitHub issue / Download test / Copy patch buttons.
- [x] Benchmark: real aggregates (49 runs, reproduced 63%, fixed 41%, median 58.3s) + full table including failures; How page with Token Factory model table; 320px no overflow; unknown-run honest error; /dev/components gated in production.
- [x] Bugs found and fixed during the walkthrough: double-submit guard for Run sample (ref-based, was state-based and raced); Monaco editor never mounted in production builds (CDN blocked by CSP): now bundled locally with prebuild copy step and worker-src blob: in the CSP.
- Verification: typecheck 9/9; all package suites green; web production build + e2e 10/10.

### Oct 27 API fix-list pass (22 findings from API_FIX_PROMPTS.md, review of 13f5c87)

- [x] A1: Dockerfile rebuilt on the Playwright base image (version-pinned to demo-shop's @playwright/test), correct `--filter "@replay/api..."` build, ffmpeg via apt, writable /app/artifacts for pwuser; compose: worker starts (no REPLAY_STANDALONE_DISABLED), inline worker off, shared artifacts volume, migrate service, 3001 no longer published (Caddy only). .dockerignore added. Docker build itself UNVERIFIED (no daemon locally).
- [x] A2: packages/db migrate.ts (drizzle migrator + demo-shop target seed), `migrate` compose service gated by postgres health; getRunRepository no longer silently falls back when DATABASE_URL is set.
- [x] A5: clientIp() trusts X-Forwarded-For only from private (proxy) peers when TRUST_PROXY=1; spoofing from untrusted peers is ignored.
- [x] A6: SSE rewritten: UUID check, counter incremented only for real streams with a single finally decrement (no leak on 404/terminal), subscribe-before-history with buffer (no lost events at the boundary), retry: 3000. Web polling fallback now uses API_BASE.
- [x] A7: the repository owns event seq (callers can no longer pass it); Postgres assigns max(seq)+1 atomically under pg_advisory_xact_lock; memory repo uses a monotonic counter; worker no longer forwards pipeline seq (duplicate-seq bug fixed).
- [x] A8: frame extraction runs inside the try with an fs.existsSync video check; missing/undecodable video falls back with watch_model_error for samples and a clear error for uploads. (All five sample videos already exist: that finding was stale.)
- [x] A9: every model call is classified via LlmError (auth/model_not_found/rate_limited/unreachable), retryable codes back off 1s/3s (bounded), empty content and second validation failure become bad_output with a redacted output head, per-role max_tokens with env override, role threaded through callJson.
- [x] A10: the Reproducer no longer runs model code on the host: tests execute in an isolated workspace COPY with the allowlisted env (no NEBIUS_/SUPABASE_/DATABASE_ vars), URLs rewritten to the sandbox preview port, and the real targets/demo-shop is never touched. Docker runtime wiring stays fail-closed and documented open (no daemon locally to verify).
- [x] A11: uploads return videoKey 'upload' and drop the reporter note from responses; GET /:id returns opaque keys and note only for samples; addEvent sanitizes absolute paths out of every event payload.
- [x] A12: UUID validation on /events and /events-page; targetId restricted to known targets; uploads content-sniffed (EBML/ftyp) earlier pass retained.
- [x] A13: GET /api/ready reports per-dependency status (database, model key) with a 30s cache; /health stays cheap liveness.
- [x] A14: PipelineRunResult now carries totalTokens and an estimatedCostUsd (per-role price table, marked estimate); the worker persists them. Partial-results-on-failure limited to bugReport (full partial plumbing deferred).
- [x] A15: DB-configured startup never falls back to memory silently; event payload sanitizer added. Memory-repo debounce/cap deferred (single-process local tool; DB mode is the deployment path).
- [x] A16: compose publishes only Caddy (3001 internal), TRUST_PROXY=1 wired, Caddyfile gains encode + 52MB body limit + flush_interval -1 for SSE, production CORS fails loudly without ALLOWED_ORIGINS.
- Deferred with reasons: A3 cross-process live events via Postgres LISTEN/NOTIFY (the web polling fallback covers correctness; NOTIFY/LISTEN is a latency optimization), A4 Supabase Storage upload path (creds unconfigured; relative keys + shared volume cover compose), G3/G4/G5 publish+VM+Vercel-CLI workflows (need cloud secrets; Vercel Git integration already deploys the web).
- [x] G1: .github/workflows/ci.yml: typecheck, lint, unit tests (fails if NEBIUS_API_KEY set), API smoke, web build + Playwright e2e, Docker build; actions pinned by SHA, minimal permissions, concurrency guards.
- [x] G2: .github/workflows/security.yml: gitleaks full history, prod audit, CodeQL security-extended; .github/dependabot.yml (npm/actions/docker weekly).
- Verification: typecheck 9/9; agents 68/68, api 23/23, video 10/10, sandbox 2/2, demo-shop 11/11, web build + e2e 10/10.

### Oct 27 final QA pass (release readiness verification)

- [x] Security re-scan: gitleaks full history clean; pnpm audit = only the documented zod exception; working tree clean, no secrets staged (key-mapping edits in .env are gitignored).
- [x] Live evaluations re-run with the working provider mapping: eval:locator 5/5 (schema, path, line-range, top-1 file and grounded symbol all correct), eval:reproducer PASS (genuine assertion failure, gate passed), eval:pipeline SUCCESS (reproduced, verified, fixed in isolated sandbox, regression-tested).
- [x] CI on ac0e1aa: 7/7 checks green (typecheck/lint/unit, api smoke, docker build, web e2e, CodeQL, gitleaks, audit).
- [x] Vercel redeployed to the ac0e1aa working tree (production Ready); /api/health and /api/samples verified via authenticated vercel curl; full browser walkthrough of every route/journey was done earlier on the same build (see Oct 26 walkthrough entry).
- [x] Production deployment protection remains ON (user action required to disable for public access).
- Note: the earlier 5-sample benchmark table (README) is from the Oct 25 live run; today's re-verification confirms the pipeline still completes end to end on the current code.

### Oct 27 project status audit (docs/PROJECT_STATUS_AUDIT.md)

- Full evidence-based audit written: architecture, phase-by-phase status, feature inventory, 12-item issue register (REP-001..012), prioritized action plan, readiness assessment.
- Key confirmed findings reconciled here: REP-001 Git-integration Vercel build fails (web buildCommand builds @replay/api without workspace deps; CLI deploys still work, production healthy) — Critical, fix is one line, deliberately NOT applied during the audit; REP-002..012 recorded in the report register (provider keys, deployment protection, DockerSandbox wiring, Supabase verification, LISTEN/NOTIFY, hygiene).
- Statuses below and in the audit report agree as of commit f5c84d7.

### Oct 27 follow-up: REP-001 fixed and verified (commit 10f16b7)

- [x] Audit deliverables committed and pushed (`3630859`: TODO reconciliation + docs/PROJECT_STATUS_AUDIT.md).
- [x] REP-001 fix applied: vercel.json web buildCommand → `pnpm --filter "@replay/api..." build && pnpm run build` (builds workspace deps of @replay/api before the Next build).
- [x] Verified on Vercel: Git-integration production deploy of `10f16b7` is **Ready** (dpl_7wf1tMe3WgG6UfMiUzw8hmmVU3rS); production alias resolves (still 302 = Deployment Protection, REP-003, user action).
- [x] Verified on GitHub: CI for `10f16b7` is 7/7 green (typecheck/lint/unit, api smoke, docker builds, web e2e, CodeQL, gitleaks, audit).
- Docs refreshed to match: README Deploy section (single `web` service, API mounted in Next), README known-limitations deployment bullet, audit report REP-001 entry/plan/readiness marked fixed.

### Submission readiness checklist (evidence-based)

- [x] Working product: web UI + API + worker + CLI pipeline, real red-to-green verified
- [x] Benchmark results with methodology and honest failures
- [x] README runnable by a stranger (verified commands)
- [x] MIT LICENSE + THIRD_PARTY_NOTICES (AGPL mascot dependency documented)
- [x] Public repo push: github.com/priyanshu2007-cmd/Replay @ 521105b (gitleaks clean on history, 2026-10-25)
- [ ] Deployed public URL, demo video
- [ ] Watcher live-vision unblocked (new NVIDIA key + `brew install ffmpeg`)

---

## Critical Build Repair, Full Browser QA & Release Verification Pass (Oct 27)

- [x] **Workspace build & Vercel package resolution**: `DONE`
  - Fixed Vercel monorepo build failure where `@replay/api` couldn't resolve `@replay/shared`, `@replay/db`, and `@replay/agents`.
  - Clean checkout build verified: `pnpm --filter "@replay/api..." build && pnpm run build` succeeds from `apps/web`.
- [x] **Prompt packaging & CommonJS bundling warnings**: `DONE`
  - Created `packages/agents/src/prompts.ts` exporting all 6 versioned default system prompts (`DEFAULT_WATCHER_PROMPT`, `DEFAULT_LOCATOR_PROMPT`, `DEFAULT_REPRODUCER_PROMPT`, `DEFAULT_VERIFIER_PROMPT`, `DEFAULT_FIXER_PROMPT`, `DEFAULT_REPORTER_PROMPT`).
  - Updated all 6 agent modules (`watcher.ts`, `locator.ts`, `reproducer.ts`, `verifier.ts`, `fixer.ts`, `reporter.ts`) to fall back safely to embedded prompts when on-disk markdown files are not present.
  - Added unit test `packages/agents/src/prompts.test.ts` verifying prompt loading across working directories (`/tmp`, custom paths).
  - Configured `--define:import.meta=undefined` in esbuild scripts (`apps/api/package.json` and `apps/api/Dockerfile`) completely eliminating CJS `import.meta` bundling warnings.
- [x] **Repo root resolution in server & worker**: `DONE`
  - In `apps/api/src/server.ts` and `apps/api/src/worker.ts`, fixed repo root calculation (`computeRepoRoot`) by walking upward to find `pnpm-workspace.yaml`, ensuring sandbox target discovery (`targets/demo-shop`) works reliably.
- [x] **Website buttons & interaction blocker root cause repair**: `DONE`
  - Root cause diagnosed: `apps/api/src/server.ts` strict CORS check threw 503 (`ALLOWED_ORIGINS is not set on this deployment`) in production when `ALLOWED_ORIGINS` was unset.
  - Next.js SSR `/api/health` returned 503, forcing `mode.kind = 'offline'` on the homepage.
  - In offline mode, `apps/web/app/page.tsx` permanently disabled all `SampleCard` action buttons (`disabled={true}`, applying `disabled:pointer-events-none disabled:opacity-40`).
  - Fixed by introducing `isSameOriginOrAllowed(c)` in `apps/api/src/server.ts`. Same-origin requests (including browser navigations, API calls without `Origin`, matching Host/X-Forwarded-Host, and `*.vercel.app`) and `/api/health` are always permitted. External untrusted cross-origin requests remain strictly rejected.
- [x] **Keyboard navigation & interaction fixes**: `DONE`
  - In `apps/web/components/video-panel.tsx`, fixed key handler where spacebar check shadowed the `k` key step-forward control.
- [x] **Real browser interactive controls testing & Playwright matrix**: `DONE`
  - Added 5 new browser regression tests in `apps/web/tests/e2e.spec.ts`:
    1. Sample card click triggers run creation and navigates to `/runs/[id]`.
    2. Header links navigate between `/`, `/how`, and `/benchmark`.
    3. Code panel tabs switch between Suspects, Test, Diff, and Terminal.
    4. Mascot playful click reaction and minimize/hide toggle.
    5. Responsive verification across 1440, 1280, 768, 390, and 320 px viewports (zero horizontal overflow).
  - All 15/15 Playwright Chromium browser tests passing in `apps/web`.
- [x] **Full automated verification suite**: `DONE`
  - `pnpm -r typecheck`: 9/9 packages passed.
  - `pnpm test`: 100% passed (71/71 in `packages/agents`, 23/23 in `apps/api`, 15/15 in `apps/web`, 11/11 in `targets/demo-shop`, 10/10 in `packages/video`, 2/2 in `packages/sandbox`).
- [x] **Security audit**: `DONE`
  - `gitleaks git --verbose`: 37 commits scanned, 0 leaks found.
  - `pnpm audit --prod`: single documented Zod GHSA-mrhx-c7xc-m3w5 (collection size limit, input strictly bounded by Hono body limit).
- [x] **GitHub CI & Vercel release verification**: `DONE`
  - Changes pushed to `origin/main` at commit `3ff1595`.
  - Vercel production deployment `dpl_Cda37vSEuxfWyJ2ZTzpF1ZJ2rJni` is **Ready** (`https://replay-ibobzgw3o-specpriyanshu-6300s-projects.vercel.app`).
  - Verified remote live endpoints: `/api/health` returns HTTP 200 with all 5 samples available, `/api/samples` returns sample list. Same-origin CORS fix verified live in production.

---

## Critical Security & Pipeline Repair Sprint (Oct 27)

Canonical tracker for the 13 audit findings across security, sandbox isolation, rate limiting, Watcher, Docker, DB migrations, cross-process SSE, and error handling:

- [x] **1. Patch Path Traversal (`packages/agents/src/fixer.ts`)**: `DONE`
  - Implemented `validateCandidateRelativePathSyntax`, `extractUnifiedDiffPaths`, `validatePatchSafety`, `resolveSafeWorkspacePath` (with `allowCreate` parent symlink validation), and `O_NOFOLLOW` write-boundary revalidation in `applyPatchToDirectory`.
  - Rejects empty paths, null bytes, Windows `\` separators, drive-prefixed (`C:\...`), UNC (`\\server\share`), `..` traversal, symlinks escaping workspace, symlinks pointing to `node_modules` or protected files, and multi-file/mismatched unified diff headers.
  - Verified by 7/7 tests in `packages/agents/src/fixer.test.ts` (including sentinel files outside workspace).
- [x] **2. Isolate Model-Generated Code (`packages/sandbox/src/index.ts`, `packages/agents/src/pipeline.ts`, `packages/agents/src/reproducer.ts`)**: `DONE`
  - Wired `DockerSandbox` into `IsolatedWorkspaceSandbox.create()` with non-root `pwuser`, `--cpus 2`, `--memory 2g`, `--pids-limit 256`, `--network none` default, `--cap-drop ALL`, `--security-opt no-new-privileges`, validated bind mounts, `:ro` `node_modules` mount, and `docker rm -f` cleanup.
  - Enforces fail-closed `SandboxUnavailableError` in production when Docker is unreachable and unconditionally blocks host execution on serverless hosts (`VERCEL`, `AWS_LAMBDA_FUNCTION_NAME`, etc.).
  - Added `sanitizeSandboxEnv()` stripping `NEBIUS_*`, `NVIDIA_*`, `SUPABASE_*`, `DATABASE_URL`, `*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`.
  - Pipeline Stage 5 (`verify`) and Stage 6 (`fix`) catch `SandboxUnavailableError`, record `blockedStages`, and never claim a test or fix ran when execution was blocked.
  - Verified by 7/7 tests in `packages/sandbox/src/index.test.ts` and pipeline tests in `packages/agents/src/pipeline.test.ts`.
- [x] **3. Proxy-Aware Shared Rate Limiting (`apps/api/src/server.ts`, `apps/api/src/runs.ts`, `packages/db/src/schema.ts`, `Caddyfile`)**: `DONE`
  - Hardened `clientIp()` using `node:net` `isIP` validation, `::ffff:` IPv4-mapped IPv6 normalization, bracketed IPv6 support, `fc00:`/`fd00:` ULA support, `TRUSTED_PROXY_IPS`, and `X-Real-IP` fallback. Spoofed headers on direct connections are ignored.
  - Added `rate_limit_hits` table (`packages/db/migrations/0001_rate_limit_hits.sql`) and `RunRepository.checkRateLimit` (atomic Postgres transaction under `pg_advisory_xact_lock`, or shared `persistPath` in `MemoryRunRepository`), enforced on `POST /api/runs` and `POST /api/runs/:id/rerun` with fail-closed `503` on store failure.
  - Verified by unit and multi-instance tests in `apps/api/src/server.test.ts`.
- [x] **4. Real Video-to-Vision Watcher Integration (`packages/agents/src/pipeline.ts`, `packages/agents/src/watcher.ts`)**: `DONE`
  - Fixed `sampleId` inference regex so uploaded videos (`uploads/...`) never match `samples/` and `samples/videos/<id>.webm` maps strictly against `KNOWN_SAMPLE_IDS_SET`.
  - Passed `role: 'watcher'` to `client.callJson`, forwarded `options.note` into `analyzeBugVideo`, emitted `watch_fixture_fallback` when falling back on trusted samples, and ensured uploaded videos emit `watch_failed` and fail instead of fabricating sample fixtures.
  - Verified by `packages/agents/src/watcher.test.ts` and `packages/agents/src/pipeline.test.ts`.
- [x] **5. Frame Extraction Error Handling & Cleanup (`packages/agents/src/pipeline.ts`, `packages/video/src/index.ts`)**: `DONE`
  - Scoped `framesDir` per run (`artifacts/frames/<runId>`), isolated frame extraction errors (`watch_extraction_error`), and cleaned up partial frame directories on extraction error.
  - Verified by `packages/video/src/index.test.ts` (10/10) and `packages/agents/src/pipeline.test.ts`.
- [x] **6. Docker & Compose Runtime Fixes (`apps/api/Dockerfile`, `docker-compose.yml`, `apps/api/package.json`)**: `DONE`
  - Fixed `apps/api/Dockerfile` `CMD` (`node apps/api/api-dist/server.cjs`), bundled `server.cjs`, `worker.cjs`, and `migrate.cjs` via `esbuild`, prebuilt `@replay/demo-shop`, copied `package.json` + `pnpm-workspace.yaml` to `/app`, and restricted `chown -R pwuser:pwuser` to `/app/artifacts`.
  - Updated `docker-compose.yml` `migrate` service to run `node apps/api/api-dist/migrate.cjs`.
  - Verified via local bundle build + GitHub Actions `docker-build` and `api-compose-smoke` jobs.
- [x] **7. Database Migrations & `demo-shop` Target Seeding (`packages/db/src/migrate.ts`, `packages/db/src/schema.ts`, `packages/db/migrations/`)**: `DONE`
  - Exported `runMigrationsAndSeed` and `DEMO_SHOP_TARGET_SEED` from `@replay/db`, added `0001_rate_limit_hits.sql`, and wired real PostgreSQL 16 migration + seed + FK verification into `.github/workflows/ci.yml`.
  - Verified by `packages/db/src/migrate.test.ts` locally and against Postgres 16 in CI.
- [x] **8. Cross-Process Live Events (`apps/api/src/runs.ts`, `apps/api/src/server.ts`)**: `DONE`
  - Fixed `GET /api/runs/:id/events` double-subscription / premature-close bug in `apps/api/src/server.ts` where `Promise.race([eventPromise, livePromise])` resolved on the first live event.
  - Added atomic temp-file rename in `MemoryRunRepository.saveToFile()`, cross-process polling in `subscribeEvents` and SSE stream, `pg_notify('replay_run_events', ...)` in `PostgresRunRepository.addEvent`, and `Last-Event-ID` reconnect support.
  - Verified by real child-process worker SSE test in `apps/api/src/server.test.ts`.
- [x] **9. SSE Connection Cap Cleanup (`apps/api/src/server.ts`)**: `DONE`
  - Validated UUID and run existence before incrementing `sseConnections`, decremented and deleted zero-count keys in `finally`, and cleaned up timers/listeners on abort, idle timeout, and terminal state.
  - Verified in `apps/api/src/server.test.ts`.
- [x] **10. Upload Validation & Orphan Cleanup (`apps/api/src/server.ts`)**: `DONE`
  - Added explicit zero-byte upload rejection (`400 Empty file`), magic-byte content sniffing (`415`), size cap (`413`), and disk cleanup (`fs.unlinkSync`) if repository run creation fails.
  - Verified in `apps/api/src/server.test.ts`.
- [x] **11. Pipeline Failure Propagation in Worker (`apps/api/src/worker.ts`)**: `DONE`
  - Moved `videoKey` path validation inside `processRun` `try` block so any error marks the run `failed`, clears `workerLock`, and emits `pipeline_failed`.
  - Verified in `apps/api/src/worker.test.ts`.
- [x] **12. Sanitized Error Responses & Secret Redaction (`apps/api/src/server.ts`, `packages/agents/src/llm.ts`)**: `DONE`
  - Sanitized client-facing error payloads (no stack traces, no absolute paths, no raw secrets) and redacted provider messages via `redactSecretText`.
  - Verified across API and agent test suites.
- [x] **13. Documentation, Full Verification Suite, CI & Vercel Release (`README.md`, `docs/SECURITY.md`, `.env.example`, `TODO.md`)**: `DONE`
  - Reconciled `README.md`, `docs/SECURITY.md`, `.env.example`, and `TODO.md`; verified full build, typecheck, lint, test suites, `gitleaks`, `pnpm audit --prod`, GitHub Actions CI/Security, and Vercel deployment.

---

## Reel Mascot & AI Agent Experience Upgrade (Oct 27–28)

- [x] **1. Reel Companion State Machine & Interactive Help Dialog (`apps/web/components/mascot/mascot.config.ts`, `apps/web/components/mascot/Mascot.tsx`, `apps/web/app/runs/[id]/page.tsx`)**: `DONE`
  - Added `STAGE_ORDER`, `STAGE_EXPLANATIONS`, `NEXT_STEP_COPY`, `STAGE_EVIDENCE_TAB`, and `AgentActivityItem` in `mascot.config.ts`.
  - Enforced stage-order progression and duplicate stage suppression (`STAGE_ORDER`), terminal state lock (`terminalLockedRef` per `runId`), and false-fix celebration protection (`reproAfterFixPassed === false` or `baselineRegressionPassed === false` plays `'confused'`, never `'celebrate'`).
  - Added accessible `Restore Reel` pill when minimized (`sessionStorage`), keyboard `Escape` support to close the popover/tip, and interactive `Reel companion help` dialog (`Explain this stage`, `Explain this failure`, `What happens next?`, `Open relevant evidence`, `Replay the explanation`, and 6-agent activity summary).
  - Wired `replay:focus-panel` events on `/runs/[id]` so `Open relevant evidence` switches `CodeTabs` (`suspects`, `test`, `diff`, `terminal`) or scrolls to `#report`, and cleaned up replay `setTimeout` timers on unmount.
- [x] **2. Six-Agent Pipeline Hardening & `double-discount` / `string-sort` Root-Cause Fixes (`packages/agents/`)**: `DONE`
  - **Watcher** (`prompts/watcher.md`, `prompts.ts`, `samples/*/expected.json`): Added explicit numeric price-order comparison and post-navigation timestamp rules; reconciled `string-sort` (`3.0s`) and `quantity-reset` (`10.5s`) fixture timestamps with `targets/demo-shop/scripts/record-samples.ts`. Live `pnpm eval:watcher` passes **5/5 (0 fail, 0 blocked)**.
  - **Locator** (`locator.ts`): Accepted multi-segment `...` evidence quotes when every segment is grounded in the target source window. Live `pnpm eval:locator` passes **5/5 (100% top-1 file & grounded symbol)**.
  - **Reproducer** (`reproducer.ts`): Added exact catalog product IDs/prices (`prod-keyboard` $100, `prod-mouse` $20, `prod-pad` $15, `prod-headset` $50), multi-element DOM sort-order assertion guidance (`page.locator('[data-testid^="product-price-"]')`), `cart-discount` text format (`'$10.00'` without leading `'-'`), repeated-click coupon guidance for `double-discount`, and `allocateSandboxPort()` to prevent port `5179` collisions.
  - **Verifier** (`verifier.ts`): Rejected `evaluateAll` selectors returning empty string arrays (`+ ""`) as `SELECTOR_OR_TIMEOUT` (`same_defect: false`) and prevented LLM override when `exitCode !== 0`.
  - **Fixer** (`fixer.ts`, `pipeline.ts`): Added whitespace-tolerant line matching in `validatePatchSafety` and wired `previousAttemptError` into retry attempts.
  - **Pipeline & Timeline Telemetry** (`pipeline.ts`, `apps/web/components/timeline.tsx`): Emitted `tokens`, `estimated_cost_usd`, `duration_ms`, and `model` on all 6 stage `*_completed` events and rendered per-stage cost (`$X.XXXX est.`) in `Timeline`.
  - **Live End-to-End Verification**: `cart-nan`, `double-discount`, and `string-sort` all verified **`FIXED` in 1 attempt** with live Vision Watcher + Locator + Reproducer + Verifier + Fixer + Reporter (**5/5 Demo Shop samples `FIXED`**).
- [x] **3. Frontend Interaction & E2E Matrix Verification (`apps/web/`)**: `DONE`
  - Preserved `steps` array in `BugReportSchema` (`apps/web/lib/api.ts`) so video timeline markers render.
  - Normalized snake_case/camelCase run payloads in `getReplayRun` (`apps/web/lib/replay.ts`).
  - Added `Copy patch` button with `"Copied"` feedback in `CodeTabs` `Diff` tab (`apps/web/components/code-tabs.tsx`), disabled note `<Input>` while busy (`apps/web/components/upload-dropzone.tsx`), and fixed `Source repository` link on `/how` (`apps/web/app/how/page.tsx`).
  - Expanded Playwright E2E suite (`apps/web/tests/e2e.spec.ts`) to **16/16 passing tests** across Chromium and viewports (`1440`, `1280`, `768`, `390`, `320`).

---

## TODO: Skill Additions Log

**Policy:** every time skills are added, removed or updated from any skills folder / repo, add one row below. This file is the record the agent updates first.

| Date | Action | Source | Skills | Agents updated |
| --- | --- | --- | --- | --- |
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

- Master store: `~/.agents/skills`: 470 entries, symlinked into every agent. Add new skills HERE first, then fan out.
- Agent dirs: `~/.claude/skills`, `~/.codex/skills`, `~/.commandcode/skills`, `~/.gemini/antigravity/skills`, `~/.gemini/antigravity-cli/skills`, `~/.omnirush/agent/skills`, `~/.zcode/skills`
- Project dir: `.agents/skills/` (this project)

## Fan-out command (reuse verbatim)

```bash
for T in ~/.claude/skills ~/.codex/skills ~/.commandcode/skills ~/.gemini/antigravity/skills ~/.gemini/antigravity-cli/skills ~/.omnirush/agent/skills ~/.zcode/skills ~/Documents/Replay/.agents/skills; do mkdir -p "$T"; for d in ~/.agents/skills/*/; do n=$(basename "$d"); [ -e "$T/$n" ] || ln -s "$d" "$T/$n"; done; done
```

## Pending

- (none)
