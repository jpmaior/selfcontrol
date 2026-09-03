// The block page.
//
// The countdown ticks locally every second, but the truth comes from the
// background: the rolling window can hand budget back early, so the page
// re-reads its status periodically rather than trusting the timestamp it was
// opened with.

import { clock, countdown } from "../common/format.js";

const params = new URLSearchParams(location.search);
const ruleId = params.get("rule");
const label = params.get("label") || ruleId || "this site";

const el = {
  emoji: document.getElementById("emoji"),
  headline: document.getElementById("headline"),
  quip: document.getElementById("quip"),
  meter: document.getElementById("meter"),
  countdown: document.getElementById("countdown"),
  countdownText: document.getElementById("countdown-text"),
  detail: document.getElementById("detail"),
};

const QUIPS = [
  "The video will still be there. That is precisely the problem.",
  "You did not run out of time. You ran out of the time you gave yourself.",
  "This is the part where you find out what you were avoiding.",
  "Somewhere, a past version of you is feeling very smug right now.",
  "The algorithm will cope without you.",
  "Consider: a glass of water. A window. A stretch.",
  "You set this limit while thinking clearly. Trust that person.",
];

/** Deterministic per rule and hour, so it does not flicker on every tick. */
function pickQuip() {
  const seed = [...`${ruleId}${new Date().getHours()}`].reduce((a, c) => a + c.charCodeAt(0), 0);
  return QUIPS[seed % QUIPS.length];
}

let unlockAtMs = Number(params.get("until")) || Date.now();
let blockedAtMs = Date.now();

async function refresh() {
  try {
    const statuses = await browser.runtime.sendMessage({ type: "status" });
    const mine = statuses?.find((s) => s.id === ruleId);
    if (!mine) return;

    unlockAtMs = mine.unlockAtMs;
    el.detail.textContent =
      `${label}: ${clock(mine.usedMs)} of ${clock(mine.budgetMs)} used in the last ` +
      `${Math.round(mine.windowMs / 60000)} minutes.`;

    if (!mine.exhausted) unlock();
  } catch {
    // Background asleep or mid-restart; the local tick carries us until the
    // next refresh succeeds.
  }
}

function unlock() {
  document.body.classList.add("unlocked");
  el.emoji.textContent = "✅";
  el.headline.textContent = `${label} is available again`;
  el.quip.textContent = "Spend it deliberately this time.";
  el.countdownText.textContent = "Unlocked";
  el.countdown.textContent = "";
  el.meter.style.width = "100%";
}

function tick() {
  const now = Date.now();
  const remaining = unlockAtMs - now;

  if (remaining <= 0) {
    unlock();
    return;
  }

  el.countdown.textContent = countdown(remaining);

  const span = Math.max(1, unlockAtMs - blockedAtMs);
  el.meter.style.width = `${Math.min(100, ((now - blockedAtMs) / span) * 100)}%`;
}

el.headline.textContent = `${label} is done for now`;
el.quip.textContent = pickQuip();
tick();
setInterval(tick, 1000);

// Polling wakes the event page, so only do it while someone is actually
// looking — a block tab parked in the background must not pin the background
// alive. The visibilitychange refresh keeps the page honest on return.
refresh();
setInterval(() => {
  if (document.visibilityState === "visible") refresh();
}, 5000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refresh();
});
