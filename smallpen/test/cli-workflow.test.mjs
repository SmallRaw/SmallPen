import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { openPackage } from "@smallpen/local-package";
import { INIT_ANSWERS_EXAMPLE } from "../apps/cli/bin/schema.mjs";
import { componentSummary } from "../apps/cli/bin/design-output.mjs";

const cli = new URL("../apps/cli/bin/smallpen.mjs", import.meta.url);

test("component summaries compare actual fields across variants with different node IDs", () => {
  const variant = (suffix, color) => ({
    id: `var_${suffix}`,
    rootId: `node_${suffix}`,
    nodes: {
      [`node_${suffix}`]: {
        id: `node_${suffix}`,
        name: "Button",
        type: "COMPONENT",
        width: 100,
        height: 40,
        x: 0,
        y: 0,
        children: [`node_label_${suffix}`],
        fills: [{ type: "solid", color }],
      },
      [`node_label_${suffix}`]: {
        id: `node_label_${suffix}`,
        name: "Label",
        type: "TEXT",
        children: [],
        text: "Save",
        width: 80,
        height: 20,
        x: 10,
        y: 10,
      },
    },
  });
  const summary = componentSummary({
    id: "cmp_button",
    name: "Button",
    axes: [],
    variants: [variant("primary", "#123456"), variant("secondary", "#ffffff")],
  });
  assert.deepEqual(summary.differences, ["fills"]);
});
async function run(args, expected = 0) {
  // Schema and full-value checks opt into stdout; fixed-file transport is tested separately.
  if (
    (args[0] === "schema" || args.includes("--full")) &&
    !args.includes("--stdout")
  )
    args = [...args, "--stdout"];
  const child = spawn(process.execPath, [cli.pathname, ...args], {
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
async function workspace(layout = "single", axes) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-workflow-"));
  const answers = join(root, "answers.json");
  await writeFile(
    answers,
    JSON.stringify({
      ...INIT_ANSWERS_EXAMPLE,
      contextAxes: axes ?? [
        {
          id: "axis_mode",
          name: "Mode",
          kind: "theme",
          defaultValue: "Light",
          values: ["Light", "Dark"],
        },
        {
          id: "axis_scale",
          name: "Scale",
          kind: "theme",
          defaultValue: "Regular",
          values: ["Regular", "Large"],
        },
      ],
    }),
  );
  const initialized = await run([
    "project",
    "init",
    join(root, "acme"),
    "--answers",
    answers,
    "--layout",
    layout,
    "--confirm",
    "--json",
  ]);
  return {
    root,
    path:
      initialized.packages.package?.path ?? initialized.packages.product.path,
    owner:
      initialized.packages.package?.path ??
      initialized.packages.foundation.path,
  };
}
const revisionOf = async (path) =>
  (await run(["project", "show", path, "--json"])).revision;
// Exact operation batches are the App-equivalent write path that stays public
// (advanced apply); name commands cover everything else.
async function apply(path, root, operations, ...args) {
  const file = join(root, `batch-${randomUUID()}.json`);
  await writeFile(
    file,
    JSON.stringify({
      batchId: `test_${randomUUID()}`,
      baseRevision: await revisionOf(path),
      operations,
    }),
  );
  return run(["advanced", "apply", path, "--batch", file, ...args, "--json"]);
}
// The starter page Home has one mobile version rooted at node_home_root.
const addNodes = (path, root, nodes, parentId = "node_home_root") =>
  apply(
    path,
    root,
    nodes.map((node) => ({
      type: "add-presentation-node",
      screenId: "scr_home",
      presentationId: "pres_home_mobile",
      parentId,
      node,
    })),
  );
async function stored(path) {
  const { revision, manifest, entries } = await openPackage(path);
  return structuredClone({ revision, manifest, entries });
}
const theme = (path, action, ...args) =>
  run(["token", "theme", action, path, ...args, "--json"]);
const group = async (path, name) =>
  (await run(["token", "theme", "list", path, "--full", "--json"])).groups.find(
    (item) => item.name === name,
  );

test("CLI defaults and partial theme overrides ignore stored App selection in both layouts", async () => {
  for (const layout of ["single", "foundation-product"]) {
    const { root, path } = await workspace(layout);
    await apply(path, root, [
      {
        type: "set-active-token-themes",
        themePaths: ["Mode/Dark", "Scale/Large"],
      },
    ]);
    const before = await stored(path);
    const defaults = await run(["token", "theme", "list", path, "--json"]);
    assert.deepEqual(defaults.selection.themes, [
      "Mode/Light",
      "Scale/Regular",
    ]);
    assert.equal(defaults.appSelection, undefined);
    const appSettings = await run(["token", "theme", "list", path, "--full", "--json"]);
    assert.deepEqual(appSettings.appSelection.themes, [
      "Mode/Dark",
      "Scale/Large",
    ]);
    const partial = await run([
      "token", "theme", "list",
      path,
      "--theme",
      "Mode/Dark",
      "--json",
    ]);
    assert.deepEqual(partial.selection.themes, ["Mode/Dark", "Scale/Regular"]);
    assert.equal(
      partial.groups.find(({ name }) => name === "Mode").default,
      "Mode/Light",
    );
    assert.deepEqual(await stored(path), before);
  }
});

test("unthemed CLI defaults remain available when the App deselects all sets", async () => {
  const { path, root } = await workspace("single", []);
  const before = await stored(path);
  const library = before.entries[before.manifest.entries.tokens[0]];
  library.activeSetIds = [];
  await apply(path, root, [{ type: "replace-token-library", library }]);
  const after = await stored(path);
  assert.deepEqual(
    after.entries[after.manifest.entries.tokens[0]].activeSetIds,
    [],
  );
  const values = await run(["token", "list", path, "--json"]);
  assert.equal(values.items.length, 3);
  assert.ok(values.items.some(({ token }) => token.path === "color.brand"));
  assert.equal(values.revision, after.revision);
});

test("group rename/delete preserves default identities and rejects duplicate/reused write identities", async () => {
  const { path } = await workspace();
  await theme(path, "add", "--theme", "Brand/Default", "--batch-id", "brand-create");
  await theme(path, "add", "--theme", "Brand/Alternate");
  await theme(path, "default", "--theme", "Brand/Alternate");
  const id = (await group(path, "Brand")).default.id;
  await theme(path, "rename", "--theme", "Brand/Alternate", "--to", "Other");
  await theme(path, "rename", "--group", "Brand", "--to", "Identity");
  assert.equal((await group(path, "Identity")).default.id, id);
  await theme(path, "delete", "--theme", "Identity/Other");
  assert.equal(
    (await group(path, "Identity")).default.path,
    "Identity/Default",
  );
  const revision = await revisionOf(path);
  assert.equal(
    (
      await run(
        ["token", "theme", "delete", path, "--theme", "Identity/Default", "--json"],
        1,
      )
    ).error.code,
    "last_theme_option",
  );
  assert.equal(
    (
      await run(
        [
          "token", "theme", "add",
          path,
          "--theme",
          "Different/Default",
          "--batch-id",
          "brand-create",
          "--json",
        ],
        1,
      )
    ).error.code,
    "batch_id_conflict",
  );
  assert.equal(await revisionOf(path), revision);
});

test("a Product component view resolves its Foundation defaults and explicit values consistently", async () => {
  const { path, owner, root } = await workspace("foundation-product");
  const foundation = await openPackage(owner);
  const ownerId = foundation.manifest.packageId;
  const variant = foundation.domain.componentSets
    .get("cmp_button")
    .variants.find(({ id }) => id === "var_button_default");
  await apply(owner, root, [
    {
      type: "put-set-token",
      setId: "tset_mode_dark",
      token: {
        id: "tok_brand_dark",
        name: "color.brand",
        type: "color",
        value: "#111111",
      },
    },
    {
      type: "update-component-node",
      componentId: "cmp_button",
      variantId: "var_button_default",
      nodeId: variant.rootId,
      changes: {
        tokenBindings: {
          fill: { assetId: "tok_color_brand", packageId: ownerId },
        },
      },
    },
  ]);
  const args = [path, "--component", "Button", "--json"];
  const light = await run(["view", ...args]);
  const dark = await run(["view", ...args, "--theme", "Mode/Dark"]);
  assert.equal(
    light.tokenSources.find(({ path }) => path === "color.brand").value,
    "#6750a4",
  );
  assert.equal(
    dark.tokenSources.find(({ path }) => path === "color.brand").value,
    "#111111",
  );
  const image = await run([
    "export",
    ...args,
    "--theme",
    "Mode/Dark",
    "--format",
    "png",
  ]);
  assert.deepEqual(image.selection, dark.selection);
});

test("theme writes create real Default pairs, copy independent options, configure defaults and undo", async () => {
  const { root, path } = await workspace();
  const added = await theme(
    path,
    "add",
    "--theme",
    "Brand/Default",
    "--batch-id",
    "brand-1",
  );
  const retry = await theme(
    path,
    "add",
    "--theme",
    "Brand/Default",
    "--batch-id",
    "brand-1",
  );
  assert.equal(retry.alreadyApplied, true);
  assert.equal(retry.revision, added.revision);
  const brand = await group(path, "Brand");
  assert.equal(brand.default.path, "Brand/Default");
  const tokenSet = brand.options[0].setIds[0];
  await apply(path, root, [
    {
      type: "put-set-token",
      setId: tokenSet,
      token: {
        id: "tok_brand_surface",
        name: "brand.surface",
        type: "color",
        value: "#123456",
      },
    },
  ]);
  await theme(path, "add", "--theme", "Brand/Other");
  const snapshot = await stored(path);
  const library = snapshot.entries[snapshot.manifest.entries.tokens[0]];
  const copy = library.sets.find(({ name }) => name === "Brand/Other");
  assert.equal(copy.tokens[0].value, "#123456");
  assert.notEqual(copy.tokens[0].id, "tok_brand_surface");
  const active = library.activeThemeIds;
  const change = await theme(path, "default", "--theme", "Brand/Other");
  assert.equal((await group(path, "Brand")).default.path, "Brand/Other");
  const after = await stored(path);
  assert.deepEqual(
    after.entries[after.manifest.entries.tokens[0]].activeThemeIds,
    active,
  );
  await run(["advanced", "apply", path, "--batch", change.inverseBatchPath, "--json"]);
  assert.equal((await group(path, "Brand")).default.path, "Brand/Default");
});

test("theme renames preserve saved local Scenario choices and referenced options cannot be deleted", async () => {
  const { root, path } = await workspace();
  await theme(path, "add", "--theme", "Brand/Default");
  await theme(path, "add", "--theme", "Brand/Other");
  const scenario = (
    await run(["project", "list", path, "--kind", "scenarios", "--full", "--json"])
  ).items[0].item;
  await apply(path, root, [
    {
      type: "put-scenario",
      scenario: { ...scenario, themes: ["Brand/Other"] },
    },
  ]);
  await theme(path, "rename", "--theme", "Brand/Other", "--to", "Alternate");
  await theme(path, "rename", "--group", "Brand", "--to", "Identity");
  const saved = (await openPackage(path)).domain.scenarios.get(scenario.id);
  assert.deepEqual(saved.themes, ["Identity/Alternate"]);
  const before = await revisionOf(path);
  assert.equal(
    (
      await run(
        ["token", "theme", "delete", path, "--theme", "Identity/Alternate", "--json"],
        1,
      )
    ).error.code,
    "theme_option_in_use",
  );
  assert.equal(await revisionOf(path), before);
});

test("AI can discover technical rules and exact write examples without a Skill", async () => {
  const help = await run(["help", "rules", "--json"]);
  assert.ok(help.rules.some(({ id }) => id === "project"));
  for (const rule of help.rules) {
    const detail = await run(rule.nextOperations[0].argv);
    assert.equal(detail.id, rule.id);
    assert.ok(detail.notes.length);
  }
  const rules = await run(["help", "rules", "themes", "--json"]);
  assert.ok(
    rules.notes.some((note) =>
      note.includes("never the App's active selection"),
    ),
  );
  // Every name-based write that takes an input file points at its example.
  for (const [object, action] of [
    ["component", "define"],
    ["page", "draw"],
    ["token", "set"],
  ]) {
    const contract = await run(["schema", "command", object, action, "--json"]);
    const detail = await run(contract.nextOperations[0].argv);
    assert.equal(detail.command.split(" ").slice(0, 2).join(" "), `${object} ${action}`);
    assert.ok(detail.example);
  }
});

test("view and exported artifacts share target and themes; local wireframe and PNG are real files", async () => {
  const { root, path } = await workspace();
  await addNodes(path, root, [
    {
      id: "node_title",
      type: "TEXT",
      name: "Title",
      text: "My tasks",
      textStyle: { fontSize: 20 },
      children: [],
      width: 200,
      height: 30,
      x: 10,
      y: 10,
    },
  ]);
  const args = [
    path,
    "--page",
    "Home",
    "--element",
    "Title",
    "--theme",
    "Mode/Dark",
    "--json",
  ];
  const view = await run(["view", ...args]);
  assert.match(view.text, /My tasks/);
  assert.deepEqual(view.selection.themes, ["Mode/Dark", "Scale/Regular"]);
  for (const format of ["text", "wireframe", "png"]) {
    const exported = await run(["export", ...args, "--format", format]);
    assert.deepEqual(exported.selection, view.selection);
    const bytes = await readFile(exported.output);
    assert.equal(exported.bytes, bytes.length);
    if (format === "png") assert.equal(bytes.subarray(1, 4).toString(), "PNG");
    else assert.ok(bytes.length > 0);
  }
});

test("a selected instance expands its local wireframe and reports outline pagination in lines", async () => {
  const { root, path } = await workspace();
  const snapshot = await openPackage(path);
  const packageId = snapshot.manifest.packageId;
  const variant = structuredClone(
    snapshot.domain.componentSets
      .get("cmp_button")
      .variants.find(({ id }) => id === "var_button_default"),
  );
  variant.nodes[variant.rootId].children = ["node_label"];
  variant.nodes.node_label = {
    id: "node_label",
    type: "TEXT",
    name: "Label",
    text: "Save",
    children: [],
    width: 100,
    height: 20,
    x: 8,
    y: 8,
  };
  await apply(path, root, [
    { type: "put-variant", componentId: "cmp_button", variant },
  ]);
  await addNodes(path, root, [
    {
      id: "node_action",
      type: "INSTANCE",
      name: "Action",
      children: [],
      width: 160,
      height: 48,
      x: 10,
      y: 10,
      instance: {
        component: { assetId: "cmp_button", packageId },
        variant: {},
        overrides: {},
      },
    },
  ]);
  const target = [path, "--page", "Home", "--element", "Action"];
  const wire = await run([
    "view",
    ...target,
    "--as",
    "wireframe",
    "--full",
    "--json",
  ]);
  assert.match(wire.wireframe, /Label/);
  assert.equal(wire.page, undefined);
  const outline = await run(["view", ...target, "--json"]);
  assert.match(outline.text, /Label/);
  assert.match(outline.text, /TEXT/);
  assert.equal(outline.page.unit, "lines");
  const paged = await run([
    "view",
    ...target,
    "--full",
    "--limit",
    "1",
    "--offset",
    "1",
    "--json",
  ]);
  assert.equal(paged.page.limit, 1);
  assert.equal(paged.page.offset, 1);
  assert.equal(paged.text.split("\n").length, 1);
});

test("a local PNG preserves ancestor backgrounds and scoped contrast uses those same ancestors", async () => {
  const { root, path } = await workspace();
  await apply(path, root, [
    {
      type: "update-presentation-node",
      screenId: "scr_home",
      presentationId: "pres_home_mobile",
      nodeId: "node_home_root",
      changes: { fills: [{ type: "solid", color: "#eeeeee" }] },
    },
  ]);
  await addNodes(path, root, [
    {
      id: "node_local_text",
      type: "TEXT",
      name: "Local",
      text: "Hi",
      children: [],
      width: 100,
      height: 30,
      x: 10,
      y: 20,
      fills: [{ type: "solid", color: "#eeeeee" }],
      textStyle: { fontSize: 14 },
    },
  ]);
  const full = await run([
    "export",
    path,
    "--page",
    "Home",
    "--format",
    "png",
    "--json",
  ]);
  const fullBytes = await readFile(full.output);
  const local = await run([
    "export",
    path,
    "--page",
    "Home",
    "--element",
    "Local",
    "--format",
    "png",
    "--json",
  ]);
  const decode = (bytes) => {
    const chunks = [];
    for (let offset = 8; offset < bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      if (bytes.toString("ascii", offset + 4, offset + 8) === "IDAT")
        chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
      offset += length + 12;
    }
    return inflateSync(Buffer.concat(chunks));
  };
  const fullPixels = decode(fullBytes),
    localPixels = decode(await readFile(local.output));
  assert.equal(local.width, 100);
  assert.equal(local.height, 30);
  for (let y = 0; y < local.height; y++) {
    assert.deepEqual(
      localPixels.subarray(y * 401 + 1, (y + 1) * 401),
      fullPixels.subarray(
        (y + 20) * (full.width * 4 + 1) + 41,
        (y + 20) * (full.width * 4 + 1) + 441,
      ),
    );
  }
  assert.equal(localPixels[4], 255);
  const qa = await run([
    "validate",
    path,
    "--page",
    "Home",
    "--element",
    "Local",
    "--json",
  ]);
  assert.ok(qa.issues.some(({ code }) => code === "low_text_contrast"));
});

test("scoped validation reports visual problems and coverage without mutating selection", async () => {
  const { root, path } = await workspace();
  await addNodes(path, root, [
    {
      id: "node_bad_text",
      type: "TEXT",
      name: "Too small",
      text: "This text cannot possibly fit",
      textStyle: { fontSize: 24 },
      fills: [{ color: "#eeeeee", opacity: 1, type: "solid" }],
      children: [],
      width: 12,
      height: 8,
      x: 10,
      y: 10,
    },
    {
      id: "node_outside",
      type: "RECTANGLE",
      name: "Outside",
      children: [],
      width: 100,
      height: 100,
      x: 1000,
      y: 1000,
    },
  ]);
  const revision = await revisionOf(path);
  const report = await run([
    "validate",
    path,
    "--page",
    "Home",
    "--theme",
    "Mode/Dark",
    "--json",
  ]);
  assert.ok(report.issues.some(({ code }) => code === "text_overflow"));
  assert.ok(report.issues.some(({ code }) => code === "outside_root"));
  assert.equal(report.coverage.complete, false);
  assert.ok(report.coverage.skipped.length);
  assert.deepEqual(report.selection.themes, ["Mode/Dark", "Scale/Regular"]);
  assert.equal(await revisionOf(path), revision);
  const scoped = await run([
    "validate",
    path,
    "--page",
    "Home",
    "--element",
    "Too small",
    "--json",
  ]);
  assert.ok(scoped.issues.some(({ code }) => code === "text_overflow"));
  assert.equal(
    scoped.issues.some(({ nodeId }) => nodeId === "node_outside"),
    false,
  );
});
