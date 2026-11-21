## ADDED Requirements

### Requirement: A member's row is absent unless it anchors an expanded subtree
A shelved tab SHALL have a row while it is the active tab or an ancestor of
the active tab, and SHALL have no row otherwise, with one exception: a
shelved tab whose subtree is expanded keeps its row, because that row is what
its children hang from. A row SHALL be removed by hiding the tab through the
browser's tab-hiding API, and SHALL be restored by showing it again. A member
with children therefore takes its row whenever it is activated, and gives it
up again once its subtree has folded.

#### Scenario: A member with children takes its row on activation
- **WHEN** the user activates a shelved tab that has children
- **THEN** its row appears and its subtree unfolds below it

#### Scenario: Its row goes away when another tab is selected
- **WHEN** the user activates a tab that is neither that shelved tab nor one of its descendants
- **THEN** its subtree folds first and only then does its row disappear, so no frame shows a child without its parent

#### Scenario: A member with no children is hidden like any other member
- **WHEN** a childless tab is put on a shelf and is not the active tab
- **THEN** its row is gone and its shelf icon is its whole presentation

#### Scenario: Firefox itself returns the row of an activated childless member
- **WHEN** the user activates a childless shelved tab by its shelf icon
- **THEN** Firefox reveals the hidden tab, so the row comes back for as long as it stays active, and no other row appears

## MODIFIED Requirements

### Requirement: A folded shelf owner reveals only the activated tab's branch
Activating a tab inside a folded shelf owner SHALL make that owner's subtree
visible for exactly one branch: the subtree of the owner's direct child that
leads to the activated tab. Every other descendant of the owner SHALL keep no
row. A row SHALL be taken away by hiding the tab through the tab-hiding API,
never by any other mechanism.

#### Scenario: A shelved tab with children is activated from a folded owner
- **WHEN** the user activates a shelved tab that has children, and its shelf owner is folded
- **THEN** the owner's row stays, the activated tab's row and its subtree appear, and the owner's remaining descendants get no row

#### Scenario: An unshelved sibling of the branch stays invisible
- **WHEN** the owner's subtree contains an ordinary tab that is not on the shelf and not on the activated tab's branch
- **THEN** that tab keeps no row, exactly as when the owner was folded

#### Scenario: The branch is the owner's direct child
- **WHEN** the activated tab is a descendant of the owner's direct child rather than that child itself
- **THEN** the whole subtree of that direct child is revealed, so a nested shelf owner inside it keeps the row its strap lives in

#### Scenario: A childless shelved tab reveals nothing
- **WHEN** the user activates a childless shelved tab whose owner is folded
- **THEN** no owner is expanded and the tree does not move, beyond the row Firefox itself gives back to the newly active tab

#### Scenario: A suppressed sibling is hidden, not merely unstyled
- **WHEN** a row is taken away because a reveal keeps only one branch visible
- **THEN** the tab is hidden through the tab-hiding API, and the extension never reports it as a shelved tab

### Requirement: Reveals work on a companion without row-less tabs
A reveal SHALL remove the other descendants' rows through the tab-hide API.
Those tabs SHALL be tracked separately from shelved tabs, SHALL be restored to
visibility when their reveal ends, and SHALL be restored after a restart even
if the browser stopped while a reveal was running.

#### Scenario: A stock Tree Style Tab reveals one branch
- **WHEN** a tab inside a folded owner is activated
- **THEN** the owner's row and the activated tab's branch appear, and the owner's other descendants are hidden so they have no rows

#### Scenario: Ending the reveal gives the hidden tabs back
- **WHEN** the reveal ends
- **THEN** every tab the reveal hid becomes visible again, and no tab stays hidden because of a reveal

#### Scenario: A restart during a reveal leaves no invisible tab
- **WHEN** the browser stops while a reveal keeps tabs hidden, and the extension starts again
- **THEN** those tabs are made visible at boot, because reveals are runtime state and never survive a restart

#### Scenario: Hidden-by-reveal is not hidden-by-shelf
- **WHEN** a reveal hides a tab that is not on any shelf
- **THEN** that tab is not treated as a shelved tab whose icon must stay on a shelf, and it is not shown again by the member reconcile

## REMOVED Requirements

### Requirement: A failed row removal is retried against observed reality
**Reason**: The retry existed because a `row-less` state lives in TST's own
tab model and a sidebar that attaches late imports only TST's safe states, so
the state could be silently dropped and the tab rendered anyway. The
`hidden` flag of a tab is browser-level: a sidebar import cannot drop it, and
nothing renders a hidden tab. There is no failure to detect, so there is
nothing to retry.

**Migration**: No action. The bounded retry counter per tab
(`MAX_ROW_LESS_TRIES`) and the flag that forced a full re-application when a
sidebar appeared (`forceRowLessResync`) are removed with it. The renderer
still re-sends the *owner's* `tst-shelf-owner` state class on a late sidebar,
because that state does live in TST's model.
