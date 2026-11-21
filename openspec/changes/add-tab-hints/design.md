# Design: add-tab-hints

## Context

Four TST surfaces, verified against the 4.4.10 sources, carry the whole
feature:

1. `extra-contents-keydown` / `-keyup`: TST forwards key events whose
   target sits inside an addon's extra contents (a document-level
   capture listener, sidebar/tst-api-frontend.js:801, 866–880), with
   `key`, `repeat`, modifiers, the target's HTML and its `targetPart`.
   TST's sidebar has NO other keydown listener — typed letters are
   otherwise unclaimed.
2. `focus-to-extra-contents` (`{windowId, place, part}`): calls
   `node.focus()` on the first node with that `part` (tst-api-frontend.js:
   761–772). Combined with (1): focus a `tabindex="0"` span we render,
   and every keypress lands inside our `.extra-item`, so TST routes it
   to us. DOMPurify's default attribute whitelist keeps `tabindex`.
3. `tabs-rendered` / `tabs-unrendered` (`messages: {tabs: [...]}`,
   sidebar-items.js): the rendered set of the virtual-scrolled tab bar
   is trackable from the background; `tabs-unrendered` is broadcast
   only to subscribers.
4. `set-extra-contents` with `place: "tab-above"`: a per-row label
   channel, the same mechanism the straps ride.

## Goals / Non-Goals

- Goal: one command, deterministic codes, zero geometry change.
- Goal: mode state is runtime-only, per window — no persistence, no
  boot-release path (nothing hides a tab; only overlays and focus).
- Non-goal: scrolling off-viewport rows into view to give them codes;
  codes cover the visible set only, exactly like Vimium's hints cover
  visible links.
- Non-goal: hint codes in the native tab bar or in a closed-sidebar
  state; the sidebar is the only surface.

## Decisions

1. **The key catcher.** An invisible `tabindex="0"` span with
   `part="shelf-keycatcher"` rides in the root strap's `tabbar-top`
   contents. The root strap therefore becomes ALWAYS-present: an empty
   root shelf writes the catcher alone, styled zero-size (width/height
   0, opacity 0 — `display: none` would make `node.focus()` a no-op).
   The existing "an empty root shelf reserves no space" requirement
   stays the contract; the E2E keeps asserting it.
2. **Mode confirmation, not trust.** `commands.onCommand` starts the
   mode and calls `focus-to-extra-contents` for the focused window; the
   mode is CONFIRMED by the catcher's `extra-contents-focus` event. No
   confirmation within a bounded timeout (closed sidebar, TST refused)
   ends the mode before any labels are written — the spec's no-op
   scenario.
3. **Codes are a pure derivation.** `assignHints(visibleIds, charset)`
   in logic.esm.js: the visible set in tree-walk order (`treePositions`
   — the same order the straps render in), a fixed letter charset,
   length grows only when the count demands it; unit-tested, and the
   350-tab perf gate re-runs with assignment added to the pass.
4. **Row labels ride `tab-above`, tracked by the rendered set.** The
   ledger of rendered rows comes from `tabs-rendered` /
   `tabs-unrendered`; the mode writes one `set-extra-contents` per
   rendered row (bounded by the viewport, ~30–50 messages) and clears
   them on exit or viewport change. Two uniform-row traps, both
   load-bearing rules: labels paint `position: absolute` (out of flow),
   and `SHELF_STYLE` gains the `#dummy-tab .extra-items-container.above
   { display: none }` twin of the existing below-rule — the dummy tab
   mirrors extra contents and would inflate every row otherwise.
5. **Key consumption follows the narrow-cancellation rule.** The
   `extra-contents-keydown` handler answers truthy ONLY while the mode
   is active and the key belongs to the mode (letters, Backspace,
   Escape); everything else falls through to TST. The donor client's
   boolean-passthrough deviation carries the verdict.
6. **The E2E drives the whole chain headlessly.** Phase 2 opens TST's
   sidebar page in a tab already; the smoke page enters the mode
   through a test hook (the native command is a trusted event, like
   native menu delivery), the driver dispatches synthetic keydowns on
   the catcher (the same `WebDriver:ExecuteScript` route the icon
   mousedowns use), and the activation choreography reuses the existing
   icon-click assertion block. Native command delivery is verified once
   on a GUI `make iso-tst` run and documented like menu delivery.

## Risks / Trade-offs

- [Another addon listens to `extra-contents-keydown` too] → we answer
  truthy only for keys the mode consumed; a competing addon sees the
  same event regardless (TST broadcasts before the verdict).
- [Mode left active by a lost focus event] → three exits overlap:
  Escape, the catcher's `blur` (a bulk type), and the confirmation
  timeout; the window-close cleanup drops the state with the window.
- [Viewport churn re-labels rows mid-typing] → a reassignment keeps the
  buffer; codes that no longer match the new set simply hide, and a
  stale complete match activates nothing.

## Open Questions

- The default key binding is picked at implementation time to avoid
  Firefox's reserved combinations (and is user-rebindable through
  about:addons regardless).
- Whether to cap code length at two letters with prefix disambiguation
  beyond, or grow to three; the pure planner decides and the unit test
  pins it.
