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
  readDesignView,
} from "@smallpen/core";
import { openPackage, renderProjection } from "@smallpen/local-package";
import { compilePenpotChanges } from "@smallpen/penpot-adapter";

import { createWebWorkspaceSnapshot } from "../apps/background/src/web-projection.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SCREEN = "scr_design_system";
const PRESENTATION = "pres_desktop";
const INSTANCE = "node_card_instance_idle";
const LABEL = "node_card_instance_idle__node_card_idle_label";
const LABEL_TEXT = "node_card_idle_label:text";

async function fixtureValues() {
  const fixture = join(here, "fixtures", "design-system.smallpen");
  const manifest = JSON.parse(
    await readFile(join(fixture, "manifest.json"), "utf8"),
  );
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of listPackageEntries(manifest).entries) {
    values.set(entry, JSON.parse(await readFile(join(fixture, entry), "utf8")));
  }
  return values;
}

async function product(edit) {
  const values = await fixtureValues();
  edit?.(values);
  return loadPackageFromValues("memory://instance-overrides.smallpen", values);
}

// The product as the web runtime serves it, with runtime ids for projected
// instance children.
async function served(snapshot) {
  const effective = projectEffectiveSnapshot(snapshot, {});
  const projected = await createWebWorkspaceSnapshot(effective, {});
  return { ...effective, runtime: projected.runtime };
}

function projectedNodes(snapshot) {
  return projectScreen(snapshot, SCREEN, { presentationId: PRESENTATION })
    .nodes;
}

function instanceNode(snapshot) {
  return snapshot.entries["screens/screen.json"].presentations[0].nodes[
    INSTANCE
  ];
}

function batch(snapshot, operations, batchId = "overrides") {
  return { baseRevision: snapshot.revision, batchId, operations };
}

function override(fields) {
  return {
    nodeId: INSTANCE,
    presentationId: PRESENTATION,
    screenId: SCREEN,
    ...fields,
  };
}

// Penpot text content for the fixture label (Inter 14, #1b1b1f).
function labelContent(text, fill = "#1b1b1f") {
  return {
    children: [
      {
        children: text.split("\n").map((line) => ({
          children: [
            {
              fills: [{ "fill-color": fill, "fill-opacity": 1 }],
              "font-family": "Inter",
              "font-id": "gfont-inter",
              "font-size": "14",
              "font-style": "normal",
              "font-variant-id": "400",
              "font-weight": "400",
              "line-height": "1.2",
              text: line,
            },
          ],
          type: "paragraph",
        })),
        type: "paragraph-set",
      },
    ],
    type: "root",
  };
}

function labelChange(snapshot, operations) {
  const runtimeId = Object.entries(snapshot.runtime.reverseNodes).find(
    ([, value]) => value.nodeId === LABEL,
  )[0];
  return {
    id: runtimeId,
    operations,
    "page-id": snapshot.runtime.pages[SCREEN][PRESENTATION],
    type: "mod-obj",
  };
}

const userSet = (attr, val) => ({
  attr,
  "ignore-touched": false,
  type: "set",
  val,
});
const syncSet = (attr, val) => ({
  attr,
  "ignore-touched": true,
  type: "set",
  val,
});

// Compiles a Penpot commit against the served snapshot, applies it, and
// returns the next served snapshot.
async function commit(snapshot, changes, commitId = "override") {
  const compiled = compilePenpotChanges(snapshot, { changes, commitId });
  const prepared = await prepareOperationBatch(snapshot, compiled);
  return {
    compiled,
    prepared,
    snapshot: { ...prepared.snapshot, runtime: snapshot.runtime },
  };
}

test("set-instance-override writes an occurrence override and its exact inverse", async () => {
  const before = await product();
  const set = await prepareOperationBatch(
    before,
    batch(before, [
      override({
        overridePath: LABEL_TEXT,
        type: "set-instance-override",
        value: "Hello",
      }),
    ]),
  );
  assert.deepEqual(instanceNode(set.snapshot).instance.overrides, {
    [LABEL_TEXT]: "Hello",
  });
  assert.deepEqual(set.result.inverseBatch.operations, [
    override({ overridePath: LABEL_TEXT, type: "clear-instance-override" }),
  ]);
  // The shared definition and the other occurrence keep the source text.
  const nodes = projectedNodes(set.snapshot);
  assert.equal(nodes[LABEL].text, "Hello");
  assert.deepEqual(nodes[LABEL].touched, ["content-group", "text-content-text"]);
  assert.equal(
    nodes.node_card_instance_pressed__node_card_pressed_label.text,
    "Card",
  );
  const read = readDesignView(set.snapshot, {
    selector: { viewFormat: "structure" },
  });
  assert.equal(read.result.nodes[LABEL].text, "Hello");

  // The inverse restores the bytes, so the revision is the original one.
  const undone = await prepareOperationBatch(
    set.snapshot,
    set.result.inverseBatch,
  );
  assert.equal(undone.result.revision, before.revision);
  assert.equal(
    Object.hasOwn(instanceNode(undone.snapshot).instance, "overrides"),
    false,
  );

  // Replacing an override inverts to the previous value.
  const replaced = await prepareOperationBatch(
    set.snapshot,
    batch(set.snapshot, [
      override({
        overridePath: LABEL_TEXT,
        type: "set-instance-override",
        value: "Bye",
      }),
    ]),
  );
  assert.deepEqual(replaced.result.inverseBatch.operations, [
    override({
      overridePath: LABEL_TEXT,
      type: "set-instance-override",
      value: "Hello",
    }),
  ]);
  const cleared = await prepareOperationBatch(
    set.snapshot,
    batch(set.snapshot, [
      override({ overridePath: LABEL_TEXT, type: "clear-instance-override" }),
    ]),
  );
  assert.equal(cleared.result.revision, before.revision);
  const restored = await prepareOperationBatch(
    cleared.snapshot,
    cleared.result.inverseBatch,
  );
  assert.equal(restored.result.revision, set.result.revision);
});

test("instance override operations reject invalid targets, fields, and values", async () => {
  const before = await product();
  const cases = [
    [{ nodeId: "node_card_hardcoded" }, "missing_instance"],
    [{ overridePath: "node_card_idle_label" }, "invalid_component_override_path"],
    [{ overridePath: ":text" }, "invalid_component_override_path"],
    [{ overridePath: "node_missing:text" }, "missing_component_override_target"],
    [{ overridePath: "node_card_idle_root:text" }, "component_override_type_mismatch"],
    [{ overridePath: "node_card_idle_label:strokes" }, "unsupported_component_override"],
    [{ overridePath: "__proto__:text" }, "invalid_component_override"],
    [{ value: 3 }, "invalid_text_content"],
    [{ value: null }, "invalid_component_override"],
    [
      { overridePath: "node_card_idle_label:opacity", value: 2 },
      "invalid_opacity",
    ],
    [
      { overridePath: "node_card_idle_label:visible", value: "no" },
      "invalid_node_visibility",
    ],
    [
      { overridePath: "node_card_idle_label:fills", value: [{ type: "solid" }] },
      undefined,
    ],
  ];
  for (const [fields, code] of cases) {
    await assert.rejects(
      prepareOperationBatch(
        before,
        batch(before, [
          override({
            overridePath: LABEL_TEXT,
            type: "set-instance-override",
            value: "Hello",
            ...fields,
          }),
        ]),
      ),
      (error) => (code === undefined ? true : error.code === code),
      JSON.stringify(fields),
    );
  }
  await assert.rejects(
    prepareOperationBatch(
      before,
      batch(before, [
        override({ overridePath: LABEL_TEXT, type: "clear-instance-override" }),
      ]),
    ),
    (error) => error.code === "missing_component_override",
  );
});

test("an override path reaches into a nested instance", async () => {
  const before = await product((values) => {
    const components = values.get("components/components.json");
    components.componentSets.push({
      axes: [],
      id: "cmp_panel_set",
      name: "Panel",
      variants: [
        {
          id: "var_panel",
          nodes: {
            node_panel_card: {
              children: [],
              height: 120,
              id: "node_panel_card",
              instance: {
                component: {
                  assetId: "cmp_card_set",
                  packageId: "pkg_design_system",
                },
                variant: { axis_state: "idle" },
              },
              name: "Card",
              type: "INSTANCE",
              width: 200,
              x: 0,
              y: 0,
            },
            node_panel_root: {
              children: ["node_panel_card"],
              componentId: "cmp_panel_set",
              height: 140,
              id: "node_panel_root",
              name: "Panel",
              type: "COMPONENT",
              width: 220,
              x: 0,
              y: 0,
            },
          },
          rootId: "node_panel_root",
          selection: {},
        },
      ],
      visibility: "public",
    });
    const presentation = values.get("screens/screen.json").presentations[0];
    presentation.nodes.node_panel = {
      children: [],
      height: 140,
      id: "node_panel",
      instance: {
        component: { assetId: "cmp_panel_set", packageId: "pkg_design_system" },
        variant: {},
      },
      name: "Panel",
      type: "INSTANCE",
      width: 220,
      x: 420,
      y: 40,
    };
    presentation.nodes.node_canvas.children.push("node_panel");
  });
  const nestedPath = "node_panel_card__node_card_idle_label:text";
  const set = await prepareOperationBatch(
    before,
    batch(before, [
      {
        nodeId: "node_panel",
        overridePath: nestedPath,
        screenId: SCREEN,
        type: "set-instance-override",
        value: "Nested",
      },
    ]),
  );
  assert.equal(
    projectedNodes(set.snapshot)[
      "node_panel__node_panel_card__node_card_idle_label"
    ].text,
    "Nested",
  );
  await assert.rejects(
    prepareOperationBatch(
      before,
      batch(before, [
        {
          nodeId: "node_panel",
          overridePath: "node_panel_card__node_missing:text",
          screenId: SCREEN,
          type: "set-instance-override",
          value: "Nested",
        },
      ]),
    ),
    (error) => error.code === "missing_component_override_target",
  );
});

test("a text override replaces rich source runs instead of hiding behind them", async () => {
  const before = await product((values) => {
    const label =
      values.get("components/components.json").componentSets[0].variants[0]
        .nodes.node_card_idle_label;
    label.textBlocks = [
      {
        runs: [
          { fills: [{ color: "#ff0000", type: "solid" }], text: "Ca" },
          { text: "rd" },
        ],
        textStyle: { fontWeight: 700 },
      },
    ];
    const instance = values.get("screens/screen.json").presentations[0].nodes[
      INSTANCE
    ];
    instance.instance.overrides = { [LABEL_TEXT]: "Hello\nWorld" };
  });
  const label = projectedNodes(before)[LABEL];
  assert.equal(label.text, "Hello\nWorld");
  assert.equal(Object.hasOwn(label, "textBlocks"), false);
  assert.equal(label.textStyle.fontWeight, 700);
  assert.deepEqual(label.fills, [{ color: "#ff0000", type: "solid" }]);
  assert.deepEqual(label.touched, [
    "content-group",
    "text-content-structure",
    "text-content-text",
  ]);
});

test("Penpot edits of an instance child become overrides and render", async () => {
  const base = await served(await product());
  const render = async (snapshot) =>
    Buffer.from(
      (
        await renderProjection(
          snapshot,
          projectScreen(snapshot, SCREEN, { presentationId: PRESENTATION }),
        )
      ).bytes,
    ).toString("base64");
  const baseRender = await render(base);

  const hidden = await commit(base, [
    labelChange(base, [userSet("hidden", true)]),
  ]);
  assert.deepEqual(hidden.compiled.operations, [
    override({
      overridePath: "node_card_idle_label:visible",
      type: "set-instance-override",
      value: false,
    }),
  ]);
  assert.equal(projectedNodes(hidden.snapshot)[LABEL].visible, false);
  assert.notEqual(await render(hidden.snapshot), baseRender);
  const unhidden = await prepareOperationBatch(
    hidden.snapshot,
    hidden.prepared.result.inverseBatch,
  );
  assert.equal(unhidden.result.revision, base.revision);
  assert.equal(await render(unhidden.snapshot), baseRender);

  const typed = await commit(base, [
    labelChange(base, [userSet("content", labelContent("Hello"))]),
  ]);
  assert.deepEqual(typed.compiled.operations, [
    override({
      overridePath: LABEL_TEXT,
      type: "set-instance-override",
      value: "Hello",
    }),
  ]);
  assert.equal(projectedNodes(typed.snapshot)[LABEL].text, "Hello");

  // Each further edit keeps the overrides already written.
  const renamed = await commit(typed.snapshot, [
    labelChange(typed.snapshot, [
      userSet("name", "Greeting"),
      userSet("opacity", 0.5),
    ]),
  ]);
  const recolored = await commit(renamed.snapshot, [
    labelChange(renamed.snapshot, [
      userSet("content", labelContent("Hello", "#ff0000")),
    ]),
  ]);
  assert.deepEqual(instanceNode(recolored.snapshot).instance.overrides, {
    "node_card_idle_label:fills": [{ color: "#ff0000", type: "solid" }],
    "node_card_idle_label:name": "Greeting",
    "node_card_idle_label:opacity": 0.5,
    [LABEL_TEXT]: "Hello",
  });

  // Penpot's undo of the recolor writes the source fill back with the
  // touched groups the label had: the fills override goes away again.
  const undone = await commit(recolored.snapshot, [
    labelChange(recolored.snapshot, [
      {
        touched: [
          "content-group",
          "layer-effects-group",
          "name-group",
          "text-content-text",
        ],
        type: "set-touched",
      },
      syncSet("content", labelContent("Hello")),
    ]),
  ]);
  assert.equal(undone.snapshot.revision, renamed.snapshot.revision);

  // Reset overrides: source values, nil touched and remote-synced marks,
  // as separate changes of one commit.
  const reset = await commit(recolored.snapshot, [
    labelChange(recolored.snapshot, [
      syncSet("content", labelContent("Card")),
      syncSet("name", "Label"),
      syncSet("opacity", 1),
    ]),
    labelChange(recolored.snapshot, [{ touched: null, type: "set-touched" }]),
    labelChange(recolored.snapshot, [
      { "remote-synced": true, type: "set-remote-synced" },
    ]),
  ]);
  assert.equal(
    reset.compiled.operations.every(
      ({ type }) => type === "clear-instance-override",
    ),
    true,
  );
  assert.equal(reset.snapshot.revision, base.revision);
  assert.equal(await render(reset.snapshot), baseRender);
});

test("instance child edits the format cannot hold still fail explicitly", async () => {
  const base = await served(await product());
  for (const operations of [
    [userSet("x", 260)],
    [
      userSet("strokes", [
        {
          "stroke-alignment": "inner",
          "stroke-color": "#000000",
          "stroke-opacity": 1,
          "stroke-style": "solid",
          "stroke-width": 1,
        },
      ]),
    ],
  ]) {
    assert.throws(
      () =>
        compilePenpotChanges(base, {
          changes: [labelChange(base, operations)],
          commitId: "unsupported",
        }),
      (error) => error.code === "component_instance_override_unsupported",
    );
  }
  // A main-component sync (ignore-touched, no set-touched) re-applies the
  // source the projection already draws: it is no override.
  assert.deepEqual(
    compilePenpotChanges(base, {
      changes: [labelChange(base, [syncSet("content", labelContent("Changed"))])],
      commitId: "sync",
    }).operations,
    [],
  );
  // Mixed styles in one text have no override either.
  const rich = labelContent("Hello");
  rich.children[0].children[0].children.push({
    ...rich.children[0].children[0].children[0],
    "font-weight": "700",
    text: " World",
  });
  assert.throws(
    () =>
      compilePenpotChanges(base, {
        changes: [labelChange(base, [userSet("content", rich)])],
        commitId: "rich",
      }),
    (error) => error.code === "component_instance_override_unsupported",
  );
});

test("set-remote-synced is accepted as Penpot sync bookkeeping", async () => {
  const base = await served(await product());
  const instanceRuntimeId =
    base.runtime.nodes[SCREEN][PRESENTATION][INSTANCE];
  const compiled = compilePenpotChanges(base, {
    changes: [
      labelChange(base, [{ "remote-synced": true, type: "set-remote-synced" }]),
      {
        id: instanceRuntimeId,
        operations: [{ "remote-synced": null, type: "set-remote-synced" }],
        "page-id": base.runtime.pages[SCREEN][PRESENTATION],
        type: "mod-obj",
      },
    ],
    commitId: "remote-synced",
  });
  assert.deepEqual(compiled.operations, []);
});

test("an override may target a Component node added earlier in the batch", async () => {
  const before = await product();
  const componentSet = structuredClone(
    before.entries["components/components.json"].componentSets[0],
  );
  const variant = componentSet.variants[0];
  variant.nodes.node_card_idle_badge = {
    children: [],
    height: 12,
    id: "node_card_idle_badge",
    name: "Badge",
    text: "New",
    type: "TEXT",
    width: 30,
    x: 150,
    y: 8,
  };
  variant.nodes.node_card_idle_root.children.push("node_card_idle_badge");
  const applied = await prepareOperationBatch(
    before,
    batch(before, [
      { componentSet, type: "put-component-set" },
      override({
        overridePath: "node_card_idle_badge:text",
        type: "set-instance-override",
        value: "Hot",
      }),
    ]),
  );
  assert.equal(
    projectedNodes(applied.snapshot)[
      "node_card_instance_idle__node_card_idle_badge"
    ].text,
    "Hot",
  );
});

test("Penpot's measured box for an auto-sized overridden label is accepted", async () => {
  const base = await served(
    await product((values) => {
      values.get("components/components.json").componentSets[0].variants[0]
        .nodes.node_card_idle_label.growType = "auto-width";
    }),
  );
  const typed = await commit(base, [
    labelChange(base, [userSet("content", labelContent("A longer label"))]),
  ]);
  // The resize Penpot commits after measuring the new text.
  const measured = compilePenpotChanges(typed.snapshot, {
    changes: [
      labelChange(typed.snapshot, [
        syncSet("width", 120),
        syncSet("selrect", {
          height: 20,
          width: 120,
          x: 212,
          x1: 212,
          x2: 332,
          y: 48,
          y1: 48,
          y2: 68,
        }),
        syncSet("points", [
          { x: 212, y: 48 },
          { x: 332, y: 48 },
          { x: 332, y: 68 },
          { x: 212, y: 68 },
        ]),
      ]),
    ],
    commitId: "measure",
  });
  assert.deepEqual(measured.operations, []);
  // A user resize of the same label is still no override.
  assert.throws(
    () =>
      compilePenpotChanges(typed.snapshot, {
        changes: [labelChange(typed.snapshot, [userSet("width", 120)])],
        commitId: "resize",
      }),
    (error) => error.code === "component_instance_override_unsupported",
  );
});

test("set-remote-synced on a Components page node is a no-op too", async () => {
  const snapshot = await openPackage(
    join(here, "fixtures", "design-system.smallpen"),
  );
  const runtimeId = Object.keys(snapshot.runtime.reverseComponentNodes)[0];
  const compiled = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: runtimeId,
        operations: [{ "remote-synced": true, type: "set-remote-synced" }],
        "page-id": snapshot.runtime.componentsPage,
        type: "mod-obj",
      },
    ],
    commitId: "component-remote-synced",
  });
  assert.deepEqual(compiled.operations, []);
});

test("deleting a whole instance accepts Penpot's per-child deletes", async () => {
  const base = await served(await product());
  const ids = base.runtime.nodes[SCREEN][PRESENTATION];
  const page = base.runtime.pages[SCREEN][PRESENTATION];
  // Penpot's generate-delete-shapes removes each projected child first, then
  // the instance root.
  const compiled = compilePenpotChanges(base, {
    changes: [
      { id: ids[LABEL], "ignore-touched": true, "page-id": page, type: "del-obj" },
      { id: ids[INSTANCE], "page-id": page, type: "del-obj" },
    ],
    commitId: "delete-instance",
  });
  assert.deepEqual(
    compiled.operations.map(({ nodeId, type }) => ({ nodeId, type })),
    [{ nodeId: INSTANCE, type: "delete-presentation-node" }],
  );

  // Removing only a projected child still changes the instance structure.
  assert.throws(
    () =>
      compilePenpotChanges(base, {
        changes: [{ id: ids[LABEL], "page-id": page, type: "del-obj" }],
        commitId: "delete-child",
      }),
    (error) => error.code === "component_instance_override_unsupported",
  );
});
