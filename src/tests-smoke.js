/**
 * Smoke test page (~tests.html?auto=1), shipped ONLY in -e2e builds.
 * Drives the extension's internal test API and browser.tabs from inside
 * the extension, and TST directly via the registered external API, then
 * dumps a results JSON through the downloads API.
 *
 * Two run modes, detected via storage.local["e2e-ids"]:
 *   phase 1 (fresh session): builds a test window with a small tree,
 *     exercises put/take, and then WAITS for the Marionette driver's
 *     synthetic clicks on the shelf icons in the tab-hosted TST sidebar
 *     (click C's icon -> C active and unfolded; click B's icon -> B
 *     active and C folded: one subtree per shelf).  Writes a setup
 *     report first (the driver reads the window id from it).
 *   phase 3 (reinstall; the restart-persistence proxy): the runtime
 *     state was wiped by the reinstall; asserts the shelved set is
 *     rebuilt from session values and the derivation re-lands on the
 *     same shelves.  No interaction waits.
 */
"use strict";

const TST_ID = "treestyletab@piro.sakura.ne.jp";
/** The driver's hint-fixture server (tests/e2e-drive.mjs HINT_ORIGIN):
 *  a REAL http page — the only kind executeScript can inject the page
 *  catcher into (MDN), needed in phase 1 before any driver script
 *  exists. */
const HINT_PAGE = "http://127.0.0.1:47631/a.html";
const HINT_ORIGIN = "http://127.0.0.1:47631";

const outEl = document.getElementById("out");
/** @type {{name: string, ok: boolean, detail: string}[]} */
const results = [];
let reported = false;

function record (name, ok, detail) {
	results.push({ name, ok: !!ok, detail: detail == null ? "" : String(detail).slice(0, 400), });
	render();
}
function render () { if (outEl) { outEl.textContent = results.map(r => `${r.ok ? "PASS" : "FAIL"} ${r.name}${r.detail ? "  " + r.detail : ""}`).join("\n"); } }

async function bootLog (kind, detail) {
	try {
		const { bootlog, } = await browser.storage.local.get({ bootlog: [], });
		const entries = Array.isArray(bootlog) ? bootlog : [];
		entries.push(`${Date.now().toString(36)} smoke ${kind}${detail ? " " + detail : ""}`);
		await browser.storage.local.set({ bootlog: entries.slice(-80), });
	} catch (_error) { }
}

const send = message => browser.runtime.sendMessage(message);
const tst = (type, params = {}) => browser.runtime.sendMessage(TST_ID, { ...params, type });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function eventually (name, poll, timeoutMs = 8000) {
	const deadline = Date.now() + timeoutMs;
	let detail = "";
	while (Date.now() < deadline) {
		try { const value = (await poll()); if (value) { if (name) { record(name, true); } return value; } }
		catch (error) { detail = String(error); }
		(await sleep(150));
	}
	if (name) { record(name, false, detail); }
	return null;
}

async function download (payload, filename) {
	const text = JSON.stringify(payload, null, "\t");
	let url = null;
	try { url = URL.createObjectURL(new Blob([text], { type: "application/json", })); }
	catch (_error) { url = `data:application/json;base64,${btoa(unescape(encodeURIComponent(text)))}`; }
	await browser.downloads.download({ url, filename, conflictAction: "overwrite", saveAs: false, });
}

async function report (isTimeout) {
	if (reported) { return; }
	reported = true;
	let bootlog = [];
	try { const stored = await browser.storage.local.get({ bootlog: [], }); bootlog = stored.bootlog || []; }
	catch (_error) { }
	await download({
		userAgent: navigator.userAgent, isTimeout: !!isTimeout, bootlog, results,
		commands: await browser.commands.getAll()
			.then(list => list.map(c => ({ name: c.name, shortcut: c.shortcut || null, })))
			.catch(() => null),
	}, "tst-shelf-e2e.json");
	render();
}

setTimeout(async () => { (await report(true)); }, 240000); // watchdog

/** TST tree of one tab (via the external API: our addon is registered). */
async function treeOf (tabId) {
	const tab = await tst("get-tree", { tab: tabId });
	return tab || null;
}

async function main () {
	const isTimeout = false;
	try {
		const state = await eventually("registration lands with TST >= 4",
			async () => {
				const s = await send({ type: "test:state" });
				if (!(s && s.registered && s.usable)) { return null; }
				// the commands registration read from OUR OWN page: the
				// commands API answers any extension page, and the smoke
				// page IS one.  (0.3.2's background-side boot assert was
				// retired: the user's finding was key shadowing, not
				// registration.)
				const hasCmd = await browser.commands.getAll()
					.then(list => list.some(c => c.name === "tst-shelf:hints" && !!c.shortcut))
					.catch(() => false);
				return hasCmd ? s : null;
			}, 30000);
		if (!state) { return report(isTimeout); }

		const stored = await browser.storage.local.get("e2e-ids");
		if (stored["e2e-ids"]) {
			await phaseThree(stored["e2e-ids"]);
			return report(isTimeout);
		}
		await phaseOneAndTwo();
		return report(isTimeout);
	} catch (error) {
		record("smoke crashed", false, String(error && error.stack || error).slice(0, 400));
		return report(isTimeout);
	}
}

/** Builds the test tree: A <- (B, C, D); C <- (c1, c2); E = a root tab. */
async function buildTree () {
	// moz-extension pages carry a real favicon (the favicon-in-strap route
	// is under test) and never match TST's new-tab-command URL guesses.
	const TREE_URL = browser.runtime.getURL("tree-tab.html");
	// The owner gets a LONG title: a caption whose flex basis exceeds the
	// row is the condition that exposed the shelf-shrinking bug.
	const LONG_TITLE = "Shelf project — a deliberately long owner title that must be truncated by the shelf";
	const OWNER_URL = `${TREE_URL}?title=${encodeURIComponent(LONG_TITLE)}`;
	const win = await browser.windows.create({ url: OWNER_URL, });
	const windowId = win.id;
	const A = win.tabs[0].id;
	const mk = async opener => (await browser.tabs.create({ windowId, openerTabId: opener, url: TREE_URL, })).id;
	const B = await mk(A);
	const C = await mk(A);
	const D = await mk(A);
	const c1 = await mk(C);
	const c2 = await mk(C);
	// F: a second CHILDLESS child of A — switching between two childless
	// members must be a pure row swap with zero net height change.
	const F = await mk(A);
	const E = (await browser.tabs.create({ windowId, url: TREE_URL, })).id;
	const ids = { windowId, A, B, C, D, c1, c2, E, F, };
	await browser.storage.local.set({ "e2e-ids": ids, });
	return ids;
}

async function phaseOneAndTwo () {
	const ids = await buildTree();
	const attached = await eventually("TST attaches the tree", async () => {
		const tree = await treeOf(ids.C);
		return tree && tree.children && tree.children.length == 2 ? tree : null;
	}, 15000);

	// -- put on shelf -------------------------------------------------
	const putB = await send({ type: "test:put", tabId: ids.B });
	record("put on shelf returns true", putB && putB.ok === true);
	const sessionValue = await browser.sessions.getTabValue(ids.B, "tst-shelf");
	record("the sticky flag is stored as a tab session value", sessionValue && sessionValue.on === true, JSON.stringify(sessionValue));

	await send({ type: "test:put", tabId: ids.C });
	const stateC = await eventually("derivation lands C on A's shelf", async () => {
		const s = await send({ type: "test:state" });
		const shelf = s.shelves[ids.windowId] && s.shelves[ids.windowId].shelves.find(([owner]) => owner == ids.A);
		return s.shelved.includes(ids.C) && shelf && shelf[1].includes(ids.C) ? s : null;
	});
	if (!stateC) { return; }
	// 0.1.4: members have NO row at all — they are hidden tabs, the only
	// lever that removes a tab from TST's renderable set without
	// breaking its uniform-row arithmetic (a blank member row would be
	// the "gaps" 0.1.3 shipped).
	{
		// A member's row goes away by HIDING the tab: the only lever that
		// removes a tab from TST's renderable set without breaking its
		// uniform-row arithmetic.  A member with children keeps its row while
		// it is the active tab, because its subtree hangs from it.
		const state = await eventually(null, async () => {
			const s = await send({ type: "test:state" });
			return s.hiddenByUs.includes(ids.B) && s.hiddenByUs.includes(ids.C) ? s : null;
		}, 8000);
		const live = {
			B: (await browser.tabs.get(ids.B)).hidden,
			C: (await browser.tabs.get(ids.C)).hidden,
		};
		record("members keep no row — they are hidden tabs",
			!!state && state.hiddenByUs.includes(ids.B) && state.hiddenByUs.includes(ids.C)
			&& live.B === true && live.C === true,
			`hiddenByUs=${JSON.stringify(state && state.hiddenByUs)} live=${JSON.stringify(live)}`);
	}

	// Our context menu items must exist as OUR OWN browser.menus items
	// (the contextMenu-create route is invisible in plain tab menus —
	// see the implementation notes; this is the regression gate for that).
	const putItem = stateC.menu.items.find(item => item.id == "tst-shelf:put");
	const takeItem = stateC.menu.items.find(item => item.id == "tst-shelf:take");
	record("the context menu items exist as own browser.menus items",
		!!putItem && !!takeItem && putItem.title == "Put on shelf" && takeItem.title == "Take off the shelf",
		JSON.stringify(stateC.menu.items));

	// The order follows the LIVE native tab order; TST can still be
	// settling the tree right after the puts, so poll until the shelf
	// matches the live indices (the derivation catches up within one
	// debounce).
	await eventually("shelf members are listed in tab order", async () => {
		const s = await send({ type: "test:state" });
		const shelf = s.shelves[ids.windowId] && s.shelves[ids.windowId].shelves.find(([owner]) => owner == ids.A);
		if (!shelf || shelf[1].length != 2) { return null; }
		const liveTabs = await browser.tabs.query({ windowId: ids.windowId, });
		const liveIndex = Object.fromEntries(liveTabs.map(tab => [tab.id, tab.index]));
		const sorted = [ids.B, ids.C].sort((a, b) => liveIndex[a] - liveIndex[b]);
		return JSON.stringify(shelf[1]) == JSON.stringify(sorted) ? shelf : null;
	}, 8000);
	record("folded member carries the badge, childless one does not",
		stateC.shelves[ids.windowId].badges.includes(ids.C) && !stateC.shelves[ids.windowId].badges.includes(ids.B),
		`badges=${stateC.shelves[ids.windowId].badges}`);

	const foldedC = await treeOf(ids.C);
	record("putting on the shelf folds the subtree natively", (foldedC.states || []).includes("subtree-collapsed"), JSON.stringify(foldedC.states));

	// -- root shelf ----------------------------------------------------
	await send({ type: "test:put", tabId: ids.E });
	await eventually("a shelved root tab lands on the root shelf", async () => {
		const s = await send({ type: "test:state" });
		const root = s.shelves[ids.windowId].shelves.find(([owner]) => owner == "root");
		return root && root[1].includes(ids.E) ? s : null;
	});

	// -- take-off restores the pre-shelve place ------------------------
	// G is created at the END of the strip and then shelved, so the place
	// recorded at put time is the last index; taking it off must put it
	// back there.  Planning "move before the tab that now occupies the
	// saved index" left such a tab one slot short (before the last tab)
	// whenever it had to move toward a later index.
	{
		const G = (await browser.tabs.create({ windowId: ids.windowId, url: browser.runtime.getURL("tree-tab.html"), })).id;
		ids.G = G;
		await browser.storage.local.set({ "e2e-ids": ids });
		const stripOrder = async () => (await browser.tabs.query({ windowId: ids.windowId, }))
			.slice().sort((a, b) => a.index - b.index).map(tab => tab.id);
		const settledLast = await eventually(null, async () => {
			const order = await stripOrder();
			return order[order.length - 1] === G ? order : null;
		}, 8000);
		record("the extra root tab starts at the end of the strip", !!settledLast, JSON.stringify(settledLast));
		await send({ type: "test:put", tabId: G });
		await eventually("the extra root tab lands on the root shelf", async () => {
			const s = await send({ type: "test:state" });
			const root = s.shelves[ids.windowId].shelves.find(([owner]) => owner == "root");
			return root && root[1].includes(G) ? s : null;
		}, 8000);
		await send({ type: "test:take", tabId: G });
		const restored = await eventually(null, async () => {
			const order = await stripOrder();
			const s = await send({ type: "test:state" });
			return !s.shelved.includes(G) && order[order.length - 1] === G ? order : null;
		}, 8000);
		record("take off returns the tab to the end of the strip", !!restored, JSON.stringify(restored));
	}

	// -- take off ------------------------------------------------------
	await send({ type: "test:take", tabId: ids.B });
	await eventually("take off the shelf removes the member", async () => {
		const s = await send({ type: "test:state" });
		return !s.shelved.includes(ids.B) ? s : null;
	});
	const offSession = await browser.sessions.getTabValue(ids.B, "tst-shelf");
	record("taking off clears the session flag", !offSession || offSession.on !== true, JSON.stringify(offSession));

	// B goes back on the shelf: the driver will click C then B.
	await send({ type: "test:put", tabId: ids.B });
	// F is a second CHILDLESS member: switching B <-> F must be a pure row
	// swap, so the driver can tell a real jump from a legitimate fold.
	await send({ type: "test:put", tabId: ids.F });
	await eventually("the childless member F lands on A's shelf", async () => {
		const s = await send({ type: "test:state" });
		const shelf = s.shelves[ids.windowId] && s.shelves[ids.windowId].shelves.find(([owner]) => owner == ids.A);
		return shelf && shelf[1].length == 3 ? s : null;
	}, 8000);

	// -- the container line (0.6.4): markers on container members -------
	// The smoke page creates real containers (the E2E flavor carries the
	// `contextualIdentities` + `cookies` permissions); a clean profile
	// has none.  The container member is a ROOT member: the root strap's
	// icon order carries no E2E expectation, while A's shelf order is
	// asserted EXACTLY by the driver (the newest member is the rightmost).
	{
		const TREE_URL = browser.runtime.getURL("tree-tab.html");
		const containerX = await browser.contextualIdentities.create({ name: "e2e-shelf-line", color: "blue", icon: "fence", });
		const containerY = await browser.contextualIdentities.create({ name: "e2e-shelf-line-two", color: "red", icon: "fence", });
		const opened = await browser.tabs.create({ windowId: ids.windowId, url: TREE_URL, cookieStoreId: containerX.cookieStoreId, });
		const putOk = await send({ type: "test:put", tabId: opened.id });
		await eventually("the container member lands on the root shelf", async () => {
			const s = await send({ type: "test:state" });
			const root = s.shelves[ids.windowId] && s.shelves[ids.windowId].shelves.find(([owner]) => owner == "root");
			return root && root[1].includes(opened.id) ? s : null;
		}, 8000);
		record("a shelved container tab exists with its container",
			putOk && putOk.ok === true
				&& (await browser.tabs.get(opened.id)).cookieStoreId === containerX.cookieStoreId,
			JSON.stringify({ put: putOk, container: containerX.cookieStoreId, }));
		// the LIVE flip (the "follows a container change" scenario):
		// Firefox cannot retag a live tab, and the UI's own path —
		// "Reopen in Container" — recreates the tab in the other
		// container and closes the old one.  Same observable: the
		// shelved set keeps a member in the slot and the next strap
		// re-render carries the new container's marker.  No restart.
		const takeOk = await send({ type: "test:take", tabId: opened.id });
		const reopened = await browser.tabs.create({ windowId: ids.windowId, url: TREE_URL, cookieStoreId: containerY.cookieStoreId, });
		await browser.tabs.remove(opened.id).catch(() => {});
		const putBack = await send({ type: "test:put", tabId: reopened.id });
		await eventually("the reopened member is shelved in the second container", async () => {
			const s = await send({ type: "test:state" });
			const root = s.shelves[ids.windowId] && s.shelves[ids.windowId].shelves.find(([owner]) => owner == "root");
			return root && root[1].includes(reopened.id) ? s : null;
		}, 8000);
		ids.containerMember = reopened.id;
		ids.containerStore = containerY.cookieStoreId;
		ids.priorContainerStore = containerX.cookieStoreId;
		ids.controlMember = ids.F;
		await browser.storage.local.set({ "e2e-ids": ids, });
		record("the shelved container member follows a container change without a restart",
			!!(takeOk && takeOk.ok) && !!(putBack && putBack.ok),
			JSON.stringify({ take: takeOk, putBack, store: containerY.cookieStoreId, }));
	}

	// External add-tab-state probe: the smoke page sends it through the
	// same external channel the background uses; the driver later checks
	// whether it landed in TST's background model.
	await tst("add-tab-state", { tab: ids.D, state: "tst-shelf-smoke-probe" });

	// -- Firefox's hidden-tab invariant (characterization) -------------
	// The member rows are reclaimed by hiding tabs, so the shelf lives
	// with this rule: a hidden tab that becomes the ACTIVE tab is
	// revealed, and the active tab cannot be hidden again.  Recorded so
	// the design never assumes otherwise.
	{
		const probe = await send({ type: "test:probe-hidden", windowId: ids.windowId, });
		record("Firefox reveals a hidden tab when it is activated",
			probe && probe.hiddenAfterHide === true && probe.afterActivate && probe.afterActivate.hidden === false
			&& probe.afterActivate.active === true,
			JSON.stringify(probe));
		record("Firefox refuses to hide the active tab again",
			probe && probe.afterRehide && probe.afterRehide.hidden === false && probe.afterRehide.active === true,
			JSON.stringify(probe));
	}

	// -- hint mode: the decline rule, then the closed-sidebar no-op -----
	{
		// the fixture window's ACTIVE tab is an about:blank fixture tab —
		// a page the catcher can never be injected into (MDN: executeScript
		// rejects top-level about: frames), so the hotkey is a deliberate
		// no-op there: entering declines with the injectability reason,
		// never a mode that traps the keyboard.  (An extension page as
		// the active tab declines identically — same scheme set.)
		const declined = await send({ type: "test:enter-hints", windowId: ids.windowId, });
		record("entering hint mode from an extension page declines (the active tab cannot host the catcher)",
			declined && declined.ok === false && declined.reason === "active-tab-not-injectable",
			JSON.stringify(declined));
		// a REAL http page: injectable — the mode enters, the catcher is
		// armed there for real, and with no sidebar page yet (phase 2
		// opens one) no key source ever confirms the mode: the timeout
		// tears it down with nothing painted.  With the default options
		// only the http page itself carries a code (the fixture's
		// about:blank tabs are special pages).
		const hintTab = await browser.tabs.create({ windowId: ids.windowId, url: HINT_PAGE, active: true, });
		await eventually("the real http page settles", async () => {
			const live = await browser.tabs.get(hintTab.id);
			// the tab BRIEFLY sits at about:blank with status "complete"
			// before the navigation commits — the URL is the real signal
			return live.url === HINT_PAGE && live.status === "complete" ? live : null;
		}, 10000);
		const entered = await send({ type: "test:enter-hints", windowId: ids.windowId, });
		record("entering hint mode from a real http page reports itself (no sidebar yet)",
			entered && entered.ok === true, JSON.stringify(entered));
		await eventually("the page catcher is armed inside the real http page", async () => {
			const s = await send({ type: "test:state" });
			return (s.bootlog || []).some(line => line.includes(`hints-arm tab ${hintTab.id}`)) ? s : null;
		}, 10000);
		const immediateState = await send({ type: "test:state" });
		record("the mode without a sidebar stays unconfirmed (no key source)",
			immediateState && immediateState.hints && immediateState.hints.confirmed === false
				&& (immediateState.hints.codes || []).length > 0,
			JSON.stringify(immediateState && immediateState.hints));
		const refused = await send({ type: "test:hint-key", key: "a", });
		record("a keydown with no confirmed mode is refused", refused && refused.verdict === "false",
			JSON.stringify(refused));
		await eventually("the unconfirmed mode times out and exits", async () => {
			const s = await send({ type: "test:state" });
			return s && s.hints == null ? s : null;
		}, 15000);
		// the fixture must return to its exact shape: the driver's tree
		// geometry checks (the pure-swap sampler) measure row positions,
		// and one extra bottom row lets TST's virtual scroll transiently
		// render the tree WITHOUT the just-activated member's row (the
		// render range is only ~4 rows in the tab-hosted sidebar) — the
		// check's premise is a tree that fits the range entirely
		await browser.tabs.remove(hintTab.id).catch(() => {});
	}

	// -- setup report for the driver (window id + expectations) --------
	// the readout the driver needs, plus the background's bootlog: the
	// commands-registration line rides it (the readiness gate above
	// waited for it, so it is on disk by now)
	const bootlog = (await browser.storage.local.get({ bootlog: [], }).catch(() => ({}))).bootlog || [];
	await download({
		windowId: ids.windowId,
		bootlog,
		commands: await browser.commands.getAll()
			.then(list => list.map(c => ({ name: c.name, shortcut: c.shortcut || null, })))
			.catch(() => null),
		expect: {
			owner: ids.A, members: [ids.B, ids.C], rootMember: ids.E,
			children: [ids.c1, ids.c2],
			clickFirst: ids.C, clickSecond: ids.B,
			plain: ids.D, f: ids.F,
			nestedOwner: ids.C, nestedMember: ids.c1,
			containerMember: ids.containerMember, containerStore: ids.containerStore,
			priorContainerStore: ids.priorContainerStore, controlMember: ids.controlMember,
		},
		results,
	}, "tst-shelf-e2e-setup.json");
	await bootLog("setup-report", `window ${ids.windowId}`);

	// -- interaction phase: the DRIVER clicks the icons ----------------
	await eventually("click on a shelf icon activates the shelved tab", async () => {
		const tab = await browser.tabs.get(ids.C);
		return tab && tab.active ? tab : null;
	}, 90000);
	const unfoldedC = await treeOf(ids.C);
	record("selecting the icon unfolds its subtree", !(unfoldedC.states || []).includes("subtree-collapsed"), JSON.stringify(unfoldedC.states));
	// The clicked member itself is hidden (0.1.4) unless Firefox chooses
	// to reveal the tab it activates — either way the ICON is the shelf's
	// presentation, and the derivation must highlight it.
	{
		const shelfState = await eventually(null, async () => {
			const state = await send({ type: "test:state" });
			const shelf = state.shelves[ids.windowId] && state.shelves[ids.windowId].shelves.find(([owner]) => owner == ids.A);
			const highlighted = state.shelves[ids.windowId].highlights.includes(ids.C);
			return highlighted && shelf && shelf[1].includes(ids.C) ? state : null;
		}, 8000);
		const revealed = !(await browser.tabs.get(ids.C)).hidden;
		record("the selected member is highlighted on the shelf", !!shelfState,
			`revealed=${revealed} highlights=${JSON.stringify(shelfState && shelfState.shelves[ids.windowId].highlights)}`);
	}

	await eventually("clicking another tab of the same shelf folds the first", async () => {
		const tab = await browser.tabs.get(ids.B);
		return tab && tab.active ? tab : null;
	}, 90000);
	const refoldedC = await treeOf(ids.C);
	record("one subtree stays visible per shelf", (refoldedC.states || []).includes("subtree-collapsed"), JSON.stringify(refoldedC.states));

	// A member is revealed by Firefox when it becomes the active tab (see
	// the characterization probe below: the active tab cannot be hidden).
	// What must hold is that the row goes away again IMMEDIATELY — not
	// after the 120 ms re-derivation debounce — or a clicked childless
	// member would leave a lingering row in the tree.
	{
		// NOTE: this page is a BACKGROUND tab, so setTimeout is throttled
		// to 1000 ms — the poll must not use timers, or it measures the
		// throttle instead of the re-hide.  IPC round-trips pace the loop.
		const startedAt = Date.now();
		await browser.tabs.update(ids.A, { active: true, });
		let elapsed = -1;
		for (let attempt = 0; attempt < 500; attempt++) {
			const live = await browser.tabs.get(ids.B).catch(() => null);
			// Firefox revealed B when it was activated; it must be hidden again
			// as soon as it stops being active, so its row goes away
			const ready = live && (live.hidden || false);
			if (ready) { elapsed = Date.now() - startedAt; break; }
			await Promise.resolve();
		}
		record("the member is hidden again the moment another tab becomes active", elapsed >= 0 && elapsed < 250,
			`elapsed=${elapsed}ms (a full re-derivation costs 120ms of debounce on top)`);
		record("a member's row disappears when it stops being active", elapsed >= 0, `elapsed=${elapsed}ms`);
		const state = await eventually(null, async () => {
			const s = await send({ type: "test:state" });
			const shelf = s.shelves[ids.windowId] && s.shelves[ids.windowId].shelves.find(([owner]) => owner == ids.A);
			return shelf && shelf[1].length == 3 ? s : null;
		}, 8000);
		record("the member is still listed on the shelf after that", !!state,
			JSON.stringify(state && state.shelves[ids.windowId].shelves));
	}

	// -- context menus --------------------------------------------------
	// Native menus open only for TRUSTED events, which the headless rig
	// cannot produce; the visibility logic the menus.onShown listener
	// runs is exercised through the internal hook instead (delivery
	// itself is verified on a GUI Firefox — see the README).
	const menuShelved = await send({ type: "test:menu-shown", tabId: ids.C });
	record("menu visibility on a shelved tab: Take off visible, Put hidden",
		menuShelved && menuShelved.menu.lastTabId == ids.C
			&& menuShelved.menu.lastTakeVisible === true && menuShelved.menu.lastPutVisible === false,
		JSON.stringify(menuShelved && menuShelved.menu));
	record("the Shelf submenu is visible for a shelved tab",
		menuShelved && menuShelved.menu.lastShelfVisible === true
			&& menuShelved.menu.items.some(item => item.id == "tst-shelf:place-left")
			&& menuShelved.menu.items.some(item => item.id == "tst-shelf:place-right"),
		JSON.stringify(menuShelved && menuShelved.menu));
	const menuPlain = await send({ type: "test:menu-shown", tabId: ids.A });
	record("menu visibility on a plain tab: Put visible, Take hidden",
		menuPlain && menuPlain.menu.lastTabId == ids.A
			&& menuPlain.menu.lastPutVisible === true && menuPlain.menu.lastTakeVisible === false,
		JSON.stringify(menuPlain && menuPlain.menu));
	record("the Shelf submenu is hidden for an unshelved tab",
		menuPlain && menuPlain.menu.lastShelfVisible === false,
		JSON.stringify(menuPlain && menuPlain.menu));

	// -- extreme placements ("Place leftmost" / "Place rightmost") ------
	// At this point the strap order is [C, B, F] (B was re-put, forcing it
	// to the end; F followed).  "Place rightmost" moves C to the last slot
	// and "Place leftmost" returns it to the front; the shelf ends where
	// it started, so the driver's later icon-order assertion holds.
	{
		const shelfOrder = async () => {
			const s = await send({ type: "test:state" });
			const shelf = s.shelves[ids.windowId] && s.shelves[ids.windowId].shelves.find(([owner]) => owner == ids.A);
			return shelf ? shelf[1] : null;
		};
		const movedRight = await send({ type: "test:place", tabId: ids.C, side: "right", });
		const swung = await eventually(null, async () => {
			const order = await shelfOrder();
			return order && JSON.stringify(order) == JSON.stringify([ids.B, ids.F, ids.C]) ? order : null;
		}, 8000);
		record("Place rightmost makes C the last icon of its shelf", !!swung,
			`ok=${movedRight && movedRight.ok} order=${JSON.stringify(swung)}`);
		const movedLeft = await send({ type: "test:place", tabId: ids.C, side: "left", });
		const restored = await eventually(null, async () => {
			const order = await shelfOrder();
			return order && JSON.stringify(order) == JSON.stringify([ids.C, ids.B, ids.F]) ? order : null;
		}, 8000);
		record("Place leftmost puts C back at the front of its shelf", !!restored,
			`ok=${movedLeft && movedLeft.ok} order=${JSON.stringify(restored)}`);
		const already = await send({ type: "test:place", tabId: ids.C, side: "left", });
		const unchanged = await shelfOrder();
		record("an already-extreme member does not move (no-op returns ok)",
			already && already.ok === true && JSON.stringify(unchanged) == JSON.stringify([ids.C, ids.B, ids.F]),
			`ok=${already && already.ok} order=${JSON.stringify(unchanged)}`);
	}

	// -- a shelf of shelves: shelve c1 on C's shelf ---------------------
	// C is a member of A's shelf AND the owner of its own shelf.  The
	// driver's last phase activates c1 and checks that C keeps its row
	// (and with it the nested strap) instead of disappearing.
	await send({ type: "test:put", tabId: ids.c1 });
	await eventually("c1 lands on C's nested shelf", async () => {
		const s = await send({ type: "test:state" });
		const nested = s.shelves[ids.windowId] && s.shelves[ids.windowId].shelves.find(([owner]) => owner == ids.C);
		return nested && nested[1].includes(ids.c1) ? s : null;
	}, 8000);

	// -- favicon stickiness while a shelved tab reloads -----------------
	// Navigate the shelved C to a page with no favicon: the icon must
	// keep the last known favicon while the tab loads and after it
	// completes (the live tab reports none; the derivation's favicon
	// comes from the resolveFavicons memory — same record that feeds
	// the strap HTML, so the rendered style attribute is unchanged).
	{
		const before = await browser.tabs.get(ids.C);
		const remembered = before.favIconUrl;
		record("the shelved tab starts with a favicon", !!remembered, String(remembered));
		if (remembered) {
			await send({ type: "test:navigate", tabId: ids.C, url: "about:blank", });
			await eventually("a reloading shelved tab keeps the remembered favicon", async () => {
				const live = await browser.tabs.get(ids.C);
				if (live.status != "complete" || live.favIconUrl) { return null; }
				const s = await send({ type: "test:state" });
				return s.favicons && s.favicons[String(ids.C)] == remembered ? s : null;
			}, 15000);
		}
	}
}

async function phaseThree (ids) {
	// Reinstall wiped the runtime state; the boot path must rebuild it
	// from session values (the restart-persistence proxy: identical code
	// path, since a real restart cannot keep a temporary addon).
	const state = await eventually("shelved set rebuilt from session values", async () => {
		const s = await send({ type: "test:state" });
		return s.registered && s.usable && s.shelved.length >= 3 ? s : null;
	}, 30000);
	if (!state) { return; }

	const same = [ids.B, ids.C, ids.E].every(id => state.shelved.includes(id));
	record("the same tabs are shelved after the reinstall", same, JSON.stringify(state.shelved));

	record("menu items exist after the reinstall (boot-time creation)",
		state.menu.items.some(item => item.id == "tst-shelf:put") && state.menu.items.some(item => item.id == "tst-shelf:take"),
		JSON.stringify(state.menu.items));
	record("the Shelf submenu items exist after the reinstall",
		state.menu.items.some(item => item.id == "tst-shelf:place-left")
			&& state.menu.items.some(item => item.id == "tst-shelf:place-right")
			&& state.menu.items.some(item => item.id == "tst-shelf:shelf"),
		JSON.stringify(state.menu.items));

	await eventually("the shelf derivation re-lands", async () => {
		const s = await send({ type: "test:state" });
		const shelf = s.shelves[ids.windowId] && s.shelves[ids.windowId].shelves.find(([owner]) => owner == ids.A);
		const root = s.shelves[ids.windowId].shelves.find(([owner]) => owner == "root");
		const ok = shelf && shelf[1].length == 3 && root && root[1].includes(ids.E);
		if (!ok && !phaseThree.diagnosed) {
			phaseThree.diagnosed = true;
			const tree = await tst("get-light-tree", { windowId: ids.windowId, }).catch(error => ({ error: String(error), }));
			const eNode = (function find (nodes) {
				for (const node of nodes || []) {
					if (node.id == ids.E) { return node; }
					const found = find(node.children);
					if (found) { return found; }
				}
				return null;
			})(Array.isArray(tree) ? tree : []);
			const live = await browser.tabs.get(ids.E).catch(error => ({ error: String(error), }));
			record("phase 3 diagnostic", true,
				JSON.stringify({ shelves: s.shelves, shelved: s.shelved, hiddenByUs: s.hiddenByUs,
					rootIds: (Array.isArray(tree) ? tree : []).map(node => node.id),
					eNode, live: { hidden: live.hidden, active: live.active, index: live.index, error: live.error, },
				}).slice(0, 380));
		}
		return ok ? s : null;
	}, 15000);

	const refoldedC = await treeOf(ids.C);
	record("TST's native fold state persisted through the reinstall",
		(refoldedC.states || []).includes("subtree-collapsed"),
		JSON.stringify(refoldedC.states));
	record("hint mode stays down after the restart (runtime-only state)",
		state.hints == null, JSON.stringify(state.hints));

	// -- the page catcher's channel, for real, after the reinstall -----
	// The 0.4.4 path: the catcher is armed in a REAL http page (the
	// driver's hint server) — this extension page cannot host it (MDN),
	// and the smoke page's old runtime-message relay is now an ORPHAN
	// by design (the armed catcher lives in the http tab, so the
	// alive-ack must reject any other sender).  The production path
	// runs instead: executeScript injects hint-catcher.js there, and a
	// keydown inside the page rides the injected listener.
	{
		const hintTabs = await browser.tabs.query({ windowId: ids.windowId, url: "http://127.0.0.1/*", });
		const hintTab = hintTabs[0] || null;
		record("the hint fixture page survived the reinstall", !!hintTab,
			`count=${hintTabs.length}`);
		if (hintTab) {
			await browser.tabs.update(hintTab.id, { active: true, });
			const entered = await send({ type: "test:enter-hints", windowId: ids.windowId, });
			record("hint mode enters after the reinstall (a real page is the anchor)",
				entered && !!entered.ok, JSON.stringify(entered));
			const code = entered && entered.ok && (entered.codes || [])[0];
			if (entered && entered.ok && code) {
				await eventually("the catcher is armed in the real page again", async () => {
					const s = await send({ type: "test:state" });
					return (s.bootlog || []).some(line => line.includes(`hints-arm tab ${hintTab.id}`)) ? s : null;
				}, 10000);
				// the production path: a keydown dispatched inside the armed
				// page.  The default options code only the http tabs
				// (single letters), so the key ACTIVATES and ends the mode.
				const ack = await send({ type: "test:page-key", tabId: hintTab.id, key: String(code[1]).charAt(0), });
				record("a keydown inside the armed page is dispatched", ack && ack.ok === true,
					JSON.stringify(ack));
				const after = await send({ type: "test:state" });
				record("the key reached the mode through the real catcher (activation ended it)",
					after && after.hints == null,
					JSON.stringify(after && after.hints));
			}
		}
	}
}

main().catch(error => { record("smoke crashed", false, String(error && error.stack || error)); report(false); });
