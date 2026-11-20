/**
 * Pure derivation for tst-shelf: everything here is a function of its
 * inputs, no browser.*, no TST calls — unit tested in
 * tests/logic.test.mjs.  The background re-derives the whole world from
 * these after every tree mutation (design Decision 1: the only stored
 * state is a sticky per-tab flag; the target shelf is always derived).
 *
 * Inputs:
 *   tree      — TST light tree: array of root nodes
 *               { id, states: string[], children: node[] }
 *   shelved   — Set<number> of tab ids with the sticky flag
 *   tabsById  — Map<id, browser.tabs.Tab> (index, hidden, active, pinned…)
 *
 * Terminology (openspec/openspec/project.md):
 *   shelf owner — the tab whose row hosts a strap; the root shelf is
 *                 owned by the tab bar itself (owner id null).
 *   selected shelf tab — the member whose subtree is unfolded; folding
 *                 happens only when another tab of the same shelf is
 *                 selected.
 */

export const ROOT_SHELF = null;

/** One walk of the light tree: parent map, child counts, fold states. */
export function indexTree (tree) {
	const parentIdOf = new Map;   // id -> parent id (null for roots)
	const hasChildIds = new Set;  // ids with >=1 child
	const foldedIds = new Set;    // ids with 'subtree-collapsed' state
	const statesById = new Map;
	(function walk (nodes, parentId) {
		for (const node of nodes || []) {
			parentIdOf.set(node.id, parentId);
			statesById.set(node.id, node.states || []);
			if (isFolded(node.states)) { foldedIds.add(node.id); }
			if (node.children && node.children.length) {
				hasChildIds.add(node.id);
				walk(node.children, node.id);
			}
		}
	})(tree, null);
	return { parentIdOf, hasChildIds, foldedIds, statesById };
}

/** Light-tree nodes carry TST's "safe" states; folded = subtree-collapsed. */
export function isFolded (states) {
	return Array.isArray(states) && states.includes('subtree-collapsed');
}

/**
 * The full derivation of one window.
 * @returns {{
 *   parentIdOf: Map<number, number|null>,
 *   shelves: Map<number|null, number[]>,  // owner -> visible members, tab order
 *   shelfOf: Map<number, number|null>,    // member -> its shelf owner
 *   ownerIds: Set<number>,                 // owners with >=1 visible member
 *   selectedOfShelf: Map<number|null, number|null>,
 *   ghostIds: Set<number>,
 *   badgeIds: Set<number>,
 *   highlightIds: Set<number>,
 *   shelvedVisible: number[],
 * }}
 */
export function derive ({ tree, shelved, tabsById, }) {
	const { parentIdOf, hasChildIds, foldedIds, } = indexTree(tree);

	const tabOf = id => tabsById.get(id) || { id, hidden: true, active: false, index: Number.MAX_SAFE_INTEGER, };
	const visible = id => {
		const tab = tabOf(id);
		return !tab.pinned && !tab.hidden;
	};

	// shelves: group every VISIBLE shelved tab under its derived owner
	// (parent tab, or ROOT_SHELF for root tabs), in native tab order.
	const shelves = new Map;
	const shelfOf = new Map;
	const shelvedVisible = [];
	for (const id of shelved) {
		if (!parentIdOf.has(id) || !visible(id)) { continue; }
		const owner = parentIdOf.get(id);
		shelfOf.set(id, owner);
		shelvedVisible.push(id);
		const members = shelves.get(owner) || [];
		members.push(id);
		shelves.set(owner, members);
	}
	const byIndex = (a, b) => tabOf(a).index - tabOf(b).index;
	for (const [owner, members] of shelves) {
		members.sort(byIndex);
		shelves.set(owner, members);
	}
	shelvedVisible.sort(byIndex);

	const ownerIds = new Set(shelves.keys());

	// selected shelf tab: the member with children whose subtree is
	// unfolded.  Ties (transient, e.g. after session restore) prefer the
	// active member, then tab order; the background collapses strays.
	const selectedOfShelf = new Map;
	for (const [owner, members] of shelves) {
		const expandedMembers = members.filter(id => hasChildIds.has(id) && !foldedIds.has(id));
		if (expandedMembers.length == 0) { continue; }
		const active = expandedMembers.find(id => tabOf(id).active);
		selectedOfShelf.set(owner, active ?? expandedMembers[0]);
	}

	// ghost row: a selected shelved tab anchoring its own nested shelf —
	// its row must stay in the flow to host the strap, caption hidden.
	const ghostIds = new Set;
	for (const selected of selectedOfShelf.values()) {
		if (selected != null && ownerIds.has(selected)) {
			ghostIds.add(selected);
		}
	}

	// plus badge: children are folded (spec: the badge disappears while
	// unfolded; childless shelved tabs carry no badge).
	const badgeIds = new Set;
	for (const id of shelvedVisible) {
		if (hasChildIds.has(id) && foldedIds.has(id)) {
			badgeIds.add(id);
		}
	}

	// active highlight: the active tab itself, and every shelved ancestor
	// of it (a shelved tab with an active descendant is highlighted).
	const highlightIds = new Set;
	const activeId = [...tabsById.values()].find(tab => tab.active && !tab.hidden)?.id ?? null;
	if (activeId != null && parentIdOf.has(activeId)) {
		if (shelved.has(activeId)) { highlightIds.add(activeId); }
		let ancestor = parentIdOf.get(activeId);
		while (ancestor != null) {
			if (shelved.has(ancestor)) { highlightIds.add(ancestor); }
			ancestor = parentIdOf.get(ancestor);
		}
	}

	return {
		parentIdOf,
		shelves,
		shelfOf,
		ownerIds,
		selectedOfShelf,
		ghostIds,
		badgeIds,
		highlightIds,
		shelvedVisible,
	};
}

/**
 * Boot reconciliation (spec shelf-nesting): at most one selected tab per
 * shelf.  Returns the member ids to collapse — every member that has an
 * unfolded subtree but is not its shelf's selection.
 * @returns {number[]}
 */
export function straysToCollapse ({ tree, shelves, selectedOfShelf, }) {
	const { hasChildIds, foldedIds, } = indexTree(tree);
	const toCollapse = [];
	for (const [owner, members] of shelves) {
		const keep = selectedOfShelf.get(owner);
		for (const member of members) {
			if (member != keep && hasChildIds.has(member) && !foldedIds.has(member)) {
				toCollapse.push(member);
			}
		}
	}
	return toCollapse;
}

/**
 * Which shelves must re-render after an activation: the shelves along
 * the owner chains of the previous and the new active tab (badge and
 * highlight changes live there).  Pure helper for the interaction layer.
 * @returns {Array<number|null>} owner ids (ROOT_SHELF for root shelves)
 */
export function ownersAffectedByActivation ({ fromId, toId, parentIdOf }) {
	const owners = new Set;
	for (const id of [fromId, toId]) {
		let node = id;
		while (node != null && node != undefined) {
			owners.add(parentIdOf.get(node) ?? ROOT_SHELF);
			node = parentIdOf.get(node);
		}
	}
	return [...owners];
}
