/**
 * Spec-derived unit tests for src/background/render.esm.js (node --test).
 *
 * The renderer is the addon's only writer of TST state, so its ledger has
 * to mean "what TST acknowledged", not "what we wanted": a failed write
 * that is recorded as applied is never retried (the sidebar then shows
 * nothing until some unrelated event changes the markup).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createRenderer, strapHtml, iconHtml, escapeHtml } from "../src/background/render.esm.js";

/** A derivation with one shelf owned by tab 1 holding tabs 2 and 3. */
function derivationOf ({ owner = 1, members = [2, 3], badgeCounts = new Map, } = {}) {
	return {
		shelves: new Map([[owner, members]]),
		ownerIds: new Set(members.length ? [owner] : []),
		highlightIds: new Set,
		badgeIds: new Set(badgeCounts.keys()),
		badgeCounts,
	};
}

const tabsById = new Map([
	[1, { id: 1, title: "owner", url: "https://example.com/owner", },],
	[2, { id: 2, title: "a", url: "https://a.example", },],
	[3, { id: 3, title: "b", url: "https://b.example", },],
]);

/** Injected `send` that records every request and can be told to reject a
 *  given index (0-based, in call order). */
function recorder ({ failAt = [], } = {}) {
	const calls = [];
	const send = async (type, params) => {
		const index = calls.length;
		calls.push({ type, params, });
		if (failAt.includes(index)) { throw new Error(`injected failure ${index}`); }
		return true;
	};
	return { calls, send, };
}

const strapCalls = calls => calls.filter(call => call.type === "set-extra-contents");
const stateCalls = calls => calls.filter(call => call.type != "set-extra-contents");
const logs = [];

test("an unchanged markup is not sent again", async () => {
	const { calls, send, } = recorder();
	const renderer = createRenderer({ send, log: (kind, detail) => logs.push(`${kind} ${detail}`), });

	await renderer.applyDerivation({ windowId: 7, derivation: derivationOf(), tabsById, });
	const first = strapCalls(calls).length;
	await renderer.applyDerivation({ windowId: 7, derivation: derivationOf(), tabsById, });

	assert.equal(strapCalls(calls).length, first,
		"the second pass had nothing new to say, so it sent no strap at all");
	// the owner shelf's strap + the ALWAYS-present root strap (the key
	// catcher rides it: tab-hints)
	assert.equal(first, 2, "the first pass sent the owner strap and the catcher");
});

test("a rejected strap write is retried by the next derivation", async () => {
	// call 0: the owner strap (rejects), call 1: the root catcher strap
	const { calls, send, } = recorder({ failAt: [0], });
	const renderer = createRenderer({ send, log: (kind, detail) => logs.push(`${kind} ${detail}`), });

	await renderer.applyDerivation({ windowId: 7, derivation: derivationOf(), tabsById, });
	await renderer.applyDerivation({ windowId: 7, derivation: derivationOf(), tabsById, });

	// owner (failed, retried) + catcher (always acknowledged) = 3 sends
	assert.equal(strapCalls(calls).length, 3, "the failed write did not enter the ledger");
	assert.ok(logs.some(entry => entry.startsWith("strap-send-fail")), "the failure is logged");
});

test("a rejected state add is retried and never recorded as applied", async () => {
	// calls: 0 the owner strap, 1 the root catcher, 2 the owner state —
	// reject that one.
	const { calls, send, } = recorder({ failAt: [2], });
	const renderer = createRenderer({ send, log: (kind, detail) => logs.push(`${kind} ${detail}`), });

	await renderer.applyDerivation({ windowId: 7, derivation: derivationOf(), tabsById, });
	await renderer.applyDerivation({ windowId: 7, derivation: derivationOf(), tabsById, });

	const adds = stateCalls(calls).filter(call => call.type === "add-tab-state");
	assert.equal(adds.length, 2, "the rejected add was sent again");
	assert.ok(logs.some(entry => entry.startsWith("add-state-fail")));
});

test("a state remove that fails stays in the ledger", async () => {
	// calls: 0 owner strap, 1 catcher, 2 owner state add, 3 the shelf's
	// clear, 4 the state removal — reject that one.
	const derivation = derivationOf();
	const { calls, send, } = recorder({ failAt: [4], });
	const renderer = createRenderer({ send, log: (kind, detail) => logs.push(`${kind} ${detail}`), });

	await renderer.applyDerivation({ windowId: 7, derivation, tabsById, });
	await renderer.applyDerivation({ windowId: 7, derivation: derivationOf({ members: [], }), tabsById, });
	await renderer.applyDerivation({ windowId: 7, derivation: derivationOf({ members: [], }), tabsById, });

	const removals = stateCalls(calls).filter(call => call.type === "remove-tab-state");
	assert.equal(removals.length, 2, "the failed removal was retried instead of being forgotten");
	assert.ok(logs.some(entry => entry.startsWith("remove-state-fail")));
});

test("a vanished shelf is cleared once and then left alone", async () => {
	const { calls, send, } = recorder();
	const renderer = createRenderer({ send, log: () => {}, });

	await renderer.applyDerivation({ windowId: 7, derivation: derivationOf(), tabsById, });
	await renderer.applyDerivation({ windowId: 7, derivation: derivationOf({ members: [], }), tabsById, });
	await renderer.applyDerivation({ windowId: 7, derivation: derivationOf({ members: [], }), tabsById, });

	const clears = strapCalls(calls).filter(call => call.params.contents == null);
	assert.equal(clears.length, 1, "one clear, not one per derivation");
	assert.equal(clears[0].params.tab, 1);
});

test("a failed clear is retried", async () => {
	// calls: 0 owner strap, 1 catcher, 2 state add, 3 the clear (rejects)
	const { calls, send, } = recorder({ failAt: [3], });
	const renderer = createRenderer({ send, log: () => {}, });

	await renderer.applyDerivation({ windowId: 7, derivation: derivationOf(), tabsById, });
	await renderer.applyDerivation({ windowId: 7, derivation: derivationOf({ members: [], }), tabsById, });
	await renderer.applyDerivation({ windowId: 7, derivation: derivationOf({ members: [], }), tabsById, });

	assert.equal(strapCalls(calls).filter(call => call.params.contents == null).length, 2);
});

test("restoreStraps re-sends and re-acknowledges the straps", async () => {
	const { calls, send, } = recorder();
	const renderer = createRenderer({ send, log: () => {}, });
	const derivation = derivationOf();

	await renderer.applyDerivation({ windowId: 7, derivation, tabsById, });
	const before = strapCalls(calls).length;
	await renderer.restoreStraps({ windowId: 7, derivation, tabsById, });
	// a virtual-scroll restore is unconditional: the owner strap + the catcher
	assert.equal(strapCalls(calls).length, before + 2, "a virtual-scroll restore is unconditional");
	await renderer.applyDerivation({ windowId: 7, derivation, tabsById, });
	assert.equal(strapCalls(calls).length, before + 2, "the restore updated the ledger, so no redundant send");
});

test("windowId and the root shelf are routed to the right target", async () => {
	const { calls, send, } = recorder();
	const renderer = createRenderer({ send, log: () => {}, });
	const derivation = {
		shelves: new Map([[null, [2]],]),
		ownerIds: new Set([null]),
		highlightIds: new Set,
		badgeIds: new Set,
	};
	await renderer.applyDerivation({ windowId: 9, derivation, tabsById, });
	assert.deepEqual(strapCalls(calls)[0].params.place, "tabbar-top");
	assert.equal(strapCalls(calls)[0].params.windowId, 9);
	assert.equal(stateCalls(calls).length, 0, "the root shelf hosts no owner row");
});

// ---------------------------------------------------------------------------
// the key catcher (tab-hints)

test("the root strap carries the key catcher; other straps do not", () => {
	const root = strapHtml({ members: [2], tabsById, highlightIds: new Set, keyCatcher: true, });
	assert.ok(root.includes('part="shelf-keycatcher" tabindex="0"'), () => root);
	const owner = strapHtml({ members: [2], tabsById, highlightIds: new Set, });
	assert.equal(owner.includes("shelf-keycatcher"), false, "a shelf's strap has no catcher");
});

test("a member-less root strap renders the part-less idle wrapper with the catcher", () => {
	const idle = strapHtml({ members: [], tabsById, highlightIds: new Set, keyCatcher: true, });
	assert.equal(idle, `<div class="shelf-strap-idle"><span part="shelf-keycatcher" tabindex="0"></span></div>`);
	const plain = strapHtml({ members: [], tabsById, highlightIds: new Set, });
	assert.equal(plain, `<div part="shelf-strap"></div>`);
});

test("the catcher strap is written even when the derivation has no root shelf, and only once", async () => {
	const { calls, send, } = recorder();
	const renderer = createRenderer({ send, log: () => {}, });

	await renderer.applyDerivation({ windowId: 7, derivation: derivationOf(), tabsById, });
	await renderer.applyDerivation({ windowId: 7, derivation: derivationOf(), tabsById, });

	const top = strapCalls(calls).filter(call => call.params.place === "tabbar-top");
	assert.equal(top.length, 1, "the catcher strap is sent once and kept");
	assert.ok(top[0].params.contents.includes("shelf-keycatcher"), "the catcher rides it");
	assert.ok(top[0].params.contents.includes("shelf-strap-idle"), "a member-less root strap is the idle wrapper");
});

// ---------------------------------------------------------------------------
// markup builders (escaping is the security-relevant part)

test("titles and attribute values are escaped", () => {
	assert.equal(escapeHtml(`<b>"x"&'y'</b>`), "&lt;b&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/b&gt;");
	const html = iconHtml({ tab: { id: 4, title: `<script>`, url: `https://e/?a="b"`, }, active: false, badgeCount: 0, });
	assert.equal(html.includes("<script>"), false);
	assert.equal(html.includes("&lt;script&gt;"), true);
});

test("a strap with no resolvable members is empty markup", () => {
	assert.equal(strapHtml({ members: [99], tabsById, highlightIds: new Set, }),
		`<div part="shelf-strap"></div>`);
});

// ---------------------------------------------------------------------------
// fold badge (plus or the TST-side descendant count)

test("a member with descendants shows a plus badge in plus mode", () => {
	const html = strapHtml({
		members: [2], tabsById, highlightIds: new Set,
		badgeCounts: new Map([[2, 3]]), badgeMode: "plus",
	});
	assert.ok(html.includes(`part="shelf-badge"`), "the badge is present");
	assert.match(html, /<span part="shelf-badge">\+<\/span>/);
});

test("count mode shows the descendant number instead of the plus", () => {
	const html = strapHtml({
		members: [2], tabsById, highlightIds: new Set,
		badgeCounts: new Map([[2, 12]]), badgeMode: "count",
	});
	assert.match(html, /<span part="shelf-badge">12<\/span>/);
});

test("a childless member shows no badge at all", () => {
	const html = strapHtml({
		members: [2], tabsById, highlightIds: new Set,
		badgeCounts: new Map, badgeMode: "plus",
	});
	assert.ok(!html.includes("shelf-badge"), "no badge markup for a count of 0");
});

// ---------------------------------------------------------------------------
// audio indicator

test("a playing tab's icon carries the sound glyph, the favicon stays", () => {
	const html = iconHtml({
		tab: { id: 2, audible: true, mutedInfo: { muted: false, }, favIconUrl: "https://a/i.png", },
		active: false, badgeCount: 0,
	});
	assert.match(html, /<span part="shelf-sound" data-tab-id="2"><\/span>/,
		"the glyph carries the tab id for the mute click");
	assert.match(html, /background-image: url/, "the favicon background is untouched");
	assert.ok(!html.includes("tst-shelf-sound-muted"), "no muted variant while playing");
});

test("a muted tab's icon carries the muted glyph", () => {
	const html = iconHtml({
		tab: { id: 2, audible: false, mutedInfo: { muted: true, }, },
		active: false, badgeCount: 0,
	});
	assert.match(html, /part="shelf-sound tst-shelf-sound-muted"/);
});

test("a silent unmuted tab shows no audio glyph", () => {
	const html = iconHtml({
		tab: { id: 2, audible: false, mutedInfo: { muted: false, }, },
		active: false, badgeCount: 0,
	});
	assert.ok(!html.includes("shelf-sound"));
});

// ---------------------------------------------------------------------------
// container line (0.6.4): the row marker adopted on shelf icons

test("a container member's icon carries the marker span with its own palette var", () => {
	const html = iconHtml({
		tab: { id: 2, title: "a", url: "https://a.example", cookieStoreId: "container-42", },
		active: false, badgeCount: 0,
	});
	assert.match(html,
		/<span part="shelf-marker" style="--shelf-marker: var\(--contextual-identity-color-container-42, transparent\)"><\/span>/,
		() => html);
	// the marker is the FIRST child of the cell: the badge and the audio
	// indicator paint over it where they overlap
	const markerAt = html.indexOf('part="shelf-marker"');
	const soundAt = html.indexOf("shelf-sound");
	const badgeAt = html.indexOf("shelf-badge");
	assert.ok(markerAt > -1, () => html);
	assert.ok(badgeAt == -1 && soundAt == -1 || markerAt < badgeAt && markerAt < soundAt, () => html);
});

test("a default-container or private member's icon carries no marker span", () => {
	const plain = iconHtml({ tab: { id: 2, title: "a", cookieStoreId: "firefox-default", }, active: false, badgeCount: 0, });
	assert.ok(!plain.includes("shelf-marker"), () => plain);
	const priv = iconHtml({ tab: { id: 2, title: "a", cookieStoreId: "firefox-private", }, active: false, badgeCount: 0, });
	assert.ok(!priv.includes("shelf-marker"), () => priv);
	const legacy = iconHtml({ tab: { id: 2, title: "a", }, active: false, badgeCount: 0, });
	assert.ok(!legacy.includes("shelf-marker"), "a snapshot without cookieStoreId carries no marker either");
});

test("a mixed shelf colors each icon's line from its own container, not the owner's", () => {
	const mixedTabsById = new Map([
		[1, { id: 1, title: "owner", url: "https://e", cookieStoreId: "owner-container", },],
		[2, { id: 2, title: "a", url: "https://a.example", cookieStoreId: "alpha-container", },],
		[3, { id: 3, title: "b", url: "https://b.example", cookieStoreId: "beta-container", },],
	]);
	const html = strapHtml({ members: [2, 3], tabsById: mixedTabsById, highlightIds: new Set, });
	assert.match(html, /--shelf-marker: var\(--contextual-identity-color-alpha-container, transparent\)/);
	assert.match(html, /--shelf-marker: var\(--contextual-identity-color-beta-container, transparent\)/);
	assert.ok(!html.includes("owner-container"), "the owner's cookieStoreId never leaks into a member icon", );
});

test("the icon's behavior attributes are untouched by the marker span", () => {
	const tab = { id: 2, title: "a", url: "https://a.example", cookieStoreId: "container-42", };
	const html = iconHtml({ tab, active: false, badgeCount: 0, });
	assert.match(html, /<div part="shelf-icon" data-tab-id="2" draggable="true" data-drag-data='{"type":"tab","data":{"id":2,"asTree":true}}' title="a\nhttps:\/\/a\.example">/, () => html);
});

test("a marker span's cookieStoreId is escaped like any attribute", () => {
	const html = iconHtml({
		tab: { id: 2, title: "x", cookieStoreId: `"><b>x</b>`, },
		active: false, badgeCount: 0,
	});
	assert.equal(html.includes('"><b>x</b>'), false);
	assert.ok(html.includes("&quot;"), () => html);
});

// ---------------------------------------------------------------------------
// hint chips (tab-hints)

test("a hinted icon carries the code chip; an unhinted one does not", () => {
	const tab = { id: 2, title: "a", url: "https://a.example", };
	const html = strapHtml({
		members: [2], tabsById, highlightIds: new Set, hints: new Map([[2, "ab"]]),
	});
	assert.match(html, /data-hint="ab">ab<\/span>/, () => html);
	const plain = strapHtml({ members: [2], tabsById, highlightIds: new Set, });
	assert.equal(plain.includes("shelf-hint"), false, "no hint chip outside the mode");
	const narrowed = strapHtml({
		members: [2], tabsById, highlightIds: new Set, hints: new Map,
	});
	assert.equal(narrowed.includes("shelf-hint"), false, "a narrowed-out code renders nothing");
});

test("hint codes are escaped like any other markup", () => {
	// a hostile code can only come from a bug; the escape must hold anyway
	const html = iconHtml({
		tab: { id: 2, title: "x", url: "https://x.example", },
		active: false, badgeCount: 0, hint: `<b>"ab"</b>`,
	});
	assert.equal(html.includes('<b>"ab"</b>'), false);
	assert.ok(html.includes("&lt;b&gt;&quot;ab&quot;&lt;/b&gt;"), () => html);
});

// ---------------------------------------------------------------------------
// row hints (tab-above label ledger)

test("row hints are written once, updated on change and blanked on exit", async () => {
	const { calls, send, } = recorder();
	const renderer = createRenderer({ send, log: () => {}, });

	await renderer.setRowHints({ windowId: 7, labels: new Map([[11, "ab"], [12, "cd"],]), });
	await renderer.setRowHints({ windowId: 7, labels: new Map([[11, "ab"], [12, "cd"],]), });
	assert.equal(strapCalls(calls).length, 2, "unchanged labels are not re-sent");
	// the ROW chip's own part (NOT the icon chip's "shelf-hint"): the two
	// anchor to different containers and carry different geometry rules
	assert.ok(strapCalls(calls)[0].params.contents.includes('part="shelf-rowhint"'),
		() => strapCalls(calls)[0].params.contents);

	await renderer.setRowHints({ windowId: 7, labels: new Map([[11, "ab"], [12, ""],]), });
	assert.equal(strapCalls(calls).length, 3, "only the narrowed-out label is blanked");
	const blank = strapCalls(calls).at(-1);
	assert.equal(blank.params.place, "tab-above");
	assert.equal(blank.params.tab, 12);
	assert.equal(blank.params.contents, "");

	await renderer.clearRowHints({ windowId: 7, });
	const blanks = strapCalls(calls).filter(call => call.params.contents === "");
	assert.equal(blanks.length, 2, "exit blanks every acknowledged label once");
	await renderer.clearRowHints({ windowId: 7, });
	assert.equal(strapCalls(calls).length, 4, "a second clear is a no-op");

	// a rejected write is retried, never recorded as applied
	const failing = recorder({ failAt: [0], });
	const renderer2 = createRenderer({ send: failing.send, log: () => {}, });
	await renderer2.setRowHints({ windowId: 8, labels: new Map([[21, "xy"],]), });
	assert.equal(strapCalls(failing.calls).length, 1);
	await renderer2.setRowHints({ windowId: 8, labels: new Map([[21, "xy"],]), });
	assert.equal(strapCalls(failing.calls).length, 2, "the failed label write is retried");
});

test("hint chips ride restoreStraps while the mode is on, and vanish after setHints(null)", async () => {
	const { calls, send, } = recorder();
	const renderer = createRenderer({ send, log: () => {}, });
	const derivation = derivationOf();

	renderer.setHints(new Map([[2, "ab"], [3, "cd"],]));
	await renderer.applyDerivation({ windowId: 7, derivation: derivationOf(), tabsById, });
	let ownerStrap = strapCalls(calls).filter(call => call.params.place === "tab-below").at(-1);
	assert.ok(ownerStrap.params.contents.includes('data-hint="ab"'), () => ownerStrap.params.contents);

	// a virtual-scroll restore keeps the chips while the mode is on
	await renderer.restoreStraps({ windowId: 7, derivation, tabsById, });
	ownerStrap = strapCalls(calls).filter(call => call.params.place === "tab-below").at(-1);
	assert.ok(ownerStrap.params.contents.includes('data-hint="cd"'), () => ownerStrap.params.contents);

	renderer.setHints(null);
	await renderer.applyDerivation({ windowId: 7, derivation, tabsById, });
	ownerStrap = strapCalls(calls).filter(call => call.params.place === "tab-below").at(-1);
	assert.equal(ownerStrap.params.contents.includes("shelf-hint"), false, "exit removes every chip");
});

test("an owner's code chip rides its own strap as the leading item, narrowing and exiting with the mode", async () => {
	const { calls, send, } = recorder();
	const renderer = createRenderer({ send, log: () => {}, });
	const derivation = derivationOf({ owner: 1, members: [2, 3], });

	// entry: the full code map (the owner's own code included) — the
	// owner chip leads the strap, the ROOT strap (tabbar-top) carries none
	renderer.setHints(new Map([[1, "aq"], [2, "aa"], [3, "ac"],]));
	await renderer.applyDerivation({ windowId: 7, derivation, tabsById, });
	const ownerStrap = strapCalls(calls).find(call => call.params.place === "tab-below");
	const contents = ownerStrap.params.contents;
	// the chip is IN the strap markup, before the first icon
	const ownerChipAt = contents.indexOf('part="shelf-owner-hint"');
	const firstIconAt = contents.indexOf('part="shelf-icon"');
	assert.ok(ownerChipAt > -1 && firstIconAt > ownerChipAt, () => contents);
	assert.ok(contents.includes('data-hint="aq"'), () => contents);
	const rootStrap = strapCalls(calls).find(call => call.params.place === "tabbar-top");
	assert.equal(rootStrap.params.contents.includes("shelf-owner-hint"), false,
		"the root shelf has no owner tab, so no owner chip");

	// narrowing: the owner's code filtered out drops the chip through the
	// normal strap diff
	renderer.setHints(new Map([[2, "aa"],]));
	await renderer.applyDerivation({ windowId: 7, derivation, tabsById, });
	const narrowedOwner = strapCalls(calls).filter(call => call.params.place === "tab-below").at(-1);
	assert.equal(narrowedOwner.params.contents.includes("shelf-owner-hint"), false, () => narrowedOwner.params.contents);
	assert.ok(narrowedOwner.params.contents.includes('part="shelf-icon"'), "the icons stay");

	// outside the mode an owner strap carries no chip at all
	const callsBefore = strapCalls(calls).length;
	assert.ok(callsBefore > 0);
	renderer.setHints(null);
	await renderer.applyDerivation({ windowId: 7, derivation, tabsById, });
	const plainOwner = strapCalls(calls).filter(call => call.params.place === "tab-below").at(-1);
	assert.equal(plainOwner.params.contents.includes("shelf-owner-hint"), false, () => plainOwner.params.contents);
});
