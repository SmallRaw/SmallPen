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
    values.set(entry, JSON.parse(await readFile(join(fixture, entry), "utf8")));
  }
  return values;
}

function textContent(lines, fill = "#000000") {
  return {
    children: [
      {
        children: lines.map((line) => ({
          children: [
            {
              fills: [{ "fill-color": fill, "fill-opacity": 1 }],
              "font-family": "sourcesanspro",
              "font-id": "sourcesanspro",
              "font-size": "14",
              "font-style": "normal",
              "font-variant-id": "regular",
              "font-weight": "400",
              "letter-spacing": "0",
              "line-height": "1.2",
              text: line,
              "text-decoration": "none",
              "text-transform": "none",
            },
          ],
          "text-align": "left",
          "text-direction": "ltr",
          type: "paragraph",
        })),
        type: "paragraph-set",
      },
    ],
    type: "root",
    "vertical-align": "top",
  };
}

async function textSnapshot() {
  const values = await fixtureValues();
  const node = values.get("screens/roundtrip.json").presentations[0].nodes
    .node_rectangle;
  node.type = "TEXT";
  node.text = "Hello 👋\n世界";
  node.growType = "auto-width";
  node.fills = [{ color: "#2563eb", opacity: 1, type: "solid" }];
  return loadPackageFromValues("memory://text.smallpen", values);
}

test("plain multiline text content compiles, applies, and reverses", async () => {
  const snapshot = await textSnapshot();
  const runtimeId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle;
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: runtimeId,
        operations: [
          {
            attr: "content",
            type: "set",
            val: textContent(["Updated 👩🏽‍💻", "第二行"], "#2563eb"),
          },
          { attr: "grow-type", type: "set", val: "auto-height" },
          { attr: "position-data", type: "set", val: [] },
        ],
        type: "mod-obj",
      },
    ],
    commitId: "edit-text",
  });
  assert.deepEqual(batch.operations[0].changes, {
    growType: "auto-height",
    text: "Updated 👩🏽‍💻\n第二行",
  });

  const prepared = await prepareOperationBatch(snapshot, batch);
  const node =
    prepared.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_rectangle;
  assert.equal(node.text, "Updated 👩🏽‍💻\n第二行");
  assert.equal(node.growType, "auto-height");
  assert.deepEqual(node.fills, [
    { color: "#2563eb", opacity: 1, type: "solid" },
  ]);

  const reversed = await prepareOperationBatch(
    prepared.snapshot,
    prepared.result.inverseBatch,
  );
  assert.equal(reversed.snapshot.revision, snapshot.revision);
});

test("Penpot text layout cache updates are accepted as a no-op", async () => {
  const snapshot = await textSnapshot();
  const runtimeId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle;
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: runtimeId,
        operations: [
          {
            attr: "position-data",
            type: "set",
            val: [{ height: 20, text: "Hello", width: 40, x: 0, y: 0 }],
          },
        ],
        type: "mod-obj",
      },
    ],
    commitId: "text-layout-cache",
  });

  assert.deepEqual(batch.operations, []);
  const prepared = await prepareOperationBatch(snapshot, batch);
  assert.equal(prepared.snapshot.revision, snapshot.revision);
  assert.deepEqual(prepared.result.changedFiles, []);
});

test("a new Penpot text shape keeps its runtime identity", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://add-text.smallpen",
    await fixtureValues(),
  );
  const runtimeId = "aaaaaaaa-4444-4444-8444-444444444444";
  const nodeId = "node_aaaaaaaa444444448444444444444444";
  const pageId = snapshot.runtime.pages.scr_roundtrip.pres_desktop;
  const parentId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_canvas;
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: runtimeId,
        obj: {
          content: textContent(["New text"]),
          fills: [],
          "frame-id": parentId,
          "grow-type": "auto-width",
          height: 24,
          id: runtimeId,
          name: "New text",
          "parent-id": parentId,
          rotation: 0,
          shapes: [],
          strokes: [],
          type: "text",
          width: 80,
          x: 120,
          y: 180,
        },
        "page-id": pageId,
        "parent-id": parentId,
        type: "add-obj",
      },
    ],
    commitId: "add-text",
  });
  const added = await prepareOperationBatch(snapshot, batch);
  const node =
    added.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes[
      nodeId
    ];
  assert.equal(node.type, "TEXT");
  assert.equal(node.text, "New text");
  assert.equal(node.growType, "auto-width");
  assert.equal(
    added.snapshot.runtime.nodes.scr_roundtrip.pres_desktop[nodeId],
    runtimeId,
  );

  const reversed = await prepareOperationBatch(
    added.snapshot,
    added.result.inverseBatch,
  );
  assert.equal(reversed.snapshot.revision, snapshot.revision);
});

test("uniform Penpot typography becomes vendor-neutral textStyle", async () => {
  const snapshot = await textSnapshot();
  const runtimeId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle;
  const content = textContent(["Styled text"], "#2563eb");
  const span = content.children[0].children[0].children[0];
  span["font-family"] = "Inter";
  span["font-id"] = "gfont-inter";
  span["font-size"] = "18";
  span["font-variant-id"] = "600";
  span["font-weight"] = "600";
  span["letter-spacing"] = "0.5";
  span["line-height"] = "1.4";
  span["text-align"] = "left";
  span["text-direction"] = "ltr";
  const paragraph = content.children[0].children[0];
  paragraph["text-align"] = "center";
  paragraph["text-direction"] = "rtl";

  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: runtimeId,
        operations: [{ attr: "content", type: "set", val: content }],
        type: "mod-obj",
      },
    ],
    commitId: "uniform-text-style",
  });
  assert.deepEqual(batch.operations[0].changes, {
    text: "Styled text",
    textStyle: {
      fontFamily: "Inter",
      fontId: "gfont-inter",
      fontSize: 18,
      fontVariantId: "600",
      fontWeight: 600,
      letterSpacing: 0.5,
      lineHeight: 1.4,
      textAlign: "center",
      textDirection: "rtl",
    },
  });
  const prepared = await prepareOperationBatch(snapshot, batch);
  assert.deepEqual(
    prepared.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_rectangle.textStyle,
    batch.operations[0].changes.textStyle,
  );
  const reversed = await prepareOperationBatch(
    prepared.snapshot,
    prepared.result.inverseBatch,
  );
  assert.equal(reversed.snapshot.revision, snapshot.revision);
});

test("Penpot unset text styles inherit instead of entering Canonical data", async () => {
  const snapshot = await textSnapshot();
  const runtimeId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle;
  const content = textContent(["Reset text transform"], "#2563eb");
  const paragraph = content.children[0].children[0];
  paragraph["text-transform"] = "unset";
  paragraph.children[0]["text-transform"] = "unset";

  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: runtimeId,
        operations: [{ attr: "content", type: "set", val: content }],
        type: "mod-obj",
      },
    ],
    commitId: "unset-text-style",
  });

  assert.deepEqual(batch.operations[0].changes, {
    text: "Reset text transform",
  });
  const prepared = await prepareOperationBatch(snapshot, batch);
  const node =
    prepared.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_rectangle;
  assert.equal(node.text, "Reset text transform");
  assert.equal(node.textStyle, undefined);
});

test("mixed text styles become explicit text blocks and runs", async () => {
  const snapshot = await textSnapshot();
  const runtimeId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle;
  const content = textContent(["Mixed style"], "#2563eb");
  const paragraph = content.children[0].children[0];
  paragraph.children = [
    { ...paragraph.children[0], text: "Mixed " },
    { ...paragraph.children[0], "font-size": "16", text: "style" },
  ];
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: runtimeId,
        operations: [{ attr: "content", type: "set", val: content }],
        type: "mod-obj",
      },
    ],
    commitId: "rich-text-runs",
  });
  assert.deepEqual(batch.operations[0].changes, {
    text: "Mixed style",
    textBlocks: [
      {
        runs: [
          { text: "Mixed " },
          { text: "style", textStyle: { fontSize: 16 } },
        ],
      },
    ],
  });
  const prepared = await prepareOperationBatch(snapshot, batch);
  assert.deepEqual(
    prepared.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_rectangle.textBlocks,
    batch.operations[0].changes.textBlocks,
  );
  const reversed = await prepareOperationBatch(
    prepared.snapshot,
    prepared.result.inverseBatch,
  );
  assert.equal(reversed.snapshot.revision, snapshot.revision);
});
