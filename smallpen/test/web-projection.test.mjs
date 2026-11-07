import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { openPackage } from "@smallpen/local-package";

import { createWebWorkspaceSnapshot } from "../apps/background/src/web-projection.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "roundtrip.smallpen");

test("Web projection keeps a valid Package loadable", async () => {
  const product = await openPackage(fixture);
  const projected = await createWebWorkspaceSnapshot(product);

  assert.deepEqual(projected.projectionErrors, []);
  assert.equal(
    projected.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_rectangle.name,
    "Editable Rectangle",
  );
});

test("Web projection reports an invalid reference without rewriting the design", async () => {
  const product = await openPackage(fixture);
  const screen = product.entries["screens/roundtrip.json"];
  const presentation = screen.presentations[0];
  presentation.nodes.node_canvas.children.push("node_missing_component");
  presentation.nodes.node_missing_component = {
    children: [],
    height: 48,
    id: "node_missing_component",
    instance: {
      component: {
        assetId: "cmp_missing",
        packageId: product.manifest.packageId,
      },
      overrides: {},
      variant: {},
    },
    name: "Missing component",
    type: "INSTANCE",
    width: 120,
    x: 320,
    y: 96,
  };
  const before = structuredClone(product.entries);

  await assert.rejects(
    createWebWorkspaceSnapshot(product),
    (error) => {
      assert.equal(error?.code, "web_projection_failed");
      assert.equal(error?.details?.causeCode, "missing_component");
      assert.equal(error?.details?.causeDetails?.instanceId,
        "node_missing_component");
      assert.equal(error?.details?.screenId, "scr_roundtrip");
      assert.equal(error?.details?.presentationId, "pres_desktop");
      return true;
    },
  );

  assert.deepEqual(product.entries, before);
  assert.equal(
    product.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_missing_component.type,
    "INSTANCE",
  );
});
