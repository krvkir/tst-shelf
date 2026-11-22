# Design: show-sound-state-on-shelf-icons

## Context

`tabs.onUpdated` delivers `audible` / `mutedInfo` changes, and the
background already schedules a re-derivation for any change on a shelved
tab (the `shelved.has(tabId)` branch of the listener), so the diffing
renderer re-sends the strap when the state flips — no new event wiring.
Two mechanics need decisions: the glyph (the strap has no network access;
favicons already ride in `style` attributes; a plain data-URL
`background-image` cannot inherit the theme's text color) and the click
routing (`extra-contents-mousedown` carries `targetPart`, cleaned of the
addon suffix by TST — `cleanupExtraContentsPartName`,
sidebar/tst-api-frontend.js).

## Goals / Non-Goals

- Goal: two indicator states — playing, muted — in the theme's text
  color.
- Goal: click-to-toggle-mute on the indicator, pinned-tab parity.
- Non-goal: per-tab volume, the autoplay-blocked state, or a third
  "blocked" glyph; two states cover the shelf's need.

## Decisions

1. **Mask-image glyph with `currentColor`.** The speaker and
   speaker-with-slash glyphs are data-URL SVGs applied through
   `mask-image` + `background-color: currentColor`; they follow the
   theme with no loaded resource. A `background-image` data URL cannot
   inherit `currentColor` — that is why the mask, not the image. The
   attribute lives in `iconHtml`'s `style`, the same sanitization route
   the favicons already survive (README: the favicon route).
2. **Corner budget.** The fold badge owns the inline-end bottom corner
   (SHELF_STYLE rule 6); the audio indicator takes the inline-start
   bottom corner. Both are `position: absolute` inside the icon cell —
   no layout effect, no row-height effect, no uniform-row risk.
3. **Click routing by `targetPart`.** The indicator is a span with
   `part="shelf-sound"`; the mousedown handler branches on
   `originalTargetPart` BEFORE the icon's `data-tab-id` selection path:
   primary click → `browser.tabs.update(tabId, { muted: !muted })`,
   return true (cancel — the owner row must not activate). Every other
   part of the icon keeps the existing select/close paths untouched.
4. **The muted state is testable headlessly; audible is not.** The probe
   (tests/probe-favicon.mjs) settled it: headless Firefox 158 reports
   `audible: false` while a `<audio autoplay loop>` page plays, while
   `mutedInfo.muted` flips arrive immediately. So the E2E asserts the
   muted indicator and the glyph click-to-mute; the playing indicator
   rides the unit tests plus a manual `make iso-tst` pass, and the
   README records the measurement.

## Risks / Trade-offs

- [Headless audio reporting measured `audible: false`] → resolved: the
  muted path carries the E2E coverage; the playing glyph rides unit
  tests and a manual `make iso-tst` pass (README records it).
- [The glyph ships as inline CSS] → the E2E sidebar phase asserts the
  `mask-image` rule survived DOMPurify, pinning the route.

## Open Questions

- None. (The headless `audible` question is answered by the probe:
  false on Firefox 158.)
