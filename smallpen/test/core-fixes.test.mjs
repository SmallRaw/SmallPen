import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  listPackageEntries,
  loadPackageFromValues,
  prepareOperationBatch,
  readDesignView,
} from "@smallpen/core";
import { createEvidence } from "@smallpen/local-package";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "roundtrip.smallpen");

async function fixtureValues() {
  const manifest = JSON.parse(
    await readFile(join(fixture, "manifest.json"), "utf8"),
  );
  const { entries } = listPackageEntries(manifest);
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of entries) {
    values.set(entry, JSON.parse(await readFile(join(fixture, entry), "utf8")));
  }
  return values;
}

async function snapshotWith(values) {
  return loadPackageFromValues("memory://core-fixes.smallpen", values);
}

function strokeTokenValues(values) {
  const manifest = values.get("manifest.json");
  manifest.entries.tokens = ["tokens/design.json"];
  values.set("tokens/design.json", {
    activeSetIds: ["tset_strokes"],
    activeThemeIds: [],
    id: "tlib_strokes",
    sets: [
      {
        description: "Stroke tokens",
        id: "tset_strokes",
        name: "Strokes",
        tokens: [
          {
            description: "Focused stroke width",
            id: "tok_stroke_width",
            name: "stroke.focused",
            type: "stroke-width",
            value: 6,
          },
        ],
      },
    ],
    themes: [],
  });
  const nodes = values.get("screens/roundtrip.json").presentations[0].nodes;
  nodes.node_rectangle = {
    children: [],
    fills: [],
    height: 120,
    id: "node_rectangle",
    name: "Stroked line",
    pathData: "M 20 60 L 220 60",
    strokes: [{ color: "#ff0000", type: "solid", width: 2 }],
    type: "PATH",
    width: 240,
    x: 80,
    y: 96,
  };
  return values;
}

test("stroke-width token bindings bind, apply, project, clear, and inverse-restore", async () => {
  const values = await fixtureValues();
  await snapshotWith(strokeTokenValues(values));
  const before = await snapshotWith(structuredClone(values));
  const batch = {
    baseRevision: before.revision,
    batchId: "batch_stroke_bind",
    operations: [{
      binding: { assetId: "tok_stroke_width", packageId: before.manifest.packageId },
      field: "strokeWidth",
      nodeId: "node_rectangle",
      screenId: "scr_roundtrip",
      type: "set-token-binding",
    }],
  };
  const prepared = await prepareOperationBatch(before, batch);
  const applied = prepared.snapshot;
  assert.equal(
    applied.entries["screens/roundtrip.json"].presentations[0].nodes.node_rectangle
      .tokenBindings.strokeWidth.assetId,
    "tok_stroke_width",
  );
  // Projection resolves the binding to every stroke width.
  const read = readDesignView(applied, { selector: { viewFormat: "structure" } });
  assert.equal(read.result.nodes.node_rectangle.strokes[0].width, 6);

  // Clear returns to the raw value and the inverse restores the bound state.
  const cleared = await prepareOperationBatch(applied, {
    baseRevision: applied.revision,
    batchId: "batch_stroke_clear",
    operations: [{
      field: "strokeWidth",
      nodeId: "node_rectangle",
      screenId: "scr_roundtrip",
      type: "clear-token-binding",
    }],
  });
  const clearedRead = readDesignView(cleared.snapshot, {
    selector: { viewFormat: "structure" },
  });
  assert.equal(clearedRead.result.nodes.node_rectangle.strokes[0].width, 2);
  assert.deepEqual(
    cleared.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_rectangle.tokenBindings,
    {},
  );
  const restored = await prepareOperationBatch(cleared.snapshot, cleared.result.inverseBatch);
  assert.equal(restored.snapshot.revision, applied.revision);
});

test("unsupported token binding fields stay atomically rejected", async () => {
  const before = await snapshotWith(await fixtureValues());
  await assert.rejects(
    prepareOperationBatch(before, {
      baseRevision: before.revision,
      batchId: "batch_bad_binding",
      operations: [{
        binding: { assetId: "tok_brand", packageId: before.manifest.packageId },
        field: "strokeCap",
        nodeId: "node_rectangle",
        screenId: "scr_roundtrip",
        type: "set-token-binding",
      }],
    }),
    (error) => error?.code === "unsupported_token_binding",
  );
});

test("component reference cycles are rejected before the batch is accepted", async () => {
  const values = await fixtureValues();
  values.get("manifest.json").entries.components = ["components/shared.json"];
  values.set("components/shared.json", {
    componentSets: [{
      axes: [{
        domain: ["idle"],
        id: "axis_state",
        name: "State",
        role: "state",
      }],
      id: "cmp_self",
      name: "Self referencer",
      variants: [{
        id: "var_self_idle",
        nodes: {
          node_self_root: {
            children: ["node_self_instance"],
            height: 80,
            id: "node_self_root",
            name: "Root",
            type: "COMPONENT",
            width: 120,
            x: 0,
            y: 0,
          },
          node_self_instance: {
            children: [],
            height: 40,
            id: "node_self_instance",
            instance: {
              component: { assetId: "cmp_self", packageId: "pkg_roundtrip" },
              variant: {},
            },
            name: "Nested self",
            type: "INSTANCE",
            width: 40,
            x: 8,
            y: 8,
          },
        },
        rootId: "node_self_root",
        selection: { axis_state: "idle" },
      }],
      visibility: "public",
    }],
  });
  // The raw state still loads: previously accepted packages stay recoverable.
  const before = await snapshotWith(structuredClone(values));
  const batch = {
    baseRevision: before.revision,
    batchId: "batch_cycle",
    operations: [{
      componentSet: {
        axes: [{
          domain: ["idle"],
          id: "axis_state",
          name: "State",
          role: "state",
        }],
        id: "cmp_self",
        name: "Self referencer v2",
        variants: [{
          id: "var_self_idle",
          nodes: {
            node_self_root: {
              children: ["node_self_instance"],
              height: 80,
              id: "node_self_root",
              name: "Root",
              type: "COMPONENT",
              width: 120,
              x: 0,
              y: 0,
            },
            node_self_instance: {
              children: [],
              height: 40,
              id: "node_self_instance",
              instance: {
                component: { assetId: "cmp_self", packageId: "pkg_roundtrip" },
                variant: {},
              },
              name: "Nested self",
              type: "INSTANCE",
              width: 40,
              x: 8,
              y: 8,
            },
          },
          rootId: "node_self_root",
          selection: { axis_state: "idle" },
        }],
        visibility: "public",
      },
      entry: "components/shared.json",
      type: "put-component-set",
    }],
  };
  await assert.rejects(
    prepareOperationBatch(before, batch),
    (error) => error?.code === "component_cycle",
  );
});

test("a previously accepted cycle state is recoverable through a normal batch", async () => {
  const values = await fixtureValues();
  values.get("manifest.json").entries.components = ["components/shared.json"];
  values.set("components/shared.json", {
    componentSets: [{
      axes: [],
      id: "cmp_good",
      name: "Good",
      variants: [{
        id: "var_good",
        nodes: {
          node_good_root: {
            children: [],
            height: 40,
            id: "node_good_root",
            name: "Root",
            type: "COMPONENT",
            width: 80,
            x: 0,
            y: 0,
          },
        },
        rootId: "node_good_root",
        selection: {},
      }],
      visibility: "public",
    }],
  });
  const bad = await snapshotWith(structuredClone(values));
  // The recovery batch replaces the cyclic state with a valid set.
  const prepared = await prepareOperationBatch(bad, {
    baseRevision: bad.revision,
    batchId: "batch_recover",
    operations: [{
      componentSet: {
        axes: [],
        id: "cmp_good",
        name: "Good v2",
        variants: [{
          id: "var_good",
          nodes: {
            node_good_root: {
              children: [],
              height: 40,
              id: "node_good_root",
              name: "Root",
              type: "COMPONENT",
              width: 80,
              x: 0,
              y: 0,
            },
          },
          rootId: "node_good_root",
          selection: {},
        }],
        visibility: "public",
      },
      entry: "components/shared.json",
      type: "put-component-set",
    }],
  });
  assert.notEqual(prepared.snapshot.revision, bad.revision);
  assert.ok(prepared.result.inverseBatch);
});

test("component scenarios resolve semantic views and render pixels", async () => {
  const values = await fixtureValues();
  values.get("manifest.json").entries.components = ["components/shared.json"];
  values.set("components/shared.json", {
    componentSets: [{
      axes: [{
        domain: ["idle", "pressed"],
        id: "axis_state",
        name: "State",
        role: "state",
      }],
      id: "cmp_button",
      name: "Button",
      variants: [
        {
          id: "var_button_idle",
          nodes: {
            node_button_source: {
              children: [],
              fills: [{ color: "#2563eb", type: "solid" }],
              height: 40,
              id: "node_button_source",
              name: "Button",
              type: "COMPONENT",
              width: 120,
              x: 0,
              y: 0,
            },
          },
          rootId: "node_button_source",
          selection: { axis_state: "idle" },
        },
        {
          id: "var_button_pressed",
          nodes: {
            node_button_source: {
              children: [],
              fills: [{ color: "#b91c1c", type: "solid" }],
              height: 40,
              id: "node_button_source",
              name: "Button pressed",
              type: "COMPONENT",
              width: 120,
              x: 0,
              y: 0,
            },
          },
          rootId: "node_button_source",
          selection: { axis_state: "pressed" },
        },
      ],
      visibility: "public",
    }],
  });
  values.get("manifest.json").entries.scenarios = ["scenarios/design.json"];
  values.set("scenarios/design.json", {
    scenarios: [{
      actions: [{
        axisId: "axis_state",
        type: "set-state",
        value: "pressed",
      }],
      context: {},
      expectedVisibleNodeIds: ["node_button_source"],
      fixture: {},
      id: "scn_button_pressed",
      name: "Button / Pressed",
      target: {
        component: { assetId: "cmp_button", packageId: "pkg_roundtrip" },
        kind: "component",
        variant: { axis_state: "idle" },
      },
      viewport: { height: 40, scale: 1, width: 120 },
    }],
  });
  const product = await snapshotWith(values);
  const structure = readDesignView(product, {
    selector: { scenarioId: "scn_button_pressed", viewFormat: "structure" },
  });
  assert.equal(structure.result.nodes.node_button_source.type, "COMPONENT");
  assert.equal(structure.result.nodes.node_button_source.fills[0].color, "#b91c1c");
  const read = readDesignView(product, {
    selector: { scenarioId: "scn_button_pressed", viewFormat: "semantic" },
  });
  assert.equal(read.result.root.type, "COMPONENT");
  assert.equal(read.selection.scenarioId, "scn_button_pressed");

  const evidence = await createEvidence(product, {
    scale: 1,
    selector: { scenarioId: "scn_button_pressed", viewFormat: "screenshot" },
  });
  assert.deepEqual(evidence.render.diagnostics, []);
  assert.deepEqual(
    [...evidence.render.bytes.slice(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
});

test("untouched located component copies inherit master changes", async () => {
  const values = await fixtureValues();
  const manifest = values.get("manifest.json");
  manifest.entries.components = ["components/masters.json"];
  values.set("components/masters.json", {
    id: "cmp_master_card",
    mainNodeId: "node_master_card",
    name: "Master card",
    path: "Components",
    presentationId: "pres_desktop",
    screenId: "scr_roundtrip",
  });
  const presentation = values.get("screens/roundtrip.json").presentations[0];
  presentation.nodes.node_master_card = {
    children: [],
    componentId: "cmp_master_card",
    cornerRadius: 0,
    fills: [{ color: "#2563eb", type: "solid" }],
    height: 120,
    id: "node_master_card",
    name: "Master card",
    type: "COMPONENT",
    width: 240,
    x: 40,
    y: 380,
  };
  presentation.nodes.node_canvas.children.push("node_master_card", "node_copy_card");
  presentation.nodes.node_copy_card = {
    children: [],
    componentId: "cmp_master_card",
    height: 120,
    id: "node_copy_card",
    name: "Copy card",
    sourceNodeId: "node_master_card",
    type: "INSTANCE",
    width: 240,
    x: 320,
    y: 380,
  };

  // Change the master fill; the untouched copy must follow at projection.
  presentation.nodes.node_master_card.fills = [{ color: "#16a34a", type: "solid" }];
  const product = await snapshotWith(values);
  const read = readDesignView(product, { selector: { viewFormat: "structure" } });
  const copy = read.result.nodes.node_copy_card;
  assert.equal(copy.fills[0].color, "#16a34a");
  assert.equal(copy.x, 320, "copies keep their own position");

  // A touched copy keeps its own fill-group deviation.
  presentation.nodes.node_copy_card.touched = ["fill-group"];
  presentation.nodes.node_copy_card.fills = [{ color: "#f59e0b", type: "solid" }];
  const touchedProduct = await snapshotWith(values);
  const touchedRead = readDesignView(touchedProduct, {
    selector: { viewFormat: "structure" },
  });
  assert.equal(touchedRead.result.nodes.node_copy_card.fills[0].color, "#f59e0b");
});

// RV-001-B/C: inheritance must consume the master's token-evaluated values,
// respect touched groups, follow Contexts, and never mutate Canonical entries.
async function tokenMasterValues() {
  const values = await fixtureValues();
  const manifest = values.get("manifest.json");
  manifest.entries.tokens = ["tokens/design.json"];
  manifest.entries.components = ["components/masters.json"];
  values.set("tokens/design.json", {
    activeSetIds: ["tset_brand"],
    activeThemeIds: [],
    id: "tlib_brand",
    sets: [{
      description: "Brand",
      id: "tset_brand",
      name: "Brand",
      tokens: [{
        description: "Brand color",
        id: "tok_brand",
        name: "color.brand",
        type: "color",
        value: "#00ff00",
      }],
    }],
    themes: [],
  });
  values.set("components/masters.json", {
    id: "cmp_master_card",
    mainNodeId: "node_master_card",
    name: "Master card",
    path: "Components",
    presentationId: "pres_desktop",
    screenId: "scr_roundtrip",
  });
  const presentation = values.get("screens/roundtrip.json").presentations[0];
  presentation.nodes.node_master_card = {
    children: [],
    componentId: "cmp_master_card",
    cornerRadius: 0,
    fills: [{ color: "#7c3aed", type: "solid" }],
    height: 120,
    id: "node_master_card",
    name: "Master card",
    tokenBindings: {
      fill: { assetId: "tok_brand", packageId: "pkg_roundtrip" },
    },
    type: "COMPONENT",
    width: 240,
    x: 40,
    y: 380,
  };
  presentation.nodes.node_canvas.children.push("node_master_card", "node_copy_card");
  presentation.nodes.node_copy_card = {
    children: [],
    componentId: "cmp_master_card",
    height: 120,
    id: "node_copy_card",
    name: "Copy card",
    sourceNodeId: "node_master_card",
    type: "INSTANCE",
    width: 240,
    x: 320,
    y: 380,
  };
  return values;
}

test("located copies inherit the token-evaluated master color (RV-001-B)", async () => {
  const values = await tokenMasterValues();
  const before = structuredClone(values);
  const product = await snapshotWith(values);
  assert.deepEqual(values, before, "fixture build has no side effects");
  const read = readDesignView(product, { selector: { viewFormat: "structure" } });
  const nodes = read.result.nodes;
  assert.equal(nodes.node_master_card.fills[0].color, "#00ff00");
  assert.equal(
    nodes.node_copy_card.fills[0].color,
    "#00ff00",
    "untouched copy shows the resolved token color, not the raw master fill",
  );
  assert.equal(nodes.node_copy_card.type, "INSTANCE");

  // Updating the Token value moves both master and copy together.
  const updated = structuredClone(before);
  updated.get("tokens/design.json").sets[0].tokens[0].value = "#ff0000";
  const moved = await snapshotWith(updated);
  const movedRead = readDesignView(moved, { selector: { viewFormat: "structure" } });
  assert.equal(movedRead.result.nodes.node_master_card.fills[0].color, "#ff0000");
  assert.equal(movedRead.result.nodes.node_copy_card.fills[0].color, "#ff0000");
});

test("touched copies keep their own fill across master Token changes (RV-001-C)", async () => {
  const values = await tokenMasterValues();
  const presentation = values.get("screens/roundtrip.json").presentations[0];
  presentation.nodes.node_canvas.children.push("node_touched_card");
  presentation.nodes.node_touched_card = {
    children: [],
    componentId: "cmp_master_card",
    fills: [{ color: "#f59e0b", type: "solid" }],
    height: 120,
    id: "node_touched_card",
    name: "Touched copy",
    sourceNodeId: "node_master_card",
    touched: ["fill-group"],
    type: "INSTANCE",
    width: 240,
    x: 590,
    y: 380,
  };
  const before = structuredClone(values);
  const product = await snapshotWith(values);
  const read = readDesignView(product, { selector: { viewFormat: "structure" } });
  const nodes = read.result.nodes;
  assert.equal(nodes.node_master_card.fills[0].color, "#00ff00");
  assert.equal(nodes.node_copy_card.fills[0].color, "#00ff00");
  assert.equal(
    nodes.node_touched_card.fills[0].color,
    "#f59e0b",
    "fill-group touched copy keeps its own color",
  );
  assert.deepEqual(values, before, "projection must not mutate the fixture");
});

test("untouched copies follow the Context-specific token value (RV-001-C)", async () => {
  const values = await tokenMasterValues();
  // Context-specific values live in the DTCG token entry format
  // ($extensions.smallpen.contextValues), resolved against a Context axis.
  values.get("manifest.json").entries.tokens = ["tokens/dtcg.json"];
  values.set("tokens/dtcg.json", {
    color: {
      brand: {
        $extensions: {
          smallpen: {
            contextValues: [
              { value: "#111827", when: { axis_theme: "dark" } },
              { value: "#f8fafc", when: { axis_theme: "light" } },
            ],
            id: "tok_brand",
            visibility: "public",
          },
        },
        $type: "color",
        $value: "#00ff00",
      },
    },
  });
  values.set("contexts/design.json", {
    axes: [{
      defaultValue: "light",
      id: "axis_theme",
      kind: "custom",
      name: "Theme",
      values: [
        { id: "light", name: "Light" },
        { id: "dark", name: "Dark" },
      ],
    }],
    profiles: [],
  });
  values.get("manifest.json").entries.contexts = ["contexts/design.json"];
  const product = await snapshotWith(values);
  const light = readDesignView(product, {
    selector: { context: { axis_theme: "light" }, viewFormat: "structure" },
  });
  assert.equal(light.result.nodes.node_master_card.fills[0].color, "#f8fafc");
  assert.equal(light.result.nodes.node_copy_card.fills[0].color, "#f8fafc");
  const dark = readDesignView(product, {
    selector: { context: { axis_theme: "dark" }, viewFormat: "structure" },
  });
  assert.equal(dark.result.nodes.node_master_card.fills[0].color, "#111827");
  assert.equal(dark.result.nodes.node_copy_card.fills[0].color, "#111827");
});
