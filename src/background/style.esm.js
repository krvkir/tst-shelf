/**
 * The sidebar stylesheet, installed through `register-self`'s `style`
 * (a STRING — never an array; an array throws inside TST's style-install
 * listener and aborts its whole frontend init).  `%EXTRA_CONTENTS_PART%`
 * is replaced by TST with this addon's part name; `::part()` selectors
 * reach INTO the shadow root of each `.extra-items-container` span —
 * the only shadow roots in a tab row (tab-item-substance and its
 * children are plain light DOM, verified in TST 4.4.10 base.css).
 *
 * THE UNIFORM-ROW LAW (TST 4.4.10, verified the hard way):
 *  TST never measures painted rows.  Sidebar geometry — drag-and-drop
 *  zones (drag-and-drop.js: quarters of `Scroll.getItemRect`), the
 *  virtual scroll (scroll.js: `translateY(itemSize * index)`,
 *  min-height = itemSize * count) and sticky rows — all COMPUTE
 *  positions as `renderedTabHeight * index over renderable items`
 *  (scroll.js getItemRect).  Every renderable row must therefore be
 *  exactly one --tab-size tall at exactly its computed offset: any
 *  per-row deviation (a grown row, a zero-height row) shifts every
 *  computed rect below it while painting stays DOM-accurate — the two
 *  disagree, and drag-overs on shifted rows resolve to wrong drop
 *  positions (always "after"), with the marker drawn on the row while
 *  the decision comes from drifted coordinates.  tst-shelf 0.1.1 broke
 *  drops below every shelf this way; 0.1.4 conforms by construction.
 *
 * The layout under this law (0.1.4, "the shelf lives in the owner's
 * own row"):
 *  - the strap is rendered into the OWNER's `tab-below` extra contents,
 *    but as a flex ITEM beside the caption, not as a second line: the
 *    row keeps its default height and TST's arithmetic stays exact;
 *  - the caption (twisty, favicon, label) shrinks; TST's own
 *    `tab-label { overflow: hidden; white-space: nowrap; text-overflow }`
 *    truncates the title, and TST's tab preview tooltip shows the full
 *    one on hover;
 *  - the strap takes at most 2/3 of the row and scrolls horizontally
 *    when the icons do not fit (one line, never a wrapped block);
 *  - members keep NO row at all: they are hidden through
 *    `browser.tabs.hide()` (the only lever that removes a tab from
 *    TST's renderable set without breaking the law — a member row that
 *    paints 0 while TST counts it is exactly the 0.1.1 drift).
 */

export const SHELF_STYLE = `
/* 1. The dummy tab must not mirror our straps, or every row inflates:
     TST sizes ALL rows from #dummy-tab, which mirrors every addon's
     tab-below contents (sidebar/size.js, base.css:183). */
#dummy-tab .extra-items-container.below {
  display: none !important;
}

/* 2. The owner row: caption on the left, shelf on the right, one line.
     .ui is a COLUMN flex by default (caption above the below-container,
     base.css:546-554) — a row flex puts the shelf BESIDE the caption
     instead of under it, so the row never grows. */
tab-item.tst-shelf-owner .ui {
  flex-direction: row;
  align-items: center;
  gap: 2px;
}

/* 2a. The caption shrinks to make room; min-width: 0 is what lets a
     flex item go below its content width — without it the label pins
     the caption at full width and the strap overflows the row. */
tab-item.tst-shelf-owner .caption {
  flex: 1 1 auto;
  min-width: 0;
  width: auto;
}

/* 2b. The shelf itself: a flex item on the right, at most 2/3 of the
     row (spec shelf-presentation).  It is taken OUT of the vertical
     flow of .ui by being a sibling of the caption in the row flex —
     the owner row keeps its default height, the uniform-row law.

     flex-shrink MUST be 0: the caption's flex basis is the whole
     untruncated title, so when basis(caption) + basis(shelf) exceed
     the row, the browser shrinks BOTH proportionally to their bases —
     a long title then eats the shelf's width and the strap starts
     scrolling inside less than one icon (user-reported in 0.1.4).  With
     shrink 0 the caption absorbs the whole deficit, which is exactly
     what a truncating title is for. */
tab-item.tst-shelf-owner .extra-items-container.below {
  flex: 0 0 auto;
  min-width: 0;
  max-width: 66%;
  align-self: center;
  position: static;
}

/* 3. One line of favicon cells, horizontally scrollable past the 2/3
     budget.  The scrollbar is hidden (a scrollbar inside a 1-line row
     would eat the icons' height); shift+wheel and trackpad gestures
     scroll it. */
tab-item.tst-shelf-owner .extra-items-container.below::part(%EXTRA_CONTENTS_PART% shelf-strap) {
  display: flex;
  flex-direction: row;
  flex-wrap: nowrap;
  align-items: center;
  gap: 3px;
  max-width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  pointer-events: auto;
}

/* 4. The root shelf strap: #tabbar-top renders above all tabs —
     directly above the global pinned box when pinned tabs exist (TST
     has no slot below the pinned box; the deviation is recorded in
     openspec design.md).  Plain light DOM, outside the rows' flow: it
     cannot disturb the uniform-row law. */
#tabbar-top .extra-items-container::part(%EXTRA_CONTENTS_PART% shelf-strap) {
  display: flex;
  flex-direction: row;
  flex-wrap: nowrap;
  align-items: center;
  gap: 2px;
  padding: 2px;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  pointer-events: auto;
}

/* 5. One shelf icon: a favicon cell, NOT a <button> (TST cancels native
     drags started on button/select/scrollbar targets).  pointer-events
     must be re-enabled: the below container is pointer-events: none. */
::part(%EXTRA_CONTENTS_PART% shelf-icon) {
  pointer-events: auto;
  flex: 0 0 auto;
  position: relative;
  width: var(--faviconized-tab-size);
  height: var(--faviconized-tab-size);
  max-height: calc(var(--tab-size) - 4px);
  box-sizing: border-box;
  background-color: color-mix(in srgb, currentColor 8%, transparent);
  background-position: center;
  background-repeat: no-repeat;
  background-size: var(--favicon-size);
  border-radius: var(--border-radius-small, 3px);
}

/* 5b. Highlight while the member or its subtree is active: theme
     colors, exactly like the selected tab row. */
::part(%EXTRA_CONTENTS_PART% shelf-icon tst-shelf-icon-active) {
  background-color: var(--tab-surface-active, Highlight);
  box-shadow: inset 0 0 0 1px var(--tab-border-color, currentColor);
}

/* 6. The folded-subtree plus badge: shown only while children are
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
