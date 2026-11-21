## 1. Specs and baseline

- [x] 1.1 Change `remove-companion-patch` with deltas: remove
      `companion-capabilities`, remove the multi-line presentation
      requirements, restate the member-row and reveal requirements as
      hide-based
- [x] 1.2 Record the pre-change green state: `node --test tests/` 72 passing,
      `make e2e` 101 passing assertions against stock TST

## 2. Layout axis out of the background page

- [x] 2.1 Delete `shelfLayoutMode`, `computeShelfLines`, `linesOf`, the
      `shelf-layout` setting, its loader and its storage listener
- [x] 2.2 Delete `sidebarWidths`, `recordSidebarWidth` and the
      `tabbar-resized` subscription
- [x] 2.3 Delete `shelfLines`, `lineOverrides` and the six geometry constants
- [x] 2.4 Reduce `checkTstUsable` to the major-version test; drop the
      capability object and its log line
- [x] 2.5 Drop the `linesOf` injection and the `lines` ledger field in
      `render.esm.js`; drop the `tst-shelf-lines` state class
- [x] 2.6 Delete CSS rule 3b; make `SHELF_GAP_PX` local to the stylesheet
- [x] 2.7 Delete the dead `invalidate` method

## 3. Reveal lever collapsed to hiding

- [x] 3.1 `reconcileSuppressed`: one applied ledger, one hide branch, one
      show branch
- [x] 3.2 `endReveal`: one suppression-hold loop
- [x] 3.3 Keep `SUPPRESSED_KEY`, `rememberSuppressed`, `releaseSuppressed`
      and the collapse-animation hold unchanged

## 4. Row-less member path out

- [x] 4.1 `reconcileHidden`: keep only the hide/show halves; delete
      `wantRowLess`, `toRowLess`, `offRowLess` and the two state batches
- [x] 4.2 Delete `restoreMemberRow` and its two call sites
- [x] 4.3 Delete the `rowLessByUs` guards in `selectShelfTab`, `hideNow`,
      `takeOffShelf` and the tab-close cleanup
- [x] 4.4 Delete `rowLessTries`, `MAX_ROW_LESS_TRIES` and the `tabs-rendered`
      retry block
- [x] 4.5 Delete `forceRowLessResync`; keep `renderer.forceStateResync`
- [x] 4.6 Keep the childless-member bail-out in `maybeBeginReveal` and fix
      its comment
- [x] 4.7 Drop `capabilities`, `layout`, `widths`, `lines`, `rowLessByUs`,
      `suppressedByUs`, `rowLessTries` and `rowLessDebug` from `test:state`;
      delete the `test:lines` and `test:tab-state` hooks

## 5. Test rig retired

- [x] 5.1 Delete `tests/patch-tst.sh`, `tests/tst-patched.xpi` and the
      `.gitignore` entry
- [x] 5.2 Makefile: drop `TST_PATCHED`, its rule and `e2e-patched`; `e2e` is
      the single stock run, and `release` depends on it
- [x] 5.3 `e2e-drive.mjs`: drop `--tst`, the profile surgery, the temporary
      install, the A3 block, the B probe and the crowded-shelf block
- [x] 5.4 Delete the four now-unused page scripts (`scrollSidebarScript`,
      `extentScript`, `shelfFitScript`, `rowlessProbeScript`)

## 6. Expectations restated, not weakened

- [x] 6.1 The nested-member check asserts a row unconditionally
- [x] 6.2 The reveal checks assert the hide ledger and the browser's `hidden`
- [x] 6.3 The two capability-split smoke records become single hide-based
      records
- [x] 6.4 The renderer test asserts that an unchanged markup is not re-sent

## 7. Documentation

- [x] 7.1 README: replace the two-capability section with the rejection note;
      rewrite the permissions, reveal and member-row paragraphs; single E2E
      run in the build table
- [x] 7.2 `openspec/project.md`: glossary, presentation levers, permission
      surface, superseded decisions
- [x] 7.3 Delete `docs/tst-row-geometry-patch.md` and the
      `add-discrete-row-geometry` change
- [x] 7.4 Bump the manifest and package version to 0.2.3
