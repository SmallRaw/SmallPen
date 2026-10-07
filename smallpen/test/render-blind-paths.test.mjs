// Path rendering found wrong by the Flowboard blind test: curve commands drew
// straight chords and cap markers stayed a few pixels wide whatever the
// stroke width. Expected geometry comes from Penpot's SVG renderer
// (ui/shapes/custom_stroke.cljs markers, attrs.cljs dash arrays), which
// the SmallPen editor uses by default.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inflateSync } from "node:zlib";

import { listPackageEntries, loadPackageFromValues } from "@smallpen/core";
import { createEvidence } from "@smallpen/local-package";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "roundtrip.smallpen");
const BACKGROUND = [244, 244, 245];
const INK = [29, 78, 216];

async function renderPaths(paths) {
  const manifest = JSON.parse(await readFile(join(fixture, "manifest.json"), "utf8"));
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of listPackageEntries(manifest).entries) {
    values.set(entry, JSON.parse(await readFile(join(fixture, entry), "utf8")));
  }
  const nodes = values.get("screens/roundtrip.json").presentations[0].nodes;
  delete nodes.node_rectangle;
  nodes.node_canvas.children = [];
  paths.forEach((path, index) => {
    const id = `node_path_${index}`;
    nodes[id] = {
      children: [],
      fills: [],
      height: 100,
      id,
      name: id,
      type: "PATH",
      width: 100,
      x: 0,
      y: 0,
      ...path,
      strokes: path.strokes.map((stroke) => ({
        alignment: "center",
        color: "#1d4ed8",
        type: "solid",
        ...stroke,
      })),
    };
    nodes.node_canvas.children.push(id);
  });
  const evidence = await createEvidence(
    await loadPackageFromValues("memory://render-blind-paths.smallpen", values),
    { scale: 1, selector: { viewFormat: "screenshot" } },
  );
  assert.deepEqual(evidence.render.diagnostics, []);
  const { bytes, width } = evidence.render;
  const chunks = [];
  const buffer = Buffer.from(bytes);
  for (let offset = 8; offset < buffer.length; ) {
    const length = buffer.readUInt32BE(offset);
    if (buffer.toString("ascii", offset + 4, offset + 8) === "IDAT") {
      chunks.push(buffer.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }
  const pixels = inflateSync(Buffer.concat(chunks));
  return (x, y) => {
    const offset = Math.floor(y) * (width * 4 + 1) + 1 + Math.floor(x) * 4;
    return [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
  };
}

function near(actual, expected, tolerance = 24) {
  return actual.every((channel, index) => Math.abs(channel - expected[index]) <= tolerance);
}

function assertInk(pixel, x, y, label) {
  assert.ok(near(pixel(x, y), INK), `${label}: (${x}, ${y}) should be stroke ink, got ${pixel(x, y)}`);
}

function assertBlank(pixel, x, y, label) {
  assert.ok(
    near(pixel(x, y), BACKGROUND, 6),
    `${label}: (${x}, ${y}) should be background, got ${pixel(x, y)}`,
  );
}

test("curve commands stroke the curve, not the chord between end points", async () => {
  const pixel = await renderPaths([
    // Cubic: B(0.5) = (50, 17.5).
    { pathData: "M 5 70 C 5 0 95 0 95 70", strokes: [{ width: 4 }], x: 20, y: 20 },
    // Quadratic: B(0.5) = (50, 25).
    { pathData: "M 5 70 Q 50 -20 95 70", strokes: [{ width: 4 }], x: 140, y: 20 },
    // Smooth cubic reflects (40,0) about (50,40): the second half dips to
    // B(0.5) = (72.5, 70) of the cubic (50,40) (60,80) (80,80) (95,40).
    {
      pathData: "M 5 40 C 20 0 40 0 50 40 S 80 80 95 40",
      strokes: [{ width: 4 }],
      x: 260,
      y: 20,
    },
    // Smooth quadratic reflects (27,0) about (50,40) to (73,80): B(0.5) of
    // (50,40) (73,80) (95,40) is (72.75, 60).
    { pathData: "M 5 40 Q 27 0 50 40 T 95 40", strokes: [{ width: 4 }], x: 380, y: 20 },
    // Elliptical arc around (50,60) with radii 40 x 30 passes (50,30).
    { pathData: "M 10 60 A 40 30 0 0 1 90 60", strokes: [{ width: 4 }], x: 500, y: 20 },
  ]);
  assertInk(pixel, 20 + 50, 20 + 17.5, "C apex");
  assertBlank(pixel, 20 + 50, 20 + 70, "C chord");
  assertInk(pixel, 140 + 50, 20 + 25, "Q apex");
  assertBlank(pixel, 140 + 50, 20 + 70, "Q chord");
  assertInk(pixel, 260 + 72.5, 20 + 70, "S reflected half");
  assertBlank(pixel, 260 + 72.5, 20 + 40, "S chord");
  assertInk(pixel, 380 + 72.75, 20 + 60, "T reflected half");
  assertBlank(pixel, 380 + 72.75, 20 + 40, "T chord");
  assertInk(pixel, 500 + 50, 20 + 30, "A top");
  assertBlank(pixel, 500 + 50, 20 + 60, "A chord");
});

test("S after a quadratic and T after a cubic do not reflect a control point", async () => {
  // SVG reflects only a C/S control point for S (a Q/T one for T); otherwise
  // the first control point is the current point, so both second halves
  // run straight along y = 40 instead of dipping to y = 60 near x = 84.
  const fills = [{ color: "#1d4ed8", type: "solid" }];
  const pixel = await renderPaths([
    { fills, pathData: "M 0 40 Q 25 0 50 40 S 100 40 100 40 Z", strokes: [], x: 20, y: 20 },
    { fills, pathData: "M 0 40 C 10 0 40 0 50 40 T 100 40 Z", strokes: [], x: 140, y: 20 },
  ]);
  assertInk(pixel, 20 + 25, 20 + 30, "Q hump");
  assertBlank(pixel, 20 + 84, 20 + 50, "no S dip");
  assertInk(pixel, 140 + 25, 20 + 30, "C hump");
  assertBlank(pixel, 140 + 84, 20 + 50, "no T dip");
});

test("a closed curve fills its inside and a straight zero-height path still draws", async () => {
  const pixel = await renderPaths([
    {
      fills: [{ color: "#1d4ed8", type: "solid" }],
      pathData: "M 50 5 C 90 5 95 40 95 40 C 95 75 50 75 50 75 Q 5 75 5 40 T 50 5 Z",
      strokes: [],
      x: 20,
      y: 20,
    },
    { height: 0, pathData: "M 0 0 L 80 0", strokes: [{ width: 4 }], x: 140, y: 60 },
  ]);
  assertInk(pixel, 20 + 50, 20 + 40, "closed curve inside");
  assertBlank(pixel, 20 + 8, 20 + 8, "closed curve outside its corner");
  assertInk(pixel, 140 + 40, 60, "zero-height line");
});

test("open path ends are butt and strokes follow Penpot's dash arrays", async () => {
  const pixel = await renderPaths([
    { height: 0, pathData: "M 0 0 L 80 0", strokes: [{ width: 8 }], x: 40, y: 30 },
    // Dashed defaults to (w+10) on, (w+10) off: [0,12) on, [12,24) off.
    { height: 0, pathData: "M 0 0 L 200 0", strokes: [{ style: "dashed", width: 2 }], x: 40, y: 80 },
    // Dotted is round dots of diameter w every w+5.
    { height: 0, pathData: "M 0 0 L 200 0", strokes: [{ style: "dotted", width: 6 }], x: 40, y: 120 },
  ]);
  assertInk(pixel, 40 + 1, 30, "line start");
  assertBlank(pixel, 40 - 2, 30, "no cap past the start");
  assertBlank(pixel, 40 + 82, 30, "no cap past the end");
  assertInk(pixel, 40 + 6, 80, "first dash");
  assertBlank(pixel, 40 + 18, 80, "first gap");
  assertInk(pixel, 40 + 30, 80, "second dash");
  assertInk(pixel, 40 + 11, 120, "second dot centre");
  assertBlank(pixel, 40 + 5.5, 120, "between dots");
});

test("cap markers take Penpot's SVG marker geometry, scaled by stroke width", async () => {
  // Each line runs from x=40 to x=120 (the end E) at y = 40 + 60·row, w = 6.
  const caps = [
    "triangle-arrow",
    "circle-marker",
    "square-marker",
    "diamond-marker",
    "line-arrow",
  ];
  const pixel = await renderPaths(caps.map((cap, row) => ({
    height: 0,
    pathData: "M 0 0 L 80 0",
    strokes: [{ capEnd: cap, width: 6 }],
    x: 40,
    y: 40 + 60 * row,
  })));
  const end = 120;
  // Triangle: viewBox 3x6 fitted in 8.5w: tip 1.42w = 8.5 past E, base
  // 2.83w = 17 behind it, 4.25w = 25.5 either side.
  assertInk(pixel, end + 6, 40, "triangle tip");
  assertBlank(pixel, end + 10, 40, "past the triangle tip");
  assertInk(pixel, end - 16, 40 + 20, "triangle base");
  assertBlank(pixel, end - 15, 40 + 27, "beside the triangle base");
  // Circle: radius 2w = 12.
  assertInk(pixel, end, 100 + 10, "circle edge");
  assertBlank(pixel, end, 100 + 14, "outside the circle");
  // Square: side 4.24w = 25.5 centred on E.
  assertInk(pixel, end + 11, 160 + 11, "square corner");
  assertBlank(pixel, end + 14, 160, "outside the square");
  // Diamond: vertices 3w = 18 from E.
  assertInk(pixel, end + 16, 220, "diamond tip");
  assertInk(pixel, end + 7, 220 + 7, "diamond side");
  assertBlank(pixel, end + 11, 220 + 11, "outside the diamond side");
  // Line arrow: a filled chevron; its arm crosses (E-5, ±9) and the notch
  // between the arms at (E-12.75, ±4.25) stays open.
  assertInk(pixel, end - 5, 280 - 9, "chevron arm");
  assertInk(pixel, end - 5, 280 + 9, "other chevron arm");
  assertBlank(pixel, end - 12.75, 280 - 4.25 - 1, "inside the chevron notch");
});

test("cap markers grow with the stroke width", async () => {
  const pixel = await renderPaths([
    {
      height: 0,
      pathData: "M 0 0 L 80 0",
      strokes: [{ capEnd: "triangle-arrow", width: 2 }],
      x: 40,
      y: 40,
    },
    {
      height: 0,
      pathData: "M 0 0 L 80 0",
      strokes: [{ capEnd: "triangle-arrow", width: 8 }],
      x: 40,
      y: 120,
    },
  ]);
  // Tip 1.42w past the end: 2.8 for w=2, 11.3 for w=8.
  assertInk(pixel, 120 + 1, 40, "thin tip");
  assertBlank(pixel, 120 + 5, 40, "past the thin tip");
  assertInk(pixel, 120 + 9, 120, "thick tip");
  // Half the base: 4.25w, 8.5 for w=2 and 34 for w=8.
  assertBlank(pixel, 120 - 5, 40 + 12, "beside the thin base");
  assertInk(pixel, 120 - 20, 120 + 26, "thick base");
});

test("open paths stroke centred whatever their alignment, closed ones align", async () => {
  const pixel = await renderPaths([
    { height: 0, pathData: "M 0 0 L 80 0", strokes: [{ alignment: "inner", width: 8 }], x: 40, y: 40 },
    {
      fills: [],
      pathData: "M 0 0 L 60 0 L 60 60 L 0 60 Z",
      strokes: [{ alignment: "outer", width: 8 }],
      x: 40,
      y: 100,
    },
  ]);
  assertInk(pixel, 80, 40 - 3, "above an open inner stroke");
  assertInk(pixel, 80, 40 + 3, "below an open inner stroke");
  assertInk(pixel, 70, 100 - 6, "outer stroke outside the closed path");
  assertBlank(pixel, 70, 100 + 3, "outer stroke not inside the closed path");
});
