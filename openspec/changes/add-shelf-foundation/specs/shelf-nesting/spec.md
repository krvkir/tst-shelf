## ADDED Requirements

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

### Requirement: The unfolded subtree stays visible until another tab of the same shelf is selected
The extension SHALL keep the children of a shelf's selected tab visible even when the active tab moves outside the shelf or to one of the selected tab's descendants, and SHALL fold them only when another tab of the same shelf becomes selected.

#### Scenario: Activating an unrelated tab keeps the subtree open
- **WHEN** a shelf's selected tab has its children unfolded and the user activates an unrelated tab elsewhere in the tree
- **THEN** the selected tab's child rows remain visible

#### Scenario: Activating a child of the selected tab keeps it selected
- **WHEN** the active tab is a child of the selected shelf tab and the user switches to another child of the same shelf tab
- **THEN** the shelf tab remains selected and its children stay visible

#### Scenario: The unfolded subtree survives a browser restart
- **WHEN** a shelf's selected tab has its children unfolded and the browser restarts with session restore
- **THEN** that tab is selected again and its child rows come back visible, while no other shelf tab's children appear

### Requirement: A selected shelved tab unfolds its own nested shelf under the parent shelf
The extension SHALL hide the shelf owned by a shelved tab while that tab is not selected on its parent's shelf, and SHALL show that nested shelf directly below the parent shelf area when the tab is selected, so a selected shelved tab presents its own shelf and then its children in the order they would have as regular rows.

#### Scenario: A nested shelf is hidden while its owner is folded
- **WHEN** a shelved tab owns a shelf of its own and is not the selected tab of its parent's shelf
- **THEN** its own shelf icons are not shown anywhere in the tree

#### Scenario: Selecting the nested shelf's owner reveals it below the parent shelf
- **WHEN** a shelved tab that owns a shelf becomes the selected tab of its parent's shelf
- **THEN** its own shelf icons render directly below the parent shelf's icon rows
- **AND** its children rows follow below them with normal indentation
