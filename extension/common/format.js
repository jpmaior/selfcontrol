// Shared by the background and the pages, so they cannot drift into formatting
// durations, or wording a block, differently.

import { addDays, startOfDay } from "./calendar.js";

/** mm:ss, or h:mm:ss past an hour. */
export function clock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const s = String(total % 60).padStart(2, "0");
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

const DAY_MS = 24 * 3_600_000;

/**
 * Same, but rounding up — for countdowns, so they never show 0:00 while
 * waiting. From a day on, the days come first ("5d 3:52:32"): a weekly cap
 * counts down for up to a week, and 123 hours says nothing at a glance. An
 * amount of time, such as a budget, stays in hours through clock().
 */
export function countdown(ms) {
  const rounded = Math.ceil(Math.max(0, ms) / 1000) * 1000;
  if (rounded < DAY_MS) return clock(rounded);
  const rest = rounded % DAY_MS;
  const h = Math.floor(rest / 3_600_000);
  const tail = clock(rest);
  return `${Math.floor(rounded / DAY_MS)}d ${h > 0 ? tail : `0:${tail.padStart(5, "0")}`}`;
}

/**
 * "0", "40s", "30m", "1h", "1h30": short, for a scale, a chip or a legend.
 * Not clock(), whose "14:00" after a date reads as 2 pm (#74). Whole minutes
 * from a minute on; below that seconds, so a day that was used, or a budget
 * set in seconds, never reads as "0", and anything over nothing is at least 1s.
 */
export function shortDuration(ms) {
  if (!(ms > 0)) return "0";
  const sec = Math.max(1, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.round(ms / 60_000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}`;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** In full, by `Date.getDay()` number: for the day the week starts. */
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const two = (n) => String(n).padStart(2, "0");

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A wall-clock instant for "until 14:32": the time alone when it falls on
 * the same local day as `nowMs`, otherwise prefixed with the weekday, and
 * with the date too past a week from today, where the weekday alone would
 * name an earlier day: a carried week can run thirteen days (DESIGN.md §14).
 * Fixed 24-hour digits and English names rather than the locale, so the
 * popup, the block page and the console logs all agree.
 */
export function wallClock(ms, nowMs) {
  const at = new Date(ms);
  const time = `${two(at.getHours())}:${two(at.getMinutes())}`;
  const sameDay = at.toDateString() === new Date(nowMs).toDateString();
  if (sameDay) return time;
  const day = DAY_NAMES[at.getDay()];
  if (startOfDay(ms) <= addDays(startOfDay(nowMs), 7)) return `${day} ${time}`;
  return `${day} ${at.getDate()} ${MONTH_NAMES[at.getMonth()]} ${time}`;
}

/**
 * What a spent rule is, by the limit that releases last (`reason` in
 * policy.evaluate): the block page's headline and the popup's row.
 */
export const BLOCKED = {
  rolling: "done for now",
  daily: "done for today",
  weekly: "done for the week",
  always: "blocked",
};

/** A bold run of text, for a figure or a name inside a sentence. */
export function strong(text) {
  const el = document.createElement("strong");
  el.textContent = text;
  return el;
}
