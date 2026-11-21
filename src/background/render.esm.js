/**
 * Strap rendering for tst-shelf: pure HTML builders plus a diffing
 * "renderer" object that talks to TST through an injected `send`.
 *
 * Why HTML strings: TST's set-extra-contents sanitizes them with
 * DOMPurify (ALLOWED_TAGS), then appends this addon's part name to every
 * `part` attribute and rewrites only href/src/srcset of non-local URLs
 * (sidebar/tst-api-frontend.js setExtraContentsToContainer).  The
 * `style` attribute survives sanitization — favicons ride inside it as
 * background-image, without host permissions.
 *
 * Where the strap lives (0.1.4): on the OWNER's `tab-below` extra
 * contents.  It is NOT a second line under the caption — the sidebar
 * stylesheet turns the owner row's .ui into a row flex, so the strap
 * becomes a flex item BESIDE the caption (style.esm.js rule 2) and the
 * row keeps its default height (TST's uniform-row law).  Members keep
 * no row at all: they are hidden tabs (index.esm.js).
 *
 * Icon markup contract (all attributes verified against TST 4.4.10):
 *   data-tab-id      → TST routes right-clicks on the element to that
 *                      tab's native context menu (closest('[data-tab-id]')
 *                      → browser.menus.overrideContext), so the icon
 *                      menu is the tab's own menu for free.
 *   data-drag-data   → TST reads dataset.dragData at dragstart
 *                      (sidebar/drag-and-drop.js onDragStart) and runs
 *                      its NATIVE tab drag: asTree makes the whole
 *                      subtree follow; drop semantics stay TST's.
 *   draggable        → native HTML drag source.  The icon must NOT be
 *                      a <button>: TST cancels drags started on
 *                      button/select/scrollbar targets
 *                      (EventUtils.isEventFiredOnClickable).
 *   title            → the popup box with site name and URL.
 */

import { ROOT_SHELF } from "./logic.esm.js";

export function escapeHtml (text) {
	return String(text ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function escapeAttributeValue (text) {
	return escapeHtml(text); // same escapes, kept separate for readability of callers
}

/** The favicon style attribute: survives DOMPurify and TST's URL pass. */
export function faviconStyleOf (tab) {
	if (!tab.favIconUrl) { return ""; }
	return ` style="background-image: url(&quot;${escapeAttributeValue(tab.favIconUrl)}&quot;)"`;
}

/** One shelf icon (a favicon cell). */
export function iconHtml ({ tab, active, folded, }) {
	const parts = ["shelf-icon"];
	if (active) { parts.push("tst-shelf-icon-active"); }
	const badgeParts = folded ? ["shelf-badge", "tst-shelf-badge-on"] : ["shelf-badge"];
	const title = `${tab.title || tab.url || ""}\n${tab.url || ""}`;
	return `<div part="${parts.join(" ")}" data-tab-id="${tab.id}"`
		+ ` draggable="true"`
		+ ` data-drag-data='{"type":"tab","data":{"id":${tab.id},"asTree":true}}'`
		+ ` title="${escapeAttributeValue(title)}"`
		+ faviconStyleOf(tab)
		+ `><span part="${badgeParts.join(" ")}">+</span></div>`;
}

/** The strap of one shelf (its whole extra-contents markup). */
export function strapHtml ({ members, tabsById, highlightIds, badgeIds, }) {
	const icons = members
		.map(id => tabsById.get(id))
		.filter(Boolean)
		.map(tab => iconHtml({
			tab,
			active: highlightIds.has(tab.id),
			folded: badgeIds.has(tab.id),
		}))
		.join("");
	return `<div part="shelf-strap">${icons}</div>`;
}

/**
 * Diffing renderer.  Tracks what TST ACKNOWLEDGED per strap — the markup —
 * and clears the targets that vanished (an empty shelf, a closed owner).  A
 * request that rejects is not recorded, so the next derivation retries it.
 * `send(type, params)` is TST's message route; the caller injects it.
 */
export function createRenderer ({ send, log, }) {
	const renderedStraps = new Map; // `${windowId}:${owner}` -> { owner, contents } | null (cleared)
	const tabStates = new Map;      // tabId -> Set of ACKNOWLEDGED tst-shelf-* states
	/** Re-send every wanted state even if the ledger says it is applied: a
	 *  sidebar that attaches late never saw the earlier broadcasts (TST
	 *  exports only its own safe states to a newly opened sidebar, see
	 *  exportTab in common/TreeItem.js), so its model is missing ours. */
	let forceStateSync = false;
	const strapKey = (windowId, owner) => `${windowId}:${owner ?? "root"}`;

	/** Send one strap and record it only when TST ACKNOWLEDGED it.  The
	 *  ledger is a record of what the sidebar holds, never of what we
	 *  wanted: a rejected request must stay unacknowledged so the next
	 *  derivation sends it again (a ledger written before the reply left
	 *  failed writes marked as applied forever — measured with an injected
	 *  rejection: no second request, the strap simply never appeared). */
	async function writeStrap ({ key, owner, contents, windowId, }) {
		const params = owner === ROOT_SHELF
			? { place: "tabbar-top", windowId, contents, }
			: { place: "tab-below", tab: owner, windowId, contents, };
		try {
			await send("set-extra-contents", params);
			renderedStraps.set(key, contents == null ? null : { owner, contents, });
			return true;
		}
		catch (error) {
			log("strap-send-fail", `${key} ${error && error.message || error}`);
			return false;
		}
	}

	/** Apply one window's derivation: straps first, then state classes. */
	async function applyDerivation ({ windowId, derivation, tabsById, }) {
		const desired = new Map;
		for (const [owner, members] of derivation.shelves) {
			if (!members.length) { continue; }
			desired.set(strapKey(windowId, owner), {
				owner,
				contents: strapHtml({
					members,
					tabsById,
					highlightIds: derivation.highlightIds,
					badgeIds: derivation.badgeIds,
				}),
			});
		}

		const writes = [];
		for (const [key, strap] of desired) {
			const current = renderedStraps.get(key);
			if (current && current.contents === strap.contents) { continue; }
			writes.push(writeStrap({ key, ...strap, windowId, }));
		}
		// straps that vanished entirely (owner left the tree, members gone)
		for (const [key, current] of [...renderedStraps.entries()]) {
			if (key.startsWith(`${windowId}:`) && !desired.has(key) && current) {
				writes.push(writeStrap({ key, owner: current.owner, contents: null, windowId, }));
			}
		}
		await Promise.all(writes);

		await applyTabStates({ windowId, derivation, tabsById, });
	}

	/**
	 * Diff the tst-shelf-* state classes against what TST acknowledged.
	 * Only owners carry a state now: members have no rows at all (hidden
	 * tabs), so there is nothing to style on them — the strap icon IS
	 * their presentation (0.1.4).
	 */
	async function applyTabStates ({ windowId, derivation, tabsById, }) {
		const wanted = new Map; // tabId -> Set of states
		for (const owner of derivation.ownerIds) {
			if (owner === ROOT_SHELF) { continue; }
			wanted.set(owner, new Set(["tst-shelf-owner"]));
		}

		const force = forceStateSync;
		forceStateSync = false;
		// id -> states TST is known to hold; carried forward one
		// acknowledged request at a time (same rule as the strap ledger).
		const planned = new Map;
		const jobs = [];
		for (const [id, states] of wanted) {
			const current = tabStates.get(id) || new Set;
			planned.set(id, new Set(current));
			for (const state of states) {
				// windowId is load-bearing: TST's getTargetTabs falls back
				// to the LAST FOCUSED WINDOW without it, and in a headless
				// (or unfocused) session that resolves to a window whose
				// active tab is null => the request silently processes
				// ZERO tabs while still answering `true`.
				if (force || !current.has(state)) { jobs.push({ id, state, op: "add", }); }
			}
			for (const state of current) {
				if (!states.has(state)) { jobs.push({ id, state, op: "remove", }); }
			}
		}
		// tabs that dropped out of our world entirely (unshelved, closed…).
		// ONLY tabs of THIS window: in a multi-window session another
		// window's derivation must not touch states of foreign-window tabs
		// (they are "not in this tree" by definition — a global cleanup
		// here nuked the other window's shelf states; caught in E2E).
		for (const [id, current] of [...tabStates.entries()]) {
			if (wanted.has(id) || !tabsById.has(id)) { continue; }
			planned.set(id, new Set(current));
			for (const state of current) { jobs.push({ id, state, op: "remove", }); }
		}

		const outcomes = await Promise.all(jobs.map(job =>
			send(job.op === "add" ? "add-tab-state" : "remove-tab-state",
				{ tab: job.id, state: job.state, windowId, })
				.then(() => true, error => {
					log(`${job.op}-state-fail`, `${job.id} ${job.state} ${error && error.message || error}`);
					return false;
				})));
		jobs.forEach((job, index) => {
			if (!outcomes[index]) { return; }
			const states = planned.get(job.id);
			if (!states) { return; }
			if (job.op === "add") { states.add(job.state); } else { states.delete(job.state); }
		});
		for (const [id, states] of planned) {
			if (wanted.has(id) || states.size) { tabStates.set(id, states); }
			else { tabStates.delete(id); }
		}
	}

	/**
	 * Virtual-scroll restore: TST clears tab-above/tab-below extra
	 * contents when a row leaves the viewport (and re-inserts cached
	 * ones only when the row element is reused).  After tabs-rendered
	 * the sidebar has new row elements; re-send what we believe each
	 * strap should be.  Idempotent: TST sanitizes and replaces.
	 */
	async function restoreStraps ({ windowId, derivation, tabsById, }) {
		if (!derivation) { return; }
		log("restore", `window ${windowId} shelves=${derivation.shelves.size}`);
		const writes = [];
		for (const [owner, members] of derivation.shelves) {
			if (!members.length) { continue; }
			writes.push(writeStrap({
				key: strapKey(windowId, owner),
				owner,
				contents: strapHtml({
					members,
					tabsById,
					highlightIds: derivation.highlightIds,
					badgeIds: derivation.badgeIds,
				}),
				windowId,
			}));
		}
		await Promise.all(writes);
	}

	/**
	 * Upgrade path.  TST keeps extra contents per addon+tab across our
	 * updates, and 0.1.2/0.1.3 parked straps on rows that no longer host
	 * them (owner rows as a second line, then the first member's row).
	 * Without this one-shot the stale markup would sit in those rows
	 * forever.  Clear `tab-below` for every tab of the window once.
	 */
	async function clearLegacyStraps ({ windowId, tabIds, }) {
		const sends = [];
		for (const tabId of tabIds) {
			sends.push(send("set-extra-contents", { place: "tab-below", tab: tabId, windowId, contents: null, })
				.catch(error => log("legacy-clear-fail", `${tabId} ${error && error.message || error}`)));
		}
		await Promise.all(sends);
		log("legacy-clear", `window ${windowId} tabs=${tabIds.length}`);
	}

	function forceStateResync () {
		forceStateSync = true;
	}

	/** Forget a window (closed): stop tracking its keys and states. */
	function forgetWindow (windowId, liveTabIds) {
		for (const key of [...renderedStraps.keys()]) {
			if (key.startsWith(`${windowId}:`)) { renderedStraps.delete(key); }
		}
		for (const id of [...tabStates.keys()]) {
			if (!liveTabIds.has(id)) { tabStates.delete(id); }
		}
	}

	return { applyDerivation, restoreStraps, clearLegacyStraps, forgetWindow, forceStateResync };
}
