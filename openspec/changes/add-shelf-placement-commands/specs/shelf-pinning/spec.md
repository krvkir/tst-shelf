## ADDED Requirements

### Requirement: The tab context menu offers "Place leftmost" and "Place rightmost" for shelved tabs
The extension SHALL add a "Shelf" submenu to the tab context menu, containing "Place leftmost" and "Place rightmost" items, and SHALL offer the submenu only for tabs that are on a shelf. "Place leftmost" SHALL move the tab to the first position of its shelf's member block; "Place rightmost" SHALL move it to the last position. The move SHALL go through Tree Style Tab's subtree-preserving move API: the member block SHALL stay contiguous and directly under its owner, the moved tab's descendants SHALL follow it, and the relative order of every other tab SHALL be unchanged.

#### Scenario: A shelved tab's menu offers the Shelf submenu
- **WHEN** the tab context menu opens on a tab that is on a shelf
- **THEN** the menu contains a "Shelf" submenu holding "Place leftmost" and "Place rightmost"

#### Scenario: An unshelved tab's menu hides the submenu
- **WHEN** the tab context menu opens on a tab that is not on a shelf
- **THEN** the "Shelf" submenu and both of its commands are not shown

#### Scenario: "Place leftmost" makes the tab the first icon of its shelf
- **WHEN** the user chooses "Place leftmost" on a shelved tab that sits mid-shelf
- **THEN** the tab's icon becomes the leftmost icon of its shelf
- **AND** every other member keeps its relative order

#### Scenario: "Place rightmost" makes the tab the last icon of its shelf
- **WHEN** the user chooses "Place rightmost" on a shelved tab that sits mid-shelf
- **THEN** the tab's icon becomes the rightmost icon of its shelf
- **AND** every other member keeps its relative order

#### Scenario: The moved tab's subtree follows it
- **WHEN** the user moves a shelved tab that has children to an extreme slot
- **THEN** its children move with it, stay its children, and no other tab changes parent

#### Scenario: An already-extreme member does not move
- **WHEN** the user chooses the command that names the slot the member already occupies
- **THEN** nothing moves and the command has no visible effect

#### Scenario: The commands work on the root shelf
- **WHEN** the user chooses "Place leftmost" on a member of the root shelf
- **THEN** the tab becomes the leftmost root-shelf icon, at the top of the root tabs
