// INPUT:  Figma clipboard nodes (decoded fig-kiwi nodeChanges) and the font
//         families the package declares
// OUTPUT: a SmallPen page (HTML) holding them as plain layers, and what did
//         not come across
// POS:    Figma paste is for reference and migration, not fidelity: a
//         component or a copy becomes a plain board, an image or a vector a
//         box, an unknown font the built-in one, and every value stays raw
//         (no Tokens). Sizes are fixed, so the page always reads; the reader
//         (decodePackageFiles) then makes the layers.

const BOARD_TYPES = new Set(["FRAME", "SYMBOL", "INSTANCE", "COMPONENT_SET", "SECTION", "GROUP"]);
const BOX_TYPES = new Set(["RECTANGLE", "ROUNDED_RECTANGLE"]);
const DRAWN_AS_BOX = new Set(["VECTOR", "LINE", "STAR", "REGULAR_POLYGON", "BOOLEAN_OPERATION"]);
const NON_VISUAL = new Set([
  "DOCUMENT", "CANVAS", "INTERNAL_ONLY_NODE", "STYLE", "STYLE_SET", "VARIABLE",
  "VARIABLE_COLLECTION", "VARIABLE_SET", "SLICE", "STICKY", "CONNECTOR", "WIDGET",
]);
const BUILT_IN_FONT = "Source Sans Pro";
const PLACEHOLDER = "#e5e7eb";

const WEIGHTS = [
  [/thin|hairline/i, 100], [/extra ?light|ultra ?light/i, 200], [/light/i, 300],
  [/medium/i, 500], [/semi ?bold|demi ?bold/i, 600], [/extra ?bold|ultra ?bold/i, 800],
  [/black|heavy/i, 900], [/bold/i, 700],
];

const key = (guid) => (guid && Number.isFinite(guid.sessionID) && Number.isFinite(guid.localID) ? `${guid.sessionID}:${guid.localID}` : undefined);
const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
const round = (value) => Math.round(value * 100) / 100;
const px = (value) => `${round(value)}px`;
const escapeText = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttribute = (text) => String(text).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function hex(color, opacity = 1) {
  const channel = (value) => Math.max(0, Math.min(255, Math.round(finite(value) * 255))).toString(16).padStart(2, "0");
  const alpha = Math.max(0, Math.min(1, finite(color?.a, 1) * finite(opacity, 1)));
  return `#${channel(color?.r)}${channel(color?.g)}${channel(color?.b)}${alpha >= 0.999 ? "" : channel(alpha)}`;
}

const visible = (paint) => paint && paint.visible !== false;

// The gradient's line in the box, from Figma's paint transform (box space
// to gradient space): its inverse maps the gradient's ends back.
function gradientPoints(transform) {
  const { m00 = 1, m01 = 0, m02 = 0, m10 = 0, m11 = 1, m12 = 0 } = transform ?? {};
  const det = m00 * m11 - m01 * m10;
  if (!det) return undefined;
  const apply = (x, y) => {
    const dx = x - m02;
    const dy = y - m12;
    return [round((m11 * dx - m01 * dy) / det), round((-m10 * dx + m00 * dy) / det)];
  };
  return { start: apply(0, 0.5), end: apply(1, 0.5), center: apply(0.5, 0.5) };
}

function paintText(paint, lose) {
  if (paint.type === "SOLID") return hex(paint.color, paint.opacity);
  if (paint.type === "GRADIENT_LINEAR" || paint.type === "GRADIENT_RADIAL") {
    const points = gradientPoints(paint.transform);
    const stops = (paint.stops ?? []).map((stop) => `${hex(stop.color, paint.opacity)}_${round(finite(stop.position) * 100)}%`);
    if (points && stops.length >= 2) {
      return paint.type === "GRADIENT_LINEAR"
        ? `linear-gradient(from_${points.start[0]}_${points.start[1]}_to_${points.end[0]}_${points.end[1]},${stops.join(",")})`
        : `radial-gradient(from_${points.center[0]}_${points.center[1]}_to_${points.end[0]}_${points.end[1]},${stops.join(",")})`;
    }
  }
  if (paint.type === "IMAGE") {
    lose("image", "Images came across as gray boxes: put the image in assets/ and fill the box with it");
    return PLACEHOLDER;
  }
  lose(`paint:${paint.type}`, `A ${String(paint.type).toLowerCase().replace(/_/g, " ")} fill came across as a gray box`);
  return PLACEHOLDER;
}

function weightOf(style) {
  for (const [pattern, weight] of WEIGHTS) if (pattern.test(style ?? "")) return weight;
  return 400;
}

// The Figma clipboard as one SmallPen page: { html, losses }.
export function figmaPageHtml(nodeChanges, { fontFamilies = [], title = "Figma paste" } = {}) {
  const fonts = new Set([BUILT_IN_FONT, ...fontFamilies]);
  const losses = new Map();
  const lose = (code, message) => {
    if (!losses.has(code)) losses.set(code, message);
  };
  const byKey = new Map();
  for (const node of nodeChanges ?? []) {
    const id = key(node?.guid);
    if (id && node.phase !== "REMOVED") byKey.set(id, node);
  }
  const children = new Map();
  const roots = [];
  for (const [id, node] of byKey) {
    if (NON_VISUAL.has(node.type)) continue;
    const parent = key(node.parentIndex?.guid);
    if (parent && byKey.has(parent) && !NON_VISUAL.has(byKey.get(parent).type)) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(id);
    } else roots.push(id);
  }
  // Figma orders siblings by a position key, bottom layer first, as HTML does.
  const position = (id) => String(byKey.get(id).parentIndex?.position ?? "");
  for (const list of children.values()) list.sort((left, right) => (position(left) < position(right) ? -1 : position(left) > position(right) ? 1 : 0));
  if (roots.length === 0) return { html: undefined, losses: [{ code: "empty", message: "The Figma clipboard holds nothing to draw" }] };

  // Where a node sits in its parent: its box, and a turn about its centre.
  const place = (node) => {
    const { m00 = 1, m01 = 0, m02 = 0, m10 = 0, m11 = 1, m12 = 0 } = node.transform ?? {};
    const width = finite(node.size?.x);
    const height = finite(node.size?.y);
    const angle = Math.atan2(m10, m00) * (180 / Math.PI);
    if (Math.abs(angle) < 0.01) return { x: m02, y: m12, width, height, angle: 0 };
    const cx = m02 + (m00 * width + m01 * height) / 2;
    const cy = m12 + (m10 * width + m11 * height) / 2;
    return { x: cx - width / 2, y: cy - height / 2, width, height, angle };
  };

  const rootBoxes = roots.map((id) => place(byKey.get(id)));
  const left = Math.min(...rootBoxes.map((box) => box.x));
  const top = Math.min(...rootBoxes.map((box) => box.y));
  const right = Math.max(...rootBoxes.map((box) => box.x + box.width));
  const bottom = Math.max(...rootBoxes.map((box) => box.y + box.height));

  const lines = [];
  const visit = (id, depth, parent, offset, usedNames) => {
    const node = byKey.get(id);
    const box = place(node);
    const indent = "  ".repeat(depth);
    const classes = [];
    const auto = parent && (parent.stackMode === "HORIZONTAL" || parent.stackMode === "VERTICAL") && node.stackPositioning !== "ABSOLUTE";
    const row = parent?.stackMode === "HORIZONTAL";
    // Position: by left/top, unless the parent's auto layout places it.
    if (!auto) {
      if (parent && (parent.stackMode === "HORIZONTAL" || parent.stackMode === "VERTICAL")) classes.push("absolute");
      classes.push(`left-[${px(box.x - offset.x)}]`, `top-[${px(box.y - offset.y)}]`);
    }
    // Size: fixed, or filling the parent's room where auto layout says so.
    const fillMain = auto && node.stackChildPrimaryGrow === 1;
    const fillCross = auto && node.stackChildAlignSelf === "STRETCH";
    const text = node.type === "TEXT";
    const widthFills = (row && fillMain) || (!row && fillCross);
    const heightFills = (row && fillCross) || (!row && fillMain);
    if (text) {
      const resize = node.textAutoResize ?? "NONE";
      if (widthFills) classes.push("w-full");
      else if (resize !== "WIDTH_AND_HEIGHT") classes.push(`w-[${px(box.width)}]`);
      if (resize === "NONE" && !widthFills) classes.push(`h-[${px(box.height)}]`);
    } else {
      classes.push(widthFills ? "w-full" : `w-[${px(box.width)}]`);
      classes.push(heightFills ? "h-full" : `h-[${px(box.height)}]`);
    }
    if (box.angle) classes.push(`rotate-[${round(box.angle)}deg]`);
    if (node.opacity !== undefined && node.opacity < 1) classes.push(`opacity-[${round(node.opacity)}]`);
    if (node.visible === false) classes.push("hidden");
    const blend = String(node.blendMode ?? "PASS_THROUGH");
    if (!["PASS_THROUGH", "NORMAL"].includes(blend)) classes.push(`mix-blend-${blend.toLowerCase().replace(/_/g, "-")}`);

    // Auto layout.
    const stack = node.stackMode === "HORIZONTAL" || node.stackMode === "VERTICAL";
    if (stack && !text) {
      classes.push("flex", node.stackMode === "HORIZONTAL" ? "flex-row" : "flex-col");
      if (node.stackWrap === "WRAP") classes.push("flex-wrap");
      const base = finite(node.stackPadding);
      const padding = [
        finite(node.stackVerticalPadding, base), finite(node.stackPaddingRight, finite(node.stackHorizontalPadding, base)),
        finite(node.stackPaddingBottom, finite(node.stackVerticalPadding, base)), finite(node.stackHorizontalPadding, base),
      ];
      [["pt", 0], ["pr", 1], ["pb", 2], ["pl", 3]].forEach(([name, index]) => {
        if (padding[index]) classes.push(`${name}-[${px(padding[index])}]`);
      });
      if (finite(node.stackSpacing)) classes.push(`gap-[${px(node.stackSpacing)}]`);
      const justify = { CENTER: "justify-center", MAX: "justify-end", SPACE_BETWEEN: "justify-between", SPACE_EVENLY: "justify-evenly" }[node.stackPrimaryAlignItems];
      if (justify) classes.push(justify);
      // Figma starts children at the start; CSS would stretch them.
      classes.push({ CENTER: "items-center", MAX: "items-end" }[node.stackCounterAlignItems] ?? "items-start");
    }
    if (BOARD_TYPES.has(node.type) && (node.frameMaskDisabled === true || node.type === "GROUP")) classes.push("overflow-visible");

    // Paint.
    const fills = (node.fillPaints ?? []).filter(visible);
    if (text) {
      const solid = fills.find((paint) => paint.type === "SOLID");
      if (solid) classes.push(`text-[${hex(solid.color, solid.opacity)}]`);
      if (fills.some((paint) => paint.type !== "SOLID")) lose("text-paint", "Text with a gradient or image fill came across in one color");
    } else if (fills.length) {
      // Figma lists fills bottom first; CSS top first.
      classes.push(`bg-[${fills.map((paint) => paintText(paint, lose)).reverse().join(",")}]`);
    } else if (DRAWN_AS_BOX.has(node.type)) classes.push(`bg-[${PLACEHOLDER}]`);
    const strokes = (node.strokePaints ?? []).filter(visible).filter((paint) => paint.type === "SOLID");
    if (strokes.length && finite(node.strokeWeight) > 0 && !text) {
      const align = { INSIDE: "inside", CENTER: "center", OUTSIDE: "outside" }[node.strokeAlign] ?? "inside";
      const dashed = Array.isArray(node.dashPattern) && node.dashPattern.length ? "_dashed" : "";
      classes.push(`border-[${strokes.map((paint) => `${px(node.strokeWeight)}_${hex(paint.color, paint.opacity)}${dashed}_${align}`).reverse().join(",")}]`);
    }
    if ((node.strokePaints ?? []).filter(visible).some((paint) => paint.type !== "SOLID")) lose("stroke-paint", "Gradient or image strokes were left out");
    if (node.rectangleCornerRadiiIndependent) {
      [["tl", "rectangleTopLeftCornerRadius"], ["tr", "rectangleTopRightCornerRadius"], ["br", "rectangleBottomRightCornerRadius"], ["bl", "rectangleBottomLeftCornerRadius"]]
        .forEach(([corner, field]) => {
          if (finite(node[field]) > 0) classes.push(`rounded-${corner}-[${px(node[field])}]`);
        });
    } else if (finite(node.cornerRadius) > 0 && !text) classes.push(`rounded-[${px(node.cornerRadius)}]`);
    const shadows = [];
    for (const effect of node.effects ?? []) {
      const hidden = effect.visible === false ? "_hidden" : "";
      if (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW") {
        shadows.push(`${effect.type === "INNER_SHADOW" ? "inset_" : ""}${px(finite(effect.offset?.x))}_${px(finite(effect.offset?.y))}_${px(Math.max(0, finite(effect.radius)))}_${px(finite(effect.spread))}_${hex(effect.color)}${hidden}`);
      } else if (effect.type === "FOREGROUND_BLUR" || effect.type === "LAYER_BLUR") {
        classes.push(`blur-[${px(Math.max(0, finite(effect.radius)))}${hidden}]`);
      } else if (effect.type === "BACKGROUND_BLUR") {
        classes.push(`backdrop-blur-[${px(Math.max(0, finite(effect.radius)))}${hidden}]`);
      }
    }
    if (shadows.length && !text) classes.push(`shadow-[${shadows.join(",")}]`);
    if (shadows.length && text) lose("text-shadow", "Text shadows were left out");

    // Text style.
    let content = "";
    if (text) {
      const family = node.fontName?.family;
      if (family && fonts.has(family)) classes.push(`font-[${family.replace(/ /g, "_")}]`);
      else if (family) lose(`font:${family}`, `${family} is not a font of this package; its text uses ${BUILT_IN_FONT} (add @font-face in tokens.css and the file in assets/fonts/)`);
      const weight = weightOf(node.fontName?.style);
      if (weight !== 400) classes.push(`font-[${weight}]`);
      if (/italic|oblique/i.test(node.fontName?.style ?? "")) classes.push("italic");
      if (finite(node.fontSize) > 0) classes.push(`text-[${px(node.fontSize)}]`);
      const lineHeight = node.lineHeight;
      if (lineHeight && finite(lineHeight.value) > 0) {
        if (lineHeight.units === "PIXELS") classes.push(`leading-[${px(lineHeight.value)}]`);
        else if (lineHeight.units === "PERCENT") classes.push(`leading-[${round(lineHeight.value / 100)}]`);
        else if (lineHeight.units === "RAW") classes.push(`leading-[${round(lineHeight.value)}]`);
      }
      const spacing = node.letterSpacing;
      if (spacing && finite(spacing.value) !== 0) {
        classes.push(spacing.units === "PERCENT" ? `tracking-[${round(spacing.value / 100)}em]` : `tracking-[${px(spacing.value)}]`);
      }
      const align = { CENTER: "text-center", RIGHT: "text-right", JUSTIFIED: "text-justify" }[node.textAlignHorizontal];
      if (align) classes.push(align);
      const vertical = { CENTER: "align-middle", BOTTOM: "align-bottom" }[node.textAlignVertical];
      if (vertical) classes.push(vertical);
      const textCase = { UPPER: "uppercase", LOWER: "lowercase", TITLE: "capitalize" }[node.textCase];
      if (textCase) classes.push(textCase);
      const decoration = { UNDERLINE: "underline", STRIKETHROUGH: "line-through" }[node.textDecoration];
      if (decoration) classes.push(decoration);
      if ((node.textData?.styleOverrideTable ?? []).length) lose("text-runs", "Text with mixed styles came across in one style");
      const characters = String(node.textData?.characters ?? node.characters ?? "");
      if (/(?:^|\n)[ \t]|[ \t](?:\n|$)|[ \t]{2}|\t/.test(characters)) classes.push("whitespace-pre-wrap");
      content = characters.split("\n").map(escapeText).join("<br>") || "\u00a0";
    }
    if (DRAWN_AS_BOX.has(node.type)) lose("vector", "Vectors and drawn shapes came across as boxes of their size");
    if (node.type === "INSTANCE" || node.type === "SYMBOL") lose("component", "Components and copies came across as plain boards");

    // Names are unique among siblings here.
    const base = String(node.name ?? node.type ?? "Layer").trim() || "Layer";
    let name = base;
    for (let counter = 2; usedNames.has(name.toLowerCase()); counter += 1) name = `${base} ${counter}`;
    usedNames.add(name.toLowerCase());

    const tag = text ? "p" : "div";
    const shape = BOX_TYPES.has(node.type) || DRAWN_AS_BOX.has(node.type) ? ' data-shape="rectangle"' : node.type === "ELLIPSE" ? ' data-shape="ellipse"' : "";
    const open = `${indent}<${tag}${shape} data-name="${escapeAttribute(name)}" class="${classes.join(" ")}">`;
    const kids = text || !(BOARD_TYPES.has(node.type)) ? [] : children.get(id) ?? [];
    if (!BOARD_TYPES.has(node.type) && !text && (children.get(id) ?? []).length) lose("nested", "Layers inside shapes other than frames and groups were left out");
    if (text) lines.push(`${open}${content}</p>`);
    else if (!kids.length) lines.push(`${open}</div>`);
    else {
      lines.push(open);
      const names = new Set();
      // Children sit in this node's own box.
      for (const child of kids) visit(child, depth + 1, node, { x: 0, y: 0 }, names);
      lines.push(`${indent}</div>`);
    }
  };
  const names = new Set();
  for (const id of roots) visit(id, 1, undefined, { x: left, y: top }, names);
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeText(title)}</title>
  <link rel="stylesheet" href="../tokens.css">
</head>
<body class="w-[${px(Math.max(1, right - left))}] h-[${px(Math.max(1, bottom - top))}] bg-none">
${lines.join("\n")}
</body>
</html>
`;
  return { html, losses: [...losses].map(([code, message]) => ({ code, message })) };
}
