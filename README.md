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

Full behavior contract: `openspec/` (change `add-shelf-foundation`,
capabilities `shelf-pinning`, `shelf-presentation`, `shelf-nesting`,
`shelf-interaction`).

## What it does

- **Put on shelf / Take off the shelf** items in the TST tab context
  menu. Shelving is a sticky per-tab flag: drags between shelves, drops
  on shelf-less tabs (their shelf auto-creates), re-parenting and
  window moves re-derive the target shelf; only the explicit
  "Take off the shelf" action ends shelving.
- **Shelves render as favicon straps** under the owner's row (TST
  extra contents, place `tab-below`); shelved root tabs go on the
  root shelf, a fixed strap at the top of the tab bar (TST renders
  `tabbar-top` above the global pinned box — the below-pinned
  placement needs an upstream TST slot; recorded in the openspec
  design). Icons wrap into more rows when they do not fit.
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
- **Variable row heights vs TST's virtual scroll.** TST computes the
  scroll extent as rendered-count × `--tab-size`; CSS-hidden shelved
  rows and auto-height owner rows drift the pixel stack (design.md,
  risks). The drift is bounded by the number of shelf rows in the
  rendered viewport; the designed fallback (quantized owner heights)
  is not needed for v1 trees of the tested size but remains in the
  task list for the 350-tab performance pass.
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

Exit code 0 means every assertion passed (currently 45 across the
three phases; two consecutive clean runs required before merging).
`node tests/probe-mexec.mjs` is a standalone probe for Marionette
`ExecuteScript` semantics on the current Firefox build.

## Implementation notes (verified against TST 4.4.10 sources)

- **The only stored state is the sticky flag** (`tst-shelf` session
  value). Shelf membership, ghosts, badges, highlight and selection
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
