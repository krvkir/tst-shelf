# Tasks: add-container-line-on-shelf-icons

## 1. Pure rendering

- [ ] 1.1 `iconHtml` emits the marker span with `part="shelf-marker"`, first among the cell's children, gated on `cookieStoreId` being set and not `firefox-default` / `firefox-private`; the span's `style` carries `--shelf-marker: var(--contextual-identity-color-<escaped cookieStoreId>, transparent)`
- [ ] 1.2 unit tests in `tests/render.test.mjs`: container member (span present, var value), default and private members (no span), mixed shelf (two different cookieStoreId vars), click/drag/title attributes of the icon unchanged

## 2. Registered stylesheet

- [ ] 2.1 SHELF_STYLE: the base `shelf-marker` rule — absolute, the cell's inline end, cross-section `calc(var(--favicon-size) / 8)`, `background-color: var(--shelf-marker)`, `pointer-events: none`
- [ ] 2.2 the theme branches: `:root[data-style="proton"]` inline-end inset by `--tab-highlighter-size`, `:root[data-style="nova"]` the horizontal accent variant — mind the template-literal backtick trap; keep `tests/style.test.mjs` green
- [ ] 2.3 confirm the fold badge / audio indicator / hint chip stacking against the marker (marker paints under them where they overlap), and that owner rows still paint their own TST marker with the strap in place

## 3. E2E harness

- [ ] 3.1 `build.mjs` `applyE2EPatch`: add `contextualIdentities` and `cookies` to the E2E flavor manifest only (production untouched; `scripts/verify-dist.mjs` stays green)
- [ ] 3.2 smoke page setup phase: create a container, open and shelve a tab in it, and one default-container member as the control
- [ ] 3.3 sidebar phase: assert the `shelf-marker` part on the container member's icon and its absence on the control's, assert the registered stylesheet's marker rule survived (as the sound phase asserts the mask rules)
- [ ] 3.4 a live follow case: change the shelved tab's `cookieStoreId` (smoke page API) and assert the marker's var flips at the next strap re-render

## 4. Verification

- [ ] 4.1 `make test` and `make perf` (one Map lookup and one string append per icon; no derivation-path change expected)
- [ ] 4.2 two consecutive clean `make e2e` runs
- [ ] 4.3 manual `make iso-tst`: container tab shelved next to a default tab, line looks like the row's own marker (vertical under Proton-style settings, accent under Nova), recoloring the container repaints the icon without a restart

## 5. Documentation

- [ ] 5.1 `openspec/project.md` presentation levers note, if needed (pure markup, no new lever)
- [ ] 5.2 README: the container line on icons, the TST-palette dependency (measured against TST 4.4.10: sidebar.js updateContextualIdentitiesStyle, base.css:1252-1261, proton.css:457, nova.css:466-500), the Nova-approximation caveat, no new permissions
- [ ] 5.3 release checklist: feature bump to `0.7.0` in `src/manifest.json` and `package.json` together
