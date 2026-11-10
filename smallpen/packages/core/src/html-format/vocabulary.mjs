// INPUT:  class names from SmallPen HTML, the package's Tokens
// OUTPUT: style slots (value plus optional Token) per class, and back
// POS:    The one class vocabulary shared by check, decode and encode.

import {
  BLURS, COLORS, CONTAINERS, FONT_WEIGHTS, LEADING, RADIUS, SHADOWS, TEXT_SIZES, TRACKING,
  isPaletteColor, spacingSteps,
} from "./tailwind-defaults.mjs";

// CSS variable prefix -> Penpot Token type. Longer prefixes first, so
// --font-weight-* is not read as a font family.
const TOKEN_PREFIXES = [
  ["font-weight-", "font-weight"],
  ["tracking-", "letter-spacing"],
  ["spacing-", "spacing"],
  ["opacity-", "opacity"],
  ["string-", "string"],
  ["shadow-", "shadow"],
  ["border-", "stroke-width"],
  ["radius-", "border-radius"],
  ["color-", "color"],
  ["size-", "sizing"],
  ["type-", "typography"],
  ["font-", "font-family"],
  ["text-", "font-size"],
  ["flag-", "boolean"],
];

export const TYPE_PREFIX = Object.fromEntries(
  TOKEN_PREFIXES.map(([prefix, type]) => [type, prefix]),
);

export function tokenTypeOfName(name) {
  for (const [prefix, type] of TOKEN_PREFIXES) {
    if (name.startsWith(prefix) && name.length > prefix.length) {
      return { type, prefix, rest: name.slice(prefix.length) };
    }
  }
  return undefined;
}

export const TOKEN_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

// Which Token types a class prefix accepts, and the slot it writes.
// kind: color | length | number | keyword-only.
const LENGTH = "length";
const SPACING = ["spacing"];
const SIZING = ["sizing"];

const PREFIX_UTILITIES = new Map([
  ["bg", { types: ["color"], literal: "paint", slot: "fill" }],
  ["text", { types: ["color", "font-size"], literal: "color-or-length", slot: "text" }],
  ["border-t", { types: ["stroke-width"], literal: LENGTH, slot: "strokeWidthTop" }],
  ["border-r", { types: ["stroke-width"], literal: LENGTH, slot: "strokeWidthRight" }],
  ["border-b", { types: ["stroke-width"], literal: LENGTH, slot: "strokeWidthBottom" }],
  ["border-l", { types: ["stroke-width"], literal: LENGTH, slot: "strokeWidthLeft" }],
  ["border", { types: ["color", "stroke-width"], literal: "stroke", slot: "border" }],
  ["rounded-tl", { types: ["border-radius"], literal: LENGTH, slot: "radiusTopLeft" }],
  ["rounded-tr", { types: ["border-radius"], literal: LENGTH, slot: "radiusTopRight" }],
  ["rounded-br", { types: ["border-radius"], literal: LENGTH, slot: "radiusBottomRight" }],
  ["rounded-bl", { types: ["border-radius"], literal: LENGTH, slot: "radiusBottomLeft" }],
  ["rounded", { types: ["border-radius"], literal: LENGTH, slot: "radius" }],
  ["shadow", { types: ["shadow"], literal: "shadow", slot: "shadow" }],
  ["opacity", { types: ["opacity"], literal: "unit", slot: "opacity" }],
  ["p", { types: SPACING, literal: LENGTH, slot: "padding" }],
  ["px", { types: SPACING, literal: LENGTH, slot: "paddingX" }],
  ["py", { types: SPACING, literal: LENGTH, slot: "paddingY" }],
  ["pt", { types: SPACING, literal: LENGTH, slot: "paddingTop" }],
  ["pr", { types: SPACING, literal: LENGTH, slot: "paddingRight" }],
  ["pb", { types: SPACING, literal: LENGTH, slot: "paddingBottom" }],
  ["pl", { types: SPACING, literal: LENGTH, slot: "paddingLeft" }],
  ["m", { types: SPACING, literal: LENGTH, slot: "margin" }],
  ["mx", { types: SPACING, literal: LENGTH, slot: "marginX" }],
  ["my", { types: SPACING, literal: LENGTH, slot: "marginY" }],
  ["mt", { types: SPACING, literal: LENGTH, slot: "marginTop" }],
  ["mr", { types: SPACING, literal: LENGTH, slot: "marginRight" }],
  ["mb", { types: SPACING, literal: LENGTH, slot: "marginBottom" }],
  ["ml", { types: SPACING, literal: LENGTH, slot: "marginLeft" }],
  ["gap-x", { types: SPACING, literal: LENGTH, slot: "columnGap" }],
  ["gap-y", { types: SPACING, literal: LENGTH, slot: "rowGap" }],
  ["gap", { types: SPACING, literal: LENGTH, slot: "gap" }],
  ["min-w", { types: SIZING, literal: LENGTH, slot: "minWidth" }],
  ["max-w", { types: SIZING, literal: LENGTH, slot: "maxWidth" }],
  ["min-h", { types: SIZING, literal: LENGTH, slot: "minHeight" }],
  ["max-h", { types: SIZING, literal: LENGTH, slot: "maxHeight" }],
  ["w", { types: SIZING, literal: LENGTH, slot: "width" }],
  ["h", { types: SIZING, literal: LENGTH, slot: "height" }],
  ["left", { types: [], literal: "signed-length", slot: "x" }],
  ["top", { types: [], literal: "signed-length", slot: "y" }],
  ["right", { types: [], literal: "signed-length", slot: "right" }],
  ["bottom", { types: [], literal: "signed-length", slot: "bottom" }],
  ["inset-x", { types: [], literal: "signed-length", slot: "insetX" }],
  ["inset-y", { types: [], literal: "signed-length", slot: "insetY" }],
  ["inset", { types: [], literal: "signed-length", slot: "inset" }],
  ["z", { types: [], literal: "integer", slot: "zIndex" }],
  ["type", { types: ["typography"], literal: undefined, slot: "typography" }],
  ["font", { types: ["font-family", "font-weight"], literal: "font", slot: "font" }],
  ["leading", { types: [], literal: "line-height", slot: "lineHeight" }],
  ["tracking", { types: ["letter-spacing"], literal: "letter-spacing", slot: "letterSpacing" }],
  ["size", { types: SIZING, literal: LENGTH, slot: "size" }],
  ["backdrop-blur", { types: [], literal: "blur", slot: "backgroundBlur" }],
  ["blur", { types: [], literal: "blur", slot: "blur" }],
  ["rotate", { types: [], literal: "angle", slot: "rotation" }],
  ["fill", { types: ["color"], literal: "color", slot: "svgFill" }],
  ["stroke", { types: ["color"], literal: "color-or-length", slot: "svgStroke" }],
]);

const PREFIXES_BY_LENGTH = [...PREFIX_UTILITIES.keys()].sort(
  (left, right) => right.length - left.length,
);

const BLEND_MODES = [
  "normal", "multiply", "screen", "overlay", "darken", "lighten",
  "color-dodge", "color-burn", "hard-light", "soft-light", "difference",
  "exclusion", "hue", "saturation", "color", "luminosity",
];

// Exact classes: class -> list of [slot, value].
const GRID_ALIGN = ["start", "center", "end", "stretch"];
const CONTENT = { start: "start", center: "center", end: "end", between: "space-between", around: "space-around", evenly: "space-evenly", stretch: "stretch" };

const KEYWORDS = new Map([
  ["flex", [["layout", "flex"]]],
  ["inline-flex", [["layout", "flex"]]],
  // What they mean here already: a <div> is a block and a positioning box.
  ["block", []],
  ["inline-block", []],
  ["relative", []],
  // flex-1 and grow fill the parent's room along its direction; nothing
  // shrinks in the App, so the shrink and none forms change nothing.
  ["flex-1", [["grow", true]]],
  ["grow", [["grow", true]]],
  ["grow-0", []],
  ["flex-none", []],
  ["flex-initial", []],
  ["shrink", []],
  ["shrink-0", []],
  ["grid", [["layout", "grid"]]],
  ["grid-flow-row", [["gridDir", "row"]]],
  ["grid-flow-col", [["gridDir", "column"]]],
  ...GRID_ALIGN.map((value) => [`justify-items-${value}`, [["justifyItems", value]]]),
  ...["auto", ...GRID_ALIGN].map((value) => [`justify-self-${value}`, [["justifySelf", value]]]),
  ...Object.entries(CONTENT).map(([key, value]) => [`content-${key}`, [["alignContent", value]]]),
  ["flex-row", [["direction", "row"]]],
  ["flex-col", [["direction", "column"]]],
  ["flex-row-reverse", [["direction", "row-reverse"]]],
  ["flex-col-reverse", [["direction", "column-reverse"]]],
  ["flex-wrap", [["wrap", "wrap"]]],
  ["flex-nowrap", [["wrap", "nowrap"]]],
  ["items-start", [["alignItems", "start"]]],
  ["items-center", [["alignItems", "center"]]],
  ["items-end", [["alignItems", "end"]]],
  ["items-stretch", [["alignItems", "stretch"]]],
  ["justify-start", [["justify", "start"]]],
  ["justify-center", [["justify", "center"]]],
  ["justify-end", [["justify", "end"]]],
  ["justify-between", [["justify", "space-between"]]],
  ["justify-around", [["justify", "space-around"]]],
  ["justify-evenly", [["justify", "space-evenly"]]],
  ["justify-stretch", [["justify", "stretch"]]],
  ["self-auto", [["alignSelf", undefined]]],
  ["self-start", [["alignSelf", "start"]]],
  ["self-center", [["alignSelf", "center"]]],
  ["self-end", [["alignSelf", "end"]]],
  ["self-stretch", [["alignSelf", "stretch"]]],
  ["absolute", [["absolute", true]]],
  ["static", [["absolute", false]]],
  ["hidden", [["visible", false]]],
  ["shown", [["visible", true]]],
  ["overflow-visible", [["clip", false]]],
  ["overflow-hidden", [["clip", true]]],
  ["viewer-hidden", [["viewerHidden", true]]],
  ["viewer-shown", [["viewerHidden", false]]],
  ["flip-x", [["flipX", true]]],
  ["flip-y", [["flipY", true]]],
  ...["normal", "nowrap", "pre", "pre-wrap", "pre-line", "break-spaces"].map((mode) => [`whitespace-${mode}`, [["whitespace", mode]]]),
  ["italic", [["fontStyle", "italic"]]],
  ["not-italic", [["fontStyle", "normal"]]],
  ["uppercase", [["textTransform", "uppercase"]]],
  ["lowercase", [["textTransform", "lowercase"]]],
  ["capitalize", [["textTransform", "capitalize"]]],
  ["normal-case", [["textTransform", "none"]]],
  ["underline", [["textDecoration", "underline"]]],
  ["line-through", [["textDecoration", "line-through"]]],
  ["no-underline", [["textDecoration", "none"]]],
  ["align-top", [["verticalAlign", "top"]]],
  ["align-middle", [["verticalAlign", "center"]]],
  ["align-bottom", [["verticalAlign", "bottom"]]],
  ["text-left", [["textAlign", "left"]]],
  ["text-center", [["textAlign", "center"]]],
  ["text-right", [["textAlign", "right"]]],
  ["text-justify", [["textAlign", "justify"]]],
  ["text-ltr", [["textDirection", "ltr"]]],
  ["text-rtl", [["textDirection", "rtl"]]],
  ["border", [["strokeWidth", { value: 1 }]]],
  ["border-0", [["strokeWidth", { value: 0 }]]],
  ["border-t", [["strokeWidthTop", { value: 1 }]]],
  ["border-r", [["strokeWidthRight", { value: 1 }]]],
  ["border-b", [["strokeWidthBottom", { value: 1 }]]],
  ["border-l", [["strokeWidthLeft", { value: 1 }]]],
  ["border-t-0", [["strokeWidthTop", { value: 0 }]]],
  ["border-r-0", [["strokeWidthRight", { value: 0 }]]],
  ["border-b-0", [["strokeWidthBottom", { value: 0 }]]],
  ["border-l-0", [["strokeWidthLeft", { value: 0 }]]],
  ["border-none", [["stroke", null]]],
  ["border-solid", [["strokeStyle", "solid"]]],
  ["border-dashed", [["strokeStyle", "dashed"]]],
  ["border-dotted", [["strokeStyle", "dotted"]]],
  ["border-mixed", [["strokeStyle", "mixed"]]],
  ["border-inside", [["strokeAlignment", "inner"]]],
  ["border-center", [["strokeAlignment", "center"]]],
  ["border-outside", [["strokeAlignment", "outer"]]],
  // Kept but not drawn, as the App's eye button on a stroke.
  ["border-hidden", [["strokeHidden", true]]],
  ["border-shown", [["strokeHidden", false]]],
  ["stroke-hidden", [["strokeHidden", true]]],
  ["stroke-shown", [["strokeHidden", false]]],
  ["bg-none", [["fill", null]]],
  ["rounded-none", [["radius", { value: 0 }]]],
  ["shadow-none", [["shadow", null]]],
  ["blur-none", [["blur", null]]],
  ["backdrop-blur-none", [["backgroundBlur", null]]],
  ["w-full", [["width", { mode: "fill" }]]],
  ["w-fit", [["width", { mode: "hug" }]]],
  ["h-full", [["height", { mode: "fill" }]]],
  ["h-fit", [["height", { mode: "hug" }]]],
  ["pin-x-left", [["pinX", "left"]]],
  ["pin-x-right", [["pinX", "right"]]],
  ["pin-x-stretch", [["pinX", "leftright"]]],
  ["pin-x-center", [["pinX", "center"]]],
  ["pin-x-scale", [["pinX", "scale"]]],
  ["pin-y-top", [["pinY", "top"]]],
  ["pin-y-bottom", [["pinY", "bottom"]]],
  ["pin-y-stretch", [["pinY", "topbottom"]]],
  ["pin-y-center", [["pinY", "center"]]],
  ["pin-y-scale", [["pinY", "scale"]]],
  ...BLEND_MODES.map((mode) => [`mix-blend-${mode}`, [["blendMode", mode]]]),
]);

// Hints for classes people often write that SmallPen does not accept.
const REWRITES = new Map([
  ["flex-column", "flex-col"],
]);

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const PX = /^(-?\d+(?:\.\d+)?)px$/;
const NUMBER = /^-?\d+(?:\.\d+)?$/;

// Any stored color text as hex: #rgb, #rrggbb(aa), rgb() and rgba() all
// become #rrggbb or #rrggbbaa, the only color form the format writes.
// The opacity a hex alpha byte stands for. Opacities the App sets are whole
// percents; every percent has its own byte, so a byte that some percent
// rounds to reads back as exactly that percent (b3 is 0.7, not 0.702).
export function alphaFromByte(byte) {
  const percent = Math.round(byte / 2.55);
  if (Math.round((percent / 100) * 255) === byte) return percent / 100;
  return Math.round((byte / 255) * 1000) / 1000;
}

export function normalizeHex(text) {
  if (String(text).trim().toLowerCase() === "transparent") return "#00000000";
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+%?)\s*)?\)$/i.exec(String(text).trim());
  if (rgb) {
    const channel = (value) => Math.max(0, Math.min(255, Math.round(Number(value)))).toString(16).padStart(2, "0");
    let alpha = "";
    if (rgb[4] !== undefined) {
      const value = rgb[4].endsWith("%") ? Number(rgb[4].slice(0, -1)) / 100 : Number(rgb[4]);
      if (value < 1) alpha = Math.round(Math.max(0, value) * 255).toString(16).padStart(2, "0");
    }
    return `#${channel(rgb[1])}${channel(rgb[2])}${channel(rgb[3])}${alpha}`;
  }
  let hex = String(text).toLowerCase();
  if (hex.length === 4) hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  return hex;
}

export function parseLength(text, { signed = false } = {}) {
  if (text === "0") return 0;
  const match = PX.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || (!signed && value < 0)) return undefined;
  return value;
}

export function formatLength(value) {
  return value === 0 ? "0" : `${formatNumber(value)}px`;
}

export function formatNumber(value) {
  return String(Math.round(value * 10000) / 10000);
}

// CSS box-shadow text <-> SmallPen shadow objects.
export function parseShadow(text) {
  const layers = [];
  for (const layerText of splitTop(text, ",")) {
    const parts = splitTop(layerText, " ");
    const layer = { offsetX: 0, offsetY: 0, blur: 0, spread: 0, color: "#000000" };
    const lengths = [];
    let color;
    for (const part of parts) {
      if (part === "inset") layer.inset = true;
      else if (part === "hidden") layer.hidden = true;
      else if (HEX.test(part)) color = normalizeHex(part);
      else {
        const value = parseLength(part, { signed: true });
        if (value === undefined) return undefined;
        lengths.push(value);
      }
    }
    if (lengths.length < 2 || lengths.length > 4 || !color) return undefined;
    [layer.offsetX, layer.offsetY, layer.blur = 0, layer.spread = 0] = lengths;
    if (layer.blur < 0) return undefined;
    layer.color = color;
    layers.push(layer);
  }
  if (layers.length === 0) return undefined;
  return layers.length === 1 ? layers[0] : layers;
}

// A shadow layer as SmallPen writes it, from either the canonical
// {offsetX, offsetY, color: "#hex"} or the record the App stores after an
// edit ({"offset-x", style: "inner-shadow", color: {color, opacity}}).
export function shadowLayers(value) {
  return (Array.isArray(value) ? value : [value]).map((layer) => {
    const native = layer.color !== null && typeof layer.color === "object";
    const number = (field, kebab) => Number.parseFloat(layer[field] ?? layer[kebab] ?? 0) || 0;
    return {
      blur: number("blur", "blur"),
      color: native ? layer.color.color ?? "#000000" : layer.color ?? "#000000",
      hidden: layer.hidden === true,
      inset: layer.inset === true || layer.style === "inner-shadow",
      offsetX: number("offsetX", "offset-x"),
      offsetY: number("offsetY", "offset-y"),
      opacity: native ? layer.color.opacity : layer.opacity,
      spread: number("spread", "spread"),
    };
  });
}

export function formatShadow(value, separator = " ") {
  return shadowLayers(value)
    .map((layer) =>
      [
        layer.inset ? "inset" : undefined,
        formatLength(layer.offsetX),
        formatLength(layer.offsetY),
        formatLength(layer.blur),
        formatLength(layer.spread),
        shadowColor(layer),
        layer.hidden ? "hidden" : undefined,
      ].filter(Boolean).join(separator),
    )
    .join(separator === " " ? ", " : ",");
}

function shadowColor(layer) {
  const color = normalizeHex(layer.color ?? "#000000");
  if (layer.opacity === undefined || layer.opacity === null || layer.opacity === 1 || color.length === 9) return color;
  const alpha = Math.round(Math.max(0, Math.min(1, layer.opacity)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${color}${alpha}`;
}

function splitTop(text, separator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (depth === 0 && (separator === " " ? /\s/.test(char) : char === separator)) {
      const part = text.slice(start, index).trim();
      if (part) parts.push(part);
      start = index + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

// Gradients keep Penpot's geometry exactly: start and end points (0..1 of
// the box), the ellipse width ratio for radial ones, and the stops.
// linear-gradient(from 0.5 0 to 0.5 1, #ff0000 0%, #0000ff 100%)
// radial-gradient(from 0.5 0.5 to 0.5 1 width 1, #ff0000 0%, #0000ff 100%)
const GRADIENT = /^(linear|radial)-gradient\(\s*from\s+(-?[\d.]+)\s+(-?[\d.]+)\s+to\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s+width\s+([\d.]+))?\s*,(.+)\)$/;

// CSS forms: linear-gradient(to bottom | 135deg, #000, #fff 80%) and the
// default radial-gradient(#000, #fff) (an ellipse round the centre to the
// farthest corner) or radial-gradient(closest-side, …). A side or a right
// angle maps to box points directly; other angles depend on the box, so
// they keep cssDirection until seedGeometry knows the size.
const SIDES = {
  "to bottom": [0.5, 0, 0.5, 1], "to top": [0.5, 1, 0.5, 0],
  "to right": [0, 0.5, 1, 0.5], "to left": [1, 0.5, 0, 0.5],
};
const RIGHT_ANGLES = { 0: "to top", 90: "to right", 180: "to bottom", 270: "to left" };
const FARTHEST = Math.SQRT1_2;

function cssStops(parts) {
  const stops = [];
  for (const part of parts) {
    const stop = /^\s*(#[0-9a-fA-F]{3,8})(?:\s+(-?[\d.]+)%)?\s*$/.exec(part);
    if (!stop || !HEX.test(stop[1])) return undefined;
    const color = normalizeHex(stop[1]);
    const offset = stop[2] === undefined ? undefined : Number(stop[2]) / 100;
    if (offset !== undefined && (offset < 0 || offset > 1)) return undefined;
    stops.push(color.length === 9
      ? { color: color.slice(0, 7), offset, opacity: alphaFromByte(Number.parseInt(color.slice(7), 16)) }
      : { color, offset });
  }
  if (stops.length < 2) return undefined;
  // Stops without a place: the first at 0, the last at 1, the rest evenly
  // between their placed neighbours, as in CSS.
  if (stops[0].offset === undefined) stops[0].offset = 0;
  if (stops.at(-1).offset === undefined) stops.at(-1).offset = 1;
  for (let index = 1; index < stops.length - 1; index += 1) {
    if (stops[index].offset !== undefined) continue;
    let next = index;
    while (stops[next].offset === undefined) next += 1;
    const from = stops[index - 1].offset;
    const step = (stops[next].offset - from) / (next - index + 1);
    for (let fill = index; fill < next; fill += 1) stops[fill].offset = Math.round((from + step * (fill - index + 1)) * 10000) / 10000;
  }
  return stops.map((stop) => (stop.opacity === undefined ? { color: stop.color, offset: stop.offset } : stop));
}

function parseCssGradient(text) {
  const match = /^(linear|radial)-gradient\((.*)\)$/.exec(text.trim());
  if (!match) return undefined;
  const parts = splitTop(match[2], ",").map((part) => part.trim());
  if (match[1] === "radial") {
    let end = 0.5 + FARTHEST;
    if (parts[0] === "closest-side") {
      end = 1;
      parts.shift();
    } else if (["ellipse", "ellipse farthest-corner", "ellipse at center", "farthest-corner"].includes(parts[0])) parts.shift();
    const stops = cssStops(parts);
    return stops && { endX: 0.5, endY: end, gradientWidth: 1, startX: 0.5, startY: 0.5, stops, type: "radial-gradient" };
  }
  let direction = "to bottom";
  let angle;
  if (/^to\s/.test(parts[0])) direction = parts.shift().replace(/\s+/g, " ");
  else if (/^-?[\d.]+deg$/.test(parts[0])) {
    angle = ((Number.parseFloat(parts.shift()) % 360) + 360) % 360;
    if (RIGHT_ANGLES[angle]) direction = RIGHT_ANGLES[angle];
    else direction = undefined;
  }
  const stops = cssStops(parts);
  if (!stops) return undefined;
  const gradient = { gradientWidth: 1, stops, type: "linear-gradient" };
  if (direction && SIDES[direction]) {
    [gradient.startX, gradient.startY, gradient.endX, gradient.endY] = SIDES[direction];
    return gradient;
  }
  const corner = direction && /^to (top|bottom) (left|right)$|^to (left|right) (top|bottom)$/.exec(direction);
  if (direction && !corner) return undefined;
  gradient.cssDirection = corner
    ? { vertical: corner[1] ?? corner[4], horizontal: corner[2] ?? corner[3] }
    : { angle };
  Object.assign(gradient, cssGradientPoints(gradient.cssDirection, 1, 1));
  return gradient;
}

// Box points of a CSS gradient line for a box of this size: through the
// centre, long enough that the corners reach 0% and 100%.
export function cssGradientPoints(direction, width, height) {
  let dx;
  let dy;
  if (direction.angle !== undefined) {
    const radians = (direction.angle * Math.PI) / 180;
    dx = Math.sin(radians);
    dy = -Math.cos(radians);
  } else {
    // "to bottom right": the 50% line joins the other two corners.
    dx = (direction.horizontal === "right" ? 1 : -1) * height;
    dy = (direction.vertical === "bottom" ? 1 : -1) * width;
    const length = Math.hypot(dx, dy) || 1;
    dx /= length;
    dy /= length;
  }
  const half = (Math.abs(width * dx) + Math.abs(height * dy)) / 2;
  const round = (value) => Math.round(value * 10000) / 10000;
  return {
    startX: round((width / 2 - dx * half) / (width || 1)),
    startY: round((height / 2 - dy * half) / (height || 1)),
    endX: round((width / 2 + dx * half) / (width || 1)),
    endY: round((height / 2 + dy * half) / (height || 1)),
  };
}

export function parseGradient(text) {
  const match = GRADIENT.exec(text.trim());
  if (!match) return parseCssGradient(text);
  const stops = [];
  for (const part of match[7].split(",")) {
    const stop = /^\s*(#[0-9a-fA-F]{3,8})\s+(-?[\d.]+)%\s*$/.exec(part);
    if (!stop || !HEX.test(stop[1])) return undefined;
    const offset = Number(stop[2]) / 100;
    if (offset < 0 || offset > 1) return undefined;
    const color = normalizeHex(stop[1]);
    stops.push(color.length === 9
      ? { color: color.slice(0, 7), offset, opacity: alphaFromByte(Number.parseInt(color.slice(7), 16)) }
      : { color, offset });
  }
  if (stops.length === 0) return undefined;
  return {
    endX: Number(match[4]),
    endY: Number(match[5]),
    gradientWidth: match[6] === undefined ? 1 : Number(match[6]),
    startX: Number(match[2]),
    startY: Number(match[3]),
    stops,
    type: `${match[1]}-gradient`,
  };
}

export function formatGradient(paint, separator = "_") {
  const alpha = (stop) => {
    const opacity = (stop.opacity ?? 1) * (paint.opacity ?? 1);
    const color = normalizeHex(stop.color);
    if (opacity >= 1 || color.length === 9) return color;
    return `${color}${Math.round(Math.max(0, opacity) * 255).toString(16).padStart(2, "0")}`;
  };
  const kind = paint.type === "radial-gradient" ? "radial" : "linear";
  const stopList = (paint.stops ?? []).map((stop) => `${alpha(stop)}${separator}${formatNumber(stop.offset * 100)}%`).join(",");
  // The CSS form where it says the same: a side, or the default ellipse.
  const near = (left, right) => Math.abs(left - right) < 1e-4;
  const points = [paint.startX, paint.startY, paint.endX, paint.endY].map(Number);
  if (kind === "linear") {
    const side = Object.entries(SIDES).find(([, box]) => box.every((value, index) => near(value, points[index])));
    if (side) return `linear-gradient(${side[0].replace(" ", separator)},${stopList})`;
  } else if ((paint.gradientWidth ?? 1) === 1 && near(points[0], 0.5) && near(points[1], 0.5) && near(points[2], 0.5)) {
    if (near(points[3], 0.5 + FARTHEST)) return `radial-gradient(${stopList})`;
    if (near(points[3], 1)) return `radial-gradient(closest-side,${stopList})`;
  }
  const width = paint.gradientWidth !== undefined && paint.gradientWidth !== 1 ? `${separator}width${separator}${formatNumber(paint.gradientWidth)}` : "";
  const head = ["from", formatNumber(paint.startX), formatNumber(paint.startY), "to", formatNumber(paint.endX), formatNumber(paint.endY)].join(separator);
  const stops = (paint.stops ?? []).map((stop) => `${alpha(stop)}${separator}${formatNumber(stop.offset * 100)}%`);
  return `${kind}-gradient(${head}${width},${stops.join(",")})`;
}

// `_` stands for a space in a bracket value, except inside url(...): file
// names keep their underscores there, as in Tailwind.
export function bracketText(text) {
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (text.startsWith("url(", index)) {
      const end = text.indexOf(")", index);
      if (end !== -1) {
        out += text.slice(index, end + 1);
        index = end + 1;
        continue;
      }
    }
    out += text[index] === "_" ? " " : text[index];
    index += 1;
  }
  return out;
}

const URL_LAYER = /^url\(\s*(['"]?)([^'"()\s]+)\1\s*\)(?:\s+(\d+(?:\.\d+)?))?$/;
const VARIABLE = /^var\(\s*--([a-z][a-z0-9-]*)\s*\)$/;

// One layer of a fill list: a color, a gradient, an image url(...) with an
// optional opacity, or a color Token as var(--color-x).
function parsePaintLayer(text) {
  if (HEX.test(text)) return { color: normalizeHex(text) };
  const gradient = parseGradient(text);
  if (gradient) return { gradient };
  const url = URL_LAYER.exec(text);
  if (url) {
    const opacity = url[3] === undefined ? undefined : Number(url[3]);
    if (opacity !== undefined && !(opacity >= 0 && opacity <= 1)) return undefined;
    let image;
    try {
      image = decodeURI(url[2]);
    } catch {
      return undefined;
    }
    return opacity === undefined || opacity === 1 ? { image } : { image, opacity };
  }
  const variable = VARIABLE.exec(text);
  if (variable) return { token: variable[1], tokenType: "color" };
  return undefined;
}

// Fills, top layer first as in CSS background: bg-[#fff], a gradient, or a
// list bg-[url(../assets/a.png),linear-gradient(…),#ffffff].
function parsePaint(text) {
  const layers = splitTop(text, ",").map(parsePaintLayer);
  if (layers.length === 0 || layers.some((layer) => !layer)) return undefined;
  if (layers.length === 1 && layers[0].color) return { color: layers[0].color };
  if (layers.length === 1 && layers[0].gradient) return { gradient: layers[0].gradient };
  return { layers };
}

const STROKE_STYLES = new Set(["solid", "dashed", "dotted", "mixed"]);
const STROKE_ALIGNMENTS = { inside: "inner", center: "center", outside: "outer" };

// Strokes, top first: border-[1px_#e5e7eb,2px_dashed_var(--color-brand)_outside].
// Each stroke: a width (px or a stroke-width Token), a color, and optionally
// a style, where it sits, and hidden (kept but not drawn).
function parseStrokes(text) {
  const strokes = [];
  for (const part of splitTop(text, ",")) {
    const stroke = {};
    for (const word of splitTop(part, " ")) {
      const variable = VARIABLE.exec(word);
      if (HEX.test(word) && !stroke.color) stroke.color = { color: normalizeHex(word) };
      else if (variable && !stroke.color && tokenTypeOfName(variable[1])?.type === "color") stroke.color = { token: variable[1], tokenType: "color" };
      else if (variable && !stroke.width && tokenTypeOfName(variable[1])?.type === "stroke-width") stroke.width = { token: variable[1], tokenType: "stroke-width" };
      else if (STROKE_STYLES.has(word) && !stroke.style) stroke.style = word;
      else if (STROKE_ALIGNMENTS[word] && !stroke.alignment) stroke.alignment = STROKE_ALIGNMENTS[word];
      else if (word === "hidden" && !stroke.hidden) stroke.hidden = true;
      else if (parseLength(word) !== undefined && !stroke.width) stroke.width = { value: parseLength(word) };
      else return undefined;
    }
    if (!stroke.color) return undefined;
    strokes.push(stroke);
  }
  return strokes.length ? { strokes } : undefined;
}

// Tokens of a type this class takes whose value (in :root or a theme
// option) is the literal's: a hard-coded copy of a Token value.
// Tokens whose value equals a raw value: candidates to name it by, when
// the places mean the same thing (equal values alone do not say so).
export function tokensWithValue(literal, types, tokens) {
  const color = typeof literal.color === "string" ? literal.color.toLowerCase() : undefined;
  const length = typeof literal.value === "number" && !literal.layers && !literal.strokes ? literal.value : undefined;
  if (color === undefined && length === undefined) return [];
  const found = [];
  for (const [name, token] of tokens) {
    // A size that happens to equal a size Token is common; a colour or a
    // step of the spacing or radius scale is a copied value.
    if (!types.includes(token.type) || !token.scopes || token.type === "sizing") continue;
    // White and black are everyone's colours: only a Token named for them
    // is the one a literal copies.
    if (token.type === "color" && /^#(ffffff|000000)(ff)?$/.test(color ?? "") && !/white|black/.test(name)) continue;
    for (const [scope, entry] of token.scopes) {
      if (entry.alias) continue;
      const hit = token.type === "color" ? color !== undefined && typeof entry.value === "string" && entry.value.toLowerCase() === color
        : length !== undefined && length !== 0 && Number(entry.value) === length;
      if (hit) {
        found.push({ name, scope });
        break;
      }
    }
    if (found.length >= 3) break;
  }
  return found;
}

// var(--name) inside a literal names a Token: it must exist and have the
// type its place takes. Returns an error message, or undefined.
function literalTokens(literal, tokens) {
  const named = [
    ...(literal.layers ?? []).filter((layer) => layer.token),
    ...(literal.strokes ?? []).flatMap((stroke) => [stroke.color, stroke.width]).filter((value) => value?.token),
  ];
  for (const { token, tokenType } of named) {
    if (!tokens.has(token)) return `no Token --${token}`;
    const type = tokens.get(token)?.type ?? tokenTypeOfName(token)?.type;
    if (type && type !== tokenType) return `--${token} is a ${type} Token; this place takes a ${tokenType} Token`;
  }
  return undefined;
}

// Grid tracks: 240px fixed, 1fr a share of the room left, auto fits its
// content, 25% of the grid.
export function parseTracks(text) {
  const tracks = [];
  for (const word of text.trim().split(/\s+/)) {
    let match;
    if (word === "auto") tracks.push({ type: "auto" });
    else if ((match = /^(\d+(?:\.\d+)?)fr$/.exec(word))) tracks.push({ type: "flex", value: Number(match[1]) });
    else if ((match = /^(\d+(?:\.\d+)?)%$/.exec(word))) tracks.push({ type: "percent", value: Number(match[1]) });
    else if (parseLength(word) !== undefined) tracks.push({ type: "fixed", value: parseLength(word) });
    else return undefined;
  }
  return tracks.length ? tracks : undefined;
}

export function formatTracks(tracks) {
  return tracks
    .map((track) => {
      if (track.type === "auto") return "auto";
      if (track.type === "flex") return `${formatNumber(track.value ?? 1)}fr`;
      if (track.type === "percent") return `${formatNumber(track.value ?? 0)}%`;
      return formatLength(track.value ?? 0);
    })
    .join("_");
}

function parseLiteral(kind, text) {
  switch (kind) {
    case "paint":
      return parsePaint(text);
    case "color":
      return HEX.test(text) ? { color: normalizeHex(text) } : undefined;
    case LENGTH: {
      const value = parseLength(text);
      return value === undefined ? undefined : { value };
    }
    case "signed-length": {
      const value = parseLength(text, { signed: true });
      return value === undefined ? undefined : { value };
    }
    case "color-or-length":
      if (HEX.test(text)) return { color: normalizeHex(text) };
      return parseLiteral(LENGTH, text);
    case "blur": {
      // blur-[4px], or blur-[4px_hidden]: kept but not drawn.
      const [amount, flag, ...more] = text.trim().split(/\s+/);
      const value = parseLength(amount ?? "");
      if (value === undefined || more.length || (flag !== undefined && flag !== "hidden")) return undefined;
      return flag ? { value, hidden: true } : { value };
    }
    case "stroke": {
      if (HEX.test(text)) return { color: normalizeHex(text) };
      const width = parseLiteral(LENGTH, text);
      return width ?? parseStrokes(text);
    }
    case "unit": {
      if (!NUMBER.test(text)) return undefined;
      const value = Number(text);
      return value >= 0 && value <= 1 ? { value } : undefined;
    }
    case "number":
      return NUMBER.test(text) && Number(text) > 0 ? { value: Number(text) } : undefined;
    case "line-height": {
      // As in CSS: a number is a multiple of the font size, px is px.
      if (NUMBER.test(text) && Number(text) > 0) return { value: Number(text) };
      const px = parseLength(text);
      return px > 0 ? { px } : undefined;
    }
    case "letter-spacing": {
      const em = /^(-?\d+(?:\.\d+)?)em$/.exec(text);
      if (em) return { em: Number(em[1]) };
      const value = parseLength(text, { signed: true });
      return value === undefined ? undefined : { value };
    }
    case "integer":
      return /^-?\d+$/.test(text) ? { value: Number(text) } : undefined;
    case "angle": {
      const match = /^(-?\d+(?:\.\d+)?)deg$/.exec(text);
      if (!match) return undefined;
      const value = ((Number(match[1]) % 360) + 360) % 360;
      return { value };
    }
    case "shadow": {
      const value = parseShadow(text);
      return value === undefined ? undefined : { value };
    }
    case "font":
      if (/^\d{3}$/.test(text)) {
        const weight = Number(text);
        return weight >= 100 && weight <= 950 ? { weight } : undefined;
      }
      return text.trim() ? { family: text.trim().replace(/^['"]|['"]$/g, "") } : undefined;
    default:
      return undefined;
  }
}

// tokens: Map(cssName without "--" -> { type }). Returns
// { slots: [[slot, payload]] } or { error: { code, message, hint? } }.
// Class names repeat across a package; results are remembered per Token
// table (one table per read).
// The candidate closest to a misspelled name, when it is close enough.
export function suggestion(name, candidates) {
  const lower = name.toLowerCase();
  let best;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const score = distance(lower, candidate.toLowerCase());
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best !== undefined && bestScore <= Math.max(2, Math.floor(name.length / 3)) ? best : undefined;
}

function distance(left, right) {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (left[i - 1] === right[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[right.length];
}

const classMemo = new WeakMap();

export function resolveClass(className, tokens) {
  let memo = classMemo.get(tokens);
  if (!memo) classMemo.set(tokens, (memo = new Map()));
  let result = memo.get(className);
  if (!result) {
    result = resolveClassUncached(className, tokens);
    memo.set(className, result);
  }
  return result;
}

// grid-cols-3, col-start-2, row-span-2: Tailwind's whole-number forms.
const GRID_COUNT = /^grid-(cols|rows)-(\d+)$/;
const GRID_PLACE = /^(col|row)-(start|span)-(\d+)$/;
const GRID_TRACKS = /^grid-(cols|rows)-\[(.*)\]$/;

// Slots a Tailwind step, size or name can fill, by kind.
const STEP_SLOTS = new Set([
  "padding", "paddingX", "paddingY", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "margin", "marginX", "marginY", "marginTop", "marginRight", "marginBottom", "marginLeft",
  "gap", "rowGap", "columnGap", "width", "height", "minWidth", "maxWidth", "minHeight", "maxHeight",
  "x", "y", "right", "bottom", "inset", "insetX", "insetY", "size",
]);
const CONTAINER_SLOTS = new Set(["width", "minWidth", "maxWidth"]);
const RADIUS_SLOTS = new Set(["radius", "radiusTopLeft", "radiusTopRight", "radiusBottomRight", "radiusBottomLeft"]);
const SIDE_WIDTH_SLOTS = new Set(["strokeWidthTop", "strokeWidthRight", "strokeWidthBottom", "strokeWidthLeft"]);
// -left-4, -inset-1, -tracking-wide: the only values that may be negative.
const SIGNED_SLOTS = new Set(["x", "y", "right", "bottom", "inset", "insetX", "insetY", "letterSpacing"]);
const BARE = new Set(["rounded", "shadow", "blur", "backdrop-blur"]);

function raw(slot, payload) {
  return { slots: [[slot, { ...payload, literal: true }]] };
}

function failure(message) {
  return { error: { code: "invalid_literal", message } };
}

// What Tailwind v4's default theme gives a class no package Token names: a
// raw value, the same as the bracket form. Undefined when Tailwind has none.
function tailwindValue(prefix, rest, utility, className) {
  const slot = utility.slot;
  if (STEP_SLOTS.has(slot)) {
    const steps = spacingSteps(rest);
    if (steps !== undefined) return raw(slot, { value: steps });
    if (CONTAINER_SLOTS.has(slot) && CONTAINERS[rest] !== undefined) return raw(slot, { value: CONTAINERS[rest] });
    if (["width", "height", "minWidth", "maxWidth", "minHeight", "maxHeight", "size"].includes(slot)) {
      const axis = prefix.endsWith("w") ? "w" : "h";
      if (rest === "auto") return failure(`${className} depends on the parent in CSS; write ${axis}-fit to hug the content or ${axis}-full to fill the room`);
      if (rest === "screen") return failure(`${className}: write ${axis}-full; the page is the screen`);
      if (/^\d+\/\d+$/.test(rest)) return failure(`${className}: the App has no percent sizes; share the room with ${axis}-full on each child, or write px`);
    }
  }
  if (RADIUS_SLOTS.has(slot) && RADIUS[rest] !== undefined) return raw(slot, { value: RADIUS[rest] });
  if (slot === "shadow" && SHADOWS[rest] !== undefined) return raw(slot, { value: parseShadow(SHADOWS[rest]) });
  if ((slot === "blur" || slot === "backgroundBlur") && BLURS[rest] !== undefined) return raw(slot, { value: BLURS[rest] });
  if (slot === "font") {
    if (FONT_WEIGHTS[rest] !== undefined) return raw(slot, { weight: FONT_WEIGHTS[rest] });
    if (["sans", "serif", "mono"].includes(rest)) {
      return failure(`${className}: Tailwind's font stacks are not built in; add the font with @font-face in tokens.css and a --font-${rest} Token, or write font-[Family]`);
    }
  }
  if (slot === "text" && TEXT_SIZES[rest]) {
    const [size, lineHeight] = TEXT_SIZES[rest];
    return { slots: [["text", { value: size, literal: true }], ["impliedLineHeight", { px: lineHeight, literal: true }]] };
  }
  if (["text", "fill", "border", "svgFill", "svgStroke"].includes(slot)) {
    if (slot === "fill" && rest === "transparent") return { slots: [["fill", null]] };
    if (COLORS[rest]) return raw(slot, { color: COLORS[rest] });
    if (isPaletteColor(rest)) return failure(`${className}: Tailwind's color palette is not built in; use a color Token (${prefix}-brand) or ${prefix}-[#hex]`);
  }
  if ((slot === "border" || slot === "svgStroke" || SIDE_WIDTH_SLOTS.has(slot)) && /^\d+$/.test(rest)) return raw(slot, { value: Number(rest) });
  if (slot === "opacity" && /^\d+$/.test(rest) && Number(rest) <= 100) return raw(slot, { value: Number(rest) / 100 });
  if (slot === "letterSpacing" && TRACKING[rest] !== undefined) return raw(slot, { em: TRACKING[rest] });
  if (slot === "lineHeight") {
    if (LEADING[rest] !== undefined) return raw(slot, { value: LEADING[rest] });
    const steps = spacingSteps(rest);
    if (steps !== undefined) return raw(slot, { px: steps });
  }
  if (slot === "zIndex" && /^\d+$/.test(rest)) return raw(slot, { value: Number(rest) });
  if (slot === "rotation" && /^\d+(?:\.\d+)?$/.test(rest)) return raw(slot, { value: Number(rest) % 360 });
  return undefined;
}

function resolveClassUncached(className, tokens) {
  const keyword = KEYWORDS.get(className);
  if (keyword) return { slots: keyword.map(([slot, value]) => [slot, value]) };
  if (className.startsWith("-") && className.length > 1) {
    const positive = resolveClassUncached(className.slice(1), tokens);
    if (positive.error) return positive;
    const signed = positive.slots.length > 0 && positive.slots.every(([slot, payload]) =>
      SIGNED_SLOTS.has(slot) && payload && !payload.token && (typeof payload.value === "number" || typeof payload.em === "number"));
    if (!signed) return failure(`${className}: only left, top, right, bottom, inset and tracking take a minus`);
    return {
      ...positive,
      slots: positive.slots.map(([slot, payload]) => [slot, payload.em !== undefined ? { ...payload, em: -payload.em } : { ...payload, value: -payload.value }]),
    };
  }
  if (BARE.has(className)) {
    const fallback = tailwindValue(className, "", PREFIX_UTILITIES.get(className), className);
    if (fallback) return fallback;
  }
  // text-sm/6, text-[14px]/[20px]: a font size and its line height.
  const pair = /^text-(.+?)\/(.+)$/.exec(className);
  if (pair) {
    const size = resolveClassUncached(`text-${pair[1]}`, tokens);
    if (size.error) return size;
    if (!size.slots.some(([slot, payload]) => slot === "text" && payload && !payload.color && payload.tokenType !== "color")) {
      return failure(`${className}: text-SIZE/LEADING takes a font size before the /`);
    }
    const leading = resolveClassUncached(`leading-${pair[2]}`, tokens);
    if (leading.error) return { error: { ...leading.error, message: leading.error.message.replace(`leading-${pair[2]}`, className) } };
    return { slots: [...size.slots.filter(([slot]) => slot !== "impliedLineHeight"), ...leading.slots] };
  }
  const count = GRID_COUNT.exec(className);
  if (count) {
    const number = Number(count[2]);
    if (number < 1 || number > 100) return { error: { code: "invalid_literal", message: `${className}: a grid has 1 to 100 ${count[1] === "cols" ? "columns" : "rows"}` } };
    return { slots: [[count[1] === "cols" ? "gridColumns" : "gridRows", Array.from({ length: number }, () => ({ type: "flex", value: 1 }))]] };
  }
  const place = GRID_PLACE.exec(className);
  if (place) {
    const number = Number(place[3]);
    if (number < 1) return { error: { code: "invalid_literal", message: `${className}: grid lines and spans count from 1` } };
    const slot = `${place[1] === "col" ? "column" : "row"}${place[2] === "start" ? "Start" : "Span"}`;
    return { slots: [[slot, number]] };
  }
  const tracks = GRID_TRACKS.exec(className);
  if (tracks) {
    const list = parseTracks(tracks[2].replace(/_/g, " "));
    if (!list) {
      return { error: { code: "invalid_literal", message: `${className}: list the tracks, for example grid-${tracks[1]}-[240px_1fr_auto_25%] (px fixed, fr share, auto fits content, % of the grid)` } };
    }
    return { slots: [[tracks[1] === "cols" ? "gridColumns" : "gridRows", list]] };
  }
  for (const prefix of PREFIXES_BY_LENGTH) {
    if (!className.startsWith(`${prefix}-`)) continue;
    const utility = PREFIX_UTILITIES.get(prefix);
    const rest = className.slice(prefix.length + 1);
    if (!rest) break;
    if (rest.startsWith("[")) {
      if (!rest.endsWith("]")) {
        return { error: { code: "invalid_literal", message: `${className}: close the value with ]` } };
      }
      const text = bracketText(rest.slice(1, -1));
      const literal = utility.literal && parseLiteral(utility.literal, text);
      if (!literal) {
        return {
          error: {
            code: "invalid_literal",
            message: `${className}: ${literalHelp(utility.literal, prefix)}`,
          },
        };
      }
      const unknown = literalTokens(literal, tokens);
      if (unknown) return { error: { code: "unknown_token", message: `${className}: ${unknown}` } };
      return { slots: [[utility.slot, { ...literal, literal: true }]] };
    }
    const matches = [];
    for (const type of utility.types) {
      const name = `${TYPE_PREFIX[type]}${rest}`;
      if (tokens.has(name)) matches.push({ name, type });
    }
    if (matches.length === 1) {
      return { slots: [[utility.slot, { token: matches[0].name, tokenType: matches[0].type }]] };
    }
    if (matches.length > 1) {
      return {
        error: {
          code: "token_class_collision",
          message: `${className} matches ${matches.map(({ name }) => `--${name}`).join(" and ")}; rename one of them`,
        },
      };
    }
    const fallback = tailwindValue(prefix, rest, utility, className);
    if (fallback) return fallback;
    // rounded-full is a pill or a circle, as in Tailwind, unless a
    // --radius-full Token says otherwise.
    if (rest === "full" && utility.slot.startsWith("radius")) return { slots: [[utility.slot, { value: 9999, literal: true }]] };
    if (utility.types.length === 0) {
      return {
        error: {
          code: "invalid_literal",
          message: `${className}: write the value in brackets, for example ${prefix}-[${literalExample(utility.literal)}]`,
        },
      };
    }
    const wanted = utility.types.map((type) => `--${TYPE_PREFIX[type]}${rest}`);
    // The nearest Token of a type this class takes, or ones that start alike.
    const names = [...tokens.keys()].flatMap((name) => utility.types.filter((type) => name.startsWith(TYPE_PREFIX[type])).map((type) => name.slice(TYPE_PREFIX[type].length)));
    const near = suggestion(rest, names);
    const alike = near ? [] : names.filter((name) => name.split("-")[0] === rest.split("-")[0]).slice(0, 5);
    const hint = near ? `; did you mean ${prefix}-${near}?` : alike.length ? `; Tokens like it: ${alike.map((name) => `${prefix}-${name}`).join(", ")}` : "";
    // Tailwind's number scale (px-5, border-2) is not SmallPen's: a bare
    // number is a Token name, a length goes in brackets. Spacing and sizes
    // count in quarters of 16px there (px-5 is 20px); borders in px.
    const number = /^\d+(\.\d+)?$/.test(rest) && utility.literal && parseLiteral(utility.literal, `${rest}px`);
    const scaled = number && utility.types.some((type) => type === "spacing" || type === "sizing") ? Number(rest) * 4 : Number(rest);
    const nearby = number
      ? [...tokens].filter(([name, token]) => utility.types.includes(token.type) && Number.isFinite(Number(token.scopes?.get("base")?.value)))
        .map(([name, token]) => ({ name, value: Number(token.scopes.get("base").value) }))
        .sort((left, right) => Math.abs(left.value - scaled) - Math.abs(right.value - scaled)).slice(0, 2)
      : [];
    const numberHint = number
      ? `; ${scaled !== Number(rest) ? `in Tailwind ${className} is ${scaled}px: ` : ""}write ${prefix}-[${scaled}px]${nearby.length ? `, or a Token: ${nearby.map(({ name, value }) => `${prefix}-${tokenTypeOfName(name)?.rest ?? name} (${value}px)`).join(", ")}` : ""}`
      : "";
    return {
      error: {
        code: "unknown_token",
        message: `${className}: no Token ${wanted.join(" or ")}${number ? numberHint : hint}`,
        candidates: utility.types.map((type) => TYPE_PREFIX[type]),
        rest,
        typeMismatch: findOtherType(rest, tokens, utility.types),
      },
    };
  }
  if (/^(?:truncate|text-ellipsis|overflow-ellipsis|line-clamp-\d+)$/.test(className)) {
    return { error: { code: "not_in_app", message: `${className}: the App has no text ellipsis; give the text room for its words, or fewer words` } };
  }
  const rewrite = REWRITES.get(className);
  const near = rewrite ? undefined : suggestion(className, [...KEYWORDS.keys()]);
  return {
    error: {
      code: "unknown_class",
      message: rewrite
        ? `${className} is not a SmallPen class; use ${rewrite}`
        : near
          ? `${className} is not a SmallPen class; did you mean ${near}?`
          : `${className} is not a SmallPen class; smallpen help rules classes lists them`,
    },
  };
}

function findOtherType(rest, tokens, allowed) {
  for (const [prefix, type] of TOKEN_PREFIXES) {
    if (allowed.includes(type)) continue;
    if (tokens.has(`${prefix}${rest}`)) return { name: `${prefix}${rest}`, type };
  }
  return undefined;
}

function literalExample(kind) {
  switch (kind) {
    case "color": return "#2563eb";
    case "paint": return "#2563eb";
    case "stroke": return "#e5e7eb";
    case "unit": return "0.5";
    case "number": return "1.4";
    case "line-height": return "1.4";
    case "letter-spacing": return "0.5px";
    case "integer": return "1";
    case "angle": return "45deg";
    case "shadow": return "0_2px_8px_0_#00000033";
    case "blur": return "4px";
    case "font": return "600";
    default: return "16px";
  }
}

function literalHelp(kind, prefix) {
  if (!kind) return `${prefix}- takes a Token name only`;
  if (kind === "blur") return `expected a length such as ${prefix}-[4px], or ${prefix}-[4px_hidden] to keep it but not draw it`;
  if (kind === "line-height") return `expected a multiple of the font size such as ${prefix}-[1.4], or px such as ${prefix}-[20px]`;
  if (kind === "letter-spacing") return `expected px such as ${prefix}-[0.5px], or em such as ${prefix}-[0.02em]`;
  if (kind === "shadow") return `expected offsets, blur, spread and a color such as ${prefix}-[0_2px_8px_0_#00000033]; add inset for an inner shadow, hidden to keep a layer but not draw it, and separate layers with ,`;
  return `expected a value such as ${prefix}-[${literalExample(kind)}]`;
}

// Class -> list of slot writes for every class in a class attribute.
export function splitClasses(value) {
  const classes = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /\s/.test(value[index])) index += 1;
    const start = index;
    while (index < value.length && !/\s/.test(value[index])) index += 1;
    if (index > start) classes.push({ name: value.slice(start, index), start });
  }
  return classes;
}

// The class vocabulary as data, for help and schema output.
export function vocabularyReference() {
  return {
    tokenPrefixes: TOKEN_PREFIXES.map(([prefix, type]) => ({ variable: `--${prefix}*`, type })),
    valueClasses: [...PREFIX_UTILITIES].map(([prefix, utility]) => ({
      prefix: `${prefix}-`,
      tokens: utility.types,
      literal: utility.literal ? `${prefix}-[${literalExample(utility.literal)}]` : undefined,
    })),
    keywords: [...KEYWORDS.keys()],
    patterns: ["grid-cols-N", "grid-rows-N", "grid-cols-[240px_1fr_auto_25%]", "grid-rows-[…]", "col-start-N", "col-span-N", "row-start-N", "row-span-N"],
  };
}
