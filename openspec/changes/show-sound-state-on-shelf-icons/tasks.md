# Tasks: show-sound-state-on-shelf-icons

## 1. Pure rendering

- [x] 1.1 `iconHtml` renders the audio span with `part="shelf-sound"` for the playing and muted states (input: a sound-state argument derived from `tab.audible` / `tab.mutedInfo`)
- [x] 1.2 SHELF_STYLE: the two indicator rules (mask-image data URL, `background-color: currentColor`, the inline-start bottom corner, absolute, no layout effect)
- [x] 1.3 unit tests in `tests/render.test.mjs`: playing, muted, silent (no span), favicon style unaffected

## 2. Background wiring

- [x] 2.1 `extra-contents-mousedown`: branch on `originalTargetPart == "shelf-sound"` → `browser.tabs.update(tabId, { muted: !muted })`, return true before the selection path
- [x] 2.2 verify the `tabs.onUpdated` shelved branch schedules the re-derivation on `audible` / `mutedInfo` changes (it does — pin it in the E2E)

## 3. Verification

- [x] 3.1 probe: does headless Firefox report `audible: true` for a playing tab? (smoke page starts an `AudioContext`; record the result in the README)
- [x] 3.2 E2E: mute a shelved tab through the test API → the icon shows the muted indicator in the sidebar DOM; unmute → it disappears
- [x] 3.3 E2E: clicking the indicator (synthetic mousedown on the `shelf-sound` part) toggles mute and does NOT change the active tab
- [x] 3.4 E2E: if the probe reports headless `audible`, assert the playing indicator too; otherwise document the manual `make iso-tst` check
- [x] 3.5 two consecutive clean `make e2e` runs

## 4. Documentation

- [x] 4.1 README: the indicator, the headless-audio measurement, the click-to-mute behavior
- [ ] 4.2 version bump in `src/manifest.json` and `package.json` together (release checklist)
