# Design: toggle-subtree-count-badge

## Context

The badge is rendered by `iconHtml` from the derivation's `badgeIds` set;
the count needs the same walk the placement loop already performs
(`subtreeSizes`, logic.esm.js), but `derive` exports no sizes today and
the renderer receives only `badgeIds`. The option surface is new ground:
the addon ships no options page and stores nothing user-facing (the
`storage.local` rationale in project.md and the README says "boot
diagnostics only").

The visibility condition changed in review: TST's own subtree counter
(the `tab-counter` element in every row's caption,
TreeItemSubstanceElement.js:127-131; `textContent = descendants.length`,
TabCounterElement.js:63-67 — the `counterRole` +1 branch is dead code,
`configs.counterRole` is referenced but never defined) shows on every row
with `data-child-ids`, folded or unfolded; the badge now matches that, so
the count in count mode is by construction the same number TST writes.

## Goals / Non-Goals

- Goal: an always-on fold badge for members with descendants, two
  rendering modes, one storage key (`badgeMode: "plus" | "count"`), live
  application through the existing derivation path.
- Non-goal: styling options, per-shelf modes, or settings sync; the
  options page carries this one setting only.

## Decisions

1. **The count is a derivation output.** `derive` gains
   `badgeCounts: Map<id, descendants>` computed from one
   `subtreeSizes(tree)` pass; `strapHtml` takes the counts beside
   `badgeIds`. Measured after landing: the full 350-tab pass stays at
   0.46 ms median / 1.42 ms worst against the 20/100 ms budgets — two
   orders of magnitude of headroom remain (tests/perf.mjs).
2. **`storage.local` for the setting, `storage.onChanged` for the live
   update.** The options page writes the key; the background listener
   schedules a window-wide re-derivation, and the strap diff re-sends
   only the straps whose badge text changed. No restart, no second
   derivation path, no per-shelf special case.
3. **Options page = MV2 `options_ui`, two files.** The original plan
   said "inline script" — MV2 default CSP (`script-src 'self'`) forbids
   inline scripts, so the setting logic lives in its own `options.js`
   beside `options.html`. No new permission (`storage` declared), no
   host permissions, no content scripts. `build.mjs` copies both and
   `scripts/verify-dist.mjs` adds them to REQUIRED — the gate's
   allowlist is exact by design ("unexpected file in a production tree"
   fails the release), and this edit is the conscious decision point
   that rule exists for. Measured: `verify-dist` reports 6 files.
4. **Rename, not retitle-in-place.** The requirement title named the
   plus; in count mode that title would be false, and the review change
   also lifts the folded-only visibility. The delta renames it once to
   "A shelf icon shows a fold badge while the tab has descendants" and
   modifies the body under the new title. Titles are the matching key
   for every future delta — an honest title now avoids a
   MODIFIED-on-a-wrong-title later.

## Risks / Trade-offs

- [The storage permission rationale is contract text] → the change edits
  `openspec/project.md` (permission surface) and the README permissions
  section; the widening is stated in the proposal.
- [The options page ships to `dist/`] → `verify-dist` grows the expected
  file BEFORE any release runs; `make release` fails closed otherwise.
- [3-digit counts (350-tab trees) overflow the badge] → the badge's
  font-size budget is pinned by the E2E's sidebar-DOM assertion, not
  left to taste.

## Open Questions

- None blocking.
