import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectFont,
  prepareFontFiles,
  sfntToWoff,
} from "../apps/background/src/font.mjs";

function minimalTtf() {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x00010000, false);
  view.setUint16(4, 1, false);
  view.setUint32(12, 0x74657374, false);
  view.setUint32(16, 0x01020304, false);
  view.setUint32(20, 28, false);
  view.setUint32(24, 4, false);
  bytes.set([1, 2, 3, 4], 28);
  return bytes;
}

test("the local Font converter wraps valid SFNT tables as WOFF without dependencies", () => {
  const ttf = minimalTtf();
  const woff = sfntToWoff(ttf, "font/ttf");
  const view = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
  assert.equal(view.getUint32(0, false), 0x774f4646);
  assert.equal(view.getUint32(4, false), 0x00010000);
  assert.equal(view.getUint32(8, false), woff.byteLength);
  assert.equal(view.getUint16(12, false), 1);
  assert.equal(view.getUint32(16, false), 32);
  assert.equal(inspectFont(woff, "font/woff"), "font/woff");

  const files = prepareFontFiles({ "font/ttf": ttf });
  assert.deepEqual(files.ttf, { bytes: ttf, mimeType: "font/ttf" });
  assert.equal(files.woff.mimeType, "font/woff");
  assert.deepEqual(files.woff.bytes, woff);
});

test("Font inspection rejects mismatched bytes and WOFF2-only conversion", () => {
  assert.throws(
    () => inspectFont(new Uint8Array([0, 1, 2, 3]), "font/woff"),
    (error) => error?.code === "invalid_font_blob",
  );
  assert.throws(
    () =>
      prepareFontFiles({
        "font/woff2": new Uint8Array([0x77, 0x4f, 0x46, 0x32]),
      }),
    (error) => error?.code === "unsupported_font_conversion",
  );
});
