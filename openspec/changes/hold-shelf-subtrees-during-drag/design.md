# Design: hold-shelf-subtrees-during-drag

## Context

TST activates a primary-pressed regular row after its asynchronous
`tab-mousedown` listeners allow the operation (`sidebar/mouse-event-listener.js`
363-421). Its `native-tab-dragstart` notification is sent later, from the
HTML5 `dragstart` path (`sidebar/drag-and-drop.js` 848-1098). Consequently,
the existing `tabs.onActivated` handler runs `rehideMembersNow()` before a
companion can know that the press became a drag.

The current visibility decision has three separate outlets:

- `foldDanglingMembers()` folds every expanded shelved tab absent from
  `mustShow`;
- `reconcileHidden()` hides every shelved tab absent from `mustShow` after
  the fold guard expires;
- `planReveals()` prunes a folded-owner reveal as soon as the active tab leaves
  the owner, and `endReveal()` folds that owner.

Shelf-icon selection adds a fourth, direct path: `selectShelfTab()` collapses
the previous member and can call `hideNow()` for the outgoing member without
consulting `danglingMembers()` first. All four paths must observe the same
temporary decision or one of them will still collapse the drop destination.

TST already exposes the necessary notification types. `tree-attached` carries
both `tab` and `parent` (`background/tree.js` 218-224), and an active dragged
tab makes TST's drop path attach with `forceExpand: true`
(`background/commands.js` 1180). TST then expands a collapsed parent when its
expansion listeners allow it (`background/tree.js` 305-356). No listener in
this addon currently cancels `try-expand-tree-from-attached-child`.

Constraints remain stock TST 4.x, Firefox 115+, no direct TST tree writes, no
new permissions, uniform rows, two separate hiding ledgers, whole-window
idempotent derivation, and runtime-only interaction state. This is a bug fix
targeting 0.6.5, not a feature release.

## Goals / Non-Goals

**Goals:**

- Keep the pre-drag active shelved branch available from the initial grasp
  through drop settlement.
- Reapply the existing active-tab rules from the fresh post-drop tree: inside
  remains open, outside folds, cancellation folds when appropriate.
- Preserve enclosing folded-owner reveals and the existing shelf-icon native
  drag and activation behavior during the exception.
- Recognize actual attachment beneath a shelved tab and verify TST's native
  expansion of a folded, visible regular-row target.
- Clean up every provisional hold on click, drag end, cancellation, relevant
  closure, and window closure; never persist the hold.

**Non-Goals:**

- Routing a drop on an inactive folded member's favicon to that member. TST's
  `SidebarItems.getItemFromDOMNode()` resolves the containing row, and no
  extra-contents dragover/drop notification identifies the icon.
- Exposing all folded members as temporary rows, implementing a second drop
  engine, or changing shelf membership and placement semantics.
- Changing keyboard/programmatic activation, the two hiding ledgers, the
  persisted shelf flag, manifest permissions, or the production TST style.
- Editing TST or requiring a companion patch.

## Decisions

### 1. Arm an optimistic, per-window hold at mousedown

A *drag hold* is the runtime record of the active branch immediately before a
potentially draggable primary-button mousedown. Use one `Map` keyed by window
id. Its value contains:

- `phase`: `pending`, `dragging`, or `settling`;
- `sourceId`: the pressed regular tab or the icon's `data-tab-id` member;
- `preservedActiveId`: the active tab before TST processes the press;
- bookkeeping for drag-end and structural activity needed by the settle rule.

Arm only when the cached fresh-enough tree shows an expanded shelved tab with
children on `preservedActiveId`'s ancestor-or-self chain. Read the live active
tab before recording it when the cache could be stale. A source equal to the
current active tab needs no extra hold. A new pending press replaces an older
pending press; it must not replace an already dragging hold.

For a regular row, handle `tab-mousedown`, record the hold, and return `false`.
TST awaits this response before activation. For an icon, arm at the start of
`onExtraContentsMousedown()` before its existing selection work. That handler
continues to return `true` for a primary icon press because it cancels the
owner row's activation, not the icon's native drag.

An `undefined` return from the regular-row handler is forbidden: the donor
client converts it to `true`, and TST interprets that as cancellation. This is
an explicit regression test at the event-handler level.

The optimistic `pending` phase is necessary because waiting for
`native-tab-dragstart` would let the existing activation fold the branch first.
A press released without drag therefore preserves the old branch only until
mouseup. `tab-mouseup` and `extra-contents-mouseup` release a matching pending
hold idempotently; the existing clicked handlers retain their behavior.

Alternative considered: arm at `native-tab-dragstart` and reopen the old
subtree. Rejected because it creates a collapse/expand transition and lets the
120 ms derivation and 150 ms collapse animation remove the target mid-drag.

### 2. Derive a union of the live and preserved branches

Keep the hold as orchestration input, not another membership ledger. Extend
pure planning with an optional preserved active id:

- `mustShowTabs({tree, activeId, preservedActiveId})` protects the ancestor
  chains of both ids. Existing `danglingMembers()` and `reconcileHidden()`
  consume the resulting set unchanged.
- `planReveals({tree, activeId, preservedActiveId, reveals, mustShow})` keeps
  a reveal while either anchor is its owner's descendant. When both anchors
  lie beneath one owner, it exposes the union of their direct-child branch
  subtrees. Descendants outside both remain in `suppress`.
- A missing preserved id contributes no protection. An explicit user fold
  still prunes an `openedSeen` reveal; a hold never overrides it.

Do not add held ids to `shelved`, `hiddenByUs`, or `suppressedHiddenByUs`.
Do not add a session key. `derive()` continues to calculate shelves, badges,
highlights, and selection from the real tree and active tab. The delta specs
explicitly allow the previous and dragged shelf members' subtrees to coexist
until the gesture resolves; settled one-subtree behavior does not change.

Alternative considered: protect only the previously active shelved tab's row.
Rejected because `foldDanglingMembers()` would still fold it, and an enclosing
reveal could still fold its owner and remove the whole branch.

### 3. Route every direct fold/hide path through the hold

While a hold is active, the union `mustShow` governs both `rederive()` and
`rehideMembersNow()`. In `selectShelfTab()`, retain the existing incoming
member expansion and activation, but suppress the direct collapse of the
previous member and both direct `hideNow()` attempts while that previous
member belongs to the preserved branch. The icon clicked fallback remains
idempotent and does not create another hold.

After release, the ordinary whole-window pass performs any required previous
member fold and delayed row hide. This avoids a special incremental visibility
update and keeps the two hiding ledgers unchanged.

A source activation may still begin its normal reveal. `planReveals()` handles
the live and preserved anchors together, so this does not require disabling or
faking TST's `try-expand-tree-from-focused-collapsed-tab` cancellation.

### 4. Promote on native drag start, then settle against structure

`native-tab-dragstart` promotes only the matching window/source pending hold to
`dragging`; it does not attempt to reconstruct a missed pre-drag branch.
`native-tab-dragend` marks the hold ended and enters `settling`, but does not
release it immediately: TST's drop command and drag-end notification are
separate asynchronous paths, and drag end carries no parent or drop-position
payload.

While a drag is active or settling, relevant `tree-attached`,
`tree-detached`, `tabs.onMoved`, `tabs.onAttached`, and `tabs.onDetached`
notifications mark structural activity and retrigger the existing debounced
rederivation. A final held pass must fetch a fresh light tree after drag end
and after the latest structural activity. Only after that pass has updated the
window cache does the runtime:

1. clear the hold;
2. immediately run the ordinary derivation once;
3. let the existing fold guards and reveal suppression grace handle the visual
   transition.

A short settle window also covers a canceled drag with no structural event.
A bounded watchdog clears a hold if drag-end or the final pass never arrives;
watchdog expiry logs a diagnostic and reconciles from live state rather than
leaving rows permanently protected. The initial probe will establish the
observed event ordering and the quiet-window/watchdog values. Correctness must
come from the fresh-tree check, not from assuming a fixed IPC latency.

Cleanup is idempotent on source close, preserved-anchor close, window close,
and extension boot. No hold survives restart; existing reveal boot recovery
continues to own any `tst-shelf-suppressed` tabs.

Alternative considered: release directly on `native-tab-dragend`. Rejected
because an outside drop could fold A before TST attaches the active tab under
A, causing a fold/reopen race.

### 5. Detect folded-parent attachment without taking over TST's drop

Change the `tree-attached` orchestration to read `message.parent`, not only
`message.tab.windowId`. During a matching drag/settle sequence, record
`tab.id`, `parent.id`, whether `shelved.has(parent.id)`, and whether
`isSubtreeFolded(parent.states)` in diagnostics and E2E telemetry. The fresh
light tree remains authoritative after the notification snapshot.

For a drop onto a folded shelved tab's visible regular row, do not issue a
second attach or an eager manual expand. TST's existing active-drag
`forceExpand` path unfolds the parent. The next derivation sees the active
child beneath that parent, so `mustShowTabs()` protects the parent and its
ancestors. A focused E2E case verifies this stock behavior and catches any
interference from the hold.

A favicon drop is not reported as a member-targeted drop. `tree-attached`
describes only the parent TST actually selected. No heuristic shall reinterpret
an owner-row drop as a drop onto one of its icons.

### 6. Measure the real interaction before wiring the E2E contract

Add a focused probe that records, with timestamps and ids:

- regular `tab-mousedown` and icon `extra-contents-mousedown`;
- `tabs.onActivated`;
- `native-tab-dragstart` and `native-tab-dragend`;
- `tree-attached` parent/child and fold states;
- `tabs.onMoved` and the first fresh-tree observation of the new parent.

Prefer trusted pointer movement through Marionette's generic `command()` and
`WebDriver:PerformActions`. If the installed Firefox cannot generate a complete
native HTML5 drag that way, drive TST's actual sidebar handlers with a
`DataTransfer`-carrying synthetic drag as a separate characterization, and
verify one trusted drag in GUI Firefox. Do not represent a synthetic mousedown
alone as drag-and-drop coverage.

Unit tests cover the pure union and reveal pruning. E2E assertions cover the
user-visible rows and browser hidden states before drop, after inside/outside
drops, after cancellation, after plain click, and after keyboard activation.
A nested-owner case proves that an enclosing reveal survives. An icon-source
case proves that `selectShelfTab()` cannot bypass the hold. A folded visible
member target proves the native attach/expand path.

## Risks / Trade-offs

- **A plain click briefly retains the old subtree until mouseup.** This is the
  price of distinguishing a press from a drag before HTML5 drag start. The
  pending hold never changes the settled click result, and a scenario locks
  that boundary down.
- **Two shelf subtrees can be visible during an icon-source drag.** The
  exception is bounded by the live and preserved branches and disappears on
  resolution. It avoids changing the existing icon activation choreography.
- **Drag-end and structural events can race.** The settling pass uses the
  latest fresh tree and a bounded quiet/watchdog interval; the probe records
  actual ordering instead of assuming it.
- **A missed drag-end could retain rows.** Idempotent mouseup cleanup where
  applicable, source/window cleanup, and a watchdog bound the state. Expiry
  always triggers ordinary reconciliation.
- **Union protection can grow with nested active ancestors.** It adds only two
  ancestor chains and reveal walks over the same tree. Run `make perf` on the
  350-tab fixture and include held-planning cases in the gate if a new pure
  planner is added.
- **A failed native expansion could leave a folded target.** The folded-row
  E2E case distinguishes TST's result from the hold. Any manual fallback must
  be justified by that measurement and still use `expand-tree`, never a tree
  edit.

## Migration Plan

No data or setting migration is required. Existing per-tab shelf flags and
TST fold states remain unchanged. On upgrade, the new runtime map starts empty;
on downgrade, no persisted drag state exists. The two production version
fields advance from 0.6.4 to 0.6.5 together only during implementation.
Rollback is the previous production zip, with no cleanup step.

## Open Questions

The implementation probe must resolve two measurements before the settle
constants are finalized:

1. On the target Firefox/TST fixture, does `native-tab-dragend` precede or
   follow `tree-attached` and `tabs.onMoved` for inside, outside, and canceled
   drags?
2. Can Marionette pointer actions produce the complete native drag, including
   TST's drop command, in the headless fixture?

Neither question changes the user-visible contract or the choice to preserve
from mousedown.
