# Design: add-shelf-placement-commands

## Context

The member block is kept contiguous directly under its owner by
`nextPlacementMove` (logic.esm.js), which plans ONE move per call in TST's
internal walk order and forces `appendSeq`-carrying members to the END
(put order, newest last). There is no lever for "first" today.

Menu items are the extension's OWN `browser.menus` items with
`contexts: ["tab"]` (TST's `contextMenu-create` route stays invisible for
plain tab rows — verified against TST 4.4.9/4.4.10, README
implementation notes); visibility flips in `menus.onShown`, and the E2E
drives that logic through the `test:menu-shown` hook because native menus
open only for trusted events.

## Goals / Non-Goals

- Goal: two full-slot moves (leftmost / rightmost) through one planner.
- Goal: the same guarantee class as every other placement move — TST's
  own move API, `followChildren: true`, no tree edits.
- Non-goal: pointer-drag reorder inside the strap. Measured against TST
  4.4.10: no `extra-contents-dragover`/`drop` notification types exist in
  `common/tst-api.js`, `extra-contents-mousedown` and `tab-mousemove`
  payloads carry no coordinates (`event-utils.js` `getMouseEventDetail`),
  and native icon drags notify only start/end. Deferred until TST grows
  that surface; the README records the condition.
- Non-goal: step-by-step "move left/right" commands; the two extremes
  cover the need with the smallest menu surface.

## Decisions

1. **A pure planner, one move per call** — `planExtremePlacementMove` in
   logic.esm.js, a sibling of `nextPlacementMove`:
   - leftmost: `move-before` the current first member. The block's first
     slot sits directly after the owner, so the landing position
     re-derives the mover's parent as the owner — the same
     position-derived-parenting argument `nextPlacementMove` relies on.
   - rightmost: `move-after` the current last member, with `outdent`
     when that member has descendants — exactly the `thenOutdent`
     fallback path already proven in `nextPlacementMove` (`move-after`
     a tab with descendants re-parents the mover into its subtree).
   - a member already in the named slot returns `null` (no-op).
   Planning runs in tree-walk order (`treePositions`), never against
   physical strip indices (the three-orders trap, README).
2. **No new append-order state.** `appendSeq` keeps its meaning (put
   order, newest last). The explicit move lands the member at its extreme
   slot; the next `reconcilePlacement` pass finds the block contiguous
   and does nothing. Reusing `appendSeq` for "Place rightmost" would work
   today but would tie the command to put-order semantics; a user who
   places rightmost and then places leftmost again would fight the
   sequence. One explicit planner, one meaning per lever.
3. **Submenu mechanics.** `browser.menus.create` with a `parentId` for
   the two children; the parent ("tst-shelf:shelf") and both children
   carry `contexts: ["tab"]`. Only the PARENT's visibility flips in
   `onShown` (a hidden parent hides its children in Firefox); the
   children stay visible so their state is never cached as hidden.
   `menuTelemetry` and the `test:menu-shown` hook grow the three items,
   so the E2E asserts visibility exactly as it asserts put/take.
4. **Apply-and-reschedule.** The click handler awaits the planned move
   (with the `outdent` follow-up when the plan says so), then
   `scheduleRederive(windowId)`; the placement fixpoint re-checks
   contiguity afterwards and would repair a failed move inside its
   existing bounds.

## Risks / Trade-offs

- [A move lands mid-animation of a collapse] → the member whose menu was
  just opened is not the one animating; the fixpoint's 40-step bound
  covers the rest.
- [Firefox caches submenu visibility per window] → `menus.refresh()`
  already runs in `applyMenuVisibility`; the E2E menu-telemetry assertions
  cover both flipped states.

## Open Questions

- None blocking; the E2E run decides whether the children also need
  visibility flips (Firefox version-dependent; task 2.2 checks).
