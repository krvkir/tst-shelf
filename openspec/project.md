# Project: tst-shelf

Tree Style Tab companion extension: shelves — favicon straps that hold
"shelved" tabs under their owner. A tab put on the shelf keeps its
place in the TST tree, stops occupying a full row, and appears as a
small favicon icon. Long sibling runs compress into one line, and
folded subtrees hide until their shelf tab is selected. Built for
trees of 350+ tabs where constant project tabs crowd out transient
ones.

## Glossary (short, canonical)

We *put a tab on a shelf* and *take it off the shelf*; a tab that is
on a shelf is *shelved*. Idiomatic synonyms: "to shelve" / "to
unshelve" a tab. These are the only terms used in menu items
("Put on shelf", "Take off the shelf") and in all specifications.

- **Shelf** — a horizontal strap that holds shelved tabs as favicon
  icons. Two kinds exist: a tab's shelf, rendered directly under the
  tab's row, and the *root shelf*, rendered at the top of the tab bar
  next to the global pinned-tabs area. Every tab has exactly one shelf
  that can hold it: its parent tab's shelf, or the root shelf when it
  has no parent.
- **Shelved tab** — a tab on a shelf. It keeps its tree position and
  its native tab, but has no visible row in the sidebar tree.
- **Shelf owner** — the tab whose shelf a shelved tab sits on. For the
  root shelf there is no owner tab; the window itself is the owner.
- **Selected shelf tab** — the shelved tab of a shelf the user last
  activated; the only shelf tab of its shelf whose subtree may be
  unfolded.
- **Folded / unfolded subtree** — the children rows of a shelved tab:
  hidden while folded, shown as regular tree rows directly below the
  shelf while unfolded.
- **Root shelf** — the shelf that holds shelved root tabs; rendered
  as a strap at the top of the tab bar next to the global pinned tabs
  area.
- **Container-workspace filtering** — visibility filtering of tabs by
  container, performed by tst-workspace (a separate companion that
  hides non-matching tabs natively).

The uniformity invariant of the whole project: *shelved is sticky*.
Only the explicit "Take off the shelf" action unshelves a tab;
everything else — drags, re-parenting, window moves, owner closures,
restarts — moves the tab between shelves, never back to a row.

Capabilities:

- `shelf-pinning` — the "Put on shelf" / "Take off the shelf" menu
  actions, the shelving state machine with its sticky-shelved
  invariant, drag-and-drop between shelves, the root shelf's
  membership, restart persistence, and the tree-integrity invariant.
- `shelf-presentation` — what shelves look like: reserved space,
  favicon straps with wrapping, tooltips, active highlight,
  folded-subtree badge, compactness of the rest of the tree, the root
  shelf strap, and visibility parity with container-workspace
  filtering.
- `shelf-nesting` — folding rules for subtrees of shelved tabs, the
  one-subtree-at-a-time rule, restart persistence of the unfolded
  subtree, and recursive nested shelves.
- `shelf-interaction` — selecting a shelved tab by clicking its icon
  and the shelf icon's context menu.

Constraints:

- Firefox, Manifest V2, persistent background page (house layout, see
  tst-workspace).
- Requires Tree Style Tab 4.0 or later; without TST the extension
  stays idle and provides no standalone UI.
- Sidebar-only presentation: shelved tabs remain regular tabs in the
  native tab bar; the native pinned-tabs feature is out of scope.
- Tree integrity: shelving never moves, reorders, re-parents, closes,
  or natively hides a tab beyond what the user's own action (drag,
  close) does; TST's tree data is untouched by shelf bookkeeping.
- Delegation: anything Tree Style Tab already does — tree
  re-attachment on parent closure, the close-multiple-tabs
  confirmation for collapsed subtrees, drag-and-drop drop semantics —
  is used as-is, not reimplemented.
- Permission surface minimal: `tabs`, `storage`, `sessions`. No
  `tabHide` (this extension performs no native hiding), no `menus`
  (menu items are created inside TST), no host permissions in v1.
- Interop with tst-workspace goes through the native hidden state of
  tabs only; the two extensions do not message each other.

Donor sources (implementation reference, do not copy requirements from
them): `~/repos/firefox/tst-workspace` (TST API client
`src/background/tst-api.esm.js`, register/unregister handshake,
`style: ""` string-not-array lesson, E2E harness layout),
`~/repos/firefox/tst-search` (origin of the TST API client), and the
Tree Style Tab sources `~/repos/firefox/treestyletab/webextensions/`
(API contract reference).
