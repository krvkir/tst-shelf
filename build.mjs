#!/usr/bin/env node
/**
 * Build script for tst-shelf.
 *
 * Bundles the ES-module background into a single IIFE (MV2 background
 * scripts cannot import modules) and copies the static assets into the
 * output directory.
 *
 * Production and E2E flavors are SEPARATE OUTPUT DIRECTORIES:
 *   node build.mjs                 -> dist/      (the only releasable tree)
 *   E2E=1 node build.mjs --out dist-e2e
 *                                  -> dist-e2e/ (smoke page, test API,
 *                                     -e2e version, downloads permission)
 * The release target builds production from scratch after the E2E run and
 * verifies the result (scripts/verify-dist.mjs); the E2E build must never
 * be what `web-ext build` packs (it did: `make e2e` left its output in
 * dist/, and `make release` packaged it as-is).
 *
 * Usage: node build.mjs [--out DIR] [--watch]
 */
import { build, context } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "src");

const argv = process.argv.slice(2);
const outArg = (() => {
	const index = argv.indexOf("--out");
	return index >= 0 && argv[index + 1] ? argv[index + 1] : null;
})();
const OUT = path.resolve(HERE, outArg || process.env.DIST_DIR || "dist");
const E2E = !!process.env.E2E;

const STATIC_FILES = [
	"manifest.json",
	"icons/48.png", "icons/96.png",
	"options.html", "options.js",
	"hint-catcher.js",
];
/** Files that only the E2E flavor carries (copied by applyE2EPatch). */
const E2E_FILES = ["tests.html", "tests-smoke.js", "tree-tab.html", "tree-tab.js", "favicon.svg"];

const ENTRY = path.join(SRC, "background/index.esm.js");
const bundleOptions = {
	entryPoints: [ENTRY],
	bundle: true, format: "iife", platform: "browser",
	target: ["firefox115"],
	outfile: path.join(OUT, "background.js"),
};

/**
 * E2E=1 builds a test flavor: the smoke page auto-opens on start-up and
 * reports through the downloads API (the only channel that works in a
 * headless, unattended run).  Public builds never carry test code — and
 * never share their directory with a test build.
 */
function applyE2EPatch () {
	for (const rel of E2E_FILES) {
		fs.copyFileSync(path.join(SRC, rel), path.join(OUT, rel));
	}
	const manifestPath = path.join(OUT, "manifest.json");
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	manifest.version += "-e2e";
	manifest.permissions.push("downloads");
	// the hint-fixture pages (tests/e2e-drive.mjs): the E2E enters hint
	// mode through the test hook, so no commands-API activeTab grant
	// exists, and arming the page catcher in a real http page REQUIRES
	// a host permission for it.  Match patterns carry NO port (MDN:
	// a pattern with a port is invalid) — http://127.0.0.1/* matches
	// any port, 47631 included.  Production never carries this —
	// verify-dist rejects any match-pattern permission outright.
	manifest.permissions.push("http://127.0.0.1/*");
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t"));
}

function copyStatic () {
	for (const rel of STATIC_FILES) {
		const from = path.join(SRC, rel);
		if (!fs.existsSync(from)) { throw new Error(`missing source asset: src/${rel}`); }
		const to = path.join(OUT, rel);
		fs.mkdirSync(path.dirname(to), { recursive: true, });
		fs.copyFileSync(from, to);
	}
}

async function main () {
	fs.rmSync(OUT, { recursive: true, force: true, });
	await build({ ...bundleOptions, logLevel: "info", });
	copyStatic();
	if (E2E) { applyE2EPatch(); }
	console.log(`build: ${path.relative(HERE, OUT)}/ ready${E2E ? " (E2E flavor)" : ""}`);
	if (argv.includes("--watch")) {
		if (E2E) { throw new Error("--watch is for the production flavor only"); }
		const ctx = await context({ ...bundleOptions, logLevel: "silent", });
		await ctx.watch();
		fs.watch(SRC, { recursive: true, }, (_event, file) => {
			if (!file || file.startsWith("background/")) { return; } // esbuild watches that
			try { copyStatic(); console.log(`build: copied ${file}`); }
			catch (error) { console.error(`build: ${error.message}`); }
		});
		console.log(`build: watching src/ -- changes rebuild into ${path.relative(HERE, OUT)}/`);
	}
}

main().catch(error => { console.error(error); process.exit(1); });
