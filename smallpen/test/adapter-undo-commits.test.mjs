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
const recorded = JSON.parse(
  await readFile(join(here, "fixtures", "penpot-undo-commits.json"), "utf8"),
);
const groupId = "node_e3d95a5930d680188008b90518fe63c3";
const copyId = "node_e3d95a5930d680188008b90514cdfe8a";

async function fixtureValues(name) {
  const fixture = join(here, "fixtures", name);
  const manifest = JSON.parse(
    await readFile(join(fixture, "manifest.json"), "utf8"),
  );
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of listPackageEntries(manifest).entries) {
    values.set(entry, JSON.parse(await readFile(join(fixture, entry), "utf8")));
  }
  return values;
}

// The roundtrip fixture with its Desktop presentation replaced by `nodes`.
async function roundtrip(nodes) {
  const values = await fixtureValues("roundtrip.smallpen");
  if (nodes) {
    values.get("screens/roundtrip.json").presentations[0].nodes =
      structuredClone(nodes);
  }
  return loadPackageFromValues("memory://adapter-undo.smallpen", values);
}

async function commit(snapshot, value) {
  const batch = compilePenpotChanges(snapshot, {
    commitId: "adapter-undo",
    ...value,
  });
  const prepared = await prepareOperationBatch(snapshot, batch);
  return { batch, snapshot: prepared.snapshot };
}

function desktopNodes(snapshot) {
  return snapshot.entries["screens/roundtrip.json"].presentations[0].nodes;
}

function runtime(snapshot, nodeId) {
  return snapshot.runtime.nodes.scr_roundtrip.pres_desktop[nodeId];
}

function pageId(snapshot) {
  return snapshot.runtime.pages.scr_roundtrip.pres_desktop;
}

function modObj(snapshot, nodeId, operations) {
  return {
    id: runtime(snapshot, nodeId),
    operations,
    "page-id": pageId(snapshot),
    type: "mod-obj",
  };
}

test("a recorded duplicate/group/ungroup/delete session and its undos keep Penpot's layer order", async () => {
  let snapshot = await roundtrip(recorded.roundtripSession.start);
  for (const [index, step] of recorded.roundtripSession.steps.entries()) {
    ({ snapshot } = await commit(snapshot, step.commit));
    for (const [parentId, children] of Object.entries(step.order)) {
      assert.deepEqual(
        desktopNodes(snapshot)[parentId].children,
        children,
        `step ${index}: ${parentId}`,
      );
    }
  }
});

test("undoing a delete restores the shape after its recorded sibling", async () => {
  const [, , , deleted, restored] = recorded.roundtripSession.steps;
  assert.equal(restored.commit.changes[1]["after-shape"] !== undefined, true);
  let snapshot = await roundtrip(recorded.roundtripSession.start);
  for (const step of recorded.roundtripSession.steps.slice(0, 3)) {
    ({ snapshot } = await commit(snapshot, step.commit));
  }
  ({ snapshot } = await commit(snapshot, deleted.commit));
  const { batch, snapshot: after } = await commit(snapshot, restored.commit);
  assert.deepEqual(
    desktopNodes(after).node_canvas.children,
    restored.order.node_canvas,
  );
  assert.equal(desktopNodes(after).node_canvas.children.indexOf(copyId), 2);
  assert.deepEqual(
    batch.operations.map(({ type }) => type),
    ["add-presentation-node", "move-presentation-nodes"],
  );
});

test("an undo that sets flip-x / flip-y back to nil compiles to canonical fields", async () => {
  const snapshot = await roundtrip(recorded.flipNullUndo.nodes);
  const { batch, snapshot: after } = await commit(
    snapshot,
    recorded.flipNullUndo.commit,
  );
  for (const operation of batch.operations) {
    assert.equal(Object.hasOwn(operation.changes, "flip-x"), false);
    assert.equal(Object.hasOwn(operation.changes, "flip-y"), false);
  }
  assert.equal(desktopNodes(after)[groupId].y, 116);
  assert.equal(desktopNodes(after)[copyId].y, 0);
  assert.equal(Object.hasOwn(desktopNodes(after)[groupId], "flipX"), false);
});

test("nil Penpot attributes clear the canonical field Penpot would dissoc", async () => {
  const values = await fixtureValues("roundtrip.smallpen");
  Object.assign(
    values.get("screens/roundtrip.json").presentations[0].nodes.node_rectangle,
    {
      backgroundBlur: { id: "blur", type: "background-blur", value: 4 },
      cornerRadius: [4, 4, 4, 4],
      flipX: true,
      locked: true,
      proportionLock: true,
      rotation: 90,
      visible: false,
    },
  );
  const snapshot = await loadPackageFromValues(
    "memory://adapter-null.smallpen",
    values,
  );
  const { snapshot: after } = await commit(snapshot, {
    changes: [
      modObj(
        snapshot,
        "node_rectangle",
        [
          "applied-tokens",
          "background-blur",
          "blocked",
          "grow-type",
          "hidden",
          "metadata",
          "proportion-lock",
          "r1",
          "r2",
          "r3",
          "r4",
        ].map((attr) => ({ attr, type: "set", val: null })),
      ),
    ],
  });
  const node = desktopNodes(after).node_rectangle;
  for (const field of [
    "appliedTokens",
    "backgroundBlur",
    "growType",
    "cornerRadius",
    "locked",
    "proportionLock",
  ]) {
    assert.equal(Object.hasOwn(node, field), false, field);
  }
  assert.equal(node.visible, true);

  // A required attribute cannot be cleared: the adapter says so itself.
  for (const attr of ["height", "name", "width"]) {
    assert.throws(
      () =>
        compilePenpotChanges(snapshot, {
          changes: [
            modObj(snapshot, "node_rectangle", [
              { attr, type: "set", val: null },
            ]),
          ],
          commitId: "required",
        }),
      (error) => ["invalid_node_name", "invalid_node_number"].includes(error.code),
    );
  }
});

test("mov-objects follows Penpot index, after-shape and append rules", async () => {
  const snapshot = await roundtrip(recorded.roundtripSession.start);
  const children = desktopNodes(snapshot).node_canvas.children;
  const [a, b, c, d] = children;
  const move = (shapes, extra) => ({
    changes: [
      {
        "page-id": pageId(snapshot),
        "parent-id": runtime(snapshot, "node_canvas"),
        shapes: shapes.map((nodeId) => runtime(snapshot, nodeId)),
        type: "mov-objects",
        ...extra,
      },
    ],
  });
  const order = async (value) =>
    desktopNodes((await commit(snapshot, value)).snapshot).node_canvas.children;

  // The index counts the moved shape itself (changes.cljc insert-at-index).
  assert.deepEqual(await order(move([a], { index: 2 })), [b, a, c, d]);
  // An index past the end clamps instead of failing.
  assert.deepEqual(await order(move([a], { index: 99 })), [b, c, d, a]);
  // after-shape wins over index; an unknown one falls back to the index.
  assert.deepEqual(
    await order(move([d], { "after-shape": runtime(snapshot, a), index: 0 })),
    [a, d, b, c],
  );
  assert.deepEqual(
    await order(
      move([d], {
        "after-shape": "11111111-1111-4111-8111-111111111111",
        index: 1,
      }),
    ),
    [a, d, b, c],
  );
  // Without an index a shape already in the parent keeps its place.
  assert.deepEqual(await order(move([b])), [a, b, c, d]);
});

test("reorder-children sorts the current children like Penpot", async () => {
  const snapshot = await roundtrip(recorded.roundtripSession.start);
  const [a, b, c, d] = desktopNodes(snapshot).node_canvas.children;
  const { snapshot: after } = await commit(snapshot, {
    changes: [
      {
        "page-id": pageId(snapshot),
        "parent-id": runtime(snapshot, "node_canvas"),
        // Children it omits go first; unknown ids are ignored.
        shapes: [d, c, "node_missing"].map(
          (nodeId) =>
            runtime(snapshot, nodeId) ?? "22222222-2222-4222-8222-222222222222",
        ),
        type: "reorder-children",
      },
    ],
  });
  assert.deepEqual(desktopNodes(after).node_canvas.children, [a, b, d, c]);
});

test("a restored or pasted shape keeps the attributes Penpot sends with it", async () => {
  const snapshot = await roundtrip(recorded.roundtripSession.start);
  const restore = structuredClone(recorded.roundtripSession.steps[4].commit);
  Object.assign(restore.changes[0].obj, {
    blocked: true,
    "blend-mode": "multiply",
    blur: { hidden: false, id: "blur", type: "layer-blur", value: 4 },
    "constraints-h": "scale",
    exports: [{ scale: 1, suffix: "", type: "png" }],
    "hide-in-viewer": false,
    opacity: null,
    "proportion-lock": true,
    shadow: [
      {
        blur: 4,
        color: { color: "#000000", opacity: 0.2 },
        hidden: false,
        id: "shadow",
        "offset-x": 4,
        "offset-y": 4,
        spread: 0,
        style: "drop-shadow",
      },
    ],
  });
  const { snapshot: after } = await commit(snapshot, restore);
  const node = desktopNodes(after)[copyId];
  assert.equal(node.locked, true);
  assert.equal(node.proportionLock, true);
  assert.equal(node["blend-mode"], "multiply");
  assert.equal(node["constraints-h"], "scale");
  assert.equal(node.blur.value, 4);
  assert.equal(node.shadow[0].style, "drop-shadow");
  assert.deepEqual(node.exports, [{ scale: 1, suffix: "", type: "png" }]);
  // Penpot defaults (false flags, nil opacity) stay implicit.
  assert.equal(Object.hasOwn(node, "hide-in-viewer"), false);
  assert.equal(Object.hasOwn(node, "opacity"), false);
});

test("mod-page clears a background, drops a cleared Token link and refuses a new one", async () => {
  const snapshot = await roundtrip();
  const page = (extra) => ({
    changes: [{ id: pageId(snapshot), type: "mod-page", ...extra }],
  });
  const presentation = (value) =>
    value.entries["screens/roundtrip.json"].presentations[0];

  const colored = await commit(
    snapshot,
    page({ background: "#ff0000", "background-token": null }),
  );
  assert.equal(presentation(colored.snapshot).background, "#ff0000");
  const undone = await commit(
    colored.snapshot,
    page({ background: null, "background-token": null }),
  );
  assert.equal(Object.hasOwn(presentation(undone.snapshot), "background"), false);
  const detached = await commit(snapshot, page({ "background-token": null }));
  assert.deepEqual(detached.batch.operations, []);
  assert.throws(
    () =>
      compilePenpotChanges(snapshot, {
        ...page({ background: "#ff0000", "background-token": "color.bg" }),
        commitId: "token",
      }),
    (error) => error.code === "unsupported_penpot_page_attribute",
  );
});

test("a mod-obj that only clears Component metadata is an accepted no-op", async () => {
  const snapshot = await roundtrip();
  const { batch } = await commit(snapshot, {
    changes: [
      modObj(snapshot, "node_rectangle", [
        { attr: "component-id", type: "set", val: null },
        { attr: "component-file", type: "set", val: null },
        { attr: "shape-ref", type: "set", val: null },
      ]),
    ],
  });
  assert.deepEqual(batch.operations, []);
});

async function servedDesignSystem() {
  const product = await loadPackageFromValues(
    "memory://adapter-instance.smallpen",
    await fixtureValues("design-system.smallpen"),
  );
  const effective = projectEffectiveSnapshot(product, {});
  const projected = await createWebWorkspaceSnapshot(effective, {});
  return { ...effective, runtime: projected.runtime };
}

test("moving a component instance restates its projected children without writing them", async () => {
  const snapshot = await servedDesignSystem();
  const label = recorded.instanceMove.changes[1].id;
  assert.equal(
    snapshot.runtime.reverseNodes[label].nodeId,
    "node_card_instance_idle__node_card_idle_label",
  );
  const batch = compilePenpotChanges(snapshot, recorded.instanceMove);
  assert.deepEqual(batch.operations, [
    {
      changes: { x: 210 },
      nodeId: "node_card_instance_idle",
      presentationId: "pres_desktop",
      screenId: "scr_design_system",
      type: "update-presentation-node",
    },
  ]);
  const prepared = await prepareOperationBatch(snapshot, batch);
  assert.equal(
    prepared.snapshot.entries["screens/screen.json"].presentations[0].nodes
      .node_card_instance_idle.x,
    210,
  );
});

test("an edit of a projected instance child that no override holds fails explicitly", async () => {
  const snapshot = await servedDesignSystem();
  const label = recorded.instanceMove.changes[1];
  for (const operations of [
    // The label moves inside an instance that stays put.
    [{ attr: "x", type: "set", val: 260 }],
    [{ attr: "blend-mode", type: "set", val: "multiply" }],
  ]) {
    assert.throws(
      () =>
        compilePenpotChanges(snapshot, {
          changes: [{ ...label, operations }],
          commitId: "override",
        }),
      (error) => error.code === "component_instance_override_unsupported",
    );
  }
  // Nor can its structure change: there is no canonical node to delete.
  assert.throws(
    () =>
      compilePenpotChanges(snapshot, {
        changes: [{ id: label.id, "page-id": label["page-id"], type: "del-obj" }],
        commitId: "structure",
      }),
    (error) => error.code === "component_instance_override_unsupported",
  );
});
