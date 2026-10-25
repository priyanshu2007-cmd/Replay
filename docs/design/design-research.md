# Replay Design Research

## Tools studied and the lesson taken from each

1. **Linear.** Issue lists stay readable at high density because hierarchy comes from type weight and gray level, never color. Lesson: neutral grays carry 90% of the UI; color only means something.
2. **Vercel dashboard.** Deployment states (Building, Ready, Error) are tiny status pills with one hue each and a plain label. Lesson: a status pill is text plus a dot, not a banner.
3. **Sentry.** The issue page leads with the failure evidence (stack, events) above any explanation. Lesson: put the evidence card next to the verdict, never below the fold.
4. **Raycast.** One accent color (red-orange) used so consistently that the product is recognizable from a screenshot of any button. Lesson: exactly one accent, everywhere the same.
5. **Playwright Trace Viewer.** A scrubber with numbered step markers and a red failure marker; J/K or click jumps between steps. Lesson: copy this interaction model directly, it is what our users already know.
6. **GitHub.** Diff and code views are monospace at 12 to 13px with a 1px border and no shadows. Lesson: thin borders over shadows; code panels never decorated.

## What to avoid

The product bans (master prompt section 2) map to concrete failures seen on generated sites: purple gradients and glassmorphism read as template; stock or AI imagery breaks trust in a product whose whole claim is "real evidence"; fake counters and testimonials contradict the honesty rule; hero text tricks (typewriter, rotating words) read as ad-tech. Replay's identity is forensic: a scrubber, a timeline, a verdict.

## Accent color decision

Teal `hsl(172 66% 42%)` (dark theme) / `hsl(172 66% 30%)` (light theme).

- Not purple (banned), not red or green (reserved for test results), not amber (reserved for in-progress). Teal is the neutral: it never competes with the verdict colors, which carry the product's signature moment.
- Computed contrast (WCAG, against the tokens in ui-ux-design.md):
  - Accent on dark canvas `#09090b`: 6.4:1. Passes AA for all text, AAA for large text.
  - Accent on white (light theme value): 4.9:1. Passes AA.
  - Accent-ink text on accent fill: 7.1:1. Passes AA.
  - Text-primary on dark canvas: 16.2:1. Text-secondary: 6.8:1. Text-muted (52% lightness, corrected from an earlier 45% draft that measured 3.5:1): 4.6:1.
- Used for: primary buttons, focus rings, links, the active timeline stage, the scrubber playhead.

## Design review (improvement mode, before build)

Run with the dickwu `apple-design` HIG reviewer in improvement mode plus the emilkowalski `apple-design` motion skill, per the master prompt. Findings on the initial plan:

- High, craft lens: "near-black, one accent, Geist" is itself a current template default. Accepted with a mitigation: the template risk is answered by the signature element (the red to green verdict with real video frames, which no generic tool has) and by real bug recordings as the only imagery. The rest of the surface stays deliberately quiet; that is the design's stated point of view, and the quiet utility is named as such rather than disguised.
- High, accessibility: three token values failed computed contrast in the first draft. Fixed: muted gray raised from 45% to 52% lightness (3.5:1 to 4.6:1), red split into a fill value for markers and a lighter text value for small text (fill red measured 3.95:1 on dark, text red measures 6.1:1), green text verified at 7.4:1, amber at 10.2:1.
- Medium, typography: tracking was unspecified. Fixed: size-specific tracking per the motion skill's typography rules, negative on display sizes, zero at body.
- Medium, writing: sample card action label normalized to "Run sample" so the verb survives out of context; status pill labels locked to the API's run state vocabulary.
- Medium, motion: no gesture-driven surface exists in Replay (the only drag is the native video scrubber), so no spring library is added; all motion is 100 to 250ms ease-out on transform and opacity, feedback on pointer-down, cross-fade only under reduced motion.

## Font decision

Geist Sans for UI, Geist Mono for code, timestamps, file paths and model badges.

- Not Inter (overused in generated UI). Geist is built for developer tools, ships as a first-class Next.js font package with no layout shift, and has a matching mono with tabular figures for the timeline counters.
- Scale: 12 (mono micro), 13 (UI small), 14 (UI base), 16 (body), 20 (section), 28 (page), 40 (hero). Two weights do the work: 400 and 500 for UI, 600 for headings.

## Mascot references

Grok's ball bot and ChatGPT-style bot avatars work because: one simple silhouette (circle or soft square), two large high-contrast eyes, no mouth or a minimal one, slow blink and breathe only. Motion is calm even when the state is "working". See mascot.md for the spec.
