// Unit tests for the last-tab decision a `close` rule makes before it removes
// a tab, the ones an update makes before and after it closes the add-on's
// pages (DESIGN.md §12), and for how far back the block page's Go back reaches
// (DESIGN.md §19).
//   nix develop --command node --test

import test from "node:test";
import assert from "node:assert/strict";

import {
  blockPageIndex,
  canGoBack,
  describedReason,
  needsFreshTab,
  needsTabAfterUpdate,
  showsGoBack,
  windowsAnUpdateCloses,
} from "../extension/common/tabs.js";

// What lastTabClosesWindow() answers on each platform.
const DESKTOP = { perWindow: true };
const ANDROID = { perWindow: false };

// A tab that has loaded something has the size of the screen, shown or not.
const tab = (id, windowId, url = `https://example.com/${id}`) => ({
  id,
  windowId,
  url,
  title: `Page ${id}`,
  width: 1080,
  height: 2088,
});

const site = tab(1, 1, "https://www.instagram.com/");

// What Firefox for Android reports for the tab it prepares when the address
// bar is tapped, until a new tab is opened: about:blank, nothing drawn yet.
const prepared = { id: 9, windowId: 9, url: "about:blank", title: "", width: 0, height: 0 };

test("needsFreshTab desktop: the window's only tab needs one", () => {
  assert.equal(needsFreshTab(site, [site], DESKTOP), true);
});

test("needsFreshTab desktop: another tab in the window is enough", () => {
  assert.equal(needsFreshTab(site, [site, tab(2, 1)], DESKTOP), false);
});

test("needsFreshTab desktop: tabs in other windows do not keep this one open", () => {
  assert.equal(needsFreshTab(site, [site, tab(2, 2), tab(3, 3)], DESKTOP), true);
});

test("needsFreshTab android: every tab counts, whatever window it reports", () => {
  // Each tab reports a window of its own there (issue #23).
  const other = tab(2, 2);
  assert.equal(needsFreshTab(site, [site, other], ANDROID), false);
  assert.equal(needsFreshTab(site, [site], ANDROID), true);
});

test("needsFreshTab android: the tab prepared for the address bar does not count", () => {
  assert.equal(needsFreshTab(site, [site, prepared], ANDROID), true);
  assert.equal(needsFreshTab(site, [prepared, site, tab(2, 2)], ANDROID), false);
});

test("needsFreshTab android: a blank tab that has been shown counts", () => {
  const shown = { ...tab(2, 2, "about:blank"), title: "" };
  assert.equal(needsFreshTab(site, [site, shown], ANDROID), false);
});

test("needsFreshTab android: a background tab that has loaded counts", () => {
  const background = tab(2, 2, "https://example.com/article");
  assert.equal(needsFreshTab(site, [site, background], ANDROID), false);
});

test("needsFreshTab android: a loaded page reported at 0×0 still counts", () => {
  // Only about:blank is ignored; a page with a URL is a tab the user has.
  const odd = { ...tab(2, 2), width: 0, height: 0 };
  assert.equal(needsFreshTab(site, [site, odd], ANDROID), false);
});

test("needsFreshTab: the tab being closed never counts as one left", () => {
  // tabs.query may or may not still list it, depending on what landed first.
  for (const platform of [DESKTOP, ANDROID]) {
    assert.equal(needsFreshTab(site, [site], platform), true);
    assert.equal(needsFreshTab(site, [], platform), true);
    assert.equal(needsFreshTab(site, [tab(2, 1)], platform), false);
  }
});

test("needsFreshTab: two of a rule's tabs, the first closed leaves the second", () => {
  // A sweep closes them one at a time: the first leaves the other open, the
  // second is then the last.
  const second = tab(2, 1, "https://www.instagram.com/reels/");
  for (const platform of [DESKTOP, ANDROID]) {
    assert.equal(needsFreshTab(site, [site, second], platform), false);
    assert.equal(needsFreshTab(second, [second], platform), true);
  }
});

// --- Go back ---------------------------------------------------------------

// runtime.onInstalled's details, as Firefox passes them.
const updated = { reason: "update", previousVersion: "0.3.3" };

test("needsTabAfterUpdate android: an update that left no tab opens one", () => {
  // The add-on's pages close with the old version; when one was the only tab,
  // Firefox for Android is left on its last frame with 0 tabs (issue #37).
  assert.equal(needsTabAfterUpdate(updated, [], ANDROID), true);
});

test("needsTabAfterUpdate android: the tab prepared for the address bar does not count", () => {
  assert.equal(needsTabAfterUpdate(updated, [prepared], ANDROID), true);
});

test("needsTabAfterUpdate android: any tab the user has is enough", () => {
  assert.equal(needsTabAfterUpdate(updated, [tab(2, 2)], ANDROID), false);
  assert.equal(needsTabAfterUpdate(updated, [prepared, tab(2, 2)], ANDROID), false);
  const shown = { ...tab(3, 3, "about:blank"), title: "" };
  assert.equal(needsTabAfterUpdate(updated, [shown], ANDROID), false);
});

test("needsTabAfterUpdate android: only an update closed pages of ours", () => {
  // A first install had no pages open, and a Firefox update does not close them.
  for (const reason of ["install", "browser_update"]) {
    assert.equal(needsTabAfterUpdate({ reason }, [], ANDROID), false);
  }
});

test("needsTabAfterUpdate desktop: never, the window went with its last tab", () => {
  assert.equal(needsTabAfterUpdate(updated, [], DESKTOP), false);
  assert.equal(needsTabAfterUpdate(updated, [tab(2, 1)], DESKTOP), false);
});

// runtime.getURL(""): the origin of the add-on's own pages.
const OURS = "moz-extension://5f0c2a1e-0000-4000-8000-000000000001/";
const page = (id, windowId, path = "blocked/blocked.html?rule=youtube") => tab(id, windowId, `${OURS}${path}`);

test("windowsAnUpdateCloses: a window holding only our pages is closed with them", () => {
  // Firefox closes the add-on's pages as it unloads the old version, and a
  // window goes with its last tab; with the last window, Firefox quits (#50).
  assert.deepEqual(windowsAnUpdateCloses([page(1, 1)], OURS), [1]);
  assert.deepEqual(windowsAnUpdateCloses([page(1, 1), page(2, 1, "options/options.html")], OURS), [1]);
});

test("windowsAnUpdateCloses: any other tab keeps the window open", () => {
  assert.deepEqual(windowsAnUpdateCloses([page(1, 1), tab(2, 1)], OURS), []);
  assert.deepEqual(windowsAnUpdateCloses([tab(1, 1), tab(2, 2)], OURS), []);
});

test("windowsAnUpdateCloses: each window is decided on its own tabs", () => {
  const tabs = [tab(1, 1), page(2, 1), page(3, 2), page(4, 3), page(5, 3), tab(6, 4)];
  assert.deepEqual(windowsAnUpdateCloses(tabs, OURS), [2, 3]);
});

test("windowsAnUpdateCloses: another add-on's page is not closed with ours", () => {
  const theirs = tab(2, 1, "moz-extension://0d6ee0a7-0000-4000-8000-000000000002/page.html");
  assert.deepEqual(windowsAnUpdateCloses([page(1, 1), theirs], OURS), []);
});

test("windowsAnUpdateCloses: no tabs, no windows", () => {
  assert.deepEqual(windowsAnUpdateCloses([], OURS), []);
});

test("blockPageIndex: freshly opened, the block page is the tab's last entry", () => {
  // tabs.update pushes it and drops anything forward of it.
  assert.equal(blockPageIndex(null, 3), 2);
  assert.equal(blockPageIndex(undefined, 1), 0);
});

test("blockPageIndex: once recorded, the entry's own index wins over the length", () => {
  // Blocked in a new tab, a URL typed from the block page, then Back to it:
  // three entries, but the block page is the second.
  assert.equal(blockPageIndex({ blockIndex: 1 }, 3), 1);
  assert.equal(blockPageIndex({ blockIndex: 4 }, 9), 4);
  assert.equal(blockPageIndex({ blockIndex: 0 }, 2), 0);
});

test("blockPageIndex: a state it did not write is ignored", () => {
  for (const state of [{}, { blockIndex: "2" }, { blockIndex: -1 }, { blockIndex: 1.5 }, "2", 7]) {
    assert.equal(blockPageIndex(state, 3), 2, JSON.stringify(state));
  }
});

test("canGoBack: only with a page before the blocked one", () => {
  // Two steps back from the block page: at 1 that is nothing, the blocked
  // page having been the tab's first (opened in a new tab); from 2 on it is
  // the page the user came from.
  assert.equal(canGoBack(0), false);
  assert.equal(canGoBack(1), false);
  assert.equal(canGoBack(2), true);
  assert.equal(canGoBack(5), true);
});

test("showsGoBack: only on a site blocked outright, with a page to go back to", () => {
  // A budget of zero never unlocks, so its block page needs a way out; a spent
  // budget's block page counts down to one instead (DESIGN.md §19).
  assert.equal(showsGoBack({ reason: "always", unlocked: false, index: 2 }), true);
  assert.equal(showsGoBack({ reason: "always", unlocked: false, index: 1 }), false);
});

test("showsGoBack: never on a spent budget's block page", () => {
  for (const reason of ["rolling", "daily", "weekly"]) {
    assert.equal(showsGoBack({ reason, unlocked: false, index: 5 }), false, reason);
  }
});

test("showsGoBack: gone once the page unlocks", () => {
  // Raising the budget unlocks the page, and Back to … is the way out then.
  // The page's reason can still say "always" at that point (issue #44).
  assert.equal(showsGoBack({ reason: "always", unlocked: true, index: 2 }), false);
});

// What the block page's status reply carries, for describedReason().
const spent = (reason) => ({ exhausted: true, reason, binding: null });
const open = (binding) => ({ exhausted: false, reason: null, binding });

test("describedReason: a spent rule is described by what blocks it now", () => {
  assert.equal(describedReason("rolling", spent("rolling")), "rolling");
  // The daily cap filled while the rolling one was blocking.
  assert.equal(describedReason("rolling", spent("daily")), "daily");
  // The budget was set to zero with the page open.
  assert.equal(describedReason("rolling", spent("always")), "always");
});

test("describedReason: raising a zero budget leaves the outright block behind", () => {
  // The page unlocks, and its usage line must stop saying the site has no
  // time allowed (issue #44): it describes the cap with the least left.
  assert.equal(describedReason("always", open("rolling")), "rolling");
  assert.equal(describedReason("always", open("daily")), "daily");
});

test("describedReason: a spent budget's page keeps its cap once it unlocks", () => {
  // Unlocked by its own countdown, a page that said "done for today" goes on
  // describing the daily cap rather than whichever has the least left.
  assert.equal(describedReason("daily", open("rolling")), "daily");
  assert.equal(describedReason("rolling", open("weekly")), "rolling");
});
