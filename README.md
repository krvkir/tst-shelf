# tst-shelf

A [Tree Style Tab](https://github.com/piroor/treestyletab) companion
extension that puts tabs of a project subtree on "shelves": favicon
straps rendered directly under the shelf owner's row. A shelf compresses
the constant tabs of a subtree into a dense icon line, folds their
subtrees until selected, and keeps the rest of the tree untouched.

Put two tabs of a project on their parent's shelf and the parent's row
grows a 28-px strap with their favicons; the shelved rows disappear;
their children fold. Click an icon — its tab activates and its subtree
unfolds below the strap; clicking another icon of the same shelf folds
the previous one. Shelved state survives restarts. Take a tab off the
shelf and it returns to the exact place it had — the tree was never
moved.

Full behavior contract: `openspec/` (changes `add-shelf-foundation` and
`add-discrete-row-geometry`, capabilities `shelf-pinning`,
`shelf-presentation`, `shelf-nesting`, `shelf-interaction`,
`companion-capabilities`).

## Two capabilities it can use, and does without

Two things the shelf really wants are impossible from an addon on a stock
Tree Style Tab, so they live in a companion patch to TST itself
(`docs/tst-row-geometry-patch.md`, applied in a local clone of TST; the
addon never requires it):

| capability | what it enables | without it |
|---|---|---|
| **row-less tabs** (`row-less` state) | a shelved tab has no row while staying visible to the browser — no `hidden`, no reveal on activation, no `tabHide` | members are hidden with `browser.tabs.hide()`, and Firefox reveals the one you activate |
| **rows of N whole lines** (`lines` on `set-extra-contents`) | a crowded shelf grows its owner row in whole lines, so every icon stays visible | the shelf stays on one line and scrolls horizontally |

The patch is detected from TST's version (`>= 4.5`); the test build marks
itself, the upstreamable diff carries no version bump. `tests/patch-tst.sh`
builds it from the AMO release plus the patch, and the E2E runs the whole
suite against **both** builds — that is what keeps the fallbacks honest.

### What changes with the patch

- A childless shelved tab has **no row at all**, even while it is the
  active tab. Its icon is its presentation: right-click it for the tab's own
  menu, middle-click to close, hover for the title. Nothing in the tree
  moves when you select it.
- A shelved tab **with children keeps its row while it is active** (that row
  is what its subtree hangs from) and loses it when you select something
  else — after its subtree has folded, so no frame shows a child without a
  parent.
- A shelf that does not fit into 2/3 of the tab bar grows: 2 lines, 3 lines,
  and so on, with the icons laid out in exactly that many rows. Icons are
  never hidden behind a scroll.
- **No tab is hidden** while the capability exists: the `tabHide` permission
  is declared for the fallback only.

### The one setting

`shelf-layout` in the extension's storage: `auto` (default) extends the row
when the capability exists and scrolls otherwise, `extend` always prefers
extending, `scroll` always keeps one line and scrolls.

## What it does

- **Put on shelf / Take off the shelf** items in the TST tab context
  menu. Shelving is a sticky per-tab flag: drags between shelves, drops
  on shelf-less tabs (their shelf auto-creates), re-parenting and
  window moves re-derive the target shelf; only the explicit
  "Take off the shelf" action ends shelving.
- **The shelf lives INSIDE the owner's row** (0.1.4): the owner keeps
  its twisty, favicon and title on the left; the shelf's icons sit on
  the right of the same line, take at most 2/3 of the row and scroll
  horizontally past that. The title truncates with an ellipsis and
  TST's tab tooltip still shows it in full on hover. The row keeps its
  normal height, so nothing about TST's drag-and-drop geometry changes.
  Shelved root tabs go on the root shelf, a fixed strap at the top of
  the tab bar (TST renders `tabbar-top` above the global pinned box —
  the below-pinned placement needs an upstream TST slot; recorded in
  the openspec design). A newly shelved tab becomes the rightmost
  icon.
- **Shelved tabs have no rows at all** (0.1.4): on a stock TST they are
  hidden with `browser.tabs.hide()`, the only lever that removes a tab
  from TST's renderable set without breaking its uniform-row
  arithmetic; on a TST with the `row-less` capability they are marked
  instead, which needs no hiding at all (0.2.0). A shelf therefore
  costs exactly one line, and the tree is exactly as tall as the same
  tree with those tabs deleted.
- **Members stay contiguous directly under their owner**, so the
  selected member's children appear right below the owner's row.
  Placement uses TST's own subtree-preserving move API
  (`move-before`/`move-after` with `followChildren`) — tree relations
  never change, non-member tabs keep their relative order, and
  take-off returns the tab to the position it had before shelving.
- **Icons carry the tab's tooltip** (title and URL), its favicon, a
  plus badge while the member's subtree is folded, and a highlight
  while the member or one of its descendants is active. Right-click
  opens the tab's own native context menu (TST routes `data-tab-id`),
  including "Take off the shelf". Drags from an icon are TST-native
  tab drags with the whole subtree following.
- **Folding is delegated to TST**: putting a tab on the shelf sends
  `collapse-tree`; the close-confirmation dialog, the twisty state and
  restart persistence of the fold are TST's own machinery. The
  unfolded subtree survives unrelated tab activations (a narrow
  `try-collapse-tree-from-other-expansion` cancellation protects only
  shelved victims).
- **A folded owner reveals one branch only** (0.2.1, both companions since 0.2.2): activating a tab
  from the shelf of a folded owner expands that owner — TST renders a
  child row only if every ancestor is expanded — but every descendant
  outside the activated tab's branch keeps no row, so an unshelved
  sibling of the shelf block does not appear out of a fold. The branch
  is anchored on the owner's direct child, so a nested shelf keeps the
  row its strap lives in. TST's own over-expansion (it expands the tab
  *and all its ancestors*) is cancelled only when a reveal takes over.
  Leaving the owner's subtree folds it back.
  - *With the `row-less` capability* the other descendants keep their
    browser state: only the row goes, nothing is hidden.
  - *On a stock TST* (0.2.2) the only lever is `browser.tabs.hide()`, so
    the other descendants are hidden while the reveal lives. That state
    is tracked separately from shelved tabs, restored when the reveal
    ends, and released at boot if the browser stopped mid-reveal — a
    reveal never leaves a tab invisible.
  - Known limitation on both paths: a suppressed tab that owns its own
    shelf loses that shelf's strap while it is suppressed (a strap lives
    in its owner's row).
- **A member's row comes back the moment it is activated** (0.2.2): the
  row-less state lives in TST's model, so the row appears only when the
  state is removed — waiting for the debounced re-derivation left the
  children hanging under nothing for that window. Childless members keep
  no row at all.
- **A failed tree export is retried** (0.2.2): TST's tree export failing
  once used to end a re-derivation silently, leaving the previous
  decision in force (a member could keep a stale row-less claim). The
  pass now retries up to five times.
- **Workspace parity**: icons of tabs hidden by container-workspace
  extensions (e.g. tst-workspace) are not rendered; an empty shelf
  reserves no space. No messages are exchanged with them.
- **Pinning ends shelving** (and "Put on shelf" is not offered for
  pinned tabs): Firefox pinning and shelving are mutually exclusive
  states — a pinned tab lives in the global pinned box, outside the
  tree, and a shelved flag would hide it from both places.

## Permissions, honestly

- `tabs` — reading tab metadata (titles, URLs, favicons) for icons
  and tooltips.
- `tabHide` — on a stock TST, shelved tabs are hidden so they take no
  row; TST itself requests this permission for its own hidden-tab
  support. Taking a tab off the shelf shows it again. On a TST with the
  `row-less` capability the extension never calls it: members are marked
  instead of hidden, and no tab leaves the screen.
- `menus` — the two tab-context-menu items are the extension's OWN
  `browser.menus` items (see implementation notes); they appear in
  the TST sidebar's tab menu and in the native tab bar's menu.
- `sessions` — the sticky shelved flag is a per-tab session value
  (`browser.sessions.setTabValue`); it survives restarts under
  session restore and travels with the tab across window moves.
- `storage` — a rolling diagnostics log (the last 80 boot events),
  nothing else.
- No host permissions, no content scripts, no network code: the
  extension has no way to send data anywhere.

## Caveats, measured in E2E

- **Session-value persistence requires session restore.** Without
  `browser.sessionstore` the tabs themselves do not come back, so the
  loss of shelved flags is indistinguishable from the loss of the
  session.
- **The favicon route works** (task 2.4 of the openspec tasks): the
  `style` attribute of extra contents survives TST's DOMPurify pass —
  `background-image: url(...)` renders favicons without host
  permissions (verified in the shipped TST 4.4.x by the E2E).
- **The active tab and its ancestors always keep their rows.** Firefox
  reveals a hidden tab when it becomes the active tab and refuses to
  hide the active tab again (`tabs.hide` resolves with `[]`; MDN lists
  the active tab as ineligible). A hidden tab's descendants are not
  rendered either, so the extension also keeps every *ancestor* of the
  active tab visible: activating a tab of a nested shelf therefore keeps
  the nested shelf's owner on screen, with its strap. A member's row is
  reclaimed as soon as nothing depends on it, and a member whose children
  are folding away keeps its row until the animation ends (300 ms guard)
  so no frame shows children without their parent.
- **A shelf tab's subtree is unfolded only while its own row is shown.**
  Activating a tab that is neither the shelf tab nor one of its
  descendants reclaims the shelf tab's row, so its children fold first
  and the row goes away after them: no frame shows a child row with no
  parent above it. (0.1.6 collapsed the subtree only when another tab of
  the *same shelf* was selected, so switching to a plain sibling left the
  children dangling under the shelf owner's row — user-reported, fixed in
  0.1.7 and gated by an E2E frame sampler.)
- **Switching between two shelf tabs moves the tree at most one frame.**
  The swap cannot be atomic — the browser reveals the incoming tab, the
  extension hides the outgoing one, and TST paints them in separate
  frames — so the rows below the shelf shift by one row for 0–34 ms and
  end exactly where they started. Two childless members swap in place
  (measured: 0, 1 and 2 frames across E2E runs).
- **Hiding is shared with other extensions.** A shelved tab is hidden
  through the same mechanism tst-workspace uses for container
  filtering. The extension re-applies its hides on every derivation
  and remembers which hides are its own (in the tab's session value),
  so a workspace switch visibly restores our tabs for at most one
  debounce and never makes a foreign-filtered tab appear on a shelf.
  Do not enable TST's expert option "Show hidden tabs which are hidden
  by other extensions" (`renderHiddenTabs`): it puts shelved tabs back
  into the flow and the shelf loses its compaction.
- **Variable row heights vs TST's virtual scroll** (historical, 0.1.3
  and earlier): TST computes the scroll extent as rendered-count ×
  `--tab-size`; owner rows that grew and CSS-hidden member rows drifted
  the pixel stack. 0.1.4 conforms — every rendered row keeps the
  uniform height — and the E2E asserts the arithmetic row by row.
  Open task 7.2 is the 350-tab performance pass.
- **Private windows are untouched.** TST refuses external messages
  about private tabs unless the user enables both "Allow in private
  windows" and TST's own permission checkbox.
- A shelved tab's strap can briefly flash on a reused row element
  under virtual scroll (TST's pooled-element reinsert) until the
  `tabs-rendered` restore re-sends it.

## Build, testing and development

```
make deps    # npm install (esbuild + web-ext)
make build   # bundle background, copy assets -> dist/
make test    # unit tests for the derivation logic (node --test)
make watch   # rebuild dist/ on source changes; pair with make run
make run     # dev Firefox with auto-reload, clean throwaway profile
make lint    # web-ext lint over dist/
make xpi     # web-ext-artifacts/tst_shelf-<version>.zip

make fixture # clean profile + TST only (tests/fixture.sh, idempotent)
make iso-tst # throwaway GUI Firefox on that profile + this extension
make e2e     # full headless E2E against the TST fixture (see below)
make release # build, lint, unit, e2e, xpi
```

### The E2E harness (Marionette, headless)

`make e2e` launches an isolated headless Firefox on a copy of the
fixture profile (Tree Style Tab only), temporary-installs `dist/` via
Marionette's `Addon:Install`, and runs three phases:

1. **Setup** — the smoke page (`tests.html?auto=1`, only shipped in
   `-e2e` builds) builds a tree A ← (B, C, D), C ← (c1, c2), plus a
   root tab E, puts B and C on A's shelf and E on the root shelf, and
   asserts the state machine (sticky session values, shelf
   derivation, tab order, badge-on-fold, native subtree-collapsed,
   take-off) — then downloads a setup report.
2. **Sidebar DOM** — the driver opens TST's own sidebar page in a tab
   (`sidebar/sidebar.html?windowId=N`, where TST runs its complete
   sidebar including the extra-contents shadow roots), asserts the
   rendered shelves (row state classes, icons with `data-tab-id`,
   title tooltips, favicon styles, draggable, the plus badge, the
   root strap), then dispatches synthetic mousedown events on the
   shelf icons; the smoke page asserts the selection choreography
   (C activates and unfolds, its children render below the strap;
   clicking B refolds C — one subtree per shelf).
3. **Reinstall** — `Addon:Install` into the same session (runtime
   state wiped, session values intact) — the restarted smoke page
   must rebuild the shelved set from session values and re-land the
   derivation: the restart-persistence proxy (temporary installs
   never survive a real restart; the boot path is identical).

Exit code 0 means every assertion passed (currently 55 across the
three phases; two consecutive clean runs required before merging).
`node tests/probe-mexec.mjs` is a standalone probe for Marionette
`ExecuteScript` semantics on the current Firefox build.

## Implementation notes (verified against TST 4.4.10 sources)

- **THE UNIFORM-ROW LAW (0.1.3): TST never measures painted rows.**
  Drop zones, virtual scroll and sticky rows all COMPUTE geometry as
  `renderedTabHeight * index over renderable items`
  (`Scroll.getItemRect`, scroll.js:664-716; the drag zones quarter
  that rect, drag-and-drop.js:458-500). Every renderable row must
  therefore paint at exactly one `--tab-size`: 0.1.1 grew owner rows
  (strap as a second line) and collapsed member rows (negative
  margin), shifting every computed rect below each shelf by
  `39*members + strap extra` — drops there always landed as siblings
  and the attach marker stopped appearing. No CSS layout can both
  save member-row space and keep the arithmetic true (space saved =
  drift). 0.1.3 conforms: every row keeps the default height, member
  rows stay in the flow as blank boxes, and the strap renders inside
  the FIRST member's row (host state `tst-shelf-host`), wrapped lines
  spilling visually (`overflow: visible` on the below container)
  across the blank member rows. The E2E replays TST's arithmetic in
  the sidebar as a permanent conformance gate.
- **TST has three tab orders that disagree for ~250 ms after every
  internal move**: the physical strip, TST's internal index order,
  and the children-array walk that `get-light-tree` returns and the
  sidebar RENDERS. Without `doNotOptimize`, `move-before` updates the
  internal orders synchronously but defers the physical move by a
  250 ms debounce (tabs-move.js `syncToNativeTabs`). Shelf placement
  plans and derives in the walk order — planning against physical
  indices spun 40 moves into the guard on every put.
- **Shelf icons keep the last known favicon while their tab reloads**
  (Firefox reports no `favIconUrl` for a navigating tab; TST's rows
  are sticky the same way — the background only propagates explicit
  `favIconUrl` changeInfo, and a row's `_favIconUrl ||= raw.favIconUrl`
  never lets a null win). The background threads a per-session
  favicon memory through every `tabs.query` (`resolveFavicons`,
  logic.esm.js); the diffing renderer then emits an unchanged strap
  during the load, so the sidebar never drops the style attribute.
- **The only stored state is the sticky flag** (`tst-shelf` session
  value). Shelf membership, hosts, badges, highlight and selection
  are derived from TST's light tree + `browser.tabs` on every
  structural event (debounced, whole-window, idempotent diff against
  what was last applied).
- **Tab-menu items are the extension's OWN `browser.menus` items**,
  not `contextMenu-create` registrations. Verified against TST
  4.4.9/4.4.10: `contextMenu-create` items are created
  `visible: false` and no TST code path ever flips them for a plain
  tab-row menu (`onShown`'s main body updates only TST's own items;
  `contextMenu-update` strips `visible` outside an owner-matched
  override). tst-more-tree-commands, the reference helper, uses raw
  `browser.menus` for the same reason; `overrideContext({context:
  'tab'})` shows every extension's `contexts: ['tab']` items. Two
  Firefox facts the linter/E2E taught us: `browser.menus.getAll`
  does not exist (track created items yourself), and native menus
  open only for trusted events — the headless E2E drives the
  `menus.onShown` visibility logic through an internal hook instead
  (item delivery itself is verified on a GUI Firefox).
- **The diagnostics log is write-serialized.** Two in-flight
  `logBoot` calls used to race (unsynchronized read-modify-write on
  `storage.local`) and silently dropped each other's entries — at
  cold boot the first IndexedDB open is slower than the TST
  handshake, so `boot-shelved` lost to `tst-registered` almost every
  session, making healthy boots look like stale installs in the log.
- **`windowId` is load-bearing in every TST request.** TST's
  `getTargetTabs` falls back to the *last focused window* without it;
  in an unfocused/headless session that resolves to a window whose
  active tab is null, and the request silently processes zero tabs
  while answering `true` (caught by the E2E after the model probe
  showed states that resolved-true but never landed).
- **Multi-window derivations must not touch foreign states**: the
  renderer's state cleanup only removes states of tabs that belong to
  the derived window — a global cleanup nuked the other window's
  shelf states in the first E2E runs.
- **Marionette `WebDriver:ExecuteScript` takes a plain function
  body** on Firefox 158 — the IIFE-with-`arguments` form used by the
  donor harness silently returns `null` (probed in
  `tests/probe-mexec.mjs`).
- The donor TST API client (`src/background/tst-api.esm.js`,
  verbatim from tst-search via tst-workspace) carries three
  documented deviations: register-response shape validation
  (inherited), boolean response passthrough (TST's
  `tryOperationAllowed` cancels when any listener resolves truthy —
  the verbatim copy's unconditional `true` would have frozen TST's
  collapse UX), and bulk-frame fan-out (`{messages: [...]}` from
  `allowBulkMessaging`).

## Donors and attribution

- [tst-search](https://github.com/NiklasGollenstede/tst-search) by
  Niklas Gollenstede: `src/background/tst-api.esm.js` is a copy
  (MPL-2.0) of its TST external-API client with the documented
  deviations above.
- [tst-workspace](https://github.com/piroor/treestyletab/wiki) (this
  machine's earlier companion addon): build pipeline, E2E harness
  layout (fixture profile + Marionette driver + smoke page +
  downloads-channel reports), and the console-mirror pattern.
- [Tree Style Tab](https://github.com/piroor/treestyletab) by
  YUKI "Piro" Hiroshi: contract reference only, no code copied.

Specs live in `openspec/` (change `add-shelf-foundation`).
