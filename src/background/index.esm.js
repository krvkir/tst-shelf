/**
 * tst-shelf background page.
 *
 * Sections:
 *   1. state and persistence (the sticky flag; boot rebuild)
 *   2. TST registration (donor client, style string, version gate)
 *   3. uniform re-derivation (the whole world after every mutation)
 *   4. menu items (Put on shelf / Take off the shelf)
 *   5. icon interaction (mousedown select, middle close, fallback click)
 *   6. TST-behavior cancellation (the narrow, shelved-only kind)
 *   7. put/take state machine
 *   8. tab/window events, pin guard, diagnostics
 *   9. internal API for the E2E smoke page (-e2e builds only)
 *
 * Design contract: openspec/changes/add-shelf-foundation/{design.md},
 * the only stored state is the sticky per-tab session flag `tst-shelf`;
 * every shelf assignment, ghost, badge and selection is DERIVED from the
 * live TST light tree + browser.tabs on every structural event.
 */
import tstApi from "./tst-api.esm.js";
import { derive, straysToCollapse, subtreeSizes, treePositions, nextPlacementMove, resolveFavicons, mustShowTabs, ROOT_SHELF } from "./logic.esm.js";
import { createRenderer } from "./render.esm.js";
import { SHELF_STYLE } from "./style.esm.js";

const RECOMPUTE_DELAY_MS = 120;
const STATE_SHELVED = "tst-shelf-shelved";
const FLAG_KEY = "tst-shelf";

/** @type {Set<number>} tab ids carrying the sticky flag */
const shelved = new Set;
/** @type {Set<number>} tab ids we hid ourselves (browser.tabs.hide) to
 * take their rows out of TST's flow — the shelf icon is their whole
 * presentation.  Kept separate from "hidden" so that a tab hidden by
 * ANOTHER addon (tst-workspace container filtering) is distinguishable:
 * ours still gets an icon, theirs must not appear at all. */
const hiddenByUs = new Set;
/** @type {Map<number, string>} tab id -> last known favicon URL (session
 * scope): shelf icons keep the old favicon while the tab reloads —
 * TST's rows do the same (see resolveFavicons in logic.esm.js). */
let faviconMemory = new Map;
/** @type {Map<number, {derivation: object, tabsById: Map}>} last derivation per window */
const windows = new Map;
/** @type {Set<number>} windows whose 0.1.2 legacy straps were cleared */
const preparedWindows = new Set;
/** @type {Map<number, any>} per-window re-derivation timers */
const timers = new Map;
let tstUsable = false;

// ---------------------------------------------------------------------------
// 1. state, persistence and diagnostics

// serialized: two in-flight logBoot calls used to race (read-modify-write
// on storage.local) and silently DROP each other's entries — at cold boot
// the first IndexedDB open is slower than the TST handshake, so
// "boot-shelved" lost to "tst-registered" almost every time.
let bootlogWrite = Promise.resolve();
async function logBoot (kind, detail) {
	const entry = `${Date.now().toString(36)} ${kind}${detail ? " " + detail : ""}`;
	bootlogWrite = bootlogWrite.then(async () => {
		const { bootlog, } = await browser.storage.local.get({ bootlog: [], });
		const entries = Array.isArray(bootlog) ? bootlog : [];
		entries.push(entry);
		await browser.storage.local.set({ bootlog: entries.slice(-80), });
	}).catch(() => { /* diagnostics must never break the caller */ });
}

/** Rebuild the shelved set from per-tab session values after (re)start. */
async function loadShelvedFromSessions () {
	const tabs = await browser.tabs.query({});
	const values = await Promise.all(tabs.map(async tab => {
		try { return await browser.sessions.getTabValue(tab.id, FLAG_KEY); }
		catch (_error) { return null; }
	}));
	tabs.forEach((tab, index) => {
		const value = values[index];
		if (!value || !value.on) { return; }
		shelved.add(tab.id);
		// a member whose row we hid stays OURS across a restart: without
		// this the boot derivation would read it as foreign-hidden
		// (workspace filtering) and leave its icon off the shelf.
		if (value.hidden) { hiddenByUs.add(tab.id); }
	});
	logBoot("boot-shelved", `${shelved.size} of ${tabs.length} tabs`);
}

// ---------------------------------------------------------------------------
// 2. TST registration

/** @type {ReturnType<tstApi>} */
const TST = tstApi({
	getManifest () {
		const manifest = browser.runtime.getManifest();
		return {
			name: manifest.name,
			icons: manifest.icons,
			// style MUST be a string (never an array: TST's style-install
			// listener calls style.replace() — an array aborts its whole
			// frontend init; lesson recorded by tst-workspace session 5).
			style: SHELF_STYLE,
			// lightTree shrinks every notification payload to structure +
			// states — we take metadata from browser.tabs ourselves.
			lightTree: true,
			// coalesces tree-attached/tree-detached/tabs-rendered into
			// {messages: [...]} frames; the client fans them out.
			allowBulkMessaging: true,
		};
	},
	methods: [
		"get-version", "get-tree", "get-light-tree",
		"add-tab-state", "remove-tab-state",
		"collapse-tree", "expand-tree",
		"set-extra-contents", "clear-extra-contents",
		"move-before", "move-after", "outdent",
		"scroll",
	],
	events: {
		ready: () => {
			logBoot("tst-ready");
			register().then(() => scheduleRederiveAll()).catch(() => {});
		},
		"tree-attached": message => onTreeMutated(message?.tab?.windowId),
		"tree-detached": message => {
			onTreeMutated(message?.tab?.windowId);
		},
		"tabs-rendered": message => onTabsRendered(message?.tabs || []),
		"sidebar-show": message => onTabsRendered([], message?.windowId),
		"extra-contents-mousedown": message => onExtraContentsMousedown(message),
		"extra-contents-clicked": message => onExtraContentsClicked(message),
		"try-collapse-tree-from-other-expansion": message => shelved.has(message?.tab?.id),
		"try-scroll-to-activated-tab": message => onTryScrollToActivatedTab(message),
	},
	onError: error => logBoot("tst-error", String(error && error.message || error).slice(0, 120)),
});

/** register() can transiently fail while TST's background initializes
 * (it answers `undefined` to register-self and drops the registration).
 * Retry with capped backoff, mirroring tst-workspace. */
async function register () {
	let attempt = 0;
	for (;;) {
		try {
			(await TST.register());
			await checkTstUsable();
			logBoot("tst-registered", `attempt=${attempt} usable=${tstUsable}`);
			return;
		} catch (error) {
			attempt++;
			if (attempt >= 6) {
				logBoot("tst-register-fail", `${attempt} ${String(error && error.message || error).slice(0, 120)}`);
				return;
			}
			await new Promise(resolve => setTimeout(resolve, attempt * 1000));
		}
	}
}

/** Idle below TST 4.0: the extra-contents and menu APIs do not exist. */
async function checkTstUsable () {
	const version = await TST.methods.getVersion({}).catch(() => null);
	const major = parseInt(String(version || "0").split(".")[0], 10);
	tstUsable = major >= 4;
	if (!tstUsable) { logBoot("tst-too-old", String(version)); }
}

// ---------------------------------------------------------------------------
// 3. uniform re-derivation

async function normalWindows () {
	const all = await browser.windows.getAll({ windowTypes: ["normal"], });
	return all.filter(win => !win.incognito).map(win => win.id);
}

async function scheduleRederiveAll () {
	for (const windowId of await normalWindows()) { scheduleRederive(windowId); }
}

function scheduleRederive (windowId) {
	if (windowId == null) { return; }
	if (timers.has(windowId)) { clearTimeout(timers.get(windowId)); }
	timers.set(windowId, setTimeout(() => {
		timers.delete(windowId);
		rederive(windowId).catch(error => logBoot("rederive-fail", `${windowId} ${error && error.message || error}`));
	}, RECOMPUTE_DELAY_MS));
}

/**
 * The window's light tree.  Plain `get-light-tree` with only a windowId
 * resolves through TST's `getRootTabs`, which queries the CONTROLLABLE
 * index — and a hidden tab is removed from that index the moment the
 * `hidden` state applies (TreeItem.js updateIndexes, kTAB_STATE_HIDDEN →
 * `TabsStore.removeControllableTab`).  A hidden member of the ROOT shelf
 * therefore disappears from the tree entirely, while hidden CHILDREN
 * survive (the export walks `$TST.children` unfiltered).  Such a root is
 * fetched individually — `tab: <id>` resolves via `Tab.get`, which has
 * no such filter — and spliced back at its tab-order position.
 */
async function fetchLightTree (windowId, tabsById) {
	const tree = await TST.methods.getLightTree({ windowId, }).catch(error => {
		logBoot("light-tree-fail", `${windowId} ${error && error.message || error}`);
		return null;
	});
	if (!tree) { return null; }
	const roots = Array.isArray(tree) ? tree.slice() : [tree];
	const present = new Set;
	(function walk (nodes) {
		for (const node of nodes || []) {
			present.add(node.id);
			walk(node.children);
		}
	})(roots);
	const missing = [...shelved].filter(id => hiddenByUs.has(id) && tabsById.has(id) && !present.has(id));
	if (!missing.length) { return roots; }
	for (const id of missing) {
		const subtree = await TST.methods.getLightTree({ windowId, tab: id, }).catch(() => null);
		if (subtree && subtree.id == id) { roots.push(subtree); }
	}
	const indexOf = id => tabsById.get(id)?.index ?? Number.MAX_SAFE_INTEGER;
	roots.sort((a, b) => indexOf(a.id) - indexOf(b.id));
	logBoot("tree-splice", `window ${windowId} hidden roots=${missing.length}`);
	return roots;
}

async function rederive (windowId, { reconcile = false, } = {}) {
	if (!tstUsable) { return; }
	// favicon stickiness: tabs.query carries no favIconUrl while a tab
	// is loading or navigating — resolveFavicons fills the blank from
	// the memory and records every known one (logic.esm.js).
	const queryTabs = await browser.tabs.query({ windowId, });
	if (queryTabs.length == 0) { return; }
	const resolved = resolveFavicons(queryTabs, faviconMemory);
	faviconMemory = resolved.memory;
	const tabs = resolved.tabs;
	const tabsById = new Map(tabs.map(tab => [tab.id, tab]));
	// the tree comes FIRST: the hide decision needs the ancestor chain of
	// the active tab (mustShowTabs).  Hiding never changes the structure,
	// so the tree stays valid across it.
	const tree = await fetchLightTree(windowId, tabsById);
	if (!tree) { return; }
	// members keep NO row: hide them (and bring back any we hid that
	// left the shelf, or that must stay visible).
	await reconcileHidden(windowId, tabs, mustShowTabs({ tree, activeId: tabs.find(tab => tab.active)?.id ?? null, }));

const derivation = derive({ tree, shelved, tabsById, hiddenByUs, });
	windows.set(windowId, { derivation, tabsById, tree, });
	if (!preparedWindows.has(windowId)) {
		// upgrade path: 0.1.2 parked straps on owner rows (second line)
		// and 0.1.3 on the first member's row; TST keeps extra contents
		// per addon+tab across our update — clear every row once, before
		// the first owner-targeted render.
		preparedWindows.add(windowId);
		await renderer.clearLegacyStraps({ windowId, tabIds: tabs.map(tab => tab.id), }).catch(() => {});
	}
	await renderer.applyDerivation({ windowId, derivation, tabsById, });
	await reconcilePlacement(windowId, { tree, tabsById, derivation, });

	if (reconcile) {
		// boot reconciliation: one selected member per shelf (spec
		// shelf-nesting); TST persisted collapse state usually leaves at
		// most one, but a crash can leave more.
		const strays = straysToCollapse({ tree, shelves: derivation.shelves, selectedOfShelf: derivation.selectedOfShelf, });
		for (const id of strays) {
			await TST.methods.collapseTree({ tab: id, windowId, }).catch(() => {});
		}
		if (strays.length) { logBoot("reconcile", `collapsed ${strays.length}`); }
	}
}

// ---------------------------------------------------------------------------
// 3a. member rows: none at all
//
// A shelved tab's row would be a blank box in the flow, and TST's
// uniform-row law forbids making it zero-height (the painted height must
// equal the row size TST assumes, or every computed rect — and therefore
// every drop zone — below it drifts; see style.esm.js).  The only lever
// that removes a tab from TST's renderable set WITHOUT breaking the law
// is browser.tabs.hide(): a hidden tab is not counted, not painted and
// takes no space at all.  TST drops hidden tabs from
// `virtualScrollRenderableTabsInWindow` unless the expert option
// `renderHiddenTabs` is on (tabs-store.js:538-553) — that option puts
// members back into the flow and is unsupported (README).

/** Hide the members of this window; bring back members we hid that left
 *  the shelf.  Mutates the `tabs` records so the derivation sees the
 *  truth: tabs.query snapshots taken before a hide are stale. */
async function reconcileHidden (windowId, tabs, mustShow = new Set) {
	if (!tabs.length) { return; }
	const byId = new Map(tabs.map(tab => [tab.id, tab]));
	// Firefox refuses to hide the ACTIVE tab and refuses to empty a
	// window: both cases are filtered out here rather than failing the
	// whole batch (one bad id rejects the entire tabs.hide call).
	// `mustShow` adds the active tab's ancestors: a hidden parent has no
	// rendered descendants, so reclaiming an ancestor's row would take
	// the active tab's own row (and any nested shelf's strap) with it.
	const now = Date.now();
	let deferredUntil = 0;
	const toHide = [...shelved].filter(id => {
		const tab = byId.get(id);
		if (!tab || tab.hidden || tab.pinned || mustShow.has(id)) { return false; }
		const guardedUntil = hideGuard.get(id);
		if (guardedUntil && now < guardedUntil) {
			// its subtree is still animating; come back when the guard
			// expires — nothing else would trigger us (a member put on a
			// shelf would otherwise keep its row until the next event).
			deferredUntil = Math.max(deferredUntil, guardedUntil);
			return false;
		}
		if (guardedUntil) { hideGuard.delete(id); }
		return true;
	});
	if (deferredUntil) {
		const delay = Math.max(20, deferredUntil - now + 20);
		setTimeout(() => scheduleRederive(windowId), delay);
	}
	const visibleCount = tabs.filter(tab => !tab.hidden).length;
	while (toHide.length && visibleCount - toHide.length < 1) { toHide.pop(); }
	if (toHide.length) {
		try {
			const hid = await browser.tabs.hide(toHide);
			const actuallyHidden = (Array.isArray(hid) ? hid : toHide).filter(id => byId.has(id));
			for (const id of actuallyHidden) {
				hiddenByUs.add(id);
				byId.get(id).hidden = true;
			}
			await rememberHidden(actuallyHidden, true);
			logBoot("hide", `window ${windowId} tabs=${actuallyHidden.join(",")}`);
		}
		catch (error) { logBoot("hide-fail", `window ${windowId} ${error && error.message || error}`); }
	}
	// a member we hid that is no longer shelved must come back into the
	// strip (take-off shows it explicitly; this is the safety net for
	// the paths that do not — a close-parent re-parent, a pin guard…)
	const toShow = new Set([...hiddenByUs].filter(id => byId.has(id) && !shelved.has(id)));
	// Anything in the must-show chain that we hid comes back: the active
	// tab (Firefox may have revealed it already, or not yet) and every
	// ancestor of it — without the ancestors the active tab would have no
	// row at all, and a nested shelf would lose the row its strap lives
	// in.
	for (const id of mustShow) {
		if (hiddenByUs.has(id) && byId.has(id)) { toShow.add(id); }
	}
	const toShowIds = [...toShow];
	if (toShowIds.length) {
		for (const id of toShowIds) {
			hiddenByUs.delete(id);
			if (byId.has(id)) { byId.get(id).hidden = false; }
		}
		await browser.tabs.show(toShowIds).catch(error => logBoot("show-fail", String(error && error.message || error)));
		await rememberHidden(toShowIds, false);
		logBoot("show", `window ${windowId} tabs=${toShowIds.join(",")}`);
	}
}

/** Persist the "we hid it" bit beside the sticky flag: a restart must
 *  tell our own hides from another addon's (tst-workspace filtering). */
async function rememberHidden (tabIds, hidden) {
	await Promise.all(tabIds.map(async id => {
		const value = await browser.sessions.getTabValue(id, FLAG_KEY).catch(() => null);
		if (value && !!value.hidden == hidden) { return; }
		// the flag may not be on the tab yet (the put that shelved it can
		// still be in flight) — then write the bit BESIDE a fresh flag.
		// Skipping here used to lose the bit, and after a restart the tab
		// was mistaken for one hidden by another add-on: it then vanished
		// from the tree AND from the root shelf (caught in phase 3 E2E).
		if (!value && !shelved.has(id)) { return; }
		const next = { ...(value || { on: true, }), hidden, };
		await browser.sessions.setTabValue(id, FLAG_KEY, next)
			.catch(error => logBoot("remember-fail", `${id} ${error && error.message || error}`));
	}));
}

/** Immediate variant of the member reconcile, with NO re-derivation
 *  debounce.  Firefox reveals a hidden tab the instant it becomes the
 *  active tab and refuses to hide the active tab again (measured:
 *  `tabs.hide([activeId])` resolves with `[]`; MDN: "The current active
 *  tab cannot be hidden"), so a member that the user activates keeps a
 *  row for as long as it is active.  That reveal cannot be prevented,
 *  but it can be ended the moment focus moves: this runs straight from
 *  the activation/visibility events instead of waiting out the 120 ms
 *  re-derivation debounce. */
async function rehideMembersNow (windowId) {
	if (!tstUsable || windowId == null) { return; }
	const tabs = await browser.tabs.query({ windowId, }).catch(() => []);
	if (!tabs.length) { return; }
	// No extra IPC here: the tree cached by the last derivation is good
	// enough to decide what must stay visible (structure does not change
	// on activation), and the debounced re-derivation corrects any drift.
	const cached = windows.get(windowId)?.tree ?? null;
	if (!cached) { return; }
	const mustShow = mustShowTabs({ tree: cached, activeId: tabs.find(tab => tab.active)?.id ?? null, });
	await reconcileHidden(windowId, tabs, mustShow).catch(error =>
		logBoot("rehide-fail", `${windowId} ${error && error.message || error}`));
}

function onTreeMutated (windowId) {
	if (!tstUsable || windowId == null) { return; }
	scheduleRederive(windowId);
}

// ---------------------------------------------------------------------------
// 3b. shelf placement (the member block)
//
// Members of a shelf are kept CONTIGUOUS directly under their owner
// (root shelf: at the top of the root tabs), in shelving order with the
// newest last — so the selected member's children always render right
// below the strap and a newly shelved tab becomes the rightmost icon.
// Applied through TST's own move-before/move-after/outdent with
// followChildren: TST moves the member's whole subtree and re-derives
// the member's parent from the landing position; the planner's
// references are chosen so that parent is always the shelf owner
// (nextPlacementMove doc, logic.esm.js).  One move per iteration with a
// fresh derivation in between — indices shift with every move.

/** tabId -> timestamp until which its row must not be reclaimed.
 *
 * TST's collapse animation (`configs.collapseDuration`, 150 ms) runs in
 * the SIDEBAR and only removes the children's rows when it ends; the
 * `collapsing` state is sidebar-only, so the background model (and thus
 * the light tree) never reports it.  Reclaiming a parent's row mid-way
 * would orphan its still-painted children for the rest of the animation
 * — the visible "jump" when switching between shelf tabs.  So every
 * collapse we request for a member arms a guard that outlives the
 * animation, and `reconcileHidden` honours it. */
const hideGuard = new Map;
const COLLAPSE_ANIMATION_GRACE_MS = 300;

function guardRow (tabId) {
	hideGuard.set(tabId, Date.now() + COLLAPSE_ANIMATION_GRACE_MS);
}

/** tabId -> put sequence: the shelf order is the PUT order, so a newly
 *  shelved tab becomes the rightmost icon and two quick puts cannot lose
 *  each other (a per-window single slot could, and did). */
const appendSeq = new Map;
let appendCounter = 0;

function rememberAppend (tabId) {
	appendSeq.set(tabId, ++appendCounter);
}

/** Drop the sequences whose placement has been confirmed for this
 *  derivation — otherwise they would fight a later user drag forever. */
function consumeAppends (derivation) {
	for (const members of derivation.shelves.values()) {
		for (const id of members) { appendSeq.delete(id); }
	}
}
/** windowIds with a running placement loop (one at a time per window). */
const placing = new Set;

async function reconcilePlacement (windowId, { tree = null, tabsById = null, derivation = null, } = {}) {
	if (!tstUsable || placing.has(windowId)) { return; }
	placing.add(windowId);
	try {
		let steps = 0;
		while (steps++ < 40) {
			const appendOrder = appendSeq.size ? new Map(appendSeq) : null;
			if (!tree || !tabsById) {
				const tabs = await browser.tabs.query({ windowId, }).catch(() => []);
				if (tabs.length == 0) { return; }
				tabsById = new Map(tabs.map(tab => [tab.id, tab]));
				tree = await fetchLightTree(windowId, tabsById);
				if (!tree) { return; }
				derivation = derive({ tree, shelved, tabsById, hiddenByUs, });
			}
			// ranks in TST's INTERNAL order: move-before/move-after update
			// it synchronously, while the physical strip catches up only
			// after TST's deferred 250 ms sync (tabs-move.js) — planning
			// against physical indices spins on stale snapshots.
			const positions = treePositions(tree);
			const ranks = [...tabsById.values()].map(tab => ({
				id: tab.id,
				pos: positions.get(tab.id) ?? Number.MAX_SAFE_INTEGER,
				pinned: !!tab.pinned,
			}));
			const move = nextPlacementMove({
				ranks,
				sizes: subtreeSizes(tree),
				shelves: derivation.shelves,
				appendOrder,
			});
			if (!move) { consumeAppends(derivation); return; }
			const sent = move.kind == "move-before"
				? TST.methods.moveBefore({ tab: move.tabId, windowId, referenceTabId: move.referenceTabId, followChildren: true, })
				: TST.methods.moveAfter({ tab: move.tabId, windowId, referenceTabId: move.referenceTabId, followChildren: true, })
					.then(move.thenOutdent
						? () => TST.methods.outdent({ tab: move.tabId, windowId, followChildren: true, })
						: null);
			const ok = await sent.catch(error => {
				logBoot("placement-fail", `${move.kind} ${move.tabId} ${error && error.message || error}`);
				return false;
			});
			if (ok === false) { return; }
			logBoot("placement", `${move.kind} tab ${move.tabId} ref ${move.referenceTabId}`);
			tree = null; tabsById = null; derivation = null;
		}
		logBoot("placement-guard", `window ${windowId} steps ${steps}`);
	}
	finally { placing.delete(windowId); }
}

/** tabs-rendered: rows were (re)rendered — restore their straps. */
async function onTabsRendered (tabs, windowIdHint) {
	if (!tstUsable) { return; }
	const windowIds = new Set;
	if (windowIdHint != null) { windowIds.add(windowIdHint); }
	for (const tab of tabs) {
		if (tab && tab.windowId != null) { windowIds.add(tab.windowId); }
	}
	logBoot("tabs-rendered", `windows=${[...windowIds]} tabs=${tabs.length}`);
	for (const windowId of windowIds) {
		const cached = windows.get(windowId);
		if (cached) {
			renderer.restoreStraps({ windowId, derivation: cached.derivation, tabsById: cached.tabsById, })
				.catch(error => logBoot("restore-fail", `${windowId} ${error && error.message || error}`));
		}
		else {
			scheduleRederive(windowId);
		}
	}
}

const renderer = createRenderer({
	send: (type, params) => {
		const camel = type.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
		const method = TST.methods[camel];
		if (!method) {
			logBoot("send-no-method", type);
			return Promise.reject(new Error(`no method ${type}`));
		}
		const promise = method(params);
		if (type.includes("tab-state")) {
			const detail = `${type} ${JSON.stringify(params).slice(0, 90)}`;
			const timer = setTimeout(() => logBoot("send-slow", detail), 3000);
			promise.catch(error => { clearTimeout(timer); logBoot("send-fail", `${detail} ${error && error.message || error}`); });
		}
		return promise;
	},
	log: logBoot,
});

// ---------------------------------------------------------------------------
// 4. menu items

const MENU_PUT = "tst-shelf:put";
const MENU_TAKE = "tst-shelf:take";

/** Menu items are OUR OWN browser.menus items, not TST-registered ones.
 * TST's contextMenu-create items are created `visible: false` and no TST
 * code path ever flips them for a plain tab-row menu — onShown's main
 * body updates only TST's own items, and contextMenu-update strips the
 * `visible` property outside an owner-matched override (menus for the
 * addon's own extra contents). Verified against TST 4.4.9/4.4.10;
 * tst-more-tree-commands, the reference helper, uses raw browser.menus
 * for exactly this reason. TST's sidebar opens the tab menu via
 * overrideContext({context: "tab"}), which shows every extension's
 * contexts:["tab"] items — ours included. No viewTypes restriction:
 * the items also appear in the native tab bar's menu, as More Tree
 * Commands' do. */
function createMenuItems () {
	for (const item of [
		{ id: MENU_PUT, title: "Put on shelf", },
		{ id: MENU_TAKE, title: "Take off the shelf", },
	]) {
		try {
			browser.menus.create({ ...item, contexts: ["tab"], });
			// menus.getAll() does not exist in Firefox — track the
			// created items ourselves (menus.create throws on invalid
			// params, so reaching here means the item is registered).
			menuTelemetry.items.push({ id: item.id, title: item.title, });
		}
		catch (error) { logBoot("menu-create-fail", `${item.id} ${error && error.message || error}`); }
	}
}

/** Per-tab visibility: flip when a tab menu opens (menus.onShown fires
 *  for every menu that contains our items — plain tab rows in the TST
 *  sidebar, the native tab bar, and TST's overridden icon menus alike).
 *  Native menus only open for TRUSTED events, so the E2E drives this
 *  same function through the internal test hook instead. */
const menuTelemetry = { shownCount: 0, lastTabId: null, lastPutVisible: null, lastTakeVisible: null, items: [], };

async function applyMenuVisibility (tabId) {
	const isShelved = shelved.has(tabId);
	let pinned = false;
	try { pinned = (await browser.tabs.get(tabId)).pinned; }
	catch (_error) { /* closed meanwhile */ }
	try {
		const putVisible = !isShelved && !pinned;
		await browser.menus.update(MENU_PUT, { visible: putVisible, });
		await browser.menus.update(MENU_TAKE, { visible: isShelved, });
		await browser.menus.refresh();
		menuTelemetry.shownCount++;
		menuTelemetry.lastTabId = tabId;
		menuTelemetry.lastPutVisible = putVisible;
		menuTelemetry.lastTakeVisible = isShelved;
	}
	catch (error) { logBoot("menu-update-fail", `${tabId} ${error && error.message || error}`); }
}

browser.menus.onShown.addListener((info, tab) => {
	if (!info?.contexts?.includes("tab") || !tab?.id) { return; }
	applyMenuVisibility(tab.id);
});

browser.menus.onClicked.addListener((info, tab) => {
	const tabId = tab?.id;
	if (tabId == null) { return; }
	if (info.menuItemId == MENU_PUT) { putOnShelf(tabId); }
	else if (info.menuItemId == MENU_TAKE) { takeOffShelf(tabId); }
});

// ---------------------------------------------------------------------------
// 5. icon interaction

/** The member id encoded in the clicked extra-contents element, if ours. */
function shelfTargetOf (message) {
	const html = String(message?.originalTarget || "");
	const match = html.match(/data-tab-id="(\d+)"/);
	return match ? Number(match[1]) : null;
}

async function onExtraContentsMousedown (message) {
	if (!tstUsable) { return false; }
	const memberId = shelfTargetOf(message);
	if (memberId == null || !shelved.has(memberId)) { return false; }
	const button = message?.button;
	if (button == 0) {
		await selectShelfTab(memberId);
		return true; // cancel: the owner row must not activate on mousedown
	}
	if (button == 1) {
		browser.tabs.remove(memberId).catch(() => {});
		return true;
	}
	return false; // right-click: TST routes the tab's own context menu
}

/** Fallback path (mouseup): idempotent — activating twice is harmless. */
async function onExtraContentsClicked (message) {
	if (!tstUsable) { return false; }
	const memberId = shelfTargetOf(message);
	if (memberId == null || !shelved.has(memberId)) { return false; }
	if (message?.button == 1) { return true; }
	await selectShelfTab(memberId);
	return true;
}

/** Selection on the shelf: fold the previous member, unfold this one,
 *  activate it — one subtree visible per shelf (spec shelf-nesting). */
async function selectShelfTab (memberId) {
	const tab = await browser.tabs.get(memberId).catch(() => null);
	const windowId = tab?.windowId;
	if (windowId == null) { return; }
	const cached = windows.get(windowId);
	let outgoingId = null;
	if (cached) {
		// the member that currently owns the shelf's one visible row: the
		// previous active tab, if it is shelved
		const previousActive = [...cached.tabsById.values()].find(candidate => candidate.active && !candidate.pinned);
		if (previousActive && previousActive.id != memberId && shelved.has(previousActive.id)) {
			outgoingId = previousActive.id;
		}
		const owner = cached.derivation.shelfOf.get(memberId);
		const previous = cached.derivation.selectedOfShelf.get(owner);
		if (previous != null && previous != memberId) {
			// its children are about to animate away: keep its own row
			// until the animation is over (see hideGuard)
			guardRow(previous);
			await TST.methods.collapseTree({ tab: previous, windowId, }).catch(() => {});
		}
	}
	await TST.methods.expandTree({ tab: memberId, windowId, }).catch(() => {});
	// The row swap must look atomic: the sidebar renders in batched
	// frames, so the outgoing member's row has to be reclaimed in the
	// SAME batch as the incoming one's appears.  Both calls are therefore
	// issued without awaiting the first — round-trip latencies measured
	// through separate awaits left ~33 ms (two frames) with two member
	// rows painted, which reads as the tree bouncing by one row.
	// The hide may be processed before the activation (and be refused
	// because the tab is still active); the retry covers that order.
	const reclaimable = outgoingId != null && !hideGuard.has(outgoingId);
	const activation = browser.tabs.update(memberId, { active: true, }).catch(() => null);
	// issued without awaiting the activation: the parent processes the two
	// messages in order, so the reveal and the hide land in the same task
	// and TST's sidebar paints them in one frame
	const hideAttempt = reclaimable ? hideNow(outgoingId) : Promise.resolve(true);
	await activation;
	if (reclaimable && !(await hideAttempt.catch(() => false))) {
		await hideNow(outgoingId);
	}
	scheduleRederive(windowId);
}

/** Hide one tab right away, recording it as OUR hide (see hiddenByUs). */
async function hideNow (tabId) {
	try {
		const hid = await browser.tabs.hide([tabId]);
		if (Array.isArray(hid) && hid.includes(tabId)) {
			hiddenByUs.add(tabId);
			await rememberHidden([tabId], true);
			return true;
		}
		return false;
	}
	catch (error) { logBoot("hide-now-fail", `${tabId} ${error && error.message || error}`); return false; }
}

// ---------------------------------------------------------------------------
// 6. TST-behavior cancellation (scroll)

/** A shelved tab has no row: cancel TST's scroll-to-row and scroll to the
 *  owning row instead (the root shelf is fixed at the top: nothing to do). */
async function onTryScrollToActivatedTab (message) {
	const tabId = message?.tab?.id;
	if (!shelved.has(tabId)) { return false; }
	const cached = windows.get(message?.tab?.windowId);
	const owner = cached?.derivation.shelfOf.get(tabId);
	if (owner != null && owner !== ROOT_SHELF) {
		TST.methods.scroll({ tabId: owner, }).catch(() => {});
	}
	return true;
}

// ---------------------------------------------------------------------------
// 7. put/take state machine

async function putOnShelf (tabId) {
	const tab = await browser.tabs.get(tabId).catch(() => null);
	if (!tab || tab.pinned || tab.incognito) { return false; }
	// The pre-shelve position, captured BEFORE the placement move: the
	// member block will relocate the tab, take-off restores it.  A tab
	// that re-enters shelving (take + put again) stores a fresh one; a
	// shelf-to-shelf drag keeps the original.
	const existing = await browser.sessions.getTabValue(tabId, FLAG_KEY).catch(() => null);
	const prev = existing && existing.prev
		? existing.prev
		: { windowId: tab.windowId, index: tab.index, };
	await browser.sessions.setTabValue(tabId, FLAG_KEY, { on: true, prev, }).catch(() => {});
	shelved.add(tabId);
	rememberAppend(tabId);
	// fold the subtree under TST's own collapse: the confirmation dialog,
	// the twisty state and restart persistence all come for free.
	// windowId is load-bearing (see applyTabStates).
	guardRow(tabId);
	await TST.methods.collapseTree({ tab: tabId, windowId: tab.windowId, }).catch(() => {});
	scheduleRederive(tab.windowId);
	logBoot("put", `tab ${tabId} under ${tab.openerTabId}`);
	return true;
}

async function takeOffShelf (tabId) {
	const stored = await browser.sessions.getTabValue(tabId, FLAG_KEY).catch(() => null);
	await browser.sessions.removeTabValue(tabId, FLAG_KEY).catch(() => {});
	shelved.delete(tabId);
	appendSeq.delete(tabId);
	// the row comes back: a tab we hid has none at all (0.1.4)
	const wasHidden = hiddenByUs.delete(tabId);
	const tab = await browser.tabs.get(tabId).catch(() => null);
	if (tab) {
		// only OUR hides are ours to lift: a tab that a container filter
		// hid must stay hidden, or taking it off the shelf would defeat
		// the workspace it is filtered out of.
		if (wasHidden) {
			await browser.tabs.show([tabId]).catch(error => logBoot("show-fail", `${tabId} ${error && error.message || error}`));
		}
		await restorePreShelvePosition(tab, stored && stored.prev);
		scheduleRederive(tab.windowId);
	}
	logBoot("take", `tab ${tabId}`);
	return true;
}

/** Return the tab to the strip position it had before it was shelved
 *  (spec shelf-pinning): move-before the tab now occupying that index —
 *  best effort, only when the tab still lives in the same window. */
async function restorePreShelvePosition (tab, prev) {
	if (!prev || prev.windowId != tab.windowId) { return; }
	const tabs = await browser.tabs.query({ windowId: tab.windowId, }).catch(() => []);
	if (!tabs.length) { return; }
	const sorted = tabs.slice().sort((a, b) => a.index - b.index);
	const index = Math.max(0, Math.min(prev.index, sorted.length - 1));
	const ref = sorted.find(t => t.index === index) || sorted[sorted.length - 1];
	if (!ref || ref.id === tab.id) { return; }
	await TST.methods.moveBefore({ tab: tab.id, windowId: tab.windowId, referenceTabId: ref.id, followChildren: true, })
		.catch(error => logBoot("restore-fail", `${tab.id} ${error && error.message || error}`));
}

// ---------------------------------------------------------------------------
// 8. tab/window events, pin guard

browser.tabs.onRemoved.addListener(tabId => {
	faviconMemory.delete(tabId);
	hideGuard.delete(tabId);
	hiddenByUs.delete(tabId);
	if (shelved.delete(tabId)) { scheduleRederiveAll(); }
});

browser.tabs.onActivated.addListener(activeInfo => {
	// end the previous member's reveal immediately (see rehideMembersNow)
	rehideMembersNow(activeInfo.windowId);
	scheduleRederive(activeInfo.windowId);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	if (changeInfo.pinned === true && shelved.has(tabId)) {
		// Firefox pinning and shelving are mutually exclusive: a pinned
		// tab lives in the global pinned box, outside the tree; keeping
		// the flag would hide it from both places.
		logBoot("pin-guard", `tab ${tabId} unpinned-from-shelf`);
		takeOffShelf(tabId);
		return;
	}
	if (shelved.has(tabId) || (changeInfo.hidden !== undefined)) {
		scheduleRederive(tab.windowId);
	}
});

browser.tabs.onMoved.addListener((_tabId, moveInfo) => {
	scheduleRederive(moveInfo.windowId);
});
browser.tabs.onAttached.addListener((_tabId, attachInfo) => {
	scheduleRederive(attachInfo.newWindowId);
	scheduleRederiveAll();
});
browser.tabs.onDetached.addListener((_tabId, detachInfo) => {
	scheduleRederive(detachInfo.oldWindowId);
	scheduleRederiveAll();
});

browser.windows.onRemoved.addListener(async windowId => {
	timers.delete(windowId);
	windows.delete(windowId);
	const live = new Set((await browser.tabs.query({})).map(tab => tab.id));
	renderer.forgetWindow(windowId, live);
});

// ---------------------------------------------------------------------------
// boot

(async () => {
	// menu items are TST-independent: create them even when TST is absent
	// or broken, so the menu is present from the very first moment.
	createMenuItems();
	await loadShelvedFromSessions();
	await register();
	if (tstUsable) {
		await scheduleRederiveAll();
		// boot reconciliation: collapse stray multiple-expanded shelves
		for (const windowId of await normalWindows()) {
			await rederive(windowId, { reconcile: true, }).catch(error =>
				logBoot("boot-reconcile-fail", `${windowId} ${error && error.message || error}`));
		}
	}
})();

// ---------------------------------------------------------------------------
// 9. internal API for the E2E smoke page (-e2e builds only)

browser.runtime.onMessage.addListener((message, _sender) => {
	(message = message || {});
	if (!String(browser.runtime.getManifest().version).endsWith("-e2e")) { return undefined; }
	const outcome = (async () => {
		switch (message.type) {
		case "test:state": {
			const shelves = {};
			const favicons = {};
			for (const [windowId, { derivation, tabsById, }] of windows.entries()) {
				shelves[windowId] = {
					shelves: [...derivation.shelves.entries()].map(([owner, members]) => [owner == ROOT_SHELF ? "root" : owner, members]),
					badges: [...derivation.badgeIds],
					highlights: [...derivation.highlightIds],
					selected: [...derivation.selectedOfShelf.entries()].map(([owner, id]) => [owner == ROOT_SHELF ? "root" : owner, id]),
				};
				// the favicon the derivation renders for each member —
				// the sticky one while the tab is loading (resolveFavicons)
				for (const id of derivation.shelvedVisible) {
					const tab = tabsById.get(id);
					if (tab && tab.favIconUrl) { favicons[String(id)] = tab.favIconUrl; }
				}
			}
			const menuItems = menuTelemetry.items;
			return {
				registered: TST.isRegistered, usable: tstUsable,
				shelved: [...shelved], hiddenByUs: [...hiddenByUs],
				shelves, favicons,
				menu: { ...menuTelemetry, items: menuItems, },
			};
		}
		case "test:put": return { ok: await putOnShelf(message.tabId), };
		case "test:take": return { ok: await takeOffShelf(message.tabId), };
		case "test:probe-hidden": {
			// Characterize Firefox's invariant: can a hidden tab become
			// the active tab without being revealed, and can an active
			// tab be hidden again?  (0.1.5 relies on the answer.)
			const scratch = await browser.tabs.create({ windowId: message.windowId, url: "about:blank", active: false, });
			const out = { id: scratch.id, };
			try { out.hid = await browser.tabs.hide([scratch.id]); }
			catch (error) { out.hideError = String(error); }
			out.hiddenAfterHide = (await browser.tabs.get(scratch.id)).hidden;
			await browser.tabs.update(scratch.id, { active: true, });
			let live = await browser.tabs.get(scratch.id);
			out.afterActivate = { hidden: live.hidden, active: live.active, };
			try { out.hid2 = await browser.tabs.hide([scratch.id]); }
			catch (error) { out.hideError2 = String(error); }
			live = await browser.tabs.get(scratch.id);
			out.afterRehide = { hidden: live.hidden, active: live.active, };
			await browser.tabs.remove(scratch.id).catch(() => {});
			return out;
		}
		case "test:navigate": {
			await browser.tabs.update(message.tabId, { url: message.url, }).catch(() => {});
			return { ok: true, };
		}
		case "test:menu-shown": {
			// Native menus open only for trusted events (impossible in the
			// headless rig) — run the menus.onShown visibility logic directly.
			await applyMenuVisibility(message.tabId);
			return { ok: true, menu: { ...menuTelemetry, items: menuTelemetry.items, }, };
		}
		case "test:redrive": {
			await rederive(message.windowId, { reconcile: !!message.reconcile, });
			return { ok: true, };
		}
		default: return undefined;
		}
	})();
	outcome.catch(error => logBoot("msg-fail", `${message.type} ${error && error.message || error}`));
	return outcome;
});

// E2E build gate: the smoke page is only ever shipped in `make e2e` runs.
if (String(browser.runtime.getManifest().version).endsWith("-e2e")) {
	logBoot("e2e-gate", "firing");
	browser.tabs.create({ url: browser.runtime.getURL("tests.html?auto=1"), active: true, })
		.then(tab => logBoot("e2e-gate", `opened tab ${tab.id}`))
		.catch(error => logBoot("e2e-gate", `FAILED ${error && error.message || error}`));
}
