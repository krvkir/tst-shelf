#!/usr/bin/env node
/**
 * Build script for tst-shelf.
 *
 * Bundles the ES-module background into a single IIFE (MV2 background
 * scripts cannot import modules), copies static assets from src/ to
 * dist/.  With `--watch` bundles continuously on src changes.
 *
 * Usage: node build.js [--watch]
 */
"use strict";

const { build, context } = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "src");
const DIST = path.join(__dirname, "dist");
const STATIC_FILES = [
	"manifest.json",
	"icons/48.png", "icons/96.png",
];

/**
 * E2E=1 builds a test flavor: the smoke page auto-opens on start-up and
 * reports through the downloads API (the only channel that works in a
 * headless, unattended run).  Public builds never carry test code.
 */
function applyE2EPatch () {
	for (const rel of ["tests.html", "tests-smoke.js", "tree-tab.html", "favicon.svg"]) {
		fs.copyFileSync(path.join(SRC, rel), path.join(DIST, rel));
	}
	const manifestPath = path.join(DIST, "manifest.json");
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	manifest.version += "-e2e";
	manifest.permissions.push("downloads");
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t"));
}

function copyStatic () {
	for (const rel of STATIC_FILES) {
		const from = path.join(SRC, rel);
		if (!fs.existsSync(from)) { throw new Error(`missing source asset: src/${rel}`); }
		const to = path.join(DIST, rel);
		fs.mkdirSync(path.dirname(to), { recursive: true, });
		fs.copyFileSync(from, to);
	}
}

async function bundleOnce () {
	await build({
		entryPoints: [ path.join(SRC, "background/index.esm.js"), ],
		bundle: true, format: "iife", platform: "browser",
		target: ["firefox115"],
		outfile: path.join(DIST, "background.js"),
		logLevel: "info",
	});
}

async function main () {
	fs.rmSync(DIST, { recursive: true, force: true, });
	await bundleOnce();
	copyStatic();
	if (process.env.E2E) { applyE2EPatch(); }
	console.log("build: dist/ ready");
	if (process.argv.includes("--watch")) {
		const ctx = await context({
			entryPoints: [ path.join(SRC, "background/index.esm.js"), ],
			bundle: true, format: "iife", platform: "browser",
			target: ["firefox115"],
			outfile: path.join(DIST, "background.js"),
			logLevel: "silent",
		});
		await ctx.watch();
		fs.watch(SRC, { recursive: true, }, (_event, file) => {
			if (!file || file.startsWith("background/")) { return; } // esbuild watches that
			try { copyStatic(); console.log(`build: copied ${file}`); }
			catch (error) { console.error(`build: ${error.message}`); }
		});
		console.log("build: watching src/ -- changes rebuild into dist/");
	}
}

main().catch(error => { console.error(error); process.exit(1); });
