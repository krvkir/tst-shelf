# Proposal: remove-companion-patch

## Why

0.2.0 and 0.2.1 built the shelf on two Tree Style Tab features that do not
exist upstream: rows of N whole lines (`lines` on `set-extra-contents`,
capability A3), row-less tabs (the `row-less` tab state, capability B) and a
sidebar size notification (`tabbar-resized`, capability C). They live in an
uncommitted patch to TST (`docs/tst-row-geometry-patch.md`). After testing
them, the maintainer judged them not worth keeping: they double every
row-removal path in the addon, they pin the test suite to a locally patched
TST build, and they cannot ship while TST is installed from AMO.

The addon therefore carries two branches of operation everywhere a row is
taken away, and a user setting (`shelf-layout`) that only chooses between
them. Vanilla TST is the only target that can actually be released.

## What Changes

- **BREAKING**: the addon no longer detects or uses TST capabilities A3/B/C.
  A TST build that carries the patch now behaves exactly like a stock one.
- REMOVED the `shelf-layout` setting and its storage listener. A crowded
  shelf keeps one line and scrolls horizontally, always.
- REMOVED the `lines` parameter from every `set-extra-contents` call, and the
  `tst-shelf-lines` owner state with its multi-line grid stylesheet. A row is
  always one line tall — the uniform-row law again holds unconditionally.
- REMOVED the `row-less` tab state from both of its uses: shelved members are
  always hidden with `browser.tabs.hide()`, and a reveal always suppresses a
  row by hiding the tab. The suppression ledger is one set, not two.
- REMOVED the retry ladder that re-applied a `row-less` state when a sidebar
  rendered the tab anyway, and the `forceRowLessResync` flag that re-sent
  every claim when a sidebar opened late. A browser-level `hidden` cannot be
  dropped by a sidebar import, so neither has a job left.
- REMOVED the patched-TST test rig: `tests/patch-tst.sh`,
  `tests/tst-patched.xpi`, the `e2e-patched` make target, the `--tst` flag of
  the E2E driver, and the four driver blocks that gated on it.
- REMOVED `docs/tst-row-geometry-patch.md` and the
  `add-discrete-row-geometry` change (its two remaining open tasks — the
  upstream PR and a KB note — are dropped with it).
- The observable behaviour of the addon on vanilla TST SHALL NOT change:
  every stock-path code path keeps its current logic, its current ordering
  and its current error handling.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `shelf-nesting`: a member's row is removed by hiding the tab, always;
  "a childless member never has a row, not even while active" becomes "a
  member's row is reclaimed when it is not the active tab and not an
  ancestor of it". The row-presence policy is added as its own
  requirement ("A member's row is absent unless it anchors an expanded
  subtree"); the row-removal retry is removed, because a browser-level
  `hidden` flag cannot be dropped by a sidebar import.

### Deltas not carried, and why
- `companion-capabilities` and `shelf-presentation` carry no deltas here:
  their requirement bases ("A crowded shelf grows its owner's row",
  "The shelf keeps its single-line scrolling form without the
  capability", "The line count follows the sidebar width", the
  capability-detection rules, "Hiding remains the fallback
  presentation") lived in the `add-discrete-row-geometry` change, which
  this change deleted before it was ever archived — there is nothing in
  the spec chain to remove. The one-line scrolling form is the only form
  `add-shelf-foundation` ever specified, and the hiding presentation is
  the one its `shelf-presentation` delta already requires.

## Impact

- `src/background/index.esm.js` (−330 lines): the capability object, the
  sidebar-width map and its two events, `computeShelfLines`, `linesOf`,
  `shelfLines`, `lineOverrides`, `shelfLayoutMode`, `loadSettings`, the
  storage listener, the six geometry constants, the `row-less` halves of
  `reconcileHidden` and `reconcileSuppressed`, `restoreMemberRow`,
  `rowLessByUs`, `rowLessTries`, `suppressedByUs`, `forceRowLessResync`,
  `rowLessDebug`, `rowLessTrace`, and four fields of the internal test API.
- `src/background/render.esm.js` (−13): the injected `linesOf`, the `lines`
  field of the strap ledger, the `tst-shelf-lines` state.
- `src/background/style.esm.js` (−19): CSS rule 3b (the grid layout) and the
  exported `SHELF_GAP_PX`, which loses its second consumer.
- `src/tests-smoke.js` (−20): two capability-split records become
  unconditional.
- `tests/e2e-drive.mjs` (−248), `tests/render.test.mjs` (−17),
  `tests/patch-tst.sh` (−79), `Makefile` (−12), `README.md` (−56),
  `docs/tst-row-geometry-patch.md` (−107), the whole
  `add-discrete-row-geometry` change (−299 plus its specs).
- Untouched: `logic.esm.js` (595), `tst-api.esm.js` (124),
  `tests/logic.test.mjs` (62 tests), `manifest.json` — the `tabHide`
  permission stays, because it becomes the only lever.
