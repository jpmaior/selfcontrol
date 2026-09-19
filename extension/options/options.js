// Options page: add, edit and delete rules.
//
// Edits live in a local draft array and are only written on Save, so a
// half-typed domain never reaches the background. Saving writes the `settings`
// key; the background is watching it and re-arms itself without a reload.

import {
  MODES,
  ON_EXCEED,
  blankRule,
  makeRuleId,
  parseDomain,
  strip,
  validateRule,
} from "../common/rules.js";
import { loadRules, saveRules } from "../common/settings.js";
import { normalizeUsage, usedByDay } from "../background/accountant.js";
import { addDays, dayKey, startOfDay } from "../common/calendar.js";
import { clock } from "../common/format.js";

/** Days drawn in the history strip; the ledger keeps more (HISTORY_DAYS). */
const HISTORY_SHOWN = 30;

const listEl = document.getElementById("rules");
const templateEl = document.getElementById("rule-template");
const statusEl = document.getElementById("status");

/** The working copy. Never the same objects as what is in storage. */
let drafts = [];

/**
 * ruleId -> per-day usage, read straight from `usage:*` at page load. The
 * options page never messages the background (DESIGN.md §10); the ledger is
 * plain storage, and this view is read-only.
 */
let history = new Map();

/**
 * Ids that existed when the page loaded (or was last saved). A deleted rule's
 * id must not be re-minted in the same save: the background would see it
 * survive and the new rule would inherit the dead rule's usage history.
 */
let reservedIds = [];

// --- draft <-> form ------------------------------------------------------

const toMin = (sec) => Math.round(sec / 60);
const toSec = (min) => Math.max(0, Math.round(Number(min) || 0) * 60);

/** For the optional caps: blank is "none" (null), anything else is minutes. */
const toMinOrBlank = (sec) => (sec === null || sec === undefined ? "" : toMin(sec));
const toSecOrNull = (min) => (String(min).trim() === "" ? null : Math.round(Number(min)) * 60);

function fillOptions(select, items, selected) {
  for (const item of items) {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    option.selected = item.value === selected;
    select.append(option);
  }
}

function buildCard(draft) {
  const card = templateEl.content.firstElementChild.cloneNode(true);
  const field = (name) => card.querySelector(`[data-field="${name}"]`);

  field("label").value = draft.label;
  field("match").value = draft.match.join(", ");
  field("budgetMin").value = toMin(draft.budgetSec);
  field("windowMin").value = toMin(draft.windowSec);
  field("unlockMin").value = toMin(draft.minUnlockCreditSec);
  field("dailyMin").value = toMinOrBlank(draft.dailyBudgetSec);
  field("weeklyMin").value = toMinOrBlank(draft.weeklyBudgetSec);

  fillOptions(field("mode"), MODES, draft.mode);
  fillOptions(field("onExceed"), ON_EXCEED, draft.onExceed);

  // Read every field back into the draft on any change, so validation and Save
  // always see exactly what is on screen.
  card.addEventListener("input", () => {
    draft.label = field("label").value;
    draft.match = field("match")
      .value.split(/[,\s]+/)
      .map(parseDomain)
      .filter(Boolean);
    draft.mode = field("mode").value;
    draft.onExceed = field("onExceed").value;
    draft.budgetSec = toSec(field("budgetMin").value);
    draft.windowSec = toSec(field("windowMin").value);
    draft.minUnlockCreditSec = toSec(field("unlockMin").value);
    draft.dailyBudgetSec = toSecOrNull(field("dailyMin").value);
    draft.weeklyBudgetSec = toSecOrNull(field("weeklyMin").value);
    clearStatus();
  });

  // Normalise the domain field once the user leaves it, so they can see what
  // was actually understood — "https://www.YouTube.com/feed" becoming
  // "youtube.com" is reassuring rather than mysterious.
  field("match").addEventListener("change", (event) => {
    event.target.value = draft.match.join(", ");
  });

  renderHistory(card, draft);

  card.querySelector('[data-action="delete"]').addEventListener("click", () => {
    drafts = drafts.filter((d) => d !== draft);
    render();
    setStatus(`Removed "${draft.label || draft.id}". Save to confirm.`);
  });

  return card;
}

function render() {
  listEl.replaceChildren(...drafts.map(buildCard));
}

// --- history -------------------------------------------------------------

const sum = (days, field) => days.reduce((total, day) => total + day[field], 0);

function totalsText(days) {
  const week = days.slice(-7);
  const all = (list) => sum(list, "used") + sum(list, "pass");
  return `7 days ${clock(all(week))} · ${HISTORY_SHOWN} days ${clock(all(days))}`;
}

/**
 * A 30-day strip of stacked columns, used time under pass time, drawn in
 * plain CSS. Exact values ride in each column's title, and the two series
 * carry a legend so identity never rests on colour alone.
 */
function renderHistory(card, draft) {
  const details = card.querySelector('[data-role="history"]');
  const body = card.querySelector('[data-role="history-body"]');
  const totalsEl = card.querySelector('[data-role="history-totals"]');
  const byDay = draft.id ? history.get(draft.id) : null;

  const today = startOfDay(Date.now());
  const days = [];
  for (let i = HISTORY_SHOWN - 1; i >= 0; i--) {
    const at = addDays(today, -i);
    const key = dayKey(at);
    days.push({ key, at, ...(byDay?.[key] ?? { used: 0, pass: 0 }) });
  }

  const peak = Math.max(...days.map((day) => day.used + day.pass));
  if (!(peak > 0)) {
    totalsEl.textContent = "";
    body.replaceChildren(note("Nothing yet."));
    details.classList.add("empty");
    return;
  }

  totalsEl.textContent = totalsText(days);

  const strip = document.createElement("div");
  strip.className = "bars";
  strip.setAttribute("role", "img");
  strip.setAttribute("aria-label", `Daily usage over the last ${HISTORY_SHOWN} days`);

  for (const day of days) {
    const column = document.createElement("div");
    column.className = "bar";
    const label = new Date(day.at).toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
    column.title =
      day.pass > 0
        ? `${label}: ${clock(day.used)} used, ${clock(day.pass)} on a pass`
        : `${label}: ${clock(day.used)}`;

    // Only non-empty segments are drawn, so the gap between them never shows
    // on its own, and the top-most one carries the rounded data-end.
    const segments = [
      ["pass", day.pass],
      ["used", day.used],
    ]
      .filter(([, ms]) => ms > 0)
      .map(([kind, ms]) => {
        const seg = document.createElement("div");
        seg.className = `seg ${kind}`;
        seg.style.height = `${(ms / peak) * 100}%`;
        return seg;
      });
    segments[0]?.classList.add("top");
    column.append(...segments);
    strip.append(column);
  }

  const legend = document.createElement("div");
  legend.className = "legend";
  legend.append(swatch("used", "Used"));
  if (sum(days, "pass") > 0) legend.append(swatch("pass", "On a pass"));

  body.replaceChildren(strip, legend);
}

function swatch(kind, text) {
  const item = document.createElement("span");
  item.className = `legend-item ${kind}`;
  item.textContent = text;
  return item;
}

function note(text) {
  const p = document.createElement("p");
  p.className = "history-note";
  p.textContent = text;
  return p;
}

async function loadHistory(rules) {
  const keys = rules.map((rule) => `usage:${rule.id}`);
  const stored = await browser.storage.local.get(keys);
  history = new Map(
    rules.map((rule) => [rule.id, usedByDay(normalizeUsage(stored[`usage:${rule.id}`]))]),
  );
}

// --- validation and saving ----------------------------------------------

function showErrors(perDraft) {
  for (const [index, card] of [...listEl.children].entries()) {
    const errors = perDraft[index] ?? [];
    const box = card.querySelector('[data-role="errors"]');
    box.replaceChildren(
      ...errors.map((text) => {
        const li = document.createElement("li");
        li.textContent = text;
        return li;
      }),
    );
    box.hidden = errors.length === 0;
    card.classList.toggle("invalid", errors.length > 0);
  }
}

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`.trim();
}

function clearStatus() {
  if (statusEl.textContent) setStatus("");
}

async function save() {
  const perDraft = drafts.map((draft) => validateRule(draft, drafts));
  showErrors(perDraft);

  const bad = perDraft.filter((errors) => errors.length > 0).length;
  if (bad > 0) {
    setStatus(`${bad} rule${bad === 1 ? "" : "s"} need${bad === 1 ? "s" : ""} fixing.`, "bad");
    return;
  }

  // Mint ids only now, and only for rules that have none. An id is the key a
  // rule's usage data hangs off, so regenerating one for an existing rule would
  // silently orphan its history — which is why this keys off "has no id" rather
  // than trying to recognise a generated one.
  const taken = [...new Set([...reservedIds, ...drafts.filter((d) => d.id).map((d) => d.id)])];
  for (const draft of drafts) {
    if (draft.id) continue;
    draft.id = makeRuleId(draft.label, taken);
    taken.push(draft.id);
  }

  await saveRules(drafts.map(strip));
  // The background has now forgotten any deleted rule's usage, so its id is
  // genuinely free again from here on.
  reservedIds = drafts.map((d) => d.id);
  setStatus("Saved — applied immediately.", "ok");
}

// --- wiring --------------------------------------------------------------

document.getElementById("add").addEventListener("click", () => {
  drafts.push(blankRule());
  render();
  listEl.lastElementChild?.querySelector('[data-field="label"]')?.focus();
});

document.getElementById("save").addEventListener("click", save);

// Read at runtime from the manifest, so it can never drift from what is
// actually installed.
document.getElementById("version").textContent =
  `SelfControl v${browser.runtime.getManifest().version}`;

drafts = (await loadRules()).map((rule) => ({ ...rule, match: [...rule.match] }));
reservedIds = drafts.map((rule) => rule.id);
await loadHistory(drafts);
render();
