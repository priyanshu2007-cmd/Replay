# Replay: AI-Powered Video-to-Bug-Fix Autonomous Agent

> **Turn user bug report videos directly into verified code fixes in minutes.**  
> *Observe the screen. Pinpoint the code. Reproduce the bug. Verify the fix. Zero hallucinations.*

- **Production URL:** [https://replay-blond-psi.vercel.app/](https://replay-blond-psi.vercel.app/)
- **Repository:** [https://github.com/priyanshu2007-cmd/Replay](https://github.com/priyanshu2007-cmd/Replay)
- **Demo Video:** `docs/demo/replay-demo.mp4` / `docs/demo/replay-demo.webm`
- **Mascot:** Reel (the playful video spool companion)

---

## 1. Problem Statement

Modern software teams receive dozens of bug reports every week accompanied by screen recordings:
- Users click a button, a shopping cart total turns into `NaN`, an item price is doubled, or a dropdown fails to sort.
- Developers must manually watch the video, pause frame-by-frame to guess the user's clicks, search through thousands of lines of unfamiliar frontend code, write an automated test to reproduce the behavior, formulate a bugfix, run local regression tests, and draft a pull request.
- This process typically takes hours or days per issue, leading to bug backlogs and missed regressions.

Existing coding assistants only operate on text prompts; they cannot watch screen recordings, correlate visual UI transitions with source code symbols, or run red-to-green test verifications in secure sandboxes.

---

## 2. Solution: Replay

**Replay** is an end-to-end, multi-agent AI system that transforms raw screen recordings into verified pull-request-ready fixes:

1. **Watch & Reason:** Extracts video frames, measures timestamps, and analyzes chronological visual evidence using a multimodal vision model.
2. **Localize Faults:** Cross-references observed UI symptoms against the target repository to pinpoint the exact guilty source file, line numbers, and symbol.
3. **Reproduce via Playwright:** Synthesizes a focused Playwright end-to-end browser test reproducing the exact failure observed in the video.
4. **Verify Same-Symptom:** Runs the reproduction test in an isolated sandbox to confirm that the failure is genuine and matches the observed bug (not a false-positive compilation error or timeout).
5. **Surgical Patching:** Generates a minimal, AST-aware code patch fixing the underlying logic error.
6. **Double-Gate Verification:** Runs both the reproduction test and the entire baseline test suite. A fix is marked `FIXED` only if the reproduction test turns green **and** no regressions are introduced.
7. **Transparent Reporting:** Generates an evidence-backed incident report with token metrics, latencies, frame captures, diffs, and reproducible commands.

---

## 3. System Architecture & Model Pipeline

Replay is organized as a pipeline of 6 specialized autonomous agents, each matched to optimal models via Nebius Token Factory / NVIDIA endpoints:

```
[ Bug Recording / Sample Video ]
              │
              ▼
    ┌───────────────────┐
    │  Frame Extractor  │  (FFmpeg & FFprobe: temporal sampling, metadata)
    └─────────┬─────────┘
              │ Frames + Timestamps
              ▼
    ┌───────────────────┐
    │ 1. Watcher Agent  │  Model: nvidia/nemotron-3.5-super-vl-120b-a12b
    └─────────┬─────────┘  Output: Structured BugReport (failure interval, observed vs expected)
              │
              ▼
    ┌───────────────────┐
    │ 2. Locator Agent  │  Model: nvidia/nemotron-3.5-super-lightning
    └─────────┬─────────┘  Output: Grounded Suspects (file, line range, symbol, confidence)
              │
              ▼
    ┌───────────────────┐
    │ 3. Reproducer     │  Model: nvidia/nemotron-3-ultra-550b
    └─────────┬─────────┘  Output: Standalone Playwright reproduction test
              │
              ▼
    ┌───────────────────┐
    │ 4. Verifier       │  Model: nvidia/nemotron-3.5-super-lightning
    └─────────┬─────────┘  Output: Verification verdict (GENUINE_REPRODUCTION vs false positive)
              │
              ▼
    ┌───────────────────┐
    │ 5. Fixer Agent    │  Model: nvidia/nemotron-3-ultra-550b
    └─────────┬─────────┘  Output: Unified diff patch with boundary checks
              │
              ▼
    ┌───────────────────┐
    │ Sandbox Verifier  │  Isolated container sandbox: pre-fix FAIL -> post-fix PASS + baseline PASS
    └─────────┬─────────┘
              │
              ▼
    ┌───────────────────┐
    │ 6. Reporter Agent │  Model: nvidia/nemotron-3.5-super-lightning
    └───────────────────┘  Output: Evidence-backed markdown report, issue template, PR diff
```

### Models Used

| Role | Configured Model | Justification |
| :--- | :--- | :--- |
| **Watcher (Vision)** | `nvidia/nemotron-3.5-super-vl-120b-a12b` | High-fidelity vision-language model capable of reading dense UI text, observing micro-interactions, and tracking state over temporal video sequences. |
| **Locator (Code Search)** | `nvidia/nemotron-3.5-super-lightning` | Fast, high-context reasoning model that correlates UI symptoms with packed repository code and grounded AST symbols. |
| **Reproducer (Test Synth)** | `nvidia/nemotron-3-ultra-550b` | Flagship code model with deep Playwright knowledge, synthesizing deterministic selectors and robust assertions. |
| **Verifier (Diagnosis)** | `nvidia/nemotron-3.5-super-lightning` | Rapid diagnostics engine verifying failure stacks against observed visual symptoms. |
| **Fixer (Code Patching)** | `nvidia/nemotron-3-ultra-550b` | Powerful code intelligence generating surgical unified diffs without side effects or style thrashing. |
| **Reporter (Documentation)**| `nvidia/nemotron-3.5-super-lightning` | Concise technical writer summarizing timeline evidence, token consumption, and reproduction steps. |

---

## 4. Benchmark & Empirical Evaluation

Replay was evaluated across the official 5-defect **Demo Shop** benchmark (`targets/demo-shop`), a production-grade e-commerce application with real React components, cart calculations, coupon logic, and sorting algorithms.

| Sample ID | Planted Defect | Observed Symptom | Watcher Finding | Locator Top-1 Hit | End-to-End Status | Fix Time |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `cart-nan` | Missing numeric parse on coupon | Cart total renders `$NaN` | Failure at 8.0s; total displays `$NaN` | `src/App.tsx:84-105` (`applyCoupon`) | **FIXED** (1 attempt) | 44.3s |
| `double-discount` | Multiple coupon application allowed | Clicking coupon twice applies discount twice | Repeated clicks reduce total below allowable promo | `src/App.tsx:84-105` (`applyCoupon`) | **FIXED** (1 attempt) | 52.1s |
| `string-sort` | ASCII sort on numeric prices | Products sort as `$100`, `$15`, `$20` | Failure at 3.0s; `$15` item appears after `$100` | `src/App.tsx:64-75` (`sortedProducts`) | **FIXED** (1 attempt) | 58.7s |
| `empty-email` | Missing email validation on checkout | Order succeeds with blank email field | Checkout completes without email validation | `src/App.tsx:135-155` (`handleCheckout`)| **FIXED** (1 attempt) | 66.0s |
| `quantity-reset` | Quantity reset on unrelated filter | Changing filter resets cart item counter | Filter click resets counter to 1 | `src/App.tsx:110-125` (`updateQuantity`) | **FIXED** (1 attempt) | 54.4s |

### Evaluation Metrics
- **Watcher Vision Evaluation:** 5/5 (100%) samples accurately identified visual symptoms, failure intervals, and defect categories.
- **Locator Accuracy:** 5/5 (100%) Top-1 accuracy across all target codebase files and symbols.
- **Test Gate Integrity:** 100% of generated tests reproduced on pre-fix code and passed on post-fix code without failing the baseline regression suite.

---

## 5. Security Architecture & Isolation

Replay executes LLM-generated code and runs browser automation tests. To ensure total safety:

1. **Sandbox Isolation:**
   - Tests execute inside isolated Docker containers or ephemeral temporary workspaces (`packages/sandbox/`).
   - Resource bounded: `--cpus 2`, `--memory 2g`, `--pids-limit 256`, non-root user (`pwuser`), `--security-opt no-new-privileges`, `--cap-drop ALL`.
   - Network restricted (`--network none`) during test execution to prevent data exfiltration.
2. **Environment Sanitization:**
   - Host environment variables are strictly filtered: `NEBIUS_*`, `NVIDIA_*`, `SUPABASE_*`, `DATABASE_URL`, and all `*_KEY`, `*_SECRET`, `*_TOKEN` variables are stripped before spawning test processes.
3. **Patch Traversal Prevention:**
   - Unified diff patches are strictly validated in `packages/agents/src/fixer.ts`: path traversal (`../`), null bytes, Windows drive prefixes, UNC paths, and symlink breakouts are rejected. Files are opened with `O_NOFOLLOW`.
4. **Serverless Safe:**
   - On serverless platforms (e.g., Vercel) where Docker and background workers are unavailable, Replay runs in **Verified Replay Mode** with deterministic sample bundles and honest readiness reporting; it never runs unsandboxed code on serverless hosts.

---

## 6. Video Demonstration

A complete automated demonstration was recorded and transcoded:
- **Location:** `docs/demo/replay-demo.mp4` (940 KB, H.264) and `docs/demo/replay-demo.webm` (4.5 MB)
- **Features Demonstrated:**
  1. Homepage with live readiness status and sample selection.
  2. Video preview of the `cart-nan` defect.
  3. Real-time run workspace with live telemetry (duration, tokens, cost).
  4. Watcher stage showing frame analysis and defect detection at 8.0s.
  5. Locator stage identifying `App.tsx` lines 84–105.
  6. Reproducer stage showing the generated Playwright test.
  7. Verifier stage confirming same-defect failure.
  8. Fixer stage showing surgical unified diff patch.
  9. Verification & Report stage confirming `FIXED` status across all 5 verification gates.
  10. Reel Companion Mascot answering questions and guiding the user.
  11. Benchmark page with live metrics and How It Works architecture page.

---

## 7. How to Run Locally

```bash
# 1. Clone repository
git clone https://github.com/priyanshu2007-cmd/Replay.git
cd Replay

# 2. Install dependencies (Node 24+, pnpm 10+)
pnpm install

# 3. Configure environment
cp .env.example .env
# Fill NEBIUS_API_KEY / NVIDIA_API_KEY in .env

# 4. Verify model connectivity
pnpm smoke:models

# 5. Run end-to-end bug fix pipeline CLI
pnpm replay cart-nan

# 6. Start full web application and API
pnpm dev
# Web app runs at http://localhost:3000
# API server runs at http://localhost:3001
```

---

## 8. Summary & Impact

Replay demonstrates the future of automated software maintenance: closing the loop between visual user experience and underlying source code. By combining high-resolution multimodal vision models with isolated test sandboxes and AST-aware patch generation, Replay turns minutes of frustrating bug triage into instant, verifiable code fixes.

