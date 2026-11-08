// INPUT:  a page <body>, or a component root with its variant rules
// OUTPUT: flat package-model nodes with derived ids and seed geometry
// POS:    HTML element tree -> Presentation / Variant nodes. Positions and
//         sizes that layout derives are seeds; the App's layout settles them.

import { attributeValue } from "./html-parse.mjs";
import { gridCells, placeGridItems } from "./grid-cells.mjs";
import { uuidFromKey } from "./ids.mjs";
import {
  createState,
  gridItem,
  itemFields,
  layoutFields,
  readClasses,
  textStyleOf,
  valueOf,
  visualFields,
} from "./style-slots.mjs";

// One attribute per prototype trigger, as the App names them.
export const TRIGGER_ATTRIBUTES = [
  ["data-click", "click"],
  ["data-press", "mouse-press"],
  ["data-hover", "mouse-over"],
  ["data-mouse-enter", "mouse-enter"],
  ["data-mouse-leave", "mouse-leave"],
  ["data-after-delay", "after-delay"],
];
const COMMON_ATTRIBUTES = new Set(["class", "data-name", "data-visible", ...TRIGGER_ATTRIBUTES.map(([name]) => name)]);
const ALLOWED_ATTRIBUTES = {
  body: new Set([...COMMON_ATTRIBUTES, "data-flow", "data-canvas"]),
  div: new Set([...COMMON_ATTRIBUTES, "data-shape"]),
  p: new Set([...COMMON_ATTRIBUTES, "data-text"]),
  img: new Set([...COMMON_ATTRIBUTES, "src", "alt"]),
  svg: new Set([...COMMON_ATTRIBUTES, "viewbox", "xmlns"]),
  "sp-use": new Set([...COMMON_ATTRIBUTES, "component", "props"]),
  span: new Set(["class"]),
  path: new Set(["d", "fill-rule"]),
};
// A mask is a group whose first child (its bottom layer) masks the rest.
const SHAPES = { rectangle: "RECTANGLE", ellipse: "ELLIPSE", group: "GROUP", mask: "GROUP" };
const DEFAULT_NAMES = {
  FRAME: "Board", RECTANGLE: "Rectangle", ELLIPSE: "Ellipse", GROUP: "Group",
  IMAGE: "Image", PATH: "Path", TEXT: "Text", COMPONENT: "Component",
};
const PAGE_ONLY_TYPES = new Set(["ELLIPSE", "GROUP", "PATH"]);
const ELEMENT_HINTS = {
  section: "<div>", header: "<div>", footer: "<div>", nav: "<div>", main: "<div>",
  aside: "<div>", article: "<div>", button: "<div> or a component copy", ul: "<div>",
  li: "<div>", a: "a <div> with data-click", span: "<p> (or <span> inside a <p>)",
  h1: "<p>", h2: "<p>", h3: "<p>", h4: "<p>", h5: "<p>", h6: "<p>", label: "<p>",
  strong: "<span> inside a <p>", em: "<span> inside a <p>", input: "a component copy",
  style: "classes", script: "nothing: SmallPen files have no scripts",
};

export function elementType(element) {
  switch (element.tag) {
    case "body": return "FRAME";
    case "div": {
      const shape = attributeValue(element, "data-shape");
      return (shape !== undefined && SHAPES[shape]) || "FRAME";
    }
    case "p": return "TEXT";
    case "img": return "IMAGE";
    case "svg": return "PATH";
    case "sp-use": return "INSTANCE";
    default: return undefined;
  }
}

// Text of a <p>: whitespace collapses as in a browser, <br> is a line
// break. Returns { text, runs } where runs keep <span> styling.
export function readText(element, ctx) {
  const runs = [];
  const push = (text, span) => {
    if (!text) return;
    const last = runs.at(-1);
    if (last && last.span === span) last.text += text;
    else runs.push({ text, span });
  };
  for (const child of element.children) {
    if (child.type === "text") push(child.text, undefined);
    else if (child.tag === "br") push("\n", undefined);
    else if (child.tag === "span") {
      checkAttributes(child, ctx);
      for (const inner of child.children) {
        if (inner.type === "text") push(inner.text, child);
        else if (inner.tag === "br") push("\n", child);
        else ctx.issue("unknown_element", `<${inner.tag}> cannot be inside <span>`, inner.offset);
      }
    } else {
      ctx.issue("unknown_element", `<${child.tag}> cannot be inside <p>; use <span> for styled text`, child.offset);
    }
  }
  // Collapse whitespace across runs, keeping explicit line breaks.
  let text = "";
  const collapsed = [];
  let pendingSpace = false;
  for (const run of runs) {
    let out = "";
    for (const char of run.text) {
      if (char === "\n") {
        out += "\n";
        pendingSpace = false;
      } else if (/\s/.test(char) && char !== " ") {
        pendingSpace = true;
      } else {
        if (pendingSpace && (text + out).length > 0 && !(text + out).endsWith("\n")) out += " ";
        pendingSpace = false;
        out += char;
      }
    }
    text += out;
    if (out) collapsed.push({ text: out, span: run.span });
  }
  return { text, runs: collapsed };
}

function checkAttributes(element, ctx) {
  const allowed = ALLOWED_ATTRIBUTES[element.tag];
  for (const attr of element.attrs) {
    if (attr.name === "style") {
      ctx.issue("inline_style_forbidden", "style is not allowed; use classes", attr.offset);
    } else if (!allowed?.has(attr.name) && !element.brokenQuote) {
      ctx.issue("unknown_attribute", `<${element.tag}> does not take ${attr.name}`, attr.offset);
    }
  }
}

function defaultName(type, element, text, ctx) {
  if (type === "TEXT") {
    const label = (text ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    return label || DEFAULT_NAMES.TEXT;
  }
  if (type === "INSTANCE") return attributeValue(element, "component") || "Copy";
  if (type === "IMAGE") {
    const src = attributeValue(element, "src") ?? "";
    return src.split("/").at(-1)?.replace(/\.[^.]+$/, "") || DEFAULT_NAMES.IMAGE;
  }
  return DEFAULT_NAMES[type] ?? "Layer";
}

// Gives every child element its name: explicit names must not repeat
// (case-insensitive); default names are numbered around them.
function nameChildren(children, ctx) {
  const explicit = new Map();
  for (const child of children) {
    const name = attributeValue(child.element, "data-name");
    if (name === undefined) continue;
    if (!name.trim()) {
      ctx.issue("invalid_name", "data-name cannot be empty", child.element.offset);
      continue;
    }
    const key = name.toLowerCase();
    if (explicit.has(key)) {
      ctx.issue("duplicate_name", `Two siblings are named ${name}; give this one another data-name (names are how copies, variants and --element find a part)`, child.element.offset);
    } else explicit.set(key, child);
    child.name = name;
  }
  const used = new Set(explicit.keys());
  for (const child of children) {
    if (child.name !== undefined) continue;
    const base = defaultName(child.type, child.element, child.text, ctx);
    let name = base;
    for (let counter = 2; used.has(name.toLowerCase()); counter += 1) name = `${base} ${counter}`;
    used.add(name.toLowerCase());
    child.name = name;
  }
}

function sizingOf(spec, axis, info, ctx, element) {
  const label = axis === "width" ? "w" : "h";
  if (!spec) {
    if (info.isPageRoot) return { mode: "fix", value: info.rootSize[axis] };
    if (info.canHug) return { mode: "auto" };
    if (info.isMask) return { mode: "fix", value: undefined, fromMask: true };
    if (info.type !== "TEXT") {
      ctx.issue("size_required", `Give this element a ${axis}, for example ${label}-[120px]`, element.offset);
    }
    return { mode: "fix", value: 0 };
  }
  if (spec.mode === "fill") {
    if (!info.parentFlex) {
      ctx.issue("layout_not_in_app", `${label}-full fills a flex parent or a grid cell; this parent has neither flex nor grid`, element.offset);
      return { mode: "fix", value: 0 };
    }
    return { mode: "fill" };
  }
  if (spec.mode === "hug") {
    if (!info.canHug) {
      ctx.issue("layout_not_in_app", `${label}-fit works on flex and grid containers, copies and text`, element.offset);
      return { mode: "fix", value: 0 };
    }
    return { mode: "auto" };
  }
  const resolved = valueOf(spec, ctx, axis);
  return { mode: "fix", value: resolved.value, binding: resolved.binding };
}

const SIZING_FIELD = { fix: "fix", fill: "fill", auto: "auto" };

// Decodes one element subtree into ctx.nodes. Returns the node id, or
// undefined when the element is not a node.
export function decodeElement(element, ctx, parent, path, name) {
  const type = elementType(element);
  if (!type) {
    const hint = ELEMENT_HINTS[element.tag];
    ctx.issue(
      "unknown_element",
      hint ? `<${element.tag}> is not part of SmallPen HTML; use ${hint}` : `<${element.tag}> is not part of SmallPen HTML`,
      element.offset,
    );
    return undefined;
  }
  const shape = element.tag === "div" ? attributeValue(element, "data-shape") : undefined;
  if (shape !== undefined && !SHAPES[shape]) {
    ctx.issue("unknown_attribute", "data-shape takes rectangle, ellipse, group or mask", element.offset);
  }
  if (ctx.kind === "component" && PAGE_ONLY_TYPES.has(type)) {
    ctx.issue("page_only_element", `${type.toLowerCase()} works in pages only; use a <div> or an <img> in components`, element.offset);
  }
  checkAttributes(element, ctx);
  const isRoot = parent === undefined;
  const nodeType = isRoot && ctx.kind === "component" ? "COMPONENT" : type;
  const id = ctx.nodeId(path);
  ctx.elementIds?.set(element, id);
  // A text without data-name is named by its words (see nameChildren).
  if (type === "TEXT" && attributeValue(element, "data-name") === undefined) ctx.namedByText?.add(id);
  const sources = [{ value: attributeValue(element, "class") ?? "", offset: classOffset(element) }];
  for (const extra of ctx.extraClasses?.get(element) ?? []) sources.push(extra);
  const state = readClasses(createState(), sources, ctx.tokenTable, (code, message, offset = element.offset, details) =>
    ctx.issue(code, message, offset, details),
  );

  const node = { children: [], id, name, type: nodeType };
  ctx.currentNodeId = id;
  ctx.currentElement = element;
  const bindings = {};
  const merge = (part) => {
    Object.assign(node, part.fields);
    Object.assign(bindings, part.bindings);
  };

  if (type === "TEXT" && state.fill !== undefined) {
    ctx.issue("unsupported_class", "Text has no background; put the <p> in a <div> with bg-*", element.offset);
  }
  if (type !== "TEXT" && (state.textColor || Object.keys(state.text).length)) {
    ctx.issue("text_style_on_container", "Text classes go on the <p> itself; styles do not inherit in SmallPen", element.offset);
  }
  merge(visualFields(type, state, ctx));
  const isFlex = state.layout === "flex";
  const isGrid = state.layout === "grid";
  if ((isFlex || isGrid) && !["FRAME"].includes(type)) {
    ctx.issue("unsupported_class", `${state.layout} works on <div> containers only`, element.offset);
  }
  if (!isFlex && !isGrid && (state.alignItems || state.justify || state.alignContent || state.rowGap || state.columnGap || Object.keys(state.padding).length)) {
    ctx.issue("layout_required", "Gap, padding and alignment need flex or grid on the same element", element.offset);
  }
  if (!isFlex && (state.direction || state.wrap)) {
    ctx.issue("layout_required", "flex-row, flex-col and flex-wrap need flex on the same element", element.offset);
  }
  if (!isGrid && (state.gridColumns || state.gridRows || state.gridDir || state.justifyItems)) {
    ctx.issue("layout_required", "grid-cols, grid-rows, grid-flow and justify-items need grid on the same element", element.offset);
  }
  merge(layoutFields(state, ctx));
  const inLayout = Boolean(parent?.flex || parent?.grid);
  if (inLayout) merge(itemFields(state, ctx, { grid: Boolean(parent?.grid) }));
  else if (state.absolute || Object.keys(state.margin).length || state.alignSelf) {
    ctx.issue("layout_not_in_app", "absolute, margins and self-* apply inside a flex or grid parent", element.offset);
  }
  const placesCell = state.columnStart || state.rowStart || state.columnSpan || state.rowSpan || state.justifySelf;
  if (placesCell && !parent?.grid) {
    ctx.issue("layout_not_in_app", "col-*, row-* and justify-self-* place children of a grid", element.offset);
  }
  if (parent?.grid && !state.absolute) ctx.gridItems?.set(id, { ...gridItem(state), offset: element.offset });
  if (state.clip === false && (type === "FRAME" || nodeType === "COMPONENT")) node["show-content"] = true;

  // Text content and style.
  let textInfo;
  if (type === "TEXT") {
    // A variant rule's words or data-text replace the shared element's.
    const override = ctx.textOverrides?.get(element);
    textInfo = override ?? readText(element, ctx);
    const style = textStyleOf(state, ctx, bindings);
    if (Object.keys(style).length) node.textStyle = style;
    const tokenText = override ? override.tokenText : attributeValue(element, "data-text");
    if (tokenText !== undefined) {
      const name = `string-${tokenText}`;
      if (!ctx.tokenTable.has(name)) {
        ctx.issue("unknown_token", `data-text="${tokenText}": no Token --${name}`, override?.offset ?? element.offset);
        node.text = textInfo.text;
      } else {
        node.text = String(ctx.tokenValue(name) ?? "");
        bindings.text = ctx.tokenRef(name);
      }
    } else {
      node.text = textInfo.text;
      const styled = textInfo.runs.some((run) => run.span);
      if (styled) node.textBlocks = textBlocksOf(textInfo.runs, ctx, node);
    }
    if (!node.text && tokenText === undefined) {
      ctx.issue("empty_text", "A <p> needs text, or data-text with a string Token", element.offset);
    }
  }
  const visibleToken = attributeValue(element, "data-visible");
  if (visibleToken !== undefined) {
    const name = `flag-${visibleToken}`;
    if (!ctx.tokenTable.has(name)) ctx.issue("unknown_token", `data-visible="${visibleToken}": no Token --${name}`, element.offset);
    else bindings.visible = ctx.tokenRef(name);
  }

  // Geometry and sizing.
  const canHug = type === "TEXT" || type === "INSTANCE" || isFlex || isGrid;
  const info = {
    type,
    isRoot,
    isPageRoot: isRoot && ctx.kind === "page",
    rootSize: ctx.rootSize,
    parentFlex: inLayout,
    canHug,
    isMask: shape === "mask",
  };
  let width;
  let height;
  if (type === "TEXT") {
    const hasWidth = state.width && state.width.mode !== "hug";
    const hasHeight = state.height && state.height.mode !== "hug";
    width = hasWidth ? sizingOf(state.width, "width", info, ctx, element) : { mode: "auto" };
    height = hasHeight ? sizingOf(state.height, "height", info, ctx, element) : { mode: "auto" };
    if (!hasWidth && hasHeight) {
      ctx.issue("invalid_text_size", "Give text a width before a fixed height", element.offset);
      height = { mode: "auto" };
    }
    node.growType = width.mode === "auto" ? "auto-width" : height.mode === "auto" ? "auto-height" : "fixed";
    if (inLayout || isRoot) {
      node["layout-item-h-sizing"] = width.mode === "fill" ? "fill" : "fix";
      node["layout-item-v-sizing"] = height.mode === "fill" ? "fill" : "fix";
    }
  } else {
    width = sizingOf(state.width, "width", info, ctx, element);
    height = sizingOf(state.height, "height", info, ctx, element);
    if (inLayout || isRoot || isFlex || isGrid || type === "INSTANCE") {
      node["layout-item-h-sizing"] = SIZING_FIELD[width.mode];
      node["layout-item-v-sizing"] = SIZING_FIELD[height.mode];
    }
  }
  if (width.binding) bindings.width = width.binding[1];
  if (height.binding) bindings.height = height.binding[1];
  // The App's sizing rules (ctl/fix-child-sizing): a flex container that
  // hugs its main axis cannot hold a child that fills it; on the cross axis
  // and in a grid the parent checks that not every child fills. Min/max
  // limits apply to an axis that fills.
  for (const [axis, mode, label] of [["width", width.mode, "w"], ["height", height.mode, "h"]]) {
    const main = parent?.flex && (axis === "width") === parent.row;
    if (mode === "fill" && main && parent?.[`${axis}Mode`] === "auto") {
      ctx.issue("layout_not_in_app", `${label}-full inside a parent that hugs its ${axis}; give the parent a ${axis} or ${label}-full`, element.offset);
    }
    for (const limit of [axis === "width" ? "minWidth" : "minHeight", axis === "width" ? "maxWidth" : "maxHeight"]) {
      if (state[limit] && mode !== "fill") {
        ctx.issue("invalid_size_limit", `${limit === "minWidth" ? "min-w" : limit === "maxWidth" ? "max-w" : limit === "minHeight" ? "min-h" : "max-h"}-* applies to an element with ${label}-full`, element.offset);
      }
    }
  }
  node.width = width.value ?? 0;
  node.height = height.value ?? 0;
  const placed = isRoot ? false : !inLayout || state.absolute;
  node.x = placed ? (state.x?.value ?? 0) : 0;
  node.y = placed ? (state.y?.value ?? 0) : 0;
  if (!placed && !isRoot && (state.x || state.y)) {
    ctx.issue("layout_not_in_app", "left/top place children of a container without flex or grid, or absolute children", element.offset);
  }
  ctx.sizing.set(id, { width: width.mode, height: height.mode });

  // Type-specific content.
  if (type === "IMAGE") {
    const src = attributeValue(element, "src");
    const media = src === undefined ? undefined : ctx.mediaRef(src, element);
    if (media) node.mediaRef = media;
    else if (src === undefined) ctx.issue("missing_asset", "<img> needs src", element.offset);
  }
  if (type === "PATH") decodePath(element, node, state, ctx, bindings);
  if (type === "INSTANCE") {
    const root = ctx.decodeInstance(element, node, path);
    // A copy without w-/h- is as big as its component, as in the App: a
    // fixed size (and its Token) carries over, a hugging one keeps hugging.
    if (root) {
      const modes = { ...ctx.sizing.get(id) };
      for (const [axis, field] of [["width", "layout-item-h-sizing"], ["height", "layout-item-v-sizing"]]) {
        if (state[axis] || root[field] === "auto") continue;
        node[field] = "fix";
        node[axis] = root[axis] ?? 0;
        modes[axis] = "fix";
        if (root.tokenBindings?.[axis]) bindings[axis] = root.tokenBindings[axis];
      }
      ctx.sizing.set(id, modes);
    }
  }

  const interactions = [];
  for (const [attribute, trigger] of TRIGGER_ATTRIBUTES) {
    const value = attributeValue(element, attribute);
    if (value === undefined) continue;
    if (trigger === "after-delay" && !(type === "FRAME" || type === "INSTANCE")) {
      ctx.issue("invalid_interaction", "data-after-delay works on a board (<div>, <body>) or a component copy", element.offset);
      continue;
    }
    const interaction = ctx.interaction(value, element, { trigger, path });
    if (interaction) interactions.push(interaction);
  }
  if (interactions.length) node.interactions = interactions;
  if (Object.keys(bindings).length) node.tokenBindings = bindings;
  ctx.nodes[id] = node;

  // Children.
  if (type === "FRAME" || type === "GROUP" || nodeType === "COMPONENT") {
    const childElements = [];
    for (const child of element.children) {
      if (child.type === "text") {
        if (child.text.trim()) {
          ctx.issue("text_outside_p", "Put text in a <p>", child.offset);
        }
        continue;
      }
      const childType = elementType(child);
      childElements.push({
        element: child,
        type: childType,
        text: childType === "TEXT" ? readTextQuiet(child) : undefined,
      });
    }
    nameChildren(childElements, ctx);
    const ids = [];
    const outerGridItems = ctx.gridItems;
    if (isGrid) ctx.gridItems = new Map();
    const gridItems = ctx.gridItems;
    for (const child of childElements) {
      const childId = decodeElement(
        child.element,
        ctx,
        { flex: isFlex, grid: isGrid, row: isFlex && String(node["layout-flex-dir"]).startsWith("row"), id, widthMode: width.mode, heightMode: height.mode },
        [...path, child.name],
        child.name,
      );
      if (childId) ids.push(childId);
      if (isGrid) ctx.gridItems = gridItems;
    }
    ctx.gridItems = outerGridItems;
    if (isGrid) placeGrid(node, ids, gridItems, ctx, element);
    if (isFlex || isGrid) crossAxisFill(node, ids, { width, height, isGrid }, ctx, element);
    // Penpot layer order: a flex row/column lays out the last child first,
    // and a grid puts its top layer in the first cell; the file lists
    // children in reading order.
    const reverse = (isFlex && !String(node["layout-flex-dir"]).endsWith("-reverse")) || isGrid;
    node.children = reverse ? ids.reverse() : ids;
    if (shape === "mask") maskGroup(node, ids, childElements, { width, height }, ctx, element);
  } else if (type === "RECTANGLE" || type === "ELLIPSE" || type === "IMAGE") {
    for (const child of element.children) {
      if (child.type === "element" || child.text.trim()) {
        ctx.issue("unexpected_child", `A ${type.toLowerCase()} cannot have children`, child.offset);
        break;
      }
    }
  }
  return id;
}

// What CSS does on a cross axis that Penpot does not: a hugging row is as
// tall as its children that do not fill it, so when every child fills, it
// has no height; and items-stretch only places children (as items-start),
// it does not resize them.
function crossAxisFill(node, ids, { width, height, isGrid }, ctx, element) {
  const children = ids.map((id) => ctx.nodes[id]).filter((child) => child && child["layout-item-absolute"] !== true);
  if (children.length === 0) return;
  const row = !isGrid && String(node["layout-flex-dir"]).startsWith("row");
  const fills = (child, axis) => child[axis === "width" ? "layout-item-h-sizing" : "layout-item-v-sizing"] === "fill";
  for (const [axis, mode, label] of [["width", width.mode, "w"], ["height", height.mode, "h"]]) {
    if (mode !== "auto") continue;
    if (!isGrid && (axis === "width") === row) continue;
    if (!children.every((child) => fills(child, axis))) continue;
    if (isGrid) {
      const tracks = node[axis === "width" ? "layout-grid-columns" : "layout-grid-rows"] ?? [];
      if (tracks.length && tracks.every((track) => track.type === "fixed")) continue;
      const lines = axis === "width" ? "grid-cols-[200px_200px]" : "grid-rows-[160px_160px]";
      ctx.issue("layout_not_in_app", `Every child has ${label}-full in a grid that hugs its ${axis}: an auto ${axis === "width" ? "column" : "row"} is as wide as its children that do not fill it, so it has none. For equal cards size the tracks, for example ${lines}, or give the cards one ${axis}`, element.offset);
    } else {
      ctx.issue("layout_not_in_app", `Every child has ${label}-full in a ${row ? "row" : "column"} that hugs its ${axis}, so it has no ${axis}; give one child a ${axis} or the parent a ${axis}`, element.offset);
    }
  }
  // items-stretch: the cross axis (a grid's rows), justify-items-stretch: a
  // grid's columns.
  const stretched = [];
  if (node["layout-align-items"] === "stretch") stretched.push(["items-stretch", isGrid || row ? "height" : "width"]);
  if (isGrid && node["layout-justify-items"] === "stretch") stretched.push(["justify-items-stretch", "width"]);
  for (const [name, axis] of stretched) {
    const label = axis === "width" ? "w" : "h";
    if (children.some((child) => !fills(child, axis))) {
      ctx.warn?.("stretch_not_in_app", `${name} does not resize children in the App, it places them like ${name.replace("stretch", "start")}; give the children ${label}-full to fill the ${isGrid ? "cell" : axis === "height" ? "row" : "column"}`, element.offset);
    }
  }
}

// A mask group takes its box from the mask (its first child), as the App
// does: the mask sits at the group's corner and the group is as big.
function maskGroup(node, ids, childElements, size, ctx, element) {
  node["masked-group"] = true;
  const mask = ctx.nodes[ids[0]];
  if (!mask) {
    ctx.issue("mask_empty", 'A mask needs its mask shape as the first child, for example <div data-shape="ellipse" class="w-[64px] h-[64px]"></div>', element.offset);
    return;
  }
  const offset = childElements[0]?.element.offset ?? element.offset;
  if (Math.abs(mask.x) > 0.01 || Math.abs(mask.y) > 0.01) {
    ctx.issue("mask_position", `Put the mask shape ${mask.name} (the first child) at left-[0px] top-[0px]; move the mask group to place it`, offset);
  }
  for (const axis of ["width", "height"]) {
    if (size[axis].fromMask) node[axis] = mask[axis];
    else if (size[axis].mode === "fix" && Math.abs(node[axis] - mask[axis]) > 0.01) {
      ctx.issue("mask_size", `A mask is as big as its mask shape ${mask.name} (${mask.width}×${mask.height}); leave out the group's w-[…] and h-[…]`, element.offset);
      return;
    }
  }
}

// Puts a grid's children in cells (grid-cells.mjs) and adds the auto
// tracks they need.
function placeGrid(node, ids, items, ctx, element) {
  const columns = node["layout-grid-columns"];
  const rows = node["layout-grid-rows"];
  const dir = node["layout-grid-dir"];
  const list = ids.filter((id) => items.has(id)).map((id) => ({ id, ...items.get(id) }));
  const result = placeGridItems(list, columns.length, rows.length, dir);
  for (const item of result.conflicts) {
    ctx.issue("grid_cell_taken", "This child's cell is already taken by a child written before it; give it other lines or move it", item.offset);
  }
  while (columns.length < result.columns) columns.push({ type: "auto" });
  while (rows.length < result.rows) rows.push({ type: "auto" });
  node["layout-grid-cells"] = gridCells(
    result.placements.map(({ offset, ...placement }) => placement),
    columns.length,
    rows.length,
    (row, column) => uuidFromKey(`${node.id}\0cell\0${row}\0${column}`),
  );
}

function readTextQuiet(element) {
  const ignore = { issue() {} };
  return readText(element, ignore).text;
}

function classOffset(element) {
  for (const attr of element.attrs) if (attr.name === "class") return attr.valueOffset;
  return element.offset;
}

function textBlocksOf(runs, ctx, node) {
  const blocks = [{ runs: [] }];
  for (const run of runs) {
    const lines = run.text.split("\n");
    lines.forEach((line, index) => {
      if (index > 0) blocks.push({ runs: [] });
      if (!line) return;
      const entry = { text: line };
      if (run.span) {
        const state = readClasses(createState(), [{ value: attributeValue(run.span, "class") ?? "", offset: classOffset(run.span) }], ctx.tokenTable, (code, message, offset = run.span.offset, details) => ctx.issue(code, message, offset, details));
        const bindings = {};
        const style = textStyleOf(state, ctx, bindings);
        if (Object.keys(style).length) entry.textStyle = style;
        if (state.textColor) {
          const resolved = valueOf(state.textColor, ctx);
          entry.fills = [{ color: String(resolved.value).slice(0, 7), type: "solid" }];
        }
      }
      blocks.at(-1).runs.push(entry);
    });
  }
  const filtered = blocks.filter((block) => block.runs.length > 0);
  if (filtered.map((block) => block.runs.map((run) => run.text).join("")).join("\n") !== node.text) {
    return undefined;
  }
  return filtered;
}

function decodePath(element, node, state, ctx, bindings) {
  const paths = element.children.filter((child) => child.type === "element");
  if (paths.length !== 1 || paths[0].tag !== "path") {
    ctx.issue("invalid_path", "<svg> holds exactly one <path>", element.offset);
    return;
  }
  checkAttributes(paths[0], ctx);
  const d = attributeValue(paths[0], "d");
  if (!d) {
    ctx.issue("invalid_path", "<path> needs d", paths[0].offset);
    return;
  }
  node.pathData = d;
  if (state.svgFill) {
    const resolved = valueOf(state.svgFill, ctx, "fill");
    node.fills = [{ color: String(resolved.value).slice(0, 7), type: "solid" }];
    if (resolved.binding) bindings.fill = resolved.binding[1];
  } else if (!node.fills) node.fills = [];
  if (state.svgStroke) {
    if (state.svgStroke.tokenType === "color" || state.svgStroke.color) {
      const resolved = valueOf(state.svgStroke, ctx, "stroke");
      node.strokes = [{ alignment: "center", color: String(resolved.value).slice(0, 7), type: "solid", width: node.strokes?.[0]?.width ?? 1 }];
      if (resolved.binding) bindings.stroke = resolved.binding[1];
    } else if (node.strokes?.[0]) {
      node.strokes[0].width = state.svgStroke.value;
    } else {
      node.strokes = [{ alignment: "center", color: "#000000", type: "solid", width: state.svgStroke.value }];
    }
  }
  if (state.strokeHidden && node.strokes?.[0]) node.strokes[0].hidden = true;
}

// Seed sizes for everything layout derives. Text uses a rough per-glyph
// width; the renderer replaces all of it with measured layout.
export function seedGeometry(nodes, rootId, sizing, instanceSize) {
  const visit = (id) => {
    const node = nodes[id];
    if (!node) return { width: 0, height: 0 };
    const mode = sizing.get(id) ?? { width: "fix", height: "fix" };
    // Hidden and freely placed children take no room in a hugging layout.
    const childSizes = (node.children ?? []).map((child) => [child, visit(child)])
      .filter(([child]) => nodes[child]?.visible !== false && nodes[child]?.["layout-item-absolute"] !== true);
    if (node.type === "TEXT") {
      const style = node.textStyle ?? {};
      const size = style.fontSize ?? 14;
      const lineHeight = (style.lineHeight ?? 1.2) * size;
      const lines = String(node.text ?? "").split("\n");
      const widest = Math.max(1, ...lines.map((line) => estimateWidth(line, size)));
      if (node.growType === "auto-width") {
        node.width = Math.ceil(widest);
        node.height = Math.ceil(lines.length * lineHeight);
      } else if (node.growType === "auto-height") {
        const width = node.width || widest;
        const wrapped = lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(estimateWidth(line, size) / Math.max(1, width))), 0);
        node.height = Math.ceil(wrapped * lineHeight);
      }
      return { width: node.width, height: node.height };
    }
    if (node.type === "INSTANCE" && (mode.width === "auto" || mode.height === "auto")) {
      const size = instanceSize(node) ?? { width: 100, height: 40 };
      if (mode.width === "auto") node.width = size.width;
      if (mode.height === "auto") node.height = size.height;
    }
    if (node.layout === "flex") {
      const row = String(node["layout-flex-dir"]).startsWith("row");
      const padding = node["layout-padding"] ?? { p1: 0, p2: 0, p3: 0, p4: 0 };
      const gap = node["layout-gap"] ?? { "row-gap": 0, "column-gap": 0 };
      const mainGap = row ? gap["column-gap"] : gap["row-gap"];
      let main = 0;
      let cross = 0;
      for (const [, size] of childSizes) {
        main += row ? size.width : size.height;
        cross = Math.max(cross, row ? size.height : size.width);
      }
      main += Math.max(0, childSizes.length - 1) * mainGap;
      const width = (row ? main : cross) + padding.p2 + padding.p4;
      const height = (row ? cross : main) + padding.p1 + padding.p3;
      if (mode.width === "auto") node.width = Math.ceil(width);
      if (mode.height === "auto") node.height = Math.ceil(height);
    }
    if (node.layout === "grid") {
      const padding = node["layout-padding"] ?? { p1: 0, p2: 0, p3: 0, p4: 0 };
      const gap = node["layout-gap"] ?? { "row-gap": 0, "column-gap": 0 };
      const { columns, rows } = gridTrackSizes(node, nodes, undefined, undefined);
      if (mode.width === "auto") node.width = Math.ceil(sum(columns) + Math.max(0, columns.length - 1) * gap["column-gap"] + padding.p2 + padding.p4);
      if (mode.height === "auto") node.height = Math.ceil(sum(rows) + Math.max(0, rows.length - 1) * gap["row-gap"] + padding.p1 + padding.p3);
    }
    return { width: node.width, height: node.height };
  };
  visit(rootId);
  // Fill: share the parent's inner room top-down.
  const fill = (id) => {
    const node = nodes[id];
    if (!node) return;
    if (node.layout === "flex") {
      const row = String(node["layout-flex-dir"]).startsWith("row");
      const padding = node["layout-padding"] ?? { p1: 0, p2: 0, p3: 0, p4: 0 };
      const gap = node["layout-gap"] ?? { "row-gap": 0, "column-gap": 0 };
      const innerWidth = Math.max(0, node.width - padding.p2 - padding.p4);
      const innerHeight = Math.max(0, node.height - padding.p1 - padding.p3);
      const children = (node.children ?? []).map((child) => nodes[child]).filter(Boolean);
      const mainAxis = row ? "width" : "height";
      const fillers = children.filter((child) => sizing.get(child.id)?.[mainAxis] === "fill");
      const used = children
        .filter((child) => !fillers.includes(child))
        .reduce((sum, child) => sum + child[mainAxis], 0) +
        Math.max(0, children.length - 1) * (row ? gap["column-gap"] : gap["row-gap"]);
      const share = fillers.length ? Math.max(1, ((row ? innerWidth : innerHeight) - used) / fillers.length) : 0;
      for (const child of children) {
        const mode = sizing.get(child.id) ?? {};
        if (mode[mainAxis] === "fill") child[mainAxis] = Math.floor(share);
        const crossAxis = row ? "height" : "width";
        if (mode[crossAxis] === "fill") child[crossAxis] = row ? innerHeight : innerWidth;
      }
    }
    if (node.layout === "grid") {
      // Cells from the tracks; a child sits at its cell's corner, a filling
      // child takes the cell's size.
      const padding = node["layout-padding"] ?? { p1: 0, p2: 0, p3: 0, p4: 0 };
      const gap = node["layout-gap"] ?? { "row-gap": 0, "column-gap": 0 };
      const innerWidth = Math.max(0, node.width - padding.p2 - padding.p4);
      const innerHeight = Math.max(0, node.height - padding.p1 - padding.p3);
      const { columns, rows } = gridTrackSizes(node, nodes, innerWidth, innerHeight);
      const start = (sizes, index, space) => sizes.slice(0, index - 1).reduce((total, size) => total + size + space, 0);
      const span = (sizes, index, count, space) => sum(sizes.slice(index - 1, index - 1 + count)) + Math.max(0, count - 1) * space;
      for (const cell of Object.values(node["layout-grid-cells"] ?? {})) {
        for (const childId of cell.shapes ?? []) {
          const child = nodes[childId];
          if (!child) continue;
          const mode = sizing.get(childId) ?? {};
          child.x = padding.p4 + start(columns, cell.column, gap["column-gap"]);
          child.y = padding.p1 + start(rows, cell.row, gap["row-gap"]);
          if (mode.width === "fill") child.width = Math.floor(span(columns, cell.column, cell["column-span"], gap["column-gap"]));
          if (mode.height === "fill") child.height = Math.floor(span(rows, cell.row, cell["row-span"], gap["row-gap"]));
        }
      }
    }
    for (const child of node.children ?? []) fill(child);
  };
  fill(rootId);
}

const sum = (values) => values.reduce((total, value) => total + value, 0);

// Track sizes of a grid: fixed px, % of the room, auto from the widest
// child in a single-track cell, fr shares of what is left. Without room
// (a grid that hugs) fr tracks size like auto ones.
function gridTrackSizes(node, nodes, width, height) {
  const cells = Object.values(node["layout-grid-cells"] ?? {});
  const gap = node["layout-gap"] ?? { "row-gap": 0, "column-gap": 0 };
  const sizes = (tracks, room, space, axis, line, spanKey) => {
    const content = tracks.map((_track, index) => Math.max(0, ...cells
      .filter((cell) => cell[line] === index + 1 && cell[spanKey] === 1)
      .flatMap((cell) => (cell.shapes ?? []).map((id) => nodes[id]?.[axis] ?? 0))));
    const out = tracks.map((track, index) =>
      track.type === "fixed" ? track.value ?? 0
        : track.type === "percent" ? ((room ?? 0) * (track.value ?? 0)) / 100
          : track.type === "auto" || room === undefined ? content[index]
            : 0);
    const shares = tracks.reduce((total, track) => total + (track.type === "flex" ? track.value ?? 1 : 0), 0);
    if (shares > 0 && room !== undefined) {
      const free = Math.max(0, room - sum(out) - Math.max(0, tracks.length - 1) * space);
      tracks.forEach((track, index) => {
        if (track.type === "flex") out[index] = Math.max(content[index], (free * (track.value ?? 1)) / shares);
      });
    }
    return out;
  };
  return {
    columns: sizes(node["layout-grid-columns"] ?? [], width, gap["column-gap"], "width", "column", "column-span"),
    rows: sizes(node["layout-grid-rows"] ?? [], height, gap["row-gap"], "height", "row", "row-span"),
  };
}

function estimateWidth(text, size) {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    width += code > 0x2e80 ? size : code === 32 ? size * 0.28 : size * 0.55;
  }
  return width;
}
