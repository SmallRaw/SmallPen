import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  listPackageEntries,
  loadPackageFromValues,
  prepareOperationBatch,
  projectEffectiveSnapshot,
} from "@smallpen/core";
import { compilePenpotChanges } from "@smallpen/penpot-adapter";

import { createWebWorkspaceSnapshot } from "../apps/background/src/web-projection.mjs";

// Commits recorded from Penpot's native variant UI on the Components page
// (and a copy's variant switch on a screen) of two Packages: the Flowboard
// Foundation reduced to its Button set, and an init Package with two plain
// components and a Chip set used by three Instances.
const here = dirname(fileURLToPath(import.meta.url));
const recordedText = await readFile(
  join(here, "fixtures", "penpot-variant-commits.json"),
  "utf8",
);

async function load(name) {
  const fixture = join(here, "fixtures", name);
  const manifest = JSON.parse(
    await readFile(join(fixture, "manifest.json"), "utf8"),
  );
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of listPackageEntries(manifest).entries) {
    values.set(entry, JSON.parse(await readFile(join(fixture, entry), "utf8")));
  }
  return loadPackageFromValues(`memory://${name}`, values);
}

// The Background's commit path: the web projection with the session's
// runtime ids, then the adapter, then the batch.
function session(start) {
  const ids = new Map();
  const state = { snapshot: start };
  state.served = async () => {
    const effective = projectEffectiveSnapshot(state.snapshot, {});
    const projected = await createWebWorkspaceSnapshot(effective, {
      sessionRuntimeIds: ids,
    });
    return { ...effective, runtime: projected.runtime };
  };
  state.compile = async (group, name) => {
    const current = await state.served();
    const changes = JSON.parse(
      JSON.stringify(JSON.parse(recordedText)[group][name]).replaceAll(
        "__FILE__",
        current.runtime.file,
      ),
    );
    const added = new Map();
    const batch = compilePenpotChanges(
      current,
      { changes, commitId: name },
      { projectedRuntimeIds: added },
    );
    return { added, batch, current };
  };
  state.commit = async (group, name) => {
    const { added, batch, current } = await state.compile(group, name);
    state.snapshot = (await prepareOperationBatch(current, batch)).snapshot;
    for (const [runtimeId, descriptor] of added) {
      ids.delete(runtimeId);
      ids.set(runtimeId, descriptor);
    }
    return batch;
  };
  return state;
}

function componentSet(snapshot, setId) {
  for (const entry of snapshot.manifest.entries.components) {
    const found = snapshot.entries[entry].componentSets?.find(({ id }) => id === setId);
    if (found) return found;
  }
  return undefined;
}

function instance(snapshot, nodeId) {
  return snapshot.entries["screens/first-design.json"].presentations[0].nodes[nodeId]
    .instance;
}

test("adding a variant in Penpot writes one Component Set with a copy of its source variant", async () => {
  const start = await load("variant-button.smallpen");
  const editor = session(start);
  const batch = await editor.commit("button", "addVariant");
  assert.deepEqual(
    batch.operations.map(({ type }) => type),
    ["put-component-set"],
  );
  const button = componentSet(editor.snapshot, "cmp_button");
  const source = button.variants.find(({ id }) => id === "var_button_primary_sm");
  const added = button.variants.at(-1);
  assert.equal(button.variants.length, 9);
  assert.equal(added.id, "var_primary_value_3");
  assert.deepEqual(added.selection, { axis_size: "Value 3", axis_style: "primary" });
  assert.deepEqual(added.nodes, source.nodes);
  assert.deepEqual(button.axes.find(({ id }) => id === "axis_size").domain, [
    "sm",
    "md",
    "Value 3",
  ]);
  // The Penpot ids of the duplicate stay its runtime ids for the session,
  // so a reprojection keeps the shapes the workspace holds.
  const addObj = JSON.parse(recordedText).button.addVariant.find(
    ({ type }) => type === "add-obj",
  );
  const served = await editor.served();
  assert.equal(
    served.runtime.componentNodes.cmp_button.var_primary_value_3.node_button_root,
    addObj.id,
  );
});

test("undo of an added variant restores the Package exactly", async () => {
  const start = await load("variant-button.smallpen");
  const editor = session(start);
  await editor.commit("button", "addVariant");
  await editor.commit("button", "undoAddVariant");
  assert.equal(editor.snapshot.revision, start.revision);
});

test("deleting a variant and undoing it brings back the same variant and domain", async () => {
  const start = await load("variant-button.smallpen");
  const editor = session(start);
  await editor.commit("button", "deleteVariant");
  const button = componentSet(editor.snapshot, "cmp_button");
  assert.equal(button.variants.some(({ id }) => id === "var_button_primary_md"), false);
  assert.equal(button.variants.length, 7);
  await editor.commit("button", "undoDeleteVariant");
  assert.equal(editor.snapshot.revision, start.revision);
});

test("changing a variant's value writes its selection and extends the axis domain", async () => {
  const editor = session(await load("variant-button.smallpen"));
  await editor.commit("button", "changeValue");
  const button = componentSet(editor.snapshot, "cmp_button");
  assert.deepEqual(
    button.variants.find(({ id }) => id === "var_button_primary_sm").selection,
    { axis_size: "sm", axis_style: "brand" },
  );
  assert.deepEqual(button.axes[0].domain, [
    "primary",
    "secondary",
    "ghost",
    "danger",
    "brand",
  ]);
});

test("renaming a property renames its axis and keeps the axis id", async () => {
  const editor = session(await load("variant-button.smallpen"));
  // Recorded after the value change above.
  await editor.commit("button", "changeValue");
  const before = editor.snapshot.revision;
  await editor.commit("button", "renameProperty");
  const button = componentSet(editor.snapshot, "cmp_button");
  assert.deepEqual(
    button.axes.map(({ id, name, role }) => [id, name, role]),
    [
      ["axis_style", "Kind", "configuration"],
      ["axis_size", "Size", "configuration"],
    ],
  );
  await editor.commit("button", "undoRenameProperty");
  assert.equal(editor.snapshot.revision, before);
});

test("adding a property adds a configuration axis that every variant selects", async () => {
  const editor = session(await load("variant-button.smallpen"));
  await editor.commit("button", "addProperty");
  const button = componentSet(editor.snapshot, "cmp_button");
  assert.deepEqual(button.axes.at(-1), {
    domain: ["Value 1"],
    id: "axis_property_3",
    name: "Property 3",
    role: "configuration",
  });
  assert.ok(
    button.variants.every(({ selection }) => selection.axis_property_3 === "Value 1"),
  );
});

test("removing a property that leaves two equal variants is refused", async () => {
  const editor = session(await load("variant-button.smallpen"));
  await assert.rejects(editor.compile("button", "removeProperty"), {
    code: "variant_duplicate_selection",
  });
});

test("switching an Instance's variant keeps the node and the overrides that apply", async () => {
  const start = await load("variant-acme.smallpen");
  const editor = session(start);
  const batch = await editor.commit("acme", "switchVariant");
  assert.deepEqual(batch.operations, [
    {
      nodeId: "node_chip_one",
      presentationId: "pres_home_mobile",
      screenId: "scr_home",
      selection: { axis_tone: "brand" },
      type: "select-instance-variant",
    },
  ]);
  assert.deepEqual(instance(editor.snapshot, "node_chip_one"), {
    component: { assetId: "cmp_chip", packageId: "pkg_acme" },
    overrides: { "node_chip_label:text": "Hello" },
    variant: { axis_tone: "brand" },
  });
  await editor.commit("acme", "undoSwitchVariant");
  assert.equal(editor.snapshot.revision, start.revision);
});

test("combining plain components as variants merges their sets and re-points their Instances", async () => {
  const start = await load("variant-acme.smallpen");
  const editor = session(start);
  await editor.commit("acme", "combine");
  const combined = componentSet(editor.snapshot, "cmp_badge");
  assert.equal(componentSet(editor.snapshot, "cmp_button"), undefined);
  assert.deepEqual(combined.axes, [
    {
      domain: ["Badge", "Button"],
      id: "axis_property_1",
      name: "Property 1",
      role: "configuration",
    },
  ]);
  assert.deepEqual(
    combined.variants.map(({ id, selection }) => [id, selection]),
    [
      ["var_badge_default", { axis_property_1: "Badge" }],
      ["var_button_default", { axis_property_1: "Button" }],
    ],
  );
  assert.deepEqual(instance(editor.snapshot, "node_button_one"), {
    component: { assetId: "cmp_badge", packageId: "pkg_acme" },
    variant: { axis_property_1: "Button" },
  });
  assert.deepEqual(instance(editor.snapshot, "node_badge_one").variant, {
    axis_property_1: "Badge",
  });
  // Undo gives each component its own set back, in its old place.
  await editor.commit("acme", "undoCombine");
  assert.equal(editor.snapshot.revision, start.revision);
});

test("reordering variants in their container reorders the Component Set", async () => {
  const start = await load("variant-acme.smallpen");
  const editor = session(start);
  await editor.commit("acme", "reorder");
  assert.deepEqual(
    componentSet(editor.snapshot, "cmp_chip").variants.map(({ id }) => id),
    ["var_chip_brand", "var_chip_neutral"],
  );
  await editor.commit("acme", "undoReorder");
  assert.equal(editor.snapshot.revision, start.revision);
});

// A main drawn at a layout offset on the Components page, as Penpot reports
// a geometry edit of one of its shapes.
function placementChange(current, nodeId, x, y) {
  return {
    id: current.runtime.componentNodes.cmp_button.var_button_primary_sm[nodeId],
    operations: [
      { attr: "x", "ignore-touched": false, type: "set", val: x },
      { attr: "y", "ignore-touched": false, type: "set", val: y },
    ],
    "page-id": current.runtime.componentsPage,
    "smallpen-layout-offset": { x: 30, y: 366 },
    type: "mod-obj",
  };
}

test("dragging a variant main moves its tree without editing its nodes", async () => {
  const editor = session(await load("variant-button.smallpen"));
  const current = await editor.served();
  const batch = compilePenpotChanges(current, {
    changes: [
      placementChange(current, "node_button_root", 80, 386),
      placementChange(current, "node_button_label", 80, 386),
    ],
    commitId: "drag-main",
  });
  assert.deepEqual(batch.operations, []);
});

test("moving a layer inside a variant main writes its place in its parent", async () => {
  const editor = session(await load("variant-button.smallpen"));
  const current = await editor.served();
  const batch = compilePenpotChanges(current, {
    changes: [placementChange(current, "node_button_label", 32, 366)],
    commitId: "nudge-label",
  });
  assert.deepEqual(batch.operations, [
    {
      changes: { x: 2 },
      componentId: "cmp_button",
      nodeId: "node_button_label",
      type: "update-component-node",
      unset: [],
      variantId: "var_button_primary_sm",
    },
  ]);
});

test("a layer moved in a main dragged earlier is placed against the main where it is now", async () => {
  const editor = session(await load("variant-button.smallpen"));
  const current = await editor.served();
  // The main was dragged by (10, 10) in an earlier commit (nothing saved);
  // the label then moves 1 to the right of where it was in the main.
  // Penpot sends only the attribute that changed.
  const nudge = placementChange(current, "node_button_label", 41, 376);
  nudge.operations = nudge.operations.filter(({ attr }) => attr === "x");
  nudge["smallpen-parent"] = {
    child: { height: 32, width: 96, x: 41, y: 376 },
    geometry: { height: 32, width: 96, x: 40, y: 376 },
    id: current.runtime.componentNodes.cmp_button.var_button_primary_sm.node_button_root,
  };
  const batch = compilePenpotChanges(current, {
    changes: [nudge],
    commitId: "nudge-in-dragged-main",
  });
  assert.deepEqual(
    batch.operations.map(({ changes }) => changes),
    [{ x: 1 }],
  );
});

// The projection files a set under its category and names its container
// "Category / Name", as Penpot requires of a component in a folder.
function containerRename(current, name) {
  return {
    id: current.runtime.components.cmp_button,
    operations: [{ attr: "name", "ignore-touched": false, type: "set", val: name }],
    "page-id": current.runtime.componentsPage,
    type: "mod-obj",
  };
}

test("a container that keeps its folder and name writes nothing", async () => {
  const editor = session(await load("variant-button.smallpen"));
  const current = await editor.served();
  const batch = compilePenpotChanges(current, {
    changes: [containerRename(current, "Actions / Button")],
    commitId: "same-name",
  });
  assert.deepEqual(batch.operations, []);
});

test("renaming a container into another folder writes the set's category", async () => {
  const editor = session(await load("variant-button.smallpen"));
  const current = await editor.served();
  const moved = compilePenpotChanges(current, {
    changes: [containerRename(current, "Controls/ Forms / Action button")],
    commitId: "move-folder",
  });
  assert.deepEqual(moved.operations.map(({ type }) => type), ["put-component-set"]);
  assert.equal(moved.operations[0].componentSet.name, "Action button");
  assert.equal(moved.operations[0].componentSet.category, "Controls / Forms");
  const unfiled = compilePenpotChanges(current, {
    changes: [containerRename(current, "Button")],
    commitId: "leave-folder",
  });
  assert.equal(unfiled.operations[0].componentSet.name, "Button");
  assert.equal(Object.hasOwn(unfiled.operations[0].componentSet, "category"), false);
});
