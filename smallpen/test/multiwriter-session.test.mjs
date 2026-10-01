import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  applyOperationBatch,
  importMedia,
  LocalPackageBackend,
  LocalWorkspaceSession,
  openPackage,
} from "@smallpen/local-package";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");
const fixture = join(fixtures, "roundtrip.smallpen");
const cli = join(here, "..", "apps", "cli", "bin", "smallpen.mjs");

// Sessions and backends must close before their directory is removed: a
// background refresh still takes write locks next to the Packages.
async function tempRoot(context) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-multiwriter-"));
  const closers = [];
  context.after(async () => {
    for (const close of closers.reverse()) await close();
    await rm(root, { force: true, maxRetries: 3, recursive: true });
  });
  return { closeLater: (close) => closers.push(close), root };
}

async function editJson(path, edit) {
  const value = JSON.parse(await readFile(path, "utf8"));
  edit(value);
  await writeFile(path, JSON.stringify(value));
}

async function copyPackage(root, name, edit = () => {}, source = fixture) {
  const packagePath = join(root, name);
  await cp(source, packagePath, { recursive: true });
  await editJson(join(packagePath, "manifest.json"), edit);
  return packagePath;
}

async function productWorkspace(root) {
  const foundationPath = await copyPackage(root, "foundation.smallpen", (manifest) => {
    manifest.name = "Foundation";
    manifest.packageId = "pkg_foundation";
  });
  const productPath = await copyPackage(root, "product.smallpen", (manifest) => {
    manifest.dependencies = [
      { packageId: "pkg_foundation", path: "foundation.smallpen" },
    ];
    manifest.name = "Product";
    manifest.packageId = "pkg_product";
    manifest.role = "product";
  });
  return { foundationPath, productPath };
}

function opacityBatch(revision, opacity, batchId) {
  return {
    baseRevision: revision,
    batchId,
    operations: [
      {
        changes: { opacity },
        nodeId: "node_rectangle",
        presentationId: "pres_desktop",
        screenId: "scr_roundtrip",
        type: "update-presentation-node",
      },
    ],
  };
}

async function waitFor(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  assert.fail("Timed out waiting for the expected state");
}

test("a steady stream of external writes still reaches the Background", async (context) => {
  const { closeLater, root } = await tempRoot(context);
  const packagePath = (await openPackage(await copyPackage(root, "busy.smallpen"))).locator;
  const backend = new LocalPackageBackend();
  closeLater(() => backend.close());
  let seen = 0;
  backend.subscribe((event) => {
    if (event.type === "external-revision") seen += 1;
  });
  let revision = (await backend.open(packagePath)).revision;

  // Each write lands before a debounced refresh could fire; the writer stops
  // only once the Background reported one of them (or after the deadline).
  const deadline = Date.now() + 3000;
  for (let index = 0; seen === 0 && Date.now() < deadline; index += 1) {
    revision = (
      await applyOperationBatch(
        packagePath,
        opacityBatch(revision, ((index % 9) + 1) / 10, `busy_${index}`),
      )
    ).revision;
    await delay(30);
  }

  assert.ok(seen > 0, "no external revision was reported while writes continued");
});

test("an in-place blob edit leaves the ready state for Repair", async (context) => {
  const { closeLater, root } = await tempRoot(context);
  const packagePath = (await openPackage(await copyPackage(root, "blob.smallpen"))).locator;
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const { descriptor } = await importMedia(packagePath, {
    bytes: new Uint8Array(pixel),
    height: 1,
    id: "media_pixel",
    mimeType: "image/png",
    name: "Pixel",
    width: 1,
  });
  // Fingerprints that contain timestamps from the last two seconds are never
  // trusted (coarse file system clocks); let the fresh files settle.
  await delay(2100);
  const backend = new LocalPackageBackend();
  closeLater(() => backend.close());
  await backend.open(packagePath);
  await backend.refresh();
  assert.equal(await backend.refresh(), backend.snapshot);

  const handle = await open(join(packagePath, descriptor.blob), "r+");
  try {
    await handle.write(Buffer.from([pixel[20] ^ 0xff]), 0, 1, 20);
  } finally {
    await handle.close();
  }

  assert.equal(await backend.refresh(), undefined);
  assert.equal(backend.status.state, "repair");
  assert.equal(backend.status.error.code, "media_blob_hash_mismatch");
});

test("a Product whose Foundation is unreadable at open recovers once it is fixed", async (context) => {
  const { closeLater, root } = await tempRoot(context);
  const { foundationPath, productPath } = await productWorkspace(root);
  const screenPath = join(foundationPath, "screens", "roundtrip.json");
  const screen = await readFile(screenPath, "utf8");
  await writeFile(screenPath, screen.slice(0, 40));
  const workspace = new LocalWorkspaceSession();
  closeLater(() => workspace.closeAll());
  const events = [];
  workspace.subscribe((event) => events.push(event));

  const product = await workspace.open(productPath);
  assert.equal(product.status.state, "repair");
  assert.equal(workspace.packages.length, 1);

  await writeFile(screenPath, screen);

  await waitFor(() => workspace.describe(product.locator).status.state === "ready");
  assert.equal(workspace.activeLocator, product.locator);
  assert.ok(
    workspace.packages.some(({ packageId }) => packageId === "pkg_foundation"),
    "the fixed Foundation is opened so its later edits reach the Product",
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "package-dependency-changed" &&
        event.locator === product.locator &&
        event.status.state === "ready",
    ),
  );
});

test("closing the workspace while a Product opens leaves no Package watching", async (context) => {
  const { closeLater, root } = await tempRoot(context);
  const { productPath } = await productWorkspace(root);
  const watchers = () =>
    process.getActiveResourcesInfo().filter((type) => type === "FSEventWrap").length;
  const before = watchers();
  const workspace = new LocalWorkspaceSession();
  // Should this test fail, still release what leaked so the file can exit.
  closeLater(() => workspace.closeAll());

  // The Product is registered before its Foundation opens, so closeAll()
  // runs while the open still has a Package to add.
  const opening = workspace.open(productPath).catch((error) => error);
  while (workspace.packages.length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await workspace.closeAll();
  await opening;

  assert.deepEqual(workspace.packages, []);
  await waitFor(() => watchers() === before);
});

test("a Product retargeted outside the Background follows its new Foundation", async (context) => {
  const { closeLater, root } = await tempRoot(context);
  const { foundationPath, productPath } = await productWorkspace(root);
  const movedPath = join(root, "moved-foundation.smallpen");
  await cp(foundationPath, movedPath, { recursive: true });
  const workspace = new LocalWorkspaceSession();
  closeLater(() => workspace.closeAll());
  const events = [];
  workspace.subscribe((event) => events.push(event));
  const product = await workspace.open(productPath);

  await applyOperationBatch(product.locator, {
    baseRevision: product.snapshot.revision,
    batchId: "retarget_foundation",
    operations: [
      {
        dependency: { packageId: "pkg_foundation", path: "moved-foundation.smallpen" },
        type: "set-foundation-dependency",
      },
    ],
  });
  const moved = (await openPackage(movedPath)).locator;
  await waitFor(() => workspace.packages.some(({ locator }) => locator === moved));

  const edited = await applyOperationBatch(
    moved,
    opacityBatch((await openPackage(moved)).revision, 0.3, "moved_foundation_edit"),
  );

  await waitFor(
    () => workspace.describe(product.locator).status.foundationRevision === edited.revision,
  );
  // The Product may resolve the new revision from disk (through its own
  // retarget event) before the moved Foundation's watcher reports the edit.
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "package-dependency-changed" &&
        event.locator === product.locator &&
        event.dependencyLocator === moved,
    ),
  );
});

test("a Library change reaches Products that use it through their Foundation", async (context) => {
  const { closeLater, root } = await tempRoot(context);
  const sharedPath = join(root, "dsp-shared.smallpen");
  await cp(join(fixtures, "dsp-shared.smallpen"), sharedPath, { recursive: true });
  await cp(join(fixtures, "design-system.smallpen"), join(root, "design-system.smallpen"), {
    recursive: true,
  });
  const productPath = await copyPackage(root, "product.smallpen", (manifest) => {
    manifest.dependencies = [
      { packageId: "pkg_design_system", path: "design-system.smallpen" },
    ];
    manifest.packageId = "pkg_product";
    manifest.role = "product";
  });
  const workspace = new LocalWorkspaceSession();
  closeLater(() => workspace.closeAll());
  const product = await workspace.open(productPath);
  assert.equal(product.status.state, "ready");
  const libraryRevision = () =>
    workspace
      .describe(product.locator)
      .workspace.libraries.find(({ manifest }) => manifest.packageId === "pkg_dsp_shared")
      ?.revision;
  const before = libraryRevision();
  assert.ok(before);

  await editJson(join(sharedPath, "screens", "shared.json"), (screen) => {
    screen.name = "Edited shared screen";
  });
  const after = (await openPackage(sharedPath)).revision;
  assert.notEqual(after, before);

  await waitFor(() => libraryRevision() === after);
});

test("the next write removes files left by a writer killed mid-commit", async (context) => {
  const { root } = await tempRoot(context);
  const packagePath = (await openPackage(await copyPackage(root, "crash.smallpen"))).locator;
  const parent = dirname(packagePath);
  const name = basename(packagePath);
  const abandoned = [
    `.${name}.transaction-Ab12Cd`,
    `.${name}.backup-0b5e1c52-6a0f-4d39-9a43-5b1f4c1a7e10`,
    `.${name}.commit.json.6f0a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b.tmp`,
    `${name}.batches.json.1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.tmp`,
  ];
  await mkdir(join(parent, abandoned[0], "candidate.smallpen"), { recursive: true });
  await cp(packagePath, join(parent, abandoned[1]), { recursive: true });
  await writeFile(join(parent, abandoned[2]), "{");
  await writeFile(join(parent, abandoned[3]), "{");
  // Another Package's in-flight transaction shares the directory.
  const otherTransaction = `.${name}.transaction-other.smallpen.transaction-Zz99Yy`;
  await mkdir(join(parent, otherTransaction));

  await applyOperationBatch(
    packagePath,
    opacityBatch((await openPackage(packagePath)).revision, 0.4, "after_crash"),
  );

  const names = await readdir(parent);
  for (const entry of abandoned) assert.ok(!names.includes(entry), entry);
  assert.ok(names.includes(otherTransaction));
  assert.equal((await openPackage(packagePath)).revision.length, 64);
});

test("watch reports an invalid Package once and its recovery again", async (context) => {
  const { root } = await tempRoot(context);
  const packagePath = await copyPackage(root, "watched.smallpen");
  const manifestPath = join(packagePath, "manifest.json");
  const manifest = await readFile(manifestPath, "utf8");
  const child = spawn(
    process.execPath,
    [cli, "watch", packagePath, "--interval", "100", "--json"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  context.after(() => child.kill("SIGKILL"));
  const lines = [];
  let buffered = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    const complete = buffered.split("\n");
    buffered = complete.pop();
    lines.push(...complete.filter(Boolean).map((line) => JSON.parse(line)));
  });

  await waitFor(() => lines.length === 1, 10000);
  const initial = lines[0];
  assert.equal(initial.event, "revision");

  await writeFile(manifestPath, manifest.slice(0, 20));
  await waitFor(() => lines.some(({ event }) => event === "invalid"));
  // Several more polls observe the same invalid state.
  await delay(500);
  await writeFile(manifestPath, manifest);
  await waitFor(() => lines.at(-1).event === "revision");

  assert.deepEqual(
    lines.map(({ event }) => event),
    ["revision", "invalid", "revision"],
  );
  assert.equal(lines.at(-1).revision, initial.revision);
});
