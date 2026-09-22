import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  listPackageEntries,
  loadPackageFromValues,
  prepareOperationBatch,
} from "@smallpen/core";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "roundtrip.smallpen");

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

test("Core loads Canonical values without a filesystem adapter", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://roundtrip.smallpen",
    await fixtureValues(),
  );

  assert.equal(snapshot.manifest.packageId, "pkg_roundtrip");
  assert.match(snapshot.revision, /^[a-f0-9]{64}$/);
  assert.match(snapshot.runtime.team, /^[a-f0-9-]{36}$/);
  assert.notEqual(snapshot.runtime.team, snapshot.runtime.project);
  assert.match(
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle,
    /^[a-f0-9-]{36}$/,
  );
});

test("Core prepares a typed batch without mutating its input snapshot", async () => {
  const before = await loadPackageFromValues(
    "memory://roundtrip.smallpen",
    await fixtureValues(),
  );
  const prepared = await prepareOperationBatch(before, {
    baseRevision: before.revision,
    batchId: "batch_core_opacity",
    operations: [
      {
        changes: { opacity: 0.5 },
        nodeId: "node_rectangle",
        presentationId: "pres_desktop",
        screenId: "scr_roundtrip",
        type: "update-presentation-node",
      },
    ],
  });

  const beforeNode =
    before.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_rectangle;
  const afterNode =
    prepared.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_rectangle;
  assert.equal(beforeNode.opacity, 1);
  assert.equal(afterNode.opacity, 0.5);
  assert.notEqual(prepared.result.revision, before.revision);
  assert.deepEqual(prepared.result.changedFiles, ["screens/roundtrip.json"]);
});

test("Core rejects non-canonical IDs and platform path traversal", async () => {
  const invalidId = await fixtureValues();
  invalidId.get("manifest.json").packageId = "roundtrip";
  await assert.rejects(
    loadPackageFromValues("memory://invalid-id.smallpen", invalidId),
    (error) => error?.code === "invalid_package_id",
  );

  const invalidPath = await fixtureValues();
  invalidPath.get("manifest.json").entries.screens = [
    "screens\\..\\manifest.json",
  ];
  await assert.rejects(
    loadPackageFromValues("memory://invalid-path.smallpen", invalidPath),
    (error) => error?.code === "invalid_entry_path",
  );
});

test("Core enforces the Foundation and Product dependency contract", async () => {
  const productWithoutFoundation = await fixtureValues();
  productWithoutFoundation.get("manifest.json").role = "product";
  await assert.rejects(
    loadPackageFromValues(
      "memory://product-without-foundation.smallpen",
      productWithoutFoundation,
    ),
    (error) => error?.code === "product_dependency_count",
  );

  const foundationWithDependency = await fixtureValues();
  foundationWithDependency.get("manifest.json").dependencies = [
    { packageId: "pkg_other", path: "other.smallpen" },
  ];
  await assert.rejects(
    loadPackageFromValues(
      "memory://foundation-with-dependency.smallpen",
      foundationWithDependency,
    ),
    (error) => error?.code === "foundation_dependency_forbidden",
  );

  const unsafeDependencyPath = await fixtureValues();
  const unsafeManifest = unsafeDependencyPath.get("manifest.json");
  unsafeManifest.role = "product";
  unsafeManifest.dependencies = [
    { packageId: "pkg_foundation", path: "../foundation.smallpen" },
  ];
  await assert.rejects(
    loadPackageFromValues(
      "memory://unsafe-product.smallpen",
      unsafeDependencyPath,
    ),
    (error) => error?.code === "invalid_dependency",
  );
});

test("Core accepts local and URL Library sources with stable Package identities", async () => {
  const values = await fixtureValues();
  values.get("manifest.json").libraries = [
    {
      packageId: "pkg_local_library",
      source: { path: "../libraries/local.smallpen", type: "local" },
    },
    {
      packageId: "pkg_remote_library",
      source: {
        type: "url",
        url: "https://design.example/libraries/remote/manifest.json",
      },
    },
  ];
  const snapshot = await loadPackageFromValues(
    "memory://library-sources.smallpen",
    values,
  );
  assert.deepEqual(snapshot.manifest.libraries, values.get("manifest.json").libraries);

  const duplicate = await fixtureValues();
  duplicate.get("manifest.json").libraries = [
    {
      packageId: "pkg_same_library",
      source: { path: "first.smallpen", type: "local" },
    },
    {
      packageId: "pkg_same_library",
      source: { path: "second.smallpen", type: "local" },
    },
  ];
  await assert.rejects(
    loadPackageFromValues("memory://duplicate-library.smallpen", duplicate),
    (error) => error?.code === "duplicate_library",
  );

  const insecure = await fixtureValues();
  insecure.get("manifest.json").libraries = [
    {
      packageId: "pkg_remote_library",
      source: { type: "url", url: "ftp://design.example/library" },
    },
  ];
  await assert.rejects(
    loadPackageFromValues("memory://invalid-library-url.smallpen", insecure),
    (error) => error?.code === "invalid_library_source",
  );
});

test("Core links, replaces, removes, and reverses a Library source", async () => {
  const before = await loadPackageFromValues(
    "memory://library-operations.smallpen",
    await fixtureValues(),
  );
  const linked = await prepareOperationBatch(before, {
    baseRevision: before.revision,
    batchId: "link-library",
    operations: [
      {
        library: {
          packageId: "pkg_remote_library",
          source: {
            type: "url",
            url: "https://design.example/library/manifest.json",
          },
        },
        type: "put-library",
      },
    ],
  });
  assert.equal(linked.result.changedFiles[0], "manifest.json");
  assert.equal(
    linked.snapshot.manifest.libraries[0].source.url,
    "https://design.example/library/manifest.json",
  );

  const removed = await prepareOperationBatch(linked.snapshot, {
    baseRevision: linked.snapshot.revision,
    batchId: "unlink-library",
    operations: [
      { packageId: "pkg_remote_library", type: "remove-library" },
    ],
  });
  assert.equal(removed.snapshot.manifest.libraries, undefined);
  const restored = await prepareOperationBatch(
    removed.snapshot,
    removed.result.inverseBatch,
  );
  assert.deepEqual(restored.snapshot.manifest.libraries, linked.snapshot.manifest.libraries);
});

test("Core keeps the revision confirmed by the legacy SmallPen CLI", async () => {
  const before = await loadPackageFromValues(
    "memory://legacy-contract.smallpen",
    await fixtureValues(),
  );
  const prepared = await prepareOperationBatch(before, {
    baseRevision: before.revision,
    batchId: "batch_legacy_contract",
    operations: [
      {
        changes: { opacity: 0.35 },
        nodeId: "node_rectangle",
        presentationId: "pres_desktop",
        screenId: "scr_roundtrip",
        type: "update-presentation-node",
      },
    ],
  });

  assert.equal(
    prepared.result.revision,
    "829a952e988a95c362b7b20a8014d51922eac059bcd70717c495611b38e5f25b",
  );
});
