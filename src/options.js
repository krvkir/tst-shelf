// The fold badge mode: one storage.local key, read by the background at
// boot and on every storage.onChanged (live application, no restart).
"use strict";

const BADGE_MODE_KEY = "badgeMode";

function render (mode = "plus") {
	for (const radio of document.querySelectorAll(`input[name="badgeMode"]`)) {
		radio.checked = radio.value === mode;
	}
}

browser.storage.local.get({ [BADGE_MODE_KEY]: "plus", }).then(stored => {
	render(stored[BADGE_MODE_KEY]);
});
for (const radio of document.querySelectorAll(`input[name="badgeMode"]`)) {
	radio.addEventListener("change", () => browser.storage.local.set({ [BADGE_MODE_KEY]: radio.value, }));
}
