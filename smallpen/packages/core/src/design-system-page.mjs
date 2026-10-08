// The generated Design System page as one node tree: every Token Cell and
// representative component samples, laid out once here and drawn by both
// the CLI renderer and the Penpot projection.
//
// The tree uses canonical node fields (x/y relative to the parent) and is
// never written to a Package. Each node carries `designSystem`:
//   { role: "decoration" }                    background, label, ruler
//   { role: "caption" }                       a Token or sample caption
//   { role: "token-cell", specimen: KEY }     refs.specimens[KEY]
//   { role: "component-sample", sample: I }   refs.componentSamples[I]
//   { role: "located-family", family: I }     refs.families[I]
// Sample and located placeholders are empty frames of the right size; the
// renderer inserts the sample tree (expandDesignSystemPage) and the Penpot
// projection draws the component in their place. runtimeIds gives each
// node its Penpot shape id.
import { SMALLPEN_FORMAT_CAPABILITIES } from "./capabilities.mjs";
import { projectScreen } from "./design-projection.mjs";
import {
  DESIGN_SYSTEM_LABELS,
  designSystemLabelLocale,
} from "./design-system-labels.mjs";

export const DESIGN_SYSTEM_PAGE_VERSION = 1;

const FONT = "Source Sans Pro";
const INK = "#111827";
const PAGE_FILL = "#f8fafc";
const BRAND = "#4f46e5";
const CARD_STROKE = "#e5e7eb";
const CARD_FILL = "#ffffff";
const PAD = 40;
const CARD_GAP = 32;
const CARD_PAD = 24;
const COLOR_CELL = 84;
const SWATCH_W = 72;
const SWATCH_H = 40;
const VISUAL_WIDTH = 200;
const COMPONENT_INNER_MIN = 560;

const TOKEN_TYPES = [
  "color", "border-radius", "spacing", "sizing", "dimensions", "typography",
  "font-family", "font-size", "font-weight", "letter-spacing", "text-case",
  "text-decoration", "stroke-width", "shadow", "opacity", "rotation",
  "number", "boolean", "string", "other",
];

const AXIS_LABEL_KEYS = {
  Style: "axis.style", Content: "axis.content", State: "axis.state",
  Theme: "axis.theme", Tone: "axis.tone", Level: "axis.level",
  Kind: "axis.kind", primary: "axis.primary", secondary: "axis.secondary",
  ghost: "axis.ghost", text: "axis.text", leading: "axis.leading",
  trailing: "axis.trailing", icon: "axis.icon", default: "axis.default",
  idle: "axis.default", hover: "axis.hover", pressed: "axis.pressed",
  disabled: "axis.disabled", Light: "axis.light", light: "axis.light",
  Dark: "axis.dark", dark: "axis.dark", neutral: "axis.neutral",
  success: "axis.success", danger: "axis.danger", focus: "axis.focus",
  error: "axis.error", page: "axis.page", section: "axis.section",
  dialog: "axis.dialog", confirm: "axis.confirm", form: "axis.form",
};

const PREVIEW_FIELDS = new Set(
  SMALLPEN_FORMAT_CAPABILITIES.webProjection.nodeFields.filter(
    (field) =>
      ![
        "id", "name", "text", "children", "tokenBindings", "appliedTokens",
        "instance", "componentId", "componentVariantId", "sourceNodeId",
        "content", "touched", "locked", "interactions", "exports", "grids",
        "hide-fill-on-export", "hide-in-viewer", "fixed-scroll",
      ].includes(field),
  ),
);

// --- small helpers ---------------------------------------------------------

function compare(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === b) continue;
    if (a === undefined || a === null) return -1;
    if (b === undefined || b === null) return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function fnv(input, seed) {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// Deterministic uuid-shaped id for a decoration: the same page yields the
// same ids, so re-projections do not churn shapes.
function pageUuid(key) {
  const hex = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b]
    .map((seed) => fnv(key, seed))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function format(template, ...args) {
  let index = 0;
  return String(template).replace(/%s/g, () => String(args[index++] ?? ""));
}

// Text width model shared by every label: 0.62 em per Latin character and
// one em per CJK character, 1.4 lines. Labels get boxes at least this big.
export function designSystemTextMetrics(text, size) {
  const lines = String(text).split("\n");
  const em = Math.max(
    0,
    ...lines.map((line) =>
      [...line].reduce(
        (sum, character) => sum + (character.charCodeAt(0) > 255 ? 1 : 0.62),
        0,
      ),
    ),
  );
  return {
    height: Math.max(18, 1.4 * size * Math.max(1, lines.length)),
    width: Math.max(80, size * em),
  };
}

function lineWidth(line, size) {
  return size * [...line].reduce(
    (sum, character) => sum + (character.charCodeAt(0) > 255 ? 1 : 0.62),
    0,
  );
}

// Wrap inside `width`, breaking after a dot, dash, slash or space when one
// is in the line, so token names break between their segments.
function wrapText(text, size, width) {
  const lines = [];
  for (const paragraph of String(text).split("\n")) {
    let line = "";
    for (const character of [...paragraph]) {
      const next = line + character;
      if (line && lineWidth(next, size) > width) {
        const cut = Math.max(
          line.lastIndexOf("."),
          line.lastIndexOf("-"),
          line.lastIndexOf("/"),
          line.lastIndexOf(" "),
        );
        if (cut > 0 && cut < line.length - 1) {
          lines.push(line.slice(0, cut + 1));
          line = line.slice(cut + 1) + character;
        } else {
          lines.push(line);
          line = character;
        }
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function hexColor(value) {
  if (typeof value === "string" && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value)) {
    return value.toLowerCase();
  }
  if (
    value &&
    typeof value === "object" &&
    String(value.colorSpace ?? "").toLowerCase() === "srgb" &&
    Array.isArray(value.components) &&
    value.components.length === 3
  ) {
    const byte = (channel) =>
      Math.round(Math.min(255, Math.max(0, channel * 255)))
        .toString(16)
        .padStart(2, "0");
    const alpha = value.alpha ?? 1;
    return `#${value.components.map(byte).join("")}${
      alpha < 1 ? byte(alpha) : ""
    }`;
  }
  return null;
}

// Canonical fills hold #rrggbb plus an opacity, never an 8-digit color.
function solidFill(hex) {
  return hex.length === 9
    ? { color: hex.slice(0, 7), opacity: colorAlpha(hex), type: "solid" }
    : { color: hex, type: "solid" };
}

function colorAlpha(hex) {
  return hex && hex.length === 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1;
}

function isWhite(value) {
  return hexColor(value)?.slice(0, 7) === "#ffffff";
}

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, Number(value)));
}

function displayValue(ref) {
  return ref.alias && !ref.unresolvedAlias && !ref.aliasCycle
    ? ref.resolved
    : ref.raw;
}

function humanValue(type, value) {
  if (value === undefined || value === null) return "—";
  if (type === "shadow" && typeof value === "object") {
    return (Array.isArray(value) ? value : [value])
      .map((shadow) => `${shadow.inset ? "inset " : ""}${shadow.offsetX ?? 0} ${shadow.offsetY ?? 0} · blur ${shadow.blur ?? 0} · spread ${shadow.spread ?? 0}`)
      .join(" / ");
  }
  if (typeof value === "object" && !Array.isArray(value) && type === "typography") {
    return `${value.fontFamily ?? "?"} · ${value.fontSize ?? "?"}/${value.lineHeight ?? "?"} · ${value.fontWeight ?? "?"}`;
  }
  if (typeof value === "object") return JSON.stringify(value);
  if (type === "opacity") return `${Math.round(100 * Number(value))}%`;
  if (type === "rotation") return `${value}°`;
  if (type === "color") return String(hexColor(value) ?? value).toUpperCase();
  return String(value);
}

// --- the builder ------------------------------------------------------------

class PageBuilder {
  constructor(options) {
    this.labels = DESIGN_SYSTEM_LABELS[designSystemLabelLocale(options.locale)];
    this.nodes = {};
    this.runtimeIds = {};
    this.seed = options.seed ?? "design-system";
    this.count = 0;
  }

  label(key, ...args) {
    return format(this.labels[key] ?? key, ...args);
  }

  axisLabel(value) {
    const key = AXIS_LABEL_KEYS[value];
    return key ? this.label(key) : String(value);
  }

  add(node, { role = "decoration", runtimeId, ...meta } = {}) {
    this.count += 1;
    const id = node.id ?? `node_ds_${this.count}`;
    this.nodes[id] = {
      children: [],
      ...node,
      id,
      designSystem: { role, ...meta },
    };
    this.runtimeIds[id] = runtimeId ?? pageUuid(`${this.seed}\0${id}`);
    return id;
  }

  rect(x, y, width, height, fill, extra = {}, meta) {
    return this.add(
      {
        fills: fill ? [solidFill(fill)] : [],
        height,
        name: extra.name ?? "Board decoration",
        type: "RECTANGLE",
        width,
        x,
        y,
        ...extra,
      },
      meta,
    );
  }

  text(x, y, value, style = {}, meta, extra = {}) {
    const size = style.fontSize ?? 14;
    const metrics = designSystemTextMetrics(value, size);
    return this.add(
      {
        fills: [{ color: style.color ?? INK, type: "solid" }],
        growType: "fixed",
        height: extra.height ?? metrics.height,
        name: extra.name ?? value,
        opacity: style.opacity ?? 1,
        text: String(value),
        textStyle: {
          fontFamily: FONT,
          fontSize: size,
          fontWeight: style.fontWeight ?? 400,
          lineHeight: 1.4,
          textAlign: style.textAlign ?? "left",
          ...(style.textStyle ?? {}),
        },
        type: "TEXT",
        width: extra.width ?? metrics.width,
        x,
        y,
      },
      meta,
    );
  }
}

// Every Token Cell once: a Cell observed in several combinations shows the
// same value in each. Cells sharing a path (one per theme) sit together.
export function allTokenSpecimens(specimens, combinations) {
  const comboIndex = new Map((combinations ?? []).map((combo, index) => [combo.id, index]));
  const comboLabel = new Map((combinations ?? []).map((combo) => [combo.id, combo.label]));
  const entries = Object.entries(specimens ?? {}).map(([key, ref]) => ({ ...ref, key }));
  entries.sort((left, right) =>
    compare(
      [left.order ?? 0, left.tokenId, comboIndex.get(left.combinationId) ?? 0],
      [right.order ?? 0, right.tokenId, comboIndex.get(right.combinationId) ?? 0],
    ),
  );
  const seen = new Set();
  const cells = [];
  for (const ref of entries) {
    const key = `${ref.ownerPackageId}\0${ref.setId}\0${ref.tokenId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cells.push(ref);
  }
  // A Token with the same value in every theme shows once.
  const valuesByPath = new Map();
  for (const ref of cells) {
    if (!valuesByPath.has(ref.path)) valuesByPath.set(ref.path, new Set());
    valuesByPath.get(ref.path).add(stableStringify(ref.resolved ?? ref.value));
  }
  const shown = new Set();
  cells.splice(0, cells.length, ...cells.filter((ref) => {
    if (valuesByPath.get(ref.path).size > 1) return true;
    if (shown.has(ref.path)) return false;
    shown.add(ref.path);
    return true;
  }));
  // A string shows in the font its theme option uses (a Chinese value needs
  // the font that holds Chinese): the font-family Token of that option.
  const fontOf = new Map();
  for (const ref of entries)
    if (["font-family", "fontFamilies"].includes(ref.type))
      for (const id of [ref.combinationId, ...(ref.combinationIds ?? [])].filter(Boolean))
        if (!fontOf.has(id)) {
          const value = ref.resolved ?? ref.value;
          const family = Array.isArray(value) ? value[0] : value;
          if (typeof family === "string" && family) fontOf.set(id, family);
        }
  for (const [index, ref] of cells.entries())
    if (ref.type === "string") {
      const family = [ref.combinationId, ...(ref.combinationIds ?? [])].map((id) => fontOf.get(id)).find(Boolean);
      if (family) cells[index] = { ...ref, fontFamily: family };
    }
  const pathOrder = new Map();
  for (const ref of cells) if (!pathOrder.has(ref.path)) pathOrder.set(ref.path, pathOrder.size);
  const pathCount = new Map();
  for (const ref of cells) pathCount.set(ref.path, (pathCount.get(ref.path) ?? 0) + 1);
  return cells
    .map((ref) => {
      if (pathCount.get(ref.path) < 2) return ref;
      const ids = ref.combinationIds ?? [];
      const themeLabel =
        ids.length === 1 ? comboLabel.get(ids[0]) ?? ref.setName : ref.setName;
      return { ...ref, themeLabel };
    })
    .sort((left, right) =>
      compare(
        [pathOrder.get(left.path), comboIndex.get((left.combinationIds ?? [])[0]) ?? 0],
        [pathOrder.get(right.path), comboIndex.get((right.combinationIds ?? [])[0]) ?? 0],
      ),
    );
}

export function colorFamily(path) {
  const parts = String(path).split(/[./]/);
  return parts.slice(0, Math.min(2, parts.length - 1)).join(".");
}

function colorShortName(path, family) {
  if (!family) return String(path);
  const rest = String(path).slice(Math.min(String(path).length, family.length + 1));
  return rest || String(path);
}

// Masonry of equal-width cards in `columns` columns: each card goes into
// the shortest column.
function cardColumns(cards, x, y, columns) {
  const width = Math.max(0, ...cards.map((card) => card.width));
  const bottoms = Array.from({ length: Math.max(1, columns) }, () => y);
  const positions = [];
  let maxX = x;
  let endY = y;
  for (const card of cards) {
    const column = bottoms.indexOf(Math.min(...bottoms));
    const px = x + column * (width + CARD_GAP);
    const py = bottoms[column];
    positions.push([px, py]);
    bottoms[column] = py + card.height + CARD_GAP;
    maxX = Math.max(maxX, px + card.width);
    endY = Math.max(endY, py + card.height);
  }
  return { endY, maxX, positions };
}

// Masonry where a card may span several equal columns: it goes where the
// columns it covers end highest.
function spanColumns(cards, x, y, columns, columnWidth) {
  const bottoms = Array.from({ length: Math.max(1, columns) }, () => y);
  const positions = [];
  let maxX = x;
  let endY = y;
  for (const card of cards) {
    const span = Math.min(card.span ?? 1, bottoms.length);
    let best = 0;
    let bestTop = Infinity;
    for (let column = 0; column + span <= bottoms.length; column += 1) {
      const top = Math.max(...bottoms.slice(column, column + span));
      if (top < bestTop) {
        best = column;
        bestTop = top;
      }
    }
    const px = x + best * (columnWidth + CARD_GAP);
    positions.push([px, bestTop]);
    for (let column = best; column < best + span; column += 1) {
      bottoms[column] = bestTop + card.height + CARD_GAP;
    }
    maxX = Math.max(maxX, px + card.width);
    endY = Math.max(endY, bestTop + card.height);
  }
  return { endY, maxX, positions };
}

// Both zones grow downwards: about sqrt(area) columns, aiming at a block
// 1.5 times taller than wide, so columns are added slowly as cards (and
// their variants) pile up.
export function designSystemColumns(cards, low, high) {
  if (cards.length === 0) return 1;
  const width = Math.max(1, ...cards.map((card) => card.width));
  const area = cards.reduce((sum, card) => sum + width * card.height, 0);
  const columns = Math.ceil(Math.sqrt(area / (1.5 * width * width)));
  return Math.min(Math.max(columns, low), high, cards.length);
}

// Greedy wrapped rows of measured items.
function flow(items, width, rowGap, columnGap) {
  const positions = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let maxX = 0;
  for (const item of items) {
    if (x > 0 && x + item.width > width) {
      x = 0;
      y += rowHeight + rowGap;
      rowHeight = 0;
    }
    positions.push([x, y]);
    x += item.width + columnGap;
    rowHeight = Math.max(rowHeight, item.height);
    maxX = Math.max(maxX, x - columnGap);
  }
  return { endY: y + rowHeight, maxX, positions };
}

// --- Token specimens --------------------------------------------------------

function specimenName(ref, comboLabel) {
  return `Token / ${ref.setName}/${ref.path}${comboLabel ? ` · ${comboLabel}` : ""}`;
}

function checker(builder, x, y, width, height) {
  const cell = 16;
  const children = [];
  const frame = builder.add({
    fills: [],
    height,
    name: "Board decoration",
    type: "FRAME",
    width,
    x,
    y,
  });
  for (let row = 0; row < Math.ceil(height / cell); row += 1) {
    for (let col = 0; col < Math.ceil(width / cell); col += 1) {
      children.push(
        builder.rect(
          col * cell,
          row * cell,
          Math.min(cell, width - col * cell),
          Math.min(cell, height - row * cell),
          (row + col) % 2 === 0 ? "#e2e8f0" : "#ffffff",
        ),
      );
    }
  }
  builder.nodes[frame].children = children;
  return frame;
}

function ruler(builder, x, y, length, vertical) {
  const tick = 8;
  const mk = (rx, ry, w, h) => builder.rect(rx, ry, w, h, "#94a3b8");
  return vertical
    ? [mk(x, y, 1, length), mk(x - 4.5, y, tick, 1), mk(x - 4.5, y + length - 1, tick, 1)]
    : [mk(x, y, length, 1), mk(x, y - 4.5, 1, tick), mk(x + length - 1, y - 4.5, 1, tick)];
}

function tokenMeta(ref) {
  return { role: "token-cell", runtimeId: ref.shape, specimen: ref.key };
}

function specimenText(builder, ref, comboLabel, x, y, width, text, style) {
  const size = style.fontSize ?? 14;
  const lines = Math.max(1, String(text).split("\n").length);
  return builder.add(
    {
      fills: [{ color: INK, type: "solid" }],
      growType: "fixed",
      height: Math.max(24, 1.45 * size * lines),
      name: specimenName(ref, comboLabel),
      text: String(text),
      textStyle: {
        fontFamily: FONT,
        fontSize: 14,
        fontWeight: 400,
        letterSpacing: 0,
        lineHeight: 1.45,
        textDecoration: "none",
        textTransform: "none",
        ...style,
      },
      type: "TEXT",
      width,
      x,
      y,
    },
    tokenMeta(ref),
  );
}

function typographyStyle(value) {
  const style = {};
  for (const field of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "textDecoration", "textTransform"]) {
    if (value?.[field] !== undefined) style[field] = value[field];
  }
  if (value?.textCase && !style.textTransform) {
    style.textTransform = value.textCase === "title-case" ? "capitalize" : value.textCase;
  }
  if (style.fontWeight !== undefined) style.fontWeight = Number(style.fontWeight);
  if (style.fontSize !== undefined) style.fontSize = Number(style.fontSize);
  return style;
}

// The visual of one specimen at (x, y): returns its height and a draw
// function, so a row can align every specimen on a shared bottom edge.
function specimenVisual(builder, ref, comboLabel) {
  const display = displayValue(ref);
  const kind = ref.attribute ?? ref.type;
  const name = specimenName(ref, comboLabel);
  const card = (height, draw, width = VISUAL_WIDTH) => ({ draw, height, width });
  switch (kind) {
    case "fill": {
      const hex = hexColor(display);
      const transparent = hex !== null && colorAlpha(hex) === 0;
      const seeThrough = hex !== null && colorAlpha(hex) < 1;
      return card(SWATCH_H, (x, y) => {
        const ids = seeThrough ? [checker(builder, x, y, SWATCH_W, SWATCH_H)] : [];
        ids.push(
          builder.rect(x, y, SWATCH_W, SWATCH_H, hex, {
            cornerRadius: 8,
            name,
            strokes: [{
              alignment: "inner",
              color: transparent ? "#64748b" : "#e2e8f0",
              style: transparent ? "dashed" : "solid",
              type: "solid",
              width: 1,
            }],
          }, tokenMeta(ref)),
        );
        return ids;
      }, SWATCH_W);
    }
    case "radius":
      return card(48, (x, y) => [
        builder.rect(x, y, 48, 48, "#eef2ff", {
          cornerRadius: Math.max(0, Number(display) || 0),
          name,
          strokes: [{ alignment: "inner", color: BRAND, type: "solid", width: 1.5 }],
        }, tokenMeta(ref)),
      ], 48);
    case "height": {
      const height = clamp(display, 8, 160);
      return card(height + 12, (x, y) => [
        builder.rect(x + 16, y, 96, height, "#eef2ff", { name }, tokenMeta(ref)),
        ...ruler(builder, x, y, height, true),
      ]);
    }
    case "stroke-width":
      return card(28, (x, y) => [
        builder.rect(x, y, 120, 28, "#ffffff", {
          cornerRadius: 6,
          name,
          strokes: [{ alignment: "inner", color: INK, type: "solid", width: Number(display) }],
        }, tokenMeta(ref)),
      ]);
    case "shadow":
      return card(72, (x, y) => [
        builder.rect(x, y + 4, 80, 64, "#ffffff", {
          cornerRadius: 10,
          name,
          shadow: display,
        }, tokenMeta(ref)),
      ], 80);
    case "opacity":
      return card(48, (x, y) => [
        checker(builder, x, y, 96, 48),
        builder.rect(x, y, 96, 48, "#6750a4", {
          name,
          opacity: clamp(display, 0, 1),
        }, tokenMeta(ref)),
      ]);
    case "rotation": {
      const angle = ((Number(display) % 360) + 360) % 360;
      return card(88, (x, y) => [
        builder.rect(x, y + 26, 88, 36, "#eef2ff", { name, rotation: angle }, tokenMeta(ref)),
        builder.rect(x - 7, y + 40, 8, 8, "#6750a4"),
      ]);
    }
    case "dimensions": {
      const side = clamp(display, 8, 160);
      return card(side + 14, (x, y) => [
        builder.rect(x, y, side, side, "#eef2ff", { name }, tokenMeta(ref)),
        ...ruler(builder, x, y + side + 3, side, false),
      ]);
    }
    case "font-family":
      return card(32, (x, y) => [
        specimenText(builder, ref, comboLabel, x, y, VISUAL_WIDTH,
          builder.label("specimen.font-family"),
          { fontFamily: String(display), fontSize: 18 }),
      ]);
    case "font-size": {
      const size = clamp(display, 8, 96);
      return card(size * 1.5, (x, y) => [
        specimenText(builder, ref, comboLabel, x, y, VISUAL_WIDTH, "Ag",
          { fontSize: size, lineHeight: 1.4 }),
      ]);
    }
    case "font-weight":
      return card(32, (x, y) => [
        specimenText(builder, ref, comboLabel, x, y, VISUAL_WIDTH,
          builder.label("specimen.font-weight"),
          { fontWeight: Number(display) }),
      ]);
    case "letter-spacing":
      return card(32, (x, y) => [
        specimenText(builder, ref, comboLabel, x, y, VISUAL_WIDTH,
          builder.label("specimen.letter-spacing"),
          { letterSpacing: Number(display) }),
      ]);
    case "text-transform":
    case "text-case":
      return card(32, (x, y) => [
        specimenText(builder, ref, comboLabel, x, y, VISUAL_WIDTH,
          builder.label("specimen.text-case"),
          { textTransform: String(display) === "title-case" ? "capitalize" : String(display) }),
      ]);
    case "text-decoration":
      return card(32, (x, y) => [
        specimenText(builder, ref, comboLabel, x, y, VISUAL_WIDTH,
          builder.label("specimen.text-decoration"),
          { textDecoration: String(display) }),
      ]);
    default: {
      // Scalar and semantic types show the raw value as editable text.
      const raw = ref.raw;
      const text =
        typeof raw === "string" ? raw : raw && typeof raw === "object" ? JSON.stringify(raw) : String(raw);
      const height = Math.max(30, 18 * Math.max(1, Math.ceil(text.length / 26)));
      return card(height + 10, (x, y) => [
        builder.rect(x, y, VISUAL_WIDTH, height + 10, "#f8fafc"),
        specimenText(builder, ref, comboLabel, x + 8, y + 5, VISUAL_WIDTH - 16, text,
          { fontSize: 14, lineHeight: 1.3, ...(ref.fontFamily ? { fontFamily: ref.fontFamily } : {}) }),
      ]);
    }
  }
}

function valueCaption(builder, ref) {
  const value = displayValue(ref);
  let shown = humanValue(ref.type, value);
  if (ref.type === "other" && shown.length > 64) shown = `${shown.slice(0, 64)}…`;
  if (ref.aliasCycle) return builder.label("alias-cycle", shown);
  if (ref.unresolvedAlias) return builder.label("alias-unresolved", shown);
  return shown;
}

// One specimen with its name and value under it, in a `width` column.
function specimenItem(builder, ref, comboLabel, width, align = "left") {
  const nameText = wrapText(
    ref.displayName ?? (ref.themeLabel ? `${ref.path} · ${ref.themeLabel}` : ref.path),
    11,
    width,
  );
  const valueText = wrapText(valueCaption(builder, ref), 10, width);
  const visual = specimenVisual(builder, ref, comboLabel);
  const nameHeight = 1.4 * 11 * nameText.split("\n").length;
  const valueHeight = 1.4 * 10 * valueText.split("\n").length;
  return {
    nameHeight,
    valueHeight,
    visualHeight: visual.height,
    draw(x, y, layout) {
      const top = y + layout.visualHeight - visual.height;
      const ids = visual.draw(align === "center" ? x + (width - visual.width) / 2 : x, top);
      ids.push(
        builder.text(x, y + layout.visualHeight + 8, nameText,
          { fontSize: 11, opacity: 0.8, textAlign: align },
          { role: "caption", runtimeId: ref.caption },
          { height: nameHeight, name: `Label · ${ref.path}`, width }),
        builder.text(x, y + layout.visualHeight + 8 + layout.nameHeight, valueText,
          { fontSize: 10, opacity: 0.45, textAlign: align, ...(ref.fontFamily ? { fontFamily: ref.fontFamily } : {}) }, undefined,
          { height: valueHeight, width }),
      );
      return ids;
    },
  };
}

function comboLabelOf(refs, ref, builder) {
  return (
    ref.combinationLabel ??
    (refs.combinations ?? []).find((combo) => combo.id === ref.combinationId)?.label ??
    builder.label("archived")
  );
}

// A grid of specimens sharing one row height.
function specimenGrid(builder, refs, members, cellWidth, innerWidth, align, gaps = {}) {
  const items = members.map((ref) =>
    specimenItem(builder, ref, comboLabelOf(refs, ref, builder), cellWidth, align));
  const layout = {
    nameHeight: Math.max(0, ...items.map((item) => item.nameHeight)),
    visualHeight: Math.max(0, ...items.map((item) => item.visualHeight)),
  };
  const valueHeight = Math.max(0, ...items.map((item) => item.valueHeight));
  const rowHeight = layout.visualHeight + 8 + layout.nameHeight + valueHeight;
  const placed = flow(
    items.map(() => ({ height: rowHeight, width: cellWidth })),
    innerWidth,
    gaps.rowGap ?? 24,
    gaps.columnGap ?? 16,
  );
  return {
    height: placed.endY,
    draw(x, y) {
      return items.flatMap((item, index) =>
        item.draw(x + placed.positions[index][0], y + placed.positions[index][1], layout));
    },
  };
}

// A token section: a heading and its body, no card around it.
const SECTION_HEAD = 34;
const SECTION_GAP = 44;

function section(builder, title, name, width, bodyHeight, drawBody, titleId) {
  return {
    height: SECTION_HEAD + bodyHeight,
    width,
    draw(x, y) {
      return [
        builder.text(x, y, title, { fontSize: 16, fontWeight: 600 },
          titleId ? { runtimeId: titleId } : undefined, { name }),
        ...drawBody(x, y + SECTION_HEAD),
      ];
    },
  };
}

function familyTitle(builder, family) {
  if (!family) return builder.label("type.color");
  const last = family.split(".").at(-1);
  return last.charAt(0).toUpperCase() + last.slice(1);
}

// One color family: a row of rounded swatches per theme, names under them.
function colorSection(builder, refs, family, members, width) {
  const combos = refs.combinations ?? [];
  const comboIndex = new Map(combos.map((combo, index) => [combo.id, index]));
  const comboLabel = new Map(combos.map((combo) => [combo.id, combo.label]));
  // A Cell of exactly one combination belongs to that theme's row; shared
  // Cells form the default row.
  const rowKey = (ref) => ((ref.combinationIds ?? []).length === 1 ? ref.combinationIds[0] : null);
  const groups = new Map();
  for (const ref of members) {
    const key = rowKey(ref);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ref);
  }
  const keys = [...groups.keys()].sort(
    (left, right) =>
      (left === null ? -1 : comboIndex.get(left) ?? 99) -
      (right === null ? -1 : comboIndex.get(right) ?? 99),
  );
  const labelled = keys.length > 1;
  const rows = keys.map((key) => {
    const grid = specimenGrid(
      builder,
      refs,
      groups.get(key).map((ref) => ({ ...ref, displayName: colorShortName(ref.path, family) })),
      COLOR_CELL,
      width,
      "center",
      { columnGap: 8, rowGap: 16 },
    );
    const label = labelled
      ? key === null
        ? builder.label("axis.default")
        : builder.axisLabel(comboLabel.get(key))
      : null;
    return { grid, height: (label ? 22 : 0) + grid.height, label };
  });
  const bodyHeight = rows.reduce((sum, row) => sum + row.height, 0) + 16 * (rows.length - 1);
  // A small family takes only the width of its swatches, so several sit on
  // one line.
  const cells = Math.max(...keys.map((key) => groups.get(key).length));
  const natural = Math.min(width, Math.max(160, cells * (COLOR_CELL + 8) - 8));
  return section(builder, familyTitle(builder, family), `Token type · color${family ? ` · ${family}` : ""}`, natural, bodyHeight, (x, y) => {
    const ids = [];
    let cy = y;
    for (const row of rows) {
      if (row.label) ids.push(builder.text(x, cy, row.label, { fontSize: 11, opacity: 0.5 }));
      ids.push(...row.grid.draw(x, cy + (row.label ? 22 : 0)));
      cy += row.height + 16;
    }
    return ids;
  });
}

// Spacing as solid bars six times the value long. The bar is the specimen
// frame: its two end blocks sit the Cell value apart (the layout gap), so
// editing the gap in the editor writes the Cell.
const BAR_SCALE = 6;

function spacingSection(builder, refs, members, width, titleId) {
  const sorted = [...members].sort((left, right) => Number(displayValue(left)) - Number(displayValue(right)));
  const longest = Math.max(0, ...sorted.map((ref) => BAR_SCALE * (Number(displayValue(ref)) || 0)));
  const labelX = Math.min(width - 120, Math.max(48, longest) + 12);
  const rowHeight = 26;
  return section(builder, builder.label("type.spacing"), "Token type · spacing", width, sorted.length * rowHeight, (x, y) =>
    sorted.flatMap((ref, index) => {
      const gap = Math.max(0, Number(displayValue(ref)) || 0);
      const block = Math.max(2, ((BAR_SCALE - 1) * gap) / 2);
      const top = y + index * rowHeight;
      const [left, right] = ref.children ?? [];
      const blockLeft = builder.rect(0, 0, block, 12, BRAND, { name: "Specimen filler" },
        left ? { runtimeId: left } : undefined);
      const blockRight = builder.rect(block + gap, 0, block, 12, BRAND, { name: "Specimen filler" },
        right ? { runtimeId: right } : undefined);
      const frame = builder.add({
        children: [blockRight, blockLeft],
        cornerRadius: 2,
        fills: [{ color: BRAND, type: "solid" }],
        height: 12,
        layout: "flex",
        "layout-align-items": "center",
        "layout-flex-dir": "row",
        "layout-gap": { "column-gap": gap, "row-gap": gap },
        "layout-gap-type": "fixed",
        "layout-padding": { p1: 0, p2: 0, p3: 0, p4: 0 },
        "layout-padding-type": "multiple",
        name: specimenName(ref, comboLabelOf(refs, ref, builder)),
        type: "FRAME",
        width: 2 * block + gap,
        x,
        y: top + 3,
      }, tokenMeta(ref));
      return [
        frame,
        builder.text(x + labelX, top, `${ref.themeLabel ? `${ref.path} · ${ref.themeLabel}` : ref.path}  ${valueCaption(builder, ref)}`,
          { fontSize: 12, opacity: 0.6 }, { role: "caption", runtimeId: ref.caption },
          { name: `Label · ${ref.path}`, width: width - labelX }),
      ];
    }), titleId);
}

// Typography as real-size lines, its numbers in the line itself.
function typographySection(builder, refs, members, width, titleId) {
  const rows = members.map((ref) => {
    const style = typographyStyle(displayValue(ref) ?? {});
    const size = style.fontSize ?? 16;
    const lineHeight = style.lineHeight ?? 1.2;
    const name = ref.path.split(/[./]/).at(-1);
    const sample = `${name.charAt(0).toUpperCase()}${name.slice(1)} ${size}/${style.fontWeight ?? 400}`;
    return { height: Math.max(20, size * lineHeight) + 2 + 16, lineHeight, ref, sample, size, style };
  }).sort((left, right) => right.size - left.size);
  const bodyHeight = rows.reduce((sum, row) => sum + row.height + 12, 0) - 12;
  return section(builder, builder.label("type.typography"), "Token type · typography", width, bodyHeight, (x, y) => {
    const ids = [];
    let cy = y;
    for (const row of rows) {
      const textHeight = Math.max(20, row.size * row.lineHeight);
      ids.push(
        builder.add({
          fills: [{ color: INK, type: "solid" }],
          growType: "fixed",
          height: textHeight,
          name: specimenName(row.ref, comboLabelOf(refs, row.ref, builder)),
          text: row.sample,
          textStyle: { fontFamily: FONT, lineHeight: 1.2, ...row.style },
          type: "TEXT",
          width,
          x,
          y: cy,
        }, tokenMeta(row.ref)),
        builder.text(x, cy + textHeight + 2,
          `${row.ref.themeLabel ? `${row.ref.path} · ${row.ref.themeLabel}` : row.ref.path} · ${valueCaption(builder, row.ref)}`,
          { fontSize: 11, opacity: 0.5 }, { role: "caption", runtimeId: row.ref.caption },
          { name: `Label · ${row.ref.path}`, height: 16, width }),
      );
      cy += row.height + 12;
    }
    return ids;
  }, titleId);
}

function tokenSection(builder, refs, type, members, width, titleId) {
  if (type === "spacing" && members.every((ref) => (ref.attribute ?? type) === "gap")) {
    return spacingSection(builder, refs, members, width, titleId);
  }
  if (type === "typography") return typographySection(builder, refs, members, width, titleId);
  const cell = type === "border-radius" ? 72 : type === "stroke-width" ? 140 : type === "shadow" ? 104 : VISUAL_WIDTH;
  const grid = specimenGrid(builder, refs, members, cell, width, type === "border-radius" || type === "shadow" ? "center" : "left");
  return section(builder, builder.label(`type.${type}`), `Token type · ${type}`, width, grid.height, (x, y) => grid.draw(x, y), titleId);
}

// --- component samples ------------------------------------------------------

function sampleSize(sample) {
  if (sample.error) {
    const metrics = designSystemTextMetrics(sample.error, 14);
    return [metrics.width, metrics.height];
  }
  let width = 0;
  let height = 0;
  const walk = (id, ox, oy) => {
    const node = sample.nodes?.[id];
    if (!node) return;
    const x = id === sample.rootId ? 0 : ox + (node.x ?? 0);
    const y = id === sample.rootId ? 0 : oy + (node.y ?? 0);
    width = Math.max(width, x + (node.width ?? 0));
    height = Math.max(height, y + (node.height ?? 0));
    for (const child of node.children ?? []) walk(child, x, y);
  };
  walk(sample.rootId, 0, 0);
  return [width, height];
}

function sampleFeatures(sample, colors) {
  if (sample.error) return new Set([stableStringify(["error", sample.error])]);
  const features = new Set();
  const strip = (value) => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === "object") {
      const out = {};
      for (const [key, item] of Object.entries(value)) {
        if (key === "text" || key === "typographyRef" || (!colors && key === "color")) continue;
        out[key] = strip(item);
      }
      return out;
    }
    return value;
  };
  const walk = (id, path) => {
    const node = sample.nodes?.[id];
    if (!node) return;
    const children = (node.children ?? []).filter((child) => sample.nodes?.[child]?.visible !== false);
    features.add(stableStringify([path, "children", children.length]));
    for (const [field, value] of Object.entries(node)) {
      if (!PREVIEW_FIELDS.has(field)) continue;
      const shown = path.length === 0 && (field === "x" || field === "y") ? 0 : value;
      features.add(stableStringify([path, field, strip(shown)]));
    }
    if (path.length === 0) {
      features.add(stableStringify([path, "x", 0]));
      features.add(stableStringify([path, "y", 0]));
    }
    children.forEach((child, index) => walk(child, [...path, index]));
  };
  walk(sample.rootId, []);
  return features;
}

const THEME_AXIS = { id: "\0theme", name: "Theme" };

function sampleAxisValue(sample, axis) {
  return axis === THEME_AXIS
    ? sample.combinationId ?? sample.combinationLabel
    : sample.selection?.[axis.id];
}

// Default, isolated axis changes, then structurally unusual combinations.
// Palette-only combinations belong to Tokens, not repeated component trees.
export function representativeComponentSamples(samples) {
  const baseline = samples[0];
  const axes = [...(baseline.axes ?? []), THEME_AXIS];
  const distance = (sample) =>
    axes.filter((axis) => sampleAxisValue(baseline, axis) !== sampleAxisValue(sample, axis)).length;
  const records = samples.map((sample, index) => {
    const features = sampleFeatures(sample, true);
    const structure = sampleFeatures(sample, false);
    const far = distance(sample);
    return { distance: far, features, index, novelty: far > 1 ? structure : features, sample, structure };
  });
  const subset = (set, covered) => [...set].every((feature) => covered.has(feature));
  const chosen = [baseline];
  const covered = new Set([...records[0].features, ...records[0].structure]);
  const done = new Set([0]);
  const add = (record) => {
    done.add(record.index);
    if (subset(record.features, covered)) return;
    chosen.push(record.sample);
    for (const feature of record.features) covered.add(feature);
    for (const feature of record.structure) covered.add(feature);
  };
  for (const axis of axes) {
    const values = [];
    for (const sample of samples) {
      const value = sampleAxisValue(sample, axis);
      if (!values.includes(value)) values.push(value);
    }
    for (const value of values) {
      const record = records
        .filter((candidate) => sampleAxisValue(candidate.sample, axis) === value)
        .sort((left, right) => compare([left.distance, left.index], [right.distance, right.index]))[0];
      if (record && !done.has(record.index)) add(record);
    }
  }
  for (;;) {
    let best = null;
    let bestKey = null;
    for (const record of records) {
      if (done.has(record.index)) continue;
      let novelty = 0;
      for (const feature of record.novelty) if (!covered.has(feature)) novelty += 1;
      const key = [-novelty, record.distance, record.index];
      if (!bestKey || compare(key, bestKey) < 0) {
        best = record;
        bestKey = key;
      }
    }
    if (!best || subset(best.novelty, covered)) return chosen;
    add(best);
  }
}

function axisValueLabel(builder, axis, value) {
  return builder.axisLabel(axis.labels?.[value] ?? value);
}

function sampleCaption(builder, baseline, sample) {
  const axes = [...(sample.axes ?? []), THEME_AXIS];
  const changes = axes.flatMap((axis) => {
    const value = sampleAxisValue(sample, axis);
    if (value === sampleAxisValue(baseline, axis)) return [];
    return [axis === THEME_AXIS ? builder.axisLabel(sample.combinationLabel) : axisValueLabel(builder, axis, value)];
  });
  if (changes.length > 0) return changes.join(" · ");
  // The first sample names its own values ("todo"), not "Default": a reader
  // looks for the variant by the names the component uses.
  const own = (sample.axes ?? []).filter((axis) => sampleAxisValue(sample, axis) !== undefined)
    .map((axis) => axisValueLabel(builder, axis, sampleAxisValue(sample, axis)));
  return own.length > 0 ? own.join(" · ") : builder.label("axis.default");
}

// One line naming every axis and its values, the way a designer captions a
// component sheet: "Style: primary / secondary · Size: md / sm".
function familySummary(builder, samples) {
  const axes = samples[0].axes ?? [];
  const parts = axes.map((axis) => {
    const used = [];
    for (const sample of samples) {
      const value = sampleAxisValue(sample, axis);
      if (value !== undefined && !used.includes(String(value))) used.push(String(value));
    }
    const ordered = (axis.domain ?? used).map(String).filter((value) => used.includes(value));
    return `${builder.axisLabel(axis.name)}: ${ordered.map((value) => axisValueLabel(builder, axis, value)).join(" / ")}`;
  });
  const themes = [];
  for (const sample of samples) {
    if (!sample.allCombinations && sample.combinationLabel && !themes.includes(sample.combinationLabel)) {
      themes.push(sample.combinationLabel);
    }
  }
  if (themes.length > 1) {
    parts.push(`${builder.axisLabel("Theme")}: ${themes.map((theme) => builder.axisLabel(theme)).join(" / ")}`);
  }
  return parts.join(" · ");
}

function lightText(sample) {
  return Object.values(sample.nodes ?? {}).some(
    (node) =>
      node.visible !== false &&
      node.type === "TEXT" &&
      [...(node.fills ?? []), ...(node.textBlocks ?? []).flatMap((block) => (block.runs ?? []).flatMap((run) => run.fills ?? []))]
        .some((fill) => {
          const hex = hexColor(fill.color);
          return hex && luminance(hex) > 160;
        }),
  );
}

function sampleItem(builder, sampleIndex, baseline, sample) {
  const [w, h] = sampleSize(sample);
  const caption = sampleCaption(builder, baseline, sample);
  const width = Math.max(120, w, designSystemTextMetrics(caption, 12).width);
  const root = sample.nodes?.[sample.rootId];
  const opaque =
    root &&
    root.type !== "TEXT" &&
    (root.opacity ?? 1) === 1 &&
    (root.fills ?? []).some((fill) => (fill.opacity ?? 1) * colorAlpha(hexColor(fill.color)) === 1);
  const white = Object.values(sample.nodes ?? {}).some((node) => (node.fills ?? []).some((fill) => isWhite(fill.color)));
  const backing = !opaque && lightText(sample) ? INK : white ? "#f1f5f9" : null;
  return {
    height: h + 36,
    width,
    draw(x, y) {
      const ids = [
        builder.text(x, y, caption, { fontSize: 12, opacity: 0.6 },
          { role: "caption", runtimeId: sample.caption }, { name: caption }),
      ];
      if (backing) ids.push(builder.rect(x, y + 28, w, h, backing, { cornerRadius: 4 }));
      ids.push(builder.add({
        fills: [],
        height: h,
        name: sample.familyName ?? "Component",
        type: "FRAME",
        width: w,
        x,
        y: y + 28,
      }, { role: "component-sample", sample: sampleIndex.get(sample) }));
      return ids;
    },
  };
}

function familyCard(builder, title, summary, items, innerWidth) {
  const summaryText = summary ? wrapText(summary, 12, innerWidth) : "";
  const top =
    CARD_PAD +
    (title ? 30 : 0) +
    (summaryText ? designSystemTextMetrics(summaryText, 12).height + 8 : 0) +
    (title || summaryText ? 12 : 0);
  const placed = flow(items, innerWidth, 24, 32);
  const width = innerWidth + 2 * CARD_PAD;
  const height = top + placed.endY + CARD_PAD;
  return {
    height,
    width,
    draw(x, y) {
      const ids = [builder.rect(x, y, width, height, CARD_FILL, {
        cornerRadius: 12,
        name: `Component card · ${title ?? ""}`,
        strokes: [{ alignment: "inner", color: CARD_STROKE, type: "solid", width: 1 }],
      })];
      if (title) ids.push(builder.text(x + CARD_PAD, y + CARD_PAD, title, { fontSize: 18, fontWeight: 600 }));
      if (summaryText) {
        ids.push(builder.text(x + CARD_PAD, y + CARD_PAD + (title ? 30 : 0), summaryText,
          { fontSize: 12, opacity: 0.55 }, undefined, { width: innerWidth }));
      }
      items.forEach((item, index) => {
        ids.push(...item.draw(x + CARD_PAD + placed.positions[index][0], y + top + placed.positions[index][1]));
      });
      return ids;
    },
  };
}

function locatedItem(builder, family, familyIndex, size) {
  const label = family.label ?? builder.label("component");
  const [w, h] = size;
  return {
    height: Math.max(h, 48) + 28,
    width: Math.max(w, 200, designSystemTextMetrics(label, 13).width),
    draw(x, y) {
      return [
        builder.text(x, y, label, { fontSize: 13, opacity: 0.75 }, { role: "caption", runtimeId: family.caption }),
        builder.add({ fills: [], height: h, name: label, type: "FRAME", width: w, x, y: y + 28 },
          { family: familyIndex, role: "located-family" }),
      ];
    },
  };
}

function classificationOrder(sample) {
  return sample.classification === "Primitive" ? 0 : 1;
}

// --- the page ---------------------------------------------------------------

// refs: runtime.designSystemRefs (full, not the compact wire form).
// ids: runtime.designSystem (board, tokenLabel, componentsSection,
// tokensEmpty, componentsEmpty, types). options.locale picks the label
// language; options.locatedSize(family) measures located families.
// A part of the page: options.only ("tokens" | "components") drops the
// other half, options.allVariantsOf (Set of Component Set ids) shows every
// variant of those sets instead of a representative few, and
// options.minWidth and options.minColumns narrow a small page.
export function buildDesignSystemPage(refs = {}, ids = {}, options = {}) {
  const builder = new PageBuilder({ locale: options.locale, seed: options.seed ?? ids.board });
  const typeIds = ids.types ?? {};

  // Components first: their columns set the page width the tokens use.
  const samples = refs.componentSamples ?? [];
  const sampleIndex = new Map(samples.map((sample, index) => [sample, index]));
  const ordered = samples
    .map((sample, index) => ({ index, sample }))
    .sort((left, right) =>
      compare(
        [classificationOrder(left.sample), left.sample.classification, left.sample.componentSetId, left.sample.variantIndex, left.sample.combinationIndex, left.index],
        [classificationOrder(right.sample), right.sample.classification, right.sample.componentSetId, right.sample.variantIndex, right.sample.combinationIndex, right.index],
      ))
    .map(({ sample }) => sample);
  const entries = [];
  for (const sample of ordered) {
    const last = entries.at(-1);
    if (last && last.setId === sample.componentSetId) last.samples.push(sample);
    else entries.push({ category: sample.classification ?? null, samples: [sample], setId: sample.componentSetId });
  }
  for (const entry of entries) {
    const firstCombination = Math.min(...entry.samples.map((sample) => sample.combinationIndex ?? 0));
    const chosen = options.allVariantsOf?.has(entry.setId)
      ? entry.samples.filter((sample) => (sample.combinationIndex ?? 0) === firstCombination)
      : representativeComponentSamples(entry.samples);
    entry.title = entry.samples[0].familyName;
    entry.summary = familySummary(builder, entry.samples);
    entry.items = chosen.map((sample) => sampleItem(builder, sampleIndex, chosen[0], sample));
  }
  const located = (refs.families ?? [])
    .map((family, index) => ({ family, index }))
    .filter(({ family }) => samples.length === 0 || family.kind === "located");
  for (const { family, index } of located) {
    const size = options.locatedSize?.(family);
    if (!size) continue;
    entries.push({ category: null, items: [locatedItem(builder, family, index, size)], summary: null, title: null });
  }
  // Every column has one width; a card with many samples spans the fewest
  // columns that keep it no taller than wide.
  const inner = Math.max(COMPONENT_INNER_MIN, ...entries.flatMap((entry) => entry.items.map((item) => item.width)));
  const columnWidth = inner + 2 * CARD_PAD;
  const cardAt = (entry, span) =>
    familyCard(builder, entry.title, entry.summary, entry.items, span * columnWidth + (span - 1) * CARD_GAP - 2 * CARD_PAD);
  for (const entry of entries) {
    entry.span = 1;
    while (entry.span < 4) {
      const card = cardAt(entry, entry.span);
      if (card.height <= card.width) break;
      entry.span += 1;
    }
  }
  const area = entries.reduce((sum, entry) => {
    const card = cardAt(entry, entry.span);
    return sum + card.width * card.height;
  }, 0);
  const columns =
    entries.length === 0
      ? 1
      : Math.min(8, Math.max(options.minColumns ?? 4, ...entries.map((entry) => entry.span), Math.ceil(Math.sqrt(area / (1.5 * columnWidth * columnWidth)))));
  const contentWidth = Math.max(options.minWidth ?? 2000, columns * columnWidth + (columns - 1) * CARD_GAP);

  // Tokens, top to bottom: each color family, typography, then the smaller
  // sections four to a row.
  const specimens = options.only === "components" ? [] : allTokenSpecimens(refs.specimens, refs.combinations);
  const families = [];
  const byFamily = new Map();
  for (const ref of specimens.filter((candidate) => candidate.type === "color")) {
    const family = colorFamily(ref.path);
    if (!byFamily.has(family)) {
      byFamily.set(family, []);
      families.push(family);
    }
    byFamily.get(family).push(ref);
  }
  const colorBlocks = families.map((family) => colorSection(builder, refs, family, byFamily.get(family), contentWidth));
  const wide = [];
  if (colorBlocks.length > 0) {
    const placed = flow(colorBlocks, contentWidth, SECTION_GAP, 56);
    wide.push({
      height: placed.endY,
      draw: (x, y0) => colorBlocks.flatMap((block, index) =>
        block.draw(x + placed.positions[index][0], y0 + placed.positions[index][1])),
    });
  }
  const typography = specimens.filter((ref) => ref.type === "typography");
  if (typography.length > 0) {
    wide.push(tokenSection(builder, refs, "typography", typography, contentWidth, typeIds.typography));
  }
  const smallWidth = (contentWidth - 3 * 64) / 4;
  const small = [];
  for (const type of TOKEN_TYPES) {
    if (type === "color" || type === "typography") continue;
    const members = specimens.filter((ref) => ref.type === type);
    if (members.length > 0) small.push(tokenSection(builder, refs, type, members, smallWidth, typeIds[type]));
  }

  const children = [];
  let y = PAD;
  if (options.only !== "components") {
    children.push(builder.text(PAD, y, builder.label("title"), { fontSize: 28, fontWeight: 700 }, { runtimeId: ids.tokenLabel }));
    y += 64;
    if (wide.length === 0 && small.length === 0) {
      children.push(builder.text(PAD, y, builder.label("no-tokens"), { fontSize: 13, opacity: 0.55 }, { runtimeId: ids.tokensEmpty }));
      y += 28 + SECTION_GAP;
    }
    for (const item of wide) {
      children.push(...item.draw(PAD, y));
      y += item.height + SECTION_GAP;
    }
    if (small.length > 0) {
      const placed = cardColumns(small.map((item) => ({ ...item, width: smallWidth })), PAD, y, 4);
      small.forEach((item, index) => children.push(...item.draw(placed.positions[index][0], placed.positions[index][1])));
      y = placed.endY + SECTION_GAP;
    }
    y += 16;
  }

  // Components under the tokens, grouped by classification.
  let right = PAD + contentWidth;
  if (options.only !== "tokens") {
    children.push(builder.text(PAD, y, builder.label("components-source"), { fontSize: 22, fontWeight: 700 }, { runtimeId: ids.componentsSection }));
    y += 48;
    const groups = [];
    for (const entry of entries) {
      const span = Math.min(entry.span, columns);
      const card = { ...cardAt(entry, span), span };
      const last = groups.at(-1);
      if (last && last.category === entry.category) last.cards.push(card);
      else groups.push({ cards: [card], category: entry.category });
    }
    if (groups.length === 0) {
      children.push(builder.text(PAD, y, builder.label("no-components"), { fontSize: 13, opacity: 0.55 }, { runtimeId: ids.componentsEmpty }));
      y += 28;
    }
    for (const group of groups) {
      children.push(builder.text(PAD, y, `${group.category ?? builder.label("component")} · ${group.cards.length}`, { fontSize: 15, fontWeight: 600, opacity: 0.6 }));
      const placed = spanColumns(group.cards, PAD, y + 34, columns, columnWidth);
      group.cards.forEach((card, index) => {
        children.push(...card.draw(placed.positions[index][0], placed.positions[index][1]));
      });
      right = Math.max(right, placed.maxX);
      y = placed.endY + SECTION_GAP;
    }
  }
  const width = right + PAD;
  const height = y - SECTION_GAP + PAD;
  const rootId = builder.add(
    {
      children,
      fills: [{ color: PAGE_FILL, type: "solid" }],
      height,
      id: "node_ds_page",
      name: builder.label("title"),
      type: "FRAME",
      width,
      x: 0,
      y: 0,
    },
    ids.board ? { runtimeId: ids.board } : undefined,
  );
  return {
    height,
    nodes: builder.nodes,
    rootId,
    runtimeIds: builder.runtimeIds,
    version: DESIGN_SYSTEM_PAGE_VERSION,
    width,
  };
}

// The page as one renderable node tree: each sample placeholder becomes the
// sample's own nodes (ids prefixed so samples never collide) at its spot.
// locatedNodes(family) returns {nodes, rootId} for a located family.
export function expandDesignSystemPage(page, refs = {}, options = {}) {
  const nodes = {};
  for (const [id, node] of Object.entries(page.nodes)) {
    const { designSystem, ...rest } = node;
    nodes[id] = { ...rest, children: [...(node.children ?? [])] };
  }
  for (const [id, node] of Object.entries(page.nodes)) {
    const role = node.designSystem?.role;
    let source = null;
    if (role === "component-sample") {
      const sample = refs.componentSamples?.[node.designSystem.sample];
      if (sample?.nodes && !sample.error) source = { nodes: sample.nodes, rootId: sample.rootId };
    } else if (role === "located-family") {
      source = options.locatedNodes?.(refs.families?.[node.designSystem.family]) ?? null;
    }
    if (!source) continue;
    const prefix = `${id}::`;
    for (const [childId, child] of Object.entries(source.nodes)) {
      nodes[prefix + childId] = {
        ...structuredClone(child),
        children: (child.children ?? []).map((grandchild) => prefix + grandchild),
        id: prefix + childId,
        ...(childId === source.rootId ? { x: 0, y: 0 } : {}),
      };
    }
    nodes[id].children = [prefix + source.rootId];
  }
  return { nodes, rootId: page.rootId };
}

// A located family's component tree as its screen projects it, for the
// page (size) and the renderer (nodes). Null when it cannot be projected.
export function locatedFamilySource(snapshot, family, options = {}) {
  if (!family?.screenId || !family.mainNodeId) return null;
  let projected;
  try {
    projected = projectScreen(snapshot, family.screenId, {
      foundation: options.foundation,
      libraries: options.libraries,
      presentationId: family.presentationId,
    });
  } catch {
    return null;
  }
  const nodes = {};
  const visit = (id) => {
    const node = projected.nodes[id];
    if (!node || nodes[id]) return;
    nodes[id] = node;
    for (const child of node.children ?? []) visit(child);
  };
  visit(family.mainNodeId);
  if (!nodes[family.mainNodeId]) return null;
  const source = { nodes, rootId: family.mainNodeId };
  return { ...source, size: sampleSize(source) };
}

// Page options for a Package: located families measured from their screens.
export function designSystemPageOptions(snapshot, options = {}) {
  return {
    locale: options.locale,
    locatedSize: (family) => locatedFamilySource(snapshot, family, options)?.size ?? null,
  };
}
