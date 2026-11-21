# shelf-interaction Specification

## Purpose
TBD - created by archiving change add-shelf-foundation. Update Purpose after archive.
## Requirements
### Requirement: Clicking a shelf icon selects that tab
The extension SHALL activate the shelved tab whose icon receives a primary-button click, instead of the shelf owner's tab row under it, and SHALL cancel Tree Style Tab's default click reaction on the shelf.

#### Scenario: A left click on an icon activates the shelved tab
- **WHEN** the user clicks a shelf icon with the primary button
- **THEN** the shelved tab becomes the active tab
- **AND** the shelf owner does not become active merely because the shelf sits on its row

### Requirement: A shelf icon opens the tab's regular context menu with shelf actions
The extension SHALL open, on a right click of a shelf icon, the context menu of the tab the icon represents, with the same items the tab's regular row offers, including "Take off the shelf".

#### Scenario: Right-clicking an icon shows the tab's own menu
- **WHEN** the user right-clicks a shelf icon
- **THEN** the context menu of that shelved tab appears, containing the same items as for its regular row (reload, bookmark, close, container actions, and other items of the tab's context menu)
- **AND** the menu includes "Take off the shelf"

#### Scenario: Context menu actions act on the shelved tab
- **WHEN** the user picks a regular action, such as reload or close, from the shelf icon's context menu
- **THEN** the action applies to the shelved tab that the icon represents, not to the shelf owner

### Requirement: Dragging a shelf icon performs Tree Style Tab's native tab drag
The extension SHALL make a shelf icon draggable as the shelved tab itself, so that dragging it performs Tree Style Tab's native tab drag with the tab's descendants following, and the drop semantics (drop targets, insertion positions, re-parenting) SHALL be Tree Style Tab's own. After the drop, the shelved state and the new shelf placement follow the shelving rules of the `shelf-pinning` capability.

#### Scenario: A drag carries the whole subtree
- **WHEN** the user drags a shelf icon of a tab with children and drops it on a target
- **THEN** the dragged tab and all its descendants land under the drop target exactly as if the tab's regular row were dragged
- **AND** the dragged tab remains shelved afterwards

#### Scenario: The owner row is not dragged instead of the icon's tab
- **WHEN** the user starts dragging a shelf icon
- **THEN** the drag carries the shelved tab the icon represents, not the shelf owner's tab row under the strap

