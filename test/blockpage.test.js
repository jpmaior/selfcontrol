// Unit tests for how far back the block page's Go back reaches (DESIGN.md
// §19), and for which limit the page describes (DESIGN.md §22).
//   nix develop --command node --test

import test from "node:test";
import assert from "node:assert/strict";

import { blockPageIndex, canGoBack, describedReason, showsGoBack } from "../extension/common/blockpage.js";

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
