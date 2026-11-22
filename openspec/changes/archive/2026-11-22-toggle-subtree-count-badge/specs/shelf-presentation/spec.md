## RENAMED Requirements

- FROM: ### Requirement: A shelf icon shows a plus badge while the tab's children are folded
- TO: ### Requirement: A shelf icon shows a fold badge while the tab has descendants

## MODIFIED Requirements

### Requirement: A shelf icon shows a fold badge while the tab has descendants
The extension SHALL draw a visible fold badge on every shelf icon of a shelved tab that has descendant tabs, whether the tab's subtree is folded or unfolded, and SHALL NOT show the badge while the tab has no descendants. The number SHALL be the descendant tabs of the shelved tab — the same number that Tree Style Tab writes on its own tab rows, the tab itself not counted. The badge SHALL show a plus, or — when the user has selected the count mode — that number.

#### Scenario: A folded subtree gets a badge
- **WHEN** a shelved tab has children and its subtree is folded
- **THEN** its shelf icon shows a fold badge

#### Scenario: An unfolded subtree keeps the badge
- **WHEN** a shelved tab with descendants has its subtree unfolded
- **THEN** its shelf icon still shows the fold badge, as Tree Style Tab's own subtree counter does on unfolded rows

#### Scenario: A childless tab never gets the badge
- **WHEN** a shelved tab has no child tabs
- **THEN** its shelf icon shows no badge in any state

#### Scenario: Count mode shows the descendants
- **WHEN** the count mode is on and a shelved tab has three descendant tabs
- **THEN** its fold badge shows "3", folded or unfolded

#### Scenario: The number matches Tree Style Tab's counter
- **WHEN** TST writes "(N)" on the shelved tab's row as its subtree counter
- **THEN** the badge in count mode shows that same N, without parentheses

## ADDED Requirements

### Requirement: The fold badge mode is a user option
The extension SHALL offer an options page with a setting that selects whether the fold badge shows a plus or the descendant count. The setting SHALL survive restarts and SHALL apply to every shelf without restarting the extension.

#### Scenario: Selecting count mode switches every badge
- **WHEN** the user switches the option to count mode
- **THEN** every fold badge of every visible shelf shows its member's descendant count

#### Scenario: Switching back restores the plus
- **WHEN** the user switches the option back to plus mode
- **THEN** every fold badge shows a plus again

#### Scenario: The setting applies without a restart
- **WHEN** the user changes the setting while shelves are visible
- **THEN** the badges update at the next strap re-render, with no extension or browser restart
