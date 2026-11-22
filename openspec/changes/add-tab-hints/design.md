# Design: add-tab-hints

## Context

Four TST surfaces, verified against the 4.4.10 sources, carry the whole
feature:

1. `extra-contents-keydown` / `-keyup`: TST forwards key events whose
   target sits inside an addon's extra contents (a document-level
   capture listener, sidebar/tst-api-frontend.js:801, 866–880), with
   `key`, `repeat`, modifiers, the target's HTML and its `targetPart`.
   TST's sidebar has NO other keydown listener — typed letters are
   otherwise unclaimed.
2. `focus-to-extra-contents` (`{windowId, place, part}`): calls
   `node.focus()` on the first node with that `part` (tst-api-frontend.js:
   761–772). Combined with (1): focus a `tabindex="0"` span we render,
   and every keypress lands inside our `.extra-item`, so TST routes it
   to us. DOMPurify's default attribute whitelist keeps `tabindex`.
3. `tabs-rendered` / `tabs-unrendered` (`messages: {tabs: [...]}`,
   sidebar-items.js): the rendered set of the virtual-scrolled tab bar
   is trackable from the background; `tabs-unrendered` is broadcast
   only to subscribers.
4. `set-extra-contents` with `place: "tab-above"`: a per-row label
   channel, the same mechanism the straps ride.

## Goals / Non-Goals

- Goal: one command, deterministic codes, zero geometry change.
- Goal: mode state is runtime-only, per window — no persistence, no
  boot-release path (nothing hides a tab; only overlays and focus).
- Non-goal: scrolling off-viewport rows into view to give them codes;
  codes are assigned to every surface-bearing tab and their LABELS
  paint wherever a row is actually rendered — exactly like Vimium's
  hints cover the visible links.
- Non-goal: hint codes in the native tab bar or in a closed-sidebar
  state; the sidebar is the only painting surface.

## Decisions

1. **The key catcher.** An invisible `tabindex="0"` span with
   `part="shelf-keycatcher"` rides in the root strap's `tabbar-top`
   contents. The root strap therefore becomes ALWAYS-present: an empty
   root shelf writes the catcher alone, styled zero-size (width/height
   0, opacity 0 — `display: none` would make `node.focus()` a no-op).
   The existing "an empty root shelf reserves no space" requirement
   stays the contract; the E2E keeps asserting it.
2. **Mode confirmation, not trust.** `commands.onCommand` starts the
   mode and calls `focus-to-extra-contents` for the focused window. The
   mode is CONFIRMED by the **first catcher keydown** — Firefox 158
   does not dispatch `focus`/`blur` whose target sits inside a shadow
   root (E2E-measured: `focus()` moves `activeElement` but fires no
   event), so the planned `extra-contents-focus` confirmation is kept
   only as an optional second path.  A keydown can only come from a live
   sidebar with a reachable catcher, so a closed sidebar still makes the
   command a no-op: no confirmation within a bounded timeout (3 s;
   measured delivery lateness under bulk notification buffering) ends
   the mode before any row labels are written — the spec's no-op
   scenario.  The E2E drives the confirmation with a neutral F5 keydown,
   which the mode ignores except for the confirmation.
3. **Codes are a pure derivation.** `assignHints(visibleIds, charset)`
   in logic.esm.js: the visible set in tree-walk order (`treePositions`
   — the same order the straps render in), a fixed letter charset,
   length grows only when the count demands it; unit-tested, and the
   350-tab perf gate re-runs with assignment added to the pass.
4. **Row labels ride `tab-above`, tracked by the rendered set.** The
   ledger of rendered rows comes from `tabs-rendered` /
   `tabs-unrendered`; the mode writes one `set-extra-contents` per
   rendered row (bounded by the viewport, ~30–50 messages) and clears
   them on exit or viewport change. Two uniform-row traps, both
   load-bearing rules: labels paint `position: absolute` (out of flow),
   and `SHELF_STYLE` gains the `#dummy-tab .extra-items-container.above
   { display: none }` twin of the existing below-rule — the dummy tab
   mirrors extra contents and would inflate every row otherwise.
5. **Key consumption follows the narrow-cancellation rule.** The
   `extra-contents-keydown` handler answers truthy ONLY while the mode
   is active and the key belongs to the mode (letters, Backspace,
   Escape); everything else falls through to TST. The donor client's
   boolean-passthrough deviation carries the verdict.
6. **The E2E drives the whole chain headlessly.** Phase 2 opens TST's
   sidebar page in a tab already; the smoke page enters the mode
   through a test hook (the native command is a trusted event, like
   native menu delivery), the driver dispatches synthetic keydowns on
   the catcher (the same `WebDriver:ExecuteScript` route the icon
   mousedowns use), and the activation choreography reuses the existing
   icon-click assertion block. Native command delivery is verified once
   on a GUI `make iso-tst` run and documented like menu delivery.
7. **The page catcher — Vimium's mechanism, ported (0.4.0).** Vimium's
   link hints work because the keydown listener lives in the document
   the user types into (content_scripts/link_hints.js).  Our labels
   paint in TST's sidebar, which almost never holds the window focus,
   so the SAME mechanism is added as a second channel:
   `src/hint-catcher.js` is injected on demand into the focused
   window's ACTIVE tab on every mode entry, forwards code letters to
   the background as `hint-catcher-key` messages, suppresses them from
   the page, and tears itself down on the background's stop message or
   on an `{ok:false}` ack.  The injection needs no host permission:
   the command invocation grants activeTab (MDN, "How activeTab is
   granted", Firefox 63+), and activeTab is exactly what covers
   `tabs.executeScript` in MV2.  A mode serial (`modeId`) rides the
   arm/stop messages so a replaced mode's stop cannot kill the new
   mode's catcher; a re-entry in the same tab reuses the one catcher
   (the injection is idempotent per document — a second listener would
   double-forward every key).
8. **Codes cover the whole window, labels paint on rendered rows
   (0.4.0).** The 0.3.x entry planned codes from the rendered-rows
   ledger; a sidebar open since before the extension's (re)boot never
   re-broadcasts its already-rendered rows, so the user saw chips on
   shelved icons and labels only on rows re-rendered since (their
   report).  Entry now assigns codes to every surface-bearing tab and
   writes the labels unconditionally: TST routes `set-extra-contents`
   by tab id, so a row it already renders is painted even though our
   ledger never heard of it, and a row that renders later is labeled by
   the in-mode `tabs-rendered` repaint — codes stay stable across
   scrolling.

## Risks / Trade-offs

- [Another addon listens to `extra-contents-keydown` too] → we answer
  truthy only for keys the mode consumed; a competing addon sees the
  same event regardless (TST broadcasts before the verdict).
- [Mode left active by a lost focus event] → four exits overlap:
  Escape, a completed code (activation), the confirmation timeout, and
  the catcher's `blur` when Firefox delivers it at all (it does not for
  shadow-internal targets — measured; the mode is not left behind: the
  three other exits bound it).  The window-close cleanup drops the
  state with the window.
- [Extra-contents sends stall] → TST never answers `set-extra-contents`
  (every case in tst-api-frontend.js ends with a bare `return`) and the
  runtime reply race resolves only some send promises at all; the
  row-label ledger is intent-tracked with reverts on real rejections,
  and the strap ledger keeps its acknowledged semantics (a failed clear
  is retried by the vanished-shelves loop).  Re-sends are idempotent.
- [The rendered-rows ledger misses the first import] → CLOSED by the
  0.4.0 rework (decision 8): entry writes labels for the whole window
  and no longer trusts the ledger for coverage; the ledger only feeds
  the known-closed decline.
- [The page catcher cannot be injected] → extension pages (ours, the
  smoke page, AND every other extension's pages, so the tab-hosted TST
  sidebar too), `about:`, reader view and the PDF viewer reject
  `tabs.executeScript` (MDN): the failure is a bootlog line, the mode
  stays up on the sidebar's catcher channel, and the E2E asserts this
  graceful path.  An orphaned catcher (its mode died without a stop
  that reached it) eats at most ONE key — the first key's own ack
  tears it down.
- [A closed sidebar never announces itself] → a known-closed window
  (sidebar-hide with openCount 0, no rendered rows since) is declined
  at entry; a window with a sidebar closed SINCE BEFORE our boot is
  indistinguishable from one open since before it, so it enters, arms
  its page catcher, and typing a code could activate a tab whose labels
  are nowhere to see — the user sees nothing appear and does not type;
  the inactivity timeout ends the mode.  Documented, accepted.
- [Viewport churn re-labels rows mid-typing] → a reassignment keeps the
  buffer; codes that no longer match the new set simply hide, and a
  stale complete match activates nothing.

## Open Questions

- The default key binding is picked at implementation time to avoid
  Firefox's reserved combinations (and is user-rebindable through
  about:addons regardless).
- Whether to cap code length at two letters with prefix disambiguation
  beyond, or grow to three; the pure planner decides and the unit test
  pins it.

## Measured after implementation: command registration (read from
## Firefox's ExtensionShortcuts.sys.mjs + verified in E2E on 158.0)

- A command is a XUL `<key>` in a per-window `keyset`, created by
  `ExtensionShortcuts.register()` for every open window plus a
  window-open listener; registration runs in
  `onManifestEntry("commands")` at extension start. An extension
  reload/upgrade/reinstall restarts the extension and re-runs the
  chain, so a NEW manifest's commands land on the reinstall cycle —
  E2E-asserted for both a fresh temporary install and the reinstall
  (upgrade proxy), Firefox 158.0, headless (`hints command registered
  at boot (temporary install)` and `... after reinstall`).
- `about:addons`' Manage Extension Shortcuts lists extensions whose
  commands map is non-empty; an empty list means the running session
  is not on a build that declares `commands` in its manifest — reload
  the add-on or restart.
- User rebindings live in ExtensionSettingsStore and are merged over
  the manifest commands at every load; they survive updates and win,
  so ours never overwrites a non-empty shortcut. A registered command
  with an EMPTY shortcut is restored to the manifest default at boot
  (`hints-command-restore` in the bootlog); a wholly missing command
  cannot be created through the API (the API only update/reset
  existing ones) and is logged as `hints-command-missing`.
- Private windows: `registerKeysToDocument` returns early when the
  extension lacks `privateBrowsingAllowed` — the command does not
  fire there, though the page still lists it.

- `updateCommand()` calls `registerKeys(commands)` (line 209 of the
  158.0 source) BEFORE emitting `onChanged`: a remap applied in
  about:addons takes effect immediately, no restart needed — the
  first-aid earlier ("restart after remap") was wrong and is retracted.
  What CAN eat a working key: focus held by page content that stops
  propagation of the keydown (web apps that do), keyset absence on a
  private window, and a binding shared with another extension (both
  fire; the UI warns). The bootlog answers delivery: `hints-command`
  at boot, `hints-command-fired` per delivery.
- Labels render at ENTRY when the window's rendered-rows ledger is
  warm (a TST page has rendered rows since boot — spec "while the
  sidebar is open"); a cold ledger skips the writes and the entry
  stays the closed-sidebar no-op (`the unconfirmed mode wrote no
  labels` pins it). The first catcher keydown still confirms typing
  (and its own letter starts the buffer). The unconfirmed teardown
  window is 9 s so a human can read the labels before typing.

## Measured after the 0.4.0 rework (the Vimium port)

- Firefox grants activeTab when the user activates the extension's
  commands-API shortcut — MDN's compatibility table, "From Firefox 63"
  — and activeTab covers `tabs.executeScript()` in MV2; no install-time
  permission warning is shown for it.  `tabs.executeScript` cannot run
  in ANY extension page (MDN, tabs.executeScript), which is why the
  E2E asserts the graceful arm-failure path instead of a real injection
  (its driven tab is the tab-hosted TST sidebar, an extension page).
- Vimium's own mechanism (~/repos/firefox/vimium, content_scripts/
  link_hints.js): hint strings come from a BFS over the hint-character
  alphabet (hintStrings, line 967) and the key handling lives in the
  page's own mode stack (mode_key_handler.js, a capture-phase keydown);
  the port keeps our fixed-length ordered codes (simpler, prefix-free
  by construction, already unit-pinned) and takes ONLY the capture
  location: the document the user types into.
- TST broadcasts `sidebar-hide` with the post-event `openCount`
  (common/tst-api.js:78, 640-652): 0 means no sidebar page of that
  window is left (panel and tab-hosted copies both count), which is the
  known-closed decline signal.  There is no `get-sidebar-status`
  method to query the state cold.
- The 0.3.3 label-coverage defect (user report): after an extension
  reload with the sidebar left open, only shelved icons and recently
  re-rendered rows got labels — the ledger knows nothing about rows
  rendered before our boot, and a warm-but-partial ledger produced
  worse coverage than a cold one (the cold path wrote no labels at
  all).  Fixed by decision 8.
- The default binding moved to Alt+U: Alt+Shift+H was shadowed by the
  Help menu accelerator on the user's Linux desktop (user-measured;
  rebindable in about:addons regardless).  The user's finding also
  retired the boot-time registration assert: the 0.3.1 command worked
  after remapping, so registration was never the problem —
  `assertCommandsRegistered` (0.3.2's `hints-command`/restore machinery)
  is removed; the E2E now reads the registration from the smoke page's
  own `browser.commands.getAll()` report.

## Measured after the 0.5.0 round (special pages, Vimium, the narrowing defect)

- MDN tabs.executeScript settles the injectable schemes: the scheme
  must be expressible as a match pattern (http, https, file), top-level
  about: frames are NEVER injectable (matchAboutBlank covers embedded
  about:blank/srcdoc frames only), and extension pages reject the
  injection.  The decline set is therefore about:, moz-extension:,
  chrome:, resource:, moz-icon:, view-source: — the TST group tabs
  (moz-extension://<uuid>/resources/group-tab.html) are extension
  pages.  This closes the user's trap report: from such a page the
  catcher cannot exist, so the command declines there outright, and
  (option on by default) such tabs carry no code either — one can
  never navigate onto a page that would strand the keyboard.
- Vimium (~/repos/firefox/vimium) hangs its keydown listener on
  window with capture:true and consumes every MAPPED key with
  stopImmediatePropagation (content_scripts/vimium_frontend.js:204-232,
  lib/dom_utils.js:516-523) — a code letter that starts any default
  mapping is eaten before this extension's document-level catcher can
  see it.  The default mappings' first letters (background_scripts/
  commands.js defaultKeyMappings) leave exactly a, c, e, q, s, w free,
  which is the shipped default alphabet (logic.esm.js HINT_CHARSET);
  the options field exists for anyone whose Vimium config differs.
  While hint mode is armed, hint-catcher.js forwards and suppresses
  EVERY printable key (the mode owns the keyboard), so the page and
  the page's own handlers see nothing mid-mode.
- The 0.4.0 "hints disappear at random" report was TWO defects: (a)
  the strap chips never narrowed (redrawHintLabels wrote row labels
  only — the icon chips kept every code while the rows narrowed, and
  the two surfaces disagreed), fixed by making the redraw apply the
  buffer-filtered code map to the straps through the normal diff;
  (b) the row chips anchored to TST's .above container, whose geometry
  varies by row kind (the owner row's container sits ~20px lower and
  156px short of the row's inline-end — measured in the E2E), and
  whose z-order (150, --tab-extra-contents-beside-z-index) can never
  beat the favicon (200, --tab-favicon-z-index): "below favicons, not
  always visible".  Fixed by overlaying .above on the whole row
  (position: absolute; inset: 0) and moving the row chip to its own
  part (shelf-rowhint) at the row's top inline-end corner, where
  nothing above 150 ever paints.  No other addon in this setup writes
  tab-above contents (checked: tst-workspace has none).
- Match patterns carry NO port: http://127.0.0.1:47631/* is invalid
  (MDN), so the E2E's hint-fixture server is matched as
  http://127.0.0.1/* (any port).  The E2E flavor's manifest therefore
  carries that host permission (the test hook enters hint mode with
  no commands-API activeTab grant); verify-dist now rejects any
  non-API permission outright, so a host permission can never ship.
- The E2E fixture learned the hard way that its tree-geometry checks
  (the pure-swap sampler) premise on the tree fitting TST's render
  range entirely: one extra bottom row (the phase-1 hint-fixture tab)
  let the virtual scroll transiently render the tree WITHOUT the
  just-activated member's row for seconds.  The smoke page now runs
  its hint block BEFORE the setup report and removes the fixture tab
  — the driver cannot start phase 2 until the report exists.

## Measured after the 0.6.0 round (painted-surface coverage)

- The user's defect report: codes were assigned to all 350+ visible
  tabs (rows inside folded subtrees included) — 4-letter codes, and a
  mistyped code could activate a tab that was not on screen.  The
  coverage contract changed: codes cover EXACTLY the painted surfaces
  at entry (spec: "Every painted tab surface carries a unique short
  code").
- TST's tree export carries NO render knowledge: kTAB_SAFE_STATES
  (common/constants.js) lists collapsed/subtree-collapsed/group-tab
  and friends only — no "rendered" state exists anywhere; the virtual
  scroll's render range is a sidebar-side concept.  The fold cut is
  still pure: `subtree-collapsed` on owners is exported (the badge
  feature depends on it), and the planner walks the fold down.
- The RENDER truth is TST's own live viewport filter: get-tree and
  get-light-tree accept `rendered: true` (handle-misc.js ~694/~719 →
  getTargetRenderedTabs), which asks the SIDEBAR's scroll.js (the
  internal kCOMMAND_GET_RENDERED_TAB_IDS) for its live rendered ids
  (scroll.js:1321-1328: pinned + every rendered row of ANY depth).
  `tab: '*'` is LOAD-BEARING: without a tab selector TST's
  getTargetTabs returns ROOT tabs only (common/tst-api.js — tabQuery =
  message.tabs || tabIds || tab || tabId; none → Tab.getRootTabs, the
  documented piroor#2763 behaviour), so the filter kept only rendered
  roots and the harvest yielded a root-only set — 0.6.0 shipped that
  and nested visible tabs carried no codes (the user hit it on the
  first 0.6.0 build).  With tab:'*' every rendered row becomes one
  top-level entry (each may re-nest its full subtree under rendered
  ancestors — only the top-level ids are read).  Pinned tabs are in
  the set; the planner ignores pinned anyway.  The E2E's CONVERSE
  check (the hint fixture's NESTED http tab — the second tab, opened
  as the first tab's opener child — is rendered, coded and labeled)
  is the regression guard for the tab:'*' semantics; the fixture's
  own plain row D cannot witness (the 0.2.1 reveal checks leave its
  owner folded, so D is unrendered at that point by design).
- The tabs-rendered/-unrendered EVENT stream failed as a render
  ledger, measured in the E2E: the notifications carry NO top-level
  windowId (every payload measured w=undefined; the light tab
  records DO carry windowId), and with more than one sidebar copy of
  a window the streams mix — one copy's tabs-unrendered vetoes rows
  another copy still paints.  The E2E's event ledger ended up holding
  only the tabs created after the copies settled while the fixture
  rows stayed painted the whole time.  The ledger stays as telemetry
  (the state export) and the sidebar-closed decline; the live query is
  the planner's input.
- A window whose viewport cannot be queried (no sidebar copy answers —
  no sidebar at all, a failed query, a foreign copy answering with
  another window's ids, which simply fails the tree's tab filter and
  yields nothing) falls back to the fold cut alone: codes for every
  non-folded visible tab, labels painting wherever rows exist (TST
  routes set-extra-contents by tab id — the 0.3.3 stale-ledger trap
  stays shut).  The E2E asserts the painted-subset contract against
  the mode's own queried set (hints.rendered in the state export).
- The fixture measures the win and keeps the coverage honest:
  0.6.2's converse check codes the hint fixture's nested rendered tab.
