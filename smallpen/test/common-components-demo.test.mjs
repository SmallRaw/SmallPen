import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  listPackageEntries,
  loadPackageFromValues,
  prepareOperationBatch,
} from "@smallpen/core";
import { compilePenpotChanges } from "@smallpen/penpot-adapter";
import { buildCommonComponentsDemo } from "../scripts/build-common-components-demo.mjs";
import { createWebWorkspaceSnapshot } from "../apps/background/src/web-projection.mjs";

async function fixture() {
  const root = new URL("./fixtures/design-system.smallpen/", import.meta.url);
  const manifest = JSON.parse(
    await readFile(new URL("manifest.json", root), "utf8"),
  );
  const base = new Map([["manifest.json", manifest]]);
  for (const path of listPackageEntries(manifest).entries)
    base.set(path, JSON.parse(await readFile(new URL(path, root), "utf8")));
  const before = structuredClone(base);
  const values = buildCommonComponentsDemo(base);
  assert.deepEqual(base, before, "the original review package is preserved");
  return loadPackageFromValues("memory://common-components.smallpen", values);
}

test("Web expands nested component definitions and adapts sample references without changing canonical data", async () => {
  const product = await fixture();
  const before = structuredClone(product.entries);
  const web = await createWebWorkspaceSnapshot(product);
  const dialog = web.entries[
    "components/common-components.json"
  ].componentSets.find((set) => set.name === "Dialog").variants[1];
  const nodeId =
    "node_dialog_form_confirm__node_button_primary_text_default_label";
  assert.equal(dialog.nodes[nodeId]?.text, "Send invite");
  assert.ok(
    web.runtime.componentNodes.cmp_demo_dialog.var_demo_dialog_form[nodeId],
  );
  assert.deepEqual(dialog.nodes.node_dialog_form_confirm.componentId, {
    packageId: "pkg_design_system",
    assetId: "cmp_demo_button",
  });
  assert.equal(
    dialog.nodes.node_dialog_form_confirm.componentVariantId,
    "var_demo_button_primary_text_default",
  );
  const sample = web.runtime.designSystemRefs.componentSamples.find(
    (s) => s.variantId === dialog.id,
  );
  assert.equal(
    sample.nodes.node_dialog_form_confirm.componentVariantId,
    "var_demo_button_primary_text_default",
  );
  assert.deepEqual(product.entries, before);
});

test("common components expose all declared variants in both themes without projection errors", async () => {
  const snapshot = await fixture();
  const samples = snapshot.runtime.designSystemRefs.componentSamples;
  assert.deepEqual([...new Set(samples.map((s) => s.familyName))].sort(), [
    "Badge",
    "Button",
    "Card",
    "Dialog",
    "Input",
    "Title",
  ]);
  assert.equal(samples.length, 122);
  const ghost = samples.find(
    (s) => s.variantId === "var_demo_button_ghost_text_default",
  );
  assert.equal(ghost.nodes[ghost.rootId].fills[0].opacity, 0);
  assert.ok(samples.every((s) => !s.error));
  const ids = samples.flatMap((s) => Object.values(s.runtimeNodes));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(
    samples.filter((s) => s.familyName === "Button").length,
    3 * 4 * 4 * 2,
  );
  assert.ok(
    samples
      .filter((s) => s.familyName === "Dialog")
      .every((s) => s.classification === "Composite"),
  );
  const pair = samples.filter(
    (s) => s.variantId === "var_demo_button_primary_text_default",
  );
  assert.equal(
    new Set(pair.map((s) => s.nodes[s.rootId].fills[0].color)).size,
    2,
  );
  assert.equal(snapshot.runtime.designSystemRefs.pages.length, 2);
  const screen = snapshot.entries["screens/common-components.json"];
  assert.equal(
    Object.values(screen.presentations[0].nodes).filter((n) => n.instance)
      .length,
    5,
  );
});

test("editing a nested Dialog label's opacity affects its occurrence, not Button or the other Dialog", async () => {
  const snapshot = await fixture();
  const sample = snapshot.runtime.designSystemRefs.componentSamples.find(
    (s) => s.variantId === "var_demo_dialog_form",
  );
  const nodeId =
    "node_dialog_form_confirm__node_button_primary_text_default_label";
  assert.equal(sample.nodes[nodeId].text, "Send invite");
  const batch = compilePenpotChanges(snapshot, {
    commitId: "demo-dialog-label",
    changes: [
      {
        type: "mod-obj",
        id: sample.runtimeNodes[nodeId],
        "page-id": snapshot.runtime.designSystemPage,
        operations: [{ type: "set", attr: "opacity", val: 0.5 }],
      },
    ],
  });
  const next = (await prepareOperationBatch(snapshot, batch)).snapshot;
  const beforeSets =
    snapshot.entries["components/common-components.json"].componentSets;
  const afterSets =
    next.entries["components/common-components.json"].componentSets;
  assert.deepEqual(
    afterSets.find((s) => s.name === "Button"),
    beforeSets.find((s) => s.name === "Button"),
  );
  assert.deepEqual(
    afterSets.find((s) => s.name === "Dialog").variants[0],
    beforeSets.find((s) => s.name === "Dialog").variants[0],
  );
  assert.equal(
    next.runtime.designSystemRefs.componentSamples.find(
      (s) => s.key === sample.key,
    ).nodes[nodeId].opacity,
    0.5,
  );
});
