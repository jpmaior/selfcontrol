// What the block page shows besides its countdown: whether it offers Go back
// and how far back that reaches (DESIGN.md §19), and which limit it describes
// (DESIGN.md §22). PURE: no `browser.*` and no `history`; the page passes the
// history it sees and the status replies it gets, so node --test covers them.

/**
 * The block page's position in its tab's history (DESIGN.md §19). Freshly
 * opened it is the last entry, since tabs.update pushes it and drops anything
 * forward of it. The page records that in its entry's `history.state`, which
 * stays with the entry, because once the user goes forward from it and comes
 * back, `history.length` also counts the entries ahead. `state` is whatever
 * history.state holds; anything this did not write is ignored.
 */
export function blockPageIndex(state, historyLength) {
  const recorded = state?.blockIndex;
  return Number.isInteger(recorded) && recorded >= 0 ? recorded : historyLength - 1;
}

/**
 * Go back skips the blocked page, which is always the entry just before the
 * block page, so it needs one more before that: the page the user came from.
 */
export const GO_BACK_STEPS = 2;

export function canGoBack(index) {
  return index >= GO_BACK_STEPS;
}

/**
 * Go back is for a site blocked outright, whose block page never unlocks on
 * its own (DESIGN.md §19, §22). A spent budget's block page counts down to the
 * way out instead, and once any block page unlocks, Back to … is the way out.
 * `index` is blockPageIndex()'s answer.
 */
export function showsGoBack({ reason, unlocked, index }) {
  return reason === "always" && !unlocked && canGoBack(index);
}

/**
 * Which limit the block page describes, given the one it describes now and a
 * status reply for its rule. A spent rule is described by what blocks it now,
 * so a daily cap that fills while the rolling one blocks retitles the page.
 * Once the rule is open again the page keeps its limit, so a page that said
 * "done for today" goes on describing the daily cap, with one exception: a
 * raised zero budget (DESIGN.md §22). "always" describes no time allowed, which
 * is no longer true, so the page moves to the cap with the least left.
 */
export function describedReason(current, { exhausted, reason, binding }) {
  if (exhausted) return reason;
  return current === "always" ? (binding ?? "rolling") : current;
}
