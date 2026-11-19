// Unit tests for the shared duration and wall-clock formatting.
//   nix develop --command node --test

process.env.TZ = "Europe/Lisbon";

import test from "node:test";
import assert from "node:assert/strict";

import { clock, countdown, wallClock } from "../extension/common/format.js";

test("clock: mm:ss, then h:mm:ss", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(65_000), "1:05");
  assert.equal(clock(3_600_000), "1:00:00");
  assert.equal(clock(-5), "0:00", "never negative");
});

test("countdown: rounds up so it never shows 0:00 while waiting", () => {
  assert.equal(countdown(1), "0:01");
  assert.equal(countdown(59_001), "1:00");
  assert.equal(countdown(0), "0:00");
});

test("countdown: a day or more is counted in days, not in hundreds of hours", () => {
  const H = 3_600_000;
  assert.equal(countdown(24 * H - 1000), "23:59:59", "under a day is unchanged");
  assert.equal(countdown(24 * H), "1d 0:00:00");
  assert.equal(countdown(123 * H + 52 * 60_000 + 32_000), "5d 3:52:32", "a week's countdown");
  assert.equal(countdown(24 * H + 5 * 60_000 + 1), "1d 0:05:01", "still rounds up");
});

test("clock: an amount of time keeps its hours", () => {
  assert.equal(clock(30 * 3_600_000), "30:00:00", "a weekly budget reads as hours");
});

test("wallClock: today is a time, another day carries the weekday", () => {
  const now = new Date(2026, 8, 14, 10, 0).getTime(); // Monday
  assert.equal(wallClock(new Date(2026, 8, 14, 14, 32).getTime(), now), "14:32");
  assert.equal(wallClock(new Date(2026, 8, 15, 9, 5).getTime(), now), "Tue 09:05");
  assert.equal(wallClock(new Date(2026, 8, 14, 0, 0).getTime(), now), "00:00");
  assert.equal(wallClock(new Date(2026, 8, 15, 0, 0).getTime(), now), "Tue 00:00", "midnight is tomorrow");
});
