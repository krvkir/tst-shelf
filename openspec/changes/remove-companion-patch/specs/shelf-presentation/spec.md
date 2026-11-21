## REMOVED Requirements

### Requirement: A crowded shelf grows its owner's row instead of scrolling
**Reason**: Extending the owner's row needs TST to paint and to compute
positions for a row of N whole lines (`lines` on `set-extra-contents`). That
is a patch to TST, not an addon-visible API.

**Migration**: The single-line scrolling form takes over unconditionally; it
is already required by "Shelf icons are favicon-sized and stay on one line"
in the `shelf-presentation` capability of `add-shelf-foundation`. No tab is
lost from the shelf — a crowded one scrolls horizontally, and the icons that
do not fit are reached with shift+wheel or a trackpad gesture.

### Requirement: The shelf keeps its single-line scrolling form without the capability
**Reason**: It is a requirement about a fallback, and the fallback is now the
only form. A requirement that can never be violated by a different branch
carries no information.

**Migration**: The guarantee survives in "Shelving does not disturb TST's
drag-and-drop geometry" (`shelf-presentation`, `add-shelf-foundation`): every
rendered row keeps TST's uniform height and its computed offset, and the
shelf never adds a row.

### Requirement: The line count follows the sidebar width
**Reason**: The line count existed only for the multi-line layout, and the
width signal it consumed (`width`/`height` on `sidebar-show`, the
`tabbar-resized` notification) is part of the same patch. A single-line
shelf scrolls, so it needs no width.

**Migration**: No action. The extension no longer needs to know the tab bar's
width, so resizing the sidebar no longer triggers a re-derivation.
