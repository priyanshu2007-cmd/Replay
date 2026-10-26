# Replay

Drop a bug video. Get a failing test and a verified fix.

Replay takes a screen recording of a web-app bug and returns a reproduction
Playwright test that fails for the same defect, a ranked list of suspect code
locations, a patch, and proof: the reproduction test and the existing test
suite both pass after the patch is applied. Every claim in the output comes
from a real execution. When a stage cannot verify something, the run says so
(`reproduced_only`, `unreproduced`, `failed`) instead of pretending.

Built for the Nebius x NVIDIA Global AI Hackathon (Track A). Models: NVIDIA
Nemotron, served by Nebius Token Factory
(`https://api.tokenfactory.nebius.com/v1/`), as the rules require.

## How it works

```
video ──▶ Ingest ──▶ Watch ──▶ Locate ──▶ Reproduce ──▶ Verify ──▶ Fix ──▶ Report
         ffmpeg     Super VL  Lightning   Ultra         Super VL   Ultra    Nano
         frames     (vision)  (repo)      (test)        (compare)  (patch)  (report)
                        ▲                                        │
                        └──── deterministic gates, no AI ────────┘
```

| Stage | Model (Nebius Token Factory) | Job | Gate |
| --- | --- | --- | --- |
| Ingest | ffmpeg | Timestamped frames from the recording | Frames extracted |
| Watch | `nvidia/Nemotron-3.5-Super-VL` | User steps, expected vs actual, failure frame | Zod-validated BugReport |
| Locate | `nvidia/Nemotron-3_5-Lightning` | Ranked suspect files and line ranges | Only real paths (search_code/read_file) |
| Reproduce | `nvidia/Nemotron-3-Ultra-550b-a55b` | One Playwright test that fails like the video | Assertion failure, not timeout (max 4 attempts) |
| Verify | `nvidia/Nemotron-3.5-Super-VL` | Video frame vs test screenshot: same defect? | Verdict recorded, never assumed |
| Fix | `nvidia/Nemotron-3-Ultra-550b-a55b` | Minimal patch via validated diff | Repro test passes + baseline suite passes (max 3 attempts) |
| Report | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | Markdown bug report from recorded evidence | No facts outside the run record |

Watch runs fixture-assisted today (see Known limitations): when the vision
model or ffmpeg is unavailable, the run continues from the sample's
`expected.json` and the event log labels it `watch_fixture_fallback`. All
other stages execute live.

## Repository structure

```
apps/
  web/        Next.js 15 frontend (home, run workspace, benchmark, how)
  api/        Hono API + worker (run claiming, SSE, uploads)
packages/
  agents/     Model client, prompts, agents, pipeline, tools, CLI
  sandbox/    Isolated execution (workspace copies, bounded commands)
  video/      ffmpeg frame extraction
  storage/    Supabase Storage helpers
  db/         Drizzle schema + migrations
  shared/     Zod contracts shared by every package
targets/
  demo-shop/  React + Vite shop with 5 planted bugs + baseline tests
samples/      One folder per bug: expected.json fixture + videos/
eval/         Evaluator scripts (watcher, locator, reproducer, pipeline)
scripts/      Model smoke test
docs/         Build plan, implementation decisions, design docs
```

## Prerequisites

- Node.js 22+ and pnpm 10+ (`corepack enable`)
- A Nebius Token Factory API key (https://console.tokenfactory.nebius.com), from the Nebius Builder Program
- Optional: Docker (compose stack), Supabase (persistence + replay mode),
  ffmpeg (live video frame extraction)

## Setup

```bash
pnpm install
cp .env.example .env
# Edit .env: set NVIDIA_API_KEY (at minimum).
```

| Variable | Used by | Purpose |
| --- | --- | --- |
| `NEBIUS_API_KEY` | agents, api | Token Factory key (per-role `NEBIUS_API_KEY_<ROLE>` overrides supported) |
| `NEBIUS_BASE_URL` | agents, api | Defaults to `https://api.tokenfactory.nebius.com/v1/` |
| `MODEL_<ROLE>` | agents | Model id per role (watcher, verifier, locator, reproducer, fixer, reporter) |
| `DATABASE_URL` | api, worker | Postgres/Supabase connection string; omit to use the in-memory repository |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | api, storage | Server-side artifact storage; omit for local disk |
| `NEXT_PUBLIC_API_URL` | web | Live API base, e.g. `http://localhost:3001`; empty = replay mode |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | web | Replay mode reads stored sample runs (RLS: `is_sample = true`) |
| `ALLOWED_ORIGINS` | api | Comma-separated browser origins for production CORS |
| `PORT` | api | Default 3001 |

Never commit `.env`. The service-role key and NVIDIA keys stay server-side;
only `NEXT_PUBLIC_*` values reach the browser.

## Run it

```bash
pnpm dev:api        # Hono API + SSE on :3001
pnpm dev:worker     # queue worker (claims queued runs)
pnpm dev:web        # Next.js on :3000
```

Or with Docker (api, worker, postgres, caddy):

```bash
cp .env.example .env   # fill values first
docker compose up
```

## Deploy

The repo is a Vercel services project (`vercel.json`): `web` (Next.js,
public at `/`) and `api` (Hono, public at `/api/*`) deploy from one repo;
`demo-shop` is not a service (it is the sandbox target and runs on the
worker host). There are no service bindings: the browser reaches the API
through the public `/api/*` rewrite, so `NEXT_PUBLIC_API_URL` must stay
unset in the Vercel environment.

Vercel environment variables (api + web):

- `DATABASE_URL` (Supabase Postgres pooler) — required: without a shared
  database, runs created on Vercel cannot be claimed by any worker
- `REPLAY_DATA_DIR=/tmp` — serverless repos are read-only
- `ALLOWED_ORIGINS=https://<your-app>.vercel.app`
- `NEBIUS_API_KEY` — optional on the frontend; live model calls run on the
  worker host, but the key presence drives the honest UI notices
- Never set `NEXT_PUBLIC_*` secrets; the anon key pair only if replay mode
  against Supabase is wanted

The worker + Docker sandbox run on the VM (docker compose in this repo,
same `DATABASE_URL`), not on Vercel: pipelines take 45 to 66 seconds and
need Playwright plus Docker. Run `pnpm --filter @replay/db db:migrate`
against the Supabase database once, then `docker compose up` on the VM.

Database migrations (needed when DATABASE_URL points at Postgres/Supabase):

```bash
pnpm --filter @replay/db db:generate   # after schema changes
pnpm --filter @replay/db db:migrate
```

## Run the pipeline

```bash
pnpm replay cart-nan          # sample id, fixture path, or .webm path
```

The CLI prints the stage trace, the verdict, token totals and the report path
(`artifacts/reports/<runId>.md`). Sample ids: `cart-nan`, `double-discount`,
`string-sort`, `empty-email`, `quantity-reset`.

From the web app: open `http://localhost:3000`, click a sample card, watch the
run live. Finished sample runs can be replayed without a backend when
Supabase replay is configured.

## Tests and evaluation

```bash
pnpm test                                   # every package
pnpm --filter @replay/demo-shop test        # 6 baseline + 5 bug-fixture Playwright tests
pnpm --filter @replay/web test              # frontend e2e (builds + starts web and api)
pnpm smoke:models                           # live model smoke per role against Token Factory
pnpm eval:locator                           # Locator vs 5 fixtures (top-3 accuracy)
pnpm eval:reproducer                        # Reproducer vs fixtures
pnpm eval:pipeline                          # end-to-end fix-and-verify on cart-nan
pnpm replay <sampleId>                      # full pipeline per sample
```

## Sample recordings and fixtures

Each bug has `samples/<id>/expected.json` (failure timestamp, guilty file and
symbol, expected/actual behavior) and a genuine recording in
`samples/videos/<id>.webm`, captured with Playwright against the real Demo
Shop. Re-record with:

```bash
pnpm --filter @replay/demo-shop record:samples   # never overwrites existing clips
```

The demo shop activates each planted bug via a `?bug=<id>` query parameter;
the Watcher/Locator receive the route as context.

## Benchmark results

Method: `pnpm replay <sampleId>` per sample on 2026-10-25, local machine,
models live for Locate/Reproduce/Verify/Fix/Report (then on the NVIDIA Build
endpoint; the provider has since moved to Nebius Token Factory, pending a
re-run with a `NEBIUS_API_KEY`). The Watch stage ran fixture-assisted (dead
designated API key; ffmpeg is installed now, and live vision activates as
soon as a valid model key is set). Success = run status `fixed`: reproduction failed for the planted
defect, patch applied, reproduction test passed afterward, baseline suite
passed.

| Sample | Locate (top suspect, all correct) | Reproduce | Fix attempts | Status | Duration |
| --- | --- | --- | --- | --- | --- |
| cart-nan | `src/App.tsx:84` handleQuantityChange | genuine failure | 1 | **FIXED** | 44.3s |
| empty-email | `src/App.tsx:138` handleCheckout | genuine failure | 1 | **FIXED** | 66.0s |
| quantity-reset | `src/App.tsx:44` handleTabChange | genuine failure | 1 | **FIXED** | 54.4s |
| double-discount | `src/App.tsx:110` handleApplyCoupon | genuine failure | 2 | REPRODUCED_ONLY | 52.3s |
| string-sort | `src/App.tsx:53` handleSortChange | genuine failure | 2 | REPRODUCED_ONLY | 61.3s |

Aggregate (denominator = 5): 5/5 reproduced for the correct defect, 5/5
Locator top-1 suspect correct, 3/5 fixed end to end. The two REPRODUCED_ONLY
runs failed post-fix verification honestly (patch applied, reproduction test
still failing after the attempt budget) and are reported as-is.

Security controls and the full threat model live in `docs/SECURITY.md`
(sandbox fail-closed policy, path-traversal guards, rate limiting, upload
content sniffing, run privacy, security headers, artifact retention).

## Security boundaries

- Uploaded videos are limited to 50 MB and a fixed MIME allowlist; the server
  re-validates everything the client checks.
- Only the five configured sample targets run in the public demo; arbitrary
  repository URLs are not accepted.
- Agent tools validate every path (no traversal), restrict writes to the
  replay test directory, reject patches touching tests/config/manifests, and
  bound file sizes, command output and run duration.
- The sandbox executes workspace copies with bounded, non-interpolated
  commands and always tears down; the public demo never runs arbitrary user
  repositories.
- Docker socket access is a privileged boundary; the compose worker mounts it
  only if you add sandbox Docker isolation, never by default.

## Known limitations

- Watch runs fixture-assisted until a valid `NEBIUS_API_KEY` is configured.
  ffmpeg is installed; the pipeline extracts frames and calls the live Watcher
  automatically the moment a working key exists, falling back to fixtures with
  a visible `watch_model_error` event if the call fails.
- Replay mode against Supabase is implemented but was not exercised against a
  real project (no credentials configured); the frontend shows an honest
  offline state instead.
- Per-stage token/cost breakdown in the UI awaits richer pipeline event
  payloads; run-level totals are shown.
- The public deployment (Vercel + VM) is prepared (Dockerfile, compose,
  Caddyfile) but not deployed; no hosting credentials were authorized.

## License

MIT. Third-party notices: `THIRD_PARTY_NOTICES.md` (the mascot's
`@bible-strong/avatar-core` is AGPL-3.0-only; used unmodified as an npm
dependency).
