// Unit tests for the last-tab decision a `close` rule makes before it removes
// a tab, and the ones an update makes before and after it closes the add-on's
// pages (DESIGN.md §12).
//   nix develop --command node --test

import test from "node:test";
import assert from "node:assert/strict";

import { needsFreshTab, needsTabAfterUpdate, windowsAnUpdateCloses } from "../extension/common/tabs.js";

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

// --- an update -------------------------------------------------------------

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
