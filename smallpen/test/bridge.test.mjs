import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

import { serveLocalPackage } from "@smallpen/background";
import {
  sha256Hex,
  SMALLPEN_FORMAT_CAPABILITIES,
  SMALLPEN_RUNTIME_CAPABILITIES,
} from "@smallpen/core";
import { openPackage } from "@smallpen/local-package";
import { compilePenpotChanges } from "@smallpen/penpot-adapter";
import { assetEntry, onlyScreen, readModelEntry, seedLegacyIds, setPackageId } from "./helpers/named.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "roundtrip.smallpen");
const cli = join(here, "..", "apps", "cli", "bin", "smallpen.mjs");

async function copyFixture() {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-bridge-test-"));
  const packagePath = join(parent, "roundtrip.smallpen");
  await cp(fixture, packagePath, { recursive: true });
  await seedLegacyIds(packagePath, "roundtrip");
  return packagePath;
}

// A font file in assets/fonts/ and its @font-face in tokens.css.
async function addEmbeddedFont(packagePath) {
  const bytes = new Uint8Array([0x77, 0x4f, 0x46, 0x46, 0, 1, 0, 0]);
  await mkdir(join(packagePath, "assets", "fonts"), { recursive: true });
  await writeFile(join(packagePath, "assets", "fonts", "SmallPenSans-400.woff"), bytes);
  const tokens = join(packagePath, "tokens.css");
  await writeFile(
    tokens,
    `${await readFile(tokens, "utf8")}\n@font-face {\n  font-family: "SmallPen Sans";\n  src: url("assets/fonts/SmallPenSans-400.woff");\n  font-weight: 400;\n  font-style: normal;\n}\n`,
  );
  const font = assetEntry(await openPackage(packagePath)).fonts[0];
  return { bytes, fontId: font.id, variantId: font.variants[0].id };
}

function minimalTtf() {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x00010000, false);
  view.setUint16(4, 1, false);
  view.setUint32(12, 0x74657374, false);
  view.setUint32(16, 0x01020304, false);
  view.setUint32(20, 28, false);
  view.setUint32(24, 4, false);
  bytes.set([1, 2, 3, 4], 28);
  return bytes;
}

function runCli(args, input) {
  // Schema and full-value checks opt into stdout; fixed-file transport is tested separately.
  if (
    (args[0] === "schema" || args.includes("--full")) &&
    !args.includes("--stdout")
  )
    args = [...args, "--stdout"];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr, stdout }));
    child.stdin.end(input);
  });
}

test("the Penpot compiler emits one typed opacity operation with the current base revision", async () => {
  const packagePath = await copyFixture();
  const snapshot = await openPackage(packagePath);
  const runtimeId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle;

  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: runtimeId,
        operations: [{ attr: "opacity", type: "set", val: 0.55 }],
        pageId: snapshot.runtime.pages.scr_roundtrip.pres_desktop,
        type: "mod-obj",
      },
    ],
    commitId: "11111111-1111-1111-8111-111111111111",
  });

  assert.equal(batch.baseRevision, snapshot.revision);
  assert.equal(batch.batchId, "penpot_11111111-1111-1111-8111-111111111111");
  assert.deepEqual(batch.operations, [
    {
      changes: { opacity: 0.55 },
      nodeId: "node_rectangle",
      presentationId: "pres_desktop",
      screenId: "scr_roundtrip",
      type: "update-presentation-node",
    },
  ]);
});

test("the local HTTP bridge compiles and commits a Penpot opacity edit", async (context) => {
  const packagePath = await copyFixture();
  const service = await serveLocalPackage({ packagePath, port: 0 });
  context.after(() => service.close());
  const baseUrl = service.url;

  const unauthorized = await fetch(
    `http://127.0.0.1:${service.port}/v1/workspace`,
  );
  assert.equal(unauthorized.status, 404);

  const opened = await fetch(`${baseUrl}/v1/workspace`).then((response) =>
    response.json(),
  );
  assert.deepEqual(opened.capabilities, SMALLPEN_RUNTIME_CAPABILITIES);
  assert.deepEqual(opened.formatCapabilities, SMALLPEN_FORMAT_CAPABILITIES);
  const response = await fetch(`${baseUrl}/v1/penpot/commit`, {
    body: JSON.stringify({
      baseRevision: opened.revision,
      changes: [
        {
          id: opened.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle,
          operations: [{ attr: "opacity", type: "set", val: 0.4 }],
          type: "mod-obj",
        },
      ],
      commitId: "22222222-2222-2222-8222-222222222222",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).then((result) => result.json());
  const screen = await readModelEntry(packagePath, "screens/roundtrip.json");

  assert.equal(response.revn, 1);
  assert.match(response.revision, /^[a-f0-9]{64}$/);
  assert.equal(screen.presentations[0].nodes.node_rectangle.opacity, 0.4);
});

test("an agent's tokens.css edit reloads into the App with resolved bound attributes", async (context) => {
  const packagePath = await copyFixture();
  const tokensPath = join(packagePath, "tokens.css");
  await writeFile(tokensPath, ":root {\n  --color-primary: #2563eb;\n}\n");
  const pagePath = join(packagePath, "pages", "Round Trip.html");
  await writeFile(pagePath, (await readFile(pagePath, "utf8")).replace("bg-[#7c3aed]", "bg-primary"));

  const service = await serveLocalPackage({ packagePath, port: 0 });
  context.after(() => service.close());
  let opened = await fetch(`${service.url}/v1/workspace`).then((response) =>
    response.json(),
  );
  assert.equal(
    onlyScreen(opened).presentations[0].nodes
      .node_rectangle.fills[0].color,
    "#2563eb",
  );

  // The agent edits the Token in tokens.css and checks the package.
  await writeFile(tokensPath, ":root {\n  --color-primary: #db2777;\n}\n");
  const checked = await runCli(["check", packagePath, "--json"]);
  assert.equal(checked.code, 0, `${checked.stderr}\n${checked.stdout}`);
  const changedRevision = JSON.parse(checked.stdout).revision;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    opened = await fetch(`${service.url}/v1/workspace`).then((response) =>
      response.json(),
    );
    if (opened.revision === changedRevision) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(opened.revision, changedRevision);
  assert.equal(
    onlyScreen(opened).presentations[0].nodes
      .node_rectangle.fills[0].color,
    "#db2777",
  );
});

test("the local HTTP bridge requires optimistic concurrency on every Penpot commit", async (context) => {
  const packagePath = await copyFixture();
  const service = await serveLocalPackage({ packagePath, port: 0 });
  context.after(() => service.close());
  const opened = await fetch(`${service.url}/v1/workspace`).then((response) =>
    response.json(),
  );

  const response = await fetch(`${service.url}/v1/penpot/commit`, {
    body: JSON.stringify({
      changes: [
        {
          id: opened.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle,
          operations: [{ attr: "opacity", type: "set", val: 0.4 }],
          type: "mod-obj",
        },
      ],
      commitId: "missing-base-revision",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, "missing_base_revision");
  assert.equal((await openPackage(packagePath)).revision, opened.revision);
});

test("the local HTTP bridge refuses every non-loopback binding", async (context) => {
  const packagePath = await copyFixture();
  for (const host of ["0.0.0.0", "::", "192.0.2.1"]) {
    await context.test(host, async () => {
      await assert.rejects(
        serveLocalPackage({ host, packagePath, port: 0 }),
        (error) =>
          error?.code === "invalid_background_host" &&
          error?.details?.host === host,
      );
    });
  }
});

test("the local HTTP bridge keeps multiple Package sessions independent", async (context) => {
  const firstPath = await copyFixture();
  const secondPath = await copyFixture();
  await setPackageId(secondPath, "pkg_second_session");
  await seedLegacyIds(secondPath, "roundtrip");
  const service = await serveLocalPackage({ packagePath: firstPath, port: 0 });
  context.after(() => service.close());

  const initial = await fetch(`${service.url}/v1/packages`).then((response) =>
    response.json(),
  );
  assert.equal(initial.packages.length, 1);
  assert.equal(initial.packages[0].locator, undefined);
  const firstSessionId = initial.packages[0].sessionId;

  const opened = await fetch(`${service.url}/v1/packages/open`, {
    body: JSON.stringify({ locator: secondPath }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).then((response) => response.json());
  assert.equal(opened.packages.length, 2);
  assert.notEqual(opened.activeSessionId, firstSessionId);
  const secondSessionId = opened.activeSessionId;

  const first = await fetch(`${service.url}/v1/workspace`, {
    headers: { "x-smallpen-package": firstSessionId },
  }).then((response) => response.json());
  const second = await fetch(`${service.url}/v1/workspace`, {
    headers: { "x-smallpen-package": secondSessionId },
  }).then((response) => response.json());
  assert.equal(first.packageSessionId, firstSessionId);
  assert.equal(second.packageSessionId, secondSessionId);
  assert.notEqual(first.locator, second.locator);

  const fileSelected = await fetch(`${service.url}/v1/workspace`, {
    headers: {
      "x-smallpen-file": second.runtime.file,
      "x-smallpen-package": firstSessionId,
    },
  }).then((response) => response.json());
  assert.equal(fileSelected.packageSessionId, secondSessionId);

  const response = await fetch(`${service.url}/v1/penpot/commit`, {
    body: JSON.stringify({
      baseRevision: first.revision,
      changes: [
        {
          id: first.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle,
          operations: [{ attr: "opacity", type: "set", val: 0.41 }],
          type: "mod-obj",
        },
      ],
      commitId: "multi-package-first-only",
    }),
    headers: {
      "content-type": "application/json",
      "x-smallpen-package": firstSessionId,
    },
    method: "POST",
  });
  assert.equal(response.status, 200);

  const firstScreen = await readModelEntry(firstPath, "screens/roundtrip.json");
  const secondScreen = await readModelEntry(secondPath, "screens/roundtrip.json");
  assert.equal(firstScreen.presentations[0].nodes.node_rectangle.opacity, 0.41);
  assert.equal(secondScreen.presentations[0].nodes.node_rectangle.opacity ?? 1, 1);

  const undone = await fetch(`${service.url}/v1/history/undo`, {
    headers: { "x-smallpen-package": firstSessionId },
    method: "POST",
  });
  assert.equal(undone.status, 200);
  const restored = await readModelEntry(firstPath, "screens/roundtrip.json");
  assert.equal(restored.presentations[0].nodes.node_rectangle.opacity ?? 1, 1);
});

test("the local HTTP bridge restores a recent Package by stable file ID", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-file-id-restore-"));
  const firstPath = join(parent, "first.smallpen");
  const secondPath = join(parent, "second.smallpen");
  const statePath = join(parent, "application-state.json");
  await cp(fixture, firstPath, { recursive: true });
  await seedLegacyIds(firstPath, "roundtrip");
  await cp(fixture, secondPath, { recursive: true });
  await seedLegacyIds(secondPath, "roundtrip");
  await setPackageId(secondPath, "pkg_second_restore");
  await seedLegacyIds(secondPath, "roundtrip");
  let service;
  context.after(async () => {
    await service?.close();
    await rm(parent, { force: true, recursive: true });
  });

  service = await serveLocalPackage({
    applicationStatePath: statePath,
    packagePath: firstPath,
    port: 0,
  });
  const opened = await fetch(`${service.url}/v1/packages/open`, {
    body: JSON.stringify({ locator: secondPath }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).then((response) => response.json());
  const second = await fetch(`${service.url}/v1/workspace`, {
    headers: { "x-smallpen-package": opened.activeSessionId },
  }).then((response) => response.json());
  const fileId = second.runtime.file;
  await service.close();

  service = await serveLocalPackage({
    applicationStatePath: statePath,
    packagePath: firstPath,
    port: 0,
  });
  const restoredResponse = await fetch(`${service.url}/v1/workspace`, {
    headers: { "x-smallpen-file": fileId },
  });
  assert.equal(restoredResponse.status, 200);
  const restored = await restoredResponse.json();
  assert.equal(restored.runtime.file, fileId);
  assert.equal(restored.manifest.packageId, "pkg_second_restore");

  const missing = await fetch(`${service.url}/v1/workspace`, {
    headers: { "x-smallpen-file": "11111111-1111-4111-8111-111111111111" },
  });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "file_not_found");
});

test("recent file lookup distinguishes identity changes from missing files", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-file-id-mismatch-"));
  const firstPath = join(parent, "first.smallpen");
  const secondPath = join(parent, "second.smallpen");
  const statePath = join(parent, "application-state.json");
  await cp(fixture, firstPath, { recursive: true });
  await seedLegacyIds(firstPath, "roundtrip");
  await cp(fixture, secondPath, { recursive: true });
  await seedLegacyIds(secondPath, "roundtrip");
  let service;
  context.after(async () => {
    await service?.close();
    await rm(parent, { force: true, recursive: true });
  });

  service = await serveLocalPackage({
    applicationStatePath: statePath,
    packagePath: firstPath,
    port: 0,
  });
  const opened = await fetch(`${service.url}/v1/packages/open`, {
    body: JSON.stringify({ locator: secondPath }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).then((response) => response.json());
  const second = await fetch(`${service.url}/v1/workspace`, {
    headers: { "x-smallpen-package": opened.activeSessionId },
  }).then((response) => response.json());
  await service.close();

  const originalPackageId = (await openPackage(secondPath)).manifest.packageId;
  await setPackageId(secondPath, "pkg_replaced_at_same_locator");
  service = await serveLocalPackage({
    applicationStatePath: statePath,
    packagePath: firstPath,
    port: 0,
  });
  const response = await fetch(`${service.url}/v1/workspace`, {
    headers: { "x-smallpen-file": second.runtime.file },
  });

  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, "file_identity_mismatch");

  await service.close();
  await setPackageId(secondPath, originalPackageId);
  await writeFile(join(secondPath, "pages", "Round Trip.html"), "<!doctype html>\n<html>\n<body><div");
  service = await serveLocalPackage({
    applicationStatePath: statePath,
    packagePath: firstPath,
    port: 0,
  });
  const corrupt = await fetch(`${service.url}/v1/workspace`, {
    headers: { "x-smallpen-file": second.runtime.file },
  });
  const corruptError = (await corrupt.json()).error;
  assert.equal(corrupt.status, 422);
  assert.notEqual(corruptError.code, "file_not_found");
});

test("the local HTTP bridge exposes durable application preferences and recent Packages", async (context) => {
  const firstPath = await copyFixture();
  const secondPath = await copyFixture();
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "smallpen-bridge-state-"),
  );
  const service = await serveLocalPackage({
    applicationStatePath: join(stateDirectory, "state.json"),
    packagePath: firstPath,
    port: 0,
  });
  context.after(async () => {
    await service.close();
    await rm(stateDirectory, { force: true, recursive: true });
  });

  let application = await fetch(`${service.url}/v1/application`).then(
    (response) => response.json(),
  );
  assert.deepEqual(application.preferences, {
    language: "",
    renderer: "svg",
    theme: "dark",
  });
  assert.equal(application.recentPackages.length, 1);
  assert.equal(
    application.recentPackages[0].locator,
    await realpath(firstPath),
  );

  const preferences = await fetch(`${service.url}/v1/preferences`, {
    body: JSON.stringify({
      language: "zh_hant",
      renderer: "wasm",
      theme: "system",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(preferences.status, 200);
  await fetch(`${service.url}/v1/packages/open`, {
    body: JSON.stringify({ locator: secondPath }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  application = await fetch(`${service.url}/v1/application`).then((response) =>
    response.json(),
  );
  assert.deepEqual(application.preferences, {
    language: "zh_hant",
    renderer: "wasm",
    theme: "system",
  });
  assert.deepEqual(
    application.recentPackages.map(({ locator }) => locator),
    [await realpath(secondPath), await realpath(firstPath)],
  );
  const workspace = await fetch(`${service.url}/v1/workspace`).then(
    (response) => response.json(),
  );
  assert.deepEqual(workspace.preferences, application.preferences);
});

test("the local HTTP bridge rejects one of two stale concurrent writers", async (context) => {
  const packagePath = await copyFixture();
  const service = await serveLocalPackage({ packagePath, port: 0 });
  context.after(() => service.close());
  const opened = await fetch(`${service.url}/v1/workspace`).then((response) =>
    response.json(),
  );
  const commit = (opacity, commitId) =>
    fetch(`${service.url}/v1/penpot/commit`, {
      body: JSON.stringify({
        baseRevision: opened.revision,
        changes: [
          {
            id: opened.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle,
            operations: [{ attr: "opacity", type: "set", val: opacity }],
            type: "mod-obj",
          },
        ],
        commitId,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  const responses = await Promise.all([
    commit(0.21, "concurrent-writer-a"),
    commit(0.79, "concurrent-writer-b"),
  ]);
  assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 409]);
});

test("upload sessions cannot cross Package session boundaries", async (context) => {
  const firstPath = await copyFixture();
  const secondPath = await copyFixture();
  const service = await serveLocalPackage({ packagePath: firstPath, port: 0 });
  context.after(() => service.close());
  const packages = await fetch(`${service.url}/v1/packages`).then((response) =>
    response.json(),
  );
  const firstSessionId = packages.packages[0].sessionId;
  const opened = await fetch(`${service.url}/v1/packages/open`, {
    body: JSON.stringify({ locator: secondPath }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).then((response) => response.json());
  const secondSessionId = opened.activeSessionId;
  const upload = await fetch(`${service.url}/v1/upload/session`, {
    body: JSON.stringify({ totalChunks: 1 }),
    headers: {
      "content-type": "application/json",
      "x-smallpen-package": firstSessionId,
    },
    method: "POST",
  }).then((response) => response.json());

  const rejected = await fetch(
    `${service.url}/v1/upload/session/${upload["session-id"]}/chunk/0`,
    {
      body: minimalTtf(),
      headers: { "x-smallpen-package": secondSessionId },
      method: "POST",
    },
  );

  assert.equal(rejected.status, 422);
  const accepted = await fetch(
    `${service.url}/v1/upload/session/${upload["session-id"]}/chunk/0`,
    {
      body: minimalTtf(),
      headers: { "x-smallpen-package": firstSessionId },
      method: "POST",
    },
  );
  assert.equal(accepted.status, 200);
});

test("the local HTTP bridge exposes shared domain view models", async (context) => {
  const packagePath = await copyFixture();
  const service = await serveLocalPackage({ packagePath, port: 0 });
  context.after(() => service.close());

  const overview = await fetch(`${service.url}/v1/ui/overview`).then(
    (response) => response.json(),
  );
  assert.equal(overview.package.name, "SmallPen Round Trip");
  assert.equal(overview.counts.screens, 1);
  assert.equal(overview.screens[0].presentations[0].id, "pres_desktop");

  const design = await fetch(
    `${service.url}/v1/ui/design?screen=scr_roundtrip&presentation=pres_desktop`,
  ).then((response) => response.json());
  assert.equal(design.selection.screenId, "scr_roundtrip");
  assert.equal(design.projection.rootId, "node_canvas");
  assert.equal(design.selectorOptions.screens.length, 1);

  const compare = await fetch(`${service.url}/v1/ui/compare`, {
    body: JSON.stringify({
      selectors: [
        { presentationId: "pres_desktop", screenId: "scr_roundtrip" },
        { presentationId: "pres_desktop", screenId: "scr_roundtrip" },
      ],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).then((response) => response.json());
  assert.equal(compare.items.length, 2);

  const endpoints = ["catalog", "design-system", "repair", "requirements"];
  for (const endpoint of endpoints) {
    const response = await fetch(`${service.url}/v1/ui/${endpoint}`);
    assert.equal(response.status, 200, endpoint);
  }

  const operationResponse = await fetch(`${service.url}/v1/operations`, {
    body: JSON.stringify({
      baseRevision: overview.package.revision,
      batchId: "workspace-view-canonical-operation",
      operations: [
        {
          changes: { opacity: 0.72 },
          nodeId: "node_rectangle",
          presentationId: "pres_desktop",
          screenId: "scr_roundtrip",
          type: "update-presentation-node",
        },
      ],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(operationResponse.status, 200);
  assert.equal(
    (await readModelEntry(packagePath, "screens/roundtrip.json")).presentations[0].nodes.node_rectangle.opacity,
    0.72,
  );
});

test("the local HTTP bridge imports and serves content-addressed Media", async (context) => {
  const packagePath = await copyFixture();
  const service = await serveLocalPackage({ packagePath, port: 0 });
  context.after(() => service.close());
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const response = await fetch(`${service.url}/v1/media/import`, {
    body: bytes,
    headers: {
      "content-type": "image/png",
      "x-smallpen-media-name": "Pixel",
    },
    method: "POST",
  });
  assert.equal(response.status, 201);
  const uploaded = await response.json();
  assert.equal(uploaded.name, "Pixel");
  assert.equal(uploaded.width, 1);
  assert.equal(uploaded.height, 1);
  assert.match(uploaded.id, /^[a-f0-9-]{36}$/);

  const mediaResponse = await fetch(`${service.url}/v1/media/${uploaded.id}`);
  assert.equal(mediaResponse.status, 200);
  assert.equal(mediaResponse.headers.get("content-type"), "image/png");
  assert.match(
    mediaResponse.headers.get("content-security-policy"),
    /default-src 'none'/,
  );
  assert.deepEqual(Buffer.from(await mediaResponse.arrayBuffer()), bytes);

  const opened = await fetch(`${service.url}/v1/workspace`).then((result) =>
    result.json(),
  );
  assert.equal(opened.blobs, undefined);
  assert.equal(Object.keys(opened.runtime.media).length, 1);
  const library = opened.entries[opened.manifest.entries.assets[0]];
  assert.equal(library.media[0].name, "Pixel");

  const committed = await fetch(`${service.url}/v1/penpot/commit`, {
    body: JSON.stringify({
      baseRevision: opened.revision,
      changes: [{ object: uploaded, type: "add-media" }],
      commitId: "add-uploaded-media",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(committed.status, 200);
});

test("the local HTTP bridge serves embedded Font files by runtime identity", async (context) => {
  const packagePath = await copyFixture();
  const { bytes, fontId, variantId } = await addEmbeddedFont(packagePath);
  const service = await serveLocalPackage({ packagePath, port: 0 });
  context.after(() => service.close());
  const opened = await fetch(`${service.url}/v1/workspace`).then((response) =>
    response.json(),
  );
  const fileId = opened.runtime.fontFiles[variantId].woff;
  const response = await fetch(`${service.url}/v1/font/${fileId}`);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("content-type"), "font/woff");
  assert.equal(
    response.headers.get("cross-origin-resource-policy"),
    "cross-origin",
  );
  assert.match(response.headers.get("etag"), /^"sha256-[a-f0-9]{64}"$/);
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    Buffer.from(bytes),
  );

  const missing = await fetch(
    `${service.url}/v1/font/00000000-0000-4000-8000-000000000000`,
  );
  assert.equal(missing.status, 404);

  const deleted = await fetch(`${service.url}/v1/font/delete`, {
    body: JSON.stringify({ id: opened.runtime.fonts[fontId] }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(deleted.status, 200, await deleted.clone().text());
  const reloaded = await fetch(`${service.url}/v1/workspace`).then((result) =>
    result.json(),
  );
  // The last font gone, the package has no asset library, no @font-face
  // and no font file.
  assert.deepEqual(assetEntry(reloaded)?.fonts ?? [], []);
  assert.doesNotMatch(await readFile(join(packagePath, "tokens.css"), "utf8"), /@font-face/);
  await assert.rejects(readFile(join(packagePath, "assets", "fonts", "SmallPenSans-400.woff")), (error) => error.code === "ENOENT");
});

test("the local HTTP bridge creates, renames, and deletes an offline Font", async (context) => {
  const packagePath = await copyFixture();
  const service = await serveLocalPackage({ packagePath, port: 0 });
  context.after(() => service.close());
  const sessionResponse = await fetch(`${service.url}/v1/upload/session`, {
    body: JSON.stringify({ totalChunks: 1 }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(sessionResponse.status, 201);
  const sessionId = (await sessionResponse.json())["session-id"];
  const ttf = minimalTtf();
  const chunkResponse = await fetch(
    `${service.url}/v1/upload/session/${sessionId}/chunk/0`,
    { body: ttf, method: "POST" },
  );
  assert.equal(chunkResponse.status, 200);

  const rawFontId = "18181818-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const createdResponse = await fetch(`${service.url}/v1/font/variant`, {
    body: JSON.stringify({
      fontFamily: "Offline Sans",
      fontId: rawFontId,
      fontStyle: "normal",
      fontWeight: 400,
      uploads: { "font/ttf": sessionId },
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 201, JSON.stringify(created));
  assert.equal(created["font-id"], rawFontId);
  assert.equal(created["variant-name"], "Regular");
  assert.equal(created["team-id"], "00000000-0000-4000-8000-000000000001");
  assert.match(created.id, /^[a-f0-9-]{36}$/);
  assert.match(created["woff1-file-id"], /^[a-f0-9-]{36}$/);
  assert.match(created["ttf-file-id"], /^[a-f0-9-]{36}$/);

  const woffResponse = await fetch(
    `${service.url}/v1/font/${created["woff1-file-id"]}`,
  );
  assert.equal(woffResponse.status, 200);
  assert.equal(woffResponse.headers.get("content-type"), "font/woff");
  assert.deepEqual(
    Buffer.from(await woffResponse.arrayBuffer()).subarray(0, 4),
    Buffer.from("wOFF"),
  );

  const updatedResponse = await fetch(`${service.url}/v1/font/update`, {
    body: JSON.stringify({ id: rawFontId, name: "Renamed Sans" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(updatedResponse.status, 200);
  let opened = await fetch(`${service.url}/v1/workspace`).then((response) =>
    response.json(),
  );
  assert.equal(assetEntry(opened).fonts[0].family, "Renamed Sans");

  const deletedResponse = await fetch(`${service.url}/v1/font/variant/delete`, {
    body: JSON.stringify({ id: created.id }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(deletedResponse.status, 200);
  opened = await fetch(`${service.url}/v1/workspace`).then((response) =>
    response.json(),
  );
  assert.deepEqual(assetEntry(opened)?.fonts ?? [], []);
});

test("the local HTTP bridge persists basic Penpot node edits atomically", async (context) => {
  const packagePath = await copyFixture();
  const service = await serveLocalPackage({ packagePath, port: 0 });
  context.after(() => service.close());
  const opened = await fetch(`${service.url}/v1/workspace`).then((response) =>
    response.json(),
  );

  const response = await fetch(`${service.url}/v1/penpot/commit`, {
    body: JSON.stringify({
      baseRevision: opened.revision,
      changes: [
        {
          id: opened.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle,
          operations: [
            { attr: "x", type: "set", val: 128 },
            { attr: "y", type: "set", val: 160 },
            { attr: "width", type: "set", val: 288 },
            { attr: "height", type: "set", val: 144 },
            { attr: "name", type: "set", val: "Renamed Rectangle" },
            { attr: "hidden", type: "set", val: true },
            {
              attr: "fills",
              type: "set",
              val: [{ "fill-color": "#2563eb", "fill-opacity": 0.7 }],
            },
            { attr: "r1", type: "set", val: 4 },
            { attr: "r2", type: "set", val: 8 },
            { attr: "r3", type: "set", val: 12 },
            { attr: "r4", type: "set", val: 16 },
            {
              attr: "selrect",
              type: "set",
              val: { height: 144, width: 288, x: 128, y: 160 },
            },
            { attr: "points", type: "set", val: [] },
          ],
          type: "mod-obj",
        },
      ],
      commitId: "basic-node-edit",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  assert.equal(response.status, 200);
  const screen = await readModelEntry(packagePath, "screens/roundtrip.json");
  assert.deepEqual(
    {
      cornerRadius: screen.presentations[0].nodes.node_rectangle.cornerRadius,
      fills: screen.presentations[0].nodes.node_rectangle.fills,
      height: screen.presentations[0].nodes.node_rectangle.height,
      name: screen.presentations[0].nodes.node_rectangle.name,
      visible: screen.presentations[0].nodes.node_rectangle.visible,
      width: screen.presentations[0].nodes.node_rectangle.width,
      x: screen.presentations[0].nodes.node_rectangle.x,
      y: screen.presentations[0].nodes.node_rectangle.y,
    },
    {
      cornerRadius: [4, 8, 12, 16],
      fills: [{ color: "#2563eb", opacity: 0.7, type: "solid" }],
      height: 144,
      name: "Renamed Rectangle",
      visible: false,
      width: 288,
      x: 128,
      y: 160,
    },
  );
});

test("the local HTTP bridge reloads official local editing attributes", async (context) => {
  const packagePath = await copyFixture();
  const service = await serveLocalPackage({ packagePath, port: 0 });
  context.after(() => service.close());
  const opened = await fetch(`${service.url}/v1/workspace`).then((response) =>
    response.json(),
  );
  const response = await fetch(`${service.url}/v1/penpot/commit`, {
    body: JSON.stringify({
      baseRevision: opened.revision,
      changes: [
        {
          id: opened.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle,
          operations: [
            { attr: "blend-mode", type: "set", val: "multiply" },
            { attr: "hide-fill-on-export", type: "set", val: true },
            { attr: "hide-in-viewer", type: "set", val: true },
            { attr: "show-content", type: "set", val: false },
            {
              attr: "grids",
              type: "set",
              val: [
                {
                  color: "#22d3ee",
                  display: true,
                  params: { size: 8 },
                  type: "square",
                },
              ],
            },
          ],
          type: "mod-obj",
        },
      ],
      commitId: "official-local-editing-attributes",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(response.status, 200, await response.clone().text());

  const reloaded = await fetch(`${service.url}/v1/workspace`).then((result) =>
    result.json(),
  );
  const node =
    onlyScreen(reloaded).presentations[0].nodes
      .node_rectangle;
  // Blend mode and viewer visibility are design; guides and export
  // settings are editor state the package does not keep, and clipping
  // (show-content) applies to boards, not to this rectangle.
  assert.deepEqual(
    {
      blendMode: node["blend-mode"],
      grids: node.grids,
      hideFillOnExport: node["hide-fill-on-export"],
      hideInViewer: node["hide-in-viewer"],
      showContent: node["show-content"],
    },
    {
      blendMode: "multiply",
      grids: undefined,
      hideFillOnExport: undefined,
      hideInViewer: true,
      showContent: undefined,
    },
  );
});

test("the local HTTP bridge preserves a newly added node identity across commits", async (context) => {
  const packagePath = await copyFixture();
  const service = await serveLocalPackage({ packagePath, port: 0 });
  context.after(() => service.close());
  const opened = await fetch(`${service.url}/v1/workspace`).then((response) =>
    response.json(),
  );
  const pageId = opened.runtime.pages.scr_roundtrip.pres_desktop;
  const parentId = opened.runtime.nodes.scr_roundtrip.pres_desktop.node_canvas;
  const runtimeId = "44444444-4444-4444-8444-444444444444";

  const added = await fetch(`${service.url}/v1/penpot/commit`, {
    body: JSON.stringify({
      baseRevision: opened.revision,
      changes: [
        {
          id: runtimeId,
          index: 1,
          obj: {
            "frame-id": parentId,
            "parent-id": parentId,
            fills: [{ "fill-color": "#2563eb", "fill-opacity": 1 }],
            height: 80,
            id: runtimeId,
            name: "Added Rectangle",
            r1: 0,
            r2: 0,
            r3: 0,
            r4: 0,
            rotation: 0,
            shapes: [],
            strokes: [],
            type: "rect",
            width: 160,
            x: 120,
            y: 180,
          },
          "page-id": pageId,
          "parent-id": parentId,
          type: "add-obj",
        },
        {
          index: 1,
          "page-id": pageId,
          "parent-id": parentId,
          shapes: [runtimeId],
          type: "mov-objects",
        },
      ],
      commitId: "http-add-node",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).then((response) => response.json());

  const reloaded = await fetch(`${service.url}/v1/workspace`).then((response) =>
    response.json(),
  );
  const nodeId = "node_44444444444444448444444444444444";
  assert.equal(
    reloaded.runtime.nodes.scr_roundtrip.pres_desktop[nodeId],
    runtimeId,
  );

  const updated = await fetch(`${service.url}/v1/penpot/commit`, {
    body: JSON.stringify({
      baseRevision: added.revision,
      changes: [
        {
          id: runtimeId,
          operations: [{ attr: "name", type: "set", val: "Edited After Add" }],
          "page-id": pageId,
          type: "mod-obj",
        },
      ],
      commitId: "http-update-added-node",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(updated.status, 200);

  const screen = await readModelEntry(packagePath, "screens/roundtrip.json");
  assert.equal(screen.presentations[0].nodes[nodeId].name, "Edited After Add");
});

test("a Penpot page made in the App is a new canvas that persists across reloads", async (context) => {
  const packagePath = await copyFixture();
  const service = await serveLocalPackage({ packagePath, port: 0 });
  context.after(() => service.close());
  const opened = await fetch(`${service.url}/v1/workspace`).then((response) =>
    response.json(),
  );
  const runtimeId = "77777777-7777-4777-8777-777777777777";

  const added = await fetch(`${service.url}/v1/penpot/commit`, {
    body: JSON.stringify({
      baseRevision: opened.revision,
      changes: [{ id: runtimeId, name: "Second Page", type: "add-page" }],
      commitId: "http-add-page",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).then((response) => response.json());
  assert.match(added.revision, /^[a-f0-9]{64}$/);

  const reloaded = await fetch(`${service.url}/v1/workspace`).then((response) =>
    response.json(),
  );
  const canvas = reloaded.runtime.canvases.find(({ pageId }) => pageId === runtimeId);
  assert.deepEqual([canvas.name, canvas.boards], ["Second Page", []], "the page keeps its Penpot id");

  const renamed = await fetch(`${service.url}/v1/penpot/commit`, {
    body: JSON.stringify({
      baseRevision: added.revision,
      changes: [{ id: runtimeId, name: "Renamed Page", type: "mod-page" }],
      commitId: "http-rename-page",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(renamed.status, 200);
  const manifest = await readModelEntry(packagePath, "manifest.json");
  assert.equal(manifest.canvases.find(({ id }) => id === "cnv_77777777777747778777777777777777").name, "Renamed Page");
  // A canvas without pages is declared in index.html.
  assert.match(await readFile(join(packagePath, "index.html"), "utf8"), /<meta name="smallpen:canvas" content="Renamed Page">/);
});

