import { deflateSync } from "node:zlib";

import { SmallPenError } from "@smallpen/core";

// SFNT -> WOFF repackaging shared by the CLI and the Background font service.

const FONT_SIGNATURES = {
  "font/otf": new Uint8Array([0x4f, 0x54, 0x54, 0x4f]),
  "font/ttf": new Uint8Array([0x00, 0x01, 0x00, 0x00]),
  "font/woff": new Uint8Array([0x77, 0x4f, 0x46, 0x46]),
  "font/woff2": new Uint8Array([0x77, 0x4f, 0x46, 0x32]),
};

function failFont(code, message, details) {
  throw new SmallPenError(code, message, details);
}

function matches(bytes, signature) {
  return signature.every((value, index) => bytes[index] === value);
}

export function inspectFont(bytes, mimeType) {
  const signature = FONT_SIGNATURES[mimeType];
  if (!signature || !matches(bytes, signature)) {
    failFont(
      "invalid_font_blob",
      `Font bytes do not match ${mimeType || "an allowed Font type"}`,
      { mimeType },
    );
  }
  return mimeType;
}

function align4(value) {
  return (value + 3) & ~3;
}

function tableRecords(bytes) {
  if (bytes.byteLength < 12) {
    failFont("invalid_font_blob", "SFNT Font header is truncated");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numTables = view.getUint16(4, false);
  const directoryEnd = 12 + numTables * 16;
  if (numTables === 0 || numTables > 4096 || directoryEnd > bytes.byteLength) {
    failFont("invalid_font_blob", "SFNT Font table directory is invalid");
  }
  const records = [];
  for (let index = 0; index < numTables; index += 1) {
    const position = 12 + index * 16;
    const offset = view.getUint32(position + 8, false);
    const length = view.getUint32(position + 12, false);
    if (offset > bytes.byteLength || length > bytes.byteLength - offset) {
      failFont("invalid_font_blob", "SFNT Font table extends beyond the file");
    }
    records.push({
      checksum: view.getUint32(position + 4, false),
      data: bytes.subarray(offset, offset + length),
      length,
      tag: view.getUint32(position, false),
    });
  }
  return records.sort((left, right) => left.tag - right.tag);
}

export function sfntToWoff(bytes, mimeType) {
  if (mimeType !== "font/ttf" && mimeType !== "font/otf") {
    failFont("unsupported_font_conversion", `Cannot convert ${mimeType} to WOFF`);
  }
  inspectFont(bytes, mimeType);
  const source = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records = tableRecords(bytes).map((record) => {
    const compressed = new Uint8Array(deflateSync(record.data));
    return {
      ...record,
      stored: compressed.byteLength < record.length ? compressed : record.data,
    };
  });
  const directoryLength = 44 + records.length * 20;
  let outputLength = directoryLength;
  for (const record of records) outputLength += align4(record.stored.byteLength);
  const output = new Uint8Array(outputLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x774f4646, false);
  view.setUint32(4, source.getUint32(0, false), false);
  view.setUint32(8, outputLength, false);
  view.setUint16(12, records.length, false);
  view.setUint16(14, 0, false);
  view.setUint32(
    16,
    12 + records.length * 16 +
      records.reduce((total, record) => total + align4(record.length), 0),
    false,
  );
  view.setUint16(20, 1, false);
  view.setUint16(22, 0, false);
  let dataOffset = directoryLength;
  for (const [index, record] of records.entries()) {
    const position = 44 + index * 20;
    view.setUint32(position, record.tag, false);
    view.setUint32(position + 4, dataOffset, false);
    view.setUint32(position + 8, record.stored.byteLength, false);
    view.setUint32(position + 12, record.length, false);
    view.setUint32(position + 16, record.checksum, false);
    output.set(record.stored, dataOffset);
    dataOffset += align4(record.stored.byteLength);
  }
  return output;
}

export function prepareFontFiles(input) {
  const files = {};
  for (const [mimeType, bytes] of Object.entries(input)) {
    inspectFont(bytes, mimeType);
    const format = mimeType.slice("font/".length);
    files[format] = { bytes, mimeType };
  }
  if (!files.woff) {
    const source = files.ttf ?? files.otf;
    if (!source) {
      failFont(
        "unsupported_font_conversion",
        "A WOFF2-only upload cannot be converted without a WOFF2 decoder",
      );
    }
    files.woff = {
      bytes: sfntToWoff(source.bytes, source.mimeType),
      mimeType: "font/woff",
    };
  }
  return files;
}
