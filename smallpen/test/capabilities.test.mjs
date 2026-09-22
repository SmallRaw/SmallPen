import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  listPackageEntries,
  loadPackageFromValues,
  prepareOperationBatch,
  sha256Hex,
  SMALLPEN_FORMAT_CAPABILITIES,
  SMALLPEN_RUNTIME_CAPABILITIES,
} from "@smallpen/core";
import { compilePenpotChanges } from "@smallpen/penpot-adapter";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "roundtrip.smallpen");
const capabilityMediaId = "media_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa";

test("the SmallPen runtime profile is local-only and disables AI/collaboration surfaces", () => {
  assert.deepEqual(SMALLPEN_RUNTIME_CAPABILITIES, {
    agentExecution: false,
    aiChat: false,
    comments: false,
    externalChanges: true,
    localHistory: true,
    mcp: false,
    multiplePackages: true,
    networkInfrastructure: false,
    plugins: false,
    presence: false,
    realtimeCollaboration: false,
    remoteHistory: false,
    repositoryMerge: false,
    reviewWorkflow: false,
  });
  assert.equal(Object.isFrozen(SMALLPEN_RUNTIME_CAPABILITIES), true);
});

async function imageValues() {
  const values = await fixtureValues();
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const sha256 = await sha256Hex(bytes);
  const blob = `blobs/${sha256}`;
  values.get("manifest.json").entries.assets = ["assets/media.json"];
  values.set("assets/media.json", {
    colors: [],
    fonts: [],
    id: "alib_capabilities",
    media: [
      {
        blob,
        byteLength: bytes.byteLength,
        height: 1,
        id: capabilityMediaId,
        mimeType: "image/png",
        name: "Capability image",
        path: "",
        sha256,
        width: 1,
      },
    ],
    typographies: [],
  });
  values.set(blob, bytes);
  return values;
}

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

function normalizeCapabilityArrays(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeCapabilityArrays).sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        normalizeCapabilityArrays(entry),
      ]),
    );
  }
  return value;
}

test("the format capability contract advertises only implemented Web behavior", () => {
  assert.deepEqual(normalizeCapabilityArrays(SMALLPEN_FORMAT_CAPABILITIES), normalizeCapabilityArrays({
    canonicalPackage: {
      entryKinds: [
        "assets",
        "components",
        "contexts",
        "requirements",
        "scenarios",
        "screens",
        "tokens",
      ],
      nodeTypes: [
        "COMPONENT",
        "COMPONENT_SET",
        "ELLIPSE",
        "FRAME",
        "GROUP",
        "IMAGE",
        "INSTANCE",
        "PATH",
        "RECTANGLE",
        "TEXT",
      ],
      assetLibraryModel: "local-colors-fonts-typographies-media",
      binaryBlobModel: "sha256-addressed",
      customFontModel: "families-variants-woff",
      componentCanonicalModel: "component-sets-sparse-variants",
      dependencyModel:
        "one-foundation-plus-multiple-local-or-url-library-sources",
      contextModel: "finite-axes-defaults-profiles",
      effectiveTokenResolution:
        "product-first-specificity-then-foundation-fallback",
      fontImportConversion: "sfnt-to-woff",
      fontImportTypes: ["font/otf", "font/ttf", "font/woff"],
      repairChoices: [
        "choose-foundation",
        "recreate-product-asset",
        "remove-dependent-usage",
        "retarget-reference",
      ],
      presentationRootForms: ["legacy-single", "forest"],
      requirementModel: "requirements-links-flows-annotations",
      textModel: "blocks-runs",
      scenarioModel: "finite-declarative-actions",
      screenModel: "base-plus-independent-presentations",
      tokenCanonicalModel: "dtcg-smallpen-extension",
      tokenBindingFields: [
        "backgroundBlur",
        "blur",
        "cornerRadius",
        "fill",
        "fills.N",
        "fontFamily",
        "fontSize",
        "fontWeight",
        "height",
        "itemSpacing",
        "opacity",
        "paddingBottom",
        "paddingLeft",
        "paddingRight",
        "paddingTop",
        "shadow",
        "strokeWidth",
        "typography",
        "width",
      ],
      tokenLibraryModel: "ordered-sets-themes",
      tokenTypes: [
        "boolean",
        "border-radius",
        "color",
        "dimensions",
        "font-family",
        "font-size",
        "font-weight",
        "letter-spacing",
        "number",
        "opacity",
        "other",
        "rotation",
        "shadow",
        "sizing",
        "spacing",
        "string",
        "stroke-width",
        "text-case",
        "text-decoration",
        "typography",
      ],
    },
      canonicalWrite: {
      nodeFields: [
        "appliedTokens",
        "backgroundBlur",
        "blend-mode",
        "blur",
        "cornerRadius",
        "fills",
        "flipX",
        "flipY",
        "growType",
        "grids",
        "height",
        "hide-fill-on-export",
        "hide-in-viewer",
        "interactions",
        "layout",
        "layout-flex-dir",
        "layout-gap-type",
        "layout-gap",
        "layout-align-items",
        "layout-justify-content",
        "layout-align-content",
        "layout-wrap-type",
        "layout-padding-type",
        "layout-padding",
        "layout-item-margin",
        "layout-item-margin-type",
        "layout-item-h-sizing",
        "layout-item-v-sizing",
        "layout-item-max-h",
        "layout-item-min-h",
        "layout-item-max-w",
        "layout-item-min-w",
        "layout-item-align-self",
        "layout-item-absolute",
        "layout-item-z-index",
        "constraints-h",
        "constraints-v",
        "fixed-scroll",
        "exports",
        "content",
        "pathData",
        "points",
        "locked",
        "masked-group",
        "mediaRef",
        "name",
        "opacity",
        "proportionLock",
        "rotation",
        "shadow",
        "strokes",
        "show-content",
        "text",
        "textBlocks",
        "textStyle",
        "tokenBindings",
        "touched",
        "visible",
        "width",
        "x",
        "y",
      ],
      operationTypes: [
        "add-component",
        "add-presentation",
        "add-presentation-node",
        "clear-token-binding",
        "delete-component-set",
        "delete-context-file",
        "delete-interaction",
        "delete-requirement-file",
        "delete-scenario",
        "delete-screen",
        "delete-variant",
        "deprecate-token",
        "delete-presentation",
        "delete-presentation-node",
        "delete-component",
        "move-presentation",
        "move-presentation-nodes",
        "put-component-set",
        "put-context-file",
        "put-interaction",
        "put-library",
        "put-requirement-file",
        "put-scenario",
        "put-screen",
        "put-token",
        "put-variant",
        "remove-token",
        "remove-library",
        "repair-reference",
        "reorder-presentation-children",
        "replace-asset-library",
        "replace-token-library",
        "restore-canonical-entry",
        "select-instance-variant",
        "set-default-screen",
        "set-foundation-dependency",
        "set-active-token-themes",
        "set-token-binding",
        "set-token-value",
        "update-component-node",
        "update-node",
        "update-presentation",
        "update-presentation-node",
        "update-component",
      ],
    },
    penpotWrite: {
      attributes: [
        "applied-tokens",
        "background-blur",
        "blend-mode",
        "blur",
        "blocked",
        "fills",
        "flip-x",
        "flip-y",
        "grow-type",
        "grids",
        "height",
        "hide-fill-on-export",
        "hide-in-viewer",
        "interactions",
        "hidden",
        "layout",
        "layout-flex-dir",
        "layout-gap-type",
        "layout-gap",
        "layout-align-items",
        "layout-justify-content",
        "layout-align-content",
        "layout-wrap-type",
        "layout-padding-type",
        "layout-padding",
        "layout-item-margin",
        "layout-item-margin-type",
        "layout-item-h-sizing",
        "layout-item-v-sizing",
        "layout-item-max-h",
        "layout-item-min-h",
        "layout-item-max-w",
        "layout-item-min-w",
        "layout-item-align-self",
        "layout-item-absolute",
        "layout-item-z-index",
        "constraints-h",
        "constraints-v",
        "fixed-scroll",
        "exports",
        "masked-group",
        "metadata",
        "name",
        "opacity",
        "proportion-lock",
        "r1",
        "r2",
        "r3",
        "r4",
        "rotation",
        "shadow",
        "show-content",
        "width",
        "x",
        "y",
        "content",
        "pathData",
        "strokes",
        "touched",
      ],
      changeTypes: [
        "add-color",
        "add-component",
        "add-media",
        "add-page",
        "add-obj",
        "del-page",
        "del-obj",
        "del-component",
        "del-color",
        "del-media",
        "mod-page",
        "mod-obj",
        "mod-component",
        "mod-color",
        "mod-media",
        "mov-page",
        "mov-objects",
        "reg-objects",
        "reorder-children",
        "rename-token-set-group",
        "move-token-set",
        "move-token-set-group",
        "set-active-token-themes",
        "set-flow",
        "set-tokens-status",
        "set-token",
        "set-token-set",
        "set-token-theme",
        "add-typography",
        "mod-typography",
        "del-typography",
      ],
      derivedAttributes: [
        "points",
        "position-data",
        "proportion",
        "selrect",
        "transform",
        "transform-inverse",
      ],
      operationTypes: ["set", "set-touched"],
      pageAttributes: [
        "background",
        "name",
        "pixel-grid-color",
        "pixel-grid-opacity",
      ],
      presentationMoveScope: "within-screen",
      presentationTarget: "default-screen",
      componentDeletePolicy: "unused-only",
      assetDeletePolicy: "unused-only",
    },
    version: 1,
    webProjection: {
      appliedTokenAttributes: [
        "column-gap",
        "fill",
        "font-family",
        "font-size",
        "font-weight",
        "height",
        "layout-item-max-h",
        "layout-item-max-w",
        "layout-item-min-h",
        "layout-item-min-w",
        "letter-spacing",
        "line-height",
        "m1",
        "m2",
        "m3",
        "m4",
        "opacity",
        "p1",
        "p2",
        "p3",
        "p4",
        "r1",
        "r2",
        "r3",
        "r4",
        "rotation",
        "row-gap",
        "shadow",
        "stroke-color",
        "stroke-width",
        "text-case",
        "text-decoration",
        "typography",
        "width",
      ],
      componentModel: "located-main-instance",
      cornerRadiusForms: ["uniform", "per-corner"],
      entryKinds: ["assets", "components", "screens", "tokens"],
      fillTypes: ["image", "linear-gradient", "radial-gradient", "solid"],
      localAssetTypes: ["color", "font", "media", "typography"],
      nodeFields: [
        "appliedTokens",
        "backgroundBlur",
        "blend-mode",
        "blur",
        "children",
        "componentId",
        "componentVariantId",
        "cornerRadius",
        "fills",
        "flipX",
        "flipY",
        "growType",
        "grids",
        "height",
        "hide-fill-on-export",
        "hide-in-viewer",
        "id",
        "interactions",
        "layout",
        "layout-flex-dir",
        "layout-gap-type",
        "layout-gap",
        "layout-align-items",
        "layout-justify-content",
        "layout-align-content",
        "layout-wrap-type",
        "layout-padding-type",
        "layout-padding",
        "layout-item-margin",
        "layout-item-margin-type",
        "layout-item-h-sizing",
        "layout-item-v-sizing",
        "layout-item-max-h",
        "layout-item-min-h",
        "layout-item-max-w",
        "layout-item-min-w",
        "layout-item-align-self",
        "layout-item-absolute",
        "layout-item-z-index",
        "constraints-h",
        "constraints-v",
        "fixed-scroll",
        "exports",
        "content",
        "pathData",
        "points",
        "locked",
        "masked-group",
        "mediaRef",
        "name",
        "opacity",
        "proportionLock",
        "rotation",
        "shadow",
        "sourceNodeId",
        "strokes",
        "show-content",
        "text",
        "textBlocks",
        "textStyle",
        "touched",
        "type",
        "visible",
        "width",
        "x",
        "y",
      ],
      nodeTypes: ["COMPONENT", "ELLIPSE", "FRAME", "GROUP", "IMAGE", "INSTANCE", "PATH", "RECTANGLE", "TEXT"],
      presentationRootForms: ["legacy-single", "forest"],
      textModel: "blocks-runs",
      strokeTypes: ["image", "linear-gradient", "radial-gradient", "solid"],
      supportedFontTypes: ["font/otf", "font/ttf", "font/woff", "font/woff2"],
      supportedMediaTypes: [
        "image/gif",
        "image/jpeg",
        "image/png",
        "image/svg+xml",
        "image/webp",
      ],
      assetLibraryEntries: "zero-or-one",
      tokenLibraryEntries: "zero-or-one",
      touchedGroups: [
        "blur-group",
        "constraints-group",
        "content-group",
        "fill-group",
        "geometry-group",
        "layer-effects-group",
        "mask-group",
        "modifiable-group",
        "name-group",
        "radius-group",
        "shadow-group",
        "stroke-group",
        "text-display-group",
        "text-font-group",
        "visibility-group",
      ],
    },
  }));
  assert.ok(Object.isFrozen(SMALLPEN_FORMAT_CAPABILITIES));
  assert.ok(Object.isFrozen(SMALLPEN_FORMAT_CAPABILITIES.canonicalPackage));
  assert.ok(
    Object.isFrozen(
      SMALLPEN_FORMAT_CAPABILITIES.canonicalPackage.nodeTypes,
    ),
  );
});

test("every advertised Canonical node type passes the Core package boundary", async () => {
  for (const nodeType of SMALLPEN_FORMAT_CAPABILITIES.canonicalPackage
    .nodeTypes.filter((type) => type !== "COMPONENT" && type !== "INSTANCE")) {
    const values =
      nodeType === "IMAGE" ? await imageValues() : await fixtureValues();
    const node =
      values.get("screens/roundtrip.json").presentations[0].nodes.node_rectangle;
    node.type = nodeType;
    if (nodeType === "IMAGE") node.mediaRef = capabilityMediaId;
    if (nodeType === "TEXT") node.text = "Capability text";
    const snapshot = await loadPackageFromValues(
      `memory://node-type-${nodeType}.smallpen`,
      values,
    );
    assert.equal(
      snapshot.entries["screens/roundtrip.json"].presentations[0].nodes
        .node_rectangle.type,
      nodeType,
    );
  }
});

test("every advertised Penpot write compiles, applies, and reverses", async () => {
  const cases = [
    {
      attribute: "blocked",
      canonicalField: "locked",
      canonicalValue: true,
      value: true,
    },
    {
      attribute: "blend-mode",
      canonicalField: "blend-mode",
      value: "multiply",
    },
    {
      attribute: "fills",
      canonicalField: "fills",
      canonicalValue: [{ color: "#2563eb", opacity: 0.7, type: "solid" }],
      value: [{ "fill-color": "#2563eb", "fill-opacity": 0.7 }],
    },
    {
      attribute: "flip-x",
      canonicalField: "flipX",
      canonicalValue: true,
      value: true,
    },
    {
      attribute: "flip-y",
      canonicalField: "flipY",
      canonicalValue: true,
      value: true,
    },
    { attribute: "height", canonicalField: "height", value: 144 },
    {
      attribute: "hidden",
      canonicalField: "visible",
      canonicalValue: false,
      value: true,
    },
    {
      attribute: "grids",
      canonicalField: "grids",
      value: [{ color: "#22d3ee", display: true, params: { size: 8 }, type: "square" }],
    },
    {
      attribute: "hide-fill-on-export",
      canonicalField: "hide-fill-on-export",
      value: true,
    },
    {
      attribute: "hide-in-viewer",
      canonicalField: "hide-in-viewer",
      value: true,
    },
    {
      attribute: "masked-group",
      canonicalField: "masked-group",
      value: true,
    },
    {
      attribute: "name",
      canonicalField: "name",
      value: "Renamed Rectangle",
    },
    { attribute: "opacity", canonicalField: "opacity", value: 0.42 },
    {
      attribute: "proportion-lock",
      canonicalField: "proportionLock",
      canonicalValue: true,
      value: true,
    },
    {
      attribute: "r1",
      canonicalField: "cornerRadius",
      canonicalValue: [12, 0, 0, 0],
      value: 12,
    },
    {
      attribute: "r2",
      canonicalField: "cornerRadius",
      canonicalValue: [0, 12, 0, 0],
      value: 12,
    },
    {
      attribute: "r3",
      canonicalField: "cornerRadius",
      canonicalValue: [0, 0, 12, 0],
      value: 12,
    },
    {
      attribute: "r4",
      canonicalField: "cornerRadius",
      canonicalValue: [0, 0, 0, 12],
      value: 12,
    },
    {
      attribute: "rotation",
      canonicalField: "rotation",
      canonicalValue: 330,
      value: -30,
    },
    { attribute: "width", canonicalField: "width", value: 288 },
    { attribute: "x", canonicalField: "x", value: 128 },
    { attribute: "y", canonicalField: "y", value: 160 },
    {
      attribute: "strokes",
      canonicalField: "strokes",
      canonicalValue: [
        {
          alignment: "center",
          color: "#0f172a",
          opacity: 0.8,
          style: "dashed",
          type: "solid",
          width: 2,
        },
      ],
      value: [
        {
          "stroke-alignment": "center",
          "stroke-color": "#0f172a",
          "stroke-opacity": 0.8,
          "stroke-style": "dashed",
          "stroke-width": 2,
        },
      ],
    },
    {
      attribute: "shadow",
      canonicalField: "shadow",
      canonicalValue: [{ style: "drop-shadow", offsetX: 1, offsetY: 2, blur: 4, color: "#000000" }],
      value: [{ style: "drop-shadow", offsetX: 1, offsetY: 2, blur: 4, color: "#000000" }],
    },
    {
      attribute: "show-content",
      canonicalField: "show-content",
      value: false,
    },
    {
      attribute: "blur",
      canonicalField: "blur",
      canonicalValue: { type: "layer-blur", value: 4 },
      value: { type: "layer-blur", value: 4 },
    },
    {
      attribute: "background-blur",
      canonicalField: "backgroundBlur",
      canonicalValue: { type: "background-blur", value: 4 },
      value: { type: "background-blur", value: 4 },
    },
    { attribute: "layout", canonicalField: "layout", value: "flex" },
    { attribute: "layout-flex-dir", canonicalField: "layout-flex-dir", value: "row" },
    { attribute: "layout-gap-type", canonicalField: "layout-gap-type", value: "simple" },
    { attribute: "layout-gap", canonicalField: "layout-gap", value: { rowGap: 8, columnGap: 8 } },
    { attribute: "layout-align-items", canonicalField: "layout-align-items", value: "center" },
    { attribute: "layout-justify-content", canonicalField: "layout-justify-content", value: "space-between" },
    { attribute: "layout-align-content", canonicalField: "layout-align-content", value: "stretch" },
    { attribute: "layout-wrap-type", canonicalField: "layout-wrap-type", value: "nowrap" },
    { attribute: "layout-padding-type", canonicalField: "layout-padding-type", value: "simple" },
    { attribute: "layout-padding", canonicalField: "layout-padding", value: { p1: 8, p2: 8, p3: 8, p4: 8 } },
    { attribute: "layout-item-margin", canonicalField: "layout-item-margin", value: { m1: 1, m2: 2, m3: 3, m4: 4 } },
    { attribute: "layout-item-margin-type", canonicalField: "layout-item-margin-type", value: "multiple" },
    { attribute: "layout-item-h-sizing", canonicalField: "layout-item-h-sizing", value: "fill" },
    { attribute: "layout-item-v-sizing", canonicalField: "layout-item-v-sizing", value: "auto" },
    { attribute: "layout-item-max-h", canonicalField: "layout-item-max-h", value: 100 },
    { attribute: "layout-item-min-h", canonicalField: "layout-item-min-h", value: 10 },
    { attribute: "layout-item-max-w", canonicalField: "layout-item-max-w", value: 200 },
    { attribute: "layout-item-min-w", canonicalField: "layout-item-min-w", value: 20 },
    { attribute: "layout-item-align-self", canonicalField: "layout-item-align-self", value: "center" },
    { attribute: "layout-item-absolute", canonicalField: "layout-item-absolute", value: true },
    { attribute: "layout-item-z-index", canonicalField: "layout-item-z-index", value: 2 },
    { attribute: "constraints-h", canonicalField: "constraints-h", value: "left" },
    { attribute: "constraints-v", canonicalField: "constraints-v", value: "top" },
    { attribute: "fixed-scroll", canonicalField: "fixed-scroll", value: true },
    { attribute: "exports", canonicalField: "exports", value: [] },
    { attribute: "interactions", canonicalField: "interactions", value: [] },
    { attribute: "pathData", canonicalField: "pathData", value: "M0 0 L10 10" },
  ];
  assert.deepEqual(
    cases.map(({ attribute }) => attribute).sort(),
    SMALLPEN_FORMAT_CAPABILITIES.penpotWrite.attributes.filter(
      (attribute) =>
        attribute !== "applied-tokens" &&
        attribute !== "content" &&
        attribute !== "grow-type" &&
        attribute !== "metadata" &&
        attribute !== "touched",
    ).sort(),
  );

  for (const {
    attribute,
    canonicalField,
    canonicalValue,
    value,
  } of cases) {
    const snapshot = await loadPackageFromValues(
      `memory://capability-${attribute}.smallpen`,
      await fixtureValues(),
    );
    const runtimeId =
      snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle;
    const batch = compilePenpotChanges(snapshot, {
      changes: [
        {
          id: runtimeId,
          operations: [{ attr: attribute, type: "set", val: value }],
          type: "mod-obj",
        },
      ],
      commitId: `contract_${attribute}`,
    });
    const prepared = await prepareOperationBatch(snapshot, batch);
    const changedNode =
      prepared.snapshot.entries["screens/roundtrip.json"].presentations[0]
        .nodes.node_rectangle;
    assert.deepEqual(
      changedNode[canonicalField],
      canonicalValue ?? value,
      attribute,
    );

    const reversed = await prepareOperationBatch(
      prepared.snapshot,
      prepared.result.inverseBatch,
    );
    assert.equal(reversed.snapshot.revision, snapshot.revision);
  }
});

test("a Penpot navigate interaction persists and reverses exactly", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://prototype-navigation.smallpen",
    await fixtureValues(),
  );
  const rectangleId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle;
  const canvasId = snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_canvas;
  const interaction = {
    "action-type": "navigate",
    destination: canvasId,
    "event-type": "click",
    "position-relative-to": rectangleId,
    "preserve-scroll": false,
  };
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: rectangleId,
        operations: [
          { attr: "interactions", type: "set", val: [interaction] },
        ],
        type: "mod-obj",
      },
    ],
    commitId: "prototype-navigation",
  });
  const prepared = await prepareOperationBatch(snapshot, batch);
  const rectangle =
    prepared.snapshot.entries["screens/roundtrip.json"].presentations[0]
      .nodes.node_rectangle;
  assert.deepEqual(rectangle.interactions, [interaction]);

  const reversed = await prepareOperationBatch(
    prepared.snapshot,
    prepared.result.inverseBatch,
  );
  assert.equal(reversed.snapshot.revision, snapshot.revision);
});

test("a Penpot Flow start persists and reverses exactly", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://prototype-flow.smallpen",
    await fixtureValues(),
  );
  const pageId = snapshot.runtime.pages.scr_roundtrip.pres_desktop;
  const canvasId = snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_canvas;
  const flowId = "77777777-7777-4777-8777-777777777777";
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: flowId,
        "page-id": pageId,
        params: {
          id: flowId,
          name: "Flow 1",
          "starting-frame": canvasId,
        },
        type: "set-flow",
      },
    ],
    commitId: "prototype-flow",
  });
  const prepared = await prepareOperationBatch(snapshot, batch);
  const presentation =
    prepared.snapshot.entries["screens/roundtrip.json"].presentations[0];
  assert.deepEqual(presentation.prototypeFlows, [
    { id: flowId, name: "Flow 1", startingNodeId: "node_canvas" },
  ]);

  const reversed = await prepareOperationBatch(
    prepared.snapshot,
    prepared.result.inverseBatch,
  );
  assert.equal(reversed.snapshot.revision, snapshot.revision);

  const renamed = await prepareOperationBatch(
    prepared.snapshot,
    compilePenpotChanges(prepared.snapshot, {
      changes: [
        {
          id: flowId,
          "page-id": pageId,
          params: {
            id: flowId,
            name: "Checkout",
            "starting-frame": canvasId,
          },
          type: "set-flow",
        },
      ],
      commitId: "prototype-flow-rename",
    }),
  );
  assert.equal(
    renamed.snapshot.entries["screens/roundtrip.json"].presentations[0]
      .prototypeFlows[0].name,
    "Checkout",
  );

  const deleted = await prepareOperationBatch(
    renamed.snapshot,
    compilePenpotChanges(renamed.snapshot, {
      changes: [
        { id: flowId, "page-id": pageId, params: null, type: "set-flow" },
      ],
      commitId: "prototype-flow-delete",
    }),
  );
  assert.deepEqual(
    deleted.snapshot.entries["screens/roundtrip.json"].presentations[0]
      .prototypeFlows,
    [],
  );
});

test("Penpot canvas colors persist together in one reversible page update", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://canvas-colors.smallpen",
    await fixtureValues(),
  );
  const pageId = snapshot.runtime.pages.scr_roundtrip.pres_desktop;
  const prepared = await prepareOperationBatch(
    snapshot,
    compilePenpotChanges(snapshot, {
      changes: [
        {
          background: "#111827",
          id: pageId,
          "pixel-grid-color": "#22d3ee",
          "pixel-grid-opacity": 0.45,
          type: "mod-page",
        },
      ],
      commitId: "canvas-colors",
    }),
  );
  const presentation =
    prepared.snapshot.entries["screens/roundtrip.json"].presentations[0];
  assert.equal(presentation.background, "#111827");
  assert.equal(presentation["pixel-grid-color"], "#22d3ee");
  assert.equal(presentation["pixel-grid-opacity"], 0.45);

  const reversed = await prepareOperationBatch(
    prepared.snapshot,
    prepared.result.inverseBatch,
  );
  assert.equal(reversed.snapshot.revision, snapshot.revision);
});

test("completed Penpot geometry ignores only its derived representation", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://geometry.smallpen",
    await fixtureValues(),
  );
  const runtimeId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle;
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: runtimeId,
        operations: [
          { attr: "x", type: "set", val: 128 },
          {
            attr: "selrect",
            type: "set",
            val: { height: 120, width: 240, x: 128, y: 96 },
          },
          {
            attr: "points",
            type: "set",
            val: [
              { x: 128, y: 96 },
              { x: 368, y: 96 },
              { x: 368, y: 216 },
              { x: 128, y: 216 },
            ],
          },
        ],
        type: "mod-obj",
      },
    ],
    commitId: "geometry",
  });

  assert.deepEqual(batch.operations[0].changes, { x: 128 });
});

test("Penpot geometry removes UI floating-point noise and default radii", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://normalized-geometry.smallpen",
    await fixtureValues(),
  );
  const runtimeId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle;
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: runtimeId,
        operations: [
          { attr: "width", type: "set", val: 240.00000000000006 },
          { attr: "r1", type: "set", val: 0 },
          { attr: "r2", type: "set", val: 0 },
          { attr: "r3", type: "set", val: 0 },
          { attr: "r4", type: "set", val: 0 },
        ],
        type: "mod-obj",
      },
    ],
    commitId: "normalized_geometry",
  });

  assert.deepEqual(batch.operations[0].changes, {
    cornerRadius: null,
    width: 240,
  });
  const prepared = await prepareOperationBatch(snapshot, batch);
  const changed =
    prepared.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_rectangle;
  assert.equal(changed.width, 240);
  assert.equal(Object.hasOwn(changed, "cornerRadius"), false);
});

test("Penpot fill edits preserve an omitted default opacity", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://default-fill-opacity.smallpen",
    await fixtureValues(),
  );
  const runtimeId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle;
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: runtimeId,
        operations: [
          {
            attr: "fills",
            type: "set",
            val: [{ "fill-color": "#2563eb", "fill-opacity": 1 }],
          },
        ],
        type: "mod-obj",
      },
    ],
    commitId: "default_fill_opacity",
  });

  assert.deepEqual(batch.operations[0].changes, {
    fills: [{ color: "#2563eb", type: "solid" }],
  });
});

test("Penpot ratio locking derives its proportion from canonical geometry", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://proportion-lock.smallpen",
    await fixtureValues(),
  );
  const runtimeId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle;
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: runtimeId,
        operations: [
          { attr: "proportion-lock", type: "set", val: true },
          { attr: "proportion", type: "set", val: 2 },
        ],
        type: "mod-obj",
      },
    ],
    commitId: "proportion_lock",
  });

  assert.deepEqual(batch.operations[0].changes, { proportionLock: true });
});

test("Penpot undo restores touched state and canonical values together", async () => {
  const values = await fixtureValues();
  const rectangle =
    values.get("screens/roundtrip.json").presentations[0].nodes.node_rectangle;
  rectangle.opacity = 0.9;
  const snapshot = await loadPackageFromValues(
    "memory://undo-touched.smallpen",
    values,
  );
  const runtimeId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle;
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: runtimeId,
        operations: [
          { touched: null, type: "set-touched" },
          { attr: "opacity", type: "set", val: 1 },
        ],
        type: "mod-obj",
      },
    ],
    commitId: "undo_touched",
  });

  assert.deepEqual(batch.operations[0].changes, { opacity: 1 });
  const prepared = await prepareOperationBatch(snapshot, batch);
  const changed =
    prepared.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_rectangle;
  assert.equal(changed.opacity, 1);
  assert.equal(Object.hasOwn(changed, "touched"), false);

  const reversed = await prepareOperationBatch(
    prepared.snapshot,
    prepared.result.inverseBatch,
  );
  assert.equal(reversed.snapshot.revision, snapshot.revision);
});

test("unadvertised Penpot changes, operations, and attributes fail explicitly", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://unsupported.smallpen",
    await fixtureValues(),
  );
  const runtimeId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle;
  const commit = (change) => ({ changes: [change], commitId: "unsupported" });

  assert.throws(
    () => compilePenpotChanges(snapshot, commit({ id: runtimeId, type: "add-guide" })),
    (error) => error?.code === "unsupported_penpot_change",
  );
  assert.throws(
    () =>
      compilePenpotChanges(
        snapshot,
        commit({
          id: runtimeId,
          operations: [{ attr: "opacity", type: "unset" }],
          type: "mod-obj",
        }),
      ),
    (error) => error?.code === "unsupported_penpot_operation",
  );
  assert.throws(
    () =>
      compilePenpotChanges(
        snapshot,
        commit({
          id: runtimeId,
          operations: [{ attr: "stroke-cap", type: "set", val: "round" }],
          type: "mod-obj",
        }),
      ),
    (error) => error?.code === "unsupported_penpot_attribute",
  );
  assert.throws(
    () =>
      compilePenpotChanges(
        snapshot,
        commit({
          id: runtimeId,
          operations: [
            {
              attr: "selrect",
              type: "set",
              val: { height: 120, width: 240, x: 10, y: 10 },
            },
          ],
          type: "mod-obj",
        }),
      ),
    (error) => error?.code === "unsupported_penpot_derived_attribute",
  );
});

test("Penpot derived geometry can accompany geometry in a separate object change", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://grouped-derived-geometry.smallpen",
    await fixtureValues(),
  );
  const runtimeId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle;
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: runtimeId,
        operations: [
          {
            attr: "selrect",
            type: "set",
            val: { height: 120, width: 250, x: 80, y: 96 },
          },
        ],
        type: "mod-obj",
      },
      {
        id: runtimeId,
        operations: [{ attr: "width", type: "set", val: 250 }],
        type: "mod-obj",
      },
    ],
    commitId: "grouped_derived_geometry",
  });

  assert.deepEqual(batch.operations[0].changes, { width: 250 });
});

test("unadvertised Canonical operations and node fields fail explicitly", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://unsupported-canonical.smallpen",
    await fixtureValues(),
  );
  const batch = (operation) => ({
    baseRevision: snapshot.revision,
    batchId: "unsupported_canonical",
    operations: [operation],
  });

  await assert.rejects(
    prepareOperationBatch(snapshot, batch({ type: "delete-node" })),
    (error) => error?.code === "unsupported_operation",
  );
  await assert.rejects(
    prepareOperationBatch(
      snapshot,
      batch({
        changes: { shadows: [] },
        nodeId: "node_rectangle",
        presentationId: "pres_desktop",
        screenId: "scr_roundtrip",
        type: "update-presentation-node",
      }),
    ),
    (error) => error?.code === "unsupported_node_change",
  );
});

test("Canonical basic node writes reject values that cannot round trip", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://invalid-basic-write.smallpen",
    await fixtureValues(),
  );
  const batch = (changes) => ({
    baseRevision: snapshot.revision,
    batchId: "invalid_basic_write",
    operations: [
      {
        changes,
        nodeId: "node_rectangle",
        presentationId: "pres_desktop",
        screenId: "scr_roundtrip",
        type: "update-presentation-node",
      },
    ],
  });

  await assert.rejects(
    prepareOperationBatch(snapshot, batch({ width: Number.NaN })),
    (error) => error?.code === "invalid_node_number",
  );
  await assert.rejects(
    prepareOperationBatch(snapshot, batch({ name: 42 })),
    (error) => error?.code === "invalid_node_name",
  );
  await assert.rejects(
    prepareOperationBatch(snapshot, batch({ visible: "yes" })),
    (error) => error?.code === "invalid_node_visibility",
  );
  await assert.rejects(
    prepareOperationBatch(snapshot, batch({ cornerRadius: [1, 2, 3] })),
    (error) => error?.code === "invalid_corner_radius",
  );
  await assert.rejects(
    prepareOperationBatch(
      snapshot,
      batch({ fills: [{ stops: [], type: "gradient" }] }),
    ),
    (error) => error?.code === "unsupported_fill_type",
  );
});
