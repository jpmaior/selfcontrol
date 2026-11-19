// The block page.
//
// The countdown ticks locally every second, but the truth comes from the
// background: the rolling window can hand budget back early, so the page
// re-reads its status periodically rather than trusting the timestamp it was
// opened with.

import { BLOCKED, clock, countdown, strong } from "../common/format.js";
import { returnUrlFrom } from "../common/rules.js";
import { blockPageIndex, describedReason, GO_BACK_STEPS, showsGoBack } from "../common/blockpage.js";

const params = new URLSearchParams(location.search);
const ruleId = params.get("rule");
const label = params.get("label") || ruleId || "this site";

/** The page this one replaced, if it is safe to link back to. */
const returnUrl = returnUrlFrom(params);

const el = {
  icon: document.getElementById("icon"),
  headline: document.getElementById("headline"),
  quip: document.getElementById("quip"),
  meter: document.getElementById("meter"),
  countdown: document.getElementById("countdown"),
  countdownText: document.getElementById("countdown-text"),
  unlocked: document.getElementById("unlocked"),
  detail: document.getElementById("detail"),
  passes: document.getElementById("passes"),
  passesText: document.getElementById("passes-text"),
  return: document.getElementById("return"),
  goBack: document.getElementById("go-back"),
};

/** "youtube.com/watch?v=abc…": hostname and a short path, for the muted line. */
function shortUrl(href) {
  const u = new URL(href);
  const path = `${u.pathname}${u.search}`.replace(/\/$/, "");
  const trimmed = path.length > 40 ? `${path.slice(0, 39)}…` : path;
  return `${u.hostname.replace(/^www\./, "")}${trimmed}`;
}

/**
 * While blocked: where you were, as text. Once unlocked: a real link. No
 * auto-redirect on purpose; going back is a choice, and the navigation runs
 * through the same guard as any other, so a rule that re-blocks re-blocks.
 */
function renderReturn(unlocked) {
  if (!returnUrl) {
    el.return.hidden = true;
    return;
  }
  el.return.hidden = false;
  if (unlocked) {
    const a = document.createElement("a");
    a.className = "button primary";
    a.href = returnUrl;
    a.append(`Back to ${shortUrl(returnUrl)}`, arrowIcon());
    el.return.replaceChildren(a);
  } else {
    const where = document.createElement("span");
    where.className = "where";
    where.textContent = shortUrl(returnUrl);
    el.return.replaceChildren("You were on ", where);
  }
}

/**
 * Go back: past the blocked page, to the one the user came from (DESIGN.md
 * §19). Only for a site blocked outright, which never unlocks, so its block
 * page would otherwise be a dead end. A step through history rather than a
 * link, so the page comes back as it was left, scroll position included, and
 * it needs nothing from the background. It is no way around a block: where it
 * lands goes through the navigation guard like any other page.
 *
 * Where this page sits in the tab's history is recorded in its own entry on
 * the first load, while it is still the last entry; afterwards the length
 * would also count anything the user went forward to. Recorded whatever the
 * reason, since a refresh can turn a spent budget into an outright block.
 */
const blockIndex = blockPageIndex(history.state, history.length);
history.replaceState({ blockIndex }, "");

function setUpGoBack() {
  el.goBack.prepend(arrowIcon("back"));
  el.goBack.addEventListener("click", () => history.go(-GO_BACK_STEPS));
}

/** Shown or not, again whenever the reason changes or the page unlocks. */
function renderGoBack() {
  el.goBack.hidden = !showsGoBack({
    reason,
    unlocked: document.body.classList.contains("unlocked"),
    index: blockIndex,
  });
}

function arrowIcon(direction = "forward") {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", direction === "back" ? "M19 12H5M11 6l-6 6 6 6" : "M5 12h14M13 6l6 6-6 6");
  svg.append(path);
  return svg;
}

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
let reason = params.get("reason") || "rolling";

/** The headline names the period that ran out, so "until midnight" makes sense. */
const headline = () => `${label} is ${BLOCKED[reason] ?? BLOCKED.rolling}`;

/**
 * A rule with a budget of zero blocks outright (DESIGN.md §22): there is no
 * instant to count down to, so the meter and the countdown go, and only
 * raising the budget, seen on a refresh, unlocks the page.
 */
const outright = () => reason === "always";

function setHeadline() {
  el.headline.textContent = headline();
  document.body.classList.toggle("outright", outright());
  renderGoBack();
}

/** "YouTube: 4:57 of 5:00 used today.", with the two figures in bold. */
function describeCap(mine) {
  const windowMin = Math.round(mine.windowMs / 60000);
  const cap = mine.caps?.[reason];
  const line = (usedMs, budgetMs, period) => [
    `${label}: `,
    strong(clock(usedMs)),
    " of ",
    strong(clock(budgetMs)),
    ` used ${period}.`,
  ];
  if (outright()) {
    return [`${label} has `, strong("no time"), " allowed, and stays blocked until its budget is raised."];
  }
  switch (cap && reason) {
    case "daily":
      return line(cap.usedMs, cap.budgetMs, "today");
    case "weekly":
      return line(cap.usedMs, cap.budgetMs, "this week");
    default:
      return line(mine.usedMs, mine.budgetMs, `in the last ${windowMin} minutes`);
  }
}

async function refresh() {
  try {
    const statuses = await browser.runtime.sendMessage({ type: "status" });
    // Only a real answer says anything about the rule; anything else leaves
    // the local tick in charge, as a failed message does.
    if (!Array.isArray(statuses)) return;
    const mine = statuses.find((s) => s.id === ruleId);
    if (!mine) {
      // Deleted: nothing blocks the site any more, so this is an unlock like
      // any other, minus a usage line for a rule that no longer exists. Never
      // a transient: the background answers only once its rules have loaded,
      // and swaps the set whole (DESIGN.md §19).
      el.detail.replaceChildren();
      unlock();
      return;
    }

    unlockAtMs = mine.unlockAtMs;
    const next = describedReason(reason, mine);
    if (next !== reason) {
      reason = next;
      // A different constraint took over (say the daily cap filled while the
      // rolling one was blocking): retitle rather than count down to the
      // wrong instant. A rule that is open again keeps the unlocked headline,
      // which unlock() below sets; only the usage line follows the new limit.
      if (mine.exhausted) setHeadline();
    }
    el.detail.replaceChildren(...describeCap(mine));

    // The pass control lives in the popup on purpose: this page never gets
    // an unlock button. It only says that one exists.
    const left = mine.passOffer?.left ?? 0;
    el.passes.hidden = !(mine.exhausted && mine.reason === "rolling" && left > 0);
    el.passesText.textContent =
      left === 1
        ? "You have 1 pass left this week, in the toolbar popup."
        : `You have ${left} passes left this week, in the toolbar popup.`;

    if (mine.exhausted) block();
    else unlock();
  } catch {
    // Background asleep or mid-restart; the local tick carries us until the
    // next refresh succeeds.
  }
}

function unlock() {
  // The tick keeps calling this once the time is up; rebuilding the link
  // every second would drop keyboard focus from it.
  if (document.body.classList.contains("unlocked")) return;
  document.body.classList.remove("outright");
  document.body.classList.add("unlocked");
  el.icon.src = "../icons/available.svg";
  el.headline.textContent = `${label} is available again`;
  el.quip.textContent = "Spend it deliberately this time.";
  el.countdownText.hidden = true;
  el.countdown.hidden = true;
  el.unlocked.hidden = false;
  el.meter.style.width = "100%";
  el.passes.hidden = true;
  renderGoBack();
  renderReturn(true);
}

/**
 * unlock() undone: the rule is spent again while the page is open, because a
 * pass ended, Lock in was pressed or the budget was lowered. Without it the
 * page went on saying the site was available when it was not (DESIGN.md §19).
 * The countdown starts over from now, to the instant refresh() just set.
 */
function block() {
  if (!document.body.classList.contains("unlocked")) return;
  document.body.classList.remove("unlocked");
  blockedAtMs = Date.now();
  el.icon.src = "../icons/blocked.svg";
  el.quip.textContent = pickQuip();
  el.countdownText.hidden = false;
  el.countdown.hidden = false;
  el.unlocked.hidden = true;
  setHeadline();
  renderReturn(false);
  tick();
}

function tick() {
  if (outright()) return; // nothing to count down to
  const now = Date.now();
  const remaining = unlockAtMs - now;

  if (remaining <= 0) {
    // The usage line is refresh()'s, and still says what was used before the
    // time came back. Ask now rather than at the next refresh, up to 5 s on.
    const fresh = !document.body.classList.contains("unlocked");
    unlock();
    if (fresh && document.visibilityState === "visible") refresh();
    return;
  }

  el.countdown.textContent = countdown(remaining);

  const span = Math.max(1, unlockAtMs - blockedAtMs);
  el.meter.style.width = `${Math.min(100, ((now - blockedAtMs) / span) * 100)}%`;
}

setUpGoBack();
setHeadline();
el.quip.textContent = pickQuip();
renderReturn(false);
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
