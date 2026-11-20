# Design: add-shelf-foundation

## Context

Companion extension for Tree Style Tab (TST), not a fork. TST's tree is
a flat list of `tab-item` rows; every verified mechanism below comes
from the TST sources at
`~/repos/firefox/treestyletab/webextensions/` (read at version
4.4.10) and the TST wiki, not from assumptions. The shelf is a pure
presentation layer over a sticky per-tab flag; tree mutations belong
to the user and to TST.

## Verified TST mechanics this design rests on

- `register-self` carries a `style` string that TST installs into the
  sidebar (`installStyle`, `sidebar/tst-api-frontend.js`); custom tab
  states set via `add-tab-state` become CSS classes on `tab-item`
  elements. Extra contents go through `set-extra-contents` with
  `place: 'tab-below'` (tab straps) or `place: 'tabbar-top'` (the root
  shelf); tab straps are auto-reinserted when TST reuses a row element
  (`AUTO_REINSERT_PLACES`, `SidebarItems.onReuseTreeItemElement`),
  but are cleared when a tab leaves the viewport (TST 4.x virtual
  scroll; restore on the `tabs-rendered` notification). The
  `tabbar-top` container is not a tab row and never un-renders.
- Row heights are fixed at `--tab-size`, which TST derives from the
  height of the `#dummy-tab` — and the dummy tab mirrors the most
  recent `tab-below`/`tab-above` contents of every addon
  (`sidebar/size.js` phase 1, `base.css:183`
  "make tab height consistent even if only some tabs have extra
  contents"). A naive strap therefore inflates every row in the tree.
- The `.extra-items-container.below` sits inside `tab-item-substance`
  as an in-flow, `overflow: visible` flex column
  (`base.css:756-766`, `sidebar.html`), so in-flow strap content grows
  its row if the row's fixed height is lifted.
- TST hides rows itself by a negative-margin pattern, not
  `display: none` (`.collapsed` rule, `base.css:686`); nested
  below-contents keep rendering under it.
- Sanitization of extra contents (DOMPurify + a TST pass) rewrites
  only `href`/`src`/`srcset` attributes to `#` unless their URL
  matches `data|resource|chrome|about|moz-extension`
  (`setExtraContentsToContainer`, `sidebar/tst-api-frontend.js`); the
  `style` attribute is not touched by the TST pass.
- An element inside extra contents with a `data-tab-id` attribute gets
  the native tab context menu of that tab on right-click
  (TST wiki "Extra Tab Contents API → Override context menu";
  `sidebar/tab-context-menu.js` resolves `closest('[data-tab-id]')`
  and calls `browser.menus.overrideContext({context: 'tab', tabId})`).
- Extra-contents elements become TST-native drag sources with
  `draggable="true"` and a
  `data-drag-data='{"type":"tab","data":{"id":N,"asTree":true}}'`
  attribute (TST wiki); TST then runs its own drag-and-drop — drop
  zones, edge-insertion vs attach-as-child, re-parenting of the
  dragged tree — exactly as for a row drag.
- Menu items are OUR OWN `browser.menus` items (manifest permission
  `menus`): `{id, title, contexts: ['tab']}`, visibility flipped by our
  `menus.onShown` listener, clicks handled by our `menus.onClicked`.
  REJECTED route, verified against TST 4.4.9/4.4.10 sources: registering
  via `contextMenu-create` creates the item `visible: false`
  (`background/tab-context-menu.js` — the create handler computes
  `lastVisible && mOverriddenContext && owner == sender`), and no TST
  code path ever flips it for a plain tab-row menu: `onShown`'s main
  body updates only TST's own items, and `contextMenu-update` strips
  the `visible` property unless an owner-matched menu is currently
  overridden (menus for the addon's own extra contents). The flagship
  helper, tst-more-tree-commands, bypasses `contextMenu-create` for the
  same reason. TST's sidebar opens the tab menu via
  `overrideContext({context: 'tab', tabId})`, which shows every
  extension's `contexts: ['tab']` items — ours included (and they also
  appear in the native tab bar's menu, as More Tree Commands' do).
- Clicks on extra contents arrive as `extra-contents-clicked` /
  `extra-contents-mousedown` with `originalTarget` (the clicked
  element's HTML, `data-*` attributes included), `originalTargetPart`,
  and `tab` = the row's host tab (the shelf owner); a listener
  returning `true` cancels TST's default reaction — activating the
  owner (`sidebar/mouse-event-listener.js`).
- TST's own collapse machinery is the delegation target for folding:
  `subtree-collapsed` is a TST tab state (exported in the light tree's
  `states`, persisted by TST across restarts via its per-tab
  persistent-states session values, `TreeItem.js`), driven by
  `collapse-tree` / `expand-tree` messages; TST's own close path
  confirms closing a tab with a collapsed subtree (suppressible via
  `grant-to-remove-tabs`, which we never send for shelf tabs); TST
  notifies `tree-attached` / `tree-detached` on re-parenting and
  `try-collapse-tree-from-other-expansion` before auto-collapsing
  "other" trees on focus changes (cancellable by returning `true`).
- The external `get-tree` export carries per-tab raw properties
  (`title`, `url`, `favIconUrl`, `cookieStoreId`, `hidden`, …) plus
  $TST tree fields (`children`, `ancestorTabIds`, `indent`, `states`)
  — but NOT TST's persistent `uniqueId`; the extension keeps its own
  stable per-tab keys instead.

## Donors

- `~/repos/firefox/tst-workspace` — `src/background/tst-api.esm.js`
  copied verbatim with attribution (MPL-2.0): register / re-register on
  `ready`, wait-for-shutdown, response-shape guard, retry-with-backoff;
  the `style: ""` string-not-array lesson (an array style breaks TST
  sidebar init); the E2E rig layout (fixture profile with TST,
  Marionette trusted-click tests, headless Firefox + LibreWolf matrix).
- `~/repos/firefox/tst-search` — original author of the TST API
  client.
- `~/repos/firefox/treestyletab` — contract reference only.

## Decisions

1. **The only stored state is a sticky per-tab flag.** Every tab gets
   a `tst-shelf-key` uuid session value on first sight; a shelved tab
   stores `('tst-shelf', {on: true})` via
   `browser.sessions.setTabValue`. The flag survives browser restarts
   under session restore and dies with the tab. Nothing else is
   stored: the target shelf is always *derived* from the live tree —
   the parent tab's shelf, or the root shelf for root tabs. All
   structural events (`tree-attached`, `tree-detached`,
   `tabs.onMoved` across windows, owner/member `tabs.onRemoved`,
   drag drops) trigger the same idempotent re-derivation: recompute
   every shelved tab's owner from the light tree and re-render the
   affected straps. There is no auto-unshelve; the flag is cleared
   only by the "Take off the shelf" action.
2. **Shelves are straps of extra contents.** A tab's shelf is
   `set-extra-contents` at `place: 'tab-below'` on the owner row; the
   root shelf is the strap at `place: 'tabbar-top'` (it is not a tab
   row, so it never un-renders and never participates in row
   sizing). One container element with one icon button per
   currently-shown shelved tab. Each button carries `data-tab-id`
   (native tab context menu for that tab), `data-shelf-key`, a
   `part="shelf-icon"`, a `title` tooltip (`title\nurl`), the favicon
   as an inline `style` background image, `draggable="true"` and the
   tab-type `data-drag-data` with `asTree: true` (Decision 7). All
   CSS ships via the `register-self` `style` string (a string, never
   an array).
3. **Row sizing: suppress the global inflation, make owner rows
   auto-height.** The installed style sets
   `#dummy-tab .extra-items-container.below { display: none }` so the
   dummy tab (and thus `--tab-size` for every row) ignores the strap;
   shelf-owner rows get `height: auto; min-height: var(--tab-size)`
   so the in-flow strap reserves exactly its own height under the
   owner. Icons lay out in a CSS grid
   (`repeat(auto-fill, var(--faviconized-tab-size))` rows), so
   wrapping and shelf height are intrinsic — no width-measuring from
   the background. The root shelf strap lives in `#tabbar-top` and is
   styled by the same grid.
4. **Shelved rows are hidden the way TST hides rows**: the
   `tst-shelf-shelved` state class gets the negative-margin collapse
   pattern (`margin-block-start:
   calc(0px - var(--tab-current-size) - var(--tab-margin-block-end))`,
   mirroring `base.css:686`), not `display: none`, keeping TST's
   layout and scroll math consistent. A shelved tab that must anchor
   visible content — a selected shelved tab that owns a nested shelf,
   or a shelved tab that TST promoted into a parent of regular tabs
   — renders as a *ghost row* instead: the `tst-shelf-ghost` state
   hides the caption, the row keeps only its own strap at its indent,
   auto-heighted.
5. **Favicons render through the `style` attribute.**
   `background-image: url(<favIconUrl from tabs.Tab>)` on the icon
   button passes sanitization untouched (the TST pass rewrites only
   `href`/`src`/`srcset`) and the sidebar CSP does not restrict
   `img-src`. If the pinned DOMPurify build strips `style` attributes
   (verification task 2.4), the fallback is
   `set-extra-contents-properties` with `{style: cssText}` — DOM
   property assignment bypasses the HTML sanitizer entirely. Fetching
   favicons into `data:` URIs is the last resort and needs host
   permissions; out of scope for v1.
6. **Menu items**: `contextMenu-create` for
   `{id: 'tst-shelf:put', title: 'Put on shelf', contexts: ['tab'],
   viewTypes: ['sidebar']}` and `{id: 'tst-shelf:take',
   title: 'Take off the shelf', …}`. Visibility on
   `contextMenu-shown`: "Put on shelf" for every unshelved tab (root
   tabs included — they go on the root shelf), "Take off the shelf"
   for every shelved tab. "Take off the shelf" is the only code path
   that clears the sticky flag.
7. **Drags are TST-native drags.** The icon's `data-drag-data` (type
   `tab`, `asTree: true`) makes TST treat the drag as a regular tab
   drag: children follow, drop zones, edge-insertion, attach-as-child
   are all TST's. We add no drop logic; after TST's resulting
   `tree-attached`/`tree-detached`/move notifications the uniform
   re-derivation (Decision 1) moves the icon to the shelf of whatever
   parent TST assigned — the drop target's shelf (auto-created when
   the target had none), or the root shelf for a root-level drop. Edge
   drops that TST resolves as sibling insertions keep the tab shelved
   on the sibling's parent's shelf. Icon clicks: on
   `extra-contents-clicked` parse `data-tab-id` from
   `originalTarget`, activate that tab
   (`browser.tabs.update(id, {active: true})`), return `true` so TST
   does not activate the owner. Right-clicks need no code: the
   `data-tab-id` attribute routes them to the tab's native context
   menu. When the activated tab is shelved, respond `true` to
   `try-scroll-to-activated-tab` and send TST `scroll` to the owner
   row (or the top of the tab bar for root-shelf tabs) instead.
8. **Folding is TST's own subtree-collapsed state — delegated, not
   reimplemented.** Putting a tab on the shelf sends `collapse-tree`
   for it; children hide by TST's native collapsed-row rendering.
   Selecting a shelf icon activates the tab and TST's own
   focus-behavior expands the focused collapsed tab; the previous
   shelf tab of the same shelf gets an explicit `collapse-tree` to
   guarantee the one-subtree-per-shelf rule. Unrelated activations
   must NOT fold a shelf subtree: we cancel TST's
   `try-collapse-tree-from-other-expansion` whenever the would-be
   victim is a shelved tab (returning `true`; regular trees stay
   untouched). The selected shelf tab is *derived*, never stored: the
   shelved tab of a shelf whose subtree is expanded, or the active
   shelved tab; ties resolved in favor of the active tab. Because TST
   persists `subtree-collapsed` across restarts, the unfolded subtree
   surviving restarts — and coming back exactly as left — is free.
   Boot reconciliation additionally collapses stray multiple-expanded
   shelves to one.
9. **Close confirmation is TST's.** A shelved tab's children are
   folded under TST's native collapsed state (Decision 8), so
   closing it through its context menu ("Close Tab" in the
   `data-tab-id`-routed native menu) hits TST's own
   close-multiple-tabs confirmation for collapsed parents. We never
   send `grant-to-remove-tabs` for shelf tabs and add no dialog of
   our own. Closing a childless shelved tab needs no confirmation and
   removes the icon via `tabs.onRemoved` re-derivation.
10. **Owner closure is uniform re-derivation, not special-cased.**
    When a shelf owner closes, TST's own close-parent behavior
    re-attaches its children (grandparent attach, or first-child
    promotion, per TST configuration). The shelved members are
    ordinary children in TST's model, so they follow that behavior;
    the uniform re-derivation then lands each member's icon on the
    shelf of its new parent — the grandparent's shelf in the
    attach-up case, the promoted tab's (auto-created) shelf in the
    promote case, the root shelf if a member ends up root. The
    invariant the user cares about — no wall of rows appearing on
    closure — holds in every branch because shelved members never
    render rows; a promoted *shelved* member anchors its inherited
    regular children through the ghost row (Decision 4).
11. **Workspace parity**: the addon tracks `hidden` transitions of
    shelved tabs (`tabs.onUpdated` `changeInfo.hidden`, plus raw
    `hidden` from `get-tree` on re-derivation) and re-renders straps
    with only the icons of currently-visible shelved tabs; an icon
    whose tab is hidden never renders, and a shelf with no visible
    icons reserves no space. No messages are exchanged with
    tst-workspace.
12. **Performance budget**: bulk message sends (`messages: [...]`),
    `lightTree: true`, `allowBulkMessaging: true`; strap re-renders
    debounced and batched; re-derivation only touches affected owners
    on tree events; the light tree's `states` array feeds badge and
    fold cues without extra queries. Budget gate in the E2E fixture:
    a 350-tab session with 5 shelves of 5 tabs each must reconcile
    all straps after a restart in under 300 ms.

## Risks / Trade-offs

- **Root shelf placement is constrained by the TST API.** The user
  wants the root shelf "right below the pinned tabs box"; TST 4.4.10
  offers no extra-contents slot between the pinned box and the tree —
  `tabbar-top` renders *above all tabs including the pinned box*, and
  the only position-exact alternative (`tab-above` on the first root
  tab) scrolls away and un-renders under virtual scroll. v1
  implements the root shelf at `tabbar-top`, i.e. directly *above*
  the pinned favicon row when pinned tabs exist (exactly below it
  when they do not); exact below-pinned placement requires an
  upstream TST slot. This deviation is the single open product
  decision of this change.
- **TST-behavior cancellation is the risk hotspot** (same class of
  risk as tst-workspace session 5): the single cancellation listener
  (`try-collapse-tree-from-other-expansion` for shelved victims)
  must be narrow; an over-broad cancel would freeze TST's native
  collapse UX. E2E covers: fold on shelve, expand on select,
  one-per-shelf, stays-until-sibling, restart survival, plus native
  Collapse All still working on regular trees.
- **Native-collapse coupling**: folding relies on TST's focus and
  collapse behaviors (`try-expand-tree-from-focused-collapsed-tab`
  and friends) and their configuration; the E2E matrix runs under
  default and collapsed-tree-heavy TST configurations.
- **DOMPurify `style`-attribute behavior** is the one unverified link
  in the favicon route (task 2.4); the properties-based fallback is
  designed in, not improvised.
- **Session-value persistence requires session restore.** Without
  session restore the tabs themselves do not come back, so the loss
  of shelved flags is indistinguishable from the loss of the session;
  documented in the README.
- **`data-tab-id` icon menus** depend on TST's documented
  override-context contract; if a future TST drops it,
  `override-context` (sent on `extra-contents-mousedown`) is the
  documented fallback performing the same job.
- **tst-workspace race**: both extensions react to tree events;
  re-derivation is idempotent and reads only native state, so the
  worst case is a delayed icon update, never a wrong shelf.
- **Variable row heights vs TST's virtual scroll.** TST assumes
  uniform `--tab-size` (the dummy-tab mechanism exists precisely to
  avoid per-row variance); auto-height owner rows deviate on
  purpose. Mitigation: measured E2E on the 300+ tab fixture; fallback
  plan is quantized owner heights via state classes
  (`tst-shelf-owner-rows-1..N` setting `--tab-current-size`
  explicitly) if scroll mispredictions appear.

## Implementation notes (2026-11-21, discovered while building)

Deviations and refinements the E2E forced, all recorded in the README
too:

- **No per-tab uuid key.** Decision 1 planned a `tst-shelf-key`
  session value for stable per-tab keys; implementation showed it is
  unnecessary — the sticky flag rides the tab through session restore
  and window moves, and nothing correlates tabs across sessions by
  anything but id. The flag alone is the stored state.
- **`windowId` is load-bearing in every TST request.** TST's
  `getTargetTabs` falls back to the last focused window without it;
  unfocused/headless sessions then resolve an active tab of null and
  the request silently processes zero tabs while answering `true`.
  Every `add-tab-state`/`remove-tab-state`/`collapse-tree`/
  `expand-tree` call now carries the target's `windowId`.
- **The renderer's state cleanup is window-scoped.** A derivation of
  window W must only remove shelf states of tabs that exist in W;
  the first E2E runs nuked the other window's shelf states through
  the global cleanup.
- **The donor TST client needed two more deviations** (documented in
  the file header): boolean response passthrough (the verbatim copy's
  unconditional `true` would cancel every `tryOperationAllowed` we
  subscribe to) and bulk-frame fan-out for `allowBulkMessaging`.
- **Firefox 158 Marionette takes `WebDriver:ExecuteScript` as a plain
  function body**; the donor harness's IIFE-with-`arguments` form
  silently returns null (probe: `tests/probe-mexec.mjs`).
- **The icon markup avoids `<button>`** (TST cancels native drags
  started on button/select/scrollbar targets) and re-enables
  `pointer-events` on `::part(shelf-icon)` (the below container is
  `pointer-events: none`).
