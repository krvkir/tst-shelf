/**
 * E2E driver for tst-shelf: launches an isolated headless Firefox on a
 * copy of the clean fixture profile (Tree Style Tab only),
 * temporary-installs the built extension through the Marionette
 * `Addon:Install` command, and runs three phases:
 *
 *   1. install — wait for the smoke page's setup report
 *      (tst-shelf-e2e-setup.json: the extension is alive, the tree built,
 *      the puts landed; also carries the test window id and expected
 *      tab ids).
 *   2. sidebar DOM — open TST's own sidebar page in a tab
 *      (moz-extension://<tst-uuid>/sidebar/sidebar.html?windowId=N — TST
 *      runs its full sidebar there, including extra-contents shadow
 *      roots), assert the rendered shelves in the DOM (row state classes,
 *      strap icons with data-tab-id/title/favicon style, the plus badge,
 *      the root shelf strap), then dispatch synthetic mousedown events on
 *      the shelf icons — the smoke page in its own tab asserts the
 *      selection choreography (C active+unfolded, then B active and C
 *      refolded: one subtree per shelf).
 *   3. reinstall — Addon:Install into the SAME session (runtime state
 *      wiped, session values intact): the restarted smoke page must
 *      rebuild the shelved set from session values — the
 *      restart-persistence proxy (temporary installs never survive a
 *      real restart; the boot path is identical).
 *
 * Usage: node tests/e2e-drive.mjs [--dist dist-e2e]
 *                                 [--port 2829] [--timeout 150] [--keep]
 * Exit codes: 0 all results ok, 1 failing results, 2 harness failure.
 */
"use strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, } from "node:child_process";
import net from "node:net";
import { fileURLToPath, } from "node:url";
import { Marionette, } from "./marionette.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const FIXTURE = path.join(HERE, "fixture-profile");
const DOWNLOADS = path.join(HERE, "e2e-downloads");
const SETUP_REPORT = path.join(DOWNLOADS, "tst-shelf-e2e-setup.json");
const FINAL_REPORT = path.join(DOWNLOADS, "tst-shelf-e2e.json");
const CONSOLE_LOG = path.join(HERE, "e2e-console.log");
const FIREFOX_LOG = path.join(HERE, "e2e-firefox.log");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = argv.indexOf(name);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PORT = Number(flag("--port", 2829));
const TIMEOUT_S = Number(flag("--timeout", 150));
const KEEP = argv.includes("--keep");
const HEADED = argv.includes("--headed");
const FIREFOX_BIN = flag("--bin", "/usr/bin/firefox");
/** The built extension tree to install.  `make e2e` passes dist-e2e, so the
 *  production dist/ is never installed by the harness (and can never be
 *  left holding a test build). */
const DIST = path.resolve(REPO, flag("--dist", "dist"));
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "tst-shelf-e2e-"));
const PREFS = path.join(SCRATCH, "prefs.js");
const die = error => { console.error(error && error.stack || String(error)); process.exitCode = 2; };

/** A report file exists AND parses (downloads are created empty first). */
function reportReady (path) {
	try {
		const text = fs.readFileSync(path, "utf8");
		if (!text.trim()) { return null; }
		return JSON.parse(text);
	} catch (_error) { return null; }
}

async function waitForReport (path, timeoutMs, afterMs = 0) {
	const threshold = Date.now() + afterMs;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const report = reportReady(path);
		if (report && Date.now() >= threshold) { return report; }
		await new Promise(resolve => setTimeout(resolve, 500));
	}
	return null;
}

function readTstUuid (prefsPath) {
	try {
		const text = fs.readFileSync(prefsPath, "utf8");
		const line = text.split("\n").find(l => l.startsWith(`user_pref("extensions.webextensions.uuids"`));
		const inner = line && line.match(/uuids", "(.*)"\);/);
		if (!inner) { return null; }
		const map = JSON.parse(JSON.parse(`"${inner[1]}"`));
		return map["treestyletab@piro.sakura.ne.jp"] || null;
	} catch (_error) { return null; }
}

async function commandTry (marionette, name, fallbacks, params) {
	const names = [name, ...fallbacks];
	let lastError = null;
	for (const attempt of names) {
		try { return await marionette.command(attempt, params); }
		catch (error) { lastError = error; }
	}
	throw lastError;
}

function prepareProfile () {
	fs.cpSync(FIXTURE, SCRATCH, { recursive: true, });
	fs.appendFileSync(path.join(SCRATCH, "prefs.js"), `user_pref("marionette.port", ${PORT});\n`);
}

async function waitForPort (timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const open = await new Promise(resolve => {
			const probe = net.createConnection({ port: PORT, host: "127.0.0.1", });
			probe.once("connect", () => { probe.destroy(); resolve(true); });
			probe.once("error", () => { probe.destroy(); resolve(false); });
		});
		if (open) { return; }
		await new Promise(resolve => setTimeout(resolve, 500));
	}
	throw new Error(`firefox did not open marionette port ${PORT} within ${timeoutMs}ms`);
}

// Marionette (Firefox 158) takes the script as a plain FUNCTION BODY:
// args arrive in `arguments`, promises are awaited, and the historical
// IIFE-with-arguments form silently returns null (probed in
// tests/probe-mexec.mjs).
const mirrorScript = String.raw`
	const [logPath, lockPath] = arguments;
	const out = text => {
		try { dump("[mirror] " + text + "\n"); } catch (dumpError) { }
		try {
			if (typeof IOUtils === "object") {
				IOUtils.writeUTF8(logPath, text + "\n", { mode: "append", }).catch(() => { });
			}
		} catch (ioError) { }
	};
	return (async () => {
		try {
			if (!globalThis.Services) {
				try { globalThis.Services = ChromeUtils.importESModule("resource://gre/modules/Services.sys.mjs").Services; }
				catch (importError1) {
					try { globalThis.Services = ChromeUtils.importESModule("moz-src:///Services.sys.mjs").Services; }
					catch (importError2) { return { live: false, error: String(importError2).slice(0, 200), }; }
				}
			}
			if (await IOUtils.exists(lockPath)) { return { live: "already", }; }
			await IOUtils.writeUTF8(lockPath, new Date().toISOString());
			const listener = { observe (msg) { try {
				const line = typeof msg?.lineNumber !== "undefined"
					? "JS[" + (msg.category ?? "error") + "] " + msg.message +
						(msg.sourceName ? " @" + msg.sourceName + ":" + msg.lineNumber : "")
					: "LOG " + String(msg?.message ?? msg);
				out(line);
			} catch (error) { out("hook-error " + error); } }, };
			globalThis.Services.console.registerListener(listener);
			out("[hook] console mirror installed");
			return { live: true, };
		} catch (error) {
			return { live: false, error: String(error && error.stack || error).slice(0, 400), };
		}
	})();
`;

/** Runs on the tab-hosted TST sidebar page (content context).  Returns
 *  the shelf DOM snapshot; `arguments[0]` (if non-null) dispatches a
 *  synthetic mousedown on that shelf icon (composed event into the
 *  shadow root).  No backticks: this is one big String.raw template. */
const sidebarScript = String.raw`
	const clickId = arguments[0];
	const flat = [];
	const icons = [];
	for (const row of document.querySelectorAll("tab-item[data-tab-id]")) {
		const rect = row.getBoundingClientRect();
		const info = {
			id: row.dataset.tabId,
			classes: [...row.classList],
			top: rect.top,
			height: rect.height,
		};
		// tab-item itself has NO shadow root: the extra-items spans are
		// light-DOM children (inside tab-item-substance), and each span
		// carries its own open shadow root with the addon contents.
		const below = row.querySelector(".extra-items-container.below");
		const root = below && below.shadowRoot;
		const strap = root && root.querySelector('[part~="shelf-strap"]');
		if (strap) {
			info.strap = true;
			for (const icon of strap.querySelectorAll('[part~="shelf-icon"]')) {
				const record = {
					id: icon.dataset.tabId,
					title: (icon.getAttribute("title") || "").split("\n")[0],
					hasBg: /background-image/.test(icon.getAttribute("style") || ""),
					draggable: icon.getAttribute("draggable"),
					badge: !!icon.querySelector('[part~="shelf-badge"][part~="tst-shelf-badge-on"]'),
					active: (icon.getAttribute("part") || "").includes("tst-shelf-icon-active"),
				};
				icons.push(record);
				if (clickId != null && record.id == String(clickId)) {
					const rect = icon.getBoundingClientRect();
					icon.dispatchEvent(new MouseEvent("mousedown", {
						bubbles: true, composed: true, button: 0,
						clientX: rect.x + 5, clientY: rect.y + 5,
					}));
					record.clicked = true;
				}
			}
		}
		flat.push(info);
	}
	const top = document.querySelector("#tabbar-top .extra-items-container");
	const topRoot = top && top.shadowRoot;
	const topStrap = topRoot && topRoot.querySelector('[part~="shelf-strap"]');
	const rootIcons = [];
	if (topStrap) {
		for (const icon of topStrap.querySelectorAll('[part~="shelf-icon"]')) {
			rootIcons.push({
				id: icon.dataset.tabId,
				title: (icon.getAttribute("title") || "").split("\n")[0],
				hasBg: /background-image/.test(icon.getAttribute("style") || ""),
			});
		}
	}
	const normal = document.querySelector("#normal-tabs-container .tabs");
	return JSON.stringify({
		href: location.href,
		readyState: document.readyState,
		allTabItems: document.querySelectorAll("tab-item").length,
		rowsWithTabId: flat.length,
		rows: flat, icons, rootIcons, clicked: !!clickId,
		normalChildren: normal ? normal.children.length : -1,
	});
`;

/** Conformance probe: painted rows against TST's geometry model.
 *  TST never measures painted rows: drop zones, virtual scroll and sticky all
 *  derive positions from the tab model (scroll.js getItemRect).  The model's
 *  contract is: every renderable row is an INTEGER number of one-line heights
 *  (a stock TST allows only 1, the A3 patch allows N), the rows are laid out
 *  contiguously, and the first row starts at the content origin.  Any painted
 *  deviation — a grown strap row on a model that says one line (0.1.1) or a
 *  zero-height member row — shifts every computed rect below it and makes
 *  drop-overs resolve to the wrong position. */
const conformanceScript = String.raw`
	const container = document.querySelector("#normal-tabs-container");
	const rows = [...container.querySelectorAll("tab-item[data-tab-id]")];
	const heights = rows.map(row => Math.round(row.getBoundingClientRect().height * 10) / 10);
	const rowH = heights.length ? Math.min(...heights) : 0;
	const containerTop = container.getBoundingClientRect().top;
	const scrollTop = container.scrollTop;
	const origin = containerTop - scrollTop;
	const drift = [];
	let previousBottom = null;
	rows.forEach((row, index) => {
		const rect = row.getBoundingClientRect();
		// 1. the painted height must be an integer number of lines
		const lines = rowH > 0 ? rect.height / rowH : 0;
		if (rowH > 0 && Math.abs(lines - Math.round(lines)) > 0.05) {
			drift.push({ id: row.dataset.tabId, index: index, reason: "height", height: heights[index], rowH: rowH });
		}
		// 2. rows must be contiguous: no gaps, no overlaps
		if (previousBottom != null && Math.abs(rect.top - previousBottom) > 1.5) {
			drift.push({ id: row.dataset.tabId, index: index, reason: "gap", top: Math.round(rect.top), previousBottom: Math.round(previousBottom) });
		}
		previousBottom = rect.bottom;
	});
	return JSON.stringify({ rows: rows.length, rowH: rowH, anchor: Math.abs((rows[0] ? rows[0].getBoundingClientRect().top : 0) - origin), drift: drift });
`;

/** Visibility probe for the selected shelved tab's children rows, plus
 *  the plain sibling for the dangle-position check (bug 2) and the owner
 *  row (the shelf's space lies between the owner and the children). */
const visibilityScript = String.raw`
	const rowOf = id => document.querySelector('tab-item[data-tab-id="' + id + '"]');
	const probe = id => {
		const row = rowOf(id);
		return {
			exists: !!row,
			top: row ? row.getBoundingClientRect().top : -1,
			height: row ? row.getBoundingClientRect().height : -1,
			classes: row ? [...row.classList].join(",") : "",
		};
	};
	return JSON.stringify({ c1: probe(arguments[0]), c2: probe(arguments[1]), plain: probe(arguments[2]), owner: probe(arguments[3]), });
`;

/** Strap geometry probe (0.1.4 spec: the shelf lives in the owner's OWN
 *  row — at most 2/3 of its width, one line, horizontally scrollable —
 *  and the row never grows).  The strap is inflated with cloned icons
 *  so the overflow path is measured deterministically instead of
 *  depending on how many members the fixture happens to have: the clone
 *  set is removed before the script returns.  `arguments[0]` = owner id,
 *  `arguments[1]` = a plain (shelfless) row id for the height baseline. */
const strapGeometryScript = String.raw`
	const owner = arguments[0];
	const plainId = arguments[1];
	const row = document.querySelector('tab-item[data-tab-id="' + owner + '"]');
	const plain = document.querySelector('tab-item[data-tab-id="' + plainId + '"]');
	const below = row && row.querySelector('.extra-items-container.below');
	const strap = below && below.shadowRoot && below.shadowRoot.querySelector('[part~="shelf-strap"]');
	const label = row && row.querySelector('tab-label');
	if (!row || !strap) {
		return JSON.stringify({ missing: true, row: !!row, strap: !!strap });
	}
	const rowWidth = row.getBoundingClientRect().width;
	const naturalWidth = strap.getBoundingClientRect().width;
	const naturalLabelTruncated = !!label && label.scrollWidth > label.clientWidth + 1;
	const overflowX = getComputedStyle(strap).overflowX;
	const template = strap.querySelector('[part~="shelf-icon"]');
	// the shelf as it really is: the icons must fit without shrinking and
	// without a scrollbar (0.1.4 shrank the shelf to less than one icon
	// when the owner's title was long)
	const naturalIcons = strap.querySelectorAll('[part~="shelf-icon"]').length;
	const gap = parseFloat(getComputedStyle(strap).columnGap) || 0;
	const ui = row.querySelector(".ui");
	const uiWidth = ui ? ui.getBoundingClientRect().width : rowWidth;
	const iconWidth = template ? template.getBoundingClientRect().width : 0;
	// TST's own icon size: the size an UNSHRUNK cell must have (a shrunk
	// shelf shrinks its cells too, so measuring the cell alone can pass
	// vacuously — this is the independent reference).
	const expectedIconSize = parseFloat(getComputedStyle(row).getPropertyValue("--faviconized-tab-size")) || 0;
	const naturalScrolls = strap.scrollWidth > strap.clientWidth + 1;
	const clones = [];
	for (let index = 0; index < 40 && template; index++) {
		const clone = template.cloneNode(true);
		strap.appendChild(clone);
		clones.push(clone);
	}
	const inflatedWidth = strap.getBoundingClientRect().width;
	const scrolls = strap.scrollWidth > strap.clientWidth + 1;
	const inflatedLabelTruncated = !!label && label.scrollWidth > label.clientWidth + 1;
	const rowHeight = row.getBoundingClientRect().height;
	const plainHeight = plain ? plain.getBoundingClientRect().height : -1;
	const strapHeight = strap.getBoundingClientRect().height;
	for (const clone of clones) { strap.removeChild(clone); }
	return JSON.stringify({
		rowWidth, naturalWidth, inflatedWidth, scrolls, overflowX,
		naturalLabelTruncated, inflatedLabelTruncated,
		naturalIcons, iconWidth, naturalScrolls, expectedIconSize, gap, uiWidth,
		rowHeight, plainHeight, strapHeight,
		ratio: rowWidth ? inflatedWidth / rowWidth : -1,
		cleaned: strap.querySelectorAll('[part~="shelf-icon"]').length,
	});
`;

/** Line-fitting probe: what does the engine report about a row whose extra
 *  contents want more room than the row's pinned height?  Injects a wrapping
 *  strap + a released cap, measures, then removes the injected style.  The
 *  numbers decide how TST can round a row's height up to whole lines. */
const lineProbeScript = String.raw`
	const owner = arguments[0];
	const row = document.querySelector('tab-item[data-tab-id="' + owner + '"]');
	const read = label => {
		const below = row.querySelector('.extra-items-container.below');
		const strap = below && below.shadowRoot && below.shadowRoot.querySelector('[part~="shelf-strap"]');
		const span = below && below.querySelector('.extra-item');
		return {
			label,
			rowClient: row.clientHeight,
			rowScroll: row.scrollHeight,
			rowRect: Math.round(row.getBoundingClientRect().height * 10) / 10,
			belowClient: below ? below.clientHeight : -1,
			belowScroll: below ? below.scrollHeight : -1,
			belowRect: below ? Math.round(below.getBoundingClientRect().height * 10) / 10 : -1,
			spanRect: span ? Math.round(span.getBoundingClientRect().height * 10) / 10 : -1,
			strapRect: strap ? Math.round(strap.getBoundingClientRect().height * 10) / 10 : -1,
			strapScroll: strap ? strap.scrollHeight : -1,
			strapColumns: strap ? getComputedStyle(strap).gridTemplateColumns : '',
		};
	};
	const before = read('pinned-1-line');
	const template = row.querySelector('.extra-items-container.below').shadowRoot.querySelector('[part~="shelf-icon"]');
	const clones = [];
	for (let i = 0; i < 12 && template; i++) {
		const clone = template.cloneNode(true);
		template.parentNode.appendChild(clone);
		clones.push(clone);
	}
	const style = document.createElement('style');
	style.textContent = 'tab-item.tst-shelf-owner .extra-items-container.below { max-height: none !important; }'
		+ 'tab-item.tst-shelf-owner .extra-items-container.below::part(shelf-strap) { flex-wrap: wrap !important; overflow: visible !important; }';
	document.documentElement.appendChild(style);
	const after = read('released-wrap');
	for (const clone of clones) { clone.parentNode.removeChild(clone); }
	style.remove();
	return JSON.stringify({ before, after, });
`;

/** Calls tst-shelf's internal test API from the tab-hosted sidebar page.
 *  Cross-extension runtime messaging works from any extension page, so the
 *  driver can drive the addon without a second page. */
const shelfCallScript = String.raw`
	return (async () => {
		const response = await browser.runtime.sendMessage("tst-shelf@example.com", arguments[0]);
		return JSON.stringify(response);
	})();
`;

/** Frame sampler: records, once per animation frame, where a marker row
 *  sits and how many rows exist.  Starting it before a shelf-tab switch
 *  and reading it afterwards yields the tree's motion in pixels — the
 *  only honest way to tell "the tree stayed put" from "it jumped and
 *  came back".  `arguments[0]` = marker tab id, `arguments[1]` = frames. */
const sampleStartScript = String.raw`
	window.__shelfSamples = [];
	const marker = arguments[0];
	const frames = arguments[1] || 120;
	const t0 = performance.now();
	const tick = () => {
		const row = document.querySelector('tab-item[data-tab-id="' + marker + '"]');
		const container = document.querySelector("#normal-tabs-container");
		window.__shelfSamples.push({
			t: Math.round(performance.now() - t0),
			top: row ? Math.round(row.getBoundingClientRect().top) : -1,
			rows: container ? container.querySelectorAll("tab-item[data-tab-id]").length : -1,
			ids: container ? [...container.querySelectorAll("tab-item[data-tab-id]")].map(row => row.dataset.tabId).join(",") : "",
			height: container ? Math.round(container.scrollHeight) : -1,
		});
		if (window.__shelfSamples.length < frames)
			requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
	return "sampling";
`;

const sampleReadScript = String.raw`
	return JSON.stringify(window.__shelfSamples || []);
`;

/** The sidebar page URL of an installed extension, by addon id.  Works for
 *  temporary installs, whose UUID is never written to prefs.js. */
const sidebarUrlScript = String.raw`
	const id = arguments[0];
	const policy = WebExtensionPolicy.getByID(id);
	return policy ? policy.getURL("sidebar/sidebar.html") : null;
`;

/** Activates a tab the way a user click does.  Runs in the tab-hosted
 *  TST sidebar page: it is a WebExtension page (TST holds the `tabs`
 *  permission), so browser.tabs.update is available from content
 *  context — chrome-context XULTab.id is NOT the WebExtension id.
 *  Used for the path that left a dangling subtree in 0.1.6: switching to
 *  a tab that is NOT on a shelf, so no shelf-selection event happens. */
const activateScript = String.raw`
	const tabId = arguments[0];
	return (async () => {
		await browser.tabs.update(tabId, { active: true, });
		return "activated " + tabId;
	})();
`;

/** Which of the given tab ids currently have a rendered row. */
const rowPresenceScript = String.raw`
	const out = {};
	for (const id of arguments[0]) {
		out[id] = !!document.querySelector('tab-item[data-tab-id="' + id + '"]');
	}
	return JSON.stringify(out);
`;

/** Rows AND browser visibility for a set of tabs.  `hidden` is the other
 *  half of a reveal's claim: a suppressed row goes through
 *  browser.tabs.hide(), so a tab without a row must report `hidden`.
 *  (Async IIFE: Marionette runs the script as a *body*, so a top-level
 *  await is a syntax error.) */
const rowAndStateScript = String.raw`
	return (async () => {
		const ids = arguments[0];
		const out = {};
		for (const id of ids) {
			out[id] = !!document.querySelector('tab-item[data-tab-id="' + id + '"]');
		}
		const live = await Promise.all(ids.map(id => browser.tabs.get(id).catch(() => null)));
						return JSON.stringify({
			rows: out,
			hidden: Object.fromEntries(ids.map((id, index) => [id, !!(live[index] && live[index].hidden)])),
			active: Object.fromEntries(ids.map((id, index) => [id, !!(live[index] && live[index].active)])),
		});
	})();
`;

/** Model probe: dumps every tab's states from the TST background. */
const stateProbeScript = String.raw`
	return (async () => {
		const win = await browser.runtime.sendMessage({
			type: "treestyletab:ping-to-background",
			windowId: arguments[0],
		});
		const map = {};
		for (const tab of win.tabs) {
			map[tab.id] = (tab.$TST && tab.$TST.states) || [];
		}
		return JSON.stringify(map);
	})();
`;

/** Every assertion the driver makes, in one place: it prints, it records,
 *  and a failure sets the exit status.  Assertions used to be raw
 *  `console.log` calls, and two of them (the folded-owner check and the
 *  nested-member check) printed FAIL without touching `process.exitCode` —
 *  `make e2e` exited 0 while the log said FAIL.  A `detail` is evaluated
 *  only on failure so the happy path stays quiet. */
const results = [];
function check (name, ok, detail = null, scope = "driver") {
	const text = typeof detail == "function" ? (ok ? null : detail()) : detail;
	const entry = { name, ok: !!ok, detail: text == null || text === "" ? null : String(text), };
	results.push(entry);
	console.log(`${entry.ok ? "PASS" : "FAIL"} [${scope}] ${entry.name}${entry.detail ? " " + entry.detail : ""}`);
	if (!entry.ok) { process.exitCode = process.exitCode || 1; }
	return entry.ok;
}

function printReport (path, phase) {
	const report = JSON.parse(fs.readFileSync(path, "utf8"));
	for (const entry of report.results || []) {
		check(entry.name, entry.ok, entry.detail, phase);
	}
}

/**
 * Phase 2: open TST's own sidebar page in a tab and assert what the
 * shelf really paints there — strap ownership, row geometry, member
 * rows, the selection choreography, the reveal rules.  Extracted from
 * main() so each harness phase is a named routine; every assertion goes
 * through check(), the single oracle that also sets the exit status.
 */
async function runSidebarPhase (marionette, { windowId, expect, }) {
	if (windowId != null) {
		// A temporary install never reaches prefs.js, so ask the policy
		// registry for the sidebar URL and fall back to the sideloaded
		// UUID only if that fails.
		let baseUrl = null;
		for (let i = 0; i < 40 && !baseUrl; i++) {
			const url = await marionette.command("Marionette:SetContext", { value: "chrome", })
				.then(() => marionette.command("WebDriver:ExecuteScript", {
					script: sidebarUrlScript, args: ["treestyletab@piro.sakura.ne.jp",], newSandbox: false,
				}))
				.then(response => response && response.value, () => null);
			const uuid = readTstUuid(PREFS);
			baseUrl = url || (uuid ? `moz-extension://${uuid}/sidebar/sidebar.html` : null);
			if (!baseUrl) { await new Promise(resolve => setTimeout(resolve, 500)); }
		}
		await marionette.command("Marionette:SetContext", { value: "content", }).catch(() => {});
		check("TST sidebar URL resolvable", !!baseUrl);
		if (baseUrl) {
			const pageUrl = `${baseUrl}?windowId=${windowId}`;
			console.log(`[drive] phase 2: opening ${pageUrl}`);
			await marionette.command("Marionette:SetContext", { value: "content", });
			try {
				const win = await commandTry(marionette, "WebDriver:NewWindow", ["Marionette:NewWindow"], { type: "tab", });
				const handle = (win && (win.handle || (win.value && win.value.handle))) || null;
				if (handle) {
					await commandTry(marionette, "WebDriver:SwitchToWindow", ["Marionette:SwitchToWindow"], { handle, });
				}
				await commandTry(marionette, "WebDriver:Navigate", ["Marionette:GetURL"], { url: pageUrl, });
			// A tall window keeps every row inside TST's virtual-scroll
			// render range; a short headless viewport legitimately skips
			// off-screen rows (exists: false), which is TST working as
			// designed, not a shelf bug.
			await commandTry(marionette, "WebDriver:SetWindowRect", ["Marionette:SetWindowRect"], { width: 480, height: 900, }).catch(() => {});
			} catch (error) {
				console.log(`[drive] phase 2 navigation failed: ${error.message}`);
			}
			await new Promise(resolve => setTimeout(resolve, 6000));

			// poll until the straps rendered (the tabs-rendered restore path)
			let dump = null;
			for (let attempt = 0; attempt < 24; attempt++) {
				const response = await marionette.command("WebDriver:ExecuteScript", {
					script: sidebarScript, args: [null,], newSandbox: false,
				}).catch(error => { console.log(`[drive] sidebar dump failed: ${error.message}`); return null; });
				dump = response && response.value ? JSON.parse(response.value) : null;
				if (dump && dump.icons.length >= 2) { break; }
				await new Promise(resolve => setTimeout(resolve, 1000));
			}
			// decisive probe: push a state through TST's own bridge
			const probe = await marionette.command("WebDriver:ExecuteScript", {
				script: stateProbeScript, args: [windowId,], newSandbox: false,
			}).catch(error => { console.log(`[drive] state probe failed: ${error.message}`); return null; });
			console.log(`[drive] state probe: ${probe && probe.value}`);
			if (!dump || dump.icons.length < 2) {
				const diag = dump ?
					`href=${dump.href} ready=${dump.readyState} tabItems=${dump.allTabItems} rows=${dump.rowsWithTabId} normalChildren=${dump.normalChildren}` :
					"(no dump)";
				check("shelf icons render in the owner strap", false, diag);
			} else {
				console.log(`[drive] row classes: ${JSON.stringify((dump.rows || []).map(row => [row.id, row.classes]))}`);
				const e = expect.expect;
				const byId = Object.fromEntries(dump.icons.map(icon => [icon.id, icon]));

				check("owner row carries the tst-shelf-owner class", dump.rows.find(row => row.id == String(e.owner) && row.classes.includes("tst-shelf-owner")));

				// uniform-row law (0.1.4): the strap lives INSIDE the
				// owner's own row (beside the caption), so the owner row
				// keeps its DEFAULT height and every rendered row sits
				// exactly where TST's index arithmetic expects it (the
				// drop-zone guarantee: 0.1.1 grew owner rows and collapsed
				// member rows, shifting every computed rect below each
				// shelf, and drops there always landed as siblings).
				{
					const ownerRow = dump.rows.find(row => row.id == String(e.owner));
					const plainRow = dump.rows.find(row => row.id == String(e.plain));
					const sameHeight = ownerRow && plainRow && Math.abs(ownerRow.height - plainRow.height) < 2;
					check("the owner row keeps its normal height", sameHeight, () =>
						`owner=${ownerRow && ownerRow.height} plain=${plainRow && plainRow.height}`);
				}
				{
					const ownerRow = dump.rows.find(row => row.id == String(e.owner));
					check("the strap renders inside the owner's own row", ownerRow && ownerRow.strap && ownerRow.classes.includes("tst-shelf-owner"), () => `the strap renders inside the owner's own row (${JSON.stringify(ownerRow)})`);
				}
				// no member rows at all: a hidden tab has no row, so the
				// shelf costs exactly one line (0.1.3's blank member boxes
				// were the "vertical gaps").  The invariant is about the
				// SETTLED sidebar — the addon re-applies addon states when a
				// sidebar appears (TST's initial import carries only its own
				// safe states), and that pass is debounced — so poll instead
				// of reading the very first frame that has icons.
				{
					let memberRows = [];
					for (let attempt = 0; attempt < 6; attempt++) {
						const fresh = await marionette.command("WebDriver:ExecuteScript", {
							script: sidebarScript, args: [null,], newSandbox: false,
						}).catch(() => null);
						const again = fresh && fresh.value ? JSON.parse(fresh.value) : null;
						if (!again) { break; }
						memberRows = e.members.filter(id => again.rows.some(row => row.id == String(id)));
						if (memberRows.length == 0) { break; }
						await new Promise(resolve => setTimeout(resolve, 500));
					}
					let detail = () => `rows=${JSON.stringify(memberRows)}`;
					if (memberRows.length != 0) {
						const diag = await marionette.command("WebDriver:ExecuteScript", {
							script: shelfCallScript, args: [{ type: "test:state", },], newSandbox: false,
						}).catch(() => null);
						const diagState = diag && diag.value ? JSON.parse(diag.value) : null;
						detail = () => JSON.stringify({
							rows: memberRows,
							hiddenByUs: diagState && diagState.hiddenByUs,
						});
					}
					check("members keep no rows — a shelf costs one line", memberRows.length == 0, detail);
				}
				// the owner's row: title on the left, shelf on the right,
				// capped at 2/3 of the width, one line, horizontally
				// scrollable when the icons do not fit, and the row still
				// does not grow.
				{
					const geometry = await marionette.command("WebDriver:ExecuteScript", {
						script: strapGeometryScript, args: [e.owner, e.plain,], newSandbox: false,
					}).catch(error => { console.log(`[drive] strap geometry probe failed: ${error.message}`); return null; });
					const g = geometry && geometry.value ? JSON.parse(geometry.value) : null;
					// the shelf exactly as it is: as wide as its icons need, or
					// exactly as wide as the 2/3 cap allows — never narrower
					// (0.1.4 squeezed it to a scrolling sliver beside a long
					// title), and never scrolling while the icons fit (the old
					// oracle ignored `naturalScrolls` and printed PASS next to
					// scrolls=true).
					const unit = g && g.expectedIconSize > 0 ? g.expectedIconSize : g && g.iconWidth;
					const content = g ? g.naturalIcons * (unit + g.gap) - g.gap : 0;
					const cap = g ? 0.66 * g.uiWidth : 0;
					const overflows = content > cap + 2;
					const fits = g && unit > 0 && g.naturalIcons > 0
						&& g.iconWidth >= unit - 1
						&& g.naturalWidth >= Math.min(content, cap) - 2
						&& !(g.naturalScrolls && !overflows);
					const geometryDetail = () => JSON.stringify(g);
					check(`the natural shelf is as wide as its icons and does not scroll while they fit (icons=${g && g.naturalIcons} iconW=${g && g.iconWidth && g.iconWidth.toFixed(1)} unit=${g && g.expectedIconSize} shelfW=${g && g.naturalWidth && g.naturalWidth.toFixed(1)} cap=${cap.toFixed(1)} scrolls=${g && g.naturalScrolls})`, fits, geometryDetail);
					const capped = g && g.ratio > 0 && g.ratio <= 0.68;
					const scrolls = g && g.overflowX == "auto" && g.scrolls;
					const truncated = g && g.inflatedLabelTruncated;
					const noGrowth = g && Math.abs(g.rowHeight - g.plainHeight) < 2;
					const cleaned = g && g.cleaned >= 2;
					check(`the shelf never exceeds 2/3 of the owner row (ratio=${g && g.ratio.toFixed(2)})`, capped, geometryDetail);
					check(`a shelf that does not fit scrolls horizontally (overflowX=${g && g.overflowX} scrolls=${g && g.scrolls})`, scrolls, geometryDetail);
					check(`the owner title truncates to make room (label truncated=${g && g.inflatedLabelTruncated})`, truncated, geometryDetail);
					check(`a full shelf still does not grow the owner row (row=${g && g.rowHeight} plain=${g && g.plainHeight})`, noGrowth, geometryDetail);
					check("the geometry probe cleaned up its cloned icons", cleaned, geometryDetail);
				}
				{
					const probe = await marionette.command("WebDriver:ExecuteScript", {
						script: lineProbeScript, args: [e.owner,], newSandbox: false,
					}).catch(error => { console.log(`[drive] line probe failed: ${error.message}`); return null; });
					console.log(`[drive] line probe: ${probe && probe.value}`);
				}
				{
					const conformance = await marionette.command("WebDriver:ExecuteScript", {
						script: conformanceScript, args: [e.plain,], newSandbox: false,
					}).catch(error => { console.log(`[drive] conformance probe failed: ${error.message}`); return null; });
					const c = conformance && conformance.value ? JSON.parse(conformance.value) : null;
					// `anchor` (first row minus the content origin) is part of the
					// contract and was previously computed and then ignored:
					// TST's computed positions are absolute, so a shifted first
					// row shifts every drop zone below it.
					check(`every rendered row sits at TST's computed position — drop zones exact (rows=${c && c.rows} rowH=${c && c.rowH && c.rowH.toFixed(1)} anchor=${c && c.anchor && c.anchor.toFixed(1)})`,
						c && c.rows >= 2 && c.drift.length == 0 && c.rowH > 20 && c.anchor <= 1.5,
						() => JSON.stringify(c));
				}

				// bug 3: the re-put member (B, the newest put) is the
				// RIGHTMOST icon; C kept its earlier block slot.
				{
					const order = (dump.icons || []).map(icon => icon.id);
					const expected = [String(e.members[1]), String(e.members[0]), String(e.f)];
					check(`the newest member is the rightmost icon (${order.join(",")})`,
						JSON.stringify(order) == JSON.stringify(expected),
						() => `expected ${expected.join(",")}`);
				}

				check("both members are icons on the owner strap", byId[String(e.members[0])] && byId[String(e.members[1])], () => `both members are icons on the owner strap ${JSON.stringify(dump.icons)}`);

				const iconB = byId[String(e.members[0])];
				const iconC = byId[String(e.members[1])];
				check("icons carry title tooltips", iconB && iconB.title == "shelf tree tab", () => `icons carry title tooltips ${iconB && iconB.title}`);

				check("the folded member carries the plus badge", iconC && iconC.badge, () => `the folded member carries the plus badge ${JSON.stringify(iconC)}`);

				check("icons are native drag sources", iconB && iconB.draggable == "true", () => `icons are native drag sources ${iconB && iconB.draggable}`);

				check("favicons ride the style attribute through the sanitizer", iconB && iconB.hasBg, () => `favicons ride the style attribute through the sanitizer ${iconB && JSON.stringify(iconB)}`);

				check("the root shelf strap holds the shelved root tab", (dump.rootIcons || []).some(icon => icon.id == String(e.rootMember)), () => `the root shelf strap holds the shelved root tab ${JSON.stringify(dump.rootIcons)}`);

				// interaction: click C (unfold+activate), then B (one per shelf)
				console.log("[drive] phase 2: clicking the C icon");
				await marionette.command("WebDriver:ExecuteScript", {
					script: sidebarScript, args: [e.clickFirst,], newSandbox: false,
				}).catch(error => console.log(`[drive] click-1 failed: ${error.message}`));
				await new Promise(resolve => setTimeout(resolve, 4000));

				let visibleInfo = null;
				for (let i = 0; i < 10 && !(visibleInfo && visibleInfo.c1.height > 0 && visibleInfo.c2.height > 0); i++) {
					const afterFirst = await marionette.command("WebDriver:ExecuteScript", {
						script: visibilityScript,
						args: [e.children[0], e.children[1], e.plain, e.owner,], newSandbox: false,
					}).catch(error => { console.log(`[drive] visibility probe failed: ${error.message}`); return null; });
					visibleInfo = afterFirst && afterFirst.value ? JSON.parse(afterFirst.value) : null;
					if (visibleInfo && visibleInfo.c1.height > 0 && visibleInfo.c2.height > 0) { break; }
					await new Promise(resolve => setTimeout(resolve, 1000));
				}
				check("the selected shelved tab's children render below the shelf", visibleInfo && visibleInfo.c1.height > 0 && visibleInfo.c2.height > 0, () => `the selected shelved tab's children render below the shelf ${JSON.stringify(visibleInfo)}`);

				// bug 2 (0.1.4): the children dangle from the SHELF — the
				// shelf is a single line inside the owner's row, so the
				// children sit directly below that row and above the plain
				// sibling that follows the member block, not below it.
				// Rows must EXIST (a missing row would make the top
				// comparison vacuously true).
				check("the selected member's subtree dangles from the shelf, above the following siblings",
					visibleInfo && visibleInfo.c1.exists && visibleInfo.c1.height > 0
						&& visibleInfo.c2.exists && visibleInfo.c2.height > 0
						&& visibleInfo.plain && visibleInfo.plain.height > 0
						&& visibleInfo.c1.top < visibleInfo.plain.top && visibleInfo.c2.top < visibleInfo.plain.top,
					() => JSON.stringify(visibleInfo && { c1: visibleInfo.c1, c2: visibleInfo.c2, plain: visibleInfo.plain && visibleInfo.plain.top }));
				check("the selected member's children render directly below the owner row",
					visibleInfo && visibleInfo.owner && visibleInfo.owner.height > 0
						&& visibleInfo.c1.top >= visibleInfo.owner.top + visibleInfo.owner.height - 1,
					() => JSON.stringify(visibleInfo && { owner: visibleInfo.owner.top + visibleInfo.owner.height, c1: visibleInfo.c1.top }));

				const readSamples = async label => {
					const read = await marionette.command("WebDriver:ExecuteScript", {
						script: sampleReadScript, args: [], newSandbox: false,
					}).catch(error => { console.log(`[drive] sampler read failed: ${error.message}`); return null; });
					const samples = read && read.value ? JSON.parse(read.value) : [];
					const tops = samples.filter(sample => sample.top >= 0).map(sample => sample.top);
					console.log(`[drive] ${label} trail: tops=${JSON.stringify([...new Set(tops)])} frames=${samples.length}`);
					return samples;
				};

				// -- 0.1.7: an UNSHELVED sibling takes the row AND the subtree
				// C is active and unfolded (c1/c2 are rows).  D is a plain
				// sibling, not on the shelf, so NO shelf-selection event
				// happens: the member's row is reclaimed by the activation
				// path alone.  0.1.6 reclaimed the row and left the children
				// painted under a parent row that no longer existed
				// (user-reported).  The subtree must fold FIRST, so that no
				// frame ever shows a child without its parent.
				const diagC = await marionette.command("WebDriver:ExecuteScript", {
					script: shelfCallScript, args: [{ type: "test:state", },], newSandbox: false,
				}).catch(() => null);
				const diagCState = diagC && diagC.value ? JSON.parse(diagC.value) : null;
				// the member's row must be back BEFORE the next activation
				// (0.2.2: it is restored at activation time, not by the
				// debounced re-derivation) — diagnostic on failure only
				const memberRowBack = await marionette.command("WebDriver:ExecuteScript", {
					script: rowPresenceScript, args: [[e.clickFirst,],], newSandbox: false,
				}).catch(() => null);
				const memberRowState = memberRowBack && memberRowBack.value ? JSON.parse(memberRowBack.value) : null;
				check("the activated member's row is back before the next activation",
					!!(memberRowState && memberRowState[e.clickFirst]),
					() => JSON.stringify({ row: memberRowState, hiddenByUs: diagCState && diagCState.hiddenByUs, diag: diagCState && diagCState.diagLog, }));
				console.log("[drive] phase 2: sampling while the plain sibling D is activated");
				await marionette.command("WebDriver:ExecuteScript", {
					script: sampleStartScript, args: [e.plain, 150,], newSandbox: false,
				}).catch(error => console.log(`[drive] sampler start failed: ${error.message}`));
				await new Promise(resolve => setTimeout(resolve, 120));
				const activated = await marionette.command("WebDriver:ExecuteScript", {
					script: activateScript, args: [e.plain,], newSandbox: false,
				}).catch(error => { console.log(`[drive] activation failed: ${error.message}`); return null; });
				console.log(`[drive] activate D: ${JSON.stringify(activated && activated.value)}`);
				await new Promise(resolve => setTimeout(resolve, 3000));
				{
					const samples = await readSamples("plain sibling");
					const parents = { [e.children[0]]: e.clickFirst, [e.children[1]]: e.clickFirst, };
					const orphans = samples.filter(sample => {
						const ids = String(sample.ids || "").split(",").filter(Boolean);
						return Object.keys(parents).some(child => ids.includes(String(child)) && !ids.includes(String(parents[child])));
					});
					const startIds = String((samples[0] || {}).ids || "").split(",").filter(Boolean);
					const startedWithMember = startIds.includes(String(e.clickFirst));
					check("sampling starts with the member's row on screen", startedWithMember,
						() => `start=${JSON.stringify(startIds)}`);
					check("an unshelved sibling reclaims the member's row without orphaning its subtree", samples.length >= 30 && orphans.length == 0 && startedWithMember, () => `an unshelved sibling reclaims the member's row without orphaning its subtree (${orphans.length} orphan frames of ${samples.length}: ${JSON.stringify(orphans.slice(0, 3))})`);
					const presence = await marionette.command("WebDriver:ExecuteScript", {
						script: rowPresenceScript,
						args: [[e.clickFirst, e.children[0], e.children[1], e.plain,],],
						newSandbox: false,
					}).catch(() => null);
					const rows = presence && presence.value ? JSON.parse(presence.value) : null;
					const gone = rows && !rows[e.clickFirst] && !rows[e.children[0]] && !rows[e.children[1]];
					const siblingShown = rows && rows[e.plain];
					check(`the member's row and its whole subtree are gone after the switch (${JSON.stringify(rows)})`,
						gone && siblingShown);
				}

				// -- switching between shelf tabs must not move the tree
				// C is active and unfolded (its two children are rows);
				// the plain sibling D is the marker below the shelf.
				// Two distinct requirements, measured separately:
				//  (1) a parent's row must never disappear while its
				//      children are still painted — TST animates a
				//      collapse for 150 ms before it removes the rows,
				//      so reclaiming the parent's row mid-way orphans
				//      them (0.1.4 did exactly that);
				//  (2) switching between two CHILDLESS members is a pure
				//      row swap: the tree must not move at all.
				console.log("[drive] phase 2: clicking the B icon (switch sampling)");
				await marionette.command("WebDriver:ExecuteScript", {
					script: sampleStartScript, args: [e.plain, 150,], newSandbox: false,
				}).catch(error => console.log(`[drive] sampler start failed: ${error.message}`));
				await new Promise(resolve => setTimeout(resolve, 120));
				await marionette.command("WebDriver:ExecuteScript", {
					script: sidebarScript, args: [e.clickSecond,], newSandbox: false,
				}).catch(error => console.log(`[drive] click-2 failed: ${error.message}`));
				await new Promise(resolve => setTimeout(resolve, 2600));
				{
					const samples = await readSamples("switch");
					// (1) orphan check: no frame where a child's row exists
					// but its parent's row is gone
					const parentOf = { [e.children[0]]: e.clickFirst, [e.children[1]]: e.clickFirst, };
					const orphans = samples.filter(sample => {
						const ids = String(sample.ids || "").split(",").filter(Boolean);
						return Object.keys(parentOf).some(child => ids.includes(String(child)) && !ids.includes(String(parentOf[child])));
					});
					check("a parent's row never disappears while its children are still painted", samples.length >= 30 && orphans.length == 0, () => `a parent's row never disappears while its children are still painted (${orphans.length} frames of ${samples.length}: ${JSON.stringify(orphans.slice(0, 3))})`);
				}

				// (2) childless to childless: a pure row swap, no motion
				console.log("[drive] phase 2: waiting for the childless member F's icon");
				let sawF = false;
				for (let attempt = 0; attempt < 20 && !sawF; attempt++) {
					const response = await marionette.command("WebDriver:ExecuteScript", {
						script: sidebarScript, args: [null,], newSandbox: false,
					}).catch(() => null);
					const dump2 = response && response.value ? JSON.parse(response.value) : null;
					sawF = !!dump2 && (dump2.icons || []).some(icon => icon.id == String(e.f));
					if (!sawF) { await new Promise(resolve => setTimeout(resolve, 500)); }
				}
				check("the childless member's icon appears (pure-swap switch)", sawF);
				if (sawF) {
					await marionette.command("WebDriver:ExecuteScript", {
						script: sidebarScript, args: [e.f,], newSandbox: false,
					}).catch(error => console.log(`[drive] click-F failed: ${error.message}`));
					await new Promise(resolve => setTimeout(resolve, 1500));
					console.log("[drive] phase 2: clicking the B icon (pure swap sampling)");
					await marionette.command("WebDriver:ExecuteScript", {
						script: sampleStartScript, args: [e.plain, 150,], newSandbox: false,
					}).catch(error => console.log(`[drive] sampler start failed: ${error.message}`));
					await new Promise(resolve => setTimeout(resolve, 120));
					await marionette.command("WebDriver:ExecuteScript", {
						script: sidebarScript, args: [e.clickSecond,], newSandbox: false,
					}).catch(error => console.log(`[drive] click-2 failed: ${error.message}`));
					await new Promise(resolve => setTimeout(resolve, 2600));
					const samples = await readSamples("pure swap");
					const seenSwap = [];
					for (const sample of samples) {
						const key = `${sample.rows}|${sample.ids}`;
						if (!seenSwap.length || seenSwap[seenSwap.length - 1].key != key) { seenSwap.push({ key, t: sample.t, top: sample.top, }); }
					}
					console.log(`[drive] pure swap row sets: ${JSON.stringify(seenSwap.map(entry => [entry.t, entry.top, entry.key]))}`);
					// the swap cannot be atomic: the incoming member is revealed by
					// the activation and the outgoing one is hidden by us, two IPC
					// messages that TST's sidebar paints in separate frames.  The
					// measurable goal is therefore "one frame, not a visible jump":
					// the tree returns to its exact position and is never displaced
					// for more than a single sampled frame.
					const tops = samples.filter(sample => sample.top >= 0).map(sample => sample.top);
					const restingTop = tops.length ? tops[tops.length - 1] : null;
					const displaced = samples.filter(sample => sample.top >= 0 && restingTop != null && Math.abs(sample.top - tops[0]) > 2);
					const frameBudget = 2;
					check(`switching between childless shelf tabs displaces the tree for at most ${displaced.length} frame(s) and returns it (${displaced.length * 17}ms)`,
						samples.length >= 30 && displaced.length <= frameBudget && restingTop != null && Math.abs(restingTop - tops[0]) <= 2,
						() => `${displaced.length} frames of ${samples.length}, trail ${JSON.stringify([...new Set(tops)])}`);

				}

				// -- a shelf of shelves: the owner must not vanish while a
				// tab of ITS shelf is active.  Activate C (a member of A's
				// shelf that owns a nested shelf), click c1 on that nested
				// shelf, and check that C keeps its row — with it, the
				// nested strap stays on screen.
				console.log("[drive] phase 2: nested shelf check");
				await marionette.command("WebDriver:ExecuteScript", {
					script: sidebarScript, args: [e.clickFirst,], newSandbox: false,
				}).catch(error => console.log(`[drive] nested owner click failed: ${error.message}`));
				await new Promise(resolve => setTimeout(resolve, 2000));
				let nestedDump = null;
				for (let attempt = 0; attempt < 20; attempt++) {
					const response = await marionette.command("WebDriver:ExecuteScript", {
						script: sidebarScript, args: [null,], newSandbox: false,
					}).catch(() => null);
					nestedDump = response && response.value ? JSON.parse(response.value) : null;
					const row = nestedDump && nestedDump.rows.find(candidate => candidate.id == String(e.nestedOwner));
					if (row && row.strap) { break; }
					await new Promise(resolve => setTimeout(resolve, 500));
				}
				{
					const row = nestedDump && nestedDump.rows.find(candidate => candidate.id == String(e.nestedOwner));
					const icon = nestedDump && (nestedDump.icons || []).find(candidate => candidate.id == String(e.nestedMember));
					check("a shelved tab that owns a shelf shows that shelf in its own row", row && row.strap && icon, () => `a shelved tab that owns a shelf shows that shelf in its own row (owner=${JSON.stringify(row)} member=${JSON.stringify(icon)})`);
				}
				await marionette.command("WebDriver:ExecuteScript", {
					script: sidebarScript, args: [e.nestedMember,], newSandbox: false,
				}).catch(error => console.log(`[drive] nested member click failed: ${error.message}`));
				await new Promise(resolve => setTimeout(resolve, 2500));
				{
					const response = await marionette.command("WebDriver:ExecuteScript", {
						script: sidebarScript, args: [null,], newSandbox: false,
					}).catch(() => null);
					const dump3 = response && response.value ? JSON.parse(response.value) : null;
					const row = dump3 && dump3.rows.find(candidate => candidate.id == String(e.nestedOwner));
					const activeRow = dump3 && dump3.rows.find(candidate => candidate.id == String(e.nestedMember));
					// 0.1.5 hid the owner here and the nested shelf vanished
					// with it; the owner must keep its row instead
					check("activating a tab of a nested shelf keeps that shelf's owner visible", row && row.strap, () => `activating a tab of a nested shelf keeps that shelf's owner visible (owner=${JSON.stringify(row)})`);
					// A member is a hidden tab, and Firefox reveals a hidden tab
					// the moment it becomes active: the activated nested member
					// does get a row, and its own shelf (if any) hangs from it.
					check(`the activated nested member has a row (hasRow=${!!activeRow})`, !!activeRow);
				}
				// leave C folded again: phase 3 asserts that TST's native
				// fold state survives the reinstall
				await marionette.command("WebDriver:ExecuteScript", {
					script: sidebarScript, args: [e.clickSecond,], newSandbox: false,
				}).catch(error => console.log(`[drive] refold click failed: ${error.message}`));
				await new Promise(resolve => setTimeout(resolve, 1500));

				// -- reveal: from a FOLDED owner's shelf, only the activated
				// tab's branch may appear (0.2.1).  Before this, TST expanded
				// the tab AND ALL ITS ANCESTORS (handle-tab-focus.js), so the
				// owner's whole subtree — the unshelved sibling D included —
				// popped into view.  The other descendants' rows go through
				// browser.tabs.hide().
				{
					const call = async message => {
						const response = await marionette.command("WebDriver:ExecuteScript", {
							script: shelfCallScript, args: [message,], newSandbox: false,
						}).catch(error => { console.log(`[drive] shelf call failed: ${error.message}`); return null; });
						return response && response.value ? JSON.parse(response.value) : null;
					};
					const presence = async ids => {
						const response = await marionette.command("WebDriver:ExecuteScript", {
							script: rowPresenceScript, args: [ids,], newSandbox: false,
						}).catch(() => null);
						return response && response.value ? JSON.parse(response.value) : {};
					};
					await call({ type: "test:collapse", tabId: e.owner, windowId, collapsed: true, });
					await new Promise(resolve => setTimeout(resolve, 2000));
					const folded = await presence([e.owner, e.clickFirst, e.children[0], e.children[1], e.plain]);
					console.log(`[drive] rows while the owner is folded: ${JSON.stringify(folded)}`);
					check(`a folded owner renders no rows for its subtree`, folded[e.clickFirst] === false && folded[e.plain] === false);
					// click C's icon: C's branch comes back, D must not
					await marionette.command("WebDriver:ExecuteScript", {
						script: sidebarScript, args: [e.clickFirst,], newSandbox: false,
					}).catch(error => console.log(`[drive] reveal click failed: ${error.message}`));
					await new Promise(resolve => setTimeout(resolve, 2500));
					const revealed = await presence([e.owner, e.clickFirst, e.children[0], e.children[1], e.plain, e.clickSecond, e.f]);
					console.log(`[drive] rows after the reveal: ${JSON.stringify(revealed)}`);
					// c1 is a member of C's OWN shelf, so it stays row-less (hidden);
					// the branch that must appear is the owner, C and c2.
					const branchOk = revealed[e.owner] && revealed[e.clickFirst] && revealed[e.children[1]];
					check(`the activated shelf tab's branch has rows (owner, member, its plain child)`, branchOk);
					check(`a nested member of the branch stays row-less (c1)`, revealed[e.children[0]] === false);
					check(`the unshelved sibling keeps NO row under a reveal`, revealed[e.plain] === false);
					const state = await call({ type: "test:state", });
					const revealState = (state && state.reveals && state.reveals[windowId]) || [];
					const suppressedHidden = (state && state.suppressedHiddenByUs) || [];
					console.log(`[driver] reveal state: ${JSON.stringify({ reveal: revealState, suppressedHidden, debug: state && state.revealDebug, })}`);
					const revealOk = revealState.some(([owner]) => owner == e.owner) && suppressedHidden.includes(e.plain);
					check(`the addon keeps the owner expanded and accounts for the suppressed sibling (hidden)`, revealOk);
					const hiddenSibling = (state && state.hiddenByUs) || [];
					check(`a suppressed tab is never counted as a member hide`, !(hiddenSibling.includes(e.plain)));
					const live = await marionette.command("WebDriver:ExecuteScript", {
						script: rowAndStateScript, args: [[e.plain,],], newSandbox: false,
					}).catch(() => null);
					const liveState = live && live.value ? JSON.parse(live.value) : null;
					const hiddenFlag = !!(liveState && liveState.hidden[e.plain]);
					check(`the suppressed sibling is hidden (the stock lever)`, hiddenFlag === true);
					// nested shelf: c1 is a member of C's OWN shelf, whose strap
					// lives in C's row.  Clicking c1 must keep C's row — the
					// branch is anchored on the owner's DIRECT child, so the
					// whole nested shelf stays visible.
					await marionette.command("WebDriver:ExecuteScript", {
						script: sidebarScript, args: [e.nestedMember,], newSandbox: false,
					}).catch(error => console.log(`[drive] nested reveal click failed: ${error.message}`));
					await new Promise(resolve => setTimeout(resolve, 2500));
					const nested = await presence([e.clickFirst, e.nestedMember, e.plain]);
					console.log(`[driver] rows after the nested click: ${JSON.stringify(nested)}`);
					const nestedOk = nested[e.clickFirst] === true && nested[e.plain] === false;
					check(`clicking a nested shelf member keeps the nested owner's row (its strap host)`, nestedOk);
					// leaving the owner's subtree ends the reveal and folds it back
					await marionette.command("WebDriver:ExecuteScript", {
						script: activateScript, args: [e.rootMember,], newSandbox: false,
					}).catch(error => console.log(`[drive] root activation failed: ${error.message}`));
					await new Promise(resolve => setTimeout(resolve, 2500));
					const afterState = await call({ type: "test:state", });
					const revealAfter = (afterState && afterState.reveals && afterState.reveals[windowId]) || [];
					const suppressedHiddenAfter = (afterState && afterState.suppressedHiddenByUs) || [];
					const backRows = await presence([e.owner, e.clickFirst, e.plain]);
					const backLive = await marionette.command("WebDriver:ExecuteScript", {
						script: rowAndStateScript, args: [[e.plain,],], newSandbox: false,
					}).catch(() => null);
					const backState = backLive && backLive.value ? JSON.parse(backLive.value) : null;
					console.log(`[driver] after leaving: ${JSON.stringify({ revealAfter, suppressedHiddenAfter, backRows, backState, })}`);
					const ended = revealAfter.length == 0 &&
						suppressedHiddenAfter.length == 0 &&
						backRows[e.clickFirst] === false;
					check(`leaving the owner's subtree ends the reveal and the owner folds back`, ended);
					// the suppressed sibling must come back to the browser too
					const siblingBack = !(backState && backState.hidden[e.plain]);
					check(`ending the reveal restores the suppressed sibling's visibility`, siblingBack);
				}
			}
		}
	}
}

async function main () {
	prepareProfile();
	fs.rmSync(CONSOLE_LOG, { force: true, });
	fs.rmSync(CONSOLE_LOG.replace(/\.log$/, ".lock"), { force: true, });
	fs.rmSync(SETUP_REPORT, { force: true, });
	fs.rmSync(FINAL_REPORT, { force: true, });

	const args = HEADED
		? ["-no-remote", "-marionette", "-remote-allow-system-access", "-profile", SCRATCH,]
		: ["-no-remote", "-headless", "-marionette", "-remote-allow-system-access", "-profile", SCRATCH,];
	console.log(`[drive] ${FIREFOX_BIN} ${args.join(" ")}`);
	const firefox = spawn(FIREFOX_BIN, args,
		{ stdio: ["ignore", fs.openSync(FIREFOX_LOG, "w"), fs.openSync(FIREFOX_LOG, "a"),], });

	try {
		await waitForPort(60_000);
		console.log("[drive] marionette port is up");
		const marionette = new Marionette;
		const handshake = await marionette.connect(PORT);
		console.log(`[drive] handshake protocol=${handshake.marionetteProtocol} app=${handshake.applicationType}`);
		let session;
		try { session = await marionette.command("newSession", { capabilities: { alwaysMatch: { }, }, }); }
		catch { session = await marionette.command("WebDriver:NewSession", { capabilities: { alwaysMatch: { }, }, }); }
		console.log(`[drive] session ${(session?.sessionId || "?").slice(0, 12)}`);
		await marionette.command("Marionette:SetContext", { value: "chrome", });

		// Mirror ALL browser console output to tests/e2e-console.log
		// (extension console never reaches stderr; only uncaught errors do).
		const mirror = await marionette.command("WebDriver:ExecuteScript", {
			script: mirrorScript,
			args: [CONSOLE_LOG, CONSOLE_LOG.replace(/\.log$/, ".lock"),],
		});
		console.log(`[drive] console mirror: ${JSON.stringify(mirror?.value ?? mirror)}`);

		const install = await marionette.command("Addon:Install", {
			path: DIST, temporary: true, allowPrivateBrowsing: false,
		});
		console.log(`[drive] temporary install: ${JSON.stringify(install?.value ?? install)}`);

		// -- phase 1: extension alive, tree built, puts landed ------------
		const expect = await waitForReport(SETUP_REPORT, TIMEOUT_S * 1000);
		if (!expect) {
			console.log(`[drive] TIMEOUT: no setup report after ${TIMEOUT_S}s`);
			process.exitCode = 2;
		}
		const windowId = expect && expect.windowId;
		if (expect) {
			for (const entry of expect.results || []) {
				check(entry.name, entry.ok, entry.detail, "setup");
			}
		}

		// -- phase 2: sidebar DOM assertions + synthetic clicks ------------
		await runSidebarPhase(marionette, { windowId, expect, });


		// -- final report of phase 1+2 -------------------------------------
		const finalReport = await waitForReport(FINAL_REPORT, 90_000);
		if (!finalReport) {
			console.log("[drive] TIMEOUT: no final report");
			process.exitCode = process.exitCode || 2;
		} else {
			printReport(FINAL_REPORT, "phase 1+2");
		}

		// -- phase 3: reinstall = restart-persistence proxy -----------------
		const reinstallAt = Date.now();
		fs.rmSync(FINAL_REPORT, { force: true, });
		const reinstall = await marionette.command("Addon:Install", { path: DIST, temporary: true, });
		console.log(`[drive] reinstall: ${JSON.stringify(reinstall?.value ?? reinstall)}`);
		const phase3Report = await waitForReport(FINAL_REPORT, 90_000, reinstallAt - Date.now());
		if (!phase3Report) {
			check("reinstalled smoke page reports again (persistence path)", false, "no report after the reinstall");
		} else {
			printReport(FINAL_REPORT, "phase 3 (reinstall)");
		}

		marionette.destroy();
	} finally {
		if (firefox.exitCode === null) { firefox.kill("SIGTERM"); }
		await new Promise(resolve => setTimeout(resolve, 800));
		if (firefox.exitCode === null) { firefox.kill("SIGKILL"); }
		if (!KEEP) { fs.rmSync(SCRATCH, { recursive: true, force: true, }); }
		if (KEEP) { console.log(`[drive] profile kept at ${SCRATCH}`); }
	}

	if (fs.existsSync(CONSOLE_LOG)) {
		const lines = fs.readFileSync(CONSOLE_LOG, "utf8").split("\n");
		console.log(`[drive] ---------- firefox console tail (${lines.length} lines; full: tests/e2e-console.log) ----------`);
		console.log(lines.slice(-80).join("\n"));
	}
	console.log("[drive] driver done");
}

await main().catch(error => { die(error); });
