## ADDED Requirements

### Requirement: A folded shelf owner reveals only the activated tab's branch
When the companion supports row-less tabs, activating a tab inside a folded shelf owner SHALL make that owner's subtree visible for exactly one branch: the subtree of the owner's direct child that leads to the activated tab. Every other descendant of the owner SHALL keep no row.

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
- **THEN** no owner is expanded, no row appears anywhere, and the tree does not move

#### Scenario: A reveal never hides a tab
- **WHEN** a row is taken away because a reveal keeps only one branch visible
- **THEN** the tab is not hidden through the tab-hide API, and the tab remains reachable through its shelf icon

### Requirement: A reveal ends when it stops being needed
A reveal SHALL end when the active tab is no longer a descendant of its owner, when the owner is closed, or when the user folds the owner. Ending a reveal SHALL fold the owner back to the state it had before the reveal, and SHALL restore every row the reveal suppressed.

#### Scenario: Activating a tab outside the owner's subtree restores the fold
- **WHEN** the user activates a tab outside the owner's subtree
- **THEN** the owner is folded again, the suppressed rows stay absent, and no tab gains a row it did not have before the reveal

#### Scenario: The user's own fold wins
- **WHEN** the user folds the owner that a reveal is keeping expanded
- **THEN** the reveal ends, the suppressed rows come back into the model, and the extension does not expand the owner again

#### Scenario: Leaving the subtree does not flash rows
- **WHEN** a reveal ends
- **THEN** the suppressed rows stay suppressed for the length of the companion's collapse animation, so no row is painted under a fold that is already closing

### Requirement: Reveals work on a companion without row-less tabs
When the companion lacks row-less tabs, the extension SHALL still reveal exactly one branch of a folded owner, removing the other descendants' rows through the tab-hide API. Those tabs SHALL be tracked separately from shelved tabs, SHALL be restored to visibility when their reveal ends, and SHALL be restored after a restart even if the browser stopped while a reveal was running.

#### Scenario: A stock Tree Style Tab reveals one branch
- **WHEN** a tab inside a folded owner is activated on a companion without row-less tabs
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

### Requirement: A failed row removal is retried against observed reality
When the companion reports that a tab without a row was rendered anyway, the extension SHALL re-apply the row removal, a bounded number of times per tab, instead of trusting its own bookkeeping.

#### Scenario: A late-opened sidebar renders rows for row-less tabs
- **WHEN** a sidebar renders tabs the extension keeps row-less
- **THEN** the extension re-applies the row removal, so the settled sidebar shows no row for them
