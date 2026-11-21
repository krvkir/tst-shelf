# Tasks: add-tab-hints

## 1. Pure derivation

- [x] 1.1 `assignHints(visibleIds, charset)` in logic.esm.js: tree-walk order, unique codes, shortest practical length, reassignment on set change
- [x] 1.2 unit tests: order, uniqueness, length growth, viewport-set change, the 350-tab fixture
- [x] 1.3 `make perf` with hint assignment added to the measured pass

## 2. Rendering

- [x] 2.1 hint spans in `iconHtml` / `strapHtml` (unit tests in `tests/render.test.mjs`: label present in mode, absent otherwise, narrowing hides non-matching icons)
- [x] 2.2 per-row labels through `set-extra-contents` `tab-above`; SHELF_STYLE label rules (absolute, out of flow) plus the `#dummy-tab .above` twin of the load-bearing below-rule
- [x] 2.3 the root strap becomes always-present: a zero-size key catcher (`tabindex="0"`, `part="shelf-keycatcher"`) rides the `tabbar-top` contents even when no root tab is shelved

## 3. Background wiring

- [x] 3.1 `src/manifest.json`: the `commands` entry (default binding not reserved by Firefox; user-rebindable)
- [x] 3.2 the per-window mode state machine: entry, buffer, exit states (Escape, blur, activation, window close); runtime-only, no persistence
- [x] 3.3 `commands.onCommand` → focused window → enter mode → `focus-to-extra-contents`; confirm by the first catcher keydown (the E2E-measured shadow-focus gap makes `extra-contents-focus` a secondary path), exit on a bounded timeout otherwise
- [x] 3.4 `extra-contents-keydown` handler: buffer, Backspace, Escape, complete-code activation; truthy answers only for keys the mode consumed
- [x] 3.5 activation routing: a shelved tab through the icon-click choreography, a row tab through activation — reuse `selectShelfTab` and the activation path
- [x] 3.6 the rendered-rows ledger from `tabs-rendered` / `tabs-unrendered` (register the unrendered type), label writes and clears bounded by the viewport

## 4. Verification

- [x] 4.1 E2E phase 2: enter the mode through a test hook, focus the catcher through the same `focus-to-extra-contents` message, dispatch synthetic keydowns
- [x] 4.2 E2E: typing a shelved member's code runs the icon-click choreography (assertions reuse the existing selection block); a row tab's code activates it
- [x] 4.3 E2E: prefix narrowing hides non-matching labels; Backspace restores them; Escape exits with every label cleared
- [x] 4.4 E2E: the uniform-row conformance gate stays green while labels render, and an empty root shelf still reserves no space with the catcher present
- [ ] 4.5 native command delivery verified once on a GUI `make iso-tst` run (documented like native menu delivery)
- [x] 4.6 two consecutive clean `make e2e` runs

## 5. Documentation

- [x] 5.1 README: the command, its rebinding, the visible-set scope of codes, the dummy-tab above-rule
- [x] 5.2 `openspec/project.md`: the capabilities list and glossary gain `tab-hints`
- [x] 5.3 version bump in `src/manifest.json` and `package.json` together (release checklist)
- [x] 5.4 commands registration visible in E2E reports (the smoke page reports `browser.commands.getAll()`; the driver asserts the hints command with a shortcut on the temporary install and the reinstall cycle); README caveat about the shortcuts page and the private-window skip.  (0.3.2's boot-time `assertCommandsRegistered` was retired by the user's finding: the shadowing, not the registration, was the defect.)

## 6. 0.4.0 rework: the page catcher (Vimium port) and full-window labels

- [x] 6.1 `src/hint-catcher.js`: the on-demand page key catcher (idempotent per document, modeId arm/stop, first-ack self-teardown), shipped in both build flavors
- [x] 6.2 manifest: `activeTab` permission; default binding Alt+U (Alt+Shift+H shadowed by the Help menu, user-measured)
- [x] 6.3 background: `armPageCatcher` on entry (executeScript into the active tab, arm message with retry), `hint-catcher-stop` on every exit, the production `hint-catcher-key` runtime listener with the alive-ack, shared `consumeHintKey` for both channels
- [x] 6.4 entry plans codes for EVERY surface-bearing tab of the window and writes row labels unconditionally (the stale-ledger defect); a known-closed sidebar (sidebar-hide, openCount 0, no rendered rows) declines at entry
- [x] 6.5 E2E: arm-failure asserted as the graceful path (extension pages reject executeScript, MDN); the smoke page relays `hint-catcher-key` through its internal connection to exercise the real handler headlessly; the registration asserts read the smoke page's `commands` report
- [x] 6.6 design/spec amendments: page-capture scenarios, scroll-stable codes, the measured facts section (MDN activeTab, injection exclusions, sidebar-hide openCount)
- [ ] 6.7 native command delivery and a REAL page-catcher typing verified on a GUI `make iso-tst` run (headless cannot inject into its own extension pages)

## 7. 0.5.0 round: special pages, the Vimium conflict, the narrowing defect

- [x] 7.1 `logic.esm.js`: `isSpecialPageUrl` (the MDN executeScript scheme matrix), `normalizeHintCharset`, the default charset switched to the six Vimium-safe letters (`acqsew`)
- [x] 7.2 background: entry declines when the window's ACTIVE tab is a special page (the trap report); the exclusion option (default on) filters such TABS from codes; `hintCharset`/`hintExcludeSpecialPages` in storage.local, loaded at boot and applied live through storage.onChanged
- [x] 7.3 options page: the code-alphabet field and the special-page exclusion checkbox (the background normalizes and falls back to the default alphabet for anything under two characters, with a bootlog line)
- [x] 7.4 `hint-catcher.js`: forwards and suppresses EVERY printable key while armed (a custom alphabet may carry digits; unused keys must not reach the page mid-mode)
- [x] 7.5 the narrowing defect: `redrawHintLabels` applies the buffer-filtered code map to the straps too (the icon chips narrowed never — the user's "random" report); row chips move to their own part (`shelf-rowhint`) at the row's top inline-end corner with the `.above` container overlaid on the row (the favicon's z-index 200 painted over the old placement)
- [x] 7.6 `build.mjs`/`verify-dist`: the E2E flavor gains the `http://127.0.0.1/*` host permission (the test hook enters with no activeTab grant); verify-dist rejects any non-API permission outright
- [x] 7.7 E2E: a real http fixture server (the favicon probe's pattern); phase 1 runs the decline + real-arm asserts and REMOVES its fixture tab before the setup report (the pure-swap sampler premises on a tree that fits TST's render range); phase 2 asserts the default exclusion, a keydown dispatched inside the armed page through the production catcher, the exclusion flip, the chip-prefix narrowing, the corner geometry, the configured alphabet, and restores the defaults; phase 3 activates an http tab before its round-trip
- [x] 7.8 design/spec amendments: the decline scenario, the exclusion and alphabet requirements, the Vimium mechanics (window capture + stopImmediatePropagation + the safe letters), the MDN scheme matrix, the match-pattern port fact, the sampler/range lesson
- [x] 7.9 two consecutive clean `make e2e` runs (155 checks each)

## 8. 0.6.0 round: painted-surface coverage (codes only for what is on screen)

- [x] 8.1 `logic.esm.js`: `planHintTargets` — the pure planner: rendered rows only, members only while their strap is painted (root strap always; nested straps with the owner's row), the fold walk (rows inside a folded subtree excluded, members inside it kept), the special/pinned/hidden rules; `null` rendered = no viewport truth (the fallback)
- [x] 8.2 `index.esm.js`: entry fetches TST's live viewport (`get-light-tree {rendered: true}` — the rendered set is the response's top-level ids) and plans codes from it; the event ledger demoted to telemetry; a fresh derivation over the just-fetched tree (shelfOf must agree with the walk)
- [x] 8.3 unit tests: painted-surface eligibility (warm/cold/empty ledger, nested members with and without a reveal, icon rules, special exclusion, pinned, walk order)
- [x] 8.4 E2E: the fixture-growth block and mkBlankTabsScript retired (codes are naturally 2-letter now; off-screen rows carry none); a coverage assertion — every coded row is in the mode's own rendered set (`hints.rendered` in the state export)
- [x] 8.5 spec/design amendments: the painted-surface requirement with its scenarios (fold, viewport, the query fallback), the measured facts (no rendered state in the export; the live query; the event-ledger veto flaw)
- [x] 8.6 two consecutive clean `make e2e` runs (156 checks each)
