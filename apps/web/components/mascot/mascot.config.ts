/**
 * Reel configuration: stage and state reactions, tips, sizing, and grounded help copy.
 * Animation names must exist in avatar.avatar.json (validated at load by
 * the Mascot component; unknown names fall back to idle at runtime).
 */

export interface AgentActivityItem {
  name: 'Watcher' | 'Locator' | 'Reproducer' | 'Verifier' | 'Fixer' | 'Reporter';
  stage: 'watch' | 'locate' | 'reproduce' | 'verify' | 'fix' | 'report';
  status: 'pending' | 'running' | 'done' | 'fallback' | 'failed';
}

export type MascotEvent =
  | {
      kind: 'stage';
      stage: string;
      runId?: string;
      seq?: number;
      fallback?: boolean;
    }
  | {
      kind: 'state';
      state: string;
      runId?: string;
      seq?: number;
      reproAfterFixPassed?: boolean;
      baselineRegressionPassed?: boolean;
      errorMessage?: string | null;
      fallback?: boolean;
    }
  | {
      kind: 'context';
      runId?: string;
      stage?: string | null;
      state?: string | null;
      runStateRaw?: string | null;
      fallback?: boolean;
      reproAfterFixPassed?: boolean;
      baselineRegressionPassed?: boolean;
      errorMessage?: string | null;
      blockedReason?: string | null;
      agents?: AgentActivityItem[];
      bugSummary?: string | null;
      topSuspect?: string | null;
      hasDiff?: boolean;
      verifierReason?: string | null;
    }
  | {
      kind: 'home_context';
      mode: 'live' | 'replay' | 'offline';
      executionMode: 'live' | 'recorded_sample_replay' | 'fixture_assisted' | 'read_only';
      canExecuteLiveRun: boolean;
      canReplayRecordedSamples: boolean;
      modelsKeyMissing: boolean;
      blockers: string[];
      samplesCount: number;
    };

export const STAGE_ORDER: Record<string, number> = {
  ingest: 0,
  watch: 1,
  locate: 2,
  reproduce: 3,
  verify: 4,
  fix: 5,
  report: 6,
};

export const STAGE_ANIMATION: Record<string, string> = {
  ingest: 'idle',
  watch: 'listening',
  locate: 'searching',
  reproduce: 'working',
  verify: 'curious',
  fix: 'working',
  report: 'thinking',
};

export const STATE_ANIMATION: Record<string, string> = {
  fixed: 'celebrate',
  reproduced_only: 'confused',
  unreproduced: 'confused',
  failed: 'confused',
};

/** Expected failure mid-run: a red test is progress, Reel thinks, not sads. */
export const TEST_FAILING_ANIMATION = 'thinking';

export const TIPS: Record<string, string> = {
  ingest: 'Extracting timestamped frames from the bug recording.',
  watch: 'Watcher inspects video frames to find the first visible failure.',
  watch_fallback: 'Live vision was unavailable; using verified sample fixture metadata.',
  locate: 'Locator ranks suspect source files and line ranges against the packed repo.',
  reproduce: 'This red test is good news: it proves the bug.',
  verify: 'Verifier checks that the test failed for the reported symptom, not a timeout.',
  fix: 'The patch only counts when the test and the suite both pass.',
  report: 'Reporter assembles the evidence-backed markdown summary.',
  fixed: 'Verified: the reproduction test and the existing suite both pass.',
  reproduced_only: 'Bug reproduced and verified, but the candidate patch did not pass both post-fix gates.',
  unreproduced: 'No reproduction means no fix claims. The evidence stays in the report.',
  failed: 'The run failed and said so. Check the error panel for the cause.',
};

export const PAGE_TIPS: Record<string, string> = {
  '/': 'Pick a sample and watch the run go from a red failing test to a verified fix.',
  '/benchmark': 'Every recorded run is here, including the failures.',
  '/how': 'Each stage has one model and one deterministic gate. Nothing passes without proof.',
};

export const SAMPLE_EXPLANATIONS: Record<string, string> = {
  'cart-nan':
    "cart-nan: Clearing the quantity input calls parseInt('', 10) without an isNaN guard in handleQuantityChange (src/App.tsx:L84-105), causing Cart total to display '$NaN'.",
  'double-discount':
    "double-discount: Clicking Apply twice on SAVE10 increments discountPercent by 10% each click in handleApplyCoupon (src/App.tsx:L107-133) because appliedCoupon === code is not checked.",
  'string-sort':
    "string-sort: Sorting by Price: Low to High uses String(a.price).localeCompare(String(b.price)) in handleSortChange (src/App.tsx:L49-70), placing $100 before $15, $20, and $50.",
  'empty-email':
    "empty-email: Clicking Complete Purchase with a blank email skips validation in handleCheckout (src/App.tsx:L135-157) and shows Order Confirmed.",
  'quantity-reset':
    "quantity-reset: Switching from Cart to Catalog and back resets item quantities to 1 in handleTabChange (src/App.tsx:L41-47).",
};

export const STAGE_EXPLANATIONS: Record<string, string> = {
  ingest: 'Ingest validates the recording and prepares the target repository workspace.',
  watch: 'Watcher analyzes timestamped video frames to identify user steps and the first failure frame. When live vision or FFmpeg is unavailable on a known sample, fixture-assisted metadata is used and labeled explicitly.',
  locate: 'Locator scans the packed repository and ranks suspect files, line numbers, and grounded code quotes.',
  reproduce: 'Reproducer writes a Playwright test asserting expected behavior. An expected assertion failure (red test) is required evidence that the defect is reproduced.',
  verify: 'Verifier enforces the deterministic reproduction gate: timeouts, missing selectors, syntax errors, and passing tests never count as a reproduced bug.',
  fix: 'Fixer proposes a minimal source patch inside an isolated sandbox. A reproduced bug only becomes a verified fix when both the reproduction test and baseline regression suite pass after patching.',
  report: 'Reporter compiles the final markdown report strictly from recorded pipeline evidence, test logs, and token metrics.',
};

export const NEXT_STEP_COPY: Record<string, string> = {
  ingest: 'Next gate: extract keyframes with FFmpeg and run Watcher analysis.',
  watch: 'Next gate: pack the repository and rank suspect source locations with Locator.',
  locate: 'Next gate: generate a failing Playwright test with Reproducer.',
  reproduce: 'Next gate: run the test in the sandbox and confirm a genuine assertion failure in Verifier.',
  verify: 'Next gate: propose a surgical patch in Fixer and rerun both the repro test and baseline suite.',
  fix: 'Next gate: both the post-fix reproduction test and the baseline regression suite must pass before Reporter marks the run FIXED.',
  report: 'Next step: inspect the Suspects, Test, Diff, Terminal, and Report panels.',
  fixed: 'All gates passed: the reproduction test went from red to green and the baseline suite stayed green. You can copy the patch or GitHub issue.',
  reproduced_only: 'The bug was genuinely reproduced, but the candidate patch did not clear both post-fix test gates. Inspect the Diff and Terminal tabs or retry the run.',
  unreproduced: 'The reproduction gate rejected the generated test (noFixWithoutRepro). Inspect the Terminal tab or retry the run.',
  failed: 'Execution stopped due to a stage or infrastructure error. Inspect the Run error banner and click Retry run once resolved.',
};

export const STAGE_EVIDENCE_TAB: Record<string, 'suspects' | 'test' | 'diff' | 'terminal' | 'report'> = {
  ingest: 'suspects',
  watch: 'suspects',
  locate: 'suspects',
  reproduce: 'test',
  verify: 'terminal',
  fix: 'diff',
  report: 'report',
};

export const MASCOT = {
  name: 'Reel',
  ariaLabel: 'Reel, the Replay mascot. Activate for a tip.',
  desktopSize: 104,
  mobileSize: 80,
  inactivityMs: 30_000,
  /** Routes where the mascot stays out of the way. */
  hiddenRoutes: ['/dev/components'],
};
