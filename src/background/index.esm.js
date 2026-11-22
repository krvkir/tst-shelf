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
 *   8b. hint mode (the keyboard codes; pure planner in logic.esm.js)
 *   9. internal API for the E2E smoke page (-e2e builds only)
 *
 * Design contract: openspec/changes/add-shelf-foundation/{design.md},
 * the only stored state is the sticky per-tab session flag `tst-shelf`;
 * every shelf assignment, ghost, badge and selection is DERIVED from the
 * live TST light tree + browser.tabs on every structural event.
 * Hint mode is runtime-only presentation state: nothing in it hides a
 * tab or touches TST's tree data, so it has no boot-release path.
 */
import tstApi from "./tst-api.esm.js";
import { derive, indexTree, straysToCollapse, subtreeSizes, treePositions, nextPlacementMove, planExtremePlacementMove, resolveFavicons, mustShowTabs, danglingMembers, planReveals, isSubtreeFolded, planRestoreMove, subtreeIds, siblingListOf, ROOT_SHELF, assignHints, hintMatches, normalizeHintCharset, isSpecialPageUrl, planHintTargets, HINT_CHARSET, } from "./logic.esm.js";
import { createRenderer } from "./render.esm.js";
import { SHELF_STYLE } from "./style.esm.js";

const RECOMPUTE_DELAY_MS = 120;
/** The badge mode: "plus" (default) | "count" (the descendant number). */
const BADGE_MODE_KEY = "badgeMode";
/** Hint-code alphabet (options page): raw string, normalized on read;
 *  empty/too-short values fall back to HINT_CHARSET. */
const HINT_CHARSET_KEY = "hintCharset";
/** No hint codes on pages executeScript cannot inject into (about:,
 *  extension pages — the TST group tabs among them), so one can never
 *  be navigated INTO and strand the keyboard.  Default ON. */
const HINT_EXCLUDE_SPECIAL_KEY = "hintExcludeSpecialPages";

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
	// diagnostic-only receipt trace: which messages actually reach the
	// background from other extensions, in which shape (sync undefined
	// never answers, so this cannot affect the reply races)
	browser.runtime.onMessageExternal.addListener(message => {
		diag(`ext-in type=${message && message.type} bulk=${Array.isArray(message && message.messages)}`);
		return undefined;
	});
}

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
/** The badge mode is a user option (storage.local.badgeMode); its
 *  change re-renders the straps through the next re-derivations. */
let badgeMode = "plus";
/** Hint options (storage.local): the normalized code alphabet, and
 *  whether special pages are excluded from codes.  Read at boot and on
 *  every change; nothing else caches them (a mode entering mid-change
 *  reads the live values). */
let hintCharset = HINT_CHARSET;
let hintExcludeSpecial = true;
/** @type {Map<number, Map<number, {openedSeen: boolean}>>} windowId -> shelf
 *  owner -> reveal.  A reveal keeps ONE folded owner expanded while a
 *  descendant of it is active, and suppresses every other descendant's row
 *  (planReveals), so activating a shelved tab from a folded owner's shelf
 *  shows that tab's subtree only instead of the owner's whole subtree. */
const reveals = new Map;

/** @type {Map<number, Set<number>>} windowId -> ids of tabs TST has
 *  rendered rows for (the virtual-scroll viewport — tabs-rendered /
 *  tabs-unrendered are rAF-batched broadcasts of the rendered set).
 *  Consumed by hint mode: only rendered rows carry row labels.  TST
 *  keeps NO initial dump — the set warms from the live broadcasts, and
 *  a window with an empty ledger (nothing rendered since our boot)
 *  falls back to every visible tab when the mode enters. */
const renderedTabs = new Map;

/** @type {Map<number, {open: boolean}>} windowId -> the last
 *  sidebar-show/-hide TST broadcast for that window (sidebar-hide
 *  carries the post-event openCount; 0 means no sidebar page is left —
 *  panel or tab-hosted copies count).  A window with NO entry has not
 *  been seen since boot: hint mode then decides on the rendered-rows
 *  ledger alone, because a sidebar that was already open when we
 *  registered never broadcasts anything to us (TST's tabs-rendered
 *  fired before our boot — the stale-ledger trap 0.3.3 shipped). */
const sidebarState = new Map;

/** @type {Map<number, number>} windowId -> consecutive failed tree exports;
 *  a failed pass must not silently keep the previous decision in force. */
const treeFetchTries = new Map;
const MAX_TREE_FETCH_TRIES = 5;
/** Ring of the last diagnostics relevant to the E2E (no storage IPC). */
const diagLog = [];
function diag (text) {
	diagLog.push(`${Date.now().toString(36)} ${text}`);
	if (diagLog.length > 300) { diagLog.shift(); }
}

/** @type {Set<number>} tabs whose row a reveal removed by HIDING them.
 *  Separate from `hiddenByUs` on purpose: that set means "hidden but still
 *  an icon on a shelf", and `reconcileHidden` shows such tabs again. */
const suppressedHiddenByUs = new Set;
/** Per-tab session key: true while a reveal keeps the tab hidden.  A crash
 *  mid-reveal must not leave an invisible tab behind (reveals are runtime
 *  state), so the boot path shows every tab carrying it. */
const SUPPRESSED_KEY = "tst-shelf-suppressed";
/** @type {Map<number, number>} tabId -> timestamp until which a suppressed
 *  tab keeps its suppression after the reveal that suppressed it ended.
 *  The owner is folded back at that moment, and TST removes the rows of a
 *  collapse only after `configs.collapseDuration` (150 ms) — lifting the
 *  suppression sooner would paint the siblings for the length of the
 *  animation (the "rows flash" jump). */
const suppressHold = new Map;

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

/** The user options live in storage.local; the options page writes them
 *  and this listener applies them live (a mode flip changes the badge
 *  text in every strap's markup, so the diffing renderer re-sends
 *  exactly the changed straps).  An invalid charset (fewer than two
 *  usable characters) keeps the default and leaves a bootlog line. */
async function loadOptions () {
	const defaults = {
		[BADGE_MODE_KEY]: "plus",
		[HINT_CHARSET_KEY]: "",
		[HINT_EXCLUDE_SPECIAL_KEY]: true,
	};
	const stored = await browser.storage.local.get(defaults).catch(() => null);
	badgeMode = stored?.[BADGE_MODE_KEY] === "count" ? "count" : "plus";
	const charset = normalizeHintCharset(stored?.[HINT_CHARSET_KEY]);
	if (stored?.[HINT_CHARSET_KEY] && !charset) {
		logBoot("hint-charset-invalid", String(stored[HINT_CHARSET_KEY]).slice(0, 40));
	}
	hintCharset = charset || HINT_CHARSET;
	hintExcludeSpecial = stored?.[HINT_EXCLUDE_SPECIAL_KEY] !== false;
}
browser.storage.onChanged.addListener((changes, areaName) => {
	if (areaName !== "local") { return; }
	if (BADGE_MODE_KEY in changes) {
		badgeMode = changes[BADGE_MODE_KEY].newValue === "count" ? "count" : "plus";
		logBoot("badge-mode", badgeMode);
		scheduleRederiveAll();
	}
	if (HINT_CHARSET_KEY in changes) {
		const charset = normalizeHintCharset(changes[HINT_CHARSET_KEY]?.newValue);
		if (changes[HINT_CHARSET_KEY]?.newValue && !charset) {
			logBoot("hint-charset-invalid", String(changes[HINT_CHARSET_KEY].newValue).slice(0, 40));
		}
		hintCharset = charset || HINT_CHARSET;
		logBoot("hint-charset", hintCharset);
	}
	if (HINT_EXCLUDE_SPECIAL_KEY in changes) {
		hintExcludeSpecial = changes[HINT_EXCLUDE_SPECIAL_KEY]?.newValue !== false;
		logBoot("hint-exclude-special", String(hintExcludeSpecial));
	}
});

/** Rebuild the shelved set from per-tab session values after (re)start, and
 *  release any tab a reveal left hidden.
 *
 *  The suppressed-tab bit is only read for tabs that are actually hidden: a
 *  tab a reveal suppressed is hidden by us, so a 350-tab boot reads one
 *  value per hidden tab, not one per tab. */
async function loadShelvedFromSessions () {
	const tabs = await browser.tabs.query({});
	const values = await Promise.all(tabs.map(async tab => {
		const read = key => browser.sessions.getTabValue(tab.id, key).catch(() => null);
		const [flag, suppressed,] = await Promise.all([
			read(FLAG_KEY),
			tab.hidden ? read(SUPPRESSED_KEY) : null,
		]);
		return { flag, suppressed, };
	}));
	const stale = [];
	tabs.forEach((tab, index) => {
		const { flag, suppressed, } = values[index];
		if (suppressed === true) { stale.push(tab.id); }
		if (!flag || !flag.on) { return; }
		shelved.add(tab.id);
		// a member whose row we hid stays OURS across a restart: without
		// this the boot derivation would read it as foreign-hidden
		// (workspace filtering) and leave its icon off the shelf.
		if (flag.hidden) { hiddenByUs.add(tab.id); }
	});
	logBoot("boot-shelved", `${shelved.size} of ${tabs.length} tabs`);
	// a reveal that was running when the browser died left its suppressed
	// tabs hidden; reveals never survive a restart, so show them now
	if (stale.length) { await releaseSuppressed(stale); }
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
		"scroll", "focus-to-extra-contents",
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
		"tabs-rendered": message => onTabsRendered(message?.tabs || [], message?.windowId),
		"tabs-unrendered": message => onTabsUnrendered(message?.tabs || []),
		"sidebar-show": message => {
			// A sidebar that opens LATER missed every state we applied while it
			// was closed: TST exports only its own safe states on a sidebar's
			// initial import (common/TreeItem.js exportTab), so the addon state
			// classes are not in it.  Do NOT drop the renderer's ledger — it is
			// our knowledge of what must be re-applied — force the next pass to
			// re-send every state class instead.  (Hidden members need no such
			// treatment: `hidden` is browser-level, so a fresh sidebar never
			// paints them.)
			if (message?.windowId != null) { sidebarState.set(message.windowId, { open: true, }); }
			renderer.forceStateResync();
			if (message?.windowId != null) { scheduleRederive(message.windowId); }
			onTabsRendered([], message?.windowId);
		},
		"sidebar-hide": message => {
			// The openCount AFTER the disconnect decides: a closed panel
			// with a tab-hosted copy still renders rows (hint mode's
			// labels paint there).  Known-closed is one of hint mode's
			// two decline conditions.
			if (message?.windowId != null) {
				sidebarState.set(message.windowId, { open: (Number(message?.openCount) || 0) > 0, });
			}
		},
		"extra-contents-mousedown": message => onExtraContentsMousedown(message),
		"extra-contents-clicked": message => onExtraContentsClicked(message),
		"extra-contents-keydown": message => onExtraContentsKeydown(message),
		"extra-contents-focus": message => onExtraContentsFocus(message),
		"extra-contents-blur": message => onExtraContentsBlur(message),
		"try-collapse-tree-from-other-expansion": message => shelved.has(message?.tab?.id),
		// TST is about to expand the activated tab AND ALL ITS ANCESTORS
		// (background/handle-tab-focus.js, toBeExpandedAncestors).  For a tab
		// on the shelf of a FOLDED owner that is exactly the "wall of rows"
		// the reveal prevents: we expand the owner ourselves, keep the
		// activated tab's branch and suppress the rest.  Answer truthy ONLY
		// when we take over (tst-api's tryOperationAllowed cancels on any
		// truthy answer).
		"try-expand-tree-from-focused-collapsed-tab": message =>
			maybeBeginReveal(message?.tab?.windowId, message?.tab?.id),
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

/** Below TST 4.0 the extra-contents and menu APIs do not exist, so the
 *  extension stays idle (menu items only). */
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
		// Only a ROOT member may be re-rooted.  A shelved tab cut out of
		// the export because its OWNER was hidden by another addon
		// (container-workspace filtering) still reports its ancestors —
		// re-rooting it would repaint it on the root-shelf strap at
		// #tabbar-top, send the placement loop chasing "the first normal
		// root" (physically MOVING the tab to the top of the strip) and
		// leave no way back to its owner once the workspace is switched
		// off.  Such a member stays out of the walk instead: no icon, no
		// placement, its shelf dormant with its invisible owner.
		if (subtree && subtree.id == id && !(subtree.ancestorTabIds || []).length) {
			roots.push(subtree);
		}
	}
	const indexOf = id => tabsById.get(id)?.index ?? Number.MAX_SAFE_INTEGER;
	roots.sort((a, b) => indexOf(a.id) - indexOf(b.id));
	const spliced = roots.length - (Array.isArray(tree) ? tree.length : 1);
	logBoot("tree-splice", `window ${windowId} wanted=${missing.length} spliced=${spliced}`);
	return roots;
}

/** The live rendered set of a window's sidebar — TST's OWN viewport
 *  filter (get-light-tree with rendered:true + tab:'*' →
 *  getTargetRenderedTabs → the sidebar virtual scroll's rendered ids,
 *  scroll.js:1321-1328: pinned + every rendered row of ANY depth).
 *  The tab:'*' selector is LOAD-BEARING: a windowId-ONLY message makes
 *  TST's getTargetTabs return ROOT tabs (common/tst-api.js: tabQuery =
 *  message.tabs || tabIds || tab || tabId; none → Tab.getRootTabs —
 *  the documented piroor#2763 behaviour), so rendered DESCENDANTS were
 *  filtered away and the harvest yielded a root-only set (bug shipped
 *  in 0.6.0: nested visible tabs got no hint codes).  With tab:'*'
 *  every rendered row becomes one top-level entry; the export may nest
 *  the same tab again under a rendered ancestor — only the top-level
 *  ids are read.  No copy answering (no sidebar, a failed query)
 *  rejects/returns null — the caller falls back to the fold cut alone.
 *  Pinned tabs are in the set; the planner ignores them anyway.  One
 *  copy answers when several exist — whichever replies first
 *  (production has one panel; the tab-hosted copies of E2E/user setups
 *  race, and a wrong window's answer simply fails the tree's tab
 *  filter and yields an empty set → the same fallback). */
async function fetchRenderedIds (windowId) {
	const tree = await TST.methods.getLightTree({ windowId, rendered: true, tab: '*', }).catch(() => null);
	const ids = new Set;
	if (Array.isArray(tree)) {
		for (const node of tree) {
			if (node && node.id != null) { ids.add(node.id); }
		}
	}
	else if (tree && tree.id != null) { ids.add(tree.id); }
	return ids.size ? ids : null;
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
	if (!tree) {
		// A failed tree export used to end the pass silently, leaving the
		// previous decision in force: a member that had just been activated
		// stayed hidden by the pass taken while ANOTHER tab was active, so
		// its children rendered without their parent until some unrelated
		// event re-derived (measured: the trace still named the previous
		// active tab minutes later).  Retry, bounded.
		const tries = (treeFetchTries.get(windowId) || 0) + 1;
		treeFetchTries.set(windowId, tries);
		logBoot("tree-fetch-fail", `window ${windowId} tries=${tries}`);
		diag(`tree-fail w=${windowId} tries=${tries}`);
		if (tries <= MAX_TREE_FETCH_TRIES) { scheduleRederive(windowId); }
		return;
	}
	treeFetchTries.delete(windowId);
	// members keep NO row: hide them (and bring back any we hid that
	// left the shelf, or that must stay visible).
	// FOLD FIRST: a member's subtree may stay unfolded only while its own
	// row is on screen (logic.esm.js danglingMembers).  Folding arms the
	// hide guard for exactly those members, so the hide below waits for
	// TST's collapse animation instead of orphaning the children's rows.
	// WHICH TAB IS ACTIVE is re-read here, not taken from the snapshot
	// above: the snapshot is taken before the tree fetch, and a tab the
	// user just activated (a shelf click, a Ctrl+Tab) is still inactive in
	// it.  `mustShow` — who keeps a row, and therefore who is not hidden —
	// hangs on exactly that flag, so a stale snapshot hid the tab that had
	// just been activated and left its children dangling (measured: the
	// trace named `5` as active minutes after the user had moved on).
	const liveActive = await browser.tabs.query({ windowId, active: true, })
		.then(list => list.shift(), () => null);
	diag(`rederive w=${windowId} active=${liveActive?.id} shelved=${shelved.size}`);
	const activeId = liveActive?.id ?? null;
	const mustShow = mustShowTabs({ tree, activeId, });
	foldDanglingMembers(windowId, tree, mustShow);
	await reconcileHidden(windowId, tabs, mustShow);
	// 0.1.7/0.2.x: a folded owner that a reveal keeps open shows only the
	// active tab's branch — every other descendant loses its row here.
	await reconcileSuppressed(windowId, tree, tabsById, mustShow, activeId);

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
async function reconcileHidden (windowId, tabs, mustShow = new Set) {
	if (!tabs.length) { return; }
	const byId = new Map(tabs.map(tab => [tab.id, tab]));

	// A member's row goes away by HIDING the tab: that is the only lever
	// that removes a tab from TST's renderable set without breaking its
	// uniform-row law (see the section comment above).  The fold-until-
	// selected rule decides WHEN a row may go: a member with children keeps
	// it while it is the active tab or an ancestor of it, because its
	// subtree hangs from it (spec shelf-nesting).  Its subtree is folded
	// first — foldDanglingMembers ran before this and armed `hideGuard` —
	// so the transition waits for TST's collapse animation to remove the
	// children's rows.
	const now = Date.now();
	let deferredUntil = 0;

	// Firefox refuses to hide the ACTIVE tab and refuses to empty a
	// window: both cases are filtered out here rather than failing the
	// whole batch (one bad id rejects the entire tabs.hide call).
	// `mustShow` adds the active tab's ancestors: a hidden parent has no
	// rendered descendants, so reclaiming an ancestor's row would take
	// the active tab's own row (and any nested shelf's strap) with it.
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
		// Commit the ledger only when the browser acknowledged the show:
		// deleting first left a tab hidden forever after a rejected call
		// (nothing would ask for it again — `toShow` is derived from
		// `hiddenByUs`).
		const shown = await browser.tabs.show(toShowIds).then(() => toShowIds, error => {
			logBoot("show-fail", String(error && error.message || error));
			return [];
		});
		for (const id of shown) {
			hiddenByUs.delete(id);
			if (byId.has(id)) { byId.get(id).hidden = false; }
		}
		if (shown.length) {
			await rememberHidden(shown, false);
			logBoot("show", `window ${windowId} tabs=${shown.join(",")}`);
		}
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

// ---------------------------------------------------------------------------
// 3b. reveals: a folded shelf owner shows only the active tab's branch
//
// A folded owner's shelf is the folded view of its subtree.  Activating a
// tab from that shelf needs the owner EXPANDED (TST renders a child row
// only if every ancestor is expanded), and TST's own reaction is to expand
// the tab and all its ancestors — which paints the owner's whole subtree.
// The user vetoed that: only the activated tab's branch may appear, the
// rest of the subtree must stay as folded as it was.  So the reveal
// expands the owner and HIDES every other descendant, and folds the owner
// back when the active tab leaves its subtree.

/** Why the last reveal attempt declined — E2E diagnostics only. */
let revealDebug = null;

function revealsFor (windowId) {
	let map = reveals.get(windowId);
	if (!map) { map = new Map; reveals.set(windowId, map); }
	return map;
}

/**
 * Start (or keep) a reveal for the shelf owner of `tabId`.
 *
 * Returns true when a reveal covers this activation, which is also the
 * cancel verdict for `try-expand-tree-from-focused-collapsed-tab`: TST's
 * expansion of the tab plus its ancestors would reveal the siblings.
 * False lets TST do its normal thing.
 *
 * The suppressed tabs are hidden through browser.tabs.hide() — declared by
 * this addon anyway for member rows — tracked in their own ledger, and
 * restored on the next derivation and after a restart (`SUPPRESSED_KEY`).
 */
function maybeBeginReveal (windowId, tabId) {
	const bail = reason => { revealDebug = `${reason} w=${windowId} t=${tabId}`; return false; };
	if (!tstUsable) { return bail("tst-unusable"); }
	if (windowId == null || tabId == null) { return bail("no-ids"); }
	const cached = windows.get(windowId);
	if (!cached) { return bail("no-cache"); }
	if (!shelved.has(tabId)) { return bail("not-shelved"); }
	const { tree, derivation, } = cached;
	const { hasChildIds, statesById, } = indexTree(tree);
	// A childless member has no subtree to reveal, so TST's ancestor
	// expansion has nothing to take over: let it run.  (This is not about
	// the row — Firefox reveals a hidden tab the moment it is activated,
	// whatever we decide here.)
	if (!hasChildIds.has(tabId)) { return bail("childless"); }
	const owner = derivation.shelfOf.get(tabId);
	if (owner == null) { return bail("no-owner"); } // the root shelf owns no row to expand
	const map = revealsFor(windowId);
	if (!isSubtreeFolded(statesById.get(owner))) {
		// owner already expanded: TST shows its whole subtree, which is the
		// expected behaviour there — but a reveal we started earlier still
		// decides what else is visible
		revealDebug = `owner-open w=${windowId} t=${tabId} o=${owner} states=${JSON.stringify(statesById.get(owner))}`;
		return map.has(owner);
	}
	if (!map.has(owner)) {
		map.set(owner, { openedSeen: false, });
		logBoot("reveal", `window ${windowId} owner ${owner} tab ${tabId}`);
		TST.methods.expandTree({ tab: owner, windowId, })
			.catch(error => logBoot("reveal-fail", `${owner} ${error && error.message || error}`));
		// TST's cancelled reaction also used to unfold this tab's own
		// subtree; the branch must come back whole, children included
		TST.methods.expandTree({ tab: tabId, windowId, }).catch(() => {});
	}
	return true;
}

/** End a reveal: forget it and fold the owner back.  Only ever called for
 *  owners WE expanded — a reveal exists only if its owner read folded when
 *  it was created, and a fold the user applies ends the reveal through
 *  planReveals (see `openedSeen`). */
function endReveal (windowId, owner) {
	const map = reveals.get(windowId);
	if (!map || !map.delete(owner)) { return; }
	logBoot("reveal-end", `window ${windowId} owner ${owner}`);
	// The siblings' rows disappear with TST's collapse animation, which
	// runs for `configs.collapseDuration` BEFORE the rows go.  Lifting
	// their suppression now would paint them for the length of the
	// animation (the bounce the user reported for row swaps).
	const until = Date.now() + COLLAPSE_ANIMATION_GRACE_MS;
	for (const id of suppressedHiddenByUs) { suppressHold.set(id, until); }
	if (!tstUsable) { return; }
	TST.methods.collapseTree({ tab: owner, windowId, })
		.catch(error => logBoot("reveal-fold-fail", `${owner} ${error && error.message || error}`));
}

/**
 * Apply the running reveals: every descendant of a revealed owner that is
 * not on the active tab's branch loses its row.  Members are excluded —
 * their row is the member rule's business, and hiding one here would put a
 * shelf icon's tab into the reveal ledger where the member reconcile cannot
 * see it.
 *
 * The lever is browser.tabs.hide(), the only way to drop a row on a stock
 * TST.  Suppressed tabs are tracked in `suppressedHiddenByUs` —
 * deliberately NOT in `hiddenByUs`, because that set means "hidden, but
 * still shown as a shelf icon" and `reconcileHidden` would show such a tab
 * right back.  The session key `SUPPRESSED_KEY` makes a crash mid-reveal
 * recoverable at boot.
 */
async function reconcileSuppressed (windowId, tree, tabsById, mustShow, activeIdHint = undefined) {
	if (!tree) { return; }
	const now = Date.now();
	// the live active id when the caller has a fresher one than its snapshot
	const activeId = activeIdHint !== undefined ? activeIdHint :
		[...tabsById.values()].find(tab => tab.active && !tab.hidden)?.id ?? null;
	const map = reveals.get(windowId) || new Map;
	const { suppress, prune, } = planReveals({ tree, activeId, reveals: map, mustShow, });
	for (const owner of prune) { endReveal(windowId, owner); }
	// once a derivation has SEEN the owner expanded, a later `collapsed`
	// state on it can only be the user's own fold
	const { statesById, } = indexTree(tree);
	for (const [owner, info] of map) {
		if (!isSubtreeFolded(statesById.get(owner))) { info.openedSeen = true; }
	}
	// a tab another addon hid has no row anyway; hiding it would make this
	// addon answer for someone else's state
	const want = new Set(suppress.filter(id => {
		if (shelved.has(id) || !tabsById.has(id)) { return false; }
		return !tabsById.get(id).hidden || suppressedHiddenByUs.has(id);
	}));
	const toSuppress = [...want].filter(id => !suppressedHiddenByUs.has(id));
	// never empty the window: Firefox refuses it and the whole hide call
	// would fail (the member path guards the same way)
	const visibleCount = [...tabsById.values()].filter(tab => !tab.hidden).length;
	while (toSuppress.length && visibleCount - toSuppress.length < 1) { toSuppress.pop(); }
	if (toSuppress.length) {
		try {
			const hid = await browser.tabs.hide(toSuppress);
			const actuallyHidden = (Array.isArray(hid) ? hid : toSuppress).filter(id => tabsById.has(id));
			for (const id of actuallyHidden) { suppressedHiddenByUs.add(id); }
			await rememberSuppressed(actuallyHidden, true);
			logBoot("suppress-hide", `window ${windowId} tabs=${actuallyHidden.join(",")}`);
		}
		catch (error) { logBoot("suppress-hide-fail", `window ${windowId} ${error && error.message || error}`); }
	}
	// tabs that must keep their row are never suppressed; lift only within
	// this window's tabs (the ledger is global, a foreign window's
	// derivation must not strip them)
	const toLift = [...suppressedHiddenByUs].filter(id => !want.has(id) && tabsById.has(id));
	let deferredUntil = 0;
	const lift = [];
	for (const id of toLift) {
		const until = suppressHold.get(id) || 0;
		if (until > now) {
			deferredUntil = Math.max(deferredUntil, until);
			continue;
		}
		suppressHold.delete(id);
		lift.push(id);
	}
	if (deferredUntil) {
		setTimeout(() => scheduleRederive(windowId), Math.max(20, deferredUntil - now + 20));
	}
	if (lift.length) {
		const lifted = await browser.tabs.show(lift).then(() => lift, error => {
			logBoot("suppress-show-fail", String(error && error.message || error));
			return [];
		});
		for (const id of lifted) { suppressedHiddenByUs.delete(id); }
		await rememberSuppressed(lifted, false);
		if (lifted.length) { logBoot("suppress-off", `window ${windowId} tabs=${lifted.join(",")}`); }
	}
}

/** Persist "this tab is hidden by a reveal" so a crash mid-reveal does not
 *  leave an invisible tab behind: the boot path shows such tabs again. */
async function rememberSuppressed (tabIds, suppressed) {
	await Promise.all(tabIds.map(id =>
		browser.sessions.setTabValue(id, SUPPRESSED_KEY, suppressed)
			.catch(error => logBoot("suppress-memory-fail", `${id} ${error && error.message || error}`))));
}

/** Boot: any tab still hidden because a reveal was running when the browser
 *  died comes back.  Reveals are runtime state and never survive a restart,
 *  so nothing else would ever show such a tab. */
async function releaseSuppressed (tabIds) {
	await browser.tabs.show(tabIds).catch(error => logBoot("suppress-restore-fail", String(error && error.message || error)));
	await rememberSuppressed(tabIds, false);
	logBoot("suppress-restore", `tabs=${tabIds.join(",")}`);
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
	const cachedActiveId = tabs.find(tab => tab.active)?.id ?? null;
	const mustShow = mustShowTabs({ tree: cached, activeId: cachedActiveId, });
	// the member that just lost activation may still have an unfolded
	// subtree: fold it before reclaiming its row (danglingMembers)
	foldDanglingMembers(windowId, cached, mustShow);
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

/**
 * The menu-driven extreme placements ("Place leftmost"/"Place rightmost").
 * Plans against the CACHED tree (a ≤120 ms-stale walk order is exact
 * inside a settled shelf; the post-move re-derivation repairs anything the
 * move disturbed) and applies one TST move with followChildren — the same
 * conventions the automatic placement loop uses.
 */
async function placeOnShelfEdge (tabId, side) {
	if (!tstUsable || !shelved.has(tabId)) { return false; }
	const tab = await browser.tabs.get(tabId).catch(() => null);
	if (!tab) { return false; }
	const windowId = tab.windowId;
	const cached = windows.get(windowId);
	const owner = cached?.derivation.shelfOf.get(tabId);
	if (cached == null || owner == null) { return false; }
	const members = cached.derivation.shelves.get(owner) || [];
	const move = planExtremePlacementMove({
		members,
		tabId,
		side,
		sizes: subtreeSizes(cached.tree),
	});
	if (!move) { return true; } // already at the requested extreme
	const params = { tab: tabId, windowId, referenceTabId: move.referenceTabId, followChildren: true, };
	const sent = move.kind == "move-before"
		? TST.methods.moveBefore(params)
		: TST.methods.moveAfter(params)
			.then(move.thenOutdent
				? () => TST.methods.outdent({ tab: tabId, windowId, followChildren: true, })
				: null);
	const ok = await sent.then(() => true, error => {
		logBoot(`place-${side}-fail`, `${tabId} ${error && error.message || error}`);
		return false;
	});
	logBoot(`place-${side}`, `tab ${tabId}`);
	scheduleRederive(windowId);
	return ok;
}

/** tabs-rendered: rows were (re)rendered — remember them for hint mode,
 *  restore their straps, and while hint mode is on re-send their labels
 *  (TST clears a row's extra contents on unrender and re-inserts the
 *  cached markup only when the element is reused: a stale narrowed label
 *  would otherwise come back with the row). */
async function onTabsRendered (tabs, windowIdHint) {
	if (!tstUsable) { return; }
	ledgerRenderedTabs(tabs, windowIdHint);
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
			if (hint && hint.confirmed && hint.windowId === windowId) {
				await redrawHintLabels().catch(error => logBoot("hints-relabel-fail", `${windowId} ${error && error.message || error}`));
			}
		}
		else {
			scheduleRederive(windowId);
		}
	}
}

/** tabs-unrendered: rows left the viewport — forget them in the ledger
 *  (an unrendered row carries no label, and the mode re-derives when it
 *  comes back via tabs-rendered). */
function onTabsUnrendered (tabs) {
	renderer.forgetRowHints(tabs);
	for (const tab of tabs) {
		const set = tab && tab.windowId != null ? renderedTabs.get(tab.windowId) : null;
		if (set) { set.delete(tab?.id); }
	}
}

/** Add the rendered ids of one notification to the ledger.  The
 *  notification's own windowId backs its tab entries up: some TST
 *  export shapes carry only `{ id }` per tab (measured — the hint window's
 *  rendered set stayed empty off the hint alone). */
function ledgerRenderedTabs (tabs, windowIdHint) {
	for (const tab of tabs) {
		const windowId = tab && (tab.windowId != null ? tab.windowId : windowIdHint);
		if (!tab || windowId == null || tab.id == null) { continue; }
		let set = renderedTabs.get(windowId);
		if (!set) { set = new Set; renderedTabs.set(windowId, set); }
		set.add(tab.id);
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
			// clear the watchdog on BOTH outcomes: clearing it only on
			// failure logged every healthy slow-ish request as "send-slow"
			promise.then(
				() => clearTimeout(timer),
				error => { clearTimeout(timer); logBoot("send-fail", `${detail} ${error && error.message || error}`); });
		}
		return promise;
	},
	log: logBoot,
	badgeModeOf: () => badgeMode,
});

// ---------------------------------------------------------------------------
// 4. menu items

const MENU_PUT = "tst-shelf:put";
const MENU_TAKE = "tst-shelf:take";
const MENU_SHELF = "tst-shelf:shelf";
const MENU_PLACE_LEFT = "tst-shelf:place-left";
const MENU_PLACE_RIGHT = "tst-shelf:place-right";

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
	// the parent must exist before the children attach to it
	const items = [
		{ id: MENU_PUT, title: "Put on shelf", },
		{ id: MENU_TAKE, title: "Take off the shelf", },
		{ id: MENU_SHELF, title: "Shelf", },
		{ id: MENU_PLACE_LEFT, title: "Place leftmost", parentId: MENU_SHELF, },
		{ id: MENU_PLACE_RIGHT, title: "Place rightmost", parentId: MENU_SHELF, },
	];
	for (const item of items) {
		try {
			browser.menus.create({ ...item, contexts: ["tab"], });
			// menus.getAll() does not exist in Firefox — track the
			// created items ourselves (menus.create throws on invalid
			// params, so reaching here means the item is registered).
			menuTelemetry.items.push({ id: item.id, title: item.title, parentId: item.parentId, });
		}
		catch (error) { logBoot("menu-create-fail", `${item.id} ${error && error.message || error}`); }
	}
}

/** Per-tab visibility: flip when a tab menu opens (menus.onShown fires
 *  for every menu that contains our items — plain tab rows in the TST
 *  sidebar, the native tab bar, and TST's overridden icon menus alike).
 *  Native menus only open for TRUSTED events, so the E2E drives this
 *  same function through the internal test hook instead. */
const menuTelemetry = {
	shownCount: 0, lastTabId: null, lastPutVisible: null, lastTakeVisible: null,
	lastShelfVisible: null, items: [],
};

async function applyMenuVisibility (tabId) {
	const isShelved = shelved.has(tabId);
	let pinned = false;
	try { pinned = (await browser.tabs.get(tabId)).pinned; }
	catch (_error) { /* closed meanwhile */ }
	try {
		const putVisible = !isShelved && !pinned;
		const shelfVisible = isShelved && !pinned;
		await browser.menus.update(MENU_PUT, { visible: putVisible, });
		await browser.menus.update(MENU_TAKE, { visible: isShelved, });
		await browser.menus.update(MENU_SHELF, { visible: shelfVisible, });
		await browser.menus.update(MENU_PLACE_LEFT, { visible: shelfVisible, });
		await browser.menus.update(MENU_PLACE_RIGHT, { visible: shelfVisible, });
		await browser.menus.refresh();
		menuTelemetry.shownCount++;
		menuTelemetry.lastTabId = tabId;
		menuTelemetry.lastPutVisible = putVisible;
		menuTelemetry.lastTakeVisible = isShelved;
		menuTelemetry.lastShelfVisible = shelfVisible;
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
	else if (info.menuItemId == MENU_PLACE_LEFT) { placeOnShelfEdge(tabId, "left"); }
	else if (info.menuItemId == MENU_PLACE_RIGHT) { placeOnShelfEdge(tabId, "right"); }
});

// ---------------------------------------------------------------------------
// 5. icon interaction

/** The member id encoded in the clicked extra-contents element, if ours. */
function shelfTargetOf (message) {
	const html = String(message?.originalTarget || "");
	const match = html.match(/data-tab-id="(\d+)"/);
	return match ? Number(match[1]) : null;
}

/** Is the click on the audio indicator?  The payload's
 *  originalTargetPart carries the deepest [part] element's part list
 *  (tst-api-frontend getExtraContentsInfo) with this addon's part name
 *  stripped; the sound glyph's own element matches first. */
function onSoundGlyph (message) {
	return String(message?.originalTargetPart || "").split(/\s+/)[0] === "shelf-sound";
}

/** Toggle the mute of the tab the clicked sound glyph belongs to. */
async function toggleMemberMute (memberId) {
	const tab = await browser.tabs.get(memberId).catch(() => null);
	const muted = !!tab?.mutedInfo?.muted;
	await browser.tabs.update(memberId, { muted: !muted, }).catch(() => {});
	return !muted;
}

async function onExtraContentsMousedown (message) {
	if (!tstUsable) { return false; }
	if (onSoundGlyph(message)) {
		const memberId = shelfTargetOf(message);
		if (memberId != null && shelved.has(memberId)) {
			await toggleMemberMute(memberId);
			return true; // cancel: clicking the glyph must not select the tab
		}
	}
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
	if (onSoundGlyph(message)) {
		// the mousedown already toggled the mute: cancel the selection
		// path for the click that follows the glyph
		return true;
	}
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
	// The incoming member needs no action from us: it is hidden, and
	// Firefox reveals a hidden tab the moment it becomes active.
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
	// The pre-shelve place, captured BEFORE the placement move: the member
	// block will relocate the tab, take-off restores it.  The NEIGHBOURS are
	// the robust half of the record — they survive unrelated moves that
	// shift the index — and the index is the fallback when both are gone.
	// A tab that re-enters shelving (take + put again) stores a fresh one;
	// a shelf-to-shelf drag keeps the original.
	const existing = await browser.sessions.getTabValue(tabId, FLAG_KEY).catch(() => null);
	const prev = existing && existing.prev ? existing.prev : await preShelvePlaceOf(tab);
	// Refuse the put when its ONE required write fails: a sticky flag that
	// never reached the session store would not survive a restart, while
	// this session would report the tab as shelved.
	try { await browser.sessions.setTabValue(tabId, FLAG_KEY, { on: true, prev, }); }
	catch (error) {
		logBoot("put-fail", `${tabId} ${error && error.message || error}`);
		return false;
	}
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

/** The tab's place in TST's internal order, as take-off needs it.
 *
 *  Only SIBLINGS are recorded as neighbours.  A neighbour from elsewhere
 *  in the pre-order (a cousin, an uncle) is not a legal reference for a
 *  restore move: `move-after` a descendant re-parents the mover into that
 *  subtree, and the tab comes off the shelf onto the wrong shelf entirely
 *  (measured: B was restored after c1 — a child of C — and became a child
 *  of C, i.e. moved from A's shelf to C's).  `slot` is the position among
 *  those siblings; `index` stays as the physical fallback for records that
 *  have no tree (or no parent). */
async function preShelvePlaceOf (tab) {
	const tree = windows.get(tab.windowId)?.tree;
	const siblings = tree ? siblingListOf({ tree, id: tab.id, }) : null;
	if (siblings) {
		return {
			windowId: tab.windowId,
			index: tab.index,
			parentId: siblings.parentId,
			slot: siblings.slot,
			beforeId: siblings.slot > 0 ? siblings.siblings[siblings.slot - 1] : null,
			afterId: siblings.slot + 1 < siblings.siblings.length ? siblings.siblings[siblings.slot + 1] : null,
		};
	}
	return { windowId: tab.windowId, index: tab.index, parentId: undefined, slot: tab.index, beforeId: null, afterId: null, };
}

/** TST's internal tab order of a window: the cached light tree when a
 *  derivation has run, otherwise the physical strip order.  Moves are
 *  planned in TST's order because the physical strip lags it
 *  (tabs-move.js defers the sync by ~250 ms). */
async function tabOrderOf (windowId) {
	const tree = windows.get(windowId)?.tree;
	if (tree) { return [...treePositions(tree).keys()]; }
	const tabs = await browser.tabs.query({ windowId, }).catch(() => []);
	return tabs.slice().sort((a, b) => a.index - b.index).map(tab => tab.id);
}

async function takeOffShelf (tabId) {
	const stored = await browser.sessions.getTabValue(tabId, FLAG_KEY).catch(() => null);
	// The flag removal is the one required write of a take-off: if it
	// fails, the tab is still shelved after a restart, so the operation
	// fails rather than reporting a half-done take.
	if (stored) {
		try { await browser.sessions.removeTabValue(tabId, FLAG_KEY); }
		catch (error) {
			logBoot("take-fail", `${tabId} ${error && error.message || error}`);
			return false;
		}
	}
	shelved.delete(tabId);
	appendSeq.delete(tabId);
	// The row comes back.  The ledger entry is dropped only when the call
	// that restores the row was acknowledged; a rejected call leaves it in
	// place, and the next derivation retries it (`toShow` is derived from
	// `hiddenByUs`).
	const tab = await browser.tabs.get(tabId).catch(() => null);
	if (hiddenByUs.has(tabId)) {
		// only OUR hides are ours to lift: a tab that a container filter
		// hid must stay hidden, or taking it off the shelf would defeat
		// the workspace it is filtered out of.
		const shown = await browser.tabs.show([tabId]).then(() => true, error => {
			logBoot("show-fail", `${tabId} ${error && error.message || error}`);
			return false;
		});
		if (shown) { hiddenByUs.delete(tabId); }
	}
	if (tab) {
		await restorePreShelvePosition(tab, stored && stored.prev);
		scheduleRederive(tab.windowId);
	}
	logBoot("take", `tab ${tabId}`);
	return true;
}

/** Return the tab to the strip position it had before it was shelved
 *  (spec shelf-pinning).  The move is planned by the pure
 *  `planRestoreMove` (logic.esm.js), which resolves the reference tab in
 *  the order WITHOUT the mover (and its subtree): picking "the tab that
 *  now occupies the saved index" and always moving before it left a tab
 *  that had to move toward a later index exactly one slot short —
 *  [X, A, B] with X saved at index 1 stayed [X, A, B] instead of
 *  [A, X, B]. */
async function restorePreShelvePosition (tab, prev) {
	if (!prev || prev.windowId != tab.windowId) { return; }
	const tree = windows.get(tab.windowId)?.tree;
	const siblings = tree ? siblingListOf({ tree, id: tab.id, }) : null;
	// Same parent as at put time → the saved neighbours are legal
	// references.  Otherwise aim for the saved SLOT inside the current
	// parent only: a tab that was re-parented must not be yanked back into
	// a subtree it no longer belongs to (and a neighbour from another
	// parent would re-parent it through TST's position-derived parenting).
	const sameParent = !!(siblings && prev.parentId !== undefined && siblings.parentId === prev.parentId);
	const order = siblings ? siblings.siblings : await tabOrderOf(tab.windowId);
	if (!order.includes(tab.id)) { return; }
	const move = planRestoreMove({
		order,
		tabId: tab.id,
		subtree: tree ? subtreeIds({ tree, id: tab.id, }) : [],
		savedIndex: Number.isFinite(prev.slot) ? prev.slot : (Number.isFinite(prev.index) ? prev.index : 0),
		beforeId: sameParent ? prev.beforeId ?? null : null,
		afterId: sameParent ? prev.afterId ?? null : null,
	});
	if (!move) { return; }
	const params = { tab: tab.id, windowId: tab.windowId, referenceTabId: move.referenceTabId, followChildren: true, };
	const sent = move.kind == "move-before" ? TST.methods.moveBefore(params) : TST.methods.moveAfter(params);
	await sent.catch(error => logBoot("restore-fail", `${tab.id} ${error && error.message || error}`));
}

// ---------------------------------------------------------------------------
// 8. tab/window events, pin guard

browser.tabs.onRemoved.addListener(tabId => {
	faviconMemory.delete(tabId);
	hideGuard.delete(tabId);
	foldTries.delete(tabId);
	hiddenByUs.delete(tabId);
	suppressedHiddenByUs.delete(tabId);
	suppressHold.delete(tabId);
	// a closed owner ends its reveal; a closed active tab prunes it on the
	// next derivation (planReveals)
	for (const map of reveals.values()) { map.delete(tabId); }
	if (shelved.delete(tabId)) { scheduleRederiveAll(); }
});

browser.tabs.onActivated.addListener(activeInfo => {
	// a shelved tab activated inside a FOLDED owner's subtree: reveal its
	// branch only (see section 3b).  This covers every activation route —
	// the shelf icon's mousedown, Ctrl+Tab, Firefox's own tab bar.
	maybeBeginReveal(activeInfo.windowId, activeInfo.tabId);
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
	reveals.delete(windowId);
	if (hint && hint.windowId === windowId) { exitHintMode("window"); }
	renderedTabs.delete(windowId);
	sidebarState.delete(windowId);
	const live = new Set((await browser.tabs.query({})).map(tab => tab.id));
	renderer.forgetWindow(windowId, live);
});

/** The native hotkey (default Alt+U; user-rebindable in
 *  about:addons).  The command fires for the focused window, exactly what
 *  the mode's window parameter is.  Delivery is a trusted event: the E2E
 *  drives the mode through the internal hooks, and a GUI run verifies the
 *  native path once (documented like native menu delivery).  The command
 *  invocation is also what GRANTS activeTab for the active tab (MDN:
 *  "activating a keyboard shortcut defined by the extension with the
 *  commands API"), which is the permission the page catcher's
 *  tabs.executeScript rides (see armPageCatcher). */
if (browser.commands?.onCommand) {
	browser.commands.onCommand.addListener((command, tab) => {
		if (command !== "tst-shelf:hints") { return; }
		// user-visible diagnostic: the bootlog answers "does Firefox
		// deliver the command at all" (the focus-dependent delivery
		// question answered on the user's own machine)
		logBoot("hints-command-fired", `window ${tab?.windowId ?? "?"}`);
		const windowId = tab?.windowId ?? null;
		const start = windowId != null
			? enterHintMode(windowId)
			: browser.windows.getLastFocused().then(win => enterHintMode(win.id));
		start.catch(error => logBoot("hints-command-fail", String(error && error.message || error)));
	});
}

// ---------------------------------------------------------------------------
// boot

(async () => {
	// options and menu items are TST-independent: load/create them even
	// when TST is absent or broken.
	await loadOptions();
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
// 8b. hint mode (tab-hints capability)
//
// The keyboard codes.  Entry: a browser command (native hotkey, default
// Alt+U) starts the mode for the focused window, assigns the codes
// (assignHints, logic.esm.js — rendered order, unique, shortest practical
// length) over EXACTLY the tabs whose surfaces are painted
// (planHintTargets, logic.esm.js: rendered rows and members whose strap
// is painted; folded-away and off-viewport tabs carry none, so a
// mistyped code can never activate a tab that is not on screen), and
// lights them up: strap chips through the normal strap diff, row labels
// through set-extra-contents on every coded row.
//
// Key capture runs on TWO channels, because the labels paint in TST's
// sidebar while the user's keyboard focus is usually the web page:
// 1. THE PAGE CATCHER (Vimium's mechanism, ported): src/hint-catcher.js
//    is injected on demand into the window's ACTIVE tab — legal with no
//    host permissions, because the command invocation grants activeTab
//    (MDN, commands → activeTab, Firefox 63+) and activeTab is exactly
//    what covers tabs.executeScript in MV2.  The catcher forwards every
//    code letter as a runtime message and suppresses it from the page.
// 2. TST'S OWN FORWARDING: a zero-size tabindex catcher span rides the
//    ALWAYS-present root strap (render.esm.js); focus-to-extra-contents
//    focuses it, and once focused every keydown inside it arrives as
//    extra-contents-keydown.  This is the only channel on pages the
//    catcher cannot be injected into (extension pages, about:, reader
//    view, PDF viewer — MDN lists them) and whenever the user's focus
//    is inside the sidebar.
//
// The FIRST keydown of either channel confirms the mode: Firefox does
// not dispatch focus/blur for shadow-internal targets (measured in the
// E2E focus probe), so focus events cannot confirm.  A mode that no key
// ever reaches is torn down by HINT_CONFIRM_TIMEOUT_MS with nothing
// visible left behind — that is the closed-sidebar no-op: entry declines
// a KNOWN-closed sidebar outright (sidebar-hide with openCount 0 and no
// rendered rows since), and an unknown window whose sidebar is closed
// enters but has no key source and paints nothing (labels only land on
// rendered rows, which a closed sidebar has none of).
//
// Exits overlap: Escape, a completed code (activation), a window close,
// the confirmation timeout, and the catcher losing focus when Firefox
// delivers a blur at all.  Nothing persists; nothing hides a tab.

/** The whole runtime state of the mode, or null.  One mode at a time —
 *  the keydown payloads carry no windowId (the catcher lives in the
 *  sidebar itself), so the FOCUSED catcher identifies the mode's window:
 *  a second command while one is up just moves the mode. */
let hint = null;
const HINT_CONFIRM_TIMEOUT_MS = 9000;
/** Serial of the current hint mode.  The page catcher's arm/stop messages
 *  carry it, so a stop left over from a replaced mode cannot tear down
 *  the NEW mode's catcher (the replace race is real: stop(old) can land
 *  after arm(new)). */
let catcherSeq = 0;
/** Every enter/confirm/exit with its reason, for the E2E state export:
 *  the shared diag ring drowns in poll traffic, and "why did the mode
 *  go down" is exactly the question the flaky-exit debugging asks. */
const hintLog = [];
const hintLogPush = line => {
	hintLog.push(`${Date.now().toString(36)} ${line}`);
	if (hintLog.length > 60) { hintLog.shift(); }
};

/**
 * Assign the codes for the focused window and light the chips up.
 *
 * Codes cover EXACTLY the tabs whose surfaces are painted
 * (planHintTargets, logic.esm.js): a shelved member's code labels its
 * ICON — only while the strap carrying it is painted (the root strap
 * always is; a nested strap rides its owner's row) — and a row tab's
 * code labels its rendered row.  A COLD ledger (no tabs-rendered since
 * our boot — the extension-reload-with-open-sidebar case, the 0.3.3
 * trap) skips the viewport cut and codes every non-folded visible tab:
 * TST routes set-extra-contents by tab id, so labels for rows that are
 * rendered but never broadcast still paint, and the mode never blanks
 * after a reload.
 */
async function enterHintMode (windowId) {
	if (!tstUsable) { return { ok: false, reason: "tst-unusable", }; }
	if (exitHintMode("replaced")) { /* a previous mode is torn down */ }
	if (windowId == null) {
		logBoot("hints-decline", "no-window");
		return { ok: false, reason: "no-window", };
	}
	// the page catcher cannot live on a page executeScript rejects
	// (MDN: top-level about: frames, extension pages — the TST group
	// tabs among them), and without it the keyboard path is dead: the
	// sidebar channel needs a focus the user would have to hand over
	// by hand.  The hotkey is therefore a deliberate no-op there
	// (spec: entering from a page that cannot host the catcher), never
	// a mode that traps.  This decline is UNCONDITIONAL — the option
	// below only governs whether such TABS carry codes at all.
	const activeTab = (await browser.tabs.query({ windowId, active: true, }).catch(() => []))[0] || null;
	if (activeTab && isSpecialPageUrl(activeTab.url)) {
		logBoot("hints-decline", `window ${windowId} active-tab-not-injectable ${String(activeTab.url).slice(0, 60)}`);
		return { ok: false, reason: "active-tab-not-injectable", };
	}
	// a KNOWN-closed sidebar (sidebar-hide left openCount 0) with no
	// rendered rows: nothing can paint and no catcher makes sense — the
	// spec's closed-sidebar no-op, declined at entry.  An UNKNOWN window
	// (no sidebar-show/-hide since boot — a sidebar open since before
	// our registration) is NOT declined: its rows are exactly the ones
	// the ledger does not know but TST still routes labels to.
	const ledger = renderedTabs.get(windowId) || null;
	const knownSidebar = sidebarState.get(windowId) || null;
	if (knownSidebar && !knownSidebar.open && !(ledger && ledger.size)) {
		logBoot("hints-decline", `window ${windowId} sidebar-closed`);
		return { ok: false, reason: "sidebar-closed", };
	}
	diag(`hints-enter w=${windowId}`);
	const tabs = await browser.tabs.query({ windowId, }).catch(() => []);
	if (!tabs.length) {
		logBoot("hints-decline", `window ${windowId} no-tabs`);
		return { ok: false, reason: "no-tabs", };
	}
	const tabsById = new Map(tabs.map(tab => [tab.id, tab]));
	const tree = await fetchLightTree(windowId, tabsById);
	if (!tree) {
		logBoot("hints-decline", `window ${windowId} no-tree`);
		return { ok: false, reason: "no-tree", };
	}
	// a FRESH derivation over the just-fetched tree: shelfOf must agree
	// with the tree the planner walks (a cached derivation can lag one
	// 120 ms debounce behind a structural move, misattributing a
	// member's strap); derive costs ~0.5 ms at 350 tabs (perf gate)
	const derivation = derive({ tree, shelved, tabsById, hiddenByUs, });
	// The coded set: EXACTLY the tabs whose surfaces are painted
	// (planHintTargets, logic.esm.js) — rendered rows, and members whose
	// strap is painted; folded-away rows and off-viewport rows carry no
	// code, so a mistyped code can never activate a tab that is not on
	// screen.
	//
	// The RENDER truth is TST's own live viewport filter: get-light-tree
	// with rendered:true AND tab:'*' (background getTargetRenderedTabs
	// asks the sidebar's virtual scroll for its rendered ids; tab:'*' is
	// required — a windowId-ONLY query selects ROOT tabs in TST's
	// getTargetTabs, so rendered descendants would be filtered away and
	// the set would be root-only: the 0.6.0 bug, caught by the E2E's
	// converse coverage check), because
	// the tabs-rendered/-unrendered EVENT stream is not a per-window
	// truth: several sidebar copies of one window render/unrender their
	// own viewports, and one copy's tabs-unrendered would veto rows
	// another copy still paints (measured in the E2E: the event ledger
	// ended up holding only tabs created after the copies settled, while
	// the fixture rows stayed painted the whole time).  A window with NO
	// sidebar copy answering (no sidebar at all, or a failed query)
	// falls back to the fold cut alone — codes for every non-folded
	// visible tab, labels painting wherever rows exist (the 0.3.3
	// stale-ledger trap stays shut: TST routes set-extra-contents by tab
	// id, so labels for never-broadcast rows still paint).
	const renderedIds = await fetchRenderedIds(windowId);
	const rendered = renderedIds && renderedIds.size ? renderedIds : null;
	if (!rendered) { logBoot("hints-render-unknown", `window ${windowId}`); }
	const { orderedIds, rowIds, memberIds, } = planHintTargets({
		tree, tabsById,
		shelfOf: derivation.shelfOf,
		shelved, hiddenByUs, suppressedHiddenByUs,
		rendered,
		excludeSpecial: hintExcludeSpecial,
	});
	const codes = assignHints(orderedIds, hintCharset);
	if (!codes.size) {
		diag(`hints-enter w=${windowId} empty`);
		return { ok: false, reason: "no-visible-tabs", };
	}
	hintLogPush(`enter w=${windowId} tabs=${codes.size} rows=${rowIds.length} rendered=${rendered ? rendered.size : "unknown"} members=${memberIds.length} shelved=${shelved.size}`);
	hint = {
		windowId,
		modeId: ++catcherSeq,
		codes,
		rowIds,
		rendered,
		buffer: "",
		confirmed: false,
		catcherTabId: null,
		timer: setTimeout(() => {
			if (hint && !hint.confirmed) {
				logBoot("hints-unconfirmed", `window ${windowId}`);
				exitHintMode("unconfirmed");
			}
		}, HINT_CONFIRM_TIMEOUT_MS),
	};
	renderer.setHints(codes);
	// the strap chips ride the normal diff over the FRESH derivation (the
	// chips come from setHints; the strap membership from the same tree
	// the planner walked), and the row labels go out at ENTRY for the
	// coded rows: a window without a sidebar page has no rendered row to
	// receive any of them — the writes no-op, no label appears anywhere,
	// and the mode's no-op holds
	await renderer.applyDerivation({ windowId, derivation, tabsById, })
		.catch(error => logBoot("hints-strap-fail", `${windowId} ${error && error.message || error}`));
	await redrawHintLabels()
		.catch(error => logBoot("hints-label-fail", `${windowId} ${error && error.message || error}`));
	await armPageCatcher(windowId);
	focusCatcher(windowId);
	logBoot("hints-enter", `window ${windowId} tabs=${codes.size}`);
	return { ok: true, codes: [...codes.entries()], };
}

/** Ask TST to focus the catcher.  Called once on entry; a lost focus
 *  later just ends the mode through the blur event. */
function focusCatcher (windowId) {
	TST.methods.focusToExtraContents({ windowId, place: "tabbar-top", part: "shelf-keycatcher", })
		.catch(error => logBoot("hints-focus-fail", `window ${windowId} ${error && error.message || error}`));
}

/** Inject the page catcher (src/hint-catcher.js) into the window's
 *  ACTIVE tab — the Vimium-port channel.  The user's keyboard focus is
 *  the web page, not TST's sidebar, so the letters must be captured
 *  where they are typed; the injection is legal with no host
 *  permissions because the command invocation grants activeTab (MDN,
 *  "How activeTab is granted": a commands-API shortcut, Firefox 63+),
 *  and activeTab is exactly what covers tabs.executeScript in MV2.
 *
 *  Pages executeScript cannot touch — extension pages (the smoke page
 *  and every OTHER extension's pages, so the E2E's tab-hosted TST
 *  sidebar too), about:, reader view, the PDF viewer — reject here:
 *  that failure is a bootlog line, and the sidebar's own catcher
 *  remains the channel (the E2E asserts this graceful path). */
async function armPageCatcher (windowId) {
	const active = (await browser.tabs.query({ windowId, active: true, }).catch(() => []))[0] || null;
	const modeId = hint?.modeId;
	if (!active || modeId == null) { return; }
	try {
		await browser.tabs.executeScript(active.id, { file: "hint-catcher.js", });
		// Retarget the catcher at THIS mode.  The arm message can fail
		// when a stop for the replaced mode lands between the injection
		// and the message and killed the catcher the injection guard
		// reused — the re-injection below closes that race.
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				await browser.tabs.sendMessage(active.id, { type: "hint-catcher-arm", modeId, });
				if (hint && hint.modeId === modeId) { hint.catcherTabId = active.id; }
				hintLogPush(`arm tab=${active.id} try=${attempt}`);
				logBoot("hints-arm", `tab ${active.id}`);
				return;
			}
			catch (_error) { /* the catcher died between inject and arm */ }
			await browser.tabs.executeScript(active.id, { file: "hint-catcher.js", }).catch(() => {});
		}
		logBoot("hints-arm-fail", `tab ${active.id} arm message undeliverable`);
	}
	catch (error) {
		logBoot("hints-arm-fail", `tab ${active.id} ${error && error.message || error}`);
	}
}

/** The focus confirmation.  Without it the mode never writes a row label
 *  (and the straps write nothing when no sidebar exists to paint them). */
async function onExtraContentsFocus (message) {
	if (!hint || hint.confirmed) { return undefined; }
	if (!String(message?.originalTargetPart || "").startsWith("shelf-keycatcher")) { return undefined; }
	hint.confirmed = true;
	clearTimeout(hint.timer);
	diag(`hints-confirmed w=${hint.windowId}`);
	logBoot("hints-confirmed", `window ${hint.windowId}`);
	await redrawHintLabels();
	return undefined;
}

/** The row labels AND the strap chips for the current buffer: a code
 *  that still matches keeps its chip, the rest go blank — on BOTH
 *  surfaces (the 0.4.0 defect: only the row labels narrowed, the icon
 *  chips kept every code, and the two disagreed mid-mode; the user
 *  report called it "hints disappear at random"). */
async function redrawHintLabels () {
	if (!hint) { return; }
	const windowId = hint.windowId;
	diag(`hints-redraw w=${windowId} buffer=${hint.buffer}`);
	const labels = new Map;
	for (const id of hint.rowIds) {
		const code = hint.codes.get(id);
		labels.set(id, code && code.startsWith(hint.buffer) ? code : "");
	}
	// force: TST may just have re-inserted a cached (stale) label with the
	// re-rendered row; the ledger compare must not skip those
	await renderer.setRowHints({ windowId, labels, force: true, });
	// the chips ride the normal strap diff: the buffer-filtered code map
	// (the full map while the buffer is empty — entry), re-applied now
	renderer.setHints(hint.buffer ? new Map(hintMatches(hint.codes, hint.buffer)) : hint.codes);
	const cached = windows.get(windowId);
	if (cached?.derivation) {
		await renderer.applyDerivation({ windowId, derivation: cached.derivation, tabsById: cached.tabsById, })
			.catch(error => logBoot("hints-strap-fail", `${windowId} ${error && error.message || error}`));
	}
}

/** Tear the mode down: unconfirm the timer, drop the chips (the next
 *  strap diff) and blank every acknowledged row label.  Idempotent. */
function exitHintMode (reason) {
	if (!hint) { return false; }
	const { windowId, timer, catcherTabId, modeId, } = hint;
	hint = null;
	hintLogPush(`exit ${reason} w=${windowId}`);
	if (timer) { clearTimeout(timer); }
	// the armed page catcher must stop eating keys: a modeId match tears
	// it down (hint-catcher.js); a tab that closed took its catcher with
	// the document anyway.  An ack-less orphan answers its OWN first key
	// with a {ok:false} and tears itself down.
	if (catcherTabId != null) {
		browser.tabs.sendMessage(catcherTabId, { type: "hint-catcher-stop", modeId, })
			.catch(() => {});
	}
	hintLogPush(`clearing w=${windowId}`);
	renderer.setHints(null);
	renderer.clearRowHints({ windowId, })
		.catch(error => logBoot("hints-exit-fail", `${windowId} ${error && error.message || error}`));
	const cached = windows.get(windowId);
	if (cached) {
		renderer.applyDerivation({ windowId, derivation: cached.derivation, tabsById: cached.tabsById, })
			.catch(error => logBoot("hints-exit-fail", `${windowId} ${error && error.message || error}`));
	}
	logBoot("hints-exit", `window ${windowId} ${reason}`);
	diag(`hints-exit w=${windowId} ${reason}`);
	return true;
}

/**
 * The typing state machine, shared by both capture channels (the
 * narrow-cancellation rule: a truthy answer only for keys the mode
 * consumed — TST's tryOperationAllowed cancels on any truthy response,
 * and for keyboard events the verdict decides nothing in TST, so the
 * rule is about not claiming keys we ignore).
 *
 * Letters lower-cased; Shift-letters match.  Ctrl/Alt/Meta combos fall
 * through.  A letter that empties the match set is ignored.  A UNIQUE
 * match activates at once (even one letter in); a longer match needs the
 * full code.  Backspace pops; Escape exits; auto-repeat is swallowed.
 *
 * The first key of either channel IS the mode's confirmation: Firefox
 * does not dispatch focus/blur for shadow-internal targets (measured in
 * the E2E focus probe), so no focus event can confirm, and a mode that
 * no key ever reaches is the timeout's to tear down.
 */
async function consumeHintKey (payload) {
	if (!hint) { return false; }
	const key = String(payload?.key || "");
	if (!hint.confirmed) {
		if (key === "Escape") { exitHintMode("escape"); return true; }
		hint.confirmed = true;
		clearTimeout(hint.timer);
		diag(`hints-confirmed w=${hint.windowId}`);
		hintLogPush(`confirm`);
		logBoot("hints-confirmed", `window ${hint.windowId}`);
		await redrawHintLabels();
	}
	if (key === "Escape") { exitHintMode("escape"); return true; }
	if (key === "Backspace") {
		if (!hint.buffer) { return false; }
		hint.buffer = hint.buffer.slice(0, -1);
		await redrawHintLabels();
		return true;
	}
	if (payload?.repeat || key.length !== 1) { return payload?.repeat ? true : false; }
	if (payload?.ctrlKey || payload?.altKey || payload?.metaKey) { return false; }
	const next = hint.buffer + key.toLowerCase();
	const matches = hintMatches(hint.codes, next);
	if (!matches.length) { return false; }
	if (matches.length === 1) {
		const [tabId] = matches[0];
		const shelvedTab = shelved.has(tabId);
		exitHintMode(`activate ${tabId}`);
		if (shelvedTab) {
			// exactly the icon-click choreography: fold swap, reveal, hide
			// of the outgoing member's row (index.esm.js section 5)
			await selectShelfTab(tabId);
		}
		else {
			await browser.tabs.update(tabId, { active: true, }).catch(() => {});
		}
		return true;
	}
	hint.buffer = next;
	await redrawHintLabels();
	return true;
}

/** TST's channel: the sidebar catcher's keydowns, forwarded as
 *  extra-contents-keydown. */
async function onExtraContentsKeydown (message) {
	if (E2E_BUILD) { diag(`hints-key key=${String(message && message.key)}`); }
	if (!hint) { return false; }
	return consumeHintKey(message);
}

/** The page catcher's channel: an internal runtime message from the
 *  injected hint-catcher.js — or, in the E2E, from the smoke page
 *  relaying the same type through its internal connection (executeScript
 *  cannot touch extension pages, so the relay is the only headless way
 *  to exercise this handler).  The ack tells the catcher whether its
 *  mode is still alive; a catcher whose tab is not the armed one (an
 *  orphan of a replaced mode, or a re-entered mode arming another tab)
 *  is told to tear itself down on its next key. */
browser.runtime.onMessage.addListener((message, sender) => {
	if (!message || message.type !== "hint-catcher-key") { return undefined; }
	const tabId = sender && sender.tab && sender.tab.id;
	const alive = () => !!hint
		&& (hint.catcherTabId == null || hint.catcherTabId === tabId);
	return consumeHintKey(message)
		.then(() => ({ ok: alive(), }))
		.catch(() => ({ ok: alive(), }));
});

/** The catcher lost focus: the mode is up without a keyboard. */
async function onExtraContentsBlur (message) {
	if (!hint || !hint.confirmed) { return undefined; }
	if (!String(message?.originalTargetPart || "").startsWith("shelf-keycatcher")) { return undefined; }
	exitHintMode("blur");
	return undefined;
}

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
					badgeCounts: [...derivation.badgeCounts.entries()],
					highlights: [...derivation.highlightIds],
					selected: [...derivation.selectedOfShelf.entries()].map(([owner, id]) => [owner == ROOT_SHELF ? "root" : owner, id]),
					active: [...tabsById.values()].filter(tab => tab.active && !tab.hidden).map(tab => tab.id),
				};
				// the favicon the derivation renders for each member —
				// the sticky one while the tab is loading (resolveFavicons)
				for (const id of derivation.shelvedVisible) {
					const tab = tabsById.get(id);
					if (tab && tab.favIconUrl) { favicons[String(id)] = tab.favIconUrl; }
				}
			}
			const menuItems = menuTelemetry.items;
			const revealState = {};
			for (const [windowId, map] of reveals.entries()) {
				revealState[windowId] = [...map.entries()].map(([owner, info]) => [owner, !!info.openedSeen]);
			}
			const renderedState = {};
			for (const [windowId, set] of renderedTabs.entries()) {
				renderedState[windowId] = [...set].sort((a, b) => a - b);
			}
			const hintState = hint && {
				windowId: hint.windowId,
				confirmed: hint.confirmed,
				buffer: hint.buffer,
				labels: renderer.rowHintCount(hint.windowId),
				codes: [...hint.codes.entries()],
				rendered: hint.rendered ? [...hint.rendered] : null,
			};
			const storedBootlog = (await browser.storage.local.get({ bootlog: [], }).catch(() => ({}))).bootlog || [];
			return {
				registered: TST.isRegistered, usable: tstUsable,
				shelved: [...shelved], hiddenByUs: [...hiddenByUs],
				diagLog,
				suppressedHiddenByUs: [...suppressedHiddenByUs],
				reveals: revealState,
				revealDebug,
				shelves, favicons,
				renderedTabs: renderedState,
				hints: hintState,
				hintOptions: { charset: hintCharset, excludeSpecialPages: hintExcludeSpecial, },
				hintLog: [...hintLog],
				rowLedger: renderer.rowLedgerCount(),
				rowKeys: renderer.rowLedgerKeys(),
				rowInFlight: renderer.rowHintPendingCount(),
				rowTrace: renderer.rowHintTraceLines(),
				menu: { ...menuTelemetry, items: menuItems, },
				bootlog: storedBootlog.slice(-18),
			};
		}
		case "test:put": return { ok: await putOnShelf(message.tabId), };
		case "test:take": return { ok: await takeOffShelf(message.tabId), };
		case "test:place": return {
			ok: await placeOnShelfEdge(message.tabId, message.side === "left" ? "left" : "right"),
		};
		case "test:mute": {
			await browser.tabs.update(message.tabId, { muted: !!message.muted, }).catch(() => {});
			await rederive(message.windowId);
			return { ok: true, };
		}
		case "test:badge-mode": {
			await browser.storage.local.set({ [BADGE_MODE_KEY]: message.mode === "count" ? "count" : "plus", });
			await rederive(message.windowId);
			return { ok: true, mode: badgeMode, };
		}
		case "test:set-hint-options": {
			// The options-page path, headlessly: write the storage keys; the
			// background's onChanged listener applies them (the E2E polls
			// test:state's hintOptions for the applied values).
			const write = {};
			if (typeof message.charset === "string") { write[HINT_CHARSET_KEY] = message.charset; }
			if (typeof message.excludeSpecialPages === "boolean") { write[HINT_EXCLUDE_SPECIAL_KEY] = message.excludeSpecialPages; }
			if (Object.keys(write).length) { await browser.storage.local.set(write); }
			return { ok: true, };
		}
		case "test:page-key": {
			// A synthetic keydown INSIDE a real web page — the only headless
			// way to exercise hint-catcher.js end to end: the catcher was
			// injected there by armPageCatcher, the event reaches its
			// document-level listener, and the runtime message comes back
			// through the production handler.  No TST involved.
			const key = String(message.key || "");
			const code = `document.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true, })); true;`;
			try {
				await browser.tabs.executeScript(Number(message.tabId), { code, });
				return { ok: true, };
			}
			catch (error) {
				return { ok: false, error: String(error && error.message || error), };
			}
		}
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
		case "test:collapse": {
			// Drive TST's own fold state (the reveal gate is built on it).
			const method = message.collapsed === false ? "expandTree" : "collapseTree";
			const ok = await TST.methods[method]({ tab: message.tabId, windowId: message.windowId, })
				.catch(error => { logBoot("test-collapse-fail", String(error && error.message || error)); return false; });
			await rederive(message.windowId);
			return { ok, };
		}
		case "test:redrive": {
			await rederive(message.windowId, { reconcile: !!message.reconcile, });
			return { ok: true, };
		}
		case "test:enter-hints": {
			// The native command is a trusted keyboard event, which the
			// headless rig cannot produce — the smoke page (and the driver,
			// through the sidebar page) enters the mode through this hook
			// instead; native delivery is verified on a GUI make iso-tst run.
			const result = await enterHintMode(message.windowId);
			return { ok: !!result.ok, reason: result.reason || null, codes: result.codes || null, };
		}
		case "test:exit-hints": {
			await exitHintMode(message.reason || "test");
			return { ok: true, };
		}
		case "test:tree-of": {
			// relay TST's get-tree through our background: the tab-hosted
			// TST sidebar page is TST's own runtime, and an internally
			// sent `get-tree` lands on no listener at all (handle-misc's
			// internal onMessage filters `treestyletab:*` only)
			const tree = await TST.methods.getTree({ tab: message.tab, }).catch(() => null);
			return { tree: tree || null, };
		}
		case "test:hint-key": {
			// The typing machine, with a synthesized payload (the phase-2
			// DOM chain exercises the real TST forwarding instead).  The
			// hook is a DIRECT keydown: it must not confirm a mode whose
			// sidebar never did — the confirmation gate is exactly what
			// makes a closed sidebar a no-op, so an unconfirmed mode is
			// refused here as well (the smoke's phase-1 expectation).
			if (!hint || !hint.confirmed) {
				return { verdict: "false", hints: hint && {
					buffer: hint.buffer, confirmed: hint.confirmed, windowId: hint.windowId,
				} };
			}
			const verdict = await onExtraContentsKeydown({
				key: message.key, repeat: !!message.repeat,
				ctrlKey: !!message.ctrlKey, altKey: !!message.altKey, metaKey: !!message.metaKey,
			});
			const state = hint && {
				buffer: hint.buffer, confirmed: hint.confirmed, windowId: hint.windowId,
			};
			return { verdict: String(!!verdict), hints: state };
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
