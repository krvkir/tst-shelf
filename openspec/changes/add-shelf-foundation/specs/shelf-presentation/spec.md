## ADDED Requirements

### Requirement: A tab's shelf reserves horizontal space directly under its owner's row
The extension SHALL reserve a horizontal space directly below the shelf owner's tab row, spanning the tab row width, growing the owner's row downward by the strap's height, and SHALL render shelved tabs only inside that space, between the owner's row and the owner's following children rows.

#### Scenario: The shelf appears between the owner and its other children
- **WHEN** a tab is put on the shelf of a parent whose shelf is empty
- **THEN** a one-icon-row space appears directly under the owner's row, extending the owner's row height, without squeezing the owner's caption line
- **AND** the owner's other children rows follow below that space

### Requirement: The root shelf renders as a fixed strap at the top of the tab bar
The extension SHALL render the root shelf as a strap at the top of the tab bar, directly adjacent to the global pinned-tabs area, holding the icons of shelved root tabs in their tab order. The root shelf SHALL NOT move when the tree scrolls, and SHALL reserve no space while no root tab is shelved.

#### Scenario: Shelving a root tab shows its icon in the top strap
- **WHEN** a root tab is put on the shelf
- **THEN** its icon appears in the root shelf strap at the top of the tab bar, next to the global pinned-tabs area

#### Scenario: The root shelf stays in place while the tree scrolls
- **WHEN** the user scrolls the tab tree up or down
- **THEN** the root shelf strap and its icons stay fixed at the top of the tab bar

#### Scenario: An empty root shelf reserves no space
- **WHEN** no root tab is shelved
- **THEN** the top of the tab bar reserves no space for the root shelf

### Requirement: Shelf icons are favicon-sized and wrap into additional rows
The extension SHALL render each shelved tab as a favicon icon of the same size as faviconized pinned tabs, arranged left to right in the order of the tabs among the owner's children, wrapping to a new icon row when the next icon no longer fits the line, and each shelf SHALL grow downward by one icon row height per wrapped line.

#### Scenario: A handful of shelved tabs fill one icon row
- **WHEN** a parent has five shelved tabs and the sidebar is wide enough to fit five icons
- **THEN** the shelf is one icon row tall and shows the five icons left to right

#### Scenario: Too many icons wrap to further rows
- **WHEN** a shelf holds more icons than fit into one line of the sidebar width
- **THEN** the icons wrap at the line edge
- **AND** the shelf is as tall as the number of wrapped lines

#### Scenario: Icon order follows tab order
- **WHEN** shelved tabs are read left to right, top to bottom on the shelf
- **THEN** their order matches the order of the same tabs among the owner's children in the tree

#### Scenario: A newly shelved tab becomes the rightmost icon
- **WHEN** the user puts a tab on a shelf that already holds icons
- **THEN** the new tab's icon appears at the right end of the shelf, after every earlier member

### Requirement: The rest of the tree keeps its normal compact layout
The extension SHALL NOT change the height or spacing of tab rows outside shelves: rows of tabs that are not shelf owners SHALL keep their normal size regardless of how many shelves exist and how tall they are.

#### Scenario: Other rows do not grow when a shelf grows
- **WHEN** a shelf wraps into several icon rows
- **THEN** every tab row that is not a shelf owner keeps its normal height

#### Scenario: Unrelated rows stay at normal size alongside many shelves
- **WHEN** several parents in the tree hold tall shelves
- **THEN** rows of trees without shelves render at their normal height, the same as in a session without the extension

### Requirement: A shelf icon shows the tab's favicon, title, and URL on hover
The extension SHALL render each shelved tab's favicon as its icon and SHALL show the tab's title and URL as a tooltip when the pointer hovers over the icon. While the tab reports no favicon, the extension SHALL keep showing the last known favicon.

#### Scenario: Hovering an icon shows the tab's identity
- **WHEN** the pointer hovers over a shelf icon
- **THEN** a tooltip shows the shelved tab's title and URL, as tab tooltips do

#### Scenario: The icon keeps the last known favicon while the tab loads
- **WHEN** a shelved tab navigates to a new page and is loading, before the new page reports a favicon
- **THEN** its icon keeps showing the favicon of the page the tab had before the navigation

### Requirement: A shelf icon highlights while its subtree is active
The extension SHALL highlight a shelf icon's background while the shelved tab itself or any of its descendants is the active tab, using the selected-tab background color of the active TST theme, and SHALL remove the highlight when the active tab leaves the subtree.

#### Scenario: The icon highlights while the shelved tab is active
- **WHEN** a shelved tab is the active tab
- **THEN** its shelf icon's background is highlighted with the theme's selected-tab color

#### Scenario: The icon highlights while one of its children is active
- **WHEN** a child tab of a shelved tab is the active tab
- **THEN** the shelved tab's icon stays highlighted

#### Scenario: The icon drops the highlight when an unrelated tab is active
- **WHEN** the active tab is neither the shelved tab nor one of its descendants
- **THEN** its shelf icon is not highlighted

### Requirement: A shelf icon shows a plus badge while the tab's children are folded
The extension SHALL draw a visible plus badge on a shelf icon while the shelved tab has child tabs and its subtree is folded, and SHALL NOT show the badge while the subtree is unfolded or the tab has no children.

#### Scenario: A folded subtree gets a plus badge
- **WHEN** a shelved tab has children and its subtree is folded
- **THEN** its shelf icon shows a plus badge

#### Scenario: An unfolded subtree drops the badge
- **WHEN** a shelved tab's subtree is unfolded
- **THEN** its shelf icon shows no plus badge

#### Scenario: A childless tab never gets the badge
- **WHEN** a shelved tab has no child tabs
- **THEN** its shelf icon shows no badge in any state

### Requirement: Shelf icons follow container-workspace filtering of their tabs
The extension SHALL show a shelf icon exactly while its tab is visible under the current container-workspace filtering (such as tst-workspace), and SHALL hide the icon while the tab is filtered out; a shelf with no visible icons SHALL reserve no space.

#### Scenario: Only the active container's icons stay on a mixed shelf
- **WHEN** a shelf holds tabs from two containers and container-workspace filtering is active for one of them
- **THEN** only the icons of the filtered-in container's tabs are shown on the shelf
- **AND** the icons of the filtered-out tabs are hidden

#### Scenario: An icon returns when its tab becomes visible again
- **WHEN** workspace filtering stops hiding a shelved tab
- **THEN** its icon reappears on the shelf at its order position

#### Scenario: A fully filtered-out shelf closes its space
- **WHEN** workspace filtering hides every tab of a shelf
- **THEN** the shelf reserves no space under the owner's row
