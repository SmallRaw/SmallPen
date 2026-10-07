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
const newRuntimeId = "44444444-4444-4444-8444-444444444444";
const newNodeId = "node_44444444444444448444444444444444";
const newPageRuntimeId = "77777777-7777-4777-8777-777777777777";
const newPresentationId = "pres_77777777777747778777777777777777";
const nestedParentRuntimeId = "88888888-8888-4888-8888-888888888888";
const nestedParentNodeId = "node_88888888888848888888888888888888";
const nestedChildRuntimeId = "99999999-9999-4999-8999-999999999999";
const nestedChildNodeId = "node_99999999999949998999999999999999";

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

function rectangle(id, overrides = {}) {
  return {
    children: [],
    fills: [{ color: "#2563eb", type: "solid" }],
    height: 80,
    id,
    name: "Structural Rectangle",
    type: "RECTANGLE",
    width: 160,
    x: 120,
    y: 180,
    ...overrides,
  };
}

function penpotRectangle(id, parentId) {
  return {
    "flip-x": null,
    "flip-y": null,
    "frame-id": parentId,
    "parent-id": parentId,
    "proportion-lock": false,
    fills: [{ "fill-color": "#2563eb", "fill-opacity": 1 }],
    height: 80,
    id,
    name: "Structural Rectangle",
    points: [],
    r1: 4,
    r2: 8,
    r3: 12,
    r4: 16,
    rotation: 0,
    selrect: { height: 80, width: 160, x: 120, y: 180 },
    shapes: [],
    strokes: [],
    transform: {},
    "transform-inverse": {},
    type: "rect",
    width: 160,
    x: 120,
    y: 180,
  };
}

test("UUID-backed Canonical node IDs preserve a new Penpot runtime ID", async () => {
  const values = await fixtureValues();
  const screen = values.get("screens/roundtrip.json");
  screen.presentations[0].nodes[newNodeId] = rectangle(newNodeId);
  screen.presentations[0].nodes.node_canvas.children.push(newNodeId);

  const opened = await loadPackageFromValues(
    "memory://uuid-backed-node.smallpen",
    values,
  );
  assert.equal(
    opened.runtime.nodes.scr_roundtrip.pres_desktop[newNodeId],
    newRuntimeId,
  );
  assert.deepEqual(opened.runtime.reverseNodes[newRuntimeId], {
    nodeId: newNodeId,
    presentationId: "pres_desktop",
    screenId: "scr_roundtrip",
  });
});

test("a Penpot add followed by placement applies and reverses atomically", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://add-node.smallpen",
    await fixtureValues(),
  );
  const pageId = snapshot.runtime.pages.scr_roundtrip.pres_desktop;
  const parentId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_canvas;
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        "frame-id": parentId,
        id: newRuntimeId,
        index: 1,
        obj: penpotRectangle(newRuntimeId, parentId),
        "page-id": pageId,
        "parent-id": parentId,
        type: "add-obj",
      },
      {
        index: 1,
        "page-id": pageId,
        "parent-id": parentId,
        shapes: [newRuntimeId],
        type: "mov-objects",
      },
    ],
    commitId: "add-node",
  });

  assert.deepEqual(
    batch.operations.map(({ type }) => type),
    ["add-presentation-node", "move-presentation-nodes"],
  );
  const prepared = await prepareOperationBatch(snapshot, batch);
  const presentation =
    prepared.snapshot.entries["screens/roundtrip.json"].presentations[0];
  assert.deepEqual(presentation.nodes.node_canvas.children, [
    "node_rectangle",
    newNodeId,
  ]);
  assert.deepEqual(presentation.nodes[newNodeId], {
    children: [],
    cornerRadius: [4, 8, 12, 16],
    fills: [{ color: "#2563eb", type: "solid" }],
    height: 80,
    id: newNodeId,
    name: "Structural Rectangle",
    type: "RECTANGLE",
    width: 160,
    x: 120,
    y: 180,
  });
  assert.equal(
    prepared.snapshot.runtime.nodes.scr_roundtrip.pres_desktop[newNodeId],
    newRuntimeId,
  );

  const reversed = await prepareOperationBatch(
    prepared.snapshot,
    prepared.result.inverseBatch,
  );
  assert.equal(reversed.snapshot.revision, snapshot.revision);
});

test("Penpot nested geometry converts page coordinates to parent-relative coordinates", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://nested-geometry.smallpen",
    await fixtureValues(),
  );
  const pageId = snapshot.runtime.pages.scr_roundtrip.pres_desktop;
  const canvasRuntimeId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_canvas;
  const parent = {
    ...penpotRectangle(nestedParentRuntimeId, canvasRuntimeId),
    height: 160,
    name: "Nested frame",
    shapes: [nestedChildRuntimeId],
    type: "frame",
    width: 360,
    x: 120,
    y: 180,
  };
  const child = {
    ...penpotRectangle(nestedChildRuntimeId, nestedParentRuntimeId),
    x: 148,
    y: 224,
  };
  const addedBatch = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: nestedParentRuntimeId,
        obj: parent,
        "page-id": pageId,
        "parent-id": canvasRuntimeId,
        type: "add-obj",
      },
      {
        id: nestedChildRuntimeId,
        obj: child,
        "page-id": pageId,
        "parent-id": nestedParentRuntimeId,
        type: "add-obj",
      },
    ],
    commitId: "nested-add",
  });
  const added = await prepareOperationBatch(snapshot, addedBatch);
  let nodes =
    added.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes;
  assert.deepEqual(
    { x: nodes[nestedParentNodeId].x, y: nodes[nestedParentNodeId].y },
    { x: 120, y: 180 },
  );
  assert.deepEqual(
    { x: nodes[nestedChildNodeId].x, y: nodes[nestedChildNodeId].y },
    { x: 28, y: 44 },
  );

  const movedBatch = compilePenpotChanges(added.snapshot, {
    changes: [
      {
        id: nestedParentRuntimeId,
        "page-id": pageId,
        operations: [
          { attr: "x", type: "set", val: 300 },
          { attr: "y", type: "set", val: 250 },
        ],
        type: "mod-obj",
      },
      {
        id: nestedChildRuntimeId,
        "page-id": pageId,
        operations: [
          { attr: "x", type: "set", val: 328 },
          { attr: "y", type: "set", val: 294 },
        ],
        type: "mod-obj",
      },
    ],
    commitId: "nested-move",
  });
  const moved = await prepareOperationBatch(added.snapshot, movedBatch);
  nodes = moved.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes;
  assert.deepEqual(
    { x: nodes[nestedParentNodeId].x, y: nodes[nestedParentNodeId].y },
    { x: 300, y: 250 },
  );
  assert.deepEqual(
    { x: nodes[nestedChildNodeId].x, y: nodes[nestedChildNodeId].y },
    { x: 28, y: 44 },
  );
});

test("Penpot page-root edits use a Canonical forest and reverse exactly", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://page-root-forest.smallpen",
    await fixtureValues(),
  );
  const pageId = snapshot.runtime.pages.scr_roundtrip.pres_desktop;
  const runtime = snapshot.runtime.nodes.scr_roundtrip.pres_desktop;
  const pageRootId = "00000000-0000-0000-0000-000000000000";

  const add = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: newRuntimeId,
        index: 1,
        obj: penpotRectangle(newRuntimeId, pageRootId),
        "page-id": pageId,
        "parent-id": pageRootId,
        type: "add-obj",
      },
    ],
    commitId: "add-page-root",
  });
  assert.equal(add.operations[0].parentId, null);
  const added = await prepareOperationBatch(snapshot, add);
  const addedPresentation =
    added.snapshot.entries["screens/roundtrip.json"].presentations[0];
  assert.equal(addedPresentation.rootId, "node_canvas");
  assert.deepEqual(addedPresentation.rootIds, ["node_canvas", newNodeId]);
  const addReversed = await prepareOperationBatch(
    added.snapshot,
    added.result.inverseBatch,
  );
  assert.equal(addReversed.snapshot.revision, snapshot.revision);

  const move = compilePenpotChanges(snapshot, {
    changes: [
      {
        index: 1,
        "page-id": pageId,
        "parent-id": pageRootId,
        shapes: [runtime.node_rectangle],
        type: "mov-objects",
      },
    ],
    commitId: "move-to-page-root",
  });
  const moved = await prepareOperationBatch(snapshot, move);
  const movedPresentation =
    moved.snapshot.entries["screens/roundtrip.json"].presentations[0];
  assert.deepEqual(movedPresentation.rootIds, [
    "node_canvas",
    "node_rectangle",
  ]);
  assert.deepEqual(movedPresentation.nodes.node_canvas.children, []);
  const moveReversed = await prepareOperationBatch(
    moved.snapshot,
    moved.result.inverseBatch,
  );
  assert.equal(moveReversed.snapshot.revision, snapshot.revision);

  const reorder = compilePenpotChanges(moved.snapshot, {
    changes: [
      {
        "page-id": pageId,
        "parent-id": pageRootId,
        shapes: [runtime.node_rectangle, runtime.node_canvas],
        type: "reorder-children",
      },
    ],
    commitId: "reorder-page-roots",
  });
  const reordered = await prepareOperationBatch(moved.snapshot, reorder);
  assert.deepEqual(
    reordered.snapshot.entries["screens/roundtrip.json"].presentations[0]
      .rootIds,
    ["node_rectangle", "node_canvas"],
  );
  assert.equal(
    reordered.snapshot.entries["screens/roundtrip.json"].presentations[0]
      .rootId,
    "node_rectangle",
  );
  const reorderReversed = await prepareOperationBatch(
    reordered.snapshot,
    reordered.result.inverseBatch,
  );
  assert.equal(reorderReversed.snapshot.revision, moved.snapshot.revision);

  const remove = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: runtime.node_canvas,
        "page-id": pageId,
        type: "del-obj",
      },
    ],
    commitId: "delete-only-page-root",
  });
  const removed = await prepareOperationBatch(snapshot, remove);
  const removedPresentation =
    removed.snapshot.entries["screens/roundtrip.json"].presentations[0];
  assert.equal(removedPresentation.rootId, null);
  assert.deepEqual(removedPresentation.rootIds, []);
  assert.deepEqual(removedPresentation.nodes, {});
  const removeReversed = await prepareOperationBatch(
    removed.snapshot,
    removed.result.inverseBatch,
  );
  assert.equal(removeReversed.snapshot.revision, snapshot.revision);
});

test("a Penpot page is a canvas: add, rename, move and delete reverse exactly", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://page-lifecycle.smallpen",
    await fixtureValues(),
  );
  const newCanvasId = newPresentationId.replace(/^pres_/, "cnv_");
  const add = compilePenpotChanges(snapshot, {
    changes: [{ id: newPageRuntimeId, name: "Second Page", type: "add-page" }],
    commitId: "add-page",
  });
  assert.deepEqual(add.operations, [
    {
      canvases: [
        { id: "cnv_pages", name: "Pages", screens: ["scr_roundtrip"] },
        { id: newCanvasId, name: "Second Page", screens: [] },
      ],
      type: "put-canvases",
    },
  ]);
  const added = await prepareOperationBatch(snapshot, add);
  assert.equal(
    added.snapshot.runtime.canvases.find(({ id }) => id === newCanvasId).pageId,
    newPageRuntimeId,
    "the canvas keeps the Penpot page id",
  );
  const reversed = await prepareOperationBatch(added.snapshot, added.result.inverseBatch);
  assert.equal(reversed.snapshot.revision, snapshot.revision);

  const renamed = await prepareOperationBatch(added.snapshot, compilePenpotChanges(added.snapshot, {
    changes: [{ id: newPageRuntimeId, name: "Renamed Page", type: "mod-page" }],
    commitId: "rename-page",
  }));
  assert.equal(renamed.snapshot.manifest.canvases[1].name, "Renamed Page");

  const moved = await prepareOperationBatch(added.snapshot, compilePenpotChanges(added.snapshot, {
    changes: [{ id: newPageRuntimeId, index: 0, type: "mov-page" }],
    commitId: "move-page",
  }));
  assert.deepEqual(moved.snapshot.manifest.canvases.map(({ id }) => id), [newCanvasId, "cnv_pages"]);

  const removed = await prepareOperationBatch(added.snapshot, compilePenpotChanges(added.snapshot, {
    changes: [{ id: newPageRuntimeId, type: "del-page" }],
    commitId: "delete-page",
  }));
  assert.deepEqual(removed.snapshot.manifest.canvases.map(({ id }) => id), ["cnv_pages"]);
  const restored = await prepareOperationBatch(removed.snapshot, removed.result.inverseBatch);
  assert.equal(restored.snapshot.revision, added.snapshot.revision);
});

test("copying a whole canvas in the App says to copy its pages with the CLI", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://duplicate-page.smallpen",
    await fixtureValues(),
  );
  const pageRootId = "00000000-0000-0000-0000-000000000000";
  const frameRuntimeId = "88888888-8888-4888-8888-888888888888";
  const childRuntimeId = "99999999-9999-4999-8999-999999999999";
  const frameNodeId = "node_88888888888848888888888888888888";
  const childNodeId = "node_99999999999949998999999999999999";
  const frame = {
    ...penpotRectangle(frameRuntimeId, pageRootId),
    fills: [],
    name: "Duplicated Canvas",
    shapes: [childRuntimeId],
    type: "frame",
  };
  const child = penpotRectangle(childRuntimeId, frameRuntimeId);
  assert.throws(
    () =>
    compilePenpotChanges(snapshot, {
    changes: [
      {
        id: newPageRuntimeId,
        page: {
          id: newPageRuntimeId,
          name: "Duplicated Page",
          objects: {
            [pageRootId]: { id: pageRootId, shapes: [frameRuntimeId] },
            [frameRuntimeId]: frame,
            [childRuntimeId]: child,
          },
        },
        type: "add-page",
      },
    ],
    commitId: "duplicate-page",
    }),
    (error) => error?.code === "duplicate_canvas_unsupported",
  );
});

test("a duplicated Penpot subtree keeps every new runtime identity", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://duplicate-subtree.smallpen",
    await fixtureValues(),
  );
  const pageId = snapshot.runtime.pages.scr_roundtrip.pres_desktop;
  const rootRuntimeId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_canvas;
  const frameRuntimeId = "55555555-5555-4555-8555-555555555555";
  const childRuntimeId = "66666666-6666-4666-8666-666666666666";
  const frameNodeId = "node_55555555555545558555555555555555";
  const childNodeId = "node_66666666666646668666666666666666";
  const frame = {
    ...penpotRectangle(frameRuntimeId, rootRuntimeId),
    fills: [],
    name: "Duplicated Frame",
    shapes: [childRuntimeId],
    type: "frame",
  };
  const child = penpotRectangle(childRuntimeId, frameRuntimeId);
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: frameRuntimeId,
        obj: frame,
        "page-id": pageId,
        "parent-id": rootRuntimeId,
        type: "add-obj",
      },
      {
        id: childRuntimeId,
        obj: child,
        "page-id": pageId,
        "parent-id": frameRuntimeId,
        type: "add-obj",
      },
    ],
    commitId: "duplicate-subtree",
  });

  const duplicated = await prepareOperationBatch(snapshot, batch);
  const presentation =
    duplicated.snapshot.entries["screens/roundtrip.json"].presentations[0];
  assert.deepEqual(presentation.nodes[frameNodeId].children, [childNodeId]);
  assert.equal(
    duplicated.snapshot.runtime.nodes.scr_roundtrip.pres_desktop[frameNodeId],
    frameRuntimeId,
  );
  assert.equal(
    duplicated.snapshot.runtime.nodes.scr_roundtrip.pres_desktop[childNodeId],
    childRuntimeId,
  );

  const reversed = await prepareOperationBatch(
    duplicated.snapshot,
    duplicated.result.inverseBatch,
  );
  assert.equal(reversed.snapshot.revision, snapshot.revision);
});

test("Penpot delete, move, and reorder operations each reverse exactly", async () => {
  const values = await fixtureValues();
  const screen = values.get("screens/roundtrip.json");
  screen.presentations[0].nodes.node_frame = {
    ...rectangle("node_frame", {
      children: [newNodeId],
      name: "Nested Frame",
      type: "FRAME",
      x: 400,
    }),
  };
  screen.presentations[0].nodes[newNodeId] = rectangle(newNodeId, {
    x: 420,
    y: 200,
  });
  screen.presentations[0].nodes.node_canvas.children.push("node_frame");
  const snapshot = await loadPackageFromValues(
    "memory://structural-roundtrip.smallpen",
    values,
  );
  const pageId = snapshot.runtime.pages.scr_roundtrip.pres_desktop;
  const runtime = snapshot.runtime.nodes.scr_roundtrip.pres_desktop;

  const move = compilePenpotChanges(snapshot, {
    changes: [
      {
        index: 0,
        "page-id": pageId,
        "parent-id": runtime.node_frame,
        shapes: [runtime.node_rectangle],
        type: "mov-objects",
      },
    ],
    commitId: "move-node",
  });
  const moved = await prepareOperationBatch(snapshot, move);
  assert.deepEqual(
    moved.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_frame.children,
    ["node_rectangle", newNodeId],
  );
  const moveReversed = await prepareOperationBatch(
    moved.snapshot,
    moved.result.inverseBatch,
  );
  assert.equal(moveReversed.snapshot.revision, snapshot.revision);

  const reorder = compilePenpotChanges(snapshot, {
    changes: [
      {
        "page-id": pageId,
        "parent-id": runtime.node_canvas,
        shapes: [runtime.node_frame, runtime.node_rectangle],
        type: "reorder-children",
      },
    ],
    commitId: "reorder-node",
  });
  const reordered = await prepareOperationBatch(snapshot, reorder);
  assert.deepEqual(
    reordered.snapshot.entries["screens/roundtrip.json"].presentations[0]
      .nodes.node_canvas.children,
    ["node_frame", "node_rectangle"],
  );
  const reorderReversed = await prepareOperationBatch(
    reordered.snapshot,
    reordered.result.inverseBatch,
  );
  assert.equal(reorderReversed.snapshot.revision, snapshot.revision);

  const remove = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: runtime.node_frame,
        "page-id": pageId,
        type: "del-obj",
      },
    ],
    commitId: "delete-node",
  });
  const removed = await prepareOperationBatch(snapshot, remove);
  const removedNodes =
    removed.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes;
  assert.equal(removedNodes.node_frame, undefined);
  assert.equal(removedNodes[newNodeId], undefined);
  const deleteReversed = await prepareOperationBatch(
    removed.snapshot,
    removed.result.inverseBatch,
  );
  assert.equal(deleteReversed.snapshot.revision, snapshot.revision);
});

test("invalid structural operations are rejected without a partial snapshot", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://invalid-structure.smallpen",
    await fixtureValues(),
  );
  const operation = (value) => ({
    baseRevision: snapshot.revision,
    batchId: "invalid_structure",
    operations: [value],
  });

  await assert.rejects(
    prepareOperationBatch(
      snapshot,
      operation({
        nodeId: "node_missing",
        presentationId: "pres_desktop",
        screenId: "scr_roundtrip",
        type: "delete-presentation-node",
      }),
    ),
    (error) => error?.code === "missing_node",
  );
  await assert.rejects(
    prepareOperationBatch(
      snapshot,
      operation({
        childIds: ["node_rectangle", "node_rectangle"],
        parentId: "node_canvas",
        presentationId: "pres_desktop",
        screenId: "scr_roundtrip",
        type: "reorder-presentation-children",
      }),
    ),
    (error) => error?.code === "invalid_child_order",
  );
});

// RV-002-A: adapter saves real page names verbatim; only an exact no-op
// rename is dropped, and the inverse restores the previous name.
test("mod-page names the canvas literally and the inverse restores it (RV-002-A)", async () => {
  const { openPackage } = await import("@smallpen/local-package");
  const { cp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const cases = ["Round Trip · Review", "Plain name", "A · B · C", "Round Trip"];
  for (const [index, name] of cases.entries()) {
    const packagePath = join(tmpdir(), `smallpen-rv002a-${index}.smallpen`);
    await cp(fixture, packagePath, { recursive: true });
    const snapshot = await openPackage(packagePath);
    const pageId = snapshot.runtime.pages.scr_roundtrip.pres_desktop;
    const batch = compilePenpotChanges(snapshot, {
      changes: [{ id: pageId, name, type: "mod-page" }],
      commitId: `11111111-1111-1111-8111-${String(index).padStart(12, "0")}`,
    });
    assert.equal(batch.operations.length, 1, `real name keeps the op: ${name}`);
    assert.equal(batch.operations[0].canvases[0].name, name);
    const prepared = await prepareOperationBatch(snapshot, batch);
    assert.equal(prepared.snapshot.runtime.canvases[0].name, name, `name saved exactly: ${name}`);
    const restored = await prepareOperationBatch(prepared.snapshot, prepared.result.inverseBatch);
    assert.equal(restored.snapshot.manifest.canvases, undefined, `inverse restores the canvases by module for ${name}`);
  }
});

// Fixture variant whose page-root canvas sits away from the origin, so
// parent-relative and page-absolute coordinates differ at every level.
async function offsetCanvasSnapshot() {
  const values = await fixtureValues();
  const nodes = values.get("screens/roundtrip.json").presentations[0].nodes;
  nodes.node_canvas.x = 100;
  nodes.node_canvas.y = 50;
  nodes.node_board = rectangle("node_board", {
    children: [],
    height: 400,
    name: "Board",
    type: "FRAME",
    width: 400,
    x: 300,
    y: 200,
  });
  nodes.node_canvas.children.push("node_board");
  return loadPackageFromValues("memory://offset-canvas.smallpen", values);
}

function nodeAt(snapshot, nodeId) {
  return snapshot.entries["screens/roundtrip.json"].presentations[0].nodes[
    nodeId
  ];
}

function absoluteOrigin(snapshot, nodeId) {
  const nodes =
    snapshot.entries["screens/roundtrip.json"].presentations[0].nodes;
  let x = 0;
  let y = 0;
  let current = nodeId;
  while (current) {
    x += nodes[current].x ?? 0;
    y += nodes[current].y ?? 0;
    current = Object.values(nodes).find((node) =>
      (node.children ?? []).includes(current),
    )?.id;
  }
  return { x, y };
}

test("Penpot reparenting keeps page-absolute positions under an offset parent", async () => {
  const snapshot = await offsetCanvasSnapshot();
  const pageId = snapshot.runtime.pages.scr_roundtrip.pres_desktop;
  const runtime = snapshot.runtime.nodes.scr_roundtrip.pres_desktop;
  const before = absoluteOrigin(snapshot, "node_rectangle");
  assert.deepEqual(before, { x: 180, y: 146 });

  // Drag into a board: Penpot sends only mov-objects; x/y stay absolute.
  const drag = compilePenpotChanges(snapshot, {
    changes: [
      {
        index: 0,
        "page-id": pageId,
        "parent-id": runtime.node_board,
        shapes: [runtime.node_rectangle],
        type: "mov-objects",
      },
    ],
    commitId: "drag-into-board",
  });
  const dragged = await prepareOperationBatch(snapshot, drag);
  assert.deepEqual(
    nodeAt(dragged.snapshot, "node_board").children,
    ["node_rectangle"],
  );
  assert.deepEqual(
    { x: nodeAt(dragged.snapshot, "node_rectangle").x, y: nodeAt(dragged.snapshot, "node_rectangle").y },
    { x: -220, y: -104 },
  );
  assert.deepEqual(absoluteOrigin(dragged.snapshot, "node_rectangle"), before);
  const dragReversed = await prepareOperationBatch(
    dragged.snapshot,
    dragged.result.inverseBatch,
  );
  assert.equal(dragReversed.snapshot.revision, snapshot.revision);

  // Group: a new group at the child's page-absolute box, then the move.
  const group = {
    ...penpotRectangle(newRuntimeId, runtime.node_canvas),
    name: "Group",
    shapes: [runtime.node_rectangle],
    type: "group",
    x: 180,
    y: 146,
    selrect: { height: 80, width: 160, x: 180, y: 146 },
  };
  const grouping = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: newRuntimeId,
        index: 1,
        obj: group,
        "page-id": pageId,
        "parent-id": runtime.node_canvas,
        type: "add-obj",
      },
      {
        index: 0,
        "page-id": pageId,
        "parent-id": newRuntimeId,
        shapes: [runtime.node_rectangle],
        type: "mov-objects",
      },
    ],
    commitId: "group-rectangle",
  });
  const grouped = await prepareOperationBatch(snapshot, grouping);
  assert.deepEqual(
    { x: nodeAt(grouped.snapshot, newNodeId).x, y: nodeAt(grouped.snapshot, newNodeId).y },
    { x: 80, y: 96 },
  );
  assert.deepEqual(
    { x: nodeAt(grouped.snapshot, "node_rectangle").x, y: nodeAt(grouped.snapshot, "node_rectangle").y },
    { x: 0, y: 0 },
  );
  assert.deepEqual(absoluteOrigin(grouped.snapshot, "node_rectangle"), before);

  // Ungroup: the child moves back to the canvas and the group is deleted.
  const ungrouping = compilePenpotChanges(grouped.snapshot, {
    changes: [
      {
        index: 0,
        "page-id": pageId,
        "parent-id": runtime.node_canvas,
        shapes: [runtime.node_rectangle],
        type: "mov-objects",
      },
      { id: newRuntimeId, "page-id": pageId, type: "del-obj" },
    ],
    commitId: "ungroup-rectangle",
  });
  const ungrouped = await prepareOperationBatch(grouped.snapshot, ungrouping);
  assert.equal(nodeAt(ungrouped.snapshot, newNodeId), undefined);
  assert.deepEqual(
    { x: nodeAt(ungrouped.snapshot, "node_rectangle").x, y: nodeAt(ungrouped.snapshot, "node_rectangle").y },
    { x: 80, y: 96 },
  );
  assert.deepEqual(absoluteOrigin(ungrouped.snapshot, "node_rectangle"), before);
});

test("an explicit x/y in the reparenting commit wins over the preserved origin", async () => {
  const snapshot = await offsetCanvasSnapshot();
  const pageId = snapshot.runtime.pages.scr_roundtrip.pres_desktop;
  const runtime = snapshot.runtime.nodes.scr_roundtrip.pres_desktop;
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        index: 0,
        "page-id": pageId,
        "parent-id": runtime.node_board,
        shapes: [runtime.node_rectangle],
        type: "mov-objects",
      },
      {
        id: runtime.node_rectangle,
        "page-id": pageId,
        operations: [{ attr: "x", type: "set", val: 410 }],
        type: "mod-obj",
      },
    ],
    commitId: "drag-and-nudge",
  });
  const moved = await prepareOperationBatch(snapshot, batch);
  // x comes from the explicit page-absolute value; y keeps its origin.
  assert.deepEqual(
    { x: nodeAt(moved.snapshot, "node_rectangle").x, y: nodeAt(moved.snapshot, "node_rectangle").y },
    { x: 10, y: -104 },
  );
});
