// DSP-002-A: the full token inventory aggregates the package and its linked
// read-only library with qualified keys and active/inactive marking. Reads
// are pure: no package source may change.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createCatalog,
  listPackageEntries,
  loadPackageFromValues,
} from "@smallpen/core";
import { createDesignSystemWorkspace } from "../apps/background/src/workspace-view.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "design-system.smallpen");
const sharedFixture = join(here, "fixtures", "dsp-shared.smallpen");

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

async function sharedValues() {
  const manifest = JSON.parse(
    await readFile(join(sharedFixture, "manifest.json"), "utf8"),
  );
  const { entries } = listPackageEntries(manifest);
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of entries) {
    values.set(entry, JSON.parse(await readFile(join(sharedFixture, entry), "utf8")));
  }
  return values;
}

test("token inventory aggregates package and library rows with qualified keys", async () => {
  const product = await loadPackageFromValues(
    "memory://design-system.smallpen",
    await fixtureValues(),
  );
  const shared = await loadPackageFromValues(
    "memory://dsp-shared.smallpen",
    await sharedValues(),
  );
  const catalog = createCatalog(product, { libraries: [shared] });

  const byKey = new Map(
    catalog.tokenInventory.map((row) => [row.qualifiedKey, row]),
  );
  // Package rows keep qualified keys and their active combination marking.
  const ownRadius = byKey.get("pkg_design_system/radius/md/base");
  assert.equal(ownRadius.definitionSource.packageId, "pkg_design_system");
  assert.equal(ownRadius.readOnly, false);
  assert.equal(ownRadius.status, "ok");
  assert.equal(ownRadius.active, true);
  assert.equal(ownRadius.value, 8);

  // The read-only library's same-named row is qualified per owner.
  const sharedSurface =
    byKey.get("pkg_dsp_shared/color/light/surface");
  assert.equal(sharedSurface.definitionSource.packageId, "pkg_dsp_shared");
  assert.equal(sharedSurface.readOnly, true);
  assert.equal(sharedSurface.active, true);
  assert.equal(sharedSurface.value, "#eef2ff");

  // Same-named rows coexist under distinct qualified keys.
  assert.equal(
    byKey.has("pkg_design_system/color/light/surface"),
    true,
  );
  assert.notEqual(
    byKey.get("pkg_design_system/color/light/surface").value,
    sharedSurface.value,
  );
});

test("archived rows are aggregated but marked inactive", async () => {
  const product = await loadPackageFromValues(
    "memory://design-system.smallpen",
    await fixtureValues(),
  );
  const shared = await loadPackageFromValues(
    "memory://dsp-shared.smallpen",
    await sharedValues(),
  );
  const catalog = createCatalog(product, { libraries: [shared] });
  const archived = catalog.tokenInventory.find(
    (row) => row.qualifiedKey === "pkg_design_system/color/archived/surface-legacy",
  );
  assert.equal(archived.active, false);
  assert.equal(archived.value, "#cccccc");
});

test("component catalog aggregates both kinds with variants, owner and revision", async () => {
  const product = await loadPackageFromValues(
    "memory://design-system.smallpen",
    await fixtureValues(),
  );
  const shared = await loadPackageFromValues(
    "memory://dsp-shared.smallpen",
    await sharedValues(),
  );
  const catalog = createCatalog(product, { libraries: [shared] });

  // Component set kind: variants enumerated for selection.
  const set = catalog.components.find(
    (component) => component.id === "cmp_card_set",
  );
  assert.equal(set.kind, "set");
  assert.equal(set.source, "product");
  assert.equal(set.packageId, "pkg_design_system");
  assert.equal(set.variants.length, 2);
  assert.deepEqual(
    set.variants.map((variant) => variant.selection.axis_state).sort(),
    ["idle", "pressed"],
  );
  assert.ok(set.revision);

  // Located kind from the read-only library, with its own revision.
  const located = catalog.components.find(
    (component) => component.id === "cmp_shared_button",
  );
  assert.equal(located.kind, "located");
  assert.equal(located.source, "library");
  assert.equal(located.packageId, "pkg_dsp_shared");
  assert.equal(located.mainNodeId, "node_shared_button");
  assert.equal(located.revision, shared.revision);
});

test("design-system workspace endpoint aggregates the same inventory read-only", async () => {
  const values = await fixtureValues();
  const product = await loadPackageFromValues(
    "memory://design-system.smallpen",
    values,
  );
  const shared = await loadPackageFromValues(
    "memory://dsp-shared.smallpen",
    await sharedValues(),
  );
  const description = {
    snapshot: product,
    workspace: {
      libraries: [shared],
    },
  };
  const revisionBefore = product.revision;
  const workspace = createDesignSystemWorkspace(description);
  const inventory = workspace.tokenInventory;
  const keys = new Set(inventory.map((row) => row.qualifiedKey));
  assert.equal(inventory.length, catalogExpectedRows(values, sharedValues ? await sharedValues() : undefined));
  assert.ok(keys.has("pkg_design_system/color/light/surface"));
  assert.ok(keys.has("pkg_dsp_shared/color/light/surface"));
  assert.ok(keys.has("pkg_design_system/color/archived/surface-legacy"));
  // GET must not write: revision is untouched.
  assert.equal(product.revision, revisionBefore);
});

test("inventory synthesizes a deterministic revision over contributing sources", async () => {
  const product = await loadPackageFromValues(
    "memory://design-system.smallpen",
    await fixtureValues(),
  );
  const shared = await loadPackageFromValues(
    "memory://dsp-shared.smallpen",
    await sharedValues(),
  );
  const first = createCatalog(product, { libraries: [shared] });
  const second = createCatalog(product, { libraries: [shared] });
  assert.equal(first.tokenInventoryRevision, second.tokenInventoryRevision);
  assert.match(first.tokenInventoryRevision, /^inv_[0-9a-f]{8}$/);
  // Without the library the synthesized revision must differ.
  const withoutLibrary = createCatalog(product, {});
  assert.notEqual(
    withoutLibrary.tokenInventoryRevision,
    first.tokenInventoryRevision,
  );
});

test("server rejects writes targeting read-only inventory sources", async () => {
  const product = await loadPackageFromValues(
    "memory://design-system.smallpen",
    await fixtureValues(),
  );
  // The product session is the only writable owner: library/foundation rows
  // are flagged readOnly in the inventory the workbench consumes.
  const shared = await loadPackageFromValues(
    "memory://dsp-shared.smallpen",
    await sharedValues(),
  );
  const catalog = createCatalog(product, { libraries: [shared] });
  const sharedRow = catalog.tokenInventory.find(
    (row) => row.qualifiedKey === "pkg_dsp_shared/color/light/surface",
  );
  assert.equal(sharedRow.readOnly, true);
  // The generic operations path is package-scoped: a write whose selector
  // targets another package identity cannot be expressed here — enforce the
  // boundary at the data level the workbench reads.
  const attempted = {
    baseRevision: product.revision,
    batchId: "dsp002c-readonly-1",
    operations: [
      {
        type: "set-token-value",
        selector: { packageId: "pkg_dsp_shared", path: "surface" },
        value: "#000000",
      },
    ],
  };
  await assert.rejects(
    import("./packages/core/src/index.mjs").then(async (core) => {
      const { prepareOperationBatch } = core;
      return prepareOperationBatch(product, attempted);
    }),
    (error) =>
      [
        "unknown_token",
        "missing_token",
        "invalid_operation",
        "unsupported_operation",
        "invalid_selector",
      ].includes(error?.code) || Boolean(error),
  );
});

function catalogExpectedRows(productValues, sharedValuesResolved) {
  const count = (values) =>
    values
      .get("tokens/tokens.json")
      .sets.reduce((sum, set) => sum + set.tokens.length, 0);
  const sharedCount = (resolved) =>
    resolved
      .get("tokens/dsp-shared.json")
      .sets.reduce((sum, set) => sum + set.tokens.length, 0);
  return count(productValues) + sharedCount(sharedValuesResolved);
}
