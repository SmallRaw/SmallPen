import assert from "node:assert/strict";
import test from "node:test";
import { tokenSetOperations } from "../packages/core/src/simple-authoring.mjs";

function example() {
  const sets = ["Theme/Default", "Theme/Dark", "Viewport/Small", "Viewport/Medium"]
    .map((name, i) => ({ id: `set_${i}`, name, tokens: [{
      id: `tok_${i}`, name: "size.emblem", type: "number", value: 40 + i,
    }] }));
  return { manifest: { entries: { tokens: ["tokens.json"] } }, entries: {
    "tokens.json": { sets, themes: sets.map((set, i) => ({
      id: `theme_${i}`, group: set.name.split("/")[0], name: set.name.split("/")[1], setIds: [set.id],
    })), defaultThemeIds: ["theme_0", "theme_2"], activeThemeIds: ["theme_1", "theme_3"] },
  } };
}

test("an explicit Token group disambiguates the row and edits only its named option", () => {
  const snapshot = example(), before = structuredClone(snapshot);
  const edits = tokenSetOperations(snapshot, { tokens: [{
    name: "size.emblem", group: "viewport", values: { "Viewport/Medium": 120 },
  }] }, () => "new_token");
  assert.equal(edits.length, 1);
  assert.equal(edits[0].setId, "set_3");
  assert.equal(edits[0].token.value, 120);
  assert.equal(edits[0].token.id, "tok_3");
  assert.deepEqual(snapshot, before, "planning changes neither defaults nor App selection");
});

test("omitting the group retains the ambiguous Token name error", () => {
  assert.throws(() => tokenSetOperations(example(), { tokens: [{
    name: "size.emblem", values: { "Viewport/Medium": 120 },
  }] }), error => error.code === "ambiguous_token_name");
});

test("an explicit unknown Token group fails before ambiguous-name lookup", () => {
  assert.throws(() => tokenSetOperations(example(), { tokens: [{
    name: "size.emblem", group: "Missing", value: 120,
  }] }), error => error.code === "unknown_token_theme_group");
});

test("an option from another group cannot escape an explicit Token group", () => {
  assert.throws(() => tokenSetOperations(example(), { tokens: [{
    name: "size.emblem", group: "Viewport", values: { "Theme/Dark": 120 },
  }] }), error => error.code === "token_group_mismatch");
});
