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
  decodeFigmaClipboard,
  openRemoteLibrary,
} from "@smallpen/local-package";

import {
  ByteBuffer,
  decodeBinarySchema,
  encodeBinarySchema,
} from "../packages/local-package/src/kiwi-runtime.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "roundtrip.smallpen");
const localPackageRoot = join(here, "..", "packages", "local-package");

async function fixtureValues(edit = () => {}) {
  const manifest = JSON.parse(await readFile(join(fixture, "manifest.json"), "utf8"));
  edit(manifest);
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of listPackageEntries(manifest).entries) {
    values.set(entry, JSON.parse(await readFile(join(fixture, entry), "utf8")));
  }
  return values;
}

async function rejectsWith(promise, code) {
  let caught;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.code, code, caught?.stack);
  return caught;
}

// --- Remote Library requests (M5) -----------------------------------------

async function remoteFetch(handler) {
  const values = await fixtureValues((manifest) => {
    manifest.packageId = "pkg_remote_library";
  });
  return async (url, init) => {
    const response = await handler(new URL(url), init);
    if (response) return response;
    const value = values.get(new URL(url).pathname.replace(/^\/library\//, ""));
    return value === undefined
      ? new Response("missing", { status: 404 })
      : new Response(JSON.stringify(value), { status: 200 });
  };
}

test("Remote Libraries follow same-origin redirects only (M5)", async () => {
  const sameOrigin = await openRemoteLibrary("https://design.example/old/", {
    fetchImpl: await remoteFetch((url, init) => {
      assert.equal(init.redirect, "manual");
      if (url.pathname.startsWith("/old/")) {
        return new Response(null, {
          headers: { location: url.pathname.replace("/old/", "/library/") },
          status: 302,
        });
      }
      return undefined;
    }),
    refresh: true,
  });
  assert.equal(sameOrigin.manifest.packageId, "pkg_remote_library");

  await rejectsWith(
    openRemoteLibrary("https://design.example/library/", {
      fetchImpl: await remoteFetch(() =>
        new Response(null, {
          headers: { location: "http://169.254.169.254/latest/meta-data" },
          status: 301,
        }),
      ),
      refresh: true,
    }),
    "remote_library_redirect",
  );
});

test("Remote Library bodies are streamed against the size limit (M5)", async () => {
  let pulled = 0;
  const chunk = new Uint8Array(1024 * 1024);
  const endless = () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          pulled += 1;
          controller.enqueue(chunk);
        },
      }),
      { status: 200 },
    );
  await rejectsWith(
    openRemoteLibrary("https://design.example/library/", {
      fetchImpl: endless,
      refresh: true,
    }),
    "remote_library_too_large",
  );
  // Reading stops right after the 50 MB limit instead of buffering it all.
  assert.ok(pulled <= 53, `pulled ${pulled} chunks`);
});

test("Remote Library errors never echo response text (M5)", async () => {
  const error = await rejectsWith(
    openRemoteLibrary("https://design.example/library/", {
      fetchImpl: async () => new Response("secret-session-token {", { status: 200 }),
      refresh: true,
    }),
    "invalid_remote_library",
  );
  assert.doesNotMatch(JSON.stringify({ details: error.details, message: error.message }), /secret/);
});

test("Remote Library requests time out (M5)", async () => {
  await rejectsWith(
    openRemoteLibrary("https://design.example/library/", {
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason));
        }),
      refresh: true,
      requestTimeoutMs: 50,
    }),
    "remote_library_timeout",
  );
});

// --- Kiwi clipboard schema (M6) -------------------------------------------

test("a hostile 5-byte Kiwi schema is rejected instead of over-reading (M6)", () => {
  // A varuint definition count of 2^32-1 with no bytes left to back it.
  const hostile = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x0f]);
  assert.throws(() => decodeBinarySchema(new ByteBuffer(hostile)), /exceeds the message/);
  // One definition whose name string is never terminated.
  assert.throws(
    () => decodeBinarySchema(new ByteBuffer(new Uint8Array([1, 65, 66, 67, 68]))),
    /Unterminated string|ends before/,
  );
  const reader = new ByteBuffer(new Uint8Array([0x80]));
  assert.throws(() => reader.readVarUint(), /ends before/);
});

function kiwiClipboardHtml(definitions, data) {
  const schemaBytes = deflateSync(
    encodeBinarySchema({ definitions, package: null }),
  );
  const dataBytes = deflateSync(data);
  const payload = new Uint8Array(20 + schemaBytes.length + dataBytes.length);
  const view = new DataView(payload.buffer);
  payload.set(new TextEncoder().encode("fig-kiwi"), 0);
  view.setUint32(8, 101, true);
  view.setUint32(12, schemaBytes.length, true);
  payload.set(schemaBytes, 16);
  view.setUint32(16 + schemaBytes.length, dataBytes.length, true);
  payload.set(dataBytes, 20 + schemaBytes.length);
  const meta = Buffer.from("{}").toString("base64");
  return `(figmeta)${meta}(/figmeta)(figma)${Buffer.from(payload).toString("base64")}(/figma)`;
}

const kiwiField = (name, type, value, isArray = false) => ({
  isArray,
  isDeprecated: false,
  name,
  type,
  value,
});

test("Kiwi values that consume no bytes cannot exhaust memory", async () => {
  // An array of field-less structs: every element decodes from zero bytes.
  // At 120 million elements (a 155 KB clipboard) this used to abort the
  // process with a fatal out-of-memory error.
  const length = 10_000_000;
  const head = new ByteBuffer();
  head.writeVarUint(1);
  head.writeVarUint(length);
  head.writeVarUint(0);
  const data = new Uint8Array(head.length + length);
  data.set(head.toUint8Array());
  await assert.rejects(
    decodeFigmaClipboard(
      kiwiClipboardHtml(
        [
          { fields: [], kind: "STRUCT", name: "Empty" },
          {
            fields: [kiwiField("nodeChanges", "Empty", 1, true)],
            kind: "MESSAGE",
            name: "Message",
          },
        ],
        data,
      ),
    ),
    { code: "invalid_figma_clipboard", message: /too many values/ },
  );
  // Struct fields carry no tag: a chain of structs with two fields each
  // decodes 2^40 objects from a two-byte message.
  const depth = 40;
  const chain = Array.from({ length: depth }, (_, index) => ({
    fields:
      index === depth - 1
        ? []
        : [kiwiField("a", `S${index + 1}`, 0), kiwiField("b", `S${index + 1}`, 0)],
    kind: "STRUCT",
    name: `S${index}`,
  }));
  await assert.rejects(
    decodeFigmaClipboard(
      kiwiClipboardHtml(
        [
          ...chain,
          {
            fields: [kiwiField("root", "S0", 1)],
            kind: "MESSAGE",
            name: "Message",
          },
        ],
        new Uint8Array([1, 0]),
      ),
    ),
    { code: "invalid_figma_clipboard", message: /too many values/ },
  );
});

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
  const evidence = await createEvidence(snapshot, {
    scale: 1,
    selector: { viewFormat: "screenshot" },
  });
  return evidence.render.diagnostics
    .filter(({ code }) => code === "media_decode_failed")
    .map(({ message }) => message);
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

test("PNG pixel data cannot inflate past its declared size (M7)", async () => {
  // A 2x2 image whose compressed stream expands to 16 MB.
  const messages = await decodeDiagnostics(
    png(2, 2, Buffer.alloc(16 * 1024 * 1024)),
    "image/png",
  );
  assert.ok(
    messages.some((message) => /larger than its declared size/.test(message)),
    JSON.stringify(messages),
  );
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
