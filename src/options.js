// The options: the fold badge mode and the hint settings.  Each is one
// storage.local key, read by the background at boot and on every
// storage.onChanged (live application, no restart).
"use strict";

const BADGE_MODE_KEY = "badgeMode";
const HINT_CHARSET_KEY = "hintCharset";
const HINT_EXCLUDE_SPECIAL_KEY = "hintExcludeSpecialPages";
/** The default the background falls back to (logic.esm.js HINT_CHARSET):
 *  the lowercase letters no default Vimium mapping starts with. */
const DEFAULT_HINT_CHARSET = "acqsew";

function render (mode = "plus") {
	for (const radio of document.querySelectorAll(`input[name="badgeMode"]`)) {
		radio.checked = radio.value === mode;
	}
}

function renderHintOptions (stored) {
	const charset = document.querySelector(`input[name="hintCharset"]`);
	charset.value = typeof stored[HINT_CHARSET_KEY] === "string" && stored[HINT_CHARSET_KEY]
		? stored[HINT_CHARSET_KEY] : "";
	const exclude = document.querySelector(`input[name="hintExcludeSpecialPages"]`);
	exclude.checked = stored[HINT_EXCLUDE_SPECIAL_KEY] !== false;
}

const DEFAULTS = {
	[BADGE_MODE_KEY]: "plus",
	[HINT_CHARSET_KEY]: "",
	[HINT_EXCLUDE_SPECIAL_KEY]: true,
};

browser.storage.local.get(DEFAULTS).then(stored => {
	render(stored[BADGE_MODE_KEY]);
	renderHintOptions(stored);
});
for (const radio of document.querySelectorAll(`input[name="badgeMode"]`)) {
	radio.addEventListener("change", () => browser.storage.local.set({ [BADGE_MODE_KEY]: radio.value, }));
}
document.querySelector(`input[name="hintCharset"]`).addEventListener("change", event => {
	// the background normalizes (unique lowercase letters/digits) and
	// falls back to the default for anything with fewer than two — the
	// field keeps what the user typed so they can see and fix it
	browser.storage.local.set({ [HINT_CHARSET_KEY]: event.target.value.trim(), });
});
document.querySelector(`input[name="hintExcludeSpecialPages"]`).addEventListener("change", event => {
	browser.storage.local.set({ [HINT_EXCLUDE_SPECIAL_KEY]: event.target.checked, });
});
