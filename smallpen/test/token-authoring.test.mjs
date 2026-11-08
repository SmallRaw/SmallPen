import assert from "node:assert/strict";
import test from "node:test";
import {
  createTokenRow,
  writeTokenCell,
  tokenGroupSets,
  tokenIntentOperations,
} from "@smallpen/core";

test("shared row creation and cell writes preserve independent identities and metadata", () => {
  const sets = [
    { id: "a", name: "Brand/Default", tokens: [] },
    { id: "b", name: "Brand/Ocean", tokens: [] },
    { id: "outside", name: "Other/Default", tokens: [] },
  ];
  const token = {
    id: "discard",
    name: "space.card",
    type: "spacing",
    value: 12,
    description: "Card spacing",
    "modified-at": "discard",
  };
  let sequence = 0;
  const edits = createTokenRow(
    sets,
    ["a", "a", "b", "missing"],
    token,
    () => `new_${++sequence}`,
  );
  assert.deepEqual(
    edits.map(({ setId }) => setId),
    ["a", "b"],
  );
  assert.deepEqual(
    edits.map(({ token }) => token.value),
    [12, 12],
  );
  assert.deepEqual(
    edits.map(({ token }) => token.id),
    ["new_1", "new_2"],
  );
  assert.ok(edits.every(({ token }) => !Object.hasOwn(token, "modified-at")));
  assert.equal(sets[0].tokens.length, 0);
  sets[0].tokens.push(edits[0].token);
  const filled = writeTokenCell(
    sets,
    "b",
    edits[0].token,
    "{space.base}",
    () => "new_3",
  );
  assert.deepEqual(filled.token, {
    id: "new_3",
    name: "space.card",
    type: "spacing",
    value: "{space.base}",
    description: "Card spacing",
  });
  sets[1].tokens.push(filled.token);
  const changed = writeTokenCell(sets, "b", edits[0].token, 24, () =>
    assert.fail("existing cell must keep its ID"),
  );
  assert.equal(changed.token.id, "new_3");
  assert.equal(changed.token.value, 24);
  assert.equal(changed.token.description, "Card spacing");
  assert.equal(sets[0].tokens[0].value, 12);
  assert.equal(sets[2].tokens.length, 0);
  assert.throws(() => createTokenRow(sets, ["a", "b"], token, () => "other"), {
    code: "duplicate_token_name",
  });
  assert.deepEqual(
    tokenGroupSets({ sets }, "Brand").map((set) => set.id),
    ["a", "b"],
  );
});

test("independent row copies preserve composite value fields without sharing mutable objects", () => {
  const value = [
    { color: "#112233", offsetX: 1, offsetY: 2, blur: 4, spread: 0 },
  ];
  const template = { name: "shadow.card", type: "shadow", value };
  let id = 0;
  const edits = createTokenRow(
    [
      { id: "a", tokens: [] },
      { id: "b", tokens: [] },
    ],
    ["a", "b"],
    template,
    () => `id_${++id}`,
  );
  assert.deepEqual(
    edits.map((edit) => edit.token.value),
    [value, value],
  );
  edits[0].token.value[0].blur = 8;
  assert.equal(edits[1].token.value[0].blur, 4);
  assert.equal(template.value[0].blur, 4);
});

test("theme labels from init select native App Set groups and options without writing dependencies", () => {
  const library = {
    sets: [
      { id: "tset_base", name: "base", tokens: [] },
      { id: "tset_day", name: "appearance/day", tokens: [] },
      { id: "tset_night", name: "appearance/night", tokens: [] },
    ],
    themes: [
      {
        id: "theme_day",
        group: "Appearance",
        name: "Day",
        setIds: ["tset_base", "tset_day"],
      },
      {
        id: "theme_night",
        group: "Appearance",
        name: "Night",
        setIds: ["tset_base", "tset_night"],
      },
    ],
  };
  const snapshot = {
    manifest: { packageId: "pkg_test", entries: { tokens: ["tokens.json"] } },
    entries: { "tokens.json": library },
  };
  let id = 0;
  const create = tokenIntentOperations(
    snapshot,
    {
      action: "create-row",
      group: "Appearance",
      name: "color.accent",
      type: "color",
      value: "#112233",
      description: "",
    },
    () => `tok_${++id}`,
  );
  assert.deepEqual(
    create.map((op) => op.setId),
    ["tset_day", "tset_night"],
  );
  for (const op of create)
    library.sets.find((set) => set.id === op.setId).tokens.push(op.token);
  const change = tokenIntentOperations(snapshot, {
    action: "set-value",
    group: "Appearance",
    option: "Night",
    name: "color.accent",
    value: "#334455",
  });
  assert.equal(change[0].setId, "tset_night");
  assert.equal(change[0].token.id, "tok_2");
  assert.throws(() => tokenIntentOperations(snapshot, { action: "toString" }), {
    code: "invalid_token_intent",
  });
});

