# Tasks: add-container-line-on-shelf-icons

## 1. Pure rendering

- [x] 1.1 `iconHtml` emits the marker span with `part="shelf-marker"`, first among the cell's children, gated on `cookieStoreId` being set and not `firefox-default` / `firefox-private`; the span's `style` carries `--shelf-marker: var(--contextual-identity-color-<escaped cookieStoreId>, transparent)` (`render.esm.js`: `markerSpanOf` + `NON_CONTAINER_COOKIE_STORES`)
- [x] 1.2 unit tests in `tests/render.test.mjs`: container member (span present, var value), default and private members (no span), a snapshot without `cookieStoreId` (no span), mixed shelf (two different cookieStoreId vars, owner's never leaks), marker first among children, click/drag/title attributes unchanged, `cookieStoreId` escaped in the style attribute (125 unit tests green)

## 2. Registered stylesheet

- [x] 2.1 SHELF_STYLE rule 5c: the base `shelf-marker` rule — absolute, the cell's inline end, cross-section `calc(var(--favicon-size) / 8)` (= TST's `--contextual-identity-marker-size`), block insets = the row marker's margin formula with `--tab-current-size` replaced by the cell's `--faviconized-tab-size`, `background-color: var(--shelf-marker)`, `pointer-events: none`
- [x] 2.2 the theme branches: `:root[data-style="proton"].regular/.inverted` shifted by `--tab-highlighter-size` (proton.css:457), `:root[data-style="nova"]` the horizontal accent variant with the faviconized margins (nova.css:466-500); the comment carries NO backticks (a raw backtick inside the template is the 0.6.3 trap — found and avoided once here); `tests/style.test.mjs` extended and green
- [x] 2.3 stacking confirmed by the unit test: the marker is the FIRST child of the icon cell, so the badge, the sound glyph and hint chips (later siblings, plus the chip's own z-index) paint over it where they overlap. Owner rows untouched: the registered style contains no `contextual-identity-marker` rule, the owner row keeps TST's native marker (E2E state probe still shows the per-tab `contextual-identity-…` states; owner-row geometry checks green)

## 3. E2E harness

- [x] 3.1 `build.mjs` `applyE2EPatch`: add `contextualIdentities` and `cookies` to the E2E flavor manifest only (production untouched; `scripts/verify-dist.mjs` green)
- [x] 3.2 smoke page setup phase: creates two containers (`e2e-shelf-line`, `e2e-shelf-line-two`), opens and shelves a tab in the first (a ROOT member — A's shelf order is asserted exactly by the driver, the root strap's is not) and uses the default-container childless member F as the control
- [x] 3.3 sidebar phase: asserts the `shelf-marker` span on the container member's icon and its absence on the control's, the marker's var carrying the second container's cookieStoreId and not the first, the live-palette-reference form (`--shelf-marker: var(…)`), and the registered stylesheet's marker rule + the active theme's branch surviving install (`themeStyle` + branch booleans in the sidebar dump)
- [x] 3.4 a live follow case: Firefox cannot retag a live tab, so the flip uses the UI's own reopen-in-container path — take off, `tabs.create({cookieStoreId: second})`, remove, put back — the same observable the scenario claims: the shelved set keeps a member in the slot and the next strap re-render carries the new container's marker, no extension restart

## 4. Verification

- [x] 4.1 `make test` (125 tests green) and `make perf` (full pass median 0.49 ms / worst 1.07 ms, put 0.38 ms — budgets unchanged; the marker is one map-free string append per icon)
- [x] 4.2 two consecutive clean `make e2e` runs (174 PASS / 0 FAIL / exit 0, both runs; the container member id `firefox-container-7` asserted live in the sidebar DOM)
- [ ] 4.3 manual `make iso-tst`: container tab shelved next to a default tab, line looks like the row's own marker (vertical under Proton-style settings, accent under Nova), recoloring the container repaints the icon without a restart — REMAINS OPEN for the user (GUI only)

## 5. Documentation

- [x] 5.1 `openspec/project.md` — no edit needed: the container line is pure strap markup, not a new presentation lever (the levers list already contains the strap; the delta adds the requirement to `shelf-presentation`)
- [x] 5.2 README: the container line in "What it does" and a dedicated "Implementation notes" entry (palette = TST's live `--contextual-identity-color-<id>` references, sidebar.js:496-510; geometry = base.css:1252-1261 with the cell replacing the row's current size; proton.css:457; nova.css:466-500; the Nova-approximation caveat; the TST-internal var prefix pinned to 4.4.10; no new permissions in production)
- [x] 5.3 release checklist: bug-fix bump to `0.6.4` in `src/manifest.json` and `package.json` together
