/**
 * Spec-derived unit tests for src/background/logic.esm.js (node --test).
 * Run: make test
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	derive, indexTree, isFolded, straysToCollapse, ownersAffectedByActivation,
	subtreeSizes, treePositions, nextPlacementMove, planExtremePlacementMove, resolveFavicons,
	mustShowTabs, danglingMembers, ROOT_SHELF,
	planReveals, isSubtreeFolded, planRestoreMove, subtreeIds, siblingListOf,
	assignHints, hintMatches, HINT_CHARSET, normalizeHintCharset, normalizeHintFontSize, isSpecialPageUrl, planHintTargets,
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

test("every member with descendants carries a fold badge, folded or not", () => {
	const tree = [node(1, [], [node(2, ["subtree-collapsed"], [node(5), node(6)]), node(4, [], [node(7)])])];
	const shelved = new Set([2, 4]);
	const { selectedOfShelf, badgeIds, badgeCounts, } = derive({ tree, shelved, tabsById: tabsById([
		{ id: 1, index: 0 }, { id: 2, index: 1 }, { id: 4, index: 2 },
		{ id: 5, index: 3 }, { id: 6, index: 4 }, { id: 7, index: 5 },
	]) });
	assert.equal(selectedOfShelf.get(1), 4, "the unfolded member is selected");
	assert.equal(badgeIds.has(2), true, "folded member carries the badge");
	assert.equal(badgeIds.has(4), true, "an UNFOLDED member with children carries it too (TST's counter shows always)");
	assert.deepEqual([...badgeCounts.entries()].sort((a, b) => a[0] - b[0]), [[2, 2], [4, 1]],
		"the count is the descendants, the tab itself excluded (TST's tab-counter number)");
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

test("a member carrying a put sequence is forced to the shelf end regardless of index", () => {
	// strip order already holds B (2) at the owner's first slot and C (3)
	// after it; B was just put again, so it must become the rightmost
	// icon.  Without `appendOrder` the planner returns null (both in
	// place) — that difference is what makes this test detect the
	// behaviour it names.
	const tree = [node(1, [], [node(2), node(3), node(4)])];
	const shelves = new Map([[1, [2, 3]]]);
	const args = {
		ranks: ranks([
			{ id: 1, pos: 0 }, { id: 2, pos: 1 }, { id: 3, pos: 2 }, { id: 4, pos: 3 },
		]),
		sizes: subtreeSizes(tree),
		shelves,
	};
	assert.deepEqual(nextPlacementMove({ ...args, appendOrder: new Map([[2, 1]]) }),
		{ tabId: 3, kind: "move-before", referenceTabId: 2 },
		"the older member (3) moves in front of the freshly put one (2)");
	assert.equal(nextPlacementMove(args), null, "control: no put order, no move");
});

test("two rapid puts keep their sequence order, newest last", () => {
	// B (seq 2) and C (seq 1) are both freshly put while the strip still
	// reads [B, C]: the shelf order is the PUT order, so C goes first.
	// A single append slot lost one of them (caught by the E2E:
	// `[B, C, F]` instead of `[C, B, F]`).
	const tree = [node(1, [], [node(2), node(3), node(4)])];
	const shelves = new Map([[1, [2, 3]]]);
	assert.deepEqual(nextPlacementMove({
		ranks: ranks([
			{ id: 1, pos: 0 }, { id: 2, pos: 1 }, { id: 3, pos: 2 }, { id: 4, pos: 3 },
		]),
		sizes: subtreeSizes(tree),
		shelves,
		appendOrder: new Map([[2, 2], [3, 1]]),
	}), { tabId: 3, kind: "move-before", referenceTabId: 2 });
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
		appendOrder: new Map([[3, 1]]),
	}), { tabId: 3, kind: "move-after", referenceTabId: 2, thenOutdent: true });

	// same, but B childless: plain move-after re-parents to the owner
	const tree2 = [node(1, [], [node(2), node(3)])];
	assert.deepEqual(nextPlacementMove({
		ranks: ranks([{ id: 1, pos: 0 }, { id: 2, pos: 1 }, { id: 3, pos: 7 }]),
		sizes: subtreeSizes(tree2),
		shelves,
		appendOrder: new Map([[3, 1]]),
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
		appendOrder: new Map([[2, 1]]),
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
// take-off restoration (the tab returns to its pre-shelve place)

test("restoring a tab that has to move toward a later index references the right tab", () => {
	// [X, A, B] and X originally sat at index 1: the tab at index 1 is A,
	// but X must land BETWEEN A and B.  Referencing A would leave the
	// order unchanged ([X, A, B]) — the off-by-one this planner exists to
	// prevent.
	assert.deepEqual(planRestoreMove({ order: [7, 1, 2], tabId: 7, savedIndex: 1 }),
		{ kind: "move-before", referenceTabId: 2 });
});

test("restoring a tab that has to move toward an earlier index", () => {
	assert.deepEqual(planRestoreMove({ order: [1, 2, 7], tabId: 7, savedIndex: 0 }),
		{ kind: "move-before", referenceTabId: 1 });
	assert.deepEqual(planRestoreMove({ order: [1, 2, 7], tabId: 7, savedIndex: 1 }),
		{ kind: "move-before", referenceTabId: 2 });
});

test("a tab already in its old place does not move", () => {
	assert.equal(planRestoreMove({ order: [1, 7, 2], tabId: 7, savedIndex: 1 }), null);
	assert.equal(planRestoreMove({ order: [7, 1, 2], tabId: 7, savedIndex: 0 }), null);
	assert.equal(planRestoreMove({ order: [1, 2, 7], tabId: 7, savedIndex: 2 }), null);
});

test("the last position is restored with move-after, the first with move-before", () => {
	assert.deepEqual(planRestoreMove({ order: [7, 1, 2], tabId: 7, savedIndex: 2 }),
		{ kind: "move-after", referenceTabId: 2 });
	assert.deepEqual(planRestoreMove({ order: [1, 7, 2], tabId: 7, savedIndex: 0 }),
		{ kind: "move-before", referenceTabId: 1 });
	assert.equal(planRestoreMove({ order: [1, 2, 7], tabId: 7, savedIndex: 99 }), null,
		"an index past the end clamps to the end — the tab is already there");
});

test("the tab's subtree never serves as its own landing reference", () => {
	// 7 owns 8 and 9 (followChildren carries them) and already sits at
	// its old index 1.  Counting the subtree as ordinary tabs, the slot at
	// index 1 is the mover's OWN child 8 — the planner would "restore" the
	// tab before its own descendants.
	const tree = [node(1), node(7, [], [node(8), node(9)]), node(2)];
	assert.deepEqual(subtreeIds({ tree, id: 7 }), [8, 9]);
	assert.deepEqual(planRestoreMove({ order: [1, 7, 8, 9, 2], tabId: 7, subtree: [8, 9], savedIndex: 2 }),
		{ kind: "move-after", referenceTabId: 2 }, "slot 2 = the end, once the subtree does not count");
	assert.deepEqual(planRestoreMove({ order: [1, 7, 8, 9, 2], tabId: 7, savedIndex: 2 }),
		{ kind: "move-before", referenceTabId: 9 },
		"control: without the subtree list the reference is the tab's own descendant");
});

test("saved neighbour ids win over an index that unrelated moves shifted", () => {
	// A tab was opened at the end, then something was closed in front of
	// it: the bare index no longer means its old place, the neighbours do.
	assert.deepEqual(planRestoreMove({ order: [1, 2, 7], tabId: 7, savedIndex: 2, beforeId: 1, afterId: 2 }),
		{ kind: "move-after", referenceTabId: 1 });
	assert.equal(planRestoreMove({ order: [1, 7, 2], tabId: 7, savedIndex: 1, beforeId: 1, afterId: 2 }), null,
		"already between the two neighbours");
	assert.deepEqual(planRestoreMove({ order: [1, 7, 2], tabId: 7, savedIndex: 1, beforeId: 99, afterId: 1 }),
		{ kind: "move-before", referenceTabId: 1 }, "a closed neighbour falls back to the surviving one");
});

test("siblingListOf returns the tab's own parent and its ordered siblings", () => {
	// A <- (B, C <- (c1, c2), D), E: B's siblings are [B, C, D]; c1's are
	// [c1, c2]; E has no parent.
	const tree = [node(1, [], [node(2), node(3, [], [node(5), node(6)]), node(4)]), node(7)];
	assert.deepEqual(siblingListOf({ tree, id: 2 }), { parentId: 1, siblings: [2, 3, 4], slot: 0 });
	assert.deepEqual(siblingListOf({ tree, id: 5 }), { parentId: 3, siblings: [5, 6], slot: 0 });
	assert.deepEqual(siblingListOf({ tree, id: 7 }), { parentId: null, siblings: [1, 7], slot: 1 });
	assert.equal(siblingListOf({ tree, id: 99 }), null, "not in the tree");
});

test("restoring among a sibling list uses the saved slot", () => {
	// The caller passes the tab's CURRENT sibling list and drops the
	// neighbour hints when the parent changed.  Siblings [9, 4, 5], the
	// tab (9) first, its old slot 1: it must land between 4 and 5.
	// Referencing a former cousin would re-parent the tab into that
	// cousin's subtree (move-after a descendant does exactly that).
	assert.deepEqual(planRestoreMove({ order: [9, 4, 5], tabId: 9, savedIndex: 1 }),
		{ kind: "move-before", referenceTabId: 5 });
	assert.equal(planRestoreMove({ order: [4, 9, 5], tabId: 9, savedIndex: 1 }), null,
		"already between them");
	assert.deepEqual(planRestoreMove({ order: [4, 9, 5], tabId: 9, savedIndex: 0 }),
		{ kind: "move-before", referenceTabId: 4 });
	assert.deepEqual(planRestoreMove({ order: [4, 9, 5], tabId: 9, savedIndex: 2 }),
		{ kind: "move-after", referenceTabId: 5 });
});

test("a tab missing from the order plans no move", () => {
	assert.equal(planRestoreMove({ order: [1, 2], tabId: 7, savedIndex: 0 }), null);
	assert.equal(planRestoreMove({ order: [7], tabId: 7, savedIndex: 0 }), null, "nowhere to land");
});

// ---------------------------------------------------------------------------
// placement fallbacks

test("no tab exists at the expected slot and there is no previous member: no move", () => {
	// a sparse rank set (a race or a foreign re-parent left a gap): owner
	// at 0, member at 5, nothing at 1 — and the member is the FIRST of the
	// shelf, so there is no previous member to append after.
	const tree = [node(1, [], [node(3)])];
	assert.equal(nextPlacementMove({
		ranks: ranks([{ id: 1, pos: 0 }, { id: 3, pos: 5 }]),
		sizes: subtreeSizes(tree),
		shelves: new Map([[1, [3]]]),
	}), null);
});

test("an all-pinned shelf member is left alone", () => {
	// pinned tabs live outside the tree: they are filtered out of the
	// plan and the planner reports nothing to do
	const tree = [node(1), node(2)];
	assert.equal(nextPlacementMove({
		ranks: ranks([{ id: 1, pos: 0 }, { id: 2, pos: 1, pinned: true }]),
		sizes: subtreeSizes(tree),
		shelves: new Map([[1, [2]]]),
	}), null);
});

// ---------------------------------------------------------------------------
// favicon stickiness (the icon keeps the last known favicon while loading)

test("resolveFavicons records tabs that have a favicon", () => {
	const memory = new Map;
	const { tabs, memory: next, } = resolveFavicons([{ id: 1, favIconUrl: "https://a/img.png", }], memory);
	assert.deepEqual(next.get(1), { favIconUrl: "https://a/img.png", pageUrl: undefined });
	assert.equal(tabs[0].favIconUrl, "https://a/img.png", "no patching needed");
});

test("a loading tab without a favicon renders the remembered one", () => {
	const memory = new Map([[1, { favIconUrl: "https://a/img.png", pageUrl: "https://a/x", }]]);
	const { tabs, } = resolveFavicons([{ id: 1, favIconUrl: undefined, }], memory);
	assert.equal(tabs[0].favIconUrl, "https://a/img.png", "the blank tab carries the remembered favicon");
	assert.equal(memory.get(1).favIconUrl, "https://a/img.png", "the memory is not consumed");
});

test("a never-seen tab without a favicon stays favicon-less", () => {
	const { tabs, memory, } = resolveFavicons([{ id: 7, }], new Map);
	assert.equal("favIconUrl" in tabs[0], false, "no phantom favicon appears");
	assert.equal(memory.size, 0);
});

test("the memory follows favicon changes; blanks fall back to the newest one", () => {
	let { tabs, memory, } = resolveFavicons([
		{ id: 1, favIconUrl: "https://a/1.png", }, { id: 1, url: "https://a/x", },
	], new Map);
	// a delivered favicon pairs with its page url
	({ memory, } = resolveFavicons([{ id: 1, favIconUrl: "https://a/1.png", url: "https://a/x", }], memory));
	assert.deepEqual(memory.get(1), { favIconUrl: "https://a/1.png", pageUrl: "https://a/x", });
	({ tabs, memory, } = resolveFavicons([{ id: 1, favIconUrl: "https://b/2.png", url: "https://b/y", }], memory));
	assert.deepEqual(memory.get(1), { favIconUrl: "https://b/2.png", pageUrl: "https://b/y", },
		"a cross-site favicon overwrites the memory");
	({ tabs, memory, } = resolveFavicons([{ id: 1, }], memory));
	assert.equal(tabs[0].favIconUrl, "https://b/2.png", "a blank falls back to the NEW favicon, not the oldest one");
});

test("the memory survives across windows' derivations", () => {
	let { memory, } = resolveFavicons([{ id: 1, favIconUrl: "https://a/1.png", url: "https://a/x", }], new Map);
	({ memory, } = resolveFavicons([{ id: 2, favIconUrl: "https://b/2.png", url: "https://b/y", }], memory));
	const { tabs, } = resolveFavicons([{ id: 1, }], memory);
	assert.equal(tabs[0].favIconUrl, "https://a/1.png", "entries from other derivations persist");
});

test("a default-favicon delivery (the error page) never overwrites or wins (measured: info.svg)", () => {
	// Firefox 158: a blocked page settles with chrome://global/skin/icons/info.svg
	const memory = new Map([[1, { favIconUrl: "https://a/img.png", pageUrl: "https://a/x", }]]);
	const { tabs, memory: next, } = resolveFavicons([
		{ id: 1, favIconUrl: "chrome://global/skin/icons/info.svg", url: "http://unreachable:9/", status: "complete", },
	], memory);
	assert.equal(tabs[0].favIconUrl, "https://a/img.png", "the failed navigation keeps the previous site's icon");
	assert.deepEqual(next.get(1), { favIconUrl: "https://a/img.png", pageUrl: "https://a/x", },
		"the placeholder never enters the memory");
});

test("a cross-site page that settles with no favicon drops the stale icon", () => {
	const memory = new Map([[1, { favIconUrl: "https://a/img.png", pageUrl: "https://a/x", }]]);
	const { tabs, memory: next, } = resolveFavicons([
		{ id: 1, favIconUrl: undefined, url: "https://other/plain.txt", status: "complete", },
	], memory);
	assert.equal(tabs[0].favIconUrl == null, true, "the old icon would be a lie on the new document");
	assert.equal(next.size, 0, "the stale entry is dropped");
});

test("an internal page that settles with no favicon keeps the remembered icon", () => {
	// the E2E parks shelved tabs on about:blank; it is nobody's site
	const memory = new Map([[1, { favIconUrl: "https://a/img.png", pageUrl: "https://a/x", }]]);
	const { tabs, memory: next, } = resolveFavicons([
		{ id: 1, favIconUrl: undefined, url: "about:blank", status: "complete", },
	], memory);
	assert.equal(tabs[0].favIconUrl, "https://a/img.png");
	assert.equal(next.size, 1);
});

test("a same-origin page that settles with no favicon keeps the remembered icon", () => {
	const memory = new Map([[1, { favIconUrl: "https://a/img.png", pageUrl: "https://a/x", }]]);
	const { tabs, memory: next, } = resolveFavicons([
		{ id: 1, favIconUrl: undefined, url: "https://a/z", status: "complete", },
	], memory);
	assert.equal(tabs[0].favIconUrl, "https://a/img.png", "the site's own settled reload keeps it");
	assert.equal(next.size, 1, "the same-origin entry stays");
});

test("a data: favicon is a real site favicon, not a placeholder (measured)", () => {
	const memory = new Map([[1, { favIconUrl: "https://a/img.png", pageUrl: "https://a/x", }]]);
	const { tabs, memory: next, } = resolveFavicons([
		{ id: 1, favIconUrl: "data:image/svg+xml;base64,AAAA", url: "https://b/x", status: "complete", },
	], memory);
	assert.equal(tabs[0].favIconUrl, "data:image/svg+xml;base64,AAAA", "it renders");
	assert.equal(next.get(1).favIconUrl, "data:image/svg+xml;base64,AAAA", "it wins the memory");
});

test("while a foreign page is still loading, the remembered icon stays", () => {
	const memory = new Map([[1, { favIconUrl: "https://a/img.png", pageUrl: "https://a/x", }]]);
	const { tabs, memory: next, } = resolveFavicons([
		{ id: 1, favIconUrl: undefined, url: "https://other/x", status: "loading", },
	], memory);
	assert.equal(tabs[0].favIconUrl, "https://a/img.png", "an icon may still arrive");
	assert.equal(next.size, 1, "the memory is intact until the settle");
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

// ---------------------------------------------------------------------------
// reveals: a folded shelf owner shows only the active tab's branch

/** A <- (B, C <- (c1, c2), D), E — the tree the user reported the bug on:
 *  B and C sit on A's shelf (row-less: hidden), D is an ordinary unshelved child.
 *  A is FOLDED: the state at the moment the reveal is created.  Measured
 *  marker placement: the fold point carries `subtree-collapsed`, every tab
 *  inside the fold carries `collapsed`. */
const foldedTree = () => [
	node(1, ["subtree-collapsed"], [
		node(2, ["collapsed"]),
		node(3, ["collapsed"], [node(5, ["collapsed"]), node(6, ["collapsed"])]),
		node(4, ["collapsed"]),
	]),
	node(7),
];

/** The same tree one derivation later: the reveal expanded A, so the
 *  owner and its children are renderable — which is exactly why the
 *  siblings must lose their rows. */
const revealedTree = () => [
	node(1, [], [
		node(2),
		node(3, [], [node(5), node(6)]),
		node(4),
	]),
	node(7),
];

test("isSubtreeFolded reads BOTH of TST's fold markers", () => {
	// measured: the fold point carries `subtree-collapsed`, every tab inside
	// the fold carries `collapsed` — both mean the subtree is not rendered
	assert.equal(isSubtreeFolded(["subtree-collapsed"]), true, "the tab the fold was applied to");
	assert.equal(isSubtreeFolded(["collapsed"]), true, "a tab inside that fold");
	assert.equal(isSubtreeFolded(["collapsed", "newtab-command-tab"]), true);
	assert.equal(isSubtreeFolded(["newtab-command-tab"]), false);
	assert.equal(isSubtreeFolded(undefined), false);
});

test("a reveal keeps the active tab's branch and suppresses the rest of the owner's subtree", () => {
	// activating the shelved child C (which has children) must reveal C
	// and c1/c2 only — D, the unshelved sibling, keeps NO row, and B stays
	// row-less on the shelf.
	const { suppress, prune, } = planReveals({
		tree: revealedTree(), activeId: 3,
		reveals: new Map([[1, { openedSeen: true, }]]),
	});
	assert.deepEqual(prune, []);
	assert.deepEqual(suppress.sort(), [2, 4], "the siblings outside the branch, never C or its children");
});

test("the branch follows the active tab while the reveal lives", () => {
	const reveals = new Map([[1, { openedSeen: true, }]]);
	// the unshelved child D becomes active: its own row replaces the branch
	assert.deepEqual(planReveals({ tree: revealedTree(), activeId: 4, reveals, }).suppress.sort(),
		[2, 3, 5, 6]);
	// a grandchild: the branch is still C's whole subtree, so c1 keeps its
	// row even though c2 is the active tab
	assert.deepEqual(planReveals({ tree: revealedTree(), activeId: 6, reveals, }).suppress.sort(),
		[2, 4], "C is the owner's direct child on the path, so its subtree is the branch");
});

test("a reveal ends when the active tab leaves the owner's subtree", () => {
	const { suppress, prune, } = planReveals({
		tree: revealedTree(), activeId: 7,
		reveals: new Map([[1, { openedSeen: true, }]]),
	});
	assert.deepEqual(prune, [1], "the owner is folded back");
	assert.deepEqual(suppress, []);
});

test("a reveal ends when the owner itself becomes active", () => {
	assert.deepEqual(planReveals({
		tree: revealedTree(), activeId: 1,
		reveals: new Map([[1, { openedSeen: true, }]]),
	}).prune, [1]);
});

test("the user folding the owner ends the reveal", () => {
	assert.deepEqual(planReveals({
		tree: foldedTree(), activeId: 3,
		reveals: new Map([[1, { openedSeen: true, }]]),
	}).prune, [1], "the owner reads `collapsed` again: that fold is the user's");
});

test("our own expansion still in flight does not end the reveal", () => {
	// openedSeen is false until a derivation has SEEN the owner expanded —
	// otherwise the first pass after creating the reveal would mistake the
	// not-yet-expanded owner for a user fold and cancel the reveal.
	const { prune, suppress, } = planReveals({
		tree: foldedTree(), activeId: 3,
		reveals: new Map([[1, { openedSeen: false, }]]),
	});
	assert.deepEqual(prune, []);
	assert.deepEqual(suppress.sort(), [2, 4]);
});

test("a reveal of a closed owner is dropped", () => {
	assert.deepEqual(planReveals({
		tree: foldedTree(), activeId: 3,
		reveals: new Map([[99, { openedSeen: true, }]]),
	}).prune, [99]);
});

test("tabs that must keep their row are never suppressed", () => {
	// mid-animation tabs are in mustShowTabs; taking their row away would
	// orphan whatever is animating under them
	const { suppress, } = planReveals({
		tree: revealedTree(), activeId: 3,
		reveals: new Map([[1, { openedSeen: true, }]]),
		mustShow: new Set([4]),
	});
	assert.deepEqual(suppress, [2], "D is protected");
});

test("nested reveals each suppress their own owner's subtree", () => {
	// G <- (P <- (B, C), X): G and P both own shelves, both are expanded by
	// their reveal (no `collapsed` state — that would mean the user folded
	// them back), and the active tab lives under P.
	const tree = [
		node(1, [], [
			node(2, [], [
				node(3),
				node(4),
			]),
			node(5),
		]),
	];
	const { suppress, prune, } = planReveals({
		tree, activeId: 4,
		reveals: new Map([[1, { openedSeen: true, }], [2, { openedSeen: true, }]]),
	});
	assert.deepEqual(prune, []);
	assert.deepEqual(suppress.sort(), [3, 5], "X from the outer owner, B from the inner one");
});

// ---------------------------------------------------------------------------
// drag holds: the preserved pre-drag branch (shelf-nesting delta)

test("mustShowTabs without a hold is unchanged by the extra argument", () => {
	const tree = [node(1, [], [node(2, [], [node(3, [], [node(4)])])])];
	assert.deepEqual([...mustShowTabs({ tree, activeId: 4, })].sort(), [1, 2, 3, 4]);
	assert.deepEqual([...mustShowTabs({ tree, activeId: 4, preservedActiveId: null, })].sort(), [1, 2, 3, 4],
		"a null preserved anchor contributes nothing");
});

test("mustShowTabs protects the union of the live and preserved chains", () => {
	// X <- (S <- (s1, ...)), Y <- (y1): the drag hold preserves the
	// pre-press branch S<-s1 while the press activated y1.
	const tree = [node(1, [], [node(2, [], [node(3, [], [node(4)])]), node(5, [], [node(6)])])];
	const must = mustShowTabs({ tree, activeId: 6, preservedActiveId: 4 });
	assert.deepEqual([...must].sort(), [1, 2, 3, 4, 5, 6],
		"both chains: the dragged tab keeps its rows, the preserved shelved branch keeps its drop targets");
});

test("mustShowTabs treats an unknown preserved id like an unknown active id", () => {
	const tree = [node(2)];
	assert.deepEqual([...mustShowTabs({ tree, activeId: 2, preservedActiveId: 99, })].sort(), [2, 99],
		"the walk stops at the missing node; the id itself is still protected until it is re-read");
});

test("a drag outside a revealed owner does not end its reveal at grasp", () => {
	// the pre-drag branch (C's subtree) hangs beneath owner A; the press
	// activated E outside A.  Without the hold this pruned the reveal and
	// folded A mid-drag; with it the reveal survives until the drag
	// resolves.
	const reveals = new Map([[1, { openedSeen: true, }]]);
	const { suppress, prune, } = planReveals({
		tree: revealedTree(), activeId: 7, preservedActiveId: 3, reveals,
	});
	assert.deepEqual(prune, [], "the preserved branch is still beneath owner A (1)");
	assert.deepEqual(suppress.sort(), [2, 4], "the live branch is outside, so only the preserved branch's siblings lose their rows");
});

test("both anchors beneath one owner reveal the union of their branches", () => {
	// the pressed active tab c1 (id 5) while the preserved branch is C's
	// whole subtree (3 <- c1, c2): both C's branch and the deeper branch
	// stay renderable — one subtree contains the other here, so only D
	// (the unshelved sibling) and B (the other member) are suppressed.
	const { suppress, prune, } = planReveals({
		tree: revealedTree(), activeId: 5, preservedActiveId: 3,
		reveals: new Map([[1, { openedSeen: true, }]]),
	});
	assert.deepEqual(prune, []);
	assert.deepEqual(suppress.sort(), [2, 4], "ids outside BOTH branch subtrees are suppressed");
});

test("two sibling branches beneath one owner both stay renderable", () => {
	// the active tab is B (id 2, a childless member) while the preserved
	// branch is C <- (c1, c2): the dragged tab's branch and the preserved
	// branch are disjoint subtrees, and only D is outside both.
	const { suppress, prune, } = planReveals({
		tree: revealedTree(), activeId: 2, preservedActiveId: 3,
		reveals: new Map([[1, { openedSeen: true, }]]),
	});
	assert.deepEqual(prune, []);
	assert.deepEqual(suppress, [4], "D alone loses its row: it is the only descendant outside both branches");
});

test("one owner, one anchor each: an outside active tab adds nothing to the branch", () => {
	// the preserved anchor lives below owner A while the active tab (id 7)
	// is a root tab outside: the branch is the preserved branch alone
	const { suppress, prune, } = planReveals({
		tree: revealedTree(), activeId: 7, preservedActiveId: 5,
		reveals: new Map([[1, { openedSeen: true, }]]),
	});
	assert.deepEqual(prune, []);
	assert.deepEqual(suppress.sort(), [2, 4], "C's branch (B=5) is exposed, no part of the outside active tab is");
});

test("a reveal with only an outside preserved anchor is pruned (release)", () => {
	// the hold released: the preserved anchor is gone (null) and the
	// active tab is outside the owner — the ordinary prune path runs
	assert.deepEqual(planReveals({
		tree: revealedTree(), activeId: 7, preservedActiveId: null,
		reveals: new Map([[1, { openedSeen: true, }]]),
	}).prune, [1]);
});

test("the user folding the owner still wins during a hold", () => {
	assert.deepEqual(planReveals({
		tree: foldedTree(), activeId: 7, preservedActiveId: 3,
		reveals: new Map([[1, { openedSeen: true, }]]),
	}).prune, [1], "openedSeen + collapsed states = the user's own fold, hold or no hold");
});

test("a closed owner is pruned regardless of a preserved anchor", () => {
	assert.deepEqual(planReveals({
		tree: foldedTree(), activeId: 3, preservedActiveId: 99,
		reveals: new Map([[99, { openedSeen: true, }]]),
	}).prune, [99]);
});

test("an unknown preserved anchor never keeps a reveal open by itself", () => {
	assert.deepEqual(planReveals({
		tree: revealedTree(), activeId: 6, preservedActiveId: 99,
		reveals: new Map([[1, { openedSeen: true, }]]),
	}).prune, [], "the live anchor keeps it; the junk anchor is ignored");
	assert.deepEqual(planReveals({
		tree: revealedTree(), activeId: 7, preservedActiveId: 99,
		reveals: new Map([[1, { openedSeen: true, }]]),
	}).prune, [1], "no anchor under the owner: pruned");
});

// ---------------------------------------------------------------------------
// extreme placements ("Place leftmost" / "Place rightmost")

test("a mid-shelf member moves left before the first member", () => {
	const tree = [node(1, [], [node(2), node(3), node(4), node(5)])];
	assert.deepEqual(planExtremePlacementMove({
		members: [2, 3, 4], tabId: 3, side: "left", sizes: subtreeSizes(tree),
	}), { tabId: 3, kind: "move-before", referenceTabId: 2 });
});

test("a mid-shelf member moves right after the last member", () => {
	const tree = [node(1, [], [node(2), node(3), node(4), node(5)])];
	assert.deepEqual(planExtremePlacementMove({
		members: [2, 3, 4], tabId: 3, side: "right", sizes: subtreeSizes(tree),
	}), { tabId: 3, kind: "move-after", referenceTabId: 4, thenOutdent: false });
});

test("the rightward move outdents past a last member with descendants", () => {
	// A <- (B, C, D <- (d1)); "Place rightmost" on C references D; landing
	// after it would re-parent C as D's child, so the plan adds an outdent
	const tree = [node(1, [], [node(2), node(3), node(4, [], [node(5)])])];
	assert.deepEqual(planExtremePlacementMove({
		members: [2, 3, 4], tabId: 3, side: "right", sizes: subtreeSizes(tree),
	}), { tabId: 3, kind: "move-after", referenceTabId: 4, thenOutdent: true });
});

test("an already-extreme member plans no move", () => {
	const sizes = subtreeSizes([node(1, [], [node(2), node(3), node(4)])]);
	assert.equal(planExtremePlacementMove({ members: [2, 3, 4], tabId: 2, side: "left", sizes, }), null);
	assert.equal(planExtremePlacementMove({ members: [2, 3, 4], tabId: 4, side: "right", sizes, }), null);
});

test("a single-member shelf plans no move at either end", () => {
	const sizes = subtreeSizes([node(1, [], [node(2)])]);
	assert.equal(planExtremePlacementMove({ members: [2], tabId: 2, side: "left", sizes, }), null);
	assert.equal(planExtremePlacementMove({ members: [2], tabId: 2, side: "right", sizes, }), null);
});

test("a tab that is not a member of the block plans no move", () => {
	assert.equal(planExtremePlacementMove({ members: [2, 3], tabId: 99, side: "left", sizes: new Map, }), null);
});

test("the reference stays inside the member block (the re-parent trap)", () => {
	// the block B, C sits under A with a plain sibling X after it: a right
	// move must reference C (the last MEMBER), never X — move-after X
	// would carry the subtree out of the block
	const tree = [node(1, [], [node(2), node(3), node(4)])];
	const plan = planExtremePlacementMove({
		members: [2, 3], tabId: 2, side: "right", sizes: subtreeSizes(tree),
	});
	assert.equal(plan.referenceTabId, 3, "the last member of the block, not the sibling after it");
	assert.equal(plan.thenOutdent, false);
});

// ---------------------------------------------------------------------------
// hint codes (tab-hints capability)

test("short alphabet for a small visible set, unique codes", () => {
	const map = assignHints([2, 3, 4], HINT_CHARSET);
	assert.deepEqual([...map.values()], ["a", "c", "q"]);
	assert.equal(new Set(map.values()).size, map.size, "codes are unique");
	assert.equal(map.get(3).length, 1, "single letters while the set fits the alphabet");
});

test("codes follow the caller's (rendered) order", () => {
	const map = assignHints([9, 4, 7], "abcd");
	assert.deepEqual([...map.keys()], [9, 4, 7], "input order, not id order");
});

test("the length grows only when the count demands it", () => {
	// the boundary math needs a 26-letter alphabet stated EXPLICITLY —
	// the default charset is the six Vimium-safe letters now
	const alphabet = "abcdefghijklmnopqrstuvwxyz";
	assert.equal(assignHints(Array.from({ length: 26 }, (_, i) => i), alphabet).get(0).length, 1);
	assert.equal(assignHints(Array.from({ length: 27 }, (_, i) => i), alphabet).get(0).length, 2);
	assert.equal(assignHints(Array.from({ length: 676 }, (_, i) => i), alphabet).get(0).length, 2);
	assert.equal(assignHints(Array.from({ length: 677 }, (_, i) => i), alphabet).get(0).length, 3);
});

test("the default charset is safe against Vimium's default keymap", () => {
	// the lowercase letters that START a mapping in Vimium's
	// background_scripts/commands.js defaultKeyMappings (measured in
	// ~/repos/firefox/vimium): Vimium listens on window with
	// capture:true and consumes mapped keys with
	// stopImmediatePropagation, so a code letter from this set is
	// eaten before our document-level catcher can ever see it
	const vimiumFirstLetters = "jkhl gz dur y p iv f n o b t x m".split(/\s*/).join("");
	for (const letter of HINT_CHARSET.split("")) {
		assert.equal(vimiumFirstLetters.includes(letter), false,
			`"${letter}" starts a default Vimium mapping and cannot be a code letter`);
	}
	assert.equal(HINT_CHARSET.length >= 2, true, "an alphabet, not a single letter");
});

test("normalizeHintCharset dedupes, lower-cases, and rejects too-short input", () => {
	assert.equal(normalizeHintCharset("Qq Aa, c!"), "qac");
	assert.equal(normalizeHintCharset("AcQSEW"), "acqsew", "upper-case input normalizes to the default set");
	assert.equal(normalizeHintCharset("aa"), "", "one distinct character is not an alphabet — the caller keeps the default");
	assert.equal(normalizeHintCharset(""), "");
	assert.equal(normalizeHintCharset(null), "");
	assert.equal(normalizeHintCharset("a1 2b"), "a12b", "digits are allowed in a custom charset");
});

test("normalizeHintFontSize clamps to the chip band and falls back on junk", () => {
	assert.equal(normalizeHintFontSize(12), 12);
	assert.equal(normalizeHintFontSize("13"), 13, "the options field stores a string");
	assert.equal(normalizeHintFontSize(14.9), 15, "rounded into the band");
	assert.equal(normalizeHintFontSize(9), 12, "below the band falls back to the default");
	assert.equal(normalizeHintFontSize(19), 12, "above the band falls back to the default");
	assert.equal(normalizeHintFontSize("nine"), 12);
	assert.equal(normalizeHintFontSize(null), 12);
	assert.equal(normalizeHintFontSize(undefined), 12);
	assert.equal(normalizeHintFontSize("9", 11), 11, "the fallback is the caller's");
});

test("isSpecialPageUrl marks exactly the uninjectable schemes", () => {
	// MDN tabs.executeScript: top-level about: frames and extension
	// pages reject the injection; http/https/file are the matchable
	// schemes (anything else is ATTEMPTED and the arm failure logged)
	assert.equal(isSpecialPageUrl("about:blank"), true);
	assert.equal(isSpecialPageUrl("about:newtab"), true);
	assert.equal(isSpecialPageUrl("about:reader?url=https%3A%2F%2Fexample.com%2F"), true);
	assert.equal(isSpecialPageUrl("moz-extension://8f0261c6-33f8-4b47-b10a-e887e54570e4/resources/group-tab.html?title=Token+Engineering"), true);
	assert.equal(isSpecialPageUrl("chrome://browser/content/browser.xhtml"), true);
	assert.equal(isSpecialPageUrl("resource://pdf.js/web/viewer.html"), true);
	assert.equal(isSpecialPageUrl("view-source:https://example.com/"), true);
	assert.equal(isSpecialPageUrl("https://example.com/"), false);
	assert.equal(isSpecialPageUrl("http://127.0.0.1:47631/a.html"), false);
	assert.equal(isSpecialPageUrl("file:///home/dev/notes/index.html"), false);
	assert.equal(isSpecialPageUrl("data:text/html,hello"), false, "attempted: not a match pattern, but not a known-forbidden scheme either");
	assert.equal(isSpecialPageUrl(""), true, "no URL at all is not an injectable page");
	assert.equal(isSpecialPageUrl(undefined), true);
});

test("a 700-tab window still gets unique, prefix-safe codes", () => {
	const map = assignHints(Array.from({ length: 700 }, (_, i) => i + 1));
	assert.equal(new Set(map.values()).size, 700, "unique");
	// a fixed length makes the prefix rule decidable by construction
	const lengths = new Set([...map.values()].map(code => code.length));
	assert.equal(lengths.size, 1, "all codes share one length, so none is a bare prefix of another");
});

test("reassignment: a different visible set produces fresh codes, deterministically", () => {
	const first = assignHints([5, 6, 7]);
	const again = assignHints([5, 6, 7]);
	assert.deepEqual([...first.entries()], [...again.entries()], "pure and deterministic");
	const grown = assignHints([5, 6, 7, 8]);
	assert.deepEqual(grown.get(5), first.get(5), "the stable prefix of the set keeps its codes");
});

test("hintMatches narrows by case-folded prefix", () => {
	const codes = assignHints([1, 2, 3]);
	assert.deepEqual(hintMatches(codes, "c"), [[2, "c"]]);
	assert.deepEqual(hintMatches(codes, "C"), [], "the caller lower-cases; mixed case dies");
	assert.deepEqual(hintMatches(codes, ""), [], "an empty buffer matches nothing (activation needs a letter)");
});

test("hintMatches keeps an empty match clean instead of a false activate", () => {
	const codes = new Map([[1, "ad"], [2, "bc"]]);
	assert.deepEqual(hintMatches(codes, "a"), [[1, "ad"]]);
	assert.deepEqual(hintMatches(codes, "z"), []);
});

// ---------------------------------------------------------------------------
// the coded set: painted surfaces only (planHintTargets)

test("planHintTargets codes exactly the painted surfaces (warm ledger)", () => {
	// tree: 1 = an owner, FOLDED, with member 2 (hidden by us) and plain
	// child 3; 4 = a plain row; 5 = a root-shelf member (hidden by us);
	// 6 = a plain row OUTSIDE the viewport
	const tree = [
		node(1, ["subtree-collapsed"], [node(2), node(3)]),
		node(4, [], []),
		node(5),
		node(6),
	];
	const tabsById = new Map([
		[1, { id: 1, }],
		[2, { id: 2, hidden: true, }],
		[3, { id: 3, }],
		[4, { id: 4, }],
		[5, { id: 5, hidden: true, }],
		[6, { id: 6, }],
	]);
	const shelved = new Set([2, 5]);
	const hiddenByUs = new Set([2, 5]);
	const shelfOf = new Map([[2, 1], [5, null]]); // 2 on owner 1's shelf, 5 on the root shelf
	const out = planHintTargets({
		tree, tabsById, shelfOf, shelved, hiddenByUs,
		suppressedHiddenByUs: new Set, rendered: new Set([1, 4]),
		excludeSpecial: false,
	});
	// rows: 4 only (1 is coded as a row? NO — 1 is an owner with a PLAIN
	// row too — owners are row tabs!  3 is folded away, 6 is off-screen)
	assert.deepEqual(out.rowIds, [1, 4], "rendered rows only: the folded child and the off-viewport row carry no code");
	// members: 2 (its strap paints on owner 1's rendered row, folded or
	// not — the icons are the fold's presentation) and 5 (the root strap
	// rides #tabbar-top, always painted)
	assert.deepEqual(out.memberIds, [2, 5], "a member's code rides its painted strap, not its row");
	// ordered: walk order 1, 2, 4, 5
	assert.deepEqual(out.orderedIds, [1, 2, 4, 5]);
});

test("a cold ledger keeps codes for every non-folded visible tab (the 0.3.3 trap stays shut)", () => {
	const tree = [
		node(1, ["subtree-collapsed"], [node(3)]),
		node(4),
	];
	const tabsById = new Map([[1, { id: 1, }], [3, { id: 3, }], [4, { id: 4, }]]);
	const out = planHintTargets({
		tree, tabsById, shelfOf: new Map, shelved: new Set, hiddenByUs: new Set,
		suppressedHiddenByUs: new Set, rendered: null, excludeSpecial: false,
	});
	assert.deepEqual(out.rowIds, [1, 4], "cold: the viewport cut is skipped (labels paint wherever rows are)");
	assert.equal(out.rowIds.includes(3), false, "the fold cut comes from the tree and survives the cold case");
	// an EMPTY ledger is cold too (a window whose rows all unrendered)
	assert.deepEqual(planHintTargets({
		tree, tabsById, shelfOf: new Map, shelved: new Set, hiddenByUs: new Set,
		suppressedHiddenByUs: new Set, rendered: new Set, excludeSpecial: false,
	}).rowIds, [1, 4]);
});

test("a nested member is coded only while its owner's row is painted (a reveal)", () => {
	// C (2) is a member of A's shelf and the owner of c1 (7); c1's strap
	// rides C's row, which exists only during a reveal
	const tree = [node(1, [], [node(2, [], [node(7)])])];
	const tabsById = new Map([
		[1, { id: 1, }], [2, { id: 2, hidden: true, }], [7, { id: 7, hidden: true, }],
	]);
	const shelved = new Set([2, 7]);
	const hiddenByUs = new Set([2, 7]);
	const shelfOf = new Map([[2, 1], [7, 2]]);
	const base = { tree, tabsById, shelfOf, shelved, hiddenByUs, suppressedHiddenByUs: new Set, excludeSpecial: false, };
	// no reveal: owner 2 has no row, so the nested strap paints nowhere
	assert.deepEqual(planHintTargets({ ...base, rendered: new Set([1]), }).memberIds, [2],
		"the nested member carries no code without a reveal (its strap has no row)");
	// the reveal paints owner 2's row: c1's strap paints with it
	assert.deepEqual(planHintTargets({ ...base, rendered: new Set([1, 2]), }).memberIds, [2, 7]);
});

test("member icon rules and the special-page exclusion gate the codes", () => {
	const tree = [node(1, [], [node(2), node(3), node(4), node(5)])];
	const tabsById = new Map([
		[1, { id: 1, url: "https://a.example/", }],
		[2, { id: 2, hidden: true, url: "https://a.example/", }],          // hidden by someone else: no icon
		[3, { id: 3, hidden: true, url: "https://a.example/", }],          // reveal-suppressed: no icon
		[4, { id: 4, hidden: true, url: "about:blank", }], // special page: excluded
		[5, { id: 5, hidden: true, url: "https://a.example/", }],
	]);
	const shelved = new Set([2, 3, 4, 5]);
	const hiddenByUs = new Set([4, 5]);
	const suppressedHiddenByUs = new Set([3]);
	const shelfOf = new Map([[2, 1], [3, 1], [4, 1], [5, 1]]);
	const out = planHintTargets({
		tree, tabsById, shelfOf, shelved, hiddenByUs, suppressedHiddenByUs,
		rendered: new Set([1]), excludeSpecial: true,
	});
	assert.deepEqual(out.memberIds, [5], "only the eligible icon survives: foreign-hidden, suppressed and special members carry no code");
	// with the exclusion OFF the special-page member is coded like any other
	assert.deepEqual(planHintTargets({
		tree, tabsById, shelfOf, shelved, hiddenByUs, suppressedHiddenByUs,
		rendered: new Set([1]), excludeSpecial: false,
	}).memberIds, [4, 5]);
	// a member the derivation gives no shelf (no icon anywhere) carries no code
	assert.deepEqual(planHintTargets({
		tree, tabsById, shelfOf: new Map, shelved, hiddenByUs, suppressedHiddenByUs,
		rendered: new Set([1]), excludeSpecial: false,
	}).memberIds, []);
});

test("pinned tabs and tabs missing from the query carry no code", () => {
	const tree = [node(1, [], [node(2)]), node(3)];
	const tabsById = new Map([[1, { id: 1, pinned: true, }], [3, { id: 3, }]]);
	const out = planHintTargets({
		tree, tabsById, shelfOf: new Map, shelved: new Set, hiddenByUs: new Set,
		suppressedHiddenByUs: new Set, rendered: new Set([1, 2, 3]), excludeSpecial: false,
	});
	assert.deepEqual(out.rowIds, [3], "pinned rows and absent tab records are never coded");
});
