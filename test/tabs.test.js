// Unit tests for the last-tab decision a `close` rule makes before it removes
// a tab (DESIGN.md §12), and for how far back the block page's Go back reaches
// (DESIGN.md §19).
//   nix develop --command node --test

import test from "node:test";
import assert from "node:assert/strict";

import { blockPageIndex, canGoBack, needsFreshTab } from "../extension/common/tabs.js";

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
