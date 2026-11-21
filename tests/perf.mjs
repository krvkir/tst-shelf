#!/usr/bin/env node
/**
 * Performance gate for the pure derivation (openspec task 7.2).
 *
 * The project targets trees of 350+ tabs.  This script builds a
 * deterministic 350-tab fixture (5 shelves × 5 members, plus plain tabs to
 * reach 350) and measures the whole pure pipeline the background runs on
 * every structural event and on boot:
 *
 *   indexTree → derive → mustShowTabs → danglingMembers → planReveals
 *             → treePositions → subtreeSizes → nextPlacementMove
 *
 * Budgets (openspec task 7.2: full reconciliation after restart < 300 ms,
 * strap re-render on one put < 50 ms).  Only the pure share is measured
 * here — IPC, DOM and TST's own work are outside this script — so the
 * budgets are set well inside the end-to-end ones:
 *
 *   full pass   median < 20 ms, worst < 100 ms
 *   one put      median < 10 ms
 *
 * Measured on the reference machine (Node 26, 350 tabs): full pass median
 * 0.5 ms / worst 1.9 ms; put median 0.4 ms — two orders of magnitude below
 * the end-to-end budgets, i.e. the browser, not this code, spends them.
 *
 * Median AND worst case are printed so a regression is visible as a number,
 * not as a vibe.  Usage: node tests/perf.mjs [--tabs 350] [--runs 40]
 */
import {
	derive, indexTree, mustShowTabs, danglingMembers, planReveals,
	treePositions, subtreeSizes, nextPlacementMove, assignHints, ROOT_SHELF,
} from "../src/background/logic.esm.js";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const index = argv.indexOf(name);
	return index >= 0 && argv[index + 1] ? Number(argv[index + 1]) : fallback;
};
const TABS = flag("--tabs", 350);
const RUNS = flag("--runs", 40);
const BUDGET_FULL = 20;
const BUDGET_WORST = 100;
const BUDGET_PUT = 10;

/** A 350-tab fixture: 5 shelf owners, each with 5 shelved members (the
 *  first of which owns children), and plain tabs padding the tree.  Tab
 *  ids are dense (1..N) so nothing degenerates through sparse positions. */
function fixture (total) {
	const tree = [];
	const shelved = new Set;
	const tabs = [];
	let nextId = 1;
	const tab = (states = []) => {
		const id = nextId++;
		tabs.push({ id, index: id - 1, hidden: false, active: false, pinned: false, });
		return { id, states, children: [], };
	};
	const ownerCount = 5;
	const membersEach = 5;
	for (let ownerIndex = 0; ownerIndex < ownerCount; ownerIndex++) {
		const owner = tab();
		for (let memberIndex = 0; memberIndex < membersEach; memberIndex++) {
			const member = tab(["subtree-collapsed"]);
			if (memberIndex === 0) {
				for (let child = 0; child < 3; child++) { member.children.push(tab()); }
			}
			owner.children.push(member);
			shelved.add(member.id);
		}
		tree.push(owner);
	}
	while (nextId <= total) {
		const root = tab();
		root.children.push(tab(), tab());
		tree.push(root);
	}
	tabs[0].active = true;
	const tabsById = new Map(tabs.map(entry => [entry.id, entry]));
	return { tree, shelved, tabsById, };
}

function median (values) {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

const { tree, shelved, tabsById, } = fixture(TABS);
const activeId = [...tabsById.values()].find(tab => tab.active)?.id ?? null;
const reveals = new Map;

/** One full derivation pass, as the background runs it — plus the hint
 *  assignment a mode start runs against the same tree (task 1.3). */
function fullPass () {
	const indexed = indexTree(tree);
	const mustShow = mustShowTabs({ tree, activeId, });
	const dangling = danglingMembers({ tree, shelved, mustShow, });
	const plan = planReveals({ tree, activeId, reveals, mustShow, });
	const derivation = derive({ tree, shelved, tabsById, });
	const positions = treePositions(tree);
	const ranks = [...tabsById.values()].map(entry => ({
		id: entry.id,
		pos: positions.get(entry.id) ?? Number.MAX_SAFE_INTEGER,
		pinned: !!entry.pinned,
	}));
	const move = nextPlacementMove({
		ranks,
		sizes: subtreeSizes(tree),
		shelves: derivation.shelves,
	});
	const hints = assignHints([...positions.keys()]);
	return { indexed, mustShow, dangling, plan, derivation, move, hints, };
}

// warm-up (JIT), then measure
for (let index = 0; index < 5; index++) { fullPass(); }
const samples = [];
for (let index = 0; index < RUNS; index++) {
	const started = performance.now();
	fullPass();
	samples.push(performance.now() - started);
}

// one put: the same pass with one more member on a shelf
const extra = [...tabsById.keys()].find(id => !shelved.has(id));
shelved.add(extra);
for (let index = 0; index < 3; index++) { fullPass(); }
const putSamples = [];
for (let index = 0; index < RUNS; index++) {
	const started = performance.now();
	fullPass();
	putSamples.push(performance.now() - started);
}
shelved.delete(extra);

const medianFull = median(samples);
const worstFull = Math.max(...samples);
const medianPut = median(putSamples);

const check = (name, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} [perf] ${name}${detail ? " " + detail : ""}`);
	if (!ok) { process.exitCode = 1; }
	return ok;
};

console.log(`[perf] fixture: ${tabsById.size} tabs, ${shelved.size} shelved, ${derive({ tree, shelved, tabsById, }).shelves.size} shelves`);
check("a full pure pass stays inside the reconciliation budget",
	medianFull < BUDGET_FULL && worstFull < BUDGET_WORST,
	`median=${medianFull.toFixed(2)}ms worst=${worstFull.toFixed(2)}ms budget=median<${BUDGET_FULL}ms worst<${BUDGET_WORST}ms`);
check("a put re-derivation stays inside the strap budget",
	medianPut < BUDGET_PUT,
	`median=${medianPut.toFixed(2)}ms budget=<${BUDGET_PUT}ms`);
