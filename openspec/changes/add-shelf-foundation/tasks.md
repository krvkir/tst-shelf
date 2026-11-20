# Tasks: add-shelf-foundation

## 1. Scaffold

- [x] 1.1 Create the repository skeleton from the tst-workspace donor
  layout: ES-module background, no bundler magic; manifest v2 with
  permissions `tabs`, `storage`, `sessions`; persistent background
  page; `browser_specific_settings.gecko` with
  `data_collection_permissions: { "required": ["none"] }` (object, not
  array — web-ext 8.6 schema); distinct gecko id.
- [x] 1.2 Copy `tst-api.esm.js` from `tst-workspace` (origin:
  `tst-search`, MPL-2.0) verbatim with the attribution header; set up
  the Makefile pipeline (deps, build, run with web-ext auto-reload,
  xpi, lint) mirroring tst-workspace.
- [x] 1.3 Register with TST: `register-self` with a `style` STRING
  (never an array), `listeningTypes` for `ready`, `tabs-rendered`,
  `sidebar-show`, `tree-attached`, `tree-detached`,
  `extra-contents-clicked`, `extra-contents-mousedown`,
  `contextMenu-shown`, `try-collapse-tree-from-other-expansion`,
  `try-scroll-to-activated-tab`, `wait-for-shutdown`; `lightTree:
  true`, `allowBulkMessaging: true`; version-gate on `get-version`
  (idle below TST 4.0). Smoke: handshake + `get-light-tree` in the
  fixture profile.

## 2. State model (sticky flag + derivation)

- [x] 2.1 Per-tab session keys: `tst-shelf-key` uuid via
  `sessions.setTabValue` on first sight; `tst-shelf = {on: true}` on
  "Put on shelf"; cleared only by "Take off the shelf". Owner is
  always derived: parent tab → its shelf; root → root shelf. No stored
  owner, no stored selection.
- [x] 2.2 Uniform re-derivation pass (idempotent): read light tree +
  `tabs.query`, assign every shelved tab to its derived shelf, diff
  against rendered straps, update. Triggers: `ready`/startup,
  `tree-attached`, `tree-detached`, `tabs.onMoved` (cross-window),
  `tabs.onRemoved` (member close → drop icon; owner close → members
  re-derive under their new parents per TST's close-parent behavior).
- [x] 2.3 State choreography: `add-tab-state`/`remove-tab-state` for
  `tst-shelf-shelved` (negative-margin row hiding) and
  `tst-shelf-ghost` (caption-hidden strap-only row for a shelved tab
  anchoring a nested shelf or inherited visible children); taking off
  the shelf clears all shelf states.
- [x] 2.4 Verify the favicon route in the shipped TST: confirm
  DOMPurify keeps the inline `style` attribute in `set-extra-contents`
  (favicon `background-image`); if stripped, switch to
  `set-extra-contents-properties` with `{style: cssText}` property
  assignment (sanitizer-bypassing fallback). Record the result in the
  README.

## 3. Menu items

- [x] 3.1 Register `tst-shelf:put` ("Put on shelf") and
  `tst-shelf:take` ("Take off the shelf") via `contextMenu-create`
  with `contexts: ['tab']`, `viewTypes: ['sidebar']`.
- [x] 3.2 Drive item visibility on `contextMenu-shown`: "Put on
  shelf" for every unshelved tab (root tabs included), "Take off the
  shelf" for every shelved tab (via `contextMenu-update`); handle
  `contextMenu-click` (filter the legacy `fake-contextMenu-click`
  duplicate by sender+type); "Take off the shelf" is the only code
  path clearing the sticky flag.

## 4. Shelf rendering

- [x] 4.1 Tab shelves: `set-extra-contents` with `place:
  'tab-below'` on the owner row; one icon button per currently-visible
  shelved tab, each with `data-tab-id`, `part="shelf-icon"`,
  `title` = `title\nurl`, favicon via inline style background-image;
  restore on `tabs-rendered` and `sidebar-show`.
- [x] 4.2 Root shelf: strap via `set-extra-contents` `place:
  'tabbar-top'` (not a tab row: no un-render, no dummy-tab
  involvement), same icon markup, icon order = native tab order.
- [x] 4.3 Strap CSS in the register-self style: icon grid
  (`repeat(auto-fill, var(--faviconized-tab-size))` rows), wrap, plus
  badge, active highlight via the theme's selected-tab background
  variable (`--tab-background-color-selected` on Nova; verify
  Proton/Photon equivalents and add fallbacks).
- [x] 4.4 Row sizing: `#dummy-tab .extra-items-container.below
  { display: none }` (keep `--tab-size` compact), owner rows
  `height: auto; min-height: var(--tab-size)`; shelved rows hidden via
  the negative-margin collapse pattern (mirror `base.css:686`).
- [x] 4.5 Update choreography: favicon/title/URL changes
  (`tabs.onUpdated`), workspace-hidden transitions
  (`changeInfo.hidden`), badge/highlight states (badge keyed on the
  light tree's `states` including `subtree-collapsed`), icon order on
  tab moves — all through strap re-renders + 
  `set-extra-contents-properties` where cheap; debounce and batch.

## 5. Icon interaction

- [x] 5.1 Click: on `extra-contents-clicked`, parse `data-tab-id`
  from `originalTarget`; `tabs.update(id, {active: true})`; return
  `true` to cancel the owner activation.
- [x] 5.2 Right-click: rely on the `data-tab-id` attribute routing to
  the tab's native context menu (no extra code); E2E-verify the menu
  opens with the tab's items plus "Take off the shelf".
- [x] 5.3 Drag: icons get `draggable="true"` and
  `data-drag-data='{"type":"tab","data":{"id":N,"asTree":true}}'`;
  TST performs the native drag (children follow, drop semantics are
  TST's); the post-drop `tree-attached`/`tree-detached`
  re-derivation moves the icon to the new shelf. No custom drop
  logic.
- [x] 5.4 Scroll: respond `true` to `try-scroll-to-activated-tab` for
  shelved tabs and send TST `scroll` to the owner row (or the top of
  the tab bar for root-shelf tabs) instead, so activation scrolls
  the shelf into view.

## 6. Nesting via TST's native collapse (delegated)

- [x] 6.1 "Put on shelf" sends `collapse-tree` for the tab (children
  fold natively, TST-persisted); selecting a shelf icon activates the
  tab and TST's own focus behavior expands it; on selecting another
  tab of the same shelf, send `collapse-tree` for the previously
  selected one (guarantee one-subtree-per-shelf).
- [x] 6.2 Stay-open guarantee: cancel TST's
  `try-collapse-tree-from-other-expansion` only when the would-be
  victim is a shelved tab (return `true`; regular trees untouched);
  E2E that unrelated activations leave the shelf subtree unfolded.
- [x] 6.3 Selection is derived, never stored: per shelf, the
  shelved tab with an expanded subtree wins; ties resolved by the
  active tab; boot reconciliation collapses stray multiple-expanded
  shelves to one. Restart survival comes from TST's persisted
  collapse state (verify with session-restore E2E).
- [x] 6.4 Ghost rows: a shelved tab anchoring a nested shelf or
  inherited unfolded children renders `tst-shelf-ghost` (caption
  hidden, strap-only, auto-height at its indent); nested shelf shows
  below the parent shelf per DOM order of the flat row list.

## 7. E2E and performance

- [x] 7.1 Port the tst-workspace E2E rig (fixture profile with TST
  installed, Marionette trusted clicks, headless Firefox + LibreWolf
  matrix); add shelf cases: put/take roundtrip, restart persistence
  of shelved state AND of the unfolded subtree (session restore),
  re-derivation after re-parent / window move / owner close under
  both TST close-parent behaviors (attach-up and promote-first),
  close-with-children confirmation via the icon menu (and no dialog
  from us), root shelf (fixed strap, tab order, empty = no space),
  wrapping shelves, tooltip, highlight, badge, mixed-shelf filtering
  with tst-workspace installed, icon click vs owner activation, icon
  context menu contents, shelf→shelf drag (trusted events), drag to
  root, drop on shelf-less tab creating its shelf.
- [ ] 7.2 Performance gate: 350-tab fixture with 5 shelves x 5 tabs:
  full reconciliation after restart under 300 ms; strap re-render on
  one put under 50 ms; no visible sidebar reflow storms on tab
  activation bursts.
- [x] 7.3 Virtual-scroll sanity — closed by the uniform-row law
  (0.1.3): no row deviates from the default height, so the E2E
  conformance probe ("every rendered row sits at TST's computed
  position": first row at the content origin, consecutive pitch = row
  height, 1.5 px tolerance) now guards drop zones, virtual scroll
  and sticky rows together.  The quantized-height fallback is no
  longer needed; any future layout change must keep the probe green.

## 7b. v0.1.1 layout fixes (user-reported)

- [x] 7b.1 The strap extends the owner's row as a second line (CSS
  specificity chain + substance wrap; E2E measures owner vs plain row
  height).
  *Superseded by 7c.1 — the second-line growth broke TST's
  uniform-row arithmetic; the strap moved to the first member's row.*
- [x] 7b.2 Members stay contiguous directly under the owner via
  TST's move-before/move-after/outdent (followChildren), planned in
  the light-tree walk order; the selected member's children render
  above the owner's following children (E2E geometry).
- [x] 7b.3 A newly shelved tab becomes the rightmost icon (append
  semantics through pendingAppend; E2E icon order after a re-put).
- [x] 7b.4 Take-off restores the pre-shelve strip position (stored in
  the flag's session value; same-window best-effort).
- [x] 7b.5 Placement loop: per-window serialized, bounded, guarded;
  planner unit-tested (tests/logic.test.mjs, walk-space ranks).

## 7c. v0.1.3 uniform-row conformance (user-reported drop regression)

- [x] 7c.1 Uniform-row law: every row keeps the default height;
  member rows stay in the flow as blank boxes; the strap renders in
  the first visible member's row (host state), wrapped lines spill
  visually across blank member rows; ghost rows removed (nested
  shelves host on their own first member).  E2E: owner row height ==
  plain row height; the conformance probe replays TST's index
  arithmetic in the sidebar (regression gate for drops and scroll).
- [x] 7c.2 The selected member is ordered last within its shelf
  (planner `selectedIds`): its children dangle below the shelf's
  whole space and the host row never carries rendered children;
  icon order follows the reordered tab order.
- [x] 7c.3 Upgrade path: one-shot `clearLegacyStraps` clears 0.1.2's
  owner/ghost-row straps (TST keeps extra contents per addon+tab
  across addon updates).
- [ ] 7c.4 Follow-up: per-line icon slicing for shelves wider than
  one line — currently wrapped lines spill across member rows, which
  stays inside the shelf's space but reserves one row per member;
  slicing needs the sidebar width, which a background page cannot
  know (the width-blocked F2 paging variant, design.md 0.1.3 notes).

## 8. Packaging

- [x] 8.1 `make lint` clean (0 errors / 0 notices / 0 warnings);
  README with donors' attribution, permission justification (`tabs`,
  `storage`, `sessions`), the session-restore persistence caveat, the
  favicon route result from task 2.4, and the root-shelf placement
  note (v1 renders it above the global pinned row; upstream TST slot
  needed for below-pinned placement).

## 7d. v0.1.4 the shelf moves into the owner's row (user-reported visuals)

- [x] 7d.1 Owner-row strap: `.ui` becomes a row flex for owner rows,
  caption shrinks (`min-width: 0`), shelf sits on the right at most
  2/3 of the row, single line with `overflow-x: auto`.  The row height
  is unchanged (the E2E inflates the strap with cloned icons and
  re-measures).
- [x] 7d.2 Members lose their rows: shelved tabs are hidden with
  `browser.tabs.hide()` (manifest gains `tabHide`); the active tab and
  a window's last visible tab are skipped; hides are re-applied per
  derivation.  `hiddenByUs` (persisted in the tab's session value)
  separates our hides from another addon's container filtering.
- [x] 7d.3 TST drops hidden root tabs from `get-root-tabs` (hidden
  tabs leave the controllable index): `fetchLightTree` requests each
  such root by id and splices it back in tab order.  Found by the
  reinstall phase.
- [x] 7d.4 Icon order is plain tab order again (the 0.1.3
  selected-member-last rule is gone: with no member rows, the selected
  member's children render below the owner row wherever the member
  sits).
- [x] 7d.5 E2E: owner row carries the strap; member rows absent; 2/3
  cap; horizontal scroll; title truncation under a full shelf; row
  height unchanged; children directly below the owner row.
- [ ] 7d.6 Follow-up: scroll a long shelf with the mouse wheel without
  shift (needs a wheel listener on the strap; TST's own wheel handler
  leaves the row area alone, so this is ours to add).
- [ ] 7d.7 Follow-up: `renderHiddenTabs` interplay. When the user
  enables TST's expert "show hidden tabs" option, member rows come
  back and the shelf loses its compaction (geometry stays correct —
  the rows are counted and painted at full height). Detect the option
  and fall back to a visible warning / blank-row mode.

## 7e. v0.1.5 shelf width and the reveal invariant

- [x] 7e.1 The shelf container is `flex: 0 0 auto`: a long owner title
  truncates instead of shrinking the shelf (measured before: container
  17.1 px, cells 34 px, scrollbar; after: 71 px for two cells).
- [x] 7e.2 E2E gate on the *natural* shelf width against TST's own
  `--faviconized-tab-size`; the fixture owner now carries a deliberately
  long title (`tree-tab.html?title=…`), the condition that exposed it.
- [x] 7e.3 `rehideMembersNow`: a revealed member is hidden again from
  `tabs.onActivated` and from its `hidden: false` update, without the
  120 ms debounce (measured 37 ms vs 150 ms).
- [x] 7e.4 Characterization tests for the browser invariant: activating
  a hidden tab reveals it, and `tabs.hide([activeId])` is a no-op.
- [ ] 7e.5 Blocked by the browser: a childless member cannot stay
  row-less while it is the active tab (see design.md 0.1.5). Revisit if
  Firefox ever allows hiding the selected tab.

## 7f. v0.1.6 rows that must not be reclaimed

- [x] 7f.1 `mustShowTabs`: the active tab and its ancestors keep their
  rows (a shelved tab with children no longer disappears while a child is
  active), plus every tab in a collapse/expand animation.
- [x] 7f.2 `hideGuard`: a member whose subtree is folding keeps its row
  for 300 ms (TST's 150 ms animation is sidebar-only and invisible to the
  background), with a re-derivation scheduled at expiry.
- [x] 7f.3 The outgoing member is hidden in the same tick as the
  activation: the swap window dropped from ~80 ms to 0–34 ms.
- [x] 7f.4 `appendOrder` sequence replaces the single append slot (two
  quick puts no longer lose the first one).
- [x] 7f.5 `rememberHidden` writes the bit even when the flag is not on
  the tab yet (root-shelf members survived a restart again).
- [x] 7f.6 E2E: frame sampler asserts no orphaned children and a
  two-frame displacement budget for a childless↔childless swap; nested
  shelf case (owner stays visible with its strap) covered.
- [ ] 7f.7 Blocked by the platform: an atomic row swap. Both the reveal
  (browser-driven) and the hide (our API call) would have to land in one
  sidebar frame; there is no batched tab-visibility API.
