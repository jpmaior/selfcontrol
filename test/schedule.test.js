// Unit tests for schedule.js: blocked spans in local time.
//   nix develop --command node --test

process.env.TZ = "Europe/Lisbon";

import test from "node:test";
import assert from "node:assert/strict";

import {
  blockEndsAt,
  blockedAt,
  describeSpans,
  gridToSpans,
  nextBlockStartsAt,
  normalizeSpans,
  spansToGrid,
} from "../extension/common/schedule.js";

const local = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

// 2026-09-14 is a Monday.
const MON = (h, m = 0) => local(2026, 9, 14, h, m);
const TUE = (h, m = 0) => local(2026, 9, 15, h, m);
const SUN = (h, m = 0) => local(2026, 9, 20, h, m);

const span = (day, fromMin, toMin) => ({ day, fromMin, toMin });
const H = (h) => h * 60;

const WORK = [0, 1, 2, 3, 4].map((day) => span(day, H(9), H(18)));

// --- normalizeSpans ------------------------------------------------------

test("normalizeSpans: sorts by day then start", () => {
  const out = normalizeSpans([span(2, H(9), H(10)), span(0, H(20), H(21)), span(0, H(9), H(10))]);
  assert.deepEqual(out, [span(0, H(9), H(10)), span(0, H(20), H(21)), span(2, H(9), H(10))]);
});

test("normalizeSpans: merges overlapping and touching spans on the same day", () => {
  const out = normalizeSpans([span(0, H(9), H(12)), span(0, H(12), H(15)), span(0, H(14), H(16))]);
  assert.deepEqual(out, [span(0, H(9), H(16))]);
});

test("normalizeSpans: does not merge across days, drops empty and invalid spans", () => {
  const out = normalizeSpans([
    span(0, H(22), H(24)),
    span(1, H(0), H(1)),
    span(1, H(5), H(5)),
    span(1, H(7), H(6)),
    span(9, H(1), H(2)),
    null,
    { day: 0 },
  ]);
  assert.deepEqual(out, [span(0, H(22), H(24)), span(1, H(0), H(1))]);
});

test("normalizeSpans: does not mutate its input", () => {
  const input = [span(0, H(12), H(13)), span(0, H(9), H(10))];
  const copy = structuredClone(input);
  normalizeSpans(input);
  assert.deepEqual(input, copy);
});

// --- blockedAt -----------------------------------------------------------

test("blockedAt: inside, at the start (blocked), at the end (open)", () => {
  assert.equal(blockedAt(WORK, MON(10)), true);
  assert.equal(blockedAt(WORK, MON(9, 0)), true, "fromMin is inclusive");
  assert.equal(blockedAt(WORK, MON(18, 0)), false, "toMin is exclusive");
  assert.equal(blockedAt(WORK, MON(8, 59)), false);
});

test("blockedAt: a span ending at 1440 covers the last minute of the day", () => {
  const spans = [span(0, H(22), 1440)];
  assert.equal(blockedAt(spans, MON(23, 59)), true);
  assert.equal(blockedAt(spans, TUE(0, 0)), false, "the next day is a different span");
});

test("blockedAt: a different weekday is open; Sunday is 6, not 0", () => {
  assert.equal(blockedAt(WORK, SUN(10)), false);
  const sundayOnly = [span(6, H(9), H(18))];
  assert.equal(blockedAt(sundayOnly, SUN(10)), true);
  assert.equal(blockedAt(sundayOnly, MON(10)), false);
});

test("blockedAt: an empty schedule never blocks", () => {
  assert.equal(blockedAt([], MON(10)), false);
  assert.equal(blockedAt(undefined, MON(10)), false);
});

// --- blockEndsAt ---------------------------------------------------------

test("blockEndsAt: the end of the current span, null when open", () => {
  assert.equal(blockEndsAt(WORK, MON(10)), MON(18));
  assert.equal(blockEndsAt(WORK, MON(19)), null);
});

test("blockEndsAt: adjacent spans read as one block", () => {
  const spans = [span(0, H(9), H(12)), span(0, H(12), H(15))];
  assert.equal(blockEndsAt(spans, MON(10)), MON(15));
});

test("blockEndsAt: a span ending at midnight continues into a span starting at 0 the next day", () => {
  const spans = [span(0, H(22), 1440), span(1, 0, H(1))];
  assert.equal(blockEndsAt(spans, MON(23)), TUE(1), "until 01:00, not 00:00");
  assert.equal(blockEndsAt(spans, TUE(0, 30)), TUE(1));
});

test("blockEndsAt: an all-week block wraps from Sunday into Monday", () => {
  const always = [0, 1, 2, 3, 4, 5, 6].map((day) => span(day, 0, 1440));
  // The chain must terminate: after a full lap it is the same instant next week.
  assert.equal(blockEndsAt(always, SUN(12)), local(2026, 9, 27));
});

test("blockEndsAt: a span to 1440 on the 25-hour day ends at the real midnight", () => {
  // 2026-10-25 is a Sunday and the fall-back day in Lisbon.
  const spans = [span(6, 0, 1440)];
  assert.equal(blockEndsAt(spans, local(2026, 10, 25, 12)), local(2026, 10, 26));
});

// --- nextBlockStartsAt ---------------------------------------------------

test("nextBlockStartsAt: later today, tomorrow, next week, never", () => {
  assert.equal(nextBlockStartsAt(WORK, MON(8)), MON(9), "later today");
  assert.equal(nextBlockStartsAt(WORK, MON(19)), TUE(9), "tomorrow");
  const mondayOnly = [span(0, H(9), H(10))];
  assert.equal(nextBlockStartsAt(mondayOnly, MON(11)), local(2026, 9, 21, 9), "next Monday");
  assert.equal(nextBlockStartsAt([], MON(8)), null);
});

test("nextBlockStartsAt: at the start instant the block has begun, so the next one is later", () => {
  assert.equal(nextBlockStartsAt(WORK, MON(9)), TUE(9));
});

test("nextBlockStartsAt: while blocked, the next start is strictly in the future", () => {
  assert.equal(nextBlockStartsAt(WORK, MON(10)), TUE(9));
});

// --- grid helpers --------------------------------------------------------

test("spansToGrid / gridToSpans: round-trip at 30-minute slots", () => {
  const grid = spansToGrid(WORK, 30);
  assert.equal(grid.length, 7);
  assert.equal(grid[0].length, 48);
  assert.equal(grid[0][18], true, "09:00 slot");
  assert.equal(grid[0][35], true, "17:30 slot");
  assert.equal(grid[0][36], false, "18:00 slot");
  assert.equal(grid[5][18], false, "Saturday");
  assert.deepEqual(gridToSpans(grid, 30), WORK);
});

test("spansToGrid: a span that is not slot-aligned is widened to the enclosing slots", () => {
  // The rule: every slot the span touches is blocked, so painting never makes
  // a schedule looser than what was stored.
  const grid = spansToGrid([span(0, 545, 605)], 30);
  assert.deepEqual(gridToSpans(grid, 30), [span(0, 540, 630)]);
});

test("gridToSpans: merges adjacent slots and handles a full day", () => {
  const grid = spansToGrid([], 30);
  grid[6].fill(true);
  grid[1][0] = true;
  grid[1][1] = true;
  grid[1][3] = true;
  assert.deepEqual(gridToSpans(grid, 30), [span(1, 0, 60), span(1, 90, 120), span(6, 0, 1440)]);
});

// --- describeSpans -------------------------------------------------------

test("describeSpans: nothing, a weekday run, and a scattered pair", () => {
  assert.equal(describeSpans([]), "No schedule");
  assert.equal(describeSpans(WORK), "Blocked Mon–Fri 09:00–18:00");
  assert.equal(describeSpans([span(0, H(9), H(18)), span(2, H(9), H(18))]), "Blocked Mon, Wed 09:00–18:00");
});

test("describeSpans: several ranges in a day, and several day groups", () => {
  const split = [span(0, H(9), H(12)), span(0, H(14), H(18))];
  assert.equal(describeSpans(split), "Blocked Mon 09:00–12:00, 14:00–18:00");

  const mixed = [...WORK, span(5, 0, 1440), span(6, 0, 1440)];
  assert.equal(describeSpans(mixed), "Blocked Mon–Fri 09:00–18:00; Sat, Sun 00:00–24:00");
});

test("describeSpans: a run of two days is a pair, not a range", () => {
  assert.equal(describeSpans([span(0, H(9), H(10)), span(1, H(9), H(10))]), "Blocked Mon, Tue 09:00–10:00");
});
