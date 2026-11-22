# Design: add-container-line-on-shelf-icons

## Context

Tree Style Tab paints the container marker on rendered rows only:
`TreeItemSubstanceElement.ensureContextualIdentityMarker`
(sidebar/components/TreeItemSubstanceElement.js:697) appends a
`<span class="contextual-identity-marker">` when the row's state set
gains `contextual-identity-<cookieStoreId>` (added per `cookieStoreId`
update in common/tabs-update.js:318-327). Shelved members are hidden
tabs without rows, so their marker has no host — this is the reported
bug ("regular tabs lose their workspace markers when they get
shelves"). The marker's style and palette live in two TST stylesheets
of the sidebar document, both updated live:

- Palette — `updateContextualIdentitiesStyle` (sidebar/sidebar.js:496-510)
  declares, for every real identity (custom containers included), a root
  variable `--contextual-identity-color-<cookieStoreId>` whose value is
  the identity's `colorCode` hex (e.g. `#37adff`) or a themed keyword
  var. `firefox-default` and `firefox-private` are not identities, so
  they get no variable. Rebuilt at sidebar init and on every
  `ContextualIdentities.onUpdated` (sidebar/sidebar.js:1047).
- Geometry — sidebar/styles/base.css:1252-1261 is the baseline
  (thin vertical bar: width `calc(var(--favicon-size) / 8)` — 2 px at
  the default 16 px favicon — at the row's inline end, block-inset by
  `--contextual-identity-marker-margin`); proton.css:457 shifts the bar
  inward by `--tab-highlighter-size`; nova.css:466-500 replaces it with
  a horizontal accent (height = marker size, spanning the pill).
  Photon, sidebar and highcontrast styles define no marker of their own
  and inherit the base geometry. The active theme is readable from the
  sidebar root: `document.documentElement.dataset.style = style`
  (sidebar/sidebar.js:380).

The shelf side: our icon cells are already `position: relative`
(SHELF_STYLE rule 5) and every icon decoration (fold badge, audio
indicator, hint chip) is a passive, absolutely positioned child of the
cell. `iconHtml` receives the full `browser.tabs.Tab` through
`tabsById` (index.esm.js:497-506), and `tab.cookieStoreId` is always
present on those snapshots (MDN `tabs.Tab`). The strap diff is an
exact-string compare (render.esm.js `writeStrap`), so an icon whose
markup text changes for any reason re-sends and an unchanged one does
not — no additional ledger.

## Goals / Non-Goals

- Goal: the container line on shelf icons, visually matching the row
  marker (color source and cross-section) of the active TST theme.
- Goal: no new permission, no stored state, no second palette
  ("derive, do not remember").
- Non-goal: re-implementing the Firefox-native strip's own marker; the
  sidebar is the surface.
- Non-goal: styling the line per theme from our side beyond the marker
  geometry — the marker has no text, no hover, no user option.
- Non-goal: owner rows. Their markers already paint (they are regular
  rows) and must keep doing so untouched.

## Decisions

1. **Route 1 — the color is a TST palette reference, not a value.** The
   marker span's inline `style` carries one custom property:
   `--shelf-marker: var(--contextual-identity-color-<cookieStoreId>,
   transparent)`, and the registered stylesheet paints
   `background-color: var(--shelf-marker)`. Inline `style` attributes
   survive TST's sanitizer — the route the favicons already use
   (render.esm.js header; `faviconStyleOf`). Consequences: custom
   containers get exact `colorCode` values; a container recolor
   (ContextualIdentities.onUpdated → updateContextualIdentitiesStyle)
   repaints our icons with no re-derivation; unknown or future
   cookieStoreIds degrade to `transparent` (no line), never to a wrong
   color. Cost: the var prefix is TST-internal, pinned to TST 4.4.10 in
   the README. The palette dependency is one-way (we read nothing, TST
   needs nothing from us).
2. **Emission gate in the markup, not the stylesheet.** `iconHtml`
   emits the span iff `tab.cookieStoreId` is set and is neither
   `firefox-default` nor `firefox-private` — the only two no-identity
   cookie stores a shelved tab can carry (the palette has no vars for
   them either way, so the gate is a DOM economy, not a correctness
   device). Members of mixed shelves each carry their own cookieStoreId,
   so per-member coloring is automatic; the owner's row color is
   deliberately NOT inherited — it would paint the owner's color on
   every member.
3. **A dedicated passive part `shelf-marker`, mirroring `shelf-sound`.**
   A child span of the icon cell, `pointer-events: none`, no
   `data-tab-id` of its own (click/drag routing stays on the cell),
   placed FIRST among the cell's children so the fold badge and audio
   indicator paint over it where they overlap, and under the hint chip
   (the chip's own z-index is higher already). The uniform-row law is
   untouched: absolutely positioned inside the cell, no flow, no row
   height, dummy-tab mirrors unaffected (rules 1 and 8b stay).
4. **Geometry mirrors the row marker of the active theme.** Base rule:
   cross-section `calc(var(--favicon-size) / 8)` — TST's own formula,
   so it scales with the user's favicon size — at the cell's inline
   end, block-inset within the cell (the icon cell is inset from the
   row edges, so a shorter vertical extent is accepted; the user's
   words: "in all other respects the same"). Two theme branches key on
   `:root[data-style=...]`: proton shifts the bar inward by
   `--tab-highlighter-size`; nova switches to the horizontal accent
   across the cell's top region, with the row-relative offsets the
   nova.css marker block uses. The unknown/other dataset values fall
   through to the base geometry (what photon/sidebar/highcontrast do).
   If TST stops setting `dataset.style`, nothing breaks: branches
   simply stop matching and the base rule applies.
5. **No state to release at boot.** The marker exists only in the strap
   markup, rebuilt by the ordinary derivation. A container change on a
   shelved tab (e.g. its native context menu's "Reopen in Container",
   through `tabs.onUpdated`'s shelved branch → re-derivation) changes
   the markup string and re-sends exactly that icon.
6. **E2E: the flavor creates a real container.** A clean profile has
   none, so the smoke page (an extension page) creates one with
   `contextualIdentities.create` and then tabs with
   `browser.tabs.create({cookieStoreId})` — both need the
   `contextualIdentities` and `cookies` permissions, which the E2E
   patch (`build.mjs` `applyE2EPatch`) already adds for `downloads` and
   host patterns. Production stays permission-free and `verify-dist`'s
   whitelist untouched; the E2E asserts the `shelf-marker` part on a
   container member's icon in the sidebar DOM, its absence for a
   default-container member, and the registered stylesheet's marker
   rule (the sound change precedent: assert the shipped CSS survived).

## Risks / Trade-offs

- [The palette prefix `--contextual-identity-color-<id>` is TST
  internals] → pinned to TST 4.4.10 in the README's verified-notes
  section; `transparent` fallback degrades to "no line" rather than a
  wrong color. Route 2 (query `contextualIdentities` ourselves) was
  rejected: it buys independence by adding a permission, a re-review
  and a `verify-dist` edit, while re-implementing the palette TST
  already keeps in the sidebar document.
- [Nova users see a horizontal accent on rows, and the icon's accent is
  our approximation of its offsets] → README caveat; the color and
  cross-section still match exactly. Proton-family users (the reporter
  of the bug, who described the vertical line) get the exact geometry.
- [A future TST rename of the marker var or `dataset.style`] → degrades
  to invisible or base geometry; no crash; README records the
  integration as measured, like the other TST-internal hooks.

## Open Questions

- None.
