// Unit tests for the toolbar badge decision.
//   nix develop --command node --test

import test from "node:test";
import assert from "node:assert/strict";

import { badgeFor } from "../extension/common/badge.js";

const idle = { counting: false, exhausted: false, pass: { active: false } };
const counting = { ...idle, counting: true };
const spent = { ...idle, exhausted: true };
const onPass = { ...idle, pass: { active: true } };

test("badgeFor: nothing to say is an empty badge", () => {
  assert.equal(badgeFor([]).text, "");
  assert.equal(badgeFor([idle, idle]).text, "");
});

test("badgeFor: any rule counting shows the dot", () => {
  const badge = badgeFor([idle, counting]);
  assert.equal(badge.text, "●");
  assert.ok(badge.color, "carries a colour");
});

test("badgeFor: a rule exhausted and none counting shows the mark", () => {
  const badge = badgeFor([idle, spent]);
  assert.equal(badge.text, "!");
  assert.notEqual(badge.color, badgeFor([counting]).color, "a different colour from the dot");
});

test("badgeFor: counting wins over another rule being exhausted", () => {
  // It is the thing happening right now.
  assert.equal(badgeFor([spent, counting]).text, "●");
});

test("badgeFor: an active pass counts as counting", () => {
  assert.equal(badgeFor([onPass]).text, "●");
  assert.equal(badgeFor([spent, onPass]).text, "●");
});

test("badgeFor: tolerates missing fields", () => {
  assert.equal(badgeFor([{ counting: true }]).text, "●");
  assert.equal(badgeFor([{ exhausted: true }]).text, "!");
  assert.equal(badgeFor([{}]).text, "");
});
