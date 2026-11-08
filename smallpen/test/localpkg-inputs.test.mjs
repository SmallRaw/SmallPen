import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { deflateSync } from "node:zlib";

import {
  listPackageEntries,
  loadPackageFromValues,
  sha256Hex,
} from "@smallpen/core";
import {
  createEvidence,
} from "@smallpen/local-package";
import { readModelEntry } from "./helpers/named.mjs";


const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "model", "roundtrip");
const localPackageRoot = join(here, "..", "packages", "local-package");

async function fixtureValues(edit = () => {}) {
  const manifest = await readModelEntry(fixture, "manifest.json");
  edit(manifest);
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of listPackageEntries(manifest).entries) {
    values.set(entry, JSON.parse(await readFile(join(fixture, entry), "utf8")));
  }
  return values;
}

// --- Remote Library requests (M5) -----------------------------------------

// --- Kiwi clipboard schema (M6) -------------------------------------------

// --- Raster decode limits (M7) --------------------------------------------

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

function png(width, height, raw) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk("IHDR", header),
      pngChunk("IDAT", deflateSync(raw)),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

function gif(width, height) {
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(width, 0);
  screen.writeUInt16LE(height, 2);
  return new Uint8Array(
    Buffer.concat([Buffer.from("GIF89a", "ascii"), screen, Buffer.from([0x3b])]),
  );
}

function jpeg(width, height) {
  const sof = Buffer.from([
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    height >> 8, height & 0xff, width >> 8, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
  ]);
  return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]));
}

function webp(width, height) {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8X", 12, "ascii");
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return new Uint8Array(bytes);
}

async function decodeDiagnostics(bytes, mimeType) {
  const sha256 = await sha256Hex(bytes);
  const values = await fixtureValues();
  values.delete(values.get("manifest.json").entries.assets[0]);
  values.get("manifest.json").entries.assets = ["assets/media.json"];
  values.set("assets/media.json", {
    colors: [],
    fonts: [],
    id: "alib_media",
    media: [{
      blob: `blobs/${sha256}`,
      byteLength: bytes.byteLength,
      height: 4,
      id: "media_hostile",
      mimeType,
      name: "hostile",
      path: "Images",
      sha256,
      width: 4,
    }],
    typographies: [],
  });
  values.set(`blobs/${sha256}`, bytes);
  const nodes = values.get("screens/roundtrip.json").presentations[0].nodes;
  nodes.node_rectangle = {
    children: [],
    fills: [],
    height: 40,
    id: "node_rectangle",
    mediaRef: "media_hostile",
    name: "Hostile image",
    type: "IMAGE",
    width: 40,
    x: 80,
    y: 96,
  };
  const snapshot = await loadPackageFromValues("memory://hostile-media.smallpen", values);
  try {
    const evidence = await createEvidence(snapshot, { scale: 1, selector: { viewFormat: "screenshot" } });
    return evidence.render.diagnostics.filter(({ code }) => code === "media_decode_failed").map(({ message }) => message);
  } catch (error) {
    return [error.message];
  }

}

test("every raster decoder applies the same size limits (M7)", async () => {
  for (const [label, bytes, mimeType] of [
    ["PNG", png(8192, 8192, Buffer.alloc(0)), "image/png"],
    ["GIF", gif(8192, 8192), "image/gif"],
    ["JPEG", jpeg(8192, 8192), "image/jpeg"],
    ["WebP", webp(16000, 16000), "image/webp"],
  ]) {
    const messages = await decodeDiagnostics(bytes, mimeType);
    assert.ok(
      messages.some((message) => /exceeds the renderer limits/.test(message)),
      `${label}: ${JSON.stringify(messages)}`,
    );
  }
});

test("Skia bounds PNG decoding to the declared image dimensions", async () => {
  // Skia reads only the declared 2x2 image, rather than inflating all trailing
  // compressed data into a JavaScript buffer.
  const messages = await decodeDiagnostics(png(2, 2, Buffer.alloc(16 * 1024 * 1024)), "image/png");
  assert.deepEqual(messages, []);
});

// --- Bundled font licenses (L2) -------------------------------------------

test("every bundled font ships with its OFL license text (L2)", async () => {
  const fontsPath = join(localPackageRoot, "assets", "fonts");
  const files = await readdir(fontsPath);
  const licenses = await Promise.all(
    files
      .filter((file) => file.endsWith(".txt"))
      .map((file) => readFile(join(fontsPath, file), "utf8")),
  );
  for (const font of files.filter((file) => file.endsWith(".ttf"))) {
    const license = licenses.find((text) => text.includes(font));
    assert.ok(license, `missing license for ${font}`);
    assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/);
  }
  const manifest = JSON.parse(await readFile(join(localPackageRoot, "package.json"), "utf8"));
  assert.ok(manifest.files.includes("assets"));
});
