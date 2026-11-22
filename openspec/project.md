# Project: tst-shelf

Tree Style Tab companion extension: shelves — favicon straps that hold "shelved" tabs under their owner. A tab put on the shelf keeps its place in the TST tree, stops occupying a full row, and appears as a small favicon icon. Long sibling runs compress into one line, and folded subtrees hide until their shelf tab is selected. Built for trees of 350+ tabs where constant project tabs crowd out transient ones.

## Glossary (short, canonical)

We *put a tab on a shelf* and *take it off the shelf*; a tab that is on a shelf is *shelved*. Idiomatic synonyms: "to shelve" / "to unshelve" a tab. These are the only terms used in menu items ("Put on shelf", "Take off the shelf") and in all specifications.

- **Shelf** — a horizontal strap that holds shelved tabs as favicon icons. Two kinds exist: a tab's shelf, rendered directly under the tab's row, and the *root shelf*, rendered at the top of the tab bar next to the global pinned-tabs area. Every tab has exactly one shelf that can hold it: its parent tab's shelf, or the root shelf when it has no parent.
- **Shelved tab** — a tab on a shelf. It keeps its native tab and its place in the tree, but has no visible row in the sidebar tree: it is hidden with `browser.tabs.hide()`, the only lever that removes a row without breaking TST's uniform-row geometry.
- **Shelf owner** — the tab whose shelf a shelved tab sits on. For the root shelf there is no owner tab; the window itself is the owner.
- **Selected shelf tab** — the shelved tab of a shelf the user last activated; the only shelf tab of its shelf whose subtree may be unfolded.
- **Folded / unfolded subtree** — the children rows of a shelved tab: hidden while folded, shown as regular tree rows directly below the shelf while unfolded.
- **Root shelf** — the shelf that holds shelved root tabs; rendered as a strap at the top of the tab bar next to the global pinned tabs area.
- **Container-workspace filtering** — visibility filtering of tabs by container, performed by tst-workspace (a separate companion that hides non-matching tabs natively).

The uniformity invariant of the whole project: *shelved is sticky*. Only the explicit "Take off the shelf" action unshelves a tab; everything else — drags, re-parenting, window moves, owner closures, restarts — moves the tab between shelves, never back to a row.

Capabilities:

- `shelf-pinning` — the "Put on shelf" / "Take off the shelf" menu actions, the shelving state machine with its sticky-shelved invariant, drag-and-drop between shelves, the root shelf's membership, restart persistence, and the tree-integrity invariant.
- `shelf-presentation` — what shelves look like: reserved space, favicon straps with wrapping, tooltips, active highlight, folded-subtree badge, compactness of the rest of the tree, the root shelf strap, and visibility parity with container-workspace filtering.
- `shelf-nesting` — folding rules for subtrees of shelved tabs, the one-subtree-at-a-time rule, restart persistence of the unfolded subtree, and recursive nested shelves.
- `shelf-interaction` — selecting a shelved tab by clicking its icon and the shelf icon's context menu.
- `tab-hints` — the keyboard command that labels every visible tab of the focused window with a short code (a member's code on its icon, a row's code on the row), prefix narrowing, and code activation.

Constraints:

- Firefox, Manifest V2, persistent background page (house layout, see tst-workspace).
- Requires Tree Style Tab 4.0 or later; without TST the extension stays idle and provides no standalone UI.
- Sidebar-only presentation: shelved tabs remain regular tabs in the native tab bar; the native pinned-tabs feature is out of scope.  A pinned tab cannot be shelved (putting one fails; pinning a shelved tab takes it off the shelf).
- Tree integrity: shelving never re-parents, closes, or re-orders a tab beyond **the member block it owns**: the members of a shelf are kept contiguous directly under their owner, newest put last, through TST's own `move-before` / `move-after` / `outdent` with `followChildren`. Take-off moves the tab back to its pre-shelve place, planned from the neighbours and index recorded at put time.  TST's tree data is never edited directly.
- Presentation levers, current and deliberate: the owner row's strap (extra contents), the addon state `tst-shelf-owner`, TST's `collapse-tree` / `expand-tree`, and `browser.tabs.hide()`.
- Permission surface: `tabs`, `tabHide` (member rows, and the rows a reveal suppresses), `storage` (boot diagnostics and the one user option, `badgeMode`), `sessions` (the sticky per-tab flag), `menus` (the tab-context-menu items — Put on shelf, Take off the shelf, and the "Shelf" submenu with the two place commands — which TST's own item API cannot make visible for plain tab rows), `commands` (the user-rebindable hint-mode hotkey), no host permissions, no content scripts.
- Interop with tst-workspace goes through the native hidden state of tabs only; the two extensions do not message each other.

Superseded decisions (kept as history; do not read them as invariants):

- *0.1.0–0.1.3, "shelving never moves a tab"* — the shelf was rendered inside the owner's row without touching tab order, so members stayed scattered and the selected member's subtree could render rows between the owner and the shelf.  Superseded in 0.1.4 by the contiguous member block described above.
- *0.1.1, "rows of N whole lines"* was rejected as a stock-TST feature. It returned in 0.2.0 through a companion patch (`lines` on `set-extra-contents`, the `row-less` tab state, a `tabbar-resized` notification), and was rejected again in 0.2.3 — see `openspec/changes/remove-companion-patch`. A crowded shelf keeps one line and scrolls; a member's row is removed by hiding the tab.
- *0.1.0–0.1.4, "menu items are created inside TST"* — TST's own context menu items stay invisible for plain tab rows, so 0.1.5 creates the two items through `browser.menus` with `contexts: ["tab"]`, which requires the `menus` permission.

Donor sources (implementation reference, do not copy requirements from them): `~/repos/firefox/tst-workspace` (TST API client `src/background/tst-api.esm.js`, register/unregister handshake, `style: ""` string-not-array lesson, E2E harness layout), `~/repos/firefox/tst-search` (origin of the TST API client), and the Tree Style Tab sources `~/repos/firefox/treestyletab/webextensions/` (API contract reference).
