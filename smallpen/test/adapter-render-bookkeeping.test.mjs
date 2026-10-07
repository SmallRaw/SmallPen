import assert from "node:assert/strict";
import test from "node:test";
import { loadPackageFromValues } from "@smallpen/core";
import { compilePenpotChanges } from "@smallpen/penpot-adapter";
import { createWebLibrarySnapshot } from "../apps/background/src/web-projection.mjs";
import { buildEditorPackageValues } from "./fixtures/design-system-editor-fixture.mjs";

// Opening the generated Design System page re-measures every text, nested
// occurrences included. Those `position-data` syncs are render bookkeeping:
// they must never write an (empty) Instance override into the source.
test("a nested occurrence's text measuring writes no Instance override", async () => {
  const values = buildEditorPackageValues();
  const path = values.get("manifest.json").entries.components[0];
  const card = values.get(path).componentSets
    .find((item) => item.id === "cmp_canvas_card").variants[0];
  card.nodes[card.rootId].children.push("node_nested_button");
  card.nodes.node_nested_button = {
    id: "node_nested_button", name: "Button", type: "INSTANCE", children: [],
    x: 0, y: 50, width: 120, height: 40,
    instance: {
      component: { packageId: "pkg_canvas", assetId: "cmp_canvas_button" },
      variant: { axis_variant: "primary" },
    },
  };
  const snapshot = await loadPackageFromValues("memory://bookkeeping.smallpen", values);
  const sample = snapshot.runtime.designSystemRefs.componentSamples
    .find((item) => item.variantId === card.id);
  const target = "node_nested_button__node_canvas_button_primary_label";
  assert.ok(sample.runtimeNodes[target]);
  const batch = compilePenpotChanges(snapshot, {
    commitId: "text-measuring",
    changes: [{
      type: "mod-obj",
      id: sample.runtimeNodes[target],
      "page-id": snapshot.runtime.designSystemPage,
      operations: [{
        type: "set",
        attr: "position-data",
        val: [{ x: 0, y: 0, width: 40, height: 16, text: "Label" }],
        "ignore-geometry": true,
        "ignore-touched": true,
      }],
    }],
  });
  assert.deepEqual(batch.operations, []);
});

// A Library loads in the Web as a library file only when its component
// trees are expanded: a canonical INSTANCE carries no native component
// reference, and the projection cannot place it.
test("a Library travels to the Web with its nested Instances expanded", async () => {
  const values = buildEditorPackageValues();
  const path = values.get("manifest.json").entries.components[0];
  const card = values.get(path).componentSets
    .find((item) => item.id === "cmp_canvas_card").variants[0];
  card.nodes[card.rootId].children.push("node_nested_button");
  card.nodes.node_nested_button = {
    id: "node_nested_button", name: "Button", type: "INSTANCE", children: [],
    x: 0, y: 50, width: 120, height: 40,
    instance: {
      component: { packageId: "pkg_canvas", assetId: "cmp_canvas_button" },
      variant: { axis_variant: "primary" },
    },
  };
  const library = await loadPackageFromValues("memory://library.smallpen", values);
  const web = await createWebLibrarySnapshot(library);
  const variant = web.entries[path].componentSets
    .find((item) => item.id === "cmp_canvas_card").variants[0];
  const nested = variant.nodes.node_nested_button;
  assert.equal(nested.type, "INSTANCE");
  assert.deepEqual(nested.componentId, { assetId: "cmp_canvas_button", packageId: "pkg_canvas" });
  assert.ok(nested.children.length > 0);
  const ids = web.runtime.componentNodes.cmp_canvas_card[variant.id];
  for (const nodeId of Object.keys(variant.nodes)) assert.ok(ids[nodeId], nodeId);
  // The stored Library itself is not touched.
  assert.deepEqual(library.entries[path].componentSets
    .find((item) => item.id === "cmp_canvas_card").variants[0].nodes.node_nested_button.children, []);
});
