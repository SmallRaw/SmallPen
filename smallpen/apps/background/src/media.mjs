import { SmallPenError } from "@smallpen/core";

const JPEG_SOF_MARKERS = new Set([
  0xc0,
  0xc1,
  0xc2,
  0xc3,
  0xc5,
  0xc6,
  0xc7,
  0xc9,
  0xca,
  0xcb,
  0xcd,
  0xce,
  0xcf,
]);

function invalidMedia(message = "Uploaded Media is not a valid image") {
  throw new SmallPenError("invalid_media_blob", message);
}

function positiveDimensions(width, height) {
  if (
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    !Number.isSafeInteger(height) ||
    height <= 0
  ) {
    invalidMedia("Uploaded Media dimensions are invalid");
  }
  return { height, width };
}

function parsePng(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    bytes.length < 24 ||
    signature.some((byte, index) => bytes[index] !== byte) ||
    String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR"
  ) {
    invalidMedia("Uploaded PNG has an invalid signature or IHDR");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return positiveDimensions(view.getUint32(16), view.getUint32(20));
}

function parseGif(bytes) {
  const signature = new TextDecoder("ascii").decode(bytes.slice(0, 6));
  if (bytes.length < 10 || (signature !== "GIF87a" && signature !== "GIF89a")) {
    invalidMedia("Uploaded GIF has an invalid signature");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return positiveDimensions(view.getUint16(6, true), view.getUint16(8, true));
}

function parseJpeg(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    invalidMedia("Uploaded JPEG has an invalid signature");
  }
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > bytes.length) break;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) break;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (length < 7) break;
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      return positiveDimensions(width, height);
    }
    offset += length;
  }
  invalidMedia("Uploaded JPEG does not contain a supported frame header");
}

function uint24(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function parseWebp(bytes) {
  const text = (start, end) =>
    new TextDecoder("ascii").decode(bytes.slice(start, end));
  if (bytes.length < 30 || text(0, 4) !== "RIFF" || text(8, 12) !== "WEBP") {
    invalidMedia("Uploaded WebP has an invalid RIFF signature");
  }
  const format = text(12, 16);
  if (format === "VP8X") {
    return positiveDimensions(uint24(bytes, 24) + 1, uint24(bytes, 27) + 1);
  }
  if (
    format === "VP8 " &&
    bytes[23] === 0x9d &&
    bytes[24] === 0x01 &&
    bytes[25] === 0x2a
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return positiveDimensions(
      view.getUint16(26, true) & 0x3fff,
      view.getUint16(28, true) & 0x3fff,
    );
  }
  if (format === "VP8L" && bytes[20] === 0x2f && bytes.length >= 25) {
    const bits =
      bytes[21] |
      (bytes[22] << 8) |
      (bytes[23] << 16) |
      (bytes[24] << 24);
    return positiveDimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  invalidMedia("Uploaded WebP uses an unsupported image header");
}

function svgLength(value) {
  if (typeof value !== "string") return undefined;
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)(?:px)?\s*$/i.exec(value);
  return match ? Math.round(Number(match[1])) : undefined;
}

function parseSvg(bytes) {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const root = /<svg\b([^>]*)>/i.exec(source)?.[1];
  if (root === undefined) invalidMedia("Uploaded SVG does not contain an svg root");
  const attribute = (name) =>
    new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(root)?.[1];
  let width = svgLength(attribute("width"));
  let height = svgLength(attribute("height"));
  const viewBox = attribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if ((!width || !height) && viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
    width ??= Math.round(viewBox[2]);
    height ??= Math.round(viewBox[3]);
  }
  return positiveDimensions(width, height);
}

export function inspectImage(bytes, mimeType) {
  if (!(bytes instanceof Uint8Array)) invalidMedia();
  switch (mimeType) {
    case "image/gif":
      return parseGif(bytes);
    case "image/jpeg":
      return parseJpeg(bytes);
    case "image/png":
      return parsePng(bytes);
    case "image/svg+xml":
      return parseSvg(bytes);
    case "image/webp":
      return parseWebp(bytes);
    default:
      throw new SmallPenError(
        "media_type_not_allowed",
        `Unsupported Media type: ${String(mimeType)}`,
      );
  }
}
