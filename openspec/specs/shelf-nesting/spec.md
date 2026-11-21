# shelf-nesting Specification

## Purpose
TBD - created by archiving change add-shelf-foundation. Update Purpose after archive.
## Requirements
### Requirement: Children of a shelved tab stay hidden until it is selected on the shelf
The extension SHALL hide the rows of a shelved tab's child tabs in the sidebar tree while the shelved tab is not the selected tab of its shelf, and SHALL show them while it is.

#### Scenario: An unselected shelved tab hides its children
- **WHEN** a shelved tab with children is not the selected tab of its shelf
- **THEN** its child rows are not shown in the tree

#### Scenario: Selecting the shelved tab reveals its children
- **WHEN** a shelved tab with children becomes the selected tab of its shelf
- **THEN** its child rows appear in the tree directly under the shelf

### Requirement: Unfolded children appear below the shelf with normal tree indentation
The extension SHALL show the unfolded children of a selected shelved tab as regular tree rows directly below the shelf area, with the indentation the tabs have as the shelved tab's descendants, so the shelf visually acts as their parent row.

#### Scenario: Unfolded children render under the shelf in order
- **WHEN** the selected shelved tab has children and they are unfolded
- **THEN** the child rows render directly below the shelf's icon rows, indented as descendants of the shelved tab
- **AND** the owner's other children rows follow below them

### Requirement: One subtree is visible at a time per shelf
The extension SHALL unfold at most one shelved tab's subtree per shelf at any time: selecting a different tab of the same shelf SHALL fold the previously selected tab's children back.

#### Scenario: Selecting another shelf tab swaps the unfolded subtree
- **WHEN** shelf tab A's children are unfolded and the user selects shelf tab B on the same shelf
- **THEN** A's child rows hide and B's child rows show, if B has children

### Requirement: A shelved tab's subtree is unfolded only while that tab's own row is shown
The extension SHALL fold the subtree of a shelved tab whenever that tab's own row is not shown in the tree. A shelved tab keeps its row only while it is the active tab or an ancestor of the active tab; in every other state its descendants would render below the shelf with no parent row above them.

#### Scenario: Activating an unrelated tab folds the subtree
- **WHEN** a shelf tab's children are unfolded and the user activates a tab that is neither that tab nor one of its descendants
- **THEN** the shelf tab's child rows hide, and the shelf tab's own row is reclaimed only after they are gone
- **AND** no frame of the transition shows a child row while the shelf tab's row is absent

#### Scenario: Activating a child of the shelved tab keeps it unfolded
- **WHEN** the active tab is a child of the shelved tab and the user switches to another child of the same shelved tab
- **THEN** the shelved tab keeps its row and its children stay visible

#### Scenario: The fold state survives a browser restart
- **WHEN** the browser restarts with session restore
- **THEN** the shelved tab's folded state is the one TST persisted, and the subtree of the member that is active again is unfolded

### Requirement: A selected shelved tab unfolds its own nested shelf under the parent shelf
The extension SHALL hide the shelf owned by a shelved tab while that tab is not selected on its parent's shelf, and SHALL show that nested shelf directly below the parent shelf area when the tab is selected, so a selected shelved tab presents its own shelf and then its children in the order they would have as regular rows.

#### Scenario: A nested shelf is hidden while its owner is folded
- **WHEN** a shelved tab owns a shelf of its own and is not the selected tab of its parent's shelf
- **THEN** its own shelf icons are not shown anywhere in the tree

#### Scenario: Selecting the nested shelf's owner reveals it below the parent shelf
- **WHEN** a shelved tab that owns a shelf becomes the selected tab of its parent's shelf
- **THEN** its own shelf icons render directly below the parent shelf's icon rows
- **AND** its children rows follow below them with normal indentation

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

