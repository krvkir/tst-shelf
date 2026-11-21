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

/**
 * One shelf icon (a favicon cell).
 *
 * The fold badge shows whenever the shelved tab has descendants (the
 * count is TST's own subtree-counter number: the descendants, the tab
 * itself excluded) — the mode picks the plus or the number.  The audio
 * indicator (`shelf-sound`) takes the other bottom corner; it carries
 * the tab's id again so a click on the glyph alone identifies the target
 * in the mousedown payload's closest-part HTML.
 *
 * In hint mode `hint` is the tab's two-letter code: an overlay chip the
 * click/drag behavior flows through (pointer-events: none; the chip is
 * passive).
 */
export function iconHtml ({ tab, active, badgeMode = "plus", badgeCount = 0, hint = null, }) {
	const parts = ["shelf-icon"];
	if (active) { parts.push("tst-shelf-icon-active"); }
	const muted = !!tab.mutedInfo?.muted;
	const playing = !muted && !!tab.audible;
	const soundSpan = muted || playing
		? `<span part="shelf-sound${muted ? " tst-shelf-sound-muted" : ""}" data-tab-id="${tab.id}"></span>`
		: "";
	const badgeSpan = badgeCount > 0
		? `<span part="shelf-badge">${badgeMode === "count" ? badgeCount : "+"}</span>`
		: "";
	const hintSpan = hint
		? `<span part="shelf-hint" data-hint="${escapeAttributeValue(hint)}">${escapeHtml(hint)}</span>`
		: "";
	const title = `${tab.title || tab.url || ""}\n${tab.url || ""}`;
	return `<div part="${parts.join(" ")}" data-tab-id="${tab.id}"`
		+ ` draggable="true"`
		+ ` data-drag-data='{"type":"tab","data":{"id":${tab.id},"asTree":true}}'`
		+ ` title="${escapeAttributeValue(title)}"`
		+ faviconStyleOf(tab)
		+ `>${hintSpan}${soundSpan}${badgeSpan}</div>`;
}

/** The invisible, zero-size key catcher: the mode's focus target.  TST's
 *  focus-to-extra-contents focuses it and every keydown from then on is
 *  forwarded through its `.extra-item` owner routing (tst-api-frontend).
 *  Zero-size and opacity 0 — `display: none` would make focus a no-op. */
const KEY_CATCHER_HTML = `<span part="shelf-keycatcher" tabindex="0"></span>`;

/**
 * The strap of one shelf (its whole extra-contents markup).
 *
 * `keyCatcher` (ROOT shelves only) prepends the key catcher, making the
 * root strap ALWAYS-present: the catcher exists in every window from the
 * first derivation, even with zero root members, which is what
 * `focus-to-extra-contents` needs before a hint mode can be started.
 * A member-less root strap therefore renders as a part-less "idle"
 * wrapper (no styling, no height) so an empty root shelf still reserves
 * no space; the catcher itself is zero-size either way.
 *
 * `hints` (hint mode): a Map tabId -> code; the chip renders on the
 * icons whose ids sit in the map — narrowed labels are simply absent.
 */
export function strapHtml ({ members, tabsById, highlightIds, badgeCounts = new Map, badgeMode = "plus", hints = null, keyCatcher = false, }) {
	const icons = members
		.map(id => tabsById.get(id))
		.filter(Boolean)
		.map(tab => iconHtml({
			tab,
			active: highlightIds.has(tab.id),
			badgeMode,
			badgeCount: badgeCounts.get(tab.id) || 0,
			hint: hints ? (hints.get(tab.id) || null) : null,
		}))
		.join("");
	if (keyCatcher && !icons.length) {
		return `<div class="shelf-strap-idle">${KEY_CATCHER_HTML}</div>`;
	}
	const catcher = keyCatcher ? KEY_CATCHER_HTML : "";
	return `<div part="shelf-strap">${catcher}${icons}</div>`;
}

/**
 * Diffing renderer.  Tracks what TST ACKNOWLEDGED per strap — the markup —
 * and clears the targets that vanished (an empty shelf, a closed owner).  A
 * request that rejects is not recorded, so the next derivation retries it.
 * `send(type, params)` is TST's message route; the caller injects it.
 */
export function createRenderer ({ send, log, badgeModeOf = () => "plus", }) {
	const renderedStraps = new Map; // `${windowId}:${owner}` -> { owner, contents } | null (cleared)
	const tabStates = new Map;      // tabId -> Set of ACKNOWLEDGED tst-shelf-* states
	/** The active hint codes (Map tabId -> code) while hint mode is on,
	 *  null otherwise: the strap markup is rebuilt from this on every
	 *  derivation, so a structural pass during the mode re-applies the
	 *  chips together with everything else. */
	let activeHints = null;
	/** Row hint ledger: `${windowId}:${tabId}` -> last ACKNOWLEDGED
	 *  contents of the tab's `tab-above` extra contents.  Same rule as
	 *  the strap ledger: a rejected write is not recorded, so the next
	 *  request retries it. */
	const rowHints = new Map;
	/** Writes whose send promise has not settled yet.  TST never answers
	 *  extra-contents requests (every case in tst-api-frontend.js ends
	 *  with a bare `return`), so "acknowledged" for row labels really
	 *  means "the send promise settled" — a count the E2E reads to tell
	 *  a hung send batch from a refused one. */
	let rowHintPending = 0;
	const rowHintPendingCount = () => rowHintPending;
	/** The settle trace of the recent row-hint writes, for the E2E state
	 *  export: TST never answers extra-contents requests, so "settled"
	 *  means the send promise resolved; failures and latencies ride here
	 *  (a dedicated ring — the shared diag ring drowns in poll traffic). */
	const rowHintTrace = [];
	const rowHintTracePush = line => {
		rowHintTrace.push(`${Date.now().toString(36)} ${line}`);
		if (rowHintTrace.length > 60) { rowHintTrace.shift(); }
	};
	const rowHintTraceLines = () => [...rowHintTrace];
	/** The full row-hint ledger as `window:tab(length)` keys, for the E2E
	 *  state export — the settled-ledger truth the checks lean on. */
	const rowLedgerKeys = () => [...rowHints.entries()]
		.map(([key, contents]) => `${key}(${contents ? contents.length : 0})`);
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
	/** TST never answers `set-extra-contents` (each case in
	 *  tst-api-frontend.js ends with a bare `return`), and the reply
	 *  race resolves only some send promises at all — the rest settle
	 *  LATE, after later writes on the same channel have already
	 *  superseded them.  A late settle must not poison the ledger with a
	 *  superseded "want" (an E2E-measured hang at ~0.9 s), so every
	 *  extra-contents settle is bounded: the send counts as acknowledged
	 *  when it resolves OR when the bound expires, and a rejection before
	 *  the bound is still a failure (retried by the next diff). */
	const SETTLE_BOUND_MS = 250;
	function boundSettle (promise, failNote) {
		return Promise.race([
			promise,
			new Promise(resolve => setTimeout(() => resolve("bound"), SETTLE_BOUND_MS)),
		]).then(value => {
			if (value === "bound") { rowHintTracePush(`bound ${failNote}`); }
			return value;
		}, error => {
			return Promise.reject(error);
		});
	}

	/** Send one strap.  TST never answers `set-extra-contents` and the
	 *  reply race leaves some send promises settled late or never, so
	 *  the ledger is INTENT-tracked: it records the want immediately and
	 *  reverts on a real rejection alone (a rejection means TST never
	 *  heard us, so the next diff re-sends).  Idempotent re-sends are
	 *  harmless: the DOM's truth lives in TST, not here. */
	async function writeStrap ({ key, owner, contents, windowId, }) {
		const params = owner === ROOT_SHELF
			? { place: "tabbar-top", windowId, contents, }
			: { place: "tab-below", tab: owner, windowId, contents, };
		const startedAt = Date.now();
		try {
			await boundSettle(send("set-extra-contents", params), `strap ${key}`);
			// ACK semantics for straps: a successful clear drops the entry
			// ("left alone"), a failure keeps nothing (the vanished-shelves
			// loop retries it), a hung send re-sends the next pass — straps
			// are idempotent.  (The row-hint ledger below is intent-first:
			// its writes race restore/redraw/exit batches in one burst.)
			renderedStraps.set(key, contents == null ? null : { owner, contents, });
			rowHintTracePush(`strap ${key} ${Date.now() - startedAt}ms`);
			return true;
		}
		catch (error) {
			rowHintTracePush(`strap-fail ${key} ${Date.now() - startedAt}ms ${error && error.message || error}`);
			log("strap-send-fail", `${key} ${Date.now() - startedAt}ms ${error && error.message || error}`);
			return false;
		}
	}

	/** Build one shelf's strap markup from the current derivation state.
	 *  The ROOT shelf carries the key catcher in every derivation and
	 *  every restore (tab-hints); the active hint codes ride the icons. */
	function strapFor ({ owner, members, tabsById, highlightIds, badgeCounts, }) {
		return strapHtml({
			members,
			tabsById,
			highlightIds,
			badgeCounts,
			badgeMode: badgeModeOf(),
			hints: activeHints,
			keyCatcher: owner === ROOT_SHELF,
		});
	}

	/** Apply one window's derivation: straps first, then state classes. */
	async function applyDerivation ({ windowId, derivation, tabsById, }) {
		const desired = new Map;
		for (const [owner, members] of derivation.shelves) {
			if (!members.length) { continue; }
			desired.set(strapKey(windowId, owner), {
				owner,
				contents: strapFor({
					owner,
					members,
					tabsById,
					highlightIds: derivation.highlightIds,
					badgeCounts: derivation.badgeCounts,
				}),
			});
		}
		// the ROOT strap is always present: a window with no root members
		// still carries the (member-less, part-less) catcher wrapper, so
		// the mode's focus target exists before any hint can be wanted.
		const rootKey = strapKey(windowId, ROOT_SHELF);
		if (!desired.has(rootKey)) {
			desired.set(rootKey, {
				owner: ROOT_SHELF,
				contents: strapFor({
					owner: ROOT_SHELF,
					members: [],
					tabsById,
					highlightIds: new Set,
					badgeCounts: new Map,
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
		let wroteRoot = false;
		for (const [owner, members] of derivation.shelves) {
			if (!members.length && owner !== ROOT_SHELF) { continue; }
			wroteRoot = wroteRoot || owner === ROOT_SHELF;
			writes.push(writeStrap({
				key: strapKey(windowId, owner),
				owner,
				contents: strapFor({
					owner,
					members,
					tabsById,
					highlightIds: derivation.highlightIds,
					badgeCounts: derivation.badgeCounts,
				}),
				windowId,
			}));
		}
		// the catcher rides the root strap in every window, member-less or not
		if (!wroteRoot) {
			writes.push(writeStrap({
				key: strapKey(windowId, ROOT_SHELF),
				owner: ROOT_SHELF,
				contents: strapFor({
					owner: ROOT_SHELF,
					members: [],
					tabsById,
					highlightIds: new Set,
					badgeCounts: new Map,
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

	/**
	 * Row hint ledger: one `tab-above` extra contents per labeled row.
	 * TST clears a row's extra contents when the row leaves the viewport
	 * and re-inserts its cached markup only when the element is reused,
	 * so the mode re-sends the labels on every `tabs-rendered` too (see
	 * onTabsRendered): the ledger holds what the sidebar last
	 * acknowledged, and only a differing label goes over the wire.
	 */
	function rowHintMarkup (code) {
		// part "shelf-rowhint" (NOT the icon chip's "shelf-hint"): the row
		// chip anchors to TST's .above container, the icon chip to our own
		// .shelf-icon — two geometries, two rules (style.esm.js)
		return code
			? `<span part="shelf-rowhint" data-hint="${escapeAttributeValue(code)}">${escapeHtml(code)}</span>`
			: "";
	}

	async function writeRowHint ({ key, tab, windowId, contents, force = false, }) {
		if (!force && rowHints.get(key) === contents) { return false; }
		// intent first, but an EMPTY label is "no label": it drops the key
		// entirely (a blank entry can only be confused with a later want)
		if (contents) { rowHints.set(key, contents); } else { rowHints.delete(key); }
		rowHintPending++;
		const startedAt = Date.now();
		try {
			await boundSettle(send("set-extra-contents", { place: "tab-above", tab, windowId, contents, }), `row ${key}`);
			rowHintTracePush(`${contents ? "settle" : "clear"} ${key} ${Date.now() - startedAt}ms`);
			return true;
		}
		catch (error) {
			rowHints.delete(key);
			rowHintTracePush(`fail ${key} ${Date.now() - startedAt}ms ${error && error.message || error}`);
			log("row-hint-fail", `${key} ${Date.now() - startedAt}ms ${error && error.message || error}`);
			return false;
		}
		finally {
			rowHintPending--;
		}
	}

	/** `labels`: Map<tabId, string> — the code for kept labels, "" (an
	 *  empty string) for hidden ones (the narrowed-out codes).  `force`
	 *  re-sends labels whose ledger content already matches: TST may have
	 *  re-inserted a cached (stale) label with the re-rendered row, and
	 *  the re-rendered id is exactly what force is used with. */
	async function setRowHints ({ windowId, labels = new Map, force = false, }) {
		const jobs = [];
		for (const [tabId, code] of labels) {
			jobs.push(writeRowHint({
				key: strapKey(windowId, tabId),
				tab: tabId,
				windowId,
				contents: rowHintMarkup(code),
				force,
			}));
		}
		await Promise.all(jobs);
	}

	/** Blank every acknowledged label of the window (mode exit) and drop
	 *  the empty ledger entries.  A `set-extra-contents` of "" blanks the
	 *  item while keeping the (zero-size) `.extra-item` wrapper TST
	 *  created for it — same visual result as clearing the container. */
	async function clearRowHints ({ windowId, }) {
		const prefix = `${windowId}:`;
		const keys = [...rowHints.keys()].filter(key => key.startsWith(prefix));
		rowHintTracePush(`clearing ${windowId} with ${keys.length} keys`);
		log("hints-clearing", `window ${windowId} keys=${keys.length}`);
		const jobs = [];
		for (const [key, contents] of [...rowHints.entries()]) {
			if (!key.startsWith(prefix) || contents === "") { continue; }
			// unconditional intent: the window's row labels are DOWN from
			// this moment; even a hung/late send promise cannot re-arm a
			// key (a later re-enter re-sends everything: the ledger is
			// empty and a label write to an already-blank container is a
			// harmless no-op on TST's side)
			rowHints.delete(key);
			jobs.push(writeRowHint({ key, tab: Number(key.slice(prefix.length)), windowId, contents: "", force: true, }));
		}
		await Promise.all(jobs);
	}

	/** Drop the ledger entries of tabs TST has unrendered: TST clears a
	 *  row's extra contents when its row leaves the viewport, so anything
	 *  we still believe "already sent" is gone on the TST side and the
	 *  next label write must be a real resend, not a ledger skip. */
	function forgetRowHints (tabs) {
		for (const tab of tabs) {
			if (!tab || tab.windowId == null || tab.id == null) { continue; }
			const key = strapKey(tab.windowId, tab.id);
			if (rowHints.has(key)) {
				rowHintTracePush(`forget ${key}`);
				rowHints.delete(key);
			}
		}
	}

	/** Diagnostics for the E2E state export: how many acknowledged
	 *  non-empty row labels the window holds. */
	function rowHintCount (windowId) {
		const prefix = `${windowId}:`;
		let count = 0;
		for (const [key, contents] of rowHints.entries()) {
			if (key.startsWith(prefix) && contents) { count++; }
		}
		return count;
	}

	/** Diagnostics for the E2E state export: how many acknowledged
	 *  non-empty row labels exist in ANY window — readable both while a
	 *  mode is up and after its exit (the hint export dies with it). */
	function rowLedgerCount () {
		let count = 0;
		for (const contents of rowHints.values()) {
			if (contents) { count++; }
		}
		return count;
	}

	/** Enter/leave hint mode's chip set: the straps are rebuilt from this
	 *  on the next derivation (and every structural pass in between). */
	function setHints (map) {
		activeHints = map;
	}

	function forceStateResync () {
		forceStateSync = true;
	}

	/** Forget a window (closed): stop tracking its keys and states. */
	function forgetWindow (windowId, liveTabIds) {
		for (const key of [...renderedStraps.keys()]) {
			if (key.startsWith(`${windowId}:`)) { renderedStraps.delete(key); }
		}
		for (const key of [...rowHints.keys()]) {
			if (key.startsWith(`${windowId}:`)) { rowHints.delete(key); }
		}
		for (const id of [...tabStates.keys()]) {
			if (!liveTabIds.has(id)) { tabStates.delete(id); }
		}
	}

	return {
		applyDerivation, restoreStraps, clearLegacyStraps, forgetWindow,
		forceStateResync, setHints, setRowHints, clearRowHints, forgetRowHints, rowHintCount, rowLedgerCount, rowHintPendingCount, rowHintTraceLines, rowLedgerKeys,
	};
}
