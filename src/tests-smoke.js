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
	await download({ userAgent: navigator.userAgent, isTimeout: !!isTimeout, bootlog, results, }, "tst-shelf-e2e.json");
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
				return s && s.registered && s.usable ? s : null;
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

	// -- setup report for the driver (window id + expectations) --------
	await download({
		windowId: ids.windowId,
		expect: {
			owner: ids.A, members: [ids.B, ids.C], rootMember: ids.E,
			children: [ids.c1, ids.c2],
			clickFirst: ids.C, clickSecond: ids.B,
			plain: ids.D, f: ids.F,
			nestedOwner: ids.C, nestedMember: ids.c1,
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
	const menuPlain = await send({ type: "test:menu-shown", tabId: ids.A });
	record("menu visibility on a plain tab: Put visible, Take hidden",
		menuPlain && menuPlain.menu.lastTabId == ids.A
			&& menuPlain.menu.lastPutVisible === true && menuPlain.menu.lastTakeVisible === false,
		JSON.stringify(menuPlain && menuPlain.menu));

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
}

main().catch(error => { record("smoke crashed", false, String(error && error.stack || error)); report(false); });
