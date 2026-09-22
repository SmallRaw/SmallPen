import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  listPackageEntries,
  sha256Hex,
} from "@smallpen/core";
import {
  defaultLibraryCacheRoot,
  openRemoteLibrary,
  sfntToWoff,
} from "@smallpen/local-package";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "apps", "cli", "bin", "smallpen-check.cjs");
const fixture = join(here, "fixtures", "roundtrip.smallpen");
const ttf = join(here, "..", "packages", "local-package", "assets", "fonts", "SourceSansPro-Regular.ttf");

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr, stdout }));
  });
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function cloneFixture(name) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-media-"));
  const packagePath = join(root, name);
  await cp(fixture, packagePath, { recursive: true });
  return { packagePath, root };
}

async function buildPng() {
  const { deflateSync } = await import("node:zlib");
  const { crc32 } = await import("@smallpen/core");
  void crc32;
  // Minimal chunked PNG encoder.
  const width = 2;
  const height = 2;
  const raw = Buffer.from([
    0,
    255, 0, 0, 255, 0, 0, 255, 255,
    0,
    0, 0, 255, 255, 255, 255, 0, 255,
  ]);
  const chunk = (type, data) => {
    const name = Buffer.from(type, "ascii");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([name, data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32Of(body));
    return Buffer.concat([length, body, checksum]);
  };
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32Of = (buffer) => {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

function gifBytes() {
  // 2x2 GIF header only as far as the logical screen descriptor; import sniffs
  // dimensions from the header.
  return new Uint8Array([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
    0x02, 0x00,
    0x02, 0x00,
    0x80,
    0x00,
    0x00,
    0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00,
    0x2c,
    0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x02, 0x00, 0x00,
    0x02, 0x02, 0x44, 0x01, 0x00,
    0x3b,
  ]);
}

function webpBytes() {
  // Minimal VP8L WebP: RIFF header + VP8L chunk with 3x1 dimensions.
  const buffer = new Uint8Array(30);
  const ascii = (text, offset) => {
    for (const [index, char] of [...text].entries()) buffer[offset + index] = char.charCodeAt(0);
  };
  ascii("RIFF", 0);
  const view = new DataView(buffer.buffer);
  view.setUint32(4, 22, true);
  ascii("WEBP", 8);
  ascii("VP8L", 12);
  view.setUint32(16, 5, true);
  ascii("\x9d\x01*", 20);
  // VP8L payload: signature byte then 14-bit width-1 and height-1.
  buffer[20] = 0x2f;
  const width = 3;
  const height = 1;
  const bits = ((height - 1) << 14) | (width - 1);
  buffer[21] = bits & 0xff;
  buffer[22] = (bits >> 8) & 0xff;
  buffer[23] = 0;
  buffer[24] = 0;
  buffer[25] = 0xfe;
  return buffer;
}

test("import-media is the public binary entry with content addressing and lifecycle (SP-028/029/030/031)", async () => {
  const { packagePath } = await cloneFixture("media.smallpen");
  const png = await buildPng();

  const pngPath = join(dirname(packagePath), "dot.png");
  await writeFile(pngPath, png);
  const first = JSON.parse(
    (
      await runCli([
        "import-media",
        packagePath,
        "--file",
        pngPath,
        "--media-id",
        "media_dot",
        "--name",
        "dot.png",
        "--json",
      ])
    ).stdout,
  );
  assert.equal(first.descriptor.mimeType, "image/png");
  assert.equal(first.descriptor.width, 2);
  assert.equal(first.descriptor.height, 2);
  assert.equal(first.descriptor.blob, `blobs/${await sha256Hex(png)}`);

  // Same bytes under a new id share the same content-addressed blob.
  const second = JSON.parse(
    (
      await runCli([
        "import-media",
        packagePath,
        "--file",
        pngPath,
        "--media-id",
        "media_dot_two",
        "--json",
      ])
    ).stdout,
  );
  assert.equal(second.descriptor.blob, first.descriptor.blob);
  assert.notEqual(second.descriptor.id, first.descriptor.id);

  // Reimporting an id is atomic and typed.
  const duplicate = await runCli([
    "import-media",
    packagePath,
    "--file",
    pngPath,
    "--media-id",
    "media_dot",
    "--json",
  ]);
  assert.equal(duplicate.code, 1);
  assert.equal(JSON.parse(duplicate.stdout).error.code, "duplicate_media_id");

  // Removal is typed and reversible through the returned inverse contract.
  const removed = JSON.parse(
    (
      await runCli([
        "remove-media",
        packagePath,
        "--media-id",
        "media_dot_two",
        "--json",
      ])
    ).stdout,
  );
  assert.equal(removed.removed, true);
  const missing = await runCli([
    "remove-media",
    packagePath,
    "--media-id",
    "media_dot_two",
    "--json",
  ]);
  assert.equal(missing.code, 1);
  assert.equal(JSON.parse(missing.stdout).error.code, "missing_media");
});

test("import-media sniffs JPEG, GIF, and WebP dimensions from bytes (SP-029/030/031)", async () => {
  const { packagePath, root } = await cloneFixture("sniff.smallpen");
  const jpegPath = join(here, "fixtures", "quadrant.jpg");
  const jpeg = JSON.parse(
    (await runCli(["import-media", packagePath, "--file", jpegPath, "--json"])).stdout,
  );
  assert.equal(jpeg.descriptor.mimeType, "image/jpeg");
  assert.equal(jpeg.descriptor.width, 8);
  assert.equal(jpeg.descriptor.height, 8);

  const gifPath = join(root, "frame.gif");
  await writeFile(gifPath, gifBytes());
  const gif = JSON.parse(
    (await runCli(["import-media", packagePath, "--file", gifPath, "--json"])).stdout,
  );
  assert.equal(gif.descriptor.mimeType, "image/gif");
  assert.equal(gif.descriptor.width, 2);
  assert.equal(gif.descriptor.height, 2);

  const webpPath = join(root, "tiny.webp");
  await writeFile(webpPath, webpBytes());
  const webp = JSON.parse(
    (await runCli(["import-media", packagePath, "--file", webpPath, "--json"])).stdout,
  );
  assert.equal(webp.descriptor.mimeType, "image/webp");
  assert.equal(webp.descriptor.width, 3);
  assert.equal(webp.descriptor.height, 1);

  const corrupt = join(root, "broken.png");
  await writeFile(corrupt, Buffer.from([1, 2, 3, 4]));
  const rejected = await runCli(["import-media", packagePath, "--file", corrupt, "--json"]);
  assert.equal(rejected.code, 1);
  assert.equal(JSON.parse(rejected.stdout).error.code, "invalid_media_file");
});

test("import-font converts SFNT to WOFF and bounds WOFF2 support (SP-033/034/035/036)", async () => {
  const { packagePath, root } = await cloneFixture("fonts.smallpen");

  const ttfImport = JSON.parse(
    (await runCli([
      "import-font",
      packagePath,
      "--file",
      ttf,
      "--family",
      "Source Sans Pro",
      "--font-id",
      "font_sourcesans",
      "--variant-id",
      "fvar_regular",
      "--weight",
      "400",
      "--json",
    ])).stdout,
  );
  assert.equal(ttfImport.fontId, "font_sourcesans");
  assert.ok(ttfImport.files.ttf, "original TTF bytes are preserved");
  assert.ok(ttfImport.files.woff, "SFNT is converted to WOFF");

  // WOFF imports as-is with byte validation.
  const woffPath = join(root, "regular.woff");
  const ttfBytes = new Uint8Array(await readFile(ttf));
  await writeFile(woffPath, sfntToWoff(ttfBytes, "font/ttf"));
  const woffImport = JSON.parse(
    (await runCli([
      "import-font",
      packagePath,
      "--file",
      woffPath,
      "--family",
      "Source Sans Pro",
      "--font-id",
      "font_sourcesans_woff",
      "--variant-id",
      "fvar_woff",
      "--weight",
      "400",
      "--json",
    ])).stdout,
  );
  assert.ok(woffImport.files.woff);
  assert.equal(woffImport.files.ttf, undefined);

  // A signature-valid WOFF2 reaches the explicit conversion boundary.
  const woff2Path = join(root, "modern.woff2");
  await writeFile(woff2Path, Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]));
  const woff2 = await runCli([
    "import-font",
    packagePath,
    "--file",
    woff2Path,
    "--family",
    "Future",
    "--json",
  ]);
  assert.equal(woff2.code, 1);
  assert.equal(JSON.parse(woff2.stdout).error.code, "unsupported_font_conversion");

  // Corrupt font bytes are a different, typed rejection.
  const corruptPath = join(root, "broken.ttf");
  await writeFile(corruptPath, Buffer.from([1, 2, 3, 4, 5]));
  const corrupt = await runCli([
    "import-font",
    packagePath,
    "--file",
    corruptPath,
    "--family",
    "Broken",
    "--json",
  ]);
  assert.equal(corrupt.code, 1);
  assert.equal(JSON.parse(corrupt.stdout).error.code, "invalid_font_blob");
});

test("library refresh keeps the verified snapshot on identity mismatch (SP-024/SP-025)", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "smallpen-refresh-cache-"));
  const manifest = JSON.parse(await readFile(join(fixture, "manifest.json"), "utf8"));
  manifest.name = "Remote Library";
  manifest.packageId = "pkg_remote_library";
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of listPackageEntries(manifest).entries) {
    values.set(entry, JSON.parse(await readFile(join(fixture, entry), "utf8")));
  }
  const sourceUrl = "https://design.example/library/";
  const requests = [];
  const fetchImpl = (url) => {
    requests.push(url);
    const path = new URL(url).pathname.replace("/library/", "");
    const value = values.get(path);
    return value === undefined
      ? new Response("missing", { status: 404 })
      : new Response(JSON.stringify(value), { status: 200 });
  };
  const first = await openRemoteLibrary(sourceUrl, {
    cacheRoot,
    expectedPackageId: "pkg_remote_library",
    fetchImpl,
    refresh: true,
  });
  assert.equal(first.remote.cache, "refreshed");

  // The origin now serves a different Package ID.
  values.set("manifest.json", { ...manifest, packageId: "pkg_impersonator" });
  await assert.rejects(
    openRemoteLibrary(sourceUrl, {
      cacheRoot,
      expectedPackageId: "pkg_remote_library",
      fetchImpl,
      refresh: true,
    }),
    (error) => {
      assert.equal(error.code, "library_id_mismatch");
      assert.equal(error.details.expectedPackageId, "pkg_remote_library");
      assert.equal(error.details.actualPackageId, "pkg_impersonator");
      return true;
    },
  );

  // The previous verified snapshot is still readable offline.
  const offline = await openRemoteLibrary(sourceUrl, {
    cacheRoot,
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(offline.revision, first.revision);
  assert.equal(offline.manifest.packageId, "pkg_remote_library");
});

test("tampered cache content is rejected and recoverable online (SP-026)", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "smallpen-integrity-cache-"));
  const manifest = JSON.parse(await readFile(join(fixture, "manifest.json"), "utf8"));
  manifest.name = "Remote Library";
  manifest.packageId = "pkg_remote_library";
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of listPackageEntries(manifest).entries) {
    values.set(entry, JSON.parse(await readFile(join(fixture, entry), "utf8")));
  }
  const sourceUrl = "https://design.example/library/";
  const fetchImpl = (url) => {
    const path = new URL(url).pathname.replace("/library/", "");
    const value = values.get(path);
    return value === undefined
      ? new Response("missing", { status: 404 })
      : new Response(JSON.stringify(value), { status: 200 });
  };
  await openRemoteLibrary(sourceUrl, {
    cacheRoot,
    fetchImpl,
    refresh: true,
  });

  const { readdir, readFile: readCache, writeFile: writeCache } = await import("node:fs/promises");
  const { join: joinPath } = await import("node:path");
  const cacheDirs = await readdir(cacheRoot);
  const snapshotRoot = joinPath(cacheRoot, cacheDirs[0]);
  const pointer = JSON.parse(await readCache(joinPath(snapshotRoot, "current.json"), "utf8"));
  const revisionRoot = joinPath(snapshotRoot, pointer.revision);
  const entryFiles = (await readdir(revisionRoot, { recursive: true }))
    .filter((file) => file.endsWith(".json") && !file.endsWith("current.json") && file !== "manifest.json");
  const entryPath = joinPath(revisionRoot, entryFiles[0]);
  const original = JSON.parse(await readCache(entryPath, "utf8"));
  original.name = `${original.name} (tampered)`;
  await writeCache(entryPath, `${JSON.stringify(original, null, 2)}\n`);

  // Offline: the tampered cache is rejected with a typed error, never trusted.
  await assert.rejects(
    openRemoteLibrary(sourceUrl, {
      cacheRoot,
      fetchImpl: async () => {
        throw new Error("offline");
      },
    }),
    (error) => error.code === "remote_library_cache_corrupt",
  );

  // Online: the safe re-fetch replaces the corrupted view with verified bytes.
  const refreshed = await openRemoteLibrary(sourceUrl, { cacheRoot, fetchImpl });
  assert.equal(refreshed.remote.cache, "refreshed");
  // The repaired cache verifies again and serves hits offline.
  const repaired = await openRemoteLibrary(sourceUrl, {
    cacheRoot,
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(repaired.remote.cache, "hit");
  assert.equal(repaired.revision, pointer.revision);
});

test("catalog inventories Library assets with qualified ownership (SP-023)", async () => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-inventory-"));
  const productPath = join(root, "app.smallpen");
  const libraryPath = join(root, "assets.smallpen");
  await cp(fixture, productPath, { recursive: true });
  await cp(fixture, libraryPath, { recursive: true });
  const libraryManifestPath = join(libraryPath, "manifest.json");
  const libraryManifest = JSON.parse(await readFile(libraryManifestPath, "utf8"));
  libraryManifest.name = "Assets Library";
  libraryManifest.packageId = "pkg_assets_library";
  libraryManifest.entries.assets = ["assets/design.json"];
  await writeJson(libraryManifestPath, libraryManifest);
  await mkdir(join(libraryPath, "assets"), { recursive: true });
  await writeJson(join(libraryPath, "assets/design.json"), {
    colors: [{
      id: "color_lib_brand",
      name: "Brand",
      paint: { color: "#6750a4", opacity: 1, type: "solid" },
      path: "Brand",
    }],
    fonts: [],
    id: "alib_library",
    media: [{
      blob: "blobs/6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
      byteLength: 1,
      height: 8,
      id: "media_lib_mark",
      mimeType: "image/png",
      name: "mark.png",
      path: "Images",
      sha256: "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
      width: 8,
    }],
    typographies: [{
      id: "typo_lib_heading",
      name: "Heading",
      path: "Text",
      style: {
        fontFamily: "Inter",
        fontId: "gfont-inter",
        fontSize: 24,
        fontStyle: "normal",
        fontVariantId: "regular",
        fontWeight: 700,
        letterSpacing: 0,
        lineHeight: 1.2,
        textTransform: "none",
      },
    }],
  });
  await mkdir(join(libraryPath, "blobs"), { recursive: true });
  await writeFile(
    join(libraryPath, "blobs/6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d"),
    new Uint8Array([0]),
  );
  const productManifestPath = join(productPath, "manifest.json");
  const productManifest = JSON.parse(await readFile(productManifestPath, "utf8"));
  productManifest.libraries = [{
    packageId: "pkg_assets_library",
    source: { path: "assets.smallpen", type: "local" },
  }];
  await writeJson(productManifestPath, productManifest);

  const catalog = JSON.parse((await runCli(["catalog", productPath, "--json"])).stdout);
  assert.ok(Array.isArray(catalog.libraries));
  const inventory = catalog.libraries.find(
    (library) => library.packageId === "pkg_assets_library",
  );
  assert.ok(inventory, "catalog attributes the Library inventory");
  assert.ok(inventory.revision);
  assert.equal(inventory.assets.media[0].id, "media_lib_mark");
  assert.equal(inventory.assets.colors[0].id, "color_lib_brand");
  assert.equal(inventory.assets.typographies[0].id, "typo_lib_heading");
  void rm;
  void defaultLibraryCacheRoot;
});
