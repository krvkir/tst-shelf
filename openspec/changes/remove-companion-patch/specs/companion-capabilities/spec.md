## REMOVED Requirements

### Requirement: Companion capabilities are detected, never assumed
**Reason**: The capabilities it detects (rows of N whole lines, `row-less`
tabs, the `tabbar-resized` size report) exist only in a local patch to Tree
Style Tab and are not upstream. Maintaining a second code path for every row
removal cost more than the features were worth, and the patched build cannot
be shipped while TST is installed from AMO.

**Migration**: No action for a user. The extension stops calling
`get-version` for anything but the major version it already needed (TST 4.0
introduced the extra-contents and menu APIs). A patched TST build now gets
exactly the behaviour of a stock one: no `lines` parameter is sent, no
`row-less` state is applied, and the `tabbar-resized` notification is not
subscribed to.

### Requirement: The declared layout setting decides what a crowded shelf does
**Reason**: The setting (`auto` | `extend` | `scroll`) existed only to choose
between the two layouts, and two of its three values mean the same thing
without the capability. With `extend` gone, `auto` and `scroll` both mean
"keep one line and scroll", so the setting has no decision left to make.

**Migration**: The `shelf-layout` key in `storage.local` is ignored and left
untouched. A user who set `scroll` sees no change; a user who set `extend` or
kept the default sees crowded shelves scroll horizontally instead of growing
the owner row.
