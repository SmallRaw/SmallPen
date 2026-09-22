import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { deflateSync, inflateSync } from "node:zlib";

import {
  listPackageEntries,
  loadPackageFromValues,
  readDesignView,
  sha256Hex,
} from "@smallpen/core";
import { createEvidence } from "@smallpen/local-package";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "roundtrip.smallpen");

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function encodeTestPng(width, height, colorAt) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * (width * 4 + 1)] = 0;
    for (let column = 0; column < width; column += 1) {
      const [r, g, b, a = 255] = colorAt(column, row);
      const offset = row * (width * 4 + 1) + 1 + column * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk("IHDR", header),
      pngChunk("IDAT", deflateSync(raw, { level: 9 })),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

// Minimal GIF writer emitting literal LZW codes (periodic clear codes keep the
// code width at its minimum), enough to exercise the decoder deterministically.
function encodeTestGif(width, height, colorIndexAt, palette) {
  const minCodeSize = 2;
  const clearCode = 4;
  const endCode = 5;
  const tableSize = 2 ** (minCodeSize + 1);
  const paddedPalette = [...palette];
  while (paddedPalette.length < tableSize) paddedPalette.push([0, 0, 0]);
  const bytes = [];
  let bitCursor = 0;
  let current = 0;
  const pushCode = (code) => {
    current |= code << bitCursor;
    bitCursor += minCodeSize + 1;
    while (bitCursor >= 8) {
      bytes.push(current & 0xff);
      current >>= 8;
      bitCursor -= 8;
    }
  };
  pushCode(clearCode);
  let sinceClear = 0;
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      pushCode(colorIndexAt(column, row));
      sinceClear += 1;
      // Reset before the decoder's code width would grow (it adds a dictionary
      // entry from each consecutive literal pair).
      if (sinceClear >= 2) {
        pushCode(clearCode);
        sinceClear = 0;
      }
    }
  }
  pushCode(endCode);
  if (bitCursor > 0) bytes.push(current & 0xff);
  const data = Buffer.from(bytes);
  const subBlocks = [];
  for (let offset = 0; offset < data.length; offset += 255) {
    const slice = data.subarray(offset, offset + 255);
    subBlocks.push(Buffer.from([slice.length]), slice);
  }
  subBlocks.push(Buffer.from([0]));
  const paletteData = Buffer.alloc(paddedPalette.length * 3);
  for (const [index, [r, g, b]] of paddedPalette.entries()) {
    paletteData[index * 3] = r;
    paletteData[index * 3 + 1] = g;
    paletteData[index * 3 + 2] = b;
  }
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(width, 0);
  screen.writeUInt16LE(height, 2);
  screen[4] = 0x80 | 0x10 | minCodeSize;
  const descriptor = Buffer.alloc(9);
  descriptor.writeUInt16LE(width, 4);
  descriptor.writeUInt16LE(height, 6);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from("GIF89a", "ascii"),
      screen,
      paletteData,
      Buffer.from([0x2c]),
      descriptor,
      Buffer.from([minCodeSize]),
      ...subBlocks,
      Buffer.from([0x3b]),
    ]),
  );
}

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

async function snapshotWith(values) {
  return loadPackageFromValues("memory://renderer-fixes.smallpen", values);
}

function screenNodes(values) {
  return values.get("screens/roundtrip.json").presentations[0].nodes;
}

function pngPixels(bytes, width) {
  const chunks = [];
  let offset = 8;
  const buffer = Buffer.from(bytes);
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.slice(offset + 4, offset + 8).toString("ascii");
    if (type === "IDAT") chunks.push(buffer.slice(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  return inflateSync(Buffer.concat(chunks));
}

function pngPixel(bytes, width, x, y) {
  const pixels = pngPixels(bytes, width);
  const row = y * (width * 4 + 1);
  return [...pixels.slice(row + 1 + x * 4, row + 1 + x * 4 + 4)];
}

function regionHasColor(bytes, width, bounds, target, tolerance = 12) {
  const pixels = pngPixels(bytes, width);
  for (let y = bounds.top; y < bounds.bottom; y += 1) {
    const row = y * (width * 4 + 1);
    for (let x = bounds.left; x < bounds.right; x += 1) {
      const offset = row + 1 + x * 4;
      const sample = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
      if (
        Math.abs(sample[0] - target[0]) <= tolerance &&
        Math.abs(sample[1] - target[1]) <= tolerance &&
        Math.abs(sample[2] - target[2]) <= tolerance
      ) {
        return true;
      }
    }
  }
  return false;
}

function mutateNodes(values, mutate) {
  mutate(values.get("screens/roundtrip.json").presentations[0].nodes);
  return values;
}

test("PATH nodes render pathData geometry instead of a bounding rectangle", async () => {
  const values = await fixtureValues();
  mutateNodes(values, (nodes) => {
    nodes.node_rectangle = {
      children: [],
      fills: [],
      height: 120,
      id: "node_rectangle",
      name: "Flow line",
      pathData: "M 20 60 L 220 60",
      strokes: [{ color: "#ff0000", type: "solid", width: 4 }],
      type: "PATH",
      width: 240,
      x: 80,
      y: 96,
    };
  });
  const horizontal = await createEvidence(await snapshotWith(values), {
    scale: 1,
    selector: { viewFormat: "screenshot" },
  });
  assert.deepEqual(horizontal.render.diagnostics, []);
  // Centerline pixels carry the stroke color.
  assert.deepEqual(pngPixel(horizontal.render.bytes, horizontal.render.width, 200, 156).slice(0, 3), [255, 0, 0]);
  // The bounding-box interior away from the line stays background.
  assert.deepEqual(pngPixel(horizontal.render.bytes, horizontal.render.width, 200, 130), [244, 244, 245, 255]);
  assert.deepEqual(pngPixel(horizontal.render.bytes, horizontal.render.width, 200, 180), [244, 244, 245, 255]);

  // Changing only pathData from horizontal to diagonal must change pixels.
  mutateNodes(values, (nodes) => {
    nodes.node_rectangle.pathData = "M 20 14 L 220 104";
  });
  const diagonal = await createEvidence(await snapshotWith(values), {
    scale: 1,
    selector: { viewFormat: "screenshot" },
  });
  assert.notEqual(horizontal.render.renderHash, diagonal.render.renderHash);
  assert.ok(regionHasColor(diagonal.render.bytes, diagonal.render.width, {
    bottom: 210,
    left: 90,
    right: 330,
    top: 100,
  }, [255, 0, 0], 40));
});

test("PATH stroke caps draw circle markers and triangle arrowheads", async () => {
  const values = await fixtureValues();
  mutateNodes(values, (nodes) => {
    nodes.node_rectangle = {
      children: [],
      fills: [],
      height: 120,
      id: "node_rectangle",
      name: "Arrow line",
      pathData: "M 20 60 L 220 60",
      strokes: [{
        capEnd: "triangle-arrow",
        capStart: "circle-marker",
        color: "#ff0000",
        type: "solid",
        width: 4,
      }],
      type: "PATH",
      width: 240,
      x: 80,
      y: 96,
    };
  });
  const decorated = await createEvidence(await snapshotWith(values), {
    scale: 1,
    selector: { viewFormat: "screenshot" },
  });
  // Marker ink appears above the 4px centerline near both endpoints.
  assert.ok(
    regionHasColor(decorated.render.bytes, decorated.render.width, {
      bottom: 150,
      left: 90,
      right: 110,
      top: 140,
    }, [255, 0, 0], 40),
    "circle marker at the start",
  );
  assert.ok(
    regionHasColor(decorated.render.bytes, decorated.render.width, {
      bottom: 168,
      left: 282,
      right: 302,
      top: 144,
    }, [255, 0, 0], 40),
    "triangle arrow at the end",
  );
  const withoutCaps = await createEvidence(
    await snapshotWith(mutateNodes(values, (nodes) => {
      delete nodes.node_rectangle.strokes[0].capStart;
      delete nodes.node_rectangle.strokes[0].capEnd;
    })),
    { scale: 1, selector: { viewFormat: "screenshot" } },
  );
  assert.notEqual(withoutCaps.render.renderHash, decorated.render.renderHash);
  assert.deepEqual(pngPixel(withoutCaps.render.bytes, withoutCaps.render.width, 100, 142), [244, 244, 245, 255]);
});

test("flex gap and padding reflow child positions and pixels", async () => {
  const values = await fixtureValues();
  mutateNodes(values, (nodes) => {
    nodes.node_rectangle.fills = [];
    nodes.node_canvas.children.push("node_row");
    nodes.node_row = {
      children: ["node_cell_a", "node_cell_b"],
      height: 200,
      id: "node_row",
      layout: "flex",
      "layout-flex-dir": "row",
      "layout-gap": { columnGap: 8, rowGap: 8 },
      "layout-gap-type": "simple",
      "layout-padding": { p1: 8, p2: 8, p3: 8, p4: 8 },
      "layout-padding-type": "simple",
      name: "Row",
      type: "FRAME",
      width: 400,
      x: 80,
      y: 96,
    };
    nodes.node_cell_a = {
      children: [],
      fills: [{ color: "#2563eb", type: "solid" }],
      height: 100,
      id: "node_cell_a",
      name: "Cell A",
      type: "RECTANGLE",
      width: 100,
      x: 0,
      y: 0,
    };
    nodes.node_cell_b = {
      children: [],
      fills: [{ color: "#16a34a", type: "solid" }],
      height: 100,
      id: "node_cell_b",
      name: "Cell B",
      type: "RECTANGLE",
      width: 100,
      x: 0,
      y: 0,
    };
  });
  const narrow = await createEvidence(await snapshotWith(values), {
    scale: 1,
    selector: { viewFormat: "screenshot" },
  });
  // Reflow placed the cells after the 8px padding with an 8px gap.
  const semantic = readDesignView(await snapshotWith(values), {
    selector: { viewFormat: "semantic" },
  });
  const row = semantic.result.root.children.find(({ id }) => id === "node_row");
  const cellA = row.children.find(({ id }) => id === "node_cell_a");
  const cellB = row.children.find(({ id }) => id === "node_cell_b");
  assert.deepEqual(
    [cellA.bounds.x, cellA.bounds.y].map(Math.round),
    [88, 104],
  );
  assert.equal(Math.round(cellB.bounds.x), 196);
  assert.deepEqual(pngPixel(narrow.render.bytes, narrow.render.width, 92, 108).slice(0, 3), [37, 99, 235]);
  assert.deepEqual(pngPixel(narrow.render.bytes, narrow.render.width, 200, 108).slice(0, 3), [22, 163, 74]);

  mutateNodes(values, (nodes) => {
    nodes.node_row["layout-gap"] = { columnGap: 48, rowGap: 48 };
    nodes.node_row["layout-padding"] = { p1: 32, p2: 32, p3: 32, p4: 32 };
  });
  const wide = await createEvidence(await snapshotWith(values), {
    scale: 1,
    selector: { viewFormat: "screenshot" },
  });
  assert.notEqual(narrow.render.renderHash, wide.render.renderHash);
  // With the larger gap/padding the first cell moved right/down.
  assert.deepEqual(pngPixel(wide.render.bytes, wide.render.width, 116, 132).slice(0, 3), [37, 99, 235]);
  assert.deepEqual(pngPixel(wide.render.bytes, wide.render.width, 92, 108), [244, 244, 245, 255]);
});

test("dashed strokes leave measurable gaps against solid strokes", async () => {
  const values = await fixtureValues();
  mutateNodes(values, (nodes) => {
    nodes.node_rectangle = {
      children: [],
      fills: [],
      height: 120,
      id: "node_rectangle",
      name: "Dashed frame",
      strokes: [{
        color: "#ff0000",
        style: "dashed",
        type: "solid",
        width: 4,
      }],
      type: "RECTANGLE",
      width: 240,
      x: 80,
      y: 96,
    };
  });
  const dashed = await createEvidence(await snapshotWith(values), {
    scale: 1,
    selector: { viewFormat: "screenshot" },
  });
  const solid = await createEvidence(
    await snapshotWith(mutateNodes(values, (nodes) => {
      nodes.node_rectangle.strokes[0].style = "solid";
    })),
    { scale: 1, selector: { viewFormat: "screenshot" } },
  );
  assert.notEqual(dashed.render.renderHash, solid.render.renderHash);
  const dashedPixels = pngPixels(dashed.render.bytes, dashed.render.width);
  const solidPixels = pngPixels(solid.render.bytes, solid.render.width);
  const width = dashed.render.width;
  let foundGap = false;
  const y = 96; // Top edge band.
  for (let x = 84; x < 316; x += 1) {
    const offset = y * (width * 4 + 1) + 1 + x * 4;
    const dashedColor = [dashedPixels[offset], dashedPixels[offset + 1], dashedPixels[offset + 2]];
    const solidColor = [solidPixels[offset], solidPixels[offset + 1], solidPixels[offset + 2]];
    if (
      dashedColor.every((channel) => Math.abs(channel - 244) <= 2) &&
      solidColor[0] > 200
    ) {
      foundGap = true;
      break;
    }
  }
  assert.ok(foundGap, "dashed stroke should expose background gaps the solid stroke covers");
});

test("drop shadows put offset blurred ink behind the shape", async () => {
  const values = await fixtureValues();
  mutateNodes(values, (nodes) => {
    nodes.node_rectangle = {
      children: [],
      fills: [{ color: "#2563eb", type: "solid" }],
      height: 120,
      id: "node_rectangle",
      name: "Shadow card",
      shadow: [{
        blur: 8,
        color: "#000000",
        offsetX: 16,
        offsetY: 16,
        style: "drop-shadow",
      }],
      type: "RECTANGLE",
      width: 240,
      x: 80,
      y: 96,
    };
  });
  const withShadow = await createEvidence(await snapshotWith(values), {
    scale: 1,
    selector: { viewFormat: "screenshot" },
  });
  const withoutShadow = await createEvidence(
    await snapshotWith(mutateNodes(values, (nodes) => {
      delete nodes.node_rectangle.shadow;
    })),
    { scale: 1, selector: { viewFormat: "screenshot" } },
  );
  assert.notEqual(withShadow.render.renderHash, withoutShadow.render.renderHash);
  const shadowPixels = pngPixels(withShadow.render.bytes, withShadow.render.width);
  const barePixels = pngPixels(withoutShadow.render.bytes, withoutShadow.render.width);
  const width = withShadow.render.width;
  const sample = (pixels, x, y) => pixels[y * (width * 4 + 1) + 1 + x * 4];
  let darkened = 0;
  for (let x = 210; x < 300; x += 1) {
    for (let y = 225; y < 240; y += 1) {
      if (sample(shadowPixels, x, y) < sample(barePixels, x, y) - 6) darkened += 1;
    }
  }
  assert.ok(darkened > 100, "shadow should darken the offset region");
  assert.deepEqual(pngPixel(withShadow.render.bytes, withShadow.render.width, 60, 150), [244, 244, 245, 255]);
});

test("layer blur and background blur both change the raster", async () => {
  const values = await fixtureValues();
  mutateNodes(values, (nodes) => {
    nodes.node_rectangle = {
      blur: { type: "layer-blur", value: 6 },
      children: [],
      fills: [{ color: "#2563eb", type: "solid" }],
      height: 120,
      id: "node_rectangle",
      name: "Blurred card",
      type: "RECTANGLE",
      width: 240,
      x: 80,
      y: 96,
    };
  });
  const blurred = await createEvidence(await snapshotWith(values), {
    scale: 1,
    selector: { viewFormat: "screenshot" },
  });
  const sharp = await createEvidence(
    await snapshotWith(mutateNodes(values, (nodes) => {
      delete nodes.node_rectangle.blur;
    })),
    { scale: 1, selector: { viewFormat: "screenshot" } },
  );
  assert.notEqual(blurred.render.renderHash, sharp.render.renderHash);
  // A layer-blurred edge is softer: just inside the edge the color is blended.
  assert.notDeepEqual(pngPixel(blurred.render.bytes, blurred.render.width, 82, 156).slice(0, 3), [37, 99, 235]);
  assert.deepEqual(pngPixel(sharp.render.bytes, sharp.render.width, 82, 156).slice(0, 3), [37, 99, 235]);

  // Background blur smears the striped backdrop behind the shape.
  const backdropValues = structuredClone(values);
  mutateNodes(backdropValues, (nodes) => {
    delete nodes.node_rectangle.blur;
    nodes.node_rectangle = {
      children: [],
      fills: [{ color: "#111827", type: "solid" }],
      height: 120,
      id: "node_rectangle",
      name: "Solid card",
      type: "RECTANGLE",
      width: 240,
      x: 80,
      y: 96,
    };
    nodes.node_canvas.children.push("node_glass");
    for (let index = 0; index < 24; index += 1) {
      const id = `node_stripe_${index}`;
      nodes.node_canvas.children.push(id);
      nodes[id] = {
        children: [],
        fills: [{ color: index % 2 ? "#ffffff" : "#000000", type: "solid" }],
        height: 400,
        id,
        name: `Stripe ${index}`,
        type: "RECTANGLE",
        width: 10,
        x: index * 20,
        y: 0,
      };
    }
    nodes.node_glass = {
      backgroundBlur: { type: "background-blur", value: 6 },
      children: [],
      fills: [{ color: "#ffffff", opacity: 0.15, type: "solid" }],
      height: 200,
      id: "node_glass",
      name: "Glass",
      type: "RECTANGLE",
      width: 200,
      x: 40,
      y: 100,
    };
  });
  const withGlass = await createEvidence(await snapshotWith(backdropValues), {
    scale: 1,
    selector: { viewFormat: "screenshot" },
  });
  const withoutGlass = await createEvidence(
    await snapshotWith(mutateNodes(backdropValues, (nodes) => {
      delete nodes.node_glass.backgroundBlur;
    })),
    { scale: 1, selector: { viewFormat: "screenshot" } },
  );
  assert.notEqual(withGlass.render.renderHash, withoutGlass.render.renderHash);
});

test("auto-height text grows the projected bounds and shows the whole sentence", async () => {
  const values = await fixtureValues();
  mutateNodes(values, (nodes) => {
    nodes.node_rectangle = {
      children: [],
      fills: [{ color: "#111827", type: "solid" }],
      growType: "auto-height",
      height: 70,
      id: "node_rectangle",
      name: "Growing text",
      text: "The quick brown fox jumps over the lazy dog again and again",
      textStyle: {
        fontFamily: "sourcesanspro",
        fontId: "sourcesanspro",
        fontSize: 18,
        fontStyle: "normal",
        fontWeight: 400,
        letterSpacing: 0,
        lineHeight: 1.4,
        textAlign: "left",
        verticalAlign: "top",
      },
      type: "TEXT",
      width: 130,
      x: 80,
      y: 96,
    };
  });
  const product = await snapshotWith(values);
  const evidence = await createEvidence(product, {
    scale: 1,
    selector: { viewFormat: "screenshot" },
  });
  const textEntry = evidence.evidence.semanticTree.root.children
    .find((child) => child.id === "node_rectangle");
  assert.ok(textEntry, "semantic tree keeps the text node");
  assert.ok(
    textEntry.bounds.height > 70,
    `auto-height should grow the semantic bounds (got ${textEntry.bounds.height})`,
  );
  assert.equal(
    product.entries["screens/roundtrip.json"].presentations[0].nodes.node_rectangle
      .height,
    70,
    "canonical height stays untouched",
  );
  assert.ok(
    regionHasColor(evidence.render.bytes, evidence.render.width, {
      bottom: 240,
      left: 80,
      right: 210,
      top: 170,
    }, [17, 24, 39], 60),
    "the wrapped sentence draws past the original 70px height",
  );
});

test("masked groups clip overflow and show-content re-exposes it", async () => {
  const values = await fixtureValues();
  mutateNodes(values, (nodes) => {
    nodes.node_rectangle.fills = [];
    nodes.node_canvas.children.push("node_masked_group");
    nodes.node_masked_group = {
      children: ["node_mask_source", "node_mask_content"],
      "masked-group": true,
      height: 100,
      id: "node_masked_group",
      name: "Masked group",
      type: "GROUP",
      width: 180,
      x: 60,
      y: 60,
    };
    nodes.node_mask_source = {
      children: [],
      fills: [{ color: "#ff00ff", type: "solid" }],
      height: 80,
      id: "node_mask_source",
      name: "Mask source",
      type: "RECTANGLE",
      width: 80,
      x: 0,
      y: 0,
    };
    nodes.node_mask_content = {
      children: [],
      fills: [{
        endX: 1,
        endY: 0,
        gradientWidth: 1,
        startX: 0,
        startY: 0,
        stops: [
          { color: "#ff8800", offset: 0 },
          { color: "#22ccff", offset: 1 },
        ],
        type: "linear-gradient",
      }],
      height: 100,
      id: "node_mask_content",
      name: "Overflow content",
      type: "RECTANGLE",
      width: 180,
      x: 0,
      y: 0,
    };
  });
  const masked = await createEvidence(await snapshotWith(values), {
    scale: 1,
    selector: { viewFormat: "screenshot" },
  });
  // Outside the 80x80 mask source the overflowing gradient is clipped to the
  // white background; the mask source itself is not painted (Penpot mask
  // semantics: first child acts only as the clip shape).
  assert.deepEqual(pngPixel(masked.render.bytes, masked.render.width, 150, 100), [244, 244, 245, 255]);
  // Inside the mask area the overflowing content is visible; the mask source
  // itself is not painted.
  assert.deepEqual(pngPixel(masked.render.bytes, masked.render.width, 70, 70).slice(0, 3), [242, 140, 15]);
  assert.ok(
    regionHasColor(masked.render.bytes, masked.render.width, {
      bottom: 130,
      left: 62,
      right: 135,
      top: 62,
    }, [255, 136, 0], 90),
    "content inside the mask area is visible",
  );

  const revealed = await createEvidence(
    await snapshotWith(mutateNodes(values, (nodes) => {
      nodes.node_masked_group["show-content"] = true;
    })),
    { scale: 1, selector: { viewFormat: "screenshot" } },
  );
  assert.notEqual(revealed.render.renderHash, masked.render.renderHash);
  assert.ok(
    regionHasColor(revealed.render.bytes, revealed.render.width, {
      bottom: 130,
      left: 150,
      right: 238,
      top: 62,
    }, [34, 204, 255], 90),
    "overflow content is drawn outside the mask when show-content is true",
  );
});

test("tab characters immediately before a line break draw no ink", async () => {
  const build = async (text) => {
    const values = await fixtureValues();
    mutateNodes(values, (nodes) => {
      nodes.node_rectangle = {
        children: [],
        fills: [{ color: "#111827", type: "solid" }],
        height: 70,
        id: "node_rectangle",
        name: "Whitespace text",
        text,
        textStyle: {
          fontFamily: "sourcesanspro",
          fontId: "sourcesanspro",
          fontSize: 20,
          fontStyle: "normal",
          fontWeight: 400,
          letterSpacing: 0,
          lineHeight: 1.4,
          textAlign: "left",
          verticalAlign: "top",
        },
        type: "TEXT",
        width: 130,
        x: 80,
        y: 96,
      };
    });
    return createEvidence(await snapshotWith(values), {
      scale: 1,
      selector: { viewFormat: "screenshot" },
    });
  };
  const tabbed = await build("H\t\nI");
  const spaced = await build("H \nI");
  assert.deepEqual([...tabbed.render.bytes], [...spaced.render.bytes]);
  assert.deepEqual(tabbed.render.diagnostics, []);
});

test("unsupported glyphs surface a locatable diagnostic instead of silent tofu", async () => {
  const build = async (text) => {
    const values = await fixtureValues();
    mutateNodes(values, (nodes) => {
      nodes.node_rectangle = {
        children: [],
        fills: [{ color: "#111827", type: "solid" }],
        height: 70,
        id: "node_rectangle",
        name: "Glyph text",
        text,
        textStyle: {
          fontFamily: "sourcesanspro",
          fontId: "sourcesanspro",
          fontSize: 20,
          fontStyle: "normal",
          fontWeight: 400,
          letterSpacing: 0,
          lineHeight: 1.4,
          textAlign: "left",
          verticalAlign: "top",
        },
        type: "TEXT",
        width: 200,
        x: 80,
        y: 96,
      };
    });
    return createEvidence(await snapshotWith(values), {
      scale: 1,
      selector: { viewFormat: "screenshot" },
    });
  };
  const emoji = await build("Greeting \u{1F600}");
  const missingCodes = emoji.render.diagnostics.filter(
    (diagnostic) => diagnostic.code === "text_missing_glyph",
  );
  assert.equal(missingCodes.length, 1);
  assert.match(missingCodes[0].message, /U\+1F600/);
  assert.equal(missingCodes[0].nodeId, "node_rectangle");
  const plain = await build("Greeting");
  assert.deepEqual(plain.render.diagnostics, []);
});

test("imported PNG media renders real pixels", async () => {
  const values = await fixtureValues();
  const quadrant = encodeTestPng(8, 8, (x, y) => {
    const red = x < 4;
    const top = y < 4;
    if (red && top) return [255, 0, 0];
    if (!red && top) return [0, 255, 0];
    if (red && !top) return [0, 0, 255];
    return [255, 255, 0];
  });
  const sha256 = await sha256Hex(quadrant);
  values.get("manifest.json").entries.assets = ["assets/media.json"];
  values.set("assets/media.json", {
    colors: [],
    fonts: [],
    id: "alib_media",
    media: [{
      blob: `blobs/${sha256}`,
      byteLength: quadrant.byteLength,
      height: 8,
      id: "media_png_quadrant",
      mimeType: "image/png",
      name: "quadrant.png",
      path: "Images",
      sha256,
      width: 8,
    }],
    typographies: [],
  });
  values.set(`blobs/${sha256}`, quadrant);
  mutateNodes(values, (nodes) => {
    nodes.node_rectangle = {
      children: [],
      fills: [],
      height: 160,
      id: "node_rectangle",
      mediaRef: "media_png_quadrant",
      name: "Quadrant image",
      type: "IMAGE",
      width: 160,
      x: 80,
      y: 96,
    };
  });
  const evidence = await createEvidence(await snapshotWith(values), {
    scale: 1,
    selector: { viewFormat: "screenshot" },
  });
  assert.deepEqual(evidence.render.diagnostics, []);
  const width = evidence.render.width;
  assert.deepEqual(pngPixel(evidence.render.bytes, width, 100, 116).slice(0, 3), [255, 0, 0]);
  assert.deepEqual(pngPixel(evidence.render.bytes, width, 220, 116).slice(0, 3), [0, 255, 0]);
  assert.deepEqual(pngPixel(evidence.render.bytes, width, 100, 236).slice(0, 3), [0, 0, 255]);
  assert.deepEqual(pngPixel(evidence.render.bytes, width, 220, 236).slice(0, 3), [255, 255, 0]);
});

test("imported JPEG media renders real pixels", async () => {
  const values = await fixtureValues();
  const bytes = new Uint8Array(await readFile(join(here, "fixtures", "quadrant.jpg")));
  const sha256 = await sha256Hex(bytes);
  values.get("manifest.json").entries.assets = ["assets/media.json"];
  values.set("assets/media.json", {
    colors: [],
    fonts: [],
    id: "alib_media",
    media: [{
      blob: `blobs/${sha256}`,
      byteLength: bytes.byteLength,
      height: 8,
      id: "media_jpeg_quadrant",
      mimeType: "image/jpeg",
      name: "quadrant.jpg",
      path: "Images",
      sha256,
      width: 8,
    }],
    typographies: [],
  });
  values.set(`blobs/${sha256}`, bytes);
  mutateNodes(values, (nodes) => {
    nodes.node_rectangle = {
      children: [],
      fills: [],
      height: 160,
      id: "node_rectangle",
      mediaRef: "media_jpeg_quadrant",
      name: "Quadrant photo",
      type: "IMAGE",
      width: 160,
      x: 80,
      y: 96,
    };
  });
  const evidence = await createEvidence(await snapshotWith(values), {
    scale: 1,
    selector: { viewFormat: "screenshot" },
  });
  assert.deepEqual(
    evidence.render.diagnostics.filter((diagnostic) => diagnostic.code === "media_decode_failed"),
    [],
  );
  const width = evidence.render.width;
  const center = (x, y) => pngPixel(evidence.render.bytes, width, x, y).slice(0, 3);
  const [r, g, b] = center(100, 116);
  assert.ok(r > 180 && g < 90 && b < 90, `top-left quadrant should be red, got ${r},${g},${b}`);
  const [r2, g2, b2] = center(220, 116);
  assert.ok(g2 > 150 && r2 < 120, `top-right quadrant should be green, got ${r2},${g2},${b2}`);
  const [r3, g3, b3] = center(100, 236);
  assert.ok(b3 > 150 && r3 < 120, `bottom-left quadrant should be blue, got ${r3},${g3},${b3}`);
  const [r4, g4, b4] = center(220, 236);
  assert.ok(r4 > 180 && g4 > 150 && b4 < 120, `bottom-right quadrant should be yellow, got ${r4},${g4},${b4}`);
});

test("imported GIF media renders its first frame", async () => {
  const values = await fixtureValues();
  const gif = encodeTestGif(4, 4, (x) => (x < 2 ? 0 : 1), [
    [255, 0, 0],
    [0, 0, 255],
  ]);
  const sha256 = await sha256Hex(gif);
  values.get("manifest.json").entries.assets = ["assets/media.json"];
  values.set("assets/media.json", {
    colors: [],
    fonts: [],
    id: "alib_media",
    media: [{
      blob: `blobs/${sha256}`,
      byteLength: gif.byteLength,
      height: 4,
      id: "media_gif_frames",
      mimeType: "image/gif",
      name: "frames.gif",
      path: "Images",
      sha256,
      width: 4,
    }],
    typographies: [],
  });
  values.set(`blobs/${sha256}`, gif);
  mutateNodes(values, (nodes) => {
    nodes.node_rectangle = {
      children: [],
      fills: [],
      height: 80,
      id: "node_rectangle",
      mediaRef: "media_gif_frames",
      name: "Frame image",
      type: "IMAGE",
      width: 80,
      x: 80,
      y: 96,
    };
  });
  const evidence = await createEvidence(await snapshotWith(values), {
    scale: 1,
    selector: { viewFormat: "screenshot" },
  });
  assert.deepEqual(
    evidence.render.diagnostics.filter(
      (diagnostic) => diagnostic.code === "media_decode_failed",
    ),
    [],
  );
  const width = evidence.render.width;
  assert.deepEqual(pngPixel(evidence.render.bytes, width, 100, 116).slice(0, 3), [255, 0, 0]);
  assert.deepEqual(pngPixel(evidence.render.bytes, width, 140, 116).slice(0, 3), [0, 0, 255]);
});

test("SVG media rasterizes compound paths and curved commands", async () => {
  const values = await fixtureValues();
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#ff00ff"/>
  <path fill="#00e5ff" d="M 20 20 L 80 20 L 80 80 L 20 80 Z M 40 40 L 40 60 L 60 60 L 60 40 Z"/>
  <path stroke="#000000" stroke-width="4" fill="none" d="M 10 90 C 30 70, 50 110, 90 90"/>
</svg>`, "utf8");
  const sha256 = await sha256Hex(svg);
  values.get("manifest.json").entries.assets = ["assets/media.json"];
  values.set("assets/media.json", {
    colors: [],
    fonts: [],
    id: "alib_media",
    media: [{
      blob: `blobs/${sha256}`,
      byteLength: svg.byteLength,
      height: 100,
      id: "media_svg_compound",
      mimeType: "image/svg+xml",
      name: "compound.svg",
      path: "Images",
      sha256,
      width: 100,
    }],
    typographies: [],
  });
  values.set(`blobs/${sha256}`, svg);
  mutateNodes(values, (nodes) => {
    nodes.node_rectangle = {
      children: [],
      fills: [],
      height: 100,
      id: "node_rectangle",
      mediaRef: "media_svg_compound",
      name: "Compound image",
      type: "IMAGE",
      width: 100,
      x: 80,
      y: 96,
    };
  });
  const evidence = await createEvidence(await snapshotWith(values), {
    scale: 1,
    selector: { viewFormat: "screenshot" },
  });
  assert.deepEqual(
    evidence.render.diagnostics.filter(
      (diagnostic) => diagnostic.code === "unsupported_svg_path",
    ),
    [],
    "curved SVG path commands must rasterize",
  );
  const width = evidence.render.width;
  // Donut center exposes the magenta backdrop through the hole.
  assert.deepEqual(pngPixel(evidence.render.bytes, width, 130, 146).slice(0, 3), [255, 0, 255]);
  // The ring band is cyan.
  assert.deepEqual(pngPixel(evidence.render.bytes, width, 130, 126).slice(0, 3), [0, 229, 255]);
  // The curved stroke draws black ink near its midpoint.
  assert.ok(
    regionHasColor(evidence.render.bytes, width, {
      bottom: 196,
      left: 115,
      right: 165,
      top: 176,
    }, [0, 0, 0], 60),
  );
});

test("semantic views expose presentation interactions", async () => {
  const values = await fixtureValues();
  const screen = values.get("screens/roundtrip.json");
  const manifest = values.get("manifest.json");
  screen.presentations[0].interactions = [{
    action: {
      presentationId: "pres_desktop",
      screen: manifest.packageId ? { assetId: "scr_roundtrip", packageId: manifest.packageId } : "scr_roundtrip",
      type: "navigate",
    },
    id: "int_roundtrip_1",
    name: "Open detail",
    sourceNodeId: "node_rectangle",
    trigger: "activate",
  }];
  const product = await snapshotWith(values);
  const read = readDesignView(product, {
    selector: { viewFormat: "semantic" },
  });
  const interactions = read.result.interactions ?? [];
  assert.equal(interactions.length, 1);
  assert.equal(interactions[0].id, "int_roundtrip_1");
  assert.equal(interactions[0].trigger, "activate");
  assert.equal(interactions[0].sourceNodeId, "node_rectangle");
  assert.equal(interactions[0].action.type, "navigate");
  assert.equal(interactions[0].action.screen.assetId, "scr_roundtrip");
});

// SP-031-B/C: imported WebP media renders real pixels (lossless + lossy),
// including alpha; corrupt WebP falls back to the typed placeholder path.
test("imported WebP media renders real pixels including alpha (SP-031-B/C)", async () => {
  const importWebp = async (values, file, id) => {
    const bytes = new Uint8Array(await readFile(file));
    const sha256 = await sha256Hex(bytes);
    values.get("manifest.json").entries.assets = ["assets/media.json"];
    values.set("assets/media.json", {
      colors: [],
      fonts: [],
      id: "alib_media",
      media: [{
        blob: `blobs/${sha256}`,
        byteLength: bytes.byteLength,
        height: 4,
        id,
        mimeType: "image/webp",
        name: id,
        path: "Images",
        sha256,
        width: 32,
      }],
      typographies: [],
    });
    values.set(`blobs/${sha256}`, bytes);
    mutateNodes(values, (nodes) => {
      nodes.node_rectangle = {
        children: [],
        fills: [],
        height: 80,
        id: "node_rectangle",
        mediaRef: id,
        name: "WebP image",
        type: "IMAGE",
        width: 80,
        x: 80,
        y: 96,
      };
    });
    return snapshotWith(values);
  };
  const { deflateSync } = await import("node:zlib");
  void deflateSync;

  const values = await fixtureValues();
  const product = await importWebp(
    values,
    join(here, "fixtures", "quadrant-alpha.webp"),
    "media_webp_alpha",
  );
  const evidence = await createEvidence(product, {
    scale: 1,
    selector: { viewFormat: "screenshot" },
  });
  assert.deepEqual(
    evidence.render.diagnostics.filter((d) => d.code === "media_decode_unsupported"),
    [],
    "webp decodes without the unsupported fallback",
  );
  const width = evidence.render.width;
  // Quadrant centers (node 80px at 80,96; image pixel = 20 screen px):
  // red / green / semi-transparent blue over canvas / transparent over canvas.
  const px = (x, y) => pngPixel(evidence.render.bytes, width, x, y);
  assert.deepEqual(px(100, 116).slice(0, 3), [255, 0, 0]);
  assert.deepEqual(px(140, 116).slice(0, 3), [0, 255, 0]);
  // Semi-transparent blue (128 alpha) blended over the canvas background.
  const translucentBlue = px(100, 156);
  assert.ok(
    translucentBlue[2] > 140 && translucentBlue[0] < 140,
    `blue quadrant blends over background: ${translucentBlue}`,
  );
  // Fully transparent yellow over canvas shows the canvas color.
  assert.deepEqual(px(140, 156), [244, 244, 245, 255]);

  // Lossy WebP decodes to approximately correct quadrant colors.
  const lossyValues = await fixtureValues();
  const lossyPath = join(here, "fixtures", "quadrant-lossy.webp");
  const bytes = new Uint8Array(await readFile(lossyPath));
  const sha256 = await sha256Hex(bytes);
  lossyValues.get("manifest.json").entries.assets = ["assets/media.json"];
  lossyValues.set("assets/media.json", {
    colors: [],
    fonts: [],
    id: "alib_media2",
    media: [{
      blob: `blobs/${sha256}`,
      byteLength: bytes.byteLength,
      height: 4,
      id: "media_webp_lossy",
      mimeType: "image/webp",
      name: "lossy.webp",
      path: "Images",
      sha256,
      width: 4,
    }],
    typographies: [],
  });
  lossyValues.set(`blobs/${sha256}`, bytes);
  mutateNodes(lossyValues, (nodes) => {
    nodes.node_rectangle = {
      children: [],
      fills: [],
      height: 80,
      id: "node_rectangle",
      mediaRef: "media_webp_lossy",
      name: "Lossy image",
      type: "IMAGE",
      width: 80,
      x: 80,
      y: 96,
    };
  });
  const lossy = await createEvidence(await snapshotWith(lossyValues), {
    scale: 1,
    selector: { viewFormat: "screenshot" },
  });
  const w = lossy.render.width;
  const tl = pngPixel(lossy.render.bytes, w, 100, 116).slice(0, 3);
  assert.ok(tl[0] > 180 && tl[1] < 90, `lossy top-left red: ${tl}`);
  const br = pngPixel(lossy.render.bytes, w, 140, 156).slice(0, 3);
  assert.ok(br[0] > 180 && br[1] > 180 && br[2] < 120, `lossy bottom-right yellow: ${br}`);
});

// NOTE: quadrant-alpha.webp / quadrant-lossy.webp are committed test fixtures.

test("hide-fill-on-export suppresses fill ink in the export render (SP-DES-011-B)", async () => {
  const values = await fixtureValues();
  mutateNodes(values, (nodes) => {
    nodes.node_rectangle = {
      children: [],
      fills: [{ color: "#2563eb", type: "solid" }],
      "hide-fill-on-export": true,
      height: 120,
      id: "node_rectangle",
      name: "Export-hidden fill",
      strokes: [{ color: "#111827", type: "solid", width: 2 }],
      type: "RECTANGLE",
      width: 240,
      x: 80,
      y: 96,
    };
  });
  const evidence = await createEvidence(await snapshotWith(values), {
    scale: 1,
    selector: { viewFormat: "screenshot" },
  });
  const w = evidence.render.width;
  const center = pngPixel(evidence.render.bytes, w, 200, 156).slice(0, 3);
  assert.ok(
    Math.abs(center[0] - 244) < 6 && Math.abs(center[2] - 245) < 6,
    `fill must be suppressed on export (background expected), got ${center}`,
  );
  const controlValues = await fixtureValues();
  mutateNodes(controlValues, (nodes) => {
    nodes.node_rectangle = {
      ...nodes.node_rectangle,
      "hide-fill-on-export": false,
    };
  });
  const control = await createEvidence(await snapshotWith(controlValues), {
    scale: 1,
    selector: { viewFormat: "screenshot" },
  });
  const controlCenter = pngPixel(control.render.bytes, w, 200, 156).slice(0, 3);
  assert.ok(
    Math.abs(controlCenter[0] - 0x7c) < 20 && Math.abs(controlCenter[2] - 0xed) < 20,
    `control keeps the fill, got ${controlCenter}`,
  );
});

test("round and square line caps extend PATH stroke endpoints (SP-052)", async () => {
  const values = await fixtureValues();
  mutateNodes(values, (nodes) => {
    nodes.node_rectangle = {
      children: [],
      fills: [],
      height: 120,
      id: "node_rectangle",
      name: "Capped line",
      pathData: "M 20 60 L 220 60",
      strokes: [
        {
          capStart: "round",
          capEnd: "square",
          color: "#ff0000",
          style: "solid",
          type: "solid",
          width: 6,
        },
      ],
      type: "PATH",
      width: 240,
      x: 80,
      y: 96,
    };
  });
  const capped = await createEvidence(await snapshotWith(values), {
    scale: 1,
    selector: { viewFormat: "screenshot" },
  });
  const w = capped.render.width;
  // Round cap at start (x=100): ink extends to ~x=97 (3px半圆), y=156.
  const left = pngPixel(capped.render.bytes, w, 98, 156).slice(0, 3);
  assert.ok(left[0] > 180 && left[1] < 90, `round cap ink left of start: ${left}`);
  // Square cap at end (x=300): ink extends to ~x=303, y=156.
  const right = pngPixel(capped.render.bytes, w, 302, 156).slice(0, 3);
  assert.ok(right[0] > 180 && right[1] < 90, `square cap ink past end: ${right}`);
});

test("FRAME with show-content false clips children to rounded bounds (SP-052)", async () => {
  const values = await fixtureValues();
  mutateNodes(values, (nodes) => {
    nodes.node_canvas.children.push("node_clip_frame");
    nodes.node_clip_frame = {
      cornerRadius: [40, 40, 40, 40],
      children: ["node_clip_child"],
      fills: [{ color: "#1d4ed8", type: "solid" }],
      height: 120,
      id: "node_clip_frame",
      name: "Clip Frame",
      "show-content": false,
      type: "FRAME",
      width: 120,
      x: 480,
      y: 300,
    };
    nodes.node_clip_child = {
      children: [],
      fills: [{ color: "#fbbf24", type: "solid" }],
      height: 200,
      id: "node_clip_child",
      name: "Clip Child",
      // Frame-relative coords: the child protrudes 80px right/below.
      type: "RECTANGLE",
      width: 200,
      x: 0,
      y: 0,
    };
  });
  const clipped = await createEvidence(await snapshotWith(values), {
    scale: 1,
    selector: { viewFormat: "screenshot" },
  });
  const w = clipped.render.width;
  const bg = [244, 244, 245, 255];
  // Beyond the frame bounds the child must not ink (clipped).
  const outside = pngPixel(clipped.render.bytes, w, 620, 400).slice(0, 3);
  assert.deepEqual(outside, bg.slice(0, 3).map((v) => v));
  // Inside the rounded corner region (corner at 480,300 radius 40) no ink.
  const corner = pngPixel(clipped.render.bytes, w, 484, 304).slice(0, 3);
  assert.deepEqual(corner, bg.slice(0, 3).map((v) => v));
  // Center of the frame shows the child ink (child covers the frame center).
  const center = pngPixel(clipped.render.bytes, w, 540, 360).slice(0, 3);
  assert.ok(center[0] > 200 && center[2] < 120, `child ink inside: ${center}`);
});
