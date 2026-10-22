import assert from "node:assert/strict";
import test from "node:test";
import { openPackage } from "@smallpen/local-package";
import {
  canonicalJSON, componentDefineOperation, componentSetOperation,
  pageDrawOperation, pageSetOperation, prepareOperationBatch,
} from "@smallpen/core";

const fixture = new URL("fixtures/roundtrip.smallpen", import.meta.url).pathname;
const apply = async (snapshot, ...operations) => (await prepareOperationBatch(snapshot, {
  baseRevision: snapshot.revision, batchId: "input-validation", operations,
})).snapshot;

async function example() {
  let snapshot = await openPackage(fixture);
  const base = { layout: "row", width: 240, height: 60, children: [
    { name: "Label", text: "Save" }, { name: "Box", width: 24, height: 24 },
  ] };
  snapshot = await apply(snapshot, componentDefineOperation(snapshot, { name: "Action", base }));
  snapshot = await apply(snapshot, pageDrawOperation(snapshot, { page: "Actions", ...base }));
  return snapshot;
}

for (const [field, received, allowedValues] of [
  ["align", "middle", ["start", "center", "end", "stretch"]],
  ["justify", "around", ["start", "center", "end", "space-between"]],
  ["layout", "diagonal", ["row", "column", "none"]],
]) {
  test(`${field} rejects unsupported values in page and component creation and edits`, async () => {
    const snapshot = await example();
    const before = canonicalJSON(snapshot.entries);
    const invalid = { layout: "row", width: 120, height: 40, [field]: received };
    for (const operation of [
      () => pageDrawOperation(snapshot, { page: "Invalid", ...invalid, children: [] }),
      () => componentDefineOperation(snapshot, { name: "Invalid", base: invalid }),
      () => pageSetOperation(snapshot, { page: "Actions", set: { [field]: received } }),
      () => componentSetOperation(snapshot, { component: "Action", set: { [field]: received } }),
    ]) {
      assert.throws(operation, (error) => {
        assert.equal(error.code, field === "layout" ? "invalid_layout" : "invalid_alignment");
        assert.equal(error.details.field, field);
        assert.equal(error.details.received, received);
        assert.deepEqual(error.details.allowedValues, allowedValues);
        return true;
      });
    }
    assert.equal(canonicalJSON(snapshot.entries), before);
  });
}

test("container settings on text are rejected instead of silently ignored", async () => {
  const snapshot = await example();
  for (const [field, value] of Object.entries({ align: "center", justify: "center", layout: "row", gap: 8, padding: 8 })) {
    for (const operation of [
      () => pageDrawOperation(snapshot, { page: "Invalid", children: [{ name: "Label", text: "Save", [field]: value }] }),
      () => pageSetOperation(snapshot, { page: "Actions", element: "Label", set: { [field]: value } }),
      () => componentSetOperation(snapshot, { component: "Action", element: "Label", set: { [field]: value } }),
    ]) {
      assert.throws(operation, (error) => error.code === "inapplicable_field" && error.details.field === field && /Label/.test(error.message));
    }
  }
});

test("layout-dependent edits require a row or column on their target", async () => {
  const snapshot = await example();
  for (const [field, value] of Object.entries({ align: "center", justify: "center", gap: 8, padding: 8 })) {
    assert.throws(() => pageSetOperation(snapshot, { page: "Actions", element: "Box", set: { [field]: value } }),
      (error) => error.code === "inapplicable_field" && error.details.field === field);
  }
  assert.throws(() => pageSetOperation(snapshot, { page: "Actions", set: { layout: "none", align: "center" } }),
    (error) => error.code === "inapplicable_field" && error.details.field === "align");
  const changed = pageSetOperation(snapshot, { page: "Actions", element: "Box", set: { layout: "row", align: "center" } });
  const box = Object.values(changed.screen.presentations[0].nodes).find((node) => node.name === "Box");
  assert.equal(box["layout-align-items"], "center");
});

test("drawing a component copy rejects container fields that belong to its definition", async () => {
  const snapshot = await example();
  assert.throws(() => pageDrawOperation(snapshot, { page: "Copies", children: [{ name: "Copy", use: "Action", align: "center" }] }),
    (error) => error.code === "inapplicable_field" && error.details.field === "align" && /component/.test(error.message));
});
