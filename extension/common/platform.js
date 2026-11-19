// Which Firefox this is, for what feature detection cannot see (DESIGN.md §12).
// Shared by the background, the popup and the options page so they cannot
// disagree.

async function isAndroid() {
  return (await browser.runtime.getPlatformInfo()).os === "android";
}

/**
 * Whether tabs report `audible`, which an `audible` rule counts on. Firefox for
 * Android has the property and returns undefined (bug 2032751), which only a
 * tab that is playing could show.
 */
export async function reportsAudible() {
  return !(await isAndroid());
}

/**
 * Whether removing a window's last tab closes the window, and with the last
 * window Firefox: desktop. On Android every tab reports a window of its own,
 * so the last tab of all is what counts there (needsFreshTab() in tabs.js).
 */
export async function lastTabClosesWindow() {
  return !(await isAndroid());
}
