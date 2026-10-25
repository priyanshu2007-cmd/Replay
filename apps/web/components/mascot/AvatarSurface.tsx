'use client';

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import {
  advanceAvatarPlayback,
  createAvatarPlaybackState,
  playAvatarAnimation,
  renderAvatarFrame,
  resolveAnimation,
  resolveExpression,
  RADIUS,
  type AvatarCommandResult,
  type AvatarDefinition,
  type AvatarPlaybackState,
  type AvatarRuntimeError,
} from '@bible-strong/avatar-core';

/**
 * SVG surface for the avatar definition, driven by @bible-strong/avatar-core's
 * own playback and frame renderer.
 *
 * Why this exists: @bible-strong/avatar-react 0.1.0 renders the core's
 * unit-scale geometry into a viewBox of +-150 without the RADIUS (120) scene
 * transform, so the avatar paints sub-pixel (verified: getBBox 0.3 units
 * inside a 300-unit viewBox, nothing visible at any size). This surface keeps
 * the library's renderer and playback math and adds the missing scale only.
 */

export interface AvatarSurfaceHandle {
  play: (animation: string) => AvatarCommandResult<AvatarPlaybackState>;
  setExpression: (expression: string) => AvatarCommandResult<AvatarPlaybackState>;
  stop: () => void;
  getState: () => { activeAnimation?: string; activeExpression: string; status: string };
}

interface Props {
  definition: AvatarDefinition;
  defaultAnimation?: string;
  defaultExpression?: string;
  reducedMotion?: boolean;
  size?: number;
  ariaLabel?: string;
  onAnimationEnd?: (animation: string) => void;
  onError?: (error: AvatarRuntimeError) => void;
}

const STROKE = 0.04;

export const AvatarSurface = forwardRef<AvatarSurfaceHandle, Props>(function AvatarSurface(
  { definition, defaultAnimation, defaultExpression, reducedMotion = false, size = 104, ariaLabel, onAnimationEnd, onError },
  ref,
) {
  const svgRef = useRef<SVGSVGElement>(null);
  const headOuterRef = useRef<SVGPathElement>(null);
  const headRef = useRef<SVGPathElement>(null);
  const leftEyeRef = useRef<SVGPathElement>(null);
  const rightEyeRef = useRef<SVGPathElement>(null);
  const backRefs = useRef<Array<SVGPathElement | null>>([]);
  const frontRefs = useRef<Array<SVGPathElement | null>>([]);

  const stateRef = useRef<AvatarPlaybackState>(createAvatarPlaybackState());
  const rafRef = useRef<number>(0);
  const lastAnimationRef = useRef<string | undefined>(undefined);
  const endedRef = useRef<Set<string>>(new Set());

  const env = useMemo(
    () => ({ random: Math.random, reduceMotion: reducedMotion }),
    [reducedMotion],
  );

  const nodeCount = definition.body.nodes.length;

  function applyFrame(now: number) {
    const frame = renderAvatarFrame(definition, stateRef.current, now, env);
    const g = frame.geometry;
    headOuterRef.current?.setAttribute('d', g.headPath);
    headRef.current?.setAttribute('d', g.headPath);
    headRef.current?.setAttribute('fill', frame.colors.body);
    leftEyeRef.current?.setAttribute('d', g.leftPath);
    leftEyeRef.current?.setAttribute('fill', frame.colors.eyes);
    leftEyeRef.current?.setAttribute('opacity', g.leftVisible ? '1' : '0');
    rightEyeRef.current?.setAttribute('d', g.rightPath);
    rightEyeRef.current?.setAttribute('fill', frame.colors.eyes);
    rightEyeRef.current?.setAttribute('opacity', g.rightVisible ? '1' : '0');
    backRefs.current.forEach((el, i) => {
      el?.setAttribute('d', g.backPaths[i] ?? '');
      el?.setAttribute('fill', frame.colors.body);
    });
    frontRefs.current.forEach((el, i) => {
      el?.setAttribute('d', g.frontPaths[i] ?? '');
      el?.setAttribute('fill', frame.colors.body);
    });
    return frame;
  }

  function startLoop() {
    cancelAnimationFrame(rafRef.current);
    const tick = () => {
      const before = stateRef.current;
      stateRef.current = advanceAvatarPlayback(definition, stateRef.current, performance.now(), env);
      applyFrame(performance.now());
      // A once/pingPong animation that finished: core marks it stopped.
      if (
        before.activeAnimation &&
        stateRef.current.status === 'stopped' &&
        before.status === 'playing' &&
        !endedRef.current.has(before.activeAnimation)
      ) {
        endedRef.current.add(before.activeAnimation);
        onAnimationEnd?.(before.activeAnimation);
      }
      if (stateRef.current.status !== 'stopped') {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  }

  // Initial frame: reduced motion gets one static neutral frame; otherwise
  // start the default animation (or show the default expression statically).
  useEffect(() => {
    endedRef.current.clear();
    if (reducedMotion) {
      const resolved = defaultExpression ? resolveExpression(definition, defaultExpression) : null;
      if (resolved && !resolved.ok) onError?.(resolved.error);
      const exprKey = resolved?.ok ? defaultExpression! : 'neutral';
      stateRef.current = { ...createAvatarPlaybackState(), activeExpression: exprKey, status: 'stopped' };
      applyFrame(performance.now());
      return;
    }
    if (defaultAnimation) {
      const resolved = resolveAnimation(definition, defaultAnimation);
      if (resolved.ok) {
        const played = playAvatarAnimation(definition, defaultAnimation, performance.now());
        if (played.ok) {
          lastAnimationRef.current = defaultAnimation;
          stateRef.current = played.value;
          startLoop();
        }
      } else {
        onError?.(resolved.error);
        stateRef.current = { ...createAvatarPlaybackState(), activeExpression: 'neutral', status: 'stopped' };
        applyFrame(performance.now());
      }
    } else {
      stateRef.current = { ...createAvatarPlaybackState(), activeExpression: defaultExpression ?? 'neutral', status: 'stopped' };
      applyFrame(performance.now());
    }
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [definition, defaultAnimation, defaultExpression, reducedMotion]);

  useImperativeHandle(ref, () => ({
    play(animation: string) {
      endedRef.current.clear();
      const resolved = resolveAnimation(definition, animation);
      if (!resolved.ok) return resolved;
      const played = playAvatarAnimation(definition, animation, performance.now());
      if (played.ok) {
        lastAnimationRef.current = animation;
        stateRef.current = played.value;
        startLoop();
      }
      return played;
    },
    setExpression(expression: string) {
      const resolved = resolveExpression(definition, expression);
      if (!resolved.ok) return resolved;
      endedRef.current.clear();
      cancelAnimationFrame(rafRef.current);
      stateRef.current = { ...createAvatarPlaybackState(), activeExpression: expression, status: 'stopped' };
      applyFrame(performance.now());
      return { ok: true, value: stateRef.current };
    },
    stop() {
      cancelAnimationFrame(rafRef.current);
      stateRef.current = { ...createAvatarPlaybackState(), activeExpression: 'neutral', status: 'stopped' };
      applyFrame(performance.now());
    },
    getState() {
      const s = stateRef.current;
      return { activeAnimation: s.activeAnimation, activeExpression: s.activeExpression, status: s.status };
    },
  }));

  return (
    <svg
      ref={svgRef}
      viewBox="-150 -150 300 300"
      width={size}
      height={size}
      role="img"
      aria-label={ariaLabel}
      className="block overflow-visible"
    >
      {/* Core renders body-unit geometry; the scene scale (RADIUS) is applied here. */}
      <g transform={`scale(${RADIUS})`}>
        {Array.from({ length: nodeCount }).map((_, i) => (
          <path key={`b${i}`} ref={(el) => { backRefs.current[i] = el; }} stroke="none" />
        ))}
        <path ref={headOuterRef} fill="none" stroke={definition.colors.body} strokeWidth={STROKE} strokeLinejoin="round" />
        <path ref={headRef} stroke="none" />
        {Array.from({ length: nodeCount }).map((_, i) => (
          <path key={`f${i}`} ref={(el) => { frontRefs.current[i] = el; }} stroke="none" />
        ))}
        <path ref={leftEyeRef} stroke="none" />
        <path ref={rightEyeRef} stroke="none" />
      </g>
    </svg>
  );
});
