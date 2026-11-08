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

import { encodePackage, prepareOperationBatch } from "@smallpen/core";
import {
  applyOperationBatch,
  LocalPackageBackend,
  LocalWorkspaceSession,
  openPackage,
} from "@smallpen/local-package";
import { onlyScreen, seedLegacyIds } from "./helpers/named.mjs";
import { filesRevision } from "../packages/local-package/src/html-store.mjs";

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

async function copyPackage(root, name) {
  const packagePath = join(root, name);
  await cp(fixture, packagePath, { recursive: true });
  return seedLegacyIds(packagePath, "roundtrip");
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


test("opening a Package without tokens.css never writes; the first commit adds it (M3)", async (context) => {
  const root = await tempRoot(context);
  const packagePath = await copyPackage(root, "tokenless.smallpen");
  await rm(join(packagePath, "tokens.css"));
  const disk = (await openPackage(packagePath)).revision;
  const workspace = new LocalWorkspaceSession();
  closeLater(context, () => workspace.closeAll());

  const opened = await workspace.open(packagePath);
  assert.equal(workspace.packages.length, 1);
  assert.equal(opened.status.state, "ready");
  assert.equal((await openPackage(packagePath)).revision, disk);
  assert.equal(await exists(join(packagePath, "tokens.css")), false);

  const result = await workspace.commit(
    opened.locator,
    opacityBatch(opened.snapshot.revision, 0.5, "batch_first_tokenless_write"),
  );
  const written = await openPackage(packagePath);
  assert.equal(result.revision, written.revision);
  assert.equal(workspace.describe(opened.locator).snapshot.revision, written.revision);
  assert.equal(await exists(join(packagePath, "tokens.css")), true);
  assert.equal(onlyScreen(written).presentations[0].nodes.node_rectangle.opacity, 0.5);
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
  // The revision a commit produces is the hash of the files it writes.
  const expected = filesRevision(encodePackage((await prepareOperationBatch(opened, batch)).snapshot).files);

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

  const pagePath = join(packagePath, "pages", "Round Trip.html");
  await writeFile(pagePath, (await readFile(pagePath, "utf8")).replace("bg-[#7c3aed]", "bg-[#111111]"));
  await waitFor(async () => {
    await backend.refresh();
    return onlyScreen(backend.snapshot).presentations[0].nodes.node_rectangle.fills[0].color === "#111111";
  });
});

