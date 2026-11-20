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
 * Diffing renderer.  Tracks what it last sent per strap (so identical
 * re-derivations cost nothing) and per tab (state classes), and clears
 * straps that became empty.  `send(type, params)` is TST's message
 * route; the caller injects it.
 */
export function createRenderer ({ send, log, }) {
	const renderedStraps = new Map; // `${windowId}:${owner}` -> last contents (or null)
	const tabStates = new Map;      // tabId -> Set of applied tst-shelf-* states
	const strapKey = (windowId, owner) => `${windowId}:${owner ?? "root"}`;

	/** Apply one window's derivation: straps first, then state classes. */
	async function applyDerivation ({ windowId, derivation, tabsById, }) {
		const desired = new Map;
		for (const [owner, members] of derivation.shelves) {
			const key = strapKey(windowId, owner);
			desired.set(key, {
				owner,
				contents: members.length ?
					strapHtml({
						members,
						tabsById,
						highlightIds: derivation.highlightIds,
						badgeIds: derivation.badgeIds,
					}) :
					null,
			});
		}

		const sends = [];
		for (const [key, { owner, contents }] of desired) {
			if (renderedStraps.get(key) === contents) { continue; }
			renderedStraps.set(key, contents);
			sends.push(sendStrap({ windowId, owner, contents }));
		}
		// straps that vanished entirely (owner left the tree, members gone)
		for (const key of [...renderedStraps.keys()]) {
			if (key.startsWith(`${windowId}:`) && !desired.has(key) && renderedStraps.get(key) != null) {
				renderedStraps.set(key, null);
				const owner = key.endsWith(":root") ? ROOT_SHELF : Number(key.slice(String(windowId).length + 1));
				sends.push(sendStrap({ windowId, owner, contents: null }));
			}
		}
		await Promise.all(sends);

		await applyTabStates({ windowId, derivation, tabsById, });
	}

	function sendStrap ({ windowId, owner, contents, }) {
		const params = owner === ROOT_SHELF ?
			{ place: "tabbar-top", windowId, contents, } :
			{ place: "tab-below", tab: owner, windowId, contents, };
		return send("set-extra-contents", params);
	}

	/** Diff the tst-shelf-* state classes against what we last applied. */
	async function applyTabStates ({ windowId, derivation, tabsById, }) {
		const wanted = new Map; // tabId -> Set of states
		for (const id of derivation.shelvedVisible) {
			const states = new Set(["tst-shelf-shelved"]);
			if (derivation.ghostIds.has(id)) { states.add("tst-shelf-ghost"); }
			wanted.set(id, states);
		}
		for (const owner of derivation.ownerIds) {
			if (owner === ROOT_SHELF) { continue; }
			const states = wanted.get(owner) || new Set;
			states.add("tst-shelf-owner");
			wanted.set(owner, states);
		}

		const sends = [];
		for (const [id, states] of wanted) {
			const current = tabStates.get(id) || new Set;
			for (const state of states) {
				// windowId is load-bearing: TST's getTargetTabs falls back
				// to the LAST FOCUSED WINDOW without it, and in a headless
				// (or unfocused) session that resolves to a window whose
				// active tab is null => the request silently processes
				// ZERO tabs while still answering `true`.
				if (!current.has(state)) { sends.push(send("add-tab-state", { tab: id, state, windowId, })); }
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
			sends.push(sendStrap({
				windowId,
				owner,
				contents: members.length ?
					strapHtml({
						members,
						tabsById,
						highlightIds: derivation.highlightIds,
						badgeIds: derivation.badgeIds,
					}) :
					null,
			}).catch(error => log("restore-send-fail", `${owner} ${error && error.message || error}`)));
		}
		await Promise.all(sends);
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

	return { applyDerivation, restoreStraps, forgetWindow };
}
