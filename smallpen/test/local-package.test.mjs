import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
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
const fixture = join(here, "fixtures", "roundtrip.smallpen");

async function copyFixture() {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-test-"));
  const packagePath = join(parent, "roundtrip.smallpen");
  await cp(fixture, packagePath, { recursive: true });
  return packagePath;
}

async function productWorkspaceFixture() {
  const root = await mkdtemp(join(tmpdir(), "smallpen-session-workspace-"));
  const productPath = join(root, "product.smallpen");
  const foundationPath = join(root, "foundation.smallpen");
  await cp(fixture, productPath, { recursive: true });
  await cp(fixture, foundationPath, { recursive: true });
  const foundationManifestPath = join(foundationPath, "manifest.json");
  const foundationManifest = JSON.parse(
    await readFile(foundationManifestPath, "utf8"),
  );
  foundationManifest.name = "Foundation";
  foundationManifest.packageId = "pkg_foundation";
  await writeFile(foundationManifestPath, JSON.stringify(foundationManifest));
  const productManifestPath = join(productPath, "manifest.json");
  const productManifest = JSON.parse(await readFile(productManifestPath, "utf8"));
  productManifest.dependencies = [
    { packageId: "pkg_foundation", path: "foundation.smallpen" },
  ];
  productManifest.name = "Product";
  productManifest.packageId = "pkg_product";
  productManifest.role = "product";
  await writeFile(productManifestPath, JSON.stringify(productManifest));
  return { foundationPath, productPath, root };
}

function opacityBatch(revision, opacity, suffix = "") {
  return {
    baseRevision: revision,
    batchId: `batch_opacity_${opacity}${suffix}`,
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

async function waitFor(predicate, attempts = 30) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await delay(100);
  }
  assert.fail("Timed out waiting for local Package state");
}

test("opening a package produces deterministic Penpot runtime UUIDs", async () => {
  const packagePath = await copyFixture();
  const first = await openPackage(packagePath);
  const second = await openPackage(packagePath);

  assert.match(first.revision, /^[a-f0-9]{64}$/);
  assert.equal(
    first.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle,
    second.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle,
  );
  assert.match(
    first.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle,
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
});

test("runtime UUID indexes keep Presentation-scoped node IDs distinct", async () => {
  const packagePath = await copyFixture();
  const screenPath = join(packagePath, "screens/roundtrip.json");
  const screen = JSON.parse(await readFile(screenPath, "utf8"));
  const second = structuredClone(screen.presentations[0]);
  second.id = "pres_mobile";
  second.name = "Mobile";
  await writeFile(
    screenPath,
    `${JSON.stringify(
      { ...screen, presentations: [...screen.presentations, second] },
      null,
      2,
    )}\n`,
  );

  const opened = await openPackage(packagePath);
  const desktop =
    opened.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle;
  const mobile = opened.runtime.nodes.scr_roundtrip.pres_mobile.node_rectangle;

  assert.notEqual(desktop, mobile);
  assert.notEqual(
    opened.runtime.pages.scr_roundtrip.pres_desktop,
    opened.runtime.pages.scr_roundtrip.pres_mobile,
  );
});

test("a typed operation batch atomically changes one node and one revision", async () => {
  const packagePath = await copyFixture();
  const before = await openPackage(packagePath);
  const result = await applyOperationBatch(
    packagePath,
    opacityBatch(before.revision, 0.45),
  );
  const after = await openPackage(packagePath);
  const screen = JSON.parse(
    await readFile(join(packagePath, "screens/roundtrip.json"), "utf8"),
  );

  assert.notEqual(result.revision, before.revision);
  assert.equal(after.revision, result.revision);
  assert.deepEqual(result.changedFiles, ["screens/roundtrip.json"]);
  assert.deepEqual(result.affectedIds, ["node_rectangle"]);
  assert.equal(screen.presentations[0].nodes.node_rectangle.opacity, 0.45);
  assert.equal(
    after.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle,
    before.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle,
  );
});

test("a stale batch is rejected without changing the package", async () => {
  const packagePath = await copyFixture();
  const before = await openPackage(packagePath);

  await assert.rejects(
    applyOperationBatch(packagePath, opacityBatch("stale-revision", 0.2)),
    (error) => error?.code === "stale_revision",
  );

  const after = await openPackage(packagePath);
  assert.equal(after.revision, before.revision);
});

test("an abandoned Package write lock is recovered", async () => {
  const packagePath = await copyFixture();
  const before = await openPackage(packagePath);
  const lockPath = join(
    dirname(packagePath),
    `.${basename(packagePath)}.write-lock`,
  );
  await mkdir(lockPath, { recursive: true });
  await writeFile(
    join(lockPath, "owner.json"),
    JSON.stringify({ createdAt: new Date().toISOString(), pid: 2147483647 }),
  );

  const result = await applyOperationBatch(
    packagePath,
    opacityBatch(before.revision, 0.45, "_abandoned_lock"),
  );

  assert.notEqual(result.revision, before.revision);
});

test("a Package write lock is recovered after PID reuse", async () => {
  const packagePath = await copyFixture();
  const before = await openPackage(packagePath);
  const lockPath = join(
    dirname(packagePath),
    `.${basename(packagePath)}.write-lock`,
  );
  await mkdir(lockPath, { recursive: true });
  await writeFile(
    join(lockPath, "owner.json"),
    JSON.stringify({
      createdAt: "2000-01-01T00:00:00.000Z",
      pid: process.pid,
      processIdentity: "a previous process with the same pid",
    }),
  );

  const result = await applyOperationBatch(
    packagePath,
    opacityBatch(before.revision, 0.55, "_expired_lock"),
  );

  assert.notEqual(result.revision, before.revision);
});

test("concurrent contenders serialize while recovering an abandoned Package lock", async () => {
  const packagePath = await copyFixture();
  const before = await openPackage(packagePath);
  const lockPath = join(
    dirname(packagePath),
    `.${basename(packagePath)}.write-lock`,
  );
  await mkdir(lockPath, { recursive: true });
  await writeFile(
    join(lockPath, "owner.json"),
    JSON.stringify({ createdAt: new Date().toISOString(), pid: 2147483647 }),
  );

  const results = await Promise.allSettled([
    applyOperationBatch(
      packagePath,
      opacityBatch(before.revision, 0.25, "_abandoned_first"),
    ),
    applyOperationBatch(
      packagePath,
      opacityBatch(before.revision, 0.75, "_abandoned_second"),
    ),
  ]);

  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected?.reason?.code, "stale_revision");
  assert.equal(
    (await openPackage(packagePath)).revision,
    results.find((result) => result.status === "fulfilled")?.value.revision,
  );
});

test("opening a Package completes an interrupted directory commit", async (context) => {
  const packagePath = await copyFixture();
  const parent = dirname(packagePath);
  const transactionPath = await mkdtemp(join(parent, ".smallpen-transaction-"));
  const candidatePath = join(transactionPath, "candidate.smallpen");
  const backupPath = join(parent, `.${basename(packagePath)}.backup-interrupted`);
  const journalPath = join(parent, `.${basename(packagePath)}.commit.json`);
  context.after(() => rm(parent, { force: true, recursive: true }));
  await cp(packagePath, candidatePath, { recursive: true });
  await writeFile(
    journalPath,
    JSON.stringify({ backupPath, candidatePath, transactionPath }),
  );
  await rename(packagePath, backupPath);

  const recovered = await openPackage(packagePath);

  assert.equal(recovered.manifest.packageId, "pkg_roundtrip");
  await assert.rejects(readFile(journalPath), (error) => error?.code === "ENOENT");
});

test("a Package reader waits for an active commit journal owner", async (context) => {
  const requestedPath = await copyFixture();
  const packagePath = (await openPackage(requestedPath)).locator;
  const parent = dirname(packagePath);
  const transactionPath = await mkdtemp(join(parent, ".smallpen-transaction-"));
  const candidatePath = join(transactionPath, "candidate.smallpen");
  const backupPath = join(parent, `.${basename(packagePath)}.backup-active`);
  const journalPath = join(parent, `.${basename(packagePath)}.commit.json`);
  const lockPath = join(parent, `.${basename(packagePath)}.write-lock`);
  const claimName = "0000000000000000-active-writer.json";
  const claimPath = join(lockPath, claimName);
  const activePath = join(lockPath, "active");
  context.after(() => rm(parent, { force: true, recursive: true }));
  await cp(packagePath, candidatePath, { recursive: true });
  await writeFile(
    journalPath,
    JSON.stringify({ backupPath, candidatePath, transactionPath }),
  );
  await mkdir(lockPath, { recursive: true });
  await writeFile(
    claimPath,
    JSON.stringify({
      createdAt: new Date().toISOString(),
      pid: process.pid,
    }),
  );
  await writeFile(activePath, JSON.stringify({ claimName }));

  let settled = false;
  const opening = openPackage(packagePath).finally(() => {
    settled = true;
  });
  await delay(100);
  assert.equal(settled, false);
  assert.equal(JSON.parse(await readFile(journalPath, "utf8")).candidatePath, candidatePath);
  assert.equal(
    JSON.parse(await readFile(join(candidatePath, "manifest.json"), "utf8")).packageId,
    "pkg_roundtrip",
  );

  await rm(activePath, { force: true });
  await rm(claimPath, { force: true });
  const opened = await opening;
  assert.equal(opened.manifest.packageId, "pkg_roundtrip");
  await assert.rejects(readFile(journalPath), (error) => error?.code === "ENOENT");
});

test("opening a valid Package discards a truncated pre-commit journal", async (context) => {
  const packagePath = await copyFixture();
  const parent = dirname(packagePath);
  const journalPath = join(parent, `.${basename(packagePath)}.commit.json`);
  context.after(() => rm(parent, { force: true, recursive: true }));
  await writeFile(journalPath, "{ partial");

  const opened = await openPackage(packagePath);

  assert.equal(opened.manifest.packageId, "pkg_roundtrip");
  await assert.rejects(readFile(journalPath), (error) => error?.code === "ENOENT");
});

test("Package reads remain valid while commits replace the directory", async () => {
  const packagePath = await copyFixture();
  let revision = (await openPackage(packagePath)).revision;
  for (let index = 0; index < 8; index += 1) {
    const previousRevision = revision;
    const commit = applyOperationBatch(
      packagePath,
      opacityBatch(revision, 0.1 + index * 0.1, `_read_race_${index}`),
    );
    const reads = Array.from({ length: 8 }, () => openPackage(packagePath));
    const [result, ...snapshots] = await Promise.all([commit, ...reads]);
    revision = result.revision;
    assert.ok(snapshots.every((snapshot) => snapshot.manifest.packageId === "pkg_roundtrip"));
    assert.ok(
      snapshots.every((snapshot) =>
        snapshot.revision === previousRevision || snapshot.revision === revision
      ),
    );
  }
});

test("a Media import writes its descriptor and content-addressed blob atomically", async () => {
  const packagePath = await copyFixture();
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const imported = await importMedia(packagePath, {
    bytes,
    height: 1,
    id: "media_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa",
    mimeType: "image/png",
    name: "Pixel",
    width: 1,
  });
  assert.ok(imported.result.changedFiles.includes("assets/assets.json"));
  assert.ok(!imported.result.changedFiles.includes("manifest.json"));
  assert.ok(imported.result.changedFiles.includes(imported.descriptor.blob));
  assert.deepEqual(
    await readFile(join(packagePath, imported.descriptor.blob)),
    bytes,
  );
  const opened = await openPackage(packagePath);
  assert.equal(opened.entries["assets/assets.json"].media[0].name, "Pixel");

  await applyOperationBatch(packagePath, imported.result.inverseBatch);
  const reversed = await openPackage(packagePath);
  assert.deepEqual(reversed.manifest.entries.assets, ["assets/assets.json"]);
  assert.deepEqual(reversed.entries["assets/assets.json"].media, []);
  assert.ok(reversed.blobs.has(imported.descriptor.blob));
});

test("the Node adapter rejects non-package directories and entry symlinks", async () => {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-path-test-"));
  const wrongExtension = join(parent, "roundtrip");
  await cp(fixture, wrongExtension, { recursive: true });
  await assert.rejects(
    openPackage(wrongExtension),
    (error) => error?.code === "invalid_package_path",
  );

  const packagePath = await copyFixture();
  const screenPath = join(packagePath, "screens/roundtrip.json");
  const outsidePath = join(dirname(packagePath), "outside.json");
  await rename(screenPath, outsidePath);
  await symlink(outsidePath, screenPath);
  await assert.rejects(
    openPackage(packagePath),
    (error) => error?.code === "invalid_entry_path",
  );
});

test("the local backend serializes simultaneous commits at one base revision", async (context) => {
  const packagePath = await copyFixture();
  const backend = new LocalPackageBackend();
  context.after(() => backend.close());
  const opened = await backend.open(packagePath);

  const results = await Promise.allSettled([
    backend.commit(opacityBatch(opened.revision, 0.2, "_first")),
    backend.commit(opacityBatch(opened.revision, 0.8, "_second")),
  ]);

  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected?.reason?.code, "stale_revision");
});

test("the local backend confirms identical batch retries and rejects identity reuse", async (context) => {
  const packagePath = await copyFixture();
  const backend = new LocalPackageBackend();
  context.after(() => backend.close());
  const opened = await backend.open(packagePath);
  const batch = opacityBatch(opened.revision, 0.4, "_idempotent");
  const first = await backend.commit(batch);
  const retry = await backend.commit(structuredClone(batch));
  assert.equal(retry.duplicate, true);
  assert.equal(retry.revision, first.revision);
  await assert.rejects(
    backend.commit({
      ...structuredClone(batch),
      operations: [
        {
          ...structuredClone(batch.operations[0]),
          changes: { opacity: 0.9 },
        },
      ],
    }),
    (error) => error?.code === "duplicate_batch_id",
  );
  assert.equal((await openPackage(packagePath)).revision, first.revision);
});

test("the local backend suppresses self writes and reports an external CLI write once", async (context) => {
  const packagePath = await copyFixture();
  const backend = new LocalPackageBackend();
  const events = [];
  backend.subscribe((event) => events.push(event));
  context.after(() => backend.close());

  const opened = await backend.open(packagePath);
  const local = await backend.commit(
    opacityBatch(opened.revision, 0.6, "_local"),
  );
  await delay(300);
  assert.deepEqual(events, []);

  await applyOperationBatch(
    packagePath,
    opacityBatch(local.revision, 0.3, "_external"),
  );
  for (let attempt = 0; attempt < 20 && events.length === 0; attempt += 1) {
    await delay(100);
  }

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "external-revision");
  assert.equal(events[0].snapshot.revision, backend.snapshot.revision);
});

test("the local backend watches nested entries and retains last-valid read-only state", async (context) => {
  const packagePath = await copyFixture();
  const backend = new LocalPackageBackend();
  const events = [];
  backend.subscribe((event) => events.push(event));
  context.after(() => backend.close());
  const opened = await backend.open(packagePath);
  const originalRevision = opened.revision;
  const screenPath = join(packagePath, "screens/roundtrip.json");
  const screen = JSON.parse(await readFile(screenPath, "utf8"));
  screen.name = "Manual nested edit";
  await writeFile(screenPath, JSON.stringify(screen));
  await waitFor(() => events.some(({ type }) => type === "external-revision"));
  assert.notEqual(backend.snapshot.revision, originalRevision);
  assert.equal(backend.changes.at(-1).source, "external");
  assert.ok(backend.changes.at(-1).affectedIds.includes("scr_roundtrip"));
  assert.ok(backend.changes.at(-1).changedFiles.includes("screens/roundtrip.json"));

  const lastValidRevision = backend.snapshot.revision;
  await writeFile(screenPath, "{ partial");
  await waitFor(() => backend.status.state === "repair");
  assert.equal(backend.status.readOnly, true);
  assert.equal(backend.status.lastValidRevision, lastValidRevision);
  assert.equal(backend.snapshot.revision, lastValidRevision);
  await assert.rejects(
    backend.commit(opacityBatch(lastValidRevision, 0.1, "_repair_read_only")),
    (error) => error?.code === "repair_read_only",
  );

  await writeFile(screenPath, JSON.stringify(screen));
  await waitFor(() => backend.status.state === "ready");
  assert.equal(backend.status.readOnly, false);
  assert.equal(backend.snapshot.revision, lastValidRevision);
  assert.ok(events.some(({ type }) => type === "external-recovered"));
});

test("local Backend Undo and Redo submit inverse Operation Batches", async (context) => {
  const packagePath = await copyFixture();
  const backend = new LocalPackageBackend();
  context.after(() => backend.close());
  const opened = await backend.open(packagePath);
  const changed = await backend.commit(
    opacityBatch(opened.revision, 0.35, "_history"),
  );
  assert.equal(
    backend.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_rectangle.opacity,
    0.35,
  );
  const undone = await backend.undo();
  assert.equal(undone.revision, opened.revision);
  assert.equal(
    backend.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_rectangle.opacity,
    1,
  );
  const redone = await backend.redo();
  assert.equal(redone.revision, changed.revision);
  assert.equal(
    backend.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_rectangle.opacity,
    0.35,
  );
  assert.deepEqual(
    backend.changes.slice(-3).map(({ source }) => source),
    ["local", "undo", "redo"],
  );
});

test("one workspace session opens multiple independent files and reconciles surviving UI state", async (context) => {
  const firstPath = await copyFixture();
  const secondPath = await copyFixture();
  const workspace = new LocalWorkspaceSession();
  const events = [];
  workspace.subscribe((event) => events.push(event));
  context.after(() => workspace.closeAll());
  const first = await workspace.open(firstPath, {
    presentationId: "pres_desktop",
    screenId: "scr_roundtrip",
    selectedIds: ["node_rectangle"],
    viewport: { x: 12, y: 24, zoom: 1.5 },
  });
  const second = await workspace.open(secondPath);
  assert.equal(workspace.packages.length, 2);
  assert.equal(workspace.activeLocator, first.locator);
  assert.notEqual(first.locator, second.locator);
  assert.notEqual(first.snapshot.runtime.file, second.snapshot.runtime.file);

  const firstCommit = await workspace.commit(
    first.locator,
    opacityBatch(first.snapshot.revision, 0.55, "_multi_file"),
  );
  assert.deepEqual(workspace.describe(first.locator).viewState, {
    presentationId: "pres_desktop",
    screenId: "scr_roundtrip",
    selectedIds: ["node_rectangle"],
    viewport: { x: 12, y: 24, zoom: 1.5 },
  });
  await workspace.commit(first.locator, {
    baseRevision: firstCommit.revision,
    batchId: "batch_delete_selected_node",
    operations: [
      {
        nodeId: "node_rectangle",
        presentationId: "pres_desktop",
        screenId: "scr_roundtrip",
        type: "delete-presentation-node",
      },
    ],
  });
  assert.deepEqual(workspace.describe(first.locator).viewState.selectedIds, []);
  assert.deepEqual(workspace.describe(first.locator).viewState.viewport, {
    x: 12,
    y: 24,
    zoom: 1.5,
  });

  const secondScreenPath = join(second.locator, "screens/roundtrip.json");
  const secondScreen = JSON.parse(await readFile(secondScreenPath, "utf8"));
  secondScreen.name = "Second file changed";
  await writeFile(secondScreenPath, JSON.stringify(secondScreen));
  await waitFor(() =>
    events.some(
      ({ locator, type }) =>
        locator === second.locator && type === "external-revision",
    ),
  );
  assert.equal(workspace.activeLocator, first.locator);
  assert.equal(
    workspace.describe(second.locator).snapshot.entries["screens/roundtrip.json"]
      .name,
    "Second file changed",
  );
});

test("a Product session tracks its Foundation and retains the last valid composite workspace", async (context) => {
  const paths = await productWorkspaceFixture();
  const workspace = new LocalWorkspaceSession();
  context.after(async () => {
    await workspace.closeAll();
    await rm(paths.root, { force: true, recursive: true });
  });
  const product = await workspace.open(paths.productPath);
  assert.equal(workspace.packages.length, 2);
  assert.equal(product.status.state, "ready");
  const lastValidFoundationRevision =
    workspace.describe(product.locator).workspace.foundation.revision;

  const foundationScreenPath = join(
    paths.foundationPath,
    "screens/roundtrip.json",
  );
  const validFoundationScreen = await readFile(foundationScreenPath, "utf8");
  await writeFile(foundationScreenPath, "{ partial");
  await waitFor(
    () => workspace.describe(product.locator).status.state === "repair",
  );
  const repair = workspace.describe(product.locator);
  assert.equal(repair.status.readOnly, true);
  assert.equal(
    repair.workspace.foundation.revision,
    lastValidFoundationRevision,
  );
  await assert.rejects(
    workspace.commit(
      product.locator,
      opacityBatch(product.snapshot.revision, 0.2, "_dependency_repair"),
    ),
    (error) => error?.code === "workspace_repair_read_only",
  );

  await writeFile(foundationScreenPath, validFoundationScreen);
  await waitFor(
    () => workspace.describe(product.locator).status.state === "ready",
  );
  assert.equal(workspace.describe(product.locator).status.readOnly, false);
});
