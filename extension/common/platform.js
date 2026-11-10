// What this browser can observe, for the decisions that depend on it. Shared
// by the background, the popup and the options page so they cannot disagree.

/**
 * Whether tabs report `audible`, which an `audible` rule counts on.
 *
 * Firefox for Android does not: it has the property, and it returns undefined
 * (bug 2032751; DESIGN.md §12). Feature detection cannot see that without a
 * tab that is playing, so the platform is the signal.
 */
export async function reportsAudible() {
  const { os } = await browser.runtime.getPlatformInfo();
  return os !== "android";
}

/**
 * Whether removing a window's last tab closes the window, and closing the last
 * window closes Firefox (closeWindowWithLastTab), so a `close` rule must open
 * a fresh tab before it removes a window's last one.
 *
 * Desktop only. Firefox for Android has no window to lose, and each tab there
 * reports a window of its own, so every tab would look like a window's last;
 * there the fresh tab is for the last tab Firefox has. needsFreshTab() in
 * tabs.js takes the answer (DESIGN.md §12).
 */
export async function lastTabClosesWindow() {
  const { os } = await browser.runtime.getPlatformInfo();
  return os !== "android";
}
