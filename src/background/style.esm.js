/**
 * The sidebar stylesheet, installed through `register-self`'s `style`
 * (a STRING — never an array; an array throws inside TST's style-install
 * listener and aborts its whole frontend init).  `%EXTRA_CONTENTS_PART%`
 * is replaced by TST with this addon's part name; `::part()` selectors
 * reach INTO the shadow root of each `.extra-items-container` span —
 * the only shadow roots in a tab row (tab-item-substance and its
 * children are plain light DOM, verified in TST 4.4.10 base.css).
 *
 * THE TEMPLATE TRAP (0.6.3, paid for with an E2E run): this whole
 * stylesheet is ONE template literal.  A RAW backtick inside it (CSS
 * comments quoting selectors, e.g. \`.above\` in rule 8a) does not end
 * the file — it ends THE TEMPLATE, the rest parses as a tagged-
 * template call on the string's (missing) property, esbuild bundles
 * it without any diagnostics, and the bundle then throws
 * \`... is not a function\` at every boot, silently killing
 * register-self.  Every backtick here MUST be escaped (\\\`).  The
 * guard is tests/style.test.mjs, which CALLS buildShelfStyle and
 * asserts the tail rules survive; keep it green before committing.
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
 *  - the strap takes at most 2/3 of the row; when the icons do not fit it
 *    scrolls horizontally, so the row keeps its one-line height;
 *  - members keep NO row at all: they are hidden through
 *    `browser.tabs.hide()` (the only lever that removes a tab from
 *    TST's renderable set without breaking the law — a member row that
 *    paints 0 while TST counts it is exactly the 0.1.1 drift).
 */

/** The gap between shelf cells, in px. */
const SHELF_GAP_PX = 3;

/** The default hint chip font size, in px: the user option
 *  storage.local.hintFontSize.  0.6.2 painted 11px; the option default
 *  is a notch larger (12px) because the chips are dense two-to-four
 *  letter labels the user reads whole. */
export const DEFAULT_HINT_FONT_SIZE_PX = 12;

/** The stylesheet with the hint chip size baked in.  The chips paint
 *  from TST's own shadow parts, so there is no element of ours in a
 *  row that could carry a CSS custom property down to them — the size
 *  must live in the registered style string itself.  An option change
 *  therefore re-runs register-self: TST's installStyle REPLACES the
 *  addon's <style> text in every live sidebar (measured in TST 4.4.10,
 *  tst-api-frontend.js installStyle), and the chips restyle at once,
 *  mid-mode included. */
export function buildShelfStyle (hintFontSize = DEFAULT_HINT_FONT_SIZE_PX) {
	const value = Number(hintFontSize);
	const fontPx = Number.isFinite(value) && value >= 10 && value <= 18
		? Math.round(value) : DEFAULT_HINT_FONT_SIZE_PX;
	return `
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
  gap: ${SHELF_GAP_PX}px;
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

/* 5c. The container line (0.6.4): the thin color bar Firefox and TST
     paint on every rendered ROW of a container tab, adopted for shelf
     icons (a member has no row — its icon cell is the marker's site;
     the owner row paints its own native marker untouched).  The COLOR
     is TST's live palette, referenced never copied: the markup carries
     --shelf-marker: var(--contextual-identity-color-<id>, transparent)
     and TST's updateContextualIdentitiesStyle (sidebar/sidebar.js)
     declares that variable per container on the sidebar root, rebuilding
     it on every containers change — a recolor repaints the icons without
     any re-derivation.  The paint color below:
     background-color: var(--shelf-marker).
     GEOMETRY is TST's own row marker, bounded by the icon cell the way
     TST bounds it by the row.  Cross-section calc(var(--favicon-size) /
     8) is TST's very --contextual-identity-marker-size (base.css).  The
     block insets are TST's row formula --contextual-identity-marker-
     margin = min((current - favicon) / 2, current * 0.15) with the row's
     current size replaced by the cell's (--faviconized-tab-size): the
     line spans the favicon's height exactly the way the row's marker
     does on a faviconized (pinned) row — a favicon cell IS a faviconized
     geometry.  Nova replaces the bar with a horizontal accent (nova.css),
     keyed below on the sidebar root's data-style (sidebar.js); proton
     shifts the bar inward by --tab-highlighter-size (proton.css), under
     .regular/.inverted, the same sides TST uses.  Themes with no marker
     override of their own (photon, sidebar, highcontrast) fall through
     to the base bar, as they do on rows.  pointer-events: none: the
     icon cell keeps every behavior (click, drag, context menu). */
::part(%EXTRA_CONTENTS_PART% shelf-marker) {
  --shelf-marker-cross: calc(var(--favicon-size) / 8);
  position: absolute;
  inset-inline-end: 0;
  inset-block: min(calc((var(--faviconized-tab-size) - var(--favicon-size)) / 2), calc(var(--faviconized-tab-size) * 0.15));
  width: var(--shelf-marker-cross);
  height: auto;
  background-color: var(--shelf-marker);
  z-index: var(--tab-ui-z-index);
  pointer-events: none;
}
:root[data-style="proton"].regular ::part(%EXTRA_CONTENTS_PART% shelf-marker) {
  inset-inline-end: var(--tab-highlighter-size);
}
:root[data-style="proton"].inverted ::part(%EXTRA_CONTENTS_PART% shelf-marker) {
  inset-inline-start: var(--tab-highlighter-size);
}
:root[data-style="nova"] ::part(%EXTRA_CONTENTS_PART% shelf-marker) {
  inset-inline: calc(var(--toolbarbutton-border-radius, 4px) * 0.65 / 2);
  inset-block-start: calc((var(--faviconized-tab-size) - var(--favicon-size) - var(--shelf-marker-cross) * 2) / 4);
  inset-block-end: auto;
  height: var(--shelf-marker-cross);
  width: auto;
  border-radius: var(--border-radius-xsmall, 1px);
}

/* 6. The fold badge: shown whenever the shelved tab has descendants,
     whether the subtree is folded or unfolded (it carries the same
     descendant count TST writes on its own rows).  The markup emits it
     only when a count exists, so nothing to hide here. */
::part(%EXTRA_CONTENTS_PART% shelf-badge) {
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

/* 7. The audio indicator: the playing/muted glyph in the tab's own
     corner, exactly like Firefox marks media tabs.  Theme-colored
     without any network resource: the glyph is a mask-image data URL
     and the paint color is currentColor.  The muted glyph (speaker with
     a bar) replaces the playing one (speaker with arcs).  pointer-events
     is re-enabled: a primary click on the glyph mutes/unmutes the
     member (index.esm.js routes on the part). */
::part(%EXTRA_CONTENTS_PART% shelf-sound) {
  position: absolute;
  inset-inline-start: 1px;
  inset-block-end: 1px;
  width: 9px;
  height: 9px;
  pointer-events: auto;
  background-color: currentColor;
  mask: url("data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2016%2016%22%3E%3Cpath%20d%3D%22M1%206h3l4-3.5v11L4%2010H1zM10%205.5a3.5%203.5%200%200%201%200%205M12%203a6.5%206.5%200%200%201%200%2010%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%222%22%20stroke-linejoin%3D%22round%22%2F%3E%3C%2Fsvg%3E") no-repeat center / contain;
}
::part(%EXTRA_CONTENTS_PART% shelf-sound tst-shelf-sound-muted) {
  mask: url("data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2016%2016%22%3E%3Cpath%20d%3D%22M1%206h3l4-3.5v11L4%2010H1z%22%20fill%3D%22black%22%2F%3E%3Cpath%20d%3D%22M3%202l11%2012M14%202L3%2014%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%222%22%2F%3E%3C%2Fsvg%3E") no-repeat center / contain;
}

/* 8. The hint mode (tab-hints).  The code chips paint OUT OF FLOW —
     an in-flow label inside an extra-contents container would add
     exactly the height the uniform-row law forbids (an in-flow chip
     in a STRAP is the one exception: the strap is a bounded flex item
     inside the owner's one-line row, so an extra flex item just
     widens it).

     THREE chips, three homes.  "shelf-hint", the ICON chip, lives
     inside our own .shelf-icon cells.  "shelf-owner-hint", an OWNER
     row's chip (the user call: "on the same line the shelved
     children's chips are located, to the left from the leftmost one,
     at the same distance as the shelf's other chips are apart"), is a
     plain flex item at the START of its own strap (strapHtml
     prepends it from the same narrowed hints map the icon chips ride)
     — same line by the strap's align-items: center, one strap-gap
     (3px) left of the leftmost icon, and NEVER paintable-over by the
     strap because it IS strap content.  (History, measured: 0.6.2
     carried owner chips in the tab-above overlay at the row's
     inline-end corner — TST's tab-above/tab-below containers share
     --tab-extra-contents-beside-z-index 150 and the strap's content
     comes later in the row DOM, so the rightmost member's icon chip
     painted over the owner's chip on exactly the rows that have a
     shelf; an unreleased experiment moved owner chips to tab-front —
     the caption's label-area overlay, z 6000 — and they became visible
     but MISALIGNED: the front container's insets are the GLOBAL
     --tab-label-start/end-offsets computed from the DUMMY tab
     (size.js:177-178), which measured 33px off the row's end on a
     plain row — visually fine — but on a starved owner caption the
     chip's row-insetEnd measured 122px: "the hints are not aligned,
     visual mess".  0.6.3: owners ride the strap; plain rows return
     to the 0.6.2 corner.)  "shelf-rowhint", the ROW chip of rows
     WITHOUT a strap, stays in the tab-above overlay (8a) anchored at
     the row's inline-end top corner — the 0.6.2 geometry the user
     explicitly blessed ("for the shelfless tabs, their chips'
     locations were perfect, aligning vertically with the rightmost
     shelved tabs' chips"). */
::part(%EXTRA_CONTENTS_PART% shelf-hint) {
  position: absolute;
  inset-inline-start: 8px;
  inset-block-start: 0;
  z-index: var(--tab-extra-contents-beside-z-index, 1);
  font: message-box;
  font-size: ${fontPx}px;
  line-height: 1.25;
  font-weight: 600;
  padding: 0 3px;
  color: #0b2a30;
  background-color: #00c8d9;
  border-radius: 3px;
  box-shadow: 0 0 0 1px rgba(2, 42, 48, 0.55);
  pointer-events: none;
}
::part(%EXTRA_CONTENTS_PART% shelf-rowhint) {
  position: absolute;
  inset-inline-end: 2px;
  inset-block-start: 0;
  font: message-box;
  font-size: ${fontPx}px;
  line-height: 1.25;
  font-weight: 600;
  padding: 0 3px;
  color: #0b2a30;
  background-color: #00c8d9;
  border-radius: 3px;
  box-shadow: 0 0 0 1px rgba(2, 42, 48, 0.55);
  pointer-events: none;
}
::part(%EXTRA_CONTENTS_PART% shelf-owner-hint) {
  flex: 0 0 auto;
  font: message-box;
  font-size: ${fontPx}px;
  line-height: 1.25;
  font-weight: 600;
  padding: 0 3px;
  color: #0b2a30;
  background-color: #00c8d9;
  border-radius: 3px;
  box-shadow: 0 0 0 1px rgba(2, 42, 48, 0.55);
  pointer-events: none;
}
@media (prefers-color-scheme: dark) {
  ::part(%EXTRA_CONTENTS_PART% shelf-hint),
  ::part(%EXTRA_CONTENTS_PART% shelf-rowhint),
  ::part(%EXTRA_CONTENTS_PART% shelf-owner-hint) {
    color: #ffffff;
    background-color: #005f6e;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.35);
  }
}

/* 8b. The twin of the load-bearing rule 1: the dummy tab mirrors the
     latest tab-above extra contents, and its (hidden, but
     layout-visible) mirror must not inflate every row either. */
#dummy-tab .extra-items-container.above {
  display: none !important;
}

/* 8a. The ROW chip's ANCHOR: the row chip hosts in TST's \`.above\`
     container, whose own box varies by row kind — on the OWNER row
     (whose .below carries the strap) the measured container lands
     ~20px below the row's top and falls short of the row's inline-end
     edge (the E2E caught the owner's chip misplaced by 156px).  The
     container is therefore overlaid on the whole row: the chip's
     corner coordinates become the ROW's, for every row kind alike.
     Owner rows carry NO row chip anymore (their codes ride the strap,
     rule 8), so the 0.6.2 collision the overlay enabled (equal z with
     the strap) is gone; the overlay keeps TST's z-index 150 and its
     pointer-events: none, and leaves the flow untouched (it was
     zero-height): the uniform-row law holds.  No other addon in this
     setup writes tab-above contents (checked: tst-workspace has
     none). */
tab-item .extra-items-container.above {
  position: absolute;
  inset: 0;
}

/* 8c. The key catcher: zero-size, invisible, still focusable —
     display: none would make node.focus() a no-op, which is why
     visibility is hidden instead of the node being removed.  #tabbar-top
     itself is an absolute, height-0 overlay (base.css), so the catcher
     reserves no space anywhere while the mode is off. */
::part(%EXTRA_CONTENTS_PART% shelf-keycatcher) {
  position: absolute;
  width: 0;
  height: 0;
  opacity: 0;
  padding: 0;
  border: none;
  pointer-events: none;
}

/* 8d. A member-less root strap is the part-less idle wrapper: give it
     no size, so an empty root shelf still reserves no space while the
     catcher waits inside it. */
#tabbar-top .extra-items-container .shelf-strap-idle {
  display: block;
  width: 0;
  height: 0;
  overflow: visible;
}
`;
}
