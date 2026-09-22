import { readFile } from "node:fs/promises";
import { deflateSync, inflateSync } from "node:zlib";

import opentype from "opentype.js";

import {
  createSemanticTree,
  projectDesignView,
  resolveDesignView,
  sha256Hex,
  SmallPenError,
} from "@smallpen/core";

import { initWebpDecoder, decodeWebpSync } from "./webp-decode.mjs";

const MAX_DIMENSION = 8192;
const MAX_PIXELS = 32 * 1024 * 1024;
const CURVE_STEPS = 8;
const GLYPH_COVERAGE_EXPONENT = 1 / 1.8;
const GLYPH_SAMPLES = [0.125, 0.375, 0.625, 0.875];

const BUILTIN_FONT_FILES = new Map([
  [400, "SourceSansPro-Regular.ttf"],
  [600, "SourceSansPro-Semibold.ttf"],
  [700, "SourceSansPro-Bold.ttf"],
]);
const builtinFonts = new Map();
let symbolFont;

const NAMED_COLORS = new Map([
  ["black", [0, 0, 0, 255]],
  ["blue", [0, 0, 255, 255]],
  ["gray", [128, 128, 128, 255]],
  ["green", [0, 128, 0, 255]],
  ["grey", [128, 128, 128, 255]],
  ["red", [255, 0, 0, 255]],
  ["transparent", [0, 0, 0, 0]],
  ["white", [255, 255, 255, 255]],
]);

function clamp(value, lower, upper) {
  return Math.min(Math.max(value, lower), upper);
}

function parseHexColor(value) {
  const source = value.slice(1);
  if (![3, 4, 6, 8].includes(source.length) || !/^[a-f0-9]+$/i.test(source)) {
    return undefined;
  }
  const pairs =
    source.length <= 4
      ? [...source].map((part) => part + part)
      : source.match(/../g);
  return [
    Number.parseInt(pairs[0], 16),
    Number.parseInt(pairs[1], 16),
    Number.parseInt(pairs[2], 16),
    pairs[3] === undefined ? 255 : Number.parseInt(pairs[3], 16),
  ];
}

function parseColor(value, diagnostics, path) {
  if (typeof value !== "string") return [255, 0, 255, 255];
  const source = value.trim().toLowerCase();
  if (source.startsWith("#")) {
    const parsed = parseHexColor(source);
    if (parsed) return parsed;
  }
  if (NAMED_COLORS.has(source)) return [...NAMED_COLORS.get(source)];
  const match = /^rgba?\(([^)]+)\)$/.exec(source);
  if (match) {
    const parts = match[1].split(",").map((part) => Number(part.trim()));
    if (
      (parts.length === 3 || parts.length === 4) &&
      parts.every(Number.isFinite)
    ) {
      return [
        clamp(Math.round(parts[0]), 0, 255),
        clamp(Math.round(parts[1]), 0, 255),
        clamp(Math.round(parts[2]), 0, 255),
        parts[3] === undefined
          ? 255
          : clamp(Math.round(parts[3] * 255), 0, 255),
      ];
    }
  }
  diagnostics.push({
    code: "unsupported_render_color",
    message: `Renderer substituted unsupported color ${value}`,
    path,
  });
  return [255, 0, 255, 255];
}

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

function encodePng(width, height, pixels) {
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const target = row * (width * 4 + 1);
    scanlines[target] = 0;
    Buffer.from(
      pixels.buffer,
      pixels.byteOffset + row * width * 4,
      width * 4,
    ).copy(scanlines, target + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk("IHDR", header),
      pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

function multiply(left, right) {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function translate(x, y) {
  return [1, 0, 0, 1, x, y];
}

function nodeTransform(node) {
  const angle = ((node.rotation ?? 0) * Math.PI) / 180;
  const cosine = Math.cos(angle) * (node.flipX ? -1 : 1);
  const sine = Math.sin(angle) * (node.flipX ? -1 : 1);
  const vertical = node.flipY ? -1 : 1;
  const centered = multiply(
    translate(node.width / 2, node.height / 2),
    [cosine, sine, -Math.sin(angle) * vertical, Math.cos(angle) * vertical, 0, 0],
  );
  return multiply(
    translate(node.x, node.y),
    multiply(centered, translate(-node.width / 2, -node.height / 2)),
  );
}

function inverse(matrix) {
  const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
  if (Math.abs(determinant) < 1e-12) return undefined;
  return [
    matrix[3] / determinant,
    -matrix[1] / determinant,
    -matrix[2] / determinant,
    matrix[0] / determinant,
    (matrix[2] * matrix[5] - matrix[3] * matrix[4]) / determinant,
    (matrix[1] * matrix[4] - matrix[0] * matrix[5]) / determinant,
  ];
}

function point(matrix, x, y) {
  return {
    x: matrix[0] * x + matrix[2] * y + matrix[4],
    y: matrix[1] * x + matrix[3] * y + matrix[5],
  };
}

function transformedBounds(matrix, width, height) {
  const corners = [
    point(matrix, 0, 0),
    point(matrix, width, 0),
    point(matrix, 0, height),
    point(matrix, width, height),
  ];
  return {
    bottom: Math.max(...corners.map(({ y }) => y)),
    left: Math.min(...corners.map(({ x }) => x)),
    right: Math.max(...corners.map(({ x }) => x)),
    top: Math.min(...corners.map(({ y }) => y)),
  };
}

function blend(pixels, index, color, opacity) {
  const sourceAlpha = clamp((color[3] / 255) * opacity, 0, 1);
  const targetAlpha = pixels[index + 3] / 255;
  const outputAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
  if (outputAlpha <= 0) return;
  for (let channel = 0; channel < 3; channel += 1) {
    pixels[index + channel] = Math.round(
      (color[channel] * sourceAlpha +
        pixels[index + channel] * targetAlpha * (1 - sourceAlpha)) /
        outputAlpha,
    );
  }
  pixels[index + 3] = Math.round(outputAlpha * 255);
}

function fontIdentity(value) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, "");
}

function nearestWeight(weight, choices) {
  return [...choices].sort(
    (left, right) =>
      Math.abs(left - weight) - Math.abs(right - weight) || right - left,
  )[0];
}

function parseFont(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return opentype.parse(
    view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength),
  );
}

async function loadBuiltinFont(weight) {
  if (!builtinFonts.has(weight)) {
    builtinFonts.set(
      weight,
      readFile(
        new URL(`../assets/fonts/${BUILTIN_FONT_FILES.get(weight)}`, import.meta.url),
      ).then(parseFont),
    );
  }
  return builtinFonts.get(weight);
}

async function loadSymbolFont() {
  symbolFont ??= readFile(
    new URL("../assets/fonts/WorkSans-Regular.ttf", import.meta.url),
  ).then(parseFont);
  return symbolFont;
}

async function createFontLibrary(product, foundation, libraries, diagnostics) {
  const builtins = new Map(
    await Promise.all(
      [...BUILTIN_FONT_FILES.keys()].map(async (weight) => [
        weight,
        await loadBuiltinFont(weight),
      ]),
    ),
  );
  const custom = [];
  for (const snapshot of [foundation, ...libraries, product]) {
    if (!snapshot) continue;
    for (const entry of snapshot.manifest.entries.assets) {
      for (const family of snapshot.entries[entry].fonts ?? []) {
        for (const variant of family.variants) {
          const descriptor =
            variant.files.ttf ?? variant.files.otf ?? variant.files.woff;
          const bytes = descriptor && snapshot.blobs?.get(descriptor.blob);
          if (!bytes) continue;
          try {
            custom.push({
              family: fontIdentity(family.family),
              font: parseFont(bytes),
              id: fontIdentity(family.id),
              style: variant.style,
              weight: variant.weight,
            });
          } catch (cause) {
            diagnostics.push({
              code: "font_render_parse_failed",
              message: `Renderer could not parse ${family.family} ${variant.name}`,
              path: `${entry}.fonts.${family.id}.${variant.id}`,
            });
          }
        }
      }
    }
  }
  const symbols = await loadSymbolFont();
  return { builtins, custom, symbols };
}

function resolveFont(state, style, nodeId, path) {
  const id = fontIdentity(style.fontId);
  const family = fontIdentity(style.fontFamily);
  const weight = Number(style.fontWeight ?? 400);
  const variantStyle = style.fontStyle ?? "normal";
  const familyCandidates = state.fonts.custom.filter(
    (item) => item.id === id || item.family === family,
  );
  const styleCandidates = familyCandidates.filter(
    (item) => item.style === variantStyle,
  );
  const candidates = styleCandidates.length > 0 ? styleCandidates : familyCandidates;
  if (candidates.length > 0) {
    const selectedWeight = nearestWeight(
      weight,
      candidates.map((item) => item.weight),
    );
    return candidates.find((item) => item.weight === selectedWeight).font;
  }
  const selectedWeight = nearestWeight(weight, state.fonts.builtins.keys());
  if (
    id !== "sourcesanspro" &&
    family !== "sourcesanspro" &&
    family !== "sourcesanspro2"
  ) {
    const key = `${nodeId}:${id || family}`;
    if (!state.fontFallbacks.has(key)) {
      state.fontFallbacks.add(key);
      state.diagnostics.push({
        code: "font_render_fallback",
        message: `Renderer substituted Source Sans Pro for ${style.fontFamily ?? style.fontId ?? "unknown font"}`,
        nodeId,
        path,
      });
    }
  }
  return state.fonts.builtins.get(selectedWeight);
}

function addCurvePoints(contour, command, current) {
  for (let step = 1; step <= CURVE_STEPS; step += 1) {
    const amount = step / CURVE_STEPS;
    const inverseAmount = 1 - amount;
    if (command.type === "Q") {
      contour.push({
        x:
          inverseAmount * inverseAmount * current.x +
          2 * inverseAmount * amount * command.x1 +
          amount * amount * command.x,
        y:
          inverseAmount * inverseAmount * current.y +
          2 * inverseAmount * amount * command.y1 +
          amount * amount * command.y,
      });
    } else {
      contour.push({
        x:
          inverseAmount ** 3 * current.x +
          3 * inverseAmount * inverseAmount * amount * command.x1 +
          3 * inverseAmount * amount * amount * command.x2 +
          amount ** 3 * command.x,
        y:
          inverseAmount ** 3 * current.y +
          3 * inverseAmount * inverseAmount * amount * command.y1 +
          3 * inverseAmount * amount * amount * command.y2 +
          amount ** 3 * command.y,
      });
    }
  }
}

function flattenPath(path) {
  const contours = [];
  let contour = [];
  let current;
  for (const command of path.commands) {
    if (command.type === "M") {
      if (contour.length > 2) contours.push(contour);
      contour = [{ x: command.x, y: command.y }];
      current = contour[0];
    } else if (command.type === "L") {
      current = { x: command.x, y: command.y };
      contour.push(current);
    } else if ((command.type === "Q" || command.type === "C") && current) {
      addCurvePoints(contour, command, current);
      current = contour.at(-1);
    } else if (command.type === "Z") {
      if (contour.length > 2) contours.push(contour);
      contour = [];
      current = undefined;
    }
  }
  if (contour.length > 2) contours.push(contour);
  return contours;
}

function contourBounds(contours) {
  const points = contours.flat();
  return {
    bottom: Math.max(...points.map(({ y }) => y)),
    left: Math.min(...points.map(({ x }) => x)),
    right: Math.max(...points.map(({ x }) => x)),
    top: Math.min(...points.map(({ y }) => y)),
  };
}

function transformedRectangleBounds(matrix, bounds) {
  const corners = [
    point(matrix, bounds.left, bounds.top),
    point(matrix, bounds.right, bounds.top),
    point(matrix, bounds.left, bounds.bottom),
    point(matrix, bounds.right, bounds.bottom),
  ];
  return {
    bottom: Math.max(...corners.map(({ y }) => y)),
    left: Math.min(...corners.map(({ x }) => x)),
    right: Math.max(...corners.map(({ x }) => x)),
    top: Math.min(...corners.map(({ y }) => y)),
  };
}

function windingNumber(contours, x, y) {
  let winding = 0;
  for (const contour of contours) {
    for (let index = 0; index < contour.length; index += 1) {
      const start = contour[index];
      const end = contour[(index + 1) % contour.length];
      const cross =
        (end.x - start.x) * (y - start.y) -
        (x - start.x) * (end.y - start.y);
      if (start.y <= y && end.y > y && cross > 0) winding += 1;
      if (start.y > y && end.y <= y && cross < 0) winding -= 1;
    }
  }
  return winding;
}

function contourWindingCount(contours, x, y) {
  // Parity test for SVG fill-rule="evenodd": counts crossings, not signed winding.
  let crossings = 0;
  for (const contour of contours) {
    for (let index = 0; index < contour.length; index += 1) {
      const start = contour[index];
      const end = contour[(index + 1) % contour.length];
      if (
        (start.y <= y && end.y > y) ||
        (start.y > y && end.y <= y)
      ) {
        const intersectX =
          start.x + ((y - start.y) / (end.y - start.y)) * (end.x - start.x);
        if (intersectX > x) crossings += 1;
      }
    }
  }
  return crossings;
}

const PATH_CURVE_STEPS = 16;
const PATH_TOKEN =
  /[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;

function arcToCubicSegments(current, rx, ry, angleDegrees, largeArc, sweep, next) {
  if (
    current.x === next.x &&
    current.y === next.y ||
    rx === 0 ||
    ry === 0
  ) {
    return [];
  }
  const angle = (angleDegrees * Math.PI) / 180;
  const cosAngle = Math.cos(angle);
  const sinAngle = Math.sin(angle);
  let radiusX = Math.abs(rx);
  let radiusY = Math.abs(ry);
  const deltaX = (current.x - next.x) / 2;
  const deltaY = (current.y - next.y) / 2;
  const transformedX = cosAngle * deltaX + sinAngle * deltaY;
  const transformedY = -sinAngle * deltaX + cosAngle * deltaY;
  const radiusCheck =
    (transformedX * transformedX) / (radiusX * radiusX) +
    (transformedY * transformedY) / (radiusY * radiusY);
  if (radiusCheck > 1) {
    const scale = Math.sqrt(radiusCheck);
    radiusX *= scale;
    radiusY *= scale;
  }
  const sign = largeArc !== sweep ? 1 : -1;
  const numerator =
    radiusX * radiusX * radiusY * radiusY -
    radiusX * radiusX * transformedY * transformedY -
    radiusY * radiusY * transformedX * transformedX;
  const denominator =
    radiusX * radiusX * transformedY * transformedY +
    radiusY * radiusY * transformedX * transformedX;
  const centerCoefficient = sign * Math.sqrt(Math.max(0, numerator / denominator));
  const centerPrimeX = (centerCoefficient * radiusX * transformedY) / radiusY;
  const centerPrimeY = (-centerCoefficient * radiusY * transformedX) / radiusX;
  const centerX =
    cosAngle * centerPrimeX - sinAngle * centerPrimeY + (current.x + next.x) / 2;
  const centerY =
    sinAngle * centerPrimeX + cosAngle * centerPrimeY + (current.y + next.y) / 2;
  const startVector = {
    x: (transformedX - centerPrimeX) / radiusX,
    y: (transformedY - centerPrimeY) / radiusY,
  };
  const endVector = {
    x: (-transformedX - centerPrimeX) / radiusX,
    y: (-transformedY - centerPrimeY) / radiusY,
  };
  const startAngle = Math.atan2(startVector.y, startVector.x);
  let endAngle = Math.atan2(endVector.y, endVector.x);
  let span = endAngle - startAngle;
  if (!sweep && span > 0) span -= 2 * Math.PI;
  if (sweep && span < 0) span += 2 * Math.PI;
  const segmentCount = Math.max(1, Math.ceil(Math.abs(span) / (Math.PI / 4)));
  const segments = [];
  const delta = span / segmentCount;
  const coefficient = (4 / 3) * Math.tan(delta / 4);
  let angleCursor = startAngle;
  for (let index = 0; index < segmentCount; index += 1) {
    const nextAngle = angleCursor + delta;
    const startCos = Math.cos(angleCursor);
    const startSin = Math.sin(angleCursor);
    const endCos = Math.cos(nextAngle);
    const endSin = Math.sin(nextAngle);
    const toPoint = (cosine, sine) => ({
      x: centerX +
        radiusX * cosine * cosAngle -
        radiusY * sine * sinAngle,
      y: centerY +
        radiusX * cosine * sinAngle +
        radiusY * sine * cosAngle,
    });
    const toControl = (cosine, sine, amount) => ({
      x: centerX +
        radiusX * (cosine - amount * sine) * cosAngle -
        radiusY * (sine + amount * cosine) * sinAngle,
      y: centerY +
        radiusX * (cosine - amount * sine) * sinAngle +
        radiusY * (sine + amount * cosine) * cosAngle,
    });
    segments.push({
      x1: toControl(startCos, startSin, coefficient).x,
      y1: toControl(startCos, startSin, coefficient).y,
      x2: toControl(endCos, endSin, -coefficient).x,
      y2: toControl(endCos, endSin, -coefficient).y,
      x: toPoint(endCos, endSin).x,
      y: toPoint(endCos, endSin).y,
    });
    angleCursor = nextAngle;
  }
  return segments;
}

// Parses the full SVG path grammar (M L H V C S Q T A Z, absolute and relative)
// into flattened contours and polyline segments. Used for canonical PATH nodes
// and SVG media paths.
function parsePathData(value) {
  if (typeof value !== "string") return undefined;
  const tokens = value.match(PATH_TOKEN);
  if (!tokens) return undefined;
  const segments = [];
  const contours = [];
  const closedContours = [];
  let contour = [];
  let command;
  let index = 0;
  let cursor = { x: 0, y: 0 };
  let subpathStart = cursor;
  let previousControl;
  const readNumber = () => {
    const token = tokens[index++];
    const parsed = Number.parseFloat(token);
    if (!Number.isFinite(parsed)) throw new Error(`invalid path number ${token}`);
    return parsed;
  };
  const pushLine = (next) => {
    segments.push({ end: next, start: cursor });
    contour.push(next);
    cursor = next;
  };
  const pushCubic = (cubic, current) => {
    for (let step = 1; step <= PATH_CURVE_STEPS; step += 1) {
      const amount = step / PATH_CURVE_STEPS;
      const inverseAmount = 1 - amount;
      contour.push({
        x:
          inverseAmount ** 3 * current.x +
          3 * inverseAmount * inverseAmount * amount * cubic.x1 +
          3 * inverseAmount * amount * amount * cubic.x2 +
          amount ** 3 * cubic.x,
        y:
          inverseAmount ** 3 * current.y +
          3 * inverseAmount * inverseAmount * amount * cubic.y1 +
          3 * inverseAmount * amount * amount * cubic.y2 +
          amount ** 3 * cubic.y,
      });
    }
    segments.push({ end: contour.at(-1), start: current });
    return contour.at(-1);
  };
  try {
    while (index < tokens.length) {
      if (/^[a-zA-Z]$/.test(tokens[index])) command = tokens[index++];
      else if (!command) return undefined;
      const relative = command === command.toLowerCase();
      const normalized = command.toUpperCase();
      const reflect = (x, y) =>
        previousControl
          ? { x: 2 * cursor.x - previousControl.x, y: 2 * cursor.y - previousControl.y }
          : { x: cursor.x, y: cursor.y };
      if (normalized === "Z") {
        if (contour.length > 0) {
          segments.push({ end: subpathStart, start: cursor });
          if (contour.length > 2) {
            contours.push(contour);
            closedContours.push(true);
          }
        }
        contour = [];
        cursor = subpathStart;
        command = undefined;
        previousControl = undefined;
      } else if (normalized === "M") {
        if (contour.length > 2) {
          contours.push(contour);
          closedContours.push(false);
        }
        contour = [];
        const next = {
          x: readNumber() + (relative ? cursor.x : 0),
          y: readNumber() + (relative ? cursor.y : 0),
        };
        contour.push(next);
        cursor = next;
        subpathStart = next;
        previousControl = undefined;
        command = relative ? "l" : "L";
      } else if (normalized === "L") {
        pushLine({
          x: readNumber() + (relative ? cursor.x : 0),
          y: readNumber() + (relative ? cursor.y : 0),
        });
        previousControl = undefined;
      } else if (normalized === "H") {
        pushLine({ x: readNumber() + (relative ? cursor.x : 0), y: cursor.y });
        previousControl = undefined;
      } else if (normalized === "V") {
        pushLine({ x: cursor.x, y: readNumber() + (relative ? cursor.y : 0) });
        previousControl = undefined;
      } else if (normalized === "C") {
        const cubic = {
          x1: readNumber() + (relative ? cursor.x : 0),
          y1: readNumber() + (relative ? cursor.y : 0),
          x2: readNumber() + (relative ? cursor.x : 0),
          y2: readNumber() + (relative ? cursor.y : 0),
          x: readNumber() + (relative ? cursor.x : 0),
          y: readNumber() + (relative ? cursor.y : 0),
        };
        previousControl = { x: cubic.x2, y: cubic.y2 };
        cursor = pushCubic(cubic, cursor);
      } else if (normalized === "S") {
        const first = reflect(cursor.x, cursor.y);
        const cubic = {
          x1: first.x,
          y1: first.y,
          x2: readNumber() + (relative ? cursor.x : 0),
          y2: readNumber() + (relative ? cursor.y : 0),
          x: readNumber() + (relative ? cursor.x : 0),
          y: readNumber() + (relative ? cursor.y : 0),
        };
        previousControl = { x: cubic.x2, y: cubic.y2 };
        cursor = pushCubic(cubic, cursor);
      } else if (normalized === "Q") {
        const control = {
          x: readNumber() + (relative ? cursor.x : 0),
          y: readNumber() + (relative ? cursor.y : 0),
        };
        const cubic = {
          x1: control.x,
          y1: control.y,
          x2: control.x,
          y2: control.y,
          x: readNumber() + (relative ? cursor.x : 0),
          y: readNumber() + (relative ? cursor.y : 0),
        };
        previousControl = control;
        cursor = pushCubic(cubic, cursor);
      } else if (normalized === "T") {
        const control = reflect(cursor.x, cursor.y);
        const cubic = {
          x1: control.x,
          y1: control.y,
          x2: control.x,
          y2: control.y,
          x: readNumber() + (relative ? cursor.x : 0),
          y: readNumber() + (relative ? cursor.y : 0),
        };
        previousControl = control;
        cursor = pushCubic(cubic, cursor);
      } else if (normalized === "A") {
        const rx = readNumber();
        const ry = readNumber();
        const rotation = readNumber();
        const largeArc = readNumber() !== 0;
        const sweep = readNumber() !== 0;
        const next = {
          x: readNumber() + (relative ? cursor.x : 0),
          y: readNumber() + (relative ? cursor.y : 0),
        };
        for (const cubic of arcToCubicSegments(
          cursor,
          rx,
          ry,
          rotation,
          largeArc,
          sweep,
          next,
        )) {
          cursor = pushCubic(cubic, cursor);
        }
        cursor = next;
        previousControl = undefined;
      } else {
        return undefined;
      }
    }
  } catch {
    return undefined;
  }
  if (contour.length > 2) {
    contours.push(contour);
    closedContours.push(false);
  }
  if (segments.length === 0) return undefined;
  const cumulative = [];
  let totalLength = 0;
  for (const segment of segments) {
    totalLength += Math.hypot(segment.end.x - segment.start.x, segment.end.y - segment.start.y);
    cumulative.push(totalLength);
  }
  return {
    closedContours,
    contours,
    cumulative,
    end: segments.at(-1).end,
    segments,
    start: segments[0].start,
    totalLength,
  };
}

function directionAt(geometry, position) {
  const index = Math.min(
    geometry.segments.length - 1,
    typeof position === "object" ? position.segmentIndex ?? 0 : position,
  );
  const segment = geometry.segments[index];
  const dx = segment.end.x - segment.start.x;
  const dy = segment.end.y - segment.start.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: dx / length, y: dy / length };
}

function pathFillContains(geometry, x, y, evenOdd = false) {
  return evenOdd
    ? contourWindingCount(geometry.contours, x, y) % 2 === 1
    : windingNumber(geometry.contours, x, y) !== 0;
}

function dashPattern(stroke, width) {
  const style = stroke.style ?? "solid";
  if (style === "solid") return undefined;
  const scale = Math.max(1, width);
  if (style === "dashed") {
    return { on: stroke.dash ?? scale * 3, period: (stroke.dash ?? scale * 3) + (stroke.gap ?? scale * 3) };
  }
  if (style === "dotted") {
    const on = stroke.dash ?? scale;
    return { on, period: on + (stroke.gap ?? scale) };
  }
  // "mixed": dash, gap, dot, gap — deterministic alternating pattern.
  const dash = stroke.dash ?? scale * 3;
  const dot = scale;
  const gap = stroke.gap ?? scale * 2;
  return { on: dash, period: dash + gap + dot + gap, mixed: { dash, dot, gap } };
}

function dashOnAt(pattern, distance) {
  if (!pattern) return true;
  let offset = distance % pattern.period;
  if (offset < 0) offset += pattern.period;
  if (!pattern.mixed) return offset < pattern.on;
  if (offset < pattern.mixed.dash) return true;
  offset -= pattern.mixed.dash + pattern.mixed.gap;
  if (offset < 0) return false;
  return offset < pattern.mixed.dot;
}

function pathStrokeContains(
  geometry,
  x,
  y,
  width,
  pattern,
  alignment,
  fillInside,
) {
  const halfWidth = alignment === "center" || alignment === undefined
    ? width / 2
    : width;
  for (let index = 0; index < geometry.segments.length; index += 1) {
    const segment = geometry.segments[index];
    const dx = segment.end.x - segment.start.x;
    const dy = segment.end.y - segment.start.y;
    const lengthSquared = dx * dx + dy * dy;
    const amount = lengthSquared === 0
      ? 0
      : clamp(((x - segment.start.x) * dx + (y - segment.start.y) * dy) / lengthSquared, 0, 1);
    const distance = Math.hypot(
      x - (segment.start.x + amount * dx),
      y - (segment.start.y + amount * dy),
    );
    if (distance > halfWidth) continue;
    const startLength = index === 0
      ? 0
      : geometry.cumulative[index - 1];
    if (!dashOnAt(pattern, startLength + amount * Math.sqrt(lengthSquared))) {
      continue;
    }
    if (alignment === "inner" && !fillInside) continue;
    if (alignment === "outer" && fillInside) continue;
    return true;
  }
  return false;
}

const MARKER_SIDES = 24;

function markerGeometry(cap, point, direction, width) {
  const size = Math.max(3, width * 2.5);
  const normal = { x: -direction.y, y: direction.x };
  const at = (along, across) => ({
    x: point.x + direction.x * along + normal.x * across,
    y: point.y + direction.y * along + normal.y * across,
  });
  if (cap === "round") {
    const radius = width / 2;
    const contour = [];
    for (let index = 0; index < MARKER_SIDES; index += 1) {
      const angle = (index / MARKER_SIDES) * Math.PI * 2;
      contour.push({
        x: point.x + Math.cos(angle) * radius,
        y: point.y + Math.sin(angle) * radius,
      });
    }
    return { contours: [contour], segments: [] };
  }
  if (cap === "square") {
    const half = width / 2;
    return {
      contours: [[
        at(0, -half),
        at(half, -half),
        at(half, half),
        at(0, half),
      ]],
      segments: [],
    };
  }
  if (cap === "triangle-arrow") {
    const length = Math.max(6, width * 4);
    const half = size * 0.9;
    return {
      contours: [[
        point,
        at(-length, half),
        at(-length, -half),
      ]],
      segments: [],
    };
  }
  if (cap === "circle-marker") {
    const contour = [];
    for (let index = 0; index < MARKER_SIDES; index += 1) {
      const angle = (index / MARKER_SIDES) * Math.PI * 2;
      contour.push({
        x: point.x + Math.cos(angle) * size,
        y: point.y + Math.sin(angle) * size,
      });
    }
    return { contours: [contour], segments: [] };
  }
  if (cap === "square-marker") {
    return {
      contours: [[
        at(-size, size),
        at(-size, -size),
        at(size, -size),
        at(size, size),
      ]],
      segments: [],
    };
  }
  if (cap === "diamond-marker") {
    return {
      contours: [[
        at(0, size),
        at(-size, 0),
        at(0, -size),
        at(size, 0),
      ]],
      segments: [],
    };
  }
  if (cap === "line-arrow") {
    const length = Math.max(6, width * 4);
    const spread = Math.PI / 7;
    const back = {
      x: -direction.x * Math.cos(spread) - -direction.y * Math.sin(spread),
      y: -direction.y * Math.cos(spread) + -direction.x * Math.sin(spread),
    };
    const backOther = {
      x: -direction.x * Math.cos(spread) - direction.y * Math.sin(spread),
      y: -direction.y * Math.cos(spread) + direction.x * Math.sin(spread),
    };
    return {
      contours: [],
      segments: [
        {
          end: { x: point.x + back.x * length, y: point.y + back.y * length },
          start: point,
        },
        {
          end: {
            x: point.x + backOther.x * length,
            y: point.y + backOther.y * length,
          },
          start: point,
        },
      ],
    };
  }
  return undefined;
}

function capExtensions(geometry, width, pattern) {
  // "square" caps extend the open ends by half the stroke width; "round" caps
  // already fall out of the distance test.
  if (!pattern && width <= 0) return undefined;
  const segments = [];
  const half = width / 2;
  const first = geometry.segments[0];
  if (first) {
    const direction = directionAt(geometry, { segmentIndex: 0 });
    segments.push({
      end: first.start,
      start: {
        x: first.start.x - direction.x * half,
        y: first.start.y - direction.y * half,
      },
    });
  }
  const last = geometry.segments.at(-1);
  if (last) {
    const direction = directionAt(geometry, {
      segmentIndex: geometry.segments.length - 1,
    });
    segments.push({
      end: {
        x: last.end.x + direction.x * half,
        y: last.end.y + direction.y * half,
      },
      start: last.end,
    });
  }
  return segments.length ? { contours: [], segments } : undefined;
}

const WHITESPACE = /\s/u;

function spaceAdvance(font) {
  const space = font.charToGlyph(" ");
  const advance = space.advanceWidth ?? 0;
  return advance > 0 ? advance : font.unitsPerEm * 0.25;
}

function lineGlyphs(
  font,
  symbolFont,
  text,
  x,
  baseline,
  size,
  letterSpacing,
  outlines = true,
  missing,
) {
  const glyphs = [...text].map((character) => {
    if (WHITESPACE.test(character)) {
      // Whitespace never draws ink, even when the font lacks the codepoint.
      return {
        advanceWidth: spaceAdvance(font),
        font,
        glyph: font.charToGlyph(" "),
        whitespace: true,
      };
    }
    const glyph = font.charToGlyph(character);
    if (glyph.index === 0 && symbolFont.charToGlyphIndex(character) !== 0) {
      return {
        advanceWidth: symbolFont.unitsPerEm,
        font: symbolFont,
        glyph: symbolFont.charToGlyph(character),
      };
    }
    if (glyph.index === 0) {
      missing?.add(character);
      return {
        advanceWidth: spaceAdvance(font),
        font,
        glyph,
        missing: true,
      };
    }
    return { font, glyph };
  });
  const result = [];
  let cursor = x;
  for (let index = 0; index < glyphs.length; index += 1) {
    const { advanceWidth, font: glyphFont, glyph, missing: isMissing, whitespace } = glyphs[index];
    if (index > 0 && glyphs[index - 1].font === glyphFont) {
      cursor +=
        (glyphFont.getKerningValue(glyphs[index - 1].glyph, glyph) * size) /
        glyphFont.unitsPerEm;
    }
    if (outlines && !isMissing && !whitespace) {
      const contours = flattenPath(glyph.getPath(cursor, baseline, size));
      if (contours.length > 0) result.push({ bounds: contourBounds(contours), contours });
    }
    cursor +=
      ((advanceWidth ?? glyph.advanceWidth ?? glyphFont.unitsPerEm) * size) /
        glyphFont.unitsPerEm +
      letterSpacing;
  }
  return { glyphs: result, width: Math.max(0, cursor - x - letterSpacing) };
}

function wrapTextLines(source, width, measure) {
  const lines = [];
  for (const paragraph of source.split("\n")) {
    let line = "";
    // Preserve spaces and tabs, allowing a break after each (break-spaces).
    // Runs without these break opportunities keep their existing overflow.
    for (const run of paragraph.split(/(?<=[ \t])/u)) {
      const candidate = line + run;
      if (line && measure(candidate) > width) {
        lines.push(line);
        line = run;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}

function typographicAscender(font) {
  const value = Number(font.tables?.os2?.sTypoAscender);
  return Number.isFinite(value) && value > 0 ? value : font.ascender;
}

function renderGlyph(
  state,
  node,
  matrix,
  inverseMatrix,
  glyph,
  color,
  opacity,
  clips,
) {
  const bounds = transformedRectangleBounds(matrix, glyph.bounds);
  const left = clamp(Math.floor(bounds.left * state.scale), 0, state.width);
  const right = clamp(Math.ceil(bounds.right * state.scale), 0, state.width);
  const top = clamp(Math.floor(bounds.top * state.scale), 0, state.height);
  const bottom = clamp(Math.ceil(bounds.bottom * state.scale), 0, state.height);
  for (let pixelY = top; pixelY < bottom; pixelY += 1) {
    for (let pixelX = left; pixelX < right; pixelX += 1) {
      let covered = 0;
      for (const sampleY of GLYPH_SAMPLES) {
        for (const sampleX of GLYPH_SAMPLES) {
          const local = point(
            inverseMatrix,
            (pixelX + sampleX) / state.scale,
            (pixelY + sampleY) / state.scale,
          );
          if (
            local.x >= 0 &&
            local.y >= 0 &&
            local.x <= node.width &&
            local.y <= node.height &&
            windingNumber(glyph.contours, local.x, local.y) !== 0 &&
            clipsAllow(clips, (pixelX + sampleX) / state.scale, (pixelY + sampleY) / state.scale)
          ) {
            covered += 1;
          }
        }
      }
      if (covered > 0) {
        const coverage =
          covered / (GLYPH_SAMPLES.length * GLYPH_SAMPLES.length);
        blend(
          state.pixels,
          (pixelY * state.width + pixelX) * 4,
          color,
          opacity * coverage ** GLYPH_COVERAGE_EXPONENT,
        );
      }
    }
  }
}

function renderTextDecoration(
  state,
  node,
  matrix,
  inverseMatrix,
  font,
  style,
  x,
  baseline,
  width,
  color,
  opacity,
  clips,
) {
  const underline = style.textDecoration === "underline";
  if (!underline && style.textDecoration !== "line-through") return;
  if (width <= 0) return;
  const size = Number(style.fontSize ?? 14);
  const units = size / font.unitsPerEm;
  const metricPosition = Number(
    underline
      ? font.tables?.post?.underlinePosition
      : font.tables?.os2?.yStrikeoutPosition,
  );
  const metricThickness = Number(
    underline
      ? font.tables?.post?.underlineThickness
      : font.tables?.os2?.yStrikeoutSize,
  );
  const position = Number.isFinite(metricPosition)
    ? metricPosition * units
    : size * (underline ? -0.1 : 0.3);
  const thickness = Math.max(
    1,
    Number.isFinite(metricThickness) && metricThickness > 0
      ? metricThickness * units
      : size * 0.05,
  );
  const top = baseline - position - thickness / 2;
  const bounds = { bottom: top + thickness, left: x, right: x + width, top };
  const contours = [
    [
      { x: bounds.left, y: bounds.top },
      { x: bounds.right, y: bounds.top },
      { x: bounds.right, y: bounds.bottom },
      { x: bounds.left, y: bounds.bottom },
    ],
  ];
  renderGlyph(
    state,
    node,
    matrix,
    inverseMatrix,
    { bounds, contours },
    color,
    opacity,
    clips,
  );
}

function richTextRun(state, node, style, fills, path) {
  const font = resolveFont(state, style, node.id, path);
  const size = Number(style.fontSize ?? 14);
  const height = Number(style.lineHeight ?? 1.2);
  const lineHeight = height <= 4 ? size * height : height;
  const ascent =
    (lineHeight - size) / 2 +
    (typographicAscender(font) * size) / font.unitsPerEm;
  const color = fills?.[0]
    ? paintColor(
        fills[0],
        0,
        0,
        node,
        state.colors,
        state.diagnostics,
        path,
        state.productPackageId,
      )
    : [32, 33, 36, 255];
  return {
    ascent,
    color,
    descent: lineHeight - ascent,
    font,
    size,
    spacing: Number(style.letterSpacing ?? 0),
    style,
  };
}

function richLineLayout(characters) {
  let width = 0;
  let previous;
  const placed = characters.map((character) => {
    if (previous) {
      width += previous.run.spacing;
      if (
        previous.font === character.font &&
        previous.run.size === character.run.size
      ) {
        width +=
          (character.font.getKerningValue(previous.glyph, character.glyph) *
            character.run.size) /
          character.font.unitsPerEm;
      }
    }
    const x = width;
    width += character.advance;
    previous = character;
    return { ...character, x };
  });
  return { placed, width: Math.max(0, width) };
}

function richTextLines(state, node, path, missing) {
  const lines = [];
  for (const block of node.textBlocks) {
    const blockStyle = {
      ...(node.textStyle ?? {}),
      ...(block.textStyle ?? {}),
    };
    const paragraphs = [{ characters: [], emptyRun: undefined }];
    for (const sourceRun of block.runs ?? []) {
      const style = { ...blockStyle, ...(sourceRun.textStyle ?? {}) };
      const run = richTextRun(
        state,
        node,
        style,
        sourceRun.fills ?? node.fills,
        path,
      );
      const source =
        style.textTransform === "uppercase"
          ? sourceRun.text.toUpperCase()
          : style.textTransform === "lowercase"
            ? sourceRun.text.toLowerCase()
            : sourceRun.text;
      paragraphs.at(-1).emptyRun ??= run;
      for (const character of source) {
        if (character === "\n") {
          paragraphs.push({ characters: [], emptyRun: run });
          continue;
        }
        if (WHITESPACE.test(character)) {
          paragraphs
            .at(-1)
            .characters.push({
              character,
              run,
              font: run.font,
              glyph: run.font.charToGlyph(" "),
              advance: (spaceAdvance(run.font) * run.size) / run.font.unitsPerEm,
              whitespace: true,
            });
          continue;
        }
        let font = run.font;
        let glyph = font.charToGlyph(character);
        let advanceWidth = glyph.advanceWidth ?? font.unitsPerEm;
        if (
          glyph.index === 0 &&
          state.fonts.symbols.charToGlyphIndex(character) !== 0
        ) {
          font = state.fonts.symbols;
          glyph = font.charToGlyph(character);
          advanceWidth = font.unitsPerEm;
        } else if (glyph.index === 0) {
          missing?.add(character);
          advanceWidth = spaceAdvance(font);
        }
        paragraphs
          .at(-1)
          .characters.push({
            character,
            run,
            font,
            glyph,
            whitespace: glyph.index === 0,
            advance: (advanceWidth * run.size) / font.unitsPerEm,
          });
      }
    }
    const finish = (characters, emptyRun) => {
      const runs = characters.length
        ? characters.map(({ run }) => run)
        : [emptyRun ?? richTextRun(state, node, blockStyle, node.fills, path)];
      const ascent = runs.reduce(
        (maximum, run) => Math.max(maximum, run.ascent),
        -Infinity,
      );
      const descent = runs.reduce(
        (maximum, run) => Math.max(maximum, run.descent),
        -Infinity,
      );
      lines.push({
        ...richLineLayout(characters),
        ascent,
        height: ascent + descent,
        align: blockStyle.textAlign,
      });
    };
    for (const paragraph of paragraphs) {
      let line = [];
      let word = [];
      const appendWord = () => {
        const candidate = line.concat(word);
        if (
          line.length &&
          node.growType !== "auto-width" &&
          richLineLayout(candidate).width > node.width
        ) {
          finish(line);
          line = word;
        } else {
          line = candidate;
        }
        word = [];
      };
      for (const character of paragraph.characters) {
        word.push(character);
        if (character.character === " " || character.character === "\t")
          appendWord();
      }
      if (word.length) appendWord();
      finish(line, paragraph.emptyRun);
    }
  }
  return lines;
}

function renderRichText(state, node, matrix, opacity, path, clips) {
  const inverseMatrix = inverse(matrix);
  if (!inverseMatrix) return;
  const missing = new Set();
  const lines = richTextLines(state, node, path, missing);
  if (missing.size > 0) recordMissingGlyphs(state, node, path, missing);
  const height = lines.reduce((sum, line) => sum + line.height, 0);
  if (node.growType === "auto-height" && height > node.height) {
    node.height = height;
  }
  let top =
    node.textStyle?.verticalAlign === "center"
      ? (node.height - height) / 2
      : node.textStyle?.verticalAlign === "bottom"
        ? node.height - height
        : 0;
  for (const line of lines) {
    const x =
      line.align === "center"
        ? (node.width - line.width) / 2
        : line.align === "right"
          ? node.width - line.width
          : 0;
    const baseline = top + line.ascent;
    const spans = [];
    for (const character of line.placed) {
      const { run } = character;
      if (character.whitespace) {
        pushRichSpan(spans, run, character.x, character.x + character.advance);
        continue;
      }
      const contours = flattenPath(
        character.glyph.getPath(x + character.x, baseline, run.size),
      );
      if (contours.length) {
        renderGlyph(
          state,
          node,
          matrix,
          inverseMatrix,
          { bounds: contourBounds(contours), contours },
          run.color,
          opacity,
          clips,
        );
      }
      pushRichSpan(spans, run, character.x, character.x + character.advance);
    }
    for (const span of spans) {
      renderTextDecoration(
        state,
        node,
        matrix,
        inverseMatrix,
        span.run.font,
        span.run.style,
        x + span.left,
        baseline,
        span.right - span.left,
        span.run.color,
        opacity,
        clips,
      );
    }
    top += line.height;
  }
}

function pushRichSpan(spans, run, left, right) {
  const previous = spans.at(-1);
  if (previous?.run === run) previous.right = right;
  else spans.push({ run, left, right });
}

function recordMissingGlyphs(state, node, path, missing) {
  const existing = state.missingGlyphs.get(node.id) ?? new Set();
  for (const character of missing) existing.add(character);
  state.missingGlyphs.set(node.id, existing);
  state.diagnostics.push({
    code: "text_missing_glyph",
    message: `Text node is missing glyphs for: ${[...missing]
      .map((character) => describeCodepoint(character))
      .join(", ")}`,
    nodeId: node.id,
    path,
  });
}

function describeCodepoint(character) {
  const codePoint = character.codePointAt(0);
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

function renderText(state, node, matrix, opacity, path, clips) {
  if (!node.text) return;
  if (node.textBlocks?.length) {
    renderRichText(state, node, matrix, opacity, path, clips);
    return;
  }
  const style = node.textStyle ?? {};
  const font = resolveFont(state, style, node.id, path);
  const fontSize = Number(style.fontSize ?? 14);
  const lineHeightValue = Number(style.lineHeight ?? 1.2);
  const lineHeight = lineHeightValue <= 4 ? fontSize * lineHeightValue : lineHeightValue;
  const letterSpacing = Number(style.letterSpacing ?? 0);
  const source =
    style.textTransform === "uppercase"
      ? node.text.toUpperCase()
      : style.textTransform === "lowercase"
        ? node.text.toLowerCase()
        : node.text;
  const missing = new Set();
  const lines =
    node.growType === "auto-width"
      ? source.split("\n")
      : wrapTextLines(
          source,
          node.width,
          (text) =>
            lineGlyphs(
              font,
              state.fonts.symbols,
              text,
              0,
              0,
              fontSize,
              letterSpacing,
              false,
            ).width,
        );
  if (node.growType === "auto-height") {
    const blockHeight = lines.length * lineHeight;
    if (blockHeight > node.height) node.height = blockHeight;
  }
  const blockHeight = lines.length * lineHeight;
  const verticalOffset =
    style.verticalAlign === "center"
      ? (node.height - blockHeight) / 2
      : style.verticalAlign === "bottom"
        ? node.height - blockHeight
        : 0;
  const ascender = (typographicAscender(font) * fontSize) / font.unitsPerEm;
  const textColor = node.fills?.[0]
    ? paintColor(
        node.fills[0],
        0,
        0,
        node,
        state.colors,
        state.diagnostics,
        path,
        state.productPackageId,
      )
    : [32, 33, 36, 255];
  const inverseMatrix = inverse(matrix);
  if (!inverseMatrix) return;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lineGlyphs(
      font,
      state.fonts.symbols,
      lines[index],
      0,
      0,
      fontSize,
      letterSpacing,
      false,
    );
    const x =
      style.textAlign === "center"
        ? (node.width - line.width) / 2
        : style.textAlign === "right"
          ? node.width - line.width
          : 0;
    const baseline =
      verticalOffset + index * lineHeight + (lineHeight - fontSize) / 2 + ascender;
    const placed = lineGlyphs(
      font,
      state.fonts.symbols,
      lines[index],
      x,
      baseline,
      fontSize,
      letterSpacing,
      true,
      missing,
    );
    for (const glyph of placed.glyphs) {
      renderGlyph(state, node, matrix, inverseMatrix, glyph, textColor, opacity, clips);
    }
    renderTextDecoration(
      state,
      node,
      matrix,
      inverseMatrix,
      font,
      style,
      x,
      baseline,
      line.width,
      textColor,
      opacity,
      clips,
    );
  }
  if (missing.size > 0) recordMissingGlyphs(state, node, path, missing);
}

function assetReferenceKey(reference, localPackageId) {
  return reference && typeof reference === "object"
    ? `${reference.packageId}#${reference.assetId}`
    : `${localPackageId}#${reference}`;
}

function colorLibrary(product, foundation, libraries, diagnostics) {
  const result = new Map();
  for (const snapshot of [foundation, ...libraries, product]) {
    if (!snapshot) continue;
    for (const entry of snapshot.manifest.entries.assets) {
      for (const color of snapshot.entries[entry].colors) {
        if (color.paint.type === "solid") {
          result.set(
            assetReferenceKey(color.id, snapshot.manifest.packageId),
            parseColor(color.paint.color, diagnostics, `${entry}.colors.${color.id}`),
          );
        }
      }
    }
  }
  return result;
}

function paintColor(
  paint,
  x,
  y,
  node,
  colors,
  diagnostics,
  path,
  localPackageId,
) {
  const colorKey = paint.colorRef
    ? assetReferenceKey(paint.colorRef, localPackageId)
    : undefined;
  if (colorKey && colors.has(colorKey)) {
    return [...colors.get(colorKey)];
  }
  if (paint.type === "solid") {
    return parseColor(paint.color, diagnostics, `${path}.color`);
  }
  if (paint.type === "image") return [225, 228, 234, 255];
  const stops = [...paint.stops].sort((left, right) => left.offset - right.offset);
  let offset;
  if (paint.type === "radial-gradient") {
    const radius = Math.max(1e-9, paint.gradientWidth * Math.max(node.width, node.height));
    offset = Math.hypot(x - paint.startX * node.width, y - paint.startY * node.height) / radius;
  } else {
    const startX = paint.startX * node.width;
    const startY = paint.startY * node.height;
    const endX = paint.endX * node.width;
    const endY = paint.endY * node.height;
    const dx = endX - startX;
    const dy = endY - startY;
    offset = ((x - startX) * dx + (y - startY) * dy) / Math.max(1e-9, dx * dx + dy * dy);
  }
  offset = clamp(offset, 0, 1);
  const rightIndex = stops.findIndex((stop) => stop.offset >= offset);
  const right = stops[rightIndex < 0 ? stops.length - 1 : rightIndex];
  const left = stops[Math.max(0, (rightIndex < 0 ? stops.length : rightIndex) - 1)];
  const span = Math.max(1e-9, right.offset - left.offset);
  const amount = clamp((offset - left.offset) / span, 0, 1);
  const leftColor = parseColor(left.color, diagnostics, `${path}.stops`);
  const rightColor = parseColor(right.color, diagnostics, `${path}.stops`);
  return leftColor.map((value, index) =>
    Math.round(
      value * (1 - amount) + rightColor[index] * amount,
    ),
  );
}

function svgAttributes(source) {
  return Object.fromEntries(
    [...source.matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(
      (match) => [match[1], match[2] ?? match[3]],
    ),
  );
}

function svgNumber(value, fallback = 0) {
  const result = Number.parseFloat(value);
  return Number.isFinite(result) ? result : fallback;
}

function svgOpacity(attributes, name = "opacity") {
  return clamp(svgNumber(attributes[name], 1), 0, 1);
}

function svgPaint(value, opacity, diagnostics, path) {
  if (!value || value === "none") return undefined;
  const color = parseColor(value, diagnostics, path);
  color[3] = Math.round(color[3] * opacity);
  return color;
}

function distanceToSegment(x, y, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const amount = lengthSquared === 0
    ? 0
    : clamp(((x - start.x) * dx + (y - start.y) * dy) / lengthSquared, 0, 1);
  return Math.hypot(x - (start.x + amount * dx), y - (start.y + amount * dy));
}

function parseSvgMedia(bytes, descriptor, diagnostics, path) {
  const source = new TextDecoder().decode(bytes);
  if (/<(?:script|foreignObject)\b/i.test(source)) {
    diagnostics.push({
      code: "unsafe_svg_media",
      message: `Renderer rejected active SVG content in ${descriptor.name}`,
      path,
    });
    return undefined;
  }
  const rootMatch = /<svg\b([^>]*)>/i.exec(source);
  if (!rootMatch) return undefined;
  const root = svgAttributes(rootMatch[1]);
  const viewBox = (root.viewBox ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const bounds = viewBox.length === 4 && viewBox.every(Number.isFinite)
    ? { height: viewBox[3], width: viewBox[2], x: viewBox[0], y: viewBox[1] }
    : {
        height: svgNumber(root.height, descriptor.height),
        width: svgNumber(root.width, descriptor.width),
        x: 0,
        y: 0,
      };
  if (bounds.width <= 0 || bounds.height <= 0) return undefined;
  const shapes = [];
  for (const match of source.matchAll(/<(rect|circle|ellipse|line|path)\b([^>]*)\/?\s*>/gi)) {
    const type = match[1].toLowerCase();
    const attributes = svgAttributes(match[2]);
    const opacity = svgOpacity(attributes);
    const fill = svgPaint(
      attributes.fill ?? (type === "path" ? "#000000" : undefined),
      opacity * svgOpacity(attributes, "fill-opacity"),
      diagnostics,
      `${path}.${type}.fill`,
    );
    const stroke = svgPaint(
      attributes.stroke,
      opacity * svgOpacity(attributes, "stroke-opacity"),
      diagnostics,
      `${path}.${type}.stroke`,
    );
    const strokeWidth = svgNumber(attributes["stroke-width"], 1);
    if (type === "rect") {
      shapes.push({
        fill,
        height: svgNumber(attributes.height),
        rx: svgNumber(attributes.rx),
        ry: svgNumber(attributes.ry, svgNumber(attributes.rx)),
        stroke,
        strokeWidth,
        type,
        width: svgNumber(attributes.width),
        x: svgNumber(attributes.x),
        y: svgNumber(attributes.y),
      });
    } else if (type === "circle" || type === "ellipse") {
      shapes.push({
        cx: svgNumber(attributes.cx),
        cy: svgNumber(attributes.cy),
        fill,
        rx: svgNumber(attributes.rx, svgNumber(attributes.r)),
        ry: svgNumber(attributes.ry, svgNumber(attributes.r)),
        stroke,
        strokeWidth,
        type,
      });
    } else {
      const geometry = type === "line"
        ? {
            contours: [],
            cumulative: [Math.hypot(
              svgNumber(attributes.x2) - svgNumber(attributes.x1),
              svgNumber(attributes.y2) - svgNumber(attributes.y1),
            )],
            end: { x: svgNumber(attributes.x2), y: svgNumber(attributes.y2) },
            segments: [{
              start: { x: svgNumber(attributes.x1), y: svgNumber(attributes.y1) },
              end: { x: svgNumber(attributes.x2), y: svgNumber(attributes.y2) },
            }],
            start: { x: svgNumber(attributes.x1), y: svgNumber(attributes.y1) },
            totalLength: Math.hypot(
              svgNumber(attributes.x2) - svgNumber(attributes.x1),
              svgNumber(attributes.y2) - svgNumber(attributes.y1),
            ),
          }
        : parsePathData(attributes.d ?? "");
      if (!geometry) {
        diagnostics.push({
          code: "unsupported_svg_path",
          message: `Renderer could not rasterize a complex path in ${descriptor.name}`,
          path,
        });
      } else {
        shapes.push({
          evenOdd: (attributes["fill-rule"] ?? "").toLowerCase() === "evenodd",
          fill,
          geometry,
          stroke,
          strokeWidth,
          type: "path",
        });
      }
    }
  }
  return { bounds, shapes };
}

function compositeColor(target, source) {
  if (!source || source[3] === 0) return target;
  const result = [...target];
  blend(result, 0, source, 1);
  return result;
}

// --- Raster image decoding (PNG / GIF / baseline JPEG) ---------------------

function pushDecodeDiagnostic(diagnostics, path, name, detail) {
  diagnostics.push({
    code: "media_decode_failed",
    message: `Renderer could not decode ${name}: ${detail}`,
    path,
  });
}

function decodePng(bytes, diagnostics, path, name) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    view.length < signature.length + 12 ||
    signature.some((byte, index) => view[index] !== byte)
  ) {
    pushDecodeDiagnostic(diagnostics, path, name, "not a PNG file");
    return undefined;
  }
  const data = new DataView(view.buffer, view.byteOffset, view.byteLength);
  let offset = 8;
  let header;
  let palette;
  let transparency;
  const idat = [];
  while (offset + 12 <= view.length) {
    const length = data.getUint32(offset);
    const type = String.fromCharCode(
      view[offset + 4],
      view[offset + 5],
      view[offset + 6],
      view[offset + 7],
    );
    const body = view.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      header = {
        colorType: body[9],
        compression: body[10],
        depth: body[8],
        filter: body[11],
        height: data.getUint32(offset + 12),
        interlace: body[12],
        width: data.getUint32(offset + 8),
      };
    } else if (type === "PLTE") {
      palette = body;
    } else if (type === "tRNS") {
      transparency = body;
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (
    !header ||
    idat.length === 0 ||
    header.width <= 0 ||
    header.height <= 0 ||
    header.width > MAX_DIMENSION ||
    header.height > MAX_DIMENSION
  ) {
    pushDecodeDiagnostic(diagnostics, path, name, "missing or invalid PNG header");
    return undefined;
  }
  if (
    header.depth !== 8 ||
    ![0, 2, 3, 4, 6].includes(header.colorType) ||
    header.compression !== 0 ||
    header.filter !== 0 ||
    header.interlace !== 0
  ) {
    pushDecodeDiagnostic(
      diagnostics,
      path,
      name,
      `unsupported PNG pixel format (depth ${header.depth}, color ${header.colorType}, interlace ${header.interlace})`,
    );
    return undefined;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header.colorType];
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    pushDecodeDiagnostic(diagnostics, path, name, "corrupt PNG pixel data");
    return undefined;
  }
  const stride = header.width * channels;
  if (raw.length < (stride + 1) * header.height) {
    pushDecodeDiagnostic(diagnostics, path, name, "truncated PNG pixel data");
    return undefined;
  }
  const lines = Buffer.alloc(stride * header.height);
  const previous = Buffer.alloc(stride);
  for (let row = 0; row < header.height; row += 1) {
    const filter = raw[row * (stride + 1)];
    const source = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1));
    const target = lines.subarray(row * stride, (row + 1) * stride);
    for (let column = 0; column < stride; column += 1) {
      const left = column >= channels ? target[column - channels] : 0;
      const up = previous[column];
      const upLeft = column >= channels ? previous[column - channels] : 0;
      let value = source[column];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const prediction = left + up - upLeft;
        const distances = [
          Math.abs(prediction - left),
          Math.abs(prediction - up),
          Math.abs(prediction - upLeft),
        ];
        value += distances[0] <= distances[1] && distances[0] <= distances[2]
          ? left
          : distances[1] <= distances[2]
            ? up
            : upLeft;
      }
      target[column] = value & 0xff;
    }
    previous.set(target);
  }
  const pixels = new Uint8ClampedArray(header.width * header.height * 4);
  for (let index = 0; index < header.width * header.height; index += 1) {
    const source = index * channels;
    const target = index * 4;
    if (header.colorType === 0) {
      const gray = lines[source];
      pixels[target] = gray;
      pixels[target + 1] = gray;
      pixels[target + 2] = gray;
      pixels[target + 3] =
        transparency && transparency[0] !== undefined && gray === transparency[0]
          ? 0
          : 255;
    } else if (header.colorType === 2) {
      pixels[target] = lines[source];
      pixels[target + 1] = lines[source + 1];
      pixels[target + 2] = lines[source + 2];
      pixels[target + 3] = 255;
    } else if (header.colorType === 3) {
      const entry = lines[source] * 3;
      if (!palette || entry + 2 >= palette.length) {
        pushDecodeDiagnostic(diagnostics, path, name, "PNG palette entry missing");
        return undefined;
      }
      pixels[target] = palette[entry];
      pixels[target + 1] = palette[entry + 1];
      pixels[target + 2] = palette[entry + 2];
      pixels[target + 3] =
        transparency && lines[source] < transparency.length
          ? transparency[lines[source]]
          : 255;
    } else if (header.colorType === 4) {
      const gray = lines[source];
      pixels[target] = gray;
      pixels[target + 1] = gray;
      pixels[target + 2] = gray;
      pixels[target + 3] = lines[source + 1];
    } else {
      pixels[target] = lines[source];
      pixels[target + 1] = lines[source + 1];
      pixels[target + 2] = lines[source + 2];
      pixels[target + 3] = lines[source + 3];
    }
  }
  return { height: header.height, pixels, width: header.width };
}

function decodeGif(bytes, diagnostics, path, name) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const signature = String.fromCharCode(...view.subarray(0, 6));
  if (!/^GIF8[79]a$/.test(signature) || view.length < 14) {
    pushDecodeDiagnostic(diagnostics, path, name, "not a GIF file");
    return undefined;
  }
  const data = new DataView(view.buffer, view.byteOffset, view.byteLength);
  const width = data.getUint16(6, true);
  const height = data.getUint16(8, true);
  const packed = view[10];
  let offset = 13;
  let globalTable;
  if (packed & 0x80) {
    const size = 2 ** ((packed & 0x07) + 1);
    globalTable = view.subarray(offset, offset + size * 3);
    offset += size * 3;
  }
  let transparentIndex = -1;
  const readSubBlocks = () => {
    const chunks = [];
    while (offset < view.length) {
      const size = view[offset++];
      if (size === 0) break;
      chunks.push(view.subarray(offset, offset + size));
      offset += size;
    }
    return Buffer.concat(chunks);
  };
  let frame;
  while (offset < view.length) {
    const block = view[offset++];
    if (block === 0x3b) break;
    if (block === 0x21) {
      const label = view[offset++];
      if (label === 0xf9) {
        const block_ = readSubBlocks();
        if (block_.length >= 4 && block_[0] & 0x01) transparentIndex = block_[3];
      } else {
        readSubBlocks();
      }
      continue;
    }
    if (block !== 0x2c) {
      pushDecodeDiagnostic(diagnostics, path, name, "corrupt GIF block structure");
      return undefined;
    }
    const frameX = data.getUint16(offset, true);
    const frameY = data.getUint16(offset + 2, true);
    const frameWidth = data.getUint16(offset + 4, true);
    const frameHeight = data.getUint16(offset + 6, true);
    const framePacked = view[offset + 8];
    offset += 9;
    let table = globalTable;
    if (framePacked & 0x80) {
      const size = 2 ** ((framePacked & 0x07) + 1);
      table = view.subarray(offset, offset + size * 3);
      offset += size * 3;
    }
    const interlaced = (framePacked & 0x40) !== 0;
    const minCodeSize = view[offset++];
    const compressed = readSubBlocks();
    const indices = lzwDecode(
      compressed,
      minCodeSize,
      frameWidth * frameHeight,
      diagnostics,
      path,
      name,
    );
    if (!indices || !table) return undefined;
    const pixels = new Uint8ClampedArray(width * height * 4);
    const rowOrder = [];
    if (interlaced) {
      for (const start of [0, 4, 2, 1]) {
        for (let row = start; row < frameHeight; row += 8) rowOrder.push(row);
      }
    } else {
      for (let row = 0; row < frameHeight; row += 1) rowOrder.push(row);
    }
    for (let index = 0; index < indices.length; index += 1) {
      const colorIndex = indices[index];
      const row = rowOrder[Math.floor(index / frameWidth)];
      const column = index % frameWidth;
      const target = ((frameY + row) * width + frameX + column) * 4;
      if (colorIndex === transparentIndex) continue;
      pixels[target] = table[colorIndex * 3];
      pixels[target + 1] = table[colorIndex * 3 + 1];
      pixels[target + 2] = table[colorIndex * 3 + 2];
      pixels[target + 3] = 255;
    }
    frame = { height, pixels, width };
    // Only the first composed frame is rendered; additional frames are reported.
    let blockCursor = offset;
    while (blockCursor < view.length) {
      const marker = view[blockCursor];
      if (marker === 0x3b) break;
      if (marker === 0x21) {
        blockCursor += 2;
        while (blockCursor < view.length && view[blockCursor] !== 0) {
          blockCursor += view[blockCursor] + 1;
        }
        blockCursor += 1;
        continue;
      }
      if (marker === 0x2c) {
        diagnostics.push({
          code: "media_animation_frames_ignored",
          message: `Renderer composed only the first frame of animated media ${name}`,
          path,
        });
        break;
      }
      break;
    }
    break;
  }
  if (!frame) {
    pushDecodeDiagnostic(diagnostics, path, name, "GIF contains no image frame");
    return undefined;
  }
  return frame;
}

function lzwDecode(compressed, minCodeSize, expectedPixels, diagnostics, path, name) {
  const clearCode = 2 ** minCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  let dictionary = new Map();
  const reset = () => {
    dictionary = new Map();
    for (let code = 0; code < clearCode; code += 1) dictionary.set(code, [code]);
    codeSize = minCodeSize + 1;
    nextCode = endCode + 1;
  };
  reset();
  const output = [];
  let bitCursor = 0;
  let previous;
  const totalBits = compressed.length * 8;
  while (bitCursor + codeSize <= totalBits && output.length < expectedPixels + 4096) {
    let code = 0;
    for (let bit = 0; bit < codeSize; bit += 1) {
      const byteIndex = Math.floor((bitCursor + bit) / 8);
      code |= ((compressed[byteIndex] >> ((bitCursor + bit) % 8)) & 1) << bit;
    }
    bitCursor += codeSize;
    if (code === endCode) break;
    if (code === clearCode) {
      reset();
      previous = undefined;
      continue;
    }
    let entry = dictionary.get(code);
    if (entry === undefined) {
      if (previous === undefined) {
        pushDecodeDiagnostic(diagnostics, path, name, "corrupt GIF LZW stream");
        return undefined;
      }
      entry = [...previous, previous[0]];
    }
    for (const pixel of entry) output.push(pixel);
    if (previous && nextCode < 4096) {
      dictionary.set(nextCode, [...previous, entry[0]]);
      nextCode += 1;
      if (nextCode === 2 ** codeSize && codeSize < 12) codeSize += 1;
    }
    previous = entry;
  }
  if (output.length < expectedPixels) {
    pushDecodeDiagnostic(diagnostics, path, name, "truncated GIF pixel data");
    return undefined;
  }
  return output.slice(0, expectedPixels);
}

// Minimal baseline (sequential DCT, Huffman) JPEG decoder. Progressive and
// arithmetic-coded JPEGs are rejected with a typed diagnostic instead.
function decodeJpeg(bytes, diagnostics, path, name) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const data = new DataView(view.buffer, view.byteOffset, view.byteLength);
  if (view.length < 4 || view[0] !== 0xff || view[1] !== 0xd8) {
    pushDecodeDiagnostic(diagnostics, path, name, "not a JPEG file");
    return undefined;
  }
  let offset = 2;
  const quant = new Map();
  const huffman = new Map();
  let frame;
  let restartInterval = 0;
  const readLength = () => {
    const length = data.getUint16(offset);
    offset += 2;
    return length;
  };
  while (offset + 4 <= view.length) {
    if (view[offset] !== 0xff) {
      pushDecodeDiagnostic(diagnostics, path, name, "corrupt JPEG marker structure");
      return undefined;
    }
    const marker = view[offset + 1];
    offset += 2;
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = readLength();
    const body = offset;
    if (marker === 0xdb) {
      let cursor = body;
      while (cursor < body + length - 2) {
        const tableInfo = view[cursor++];
        const tableId = tableInfo & 0x0f;
        const values = new Int32Array(64);
        if (tableInfo & 0xf0) {
          for (let index = 0; index < 64; index += 1) {
            values[index] = data.getUint16(cursor);
            cursor += 2;
          }
        } else {
          for (let index = 0; index < 64; index += 1) {
            values[index] = view[cursor++];
          }
        }
        quant.set(tableId, values);
      }
    } else if (marker === 0xc4) {
      let cursor = body;
      while (cursor < body + length - 2) {
        const tableInfo = view[cursor++];
        const classBit = tableInfo >> 4;
        const tableId = tableInfo & 0x0f;
        const counts = view.subarray(cursor, cursor + 16);
        cursor += 16;
        let total = 0;
        for (const count of counts) total += count;
        const symbols = view.subarray(cursor, cursor + total);
        cursor += total;
        const codes = new Map();
        let code = 0;
        let symbolCursor = 0;
        for (let bits = 1; bits <= 16; bits += 1) {
          for (let index = 0; index < counts[bits - 1]; index += 1) {
            codes.set(`${bits}:${code}`, symbols[symbolCursor++]);
            code += 1;
          }
          code *= 2;
        }
        huffman.set(`${classBit}:${tableId}`, codes);
      }
    } else if (marker === 0xc0 || marker === 0xc1) {
      frame = {
        components: [],
        // SOF body: precision(1), height(2), width(2), component count(1).
        height: data.getUint16(body + 1),
        width: data.getUint16(body + 3),
      };
      const componentCount = view[body + 5];
      let cursor = body + 6;
      for (let index = 0; index < componentCount; index += 1) {
        // Quantization tables may be emitted after SOF; keep the id and
        // resolve it once the scan starts.
        frame.components.push({
          h: view[cursor + 1] >> 4,
          id: view[cursor],
          quantId: view[cursor + 2] & 0x0f,
          v: view[cursor + 1] & 0x0f,
        });
        cursor += 3;
      }
      if (frame.width <= 0 || frame.height <= 0) frame = undefined;
    } else if (marker === 0xc2 || marker === 0xc3 || (marker >= 0xc5 && marker <= 0xcf)) {
      pushDecodeDiagnostic(
        diagnostics,
        path,
        name,
        "unsupported JPEG coding (progressive/lossless/arithmetic)",
      );
      return undefined;
    } else if (marker === 0xc9 || marker === 0xca) {
      pushDecodeDiagnostic(diagnostics, path, name, "unsupported JPEG coding (arithmetic)");
      return undefined;
    } else if (marker === 0xdd) {
      restartInterval = data.getUint16(body);
    }
    offset = body + length - 2;
    if (marker === 0xda) {
      if (!frame) {
        pushDecodeDiagnostic(diagnostics, path, name, "JPEG scan without frame");
        return undefined;
      }
      const componentCount = view[body];
      let cursor = body + 1;
      for (let index = 0; index < componentCount; index += 1) {
        const component = frame.components.find((item) => item.id === view[cursor]);
        if (component) {
          component.dc = huffman.get(`0:${view[cursor + 1] >> 4}`);
          component.ac = huffman.get(`1:${view[cursor + 1] & 0x0f}`);
          component.quant = quant.get(component.quantId);
        }
        cursor += 2;
      }
      // Skip Ss, Se, and Ah/Al before the entropy-coded data.
      const scanStart = cursor + 3;
      return jpegDecodeScan(
        view,
        data,
        frame,
        scanStart,
        restartInterval,
        diagnostics,
        path,
        name,
      );
    }
  }
  pushDecodeDiagnostic(diagnostics, path, name, "JPEG ended without a scan");
  return undefined;
}

const JPEG_ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40,
  48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29,
  22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54,
  47, 55, 62, 63,
];

function jpegHuffmanSymbol(codes, reader) {
  let code = 0;
  for (let bits = 1; bits <= 16; bits += 1) {
    code = (code << 1) | reader.readBit();
    const symbol = codes.get(`${bits}:${code}`);
    if (symbol !== undefined) return symbol;
  }
  return undefined;
}

function jpegReceiveExtend(reader, magnitude) {
  if (magnitude === 0) return 0;
  let value = reader.readBits(magnitude);
  if (value < 2 ** (magnitude - 1)) value -= 2 ** magnitude - 1;
  return value;
}

function jpegDecodeScan(
  view,
  data,
  frame,
  start,
  restartInterval,
  diagnostics,
  path,
  name,
) {
  const scanComponents = frame.components.filter((component) => component.ac);
  if (scanComponents.length === 0) {
    pushDecodeDiagnostic(diagnostics, path, name, "JPEG scan has no decodable components");
    return undefined;
  }
  const hMax = Math.max(...frame.components.map((component) => component.h));
  const vMax = Math.max(...frame.components.map((component) => component.v));
  const mcuWidth = hMax * 8;
  const mcuHeight = vMax * 8;
  const mcusX = Math.ceil(frame.width / mcuWidth);
  const mcusY = Math.ceil(frame.height / mcuHeight);
  const planes = frame.components.map((component) => new Float32Array(
    Math.ceil((frame.width * component.h) / hMax) *
      Math.ceil((frame.height * component.v) / vMax) +
      64,
  ));
  const planeWidths = frame.components.map((component) =>
    Math.ceil((frame.width * component.h) / hMax),
  );
  const reader = {
    cursor: start,
    bitBuffer: 0,
    bitCount: 0,
    readBit() {
      while (this.bitCount === 0) {
        if (this.cursor >= view.length) throw new Error("truncated JPEG scan");
        const byte = view[this.cursor++];
        if (byte === 0xff) {
          const next = view[this.cursor] ?? 0;
          if (next === 0x00) this.cursor += 1;
          else if (next >= 0xd0 && next <= 0xd7) {
            // Restart marker: handled by the MCU loop; skip here defensively.
            this.cursor += 1;
            continue;
          } else throw new Error("unexpected JPEG marker in scan");
        }
        this.bitBuffer = byte;
        this.bitCount = 8;
      }
      this.bitCount -= 1;
      return (this.bitBuffer >> this.bitCount) & 1;
    },
    readBits(count) {
      let value = 0;
      for (let index = 0; index < count; index += 1) {
        value = (value << 1) | this.readBit();
      }
      return value;
    },
    reset() {
      this.bitCount = 0;
    },
  };
  const coefficients = frame.components.map(() => new Int32Array(64));
  const predictions = frame.components.map(() => 0);
  let mcuCount = 0;
  try {
    for (let mcuY = 0; mcuY < mcusY; mcuY += 1) {
      for (let mcuX = 0; mcuX < mcusX; mcuX += 1) {
        if (
          restartInterval > 0 &&
          mcuCount > 0 &&
          mcuCount % restartInterval === 0
        ) {
          predictions.fill(0);
          reader.reset();
          // Consume the restart marker.
          while (reader.cursor + 1 < view.length) {
            if (view[reader.cursor] === 0xff && view[reader.cursor + 1] !== 0x00) {
              reader.cursor += 2;
              break;
            }
            reader.cursor += 1;
          }
        }
        for (let componentIndex = 0; componentIndex < scanComponents.length; componentIndex += 1) {
          const component = scanComponents[componentIndex];
          const blocksX = Math.ceil((mcuWidth * component.h) / hMax / 8);
          const blocksY = Math.ceil((mcuHeight * component.v) / vMax / 8);
          for (let blockY = 0; blockY < blocksY; blockY += 1) {
            for (let blockX = 0; blockX < blocksX; blockX += 1) {
              const coefficients_ = coefficients[componentIndex];
              coefficients_.fill(0);
              const dcSymbol = jpegHuffmanSymbol(component.dc, reader);
              if (dcSymbol === undefined) throw new Error("invalid DC code");
              predictions[componentIndex] += jpegReceiveExtend(reader, dcSymbol);
              coefficients_[0] = predictions[componentIndex] * component.quant[0];
              let cursor = 1;
              while (cursor < 64) {
                const acSymbol = jpegHuffmanSymbol(component.ac, reader);
                if (acSymbol === undefined) throw new Error("invalid AC code");
                const run = acSymbol >> 4;
                const magnitude = acSymbol & 0x0f;
                if (magnitude === 0) {
                  if (run === 15) {
                    cursor += 16;
                    continue;
                  }
                  break;
                }
                cursor += run;
                if (cursor > 63) throw new Error("AC run overflows block");
                coefficients_[JPEG_ZIGZAG[cursor]] =
                  jpegReceiveExtend(reader, magnitude) * component.quant[cursor];
                cursor += 1;
              }
              const plane = planes[frame.components.indexOf(component)];
              const planeWidth = planeWidths[frame.components.indexOf(component)];
              const originX = mcuX * ((mcuWidth * component.h) / hMax) + blockX * 8;
              const originY = mcuY * ((mcuHeight * component.v) / vMax) + blockY * 8;
              jpegIdctInto(coefficients_, plane, planeWidth, originX, originY);
            }
          }
        }
        mcuCount += 1;
      }
    }
  } catch (cause) {
    pushDecodeDiagnostic(diagnostics, path, name, `corrupt JPEG scan (${cause.message})`);
    return undefined;
  }
  // Color transform and upsample to RGBA.
  const pixels = new Uint8ClampedArray(frame.width * frame.height * 4);
  const hasChroma = scanComponents.length >= 3;
  const luminance = planes[0];
  const indexY = 0;
  const indexCb = hasChroma ? 1 : -1;
  const indexCr = hasChroma ? 2 : -1;
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const target = (y * frame.width + x) * 4;
      if (!hasChroma) {
        const value = clamp(
          Math.round(luminance[y * planeWidths[0] + x] + 128),
          0,
          255,
        );
        pixels[target] = value;
        pixels[target + 1] = value;
        pixels[target + 2] = value;
        pixels[target + 3] = 255;
        continue;
      }
      const sampleY = luminance[y * planeWidths[indexY] + x];
      const sampleCb = planes[indexCb][
        Math.floor((y * frame.components[indexCb].v) / vMax) *
          planeWidths[indexCb] +
          Math.floor((x * frame.components[indexCb].h) / hMax)
      ];
      const sampleCr = planes[indexCr][
        Math.floor((y * frame.components[indexCr].v) / vMax) *
          planeWidths[indexCr] +
          Math.floor((x * frame.components[indexCr].h) / hMax)
      ];
      pixels[target] = clamp(
        Math.round(sampleY + 1.402 * sampleCr + 128),
        0,
        255,
      );
      pixels[target + 1] = clamp(
        Math.round(
          sampleY - 0.344136 * sampleCb - 0.714136 * sampleCr + 128,
        ),
        0,
        255,
      );
      pixels[target + 2] = clamp(
        Math.round(sampleY + 1.772 * sampleCb + 128),
        0,
        255,
      );
      pixels[target + 3] = 255;
    }
  }
  return { height: frame.height, pixels, width: frame.width };
}

function jpegIdctInto(coefficients, plane, planeWidth, originX, originY) {
  const temporary = new Float32Array(64);
  // Rows.
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      let sum = 0;
      for (let frequency = 0; frequency < 8; frequency += 1) {
        const cosine =
          frequency === 0
            ? 1 / Math.SQRT2
            : 1;
        sum +=
          cosine *
          coefficients[row * 8 + frequency] *
          Math.cos(((2 * column + 1) * frequency * Math.PI) / 16);
      }
      temporary[row * 8 + column] = sum / 2;
    }
  }
  // Columns.
  for (let column = 0; column < 8; column += 1) {
    for (let row = 0; row < 8; row += 1) {
      let sum = 0;
      for (let frequency = 0; frequency < 8; frequency += 1) {
        const cosine = frequency === 0 ? 1 / Math.SQRT2 : 1;
        sum +=
          cosine *
          temporary[frequency * 8 + column] *
          Math.cos(((2 * row + 1) * frequency * Math.PI) / 16);
      }
      const value = clamp(Math.round(sum / 2), -128, 2047);
      const targetX = originX + column;
      const targetY = originY + row;
      if (targetX < planeWidth && targetY * planeWidth + targetX < plane.length) {
        plane[targetY * planeWidth + targetX] = value;
      }
    }
  }
}

function svgSample(image, x, y, node) {
  const scale = Math.max(
    node.width / image.bounds.width,
    node.height / image.bounds.height,
  );
  const sourceX = image.bounds.x +
    (x - (node.width - image.bounds.width * scale) / 2) / scale;
  const sourceY = image.bounds.y +
    (y - (node.height - image.bounds.height * scale) / 2) / scale;
  let color = [0, 0, 0, 0];
  for (const shape of image.shapes) {
    let inside = false;
    let border = false;
    if (shape.type === "rect") {
      const localX = sourceX - shape.x;
      const localY = sourceY - shape.y;
      const rect = {
        cornerRadius: [shape.rx, shape.rx, shape.ry, shape.ry],
        height: shape.height,
        width: shape.width,
      };
      inside =
        localX >= 0 &&
        localY >= 0 &&
        localX <= shape.width &&
        localY <= shape.height &&
        cornerContains(rect, localX, localY);
      if (inside && shape.stroke) {
        const inset = shape.strokeWidth;
        border =
          localX <= inset ||
          localY <= inset ||
          localX >= shape.width - inset ||
          localY >= shape.height - inset;
      }
    } else if (shape.type === "circle" || shape.type === "ellipse") {
      const distance =
        ((sourceX - shape.cx) / Math.max(shape.rx, 1e-9)) ** 2 +
        ((sourceY - shape.cy) / Math.max(shape.ry, 1e-9)) ** 2;
      inside = distance <= 1;
      border = inside && shape.stroke && distance >=
        (1 - shape.strokeWidth / Math.max(shape.rx, shape.ry, 1)) ** 2;
    } else if (shape.type === "path") {
      if (shape.fill && shape.geometry) {
        inside = pathFillContains(shape.geometry, sourceX, sourceY, shape.evenOdd);
      }
      if (
        shape.stroke &&
        shape.geometry &&
        pathStrokeContains(shape.geometry, sourceX, sourceY, shape.strokeWidth)
      ) {
        border = true;
      }
    } else if (shape.type === "line") {
      border =
        shape.stroke &&
        shape.segments.some(
          ({ start, end }) =>
            distanceToSegment(sourceX, sourceY, start, end) <=
            shape.strokeWidth / 2,
        );
    }
    if (inside && shape.fill) color = compositeColor(color, shape.fill);
    if (border && shape.stroke) color = compositeColor(color, shape.stroke);
  }
  return color;
}

function rasterSample(image, x, y, node) {
  const scale = Math.max(
    node.width / image.width,
    node.height / image.height,
  );
  const sourceX = Math.floor(
    (x - (node.width - image.width * scale) / 2) / scale,
  );
  const sourceY = Math.floor(
    (y - (node.height - image.height * scale) / 2) / scale,
  );
  if (
    sourceX < 0 ||
    sourceY < 0 ||
    sourceX >= image.width ||
    sourceY >= image.height
  ) {
    return [0, 0, 0, 0];
  }
  const index = (sourceY * image.width + sourceX) * 4;
  return [
    image.pixels[index],
    image.pixels[index + 1],
    image.pixels[index + 2],
    image.pixels[index + 3],
  ];
}

function decodeMediaBytes(media, bytes, diagnostics, path) {
  switch (media.mimeType) {
    case "image/svg+xml":
      return {
        kind: "svg",
        value: parseSvgMedia(bytes, media, diagnostics, path),
      };
    case "image/png":
      return {
        kind: "raster",
        value: decodePng(bytes, diagnostics, path, media.name),
      };
    case "image/gif":
      return {
        kind: "raster",
        value: decodeGif(bytes, diagnostics, path, media.name),
      };
    case "image/jpeg":
      return {
        kind: "raster",
        value: decodeJpeg(bytes, diagnostics, path, media.name),
      };
    case "image/webp":
      return {
        kind: "raster",
        value: decodeWebpSync(bytes, diagnostics, path, media.name),
      };
    default:
      diagnostics.push({
        code: "media_decode_unsupported",
        message: `Renderer cannot decode ${media.mimeType} media ${media.name}; using the deterministic placeholder`,
        path,
      });
      return undefined;
  }
}

function* renderSnapshotMedia(snapshot) {
  if (!snapshot) return;
  for (const entry of snapshot.manifest.entries.assets) {
    for (const media of snapshot.entries[entry].media ?? []) yield media;
  }
}

function state_media_refs(projection) {
  void projection;
  return [];
}

function createMediaLibrary(product, foundation, libraries, diagnostics) {
  const result = new Map();
  for (const snapshot of [foundation, ...libraries, product]) {
    if (!snapshot) continue;
    for (const entry of snapshot.manifest.entries.assets) {
      for (const media of snapshot.entries[entry].media ?? []) {
        const bytes = snapshot.blobs?.get(media.blob);
        if (!bytes) continue;
        const path = `${entry}.media.${media.id}`;
        const decoded = decodeMediaBytes(media, bytes, diagnostics, path);
        result.set(assetReferenceKey(media.id, snapshot.manifest.packageId), {
          descriptor: media,
          image: decoded?.kind === "svg" ? decoded.value : undefined,
          raster: decoded?.kind === "raster" ? decoded.value : undefined,
        });
      }
    }
  }
  return result;
}

function cornerContains(node, x, y) {
  const values = Array.isArray(node.cornerRadius)
    ? node.cornerRadius
    : [node.cornerRadius ?? 0];
  const requested = (values.length === 4 ? values : Array(4).fill(values[0]))
    .map((value) => Math.max(0, Number(value) || 0));
  const [topLeft, topRight, bottomRight, bottomLeft] = requested;
  const scale = Math.min(
    1,
    topLeft + topRight > 0 ? node.width / (topLeft + topRight) : 1,
    bottomLeft + bottomRight > 0
      ? node.width / (bottomLeft + bottomRight)
      : 1,
    topLeft + bottomLeft > 0 ? node.height / (topLeft + bottomLeft) : 1,
    topRight + bottomRight > 0
      ? node.height / (topRight + bottomRight)
      : 1,
  );
  const radii = requested.map((radius) => radius * scale);
  const tests = [
    [radii[0], radii[0], radii[0]],
    [node.width - radii[1], radii[1], radii[1]],
    [node.width - radii[2], node.height - radii[2], radii[2]],
    [radii[3], node.height - radii[3], radii[3]],
  ];
  if (x < radii[0] && y < radii[0]) {
    return (x - tests[0][0]) ** 2 + (y - tests[0][1]) ** 2 <= tests[0][2] ** 2;
  }
  if (x > node.width - radii[1] && y < radii[1]) {
    return (x - tests[1][0]) ** 2 + (y - tests[1][1]) ** 2 <= tests[1][2] ** 2;
  }
  if (x > node.width - radii[2] && y > node.height - radii[2]) {
    return (x - tests[2][0]) ** 2 + (y - tests[2][1]) ** 2 <= tests[2][2] ** 2;
  }
  if (x < radii[3] && y > node.height - radii[3]) {
    return (x - tests[3][0]) ** 2 + (y - tests[3][1]) ** 2 <= tests[3][2] ** 2;
  }
  return true;
}

function nodeContains(node, x, y) {
  if (x < 0 || y < 0 || x >= node.width || y >= node.height) return false;
  if (node.type === "ELLIPSE") {
    const radiusX = node.width / 2;
    const radiusY = node.height / 2;
    if (radiusX <= 0 || radiusY <= 0) return false;
    return (
      ((x - radiusX) / radiusX) ** 2 +
        ((y - radiusY) / radiusY) ** 2 <=
      1
    );
  }
  return cornerContains(node, x, y);
}

function nodeContainsGeometry(node, geometry, x, y) {
  if (geometry) return pathFillContains(geometry, x, y);
  return nodeContains(node, x, y);
}

function insetContains(node, x, y, inset) {
  const width = node.width - inset * 2;
  const height = node.height - inset * 2;
  if (width <= 0 || height <= 0) return false;
  const reduceRadius = (value) => Math.max(0, Number(value) - inset);
  const cornerRadius = Array.isArray(node.cornerRadius)
    ? node.cornerRadius.map(reduceRadius)
    : reduceRadius(node.cornerRadius ?? 0);
  return nodeContains(
    { ...node, cornerRadius, height, width },
    x - inset,
    y - inset,
  );
}

function makeGeometry(segments) {
  const cumulative = [];
  let totalLength = 0;
  for (const segment of segments) {
    totalLength += Math.hypot(
      segment.end.x - segment.start.x,
      segment.end.y - segment.start.y,
    );
    cumulative.push(totalLength);
  }
  return { contours: [], cumulative, segments, totalLength };
}

function clipsAllow(clips, x, y) {
  if (!clips || clips.length === 0) return true;
  return clips.every(({ inverse, shape }) => {
    if (!inverse) return true;
    const local = point(inverse, x, y);
    return nodeContains(shape, local.x, local.y);
  });
}

function effectsOf(value) {
  if (Array.isArray(value)) return value.filter(isRecordLike);
  return value ? [value] : [];
}

function isRecordLike(value) {
  return typeof value === "object" && value !== null;
}

function blurRadiusOf(value) {
  const effect = effectsOf(value)[0];
  if (!effect) return undefined;
  const radius = Number(effect.value ?? effect.radius ?? effect.blur);
  return Number.isFinite(radius) && radius > 0 ? radius : undefined;
}

function blurAlphaRegion(buffer, width, height, radius) {
  const boxRadius = Math.round(radius);
  if (boxRadius < 1) return;
  const temporary = new Float32Array(buffer.length);
  const window = boxRadius * 2 + 1;
  for (let pass = 0; pass < 3; pass += 1) {
    for (let row = 0; row < height; row += 1) {
      let sum = 0;
      for (let offset = -boxRadius; offset <= boxRadius; offset += 1) {
        sum += buffer[row * width + clamp(offset, 0, width - 1)];
      }
      for (let column = 0; column < width; column += 1) {
        temporary[row * width + column] = sum / window;
        sum += buffer[row * width + clamp(column + boxRadius + 1, 0, width - 1)] -
          buffer[row * width + clamp(column - boxRadius, 0, width - 1)];
      }
    }
    for (let column = 0; column < width; column += 1) {
      let sum = 0;
      for (let offset = -boxRadius; offset <= boxRadius; offset += 1) {
        sum += temporary[clamp(offset, 0, height - 1) * width + column];
      }
      for (let row = 0; row < height; row += 1) {
        buffer[row * width + column] = sum / window;
        sum += temporary[clamp(row + boxRadius + 1, 0, height - 1) * width + column] -
          temporary[clamp(row - boxRadius, 0, height - 1) * width + column];
      }
    }
  }
}

function blurRgbaRegion(pixels, width, height, left, top, right, bottom, radius) {
  const boxRadius = Math.round(radius);
  if (boxRadius < 1 || right <= left || bottom <= top) return;
  const regionWidth = right - left;
  const regionHeight = bottom - top;
  const buffer = new Float32Array(regionWidth * regionHeight * 4);
  for (let row = 0; row < regionHeight; row += 1) {
    for (let column = 0; column < regionWidth; column += 1) {
      const source = ((top + row) * width + (left + column)) * 4;
      const alpha = pixels[source + 3] / 255;
      const target = (row * regionWidth + column) * 4;
      buffer[target] = pixels[source] * alpha;
      buffer[target + 1] = pixels[source + 1] * alpha;
      buffer[target + 2] = pixels[source + 2] * alpha;
      buffer[target + 3] = pixels[source + 3];
    }
  }
  const temporary = new Float32Array(buffer.length);
  const window = boxRadius * 2 + 1;
  const at = (buffer_, row, column, channel) =>
    buffer_[(clamp(row, 0, regionHeight - 1) * regionWidth + clamp(column, 0, regionWidth - 1)) * 4 + channel];
  for (let pass = 0; pass < 3; pass += 1) {
    for (let row = 0; row < regionHeight; row += 1) {
      for (let channel = 0; channel < 4; channel += 1) {
        let sum = 0;
        for (let offset = -boxRadius; offset <= boxRadius; offset += 1) {
          sum += at(buffer, row, offset, channel);
        }
        for (let column = 0; column < regionWidth; column += 1) {
          temporary[(row * regionWidth + column) * 4 + channel] = sum / window;
          sum += at(buffer, row, column + boxRadius + 1, channel) -
            at(buffer, row, column - boxRadius, channel);
        }
      }
    }
    for (let column = 0; column < regionWidth; column += 1) {
      for (let channel = 0; channel < 4; channel += 1) {
        let sum = 0;
        for (let offset = -boxRadius; offset <= boxRadius; offset += 1) {
          sum += at(temporary, offset, column, channel);
        }
        for (let row = 0; row < regionHeight; row += 1) {
          buffer[(row * regionWidth + column) * 4 + channel] = sum / window;
          sum += at(temporary, row + boxRadius + 1, column, channel) -
            at(temporary, row - boxRadius, column, channel);
        }
      }
    }
  }
  for (let row = 0; row < regionHeight; row += 1) {
    for (let column = 0; column < regionWidth; column += 1) {
      const source = (row * regionWidth + column) * 4;
      const alpha = buffer[source + 3];
      const target = ((top + row) * width + (left + column)) * 4;
      const coverage = alpha / 255;
      pixels[target] = coverage > 0
        ? clamp(Math.round(buffer[source] / coverage), 0, 255)
        : 0;
      pixels[target + 1] = coverage > 0
        ? clamp(Math.round(buffer[source + 1] / coverage), 0, 255)
        : 0;
      pixels[target + 2] = coverage > 0
        ? clamp(Math.round(buffer[source + 2] / coverage), 0, 255)
        : 0;
      pixels[target + 3] = clamp(Math.round(alpha), 0, 255);
    }
  }
}

function pixelBounds(state, matrix, node) {
  const bounds = transformedBounds(matrix, node.width, node.height);
  return {
    bottom: clamp(Math.ceil(bounds.bottom * state.scale), 0, state.height),
    left: clamp(Math.floor(bounds.left * state.scale), 0, state.width),
    right: clamp(Math.ceil(bounds.right * state.scale), 0, state.width),
    top: clamp(Math.floor(bounds.top * state.scale), 0, state.height),
  };
}

function renderNodeShadow(state, node, matrix, opacity, path, clips, geometry) {
  const shadows = effectsOf(node.shadow);
  for (const shadow of shadows) {
    if (shadow.hidden === true) continue;
    if (shadow.style !== undefined && shadow.style !== "drop-shadow") {
      state.diagnostics.push({
        code: "unsupported_render_shadow",
        message: `Renderer ignored shadow style ${shadow.style}`,
        nodeId: node.id,
        path,
      });
      continue;
    }
    const offsetX = Number(shadow.offsetX ?? 0);
    const offsetY = Number(shadow.offsetY ?? 0);
    const blur = Number(shadow.blur ?? 0);
    const color = parseColor(
      typeof shadow.color === "string" ? shadow.color : "#000000",
      state.diagnostics,
      `${path}.shadow`,
    );
    const shadowOpacity = Number.isFinite(Number(shadow.opacity))
      ? clamp(Number(shadow.opacity), 0, 1)
      : 1;
    const offsetDeviceX =
      (matrix[0] * offsetX + matrix[2] * offsetY) * state.scale;
    const offsetDeviceY =
      (matrix[1] * offsetX + matrix[3] * offsetY) * state.scale;
    const bounds = pixelBounds(state, matrix, node);
    const expand = Math.ceil(blur * state.scale * 3) + 2;
    const left = clamp(bounds.left + Math.floor(offsetDeviceX - expand), 0, state.width);
    const right = clamp(bounds.right + Math.ceil(offsetDeviceX + expand), 0, state.width);
    const top = clamp(bounds.top + Math.floor(offsetDeviceY - expand), 0, state.height);
    const bottom = clamp(bounds.bottom + Math.ceil(offsetDeviceY + expand), 0, state.height);
    if (right <= left || bottom <= top) continue;
    const regionWidth = right - left;
    const alphaBuffer = new Float32Array(regionWidth * (bottom - top));
    const inverseMatrix = inverse(matrix);
    if (!inverseMatrix) continue;
    for (let pixelY = top; pixelY < bottom; pixelY += 1) {
      for (let pixelX = left; pixelX < right; pixelX += 1) {
        const canvasX = (pixelX + 0.5 - offsetDeviceX) / state.scale;
        const canvasY = (pixelY + 0.5 - offsetDeviceY) / state.scale;
        const local = point(inverseMatrix, canvasX, canvasY);
        if (
          local.x < 0 ||
          local.y < 0 ||
          local.x >= node.width ||
          local.y >= node.height ||
          !nodeContainsGeometry(node, geometry, local.x, local.y) ||
          !clipsAllow(clips, canvasX, canvasY)
        ) {
          continue;
        }
        alphaBuffer[(pixelY - top) * regionWidth + (pixelX - left)] = 1;
      }
    }
    blurAlphaRegion(alphaBuffer, regionWidth, bottom - top, blur * state.scale);
    for (let pixelY = top; pixelY < bottom; pixelY += 1) {
      for (let pixelX = left; pixelX < right; pixelX += 1) {
        const coverage = alphaBuffer[(pixelY - top) * regionWidth + (pixelX - left)];
        if (coverage <= 0.004) continue;
        blend(
          state.pixels,
          (pixelY * state.width + pixelX) * 4,
          color,
          opacity * shadowOpacity * coverage,
        );
      }
    }
  }
}

function renderBackgroundBlur(state, node, matrix, clips) {
  const radius = blurRadiusOf(node.backgroundBlur);
  if (!radius) return;
  const inverseMatrix = inverse(matrix);
  if (!inverseMatrix) return;
  const bounds = pixelBounds(state, matrix, node);
  if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) return;
  const regionWidth = bounds.right - bounds.left;
  const regionHeight = bounds.bottom - bounds.top;
  const original = new Uint8ClampedArray(regionWidth * regionHeight * 4);
  for (let row = 0; row < regionHeight; row += 1) {
    for (let column = 0; column < regionWidth; column += 1) {
      const source = ((bounds.top + row) * state.width + (bounds.left + column)) * 4;
      const target = (row * regionWidth + column) * 4;
      original[target] = state.pixels[source];
      original[target + 1] = state.pixels[source + 1];
      original[target + 2] = state.pixels[source + 2];
      original[target + 3] = state.pixels[source + 3];
    }
  }
  blurRgbaRegion(
    state.pixels,
    state.width,
    state.height,
    bounds.left,
    bounds.top,
    bounds.right,
    bounds.bottom,
    radius * state.scale,
  );
  for (let pixelY = bounds.top; pixelY < bounds.bottom; pixelY += 1) {
    for (let pixelX = bounds.left; pixelX < bounds.right; pixelX += 1) {
      const canvasX = (pixelX + 0.5) / state.scale;
      const canvasY = (pixelY + 0.5) / state.scale;
      const local = point(inverseMatrix, canvasX, canvasY);
      if (
        local.x < 0 ||
        local.y < 0 ||
        local.x >= node.width ||
        local.y >= node.height ||
        (nodeContains(node, local.x, local.y) && clipsAllow(clips, canvasX, canvasY))
      ) {
        continue;
      }
      const target = (pixelY * state.width + pixelX) * 4;
      const source =
        ((pixelY - bounds.top) * regionWidth + (pixelX - bounds.left)) * 4;
      state.pixels[target] = original[source];
      state.pixels[target + 1] = original[source + 1];
      state.pixels[target + 2] = original[source + 2];
      state.pixels[target + 3] = original[source + 3];
    }
  }
}

function boundaryGeometry(node) {
  // Boundary polyline of rect/ellipse shapes, used for dashed strokes.
  if (node.type === "ELLIPSE") {
    const sides = 96;
    const segments = [];
    const radiusX = node.width / 2;
    const radiusY = node.height / 2;
    let previous = { x: radiusX, y: 0 };
    for (let index = 1; index <= sides; index += 1) {
      const angle = (index / sides) * Math.PI * 2;
      const next = {
        x: radiusX + Math.cos(angle) * radiusX,
        y: radiusY + Math.sin(angle) * radiusY,
      };
      segments.push({ end: next, start: previous });
      previous = next;
    }
    return { contours: [], segments };
  }
  const radii = (Array.isArray(node.cornerRadius)
    ? node.cornerRadius
    : Array(4).fill(node.cornerRadius ?? 0)
  ).map((value) => clamp(Number(value) || 0, 0, Math.min(node.width, node.height) / 2));
  const segments = [];
  const addArc = (centerX, centerY, radius, startAngle, endAngle) => {
    if (radius <= 0) return;
    const steps = Math.max(2, Math.ceil((Math.abs(endAngle - startAngle) / (Math.PI / 2)) * 8));
    let previous = {
      x: centerX + Math.cos(startAngle) * radius,
      y: centerY + Math.sin(startAngle) * radius,
    };
    for (let step = 1; step <= steps; step += 1) {
      const angle = startAngle + ((endAngle - startAngle) * step) / steps;
      const next = {
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius,
      };
      segments.push({ end: next, start: previous });
      previous = next;
    }
  };
  const [topLeft, topRight, bottomRight, bottomLeft] = radii;
  const addLine = (start, end) => {
    if (Math.hypot(end.x - start.x, end.y - start.y) > 0) segments.push({ end, start });
  };
  const top = ({ x: topLeft, y: 0 });
  addLine(top, { x: node.width - topRight, y: 0 });
  addArc(node.width - topRight, topRight, topRight, -Math.PI / 2, 0);
  addLine({ x: node.width, y: topRight }, { x: node.width, y: node.height - bottomRight });
  addArc(node.width - bottomRight, node.height - bottomRight, bottomRight, 0, Math.PI / 2);
  addLine(
    { x: node.width - bottomRight, y: node.height },
    { x: bottomLeft, y: node.height },
  );
  addArc(bottomLeft, node.height - bottomLeft, bottomLeft, Math.PI / 2, Math.PI);
  addLine({ x: 0, y: node.height - bottomLeft }, { x: 0, y: topLeft });
  addArc(topLeft, topLeft, topLeft, Math.PI, Math.PI * 1.5);
  return { contours: [], segments };
}

function strokeSegmentsFor(node, geometry, stroke, width, pattern) {
  if (geometry) return [];
  if (pattern) return boundaryGeometry(node).segments;
  return [];
}

function renderStrokeColor(state, node, stroke, path) {
  return paintColor(
    stroke,
    0,
    0,
    node,
    state.colors,
    state.diagnostics,
    `${path}.strokes`,
  );
}

function mergeMissingGlyphs(state, missing) {
  for (const [nodeId, characters] of missing) {
    const existing = state.missingGlyphs.get(nodeId) ?? new Set();
    for (const character of characters) existing.add(character);
    state.missingGlyphs.set(nodeId, existing);
  }
}

function createScratchState(state) {
  return {
    ...state,
    colors: state.colors,
    diagnostics: [],
    fontFallbacks: state.fontFallbacks,
    fonts: state.fonts,
    media: state.media,
    pixels: new Uint8ClampedArray(state.width * state.height * 4),
    missingGlyphs: new Map(),
  };
}

function childClips(state, nodes, node, matrix, clips) {
  const inverseMatrix = inverse(matrix);
  if (!inverseMatrix) return clips;
  if (node.type === "FRAME" && node["show-content"] === false) {
    return [...(clips ?? []), { inverse: inverseMatrix, shape: node }];
  }
  if (
    node["masked-group"] === true &&
    (node.children?.length ?? 0) > 1 &&
    node["show-content"] !== true
  ) {
    const maskNode = nodes[node.children[0]];
    if (maskNode) {
      const maskMatrix = multiply(matrix, nodeTransform(maskNode));
      const maskInverse = inverse(maskMatrix);
      if (maskInverse) {
        return [...(clips ?? []), { inverse: maskInverse, shape: maskNode }];
      }
    }
  }
  return clips;
}

function renderTree(state, nodes, nodeId, parentMatrix, parentOpacity, stack, clips) {
  if (stack.has(nodeId)) throw new SmallPenError("node_cycle", `Render cycle includes ${nodeId}`);
  const node = nodes[nodeId];
  if (!node) throw new SmallPenError("missing_node", `Render Node is missing: ${nodeId}`);
  if (node.visible === false) return;
  const matrix = multiply(parentMatrix, nodeTransform(node));
  const opacity = parentOpacity * (node.opacity ?? 1);
  const path = `projection.nodes.${nodeId}`;
  const isMaskSource =
    clips?.length > 0 && clips[clips.length - 1].shape === node;
  const layerBlurRadius = isMaskSource ? undefined : blurRadiusOf(node.blur);
  const children = node.children ?? [];
  const masked =
    node["masked-group"] === true &&
    children.length > 1 &&
    node["show-content"] !== true;
  if (layerBlurRadius) {
    // Layer blur isolates the node and its subtree in an offscreen buffer.
    const scratch = createScratchState(state);
    renderNodeShape(scratch, node, matrix, opacity, path, clips);
    stack.add(nodeId);
    for (let index = masked ? 1 : 0; index < children.length; index += 1) {
      renderTree(
        scratch,
        nodes,
        children[index],
        matrix,
        opacity,
        stack,
        masked || (node.type === "FRAME" && node["show-content"] === false)
          ? childClips(state, nodes, node, matrix, clips)
          : clips,
      );
    }
    stack.delete(nodeId);
    for (const entry of scratch.diagnostics) state.diagnostics.push(entry);
    if (scratch.missingGlyphs) mergeMissingGlyphs(state, scratch.missingGlyphs);
    blurRgbaRegion(
      scratch.pixels,
      state.width,
      state.height,
      0,
      0,
      state.width,
      state.height,
      layerBlurRadius * state.scale,
    );
    for (let index = 0; index < state.pixels.length; index += 4) {
      blend(
        state.pixels,
        index,
        [
          scratch.pixels[index],
          scratch.pixels[index + 1],
          scratch.pixels[index + 2],
          scratch.pixels[index + 3],
        ],
        1,
      );
    }
    return;
  }
  if (!isMaskSource) {
    renderNodeShape(state, node, matrix, opacity, path, clips);
  }
  stack.add(nodeId);
  const clipsChildren =
    masked || (node.type === "FRAME" && node["show-content"] === false);
  const childClipsHere = clipsChildren
    ? childClips(state, nodes, node, matrix, clips)
    : clips;
  for (let index = 0; index < children.length; index += 1) {
    if (masked && index === 0) {
      // The mask source is used only as the clip shape (Penpot semantics) and
      // is not rendered as content.
      continue;
    }
    renderTree(state, nodes, children[index], matrix, opacity, stack, childClipsHere);
  }
    stack.delete(nodeId);
}

function renderNodeShape(state, node, matrix, opacity, path, clips) {
  const inverseMatrix = inverse(matrix);
  if (!inverseMatrix || node.width <= 0 || node.height <= 0) return;
  const geometry = node.type === "PATH" && typeof node.pathData === "string"
    ? parsePathData(node.pathData)
    : undefined;
  if (node.type === "PATH" && typeof node.pathData === "string" && !geometry) {
    state.diagnostics.push({
      code: "unsupported_render_path",
      message: `Renderer could not parse pathData and used the bounding box`,
      nodeId: node.id,
      path,
    });
  }
  renderNodeShadow(state, node, matrix, opacity, path, clips, geometry);
  renderBackgroundBlur(state, node, matrix, clips);
  const bounds = pixelBounds(state, matrix, node);
  // hide-fill-on-export suppresses fills in exported raster output while the
  // editing surface keeps showing them; the CLI render is the export surface.
  const suppressFill = node["hide-fill-on-export"] === true;
  const fills =
    suppressFill || node.type === "TEXT"
      ? []
      : node.fills?.length
        ? node.fills
        : node.type === "IMAGE" && node.mediaRef
          ? [{ mediaRef: node.mediaRef, type: "image" }]
          : node.type === "FRAME" && path.endsWith(`.${state.rootId}`)
            ? [{ color: "#ffffff", type: "solid" }]
            : [];
  for (const fill of fills) {
    const media = fill.type === "image"
      ? state.media.get(
          assetReferenceKey(fill.mediaRef, state.productPackageId),
        )
      : undefined;
    const raster = media?.raster;
    if (fill.type === "image" && !media?.image && !raster) {
      state.diagnostics.push({
        code: "image_render_placeholder",
        message: `Image ${JSON.stringify(fill.mediaRef)} uses a deterministic placeholder`,
        nodeId: node.id,
        path,
      });
    }
    for (let pixelY = bounds.top; pixelY < bounds.bottom; pixelY += 1) {
      for (let pixelX = bounds.left; pixelX < bounds.right; pixelX += 1) {
        const canvasX = (pixelX + 0.5) / state.scale;
        const canvasY = (pixelY + 0.5) / state.scale;
        const local = point(inverseMatrix, canvasX, canvasY);
        if (
          local.x < 0 ||
          local.y < 0 ||
          local.x >= node.width ||
          local.y >= node.height ||
          !nodeContainsGeometry(node, geometry, local.x, local.y) ||
          !clipsAllow(clips, canvasX, canvasY)
        ) {
          continue;
        }
        const color = raster
          ? rasterSample(raster, local.x, local.y, node)
          : media?.image
            ? svgSample(media.image, local.x, local.y, node)
            : paintColor(
                fill,
                local.x,
                local.y,
                node,
                state.colors,
                state.diagnostics,
                path,
                state.productPackageId,
              );
        if (fill.type === "image" && !media?.image && !raster) {
          const band = (Math.floor(local.x / 8) + Math.floor(local.y / 8)) % 2;
          color[0] -= band * 18;
          color[1] -= band * 18;
          color[2] -= band * 18;
        }
        blend(
          state.pixels,
          (pixelY * state.width + pixelX) * 4,
          color,
          opacity * (fill.opacity ?? 1),
        );
      }
    }
  }
  for (const stroke of node.type === "TEXT" ? [] : (node.strokes ?? [])) {
    if (stroke.hidden === true) continue;
    const width = Math.max(1, stroke.width ?? 1);
    const color = renderStrokeColor(state, node, stroke, path);
    const pattern = dashPattern(stroke, width);
    const boundary = geometry || (pattern ? makeGeometry(boundaryGeometry(node).segments) : undefined);
    const markerStart = stroke.capStart && geometry
      ? markerGeometry(
          stroke.capStart,
          geometry.start,
          directionAt(geometry, { segmentIndex: 0 }),
          width,
        )
      : undefined;
    const markerEnd = stroke.capEnd && geometry
      ? markerGeometry(
          stroke.capEnd,
          geometry.end,
          directionAt(geometry, { segmentIndex: geometry.segments.length - 1 }),
          width,
        )
      : undefined;
    for (let pixelY = bounds.top; pixelY < bounds.bottom; pixelY += 1) {
      for (let pixelX = bounds.left; pixelX < bounds.right; pixelX += 1) {
        const canvasX = (pixelX + 0.5) / state.scale;
        const canvasY = (pixelY + 0.5) / state.scale;
        const local = point(inverseMatrix, canvasX, canvasY);
        if (
          local.x < 0 ||
          local.y < 0 ||
          local.x >= node.width ||
          local.y >= node.height ||
          !clipsAllow(clips, canvasX, canvasY)
        ) {
          continue;
        }
        let covered;
        if (boundary) {
          const fillInside = nodeContainsGeometry(node, geometry, local.x, local.y);
          covered = pathStrokeContains(
            boundary,
            local.x,
            local.y,
            width,
            pattern,
            stroke.alignment,
            fillInside,
          );
        } else {
          covered =
            nodeContains(node, local.x, local.y) &&
            !insetContains(node, local.x, local.y, width);
        }
        if (!covered && markerStart) {
          covered =
            windingNumber(markerStart.contours, local.x, local.y) !== 0 ||
            (markerStart.segments.length > 0 &&
              pathStrokeContains(
                makeGeometry(markerStart.segments),
                local.x,
                local.y,
                width,
              ));
        }
        if (!covered && markerEnd) {
          covered =
            windingNumber(markerEnd.contours, local.x, local.y) !== 0 ||
            (markerEnd.segments.length > 0 &&
              pathStrokeContains(
                makeGeometry(markerEnd.segments),
                local.x,
                local.y,
                width,
              ));
        }
        if (!covered) continue;
        blend(
          state.pixels,
          (pixelY * state.width + pixelX) * 4,
          color,
          opacity * (stroke.opacity ?? 1),
        );
      }
    }
  }
  if (node.type === "TEXT") renderText(state, node, matrix, opacity, path, clips);
}

function flattenRegions(
  node,
  scale,
  width,
  height,
  originX,
  originY,
  result = [],
) {
  const rawLeft = (node.bounds.x - originX) * scale;
  const rawTop = (node.bounds.y - originY) * scale;
  const left = clamp(rawLeft, 0, width);
  const top = clamp(rawTop, 0, height);
  const right = clamp(rawLeft + node.bounds.width * scale, 0, width);
  const bottom = clamp(rawTop + node.bounds.height * scale, 0, height);
  result.push({
    height: Math.max(0, bottom - top),
    nodeId: node.id,
    width: Math.max(0, right - left),
    x: left,
    y: top,
  });
  for (const child of node.children) {
    flattenRegions(
      child,
      scale,
      width,
      height,
      originX,
      originY,
      result,
    );
  }
  return result;
}

export async function renderProjection(product, projection, options = {}) {
  if (projection.fallbackUsed) {
    throw new SmallPenError(
      "preview_fallback_not_renderable",
      "Preview fallback cannot be used for strict render or evidence",
    );
  }
  const scale = options.scale ?? 1;
  if (!Number.isFinite(scale) || scale <= 0 || scale > 8) {
    throw new SmallPenError("invalid_render_scale", "Render scale must be within (0, 8]", {
      scale,
    });
  }
  const root = projection.nodes[projection.rootId];
  if (!root) throw new SmallPenError("missing_root_node", "Projection root is unavailable");
  const width = Math.ceil(root.width * scale);
  const height = Math.ceil(root.height * scale);
  if (
    width < 1 ||
    height < 1 ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION ||
    width * height > MAX_PIXELS
  ) {
    throw new SmallPenError("render_size_exceeded", "Rendered image exceeds safety limits", {
      height,
      maximumDimension: MAX_DIMENSION,
      maximumPixels: MAX_PIXELS,
      width,
    });
  }
  const diagnostics = [...(projection.diagnostics ?? [])];
  const hasText = Object.values(projection.nodes).some(
    (node) => node.type === "TEXT" && node.text,
  );
  // WebP media requires the libwebp wasm decoder; initialize it lazily once.
  const hasWebp = [product, options.foundation, ...(options.libraries ?? [])]
    .some((snapshot) =>
      snapshot?.manifest?.entries?.assets?.some((entry) =>
        (snapshot.entries[entry]?.media ?? []).some(
          (media) => media.mimeType === "image/webp",
        ),
      ) ?? false,
    );
  if (hasWebp) await initWebpDecoder();
  const state = {
    colors: colorLibrary(
      product,
      options.foundation,
      options.libraries ?? [],
      diagnostics,
    ),
    diagnostics,
    fontFallbacks: new Set(),
    fonts: hasText
      ? await createFontLibrary(
          product,
          options.foundation,
          options.libraries ?? [],
          diagnostics,
        )
      : undefined,
    height,
    media: createMediaLibrary(
      product,
      options.foundation,
      options.libraries ?? [],
      diagnostics,
    ),
    missingGlyphs: new Map(),
    pixels: new Uint8ClampedArray(width * height * 4),
    productPackageId: product.manifest.packageId,
    rootId: projection.rootId,
    scale,
    width,
  };
  renderTree(
    state,
    projection.nodes,
    projection.rootId,
    translate(-root.x, -root.y),
    1,
    new Set(),
  );
  const bytes = encodePng(width, height, state.pixels);
  return {
    bytes,
    diagnostics,
    height,
    mimeType: "image/png",
    renderHash: await sha256Hex(bytes),
    width,
  };
}

export async function createEvidence(product, options = {}) {
  const resolved = resolveDesignView(product, options);
  const projection = projectDesignView(product, resolved, options);
  const render = await renderProjection(product, projection, options);
  const semanticTree = createSemanticTree(product, projection, {
    foundationRevision: options.foundation?.revision,
    scenarioId: resolved.scenarioId,
    selection: resolved.selection,
  });
  const packageHash = options.foundation
    ? await sha256Hex(`${product.revision}\0${options.foundation.revision}`)
    : product.revision;
  const rootX = semanticTree.root.bounds.x;
  const rootY = semanticTree.root.bounds.y;
  const regions = flattenRegions(
    semanticTree.root,
    options.scale ?? 1,
    render.width,
    render.height,
    rootX,
    rootY,
  );
  return {
    evidence: {
      diagnostics: render.diagnostics,
      nodeRegions: regions,
      packageHash,
      packageId: product.manifest.packageId,
      ...(options.foundation
        ? { foundationRevision: options.foundation.revision }
        : {}),
      productRevision: product.revision,
      renderHash: render.renderHash,
      revision: product.revision,
      selector: resolved.selection,
      semanticTree,
      viewport: {
        height: render.height,
        scale: options.scale ?? 1,
        width: render.width,
      },
    },
    projection,
    render,
  };
}
