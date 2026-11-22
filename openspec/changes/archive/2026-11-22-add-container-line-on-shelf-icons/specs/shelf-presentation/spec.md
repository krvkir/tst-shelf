## ADDED Requirements

### Requirement: A shelf icon carries its tab's container line
The extension SHALL show the container color line on a shelf icon whenever the shelved tab belongs to a Firefox container (contextual identity), painted the way the active Tree Style Tab theme paints the container marker on regular tab rows: the tab's own container's color, the same cross-section the row marker uses, at the marker's own place in the row's line geometry, with the line's vertical extent bounded by the icon cell. A shelved tab of the default container or of a private window SHALL show no line. On a shelf of members from several containers, each icon's line SHALL follow its own tab's container, not the owner's. The line SHALL NOT displace the favicon, the fold badge, the audio indicator or the hint chips, SHALL carry no click behavior of its own, and SHALL NOT affect the container markers Tree Style Tab itself paints on rendered rows, the owner rows included.

#### Scenario: A shelved container tab's icon carries the line
- **WHEN** a tab of a Firefox container is put on a shelf
- **THEN** its icon shows the container color line and the tab's row, which is gone, is not the paint site anymore

#### Scenario: A default or private tab's icon shows no line
- **WHEN** a shelved tab belongs to the default container or lives in a private window
- **THEN** its icon shows no container line, as its regular rows would show no marker

#### Scenario: The line matches the rows' marker style
- **WHEN** the line on a shelf icon is compared with the container marker on a regular rendered row of the same container and theme
- **THEN** both use the same container color and the same cross-section, and only the line's vertical extent is shorter on the icon, bounded by the icon cell

#### Scenario: A mixed shelf colors each member's line
- **WHEN** a shelf holds iconized tabs from two different containers
- **THEN** each icon's line is painted in its own tab's container color and not in the owner's

#### Scenario: The line follows a container change live
- **WHEN** a shelved tab moves to another container while it stays shelved
- **THEN** its icon's line takes the new container's color at the next strap re-render, without an extension restart

#### Scenario: The decorations are not displaced
- **WHEN** a container member's icon shows the fold badge, the audio indicator, or a hint-mode chip
- **THEN** those decorations keep their places and behaviors, and the line passes under them where they overlap

#### Scenario: Unshelving returns the line to the row
- **WHEN** a shelved tab of a container is taken off the shelf
- **THEN** its row paints the regular container marker again and no icon remains to show one
