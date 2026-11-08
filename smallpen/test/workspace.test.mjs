import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { listPackageEntries } from "@smallpen/core";
import {
  applyOperationBatch,
  openWorkspace,
  resolveWorkspace,
} from "@smallpen/local-package";
import { onlyScreen, seedLegacyIds } from "./helpers/named.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "roundtrip.smallpen");
const fixtureModel = join(here, "fixtures", "model", "roundtrip");

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function workspaceFixture() {
  const root = await mkdtemp(join(tmpdir(), "smallpen-workspace-test-"));
  const productPath = join(root, "app.smallpen");
  const foundationPath = join(root, "foundation.smallpen");
  await cp(fixture, productPath, { recursive: true });
  await seedLegacyIds(productPath, "roundtrip");
  await cp(fixture, foundationPath, { recursive: true });
  await seedLegacyIds(foundationPath, "roundtrip");
  const foundationManifestPath = join(foundationPath, "manifest.json");
  const foundationManifest = JSON.parse(
    await readFile(foundationManifestPath, "utf8"),
  );
  foundationManifest.name = "Foundation";
  foundationManifest.packageId = "pkg_foundation";
  await writeJson(foundationManifestPath, foundationManifest);
  const productManifestPath = join(productPath, "manifest.json");
  const productManifest = JSON.parse(
    await readFile(productManifestPath, "utf8"),
  );
  productManifest.dependencies = [
    { packageId: "pkg_foundation", path: "foundation.smallpen" },
  ];
  productManifest.name = "Product";
  productManifest.packageId = "pkg_product";
  productManifest.role = "product";
  await writeJson(productManifestPath, productManifest);
  return { foundationPath, productPath, root };
}

test("opening a non-Package path never creates a lock beside it", async () => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-lock-litter-"));
  await mkdir(join(root, "private"));
  await writeFile(join(root, "private", "notes.txt"), "data");
  for (const path of [join(root, "private"), join(root, "private", "notes.txt")]) {
    await assert.rejects(
      openWorkspace(path),
      (error) => error?.code === "invalid_package_path",
    );
  }
  assert.deepEqual(await readdir(root), ["private"]);
  assert.deepEqual(await readdir(join(root, "private")), ["notes.txt"]);
});

