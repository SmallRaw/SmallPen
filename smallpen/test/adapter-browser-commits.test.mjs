// Penpot commits recorded from the release frontend in a browser edit tour.
// Each one used to be rejected although it is a plain design edit.
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
  projectScreen,
} from "@smallpen/core";
import { compilePenpotChanges } from "@smallpen/penpot-adapter";

import { createWebWorkspaceSnapshot } from "../apps/background/src/web-projection.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SCREEN = "scr_design_system";
const PRESENTATION = "pres_desktop";
const SWATCH = "node_swatch_primary";

const EXAMPLE = join(here, "..", "examples", "common-components.smallpen");

async function served(
  fixture = join(here, "fixtures", "design-system.smallpen"),
  edit = undefined,
) {
  const manifest = JSON.parse(
    await readFile(join(fixture, "manifest.json"), "utf8"),
  );
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of listPackageEntries(manifest).entries) {
    values.set(entry, JSON.parse(await readFile(join(fixture, entry), "utf8")));
  }
  edit?.(values);
  const snapshot = await loadPackageFromValues("memory://browser.smallpen", values);
  const effective = projectEffectiveSnapshot(snapshot, {});
  const projected = await createWebWorkspaceSnapshot(effective, {});
  return { ...effective, runtime: projected.runtime };
}

function runtimeId(snapshot, nodeId) {
  return Object.entries(snapshot.runtime.reverseNodes).find(
    ([, value]) => value.nodeId === nodeId,
  )[0];
}

function modObj(snapshot, nodeId, operations) {
  return {
    id: runtimeId(snapshot, nodeId),
    operations,
    "page-id": snapshot.runtime.pages[SCREEN][PRESENTATION],
    type: "mod-obj",
  };
}

async function prepare(snapshot, changes, commitId) {
  const compiled = compilePenpotChanges(snapshot, { changes, commitId });
  return (await prepareOperationBatch(snapshot, compiled)).snapshot;
}

async function apply(snapshot, changes, commitId) {
  return (await prepare(snapshot, changes, commitId)).entries[
    "screens/screen.json"
  ].presentations[0].nodes;
}

const userSet = (attr, val) => ({
  attr,
  "ignore-geometry": false,
  "ignore-touched": false,
  type: "set",
  val,
});

test("a stroke width edit that also sets every side to that width is accepted", async () => {
  const snapshot = await served();
  // Recorded: the stroke width input (stroke-width-all-attrs) writes the
  // four sides with the width.
  const stroke = {
    "stroke-color": "#000000",
    "stroke-width-left": 3,
    "stroke-alignment": "inner",
    "stroke-width": 3,
    "stroke-opacity": 1,
    "stroke-width-right": 3,
    "stroke-width-bottom": 3,
    "stroke-width-top": 3,
    "stroke-style": "solid",
  };
  const nodes = await apply(
    snapshot,
    [
      modObj(snapshot, SWATCH, [
        {
          type: "set",
          attr: "strokes",
          val: [stroke],
          "ignore-geometry": false,
          "ignore-touched": false,
        },
      ]),
    ],
    "stroke-width",
  );
  assert.deepEqual(nodes[SWATCH].strokes, [
    {
      alignment: "inner",
      color: "#000000",
      opacity: 1,
      style: "solid",
      type: "solid",
      width: 3,
    },
  ]);
  // A real per-side width still has no place in the format.
  assert.throws(
    () =>
      compilePenpotChanges(snapshot, {
        changes: [
          modObj(snapshot, SWATCH, [
            {
              type: "set",
              attr: "strokes",
              val: [{ ...stroke, "stroke-width-top": 6 }],
            },
          ]),
        ],
        commitId: "per-side",
      }),
    (error) =>
      error.code === "unsupported_penpot_stroke" &&
      error.details.fields.join() === "stroke-width-top",
  );
});

test("a flex layout added in Penpot projects back where Penpot placed the children", async () => {
  const snapshot = await served();
  // Recorded: Shift+A on Fixture Canvas. Penpot picks column-reverse,
  // writes row-gap/column-gap, and moves each child into the column.
  const layout = [
    userSet("layout-gap-type", "multiple"),
    userSet("layout-padding", { p1: 40, p2: 40, p3: 40, p4: 40 }),
    userSet("layout-wrap-type", "nowrap"),
    userSet("layout", "flex"),
    userSet("layout-align-items", "start"),
    userSet("layout-padding-type", "simple"),
    userSet("layout-gap", { "row-gap": 0, "column-gap": 0 }),
    userSet("layout-justify-content", "start"),
    userSet("layout-flex-dir", "column-reverse"),
    userSet("layout-align-content", "stretch"),
  ];
  const placed = {
    node_swatch_primary: [40, 40],
    node_swatch_radius: [40, 120],
    node_card_instance_idle: [40, 200],
    node_card_instance_pressed: [40, 320],
    node_card_hardcoded: [40, 440],
  };
  const moves = Object.entries(placed).map(([nodeId, [x, y]]) =>
    modObj(snapshot, nodeId, [
      { ...userSet("x", x), "ignore-touched": true },
      { ...userSet("y", y), "ignore-touched": true },
    ]),
  );
  const next = await prepare(
    snapshot,
    [modObj(snapshot, "node_canvas", layout), ...moves],
    "flex",
  );
  const position = (nodes) =>
    Object.fromEntries(
      Object.keys(placed).map((id) => [id, [nodes[id].x, nodes[id].y]]),
    );
  const projected = projectScreen(next, SCREEN, {
    presentationId: PRESENTATION,
  }).nodes;
  assert.deepEqual(position(projected), placed);

  // A plain column starts with the top layer (the last child), and the
  // Penpot row-gap spaces it.
  const column = await prepare(
    next,
    [
      modObj(snapshot, "node_canvas", [
        userSet("layout-flex-dir", "column"),
        userSet("layout-gap", { "row-gap": 10, "column-gap": 0 }),
      ]),
    ],
    "column",
  );
  assert.deepEqual(
    position(
      projectScreen(column, SCREEN, { presentationId: PRESENTATION }).nodes,
    ),
    {
      node_swatch_primary: [40, 520],
      node_swatch_radius: [40, 430],
      node_card_instance_idle: [40, 300],
      node_card_instance_pressed: [40, 170],
      node_card_hardcoded: [40, 40],
    },
  );
});

test("centered flex content that overflows projects where Penpot put it", async () => {
  const snapshot = await served();
  const flex = await prepare(
    snapshot,
    [
      modObj(snapshot, "node_canvas", [
        userSet("layout", "flex"),
        userSet("layout-flex-dir", "column-reverse"),
        userSet("layout-padding", { p1: 40, p2: 40, p3: 40, p4: 40 }),
        userSet("layout-gap", { "row-gap": 0, "column-gap": 0 }),
      ]),
    ],
    "flex",
  );
  // Recorded: the justify-content center button. The 520px column does
  // not fit the 320px inner height, so Penpot starts it 100px above the
  // padding edge.
  const centered = await prepare(
    flex,
    [modObj(snapshot, "node_canvas", [userSet("layout-justify-content", "center")])],
    "center",
  );
  const nodes = projectScreen(centered, SCREEN, {
    presentationId: PRESENTATION,
  }).nodes;
  assert.deepEqual(
    [nodes.node_swatch_primary.y, nodes.node_card_hardcoded.y],
    [-60, 340],
  );
});

test("a copy dropped from Assets moves with its children in the same session", async () => {
  const example = join(here, "..", "examples", "common-components.smallpen");
  const manifest = JSON.parse(
    await readFile(join(example, "manifest.json"), "utf8"),
  );
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of listPackageEntries(manifest).entries) {
    values.set(entry, JSON.parse(await readFile(join(example, entry), "utf8")));
  }
  const start = await loadPackageFromValues("memory://dropped.smallpen", values);
  // The Background keeps the Penpot ids of the dropped copy's children
  // until the page reloads (server.mjs projectedRuntimeIds).
  const sessionIds = new Map();
  const serve = async (snapshot) => {
    const effective = projectEffectiveSnapshot(snapshot, {});
    const projected = await createWebWorkspaceSnapshot(effective, {});
    for (const [id, descriptor] of sessionIds) {
      projected.runtime.reverseNodes[id] ??= descriptor;
    }
    return { ...effective, runtime: projected.runtime };
  };
  const servedStart = await serve(start);
  const recorded = JSON.parse(
    (
      await readFile(
        join(here, "fixtures", "penpot-dropped-copy-commits.json"),
        "utf8",
      )
    ).replaceAll("__FILE__", servedStart.runtime.file),
  );
  const dropped = compilePenpotChanges(servedStart, recorded.dropVariant, {
    projectedRuntimeIds: sessionIds,
  });
  const afterDrop = await serve(
    (await prepareOperationBatch(servedStart, dropped)).snapshot,
  );
  // Recorded: Shift+ArrowDown moves the root and each child by 10px.
  const moved = compilePenpotChanges(afterDrop, recorded.moveDropped);
  assert.deepEqual(moved.operations, [
    {
      changes: { y: 318 },
      nodeId: "node_eed40d5fae5e803e8008b937f838d8d0",
      presentationId: PRESENTATION,
      screenId: SCREEN,
      type: "update-presentation-node",
    },
  ]);
});

test("a stroke width Token applied to every side binds stroke-width", async () => {
  const snapshot = await served(EXAMPLE);
  // Recorded: clicking the border-width Token on Hardcoded Radius Control.
  const operations = compilePenpotChanges(snapshot, {
    changes: [
      modObj(snapshot, "node_card_hardcoded", [
        userSet("applied-tokens", {
          "stroke-width-left": "border-width",
          "stroke-width-right": "border-width",
          "stroke-width-bottom": "border-width",
          "stroke-width-top": "border-width",
        }),
      ]),
      modObj(snapshot, "node_card_hardcoded", [
        userSet("strokes", [
          {
            "stroke-color": "#000000",
            "stroke-width-left": 1,
            "stroke-alignment": "inner",
            "stroke-width": 1,
            "stroke-opacity": 1,
            "stroke-width-right": 1,
            "stroke-width-bottom": 1,
            "stroke-width-top": 1,
            "stroke-style": "solid",
          },
        ]),
      ]),
    ],
    commitId: "stroke-token",
  }).operations;
  assert.deepEqual(
    operations.map(({ changes }) => changes.appliedTokens),
    [{ "stroke-width": "border-width" }],
  );
  // Different Tokens per side have no canonical binding.
  assert.throws(
    () =>
      compilePenpotChanges(snapshot, {
        changes: [
          modObj(snapshot, "node_card_hardcoded", [
            userSet("applied-tokens", {
              "stroke-width-left": "border-width",
              "stroke-width-top": "border-width",
            }),
          ]),
        ],
        commitId: "stroke-side-token",
      }),
    (error) => error.code === "unsupported_applied_token_attribute",
  );
});

test("a font-weight Token on a text keeps the variant Penpot merges into it", async () => {
  const snapshot = await served(EXAMPLE, (values) => {
    const nodes = values.get("screens/screen.json").presentations[0].nodes;
    nodes.node_canvas.children.push("node_note");
    nodes.node_note = {
      children: [],
      height: 17,
      id: "node_note",
      name: "Tok text",
      text: "Tok text",
      type: "TEXT",
      width: 47,
      x: 60,
      y: 320,
    };
  });
  // Recorded: clicking a font-weight Token (700) with the text selected.
  // The leaf and paragraph also carry the Token's {weight} variant map.
  const style = {
    "line-height": "1.2",
    "font-family": "sourcesanspro",
    fills: [{ "fill-color": "#000000", "fill-opacity": 1 }],
    "text-transform": "none",
    "text-align": "left",
    "font-weight": "700",
    "text-decoration": "none",
    "text-direction": "ltr",
    "font-size": "14",
    "letter-spacing": "0",
    "font-id": "sourcesanspro",
    weight: "700",
    "font-variant-id": "bold",
  };
  const content = {
    type: "root",
    children: [
      {
        type: "paragraph-set",
        children: [
          {
            ...style,
            key: "55u2q",
            type: "paragraph",
            children: [{ ...style, text: "Tok text" }],
          },
        ],
      },
    ],
  };
  const nodes = await apply(
    snapshot,
    [
      modObj(snapshot, "node_note", [
        userSet("applied-tokens", { "font-weight": "weight" }),
      ]),
      modObj(snapshot, "node_note", [
        { ...userSet("content", content), "ignore-touched": true },
      ]),
    ],
    "font-weight-token",
  );
  assert.equal(nodes.node_note.textStyle.fontWeight, 700);
  assert.deepEqual(nodes.node_note.appliedTokens, { "font-weight": "weight" });
});
