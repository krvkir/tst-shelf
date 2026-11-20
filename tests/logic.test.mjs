/**
 * Spec-derived unit tests for src/background/logic.esm.js (node --test).
 * Run: make test
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	derive, indexTree, isFolded, straysToCollapse, ownersAffectedByActivation,
	ROOT_SHELF,
} from "../src/background/logic.esm.js";

/** Light-tree node helper. */
const node = (id, states = [], children = []) => ({ id, states, children });

/** tabs.Tab stand-ins keyed by id. */
const tabsById = (tabs) => new Map(tabs.map(tab => [tab.id, {
	index: 0, hidden: false, active: false, pinned: false, ...tab,
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

test("an empty shelf (all members hidden) reserves no owner", () => {
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
	const { selectedOfShelf, ghostIds, badgeIds } = derive({ tree, shelved, tabsById: tabsById([
		{ id: 1, index: 0 }, { id: 2, index: 1 }, { id: 4, index: 2 }, { id: 5, index: 3 }, { id: 6, index: 4 },
	]) });
	assert.equal(selectedOfShelf.get(1), 4, "the unfolded member is selected");
	assert.equal(badgeIds.has(2), true, "folded member carries the plus badge");
	assert.equal(badgeIds.has(4), false, "unfolded member carries none");
	assert.equal(ghostIds.has(4), false, "no ghost without an own nested shelf");
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

test("ghost row appears for a selected shelved tab owning a nested shelf", () => {
	// 1 owns a shelf with {2}; 2 (shelved, selected) owns a nested shelf with {3}
	const tree = [node(1, [], [node(2, [], [node(3, [], [node(4)])])])];
	const shelved = new Set([2, 3]);
	const { selectedOfShelf, ghostIds, shelves } = derive({ tree, shelved, tabsById: tabsById([
		{ id: 1, index: 0 }, { id: 2, index: 1 }, { id: 3, index: 2 }, { id: 4, index: 3 },
	]) });
	assert.equal(selectedOfShelf.get(1), 2);
	assert.equal(shelves.get(2).includes(3), true, "3 is shelved on 2's nested shelf");
	assert.equal(ghostIds.has(2), true, "selected shelved tab with own members ghosts");
	assert.equal(ghostIds.has(3), false);
});

test("no ghost while the nested shelf owner is folded", () => {
	const tree = [node(1, [], [node(2, ["subtree-collapsed"], [node(3, [], [node(4)])])])];
	const shelved = new Set([2, 3]);
	const { selectedOfShelf, ghostIds } = derive({ tree, shelved, tabsById: tabsById([
		{ id: 1, index: 0 }, { id: 2, index: 1 }, { id: 3, index: 2 }, { id: 4, index: 3 },
	]) });
	assert.equal(selectedOfShelf.get(1), undefined, "nothing unfolded on shelf 1");
	assert.equal(ghostIds.has(2), false, "folded owner keeps its row hidden");
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
