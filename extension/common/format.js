// Shared by the background, the block page and the popup, so the three of them
// cannot drift into formatting durations differently.

/** mm:ss, or h:mm:ss past an hour. */
export function clock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const s = String(total % 60).padStart(2, "0");
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Same, but rounding up — for countdowns, so they never show 0:00 while waiting. */
export function countdown(ms) {
  return clock(Math.ceil(Math.max(0, ms) / 1000) * 1000);
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
