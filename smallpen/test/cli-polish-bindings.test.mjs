import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  listPackageEntries,
  loadPackageFromValues,
} from "@smallpen/core";

import { createCanvasWorkspace } from "../apps/background/src/workspace-view.mjs";
import { componentEntry, readModelEntry } from "./helpers/named.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "model", "design-system");

test("canvas variant render applies fill, stroke, and typography bindings like projections", async () => {
  const manifest = await readModelEntry(fixture, "manifest.json");
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
    componentEntry(product).componentSets[0].variants[0]
      .nodes.node_card_idle_root.fills,
    [{ color: "#000000", type: "solid" }],
  );
});
