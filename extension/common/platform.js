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
