# Tasks: add-shelf-placement-commands

## 1. Pure derivation

- [x] 1.1 `planExtremePlacementMove` in logic.esm.js: leftmost (`move-before` the first member), rightmost (`move-after` the last member, plus `outdent` when it has descendants), `null` when already in place
- [x] 1.2 planning in tree-walk order (`treePositions`), references chosen inside the member block only
- [x] 1.3 unit tests: mid-shelf both ways, root shelf, moved member with children, already-extreme no-op, single-member shelf no-op, last member with descendants (the outdent case)

## 2. Background wiring

- [x] 2.1 create the "Shelf" parent and the two children (own `browser.menus` items, `contexts: ["tab"]`); extend `menuTelemetry.items`
- [x] 2.2 `applyMenuVisibility`: the parent's visibility flips with the tab's shelved state (check whether the children need flips too on the target Firefox)
- [x] 2.3 `menus.onClicked`: route the two ids to the planner, apply through `move-before` / `move-after`(+`outdent`) with `followChildren: true`, then `scheduleRederive`
- [x] 2.4 E2E hook: `test:menu-shown` telemetry grows the submenu items

## 3. Verification

- [x] 3.1 unit tests green (`make test`)
- [x] 3.2 E2E phase 1: "Place rightmost" on a mid-shelf member moves it to the end of its shelf (assert through the shelved order in `test:state`); "Place leftmost" mirrors it
- [x] 3.3 E2E: the member block stays contiguous after the move — no extra rows appear and the derivation reports the same shelves
- [x] 3.4 E2E: menu telemetry shows the submenu hidden for unshelved tabs and visible for shelved ones
- [x] 3.5 two consecutive clean `make e2e` runs

## 4. Documentation

- [x] 4.1 README: the submenu, the two commands, and the deferred drag-reorder note with the measured TST surface facts
- [ ] 4.2 version bump in `src/manifest.json` and `package.json` together (release checklist)
