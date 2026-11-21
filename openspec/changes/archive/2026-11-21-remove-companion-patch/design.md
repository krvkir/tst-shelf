## Decisions

### The stock path is the specification, not a fallback

The removal was scoped as "delete the patched branches, keep the stock
branches byte-for-byte". Every stock code path — the hide-based member
reconcile, the hide-based reveal suppression, the collapse guard, the
placement loop, the retry of a failed tree export — keeps its current
ordering, its current error handling and its current log keys. The E2E
comparison is the acceptance test: the stock run must report the same
assertions with the same outcomes before and after.

### One row-removal lever, because three mechanisms were one mechanism

The addon had two ways to take a row away (TST's `row-less` state and
`browser.tabs.hide()`) and kept four structures to stay honest about which
was in use: `rowLessByUs`, `suppressedByUs`, `rowLessTries` and
`forceRowLessResync`. They existed for one reason: a TST state lives in the
sidebar's imported model, so a sidebar that attaches late can lose it, and
nothing paints a row that is not in the model. Hiding has no such failure
mode — `hidden` is a browser-level flag, and TST filters hidden tabs out of
its renderable set on every render. Deleting the state lever deletes the
bookkeeping with it, not just the branch.

### The configuration axis goes with the capability

`shelf-layout` had three values and two meanings: without the `lines`
capability, `auto` and `extend` both mean "keep one line and scroll". A
setting that cannot change behaviour is a support burden with no payoff, so
it is deleted rather than reduced to one value. The stored key is left in
`storage.local` untouched — writing a migration for a key nobody reads would
add code to a change whose purpose is to remove code.

### A childless member's reveal guard is kept, though its comment was wrong

`maybeBeginReveal` bails out for a childless member with the comment "a
childless member never has a row (feature 1)". The claim is false on a stock
TST — Firefox reveals a hidden tab the moment it is activated, so the member
does get a row. The guard itself is still right: a childless member has no
subtree to reveal, so TST's ancestor expansion has nothing to take over, and
cancelling it would make the extension expand a folded owner for no reason.
The guard stays; the comment is rewritten to state what the code actually
relies on. Whether a childless member should start a reveal at all is a
separate question and is out of scope here.

### `tabHide` is not cleaned up

It looks like a leftover of the fallback path, but it is now the only lever:
member rows, and every row a reveal suppresses. It stays in the manifest.

## What stays untouched, and why it looks capability-shaped

- `mustShowTabs`, `danglingMembers`, `hideGuard`, `collapseDuration` grace:
  these guard TST's collapse animation and Firefox's "the active tab is
  always visible" rule. Both hold on every TST build.
- `planReveals` and the `try-expand-tree-from-focused-collapsed-tab`
  cancellation: `reveal-folded-owner-branch` decided to hide unshelved
  siblings, which the addon already had the permission for.
- `SUPPRESSED_KEY`, `rememberSuppressed`, `releaseSuppressed`: the crash
  recovery of a reveal. Unchanged.
- `renderer.forceStateResync`: the *owner* state class `tst-shelf-owner` does
  live in TST's model, so a late sidebar still needs the re-send.
- `logic.esm.js` in full: it never mentioned a capability.

## Verification

- `node --test tests/`: 72 tests before and after (one renderer test replaced,
  because the line count is no longer part of a strap's identity).
- `make e2e` against the stock fixture: 101 assertions before, 99 after. The
  two that went are the ones that probed TST's handling of a state the addon
  no longer sends ("B fallback", "clearing row-less brings the row back").
  Everything else passes with the same outcome, including the geometry
  conformance gate, the reveal gates, the nested-shelf gates and the
  reinstall-persistence phase.
