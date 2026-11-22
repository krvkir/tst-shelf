# tab-hints Specification

## Purpose
TBD - created by archiving change add-tab-hints. Update Purpose after archive.
## Requirements
### Requirement: A keyboard command starts hint mode for the focused window
The extension SHALL register a browser keyboard command that starts hint mode for the focused window's tab strip. While hint mode is active, the extension SHALL assign and render a hint code for every visible tab of that window, and SHALL capture the code letters wherever the window's keyboard focus is — the focused web page as well as the Tree Style Tab sidebar — so typing a code works from the page the user is reading. Hint mode SHALL end when a tab is activated through a code, when the user presses Escape, or when the user has typed nothing for a few seconds. Starting hint mode SHALL have no effect while the window's Tree Style Tab sidebar is closed, and SHALL decline — a deliberate no-op — when the window's active tab is a page no key catcher can ever be injected into (a browser page, an extension page), because such a mode could not receive keys from anywhere the user's focus already is.

#### Scenario: The command labels every visible tab
- **WHEN** the user presses the hint command's key while the sidebar is open
- **THEN** every visible tab of the window — rendered rows and shelf icons — carries a code label

#### Scenario: Typing works from the focused page
- **WHEN** hint mode is active and the window's keyboard focus is a normal web page
- **THEN** typing a tab's code activates that tab, and the page receives no typed letter

#### Scenario: Escape exits without activating anything
- **WHEN** hint mode is active and the user presses Escape
- **THEN** the labels disappear and no tab changes state

#### Scenario: A pause in typing ends the mode
- **WHEN** hint mode is active and the user types nothing for a few seconds
- **THEN** the labels disappear and the extension stops consuming keys

#### Scenario: A closed sidebar makes the command a no-op
- **WHEN** the user presses the command's key while the window's Tree Style Tab sidebar is closed
- **THEN** nothing happens and no labels appear anywhere

#### Scenario: A special active page makes the command a no-op
- **WHEN** the user presses the command's key while the window's active tab is a page the key catcher cannot be injected into — an about: page, an extension page such as a Tree Style Tab group tab
- **THEN** nothing happens, no labels appear, and no hint mode is left running

### Requirement: Every painted tab surface carries a unique short code
The extension SHALL assign, while hint mode is active, a unique code of the shortest practical length to exactly the tabs whose surfaces are painted when the mode starts: a rendered row without a strap has its code label the row at its inline-end top corner; a rendered shelf owner has its code lead its own strap, on the same line as the member chips and to the left of the leftmost member icon, spaced by the strap's chip rhythm; and a shelved tab whose shelf icon is painted has its code label that icon. No other tab SHALL carry a code — hidden tabs, tabs inside folded subtrees, and rows outside the sidebar's rendered range have none, so a typed code can never activate a tab the user cannot see. The chips SHALL align so the labels read as one column: on shelfless rows at the corner of the row, on shelf owners on the shelf's line. Codes SHALL follow the rendered order of the tree, SHALL stay unchanged for the mode's lifetime, and SHALL be built from the user-configured code alphabet. While the special-page exclusion option is on (the default), a tab whose page the key catcher can never be injected into SHALL carry no code either, so the keyboard can never navigate onto a page it would be stranded on.

#### Scenario: Codes are unique and ordered
- **WHEN** hint mode is active over a tree of ten painted tabs
- **THEN** every one of them carries a different code, in the order the tree renders them

#### Scenario: A shelved tab's code sits on its icon
- **WHEN** a shelf's members are hidden rows visible only as icons
- **THEN** their codes label the icons on the strap, and no code labels the hidden rows themselves

#### Scenario: A shelf owner's code rides the strap's line
- **WHEN** hint mode is active and a tab that paints a shelf strap carries its row code
- **THEN** the owner's code leads the strap itself — on the same line as the member chips, to the left of the leftmost member icon, spaced by the strap's chip rhythm — and stays legible at every strap width

#### Scenario: A row scrolled out of view keeps its code
- **WHEN** a labeled row leaves the visible range of the virtual scroll and comes back
- **THEN** it shows the same code it had

#### Scenario: A row outside the viewport at entry carries no code
- **WHEN** a row is outside the sidebar's rendered range when the mode starts and scrolls into view later
- **THEN** it carries no code, the codes of the other tabs do not change, and re-entering the mode after the scroll assigns codes for the new viewport

#### Scenario: Codes follow a changing tree
- **WHEN** a tab closes while hint mode is active
- **THEN** the codes of the remaining tabs stay valid and unique

#### Scenario: A folded subtree carries no row codes
- **WHEN** a parent's subtree is folded when the mode starts
- **THEN** the rows inside the fold carry no code, the folded parent's own row carries its code, and the members of its shelf keep their icon codes

#### Scenario: Special pages carry no code while the exclusion is on
- **WHEN** hint mode is active with the exclusion option on (the default) and the window holds tabs on pages the catcher cannot be injected into — about: pages, extension pages
- **THEN** those tabs carry no code, and every other painted tab does

#### Scenario: Codes come from the configured alphabet
- **WHEN** the user has configured a code alphabet in the options and starts hint mode
- **THEN** every code consists only of characters from that alphabet

#### Scenario: A window whose viewport cannot be queried still codes the tree
- **WHEN** the mode starts for a window whose sidebar viewport state cannot be queried (no sidebar copy answers)
- **THEN** the codes cover every tab whose row is not folded away — labels painting wherever rows exist — so a reload of the extension with an open sidebar never blanks the mode

### Requirement: Hint options apply live
The extension SHALL offer, on its options page, the code alphabet (two or more distinct letters or digits, defaulting to letters that no default Vimium mapping starts with), the special-page exclusion (default on), and the hint chip font size in px (10-18, default 12), and SHALL apply a change to any of them without a restart or a reload.

#### Scenario: Changing the alphabet changes the next codes
- **WHEN** the user changes the code alphabet while no hint mode is running and starts one afterwards
- **THEN** the codes are built from the new alphabet

#### Scenario: Turning the exclusion off codes special pages
- **WHEN** the user turns the special-page exclusion off and starts hint mode over a window with an about: tab
- **THEN** that tab carries a code as any other visible tab

#### Scenario: Changing the chip size restyles the chips already painted
- **WHEN** the user changes the hint chip font size while hint mode is active and chips are painted
- **THEN** the already-painted chips restyle to the new size at once, without re-entering the mode; values outside the band keep the size the mode is running with

### Requirement: Hint labels do not change the tree's geometry
The extension SHALL render hint labels as overlays — on the shelf icon or on the tab's row — that change no row's size, position, or spacing, and SHALL leave the tab bar's own layout untouched while the mode is not active.

#### Scenario: Rows keep TST's uniform arithmetic while labeled
- **WHEN** hint labels are rendered over rows and icons
- **THEN** every rendered row paints at exactly its computed height and offset (the extension's uniform-row conformance gate)

#### Scenario: An empty root shelf still reserves no space while labeled
- **WHEN** hint mode is active and no root tab is shelved
- **THEN** the top of the tab bar reserves no space, and the codes render without the root strap appearing

#### Scenario: Exiting removes every label
- **WHEN** hint mode ends
- **THEN** every code label is gone from rows and icons, and the tab bar renders exactly as before the mode

### Requirement: Typing a code activates that tab
The extension SHALL activate the tab whose code the user types: a shelved tab exactly as a primary click on its shelf icon does — selection, fold swap, reveal rules — and a rendered row's tab as its row click does. A typed prefix that matches more than one code SHALL activate nothing while it is incomplete, and the labels of tabs whose codes no longer match SHALL hide while the buffer is non-empty. Backspace SHALL remove the last typed letter.

#### Scenario: Typing a shelved member's code selects it
- **WHEN** the user types the code of a shelved tab with children
- **THEN** that tab activates and its subtree unfolds, exactly as when its icon is clicked

#### Scenario: Typing a row tab's code activates it
- **WHEN** the user types the code of a rendered row's tab
- **THEN** that tab becomes the active tab

#### Scenario: A prefix that matches several codes activates nothing
- **WHEN** the user types one letter that begins several codes
- **THEN** no tab activates, and only the labels of the still-matching tabs remain visible

#### Scenario: The icon chips narrow together with the row labels
- **WHEN** the user types one letter that begins several codes and the window holds shelved tabs with visible icons
- **THEN** the chips on those icons hide exactly like the row labels of the non-matching tabs, so both surfaces agree

#### Scenario: Backspace un-types a letter
- **WHEN** the user typed one letter of a two-letter code and presses Backspace
- **THEN** the buffer empties and every label of the visible set shows again

