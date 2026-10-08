import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { interactionIntentOperations } from "@smallpen/core";
import { openPackage } from "@smallpen/local-package";
import { createWebWorkspaceSnapshot } from "../apps/background/src/web-projection.mjs";

const cli = new URL("../apps/cli/bin/smallpen.mjs", import.meta.url).pathname;
const fixture = new URL("fixtures/variant-acme.smallpen", import.meta.url)
  .pathname;
async function run(argv, code = 0) {
  // Schema and full-value checks opt into stdout; fixed-file transport is tested separately.
  if (
    (argv[0] === "schema" || argv.includes("--full")) &&
    !argv.includes("--stdout")
  )
    argv = [...argv, "--stdout"];
  const child = spawn(process.execPath, [cli, ...argv, "--json"]);
  let out = "",
    err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  assert.equal(
    await new Promise((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    }),
    code,
    out || err,
  );
  return JSON.parse(out);
}
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "smallpen-spec-"));
  const path = join(root, "acme.smallpen");
  await cp(fixture, path, { recursive: true });
  return { root, path };
}
// Stored data, read directly; CLI reads only show names.
async function stored(path) {
  const { revision, manifest, entries, runtime } = await openPackage(path);
  return structuredClone({ revision, manifest, entries, runtime });
}
const screenOf = (snapshot, id) =>
  structuredClone(
    snapshot.manifest.entries.screens
      .map((entry) => snapshot.entries[entry])
      .find((screen) => screen.id === id),
  );
const componentOf = async (path, id) =>
  structuredClone((await openPackage(path)).domain.componentSets.get(id));
async function apply(root, path, operations, batchId = "setup") {
  const file = join(root, "batch.json");
  await writeFile(
    file,
    JSON.stringify({
      batchId,
      baseRevision: (await openPackage(path)).revision,
      operations,
    }),
  );
  return run(["advanced", "apply", path, "--batch", file]);
}
// Native Penpot interactions the name commands cannot express (overlays on
// a frame, open-url) are written as the exact operations the App would store.
async function setInteraction(root, path, nodeId, interaction, batchId) {
  const operations = interactionIntentOperations(await openPackage(path), {
    action: "set-interaction",
    screenId: "scr_home",
    nodeId,
    interaction,
  });
  return apply(root, path, operations, batchId);
}

test("component validation covers every variant unless one is named and paginates results without reducing coverage", async () => {
  const { path } = await workspace();
  const before = await stored(path);
  // The plain reply counts coverage and carries no ids.
  const brief = await run([
    "validate",
    path,
    "--component",
    "Chip",
    "--limit",
    "1",
  ]);
  assert.equal(brief.coverage.targetCount, 2);
  assert.ok(brief.issues.length <= 1);
  assert.ok(brief.coverage.targets.every((t) => t.variantId === undefined));
  // --full keeps the stored ids that show which variants were covered.
  const all = await run([
    "validate",
    path,
    "--component",
    "Chip",
    "--limit",
    "1",
    "--full",
  ]);
  assert.deepEqual(
    all.coverage.targets.map((t) => t.variantId),
    ["var_chip_neutral", "var_chip_brand"],
  );
  assert.equal(all.coverage.targetCount, 2);
  assert.ok(all.issues.length <= 1);
  assert.ok(all.issues.every((i) => i.target.componentId === "cmp_chip"));
  const oneBrief = await run([
    "validate",
    path,
    "--component",
    "Chip",
    "--variant",
    "Tone=brand",
  ]);
  assert.equal(oneBrief.coverage.targetCount, 1);
  const one = await run([
    "validate",
    path,
    "--component",
    "Chip",
    "--variant",
    "Tone=brand",
    "--full",
  ]);
  assert.equal(one.selection.variantId, "var_chip_brand");
  assert.deepEqual(
    one.coverage.targets.map((t) => t.variantId),
    ["var_chip_brand"],
  );
  assert.deepEqual(await stored(path), before);
});

test("whole-page text wireframes preserve line endings and export the decoded text", async () => {
  const { root, path } = await workspace();
  const before = await stored(path);
  const view = await run([
    "view",
    path,
    "--page",
    "Home",
    "--as",
    "wireframe",
  ]);
  assert.equal(view.textLayout.lineEnding, "LF");
  assert.equal(view.textLayout.monospace, true);
  assert.equal(view.lineCount, view.wireframe.split("\n").length);
  assert.ok(view.lineCount > 1);
  const output = join(root, "wireframe.txt");
  await run([
    "export",
    path,
    "--page",
    "Home",
    "--format",
    "wireframe",
    "--output",
    output,
  ]);
  assert.ok((await readFile(output, "utf8")).endsWith(`${view.wireframe}\n`));
  assert.deepEqual(await stored(path), before);
});

test("default exports remain text wireframes even with full output; PNG is explicitly requested", async () => {
  const { root, path } = await workspace();
  const before = await stored(path);
  const view = await run([
    "view",
    path,
    "--page",
    "Home",
    "--as",
    "wireframe",
  ]);
  for (const extra of [[], ["--full"]]) {
    const exported = await run(["export", path, "--page", "Home", ...extra]);
    assert.equal(exported.mimeType, "text/plain");
    assert.ok(
      (await readFile(exported.output, "utf8")).endsWith(`${view.wireframe}\n`),
    );
    assert.equal(exported.base64, undefined);
  }
  const png = await run([
    "export",
    path,
    "--page",
    "Home",
    "--format",
    "png",
    "--output",
    join(root, "explicit.png"),
  ]);
  assert.equal(png.mimeType, "image/png");
  assert.equal((await readFile(png.output)).subarray(1, 4).toString(), "PNG");
  assert.equal(png.base64, undefined);
  assert.deepEqual(await stored(path), before);
});

test("colors can be created, read, edited and removed by name without replacing unrelated entries", async () => {
  const { path } = await workspace();
  const colors = async () =>
    (await run(["advanced", "style", "list", path, "--kind", "colors"])).items.map(
      (item) => item.asset,
    );
  await run(["advanced", "style", "set", path, "--color", "Brand/Kept", "--value", "#abcdef"]);
  const kept = (await colors()).find((asset) => asset.name === "Kept");
  await run(["advanced", "style", "set", path, "--color", "Extra", "--value", "#123456"]);
  assert.equal(
    (await colors()).find((asset) => asset.name === "Extra").paint.color,
    "#123456",
  );
  await run(["advanced", "style", "set", path, "--color", "Extra", "--value", "#654321"]);
  const edited = await colors();
  assert.equal(edited.filter((asset) => asset.name === "Extra").length, 1);
  assert.equal(
    edited.find((asset) => asset.name === "Extra").paint.color,
    "#654321",
  );
  assert.deepEqual(
    edited.find((asset) => asset.name === "Kept"),
    kept,
  );
  await run(["advanced", "style", "delete", path, "--color", "Extra"]);
  assert.deepEqual(await colors(), [kept]);
});

test("font variants and individual typography fields can be maintained without resubmitting binary descriptors", async () => {
  const { path } = await workspace();
  const fontFile = new URL(
    "../packages/local-package/assets/fonts/SourceSansPro-Regular.ttf",
    import.meta.url,
  ).pathname;
  await run(["asset", "font", "import", path, "--file", fontFile, "--family", "Work Sans"]);
  // IDs appear only with --full; the typography must point at this font.
  const fonts = async () =>
    (await run(["asset", "font", "list", path, "--full"])).items;
  const font = (await fonts())[0].asset;
  const style = {
    fontFamily: "Work Sans",
    fontSize: 16,
    fontStyle: "normal",
    fontWeight: 400,
    letterSpacing: 0,
    lineHeight: 1.4,
    textTransform: "none",
  };
  await run([
    "advanced", "style", "set",
    path,
    "--typography",
    "Text/Body",
    "--value",
    JSON.stringify(style),
  ]);
  const typography = async () =>
    (
      await run(["advanced", "style", "list", path, "--kind", "typographies", "--full"])
    ).items[0].asset;
  const created = await typography();
  assert.equal(created.style.fontId, font.id);
  assert.deepEqual(created.style, { ...created.style, ...style });
  await run([
    "advanced", "style", "set",
    path,
    "--typography",
    "Text/Body",
    "--value",
    JSON.stringify({ fontSize: 18 }),
  ]);
  assert.deepEqual((await typography()).style, {
    ...created.style,
    fontSize: 18,
  });
  assert.deepEqual((await fonts())[0].asset, font);
  const before = await stored(path);
  assert.equal(
    (
      await run(
        ["asset", "font", "delete", path, "--font", "Work Sans", "--variant", "Missing"],
        1,
      )
    ).error.code,
    "missing_font_variant",
  );
  assert.deepEqual(await stored(path), before);
  await run(["advanced", "style", "delete", path, "--typography", "Text/Body"]);
  await run([
    "asset", "font", "delete",
    path,
    "--font",
    "Work Sans",
    "--variant",
    font.variants[0].name,
  ]);
  assert.equal((await run(["asset", "font", "list", path])).page.total, 0);
  assert.equal(
    (await run(["advanced", "style", "list", path, "--kind", "typographies"])).page.total,
    0,
  );
});

test("AI configures prototype starts and links by name and reads connections without saving state", async () => {
  const { root, path } = await workspace();
  await apply(
    root,
    path,
    [
      {
        type: "put-screen",
        screen: {
          id: "scr_detail",
          name: "Detail",
          basePresentationId: "pres_detail",
          counterparts: [],
          presentations: [
            {
              id: "pres_detail",
              name: "Base",
              platform: "mobile",
              viewport: { width: 390, height: 844 },
              rootId: "node_detail_root",
              interactions: [],
              nodes: {
                node_detail_root: {
                  id: "node_detail_root",
                  name: "Detail",
                  type: "FRAME",
                  x: 0,
                  y: 0,
                  width: 390,
                  height: 844,
                  children: ["node_back"],
                },
                node_back: {
                  id: "node_back",
                  name: "Back",
                  type: "RECTANGLE",
                  x: 12,
                  y: 12,
                  width: 48,
                  height: 32,
                  children: [],
                },
              },
            },
          ],
        },
      },
    ],
    "detail",
  );
  await run(["flow", "start", path, "--page", "Home"]);
  const connect = [
    "flow",
    "link",
    path,
    "--from",
    "Home / Button one",
    "--to",
    "Detail",
    "--on",
    "click",
    "--batch-id",
    "connect",
  ];
  const linked = await run(connect);
  const retry = await run(connect);
  assert.equal(retry.alreadyApplied, true);
  assert.equal(retry.revision, linked.revision);
  await run([
    "flow",
    "link",
    path,
    "--from",
    "Detail / Back",
    "--action",
    "back",
  ]);
  const before = await stored(path);
  const flows = await run(["flow", "list", path, "--full"]);
  assert.deepEqual(flows.starts.map((s) => s.page), ["Home"]);
  assert.deepEqual(flows.links, [
    {
      page: "Home",
      platform: "mobile",
      element: "Button one",
      on: "click",
      action: "navigate",
      to: "Detail",
    },
    {
      page: "Detail",
      platform: "mobile",
      element: "Back",
      on: "click",
      action: "back",
    },
  ]);
  const native = screenOf(before, "scr_home").presentations[0].nodes
    .node_button_one.interactions;
  assert.equal(native.length, 1);
  assert.equal(native[0]["event-type"], "click");
  assert.equal(native[0]["action-type"], "navigate");
  assert.deepEqual(await stored(path), before);
  const missing = await run(
    ["flow", "link", path, "--from", "Home / Button one", "--to", "Missing"],
    1,
  );
  assert.equal(missing.error.code, "unknown_page");
  assert.deepEqual(await stored(path), before);
});

test("native overlay, press release, hover, delay and external URL semantics survive App projection", async () => {
  const { root, path } = await workspace();
  const screen = screenOf(await stored(path), "scr_home"),
    presentation = screen.presentations[0];
  presentation.rootIds = [presentation.rootId, "node_overlay"];
  presentation.nodes.node_overlay = {
    id: "node_overlay",
    name: "Overlay",
    type: "FRAME",
    x: 450,
    y: 0,
    width: 180,
    height: 120,
    children: ["node_close"],
  };
  presentation.nodes.node_close = {
    id: "node_close",
    name: "Close",
    type: "RECTANGLE",
    x: 8,
    y: 8,
    width: 32,
    height: 24,
    children: [],
  };
  presentation.nodes.node_button_two = {
    id: "node_button_two",
    name: "Hover",
    type: "RECTANGLE",
    x: 12,
    y: 300,
    width: 100,
    height: 32,
    children: [],
  };
  presentation.nodes[presentation.rootId].children.push("node_button_two");
  await apply(root, path, [{ type: "put-screen", screen }]);
  const overlay = { screenId: "scr_home", nodeId: "node_overlay" };
  await setInteraction(root, path, "node_button_one", {
    "event-type": "mouse-press",
    "action-type": "open-overlay",
    destination: overlay,
    animation: { "animation-type": "dissolve", duration: 200, easing: "ease" },
  }, "press");
  await setInteraction(root, path, "node_button_two", {
    "event-type": "mouse-over",
    "action-type": "toggle-overlay",
    destination: overlay,
  }, "hover");
  await setInteraction(root, path, "node_close", {
    "event-type": "click",
    "action-type": "close-overlay",
  }, "close");
  await setInteraction(root, path, "node_home_root", {
    "event-type": "after-delay",
    "action-type": "open-url",
    url: "https://example.com/help",
    delay: 900,
  }, "delay");
  const before = await stored(path);
  const projected = await createWebWorkspaceSnapshot(await openPackage(path));
  const entry = projected.manifest.entries.screens.find(
    (entry) => projected.entries[entry].id === "scr_home",
  );
  const nodes = projected.entries[entry].presentations[0].nodes;
  const press = nodes.node_button_one.interactions[0];
  assert.equal(
    press.destination,
    before.runtime.nodes.scr_home[presentation.id].node_overlay,
  );
  assert.equal(press["event-type"], "mouse-press");
  assert.equal(press["action-type"], "open-overlay");
  assert.equal(press.animation.duration, 200);
  const hover = nodes.node_button_two.interactions[0];
  assert.equal(hover["event-type"], "mouse-over");
  assert.equal(hover["action-type"], "toggle-overlay");
  assert.equal(nodes.node_close.interactions[0]["action-type"], "close-overlay");
  const delay = nodes.node_home_root.interactions[0];
  assert.equal(delay["event-type"], "after-delay");
  assert.equal(delay.delay, 900);
  assert.equal(delay.url, "https://example.com/help");
  assert.deepEqual(await stored(path), before);
  await run(["flow", "unlink", path, "--from", "Home / Hover"]);
  assert.deepEqual(
    screenOf(await stored(path), "scr_home").presentations[0].nodes
      .node_button_two.interactions ?? [],
    [],
  );
  assert.ok(
    !(await run(["flow", "list", path, "--full"])).links.some(
      (link) => link.element === "Hover",
    ),
  );
});

test("a page checks every version and layout gaps are never silently approved", async () => {
  const { root, path } = await workspace();
  const screen = screenOf(await stored(path), "scr_home"),
    alternate = structuredClone(screen.presentations[0]);
  alternate.id = "pres_wide";
  alternate.name = "tablet";
  alternate.platform = "tablet";
  alternate.viewport = { width: 768, height: 1024 };
  alternate.nodes.node_home_root.layout = "grid";
  screen.presentations.push(alternate);
  const base = screen.presentations[0];
  base.nodes.node_unrelated_grid = {
    id: "node_unrelated_grid",
    name: "Other region",
    type: "FRAME",
    x: 12,
    y: 500,
    width: 100,
    height: 100,
    children: [],
    layout: "grid",
  };
  base.nodes[base.rootId].children.push("node_unrelated_grid");
  await apply(root, path, [{ type: "put-screen", screen }]);
  const before = await stored(path);
  const brief = await run(["validate", path, "--page", "Home"]);
  assert.equal(brief.coverage.targetCount, 2, "both versions are checked");
  // Sizes the preview cannot compute read as one note.
  assert.match(brief.previewNote, /cannot compute some automatic sizes/);
  const report = await run(["validate", path, "--page", "Home", "--full"]);
  assert.deepEqual(
    report.coverage.targets.map((t) => t.presentationId),
    [screen.basePresentationId, "pres_wide"],
  );
  assert.ok(
    report.coverage.skipped.some(
      (item) => item.code === "layout_projection_partial",
    ),
  );
  const view = await run([
    "view",
    path,
    "--page",
    "Home",
    "--platform",
    "tablet",
    "--full",
  ]);
  assert.equal(view.selection.presentationId, "pres_wide");
  assert.ok(
    view.diagnostics.some((item) => item.code === "layout_projection_partial"),
  );
  const local = await run([
    "validate",
    path,
    "--page",
    "Home",
    "--element",
    "Button one",
    "--full",
  ]);
  assert.equal(local.selection.nodeId, "node_button_one");
  assert.ok(
    !local.issues.some((issue) => issue.nodeId === "node_unrelated_grid"),
  );
  assert.ok(
    !local.coverage.skipped.some(
      (skip) => skip.nodeId === "node_unrelated_grid",
    ),
  );
  const png = await run([
    "export",
    path,
    "--page",
    "Home",
    "--element",
    "Button one",
    "--output",
    join(root, "local.png"),
    "--format",
    "png",
  ]);
  // Diagnostics name elements; the unrelated region is never among them.
  assert.ok(
    !png.diagnostics.some((issue) =>
      /Other region|node_unrelated_grid/.test(JSON.stringify(issue)),
    ),
  );
  assert.deepEqual(await stored(path), before);
});

test("reverse edits are new guarded writes and never overwrite later changes", async () => {
  const { root, path } = await workspace();
  const write = await run([
    "component",
    "rename",
    path,
    "--component",
    "Chip",
    "--to",
    "New",
    "--inverse-out",
    join(root, "retained-undo.json"),
  ]);
  assert.deepEqual(write.undo.argv.slice(0, 4), ["advanced", "apply", path, "--batch"]);
  assert.equal(write.baseRevision, undefined);
  const report = JSON.parse(await readFile(write.changeReportPath, "utf8"));
  assert.ok(report.entries.length);
  await run([
    "component",
    "rename",
    path,
    "--component",
    "Badge",
    "--to",
    "Later",
  ]);
  const before = await stored(path);
  assert.equal(
    (await run(["advanced", "apply", path, "--batch", write.inverseBatchPath], 1)).error
      .code,
    "stale_revision",
  );
  assert.deepEqual(await stored(path), before);
  await run([
    "component",
    "rename",
    path,
    "--component",
    "New",
    "--to",
    "Chip",
  ]);
  assert.equal((await componentOf(path, "cmp_chip")).name, "Chip");
  assert.equal((await componentOf(path, "cmp_badge")).name, "Later");
});

test("component metadata edits preserve stored definitions and artifact failure offers an idempotent retry", async () => {
  const { root, path } = await workspace();
  const before = await componentOf(path, "cmp_chip");
  const blocked = join(root, "not-a-directory");
  await writeFile(blocked, "file");
  const changed = await run([
    "component",
    "rename",
    path,
    "--component",
    "Chip",
    "--to",
    "Renamed",
    "--inverse-out",
    join(blocked, "reverse.json"),
  ]);
  const after = await componentOf(path, "cmp_chip");
  // A rename names the component and each variant's main root, as the App
  // does; every other stored field stays as it was.
  const expected = { ...structuredClone(before), name: "Renamed" };
  for (const variant of expected.variants)
    variant.nodes[variant.rootId].name = "Renamed";
  assert.deepEqual(after, expected);
  assert.equal(changed.changed, true);
  assert.equal(changed.undoError.code, "inverse_output_failed");
  assert.ok(
    changed.undoError.nextOperations?.length,
    `undoError offers no retry: ${JSON.stringify(changed.undoError)}`,
  );
  const retry = await run(
    changed.undoError.nextOperations[0].argv.filter((arg) => arg !== "--json"),
  );
  assert.equal(retry.alreadyApplied, true);
  assert.equal(retry.revision, changed.revision);
  assert.ok(retry.inverseBatch);
  assert.deepEqual(await componentOf(path, "cmp_chip"), after);
});

test("raw writes cannot introduce unsupported prototype conditions or destroy a connected target", async () => {
  const { root, path } = await workspace();
  const before = await stored(path);
  const file = join(root, "bad-prototype.json");
  await writeFile(
    file,
    JSON.stringify({
      batchId: "condition",
      baseRevision: before.revision,
      operations: [
        {
          type: "put-interaction",
          screenId: "scr_home",
          presentationId: "pres_home_mobile",
          interaction: {
            id: "int_conditional",
            name: "Conditional",
            sourceNodeId: "node_button_one",
            trigger: "activate",
            condition: {
              stateKey: "platform",
              operator: "equals",
              value: "mobile",
            },
            action: {
              type: "navigate",
              screen: { packageId: "pkg_acme", assetId: "scr_home" },
              presentationId: "pres_home_mobile",
            },
          },
        },
      ],
    }),
  );
  const failed = await run(["advanced", "apply", path, "--batch", file], 1);
  assert.equal(failed.error.code, "invalid_prototype_connection");
  assert.equal(
    failed.error.details.issues[0].code,
    "unsupported_interaction_condition",
  );
  assert.deepEqual(await stored(path), before);
  const other = screenOf(before, "scr_home");
  other.id = "scr_other";
  other.name = "Other";
  await apply(root, path, [{ type: "put-screen", screen: other }], "other");
  await run([
    "flow",
    "link",
    path,
    "--from",
    "Home / Button one",
    "--to",
    "Other",
  ]);
  const state = await stored(path);
  await writeFile(
    file,
    JSON.stringify({
      batchId: "delete-target",
      baseRevision: state.revision,
      operations: [{ type: "delete-screen", screenId: "scr_other" }],
    }),
  );
  assert.equal(
    (await run(["advanced", "apply", path, "--batch", file], 1)).error.code,
    "invalid_prototype_connection",
  );
  assert.deepEqual(await stored(path), state);
});
