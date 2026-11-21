"use strict";

/* The E2E fixture page sets its own title so tests can control the
 * caption width: `tree-tab.html?title=<text>`.  A LONG title is what
 * makes the owner's caption want more room than the row has — the
 * condition that exposed the shelf-shrinking bug (the shelf was a
 * shrinkable flex item next to a caption whose flex basis is the whole
 * untruncated title). */
const title = new URLSearchParams(location.search).get("title");
if (title) {
	document.title = title;
}
