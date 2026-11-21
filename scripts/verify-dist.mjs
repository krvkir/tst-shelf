#!/usr/bin/env node
/**
 * Release gate for a built extension tree (`dist/` by default).
 *
 * `make release` must package a PRODUCTION build, never the E2E flavor:
 * the E2E manifest declares the downloads permission, carries a `-e2e`
 * version, and ships a smoke page that can drive shelves, navigation and
 * arbitrary TST state through a test-only external message API.  This
 * script fails the release if any of that is present, or if the tree
 * carries files the production build never produces.
 *
 * Usage: node scripts/verify-dist.mjs [DIR]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const DIR = path.resolve(REPO, process.argv[2] || "dist");

const REQUIRED = ["manifest.json", "background.js", "icons/48.png", "icons/96.png"];
const FORBIDDEN = ["tests.html", "tests-smoke.js", "tree-tab.html", "tree-tab.js", "favicon.svg"];

const problems = [];
const say = text => { problems.push(text); };

function walk (dir, prefix = "") {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const rel = path.join(prefix, entry.name);
		if (entry.isDirectory()) { out.push(...walk(path.join(dir, entry.name), rel)); }
		else { out.push(rel); }
	}
	return out;
}

if (!fs.existsSync(DIR)) {
	console.error(`verify-dist: ${DIR} does not exist (run node build.mjs)`);
	process.exit(1);
}

const files = walk(DIR).sort();
for (const rel of REQUIRED) {
	if (!files.includes(rel)) { say(`missing required file: ${rel}`); }
}
for (const rel of FORBIDDEN) {
	if (files.includes(rel)) { say(`test-only file present: ${rel}`); }
}
for (const rel of files) {
	if (/-e2e/.test(rel)) { say(`test-flavored file present: ${rel}`); }
}

let manifest = null;
try {
	manifest = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8"));
}
catch (error) { say(`manifest.json does not parse: ${error.message}`); }

if (manifest) {
	if (String(manifest.version || "").endsWith("-e2e")) {
		say(`manifest version is the E2E version: ${manifest.version}`);
	}
	if ((manifest.permissions || []).includes("downloads")) {
		say("manifest declares the downloads permission (E2E only)");
	}
	const expected = new Set(REQUIRED);
	for (const rel of files) {
		if (!expected.has(rel)) { say(`unexpected file in a production tree: ${rel}`); }
	}
}

if (problems.length) {
	for (const problem of problems) { console.error(`verify-dist: FAIL ${problem}`); }
	process.exit(1);
}
console.log(`verify-dist: ${path.relative(REPO, DIR)}/ is a production build (${files.length} files, version ${manifest.version})`);
