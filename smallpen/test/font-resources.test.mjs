import assert from "node:assert/strict";
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import opentype from "opentype.js";
import { projectScreen, sha256Hex } from "@smallpen/core";
import { serveLocalPackage } from "@smallpen/background";
import {
  importFontVariant,
  openPackage,
  renderProjection,
  resolveFontResource,
  sfntToWoff,
} from "@smallpen/local-package";
import * as conversion from "../packages/local-package/src/font-convert.mjs";

const fontId = "font_formatprobe",
  variantId = "fvar_formatprobe";
const fixture = new URL("fixtures/roundtrip.smallpen/", import.meta.url);
const ttf = new Uint8Array(
  await readFile(
    new URL(
      "../packages/local-package/assets/fonts/SourceSansPro-Regular.ttf",
      import.meta.url,
    ),
  ),
);
const shape = new opentype.Path();
shape.moveTo(100, 0);
shape.lineTo(800, 0);
shape.lineTo(450, 800);
shape.close();
const otf = new Uint8Array(
  new opentype.Font({
    familyName: "Format Probe",
    styleName: "Regular",
    unitsPerEm: 1000,
    ascender: 900,
    descender: -100,
    glyphs: [
      new opentype.Glyph({
        name: ".notdef",
        advanceWidth: 1000,
        path: new opentype.Path(),
      }),
      new opentype.Glyph({
        name: "A",
        unicode: 65,
        advanceWidth: 1000,
        path: shape,
      }),
    ],
  }).toArrayBuffer(),
);

function tables(bytes) {
  const buffer = Buffer.from(bytes),
    result = {};
  for (let i = 0; i < buffer.readUInt16BE(4); i++) {
    const position = 12 + i * 16,
      tag = buffer.toString("ascii", position, position + 4);
    const data = Buffer.from(
      buffer.subarray(
        buffer.readUInt32BE(position + 8),
        buffer.readUInt32BE(position + 8) + buffer.readUInt32BE(position + 12),
      ),
    );
    if (tag === "head") data.writeUInt32BE(0, 8); // The file checksum depends on table placement.
    result[tag] = data;
  }
  return result;
}

test("WOFF unpacking preserves every TTF and OTF table without rebuilding glyphs", () => {
  for (const [bytes, mimeType] of [
    [ttf, "font/ttf"],
    [otf, "font/otf"],
  ]) {
    const unpacked = conversion.woffToSfnt(sfntToWoff(bytes, mimeType));
    assert.deepEqual(tables(unpacked), tables(bytes));
    assert.equal(
      opentype.parse(unpacked.buffer).charToGlyphIndex("A") > 0,
      true,
    );
  }
});

test("WOFF decoding rejects truncated tables, oversized output and unsupported flavors", () => {
  const valid = sfntToWoff(ttf, "font/ttf");
  for (const edit of [
    (bytes) => bytes.subarray(0, 40),
    (bytes) => {
      new DataView(bytes.buffer).setUint32(16, 0xffffffff);
      return bytes;
    },
    (bytes) => {
      new DataView(bytes.buffer).setUint32(4, 0x74746366);
      return bytes;
    },
    (bytes) => {
      new DataView(bytes.buffer).setUint32(48, bytes.length + 1);
      return bytes;
    },
  ])
    assert.throws(
      () => conversion.woffToSfnt(edit(valid.slice())),
      (error) => error.code === "invalid_font_blob",
    );
});

async function example(context, format, bytes) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-font-resource-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "probe.smallpen");
  await cp(fixture, path, { recursive: true });
  await importFontVariant(path, {
    family: "Format Probe",
    fontId,
    id: variantId,
    name: "Regular",
    weight: 400,
    style: "normal",
    files: { [format]: { bytes, mimeType: `font/${format}` } },
  });
  const screenPath = join(path, "screens/roundtrip.json");
  const screen = JSON.parse(await readFile(screenPath, "utf8"));
  Object.assign(screen.presentations[0].nodes.node_rectangle, {
    type: "TEXT",
    text: "AAA AAA AAA",
    growType: "auto-height",
    textStyle: {
      fontFamily: "Format Probe",
      fontId,
      fontVariantId: "normal-400",
      fontWeight: 400,
      fontStyle: "normal",
      fontSize: 24,
    },
  });
  await writeFile(screenPath, JSON.stringify(screen));
  return { root, path, snapshot: await openPackage(path) };
}

test("a single TTF, OTF or WOFF opens and feeds the same native bytes to App and CLI without changing the package", async (context) => {
  for (const [format, bytes, expected] of [
    ["ttf", ttf, ttf],
    ["otf", otf, otf],
    ["woff", sfntToWoff(otf, "font/otf"), otf],
  ]) {
    const { path, snapshot } = await example(context, format, bytes);
    const library = snapshot.entries[snapshot.manifest.entries.assets[0]];
    assert.deepEqual(Object.keys(library.fonts[0].variants[0].files), [format]);
    const beforeBlobs = (await readdir(join(path, "blobs"))).sort();
    const rendered = await renderProjection(
      snapshot,
      projectScreen(snapshot, "scr_roundtrip"),
    );
    assert.ok(rendered.bytes.length > 8);
    const service = await serveLocalPackage({ packagePath: path, port: 0 });
    try {
      const files = snapshot.runtime.fontFiles[variantId];
      const native = await fetch(`${service.url}/v1/font/${files.sfnt}`);
      assert.equal(native.status, 200);
      const nativeBytes = new Uint8Array(await native.arrayBuffer());
      assert.deepEqual(tables(nativeBytes), tables(expected));
      const css = await fetch(`${service.url}/v1/font/${files.woff}`);
      assert.equal(css.status, 200);
      assert.equal(css.headers.get("content-type"), "font/woff");
      assert.deepEqual(
        tables(conversion.woffToSfnt(new Uint8Array(await css.arrayBuffer()))),
        tables(expected),
      );
    } finally {
      await service.close();
    }
    assert.equal((await openPackage(path)).revision, snapshot.revision);
    assert.deepEqual((await readdir(join(path, "blobs"))).sort(), beforeBlobs);
  }
});

test("OTF and its single WOFF produce identical PNGs and text layout", async (context) => {
  const results = [];
  for (const [format, bytes] of [
    ["otf", otf],
    ["woff", sfntToWoff(otf, "font/otf")],
  ]) {
    const { snapshot } = await example(context, format, bytes);
    results.push(
      await renderProjection(
        snapshot,
        projectScreen(snapshot, "scr_roundtrip"),
      ),
    );
  }
  assert.ok(results[0].bytes.length > 8);
  assert.deepEqual(results[0].bytes, results[1].bytes);
  assert.deepEqual(results[0].textMetrics, results[1].textMetrics);
});

test("the disposable font cache repairs damage, bounds storage and survives an unwritable location", async (context) => {
  const { root, snapshot } = await example(
    context,
    "woff",
    sfntToWoff(otf, "font/otf"),
  );
  const previous = process.env.SMALLPEN_FONT_CACHE_DIR;
  context.after(() => {
    if (previous === undefined) delete process.env.SMALLPEN_FONT_CACHE_DIR;
    else process.env.SMALLPEN_FONT_CACHE_DIR = previous;
  });
  const cache = join(root, "cache");
  process.env.SMALLPEN_FONT_CACHE_DIR = cache;
  const variant =
    snapshot.entries[snapshot.manifest.entries.assets[0]].fonts[0].variants[0];
  const first = await resolveFontResource(snapshot, variant);
  const [name] = await readdir(cache);
  assert.ok(name.endsWith(".font"));
  await writeFile(join(cache, name), "damaged");
  assert.deepEqual(
    (await resolveFontResource(snapshot, variant)).bytes,
    first.bytes,
  );
  const old = join(cache, `${"0".repeat(64)}.font`);
  await writeFile(old, "");
  await truncate(old, 128 * 1024 * 1024);
  await utimes(old, new Date(0), new Date(0));
  await rm(join(cache, name));
  await resolveFontResource(snapshot, variant);
  assert.deepEqual(
    await readdir(cache),
    [name],
    "old cached data leaves the byte window",
  );
  const blocked = join(root, "not-a-directory");
  await writeFile(blocked, "blocked");
  process.env.SMALLPEN_FONT_CACHE_DIR = blocked;
  assert.deepEqual(
    (await resolveFontResource(snapshot, variant)).bytes,
    first.bytes,
  );
});

test("legacy dual-format variants keep their original blobs and revision", async (context) => {
  const { path, snapshot } = await example(context, "otf", otf);
  const entry = snapshot.manifest.entries.assets[0];
  const library = structuredClone(snapshot.entries[entry]);
  const bytes = sfntToWoff(otf, "font/otf"),
    sha256 = await sha256Hex(bytes),
    blob = `blobs/${sha256}`;
  library.fonts[0].variants[0].files.woff = {
    blob,
    sha256,
    byteLength: bytes.length,
    mimeType: "font/woff",
  };
  await writeFile(join(path, blob), bytes);
  await writeFile(join(path, entry), JSON.stringify(library));
  const legacy = await openPackage(path);
  const rendered = await renderProjection(
    legacy,
    projectScreen(legacy, "scr_roundtrip"),
  );
  assert.ok(rendered.bytes.length > 8);
  const reopened = await openPackage(path);
  assert.equal(reopened.revision, legacy.revision);
  assert.deepEqual(
    Object.keys(reopened.entries[entry].fonts[0].variants[0].files).sort(),
    ["otf", "woff"],
  );
});
