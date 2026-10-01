import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  listPackageEntries,
  loadPackageFromValues,
  prepareOperationBatch,
  projectEffectiveSnapshot,
  projectScreen,
  SMALLPEN_FORMAT_CAPABILITIES,
} from "@smallpen/core";
import { serveLocalPackage } from "@smallpen/background";
import { openPackage } from "@smallpen/local-package";
import { compilePenpotChanges } from "@smallpen/penpot-adapter";

import { createWebWorkspaceSnapshot } from "../apps/background/src/web-projection.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const recordedText = await readFile(
  join(here, "fixtures", "penpot-instance-commits.json"),
  "utf8",
);
const SCREEN = "scr_design_system";
const PRESENTATION = "pres_desktop";
const DROPPED = "node_d9fdcec0417080ce8008b913d61daf15";
const CANONICAL_NODE_FIELDS = new Set([
  ...SMALLPEN_FORMAT_CAPABILITIES.canonicalWrite.nodeFields,
  "children",
  "componentId",
  "componentVariantId",
  "id",
  "instance",
  "sourceNodeId",
  "type",
]);

async function product() {
  const fixture = join(here, "fixtures", "design-system.smallpen");
  const manifest = JSON.parse(
    await readFile(join(fixture, "manifest.json"), "utf8"),
  );
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of listPackageEntries(manifest).entries) {
    values.set(entry, JSON.parse(await readFile(join(fixture, entry), "utf8")));
  }
  return loadPackageFromValues("memory://instance-adds.smallpen", values);
}

// The product as the web runtime serves it to Penpot.
async function served(snapshot) {
  const effective = projectEffectiveSnapshot(snapshot, {});
  const projected = await createWebWorkspaceSnapshot(effective, {});
  return { ...effective, runtime: projected.runtime };
}

// A recorded commit, with the Penpot file id of this run.
function recorded(snapshot, name) {
  return JSON.parse(recordedText.replaceAll("__FILE__", snapshot.runtime.file))[
    name
  ];
}

async function commit(snapshot, value) {
  const current = await served(snapshot);
  const batch = compilePenpotChanges(current, {
    ...(typeof value === "function" ? value(current) : value),
  });
  const prepared = await prepareOperationBatch(current, batch);
  return { batch, snapshot: prepared.snapshot };
}

function nodes(snapshot) {
  return snapshot.entries["screens/screen.json"].presentations[0].nodes;
}

function runtimeId(snapshot, nodeId) {
  return snapshot.runtime.nodes[SCREEN][PRESENTATION][nodeId];
}

// Penpot deletes the projected children of a copy before its root.
function deleteCommit(current, nodeIds) {
  return {
    changes: nodeIds.map((nodeId) => ({
      id: runtimeId(current, nodeId),
      "page-id": current.runtime.pages[SCREEN][PRESENTATION],
      type: "del-obj",
    })),
    commitId: "delete-instance",
  };
}

function assertCanonicalNodes(batch) {
  for (const operation of batch.operations) {
    if (operation.type !== "add-presentation-node") continue;
    assert.deepEqual(
      Object.keys(operation.node).filter(
        (field) => !CANONICAL_NODE_FIELDS.has(field),
      ),
      [],
      `${operation.node.id} carries non-canonical fields`,
    );
  }
}

test("undo of a deleted Instance with a root override restores its canonical bytes", async () => {
  const start = await served(await product());
  const fill = {
    changes: [
      {
        id: runtimeId(start, "node_card_instance_idle"),
        operations: [
          {
            attr: "fills",
            "ignore-touched": false,
            type: "set",
            val: [{ "fill-color": "#ff0000", "fill-opacity": 1 }],
          },
        ],
        "page-id": start.runtime.pages[SCREEN][PRESENTATION],
        type: "mod-obj",
      },
    ],
    commitId: "fill-instance",
  };
  const { snapshot: filled } = await commit(start, fill);
  const before = nodes(filled).node_card_instance_idle;
  assert.deepEqual(before.fills, [{ color: "#ff0000", type: "solid" }]);
  const { snapshot: deleted } = await commit(filled, (current) =>
    deleteCommit(current, [
      "node_card_instance_idle__node_card_idle_label",
      "node_card_instance_idle",
    ]),
  );
  assert.equal(nodes(deleted).node_card_instance_idle, undefined);

  const { batch, snapshot: restored } = await commit(
    deleted,
    recorded(deleted, "undoDeleteInstance"),
  );
  assert.deepEqual(
    batch.operations.map(({ type }) => type),
    ["add-presentation-node", "move-presentation-nodes"],
  );
  assertCanonicalNodes(batch);
  assert.deepEqual(nodes(restored).node_card_instance_idle, before);
  assert.equal(
    Object.keys(nodes(restored)).some((nodeId) =>
      nodeId.startsWith("node_04876245"),
    ),
    false,
  );
  assert.equal(restored.revision, filled.revision);
});

test("undo of a deleted Instance turns changed copy children back into overrides", async () => {
  const start = await served(await product());
  const { snapshot: overridden } = await prepareOperationBatch(start, {
    baseRevision: start.revision,
    batchId: "child-overrides",
    operations: [
      ["node_card_idle_label:text", "Hello"],
      ["node_card_idle_label:fills", [{ color: "#00ff00", type: "solid" }]],
    ].map(([overridePath, value]) => ({
      nodeId: "node_card_instance_idle",
      overridePath,
      presentationId: PRESENTATION,
      screenId: SCREEN,
      type: "set-instance-override",
      value,
    })),
  });
  const { snapshot: deleted } = await commit(overridden, (current) =>
    deleteCommit(current, [
      "node_card_instance_idle__node_card_idle_label",
      "node_card_instance_idle",
    ]),
  );
  // The recorded undo, as Penpot sends it for this copy: an unchanged root
  // and a label whose text and color are overridden.
  const undo = recorded(deleted, "undoDeleteInstance");
  const [root, , label] = undo.changes;
  delete root.obj.touched;
  root.obj.fills = [{ "fill-color": "#ffffff", "fill-opacity": 1 }];
  label.obj.touched = [
    "content-group",
    "text-content-attribute",
    "text-content-text",
  ];
  const span = label.obj.content.children[0].children[0].children[0];
  span.text = "Hello";
  span.fills = [{ "fill-color": "#00ff00", "fill-opacity": 1 }];

  const { snapshot: restored } = await commit(deleted, undo);
  assert.deepEqual(nodes(restored).node_card_instance_idle.instance.overrides, {
    "node_card_idle_label:fills": [{ color: "#00ff00", type: "solid" }],
    "node_card_idle_label:text": "Hello",
  });
  assert.equal(restored.revision, overridden.revision);
});

test("a variant dropped from Assets is written as a domain Instance at its dropped place", async () => {
  const start = await product();
  const { batch, snapshot: dropped } = await commit(
    start,
    recorded(start, "dropInstance"),
  );
  assertCanonicalNodes(batch);
  // Penpot adds the copy at the page root (x -238), moves it to x -20 with
  // the main's layout offset attached, and reparents it into the canvas at
  // 0,0: the offset belongs to the generated Components page only.
  assert.deepEqual(nodes(dropped)[DROPPED], {
    children: [],
    height: 120,
    id: DROPPED,
    instance: {
      component: { assetId: "cmp_card_set", packageId: "pkg_design_system" },
      variant: { axis_state: "pressed" },
    },
    name: "Card / pressed",
    type: "INSTANCE",
    width: 200,
    x: -20,
    y: 250,
  });
  assert.deepEqual(nodes(dropped).node_canvas.children.slice(-1), [DROPPED]);
  assert.equal(
    Object.hasOwn(nodes(dropped), "node_d9fdcec0417080ce8008b913d61daf16"),
    false,
  );

  // Deleting it and undoing restores the same bytes, without a jump.
  const { snapshot: deleted } = await commit(dropped, (current) =>
    deleteCommit(current, [`${DROPPED}__node_card_pressed_label`, DROPPED]),
  );
  assert.equal(nodes(deleted)[DROPPED], undefined);
  const { batch: undoBatch, snapshot: restored } = await commit(
    deleted,
    recorded(deleted, "undoDeleteDropped"),
  );
  assertCanonicalNodes(undoBatch);
  assert.deepEqual(nodes(restored)[DROPPED], nodes(dropped)[DROPPED]);
  assert.equal(restored.revision, dropped.revision);
});

test("a duplicated Instance copy gets its own id and keeps the source's overrides", async () => {
  const start = await product();
  // The recorded copy under fresh runtime ids, its plugin data still naming
  // the Instance it was duplicated from (which stays on the canvas).
  const duplicate = JSON.parse(
    JSON.stringify(recorded(start, "undoDeleteInstance"))
      .replaceAll(
        "a06aa39b-1d6a-5c3d-8aed-a25c57e260af",
        "5d0c5a3e-0000-4000-8000-00000000d001",
      )
      .replaceAll(
        "04876245-fbba-5998-a5d6-ca946d2f08fe",
        "5d0c5a3e-0000-4000-8000-00000000d002",
      ),
  );
  const { batch, snapshot } = await commit(start, duplicate);
  assertCanonicalNodes(batch);
  const copyId = "node_5d0c5a3e00004000800000000000d001";
  assert.deepEqual(nodes(snapshot)[copyId], {
    ...nodes(start).node_card_instance_idle,
    fills: [{ color: "#ff0000", type: "solid" }],
    id: copyId,
  });
  assert.deepEqual(
    nodes(snapshot).node_card_instance_idle,
    nodes(start).node_card_instance_idle,
  );
});

test("the recorded delete of a copy removes only its canonical Instance", async () => {
  const start = await product();
  const { batch, snapshot } = await commit(
    start,
    recorded(start, "deleteInstance"),
  );
  assert.deepEqual(batch.operations, [
    {
      nodeId: "node_card_instance_pressed",
      presentationId: PRESENTATION,
      screenId: SCREEN,
      type: "delete-presentation-node",
    },
  ]);
  assert.equal(nodes(snapshot).node_card_instance_pressed, undefined);
});

test("a layout offset on a shape outside the generated pages does not shift it", async () => {
  const start = await product();
  const { snapshot } = await commit(start, (current) => ({
    changes: [
      {
        id: runtimeId(current, "node_swatch_primary"),
        operations: [
          { attr: "x", "ignore-touched": false, type: "set", val: 60 },
        ],
        "page-id": current.runtime.pages[SCREEN][PRESENTATION],
        "smallpen-layout-offset": { x: 472, y: 0 },
        type: "mod-obj",
      },
    ],
    commitId: "move-swatch",
  }));
  assert.equal(nodes(snapshot).node_swatch_primary.x, 60);
});

test("a main edit's component sync leaves the canonical Instance to its source", async () => {
  const start = await product();
  const before = nodes(start).node_card_instance_idle;
  const { batch, snapshot } = await commit(start, recorded(start, "mainEdit"));
  assert.deepEqual(nodes(snapshot).node_card_instance_idle, before);
  assert.equal(
    batch.operations.some(({ nodeId }) => nodeId === "node_card_instance_idle"),
    false,
  );
  const projected = projectScreen(snapshot, SCREEN, {
    presentationId: PRESENTATION,
  }).nodes.node_card_instance_idle;
  assert.equal(projected.name, "Card instance / idle");
  assert.deepEqual(projected.fills, [{ color: "#00ff00", type: "solid" }]);
});

test("undo of an Instance root fill edit hands the fill back to the source", async () => {
  const start = await served(await product());
  const fillChange = (current, operations) => ({
    changes: [
      {
        id: runtimeId(current, "node_card_instance_idle"),
        operations,
        "page-id": current.runtime.pages[SCREEN][PRESENTATION],
        type: "mod-obj",
      },
    ],
    commitId: "fill",
  });
  const { snapshot: filled } = await commit(start, (current) =>
    fillChange(current, [
      {
        attr: "fills",
        "ignore-touched": false,
        type: "set",
        val: [{ "fill-color": "#ff0000", "fill-opacity": 1 }],
      },
    ]),
  );
  // Penpot's undo: the old touched groups, then the old value.
  const { snapshot: undone } = await commit(filled, (current) =>
    fillChange(current, [
      { touched: ["name-group"], type: "set-touched" },
      {
        attr: "fills",
        "ignore-touched": true,
        type: "set",
        val: [{ "fill-color": "#ffffff", "fill-opacity": 1 }],
      },
    ]),
  );
  assert.equal(undone.revision, start.revision);
  assert.equal(Object.hasOwn(nodes(undone).node_card_instance_idle, "touched"), false);
});

test("an Instance root that holds its own name or fills projects them as touched", async () => {
  const start = await product();
  const projectedRoot = (snapshot) =>
    projectScreen(snapshot, SCREEN, { presentationId: PRESENTATION }).nodes
      .node_card_instance_idle;
  assert.deepEqual(projectedRoot(start).touched, ["name-group"]);
  const { snapshot: filled } = await commit(start, (current) => ({
    changes: [
      {
        id: runtimeId(current, "node_card_instance_idle"),
        operations: [
          {
            attr: "fills",
            "ignore-touched": false,
            type: "set",
            val: [{ "fill-color": "#ff0000", "fill-opacity": 1 }],
          },
          { attr: "name", "ignore-touched": false, type: "set", val: "Card / idle" },
        ],
        "page-id": current.runtime.pages[SCREEN][PRESENTATION],
        type: "mod-obj",
      },
    ],
    commitId: "fill-and-rename",
  }));
  // Named like its source again, but filled red.
  assert.deepEqual(projectedRoot(filled).touched, ["fill-group"]);
});

test("deleting a freshly dropped Instance before a reload deletes it", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-instance-adds-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  for (const name of ["design-system.smallpen", "dsp-shared.smallpen"]) {
    await cp(join(here, "fixtures", name), join(root, name), {
      recursive: true,
    });
  }
  const service = await serveLocalPackage({
    packagePath: join(root, "design-system.smallpen"),
    port: 0,
  });
  context.after(() => service.close());
  let workspace = await fetch(`${service.url}/v1/workspace`).then((response) =>
    response.json(),
  );
  // The recorded drop, then the recorded delete Penpot sends while the page
  // still holds the copy child under the runtime id it gave it.
  const post = async (name) => {
    const response = await fetch(`${service.url}/v1/penpot/commit`, {
      body: JSON.stringify({
        ...recorded(workspace, name),
        baseRevision: workspace.revision,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    workspace = await fetch(`${service.url}/v1/workspace`).then((next) =>
      next.json(),
    );
  };
  const packageNodes = async () =>
    nodes(await openPackage(join(root, "design-system.smallpen")));
  const instanceId = "node_07f88dd97f3980a08008b91c38c77cd7";
  await post("freshDrop");
  assert.deepEqual((await packageNodes())[instanceId].instance.variant, {
    axis_state: "pressed",
  });
  await post("freshDropDelete");
  assert.equal(
    Object.keys(await packageNodes()).some((nodeId) =>
      nodeId.startsWith(instanceId),
    ),
    false,
  );
});

test("a session-unknown copy child delete rides along with its Instance delete", async () => {
  const start = await product();
  const { snapshot: dropped } = await commit(start, recorded(start, "freshDrop"));
  // A Background without the session mapping (restarted) still accepts it.
  const { batch, snapshot } = await commit(
    dropped,
    recorded(start, "freshDropDelete"),
  );
  assert.deepEqual(
    batch.operations.map(({ nodeId, type }) => [type, nodeId]),
    [["delete-presentation-node", "node_07f88dd97f3980a08008b91c38c77cd7"]],
  );
  assert.equal(nodes(snapshot).node_07f88dd97f3980a08008b91c38c77cd7, undefined);
});
