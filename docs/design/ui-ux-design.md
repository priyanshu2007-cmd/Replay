# Replay UI and UX Design

## Principles

1. Evidence before explanation: show the failing frame, the failing test and the diff before any prose. Example: the run view opens with the status pill and the video already seeked to the failure.
2. Color means something or nothing: red only for failing tests, green only for verified passing, amber only for in progress. Example: a reproduced-but-unfixed run is red plus text, never orange.
3. Density with air: information-rich panels, one quiet background, 1px borders instead of shadows. Example: the timeline rows pack stage, model, tokens, cost on one line each.
4. Nothing fake: every number comes from the API or is not rendered. Example: no stats strip exists until /api/stats does.
5. The terminal is a first-class surface: mono type for code, paths, timestamps and model names everywhere. Example: model badges are Geist Mono 12px.
6. Keyboard parity: every flow works without a mouse. Example: Space toggles the video, J and K move between steps.
7. Calm motion only: 150 to 250ms ease-out on state changes; the timeline grows as real events arrive; nothing follows the pointer.

## Tokens

Defined once as CSS variables in `apps/web/app/globals.css` (HSL channels), consumed by Tailwind v4 theme keys. No hex values in components.

Colors (dark, default):
- bg-canvas `hsl(240 10% 3.9%)`, bg-panel `hsl(240 4% 7%)`, bg-raised `hsl(240 4% 10%)`
- border-subtle `hsl(240 4% 14%)`, border-strong `hsl(240 4% 20%)`
- text-primary `hsl(0 0% 98%)`, text-secondary `hsl(240 5% 64.9%)`, text-muted `hsl(240 5% 52%)`
- accent `hsl(172 66% 42%)`, accent-ink (text on accent) `hsl(180 100% 3.9%)`
- fail-fill `hsl(0 72% 51%)` (markers, borders, diff deletions), fail-text `hsl(0 84% 71%)` (small text on dark)
- pass `hsl(142 71% 45%)`, progress `hsl(38 92% 50%)`

Colors (light): canvas `hsl(0 0% 100%)`, panel `hsl(240 5% 98%)`, raised `hsl(0 0% 100%)`, border-subtle `hsl(240 6% 90%)`, border-strong `hsl(240 6% 82%)`, text-primary `hsl(240 6% 10%)`, text-secondary `hsl(240 4% 32%)`, text-muted `hsl(240 4% 40%)`, accent `hsl(172 66% 30%)`, fail-fill `hsl(0 74% 42%)`, fail-text `hsl(0 74% 36%)`, pass `hsl(142 72% 29%)`, progress `hsl(32 95% 38%)`.

Type: Geist Sans / Geist Mono; scale 12, 13, 14, 16, 20, 28, 40; mono for code, paths, timestamps, model IDs, metrics. Tracking is size-specific: 40px display at -0.02em, 28px at -0.01em, everything 20px and below at 0em. Leading: 1.05 at display sizes, 1.45 body.
Spacing: 4px base grid; section padding 24; panel padding 16; gaps 8 and 12.
Radii: 6px small (inputs, pills), 10px medium (panels).
Borders: 1px border-subtle everywhere a surface changes; shadows only for the mascot's speech bubble.
Motion (per the emilkowalski apple-design skill, translated to this product): feedback on pointer-down, never only on release (buttons respond to :active with a 100ms transform). Durations 150ms (hover, focus), 200ms (state changes, status pill color), 250ms (panel expand, timeline row entry). All motion is transform and opacity only, ease-out. No springs and no gesture-driven animation: the only drag surface is the native video scrubber, so no spring library is added. Interruptibility is trivially satisfied because no animation is user-grabbed. Timeline rows enter with a 200ms fade and 4px rise as real events arrive, never before. `prefers-reduced-motion`: all transitions to 0ms, fades become instant state swaps, no idle animations, no mascot motion.
Z-index: header 20, speech bubble 30, toast 40. Nothing higher.

## Component inventory (states)

- Button: primary (accent fill, accent-ink text), secondary (raised bg, border), ghost (transparent, border on hover), destructive (fail-fill). States: default, hover, focus-visible (2px accent ring, offset 2), active (scale 0.98, 100ms, applied on pointer-down), disabled (40% opacity). Labels are verbs that survive out of context: "Run sample", "Copy as GitHub issue", "Download test".
- Input: label above, 1px border, focus ring, error text below in fail color.
- Upload dropzone: dashed border, drag-over accent border, accepts webm/mp4/mov/mkv up to 50MB; client checks size and type; server answer is final.
- Sample card: title, mono bug id, expected behavior line, frame thumbnail from the real recording, one Run button; disabled state when `recordingAvailable` is false.
- Model badge: mono 12px, border, e.g. `nemotron-3-ultra-550b`.
- Stage row: stage name, model badge, status, elapsed, tokens, cost; expandable tool calls; running (amber pulse dot, disabled under reduced motion), done, failed.
- Status pill: FAILING (fail), FIXED (pass), RUNNING (progress), REPRODUCED ONLY, UNREPRODUCED, FAILED (secondary). 28px tall, mono 12px uppercase.
- Code / diff / terminal panels: mono 13px, line numbers, 1px border, no shadows. Diff: standard red/green line backgrounds at 12% alpha.
- Evidence card: two squares side by side (video failure frame via canvas capture, test outcome), verdict sentence, timestamps.
- Toast: bottom-left, panel bg, 1px border, 4s auto-dismiss, manual close.
- Empty state: one sentence of what is missing and one action.
- Error state: what happened, one next action, no stack traces.
- Skeleton: raised bg blocks matching final layout, 150ms opacity pulse, disabled under reduced motion.

## Screen specs

Home `/`: header (wordmark "replay", nav: How it works, Benchmark). Hero left-aligned: promise line at 40px, supporting line 16px secondary, upload zone right of hero at 1440, below at 1280. Sample cards: 3 across at 1440 and 1280, 2 at 768, 1 at 390 and 320. No stats strip (no endpoint), no marketing sections. 1440: hero 2-col 7/5. 768: single column, upload below cards. 390/320: single column, 16px page padding.

Run view `/runs/[id]`: header with back link, run id (mono), status pill right. Three columns at 1440 and 1280: video 4fr, timeline 4fr, code tabs 5fr; evidence card full width below; report last. At 768: stacked video, pill sticky top, timeline, tabs. At 390/320: same stack, 12px padding, tabs scroll horizontally.

Benchmark `/benchmark`: table (mono numbers): run id, sample, state, stage reached, tokens, cost, duration, created. Failure rows stay in the table. Empty state when no runs.

How it works `/how`: pipeline diagram as bordered panels in a row (Ingest through Report) with arrows, then model table (stage, model, job), then the honesty paragraph. No mascot.

## Copy guidelines

Tone: direct, calm, technical. Say what the thing does, with numbers when we have them.

Promise line (chosen): "Drop a bug video. Get a failing test and a verified fix."
Alternatives considered: "Watch it break. Watch it pass." (too clever), "From bug video to verified fix, with the test to prove it." (long).
Supporting line: "Replay watches the recording, writes a Playwright test that fails the same way, patches the code, and proves the fix by running the test again. Runs in a sandbox. Nemotron models on NVIDIA Build."

Banned words (from the master prompt plus our list): revolutionize, supercharge, unleash, seamless, effortless, cutting-edge, next-gen, game-changer, empower, unlock, harness, elevate, "in today's fast-paced world", "say goodbye to", rhetorical triples. No em dashes anywhere. No emoji anywhere.

Errors: name the problem, then the next action. "Could not reach the backend. Check that the API is running, or watch a recorded run instead." Empty: "No runs yet. Start one from a sample."

## Accessibility

Focus: 2px accent ring with 2px offset on every interactive element, never removed. Keyboard map: Tab order follows the DOM; Space play or pause on the video; J and K previous and next step; arrow keys move tab selection. Touch targets at least 44px on primary actions. `aria-live="polite"` only on the final verdict pill. Reduced motion: no pulse, no idle mascot animation, transitions 0ms. Icons are Lucide with `aria-hidden` and always paired with text or an aria-label.
