// Which open tabs count when a `close` rule decides whether the tab it closes
// is the last one, and when an update decides which windows it would close
// and whether it left Firefox with none; when the block page offers Go back and how far back it reaches, and
// which limit the block page describes. PURE: no `browser.*` and no `history`;
// the caller passes the tabs, the platform and the history it sees, so both
// platforms are covered by node --test.
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
  return perWindow ? !others.some((tab) => tab.windowId === closing.windowId) : noTabLeft(others);
}

/**
 * Whether the extension must open a tab as it starts, given its
 * runtime.onInstalled `details`. An update closes the add-on's own pages, and
 * when one was the last tab, Firefox for Android stays frozen on it with no
 * tab (DESIGN.md §12). By the time the new version runs they are gone, so
 * `tabs` is what Firefox has left. `perWindow` as for needsFreshTab(): on
 * desktop the window went with its last tab, and nothing is left frozen.
 */
export function needsTabAfterUpdate({ reason }, tabs, { perWindow }) {
  return reason === "update" && !perWindow && noTabLeft(tabs);
}

/**
 * The windows an update would close, as the old version learns of it from
 * runtime.onUpdateAvailable: those holding nothing but the add-on's own pages,
 * whose origin is `origin`, runtime.getURL(""). Firefox closes those pages as
 * it unloads the old version, a window goes with its last tab, and with the
 * last window Firefox quits, before the new version could repair anything
 * (DESIGN.md §12). Desktop only: Firefox for Android has no window to lose,
 * and needsTabAfterUpdate() repairs its last tab afterwards.
 */
export function windowsAnUpdateCloses(tabs, origin) {
  return [...Map.groupBy(tabs, (tab) => tab.windowId)]
    .filter(([, inWindow]) => inWindow.every((tab) => tab.url?.startsWith(origin)))
    .map(([windowId]) => windowId);
}

/** Firefox for Android has no tab the user can see. */
function noTabLeft(tabs) {
  return tabs.every(preparedForAddressBar);
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

/**
 * Go back is for a site blocked outright, whose block page never unlocks on
 * its own (DESIGN.md §19, §22). A spent budget's block page counts down to the
 * way out instead, and once any block page unlocks, Back to … is the way out.
 * `index` is blockPageIndex()'s answer.
 */
export function showsGoBack({ reason, unlocked, index }) {
  return reason === "always" && !unlocked && canGoBack(index);
}

/**
 * Which limit the block page describes, given the one it describes now and a
 * status reply for its rule. A spent rule is described by what blocks it now,
 * so a daily cap that fills while the rolling one blocks retitles the page.
 * Once the rule is open again the page keeps its limit, so a page that said
 * "done for today" goes on describing the daily cap, with one exception: a
 * raised zero budget (DESIGN.md §22). "always" describes no time allowed, which
 * is no longer true, so the page moves to the cap with the least left.
 */
export function describedReason(current, { exhausted, reason, binding }) {
  if (exhausted) return reason;
  return current === "always" ? (binding ?? "rolling") : current;
}
