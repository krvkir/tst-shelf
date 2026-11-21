/** Mirrors the background's phase into the page title (readable from
 *  chrome with `browserEl.contentTitle` even for a remote page) and
 *  renders the saved events when they arrive. */
browser.storage.local.get().then(render).catch(error => {
	document.title = `probe storage error: ${error}`;
});
setInterval(() => browser.storage.local.get().then(render).catch(() => {}), 1000);

function render ({ phase, eventCount, events, mainError, downloadError, }) {
	document.title = `probe:${phase || "?"}:events=${(events || []).length}:${eventCount ?? 0}${mainError ? " ERR " + mainError.slice(0, 80) : ""}${downloadError ? " DLERR " + String(downloadError).slice(0, 80) : ""}`;
	document.getElementById("out").textContent = events
		? JSON.stringify({ events, mainError, downloadError, }, null, "\t")
		: `phase ${phase}, events so far: ${eventCount ?? 0}`;
}
