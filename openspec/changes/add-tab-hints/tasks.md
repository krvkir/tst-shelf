# Tasks: add-tab-hints

## 1. Pure derivation

- [ ] 1.1 `assignHints(visibleIds, charset)` in logic.esm.js: tree-walk order, unique codes, shortest practical length, reassignment on set change
- [ ] 1.2 unit tests: order, uniqueness, length growth, viewport-set change, the 350-tab fixture
- [ ] 1.3 `make perf` with hint assignment added to the measured pass

## 2. Rendering

- [ ] 2.1 hint spans in `iconHtml` / `strapHtml` (unit tests in `tests/render.test.mjs`: label present in mode, absent otherwise, narrowing hides non-matching icons)
- [ ] 2.2 per-row labels through `set-extra-contents` `tab-above`; SHELF_STYLE label rules (absolute, out of flow) plus the `#dummy-tab .above` twin of the load-bearing below-rule
- [ ] 2.3 the root strap becomes always-present: a zero-size key catcher (`tabindex="0"`, `part="shelf-keycatcher"`) rides the `tabbar-top` contents even when no root tab is shelved

## 3. Background wiring

- [ ] 3.1 `src/manifest.json`: the `commands` entry (default binding not reserved by Firefox; user-rebindable)
- [ ] 3.2 the per-window mode state machine: entry, buffer, exit states (Escape, blur, activation, window close); runtime-only, no persistence
- [ ] 3.3 `commands.onCommand` → focused window → enter mode → `focus-to-extra-contents`; confirm by the catcher's `extra-contents-focus`, exit on a bounded timeout otherwise
- [ ] 3.4 `extra-contents-keydown` handler: buffer, Backspace, Escape, complete-code activation; truthy answers only for keys the mode consumed
- [ ] 3.5 activation routing: a shelved tab through the icon-click choreography, a row tab through activation — reuse `selectShelfTab` and the activation path
- [ ] 3.6 the rendered-rows ledger from `tabs-rendered` / `tabs-unrendered` (register the unrendered type), label writes and clears bounded by the viewport

## 4. Verification

- [ ] 4.1 E2E phase 2: enter the mode through a test hook, focus the catcher through the same `focus-to-extra-contents` message, dispatch synthetic keydowns
- [ ] 4.2 E2E: typing a shelved member's code runs the icon-click choreography (assertions reuse the existing selection block); a row tab's code activates it
- [ ] 4.3 E2E: prefix narrowing hides non-matching labels; Backspace restores them; Escape exits with every label cleared
- [ ] 4.4 E2E: the uniform-row conformance gate stays green while labels render, and an empty root shelf still reserves no space with the catcher present
- [ ] 4.5 native command delivery verified once on a GUI `make iso-tst` run (documented like native menu delivery)
- [ ] 4.6 two consecutive clean `make e2e` runs

## 5. Documentation

- [ ] 5.1 README: the command, its rebinding, the visible-set scope of codes, the dummy-tab above-rule
- [ ] 5.2 `openspec/project.md`: the capabilities list and glossary gain `tab-hints`
- [ ] 5.3 version bump in `src/manifest.json` and `package.json` together (release checklist)
