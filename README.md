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
the previous one. Shelved state survives restarts.

While shelved, a shelf's members are kept contiguous directly under
their owner (the newest put is the rightmost icon), moved with TST's own
`move-before`/`move-after`/`outdent`. Take a tab off the shelf and it
moves back to its pre-shelve place, planned from the neighbours and the
index recorded when it was put.

Full behavior contract: `openspec/` (changes `add-shelf-foundation`,
`remove-companion-patch`, `reveal-folded-owner-branch`; capabilities
`shelf-pinning`, `shelf-presentation`, `shelf-nesting`,
`shelf-interaction`).

## Why it is a stock-only addon

Tree Style Tab offers no way for an addon to remove a tab's row while keeping
the tab on screen, nor to make a row more than one line tall. 0.2.0 solved
both with a companion patch to TST (`row-less` as a tab state, `lines` on
`set-extra-contents`, a `tabbar-resized` notification). It was tested and
rejected in 0.2.3: it doubled every row-removal path in the addon, pinned the
E2E to a locally built TST, and cannot ship while TST is installed from AMO.

What that leaves:

- A member's row is removed by hiding the tab with `browser.tabs.hide()`, the
  only lever that takes a tab out of TST's renderable set without breaking its
  uniform-row arithmetic. A shelf therefore costs exactly one line, and the
  tree is exactly as tall as the same tree with those tabs deleted.
- A crowded shelf keeps one line and scrolls horizontally. `shelf-layout` and
  the multi-line layout are gone; `shelf-layout` in `storage.local` is ignored
  and left untouched.

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
- **Shelved tabs have no rows at all** (0.1.4): they are hidden with
  `browser.tabs.hide()`, the only lever that removes a tab from TST's
  renderable set without breaking its uniform-row arithmetic. A shelf
  therefore costs exactly one line, and the tree is exactly as tall as
  the same tree with those tabs deleted.
- **Members stay contiguous directly under their owner**, so the
  selected member's children appear right below the owner's row.
  Placement uses TST's own subtree-preserving move API
  (`move-before`/`move-after` with `followChildren`) — tree relations
  never change, non-member tabs keep their relative order, and
  take-off returns the tab to the position it had before shelving.
- **Icons carry the tab's tooltip** (title and URL), its favicon, a
  fold badge while the member has descendants — a plus, or the
  descendant count when the user selects count mode in the options
  (the same number TST writes as its subtree counter on tab rows,
  folded or unfolded) — and a highlight while the member or one of its
  descendants is active. A member that plays audio shows a sound glyph
  in its icon; a muted member shows the muted glyph, and clicking the
  glyph (not the icon) mutes or unmutes the tab without activating it.
  A member of a Firefox container shows the thin container color line
  on its icon (0.6.4) — the same notation regular tab rows carry, with
  the color tracked live: recoloring the container repaints the icons
  with no restart. Default-container and private tabs draw no line.
  Right-click opens the tab's own native context menu (TST routes
  `data-tab-id`), including the "Shelf" submenu with "Place leftmost"
  and "Place rightmost" for shelved tabs, and "Take off the shelf".
  Drags from an icon are TST-native tab drags with the whole subtree
  following.
- **Folding is delegated to TST**: putting a tab on the shelf sends
  `collapse-tree`; the close-confirmation dialog, the twisty state and
  restart persistence of the fold are TST's own machinery. The
  unfolded subtree survives unrelated tab activations (a narrow
  `try-collapse-tree-from-other-expansion` cancellation protects only
  shelved victims).
- **A folded owner reveals one branch only** (0.2.1): activating a tab
  from the shelf of a folded owner expands that owner — TST renders a
  child row only if every ancestor is expanded — but every descendant
  outside the activated tab's branch keeps no row, so an unshelved
  sibling of the shelf block does not appear out of a fold. The branch
  is anchored on the owner's direct child, so a nested shelf keeps the
  row its strap lives in. TST's own over-expansion (it expands the tab
  *and all its ancestors*) is cancelled only when a reveal takes over.
  Leaving the owner's subtree folds it back.
  - The other descendants are hidden with `browser.tabs.hide()` while the
    reveal lives. That state is tracked separately from shelved tabs,
    restored when the reveal ends, and released at boot if the browser
    stopped mid-reveal — a reveal never leaves a tab invisible.
  - Known limitation: a suppressed tab that owns its own shelf loses that
    shelf's strap while it is suppressed (a strap lives in its owner's
    row).
- **A member's row comes back the moment it is activated**: Firefox reveals
  a hidden tab when it becomes the active tab, so the row appears without
  the extension doing anything. It is hidden again — `rehideMembersNow`,
  measured at ~30 ms — the moment another tab takes the focus.
- **Grasping another tab does not fold the target shelf** (0.6.5): TST
  activates a pressed row on mousedown — long before its dragstart
  notification — which used to fold the shelved subtree the user was
  about to drag onto, so tabs could only be added to a shelf by taking
  the shelved tab off first. A *drag hold* now records the pre-press
  active branch at mousedown and keeps it renderable through the whole
  gesture: the shelved rows and their unfolded subtrees stay available
  as drop targets, and enclosing folded-owner reveals survive the grasp.
  Arming covers the active shelved tab itself with or without children —
  a childless member's single revealed row is the shelf's only drop
  surface, and without the hold it folded away at grasp (0.6.5 fix
  measured in the E2E drag phase).
  When the gesture resolves as a plain click or a canceled drag, the
  ordinary rules fold the branch again; when the drop lands inside the
  preserved subtree, the dragged tab's own activity keeps it open with
  no fold/reopen transition; when it lands elsewhere, the branch folds
  once, child-first. Dropping an active tab onto a folded shelved tab's
  visible row unfolds the target through TST's own attachment flow. The
  hold is runtime state only (no session key), and keyboard or
  programmatic activation keeps the pre-0.6.5 behavior exactly.
  Known limitation: a drop aimed at an *inactive folded member's
  favicon* still resolves to its owner row — TST reports no favicon
  target, see the implementation notes.
- **A failed tree export is retried** (0.2.2): TST's tree export failing
  once used to end a re-derivation silently, leaving the previous
  decision in force (a member could keep a stale decision). The pass now
  retries up to five times.
- **Workspace parity**: icons of tabs hidden by container-workspace
  extensions (e.g. tst-workspace) are not rendered; an empty shelf
  reserves no space. No messages are exchanged with them. A workspace
  filter that hides a shelf OWNER hides the whole shelf with it
  (0.6.1, lab-measured): the strap lives in the owner's row, so owner
  and strap vanish together, every member keeps its icons off and its
  tree position, and the shelf re-derives unchanged when the filter
  lifts. Re-rooting a member whose owner merely dropped out of TST's
  export once painted all foreign shelves onto the root shelf at the
  top of the sidebar and moved the members there — 0.6.0's bug.
- **Pinning ends shelving** (and "Put on shelf" is not offered for
  pinned tabs): Firefox pinning and shelving are mutually exclusive
  states — a pinned tab lives in the global pinned box, outside the
  tree, and a shelved flag would hide it from both places.
- **Hint mode (tab-hints)**: a keyboard command — default `Alt+U` (the
  earlier `Alt+Shift+H` default collided with the Help menu accelerator
  on Linux; rebind freely in about:addons' extension-shortcuts page) —
  labels the tabs that are actually on screen with a short code
  (`aa`, `ab`, …): shelf members' codes sit on their icons, shelf
  owners' codes sit on their shelf's strap — the same line as the
  member chips, one strap-gap left of the leftmost member icon — and
  rendered rows' codes at the row's inline-end top corner, vertically
  aligned with the shelves' rightmost icon chips. Type the code to
  activate
  the tab; unique prefixes narrow the labels — rows and icon chips
  together — Backspace un-types, Escape exits, and a few seconds of
  not typing ends the mode. Codes cover exactly the painted surfaces
  at entry — rendered rows and visible shelf icons; hidden tabs, tabs
  inside folded subtrees and rows outside the sidebar's viewport carry
  no code, so a mistyped code can never activate a tab you cannot
  see, and the codes stay 1-2 letters even in a 350-tab window of
  folded trees. A row scrolled out and back keeps its code; a row
  that first appears after entry shows none until you re-enter after
  scrolling. A closed sidebar makes the command a no-op, and so does
  a special active page: on `about:…`, extension pages (TST's group
  tabs among them) and every other page a key catcher can never be
  injected into (MDN), the command does nothing — such a mode could
  not receive keys from anywhere the user's focus already is, and
  while the exclusion option is on (the default, options page) those
  tabs carry no code either, so the keyboard can never navigate onto
  a page it would be stranded on. The code alphabet is configurable
  (options page); the default (`acqsew`) uses exactly the letters no
  default Vimium mapping starts with. The chip font size is
  configurable too (options page, 10-18px, default 12); a change
  applies live — chips already painted restyle at once, mid-mode
  included.
- **The hint command comes from the manifest's `commands` block.**
  Firefox registers it when the extension starts (XUL `key` elements in
  a per-window keyset; Firefox's ExtensionShortcuts.sys.mjs) and lists
  it on the "Manage Extension Shortcuts" page. If that page shows
  nothing for TST Shelf, the running session is not on a build with
  the `commands` block — reload the add-on or restart Firefox. User
  rebindings stored by Firefox survive updates and win over the
  manifest default, and a remap takes effect immediately (Firefox
  re-registers the keyset before emitting the change). A binding that
  another command or the desktop environment owns simply never fires;
  Firefox does not warn about collisions with its own menus.
- **Private windows do not receive the hint command.** Firefox skips
  key registration for a private window when the extension lacks
  `privateBrowsingAllowed` (ours does — it reads no private data);
  entering hint mode there is not offered.

## Permissions, honestly

- `tabs` — reading tab metadata (titles, URLs, favicons) for icons
  and tooltips.
- `tabHide` — shelved tabs are hidden so they take no row, and a reveal
  hides the siblings it suppresses; TST itself requests this permission
  for its own hidden-tab support. Taking a tab off the shelf shows it
  again.
- `menus` — the tab-context-menu items are the extension's OWN
  `browser.menus` items (see implementation notes): "Put on shelf",
  "Take off the shelf", and the "Shelf" submenu with "Place
  leftmost"/"Place rightmost"; they appear in the TST sidebar's tab
  menu and in the native tab bar's menu.
- `sessions` — the sticky shelved flag is a per-tab session value
  (`browser.sessions.setTabValue`); it survives restarts under
  session restore and travels with the tab across window moves.
- `storage` — a rolling diagnostics log (the last 80 boot events) and
  the user options (`badgeMode`, the fold badge mode; the hint
  options: alphabet, special-page exclusion, chip font size), nothing
  else.
- `commands` — the hint-mode hotkey. A single user-triggerable
  shortcut; it starts the label overlay for the focused window and is
  rebindable in about:addons.
- `activeTab` — granted by the hint command's own invocation (MDN: a
  commands-API shortcut grants activeTab, Firefox 63+). It is what lets
  the mode inject its key catcher into the active page — once per mode
  entry, into that one tab only, never at any other time. No install
  warning is shown for it, and it grants nothing else.
- No host permissions, no manifest content scripts, no network code:
  the extension has no way to send data anywhere. The one injected file
  (`hint-catcher.js`) runs only in the active tab, only while hint
  mode is up, only after the user invoked the command, and only
  forwards letters to the background.

## Caveats, measured in E2E
- **The hint command's keydown is delivered where Firefox delivers it.**
  A registered command is a XUL `key` in the browser window's keyset;
  Firefox fires it for keys pressed while a normal web page or the
  browser chrome (address bar, menus) has focus. If the key seems dead,
  first click a web page tab and press the key there — with all of the
  focus options exhausted, read the bootlog:
  `about:debugging#/runtime/this-firefox` → TST Shelf → Inspect →
  `browser.storage.local.get("bootlog").then(r => console.log(r.bootlog.slice(-12)))`.
  `hints-command-fired` appears the moment Firefox delivers the command;
  `hints-decline <reason>` explains a declined entry; nothing at all in
  the bootlog means the keypress never reached the extension (a
  Firefox-side delivery problem, reported to Bugzilla, not ours).
- **Hint-mode key capture runs on two channels.** Vimium's link hints
  work because their key listener lives in the page the user types
  into; the same mechanism is ported: on every mode entry a tiny
  on-demand key catcher (`hint-catcher.js`) is injected into the
  window's active tab — legal without host permissions, because the
  command's own invocation grants `activeTab` (MDN: a commands-API
  shortcut, Firefox 63+), and activeTab is exactly what covers
  `tabs.executeScript` in MV2. The catcher forwards the code letters
  to the background and suppresses them from the page (modifier combos
  like Ctrl+L pass through untouched); it tears itself down on the
  mode's exit message, and an orphan answers its own first key with a
  teardown. The sidebar's own channel stays for when the tree has the
  focus: a zero-size catcher span rides the root strap, receives
  `focus-to-extra-contents`, and every keydown in it arrives as
  `extra-contents-keydown`. The first key of either channel confirms
  the mode (Firefox 158 does not dispatch focus/blur for shadow-
  internal targets — measured), and the bounded timeout tears an
  unconfirmed mode down with nothing painted. Pages the injection
  cannot touch split in two: pages Firefox rejects outright —
  top-level `about:` frames and extension pages, the TST group tabs
  among them (MDN) — DECLINE the entry itself (`hints-decline
  active-tab-not-injectable` in the bootlog; no mode, no labels, and
  with the exclusion option on, no codes on such tabs either); pages
  that merely fail at arming — the PDF viewer, reader view — enter,
  log `hints-arm-fail`, and keep the sidebar channel: click a row in
  the tree first, then type.
- **Vimium and other page-keyboard extensions.** Vimium hangs its
  keydown listener on `window` with capture and consumes every key it
  maps before any other listener in the page can see it (measured in
  the Vimium sources: `stopImmediatePropagation` on mapped keys) — a
  hint code built from a letter Vimium maps would be eaten as typed.
  The default alphabet `acqsew` is exactly the six lowercase letters
  no default Vimium mapping starts with, so with stock Vimium nothing
  collides; while hint mode is armed, the catcher also suppresses
  EVERY printable key from the page, so Vimium's normal mode cannot
  react to hint typing either. If your Vimium (or any other
  extension's) keymap differs, the alphabet field on the options page
  takes any two or more distinct letters or digits.
- **The drag lifecycle, measured** (0.6.5, the E2E drag phase): TST
  activates a pressed row inside its `promisedMousedownNotified.then`,
  i.e. right after the extension's `tab-mousedown` reply — so any
  preservation must arm at mousedown; by `native-tab-dragstart`
  (broadcast from TST's HTML5 `dragstart` handler) the rows are already
  moving. The other measured facts the hold leans on: a same-sidebar
  drop's `tree-attached` lands AFTER `native-tab-dragend`
  (the settle must not release on dragend alone); TST tears its drag
  session down `setTimeout(0)`-style within `onDrop`, so a dragend
  arriving later than a frame reads "already handled by ondrop" and is
  never broadcast; the row a press resolves through is the
  `tab-item-substance` element (a press on the bare `tab-item` host is
  reported as a `tabbar-mousedown`, not a `tab-mousedown`); and a
  drop onto a folded shelved row reports `parentFolded=false` when
  TST's own `forceExpand` already unfolded the target — the recorded
  fold then comes from the pre-attach cached tree. A plain click keeps
  its old branch only until mouseup (~120 ms debounce after release);
  keyboard/programmatic activation folds immediately as before. The
  settled quiet window is 400 ms after drag end and the last structural
  event, bounded by 3 s, with a 10 s pending and a 90 s dragging
  watchdog.
- **A trusted native drag stays a manual check.** Marionette cannot
  produce an OS-level HTML5 drag session in a headless Firefox
  (measured — pointer actions produce no dragstart), so the E2E drag
  phase drives TST's REAL sidebar handlers with synthetic,
  `DataTransfer`-carrying `mousedown → dragstart → dragover → drop →
  dragend` chains (composed events inside TST's actual document, the
  same notifications and commands a real drag raises), and one trusted
  GUI drag per scenario is verified by `make iso-tst` runs. The
  synthetic chain is faithful in ordering (the `tree-attached` after
  `dragend` inversion above was measured with it), but it is not an
  OS drag: treat any surprising real-drag report as suspect even when
  the E2E stays green.
- **Extra-contents writes have no reply.** Every extra-contents case in
  tst-api-frontend.js ends with a bare `return`, and the runtime reply
  race leaves some send promises settled late or never. The row-label
  ledger is intent-tracked for that reason; the strap ledger keeps the
  acknowledged semantics (a failed clear is retried by the
  vanished-shelves loop), and both are idempotent re-send safe.


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
  into the flow and the shelf loses its compaction (geometry stays
  correct — the rows are counted and painted at full height). Between
  this option and Firefox's rule that an activated hidden tab stays
  visible, "a shelved tab has no row in the tree" is a promise the
  extension cannot keep unconditionally: it holds under TST's default
  settings and while the tab is not active. The contract therefore
  guarantees the weaker, checkable form — the shelf lives inside the
  owner's row and never adds one — and this README is the documented
  limitation of the stronger reading.
- **Variable row heights vs TST's virtual scroll** (historical, 0.1.3
  and earlier): TST computes the scroll extent as rendered-count ×
  `--tab-size`; owner rows that grew and CSS-hidden member rows drifted
  the pixel stack. 0.1.4 conforms — every rendered row keeps the
  uniform height — and the E2E asserts the arithmetic row by row.
  Open task 7.2 is the 350-tab performance pass. The multi-line row
  height of 0.2.0 (a companion patch) is gone for the same reason: it
  required TST to paint and to compute positions from line counts.
- **Private windows are untouched.** TST refuses external messages
  about private tabs unless the user enables both "Allow in private
  windows" and TST's own permission checkbox.
- A shelved tab's strap can briefly flash on a reused row element
  under virtual scroll (TST's pooled-element reinsert) until the
  `tabs-rendered` restore re-sends it.

## Build, testing and development

```
make deps    # npm install (esbuild + web-ext)
make build   # bundle background, copy assets -> dist/   (production)
make test    # unit tests: logic, renderer, markup (node --test)
make perf    # 350-tab pure-derivation gate (tests/perf.mjs)
make watch   # rebuild dist/ on source changes; pair with make run
make run     # dev Firefox with auto-reload, clean throwaway profile
make lint    # web-ext lint over dist/
make verify-dist # assert dist/ is a production tree, not the E2E flavor
make xpi     # web-ext-artifacts/tst_shelf-<version>.zip

make fixture # clean profile + TST only (tests/fixture.sh, idempotent)
make iso-tst # throwaway GUI Firefox on that profile + this extension
make e2e     # the headless E2E run against the stock TST fixture
make release # unit tests, the E2E run, then a CLEAN build + lint + xpi
```

Two build flavors, two directories: `dist/` is production and the only
tree `web-ext` ever packs; `dist-e2e/` is the test build (smoke page,
`-e2e` version, `downloads` permission) that `make e2e` installs.  A
release re-builds `dist/` from scratch after the E2E runs and refuses to
pack it unless `scripts/verify-dist.mjs` confirms it carries no test
files, no `-e2e` version and no `downloads` permission.

### The E2E harness (Marionette, headless)

`make e2e` runs the driver against the stock Tree Style Tab of the fixture
profile (`tests/fixture.sh` sideloads the signed AMO release).  It launches
an isolated headless Firefox on a copy of that profile, temporary-installs
`dist-e2e/` via Marionette's `Addon:Install`, and runs three phases:

1. **Setup** — the smoke page (`tests.html?auto=1`, only shipped in
   `-e2e` builds) builds a tree A ← (B, C, D), C ← (c1, c2), plus a
   root tab E, puts B and C on A's shelf and E on the root shelf, and
   asserts the state machine (sticky session values, shelf
   derivation, tab order, badge-on-descendants, native
   subtree-collapsed, take-off, the Shelf submenu's visibility, the
   "Place leftmost"/"Place rightmost" swings) — then downloads a
   setup report.
2. **Sidebar DOM** — the driver opens TST's own sidebar page in a tab
   (`sidebar/sidebar.html?windowId=N`, where TST runs its complete
   sidebar including the extra-contents shadow roots), asserts the
   rendered shelves (row state classes, icons with `data-tab-id`,
   title tooltips, favicon styles, draggable, the fold badge, the
   root strap), the count mode (flip through the internal hook —
   every badge becomes the descendant number, and back), and the
   muted glyph (mute through the hook; then a synthetic mousedown on
   the glyph itself, which must unmute without activating the tab),
   then dispatches synthetic mousedown events on the
   shelf icons; the smoke page asserts the selection choreography
   (C activates and unfolds, its children render below the strap;
   clicking B refolds C — one subtree per shelf).
3. **Reinstall** — `Addon:Install` into the same session (runtime
   state wiped, session values intact) — the restarted smoke page
   must rebuild the shelved set from session values and re-land the
   derivation: the restart-persistence proxy (temporary installs
   never survive a real restart; the boot path is identical).

Exit code 0 means every assertion passed.  Every assertion in the driver
goes through one `check(name, ok, detail)` function, which prints, records
and sets the exit status; a check cannot print FAIL and leave the run
green.  Two consecutive clean runs are required before merging.
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
- **Shelf icons adopt TST's container marker (0.6.4)** — the thin
  vertical color line Firefox and TST paint on rendered rows of
  container (contextual identity) tabs. A shelved member has no row,
  so its icon cell carries the equivalent instead: a passive, zero-
  behavior `shelf-marker` span, first among the cell's children so the
  badge, the sound glyph and hint chips paint over it where they
  overlap. Three TST internals, verified in 4.4.10, carry the feature:
  - *The palette* — `updateContextualIdentitiesStyle`
    (sidebar/sidebar.js:496-510) declares
    `--contextual-identity-color-<cookieStoreId>` on the sidebar root
    for every real container and rebuilds it on every containers
    change (onUpdated), so the icons' color is a live CSS reference,
    never a value copied at render time. `firefox-default` and
    `firefox-private` are not containers: no variable exists for
    either, the markup emits no span for them, and the
    `transparent` fallback inside the var reference degrades any
    unknown cookieStoreId to *no line* rather than a wrong color.
  - *The palette var name prefix* `--contextual-identity-color-` is
    TST-internal and pinned to the 4.4.10 reading above; a future TST
    rename degrades to no line, never to a crash.
  - *The geometry* — the base bar is TST's own
    `.contextual-identity-marker` (sidebar/styles/base.css:1252-1261):
    cross-section `calc(var(--favicon-size) / 8)`, the row's
    marker-margin formula `min((current - favicon) / 2, current *
    0.15)` with `current` replaced by the icon cell's
    `--faviconized-tab-size`, so the line spans the favicon's height
    the way it does on a pinned row. The proton branch shifts the bar
    inward by `--tab-highlighter-size` under
    `:root[data-style="proton"].regular/.inverted` (proton.css:457);
    the nova branch replaces the bar with a horizontal accent
    (nova.css:466-500). The active theme key is read from TST's own
    `document.documentElement.dataset.style` (sidebar.js:380).
    *Caveat:* Nova's row marker uses CSS anchor positioning against
    the row's pill; the icon accent approximates its offsets (the
    faviconized margins), so under Nova the icon line is an
    approximation of the row marker's position — same color, same
    cross-section — while Proton-family themes get the exact
    geometry. The headless E2E asserts both branches ship in the
    registered style and that the branch of the active theme is
    present; the visual parity per theme is a GUI check (`make
    iso-tst`).
- **Shelf icons keep the last known favicon while their tab reloads**
  (Firefox reports no `favIconUrl` for a navigating tab; TST's rows
  are sticky the same way — the background only propagates explicit
  `favIconUrl` changeInfo, and a row's `_favIconUrl ||= raw.favIconUrl`
  never lets a null win). The background threads a per-session
  favicon memory through every `tabs.query` (`resolveFavicons`,
  logic.esm.js); the diffing renderer then emits an unchanged strap
  during the load, so the sidebar never drops the style attribute.
  Measured on Firefox 158 (tests/probe-favicon.mjs, timeline in
  2026-11-21-fixes/favicon-probe.json):
  - a navigation that cannot reach the site settles as `status:
    complete` with `favIconUrl = chrome://global/skin/icons/info.svg`
    — the error page's own icon, which is exactly the "circled i" —
    while `tab.url` still names the site. A delivery of such a
    placeholder never overwrites the memory and never wins the render:
    the icon keeps the previous page's favicon.
  - a page that loads successfully with no favicon delivers nothing at
    all; when its url is an HTTP(S) url of another origin at `complete`,
    the remembered icon is dropped (a stale site icon must not lie).
    Internal pages (about:blank, extension pages) are not site
    documents — the remembered icon stays.
  - `data:` favicons are real site favicons on this Firefox (the probe's
    `<link rel="icon">` page was reported as
    `data:image/svg+xml;base64,…`); they are never treated as
    placeholders.
  - Still undetectable from the background: an icon that fails to
    *decode* (a 404 icon, corrupt SVG) — a `background-image` load
    failure is invisible without content scripts. Documented as out of
    scope.
- **Shelf icons mark audio** the same way Firefox marks media tabs:
  `tab.audible` shows a sound glyph, `tab.mutedInfo.muted` a muted
  one; clicking the glyph toggles the mute (the mousedown payload's
  `originalTargetPart` names the glyph's part, verified in TST 4.4.10
  tst-api-frontend.js). Measured: headless Firefox 158 never reports
  `audible: true` for a playing `<audio loop>` page, so the playing
  glyph is asserted on unit tests and GUI — the muted one is fully
  headless-E2E'd.
- **The tab context menu carries a "Shelf" submenu** with "Place
  leftmost"/"Place rightmost" for shelved tabs. Pointer reordering
  INSIDE the strap remains out of reach on stock TST 4.4.x: no
  dragover/drop notifications exist for addon extra contents, and no
  extra-contents event carries pointer coordinates
  (drag-and-drop.js:868-871, event-utils.js:69-77) — the menu commands
  and a native TST icon drag (drop onto the shelf owner = subtree
  reattach) are the available reorder paths until upstream gains
  drop-target notifications for extra contents.
- **A drop aimed at an inactive folded member's favicon cannot reach
  that member** (0.6.5): TST's `SidebarItems.getItemFromDOMNode`
  (sidebar-items.js:78-85) resolves a drop target through the closest
  `tab-item-substance`, so an icon inside an owner's row resolves to
  the OWNER row and no notification carries the icon — a favicon drop
  lands as an owner-row drop, same as it did before drag preservation
  existed. The 0.6.5 hold preserves the active member's OWN row while a
  drag is under way (arming covers shelved members with children and
  childless ones alike), so the folded *regular row* is a valid drop
  target; the folded *favicon*
  is not a target of its own. Exposing it needs one of two upstream
  changes: temporarily rendering folded members as rows during a drag
  (rejected: reintroduces row-height work at 350-tab scale), or TST
  routing extra-contents drop targets to companions.
- **The E2E drag phase presses `tab-item-substance`, never the row**:
  TST's `getTreeItemFromEvent` resolves through
  `getItemFromDOMNode(node.closest('tab-item-substance').raw)`
  (sidebar-items.js:78-85), and a press dispatched on the bare
  `tab-item` host falls through to the tabbar fallback — the
  notification then arrives as `tabbar-mousedown` (no `tab-mousedown`
  at all, measured). Icon presses are dispatched on the icon element
  itself, whose `data-drag-data` (`{type: 'tab', data: {id, asTree}}`)
  drives TST's `detectOverrideDragDataSet` override of the dragged
  item (drag-and-drop.js:869-929).
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
