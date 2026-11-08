import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { seedLegacyIds } from "./helpers/named.mjs";
import {
  applyOperationBatch,
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

async function copyPackage(root, name, source = fixture) {
  const packagePath = join(root, name);
  await cp(source, packagePath, { recursive: true });
  return seedLegacyIds(packagePath, "roundtrip");
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

test("an asset file edited in place is a new revision, not a broken package", async (context) => {
  const { closeLater, root } = await tempRoot(context);
  const packagePath = (await openPackage(await copyPackage(root, "blob.smallpen"))).locator;
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await mkdir(join(packagePath, "assets"), { recursive: true });
  await writeFile(join(packagePath, "assets", "pixel.png"), pixel);
  const page = join(packagePath, "pages", "Round Trip.html");
  await writeFile(page, (await readFile(page, "utf8")).replace("</body>", '  <img data-name="Pixel" src="../assets/pixel.png" class="w-[1px] h-[1px]">\n</body>'));
  // Fingerprints that contain timestamps from the last two seconds are never
  // trusted (coarse file system clocks); let the fresh files settle.
  await delay(2100);
  const backend = new LocalPackageBackend();
  closeLater(() => backend.close());
  const opened = await backend.open(packagePath);
  await backend.refresh();
  assert.equal(await backend.refresh(), backend.snapshot);

  const handle = await open(join(packagePath, "assets", "pixel.png"), "r+");
  try {
    await handle.write(Buffer.from([pixel[20] ^ 0xff]), 0, 1, 20);
  } finally {
    await handle.close();
  }

  const refreshed = await backend.refresh();
  assert.ok(refreshed, "the edited asset is read again");
  assert.notEqual(refreshed.revision, opened.revision);
  assert.equal(backend.status.state, "ready");
});

test("closing the workspace while a Package opens leaves no Package watching", async (context) => {
  const { closeLater, root } = await tempRoot(context);
  const productPath = await copyPackage(root, "opening.smallpen");
  const watchers = () =>
    process.getActiveResourcesInfo().filter((type) => type === "FSEventWrap").length;
  const before = watchers();
  const workspace = new LocalWorkspaceSession();
  // Should this test fail, still release what leaked so the file can exit.
  closeLater(() => workspace.closeAll());

  // The Package is registered before it finishes opening, so closeAll()
  // runs while the open is still in flight.
  const opening = workspace.open(productPath).catch((error) => error);
  while (workspace.packages.length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await workspace.closeAll();
  await opening;

  assert.deepEqual(workspace.packages, []);
  await waitFor(() => watchers() === before);
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

