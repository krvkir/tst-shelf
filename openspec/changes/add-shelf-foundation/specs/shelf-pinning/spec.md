## ADDED Requirements

### Requirement: The tab context menu offers "Put on shelf" for every unshelved tab and "Take off the shelf" for every shelved tab
The extension SHALL add a "Put on shelf" item to the Tree Style Tab tab context menu, offered for every tab that is not on a shelf yet, and a "Take off the shelf" item, offered for every shelved tab. "Take off the shelf" SHALL be the only action that removes a tab from a shelf.

#### Scenario: A regular tab gets "Put on shelf"
- **WHEN** the tab context menu opens on a tab that is not on a shelf
- **THEN** the menu contains "Put on shelf" and no "Take off the shelf"

#### Scenario: A shelved tab gets "Take off the shelf"
- **WHEN** the tab context menu opens on a tab that is on a shelf
- **THEN** the menu contains "Take off the shelf" and no "Put on shelf"

### Requirement: Putting a tab on the shelf removes its row and shows its favicon on the target shelf
The extension SHALL, when the user puts a tab on the shelf, remove that tab's row from the sidebar tree and render the tab as a favicon icon on the shelf of the tab's parent tab, or on the root shelf when the tab has no parent. The tab SHALL stay a regular tab in the native tab bar with unchanged tree relations; its sibling position may be normalized into the owner's member block (see "Shelving keeps the tree structure and reorders only shelf members among their siblings").

#### Scenario: A child tab lands on its parent's shelf
- **WHEN** the user puts a tab that has a parent tab on the shelf
- **THEN** the tab's row disappears from the sidebar tree
- **AND** the parent's shelf appears directly under the parent's row, showing the tab's favicon icon
- **AND** the tab stays at its position as a regular tab in the native tab bar

#### Scenario: A root tab lands on the root shelf
- **WHEN** the user puts a tab without a parent on the shelf
- **THEN** its icon appears on the root shelf at the top of the tab bar instead of in the tree

#### Scenario: Putting a tab with children on the shelf folds them
- **WHEN** the user puts a tab that has child tabs on the shelf
- **THEN** the tab's row disappears and its icon appears on the target shelf
- **AND** its child tabs' rows stay hidden in the tree (they unfold only when the shelved tab is selected)

### Requirement: Shelving keeps the tree structure and reorders only shelf members among their siblings
The extension SHALL NOT change the parent-child relations of any tab: TST's tree data and every tab's native tree relations SHALL remain exactly what they would be without the extension. The extension SHALL keep the members of every shelf contiguous among their owner's children, directly after the owner (root shelf: at the top of the root tabs), newest member last; when a member is out of place, the extension SHALL move it among its siblings via Tree Style Tab's own subtree-preserving move API, leaving the relative order of all non-member tabs unchanged.

#### Scenario: A member is normalized into the block without disturbing others
- **WHEN** a shelved member sits below non-member siblings of its owner
- **THEN** the member moves to the end of the member block, directly under the owner, with its subtree following it
- **AND** the non-member siblings keep their relative order and their children

#### Scenario: A member keeps its parent through the placement move
- **WHEN** the extension repositions a shelved member
- **THEN** the member stays a child of the same owner, and its descendants stay its children

#### Scenario: A tree operation on the shelved tab behaves as on a regular tab
- **WHEN** the user closes, reloads, bookmarks, or otherwise acts on a shelved tab through its context menu or the native tab bar
- **THEN** the operation has exactly its regular effect on the tab, with no shelf-specific differences besides the sidebar row

### Requirement: Taking a tab off the shelf restores its row in the tree
The extension SHALL, when the user takes a shelved tab off the shelf, remove the tab's icon from its shelf and show the tab's row in the sidebar tree as a regular row, restoring the strip position the tab had before it was shelved when the tab still lives in the same window; otherwise the row appears at the tab's current position.

#### Scenario: Taking a tab off the shelf brings the row back where it was
- **WHEN** the user chooses "Take off the shelf" on a shelved tab
- **THEN** the tab's icon disappears from the shelf
- **AND** the tab's row reappears in the tree near the position it had before it was shelved, with its subtree following it

#### Scenario: The last icon removed closes the shelf space
- **WHEN** the user takes the only tab of a shelf off the shelf
- **THEN** the shelf stops reserving space under the owner's row and the tree under the owner closes the gap

### Requirement: Shelved state survives browser restarts with the shelf re-derived from the restored tree
The extension SHALL keep every tab's shelved state, across browser restarts that restore the previous session, and SHALL re-derive each shelved tab's target shelf from the restored tree: the parent tab's shelf, or the root shelf when the tab has no parent.

#### Scenario: Shelves are rebuilt after a restart
- **WHEN** the browser restarts and restores the previous session
- **THEN** every tab that was shelved is shelved again, on the shelf of its parent tab, or on the root shelf if it has no parent
- **AND** tabs that were not shelved appear as regular rows, unchanged

#### Scenario: A restored shelved tab whose parent changed lands on its current parent's shelf
- **WHEN** a session restores a shelved tab whose parent tab is not the parent it had when it was shelved
- **THEN** the tab is shelved on its current parent's shelf, without becoming a visible row

### Requirement: A shelved tab stays shelved when its parent changes
The extension SHALL keep a tab shelved through any change of parent — drag-and-drop, re-parenting, moving to another window — and SHALL move its icon to the shelf of its new parent, or to the root shelf of its window when it becomes a root tab. The extension SHALL NOT unshelve a tab on any structural change.

#### Scenario: A drag from one shelf to another moves the icon
- **WHEN** the user drags a shelf icon and drops it on another visible shelf
- **THEN** the tab stays shelved and its icon appears on the drop-target shelf, with the shelf created for the target tab if it had none
- **AND** the dragged tab's children follow the drag exactly as when a regular tab is dragged to a new parent

#### Scenario: A drag to the root level lands on the root shelf
- **WHEN** the user drags a shelf icon and drops it at the root level of the tree
- **THEN** the tab stays shelved and its icon appears on the root shelf instead of becoming a visible row

#### Scenario: Moving the tab to another window shelves it on the new window's root shelf
- **WHEN** a shelved tab is moved to a different browser window
- **THEN** the tab stays shelved and its icon appears on the root shelf of the destination window

#### Scenario: A re-parented tab keeps its shelf membership
- **WHEN** a shelved tab is re-parented by any means other than dragging
- **THEN** the tab stays shelved and its icon moves to the new parent's shelf

### Requirement: Firefox pinning and shelving are mutually exclusive
The extension SHALL take a shelved tab off the shelf when the user pins it, and SHALL NOT offer "Put on shelf" for pinned tabs. Firefox pinning moves the tab into the global pinned box outside the tree; the extension SHALL NOT hide a pinned tab from the pinned box.

#### Scenario: Pinning a shelved tab takes it off the shelf
- **WHEN** the user right-clicks a shelf icon and chooses the tab's native "Pin Tab"
- **THEN** the tab leaves its shelf, appears in the global pinned box, and no shelf icon remains for it
- **AND** the tab's shelved flag is cleared

#### Scenario: A pinned tab is not offered shelving
- **WHEN** the tab context menu opens on a pinned tab
- **THEN** "Put on shelf" is not among the offered items

### Requirement: Closing the shelf owner re-shelves its members instead of unfolding rows
The extension SHALL keep every member of a closing owner's shelf shelved and SHALL move each member's icon to the shelf of the member's new parent, as determined by Tree Style Tab's own behavior for children of a closing parent, or to the root shelf when the member becomes a root tab. No member SHALL become a visible row because of the closure.

#### Scenario: Members land on the grandparent's shelf when TST attaches them upward
- **WHEN** the owner of a non-empty shelf closes and Tree Style Tab attaches the owner's children to the owner's parent
- **THEN** the members' icons appear on the grandparent's shelf and no member row appears in the tree

#### Scenario: Members land on the promoted child's shelf when TST promotes a first child
- **WHEN** the owner of a non-empty shelf closes and Tree Style Tab promotes the owner's first child as the new parent
- **THEN** the members' icons appear on the promoted tab's shelf, created for it if it had none, and no member row appears in the tree

#### Scenario: The root shelf collects members when a root owner closes
- **WHEN** the owner of a non-empty shelf closes and members become root tabs
- **THEN** their icons appear on the root shelf and no member row appears in the tree

### Requirement: Closing a shelved tab removes its icon, with Tree Style Tab's own confirmation when it has children
The extension SHALL remove a shelved tab's icon from its shelf when the tab closes. When the user closes a shelved tab that has child tabs through its context menu, the extension SHALL delegate the confirmation to Tree Style Tab's own multiple-tabs-close confirmation, shown the same way as for a collapsed parent with children, and SHALL add no confirmation of its own.

#### Scenario: A childless shelved tab closes without extra prompts
- **WHEN** the user closes a shelved tab that has no child tabs
- **THEN** its icon disappears from the shelf immediately and the remaining icons keep their order

#### Scenario: A shelved tab with children asks through TST's confirmation
- **WHEN** the user closes a shelved tab with folded child tabs through its context menu
- **THEN** Tree Style Tab's own confirmation for closing a tab with a collapsed subtree appears before the tab closes
- **AND** the extension shows no additional dialog
