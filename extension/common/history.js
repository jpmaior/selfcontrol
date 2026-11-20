// The history view's shape: a rule's per-day usage as weeks of seven local
// days, oldest first. PURE: no `browser.*`, no `Date.now()`.
//
// The options page draws the kept days (HISTORY_DAYS) as a calendar, one row
// per week, so that ninety days stay readable on a phone (DESIGN.md §13). The
// rows begin at the first week with any use rather than ninety days back, so a
// new rule is a row or two, not a page of empty ones. A kept day with nothing
// in it is a zero; a day before the kept range or still to come is out of
// range, so the page can leave it blank rather than claim a zero it does not
// know.
//
// A week here starts on the chosen day and is always seven days. A carried week
// (calendar.js changeWeekStart()) is not followed: it would make one row up to
// thirteen days long, and the folded days do not depend on the week anyway.

import { HISTORY_DAYS } from "./accountant.js";
import { MONDAY, addDays, dayKey, startOfDay, startOfWeek } from "./calendar.js";

const isCap = (ms) => Number.isFinite(ms) && ms > 0;

/**
 * `byDay` is usedByDay()'s `{ "YYYY-MM-DD": { used, pass } }`. Returns
 * `[{ startMs, used, pass, reached, days: [{ key, at, used, pass, inRange,
 * reached }] × 7 }]`, oldest week first, or `[]` when no kept day has any use.
 *
 * `reached` says the day (or week) used at least its cap, by what the cap
 * counts: pass time too unless the rule's passes do not count toward the caps.
 * It is measured against the cap given, which is the rule's cap now, not
 * necessarily the one it had that day.
 */
export function historyWeeks(
  byDay,
  nowMs,
  { startDay = MONDAY, days = HISTORY_DAYS, dailyBudgetMs = null, weeklyBudgetMs = null, passCounts = true } = {},
) {
  const today = startOfDay(nowMs);
  const firstKey = dayKey(addDays(today, -(days - 1)));
  const lastKey = dayKey(today);
  const kept = (key) => key >= firstKey && key <= lastKey;
  const counted = ({ used, pass }) => used + (passCounts ? pass : 0);

  const used = Object.keys(byDay)
    .filter((key) => kept(key) && byDay[key].used + byDay[key].pass > 0)
    .sort();
  if (used.length === 0) return [];

  const [y, m, d] = used[0].split("-").map(Number);
  const lastWeek = startOfWeek(today, startDay);
  const weeks = [];
  // Walked through Date setters, a week and a day at a time, never by adding
  // milliseconds: a DST week is 167 or 169 hours long.
  for (let weekStart = startOfWeek(new Date(y, m - 1, d).getTime(), startDay); weekStart <= lastWeek; ) {
    const week = { startMs: weekStart, used: 0, pass: 0, reached: false, days: [] };
    for (let i = 0; i < 7; i++) {
      const at = addDays(weekStart, i);
      const key = dayKey(at);
      const inRange = kept(key);
      const entry = inRange ? byDay[key] : null;
      const day = { key, at, used: entry?.used ?? 0, pass: entry?.pass ?? 0, inRange, reached: false };
      day.reached = isCap(dailyBudgetMs) && counted(day) >= dailyBudgetMs;
      week.used += day.used;
      week.pass += day.pass;
      week.days.push(day);
    }
    week.reached = isCap(weeklyBudgetMs) && counted(week) >= weeklyBudgetMs;
    weeks.push(week);
    weekStart = addDays(weekStart, 7);
  }
  return weeks;
}
