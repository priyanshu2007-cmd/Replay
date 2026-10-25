'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { AvatarSurface, type AvatarSurfaceHandle } from './AvatarSurface';
import { validateAvatarDefinition } from '@bible-strong/avatar-core';
import definitionJson from './avatar.avatar.json';
import { MASCOT, PAGE_TIPS, STATE_ANIMATION, STAGE_ANIMATION, TIPS, type MascotEvent } from './mascot.config';

const parsed = validateAvatarDefinition(definitionJson);

type Animation =
  | 'idle' | 'waking' | 'listening' | 'searching' | 'working' | 'thinking'
  | 'curious' | 'confused' | 'celebrate' | 'happy' | 'drowsy' | 'sleeping' | 'playful';

/** Priority: terminal state > stage reactions > mascot click > inactivity. */
const PRIORITY: Record<string, number> = { terminal: 3, stage: 2, mascot: 2, inactivity: 1 };

export default function Mascot() {
  const pathname = usePathname();
  const controller = useRef<AvatarSurfaceHandle>(null);
  const [broken, setBroken] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [minimised, setMinimised] = useState(false);
  const [desktop, setDesktop] = useState(true);
  const [tip, setTip] = useState<string | null>(null);
  const shownTips = useRef<Set<string>>(new Set());
  const priorityUntil = useRef(0);
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

  // One short page tip per page per session.
  useEffect(() => {
    const tip = PAGE_TIPS[pathname];
    if (!tip || shownTips.current.has(`page:${pathname}`)) return;
    shownTips.current.add(`page:${pathname}`);
    setTip(tip);
    if (tipTimer.current) clearTimeout(tipTimer.current);
    tipTimer.current = setTimeout(() => setTip(null), 6000);
  }, [pathname]);

  const play = useCallback(
    (animation: Animation, priority: keyof typeof PRIORITY) => {
      if (reducedMotion) return;
      if (Date.now() < priorityUntil.current && PRIORITY[priority]! < 3) return;
      if (priority === 'terminal') priorityUntil.current = Date.now() + 4000;
      const result = controller.current?.play(animation);
      if (result && !result.ok && result.error.code === 'unknown_animation') {
        controller.current?.play('idle');
      }
    },
    [reducedMotion],
  );

  const showTip = useCallback((key: string) => {
    const text = TIPS[key];
    if (!text || shownTips.current.has(key)) return;
    shownTips.current.add(key);
    setTip(text);
    if (tipTimer.current) clearTimeout(tipTimer.current);
    tipTimer.current = setTimeout(() => setTip(null), 6000);
  }, []);

  // Pipeline reactions from the run view.
  useEffect(() => {
    function onMascotEvent(e: Event) {
      const detail = (e as CustomEvent<MascotEvent>).detail;
      if (detail.kind === 'stage') {
        const animation = STAGE_ANIMATION[detail.stage];
        if (animation) play(animation as Animation, 'stage');
        if (detail.stage === 'reproduce') showTip('reproduce');
        if (detail.stage === 'fix') showTip('fix');
      } else {
        const animation = STATE_ANIMATION[detail.state];
        if (animation) play(animation as Animation, 'terminal');
        showTip(detail.state);
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

  const hidden =
    broken || !definition || minimised || MASCOT.hiddenRoutes.some((route) => pathname.startsWith(route));

  if (hidden) return null;

  return (
    <div
      className="fixed bottom-3 right-3 z-30 md:bottom-4 md:right-4"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)', paddingRight: 'env(safe-area-inset-right)' }}
    >
      {tip && (
        <div className="mb-2 max-w-[220px] rounded-s border border-border-subtle bg-panel px-3 py-2 text-[12px] leading-snug text-primary shadow-sm">
          {tip}
        </div>
      )}
      <div className="flex items-end gap-1">
        <button
          type="button"
          aria-label={MASCOT.ariaLabel}
          data-animation={controller.current?.getState().activeAnimation ?? 'idle'}
          onClick={() => {
            play('playful', 'mascot');
            setTip(null);
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
        <button
          type="button"
          aria-label="Hide Reel"
          onClick={() => {
            setMinimised(true);
            try {
              localStorage.setItem('replay-mascot-min', '1');
            } catch {
              // storage unavailable
            }
          }}
          className="h-6 w-6 rounded-s text-muted transition-colors duration-150 ease-out hover:text-primary"
        >
          x
        </button>
      </div>
    </div>
  );
}
