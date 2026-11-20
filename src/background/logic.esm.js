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
 *   hiddenByUs — Set<number> of tab ids THIS addon hid (browser.tabs.hide)
 *               to take their rows out of TST's flow.  The distinction
 *               matters: a tab hidden by us still gets a shelf icon (we
 *               hid it precisely because it lives on a shelf), while a
 *               tab hidden by ANOTHER addon (tst-workspace container
 *               filtering) must not appear at all.
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
 * Favicon stickiness: the shelf icon keeps the last known favicon while
 * the tab is loading.  Firefox reports no favIconUrl for a navigating or
 * reloading tab, so a fresh tabs.query carries none — and a naive
 * re-render blanks the icon until the new page announces its own.
 * TST's own rows never blank: the background only propagates a favicon
 * change when the changeInfo explicitly carries favIconUrl, never on
 * status flips (tabs-update.js), and a row element never lets a null
 * overwrite its remembered value (`this.favIconUrl =
 * this._favIconUrl ||= this.raw?.favIconUrl`).  This mirrors that with
 * a per-session memory threaded through every query: tabs that have a
 * favicon update the memory, tabs that do not render the remembered
 * one.  Pure — returns patched tab records (shallow copies, favIconUrl
 * filled in) plus the updated memory.
 */
export function resolveFavicons (tabs, memory) {
	const next = new Map(memory);
	const patched = tabs.map(tab => {
		if (tab.favIconUrl) { next.set(tab.id, tab.favIconUrl); return tab; }
		const remembered = next.get(tab.id);
		return remembered ? { ...tab, favIconUrl: remembered, } : tab;
	});
	return { tabs: patched, memory: next, };
}

/**
 * The full derivation of one window.
 * @returns {{
 *   parentIdOf: Map<number, number|null>,
 *   shelves: Map<number|null, number[]>,  // owner -> visible members, tab order
 *   shelfOf: Map<number, number|null>,    // member -> its shelf owner
 *   ownerIds: Set<number>,                 // owners with >=1 visible member
 *   selectedOfShelf: Map<number|null, number|null>,
 *   badgeIds: Set<number>,
 *   highlightIds: Set<number>,
 *   shelvedVisible: number[],
 * }}
 */
export function derive ({ tree, shelved, tabsById, hiddenByUs = new Set, }) {
	const { parentIdOf, hasChildIds, foldedIds, } = indexTree(tree);
	// Member order = the TREE WALK order (treePositions), the order the
	// TST sidebar renders rows in.  Physical browser.tabs indices lag
	// every move by TST's deferred sync (tabs-move.js, ~250 ms), and the
	// strap must agree with the rendered rows, not with the stale strip.
	const positions = treePositions(tree);

	const tabOf = id => tabsById.get(id) || { id, hidden: true, active: false, index: Number.MAX_SAFE_INTEGER, };
	const visible = id => {
		const tab = tabOf(id);
		if (tab.pinned) { return false; }
		// hidden by us: the row is gone on purpose, the icon stays;
		// hidden by someone else (tst-workspace filtering): no icon.
		return !tab.hidden || hiddenByUs.has(id);
	};

	// shelves: group every VISIBLE shelved tab under its derived owner
	// (parent tab, or ROOT_SHELF for root tabs), in rendered order.
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
	const byPosition = (a, b) => (positions.get(a) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b) ?? Number.MAX_SAFE_INTEGER);
	for (const [owner, members] of shelves) {
		members.sort(byPosition);
		shelves.set(owner, members);
	}
	shelvedVisible.sort(byPosition);

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

	// The strap targets the OWNER row (0.1.4): the shelf sits inside the
	// owner's own line, beside the caption (style.esm.js rule 2), and
	// members keep no row at all — they are hidden tabs.  Nothing to
	// compute here: `render.esm.js` sends the strap to the owner.

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
		badgeIds,
		highlightIds,
		shelvedVisible,
	};
}

/**
 * The tabs that must keep their rows whatever else the extension does.
 *
 * Three facts force this list.  (1) Firefox reveals a hidden tab when it
 * becomes the active tab and refuses to hide the active tab again, so
 * the active tab always paints a row.  (2) A hidden tab's descendants
 * are not rendered at all, so hiding an ANCESTOR of the active tab would
 * take the active tab's own row away — and for a shelf of shelves it
 * would also take the nested shelf's strap away, because that strap
 * lives in its owner's row.  (3) TST animates collapse/expand for
 * `configs.collapseDuration` (150 ms) *before* it removes the rows, so a
 * parent whose children are mid-animation must keep its row too, or the
 * animating children are orphaned (parent row gone, children still
 * painted) — the visible "jump" when switching between shelf tabs.
 *
 * So: the active tab, every tab in a collapse/expand animation, and all
 * their ancestors.
 *
 * @returns {Set<number>} ids that must stay visible
 */
export function mustShowTabs ({ tree, activeId, animationStates = ["collapsing", "expanding"], }) {
	const { parentIdOf, statesById, } = indexTree(tree);
	const must = new Set;
	const protect = id => {
		let node = id;
		while (node != null && node != undefined && !must.has(node)) {
			must.add(node);
			node = parentIdOf.get(node) ?? null;
		}
	};
	if (activeId != null) { protect(activeId); }
	for (const [id, states] of statesById) {
		if (animationStates.some(state => states.includes(state))) { protect(id); }
	}
	return must;
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

/**
 * Subtree sizes of the light tree (member row + all descendants).
 * @returns {Map<number, number>} id -> node count of its subtree
 */
export function subtreeSizes (tree) {
	const sizes = new Map;
	(function walk (nodes) {
		let total = 0;
		for (const node of nodes || []) {
			const size = 1 + walk(node.children || []);
			sizes.set(node.id, size);
			total += size;
		}
		return total;
	})(tree);
	return sizes;
}

/**
 * Pre-order walk positions of the light tree: TST's INTERNAL tab order.
 * TST updates this order synchronously inside move-before/move-after,
 * while the PHYSICAL strip (browser.tabs.query indices) catches up only
 * after the deferred sync (tabs-move.js syncToNativeTabs — a 250 ms
 * debounce per window).  Placement planning MUST run in this internal
 * space: planning against physical indices spins on stale snapshots
 * until the debounce lands (the move-storm bug, design.md).
 * @returns {Map<number, number>} id -> walk position
 */
export function treePositions (tree) {
	const positions = new Map;
	(function walk (nodes) {
		for (const node of nodes || []) {
			positions.set(node.id, positions.size);
			walk(node.children);
		}
	})(tree);
	return positions;
}

/**
 * The single next move that makes every shelf's members contiguous
 * directly under their owner, newest member last (spec shelf-pinning:
 * a tab put on the shelf becomes the rightmost icon).  Non-member tabs
 * never change their relative order.
 *
 * Members are contiguous so that the SELECTED member's subtree — the
 * only rows a shelf shows — always renders directly below the owner
 * row: every row between the owner and it belongs to a hidden member
 * and therefore paints nothing (0.1.4; the members themselves have no
 * rows at all, so the icon order can follow plain tab order and icons
 * no longer jump when the selection changes).
 *
 * Ranks are positions in TST's INTERNAL order (treePositions), not
 * physical strip indices.  Returns ONE move per call — positions shift
 * with every applied move, so the caller re-derives between
 * applications (bounded, per-window-serialized fixpoint loop).
 *
 * Move kinds (applied via TST's move-before/move-after/outdent with
 * followChildren: TST moves the member's whole subtree and re-derives
 * the member's parent from the position; the references below are
 * chosen so that parent is provably the shelf owner):
 *   {tabId, kind: 'move-before', referenceTabId} — insert before the
 *     tab currently occupying the expected slot;
 *   {tabId, kind: 'move-after', referenceTabId, thenOutdent} — the
 *     expected slot is past the end: after the previous member, with
 *     an outdent when that member has descendants (positioning after
 *     its subtree).  Defensive: unreachable under TST's contiguity
 *     invariants with a dense strip, kept as a failsafe.
 *
 * `appendOrder` (Map tabId -> sequence) forces the members that carry a
 * sequence to the END of their shelf, in that sequence's order: it is the
 * PUT order (a newly shelved tab becomes the rightmost icon).  A plain
 * `appendTabId` slot could not express this — two puts in quick
 * succession overwrote each other and the first one silently kept its
 * old slot (caught by the E2E: `[B, C, F]` instead of `[C, B, F]`).
 * Members without a sequence keep their rank order and come first, so a
 * drag that re-parents a tab still decides its place.
 * @returns {null|{tabId: number, kind: string, referenceTabId: number, thenOutdent?: boolean}}
 */
export function nextPlacementMove ({ ranks, sizes, shelves, appendOrder = null, }) {
	const sorted = [...ranks].sort((a, b) => a.pos - b.pos);
	const rankOf = new Map(sorted.map(rank => [rank.id, rank]));
	const rankAt = pos => sorted.find(rank => rank.pos === pos) || null;
	for (const [owner, members] of shelves) {
		const seqOf = id => (appendOrder && appendOrder.has(id)) ? appendOrder.get(id) : null;
		const ordered = members
			.filter(id => rankOf.has(id) && !rankOf.get(id).pinned)
			.sort((a, b) => {
				const aSeq = seqOf(a);
				const bSeq = seqOf(b);
				if (aSeq != null && bSeq != null) { return aSeq - bSeq; }
				if (aSeq != null) { return 1; }
				if (bSeq != null) { return -1; }
				return rankOf.get(a).pos - rankOf.get(b).pos;
			});
		const ownerRank = owner === ROOT_SHELF ? null : rankOf.get(owner);
		if (owner !== ROOT_SHELF && !ownerRank) { continue; }
		let expected = owner === ROOT_SHELF ? firstNormalPos(sorted) : ownerRank.pos + 1;
		let prev = null;
		for (const id of ordered) {
			const rank = rankOf.get(id);
			if (rank.pos === expected) {
				expected += sizes.get(id) ?? 1;
				prev = id;
				continue;
			}
			const ref = rankAt(expected);
			if (ref) { return { tabId: id, kind: "move-before", referenceTabId: ref.id, }; }
			// past the end: append after the previous member; when it has
			// descendants, move-after parents us to it — outdent then
			// re-attaches to the owner after its subtree.
			if (prev != null) {
				return {
					tabId: id,
					kind: "move-after",
					referenceTabId: prev,
					thenOutdent: (sizes.get(prev) ?? 1) > 1,
				};
			}
			return null; // no reference exists; nothing safe to do here
		}
	}
	return null;
}

/** Walk position of the first non-pinned rank (the root block's top). */
function firstNormalPos (sortedRanks) {
	for (const rank of sortedRanks) {
		if (!rank.pinned) { return rank.pos; }
	}
	return 0;
}
