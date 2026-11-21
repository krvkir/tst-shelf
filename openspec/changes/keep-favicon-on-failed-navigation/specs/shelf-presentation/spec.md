## MODIFIED Requirements

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
