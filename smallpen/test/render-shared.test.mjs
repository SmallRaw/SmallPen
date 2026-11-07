import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  projectDesignView,
  resolveDesignView,
  stableRuntimeUuid,
} from "@smallpen/core";
import { openPackage } from "@smallpen/local-package";

const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "roundtrip.smallpen",
);

test("the App renderer exports a package under Node without a browser or App", async () => {
  assert.equal(typeof globalThis.document, "undefined");
  const product = await openPackage(fixture);
  const projection = projectDesignView(product, resolveDesignView(product));
  const { renderAppProjection } = await import("@smallpen/local-package");
  const image = await renderAppProjection(product, projection);
  assert.deepEqual(
    [...image.bytes.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  assert.equal(image.width, 800);
  assert.equal(image.height, 600);
  assert.equal(image.renderer, "app-wasm");
  assert.match(image.kernelHash, /^[a-f0-9]{64}$/);
  assert.equal((await openPackage(fixture)).revision, product.revision);
});

test("the App renderer measures auto text before reflowing its flex siblings", async () => {
  const product = await openPackage(fixture);
  const projection = projectDesignView(product, resolveDesignView(product));
  const frame = projection.nodes[projection.rootId];
  frame.children = ["node_flex"];
  projection.nodes.node_flex = {
    id: "node_flex",
    type: "FRAME",
    name: "row",
    x: 20,
    y: 20,
    width: 400,
    height: 60,
    // SmallPen/Penpot store paint order; a normal row lays it out in reverse.
    children: ["node_following", "node_auto"],
    layout: "flex",
    "layout-flex-dir": "row",
    "layout-gap": { "row-gap": 8, "column-gap": 8 },
  };
  projection.nodes.node_auto = {
    id: "node_auto",
    type: "TEXT",
    name: "auto",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    growType: "auto-width",
    text: "Hello world",
    children: [],
    "layout-item-h-sizing": "fix",
    "layout-item-v-sizing": "fix",
    textStyle: {
      fontFamily: "sourcesanspro",
      fontId: "sourcesanspro",
      fontSize: 24,
      fontWeight: 400,
      lineHeight: 1.25,
    },
  };
  projection.nodes.node_following = {
    id: "node_following",
    type: "RECTANGLE",
    name: "following",
    x: 18,
    y: 0,
    width: 20,
    height: 20,
    children: [],
    fills: [{ type: "solid", color: "#3957d7" }],
    "layout-item-h-sizing": "fix",
    "layout-item-v-sizing": "fix",
  };
  const { renderAppProjection } = await import("@smallpen/local-package");
  const image = await renderAppProjection(product, projection);
  const id = (node) =>
    stableRuntimeUuid(product.manifest.packageId, "render-node", node);
  const text = image.geometry[await id("node_auto")];
  const next = image.geometry[await id("node_following")];
  assert.ok(text.width > 100, "real font metrics expand auto-width text");
  assert.equal(text.height, 30);
  assert.ok(
    next.x >= text.x + text.width + 7.99,
    `the sibling follows measured text plus gap: ${JSON.stringify({ text, next })}`,
  );
});
