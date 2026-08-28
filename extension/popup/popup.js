// Popup: a live read-only view of every rule.
//
// Sending a message wakes the background if it was unloaded, so opening the
// popup is always enough to get a fresh answer. Rows are built once and then
// mutated in place — rebuilding the list every second would restart the CSS
// transitions and make the meters stutter.

import { clock, countdown } from "../common/format.js";

const REFRESH_MS = 1000;

const listEl = document.getElementById("rules");
const noteEl = document.getElementById("note");

/** ruleId -> the elements of its row */
const rows = new Map();

const MODE_HINT = {
  audible: "counts while playing",
  focus: "counts while focused",
};

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
  const right = document.createElement("span");
  detail.append(used, right);

  li.append(row, meter, detail);
  listEl.append(li);

  const parts = { li, state, fill, used, right };
  rows.set(status.id, parts);
  return parts;
}

function render(status, nowMs) {
  const parts = rows.get(status.id) ?? createRow(status);

  parts.li.classList.toggle("live", status.counting && !status.exhausted);
  parts.li.classList.toggle("spent", status.exhausted);

  if (status.exhausted) {
    parts.state.textContent = "blocked";
    parts.right.textContent = `unlocks in ${countdown(status.unlockAtMs - nowMs)}`;
  } else {
    parts.state.textContent = status.counting ? "counting" : MODE_HINT[status.mode] ?? "";
    parts.right.textContent = `${clock(status.remainingMs)} left`;
  }

  parts.used.textContent = `${clock(status.usedMs)} / ${clock(status.budgetMs)}`;

  const ratio = status.budgetMs > 0 ? status.usedMs / status.budgetMs : 0;
  parts.fill.style.width = `${Math.min(100, ratio * 100)}%`;
}

function setNote(text) {
  noteEl.textContent = text ?? "";
  noteEl.hidden = !text;
}

async function refresh() {
  let statuses;
  try {
    statuses = await browser.runtime.sendMessage({ type: "status" });
  } catch {
    setNote("Background script not responding.");
    return;
  }

  if (!Array.isArray(statuses) || statuses.length === 0) {
    setNote("No rules configured.");
    return;
  }

  const now = Date.now();
  for (const status of statuses) render(status, now);

  const windowMin = Math.round((statuses[0].windowMs ?? 0) / 60000);
  setNote(windowMin ? `Limits apply over a rolling ${windowMin} minutes.` : null);
}

refresh();
setInterval(refresh, REFRESH_MS);
