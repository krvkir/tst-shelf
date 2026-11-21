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
 * Usage: node tests/e2e-drive.mjs [--port 2829] [--timeout 150] [--keep]
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
const DIST = path.join(REPO, "dist");

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
/** Path to a PATCHED Tree Style Tab xpi (tests/patch-tst.sh).  When set,
 *  the fixture's sideloaded release build is removed and this one is
 *  temporary-installed first — that is how the A3/B upstream patch is
 *  exercised (discrete row heights, row-less tabs). */
const TST_PATCH = flag("--tst", null) && path.resolve(flag("--tst", null));

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
	if (TST_PATCH) {
		// the patched build replaces the sideloaded one: same addon id, and
		// a temporary install of it must not collide with a signed copy
		const sideloaded = path.join(SCRATCH, "extensions", "treestyletab@piro.sakura.ne.jp.xpi");
		fs.rmSync(sideloaded, { force: true, });
		console.log(`[drive] patched TST mode: removed sideloaded release build`);
	}
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

/** Row metrics of one tab plus TST's computed scroll extent.  The extent is
 *  the virtual-scroll container's min-height, i.e. exactly
 *  `totalRenderableItemsSize` from sidebar/scroll.js — the expression the
 *  A3 patch generalizes.  It is only set when the tab bar overflows, so the
 *  driver shrinks the window first. */
const extentScript = String.raw`
	const ownerId = arguments[0];
	const plainId = arguments[1];
	const container = document.querySelector('#normal-tabs-container');
	const scroller = container.querySelector('.virtual-scroll-container');
	const rect = id => {
		const row = document.querySelector('tab-item[data-tab-id="' + id + '"]');
		return row ? Math.round(row.getBoundingClientRect().height * 10) / 10 : -1;
	};
	const top = id => {
		const row = document.querySelector('tab-item[data-tab-id="' + id + '"]');
		return row ? Math.round(row.getBoundingClientRect().top) : -1;
	};
	const rowList = [...container.querySelectorAll('tab-item[data-tab-id]')].map(row => ({
		id: row.dataset.tabId,
		top: Math.round(row.getBoundingClientRect().top),
		height: Math.round(row.getBoundingClientRect().height),
	}));
	const lastTop = rowList.length ? rowList[rowList.length - 1].top : -1;
	const below = document.querySelector('tab-item[data-tab-id="' + ownerId + '"] .extra-items-container.below');
	const root = below && below.shadowRoot;
	const strap = root && root.querySelector('[part~="shelf-strap"]');
	return JSON.stringify({
		minHeight: Math.round((parseFloat(getComputedStyle(scroller).minHeight) || 0) * 10) / 10,
		ownerHeight: rect(ownerId),
		rowList, lastTop,
		ownerStyleVar: (document.querySelector('tab-item[data-tab-id="' + ownerId + '"]').style.getPropertyValue('--tab-lines') || '(unset)'),
		ownerComputedHeight: getComputedStyle(document.querySelector('tab-item[data-tab-id="' + ownerId + '"]')).height,
		tabSize: getComputedStyle(document.querySelector('tab-item[data-tab-id="' + ownerId + '"]')).getPropertyValue('--tab-size'),
		ownerClasses: [...document.querySelector('tab-item[data-tab-id="' + ownerId + '"]').classList].join(','),
		plainHeight: rect(plainId),
		plainTop: top(plainId),
		strapHeight: strap ? Math.round(strap.getBoundingClientRect().height) : -1,
		rows: container.querySelectorAll('tab-item[data-tab-id]').length,
		ids: [...container.querySelectorAll('tab-item[data-tab-id]')].map(row => row.dataset.tabId).join(","),
		viewport: Math.round(innerWidth) + 'x' + Math.round(innerHeight),
		scrollTopMax: Math.round((container.scrollTopMax || 0) * 10) / 10,
	});
`;

/** Crowded-shelf probe: the strap's icons against its own box, plus the row
 *  height.  "All icons visible, no horizontal scroll" is the requirement for
 *  the extend layout. */
const shelfFitScript = String.raw`
	const owner = arguments[0];
	const row = document.querySelector('tab-item[data-tab-id="' + owner + '"]');
	const below = row && row.querySelector('.extra-items-container.below');
	const strap = below && below.shadowRoot && below.shadowRoot.querySelector('[part~="shelf-strap"]');
	if (!strap) { return JSON.stringify({ missing: true, }); }
	const box = strap.getBoundingClientRect();
	const icons = [...strap.querySelectorAll('[part~="shelf-icon"]')].map(icon => {
		const rect = icon.getBoundingClientRect();
		return { right: Math.round(rect.right), bottom: Math.round(rect.bottom), width: Math.round(rect.width), height: Math.round(rect.height), };
	});
	return JSON.stringify({
		rowHeight: Math.round(row.getBoundingClientRect().height),
		rowWidth: Math.round(row.getBoundingClientRect().width),
		icons: icons.length,
		scrolls: strap.scrollWidth > strap.clientWidth + 1,
		overflowX: getComputedStyle(strap).overflowX,
		display: getComputedStyle(strap).display,
		strapHeight: Math.round(box.height),
		strapWidth: Math.round(box.width),
		allInside: icons.every(icon => icon.right <= Math.round(box.right) + 1 && icon.bottom <= Math.round(box.bottom) + 1),
		rows: new Set(icons.map(icon => icon.bottom)).size,
	});
`;

/** Row + browser visibility of one tab, read from the sidebar page. */
const rowlessProbeScript = String.raw`
	const id = arguments[0];
	return (async () => {
		const row = document.querySelector('tab-item[data-tab-id="' + id + '"]');
		const tab = await browser.tabs.get(id);
		return JSON.stringify({ hasRow: !!row, hidden: tab.hidden, active: tab.active, });
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

/** Rows AND browser visibility for a set of tabs.  `hidden` is the
 *  capability-sensitive half of a reveal: on a patched companion the row
 *  goes through `row-less` and the tab stays visible, on a stock one the
 *  row goes through browser.tabs.hide().  (Async IIFE: Marionette runs the
 *  script as a *body*, so a top-level await is a syntax error.) */
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

function printReport (path, phase) {
	const report = JSON.parse(fs.readFileSync(path, "utf8"));
	for (const entry of report.results || []) {
		console.log(`${entry.ok ? "PASS" : "FAIL"} [${phase}] ${entry.name}${entry.detail ? " " + entry.detail : ""}`);
	}
	if ((report.results || []).some(entry => !entry.ok)) { process.exitCode = process.exitCode || 1; }
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

		if (TST_PATCH) {
			const tstInstall = await marionette.command("Addon:Install", {
				path: TST_PATCH, temporary: true,
			});
			console.log(`[drive] temporary install (patched TST): ${JSON.stringify(tstInstall?.value ?? tstInstall)}`);
		}
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
				console.log(`${entry.ok ? "PASS" : "FAIL"} [setup] ${entry.name}${entry.detail ? " " + entry.detail : ""}`);
			}
			if ((expect.results || []).some(entry => !entry.ok)) { process.exitCode = process.exitCode || 1; }
		}

		// -- phase 2: sidebar DOM assertions + synthetic clicks ------------
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
			if (!baseUrl) {
				console.log("FAIL [driver] TST sidebar URL resolvable");
				process.exitCode = process.exitCode || 1;
			} else {
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
					console.log(`FAIL [driver] shelf icons render in the owner strap ${diag}`);
					process.exitCode = process.exitCode || 1;
				} else {
					console.log(`[drive] row classes: ${JSON.stringify((dump.rows || []).map(row => [row.id, row.classes]))}`);
					const e = expect.expect;
					const byId = Object.fromEntries(dump.icons.map(icon => [icon.id, icon]));

					if (dump.rows.find(row => row.id == String(e.owner) && row.classes.includes("tst-shelf-owner"))) {
						console.log("PASS [driver] owner row carries the tst-shelf-owner class");
					} else {
						console.log("FAIL [driver] owner row carries the tst-shelf-owner class");
						process.exitCode = process.exitCode || 1;
					}

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
						if (ownerRow && plainRow && Math.abs(ownerRow.height - plainRow.height) < 2) {
							console.log(`PASS [driver] the owner row keeps its normal height (owner=${ownerRow.height.toFixed(1)} plain=${plainRow.height.toFixed(1)})`);
						} else {
							console.log(`FAIL [driver] the owner row keeps its normal height (owner=${ownerRow && ownerRow.height} plain=${plainRow && plainRow.height})`);
							process.exitCode = process.exitCode || 1;
						}
					}
					{
						const ownerRow = dump.rows.find(row => row.id == String(e.owner));
						if (ownerRow && ownerRow.strap && ownerRow.classes.includes("tst-shelf-owner")) {
							console.log("PASS [driver] the strap renders inside the owner's own row");
						} else {
							console.log(`FAIL [driver] the strap renders inside the owner's own row (${JSON.stringify(ownerRow)})`);
							process.exitCode = process.exitCode || 1;
						}
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
						if (memberRows.length == 0) {
							console.log("PASS [driver] members keep no rows — a shelf costs one line");
						} else {
							const diag = await marionette.command("WebDriver:ExecuteScript", {
								script: shelfCallScript, args: [{ type: "test:state", },], newSandbox: false,
							}).catch(() => null);
							const diagState = diag && diag.value ? JSON.parse(diag.value) : null;
							console.log(`[driver] member-row diagnostic: ${JSON.stringify({
								claimed: diagState && diagState.rowLessByUs,
								retries: diagState && diagState.rowLessTries,
								caps: diagState && diagState.capabilities,
							})}`);
							console.log(`FAIL [driver] members keep no rows — a shelf costs one line (rows=${JSON.stringify(memberRows)})`);
							process.exitCode = process.exitCode || 1;
						}
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
						// the shelf exactly as it is: the icons must fit — a
					// shrinkable shelf next to a long title collapsed to
					// less than one icon and started scrolling (0.1.4 bug)
					{
						// the shelf must be as wide as it needs, or exactly as wide as
						// its cap allows — never narrower (0.1.4 squeezed it to a
						// scrolling sliver next to a long title)
						const unit = g && g.expectedIconSize > 0 ? g.expectedIconSize : g && g.iconWidth;
						const content = g ? g.naturalIcons * (unit + g.gap) - g.gap : 0;
						const cap = g ? 0.66 * g.uiWidth : 0;
						const fits = g && unit > 0 && g.naturalIcons > 0
							&& g.iconWidth >= unit - 1
							&& g.naturalWidth >= Math.min(content, cap) - 2;
						console.log(`${fits ? "PASS" : "FAIL"} [driver] the natural shelf fits its icons without scrolling (icons=${g && g.naturalIcons} iconW=${g && g.iconWidth && g.iconWidth.toFixed(1)} unit=${g && g.expectedIconSize} shelfW=${g && g.naturalWidth && g.naturalWidth.toFixed(1)} scrolls=${g && g.naturalScrolls})`);
						if (!fits) {
							console.log(`       geometry detail: ${JSON.stringify(g)}`);
							process.exitCode = process.exitCode || 1;
						}
					}
					const capped = g && g.ratio > 0 && g.ratio <= 0.68;
						const scrolls = g && g.overflowX == "auto" && g.scrolls;
						const truncated = g && g.inflatedLabelTruncated;
						const noGrowth = g && Math.abs(g.rowHeight - g.plainHeight) < 2;
						const cleaned = g && g.cleaned >= 2;
						console.log(`${capped ? "PASS" : "FAIL"} [driver] the shelf never exceeds 2/3 of the owner row (ratio=${g && g.ratio.toFixed(2)})`);
						console.log(`${scrolls ? "PASS" : "FAIL"} [driver] a shelf that does not fit scrolls horizontally (overflowX=${g && g.overflowX} scrolls=${g && g.scrolls})`);
						console.log(`${truncated ? "PASS" : "FAIL"} [driver] the owner title truncates to make room (label truncated=${g && g.inflatedLabelTruncated})`);
						console.log(`${noGrowth ? "PASS" : "FAIL"} [driver] a full shelf still does not grow the owner row (row=${g && g.rowHeight} plain=${g && g.plainHeight})`);
						if (!(capped && scrolls && truncated && noGrowth && cleaned)) {
							console.log(`       geometry detail: ${JSON.stringify(g)}`);
							process.exitCode = process.exitCode || 1;
						}
					}
					{
						const probe = await marionette.command("WebDriver:ExecuteScript", {
							script: lineProbeScript, args: [e.owner,], newSandbox: false,
						}).catch(error => { console.log(`[drive] line probe failed: ${error.message}`); return null; });
						console.log(`[drive] line probe: ${probe && probe.value}`);
					}
					if (TST_PATCH) {
						// -- A3: a row can be N whole lines, and the geometry
						// accounts for it exactly.  The addon declares the count
						// (`lines` on set-extra-contents); TST makes the row that
						// tall and computes every position from a sum of pitches.
						// Measured at 1 line and at 3: the row must be 3 pitches
						// tall and TST's computed extent must grow by exactly two.
						const call = async message => {
							const response = await marionette.command("WebDriver:ExecuteScript", {
								script: shelfCallScript, args: [message,], newSandbox: false,
							}).catch(error => { console.log(`[drive] shelf call failed: ${error.message}`); return null; });
							return response && response.value ? JSON.parse(response.value) : null;
						};
						const readExtent = async () => {
							const response = await marionette.command("WebDriver:ExecuteScript", {
								script: extentScript, args: [e.owner, e.plain,], newSandbox: false,
							}).catch(() => null);
							return response && response.value ? JSON.parse(response.value) : null;
						};
						// the extent is only materialized while the tab bar overflows
						await commandTry(marionette, "WebDriver:SetWindowRect", ["Marionette:SetWindowRect"], { width: 480, height: 220, }).catch(() => {});
						await new Promise(resolve => setTimeout(resolve, 1200));
						await call({ type: "test:lines", owner: e.owner, lines: 1, windowId, });
						await new Promise(resolve => setTimeout(resolve, 1200));
						const one = await readExtent();
						await call({ type: "test:lines", owner: e.owner, lines: 3, windowId, });
						await new Promise(resolve => setTimeout(resolve, 1200));
						const three = await readExtent();
						console.log(`[drive] A3 one line: ${JSON.stringify(one)}`);
						console.log(`[drive] A3 three lines: ${JSON.stringify(three)}`);
						const rendered = (one && one.rowList) || [];
						const pitch = rendered.length
							? rendered.map(row => row.height).sort((a, b) => a - b)[0]
							: 0;
						const rowGrew = one && three && pitch > 0
							&& Math.abs(one.ownerHeight - pitch) <= 2
							&& Math.abs(three.ownerHeight - 3 * pitch) <= 2;
						console.log(`${rowGrew ? "PASS" : "FAIL"} [driver] A3: a row of N declared lines paints N lines (1 line=${one && one.ownerHeight}, 3 lines=${three && three.ownerHeight}, pitch=${pitch})`);
						if (!rowGrew) { process.exitCode = process.exitCode || 1; }
						const extentGrew = one && three && pitch > 0 && one.minHeight > 0
							&& Math.abs((three.minHeight - one.minHeight) - 2 * pitch) <= 2;
						console.log(`${extentGrew ? "PASS" : "FAIL"} [driver] A3: TST's computed scroll extent grows by exactly the extra lines (${one && one.minHeight} -> ${three && three.minHeight}, pitch=${pitch})`);
						if (!extentGrew) { process.exitCode = process.exitCode || 1; }
						// the row that follows the grown one must start exactly where
						// the grown row ends: painted flow and computed geometry agree
						const ownerTop = three && (three.rowList.find(row => row.id == String(e.owner)) || {}).top;
						const follower = three && three.rowList.find(row => row.id != String(e.owner));
						const contiguous = three && ownerTop != null && follower
							&& Math.abs(follower.top - (ownerTop + three.ownerHeight)) <= 2;
						console.log(`${contiguous ? "PASS" : "FAIL"} [driver] A3: the next row starts exactly where the grown row ends (owner=${ownerTop}+${three && three.ownerHeight}, next=${follower && follower.top})`);
						if (!contiguous) { process.exitCode = process.exitCode || 1; }
						// restore: the addon's own computation, tall window
						await call({ type: "test:lines", owner: e.owner, lines: 0, windowId, });
						await commandTry(marionette, "WebDriver:SetWindowRect", ["Marionette:SetWindowRect"], { width: 480, height: 900, }).catch(() => {});
						await new Promise(resolve => setTimeout(resolve, 1500));
					}
					{
						// -- B: a row-less tab keeps the tab but loses its row.
						// This is the capability feature 1 of 0.2.0 needs; a stock
						// TST ignores the state and keeps the row (that is the
						// documented fallback).  Read it on a PLAIN tab, so the
						// answer is not confused with our own hiding of members.
						const call = async message => {
							const response = await marionette.command("WebDriver:ExecuteScript", {
								script: shelfCallScript, args: [message,], newSandbox: false,
							}).catch(error => { console.log(`[drive] shelf call failed: ${error.message}`); return null; });
							return response && response.value ? JSON.parse(response.value) : null;
						};
						const probe = async () => {
							const response = await marionette.command("WebDriver:ExecuteScript", {
								script: rowlessProbeScript, args: [e.plain,], newSandbox: false,
							}).catch(() => null);
							return response && response.value ? JSON.parse(response.value) : null;
						};
						const before = await probe();
						await call({ type: "test:tab-state", tabId: e.plain, state: "row-less", windowId, });
						await new Promise(resolve => setTimeout(resolve, 1500));
						const during = await probe();
						await call({ type: "test:tab-state", tabId: e.plain, state: "row-less", add: false, windowId, });
						await new Promise(resolve => setTimeout(resolve, 1500));
						const after = await probe();
						console.log(`[drive] row-less probe: ${JSON.stringify({ before, during, after, patched: !!TST_PATCH })}`);
						const lostRow = TST_PATCH ? (during && !during.hasRow) : (during && during.hasRow);
						const stayedVisible = during && during.hidden === false;
						const restored = after && after.hasRow;
						console.log(`${lostRow && stayedVisible ? "PASS" : "FAIL"} [driver] ${TST_PATCH ? "B: a row-less tab loses its row while staying visible" : "B fallback: a stock TST ignores row-less and keeps the row"} (hasRow=${during && during.hasRow} hidden=${during && during.hidden})`);
						if (!(lostRow && stayedVisible)) { process.exitCode = process.exitCode || 1; }
						console.log(`${restored ? "PASS" : "FAIL"} [driver] clearing row-less brings the row back`);
						if (!restored) { process.exitCode = process.exitCode || 1; }
					}
					{
						const conformance = await marionette.command("WebDriver:ExecuteScript", {
							script: conformanceScript, args: [e.plain,], newSandbox: false,
						}).catch(error => { console.log(`[drive] conformance probe failed: ${error.message}`); return null; });
						const c = conformance && conformance.value ? JSON.parse(conformance.value) : null;
						if (c && c.rows >= 2 && c.drift.length == 0 && c.rowH > 20) {
							console.log(`PASS [driver] every rendered row sits at TST's computed position — drop zones exact (rows=${c.rows} rowH=${c.rowH.toFixed(1)} anchor=${c.anchor.toFixed(1)})`);
						} else {
							console.log(`FAIL [driver] every rendered row sits at TST's computed position — drop zones exact ${JSON.stringify(c)}`);
							process.exitCode = process.exitCode || 1;
						}
					}

					// bug 3: the re-put member (B, the newest put) is the
					// RIGHTMOST icon; C kept its earlier block slot.
					{
						const order = (dump.icons || []).map(icon => icon.id);
						const expected = [String(e.members[1]), String(e.members[0]), String(e.f)];
						if (JSON.stringify(order) == JSON.stringify(expected)) {
							console.log(`PASS [driver] the newest member is the rightmost icon (${order.join(",")})`);
						} else {
							console.log(`FAIL [driver] the newest member is the rightmost icon (got ${order.join(",")})`);
							process.exitCode = process.exitCode || 1;
						}
					}

					if (byId[String(e.members[0])] && byId[String(e.members[1])]) {
						console.log("PASS [driver] both members are icons on the owner strap");
					} else {
						console.log(`FAIL [driver] both members are icons on the owner strap ${JSON.stringify(dump.icons)}`);
						process.exitCode = process.exitCode || 1;
					}

					const iconB = byId[String(e.members[0])];
					const iconC = byId[String(e.members[1])];
					if (iconB && iconB.title == "shelf tree tab") {
						console.log("PASS [driver] icons carry title tooltips");
					} else {
						console.log(`FAIL [driver] icons carry title tooltips ${iconB && iconB.title}`);
						process.exitCode = process.exitCode || 1;
					}

					if (iconC && iconC.badge) {
						console.log("PASS [driver] the folded member carries the plus badge");
					} else {
						console.log(`FAIL [driver] the folded member carries the plus badge ${JSON.stringify(iconC)}`);
						process.exitCode = process.exitCode || 1;
					}

					if (iconB && iconB.draggable == "true") {
						console.log("PASS [driver] icons are native drag sources");
					} else {
						console.log(`FAIL [driver] icons are native drag sources ${iconB && iconB.draggable}`);
						process.exitCode = process.exitCode || 1;
					}

					if (iconB && iconB.hasBg) {
						console.log("PASS [driver] favicons ride the style attribute through the sanitizer");
					} else {
						console.log(`FAIL [driver] favicons ride the style attribute through the sanitizer ${iconB && JSON.stringify(iconB)}`);
						process.exitCode = process.exitCode || 1;
					}

					if ((dump.rootIcons || []).some(icon => icon.id == String(e.rootMember))) {
						console.log("PASS [driver] the root shelf strap holds the shelved root tab");
					} else {
						console.log(`FAIL [driver] the root shelf strap holds the shelved root tab ${JSON.stringify(dump.rootIcons)}`);
						process.exitCode = process.exitCode || 1;
					}

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
					if (visibleInfo && visibleInfo.c1.height > 0 && visibleInfo.c2.height > 0) {
						console.log("PASS [driver] the selected shelved tab's children render below the shelf");
					} else {
						console.log(`FAIL [driver] the selected shelved tab's children render below the shelf ${JSON.stringify(visibleInfo)}`);
						process.exitCode = process.exitCode || 1;
					}

					// bug 2 (0.1.4): the children dangle from the SHELF — the
					// shelf is a single line inside the owner's row, so the
					// children sit directly below that row and above the plain
					// sibling that follows the member block, not below it.
					// Rows must EXIST (a missing row would make the top
					// comparison vacuously true).
					if (visibleInfo && visibleInfo.c1.exists && visibleInfo.c1.height > 0
						&& visibleInfo.c2.exists && visibleInfo.c2.height > 0
						&& visibleInfo.plain && visibleInfo.plain.height > 0
						&& visibleInfo.c1.top < visibleInfo.plain.top && visibleInfo.c2.top < visibleInfo.plain.top) {
						console.log("PASS [driver] the selected member's subtree dangles from the shelf, above the following siblings");
					} else {
						console.log(`FAIL [driver] the selected member's subtree dangles from the shelf, above the following siblings ${JSON.stringify(visibleInfo && { c1: visibleInfo.c1, c2: visibleInfo.c2, plain: visibleInfo.plain && visibleInfo.plain.top })}`);
						process.exitCode = process.exitCode || 1;
					}
					if (visibleInfo && visibleInfo.owner && visibleInfo.owner.height > 0
						&& visibleInfo.c1.top >= visibleInfo.owner.top + visibleInfo.owner.height - 1) {
						console.log("PASS [driver] the selected member's children render directly below the owner row");
					} else {
						console.log(`FAIL [driver] the selected member's children render directly below the owner row ${JSON.stringify(visibleInfo && { owner: visibleInfo.owner.top + visibleInfo.owner.height, c1: visibleInfo.c1.top })}`);
						process.exitCode = process.exitCode || 1;
					}

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
					if (!(memberRowState && memberRowState[e.clickFirst])) {
						console.log(`[driver] member row missing after the click: ${JSON.stringify({ row: memberRowState, claimed: diagCState && diagCState.rowLessByUs, trace: diagCState && diagCState.rowLessDebug, diag: diagCState && diagCState.diagLog, })}`);
						process.exitCode = process.exitCode || 1;
					}
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
						if (!startedWithMember) {
							console.log(`FAIL [driver] sampling starts with the member's row on screen (start=${JSON.stringify(startIds)})`);
							process.exitCode = process.exitCode || 1;
						}
						if (samples.length >= 30 && orphans.length == 0 && startedWithMember) {
							console.log("PASS [driver] an unshelved sibling reclaims the member's row without orphaning its subtree");
						} else {
							console.log(`FAIL [driver] an unshelved sibling reclaims the member's row without orphaning its subtree (${orphans.length} orphan frames of ${samples.length}: ${JSON.stringify(orphans.slice(0, 3))})`);
							process.exitCode = process.exitCode || 1;
						}
						const presence = await marionette.command("WebDriver:ExecuteScript", {
							script: rowPresenceScript,
							args: [[e.clickFirst, e.children[0], e.children[1], e.plain,],],
							newSandbox: false,
						}).catch(() => null);
						const rows = presence && presence.value ? JSON.parse(presence.value) : null;
						const gone = rows && !rows[e.clickFirst] && !rows[e.children[0]] && !rows[e.children[1]];
						const siblingShown = rows && rows[e.plain];
						if (gone && siblingShown) {
							console.log(`PASS [driver] the member's row and its whole subtree are gone after the switch (${JSON.stringify(rows)})`);
						} else {
							console.log(`FAIL [driver] the member's row and its whole subtree are gone after the switch (${JSON.stringify(rows)})`);
							process.exitCode = process.exitCode || 1;
						}
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
						if (samples.length >= 30 && orphans.length == 0) {
							console.log("PASS [driver] a parent's row never disappears while its children are still painted");
						} else {
							console.log(`FAIL [driver] a parent's row never disappears while its children are still painted (${orphans.length} frames of ${samples.length}: ${JSON.stringify(orphans.slice(0, 3))})`);
							process.exitCode = process.exitCode || 1;
						}
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
					if (!sawF) {
						console.log("FAIL [driver] the childless member's icon appears (pure-swap switch)");
						process.exitCode = process.exitCode || 1;
					} else {
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
						if (samples.length >= 30 && displaced.length <= frameBudget && restingTop != null && Math.abs(restingTop - tops[0]) <= 2) {
							console.log(`PASS [driver] switching between childless shelf tabs displaces the tree for at most ${displaced.length} frame(s) and returns it (${displaced.length * 17}ms)`);
						} else {
							console.log(`FAIL [driver] switching between childless shelf tabs displaces the tree (${displaced.length} frames of ${samples.length}, trail ${JSON.stringify([...new Set(tops)])})`);
							process.exitCode = process.exitCode || 1;
						}

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
						if (row && row.strap && icon) {
							console.log("PASS [driver] a shelved tab that owns a shelf shows that shelf in its own row");
						} else {
							console.log(`FAIL [driver] a shelved tab that owns a shelf shows that shelf in its own row (owner=${JSON.stringify(row)} member=${JSON.stringify(icon)})`);
							process.exitCode = process.exitCode || 1;
						}
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
						if (row && row.strap) {
							console.log("PASS [driver] activating a tab of a nested shelf keeps that shelf's owner visible");
						} else {
							console.log(`FAIL [driver] activating a tab of a nested shelf keeps that shelf's owner visible (owner=${JSON.stringify(row)})`);
							process.exitCode = process.exitCode || 1;
						}
						// A CHILDLESS member is row-less on a TST with the B
						// capability (feature 1): activating it must NOT produce a
						// row — that is what removes the reveal/row-swap flicker.
						// On a stock TST the member is hidden by us and Firefox
						// reveals it, so it does get a row.
						const expectRow = !TST_PATCH;
						const asExpected = !!activeRow === expectRow;
						console.log(`${asExpected ? "PASS" : "FAIL"} [driver] ${expectRow ? "the activated nested member has a row (hidden-tab fallback)" : "a row-less member gets no row even while active"} (hasRow=${!!activeRow})`);
						if (!asExpected) { process.exitCode = process.exitCode || 1; }
					}
					// -- crowded shelf: grow the row in whole lines instead of
					// scrolling, so every icon stays visible (0.2.0 "extend").
					// One more member is put on A's shelf while it is ACTIVE —
					// a childless member is row-less, so its own row must not
					// appear even though it is the selected tab.
					if (TST_PATCH) {
						const call = async message => {
							const response = await marionette.command("WebDriver:ExecuteScript", {
								script: shelfCallScript, args: [message,], newSandbox: false,
							}).catch(error => { console.log(`[drive] shelf call failed: ${error.message}`); return null; });
							return response && response.value ? JSON.parse(response.value) : null;
						};
						const stateBefore = await call({ type: "test:state", });
						const width = stateBefore && stateBefore.widths && (stateBefore.widths.find(([id]) => id == windowId) || [])[1];
						await call({ type: "test:put", tabId: e.plain, });
						// the member is childless, so it must be row-less — and it
						// must STAY row-less while it is the active tab
						await marionette.command("WebDriver:ExecuteScript", {
							script: activateScript, args: [e.plain,], newSandbox: false,
						}).catch(error => console.log(`[drive] activation failed: ${error.message}`));
						await new Promise(resolve => setTimeout(resolve, 2500));
						const grown = await call({ type: "test:state", });
						const linesOf = state => {
							const entry = state && state.lines && state.lines.find(([id]) => id == windowId);
							const map = entry && new Map(entry[1]);
							return map ? (map.get("root") || null, map.get(String(e.owner)) || map.get(e.owner)) : null;
						};
						const expectedLines = linesOf(grown);
						const fit = await marionette.command("WebDriver:ExecuteScript", {
							script: shelfFitScript, args: [e.owner,], newSandbox: false,
						}).catch(() => null);
						const f = fit && fit.value ? JSON.parse(fit.value) : null;
						const pitch = f && f.icons > 0 ? 39 : 0;
						console.log(`[drive] crowded shelf: width=${width} lines=${expectedLines} fit=${JSON.stringify(f)}`);
						const grewLines = expectedLines > 1;
						const tallRow = f && pitch > 0 && Math.abs(f.rowHeight - expectedLines * pitch) <= 2;
						const allVisible = f && !f.scrolls && f.allInside;
						const stacked = f && f.rows === expectedLines;
						console.log(`${grewLines ? "PASS" : "FAIL"} [driver] a crowded shelf asks for more than one line (lines=${expectedLines}, width=${width})`);
						console.log(`${tallRow ? "PASS" : "FAIL"} [driver] the crowded shelf's row is exactly that many lines (row=${f && f.rowHeight} lines=${expectedLines})`);
						console.log(`${stacked ? "PASS" : "FAIL"} [driver] the icons are laid out in that many rows (rows=${f && f.rows})`);
						console.log(`${allVisible ? "PASS" : "FAIL"} [driver] every icon is visible without horizontal scrolling (icons=${f && f.icons} scrolls=${f && f.scrolls})`);
						if (!(grewLines && tallRow && stacked && allVisible)) { process.exitCode = process.exitCode || 1; }
						// the member we just put on the shelf is ACTIVE and has no
						// children: it must be row-less, i.e. no row, not hidden
						const presence = await marionette.command("WebDriver:ExecuteScript", {
							script: rowPresenceScript, args: [[e.plain,],], newSandbox: false,
						}).catch(() => null);
						const rows = presence && presence.value ? JSON.parse(presence.value) : null;
						const live = await marionette.command("WebDriver:ExecuteScript", {
							script: rowlessProbeScript, args: [e.plain,], newSandbox: false,
						}).catch(() => null);
						const info = live && live.value ? JSON.parse(live.value) : null;
						if (rows && rows[e.plain] === false && info && info.hidden === false && info.active === true) {
							console.log("PASS [driver] an ACTIVE childless member has no row and is not hidden");
						} else {
							console.log(`FAIL [driver] an ACTIVE childless member has no row and is not hidden (${JSON.stringify({ rows, info })})`);
							process.exitCode = process.exitCode || 1;
						}
						await call({ type: "test:take", tabId: e.plain, });
						await new Promise(resolve => setTimeout(resolve, 2000));
						const back = await marionette.command("WebDriver:ExecuteScript", {
							script: shelfFitScript, args: [e.owner,], newSandbox: false,
						}).catch(() => null);
						const b = back && back.value ? JSON.parse(back.value) : null;
						console.log(`${b && b.rowHeight <= pitch + 2 ? "PASS" : "FAIL"} [driver] taking it off the shelf returns the row to one line (row=${b && b.rowHeight})`);
						if (!(b && b.rowHeight <= pitch + 2)) { process.exitCode = process.exitCode || 1; }
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
					// popped into view.  Runs on BOTH companions: the suppressed
					// rows go through `row-less` on a patched TST and through
					// browser.tabs.hide() on a stock one, so the assertions split
					// by capability.
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
						const state0 = await call({ type: "test:state", });
						const rowLess = !!(state0 && state0.capabilities && state0.capabilities.rowLess);
						console.log(`[drive] reveal on ${rowLess ? "a patched" : "a stock"} companion`);
						await call({ type: "test:collapse", tabId: e.owner, windowId, collapsed: true, });
						await new Promise(resolve => setTimeout(resolve, 2000));
						const folded = await presence([e.owner, e.clickFirst, e.children[0], e.children[1], e.plain]);
						console.log(`[drive] rows while the owner is folded: ${JSON.stringify(folded)}`);
						console.log(`${folded[e.clickFirst] === false && folded[e.plain] === false ? "PASS" : "FAIL"} [driver] a folded owner renders no rows for its subtree`);
						// click C's icon: C's branch comes back, D must not
						await marionette.command("WebDriver:ExecuteScript", {
							script: sidebarScript, args: [e.clickFirst,], newSandbox: false,
						}).catch(error => console.log(`[drive] reveal click failed: ${error.message}`));
						await new Promise(resolve => setTimeout(resolve, 2500));
						const revealed = await presence([e.owner, e.clickFirst, e.children[0], e.children[1], e.plain, e.clickSecond, e.f]);
						console.log(`[drive] rows after the reveal: ${JSON.stringify(revealed)}`);
						// c1 is a member of C's OWN shelf, so it stays row-less;
						// the branch that must appear is the owner, C and c2.
						const branchOk = revealed[e.owner] && revealed[e.clickFirst] && revealed[e.children[1]];
						console.log(`${branchOk ? "PASS" : "FAIL"} [driver] the activated shelf tab's branch has rows (owner, member, its plain child)`);
						console.log(`${revealed[e.children[0]] === false ? "PASS" : "FAIL"} [driver] a nested member of the branch stays row-less (c1)`);
						console.log(`${revealed[e.plain] === false ? "PASS" : "FAIL"} [driver] the unshelved sibling keeps NO row under a reveal`);
						const state = await call({ type: "test:state", });
						const revealState = (state && state.reveals && state.reveals[windowId]) || [];
						const suppressed = (state && state.suppressedByUs) || [];
						const suppressedHidden = (state && state.suppressedHiddenByUs) || [];
						console.log(`[driver] reveal state: ${JSON.stringify({ reveal: revealState, suppressed, suppressedHidden, retries: state && state.rowLessTries, debug: state && state.revealDebug, })}`);
						const revealOk = revealState.some(([owner]) => owner == e.owner) &&
							(rowLess ? suppressed.includes(e.plain) : suppressedHidden.includes(e.plain));
						console.log(`${revealOk ? "PASS" : "FAIL"} [driver] the addon keeps the owner expanded and accounts for the suppressed sibling (${rowLess ? "row-less" : "hidden"})`);
						const hiddenSibling = (state && state.hiddenByUs) || [];
						console.log(`${hiddenSibling.includes(e.plain) ? "FAIL" : "PASS"} [driver] a suppressed tab is never counted as a member hide`);
						// capability split: no hiding at all on a patched TST; the
						// browser reports `hidden` on a stock one
						const live = await marionette.command("WebDriver:ExecuteScript", {
							script: rowAndStateScript, args: [[e.plain,],], newSandbox: false,
						}).catch(() => null);
						const liveState = live && live.value ? JSON.parse(live.value) : null;
						const hiddenFlag = !!(liveState && liveState.hidden[e.plain]);
						const hidingOk = rowLess ? hiddenFlag === false : hiddenFlag === true;
						console.log(`${hidingOk ? "PASS" : "FAIL"} [driver] the suppressed sibling is ${rowLess ? "not hidden (row-less only)" : "hidden (the stock lever)"}`);
						if (!(branchOk && revealed[e.plain] === false && revealOk && !hiddenSibling.includes(e.plain) && hidingOk)) {
							process.exitCode = process.exitCode || 1;
						}
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
						console.log(`${nestedOk ? "PASS" : "FAIL"} [driver] clicking a nested shelf member keeps the nested owner's row (its strap host)`);
						if (!nestedOk) { process.exitCode = process.exitCode || 1; }
						// leaving the owner's subtree ends the reveal and folds it back
						await marionette.command("WebDriver:ExecuteScript", {
							script: activateScript, args: [e.rootMember,], newSandbox: false,
						}).catch(error => console.log(`[drive] root activation failed: ${error.message}`));
						await new Promise(resolve => setTimeout(resolve, 2500));
						const afterState = await call({ type: "test:state", });
						const revealAfter = (afterState && afterState.reveals && afterState.reveals[windowId]) || [];
						const suppressedAfter = (afterState && afterState.suppressedByUs) || [];
						const suppressedHiddenAfter = (afterState && afterState.suppressedHiddenByUs) || [];
						const backRows = await presence([e.owner, e.clickFirst, e.plain]);
						const backLive = await marionette.command("WebDriver:ExecuteScript", {
							script: rowAndStateScript, args: [[e.plain,],], newSandbox: false,
						}).catch(() => null);
						const backState = backLive && backLive.value ? JSON.parse(backLive.value) : null;
						console.log(`[driver] after leaving: ${JSON.stringify({ revealAfter, suppressedAfter, suppressedHiddenAfter, backRows, backState, })}`);
						const ended = revealAfter.length == 0 &&
							suppressedAfter.length == 0 &&
							suppressedHiddenAfter.length == 0 &&
							backRows[e.clickFirst] === false;
						console.log(`${ended ? "PASS" : "FAIL"} [driver] leaving the owner's subtree ends the reveal and the owner folds back`);
						// the suppressed sibling must come back to the browser too
						const siblingBack = !(backState && backState.hidden[e.plain]);
						console.log(`${siblingBack ? "PASS" : "FAIL"} [driver] ending the reveal restores the suppressed sibling's visibility`);
						if (!(ended && siblingBack)) { process.exitCode = process.exitCode || 1; }
					}
				}
			}
		}

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
			console.log("FAIL [driver] reinstalled smoke page reports again (persistence path)");
			process.exitCode = process.exitCode || 1;
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
