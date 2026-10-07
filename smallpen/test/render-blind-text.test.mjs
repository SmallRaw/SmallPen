// The Penpot editor reads a text lineHeight as a multiple of the font size
// whatever its value; the CLI used to read values above 4 as pixels, so a
// lineHeight of 6 drew lines 6 px apart in the CLI and 60 px in Penpot.
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

async function inkRows(lineHeight) {
  const manifest = JSON.parse(await readFile(join(fixture, "manifest.json"), "utf8"));
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of listPackageEntries(manifest).entries) {
    values.set(entry, JSON.parse(await readFile(join(fixture, entry), "utf8")));
  }
  const nodes = values.get("screens/roundtrip.json").presentations[0].nodes;
  nodes.node_rectangle = {
    children: [],
    fills: [{ color: "#000000", type: "solid" }],
    growType: "fixed",
    height: 200,
    id: "node_rectangle",
    name: "Two lines",
    text: "H\nH",
    textStyle: { fontFamily: "Source Sans Pro", fontSize: 10, lineHeight },
    type: "TEXT",
    width: 100,
    x: 100,
    y: 100,
  };
  const { render } = await createEvidence(
    await loadPackageFromValues("memory://render-blind-text.smallpen", values),
    { scale: 1, selector: { viewFormat: "screenshot" } },
  );
  const chunks = [];
  const buffer = Buffer.from(render.bytes);
  for (let offset = 8; offset < buffer.length; ) {
    const length = buffer.readUInt32BE(offset);
    if (buffer.toString("ascii", offset + 4, offset + 8) === "IDAT") {
      chunks.push(buffer.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }
  const pixels = inflateSync(Buffer.concat(chunks));
  const rows = [];
  for (let y = 100; y < 300; y += 1) {
    for (let x = 100; x < 200; x += 1) {
      const offset = y * (render.width * 4 + 1) + 1 + x * 4;
      if (pixels[offset] < 120) {
        rows.push(y - 100);
        break;
      }
    }
  }
  return rows;
}

test("lineHeight is a multiple of the font size even above 4", async () => {
  const rows = await inkRows(6);
  // Two 10 px lines 60 px apart: ink in the first and the second line box
  // and nothing between them.
  assert.ok(rows.some((row) => row < 60), `first line ink rows ${rows}`);
  assert.ok(rows.some((row) => row >= 60 && row < 120), `second line ink rows ${rows}`);
  assert.ok(!rows.some((row) => row >= 40 && row < 60), `nothing between the lines ${rows}`);
  const tight = await inkRows(1.2);
  assert.ok(Math.max(...tight) < 30, `1.2 keeps lines 12 px apart ${tight}`);
});
