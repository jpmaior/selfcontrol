// Which open tabs count when a `close` rule decides whether the tab it closes
// is the last one, and how far back the block page's Go back can reach. PURE:
// no `browser.*` and no `history`; the caller passes the tabs, the platform and
// the history it sees, so both platforms are covered by node --test.
//
// The tab list cannot be taken at its word on Android: it carries a hidden
// tab Firefox prepares when the address bar is tapped, and counting it left
// Firefox frozen on the closed site (DESIGN.md §12).

/**
 * Whether a `close` rule must open a fresh tab before it removes `closing`.
 *
 * `tabs` is every open tab, from tabs.query({}), with or without `closing`
 * still in it. `perWindow` is lastTabClosesWindow() in platform.js: on desktop
 * only the window's tabs count, because removing its last one closes the
 * window; on Android every tab counts, except the one prepared for the
 * address bar.
 */
export function needsFreshTab(closing, tabs, { perWindow }) {
  const others = tabs.filter((tab) => tab.id !== closing.id);
  const left = perWindow
    ? others.filter((tab) => tab.windowId === closing.windowId)
    : others.filter((tab) => !preparedForAddressBar(tab));
  return left.length === 0;
}

/**
 * Firefox for Android's hidden tab for the next new tab. A blank tab created in
 * the background and never shown looks the same and is ignored with it; at
 * worst that opens one blank tab too many.
 */
function preparedForAddressBar(tab) {
  return tab.url === "about:blank" && tab.width === 0 && tab.height === 0;
}

/**
 * The block page's position in its tab's history (DESIGN.md §19). Freshly
 * opened it is the last entry, since tabs.update pushes it and drops anything
 * forward of it. The page records that in its entry's `history.state`, which
 * stays with the entry, because once the user goes forward from it and comes
 * back, `history.length` also counts the entries ahead. `state` is whatever
 * history.state holds; anything this did not write is ignored.
 */
export function blockPageIndex(state, historyLength) {
  const recorded = state?.blockIndex;
  return Number.isInteger(recorded) && recorded >= 0 ? recorded : historyLength - 1;
}

/**
 * Go back skips the blocked page, which is always the entry just before the
 * block page, so it needs one more before that: the page the user came from.
 */
export const GO_BACK_STEPS = 2;

export function canGoBack(index) {
  return index >= GO_BACK_STEPS;
}
