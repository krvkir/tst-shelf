# Tasks: reveal-folded-owner-branch

## 1. Pure derivation

- [x] 1.1 `indexTree` exposes `childrenById` (subtree walks without another pass)
- [x] 1.2 `isSubtreeFolded` accepts both measured fold markers (`subtree-collapsed`, `collapsed`)
- [x] 1.3 `planReveals` returns the ids to suppress plus the owners whose reveal must end
- [x] 1.4 branch anchored on the owner's direct child, not on the active tab
- [x] 1.5 `mustShow` ids are never suppressed
- [x] 1.6 unit tests: 12 cases (branch, sibling suppression, branch follows the active tab, leaving the subtree, owner activated, user fold, expansion in flight, closed owner, animation protection, nested reveals, fold markers)

## 2. Background wiring

- [x] 2.1 reveal ledger per window/owner, cleaned on tab and window close
- [x] 2.2 cancel `try-expand-tree-from-focused-collapsed-tab` only when a reveal takes over
- [x] 2.3 expand the owner and the activated tab ourselves (`expand-tree`)
- [x] 2.4 `reconcileSuppressed` applies `row-less` to the suppression set and lifts it again
- [x] 2.5 `suppressHold` for the length of TST's collapse animation
- [x] 2.6 `endReveal` folds the owner back
- [x] 2.7 gate everything on the row-less capability; a stock companion is untouched
- [x] 2.8 re-apply after `sidebar-show` (a late-opened sidebar misses addon states)

## 3. Verification

- [x] 3.1 E2E: a folded owner renders no rows for its subtree
- [x] 3.2 E2E: after clicking the shelf icon the branch has rows and the unshelved sibling has none
- [x] 3.3 E2E: the sibling is suppressed through `row-less`, never hidden
- [x] 3.4 E2E: clicking a nested shelf member keeps the nested owner's row
- [x] 3.5 E2E: leaving the owner's subtree ends the reveal and folds it back
- [x] 3.6 full suite green on the patched companion (96 assertions) and on the stock one (80)

## 4. Documentation

- [x] 4.1 spec delta on `shelf-nesting`
- [x] 4.2 design notes with the measured fold-marker trap
- [x] 4.3 README caveat
- [x] 4.4 upstream: mention the reveal rule in the row-geometry proposal (a helper-facing note, no API change needed). Resolution: superseded — the row-geometry proposal was deleted together with the patched-TST support (remove-companion-patch, task 7.3).

## 5. Stock-companion support (0.2.2)

- [x] 5.1 reveal works without the row-less capability: siblings removed with the tab-hide API
- [x] 5.2 `suppressedHiddenByUs` ledger, kept out of `hiddenByUs` so the member reconcile cannot show them
- [x] 5.3 session bit `tst-shelf-suppressed`, read at boot only for hidden tabs; stale ones shown
- [x] 5.4 `suppressHold` covers the hidden path too (no flash while the owner folds)
- [x] 5.5 row-removal retry driven by `tabs-rendered`, bounded per tab
- [x] 5.6 E2E runs the reveal block on both companions, capability-split assertions (98 patched / 90 stock), three consecutive runs each
- [x] 5.7 window-scoped ledger cleanups (a foreign window's pass stripped them)
- [x] 5.8 active tab re-read before the anchor decision (stale snapshot took a just-activated member's row)
- [x] 5.9 tree-export retry instead of a silently dropped pass
- [x] 5.10 the activated member's row restored at activation time, not by the debounce

