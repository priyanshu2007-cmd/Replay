'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { AvatarSurface, type AvatarSurfaceHandle } from './AvatarSurface';
import { validateAvatarDefinition } from '@bible-strong/avatar-core';
import definitionJson from './avatar.avatar.json';
import {
  MASCOT,
  NEXT_STEP_COPY,
  PAGE_TIPS,
  SAMPLE_EXPLANATIONS,
  STAGE_ANIMATION,
  STAGE_EVIDENCE_TAB,
  STAGE_EXPLANATIONS,
  STAGE_ORDER,
  STATE_ANIMATION,
  TEST_FAILING_ANIMATION,
  TIPS,
  type AgentActivityItem,
  type MascotEvent,
} from './mascot.config';

const parsed = validateAvatarDefinition(definitionJson);

type Animation =
  | 'idle' | 'waking' | 'listening' | 'searching' | 'working' | 'thinking'
  | 'curious' | 'confused' | 'celebrate' | 'happy' | 'drowsy' | 'sleeping' | 'playful';

/** Priority: terminal state > stage reactions > mascot click > inactivity. */
const PRIORITY: Record<string, number> = { terminal: 3, stage: 2, mascot: 2, inactivity: 1 };

const DEFAULT_AGENTS: AgentActivityItem[] = [
  { name: 'Watcher', stage: 'watch', status: 'pending' },
  { name: 'Locator', stage: 'locate', status: 'pending' },
  { name: 'Reproducer', stage: 'reproduce', status: 'pending' },
  { name: 'Verifier', stage: 'verify', status: 'pending' },
  { name: 'Fixer', stage: 'fix', status: 'pending' },
  { name: 'Reporter', stage: 'report', status: 'pending' },
];

export default function Mascot() {
  const pathname = usePathname();
  const router = useRouter();
  const controller = useRef<AvatarSurfaceHandle>(null);
  const [broken, setBroken] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [minimised, setMinimised] = useState(false);
  const [desktop, setDesktop] = useState(true);
  const [tip, setTip] = useState<string | null>(null);
  const [activeAnimation, setActiveAnimation] = useState<Animation>('idle');
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpText, setHelpText] = useState<string | null>(null);
  const [question, setQuestion] = useState('');

  // Grounded run context from the active workspace
  const [runStage, setRunStage] = useState<string | null>(null);
  const [runState, setRunState] = useState<string | null>(null);
  const [runStateRaw, setRunStateRaw] = useState<string | null>(null);
  const [usedFallback, setUsedFallback] = useState(false);
  const [reproPassed, setReproPassed] = useState<boolean | undefined>(undefined);
  const [suitePassed, setSuitePassed] = useState<boolean | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentActivityItem[]>(DEFAULT_AGENTS);
  const [bugSummary, setBugSummary] = useState<string | null>(null);
  const [topSuspect, setTopSuspect] = useState<string | null>(null);
  const [hasDiff, setHasDiff] = useState<boolean>(false);
  const [verifierReason, setVerifierReason] = useState<string | null>(null);

  // Grounded homepage readiness context
  const [homeMode, setHomeMode] = useState<'live' | 'replay' | 'offline'>('live');
  const [executionMode, setExecutionMode] = useState<
    'live' | 'recorded_sample_replay' | 'fixture_assisted' | 'read_only'
  >('live');
  const [canExecuteLiveRun, setCanExecuteLiveRun] = useState<boolean>(true);
  const [homeBlockers, setHomeBlockers] = useState<string[]>([]);

  const shownTips = useRef<Set<string>>(new Set());
  const priorityUntil = useRef(0);
  const currentRunIdRef = useRef<string | undefined>(undefined);
  const maxStageOrderRef = useRef<number>(-1);
  const terminalLockedRef = useRef<boolean>(false);
  const lastEventKeyRef = useRef<string>('');
  const lastStateKeyRef = useRef<string>('');
  // The run shown by the page is the only run Reel may react to. Assigned during render so it is
  // current before the page's own effects dispatch events for a newly opened run.
  const pageRunIdRef = useRef<string | undefined>(undefined);
  pageRunIdRef.current = /^\/runs\/([^/?#]+)/.exec(pathname)?.[1];
  const inactivityTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const definition = parsed.ok ? parsed.value : null;

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const update = () => setDesktop(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    try {
      setMinimised(localStorage.getItem('replay-mascot-min') === '1');
    } catch {
      // storage unavailable
    }
  }, []);

  // Reset run tracking when leaving a run page
  useEffect(() => {
    if (!pathname.startsWith('/runs/')) {
      currentRunIdRef.current = undefined;
      maxStageOrderRef.current = -1;
      terminalLockedRef.current = false;
      priorityUntil.current = 0;
      lastEventKeyRef.current = '';
      lastStateKeyRef.current = '';
      setRunStage(null);
      setRunState(null);
      setRunStateRaw(null);
      setUsedFallback(false);
      setReproPassed(undefined);
      setSuitePassed(undefined);
      setErrorMessage(null);
      setBlockedReason(null);
      setAgents(DEFAULT_AGENTS);
      setBugSummary(null);
      setTopSuspect(null);
      setHasDiff(false);
      setVerifierReason(null);
    }
  }, [pathname]);

  // One short page tip per page per session.
  useEffect(() => {
    const pageTip = PAGE_TIPS[pathname];
    if (!pageTip || shownTips.current.has(`page:${pathname}`)) return;
    shownTips.current.add(`page:${pathname}`);
    setTip(pageTip);
    if (tipTimer.current) clearTimeout(tipTimer.current);
    tipTimer.current = setTimeout(() => setTip(null), 6000);
  }, [pathname]);

  // Escape key closes help dialog or dismisses active tip bubble.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (helpOpen) {
          setHelpOpen(false);
        } else if (tip) {
          setTip(null);
        }
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [helpOpen, tip]);

  const play = useCallback(
    (animation: Animation, priority: keyof typeof PRIORITY) => {
      if (terminalLockedRef.current && PRIORITY[priority]! < 3 && priority !== 'mascot') {
        return;
      }
      if (Date.now() < priorityUntil.current && PRIORITY[priority]! < 3) return;
      if (priority === 'terminal') {
        priorityUntil.current = Date.now() + 8000;
        terminalLockedRef.current = true;
      }
      setActiveAnimation(animation);
      if (reducedMotion) return;
      const result = controller.current?.play(animation);
      if (result && !result.ok && result.error.code === 'unknown_animation') {
        setActiveAnimation('idle');
        controller.current?.play('idle');
      }
    },
    [reducedMotion],
  );

  const showTip = useCallback((key: string, force = false) => {
    const text = TIPS[key];
    if (!text) return;
    if (!force && shownTips.current.has(key)) return;
    shownTips.current.add(key);
    setTip(text);
    if (tipTimer.current) clearTimeout(tipTimer.current);
    tipTimer.current = setTimeout(() => setTip(null), 6000);
  }, []);

  // Pipeline & page context reactions.
  useEffect(() => {
    function onMascotEvent(e: Event) {
      const detail = (e as CustomEvent<MascotEvent>).detail;
      if (!detail) return;

      if (detail.kind === 'home_context') {
        setHomeMode(detail.mode);
        setExecutionMode(detail.executionMode);
        setCanExecuteLiveRun(detail.canExecuteLiveRun);
        setHomeBlockers(detail.blockers ?? []);
        return;
      }

      if (detail.runId) {
        // Events for a run the page is not showing (foreign or stale) must not move Reel.
        const shownRunId = pageRunIdRef.current;
        if (shownRunId && detail.runId !== shownRunId) return;
        if (detail.runId !== currentRunIdRef.current) {
          const switchingRuns = currentRunIdRef.current !== undefined;
          currentRunIdRef.current = detail.runId;
          maxStageOrderRef.current = -1;
          terminalLockedRef.current = false;
          priorityUntil.current = 0; // a previous run's terminal cooldown must not block this run
          lastEventKeyRef.current = '';
          lastStateKeyRef.current = '';
          if (switchingRuns) play('idle', 'mascot');
        }
      }

      if (detail.kind === 'context') {
        if (detail.stage !== undefined) setRunStage(detail.stage);
        if (detail.state !== undefined) setRunState(detail.state);
        if (detail.runStateRaw !== undefined) setRunStateRaw(detail.runStateRaw);
        if (detail.fallback !== undefined) setUsedFallback(detail.fallback);
        if (detail.reproAfterFixPassed !== undefined) setReproPassed(detail.reproAfterFixPassed);
        if (detail.baselineRegressionPassed !== undefined) setSuitePassed(detail.baselineRegressionPassed);
        if (detail.errorMessage !== undefined) setErrorMessage(detail.errorMessage);
        if (detail.blockedReason !== undefined) setBlockedReason(detail.blockedReason);
        if (detail.agents) setAgents(detail.agents);
        if (detail.bugSummary !== undefined) setBugSummary(detail.bugSummary);
        if (detail.topSuspect !== undefined) setTopSuspect(detail.topSuspect);
        if (detail.hasDiff !== undefined) setHasDiff(detail.hasDiff);
        if (detail.verifierReason !== undefined) setVerifierReason(detail.verifierReason);
        return;
      }

      if (detail.kind === 'stage') {
        if (terminalLockedRef.current) return;
        const order = STAGE_ORDER[detail.stage] ?? -1;
        const eventKey = `stage:${detail.runId ?? ''}:${detail.stage}:${detail.fallback ? 'fb' : ''}`;
        if (eventKey === lastEventKeyRef.current) return;
        if (order !== -1 && order < maxStageOrderRef.current) return;
        if (order > maxStageOrderRef.current) maxStageOrderRef.current = order;
        lastEventKeyRef.current = eventKey;

        setRunStage(detail.stage);
        if (detail.fallback) setUsedFallback(true);

        const animation =
          detail.stage === 'reproduce'
            ? TEST_FAILING_ANIMATION
            : STAGE_ANIMATION[detail.stage];
        if (animation) play(animation as Animation, 'stage');
        if (detail.fallback && detail.stage === 'watch') showTip('watch_fallback');
        else if (detail.stage === 'reproduce') showTip('reproduce');
        else if (detail.stage === 'fix') showTip('fix');
      } else if (detail.kind === 'state') {
        const gatesVerified =
          detail.reproAfterFixPassed !== false && detail.baselineRegressionPassed !== false;
        const effectiveState =
          detail.state === 'fixed' && !gatesVerified ? 'reproduced_only' : detail.state;

        const eventKey = `state:${detail.runId ?? ''}:${effectiveState}`;
        if (eventKey === lastStateKeyRef.current) return;
        lastStateKeyRef.current = eventKey;

        setRunState(effectiveState);
        setRunStateRaw(effectiveState);
        if (detail.reproAfterFixPassed !== undefined) setReproPassed(detail.reproAfterFixPassed);
        if (detail.baselineRegressionPassed !== undefined) setSuitePassed(detail.baselineRegressionPassed);
        if (detail.errorMessage !== undefined) setErrorMessage(detail.errorMessage);
        if (detail.fallback) setUsedFallback(true);

        const animation = STATE_ANIMATION[effectiveState];
        if (animation) play(animation as Animation, 'terminal');
        showTip(effectiveState);
      }
    }
    window.addEventListener('replay:mascot', onMascotEvent);
    // Ask the page to resend its latest state: it may have emitted before this listener existed.
    window.dispatchEvent(new Event('replay:mascot-ready'));
    return () => window.removeEventListener('replay:mascot', onMascotEvent);
  }, [play, showTip]);

  // Inactivity: drowsy then sleeping; any activity wakes Reel.
  useEffect(() => {
    if (reducedMotion) return;
    let sleeping = false;
    function arm() {
      if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
      inactivityTimer.current = setTimeout(() => {
        if (terminalLockedRef.current) return;
        sleeping = true;
        play('drowsy', 'inactivity');
      }, MASCOT.inactivityMs);
    }
    function onActivity() {
      if (sleeping) {
        sleeping = false;
        play('idle', 'stage');
      }
      arm();
    }
    const opts = { passive: true } as AddEventListenerOptions;
    window.addEventListener('pointermove', onActivity, opts);
    window.addEventListener('keydown', onActivity, opts);
    window.addEventListener('scroll', onActivity, opts);
    arm();
    return () => {
      if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
      window.removeEventListener('pointermove', onActivity);
      window.removeEventListener('keydown', onActivity);
      window.removeEventListener('scroll', onActivity);
    };
  }, [play, reducedMotion]);

  useEffect(() => () => {
    if (tipTimer.current) clearTimeout(tipTimer.current);
  }, []);

  const onAnimationEnd = useCallback(
    (animation: string) => {
      if (animation === 'waking') play('idle', 'stage');
      else if (animation === 'drowsy') play('sleeping', 'inactivity');
      else if (animation === 'celebrate') play('happy', 'stage');
      else if (animation === 'playful') play('idle', 'stage');
    },
    [play],
  );

  const isRouteHidden = MASCOT.hiddenRoutes.some((route) => pathname.startsWith(route));
  if (broken || !definition || isRouteHidden) return null;

  function handleMinimise() {
    setMinimised(true);
    setHelpOpen(false);
    try {
      localStorage.setItem('replay-mascot-min', '1');
    } catch {
      // storage unavailable
    }
  }

  function handleRestore() {
    setMinimised(false);
    try {
      localStorage.setItem('replay-mascot-min', '0');
    } catch {
      // storage unavailable
    }
  }

  function explainCurrentStage(): string {
    if (runStage && STAGE_EXPLANATIONS[runStage]) {
      const base = STAGE_EXPLANATIONS[runStage]!;
      if (runStage === 'watch' && usedFallback) {
        return `${base} Note: this run used fixture-assisted clip metadata rather than live vision.`;
      }
      return base;
    }
    if (pathname === '/') {
      if (homeMode !== 'live') {
        return 'The backend API is currently unreachable. Click Retry API readiness below once the backend is running.';
      }
      if (executionMode === 'recorded_sample_replay') {
        return 'Serverless Demo Mode: All 5 sample recordings are playable and Run sample opens pre-verified Demo Shop pipeline artifacts.';
      }
      return PAGE_TIPS['/']!;
    }
    return PAGE_TIPS[pathname] ?? 'Reel tracks each deterministic gate across the 7-stage Replay pipeline.';
  }

  function explainFailureOrFallback(): string {
    if (errorMessage) {
      return `Stage failure: ${errorMessage}`;
    }
    if (blockedReason) {
      return `Blocked stage: ${blockedReason}`;
    }
    if (runState === 'reproduced_only') {
      return `The bug was genuinely reproduced before patching, but post-fix verification did not pass both gates (repro test after fix: ${
        reproPassed ? 'passed' : 'failed'
      }, baseline suite: ${suitePassed ? 'passed' : 'failed'}). Replay never marks a patch fixed unless both pass.`;
    }
    if (runState === 'unreproduced') {
      return 'The candidate Playwright test did not fail with a matching symptom assertion (timeouts, selector misses, and passing tests are rejected by the Verifier gate).';
    }
    if (usedFallback) {
      return 'Live Watcher vision or serverless worker was unavailable for this sample, so Replay explicitly loaded verified sample fixture/replay data.';
    }
    if (pathname === '/' && homeBlockers.length > 0) {
      return `Readiness notes: ${homeBlockers.join(' ')}`;
    }
    return 'No stage failure is recorded on the current view.';
  }

  function explainNextStep(): string {
    if (runState && NEXT_STEP_COPY[runState]) {
      return NEXT_STEP_COPY[runState]!;
    }
    if (runStage && NEXT_STEP_COPY[runStage]) {
      return NEXT_STEP_COPY[runStage]!;
    }
    if (pathname === '/') {
      return 'Select one of the five sample bugs (cart-nan, double-discount, string-sort, empty-email, quantity-reset) or upload a short WebM/MP4 recording to start a pipeline run.';
    }
    return 'Open a run from the homepage or benchmark table to inspect its stage evidence.';
  }

  function answerUserQuestion(rawQuestion: string): string {
    const q = rawQuestion.trim().toLowerCase();
    if (!q) return explainCurrentStage();

    // Check specific sample IDs first
    for (const [sampleId, desc] of Object.entries(SAMPLE_EXPLANATIONS)) {
      if (q.includes(sampleId) || q.includes(sampleId.replace('-', ' '))) {
        return desc;
      }
    }

    if (q.includes('recording not available') || q.includes('video not available')) {
      return 'A card shows "Recording not available" only when /samples/<id>.webm is missing or fails to load. All five Demo Shop sample WebM files are verified in public/samples/ and served directly.';
    }

    if (
      q.includes("why can't i run") ||
      q.includes('why cant i run') ||
      q.includes('faded') ||
      q.includes('disabled')
    ) {
      if (homeMode !== 'live') {
        return 'Run buttons are disabled because /api/health could not reach the backend. Click "Retry API readiness" to re-check.';
      }
      if (q.includes('upload') || q.includes('this video')) {
        return '"Run on this video" stays disabled until you select a valid .webm, .mp4, .mov, or .mkv file (up to 50 MB and 30s) in the upload box.';
      }
      if (!canExecuteLiveRun && homeBlockers.length > 0) {
        return `Live execution note: ${homeBlockers.join(' ')} Sample runs remain enabled via verified recorded Demo Shop replays.`;
      }
      return 'All five sample cards are enabled and ready to run. For custom videos, choose a .webm or .mp4 file first to enable "Run on this video".';
    }

    if (q.includes('upload') || q.includes('my own video') || q.includes('custom video')) {
      return 'To upload your own video: drop or select a .webm or .mp4 bug clip (<= 50 MB, <= 30s) in the Upload box, optionally add a reporter note, and click "Run on this video". Note: custom video analysis requires a live worker, FFmpeg, sandbox, and NEBIUS_API_KEY.';
    }

    if (q.includes('queued') || q.includes('stuck') || q.includes('waiting')) {
      if (runStateRaw === 'queued') {
        return 'This run is in "queued" state waiting for a Worker process to claim it. Locally, the API starts an inline worker automatically; with Postgres, run "pnpm dev:worker".';
      }
      return `This run is not queued; its current state is "${runState ?? runStage ?? 'ready'}". On Vercel serverless, sample runs load verified recorded artifacts immediately so they never stall in queued.`;
    }

    if (q.includes('fixer') || q.includes('patch') || q.includes('diff')) {
      if (pathname.startsWith('/runs/')) {
        return `Fixer generates a surgical unified diff inside an isolated sandbox${
          topSuspect ? ` targeting ${topSuspect}` : ''
        }. ${
          hasDiff
            ? 'A candidate diff is available in the Diff tab—both the reproduction test and 6-test baseline suite must pass for FIXED.'
            : 'No patch has been applied yet on this run.'
        }`;
      }
      return STAGE_EXPLANATIONS.fix!;
    }

    if (q.includes('pass') || q.includes('did the fix') || q.includes('test')) {
      if (pathname.startsWith('/runs/')) {
        if (runState === 'fixed') {
          return `Yes—post-fix verification passed both gates: reproduction test after fix (${
            reproPassed !== false ? 'PASSED' : 'FAILED'
          }) and baseline regression suite (${suitePassed !== false ? '6/6 GREEN' : 'FAILED'}).`;
        }
        if (runState === 'reproduced_only') {
          return `Pre-fix reproduction succeeded, but post-fix gates did not both pass (repro after fix: ${
            reproPassed ? 'passed' : 'failed'
          }, baseline suite: ${suitePassed ? 'passed' : 'failed'}).`;
        }
      }
      return 'Replay requires two deterministic test gates: (1) the generated Playwright test must fail before the patch for the right symptom, and (2) both the reproduction test and baseline suite must pass after patching.';
    }

    if (q.includes('fail') || q.includes('error') || q.includes('blocker') || q.includes('wrong')) {
      return explainFailureOrFallback();
    }

    if (q.includes('watcher')) return STAGE_EXPLANATIONS.watch!;
    if (q.includes('locator') || q.includes('suspect')) {
      return topSuspect
        ? `Locator ranked ${topSuspect} as the top suspect for "${bugSummary ?? 'this defect'}".`
        : STAGE_EXPLANATIONS.locate!;
    }
    if (q.includes('reproducer')) return STAGE_EXPLANATIONS.reproduce!;
    if (q.includes('verifier')) {
      return verifierReason
        ? `Verifier verdict: ${verifierReason}`
        : STAGE_EXPLANATIONS.verify!;
    }
    if (q.includes('reporter')) return STAGE_EXPLANATIONS.report!;
    if (q.includes('sample')) {
      return 'Replay includes 5 Demo Shop sample bugs: cart-nan ($NaN on empty quantity), double-discount (SAVE10 stacks twice), string-sort ($100 sorted before $20), empty-email (checkout skips email check), and quantity-reset (tab switch resets quantity to 1).';
    }

    return `${explainCurrentStage()} ${explainNextStep()}`;
  }

  function handleQuestionSubmit(e: FormEvent) {
    e.preventDefault();
    if (!question.trim()) return;
    play('thinking', 'mascot');
    setHelpText(answerUserQuestion(question));
    setQuestion('');
  }

  function openRelevantEvidence() {
    if (pathname.startsWith('/runs/')) {
      const targetTab =
        runState === 'fixed' || runState === 'reproduced_only'
          ? 'diff'
          : runState === 'failed' || runState === 'unreproduced'
            ? 'terminal'
            : (runStage && STAGE_EVIDENCE_TAB[runStage]) || 'suspects';
      window.dispatchEvent(new CustomEvent('replay:focus-panel', { detail: { tab: targetTab } }));
      setHelpText(`Focused the ${targetTab} evidence panel.`);
    } else {
      router.push('/benchmark');
      setHelpOpen(false);
    }
  }

  function replayExplanation() {
    const key = runState || (usedFallback && runStage === 'watch' ? 'watch_fallback' : runStage);
    if (key && TIPS[key]) {
      showTip(key, true);
      setHelpText(TIPS[key]!);
      return;
    }
    const pageTip = PAGE_TIPS[pathname] ?? TIPS.reproduce!;
    setTip(pageTip);
    setHelpText(pageTip);
    if (tipTimer.current) clearTimeout(tipTimer.current);
    tipTimer.current = setTimeout(() => setTip(null), 6000);
  }

  if (minimised) {
    return (
      <div
        className="fixed bottom-3 right-3 z-30 md:bottom-4 md:right-4"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)', paddingRight: 'env(safe-area-inset-right)' }}
      >
        <button
          type="button"
          aria-label="Restore Reel"
          onClick={handleRestore}
          className="rounded-full border border-border-subtle bg-panel px-3 py-1.5 font-mono text-[12px] text-secondary shadow-sm transition-colors duration-150 ease-out hover:border-border-strong hover:text-primary"
        >
          Reel
        </button>
      </div>
    );
  }

  return (
    <div
      className="fixed bottom-3 right-3 z-30 md:bottom-4 md:right-4"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)', paddingRight: 'env(safe-area-inset-right)' }}
    >
      {helpOpen && (
        <div
          role="dialog"
          aria-label="Reel companion help"
          className="mb-2 w-[300px] max-w-[calc(100vw-24px)] rounded-m border border-border-subtle bg-panel p-3 text-[12px] leading-snug text-primary shadow-md sm:w-[336px]"
        >
          <div className="mb-2 flex items-center justify-between gap-2 border-b border-border-subtle pb-1.5">
            <span className="font-mono text-[12px] font-semibold text-primary">
              Reel {runStage ? `· ${runStage}` : ''} {runState ? `(${runState})` : ''}
            </span>
            <button
              type="button"
              aria-label="Close Reel help"
              onClick={() => setHelpOpen(false)}
              className="rounded-s px-1.5 py-0.5 text-[11px] text-muted hover:text-primary"
            >
              Esc
            </button>
          </div>

          <div role="region" aria-live="polite" className="mb-2.5 rounded-s bg-canvas p-2 text-[12px] text-secondary">
            {helpText ?? explainCurrentStage()}
          </div>

          <form onSubmit={handleQuestionSubmit} className="mb-2.5 flex gap-1.5">
            <input
              type="text"
              aria-label="Ask Reel a question"
              placeholder="Ask why, about Fixer, samples, or uploads..."
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              className="h-7 min-w-0 flex-1 rounded-s border border-border-subtle bg-canvas px-2 text-[11px] text-primary placeholder:text-muted focus-visible:outline-2 focus-visible:outline-accent"
            />
            <button
              type="submit"
              className="h-7 shrink-0 rounded-s bg-accent px-2.5 font-mono text-[11px] font-medium text-accent-ink hover:opacity-90"
            >
              Ask
            </button>
          </form>

          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setHelpText(explainCurrentStage())}
              className="rounded-s border border-border-subtle bg-canvas px-2 py-1 text-[11px] text-primary hover:border-border-strong"
            >
              Explain this stage
            </button>
            <button
              type="button"
              onClick={() => setHelpText(explainFailureOrFallback())}
              className="rounded-s border border-border-subtle bg-canvas px-2 py-1 text-[11px] text-primary hover:border-border-strong"
            >
              Explain this failure
            </button>
            <button
              type="button"
              onClick={() => setHelpText(explainNextStep())}
              className="rounded-s border border-border-subtle bg-canvas px-2 py-1 text-[11px] text-primary hover:border-border-strong"
            >
              What happens next?
            </button>
            <button
              type="button"
              onClick={openRelevantEvidence}
              className="rounded-s border border-border-subtle bg-canvas px-2 py-1 text-[11px] text-primary hover:border-border-strong"
            >
              Open relevant evidence
            </button>
            <button
              type="button"
              onClick={replayExplanation}
              className="rounded-s border border-border-subtle bg-canvas px-2 py-1 text-[11px] text-primary hover:border-border-strong"
            >
              Replay the explanation
            </button>
            {pathname === '/' && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    window.dispatchEvent(
                      new CustomEvent('replay:mascot-action', { detail: { action: 'scroll-samples' } }),
                    );
                    setHelpText('Scrolled to the five Demo Shop sample recordings.');
                  }}
                  className="rounded-s border border-border-subtle bg-canvas px-2 py-1 text-[11px] text-primary hover:border-border-strong"
                >
                  Open sample section
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setHelpText('Starting sample run for cart-nan...');
                    window.dispatchEvent(
                      new CustomEvent('replay:mascot-action', {
                        detail: { action: 'run-sample', sampleId: 'cart-nan' },
                      }),
                    );
                  }}
                  className="rounded-s border border-border-subtle bg-canvas px-2 py-1 text-[11px] text-primary hover:border-border-strong"
                >
                  Select sample
                </button>
                <button
                  type="button"
                  onClick={() => {
                    window.dispatchEvent(
                      new CustomEvent('replay:mascot-action', { detail: { action: 'open-upload' } }),
                    );
                    setHelpText(
                      'Focused the upload dropzone. Choose a .webm or .mp4 clip (up to 50 MB, <= 30s) to enable "Run on this video".',
                    );
                  }}
                  className="rounded-s border border-border-subtle bg-canvas px-2 py-1 text-[11px] text-primary hover:border-border-strong"
                >
                  Open upload guidance
                </button>
                <button
                  type="button"
                  onClick={() => {
                    window.dispatchEvent(
                      new CustomEvent('replay:mascot-action', { detail: { action: 'recheck-ready' } }),
                    );
                    setHelpText('Rechecked /api/health and /api/ready status.');
                  }}
                  className="rounded-s border border-border-subtle bg-canvas px-2 py-1 text-[11px] text-primary hover:border-border-strong"
                >
                  Retry API readiness
                </button>
              </>
            )}
            {pathname.startsWith('/runs/') &&
              (runState === 'failed' || runState === 'reproduced_only' || runState === 'unreproduced') && (
                <button
                  type="button"
                  onClick={() => {
                    setHelpText('Starting a fresh rerun for this recording...');
                    window.dispatchEvent(
                      new CustomEvent('replay:mascot-action', { detail: { action: 'retry-run' } }),
                    );
                  }}
                  className="rounded-s border border-border-subtle bg-canvas px-2 py-1 text-[11px] text-primary hover:border-border-strong"
                >
                  Retry failed run
                </button>
              )}
          </div>

          {pathname.startsWith('/runs/') && (
            <div className="mt-2.5 border-t border-border-subtle pt-2">
              <p className="mb-1 font-mono text-[10px] uppercase text-muted">Agent activity summary</p>
              <ul className="grid grid-cols-2 gap-1 font-mono text-[11px]">
                {agents.map((a) => (
                  <li key={a.name} className="flex items-center justify-between rounded-s bg-canvas px-1.5 py-0.5">
                    <span className="text-secondary">{a.name}</span>
                    <span
                      className={
                        a.status === 'done'
                          ? 'text-pass'
                          : a.status === 'failed'
                            ? 'text-fail-text'
                            : a.status === 'fallback' || a.status === 'running'
                              ? 'text-progress'
                              : 'text-muted'
                      }
                    >
                      {a.status}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {tip && !helpOpen && (
        <div
          role="status"
          aria-live="polite"
          className="mb-2 max-w-[220px] rounded-s border border-border-subtle bg-panel px-3 py-2 text-[12px] leading-snug text-primary shadow-sm"
        >
          {tip}
        </div>
      )}

      <div className="flex items-end gap-1">
        <button
          type="button"
          aria-label={MASCOT.ariaLabel}
          aria-expanded={helpOpen}
          data-animation={activeAnimation}
          onClick={() => {
            play('playful', 'mascot');
            setTip(null);
            setHelpOpen((prev) => !prev);
            if (!helpOpen) {
              setHelpText(explainCurrentStage());
            }
          }}
          className="block h-20 w-20 cursor-pointer rounded-full transition-transform duration-150 ease-out active:scale-95 motion-reduce:transition-none md:h-[104px] md:w-[104px]"
        >
          <AvatarSurface
            ref={controller}
            definition={definition}
            defaultAnimation={reducedMotion ? undefined : 'waking'}
            defaultExpression={reducedMotion ? 'neutral' : undefined}
            reducedMotion={reducedMotion}
            size={desktop ? MASCOT.desktopSize : MASCOT.mobileSize}
            ariaLabel=""
            onError={() => setBroken(true)}
            onAnimationEnd={onAnimationEnd}
          />
        </button>
        <div className="flex flex-col gap-1">
          <button
            type="button"
            aria-label="Open Reel help"
            aria-expanded={helpOpen}
            onClick={() => {
              setTip(null);
              setHelpOpen((prev) => !prev);
              if (!helpOpen) setHelpText(explainCurrentStage());
            }}
            className="h-6 w-6 rounded-s border border-border-subtle bg-panel font-mono text-[11px] text-secondary transition-colors duration-150 ease-out hover:text-primary"
          >
            ?
          </button>
          <button
            type="button"
            aria-label="Hide Reel"
            onClick={handleMinimise}
            className="h-6 w-6 rounded-s text-muted transition-colors duration-150 ease-out hover:text-primary"
          >
            x
          </button>
        </div>
      </div>
    </div>
  );
}
