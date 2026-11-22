# Proposal: keep-favicon-on-failed-navigation

## Why

A shelf icon is its tab's whole presentation, so a lost favicon costs more
than a blank row: when a shelved tab's site cannot be reached — VPN down,
DNS dead, crash — the browser's favicon route delivers the default icon and
the strap loses the site identity it exists to carry. The loading case is
already handled (the icon keeps the last known favicon while `favIconUrl`
is absent), but a *failed* navigation can deliver a default icon as a
truthy value, which the current memory overwrites without a check.

## What Changes

- The shelf icon keeps the favicon it had before a navigation that fails to
  reach the site (connection refused, name-resolution failure, crash page)
  instead of showing the browser-default icon.
- A *successful* navigation to a different page resets the memory: the
  previous site's favicon is never shown for a new site, so an iconless
  page renders with the default, not with stale identity.
- Firefox's exact reporting for the failed case is measured first (E2E
  probe); the detection rule derives from the measurement, not from an
  assumption.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- **shelf-presentation**: the requirement "A shelf icon shows the tab's
  favicon, title, and URL on hover" is modified: failed navigations keep
  the last known favicon, and successful cross-site navigations reset the
  memory.

## Impact

- `src/background/logic.esm.js`: `resolveFavicons` — the memory values grow
  from a URL string to `{favIconUrl, pageUrl}`; a default-favicon
  predicate; the origin-change reset. Pure, unit-tested.
- `src/background/index.esm.js`: the memory shape at its call sites; no new
  state — the favicon memory stays session-scoped presentation memory.
- `tests/logic.test.mjs`: the keep/reset matrix; `tests/e2e-drive.mjs` +
  `src/tests-smoke.js`: the failed-navigation probe and assertions.
- No manifest, permission or TST-API changes.
