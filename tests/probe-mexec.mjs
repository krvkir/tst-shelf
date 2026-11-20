/**
 * Manual probe: does WebDriver:ExecuteScript work in chrome and content
 * contexts on this Firefox build?  Usage: node tests/probe-mexec.mjs
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
const FIXTURE = path.join(HERE, "fixture-profile");
const PORT = 2831;
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "probe-"));

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
	throw new Error("no port");
}

fs.cpSync(FIXTURE, SCRATCH, { recursive: true, });
fs.appendFileSync(path.join(SCRATCH, "prefs.js"), `user_pref("marionette.port", ${PORT});\n`);
const firefox = spawn("/usr/bin/firefox", ["-no-remote", "-headless", "-marionette", "-remote-allow-system-access", "-profile", SCRATCH,],
	{ stdio: ["ignore", "ignore", "ignore"], });

await waitForPort(60_000);
const m = new Marionette;
console.log("handshake:", await m.connect(PORT));
try { await m.command("newSession", { capabilities: { alwaysMatch: { }, }, }); }
catch { await m.command("WebDriver:NewSession", { capabilities: { alwaysMatch: { }, }, }); }

await m.command("Marionette:SetContext", { value: "chrome", });
for (const [label, script, extra] of [
	["chrome return-const", "return 1+1;", {}],
	["chrome newSandbox-default", "return 2+2;", {}],
	["chrome newSandbox-false", "return 3+3;", { newSandbox: false, }],
]) {
	try {
		const r = await m.command("WebDriver:ExecuteScript", { script, args: [], ...extra, });
		console.log(label, "=>", JSON.stringify(r));
	} catch (error) { console.log(label, "THREW:", error.message); }
}

await m.command("Marionette:SetContext", { value: "content", });
await m.command("WebDriver:Navigate", { url: "about:blank", }).catch(async () => { await m.command("Marionette:GetURL", { url: "about:blank", }); });
for (const [label, script, extra] of [
	["content return-const", "return 1+1;", {}],
	["content newSandbox-false", "return 3+3;", { newSandbox: false, }],
	["content body-form", "(function () { return 'bodyform'; }).apply(null, arguments)", {}],
]) {
	try {
		const r = await m.command("WebDriver:ExecuteScript", { script, args: [], ...extra, });
		console.log(label, "=>", JSON.stringify(r));
	} catch (error) { console.log(label, "THREW:", error.message); }
}

m.destroy();
firefox.kill("SIGTERM");
setTimeout(() => firefox.kill("SIGKILL"), 1500);
fs.rmSync(SCRATCH, { recursive: true, force: true, });
