import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { deflateSync } from "node:zlib";

import {
  compileDraftMerge,
  createFigmaDraftValues,
  diffDrafts,
  draftFromSnapshot,
  loadPackageFromValues,
} from "@smallpen/core";
import {
  decodeFigmaClipboard,
  importDraft,
  openPackage,
} from "@smallpen/local-package";

import {
  compileSchema,
  encodeBinarySchema,
} from "../packages/local-package/src/kiwi-runtime.mjs";

const importedAt = "2026-08-28T00:00:00.000Z";
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "apps", "cli", "bin", "smallpen.mjs");

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stderr.setEncoding("utf8");
    child.stdout.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr, stdout }));
  });
}

function guid(sessionID, localID) {
  return { localID, sessionID };
}

function matrix(x, y) {
  return { m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y };
}

function componentClipboardNodes() {
  return [
    {
      componentPropDefs: [
        {
          id: guid(9, 1),
          initialValue: { textValue: "Idle" },
          name: "State",
          preferredValues: { stringValues: ["Idle", "Pressed"] },
          type: "VARIANT",
        },
      ],
      guid: guid(1, 1),
      name: "Button",
      parentIndex: { guid: guid(0, 1) },
      size: { x: 120, y: 40 },
      transform: matrix(0, 0),
      type: "COMPONENT_SET",
    },
    {
      fillPaints: [
        { color: { b: 0.8, g: 0.2, r: 0.4 }, type: "SOLID" },
      ],
      guid: guid(1, 2),
      name: "State=Idle",
      parentIndex: { guid: guid(1, 1) },
      size: { x: 120, y: 40 },
      transform: matrix(0, 0),
      type: "COMPONENT",
      variantPropSpecs: [{ propDefId: guid(9, 1), value: "Idle" }],
    },
    {
      componentPropAssignments: [
        { binary: new Uint8Array([1, 2, 3]), sequence: 9n },
      ],
      fillPaints: [{ type: "GRADIENT_LINEAR" }],
      guid: guid(1, 3),
      name: "Button Instance",
      parentIndex: { guid: guid(0, 1) },
      size: { x: 120, y: 40 },
      symbolData: { symbolID: guid(1, 2) },
      transform: matrix(20, 20),
      type: "INSTANCE",
    },
  ];
}

async function structuredDraft(nodes = componentClipboardNodes(), hash = "a".repeat(64)) {
  const model = createFigmaDraftValues({
    importedAt,
    inputHash: hash,
    meta: { dataType: "NODE_CHANGES", fileKey: "fixture", pasteID: 42 },
    nodeChanges: nodes,
    packageId: "pkg_figma_draft",
  });
  const snapshot = await loadPackageFromValues("/tmp/fixture.smallpen", model.values);
  return { model, snapshot };
}

test("structured Figma Draft preserves components, instances, metadata, and losses", async () => {
  const { snapshot } = await structuredDraft();
  assert.equal(snapshot.manifest.draft.provenance.sourceKind, "figma-structured");
  assert.equal(snapshot.manifest.draft.provenance.sourceFileId, "fixture");
  assert.equal(snapshot.domain.componentSets.size, 1);
  const component = [...snapshot.domain.componentSets.values()][0];
  assert.equal(component.axes[0].role, "state");
  const screen = snapshot.entries["screens/imported.json"];
  const instance = screen.presentations[0].nodes.node_figma_1_3;
  assert.equal(instance.instance.component.assetId, component.id);
  assert.deepEqual(instance.instance.variant, { axis_figma_9_1: "Idle" });
  assert.equal(instance.sourceMetadata.figma.sourceType, "INSTANCE");
  assert.deepEqual(instance.sourceMetadata.figma.componentPropAssignments, [
    {
      binary: { byteLength: 3, omitted: true, type: "Uint8Array" },
      sequence: "9",
    },
  ]);
  assert.equal(
    snapshot.manifest.draft.losses.filter(({ code }) => code === "figma_fill_unsupported").length,
    1,
  );
});

test("Draft diff is independent and compile emits only selected current-revision changes", async () => {
  const before = await structuredDraft();
  const changedNodes = componentClipboardNodes();
  changedNodes[2].transform = matrix(28, 20);
  const after = await structuredDraft(changedNodes, "b".repeat(64));
  const diff = diffDrafts(draftFromSnapshot(before.snapshot), draftFromSnapshot(after.snapshot));
  assert.ok(diff.semantic.length > 0);

  const batch = compileDraftMerge(
    before.snapshot,
    draftFromSnapshot(after.snapshot),
    [
      {
        fields: ["x"],
        nodeId: "node_figma_1_3",
        screenId: "scr_figma_import",
      },
    ],
    { batchId: "draft_selected_change" },
  );
  assert.equal(batch.baseRevision, before.snapshot.revision);
  assert.deepEqual(batch.operations, [
    {
      changes: { x: 28 },
      nodeId: "node_figma_1_3",
      presentationId: "pres_figma_import",
      screenId: "scr_figma_import",
      type: "update-presentation-node",
    },
  ]);
  assert.equal(
    before.snapshot.entries["screens/imported.json"].presentations[0].nodes
      .node_figma_1_3.x,
    20,
  );
});

function minimalClipboardHtml() {
  const schema = {
    definitions: [
      {
        fields: [
          { isArray: false, isDeprecated: false, name: "sessionID", type: "uint", value: 0 },
          { isArray: false, isDeprecated: false, name: "localID", type: "uint", value: 0 },
        ],
        kind: "STRUCT",
        name: "GUID",
      },
      {
        fields: [
          { isArray: false, isDeprecated: false, name: "x", type: "float", value: 0 },
          { isArray: false, isDeprecated: false, name: "y", type: "float", value: 0 },
        ],
        kind: "STRUCT",
        name: "Vector",
      },
      {
        fields: [
          { isArray: false, isDeprecated: false, name: "guid", type: "GUID", value: 1 },
          { isArray: false, isDeprecated: false, name: "type", type: "string", value: 2 },
          { isArray: false, isDeprecated: false, name: "name", type: "string", value: 3 },
          { isArray: false, isDeprecated: false, name: "size", type: "Vector", value: 4 },
        ],
        kind: "MESSAGE",
        name: "NodeChange",
      },
      {
        fields: [
          { isArray: true, isDeprecated: false, name: "nodeChanges", type: "NodeChange", value: 1 },
        ],
        kind: "MESSAGE",
        name: "Message",
      },
    ],
    package: null,
  };
  const compiled = compileSchema(schema);
  const schemaBytes = deflateSync(encodeBinarySchema(schema));
  const dataBytes = deflateSync(
    compiled.encodeMessage({
      nodeChanges: [
        { guid: guid(1, 9), name: "Decoded Frame", size: { x: 320, y: 200 }, type: "FRAME" },
      ],
    }),
  );
  const total = 20 + schemaBytes.byteLength + dataBytes.byteLength;
  const payload = new Uint8Array(total);
  const view = new DataView(payload.buffer);
  payload.set(new TextEncoder().encode("fig-kiwi"), 0);
  view.setUint32(8, 101, true);
  view.setUint32(12, schemaBytes.byteLength, true);
  payload.set(schemaBytes, 16);
  const dataOffset = 16 + schemaBytes.byteLength;
  view.setUint32(dataOffset, dataBytes.byteLength, true);
  payload.set(dataBytes, dataOffset + 4);
  const meta = Buffer.from(
    JSON.stringify({ dataType: "NODE_CHANGES", fileKey: "decoded", pasteID: 7 }),
  ).toString("base64");
  return `<meta>(figmeta)${meta}(/figmeta)</meta><div>(figma)${Buffer.from(payload).toString("base64")}(/figma)</div>`;
}

test("native Figma clipboard markers decode their embedded Kiwi schema", async () => {
  const decoded = await decodeFigmaClipboard(minimalClipboardHtml());
  assert.equal(decoded.meta.fileKey, "decoded");
  assert.equal(decoded.nodeChanges[0].name, "Decoded Frame");
  assert.equal(decoded.nodeChanges[0].size.x, 320);
});

const onePixelPng = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

test("PNG fallback writes one validated independent Draft and never overwrites", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-draft-"));
  context.after(() => rm(parent, { force: true, recursive: true }));
  const output = join(parent, "fallback.smallpen");
  const result = await importDraft({
    bytes: onePixelPng,
    importedAt,
    kind: "png",
    output,
    packageId: "pkg_png_draft",
  });
  assert.equal(result.provenance.sourceKind, "png");
  assert.equal(result.losses[0].code, "flat_media_only");
  const loaded = await openPackage(output);
  const node = loaded.entries["screens/imported.json"].presentations[0].nodes
    .node_flat_import;
  assert.equal(node.type, "IMAGE");
  assert.equal(loaded.blobs.size, 1);
  assert.equal((await readFile(join(output, [...loaded.blobs.keys()][0]))).byteLength, onePixelPng.byteLength);
  await assert.rejects(
    importDraft({
      bytes: onePixelPng,
      importedAt,
      kind: "png",
      output,
      packageId: "pkg_png_draft",
    }),
    ({ code }) => code === "draft_output_exists",
  );
});

test("public CLI imports, inspects, diffs, and compiles independent Draft files", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-draft-cli-"));
  context.after(() => rm(parent, { force: true, recursive: true }));
  const input = join(parent, "fallback.png");
  const first = join(parent, "first.smallpen");
  const second = join(parent, "second.smallpen");
  const selections = join(parent, "selections.json");
  await writeFile(input, onePixelPng);
  for (const output of [first, second]) {
    const imported = await runCli([
      "import-draft",
      output,
      "--kind",
      "png",
      "--input",
      input,
      "--package-id",
      "pkg_cli_draft",
      "--json",
    ]);
    assert.equal(imported.code, 0, `${imported.stderr}\n${imported.stdout}`);
    assert.equal(JSON.parse(imported.stdout).provenance.sourceKind, "png");
  }
  const inspected = await runCli(["inspect", first, "--json"]);
  assert.equal(inspected.code, 0, inspected.stderr);
  assert.equal(JSON.parse(inspected.stdout).draft.losses[0].code, "flat_media_only");

  const diffed = await runCli(["draft-diff", first, "--after", second, "--json"]);
  assert.equal(diffed.code, 0, diffed.stderr);
  assert.deepEqual(JSON.parse(diffed.stdout), { losses: [], semantic: [] });

  await writeFile(
    selections,
    JSON.stringify([
      {
        fields: ["x"],
        nodeId: "node_flat_import",
        screenId: "scr_flat_import",
      },
    ]),
  );
  const compiled = await runCli([
    "draft-compile",
    first,
    "--draft",
    second,
    "--selections",
    selections,
    "--batch-id",
    "cli_draft_compile",
    "--json",
  ]);
  assert.equal(compiled.code, 0, `${compiled.stderr}\n${compiled.stdout}`);
  const batch = JSON.parse(compiled.stdout);
  assert.equal(batch.baseRevision, (await openPackage(first)).revision);
  assert.equal(batch.batchId, "cli_draft_compile");
  assert.deepEqual(batch.operations[0].changes, { x: 0 });
});
