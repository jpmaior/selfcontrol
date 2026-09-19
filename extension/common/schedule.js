// Blocked spans in local time. PURE: no `browser.*`, no `Date.now()`.
//
// A rule's schedule is a list of spans, each on one weekday (Mon = 0) between
// two minutes of the day, `fromMin` inclusive and `toMin` exclusive, with 1440
// meaning midnight at the end of the day:
//
//   [{ day: 0, fromMin: 540, toMin: 1080 }]   // Monday 09:00–18:00
//
// Spans never wrap past midnight. An overnight block is two spans, 22:00–24:00
// and 00:00–07:00 the next day, which is what the grid editor produces
// naturally; blockEndsAt() joins them back together so the block page can say
// "until 07:00" rather than "until 00:00". See DESIGN.md §15.

import { addDays, atMinute, minuteOfDay, startOfDay, weekday } from "./calendar.js";

export const MINUTES_PER_DAY = 1440;
export const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function isValidSpan(span) {
  return (
    Boolean(span) &&
    typeof span === "object" &&
    Number.isInteger(span.day) &&
    span.day >= 0 &&
    span.day <= 6 &&
    Number.isInteger(span.fromMin) &&
    Number.isInteger(span.toMin) &&
    span.fromMin >= 0 &&
    span.toMin <= MINUTES_PER_DAY &&
    span.fromMin < span.toMin
  );
}

/**
 * A clean copy: valid spans only, sorted by day then start, with overlapping
 * and touching spans on the same day merged. Every other function here calls
 * this first, so callers may pass whatever was stored.
 */
export function normalizeSpans(spans) {
  if (!Array.isArray(spans)) return [];
  const sorted = spans
    .filter(isValidSpan)
    .map((s) => ({ day: s.day, fromMin: s.fromMin, toMin: s.toMin }))
    .sort((a, b) => a.day - b.day || a.fromMin - b.fromMin);

  const out = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last && last.day === span.day && span.fromMin <= last.toMin) {
      last.toMin = Math.max(last.toMin, span.toMin);
    } else {
      out.push(span);
    }
  }
  return out;
}

function spanAt(spans, day, minute) {
  return spans.find((s) => s.day === day && s.fromMin <= minute && minute < s.toMin) ?? null;
}

export function blockedAt(spans, nowMs) {
  return spanAt(normalizeSpans(spans), weekday(nowMs), minuteOfDay(nowMs)) !== null;
}

/**
 * The instant the current block ends, or null if not blocked. A span that
 * runs to midnight continues into a span starting at 0 the next day. A
 * schedule that blocks the whole week never ends; a week away is as far as
 * this looks.
 */
export function blockEndsAt(spans, nowMs) {
  const all = normalizeSpans(spans);
  let day = weekday(nowMs);
  let dayStart = startOfDay(nowMs);
  let current = spanAt(all, day, minuteOfDay(nowMs));
  if (!current) return null;

  for (let hops = 0; current.toMin === MINUTES_PER_DAY; hops++) {
    if (hops >= 7) return dayStart;
    day = (day + 1) % 7;
    dayStart = addDays(dayStart, 1);
    const next = all.find((s) => s.day === day && s.fromMin === 0);
    if (!next) return dayStart;
    current = next;
  }
  return atMinute(dayStart, current.toMin);
}

/** The next span start strictly after `nowMs`, up to a week ahead, or null. */
export function nextBlockStartsAt(spans, nowMs) {
  const all = normalizeSpans(spans);
  if (all.length === 0) return null;

  let dayStart = startOfDay(nowMs);
  for (let ahead = 0; ahead <= 7; ahead++) {
    const day = (weekday(nowMs) + ahead) % 7;
    for (const span of all) {
      if (span.day !== day) continue;
      const at = atMinute(dayStart, span.fromMin);
      if (at > nowMs) return at;
    }
    dayStart = addDays(dayStart, 1);
  }
  return null;
}

// --- the grid the editor paints -----------------------------------------

/**
 * 7 rows of booleans, one per `slotMin`-minute slot. A span that is not
 * slot-aligned is widened to every slot it touches, so opening the editor
 * never makes a stored schedule looser than it was.
 */
export function spansToGrid(spans, slotMin) {
  const slots = MINUTES_PER_DAY / slotMin;
  const grid = Array.from({ length: 7 }, () => new Array(slots).fill(false));
  for (const span of normalizeSpans(spans)) {
    const first = Math.floor(span.fromMin / slotMin);
    const last = Math.ceil(span.toMin / slotMin) - 1;
    for (let i = first; i <= last; i++) grid[span.day][i] = true;
  }
  return grid;
}

export function gridToSpans(grid, slotMin) {
  const spans = [];
  grid.forEach((row, day) => {
    let start = null;
    row.forEach((on, i) => {
      if (on && start === null) start = i;
      if (!on && start !== null) {
        spans.push({ day, fromMin: start * slotMin, toMin: i * slotMin });
        start = null;
      }
    });
    if (start !== null) spans.push({ day, fromMin: start * slotMin, toMin: row.length * slotMin });
  });
  return normalizeSpans(spans);
}

/** Two of the three presets the editor offers; "Clear" is the empty list. */
export const PRESETS = {
  work: [0, 1, 2, 3, 4].map((day) => ({ day, fromMin: 9 * 60, toMin: 18 * 60 })),
  evenings: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, fromMin: 20 * 60, toMin: MINUTES_PER_DAY })),
};

// --- describing ---------------------------------------------------------

const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** "Mon–Fri" for three or more consecutive days, "Mon, Tue" otherwise. */
function describeDays(days) {
  const parts = [];
  let i = 0;
  while (i < days.length) {
    let j = i;
    while (j + 1 < days.length && days[j + 1] === days[j] + 1) j++;
    if (j - i >= 2) {
      parts.push(`${DAY_NAMES[days[i]]}–${DAY_NAMES[days[j]]}`);
    } else {
      for (let k = i; k <= j; k++) parts.push(DAY_NAMES[days[k]]);
    }
    i = j + 1;
  }
  return parts.join(", ");
}

/** A one-line summary for the options page, grouping days with identical spans. */
export function describeSpans(spans) {
  const all = normalizeSpans(spans);
  if (all.length === 0) return "No schedule";

  const groups = new Map(); // times text -> days
  for (let day = 0; day <= 6; day++) {
    const times = all
      .filter((s) => s.day === day)
      .map((s) => `${hhmm(s.fromMin)}–${hhmm(s.toMin)}`)
      .join(", ");
    if (!times) continue;
    if (!groups.has(times)) groups.set(times, []);
    groups.get(times).push(day);
  }

  const parts = [...groups].map(([times, days]) => `${describeDays(days)} ${times}`);
  return `Blocked ${parts.join("; ")}`;
}
