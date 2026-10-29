# Replay Mascot: Reel

## Identity

Name: Reel (film reel, replay). Personality: a calm, observant debugging buddy. It watches the pipeline with you and reacts to evidence, never to hype.

Shape and colors: soft cube (Cubee-style starter family) in the accent teal, two large high-contrast eyes (near-black on teal), no mouth. Size 104px desktop, 80px mobile, fixed bottom-right, never overlapping the status pill, Monaco panels, upload button or the video scrubber (safe-area aware).

## Animation map (validated against the avatar definition at load)

| App state | Animation |
| --- | --- |
| Page load | waking then idle |
| Watch stage | listening |
| Locate stage | searching |
| Reproduce stage | working |
| Test FAILING (expected red) | thinking |
| Verify stage | curious |
| Fix stage | working |
| Run FIXED | celebrate once, then idle |
| Cannot reproduce or fix fails | confused |
| 30s inactivity | drowsy then sleeping |
| Click on mascot | playful |

Only animations present in the exported avatar file are ever requested; the controller validates names at load and falls back to idle.

Speech bubble: at most one short factual tip per stage per session, e.g. "This red test is good news: it proves the bug." Never over controls. No emoji, no em dashes.

Reduced motion: still pose, no reactions, bubble still allowed on click.

## Implementation status

Reel is implemented and renders. The avatar definition
(`apps/web/components/mascot/avatar.avatar.json`) was written programmatically
against the published JSON schema (no Studio export was needed) and is
validated at module load with `validateAvatarDefinition` from
`@bible-strong/avatar-core`; an invalid definition disables the mascot rather
than rendering a broken character.

Rendering: `@bible-strong/avatar-core` 0.1.0 drives playback and produces
every frame (its `renderAvatarFrame` computes all geometry and colors). A
small Replay-owned SVG surface (`components/mascot/AvatarSurface.tsx`) applies
the frames to SVG paths and adds the documented `RADIUS` (120) scene scale.
The official `@bible-strong/avatar-react` 0.1.0 wrapper was evaluated and
removed: it renders the core's unit-scale geometry into a plus/minus 150
viewBox without the scale transform, so the avatar paints sub-pixel and stays
invisible at any size (verified with getBBox and element screenshots before
the replacement was written).

Verified live behavior: waking plays on load and hands off to idle;
stage events map to listening, searching, working, curious and thinking;
terminal states map to celebrate (then happy) and confused; 30 s of
inactivity runs drowsy then sleeping and any activity wakes Reel; clicking
plays playful once. Only animation names present in the definition are ever
requested; unknown names fall back to idle. Reduced motion renders one static
neutral frame with no reactions. All timers, listeners and the animation loop
are cleaned up on unmount.

License note: `@bible-strong/avatar-core` is AGPL-3.0-only. Replay is MIT.
The integration and obligations are recorded in THIRD_PARTY_NOTICES.md.
