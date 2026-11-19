// Which open tabs count, when a `close` rule removes a tab and when an update
// closes the add-on's pages (DESIGN.md §12). PURE: the caller passes the tabs
// and the platform, so node --test covers both platforms. On Android the list
// carries a hidden tab, and counting it left Firefox frozen on a closed site.

/**
 * Whether a `close` rule must open a fresh tab before it removes `closing`.
 * `tabs` is tabs.query({}), with or without `closing`. `perWindow` is
 * lastTabClosesWindow(): on desktop only the window's tabs count, on Android
 * every tab the user can see.
 */
export function needsFreshTab(closing, tabs, { perWindow }) {
  const others = tabs.filter((tab) => tab.id !== closing.id);
  return perWindow ? !others.some((tab) => tab.windowId === closing.windowId) : noTabLeft(others);
}

/**
 * Whether the new version must open a tab, given runtime.onInstalled's
 * `details` and the tabs the update left: on Android, when it closed the last
 * one the user had. On desktop the window went with its last tab, and nothing
 * is left frozen to repair.
 */
export function needsTabAfterUpdate({ reason }, tabs, { perWindow }) {
  return reason === "update" && !perWindow && noTabLeft(tabs);
}

/**
 * The windows an update would close, for the old version to keep open: those
 * holding nothing but the add-on's own pages, whose origin is `origin`
 * (runtime.getURL("")). Desktop only; on Android needsTabAfterUpdate() repairs
 * the last tab afterwards.
 */
export function windowsAnUpdateCloses(tabs, origin) {
  return [...Map.groupBy(tabs, (tab) => tab.windowId)]
    .filter(([, inWindow]) => inWindow.every((tab) => tab.url?.startsWith(origin)))
    .map(([windowId]) => windowId);
}

/** No tab the user can see is left. */
function noTabLeft(tabs) {
  return tabs.every(preparedForAddressBar);
}

/**
 * The hidden tab Firefox for Android prepares when the address bar is tapped.
 * A blank background tab never shown looks the same and is ignored with it: at
 * worst, one blank tab too many.
 */
function preparedForAddressBar(tab) {
  return tab.url === "about:blank" && tab.width === 0 && tab.height === 0;
}
