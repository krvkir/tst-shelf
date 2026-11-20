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
- [ ] 7.3 Virtual-scroll sanity on the 350-tab fixture: scrolling and
  `scroll`-to-tab remain accurate with tall owner rows and collapsed
  shelved rows; if mispredictions appear, switch owner rows to
  quantized height state classes (`tst-shelf-owner-rows-1..N`).

## 8. Packaging

- [x] 8.1 `make lint` clean (0 errors / 0 notices / 0 warnings);
  README with donors' attribution, permission justification (`tabs`,
  `storage`, `sessions`), the session-restore persistence caveat, the
  favicon route result from task 2.4, and the root-shelf placement
  note (v1 renders it above the global pinned row; upstream TST slot
  needed for below-pinned placement).
