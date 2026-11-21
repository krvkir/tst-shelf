# Proposal: reveal-folded-owner-branch

## Why

A folded shelf owner shows only its own row with the strap; the shelf is
the folded view of the owner's subtree. Activating a tab from that strap
used to paint the owner's WHOLE subtree: TST reacts to a tab activated
inside a fold by expanding the tab *and all its ancestors*
(`background/handle-tab-focus.js`, `toBeExpandedAncestors`), which is the
right reaction for a plain tree and the wrong one when the ancestor is a
shelf owner — an unshelved sibling of the activated tab appears out of
nowhere (user-reported, 0.2.0).

The user's requirement: "Only the activated child's subtree should be
revealed, the remaining part of the parent's subtree should be kept
folded."

## What changes

When the companion supports row-less tabs, activating a tab inside a
folded shelf owner creates a *reveal* for that owner:

- the owner is expanded (mechanically required — TST renders a child row
  only if every ancestor is expanded), and TST's own over-expansion is
  cancelled;
- every descendant of the owner outside the activated tab's branch loses
  its row through the `row-less` state — the tab stays visible to the
  browser, nothing is hidden;
- the branch is anchored on the owner's DIRECT child that leads to the
  active tab, so a nested shelf's owner keeps its row (its strap lives
  there) and activating a grandchild does not hide its siblings;
- the reveal ends — and the owner is folded back — when the active tab
  leaves the owner's subtree, when the owner is closed, or when the user
  folds the owner themselves.

On a companion without the row-less capability nothing changes: the only
lever that removes a row is `browser.tabs.hide()`, and hiding ordinary
(unshelved) tabs to reshape a tree is not a lever this extension takes.
TST's native expansion stays.

## Impact

- `src/background/logic.esm.js`: `planReveals` (pure), `isSubtreeFolded`,
  `childrenById` in `indexTree`.
- `src/background/index.esm.js`: reveal ledger, the
  `try-expand-tree-from-focused-collapsed-tab` cancellation, the
  suppression reconcile, reveal cleanup on tab/window close.
- `src/manifest.json`: version 0.2.1.
- 10 new unit tests, 5 new E2E assertions.
