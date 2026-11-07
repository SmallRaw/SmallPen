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
} from "@smallpen/core";
import { compilePenpotChanges } from "@smallpen/penpot-adapter";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "roundtrip.smallpen");

const colorId = "color_11111111111141118111111111111111";
const colorRuntimeId = "11111111-1111-4111-8111-111111111111";
const typographyId = "typo_22222222222242228222222222222222";
const typographyRuntimeId = "22222222-2222-4222-8222-222222222222";
const addedColorRuntimeId = "33333333-3333-4333-8333-333333333333";
const addedTypographyRuntimeId = "44444444-4444-4444-8444-444444444444";
const mediaId = "media_55555555555545558555555555555555";
const mediaRuntimeId = "55555555-5555-4555-8555-555555555555";
const fontId = "font_66666666666646668666666666666666";
const fontRuntimeId = "66666666-6666-4666-8666-666666666666";
const fontVariantId = "fvar_77777777777747778777777777777777";
const fontVariantRuntimeId = "77777777-7777-4777-8777-777777777777";

const canonicalTypographyStyle = {
  fontFamily: "Inter",
  fontId: "gfont-inter",
  fontSize: 16,
  fontStyle: "normal",
  fontVariantId: "regular",
  fontWeight: 400,
  letterSpacing: 0,
  lineHeight: 1.4,
  textTransform: "none",
};

function penpotTypography(id, name = "Body") {
  return {
    "font-family": "Inter",
    "font-id": "gfont-inter",
    "font-size": "16",
    "font-style": "normal",
    "font-variant-id": "regular",
    "font-weight": "400",
    id,
    "letter-spacing": "0",
    "line-height": "1.4",
    name,
    path: "Text",
    "text-transform": "none",
  };
}

function textContent(text, snapshot, typographyRuntime = typographyRuntimeId) {
  return {
    children: [
      {
        children: [
          {
            children: [
              {
                fills: [{ "fill-color": "#000000", "fill-opacity": 1 }],
                "font-family": "sourcesanspro",
                "font-id": "sourcesanspro",
                "font-size": "14",
                "font-style": "normal",
                "font-variant-id": "regular",
                "font-weight": "400",
                "letter-spacing": "0",
                "line-height": "1.2",
                text,
                "text-decoration": "none",
                "text-transform": "none",
                "typography-ref-file": snapshot.runtime.file,
                "typography-ref-id": typographyRuntime,
              },
            ],
            "text-align": "left",
            "text-direction": "ltr",
            type: "paragraph",
          },
        ],
        type: "paragraph-set",
      },
    ],
    type: "root",
    "vertical-align": "top",
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

async function assetValues({ references = false, text = false } = {}) {
  const values = await fixtureValues();
  values.get("manifest.json").entries.assets = ["assets/design.json"];
  values.set("assets/design.json", {
    colors: [
      {
        id: colorId,
        name: "Primary",
        paint: { color: "#2563eb", opacity: 1, type: "solid" },
        path: "Brand",
      },
    ],
    fonts: [],
    id: "alib_design",
    media: [],
    typographies: [
      {
        id: typographyId,
        name: "Body",
        path: "Text",
        style: canonicalTypographyStyle,
      },
    ],
  });
  const node = values.get("screens/roundtrip.json").presentations[0].nodes
    .node_rectangle;
  if (references) {
    node.fills = [
      { color: "#2563eb", colorRef: colorId, opacity: 1, type: "solid" },
    ];
    node.strokes = [
      { color: "#2563eb", colorRef: colorId, type: "solid", width: 2 },
    ];
  }
  if (text) {
    node.type = "TEXT";
    node.text = "Hello";
    node.growType = "fixed";
    delete node.fills;
    node.textStyle = references ? { typographyRef: typographyId } : {};
  }
  return values;
}

async function externalAssetSnapshot() {
  const values = await assetValues();
  const manifest = values.get("manifest.json");
  manifest.name = "Shared Library";
  manifest.packageId = "pkg_shared_library";
  return loadPackageFromValues(
    "https://libraries.example/design/manifest.json",
    values,
  );
}

async function fontValues({ reference = true } = {}) {
  const values = await fixtureValues();
  const bytes = new Uint8Array([0x77, 0x4f, 0x46, 0x46, 0, 1, 0, 0]);
  const sha256 = await sha256Hex(bytes);
  const blob = `blobs/${sha256}`;
  values.get("manifest.json").entries.assets = ["assets/fonts.json"];
  values.set("assets/fonts.json", {
    colors: [],
    fonts: [
      {
        family: "SmallPen Sans",
        id: fontId,
        variants: [
          {
            files: {
              woff: {
                blob,
                byteLength: bytes.byteLength,
                mimeType: "font/woff",
                sha256,
              },
            },
            id: fontVariantId,
            name: "Regular",
            style: "normal",
            weight: 400,
          },
        ],
      },
    ],
    id: "alib_fonts",
    media: [],
    typographies: [],
  });
  values.set(blob, bytes);
  if (reference) {
    const node = values.get("screens/roundtrip.json").presentations[0].nodes
      .node_rectangle;
    node.type = "TEXT";
    node.text = "Offline";
    node.textStyle = {
      fontFamily: "SmallPen Sans",
      fontId,
      fontStyle: "normal",
      fontVariantId: "normal-400",
      fontWeight: 400,
    };
  }
  return { blob, bytes, values };
}

async function mediaValues({ imageNode = false, references = false } = {}) {
  const values = await assetValues();
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  const sha256 = await sha256Hex(bytes);
  const blob = `blobs/${sha256}`;
  values.get("assets/design.json").media.push({
    blob,
    byteLength: bytes.byteLength,
    height: 24,
    id: mediaId,
    mimeType: "image/png",
    name: "Logo",
    path: "Brand",
    sha256,
    width: 32,
  });
  values.set(blob, bytes);
  const node = values.get("screens/roundtrip.json").presentations[0].nodes
    .node_rectangle;
  if (imageNode) {
    node.type = "IMAGE";
    node.mediaRef = mediaId;
  }
  if (references) {
    node.fills = [{ mediaRef: mediaId, opacity: 0.8, type: "image" }];
    node.strokes = [{ mediaRef: mediaId, type: "image", width: 2 }];
  }
  return { blob, bytes, values };
}

async function externalMediaSnapshot() {
  const { values } = await mediaValues();
  const manifest = values.get("manifest.json");
  manifest.name = "Shared Media Library";
  manifest.packageId = "pkg_shared_media_library";
  return loadPackageFromValues(
    "https://libraries.example/media/manifest.json",
    values,
  );
}

test("Colors and Typographies keep stable runtime identities and validate references", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://assets.smallpen",
    await assetValues({ references: true, text: true }),
  );
  assert.equal(snapshot.runtime.colors[colorId], colorRuntimeId);
  assert.equal(
    snapshot.runtime.typographies[typographyId],
    typographyRuntimeId,
  );
  assert.deepEqual(snapshot.runtime.reverseColors[colorRuntimeId], { colorId });
  assert.deepEqual(snapshot.runtime.reverseTypographies[typographyRuntimeId], {
    typographyId,
  });

  const missingColor = await assetValues({ references: true });
  missingColor.get("assets/design.json").colors = [];
  await assert.rejects(
    loadPackageFromValues("memory://missing-color.smallpen", missingColor),
    (error) => error?.code === "missing_color_reference",
  );

  const missingTypography = await assetValues({ references: true, text: true });
  missingTypography.get("assets/design.json").typographies = [];
  await assert.rejects(
    loadPackageFromValues(
      "memory://missing-typography.smallpen",
      missingTypography,
    ),
    (error) => error?.code === "missing_typography_reference",
  );
});

test("Penpot fill and stroke Color references apply and reverse exactly", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://color-references.smallpen",
    await assetValues(),
  );
  const runtimeNodeId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle;
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: runtimeNodeId,
        operations: [
          {
            attr: "fills",
            type: "set",
            val: [
              {
                "fill-color": "#2563eb",
                "fill-color-ref-file": snapshot.runtime.file,
                "fill-color-ref-id": colorRuntimeId,
                "fill-opacity": 0.8,
              },
            ],
          },
          {
            attr: "strokes",
            type: "set",
            val: [
              {
                "stroke-color": "#2563eb",
                "stroke-color-ref-file": snapshot.runtime.file,
                "stroke-color-ref-id": colorRuntimeId,
                "stroke-width": 2,
              },
            ],
          },
        ],
        type: "mod-obj",
      },
    ],
    commitId: "referenced-paints",
  });
  assert.equal(batch.operations[0].changes.fills[0].colorRef, colorId);
  assert.equal(batch.operations[0].changes.strokes[0].colorRef, colorId);

  const prepared = await prepareOperationBatch(snapshot, batch);
  const node =
    prepared.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_rectangle;
  assert.equal(node.fills[0].colorRef, colorId);
  assert.equal(node.strokes[0].colorRef, colorId);
  const reversed = await prepareOperationBatch(
    prepared.snapshot,
    prepared.result.inverseBatch,
  );
  assert.equal(reversed.snapshot.revision, snapshot.revision);

  assert.throws(
    () =>
      compilePenpotChanges(snapshot, {
        changes: [
          {
            id: runtimeNodeId,
            operations: [
              {
                attr: "fills",
                type: "set",
                val: [
                  {
                    "fill-color": "#2563eb",
                    "fill-color-ref-file":
                      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    "fill-color-ref-id": colorRuntimeId,
                  },
                ],
              },
            ],
            type: "mod-obj",
          },
        ],
        commitId: "external-color-reference",
      }),
    (error) => error?.code === "unknown_external_library",
  );
});

test("Penpot external Color references retain their Package identity", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://external-color-consumer.smallpen",
    await assetValues(),
  );
  const library = await externalAssetSnapshot();
  const runtimeNodeId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle;
  const batch = compilePenpotChanges(
    snapshot,
    {
      changes: [
        {
          id: runtimeNodeId,
          operations: [
            {
              attr: "fills",
              type: "set",
              val: [
                {
                  "fill-color": "#2563eb",
                  "fill-color-ref-file": library.runtime.file,
                  "fill-color-ref-id": library.runtime.colors[colorId],
                },
              ],
            },
          ],
          type: "mod-obj",
        },
      ],
      commitId: "external-color-reference",
    },
    { libraries: [library] },
  );

  assert.deepEqual(batch.operations[0].changes.fills[0].colorRef, {
    assetId: colorId,
    packageId: "pkg_shared_library",
  });
  const prepared = await prepareOperationBatch(snapshot, batch);
  assert.deepEqual(
    prepared.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_rectangle.fills[0].colorRef,
    { assetId: colorId, packageId: "pkg_shared_library" },
  );
});

test("Penpot rich text Typography references apply and reverse exactly", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://typography-reference.smallpen",
    await assetValues({ text: true }),
  );
  const runtimeNodeId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle;
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: runtimeNodeId,
        operations: [
          {
            attr: "content",
            type: "set",
            val: textContent("Referenced", snapshot),
          },
        ],
        type: "mod-obj",
      },
    ],
    commitId: "typography-reference",
  });
  assert.deepEqual(batch.operations[0].changes, {
    text: "Referenced",
    textStyle: { typographyRef: typographyId },
  });

  const prepared = await prepareOperationBatch(snapshot, batch);
  const node =
    prepared.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_rectangle;
  assert.deepEqual(node.textStyle, { typographyRef: typographyId });
  const reversed = await prepareOperationBatch(
    prepared.snapshot,
    prepared.result.inverseBatch,
  );
  assert.equal(reversed.snapshot.revision, snapshot.revision);
});

test("Penpot external Typography references retain their Package identity", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://external-typography-consumer.smallpen",
    await assetValues({ text: true }),
  );
  const library = await externalAssetSnapshot();
  const runtimeNodeId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle;
  const batch = compilePenpotChanges(
    snapshot,
    {
      changes: [
        {
          id: runtimeNodeId,
          operations: [
            {
              attr: "content",
              type: "set",
              val: textContent(
                "Referenced externally",
                library,
                library.runtime.typographies[typographyId],
              ),
            },
          ],
          type: "mod-obj",
        },
      ],
      commitId: "external-typography-reference",
    },
    { libraries: [library] },
  );

  assert.deepEqual(batch.operations[0].changes.textStyle, {
    typographyRef: {
      assetId: typographyId,
      packageId: "pkg_shared_library",
    },
  });
  const prepared = await prepareOperationBatch(snapshot, batch);
  assert.deepEqual(
    prepared.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_rectangle.textStyle.typographyRef,
    { assetId: typographyId, packageId: "pkg_shared_library" },
  );
});

test("Penpot ignores Typography library paths copied into rich text", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://typography-path.smallpen",
    await assetValues({ text: true }),
  );
  const content = textContent("Referenced", snapshot);
  const paragraph = content.children[0].children[0];
  const span = paragraph.children[0];
  paragraph.path = "Text";
  span.path = "Text";

  const runtimeNodeId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle;
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: runtimeNodeId,
        operations: [{ attr: "content", type: "set", val: content }],
        type: "mod-obj",
      },
    ],
    commitId: "typography-path",
  });

  assert.deepEqual(batch.operations[0].changes, {
    text: "Referenced",
    textStyle: { typographyRef: typographyId },
  });
});

test("Penpot Color and Typography lifecycle changes replace one library atomically", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://asset-lifecycle.smallpen",
    await assetValues(),
  );
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        color: {
          color: "#1d4ed8",
          id: colorRuntimeId,
          name: "Primary blue",
          opacity: 0.9,
          path: "Brand",
        },
        type: "mod-color",
      },
      {
        typography: penpotTypography(typographyRuntimeId, "Body text"),
        type: "mod-typography",
      },
    ],
    commitId: "asset-lifecycle",
  });
  assert.equal(batch.operations.length, 1);
  assert.equal(batch.operations[0].type, "replace-asset-library");
  assert.equal(batch.operations[0].library.colors[0].name, "Primary blue");
  assert.equal(batch.operations[0].library.colors[0].paint.opacity, 0.9);
  assert.equal(batch.operations[0].library.typographies[0].name, "Body text");

  const prepared = await prepareOperationBatch(snapshot, batch);
  assert.deepEqual(prepared.result.changedFiles, ["assets/design.json"]);
  const reversed = await prepareOperationBatch(
    prepared.snapshot,
    prepared.result.inverseBatch,
  );
  assert.equal(reversed.snapshot.revision, snapshot.revision);
});

test("a first Penpot Asset Library can be created, referenced, and reversed", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://new-assets.smallpen",
    await fixtureValues(),
  );
  const runtimeNodeId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle;
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        color: {
          color: "#16a34a",
          id: addedColorRuntimeId,
          name: "Success",
          opacity: 1,
          path: "Status",
        },
        type: "add-color",
      },
      {
        typography: penpotTypography(addedTypographyRuntimeId),
        type: "add-typography",
      },
      {
        id: runtimeNodeId,
        operations: [
          {
            attr: "fills",
            type: "set",
            val: [
              {
                "fill-color": "#16a34a",
                "fill-color-ref-file": snapshot.runtime.file,
                "fill-color-ref-id": addedColorRuntimeId,
              },
            ],
          },
        ],
        type: "mod-obj",
      },
    ],
    commitId: "create-assets",
  });
  assert.deepEqual(
    batch.operations.map(({ type }) => type),
    ["replace-asset-library", "update-presentation-node"],
  );
  const prepared = await prepareOperationBatch(snapshot, batch);
  assert.deepEqual(prepared.snapshot.manifest.entries.assets, [
    "assets/assets.json",
  ]);
  assert.equal(
    prepared.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_rectangle.fills[0].colorRef,
    `color_${addedColorRuntimeId.replaceAll("-", "")}`,
  );

  const cleared = await prepareOperationBatch(prepared.snapshot, {
    baseRevision: prepared.snapshot.revision,
    batchId: "clear-new-color-reference",
    operations: [
      {
        changes: {
          fills: [{ color: "#16a34a", opacity: 1, type: "solid" }],
        },
        nodeId: "node_rectangle",
        presentationId: "pres_desktop",
        screenId: "scr_roundtrip",
        type: "update-presentation-node",
      },
    ],
  });
  const deleted = await prepareOperationBatch(cleared.snapshot, {
    baseRevision: cleared.snapshot.revision,
    batchId: "delete-new-asset-library",
    operations: [{ library: null, type: "replace-asset-library" }],
  });
  assert.deepEqual(deleted.result.deletedFiles, ["assets/assets.json"]);
  assert.deepEqual(deleted.snapshot.manifest.entries.assets, []);
  const restored = await prepareOperationBatch(
    deleted.snapshot,
    deleted.result.inverseBatch,
  );
  assert.deepEqual(restored.snapshot.manifest.entries.assets, [
    "assets/assets.json",
  ]);
});

test("deleting a referenced asset is rejected while unused assets can be deleted", async () => {
  const referenced = await loadPackageFromValues(
    "memory://referenced-assets.smallpen",
    await assetValues({ references: true }),
  );
  const referencedDelete = compilePenpotChanges(referenced, {
    changes: [{ id: colorRuntimeId, type: "del-color" }],
    commitId: "delete-referenced-color",
  });
  await assert.rejects(
    prepareOperationBatch(referenced, referencedDelete),
    (error) => error?.code === "missing_color_reference",
  );

  const unused = await loadPackageFromValues(
    "memory://unused-assets.smallpen",
    await assetValues(),
  );
  const deleteUnused = compilePenpotChanges(unused, {
    changes: [
      { id: colorRuntimeId, type: "del-color" },
      { id: typographyRuntimeId, type: "del-typography" },
    ],
    commitId: "delete-unused-assets",
  });
  const prepared = await prepareOperationBatch(unused, deleteUnused);
  const library = prepared.snapshot.entries["assets/design.json"];
  assert.deepEqual(library.colors, []);
  assert.deepEqual(library.typographies, []);
  const reversed = await prepareOperationBatch(
    prepared.snapshot,
    prepared.result.inverseBatch,
  );
  assert.equal(reversed.snapshot.revision, unused.revision);
});

test("content-addressed Media blobs validate bytes and keep stable runtime identities", async () => {
  const { blob, values } = await mediaValues({
    imageNode: true,
    references: true,
  });
  const snapshot = await loadPackageFromValues(
    "memory://media.smallpen",
    values,
  );
  assert.equal(snapshot.runtime.media[mediaId], mediaRuntimeId);
  assert.deepEqual(snapshot.runtime.reverseMedia[mediaRuntimeId], { mediaId });
  assert.ok(snapshot.runtime.mediaStorage[mediaId]);
  assert.deepEqual(snapshot.blobs.get(blob), values.get(blob));

  const missing = await mediaValues();
  missing.values.delete(missing.blob);
  await assert.rejects(
    loadPackageFromValues(
      "memory://missing-media-blob.smallpen",
      missing.values,
    ),
    (error) => error?.code === "missing_media_blob",
  );

  const corrupt = await mediaValues();
  corrupt.values.set(
    corrupt.blob,
    new Uint8Array(corrupt.bytes.length).fill(1),
  );
  await assert.rejects(
    loadPackageFromValues(
      "memory://corrupt-media-blob.smallpen",
      corrupt.values,
    ),
    (error) => error?.code === "media_blob_hash_mismatch",
  );
});

test("embedded Fonts validate blobs, project stable identities, and reverse Penpot text", async () => {
  const { blob, values } = await fontValues();
  const snapshot = await loadPackageFromValues(
    "memory://fonts.smallpen",
    values,
  );
  assert.equal(snapshot.runtime.fonts[fontId], fontRuntimeId);
  assert.deepEqual(snapshot.runtime.reverseFonts[fontRuntimeId], { fontId });
  assert.equal(
    snapshot.runtime.fontVariants[fontVariantId],
    fontVariantRuntimeId,
  );
  assert.deepEqual(snapshot.runtime.reverseFontVariants[fontVariantRuntimeId], {
    fontId,
    fontVariantId,
  });
  const fileRuntimeId = snapshot.runtime.fontFiles[fontVariantId].woff;
  assert.match(fileRuntimeId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(snapshot.runtime.reverseFontFiles[fileRuntimeId], {
    fontId,
    fontVariantId,
    format: "woff",
  });
  assert.deepEqual(snapshot.blobs.get(blob), values.get(blob));

  const runtimeNodeId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle;
  const content = textContent("Offline", snapshot);
  const span = content.children[0].children[0].children[0];
  delete span["typography-ref-file"];
  delete span["typography-ref-id"];
  span["font-family"] = "SmallPen Sans";
  span["font-id"] = `custom-${fontRuntimeId}`;
  span["font-variant-id"] = "normal-400";
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: runtimeNodeId,
        operations: [{ attr: "content", type: "set", val: content }],
        type: "mod-obj",
      },
    ],
    commitId: "edit-custom-font-text",
  });
  const prepared = await prepareOperationBatch(snapshot, batch);
  const node =
    prepared.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_rectangle;
  assert.equal(node.textStyle.fontId, fontId);
  const reversed = await prepareOperationBatch(
    prepared.snapshot,
    prepared.result.inverseBatch,
  );
  assert.equal(reversed.snapshot.revision, snapshot.revision);

  const missing = await fontValues();
  missing.values.delete(missing.blob);
  await assert.rejects(
    loadPackageFromValues(
      "memory://missing-font-blob.smallpen",
      missing.values,
    ),
    (error) => error?.code === "missing_font_blob",
  );
  const corrupt = await fontValues();
  corrupt.values.set(
    corrupt.blob,
    new Uint8Array(corrupt.bytes.length).fill(1),
  );
  await assert.rejects(
    loadPackageFromValues(
      "memory://corrupt-font-blob.smallpen",
      corrupt.values,
    ),
    (error) => error?.code === "font_blob_hash_mismatch",
  );
});

test("Penpot image fills, strokes, and IMAGE metadata apply and reverse", async () => {
  const { values } = await mediaValues({ imageNode: true });
  const snapshot = await loadPackageFromValues(
    "memory://penpot-media.smallpen",
    values,
  );
  const runtimeNodeId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle;
  const reference = {
    height: 24,
    id: mediaRuntimeId,
    "keep-aspect-ratio": true,
    mtype: "image/png",
    name: "Logo",
    width: 32,
  };
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: runtimeNodeId,
        operations: [
          { attr: "metadata", type: "set", val: reference },
          {
            attr: "fills",
            type: "set",
            val: [{ "fill-image": reference, "fill-opacity": 0.8 }],
          },
          {
            attr: "strokes",
            type: "set",
            val: [{ "stroke-image": reference, "stroke-width": 2 }],
          },
        ],
        type: "mod-obj",
      },
    ],
    commitId: "image-references",
  });
  assert.deepEqual(batch.operations[0].changes, {
    fills: [{ mediaRef: mediaId, opacity: 0.8, type: "image" }],
    mediaRef: mediaId,
    strokes: [{ mediaRef: mediaId, type: "image", width: 2 }],
  });
  const prepared = await prepareOperationBatch(snapshot, batch);
  const node =
    prepared.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_rectangle;
  assert.equal(node.mediaRef, mediaId);
  assert.equal(node.fills[0].mediaRef, mediaId);
  assert.equal(node.strokes[0].mediaRef, mediaId);
  const reversed = await prepareOperationBatch(
    prepared.snapshot,
    prepared.result.inverseBatch,
  );
  assert.equal(reversed.snapshot.revision, snapshot.revision);
});

test("Penpot external Media references retain their Package identity", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://external-media-consumer.smallpen",
    await assetValues(),
  );
  const library = await externalMediaSnapshot();
  const pageId = snapshot.runtime.pages.scr_roundtrip.pres_desktop;
  const parentId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_canvas;
  const runtimeNodeId = "88888888-8888-4888-8888-888888888888";
  const reference = {
    height: 24,
    id: library.runtime.media[mediaId],
    "keep-aspect-ratio": true,
    mtype: "image/png",
    name: "Logo",
    width: 32,
  };
  const batch = compilePenpotChanges(
    snapshot,
    {
      changes: [
        {
          id: runtimeNodeId,
          obj: {
            "frame-id": parentId,
            "parent-id": parentId,
            fills: [{ "fill-image": reference, "fill-opacity": 0.8 }],
            height: 24,
            id: runtimeNodeId,
            metadata: reference,
            name: "Shared logo",
            rotation: 0,
            shapes: [],
            strokes: [],
            type: "image",
            width: 32,
            x: 120,
            y: 180,
          },
          "page-id": pageId,
          "parent-id": parentId,
          type: "add-obj",
        },
      ],
      commitId: "external-image-reference",
    },
    { libraries: [library] },
  );
  const qualifiedReference = {
    assetId: mediaId,
    packageId: "pkg_shared_media_library",
  };

  assert.deepEqual(batch.operations[0].node.mediaRef, qualifiedReference);
  assert.deepEqual(batch.operations[0].node.fills, [
    { mediaRef: qualifiedReference, opacity: 0.8, type: "image" },
  ]);
  const prepared = await prepareOperationBatch(snapshot, batch);
  const node =
    prepared.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_88888888888848888888888888888888;
  assert.deepEqual(node.mediaRef, qualifiedReference);
  assert.deepEqual(node.fills[0].mediaRef, qualifiedReference);
});

test("Media metadata lifecycle preserves blobs and rejects live-reference deletion", async () => {
  const { blob, values } = await mediaValues();
  const snapshot = await loadPackageFromValues(
    "memory://media-lifecycle.smallpen",
    values,
  );
  const changed = compilePenpotChanges(snapshot, {
    changes: [
      {
        object: {
          height: 24,
          id: mediaRuntimeId,
          mtype: "image/png",
          name: "Renamed logo",
          path: "Identity",
          width: 32,
        },
        type: "mod-media",
      },
    ],
    commitId: "rename-media",
  });
  const prepared = await prepareOperationBatch(snapshot, changed);
  assert.equal(
    prepared.snapshot.entries["assets/design.json"].media[0].name,
    "Renamed logo",
  );
  assert.ok(prepared.snapshot.blobs.has(blob));
  const reversed = await prepareOperationBatch(
    prepared.snapshot,
    prepared.result.inverseBatch,
  );
  assert.equal(reversed.snapshot.revision, snapshot.revision);

  const referencedValues = await mediaValues({ imageNode: true });
  const referenced = await loadPackageFromValues(
    "memory://referenced-media.smallpen",
    referencedValues.values,
  );
  const deletion = compilePenpotChanges(referenced, {
    changes: [{ id: mediaRuntimeId, type: "del-media" }],
    commitId: "delete-referenced-media",
  });
  await assert.rejects(
    prepareOperationBatch(referenced, deletion),
    (error) => error?.code === "missing_media_reference",
  );
});

test("an orphan content-addressed blob can be attached atomically and restored", async () => {
  const values = await fixtureValues();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const sha256 = await sha256Hex(bytes);
  const blob = `blobs/${sha256}`;
  values.set(blob, bytes);
  const snapshot = await loadPackageFromValues(
    "memory://orphan-media.smallpen",
    values,
  );
  const library = {
    colors: [],
    fonts: [],
    id: "alib_media",
    media: [
      {
        blob,
        byteLength: bytes.byteLength,
        height: 1,
        id: mediaId,
        mimeType: "image/png",
        name: "Imported",
        path: "",
        sha256,
        width: 1,
      },
    ],
    typographies: [],
  };
  const attached = await prepareOperationBatch(snapshot, {
    baseRevision: snapshot.revision,
    batchId: "attach-media",
    operations: [{ library, type: "replace-asset-library" }],
  });
  assert.ok(attached.snapshot.blobs.has(blob));
  assert.equal(
    attached.snapshot.entries["assets/assets.json"].media[0].id,
    mediaId,
  );
  const reversed = await prepareOperationBatch(
    attached.snapshot,
    attached.result.inverseBatch,
  );
  assert.equal(reversed.snapshot.revision, snapshot.revision);
  assert.ok(reversed.snapshot.blobs.has(blob));
});
