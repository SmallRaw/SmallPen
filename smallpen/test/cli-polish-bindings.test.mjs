import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  designTokenWarningsForBatch,
  listPackageEntries,
  loadPackageFromValues,
  prepareOperationBatch,
} from "@smallpen/core";

import { createCanvasWorkspace } from "../apps/background/src/workspace-view.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "design-system.smallpen");

function adviceValues(tokenBindings) {
  return new Map([
    ["manifest.json", {
      defaultScreenId: "scr_home",
      entries: {
        assets: [], components: [], contexts: [], requirements: [], scenarios: [],
        screens: ["screens/home.json"], tokens: ["tokens/design.json"],
      },
      formatVersion: 1,
      name: "Stroke Advice",
      packageId: "pkg_stroke_advice",
      role: "foundation",
    }],
    ["screens/home.json", {
      basePresentationId: "pres_home",
      counterparts: [],
      id: "scr_home",
      name: "Home",
      presentations: [{
        id: "pres_home",
        interactions: [],
        name: "Home",
        nodes: {
          node_box: {
            children: [], height: 40, id: "node_box", name: "Box",
            strokes: [{ color: "#000000", type: "solid", width: 1 }, { color: "#000000", type: "solid", width: 1 }],
            ...(tokenBindings ? { tokenBindings } : {}),
            type: "RECTANGLE", width: 40, x: 0, y: 0,
          },
        },
        platform: "desktop",
        rootId: "node_box",
        viewport: { height: 600, width: 800 },
      }],
    }],
    ["tokens/design.json", {
      color: {
        $type: "color",
        accent: { $extensions: { smallpen: { id: "tok_accent" } }, $value: "#6750a4" },
      },
    }],
  ]);
}

async function strokeWarnings(tokenBindings) {
  const product = await loadPackageFromValues("memory://stroke-advice.smallpen", adviceValues(tokenBindings));
  const batch = {
    baseRevision: product.revision,
    batchId: "batch_stroke_advice",
    operations: [{
      changes: {
        strokes: [
          { color: "#6750a4", type: "solid", width: 2 },
          { color: "#6750a4", type: "solid", width: 2 },
        ],
      },
      nodeId: "node_box",
      presentationId: "pres_home",
      screenId: "scr_home",
      type: "update-presentation-node",
    }],
  };
  const prepared = await prepareOperationBatch(product, batch);
  return designTokenWarningsForBatch(prepared.snapshot, batch)
    .filter(({ field }) => field.startsWith("strokes."));
}

test("raw stroke colours get Token advice; stroke and strokes.N bindings count as bound", async () => {
  const raw = await strokeWarnings();
  assert.deepEqual(raw.map(({ code, field }) => [code, field]), [
    ["design_token_not_used", "strokes.0"],
    ["design_token_not_used", "strokes.1"],
  ]);
  assert.deepEqual(raw[0].recommendedBinding, {
    field: "strokes.0",
    token: "color.accent",
    reference: { assetId: "tok_accent", packageId: "pkg_stroke_advice" },
  });
  const reference = { assetId: "tok_accent", packageId: "pkg_stroke_advice" };
  assert.deepEqual((await strokeWarnings({ stroke: reference })).map(({ field }) => field), ["strokes.1"]);
  assert.deepEqual((await strokeWarnings({ "strokes.1": reference })).map(({ field }) => field), ["strokes.0"]);
});

test("canvas variant render applies fill, stroke, and typography bindings like projections", async () => {
  const manifest = JSON.parse(await readFile(join(fixture, "manifest.json"), "utf8"));
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of listPackageEntries(manifest).entries) {
    values.set(entry, JSON.parse(await readFile(join(fixture, entry), "utf8")));
  }
  const components = values.get("components/components.json");
  const root = components.componentSets[0].variants[0].nodes.node_card_idle_root;
  const primary = { assetId: "tok_color_light_primary", packageId: "pkg_design_system" };
  root.fills = [{ color: "#000000", type: "solid" }];
  root.strokes = [{ color: "#000000", type: "solid", width: 3 }];
  root.tokenBindings = { ...root.tokenBindings, fill: primary, stroke: primary };
  const product = await loadPackageFromValues("memory://design-system.smallpen", values);

  const workspace = await createCanvasWorkspace({ snapshot: product });
  const key = Object.keys(workspace.render).find((id) => id.includes("/var_card_idle/"));
  const node = workspace.render[key].nodes.node_card_idle_root;
  assert.deepEqual(node.fills, [{ color: "#6750a4", type: "solid" }]);
  assert.deepEqual(node.strokes, [{ color: "#6750a4", type: "solid", width: 3 }]);
  assert.equal(node.cornerRadius, 8);
  // Binding field names are never written onto the node as raw fields.
  assert.equal(Object.hasOwn(node, "fill"), false);
  assert.equal(Object.hasOwn(node, "stroke"), false);
  // The canonical variant is unchanged.
  assert.deepEqual(
    product.entries["components/components.json"].componentSets[0].variants[0]
      .nodes.node_card_idle_root.fills,
    [{ color: "#000000", type: "solid" }],
  );
});
