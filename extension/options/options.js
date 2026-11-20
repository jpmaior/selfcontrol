// Options page: add, edit and delete rules, and choose the day the week starts.
//
// Master/detail: the rule list, and one rule's form at a time. Edits live in a
// local draft array and are only written on Save, so a half-typed domain never
// reaches the background. Saving writes the `settings` key; the background is
// watching it and re-arms itself without a reload. The week's start day is a
// draft too, saved with the rules.

import {
  MODES,
  ON_EXCEED,
  blankRule,
  blocksOutright,
  droppedPath,
  formEdit,
  hasPath,
  makeRuleId,
  strip,
  validateRule,
} from "../common/rules.js";
import { loadSettings, saveSettings, usageKey } from "../common/settings.js";
import { HISTORY_DAYS, normalizeUsage, usedByDay } from "../common/accountant.js";
import { DEFAULT_WEEK, addDays, changeWeekStart, dayKey, startOfDay, weekOf } from "../common/calendar.js";
import { historyWeeks } from "../common/history.js";
import { WEEKDAYS, clock, strong } from "../common/format.js";
import { describeImport, parseImport, serializeRules } from "../common/transfer.js";
import { reportsAudible } from "../common/platform.js";

const listEl = document.getElementById("rule-list");
const countEl = document.getElementById("rule-count");
const detailEl = document.getElementById("detail");
const itemTemplateEl = document.getElementById("rule-item-template");
const templateEl = document.getElementById("rule-template");
const emptyTemplateEl = document.getElementById("empty-template");
const statusEl = document.getElementById("status");
const revertEl = document.getElementById("revert");
const weekStartEl = document.getElementById("week-start");
const weekCarryEl = document.getElementById("week-carry");

/** Whether "Count time" is a real choice here; not on Firefox for Android. */
const AUDIBLE = await reportsAudible();

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

/**
 * The week setting as last loaded or saved, and the start day the select
 * shows. Saved with the rules, through changeWeekStart() (DESIGN.md §14).
 */
let savedWeek = DEFAULT_WEEK;
let weekDraft = DEFAULT_WEEK.startDay;

const weekEdited = () => weekDraft !== savedWeek.startDay;

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

// Display only. A rule from setLimits() or an import can hold seconds a
// minutes field cannot show; the field shows them rounded, and they are only
// rewritten when that field is edited (formEdit()).
const toMin = (sec) => Math.round(sec / 60);

/** For the optional caps: blank is "none" (null), anything else is minutes. */
const toMinOrBlank = (sec) => (sec === null || sec === undefined ? "" : toMin(sec));

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

/** The fields the history view draws from: the caps, and whether pass time counts toward them. */
const HISTORY_FIELDS = new Set(["budgetMin", "dailyMin", "weeklyMin", "passCounts"]);

function buildForm(draft) {
  const root = templateEl.content.firstElementChild.cloneNode(true);
  const field = (name) => root.querySelector(`[data-field="${name}"]`);

  // Form-only state, which strip() leaves out of what is saved. "Match paths"
  // is not stored: it is on for a rule that has a path. `matchText` is what
  // was last typed or pasted, so turning paths off and on again gives back the
  // path the field had dropped.
  draft.matchPaths ??= draft.match.some(hasPath);
  draft.matchText ??= draft.match.join(", ");

  const showPaths = () => {
    // With paths off, "youtube.com/shorts" quietly becoming "youtube.com"
    // would limit the whole site, so say so and point at the checkbox.
    const dropped = draft.matchPaths ? null : droppedPath(draft.matchText);
    const note = root.querySelector('[data-role="path-dropped"]');
    note.hidden = !dropped;
    if (dropped) {
      note.textContent = `Only the site is kept, so this covers all of ${dropped.split("/")[0]}. Tick Match paths to limit ${dropped} alone.`;
    }
    field("matchPaths").checked = draft.matchPaths;
    root.querySelector('[data-role="paths-hint"]').hidden = !draft.matchPaths;
    root.querySelector('[data-role="match-label"]').textContent = draft.matchPaths ? "Domains and paths" : "Domains";
    field("match").placeholder = draft.matchPaths ? "youtube.com/shorts" : "youtube.com, vimeo.com";
  };

  field("label").value = draft.label;
  field("match").value = draft.match.join(", ");
  showPaths();
  field("budgetMin").value = toMinOrBlank(draft.budgetSec);
  field("windowMin").value = toMin(draft.windowSec);
  field("unlockMin").value = toMin(draft.minUnlockCreditSec);
  field("dailyMin").value = toMinOrBlank(draft.dailyBudgetSec);
  field("weeklyMin").value = toMinOrBlank(draft.weeklyBudgetSec);
  field("passesPerWeek").value = draft.passes.perWeek;
  field("passMin").value = toMin(draft.passes.durationSec);
  field("passCounts").checked = draft.passes.countsTowardCaps;

  fillOptions(field("mode"), MODES, draft.mode);
  // Firefox for Android cannot tell when a tab plays sound, so every rule
  // counts while focused there and the choice would be a lie (DESIGN.md §12).
  // Hidden, so never edited: the stored mode stays in the draft, and a rule
  // from desktop keeps counting while playing there.
  field("mode").closest(".field").hidden = !AUDIBLE;
  if (!AUDIBLE) field("match").closest("section").querySelector(".section-title").textContent = "1. Domains";
  fillOptions(field("onExceed"), ON_EXCEED, draft.onExceed);
  showOutright(root, draft);
  showWeekEnd(root);

  // Write back only the field that was edited (formEdit()): reading every
  // field back would round each value to the whole minutes it is shown in.
  root.addEventListener("input", (event) => {
    const name = event.target.dataset.field;
    if (!name) return;
    const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
    const change = formEdit(draft, name, value);
    Object.assign(draft, change);
    if (name === "matchPaths") field("match").value = draft.match.join(", ");
    if (name === "match" || name === "matchPaths") showPaths();
    // A new rule's cool-down following its budget.
    if (name === "budgetMin" && "minUnlockCreditSec" in change) {
      field("unlockMin").value = toMin(draft.minUnlockCreditSec);
    }
    showOutright(root, draft);
    // The history's cap line and "cap reached" follow the caps as they are typed.
    if (HISTORY_FIELDS.has(name)) renderHistory(root, draft);
    if (validating) validateAll();
    message = null;
    renderList();
    showErrors(root, draft);
    updateSaveBar();
  });

  // Normalise the domain field once the user leaves it, so they can see what
  // was actually understood — "https://www.YouTube.com/feed" becoming
  // "youtube.com" (or "youtube.com/feed" with paths on) is reassuring rather
  // than mysterious.
  field("match").addEventListener("change", (event) => {
    event.target.value = draft.match.join(", ");
  });

  root.querySelector('[data-action="delete"]').addEventListener("click", () => remove(draft));

  showErrors(root, draft);
  renderHistory(root, draft);
  return root;
}

/**
 * A budget of 0 blocks the site outright, and nothing that limits time applies
 * any more (DESIGN.md §22). The parts marked `data-limit` are greyed out and
 * disabled rather than cleared or hidden, so it is plain what comes back when
 * the budget does; a notice says what will happen, before Save.
 */
function showOutright(root, draft) {
  const outright = blocksOutright(draft);
  for (const part of root.querySelectorAll("[data-limit]")) {
    part.classList.toggle("off", outright);
    for (const control of part.querySelectorAll("input, select")) control.disabled = outright;
  }
  root.querySelector('[data-role="on-exceed-label"]').textContent = outright
    ? "When it is opened"
    : "When it runs out";

  const notice = root.querySelector('[data-role="outright"]');
  notice.hidden = !outright;
  if (!outright) return;
  const name = nameOf(draft);
  const what =
    draft.onExceed === "close"
      ? ["Closed outright.", `A tab on ${name || "this site"} is closed the moment it opens, and any tab already on it is closed when you save.`]
      : ["Blocked outright.", `${name || "This site"} is blocked the moment it is opened, and any tab already on it is blocked when you save.`];
  notice.replaceChildren(
    strong(what[0]),
    ` ${what[1]} That lasts until you raise the budget. Nothing is counted, so the window, the daily and weekly caps, the cool-down and the passes are switched off.`,
  );
}

// --- the week ------------------------------------------------------------

/** "a week on Sunday night": the night before the start day. */
function showWeekEnd(root) {
  const el = root.querySelector('[data-role="week-end"]');
  if (el) el.textContent = WEEKDAYS[(weekDraft + 6) % 7];
}

const shortDate = (ms) => new Date(ms).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

/**
 * The select, and when the week in progress runs longer than seven days, say
 * so: before Save, what saving would do, and after it, while it lasts.
 */
function showWeek() {
  weekStartEl.value = String(weekDraft);
  showWeekEnd(detailEl);
  const now = Date.now();
  const week = weekEdited() ? changeWeekStart(savedWeek, weekDraft, now) : savedWeek;
  const { startMs, endMs } = weekOf(now, week);
  const carried = week.carry !== null && week.carry.until === endMs;
  weekCarryEl.hidden = !carried;
  if (!carried) return;
  const what = `This week began on ${shortDate(startMs)} and runs until ${shortDate(endMs)}, when weeks start on ${WEEKDAYS[week.startDay]}.`;
  weekCarryEl.textContent = weekEdited() ? `Once saved: ${what[0].toLowerCase()}${what.slice(1)}` : what;
}

// Monday first, as the default.
for (const day of [1, 2, 3, 4, 5, 6, 0]) {
  const option = document.createElement("option");
  option.value = String(day);
  option.textContent = WEEKDAYS[day];
  weekStartEl.append(option);
}

weekStartEl.addEventListener("change", () => {
  weekDraft = Number(weekStartEl.value);
  message = null;
  showWeek();
  // The history's rows follow the start day being chosen.
  if (selected) renderHistory(detailEl, selected);
  updateSaveBar();
});

// --- the list ------------------------------------------------------------

/** "5m / 1h window": the rolling cap, the one every rule has. */
const capSummary = (draft) =>
  blocksOutright(draft)
    ? "blocked outright"
    : `${shortDuration(draft.budgetSec * 1000)} / ${shortDuration(draft.windowSec * 1000)} window`;

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
  if (selected) {
    detailEl.replaceChildren(buildForm(selected));
    return;
  }
  const empty = emptyTemplateEl.content.firstElementChild.cloneNode(true);
  empty.querySelector('[data-action="add"]').addEventListener("click", addRule);
  detailEl.replaceChildren(empty);
}

function render() {
  renderList();
  renderDetail();
  showWeek();
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
  el.replaceChildren(total("7 days", days.slice(-7)), sep, total(`${HISTORY_DAYS} days`, days));
}

/** "0", "30m", "1h", "1h30": short, for a scale or a chip. Values are whole minutes. */
function shortDuration(ms) {
  const min = Math.round(ms / 60_000);
  if (min === 0) return "0";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}`;
}

const capMs = (sec) => (Number.isFinite(sec) && sec > 0 ? sec * 1000 : null);

function dayLabel(day, today) {
  if (day.at === today) return "Today";
  if (day.at === addDays(today, -1)) return "Yesterday";
  return new Date(day.at).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function dayText(day, today) {
  const label = dayLabel(day, today);
  if (!day.inRange) return `${label}: ${day.at > today ? "still to come" : `older than ${HISTORY_DAYS} days`}`;
  if (day.used === 0 && day.pass === 0) return `${label}: nothing`;
  const parts = [`${label}: ${clock(day.used)} used`];
  if (day.pass > 0) parts.push(`${clock(day.pass)} on a pass`);
  if (day.reached) parts.push("daily cap reached");
  return parts.join(", ");
}

/** Rows are newest first: "This week", "Last week", then the start date. */
function weekLabel(week, index, long = false) {
  if (index === 0) return "This week";
  if (index === 1) return "Last week";
  const date = new Date(week.startMs).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return long ? `Week of ${date}` : date;
}

function weekText(week, index) {
  const reached = week.reached ? ", weekly cap reached" : "";
  return `${weekLabel(week, index, true)}: ${clock(week.used + week.pass)}${reached}`;
}

/** The day picked by a click, a tap or the keyboard, kept across a re-render of the same rule. */
let pickedDay = null;
let pickedFor = null;

/**
 * The kept days (HISTORY_DAYS) as a calendar: one row per week, newest on
 * top, starting on the day the week starts, from the first week with any use.
 * Each day is a small column of used time under pass time, against the daily
 * cap's line when the rule has one, all on one scale; the row's header gives
 * the week's total, with a bar to read the weeks against each other. Ninety
 * columns side by side would be three pixels each on a phone (DESIGN.md §13).
 *
 * Exact figures are in the readout above the calendar, for the day under the
 * pointer, or the one picked by a click, a tap or the arrow keys: the
 * calendar is an ARIA grid with one tab stop, and every day carries its
 * figures as its label.
 */
function renderHistory(root, draft) {
  const body = root.querySelector('[data-role="history-body"]');
  const totalsEl = root.querySelector('[data-role="history-totals"]');
  const readout = root.querySelector('[data-role="readout"]');
  const byDay = draft.id ? history.get(draft.id) : null;
  if (pickedFor !== draft) {
    pickedFor = draft;
    pickedDay = null;
  }

  const now = Date.now();
  const today = startOfDay(now);
  // A rule blocked outright has no time left to limit (DESIGN.md §22).
  const dailyCap = blocksOutright(draft) ? null : capMs(draft.dailyBudgetSec);
  const weeks = byDay
    ? historyWeeks(byDay, now, {
        startDay: weekDraft,
        dailyBudgetMs: dailyCap,
        weeklyBudgetMs: blocksOutright(draft) ? null : capMs(draft.weeklyBudgetSec),
        passCounts: draft.passes.countsTowardCaps,
      })
    : [];

  if (weeks.length === 0) {
    totalsEl.replaceChildren();
    readout.textContent = "";
    body.replaceChildren(note(draft.id ? "Nothing yet." : "History starts once this rule is saved."));
    return;
  }

  const days = weeks.flatMap((week) => week.days).filter((day) => day.inRange);
  renderTotals(totalsEl, days);
  // One scale for every day, so heights compare across weeks: the busiest day
  // or the daily cap, whichever is higher, fills a cell.
  const busiest = days.reduce((top, day) => (day.used + day.pass > top.used + top.pass ? day : top));
  const maxMs = Math.max(busiest.used + busiest.pass, dailyCap ?? 0);
  const weekMaxMs = Math.max(...weeks.map((week) => week.used + week.pass));
  const newestFirst = [...weeks].reverse();

  const weekOfDay = new Map();
  for (const [index, week] of newestFirst.entries()) {
    for (const day of week.days) weekOfDay.set(day.key, [week, index]);
  }
  if (!days.some((day) => day.key === pickedDay)) pickedDay = null;

  let hovered = null;
  const showDay = () => {
    const key = hovered ?? pickedDay ?? days.at(-1).key;
    const day = days.find((d) => d.key === key);
    const [week, index] = weekOfDay.get(key);
    readout.textContent = `${dayText(day, today)} · ${weekText(week, index)}`;
  };

  const grid = document.createElement("div");
  grid.className = "cal";
  grid.setAttribute("role", "grid");
  grid.setAttribute("aria-label", `Daily use by week, the last ${HISTORY_DAYS} days`);
  grid.setAttribute("aria-readonly", "true");

  const head = document.createElement("div");
  head.className = "cal-row cal-head";
  head.setAttribute("role", "row");
  const corner = document.createElement("span");
  corner.setAttribute("role", "columnheader");
  corner.textContent = "Week";
  head.append(corner);
  for (let i = 0; i < 7; i++) {
    const name = document.createElement("span");
    name.setAttribute("role", "columnheader");
    const weekdayName = WEEKDAYS[(weekDraft + i) % 7];
    name.textContent = weekdayName.slice(0, 3);
    name.title = weekdayName;
    head.append(name);
  }
  grid.append(head);

  const cells = new Map();
  for (const [index, week] of newestFirst.entries()) {
    const row = document.createElement("div");
    row.className = "cal-row";
    row.setAttribute("role", "row");

    const header = document.createElement("div");
    header.className = "wk";
    header.setAttribute("role", "rowheader");
    header.setAttribute("aria-label", weekText(week, index));
    const label = document.createElement("span");
    label.className = "wk-label";
    label.textContent = weekLabel(week, index);
    const total = document.createElement("span");
    total.className = "wk-total";
    total.textContent = shortDuration(week.used + week.pass);
    const bar = document.createElement("span");
    bar.className = "wk-bar";
    for (const kind of ["used", "pass"]) {
      if (week[kind] === 0) continue;
      const part = document.createElement("i");
      part.className = kind;
      part.style.width = `${(week[kind] / weekMaxMs) * 100}%`;
      bar.append(part);
    }
    header.append(label, total, bar);
    row.append(header);

    for (const day of week.days) {
      const cell = document.createElement("div");
      cell.className = "day";
      cell.setAttribute("role", "gridcell");
      cell.setAttribute("aria-label", dayText(day, today));
      row.append(cell);
      if (!day.inRange) {
        cell.classList.add("out");
        continue;
      }
      cell.tabIndex = -1;
      cell.dataset.key = day.key;
      cell.title = dayText(day, today);
      cell.classList.toggle("today", day.at === today);
      cell.classList.toggle("zero", day.used + day.pass === 0);
      cells.set(day.key, cell);

      const column = document.createElement("div");
      column.className = "col";
      // Only non-empty segments are drawn, so the gap between them never
      // shows on its own, and the top-most one carries the rounded data-end.
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
      if (dailyCap !== null) {
        const line = document.createElement("div");
        line.className = "cap";
        line.style.bottom = `${(dailyCap / maxMs) * 100}%`;
        column.append(line);
      }
      cell.append(column);
    }
    grid.append(row);
  }

  // One tab stop: the picked day, or today. The arrows move a day sideways
  // and a week up (newer) or down (older); Home and End go to the first and
  // last kept day of the row.
  const pick = (key, focus) => {
    for (const cell of cells.values()) cell.tabIndex = -1;
    cells.get(key).tabIndex = 0;
    if (focus) cells.get(key).focus();
  };
  const choose = (key) => {
    pickedDay = key;
    for (const [k, cell] of cells) cell.classList.toggle("picked", k === key);
    pick(key, false);
    showDay();
  };
  const order = days.map((day) => day.key);
  // A click or a tap focuses the day too; it is listened to as well so that
  // picking never depends on the focus event arriving.
  for (const type of ["focusin", "click"]) {
    grid.addEventListener(type, (event) => {
      const key = event.target.closest?.(".day")?.dataset.key;
      if (key && key !== pickedDay) choose(key);
    });
  }
  grid.addEventListener("keydown", (event) => {
    const key = event.target.dataset?.key;
    if (!key) return;
    const at = order.indexOf(key);
    const rowKeys = weekOfDay.get(key)[0].days.filter((day) => day.inRange).map((day) => day.key);
    const target = {
      ArrowLeft: order[at - 1],
      ArrowRight: order[at + 1],
      ArrowUp: order[Math.min(order.length - 1, at + 7)],
      ArrowDown: order[Math.max(0, at - 7)],
      Home: rowKeys[0],
      End: rowKeys.at(-1),
    }[event.key];
    if (event.key in { ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1, Home: 1, End: 1 }) event.preventDefault();
    if (target && target !== key) pick(target, true);
  });
  grid.addEventListener("mouseover", (event) => {
    const key = event.target.closest?.(".day")?.dataset.key ?? null;
    if (key === hovered) return;
    hovered = key;
    showDay();
  });
  grid.addEventListener("mouseleave", () => {
    hovered = null;
    showDay();
  });

  const legend = document.createElement("div");
  legend.className = "legend";
  legend.append(swatch("used", "Used"));
  if (sum(days, "pass") > 0) legend.append(swatch("pass", "On a pass"));
  if (dailyCap !== null) legend.append(swatch("daily-cap", `Daily cap, ${shortDuration(dailyCap)}`));
  const peak = document.createElement("span");
  peak.className = "legend-peak";
  peak.textContent = `Busiest: ${dayLabel(busiest, today)}, ${clock(busiest.used + busiest.pass)}`;
  legend.append(peak);

  body.replaceChildren(grid, legend);
  if (pickedDay) choose(pickedDay);
  else pick(order.at(-1), false);
  showDay();
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
  const stored = await browser.storage.local.get(rules.map((rule) => usageKey(rule.id)));
  history = new Map(rules.map((rule) => [rule.id, usedByDay(normalizeUsage(stored[usageKey(rule.id)]))]));
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
    ...(weekEdited() ? ["Week start"] : []),
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

function setStatus(text, kind = "") {
  message = { text, kind };
  updateSaveBar();
}

/**
 * Validate every draft and, if any needs fixing, show it: from here on every
 * edit re-validates. Returns how many need fixing.
 */
function flagInvalid() {
  validateAll();
  const bad = drafts.filter((draft) => errors.get(draft).length > 0);
  if (bad.length === 0) return 0;
  validating = true;
  // Show a rule that needs fixing, unless the one on screen already does.
  if (!bad.includes(selected)) selected = bad[0];
  return bad.length;
}

const needFixing = (n) => `${n} rule${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} fixing`;

/**
 * Rules saved before validation was tightened, say with a window longer than
 * a day, still apply as they are: nothing rewrites stored rules. But Save
 * would refuse them with the next edit, so they are pointed out up front
 * rather than when an unrelated change is being saved.
 */
function flagSavedInvalid() {
  const n = flagInvalid();
  render();
  if (n > 0) setStatus(`${needFixing(n)} before the next save. Saved rules still apply as they are.`, "bad");
  return n;
}

async function save() {
  const n = flagInvalid();
  if (n > 0) {
    render();
    setStatus(`${needFixing(n)}.`, "bad");
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
  await saveSettings({ rules, weekStart: weekEdited() ? weekDraft : undefined });
  markSaved(rules);
  savedWeek = (await loadSettings()).week;
  weekDraft = savedWeek.startDay;
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
  weekDraft = savedWeek.startDay;
  validating = false;
  errors = new Map();
  if (flagSavedInvalid() === 0) setStatus("Reverted to what is saved.");
}

// --- export and import ---------------------------------------------------

/** What is saved, not the drafts: an export must not carry unsaved edits. */
async function exportRules() {
  const { rules, week } = await loadSettings();
  const json = JSON.stringify(serializeRules(rules, Date.now(), week.startDay), null, 2);
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

/** The parsed file, `{ rules, weekStart }`, waiting for the user to confirm, or null. */
let pendingImport = null;

async function importFromFile(file) {
  const result = parseImport(await file.text());
  if (!result.ok) {
    setStatus(`Import refused: ${result.error}`, "bad");
    return;
  }
  // Against what is saved, since that is whose history is at stake.
  const { rules: current, week } = await loadSettings();
  pendingImport = { rules: result.rules, weekStart: result.weekStart };
  transferSummaryEl.textContent = describeImport(current, result.rules, {
    weekStart: result.weekStart,
    currentWeekStart: week.startDay,
  });
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
  drafts = pendingImport.rules.map(cloneRule);
  // A file without a week start leaves the one set alone.
  if (pendingImport.weekStart !== null) weekDraft = pendingImport.weekStart;
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

function addRule() {
  const draft = blankRule();
  drafts.push(draft);
  selected = draft;
  render();
  detailEl.querySelector('[data-field="label"]').focus();
}

/** The last `#add-<n>` acted on. */
let addedFor = null;

/**
 * The popup's "Add a rule" opens this page as options.html#add-<n>, or points
 * an open one there. Each <n> adds one rule: Firefox for Android navigates an
 * open tab to it twice, so two hashchange events arrive for one tap. The hash
 * goes once it is read, so a reload does not add another.
 */
function addFromHash() {
  if (!location.hash.startsWith("#add")) return;
  const request = location.hash;
  // window.history: `history` here is the usage history.
  window.history.replaceState(null, "", location.pathname);
  if (request === addedFor) return;
  addedFor = request;
  addRule();
}

document.getElementById("add").addEventListener("click", addRule);
window.addEventListener("hashchange", addFromHash);

document.getElementById("save").addEventListener("click", save);
revertEl.addEventListener("click", revert);

// Read at runtime from the manifest, so it can never drift from what is
// actually installed.
document.getElementById("version").textContent = `v${browser.runtime.getManifest().version}`;

const { rules: loaded, week: loadedWeek } = await loadSettings();
savedWeek = loadedWeek;
weekDraft = savedWeek.startDay;
markSaved(loaded);
drafts = loaded.map(cloneRule);
selected = drafts[0] ?? null;
reservedIds = drafts.map((rule) => rule.id);
await loadHistory(drafts);
flagSavedInvalid();
addFromHash();
