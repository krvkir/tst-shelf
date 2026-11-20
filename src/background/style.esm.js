/**
 * The sidebar stylesheet, installed through `register-self`'s `style`
 * (a STRING — never an array; an array throws inside TST's style-install
 * listener and aborts its whole frontend init).  `%EXTRA_CONTENTS_PART%`
 * is replaced by TST with this addon's part name; `::part()` selectors
 * reach INTO the shadow root of each `.extra-items-container` span —
 * the only shadow roots in a tab row (tab-item-substance and its
 * children are plain light DOM, verified in TST 4.4.10 base.css).
 *
 * Layout facts this rests on (TST 4.4.10 sources):
 *  - rows are fixed-height `var(--tab-size)`, derived from #dummy-tab,
 *    which MIRRORS the latest tab-below contents of every addon
 *    (sidebar/size.js phase 1, base.css:183).  One strap would inflate
 *    EVERY row; hence rule 1.
 *  - `.extra-items-container.below` is an in-flow flex column,
 *    `overflow: visible`, `pointer-events: none` (base.css:756-766):
 *    in-flow content grows a `height: auto` row (rule 2), and icons
 *    must re-enable pointer-events (rule 5).
 *  - TST hides rows by the negative-margin pattern, not display:none
 *    (base.css:686); we mirror it for shelved rows (rule 3) so TST's
 *    own layout transitions keep working.  Known v1 deviation: the
 *    virtual scroll computes the container height as rendered-count ×
 *    --tab-size (sidebar/scroll.js), so hidden and grown rows drift the
 *    pixel stack; measured by the E2E scroll case, quantized heights
 *    are the designed fallback (openspec design.md, risks).
 */

export const SHELF_STYLE = `
/* 1. The dummy tab must not mirror our straps, or every row inflates. */
#dummy-tab .extra-items-container.below {
  display: none !important;
}

/* 2. A shelf owner row grows to fit its strap on a SECOND line.
     base.css:183 pins rows at the chain tab-item:not(.faviconized):not(.dummy)
     (specificity 0,2,1) and stretches tab-item-substance (a ROW flex,
     base.css:527) to 100 percent — a plain tab-item.tst-shelf-owner rule
     (0,1,1) never won, and the in-flow below container rendered BESIDE
     the title, sharing the single line.  Match the pseudo-class chain,
     force the height, and make the substance wrap so the full-basis
     below container breaks onto its own line. */
tab-item.tst-shelf-owner:not(.faviconized):not(.dummy) {
  height: auto !important;
  min-height: var(--tab-size);
}
tab-item.tst-shelf-owner:not(.faviconized):not(.dummy) tab-item-substance {
  height: auto !important;
  flex-wrap: wrap;
  align-content: flex-start;
}
tab-item.tst-shelf-owner:not(.faviconized):not(.dummy) tab-item-substance .extra-items-container.below {
  flex-basis: 100%;
  order: 2;
  overflow: visible;
}

/* 3. A shelved row disappears exactly the way TST collapses rows:
     negative margin cancels one row height (base.css:686 pattern),
     visibility removes its paint.  Ghost rows (3b) stay in the flow. */
tab-item.tst-shelf-shelved:not(.tst-shelf-ghost) {
  margin-block-start: calc(0px - var(--tab-current-size) - var(--tab-margin-block-end));
  visibility: hidden;
  pointer-events: none;
  z-index: 0;
}

/* 3b. A ghost row: a shelved tab anchoring a visible nested shelf —
     caption gone, only its own strap remains, at its tree indent. */
tab-item.tst-shelf-ghost {
  visibility: visible;
}
/* Ghost rows must also beat the base.css:183 height chain, and their
   strap must own the full row width (the caption parts are hidden). */
tab-item.tst-shelf-ghost:not(.faviconized):not(.dummy) {
  height: auto !important;
  min-height: 0 !important;
}
tab-item.tst-shelf-ghost:not(.faviconized):not(.dummy) tab-item-substance {
  height: auto !important;
  min-height: 0;
  flex-wrap: wrap;
  align-content: flex-start;
}
tab-item.tst-shelf-ghost:not(.faviconized):not(.dummy) tab-item-substance .extra-items-container.below {
  flex-basis: 100%;
  overflow: visible;
}
tab-item.tst-shelf-ghost tab-twisty,
tab-item.tst-shelf-ghost tab-favicon,
tab-item.tst-shelf-ghost tab-label,
tab-item.tst-shelf-ghost tab-closebox,
tab-item.tst-shelf-ghost .extra-items-container.indent,
tab-item.tst-shelf-ghost .extra-items-container.front,
tab-item.tst-shelf-ghost .extra-items-container.behind,
tab-item.tst-shelf-ghost .extra-items-container.above {
  display: none;
}
tab-item.tst-shelf-ghost tab-item-substance {
  height: auto;
  min-height: 0;
}

/* 4. The root shelf strap: #tabbar-top renders above all tabs —
     directly above the global pinned box when pinned tabs exist
     (TST has no slot below the pinned box; the deviation is recorded
     in openspec design.md).  The container is plain light DOM here. */
#tabbar-top .extra-items-container::part(%EXTRA_CONTENTS_PART% shelf-strap) {
  display: grid;
  grid-template-columns: repeat(auto-fill, var(--faviconized-tab-size));
  gap: 2px;
  padding: 2px;
}

/* 5. Icon straps inside owner rows: grid wrap, faviconized cell size. */
tab-item .extra-items-container.below::part(%EXTRA_CONTENTS_PART% shelf-strap) {
  display: grid;
  grid-template-columns: repeat(auto-fill, var(--faviconized-tab-size));
  gap: 2px;
  padding: 2px 0;
}

/* 6. One shelf icon: a favicon cell, NOT a <button> (TST cancels native
     drags started on button/select/scrollbar targets).  pointer-events
     must be re-enabled: the below container is pointer-events: none. */
::part(%EXTRA_CONTENTS_PART% shelf-icon) {
  pointer-events: auto;
  position: relative;
  width: var(--faviconized-tab-size);
  height: var(--faviconized-tab-size);
  box-sizing: border-box;
  background-color: color-mix(in srgb, currentColor 8%, transparent);
  background-position: center;
  background-repeat: no-repeat;
  background-size: var(--favicon-size);
  border-radius: var(--border-radius-small, 3px);
}

/* 6b. Highlight while the member or its subtree is active: theme colors,
     exactly like the selected tab row. */
::part(%EXTRA_CONTENTS_PART% shelf-icon tst-shelf-icon-active) {
  background-color: var(--tab-surface-active, Highlight);
  box-shadow: inset 0 0 0 1px var(--tab-border-color, currentColor);
}

/* 7. The folded-subtree plus badge: shown only while children are
     folded (it disappears when the subtree is unfolded — no minus). */
::part(%EXTRA_CONTENTS_PART% shelf-badge) {
  display: none;
  position: absolute;
  inset-inline-end: 0;
  inset-block-end: 0;
  font: message-box;
  font-size: 10px;
  line-height: 10px;
  padding: 0 2px;
  color: var(--tab-text);
  background-color: color-mix(in srgb, currentColor 20%, transparent);
  border-start-start-radius: 3px;
  pointer-events: none;
}
::part(%EXTRA_CONTENTS_PART% shelf-badge tst-shelf-badge-on) {
  display: block;
}
`;
