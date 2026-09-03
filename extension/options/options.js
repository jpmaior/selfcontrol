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
  validateRule,
} from "../common/rules.js";
import { loadRules, saveRules } from "../common/settings.js";

const listEl = document.getElementById("rules");
const templateEl = document.getElementById("rule-template");
const statusEl = document.getElementById("status");

/** The working copy. Never the same objects as what is in storage. */
let drafts = [];

/**
 * Ids that existed when the page loaded (or was last saved). A deleted rule's
 * id must not be re-minted in the same save: the background would see it
 * survive and the new rule would inherit the dead rule's usage history.
 */
let reservedIds = [];

// --- draft <-> form ------------------------------------------------------

const toMin = (sec) => Math.round(sec / 60);
const toSec = (min) => Math.max(0, Math.round(Number(min) || 0) * 60);

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
    clearStatus();
  });

  // Normalise the domain field once the user leaves it, so they can see what
  // was actually understood — "https://www.YouTube.com/feed" becoming
  // "youtube.com" is reassuring rather than mysterious.
  field("match").addEventListener("change", (event) => {
    event.target.value = draft.match.join(", ");
  });

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

/** Only the fields a rule is made of; drop anything the form left lying around. */
function strip(draft) {
  return {
    id: draft.id,
    label: draft.label.trim(),
    match: draft.match,
    mode: draft.mode,
    budgetSec: draft.budgetSec,
    windowSec: draft.windowSec,
    onExceed: draft.onExceed,
    minUnlockCreditSec: draft.minUnlockCreditSec,
  };
}

// --- wiring --------------------------------------------------------------

document.getElementById("add").addEventListener("click", () => {
  drafts.push(blankRule());
  render();
  listEl.lastElementChild?.querySelector('[data-field="label"]')?.focus();
});

document.getElementById("save").addEventListener("click", save);

drafts = (await loadRules()).map((rule) => ({ ...rule, match: [...rule.match] }));
reservedIds = drafts.map((rule) => rule.id);
render();
