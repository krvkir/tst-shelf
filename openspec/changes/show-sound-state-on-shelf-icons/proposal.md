# Proposal: show-sound-state-on-shelf-icons

## Why

A shelved tab's icon is its whole presentation, so audio state is invisible
on a shelf: a background tab playing sound shows nothing, and the user
finds it by muting tabs one by one. Pinned tabs carry this natively; the
strap has no equivalent.

## What Changes

- A sound indicator on the shelf icon while the tab plays audio, and a
  muted indicator while the tab is muted — both in the active theme's text
  color, both loading no network resource.
- Clicking the indicator toggles the tab's muted state — the speaker on a
  pinned tab — instead of activating the tab; clicking the icon elsewhere
  selects the tab as before.
- The favicon stays visible: the indicator is a corner badge, not a
  replacement. On a strap of lookalike favicons identity beats state.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- **shelf-presentation**: adds a requirement for the sound/muted
  indicator on the shelf icon.
- **shelf-interaction**: adds a requirement routing primary clicks on the
  indicator to the mute toggle.

## Impact

- `src/background/render.esm.js`: the indicator span in `iconHtml`
  (unit-tested in `tests/render.test.mjs`).
- `src/background/style.esm.js`: the badge corner rules (mask-image
  glyph, `currentColor`).
- `src/background/index.esm.js`: the `extra-contents-mousedown` branch
  on the indicator's `targetPart` → `browser.tabs.update({muted})`.
- `tests/e2e-drive.mjs` + `src/tests-smoke.js`: a headless-audio probe
  and the indicator assertions; README caveat.
- No new permissions: `tabs` already covers `audible` / `mutedInfo`.
