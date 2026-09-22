// DSE-002/A1: moving or editing a PATH shape in the normal editor emits a
// mod-obj whose :content carries Penpot path segments. The adapter must
// compile that into the canonical pathData string (the format render.mjs and
// the web projection consume), not reject it as a text-only attribute
// (unexpected_text_attribute). Reproduces the 422 from the ordinary-page
// baseline e2e (audits/2026-09-12-dse-002).
import assert from "node:assert/strict";
import test from "node:test";

import { loadPackageFromValues, prepareOperationBatch } from "@smallpen/core";
import { compilePenpotChanges } from "@smallpen/penpot-adapter";

import { buildEditorPackageValues } from "./fixtures/design-system-editor-fixture.mjs";

async function editorSnapshot() {
  const values = buildEditorPackageValues();
  const manifest = values.get("manifest.json");
  // Unit scope: the linked read-only library is irrelevant for path
  // compilation and is not part of the in-memory fixture set.
  delete manifest.libraries;
  return loadPackageFromValues("memory://editor-path.smallpen", values);
}

// Penpot runtime path content is page-absolute. The canonical node sits at
// x=20,y=80 inside the container at absolute (40,404), so the runtime origin
// is (60,484): local pathData = absolute content − (60,484).
const RUNTIME_ORIGIN = { x: 60, y: 484 };
const TRIANGLE_SEGMENTS_ABSOLUTE = [
  { command: "move-to", params: { x: 0 + RUNTIME_ORIGIN.x, y: 64 + RUNTIME_ORIGIN.y } },
  { command: "line-to", params: { x: 32 + RUNTIME_ORIGIN.x, y: 0 + RUNTIME_ORIGIN.y } },
  { command: "line-to", params: { x: 64 + RUNTIME_ORIGIN.x, y: 64 + RUNTIME_ORIGIN.y } },
  { command: "close-path" },
];

test("path content segments compile to canonical pathData", async () => {
  const snapshot = await editorSnapshot();
  const runtimeId =
    snapshot.runtime.nodes.scr_canvas_home.pres_canvas_home_desktop
      .node_editor_nested_path;
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: runtimeId,
        operations: [
          { attr: "content", type: "set", val: TRIANGLE_SEGMENTS_ABSOLUTE },
        ],
        type: "mod-obj",
      },
    ],
    commitId: "move-path",
  });

  assert.equal(batch.operations.length, 1);
  assert.equal(batch.operations[0].type, "update-presentation-node");
  assert.equal(batch.operations[0].changes.pathData, "M0,64L32,0L64,64Z");
  assert.equal(batch.operations[0].changes.content, undefined);

  const prepared = await prepareOperationBatch(snapshot, batch);
  const node =
    prepared.snapshot.entries["screens/canvas-page-home.json"].presentations[0]
      .nodes.node_editor_nested_path;
  assert.equal(node.pathData, "M0,64L32,0L64,64Z");
});

test("path move with x and content in one change shifts geometry once", async () => {
  const snapshot = await editorSnapshot();
  const runtimeId =
    snapshot.runtime.nodes.scr_canvas_home.pres_canvas_home_desktop
      .node_editor_nested_path;
  // Move right +3px: runtime x 60 → 63, content x follows (y untouched).
  // The compiled canonical x must be 20+3=23 and the local pathData must
  // stay the original shape (no second shift from the stale origin).
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: runtimeId,
        operations: [
          { attr: "x", type: "set", val: 63 },
          {
            attr: "content",
            type: "set",
            val: TRIANGLE_SEGMENTS_ABSOLUTE.map((segment) => ({
              ...segment,
              params: Object.fromEntries(
                Object.entries(segment.params ?? {}).map(([key, value]) => [
                  key,
                  key.endsWith("x") ? value + 3 : value,
                ]),
              ),
            })),
          },
        ],
        type: "mod-obj",
      },
    ],
    commitId: "move-path-with-x",
  });

  assert.equal(batch.operations[0].changes.x, 23);
  assert.equal(batch.operations[0].changes.pathData, "M0,64L32,0L64,64Z");

  const prepared = await prepareOperationBatch(snapshot, batch);
  const node =
    prepared.snapshot.entries["screens/canvas-page-home.json"].presentations[0]
      .nodes.node_editor_nested_path;
  assert.equal(node.x, 23);
  assert.equal(node.pathData, "M0,64L32,0L64,64Z");
});

test("path content string passes through to pathData", async () => {
  const snapshot = await editorSnapshot();
  const runtimeId =
    snapshot.runtime.nodes.scr_canvas_home.pres_canvas_home_desktop
      .node_editor_nested_path;
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: runtimeId,
        operations: [
          { attr: "content", type: "set", val: "M 4,60 L 30,4 L 60,60 Z" },
        ],
        type: "mod-obj",
      },
    ],
    commitId: "move-path-string",
  });
  assert.equal(batch.operations[0].changes.pathData, "M 4,60 L 30,4 L 60,60 Z");
});
