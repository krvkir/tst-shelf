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
		const info = {
			id: row.dataset.tabId,
			classes: [...row.classList],
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

/** Visibility probe for the selected shelved tab's children rows. */
const visibilityScript = String.raw`
	const rowOf = id => document.querySelector('tab-item[data-tab-id="' + id + '"]');
	const probe = id => {
		const row = rowOf(id);
		return {
			exists: !!row,
			height: row ? row.getBoundingClientRect().height : -1,
			classes: row ? [...row.classList].join(",") : "",
		};
	};
	return JSON.stringify({ c1: probe(arguments[0]), c2: probe(arguments[1]), });
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
			let uuid = null;
			for (let i = 0; i < 40 && !uuid; i++) {
				uuid = readTstUuid(PREFS);
				if (!uuid) { await new Promise(resolve => setTimeout(resolve, 500)); }
			}
			if (!uuid) {
				console.log("FAIL [driver] TST uuid readable from prefs");
				process.exitCode = process.exitCode || 1;
			} else {
				const pageUrl = `moz-extension://${uuid}/sidebar/sidebar.html?windowId=${windowId}`;
				console.log(`[drive] phase 2: opening ${pageUrl}`);
				await marionette.command("Marionette:SetContext", { value: "content", });
				try {
					const win = await commandTry(marionette, "WebDriver:NewWindow", ["Marionette:NewWindow"], { type: "tab", });
					const handle = (win && (win.handle || (win.value && win.value.handle))) || null;
					if (handle) {
						await commandTry(marionette, "WebDriver:SwitchToWindow", ["Marionette:SwitchToWindow"], { handle, });
					}
					await commandTry(marionette, "WebDriver:Navigate", ["Marionette:GetURL"], { url: pageUrl, });
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

					if (dump.rows.find(row => row.id == String(e.members[0]) && row.classes.includes("tst-shelf-shelved"))) {
						console.log("PASS [driver] shelved rows hide via the tst-shelf-shelved class");
					} else {
						console.log("FAIL [driver] shelved rows hide via the tst-shelf-shelved class");
						process.exitCode = process.exitCode || 1;
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
							args: [e.children[0], e.children[1],], newSandbox: false,
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

					console.log("[drive] phase 2: clicking the B icon");
					await marionette.command("WebDriver:ExecuteScript", {
						script: sidebarScript, args: [e.clickSecond,], newSandbox: false,
					}).catch(error => console.log(`[drive] click-2 failed: ${error.message}`));
					await new Promise(resolve => setTimeout(resolve, 3000));
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
