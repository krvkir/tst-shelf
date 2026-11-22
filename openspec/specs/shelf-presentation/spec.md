# shelf-presentation Specification

## Purpose
TBD - created by archiving change add-shelf-foundation. Update Purpose after archive.
## Requirements
### Requirement: A shelf lives inside its owner's row
The extension SHALL render a shelf's icons inside the shelf owner's own tab row, on the opposite side of the caption, so that a shelf costs no vertical space beyond the row TST already renders for the owner. Shelved tabs SHALL NOT get rows of their own; the extension removes them from the tab strip through the browser's tab-hiding API.

#### Scenario: A shelved tab shows up as an icon, not as a row
- **WHEN** a tab is put on the shelf of a parent
- **THEN** its icon appears inside the owner's row and the tab itself has no row in the tree
- **AND** the rows below the owner are the same as those of a tree without any shelved tab

#### Scenario: The owner's row keeps its normal height
- **WHEN** a parent holds a shelf with any number of icons
- **THEN** the owner's row renders at the same height as any plain tab row

### Requirement: Shelved tabs are hidden from the tab strip
The extension SHALL keep every shelved tab hidden through the browser's tab-hiding API, and SHALL show it again when it leaves the shelf or when the browser refuses to keep it hidden. The hidden state the extension applies SHALL be distinguishable from a hidden state applied by another extension, so that the shelf still lists its own tabs while leaving tabs filtered out by another extension unlisted.

#### Scenario: Taking a tab off the shelf brings its row back
- **WHEN** the user takes a tab off the shelf
- **THEN** the tab's row is visible again in the tree and the tab sits at its pre-shelving position

#### Scenario: A tab hidden by another extension is not listed on the shelf
- **WHEN** a shelved tab is hidden by a container-workspace filter
- **THEN** its icon is not shown on the shelf

#### Scenario: A shelved tab that becomes hidden is still listed
- **WHEN** a shelved tab is hidden by the extension itself
- **THEN** its icon stays on the shelf, highlighted or dimmed exactly as any other member

#### Scenario: Restored sessions keep the distinction
- **WHEN** the browser restarts with shelved tabs hidden by the extension
- **THEN** the shelf lists those tabs again instead of treating them as filtered out

### Requirement: Shelving does not disturb TST's drag-and-drop geometry
The extension SHALL keep every rendered tab row at TST's uniform row height and at TST's computed offset. TST computes drag-and-drop zones, virtual scroll offsets and sticky rows as `row height x index` over the renderable tabs, so any row that paints taller, shorter, or absent while TST still counts it shifts the computed drop positions of every row below it.

#### Scenario: Dropping a tab on a shelfless tab attaches it as a child
- **WHEN** a tab is dragged onto the caption of a plain tab that follows a shelf in the tree
- **THEN** TST's drop zones resolve exactly as without the extension, and dropping in the middle of the row attaches the dragged tab as the target's child

#### Scenario: Every rendered row sits at TST's computed position
- **WHEN** the tree holds shelves with owner rows and hidden members
- **THEN** every rendered row's painted position matches the uniform-row arithmetic TST uses for its own geometry (measured: the first row sits at the content origin and every consecutive row pitch equals the row height)

### Requirement: The owner keeps its title and gains the shelf beside it
The extension SHALL keep the owner's caption visible — twisty, favicon and title — and SHALL place the shelf to the right of it. The owner's title SHALL be truncated when the shelf takes its room, and the untruncated title SHALL remain available on hover.

#### Scenario: The owner's title truncates instead of overflowing
- **WHEN** a shelf takes its share of the owner's row
- **THEN** the owner's title is truncated with an ellipsis at the edge of its remaining room, and the row does not overflow

#### Scenario: The full title is available on hover
- **WHEN** the pointer hovers over a truncated owner row
- **THEN** a tooltip shows the owner's full title and URL

#### Scenario: A narrow shelf leaves most of the title visible
- **WHEN** a shelf holds two icons in a wide sidebar
- **THEN** the owner's title keeps the room the icons do not need

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

#### Scenario: A hidden root tab still lands on the root shelf
- **WHEN** a shelved root tab is hidden by the extension and the browser restarts
- **THEN** its icon appears in the root shelf strap

### Requirement: Shelf icons are favicon-sized and stay on one line
The extension SHALL render each shelved tab as a favicon icon of the same size as faviconized pinned tabs, arranged left to right in tab order, on a single line. The icons SHALL take at most two thirds of the owner's row width; when they do not fit, the line SHALL scroll horizontally rather than wrap or grow the row.

#### Scenario: The shelf is never squeezed below its icons
- **WHEN** the owner's title is long enough that the caption alone would exceed the row's width
- **THEN** the shelf keeps the natural width of its icons and the caption is truncated instead
- **AND** the shelf does not start scrolling while its icons still fit the two-thirds budget

#### Scenario: A handful of shelved tabs fill one line
- **WHEN** a parent holds five shelved tabs
- **THEN** the shelf shows the five icons in one line inside the owner's row

#### Scenario: Too many icons scroll instead of wrapping
- **WHEN** a shelf holds more icons than fit into two thirds of the owner row
- **THEN** the icons stay on one line and the line scrolls horizontally
- **AND** the owner row keeps its normal height

#### Scenario: Icon order follows tab order
- **WHEN** shelved tabs are read left to right on the shelf
- **THEN** their order matches their order among the owner's children in the tree

#### Scenario: A newly shelved tab becomes the rightmost icon
- **WHEN** the user puts a tab on a shelf that already holds icons
- **THEN** the new tab's icon appears at the right end of the shelf, after every earlier member

#### Scenario: Selecting an icon does not rearrange the shelf
- **WHEN** the user selects an icon on the shelf
- **THEN** the icons stay in their order and the selected tab's subtree appears below the shelf

### Requirement: The active tab and its ancestors always keep their rows
The extension SHALL keep the active tab visible whatever its subtree looks like, and SHALL keep every ancestor of the active tab visible as well. A hidden tab's descendants are not rendered, so reclaiming an ancestor's row would take the active tab's own row away; for a shelf of shelves it would also take the nested shelf's strap off the screen, because that strap is rendered in its owner's row. Rows that cannot be reclaimed yet — because a descendant of the tab is mid-animation — SHALL be kept until the animation is over.

#### Scenario: A shelved tab with children stays visible while a child is active
- **WHEN** a member of a shelf has child tabs and the user activates one of those children
- **THEN** the member keeps its row, above the child's row, instead of disappearing from the tree

#### Scenario: A shelved tab that owns a shelf keeps that shelf on screen
- **WHEN** the user activates a tab of a nested shelf
- **THEN** the nested shelf's owner keeps its row, and the nested shelf's icons stay visible in it

#### Scenario: A member's row is reclaimed only when nothing depends on it
- **WHEN** a member stops being active and none of its descendants is the active tab
- **THEN** its row is gone again within a fraction of a second, and its icon is back to being its only presentation

#### Scenario: A collapsing subtree is not orphaned
- **WHEN** a member's children are folding away because another tab of the same shelf was activated
- **THEN** the member's own row is kept until the children's rows are gone, so no frame shows children without their parent

### Requirement: Switching between two shelf tabs does not move the tree
Switching from one member of a shelf to another SHALL be a row swap: the number of painted member rows SHALL stay the same, and the displacement of the rows below the shelf SHALL last at most a couple of frames.

#### Scenario: Two childless members swap in place
- **WHEN** the user activates a second childless member of the same shelf
- **THEN** the rows below the shelf end at the same position they started at, and the tree is not visibly displaced

#### Scenario: Switching keeps the members on the shelf
- **WHEN** the user switches between members several times
- **THEN** every member is still listed on the shelf in its order position

### Requirement: The rest of the tree keeps its normal compact layout
The extension SHALL NOT change the height or spacing of tab rows outside shelves: rows of tabs that are not shelf owners SHALL keep their normal size, and a shelf SHALL never add rows to the tree.

#### Scenario: Unrelated rows stay at normal size alongside many shelves
- **WHEN** several parents in the tree hold shelves
- **THEN** rows of trees without shelves render at their normal height, the same as in a session without the extension

#### Scenario: A shelf never adds a blank row
- **WHEN** a shelf holds any number of tabs
- **THEN** no row is rendered for them, so the tree is exactly as tall as the same tree with those tabs removed

### Requirement: A shelf icon shows the tab's favicon, title, and URL on hover
The extension SHALL render each shelved tab's favicon as its icon and SHALL show the tab's title and URL as a tooltip when the pointer hovers over the icon. While the tab reports no favicon, the extension SHALL keep showing the last known favicon. When the tab's page cannot be reached — the navigation fails with a connection error, a name-resolution failure, or a crash — the icon SHALL keep the favicon of the page the tab had before that navigation. When the tab successfully loads a different page, the extension SHALL NOT show the previous page's favicon for it.

#### Scenario: Hovering an icon shows the tab's identity
- **WHEN** the pointer hovers over a shelf icon
- **THEN** a tooltip shows the shelved tab's title and URL, as tab tooltips do

#### Scenario: The icon keeps the last known favicon while the tab loads
- **WHEN** a shelved tab navigates to a new page and is loading, before the new page reports a favicon
- **THEN** its icon keeps showing the favicon of the page the tab had before the navigation

#### Scenario: A reload that cannot reach the site keeps the favicon
- **WHEN** the user reloads a shelved tab whose site cannot be reached
- **THEN** its icon keeps the favicon it had before the reload instead of showing the browser-default icon

#### Scenario: An unreachable navigation keeps the previous page's favicon
- **WHEN** a shelved tab navigates to a different site and that site cannot be reached
- **THEN** its icon keeps the favicon of the page it had before the navigation

#### Scenario: A successful navigation to an iconless page shows no stale favicon
- **WHEN** a shelved tab successfully loads a page of a different site that provides no favicon
- **THEN** its icon shows the browser-default presentation and not the previous site's favicon

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

### Requirement: Shelf icons follow container-workspace filtering of their tabs
The extension SHALL show a shelf icon exactly while its tab is not filtered out by another extension's tab hiding, and SHALL hide the icon while the tab is filtered out by such an extension; a shelf with no visible icons SHALL render no strap.

#### Scenario: Only the active container's icons stay on a mixed shelf
- **WHEN** a shelf holds tabs from two containers and container-workspace filtering is active for one of them
- **THEN** only the icons of the filtered-in container's tabs are shown on the shelf

#### Scenario: An icon returns when its tab becomes visible again
- **WHEN** workspace filtering stops hiding a shelved tab
- **THEN** its icon reappears on the shelf at its order position

#### Scenario: A fully filtered-out shelf closes its space
- **WHEN** workspace filtering hides every tab of a shelf
- **THEN** the shelf renders no strap at all

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

### Requirement: A shelf icon shows its tab's audio state
The extension SHALL show a sound indicator on a shelf icon while the shelved tab plays audio, and a muted indicator while the tab is muted, using the active theme's text color and loading no network resource. The favicon SHALL stay visible while an indicator shows, and the indicator SHALL not displace the fold badge. While the tab is silent and unmuted, no audio indicator SHALL be shown.

#### Scenario: A playing tab shows the sound indicator
- **WHEN** a shelved tab plays audio
- **THEN** its shelf icon shows a sound indicator and keeps showing the tab's favicon

#### Scenario: A muted tab shows the muted indicator
- **WHEN** a shelved tab is muted
- **THEN** its shelf icon shows a muted indicator instead of the sound indicator

#### Scenario: A silent unmuted tab shows no indicator
- **WHEN** a shelved tab plays no audio and is not muted
- **THEN** its shelf icon shows no audio indicator

#### Scenario: The indicator follows the tab's state live
- **WHEN** audio starts or stops in a shelved tab, or its mute state changes
- **THEN** its shelf icon's indicator updates at the next strap re-render, without a restart

