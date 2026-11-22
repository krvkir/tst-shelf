/**
 * Unit tests for src/background/style.esm.js (node --test).
 *
 * The stylesheet is one big template literal, so the only honest check is
 * to CALL the builder: 0.6.3 shipped a raw backtick inside a CSS comment
 * (the \`.above\` mention in rule 8a) that esbuild accepted without a
 * peep — the template ended early and the rest parsed as a tagged-
 * template call on the string's (missing) `.above` property, throwing at
 * every boot and killing register-self; nothing imported
 * buildShelfStyle here, so no test noticed.  These tests import it.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildShelfStyle, DEFAULT_HINT_FONT_SIZE_PX, } from "../src/background/style.esm.js";

test("buildShelfStyle returns the whole stylesheet as one string", () => {
	const style = buildShelfStyle();
	assert.equal(typeof style, "string");
	for (const probe of [
		"#dummy-tab .extra-items-container.below",
		"tab-item.tst-shelf-owner .ui",
		"::part(%EXTRA_CONTENTS_PART% shelf-strap)",
		"::part(%EXTRA_CONTENTS_PART% shelf-icon)",
		"::part(%EXTRA_CONTENTS_PART% shelf-hint)",
		"::part(%EXTRA_CONTENTS_PART% shelf-rowhint)",
		"::part(%EXTRA_CONTENTS_PART% shelf-owner-hint)",
		".extra-items-container.above",
		"#tabbar-top .extra-items-container",
		"::part(%EXTRA_CONTENTS_PART% shelf-keycatcher)",
	]) {
		assert.ok(style.includes(probe), `the style is missing the rule ${probe}`);
	}
});

test("the container-line rules ship: the base bar and both theme branches (0.6.4)", () => {
	const style = buildShelfStyle();
	// the base bar: geometry from TST's own row marker
	assert.ok(style.includes("::part(%EXTRA_CONTENTS_PART% shelf-marker)"),
		"the base ::part(shelf-marker) rule is missing");
	assert.ok(style.includes("--shelf-marker-cross: calc(var(--favicon-size) / 8);"),
		"the cross-section is not TST's --contextual-identity-marker-size formula");
	assert.ok(style.includes("background-color: var(--shelf-marker);"),
		"the paint color does not ride the markup's --shelf-marker var");
	assert.ok(style.includes("inset-block: min(calc((var(--faviconized-tab-size) - var(--favicon-size)) / 2), calc(var(--faviconized-tab-size) * 0.15));"),
		"the block insets are not the row-marker margin formula bounded by the cell");
	// the theme branches, keyed on TST's sidebar-root dataset (sidebar.js:380)
	assert.ok(style.includes(':root[data-style="proton"].regular ::part(%EXTRA_CONTENTS_PART% shelf-marker)'),
		"the proton regular branch (marker shifted inward) is missing");
	assert.ok(style.includes(':root[data-style="proton"].inverted ::part(%EXTRA_CONTENTS_PART% shelf-marker)'),
		"the proton inverted branch is missing");
	assert.ok(style.includes('--tab-highlighter-size'),
		"the proton branch does not shift by --tab-highlighter-size");
	assert.ok(style.includes(':root[data-style="nova"] ::part(%EXTRA_CONTENTS_PART% shelf-marker)'),
		"the nova branch (horizontal accent) is missing");
	assert.ok(style.includes("height: var(--shelf-marker-cross);"),
		"the nova branch does not flip the bar to a horizontal accent");
	// the marker is passive: no pointer-events of its own
	const baseAt = style.indexOf("::part(%EXTRA_CONTENTS_PART% shelf-marker) {");
	const baseBlock = style.slice(baseAt, style.indexOf("}", baseAt));
	assert.ok(baseBlock.includes("pointer-events: none"), () => baseBlock);
});

test("the builder throws nothing and the stylesheet keeps its tail", () => {
	assert.doesNotThrow(() => buildShelfStyle(10));
	assert.doesNotThrow(() => buildShelfStyle(18));
	assert.doesNotThrow(() => buildShelfStyle(Number.NaN));
	const style = buildShelfStyle();
	// the last rule of the template: when a backtick ends the template
	// early (the 0.6.3 accident) everything after it stops being string
	// content, and the tail is the first thing to go missing
	assert.ok(style.includes(".shelf-strap-idle"), "the style lost its tail");
	const opens = (style.match(/\{/g) || []).length;
	const closes = (style.match(/\}/g) || []).length;
	assert.equal(opens, closes, `unbalanced braces: ${opens} { vs ${closes} }`);
});

test("the %EXTRA_CONTENTS_PART% placeholders survive for TST to expand", () => {
	const style = buildShelfStyle();
	const count = (style.match(/%EXTRA_CONTENTS_PART%/g) || []).length;
	assert.ok(count >= 10, `only ${count} placeholders left in the style`);
});

test("the chip font size is baked in and out-of-band values fall back", () => {
	assert.ok(buildShelfStyle(16).includes("font-size: 16px;"));
	assert.ok(buildShelfStyle(9).includes(`font-size: ${DEFAULT_HINT_FONT_SIZE_PX}px;`),
		"a 9px request fell back to the default");
	assert.ok(buildShelfStyle(600).includes(`font-size: ${DEFAULT_HINT_FONT_SIZE_PX}px;`),
		"a 600px request fell back to the default");
	assert.ok(buildShelfStyle("nonsense").includes(`font-size: ${DEFAULT_HINT_FONT_SIZE_PX}px;`),
		"junk fell back to the default");
	assert.equal(DEFAULT_HINT_FONT_SIZE_PX, 12);
});
