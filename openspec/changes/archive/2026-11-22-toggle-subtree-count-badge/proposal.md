# Proposal: toggle-subtree-count-badge

## Why

The plus badge says "there is folded content behind this icon" but not how
much: on a 350-tab tree one favicon can hide anywhere between one and
fifty rows, and the user learns the size only by activating the icon. The
number is already computed by the derivation pipeline (`subtreeSizes`,
logic.esm.js) — this is presentation, not new state. Tree Style Tab
itself writes the descendant count on every rendered tab row that has
children, folded or unfolded (the row's `tab-counter` element,
TreeItemSubstanceElement.js:127-131); the shelf icon's badge should
repeat that behavior instead of vanishing with the fold.

## What Changes

- The fold badge shows on every shelved tab that has descendants,
  folded or unfolded — TST's counter semantics, minus the parentheses.
  (The original proposal kept the folded-only visibility; that
  condition is lifted in review — see the requirement text.)
- The badge gets two modes: "plus" (the default) and "count" — the
  badge shows the number of the tab's descendant tabs, the same number
  TST's subtree counter writes on its rows.
- The mode is a user option on the extension's first options page;
  changing it applies live, without a restart.
- The requirement "A shelf icon shows a plus badge while the tab's
  children are folded" is renamed to "A shelf icon shows a fold badge
  while the tab has descendants", because in count mode the title's
  "plus" would be false and the folded-only visibility is lifted.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- **shelf-presentation**: renames the fold-badge requirement (plus →
  fold badge) and modifies it to cover the always-on visibility and the
  count mode; adds a requirement for the badge-mode option.

## Impact

- `src/options.html` (new, with `src/options.js` — MV2 pages forbid
  inline scripts, so the setting logic is a separate file) with the
  badge-mode setting (MV2 `options_ui`; no new permission — `storage` is
  already declared).
- `src/manifest.json`: `options_ui`; `src/background/index.esm.js`: the
  option read at boot + `storage.onChanged` → re-derivation.
- `src/background/logic.esm.js`: descendant counts as a derivation
  output (`derive` gains `badgeCounts`, `badgeIds` loses the fold
  condition); `src/background/render.esm.js`: badge text from the mode
  and the counts.
- `build.mjs` (STATIC_FILES) and `scripts/verify-dist.mjs` (REQUIRED):
  the options page and script are new production files; the release
  gate's exact allowlist must be edited consciously.
- README and `openspec/project.md`: the `storage` permission rationale
  widens from "boot diagnostics only" to diagnostics and options.
