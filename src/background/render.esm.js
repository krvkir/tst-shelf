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
 * Diffing renderer.  Tracks what it last sent per strap and clears the
 * targets that vanished (an empty shelf, a closed owner).
 * `send(type, params)` is TST's message route; the caller injects it.
 */
export function createRenderer ({ send, log, linesOf = () => 1, }) {
	const renderedStraps = new Map; // `${windowId}:${owner}` -> { owner, contents } (null = cleared)
	const tabStates = new Map;      // tabId -> Set of applied tst-shelf-* states
	/** Re-send every wanted state even if the ledger says it is applied: a
	 *  sidebar that attaches late never saw the earlier broadcasts (TST
	 *  exports only its own safe states to a newly opened sidebar, see
	 *  exportTab in common/TreeItem.js), so its model is missing ours. */
	let forceStateSync = false;
	const strapKey = (windowId, owner) => `${windowId}:${owner ?? "root"}`;

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

		const sends = [];
		// `lines` is the TST capability (A3): the row is rendered as N whole
		// lines tall and TST's scroll geometry accounts for it.  A TST
		// without the capability ignores the parameter and the strap simply
		// scrolls (the stylesheet keeps a single line there).
		const strapSend = ({ owner, contents, }) => {
			const lines = linesOf(owner, windowId);
			return send("set-extra-contents",
				owner === ROOT_SHELF
					? { place: "tabbar-top", windowId, contents, lines, }
					: { place: "tab-below", tab: owner, windowId, contents, lines, });
		};

		for (const [key, strap] of desired) {
			const current = renderedStraps.get(key);
			if (current && current.contents === strap.contents) { continue; }
			renderedStraps.set(key, strap);
			sends.push(strapSend(strap));
		}
		// straps that vanished entirely (owner left the tree, members gone)
		for (const [key, current] of [...renderedStraps.entries()]) {
			if (key.startsWith(`${windowId}:`) && !desired.has(key) && current && current.contents != null) {
				renderedStraps.set(key, null);
				sends.push(strapSend({
					owner: key.endsWith(":root") ? ROOT_SHELF : Number(key.slice(String(windowId).length + 1)),
					contents: null,
				}));
			}
		}
		await Promise.all(sends);

		await applyTabStates({ windowId, derivation, tabsById, });
	}

	/**
	 * Diff the tst-shelf-* state classes against what we last applied.
	 * Only owners carry a state now: members have no rows at all (hidden
	 * tabs), so there is nothing to style on them — the strap icon IS
	 * their presentation (0.1.4).
	 */
	async function applyTabStates ({ windowId, derivation, tabsById, }) {
		const wanted = new Map; // tabId -> Set of states
		for (const owner of derivation.ownerIds) {
			if (owner === ROOT_SHELF) { continue; }
			const states = new Set(["tst-shelf-owner"]);
			if (linesOf(owner, windowId) > 1) { states.add("tst-shelf-lines"); }
			wanted.set(owner, states);
		}

		const sends = [];
		const force = forceStateSync;
		forceStateSync = false;
		for (const [id, states] of wanted) {
			const current = tabStates.get(id) || new Set;
			for (const state of states) {
				// windowId is load-bearing: TST's getTargetTabs falls back
				// to the LAST FOCUSED WINDOW without it, and in a headless
				// (or unfocused) session that resolves to a window whose
				// active tab is null => the request silently processes
				// ZERO tabs while still answering `true`.
				if (force || !current.has(state)) { sends.push(send("add-tab-state", { tab: id, state, windowId, })); }
			}
			for (const state of current) {
				if (!states.has(state)) { sends.push(send("remove-tab-state", { tab: id, state, windowId, })); }
			}
			tabStates.set(id, states);
		}
		// tabs that dropped out of our world entirely (unshelved, closed…).
		// ONLY tabs of THIS window: in a multi-window session another
		// window's derivation must not touch states of foreign-window tabs
		// (they are "not in this tree" by definition — a global cleanup
		// here nuked the other window's shelf states; caught in E2E).
		for (const [id, current] of [...tabStates.entries()]) {
			if (!wanted.has(id) && tabsById.has(id)) {
				for (const state of current) {
					sends.push(send("remove-tab-state", { tab: id, state, windowId, }));
				}
				tabStates.delete(id);
			}
		}
		await Promise.all(sends);
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
		const sends = [];
		for (const [owner, members] of derivation.shelves) {
			if (!members.length) { continue; }
			const contents = strapHtml({
				members,
				tabsById,
				highlightIds: derivation.highlightIds,
				badgeIds: derivation.badgeIds,
			});
			const lines = linesOf(owner, windowId);
			const params = owner === ROOT_SHELF
				? { place: "tabbar-top", windowId, contents, lines, }
				: { place: "tab-below", tab: owner, windowId, contents, lines, };
			sends.push(send("set-extra-contents", params)
				.catch(error => log("restore-send-fail", `${owner} ${error && error.message || error}`)));
		}
		await Promise.all(sends);
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

	/** Drop the remembered straps so the next derivation re-sends them
	 *  (used when something outside the contents changed, e.g. the row's
	 *  line count). */
	function invalidate (windowId) {
		for (const key of [...renderedStraps.keys()]) {
			if (key.startsWith(`${windowId}:`)) { renderedStraps.delete(key); }
		}
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

	return { applyDerivation, restoreStraps, clearLegacyStraps, forgetWindow, invalidate, forceStateResync };
}
