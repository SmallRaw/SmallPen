import { pngPixels } from "./png-pixels.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { perSideStrokeWidths, rectangularStrokeBand } from "@smallpen/core";
import { openPackage, renderProjection } from "@smallpen/local-package";

const fixture = new URL("./fixtures/roundtrip.smallpen/", import.meta.url).pathname;

function pixelsOf(render) {
  const bytes = Buffer.from(render.bytes), chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString("ascii", offset + 4, offset + 8) === "IDAT") chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const pixels = pngPixels(bytes, render.width);
  return (x, y) => [...pixels.subarray(y * (render.width * 4 + 1) + 1 + x * 4, y * (render.width * 4 + 1) + 1 + x * 4 + 4)];
}

test("side widths preserve zero, inherit absent sides and leave uniform strokes unchanged", () => {
  assert.deepEqual(perSideStrokeWidths({ width: 2, widthTop: 0 }), [0, 2, 2, 2]);
  assert.deepEqual(perSideStrokeWidths({ width: 0, widthBottom: 2 }), [0, 0, 2, 0]);
  assert.equal(perSideStrokeWidths({ width: 2, widthTop: null }), null);
  assert.equal(perSideStrokeWidths({ width: 2, widthTop: 2, widthBottom: 2 }), null);
});

test("rounded side bands fit oversized radii and omit collapsed inner holes", () => {
  const node = { width: 100, height: 60, cornerRadius: 1000 };
  const stroke = { width: 0, widthBottom: 2, alignment: "inner" };
  assert.match(rectangularStrokeBand(node, stroke).outerPath, /A30,30/);
  assert.equal(rectangularStrokeBand(node, { ...stroke, widthBottom: 80 }).innerPath, "");
});

for (const alignment of ["inner", "center", "outer"])
  test(`CLI ${alignment} side borders use the rounded band drawn in SVG`, async () => {
    const product = await openPackage(fixture);
    const root = { id: "root", type: "FRAME", children: ["box"], x: 0, y: 0, width: 160, height: 120,
      fills: [{ type: "solid", color: "#ffffff" }] };
    const node = { id: "box", type: "RECTANGLE", children: [], x: 20, y: 20, width: 100, height: 60, cornerRadius: 12,
      fills: [], strokes: [{ type: "solid", style: "solid", color: "#000000", width: 2, widthBottom: 8, alignment }] };
    const projection = { nodes: { root, box: node }, rootId: "root" };
    const pixel = pixelsOf(await renderProjection(product, projection, { scale: 2 }));
    // The centre remains a hole; the lower edge reaches according to alignment.
    assert.deepEqual(pixel(140, 100), [255, 255, 255, 255]);
    const bottom = alignment === "outer" ? 87 : alignment === "center" ? 83 : 79;
    assert.deepEqual(pixel(140, bottom * 2), [0, 0, 0, 255]);
    // A rounded corner stays clear, including for centre and outer strokes.
    const corner = alignment === "outer" ? [18, 18] : alignment === "center" ? [19, 19] : [20, 20];
    assert.deepEqual(pixel(corner[0] * 2, corner[1] * 2), [255, 255, 255, 255]);
    assert.ok(rectangularStrokeBand(node, node.strokes[0]).pathData.includes("A"));
  });
