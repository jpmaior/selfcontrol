// Which open tabs count when a `close` rule decides whether the tab it closes
// is the last one. PURE: no `browser.*`; the caller passes the tabs and the
// platform, so both platforms are covered by node --test.
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
