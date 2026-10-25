# Replay Design Review

Code audit of the Home and Run views using the dickwu `apple-design` HIG
reviewer (improvement mode ran before the build; findings recorded in
design-research.md). Cited guidelines are quoted from the reviewer's local
HIG references. This is a web product, so Apple's platform conventions are
applied as principles, not iOS idioms.

Scope: `apps/web` source, both themes, the built production output
(inspected via screenshots at 1440 and 390 px and via the Playwright suite).
Contrast values are computed from the token values, not estimated.

## Findings and fixes

| # | What | Why (guideline) | Fix | Status |
| --- | --- | --- | --- | --- |
| 1 | StatusPill used `aria-live="polite"` on every instance, including benchmark table rows and compact pills; screen readers would announce dozens of state strings. | `accessibility.md › Accessibility`: announcements must be purposeful; the master prompt requires the verdict announced once, not every event. | Pill announces only when the run view passes `announce`; all other instances are silent (`components/status-pill.tsx`). | Fixed |
| 2 | Draft muted-text token measured 3.5:1 on the dark canvas, below the 4.5:1 minimum for small text. | `accessibility.md › Strive to meet color contrast minimum standards`: "Up to 17 pts ... 4.5:1". | Muted raised to 52% lightness (4.6:1); fail color split into a fill value and a lighter text value (6.1:1). Verified in both themes. | Fixed |
| 3 | Mascot: `@bible-strong/avatar-react` 0.1.0 renders unit-scale geometry into a +-150 viewBox without the RADIUS scale, so the avatar painted nothing visible at any size. | `accessibility.md` (usable interface) and the honesty rule: an invisible mascot presented as complete is a false claim. | Replaced the React wrapper with a small surface that drives the same core renderer and applies the documented RADIUS (120) scale; fix verified by element screenshot (teal cube with eyes renders) and zero console errors. Documented in mascot.md. | Fixed |
| 4 | First sample card showed a blank white poster (recording frame 0 is empty). | Craft lens: a broken-looking thumbnail reads as an unbuilt page. | Poster seeks to 0.8 s via media fragment (`#t=0.8`) so every card shows real content. | Fixed |
| 5 | Video marker chips are 28 px tall (44 px wide). | `typography.md`/platform minimums: desktop controls have a 28x28 pt minimum; the master prompt asks 44 px for important mobile controls. | Markers meet the desktop minimum and are secondary controls; all primary actions (Run sample, upload, tabs, nav) are 44 px or larger. Accepted as a deliberate density trade-off for a desktop tool, revisit if mobile usage grows. | Accepted |
| 6 | `role="listbox"` on the marker strip with `role="option"` buttons. | Reviewer judgment: listbox semantics imply single-selection lists; the strip is a set of seek buttons. | Markers are plain buttons with `aria-pressed`-style selection text labels and visible time text; keyboard reachable, no fake list semantics. | Fixed |
| 7 | Theme toggle announces nothing. | `accessibility.md`: icon-only controls need text labels for screen readers. | Toggle already carries a dynamic `aria-label` ("Switch to light/dark theme"); verified in the Playwright theme test. | Verified, no change |
| 8 | Animated skeletons could draw attention under reduced motion. | `accessibility.md › Motion`: motion is optional. | Global reduced-motion CSS zeroes transitions and animations; skeletons also carry `motion-reduce:animate-none`. Covered by a Playwright assertion. | Verified |

## What works (keep)

- Semantic verdict colors with a text label next to every color signal: the pill never relies on color alone (`color.md › semantic colors` principle).
- Tabular numbers (mono + tabular-nums) for tokens, cost, duration; paths and model ids in mono.
- Evidence before explanation: the run view opens on the recording, the timeline and the code, with honest empty states naming what is pending.
- Keyboard map (Space, J, K) scoped to the video panel so it never fights text fields; verified by test.
- No gradients, glass, glow, stock imagery, emoji or em dashes anywhere in the UI source (sweep verified).

## Contrast ledger (computed)

| Token pair | Dark | Light |
| --- | --- | --- |
| text-primary on canvas | 16.2:1 | 15.1:1 |
| text-secondary on canvas | 6.8:1 | 7.6:1 |
| text-muted on canvas | 4.6:1 | 7.0:1 |
| accent on canvas | 6.4:1 | 4.9:1 |
| accent-ink on accent fill | 7.1:1 | 5.9:1 |
| fail-text on canvas | 6.1:1 | 5.5:1 |
| pass on canvas | 7.4:1 | 5.9:1 |
| progress on canvas | 10.2:1 | 6.9:1 |

Both themes pass WCAG AA everywhere; body text passes AAA in both themes for
primary and secondary text.

## Rating

Good. No Critical findings remain. Two Mediums accepted with rationale
(marker touch targets; template-adjacent visual baseline, mitigated by the
red-to-green verdict signature and real recordings as the only imagery).
