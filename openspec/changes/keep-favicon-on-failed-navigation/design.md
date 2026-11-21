# Design: keep-favicon-on-failed-navigation

## Context

`resolveFavicons` (logic.esm.js) fills blanks from a per-session
`Map<tabId, url>`: a tab without `favIconUrl` renders the remembered one,
a tab with one overwrites the memory. That covers the *loading* case only.
A failed navigation is different: Firefox may deliver a truthy
default-icon URL (or keep the last value standing while the tab shows an
error page), and a truthy value overwrites the memory today. The converse
trap: after a *successful* cross-site navigation to an iconless page,
keeping the old site's favicon would be a lie — the memory must reset
there.

TST's own rows are sticky the same way for the loading case only
(tabs-update.js propagates only explicit `favIconUrl` changeInfo, and a
row's `_favIconUrl ||= raw.favIconUrl` never lets a null win); the README
documents the same contract for the strap.

## Goals / Non-Goals

- Goal: the shelf icon never regresses to the browser-default icon
  because a page failed to load.
- Goal: the memory never carries one site's favicon onto another site's
  page (a successful navigation resets it).
- Non-goal: detecting icons that fail to *decode* — a `background-image`
  load failure is invisible to the background. Documented in the README
  as out of scope.
- Non-goal: favicons for non-shelved tabs; TST's rows keep their own
  stickiness.

## Decisions

1. **Measured, then frozen.** The probe (tasks 1.1/1.2) ran as
   `tests/probe-favicon.mjs` — a throwaway-profile WebExtension
   (tests/probe-favicon-addon/) driven through the repo's Marionette
   client against an inline HTTP server; its full timeline is in
   2026-11-21-fixes/favicon-probe.json (Firefox 158.0, headless). Facts:
   a connection-refused navigation settles as `status: complete` with
   `favIconUrl = chrome://global/skin/icons/info.svg` (the error page's
   own icon, the "circled i" users see) while `tab.url` still names the
   site; a page that loads successfully without a favicon delivers
   nothing at any point; site SVG/PNG icons are delivered as
   `data:image/svg+xml;base64,…` (so `data:` is a REAL favicon here);
   a hidden tab keeps reporting its favicon (shelf members included);
   headless Firefox reports `audible: false` for a looping `<audio>`
   page.
2. **The memory grows, not multiplies.** The per-tab memory value is
   `{favIconUrl, pageUrl}`: the page URL decides whether a *missing*
   favicon is a load in progress (non-HTTP page or still loading —
   keep) or a foreign settled document (HTTP(S) url of another origin
   at `complete` — drop). One state key, session-scoped, never
   persisted — presentation memory, not tab state.
3. **Placeholder deliveries never win.** A delivery whose URL matches
   the Firefox skin-icons blocklist (`chrome://global/skin/icons/*` —
   info.svg is the measured error-page icon — and `moz-anno:`) neither
   overwrites the memory nor wins the render; the remembered site icon
   keeps showing, which is the failed-navigation contract. `data:` urls
   are never placeholders.
4. **Reset on successful navigation only for HTTP(S) documents.** A page
   settled at `complete` with no delivery drops the remembered icon
   when its url is an HTTP(S) url of another origin; `about:blank` and
   internal pages are not site documents (the E2E parks shelved tabs on
   about:blank and expects the icon to stay). Rejected: persisting
   favicons across restarts — a boot has no icon to show until the tab
   loads anyway, and session scope keeps the
   only-stored-state-is-the-sticky-flag discipline.

## Risks / Trade-offs

- [Firefox's reporting differs by failure kind] → the probe covers the
  refused connection first (deterministic); DNS and proxy failures ride
  the same `status` path and are asserted only if the headless harness
  can produce them.
- [The blocklist misses a future default-icon URL] → the predicate is
  one pure function with a unit test per known URL; an unlisted default
  degrades to the pre-change behaviour (blank icon), never to a wrong
  icon.

## Open Questions

- None. (The probe answered it: Firefox 158 delivers
  `chrome://global/skin/icons/info.svg` as `favIconUrl` for an error
  page while `url` keeps naming the site, and the page settles at
  `status: complete`; iconless successful pages deliver nothing.
  tests/probe-favicon.mjs, timeline saved in
  2026-11-21-fixes/favicon-probe.json.)
