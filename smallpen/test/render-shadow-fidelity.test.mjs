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

// Renders the fixture screen on a white canvas with `nodes` as the canvas
// children (coordinates are parent-relative) and returns a pixel reader.
async function renderNodes(nodes, children = Object.keys(nodes)) {
  const values = await fixtureValues();
  const screen = values.get("screens/roundtrip.json").presentations[0];
  screen.nodes = {
    node_canvas: {
      ...screen.nodes.node_canvas,
      children,
      fills: [{ color: "#ffffff", type: "solid" }],
    },
    ...nodes,
  };
  const evidence = await createEvidence(
    await loadPackageFromValues("memory://render-shadow-fidelity.smallpen", values),
    { scale: 1, selector: { viewFormat: "screenshot" } },
  );
  const { bytes, diagnostics, width } = evidence.render;
  const chunks = [];
  const buffer = Buffer.from(bytes);
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    if (buffer.toString("ascii", offset + 4, offset + 8) === "IDAT") {
      chunks.push(buffer.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }
  const pixels = inflateSync(Buffer.concat(chunks));
  const pixel = (x, y) => {
    const start = y * (width * 4 + 1) + 1 + x * 4;
    return [...pixels.subarray(start, start + 4)];
  };
  // Opacity of black ink over the white canvas, 0..1.
  const ink = (x, y) => 1 - pixel(x, y)[0] / 255;
  return { diagnostics, ink, pixel };
}

// A nearly transparent white fill: the card casts its shadow (a shape that
// paints nothing casts none) without hiding the shadow under it.
function shadowedCard(shadow, extra = {}) {
  return {
    node_card: {
      children: [],
      fills: [{ color: "#ffffff", opacity: 0.01, type: "solid" }],
      height: 100,
      id: "node_card",
      name: "Card",
      shadow: Array.isArray(shadow) ? shadow : [shadow],
      type: "RECTANGLE",
      width: 200,
      x: 80,
      y: 96,
      ...extra,
    },
  };
}

// Standard normal CDF via the Abramowitz-Stegun erf approximation 7.1.26.
function normalCdf(z) {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 +
    t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

test("a canonical offsetY shadow paints below the node only", async () => {
  const { diagnostics, ink } = await renderNodes(shadowedCard({
    blur: 0,
    color: "#000000",
    offsetX: 0,
    offsetY: 40,
    spread: 0,
  }));
  // The card spans y 96..196; its shadow spans y 136..236.
  assert.ok(ink(180, 220) > 0.95, `below the card: ${ink(180, 220)}`);
  assert.equal(ink(180, 120), 0, "no fill, and the shadow is shifted down");
  assert.equal(ink(180, 240), 0);
  assert.equal(ink(180, 90), 0);
  assert.deepEqual(diagnostics.map(({ code }) => code), []);
});

test("a legacy {x, y} shadow keeps its y offset and is diagnosed once", async () => {
  const legacy = { blur: 0, color: "#000000", spread: 0, x: 0, y: 40 };
  const { diagnostics, ink } = await renderNodes(shadowedCard([legacy, { ...legacy }]));
  assert.ok(ink(180, 220) > 0.95, `below the card: ${ink(180, 220)}`);
  assert.equal(ink(180, 120), 0);
  const legacyDiagnostics = diagnostics.filter(
    ({ code }) => code === "legacy_shadow_shape",
  );
  assert.equal(legacyDiagnostics.length, 1);
  assert.equal(legacyDiagnostics[0].nodeId, "node_card");
  assert.equal(legacyDiagnostics[0].path, "projection.nodes.node_card");
  assert.match(legacyDiagnostics[0].message, /offsetX\/offsetY/);
});

test("Penpot kebab-case shadows keep working without a legacy diagnostic", async () => {
  const { diagnostics, ink } = await renderNodes(shadowedCard({
    blur: 0,
    color: { color: "#000000", opacity: 1 },
    "offset-x": 0,
    "offset-y": 40,
    spread: 0,
    style: "drop-shadow",
  }));
  assert.ok(ink(180, 220) > 0.95);
  assert.deepEqual(diagnostics.map(({ code }) => code), []);
});

test("shadow spread grows and shrinks the shadow shape", async () => {
  const base = { blur: 0, color: "#000000", offsetX: 0, offsetY: 0 };
  const grown = await renderNodes(shadowedCard({ ...base, spread: 10 }));
  // The card spans x 80..280; a 10px spread reaches x 70.
  assert.ok(grown.ink(74, 150) > 0.95, `grown: ${grown.ink(74, 150)}`);
  assert.ok(grown.ink(180, 200) > 0.95);
  assert.equal(grown.ink(66, 150), 0);
  const plain = await renderNodes(shadowedCard({ ...base, spread: 0 }));
  assert.equal(plain.ink(74, 150), 0);
  const shrunk = await renderNodes(shadowedCard({
    ...base,
    offsetY: 120,
    spread: -10,
  }));
  // Shifted below the card: y 216..316, shrunk to x 90..270, y 226..306.
  assert.ok(shrunk.ink(180, 260) > 0.95);
  assert.equal(shrunk.ink(85, 260), 0);
  assert.equal(shrunk.ink(180, 220), 0);
});

test("shadow blur is a CSS blur radius: Gaussian sigma = blur / 2", async () => {
  const { ink } = await renderNodes(shadowedCard({
    blur: 8,
    color: "#000000",
    offsetX: 0,
    offsetY: 0,
    spread: 0,
  }));
  const sigma = 4;
  let worst = 0;
  // Across the left edge (x = 80) at the card's vertical middle.
  for (let x = 66; x <= 94; x += 1) {
    const expected = normalCdf((x + 0.5 - 80) / sigma);
    worst = Math.max(worst, Math.abs(ink(x, 146) - expected));
  }
  assert.ok(worst < 0.05, `largest deviation from sigma 4: ${worst}`);
  // Nothing beyond about three sigma.
  assert.ok(ink(64, 146) < 0.01, `far tail: ${ink(64, 146)}`);
});

test("a shadow inside a clipping frame does not paint outside the frame", async () => {
  const { ink } = await renderNodes(
    {
      node_clip: {
        children: ["node_card"],
        fills: [],
        height: 100,
        id: "node_clip",
        name: "Clip",
        "show-content": false,
        type: "FRAME",
        width: 200,
        x: 80,
        y: 96,
      },
      node_card: {
        children: [],
        fills: [{ color: "#ffffff", opacity: 0.01, type: "solid" }],
        height: 60,
        id: "node_card",
        name: "Card",
        shadow: [{ blur: 0, color: "#000000", offsetX: 0, offsetY: 60, spread: 0 }],
        type: "RECTANGLE",
        width: 160,
        x: 20,
        y: 20,
      },
    },
    ["node_clip"],
  );
  // The shadow spans frame-relative y 80..140; the frame ends at y 100.
  assert.ok(ink(180, 186) > 0.95, `inside the frame: ${ink(180, 186)}`);
  for (const y of [196, 200, 210, 230]) {
    assert.equal(ink(180, y), 0, `outside the frame at y ${y}`);
  }
});

for (const [label, extra] of [
  ["ellipse", { type: "ELLIPSE" }],
  ["fully rounded rectangle", { cornerRadius: 999, type: "RECTANGLE" }],
]) {
  test(`a 1px ring on a 24px ${label} is antialiased and continuous`, async () => {
    const { ink } = await renderNodes({
      node_avatar: {
        children: [],
        fills: [],
        height: 24,
        id: "node_avatar",
        name: "Avatar",
        strokes: [{ color: "#000000", type: "solid", width: 1 }],
        width: 24,
        x: 100,
        y: 100,
        ...extra,
      },
    });
    let partial = 0;
    for (let y = 98; y < 126; y += 1) {
      for (let x = 98; x < 126; x += 1) {
        const value = ink(x, y);
        if (value > 0.05 && value < 0.95) partial += 1;
      }
    }
    assert.ok(partial >= 16, `edge pixels with partial coverage: ${partial}`);
    // Sampled along the ring's centreline, every pixel carries ink.
    for (let step = 0; step < 360; step += 1) {
      const angle = (step * Math.PI) / 180;
      const x = Math.floor(112 + Math.cos(angle) * 11.5);
      const y = Math.floor(112 + Math.sin(angle) * 11.5);
      assert.ok(ink(x, y) > 0.2, `gap at ${step} degrees (${x}, ${y}): ${ink(x, y)}`);
    }
    // The interior and the outside stay clear.
    assert.equal(ink(112, 112), 0);
    assert.equal(ink(96, 112), 0);
  });
}

// Reference values: Chromium rendering Penpot's drop-shadow filter markup
// with its result/in2 attributes present (CSS-equivalent output) for a
// 300x150 white rect with {offsetX:0, offsetY:4, blur:12, color:"#00000026"}
// on white, sampled 0-10px below the rect and 0-10px right of it, 70px above
// its bottom.
const SVG_BELOW = [0.11, 0.098, 0.09, 0.078, 0.071, 0.059, 0.051, 0.039, 0.031, 0.024, 0.02];
const SVG_RIGHT = [0.071, 0.059, 0.051, 0.039, 0.031, 0.024, 0.02, 0.012, 0.008, 0.008, 0.004];

test("a drop shadow matches the SVG drop-shadow filter within 0.02", async () => {
  const { ink } = await renderNodes({
    node_card: {
      children: [],
      fills: [{ color: "#ffffff", type: "solid" }],
      height: 150,
      id: "node_card",
      name: "Card",
      shadow: [{ blur: 12, color: "#00000026", offsetX: 0, offsetY: 4, spread: 0 }],
      type: "RECTANGLE",
      width: 300,
      x: 20,
      y: 20,
    },
  });
  SVG_BELOW.forEach((expected, index) => {
    const actual = ink(170, 170 + index);
    assert.ok(Math.abs(actual - expected) < 0.02, `below +${index}: ${actual} vs ${expected}`);
  });
  SVG_RIGHT.forEach((expected, index) => {
    const actual = ink(320 + index, 100);
    assert.ok(Math.abs(actual - expected) < 0.02, `right +${index}: ${actual} vs ${expected}`);
  });
});

test("every drop shadow is drawn and the first one is on top, as in CSS", async () => {
  const red = { blur: 0, color: "#ff0000", offsetX: 0, offsetY: 30, spread: 0 };
  const blue = { blur: 0, color: "#0000ff", offsetX: 0, offsetY: 40, spread: 0 };
  const { diagnostics, pixel } = await renderNodes(shadowedCard([red, blue]));
  // The card spans y 96-196: red covers 126-226, blue 136-236.
  assert.deepEqual(pixel(180, 210).slice(0, 3), [255, 0, 0], "red (first) is on top");
  assert.deepEqual(pixel(180, 230).slice(0, 3), [0, 0, 255], "blue (second) shows below it");
  assert.equal(diagnostics.some(({ code }) => code === "penpot_shadow_not_drawn"), false);
});

test("a shape that paints nothing casts no shadow, as in SVG", async () => {
  const shadow = { blur: 0, color: "#000000", offsetX: 0, offsetY: 30, spread: 0 };
  const bare = await renderNodes(shadowedCard(shadow, { fills: [] }));
  assert.equal(bare.ink(180, 210), 0);
  const invisible = await renderNodes(shadowedCard(shadow, {
    fills: [{ color: "#ffffff", opacity: 0, type: "solid" }],
  }));
  assert.equal(invisible.ink(180, 210), 0);
  const stroked = await renderNodes(shadowedCard(shadow, {
    fills: [],
    strokes: [{ color: "#000000", type: "solid", width: 1 }],
  }));
  assert.ok(stroked.ink(180, 210) > 0.9);
});

test("a small blur uses a true Gaussian, not boxes rounded to nothing", async () => {
  const { ink } = await renderNodes(shadowedCard({
    blur: 2,
    color: "#000000",
    offsetX: 0,
    offsetY: 0,
    spread: 0,
  }));
  // sigma 1 across the left edge at x = 80.
  for (const x of [77, 78, 79, 80, 81]) {
    const expected = normalCdf((x + 0.5 - 80) / 1);
    assert.ok(Math.abs(ink(x, 146) - expected) < 0.03, `x ${x}: ${ink(x, 146)} vs ${expected}`);
  }
});
