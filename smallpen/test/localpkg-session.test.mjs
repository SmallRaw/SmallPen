import assert from "node:assert/strict";
import {
  cp,
  lstat,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { listPackageEntries, prepareOperationBatch } from "@smallpen/core";
import {
  applyOperationBatch,
  LocalPackageBackend,
  LocalWorkspaceSession,
  openPackage,
  resolveWorkspace,
} from "@smallpen/local-package";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "roundtrip.smallpen");

const closers = new Map();

// Sessions and backends must close before their directory is removed: a
// background refresh still takes write locks next to the Packages.
function closeLater(context, close) {
  closers.get(context).push(close);
}

async function tempRoot(context) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-localpkg-session-"));
  closers.set(context, []);
  context.after(async () => {
    for (const close of closers.get(context).reverse()) await close();
    closers.delete(context);
    await rm(root, { force: true, maxRetries: 3, recursive: true });
  });
  return root;
}

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value));
}

async function editManifest(packagePath, edit) {
  const path = join(packagePath, "manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  edit(manifest);
  await writeJson(path, manifest);
}

async function copyPackage(root, name, edit = () => {}) {
  const packagePath = join(root, name);
  await cp(fixture, packagePath, { recursive: true });
  await editManifest(packagePath, edit);
  return packagePath;
}

async function withoutTokens(packagePath) {
  await editManifest(packagePath, (manifest) => {
    manifest.entries.tokens = [];
  });
  await rm(join(packagePath, "tokens"), { force: true, recursive: true });
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
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

async function waitFor(predicate, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return;
    await delay(100);
  }
  assert.fail("Timed out waiting for the expected state");
}

async function productWorkspace(context) {
  const root = await tempRoot(context);
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
  return { foundationPath, productPath, root };
}

test("opening Packages without Tokens never writes; the first commit persists the default Theme (M3)", async (context) => {
  const { foundationPath, productPath } = await productWorkspace(context);
  await withoutTokens(productPath);
  await withoutTokens(foundationPath);
  const productDisk = (await openPackage(productPath)).revision;
  const foundationDisk = (await openPackage(foundationPath)).revision;
  const workspace = new LocalWorkspaceSession();
  closeLater(context, () => workspace.closeAll());

  const product = await workspace.open(productPath);
  assert.equal(workspace.packages.length, 2);
  assert.equal(product.status.state, "ready");
  assert.equal((await openPackage(productPath)).revision, productDisk);
  assert.equal((await openPackage(foundationPath)).revision, foundationDisk);
  assert.equal(await exists(join(productPath, "tokens")), false);
  assert.equal(await exists(join(foundationPath, "tokens")), false);
  // The default Theme is projected in memory for the editor.
  assert.deepEqual(product.snapshot.manifest.entries.tokens, ["tokens/tokens.json"]);
  assert.deepEqual(
    product.snapshot.entries["tokens/tokens.json"].themes.map(({ id }) => id),
    ["theme_default"],
  );

  const result = await workspace.commit(
    product.locator,
    opacityBatch(product.snapshot.revision, 0.5, "batch_first_tokenless_write"),
  );
  const written = await openPackage(productPath);
  assert.equal(result.revision, written.revision);
  assert.equal(workspace.describe(product.locator).snapshot.revision, written.revision);
  assert.deepEqual(
    written.entries["tokens/tokens.json"].activeThemeIds,
    ["theme_default"],
  );
  assert.equal(
    written.entries["screens/roundtrip.json"].presentations[0].nodes.node_rectangle
      .opacity,
    0.5,
  );
  assert.equal((await openPackage(foundationPath)).revision, foundationDisk);
});

test("local Library paths must be relative to the declaring Package (M3)", async (context) => {
  const root = await tempRoot(context);
  const libraryPath = await copyPackage(root, "icons.smallpen", (manifest) => {
    manifest.packageId = "pkg_icons";
  });
  const ownerPath = await copyPackage(root, "owner.smallpen", (manifest) => {
    manifest.libraries = [
      { packageId: "pkg_icons", source: { path: libraryPath, type: "local" } },
    ];
  });

  const resolution = await resolveWorkspace(ownerPath);
  assert.equal(resolution.status, "repair");
  assert.equal(resolution.conflicts[0].code, "library_unavailable");
  assert.match(resolution.conflicts[0].message, /relative/);

  const workspace = new LocalWorkspaceSession();
  closeLater(context, () => workspace.closeAll());
  await workspace.open(ownerPath);
  assert.equal(workspace.packages.length, 1);
});

test("a local Foundation commit refreshes its dependent Products (M4)", async (context) => {
  const { foundationPath, productPath } = await productWorkspace(context);
  const workspace = new LocalWorkspaceSession();
  closeLater(context, () => workspace.closeAll());
  const events = [];
  workspace.subscribe((event) => events.push(event));
  const product = await workspace.open(productPath);
  const foundationLocator = (await openPackage(foundationPath)).locator;
  const foundation = workspace.describe(foundationLocator);

  const result = await workspace.commit(
    foundation.locator,
    opacityBatch(foundation.snapshot.revision, 0.2, "batch_foundation_local"),
  );

  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "package-dependency-changed" &&
        event.locator === product.locator &&
        event.dependencyEvent === "package-committed",
    ),
  );
  assert.equal(
    workspace.describe(product.locator).workspace.foundation.revision,
    result.revision,
  );
});

test("an external write that lands right after a local commit is reported (M4)", async (context) => {
  const root = await tempRoot(context);
  const packagePath = (
    await openPackage(await copyPackage(root, "race.smallpen"))
  ).locator;
  const backend = new LocalPackageBackend();
  closeLater(context, () => backend.close());
  const events = [];
  backend.subscribe((event) => events.push(event));
  const opened = await backend.open(packagePath);
  const batch = opacityBatch(opened.revision, 0.5, "batch_local_before_race");
  const expected = (await prepareOperationBatch(opened, batch)).result.revision;

  const local = backend.commit(batch);
  let settled = false;
  local.then(() => (settled = true), () => (settled = true));
  // Wait until the local commit holds the write lock; a fixed delay let a
  // slow commit lose the lock to the external write (stale_revision).
  const active = join(dirname(packagePath), ".race.smallpen.write-lock", "active");
  while (!settled && !(await lstat(active).then(() => true, () => false))) {
    await delay(1);
  }
  // Queued behind the local commit's write lock: it lands as soon as that
  // lock is released, before the backend could reopen the Package.
  const external = applyOperationBatch(
    packagePath,
    opacityBatch(expected, 0.9, "batch_external_after_race"),
  );
  const committed = await local;
  const externalResult = await external;

  assert.equal(committed.revision, expected);
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "external-revision" &&
        event.change.revision === externalResult.revision,
    ),
  );
  assert.equal(backend.snapshot.revision, externalResult.revision);
});

test("an unchanged Package is not reloaded on refresh, while edits still are (M2)", async (context) => {
  const root = await tempRoot(context);
  const packagePath = (
    await openPackage(await copyPackage(root, "poll.smallpen"))
  ).locator;
  // Fingerprints that contain timestamps from the last two seconds are never
  // trusted (coarse file system clocks); let the fresh copy settle.
  await delay(2100);
  const backend = new LocalPackageBackend();
  closeLater(context, () => backend.close());
  await backend.open(packagePath);

  await backend.refresh();
  const unchanged = await backend.refresh();
  assert.equal(unchanged, backend.snapshot);

  const screenPath = join(packagePath, "screens/roundtrip.json");
  const screen = JSON.parse(await readFile(screenPath, "utf8"));
  screen.name = "Edited outside";
  await writeJson(screenPath, screen);
  await waitFor(async () => {
    await backend.refresh();
    return backend.snapshot.entries["screens/roundtrip.json"].name === "Edited outside";
  });
});

test("session commits reuse verified remote Libraries instead of refetching (M5)", async (context) => {
  const root = await tempRoot(context);
  const remoteManifest = JSON.parse(await readFile(join(fixture, "manifest.json"), "utf8"));
  remoteManifest.name = "Remote Icons";
  remoteManifest.packageId = "pkg_remote_icons";
  const remoteValues = new Map([["manifest.json", remoteManifest]]);
  for (const entry of listPackageEntries(remoteManifest).entries) {
    remoteValues.set(entry, JSON.parse(await readFile(join(fixture, entry), "utf8")));
  }
  const ownerPath = await copyPackage(root, "owner.smallpen", (manifest) => {
    manifest.libraries = [
      {
        packageId: "pkg_remote_icons",
        source: { type: "url", url: "https://design.example/icons/" },
      },
    ];
  });
  const requests = [];
  let offline = false;
  const fetchImpl = async (url, init) => {
    requests.push(String(url));
    if (offline) {
      // An unreachable remote: hangs until the request is aborted.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal.reason));
      });
    }
    const value = remoteValues.get(new URL(url).pathname.replace("/icons/", ""));
    return value === undefined
      ? new Response("missing", { status: 404 })
      : new Response(JSON.stringify(value), { status: 200 });
  };
  const workspace = new LocalWorkspaceSession({ fetchImpl });
  closeLater(context, () => workspace.closeAll());

  const owner = await workspace.open(ownerPath);
  assert.equal(owner.status.state, "ready");
  const fetched = requests.length;
  assert.ok(fetched > 0);

  offline = true;
  const committed = await Promise.race([
    workspace.commit(
      owner.locator,
      opacityBatch(owner.snapshot.revision, 0.45, "batch_remote_offline"),
    ),
    delay(5000).then(() => "timed out"),
  ]);
  assert.notEqual(committed, "timed out");
  assert.equal(requests.length, fetched);
  assert.equal(workspace.describe(owner.locator).status.state, "ready");
});
