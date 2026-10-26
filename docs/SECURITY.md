# Security

Threat model: Replay executes model-generated code (Playwright tests, code
patches), accepts untrusted video uploads, and sends untrusted model output
through the pipeline. Everything below was implemented 2026-10-26 (review
commit 521105b); verified items were checked by tests, unverified ones are
marked.

## Untrusted code execution

- Model-generated tests and patches run in an isolated workspace, never
  against the primary tree. **Host execution is fail-closed**: enabled only
  outside production, or with an explicit `REPLAY_ALLOW_HOST_SANDBOX=1`
  (`packages/sandbox/src/index.ts`). Production without Docker fails the fix
  stage with `sandbox_unavailable` instead of falling back to the host.
- Sandbox processes receive an **explicit environment allowlist** only (PATH,
  HOME, LANG, TMPDIR, CI). Tests prove `NEBIUS_API_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY` and `DATABASE_URL` are absent inside the sandbox
  (`packages/sandbox/src/index.test.ts`). VERIFIED.
- The full container sandbox (Docker, non-root, network-restricted, tmpfs,
  pids/memory/cpu caps) is defined in `DockerSandbox` and the compose stack;
  wiring the fix stage onto it end to end is OPEN (requires a Docker daemon
  with the sandbox image; documented as the main remaining hardening step).
- node_modules inside the workspace is a symlink to the real dependency tree
  during local runs; the container path must replace this. OPEN (same item).

## Path safety

- Every agent-supplied file path for patch application is resolved against the
  workspace root with realpath checks; traversal, absolute paths, symlink
  escapes, `node_modules`, `.git`, `tests/`, env files, manifests, lockfiles
  and configs are rejected (`resolveSafeWorkspacePath`). VERIFIED by tests
  (traversal, absolute, protected files).

## API

- Per-IP rate limit: 5 run submissions per hour (429 with a clear message).
  Client IP comes from the socket address; the client-controlled first
  X-Forwarded-For hop is ignored. VERIFIED by test.
- Request bodies are capped by a body-limit middleware before parsing, so an
  oversized upload cannot buffer the server to death. VERIFIED by middleware.
- Uploads are content-sniffed (WebM EBML header, MP4/MOV ftyp box) in addition
  to the MIME allowlist; a renamed text file is rejected with 415. VERIFIED.
- `GET /api/runs` lists only sample runs, with no reporter notes and opaque
  video keys; uploaded absolute paths never leave the server. VERIFIED by test.
- Run ids are UUIDs and validated as such; unknown ids return 400/404.
- SSE connections are capped at 5 per client with a 10-minute idle timeout.
- Error responses never include stack traces; provider messages pass through
  one redaction helper (`redactSecretText`) that masks `sk-`/`nvapi`/Bearer/JWT
  patterns before storage or display.
- Known limitation: rate limiting and caps are in-memory per process; a
  multi-replica deployment needs a shared store. OPEN.

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
