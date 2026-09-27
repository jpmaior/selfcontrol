// Options page: add, edit and delete rules.
//
// Master/detail: the rule list, and one rule's form at a time. Edits live in a
// local draft array and are only written on Save, so a half-typed domain never
// reaches the background. Saving writes the `settings` key; the background is
// watching it and re-arms itself without a reload.

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
import { importSummary, parseImport, serializeRules } from "../common/transfer.js";

/** Days drawn in the history strip; the ledger keeps more (HISTORY_DAYS). */
const HISTORY_SHOWN = 30;

const listEl = document.getElementById("rule-list");
const countEl = document.getElementById("rule-count");
const detailEl = document.getElementById("detail");
const itemTemplateEl = document.getElementById("rule-item-template");
const templateEl = document.getElementById("rule-template");
const emptyTemplateEl = document.getElementById("empty-template");
const statusEl = document.getElementById("status");
const revertEl = document.getElementById("revert");

/** Stacked layout: picking a rule has to scroll its form into view. */
const stacked = window.matchMedia("(max-width: 59.99rem)");

/** The working copy. Never the same objects as what is in storage. */
let drafts = [];

/** The draft whose form is on screen, or null when there are no rules. */
let selected = null;

/**
 * The rules as last loaded or saved, and each one's canonical JSON by id: what
 * "unsaved changes" is measured against.
 */
let saved = [];
let savedJson = new Map();

/** draft -> its problems at the last validation. */
let errors = new Map();

/**
 * After a refused save, every edit re-validates, so the list shows a rule
 * turning good as it is fixed. Before one, a rule being typed is not nagged.
 */
let validating = false;

/** An action's outcome, shown in the save bar until the next edit. */
let message = null;

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

const cloneRule = (rule) => structuredClone(rule);
const nameOf = (rule) => String(rule.label ?? "").trim();
const canonical = (rule) => JSON.stringify(strip(rule));

function markSaved(rules) {
  saved = rules.map(cloneRule);
  savedJson = new Map(saved.map((rule) => [rule.id, canonical(rule)]));
}

/** A rule with no id has never been saved; strip() ignores form-only state. */
const isEdited = (draft) => !draft.id || savedJson.get(draft.id) !== canonical(draft);

const removedRules = () => saved.filter((rule) => !drafts.some((d) => d.id === rule.id));

function fillOptions(select, items, selectedValue) {
  for (const item of items) {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    option.selected = item.value === selectedValue;
    select.append(option);
  }
}

function buildForm(draft) {
  const root = templateEl.content.firstElementChild.cloneNode(true);
  const field = (name) => root.querySelector(`[data-field="${name}"]`);

  field("label").value = draft.label;
  field("match").value = draft.match.join(", ");
  field("budgetMin").value = toMin(draft.budgetSec);
  field("windowMin").value = toMin(draft.windowSec);
  field("unlockMin").value = toMin(draft.minUnlockCreditSec);
  field("dailyMin").value = toMinOrBlank(draft.dailyBudgetSec);
  field("weeklyMin").value = toMinOrBlank(draft.weeklyBudgetSec);
  field("passesPerWeek").value = draft.passes.perWeek;
  field("passMin").value = toMin(draft.passes.durationSec);
  field("passCounts").checked = draft.passes.countsTowardCaps;

  fillOptions(field("mode"), MODES, draft.mode);
  fillOptions(field("onExceed"), ON_EXCEED, draft.onExceed);

  // Read every field back into the draft on any change, so validation and Save
  // always see exactly what is on screen.
  root.addEventListener("input", () => {
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
    draft.passes = {
      perWeek: Math.max(0, Math.round(Number(field("passesPerWeek").value) || 0)),
      durationSec: toSec(field("passMin").value),
      countsTowardCaps: field("passCounts").checked,
    };
    if (validating) validateAll();
    message = null;
    renderList();
    showErrors(root, draft);
    updateSaveBar();
  });

  // Normalise the domain field once the user leaves it, so they can see what
  // was actually understood — "https://www.YouTube.com/feed" becoming
  // "youtube.com" is reassuring rather than mysterious.
  field("match").addEventListener("change", (event) => {
    event.target.value = draft.match.join(", ");
  });

  root.querySelector('[data-action="delete"]').addEventListener("click", () => remove(draft));

  showErrors(root, draft);
  renderHistory(root, draft);
  return root;
}

// --- the list ------------------------------------------------------------

/** "5m / 1h window": the rolling cap, the one every rule has. */
const capSummary = (draft) =>
  `${shortDuration(draft.budgetSec * 1000)} / ${shortDuration(draft.windowSec * 1000)} window`;

function itemState(draft) {
  if (errors.get(draft)?.length > 0) return ["invalid", "Needs fixing"];
  if (!draft.id) return ["new", "New"];
  if (isEdited(draft)) return ["edited", "Edited"];
  return ["saved", "Saved"];
}

function buildListItem(draft) {
  const item = itemTemplateEl.content.firstElementChild.cloneNode(true);
  const part = (role) => item.querySelector(`[data-role="${role}"]`);
  const button = item.querySelector("button");

  const name = nameOf(draft);
  part("name").textContent = name || "Untitled rule";
  part("name").classList.toggle("untitled", !name);
  part("domains").textContent = draft.match.join(", ") || "no domains yet";
  part("summary").textContent = capSummary(draft);
  const [kind, text] = itemState(draft);
  part("state").textContent = text;
  part("state").classList.add(kind);

  button.setAttribute("aria-current", String(draft === selected));
  button.addEventListener("click", () => select(draft));
  return item;
}

function renderList() {
  // Rebuilding would drop keyboard focus on the item just activated.
  const focused = [...listEl.querySelectorAll("button")].indexOf(document.activeElement);
  countEl.textContent = drafts.length;
  listEl.replaceChildren(...drafts.map(buildListItem));
  if (focused !== -1) listEl.querySelectorAll("button")[focused]?.focus();
}

function renderDetail() {
  detailEl.replaceChildren(
    selected ? buildForm(selected) : emptyTemplateEl.content.firstElementChild.cloneNode(true),
  );
}

function render() {
  renderList();
  renderDetail();
  updateSaveBar();
}

function select(draft) {
  if (draft === selected) return;
  selected = draft;
  render();
  if (stacked.matches) detailEl.scrollIntoView({ block: "start" });
}

function remove(draft) {
  const index = drafts.indexOf(draft);
  drafts = drafts.filter((d) => d !== draft);
  errors.delete(draft);
  if (validating) validateAll();
  selected = drafts[Math.min(index, drafts.length - 1)] ?? null;
  render();
  // A rule that was never saved is simply gone; nothing is left to confirm.
  const next = draft.id ? " Save to confirm." : "";
  setStatus(`Removed "${nameOf(draft) || "Untitled rule"}".${next}`);
}

// --- history -------------------------------------------------------------

const sum = (days, field) => days.reduce((total, day) => total + day[field], 0);

function renderTotals(el, days) {
  const all = (list) => sum(list, "used") + sum(list, "pass");
  const total = (label, list) => {
    const span = document.createElement("span");
    const value = document.createElement("strong");
    value.textContent = clock(all(list));
    span.append(`${label}: `, value);
    return span;
  };
  const sep = document.createElement("span");
  sep.className = "sep";
  sep.textContent = "·";
  el.replaceChildren(total("7 days", days.slice(-7)), sep, total(`${HISTORY_SHOWN} days`, days));
}

/** Axis steps, in minutes: the smallest one at or above the busiest day. */
const AXIS_STEPS_MIN = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720, 1440];

function axisMaxMs(peakMs) {
  const peakMin = Math.ceil(peakMs / 60_000);
  const step = AXIS_STEPS_MIN.find((m) => m >= peakMin) ?? Math.ceil(peakMin / 60) * 60;
  return step * 60_000;
}

/** "0", "30m", "1h", "1h30": short, for an axis or a chip. Values are whole minutes. */
function shortDuration(ms) {
  const min = Math.round(ms / 60_000);
  if (min === 0) return "0";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}`;
}

function dayLabel(day, index) {
  if (index === HISTORY_SHOWN - 1) return "Today";
  if (index === HISTORY_SHOWN - 2) return "Yesterday";
  return new Date(day.at).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function dayText(day, index) {
  const parts = [`${dayLabel(day, index)}: ${clock(day.used)} used`];
  if (day.pass > 0) parts.push(`${clock(day.pass)} on a pass`);
  if (day.used === 0 && day.pass === 0) return `${dayLabel(day, index)}: nothing`;
  return parts.join(", ");
}

/**
 * A 30-day chart of stacked columns, used time under pass time, drawn in
 * plain CSS: a time axis with hairline gridlines on the left, dates along the
 * bottom, and a readout in the card's heading that names the day under the
 * pointer (or the focused column) with its exact time. The two series carry a
 * legend so identity never rests on colour alone.
 */
function renderHistory(root, draft) {
  const body = root.querySelector('[data-role="history-body"]');
  const totalsEl = root.querySelector('[data-role="history-totals"]');
  const readout = root.querySelector('[data-role="readout"]');
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
    body.replaceChildren(note(draft.id ? "Nothing yet." : "History starts once this rule is saved."));
    return;
  }

  renderTotals(totalsEl, days);
  const maxMs = axisMaxMs(peak);

  // The readout shows today until a column is hovered or focused.
  const showDay = (index) => {
    readout.textContent = dayText(days[index], index);
  };
  showDay(days.length - 1);

  const plot = document.createElement("div");
  plot.className = "plot";

  const yAxis = document.createElement("div");
  yAxis.className = "y-axis";
  const area = document.createElement("div");
  area.className = "area";
  for (const fraction of [1, 0.5, 0]) {
    const label = document.createElement("span");
    label.style.bottom = `${fraction * 100}%`;
    label.textContent = shortDuration(maxMs * fraction);
    yAxis.append(label);
    if (fraction > 0) {
      const line = document.createElement("div");
      line.className = "gridline";
      line.style.bottom = `${fraction * 100}%`;
      area.append(line);
    }
  }

  const strip = document.createElement("div");
  strip.className = "bars";
  strip.setAttribute("role", "group");
  strip.setAttribute("aria-label", `Daily usage over the last ${HISTORY_SHOWN} days`);

  const xAxis = document.createElement("div");
  xAxis.className = "x-axis";

  days.forEach((day, index) => {
    const column = document.createElement("div");
    column.className = "bar";
    column.tabIndex = 0;
    column.setAttribute("aria-label", dayText(day, index));
    column.title = dayText(day, index);
    column.addEventListener("mouseenter", () => showDay(index));
    column.addEventListener("focus", () => showDay(index));
    column.addEventListener("mouseleave", () => showDay(days.length - 1));
    column.addEventListener("blur", () => showDay(days.length - 1));

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
        seg.style.height = `${(ms / maxMs) * 100}%`;
        return seg;
      });
    segments[0]?.classList.add("top");
    column.append(...segments);
    strip.append(column);

    // A date under every seventh column, counted back from today so "Today"
    // is always labelled.
    const tick = document.createElement("span");
    tick.className = "tick";
    if ((days.length - 1 - index) % 7 === 0) {
      tick.textContent =
        index === days.length - 1
          ? "Today"
          : new Date(day.at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
    }
    xAxis.append(tick);
  });

  area.append(strip);
  plot.append(yAxis, area, document.createElement("div"), xAxis);

  const legend = document.createElement("div");
  legend.className = "legend";
  legend.append(swatch("used", "Used"));
  if (sum(days, "pass") > 0) legend.append(swatch("pass", "On a pass"));

  body.replaceChildren(plot, legend);
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

function validateAll() {
  errors = new Map(drafts.map((draft) => [draft, validateRule(draft, drafts)]));
}

function showErrors(root, draft) {
  const list = errors.get(draft) ?? [];
  const box = root.querySelector('[data-role="errors"]');
  box.replaceChildren(
    ...list.map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      return li;
    }),
  );
  box.hidden = list.length === 0;
  box.parentElement.classList.toggle("invalid", list.length > 0);
}

/** "Unsaved changes for A, B" when nothing more pressing has been said. */
function updateSaveBar() {
  const names = [
    ...drafts.filter(isEdited).map((d) => nameOf(d) || "Untitled rule"),
    ...removedRules().map((rule) => `${nameOf(rule) || rule.id} (deleted)`),
  ];
  revertEl.disabled = names.length === 0;

  const kind = message?.kind ?? "";
  const parts = message
    ? [message.text]
    : names.length === 0
      ? ["No unsaved changes."]
      : ["Unsaved changes for ", ...names.flatMap((name, i) => [i > 0 ? ", " : "", strong(name)])];

  // A status region announces every rewrite, so only rewrite on a change.
  const text = parts.map((p) => (typeof p === "string" ? p : p.textContent)).join("");
  if (statusEl.textContent === text && statusEl.className === `status ${kind}`.trim()) return;
  statusEl.replaceChildren(...parts);
  statusEl.className = `status ${kind}`.trim();
}

function strong(text) {
  const el = document.createElement("strong");
  el.textContent = text;
  return el;
}

function setStatus(text, kind = "") {
  message = { text, kind };
  updateSaveBar();
}

async function save() {
  validateAll();
  const bad = drafts.filter((draft) => errors.get(draft).length > 0);
  if (bad.length > 0) {
    validating = true;
    // Show a rule that needs fixing, unless the one on screen already does.
    if (!bad.includes(selected)) selected = bad[0];
    render();
    const n = bad.length;
    setStatus(`${n} rule${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} fixing.`, "bad");
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

  const rules = drafts.map(strip);
  await saveRules(rules);
  markSaved(rules);
  validating = false;
  errors = new Map();
  // The background has now forgotten any deleted rule's usage, so its id is
  // genuinely free again from here on.
  reservedIds = drafts.map((d) => d.id);
  // The background has now forgotten any deleted rule's usage, so the history
  // this page shows must not keep claiming otherwise.
  await loadHistory(drafts);
  render();
  setStatus("Saved — applied immediately.", "ok");
}

/** Back to what is saved, deleted rules included. */
function revert() {
  const keep = selected?.id;
  drafts = saved.map(cloneRule);
  selected = drafts.find((d) => d.id && d.id === keep) ?? drafts[0] ?? null;
  validating = false;
  errors = new Map();
  render();
  setStatus("Reverted to what is saved.");
}

// --- export and import ---------------------------------------------------

/** What is saved, not the drafts: an export must not carry unsaved edits. */
async function exportRules() {
  const rules = await loadRules();
  const json = JSON.stringify(serializeRules(rules, Date.now()), null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `selfcontrol-rules-${dayKey(Date.now())}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  setStatus(`Exported ${rules.length} rule${rules.length === 1 ? "" : "s"}.`, "ok");
}

const transferEl = document.getElementById("transfer");
const transferSummaryEl = document.getElementById("transfer-summary");

/** The parsed rules waiting for the user to confirm, or null. */
let pendingImport = null;

function describeImport(current, incoming) {
  const { added, kept, removed } = importSummary(current, incoming);
  const n = (count) => `${count} rule${count === 1 ? "" : "s"}`;
  const parts = [`${n(incoming.length)} replace your ${n(current.length)}.`];
  if (kept.length > 0) parts.push(`${kept.join(", ")} keep${kept.length === 1 ? "s" : ""} its history;`);
  if (removed.length > 0) parts.push(`${removed.join(", ")}: history discarded.`);
  if (added.length > 0) parts.push(`${added.join(", ")}: new.`);
  return parts.join(" ").replace(/;$/, ".");
}

async function importFromFile(file) {
  const result = parseImport(await file.text());
  if (!result.ok) {
    setStatus(`Import refused: ${result.error}`, "bad");
    return;
  }
  // Against what is saved, since that is whose history is at stake.
  const current = await loadRules();
  pendingImport = result.rules;
  transferSummaryEl.textContent = describeImport(current, result.rules);
  transferEl.hidden = false;
  message = null;
  updateSaveBar();
}

function cancelImport() {
  pendingImport = null;
  transferEl.hidden = true;
}

/** Replace the drafts and go through the ordinary save path, validation included. */
async function confirmImport() {
  if (!pendingImport) return;
  drafts = pendingImport.map(cloneRule);
  selected = drafts[0] ?? null;
  cancelImport();
  render();
  await save();
}

document.getElementById("export").addEventListener("click", exportRules);

const fileInput = document.getElementById("import-file");
document.getElementById("import").addEventListener("click", () => {
  fileInput.value = "";
  fileInput.click();
});
fileInput.addEventListener("change", () => {
  const [file] = fileInput.files;
  if (file) importFromFile(file);
});
document.getElementById("transfer-confirm").addEventListener("click", confirmImport);
document.getElementById("transfer-cancel").addEventListener("click", cancelImport);

// --- wiring --------------------------------------------------------------

document.getElementById("add").addEventListener("click", () => {
  const draft = blankRule();
  drafts.push(draft);
  selected = draft;
  render();
  detailEl.querySelector('[data-field="label"]').focus();
});

document.getElementById("save").addEventListener("click", save);
revertEl.addEventListener("click", revert);

// Read at runtime from the manifest, so it can never drift from what is
// actually installed.
document.getElementById("version").textContent = `v${browser.runtime.getManifest().version}`;

const loaded = await loadRules();
markSaved(loaded);
drafts = loaded.map(cloneRule);
selected = drafts[0] ?? null;
reservedIds = drafts.map((rule) => rule.id);
await loadHistory(drafts);
render();
