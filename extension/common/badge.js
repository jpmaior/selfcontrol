// The toolbar badge: a state indicator, not a countdown (DESIGN.md §18).
//
// badgeFor() is PURE and decides from the statuses alone; applyBadge() is the
// one place that touches browser.action, and it is feature-detected and
// wrapped, since Android may not draw badges at all. The badge is set only on
// transitions, so nothing ticks and the event page stays asleep in between.

/** Same greens and oranges as the popup, so the two read as one thing. */
const LIVE = "#2e9e5b";
const SPENT = "#e4572e";

export const BADGE_NONE = { text: "", color: LIVE, textColor: "#ffffff" };

/**
 * `●` while any rule is counting (an active pass counts: the site is open on
 * borrowed time), `!` while a rule is blocked and nothing is counting, empty
 * otherwise. Counting wins over blocked because it is what is happening now.
 */
export function badgeFor(statuses) {
  let counting = false;
  let exhausted = false;
  for (const s of statuses) {
    if (s?.counting || s?.pass?.active) counting = true;
    if (s?.exhausted) exhausted = true;
  }
  if (counting) return { text: "●", color: LIVE, textColor: "#ffffff" };
  if (exhausted) return { text: "!", color: SPENT, textColor: "#ffffff" };
  return BADGE_NONE;
}

export async function applyBadge(badge) {
  const action = globalThis.browser?.action;
  if (typeof action?.setBadgeText !== "function") return false;
  try {
    await action.setBadgeText({ text: badge.text });
    if (badge.text) {
      await action.setBadgeBackgroundColor?.({ color: badge.color });
      await action.setBadgeTextColor?.({ color: badge.textColor });
    }
    return true;
  } catch {
    return false;
  }
}
