// INPUT:  resolved class slots of one element, its node type and parent
// OUTPUT: package-model node fields plus Token bindings
// POS:    The decode half of the class vocabulary: slots -> node fields.

import { uuidFromKey } from "./ids.mjs";
import { alphaFromByte, resolveClass, splitClasses } from "./vocabulary.mjs";

export function createState() {
  return { padding: {}, margin: {}, radius: {}, text: {}, touched: new Set() };
}

function side(target, keys, payload) {
  for (const key of keys) target[key] = payload;
}

// Writes one class into the state. Later classes overwrite earlier ones.
function applySlot(state, slot, payload, report) {
  state.touched.add(slot);
  switch (slot) {
    case "padding": side(state.padding, ["top", "right", "bottom", "left"], payload); break;
    case "paddingX": side(state.padding, ["right", "left"], payload); break;
    case "paddingY": side(state.padding, ["top", "bottom"], payload); break;
    case "paddingTop": state.padding.top = payload; break;
    case "paddingRight": state.padding.right = payload; break;
    case "paddingBottom": state.padding.bottom = payload; break;
    case "paddingLeft": state.padding.left = payload; break;
    case "margin": side(state.margin, ["top", "right", "bottom", "left"], payload); break;
    case "marginX": side(state.margin, ["right", "left"], payload); break;
    case "marginY": side(state.margin, ["top", "bottom"], payload); break;
    case "marginTop": state.margin.top = payload; break;
    case "marginRight": state.margin.right = payload; break;
    case "marginBottom": state.margin.bottom = payload; break;
    case "marginLeft": state.margin.left = payload; break;
    case "gap": state.rowGap = payload; state.columnGap = payload; break;
    case "rowGap": state.rowGap = payload; break;
    case "columnGap": state.columnGap = payload; break;
    case "radius":
      side(state.radius, ["topLeft", "topRight", "bottomRight", "bottomLeft"], payload);
      state.radius.uniform = true;
      break;
    case "radiusTopLeft": state.radius.topLeft = payload; state.radius.uniform = false; break;
    case "radiusTopRight": state.radius.topRight = payload; state.radius.uniform = false; break;
    case "radiusBottomRight": state.radius.bottomRight = payload; state.radius.uniform = false; break;
    case "radiusBottomLeft": state.radius.bottomLeft = payload; state.radius.uniform = false; break;
    case "border":
      if (payload.strokes) {
        // A stroke list states every stroke; it replaces the single-stroke classes.
        for (const key of ["strokeColor", "strokeWidth", "strokeStyle", "strokeAlignment", "strokeSides", "strokeNone"]) delete state[key];
        state.strokeList = payload.strokes;
        break;
      }
      delete state.strokeList;
      if (payload.tokenType === "color" || payload.color) state.strokeColor = payload;
      else state.strokeWidth = payload;
      break;
    case "strokeWidth": delete state.strokeList; state.strokeWidth = payload; break;
    case "stroke":
      state.strokeNone = payload === null;
      if (payload === null) { delete state.strokeColor; delete state.strokeWidth; delete state.strokeList; }
      break;
    case "strokeStyle":
    case "strokeAlignment":
      delete state.strokeList;
      state[slot] = payload;
      break;
    case "strokeWidthTop":
    case "strokeWidthRight":
    case "strokeWidthBottom":
    case "strokeWidthLeft":
      delete state.strokeList;
      state.strokeSides = { ...(state.strokeSides ?? {}), [slot]: payload };
      break;
    case "text":
      if (payload.tokenType === "color" || payload.color) state.textColor = payload;
      else state.text.fontSize = payload;
      break;
    case "font":
      if (payload.tokenType === "font-weight" || payload.weight !== undefined) {
        state.text.fontWeight = payload.weight !== undefined ? { value: payload.weight, literal: true } : payload;
      } else {
        state.text.fontFamily = payload.family !== undefined ? { value: payload.family, literal: true } : payload;
      }
      break;
    case "typography": state.text.typography = payload; break;
    case "lineHeight": state.text.lineHeight = payload; break;
    case "letterSpacing": state.text.letterSpacing = payload; break;
    case "textAlign":
    case "fontStyle":
    case "textTransform":
    case "textDecoration":
    case "verticalAlign":
    case "textDirection":
      state.text[slot] = payload;
      break;
    case "blur":
    case "backgroundBlur":
      state[slot] = payload;
      break;
    default:
      state[slot] = payload;
  }
}

// Reads every class of a class attribute (plus inherited sources such as
// variant rules) into the state. sources: [{ value, offset }].
export function readClasses(state, sources, tokens, report) {
  for (const source of sources) {
    if (!source?.value) continue;
    for (const { name, start } of splitClasses(source.value)) {
      const offset = source.offset + start;
      const result = resolveClass(name, tokens);
      if (result.error) {
        report(result.error.code, result.error.message, offset, result.error);
        continue;
      }
      for (const [slot, payload] of result.slots) {
        applySlot(state, slot, payload, (code, message) => report(code, message, offset));
      }
      if (result.note) report(result.note.code, result.note.message, offset, { severity: "warning" });
    }
  }
  return state;
}

// payload -> { value, binding } using the Token resolver.
export function valueOf(payload, ctx, field) {
  if (!payload) return undefined;
  if (payload.token) {
    return {
      value: ctx.tokenValue(payload.token),
      binding: field ? [field, ctx.tokenRef(payload.token)] : undefined,
    };
  }
  return { value: payload.value ?? payload.color };
}

function splitAlpha(hex) {
  if (typeof hex === "string" && hex.length === 9) {
    return { color: hex.slice(0, 7), opacity: alphaFromByte(Number.parseInt(hex.slice(7), 16)) };
  }
  return { color: hex };
}

function paint(payload, ctx, bindingField, bindings) {
  if (payload.gradient) return structuredClone(payload.gradient);
  if (payload.image !== undefined) {
    const media = ctx.mediaRef(payload.image, ctx.currentElement);
    const fill = { mediaRef: media ?? { path: undefined }, type: "image" };
    if (payload.opacity !== undefined) fill.opacity = payload.opacity;
    return fill;
  }
  const resolved = valueOf(payload, ctx, bindingField);
  if (resolved?.binding) bindings[resolved.binding[0]] = resolved.binding[1];
  const { color, opacity } = splitAlpha(typeof resolved?.value === "string" ? resolved.value : "#000000");
  return opacity === undefined ? { color, type: "solid" } : { color, opacity, type: "solid" };
}

// Visual fields shared by every node type. Returns { fields, bindings }.
export function visualFields(type, state, ctx) {
  const fields = {};
  const bindings = {};
  const isText = type === "TEXT";

  if (isText) {
    if (state.textColor) fields.fills = [paint(state.textColor, ctx, "fill", bindings)];
  } else if (state.fill === null) {
    fields.fills = [];
  } else if (state.fill?.layers) {
    // One Token layer alone is bg-<token>; in a list each Token layer binds
    // its own fill, fills.0 being the one the App shows as the fill Token.
    const single = state.fill.layers.length === 1;
    fields.fills = state.fill.layers.map((layer, index) =>
      paint(layer, ctx, single ? "fill" : `fills.${index}`, bindings));
  } else if (state.fill) {
    fields.fills = [paint(state.fill, ctx, "fill", bindings)];
  }

  if (state.strokeList) {
    const single = state.strokeList.length === 1;
    fields.strokes = state.strokeList.map((entry, index) => {
      const color = paint(entry.color, ctx, single ? "stroke" : `strokes.${index}`, bindings);
      const width = entry.width ? valueOf(entry.width, ctx, single ? "strokeWidth" : undefined) : { value: 1 };
      if (width.binding) bindings[width.binding[0]] = width.binding[1];
      if (entry.width?.token && !single) {
        ctx.issue?.("unsupported_class", "A stroke-width Token binds one stroke only; write the width in px in a stroke list", ctx.currentElement?.offset ?? 0);
      }
      const stroke = { alignment: entry.alignment ?? "inner", color: color.color, type: "solid", width: width.value };
      if (color.opacity !== undefined) stroke.opacity = color.opacity;
      if (entry.style && entry.style !== "solid") stroke.style = entry.style;
      // border-hidden hides every stroke; hidden in a stroke hides that one.
      if (entry.hidden || state.strokeHidden) stroke.hidden = true;
      return stroke;
    });
  } else if (!state.strokeNone && (state.strokeWidth || state.strokeColor || state.strokeSides)) {
    // As in CSS, border-b-* alone draws the bottom only: the other sides
    // take the border width, which is 0 unless border or border-* sets it.
    const width = state.strokeWidth
      ? valueOf(state.strokeWidth, ctx, "strokeWidth")
      : { value: state.strokeSides ? 0 : 1 };
    if (width.binding) bindings[width.binding[0]] = width.binding[1];
    const color = state.strokeColor
      ? paint(state.strokeColor, ctx, "stroke", bindings)
      : { color: "#000000", type: "solid" };
    const stroke = {
      alignment: state.strokeAlignment ?? "inner",
      color: color.color,
      type: "solid",
      width: width.value,
    };
    if (color.opacity !== undefined) stroke.opacity = color.opacity;
    if (state.strokeStyle && state.strokeStyle !== "solid") stroke.style = state.strokeStyle;
    if (state.strokeHidden) stroke.hidden = true;
    const sideFields = { strokeWidthTop: "widthTop", strokeWidthRight: "widthRight", strokeWidthBottom: "widthBottom", strokeWidthLeft: "widthLeft" };
    for (const [slot, payload] of Object.entries(state.strokeSides ?? {})) {
      const resolved = valueOf(payload, ctx, slot);
      stroke[sideFields[slot]] = resolved.value;
      if (resolved.binding) bindings[slot] = resolved.binding[1];
    }
    const anySide = Object.keys(sideFields).some((key) => stroke[sideFields[key]] > 0);
    if (width.value > 0 || anySide) fields.strokes = [stroke];
    else fields.strokes = [];
  } else if (state.strokeNone) {
    fields.strokes = [];
  }

  const corners = ["topLeft", "topRight", "bottomRight", "bottomLeft"];
  if (corners.some((corner) => state.radius[corner])) {
    const bindingNames = { topLeft: "radiusTopLeft", topRight: "radiusTopRight", bottomRight: "radiusBottomRight", bottomLeft: "radiusBottomLeft" };
    const values = corners.map((corner) => valueOf(state.radius[corner], ctx) ?? { value: 0 });
    const same = corners.every((corner) => state.radius[corner] === state.radius.topLeft);
    if (same && state.radius.topLeft) {
      const resolved = valueOf(state.radius.topLeft, ctx, "cornerRadius");
      fields.cornerRadius = resolved.value;
      if (resolved.binding) bindings.cornerRadius = resolved.binding[1];
    } else {
      fields.cornerRadius = values.map((entry) => entry.value);
      for (const corner of corners) {
        if (state.radius[corner]?.token) bindings[bindingNames[corner]] = ctx.tokenRef(state.radius[corner].token);
      }
    }
  }

  if (state.shadow === null) {
    // shadow-none clears an inherited shadow; nothing to store.
  } else if (state.shadow) {
    const resolved = valueOf(state.shadow, ctx, "shadow");
    fields.shadow = resolved.value;
    if (resolved.binding) bindings.shadow = resolved.binding[1];
  }
  if (state.opacity) {
    const resolved = valueOf(state.opacity, ctx, "opacity");
    fields.opacity = resolved.value;
    if (resolved.binding) bindings.opacity = resolved.binding[1];
  }
  if (state.visible === false) fields.visible = false;
  if (state.visible === true && state.touched.has("visible")) fields.visible = true;
  for (const [slot, type] of [["blur", "layer-blur"], ["backgroundBlur", "background-blur"]]) {
    if (!state[slot]) continue;
    fields[slot] = { hidden: state[slot].hidden === true, id: uuidFromKey(`${ctx.currentNodeId ?? "node"}\0${slot}`), type, value: state[slot].value };
  }
  if (state.rotation) fields.rotation = state.rotation.value;
  if (state.flipX) fields.flipX = true;
  if (state.flipY) fields.flipY = true;
  if (state.blendMode && state.blendMode !== "normal") fields["blend-mode"] = state.blendMode;
  if (state.viewerHidden) fields["hide-in-viewer"] = true;
  if (state.pinX) fields["constraints-h"] = state.pinX;
  if (state.pinY) fields["constraints-v"] = state.pinY;
  return { fields, bindings };
}

const TEXT_FIELD_BINDINGS = {
  fontFamily: "fontFamily",
  fontSize: "fontSize",
  fontWeight: "fontWeight",
  letterSpacing: "letterSpacing",
};

export function textStyleOf(state, ctx, bindings) {
  const style = {};
  const text = state.text;
  if (text.typography) {
    const value = ctx.tokenValue(text.typography.token);
    if (value && typeof value === "object") {
      for (const field of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing"]) {
        if (value[field] !== undefined) style[field] = value[field];
      }
    }
    bindings.typography = ctx.tokenRef(text.typography.token);
  }
  for (const field of ["fontFamily", "fontSize", "fontWeight", "letterSpacing", "lineHeight"]) {
    if (!text[field]) continue;
    const resolved = valueOf(text[field], ctx, TEXT_FIELD_BINDINGS[field]);
    style[field] = resolved.value;
    if (resolved.binding) bindings[resolved.binding[0]] = resolved.binding[1];
  }
  for (const field of ["textAlign", "fontStyle", "textTransform", "textDecoration", "verticalAlign", "textDirection"]) {
    if (text[field] !== undefined) style[field] = text[field];
  }
  return style;
}

function spacingValue(payload, ctx, bindingField, bindings) {
  if (!payload) return 0;
  const resolved = valueOf(payload, ctx, bindingField);
  if (resolved.binding) bindings[bindingField] = resolved.binding[1];
  return resolved.value;
}

// Container layout fields for a node with `flex`.
export function layoutFields(state, ctx) {
  const fields = {};
  const bindings = {};
  if (state.layout !== "flex" && state.layout !== "grid") return { fields, bindings };
  fields.layout = state.layout;
  if (state.layout === "flex") {
    fields["layout-flex-dir"] = state.direction ?? "row";
    if (state.wrap === "wrap") fields["layout-wrap-type"] = "wrap";
  } else {
    // The flow direction gets tracks as children need them (auto, as in
    // CSS); the other direction has one 1fr track unless the classes say.
    const dir = state.gridDir ?? "row";
    fields["layout-grid-dir"] = dir;
    fields["layout-grid-columns"] = structuredClone(state.gridColumns ?? (dir === "row" ? [{ type: "flex", value: 1 }] : []));
    fields["layout-grid-rows"] = structuredClone(state.gridRows ?? (dir === "row" ? [] : [{ type: "flex", value: 1 }]));
    if (state.justifyItems) fields["layout-justify-items"] = state.justifyItems;
  }
  if (state.alignItems) fields["layout-align-items"] = state.alignItems;
  if (state.justify) fields["layout-justify-content"] = state.justify;
  if (state.alignContent) fields["layout-align-content"] = state.alignContent;
  if (state.rowGap || state.columnGap) {
    fields["layout-gap"] = {
      "column-gap": spacingValue(state.columnGap, ctx, "columnGap", bindings),
      "row-gap": spacingValue(state.rowGap, ctx, "rowGap", bindings),
    };
  }
  const padding = state.padding;
  if (padding.top || padding.right || padding.bottom || padding.left) {
    fields["layout-padding"] = {
      p1: spacingValue(padding.top, ctx, "paddingTop", bindings),
      p2: spacingValue(padding.right, ctx, "paddingRight", bindings),
      p3: spacingValue(padding.bottom, ctx, "paddingBottom", bindings),
      p4: spacingValue(padding.left, ctx, "paddingLeft", bindings),
    };
    fields["layout-padding-type"] = "multiple";
  }
  return { fields, bindings };
}

// Item fields for a child of a flex or grid container. A grid child's
// alignment belongs to its cell (gridCell), not to the child.
export function itemFields(state, ctx, { grid = false } = {}) {
  const fields = {};
  const bindings = {};
  const margin = state.margin;
  if (margin.top || margin.right || margin.bottom || margin.left) {
    fields["layout-item-margin"] = {
      m1: spacingValue(margin.top, ctx, "marginTop", bindings),
      m2: spacingValue(margin.right, ctx, "marginRight", bindings),
      m3: spacingValue(margin.bottom, ctx, "marginBottom", bindings),
      m4: spacingValue(margin.left, ctx, "marginLeft", bindings),
    };
    fields["layout-item-margin-type"] = "multiple";
  }
  if (state.alignSelf && !grid) fields["layout-item-align-self"] = state.alignSelf;
  if (state.absolute) fields["layout-item-absolute"] = true;
  if (state.zIndex) fields["layout-item-z-index"] = state.zIndex.value;
  for (const [slot, field, binding] of [
    ["minWidth", "layout-item-min-w", "minWidth"],
    ["maxWidth", "layout-item-max-w", "maxWidth"],
    ["minHeight", "layout-item-min-h", "minHeight"],
    ["maxHeight", "layout-item-max-h", "maxHeight"],
  ]) {
    if (!state[slot]) continue;
    const resolved = valueOf(state[slot], ctx, binding);
    fields[field] = resolved.value;
    if (resolved.binding) bindings[binding] = resolved.binding[1];
  }
  return { fields, bindings };
}

// Where a grid child goes: an explicit line and span, alignment in its cell.
export function gridItem(state) {
  return {
    column: state.columnStart,
    row: state.rowStart,
    columnSpan: state.columnSpan ?? 1,
    rowSpan: state.rowSpan ?? 1,
    alignSelf: state.alignSelf,
    justifySelf: state.justifySelf,
  };
}
