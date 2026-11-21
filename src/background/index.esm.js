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
import { derive, indexTree, straysToCollapse, subtreeSizes, treePositions, nextPlacementMove, resolveFavicons, mustShowTabs, danglingMembers, ROOT_SHELF } from "./logic.esm.js";
import { createRenderer } from "./render.esm.js";
import { SHELF_STYLE } from "./style.esm.js";

const RECOMPUTE_DELAY_MS = 120;

/** The smoke page and the E2E driver only exist in `make e2e` builds. */
const E2E_BUILD = String(browser.runtime.getManifest().version).endsWith("-e2e");

// The internal test API must answer BOTH our own pages (runtime.onMessage)
// and pages of OTHER extensions (runtime.onMessageExternal — the E2E drives
// the addon from the tab-hosted TST sidebar, which is TST's page).  It is
// registered here, before the TST client below: Firefox takes the FIRST
// non-undefined response, and the donor client answers `true` to every
// external message it does not recognize.
if (E2E_BUILD) {
	// eslint-disable-next-line no-use-before-define
	browser.runtime.onMessage.addListener(onTestMessage);
	// eslint-disable-next-line no-use-before-define
	browser.runtime.onMessageExternal.addListener(onTestMessage);
}

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
/** @type {Map<number|string, number>} owner -> rows the shelf needs.
 *  Used by the E2E to drive the A3 gate directly; normally the line count
 *  comes from computeShelfLines() below. */
const lineOverrides = new Map;
/** Whether the TST build supports rows of N whole lines and row-less tabs
 *  (the A3/B patch).  Advertised through TST's minor version — a stock
 *  4.4.x ignores both. */
let tstShelfCapabilities = { lines: false, rowLess: false, };
/** @type {Map<number, number>} windowId -> width of the tab bar area, as
 *  reported by TST.  The sidebar is the only party that knows its own width,
 *  and a shelf's line count depends on it (TST 4.5 "tabbar-resized"). */
const sidebarWidths = new Map;
/** @type {Map<number, Map<number|null, number>>} windowId -> owner -> lines
 *  computed by the last derivation. */
const shelfLines = new Map;
/** @type {Set<number>} members rendered row-less through TST (feature 1:
 *  a childless shelved tab has no row at all, yet is never hidden). */
const rowLessByUs = new Set;
/** "auto" | "scroll" | "extend" — what a crowded shelf does.  "auto" extends
 *  the row in whole lines when TST supports it, and scrolls otherwise. */
const SETTING_LAYOUT = "shelf-layout";
let shelfLayout = "auto";

/** One shelf icon cell: TST's faviconized tab size (34 px at scale 1) plus
 *  the strap's 3 px gap. */
const SHELF_CELL_WIDTH = 37;
const SHELF_CELL_GAP = 3;
/** Share of the tab bar width the shelf may use (spec: at most 2/3 of the
 *  owner's row), minus a small allowance for the row's own margins. */
const SHELF_WIDTH_SHARE = 2 / 3;
const SHELF_WIDTH_MARGIN = 8;

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

/** The one user-facing setting: what a crowded shelf does.  "auto" grows the
 *  owner row in whole lines when TST supports it (TST 4.5), and scrolls
 *  within one line otherwise. */
async function loadSettings () {
	const stored = await browser.storage.local.get({ [SETTING_LAYOUT]: "auto", }).catch(() => ({}));
	const value = stored[SETTING_LAYOUT];
	shelfLayout = ["auto", "scroll", "extend",].includes(value) ? value : "auto";
	logBoot("settings", `layout=${shelfLayout}`);
}

browser.storage.onChanged.addListener((changes, area) => {
	if (area != "local" || !(SETTING_LAYOUT in changes)) { return; }
	const value = changes[SETTING_LAYOUT].newValue;
	shelfLayout = ["auto", "scroll", "extend",].includes(value) ? value : "auto";
	logBoot("settings", `layout=${shelfLayout}`);
	scheduleRederiveAll();
});

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
		"sidebar-show": message => {
			recordSidebarWidth(message);
			// A sidebar that opens LATER missed every state we applied while it
			// was closed: TST exports only its own safe states on a sidebar's
			// initial import (common/TreeItem.js exportTab), so addon states are
			// not in it.  Forget both ledgers and re-apply from scratch.
			rowLessByUs.clear();
			renderer.forceStateResync();
			if (message?.windowId != null) { scheduleRederive(message.windowId); }
			onTabsRendered([], message?.windowId);
		},
		"tabbar-resized": message => recordSidebarWidth(message),
		"extra-contents-mousedown": message => onExtraContentsMousedown(message),
		"extra-contents-clicked": message => onExtraContentsClicked(message),
		"try-collapse-tree-from-other-expansion": message => shelved.has(message?.tab?.id),
		"try-scroll-to-activated-tab": message => onTryScrollToActivatedTab(message),
	},
	onError: error => logBoot("tst-error", String(error && error.message || error).slice(0, 120)),
});

/** "extend" grows the owner row in whole lines; "scroll" keeps one line and
 *  scrolls the strap horizontally. */
function shelfLayoutMode () {
	if (shelfLayout == "scroll") { return "scroll"; }
	if (shelfLayout == "extend") { return tstShelfCapabilities.lines ? "extend" : "scroll"; }
	return tstShelfCapabilities.lines ? "extend" : "scroll";
}

/** How many whole lines the strap of one shelf needs.  1 means "fits on the
 *  owner's own line".  Requires TST's A3 capability and the sidebar width;
 *  without either the shelf stays on one line and scrolls. */
function computeShelfLines (windowId, members) {
	if (shelfLayoutMode() != "extend") { return 1; }
	const width = sidebarWidths.get(windowId);
	if (!(width > 0)) { return 1; }
	// the last cell of a line needs no trailing gap
	const available = Math.floor((width * SHELF_WIDTH_SHARE) - SHELF_WIDTH_MARGIN);
	const columns = Math.max(1, Math.floor((available + SHELF_CELL_GAP) / SHELF_CELL_WIDTH));
	return Math.max(1, Math.ceil(members.length / columns));
}

/** The line count the renderer declares for one owner's strap. */
function linesOf (owner, windowId) {
	const override = lineOverrides.get(owner ?? "root");
	if (override) { return override; }
	const perWindow = shelfLines.get(windowId);
	return (perWindow && perWindow.get(owner ?? ROOT_SHELF)) || 1;
}

function recordSidebarWidth (message) {
	const windowId = message?.windowId;
	const width = Number(message?.width);
	if (windowId == null || !(width > 0)) { return; }
	if (sidebarWidths.get(windowId) == width) { return; }
	sidebarWidths.set(windowId, width);
	// every shelf's line count depends on it
	scheduleRederive(windowId);
}

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
	// A3 (rows of N whole lines) and B (row-less tabs) are what TST 4.5
	// carries.  A stock 4.4.x silently ignores both: `lines` is not read
	// and the `row-less` state is inert, so the addon degrades to hiding
	// members and to a single-line scrolling shelf.
	const minor = parseInt(String(version || "0").split(".")[1], 10) || 0;
	tstShelfCapabilities = {
		lines:   major > 4 || (major == 4 && minor >= 5),
		rowLess: major > 4 || (major == 4 && minor >= 5),
	};
	if (!tstUsable) { logBoot("tst-too-old", String(version)); }
	logBoot("tst-capabilities", JSON.stringify(tstShelfCapabilities));
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
	// FOLD FIRST: a member's subtree may stay unfolded only while its own
	// row is on screen (logic.esm.js danglingMembers).  Folding arms the
	// hide guard for exactly those members, so the hide below waits for
	// TST's collapse animation instead of orphaning the children's rows.
	const mustShow = mustShowTabs({ tree, activeId: tabs.find(tab => tab.active)?.id ?? null, });
	foldDanglingMembers(windowId, tree, mustShow);
	await reconcileHidden(windowId, tabs, mustShow, tree);

	const derivation = derive({ tree, shelved, tabsById, hiddenByUs, });
	// 0.2.0: a crowded shelf grows its row in whole lines instead of
	// scrolling, when TST can do that and the sidebar width is known.
	const lines = new Map;
	for (const [owner, members] of derivation.shelves) {
		lines.set(owner, computeShelfLines(windowId, members));
	}
	shelfLines.set(windowId, lines);
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

/** tabId -> times TST was asked to collapse a dangling member's subtree.
 *  A collapse that never lands must not defer the hide forever, so the
 *  request is bounded: past MAX_FOLD_TRIES the row is reclaimed anyway
 *  (TST then removes the children's rows when its animation ends). */
const foldTries = new Map;
const MAX_FOLD_TRIES = 3;

/**
 * Fold the subtrees of "dangling" members (logic.esm.js
 * danglingMembers): a shelved tab's subtree may stay unfolded only while
 * its own row is on screen.  When the user activates an UNSHELVED
 * sibling, the member's row is reclaimed without any shelf selection
 * event, and 0.1.6 left the children rendered under a parent row that no
 * longer existed (user-reported).
 *
 * `hideGuard` is armed BEFORE this returns, so the `reconcileHidden`
 * pass that follows in the same derivation defers those hides until
 * TST's collapse animation (configs.collapseDuration) has removed the
 * children's rows — the parent's row must outlive its children's rows.
 */
function foldDanglingMembers (windowId, tree, mustShow) {
	if (!tstUsable || !tree) { return 0; }
	const ids = danglingMembers({ tree, shelved, mustShow, });
	for (const id of [...foldTries.keys()]) {
		if (!ids.includes(id)) { foldTries.delete(id); }
	}
	for (const id of ids) {
		const tries = (foldTries.get(id) || 0) + 1;
		foldTries.set(id, tries);
		if (tries > MAX_FOLD_TRIES) {
			logBoot("fold-give-up", `window ${windowId} tab ${id} tries=${tries}`);
			continue;
		}
		guardRow(id);
		TST.methods.collapseTree({ tab: id, windowId, })
			.catch(error => logBoot("fold-fail", `${id} ${error && error.message || error}`));
	}
	return ids.length;
}

/** Hide the members of this window; bring back members we hid that left
 *  the shelf.  Mutates the `tabs` records so the derivation sees the
 *  truth: tabs.query snapshots taken before a hide are stale. */
async function reconcileHidden (windowId, tabs, mustShow = new Set, tree = null) {
	if (!tabs.length) { return; }
	const byId = new Map(tabs.map(tab => [tab.id, tab]));

	// Feature 1 and the fold-until-selected rule, on a TST with the row-less
	// capability: a CHILDLESS member never renders a row at all (it is NOT
	// hidden — the tab stays visible to the browser, nothing is revealed on
	// activation and no row ever swaps in), and a member WITH children is
	// row-less only while it is neither the active tab nor an ancestor of
	// it: when it becomes active its row comes back, and its subtree hangs
	// from it (spec shelf-nesting).  Its subtree is folded first —
	// foldDanglingMembers ran before this and armed `hideGuard` — so the
	// transition waits for TST's collapse animation to remove the children's
	// rows, exactly like the hide path below.
	//
	// In this mode nothing is ever hidden: the `tabHide` lever stays unused.
	const now = Date.now();
	let deferredUntil = 0;
	const wantRowLess = new Set;
	const rowLessMode = tstShelfCapabilities.rowLess && !!tree;
	if (rowLessMode) {
		const { hasChildIds, } = indexTree(tree);
		for (const id of shelved) {
			const tab = byId.get(id);
			if (!tab || tab.pinned) { continue; }
			const childless = !hasChildIds.has(id);
			if (!childless && mustShow.has(id)) { continue; } // row is the subtree's anchor
			if (!childless) {
				const guardedUntil = hideGuard.get(id);
				if (guardedUntil && now < guardedUntil) {
					deferredUntil = Math.max(deferredUntil, guardedUntil);
					continue;
				}
				if (guardedUntil) { hideGuard.delete(id); }
			}
			wantRowLess.add(id);
		}
	}
	const toRowLess = [...wantRowLess].filter(id => !rowLessByUs.has(id));
	const offRowLess = [...rowLessByUs].filter(id => !wantRowLess.has(id));
	if (toRowLess.length) {
		await Promise.all(toRowLess.map(id => TST.methods.addTabState({ tab: id, state: "row-less", windowId, })
			.catch(error => logBoot("rowless-fail", `${id} ${error && error.message || error}`))));
		for (const id of toRowLess) { rowLessByUs.add(id); }
		logBoot("rowless", `window ${windowId} tabs=${toRowLess.join(",")}`);
	}
	if (offRowLess.length) {
		await Promise.all(offRowLess.map(id => TST.methods.removeTabState({ tab: id, state: "row-less", windowId, })
			.catch(() => {})));
		for (const id of offRowLess) { rowLessByUs.delete(id); }
		logBoot("rowless-off", `window ${windowId} tabs=${offRowLess.join(",")}`);
	}
	// Firefox refuses to hide the ACTIVE tab and refuses to empty a
	// window: both cases are filtered out here rather than failing the
	// whole batch (one bad id rejects the entire tabs.hide call).
	// `mustShow` adds the active tab's ancestors: a hidden parent has no
	// rendered descendants, so reclaiming an ancestor's row would take
	// the active tab's own row (and any nested shelf's strap) with it.
	const toHide = [...shelved].filter(id => {
		const tab = byId.get(id);
		if (!tab || tab.hidden || tab.pinned || mustShow.has(id)) { return false; }
		// a row-less member is already absent from the sidebar; hiding it
		// would add the tabHide lever for no gain
		if (wantRowLess.has(id)) { return false; }
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
	// a member that switched to the row-less presentation must stop being
	// hidden: `hidden` is a browser-level state and would make the tab
	// appear/disappear on activation again
	for (const id of wantRowLess) {
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
	// the member that just lost activation may still have an unfolded
	// subtree: fold it before reclaiming its row (danglingMembers)
	foldDanglingMembers(windowId, cached, mustShow);
	await reconcileHidden(windowId, tabs, mustShow, cached).catch(error =>
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
	linesOf: (owner, windowId) => linesOf(owner, windowId),
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
	// a row-less member has no row to reclaim (feature 1): nothing to hide,
	// nothing to race with
	const reclaimable = outgoingId != null && !hideGuard.has(outgoingId) && !rowLessByUs.has(outgoingId);
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
	if (rowLessByUs.has(tabId)) { return true; } // no row to reclaim
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
	const wasRowLess = rowLessByUs.delete(tabId);
	const tab = await browser.tabs.get(tabId).catch(() => null);
	if (wasRowLess && tab) {
		// the row comes back
		await TST.methods.removeTabState({ tab: tabId, state: "row-less", windowId: tab.windowId, }).catch(() => {});
	}
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
	foldTries.delete(tabId);
	hiddenByUs.delete(tabId);
	rowLessByUs.delete(tabId);
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
	await loadSettings();
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

function onTestMessage (message) {
	(message = message || {});
	if (!E2E_BUILD || !String(message.type || "").startsWith("test:")) { return undefined; }
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
				rowLessByUs: [...rowLessByUs],
				capabilities: tstShelfCapabilities,
				layout: shelfLayoutMode(),
				widths: [...sidebarWidths.entries()],
				lines: [...windows.entries()].map(([id, win]) => [id, [...(shelfLines.get(id) || new Map).entries()]]),
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
		case "test:lines": {
			// A3 gate: make an owner's row N whole lines tall (0 = back to the
			// addon's own computation).
			const key = message.owner == null ? "root" : message.owner;
			if (message.lines > 0) { lineOverrides.set(key, message.lines); }
			else { lineOverrides.delete(key); }
			renderer.invalidate(message.windowId);
			await rederive(message.windowId);
			return { ok: true, capabilities: tstShelfCapabilities, };
		}
		case "test:tab-state": {
			// B gate: apply a TST tab state (e.g. row-less) through the API.
			const method = message.add === false ? "removeTabState" : "addTabState";
			const ok = await TST.methods[method]({ tab: message.tabId, state: message.state, windowId: message.windowId, })
				.catch(error => { logBoot("test-tab-state-fail", String(error && error.message || error)); return false; });
			return { ok, capabilities: tstShelfCapabilities, };
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
}

// E2E build gate: the smoke page is only ever shipped in `make e2e` runs.
if (String(browser.runtime.getManifest().version).endsWith("-e2e")) {
	logBoot("e2e-gate", "firing");
	browser.tabs.create({ url: browser.runtime.getURL("tests.html?auto=1"), active: true, })
		.then(tab => logBoot("e2e-gate", `opened tab ${tab.id}`))
		.catch(error => logBoot("e2e-gate", `FAILED ${error && error.message || error}`));
}
