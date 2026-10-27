# Replay: Project Status Audit

Date: 2026-10-27. Auditor scope: complete repository inspection against commit
`f5c84d7` (branch `main`, working tree clean, all checks green on the remote).
This is an evidence-based audit: every status below was verified by commands run
during this session or by direct code inspection. Companion documents:
`TODO.md` (tracker), `docs/SECURITY.md` (security detail), `README.md` (usage).

---

## A. Executive summary

Replay works today, end to end, on the demo path. A user can open the website,
click one of five real bug samples, and watch a run proceed through the agent
pipeline with live model calls: the bug is reproduced by a generated Playwright
test that genuinely fails, a patch is proposed and applied in an isolated
workspace, and the run ends with an honest verdict (fixed, reproduced-only, or
failed) backed by real test execution. The Docker compose stack runs the same
pipeline in containers. CI (7 checks), security scanning, and production
deployment on Vercel are in place and green.

Can a user run the product? Yes, locally via the CLI (`pnpm replay
cart-nan`), via the web UI with the local API, and via Docker compose.
Can it reproduce a bug? Yes, verified live for cart-nan (genuine assertion
failure matching the defect) and by evaluation for the other four samples.
Can it verify a fix? Yes: the reproduction test must pass post-patch and the
baseline suite must stay green before a run is marked `fixed`; this gate has
both passed and honestly failed live.
Is the frontend usable? Yes, verified in a real browser across routes,
themes, viewports and journeys.
Is deployment healthy? Yes. The Vercel production deployment is Ready and its
routes verified; the Git-integration build path is fixed and verified
(REP-001 closed on commit `10f16b7`: deploy Ready, CI 7/7).
What prevents full completion? Public access (Vercel Authentication toggle),
a Token Factory / NVIDIA key in the Vercel environment for live runs from the
public URL, the demo video, and the Devpost submission.

## B. Architecture and data flow

```
browser (apps/web, Next.js 15, port 3000)
   │  same-origin /api/* (Hono app mounted at app/api/[[...route]]/route.ts)
   ▼
API (apps/api, Hono + worker entry, port 3001)
   │  run lifecycle: queued → running → fixed/reproduced_only/unreproduced/failed
   │  repository: Postgres (Drizzle) when DATABASE_URL is set, else in-memory + JSON file
   ▼
Worker (apps/api/src/worker.ts, claims runs FOR UPDATE SKIP LOCKED)
   ▼
Pipeline (packages/agents/src/pipeline.ts)
   ├─ Ingest: ffmpeg frames (packages/video, 2fps + scene change, ≤1280px)
   ├─ Watch: Nemotron Super VL (vision, base64 image parts) → BugReport (Zod)
   │         fallback: samples/<id>/expected.json fixture (visible event)
   ├─ Locate: Nemotron Lightning over packed repo (packer.ts) → suspects (Zod)
   ├─ Reproduce: Nemotron Ultra writes a Playwright test, executed in an
   │             isolated workspace copy (packages/sandbox) → genuine failure gate
   ├─ Verify: deterministic classification + Super VL same-defect comparison
   ├─ Fix: Nemotron Ultra patch → validated diff → sandbox rebuild →
   │       repro test must pass + baseline suite must stay green (≤3 attempts)
   └─ Report: Nemotron Nano, Markdown from recorded evidence only
   ▼
Artifacts (reports, sandbox outputs) + events (run_events table / memory)
   ▼
Frontend run workspace renders events via SSE (with polling fallback)
```

Providers: NVIDIA Nemotron models via the OpenAI-compatible client
(`packages/agents/src/llm.ts`). The central map (`AGENT_MODEL_DEFAULTS`)
resolves `NEBIUS_*` env names; the current `.env` points `NEBIUS_BASE_URL` at
the working NVIDIA Build endpoint (Decision 006 in
docs/IMPLEMENTATION_DECISIONS.md).

## C. Phase-by-phase status

| Phase | Steps | Status | Key evidence |
|---|---|---|---|
| 0 Repository audit | — | DONE | docs/ + this audit; structure reconciled |
| A Foundation | 1–4 | DONE/PARTIAL | typecheck 9/9; DB schema + migrations + seed (Postgres path verified in compose); Supabase Storage wrapper implemented but live Supabase unverified (REP-010) |
| B Demo target | 5–8 | DONE | 6 baseline + 5 fixture Playwright tests pass; 5 genuine recordings + expected fixtures |
| C Video/Perception | 9–13 | DONE/PARTIAL | ffmpeg installed, extractor unit-tested, live Watcher verified in compose (live video analysis event); Locator eval 5/5 top-1; eval:watcher bounded by vision-key availability historically — now mapped to working key (REP-006) |
| D Action agents | 14–20 | DONE/PARTIAL | pipeline verified end to end live (CLI + compose + CI); sandbox fail-closed; DockerSandbox runtime wiring on VM open (REP-004) |
| E Worker/API | 21–23 | DONE/PARTIAL | compose-verified: claims, events, health, ready, samples; Postgres migrations + seed applied; SSE verified (localhost + unit); Supabase-backed run storage unverified (REP-010) |
| F Frontend | 24–30 | DONE/PARTIAL | all pages implemented and browser-verified; replay mode implemented but Supabase path unverified (REP-010); mascot verified |
| G Delivery | 31–36 | PARTIAL/PENDING | README + CI + security green; Vercel deployed and Git-integration build fixed/verified (REP-001 closed); demo video (35) and submission (36) PENDING |

## D. Feature inventory (high-value features)

| Feature | Location | Verification | Status | Limitation |
|---|---|---|---|---|
| Pipeline CLI | packages/agents/src/cli.ts | live run 2026-10-27: FIXED 53.4s | DONE | Watch fixture-assisted unless live vision key path succeeds |
| Web sample run | apps/web + apps/api | compose live run: live video analysis, locate 7.3k tokens, honest reproduced_only | DONE | none material |
| Sandbox isolation | packages/sandbox | unit tests prove env allowlist; path guard tests | DONE (dev mode) | DockerSandbox wiring for production VM open (REP-004) |
| Fix gate | pipeline.ts fix stage | live: 2 attempts, output tails recorded, honest reproduced_only | DONE | model variance: not every bug fixes on every run |
| SSE + events | apps/api + hooks/use-run-events.ts | unit tests + compose run streamed | DONE | cross-process live events need Postgres LISTEN/NOTIFY (REP-011) |
| Uploads | apps/api/src/server.ts | unit tests (mime, size, magic bytes, opaque key) | DONE | Supabase Storage path unverified (REP-010) |
| Replay mode | apps/web/lib/replay.ts | implemented; honest offline state verified | PARTIAL | Supabase-backed replay unverified (REP-010) |
| Benchmark page | apps/web/app/benchmark | renders real run records | DONE | aggregates from live memory-repo data only |
| Mascot | apps/web/components/mascot | renders, reacts, minimise persists | DONE | n/a |

## E. Error and issue register

| ID | Title | Severity | Category | Status | Evidence | Root cause | Impact | Recommended fix | Priority |
|---|---|---|---|---|---|---|---|---|---|
| REP-001 | Git-integration Vercel build fails | Critical | Deployment | **Fixed & verified** | vercel inspect of replay-2wjg4ijgk: `pnpm --filter @replay/api build` → TS2307 cannot find @replay/shared/@replay/db/@replay/agents | web service buildCommand built @replay/api without its workspace deps (`--filter @replay/api build` lacks the `...` suffix); fresh CI-style checkout has no dist/ | Every Git push produced a failed production deployment; CLI deploys still worked | Fixed in commit `10f16b7`: vercel.json now `pnpm --filter "@replay/api..." build && pnpm run build`; Git deploy of that commit is Ready, CI 7/7 | 1 |
| REP-002 | Model credentials are NVIDIA Build keys under NEBIUS_* names | High | Deployment/Provider | Confirmed | .env (gitignored): NEBIUS_BASE_URL=https://integrate.api.nvidia.com/v1 | Token Factory key was never provisioned; working keys are NVIDIA Build keys | Hackathon rules ask for Token Factory; judges may check the endpoint | Provision a Token Factory key and change only .env (code is endpoint-agnostic) | 2 |
| REP-003 | Vercel Authentication blocks public access | High | Deployment | Confirmed | curl of the production alias returns 302 "Protected by Vercel Authentication" | account-level Deployment Protection enabled | Judges cannot open the demo URL | Dashboard: Settings → Deployment Protection → disable Vercel Authentication | 3 |
| REP-004 | Sandbox runs on host in dev; DockerSandbox not wired in containers | High | Security | Confirmed | packages/sandbox fail-closed policy; compose worker sets REPLAY_ALLOW_HOST_SANDBOX=1 | DockerSandbox was never connected to the pipeline stages; worker container has no Docker socket | Model code runs in a workspace copy with env allowlist but without container isolation on the VM | Mount docker socket + CLI in worker image and wire DockerSandbox into verify/fix stages, or run worker on the VM host with Docker | 4 |
| REP-005 | Zod < 4.6.6 audit high | Medium | Security | Confirmed (accepted) | pnpm audit; docs/SECURITY.md | zod 4 is a breaking major; migration deferred | Audit noise; no known exploited path in this codebase | Migrate schemas to zod 4 post-deadline | 8 |
| REP-006 | Watch stage fixture-fallback on live vision key rejection | Medium | Agent | Confirmed | watch_fixture_fallback events in live runs | designated watcher key 403 (dead); mapped global key works for super-vl text and vision on some calls; intermittent 403s remain | Watch accuracy depends on fixture quality, not the video, when fallback fires | Provision a stable working vision key; keep fallback | 5 |
| REP-007 | Live runs from the Vercel frontend need a shared database | Medium | Deployment | Confirmed | health shows database: fallback-memory; compose verified Postgres path | Vercel functions have no persistent state; without DATABASE_URL runs vanish per invocation | Public-URL runs cannot be claimed by any worker | Set DATABASE_URL on Vercel + run db:migrate + VM worker (same DB) | 6 |
| REP-008 | Cross-process live SSE events need LISTEN/NOTIFY | Medium | Backend | Confirmed | runs.ts in-process EventEmitter; compose api+worker are separate processes | Events travel in-process only | SSE shows history then waits; web polling fallback (20s) covers correctness at reduced latency | pg NOTIFY on addEvent + LISTEN in API, or keep polling fallback | 7 |
| REP-009 | Supabase Storage + replay-mode path unverified | Medium | Backend | Confirmed | no SUPABASE_URL configured; storage wrapper tested by unit only | credentials not provisioned | replay mode from Supabase and signed-upload flow unproven | Provision Supabase project; run the upload + replay journey | 9 |
| REP-010 | Memory repo writes JSON on every event; no debounce | Low | Backend | Confirmed | runs.ts saveToFile on each addEvent | simplest implementation | acceptable locally; unnecessary IO at scale | debounce + async tmp-rename write | 10 |
| REP-011 | ~130 local artifact reports + .playwright-results-repro in packages/agents/artifacts and targets/demo-shop | Low | Hygiene | Confirmed | find output; gitignored (0 untracked in git status) | pipeline writes artifacts relative to package cwd | repo dir clutter; no git impact | relocate artifact root via REPLAY_DATA_DIR (already supported) | 11 |
| REP-012 | Demo video + Devpost submission missing | High | Delivery | PENDING | TODO.md Phase G 35–36 | not yet produced | submission incomplete | record ~70s live run (procedure in TODO), submit on Devpost | 12 |

Resolved in prior work (verified this session, not re-listed above): services
builder ESM/CJS crash (API mounted in Next), ERR_PNPM_IGNORED_BUILDS,
unresolvable action SHAs, CI build order, lint-on-monaco, silent container
exit (isDirectRun guard), zero-row atomic seq insert, em dashes in docs,
host-secret exposure in the reproducer (sandboxed), prompt loading in CJS
bundles.

## F. Possible fixes (priority order)

1. **REP-001 (DONE, commit `10f16b7`):** one-line change in vercel.json —
   `"buildCommand": "pnpm --filter \"@replay/api...\" build && pnpm run build"`.
   Regression check DONE: Git deploy of that commit is Ready, CI 7/7.
2. **REP-003 (no code):** toggle Deployment Protection off in the dashboard.
   Verify: curl the production alias returns 200 and the home page renders.
3. **REP-002 (decision + .env):** provision a Token Factory key (Builder
   Program), set NEBIUS_API_KEY/NEBIUS_BASE_URL to Token Factory values, run
   `pnpm smoke:models` (4/4), re-run `pnpm replay cart-nan`. Code unchanged.
4. **REP-004 (architectural, justified):** wire DockerSandbox into the fix and
   verify stages with the worker given docker CLI + socket (documented
   root-equivalent risk) or run the worker on the VM host. Regression tests:
   sandbox env test (exists), plus a network-isolation test. Prerequisite:
   Docker on the VM.
5. **REP-007 (config + ops):** DATABASE_URL on Vercel, `db:migrate` on
   Supabase, VM worker. Verify: run created via the public URL reaches
   `running` within seconds.
6. **REP-006/008/009/010/011:** see register; each has a bounded fix and no
   dependency on the others.

## G. Verification results (2026-10-27, this session)

| Command | Result | Mode |
|---|---|---|
| `pnpm -r typecheck` | 9/9 packages, exit 0 | static |
| `pnpm --filter @replay/agents test` | 68/68 (serialized) | mocked |
| `pnpm --filter @replay/api test` | 23/23 | mocked + in-memory |
| `pnpm --filter @replay/video test` | 10/10 | unit + env probe |
| `pnpm --filter @replay/sandbox test` | 2/2 | env allowlist proof |
| `pnpm --filter @replay/demo-shop test` | 11/11 | real browser (chromium) |
| `pnpm eval:locator` | 5/5 samples: schema, path, lines, top-1 file and grounded symbol | **live** (Lightning) |
| `pnpm eval:reproducer` | PASS: genuine assertion failure, gate passed | **live** (Ultra) |
| `pnpm eval:pipeline` | SUCCESS: fixed in isolated sandbox, regression-tested | **live + sandbox** |
| `pnpm smoke:models` | 4/4 roles | **live** |
| `pnpm replay cart-nan` | FIXED 53.4s, 1 attempt | **live end to end** (Watch fixture-assisted) |
| `pnpm --filter @replay/web build` | ✓ 7 routes | production build |
| web Playwright e2e | 10/10 local; CI job success | headless chromium |
| Docker compose | postgres+migrate+api+worker up; live run processed | **containers** |
| gitleaks / audit | clean / 1 documented exception | scanners |

Skipped/unavailable: live Supabase paths (no credentials), DockerSandbox
runtime (no Docker socket wiring), Nebius Token Factory endpoint (no key).

## H. Browser and UI audit

Routes tested in the desktop browser (2026-10-26 walkthrough, same build as
HEAD minus docs/test-infra): `/`, `/runs/[id]` (live and completed),
`/benchmark`, `/how`, `/dev/components` (dev-only gate verified). Journeys:
sample run creation → live SSE timeline → panels; completed-run inspection
(video auto-seek, Monaco test/diff, terminal, evidence card, report actions);
upload validation; theme toggle; mascot interactions; unknown-run error state.
Viewports: 1440/390/320 in-browser (no horizontal overflow), 768/1280 via e2e.
Console: no runtime errors during walkthroughs. Findings fixed during that
walkthrough: double-submit guard, Monaco same-origin loading. No open browser
defects.

## I. Security assessment

Scanners run: gitleaks (full history, clean), pnpm audit (1 accepted high),
CodeQL (green on CI). Manual review findings are documented in
docs/SECURITY.md with the remediation state: fail-closed sandbox, env
allowlist (test-proven), path-traversal guards (test-proven), opaque keys,
rate limiting, body limit + magic bytes, UUID validation, SSE caps, security
headers, non-root image, retention job. Unverified: Supabase RLS (no project),
Docker runtime isolation (no socket). No credentials in code or history; the
keys pasted in chat were flagged for rotation.

## J. GitHub and Vercel status

GitHub: `main` = `10f16b7` (audit doc `3630859`, REP-001 fix `10f16b7`),
origin in sync. Checks on `10f16b7`: 7/7 success (Typecheck/lint/unit, API
smoke, Docker builds, Web e2e, CodeQL, Gitleaks, audit). Dependabot PR for
upload-artifact passing CI. Vercel: the Git-integration production deploy of
`10f16b7` (the first after the REP-001 fix) is **Ready** with the standard
aliases attached.

## K. Blockers

| Blocker | Depends on | Blocks | Action needed |
|---|---|---|---|
| Vercel Deployment Protection | dashboard access | public demo URL | user toggles it off |
| Token Factory key | Nebius Builder Program account | rules-compliant provider claim | provision key, update .env |
| DATABASE_URL (Supabase) | Supabase project | live runs from public URL, replay mode, RLS | create project, set env, migrate |
| Docker on the VM + DockerSandbox wiring | VM access | production sandbox isolation | wire DockerSandbox (REP-004) |
| Demo video + Devpost | the above + screen recording | submission | record and submit |

## L. Prioritized action plan

1. **Immediate (DONE):** REP-001 fixed in commit `10f16b7` (Git deploy Ready,
   CI 7/7). Remaining: disable Deployment Protection (dashboard).
2. **High (live-demo quality, ~1-2h):** provision Token Factory key (REP-002);
   set DATABASE_URL on Vercel + Supabase migrate + VM worker (REP-007).
3. **High security (pre-public, ~2-4h):** DockerSandbox wiring (REP-004).
4. **Medium (post-demo hardening):** LISTEN/NOTIFY (REP-008), Supabase
   Storage/replay verification (REP-009), memory-repo debounce (REP-010).
5. **Final release gates:** record demo video, hallway test, README results
   refresh from a fresh 5-sample run, Devpost submission.
6. **Later:** zod 4 migration (REP-005), artifact root relocation (REP-011).

Tasks 1–2 are independent and parallelizable; 3 requires a VM; 5 requires
1–2 for live runs from the public URL.

## M. Final readiness assessment

| Area | Status | Why |
|---|---|---|
| Local development | **Ready** | one-command boot, verified repeatedly |
| Automated testing | **Ready** | 114+ tests green locally and on CI |
| Live AI integration | **Ready** (NVIDIA Build) / **Blocked** (Token Factory claim) | smoke 4/4; Token Factory key not provisioned |
| End-to-end bug reproduction | **Ready** | live CLI + compose + CI-verified |
| End-to-end fix verification | **Ready** | verified live; honest failures when the model patch does not verify |
| Frontend usability | **Ready** | browser-verified across journeys and viewports |
| Security | **Good for demo; 1 open item for public** | sandbox fail-closed; DockerSandbox wiring open |
| CI | **Ready** | 7/7 green, runs on every push |
| Deployment | **Ready** (public access still gated) | Git-integration build fixed and verified (commit `10f16b7`, deploy Ready); public access blocked only by Deployment Protection (REP-003) |
| Hackathon demo readiness | **Ready for local + CLI-demo; public URL pending 3 user actions** | see K |
