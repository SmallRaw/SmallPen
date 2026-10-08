// What changed between two revisions of a Package, in the names an agent
// reads and writes: Token paths, theme options, components with their
// variants and elements, pages with their platforms and elements. The CLI
// rebuilds the earlier revision from the batch history and compares it
// with the current one, so a person's edits in the App reach the agent as
// a short list it can align code with.
import { canvasLayout, resolveCanvases } from "./canvases.mjs";
import { listEffectiveTokens } from "./effective-tokens.mjs";
import { bindingTargetField } from "./internal.mjs";
import { flowLinks } from "./named-edits.mjs";
import { defaultTokenWorkspace, listTokenThemes, selectTokenThemes } from "./token-themes.mjs";

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const short = (value) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text === undefined ? "none" : text.length > 48 ? `${text.slice(0, 45)}...` : text;
};

// --- Tokens -----------------------------------------------------------------

// path -> {type, value, values: {"Group/Option": value}}: the default value
// and the value under each other option, as token list shows them.
function tokenTable(snapshot, foundation) {
  const workspace = defaultTokenWorkspace({ product: snapshot, foundation });
  const read = (selection) =>
    new Map(
      listEffectiveTokens(selection.product, { foundation: selection.foundation }).map((item) => [
        item.token.path,
        { type: item.token.type, value: item.value },
      ]),
    );
  const table = read(workspace);
  const themes = listTokenThemes(snapshot, foundation);
  for (const theme of themes) {
    const under = read(selectTokenThemes(workspace, [theme.path]));
    for (const [path, entry] of table) {
      const value = under.get(path)?.value;
      if (value !== undefined && !same(value, entry.value)) (entry.values ??= {})[theme.path] = value;
    }
  }
  return table;
}

function tokenChanges(before, after, options) {
  const old = tokenTable(before, options.beforeFoundation);
  const now = tokenTable(after, options.afterFoundation);
  const changes = [];
  for (const [path, entry] of now) {
    const previous = old.get(path);
    if (!previous) {
      changes.push({
        kind: "token",
        name: path,
        change: "added",
        detail: [`${entry.type} ${short(entry.value)}`, ...Object.entries(entry.values ?? {}).map(([option, value]) => `${option} ${short(value)}`)].join("; "),
      });
      continue;
    }
    const details = [];
    if (!same(previous.value, entry.value)) details.push(`${short(previous.value)} → ${short(entry.value)}`);
    const options = new Set([...Object.keys(previous.values ?? {}), ...Object.keys(entry.values ?? {})]);
    for (const option of options) {
      const from = previous.values?.[option] ?? previous.value;
      const to = entry.values?.[option] ?? entry.value;
      if (!same(from, to) && !(same(previous.value, from) && same(entry.value, to)))
        details.push(`${option} ${short(from)} → ${short(to)}`);
    }
    if (details.length) changes.push({ kind: "token", name: path, change: "changed", detail: details.join("; ") });
  }
  for (const [path] of old)
    if (!now.has(path)) changes.push({ kind: "token", name: path, change: "removed" });
  return changes.sort((left, right) => left.name.localeCompare(right.name));
}

// --- colors, typographies, fonts and media -------------------------------------

const ASSET_WORDS = { colors: "color", typographies: "typography", fonts: "font", media: "media" };

function assetTable(snapshot) {
  const table = new Map();
  for (const entry of snapshot?.manifest.entries.assets ?? [])
    for (const kind of Object.keys(ASSET_WORDS))
      for (const asset of snapshot.entries[entry]?.[kind] ?? []) table.set(`${kind}\0${asset.id}`, { kind, asset });
  return table;
}

function assetChanges(before, after) {
  const old = assetTable(before), now = assetTable(after);
  const nameOf = (asset) => asset.name ?? asset.family ?? asset.fontFamily ?? asset.id;
  const changes = [];
  for (const [key, { kind, asset }] of now) {
    const was = old.get(key)?.asset;
    const name = `${ASSET_WORDS[kind]} ${nameOf(asset)}`;
    if (!was) changes.push({ kind: "asset", name, change: "added", ...(asset.variants ? { detail: `${asset.variants.length} variant${asset.variants.length === 1 ? "" : "s"}` } : {}) });
    else if (nameOf(was) !== nameOf(asset)) changes.push({ kind: "asset", name, change: "renamed", detail: `was ${nameOf(was)}` });
    else if (!same(was, asset)) changes.push({ kind: "asset", name, change: "changed" });
  }
  for (const [key, { kind, asset }] of old)
    if (!now.has(key)) changes.push({ kind: "asset", name: `${ASSET_WORDS[kind]} ${nameOf(asset)}`, change: "removed" });
  return changes;
}

// --- themes -----------------------------------------------------------------

function themeChanges(before, after, options) {
  const old = listTokenThemes(before, options.beforeFoundation);
  const now = listTokenThemes(after, options.afterFoundation);
  const changes = [];
  for (const theme of now) {
    const previous = old.find(({ id }) => id === theme.id);
    if (!previous) changes.push({ kind: "theme", name: theme.path, change: "added" });
    else if (previous.path !== theme.path)
      changes.push({ kind: "theme", name: theme.path, change: "renamed", detail: `was ${previous.path}` });
  }
  for (const theme of old)
    if (!now.some(({ id }) => id === theme.id)) changes.push({ kind: "theme", name: theme.path, change: "removed" });
  return changes;
}

// --- nodes ------------------------------------------------------------------

function elementPath(nodes, rootId, id) {
  const parent = new Map();
  for (const [key, node] of Object.entries(nodes))
    for (const child of node.children ?? []) parent.set(child, key);
  const names = [];
  for (let at = id; at !== undefined; at = parent.get(at)) {
    if (at === rootId) break;
    names.unshift(nodes[at]?.name ?? at);
  }
  return names.join(" / ");
}

function paint(list) {
  const first = Array.isArray(list) ? list[0] : undefined;
  if (!first) return "none";
  return first.color ?? first.type ?? "paint";
}

const IGNORED = new Set(["id", "children", "interactions"]);

// Field changes of one node, merged into readable groups.
// What auto layout decides for a node: its place in a flex parent (unless
// it is absolute), and a size that fills or hugs. The App writes back what
// the layout computed; that is not a design change.
function layoutDecided(node, parent) {
  const flexChild = parent?.layout === "flex" && node["layout-item-absolute"] !== true;
  return {
    position: flexChild,
    width: flexChild && ["fill", "auto"].includes(node["layout-item-h-sizing"]),
    height: flexChild && ["fill", "auto"].includes(node["layout-item-v-sizing"]),
  };
}

function nodeFieldChanges(old, now, names, decided = {}) {
  const details = [];
  const changed = new Set(
    [...new Set([...Object.keys(old), ...Object.keys(now)])].filter(
      (key) => !IGNORED.has(key) && !same(old[key], now[key]),
    ),
  );
  const take = (key) => changed.delete(key);
  if (decided.width) take("width");
  if (decided.height) take("height");
  if (decided.position) {
    take("x");
    take("y");
  }
  // Bitwise | runs both takes.
  if (take("width") | take("height"))
    details.push(`size ${sizeOf(old)} → ${sizeOf(now)}`);
  if (take("x") | take("y"))
    details.push(`position ${Math.round(old.x ?? 0)},${Math.round(old.y ?? 0)} → ${Math.round(now.x ?? 0)},${Math.round(now.y ?? 0)}`);
  if (take("fills")) details.push(`fill ${paint(old.fills)} → ${paint(now.fills)}`);
  if (take("strokes")) details.push(`stroke ${paint(old.strokes)} → ${paint(now.strokes)}`);
  // Text and visibility read as their Token's name while they follow one,
  // so "text text.greeting → "Hi"" says the text stopped following it.
  const valueOf = (node, field) => {
    const token = node.tokenBindings?.[field];
    if (token) return names.token(token);
    return field === "text" ? `"${short(textOf(node))}"` : short(node.visible ?? true);
  };
  const textChanged = take("text") | take("textBlocks");
  const visibleChanged = take("visible");
  const bindingChanged = (field) => !same(old.tokenBindings?.[field], now.tokenBindings?.[field]);
  if (textChanged || bindingChanged("text")) details.push(`text ${valueOf(old, "text")} → ${valueOf(now, "text")}`);
  if (visibleChanged || bindingChanged("visible")) details.push(`visible ${valueOf(old, "visible")} → ${valueOf(now, "visible")}`);
  if (take("tokenBindings")) {
    const fields = new Set([...Object.keys(old.tokenBindings ?? {}), ...Object.keys(now.tokenBindings ?? {})]);
    for (const field of fields) {
      if (field === "text" || field === "visible") continue;
      const from = old.tokenBindings?.[field], to = now.tokenBindings?.[field];
      if (!same(from, to)) details.push(`${STYLE_WORDS[field] ?? FIELD_WORDS[field] ?? field} token ${from ? names.token(from) : "none"} → ${to ? names.token(to) : "none"}`);
    }
  }
  // A text style reads key by key: "font size 13 → 16".
  if (take("textStyle")) {
    const from = old.textStyle ?? {}, to = now.textStyle ?? {};
    for (const key of new Set([...Object.keys(from), ...Object.keys(to)]))
      if (!same(from[key], to[key]) && !/Id$/.test(key)) details.push(`${STYLE_WORDS[key] ?? key} ${short(from[key] ?? "none")} → ${short(to[key] ?? "none")}`);
  }
  if (take("instance")) {
    const from = old.instance ?? {}, to = now.instance ?? {};
    if (!same(from.variant, to.variant))
      details.push(`variant ${names.variant(from.component, from.variant)} → ${names.variant(to.component, to.variant)}`);
    if (!same(from.overrides, to.overrides))
      details.push(...overrideChanges(from.overrides ?? {}, to.overrides ?? {}, to.component ?? from.component, names));
    if (!same(from.component, to.component))
      details.push(`component ${names.component(from.component)} → ${names.component(to.component)}`);
  }
  for (const key of changed) {
    const word = FIELD_WORDS[key];
    if (word === null) continue;
    const value = (node) => short(VALUE_WORDS[node[key]] ?? node[key]);
    details.push(`${word ?? key} ${value(old)} → ${value(now)}`);
  }
  return details;
}

const STYLE_WORDS = {
  fontSize: "font size", fontWeight: "font weight", fontFamily: "font", lineHeight: "line height",
  letterSpacing: "letter spacing", textAlign: "text align", textTransform: "text case", textDecoration: "text decoration",
  typography: "typography", fill: "fill", stroke: "stroke", cornerRadius: "radius", itemSpacing: "gap",
  paddingTop: "padding top", paddingRight: "padding right", paddingBottom: "padding bottom", paddingLeft: "padding left",
};

// Stored field names in the words page draw uses; null is not a design
// change of its own (it comes with another field).
const FIELD_WORDS = {
  growType: "text size",
  "layout-item-h-sizing": "width",
  "layout-item-v-sizing": "height",
  "layout-flex-dir": "direction",
  "layout-gap": "gap",
  "layout-padding": "padding",
  "layout-padding-type": null,
  "layout-align-items": "align",
  "layout-justify-content": "justify",
  "layout-item-absolute": "placed freely",
  "layout-wrap-type": "wrap",
  "layout-item-margin": "margin",
  cornerRadius: "radius",
  textStyle: "text style",
  layout: "layout",
};
const VALUE_WORDS = { fix: "fixed", auto: "hug", "auto-width": "hug", "auto-height": "hug height", fixed: "fixed", flex: "auto layout" };

// A side that fills its parent is laid out by the App; say "fill".
function sizeOf(node) {
  const side = (value, sizing) => (sizing === "fill" ? "fill" : Math.round(value ?? 0));
  return `${side(node.width, node["layout-item-h-sizing"])}×${side(node.height, node["layout-item-v-sizing"])}`;
}

function textOf(node) {
  if (typeof node.text === "string") return node.text;
  if (Array.isArray(node.textBlocks)) return node.textBlocks.map((block) => block.text ?? "").join("");
  return undefined;
}

// Nodes inside a placed component copy ("parent__child") follow the
// component; only the copy itself (variant, overrides, size) is compared.
const ownNode = (id) => !String(id).includes("__");

// What changed in one placed copy's own values, element by element. A
// value that follows a Token shows the Token's name: "Label text
// text.task.new → "Add task"" means the label stopped following it.
function overrideChanges(old, now, component, names) {
  const bindingsOf = (overrides, element) => overrides[`${element}:tokenBindings`] ?? {};
  const shown = (overrides, element, field) => {
    const bound = Object.entries(bindingsOf(overrides, element))
      .filter(([binding, reference]) => reference && bindingTargetField(binding) === field)
      .map(([, reference]) => names.token(reference));
    if (bound.length) return bound.join("+");
    const raw = overrides[`${element}:${field}`];
    if (raw === undefined) return "none";
    if (field === "fills" || field === "strokes") return paint(raw);
    if (field === "variant") return names.variantOf(component, element, raw);
    return field === "text" ? `"${short(raw)}"` : short(raw);
  };
  const pairs = new Map();
  for (const key of new Set([...Object.keys(old), ...Object.keys(now)])) {
    if (same(old[key], now[key])) continue;
    const separator = key.lastIndexOf(":");
    const element = key.slice(0, separator);
    const field = key.slice(separator + 1);
    // Links from inside a copy are reported as links.
    if (field === "interactions") continue;
    if (field === "tokenBindings") {
      const before = old[key] ?? {}, after = now[key] ?? {};
      for (const binding of new Set([...Object.keys(before), ...Object.keys(after)]))
        if (!same(before[binding], after[binding])) {
          const target = bindingTargetField(binding);
          pairs.set(`${element}:${target}`, { element, field: target });
        }
      continue;
    }
    pairs.set(`${element}:${field}`, { element, field });
  }
  const label = { fills: "fill", strokes: "stroke", cornerRadius: "radius", textStyle: "text style" };
  // One line per element and field, by name: an element whose id changed
  // (one "none → X", one "X → none") reads as what really changed, or not
  // at all.
  const merged = new Map();
  for (const { element, field } of [...pairs.values()].sort((left, right) => `${left.element}:${left.field}`.localeCompare(`${right.element}:${right.field}`))) {
    const key = `${names.element(component, element)} ${label[field] ?? field}`;
    const from = shown(old, element, field), to = shown(now, element, field);
    const entry = merged.get(key) ?? { from: "none", to: "none" };
    if (from !== "none") entry.from = from;
    if (to !== "none") entry.to = to;
    merged.set(key, entry);
  }
  return [...merged].filter(([, { from, to }]) => from !== to).map(([key, { from, to }]) => `${key} ${from} → ${to}`);
}

function nodeChanges(where, before, after, names) {
  const changes = [];
  const oldNodes = before?.nodes ?? {}, newNodes = after?.nodes ?? {};
  for (const [id, node] of Object.entries(newNodes)) {
    if (!ownNode(id)) continue;
    // The root is the page version or variant itself.
    const name = id === after.rootId ? undefined : elementPath(newNodes, after.rootId, id) || node.name;
    const previous = oldNodes[id];
    if (!previous) {
      changes.push({ where, element: name, change: "added" });
      continue;
    }
    const parent = Object.values(newNodes).find((candidate) => candidate.children?.includes(id));
    // The root's name is the page's or the variant's: their rename says it.
    const details = id === after.rootId
      ? nodeFieldChanges({ ...previous, name: node.name }, node, names, layoutDecided(node, parent))
      : nodeFieldChanges(previous, node, names, layoutDecided(node, parent));
    // The same children in another order (in reading order: a flex line
    // places its last stored child first).
    const kept = (node.children ?? []).filter((child) => (previous.children ?? []).includes(child));
    const keptBefore = (previous.children ?? []).filter((child) => kept.includes(child));
    if (kept.length > 1 && !same(kept, keptBefore)) {
      const reading = (ids, holder) => (holder.layout === "flex" && !String(holder["layout-flex-dir"] ?? "row").endsWith("reverse") ? [...ids].reverse() : ids);
      const label = (ids, holder, table) => reading(ids, holder).map((child) => table[child]?.name ?? child).join(", ");
      details.push(`order ${label(keptBefore, previous, oldNodes)} → ${label(kept, node, newNodes)}`);
    }
    if (details.length) changes.push({ where, element: name, change: "changed", detail: details.join("; ") });
  }
  for (const [id, node] of Object.entries(oldNodes))
    if (ownNode(id) && !newNodes[id])
      changes.push({ where, element: elementPath(oldNodes, before.rootId, id) || node.name, change: "removed" });
  return changes;
}

// --- components -------------------------------------------------------------

function variantLabel(set, variant) {
  return set.axes.map((axis) => `${axis.name}=${variant.selection?.[axis.id]}`).join(", ");
}

// Several variants in one phrase: "Content=leading|trailing|icon" when they
// are every combination of those values, else "36 of 48 variants".
function variantsText(set, variants, labels) {
  if (variants.length <= 3) return labels.filter(Boolean).join("; ");
  const values = set.axes.map((axis) => [...new Set(variants.map((variant) => variant.selection?.[axis.id]))]);
  const combinations = values.reduce((total, list) => total * list.length, 1);
  if (combinations === variants.length) {
    const parts = set.axes
      .map((axis, index) => [axis, values[index]])
      .filter(([axis, list]) => list.length < axis.domain.length)
      .map(([axis, list]) => `${axis.name}=${list.join("|")}`);
    if (parts.length) return `${parts.join(", ")}; ${variants.length} variants`;
  }
  return `${variants.length} of ${set.variants.length} variants`;
}

function componentChanges(before, after, names) {
  const changes = [];
  const old = before.domain.componentSets;
  for (const set of after.domain.componentSets.values()) {
    const previous = old.get(set.id);
    if (!previous) {
      changes.push({ kind: "component", name: set.name, change: "added", detail: `${set.variants.length} variant${set.variants.length === 1 ? "" : "s"}` });
      continue;
    }
    if (previous.name !== set.name)
      changes.push({ kind: "component", name: set.name, change: "renamed", detail: `was ${previous.name}` });
    const axes = (list) => list.map((axis) => `${axis.name}: ${axis.domain.join("|")}`).join(" · ");
    if (axes(previous.axes) !== axes(set.axes))
      changes.push({ kind: "component", name: set.name, change: "changed", detail: `properties ${axes(previous.axes) || "none"} → ${axes(set.axes) || "none"}` });
    // The same element change in every variant is reported once.
    const grouped = new Map();
    for (const variant of set.variants) {
      const label = variantLabel(set, variant);
      const before = previous.variants.find(({ id }) => id === variant.id);
      if (!before) {
        changes.push({ kind: "component", name: `${set.name} (${label})`, change: "added" });
        continue;
      }
      for (const change of nodeChanges(label, before, variant, names)) {
        const key = `${change.element}\0${change.change}\0${change.detail ?? ""}`;
        if (!grouped.has(key)) grouped.set(key, { ...change, labels: [], variants: [] });
        grouped.get(key).labels.push(label);
        grouped.get(key).variants.push(variant);
      }
    }
    for (const change of grouped.values())
      changes.push({
        kind: "component",
        name: (() => {
          const labels = change.labels.length === set.variants.length && set.variants.length > 1 ? "all variants" : variantsText(set, change.variants, change.labels);
          return labels ? `${set.name} (${labels})` : set.name;
        })(),
        element: change.element,
        change: change.change,
        ...(change.detail ? { detail: change.detail } : {}),
      });
    for (const variant of previous.variants)
      if (!set.variants.some(({ id }) => id === variant.id))
        changes.push({ kind: "component", name: `${set.name} (${variantLabel(previous, variant)})`, change: "removed" });
  }
  for (const set of old.values())
    if (!after.domain.componentSets.has(set.id)) changes.push({ kind: "component", name: set.name, change: "removed" });
  return changes;
}

// --- pages ------------------------------------------------------------------

function screensOf(snapshot) {
  return new Map(snapshot.manifest.entries.screens.map((entry) => [snapshot.entries[entry].id, snapshot.entries[entry]]));
}

// "desktop 840×501, 21 elements, uses Title, Badge, Button".
function pageContents(presentation, names) {
  const root = presentation.nodes[presentation.rootId] ?? {};
  const own = Object.keys(presentation.nodes).filter((id) => ownNode(id) && id !== presentation.rootId);
  const used = [...new Set(own.map((id) => presentation.nodes[id].instance?.component).filter(Boolean).map(names.component))];
  return [
    `${presentation.platform ?? presentation.name} ${Math.round(root.width ?? 0)}×${Math.round(root.height ?? 0)}`,
    `${own.length} element${own.length === 1 ? "" : "s"}`,
    ...(used.length ? [`uses ${used.join(", ")}`] : []),
  ].join(", ");
}

function pageChanges(before, after, names) {
  const changes = [];
  const old = screensOf(before), now = screensOf(after);
  for (const [id, screen] of now) {
    const previous = old.get(id);
    if (!previous) {
      changes.push({ kind: "page", name: screen.name, change: "added", detail: screen.presentations.map((presentation) => pageContents(presentation, names)).join("; ") });
      continue;
    }
    if (previous.name !== screen.name)
      changes.push({ kind: "page", name: screen.name, change: "renamed", detail: `was ${previous.name}` });
    for (const presentation of screen.presentations) {
      const platform = presentation.platform ?? presentation.name;
      const was = previous.presentations.find(({ id: other }) => other === presentation.id);
      if (!was) {
        changes.push({ kind: "page", name: `${screen.name} (${platform})`, change: "added", detail: pageContents(presentation, names) });
        continue;
      }
      for (const change of nodeChanges(platform, was, presentation, names))
        changes.push({ kind: "page", name: `${screen.name} (${platform})`, element: change.element, change: change.change, ...(change.detail ? { detail: change.detail } : {}) });
      if (!same(was.interactions ?? [], presentation.interactions ?? []))
        changes.push({ kind: "page", name: `${screen.name} (${platform})`, change: "changed", detail: "links changed" });
    }
    for (const presentation of previous.presentations)
      if (!screen.presentations.some(({ id: other }) => other === presentation.id))
        changes.push({ kind: "page", name: `${screen.name} (${presentation.platform ?? presentation.name})`, change: "removed" });
  }
  for (const [id, screen] of old)
    if (!now.has(id)) changes.push({ kind: "page", name: screen.name, change: "removed" });
  return changes;
}

// --- links ------------------------------------------------------------------

const linkText = (link) => `${link.on} → ${link.to ?? link.action}${link.to && link.action !== "navigate" ? ` (${link.action})` : ""}`;

function linkChanges(before, after, options = {}) {
  const changes = [];
  const index = (links) => {
    const map = new Map();
    for (const link of links) {
      const at = `${link.screenId}\0${link.presentationId}\0${link.nodeId}\0${link.sourcePath ?? ""}`;
      map.set(at, [...(map.get(at) ?? []), link]);
    }
    return map;
  };
  const old = flowLinks(before, { foundation: options.beforeFoundation }), now = flowLinks(after, { foundation: options.afterFoundation });
  const oldLinks = index(old.links), newLinks = index(now.links);
  for (const at of new Set([...oldLinks.keys(), ...newLinks.keys()])) {
    const was = (oldLinks.get(at) ?? []).map(linkText), is = (newLinks.get(at) ?? []).map(linkText);
    if (same(was, is)) continue;
    const link = (newLinks.get(at) ?? oldLinks.get(at))[0];
    const name = `${link.page} (${link.platform})`;
    const added = is.filter((text) => !was.includes(text)), removed = was.filter((text) => !is.includes(text));
    for (const text of added) changes.push({ kind: "page", name, element: link.element, change: "link added", detail: text });
    for (const text of removed) changes.push({ kind: "page", name, element: link.element, change: "link removed", detail: text });
  }
  const startKey = (start) => `${start.screenId}\0${start.presentationId}`;
  const oldStarts = new Set(old.starts.map(startKey)), newStarts = new Set(now.starts.map(startKey));
  for (const start of now.starts)
    if (!oldStarts.has(startKey(start))) changes.push({ kind: "page", name: `${start.page} (${start.platform})`, change: "made a start" });
  for (const start of old.starts)
    if (!newStarts.has(startKey(start))) changes.push({ kind: "page", name: `${start.page} (${start.platform})`, change: "no longer a start" });
  return changes;
}

// --- canvases ----------------------------------------------------------------

// Canvases added, renamed or removed; pages put on another canvas; the
// order of a business flow's pages.
function canvasChanges(before, after) {
  const changes = [];
  const pageNames = new Map();
  for (const snapshot of [after, before])
    for (const entry of snapshot.manifest.entries.screens) {
      const screen = snapshot.entries[entry];
      if (!pageNames.has(screen.id)) pageNames.set(screen.id, screen.name);
    }
  const old = resolveCanvases(before.manifest, before.entries);
  const now = resolveCanvases(after.manifest, after.entries);
  const canvasOf = (canvases) => new Map(canvases.flatMap((canvas) => canvas.screens.map((id) => [id, canvas])));
  const oldCanvasOf = canvasOf(old), newCanvasOf = canvasOf(now);
  for (const canvas of now) {
    const was = old.find(({ id }) => id === canvas.id);
    if (!was) changes.push({ kind: "canvas", name: canvas.name, change: "added" });
    else if (was.name !== canvas.name) changes.push({ kind: "canvas", name: canvas.name, change: "renamed", detail: `was ${was.name}` });
  }
  for (const canvas of old)
    if (!now.some(({ id }) => id === canvas.id)) changes.push({ kind: "canvas", name: canvas.name, change: "removed" });
  for (const [id, canvas] of newCanvasOf) {
    const was = oldCanvasOf.get(id);
    if (was && was.id !== canvas.id)
      changes.push({ kind: "canvas", name: canvas.name, element: pageNames.get(id), change: "page moved here", detail: `from ${was.name}` });
  }
  // Flow order, per canvas and business flow, among pages on both sides.
  const orders = (snapshot) => {
    const map = new Map();
    for (const canvas of canvasLayout(snapshot.manifest, snapshot.entries, snapshot.runtime))
      for (const board of canvas.boards) {
        const at = `${canvas.id ?? canvas.name}\0${board.flow}`;
        const list = map.get(at) ?? { canvas: canvas.name, flow: board.flow, pages: [] };
        if (!list.pages.includes(board.screenId)) list.pages.push(board.screenId);
        map.set(at, list);
      }
    return map;
  };
  // Order follows starts and links, which are reported themselves; only a
  // page moved in the stored order (a drag in the App, canvas put) is news.
  const storedMoved = (canvasId) => {
    const was = old.find(({ id }) => id === canvasId)?.screens ?? [];
    const is = now.find(({ id }) => id === canvasId)?.screens ?? [];
    const kept = is.filter((id) => was.includes(id));
    return !same(kept, was.filter((id) => kept.includes(id)));
  };
  const oldOrders = orders(before);
  for (const [at, list] of orders(after)) {
    const was = oldOrders.get(at);
    if (!was || !storedMoved(at.split("\0")[0])) continue;
    const kept = list.pages.filter((id) => was.pages.includes(id));
    const keptBefore = was.pages.filter((id) => list.pages.includes(id));
    if (kept.length > 1 && !same(kept, keptBefore))
      changes.push({
        kind: "canvas",
        name: list.canvas,
        element: list.flow ? `${list.flow} row` : "Other pages",
        change: "page order",
        detail: `${kept.map((id) => pageNames.get(id)).join(", ")} (was ${keptBefore.map((id) => pageNames.get(id)).join(", ")})`,
      });
  }
  return changes;
}

// --- all --------------------------------------------------------------------

export function designChanges(before, after, options = {}) {
  const paths = new Map();
  for (const snapshot of [after, before, options.afterFoundation, options.beforeFoundation])
    for (const token of snapshot?.domain.tokens.values() ?? []) if (!paths.has(token.id)) paths.set(token.id, token.path);
  // Element names inside components, by source node id.
  const elements = new Map();
  const sets = new Map();
  for (const snapshot of [after, before, options.afterFoundation, options.beforeFoundation])
    for (const set of snapshot?.domain.componentSets.values() ?? []) {
      if (!sets.has(set.id)) sets.set(set.id, set);
      for (const variant of set.variants)
        for (const [id, node] of Object.entries(variant.nodes))
          if (!elements.has(`${set.id}\0${id}`)) elements.set(`${set.id}\0${id}`, node.name ?? id);
    }
  const names = {
    component: (reference) => sets.get(reference?.assetId)?.name ?? "none",
    // A nested copy's variant, by the axes of the component it places.
    variantOf: (reference, element, selection) => {
      const set = sets.get(reference?.assetId);
      const nested = set?.variants.flatMap((variant) => [variant.nodes[element]]).find(Boolean);
      const inner = sets.get(nested?.instance?.component?.assetId);
      return inner ? inner.axes.filter((axis) => selection[axis.id] !== undefined).map((axis) => `${axis.name}=${selection[axis.id]}`).join(", ") : short(selection);
    },
    variant: (reference, selection) => {
      const set = sets.get(reference?.assetId);
      if (!set || !selection) return short(selection);
      return set.axes.map((axis) => `${axis.name}=${selection[axis.id]}`).join(", ") || "default";
    },
    token: (reference) => paths.get(reference?.assetId) ?? reference?.assetId ?? "none",
    element: (component, id) => elements.get(`${component?.assetId}\0${id}`) ?? id,
  };
  return [
    ...themeChanges(before, after, options),
    ...tokenChanges(before, after, options),
    ...assetChanges(before, after),
    ...componentChanges(before, after, names),
    ...pageChanges(before, after, names),
    ...linkChanges(before, after, options),
    ...canvasChanges(before, after),
  ];
}

const HEADINGS = { theme: "Themes", token: "Tokens", asset: "Assets", component: "Components", page: "Pages", canvas: "Canvases" };

export function designChangesText(changes) {
  const lines = [];
  for (const kind of Object.keys(HEADINGS)) {
    const members = changes.filter((change) => change.kind === kind);
    if (!members.length) continue;
    lines.push(HEADINGS[kind]);
    for (const change of members)
      lines.push(
        `  ${change.name}${change.element ? ` / ${change.element}` : ""}: ${change.change}${change.detail ? ` — ${change.detail}` : ""}`,
      );
  }
  return lines.join("\n") || "No design changes.";
}
