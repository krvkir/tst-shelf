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
import http from "node:http";
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
/** The hint-mode fixture pages: a real http server (the favicon probe's
 *  pattern).  executeScript can inject into http (MDN) but never into
 *  about:/extension pages, so the real page catcher and the
 *  special-page exclusion both need real http pages — mirrored as a
 *  constant in src/tests-smoke.js (phase 1 runs there, before any
 *  driver script exists). */
const HINT_PORT = 47631;
const HINT_ORIGIN = `http://127.0.0.1:${HINT_PORT}`;
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
	const clickPart = arguments[1];
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
				const glyph = icon.querySelector('[part~="shelf-sound"]');
				const marker = icon.querySelector('[part~="shelf-marker"]');
				const record = {
					id: icon.dataset.tabId,
					title: (icon.getAttribute("title") || "").split("\n")[0],
					hasBg: /background-image/.test(icon.getAttribute("style") || ""),
					draggable: icon.getAttribute("draggable"),
					badgeText: icon.querySelector('[part~="shelf-badge"]') ?
						icon.querySelector('[part~="shelf-badge"]').textContent : null,
					sound: !glyph ? null :
						(glyph.getAttribute("part") || "").includes("tst-shelf-sound-muted") ? "muted" : "playing",
					active: (icon.getAttribute("part") || "").includes("tst-shelf-icon-active"),
					// 0.6.4 container line: the marker span's own inline
					// style (live palette reference), or null when absent
					marker: marker ? (marker.getAttribute("style") || "") : null,
				};
				icons.push(record);
				if (clickId != null && record.id == String(clickId)) {
					const target = clickPart === "sound" ? glyph : icon;
					if (!target) { throw new Error("no click target for " + clickId + " " + clickPart); }
					const rect = target.getBoundingClientRect();
					target.dispatchEvent(new MouseEvent("mousedown", {
						bubbles: true, composed: true, button: 0,
						clientX: rect.x + 5, clientY: rect.y + 5,
					}));
					// the matching release: a mousedown-only press would leave
					// the drag hold armed for its whole 10 s watchdog window
					// (the hold is released on mouseup), so every synthetic
					// click here is a faithful press+release
					target.dispatchEvent(new MouseEvent("mouseup", {
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
			const marker = icon.querySelector('[part~="shelf-marker"]');
			rootIcons.push({
				id: icon.dataset.tabId,
				title: (icon.getAttribute("title") || "").split("\n")[0],
				hasBg: /background-image/.test(icon.getAttribute("style") || ""),
				marker: marker ? (marker.getAttribute("style") || "") : null,
			});
		}
	}
	// the registered style string (installStyle stores it in a
	// <style type="text/css"> element in the sidebar head): does the
	// container-line block survive %EXPANSION% and TST's install?
	const styleText = [...document.querySelectorAll("style[type='text/css']")]
		.map(style => style.textContent || "")
		.join("\n");
	const normal = document.querySelector("#normal-tabs-container .tabs");
	return JSON.stringify({
		href: location.href,
		readyState: document.readyState,
		allTabItems: document.querySelectorAll("tab-item").length,
		rowsWithTabId: flat.length,
		rows: flat, icons, rootIcons, clicked: !!clickId,
		themeStyle: document.documentElement.dataset.style || null,
		hasMarkerRule: styleText.includes("shelf-marker"),
		hasMarkerProton: styleText.includes(":root[data-style=\"proton\"].regular ::part"),
		hasMarkerNova: styleText.includes(":root[data-style=\"nova\"] ::part"),
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

/** Real http pages in the fixture window, the first made ACTIVE (the
 *  window's active tab decides both the decline rule and the catcher's
 *  injection target).  Returns the new ids plus EVERY http tab of the
 *  window (phase 1's smoke page creates one too).  The QUERY PATTERN
 *  carries no port — match patterns reject ports (MDN) — while the
 *  CREATED URLs do.  Run on the tab-hosted TST sidebar page
 *  (browser.tabs works there). */
const mkHintTabsScript = String.raw`
	return (async () => {
		const windowId = arguments[0];
		const origin = arguments[1];
		const a = await browser.tabs.create({ windowId, url: origin + "/a.html", active: false, });
		// the second tab opens as the FIRST tab's opener-child: a NESTED
		// rendered row — the witness the 0.6.2 converse check needs
		// (TST's rendered query without tab:'*' drops nested tabs from
		// its top level; a root-row witness could never catch that).
		// The fixture's own D is folded away at this point (the 0.2.1
		// reveal checks leave A folded), so it cannot witness anything.
		const child = await browser.tabs.create({ windowId, url: origin + "/child.html", active: false, openerTabId: a.id, });
		const b = await browser.tabs.create({ windowId, url: origin + "/b.html", active: false, });
		await browser.tabs.update(a.id, { active: true, });
		const settled = [];
		for (let attempt = 0; attempt < 20; attempt++) {
			const tabs = await browser.tabs.query({ windowId, url: "http://127.0.0.1/*", });
			const ready = tabs.length >= 3 && tabs.every(tab => tab.status === "complete");
			if (ready) { settled.push(...tabs.map(tab => tab.id)); break; }
			await new Promise(resolve => setTimeout(resolve, 500));
		}
		return JSON.stringify({ a: a.id, child: child.id, all: settled, });
	})();
`;

/** Make a given tab the window's active tab — the hint mode's anchor
 *  rule keys on the ACTIVE tab, and a block that just activated a
 *  special page (about:blank fixture tabs, a shelved member) must hand
 *  the anchor back to an injectable page before the next entry. */
const activateTabScript = String.raw`
	return (async () => {
		await browser.tabs.update(Number(arguments[0]), { active: true, });
		return "ok";
	})();
`;

/** Dispatches one synthetic keydown on the key catcher (composed, so the
 *  document-level capture listener in tst-api-frontend.js sees it and
 *  forwards it to the addon).  Returns whether a catcher was present. */
const keydownScript = String.raw`
	const key = arguments[0];
	const host = document.querySelector("#tabbar-top .extra-items-container");
	const root = host && host.shadowRoot;
	const catcher = root && root.querySelector('[part~="shelf-keycatcher"]');
	if (!catcher) { return "no-catcher"; }
	window.__dispatchedKeys = window.__dispatchedKeys || [];
	if (window.__dispatchedKeys.length > 30) { window.__dispatchedKeys = []; }
	window.__dispatchedKeys.push(key);
	catcher.dispatchEvent(new KeyboardEvent("keydown", {
		key, bubbles: true, composed: true, cancelable: true, repeat: false,
	}));
	return "sent " + key + " queue:" + JSON.stringify(window.__dispatchedKeys);
`;

/** Where does a REAL focus event land for the catcher?  Trace listeners
 *  at document, #tabbar-top, the shadow root and the catcher; then a
 *  catcher.focus().  The composed/bubble behavior for focus targeting a
 *  node inside a shadow root decides whether TST's document-level capture
 *  listener can ever forward extra-contents-focus. */
const focusProbeScript = String.raw`
	return (async () => {
		const host = document.querySelector("#tabbar-top .extra-items-container");
		const root = host && host.shadowRoot;
		const catcher = root && root.querySelector('[part~="shelf-keycatcher"]');
		if (!catcher) { return "no-catcher"; }
		const trace = [];
		document.addEventListener("focus", e => trace.push("doc:" + (e.composed ? "c" : "u") + ":" + (e.target.id || e.target.tagName)), true);
		document.querySelector("#tabbar-top").addEventListener("focus", () => trace.push("tabbar-top"), true);
		root.addEventListener("focus", () => trace.push("shadow"), true);
		catcher.addEventListener("focus", () => trace.push("catcher"), true);
		const result = { tabindexBefore: catcher.getAttribute("tabindex"), trace, };
		catcher.focus();
		result.focus1 = root.activeElement === catcher;
		if (!result.focus1) {
			catcher.setAttribute("tabindex", "0");
			catcher.focus();
			result.focus2 = root.activeElement === catcher;
			result.tabindexAfter = catcher.getAttribute("tabindex");
		}
		await new Promise(r => setTimeout(r, 400));
		result.focusedAfter = root.activeElement === catcher;
		return JSON.stringify(result);
	})();
`;

/** TST's addon registry, from the tab-hosted sidebar page's own channel:
 *  kCOMMAND_REQUEST_INITIALIZE answers {addons: {id: full entry}} with
 *  this addon's registered listeningTypes — the exact set TST's
 *  hasListenerForMessageType gates event forwarding on. */
const tstRegistryScript = String.raw`
	return (async () => {
		const response = await browser.runtime.sendMessage({ type: "treestyletab:request-initialize", });
		const self = response && response.addons && response.addons["tst-shelf@example.com"];
		return JSON.stringify(self ? {
			listeningTypes: self.listeningTypes,
			name: self.name,
			version: self.version,
		} : null);
	})();
`;

/** The sound-block state probe: catches the reply rejection INSIDE the
 *  page and reports the calling context (href, runtime availability),
 *  because a rejected ExecuteScript promise surfaces as {value: null}
 *  (Firefox 158 Marionette), indistinguishable from an empty reply. */
const soundStateProbeScript = String.raw`
	return (async () => {
		try {
			const response = await browser.runtime.sendMessage("tst-shelf@example.com", { type: "test:state", });
			return "OK:" + JSON.stringify({
				keys: Object.keys(response || {}),
				active: response && response.shelves && response.shelves[arguments[0]]
					? response.shelves[arguments[0]].active : null,
				shelves: response && response.shelves ? Object.keys(response.shelves) : null,
				rendered: response && response.renderedTabs ? Object.keys(response.renderedTabs) : null,
				hints: response ? response.hints : null,
				bootlog: response ? response.bootlog : null,
			});
		} catch (error) {
			return "ERR:" + (error && error.message || String(error))
				+ "|href=" + String(location.href).slice(0, 80)
				+ "|runtime=" + String(typeof (window.browser && browser.runtime));
		}
	})();
`;

/** A tab's TST tree export (states included), read from the tab-hosted
 *  sidebar page's external channel — the same call the smoke page makes. */
const treeStateScript = String.raw`
	return (async () => {
		const response = await browser.runtime.sendMessage(
			"tst-shelf@example.com",
			{ type: "test:tree-of", tab: arguments[0], }
		);
		return JSON.stringify(response && response.tree || null);
	})();
`;

/** The hint-mode DOM dump: catcher presence, the code chip on every
 *  strap icon, the owner chip leading every strap, the code label in
 *  every rendered row's tab-above overlay, and the idle wrapper's
 *  presence in the root container. */
const hintDumpScript = String.raw`
	const chips = [];
	for (const strapHost of document.querySelectorAll("#tabbar-top .extra-items-container, tab-item[data-tab-id] .extra-items-container.below")) {
		const root = strapHost.shadowRoot;
		if (!root) { continue; }
		for (const icon of root.querySelectorAll('[part~="shelf-icon"]')) {
			const chip = icon.querySelector('[part~="shelf-hint"]');
			chips.push({ id: icon.dataset.tabId, code: chip ? chip.textContent : null,
				chipFont: chip ? getComputedStyle(chip).fontSize : null });
		}
	}
	const ownerChips = [];
	for (const row of document.querySelectorAll("tab-item[data-tab-id]")) {
		if (row.id == "dummy-tab" || row.classList.contains("dummy-tab")) { continue; }
		const strapHost = row.querySelector(".extra-items-container.below");
		const strapRoot = strapHost && strapHost.shadowRoot;
		const strapPart = strapRoot && strapRoot.querySelector('[part~="shelf-strap"]');
		const chip = strapPart && strapPart.querySelector('[part~="shelf-owner-hint"]');
		if (!chip) { continue; }
		const chipRect = chip.getBoundingClientRect();
		const firstIcon = strapPart.querySelector('[part~="shelf-icon"]');
		const firstIconRect = firstIcon && firstIcon.getBoundingClientRect();
		const rowRect = row.getBoundingClientRect();
		ownerChips.push({
			id: row.dataset.tabId,
			code: chip.getAttribute("data-hint"),
			text: chip.textContent,
			// 0.6.3: the chip is the strap's first flex item — one strap-gap
			// left of the leftmost member ICON, vertically on the strap's
			// own line, inside the row
			leftOfLeftmost: firstIconRect ? chipRect.right <= firstIconRect.left + 1 : null,
			// chip's right edge to the DOM-FIRST member icon's left edge.
			// The strap SCROLLS (a focus action shifts its content), so the
			// container's box rect is not a usable datum — two content
			// rects ride the same scroll and their distance is invariant.
			cellGap: firstIconRect ? Math.round(firstIconRect.left - chipRect.right) : null,
			// same LINE = the two centers agree: the owner chip is a
			// flex-centered strap item, the icon chip is a corner badge
			// INSIDE its icon cell — their tops differ by construction
			lineCenter: firstIcon ? Math.round((chipRect.top + chipRect.bottom) / 2
				- (firstIconRect.top + firstIconRect.bottom) / 2) : null,
			inRow: chipRect.top >= rowRect.top - 2 && chipRect.bottom <= rowRect.bottom + 2,
			chipFont: getComputedStyle(chip).fontSize,
		});
	}
	const labels = [];
	for (const row of document.querySelectorAll("tab-item[data-tab-id]")) {
		// the dummy tab mirrors the LAST rendered tab's id; it is not a
		// row and its mirrored label belongs to the mirrored icon, not to
		// any row
		if (row.id == "dummy-tab" || row.classList.contains("dummy-tab")) { continue; }
		// 0.6.3: an owner row's code rides ITS STRAP (ownerChips above);
		// only rows WITHOUT a strap take the tab-above row label
		const host = row.querySelector(".extra-items-container.above");
		const root = host && host.shadowRoot;
		const chip = root ? root.querySelector('[part~="shelf-rowhint"]') : null;
		let geometry = null;
		if (chip) {
			const chipRect = chip.getBoundingClientRect();
			const rowRect = row.getBoundingClientRect();
			geometry = {
				insetEnd: Math.round(rowRect.right - chipRect.right),
				insetTop: Math.round(chipRect.top - rowRect.top),
				inside: chipRect.top >= rowRect.top - 2 && chipRect.bottom <= rowRect.bottom + 2,
				chipFont: getComputedStyle(chip).fontSize,
			};
		}
		labels.push({
			id: row.dataset.tabId,
			code: chip ? chip.getAttribute("data-hint") : null,
			text: chip ? chip.textContent : null,
			geometry,
			rid: row.id,
			rcls: String(row.className).split(" ").filter(Boolean).slice(-3).join(" "),
			// a stray/invisible element (the hidden members' leftovers, the
			// dummy tab) must not demand a label: the check keys on rows a
			// user could look at
			invisible: row.offsetHeight === 0 || row.classList.contains("hidden"),
		});
	}
	const topHost = document.querySelector("#tabbar-top .extra-items-container");
	const topRoot = topHost && topHost.shadowRoot;
	const catcherNode = topRoot && topRoot.querySelector('[part~="shelf-keycatcher"]');
	const catcherCss = catcherNode ? (() => {
		const cs = getComputedStyle(catcherNode);
		return cs.display + "/" + cs.visibility + "/" + cs.opacity;
	})() : null;
	const topItem = topRoot && topRoot.querySelector(".extra-item");
	const hostOf = topHost && topHost.closest("#tabbar-top");
	const hostCss = hostOf ? getComputedStyle(hostOf).display + "/" + getComputedStyle(hostOf).visibility : null;
	return JSON.stringify({
		catcher: !!catcherNode,
		catcherPart: catcherNode ? catcherNode.getAttribute("part") : null,
		catcherCss,
		catcherFocused: !!(topRoot && topRoot.activeElement &&
			(topRoot.activeElement.getAttribute("part") || "").includes("shelf-keycatcher")),
		idle: !!(topRoot && topRoot.querySelector(".shelf-strap-idle")),
		item: !!topItem,
		itemOwner: topItem ? topItem.dataset.owner : null,
		itemPart: topItem ? topItem.getAttribute("part") : null,
		topHostCss: hostCss,
		catcherFocused: !!(topRoot && topRoot.activeElement &&
			(topRoot.activeElement.getAttribute("part") || "").includes("shelf-keycatcher")),
		chips, labels, ownerChips,
	});
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

				check("the member with descendants carries the plus badge (always, folded or not)",
					iconC && iconC.badgeText == "+" && !(iconB && iconB.badgeText),
					() => `the member with descendants carries the plus badge ${JSON.stringify(iconC)}`);

				// badge mode: the option (storage.badgeMode) switches every
				// badge to the descendant count, live
				{
					const call = async message => {
						const response = await marionette.command("WebDriver:ExecuteScript", {
							script: shelfCallScript, args: [message,], newSandbox: false,
						}).catch(error => { console.log(`[drive] shelf call failed: ${error.message}`); return null; });
						return response && response.value ? JSON.parse(response.value) : null;
					};
					const strapIcons = async () => {
						const response = await marionette.command("WebDriver:ExecuteScript", {
							script: sidebarScript, args: [null,], newSandbox: false,
						}).catch(() => null);
						const d = response && response.value ? JSON.parse(response.value) : null;
						return d ? Object.fromEntries((d.icons || []).map(icon => [icon.id, icon])) : null;
					};
					let icons = null;
					await call({ type: "test:badge-mode", mode: "count", windowId, });
					for (let attempt = 0; attempt < 10; attempt++) {
						icons = await strapIcons();
						if (icons && icons[String(e.nestedOwner)] && icons[String(e.nestedOwner)].badgeText === "2") { break; }
						await new Promise(resolve => setTimeout(resolve, 800));
					}
					// C owns the nested shelf: c1 and c2 are its descendants
					check("count mode shows the descendant count in every fold badge",
						icons && icons[String(e.nestedOwner)] && icons[String(e.nestedOwner)].badgeText === "2",
						() => `count mode shows the descendant count ${JSON.stringify(icons && icons[String(e.nestedOwner)])}`);
					await call({ type: "test:badge-mode", mode: "plus", windowId, });
					for (let attempt = 0; attempt < 10; attempt++) {
						icons = await strapIcons();
						if (icons && icons[String(e.nestedOwner)] && icons[String(e.nestedOwner)].badgeText === "+") { break; }
						await new Promise(resolve => setTimeout(resolve, 800));
					}
					check("switching back restores the plus",
						icons && icons[String(e.nestedOwner)] && icons[String(e.nestedOwner)].badgeText === "+",
						() => `switching back restores the plus ${JSON.stringify(icons && icons[String(e.nestedOwner)])}`);
				}

				// audio indicator: the muted glyph appears on the muted
				// member (headless Firefox never reports audible — measured,
				// tests/probe-favicon.mjs), a primary click on the glyph
				// unmutes WITHOUT activating the tab
				{
					const call = async message => {
						const response = await marionette.command("WebDriver:ExecuteScript", {
							script: shelfCallScript, args: [message,], newSandbox: false,
						}).catch(error => { console.log(`[drive] shelf call failed: ${error.message}`); return null; });
						return response && response.value ? JSON.parse(response.value) : null;
					};
					const strapIcon = async id => {
						const response = await marionette.command("WebDriver:ExecuteScript", {
							script: sidebarScript, args: [null,], newSandbox: false,
						}).catch(() => null);
						const d = response && response.value ? JSON.parse(response.value) : null;
						return d ? (d.icons || []).find(icon => icon.id == String(id)) || null : null;
					};
					let icon = null;
					await call({ type: "test:mute", tabId: e.nestedOwner, muted: true, windowId, });
					for (let attempt = 0; attempt < 10; attempt++) {
						icon = await strapIcon(e.nestedOwner);
						if (icon && icon.sound === "muted") { break; }
						await new Promise(resolve => setTimeout(resolve, 800));
					}
					check("a muted shelf member shows the muted indicator (favicon untouched)",
						!!(icon && icon.sound === "muted" && icon.hasBg),
						() => `a muted shelf member shows the muted indicator ${JSON.stringify(icon)}`);
					// the click goes to the glyph (arguments[1] = "sound")
					await marionette.command("WebDriver:ExecuteScript", {
						script: sidebarScript, args: [e.nestedOwner, "sound",], newSandbox: false,
					}).catch(error => console.log(`[drive] glyph click failed: ${error.message}`));
					let iconAfter = null;
					const activeAfter = [];
					for (let attempt = 0; attempt < 10; attempt++) {
						await new Promise(resolve => setTimeout(resolve, 800));
						iconAfter = await strapIcon(e.nestedOwner);
						const stateResp = await marionette.command("WebDriver:ExecuteScript", {
							script: soundStateProbeScript, args: [windowId,], newSandbox: false,
						}).catch(e => ({ value: "MARIONETTE-ERR:" + e.message }));
						console.log(`[drive] sound state probe: ${stateResp && stateResp.value ? String(stateResp.value).slice(0, 600) : JSON.stringify(stateResp)}`);
						const state = stateResp && stateResp.value && String(stateResp.value).startsWith("OK:")
							? JSON.parse(String(stateResp.value).slice(3)) : null;
						if (iconAfter && iconAfter.sound === null) {
							console.log(`[drive] sound state keys: ${state ? Object.keys(state).join(",") : "null"} typeof shelves=${state && typeof state.shelves}`);
							activeAfter.push(state && state.active);
							break;
						}
					}
					check("clicking the indicator unmutes the member", !!(iconAfter && iconAfter.sound === null),
						() => `clicking the indicator unmutes the member ${JSON.stringify(iconAfter)}`);
					check("clicking the indicator does not activate the tab",
						activeAfter.length > 0 && !activeAfter[activeAfter.length - 1].includes(e.nestedOwner),
						() => `clicking the indicator does not activate the tab (active=${JSON.stringify(activeAfter[activeAfter.length - 1])}, tabId=${e.nestedOwner})`);
					// leave the member unmuted: the rest of the phases run on
					// an ordinary audible/mutable member set
					await call({ type: "test:mute", tabId: e.nestedOwner, muted: false, windowId, });
				}

				check("icons are native drag sources", iconB && iconB.draggable == "true", () => `icons are native drag sources ${iconB && iconB.draggable}`);

				check("favicons ride the style attribute through the sanitizer", iconB && iconB.hasBg, () => `favicons ride the style attribute through the sanitizer ${iconB && JSON.stringify(iconB)}`);

				check("the root shelf strap holds the shelved root tab", (dump.rootIcons || []).some(icon => icon.id == String(e.rootMember)), () => `the root shelf strap holds the shelved root tab ${JSON.stringify(dump.rootIcons)}`);

				// -- the container line (0.6.4): the row marker adopted on
				// the icons of shelved container tabs.  The setup phase
				// flipped the member through both containers (the UI's
				// own reopen-in-container path), so the line must carry
				// the SECOND container's id — live, at the strap's next
				// re-render, with no extension restart.
				{
					const icon = (dump.rootIcons || []).find(entry => entry.id == String(e.containerMember));
					const control = (dump.icons || []).find(entry => entry.id == String(e.controlMember))
						|| (dump.rootIcons || []).find(entry => entry.id == String(e.controlMember));
					check("a shelved container member's icon carries the container line", !!(icon && icon.marker && icon.marker.includes("var(--contextual-identity-color-")),
						() => `line=${JSON.stringify(icon && icon.marker)}`);
					check("the line paints from the live palette reference, not a copied value", !!(icon && icon.marker && /^[ ]*--shelf-marker: var\(/.test(icon.marker)),
						() => `line=${JSON.stringify(icon && icon.marker)}`);
					check("the line follows the container change (second container, not the first)",
						!!(icon && icon.marker && icon.marker.includes(`--contextual-identity-color-${e.containerStore},`)
							&& !icon.marker.includes(`--contextual-identity-color-${e.priorContainerStore},`)),
						() => `line=${JSON.stringify(icon && icon.marker)} prior=${e.priorContainerStore}`);
					check("a default-container member's icon shows no line", !!(control && control.marker == null),
						() => `control=${JSON.stringify(control && control.marker)}`);
					check("the registered stylesheet carries the marker rules", dump.hasMarkerRule === true,
						() => JSON.stringify({ themeStyle: dump.themeStyle, hasMarkerRule: dump.hasMarkerRule, }));
					check("the active theme's marker branch is registered",
						dump.themeStyle === "nova" ? dump.hasMarkerNova === true : dump.hasMarkerProton === true,
						() => JSON.stringify({ themeStyle: dump.themeStyle, proton: dump.hasMarkerProton, nova: dump.hasMarkerNova, }));
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

				// -- hint mode (tab-hints): the real chain, catcher to
				// activation.  Entry through the internal hook (the native
				// command is a trusted event), focus through TST's own
				// focus-to-extra-contents, keydowns dispatched on the
				// catcher like a focused user's, every verdict read back
				// through the state.  Phase 1 already covered the closed-
				// sidebar no-op.
				{
					const call = async message => {
						const response = await marionette.command("WebDriver:ExecuteScript", {
							script: shelfCallScript, args: [message,], newSandbox: false,
						}).catch(error => { console.log(`[drive] shelf call failed: ${error.message}`); return null; });
						return response && response.value ? JSON.parse(response.value) : null;
					};
					const dumpHints = async () => {
						const response = await marionette.command("WebDriver:ExecuteScript", {
							script: hintDumpScript, args: [], newSandbox: false,
						}).catch(error => { console.log(`[drive] hint dump failed: ${error.message}`); return null; });
						return response && response.value ? JSON.parse(response.value) : null;
					};
					const readState = async () => (await call({ type: "test:state", })) || null;
					const sendKeys = async text => {
						for (const character of String(text)) {
							await marionette.command("WebDriver:ExecuteScript", {
								script: keydownScript, args: [character,], newSandbox: false,
							}).catch(error => console.log(`[drive] keydown failed: ${error.message}`));
							await new Promise(resolve => setTimeout(resolve, 800));
						}
					};
					// Enter + confirm: the mode confirms on the first catcher
					// keydown (Firefox does not dispatch focus events for
					// shadow targets), so a neutral F5 follows the command.
					const enterConfirmed = async () => {
						const entered = await call({ type: "test:enter-hints", windowId, });
						await marionette.command("WebDriver:ExecuteScript", {
							script: keydownScript, args: ["F5",], newSandbox: false,
						}).catch(error => console.log(`[drive] confirm key failed: ${error.message}`));
						let state = null;
						for (let attempt = 0; attempt < 12; attempt++) {
							state = await readState();
							if (state && state.hints && state.hints.confirmed) { break; }
							await new Promise(resolve => setTimeout(resolve, 700));
						}
						return { entered, state, };
					};
					const focusProbeResp = await marionette.command("WebDriver:ExecuteScript", {
						script: focusProbeScript, args: [], newSandbox: false,
					}).catch(e => ({ value: "ERR:" + e.message }));
					console.log(`[drive] focus probe: ${focusProbeResp && focusProbeResp.value}`);
					{
						// the keydown probe: does TST's forwarder deliver a
						// synthetic keydown dispatched on the catcher?
						const keyProbeResp = await marionette.command("WebDriver:ExecuteScript", {
							script: keydownScript, args: ["z",], newSandbox: false,
						}).catch(e => ({ value: "ERR:" + e.message }));
						console.log(`[drive] keydown probe: ${keyProbeResp && keyProbeResp.value}`);
					}
					const registryResp = await marionette.command("WebDriver:ExecuteScript", {
						script: tstRegistryScript, args: [], newSandbox: false,
					}).catch(e => ({ value: "ERR:" + e.message }));
					console.log(`[drive] tst registry for tst-shelf: ${registryResp && registryResp.value}`);
					// real http pages in the fixture window: executeScript
					// can inject into http (MDN), never into the about:blank
					// fixture tabs — the pages the real catcher lands in, and
					// the exclusion's counterweight
					let hintTabs = null;
					{
						const response = await marionette.command("WebDriver:ExecuteScript", {
							script: mkHintTabsScript, args: [windowId, HINT_ORIGIN,], newSandbox: false,
						}).catch(error => { console.log(`[drive] hint tabs failed: ${error.message}`); return null; });
						hintTabs = response && response.value ? JSON.parse(response.value) : null;
						await new Promise(resolve => setTimeout(resolve, 2500));
					}
					// the DEFAULT options round: only the real http pages carry
					// codes (the fixture's about:blank tabs are excluded), the
					// active http page hosts the page catcher, and the
					// configured charset is the Vimium-safe default
					{
						const enteredDefault = await call({ type: "test:enter-hints", windowId, });
						const defaultState = await readState();
						const codedIds = new Set((defaultState && defaultState.hints && defaultState.hints.codes || [])
							.map(([id]) => Number(id)));
						const httpIds = new Set((hintTabs && hintTabs.all || []).map(Number));
						const onlyHttp = hintTabs && codedIds.size > 0
							&& [...codedIds].every(id => httpIds.has(id));
						check("the default options exclude special pages from hint codes (only the http tabs are coded)",
							!!(enteredDefault && enteredDefault.ok && onlyHttp
								&& defaultState.hintOptions
								&& defaultState.hintOptions.charset === "acqsew"
								&& defaultState.hintOptions.excludeSpecialPages === true),
							() => `entered=${JSON.stringify(enteredDefault)} coded=${JSON.stringify([...codedIds])} http=${JSON.stringify([...httpIds])} options=${JSON.stringify(defaultState && defaultState.hintOptions)}`);
						// the page catcher is armed inside the real http page
						let armedState = null;
						for (let attempt = 0; attempt < 12; attempt++) {
							const s = await readState();
							if (s && (s.bootlog || []).some(line => line.includes(`hints-arm tab ${hintTabs.a}`))) { armedState = s; break; }
							await new Promise(resolve => setTimeout(resolve, 700));
						}
						check("the page catcher is armed inside the real http page", !!armedState,
							() => "no hints-arm line in the bootlog");
						// a keydown dispatched INSIDE that page reaches the
						// mode through the production catcher — the http tabs'
						// single-letter codes make it an activation
						const httpCode = (defaultState && defaultState.hints && defaultState.hints.codes || [])
							.find(([id]) => Number(id) == hintTabs.a);
						const pageKey = await call({ type: "test:page-key", tabId: hintTabs.a, key: (httpCode || [0, "a"])[1], });
						let afterPageKey = null;
						for (let attempt = 0; attempt < 10; attempt++) {
							afterPageKey = await readState();
							if (afterPageKey && (!afterPageKey.hints || afterPageKey.hints.confirmed)) { break; }
							await new Promise(resolve => setTimeout(resolve, 700));
						}
						check("a keydown inside the armed page reaches the mode through the real catcher",
							!!(pageKey && pageKey.ok && afterPageKey && afterPageKey.hints == null),
							() => `pageKey=${JSON.stringify(pageKey)} code=${JSON.stringify(httpCode)} hints=${JSON.stringify(afterPageKey && afterPageKey.hints)}`);
					}
					// the exclusion flip: the full fixture participates from
					// here on (the chips/labels/narrowing/activation blocks
					// need the fixture's codes)
					{
						await call({ type: "test:set-hint-options", excludeSpecialPages: false, });
						let flipped = null;
						for (let attempt = 0; attempt < 10; attempt++) {
							flipped = await readState();
							if (flipped && flipped.hintOptions && flipped.hintOptions.excludeSpecialPages === false) { break; }
							await new Promise(resolve => setTimeout(resolve, 600));
						}
						check("the exclusion option flips live (special pages join the code set)",
							!!(flipped && flipped.hintOptions && flipped.hintOptions.excludeSpecialPages === false),
							() => `options=${JSON.stringify(flipped && flipped.hintOptions)}`);
					}
					const { entered, state: confirmedState, } = await enterConfirmed();
					console.log("[drive] main entry diagnostics:", JSON.stringify({
						entered: entered && { ok: entered.ok, reason: entered.reason, codes: (entered.codes || []).slice(0, 12), },
						renderedOfMode: confirmedState && confirmedState.hints && confirmedState.hints.rendered,
						hintOptions: confirmedState && confirmedState.hintOptions,
					}));
					if (!confirmedState || !confirmedState.hints || !confirmedState.hints.confirmed) {
						const diagDump = await dumpHints();
						const diagBoot = await readState();
						check("hint mode confirms through the catcher's focus (tab-hosted sidebar)", false,
							() => `entered=${JSON.stringify(entered)} state=${JSON.stringify(confirmedState && confirmedState.hints)} dom=${JSON.stringify(diagDump)} boot=${JSON.stringify(diagBoot && diagBoot.bootlog)} diag=${JSON.stringify(diagBoot && diagBoot.diagLog && diagBoot.diagLog.slice(-30))}`);
					}
					else {
						check("hint mode confirms through the catcher's focus (tab-hosted sidebar)", true);
						const modeDump = await dumpHints();
						check("the key catcher exists and is the focused element", !!(modeDump && modeDump.catcher && modeDump.catcherFocused),
							() => `catcher=${JSON.stringify(modeDump && { catcher: modeDump.catcher, focused: modeDump.catcherFocused })}`);
						{
							const state = confirmedState;
							const codes = new Map(state.hints.codes);
							const chipsOk = (modeDump.chips || []).every(chip => codes.get(Number(chip.id)) == chip.code);
							check("every shelf icon carries its own code chip", chipsOk,
								() => `chips=${JSON.stringify((modeDump.chips || []).slice(0, 8))} codes=${JSON.stringify([...codes.entries()].slice(0, 8))}`);
							// the paints, against the wanted set: TST never
							// answers extra-contents writes (each case in
							// tst-api-frontend.js ends with a bare `return`),
							// so the renderer's settled-ledger count lags the
							// DOM arbitrarily; the DOM is the oracle.  Poll to
							// stability: the confirm-time relabel and the
							// tabs-rendered relabel both ride later beats.
							// A SHELVED tab's code labels its ICON, never its
							// row — a revealed member's row must stay bare.
							const shelvedIds = new Set((confirmedState.shelved || []).map(Number));
							let labelDump = modeDump;
							let labelDiag = null;
							let badRows = [];
							for (let attempt = 0; attempt < 10; attempt++) {
								// an OWNER row's code rides ITS STRAP (0.6.3), so
								// the row's agreed text comes from the owner chip
								// when one exists, else from the tab-above label
								const ownerBy = new Map((labelDump && labelDump.ownerChips || [])
									.map(chip => [Number(chip.id), chip]));
								badRows = (labelDump && labelDump.labels || [])
									.filter(entry => !entry.invisible && !shelvedIds.has(Number(entry.id)))
									.map(entry => {
										const code = codes.get(Number(entry.id)) || "";
										const ownerChip = ownerBy.get(Number(entry.id));
										const text = ownerChip ? (ownerChip.text || "") : (entry.text || "");
										return text !== code ? [entry.id, text, code] : null;
									})
									.filter(Boolean);
								if (!badRows.length) { break; }
								await new Promise(resolve => setTimeout(resolve, 1300));
								labelDump = await dumpHints();
								labelDiag = await readState();
							}
							check("every rendered row carries its code label (DOM agrees with the wanted codes)", badRows.length === 0,
								() => `mismatched=${JSON.stringify(badRows.slice(0, 6))} first4=${JSON.stringify((labelDump && labelDump.labels || []).slice(0, 4))} owners=${JSON.stringify(labelDump && labelDump.ownerChips)} diag=${JSON.stringify(labelDiag && labelDiag.diagLog && labelDiag.diagLog.slice(-10))}`);
						}
						// the 0.6.0 coverage contract: codes exist ONLY for
						// painted surfaces — every coded ROW id must be one
						// TST rendered (the tabs-rendered ledger); a coded
						// id the ledger does not know is a code for a tab
						// the user cannot see (the mistype-into-the-unseen
						// defect this round removes)
						{
							const codesHere = new Map(confirmedState.hints.codes);
							const shelvedHere = new Set((confirmedState.shelved || []).map(Number));
							const codedRowIds = [...codesHere.keys()].filter(id => !shelvedHere.has(id));
							const renderedNow = confirmedState.hints.rendered;
							// rendered truth from the mode's own query: with
							// a live viewport the coded rows must be a subset
							// of it; the null case (no copy answered — the
							// fold-cut fallback) is unit-tested, not E2E'd
							const unseen = renderedNow
								? codedRowIds.filter(id => !renderedNow.includes(id)) : [];
							check("codes are assigned only to painted surfaces (no code for an unrendered row)",
								unseen.length === 0,
								() => `unseen=${JSON.stringify(unseen)} rendered=${JSON.stringify(renderedNow)} codedRows=${JSON.stringify(codedRowIds)}`);
						}
						// the 0.6.2 CONVERSE (the check 0.6.0 lacked): every
						// rendered row must be coded too — TST's rendered
						// query without tab:'*' returned ROOT tabs only, so
						// nested rows silently dropped out of the coded set
						// while every other gate stayed green (superset
						// checks pass vacuously when rows go missing).  The
						// witness is the hint fixture's NESTED http tab (the
						// second tab, created as the first tab's opener
						// child): a rendered row at depth 1.  (The fixture's
						// own plain row D cannot witness this — the 0.2.1
						// reveal checks leave its owner folded, so D is
						// unrendered at this point by design.)  The mode
						// must report the child in its rendered set, code
						// it, and paint its label.
						{
							const codesHere2 = new Map(confirmedState.hints.codes);
							const nestedId = hintTabs && hintTabs.child;
							const nestedRendered = !!(nestedId != null
								&& confirmedState.hints.rendered
								&& confirmedState.hints.rendered.includes(Number(nestedId)));
							const nestedCode = nestedId != null ? codesHere2.get(Number(nestedId)) : null;
							let nestedLabel = null;
							for (let attempt = 0; attempt < 8; attempt++) {
								const fresh = await dumpHints();
								nestedLabel = (fresh && fresh.labels || [])
									.find(entry => Number(entry.id) === Number(nestedId) && !entry.invisible);
								if (nestedLabel && nestedLabel.text == nestedCode) { break; }
								await new Promise(resolve => setTimeout(resolve, 700));
							}
							check("every rendered row carries a code: the NESTED rendered http tab is reported, coded and labeled",
								!!nestedCode && nestedRendered && !!nestedLabel && nestedLabel.text == nestedCode,
								() => `nested=${nestedId} code=${nestedCode} rendered=${JSON.stringify(confirmedState.hints.rendered)} label=${JSON.stringify(nestedLabel)} firstCodes=${JSON.stringify([...codesHere2.entries()].slice(0, 12))}`);
						}
						// narrowing: a letter that begins several codes keeps
						// only those labels — deterministic, because the
						// visible set outnumbers the alphabet
						{
							const stateBefore = await readState();
							const freshDump = (await dumpHints()) || {};
							const labelBefore = new Map((freshDump.labels || [])
								.map(entry => [Number(entry.id), entry.text]));
							// the most loaded letter: the visible set outnumbers
							// the alphabet, so some letter begins several codes
							const counts = {};
							for (const [, code] of stateBefore.hints.codes) {
								counts[code[0]] = (counts[code[0]] || 0) + 1;
							}
							const [letter, expected] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
							await sendKeys(letter);
							let narrowed = null;
							for (let attempt = 0; attempt < 10; attempt++) {
								const candidate = await dumpHints();
								const buffered = await readState();
								if (buffered && buffered.hints && buffered.hints.buffer === letter) { narrowed = candidate; break; }
								await new Promise(resolve => setTimeout(resolve, 700));
							}
							const kept = narrowed
								? (narrowed.labels || []).filter(entry => entry.text).length : -1;
							const matchingRow = [...labelBefore.entries()].find(([id]) =>
								(narrowed && narrowed.labels || []).some(entry => Number(entry.id) === id && entry.text));
							const afterState = await readState();
							check(`a typed prefix keeps only the still-matching labels (letter ${letter}: ${expected} codes, ${kept} kept)`,
								!!narrowed && kept > 0 && kept < labelBefore.size && stateBefore.hints.buffer === "",
								() => `kept=${kept} labelsBefore=${labelBefore.size} hints=${JSON.stringify(afterState && afterState.hints)} letter=${letter}`);
							// one concrete label pair: a matching row keeps its
							// code, a non-matching row's label is gone
							{
								const stillKept = (narrowed && narrowed.labels || []).find(entry => entry.text && (narrowed.labels || []).length && entry.text.startsWith(letter));
								const goneOnes = (narrowed && narrowed.labels || []).filter(entry => !entry.text && labelBefore.get(Number(entry.id))).length;
								check("the narrowed labels vanish and the matching ones stay",
									!!stillKept && goneOnes > 0,
									() => `kept row=${JSON.stringify(stillKept)} vanished=${goneOnes}`);
							}
							// the STRAP CHIPS narrow with the rows (the 0.4.0
							// defect: the icon chips kept every code while the
							// row labels narrowed, and the two surfaces
							// disagreed mid-mode — "hints disappear at random");
							// the OWNER chips narrow with the same diff (0.6.3)
							{
								const paintedChips = (narrowed && narrowed.chips || []).filter(chip => chip.code);
								const paintedOwners = (narrowed && narrowed.ownerChips || []).filter(chip => chip.code);
								const offPrefix = paintedChips.filter(chip => !(chip.code || "").startsWith(letter));
								const offPrefixOwners = paintedOwners.filter(chip => !(chip.code || "").startsWith(letter));
								check("the icon chips (and the owner chips with them) narrow with the typed prefix",
									paintedChips.length > 0 && offPrefix.length === 0 && offPrefixOwners.length === 0,
									() => `chips=${JSON.stringify(paintedChips.slice(0, 8))} owners=${JSON.stringify(paintedOwners.slice(0, 4))} letter=${letter} off=${JSON.stringify(offPrefix.slice(0, 4))} offOwners=${JSON.stringify(offPrefixOwners.slice(0, 4))}`);
							}
							// the row chip's 0.6.3 geometry: plain rows' chips at
							// the row's inline-end corner (the 0.5.0/0.6.2
							// placement, vertically aligned with the shelves'
							// rightmost icon chips); owner rows' chips — part
							// shelf-owner-hint — ride their straps: same line as
							// the member chips, one strap-gap left of the
							// leftmost icon, inside the row
							{
								const withGeometry = (narrowed && narrowed.labels || [])
									.filter(entry => entry.geometry);
								const misplaced = withGeometry.filter(entry =>
									entry.geometry.insetEnd < 0 || !entry.geometry.inside);
								const fonts = [...new Set(withGeometry.map(entry => entry.geometry.chipFont))];
								check(`plain-row chips sit at the row's inline-end corner (fonts=${JSON.stringify(fonts)} insetEnd=${JSON.stringify(withGeometry.map(entry => entry.geometry.insetEnd))})`,
									withGeometry.length > 0 && misplaced.length === 0,
									() => `misplaced=${JSON.stringify(misplaced.slice(0, 5).map(entry => [entry.id, entry.geometry]))}`);
								const ownerChips = (narrowed && narrowed.ownerChips || []).filter(chip => chip.code);
								const badOwners = ownerChips.filter(chip =>
									chip.leftOfLeftmost !== true || !chip.inRow
									|| chip.lineCenter == null || Math.abs(chip.lineCenter) > 2
									|| chip.cellGap == null || chip.cellGap < 1 || chip.cellGap > 6
									|| chip.chipFont !== fonts[0]);
								check(`an owner's chip rides its strap: same line as the member cells, left of the leftmost icon, one strap-gap away (${ownerChips.length} owner chip(s): ${JSON.stringify(ownerChips.map(chip => [chip.id, chip.cellGap, chip.lineCenter, chip.chipFont]))})`,
									ownerChips.length > 0 && badOwners.length === 0,
									() => `bad=${JSON.stringify(badOwners.slice(0, 4))}`);
							}
							// the uniform-row law holds while labels paint
							{
								const geometry = await marionette.command("WebDriver:ExecuteScript", {
									script: conformanceScript, args: [], newSandbox: false,
								}).catch(error => { console.log(`[drive] labeled conformance failed: ${error.message}`); return null; });
								const g = geometry && geometry.value ? JSON.parse(geometry.value) : null;
								check("the uniform-row conformance gate stays green while labels paint (rows stay at TST's computed positions)",
									g && g.rows >= 2 && g.drift.length == 0 && g.rowH > 20 && g.anchor <= 1.5,
									() => JSON.stringify(g));
							}
							// Backspace pops the letter: every label is back
							await marionette.command("WebDriver:ExecuteScript", {
								script: keydownScript, args: ["Backspace",], newSandbox: false,
							}).catch(error => console.log(`[drive] backspace failed: ${error.message}`));
							// poll to stability: TST's virtual scroll legitimately
							// unrenders/re-renders rows between reads, so the
							// pre-typing count can differ from the CURRENT
							// viewport; the exact contract is "every row present
							// in the dump that carries a code shows its code"
							let restored = null;
							const shelvedState2 = await readState();
							const shelvedSet = new Set((shelvedState2 && shelvedState2.shelved || []).map(Number));
							for (let attempt = 0; attempt < 12; attempt++) {
								await new Promise(resolve => setTimeout(resolve, 800));
								restored = await dumpHints();
								const stable = await readState();
								const ownerBy2 = new Map((restored && restored.ownerChips || [])
									.map(chip => [Number(chip.id), chip]));
								const mismatches = [];
								for (const entry of (restored && restored.labels) || []) {
									if (entry.invisible || shelvedSet.has(Number(entry.id))) { continue; }
									const code = stable && stable.hints
										? (stable.hints.codes || []).find(([tabId]) => tabId == Number(entry.id))
										: null;
									const ownerChip = ownerBy2.get(Number(entry.id));
									const text = ownerChip ? (ownerChip.text || "") : (entry.text || "");
									if (text !== ((code || [])[1] || "")) { mismatches.push(Number(entry.id)); }
								}
								if (!mismatches.length) { break; }
								if (attempt == 11) {
									restored = restored || { labels: [], };
									restored.__mismatches = mismatches;
									break;
								}
							}
							const stateAtRest = await readState();
							check("Backspace restores every label of the visible set",
								restored && restored.__mismatches === undefined,
								() => `mismatch=${JSON.stringify((restored && restored.__mismatches) || []).slice(0, 8)} ledger=${stateAtRest && stateAtRest.rowLedger}`);
						}
						// Escape exits and blanks every label
						{
							const escapeResp = await marionette.command("WebDriver:ExecuteScript", {
								script: keydownScript, args: ["Escape",], newSandbox: false,
							}).catch(error => ({ value: "ERR:" + error.message }));
							console.log(`[drive] escape dispatched: ${escapeResp && escapeResp.value}`);
							const escapeArrival = await readState();
							console.log(`[drive] escape arrival diag: ${JSON.stringify(escapeArrival && escapeArrival.diagLog.slice(-5))} hints=${JSON.stringify(escapeArrival && escapeArrival.hints)} ledger=${escapeArrival && escapeArrival.rowLedger}`);
							// poll the acknowledge ledger first (the hint state
							// export dies with the mode): the exit is complete
							// when no acknowledged label remains anywhere
							let ledgerState = null;
							for (let attempt = 0; attempt < 12; attempt++) {
								await new Promise(resolve => setTimeout(resolve, 700));
								ledgerState = await readState();
								if (ledgerState && !ledgerState.hints && ledgerState.rowLedger === 0) { break; }
							}
							// then the paints: poll the DOM to stability — the
							// chip diffs and label clears ride the settled
							// sends, and TST re-renders can replay caches in
							// between
							let afterEscape = null;
							let escDiag = null;
							for (let attempt = 0; attempt < 10; attempt++) {
								afterEscape = await dumpHints();
								const dirty = (afterEscape && afterEscape.chips || []).some(chip => chip.code)
									|| (afterEscape && afterEscape.labels || []).some(entry => entry.text)
									|| (afterEscape && afterEscape.ownerChips || []).some(chip => chip.code);
								if (!dirty) { break; }
								await new Promise(resolve => setTimeout(resolve, 1100));
							}
							const afterState = await readState();
							escDiag = afterState;
							check("Escape exits the mode and leaves no label behind",
								afterEscape && !(afterEscape.chips || []).some(chip => chip.code)
									&& !(afterEscape.labels || []).some(entry => entry.text)
									&& !(afterEscape.ownerChips || []).some(chip => chip.code)
									&& afterState && !afterState.hints && afterState.rowLedger === 0,
								() => `afterEscape=${JSON.stringify(afterEscape && {
									chips: (afterEscape.chips || []).filter(chip => chip.code).length,
									labels: (afterEscape.labels || []).filter(entry => entry.text).length,
									owners: (afterEscape.ownerChips || []).filter(chip => chip.code).length,
								})} ledger=${afterState && afterState.rowLedger} inFlight=${afterState && afterState.rowInFlight} rowTrace=${JSON.stringify(escDiag && escDiag.rowTrace && escDiag.rowTrace.slice(-40))} keys=${JSON.stringify(escDiag && escDiag.rowKeys)} hintLog=${JSON.stringify(escDiag && escDiag.hintLog && escDiag.hintLog.slice(-14))} diag=${JSON.stringify(escDiag && escDiag.diagLog && escDiag.diagLog.slice(-25))}`);
						}
						// typing a ROW tab's full code activates it
						{
							await enterConfirmed();
							let ready = null;
							for (let attempt = 0; attempt < 12; attempt++) {
								ready = await readState();
								if (ready && ready.hints && ready.hints.confirmed) { break; }
								await new Promise(resolve => setTimeout(resolve, 800));
							}
							const codeOf = id => (String(ready.hints.codes).length && (ready.hints.codes || []).find(([tabId]) => tabId == id) || [])[1];
							// D is folded away at this point (the 0.2.1 reveal
							// checks leave A folded), so a coded NON-shelved
							// row tab — one of the http fixture tabs — proves
							// the same thing; the converse check above covers
							// the nested-row coverage separately
							const codedPlain = codeOf(e.plain)
								|| ((ready.hints.codes || []).find(([tabId]) =>
										!(ready.shelved || []).includes(String(tabId)) && !(ready.shelved || []).includes(tabId)) || [])[1];
							const plainCode = codedPlain;
							const plainTab = plainCode
								&& ((ready.hints.codes || []).find(([, code]) => code === plainCode) || [])[0];
							check("the row tab's code is assignable (fixture sanity)", !!plainCode, `plain code=${plainCode} tab=${plainTab} codes=${JSON.stringify(ready && ready.hints && ready.hints.codes)}`);
							await sendKeys(plainCode || "");
							let activated = null;
							for (let attempt = 0; attempt < 12; attempt++) {
								const status = await readState();
								if (status && status.shelves[windowId].active.includes(plainTab)) { activated = status; break; }
								await new Promise(resolve => setTimeout(resolve, 800));
							}
							check(`typing a row tab's code (${plainCode}) activates that tab`,
								!!activated, () => `active=${JSON.stringify(activated && activated.shelves[windowId].active)} hints=${JSON.stringify(activated && activated.hints)}`);
							if (activated) {
								check("the finished code ends the mode", !activated.hints,
									() => `hints=${JSON.stringify(activated.hints)}`);
							}
							await marionette.command("WebDriver:ExecuteScript", {
								script: activateScript, args: [e.rootMember,], newSandbox: false,
							}).catch(error => console.log(`[drive] reset activation failed: ${error.message}`));
							await new Promise(resolve => setTimeout(resolve, 1500));
						}
						// typing a SHELVED member's code runs the icon-click
						// choreography: selection, fold swap, reveal rules
						{
							// the previous block's activation left a special
							// page (an about:blank fixture tab) active — the
							// decline rule's exact case again
							await marionette.command("WebDriver:ExecuteScript", {
								script: activateTabScript, args: [hintTabs.a,], newSandbox: false,
							}).catch(error => console.log(`[drive] member anchor failed: ${error.message}`));
							await new Promise(resolve => setTimeout(resolve, 1200));
							const { state: shelvedState, } = await enterConfirmed();
							let ready = shelvedState;
							const codeOfHere = (state, id) =>
								(((state && state.hints && state.hints.codes) || []).find(([tabId]) => tabId == id) || [])[1];
							const shelvedSet = ((ready && ready.shelved) || []).map(Number);
							const codedMember = ((ready && ready.hints && ready.hints.codes) || []).find(([tabId]) =>
								codeOfHere(ready, tabId) && (tabId == e.clickFirst || shelvedSet.includes(Number(tabId))));
							const memberCode = codedMember ? codedMember[1] : null;
							const memberTab = codedMember ? Number(codedMember[0]) : null;
							check("the shelved member's code is assignable (fixture sanity)", !!memberCode, `member code=${memberCode} tab=${memberTab} codes=${JSON.stringify(ready && ready.hints && ready.hints.codes)} ledger=${JSON.stringify(ready && ready.renderedTabs)}`);
							await sendKeys(memberCode || "");
							let memberState = null;
							for (let attempt = 0; attempt < 12; attempt++) {
								memberState = await readState();
								if (memberState && memberState.shelves[windowId].active.includes(memberTab)) { break; }
								await new Promise(resolve => setTimeout(resolve, 800));
							}
							const liveMember = memberState && memberState.shelves[windowId].active.includes(memberTab);
							check(`typing a shelved member's code (${memberCode}) activates it through the selection choreography`, !!liveMember,
								() => `active=${JSON.stringify(memberState && memberState.shelves[windowId].active)} hints=${JSON.stringify(memberState && memberState.hints)}`);
							// the subtree unfolds with the selection (the fold
							// swap ran; c1 stays row-less as a nested member,
							// c2 is a plain child and comes back)
							const treeResponse = await marionette.command("WebDriver:ExecuteScript", {
								script: treeStateScript, args: [memberTab,], newSandbox: false,
							}).catch(() => null);
							const unfoldedAfter = treeResponse && treeResponse.value ? JSON.parse(treeResponse.value) : null;
							const rowsAfter = await marionette.command("WebDriver:ExecuteScript", {
								script: rowPresenceScript, args: [memberTab == e.clickFirst
									? [e.clickFirst, e.children[1], e.children[0],]
									: [memberTab,],], newSandbox: false,
							}).catch(() => null);
							const rows = rowsAfter && rowsAfter.value ? JSON.parse(rowsAfter.value) : null;
							if (memberTab == e.clickFirst) {
								check("the typed member's subtree unfolds like a clicked icon",
									unfoldedAfter && !(unfoldedAfter.states || []).includes("subtree-collapsed"),
									() => JSON.stringify(unfoldedAfter));
								check("the activated member has its row back and its plain child below the shelf",
									rows && rows[e.clickFirst] && rows[e.children[1]] && !rows[e.children[0]],
									() => `rows=${JSON.stringify(rows)}`);
							}
							else {
								// the fallback member is often the childless root-shelf
								// tab: the with-children scenario rides on C above, so
								// for a childless member assert only what it owes —
								// its own row is back after the activation's fold swap
								check("the typed childless member's row is back after the fold swap", !!rows && !!rows[memberTab],
									() => `rows=${JSON.stringify(rows)} tab=${memberTab} tree=${JSON.stringify(unfoldedAfter)}`);
							}
							// restore the resting state for phase 3: C folded, E active
							await call({ type: "test:collapse", tabId: e.clickFirst, windowId, collapsed: true, });
							await marionette.command("WebDriver:ExecuteScript", {
								script: activateScript, args: [e.rootMember,], newSandbox: false,
							}).catch(error => console.log(`[drive] final reset failed: ${error.message}`));
							await new Promise(resolve => setTimeout(resolve, 2000));
							let settled = null;
							let refolded = null;
							let refoldedRaw = null;
							for (let attempt = 0; attempt < 8; attempt++) {
								await new Promise(resolve => setTimeout(resolve, 900));
								settled = await readState();
								const refoldedResponse = await marionette.command("WebDriver:ExecuteScript", {
									script: treeStateScript, args: [e.clickFirst,], newSandbox: false,
								}).catch(() => null);
								refoldedRaw = refoldedResponse && refoldedResponse.value;
								refolded = refoldedRaw ? JSON.parse(refoldedRaw) : null;
								if (settled && settled.hints == null && refolded && (refolded.states || []).includes("subtree-collapsed")) { break; }
							}
							check("after the hint block the shelf state is restored for phase 3",
								settled && settled.hints == null && refolded && (refolded.states || []).includes("subtree-collapsed"),
								() => `hints=${JSON.stringify(settled && settled.hints)} states=${JSON.stringify(refolded && refolded.states)}`);
						}
						// the CONFIGURED charset: codes built from its letters
						// alone (the options field, live through onChanged)
						{
							// the previous block activated a SHELVED member —
							// a special page (about:blank) and the mode's
							// decline rule's exact case: hand the anchor back
							// to an injectable page before entering again
							await marionette.command("WebDriver:ExecuteScript", {
								script: activateTabScript, args: [hintTabs.a,], newSandbox: false,
							}).catch(error => console.log(`[drive] anchor activation failed: ${error.message}`));
							await new Promise(resolve => setTimeout(resolve, 1200));
							await call({ type: "test:set-hint-options", charset: "ac", });
							let applied = null;
							for (let attempt = 0; attempt < 10; attempt++) {
								applied = await readState();
								if (applied && applied.hintOptions && applied.hintOptions.charset === "ac") { break; }
								await new Promise(resolve => setTimeout(resolve, 600));
							}
							const { state: charsetState, } = await enterConfirmed();
							const charsetCodes = (charsetState && charsetState.hints && charsetState.hints.codes) || [];
							const offCharset = charsetCodes.filter(([, code]) => ![...code].every(ch => "ac".includes(ch)));
							check("a configured charset (ac) builds every code from its own letters",
								charsetCodes.length > 5 && offCharset.length === 0
									&& !!(applied && applied.hintOptions && applied.hintOptions.charset === "ac"),
								() => `applied=${JSON.stringify(applied && applied.hintOptions)} codes=${JSON.stringify(charsetCodes.slice(0, 6))} off=${JSON.stringify(offCharset.slice(0, 4))}`);
							await call({ type: "test:exit-hints", reason: "charset-done", });
							// restore the defaults: phase 3 enters with the
							// production options in force
							await call({ type: "test:set-hint-options", charset: "", excludeSpecialPages: true, });
							for (let attempt = 0; attempt < 10; attempt++) {
								const restored = await readState();
								if (restored && restored.hintOptions && restored.hintOptions.charset === "acqsew"
									&& restored.hintOptions.excludeSpecialPages === true) { break; }
								await new Promise(resolve => setTimeout(resolve, 600));
							}
						}
						// the CONFIGURED chip size: the option
						// (storage.hintFontSize) applies LIVE.  The size stays
						// inside the registered style string (no element of
						// ours inside the rows could carry it into TST's
						// shadow parts), so the background re-runs
						// register-self and TST's installStyle REPLACES the
						// style text in the live sidebar — the labels already
						// on screen restyle mid-mode, no re-entry needed.
						{
							// the charset round exited onto a mode whose anchor
							// may be a special page: hand the anchor back first
							await marionette.command("WebDriver:ExecuteScript", {
								script: activateTabScript, args: [hintTabs.a,], newSandbox: false,
							}).catch(error => console.log(`[drive] anchor activation failed: ${error.message}`));
							await new Promise(resolve => setTimeout(resolve, 1200));
							await call({ type: "test:set-hint-options", fontSize: 16, });
							let applied = null;
							for (let attempt = 0; attempt < 10; attempt++) {
								applied = await readState();
								if (applied && applied.hintOptions && applied.hintOptions.fontSize === 16) { break; }
								await new Promise(resolve => setTimeout(resolve, 600));
							}
							const { state: sizeState, } = await enterConfirmed();
							let sized = null;
							let lastDump = null;
							for (let attempt = 0; attempt < 10; attempt++) {
								const fresh = await dumpHints();
								lastDump = fresh;
								const labeled = (fresh && fresh.labels || []).filter(entry => entry.text);
								const chipFonts = (fresh && fresh.chips || []).filter(chip => chip.code).map(chip => chip.chipFont);
								const ownerFonts = (fresh && fresh.ownerChips || []).filter(chip => chip.code).map(chip => chip.chipFont);
								// the icon-chip and owner-chip clauses are
								// conditional: this late in the run the fixture's
								// coded set can be rows only (the about:blank
								// members and the about:blank owner are excluded
								// with the production options), so zero icon or
								// owner chips is fine
								if (labeled.length
									&& labeled.every(entry => entry.geometry && entry.geometry.chipFont === "16px")
									&& (chipFonts.length === 0 || chipFonts.every(font => font === "16px"))
									&& (ownerFonts.length === 0 || ownerFonts.every(font => font === "16px"))) { sized = fresh; break; }
								await new Promise(resolve => setTimeout(resolve, 700));
							}
							check("a configured chip size (16px) reaches row chips AND icon chips",
								!!(applied && applied.hintOptions && applied.hintOptions.fontSize === 16) && !!sized,
								() => `applied=${JSON.stringify(applied && { hintOptions: applied.hintOptions, bootlog: applied.bootlog, })} lastFonts=${JSON.stringify(lastDump && lastDump.labels.filter(entry => entry.text).slice(0, 4).map(entry => entry.geometry && entry.geometry.chipFont))}`);
							// mid-mode flip: the chips already painted must
							// restyle at once (the re-register swaps the live
							// style text; no re-entry, no rewrite)
							await call({ type: "test:set-hint-options", fontSize: 12, });
							let flipped = null;
							for (let attempt = 0; attempt < 12; attempt++) {
								await new Promise(resolve => setTimeout(resolve, 800));
								const fresh = await dumpHints();
								const labeled = (fresh && fresh.labels || []).filter(entry => entry.text);
								const ownerFonts = (fresh && fresh.ownerChips || []).filter(chip => chip.code).map(chip => chip.chipFont);
								if (labeled.length
									&& labeled.every(entry => entry.geometry && entry.geometry.chipFont === "12px")
									&& (fresh.chips || []).filter(chip => chip.code).every(chip => chip.chipFont === "12px")
									&& (ownerFonts.length === 0 || ownerFonts.every(font => font === "12px"))) { flipped = fresh; break; }
							}
							const midState = await readState();
							check("flipping the size mid-mode restyles the painted chips without re-entry",
								!!flipped && !!(midState && midState.hints),
								() => `mid=${JSON.stringify(midState && midState.hints)} fonts=${JSON.stringify(flipped && (flipped.labels || []).filter(entry => entry.text).slice(0, 3).map(entry => entry.geometry && entry.geometry.chipFont))}`);
							await call({ type: "test:exit-hints", reason: "fontsize-done", });
						}
					}
				}
			}
		}
	}
}

/** The synthetic drag lifecycle, dispatched through TST's REAL sidebar
 *  handlers (document-level mousedown/dragstart/dragover/drop/dragend in
 *  sidebar/mouse-event-listener.js and sidebar/drag-and-drop.js) inside
 *  the tab-hosted sidebar page.  A trusted OS drag cannot be produced
 *  through Marionette (Firefox does not synthesize HTML5 drag sessions
 *  from synthetic input, measured), so this DataTransfer-carrying chain
 *  is the headless characterization; ONE trusted GUI drag per scenario
 *  remains an explicit manual check (task 1.2).
 *
 *  arguments: [sourceId, sourceKind, targetId, dropMode, probeIds]
 *    sourceId/sourceKind — the pressed tab row or shelf icon
 *    targetId/dropMode   — the drop row + one of:
 *      "center" — the row's middle half => kDROP_ON_SELF (attach child)
 *      "after"  — the row's bottom quarter => kDROP_AFTER (next sibling)
 *      "cancel" — no drop at all; dragend without drop
 *    probeIds            — row ids whose DOM presence is recorded at
 *                          each step (the mid-drag visibility oracle)
 *
 *  Between the events the script reads BOTH truths: the shelf's own
 *  test:state (drag-hold phases, hiddenByUs, suppressedHiddenByUs) over
 *  the cross-extension runtime channel, and the sidebar's DOM rows.
 *  The steps carry timestamps so the run can be ordered against the
 *  background diag ring. */
const dragSequenceScript = String.raw`
	const [sourceId, sourceKind, targetId, dropMode, probeIds] = arguments;
	const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
	const byId = id => document.querySelector('tab-item[data-tab-id="' + id + '"]');
	const iconOf = id => {
		for (const host of document.querySelectorAll("#tabbar-top .extra-items-container, tab-item .extra-items-container.below")) {
			const root = host.shadowRoot;
			const icon = root && root.querySelector('[part~="shelf-icon"][data-tab-id="' + id + '"]');
			if (icon) { return icon; }
		}
		return null;
	};
	const source = sourceKind === "icon" ? iconOf(sourceId) : byId(sourceId);
	if (!source) { throw new Error("no drag source " + sourceId + " (" + sourceKind + ")"); }
	const target = dropMode === "cancel" ? null : byId(targetId);
	if (dropMode !== "cancel" && !target) { throw new Error("no drop target " + targetId); }
	// TST's getItemFromDOMNode resolves tree items through the
	// tab-item-substance element; a press dispatched on the tab-item HOST
	// reads as a tabbar-mousedown instead of a tab one (measured: no
	// tab-mousedown broadcast at all), so rows are pressed on the substance
	const pressTarget = element => element.tagName.toLowerCase() === "tab-item"
		? (element.querySelector("tab-item-substance") || element)
		: element;
	const state = async (note) => {
		try {
			const raw = await browser.runtime.sendMessage("tst-shelf@example.com", { type: "test:state", });
			const holds = raw && raw.dragHolds || {};
			const hold = holds[Object.keys(holds)[0]] || null;
			return {
				kind: sourceKind,
				note,
				hold: hold ? { phase: hold.phase, sourceId: hold.sourceId, preservedActiveId: hold.preservedActiveId, } : null,
				hiddenByUs: (raw && raw.hiddenByUs || []).filter(id => probeIds.includes(id)),
				suppressed: (raw && raw.suppressedHiddenByUs || []).filter(id => probeIds.includes(id)),
				shelved: (raw && raw.shelved || []).filter(id => probeIds.includes(id)),
				reveals: (raw && raw.reveals) || {},
				diagTail: (raw && raw.diagLog || []).slice(-30),
			};
		}
		catch (error) { return { note, stateError: String(error && error.message || error), }; }
	};
	const rows = note => {
		const out = {};
		for (const id of probeIds) { out[id] = !!byId(id); }
		out.note = note;
		return out;
	};
	const pointOf = element => {
		const rect = element.getBoundingClientRect();
		return { x: rect.x + rect.width * 0.6, y: rect.y + rect.height * 0.5, };
	};
	const timeline = [];
	const step = async (note) => { timeline.push({ at: Math.round(performance.now()), note, state: await state(note), rows: rows(note), }); };
	return (async () => {
	try {
		const dt = new DataTransfer();
		const at = pointOf(source);
		const pressOn = pressTarget(source);
		const dropOn = target ? pressTarget(target) : null;
		pressOn.dispatchEvent(new MouseEvent("mousedown", {
			bubbles: true, composed: true, cancelable: true, button: 0,
			clientX: at.x, clientY: at.y,
		}));
		await wait(420);
		await step("after-mousedown");
		// composed is LOAD-BEARING for the icon source: the strap icons
		// live INSIDE a shadow root, and an uncomposed synthetic dragstart
		// stops at the shadow boundary, never reaching TST's document-level
		// dragstart handler (measured: no native-tab-dragstart, the pending
		// hold had to expire by watchdog)
		pressOn.dispatchEvent(new DragEvent("dragstart", {
			bubbles: true, composed: true, cancelable: true, dataTransfer: dt, clientX: at.x, clientY: at.y,
		}));
		await wait(420);
		await step("after-dragstart");
		if (dropMode !== "cancel") {
			const where = dropMode === "after"
				? { x: target.getBoundingClientRect().x + target.getBoundingClientRect().width * 0.6, y: target.getBoundingClientRect().top + target.getBoundingClientRect().height * 0.9, }
				: pointOf(target);
			dropOn.dispatchEvent(new DragEvent("dragover", {
				bubbles: true, composed: true, cancelable: true, dataTransfer: dt, clientX: where.x, clientY: where.y,
			}));
			await wait(180);
			dropOn.dispatchEvent(new DragEvent("drop", {
				bubbles: true, composed: true, cancelable: true, dataTransfer: dt, clientX: where.x, clientY: where.y,
			}));
			// NO wait before the dragend: the browser fires drop THEN
			// dragend without an intervening delay, and TST tears its drag
			// session down within onDrop's setTimeout(0) — a dragend arriving
			// later reads "already handled by ondrop" and never broadcasts
			// native-tab-dragend (measured), which would pin the hold
		}
		pressOn.dispatchEvent(new DragEvent("dragend", {
			bubbles: true, composed: true, cancelable: true, dataTransfer: dt, clientX: at.x, clientY: at.y,
		}));
		await wait(650);
		await step(dropMode === "cancel" ? "after-canceled-dragend" : "after-dropped-dragend");
		return JSON.stringify({ steps: timeline, });
	}
	catch (error) {
		return JSON.stringify({ steps: timeline, error: String(error && error.stack || error), });
	}
	})();
`;

/** Press-only probe for the cleanup scenario: dispatch a mousedown on a
 *  rendered row, sample the addon's hold after TST's mousedown activation,
 *  and optionally release with a mouseup.  The dragSequenceScript sequence
 *  cannot be interrupted mid-flight, and a mid-press tab removal must
 *  happen between two scripted calls (task 4.7). */
const pressOnlyScript = String.raw`
	return (async () => {
	const [sourceId, probeIds, release] = arguments;
	const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
	const byId = id => document.querySelector('tab-item[data-tab-id="' + id + '"]');
	const target = byId(sourceId);
	if (!target) { throw new Error("no press source " + sourceId); }
	// TST resolves presses through tab-item-substance; the bare tab-item
	// host reads as a tabbar-mousedown (measured in the drag scenarios)
	const on = target.tagName.toLowerCase() === "tab-item"
		? (target.querySelector("tab-item-substance") || target) : target;
	const rect = on.getBoundingClientRect();
	const at = { x: rect.x + rect.width * 0.6, y: rect.y + rect.height * 0.5, };
	on.dispatchEvent(new MouseEvent("mousedown", {
		bubbles: true, composed: true, cancelable: true, button: 0,
		clientX: at.x, clientY: at.y,
	}));
	await wait(420);
	let pressed = null;
	try {
		const raw = await browser.runtime.sendMessage("tst-shelf@example.com", { type: "test:state", });
		const holds = raw && raw.dragHolds || {};
		const hold = holds[Object.keys(holds)[0]] || null;
		pressed = hold ? {
			phase: hold.phase,
			sourceId: hold.sourceId,
			preservedActiveId: hold.preservedActiveId,
		} : null;
	}
	catch (error) { pressed = { error: String(error && error.message || error), }; }
	const sampled = {};
	for (const id of probeIds) { sampled[id] = !!byId(id); }
	if (release === "up") {
		on.dispatchEvent(new MouseEvent("mouseup", {
			bubbles: true, composed: true, cancelable: true, button: 0,
			clientX: at.x, clientY: at.y,
		}));
	}
	return JSON.stringify({ pressed, sampled, });
	})();
`;

/** Full window tab dump (id, url, hidden, active) read from an extension
 *  page — the drag phase's ground truth when ids, hides and restarts need
 *  untangling mid-run. */
const tabsDumpScript = String.raw`
	return (async () => {
		const tabs = await browser.tabs.query({ windowId: arguments[0], });
		return JSON.stringify(tabs.map(tab => ({
			id: tab.id, active: tab.active, hidden: tab.hidden,
			url: String(tab.url || "").slice(0, 48),
		})));
	})();
`;

/** The drag-phase sidebar copy must be the ACTIVE tab of its window:
 *  a dormant background tab pauses TST's virtual-scroll layout, so the
 *  copy activates itself (the last sidebar-hosting tab is its own) from
 *  TST's tabs permission. */
const activateSelfScript = String.raw`
	return (async () => {
		const pick = String(arguments[0] || "newest");
		const sidebars = (await browser.tabs.query({}))
			.filter(tab => String(tab.url || "").includes("/sidebar/sidebar.html"))
			.sort((a, b) => pick === "oldest" ? a.id - b.id : b.id - a.id);
		const own = sidebars[0] || null;
		if (!own) { return "no-sidebar-tab"; }
		await browser.tabs.update(own.id, { active: true, });
		return "activated " + own.id;
	})();
`;

/** Virtual-scroll readiness for the drag phase: the tab-hosted copy
 *  renders rows lazily around the scroll offset, and a synthetic press
 *  can only happen on a row whose tab-item element exists (SidebarItems'
 *  virtual scroll).  Scrolls the tree so every wanted row is rendered
 *  and inside the viewport, then reports what is rendered. */
const scrollReadyScript = String.raw`
	return (async () => {
		const wanted = (arguments[0] || []).map(String);
		const wait = ms => new Promise(r => setTimeout(r, ms));
		const container = () => document.querySelector("#normal-tabs-container");
		const rowOf = id => document.querySelector('tab-item[data-tab-id="' + id + '"]');
		const rowsInDom = () => [...document.querySelectorAll("tab-item[data-tab-id]")].map(row => row.dataset.tabId);
		const inView = id => {
			const row = rowOf(id);
			if (!row) { return false; }
			const rect = row.getBoundingClientRect();
			return rect.top >= -4 && rect.bottom <= window.innerHeight + 4;
		};
		for (let pass = 0; pass < 6; pass++) {
			if (wanted.every(id => inView(id))) { break; }
			// the rendered window is sticky in a quiet copy: rows that left
			// it (or were appended past it) re-render when the scroll offset
			// sweeps their side of the strip, so scroll toward the missing
			// side repeatedly (the whole visible strip barely overflows one
			// viewport, two passes cover it)
			const box = container();
			const missing = wanted.filter(id => !inView(id)).map(Number);
			const rendered = rowsInDom().map(Number);
			const missingTop = rendered.length > 0 && missing.length > 0
				&& Math.min(...missing) < Math.min(...rendered);
			if (box) {
				box.scrollTop = missingTop ? 0 : (box.scrollTopMax || 0);
			}
			await wait(500);
		}
		return JSON.stringify({
			wanted, ok: wanted.every(id => inView(id)), rendered: rowsInDom(),
			viewport: {
				innerHeight: window.innerHeight,
				clientHeight: document.documentElement ? document.documentElement.clientHeight : -1,
				containerHeight: container() ? container().clientHeight : -1,
				scrollTop: container() ? container().scrollTop : -1,
			},
		});
	})();
`;

/** The plain-click boundary: mousedown on a row, hold ~350 ms, mouseup —
 *  with the preservation truth read from the model (hiddenByUs) at both
 *  edges, because the sidebar copy's outer rows are virtual-scroll
 *  rendered and the pressed row is usually far from the probed one. */
const plainClickScript = String.raw`
	return (async () => {
		const [sourceId, probeId, windowId] = arguments;
		const row = document.querySelector('tab-item[data-tab-id="' + sourceId + '"]');
		if (!row) { throw new Error("no row " + sourceId); }
		const state = async () => {
			try {
				const raw = await browser.runtime.sendMessage("tst-shelf@example.com", { type: "test:state", });
				return (raw && raw.hiddenByUs || []).map(Number);
			}
			catch (error) { return null; }
		};
		const rect = row.getBoundingClientRect();
		const where = { x: rect.x + rect.width * 0.6, y: rect.y + rect.height * 0.5, };
		const substance = row.tagName.toLowerCase() === "tab-item"
			? (row.querySelector("tab-item-substance") || row) : row;
		substance.dispatchEvent(new MouseEvent("mousedown", {
			bubbles: true, composed: true, cancelable: true, button: 0,
			clientX: where.x, clientY: where.y,
		}));
		await new Promise(r => setTimeout(r, 350));
		const midHidden = await state();
		const midPressUnhidden = midHidden != null && !midHidden.includes(Number(probeId));
		substance.dispatchEvent(new MouseEvent("mouseup", {
			bubbles: true, composed: true, cancelable: true, button: 0,
			clientX: where.x, clientY: where.y,
		}));
		await new Promise(r => setTimeout(r, 40));
		const afterHidden = await state();
		const rightAfterUpUnhidden = afterHidden != null && !afterHidden.includes(Number(probeId));
		return JSON.stringify({ midPressUnhidden, rightAfterUpUnhidden, midHidden, afterHidden, });
	})();
`;

/** Phase 2d: the primary-button drag exception (shelf-nesting delta,
 *  hold-shelf-subtrees-during-drag).  Runs on a dedicated tab-hosted
 *  sidebar copy so the drag's tab moves never disturb phase 2's DOM
 *  oracle; restores the phase-3 resting state (C folded, E active)
 *  before returning. */
async function runDragPhase (marionette, { windowId, expect, }) {
	if (!expect) {
		check("phase 2d skipped (no setup report)", false);
		return;
	}
	const e = expect.expect;
	const C = e.clickFirst;
	const c1 = e.children[0];
	const c2 = e.children[1];
	const D = e.plain;
	const B = e.members[0];
	const A = e.owner;
	const E = e.rootMember;
	const F = e.f;
	// a root tab OUTSIDE the fixture's shelf: the http hint page created
	// at the end of the window (never a child of A or a shelf member)
	const call = async message => {
		const response = await marionette.command("WebDriver:ExecuteScript", {
			script: shelfCallScript, args: [message,], newSandbox: false,
		}).catch(error => { console.log(`[drive] shelf call failed: ${error.message}`); return null; });
		return response && response.value ? JSON.parse(response.value) : null;
	};
	const httpCall = await call({ type: "test:http-tabs", windowId, }) || { ids: [], };
	const httpIds = (httpCall.ids || []).map(Number);
	const setupState = await call({ type: "test:state", }) || {};
	const shelved = new Set((setupState.shelved || []).map(Number));
	const hidden = new Set((setupState.hiddenByUs || []).map(Number));
	const fixtureIds = new Set([A, B, C, D, E, F, c1, c2, e.containerMember, e.controlMember].map(Number));
	const outerRootId = httpIds.find(id => !shelved.has(id) && !hidden.has(id) && !fixtureIds.has(id)) || null;
	check("an outside-the-shelf drag source exists (phase 2d setup)", outerRootId != null,
		`httpIds=${JSON.stringify(httpIds)} shelved=${JSON.stringify([...shelved])}`);
	if (outerRootId == null) { return; }
	// Fresh root-level http tabs: every drag scenario presses a source of
	// its own.  Rows are only pressable where their tab-item is rendered,
	// and TST renders appended tabs, so the scenarios never depend on the
	// initial strip's virtual-scroll window.
	const freshSources = [];
	{
		const mkSource = async name => {
			const created = await call({ type: "test:http-tab-create", windowId, url: `${HINT_ORIGIN}/${name}`, }) || {};
			return created && created.id;
		};
		for (const name of ["d1.html", "d2.html", "d3.html", "d5.html", "d7a.html", "d7b.html", "d8.html",]) {
			const id = await mkSource(name);
			if (id) { freshSources.push(Number(id)); }
		}
		check("phase 2d created fresh drag sources", freshSources.length === 7, JSON.stringify(freshSources));
	}
	if (freshSources.length < 4) { return; }

	// Reuse PHASE 2's tab-hosted sidebar copy: a second copy tab opens
	// DORMANT (its window focus sits elsewhere), TST's virtual-scroll rAF
	// layout never runs in it, and only the rows that happened to exist at
	// navigation time stay in its DOM — a drag source/target set that
	// nothing can repair from outside (the dormant-copy trap).  Phase 2's
	// copy rendered every row its checks needed; the drags run there.
	{
		const tabIdsScript = String.raw`
			return JSON.stringify({ href: location.href, });
		`;
		let adopted = false;
		try {
			marionette.command("Marionette:SetContext", { value: "chrome", }).catch(() => {});
			const handlesResponse = await marionette.command("WebDriver:GetWindowHandles", {})
				.catch(() => null);
			const browserHandles = handlesResponse && (handlesResponse.value || handlesResponse) || [];
			for (const handle of browserHandles) {
				const switched = await commandTry(marionette, "WebDriver:SwitchToWindow", ["Marionette:SwitchToWindow"], { handle, })
					.then(() => true, error => { console.log(`[drive] phase 2d switch to ${handle} failed: ${error.message}`); return false; });
				if (!switched) { continue; }
				await marionette.command("Marionette:SetContext", { value: "content", }).catch(() => {});
				const href = await marionette.command("WebDriver:ExecuteScript", {
					script: tabIdsScript, args: [], newSandbox: false,
				}).then(response => response && response.value ? JSON.parse(response.value).href : null, () => null);
				if (href && href.includes("/sidebar/sidebar.html") && href.includes(`windowId=${windowId}`)) {
					adopted = true;
					break;
				}
			}
		}
		catch (error) { console.log(`[drive] phase 2d adoption failed: ${error.message}`); }
		check("phase 2d adopted phase 2's sidebar copy", adopted);
		if (!adopted) { return; }
		// the copy is its window's tab again (the hint phase focused the
		// smoke tab and other drivers moved focus around): a dormant
		// background tab pauses TST's virtual-scroll rAF layout
		const activation = await marionette.command("WebDriver:ExecuteScript", {
			script: tabsDumpScript, args: [windowId,], newSandbox: false,
		}).then(r => r && r.value, error => "ERR:" + error.message);
		console.log(`[drive] phase 2d adopted page tabs: ${activation}`);
		const activationSelf = await marionette.command("WebDriver:ExecuteScript", {
			script: activateSelfScript, args: ["oldest",], newSandbox: false,
		}).then(r => r && r.value, error => "ERR:" + error.message);
		console.log(`[drive] phase 2d copy activation: ${activationSelf}`);
		await new Promise(resolve => setTimeout(resolve, 3500));
	}
	const rows = async ids => {
		const response = await marionette.command("WebDriver:ExecuteScript", {
			script: rowPresenceScript, args: [ids,], newSandbox: false,
		}).catch(() => null);
		return response && response.value ? JSON.parse(response.value) : {};
	};
	// The dedicated sidebar copy needs its straps before any icon click
	// works (see openBranch); individual icon clicks keep small sleeps.
	const waitFor = async (predicate, ms, what) => {
		const deadline = Date.now() + ms;
		let last = null;
		while (Date.now() < deadline) {
			last = await predicate();
			if (last && last.ok) { return last; }
			await new Promise(resolve => setTimeout(resolve, 600));
		}
		return last || { ok: false, };
	};
	const noHold = state => !state || Object.keys(state.dragHolds || {}).length === 0;
	// TST's get-tree export carries NO `parent`: ancestorTabIds is
	// parent-first ([direct parent, ..., root ancestor], measured)
	const parentOfTree = tree => (tree && tree.ancestorTabIds || [])[0] ?? null;
	/** The tab-hosted copy renders a small initial window of rows and a
	 *  drag can only press rows whose tab-item exists in the DOM, so the
	 *  scenarios scroll the tree (or back to the top) before pressing, and
	 *  the probe documents what the copy renders.  Marionette flakiness
	 *  on a freshly-navigated tab is retried once. */
	const ensureRowsRendered = async wanted => {
		let parsed = null;
		for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
			const result = await marionette.command("WebDriver:ExecuteScript", {
				script: scrollReadyScript, args: [wanted,], newSandbox: false,
			}).catch(error => ({ value: "ERR:" + error.message, }));
			const value = result && result.value;
			try {
				parsed = value ? JSON.parse(value) : null;
			}
			catch (_error) {
				console.log(`[drive] phase 2d render probe attempt ${attempt} failed: ${value}`);
				parsed = null;
				await new Promise(resolve => setTimeout(resolve, 2000));
			}
		}
		if (parsed) { console.log(`[drive] phase 2d rendered rows: ${JSON.stringify(parsed)}`); }
		return parsed;
	};
	const openBranch = async () => {
		const icons = await waitFor(async () => {
			const dump = await marionette.command("WebDriver:ExecuteScript", {
				script: sidebarScript, args: [null,], newSandbox: false,
			}).catch(() => null);
			const parsed = dump && dump.value ? JSON.parse(dump.value) : null;
			return parsed && (parsed.icons || []).some(icon => icon.id == String(C))
				? { ok: true, icons: parsed.icons.length, } : null;
		}, 12000, "strap icons");
		if (!icons || !icons.ok) { return { ok: false, what: "no C icon", icons, }; }
		await marionette.command("WebDriver:ExecuteScript", {
			script: sidebarScript, args: [C,], newSandbox: false,
		}).catch(error => console.log(`[drive] phase 2d icon click failed: ${error.message}`));
		return await waitFor(async () => {
			const rendered = await ensureRowsRendered([C, c2]);
			const presence = await rows([C, c2,]);
			return presence[c2] ? { ok: true, presence, rendered, } : null;
		}, 12000, "C branch rows");
	};
	const dragEventOrder = state => {
		// the chronological diag lines of the drag lifecycle (the events
		// the E2E synthesizes reach the addon as the same notifications;
		// their recorded order documents the measured ordering, task 1.3)
		return ((state && state.diagLog) || [])
			.filter(line => line.includes("drag-hold w=") || line.includes("activated ")
				|| line.includes("drag-start w=") || line.includes("drag-attach w=")
				|| line.includes("drag-end w=") || line.includes("drag-settle w=")
				|| line.includes("drag-hold-dropped w="))
			.slice(-30);
	};

	// -- D0: open C's branch and verify the resting state --------------
	{
		const opening = await openBranch();
		const rendered = await ensureRowsRendered([A, C, c2]);
		const presence = await rows([A, C, c2]);
		check("phase 2d opens C\'s branch (owner, member, plain child rows)",
			!!(opening && opening.ok && presence[A] && presence[C] && presence[c2]),
			() => `opening=${JSON.stringify(opening && { ok: opening.ok, what: opening.what, })} rows=${JSON.stringify(presence)} rendered=${JSON.stringify(rendered && rendered.rendered)}`);
	}
	{
		const state = await call({ type: "test:state", });
		check("no hold lingers from phase 2 (phase 2d setup)", noHold(state), JSON.stringify(state && state.dragHolds));
	}

	try { // scenarios may fail individually; the restore always runs

	// -- D1: ordinary-row grasp survives, inside-drop keeps the branch --
	{
		const source1 = freshSources[0];
		await ensureRowsRendered([source1, C, c2]);
		const sequence = await marionette.command("WebDriver:ExecuteScript", {
			script: dragSequenceScript,
			args: [source1, "row", C, "center", [C, c2, source1,],], newSandbox: false,
		}).catch(error => { console.log(`[drive] drag sequence D1 failed: ${error.message}`); return null; });
		const result = sequence && sequence.value ? JSON.parse(sequence.value) : null;
		if (!result || result.error) {
			check("the synthetic drag lifecycle runs (D1)", false, () => JSON.stringify(result));
			throw new Error("D1 sequence unavailable");
		}
		const afterDown = result.steps.find(step => step.note === "after-mousedown") || {};
		const afterStart = result.steps.find(step => step.note === "after-dragstart") || {};
		check("the grasp arms the hold from the mousedown (D1)",
			afterDown.state && afterDown.state.hold && afterDown.state.hold.phase === "pending"
				&& afterDown.state.hold.preservedActiveId != null,
			() => `after-mousedown state: ${JSON.stringify(afterDown.state)}`);
		check("the grasp preserves the shelved subtree mid-gesture (old behavior folded C here)",
			afterDown.rows && afterDown.rows[C] === true && afterDown.rows[c2] === true,
			() => `after-mousedown rows: ${JSON.stringify(afterDown.rows)}`);
		check("the grasp is answered with an explicit false (the hold records the pressed tab, D1)",
			afterDown.state && afterDown.state.hold && afterDown.state.hold.sourceId == source1,
			() => JSON.stringify(afterDown.state));
		check("native drag start promotes the pending hold (D1)",
			afterStart.state && afterStart.state.hold && afterStart.state.hold.phase === "dragging",
			() => `after-dragstart state: ${JSON.stringify(afterStart.state)}`);
		check("the shelved branch stays visible throughout the drag (D1)",
			afterStart.rows && afterStart.rows[C] === true && afterStart.rows[c2] === true,
			() => `after-dragstart rows: ${JSON.stringify(afterStart.rows)}`);
		// after the settle: D (the active dragged tab) is now child of C;
		// the active branch keeps C visible through the ordinary pass.
		const settled = await waitFor(async () => {
			const state = await call({ type: "test:state", });
			const tree = await marionette.command("WebDriver:ExecuteScript", {
				script: treeStateScript, args: [source1,], newSandbox: false,
			}).then(r => r && r.value ? JSON.parse(r.value) : null, () => null);
			const presence = await rows([A, C, c2]);
			return {
				ok: noHold(state)
					&& parentOfTree(tree) == C
					&& presence[C] === true && presence[c2] === true,
				state, tree, presence,
			};
		}, 9000, "D1 settle");
		const activeIds = ((settled.state && settled.state.shelves) || {})[windowId]?.active || [];
		check("the inside drop re-parents the dragged tab under the shelved parent (D1)",
			parentOfTree(settled.tree) == C,
			() => `tree=${JSON.stringify(settled.tree)}`);
		check("the grasp answered false: TST\'s row activation ran and the dropped tab stays active (D1)",
			activeIds.includes(source1),
			() => `active=${JSON.stringify(activeIds)} dragHolds=${JSON.stringify(settled.state && settled.state.dragHolds)}`);
		check("the inside drop keeps the shelved parent\'s subtree visible after settlement (D1)",
			settled.presence && settled.presence[C] === true && settled.presence[c2] === true,
			() => `rows=${JSON.stringify(settled.presence)} hiddenByUs=${JSON.stringify(settled.state && settled.state.hiddenByUs)}`);
		check("the hold is gone after settlement (D1)", noHold(settled.state),
			() => `dragHolds=${JSON.stringify(settled.state && settled.state.dragHolds)}`);
		const attachLines = dragEventOrder(settled.state).filter(line => line.includes("drag-attach"));
		check("tree-attached telemetry recorded the drop (D1)",
			attachLines.some(line => line.includes(`parent=${C}`) && line.includes("parentShelved=true")),
			() => `lines=${JSON.stringify(attachLines)}`);
		console.log(`[drive] phase 2d D1 event order: ${JSON.stringify(dragEventOrder(settled.state))}`);
	}

	// -- D2: a canceled drag folds the preserved branch once, afterwards -
	{
		// D is under C after D1 and C\'s branch is open: grab the outer
		// root tab (bottom of the strip) and cancel without a drop.  The
		// mid-gesture truth is the model (a scroll is impossible mid-drag),
		// the settled truth is the rows (scrolled back into the render
		// range afterwards).
		const source2 = freshSources[1];
		await ensureRowsRendered([source2]);
		const before = await call({ type: "test:state", });
		check("phase 2d D2 setup has C\'s branch renderable and unhidden",
			!(((before && before.hiddenByUs) || []).map(Number).includes(C)),
			() => `hiddenByUs=${JSON.stringify(before && before.hiddenByUs)}`);
		const sequence = await marionette.command("WebDriver:ExecuteScript", {
			script: dragSequenceScript,
			args: [source2, "row", null, "cancel", [],], newSandbox: false,
		}).catch(error => { console.log(`[drive] drag sequence D2 failed: ${error.message}`); return null; });
		const result = sequence && sequence.value ? JSON.parse(sequence.value) : null;
		check("the canceled-drag sequence runs (D2)", !!(result && !result.error), () => JSON.stringify(result));
		if (result && !result.error) {
			const mid = result.steps.find(step => step.note === "after-dragstart") || {};
			check("the canceled drag preserves the shelved branch while it lasts (D2)",
				mid.state && !(((mid.state.hiddenByUs) || []).map(Number).includes(C)),
				() => `after-dragstart state: ${JSON.stringify(mid.state)}`);
			const pending = result.steps.find(step => step.note === "after-mousedown") || {};
			check("the grasp armed a hold for the canceled drag (D2)",
				pending.state && pending.state.hold && pending.state.hold.phase === "pending",
				() => JSON.stringify(pending.state));
		}
		const settled = await waitFor(async () => {
			const state = await call({ type: "test:state", });
			const hiddenNow = (((state && state.hiddenByUs) || []).map(Number).includes(C));
			return { ok: noHold(state) && hiddenNow, state, };
		}, 9000, "D2 settle");
		await ensureRowsRendered([A]);
		const settledRows = await rows([A, C, c2]);
		check("canceling the drag folds the preserved branch once the gesture resolves (D2)",
			settledRows[A] === true && settledRows[C] === false && settledRows[c2] === false
				&& (((settled.state && settled.state.hiddenByUs) || []).map(Number).includes(C)),
			() => `rows=${JSON.stringify(settledRows)} hiddenByUs=${JSON.stringify(settled.state && settled.state.hiddenByUs)}`);
		check("no auto-unshelving through the drag exception (D2)",
			((settled.state && settled.state.shelved) || []).map(Number).includes(C),
			() => `shelved=${JSON.stringify(settled.state && settled.state.shelved)}`);
		check("the hold is gone after the canceled drag settles (D2)", noHold(settled.state),
			() => `dragHolds=${JSON.stringify(settled.state && settled.state.dragHolds)}`);
	}

	// -- D3: dropping an active dragged tab on a folded, VISIBLE shelved
	//      row unfolds it (TST\'s own forceExpand path) ---------------
	{
		// the dragged source is a fresh http root tab (guaranteed
		// rendered); C stays folded as the drop target of the
		// grasp-protected row.
		const source3 = freshSources[2];
		const opened3 = await openBranch();
		check("phase 2d D3 setup has C\'s branch open",
			!!(opened3 && opened3.ok), () => JSON.stringify(opened3 && { ok: opened3.ok, what: opened3.what, }));
		await ensureRowsRendered([C, c2, source3]);
		await call({ type: "test:collapse", tabId: C, windowId, collapsed: true, });
		const folded = await waitFor(async () => {
			const tree = await marionette.command("WebDriver:ExecuteScript", {
				script: treeStateScript, args: [C,], newSandbox: false,
			}).then(r => r && r.value ? JSON.parse(r.value) : null, () => null);
			const presence = await rows([A, C, c2]);
			return (tree && (tree.states || []).includes("subtree-collapsed"))
				&& presence[C] === true && presence[c2] === false
				? { ok: true, tree, presence, } : { ok: false, tree, presence, };
		}, 8000, "C folded with row");
		check("phase 2d D3 setup: C is folded yet keeps its visible regular row (the target)",
			!!(folded && folded.ok), () => `tree=${JSON.stringify(folded && folded.tree)} rows=${JSON.stringify(folded && folded.presence)}`);
		const sequence = await marionette.command("WebDriver:ExecuteScript", {
			script: dragSequenceScript,
			args: [source3, "row", C, "center", [C, c2, source3,],], newSandbox: false,
		}).catch(error => { console.log(`[drive] drag sequence D3 failed: ${error.message}`); return null; });
		const result = sequence && sequence.value ? JSON.parse(sequence.value) : null;
		check("the folded-target drag sequence runs (D3)", !!(result && !result.error), () => JSON.stringify(result));
		if (result && !result.error) {
			const mid = result.steps.find(step => step.note === "after-dragstart") || {};
			check("the folded shelved row survives the grasp (D3)",
				mid.rows && mid.rows[C] === true,
				() => `after-dragstart rows: ${JSON.stringify(mid.rows)}`);
		}
		const settled = await waitFor(async () => {
			const state = await call({ type: "test:state", });
			const tree = await marionette.command("WebDriver:ExecuteScript", {
				script: treeStateScript, args: [source3,], newSandbox: false,
			}).then(r => r && r.value ? JSON.parse(r.value) : null, () => null);
			const presence = await rows([C, c2,]);
			return { ok: noHold(state) && parentOfTree(tree) == C && presence[c2] === true, state, tree, presence, };
		}, 9000, "D3 settle");
		check("the drop on a folded shelved row attaches beneath it (D3)",
			parentOfTree(settled.tree) == C, () => `tree=${JSON.stringify(settled.tree)}`);
		check("TST\'s attachment flow unfolded the folded shelved target (D3)",
			!(settled.tree && (settled.tree.states || []).includes("subtree-collapsed")) && settled.presence[c2] === true,
			() => `tree=${JSON.stringify(settled.tree)} rows=${JSON.stringify(settled.presence)}`);
		const attachLines = dragEventOrder(settled.state).filter(line => line.includes("drag-attach") && line.includes(`parent=${C}`));
		check("tree-attached telemetry recorded the parent and its prior fold (D3)",
			attachLines.some(line => line.includes("parentShelved=true") && line.includes("parentFolded=true")),
			() => `lines=${JSON.stringify(attachLines)}`);
		check("the hold is gone and the child plus ancestors stay visible after settlement (D3)",
			noHold(settled.state) && settled.presence[C] === true && settled.presence[c2] === true,
			() => `rows=${JSON.stringify(settled.presence)} dragHolds=${JSON.stringify(settled.state && settled.state.dragHolds)}`);
	}

	// -- D4: a shelf-icon drag keeps the previous member\'s subtree -------
	{
		// grab B\'s icon while C\'s subtree is open: selectShelfTab\'s direct
		// fold of the previous member must not run during the gesture
		const opened = await openBranch();
		check("phase 2d D4 setup has C\'s branch open",
			!!(opened && opened.ok), () => JSON.stringify(opened && { ok: opened.ok, what: opened.what, }));
		const sequence = await marionette.command("WebDriver:ExecuteScript", {
			script: dragSequenceScript,
			args: [B, "icon", A, "center", [C, c2, B,],], newSandbox: false,
		}).catch(error => { console.log(`[drive] drag sequence D4 failed: ${error.message}`); return null; });
		const result = sequence && sequence.value ? JSON.parse(sequence.value) : null;
		check("the icon-drag sequence runs (D4)", !!(result && !result.error), () => JSON.stringify(result));
		if (result && !result.error) {
			const mid = result.steps.find(step => step.note === "after-dragstart") || {};
			check("grasping another member\'s icon preserves the previous member\'s subtree (D4)",
				mid.rows && mid.rows[C] === true && mid.rows[c2] === true,
				() => `after-dragstart rows: ${JSON.stringify(mid.rows)} state=${JSON.stringify(mid.state)}`);
			check("the dragged member\'s selection ran (its row is back, D4)",
				mid.rows && mid.rows[B] === true,
				() => `after-dragstart rows: ${JSON.stringify(mid.rows)}`);
			const pending = result.steps.find(step => step.note === "after-mousedown") || {};
			check("the icon grasp armed a hold with the previous member\'s branch preserved (D4)",
				pending.state && pending.state.hold && pending.state.hold.phase === "pending",
				() => JSON.stringify(pending.state));
		}
		const settled = await waitFor(async () => {
			const state = await call({ type: "test:state", });
			const tree = await marionette.command("WebDriver:ExecuteScript", {
				script: treeStateScript, args: [A,], newSandbox: false,
			}).then(r => r && r.value ? JSON.parse(r.value) : null, () => null);
			const presence = await rows([A, C, c2, B]);
			return {
				// the fold's hide waits out the collapse-animation guard
				// (~300 ms after the settle's ordinary pass), so poll C's
				// hidden-by-us truth, not the row's first absence
				ok: noHold(state) && ((state && state.shelved) || []).map(Number).includes(B)
					&& (((state && state.hiddenByUs) || []).map(Number).includes(C)),
				state, tree, presence,
			};
		}, 9000, "D4 settle");
		check("the icon drags its OWN tab, not the owner row (A stays, member B stays shelved, D4)",
			((settled.state && settled.state.shelved) || []).map(Number).includes(B)
				&& settled.tree && Number(settled.tree.id) == Number(A),
			() => `tree=${JSON.stringify(settled.tree)} shelved=${JSON.stringify(settled.state && settled.state.shelved)}`);
		check("resolving the icon drag leaves at most one member subtree (D4)",
			settled.presence && settled.presence[B] === true && settled.presence[C] === false && settled.presence[c2] === false,
			() => `rows=${JSON.stringify(settled.presence)} hiddenByUs=${JSON.stringify(settled.state && settled.state.hiddenByUs)} diag=${JSON.stringify(((settled.state && settled.state.diagLog) || []).slice(-20))}`);
		check("the hold is gone after the icon drag settles (D4)", noHold(settled.state),
			() => `dragHolds=${JSON.stringify(settled.state && settled.state.dragHolds)}`);
		console.log(`[drive] phase 2d D4 event order: ${JSON.stringify(dragEventOrder(settled.state))}`);
	}

	// -- D5: a plain click releases at mouseup; programmatic activation --
	{
		const opened = await openBranch();
		check("phase 2d D5 setup has C\'s branch open", !!(opened && opened.ok), () => JSON.stringify(opened && { ok: opened.ok, what: opened.what, }));
		const source5 = freshSources[3];
		await ensureRowsRendered([source5, C, c2]);
		const clickResult = await marionette.command("WebDriver:ExecuteScript", {
			script: plainClickScript, args: [source5, C, windowId,], newSandbox: false,
		}).catch(error => { console.log(`[drive] plain click failed: ${error.message}`); return null; });
		const click = clickResult && clickResult.value ? JSON.parse(clickResult.value) : null;
		check("a plain click preserves the old branch only until mouseup (mid-press un-hidden, D5)",
			!!(click && click.midPressUnhidden && click.rightAfterUpUnhidden),
			() => JSON.stringify(click));
		const settled = await waitFor(async () => {
			const state = await call({ type: "test:state", });
			const hiddenNow = (((state && state.hiddenByUs) || []).map(Number).includes(C));
			return { ok: noHold(state) && hiddenNow, state, };
		}, 9000, "D5 settle");
		await ensureRowsRendered([A]);
		const settledRows = await rows([A, C, c2]);
		check("the clicked outcome follows the ordinary rules (the clicked tab is outside: the branch folds, D5)",
			settledRows[A] === true && settledRows[C] === false
				&& (((settled.state && settled.state.hiddenByUs) || []).map(Number).includes(C)),
			() => `rows=${JSON.stringify(settledRows)} hiddenByUs=${JSON.stringify(settled.state && settled.state.hiddenByUs)}`);
		// programmatic activation: no hold, immediate fold (the non-pointer
		// exception of the delta: no arm, no pending interval)
		const reopened = await openBranch();
		const heldBefore = await call({ type: "test:state", });
		check("no hold exists for a programmatic activation setup (D5)", noHold(heldBefore),
			() => JSON.stringify(heldBefore && heldBefore.dragHolds));
		check("phase 2d D5 programming setup has C\'s branch open again",
			!!(reopened && reopened.ok), () => JSON.stringify(reopened && { ok: reopened.ok, what: reopened.what, }));
		await marionette.command("WebDriver:ExecuteScript", {
			script: activateScript, args: [source5,], newSandbox: false,
		}).catch(error => console.log(`[drive] programmatic activation failed: ${error.message}`));
		await new Promise(resolve => setTimeout(resolve, 2500));
		const afterProgrammatic = await call({ type: "test:state", });
		await ensureRowsRendered([C, c2]);
		const presenceProgrammatic = await rows([C, c2]);
		check("programmatic activation folds the branch at once and creates no hold (D5)",
			noHold(afterProgrammatic) && presenceProgrammatic[C] === false && presenceProgrammatic[c2] === false,
			() => `rows=${JSON.stringify(presenceProgrammatic)} dragHolds=${JSON.stringify(afterProgrammatic && afterProgrammatic.dragHolds)}`);
	}

	// -- D6: a drag across a folded-owner reveal preserves the reveal ----
	{
		// fold the owner A, activate C (the tabs.update route reaches the
		// reveal too): the reveal shows C\'s branch only; grasping the
		// outer tab must not prune the reveal at grasp, and an outside
		// resolution ends it through the ordinary prune path
		await ensureRowsRendered([A]);
		await call({ type: "test:collapse", tabId: A, windowId, collapsed: true, });
		await new Promise(resolve => setTimeout(resolve, 2200));
		await marionette.command("WebDriver:ExecuteScript", {
			script: activateScript, args: [C,], newSandbox: false,
		}).catch(error => console.log(`[drive] phase 2d D6 reveal activation failed: ${error.message}`));
		const revealOpening = await waitFor(async () => {
			const state = await call({ type: "test:state", });
			const reveal = (((state && state.reveals) || {})[windowId] || []);
			return reveal.some(([owner]) => owner == A) ? { ok: true, reveal, } : null;
		}, 9000, "reveal");
		const before = await call({ type: "test:state", });
		const revealBefore = ((before && before.reveals) || {})[windowId] || [];
		check("phase 2d D6 setup holds a folded-owner reveal for C\'s branch",
			!!(revealOpening && revealOpening.ok) && revealBefore.some(([owner]) => owner == A),
			() => JSON.stringify({ reveal: revealBefore, debug: before && before.revealDebug,
				shelved: (before && before.shelved || []).map(Number),
				active: (((before && before.shelves) || {})[windowId] || {}).active,
				hiddenByUs: (before && before.hiddenByUs || []).map(Number) }));
		const source6 = freshSources[3];
		await ensureRowsRendered([source6]);
		const sequence = await marionette.command("WebDriver:ExecuteScript", {
			script: dragSequenceScript,
			args: [source6, "row", null, "cancel", [],], newSandbox: false,
		}).catch(error => { console.log(`[drive] drag sequence D6 failed: ${error.message}`); return null; });
		const result = sequence && sequence.value ? JSON.parse(sequence.value) : null;
		check("the reveal-drag sequence runs (D6)", !!(result && !result.error), () => JSON.stringify(result));
		const midState = await call({ type: "test:state", });
		const midStep = result && !result.error && (result.steps || []).find(step => step.note === "after-dragstart");
		check("grasping outside a revealed owner keeps the reveal AND the branch unpruned at grasp (D6)",
			!!(midStep && midStep.state
				&& (((midStep.state.reveals || {})[windowId] || []).some(([owner]) => owner == A))
				&& !(((midStep.state.hiddenByUs) || []).map(Number).includes(C))),
			() => `stepState=${JSON.stringify(midStep && midStep.state)}`);
		check("the drag mid-state carried the hold beside the revealed branch (D6 bookkeeping)",
			!!(midStep && midStep.state && midStep.state.hold && midStep.state.hold.phase === "dragging"),
			() => `stepState=${JSON.stringify(midStep && midStep.state)} dragHoldsNow=${JSON.stringify((midState && midState.dragHolds) || {})}`);
		const postRevealGone = await waitFor(async () => {
			const state = await call({ type: "test:state", });
			const revealGone = (((state && state.reveals) || {})[windowId] || []).length === 0;
			// the fold-back and the row reclaim trail the reveal's end by
			// TST's collapse animation plus the hide guard (~450 ms) — the
			// model truth settles first, the rows follow
			const hiddenC = (((state && state.hiddenByUs) || []).map(Number).includes(C));
			return { ok: noHold(state) && revealGone && hiddenC, state, };
		}, 9000, "D6 settle");
		await ensureRowsRendered([A]);
		const settledRows = await rows([A, C, c2]);
		check("an outside resolution ends the reveal through the ordinary prune path (D6)",
			postRevealGone.ok && settledRows[A] === true && settledRows[C] === false && settledRows[c2] === false,
			() => `resolves=${JSON.stringify(postRevealGone.ok)} rows=${JSON.stringify(settledRows)} debug=${JSON.stringify(postRevealGone.state && postRevealGone.state.revealDebug)}`);
		check("the hold is gone after the reveal drag settles (D6)", noHold(postRevealGone.state),
			() => `dragHolds=${JSON.stringify(postRevealGone.state && postRevealGone.state.dragHolds)}`);
	}

	// -- D7: a mid-press tab death drops the hold (task 4.7 cleanup) -----
	{
		// The anchor must arm the hold (its branch carries C's shelf row):
		// c1, the nested-shelf member inside C's branch.  Its death
		// removes one member, which phase 3 tolerates — the reinstall's
		// shelved set rebuilds from the SURVIVING tabs' session values and
		// excludes dead ids.  Source-close and anchor-close share one
		// discard path in tabs.onRemoved; both are driven here.
		const source7a = freshSources[4];
		const source7b = freshSources[5];
		await openBranch();
		await marionette.command("WebDriver:ExecuteScript", {
			script: activateScript, args: [c1,], newSandbox: false,
		}).catch(error => console.log(`[drive] D7 anchor activation failed: ${error.message}`));
		await ensureRowsRendered([source7a, c1, C, c2]);
		const anchorSetup = await rows([c1, C, c2]);
		check("phase 2d D7 setup has the anchor branch open (c1 active, C rows)",
			!!(anchorSetup[c1] && anchorSetup[C] && anchorSetup[c2]), () => JSON.stringify(anchorSetup));
		// sub-case 1: the PRESSED SOURCE dies mid-press
		const press1 = await marionette.command("WebDriver:ExecuteScript", {
			script: pressOnlyScript,
			args: [source7a, [c1, C, c2], "press",], newSandbox: false,
		}).catch(error => { console.log(`[drive] D7 press 1 failed: ${error.message}`); return null; });
		const held1 = press1 && press1.value ? JSON.parse(press1.value) : null;
		check("the press arms a hold preserving the anchor branch (D7)",
			!!(held1 && held1.pressed && held1.pressed.phase === "pending"
				&& held1.pressed.preservedActiveId == c1 && held1.pressed.sourceId == source7a),
			() => JSON.stringify(held1 && held1.pressed));
		check("the anchored branch stays painted while the press holds (D7)",
			!!(held1 && held1.sampled && held1.sampled[C] && held1.sampled[c1] && held1.sampled[c2]),
			() => JSON.stringify(held1 && held1.sampled));
		await call({ type: "test:tabs-remove", tabId: source7a, });
		const cleaned1 = await waitFor(async () => {
			const state = await call({ type: "test:state", });
			return { ok: noHold(state) && (((state && state.shelved) || []).map(Number).includes(C)), state, };
		}, 9000, "D7 source-close cleanup");
		check("closing the pressed source drops the hold (D7)",
			!!(cleaned1 && cleaned1.ok),
			() => JSON.stringify(cleaned1 && cleaned1.state && cleaned1.state.dragHolds));
		check("the source-death cleanup left C shelved (D7)",
			!!(cleaned1 && cleaned1.state && ((cleaned1.state.shelved) || []).map(Number).includes(C)),
			() => JSON.stringify(cleaned1 && cleaned1.state && cleaned1.state.shelved));
		// sub-case 2: the PRESERVED ANCHOR dies mid-press.  Sub-case 1's
		// ordinary pass folded C's branch (the active tab fell outside
		// it), so the anchor is re-activated first: the activation reopens
		// C's row and C's plain-child rows before press 2 can arm.
		await marionette.command("WebDriver:ExecuteScript", {
			script: activateScript, args: [c1,], newSandbox: false,
		}).catch(error => console.log(`[drive] D7 anchor re-activation failed: ${error.message}`));
		const anchorReopened = await waitFor(async () => {
			const readiness = await ensureRowsRendered([c1, C, c2]);
			const fresh = await rows([c1, C, c2]);
			return fresh[c1] && fresh[C] && fresh[c2] ? { ok: true, fresh, readiness, } : null;
		}, 9000, "D7 anchor rows");
		const anchorSetup2 = anchorReopened && anchorReopened.fresh || await rows([c1, C, c2]);
		check("phase 2d D7 re-setup has the anchor branch open for press 2",
			!!(anchorSetup2[c1] && anchorSetup2[C] && anchorSetup2[c2]), () => JSON.stringify(anchorSetup2));
		if (anchorSetup2[c1] && anchorSetup2[C]) {
			const press2 = await marionette.command("WebDriver:ExecuteScript", {
				script: pressOnlyScript,
				args: [source7b, [c2, C], "press",], newSandbox: false,
			}).catch(error => { console.log(`[drive] D7 press 2 failed: ${error.message}`); return null; });
			const held2 = press2 && press2.value ? JSON.parse(press2.value) : null;
			check("the second press arms a hold with the same anchor (D7)",
				!!(held2 && held2.pressed && held2.pressed.phase === "pending"
					&& held2.pressed.preservedActiveId == c1 && held2.pressed.sourceId == source7b),
				() => JSON.stringify(held2 && held2.pressed));
			await call({ type: "test:tabs-remove", tabId: c1, });
			const cleaned2 = await waitFor(async () => {
				const state = await call({ type: "test:state", });
				return { ok: noHold(state) && (((state && state.shelved) || []).map(Number).includes(C)), state, };
			}, 9000, "D7 anchor-close cleanup");
			check("closing the preserved anchor drops the hold and keeps its owner shelved (D7)",
				!!(cleaned2 && cleaned2.ok),
				() => JSON.stringify({ holds: cleaned2 && cleaned2.state && cleaned2.state.dragHolds,
					shelved: cleaned2 && cleaned2.state && cleaned2.state.shelved }));
			// release the dangling press: the hold is already gone, the
			// release is a no-op for us, and TST's click resolves the press
			await marionette.command("WebDriver:ExecuteScript", {
				script: pressOnlyScript,
				args: [source7b, [], "up",], newSandbox: false,
			}).catch(error => console.log(`[drive] D7 release failed: ${error.message}`));
			const settled7 = await waitFor(async () => {
				const state = await call({ type: "test:state", });
				const hidden = ((state && state.hiddenByUs) || []).map(Number);
				return { ok: noHold(state) && hidden.includes(C) && !hidden.includes(c2), state, };
			}, 9000, "D7 settle");
			await ensureRowsRendered([A]);
			const settledRows7 = await rows([A, c1, c2]);
			check("after the anchor death the branch resolves by the ordinary rules (D7)",
				!!(settled7 && settled7.ok) && settledRows7[A] === true && settledRows7[c2] === false,
				() => `hold=${JSON.stringify(settled7 && settled7.state && settled7.state.dragHolds)}`
					+ ` hiddenByUs=${JSON.stringify(settled7 && settled7.state && settled7.state.hiddenByUs)}`
					+ ` rows=${JSON.stringify(settledRows7)}`);
		}
	}

	// -- D8: the ACTIVE CHILDLESS member keeps its row at grasp ----------
	{
		// B is a member with no children: its single revealed row is the
		// shelf's whole drop surface.  The 0.6.5 arming test demanded a
		// shelved member WITH children, so the hold never armed here and
		// the ordinary outgoing-member hide reclaimed the row at grasp —
		// the user bug "its subtree disappears the moment I clutch
		// another tab" (a subtree of exactly one row).  The widened test
		// must arm on B itself, and the inside drop must land beneath B.
		const source8 = freshSources[6];
		await call({ type: "test:collapse", tabId: A, windowId, collapsed: false, });
		await marionette.command("WebDriver:ExecuteScript", {
			script: activateScript, args: [B,], newSandbox: false,
		}).catch(error => console.log(`[drive] D8 anchor activation failed: ${error.message}`));
		const anchorReady = await waitFor(async () => {
			const readiness = await ensureRowsRendered([B, source8]);
			const fresh = await rows([B, source8]);
			return fresh[B] && fresh[source8] ? { ok: true, fresh, readiness, } : null;
		}, 12000, "D8 rows");
		const setup8 = anchorReady && anchorReady.fresh || await rows([B, source8]);
		check("phase 2d D8 setup renders the childless member's row (B active)",
			!!(setup8[B] && setup8[source8]),
			() => JSON.stringify({ setup8, readiness: anchorReady && anchorReady.readiness }));
		const sequence = await marionette.command("WebDriver:ExecuteScript", {
			script: dragSequenceScript,
			args: [source8, "row", B, "center", [B, source8,],], newSandbox: false,
		}).catch(error => { console.log(`[drive] drag sequence D8 failed: ${error.message}`); return null; });
		const result = sequence && sequence.value ? JSON.parse(sequence.value) : null;
		check("the childless-anchor drag sequence runs (D8)",
			!!(result && !result.error), () => JSON.stringify(result));
		const grasp = result && !result.error && (result.steps || []).find(step => step.note === "after-mousedown");
		check("the childless shelved member's row survives the grasp (D8)",
			!!(grasp && grasp.rows && grasp.rows[B]),
			() => `notes=${JSON.stringify(result && (result.steps || []).map(step => step.note))} rows=${JSON.stringify(grasp && grasp.rows)}`);
		const dragged8 = result && !result.error && (result.steps || []).find(step => step.note === "after-dragstart");
		check("the childless member's row is still the target mid-drag (D8)",
			!!(dragged8 && dragged8.rows && dragged8.rows[B]
				&& dragged8.state && dragged8.state.hold && dragged8.state.hold.phase === "dragging"),
			() => JSON.stringify({ rows: dragged8 && dragged8.rows, hold: dragged8 && dragged8.state && dragged8.state.hold }));
		const settled8 = await waitFor(async () => {
			const state = await call({ type: "test:state", });
			return { ok: noHold(state), state, };
		}, 9000, "D8 settle");
		const treeCall = await call({ type: "test:tree-of", tab: source8, });
		const parentOf8 = parentOfTree(treeCall && treeCall.tree);
		const settledRows8 = await rows([B, source8]);
		check("the inside drop attaches under the childless member and keeps its row (D8)",
			parentOf8 == B && settledRows8[B] === true && settledRows8[source8] === true
				&& !!(settled8 && settled8.ok)
				&& ((settled8.state && settled8.state.shelved) || []).map(Number).includes(B),
			() => `parent=${parentOf8} rows=${JSON.stringify(settledRows8)}`
				+ ` hold=${JSON.stringify(settled8.state && settled8.state.dragHolds)}`
				+ ` tree=${JSON.stringify(treeCall && treeCall.tree && treeCall.tree.ancestorTabIds)}`);
	}

	}
	finally { // -- restore the phase-3 resting state (C folded, E active) --
		// the fresh source tabs leave with the phase: their rows would
		// stay coded surface rows for phase 3's hint replay otherwise
		for (const sourceId of freshSources) {
			await call({ type: "test:tabs-remove", tabId: sourceId, });
		}
		await new Promise(resolve => setTimeout(resolve, 1500));
		await call({ type: "test:collapse", tabId: A, windowId, collapsed: false, });
		await call({ type: "test:collapse", tabId: C, windowId, collapsed: true, });
		// wait out the settle quiet window so no hold survives the phase
		await new Promise(resolve => setTimeout(resolve, 2500));
		const state = await call({ type: "test:state", });
		check("phase 2d leaves no hold behind (phase 3 gate)", noHold(state), JSON.stringify(state && state.dragHolds));
		const shelvedIds = ((state && state.shelved) || []).map(Number);
		check("phase 2d keeps every member shelved (B, C, F stayed through the drags)",
			shelvedIds.includes(B) && shelvedIds.includes(C) && shelvedIds.includes(F),
			() => `shelved=${JSON.stringify(shelvedIds)}`);
		const folded = await waitFor(async () => {
			const tree = await marionette.command("WebDriver:ExecuteScript", {
				script: treeStateScript, args: [C,], newSandbox: false,
			}).then(r => r && r.value ? JSON.parse(r.value) : null, () => null);
			return tree && (tree.states || []).includes("subtree-collapsed") ? { ok: true, tree, } : { ok: false, tree, };
		}, 8000, "C folded");
		check("phase 2d re-folds C for the persist-through-reinstall check",
			!!(folded && folded.ok),
			() => `tree=${JSON.stringify(folded && folded.tree)}`);
		await marionette.command("WebDriver:ExecuteScript", {
			script: activateScript, args: [E,], newSandbox: false,
		}).catch(error => console.log(`[drive] phase 2d final reset failed: ${error.message}`));
		await new Promise(resolve => setTimeout(resolve, 2000));
	}
}

async function main () {
	prepareProfile();
	fs.rmSync(CONSOLE_LOG, { force: true, });
	fs.rmSync(CONSOLE_LOG.replace(/\.log$/, ".lock"), { force: true, });
	fs.rmSync(SETUP_REPORT, { force: true, });
	fs.rmSync(FINAL_REPORT, { force: true, });

	// the hint-fixture http pages: up before the browser (the smoke page
	// navigates to one in phase 1), down with the process
	const hintServer = http.createServer((req, res) => {
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", });
		res.end(`<!doctype html><meta charset="utf-8"><title>hint ${req.url}</title><p>hint target ${req.url}</p>`);
	});
	await new Promise((resolve, reject) => {
		hintServer.once("error", reject);
		hintServer.listen(HINT_PORT, "127.0.0.1", resolve);
	});
	console.log(`[drive] hint pages at ${HINT_ORIGIN}`);

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
			// commands registration on a TEMPORARY (about:debugging-style)
			// install: the smoke page's own browser.commands.getAll() is
			// the readout (0.3.2's background-side boot assert is retired
			// — the user's finding was key shadowing, not registration).
			const cmd = (expect.commands || []).find(entry => entry.name === "tst-shelf:hints");
			check("hints command registered at boot (temporary install)",
				!!cmd && !!cmd.shortcut,
				() => `commands: ${JSON.stringify(expect.commands)}`);
		}

		// -- phase 2: sidebar DOM assertions + synthetic clicks ------------
		await runSidebarPhase(marionette, { windowId, expect, });

		// -- phase 2d: the drag lifecycle (hold-shelf-subtrees-during-drag)
		await runDragPhase(marionette, { windowId, expect, });


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
			// same assertion after the in-session reinstall: an upgrade
			// cycle must land the NEW manifest's commands, read from the
			// reinstalled smoke page's own commands.getAll().
			const cmd = (phase3Report.commands || []).find(entry => entry.name === "tst-shelf:hints");
			check("hints command registered after reinstall (upgrade proxy)",
				!!cmd && !!cmd.shortcut,
				() => `commands: ${JSON.stringify(phase3Report.commands)}`);
		}

		marionette.destroy();
	} finally {
		hintServer.close();
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
