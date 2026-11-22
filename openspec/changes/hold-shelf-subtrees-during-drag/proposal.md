# Proposal: hold-shelf-subtrees-during-drag

## Why

Grasping another tab in TST activates it on mousedown, before the browser
reports a drag. The activation immediately folds the previously active
shelved tab and reclaims its row, so its children disappear before the user
can drop a tab into that subtree. Adding a child currently requires taking
the shelved tab off its shelf, performing the drag, and shelving it again.

## What Changes

- A primary-button TST drag temporarily preserves the pre-drag active
  branch: an expanded shelved tab on that branch keeps its row and subtree,
  and an enclosing folded-owner reveal remains effective, until the gesture
  resolves as a click, a canceled drag, or a completed drop.
- A completed drop returns to the ordinary active-tab rules from the fresh
  tree. A drop inside the preserved shelved tab's subtree keeps that subtree
  open because the active dragged tab is now inside it; a drop elsewhere
  folds it. Ordinary non-drag activation behavior is unchanged.
- The same preservation applies when the drag source is a shelf icon, without
  changing the icon's native TST drag, subtree-following, selection, or sticky
  shelving semantics.
- Attachment beneath a shelved tab is recognized from TST's resulting tree
  and `tree-attached` parent payload. A drop onto a folded shelved tab's
  visible regular row uses TST's native attachment and expansion flow, then
  the ordinary derivation keeps the active child's ancestor branch visible.
- Direct drops onto an inactive folded member's favicon are not added: that
  member has no row, and stock TST 4.4.10 resolves the favicon's drop target
  to the containing owner row without notifying the companion of the icon
  target. Supporting that gesture needs a separate upstream API or UX design.
- No shelved-state persistence, manifest permission, host permission, TST
  tree-data edit, or companion TST patch is added.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- **shelf-nesting**: adds a bounded drag exception to immediate folding on
  unrelated activation, defines click/cancel/drop cleanup and post-drop
  visibility, preserves nested reveals during the gesture, and defines the
  result of attaching an active dragged tab beneath a folded shelved tab.

## Impact

- `src/background/logic.esm.js`: pure planning for the union of the live and
  preserved active branches, including reveal suppression and pruning.
- `src/background/index.esm.js`: provisional mousedown state, TST drag and
  mouseup notifications, drop-settling and cleanup, and guards for the direct
  fold/hide operations used by shelf-icon selection.
- `src/background/tst-api.esm.js`: no expected client changes; new event
  handlers must return explicit booleans where TST interprets a response as
  cancellation.
- `tests/logic.test.mjs`: branch-union, reveal-lifetime, and post-drop planner
  cases.
- `tests/e2e-drive.mjs`, `src/tests-smoke.js`, and any focused probe needed:
  browser-measured mousedown/drag/drop ordering, ordinary-row and shelf-icon
  sources, drops inside and outside the preserved subtree, cancellation,
  plain clicks, non-drag activation, nested reveals, and folded-parent drops.
- `README.md`: document the drag behavior, measured event ordering, and the
  remaining folded-favicon limitation.
- Release classification: bug fix; record and implement version **0.6.5**
  (from 0.6.4) in `src/manifest.json` and `package.json` together. The second
  version number does not change.
