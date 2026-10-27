# Security

Threat model: Replay executes model-generated code (Playwright tests, code
patches), accepts untrusted video uploads, and sends untrusted model output
through the pipeline. Everything below was implemented 2026-10-26 (review
commit 521105b); verified items were checked by tests, unverified ones are
marked.

## Untrusted code execution

- Model-generated tests and patches run in an isolated workspace, never
  against the primary tree. **Host execution is fail-closed**: enabled only
  outside production, or with an explicit `REPLAY_ALLOW_HOST_SANDBOX=1` on a
  non-serverless host (`packages/sandbox/src/index.ts`). Serverless hosts
  (`VERCEL`, `AWS_LAMBDA_FUNCTION_NAME`, etc.) unconditionally block host
  execution even if `REPLAY_ALLOW_HOST_SANDBOX=1` is set. Production without
  Docker fails closed with `SandboxUnavailableError` (`SANDBOX_UNAVAILABLE`)
  and never claims a reproduction or post-fix test ran. VERIFIED by tests.
- Sandbox processes receive an **explicit environment allowlist** (`PATH`,
  `HOME`, `LANG`, `TMPDIR`, `CI`) plus `sanitizeSandboxEnv()` secret stripping
  that removes any `NEBIUS_*`, `NVIDIA_*`, `SUPABASE_*`, `DATABASE_URL`,
  `*_KEY`, `*_TOKEN`, `*_SECRET`, or `*_PASSWORD` variables even if passed via
  per-command overrides (`packages/sandbox/src/index.test.ts`). VERIFIED.
- `DockerSandbox` is wired into `IsolatedWorkspaceSandbox.create()` with
  non-root execution (`--user pwuser`), resource caps (`--cpus 2`,
  `--memory 2g`, `--pids-limit 256`), `--network none` by default, `--cap-drop ALL`,
  `--security-opt no-new-privileges`, validated bind mounts (rejecting `/`,
  `/etc`, `docker.sock`, `.env`, `.ssh`, `.git`), `:ro` mount for shared
  `node_modules`, and guaranteed `docker rm -f` container cleanup. VERIFIED by
  mocked Docker tests and CI Docker build.

## Path safety

- Every agent-supplied file path (`target_file` and all `---`/`+++` headers in
  unified diffs) is validated by `validateCandidateRelativePathSyntax`,
  `validatePatchSafety`, and `resolveSafeWorkspacePath` (`packages/agents/src/fixer.ts`):
  rejects empty paths, null bytes, Windows backslashes, drive-prefixed paths,
  UNC paths, `..` traversal, symlink targets or parent directories escaping the
  workspace, symlinks pointing to `node_modules` or protected files, and
  multi-file diff mismatches. Revalidates canonical containment and uses
  `O_NOFOLLOW` at the final write boundary. VERIFIED by regression tests with
  external sentinels (`packages/agents/src/fixer.test.ts`).

## API

- Per-IP rate limit: 5 run submissions per hour (`POST /api/runs` and
  `POST /api/runs/:id/rerun`), enforced across instances via `RunRepository.checkRateLimit`
  (PostgreSQL `rate_limit_hits` table under `pg_advisory_xact_lock`, or shared
  `persistPath` in local mode) and failing closed (`503`) if the rate-limit
  store errors.
- Trusted-proxy IP resolution (`clientIp`): validates IPv4/IPv6 with `node:net`
  `isIP`, normalizes `::ffff:` IPv4-mapped IPv6 and bracketed IPv6, honors
  `X-Forwarded-For` / `X-Real-IP` only when `TRUST_PROXY=1` and the peer socket
  is a trusted private/ULA or `TRUSTED_PROXY_IPS` address, and ignores spoofed
  headers on direct connections. VERIFIED by unit tests.
- Request bodies are capped by a body-limit middleware before parsing, so an
  oversized upload cannot buffer the server to death. VERIFIED by middleware.
- Uploads reject zero-byte files (`400`), content-sniff magic bytes (WebM EBML
  header, MP4/MOV/MKV `ftyp` box) in addition to the MIME allowlist (`415`),
  store under a server-generated UUID filename, and unlink any orphaned file if
  database creation fails. VERIFIED by tests.
- `GET /api/runs` lists only sample runs, with no reporter notes and opaque
  video keys; uploaded absolute paths never leave the server. VERIFIED by test.
- Run ids are UUIDs and validated as such; unknown ids return 400/404 before
  consuming SSE connection slots.
- SSE connections (`/api/runs/:id/events`) are capped at 5 per client with a
  10-minute idle timeout, support `Last-Event-ID` reconnects, and stream live
  events across separate API and Worker processes in strict `seq` order.
  VERIFIED by multi-process child-worker SSE test.
- Error responses never include stack traces; provider messages pass through
  one redaction helper (`redactSecretText`) that masks `sk-`/`nvapi`/Bearer/JWT
  patterns before storage or display.

## Web

- Security headers on every route: CSP (default-src self; strict object-src,
  base-uri, frame-ancestors none; connect-src allowlist of API + Supabase),
  nosniff, strict referrer policy, restrictive Permissions-Policy, DENY
  framing. VERIFIED by inspection of served headers.
- CSP compromise, documented: `script-src` keeps `unsafe-inline` (Next.js
  injects framework inline scripts with varying hashes) and `unsafe-eval`
  (supabase-js evaluates a helper internally). Improvement path: nonce-based
  CSP via middleware.
- Report Markdown renders with `skipHtml`, so stored model output cannot
  inject HTML into the run page.

## Supply chain

- `pnpm audit --prod` after patching (re-verified 2026-10-27 on the final
  push): 1 high remaining: zod < 4.6.6. The fix is a major-version migration
  (zod 4) that touches every schema in the repo; deliberately deferred past
  the hackathon deadline and pinned to the latest v3 (3.25.76). Accepted
  risk, tracked here.
- Final secret scan: gitleaks full history clean through commit `67d7f99`
  (2026-10-27), including the two Monaco false positives fingerprint-ignored.
- dompurify (via monaco-editor) and postcss (via next) transitive
  vulnerabilities patched with workspace overrides (3.4.17 / 8.5.12). VERIFIED
  by audit.

## Secrets

- `.env` is gitignored and has never been committed
  (`git log --all --full-history -- .env` is empty). VERIFIED.
- gitleaks reports no leaks in git history (2026-10-26).
- Only `NEXT_PUBLIC_*` values exist in client bundles; the API and worker keep
  the model key, service-role key and database URL server-side.

## Artifacts

- Uploaded videos and run artifacts are deleted after 24 hours by the worker's
  retention job (hourly sweep). VERIFIED by code inspection; long-run
  verification OPEN.
