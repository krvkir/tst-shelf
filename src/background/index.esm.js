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
import { derive, straysToCollapse, ROOT_SHELF } from "./logic.esm.js";
import { createRenderer } from "./render.esm.js";
import { SHELF_STYLE } from "./style.esm.js";

const RECOMPUTE_DELAY_MS = 120;
const STATE_SHELVED = "tst-shelf-shelved";
const FLAG_KEY = "tst-shelf";

/** @type {Set<number>} tab ids carrying the sticky flag */
const shelved = new Set;
/** @type {Map<number, {derivation: object, tabsById: Map}>} last derivation per window */
const windows = new Map;
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
		if (values[index] && values[index].on) { shelved.add(tab.id); }
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

async function rederive (windowId, { reconcile = false, } = {}) {
	if (!tstUsable) { return; }
	const tree = await TST.methods.getLightTree({ windowId, }).catch(error => {
		logBoot("light-tree-fail", `${windowId} ${error && error.message || error}`);
		return null;
	});
	const tabs = await browser.tabs.query({ windowId, });
	if (!tree || tabs.length == 0) { return; }
	const tabsById = new Map(tabs.map(tab => [tab.id, tab]));

	const derivation = derive({ tree, shelved, tabsById, });
	windows.set(windowId, { derivation, tabsById, });
	await renderer.applyDerivation({ windowId, derivation, tabsById, });

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

function onTreeMutated (windowId) {
	if (!tstUsable || windowId == null) { return; }
	scheduleRederive(windowId);
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
	if (cached) {
		const owner = cached.derivation.shelfOf.get(memberId);
		const previous = cached.derivation.selectedOfShelf.get(owner);
		if (previous != null && previous != memberId) {
			await TST.methods.collapseTree({ tab: previous, windowId, }).catch(() => {});
		}
	}
	await TST.methods.expandTree({ tab: memberId, windowId, }).catch(() => {});
	await browser.tabs.update(memberId, { active: true, }).catch(() => {});
	scheduleRederive(windowId);
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
	await browser.sessions.setTabValue(tabId, FLAG_KEY, { on: true, }).catch(() => {});
	shelved.add(tabId);
	// fold the subtree under TST's own collapse: the confirmation dialog,
	// the twisty state and restart persistence all come for free.
	// windowId is load-bearing (see applyTabStates).
	await TST.methods.collapseTree({ tab: tabId, windowId: tab.windowId, }).catch(() => {});
	scheduleRederive(tab.windowId);
	logBoot("put", `tab ${tabId} under ${tab.openerTabId}`);
	return true;
}

async function takeOffShelf (tabId) {
	await browser.sessions.removeTabValue(tabId, FLAG_KEY).catch(() => {});
	shelved.delete(tabId);
	const tab = await browser.tabs.get(tabId).catch(() => null);
	if (tab) { scheduleRederive(tab.windowId); }
	logBoot("take", `tab ${tabId}`);
	return true;
}

// ---------------------------------------------------------------------------
// 8. tab/window events, pin guard

browser.tabs.onRemoved.addListener(tabId => {
	if (shelved.delete(tabId)) { scheduleRederiveAll(); }
});

browser.tabs.onActivated.addListener(activeInfo => {
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
			for (const [windowId, { derivation, }] of windows.entries()) {
				shelves[windowId] = {
					shelves: [...derivation.shelves.entries()].map(([owner, members]) => [owner == ROOT_SHELF ? "root" : owner, members]),
					ghosts: [...derivation.ghostIds],
					badges: [...derivation.badgeIds],
					selected: [...derivation.selectedOfShelf.entries()].map(([owner, id]) => [owner == ROOT_SHELF ? "root" : owner, id]),
				};
			}
			const menuItems = menuTelemetry.items;
			return {
				registered: TST.isRegistered, usable: tstUsable,
				shelved: [...shelved], shelves,
				menu: { ...menuTelemetry, items: menuItems, },
			};
		}
		case "test:put": return { ok: await putOnShelf(message.tabId), };
		case "test:take": return { ok: await takeOffShelf(message.tabId), };
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
