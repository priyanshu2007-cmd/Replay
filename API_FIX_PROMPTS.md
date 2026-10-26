# Replay: API fix list, fix prompts and GitHub Actions prompts

Reviewed Oct 26, 2026 against commit `13f5c87` ("fix gitleaksignore fingerprints"). I read every file under `apps/api`, the agent pipeline, `packages/sandbox`, `packages/db`, `packages/storage`, the Dockerfile, docker-compose and the web API client.

I could not install packages in my environment, so nothing was executed. Each finding comes from reading the code and cites the file and line. Prompt 0 makes your agent prove each one with a test before fixing it.

## How to use this file

1. Paste **Prompt 0** into Claude Code in the Replay repo. It runs Prompts A1 to A16 in order.
2. Then run **Prompts G1 to G5** to add GitHub Actions for CI, security and deployment.
3. Each prompt also works alone in a fresh session.

---

## 1. Findings, ranked

"Blocks deploy" means it breaks the hosted demo. "Blocks local" means it breaks `pnpm dev` too.

| # | Severity | Problem | Where | Prompt |
|---|---|---|---|---|
| 1 | Blocks deploy | `docker-compose.yml` gives the worker `REPLAY_STANDALONE_DISABLED: "1"`, and `worker.ts:320` only starts when that variable is **unset**. The worker never starts, so every run stays `queued` forever. | `docker-compose.yml` worker env, `worker.ts:320` | A1 |
| 2 | Blocks deploy | The Docker image does not build. The runtime stage copies `/app/samples` from a build stage that never copied it. `pnpm --filter @replay/shared^... build` selects the *dependencies* of shared, which is nothing, so the packages' `dist/` never exists and `tsc` for the API fails. | `apps/api/Dockerfile` | A1 |
| 3 | Blocks deploy | The runtime image is `node:22-alpine`. Playwright browsers do not run on Alpine (musl), and the image has no browsers anyway. Reproduction and fix tests can never run in the container. | `apps/api/Dockerfile` | A1 |
| 4 | Blocks deploy | The container runs as `USER replay`, but `/app` is owned by root. Writing `artifacts/uploads` and `artifacts/runs/<id>/frames` fails with EACCES, so uploads return 500 and the Watcher fails. | `Dockerfile`, `server.ts:242-249`, `pipeline.ts:182` | A1 |
| 5 | Blocks deploy | No database migrations run anywhere. Also, `runs.target_id` has a foreign key to `targets`, but nothing inserts the `demo-shop` target. On Postgres, every `POST /api/runs` fails with a 500. | `packages/db/src/schema.ts:15`, no seed | A2 |
| 6 | Blocks deploy | Live events only travel through an **in-process** `EventEmitter`. With docker compose, the API and worker are separate processes, so the API never hears the worker's events. SSE then shows history only, and the page looks frozen. | `runs.ts:578`, `:600-606` | A3 |
| 7 | Blocks deploy | Uploads are saved on the API container's disk. The worker runs in another container with no shared volume, so it cannot find the file. Supabase Storage (`packages/storage`) exists but is never used. | `server.ts:242-256`, `worker.ts:181-183` | A4 |
| 8 | High | The rate limit and SSE cap key on `socket.remoteAddress`. Behind Caddy, that is always Caddy's IP, so **all users share 5 runs per hour and 5 streams**. | `server.ts:149-153`, `:461-462` | A5 |
| 9 | High | The SSE connection counter leaks. It goes up before the run lookup and never comes down on a 404 or on the early "run already finished" return (`:471-473`, `:495`). After 5 finished-run views, that IP gets 429 on every stream until restart. Combined with #8, nobody can stream. | `server.ts:463-495` | A6 |
| 10 | High | SSE race: history is read, *then* the live subscription starts. Events emitted in between are lost, including `pipeline_completed`, so the stream hangs until the 10-minute idle timeout. | `server.ts:477-504` | A6 |
| 11 | High | Duplicate event `seq` numbers. The API writes `run_created` (seq 1) and `pipeline_started` (seq 2), then the worker passes the pipeline's own seq starting at 1. In memory mode the browser drops the duplicates. On Postgres, the unique index `(run_id, seq)` rejects them and the collector swallows the error, so `ingest_*` events vanish. Auto-seq is also `SELECT max+1` with no lock, which races. | `worker.ts:211`, `runs.ts:308`, `:544-555`, `pipeline.ts:101` | A7 |
| 12 | High | Polling fallback is broken. The browser fetches `/api/runs/:id/events-page` relative to the **web** origin, not `API_BASE`, so it always 404s. | `apps/web/hooks/use-run-events.ts:86` | A6 |
| 13 | High | 4 of 5 samples have no video in `samples/videos/`; only `cart-nan.webm` is there. With ffmpeg and a key present, `extractFrames` runs **outside** the try block (`pipeline.ts:183`), so a missing file or ffmpeg error fails the whole run instead of falling back. `/api/samples` also reports `recordingAvailable: false` for 4 samples. | `pipeline.ts:175-191`, `samples/videos/` | A8 |
| 14 | High | Model errors are only classified in the Verifier and Reporter. The Watcher, Locator, Reproducer and Fixer throw raw OpenAI errors, so `pipeline_failed` has `code: null`, `role: null`, `model: null`. A second bad JSON in `retryJson` throws a raw SyntaxError or ZodError, and the `bad_output` code is never produced. No retry on 429 or 5xx (`maxRetries: 0`), so one transient 502 kills a run. Empty `content` (when a reasoning model puts output elsewhere, or `finish_reason: length`) also becomes a confusing JSON error. | `llm.ts:149`, `:232-233` | A9 |
| 15 | Critical (security) | The Reproducer runs model-written test code **on the host** with `env: { ...process.env }`. It receives every secret (Nebius key, Supabase service role key, `DATABASE_URL`) and has network access. The regex "safety validator" is easy to bypass (`globalThis.process.env`, `fetch`, `require('child_'+'process')`). It also writes into the real `targets/demo-shop/tests/repro`. | `reproducer.ts:317-324`, `:58-100` | A10 |
| 16 | Critical (security) | The Fixer sandbox still runs on the host with network access and **symlinks the real `node_modules`**. In production (`NODE_ENV=production`, set in the Dockerfile), host execution is disabled and `DockerSandbox` is never wired in, so the fix stage always fails when deployed. | `packages/sandbox/src/index.ts:22-26`, `:71-75`, `pipeline.ts` fix stage | A10 |
| 17 | High (privacy) | Absolute server paths leak. `POST /api/runs` returns `videoKey: <absolute path>`. `GET /api/runs/:id` returns `videoKey` and the uploader's `note` for any run. Events carry `savedPath`, `videoPath`, `targetRepo`, `target_repo` and `video_path`, and they go to every SSE and events-page client. | `server.ts:266`, `:276`, `:391-392`, `worker.ts:190-195`, `pipeline.ts:135-139` | A11 |
| 18 | Medium | Input validation gaps: `events-page` and the SSE route skip the UUID check, and `rerun` has no rate limit and can rerun anyone's run (it also breaks once the upload is deleted after 24 h). JSON `targetId` is accepted unchecked and stored. Rate-limit slots are spent before validation, so a typo costs one of your 5. MOV and MKV are saved as `.webm`. | `server.ts:416`, `:427-453`, `:37`, `:154`, `:241` | A12 |
| 19 | Medium | `/api/health` always says `ok`. It never checks the database, the worker, ffmpeg, Docker or the model key. The roles list skips the verifier and fixer. | `server.ts:87-115` | A13 |
| 20 | Medium | The worker never saves `totalTokens` or `estimatedCostUsd`, so cost and tokens are always empty in the UI. On failure it saves none of the partial outputs (bug report, suspects, test), so judges see nothing useful. | `worker.ts:228-243`, `:260-266` | A14 |
| 21 | Medium | The memory repository rewrites the whole `runs.json` synchronously on **every event**, which blocks the event loop and grows forever. `getRunRepository` "falls back" to memory on a Postgres error that cannot happen at construction time (`postgres()` connects lazily). `recoverStaleRuns` nulls the lock before logging it, so `previousWorker` is always null. | `runs.ts:137-149`, `:616-623`, `:274-285` | A15 |
| 22 | Medium | Deploy config: CORS in production defaults to localhost only when `ALLOWED_ORIGINS` is unset, which blocks the Vercel frontend. Port `3001` is published straight to the internet beside Caddy. Root `packageManager` is `pnpm@12.15.0`; confirm that version exists and matches the lockfile. | `server.ts:66-71`, `docker-compose.yml`, `package.json` | A16 |

---

## 2. Fix prompts

### Prompt 0: Master

```text
You are in the Replay repo (Nebius x NVIDIA hackathon, due Oct 30 2026 10:30 PM IST).
Follow CLAUDE.md / AGENTS.md, use the ponytail skill (full): read before editing, smallest
complete change, keep existing structure, one small test per non-trivial fix.

Read API_FIX_PROMPTS.md section 1. For each finding, FIRST write a failing test (or a
reproduction command) that proves it, THEN fix it, THEN show the test passing. If you cannot
reproduce a finding, say so and skip it rather than changing code blindly.

Work through Prompts A1 to A16 in order (A1 to A8 are the ones that make the API work at all).
Add one TODO.md phase per prompt with checkboxes; tick only verified items.
After each prompt: pnpm -r typecheck && pnpm -r test. Do not weaken or delete tests.
Never print, log or commit secrets from .env.
End with: files changed, commands run with pass/fail, findings fixed, findings still open.
```

### A1: Make the Docker image build and the worker start (#1 to #4)

```text
Fix the API/worker container so `docker compose up` actually processes runs.

1. docker-compose.yml: remove REPLAY_STANDALONE_DISABLED from the worker (it disables the
   worker entrypoint, see apps/api/src/worker.ts:320). Give the api service
   REPLAY_INLINE_WORKER=0. Add a named volume `artifacts` mounted at /app/artifacts in BOTH api
   and worker (until A4 moves uploads to Supabase Storage).
2. apps/api/Dockerfile:
   - Build step: `pnpm --filter "@replay/api..." build` (api plus all its workspace deps).
     `@replay/shared^...` selects nothing.
   - Copy samples/ into the build stage before the runtime stage copies it.
   - Runtime base: a Debian image that can run Playwright, pinned to the SAME version as
     @playwright/test in targets/demo-shop (e.g. mcr.microsoft.com/playwright:v1.xx.x-noble).
     Install ffmpeg with apt. Install the demo-shop deps in the image.
   - Create /app/artifacts owned by the non-root user before `USER`. Keep running as non-root.
   - Keep NODE_ENV=production.
3. Add a `.dockerignore` (node_modules, .next, dist, artifacts, .env*, .git, ECC, *.pdf).
4. Verify: `docker compose build` succeeds; `docker compose up`; POST a sample run;
   it leaves `queued` within 5 s; `docker compose exec worker npx playwright --version` works;
   `docker compose exec worker ffmpeg -version` works. Paste outputs.
```

### A2: Database migrations and the missing target row (#5)

```text
On Postgres every POST /api/runs fails: runs.target_id references targets(id) and no
'demo-shop' row exists; nothing runs migrations either.

1. packages/db: add `migrate.ts` using drizzle-orm/postgres-js/migrator that applies
   packages/db/migrations, then upserts the demo-shop target
   (INSERT ... ON CONFLICT (id) DO NOTHING) with name, repo_path 'targets/demo-shop',
   sandbox_image, local_base_url 'http://localhost:5173'. Script: `pnpm --filter @replay/db migrate`.
2. Run it on container start: a one-shot `migrate` service in docker-compose that the api and
   worker depend on (condition: service_completed_successfully).
3. Fail loudly at API startup if DATABASE_URL is set but the DB is unreachable or tables are
   missing (one `select 1 from runs limit 1`), instead of a 500 on the first request.
4. Test (needs Postgres; use the compose postgres or a GitHub Actions service): migrate on an
   empty DB, create a run, read it back.
```

### A3: Live events across processes (#6)

```text
Live SSE only works when the API and worker share a process (in-memory EventEmitter,
apps/api/src/runs.ts:578,600). With separate api/worker containers the browser gets no live events.

Smallest fix with Postgres:
1. PostgresRunRepository.addEvent: after the insert, `NOTIFY run_events, '<runId>:<seq>'`
   (pg_notify in the same statement or right after).
2. PostgresRunRepository: one dedicated LISTEN connection per API process (postgres.js
   `sql.listen('run_events', ...)`). On a notification, load that one event row and emit it on
   the local EventEmitter that subscribeEvents already uses. Reconnect on drop.
3. Keep MemoryRunRepository as is (single process).
4. If you prefer no LISTEN/NOTIFY: inside the SSE handler poll `getEvents(id)` every 1 s for
   seq > lastSent. Pick ONE approach and say why.
5. Test: two repository instances on the same DB; an event added through one reaches a
   subscriber on the other within 2 s.
```

### A4: Uploads the worker can actually read (#7)

```text
Uploaded videos are written to the API container's disk (server.ts:242-256) and the worker
reads videoKey as a local path. Separate containers cannot see each other's disk.

1. If SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set: API uploads the file with the existing
   StorageService (packages/storage) to `uploads/<runId>.<ext>` and stores videoKey
   `storage:uploads/<runId>.<ext>`. Worker downloads it to a temp file before the pipeline and
   deletes it after.
2. Otherwise (local dev): keep local disk, but store videoKey as a RELATIVE key
   `uploads/<runId>.<ext>` and resolve it against an ARTIFACTS_DIR env (default <repo>/artifacts)
   in both api and worker. Reject any key containing `..` or starting with `/`.
3. Save the right extension: mp4 -> .mp4, quicktime -> .mov, matroska -> .mkv, webm -> .webm.
4. Retention (worker.cleanupOldArtifacts) also deletes storage uploads older than 24 h.
5. Test: upload through the API with a separate Worker instance (different repo object, same DB);
   the worker finds and reads the video.
```

### A5: Real client IP behind Caddy (#8)

```text
server.ts:149-153 and :461-462 use socket.remoteAddress first. Behind Caddy that is always the
proxy, so all users share one rate-limit bucket and one SSE cap.

1. Add one helper `clientIp(c)` used by both routes:
   - If TRUST_PROXY=1 and the socket address is in TRUSTED_PROXIES (default: private ranges and
     loopback), use the LAST entry of X-Forwarded-For (Caddy appends the real client IP).
   - Otherwise use the socket address. Never trust the header from an untrusted peer.
2. Caddy already sets X-Forwarded-For; set TRUST_PROXY=1 for the api service in docker-compose.
3. Tests: spoofed header from an untrusted peer is ignored; from a trusted proxy the last hop is
   used; two different clients behind the proxy get separate buckets.
```

### A6: SSE stream correctness (#9, #10, #12)

```text
Fix the SSE route (apps/api/src/server.ts:460-566) and the web polling fallback.

1. Connection counter: increment only after the run is found and the stream starts; decrement
   exactly once in a single `finally` (covers 404, terminal early return, abort, completion,
   idle timeout). Add a test that 10 sequential views of a finished run never return 429.
2. Race: subscribe FIRST and buffer live events, then send history, then flush the buffer,
   skipping seq values already sent. Test: an event added between history read and subscribe is
   delivered.
3. Validate :id as UUID on /events and /events-page (same regex helper as GET /api/runs/:id).
4. Send `retry: 3000` and use the last real seq as the SSE id (not 'ping'/'done') so
   Last-Event-ID resumes work; on reconnect skip events with seq <= Last-Event-ID.
5. apps/web/hooks/use-run-events.ts:86: the polling fallback must call
   `${API_BASE}/api/runs/<id>/events-page` (use the existing getEventsPage() from lib/api.ts),
   not a web-relative URL.
6. Tests for each item (API: node:test with createServer and MemoryRunRepository;
   web: Playwright with the API mocked).
```

### A7: Unique, ordered event sequence numbers (#11)

```text
Event seq numbers collide: the API adds run_created(1) and pipeline_started(2), then the worker
passes the pipeline's own seq starting at 1 (worker.ts:211). Postgres rejects duplicates via the
(run_id, seq) unique index and the pipeline swallows the error; the browser drops duplicates.

1. The repository owns seq. Worker onEvent must NOT pass event.seq; drop `seq` from the addEvent
   input type so no caller can.
2. PostgresRunRepository.addEvent: assign seq atomically, e.g.
   INSERT ... SELECT coalesce(max(seq),0)+1 FROM run_events WHERE run_id=$1 inside a transaction
   with `pg_advisory_xact_lock(hashtext(run_id))`, or add a `next_event_seq` column on runs
   updated with UPDATE ... RETURNING. No SELECT-then-INSERT race.
3. Keep the event's original timestamp: store it (add `created_at` from event.timestamp) instead
   of always defaulting to now().
4. EventCollector (pipeline.ts:101): if onEvent throws, log it with the run id and event type
   (redacted) instead of an empty catch.
5. Tests: 50 concurrent addEvent calls for one run yield seq 1..50 with no gaps or duplicates
   (Postgres); a full sample run in memory mode has strictly increasing unique seq.
```

### A8: Sample videos and safe frame extraction (#13)

```text
Only samples/videos/cart-nan.webm exists; apps/web/public/samples has all five. And
pipeline.ts:182-191 extracts frames OUTSIDE the try, so a missing video or ffmpeg error fails
the run instead of falling back.

1. Put all five sample videos in samples/videos/ (copy from apps/web/public/samples, or make
   the API and worker read from one shared folder). Remove the duplicate copy if you keep one.
2. pipeline.ts: liveWatcherPossible must also require fs.existsSync(videoPath). Move
   extractFrames and the base64 reads inside the try, so any failure emits watch_model_error
   (code 'video_unreadable' or 'ffmpeg_failed') and falls back to the fixture for samples.
3. Cap the request size: max 24 frames at 1024px, JPEG quality ~5, and batch 12 frames per call
   if the request is larger than 8 MB; merge the step lists.
4. /api/samples recordingAvailable must be true for all five after step 1.
5. Tests: missing video file for a sample -> run continues on fixture with a visible fallback
   event; missing video for an upload -> clear pipeline_failed with code video_unreadable.
```

### A9: One error type for every model call, with sane retries (#14)

```text
Only verifier/reporter classify errors. Make every model call fail the same clear way.

1. LlmClient.callJson(role, model, messages, schema, opts): take the role, and wrap BOTH the
   first call and the repair call in try/catch -> throw toLlmError(err, role, model).
   Update all callers (watcher, locator, reproducer, fixer, verifier, reporter) and tests.
2. Repair-call failures (JSON.parse or schema.parse) -> LlmError code 'bad_output' with the
   first 300 chars of the model output (redacted) in the message.
3. Empty content or finish_reason 'length' -> LlmError 'bad_output' saying which, before parsing.
   Set max_tokens per role (watcher 2000, locator 2000, reproducer 4000, fixer 4000,
   reporter 1500), overridable by env.
4. Retries: for retryable codes (rate_limited, unreachable, 5xx) retry up to 2 times with
   1 s / 3 s backoff plus jitter, honouring Retry-After. Emit an event `<stage>_model_retry`
   (via an onRetry callback) so retries are visible, not hidden.
5. Pipeline: catch LlmError at each stage, emit `<stage>_model_error` {code, role, model, status,
   message}, then rethrow so worker.ts pipeline_failed carries code/role/model (already reads them).
6. Tests: 401 -> auth, 404 -> model_not_found, 429 then 200 -> success with one retry event,
   two bad JSON outputs -> bad_output, empty content -> bad_output.
```

### A10: Run all model-written code in a real sandbox (#15, #16)

```text
Security-critical. Model-generated tests and patches are untrusted code.
- reproducer.ts:317-324 runs them on the host with { ...process.env } (all secrets) in the real
  targets/demo-shop folder.
- packages/sandbox IsolatedWorkspaceSandbox runs on the host with network and symlinks the real
  node_modules; in production it is disabled and DockerSandbox is never used, so the fix stage
  always fails when deployed.

1. Use DockerSandbox for BOTH reproduction and fix runs. One image (from A1) with demo-shop deps
   and Playwright browsers. Each run: copy the workspace (source only) into a temp dir, mount it
   at /work, run `npx playwright test <file>` inside the container where the dev server also runs.
   Flags: --network none, --read-only with --tmpfs /tmp, --cap-drop ALL,
   --security-opt no-new-privileges, --pids-limit 256, --memory 2g, --cpus 2, --user 1000:1000,
   timeout, always `docker rm -f` in finally. Env: explicit allowlist only (CI=1, DEMO_SHOP_PORT,
   SANDBOX_TEST). Never pass process.env.
2. The worker container needs the Docker CLI and the host Docker socket for this. Document that
   the socket is root-equivalent; that is why the worker must never run model code itself.
   Alternative if you can't use the socket: run the worker on the VM host (systemd) with Docker.
3. Host execution stays possible only with REPLAY_ALLOW_HOST_SANDBOX=1 in development, using the
   SAME env allowlist, a COPIED node_modules (not a symlink), and a loud warning event.
4. Keep validateReproductionTestCode as a lint, not as a security control; say so in a comment.
5. Never write into the real targets/demo-shop; always work in a temp copy.
6. Tests: a generated test that prints process.env sees no NEBIUS_/SUPABASE_/DATABASE_ vars;
   a test that calls fetch('https://example.com') fails (no network); a patch to
   node_modules/x is rejected; the real targets/demo-shop has no new files after a run.
```

### A11: Stop leaking server paths and other users' notes (#17)

```text
1. Responses: POST /api/runs and GET /api/runs/:id return videoKey only as an opaque value
   (the sample id, or 'upload'). Never an absolute path.
2. GET /api/runs/:id: return `note` only for sample runs or when the request carries the run's
   share token. Create the token on POST /api/runs (random 32 bytes, store only its hash), return
   it once, and have the web app keep it in the URL fragment or sessionStorage for that run.
3. Events: remove savedPath, videoPath, targetRepo, target_repo, video_path from event payloads
   (server.ts:266, worker.ts:190-195, pipeline.ts:135-139). Put a relative label instead.
   Add a `sanitizeEventPayload()` in addEvent that strips any string value that looks like an
   absolute path (/Users/, /home/, /app/, /tmp/, C:\) as a safety net.
4. Same rules for /events and /events-page.
5. Tests: no response body or SSE event contains '/Users/', '/app/', '/tmp/' or the upload dir.
```

### A12: Input validation and abuse limits (#18)

```text
1. One `requireUuid(c)` helper for every :id route (/events, /events-page, /rerun, GET).
2. Count a run against the rate limit only after the request is valid (sample id known or file
   accepted). Put /rerun under the same limit, require the share token from A11 for non-sample
   runs, and return 410 with a clear message if the original upload was deleted by retention.
3. targetId: z.enum(['demo-shop']) (from a KNOWN_TARGETS list); reject anything else with 400.
4. Upload: stream the multipart file to disk/storage instead of holding 50 MB in memory if Hono
   allows it; otherwise keep the bodyLimit and document the memory ceiling.
5. Prune runAttempts and sseConnections maps periodically so they don't grow forever.
6. Tests for each: bad UUID -> 400, unknown target -> 400, invalid request does not consume a slot,
   rerun of a deleted upload -> 410.
```

### A13: Honest health and readiness (#19)

```text
1. Keep GET /api/health as a cheap liveness check: {status:'ok'}.
2. Add GET /api/ready that checks, with a 2 s timeout each and a 30 s cache:
   database (select 1), worker heartbeat (any worker heartbeat in the last 60 s; add a
   `workers` table or a heartbeat row), ffmpeg on the worker (reported by the worker heartbeat),
   Docker sandbox available (same), and one tiny Token Factory call per distinct model
   (GET /v1/models is enough to prove the key works; cache 5 min).
   Return 200 only if all required checks pass, else 503 with per-check status. Never return keys.
3. The web home page uses /api/ready to show one quiet line naming what is down.
4. docker-compose healthchecks: api -> /api/health; the deploy workflow (G4) waits for /api/ready.
5. Tests with each dependency mocked up and down.
```

### A14: Save tokens, cost and partial results (#20)

```text
1. Each agent already returns metrics. Sum totalTokens across all model calls in the pipeline
   (include retries) and compute estimatedCostUsd from a per-model price map in llm.ts
   (input/output $ per 1M tokens, from the Token Factory price page; mark it "estimate").
   Return them in PipelineRunResult and save them in worker.ts.
2. Add per-stage tokens/cost/duration to each `<stage>_completed` event payload.
3. On failure, save whatever exists: bugReport, suspects, generatedTest, beforeTestResult.
   Make runPipeline attach `partial` outputs to the thrown error (or return them via a callback)
   so worker.ts:260 can persist them.
4. Tests: a mocked run sets totalTokens > 0 and a cost string; a run failing at reproduce still
   has bugReport and suspects saved.
```

### A15: Repository robustness (#21)

```text
1. MemoryRunRepository.saveToFile: debounce to at most once per 500 ms and write asynchronously
   (write to tmp file then rename). Cap stored runs to the latest 200.
2. getRunRepository: if DATABASE_URL is set, verify connectivity with `select 1` at startup and
   exit with a clear error on failure. Do not silently fall back to memory when a DB was intended.
3. recoverStaleRuns (memory): capture workerLock before clearing it so previousWorker is correct.
4. persistPath: resolve from the repo root (or ARTIFACTS_DIR), not process.cwd(), so api and worker
   started from different folders use the same file.
5. Tests for each.
```

### A16: Deploy configuration (#22)

```text
1. server.ts CORS: in production, if ALLOWED_ORIGINS is empty, fail at startup with a clear message
   instead of silently allowing only localhost. Document ALLOWED_ORIGINS=https://<your>.vercel.app.
2. docker-compose: do not publish 3001 publicly; only Caddy exposes 80/443. Keep 3001 on the
   internal network (use `expose`).
3. Caddyfile: add `encode zstd gzip`, a request body size limit matching 50 MB, and
   `flush_interval -1` on the reverse_proxy so SSE is not buffered.
4. Root package.json `packageManager`: set it to the pnpm version that actually generated
   pnpm-lock.yaml (check the lockfile header and `pnpm -v`). Pin the same version in Dockerfile
   and CI.
5. .env.example: add TRUST_PROXY, TRUSTED_PROXIES, ARTIFACTS_DIR, ALLOWED_ORIGINS notes.
6. README "Deploy" section updated to match.
```

---

## 3. GitHub Actions prompts

The repo has no `.github/` folder yet. Paste these after the A prompts. Every workflow must:
- Pin third-party actions to a full commit SHA, with the version in a comment.
- Set `permissions:` to the minimum at the top.
- Use `concurrency` to cancel superseded runs.
- Keep secrets in GitHub **Environments** (`staging`, `production`), never in workflow files.

### G1: CI on every push and pull request

```text
Create .github/workflows/ci.yml for the Replay pnpm monorepo.

Triggers: pull_request, push to main. permissions: contents: read. concurrency per ref.
Jobs:
1. `checks` (ubuntu-latest, Node 22, pnpm version from package.json packageManager via
   pnpm/action-setup, pnpm store cache via actions/setup-node cache: pnpm):
   pnpm install --frozen-lockfile; pnpm -r typecheck; pnpm -r lint; pnpm -r test
   (unit tests must not call real models: fail the job if NEBIUS_API_KEY is set).
2. `api-postgres`: service container postgres:16-alpine; run `pnpm --filter @replay/db migrate`,
   then the API tests that need Postgres (A2, A3, A7) with DATABASE_URL pointing at the service.
3. `web-e2e`: build apps/web with NEXT_PUBLIC_API_URL empty (replay mode) and run Playwright
   (`npx playwright install --with-deps chromium`); upload playwright-report as an artifact on
   failure (retention 7 days).
4. `docker-build`: docker/setup-buildx-action + docker/build-push-action with push: false, cache
   to GitHub Actions cache (type=gha), to prove apps/api/Dockerfile builds.
Add a status badge to README. Make `checks`, `api-postgres`, `web-e2e`, `docker-build` the
required checks in branch protection (tell me the exact settings to click; you can't set them).
```

### G2: Security scanning

```text
Create .github/workflows/security.yml. Triggers: pull_request, push to main, weekly schedule
(Monday 03:00 UTC), workflow_dispatch.
Top-level permissions: contents: read. Grant security-events: write only to jobs that upload
SARIF. Pin all actions by SHA.

Jobs:
1. `codeql`: github/codeql-action init/analyze, languages javascript-typescript,
   queries security-extended.
2. `secrets`: gitleaks (gitleaks/gitleaks-action or the gitleaks CLI) over full history
   (fetch-depth: 0), honouring the existing .gitleaksignore. Fail on findings.
3. `dependency-review`: actions/dependency-review-action on pull_request only,
   fail-on-severity: high, deny licenses GPL-3.0-only and AGPL-3.0-only for NEW deps (note:
   the avatar package is already reviewed in THIRD_PARTY_NOTICES.md; allow it explicitly).
4. `audit`: pnpm install --frozen-lockfile && pnpm audit --prod --audit-level high.
5. `container-scan`: build apps/api/Dockerfile and scan it with aquasecurity/trivy-action
   (severity CRITICAL,HIGH, ignore-unfixed true), upload SARIF to code scanning.
6. `semgrep` (optional, free): semgrep ci with p/typescript, p/nodejs, p/secrets; upload SARIF.
Also create .github/dependabot.yml: npm (pnpm) weekly grouped minor/patch updates,
github-actions weekly, docker weekly for apps/api/Dockerfile.
Add SECURITY.md at the repo root (how to report a vulnerability) if docs/SECURITY.md is not enough.
```

### G3: Build and publish the API image

```text
Create .github/workflows/build-image.yml.
Triggers: push to main, tags v*, workflow_dispatch.
permissions: contents: read, packages: write, id-token: write, attestations: write.
Steps: checkout; docker/setup-buildx-action; docker/login-action to ghcr.io with GITHUB_TOKEN;
docker/metadata-action (tags: sha, branch, semver); docker/build-push-action with
platforms linux/amd64, cache type=gha, provenance: true, sbom: true, push to
ghcr.io/<owner>/replay-api. Then actions/attest-build-provenance for the pushed digest.
Run only if CI (G1) succeeded for the same commit: use `workflow_run` on CI completed with
conclusion success, or `needs` if you merge it into ci.yml. Output the image digest.
```

### G4: Deploy the API and worker to the Nebius VM

```text
Create .github/workflows/deploy-api.yml to deploy the API + worker + Caddy to the Nebius AI Cloud
CPU VM over SSH using docker compose and the GHCR image from G3.

Triggers: workflow_dispatch (input: environment staging|production, image tag default = sha),
and automatically to `staging` after build-image succeeds on main.
Use GitHub Environments: `staging` (no approval) and `production` (required reviewer = me).
Environment secrets: VM_HOST, VM_USER, VM_SSH_KEY (deploy-only key), VM_SSH_KNOWN_HOSTS
(pin the host key, never StrictHostKeyChecking=no), and the app secrets NEBIUS_API_KEY,
DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ALLOWED_ORIGINS, REPLAY_HOST, PG_PASSWORD.
permissions: contents: read, packages: read.

Steps:
1. Write the SSH key and known_hosts from secrets (chmod 600).
2. Render a .env on the runner from secrets (never echo it), scp it plus docker-compose.yml and
   Caddyfile to /opt/replay on the VM with mode 600.
3. On the VM: `docker login ghcr.io` with a read-only token, `docker compose pull`,
   run the migrate service (A2), `docker compose up -d --remove-orphans`.
4. Smoke check from the runner: poll https://$REPLAY_HOST/api/ready for up to 3 minutes; then POST
   a sample run and wait until it leaves `queued` (proves the worker runs).
5. On failure: roll back to the previous image tag (keep it in /opt/replay/.last_good) and fail
   the job. On success: write the deployed tag to .last_good.
6. Job summary: deployed tag, URL, ready-check result. Never print secrets; mask derived values
   with ::add-mask::.
Document the one-time VM setup (Docker, a `deploy` user in the docker group, /opt/replay,
firewall 22/80/443 only) in docs/DEPLOY.md.
```

### G5: Deploy the web app (Vercel) and wire it to the API

```text
Pick ONE and document why in docs/DEPLOY.md:
A) Vercel Git integration (simplest): connect the repo in Vercel, root directory apps/web,
   set env vars per environment (NEXT_PUBLIC_API_URL=https://<REPLAY_HOST>,
   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY). Preview deploys on PRs.
   Then add .github/workflows/web-smoke.yml that runs on Vercel's `deployment_status` event and
   runs a short Playwright smoke test against the preview URL (home loads, a sample run page
   loads in replay mode, mascot visible).
B) GitHub Actions with the Vercel CLI: .github/workflows/deploy-web.yml using
   `vercel pull/build/deploy --prebuilt` with VERCEL_TOKEN, VERCEL_ORG_ID, VERCEL_PROJECT_ID as
   environment secrets; production deploy only from main with the `production` environment
   approval; post the preview URL as a PR comment (permissions: pull-requests: write only there).
Either way: after the production web deploy, add its URL to the API's ALLOWED_ORIGINS
(G4 secret) and re-run deploy-api. Fail the smoke test if the browser console shows a CSP or
CORS error.
```

---

## 4. Order I recommend with 4 days left

1. **Day 1:** A1, A2, A5, A6, A7, A8. The API works end to end locally and in docker compose.
2. **Day 2:** A3, A4, A9, A10. Deployed live updates, uploads, clear model errors and a safe sandbox.
3. **Day 3:** A11 to A16, then G1 and G2.
4. **Day 4:** G3, G4, G5, deploy, run the 5 samples on the live URL, record the demo video.

If you are short on time, A10 (sandbox) is the one security item **not** to skip before the URL goes public. Without it, anyone who uploads a video can make the model write code that reads your API keys.
