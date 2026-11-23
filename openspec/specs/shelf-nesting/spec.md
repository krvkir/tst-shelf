# shelf-nesting Specification

## Purpose
TBD - created by archiving change add-shelf-foundation. Update Purpose after archive.
## Requirements
### Requirement: Children of a shelved tab stay hidden until it is selected on the shelf
The extension SHALL hide the rows of a shelved tab's child tabs in the sidebar
tree while the shelved tab is neither the selected tab of its shelf nor the
preserved pre-drag selection of an unresolved TST drag, and SHALL show them
while it is selected or preserved. During such a drag, activating another
member of the same shelf SHALL NOT hide children that were visible for the
pre-drag selection. The exception SHALL end when the click, canceled drag, or
completed drop resolves.

#### Scenario: An unselected shelved tab hides its children
- **WHEN** a shelved tab with children is neither the selected tab of its shelf nor preserved by an unresolved TST drag
- **THEN** its child rows are not shown in the tree

#### Scenario: Selecting the shelved tab reveals its children
- **WHEN** a shelved tab with children becomes the selected tab of its shelf
- **THEN** its child rows appear in the tree directly under the shelf

#### Scenario: Dragging another icon of the same shelf preserves the existing children
- **GIVEN** shelved tab A is selected and its children are visible
- **WHEN** the user starts dragging another member of the same shelf by its icon
- **THEN** A's children remain visible until the drag resolves
- **AND** the ordinary shelf-selection choreography applies to the dragged member without prematurely reclaiming A's row

### Requirement: Unfolded children appear below the shelf with normal tree indentation
The extension SHALL show the unfolded children of a selected shelved tab as regular tree rows directly below the shelf area, with the indentation the tabs have as the shelved tab's descendants, so the shelf visually acts as their parent row.

#### Scenario: Unfolded children render under the shelf in order
- **WHEN** the selected shelved tab has children and they are unfolded
- **THEN** the child rows render directly below the shelf's icon rows, indented as descendants of the shelved tab
- **AND** the owner's other children rows follow below them

### Requirement: One subtree is visible at a time per shelf
The extension SHALL unfold at most one shelved tab's subtree per shelf after
an interaction has settled: selecting a different tab of the same shelf SHALL
fold the previously selected tab's children back. During an unresolved TST
drag, the extension SHALL permit the pre-drag selected subtree and the active
dragged shelf member's subtree to be visible together; this exception SHALL be
limited to the preserved branch and the dragged member's existing selection
choreography, and SHALL end when the gesture resolves.

#### Scenario: Selecting another shelf tab swaps the unfolded subtree
- **WHEN** shelf tab A's children are unfolded and the user selects shelf tab B on the same shelf without an unresolved drag preservation
- **THEN** A's child rows hide and B's child rows show, if B has children

#### Scenario: An icon drag can temporarily show the source and previous subtrees
- **GIVEN** shelf tab A's children are unfolded
- **WHEN** the user starts dragging shelf tab B of the same shelf and B's existing selection path unfolds B
- **THEN** A's children remain available during the drag instead of folding at grasp
- **AND** the temporary second subtree is limited to B's normal selection result

#### Scenario: Resolving an icon drag restores one selected subtree
- **GIVEN** an icon drag temporarily preserved A's subtree while B was selected
- **WHEN** the drag resolves
- **THEN** the shelf again has at most one unfolded member subtree, chosen by the current active branch and ordinary selection rules

### Requirement: A shelved tab's subtree is unfolded only while that tab's own row is shown
The extension SHALL fold the subtree of a shelved tab whenever that tab's own
row is not shown in the tree. A shelved tab keeps its row while it is the
active tab or an ancestor of the active tab; in every other settled state its
descendants would render below the shelf with no parent row above them. While
a TST drag preserves the pre-drag active branch, each shelved ancestor on that
branch SHALL retain its row and unfolded subtree, so the exception never
shows children without their parent row.

#### Scenario: Activating an unrelated tab folds the subtree
- **WHEN** a shelf tab's children are unfolded and the user activates a tab that is neither that tab nor one of its descendants without starting a TST drag
- **THEN** the shelf tab's child rows hide, and the shelf tab's own row is reclaimed only after they are gone
- **AND** no frame of the transition shows a child row while the shelf tab's row is absent

#### Scenario: A drag-related unrelated activation waits for the gesture to resolve
- **WHEN** grasping or dragging another TST tab activates a tab outside the previously active shelf tab's subtree
- **THEN** the previous shelf tab's child rows and parent row remain present during the provisional hold
- **AND** they fold in the existing child-first order if the resolved active tab remains outside that subtree

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
visible for exactly one branch after activation has settled: the subtree of
the owner's direct child that leads to the activated tab. Every other
descendant of the owner SHALL keep no row. During an unresolved TST drag that
preserves a pre-drag active branch beneath the same owner, the owner SHALL
instead reveal the union of that preserved branch and the current active
branch, while every descendant outside both branches keeps no row. A row
SHALL be taken away by hiding the tab through the tab-hiding API, never by any
other mechanism.

#### Scenario: A shelved tab with children is activated from a folded owner
- **WHEN** the user activates a shelved tab that has children, and its shelf owner is folded
- **THEN** the owner's row stays, the activated tab's row and its subtree appear, and the owner's remaining descendants get no row

#### Scenario: An unshelved sibling of the branch stays invisible
- **WHEN** the owner's subtree contains an ordinary tab that is not on the shelf and not on an active or drag-preserved branch
- **THEN** that tab keeps no row, exactly as when the owner was folded

#### Scenario: The branch is the owner's direct child
- **WHEN** the activated tab is a descendant of the owner's direct child rather than that child itself
- **THEN** the whole subtree of that direct child is revealed, so a nested shelf owner inside it keeps the row its strap lives in

#### Scenario: A nested drag preserves both required branches
- **GIVEN** a folded-owner reveal is showing the pre-drag active branch beneath owner O
- **WHEN** a TST drag activates another branch beneath O
- **THEN** O remains expanded and both the pre-drag branch and the dragged tab's required branch remain renderable until the gesture resolves
- **AND** descendants outside both branches remain suppressed

#### Scenario: A childless shelved tab reveals nothing
- **WHEN** the user activates a childless shelved tab whose owner is folded
- **THEN** no owner is expanded and the tree does not move, beyond the row Firefox itself gives back to the newly active tab

#### Scenario: A suppressed sibling is hidden, not merely unstyled
- **WHEN** a row is taken away because a reveal keeps only the active and any drag-preserved branches visible
- **THEN** the tab is hidden through the tab-hiding API, and the extension never reports it as a shelved tab

### Requirement: A reveal ends when it stops being needed
A reveal SHALL end when neither the current active tab nor the preserved
pre-drag active tab of an unresolved TST drag is a descendant of its owner,
when the owner is closed, or when the user folds the owner. Resolving a click,
canceled drag, or completed drop SHALL remove the preserved pre-drag anchor;
the reveal SHALL then end if the current active tab is outside the owner.
Ending a reveal SHALL fold the owner back to the state it had before the
reveal, and SHALL restore every row the reveal suppressed.

#### Scenario: Activating a tab outside the owner's subtree restores the fold
- **WHEN** the user activates a tab outside the owner's subtree without a TST drag preserving a branch beneath that owner
- **THEN** the owner is folded again, the suppressed rows stay absent, and no tab gains a row it did not have before the reveal

#### Scenario: A drag outside a revealed owner does not end its reveal at grasp
- **GIVEN** an active reveal beneath owner O is needed for the pre-drag branch
- **WHEN** grasping another tab activates a tab outside O and starts a drag
- **THEN** O's reveal remains until the drag resolves
- **AND** an outside drop or cancellation subsequently ends the reveal through the ordinary prune path

#### Scenario: The user's own fold wins
- **WHEN** the user folds the owner that a reveal is keeping expanded, including during a drag hold
- **THEN** the reveal ends, the suppressed rows come back into the model, and the extension does not expand the owner again

#### Scenario: Leaving the subtree does not flash rows
- **WHEN** a reveal ends, including when a drag hold is released
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

### Requirement: A primary-button TST drag preserves the previously active shelved subtree
The extension SHALL preserve the active shelved branch during a primary-button TST drag.
When the user begins the interaction on a TST tab row or shelf icon while a
shelved tab's subtree is visible on the active tab's ancestor branch, the
extension SHALL preserve that branch until the interaction
resolves as a click, a canceled drag, or a completed drop. Preservation SHALL
keep the required shelved rows visible, keep their already-unfolded subtrees
unfolded, and retain any enclosing folded-owner reveal. It SHALL NOT cancel
TST's ordinary row activation or native drag operation.

#### Scenario: Grasping an ordinary tab does not remove the drop destination
- **GIVEN** shelved tab A is active or has the active tab as a descendant, and A's subtree is visible
- **WHEN** the user presses and drags another tab's regular TST row
- **THEN** A's row and subtree remain available as drop targets throughout the drag

#### Scenario: Grasping a shelf icon preserves the previously visible branch
- **GIVEN** shelved tab A's subtree is visible on the active branch
- **WHEN** the user starts TST's native drag from another shelved tab's icon
- **THEN** A's subtree remains visible during the drag
- **AND** the icon still drags its own tab with TST's native subtree semantics

#### Scenario: A plain click preserves the old branch only until mouseup
- **GIVEN** a primary-button mousedown provisionally preserved A's subtree
- **WHEN** the user releases the button without starting a drag
- **THEN** the ordinary activation rules run against the clicked tab
- **AND** A's subtree folds if the clicked tab is outside A's subtree

#### Scenario: Activation outside a TST pointer gesture keeps the existing behavior
- **GIVEN** A's subtree is visible
- **WHEN** an unrelated tab becomes active through keyboard switching or a programmatic activation rather than a TST row or shelf-icon mousedown
- **THEN** A's subtree folds immediately under the existing activation rules, without a provisional preservation interval

### Requirement: Resolving a drag reapplies visibility from the active tab's new ancestry
When a TST tab drag resolves, the extension SHALL discard the preserved
pre-drag branch and SHALL derive visibility from the current active tab and
the fresh tree. The transition SHALL wait until the drop's structural result
is observable, rather than folding and reopening a destination merely because
a drag-end notification arrived first. Every provisional hold SHALL be
bounded and runtime-only.

#### Scenario: Dropping inside the preserved subtree keeps it visible
- **GIVEN** A's visible subtree was preserved while another active tab was dragged
- **WHEN** the dragged tab lands inside A's subtree
- **THEN** A and the ancestors needed to render it keep their rows
- **AND** A's subtree remains visible because the active dragged tab is now inside it

#### Scenario: Dropping outside the preserved subtree folds it once
- **GIVEN** A's visible subtree was preserved while another active tab was dragged
- **WHEN** the dragged tab lands outside A's subtree
- **THEN** A's subtree folds under the ordinary rules after the drop is observable
- **AND** A's row is reclaimed only after its children have folded away

#### Scenario: Canceling a drag restores the ordinary outside-subtree result
- **GIVEN** grasping another tab provisionally preserved A's subtree
- **WHEN** the drag is canceled without a tree mutation and the dragged tab remains active outside A's subtree
- **THEN** the preservation ends and A folds under the ordinary rules

#### Scenario: Closing the window discards drag preservation
- **WHEN** a window with an unresolved drag hold closes
- **THEN** its hold is discarded with the window's other runtime state
- **AND** no drag hold is persisted or restored after a restart

### Requirement: Dropping an active tab on a folded shelved tab's regular row reveals the target subtree
The target subtree SHALL unfold when an active dragged tab lands on a folded shelved tab's visible regular row.
When TST attaches the active dragged tab beneath that shelved tab, the active
child and its required ancestors SHALL remain visible after the drop. The extension SHALL use the resulting TST
parent relationship to recognize the attachment; it SHALL NOT infer a shelved
favicon target that TST did not provide.

#### Scenario: An active tab lands on a visible folded shelved row
- **GIVEN** shelved tab A has a folded subtree and a visible regular row
- **WHEN** the active dragged tab is dropped onto A's regular row so TST attaches it as A's child
- **THEN** A's subtree unfolds through TST's attachment flow
- **AND** the new child, A, and every ancestor required to render them remain visible after the drop settles

#### Scenario: Attachment beneath a folded shelved tab is identified by its new parent
- **GIVEN** a drag hold is settling or a drop is being reconciled
- **WHEN** TST reports that the dragged tab's new parent is shelved tab A and A's subtree was folded
- **THEN** the extension recognizes the result as an attachment beneath a folded shelved tab
- **AND** the final derivation uses that actual parent relationship regardless of the pointer's original position within TST's drop zones

