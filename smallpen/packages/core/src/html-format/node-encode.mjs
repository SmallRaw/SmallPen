// INPUT:  flat package-model nodes of one Presentation or Variant
// OUTPUT: canonical SmallPen HTML for that tree
// POS:    The encode half of the vocabulary: node fields -> classes. Values
//         layout derives (flex positions, hug and fill sizes) are not written.

import { formatGradient, formatLength, formatNumber, formatShadow, formatTracks, normalizeHex, tokenTypeOfName } from "./vocabulary.mjs";
import { cellsByChild, explicitLines } from "./grid-cells.mjs";
import { formatInteraction } from "./interactions.mjs";

// Editor state the format does not keep (spec section 14): locks, export
// settings, guides. The App may send them; they are not design.
const IGNORED_FIELDS = new Set([
  "id", "children", "type", "touched", "appliedTokens", "locked", "proportionLock",
  "exports", "hide-fill-on-export", "grids", "layout-padding-type", "layout-gap-type", "layout-item-margin-type",
]);
const KNOWN_FIELDS = new Set([
  "name", "x", "y", "width", "height", "fills", "strokes", "tokenBindings", "cornerRadius",
  "text", "textStyle", "textBlocks", "growType", "opacity", "visible", "instance",
  "interactions", "mediaRef", "pathData", "shadow", "rotation", "flipX", "flipY",
  "blend-mode", "show-content", "hide-in-viewer", "constraints-h", "constraints-v", "blur", "backgroundBlur",
  "masked-group",
  "layout", "layout-flex-dir", "layout-wrap-type", "layout-align-items",
  "layout-justify-content", "layout-gap", "layout-padding", "layout-item-margin",
  "layout-item-h-sizing", "layout-item-v-sizing", "layout-item-min-w", "layout-item-max-w",
  "layout-item-min-h", "layout-item-max-h", "layout-item-align-self",
  "layout-item-absolute", "layout-item-z-index", "layout-align-content",
  "layout-grid-dir", "layout-grid-rows", "layout-grid-columns", "layout-grid-cells", "layout-justify-items",
]);
const TEXT_STYLE_FIELDS = new Set([
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing",
  "textAlign", "textDecoration", "textTransform", "verticalAlign", "textDirection",
  "fontId", "fontVariantId",
]);
export function unsupported(message, details) {
  return Object.assign(new Error(message), { code: "unsupported_in_html_format", details });
}

export function escapeText(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttribute(text) {
  return String(text).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function px(value) {
  return `[${formatLength(Number(value))}]`;
}

// ctx: { tokenName(binding) -> name | undefined, tokenValue(name), path,
//   kind, componentById(id), mediaPath(id), link(interaction) -> text,
//   pageRootName, platformSize }
export function createClassWriter(node, ctx, path) {
  const classes = [];
  const bindings = node.tokenBindings ?? {};
  const bound = (field) => {
    const binding = bindings[field];
    if (!binding) return undefined;
    const name = ctx.tokenName(binding);
    if (!name) throw unsupported(`${path}: binding ${field} refers to a Token outside this package`, { path, field });
    return name;
  };
  const rest = (name) => tokenTypeOfName(name)?.rest ?? name;
  // Classes are also kept per group (fill, stroke, width, …) so variant
  // rules can write only the groups that differ.
  const grouped = new Map();
  const writer = {
    ctx,
    classes,
    grouped,
    group: "misc",
    bound,
    add: (value) => {
      if (!value) return;
      classes.push(value);
      if (!grouped.has(writer.group)) grouped.set(writer.group, []);
      grouped.get(writer.group).push(value);
    },
    token: (prefix, field) => {
      const name = bound(field);
      if (!name) return false;
      writer.add(`${prefix}-${rest(name)}`);
      return true;
    },
    rest,
  };
  return writer;
}

// The class that clears a group when a variant drops it.
export const GROUP_RESETS = {
  blur: "blur-none",
  backdrop: "backdrop-blur-none",
  fill: "bg-none",
  textColor: undefined,
  stroke: "border-none",
  strokeHidden: "border-shown",
  radius: "rounded-none",
  shadow: "shadow-none",
  opacity: "opacity-[1]",
  visible: "shown",
  rotation: "rotate-[0deg]",
  overflow: "overflow-hidden",
  viewer: "viewer-shown",
  absolute: "static",
};

function colorLiteral(paint) {
  const color = normalizeHex(paint.color ?? "#000000");
  if (paint.opacity === undefined || paint.opacity === 1 || color.length === 9) return color;
  const alpha = Math.round(Math.max(0, Math.min(1, paint.opacity)) * 255).toString(16).padStart(2, "0");
  return `${color}${alpha}`;
}

const GRADIENT_FIELDS = ["type", "startX", "startY", "endX", "endY", "gradientWidth", "stops", "opacity"];

function solidPaint(list, path, what, { gradients = false } = {}) {
  if (!Array.isArray(list) || list.length === 0) return undefined;
  if (list.length > 1) throw unsupported(`${path}: more than one ${what} is not supported`, { path });
  const [paint] = list;
  if (gradients && (paint.type === "linear-gradient" || paint.type === "radial-gradient")) {
    for (const field of Object.keys(paint)) {
      if (!GRADIENT_FIELDS.includes(field)) throw unsupported(`${path}: gradient field ${field} is not supported`, { path, field });
    }
    return paint;
  }
  if ((paint.type ?? "solid") !== "solid") throw unsupported(`${path}: ${paint.type} ${what}s are not supported`, { path });
  for (const field of Object.keys(paint)) {
    if (field === "hidden" && what === "stroke") continue;
    if (!["type", "color", "opacity", "width", "alignment", "style", "widthTop", "widthRight", "widthBottom", "widthLeft"].includes(field)) {
      throw unsupported(`${path}: ${what} field ${field} is not supported`, { path, field });
    }
  }
  return paint;
}

// One fill layer as bg-[...] text: a color, a gradient, an image, or a
// color Token as var(--name).
function paintLayer(paint, index, count, writer, ctx, path) {
  const binding = writer.bound(`fills.${index}`) ?? (index === 0 ? writer.bound("fill") : undefined);
  if (binding && (paint.type ?? "solid") === "solid") return `var(--${binding})`;
  if (paint.type === "linear-gradient" || paint.type === "radial-gradient") {
    for (const field of Object.keys(paint)) {
      if (!GRADIENT_FIELDS.includes(field)) throw unsupported(`${path}: gradient field ${field} is not supported`, { path, field });
    }
    return formatGradient(paint);
  }
  if (paint.type === "image") {
    for (const field of Object.keys(paint)) {
      if (!["type", "mediaRef", "opacity"].includes(field)) throw unsupported(`${path}: image fill field ${field} is not supported`, { path, field });
    }
    const src = ctx.mediaPath(paint.mediaRef, ctx.currentFile);
    if (!src) throw unsupported(`${path}: the image of a fill is missing`, { path });
    const url = `url(${src.replace(/ /g, "%20")})`;
    return paint.opacity === undefined || paint.opacity === 1 ? url : `${url}_${formatNumber(paint.opacity)}`;
  }
  if ((paint.type ?? "solid") !== "solid") throw unsupported(`${path}: ${paint.type} fills are not supported`, { path });
  for (const field of Object.keys(paint)) {
    if (!["type", "color", "opacity"].includes(field)) throw unsupported(`${path}: fill field ${field} is not supported`, { path, field });
  }
  return colorLiteral(paint);
}

// Fills of a box: bg-<token>, bg-[one layer], or bg-[top,…,bottom].
function fillClasses(writer, node, ctx, path) {
  const fills = Array.isArray(node.fills) ? node.fills : [];
  if (fills.length === 0) return;
  if (fills.length === 1 && (fills[0].type ?? "solid") === "solid") {
    const name = writer.bound("fill") ?? writer.bound("fills.0");
    if (name) return writer.add(`bg-${writer.rest(name)}`);
  }
  writer.add(`bg-[${fills.map((paint, index) => paintLayer(paint, index, fills.length, writer, ctx, path)).join(",")}]`);
}

// Two or more strokes: border-[1px_#e5e7eb,2px_dashed_var(--color-brand)_outside].
function strokeListClass(writer, strokes, path) {
  if (writer.bound("strokeWidth")) throw unsupported(`${path}: a stroke-width Token on more than one stroke has no SmallPen HTML form`, { path });
  const layers = strokes.map((stroke, index) => {
    if ((stroke.type ?? "solid") !== "solid") throw unsupported(`${path}: ${stroke.type} strokes are not supported`, { path });
    for (const field of Object.keys(stroke)) {
      if (!["type", "color", "opacity", "width", "alignment", "style", "hidden"].includes(field)) {
        throw unsupported(`${path}: stroke field ${field} is not supported when an element has more than one stroke`, { path, field });
      }
    }
    const color = writer.bound(`strokes.${index}`) ?? (index === 0 ? writer.bound("stroke") : undefined);
    const words = [formatLength(stroke.width ?? 1)];
    if (stroke.style && stroke.style !== "solid") words.push(stroke.style);
    words.push(color ? `var(--${color})` : colorLiteral(stroke));
    if (stroke.alignment === "center") words.push("center");
    else if (stroke.alignment === "outer") words.push("outside");
    if (stroke.hidden === true) words.push("hidden");
    return words.join("_");
  });
  writer.add(`border-[${layers.join(",")}]`);
}

function sideClasses(writer, prefixes, values, fields, zeroDefault = true) {
  // prefixes: { all, x, y, t, r, b, l }; values: [top, right, bottom, left].
  const describe = (index) => {
    const name = writer.bound(fields[index]);
    if (name) return { key: `t:${name}`, cls: (prefix) => `${prefix}-${writer.rest(name)}` };
    const value = Number(values[index] ?? 0);
    return { key: `v:${value}`, cls: (prefix) => `${prefix}-${px(value)}`, zero: value === 0 };
  };
  const [top, right, bottom, left] = [0, 1, 2, 3].map(describe);
  if (top.key === right.key && top.key === bottom.key && top.key === left.key) {
    if (!(top.zero && zeroDefault)) writer.add(top.cls(prefixes.all));
    return;
  }
  if (top.key === bottom.key && left.key === right.key) {
    if (!(top.zero && zeroDefault)) writer.add(top.cls(prefixes.y));
    if (!(left.zero && zeroDefault)) writer.add(left.cls(prefixes.x));
    return;
  }
  for (const [entry, prefix] of [[top, prefixes.t], [right, prefixes.r], [bottom, prefixes.b], [left, prefixes.l]]) {
    if (!(entry.zero && zeroDefault)) writer.add(entry.cls(prefix));
  }
}

function checkFields(node, path) {
  for (const field of Object.keys(node)) {
    if (IGNORED_FIELDS.has(field) || KNOWN_FIELDS.has(field)) continue;
    throw unsupported(`${path}: field ${field} has no SmallPen HTML form`, { path, field });
  }
  if (node.textStyle) {
    for (const field of Object.keys(node.textStyle)) {
      if (!TEXT_STYLE_FIELDS.has(field)) throw unsupported(`${path}: textStyle.${field} has no SmallPen HTML form`, { path, field });
    }
  }
}

function sizeClass(writer, axis, node, mode, ctx, info) {
  const prefix = axis === "width" ? "w" : "h";
  if (mode === "fill") return writer.add(`${prefix}-full`);
  // A copy's size defaults to its component root's.
  const root = info.copyRoot;
  if (root) {
    const rootMode = root[axis === "width" ? "layout-item-h-sizing" : "layout-item-v-sizing"] === "auto" ? "auto" : "fix";
    if (mode === "auto") {
      if (rootMode !== "auto") writer.add(`${prefix}-fit`);
      return undefined;
    }
    const sameToken = JSON.stringify(root.tokenBindings?.[axis] ?? null) === JSON.stringify(node.tokenBindings?.[axis] ?? null);
    if (rootMode === "fix" && sameToken && Number(root[axis] ?? 0) === Number(node[axis] ?? 0)) return undefined;
  }
  if (mode === "auto") {
    if (info.canHug) {
      if (!info.hugIsDefault) writer.add(`${prefix}-fit`);
      return undefined;
    }
  }
  if (writer.token(prefix, axis)) return undefined;
  const value = Number(node[axis] ?? 0);
  if (info.isPageRoot && value === ctx.platformSize?.[axis]) return undefined;
  writer.add(`${prefix}-${px(value)}`);
  return undefined;
}

export function textStyleClasses(writer, style, ctx, base = {}) {
  let typography;
  const typographyName = writer.bound("typography");
  if (typographyName) {
    writer.add(`type-${writer.rest(typographyName)}`);
    typography = ctx.tokenValue(typographyName) ?? {};
  }
  const same = (field) => {
    if (style[field] === undefined) return true;
    if (typography && typography[field] !== undefined && typography[field] === style[field]) return true;
    return base[field] !== undefined && base[field] === style[field];
  };
  if (!writer.token("font", "fontFamily") && !same("fontFamily")) {
    writer.add(`font-[${String(style.fontFamily).replace(/ /g, "_")}]`);
  }
  if (!writer.token("text", "fontSize") && !same("fontSize")) writer.add(`text-${px(style.fontSize)}`);
  if (!writer.token("font", "fontWeight") && !same("fontWeight")) writer.add(`font-[${Number.parseInt(style.fontWeight, 10)}]`);
  if (!same("lineHeight")) writer.add(`leading-[${formatNumber(Number(style.lineHeight))}]`);
  if (!writer.token("tracking", "letterSpacing") && !same("letterSpacing")) writer.add(`tracking-${px(style.letterSpacing)}`);
  const keywords = {
    textAlign: { left: "text-left", center: "text-center", right: "text-right", justify: "text-justify" },
    fontStyle: { italic: "italic", normal: "not-italic" },
    textTransform: { uppercase: "uppercase", lowercase: "lowercase", capitalize: "capitalize", none: "normal-case" },
    textDecoration: { underline: "underline", "line-through": "line-through", none: "no-underline" },
    verticalAlign: { top: "align-top", center: "align-middle", bottom: "align-bottom" },
    textDirection: { ltr: "text-ltr", rtl: "text-rtl" },
  };
  for (const [field, map] of Object.entries(keywords)) {
    if (style[field] === undefined || base[field] === style[field]) continue;
    const cls = map[style[field]];
    if (!cls) throw unsupported(`text style ${field}=${style[field]} has no class`, { field });
    writer.add(cls);
  }
}

// Visual classes shared by nodes and override parts.
export function visualClasses(writer, node, type, path, options = {}, ctx = writer.ctx) {
  writer.group = type === "TEXT" ? "textColor" : "fill";
  if (type === "TEXT") {
    const paint = solidPaint(node.fills, path, "fill");
    if (!writer.token("text", "fill") && paint) writer.add(`text-[${colorLiteral(paint)}]`);
  } else if (type === "PATH") {
    const paint = solidPaint(node.fills, path, "fill");
    if (!writer.token("fill", "fill") && paint) writer.add(`fill-[${colorLiteral(paint)}]`);
    const stroke = solidPaint(node.strokes, path, "stroke");
    if (stroke) {
      if (!writer.token("stroke", "stroke")) writer.add(`stroke-[${colorLiteral(stroke)}]`);
      if ((stroke.width ?? 1) !== 1) writer.add(`stroke-${px(stroke.width)}`);
      if (stroke.hidden === true) writer.add("stroke-hidden");
    }
  } else {
    fillClasses(writer, node, ctx, path);
    if (options.explicitNone && Array.isArray(node.fills) && node.fills.length === 0) writer.add("bg-none");
  }
  writer.group = "stroke";
  if (type !== "PATH" && Array.isArray(node.strokes) && node.strokes.length > 1) {
    strokeListClass(writer, node.strokes, path);
  } else if (type !== "PATH") {
    const stroke = solidPaint(node.strokes, path, "stroke");
    if (stroke) {
      const sides = [["widthTop", "border-t", "strokeWidthTop"], ["widthRight", "border-r", "strokeWidthRight"], ["widthBottom", "border-b", "strokeWidthBottom"], ["widthLeft", "border-l", "strokeWidthLeft"]]
        .filter(([field]) => stroke[field] !== undefined);
      if (!writer.token("border", "strokeWidth")) {
        const width = stroke.width ?? 1;
        // Sides without border keep the others at 0, so border-0 goes unsaid.
        if (!(width === 0 && sides.length > 0)) writer.add(width === 1 ? "border" : width === 0 ? "border-0" : `border-${px(width)}`);
      }
      for (const [field, prefix, binding] of sides) {
        if (!writer.token(prefix, binding)) writer.add(stroke[field] === 1 ? prefix : stroke[field] === 0 ? `${prefix}-0` : `${prefix}-${px(stroke[field])}`);
      }
      if (!writer.token("border", "stroke")) writer.add(`border-[${colorLiteral(stroke)}]`);
      if (stroke.style && stroke.style !== "solid") writer.add(`border-${stroke.style}`);
      if (stroke.alignment === "center") writer.add("border-center");
      else if (stroke.alignment === "outer") writer.add("border-outside");
      if (stroke.hidden === true) {
        writer.group = "strokeHidden";
        writer.add("border-hidden");
      }
    } else if (options.explicitNone && Array.isArray(node.strokes) && node.strokes.length === 0) {
      writer.add("border-none");
    }
  }
  writer.group = "radius";
  const radius = node.cornerRadius;
  if (Array.isArray(radius)) {
    const fields = ["radiusTopLeft", "radiusTopRight", "radiusBottomRight", "radiusBottomLeft"];
    const prefixes = ["rounded-tl", "rounded-tr", "rounded-br", "rounded-bl"];
    const describe = radius.map((value, index) => writer.bound(fields[index]) ?? `#${value}`);
    if (describe.every((entry) => entry === describe[0])) {
      if (!writer.token("rounded", "radiusTopLeft") && radius[0]) writer.add(radius[0] >= 9999 ? "rounded-full" : `rounded-${px(radius[0])}`);
    } else {
      radius.forEach((value, index) => {
        if (!writer.token(prefixes[index], fields[index]) && value) writer.add(`${prefixes[index]}-${px(value)}`);
      });
    }
  } else if (!writer.token("rounded", "cornerRadius") && radius) {
    writer.add(radius >= 9999 ? "rounded-full" : `rounded-${px(radius)}`);
  } else if (options.explicitNone && radius === 0) {
    writer.add("rounded-none");
  }
  for (const [field, prefix, group] of [["blur", "blur", "blur"], ["backgroundBlur", "backdrop-blur", "backdrop"]]) {
    writer.group = group;
    const effect = node[field];
    if (effect === undefined || effect === null) {
      if (effect === null && options.explicitNone) writer.add(`${prefix}-none`);
      continue;
    }
    if (Array.isArray(effect)) throw unsupported(`${path}: more than one ${field} is not supported`, { path });
    if (Number(effect.value) > 0) writer.add(effect.hidden === true ? `${prefix}-[${formatLength(Number(effect.value))}_hidden]` : `${prefix}-${px(effect.value)}`);
  }
  writer.group = "shadow";
  if (!writer.token("shadow", "shadow") && node.shadow !== undefined) {
    const layers = Array.isArray(node.shadow) ? node.shadow : [node.shadow];
    if (layers.length) writer.add(`shadow-[${formatShadow(node.shadow, "_")}]`);
  }
  writer.group = "opacity";
  if (!writer.token("opacity", "opacity") && node.opacity !== undefined && node.opacity !== 1) {
    writer.add(`opacity-[${formatNumber(node.opacity)}]`);
  }
  writer.group = "visible";
  if (node.visible === false) writer.add("hidden");
  else if (options.explicitNone && node.visible === true) writer.add("shown");
}

function itemClasses(writer, node, { grid = false } = {}) {
  const margin = node["layout-item-margin"];
  if (margin) {
    sideClasses(
      writer,
      { all: "m", x: "mx", y: "my", t: "mt", r: "mr", b: "mb", l: "ml" },
      [margin.m1, margin.m2, margin.m3, margin.m4],
      ["marginTop", "marginRight", "marginBottom", "marginLeft"],
    );
  }
  // In a grid the cell aligns its child; the child's own value does nothing.
  const self = node["layout-item-align-self"];
  if (self && !grid) writer.add(`self-${self}`);
  if (node["layout-item-z-index"]) writer.add(`z-[${node["layout-item-z-index"]}]`);
  for (const [field, prefix, binding] of [
    ["layout-item-min-w", "min-w", "minWidth"],
    ["layout-item-max-w", "max-w", "maxWidth"],
    ["layout-item-min-h", "min-h", "minHeight"],
    ["layout-item-max-h", "max-h", "maxHeight"],
  ]) {
    if (node[field] === undefined || node[field] === null) continue;
    if (!writer.token(prefix, binding)) writer.add(`${prefix}-${px(node[field])}`);
  }
}

const JUSTIFY = {
  start: "justify-start", center: "justify-center", end: "justify-end",
  "space-between": "justify-between", "space-around": "justify-around",
  "space-evenly": "justify-evenly", stretch: "justify-stretch",
};
const DIRECTION = {
  row: "flex-row", column: "flex-col", "row-reverse": "flex-row-reverse", "column-reverse": "flex-col-reverse",
};

const CONTENT = {
  start: "content-start", center: "content-center", end: "content-end",
  "space-between": "content-between", "space-around": "content-around",
  "space-evenly": "content-evenly", stretch: "content-stretch",
};

// grid-cols-3 when every track is 1fr, else the track list.
function trackClass(prefix, tracks) {
  if (tracks.length > 0 && tracks.every((track) => track.type === "flex" && (track.value ?? 1) === 1)) return `${prefix}-${tracks.length}`;
  return `${prefix}-[${formatTracks(tracks)}]`;
}

// The flow direction's tracks are left out when they are the auto tracks
// the children need, as the reader adds them; the other direction is left
// out when it is the single 1fr track the reader assumes.
function gridTrackClasses(writer, node) {
  const dir = node["layout-grid-dir"] ?? "row";
  const columns = node["layout-grid-columns"] ?? [];
  const rows = node["layout-grid-rows"] ?? [];
  const filled = Object.values(node["layout-grid-cells"] ?? {}).filter((cell) => (cell.shapes ?? []).length);
  const needed = (line, span) => Math.max(1, ...filled.map((cell) => cell[line] + (cell[span] ?? 1) - 1));
  const implicit = (tracks, count) => tracks.length === count && tracks.every((track) => track.type === "auto");
  const single = (tracks) => tracks.length === 1 && tracks[0].type === "flex" && (tracks[0].value ?? 1) === 1;
  const [flow, across, flowPrefix, acrossPrefix, flowCount] = dir === "row"
    ? [rows, columns, "grid-rows", "grid-cols", needed("row", "row-span")]
    : [columns, rows, "grid-cols", "grid-rows", needed("column", "column-span")];
  if (!single(across)) writer.add(trackClass(acrossPrefix, across));
  if (!implicit(flow, flowCount)) writer.add(trackClass(flowPrefix, flow));
}

// Classes for one node. info: { parentFlex, parentGrid, cell, explicitLines,
// isRoot, isPageRoot }.
export function nodeClasses(node, ctx, path, info) {
  checkFields(node, path);
  const writer = createClassWriter(node, ctx, path);
  const type = node.type === "COMPONENT" ? "FRAME" : node.type;
  const isFlex = node.layout === "flex";
  const isGrid = node.layout === "grid";
  if (node.layout && !isFlex && !isGrid) throw unsupported(`${path}: ${node.layout} layout has no SmallPen HTML form`, { path });
  writer.group = "layout";
  if (isGrid) {
    writer.add("grid");
    if (node["layout-grid-dir"] === "column") writer.add("grid-flow-col");
    gridTrackClasses(writer, node);
    if (node["layout-align-items"] && node["layout-align-items"] !== "start") writer.add(`items-${node["layout-align-items"]}`);
    if (node["layout-justify-items"] && node["layout-justify-items"] !== "start") writer.add(`justify-items-${node["layout-justify-items"]}`);
    if (node["layout-justify-content"] && node["layout-justify-content"] !== "stretch") writer.add(JUSTIFY[node["layout-justify-content"]]);
    if (node["layout-align-content"] && node["layout-align-content"] !== "stretch") writer.add(CONTENT[node["layout-align-content"]]);
  }
  if (isFlex) {
    writer.add("flex");
    writer.add(DIRECTION[node["layout-flex-dir"] ?? "row"]);
    if (node["layout-wrap-type"] === "wrap") writer.add("flex-wrap");
    if (node["layout-align-items"]) writer.add(`items-${node["layout-align-items"]}`);
    if (node["layout-justify-content"]) writer.add(JUSTIFY[node["layout-justify-content"]]);
    if (node["layout-align-content"] && node["layout-align-content"] !== "stretch") writer.add(CONTENT[node["layout-align-content"]]);
  }
  if (isFlex || isGrid) {
    writer.group = "gap";
    const gap = node["layout-gap"];
    if (gap) {
      const row = writer.bound("rowGap") ?? `#${gap["row-gap"] ?? 0}`;
      const column = writer.bound("columnGap") ?? `#${gap["column-gap"] ?? 0}`;
      if (row === column) {
        if (!writer.token("gap", "rowGap") && gap["row-gap"]) writer.add(`gap-${px(gap["row-gap"])}`);
      } else {
        if (!writer.token("gap-x", "columnGap") && gap["column-gap"]) writer.add(`gap-x-${px(gap["column-gap"])}`);
        if (!writer.token("gap-y", "rowGap") && gap["row-gap"]) writer.add(`gap-y-${px(gap["row-gap"])}`);
      }
    }
    writer.group = "padding";
    const padding = node["layout-padding"];
    if (padding) {
      sideClasses(
        writer,
        { all: "p", x: "px", y: "py", t: "pt", r: "pr", b: "pb", l: "pl" },
        [padding.p1, padding.p2, padding.p3, padding.p4],
        ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"],
      );
    }
  }

  const inLayout = info.parentFlex || info.parentGrid;
  const absoluteItem = inLayout && node["layout-item-absolute"] === true;
  writer.group = "absolute";
  if (absoluteItem) writer.add("absolute");
  writer.group = "position";
  if (!info.isRoot && (!inLayout || absoluteItem)) {
    if (node.x) writer.add(`left-${px(node.x)}`);
    if (node.y) writer.add(`top-${px(node.y)}`);
  }

  writer.group = "size";
  const hMode = node["layout-item-h-sizing"] ?? "fix";
  const vMode = node["layout-item-v-sizing"] ?? "fix";
  if (type === "TEXT") {
    const grow = node.growType ?? "fixed";
    if (hMode === "fill") writer.add("w-full");
    else if (grow !== "auto-width") {
      if (!writer.token("w", "width")) writer.add(`w-${px(node.width)}`);
    }
    if (vMode === "fill") writer.add("h-full");
    else if (grow === "fixed" && hMode !== "fill") {
      if (!writer.token("h", "height")) writer.add(`h-${px(node.height)}`);
    } else if (grow === "fixed" && hMode === "fill") {
      if (!writer.token("h", "height")) writer.add(`h-${px(node.height)}`);
    }
  } else {
    const canHug = isFlex || isGrid || type === "INSTANCE";
    const sizing = { canHug, hugIsDefault: canHug, isPageRoot: info.isPageRoot, copyRoot: type === "INSTANCE" ? ctx.instanceRoot?.(node) : undefined };
    // A mask group is as big as its mask, which the reader takes it from.
    const maskSize = type === "GROUP" && node["masked-group"] === true;
    if (!(maskSize && hMode === "fix")) sizeClass(writer, "width", node, hMode === "fill" && !inLayout ? "fix" : hMode, ctx, sizing);
    if (!(maskSize && vMode === "fix")) sizeClass(writer, "height", node, vMode === "fill" && !inLayout ? "fix" : vMode, ctx, sizing);
  }
  writer.group = "item";
  if (inLayout) itemClasses(writer, node, { grid: info.parentGrid });
  writer.group = "cell";
  if (info.parentGrid && info.cell && !absoluteItem) {
    const cell = info.cell;
    if (info.explicitLines) {
      writer.add(`col-start-${cell.column}`);
      writer.add(`row-start-${cell.row}`);
    }
    if ((cell["column-span"] ?? 1) > 1) writer.add(`col-span-${cell["column-span"]}`);
    if ((cell["row-span"] ?? 1) > 1) writer.add(`row-span-${cell["row-span"]}`);
    if (cell["align-self"] && cell["align-self"] !== "auto") writer.add(`self-${cell["align-self"]}`);
    if (cell["justify-self"] && cell["justify-self"] !== "auto") writer.add(`justify-self-${cell["justify-self"]}`);
  }

  visualClasses(writer, node, type, path);
  writer.group = "rotation";
  if (node.rotation) writer.add(`rotate-[${formatNumber(node.rotation)}deg]`);
  if (node.flipX) writer.add("flip-x");
  if (node.flipY) writer.add("flip-y");
  writer.group = "blend";
  if (node["blend-mode"] && node["blend-mode"] !== "normal") writer.add(`mix-blend-${node["blend-mode"]}`);
  writer.group = "overflow";
  if (node["show-content"] === true) writer.add("overflow-visible");
  writer.group = "viewer";
  if (node["hide-in-viewer"] === true) writer.add("viewer-hidden");
  writer.group = "pins";
  const pinX = { left: "pin-x-left", right: "pin-x-right", leftright: "pin-x-stretch", center: "pin-x-center", scale: "pin-x-scale" };
  const pinY = { top: "pin-y-top", bottom: "pin-y-bottom", topbottom: "pin-y-stretch", center: "pin-y-center", scale: "pin-y-scale" };
  if (node["constraints-h"]) writer.add(pinX[node["constraints-h"]]);
  if (node["constraints-v"]) writer.add(pinY[node["constraints-v"]]);
  writer.group = "text";
  if (type === "TEXT" && node.textStyle) textStyleClasses(writer, node.textStyle, ctx);
  return writer;
}

export function textContent(text) {
  return String(text)
    .split("\n")
    .map((line) => escapeText(line))
    .join("<br>");
}

function defaultTextName(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 40) || "Text";
}

// Encodes one tree. Returns an array of lines (without trailing newline).
export function encodeTree(nodes, rootId, ctx, options) {
  const lines = [];
  const visit = (id, depth, parent, path, parentCell) => {
    const node = nodes[id];
    if (!node) throw unsupported(`${path}: missing node ${id}`, { path });
    const isRoot = parent === undefined;
    const info = {
      parentFlex: parent?.layout === "flex",
      parentGrid: parent?.layout === "grid",
      cell: parentCell?.cell,
      explicitLines: parentCell?.explicit,
      isRoot,
      isPageRoot: isRoot && options.kind === "page",
    };
    const writer = nodeClasses(node, ctx, `${path}`, info);
    const indent = "  ".repeat(depth + (options.baseDepth ?? 0));
    const attrs = [];
    const type = node.type;
    let tag;
    switch (type) {
      case "FRAME": case "COMPONENT": tag = isRoot && options.kind === "page" ? "body" : "div"; break;
      case "RECTANGLE": tag = "div"; attrs.push('data-shape="rectangle"'); break;
      case "ELLIPSE": tag = "div"; attrs.push('data-shape="ellipse"'); break;
      case "GROUP": tag = "div"; attrs.push(node["masked-group"] === true ? 'data-shape="mask"' : 'data-shape="group"'); break;
      case "TEXT": tag = "p"; break;
      case "IMAGE": tag = "img"; break;
      case "PATH": tag = "svg"; break;
      case "INSTANCE": tag = "sp-use"; break;
      default: throw unsupported(`${path}: node type ${type} has no SmallPen HTML form`, { path });
    }
    if (node["masked-group"] === true && type !== "GROUP") throw unsupported(`${path}: only a group can be a mask`, { path });
    if (type === "INSTANCE") {
      const component = ctx.componentById(node.instance?.component?.assetId, node.instance?.component?.packageId);
      if (!component) throw unsupported(`${path}: copy of a component outside this package`, { path });
      attrs.unshift(`component="${escapeAttribute(component.name)}"`);
      const props = component.axes
        .filter((axis) => node.instance.variant?.[axis.id] !== undefined && node.instance.variant[axis.id] !== axis.domain[0])
        .map((axis) => `${axis.name}: ${node.instance.variant[axis.id]}`);
      if (props.length) attrs.push(`props="${escapeAttribute(props.join("; "))}"`);
    }
    // Names: written unless the reader would derive the same name.
    let defaultName;
    if (isRoot) defaultName = options.rootName;
    else if (type === "TEXT") defaultName = defaultTextName(node.text);
    else if (type === "INSTANCE") defaultName = ctx.componentById(node.instance?.component?.assetId)?.name;
    if (node.name !== defaultName) {
      if (!(isRoot && options.kind === "component")) attrs.push(`data-name="${escapeAttribute(node.name)}"`);
    }
    if (type === "IMAGE") {
      const src = ctx.mediaPath(node.mediaRef, options.file);
      if (!src) throw unsupported(`${path}: image media is missing`, { path });
      attrs.push(`src="${escapeAttribute(src)}"`, 'alt=""');
    }
    if (type === "PATH" && node.points && !node.pathData) throw unsupported(`${path}: point paths are not supported; use pathData`, { path });
    const textBinding = node.tokenBindings?.text && ctx.tokenName(node.tokenBindings.text);
    if (textBinding) attrs.push(`data-text="${escapeAttribute(writer.rest(textBinding))}"`);
    const visibleBinding = node.tokenBindings?.visible && ctx.tokenName(node.tokenBindings.visible);
    if (visibleBinding) attrs.push(`data-visible="${escapeAttribute(writer.rest(visibleBinding))}"`);
    attrs.push(...interactionAttributes(node.interactions, ctx, path, type, node.id));
    if (isRoot && options.rootAttributes) attrs.push(...options.rootAttributes);
    if (writer.classes.length) attrs.push(`class="${writer.classes.join(" ")}"`);
    const open = `${indent}<${tag}${attrs.length ? ` ${attrs.join(" ")}` : ""}>`;

    if (type === "TEXT") {
      const content = textBinding ? "" : encodeTextContent(node, ctx);
      lines.push(`${open}${content}</p>`);
      return;
    }
    if (type === "IMAGE") {
      lines.push(open);
      return;
    }
    if (type === "PATH") {
      lines.push(open);
      lines.push(`${indent}  <path d="${escapeAttribute(node.pathData ?? "")}"></path>`);
      lines.push(`${indent}</svg>`);
      return;
    }
    if (type === "INSTANCE") {
      const overrideLines = ctx.instanceOverrides(node, depth + 1 + (options.baseDepth ?? 0), path);
      if (overrideLines.length === 0) {
        lines.push(`${open}</sp-use>`);
      } else {
        lines.push(open, ...overrideLines, `${indent}</sp-use>`);
      }
      return;
    }
    const children = node.children ?? [];
    if (children.length === 0) {
      lines.push(`${open}</${tag}>`);
      return;
    }
    lines.push(open);
    const reverse = (node.layout === "flex" && !String(node["layout-flex-dir"] ?? "row").endsWith("-reverse")) || node.layout === "grid";
    const ordered = reverse ? [...children].reverse() : children;
    let cellOf = () => undefined;
    if (node.layout === "grid") {
      const byChild = cellsByChild(node["layout-grid-cells"]);
      const placed = ordered.filter((child) => byChild.has(child) && nodes[child]?.["layout-item-absolute"] !== true);
      const explicit = explicitLines(placed, byChild, (node["layout-grid-columns"] ?? []).length, (node["layout-grid-rows"] ?? []).length, node["layout-grid-dir"] ?? "row");
      cellOf = (child) => (byChild.has(child) ? { cell: byChild.get(child), explicit: explicit.has(child) } : undefined);
    }
    for (const child of ordered) visit(child, depth + 1, node, `${path} / ${nodes[child]?.name ?? child}`, cellOf(child));
    lines.push(`${indent}</${tag}>`);
  };
  visit(rootId, 0, undefined, options.label);
  return lines;
}

// data-click, data-hover, ... for an element's interactions, one per
// trigger, in a fixed order.
export function interactionAttributes(interactions, ctx, path, type, sourceNodeId) {
  if (!interactions?.length) return [];
  const byAttribute = new Map();
  for (const interaction of interactions) {
    const { attribute, value } = formatInteraction(interaction, ctx.interactionLookups(path, sourceNodeId), path);
    if (byAttribute.has(attribute)) throw unsupported(`${path}: two ${attribute} interactions on one element; give each trigger one action`, { path });
    if (attribute === "data-after-delay" && !["FRAME", "COMPONENT", "INSTANCE"].includes(type)) {
      throw unsupported(`${path}: an after-delay interaction needs a board`, { path });
    }
    byAttribute.set(attribute, value);
  }
  return ATTRIBUTE_ORDER.filter((attribute) => byAttribute.has(attribute))
    .map((attribute) => `${attribute}="${escapeAttribute(byAttribute.get(attribute))}"`);
}

const ATTRIBUTE_ORDER = ["data-click", "data-press", "data-hover", "data-mouse-enter", "data-mouse-leave", "data-after-delay"];

function encodeTextContent(node, ctx) {
  const blocks = node.textBlocks;
  if (!blocks?.length) return textContent(node.text ?? "");
  const base = node.textStyle ?? {};
  return blocks
    .map((block) =>
      block.runs
        .map((run) => {
          const style = { ...(block.textStyle ?? {}), ...(run.textStyle ?? {}) };
          const writer = createClassWriter({}, ctx, "text run");
          textStyleClasses(writer, style, ctx, base);
          const paint = run.fills?.[0];
          if (paint) writer.add(`text-[${colorLiteral(paint)}]`);
          const text = escapeText(run.text ?? "");
          return writer.classes.length ? `<span class="${writer.classes.join(" ")}">${text}</span>` : text;
        })
        .join(""),
    )
    .join("<br>");
}
