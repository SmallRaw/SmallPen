// The generated Design System page draws copies of screen nodes shifted by a
// board layout offset (projection.cljs `shift-origins`). Penpot reports the
// copy's page-absolute geometry, so a path edit there converts back to the
// source screen only once that offset is removed.
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
// Where the board draws the copy of node_line (source page x 10, y 40).
const OFFSET = { x: 500, y: 300 };

async function lineSnapshot() {
  const manifest = JSON.parse(
    await readFile(join(fixture, "manifest.json"), "utf8"),
  );
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of listPackageEntries(manifest).entries) {
    values.set(entry, JSON.parse(await readFile(join(fixture, entry), "utf8")));
  }
  const nodes = values.get("screens/roundtrip.json").presentations[0].nodes;
  nodes.node_line = {
    children: [],
    height: 30,
    id: "node_line",
    name: "Line",
    pathData: "M0,0L40,30",
    strokes: [{ color: "#ff0000", type: "solid", width: 2 }],
    type: "PATH",
    width: 40,
    x: 10,
    y: 40,
  };
  nodes.node_canvas.children.push("node_line");
  return loadPackageFromValues("memory://layout-offset.smallpen", values);
}

// The end point drags 10px right and down on the board copy.
function boardPathEdit(snapshot, offset) {
  const x = 10 + OFFSET.x;
  const y = 40 + OFFSET.y;
  return {
    id: snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_line,
    operations: [
      {
        attr: "content",
        type: "set",
        val: [
          { command: "move-to", params: { x, y } },
          { command: "line-to", params: { x: x + 50, y: y + 40 } },
        ],
      },
      {
        attr: "selrect",
        type: "set",
        val: {
          height: 40,
          width: 50,
          x,
          x1: x,
          x2: x + 50,
          y,
          y1: y,
          y2: y + 40,
        },
      },
      { attr: "width", type: "set", val: 50 },
      { attr: "height", type: "set", val: 40 },
    ],
    "page-id": snapshot.runtime.designSystemPage,
    ...(offset === undefined ? {} : { "smallpen-layout-offset": offset }),
    type: "mod-obj",
  };
}

test("a board path edit with its layout offset maps back to the source node", async () => {
  const snapshot = await lineSnapshot();
  assert.equal(
    snapshot.runtime.reverseDesignSystem[
      snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_line
    ].kind,
    "page-node",
  );
  const batch = compilePenpotChanges(snapshot, {
    changes: [boardPathEdit(snapshot, OFFSET)],
    commitId: "board-path",
  });
  assert.deepEqual(batch.operations.map(({ changes }) => changes), [
    { height: 40, pathData: "M0,0L50,40", width: 50 },
  ]);
  const { snapshot: after } = await prepareOperationBatch(snapshot, batch);
  const line =
    after.entries["screens/roundtrip.json"].presentations[0].nodes.node_line;
  assert.equal(line.x, 10);
  assert.equal(line.y, 40);
});

test("a board path edit without its layout offset fails instead of moving the source", async () => {
  const snapshot = await lineSnapshot();
  assert.throws(
    () =>
      compilePenpotChanges(snapshot, {
        changes: [boardPathEdit(snapshot)],
        commitId: "board-path-unshifted",
      }),
    (error) => error?.code === "design_system_layout_offset_missing",
  );
});

test("a malformed layout offset is rejected", async () => {
  const snapshot = await lineSnapshot();
  for (const offset of [{ x: 1 }, { x: "1", y: 2 }, 5]) {
    assert.throws(
      () =>
        compilePenpotChanges(snapshot, {
          changes: [boardPathEdit(snapshot, offset)],
          commitId: "board-path-bad-offset",
        }),
      (error) => error?.code === "invalid_penpot_change",
    );
  }
});
