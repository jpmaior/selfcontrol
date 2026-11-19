// Which open tabs count: when a `close` rule decides whether the tab it closes
// is the last one, and when an update decides which windows it would close and
// whether it left Firefox with none (DESIGN.md §12). PURE: no `browser.*`; the
// caller passes the tabs and the platform, so both platforms are covered by
// node --test.
//
// The tab list cannot be taken at its word on Android: it carries a hidden
// tab Firefox prepares when the address bar is tapped, and counting it left
// Firefox frozen on the closed site.

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
