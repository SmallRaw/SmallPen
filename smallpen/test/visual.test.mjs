import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  listPackageEntries,
  loadPackageFromValues,
  prepareOperationBatch,
} from "@smallpen/core";
import { compilePenpotChanges } from "@smallpen/penpot-adapter";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "roundtrip.smallpen");

async function fixtureValues() {
  const manifest = JSON.parse(
    await readFile(join(fixture, "manifest.json"), "utf8"),
  );
  const { entries } = listPackageEntries(manifest);
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of entries) {
    values.set(
      entry,
      JSON.parse(await readFile(join(fixture, entry), "utf8")),
    );
  }
  return values;
}

function penpotGradient(type = "linear") {
  return {
    "end-x": 1,
    "end-y": 1,
    "start-x": 0,
    "start-y": 0,
    stops: [
      { color: "#ef4444", offset: 0, opacity: 1 },
      { color: "#3b82f6", offset: 1, opacity: 0.8 },
    ],
    type,
    width: 1,
  };
}

test("Penpot gradient fills and strokes apply and reverse exactly", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://gradients.smallpen",
    await fixtureValues(),
  );
  const runtimeId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle;
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: runtimeId,
        operations: [
          {
            attr: "fills",
            type: "set",
            val: [
              {
                "fill-color-gradient": penpotGradient("linear"),
                "fill-opacity": 0.9,
              },
            ],
          },
          {
            attr: "strokes",
            type: "set",
            val: [
              {
                "stroke-alignment": "outer",
                "stroke-color-gradient": penpotGradient("radial"),
                "stroke-opacity": 0.75,
                "stroke-style": "dotted",
                "stroke-width": 3,
              },
            ],
          },
        ],
        type: "mod-obj",
      },
    ],
    commitId: "gradient-paints",
  });
  assert.deepEqual(batch.operations[0].changes, {
    fills: [
      {
        endX: 1,
        endY: 1,
        gradientWidth: 1,
        opacity: 0.9,
        startX: 0,
        startY: 0,
        stops: [
          { color: "#ef4444", offset: 0, opacity: 1 },
          { color: "#3b82f6", offset: 1, opacity: 0.8 },
        ],
        type: "linear-gradient",
      },
    ],
    strokes: [
      {
        alignment: "outer",
        endX: 1,
        endY: 1,
        gradientWidth: 1,
        opacity: 0.75,
        startX: 0,
        startY: 0,
        stops: [
          { color: "#ef4444", offset: 0, opacity: 1 },
          { color: "#3b82f6", offset: 1, opacity: 0.8 },
        ],
        style: "dotted",
        type: "radial-gradient",
        width: 3,
      },
    ],
  });

  const prepared = await prepareOperationBatch(snapshot, batch);
  const node =
    prepared.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_rectangle;
  assert.deepEqual(node.fills, batch.operations[0].changes.fills);
  assert.deepEqual(node.strokes, batch.operations[0].changes.strokes);
  const reversed = await prepareOperationBatch(
    prepared.snapshot,
    prepared.result.inverseBatch,
  );
  assert.equal(reversed.snapshot.revision, snapshot.revision);
});

test("image paints and incomplete references fail before Canonical data can be lost", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://unsupported-paints.smallpen",
    await fixtureValues(),
  );
  const runtimeId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle;
  const commit = (attribute, value) => ({
    changes: [
      {
        id: runtimeId,
        operations: [{ attr: attribute, type: "set", val: value }],
        type: "mod-obj",
      },
    ],
    commitId: `unsupported-${attribute}`,
  });
  assert.throws(
    () =>
      compilePenpotChanges(
        snapshot,
        commit("fills", [
          { "fill-color": "#ffffff", "fill-color-ref-id": "library-color" },
        ]),
      ),
    (error) => error?.code === "invalid_color_reference",
  );
  assert.throws(
    () =>
      compilePenpotChanges(
        snapshot,
        commit("strokes", [
          {
            "stroke-color": "#ffffff",
            "stroke-image": { id: "asset-image" },
          },
        ]),
      ),
    (error) => error?.code === "invalid_penpot_stroke",
  );
});

test("Penpot rotation and flips ignore only their derived matrices", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://transforms.smallpen",
    await fixtureValues(),
  );
  const runtimeId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle;
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: runtimeId,
        operations: [
          { attr: "flip-x", type: "set", val: true },
          { attr: "rotation", type: "set", val: -30 },
          { attr: "transform", type: "set", val: {} },
          { attr: "transform-inverse", type: "set", val: {} },
          { attr: "points", type: "set", val: [] },
        ],
        type: "mod-obj",
      },
    ],
    commitId: "transform-node",
  });
  assert.deepEqual(batch.operations[0].changes, {
    flipX: true,
    rotation: 330,
  });
  const prepared = await prepareOperationBatch(snapshot, batch);
  const node =
    prepared.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_rectangle;
  assert.equal(node.flipX, true);
  assert.equal(node.rotation, 330);
  const reversed = await prepareOperationBatch(
    prepared.snapshot,
    prepared.result.inverseBatch,
  );
  assert.equal(reversed.snapshot.revision, snapshot.revision);
});
