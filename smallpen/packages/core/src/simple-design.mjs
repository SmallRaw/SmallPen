// Name-based component, page and link writes. An agent describes a tree of
// named elements with plain values or "{token.path}" references; these
// planners build the canonical node tables, IDs, child order, flex layout
// fields and Token bindings, and return one whole put-component-set or
// put-screen operation, or an interaction intent.
import { findComponent, findElement, findPage, findPageElement, findPresentation, findVariant } from "./named-targets.mjs";
import { fail } from "./errors.mjs";
import { listEffectiveTokens } from "./effective-tokens.mjs";
import { defaultTokenWorkspace, listTokenThemes, selectTokenThemes } from "./token-themes.mjs";

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const TOKEN_REF = /^\{([^{}]+)\}$/;

// IDs keep the ASCII letters of a name. A name with other letters (Chinese,
// accented, ...) adds a short hash of the whole name, so "标题" and "正文"
// get different, stable IDs.
export function slug(text) {
  const name = String(text);
  const ascii = name.normalize("NFKD").toLowerCase()
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!/[^\x00-\x7f]/.test(name)) return ascii || "x";
  // FNV-1a, 32 bits: deterministic and synchronous.
  let hash = 0x811c9dc5;
  for (const unit of new TextEncoder().encode(name)) hash = Math.imul(hash ^ unit, 0x01000193) >>> 0;
  return [ascii, `u${hash.toString(16).padStart(8, "0")}`].filter(Boolean).join("_");
}

const sameName = (left, right) => String(left).toLowerCase() === String(right).toLowerCase();

// prefix + base, or base_2, base_3, ... when another object holds that id
// (a renamed page or component keeps its first id).
export function freeId(prefix, base, taken) {
  let id = `${prefix}${base}`;
  for (let suffix = 2; taken.has(id); suffix += 1) id = `${prefix}${base}_${suffix}`;
  return id;
}

const defaultName = (spec) => spec.name ?? (spec.use ? spec.use : spec.text ? String(spec.text).slice(0, 24) : "Group");

// Siblings never share a name, so every element can be found by name. An
// element named twice is an error; unnamed ones (named after their text or
// component) are numbered: Button, Button 2, ...
function nameSiblings(children, where) {
  const named = new Set();
  for (const child of children) {
    if (!isRecord(child) || typeof child.name !== "string") continue;
    const key = child.name.trim().toLowerCase();
    if (named.has(key))
      fail("duplicate_name", `Two elements in ${where || "the root"} are named ${child.name}; sibling names do not repeat`, {
        kind: "element", name: child.name, hint: `Name them apart, for example "${child.name} 1" and "${child.name} 2"`,
      });
    named.add(key);
  }
  const used = new Set(named);
  return children.map((child) => {
    if (!isRecord(child) || typeof child.name === "string") return child;
    const base = defaultName(child);
    let name = base;
    for (let suffix = 2; used.has(name.toLowerCase()); suffix += 1) name = `${base} ${suffix}`;
    used.add(name.toLowerCase());
    return name === base ? child : { ...child, name };
  });
}

// Tokens by path across the Package and its Foundation. A string Token
// also carries its value under every theme option (its translations), so
// a text bound to it is sized for the longest one.
function tokenIndex(snapshot, options) {
  const index = new Map();
  for (const item of listEffectiveTokens(snapshot, { foundation: options.foundation, libraries: options.libraries }))
    if (!index.has(item.token.path)) index.set(item.token.path, item);
  const strings = [...index.values()].filter((item) => item.token.type === "string");
  if (strings.length) {
    const workspace = defaultTokenWorkspace({ product: snapshot, foundation: options.foundation });
    for (const theme of listTokenThemes(snapshot, options.foundation)) {
      const selected = selectTokenThemes(workspace, [theme.path]);
      for (const item of listEffectiveTokens(selected.product, { foundation: selected.foundation, libraries: options.libraries })) {
        const entry = index.get(item.token.path);
        if (entry?.token.type !== "string") continue;
        (entry.translations ??= new Set([String(entry.value)])).add(String(item.value));
      }
    }
  }
  return index;
}

// The widest of a string Token's values, by a rough width: CJK and other
// wide characters count twice.
function widestText(texts) {
  const width = (text) => [...text].reduce((sum, char) => sum + (char.codePointAt(0) > 0x2e7f ? 2 : 1), 0);
  return [...texts].reduce((best, text) => (width(text) > width(best) ? text : best), "");
}

// Component Sets by name (or id) across the Package and its Foundation.
function componentIndex(snapshot, options) {
  const sets = [];
  for (const owner of [snapshot, options.foundation, ...(options.libraries ?? [])]) {
    if (!owner) continue;
    for (const set of owner.domain.componentSets.values())
      sets.push({ owner, set });
  }
  return (name) => {
    const matches = sets.filter(({ set }) => set.id === name || sameName(set.name, name));
    if (matches.length === 0)
      fail("unknown_component", `No component named ${name}`, { components: sets.map(({ set }) => set.name) });
    if (matches.length > 1 && !matches.every(({ set }) => set.id === matches[0].set.id))
      fail("ambiguous_component", `Several components are named ${name}; use its id`, {
        candidates: matches.map(({ owner, set }) => ({ id: set.id, packageId: owner.manifest.packageId })),
      });
    return matches[0];
  };
}

const LAYOUT_KEYS = new Set([
  "name", "type", "text", "children", "use", "props", "set", "width", "height", "x", "y",
  "layout", "gap", "padding", "align", "justify", "fill", "stroke", "radius", "opacity",
  "shadow", "visible", "color", "font", "fontSize", "fontWeight", "lineHeight", "textAlign",
  "wrap", "ellipse", "rotation", "media", "description",
  "fontFamily", "margin", "minWidth", "maxWidth", "place", "minHeight", "maxHeight", "letterSpacing", "textTransform", "textDecoration",
]);

// Values: literals pass through; "{path}" binds the Token and stores its
// current value. Returns [value, reference|undefined].
function resolveValue(raw, tokens, where) {
  if (typeof raw === "string") {
    const match = TOKEN_REF.exec(raw.trim());
    if (match) {
      const item = tokens.get(match[1]);
      if (!item) fail("unknown_token", `No Token ${match[1]} (at ${where})`, {
        suggestions: [...tokens.keys()].filter((path) => path.includes(match[1].split(".").at(-1))).slice(0, 5),
      });
      return [item.value, { assetId: item.target.assetId, packageId: item.target.packageId }];
    }
  }
  return [raw, undefined];
}

// What a page may set on an element of a placed component, by element name:
// the field it overrides and the Token binding a {token} value becomes.
const textStyleSetting = (key, binding, cast = Number) => ({
  binding,
  field: "textStyle",
  value: (value, target, current) => ({ ...(current ?? target.textStyle ?? {}), [key]: cast(value) }),
});
const INSTANCE_SETTINGS = {
  text: { binding: "text", field: "text", value: (value) => String(value) },
  visible: { binding: "visible", field: "visible", value: (value) => value === true || value === "true" },
  opacity: { binding: "opacity", field: "opacity", value: Number },
  fill: { binding: "fill", field: "fills", value: (value) => [paintOf(value)] },
  color: { binding: "fill", field: "fills", value: (value) => [paintOf(value)] },
  name: { binding: "name", field: "name", value: String },
  stroke: {
    binding: "stroke",
    field: "strokes",
    value: (value, target, current) => {
      const strokes = structuredClone(current ?? target.strokes ?? [{ alignment: "inner", type: "solid", width: 1 }]);
      strokes[0] = { ...strokes[0], color: paintOf(value).color, type: "solid" };
      return strokes;
    },
  },
  radius: { binding: "cornerRadius", field: "cornerRadius", value: Number },
  width: { binding: "width", field: "width", value: sizeNumber("width") },
  height: { binding: "height", field: "height", value: sizeNumber("height") },
  shadow: { binding: "shadow", field: "shadow", value: (value) => structuredClone(value) },
  fontSize: textStyleSetting("fontSize", "fontSize"),
  fontWeight: textStyleSetting("fontWeight", "fontWeight"),
  fontFamily: textStyleSetting("fontFamily", "fontFamily", (value) => String(Array.isArray(value) ? value[0] : value)),
  letterSpacing: textStyleSetting("letterSpacing", "letterSpacing"),
  lineHeight: textStyleSetting("lineHeight", "lineHeight"),
  props: {},
};

// Text takes a string Token and visibility a boolean one.
const VALUE_TOKEN_TYPES = { text: "string", visible: "boolean" };
function checkValueToken(field, raw, tokens, where) {
  const expected = VALUE_TOKEN_TYPES[field];
  const path = typeof raw === "string" ? TOKEN_REF.exec(raw.trim())?.[1] : undefined;
  const type = path ? tokens.get(path)?.token.type : undefined;
  if (expected && type && type !== expected)
    fail("binding_type_mismatch", `${field} needs a ${expected} Token; ${path} is ${type} (at ${where})`);
}

function paintOf(value) {
  if (typeof value === "string" && /^#[0-9a-f]{8}$/i.test(value))
    return { color: value.slice(0, 7), opacity: parseInt(value.slice(7, 9), 16) / 255, type: "solid" };
  if (typeof value === "string") return { color: value, type: "solid" };
  if (isRecord(value) && value.colorSpace) {
    const byte = (channel) => Math.round(channel * 255).toString(16).padStart(2, "0");
    return { color: `#${value.components.map(byte).join("")}`, ...(value.alpha < 1 ? { opacity: value.alpha } : {}), type: "solid" };
  }
  return { color: String(value), type: "solid" };
}

function sizeSpec(value) {
  if (value === undefined || value === null) return { mode: "auto" };
  if (typeof value === "number") return { mode: "fix", value };
  const text = String(value).trim().toLowerCase();
  if (text === "fill" || text === "100%") return { mode: "fill" };
  if (text === "hug" || text === "auto") return { mode: "auto" };
  const number = Number(text.replace(/px$/, ""));
  if (Number.isFinite(number)) return { mode: "fix", value: number };
  fail("invalid_size", `Size ${value} is not a number, "fill", "100%" or "hug"`);
}

function boxOf(raw, tokens, where, field = "padding") {
  // padding / margin: n | [vertical, horizontal] | [top, right, bottom,
  // left]; each a number or a Token.
  const list = Array.isArray(raw) ? raw : [raw];
  const sides = list.length === 1 ? [list[0], list[0], list[0], list[0]]
    : list.length === 2 ? [list[0], list[1], list[0], list[1]]
      : list.length === 4 ? list : fail(`invalid_${field}`, `${field} at ${where} takes 1, 2 or 4 values`);
  return sides.map((side, index) => resolveValue(side, tokens, `${where}.${field}[${index}]`));
}

// Applies "Child.Grandchild.prop" settings to a spec tree (variants, page
// instances). Unknown paths fail with the names that exist.
export function applySettings(spec, settings, where) {
  const result = structuredClone(spec);
  for (const [key, value] of Object.entries(settings ?? {})) {
    const parts = key.split(".");
    const prop = parts.pop();
    let node = result;
    for (const name of parts) {
      const child = (node.children ?? []).find((candidate) => sameName(candidate.name, name));
      if (!child)
        fail("unknown_element", `No element ${name} in ${where} for ${key}`, {
          children: (node.children ?? []).map((candidate) => candidate.name),
        });
      node = child;
    }
    node[prop] = value;
  }
  return result;
}

class TreeBuilder {
  constructor(prefix, tokens, components) {
    this.prefix = prefix;
    this.tokens = tokens;
    this.components = components;
    this.nodes = {};
    this.probes = {};
    this.widen = [];
    this.used = new Set();
    // Texts bound to string Tokens, measured with their longest translation.
    this.measureTexts = {};
  }

  id(path) {
    let id = `node_${this.prefix}_${path.map(slug).join("_")}`.slice(0, 120);
    let suffix = 2;
    while (this.used.has(id)) id = `${id.replace(/_\d+$/, "")}_${suffix++}`;
    this.used.add(id);
    return id;
  }

  // spec -> node id; parentFlex says whether a flex parent will place it.
  build(spec, path, parentFlex, root = false, parentJustify = undefined, textFills = false) {
    if (!isRecord(spec)) fail("invalid_element", `Element at ${path.join(" › ") || "root"} must be an object`);
    for (const key of Object.keys(spec))
      if (!LAYOUT_KEYS.has(key))
        fail("unknown_element_field", `Unknown field ${key} at ${path.join(" › ") || "root"}`, { allowedFields: [...LAYOUT_KEYS] });
    const name = defaultName(spec);
    const here = [...path, name];
    const where = here.join(" › ");
    // A redrawn page keeps its root board, so links, starts and Scenarios
    // that point at it stay valid.
    const id = root && this.rootId ? this.rootId : this.id(root ? ["root"] : here);
    if (root && this.rootId) this.used.add(id);
    const bindings = {};
    const node = { children: [], id, name, x: spec.x ?? 0, y: spec.y ?? 0 };
    const bind = (field, raw, apply) => {
      const [value, reference] = resolveValue(raw, this.tokens, `${where}.${field}`);
      if (reference) {
        checkValueToken(field, raw, this.tokens, `${where}.${field}`);
        bindings[field] = reference;
      }
      apply(value);
    };
    // The one text of a row grows with its row unless it says otherwise, so
    // a longer label in a widened instance still fits. Several texts in a
    // row hug, so one never squeezes the other into extra lines.
    const isText = !spec.use && (typeof spec.text === "string" || spec.type === "text");
    const width = sizeSpec(spec.width ?? (parentFlex === "row" && isText && textFills ? "fill" : undefined));
    const height = sizeSpec(spec.height);
    node._size = { width, height };
    // Where the element goes in a container without auto layout: its own
    // x/y, a place next to a sibling, or the next free spot (CLI decides).
    node._place = spec.x !== undefined || spec.y !== undefined ? { fixed: true } : placeOf(spec.place, where);
    if (width.mode === "fix") node.width = width.value;
    if (height.mode === "fix") node.height = height.value;
    if (parentFlex) {
      node["layout-item-h-sizing"] = width.mode;
      node["layout-item-v-sizing"] = height.mode;
    }
    if (spec.use) {
      this.instance(spec, node, where);
    } else if (spec.text !== undefined || spec.type === "text") {
      node.type = "TEXT";
      // "{text.path}" binds a string Token: the text follows its language,
      // and its box is sized for the longest translation.
      bind("text", spec.text ?? "", (value) => { node.text = String(value); });
      if (bindings.text) {
        const translations = [...this.tokens.values()].find((item) => item.token.id === bindings.text.assetId)?.translations;
        if (translations?.size > 1) node._measureText = this.measureTexts[id] = widestText(translations);
      }
      node.growType = width.mode === "auto" ? "auto-width" : "auto-height";
      const textStyle = {};
      if (spec.font !== undefined)
        bind("typography", spec.font, (value) => Object.assign(textStyle, isRecord(value) ? value : {}));
      // A font imported into the package, by family name or font-family Token.
      if (spec.fontFamily !== undefined)
        bind("fontFamily", spec.fontFamily, (value) => { textStyle.fontFamily = String(Array.isArray(value) ? value[0] : value); });
      if (spec.fontSize !== undefined) bind("fontSize", spec.fontSize, (value) => { textStyle.fontSize = Number(value); });
      if (spec.fontWeight !== undefined) bind("fontWeight", spec.fontWeight, (value) => { textStyle.fontWeight = Number(value); });
      if (spec.lineHeight !== undefined) bind("lineHeight", spec.lineHeight, (value) => { textStyle.lineHeight = Number(value); });
      if (spec.letterSpacing !== undefined) bind("letterSpacing", spec.letterSpacing, (value) => { textStyle.letterSpacing = Number(value); });
      if (spec.textTransform !== undefined) bind("textTransform", spec.textTransform, (value) => { textStyle.textTransform = String(value); });
      if (spec.textDecoration !== undefined) bind("textDecoration", spec.textDecoration, (value) => { textStyle.textDecoration = String(value); });
      if (spec.textAlign !== undefined) textStyle.textAlign = spec.textAlign;
      // A text that fills a centred row by default is centred in it, as a
      // button label is.
      else if (spec.width === undefined && textFills && parentJustify === "center") textStyle.textAlign = "center";
      if (Object.keys(textStyle).length) node.textStyle = textStyle;
      const color = spec.color ?? spec.fill;
      if (color !== undefined) bind("fill", color, (value) => { node.fills = [paintOf(value)]; });
    } else {
      const children = spec.children ?? [];
      node.type = root ? (spec.type === "component" ? "COMPONENT" : "FRAME")
        : spec.ellipse || spec.type === "ellipse" ? "ELLIPSE"
          : children.length || spec.layout || spec.type === "frame" ? "FRAME" : "RECTANGLE";
      if (spec.fill !== undefined) bind("fill", spec.fill, (value) => { node.fills = [paintOf(value)]; });
      else if (node.type === "FRAME" || node.type === "COMPONENT") node.fills = [];
      const layout = spec.layout ?? (children.length ? "column" : undefined);
      if (layout && layout !== "none") {
        node.layout = "flex";
        node["layout-flex-dir"] = layout === "row" ? "row" : "column";
        if (spec.gap !== undefined)
          bind("itemSpacing", spec.gap, (value) => { node["layout-gap"] = { "column-gap": Number(value), "row-gap": Number(value) }; });
        if (spec.padding !== undefined) {
          const sides = boxOf(spec.padding, this.tokens, where);
          node["layout-padding-type"] = "multiple";
          node["layout-padding"] = { p1: Number(sides[0][0]), p2: Number(sides[1][0]), p3: Number(sides[2][0]), p4: Number(sides[3][0]) };
          ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].forEach((field, index) => {
            if (sides[index][1]) bindings[field] = sides[index][1];
          });
        }
        if (spec.align !== undefined) node["layout-align-items"] = spec.align;
        if (spec.justify !== undefined) node["layout-justify-content"] = spec.justify;
      }
      const flex = node.layout === "flex" ? node["layout-flex-dir"] : false;
      if (!flex && spec.gap !== undefined) node._gap = Number(spec.gap);
      const named = nameSiblings(children, where);
      const isTextSpec = (child) => isRecord(child) && !child.use && (typeof child.text === "string" || child.type === "text");
      const sized = (child) => isRecord(child) && child.width !== undefined;
      const fills = (child) => isRecord(child) && ["fill", "100%"].includes(String(child.width).trim().toLowerCase());
      const loneText = flex === "row" && !named.some(fills) && named.filter((child) => isTextSpec(child) && !sized(child)).length === 1
        && named.filter(isTextSpec).length === 1;
      const ids = named.map((child) => this.build(child, here, flex, false, spec.justify, loneText && isTextSpec(child) && !sized(child)));
      // Penpot lays a flex line out from the last child: store the reverse
      // so the elements read in the order they were written.
      node.children = flex ? [...ids].reverse() : ids;
    }
    if (spec.stroke !== undefined) {
      const stroke = isRecord(spec.stroke) ? spec.stroke : { color: spec.stroke };
      const paint = { alignment: stroke.align ?? "inner", type: "solid", width: 1 };
      if (stroke.color !== undefined) bind("stroke", stroke.color, (value) => { paint.color = paintOf(value).color; });
      if (Array.isArray(stroke.width)) {
        // [top, right, bottom, left], each a width or a Token.
        if (stroke.width.length !== 4) fail("invalid_stroke", `stroke width at ${where} takes one value or four sides`);
        ["Top", "Right", "Bottom", "Left"].forEach((side, index) => {
          const [value, reference] = resolveValue(stroke.width[index], this.tokens, `${where}.stroke.width[${index}]`);
          if (reference) bindings[`strokeWidth${side}`] = reference;
          paint[`width${side}`] = Number(value);
        });
        paint.width = Math.max(...["Top", "Right", "Bottom", "Left"].map((side) => paint[`width${side}`]));
      } else if (stroke.width !== undefined) bind("strokeWidth", stroke.width, (value) => { paint.width = Number(value); });
      if (stroke.style) paint.style = stroke.style;
      node.strokes = [paint];
    }
    if (Array.isArray(spec.radius)) {
      // [top-left, top-right, bottom-right, bottom-left], each a value or a Token.
      if (spec.radius.length !== 4) fail("invalid_radius", `radius at ${where} takes one value or four corners`);
      node.cornerRadius = spec.radius.map((corner, index) => {
        const field = ["radiusTopLeft", "radiusTopRight", "radiusBottomRight", "radiusBottomLeft"][index];
        const [value, reference] = resolveValue(corner, this.tokens, `${where}.radius[${index}]`);
        if (reference) bindings[field] = reference;
        return Number(value);
      });
    } else if (spec.radius !== undefined) bind("cornerRadius", spec.radius, (value) => { node.cornerRadius = value; });
    if (spec.margin !== undefined) {
      const sides = boxOf(spec.margin, this.tokens, where, "margin");
      node["layout-item-margin-type"] = "multiple";
      node["layout-item-margin"] = { m1: Number(sides[0][0]), m2: Number(sides[1][0]), m3: Number(sides[2][0]), m4: Number(sides[3][0]) };
      ["marginTop", "marginRight", "marginBottom", "marginLeft"].forEach((field, index) => {
        if (sides[index][1]) bindings[field] = sides[index][1];
      });
    }
    for (const [field, key] of [["minWidth", "layout-item-min-w"], ["maxWidth", "layout-item-max-w"], ["minHeight", "layout-item-min-h"], ["maxHeight", "layout-item-max-h"]])
      if (spec[field] !== undefined) bind(field, spec[field], (value) => { node[key] = Number(value); });
    if (spec.opacity !== undefined) bind("opacity", spec.opacity, (value) => { node.opacity = Number(value); });
    if (spec.shadow !== undefined) bind("shadow", spec.shadow, (value) => { node.shadow = value; });
    // "{flag.path}" binds a boolean Token: shown or hidden per theme option.
    if (spec.visible !== undefined)
      bind("visible", spec.visible, (value) => {
        if (value === false || value === "false") node.visible = false;
      });
    if (spec.rotation !== undefined) bind("rotation", spec.rotation, (value) => { node.rotation = Number(value); });
    if (Object.keys(bindings).length) node.tokenBindings = bindings;
    this.nodes[id] = node;
    return id;
  }

  instance(spec, node, where) {
    const { owner, set } = this.components(spec.use);
    const selection = {};
    for (const [property, value] of Object.entries(spec.props ?? {})) {
      const axis = (set.axes ?? []).find((candidate) => sameName(candidate.name, property) || candidate.id === property);
      if (!axis)
        fail("unknown_property", `${set.name} has no property ${property} (at ${where})`, {
          properties: (set.axes ?? []).map((candidate) => candidate.name),
        });
      const choice = (axis.domain ?? []).find((candidate) => sameName(candidate, value));
      if (choice === undefined)
        fail("unknown_property_value", `${set.name} ${axis.name} has no value ${value} (at ${where})`, { values: axis.domain });
      selection[axis.id] = choice;
    }
    const variant = set.variants.find((candidate) =>
      Object.entries(selection).every(([axis, value]) => candidate.selection?.[axis] === value)) ?? set.variants[0];
    const full = Object.fromEntries((set.axes ?? []).map((axis) => [axis.id, selection[axis.id] ?? variant.selection?.[axis.id]]));
    const source = variant.nodes[variant.rootId];
    node.type = "INSTANCE";
    node.instance = {
      component: { assetId: set.id, packageId: owner.manifest.packageId },
      variant: full,
      overrides: {},
    };
    if (node.width === undefined) node.width = source.width;
    if (node.height === undefined) node.height = source.height;
    // text: {"Label": "Save"}; set: {"Icon.visible": false} -> overrides by
    // the component's own node names.
    // An element of the component: by its whole name (a name may hold a
    // "."), by a dotted path from the root ("Info.Title"), or by a name only
    // one element below has ("Title").
    const named = (name) => Object.values(variant.nodes).filter((candidate) => candidate.id !== variant.rootId && sameName(candidate.name, name));
    const pathOf = (target) => {
      const parentOf = (id) => Object.values(variant.nodes).find((candidate) => candidate.children?.includes(id));
      const names = [];
      for (let at = target; at && at.id !== variant.rootId; at = parentOf(at.id)) names.unshift(at.name);
      return names.join(".");
    };
    const byName = (path) => {
      if (!path) return source;
      const whole = named(path);
      if (whole.length === 1) return whole[0];
      let current = source;
      for (const name of path.split(".")) {
        current = current && (current.children ?? []).map((childId) => variant.nodes[childId])
          .find((candidate) => candidate && sameName(candidate.name, name));
      }
      if (current) return current;
      const last = named(path.split(".").at(-1));
      if (last.length === 1) return last[0];
      fail(last.length > 1 ? "ambiguous_element" : "unknown_element",
        last.length > 1
          ? `${set.name} has several elements named ${path.split(".").at(-1)}; name its parent too, for example "${pathOf(last[0])}" (at ${where})`
          : `${set.name} has no element ${path} (at ${where})`,
        { elements: Object.values(variant.nodes).filter((candidate) => candidate.id !== variant.rootId).map(pathOf) });
    };
    const settings = { ...Object.fromEntries(Object.entries(spec.text ?? {}).map(([path, value]) => [`${path}.text`, value])), ...(spec.set ?? {}) };
    if (typeof spec.text === "string") fail("invalid_instance_text", `text on an instance maps element names to text, for example {"Label": "Save"} (at ${where})`);
    // Each setting writes the copy's own value; a Token also becomes the
    // copy's own binding (a tokenBindings override), as when the App applies
    // a Token to a copy child.
    const own = new Map();
    for (const [key, raw] of Object.entries(settings)) {
      const parts = key.split(".");
      const field = parts.pop();
      const target = byName(parts.join("."));
      const setting = INSTANCE_SETTINGS[field];
      if (!setting)
        fail("unsupported_instance_override", `An instance can set ${Object.keys(INSTANCE_SETTINGS).join(", ")}, not ${field} (at ${where})`);
      if (field === "props") {
        // Switches a nested copy's variant: {"Icon.props": {"Size": "sm"}}.
        if (!target.instance)
          fail("unsupported_instance_override", `${parts.join(".")} is not a nested component (at ${where})`);
        const nested = this.components(target.instance.component.assetId);
        const selection = {};
        for (const [property, choice] of Object.entries(raw ?? {})) {
          const axis = (nested.set.axes ?? []).find((candidate) => sameName(candidate.name, property));
          const value = axis?.domain.find((candidate) => sameName(candidate, choice));
          if (value === undefined)
            fail("unknown_property_value", `${nested.set.name} has no ${property}=${choice} (at ${where})`, {
              properties: (nested.set.axes ?? []).map((candidate) => `${candidate.name}: ${candidate.domain.join("|")}`),
            });
          selection[axis.id] = value;
        }
        node.instance.overrides[`${target.id}:variant`] = selection;
        continue;
      }
      const [value, reference] = resolveValue(raw, this.tokens, `${where}.${key}`);
      if (reference) {
        checkValueToken(setting.binding, raw, this.tokens, `${where}.${key}`);
        if (!own.has(target.id)) own.set(target.id, {});
        own.get(target.id)[setting.binding] = reference;
      }
      const path = `${target.id}:${setting.field}`;
      node.instance.overrides[path] = setting.value(value, target, node.instance.overrides[path]);
      // A value written over a field the component binds to a Token stops
      // following it (null drops the source's binding).
      if (!reference && target.tokenBindings?.[setting.binding]) {
        if (!own.has(target.id)) own.set(target.id, {});
        own.get(target.id)[setting.binding] = null;
      }
      // A longer text in a growing slot widens the instance by the extra
      // width the new text measures.
      // A text that fills or hugs its slot grows with a longer text (one
      // that wraps at a fixed width does not): the copy widens by the extra,
      // and a hugging text takes its new width.
      // A one-line text in a fixed box (a component drawn without auto
      // layout) widens with its box and the elements around it.
      const lineHeight = (target.textStyle?.fontSize ?? 14) * (target.textStyle?.lineHeight ?? 1.2);
      const oneLineFixed = (target.growType === undefined || target.growType === "fixed") && target.height <= lineHeight * 1.6;
      const grows = ["fill", "auto"].includes(target["layout-item-h-sizing"]) || target.growType === "auto-width" || oneLineFixed;
      // A copy that fills or has a fixed width cannot grow: a longer text
      // there shows as content_overflow instead.
      if (setting.field === "text" && grows && node._size.width.mode === "auto") {
        const probe = `${node.id}::${target.id}`;
        const translations = reference ? [...this.tokens.values()].find((item) => item.token.id === reference.assetId)?.translations : undefined;
        const longest = translations?.size > 1 ? widestText(translations) : String(value);
        this.probes[probe] = { children: [], growType: "auto-width", height: target.height, id: probe, name: "probe", text: longest, textStyle: target.textStyle, type: "TEXT", width: target.width, x: 0, y: 0 };
        // Elements between the copy and the text that hug their content
        // grow with it too; one that fills takes the copy's new width.
        const parentOf = (id) => Object.values(variant.nodes).find((candidate) => candidate.children?.includes(id));
        const grow = target["layout-item-h-sizing"] === "fill" ? [] : [{ id: target.id, width: target.width }];
        for (let at = parentOf(target.id); at && at.id !== variant.rootId; at = parentOf(at.id))
          if (at["layout-item-h-sizing"] !== "fill" && (oneLineFixed || at["layout-item-h-sizing"] !== "fix")) grow.push({ id: at.id, width: at.width });
        this.widen.push({ id: node.id, probe, slot: target.width, grow });
      }
    }
    for (const [id, bindings] of own) node.instance.overrides[`${id}:tokenBindings`] = bindings;
    if (!Object.keys(node.instance.overrides).length) delete node.instance.overrides;
  }
}

// A copy's element takes a size in pixels (or a Token): fill and hug are for
// elements you draw, where the layout can decide.
function sizeNumber(field) {
  return (value) => {
    const number = Number(value);
    if (!Number.isFinite(number))
      fail("invalid_instance_size", `A copy's element ${field} takes a number or a Token, not ${JSON.stringify(value)}; fill and hug work on elements you draw`, { field, value });
    return number;
  };
}

// Bottom-up sizes for elements that hug their content; text sizes come from
// measure(nodeId) -> {width, height} when given, else an estimate.
export function sizeDesignTree(nodes, rootId, measure = () => undefined) {
  const visit = (id) => {
    const node = nodes[id];
    const { width: w, height: h } = node._size ?? { width: { mode: "fix" }, height: { mode: "fix" } };
    if (node.type === "TEXT") {
      const fontSize = node.textStyle?.fontSize ?? 14;
      const measured = measure(id);
      // Without a measure (or a font with the glyphs), estimate: wide (CJK)
      // characters take about a full em, others about half.
      const sample = String(node._measureText ?? node.text);
      const ems = [...sample].reduce((sum, char) => sum + (char.codePointAt(0) > 0x2e7f ? 1 : 0.55), 0);
      const estimate = { width: Math.ceil(ems * fontSize) + 2, height: Math.ceil(fontSize * (node.textStyle?.lineHeight ?? 1.2)) };
      if (node.width === undefined) node.width = measured?.width ?? estimate.width;
      if (node.height === undefined || h.mode !== "fix") node.height = measured?.height ?? estimate.height;
      return;
    }
    for (const child of node.children) visit(child);
    if (node.layout === "flex") {
      const row = node["layout-flex-dir"] === "row";
      const gap = node["layout-gap"]?.["column-gap"] ?? 0;
      const pad = node["layout-padding"] ?? { p1: 0, p2: 0, p3: 0, p4: 0 };
      const kids = node.children.map((child) => nodes[child]).filter((child) => child.visible !== false);
      const main = kids.reduce((sum, child) => sum + (row ? child.width : child.height), 0) + gap * Math.max(0, kids.length - 1);
      const cross = Math.max(0, ...kids.map((child) => (row ? child.height : child.width)));
      const hugWidth = (row ? main : cross) + pad.p2 + pad.p4;
      const hugHeight = (row ? cross : main) + pad.p1 + pad.p3;
      if (node.width === undefined || w.mode === "auto") node.width = node.width ?? hugWidth;
      if (node.height === undefined || h.mode === "auto") node.height = node.height ?? hugHeight;
    } else {
      arrangeFreeChildren(node, nodes);
      const kids = node.children.map((child) => nodes[child]);
      if (node.width === undefined) node.width = Math.max(0, ...kids.map((child) => child.x + child.width));
      if (node.height === undefined) node.height = Math.max(0, ...kids.map((child) => child.y + child.height));
    }
  };
  visit(rootId);
  wrapFillTexts(nodes, rootId, measure);
  for (const node of Object.values(nodes)) {
    delete node._size;
    delete node._place;
    delete node._gap;
    delete node._measureText;
  }
  return nodes;
}

// A text that fills its slot wraps at the width the App gives it, and the
// containers that hug it grow taller. Find each slot's width top-down, take
// the text's height at that width (measure.wrapped, else lines estimated
// from its one-line width), then size hugging containers again.
function wrapFillTexts(nodes, rootId, measure) {
  let wrapped = false;
  const visit = (id, width) => {
    const node = nodes[id];
    if (node.type === "TEXT") {
      if (width === undefined || node.growType !== "auto-height" || width >= node.width - 0.5 || width <= 0) return;
      const at = measure.wrapped?.(id, width);
      const lines = Math.ceil(node.width / width);
      node.width = width;
      node.height = at?.height ?? node.height * lines;
      wrapped = true;
      return;
    }
    const own = width ?? node.width;
    const kids = node.children.map((child) => nodes[child]).filter((child) => child.visible !== false);
    if (node.layout !== "flex") {
      for (const child of kids) visit(child.id, undefined);
      return;
    }
    const pad = node["layout-padding"] ?? { p1: 0, p2: 0, p3: 0, p4: 0 };
    const inner = own - (pad.p2 ?? 0) - (pad.p4 ?? 0);
    const fills = (child) => child["layout-item-h-sizing"] === "fill" && child["layout-item-absolute"] !== true;
    if (node["layout-flex-dir"] === "row") {
      const gap = node["layout-gap"]?.["column-gap"] ?? 0;
      const fixed = kids.filter((child) => !fills(child)).reduce((sum, child) => sum + child.width, 0);
      const count = kids.filter(fills).length;
      const each = count ? (inner - fixed - gap * Math.max(0, kids.length - 1)) / count : 0;
      for (const child of kids) visit(child.id, fills(child) ? Math.floor(each) : undefined);
    } else for (const child of kids) visit(child.id, fills(child) ? inner : undefined);
  };
  visit(rootId, undefined);
  if (!wrapped) return;
  const rehug = (id) => {
    const node = nodes[id];
    if (node.type === "TEXT" || node.layout !== "flex") return;
    for (const child of node.children) rehug(child);
    if (node._size?.height?.mode !== "auto") return;
    const row = node["layout-flex-dir"] === "row";
    const gap = (row ? node["layout-gap"]?.["column-gap"] : node["layout-gap"]?.["row-gap"]) ?? node["layout-gap"]?.["column-gap"] ?? 0;
    const pad = node["layout-padding"] ?? { p1: 0, p2: 0, p3: 0, p4: 0 };
    const kids = node.children.map((child) => nodes[child]).filter((child) => child.visible !== false);
    const heights = kids.map((child) => child.height);
    const content = row ? Math.max(0, ...heights) : heights.reduce((sum, height) => sum + height, 0) + gap * Math.max(0, kids.length - 1);
    node.height = content + (pad.p1 ?? 0) + (pad.p3 ?? 0);
  };
  rehug(rootId);
}

// place: "below Header" | {below|above|leftOf|rightOf: "Sibling", gap?}.
const PLACE_SIDES = ["below", "above", "leftOf", "rightOf"];
function placeOf(raw, where) {
  if (raw === undefined) return { auto: true };
  let place = raw;
  if (typeof raw === "string") {
    const [side, ...rest] = raw.trim().split(/\s+/);
    place = { [side]: rest.join(" ") };
  }
  const side = PLACE_SIDES.find((candidate) => isRecord(place) && place[candidate] !== undefined);
  if (!side)
    fail("invalid_place", `place at ${where} is "below Name", "above Name", "leftOf Name" or "rightOf Name"`, {
      example: { place: { below: "Header", gap: 16 } },
    });
  return { side, of: String(place[side]), gap: place.gap === undefined ? undefined : Number(place.gap) };
}

const overlaps = (a, b) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// Children of a container without auto layout, in written order: an
// element's own x/y stays; a place is resolved next to its sibling; the rest
// stack below what is already placed. Nothing the CLI places overlaps: an
// element that would is pushed below what it hits.
function arrangeFreeChildren(container, nodes) {
  const gap = container._gap ?? 16;
  const kids = container.children.map((id) => nodes[id]).filter(Boolean);
  const placed = [];
  for (const kid of kids) {
    const place = kid._place ?? { fixed: true };
    if (place.side) {
      const ref = kids.find((other) => other !== kid && sameName(other.name, place.of));
      if (!ref) fail("unknown_element", `place names ${place.of}, not a sibling of ${kid.name}`, { siblings: kids.map((other) => other.name) });
      const space = place.gap ?? gap;
      if (place.side === "below") Object.assign(kid, { x: ref.x, y: ref.y + ref.height + space });
      if (place.side === "above") Object.assign(kid, { x: ref.x, y: ref.y - kid.height - space });
      if (place.side === "rightOf") Object.assign(kid, { x: ref.x + ref.width + space, y: ref.y });
      if (place.side === "leftOf") Object.assign(kid, { x: ref.x - kid.width - space, y: ref.y });
    } else if (place.auto) {
      const bottom = Math.max(0, ...placed.map((other) => other.y + other.height + gap));
      Object.assign(kid, { x: placed.length ? Math.min(...placed.map((other) => other.x)) : 0, y: placed.length ? bottom : 0 });
    }
    if (!place.fixed) {
      for (let guard = 0; guard < placed.length + 1; guard += 1) {
        const hit = placed.find((other) => other.visible !== false && overlaps(kid, other));
        if (!hit) break;
        kid.y = hit.y + hit.height + gap;
      }
    }
    placed.push(kid);
  }
  // Keep everything inside the container: a place above or left of the
  // first element shifts the whole group.
  const dx = Math.min(0, ...kids.map((kid) => kid.x));
  const dy = Math.min(0, ...kids.map((kid) => kid.y));
  if (dx < 0 || dy < 0) for (const kid of kids) Object.assign(kid, { x: kid.x - dx, y: kid.y - dy });
}

function componentTree(snapshot, spec, options, prefix, base) {
  const builder = new TreeBuilder(prefix, tokenIndex(snapshot, options), componentIndex(snapshot, options));
  const rootId = builder.build({ ...base, name: base.name ?? spec.name, type: "component" }, [], false, true);
  builder.nodes[rootId].type = "COMPONENT";
  return { builder, nodes: builder.nodes, probes: builder.probes, rootId, measureTexts: builder.measureTexts };
}

// New copies grow for longer text. Edits replace the previous text's growth,
// so retrying the same value leaves the dimensions unchanged.
function widenInstances(builder, measure) {
  for (const { id, probe, previousProbe, slot, grow = [] } of builder.widen) {
    const measured = measure?.(probe);
    const node = builder.nodes[id];
    if (!measured) continue;
    const extra = Math.max(0, Math.ceil(measured.width - slot));
    const previous = previousProbe && measure?.(previousProbe);
    const previousExtra = previous ? Math.max(0, Math.ceil(previous.width - slot)) : 0;
    const delta = extra - previousExtra;
    if (delta === 0) continue;
    node.width += delta;
    for (const element of grow) {
      node.instance.overrides ??= {};
      const key = `${element.id}:width`;
      const width = node.instance.overrides[key] ?? element.width;
      node.instance.overrides[key] = Math.max(previousProbe ? width + delta : width, element.width + extra);
    }
  }
}

export const COMPONENT_DEFINE_FIELDS = Object.freeze(["name", "properties?", "base", "variants?", "category?", "description?"]);

// define: {name, properties: {Prop: [values]}, base: element, variants:
// [{when: {Prop: value}, set: {"Child.prop": value}}]} -> put-component-set.
// Every combination of property values becomes a variant: the base with
// every matching "set" applied in order. Re-defining keeps the component id.
export function componentDefineOperation(snapshot, spec, options = {}) {
  if (!isRecord(spec) || typeof spec.name !== "string" || !isRecord(spec.base))
    fail("invalid_component_define", "Expected {name, base: element, properties?, variants?}", {
      example: {
        name: "Button",
        properties: { Style: ["primary", "secondary"] },
        base: { layout: "row", padding: [8, 16], fill: "{color.brand}", radius: 8, children: [{ name: "Label", text: "Button", color: "#ffffff" }] },
        variants: [{ when: { Style: "secondary" }, set: { fill: "#ffffff", "Label.color": "{color.brand}" } }],
      },
    });
  for (const key of Object.keys(spec))
    if (!COMPONENT_DEFINE_FIELDS.map((field) => field.replace("?", "")).includes(key))
      fail("unknown_component_define_field", `Unknown field ${key}`, { allowedFields: COMPONENT_DEFINE_FIELDS });
  const existing = [...snapshot.domain.componentSets.values()].find((set) => sameName(set.name, spec.name));
  // Names never repeat: a component of the Foundation or a Library keeps its name.
  for (const owner of [options.foundation, ...(options.libraries ?? [])])
    if (!existing && owner && [...owner.domain.componentSets.values()].some((set) => sameName(set.name, spec.name)))
      fail("duplicate_name", `${owner.manifest.packageId} already has a component named ${spec.name}; names do not repeat`, { kind: "component", name: spec.name });
  // A renamed component keeps its id, so a new one may need another.
  const id = existing?.id ?? freeId("cmp_", slug(spec.name), new Set(snapshot.domain.componentSets.keys()));
  const idBase = id.replace(/^cmp_/, "");
  const properties = Object.entries(spec.properties ?? {});
  const axes = properties.map(([name, values]) => {
    if (!Array.isArray(values) || values.length === 0) fail("invalid_component_define", `Property ${name} lists its values`);
    return { domain: values.map(String), id: `axis_${slug(name)}`, name, role: "configuration" };
  });
  let combinations = [{}];
  for (const [name, values] of properties)
    combinations = combinations.flatMap((combination) => values.map((value) => ({ ...combination, [name]: String(value) })));
  for (const [index, rule] of (spec.variants ?? []).entries()) {
    for (const [name, value] of Object.entries(rule.when ?? {})) {
      const property = properties.find(([candidate]) => sameName(candidate, name));
      if (!property) fail("unknown_property", `variants[${index}].when names ${name}, not a property`, { properties: properties.map(([candidate]) => candidate) });
      if (!property[1].map(String).some((candidate) => sameName(candidate, value)))
        fail("unknown_property_value", `variants[${index}].when ${name}=${value} is not a value of ${name}`, { values: property[1] });
    }
  }
  const variants = combinations.map((combination) => {
    let base = spec.base;
    for (const rule of spec.variants ?? [])
      if (Object.entries(rule.when ?? {}).every(([name, value]) =>
        Object.entries(combination).some(([property, chosen]) => sameName(property, name) && sameName(chosen, value))))
        base = applySettings(base, rule.set, spec.name);
    const variantSlug = Object.values(combination).map(slug).join("_") || "default";
    // One element keeps one node id in every variant, so an instance's
    // overrides survive a variant change.
    const tree = componentTree(snapshot, spec, options, idBase, base);
    const measure = options.measure?.(tree);
    widenInstances(tree.builder, measure);
    sizeDesignTree(tree.nodes, tree.rootId, measure);
    return {
      id: `var_${idBase}_${variantSlug}`,
      nodes: existing ? keepNodeIds(tree.nodes, tree.rootId, existing.variants) : tree.nodes,
      rootId: tree.rootId,
      selection: Object.fromEntries(Object.entries(combination).map(([name, value]) => [`axis_${slug(name)}`, value])),
    };
  });
  return {
    type: "put-component-set",
    componentSet: {
      ...(existing ? structuredClone(existing) : {}),
      axes,
      ...(spec.category !== undefined ? { category: spec.category } : {}),
      ...(spec.description !== undefined ? { description: spec.description } : {}),
      id,
      name: spec.name,
      variants,
    },
  };
}

const PLATFORM_SIZES = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 }, tablet: { width: 834, height: 1194 } };
export const PAGE_DRAW_FIELDS = Object.freeze(["page", "module?", "canvas?", "platform?", "width?", "height?", "into?", "fill?", "layout?", "gap?", "padding?", "align?", "justify?", "children"]);

// Element paths below the root: "Info / Title". The root's own name (a
// component or page name) is left out, so renaming it changes no path.
function elementPaths(nodes, rootId) {
  const paths = new Map();
  const walk = (id, trail) => {
    for (const child of nodes[id]?.children ?? []) {
      const path = [...trail, String(nodes[child]?.name ?? "").trim().toLowerCase()];
      paths.set(child, path.join(" / "));
      walk(child, path);
    }
  };
  walk(rootId, []);
  return paths;
}

// A redrawn page or redefined component keeps the ids its elements already
// had (matched by element path), so copies' overrides, links and the App's
// shapes still find them after a rename of the page or component.
function keepNodeIds(nodes, rootId, previous) {
  const known = new Map();
  for (const { nodes: oldNodes, rootId: oldRoot } of previous)
    for (const [id, path] of elementPaths(oldNodes, oldRoot)) if (!known.has(path)) known.set(path, id);
  const rename = new Map();
  const taken = new Set(Object.keys(nodes));
  for (const [id, path] of elementPaths(nodes, rootId)) {
    const old = known.get(path);
    if (old && old !== id && !taken.has(old)) {
      rename.set(id, old);
      taken.add(old);
    }
  }
  if (!rename.size) return nodes;
  const to = (id) => rename.get(id) ?? id;
  return Object.fromEntries(Object.entries(nodes).map(([id, node]) => [
    to(id),
    { ...node, id: to(id), ...(node.children ? { children: node.children.map(to) } : {}) },
  ]));
}

// The page a draw redraws: with a module, the page of that full name; else
// the page of that name, or the one page whose last name part it is.
function pageForDraw(snapshot, spec) {
  const entries = snapshot.manifest.entries.screens;
  const pick = (entry) => ({ entry, screen: snapshot.entries[entry] });
  const full = spec.module ? `${spec.module} / ${spec.page}` : spec.page;
  const exact = entries.find((entry) => sameName(snapshot.entries[entry].name, full));
  if (exact || spec.module) return exact ? pick(exact) : null;
  const tail = entries.filter((entry) => sameName(snapshot.entries[entry].name.split(" / ").at(-1), spec.page));
  if (tail.length > 1)
    fail("ambiguous_page", `Several pages are named ${spec.page}; give module too`, { pages: tail.map((entry) => snapshot.entries[entry].name) });
  return tail.length ? pick(tail[0]) : null;
}

// draw: {page, module?, platform?, width?, height?, children: [elements]}
// redraws the page's Presentation for that platform (a new page or a new
// platform is created); with into: "Container" only that container's
// content is redrawn. Interactions on elements that still exist are kept.
export function pageDrawOperation(snapshot, spec, options = {}) {
  if (!isRecord(spec) || typeof spec.page !== "string" || !Array.isArray(spec.children))
    fail("invalid_page_draw", "Expected {page, children: [elements], module?, platform?}", {
      example: { page: "Board", module: "Tasks", platform: "desktop", layout: "row", children: [{ name: "Sidebar", width: 240, height: "fill" }, { name: "Content", width: "fill" }] },
    });
  for (const key of Object.keys(spec))
    if (!PAGE_DRAW_FIELDS.map((field) => field.replace("?", "")).includes(key))
      fail("unknown_page_draw_field", `Unknown field ${key}`, { allowedFields: PAGE_DRAW_FIELDS });
  const found = pageForDraw(snapshot, spec);
  const platform = String(spec.platform ?? found?.screen.presentations.find(({ id }) => id === found.screen.basePresentationId)?.platform ?? "desktop").toLowerCase();
  const screen = found ? structuredClone(found.screen) : {
    basePresentationId: null,
    counterparts: [],
    id: freeId("scr_", slug(spec.module ? `${spec.module} ${spec.page}` : spec.page), new Set(snapshot.manifest.entries.screens.map((entry) => snapshot.entries[entry].id))),
    name: spec.module ? `${spec.module} / ${spec.page}` : spec.page,
    presentations: [],
  };
  let presentation = screen.presentations.find((candidate) => sameName(candidate.platform ?? candidate.name, platform));
  const size = PLATFORM_SIZES[platform] ?? PLATFORM_SIZES.desktop;
  const prefix = slug(`${screen.id.replace(/^scr_/, "")}_${platform}`);
  const tokens = tokenIndex(snapshot, options);
  const components = componentIndex(snapshot, options);
  if (!presentation) {
    presentation = { id: `pres_${prefix}`, interactions: [], name: platform, nodes: {}, platform, rootId: null, viewport: size };
    screen.presentations.push(presentation);
    screen.basePresentationId ??= presentation.id;
  }
  const builder = new TreeBuilder(prefix, tokens, components);
  if (presentation.rootId) builder.rootId = presentation.rootId;
  let nodes;
  let rootId = presentation.rootId;
  if (spec.into) {
    // Rebuild one container's content in place.
    const container = Object.values(presentation.nodes).find((node) => sameName(node.name, spec.into));
    if (!container)
      fail("unknown_element", `No element ${spec.into} on ${screen.name}`, { elements: Object.values(presentation.nodes).map((node) => node.name) });
    const drop = new Set();
    const collect = (id) => { for (const child of presentation.nodes[id]?.children ?? []) { drop.add(child); collect(child); } };
    collect(container.id);
    nodes = Object.fromEntries(Object.entries(presentation.nodes).filter(([id]) => !drop.has(id)));
    for (const id of Object.keys(nodes)) builder.used.add(id);
    const flex = container.layout === "flex" ? container["layout-flex-dir"] ?? "row" : false;
    const ids = nameSiblings(spec.children, container.name).map((child) => builder.build(child, [container.name], flex));
    nodes[container.id] = { ...container, children: flex ? [...ids].reverse() : ids };
    Object.assign(nodes, builder.nodes);
  } else {
    rootId = builder.build({
      align: spec.align, children: spec.children, fill: spec.fill ?? "#ffffff", gap: spec.gap,
      height: spec.height ?? size.height, justify: spec.justify, layout: spec.layout ?? "column",
      // "List · mobile": a page's versions sit side by side on the canvas.
      name: `${spec.page} · ${platform}`, padding: spec.padding, width: spec.width ?? size.width,
    }, [], false, true);
    nodes = builder.nodes;
  }
  const measure = options.measure?.({ nodes, probes: builder.probes, rootId, measureTexts: builder.measureTexts });
  widenInstances(builder, measure);
  sizeDesignTree(nodes, rootId, measure);
  if (presentation.rootId && Object.keys(presentation.nodes ?? {}).length)
    nodes = keepNodeIds(nodes, rootId, [{ nodes: presentation.nodes, rootId: presentation.rootId }]);
  // Elements drawn again keep their interactions, including surviving
  // source elements whose links are stored as overrides on a copy.
  for (const [id, node] of Object.entries(nodes)) {
    if (presentation.nodes[id]?.interactions?.length && !node.interactions)
      node.interactions = structuredClone(presentation.nodes[id].interactions);
    const previous = presentation.nodes[id]?.instance;
    if (!previous || !node.instance ||
      previous.component.assetId !== node.instance.component.assetId ||
      previous.component.packageId !== node.instance.component.packageId) continue;
    const { set } = components(node.instance.component.assetId);
    const variant = set.variants.find((candidate) =>
      Object.entries(node.instance.variant ?? {}).every(([axis, value]) => candidate.selection?.[axis] === value)) ?? set.variants[0];
    for (const [key, links] of Object.entries(previous.overrides ?? {})) {
      if (!key.endsWith(":interactions") || !variant.nodes[key.slice(0, -":interactions".length)]) continue;
      node.instance.overrides ??= {};
      if (!Object.hasOwn(node.instance.overrides, key))
        node.instance.overrides[key] = structuredClone(links);
    }
  }
  presentation.nodes = nodes;
  presentation.rootId = rootId;
  if (!spec.into) presentation.viewport = { width: nodes[rootId].width, height: nodes[rootId].height };
  presentation.interactions = (presentation.interactions ?? []).filter((interaction) =>
    !interaction.sourceNodeId || nodes[interaction.sourceNodeId]);
  return { type: "put-screen", screen, ...(found ? { entry: found.entry } : {}) };
}

// --- partial edits ----------------------------------------------------------
//
// page set / component set change a few fields of one element, or of the
// page or variant itself, without drawing it again. Each field means what it
// means in page draw: the element is built from those fields by the same
// builder, the fields it controls are copied onto the stored element, and
// the tree is sized again (texts measured, hugging containers regrown), as a
// redraw would.

const SET_FIELDS = Object.freeze([
  "width", "height", "fill", "color", "stroke", "radius", "opacity", "shadow", "visible", "rotation",
  "margin", "minWidth", "maxWidth", "minHeight", "maxHeight",
  "text", "font", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "textTransform", "textDecoration", "textAlign",
  "layout", "gap", "padding", "align", "justify",
  "props", "set",
]);
const COPY_FIELDS = new Set(["props", "text", "set", "width", "height", "visible", "opacity"]);

// Spec field -> the stored fields and Token bindings it controls.
const CONTROLS = {
  fill: { fields: ["fills"], bindings: ["fill"] },
  color: { fields: ["fills"], bindings: ["fill"] },
  stroke: { fields: ["strokes"], bindings: ["stroke", "strokeWidth", "strokeWidthTop", "strokeWidthRight", "strokeWidthBottom", "strokeWidthLeft"] },
  radius: { fields: ["cornerRadius"], bindings: ["cornerRadius", "radiusTopLeft", "radiusTopRight", "radiusBottomRight", "radiusBottomLeft"] },
  opacity: { fields: ["opacity"], bindings: ["opacity"] },
  shadow: { fields: ["shadow"], bindings: ["shadow"] },
  rotation: { fields: ["rotation"], bindings: ["rotation"] },
  margin: { fields: ["layout-item-margin", "layout-item-margin-type"], bindings: ["marginTop", "marginRight", "marginBottom", "marginLeft"] },
  minWidth: { fields: ["layout-item-min-w"], bindings: ["minWidth"] },
  maxWidth: { fields: ["layout-item-max-w"], bindings: ["maxWidth"] },
  minHeight: { fields: ["layout-item-min-h"], bindings: ["minHeight"] },
  maxHeight: { fields: ["layout-item-max-h"], bindings: ["maxHeight"] },
  gap: { fields: ["layout-gap"], bindings: ["itemSpacing"] },
  padding: { fields: ["layout-padding", "layout-padding-type"], bindings: ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] },
  align: { fields: ["layout-align-items"], bindings: [] },
  justify: { fields: ["layout-justify-content"], bindings: [] },
};
const TEXT_STYLE_CONTROLS = {
  font: { bindings: ["typography"] },
  fontFamily: { keys: ["fontFamily"], bindings: ["fontFamily"] },
  fontSize: { keys: ["fontSize"], bindings: ["fontSize"] },
  fontWeight: { keys: ["fontWeight"], bindings: ["fontWeight"] },
  lineHeight: { keys: ["lineHeight"], bindings: ["lineHeight"] },
  letterSpacing: { keys: ["letterSpacing"], bindings: ["letterSpacing"] },
  textTransform: { keys: ["textTransform"], bindings: ["textTransform"] },
  textDecoration: { keys: ["textDecoration"], bindings: ["textDecoration"] },
  textAlign: { keys: ["textAlign"], bindings: [] },
};

function parentOf(nodes, id) {
  return Object.values(nodes).find((node) => node.children?.includes(id));
}

// Applies set to nodes[id] in place. builder holds the stored nodes, so a
// longer text in a copy widens it as page draw does.
function setElementFields(builder, nodes, id, set, where, root) {
  const node = nodes[id];
  if (!isRecord(set) || !Object.keys(set).length) fail("invalid_set", "Give at least one field to set, for example --set width=320", { allowedFields: SET_FIELDS });
  for (const key of Object.keys(set))
    if (!SET_FIELDS.includes(key)) fail("unknown_set_field", `Unknown field ${key} (at ${where})`, { allowedFields: SET_FIELDS });
  const parent = parentOf(nodes, id);
  const parentFlex = parent?.layout === "flex" ? parent["layout-flex-dir"] ?? "row" : false;
  const scratch = new TreeBuilder(`${builder.prefix}_set`, builder.tokens, builder.components);
  if (node.instance) {
    const unsupported = Object.keys(set).filter((key) => !COPY_FIELDS.has(key));
    if (unsupported.length)
      fail("unknown_set_field", `A copy of a component takes ${[...COPY_FIELDS].join(", ")}; change ${unsupported.join(", ")} in the component (at ${where})`, { allowedFields: [...COPY_FIELDS] });
    const { set: component } = builder.components(node.instance.component.assetId);
    const props = Object.fromEntries((component.axes ?? []).map((axis) => [axis.name, node.instance.variant?.[axis.id]]).filter(([, value]) => value !== undefined));
    const sizing = node["layout-item-h-sizing"];
    const spec = {
      name: node.name, use: component.id, props: { ...props, ...(set.props ?? {}) },
      ...(set.width !== undefined ? { width: set.width } : sizing === "fill" ? { width: "fill" } : sizing === "fix" || parentFlex && sizing !== "auto" ? { width: node.width } : {}),
    };
    if (set.text !== undefined) {
      if (!isRecord(set.text)) fail("invalid_set", `A copy's text takes {"Element": "text"} (at ${where})`);
      spec.text = set.text;
    }
    if (set.set !== undefined) spec.set = set.set;
    const scratchId = scratch.build(spec, [where.split(" › ")[0]], parentFlex);
    const built = scratch.nodes[scratchId];
    if (set.props !== undefined) node.instance.variant = built.instance.variant;
    // A value written now replaces the Token its field followed: the
    // copy's own binding for it goes, and the builder drops the
    // component's (null).
    const previousOverrides = node.instance.overrides ?? {};
    const overrides = { ...previousOverrides };
    const fresh = built.instance.overrides ?? {};
    for (const [key, value] of Object.entries(fresh)) {
      const at = key.lastIndexOf(":");
      const target = key.slice(0, at), field = key.slice(at + 1);
      if (field === "tokenBindings") continue;
      overrides[key] = value;
      const binding = field === "textStyle" ? undefined : Object.values(INSTANCE_SETTINGS).find((setting) => setting.field === field)?.binding;
      const bound = overrides[`${target}:tokenBindings`];
      if (binding && bound && binding in bound) {
        const { [binding]: _dropped, ...rest } = bound;
        if (Object.keys(rest).length) overrides[`${target}:tokenBindings`] = rest;
        else delete overrides[`${target}:tokenBindings`];
      }
    }
    for (const [key, value] of Object.entries(fresh))
      if (key.endsWith(":tokenBindings")) overrides[key] = { ...(overrides[key] ?? {}), ...value };
    node.instance.overrides = overrides;
    if (!Object.keys(node.instance.overrides).length) delete node.instance.overrides;
    Object.assign(builder.probes, scratch.probes);
    for (const entry of scratch.widen) {
      const targetId = entry.probe.slice(scratchId.length + 2);
      const previousText = previousOverrides[`${targetId}:text`];
      let previousProbe;
      if (previousText !== undefined) {
        previousProbe = `${entry.probe}::previous`;
        const reference = previousOverrides[`${targetId}:tokenBindings`]?.text;
        const translations = reference && [...builder.tokens.values()].find((item) => item.token.id === reference.assetId)?.translations;
        builder.probes[previousProbe] = {
          ...scratch.probes[entry.probe], id: previousProbe,
          text: translations?.size > 1 ? widestText(translations) : String(previousText),
        };
      }
      builder.widen.push({ ...entry, id, previousProbe });
    }
    for (const field of ["width", "height"])
      if (set[field] !== undefined) {
        const value = Number(set[field]);
        if (!Number.isFinite(value)) fail("invalid_instance_size", `A copy's ${field} takes a number (at ${where})`);
        node[field] = value;
        node[field === "width" ? "layout-item-h-sizing" : "layout-item-v-sizing"] = "fix";
      }
    if (set.visible !== undefined) {
      if (set.visible === false || set.visible === "false") node.visible = false;
      else delete node.visible;
    }
    if (set.opacity !== undefined) node.opacity = Number(set.opacity);
    return;
  }
  if (set.props !== undefined || set.set !== undefined)
    fail("unknown_set_field", `props and set are for copies of a component; ${node.name} is not one (at ${where})`);
  const isText = node.type === "TEXT";
  if (!isText && (set.text !== undefined || Object.keys(TEXT_STYLE_CONTROLS).some((key) => set[key] !== undefined)))
    fail("unknown_set_field", `${node.name} is not a text (at ${where})`);
  if (root && ["fill", "100%", "hug"].includes(String(set.width ?? set.height ?? "").toLowerCase()))
    fail("invalid_size", `The page or variant itself takes a number for its size (at ${where})`);
  const flexDir = node.layout === "flex" ? node["layout-flex-dir"] : undefined;
  const layout = set.layout ?? (flexDir ? (flexDir.startsWith("column") ? "column" : "row") : undefined);
  const spec = {
    ...Object.fromEntries(Object.entries(set).filter(([key]) => !["layout"].includes(key))),
    name: node.name,
    ...(isText ? { text: set.text ?? node.text ?? "" } : { type: "frame", ...(layout ? { layout } : {}) }),
  };
  const scratchId = scratch.build(spec, [where.split(" › ")[0]], parentFlex);
  const built = scratch.nodes[scratchId];
  const bindings = { ...(node.tokenBindings ?? {}) };
  const takeBindings = (names) => {
    for (const name of names) {
      delete bindings[name];
      if (built.tokenBindings?.[name]) bindings[name] = built.tokenBindings[name];
    }
  };
  for (const [key, control] of Object.entries(CONTROLS)) {
    if (set[key] === undefined) continue;
    for (const field of control.fields) {
      if (built[field] === undefined) delete node[field];
      else node[field] = structuredClone(built[field]);
    }
    takeBindings(control.bindings);
  }
  if (set.visible !== undefined) {
    if (built.visible === false) node.visible = false;
    else delete node.visible;
    takeBindings(["visible"]);
  }
  if (isText) {
    if (set.text !== undefined) {
      node.text = built.text;
      delete node.textBlocks;
      takeBindings(["text"]);
      if (scratch.measureTexts[scratchId]) builder.measureTexts[id] = scratch.measureTexts[scratchId];
    }
    const style = { ...(node.textStyle ?? {}) };
    for (const [key, control] of Object.entries(TEXT_STYLE_CONTROLS)) {
      if (set[key] === undefined) continue;
      if (key === "font") Object.assign(style, built.textStyle ?? {});
      else for (const name of control.keys) {
        if (built.textStyle?.[name] === undefined) delete style[name];
        else style[name] = built.textStyle[name];
      }
      takeBindings(control.bindings);
    }
    if (Object.keys(style).length) node.textStyle = style;
  }
  if (set.layout !== undefined) {
    const was = node.layout === "flex";
    if (set.layout === "none") {
      for (const field of ["layout", "layout-flex-dir", "layout-gap", "layout-padding", "layout-padding-type", "layout-align-items", "layout-justify-content"]) delete node[field];
      if (was) node.children = [...node.children].reverse();
    } else if (["row", "column"].includes(set.layout)) {
      node.layout = "flex";
      node["layout-flex-dir"] = set.layout;
      // A flex line stores its children last-first (see build).
      if (!was) node.children = [...node.children].reverse();
      for (const childId of node.children) {
        const child = nodes[childId];
        child["layout-item-h-sizing"] ??= "fix";
        child["layout-item-v-sizing"] ??= "fix";
      }
    } else fail("invalid_layout", `layout is row, column or none (at ${where})`, { values: ["row", "column", "none"] });
  }
  for (const [field, sizing] of [["width", "layout-item-h-sizing"], ["height", "layout-item-v-sizing"]]) {
    if (set[field] === undefined) continue;
    const size = sizeSpec(set[field]);
    if (size.mode === "fill" && !parentFlex) fail("invalid_size", `fill needs a parent with a row or column layout (at ${where})`);
    if (parentFlex) node[sizing] = size.mode;
    if (size.mode === "fix") node[field] = size.value;
    if (isText && field === "width") node.growType = size.mode === "auto" ? "auto-width" : "auto-height";
    if (!parentFlex && size.mode === "auto" && !isText && node.layout !== "flex") fail("invalid_size", `hug needs a row or column layout inside ${node.name} (at ${where})`);
    if (!parentFlex && size.mode === "auto") node[`_${field}Hug`] = true;
  }
  if (Object.keys(bindings).length) node.tokenBindings = bindings;
  else delete node.tokenBindings;
}

// Stored sizes as sizing modes again, so sizeDesignTree measures texts and
// regrows hugging containers after an edit.
function storedSizing(nodes, rootId) {
  for (const [id, node] of Object.entries(nodes)) {
    const fixed = { width: { mode: "fix" }, height: { mode: "fix" } };
    if (id === rootId || node.instance) {
      node._size = fixed;
      continue;
    }
    const h = node["layout-item-h-sizing"], v = node["layout-item-v-sizing"];
    const isText = node.type === "TEXT";
    const width = { mode: h === "fill" ? "fill" : h === "auto" || node._widthHug || (isText && node.growType === "auto-width") ? "auto" : "fix" };
    const height = { mode: v === "fill" ? "fill" : v === "auto" || node._heightHug || (isText && ["auto-width", "auto-height"].includes(node.growType)) ? "auto" : "fix" };
    delete node._widthHug;
    delete node._heightHug;
    node._size = { width, height };
    if (isText) {
      if (width.mode !== "fix") delete node.width;
      if (height.mode !== "fix") delete node.height;
    } else if (node.layout === "flex") {
      if (width.mode === "auto") delete node.width;
      if (height.mode === "auto") delete node.height;
    }
  }
}

// One element's path (or the root), or every version / variant that has it.
// Versions and variants often differ on purpose (a narrower mobile card, a
// hover fill), so an element in several of them changes in all only with
// all; otherwise the edit names one.
function editTargets(list, element, label, { all = false, one, kind }) {
  const found = [];
  let firstError;
  for (const item of list) {
    try {
      found.push({ item, id: element === undefined ? item.rootId : findElement(item.nodes, item.rootId, element, label(item)) });
    } catch (error) {
      firstError ??= error;
    }
  }
  if (!found.length) throw firstError;
  if (found.length > 1 && !all) {
    const names = found.map(({ item }) => kind.name(item));
    fail("ambiguous_target", `${element === undefined ? "This" : element} is in ${found.length} ${kind.plural}: ${names.slice(0, 8).join("; ")}${names.length > 8 ? `; and ${names.length - 8} more` : ""}. ` +
      `They may differ on purpose: name one with ${one}, or pass --all to change every one`, {
      [kind.plural]: names.slice(0, 20),
      ...(names.length > 20 ? { more: names.length - 20 } : {}),
    });
  }
  return found;
}

function sizeAgain(builder, nodes, rootId, options) {
  storedSizing(nodes, rootId);
  const measure = options.measure?.({ nodes, probes: builder.probes, rootId, measureTexts: builder.measureTexts });
  widenInstances(builder, measure);
  sizeDesignTree(nodes, rootId, measure);
}

// page set: {page, platform?, element?, all?, set}. The one version that
// has the element (or the page), the named one, or every one with all.
export function pageSetOperation(snapshot, { page, platform, element, all, set }, options = {}) {
  const found = findPage(snapshot, page);
  const entry = snapshot.manifest.entries.screens.find((name) => snapshot.entries[name].id === found.id);
  const screen = structuredClone(found);
  const versions = platform !== undefined ? [findPresentation(screen, platform)] : screen.presentations;
  const label = (presentation) => `${screen.name} (${presentation.platform ?? presentation.name})`;
  const tokens = tokenIndex(snapshot, options);
  const components = componentIndex(snapshot, options);
  const kind = { plural: "platforms", name: (presentation) => presentation.platform ?? presentation.name };
  for (const { item: presentation, id } of editTargets(versions, element, label, { all, one: "--platform", kind })) {
    const builder = new TreeBuilder(slug(`${screen.id}_${presentation.platform ?? presentation.name}`), tokens, components);
    builder.nodes = presentation.nodes;
    setElementFields(builder, presentation.nodes, id, set, label(presentation) + (element ? ` › ${element}` : ""), id === presentation.rootId);
    sizeAgain(builder, presentation.nodes, presentation.rootId, options);
    const rootNode = presentation.nodes[presentation.rootId];
    presentation.viewport = { width: rootNode.width, height: rootNode.height };
  }
  return { type: "put-screen", screen, entry };
}

// component set: {component, variant?, element?, all?, set}. The one
// variant that has the element (or the component), the named one, or every
// one with all.
export function componentSetOperation(snapshot, { component, variant, element, all, set }, options = {}) {
  const { owner, set: found } = findComponent(snapshot, component, options);
  if (owner !== snapshot)
    fail("component_not_here", `${found.name} belongs to ${owner.manifest.name ?? "another package"}; edit it there`, { package: owner.manifest.name, path: owner.locator });
  const componentSet = structuredClone(found);
  const variants = variant !== undefined ? [componentSet.variants.find(({ id }) => id === findVariant(found, variant).id)] : componentSet.variants;
  const labelOf = (item) => {
    const text = (componentSet.axes ?? []).map((axis) => `${axis.name}=${item.selection?.[axis.id]}`).join(", ");
    return text ? `${componentSet.name} (${text})` : componentSet.name;
  };
  const tokens = tokenIndex(snapshot, options);
  const components = componentIndex(snapshot, options);
  const kind = { plural: "variants", name: (item) => (componentSet.axes ?? []).map((axis) => `${axis.name}=${item.selection?.[axis.id]}`).join(", ") || "default" };
  for (const { item: target, id } of editTargets(variants, element, labelOf, { all, one: "--variant", kind })) {
    const builder = new TreeBuilder(slug(`${componentSet.id}_${target.id}`), tokens, components);
    builder.nodes = target.nodes;
    setElementFields(builder, target.nodes, id, set, labelOf(target) + (element ? ` › ${element}` : ""), id === target.rootId);
    sizeAgain(builder, target.nodes, target.rootId, options);
  }
  return { type: "put-component-set", componentSet };
}

// link: {from: "Page / Element", to: "Page", on?: "click", action?:
// "navigate" | "overlay" | "back"} -> a set-interaction intent.
export function flowLinkIntent(snapshot, link, lookups = {}) {
  if (!isRecord(link) || typeof link.from !== "string")
    fail("invalid_flow_link", "Expected --from \"Page / Element\" and --to \"Page\" (or --action back)");
  // An element inside a copy ("Page / Card / Open") links from the copy.
  const { screen, presentation, nodeId, inside } = findPageElement(snapshot, link.from, link.platform, lookups);
  const action = link.action ?? "navigate";
  const interaction = { "event-type": link.on ?? "click", "action-type": action === "overlay" ? "open-overlay" : action === "back" ? "prev-screen" : "navigate" };
  if (action !== "back") {
    // A link from one version lands on the same version of the target page
    // when it has one ("desktop" to "desktop").
    const target = findPage(snapshot, link.to ?? "");
    const platform = presentation.platform ?? presentation.name;
    const same = target.presentations.find((candidate) => (candidate.platform ?? candidate.name) === platform);
    interaction.destination = { screenId: target.id, ...(same ? { presentationId: same.id } : {}) };
  }
  return { action: "set-interaction", interaction, nodeId, ...(inside ? { sourcePath: inside.sourcePath } : {}), presentationId: presentation.id, screenId: screen.id };
}

export function flowStartIntent(snapshot, page, newId, platform) {
  const screen = findPage(snapshot, page);
  const presentation = findPresentation(screen, platform);
  // Starts share one Penpot page per canvas: a page with several versions
  // names the version, so two starts never read alike.
  const name = screen.presentations.length > 1 ? `${screen.name} (${presentation.platform ?? presentation.name})` : screen.name;
  return {
    action: "set-start",
    flow: { id: newId(), name, startingNodeId: presentation.rootId },
    presentationId: presentation.id,
    screenId: screen.id,
  };
}

// move: an element one or more steps up, down, left or right among its
// siblings. In auto layout that is its place in the order; without it, the
// element swaps places with its neighbour on that side (same gap), and
// nothing ends up overlapping. The CLI picks every coordinate.
export const MOVE_DIRECTIONS = Object.freeze(["up", "down", "left", "right"]);

export function elementMoveOperation(snapshot, { page, platform, element, direction, steps = 1 }) {
  if (!MOVE_DIRECTIONS.includes(direction))
    fail("invalid_direction", `direction is ${MOVE_DIRECTIONS.join(", ")}`, { values: MOVE_DIRECTIONS });
  const found = findPage(snapshot, page);
  const entry = snapshot.manifest.entries.screens.find((name) => snapshot.entries[name].id === found.id);
  const screen = structuredClone(found);
  const presentation = screen.presentations.find(({ id }) => id === findPresentation(found, platform).id);
  const nodes = presentation.nodes;
  const id = findElement(nodes, presentation.rootId, element, screen.name);
  const parent = Object.values(nodes).find((node) => node.children?.includes(id));
  const vertical = direction === "up" || direction === "down";
  const earlier = direction === "up" || direction === "left";
  if (parent.layout === "flex") {
    const row = parent["layout-flex-dir"] === "row";
    if (row === vertical)
      fail("move_across_layout", `${parent.name} lays its children out in a ${row ? "row" : "column"}; move ${element} ${row ? "left or right" : "up or down"}`);
    // Penpot draws a flex line from the last stored child: visual order is
    // the stored order reversed.
    const visual = [...parent.children].reverse();
    const from = visual.indexOf(id);
    const to = Math.max(0, Math.min(visual.length - 1, from + (earlier ? -steps : steps)));
    if (to === from) fail("nothing_to_move_past", `${element} is already ${earlier ? "first" : "last"} in ${parent.name}`);
    visual.splice(from, 1);
    visual.splice(to, 0, id);
    parent.children = visual.reverse();
  } else {
    const node = nodes[id];
    for (let step = 0; step < steps; step += 1) {
      // The nearest sibling on that side that shares the other axis.
      const lane = parent.children.map((child) => nodes[child]).filter((other) => other && other !== node && other.visible !== false &&
        (vertical
          ? other.x < node.x + node.width && node.x < other.x + other.width
          : other.y < node.y + node.height && node.y < other.y + other.height));
      const ahead = lane.filter((other) => vertical
        ? (earlier ? other.y + other.height <= node.y + 0.5 : other.y >= node.y + node.height - 0.5)
        : (earlier ? other.x + other.width <= node.x + 0.5 : other.x >= node.x + node.width - 0.5));
      if (!ahead.length) {
        if (step === 0) fail("nothing_to_move_past", `Nothing is ${direction === "up" ? "above" : direction === "down" ? "below" : `to the ${direction} of`} ${element} in ${parent.name}`);
        break;
      }
      const axis = vertical ? "y" : "x", size = vertical ? "height" : "width";
      const neighbour = ahead.sort((a, b) => earlier ? (b[axis] + b[size]) - (a[axis] + a[size]) : a[axis] - b[axis])[0];
      // Swap the two slots, keeping the gap between them.
      const [first, second] = earlier ? [neighbour, node] : [node, neighbour];
      const space = second[axis] - (first[axis] + first[size]);
      const start = first[axis];
      second[axis] = start;
      first[axis] = start + second[size] + space;
    }
    // Moved elements never overlap the others: push them below what they hit.
    const others = parent.children.map((child) => nodes[child]).filter((other) => other && other.visible !== false);
    for (const moved of others) {
      for (let guard = 0; guard < others.length; guard += 1) {
        const hit = others.find((other) => other !== moved && overlaps(moved, other) && others.indexOf(other) < others.indexOf(moved));
        if (!hit) break;
        moved.y = hit.y + hit.height + 16;
      }
    }
  }
  return { type: "put-screen", entry, screen };
}
