// Shared by the background and the pages, so they cannot drift into formatting
// durations, or wording a block, differently.

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

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const two = (n) => String(n).padStart(2, "0");

/**
 * A wall-clock instant for "until 14:32": the time alone when it falls on
 * the same local day as `nowMs`, otherwise prefixed with the weekday. Fixed
 * 24-hour digits rather than the locale, so the popup, the block page and
 * the console logs all agree.
 */
export function wallClock(ms, nowMs) {
  const at = new Date(ms);
  const time = `${two(at.getHours())}:${two(at.getMinutes())}`;
  const sameDay = at.toDateString() === new Date(nowMs).toDateString();
  return sameDay ? time : `${DAY_NAMES[at.getDay()]} ${time}`;
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
