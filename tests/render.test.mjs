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
	assert.equal(first, 1, "the first pass sent exactly one strap for the one shelf");
});

test("a rejected strap write is retried by the next derivation", async () => {
	const { calls, send, } = recorder({ failAt: [0], });
	const renderer = createRenderer({ send, log: (kind, detail) => logs.push(`${kind} ${detail}`), });

	await renderer.applyDerivation({ windowId: 7, derivation: derivationOf(), tabsById, });
	await renderer.applyDerivation({ windowId: 7, derivation: derivationOf(), tabsById, });

	assert.equal(strapCalls(calls).length, 2, "the failed write did not enter the ledger");
	assert.ok(logs.some(entry => entry.startsWith("strap-send-fail")), "the failure is logged");
});

test("a rejected state add is retried and never recorded as applied", async () => {
	// call 0: the strap, call 1: the owner state — reject the state.
	const { calls, send, } = recorder({ failAt: [1], });
	const renderer = createRenderer({ send, log: (kind, detail) => logs.push(`${kind} ${detail}`), });

	await renderer.applyDerivation({ windowId: 7, derivation: derivationOf(), tabsById, });
	await renderer.applyDerivation({ windowId: 7, derivation: derivationOf(), tabsById, });

	const adds = stateCalls(calls).filter(call => call.type === "add-tab-state");
	assert.equal(adds.length, 2, "the rejected add was sent again");
	assert.ok(logs.some(entry => entry.startsWith("add-state-fail")));
});

test("a state remove that fails stays in the ledger", async () => {
	// calls: 0 strap, 1 owner state, 2 clear (the shelf is gone), 3 the
	// state removal — reject that one.
	const derivation = derivationOf();
	const { calls, send, } = recorder({ failAt: [3], });
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
	// calls: 0 strap, 1 owner state, 2 clear (rejects)
	const { calls, send, } = recorder({ failAt: [2], });
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
	assert.equal(strapCalls(calls).length, before + 1, "a virtual-scroll restore is unconditional");
	await renderer.applyDerivation({ windowId: 7, derivation, tabsById, });
	assert.equal(strapCalls(calls).length, before + 1, "the restore updated the ledger, so no redundant send");
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
