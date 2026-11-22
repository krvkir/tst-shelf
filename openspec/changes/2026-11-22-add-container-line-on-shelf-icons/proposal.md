# Proposal: add-container-line-on-shelf-icons

## Why

Firefox and Tree Style Tab mark every tab row of a container with a thin
color line (the contextual-identity marker; under container-based
workspace extensions such as tst-workspace this line is what the user
reads as the workspace marker). A shelved tab keeps its container, but
its row is gone, so the marker vanishes exactly when the tab is put on
the shelf: a regular tab loses its workspace marker on shelving. The
shelf icon — the shelved tab's only presentation — must carry the
notation instead, so a mixed shelf still reads container by container.

## What Changes

- A shelf icon shows the container color line whenever its shelved tab
  belongs to a Firefox container (contextual identity), painted the way
  the active Tree Style Tab theme paints the marker on regular tab rows:
  the tab's own container color and geometry, with the line's vertical
  extent bounded by the icon cell (the only allowed deviation, since the
  cell is inset from the row edges).
- No line on icons of tabs in the default container or in a private
  window — exactly as regular rows of those tabs show no marker.
- Per-member coloring on mixed shelves: each icon's line follows its own
  tab's container, never the owner's.
- The line follows a container change live, at the next strap re-render,
  with no state of its own.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- **shelf-presentation**: adds a requirement for the container line on
  shelf icons.

## Impact

- `src/background/render.esm.js`: the marker span in `iconHtml`
  (unit-tested in `tests/render.test.mjs`).
- `src/background/style.esm.js`: the marker rules in the registered
  stylesheet, including the per-theme geometry branches
  (`:root[data-style=...]`).
- No new permissions and no stored state: the color comes from Tree
  Style Tab's own per-identity stylesheet variables (Route 1; verified
  against TST 4.4.10, `sidebar/sidebar.js:updateContextualIdentitiesStyle`
  and the `--contextual-identity-marker` rules), and `cookieStoreId`
  already rides every `browser.tabs.Tab` the derivation snapshots.
- `build.mjs`: the E2E flavor gains `contextualIdentities` + `cookies`
  permissions so the smoke page can create a real container and a
  container tab; `dist/` and `scripts/verify-dist.mjs` stay untouched.
- `tests/e2e-drive.mjs` + `src/tests-smoke.js`: container setup and the
  marker assertions; README caveat for the Tree-Style-Tab-palette
  dependency and the Nova geometry.
