# Proposal: add-shelf-foundation

## Why

The user's Tree Style Tab tree holds 350+ tabs organized into project
subtrees. Each subtree mixes a few constant tabs with transient ones,
and every tab costs a full row, so constant tabs bury the working set
and the tree grows vertically without end. Firefox's native tab
pinning compresses tabs to favicons but rips them out of the tree,
which defeats the workflow. A "shelf" — a favicon strap that holds
tabs under their owner — keeps tabs in the tree while compressing the
constant ones, and folding a shelved tab's subtree until selection
turns a long sibling run with children into one visible subtree at a
time.

## What Changes

- ADD capability `shelf-pinning`: "Put on shelf" and "Take off the
  shelf" items in the TST tab context menu; a shelved tab loses its
  sidebar row and gains a favicon icon on the shelf of its parent (or
  the root shelf for root tabs); shelved state is sticky — drags
  between shelves, drops on shelf-less tabs (which auto-create their
  shelf), re-parenting, and window moves move the tab between
  shelves, and only the explicit "Take off the shelf" action restores
  a row; shelved state survives browser restarts with the target
  shelf re-derived from the restored tree; closing a shelved tab with
  children delegates to Tree Style Tab's own close confirmation; the
  root shelf exists for root tabs and persists like any other shelf.
- ADD capability `shelf-presentation`: tab shelves reserve space
  directly under the owner's row, the root shelf renders as a fixed
  strap at the top of the tab bar next to the global pinned tabs
  area; icons are favicon-sized, wrap into extra rows, show
  title-and-URL tooltips, highlight while their subtree is active
  (theme colors), carry a plus badge while children are folded; all
  other tab rows keep their normal size; icons of
  workspace-filtered-out tabs are hidden.
- ADD capability `shelf-nesting`: children of a shelved tab stay
  hidden until the tab is selected on its shelf; unfolded children
  render as regular rows directly below the shelf with normal tree
  indentation; one subtree is visible per shelf at a time; the
  unfolded subtree stays visible across unrelated activations and
  browser restarts, folding only when another tab of the same shelf
  is selected; a selected shelved tab's own nested shelf renders
  directly below the parent shelf.
- ADD capability `shelf-interaction`: a left click on a shelf icon
  selects that tab (not the owner); a right click opens the tab's
  regular context menu, including "Take off the shelf"; a drag from a
  shelf icon performs Tree Style Tab's native tab drag with children
  following.

## Capabilities

### New Capabilities
- `shelf-pinning`: the put-on/take-off menu actions and the shelving
  state machine: sticky-shelved invariant, drag-and-drop re-shelving,
  the root shelf membership, restart persistence, owner-closure
  re-shelving, close confirmation delegation, and the tree-integrity
  invariant.
- `shelf-presentation`: the visual shelves — reserved space, favicon
  straps with wrapping, tooltip, active highlight, folded-subtree
  badge, compactness of the rest of the tree, the root shelf strap,
  and visibility parity with container-workspace filtering.
- `shelf-nesting`: folding and unfolding of shelved tabs' subtrees,
  the one-subtree-per-shelf rule, restart persistence of the unfolded
  subtree, and recursive nested shelves.
- `shelf-interaction`: click-to-select on shelf icons and the shelf
  icon context menu.

### Modified Capabilities

(none — first deployment, no prior specs)

## Impact

- Affected specs: `shelf-pinning`, `shelf-presentation`,
  `shelf-nesting`, `shelf-interaction` — all new capabilities, first
  deployment.
- Affected code: new extension in this repository — MV2 manifest,
  ES-module background (state machine + TST API client), no options
  UI in v1; no changes to Tree Style Tab, tst-workspace, or any other
  extension (coupling to tst-workspace is only through the native
  hidden state of tabs).
