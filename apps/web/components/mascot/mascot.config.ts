/**
 * Reel configuration: stage and state reactions, tips, sizing.
 * Animation names must exist in avatar.avatar.json (validated at load by
 * the Mascot component; unknown names fall back to idle at runtime).
 */

export type MascotEvent =
  | { kind: 'stage'; stage: string }
  | { kind: 'state'; state: string };

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
  reproduce: 'This red test is good news: it proves the bug.',
  fix: 'The patch only counts when the test and the suite both pass.',
  fixed: 'Verified: the reproduction test and the existing suite both pass.',
  unreproduced: 'No reproduction means no fix claims. The evidence stays in the report.',
  failed: 'The run failed and said so. Check the error panel for the cause.',
};

export const PAGE_TIPS: Record<string, string> = {
  '/': 'Pick a sample and watch the run go from a red failing test to a verified fix.',
  '/benchmark': 'Every recorded run is here, including the failures.',
  '/how': 'Each stage has one model and one deterministic gate. Nothing passes without proof.',
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
