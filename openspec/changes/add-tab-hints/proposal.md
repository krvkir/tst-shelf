# Proposal: add-tab-hints

## Why

Trees of 350+ tabs make mouse travel the bottleneck: reaching a tab means
scrolling to its row — or remembering which shelf icon holds it — and
clicking. Vimium solved this for links: press a key, read the two-letter
codes, type one, the link activates. The same interaction fits the
sidebar, and shelved tabs need it most: they have no rows, so every
keyboard flow the tree has today is blind to them.

The existing capabilities cover shelf surfaces; hint codes enumerate every
visible tab of the window, rendered rows included, so the feature gets its
own capability (`tab-hints`) instead of stretching `shelf-interaction` to
rows that are not shelf icons.

## What Changes

- A browser keyboard command (rebindable in about:addons) starts hint
  mode for the focused window's tab strip.
- Every visible tab — rendered rows and shelf icons — carries a short,
  unique code label; codes follow the rendered order and grow in length
  only when the tab count demands it.
- Typing a code activates that tab: a shelved tab exactly as a primary
  click on its icon does (selection, fold swap, reveal rules), a row tab
  as its row click does. Backspace un-types; Escape exits; losing
  keyboard focus exits.
- Hint labels never change row geometry (the uniform-row law), and the
  mode is runtime-only: nothing persists, nothing hides a tab, no
  boot-release path is needed.

## Capabilities

### New Capabilities

- `tab-hints`: keyboard activation of visible tabs through short hint
  codes — mode entry and exit, code assignment, label rendering, and
  activation semantics.

### Modified Capabilities

None — the empty-root-shelf space rule and the uniform-row requirements
keep their existing wording; the key catcher renders zero-size, so no
existing requirement's behavior changes.

## Impact

- `src/manifest.json`: a `commands` entry (commands carry no permission).
- `src/background/logic.esm.js`: pure `assignHints` over the visible set.
- `src/background/render.esm.js`: hint spans in `iconHtml`/`strapHtml`;
  per-row labels through `set-extra-contents` (`tab-above`); the root
  strap always carries a zero-size key catcher.
- `src/background/index.esm.js`: the per-window mode state machine,
  `commands.onCommand`, `extra-contents-keydown`/`-focus`/`-blur`
  handlers, the `focus-to-extra-contents` call, and the rendered-rows
  ledger from `tabs-rendered` / `tabs-unrendered`.
- `src/background/tst-api.esm.js`: the methods list grows
  `focus-to-extra-contents`.
- `src/background/style.esm.js`: the label rules and the `#dummy-tab
  .above` twin of the load-bearing below-rule.
- `tests/logic.test.mjs`, `tests/render.test.mjs`, `tests/e2e-drive.mjs`,
  `src/tests-smoke.js`; README; `openspec/project.md` capabilities list.
