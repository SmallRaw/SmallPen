import { deflateSync, inflateSync } from "node:zlib";

import { SmallPenError } from "@smallpen/core";

// Lossless container conversion shared by CLI and App resource loading.
const MAX_SFNT_BYTES = 64 * 1024 * 1024;

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
  if (!(bytes instanceof Uint8Array))
    failFont("invalid_font_blob", "Font bytes must be a Uint8Array");
  const signature = Object.hasOwn(FONT_SIGNATURES, mimeType)
    ? FONT_SIGNATURES[mimeType]
    : undefined;
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
    failFont(
      "unsupported_font_conversion",
      `Cannot convert ${mimeType} to WOFF`,
    );
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
  for (const record of records)
    outputLength += align4(record.stored.byteLength);
  const output = new Uint8Array(outputLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x774f4646, false);
  view.setUint32(4, source.getUint32(0, false), false);
  view.setUint32(8, outputLength, false);
  view.setUint16(12, records.length, false);
  view.setUint16(14, 0, false);
  view.setUint32(
    16,
    12 +
      records.length * 16 +
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

export function woffToSfnt(bytes) {
  inspectFont(bytes, "font/woff");
  const invalid = (message) => failFont("invalid_font_blob", message);
  if (bytes.byteLength < 44) invalid("WOFF header is truncated");
  const source = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flavor = source.getUint32(4),
    count = source.getUint16(12),
    total = source.getUint32(16);
  const directoryEnd = 44 + count * 20;
  if (
    ![0x00010000, 0x4f54544f].includes(flavor) ||
    source.getUint16(14) !== 0 ||
    source.getUint32(8) !== bytes.byteLength ||
    !count ||
    count > 4095 ||
    directoryEnd > bytes.byteLength ||
    total < 12 + count * 16 ||
    total > MAX_SFNT_BYTES
  )
    invalid("WOFF header or decoded size is invalid");
  const records = [],
    tags = new Set(),
    ranges = [];
  let size = 12 + count * 16;
  for (let i = 0; i < count; i++) {
    const at = 44 + i * 20,
      tag = source.getUint32(at),
      offset = source.getUint32(at + 4);
    const compressed = source.getUint32(at + 8),
      length = source.getUint32(at + 12);
    // Check unsigned lengths before align4's bitwise arithmetic can wrap.
    if (length > MAX_SFNT_BYTES || length > total)
      invalid("WOFF table exceeds the decoded size limit");
    size += align4(length);
    if (
      tags.has(tag) ||
      offset < directoryEnd ||
      offset % 4 ||
      compressed > length ||
      offset > bytes.byteLength ||
      compressed > bytes.byteLength - offset ||
      size > MAX_SFNT_BYTES ||
      size > total
    )
      invalid("WOFF table directory is invalid");
    tags.add(tag);
    ranges.push([offset, offset + compressed]);
    records.push({
      tag,
      offset,
      compressed,
      length,
      checksum: source.getUint32(at + 16),
    });
  }
  if (size !== total) invalid("WOFF decoded size does not match its tables");
  ranges.sort((a, b) => a[0] - b[0]);
  if (ranges.some((range, i) => i && range[0] < ranges[i - 1][1]))
    invalid("WOFF tables overlap");
  const output = new Uint8Array(total),
    view = new DataView(output.buffer);
  view.setUint32(0, flavor);
  view.setUint16(4, count);
  const power = Math.floor(Math.log2(count));
  view.setUint16(6, 2 ** power * 16);
  view.setUint16(8, power);
  view.setUint16(10, count * 16 - 2 ** power * 16);
  let offset = 12 + count * 16,
    head;
  for (const [i, record] of records.sort((a, b) => a.tag - b.tag).entries()) {
    let data = bytes.subarray(record.offset, record.offset + record.compressed);
    if (record.compressed < record.length) {
      try {
        data = inflateSync(data, { maxOutputLength: record.length });
      } catch {
        invalid("WOFF table cannot be decompressed within its declared size");
      }
    }
    if (data.byteLength !== record.length)
      invalid("WOFF table length is invalid");
    const at = 12 + i * 16;
    view.setUint32(at, record.tag);
    view.setUint32(at + 4, record.checksum);
    view.setUint32(at + 8, offset);
    view.setUint32(at + 12, record.length);
    output.set(data, offset);
    if (record.tag === 0x68656164) {
      if (record.length < 12) invalid("Font head table is truncated");
      head = offset;
      view.setUint32(head + 8, 0);
    }
    let checksum = 0;
    for (let i = 0; i < align4(record.length); i += 4)
      checksum = (checksum + view.getUint32(offset + i)) >>> 0;
    if (checksum !== record.checksum) invalid("WOFF table checksum is invalid");
    offset += align4(record.length);
  }
  if (head !== undefined) {
    let checksum = 0;
    for (let i = 0; i < output.length; i += 4)
      checksum = (checksum + view.getUint32(i)) >>> 0;
    view.setUint32(head + 8, (0xb1b0afba - checksum) >>> 0);
  }
  return output;
}

// Penpot names a Font Variant without a stored name from its weight and
// style (app.common.media/font-display-variant), e.g. "Bold Italic".
const FONT_WEIGHT_NAMES = {
  100: "Hairline",
  200: "Extra Light",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "Semi Bold",
  700: "Bold",
  800: "Extra Bold",
  900: "Black",
  950: "Extra Black",
};

export function fontVariantName(weight, style) {
  const base = FONT_WEIGHT_NAMES[Number(weight)] ?? String(weight);
  return style === "italic" ? `${base} Italic` : base;
}

export function prepareFontFiles(input) {
  const files = {};
  for (const [mimeType, bytes] of Object.entries(input)) {
    inspectFont(bytes, mimeType);
    const format = mimeType.slice("font/".length);
    files[format] = { bytes, mimeType };
  }
  const format = ["ttf", "otf", "woff"].find((format) => files[format]);
  if (!format)
    failFont(
      "unsupported_font_conversion",
      "Supply a TTF, OTF or WOFF font; WOFF2-only input needs a WOFF2 decoder",
    );
  const file = files[format];
  if (file.bytes.length > MAX_SFNT_BYTES)
    failFont("invalid_font_blob", "Font exceeds the resource limit");
  if (format === "woff") woffToSfnt(file.bytes);
  else tableRecords(file.bytes);
  return { [format]: file };
}
