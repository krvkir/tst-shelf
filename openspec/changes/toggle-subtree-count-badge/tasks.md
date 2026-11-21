# Tasks: toggle-subtree-count-badge

## 1. Pure derivation

- [x] 1.1 `derive` returns `badgeCounts` (descendant counts for members with folded children) computed in its own walk
- [x] 1.2 `strapHtml` renders the badge text from the mode and the counts map
- [x] 1.3 unit tests: the count excludes the member itself, folded-only visibility unchanged, plus mode unchanged, three-digit counts render
- [x] 1.4 `make perf` — the extra walk stays inside the budgets

## 2. Options surface

- [x] 2.1 `src/options.html` with the badge-mode setting (inline script, `storage.local`)
- [x] 2.2 `src/manifest.json`: `options_ui`
- [x] 2.3 background: read the mode at boot and at every derivation; `storage.onChanged` → `scheduleRederiveAll`
- [x] 2.4 `build.mjs` STATIC_FILES and `scripts/verify-dist.mjs` REQUIRED gain `options.html`

## 3. Verification

- [x] 3.1 E2E: default plus mode renders "+" (existing phase-2 assertions stay green unchanged)
- [x] 3.2 E2E: flip the mode through a test hook → the sidebar DOM shows the counts; flip back → plus again
- [x] 3.3 E2E: the boot path reads the stored mode (set through the hook, force a re-derive, assert the badge text)
- [x] 3.4 `make verify-dist` names the options page in the production tree
- [x] 3.5 two consecutive clean `make e2e` runs

## 4. Documentation

- [x] 4.1 README: the option; the `storage` permission rationale widens to diagnostics and options
- [x] 4.2 `openspec/project.md`: the permission-surface line for `storage`
- [ ] 4.3 version bump in `src/manifest.json` and `package.json` together (release checklist)
