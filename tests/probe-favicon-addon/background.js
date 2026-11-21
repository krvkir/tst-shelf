/**
 * Drives its own windows and records every tabs.onUpdated field that
 * matters to tst-shelf's derivations: favIconUrl timeline, status,
 * audible and muted on a failed navigation, a successful iconless page,
 * a reload of an unreachable site, and a playing <audio loop>.
 * Findings are written to storage.local and rendered by report.html.
 */
"use strict";

const events = [];
const record = (k, fields) => events.push({ t: Date.now(), k, ...fields });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function q (tab) {
	return {
		id: tab.id,
		url: tab.url,
		status: tab.status,
		favIconUrl: tab.favIconUrl ?? null,
		audible: tab.audible,
		muted: !!tab.mutedInfo?.muted,
		title: tab.title,
	};
}

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	record("onUpdated", {
		id: tabId,
		change: {
			pinned: changeInfo.pinned ? true : undefined,
			hidden: changeInfo.hidden,
			status: changeInfo.status,
			url: changeInfo.url,
			favIconUrl: changeInfo.favIconUrl,
			audible: changeInfo.audible,
			muted: changeInfo.mutedInfo ? changeInfo.mutedInfo.muted : undefined,
		},
		query: q(tab),
	});
});

browser.windows.onRemoved.addListener(() => events.length); // no-op, keeps the linter honest

async function firstTabOf (winId, tries = 20) {
	for (let i = 0; i < tries; i++) {
		const tab = (await browser.tabs.query({ windowId: winId, }))[0];
		if (tab) { return tab; }
		await sleep(500);
	}
	throw new Error("window never got a tab");
}

async function main () {
	// the report page opens FIRST and mirrors the live phase into its
	// title, so a chrome-side observer sees where the timeline is even
	// when the final download never lands
	await browser.tabs.create({ url: browser.runtime.getURL("report.html"), });
	const save = phase => browser.storage.local.set({ phase, eventCount: events.length, }).catch(() => {});
	await save("boot");
	record("note", { text: "probe alive" });
	const win = await browser.windows.create({ url: "about:blank", });
	await sleep(500);
	const firstTab = await firstTabOf(win.id);
	record("snapshot", { phase: "initial", tab: q(await browser.tabs.get(firstTab.id)), });

	// 1. a successful load of an iconless page (text/plain, no favicon)
	await save("phase1-navigating");
	await browser.tabs.update(firstTab.id, { url: "http://127.0.0.1:8123/plain.txt", });
	await sleep(2500);
	record("snapshot", { phase: "after-successful-plain", tab: q(await browser.tabs.get(firstTab.id)), });
	await save("phase1-done");

	// 2. navigate to a refused port (connection error)
	await save("phase2-navigating");
	await browser.tabs.update(firstTab.id, { url: "http://127.0.0.1:9/", });
	await sleep(3000);
	record("snapshot", { phase: "after-refused", tab: q(await browser.tabs.get(firstTab.id)), });
	await save("phase2-done");

	// 3. reload the refused page
	await save("phase3-navigating");
	await browser.tabs.reload(firstTab.id).catch(error => record("note", { text: `reload threw ${error}`, }));
	await sleep(3000);
	record("snapshot", { phase: "after-reload-refused", tab: q(await browser.tabs.get(firstTab.id)), });
	await save("phase3-done");

	// 4. recovery: a successful load after the failure
	await save("phase4-navigating");
	await browser.tabs.update(firstTab.id, { url: "http://127.0.0.1:8123/plain.txt", });
	await sleep(2500);
	record("snapshot", { phase: "after-recovery", tab: q(await browser.tabs.get(firstTab.id)), });
	await save("phase4-done");

	// 5. a favicon that IS delivered, then a new document on the same tab
	await save("phase5-navigating");
	const imageTab = await browser.tabs.create({ windowId: win.id, url: "http://127.0.0.1:8123/with-favicon.html", active: false, });
	await sleep(2500);
	record("snapshot", { phase: "after-favicon-site", tab: q(await browser.tabs.get(imageTab.id)), });
	await save("phase5-done");

	// 6. audio: the <audio loop> page plays; then the tab is muted
	await save("phase6-navigating");
	const audioTab = await browser.tabs.create({ windowId: win.id, url: "http://127.0.0.1:8123/audio.html", active: false, });
	await sleep(3000);
	record("snapshot", { phase: "audio-playing", tab: q(await browser.tabs.get(audioTab.id)), });
	await browser.tabs.update(audioTab.id, { muted: true, });
	await sleep(1500);
	record("snapshot", { phase: "audio-muted", tab: q(await browser.tabs.get(audioTab.id)), });
	await browser.tabs.remove(audioTab.id).catch(() => {});
	await save("phase6-done");

	// 7. favIconUrl of a tab that is HIDDEN (as shelf members are)
	await save("phase7-navigating");
	const hiddenProbe = await browser.tabs.create({ windowId: win.id, url: "http://127.0.0.1:8123/with-favicon.html", active: false, });
	await sleep(1500);
	await browser.tabs.hide([hiddenProbe.id,]);
	await sleep(1000);
	record("snapshot", { phase: "after-hide", tab: q(await browser.tabs.get(hiddenProbe.id)), });
	await browser.tabs.remove(hiddenProbe.id).catch(() => {});
	await save("phase7-done");

	// the report: download through the proven channel, storage as backup
	await save("downloading");
	try {
		const text = JSON.stringify({ events: [...events, ], mainError: null, }, null, "\t");
		let url = null;
		try { url = URL.createObjectURL(new Blob([text], { type: "application/json", })); }
		catch (_e) { url = `data:application/json;base64,${btoa(unescape(encodeURIComponent(text)))}`; }
		await browser.downloads.download({
			url, filename: "favicon-probe.json", conflictAction: "overwrite", saveAs: false,
		});
		await save("download-started");
	}
	catch (error) {
		await browser.storage.local.set({ downloadError: String(error), });
		await save("download-threw");
	}
}
main().catch(error =>
	browser.storage.local.set({ events, phase: "main-threw", mainError: String(error && error.stack || error), })
		.catch(() => {}));
