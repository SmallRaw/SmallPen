import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createTokenRow,
  writeTokenCell,
  tokenGroupSets,
  tokenIntentOperations,
  initializationTokenThemes,
  themeIntentOperations,
} from "@smallpen/core";
import { openPackage } from "@smallpen/local-package";
import { INIT_ANSWERS_EXAMPLE } from "../apps/cli/bin/schema.mjs";

const cli = new URL("../apps/cli/bin/smallpen.mjs", import.meta.url).pathname;
async function run(args, expected = 0) {
  // These tests compare complete design state; transport bounds have their own tests.
  const delivery = args.includes("--full") ? ["--stdout"] : [];
  const child = spawn(process.execPath, [cli, ...args, ...delivery], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, expected, stdout || stderr);
  return JSON.parse(stdout);
}

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

test("adding an option to a legacy group preserves its native App domain", async () => {
  const library = {
    id: "tlib_test",
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
    activeThemeIds: ["theme_day"],
    activeSetIds: [],
  };
  const snapshot = {
    manifest: { entries: { tokens: ["tokens.json"] } },
    entries: { "tokens.json": library },
    domain: { scenarios: new Map() },
  };
  const operations = await themeIntentOperations(snapshot, {
    action: "add-option",
    group: "Appearance",
    name: "Twilight",
  });
  const next = operations.find(
    (operation) => operation.type === "replace-token-library",
  ).library;
  assert.deepEqual(
    next.sets.map((set) => set.name),
    ["base", "appearance/day", "appearance/night", "appearance/Twilight"],
  );
  assert.equal(tokenGroupSets(next, "Appearance").length, 3);
  snapshot.entries["tokens.json"] = next;
  let id = 0;
  const row = tokenIntentOperations(
    snapshot,
    {
      action: "create-row",
      group: "Appearance",
      name: "color.accent",
      type: "color",
      value: "#112233",
    },
    () => `tok_${++id}`,
  );
  assert.equal(row.length, 3);
  assert.ok(row.every((operation) => operation.setId !== "tset_base"));
});

test("new init keeps arbitrary App group and option labels in native Set paths", () => {
  const result = initializationTokenThemes([
    {
      name: "Visual Theme",
      kind: "theme",
      values: ["Default", "High Contrast"],
      defaultValue: "Default",
    },
  ]);
  assert.deepEqual(
    result.sets.map((set) => set.name),
    ["base", "Visual Theme/Default", "Visual Theme/High Contrast"],
  );
  const library = {
    ...result,
    sets: result.sets.map((set) => ({ ...set, tokens: [] })),
  };
  const snapshot = {
    manifest: { entries: { tokens: ["tokens.json"] } },
    entries: { "tokens.json": library },
  };
  const ops = tokenIntentOperations(
    snapshot,
    {
      action: "create-row",
      group: "Visual Theme",
      name: "color.accent",
      type: "color",
      value: "#112233",
    },
    () => "tok_test",
  );
  assert.deepEqual(
    ops.map((op) => op.setId),
    result.sets.slice(1).map((set) => set.id),
  );
});

test("AI creates a Token row by name, fills an empty cell, reads raw definitions and resolves arbitrary combinations", async () => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-authoring-"));
  const answers = join(root, "answers.json");
  await writeFile(
    answers,
    JSON.stringify({ ...INIT_ANSWERS_EXAMPLE, contextAxes: [] }),
  );
  const initialized = await run([
    "project",
    "init",
    join(root, "acme"),
    "--answers",
    answers,
    "--confirm",
    "--json",
  ]);
  const path = initialized.packages.package.path;
  const file = join(root, "intent.json");
  const setTokens = async (tokens, ...args) => {
    await writeFile(file, JSON.stringify({ tokens }));
    return run(["token", "set", path, "--intent", file, ...args, "--json"]);
  };
  const stored = async () => (await openPackage(path)).entries;
  const definitions = () =>
    run([
      "token",
      "list",
      path,
      "--definitions",
      "--group",
      "Brand",
      "--full",
      "--json",
    ]);
  const schema = await run(["schema", "token-set", "--json"]);
  assert.ok(JSON.stringify(schema.fields).includes("group"));
  assert.ok(
    JSON.stringify(await run(["help", "token", "set", "--json"])).includes(
      "token-set",
    ),
  );
  await run([
    "token", "theme", "add",
    path,
    "--theme",
    "Brand/Default",
    "--theme",
    "Brand/Ocean",
    "--theme",
    "Brand/Rose",
    "--theme",
    "Other/Default",
    "--json",
  ]);
  const before = await run(["token", "theme", "list", path, "--full", "--json"]);
  const card = {
    name: "space.card",
    type: "spacing",
    group: "Brand",
    value: 12,
    description: "Card spacing",
  };
  const created = await setTokens([card], "--batch-id", "create-card");
  const retry = await setTokens([card], "--batch-id", "create-card");
  assert.equal(retry.alreadyApplied, true);
  assert.equal(retry.revision, created.revision);
  await run(["advanced", "apply", path, "--batch", created.inverseBatchPath, "--json"]);
  const reapplied = await setTokens([card], "--batch-id", "create-card");
  assert.equal(reapplied.revision, created.revision);
  let rows = (await definitions()).items;
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((item) => item.token.value),
    [12, 12, 12],
  );
  assert.equal(new Set(rows.map((item) => item.token.id)).size, 3);
  assert.deepEqual(
    (await run(["token", "list", path, "--definitions", "--group", "Other", "--json"]))
      .items,
    [],
  );
  const ocean = rows.find((item) => item.option === "Ocean");
  const toOcean = [{ name: "space.card", values: { "Brand/Ocean": 24 } }];
  const changed = await setTokens(toOcean, "--batch-id", "change-ocean");
  await run(["advanced", "apply", path, "--batch", changed.inverseBatchPath, "--json"]);
  const changedAgain = await setTokens(toOcean, "--batch-id", "change-ocean");
  assert.equal(changedAgain.revision, changed.revision);
  rows = (await definitions()).items;
  assert.equal(
    rows.find((item) => item.option === "Ocean").token.id,
    ocean.token.id,
  );
  assert.deepEqual(
    rows.map((item) => item.token.value),
    [12, 24, 12],
  );
  // Emptying one cell has no name command; the App does it with an
  // operation batch, which apply still takes.
  const rose = rows.find((item) => item.option === "Rose");
  await writeFile(
    file,
    JSON.stringify({
      baseRevision: (await openPackage(path)).revision,
      batchId: "empty-rose",
      operations: [{ type: "remove-token", tokenId: rose.token.id }],
    }),
  );
  await run(["advanced", "apply", path, "--batch", file, "--json"]);
  const empty = (await definitions()).items;
  assert.equal(empty.length, 2);
  const emptyResolved = await run([
    "token",
    "list",
    path,
    "--theme",
    "Brand/Rose",
    "--full",
    "--json",
  ]);
  assert.ok(
    !emptyResolved.items.some((item) => item.token.path === "space.card"),
  );
  await setTokens([{ name: "space.card", values: { "Brand/Rose": 32 } }]);
  rows = (await definitions()).items;
  const refilled = rows.find((item) => item.option === "Rose").token;
  assert.equal(refilled.value, 32);
  assert.notEqual(refilled.id, rose.token.id);
  assert.equal(refilled.description, "Card spacing");
  const snapshot = await stored();
  await writeFile(file, JSON.stringify({ tokens: toOcean }));
  const refused = await run(
    ["token", "set", path, "--intent", file, "--batch-id", "change-ocean", "--json"],
    1,
  );
  assert.equal(refused.error.code, "batch_superseded");
  const defaultValues = await run(["token", "list", path, "--full", "--json"]);
  const oceanValues = await run([
    "token",
    "list",
    path,
    "--theme",
    "Other/Default",
    "--theme",
    "Brand/Ocean",
    "--full",
    "--json",
  ]);
  assert.equal(
    defaultValues.items.find((item) => item.token.path === "space.card").value,
    12,
  );
  assert.equal(
    oceanValues.items.find((item) => item.token.path === "space.card").value,
    24,
  );
  assert.deepEqual(await stored(), snapshot, "reads leave stored data alone");
  assert.deepEqual(
    (await run(["token", "theme", "list", path, "--full", "--json"])).appSelection,
    before.appSelection,
  );
  await writeFile(
    file,
    JSON.stringify({ tokens: [{ name: "space.card", values: { "Brand/missing": 1 } }] }),
  );
  const error = await run(["token", "set", path, "--intent", file, "--json"], 1);
  assert.equal(error.error.code, "unknown_theme_option");
  assert.deepEqual(await stored(), snapshot);
  await writeFile(
    file,
    JSON.stringify({ tokens: [{ name: "space.card", values: { "Brand/Ocean": { invalid: true } } }] }),
  );
  await run(["token", "set", path, "--intent", file, "--json"], 1);
  assert.deepEqual(await stored(), snapshot);
});
