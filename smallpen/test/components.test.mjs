import assert from "node:assert/strict";
import { access, cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createCatalog,
  listPackageEntries,
  loadPackageFromValues,
  prepareOperationBatch,
  projectScreen,
} from "@smallpen/core";
import { compilePenpotChanges } from "@smallpen/penpot-adapter";
import { applyOperationBatch, openPackage } from "@smallpen/local-package";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "roundtrip.smallpen");

const componentId = "cmp_55555555555545558555555555555555";
const componentRuntimeId = "55555555-5555-4555-8555-555555555555";
const masterId = "node_66666666666646668666666666666666";
const masterRuntimeId = "66666666-6666-4666-8666-666666666666";
const masterChildId = "node_77777777777747778777777777777777";
const masterChildRuntimeId = "77777777-7777-4777-8777-777777777777";
const instanceId = "node_88888888888848888888888888888888";
const instanceRuntimeId = "88888888-8888-4888-8888-888888888888";
const copyChildId = "node_99999999999949998999999999999999";
const copyChildRuntimeId = "99999999-9999-4999-8999-999999999999";
const variantId = "var_shared_default";
const externalMediaId = "media_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa";
const externalTypographyId = "typo_bbbbbbbbbbbb4bbb8bbbbbbbbbbbbbbb";

function frame(id, overrides = {}) {
  return {
    children: [],
    height: 80,
    id,
    name: "Component frame",
    type: "FRAME",
    width: 160,
    x: 360,
    y: 96,
    ...overrides,
  };
}

function rectangle(id, overrides = {}) {
  return {
    children: [],
    fills: [{ color: "#2563eb", type: "solid" }],
    height: 32,
    id,
    name: "Component child",
    type: "RECTANGLE",
    width: 120,
    x: 380,
    y: 120,
    ...overrides,
  };
}

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

async function componentValues() {
  const values = await fixtureValues();
  const manifest = values.get("manifest.json");
  const screen = values.get("screens/roundtrip.json");
  const presentation = screen.presentations[0];
  manifest.entries.components = ["components/button.json"];
  values.set("components/button.json", {
    id: componentId,
    mainNodeId: masterId,
    name: "Button",
    path: "Controls",
    presentationId: presentation.id,
    screenId: screen.id,
  });
  presentation.nodes[masterId] = frame(masterId, {
    children: [masterChildId],
    componentId,
    name: "Button",
    type: "COMPONENT",
  });
  presentation.nodes[masterChildId] = rectangle(masterChildId);
  presentation.nodes[instanceId] = frame(instanceId, {
    children: [copyChildId],
    componentId,
    name: "Button instance",
    sourceNodeId: masterId,
    type: "INSTANCE",
    x: 560,
  });
  presentation.nodes[copyChildId] = rectangle(copyChildId, {
    sourceNodeId: masterChildId,
    touched: ["fill-group"],
    x: 580,
  });
  presentation.nodes.node_canvas.children.push(masterId, instanceId);
  return values;
}

async function externalComponentSnapshot() {
  const values = await componentValues();
  const manifest = values.get("manifest.json");
  manifest.name = "Shared Components";
  manifest.packageId = "pkg_shared_components";
  return loadPackageFromValues(
    "https://libraries.example/components/manifest.json",
    values,
  );
}

async function externalComponentSetSnapshot({ assetReferences = false } = {}) {
  const values = await fixtureValues();
  const manifest = values.get("manifest.json");
  manifest.entries.components = ["components/shared.json"];
  if (assetReferences) {
    const blob =
      "blobs/6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d";
    manifest.entries.assets = ["assets/shared.json"];
    values.set("assets/shared.json", {
      colors: [],
      fonts: [],
      id: "alib_shared",
      media: [
        {
          blob,
          byteLength: 1,
          height: 24,
          id: externalMediaId,
          mimeType: "image/png",
          name: "Shared mark",
          path: "Brand",
          sha256:
            "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
          width: 24,
        },
      ],
      typographies: [
        {
          id: externalTypographyId,
          name: "Shared heading",
          path: "Text",
          style: {
            fontFamily: "Inter",
            fontId: "gfont-inter",
            fontSize: 24,
            fontStyle: "normal",
            fontVariantId: "regular",
            fontWeight: 700,
            letterSpacing: 0,
            lineHeight: 1.2,
            textTransform: "none",
          },
        },
      ],
    });
    values.set(blob, new Uint8Array([0]));
  }
  manifest.name = "Shared Component Sets";
  manifest.packageId = "pkg_shared_component_sets";
  values.set("components/shared.json", {
    componentSets: [
      {
        axes: [],
        id: componentId,
        name: "Button",
        variants: [
          {
            id: variantId,
            nodes: {
              [masterId]: frame(masterId, {
                children: [masterChildId],
                name: "Button",
              }),
              [masterChildId]: rectangle(masterChildId, {
                ...(assetReferences ? { mediaRef: externalMediaId } : {}),
                ...(assetReferences
                  ? { textStyle: { typographyRef: externalTypographyId } }
                  : {}),
              }),
            },
            rootId: masterId,
            selection: {},
          },
        ],
        visibility: "public",
      },
    ],
  });
  return loadPackageFromValues(
    "https://libraries.example/component-sets/manifest.json",
    values,
  );
}

test("Library Component Sets are discoverable and project with owned asset references", async () => {
  const values = await fixtureValues();
  const presentation = values.get("screens/roundtrip.json").presentations[0];
  presentation.nodes[instanceId] = frame(instanceId, {
    instance: {
      component: {
        assetId: componentId,
        packageId: "pkg_shared_component_sets",
      },
      variant: {},
    },
    name: "Shared Button instance",
    type: "INSTANCE",
  });
  presentation.nodes.node_canvas.children.push(instanceId);
  const product = await loadPackageFromValues(
    "memory://library-component-consumer.smallpen",
    values,
  );
  const library = await externalComponentSetSnapshot({ assetReferences: true });

  const catalog = createCatalog(product, { libraries: [library] });
  assert.equal(
    catalog.components.some(
      (component) =>
        component.id === componentId &&
        component.packageId === "pkg_shared_component_sets" &&
        component.source === "library",
    ),
    true,
  );

  const projection = projectScreen(product, "scr_roundtrip", {
    libraries: [library],
  });
  const root = projection.nodes[instanceId];
  const child = projection.nodes[`${instanceId}__${masterChildId}`];
  assert.equal(root.componentOwnerPackageId, "pkg_shared_component_sets");
  assert.deepEqual(child.mediaRef, {
    assetId: externalMediaId,
    packageId: "pkg_shared_component_sets",
  });
  assert.deepEqual(child.textStyle.typographyRef, {
    assetId: externalTypographyId,
    packageId: "pkg_shared_component_sets",
  });
});

test("component definitions and copy source chains receive stable runtime IDs", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://components.smallpen",
    await componentValues(),
  );

  assert.equal(snapshot.runtime.components[componentId], componentRuntimeId);
  assert.deepEqual(snapshot.runtime.reverseComponents[componentRuntimeId], {
    componentId,
  });
  assert.equal(
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop[masterId],
    masterRuntimeId,
  );

  const invalid = await componentValues();
  invalid.get("screens/roundtrip.json").presentations[0].nodes[
    copyChildId
  ].sourceNodeId = masterId;
  await assert.rejects(
    loadPackageFromValues("memory://invalid-copy.smallpen", invalid),
    (error) => error?.code === "invalid_component_source",
  );
});

test("component copy overrides persist touched groups and reverse exactly", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://component-override.smallpen",
    await componentValues(),
  );
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: copyChildRuntimeId,
        operations: [
          {
            attr: "fills",
            type: "set",
            val: [{ "fill-color": "#dc2626", "fill-opacity": 1 }],
          },
          { attr: "touched", type: "set", val: ["fill-group"] },
        ],
        type: "mod-obj",
      },
    ],
    commitId: "component-override",
  });
  const prepared = await prepareOperationBatch(snapshot, batch);
  const copy =
    prepared.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes[
      copyChildId
    ];

  assert.deepEqual(copy.fills, [{ color: "#dc2626", type: "solid" }]);
  assert.deepEqual(copy.touched, ["fill-group"]);

  const reversed = await prepareOperationBatch(
    prepared.snapshot,
    prepared.result.inverseBatch,
  );
  assert.equal(reversed.snapshot.revision, snapshot.revision);
});

test("a complete Penpot instance tree compiles and keeps every source link", async () => {
  const values = await componentValues();
  const presentation = values.get("screens/roundtrip.json").presentations[0];
  delete presentation.nodes[instanceId];
  delete presentation.nodes[copyChildId];
  presentation.nodes.node_canvas.children =
    presentation.nodes.node_canvas.children.filter((id) => id !== instanceId);
  const snapshot = await loadPackageFromValues(
    "memory://add-instance.smallpen",
    values,
  );
  const canvasRuntimeId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_canvas;
  const pageRuntimeId = snapshot.runtime.pages.scr_roundtrip.pres_desktop;
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: instanceRuntimeId,
        index: 2,
        obj: {
          "component-file": snapshot.runtime.file,
          "component-id": componentRuntimeId,
          "component-root": true,
          "frame-id": canvasRuntimeId,
          "parent-id": canvasRuntimeId,
          "shape-ref": masterRuntimeId,
          fills: [],
          height: 80,
          id: instanceRuntimeId,
          name: "New Button instance",
          shapes: [copyChildRuntimeId],
          strokes: [],
          type: "frame",
          width: 160,
          x: 560,
          y: 220,
        },
        "page-id": pageRuntimeId,
        "parent-id": canvasRuntimeId,
        type: "add-obj",
      },
      {
        id: copyChildRuntimeId,
        obj: {
          "frame-id": instanceRuntimeId,
          "parent-id": instanceRuntimeId,
          "shape-ref": masterChildRuntimeId,
          fills: [{ "fill-color": "#2563eb", "fill-opacity": 1 }],
          height: 32,
          id: copyChildRuntimeId,
          name: "Component child",
          shapes: [],
          strokes: [],
          touched: [],
          type: "rect",
          width: 120,
          x: 580,
          y: 244,
        },
        "page-id": pageRuntimeId,
        "parent-id": instanceRuntimeId,
        type: "add-obj",
      },
    ],
    commitId: "add-instance",
  });
  const prepared = await prepareOperationBatch(snapshot, batch);
  const nodes =
    prepared.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes;

  assert.deepEqual(
    {
      componentId: nodes[instanceId].componentId,
      sourceNodeId: nodes[instanceId].sourceNodeId,
      type: nodes[instanceId].type,
    },
    { componentId, sourceNodeId: masterId, type: "INSTANCE" },
  );
  assert.deepEqual(
    {
      sourceNodeId: nodes[copyChildId].sourceNodeId,
      touched: nodes[copyChildId].touched,
      type: nodes[copyChildId].type,
    },
    { sourceNodeId: masterChildId, touched: [], type: "RECTANGLE" },
  );

  const reversed = await prepareOperationBatch(
    prepared.snapshot,
    prepared.result.inverseBatch,
  );
  assert.equal(reversed.snapshot.revision, snapshot.revision);
});

test("an external Penpot instance tree retains its Library and source links", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://external-component-consumer.smallpen",
    await fixtureValues(),
  );
  const library = await externalComponentSnapshot();
  const canvasRuntimeId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_canvas;
  const pageRuntimeId = snapshot.runtime.pages.scr_roundtrip.pres_desktop;
  const batch = compilePenpotChanges(
    snapshot,
    {
      changes: [
        {
          id: instanceRuntimeId,
          index: 1,
          obj: {
            "component-file": library.runtime.file,
            "component-id": library.runtime.components[componentId],
            "component-root": true,
            "frame-id": canvasRuntimeId,
            "parent-id": canvasRuntimeId,
            "shape-ref":
              library.runtime.nodes.scr_roundtrip.pres_desktop[masterId],
            fills: [],
            height: 80,
            id: instanceRuntimeId,
            name: "Shared Button instance",
            shapes: [copyChildRuntimeId],
            strokes: [],
            type: "frame",
            width: 160,
            x: 560,
            y: 220,
          },
          "page-id": pageRuntimeId,
          "parent-id": canvasRuntimeId,
          type: "add-obj",
        },
        {
          id: copyChildRuntimeId,
          obj: {
            "frame-id": instanceRuntimeId,
            "parent-id": instanceRuntimeId,
            "shape-ref":
              library.runtime.nodes.scr_roundtrip.pres_desktop[masterChildId],
            fills: [{ "fill-color": "#2563eb", "fill-opacity": 1 }],
            height: 32,
            id: copyChildRuntimeId,
            name: "Component child",
            shapes: [],
            strokes: [],
            touched: [],
            type: "rect",
            width: 120,
            x: 580,
            y: 244,
          },
          "page-id": pageRuntimeId,
          "parent-id": instanceRuntimeId,
          type: "add-obj",
        },
      ],
      commitId: "add-external-instance",
    },
    { libraries: [library] },
  );
  const prepared = await prepareOperationBatch(snapshot, batch);
  const nodes =
    prepared.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes;

  assert.deepEqual(nodes[instanceId].componentId, {
    assetId: componentId,
    packageId: "pkg_shared_components",
  });
  assert.equal(nodes[instanceId].sourceNodeId, masterId);
  assert.equal(nodes[copyChildId].sourceNodeId, masterChildId);
  assert.deepEqual(nodes[copyChildId].touched, []);
});

test("an external Component Set instance retains the selected variant", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://external-component-set-consumer.smallpen",
    await fixtureValues(),
  );
  const library = await externalComponentSetSnapshot();
  const canvasRuntimeId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_canvas;
  const pageRuntimeId = snapshot.runtime.pages.scr_roundtrip.pres_desktop;
  const batch = compilePenpotChanges(
    snapshot,
    {
      changes: [
        {
          id: instanceRuntimeId,
          obj: {
            "component-file": library.runtime.file,
            "component-id": library.runtime.variants[componentId][variantId],
            "component-root": true,
            "frame-id": canvasRuntimeId,
            "parent-id": canvasRuntimeId,
            "shape-ref":
              library.runtime.componentNodes[componentId][variantId][masterId],
            fills: [],
            height: 80,
            id: instanceRuntimeId,
            name: "Shared Button variant",
            shapes: [copyChildRuntimeId],
            strokes: [],
            type: "frame",
            width: 160,
            x: 560,
            y: 220,
          },
          "page-id": pageRuntimeId,
          "parent-id": canvasRuntimeId,
          type: "add-obj",
        },
        {
          id: copyChildRuntimeId,
          obj: {
            "frame-id": instanceRuntimeId,
            "parent-id": instanceRuntimeId,
            "shape-ref":
              library.runtime.componentNodes[componentId][variantId][
                masterChildId
              ],
            fills: [{ "fill-color": "#2563eb", "fill-opacity": 1 }],
            height: 32,
            id: copyChildRuntimeId,
            name: "Component child",
            shapes: [],
            strokes: [],
            touched: [],
            type: "rect",
            width: 120,
            x: 580,
            y: 244,
          },
          "page-id": pageRuntimeId,
          "parent-id": instanceRuntimeId,
          type: "add-obj",
        },
      ],
      commitId: "add-external-component-set-instance",
    },
    { libraries: [library] },
  );
  const prepared = await prepareOperationBatch(snapshot, batch);
  const root =
    prepared.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes[
      instanceId
    ];

  assert.deepEqual(root.componentId, {
    assetId: componentId,
    packageId: "pkg_shared_component_sets",
  });
  assert.equal(root.componentVariantId, variantId);
  assert.equal(root.sourceNodeId, masterId);
});

function componentCreationCommit(snapshot) {
  const pageId = snapshot.runtime.pages.scr_roundtrip.pres_desktop;
  const mainId = snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_canvas;
  const childId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle;
  return {
    changes: [
      {
        annotation: null,
        id: componentRuntimeId,
        "main-instance-id": mainId,
        "main-instance-page": pageId,
        name: "Canvas Component",
        path: "Layouts",
        type: "add-component",
      },
      {
        id: mainId,
        operations: [
          { attr: "component-id", type: "set", val: componentRuntimeId },
          { attr: "component-file", type: "set", val: snapshot.runtime.file },
          { attr: "component-root", type: "set", val: true },
          { attr: "main-instance", type: "set", val: true },
          { attr: "shape-ref", type: "set", val: null },
          { attr: "touched", type: "set", val: null },
        ],
        "page-id": pageId,
        type: "mod-obj",
      },
      {
        id: childId,
        operations: [
          { attr: "component-id", type: "set", val: null },
          { attr: "component-file", type: "set", val: null },
          { attr: "component-root", type: "set", val: null },
          { attr: "main-instance", type: "set", val: null },
          { attr: "shape-ref", type: "set", val: null },
          { attr: "touched", type: "set", val: null },
        ],
        "page-id": pageId,
        type: "mod-obj",
      },
    ],
    commitId: "create-component",
  };
}

test("Penpot Component creation updates its node, entry, manifest, and inverse", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://create-component.smallpen",
    await fixtureValues(),
  );
  const batch = compilePenpotChanges(
    snapshot,
    componentCreationCommit(snapshot),
  );
  assert.deepEqual(batch.operations, [
    {
      component: {
        id: componentId,
        mainNodeId: "node_canvas",
        name: "Canvas Component",
        path: "Layouts",
        presentationId: "pres_desktop",
        screenId: "scr_roundtrip",
      },
      type: "add-component",
    },
  ]);

  const prepared = await prepareOperationBatch(snapshot, batch);
  const componentEntry = `components/${componentId}.json`;
  assert.deepEqual(prepared.result.changedFiles, [
    componentEntry,
    "manifest.json",
    "screens/roundtrip.json",
  ]);
  assert.deepEqual(prepared.result.deletedFiles, []);
  assert.equal(
    prepared.snapshot.runtime.components[componentId],
    componentRuntimeId,
  );
  assert.equal(
    prepared.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_canvas.type,
    "COMPONENT",
  );
  assert.deepEqual(prepared.snapshot.entries[componentEntry], {
    id: componentId,
    mainNodeId: "node_canvas",
    name: "Canvas Component",
    path: "Layouts",
    presentationId: "pres_desktop",
    screenId: "scr_roundtrip",
  });

  const reversed = await prepareOperationBatch(
    prepared.snapshot,
    prepared.result.inverseBatch,
  );
  assert.equal(reversed.snapshot.revision, snapshot.revision);
  assert.deepEqual(reversed.result.deletedFiles, [componentEntry]);
});

test("Penpot Component metadata updates and unused deletion reverse exactly", async () => {
  const before = await loadPackageFromValues(
    "memory://component-lifecycle.smallpen",
    await fixtureValues(),
  );
  const created = await prepareOperationBatch(
    before,
    compilePenpotChanges(before, componentCreationCommit(before)),
  );
  const updated = await prepareOperationBatch(
    created.snapshot,
    compilePenpotChanges(created.snapshot, {
      changes: [
        {
          annotation: null,
          id: componentRuntimeId,
          name: "Application Canvas",
          objects: null,
          path: "Screens",
          type: "mod-component",
        },
      ],
      commitId: "update-component",
    }),
  );
  const componentEntry = `components/${componentId}.json`;
  assert.deepEqual(
    {
      name: updated.snapshot.entries[componentEntry].name,
      path: updated.snapshot.entries[componentEntry].path,
    },
    { name: "Application Canvas", path: "Screens" },
  );

  const pageId = updated.snapshot.runtime.pages.scr_roundtrip.pres_desktop;
  const mainId =
    updated.snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_canvas;
  const removed = await prepareOperationBatch(
    updated.snapshot,
    compilePenpotChanges(updated.snapshot, {
      changes: [
        { id: componentRuntimeId, type: "del-component" },
        { id: mainId, "page-id": pageId, type: "del-obj" },
      ],
      commitId: "delete-component",
    }),
  );
  assert.deepEqual(removed.result.deletedFiles, [componentEntry]);
  assert.equal(
    removed.snapshot.manifest.entries.components.includes(componentEntry),
    false,
  );
  assert.deepEqual(
    removed.snapshot.entries["screens/roundtrip.json"].presentations[0].rootIds,
    [],
  );

  const restored = await prepareOperationBatch(
    removed.snapshot,
    removed.result.inverseBatch,
  );
  assert.equal(restored.snapshot.revision, updated.snapshot.revision);
});

test("unchanged Component metadata and registered bounds are accepted as a no-op", async () => {
  const before = await loadPackageFromValues(
    "memory://component-no-op.smallpen",
    await fixtureValues(),
  );
  const created = await prepareOperationBatch(
    before,
    compilePenpotChanges(before, componentCreationCommit(before)),
  );
  const batch = compilePenpotChanges(created.snapshot, {
    changes: [
      {
        annotation: null,
        id: componentRuntimeId,
        name: "Canvas Component",
        objects: null,
        path: "Layouts",
        type: "mod-component",
      },
      {
        "page-id":
          created.snapshot.runtime.pages.scr_roundtrip.pres_desktop,
        shapes: [
          created.snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_canvas,
          "00000000-0000-0000-0000-000000000000",
        ],
        type: "reg-objects",
      },
    ],
    commitId: "unchanged-component-metadata",
  });

  assert.deepEqual(batch.operations, []);
  const prepared = await prepareOperationBatch(created.snapshot, batch);
  assert.equal(prepared.snapshot.revision, created.snapshot.revision);
  assert.deepEqual(prepared.result.changedFiles, []);
});

test("generated Components page bounds registration is a validated no-op", async () => {
  const snapshot = await openPackage(join(here, "fixtures", "design-system.smallpen"));
  const nodeId = Object.keys(snapshot.runtime.reverseComponentNodes)[0];
  assert.ok(nodeId);
  assert.ok(snapshot.runtime.componentsPage);
  const commit = {
    commitId: "projected-component-bounds",
    changes: [{
      type: "reg-objects",
      "page-id": snapshot.runtime.componentsPage,
      shapes: [nodeId, "00000000-0000-0000-0000-000000000000"],
    }],
  };
  assert.deepEqual(compilePenpotChanges(snapshot, commit).operations, []);
  assert.throws(() => compilePenpotChanges(snapshot, {
    ...commit,
    changes: [{...commit.changes[0], shapes: ["unknown-node"]}],
  }), /Unknown projected component node/);
  assert.throws(() => compilePenpotChanges(snapshot, {
    ...commit,
    changes: [{...commit.changes[0], "page-id": "unknown-page"}],
  }), /runtime page is not mapped/);
});

test("expanded component text measurements do not require a source-page mapping", async () => {
  const snapshot = await openPackage(join(here, "fixtures", "design-system.smallpen"));
  const change = {
    type: "mod-obj",
    id: "5d91ecde-8e24-5391-b9c9-2131b436ec14",
    "page-id": snapshot.runtime.componentsPage,
    operations: [{type: "set", attr: "position-data", val: [{text: "Example", width: 120}]}],
  };
  const commit = {commitId: "expanded-component-measurement", changes: [change]};
  assert.deepEqual(compilePenpotChanges(snapshot, commit).operations, []);
  const prepared = await prepareOperationBatch(snapshot, compilePenpotChanges(snapshot, commit));
  assert.equal(prepared.snapshot.revision, snapshot.revision);
  assert.throws(() => compilePenpotChanges(snapshot, {
    ...commit, changes: [{...change, operations: [...change.operations, {type: "set", attr: "opacity", val: 0.5}]}],
  }), /runtime page is not mapped/);
  assert.throws(() => compilePenpotChanges(snapshot, {
    ...commit, changes: [{...change, "page-id": "unknown-page"}],
  }), /runtime page is not mapped/);
});

test("deleting a Component with live instances is rejected atomically", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://component-in-use.smallpen",
    await componentValues(),
  );
  await assert.rejects(
    prepareOperationBatch(snapshot, {
      baseRevision: snapshot.revision,
      batchId: "delete-used-component",
      operations: [{ componentId, type: "delete-component" }],
    }),
    (error) => error?.code === "component_in_use",
  );
  assert.equal(
    snapshot.entries["screens/roundtrip.json"].presentations[0].nodes[masterId]
      .type,
    "COMPONENT",
  );
});

test("the local package transaction physically removes a deleted Component entry", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-component-delete-"));
  const packagePath = join(parent, "component.smallpen");
  await cp(fixture, packagePath, { recursive: true });
  context.after(() => rm(parent, { force: true, recursive: true }));

  const before = await openPackage(packagePath);
  const created = await applyOperationBatch(
    packagePath,
    compilePenpotChanges(before, componentCreationCommit(before)),
  );
  const entry = `components/${componentId}.json`;
  await access(join(packagePath, entry));

  const opened = await openPackage(packagePath);
  const removed = await applyOperationBatch(packagePath, {
    ...created.inverseBatch,
    baseRevision: opened.revision,
  });
  assert.deepEqual(removed.deletedFiles, [entry]);
  await assert.rejects(access(join(packagePath, entry)), {
    code: "ENOENT",
  });
  const manifest = JSON.parse(
    await readFile(join(packagePath, "manifest.json"), "utf8"),
  );
  assert.deepEqual(manifest.entries.components, []);
});
