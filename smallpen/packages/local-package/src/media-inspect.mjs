import { SmallPenError } from "@smallpen/core";

const SIGNATURES = [
  { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mimeType: "image/png" },
  { bytes: [0xff, 0xd8, 0xff], mimeType: "image/jpeg" },
  { ascii: "GIF87a", mimeType: "image/gif" },
  { ascii: "GIF89a", mimeType: "image/gif" },
  { ascii: "RIFF", mimeType: "image/webp" },
];

function failMedia(message, details) {
  throw new SmallPenError("invalid_media_file", message, details);
}

function ascii(bytes, start, length) {
  return new TextDecoder("ascii").decode(bytes.slice(start, start + length));
}

// Detects an image media type from its leading signature bytes.
export function detectMediaType(bytes) {
  for (const signature of SIGNATURES) {
    if (signature.bytes) {
      if (signature.bytes.every((value, index) => bytes[index] === value)) {
        // RIFF alone is not WebP; the container must declare WEBP at offset 8.
        if (signature.mimeType === "image/webp") {
          if (ascii(bytes, 8, 4) !== "WEBP") continue;
        }
        return signature.mimeType;
      }
    } else if (ascii(bytes, 0, signature.ascii.length) === signature.ascii) {
      return signature.mimeType;
    }
  }
  if (bytes.subarray(0, 4096).some((byte) => byte === 0x3c)) {
    // A leading '<' suggests text; SVG roots are detected by inspectMedia.
    return "image/svg+xml";
  }
  return undefined;
}

function inspectPngDimensions(bytes) {
  if (
    bytes.byteLength < 24 ||
    ascii(bytes, 12, 4) !== "IHDR"
  ) {
    failMedia("PNG has an invalid signature or IHDR");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { height: view.getUint32(20), width: view.getUint32(16) };
}

function inspectJpegDimensions(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 9 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      failMedia("JPEG has a corrupt marker structure");
    }
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = view.getUint16(offset + 2);
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      const height = view.getUint16(offset + 5);
      const width = view.getUint16(offset + 7);
      if (marker === 0xc2) {
        failMedia("Progressive JPEG media is not supported for import");
      }
      if (width <= 0 || height <= 0) failMedia("JPEG dimensions are invalid");
      return { height, width };
    }
    offset += 2 + length;
  }
  failMedia("JPEG has no frame header");
}

function inspectGifDimensions(bytes) {
  if (bytes.byteLength < 10) failMedia("GIF header is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint16(6, true);
  const height = view.getUint16(8, true);
  if (width <= 0 || height <= 0) failMedia("GIF dimensions are invalid");
  return { height, width };
}

function inspectWebpDimensions(bytes) {
  if (bytes.byteLength < 30) failMedia("WebP header is truncated");
  const format = ascii(bytes, 12, 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (format === "VP8 ") {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      failMedia("WebP VP8 start code is invalid");
    }
    const width = view.getUint16(26, true) & 0x3fff;
    const height = view.getUint16(28, true) & 0x3fff;
    return { height, width };
  }
  if (format === "VP8L") {
    const bits = view.getUint32(21, true);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { height, width };
  }
  if (format === "VP8X") {
    const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
    const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
    return { height, width };
  }
  failMedia(`WebP chunk ${format} is not supported`);
}

// SVG text: reuse the same root attribute sniffing as flat draft imports.
function inspectSvgDimensions(bytes) {
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    failMedia("SVG is not valid UTF-8 text");
  }
  const root = /<svg\b[^>]*>/i.exec(source)?.[0];
  if (!root) failMedia("SVG has no svg root element");
  const attribute = (name) =>
    new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(root)?.[1];
  const length = (value) => {
    const match = /^\s*([0-9]+(?:\.[0-9]+)?)(?:px)?\s*$/i.exec(value ?? "");
    return match ? Math.round(Number(match[1])) : undefined;
  };
  let width = length(attribute("width"));
  let height = length(attribute("height"));
  const viewBox = attribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if (
    (!width || !height) &&
    viewBox?.length === 4 &&
    viewBox.every(Number.isFinite)
  ) {
    width ??= Math.round(viewBox[2]);
    height ??= Math.round(viewBox[3]);
  }
  if (
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    !Number.isSafeInteger(height) ||
    height <= 0
  ) {
    failMedia("SVG dimensions are invalid");
  }
  return { height, width };
}

// Returns { mimeType, height, width } for supported image media bytes.
export function inspectMedia(bytes, mimeType) {
  const detected = detectMediaType(bytes);
  const resolved = mimeType ?? detected;
  if (resolved !== "image/svg+xml" && detected === undefined) {
    failMedia("Media bytes do not match a supported image signature", {
      mimeType: resolved,
    });
  }
  if (resolved === undefined) {
    failMedia("Media type could not be detected");
  }
  if (resolved === "image/svg+xml") {
    return { ...inspectSvgDimensions(bytes), mimeType: resolved };
  }
  const dimensions =
    resolved === "image/png"
      ? inspectPngDimensions(bytes)
      : resolved === "image/jpeg"
        ? inspectJpegDimensions(bytes)
        : resolved === "image/gif"
          ? inspectGifDimensions(bytes)
          : resolved === "image/webp"
            ? inspectWebpDimensions(bytes)
            : failMedia(`${resolved} media is not supported`);
  return { ...dimensions, mimeType: resolved };
}
