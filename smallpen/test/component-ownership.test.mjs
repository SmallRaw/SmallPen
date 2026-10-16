import assert from "node:assert/strict";
import test from "node:test";
import { openPackage } from "@smallpen/local-package";
import { findComponent, findPageElement, loadPackageFromValues, prepareOperationBatch } from "@smallpen/core";
import { componentDefineOperation, pageDrawOperation, pageSetOperation } from "../packages/core/src/simple-design.mjs";
import { componentLookup } from "../apps/cli/bin/design-output.mjs";

async function example() {
  let local = await openPackage(new URL("fixtures/roundtrip.smallpen", import.meta.url).pathname);
  local = (await prepareOperationBatch(local, { baseRevision: local.revision, batchId: "local-card", operations: [componentDefineOperation(local, {
    name: "Card", base: { width: 100, children: [{ name: "Local action", text: "Local" }] },
  })] })).snapshot;
  const values = snapshot => new Map([["manifest.json", structuredClone(snapshot.manifest)], ...Object.entries(snapshot.entries).map(([key, value]) => [key, structuredClone(value)])]);
  const remoteValues = values(local);
  remoteValues.get("manifest.json").packageId = "pkg_library";
  const set = remoteValues.get(local.manifest.entries.components[0]).componentSets[0];
  set.name = "Remote Card";
  Object.values(set.variants[0].nodes).find(node => node.name === "Local action").name = "Remote action";
  const library = await loadPackageFromValues("memory://library.smallpen", remoteValues);
  const localValues = values(local);
  localValues.get("manifest.json").libraries = [{ packageId: "pkg_library", source: { type: "local", path: "library.smallpen" } }];
  local = await loadPackageFromValues("memory://local.smallpen", localValues);
  const options = { libraries: [library] };
  const screen = pageDrawOperation(local, { page: "Copies", children: [{ name: "Imported", use: "Remote Card" }] }, options);
  local = (await prepareOperationBatch(local, { baseRevision: local.revision, batchId: "import-card", operations: [screen] }, options)).snapshot;
  return { local, library, options };
}

test("component discovery retains components with the same ID in different packages", async () => {
  const { local, library, options } = await example();
  assert.equal(findComponent(local, "Remote Card", options).owner.manifest.packageId, library.manifest.packageId);
});

test("editing an imported copy uses its owning package rather than a local ID collision", async () => {
  const { local, options } = await example();
  const operation = pageSetOperation(local, { page: "Copies", element: "Imported", set: { text: { "Remote action": "Changed" } } }, options);
  const copy = Object.values(operation.screen.presentations[0].nodes).find(node => node.name === "Imported");
  assert.equal(copy.instance.component.packageId, "pkg_library");
  assert.ok(Object.entries(copy.instance.overrides).some(([key, value]) => key.endsWith(":text") && value === "Changed"));
});

test("link targeting inside an imported copy follows its package identity", async () => {
  const { local, options } = await example();
  assert.equal(findPageElement(local, "Copies / Imported / Remote action", undefined, options).inside.name, "Remote action");
});

test("a missing explicit component owner stays unknown instead of using a local namesake", async () => {
  const { local } = await example();
  assert.equal(componentLookup({ product: local })({ packageId: "pkg_missing", assetId: "cmp_card" }), undefined);
});

test("a same-name ID collision requires an explicit numbered choice", async () => {
  const { local, library } = await example();
  const renamed = structuredClone(library);
  renamed.domain.componentSets.get("cmp_card").name = "Card";
  const options = { libraries: [renamed] };
  assert.throws(() => pageDrawOperation(local, { page: "Ambiguous", children: [{ name: "Copy", use: "Card" }] }, options), error => error.code === "ambiguous_component");
  assert.equal(findComponent(local, "Card [2]", options).owner.manifest.packageId, "pkg_library");
  assert.equal(findComponent(local, "Card", { foundation: structuredClone(local) }).owner.manifest.packageId, local.manifest.packageId);
});
