import { resolveContext } from "./contexts.mjs";
import { resolveEffectiveToken } from "./effective-tokens.mjs";
import { fail } from "./errors.mjs";
import { appliedTokenFields } from "./token-attributes.mjs";

// The Token types each tokenBindings field accepts.
export const TOKEN_BINDING_FIELD_TYPES = new Map([
  ["backgroundBlur", ["other", "number"]],
  ["blur", ["other", "number"]],
  ["columnGap", ["dimension", "dimensions", "number", "spacing"]],
  ["cornerRadius", ["border-radius", "dimension", "dimensions", "number"]],
  ["fill", ["color"]],
  ["fills.N", ["color"]],
  ["fontFamily", ["font-family", "string"]],
  ["fontSize", ["dimension", "dimensions", "font-size", "number"]],
  ["fontWeight", ["font-weight", "number"]],
  ["height", ["dimension", "dimensions", "number", "sizing"]],
  ["itemSpacing", ["dimension", "dimensions", "number", "spacing"]],
  ["opacity", ["number", "opacity"]],
  ["paddingBottom", ["dimension", "dimensions", "number", "spacing"]],
  ["paddingLeft", ["dimension", "dimensions", "number", "spacing"]],
  ["paddingRight", ["dimension", "dimensions", "number", "spacing"]],
  ["paddingTop", ["dimension", "dimensions", "number", "spacing"]],
  ["rowGap", ["dimension", "dimensions", "number", "spacing"]],
  ["shadow", ["shadow"]],
  ["stroke", ["color"]],
  ["strokes.N", ["color"]],
  ["strokeWidth", ["stroke-width", "dimension", "dimensions", "number"]],
  ["strokeWidthTop", ["stroke-width", "dimension", "dimensions", "number"]],
  ["strokeWidthRight", ["stroke-width", "dimension", "dimensions", "number"]],
  ["strokeWidthBottom", ["stroke-width", "dimension", "dimensions", "number"]],
  ["strokeWidthLeft", ["stroke-width", "dimension", "dimensions", "number"]],
  ["text", ["string"]],
  ["typography", ["typography"]],
  ["visible", ["boolean"]],
  ["radiusTopLeft", ["border-radius", "dimension", "dimensions", "number"]],
  ["radiusTopRight", ["border-radius", "dimension", "dimensions", "number"]],
  ["radiusBottomRight", ["border-radius", "dimension", "dimensions", "number"]],
  ["radiusBottomLeft", ["border-radius", "dimension", "dimensions", "number"]],
  ["minWidth", ["sizing", "dimension", "dimensions", "number"]],
  ["maxWidth", ["sizing", "dimension", "dimensions", "number"]],
  ["minHeight", ["sizing", "dimension", "dimensions", "number"]],
  ["maxHeight", ["sizing", "dimension", "dimensions", "number"]],
  ["marginTop", ["spacing", "dimension", "dimensions", "number"]],
  ["marginRight", ["spacing", "dimension", "dimensions", "number"]],
  ["marginBottom", ["spacing", "dimension", "dimensions", "number"]],
  ["marginLeft", ["spacing", "dimension", "dimensions", "number"]],
  ["letterSpacing", ["letter-spacing", "dimension", "dimensions", "number"]],
  ["lineHeight", ["number", "dimension", "dimensions"]],
  ["textTransform", ["text-case"]],
  ["textDecoration", ["text-decoration"]],
  ["rotation", ["rotation", "number"]],
  ["x", ["dimension", "dimensions", "number"]],
  ["y", ["dimension", "dimensions", "number"]],
  ["width", ["dimension", "dimensions", "number", "sizing"]],
]);

function compatible(field, token) {
  const baseField = field.startsWith("fills.") ? "fill"
    : field.startsWith("strokes.") ? "stroke"
      : field;
  return TOKEN_BINDING_FIELD_TYPES.get(baseField)?.includes(token.type) === true;
}

// Whether the node has the paint a binding field writes into.
export function hasTokenBindingTarget(node, field) {
  const indexed = /^(fills|strokes)\.(\d+)$/.exec(field);
  if (indexed) return node[indexed[1]]?.[Number(indexed[2])] !== undefined;
  if (field === "stroke" || field === "strokeWidth") {
    return Array.isArray(node.strokes) && node.strokes.length > 0;
  }
  return true;
}

// Penpot's gap keys, also accepted from older camelCase package values.
export function normalizedLayoutGap(value) {
  const { rowGap, columnGap, ...gap } = value ?? {};
  if (gap["row-gap"] === undefined && rowGap !== undefined) {
    gap["row-gap"] = rowGap;
  }
  if (gap["column-gap"] === undefined && columnGap !== undefined) {
    gap["column-gap"] = columnGap;
  }
  return gap;
}

function assign(node, field, value) {
  const paddingSide = {
    paddingBottom: "p3",
    paddingLeft: "p4",
    paddingRight: "p2",
    paddingTop: "p1",
  }[field];
  if (paddingSide) {
    node["layout-padding"] = {
      ...node["layout-padding"],
      [paddingSide]: Math.max(0, value),
    };
    return;
  }
  if (["itemSpacing", "rowGap", "columnGap"].includes(field)) {
    // Older packages used camelCase. Project the native Penpot keys so the
    // editor and renderer consume the same values, including an unbound axis.
    const gap = normalizedLayoutGap(node["layout-gap"]);
    if (field !== "columnGap") gap["row-gap"] = Math.max(0, value);
    if (field !== "rowGap") gap["column-gap"] = Math.max(0, value);
    node["layout-gap"] = gap;
    return;
  }
  if (field === "fill") {
    node.fills = [{ color: value, type: "solid" }];
    return;
  }
  const side = { strokeWidthTop: "widthTop", strokeWidthRight: "widthRight", strokeWidthBottom: "widthBottom", strokeWidthLeft: "widthLeft" }[field];
  if (side) {
    if (!Array.isArray(node.strokes) || node.strokes.length === 0)
      fail("missing_token_binding_target", `Token binding target is missing: ${field}`, { field, nodeId: node.id });
    node.strokes = node.strokes.map((stroke) => ({ ...stroke, [side]: Math.max(0, numeric(value)) }));
    return;
  }
  if (field === "strokeWidth") {
    if (!Array.isArray(node.strokes) || node.strokes.length === 0) {
      fail(
        "missing_token_binding_target",
        `Token binding target is missing: ${field}`,
        { field, nodeId: node.id },
      );
    }
    node.strokes = node.strokes.map((stroke) => ({
      ...stroke,
      width: value,
    }));
    return;
  }
  // stroke binds the first stroke's color, strokes.N one stroke's color;
  // width, alignment and style stay the node's own.
  const strokeMatch = field === "stroke" ? [field, "0"]
    : /^strokes\.(\d+)$/.exec(field);
  if (strokeMatch) {
    const index = Number(strokeMatch[1]);
    const strokes = structuredClone(node.strokes ?? []);
    if (!strokes[index]) {
      fail("missing_token_binding_target", `Token binding target is missing: ${field}`, {
        field,
        nodeId: node.id,
      });
    }
    strokes[index] = { ...strokes[index], color: value, type: "solid" };
    node.strokes = strokes;
    return;
  }
  const fillMatch = /^fills\.(\d+)$/.exec(field);
  if (fillMatch) {
    const index = Number(fillMatch[1]);
    const fills = structuredClone(node.fills ?? []);
    if (!fills[index]) {
      fail("missing_token_binding_target", `Token binding target is missing: ${field}`, {
        field,
        nodeId: node.id,
      });
    }
    fills[index] = { ...fills[index], color: value, type: "solid" };
    node.fills = fills;
    return;
  }
  if (field === "typography") {
    node.textStyle = { ...(node.textStyle ?? {}), ...structuredClone(value) };
    return;
  }
  if (["fontFamily", "fontSize", "fontWeight"].includes(field)) {
    node.textStyle = { ...(node.textStyle ?? {}), [field]: value };
    return;
  }
  const corner = CORNER_FIELDS.indexOf(field);
  if (corner >= 0) {
    const radii = typeof node.cornerRadius === "number"
      ? [node.cornerRadius, node.cornerRadius, node.cornerRadius, node.cornerRadius]
      : Array.isArray(node.cornerRadius) ? [...node.cornerRadius] : [0, 0, 0, 0];
    radii[corner] = Math.max(0, numeric(value));
    node.cornerRadius = radii;
    return;
  }
  const sizeLimit = { minWidth: "layout-item-min-w", maxWidth: "layout-item-max-w", minHeight: "layout-item-min-h", maxHeight: "layout-item-max-h" }[field];
  if (sizeLimit) {
    node[sizeLimit] = Math.max(0, numeric(value));
    return;
  }
  const margin = { marginTop: "m1", marginRight: "m2", marginBottom: "m3", marginLeft: "m4" }[field];
  if (margin) {
    node["layout-item-margin"] = { ...node["layout-item-margin"], [margin]: numeric(value) };
    node["layout-item-margin-type"] = "multiple";
    return;
  }
  if (["letterSpacing", "textTransform", "textDecoration"].includes(field)) {
    node.textStyle = { ...(node.textStyle ?? {}), [field]: field === "letterSpacing" ? numeric(value) : String(value) };
    return;
  }
  if (field === "lineHeight") {
    node.textStyle = { ...(node.textStyle ?? {}), lineHeight: lineHeightOf(value, node.textStyle?.fontSize) };
    return;
  }
  if (field === "rotation" || field === "x" || field === "y") {
    node[field] = numeric(value);
    return;
  }
  if (field === "text") {
    node.text = String(value);
    if (Array.isArray(node.textBlocks)) node.textBlocks = textBlocksFor(node.textBlocks, node.text);
    return;
  }
  if (field === "visible") {
    node.visible = value === true || value === "true";
    return;
  }
  node[field] = structuredClone(value);
}

const CORNER_FIELDS = ["radiusTopLeft", "radiusTopRight", "radiusBottomRight", "radiusBottomLeft"];

// Penpot writes lengths as numbers or strings such as "16" and "16px".
function numeric(value) {
  return typeof value === "number" ? value : Number.parseFloat(value) || 0;
}

// Line height is a multiplier of the font size: 1.5, "150%", or "24px".
function lineHeightOf(value, fontSize) {
  if (typeof value === "string" && value.trim().endsWith("%")) return Number.parseFloat(value) / 100;
  if (typeof value === "string" && value.trim().endsWith("px") && fontSize) return Number.parseFloat(value) / fontSize;
  return numeric(value);
}

// A string Token replaces the whole text; every paragraph keeps the first
// run's style.
function textBlocksFor(blocks, text) {
  const [first] = blocks;
  const run = first?.runs?.[0] ?? {};
  return text.split("\n").map((line) => ({
    ...(first?.textStyle ? { textStyle: structuredClone(first.textStyle) } : {}),
    runs: [{ ...structuredClone(run), text: line }],
  }));
}

// Resolves a copy's own Token bindings (the references in an Instance
// tokenBindings override) onto the node, after its value overrides, so a
// bound field follows its Token. The merged bindings stay on the node.
export function resolveOverrideBindings(node, diff, product, options = {}) {
  const own = Object.fromEntries(Object.entries(diff ?? {}).filter(([, reference]) => reference));
  if (!Object.keys(own).length) return node;
  const { tokenBindings, ...resolved } = applyEffectiveTokenBindings({ ...node, tokenBindings: own }, product, options);
  Object.assign(node, resolved);
  return node;
}

// A Token by name in the Package, its Foundation or a library.
function tokenByName(product, options, name) {
  for (const snapshot of [product, options.foundation, ...(options.libraries ?? [])]) {
    for (const token of snapshot?.domain?.tokens?.values() ?? [])
      if (token.path === name) return { assetId: token.id, packageId: snapshot.manifest.packageId };
  }
  return undefined;
}

export function applyEffectiveTokenBindings(nodeValue, product, options = {}) {
  const node = structuredClone(nodeValue);
  // Applied Token names written by the App before it stored bindings bind
  // the same fields; an explicit binding wins.
  const legacy = {};
  for (const [field, name] of Object.entries(appliedTokenFields(node.appliedTokens))) {
    if (node.tokenBindings?.[field]) continue;
    const reference = tokenByName(product, options, name);
    if (reference) legacy[field] = reference;
  }
  // itemSpacing binds both axes; a binding on one axis takes precedence.
  const bindings = Object.entries({ ...legacy, ...(node.tokenBindings ?? {}) }).sort(
    // Whole-box bindings first, so a per-axis or per-corner one wins.
    ([left], [right]) =>
      (["itemSpacing", "cornerRadius"].includes(left) ? 0 : 1) - (["itemSpacing", "cornerRadius"].includes(right) ? 0 : 1),
  );
  for (const [field, reference] of bindings) {
    const effective = resolveEffectiveToken(product, reference, options);
    if (!effective) {
      fail("missing_token", `Token not found: ${reference.assetId}`, {
        field,
        nodeId: node.id,
        path: `${node.id}.tokenBindings.${field}`,
        reference,
      });
    }
    if (!compatible(field, effective.token)) {
      fail(
        "binding_type_mismatch",
        `Token type ${effective.token.type} cannot bind to ${field}`,
        {
          field,
          nodeId: node.id,
          path: `${node.id}.tokenBindings.${field}`,
          tokenId: effective.token.id,
          tokenType: effective.token.type,
        },
      );
    }
    assign(node, field, effective.value);
  }
  return node;
}

export function projectEffectiveSnapshot(product, options = {}) {
  const foundation = options.foundation;
  const libraries = options.libraries ?? [];
  const context = resolveContext(product, foundation, options.context ?? {});
  const entries = structuredClone(product.entries);
  for (const entry of product.manifest.entries.screens) {
    for (const presentation of entries[entry].presentations) {
      for (const [nodeId, node] of Object.entries(presentation.nodes)) {
        presentation.nodes[nodeId] = applyEffectiveTokenBindings(node, product, {
          context,
          foundation,
          libraries,
        });
      }
    }
  }
  for (const entry of product.manifest.entries.components) {
    for (const set of entries[entry].componentSets ?? []) {
      for (const variant of set.variants ?? []) {
        for (const [nodeId, node] of Object.entries(variant.nodes)) {
          variant.nodes[nodeId] = applyEffectiveTokenBindings(node, product, {
            context, foundation, libraries,
          });
        }
      }
    }
  }
  return {
    ...product,
    domain: product.domain,
    entries,
    projection: { context },
  };
}
