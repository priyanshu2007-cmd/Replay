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
};

export const MASCOT = {
  name: 'Reel',
  ariaLabel: 'Reel, the Replay mascot. Activate for a tip.',
  desktopSize: 104,
  mobileSize: 80,
  inactivityMs: 30_000,
  /** Routes where the mascot stays out of the way. */
  hiddenRoutes: ['/how', '/dev/components'],
};
