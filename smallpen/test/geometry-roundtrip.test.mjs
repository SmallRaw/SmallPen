// Canonical node geometry is parent-relative: x/y, rotation and flips apply
// inside the parent's FULL transform (render.mjs `nodeTransform`). Penpot is
// page-absolute. The Penpot values below are exactly what the frontend
// projection produces for this tree (asserted in
// frontend/test/frontend_tests/smallpen/projection_test.cljs, "Shared geometry
// fixture"), so these tests close the loop: canonical -> projection -> Penpot
// change -> adapter -> canonical, and render.mjs draws the same placement.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inflateSync } from "node:zlib";

import {
  listPackageEntries,
  loadPackageFromValues,
  prepareOperationBatch,
} from "@smallpen/core";
import { createEvidence } from "@smallpen/local-package";
import { compilePenpotChanges } from "@smallpen/penpot-adapter";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "roundtrip.smallpen");
const COS30 = Math.sqrt(3) / 2;
const addedPathRuntimeId = "abababab-abab-4bab-8bab-abababababab";
const addedPathNodeId = "node_abababababab4bab8bababababababab";

const GEOMETRY_NODES = {
  node_board: {
    children: ["node_child", "node_turned", "node_line", "node_group"],
    height: 100,
    id: "node_board",
    name: "Board",
    rotation: 90,
    type: "FRAME",
    width: 200,
    x: 100,
    y: 100,
  },
  node_child: {
    children: [],
    height: 30,
    id: "node_child",
    name: "Child",
    type: "RECTANGLE",
    width: 40,
    x: 10,
    y: 20,
  },
  node_group: {
    children: ["node_leaf"],
    height: 40,
    id: "node_group",
    name: "Group",
    rotation: 90,
    type: "GROUP",
    width: 60,
    x: 120,
    y: 40,
  },
  node_leaf: {
    children: [],
    height: 10,
    id: "node_leaf",
    name: "Leaf",
    type: "RECTANGLE",
    width: 20,
    x: 5,
    y: 6,
  },
  node_line: {
    children: [],
    height: 30,
    id: "node_line",
    name: "Line",
    pathData: "M0,0L40,30",
    strokes: [{ color: "#ff0000", type: "solid", width: 4 }],
    type: "PATH",
    width: 40,
    x: 10,
    y: 20,
  },
  node_mirror: {
    children: ["node_mirrored"],
    flipX: true,
    height: 100,
    id: "node_mirror",
    name: "Mirror",
    type: "FRAME",
    width: 200,
    x: 400,
    y: 100,
  },
  node_mirrored: {
    children: [],
    height: 30,
    id: "node_mirrored",
    name: "Mirrored",
    rotation: 30,
    type: "RECTANGLE",
    width: 40,
    x: 10,
    y: 20,
  },
  node_turned: {
    children: [],
    height: 30,
    id: "node_turned",
    name: "Turned",
    rotation: 30,
    type: "RECTANGLE",
    width: 40,
    x: 10,
    y: 20,
  },
};

function linear(a, b, c, d) {
  return { a, b, c, d, e: 0, f: 0 };
}

// Penpot selrect + transform + page-level rotation/flips per node.
const PROJECTED = {
  node_board: { rotation: 90, transform: linear(0, 1, -1, 0), x: 100, y: 100 },
  node_child: { rotation: 90, transform: linear(0, 1, -1, 0), x: 195, y: 65 },
  node_group: { rotation: 180, transform: linear(-1, 0, 0, -1), x: 160, y: 180 },
  node_leaf: { rotation: 180, transform: linear(-1, 0, 0, -1), x: 195, y: 204 },
  node_line: { rotation: 90, transform: linear(0, 1, -1, 0), x: 195, y: 65 },
  node_mirror: {
    "flip-x": true,
    rotation: 0,
    transform: linear(-1, 0, 0, 1),
    x: 400,
    y: 100,
  },
  node_mirrored: {
    "flip-x": true,
    rotation: 330,
    transform: linear(-COS30, 0.5, 0.5, COS30),
    x: 550,
    y: 120,
  },
  node_turned: {
    rotation: 120,
    transform: linear(-0.5, COS30, -COS30, -0.5),
    x: 195,
    y: 65,
  },
};
const LINE_CONTENT = [
  { command: "move-to", params: { x: 230, y: 60 } },
  { command: "line-to", params: { x: 200, y: 100 } },
];

async function geometryValues() {
  const manifest = JSON.parse(
    await readFile(join(fixture, "manifest.json"), "utf8"),
  );
  const { entries } = listPackageEntries(manifest);
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of entries) {
    values.set(entry, JSON.parse(await readFile(join(fixture, entry), "utf8")));
  }
  const nodes = values.get("screens/roundtrip.json").presentations[0].nodes;
  Object.assign(nodes, structuredClone(GEOMETRY_NODES));
  nodes.node_canvas.children.push("node_board", "node_mirror");
  return values;
}

async function geometrySnapshot(values) {
  return loadPackageFromValues(
    "memory://geometry-roundtrip.smallpen",
    values ?? (await geometryValues()),
  );
}

function runtimeId(snapshot, nodeId) {
  return snapshot.runtime.nodes.scr_roundtrip.pres_desktop[nodeId];
}

function nodesOf(snapshot) {
  return snapshot.entries["screens/roundtrip.json"].presentations[0].nodes;
}

function placementOf(node) {
  return {
    flipX: node.flipX === true,
    flipY: node.flipY === true,
    rotation: node.rotation ?? 0,
    x: node.x,
    y: node.y,
  };
}

// A mod-obj carrying a node's whole absolute Penpot placement.
function placementChange(snapshot, nodeId, projected, extra = []) {
  const node = GEOMETRY_NODES[nodeId];
  const { height, width } = node;
  return {
    id: runtimeId(snapshot, nodeId),
    operations: [
      { attr: "x", type: "set", val: projected.x },
      { attr: "y", type: "set", val: projected.y },
      { attr: "rotation", type: "set", val: projected.rotation },
      { attr: "flip-x", type: "set", val: projected["flip-x"] === true },
      { attr: "transform", type: "set", val: projected.transform },
      {
        attr: "selrect",
        type: "set",
        val: { height, width, x: projected.x, y: projected.y },
      },
      ...extra,
    ],
    type: "mod-obj",
  };
}

async function applyPenpot(snapshot, changes, commitId) {
  const batch = compilePenpotChanges(snapshot, { changes, commitId });
  return (await prepareOperationBatch(snapshot, batch)).snapshot;
}

test("projected Penpot geometry compiles back to the same parent-relative nodes", async () => {
  const snapshot = await geometrySnapshot();
  const changes = Object.entries(PROJECTED).map(([nodeId, projected]) =>
    placementChange(
      snapshot,
      nodeId,
      projected,
      nodeId === "node_line"
        ? [{ attr: "content", type: "set", val: LINE_CONTENT }]
        : [],
    ),
  );
  const after = nodesOf(await applyPenpot(snapshot, changes, "sync"));
  for (const nodeId of Object.keys(PROJECTED)) {
    assert.deepEqual(
      placementOf(after[nodeId]),
      placementOf(GEOMETRY_NODES[nodeId]),
      nodeId,
    );
  }
  assert.equal(after.node_line.pathData, "M0,0L40,30");
  assert.equal(after.node_line.width, 40);
  assert.equal(after.node_line.height, 30);
});

test("turning a parent in Penpot keeps its descendants' relative geometry", async () => {
  // Board 90 -> 180 about its center: board-local p maps to (300 - x, 200 - y)
  // and Penpot rewrites every descendant's absolute placement.
  const snapshot = await geometrySnapshot();
  const turned = {
    node_board: { rotation: 180, transform: linear(-1, 0, 0, -1), x: 100, y: 100 },
    node_child: { rotation: 180, transform: linear(-1, 0, 0, -1), x: 250, y: 150 },
    node_group: { rotation: 270, transform: linear(0, -1, 1, 0), x: 120, y: 120 },
    node_leaf: { rotation: 270, transform: linear(0, -1, 1, 0), x: 131, y: 150 },
    node_line: { rotation: 180, transform: linear(-1, 0, 0, -1), x: 250, y: 150 },
    node_turned: {
      rotation: 210,
      transform: linear(-COS30, -0.5, 0.5, -COS30),
      x: 250,
      y: 150,
    },
  };
  const changes = Object.entries(turned).map(([nodeId, projected]) =>
    placementChange(
      snapshot,
      nodeId,
      projected,
      nodeId === "node_line"
        ? [
            {
              attr: "content",
              type: "set",
              val: [
                { command: "move-to", params: { x: 290, y: 180 } },
                { command: "line-to", params: { x: 250, y: 150 } },
              ],
            },
          ]
        : [],
    ),
  );
  const after = nodesOf(await applyPenpot(snapshot, changes, "turn-board"));
  assert.equal(after.node_board.rotation, 180);
  for (const nodeId of [
    "node_child",
    "node_group",
    "node_leaf",
    "node_line",
    "node_turned",
  ]) {
    assert.deepEqual(
      placementOf(after[nodeId]),
      placementOf(GEOMETRY_NODES[nodeId]),
      nodeId,
    );
  }
  assert.equal(after.node_line.pathData, "M0,0L40,30");
});

test("a Penpot move inside a turned parent changes both relative axes", async () => {
  // +10 on the page x axis is -10 on the board's local y axis (turned 90).
  const snapshot = await geometrySnapshot();
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: runtimeId(snapshot, "node_child"),
        operations: [{ attr: "x", type: "set", val: 205 }],
        type: "mod-obj",
      },
    ],
    commitId: "move-child",
  });
  assert.deepEqual(batch.operations[0].changes, { x: 10, y: 10 });
});

test("Penpot rotation inside a mirrored parent stores the relative turn", async () => {
  // Mirrored child turned to page rotation 300 (Penpot convention: matrix
  // R(rotation)·diag(-1, 1)): relative to the mirror that is a turn of 60.
  const snapshot = await geometrySnapshot();
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: runtimeId(snapshot, "node_mirrored"),
        operations: [
          { attr: "rotation", type: "set", val: 300 },
          { attr: "transform", type: "set", val: linear(-0.5, COS30, COS30, 0.5) },
        ],
        type: "mod-obj",
      },
    ],
    commitId: "turn-mirrored",
  });
  assert.deepEqual(batch.operations[0].changes, { rotation: 60 });
});

test("reparenting into a turned board keeps the page placement", async () => {
  // Penpot keeps the rectangle's page placement (selrect 80 96 240x120,
  // unturned) and sends only mov-objects. Its center (200, 156) is (106, 50)
  // in the board, and the board's quarter turn is undone by a 270 turn.
  const snapshot = await geometrySnapshot();
  const after = nodesOf(
    await applyPenpot(
      snapshot,
      [
        {
          index: 4,
          "page-id": snapshot.runtime.pages.scr_roundtrip.pres_desktop,
          "parent-id": runtimeId(snapshot, "node_board"),
          shapes: [runtimeId(snapshot, "node_rectangle")],
          type: "mov-objects",
        },
      ],
      "reparent-rectangle",
    ),
  );
  assert.deepEqual(after.node_board.children.at(-1), "node_rectangle");
  assert.deepEqual(placementOf(after.node_rectangle), {
    flipX: false,
    flipY: false,
    rotation: 270,
    x: -14,
    y: -10,
  });
});

test("a Penpot path added in a turned board stores node-local pathData", async () => {
  const snapshot = await geometrySnapshot();
  const boardRuntimeId = runtimeId(snapshot, "node_board");
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: addedPathRuntimeId,
        obj: {
          content: LINE_CONTENT,
          "frame-id": boardRuntimeId,
          height: 30,
          id: addedPathRuntimeId,
          name: "Drawn",
          "parent-id": boardRuntimeId,
          points: [
            { x: 230, y: 60 },
            { x: 230, y: 100 },
            { x: 200, y: 100 },
            { x: 200, y: 60 },
          ],
          rotation: 90,
          selrect: { height: 30, width: 40, x: 195, y: 65 },
          shapes: [],
          transform: linear(0, 1, -1, 0),
          "transform-inverse": linear(0, -1, 1, 0),
          type: "path",
          width: 40,
          x: 195,
          y: 65,
        },
        "page-id": snapshot.runtime.pages.scr_roundtrip.pres_desktop,
        "parent-id": boardRuntimeId,
        type: "add-obj",
      },
    ],
    commitId: "draw-path",
  });
  const node = batch.operations[0].node;
  assert.equal(node.id, addedPathNodeId);
  assert.equal(node.pathData, "M0,0L40,30");
  assert.deepEqual(placementOf(node), {
    flipX: false,
    flipY: false,
    rotation: 0,
    x: 10,
    y: 20,
  });
  // Penpot's page-absolute corner points are derived state, not stored.
  assert.equal(node.points, undefined);
});

function pngPixel(bytes, width, x, y) {
  const buffer = Buffer.from(bytes);
  const chunks = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (buffer.toString("ascii", offset + 4, offset + 8) === "IDAT") {
      chunks.push(buffer.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }
  const pixels = inflateSync(Buffer.concat(chunks));
  const row = y * (width * 4 + 1);
  return [...pixels.subarray(row + 1 + x * 4, row + 1 + x * 4 + 3)];
}

async function render(values) {
  const evidence = await createEvidence(await geometrySnapshot(values), {
    scale: 1,
    selector: { viewFormat: "screenshot" },
  });
  return (x, y) =>
    pngPixel(evidence.render.bytes, evidence.render.width, x, y);
}

test("render.mjs draws composed geometry where the projection places it", async () => {
  const values = await geometryValues();
  const nodes = values.get("screens/roundtrip.json").presentations[0].nodes;
  nodes.node_board.children = ["node_child", "node_group"];
  delete nodes.node_line;
  delete nodes.node_turned;
  nodes.node_child.fills = [{ color: "#0000ff", type: "solid" }];
  nodes.node_leaf.fills = [{ color: "#00ff00", type: "solid" }];
  nodes.node_mirrored.fills = [{ color: "#ff0000", type: "solid" }];
  const pixel = await render(values);
  // Child: projected selrect (195 65 40x30) turned 90 -> page x 200..230,
  // y 60..100, centered on (215, 80).
  assert.deepEqual(pixel(215, 80), [0, 0, 255]);
  assert.deepEqual(pixel(215, 62), [0, 0, 255]);
  assert.notDeepEqual(pixel(197, 80), [0, 0, 255]);
  // The translation-only placement (board origin + child x/y) stays empty.
  assert.notDeepEqual(pixel(130, 135), [0, 0, 255]);
  // Leaf: two quarter turns, projected selrect (195 204 20x10).
  assert.deepEqual(pixel(205, 209), [0, 255, 0]);
  // Mirrored: page rotation 330 about (570, 135); its long axis runs along
  // (cos 30, -sin 30), not (cos 30, sin 30).
  assert.deepEqual(pixel(570, 135), [255, 0, 0]);
  assert.deepEqual(pixel(585, 126), [255, 0, 0]);
  assert.notDeepEqual(pixel(585, 144), [255, 0, 0]);
});

test("moving an ancestor by operation carries a path along without rewriting it", async () => {
  const values = await geometryValues();
  const nodes = values.get("screens/roundtrip.json").presentations[0].nodes;
  nodes.node_board.children = ["node_line"];
  for (const nodeId of ["node_child", "node_group", "node_leaf", "node_turned"]) {
    delete nodes[nodeId];
  }
  const before = await render(values);
  // Line (230 60) -> (200 100): midpoint (215, 80).
  assert.deepEqual(before(215, 80), [255, 0, 0]);

  const snapshot = await geometrySnapshot(values);
  const moved = (
    await prepareOperationBatch(snapshot, {
      baseRevision: snapshot.revision,
      batchId: "batch_move_board",
      operations: [
        {
          changes: { x: 150 },
          nodeId: "node_board",
          presentationId: "pres_desktop",
          screenId: "scr_roundtrip",
          type: "update-presentation-node",
        },
      ],
    })
  ).snapshot;
  const line = nodesOf(moved).node_line;
  assert.equal(line.pathData, "M0,0L40,30");
  assert.deepEqual(placementOf(line), placementOf(GEOMETRY_NODES.node_line));

  nodes.node_board.x = 150;
  const after = await render(values);
  assert.deepEqual(after(265, 80), [255, 0, 0]);
  assert.notDeepEqual(after(215, 80), [255, 0, 0]);

  // The re-projected path (+50 on the page) syncs back unchanged.
  const synced = nodesOf(
    await applyPenpot(
      moved,
      [
        {
          id: runtimeId(moved, "node_line"),
          operations: [
            {
              attr: "content",
              type: "set",
              val: [
                { command: "move-to", params: { x: 280, y: 60 } },
                { command: "line-to", params: { x: 250, y: 100 } },
              ],
            },
            {
              attr: "selrect",
              type: "set",
              val: { height: 30, width: 40, x: 245, y: 65 },
            },
          ],
          type: "mod-obj",
        },
      ],
      "sync-line",
    ),
  ).node_line;
  assert.equal(synced.pathData, "M0,0L40,30");
  assert.deepEqual(placementOf(synced), placementOf(GEOMETRY_NODES.node_line));
});
