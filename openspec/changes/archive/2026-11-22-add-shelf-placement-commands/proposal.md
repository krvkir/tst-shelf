# Proposal: add-shelf-placement-commands

## Why

Shelf order is a decision the user cannot revise: icons land in put order
(newest last), and taking a tab off the shelf and re-shelving it is the
only way to move it — which also resets the tab's pre-shelve place record.
Pointer-drag reorder inside the strap is not implementable through the
stock TST external API (measured against the TST 4.4.10 sources: extra
contents receive no drag notifications at all, and no mousedown or
mousemove payload carries coordinates), so an explicit command surface is
the available interim.

## What Changes

- A "Shelf" submenu in the tab context menu, visible only for shelved
  tabs, holding two commands: "Place leftmost" and "Place rightmost".
- "Place leftmost" moves the tab to the first position of its shelf's
  member block; "Place rightmost" moves it to the last. Both move only the
  member's own slot in the block: the block stays contiguous, the tab's
  subtree follows it, and every other tab keeps its relative order.
- The commands appear wherever the tab's context menu appears — the TST
  sidebar row menu, the shelf icon's own right-click menu, and the native
  tab bar menu — because they are the extension's own `browser.menus`
  items with `contexts: ["tab"]`, the same route as "Put on shelf" /
  "Take off the shelf".
- Pointer-drag reorder is explicitly deferred until TST offers a drag
  surface for extra contents; recorded in the README as the follow-up
  condition.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- **shelf-pinning**: adds a requirement for the "Shelf" submenu and its
  two placement commands, with the same block-only movement guarantees
  the placement rules already carry.

## Impact

- `src/background/logic.esm.js`: a pure planner for the extreme-slot move
  (one `move-before` / `move-after`-plus-`outdent` plan per call).
- `src/background/index.esm.js`: the submenu's items, `menus.onShown`
  visibility, `menus.onClicked` routing, the apply-through-TST-moves step.
- `tests/logic.test.mjs`: planner cases; `tests/e2e-drive.mjs` +
  `src/tests-smoke.js`: menu telemetry through the `test:menu-shown` hook
  and the applied move.
- No manifest or permission changes.
