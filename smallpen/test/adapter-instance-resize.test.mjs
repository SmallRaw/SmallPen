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

const here = dirname(fileURLToPath(import.meta.url));
const SCREEN = "scr_home";
const PRESENTATION = "pres_home_mobile";

// The init Package with a Chip set; `labelConstraint` gives the Chip label
// a horizontal constraint in both variants.
async function chipPackage(labelConstraint) {
  const fixture = join(here, "fixtures", "variant-acme.smallpen");
  const manifest = JSON.parse(await readFile(join(fixture, "manifest.json"), "utf8"));
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of listPackageEntries(manifest).entries) {
    const value = JSON.parse(await readFile(join(fixture, entry), "utf8"));
    if (labelConstraint && entry === "components/components.json") {
      for (const variant of value.componentSets.find(({ id }) => id === "cmp_chip").variants) {
        variant.nodes.node_chip_label["constraints-h"] = labelConstraint;
      }
    }
    values.set(entry, value);
  }
  return loadPackageFromValues("memory://instance-resize.smallpen", values);
}

async function served(snapshot) {
  const effective = projectEffectiveSnapshot(snapshot, {});
  const projected = await createWebWorkspaceSnapshot(effective, {});
  return { ...effective, runtime: projected.runtime };
}

// Penpot's resize of the Chip copy from 96 to 160 wide, as recorded: the
// root, and the label when its constraint stretches it.
function resize(current, labelWidth) {
  const ids = current.runtime.nodes[SCREEN][PRESENTATION];
  const page = current.runtime.pages[SCREEN][PRESENTATION];
  const box = (y, height, width) => ({
    height,
    width,
    x: 24,
    x1: 24,
    x2: 24 + width,
    y,
    y1: y,
    y2: y + height,
  });
  const changes = [
    {
      id: ids.node_chip_one,
      operations: [
        { attr: "width", type: "set", val: 160 },
        { attr: "selrect", type: "set", val: box(120, 32, 160) },
      ],
      "page-id": page,
      type: "mod-obj",
    },
  ];
  if (labelWidth !== undefined) {
    changes.push({
      id: ids.node_chip_one__node_chip_label,
      operations: [
        { attr: "width", type: "set", val: labelWidth },
        { attr: "selrect", type: "set", val: box(126, 20, labelWidth) },
      ],
      "page-id": page,
      type: "mod-obj",
    });
  }
  return { changes, commitId: "resize-copy" };
}

function chipOne(snapshot) {
  return snapshot.entries["screens/first-design.json"].presentations[0].nodes
    .node_chip_one;
}

test("resizing a copy saves the Instance size; its unconstrained children stay put", async () => {
  const start = await chipPackage();
  const current = await served(start);
  const batch = compilePenpotChanges(current, resize(current));
  assert.deepEqual(batch.operations, [
    {
      changes: { width: 160 },
      nodeId: "node_chip_one",
      presentationId: PRESENTATION,
      screenId: SCREEN,
      type: "update-presentation-node",
    },
  ]);
  const { snapshot } = await prepareOperationBatch(current, batch);
  assert.equal(chipOne(snapshot).width, 160);
  assert.equal(chipOne(snapshot).instance.overrides?.["node_chip_label:width"], undefined);
});

test("a child its constraint stretches with a resized copy needs no override", async () => {
  const start = await chipPackage("leftright");
  const current = await served(start);
  const batch = compilePenpotChanges(current, resize(current, 160));
  assert.deepEqual(
    batch.operations.map(({ type, nodeId, changes }) => [type, nodeId, changes]),
    [["update-presentation-node", "node_chip_one", { width: 160 }]],
  );
});

test("a child resized against its constraint keeps its size as an override", async () => {
  const start = await chipPackage("left");
  const current = await served(start);
  const batch = compilePenpotChanges(current, resize(current, 160));
  assert.deepEqual(
    batch.operations.map(({ type, overridePath, value }) => [type, overridePath, value]),
    [["update-presentation-node", undefined, undefined], ["set-instance-override", "node_chip_label:width", 160]],
  );
});
