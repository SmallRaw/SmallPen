import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { OPERATION_SCHEMAS } from "@smallpen/core";

import { INIT_ANSWERS_EXAMPLE } from "../apps/cli/bin/schema.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "apps", "cli", "bin", "smallpen.mjs");

function runCli(args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "", LC_MESSAGES: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      let json;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = undefined;
      }
      resolve({ code, json, stdout });
    });
  });
}

async function initAcme(context) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smallpen-cli-polish-")));
  context.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(join(root, "answers.json"), JSON.stringify(INIT_ANSWERS_EXAMPLE));
  const init = await runCli(
    ["init", "acme", "--answers", "answers.json", "--confirm", "--json"],
    root,
  );
  assert.equal(init.code, 0, init.stdout);
  return {
    foundation: join(root, "acme", "acme-foundation.smallpen"),
    init: init.json,
    product: join(root, "acme", "acme.smallpen"),
    root,
  };
}

async function revisionOf(path, root) {
  return (await runCli(["inspect", path, "--json"], root)).json.package.revision;
}

async function writeJson(root, name, value) {
  const path = join(root, name);
  await writeFile(path, JSON.stringify(value));
  return path;
}

async function addButton({ foundation, root }) {
  const batch = await writeJson(root, "button.json", {
    baseRevision: await revisionOf(foundation, root),
    batchId: "button-v1",
    operations: [OPERATION_SCHEMAS["put-component-set"].example],
  });
  const applied = await runCli(["apply", foundation, "--batch", batch, "--json"], root);
  assert.equal(applied.code, 0, applied.stdout);
}

function buttonInstance(extra = {}) {
  return {
    children: [],
    height: 48,
    id: "node_add_button",
    instance: {
      component: { assetId: "cmp_button", packageId: "pkg_acme_foundation" },
      variant: { axis_style: "primary" },
    },
    name: "Add button",
    type: "INSTANCE",
    width: 328,
    x: 16,
    y: 576,
    ...extra,
  };
}

test("init returns package, screen, root, and seeded ids", async (context) => {
  const { foundation, init, product } = await initAcme(context);
  assert.equal(init.packages.foundation.packageId, "pkg_acme_foundation");
  assert.equal(init.packages.foundation.path, foundation);
  assert.equal(init.packages.product.packageId, "pkg_acme_product");
  assert.equal(init.packages.product.path, product);
  assert.equal(init.packages.product.revision, await revisionOf(product));
  assert.equal(init.start.screenId, "scr_home");
  assert.equal(init.start.presentationId, "pres_home_mobile");
  assert.equal(init.start.rootNode.id, "node_home_root");
  assert.deepEqual(init.start.contextAxes.map(({ id }) => id), ["axis_platform", "axis_theme"]);
  assert.deepEqual(
    init.seeded.tokens.map(({ path, tokenId }) => [tokenId, path]).sort(),
    [
      ["tok_color_brand", "color.brand"],
      ["tok_radius_md", "radius.md"],
      ["tok_spacing_md", "spacing.md"],
    ],
  );
  assert.deepEqual(init.seeded.componentSets.map(({ componentSetId, variants }) => [
    componentSetId,
    variants.map(({ variantId }) => variantId),
  ]), [["cmp_button", ["var_button_default"]]]);
  assert.match(init.seeded.note, /replaces it whole/);
});

test("help and schema say put-* replaces seeded ids and token targets the Foundation", async () => {
  const tokenHelp = (await runCli(["token", "--help"])).stdout;
  assert.match(tokenHelp, /smallpen token <package\.smallpen>/);
  assert.doesNotMatch(tokenHelp, /smallpen token <product\.smallpen>/);
  assert.match(tokenHelp, /Pass the Foundation/);
  assert.match(tokenHelp, /replaces that Token whole/);
  assert.match(tokenHelp, /tok_color_brand/);
  const initHelp = (await runCli(["init", "--help"])).stdout;
  assert.match(initHelp, /Seeded content/);
  assert.match(initHelp, /cmp_button/);
  assert.match(initHelp, /tok_color_brand/);
  const putToken = (await runCli(["schema", "operation", "put-token"])).json;
  assert.match(putToken.existingId, /replaced whole/);
  assert.match(putToken.existingId, /tok_color_brand/);
  const putSet = (await runCli(["schema", "operation", "put-component-set"])).json;
  assert.match(putSet.existingId, /cmp_button/);
  const pageHelp = (await runCli(["page", "--help"])).stdout;
  assert.match(pageHelp, /"overrides":\{"node_button_label:text":"Add task"\}/);
  for (const command of ["apply", "page", "flow", "token"]) {
    assert.match((await runCli([command, "--help"])).stdout, /--compact\] \[--inverse-out FILE\]/);
  }
});

test("width/height advice is listed only near a sizing Token", async (context) => {
  const { foundation, product, root } = await initAcme(context);
  const card = (id, height) => ({
    children: [],
    fills: [{ color: "#6750a4", type: "solid" }],
    height,
    id,
    name: id,
    type: "RECTANGLE",
    width: 300,
    x: 0,
    y: 0,
  });
  const first = await runCli([
    "page", product, "--intent",
    await writeJson(root, "cards.json", { nodes: [card("node_a", 47), card("node_b", 120)], screenId: "scr_home" }),
    "--dry-run", "--json",
  ], root);
  assert.equal(first.code, 0, first.stdout);
  assert.equal(first.json.warnings.some(({ field }) => field === "width" || field === "height"), false);
  assert.deepEqual(first.json.warningSummary.suppressed.fields, { height: 2, width: 2 });
  assert.match(first.json.warningSummary.note, /validate does not repeat/);

  const sizing = await runCli([
    "token", foundation, "--intent",
    await writeJson(root, "sizing.json", {
      operations: [{
        definition: {
          $extensions: { smallpen: { id: "tok_size_control" } },
          $type: "sizing",
          $value: 48,
        },
        filePath: "tokens/foundation.json",
        path: "size.control",
        tokenId: "tok_size_control",
        type: "put-token",
      }],
    }),
    "--json",
  ], root);
  assert.equal(sizing.code, 0, sizing.stdout);
  const second = await runCli([
    "page", product, "--intent", join(root, "cards.json"), "--dry-run",
    "--warning-detail", "full", "--json",
  ], root);
  const heights = second.json.warnings.filter(({ field }) => field === "height");
  assert.deepEqual(heights.map(({ nodeId }) => nodeId), ["node_a"]);
  assert.equal(heights[0].suggestions[0].reference.assetId, "tok_size_control");
  assert.deepEqual(second.json.warningSummary.suppressed.fields, { height: 1, width: 2 });
  const validated = await runCli(["validate", product, "--json"], root);
  assert.deepEqual(validated.json.warnings, []);
});

test("tokens labels follow the environment locale and --locale", async (context) => {
  const { product, root } = await initAcme(context);
  const english = await runCli(["tokens", product, "--json"], root, { LANG: "en_US.UTF-8" });
  assert.deepEqual(english.json.labels, { context: "Design Context", items: "Effective Tokens" });
  assert.doesNotMatch(english.stdout, /[一-鿿]/);
  const chinese = await runCli(["tokens", product, "--json"], root, { LANG: "zh_CN.UTF-8" });
  assert.deepEqual(chinese.json.labels, { context: "設計狀態", items: "有效設計變數" });
  const overridden = await runCli(["tokens", product, "--locale", "en", "--json"], root, {
    LANG: "zh_CN.UTF-8",
  });
  assert.equal(overridden.json.labels.context, "Design Context");
  for (const command of ["discover", "read-view"]) {
    const read = await runCli([command, product, "--json"], root, { LANG: "en_US.UTF-8" });
    assert.equal(read.code, 0, read.stdout);
    assert.doesNotMatch(read.stdout, /[一-鿿]/, command);
  }
});

test("page intent overrides compile to checked set-instance-override operations", async (context) => {
  const workspace = await initAcme(context);
  const { product, root } = workspace;
  await addButton(workspace);
  const before = await revisionOf(product, root);
  const bad = await runCli([
    "page", product, "--intent",
    await writeJson(root, "bad.json", {
      nodes: [buttonInstance({ overrides: { "node_missing:text": "Add task" } })],
      screenId: "scr_home",
    }),
    "--json",
  ], root);
  assert.equal(bad.code, 1);
  assert.equal(bad.json.error.code, "missing_component_override_target");
  assert.equal(await revisionOf(product, root), before);
  const misplaced = await runCli([
    "page", product, "--intent",
    await writeJson(root, "misplaced.json", {
      nodes: [{ children: [], height: 10, id: "node_x", name: "X", overrides: {}, type: "RECTANGLE", width: 10, x: 0, y: 0 }],
      screenId: "scr_home",
    }),
    "--json",
  ], root);
  assert.equal(misplaced.json.error.code, "invalid_flow_intent");

  const good = await runCli([
    "page", product, "--intent",
    await writeJson(root, "good.json", {
      nodes: [buttonInstance({ overrides: { "node_button_label:text": "Add task" } })],
      screenId: "scr_home",
    }),
    "--json",
  ], root);
  assert.equal(good.code, 0, good.stdout);
  assert.equal(good.json.inverseBatch.operations[0].type, "clear-instance-override");
  const snapshot = (await runCli(["read", product, "--json"], root)).json;
  const node = snapshot.entries["screens/first-design.json"].presentations[0].nodes.node_add_button;
  assert.deepEqual(node.instance.overrides, { "node_button_label:text": "Add task" });
  assert.equal(Object.hasOwn(node, "overrides"), false);
});

test("--compact drops the inverse batch and --inverse-out keeps undo", async (context) => {
  const { foundation, root } = await initAcme(context);
  const intent = await writeJson(root, "tokens.json", {
    operations: [OPERATION_SCHEMAS["put-token"].example],
  });
  const before = await revisionOf(foundation, root);
  const full = await runCli(["token", foundation, "--intent", intent, "--dry-run", "--json"], root);
  assert.ok(full.json.inverseBatch, "default reply keeps inverseBatch");
  assert.ok(full.json.guidance.undo);

  const undoPath = join(root, "undo.json");
  const compact = await runCli([
    "token", foundation, "--intent", intent, "--compact", "--inverse-out", undoPath, "--json",
  ], root);
  assert.equal(compact.code, 0, compact.stdout);
  assert.equal(compact.json.inverseBatch, undefined);
  assert.equal(compact.json.guidance, undefined);
  assert.equal(compact.json.inverseBatchPath, undoPath);
  assert.equal(compact.json.inverseOperationCount, 1);
  assert.match(compact.json.summary, /^Applied token_.*1 changed file\(s\)/);
  assert.ok(compact.stdout.length < full.stdout.length / 2);

  const undo = await runCli(["apply", foundation, "--batch", undoPath, "--compact", "--json"], root);
  assert.equal(undo.code, 0, undo.stdout);
  assert.equal(undo.json.revision, before);
  assert.match(undo.json.summary, /--inverse-out FILE/);
  assert.deepEqual(JSON.parse(await readFile(undoPath, "utf8")).baseRevision, compact.json.revision);
});

test("a font fallback names the available fonts and the import-font command", async (context) => {
  const { product, root } = await initAcme(context);
  const text = (id, y) => ({
    children: [],
    height: 24,
    id,
    name: id,
    text: "Hello",
    textStyle: { fontFamily: "Inter", fontSize: 16 },
    type: "TEXT",
    width: 200,
    x: 0,
    y,
  });
  const page = await runCli([
    "page", product, "--intent",
    await writeJson(root, "text.json", { nodes: [text("node_t1", 0), text("node_t2", 40)], screenId: "scr_home" }),
    "--json",
  ], root);
  assert.equal(page.code, 0, page.stdout);
  const rendered = await runCli(["render", product, "--output", join(root, "r.png"), "--json"], root);
  assert.equal(rendered.code, 0, rendered.stdout);
  const fallbacks = rendered.json.diagnostics.filter(({ code }) => code === "font_render_fallback");
  assert.equal(fallbacks.length, 1);
  assert.equal(fallbacks[0].requestedFont, "Inter");
  assert.deepEqual(fallbacks[0].nodeIds, ["node_t1", "node_t2"]);
  assert.deepEqual(fallbacks[0].availableFonts, ["Source Sans Pro (bundled)"]);
  assert.deepEqual(fallbacks[0].details, { requestedFont: "Inter", substituteFont: "Source Sans Pro" });
  assert.match(fallbacks[0].message, /import-font/);
  assert.deepEqual(fallbacks[0].nextOperations[0].argv.slice(0, 2), ["import-font", product]);
});

test("apply checks override paths against Foundation components", async (context) => {
  const workspace = await initAcme(context);
  const { product, root } = workspace;
  await addButton(workspace);
  const placed = await runCli([
    "page", product, "--intent",
    await writeJson(root, "instance.json", { nodes: [buttonInstance()], screenId: "scr_home" }),
    "--json",
  ], root);
  assert.equal(placed.code, 0, placed.stdout);
  const before = await revisionOf(product, root);
  const override = (overridePath) => writeJson(root, `override-${overridePath.length}.json`, {
    baseRevision: before,
    batchId: `override-${overridePath.length}`,
    operations: [{
      nodeId: "node_add_button",
      overridePath,
      screenId: "scr_home",
      type: "set-instance-override",
      value: "Add task",
    }],
  });
  const misspelled = await runCli([
    "apply", product, "--batch", await override("node_buton_label:text"), "--json",
  ], root);
  assert.equal(misspelled.code, 1, misspelled.stdout);
  assert.equal(misspelled.json.error.code, "missing_component_override_target");
  assert.equal(await revisionOf(product, root), before);
  const correct = await runCli([
    "apply", product, "--batch", await override("node_button_label:text"), "--json",
  ], root);
  assert.equal(correct.code, 0, correct.stdout);
});
