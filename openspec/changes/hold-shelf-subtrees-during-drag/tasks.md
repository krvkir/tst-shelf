# Tasks: hold-shelf-subtrees-during-drag

## 1. Characterize the real drag lifecycle

- [ ] 1.1 Add an E2E-only drag probe that records `tab-mousedown` / `extra-contents-mousedown`, `tabs.onActivated`, `native-tab-dragstart` / `native-tab-dragend`, `tree-attached` parent/child/states, `tabs.onMoved`, and the first fresh-tree observation of the new parent, with timestamps and window ids
- [ ] 1.2 Test whether Marionette `WebDriver:PerformActions` through the existing generic `command()` produces a complete native TST drag; if it cannot, characterize a `DataTransfer`-carrying synthetic drag through TST's actual sidebar handlers separately and leave one trusted GUI drag as an explicit manual check
- [ ] 1.3 Measure event ordering for drops inside and outside an active shelved subtree and for cancellation; use the results to set and document the structural quiet window and bounded watchdog, without treating a fixed IPC delay as proof of the final parent

## 2. Extend pure visibility planning

- [ ] 2.1 Add optional `preservedActiveId` support to `mustShowTabs`: protect the union of the live and preserved ancestor-or-self chains while retaining animation protection and existing no-hold behavior
- [ ] 2.2 Add the optional preserved anchor to `planReveals`: retain a reveal while either anchor belongs to its owner, union direct-child branch subtrees when both belong to one owner, continue suppressing every other descendant, and preserve owner-close and explicit-user-fold pruning
- [ ] 2.3 Add unit tests for no hold, identical anchors, separate branches, unknown or closed anchors, nested shelf owners, unrelated-descendant suppression, user fold during a hold, and the single-active behavior after release
- [ ] 2.4 Extend the 350-tab performance fixture with a held live+preserved planning case and confirm the existing full-pass and put budgets; record median and worst-case numbers

## 3. Implement the runtime hold

- [ ] 3.1 Add a per-window runtime `dragHolds` map and small helpers for arm/promote/settle/release/cleanup; each record carries `phase`, `sourceId`, `preservedActiveId`, drag-end/structural bookkeeping, and timer handles, with no session persistence and no changes to either hiding ledger
- [ ] 3.2 Subscribe to regular `tab-mousedown` / `tab-mouseup`, icon `extra-contents-mouseup`, and `native-tab-dragstart` / `native-tab-dragend`; arm before TST activation, return explicit `false` from regular mousedown, retain the icon handler's existing cancellation verdicts, promote only a matching source, and release pending holds on mouseup
- [ ] 3.3 Pass the hold's preserved anchor into both `rederive()` and `rehideMembersNow()` so `foldDanglingMembers()`, `reconcileHidden()`, and `reconcileSuppressed()` use the same union decision; leave non-drag activation and `maybeBeginReveal()` behavior unchanged
- [ ] 3.4 Make `selectShelfTab()` skip its direct previous-member collapse and outgoing `hideNow()` attempts only while that member belongs to an active preserved branch; retain incoming expansion, activation, icon drag data, clicked fallback, and sticky shelf membership
- [ ] 3.5 Read `message.parent` in `tree-attached`; mark structural activity during dragging/settling, record actual-parent and folded-shelved-parent telemetry, run a final fresh-tree held pass after drag end and the latest activity, then clear the hold and immediately run the ordinary pass
- [ ] 3.6 Add idempotent cleanup and diagnostics for source/anchor tab close, window close, missed drag end, tree-fetch failure, and watchdog expiry; boot starts with no holds and existing reveal crash recovery remains unchanged
- [ ] 3.7 Expose hold phase/ids and folded-parent attachment observations through the existing E2E-only state/diagnostics surface; production behavior and `dist/` permissions remain unchanged

## 4. Verify user-visible drag behavior

- [ ] 4.1 E2E ordinary-row source: after grasp and throughout the drag, the previously active shelved tab's row and children remain rendered; dropping an active tab into that subtree preserves it after settlement without a fold/reopen transition
- [ ] 4.2 E2E outside drop and cancellation: the preserved subtree folds once after resolution, its row follows the child-first guard, and the dragged tab's shelf membership/order still re-derives without auto-unshelving
- [ ] 4.3 E2E plain click and keyboard/programmatic activation: a click releases at mouseup with the ordinary final visibility, while non-pointer activation creates no hold and folds immediately as before
- [ ] 4.4 E2E shelf-icon source: the icon drags its own tab and descendants through TST, the previous same-shelf subtree is not folded or directly hidden at grasp, and at most one member subtree remains after settlement
- [ ] 4.5 E2E nested folded-owner reveal: the pre-drag and live branches remain renderable while unrelated descendants stay in `suppressedHiddenByUs`; an outside result prunes the reveal without a row flash, and an explicit user fold still wins during the hold
- [ ] 4.6 E2E folded visible regular-row target: an active dragged tab attaches beneath the shelved parent, `tree-attached` telemetry identifies that parent and its prior fold, TST unfolds the subtree, and the active child plus required ancestors remain visible; do not add favicon-target inference
- [ ] 4.7 E2E cleanup: source close, preserved-anchor close, window close, and restart leave no hold or extra hidden tab; existing renderer, frame-sampling, uniform-row geometry, and reinstall checks remain green
- [ ] 4.8 Run two consecutive clean `make e2e` runs under the hard timeout and record both exit statuses and pass/fail counts

## 5. Documentation and release gates

- [ ] 5.1 Update `README.md` with the grasp-to-settlement behavior, measured event ordering, cancellation/click boundary, folded regular-row result, and the unchanged inactive-folded-favicon limitation; update `AGENTS.org` integration/state lists if the implemented event and runtime-state names differ
- [ ] 5.2 Run `openspec validate hold-shelf-subtrees-during-drag --type change --strict`, `make test`, and `make perf`; then run a clean `make build`, `make lint`, and `make verify-dist` after the E2E flavor has been built
- [ ] 5.3 Confirm the pre-recorded bug-fix classification and bump only the third version field from 0.6.4 to **0.6.5** in `src/manifest.json` and `package.json` together; do not change the second field or delete any prior `web-ext-artifacts/` package
