/**
 * Manual probe: what does Firefox report on tabs for favIconUrl / status /
 * audible / muted when a navigation fails (refused connection), when a
 * page loads successfully WITHOUT a favicon, and when a tab plays audio?
 * Characterises the rules `resolveFavicons` (logic.esm.js) and the sound
 * indicator rely on.  Usage: node tests/probe-favicon.mjs
 *
 * Installs tests/probe-favicon-addon/ into a throwaway profile, drives it
 * (the addon's background runs the timeline against an inline HTTP
 * server), then reads the JSON report the addon renders on its own
 * moz-extension:// page.
 */
"use strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync, } from "node:child_process";
import net from "node:net";
import { fileURLToPath, } from "node:url";
import { Marionette, } from "./marionette.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADDON = path.join(HERE, "probe-favicon-addon");
const PORT = 2832;
const HTTP_PORT = 8123;
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "favicon-probe-"));

/** 0.4 s of a 440 Hz sine (quiet, but genuinely audible), so headless
 *  Firefox has something a sound-capable build can mark `audible`. */
function wavBytes (seconds) {
	const rate = 8000;
	const count = Math.floor(rate * seconds);
	const data = Buffer.alloc(44 + count * 2);
	data.write("RIFF", 0); data.writeUInt32LE(36 + count * 2, 4); data.write("WAVE", 8);
	data.write("fmt ", 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20);
	data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24);
	data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
	data.write("data", 36); data.writeUInt32LE(count * 2, 40);
	for (let i = 0; i < count; i++) {
		data.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 440 * (i / rate))), 44 + i * 2);
	}
	return data;
}

const server = http.createServer((req, res) => {
	if (req.url === "/plain.txt") {
		res.writeHead(200, { "content-type": "text/plain", });
		res.end("no favicon here\n");
		return;
	}
	if (req.url === "/with-favicon.html") {
		res.writeHead(200, { "content-type": "text/html", });
		res.end(`<!doctype html><link rel="icon" href="/icon.svg" type="image/svg+xml"><title>favicon site</title><p>x</p>`);
		return;
	}
	if (req.url === "/icon.svg") {
		res.writeHead(200, { "content-type": "image/svg+xml", });
		res.end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3" fill="#c33"/></svg>`);
		return;
	}
	if (req.url === "/audio.html") {
		res.writeHead(200, { "content-type": "text/html", });
		res.end(`<!doctype html><title>audio</title><audio src="/tone.wav" autoplay loop></audio>`);
		return;
	}
	if (req.url === "/tone.wav") {
		res.writeHead(200, { "content-type": "audio/wav", });
		res.end(wavBytes(0.4));
		return;
	}
	res.writeHead(404); res.end("");
});

const EXT_ID = "favicon-probe@example.com";

async function waitForPort (timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const open = await new Promise(resolve => {
			const probe = net.createConnection({ port: PORT, host: "127.0.0.1", });
			probe.once("connect", () => { probe.destroy(); resolve(true); });
			probe.once("error", () => { probe.destroy(); resolve(false); });
		});
		if (open) { return; }
		await new Promise(resolve => setTimeout(resolve, 400));
	}
	throw new Error("marionette port never opened");
}

const RESULTS_DIR = path.join(HERE, "..", "2026-11-21-fixes");
const RESULTS = path.join(RESULTS_DIR, "favicon-probe.json");
fs.mkdirSync(RESULTS_DIR, { recursive: true, });

/** A report file exists AND parses (downloads are created empty first). */
function reportReady (file = RESULTS) {
	try {
		const text = fs.readFileSync(file, "utf8");
		if (!text.trim()) { return null; }
		return JSON.parse(text);
	} catch (_error) { return null; }
}

async function main () {
	server.listen(HTTP_PORT, "127.0.0.1");
	// pack the probe addon (zip, as web-ext would)
	for (const file of ["manifest.json", "background.js", "report.html", "report.js",]) {
		fs.copyFileSync(path.join(ADDON, file), path.join(SCRATCH, file));
	}
	const xpi = path.join(SCRATCH, "probe.xpi");
	execFileSync("zip", ["-q", xpi, "manifest.json", "background.js", "report.html", "report.js",], { cwd: SCRATCH, });

	fs.appendFileSync(path.join(SCRATCH, "prefs.js"),
		`user_pref("marionette.port", ${PORT});\n`
		+ `user_pref("browser.download.useDownloadDir", true);\n`
		+ `user_pref("browser.download.folderList", 2);\n`
		+ `user_pref("browser.download.always_ask_before_saving_new_file", false);\n`
		+ `user_pref("browser.download.improvements_to_download_panel", false);\n`
		+ `user_pref("browser.download.dir", "${RESULTS_DIR}");\n`);
	const firefox = spawn("/usr/bin/firefox", [
		"-no-remote", "-headless", "-marionette", "-remote-allow-system-access", "-profile", SCRATCH,
	], { stdio: ["ignore", "ignore", "ignore"], });

	await waitForPort(60_000);
	const m = new Marionette;
	await m.connect(PORT);
	try { await m.command("newSession", { capabilities: { alwaysMatch: { }, }, }); }
	catch { await m.command("WebDriver:NewSession", { capabilities: { alwaysMatch: { }, }, }); }
	await m.command("Marionette:SetContext", { value: "chrome", });
	console.log("addon install:", JSON.stringify(await m.command("Addon:Install", { path: xpi, temporary: true, })));

	// the addon downloads its own report through browser.downloads (the
	// proven headless channel of the E2E); poll the file on disk, and
	// watch the report page's title for the live phase
	let report = null;
	for (let attempt = 0; attempt < 60 && !report; attempt++) {
		await new Promise(resolve => setTimeout(resolve, 3000));
		report = reportReady();
		if (!report) {
			const raw = await m.command("WebDriver:ExecuteScript", {
				script: "const titles=[];for(const win of Services.wm.getEnumerator('navigator:browser')){for(const b of win.gBrowser.browsers){titles.push(b.contentTitle+'@'+String(b.currentURI&&b.currentURI.spec||'').slice(0,60))}}return titles.join(' | ')",
				args: [],
			}).catch(error => String(error));
			const out = raw && typeof raw === "object" ? (raw.value ?? "") : raw;
			console.log("poll", attempt, ":", String(out).slice(0, 300));
		}
	}
	console.log(report ? JSON.stringify(report, null, "\t") : "NO REPORT");
	await m.command("Addon:Uninstall", { id: EXT_ID, }).catch(() => {});

	m.destroy();
	firefox.kill("SIGTERM");
	setTimeout(() => firefox.kill("SIGKILL"), 1500);
	server.close();
	fs.rmSync(SCRATCH, { recursive: true, force: true, });
}

const origLog = console.log;
const lines = [];
console.log = (...args) => { origLog(...args); lines.push(args.join(" ")); };
process.on("exit", () => { fs.writeFileSync(path.join(RESULTS_DIR, "favicon-probe-stdout.log"), lines.join("\n")); });
main().catch(error => { console.error(error); process.exit(1); });
