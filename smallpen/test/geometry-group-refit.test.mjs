// Penpot only sends shapes whose page placement changed. After an edit to
// one child it refits the parent group box (common changes_builder
// `resize-parents`: a mod-obj setting selrect, points, x, y, width, height)
// and sends nothing for the other children. Canonical children are relative
// to the group box, so those siblings must be restated to stay in place.
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
import { createEvidence } from "@smallpen/local-package";
import { compilePenpotChanges } from "@smallpen/penpot-adapter";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "roundtrip.smallpen");

function rect(id, x, color) {
  return {
    children: [],
    fills: [{ color, type: "solid" }],
    height: 50,
    id,
    name: id,
    type: "RECTANGLE",
    width: 40,
    x,
    y: 0,
  };
}

// Board at (50, 50); group at board-relative (50, 50), so page (100, 100).
async function groupSnapshot() {
  const manifest = JSON.parse(
    await readFile(join(fixture, "manifest.json"), "utf8"),
  );
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of listPackageEntries(manifest).entries) {
    values.set(entry, JSON.parse(await readFile(join(fixture, entry), "utf8")));
  }
  const nodes = values.get("screens/roundtrip.json").presentations[0].nodes;
  Object.assign(nodes, {
    node_a: rect("node_a", 0, "#dc2626"),
    node_b: rect("node_b", 60, "#2563eb"),
    node_board: {
      children: ["node_group", "node_pinned"],
      height: 300,
      id: "node_board",
      name: "Board",
      type: "FRAME",
      width: 400,
      x: 50,
      y: 50,
    },
    node_group: {
      children: ["node_a", "node_b"],
      height: 50,
      id: "node_group",
      name: "Group",
      type: "GROUP",
      width: 100,
      x: 50,
      y: 50,
    },
    node_pinned: rect("node_pinned", 300, "#16a34a"),
  });
  delete nodes.node_rectangle;
  nodes.node_canvas.children = ["node_board"];
  return loadPackageFromValues("memory://group-refit.smallpen", values);
}

function runtimeId(snapshot, nodeId) {
  return snapshot.runtime.nodes.scr_roundtrip.pres_desktop[nodeId];
}

function box(x, y, width, height) {
  return {
    height,
    width,
    x,
    x1: x,
    x2: x + width,
    y,
    y1: y,
    y2: y + height,
  };
}

function points(x, y, width, height) {
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}

function boxChange(snapshot, nodeId, x, y, width, height, attrs = ["x"]) {
  const values = { height, width, x, y };
  return {
    id: runtimeId(snapshot, nodeId),
    operations: [
      { attr: "selrect", type: "set", val: box(x, y, width, height) },
      { attr: "points", type: "set", val: points(x, y, width, height) },
      ...attrs.map((attr) => ({ attr, type: "set", val: values[attr] })),
    ],
    type: "mod-obj",
  };
}

async function apply(snapshot, changes, commitId) {
  const batch = compilePenpotChanges(snapshot, { changes, commitId });
  const prepared = await prepareOperationBatch(snapshot, batch);
  return {
    batch,
    nodes: prepared.snapshot.entries["screens/roundtrip.json"].presentations[0]
      .nodes,
    snapshot: prepared.snapshot,
  };
}

function regionBounds(evidence, nodeId) {
  const region = evidence.evidence.nodeRegions.find(
    (entry) => entry.nodeId === nodeId,
  );
  return { height: region.height, width: region.width, x: region.x, y: region.y };
}

async function regions(snapshot) {
  const evidence = await createEvidence(snapshot, {
    scale: 1,
    selector: { viewFormat: "screenshot" },
  });
  return Object.fromEntries(
    ["node_a", "node_b", "node_pinned"].map((nodeId) => [
      nodeId,
      regionBounds(evidence, nodeId),
    ]),
  );
}

test("moving one grouped child keeps the untouched sibling in place", async () => {
  const snapshot = await groupSnapshot();
  const before = await regions(snapshot);
  // A moves 30px left; Penpot refits the group to x 70, width 130.
  const { batch, nodes, snapshot: after } = await apply(
    snapshot,
    [
      boxChange(snapshot, "node_a", 70, 100, 40, 50),
      boxChange(snapshot, "node_group", 70, 100, 130, 50, ["x", "width"]),
    ],
    "refit-group",
  );
  assert.deepEqual(
    batch.operations.map(({ changes, nodeId }) => [nodeId, changes]),
    [
      ["node_a", { x: 0 }],
      ["node_group", { width: 130, x: 20 }],
      ["node_b", { x: 90 }],
    ],
  );
  assert.equal(nodes.node_b.x, 90);
  const moved = await regions(after);
  assert.deepEqual(moved.node_b, before.node_b);
  assert.deepEqual(moved.node_a, { ...before.node_a, x: before.node_a.x - 30 });
});

test("a group moved as a whole does not move its children twice", async () => {
  const snapshot = await groupSnapshot();
  const before = await regions(snapshot);
  const { nodes, snapshot: after } = await apply(
    snapshot,
    [
      boxChange(snapshot, "node_group", 110, 100, 100, 50),
      boxChange(snapshot, "node_a", 110, 100, 40, 50),
      boxChange(snapshot, "node_b", 170, 100, 40, 50),
    ],
    "move-group",
  );
  assert.equal(nodes.node_group.x, 60);
  assert.equal(nodes.node_a.x, 0);
  assert.equal(nodes.node_b.x, 60);
  const moved = await regions(after);
  assert.deepEqual(moved.node_b, { ...before.node_b, x: before.node_b.x + 10 });
});

test("resizing a board from its left edge keeps unsent children in place", async () => {
  const snapshot = await groupSnapshot();
  const before = await regions(snapshot);
  // The board grows 20px to the left; nothing inside moves on the page.
  const { nodes, snapshot: after } = await apply(
    snapshot,
    [boxChange(snapshot, "node_board", 30, 50, 420, 300, ["x", "width"])],
    "resize-board",
  );
  assert.equal(nodes.node_board.x, 30);
  assert.equal(nodes.node_group.x, 70);
  assert.equal(nodes.node_pinned.x, 320);
  assert.equal(nodes.node_a.x, 0, "grandchildren stay relative to their group");
  assert.deepEqual(await regions(after), before);
});

test("grouping in one commit places the new group before its moved children", async () => {
  // Penpot groups with add-obj (placeholder box), mov-objects, then a
  // mod-obj fitting the new group around its children.
  const snapshot = await groupSnapshot();
  const before = await regions(snapshot);
  const groupId = "cccccccc-4444-4444-8444-444444444444";
  const pageId = snapshot.runtime.pages.scr_roundtrip.pres_desktop;
  const boardId = runtimeId(snapshot, "node_board");
  const { nodes, snapshot: after } = await apply(
    snapshot,
    [
      {
        id: groupId,
        obj: {
          height: 10,
          id: groupId,
          name: "Pinned group",
          "parent-id": boardId,
          shapes: [],
          type: "group",
          width: 10,
          x: 0,
          y: 0,
        },
        "page-id": pageId,
        "parent-id": boardId,
        type: "add-obj",
      },
      {
        "page-id": pageId,
        "parent-id": groupId,
        shapes: [runtimeId(snapshot, "node_pinned")],
        type: "mov-objects",
      },
      {
        ...boxChange(snapshot, "node_pinned", 350, 50, 40, 50, [
          "x",
          "y",
          "width",
          "height",
        ]),
        id: groupId,
        "page-id": pageId,
      },
    ],
    "group-pinned",
  );
  const group = nodes.node_cccccccc444444448444444444444444;
  assert.deepEqual([group.x, group.y, group.width, group.height], [300, 0, 40, 50]);
  assert.deepEqual([nodes.node_pinned.x, nodes.node_pinned.y], [0, 0]);
  assert.deepEqual((await regions(after)).node_pinned, before.node_pinned);
});
