# Design: reveal-folded-owner-branch

## The mechanism being worked around

TST reacts to a tab activated inside a fold by expanding *the tab and all
its ancestors*:

```js
// background/handle-tab-focus.js (Tab.onActivating listener)
const toBeExpandedAncestors = [tab].concat(tab.$TST.ancestors);
for (const ancestor of toBeExpandedAncestors) {
  Tree.collapseExpandSubtree(ancestor, { collapsed: false, broadcast: true });
}
```

That branch fires for `tab.$TST.collapsed`, i.e. when the activated tab's
own subtree is folded — which is exactly the state a row-less member is
kept in (a member with children is folded whenever its row is gone, so its
children cannot dangle). So a shelf click always landed there.

The branch is guarded by a cancellable notification,
`try-expand-tree-from-focused-collapsed-tab` (`common/tst-api.js`,
cancelled when any helper answers truthy — `tryOperationAllowed` returns
false on `results.flat().some(result => result?.result)`). Cancelling it
also stops `handleNewActiveTab`, so this extension performs the two
expansions itself with `expand-tree`.

## Why the owner must be expanded at all

TST renders a tab's row only if every ancestor is expanded. A reveal
therefore cannot avoid expanding the folded owner; it can only decide what
else gets a row. The lever is the same one the shelf already uses for
members: the `row-less` state of the companion patch, which takes a tab out
of the rendered flow without hiding it (nothing about the tab changes
browser-side).

Rejected alternative: hiding the siblings with `browser.tabs.hide()`. On a
companion WITH row-less tabs it stays rejected — the `hidden` flag of an
ordinary tab is the user's visibility state, not layout. It is used on a
companion WITHOUT the capability, because there the only alternative is to
not have the feature at all; see the section below.

## The stock path (0.2.2)

Without the capability the lever is `browser.tabs.hide()`, which this
extension already declares for member rows. Three things make it safe:

- **its own ledger** (`suppressedHiddenByUs`). `hiddenByUs` means "hidden,
  but still an icon on a shelf", and `reconcileHidden` *shows* every tab in
  it that is not shelved — a suppressed tab put there would be revealed
  right back on the next derivation.
- **session bookkeeping** (`tst-shelf-suppressed`). Reveals are runtime
  state: a browser that dies mid-reveal would leave tabs hidden with
  nothing to show them. The boot path reads the bit — only for tabs that
  are actually hidden, so a patched companion pays zero extra reads — and
  shows them.
- **the same end-of-reveal path**: `suppressHold` defers the show for the
  length of TST's collapse animation, then a scheduled derivation lifts it.

Known limitation of both paths: a suppressed tab that owns its own shelf
loses its strap while suppressed, because a strap lives in its owner's row
(and a hidden or row-less tab has none).

## Row removal that does not stick

Measured: a sidebar that opens late renders rows for tabs the extension
keeps row-less — TST's initial import carries only its own safe states, and
the re-apply can land before the import finishes. Two consequences, both
fixed:

- the addon does **not** drop its ledger on `sidebar-show` any more (that
  was the earlier attempt): the ledger is the knowledge of what must be
  re-applied, and dropping it left rows behind with nothing to retry.
  Instead a `forceRowLessResync` flag makes the next pass re-send every
  claim.
- an addon claim that is *observably* violated is re-sent: `tabs-rendered`
  naming a claimed tab proves the state did not land, so the claim is
  forgotten and re-sent, bounded by `MAX_ROW_LESS_TRIES` (4) per tab.

## Three more defects the E2E flakiness exposed

1. **A global ledger cleaned by a foreign window's pass.** `offRowLess` (and
   the reveal's lift set) filtered `rowLessByUs` globally, so a derivation
   of a window that contains none of those tabs read them as "no longer a
   member" and stripped every other window's row-less states — member rows
   then reappeared on any event in the second window. Both cleanups are now
   scoped to `tabsById`, the same rule the renderer already followed.
2. **A stale active-tab snapshot.** `rederive` read the active tab from a
   `tabs.query` taken *before* the tree export; a tab activated in between
   (a shelf click) was still inactive in that snapshot, and the anchor rule
   ("a member with children keeps its row while active") therefore took the
   row away from the tab that had just been activated. The active tab is
   now re-read right before the decision, and passed to both reconciles.
3. **A failed tree export ended the pass silently.** The previous decision
   stayed in force with nothing scheduled to re-evaluate it. Now the pass
   retries, bounded by `MAX_TREE_FETCH_TRIES` (5).

Plus one deliberate rule: the activated member's row is restored **at
activation time** (`restoreMemberRow`, called from `tabs.onActivated` and
from the shelf click), not by the debounced derivation — a row-less state
lives in TST's model, so the row appears only when the state is removed,
and waiting leaves children hanging under nothing in the meantime.

## The branch rule

The branch is the subtree of the owner's DIRECT child on the active tab's
ancestor chain, not the active tab's own subtree. Two measured reasons:

- clicking a member of a NESTED shelf must keep that nested owner's row —
  the nested strap lives in it (the anchor is the nested owner itself);
- activating a grandchild afterwards must not hide its siblings, which is
  what "the activated child's subtree is revealed" means.

Tabs a reveal suppresses are exactly `descendants(owner) \ branch \ mustShow`.
`mustShow` (the active tab, its ancestors, and anything mid-animation,
`logic.mustShowTabs`) is excluded because taking those rows away would
orphan whatever is animating.

## Fold detection — measured, not assumed

TST marks a fold in two places, and which one appears depends on the tab's
role:

- the tab the fold was applied to carries `subtree-collapsed`
  (`collapseExpandSubtree` → `collapseExpandSubtreeInternal` →
  `addState(kTAB_STATE_SUBTREE_COLLAPSED)`);
- every tab INSIDE that fold carries `collapsed`
  (`collapseExpandTabAndSubtree` → `collapseExpandTab`).

Measured in the live sidebar: a folded root owner reported
`states = ["subtree-collapsed", "newtab-command-tab"]` — no `collapsed` at
all. The first implementation tested `collapsed`, found the owner
"expanded", declined the reveal, and the E2E showed the whole subtree
painted again. `isSubtreeFolded` accepts either marker.

## Lifecycle and the two race guards

- `openedSeen` — a reveal is created while the owner still reads folded
  (our own `expand-tree` is in flight). Pruning on "owner is folded" in
  that window would cancel every reveal at birth, so a fold counts as the
  USER's only after a derivation has seen the owner expanded. This also
  makes the user's own fold the winning action, with no way to tell the two
  apart by timing.
- `suppressHold` — ending a reveal folds the owner back, and TST removes
  the rows of a collapse only after `configs.collapseDuration` (150 ms).
  Lifting the suppression in the same pass would paint the siblings for the
  length of that animation (the bounce already fixed for member row swaps
  in 0.1.6). The suppression is held for the animation's length and a
  re-derivation is scheduled for its expiry.

## Known non-goals

- A reveal is runtime state: after a restart the tree is exactly as folded
  as TST persisted it, with no reveal.
- Reveals are per window and per owner; nested owners each get their own,
  which is how a two-level reveal works (unit test
  "nested reveals each suppress their own owner's subtree").
