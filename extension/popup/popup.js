// Popup: every rule's usage and state, live, and its two actions: lock in and
// use a pass.
//
// Sending a message wakes the background if it was unloaded, so opening the
// popup is always enough to get a fresh answer. Between answers the popup
// counts by itself, as the block page does: one reading, a local tick on each
// second of its countdowns, and a fresh reading every few seconds, after an
// action and when a countdown reaches zero (DESIGN.md §19). Asking every second built every
// rule's full status each time, for numbers the popup can work out alone.
// Rows are built once and then mutated in place — rebuilding the list every
// second would restart the CSS transitions and make the meters stutter.

import { BLOCKED, clock, countdown, nextCountdownStep, wallClock } from "../common/format.js";
import { MODES, effectiveMode } from "../common/rules.js";
import { reportsAudible } from "../common/platform.js";

/**
 * The longest the local tick waits. It moves the countdowns and a counting
 * rule's numbers, and a countdown's next second usually comes sooner (tick()).
 */
const TICK_MS = 1000;

/**
 * How often the popup asks the background again. What the tick cannot know
 * comes from here: a bucket ageing out of the rolling window, a rule
 * starting or stopping, and anything done elsewhere.
 */
const REFRESH_MS = 5000;

/** How long the "Confirm" step of an action stays armed. */
const CONFIRM_MS = 5000;

/**
 * How long an action's error stays up, unless another action is confirmed
 * first, and cleared by the local tick, not by a refresh: the next refresh
 * may be a moment away, and clearing there once left the error up for one
 * message round trip. Not until the popup closes either: the rows go on
 * changing under it, and an error about a click long past reads as one about
 * what the rows show now.
 */
const ACTION_ERROR_MS = 10_000;

const listEl = document.getElementById("rules");
const noteEl = document.getElementById("note");
const emptyEl = document.getElementById("empty");
const footEl = document.getElementById("foot");

/** ruleId -> the elements of its row */
const rows = new Map();

const MODE_HINT = Object.fromEntries(MODES.map((mode) => [mode.value, mode.hint]));

/** On Android an `audible` rule counts while focused; say what it does there. */
const AUDIBLE = await reportsAudible();

const CAP_NAME = { rolling: "window", daily: "today", weekly: "this week" };

function createRow(status) {
  const li = document.createElement("li");
  li.className = "rule";

  const row = document.createElement("div");
  row.className = "row";

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = status.label ?? status.id;

  const state = document.createElement("span");
  state.className = "state";

  row.append(label, state);

  const meter = document.createElement("div");
  meter.className = "meter";
  const fill = document.createElement("div");
  fill.className = "meter-fill";
  meter.append(fill);

  const detail = document.createElement("div");
  detail.className = "detail";
  const used = document.createElement("span");
  used.className = "used";
  // The clock icon is only there while blocked, beside "unlocks in".
  const rightBox = document.createElement("span");
  rightBox.className = "right";
  const clockIcon = lineIcon("M12 7v5l3 2", "circle");
  const right = document.createElement("span");
  rightBox.append(clockIcon, right);
  detail.append(used, rightBox);

  // Only shown for rules that carry a daily or weekly cap.
  const calendar = document.createElement("div");
  calendar.className = "detail calendar";
  calendar.hidden = true;

  // Lock in: two-step, inline. The first click arms the button with what
  // will happen; the second sends it. No window.confirm — popups and dialogs
  // do not mix.
  const actions = document.createElement("div");
  actions.className = "actions";
  const lockIn = actionButton("lock-in", "Lock in", null, () =>
    runAction({ type: "lockIn", ruleId: status.id }, "Could not lock in."),
  );
  const usePass = actionButton("use-pass", "Use a pass", "../icons/pass.svg", () =>
    runAction({ type: "usePass", ruleId: status.id }, "Could not use a pass."),
  );
  actions.append(usePass.button, lockIn.button);

  li.append(row, meter, detail, calendar, actions);
  listEl.append(li);

  const parts = { li, state, fill, used, right, clockIcon, calendar, lockIn, usePass };
  rows.set(status.id, parts);
  return parts;
}

function render(status, nowMs) {
  const parts = rows.get(status.id) ?? createRow(status);

  parts.li.classList.toggle("live", status.counting && !status.exhausted);
  parts.li.classList.toggle("spent", status.exhausted);
  parts.li.classList.toggle("pass", Boolean(status.pass?.active) && !status.exhausted);

  // A budget of zero: blocked until the budget is raised, so there is no
  // unlock to count down to and no time to measure (DESIGN.md §22).
  const outright = status.reason === "always";

  // An SVG element has no .hidden property; the attribute is what the CSS reads.
  parts.clockIcon.toggleAttribute("hidden", !status.exhausted || outright);
  if (outright) {
    parts.state.textContent = BLOCKED.always;
    parts.right.textContent = "";
  } else if (status.exhausted) {
    parts.state.textContent = BLOCKED[status.reason] ?? BLOCKED.rolling;
    parts.right.textContent = `unlocks in ${countdown(status.unlockAtMs - nowMs)}`;
  } else if (status.pass?.active) {
    // The rolling meter is suspended; the pass is what is running out.
    parts.state.textContent = `pass, ${countdown(status.pass.endsAtMs - nowMs)} left`;
    const which = status.binding && status.binding !== "pass" ? `${CAP_NAME[status.binding]}: ` : "";
    parts.right.textContent = which ? `${which}${clock(status.remainingMs)} left` : "rolling window paused";
  } else {
    parts.state.textContent = status.counting
      ? "counting"
      : MODE_HINT[effectiveMode(status, { audible: AUDIBLE })] ?? "";
    // The remainder is the smallest across the caps; say which one when it is
    // not the rolling window the meter shows.
    const which = status.binding && status.binding !== "rolling" ? ` (${CAP_NAME[status.binding]})` : "";
    parts.right.textContent = `${clock(status.remainingMs)} left${which}`;
  }

  parts.used.textContent = outright ? "no time allowed" : `${clock(status.usedMs)} / ${clock(status.budgetMs)}`;

  const preview = status.lockIn;
  parts.lockIn.button.hidden = !preview;
  if (preview) {
    parts.lockIn.arm(`Blocks ${status.label} until ${wallClock(preview.unlockAtMs, nowMs)}. Confirm`);
  } else {
    parts.lockIn.disarm();
  }

  const offer = status.passOffer;
  parts.usePass.button.hidden = !offer;
  if (offer) {
    parts.usePass.setLabel(`Use a pass (${offer.left} left)`);
    parts.usePass.arm(`Opens ${status.label} for ${clock(offer.durationMs)}. Confirm`);
  } else {
    parts.usePass.disarm();
  }

  const lines = [];
  if (status.caps?.daily) lines.push(`today ${clock(status.caps.daily.usedMs)} / ${clock(status.caps.daily.budgetMs)}`);
  if (status.caps?.weekly) lines.push(`week ${clock(status.caps.weekly.usedMs)} / ${clock(status.caps.weekly.budgetMs)}`);
  parts.calendar.textContent = lines.join(" · ");
  parts.calendar.hidden = lines.length === 0;

  const ratio = outright ? 1 : status.budgetMs > 0 ? status.usedMs / status.budgetMs : 0;
  parts.fill.style.width = `${Math.min(100, ratio * 100)}%`;
}

/** A stroke icon in the theme's line style: one path, plus a ring if asked. */
function lineIcon(d, ring) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  if (ring) {
    const circle = document.createElementNS(ns, "circle");
    circle.setAttribute("cx", "12");
    circle.setAttribute("cy", "12");
    circle.setAttribute("r", "9");
    svg.append(circle);
  }
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}

/**
 * A button whose first click turns it into a confirmation for a few seconds
 * and whose second click runs `act`. `arm(text)` sets the confirm wording;
 * the caller refreshes it every tick so the "until" stays current. The label
 * lives in its own span so an icon beside it survives the text changes.
 */
function actionButton(kind, initialLabel, iconSrc, act) {
  let label = initialLabel;
  const button = document.createElement("button");
  button.type = "button";
  button.className = `secondary action ${kind}`;
  const text = document.createElement("span");
  text.textContent = label;
  if (iconSrc) {
    const icon = document.createElement("img");
    icon.src = iconSrc;
    icon.alt = "";
    icon.width = 16;
    icon.height = 16;
    button.append(icon);
  }
  button.append(text);

  let armedUntil = 0;
  let confirmText = "";
  let timer = null;

  const disarm = () => {
    armedUntil = 0;
    button.classList.remove("armed");
    text.textContent = label;
  };

  button.addEventListener("click", async () => {
    if (Date.now() < armedUntil) {
      clearTimeout(timer);
      disarm();
      button.disabled = true;
      try {
        await act();
      } finally {
        button.disabled = false;
      }
      return;
    }
    armedUntil = Date.now() + CONFIRM_MS;
    button.classList.add("armed");
    text.textContent = confirmText;
    clearTimeout(timer);
    timer = setTimeout(disarm, CONFIRM_MS);
  });

  return {
    button,
    arm(wording) {
      confirmText = wording;
      if (Date.now() < armedUntil) text.textContent = wording;
    },
    setLabel(wording) {
      label = wording;
      if (Date.now() >= armedUntil) text.textContent = wording;
    },
    disarm,
  };
}

function setNote(text) {
  noteEl.textContent = text ?? "";
  noteEl.hidden = !text;
}

/** The last action's error while it stays up: { text, untilMs }, or null. */
let actionError = null;

/**
 * Send an action to the background and show why it failed, if it did. A
 * rejected message is a failure like a refusal, not an unhandled rejection.
 */
async function runAction(message, fallback) {
  actionError = null;
  let reply = null;
  try {
    reply = await browser.runtime.sendMessage(message);
  } catch {
    // Left to the fallback below.
  }
  if (!reply?.ok) actionError = { text: reply?.error ?? fallback, untilMs: Date.now() + ACTION_ERROR_MS };
  tick();
  await refresh();
}

/** The last answer from the background, and when it came: { statuses, atMs }, or null. */
let reading = null;

/** Why there is no reading to show, until the next one succeeds. */
let readingNote = null;

/** The first instant after the reading at which one of its countdowns reaches zero. */
let nextZeroMs = null;

/** Only the newest request may land: an older answer arriving late would undo it. */
let requests = 0;

async function refresh() {
  const request = ++requests;
  let statuses;
  try {
    statuses = await browser.runtime.sendMessage({ type: "status" });
  } catch {
    statuses = undefined;
  }
  if (request !== requests) return;

  if (!Array.isArray(statuses)) {
    // The tick goes on from the last reading meanwhile, as on the block page.
    readingNote = "Background script not responding.";
  } else {
    readingNote = null;
    const atMs = Date.now();
    reading = { statuses, atMs };
    nextZeroMs = firstZero(statuses, atMs);
    // A rule deleted since the last reading takes its row with it, the last
    // one too, which leaves the invitation to add one.
    const ids = new Set(statuses.map((s) => s.id));
    for (const [id, parts] of rows) {
      if (ids.has(id)) continue;
      parts.li.remove();
      rows.delete(id);
    }
  }
  tick();
}

/**
 * Where one rule's reading is `elapsedMs` later, as far as time alone moves
 * it. The countdowns need nothing here, since they count to fixed instants;
 * this is what a counting rule spends meanwhile: its rolling window's used
 * time, the calendar caps' unless a pass leaves them out, and what is left.
 * Kept within the budget, as the background's reading is: the zero brings a
 * fresh one.
 */
function projected(status, elapsedMs) {
  if (!status.counting || status.exhausted || elapsedMs <= 0) return status;
  const onPass = Boolean(status.pass?.active);
  const spend = (cap) => cap && { ...cap, usedMs: Math.min(cap.budgetMs, cap.usedMs + elapsedMs) };
  const capsCount = !onPass || status.passCountsTowardCaps;
  return {
    ...status,
    // A pass suspends the rolling cap, but its time still goes into the window (DESIGN.md §17).
    usedMs: onPass ? status.usedMs + elapsedMs : Math.min(status.budgetMs, status.usedMs + elapsedMs),
    remainingMs: Math.max(0, status.remainingMs - elapsedMs),
    caps: status.caps && {
      ...status.caps,
      daily: capsCount ? spend(status.caps.daily) : status.caps.daily,
      weekly: capsCount ? spend(status.caps.weekly) : status.caps.weekly,
    },
  };
}

/**
 * The instants a reading taken at `atMs` counts down to: an unlock, a pass
 * ending, a counting rule running out. At each, the reading stops being true
 * on its own, and the popup should ask again.
 */
function zeros(statuses, atMs) {
  return statuses.flatMap((s) => [
    s.exhausted ? s.unlockAtMs : null,
    s.pass?.active ? s.pass.endsAtMs : null,
    s.counting && !s.exhausted ? atMs + s.remainingMs : null,
  ]).filter((at) => at !== null);
}

/** The earliest of them after `atMs`, or null. */
function firstZero(statuses, atMs) {
  const ahead = zeros(statuses, atMs).filter((at) => at > atMs);
  return ahead.length ? Math.min(...ahead) : null;
}

/** The next tick, aimed at the instant something on show next changes. */
let tickTimer = null;

/**
 * The last reading, moved on to now; then a wait for the next whole second
 * before one of its zeros, and never more than TICK_MS (DESIGN.md §19, "On the
 * second"). So an unlock or a pass counts down in step with the block page,
 * and a zero is acted on at the instant it comes. Aimed afresh on every call,
 * a refresh's or an action's included, so a late timeout puts nothing off.
 */
function tick() {
  clearTimeout(tickTimer);
  const now = Date.now();
  if (reading) {
    for (const status of reading.statuses) render(projected(status, now - reading.atMs), now);
  }
  // No rules: the invitation takes the place of the rows and of Edit rules.
  const none = reading?.statuses.length === 0;
  emptyEl.hidden = !none;
  footEl.hidden = none;

  // An action's error goes once its time is up, whatever the refreshes do.
  if (actionError && now >= actionError.untilMs) actionError = null;
  setNote(readingNote ?? actionError?.text ?? null);

  if (nextZeroMs !== null && now >= nextZeroMs) {
    nextZeroMs = null;
    refresh();
  }

  const deadlines = reading ? zeros(reading.statuses, reading.atMs) : [];
  tickTimer = setTimeout(tick, nextCountdownStep(now, deadlines, TICK_MS));
}

function openRules() {
  browser.runtime.openOptionsPage();
  window.close();
}

/**
 * The options page, on a new rule's form: `#add-<n>` asks it for one, once
 * per <n> (options.js). An options tab already open is reused, as
 * openOptionsPage() would, so edits there are not split across two tabs;
 * changing only its hash does not reload it. Android has no windows API, and
 * only one window.
 */
async function addRule() {
  const page = browser.runtime.getURL("options/options.html");
  const url = `${page}#add-${Date.now()}`;
  const open = (await browser.tabs.query({})).find((tab) => tab.url?.startsWith(page));
  if (open) {
    await browser.tabs.update(open.id, { url, active: true });
    await browser.windows?.update(open.windowId, { focused: true });
  } else {
    await browser.tabs.create({ url });
  }
  window.close();
}

document.getElementById("edit").addEventListener("click", openRules);
document.getElementById("settings").addEventListener("click", openRules);
document.getElementById("add").addEventListener("click", addRule);

// Every refresh ends in a tick, answered or not, and each tick sets the next.
refresh();
setInterval(refresh, REFRESH_MS);
