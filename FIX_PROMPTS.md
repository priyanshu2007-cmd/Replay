# Replay: fix list and prompts

Reviewed on Oct 26, 2026 from the code in `/Users/priyanshu/Documents/Replay` (commit `521105b`). I read the code but did not run the site. Installing packages is blocked in my environment, so every finding comes from reading the source. Prompt 8 runs the real checks.

## 1. What is wrong (ranked)

| # | Severity | Area | Problem | Where |
|---|---|---|---|---|
| 1 | Critical (can disqualify) | Hackathon rules | All models are called through **NVIDIA Build** (`integrate.api.nvidia.com`), not **Nebius Token Factory**. The rules require Token Factory or Nebius AI Cloud. The home page even says "Nemotron models on NVIDIA Build". | `packages/agents/src/llm.ts:4`, `.env` `NVIDIA_BASE_URL`, `apps/web/app/page.tsx:90` |
| 2 | Critical | Core feature | The Watcher (vision model) never runs. Sample runs always use `expected.json` fixtures, and uploaded videos always fail with "Pipeline requires either bugReport, sampleId, or valid videoPath". The headline feature, "video in, test out", is not happening. TODO.md lists the Watcher and frame extractor as BLOCKED, and ffmpeg is not installed. | `packages/agents/src/pipeline.ts:149-178` |
| 3 | Critical | LLM errors hidden | The Verifier and Reporter wrap model calls in `catch {}` and silently switch to a "deterministic-fallback". A wrong key, wrong model ID, 401, 404, 429 or timeout is never shown. | `verifier.ts:209`, `reporter.ts:265` |
| 4 | High | LLM errors hidden | `pipeline_failed` is saved with the stage the run had when it was claimed (`run.stage`), not the stage that failed. The timeline marks a stage failed only when the two match, so the failing stage spins as "running" forever and the error text is buried in a collapsed row. No error banner shows on the run page. | `apps/api/src/worker.ts:234`, `components/timeline.tsx` |
| 5 | High | LLM errors hidden | Fix-attempt failures only say "Vite build failed after patch" or "Reproduction test still failed". The real stderr and stdout from the build or test are dropped. | `pipeline.ts:362`, `:391` and the similar lines |
| 6 | High | Live updates | The SSE stream closes as soon as **any** event has `stage === 'report'`, which includes `report_started`. The browser never receives `pipeline_completed` or `pipeline_failed`, so the run page stays on "running" until a manual reload, and the mascot never celebrates. | `apps/api/src/server.ts:424` |
| 7 | High | Live updates | The run page refetches the run only on `watch_completed` and on completion, so `run.stage` is stale during locate, reproduce and fix. The mascot reacts to `run.stage`, so it never shows searching or working. The effect also refetches on every new event once `watch_completed` exists, which wastes requests. | `app/runs/[id]/page.tsx:66-75`, `:84-88` |
| 8 | High | Replay mode crash | `replayEvents` starts as `null` and the page then calls `allEvents.some(...)` on it. That throws a TypeError, so replay mode crashes on first render. | `app/runs/[id]/page.tsx:57-63` |
| 9 | Medium | Mascot | Hidden on `/how` and `/dev/components` by config, so it is not on every page. It renders at 80 px inside a 104 px desktop button (`size={MASCOT.mobileSize}`). It only reacts on the run page. Home, Benchmark and How have no reactions such as hover, upload, errors or loading. | `mascot.config.ts:45`, `Mascot.tsx:156` |
| 10 | Medium | Frontend | Events the hook does not list (`pipeline_started`, any new error type) are dropped silently because the SSE hook only subscribes to a fixed list. | `hooks/use-run-events.ts:14` |
| 11 | Medium | Frontend | `/api/health` reports `nvidia: configured` from env-var presence only. A bad key looks healthy, and the UI never shows model status. | `server.ts` health handler |
| 12 | Critical | Security | LLM-generated tests and patches run **on the host**, not in Docker, with `env: { ...process.env }`. Code the model writes receives every secret: NVIDIA keys, the Supabase service role key and `DATABASE_URL`. It also has full network access. | `packages/sandbox/src/index.ts:53`, `pipeline.ts:353` |
| 13 | Critical | Security | Path traversal in patch apply: `target_file` only has leading `/` stripped, so `../../...` escapes the workspace. Because `node_modules` is a **symlink** to the real one, a patch can also edit the real dependencies. | `packages/agents/src/fixer.ts:80`, `:165` |
| 14 | High | Security | The rate limit trusts the first `X-Forwarded-For` value, which any client can set to bypass it. | `server.ts:128` |
| 15 | High | Security | `c.req.parseBody()` buffers the whole upload in memory before the 50 MB check, so a large body is a DoS. The MIME type is trusted from the client, with no magic-byte check. | `server.ts:140` |
| 16 | High | Security / privacy | `GET /api/runs` lists every run, including other users' uploads and notes, with no auth. Absolute server paths (`savedPath`, `videoKey`) are returned to clients and stored in events. | `server.ts:217-240`, `:314` |
| 17 | Medium | Security | There are no security headers (CSP, frame-ancestors, nosniff, referrer policy) on web or API. CORS is `*` outside production. There is no SSE connection cap. | `next.config.ts`, `server.ts` |
| 18 | Medium | Security | Uploaded videos are never deleted. Run artifacts and reports pile up in `artifacts/`. | `server.ts`, `pipeline.ts` |
| 19 | Low | Repo hygiene | `ANTIGRAVITY_MASTER_PROMPT.txt`, `AI_BRAIN.md`, `SESSION_MEMORY.md`, `apps/web/demo.tmp.mjs` and `artifacts/replay-src.tgz` (copied in during this review) should not ship. Also confirm `.env` was never committed (it is not tracked now). | repo root |

## 2. Prompts

Run Prompt 0 once. It points to the others in order. Each prompt also works on its own in a fresh Claude Code session inside the repo.

---

### Prompt 0: Master (paste this first)

```text
You are working in the Replay repo (Nebius x NVIDIA hackathon, Track A, due Oct 30 2026 10:30 PM IST).
Follow CLAUDE.md and AGENTS.md. Use ai-agent-toolkit/skills/skill-scout and the ponytail skill (full):
inspect before changing, smallest complete change, verify every step.

Read FIX_PROMPTS.md section 1 (the ranked findings). Then do Prompts 1 to 8 from that file in order.
Before starting, add one TODO.md phase per prompt with checkboxes. Tick a box only after its check
passes. Do not mark anything done that you did not verify. After each prompt, run
`pnpm -r typecheck && pnpm -r test` and fix what you broke.
Never print or commit secrets from .env. Never weaken tests to make them pass.
Finish with a report: what changed (files), commands run with pass/fail, what is still open.
```

---

### Prompt 1: Move all model calls to Nebius Token Factory (fixes #1)

```text
The hackathon requires every model call to go through Nebius Token Factory. Today
packages/agents/src/llm.ts defaults to https://integrate.api.nvidia.com/v1 (NVIDIA Build). Fix that.

1. In llm.ts: default base URL https://api.tokenfactory.nebius.com/v1/ ; read NEBIUS_API_KEY
   (keep per-role overrides NEBIUS_API_KEY_<ROLE> if you want, else one key). Rename env vars
   NVIDIA_* -> NEBIUS_* everywhere (llm.ts, server.ts health, .env.example, README, docker-compose).
2. Default model IDs must be Token Factory IDs. Do not guess: call GET /v1/models with the key and
   pick the exact IDs. Expected (verify): watcher/verifier nvidia/Nemotron-3.5-Super-VL,
   locator nvidia/Nemotron-3_5-Lightning, reproducer/fixer nvidia/Nemotron-3-Ultra-550b-a55b,
   reporter nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B. Keep MODEL_<ROLE> overrides.
3. Add scripts/smoke-models.ts: one tiny call per role, prints role, model, latency, ok or the exact
   provider error (status + message). Never prints the key. Add `pnpm smoke:models`.
4. Fix copy: apps/web/app/page.tsx and the How page must say "NVIDIA Nemotron on Nebius Token Factory".
   Update README "How NVIDIA and Nebius are used".
5. Tell me which env vars I must set in .env (names only). Do not edit .env yourself.

Done when: pnpm smoke:models shows ok for all roles (or a clear error per role), no string
"integrate.api.nvidia.com" or "NVIDIA Build" is left in the repo (grep), tests pass.
```

---

### Prompt 2: Make every LLM and pipeline error visible (fixes #3, #4, #5, #10, #11)

```text
Right now model and pipeline errors are swallowed. Make them visible end to end, without leaking secrets.

Backend
1. llm.ts: wrap provider errors in an LlmError { role, model, status, code, message, retryable }.
   Map: 401/403 -> "auth" ("API key rejected"), 404 -> "model_not_found", 429 -> "rate_limited",
   timeout/network -> "unreachable", invalid JSON after retry -> "bad_output". Redact anything that
   looks like a key (sk-..., Bearer ...) from messages.
2. verifier.ts and reporter.ts: keep the deterministic fallback if you want, but emit an event
   `<stage>_model_error` with the LlmError fields BEFORE falling back, and mark the result
   model: "deterministic-fallback" so the UI can label it. No more empty catch blocks anywhere in
   packages/agents and apps/api (grep "catch {" and "catch (e) {}" and fix each one: log + event, or a comment saying why it is safe).
3. Locator, reproducer and fixer: catch the LlmError, emit `<stage>_model_error`, then rethrow.
4. pipeline.ts fix-attempt failures: include the last 40 lines of stderr/stdout (trimmed, redacted) as
   `output_tail` in fix_attempt_failed and reproduce failures.
5. worker.ts: pipeline_failed must use the stage that actually failed (track the last emitted stage
   from onEvent), and include { error, code, stage, role, model } when it is an LlmError.
6. /api/health: add `models` with per-role status from a cached (5 min) cheap probe, never the key.

Frontend
7. use-run-events.ts: also listen to the generic `message` event and add every type ending in
   `_failed`, `_error`, `_model_error`, `pipeline_started`, so unknown types are not dropped.
8. Run page: when the run is failed or any *_model_error/*_failed event exists, show an error panel at
   the top: stage, model, plain-English cause (map codes: auth -> "The Nebius API key was rejected.
   Check NEBIUS_API_KEY.", model_not_found -> "Model ID not available on Token Factory.", etc.), the
   raw message in a collapsible mono block, and a "Retry run" button (POST /api/runs/:id/rerun, add the
   route if missing).
9. Timeline: a stage with a *_model_error or failed event shows red "failed" and auto-expands.
   Fallback stages show amber "fallback: <reason>", never green.
10. Home page: if /api/health says a model is not ok, show one quiet line naming which.

Done when: with a deliberately wrong key, a sample run shows a red failed stage with
"API key was rejected" within seconds; with a wrong model ID it says model not found; Playwright
test added for both using a mocked API.
```

---

### Prompt 3: Fix live updates on the run page (fixes #6, #7, #8)

```text
Bugs:
- apps/api/src/server.ts ~L424 closes the SSE stream when liveEvent.stage === 'report', which includes
  report_started, so the browser never gets pipeline_completed/pipeline_failed.
- app/runs/[id]/page.tsx: run.stage only refreshes on watch_completed and completion; the refetch effect
  runs on every event after watch_completed; replayEvents starts null and allEvents.some() crashes.

Fix:
1. Close the stream only on pipeline_completed or pipeline_failed (and on run terminal state).
2. Derive currentStage on the client from the latest event's stage (not from run.stage). Use it for the
   timeline and the mascot.
3. Refetch the run once when watch_completed first arrives and once on pipeline_completed/failed.
   Use refs so it never refetches twice for the same event.
4. Initialise replay events as [] and guard every use. Play stored events at recorded speed
   (setTimeout by timestamp deltas, capped at 2 s gaps) instead of dumping them all at once.
5. If SSE stays in "reconnecting" for 20 s, fall back to polling GET /api/runs/:id every 3 s until
   terminal, and say so in the header ("live stream lost, polling").

Done when: a live sample run updates every stage without reload and ends on the right final state;
replay mode loads with the API off; Playwright tests cover both.
```

---

### Prompt 4: Mascot on every page and actually reacting (fixes #9)

```text
Reel (apps/web/components/mascot) must be on every visitor page and react to what happens.

1. mascot.config.ts: hiddenRoutes = ['/dev/components'] only (show it on /how too). Keep it out of the
   way: never overlap the status pill, Monaco panels, the upload button or the video scrubber. On the
   run page at lg+ widths, sit it in the bottom-right gutter outside the 3-column grid or add bottom
   padding to the page so content is never covered.
2. Mascot.tsx: pass the right size per breakpoint (80 mobile, 104 desktop) using matchMedia; the svg
   size must match the button.
3. One tiny event bus: export `mascot.emit(kind, detail)` from mascot.events.ts that dispatches
   'replay:mascot'. Use it from:
   - Home: hover/focus on a sample card "Run" -> curious; upload file picked -> listening;
     upload/sample request in flight -> working; request error -> confused; navigation to a run -> happy.
   - Run page: stage from the latest event (Prompt 3) -> STAGE_ANIMATION; test failing mid-run -> thinking;
     fixed -> celebrate then happy; failed/unreproduced/model error -> confused + tip with the short cause.
   - Benchmark/How: page load -> waking then idle; no extra noise.
4. Click/tap on Reel -> playful + a tip relevant to the current page (add tips for home, run, benchmark, how).
   Tips: max one per page per session, short, no emoji, no em dashes, never over controls.
5. Add a small minimise button (accessible label "Hide Reel"), remembered in localStorage (try/catch).
6. Keep reduced motion: still pose, no reactions.
7. Playwright: Reel visible on /, /how, /benchmark, /runs/<sample>; hidden on /dev/components;
   minimise persists across navigation; reduced motion shows a static pose; on a run reaching
   "fixed" the mascot's current animation is celebrate (expose data-animation on the wrapper for tests).

Done when all those tests pass at 1440 and 390 px widths.
```

---

### Prompt 5: Make the Watcher actually watch the video, and make uploads work (fixes #2)

```text
The vision step is the core of the product and it never runs. Fix it.

1. packages/video: extract frames with ffmpeg (2 fps + scene changes, 1280px JPEG, timestamps).
   Check `ffmpeg -version` at worker start; if missing, fail the run with code "ffmpeg_missing" and a
   clear message (do not silently fall back). Add ffmpeg to apps/api/Dockerfile.
   Document `brew install ffmpeg` for local Mac use in README.
2. pipeline.ts watch stage: if a videoPath exists, ALWAYS call the live Watcher (watcher.ts, Super VL
   via Token Factory) with the frames. For samples, compare the live BugReport against expected.json and
   emit watch_completed with { video_analysis: "live", matches_fixture: true/false }.
   Only use the fixture when the live call fails, and then emit watch_model_error + watch_fixture_fallback
   (Prompt 2) so the UI shows amber "fallback".
3. Uploaded videos (no sampleId) must run through the live Watcher and continue the pipeline on the
   demo-shop target; remove the "Pipeline requires either bugReport, sampleId..." dead end.
4. Frames sent to the model: image_url parts with base64 data URLs or signed URLs, each preceded by
   "t=12.5s". Batch 12 to 15 frames per call if the model rejects more.
5. Video panel: show the Watcher's steps and failure marker from the live BugReport.
6. `pnpm eval:watcher` scores live failure-timestamp accuracy (+-2 s) against all 5 samples and
   prints a table. Put the real numbers in README.

Done when: a sample run shows watch "live" (not fallback) and the video jumps to the right frame;
an uploaded recording of a demo-shop bug completes at least the watch and locate stages.
```

---

### Prompt 6: Frontend improvements

```text
Improve the web app without changing its design language (dark, flat, 1 px borders, Geist, no gradients,
no emoji, no em dashes, no fake numbers). Use the frontend-design skill and the Apple design skills if
installed. Smallest changes that matter:

1. Run page header: show the current stage in words ("Reproducing: writing a Playwright test") with
   elapsed time, not just the run id. Shorten the run id (first 8 chars, full id in a copy button).
2. Status pill: add a "fallback" (amber) state when any stage used a fallback, so judges see honesty.
3. Timeline: per-stage model badge shows the real model ID from events; show tokens and cost per stage
   when events carry them (add them to *_completed payloads in pipeline.ts from metrics).
4. Empty, loading and error states for every async view (home samples, run, benchmark), each with a next
   action. Remove the "start the worker with pnpm dev:worker" developer text from the user-facing run page;
   show it only when NODE_ENV=development.
5. Home: when the API is offline, the sample cards should still open the latest recorded run of that
   sample (replay mode) instead of being disabled.
6. Benchmark page: read real runs from GET /api/runs (or Supabase in replay mode); show reproduced %,
   fixed %, median time, median cost and every failure. Hide the section if there is no data.
7. Accessibility: visible focus on every control, J/K step navigation and Space play/pause on the run
   page, aria-live="polite" only for the final verdict. Check contrast of text-muted on panel (AA).
8. Performance: lazy-load Monaco (already?) and the mascot; check no layout shift; Lighthouse >= 90 on /.
9. Delete apps/web/demo.tmp.mjs and any other temp files.

Done when: Playwright screenshots at 1440/768/390 px for /, /runs/<sample>, /benchmark, /how attached in
the final report, no horizontal scroll at 320 px, lint/typecheck/test/build pass.
```

---

### Prompt 7: Security hardening (fixes #12 to #19)

```text
Harden Replay. Do each item, add a test where it is logic, and list results in docs/SECURITY.md.

Untrusted code execution (most important)
1. Generated tests and patches are untrusted. Run them in DockerSandbox (packages/sandbox already has it),
   not IsolatedWorkspaceSandbox on the host: --network none (the dev server runs inside the same
   container), --read-only root with a tmpfs workdir, --pids-limit 256, --memory 2g, --cpus 2,
   --security-opt no-new-privileges, --cap-drop ALL, non-root user, 120 s timeout, always removed.
   If Docker is unavailable, fail the fix stage with code "sandbox_unavailable"; never fall back to host
   execution in production (allow host only when REPLAY_ALLOW_HOST_SANDBOX=1 in local dev, with a loud warning).
2. Never pass process.env into the sandbox. Pass an explicit allowlist only (PATH, HOME, CI=1,
   DEMO_SHOP_PORT, SANDBOX_TEST). Add a test that asserts NEBIUS_API_KEY / SUPABASE_SERVICE_ROLE_KEY /
   DATABASE_URL are absent inside the sandbox env.
3. Copy node_modules into the sandbox image (or mount read-only); never symlink the host's node_modules.

Patch safety
4. applyPatchToDirectory and every file read/write by agents: resolve the path with path.resolve, then
   fs.realpath, and reject anything outside the workspace root, any path through node_modules, .git,
   .env*, package.json, lockfiles, playwright config or tests/. Unit tests with "../", absolute paths,
   symlinks and encoded traversal.

API
5. Rate limit: use the socket remote address, or the LAST X-Forwarded-For hop only when the request
   comes from the trusted proxy (Caddy). Add a global limit too.
6. Uploads: hono bodyLimit middleware (50 MB) BEFORE parseBody; stream to disk; verify magic bytes
   (WebM 1A45DFA3, MP4/MOV "ftyp" at offset 4); reject others; store under a random name; never return or
   log absolute paths (use an opaque videoKey); delete uploads and artifacts after 24 h (cleanup job).
7. Run privacy: GET /api/runs returns only is_sample runs. A user's own run is readable via an
   unguessable id (UUID v4, already) plus a per-run share token returned on creation; reject listing
   others' uploads. Strip `note` from public listings.
8. Validate :id params as UUIDs; cap SSE connections per IP (e.g. 5) and per run; close idle streams after 10 min.
9. CORS: explicit allowlist from ALLOWED_ORIGINS in every environment except NODE_ENV=development.
10. Error responses never include stack traces or provider raw bodies; logs redact keys
    (sk-, Bearer, eyJ...) with one shared redact() helper.

Web
11. next.config.ts headers: Content-Security-Policy (self + API origin + Supabase origin; no unsafe-eval
    except what Monaco strictly needs, document it), X-Content-Type-Options nosniff, Referrer-Policy
    strict-origin-when-cross-origin, Permissions-Policy (camera=(), microphone=(), geolocation=()),
    frame-ancestors 'none'. The inline theme script needs a nonce or hash.
12. react-markdown for reports: no raw HTML (skipHtml), links rel="noopener noreferrer nofollow".
13. Only NEXT_PUBLIC_ vars in the browser; grep the client bundle (.next/static) for "SERVICE_ROLE",
    "NEBIUS_API_KEY", "sk-" and fail the build check if found.
14. Supabase: RLS on runs and run_events allowing anon SELECT only where is_sample = true; no anon
    insert/update/delete. Provide the SQL in packages/db/migrations and a test query proving it.

Repo and deploy
15. Confirm .env was never committed: `git log --all --full-history -- .env` must be empty. If not,
    tell me to rotate every key immediately.
16. Remove from the repo or gitignore: ANTIGRAVITY_MASTER_PROMPT.txt, AI_BRAIN.md, SESSION_MEMORY.md,
    apps/web/demo.tmp.mjs, artifacts/replay-src.tgz.
17. Docker: api/worker run as non-root; only Caddy exposes ports (remove 3001:3001 publish in prod);
    the worker gets the Docker socket only if it must start sandboxes, documented as a known risk.
18. `pnpm audit --prod` and fix high/critical issues; pin the Playwright image version.
19. Add a SECURITY.md section to README: threat model (untrusted video, untrusted model output,
    untrusted generated code), controls above, known limits.

Done when: all new tests pass, the sandbox env test proves no secrets leak, traversal tests pass,
audit has no high/critical, docs/SECURITY.md lists each item as done or open with reason.
```

---

### Prompt 8: Final verification

```text
Verify everything for real and report honestly.
1. pnpm install; pnpm -r typecheck; pnpm -r lint; pnpm -r test; pnpm --filter @replay/web build.
2. pnpm smoke:models (all roles ok) and pnpm eval:watcher (paste the table).
3. Start api + worker + web. Run all 5 samples once live. Record per sample: watch live or fallback,
   reproduced?, fixed?, duration, tokens, cost. Put the table in README and the Benchmark page.
4. Break it on purpose: wrong NEBIUS_API_KEY, wrong model ID, API stopped (replay mode), ffmpeg missing.
   Each must show a clear message in the UI. Screenshot each.
5. Playwright at 1440, 768, 390, 320 px: home, run, benchmark, how. Mascot visible where it should be.
   No horizontal scroll. Reduced motion respected.
6. Security checks from Prompt 7 (#2, #4, #13, #14, #15) re-run and pasted.
7. Final report: files changed, commands with pass/fail, screenshots, open issues. Do not say "done"
   if anything failed.
```