'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { AvatarSurface, type AvatarSurfaceHandle } from './AvatarSurface';
import { validateAvatarDefinition } from '@bible-strong/avatar-core';
import definitionJson from './avatar.avatar.json';
import {
  MASCOT,
  NEXT_STEP_COPY,
  PAGE_TIPS,
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

  // Grounded run context from the active workspace
  const [runStage, setRunStage] = useState<string | null>(null);
  const [runState, setRunState] = useState<string | null>(null);
  const [usedFallback, setUsedFallback] = useState(false);
  const [reproPassed, setReproPassed] = useState<boolean | undefined>(undefined);
  const [suitePassed, setSuitePassed] = useState<boolean | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentActivityItem[]>(DEFAULT_AGENTS);

  const shownTips = useRef<Set<string>>(new Set());
  const priorityUntil = useRef(0);
  const currentRunIdRef = useRef<string | undefined>(undefined);
  const maxStageOrderRef = useRef<number>(-1);
  const terminalLockedRef = useRef<boolean>(false);
  const lastEventKeyRef = useRef<string>('');
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
      lastEventKeyRef.current = '';
      setRunStage(null);
      setRunState(null);
      setUsedFallback(false);
      setReproPassed(undefined);
      setSuitePassed(undefined);
      setErrorMessage(null);
      setBlockedReason(null);
      setAgents(DEFAULT_AGENTS);
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

  // Pipeline reactions from the run view.
  useEffect(() => {
    function onMascotEvent(e: Event) {
      const detail = (e as CustomEvent<MascotEvent>).detail;
      if (!detail) return;

      if (detail.runId && detail.runId !== currentRunIdRef.current) {
        currentRunIdRef.current = detail.runId;
        maxStageOrderRef.current = -1;
        terminalLockedRef.current = false;
        lastEventKeyRef.current = '';
      }

      if (detail.kind === 'context') {
        if (detail.stage !== undefined) setRunStage(detail.stage);
        if (detail.state !== undefined) setRunState(detail.state);
        if (detail.fallback !== undefined) setUsedFallback(detail.fallback);
        if (detail.reproAfterFixPassed !== undefined) setReproPassed(detail.reproAfterFixPassed);
        if (detail.baselineRegressionPassed !== undefined) setSuitePassed(detail.baselineRegressionPassed);
        if (detail.errorMessage !== undefined) setErrorMessage(detail.errorMessage);
        if (detail.blockedReason !== undefined) setBlockedReason(detail.blockedReason);
        if (detail.agents) setAgents(detail.agents);
        return;
      }

      if (detail.kind === 'stage') {
        // Ignore late stage events once terminal state is reached
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
        // Guard against false fix celebration when post-fix gates did not pass
        const gatesVerified =
          detail.reproAfterFixPassed !== false && detail.baselineRegressionPassed !== false;
        const effectiveState =
          detail.state === 'fixed' && !gatesVerified ? 'reproduced_only' : detail.state;

        const eventKey = `state:${detail.runId ?? ''}:${effectiveState}`;
        if (eventKey === lastEventKeyRef.current) return;
        lastEventKeyRef.current = eventKey;

        setRunState(effectiveState);
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
      return 'Live Watcher vision or FFmpeg was unavailable for this sample, so Replay explicitly fell back to verified sample fixture metadata.';
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
      return 'Select one of the five sample bugs or upload a short WebM/MP4 recording to start a pipeline run.';
    }
    return 'Open a run from the homepage or benchmark table to inspect its stage evidence.';
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
          className="mb-2 w-[280px] max-w-[calc(100vw-24px)] rounded-m border border-border-subtle bg-panel p-3 text-[12px] leading-snug text-primary shadow-md sm:w-[310px]"
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
