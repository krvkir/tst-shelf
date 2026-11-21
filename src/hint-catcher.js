/**
 * The hint-mode key catcher for the ACTIVE PAGE (tab-hints capability).
 *
 * Vimium's link hints work because the keydown listener lives in the
 * document the user types into (content_scripts/link_hints.js — the
 * markers and the key handler share the page's focus).  A companion of
 * Tree Style Tab cannot live there permanently: the labels it must show
 * paint in TST's sidebar, a different document that rarely holds the
 * window focus.  This script is therefore injected ON DEMAND, only
 * while hint mode is up, into the focused window's active tab — legal
 * with zero host permissions because Firefox grants activeTab when the
 * user invokes an extension's keyboard shortcut (commands API; MDN,
 * "How activeTab is granted", Firefox 63+), and `tabs.executeScript` is
 * what activeTab covers in MV2.
 *
 * Contract with the background:
 * - {type:"hint-catcher-arm", modeId} retargets the catcher at a new
 *   mode (a re-entered mode reuses the same listener set).
 * - {type:"hint-catcher-stop", modeId} tears the catcher down; a stop
 *   for a different mode is ignored (the replace race: stop(old) can
 *   land after arm(new)).
 * - Every printable key (single character, no modifiers) plus Escape
 *   and Backspace is forwarded as {type:"hint-catcher-key", key,
 *   repeat} and SUPPRESSED from the page — the mode owns the keyboard
 *   for its lifetime: a custom charset may carry digits, and a key the
 *   mode does not use must not reach the page (or another extension's
 *   single-key handlers) mid-mode; the background drops the unused
 *   ones.  An ack of {ok:false} (mode gone, or a stale catcher) tears
 *   the catcher down, so at most one orphaned key is ever eaten after
 *   a mode dies unseen.
 *
 * Extension pages, about:/chrome: pages, the PDF viewer and reader view
 * cannot be injected (MDN, tabs.executeScript) — the background logs
 * the arming failure and the sidebar's own catcher (extra-contents-
 * keydown) remains the channel there.
 */
(() => {
	// one catcher per document: a re-injection while one is alive just
	// retargets it (the arm message), never stacks listeners — a second
	// listener would double-forward every key
	if (window.__tstShelfHintCatcher) { return; }
	let modeId = null;
	let keyListener = null;
	let messageListener = null;
	const teardown = () => {
		document.removeEventListener("keydown", keyListener, true);
		browser.runtime.onMessage.removeListener(messageListener);
		window.__tstShelfHintCatcher = null;
		modeId = null;
	};
	keyListener = event => {
		// modifier combos belong to the browser (Ctrl+L, Ctrl+Tab…): pass
		// them through untouched, like Vimium's unconsumed keys
		if (event.ctrlKey || event.altKey || event.metaKey) { return; }
		const key = String(event.key || "");
		// every printable key is the mode's: forwarded and suppressed (the
		// background drops the ones no code starts with)
		const isCodeKey = key === "Escape" || key === "Backspace" || key.length === 1;
		if (!isCodeKey) { return; }
		browser.runtime.sendMessage({ type: "hint-catcher-key", key, repeat: !!event.repeat, })
			.then(ack => { if (!ack || !ack.ok) { teardown(); } })
			.catch(() => teardown());
		event.preventDefault();
		event.stopPropagation();
	};
	messageListener = message => {
		if (!message || typeof message !== "object") { return; }
		if (message.type === "hint-catcher-arm") { modeId = message.modeId ?? null; return; }
		if (message.type === "hint-catcher-stop" && message.modeId === modeId) { teardown(); }
	};
	document.addEventListener("keydown", keyListener, true);
	browser.runtime.onMessage.addListener(messageListener);
	window.__tstShelfHintCatcher = { teardown, };
})();
