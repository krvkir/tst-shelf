/**
 * Spec-derived unit tests for src/background/logic.esm.js (node --test).
 * Run: make test
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	derive, indexTree, isFolded, straysToCollapse, ownersAffectedByActivation,
	subtreeSizes, treePositions, nextPlacementMove, resolveFavicons,
	mustShowTabs, danglingMembers, ROOT_SHELF,
} from "../src/background/logic.esm.js";

/** Light-tree node helper. */
const node = (id, states = [], children = []) => ({ id, states, children });

/** tabs.Tab stand-ins keyed by id. */
const tabsById = (tabs) => new Map(tabs.map(tab => [tab.id, {
	pos: 0, hidden: false, active: false, pinned: false, ...tab,
}]));

test("shelved children are assigned to their parent's shelf", () => {
	const tree = [node(1, [], [node(2), node(3), node(4)])];
	const shelved = new Set([2, 3]);
	const { shelves, shelfOf } = derive({ tree, shelved, tabsById: tabsById([
		{ id: 1, index: 0 }, { id: 2, index: 1 }, { id: 3, index: 2 }, { id: 4, index: 3 },
	]) });
	assert.deepEqual(shelves.get(1), [2, 3]);
	assert.equal(shelfOf.get(2), 1);
	assert.equal(shelves.get(ROOT_SHELF), undefined, "no root members");
});

test("shelved root tabs land on the root shelf", () => {
	const tree = [node(1), node(2, [], [node(3)])];
	const shelved = new Set([1, 2]);
	const { shelves, shelfOf } = derive({ tree, shelved, tabsById: tabsById([
		{ id: 1, index: 0 }, { id: 2, index: 1 }, { id: 3, index: 2 },
	]) });
	assert.deepEqual(shelves.get(ROOT_SHELF), [1, 2]);
	assert.equal(shelfOf.get(1), ROOT_SHELF);
});

test("members are listed in native tab order", () => {
	const tree = [node(1, [], [node(2), node(3), node(4)])];
	const shelved = new Set([4, 2]);
	const { shelves } = derive({ tree, shelved, tabsById: tabsById([
		{ id: 1, index: 0 }, { id: 4, index: 3 }, { id: 2, index: 1 }, { id: 3, index: 2 },
	]) });
	assert.deepEqual(shelves.get(1), [2, 4], "order follows tab index, not shelving order");
});

test("hidden members (workspace filtering) are not rendered on the shelf", () => {
	const tree = [node(1, [], [node(2), node(3), node(4)])];
	const shelved = new Set([2, 3]);
	const { shelves, shelvedVisible } = derive({ tree, shelved, tabsById: tabsById([
		{ id: 1, index: 0 }, { id: 2, index: 1 }, { id: 3, index: 2, hidden: true }, { id: 4, index: 3 },
	]) });
	assert.deepEqual(shelves.get(1), [2], "hidden member dropped from the strap");
	assert.deepEqual(shelvedVisible, [2]);
	assert.equal(shelves.has(3), false);
});

test("members hidden BY US keep their icons (their rows are gone on purpose)", () => {
	const tree = [node(1, [], [node(2), node(3), node(4)])];
	const shelved = new Set([2, 3]);
	const { shelves } = derive({
		tree, shelved,
		tabsById: tabsById([
			{ id: 1, index: 0 }, { id: 2, index: 1, hidden: true }, { id: 3, index: 2, hidden: true }, { id: 4, index: 3 },
		]),
		hiddenByUs: new Set([2, 3]),
	});
	assert.deepEqual(shelves.get(1), [2, 3], "0.1.4: members have no rows, so they are hidden — the icon is their whole presentation");
});

test("an empty shelf (all members hidden by someone else) reserves no owner", () => {
	const tree = [node(1, [], [node(2)])];
	const shelved = new Set([2]);
	const { shelves, ownerIds } = derive({ tree, shelved, tabsById: tabsById([
		{ id: 1, index: 0 }, { id: 2, index: 1, hidden: true },
	]) });
	assert.equal(shelves.get(1), undefined);
	assert.equal(ownerIds.has(1), false);
});

test("selection is the member with an unfolded subtree", () => {
	const tree = [node(1, [], [node(2, ["subtree-collapsed"], [node(5)]), node(4, [], [node(6)])])];
	const shelved = new Set([2, 4]);
	const { selectedOfShelf, badgeIds } = derive({ tree, shelved, tabsById: tabsById([
		{ id: 1, index: 0 }, { id: 2, index: 1 }, { id: 4, index: 2 }, { id: 5, index: 3 }, { id: 6, index: 4 },
	]) });
	assert.equal(selectedOfShelf.get(1), 4, "the unfolded member is selected");
	assert.equal(badgeIds.has(2), true, "folded member carries the plus badge");
	assert.equal(badgeIds.has(4), false, "unfolded member carries none");
});

test("the active member wins a selection tie", () => {
	const tree = [node(1, [], [node(2, [], [node(5)]), node(3, [], [node(6)])])];
	const shelved = new Set([2, 3]);
	const { selectedOfShelf } = derive({ tree, shelved, tabsById: tabsById([
		{ id: 1, index: 0 }, { id: 2, index: 1 }, { id: 3, index: 2, active: true },
		{ id: 5, index: 3 }, { id: 6, index: 4 },
	]) });
	assert.equal(selectedOfShelf.get(1), 3, "active member beats tab order");
});

test("nested shelves: the inner owner keeps its own strap", () => {
	// 1 owns a shelf with {2}; 2 (shelved, selected) owns a nested shelf with {3}
	const tree = [node(1, [], [node(2, [], [node(3, [], [node(4)])])])];
	const shelved = new Set([2, 3]);
	const { selectedOfShelf, shelves, ownerIds } = derive({ tree, shelved, tabsById: tabsById([
		{ id: 1, index: 0 }, { id: 2, index: 1 }, { id: 3, index: 2 }, { id: 4, index: 3 },
	]) });
	assert.equal(selectedOfShelf.get(1), 2);
	assert.equal(shelves.get(2).includes(3), true, "3 is shelved on 2's nested shelf");
	assert.deepEqual(shelves.get(1), [2], "the outer shelf holds 2 only");
	assert.equal(ownerIds.has(2), true, "the nested owner carries its own strap in its own row");
});

test("the owner is the strap target regardless of fold state", () => {
	const tree = [node(1, [], [node(2, ["subtree-collapsed"], [node(3, [], [node(4)])])])];
	const shelved = new Set([2, 3]);
	const { selectedOfShelf, shelves, ownerIds } = derive({ tree, shelved, tabsById: tabsById([
		{ id: 1, index: 0 }, { id: 2, index: 1 }, { id: 3, index: 2 }, { id: 4, index: 3 },
	]) });
	assert.equal(selectedOfShelf.get(1), undefined, "nothing unfolded on shelf 1");
	assert.deepEqual(shelves.get(2), [3], "the nested shelf does not depend on the owner being selected");
	assert.equal(ownerIds.has(1), true, "1 still hosts its shelf in its own row");
});

test("highlight covers the active shelved tab and its shelved ancestors", () => {
	// 1 -> 2 (shelved) -> 3 (shelved) -> 4 (active)
	const tree = [node(1, [], [node(2, [], [node(3, [], [node(4)])])])];
	const shelved = new Set([2, 3]);
	const { highlightIds } = derive({ tree, shelved, tabsById: tabsById([
		{ id: 1, index: 0 }, { id: 2, index: 1 }, { id: 3, index: 2 },
		{ id: 4, index: 3, active: true },
	]) });
	assert.equal(highlightIds.has(3), true, "direct parent of the active tab");
	assert.equal(highlightIds.has(2), true, "shelved ancestor of the active tab");
});

test("unrelated activation highlights nothing on foreign shelves", () => {
	const tree = [node(1, [], [node(2, [], [node(5)])]), node(3, [], [node(4)])];
	const shelved = new Set([2, 4]);
	const { highlightIds } = derive({ tree, shelved, tabsById: tabsById([
		{ id: 1, index: 0 }, { id: 2, index: 1 }, { id: 3, index: 2, active: true },
		{ id: 4, index: 3 }, { id: 5, index: 4 },
	]) });
	assert.equal(highlightIds.size, 0, "active tab 3 has no shelved ancestor-or-self");
});

test("boot reconciliation collapses every unfolded member but the selection", () => {
	// both 2 and 4 unfolded after restore; 4 is active => keep 4, collapse 2
	const tree = [node(1, [], [node(2, [], [node(5)]), node(4, [], [node(6)])])];
	const shelved = new Set([2, 4]);
	const tabs = tabsById([
		{ id: 1, index: 0 }, { id: 2, index: 1 }, { id: 4, index: 2, active: true },
		{ id: 5, index: 3 }, { id: 6, index: 4 },
	]);
	const derivation = derive({ tree, shelved, tabsById: tabs });
	assert.deepEqual(straysToCollapse({ tree, shelves: derivation.shelves, selectedOfShelf: derivation.selectedOfShelf, }), [2]);
});

test("straysToCollapse leaves lone selections and folded members alone", () => {
	const tree = [node(1, [], [node(2, ["subtree-collapsed"], [node(5)]), node(4, [], [node(6)])])];
	const shelved = new Set([2, 4]);
	const tabs = tabsById([
		{ id: 1, index: 0 }, { id: 2, index: 1 }, { id: 4, index: 2 },
		{ id: 5, index: 3 }, { id: 6, index: 4 },
	]);
	const derivation = derive({ tree, shelved, tabsById: tabs });
	assert.deepEqual(straysToCollapse({ tree, shelves: derivation.shelves, selectedOfShelf: derivation.selectedOfShelf, }), []);
});

test("ownersAffectedByActivation spans both owner chains and the root shelf", () => {
	const { parentIdOf } = indexTree([node(1, [], [node(2, [], [node(3)])]), node(4)]);
	assert.deepEqual(
		ownersAffectedByActivation({ fromId: 3, toId: 4, parentIdOf }).sort((a, b) => (a ?? -1) - (b ?? -1)),
		[ROOT_SHELF, 1, 2],
	);
});

test("pinned members never render on shelves", () => {
	const tree = [node(1, [], [node(2)])];
	const shelved = new Set([2]);
	const { shelves } = derive({ tree, shelved, tabsById: tabsById([
		{ id: 1, index: 0 }, { id: 2, index: 1, pinned: true },
	]) });
	assert.equal(shelves.has(1), false, "pinned tab is not a strap icon");
});

test("isFolded reads the subtree-collapsed state", () => {
	assert.equal(isFolded(["subtree-collapsed"]), true);
	assert.equal(isFolded(["collapsed"]), false, "'collapsed' is the per-row state, not the subtree fold");
	assert.equal(isFolded([]), false);
	assert.equal(isFolded(undefined), false);
});

// ---------------------------------------------------------------------------
// shelf placement (the member block)

/** Rank fixture: array of {id, pos} in TST's internal walk order
 *  (pinned optional). */
const ranks = (tabs) => tabs.map(tab => ({ pinned: false, ...tab }));

test("subtreeSizes counts rows plus descendants", () => {
	const tree = [node(1, [], [node(2, [], [node(3), node(4)]), node(5)]), node(6)];
	const sizes = subtreeSizes(tree);
	assert.equal(sizes.get(1), 5);
	assert.equal(sizes.get(2), 3);
	assert.equal(sizes.get(3), 1);
	assert.equal(sizes.get(6), 1);
});

test("treePositions numbers the pre-order walk", () => {
	const tree = [node(1, [], [node(2, [], [node(4)]), node(3)]), node(5)];
	assert.deepEqual([...treePositions(tree).entries()], [
		[1, 0], [2, 1], [4, 2], [3, 3], [5, 4],
	]);
});

test("a laid-out member block needs no moves", () => {
	// A <- (B shelved, C shelved), C <- (c1); strip: A B C c1 D
	const tree = [node(1, [], [node(2), node(3, [], [node(4)]), node(5)])];
	const shelves = new Map([[1, [2, 3]]]);
	assert.equal(nextPlacementMove({
		ranks: ranks([{ id: 1, pos: 0 }, { id: 2, pos: 1 }, { id: 3, pos: 2 }, { id: 4, pos: 3 }, { id: 5, pos: 4 }]),
		sizes: subtreeSizes(tree),
		shelves,
	}), null);
});

test("a scattered member is moved before the tab at its expected slot", () => {
	// strip: A D C c1 c2 B — members B (idx 5) and C (idx 2): in index
	// order C moves first, to slot 1 (before D); B follows on the next
	// iteration, after C's subtree.  Deterministic: members keep their
	// relative strip order inside the block.
	const tree = [node(1, [], [node(6), node(3, [], [node(7), node(8)]), node(2)])];
	const shelves = new Map([[1, [2, 3]]]);
	assert.deepEqual(nextPlacementMove({
		ranks: ranks([
			{ id: 1, pos: 0 }, { id: 6, pos: 1 }, { id: 3, pos: 2 },
			{ id: 7, pos: 3 }, { id: 8, pos: 4 }, { id: 2, pos: 5 },
		]),
		sizes: subtreeSizes(tree),
		shelves,
	}), { tabId: 3, kind: "move-before", referenceTabId: 6 });
});

test("appendTabId is forced to the shelf end regardless of index", () => {
	// members B (idx 1) and C (idx 3, freshly put): C must go AFTER B
	const tree = [node(1, [], [node(2), node(6), node(3)])];
	const shelves = new Map([[1, [2, 3]]]);
	assert.deepEqual(nextPlacementMove({
		ranks: ranks([
			{ id: 1, pos: 0 }, { id: 2, pos: 1 }, { id: 6, pos: 2 }, { id: 3, pos: 3 },
		]),
		sizes: subtreeSizes(tree),
		shelves,
		appendTabId: 3,
	}), { tabId: 3, kind: "move-before", referenceTabId: 6 });
});

test("the second member slots after the first one's subtree", () => {
	// B in place (idx 1) with subtree (b1: idx 2); C must go before D (idx 3)
	const tree = [node(1, [], [node(2, [], [node(5)]), node(3), node(4)])];
	const shelves = new Map([[1, [2, 3]]]);
	assert.deepEqual(nextPlacementMove({
		ranks: ranks([
			{ id: 1, pos: 0 }, { id: 2, pos: 1 }, { id: 5, pos: 2 },
			{ id: 4, pos: 3 }, { id: 3, pos: 4 },
		]),
		sizes: subtreeSizes(tree),
		shelves,
	}), { tabId: 3, kind: "move-before", referenceTabId: 4 });
});

test("an append past the strip end goes after the previous member, outdenting when it has descendants", () => {
	// Defensive path: with TST's contiguity invariants a dense strip can
	// hardly reach this state (the first misplaced member always gets a
	// move-before first), but a race or a gap must not wedge the loop —
	// sparse indices exercise it: B in place, its subtree ending at the
	// last dense index, C stranded beyond the expected slot.
	const tree = [node(1, [], [node(2, [], [node(5), node(6)]), node(3)])];
	const shelves = new Map([[1, [2, 3]]]);
	assert.deepEqual(nextPlacementMove({
		ranks: ranks([
			{ id: 1, pos: 0 }, { id: 2, pos: 1 }, { id: 5, pos: 2 },
			{ id: 6, pos: 3 }, { id: 3, pos: 7 },
		]),
		sizes: subtreeSizes(tree),
		shelves,
		appendTabId: 3,
	}), { tabId: 3, kind: "move-after", referenceTabId: 2, thenOutdent: true });

	// same, but B childless: plain move-after re-parents to the owner
	const tree2 = [node(1, [], [node(2), node(3)])];
	assert.deepEqual(nextPlacementMove({
		ranks: ranks([{ id: 1, pos: 0 }, { id: 2, pos: 1 }, { id: 3, pos: 7 }]),
		sizes: subtreeSizes(tree2),
		shelves,
		appendTabId: 3,
	}), { tabId: 3, kind: "move-after", referenceTabId: 2, thenOutdent: false });
});

test("root members slot against the first non-pinned tab", () => {
	// pinned P (idx 0), root members R1 (idx 2), R2 (idx 3, appended);
	// root block top = idx 1 (normal tab X sits there)
	const tree = [node(9), node(1), node(2)];
	const shelves = new Map([[ROOT_SHELF, [1, 2]]]);
	assert.deepEqual(nextPlacementMove({
		ranks: ranks([
			{ id: 99, pos: 0, pinned: true }, { id: 9, pos: 1 },
			{ id: 1, pos: 2 }, { id: 2, pos: 3 },
		]),
		sizes: subtreeSizes(tree),
		shelves,
		appendTabId: 2,
	}), { tabId: 1, kind: "move-before", referenceTabId: 9 });
});

test("the first shelf needing a move wins across several shelves", () => {
	const tree = [
		node(1, [], [node(2), node(7)]),
		node(3, [], [node(4), node(8)]),
	];
	const shelves = new Map([[1, [2]], [3, [4]]]);
	// shelf 1 laid out (B at 1); shelf 3's member at idx 3, slot = 2 (tab 8)
	assert.deepEqual(nextPlacementMove({
		ranks: ranks([
			{ id: 1, pos: 0 }, { id: 2, pos: 1 }, { id: 3, pos: 2 },
			{ id: 8, pos: 3 }, { id: 4, pos: 4 },
		]),
		sizes: subtreeSizes(tree),
		shelves,
	}), { tabId: 4, kind: "move-before", referenceTabId: 8 });
});

// ---------------------------------------------------------------------------
// favicon stickiness (the icon keeps the last known favicon while loading)

test("resolveFavicons records tabs that have a favicon", () => {
	const memory = new Map;
	const { tabs, memory: next, } = resolveFavicons([{ id: 1, favIconUrl: "https://a/img.png", }], memory);
	assert.equal(next.get(1), "https://a/img.png");
	assert.equal(tabs[0].favIconUrl, "https://a/img.png", "no patching needed");
});

test("a loading tab without a favicon renders the remembered one", () => {
	const memory = new Map([[1, "https://a/img.png",]]);
	const { tabs, } = resolveFavicons([{ id: 1, favIconUrl: undefined, }], memory);
	assert.equal(tabs[0].favIconUrl, "https://a/img.png", "the blank tab carries the remembered favicon");
	assert.equal(memory.get(1), "https://a/img.png", "the memory is not consumed");
});

test("a never-seen tab without a favicon stays favicon-less", () => {
	const { tabs, memory, } = resolveFavicons([{ id: 7, }], new Map);
	assert.equal("favIconUrl" in tabs[0], false, "no phantom favicon appears");
	assert.equal(memory.size, 0);
});

test("the memory follows favicon changes; blanks fall back to the newest one", () => {
	let { tabs, memory, } = resolveFavicons([{ id: 1, favIconUrl: "https://a/1.png", }], new Map);
	assert.equal(memory.get(1), "https://a/1.png");
	({ tabs, memory, } = resolveFavicons([{ id: 1, favIconUrl: "https://b/2.png", }], memory));
	assert.equal(memory.get(1), "https://b/2.png", "a new favicon overwrites the memory");
	({ tabs, memory, } = resolveFavicons([{ id: 1, }], memory));
	assert.equal(tabs[0].favIconUrl, "https://b/2.png", "a blank falls back to the NEW favicon, not the oldest one");
});

test("the memory survives across windows' derivations", () => {
	let { memory, } = resolveFavicons([{ id: 1, favIconUrl: "https://a/1.png", }], new Map);
	({ memory, } = resolveFavicons([{ id: 2, favIconUrl: "https://b/2.png", }], memory));
	const { tabs, } = resolveFavicons([{ id: 1, }], memory);
	assert.equal(tabs[0].favIconUrl, "https://a/1.png", "entries from other derivations persist");
});

// ---------------------------------------------------------------------------
// rows that must never be reclaimed (the active tab and its ancestors)

test("mustShowTabs spans the active tab and its whole ancestor chain", () => {
	const tree = [node(1, [], [node(2, [], [node(3, [], [node(4)])]), node(5)]), node(6)];
	assert.deepEqual([...mustShowTabs({ tree, activeId: 4 })].sort(), [1, 2, 3, 4],
		"a nested shelved owner stays visible while a tab of its shelf is active");
	assert.deepEqual([...mustShowTabs({ tree, activeId: 6 })], [6], "a root tab has no ancestors");
	assert.deepEqual([...mustShowTabs({ tree, activeId: null })], [], "no active tab, nothing to protect");
});

test("mustShowTabs survives an unknown active id", () => {
	const tree = [node(1, [], [node(2)])];
	assert.deepEqual([...mustShowTabs({ tree, activeId: 99 })], [99],
		"an untracked active id protects itself and the walk stops");
});

test("mustShowTabs protects a parent whose children are mid-animation", () => {
	// C's children are collapsing: TST paints them until the animation
	// ends (collapseDuration = 150 ms), so C must keep its row or they are
	// orphaned.
	const tree = [node(1, [], [node(2, [], [node(5, ["collapsing"]), node(6, ["expanding"])])])];
	const must = mustShowTabs({ tree, activeId: 2 });
	assert.equal(must.has(5), true, "the collapsing tab itself");
	assert.equal(must.has(6), true, "the expanding tab itself");
	assert.equal(must.has(2), true, "their parent — the shelved tab being switched away from");
	assert.equal(must.has(1), true, "and its owner");
});

test("mustShowTabs ignores settled states", () => {
	const tree = [node(1, [], [node(2, ["subtree-collapsed"], [node(5, ["collapsed-completely"])])]), node(3)];
	const must = mustShowTabs({ tree, activeId: 3 });
	assert.deepEqual([...must], [3], "a finished collapse protects nobody");
});

test("a member's unfolded subtree dangles once its row is gone", () => {
	// A <- (D: plain sibling, S: shelved, with children s1/s2).
	// S was active and unfolded; the user activated D.  S's row is
	// reclaimed (it is neither active nor an ancestor of the active tab),
	// so its subtree must be folded — 0.1.6 left s1/s2 rendered under a
	// parent row that no longer existed.
	const tree = [node(1, [], [node(2), node(3, [], [node(5), node(6)])])];
	const shelved = new Set([3]);
	const must = mustShowTabs({ tree, activeId: 2 });
	assert.deepEqual(danglingMembers({ tree, shelved, mustShow: must }), [3],
		"unfolded member with no row on screen");
});

test("the active member's subtree is not dangling", () => {
	const tree = [node(1, [], [node(2), node(3, [], [node(5), node(6)])])];
	const shelved = new Set([3]);
	const must = mustShowTabs({ tree, activeId: 3 });
	assert.deepEqual(danglingMembers({ tree, shelved, mustShow: must }), []);
});

test("a member whose descendant is active is not dangling", () => {
	// s1 is the active tab: S is an ancestor of it, so S keeps its row
	// and its subtree may stay unfolded.
	const tree = [node(1, [], [node(3, [], [node(5), node(6)])])];
	const shelved = new Set([3]);
	const must = mustShowTabs({ tree, activeId: 5 });
	assert.deepEqual(danglingMembers({ tree, shelved, mustShow: must }), []);
});

test("folded and childless members are never dangling", () => {
	const tree = [node(1, [], [node(2), node(3, ["subtree-collapsed"], [node(5)])])];
	const shelved = new Set([2, 3]);
	const must = mustShowTabs({ tree, activeId: 1 });
	assert.deepEqual(danglingMembers({ tree, shelved, mustShow: must }), []);
});

test("a member already collapsing is not dangling again", () => {
	// TST is folding it right now, so mustShowTabs protects its row until
	// the animation ends — the fold request must not be repeated, and the
	// hide stays deferred by that same protection.
	const tree = [node(1, [], [node(3, ["collapsing"], [node(5, ["collapsed-completely"])])])];
	const shelved = new Set([3]);
	const must = mustShowTabs({ tree, activeId: 1 });
	assert.equal(must.has(3), true, "protected mid-animation");
	assert.deepEqual(danglingMembers({ tree, shelved, mustShow: must }), []);
});
