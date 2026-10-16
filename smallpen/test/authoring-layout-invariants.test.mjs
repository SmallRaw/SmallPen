import assert from "node:assert/strict";
import test from "node:test";
import { openPackage, inspectProjection } from "@smallpen/local-package";
import { prepareOperationBatch, projectScreen, projectComponentVariant } from "@smallpen/core";
import { componentDefineOperation, componentSetOperation, pageDrawOperation, pageSetOperation } from "../packages/core/src/simple-design.mjs";
import { tokenSetOperations } from "../packages/core/src/simple-authoring.mjs";

const fixture = new URL("fixtures/roundtrip.smallpen", import.meta.url).pathname;
const apply = async (snapshot, ...operations) => (await prepareOperationBatch(snapshot, {
  baseRevision: snapshot.revision, batchId: "layout-invariants", operations,
})).snapshot;
async function example() {
  let snapshot = await openPackage(fixture);
  snapshot = await apply(snapshot, componentDefineOperation(snapshot, {
    name: "Card", base: { width: 80, height: "hug", layout: "column", children: [{ name: "Body", width: 80, height: 24 }] },
  }));
  snapshot = await apply(snapshot, pageDrawOperation(snapshot, {
    page: "Sizing", width: 300, height: 160, layout: "column",
    children: [{ name: "Copy", use: "Card", width: 100, height: 40 }],
  }));
  return snapshot;
}
const screenOf = snapshot => snapshot.manifest.entries.screens.map(entry => snapshot.entries[entry]).find(screen => screen.name === "Sizing");

for (const width of ["fill", "hug", "120px"]) {
  test(`editing a copy accepts the same ${width} sizing as drawing it`, async () => {
    let snapshot = await example();
    snapshot = await apply(snapshot, pageSetOperation(snapshot, { page: "Sizing", element: "Copy", set: { width, height: "hug" } }));
    const screen = screenOf(snapshot), node = Object.values(screen.presentations[0].nodes).find(node => node.name === "Copy");
    assert.equal(node["layout-item-h-sizing"], width === "fill" ? "fill" : width === "hug" ? "auto" : "fix");
    assert.equal(node["layout-item-v-sizing"], "auto");
    const actual = await inspectProjection(snapshot, projectScreen(snapshot, screen.id, {}));
    assert.equal(actual.snapshot.status, "resolved");
    assert.ok(Math.abs(actual.snapshot.nodes[node.id].bounds.width - (width === "fill" ? 300 : width === "hug" ? 80 : 120)) < 0.01);
  });
}

test("changing a hugging component root to a fixed height changes its actual height", async () => {
  let snapshot = await example();
  snapshot = await apply(snapshot, componentSetOperation(snapshot, { component: "Card", set: { height: 100 } }));
  const variant = [...snapshot.domain.componentSets.values()].find(set => set.name === "Card").variants[0];
  const result = await inspectProjection(snapshot, { nodes: projectComponentVariant(snapshot, variant), rootId: variant.rootId });
  assert.equal(result.snapshot.nodes[variant.rootId].bounds.height, 100);
});

test("a freely positioned container keeps its authored hug constraints", async () => {
  let snapshot = await openPackage(fixture);
  snapshot = await apply(snapshot, pageDrawOperation(snapshot, { page: "Sizing", width: 300, height: 160, layout: "none", children: [
    { name: "Group", layout: "column", width: 100, height: "hug", children: [{ name: "Body", width: 100, height: 24 }] },
  ] }));
  snapshot = await apply(snapshot, pageSetOperation(snapshot, { page: "Sizing", element: "Body", set: { height: 60 } }));
  const screen = screenOf(snapshot), nodes = screen.presentations[0].nodes;
  const group = Object.values(nodes).find(node => node.name === "Group");
  const result = await inspectProjection(snapshot, projectScreen(snapshot, screen.id, {}));
  assert.equal(result.snapshot.nodes[group.id].bounds.height, 60);
});

test("a literal dimension edit detaches the old Token binding", async () => {
  let snapshot = await example();
  snapshot = await apply(snapshot, ...tokenSetOperations(snapshot, { tokens: [{ name: "size.box", type: "sizing", value: 40 }] }, () => "tok_box"));
  const screen = screenOf(snapshot), presentation = screen.presentations[0];
  snapshot = await apply(snapshot, { type: "set-token-binding", screenId: screen.id, presentationId: presentation.id, nodeId: presentation.rootId, field: "width", binding: { packageId: snapshot.manifest.packageId, assetId: "tok_box" } });
  snapshot = await apply(snapshot, pageSetOperation(snapshot, { page: "Sizing", set: { width: 360 } }));
  assert.equal(projectScreen(snapshot, screen.id, {}).nodes[presentation.rootId].width, 360);
});


test("a page root retains hug height when its children grow", async () => {
  let snapshot = await openPackage(fixture);
  snapshot = await apply(snapshot, pageDrawOperation(snapshot, { page: "Sizing", width: 300, height: "hug", layout: "column", children: [{ name: "Body", width: 100, height: 24 }] }));
  snapshot = await apply(snapshot, pageSetOperation(snapshot, { page: "Sizing", element: "Body", set: { height: 60 } }));
  const screen = screenOf(snapshot), presentation = screen.presentations[0];
  const result = await inspectProjection(snapshot, projectScreen(snapshot, screen.id, {}));
  assert.ok(Math.abs(result.snapshot.nodes[presentation.rootId].bounds.height - 60) < 0.01);
  assert.equal(presentation.nodes[presentation.rootId]["layout-item-v-sizing"], "auto");
});

test("a direct copy size edit replaces its prior root override and Token binding", async () => {
  let snapshot = await example();
  snapshot = await apply(snapshot, ...tokenSetOperations(snapshot, { tokens: [{ name: "size.box", type: "sizing", value: 40 }] }, () => "tok_box"));
  snapshot = await apply(snapshot, pageSetOperation(snapshot, { page: "Sizing", element: "Copy", set: { set: { width: "{size.box}", height: 50 } } }));
  snapshot = await apply(snapshot, pageSetOperation(snapshot, { page: "Sizing", element: "Copy", set: { width: 180 } }));
  const screen = screenOf(snapshot), projected = projectScreen(snapshot, screen.id, {});
  const node = Object.values(projected.nodes).find(node => node.name === "Copy");
  assert.equal(node.width, 180);
  assert.equal(node.height, 50, "an unrelated root override survives");
  assert.equal(node.tokenBindings?.width, undefined);
});

for (const use of [undefined, "Card"]) {
  test(`dimension Tokens work in draw and set for ${use ? "copies" : "containers"}`, async () => {
    let snapshot = await example();
    snapshot = await apply(snapshot, ...tokenSetOperations(snapshot, { tokens: [{ name: "size.box", type: "sizing", value: 40 }] }, () => "tok_box"));
    snapshot = await apply(snapshot, pageDrawOperation(snapshot, { page: "Bound", width: 300, height: 160, children: [
      { name: "Box", ...(use ? { use } : { layout: "column" }), width: "{size.box}", height: 24 },
    ] }));
    snapshot = await apply(snapshot, pageSetOperation(snapshot, { page: "Bound", element: "Box", set: { width: 180 } }));
    snapshot = await apply(snapshot, pageSetOperation(snapshot, { page: "Bound", element: "Box", set: { width: "{size.box}" } }));
    const screen = snapshot.manifest.entries.screens.map(entry => snapshot.entries[entry]).find(screen => screen.name === "Bound");
    const box = Object.values(projectScreen(snapshot, screen.id, {}).nodes).find(node => node.name === "Box");
    assert.equal(box.width, 40);
    assert.equal(box.tokenBindings.width.assetId, "tok_box");
  });
}
