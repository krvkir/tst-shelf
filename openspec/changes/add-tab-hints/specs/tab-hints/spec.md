## ADDED Requirements

### Requirement: A keyboard command starts hint mode for the focused window
The extension SHALL register a browser keyboard command that starts hint mode for the focused window's tab strip. While hint mode is active, the extension SHALL assign and render a hint code for every visible tab of that window. Hint mode SHALL end when a tab is activated through a code, when the user presses Escape, or when the tab strip loses keyboard focus. Starting hint mode SHALL have no effect while the window's Tree Style Tab sidebar is closed.

#### Scenario: The command labels every visible tab
- **WHEN** the user presses the hint command's key while the sidebar is open
- **THEN** every visible tab of the window — rendered rows and shelf icons — carries a code label

#### Scenario: Escape exits without activating anything
- **WHEN** hint mode is active and the user presses Escape
- **THEN** the labels disappear and no tab changes state

#### Scenario: Losing keyboard focus exits the mode
- **WHEN** hint mode is active and the tab strip loses keyboard focus
- **THEN** the labels disappear and the extension stops consuming keys

#### Scenario: A closed sidebar makes the command a no-op
- **WHEN** the user presses the command's key while the window's Tree Style Tab sidebar is closed
- **THEN** nothing happens and no labels appear anywhere

### Requirement: Every visible tab carries a unique short code
The extension SHALL assign, while hint mode is active, a unique code of the shortest practical length to every visible tab of the window: a shelved tab's code labels its shelf icon, a rendered row's tab has its code label its row. Codes SHALL follow the rendered order of the tree and SHALL be reassigned when the visible set changes. Tabs with no visible surface — rows outside the virtual-scroll viewport, tabs hidden by a reveal or filtered out by another extension — SHALL carry no code.

#### Scenario: Codes are unique and ordered
- **WHEN** hint mode is active over a tree of ten visible tabs
- **THEN** every one of them carries a different code, in the order the tree renders them

#### Scenario: A shelved tab's code sits on its icon
- **WHEN** a shelf's members are hidden rows visible only as icons
- **THEN** their codes label the icons on the strap, and no code labels the hidden rows themselves

#### Scenario: Off-viewport rows have no code
- **WHEN** a row sits outside the visible range of the virtual scroll
- **THEN** it carries no code, and scrolling it into view assigns it one

#### Scenario: Codes follow a changing tree
- **WHEN** a tab closes or the viewport scrolls while hint mode is active
- **THEN** the codes are reassigned to the new visible set and stay unique

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

#### Scenario: Backspace un-types a letter
- **WHEN** the user typed one letter of a two-letter code and presses Backspace
- **THEN** the buffer empties and every label of the visible set shows again
