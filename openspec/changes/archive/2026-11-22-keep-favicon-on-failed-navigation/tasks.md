# Tasks: keep-favicon-on-failed-navigation

## 1. Measurement

- [x] 1.1 E2E probe: navigate a shelved tab to a refused connection (`http://127.0.0.1:9/`) and record the `favIconUrl` / `url` / `status` timeline through the existing `test:navigate` + `test:state` hooks
- [x] 1.2 decide from the probe the default-favicon URL blocklist and the origin-reset rule; record both in this design

## 2. Pure derivation

- [x] 2.1 `resolveFavicons` memory values become `{favIconUrl, pageUrl}`; add the default-favicon predicate (pure, exported for tests)
- [x] 2.2 keep on: same-page blank (loading), error-page blank; reset on: cross-site delivery; a default-URL delivery never overwrites a remembered site icon
- [x] 2.3 unit tests for the full matrix (loading, failed reload, failed navigation, successful cross-site navigation, default URL, first-seen tab)

## 3. Background wiring

- [x] 3.1 thread the new memory shape through `rederive` (the only writer and reader of the memory)
- [x] 3.2 verify no other consumer assumes a plain-string value (`faviconMemory` is deleted in `tabs.onRemoved`; the `test:state` favicons export reads patched tab records, unchanged)

## 4. Verification

- [x] 4.1 E2E phase 1: a shelved tab whose reload fails keeps its favicon in `test:state`'s `favicons` export
- [x] 4.2 E2E phase 2: the sidebar DOM keeps the icon's `style` attribute through the failed navigation (the diffing renderer emits nothing)
- [x] 4.3 two consecutive clean `make e2e` runs

## 5. Documentation

- [x] 5.1 README: extend the favicon caveat with the failed-navigation rule and the undetectable broken-icon case
- [x] 5.2 version bump in `src/manifest.json` and `package.json` together (release checklist)
