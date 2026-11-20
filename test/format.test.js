// Unit tests for the shared duration and wall-clock formatting.
//   nix develop --command node --test

process.env.TZ = "Europe/Lisbon";

import test from "node:test";
import assert from "node:assert/strict";

import { clock, countdown, shortDuration, wallClock } from "../extension/common/format.js";

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

test("shortDuration: minutes and hours, never read as a time of day", () => {
  // The history legend puts it after a date: "Mon, Aug 31, 14:00" read as 2 pm (#74).
  const M = 60_000;
  assert.equal(shortDuration(14 * M), "14m");
  assert.equal(shortDuration(60 * M), "1h");
  assert.equal(shortDuration(101 * M), "1h41");
  assert.equal(shortDuration(65 * M), "1h05");
  assert.equal(shortDuration(14 * M + 29_000), "14m", "to the nearest minute");
  assert.equal(shortDuration(30 * 60 * M), "30h", "a weekly figure keeps its hours");
  assert.equal(shortDuration(0), "0");
});

test("shortDuration: under a minute is in seconds, so a day that was used never reads 0", () => {
  assert.equal(shortDuration(40_000), "40s", "a busiest day of 40 s");
  assert.equal(shortDuration(20_000), "20s", "a 20 s budget, which the form cannot show");
  assert.equal(shortDuration(59_400), "59s");
  assert.equal(shortDuration(59_600), "1m", "rounds up into the minutes");
  assert.equal(shortDuration(300), "1s", "a few hundred milliseconds still count");
  assert.equal(shortDuration(-5), "0", "never negative");
});

test("wallClock: today is a time, another day carries the weekday", () => {
  const now = new Date(2026, 8, 14, 10, 0).getTime(); // Monday
  assert.equal(wallClock(new Date(2026, 8, 14, 14, 32).getTime(), now), "14:32");
  assert.equal(wallClock(new Date(2026, 8, 15, 9, 5).getTime(), now), "Tue 09:05");
  assert.equal(wallClock(new Date(2026, 8, 14, 0, 0).getTime(), now), "00:00");
  assert.equal(wallClock(new Date(2026, 8, 15, 0, 0).getTime(), now), "Tue 00:00", "midnight is tomorrow");
});

test("wallClock: past a week from today, the date as well, so a carried week's end is not read as this one", () => {
  // A change of the week's start day can carry the week in progress up to
  // thirteen days (DESIGN.md §14): "Sun 00:00" would read as the coming Sunday.
  const now = new Date(2026, 8, 17, 15, 30).getTime(); // Thursday
  assert.equal(wallClock(new Date(2026, 8, 24, 0, 0).getTime(), now), "Thu 00:00", "a week from today: the name will do");
  assert.equal(wallClock(new Date(2026, 8, 27, 0, 0).getTime(), now), "Sun 27 Sep 00:00");
});
