import assert from "node:assert/strict";
import test from "node:test";
import { loadPackageFromValues, prepareOperationBatch } from "@smallpen/core";
import { compilePenpotChanges } from "@smallpen/penpot-adapter";
import { buildEditorPackageValues } from "./fixtures/design-system-editor-fixture.mjs";

const load = (values = buildEditorPackageValues()) => loadPackageFromValues("memory://samples.smallpen", values);
const samples = (snapshot) => snapshot.runtime.designSystemRefs.componentSamples;
function edit(snapshot, sample, nodeId, operations) {
  return compilePenpotChanges(snapshot, {
    commitId: "component-samples-test",
    changes: [{ type: "mod-obj", id: sample.runtimeNodes[nodeId],
      "page-id": snapshot.runtime.designSystemPage, operations }],
  });
}

test("every real variant expands into every theme view with stable, distinct source-mapped ids", async () => {
  const snapshot = await load();
  const refs = snapshot.runtime.designSystemRefs;
  assert.equal(samples(snapshot).length, refs.families.filter((item) => item.kind === "variant").length * refs.combinations.length);
  assert.ok(samples(snapshot).every((item) => !item.error));
  const ids = samples(snapshot).flatMap((item) => Object.values(item.runtimeNodes));
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(samples(await load()), samples(snapshot));
});

test("bound radius edits write the Token, preserve bindings and reproject all specimens", async () => {
  const snapshot = await load();
  const sample = samples(snapshot).find((item) => item.componentSetId === "cmp_canvas_button");
  const batch = edit(snapshot, sample, sample.rootId, [
    ...[1, 2, 3, 4].map((n) => ({ type: "set", attr: `r${n}`, val: 20 })),
    { type: "set-touched", touched: null },
  ]);
  assert.deepEqual(batch.operations, [{ type: "set-token-value", tokenId: "tok_canvas_radius_base", path: "base", value: 20 }]);
  const prepared = await prepareOperationBatch(snapshot, batch);
  const next = prepared.snapshot;
  assert.ok(samples(next).filter((item) => item.componentSetId === "cmp_canvas_button").every((item) => item.nodes[item.rootId].cornerRadius === 20));
  assert.deepEqual(next.entries[next.manifest.entries.components[0]], snapshot.entries[snapshot.manifest.entries.components[0]]);
  const undone = (await prepareOperationBatch(next, prepared.result.inverseBatch)).snapshot;
  assert.deepEqual(undone.entries, snapshot.entries);
});

test("alias bindings and conflicting multi-selection edits fail without changing sources", async () => {
  const values = buildEditorPackageValues();
  const path = values.get("manifest.json").entries.components[0];
  const variant = values.get(path).componentSets.find((item) => item.id === "cmp_canvas_button").variants[0];
  variant.nodes[variant.rootId].tokenBindings.cornerRadius.assetId = "tok_canvas_radius_alias_pill";
  const snapshot = await load(values);
  const sample = samples(snapshot).find((item) => item.variantId === variant.id);
  assert.throws(() => edit(snapshot, sample, sample.rootId, [{ type: "set", attr: "r1", val: 20 }]), { code: "component_binding_source_locked" });
  assert.deepEqual(snapshot.entries[path], values.get(path));
  const plain = await load();
  const buttons = samples(plain).filter((item) => item.componentSetId === "cmp_canvas_button");
  assert.throws(() => compilePenpotChanges(plain, {
    commitId: "conflicting-selection",
    changes: buttons.slice(0, 2).map((item, index) => ({ type: "mod-obj", id: item.runtimeNodes[item.rootId],
      "page-id": plain.runtime.designSystemPage, operations: [{ type: "set", attr: "r1", val: 10 + index }] })),
  }), { code: "component_binding_conflict" });
});

test("theme binding resolves and edits the selected theme rather than the active one", async () => {
  const values = buildEditorPackageValues();
  const components = values.get(values.get("manifest.json").entries.components[0]);
  const variant = components.componentSets.find((item) => item.id === "cmp_canvas_button").variants[0];
  variant.nodes[variant.rootId].tokenBindings.fill = { packageId: "pkg_canvas", assetId: "tok_canvas_color_light_primary" };
  const snapshot = await load(values);
  const dark = samples(snapshot).find((item) => item.variantId === variant.id && item.combinationLabel.includes("Dark"));
  assert.equal(dark.nodes[dark.rootId].fills[0].color, "#d0bcff");
  const batch = edit(snapshot, dark, dark.rootId, [{ type: "set", attr: "fills", val: [{ "fill-color": "#ff0000", "fill-opacity": 1 }] }]);
  assert.equal(batch.operations[0].tokenId, "tok_canvas_color_dark_primary");
  const next = (await prepareOperationBatch(snapshot, batch)).snapshot;
  const light = samples(next).find((item) => item.variantId === variant.id && item.combinationLabel.includes("Light"));
  assert.equal(light.nodes[light.rootId].fills[0].color, "#6750a4");
});

test("unbound specimen edits affect only the exact variant and preserve source placement", async () => {
  const snapshot = await load();
  const sample = samples(snapshot).find((item) => item.componentSetId === "cmp_canvas_button");
  const batch = edit(snapshot, sample, sample.rootId, [
    { type: "set", attr: "width", val: 180 },
    { type: "set", attr: "x", val: 2000 },
  ]);
  const next = (await prepareOperationBatch(snapshot, batch)).snapshot;
  for (const item of samples(next).filter((item) => item.componentSetId === sample.componentSetId)) {
    assert.equal(item.nodes[item.rootId].width, item.variantId === sample.variantId ? 180 : 120);
    assert.equal(item.nodes[item.rootId].x, 0);
  }
});

test("separate fill bindings in one native edit both reach their own Token", async () => {
  const values = buildEditorPackageValues();
  const variant = values.get(values.get("manifest.json").entries.components[0]).componentSets[0].variants[0];
  const node = variant.nodes[variant.rootId];
  node.fills = [{ type: "solid", color: "#6750a4" }, { type: "solid", color: "#ffffff" }];
  node.tokenBindings["fills.0"] = { packageId: "pkg_canvas", assetId: "tok_canvas_color_light_primary" };
  node.tokenBindings["fills.1"] = { packageId: "pkg_canvas", assetId: "tok_canvas_color_light_surface" };
  const snapshot = await load(values);
  const sample = samples(snapshot).find((item) => item.variantId === variant.id && item.combinationLabel.includes("Light"));
  const batch = edit(snapshot, sample, sample.rootId, [{ type: "set", attr: "fills",
    val: [{ "fill-color": "#ff0000", "fill-opacity": 1 }, { "fill-color": "#00ff00", "fill-opacity": 1 }] }]);
  assert.equal(batch.operations.length, 2);
  const next = (await prepareOperationBatch(snapshot, batch)).snapshot;
  assert.deepEqual(samples(next).find((item) => item.key === sample.key).nodes[node.id].fills.map((fill) => fill.color), ["#ff0000", "#00ff00"]);
});

test("two nested occurrences edit independently and never mutate the shared child", async () => {
  const values = buildEditorPackageValues();
  const path = values.get("manifest.json").entries.components[0];
  const sets = values.get(path).componentSets;
  const card = sets.find((item) => item.id === "cmp_canvas_card").variants[0];
  for (const [index, id] of ["node_left_button", "node_right_button"].entries()) {
    card.nodes[card.rootId].children.push(id);
    card.nodes[id] = { id, name: "Same name", type: "INSTANCE", children: [], x: index * 130, y: 50, width: 120, height: 40,
      instance: { component: { packageId: "pkg_canvas", assetId: "cmp_canvas_button" }, variant: { axis_variant: "primary" }, overrides: {} } };
  }
  const snapshot = await load(values);
  const sample = samples(snapshot).find((item) => item.variantId === card.id);
  assert.equal(sample.classification, "Composite");
  assert.equal(sample.error, undefined);
  const target = "node_left_button__node_canvas_button_primary_label";
  const batch = edit(snapshot, sample, target, [{ type: "set", attr: "opacity", val: 0.4 }]);
  assert.equal(batch.operations[0].nodeId, "node_left_button");
  const next = (await prepareOperationBatch(snapshot, batch)).snapshot;
  const after = samples(next).find((item) => item.key === sample.key);
  assert.equal(after.nodes[target].opacity, 0.4);
  assert.notEqual(after.nodes["node_right_button__node_canvas_button_primary_label"].opacity, 0.4);
  assert.deepEqual(next.entries[path].componentSets.find((item) => item.id === "cmp_canvas_button"), sets.find((item) => item.id === "cmp_canvas_button"));
  assert.throws(() => edit(snapshot, sample, target, [{ type: "set", attr: "width", val: 99 }]), { code: "component_override_unsupported" });
});
