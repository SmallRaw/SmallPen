import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { projectDesignView, resolveDesignView } from "@smallpen/core";
import { inspectProjection, openPackage } from "@smallpen/local-package";
import { createSemanticTree } from "@smallpen/core";
import {
  resolveDesignLayout,
  localWireframe,
  validateDesign,
  selectedDesign,
  componentLookup,
  outlineTree,
} from "../apps/cli/bin/design-output.mjs";
import {
  inspectionReport,
  inspectionText,
} from "../apps/cli/bin/inspection-output.mjs";

const fixture = new URL("fixtures/roundtrip.smallpen", import.meta.url)
  .pathname;

async function example() {
  const product = await openPackage(fixture);
  const projection = projectDesignView(product, resolveDesignView(product));
  projection.nodes[projection.rootId].children = ["row"];
  projection.nodes.row = {
    id: "row",
    name: "Actions",
    type: "FRAME",
    x: 20,
    y: 24,
    width: 400,
    height: 60,
    children: ["next", "label"],
    layout: "flex",
    "layout-flex-dir": "row",
    "layout-gap": { "column-gap": 8, "row-gap": 8 },
  };
  projection.nodes.label = {
    id: "label",
    name: "Label",
    type: "TEXT",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    children: [],
    text: "Hello world",
    growType: "auto-width",
    textStyle: {
      fontFamily: "sourcesanspro",
      fontId: "sourcesanspro",
      fontSize: 24,
      fontWeight: 400,
      lineHeight: 1.25,
    },
  };
  projection.nodes.next = {
    id: "next",
    name: "Next",
    type: "RECTANGLE",
    x: 18,
    y: 0,
    width: 20,
    height: 20,
    children: [],
    fills: [{ type: "solid", color: "#3957d7" }],
  };
  return { product, projection };
}

test("specification and PNG identify the same native layout, including measured text and siblings", async () => {
  const { product, projection } = await example();
  const before = structuredClone(projection);
  const spec = await inspectProjection(product, projection);
  const png = await inspectProjection(product, projection, { raster: true });
  assert.equal(spec.snapshot.status, "resolved");
  assert.equal(spec.snapshot.renderer, "app-wasm");
  assert.equal(spec.snapshot.id, png.snapshot.id);
  assert.deepEqual(spec.snapshot.nodes, png.snapshot.nodes);
  const label = spec.snapshot.nodes.label.bounds;
  const next = spec.snapshot.nodes.next.bounds;
  assert.ok(label.width > 100);
  assert.equal(label.height, 30);
  assert.ok(Math.abs(next.x - label.x - label.width - 8) < 0.01);
  assert.deepEqual(
    projection,
    before,
    "inspection must not rewrite seed geometry or constraints",
  );
  assert.equal(
    spec.render.bytes.length,
    0,
    "specification does not require PNG encoding",
  );
  assert.ok(png.render.bytes.length > 8);
});

test("an element PNG crops the settled bounds rather than the seed text box", async () => {
  const { product, projection } = await example();
  const result = await inspectProjection(product, projection, {
    raster: true,
    nodeId: "label",
  });
  const bounds = result.snapshot.nodes.label.bounds;
  assert.ok(bounds.width > 100);
  assert.equal(result.render.width, Math.ceil(bounds.width));
  assert.equal(result.render.height, Math.ceil(bounds.height));
  assert.deepEqual(result.snapshot.viewport, bounds);
});

test("unavailable native geometry remains unknown and cannot become a PNG made from seed bounds", async () => {
  const { product, projection } = await example();
  projection.fallbackUsed = true;
  const result = await inspectProjection(product, projection);
  assert.equal(result.snapshot.status, "partial");
  assert.equal(result.snapshot.nodes.label.bounds, null);
  assert.equal(
    result.snapshot.nodes.label.reason,
    "preview_fallback_not_renderable",
  );
  assert.equal(result.tree.root.bounds, null);
  await assert.rejects(
    inspectProjection(product, projection, { raster: true }),
    (error) => error.code === "preview_fallback_not_renderable",
  );
});

test("specification preserves authored constraints and distinguishes literal gaps from distributed space", async () => {
  const { product, projection } = await example();
  projection.nodes.row["layout-justify-content"] = "space-between";
  projection.nodes.row["layout-item-v-sizing"] = "auto";
  const workspace = { product, libraries: [] };
  const design = await resolveDesignLayout(workspace, {
    projection,
    renderProjection: projection,
    tree: createSemanticTree(product, projection),
    selection: { themes: [], context: {} },
    ancestors: [],
  });
  design.validation = await validateDesign(workspace, design);
  const report = inspectionReport(workspace, design);
  const row = report.nodes.find((node) => node.name === "Actions");
  assert.equal(row.constraints.height, "hug");
  assert.equal(row.fields.gap.kind, "literal");
  assert.equal(row.fields.gap.value, 8);
  assert.match(row.layout.spaces[0].source, /space-between/);
  assert.ok(row.layout.spaces[0].actual > 8);
  const label = report.nodes.find((node) => node.name === "Label");
  assert.equal(label.text.lines.status, "unknown");
  assert.equal(label.disabledReason.status, "unspecified");
  assert.equal(report.coverage.combinations, 1);
  assert.equal(report.coverage.otherSizesAndStates, "not checked");
  assert.match(inspectionText(report), /height=hug →/);
});

test("partial geometry stays unknown in both specification and wireframe", async () => {
  const { product, projection } = await example();
  projection.fallbackUsed = true;
  const design = await resolveDesignLayout(
    { product },
    {
      projection,
      tree: createSemanticTree(product, projection),
      selection: {},
      ancestors: [],
    },
  );
  const report = inspectionReport({ product }, design);
  assert.match(inspectionText(report), /x=\?, y=\?.*partial/);
  assert.match(outlineTree(design.tree, design.projection), /\?×\?/);
  const validation = await validateDesign({ product }, design);
  assert.equal(validation.coverage.visibleNodeCount, 4);
  assert.deepEqual(validation.coverage.checks, []);
  const wireframe = localWireframe(design);
  assert.match(wireframe, /No spatial drawing/);
  assert.doesNotMatch(wireframe, /CANVAS|viewport: 800/);
});

test("effective visibility retains the declared rule when an ancestor hides the text", async () => {
  const { product, projection } = await example();
  projection.nodes.row.visible = false;
  const design = await resolveDesignLayout(
    { product },
    {
      projection,
      tree: createSemanticTree(product, projection),
      selection: {},
      ancestors: [],
    },
  );
  const report = inspectionReport({ product }, design);
  const label = report.nodes.find((node) => node.name === "Label");
  assert.equal(label.fields.visible.value, true);
  assert.equal(label.visibility.value, false);
  assert.equal(label.visibility.reason, "hidden by ancestor");
});

test("long pages remain inspectable and a selected small element can be exported within raster limits", async () => {
  const { product, projection } = await example();
  projection.nodes[projection.rootId].height = 10000;
  const measured = await inspectProjection(product, projection);
  assert.equal(measured.snapshot.viewport.height, 10000);
  assert.equal(measured.snapshot.status, "resolved");
  const crop = await inspectProjection(product, projection, {
    raster: true,
    nodeId: "label",
  });
  assert.ok(crop.render.width < 200);
  await assert.rejects(
    inspectProjection(product, projection, { raster: true }),
    (error) => error.code === "render_size_exceeded",
  );
});

test("a component definition and its fields are attributed to the shared source rather than a page", async () => {
  const product = await openPackage(
    new URL("fixtures/variant-acme.smallpen", import.meta.url).pathname,
  );
  const workspace = { product, libraries: [] };
  const set = [...product.domain.componentSets.values()][0];
  const design = await resolveDesignLayout(
    workspace,
    selectedDesign(
      workspace,
      {},
      {
        componentId: set.id,
        variantId: set.variants[0].id,
        packageId: product.manifest.packageId,
      },
    ),
  );
  const report = inspectionReport(workspace, design, {
    components: componentLookup(workspace),
  });
  assert.equal(report.nodes[0].source.role, "definition");
  assert.equal(report.nodes[0].source.name, set.name);
  assert.ok(report.nodes.every((node) => node.source.kind === "component"));
  assert.match(inspectionText(report), /shared definition/);
});

test("an unavailable App component chain stays unknown instead of becoming a page literal with no overrides", async () => {
  const { product, projection } = await example();
  projection.nodes.label.sourceNodeId = "missing-master";
  const design = await resolveDesignLayout(
    { product },
    {
      projection,
      tree: createSemanticTree(product, projection),
      selection: {},
      ancestors: [],
    },
  );
  const report = inspectionReport({ product }, design);
  const label = report.nodes.find((node) => node.name === "Label");
  assert.equal(label.source.kind, "component");
  assert.equal(label.source.status, "partial");
  assert.equal(label.source.overridesKnown, false);
  assert.match(inspectionText(report), /source chain: partial/);
});

test("expanded text distinguishes the authored weight from the primary font face selected by the App", async () => {
  const { product, projection } = await example();
  projection.nodes.label.textStyle.fontWeight = 500;
  const design = await resolveDesignLayout(
    { product },
    {
      projection,
      tree: createSemanticTree(product, projection),
      selection: {},
      ancestors: [],
    },
  );
  const label = inspectionReport({ product }, design).nodes.find(
    (node) => node.name === "Label",
  );
  assert.equal(label.fields.fontWeight.value, 500);
  assert.ok([400, 600].includes(label.text.primaryFaces[0].weight));
  assert.equal(label.text.primaryFaces[0].family, "Source Sans Pro");
});

test("a fill container smaller than its padding never reflects its descendants", async () => {
  const { product, projection } = await example();
  projection.nodes[projection.rootId].children = ["row"];
  Object.assign(projection.nodes.row, {
    x: 0, y: 0, width: 0, height: 60,
    layout: "flex", "layout-flex-dir": "column",
    "layout-padding": { p1: 8, p2: 16, p3: 8, p4: 16 },
    "layout-item-h-sizing": "fill",
    children: ["label"],
  });
  Object.assign(projection.nodes[projection.rootId], {
    width: 390, height: 100, layout: "flex", "layout-flex-dir": "column",
  });
  Object.assign(projection.nodes.label, {
    width: 0, height: 30, "layout-item-h-sizing": "fill", growType: "auto-height",
  });
  const result = await inspectProjection(product, projection, { raster: true });
  assert.equal(result.snapshot.status, "resolved");
  assert.ok(Math.abs(result.snapshot.nodes.label.bounds.width - 358) < 0.01);
  for (const box of Object.values(result.render.layoutBoxes)) {
    assert.notEqual(box["flip-x"], true, "fill allocation must retain text direction");
    assert.notEqual(box["flip-y"], true);
  }
  assert.ok(result.render.bytes.length > 8);
});

test("native measurement ignores unrelated canonical pages and variants", async () => {
  const { product, projection } = await example();
  Object.defineProperty(product.entries, "unrelated-component.json", {
    enumerable: true,
    get() { throw new Error("unrelated component traversed while measuring one view"); },
  });
  const result = await inspectProjection(product, projection);
  assert.equal(result.snapshot.status, "resolved");
});

test("a component root retains hug sizing when its children change after authoring", async () => {
  const { componentDefineOperation } = await import("../packages/core/src/simple-design.mjs");
  const product = await openPackage(fixture);
  const { componentSet } = componentDefineOperation(product, {
    name: "Actions",
    base: { width: 326, height: "hug", layout: "column", gap: 8, children: [
      { name: "Button", width: 326, height: 36 },
      { name: "Hint", text: "Keep modified files", width: "fill", height: "hug", fontSize: 16, lineHeight: 1.25 },
    ] },
  });
  const variant = componentSet.variants[0];
  const root = variant.nodes[variant.rootId];
  assert.equal(root.height, 64, "seed size before selecting a larger control Token");
  Object.values(variant.nodes).find(node => node.name === "Button").height = 44;
  const result = await inspectProjection(product, { nodes: variant.nodes, rootId: variant.rootId, context: {} });
  assert.ok(Math.abs(result.snapshot.nodes[root.id].bounds.height - 72) < 0.01);
  assert.equal(root["layout-item-v-sizing"], "auto");
  assert.equal(root.height, 64, "measurement does not rewrite the authored seed");
});

test("nested hug layout settles despite subpixel WASM rounding", async () => {
  // Reduced from the Medium failure to 15 generic boxes and a bundled font.
  // At 0.0001px tolerance, f32 resize noise oscillates for all nine passes.
  const product = await openPackage(fixture);
  const projection = JSON.parse(await readFile(new URL("fixtures/layout-subpixel.json", import.meta.url), "utf8"));
  const result = await inspectProjection(product, projection);
  assert.equal(result.snapshot.status, "resolved");
  assert.ok(result.snapshot.nodes[projection.rootId].bounds.height > 500);
  assert.ok(result.snapshot.diagnostics.every(issue => issue.code !== "layout_not_settled"));
});

for (const hiddenAt of ["label", "row"]) {
  test(`an unavailable font under hidden ${hiddenAt} cannot block the visible view`, async () => {
    const { product, projection } = await example();
    projection.nodes[hiddenAt].visible = false;
    Object.assign(projection.nodes.label.textStyle, { fontId: "custom-unavailable", fontFamily: "Unavailable font" });
    const result = await inspectProjection(product, projection, { raster: true });
    assert.equal(result.snapshot.status, "resolved");
    assert.ok(result.render.bytes.length > 8);
    assert.equal(result.snapshot.nodes.label.visible, false);
    assert.ok(result.render.fontRequests.every(face => face.nodeId !== "label"));
    const visible = structuredClone(projection);
    visible.nodes[hiddenAt].visible = true;
    await assert.rejects(inspectProjection(product, visible, { raster: true }), error => error.code === "font_resource_unavailable");
  });
}
