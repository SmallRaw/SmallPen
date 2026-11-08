// INPUT:  a loaded package snapshot (manifest, entries, blobs, runtime)
// OUTPUT: canonical package files: path -> text or bytes
// POS:    The single HTML writer behind App saves and fixture conversion.
//         Content the HTML format cannot hold fails; nothing is dropped.

import { cssTokenLibrary, decodeTokensCss, encodeTokensCss, resolveTokenValue } from "./tokens-codec.mjs";
import {
  createClassWriter,
  encodeTree,
  escapeAttribute,
  escapeText,
  GROUP_RESETS,
  interactionAttributes,
  nodeClasses,
  textContent,
  textStyleClasses,
  unsupported,
  visualClasses,
} from "./node-encode.mjs";
import { formatLength, tokenTypeOfName } from "./vocabulary.mjs";
import { cellsByChild, explicitLines } from "./grid-cells.mjs";
import { PLATFORM_SIZES } from "./package-decode.mjs";
import { quoteCss } from "./css-parse.mjs";

const MEDIA_EXTENSIONS = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg",
};
const PAGE_SEGMENT = /^[^/\\:*?"<>|.]+$/;
const PLATFORMS = new Set(["desktop", "mobile", "tablet"]);

function slugFile(text) {
  return String(text).trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ") || "file";
}

function relativeFrom(file, target) {
  const depth = file.split("/").length - 1;
  return `${"../".repeat(depth)}${target}`;
}

function uniquePath(used, path) {
  if (!used.has(path)) {
    used.add(path);
    return path;
  }
  const dot = path.lastIndexOf(".");
  for (let counter = 2; ; counter += 1) {
    const candidate = `${path.slice(0, dot)}-${counter}${path.slice(dot)}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

// Files plus the identity map (identity key -> id) that lets a reader give
// every element, Token and page the ids this snapshot already uses.
export function encodePackage(snapshot) {
  const { manifest, entries } = snapshot;
  const blobs = snapshot.blobs ?? new Map();
  const files = new Map();
  // Asset files are written by reference (path -> blob key): the writer
  // copies bytes only for assets that are new or changed.
  const assets = new Map();
  const identity = new Map();
  const remember = (prefix, key, id) => {
    if (id !== undefined) identity.set(`${prefix}\0${key}`, id);
  };
  const rememberTree = (nodes, rootId, scopeKey, { keep = false } = {}) => {
    const visit = (id, path) => {
      const entry = `node\0${scopeKey}\0${path.join("\0")}`;
      if (!(keep && identity.has(entry))) remember("node", `${scopeKey}\0${path.join("\0")}`, id);
      for (const child of nodes[id]?.children ?? []) visit(child, [...path, nodes[child]?.name]);
    };
    visit(rootId, []);
  };
  assertManifest(manifest);

  // Tokens and fonts.
  const tokenEntries = manifest.entries.tokens.map((entry) => entries[entry]);
  for (const [index, library] of tokenEntries.entries()) {
    if (!Array.isArray(library?.sets) || !Array.isArray(library?.themes)) {
      throw unsupported(`${manifest.entries.tokens[index]}: DTCG Token files are not supported; use tokens.css`);
    }
  }
  if (tokenEntries.length > 1) throw unsupported("Only one Token library is supported");
  const library = cssTokenLibrary(tokenEntries[0] ?? { sets: [], themes: [], activeSetIds: [], activeThemeIds: [] });
  const assetLibraries = manifest.entries.assets.map((entry) => entries[entry]);
  const usedAssetPaths = new Set();
  const mediaPaths = new Map();
  const fontFaces = [];
  for (const assetLibrary of assetLibraries) {
    if (assetLibrary.colors?.length || assetLibrary.typographies?.length) {
      throw unsupported("Color and typography styles are not supported; use Tokens");
    }
    for (const media of assetLibrary.media ?? []) {
      const extension = MEDIA_EXTENSIONS[media.mimeType];
      if (!extension) throw unsupported(`Media ${media.name}: ${media.mimeType} is not supported`);
      const path = uniquePath(usedAssetPaths, `assets/${slugFile(media.name)}.${extension}`);
      if (!blobs.has(media.blob)) throw unsupported(`Media ${media.name}: its bytes are missing`);
      assets.set(path, media.blob);
      mediaPaths.set(media.id, path);
      remember("media", `media\0${path}`, media.id);
    }
    for (const font of assetLibrary.fonts ?? []) {
      for (const variant of font.variants ?? []) {
        const [format, file] = Object.entries(variant.files)[0] ?? [];
        if (Object.keys(variant.files).length > 1) {
          // One file per weight/style; prefer the original order.
        }
        if (!file) continue;
        const style = variant.style === "italic" ? "-italic" : "";
        const path = uniquePath(usedAssetPaths, `assets/fonts/${slugFile(font.family).replace(/ /g, "")}-${variant.weight}${style}.${format}`);
        if (!blobs.has(file.blob)) throw unsupported(`Font ${font.family}: its bytes are missing`);
        assets.set(path, file.blob);
        remember("font", `font\0${font.family}`, font.id);
        remember("fvar", `fvar\0${font.family}\0${Number(variant.weight)}\0${variant.style}`, variant.id);
        fontFaces.push(
          `@font-face {\n  font-family: ${quoteCss(font.family)};\n  src: url(${quoteCss(path)});\n  font-weight: ${variant.weight};\n  font-style: ${variant.style};\n}`,
        );
      }
    }
  }
  const { css, defaults, identity: tokenIdentity } = encodeTokensCss(library, { fontFaces });
  files.set("tokens.css", css);
  for (const [key, id] of tokenIdentity) identity.set(key, id);

  // A Token resolver over the written tokens.css, for typography values.
  const decoded = decodeTokensCss(css, new Map(defaults));
  const selection = new Map(defaults);
  const tokenNameById = new Map();
  for (const set of library.sets ?? []) for (const token of set.tokens ?? []) tokenNameById.set(token.id, token.name);
  const tokenName = (binding) =>
    binding?.packageId === manifest.packageId ? tokenNameById.get(binding.assetId) : undefined;
  const tokenValue = (name) => resolveTokenValue(decoded.tokens, name, selection);

  // Components.
  const componentSets = [];
  for (const entry of manifest.entries.components) {
    if (!Array.isArray(entries[entry].componentSets)) {
      throw unsupported(`Component ${entries[entry].name ?? entry}: a page element cannot be a component; define components in components/*.html`);
    }
    for (const set of entries[entry].componentSets) componentSets.push({ entry, set });
  }
  const componentById = new Map(componentSets.map(({ set }) => [set.id, set]));

  // Pages.
  const screens = manifest.entries.screens.map((entry) => entries[entry]);
  const screenById = new Map(screens.map((screen) => [screen.id, screen]));
  const pageKey = (screen) => {
    const parts = String(screen.name).split(" / ");
    if (parts.length > 2 || parts.some((part) => !PAGE_SEGMENT.test(part))) {
      throw unsupported(`Page ${screen.name}: a page is named "Module / Page" or "Page" without / \\ : * ? " < > | or dots`);
    }
    return parts.join("/");
  };
  const reverseNodes = snapshot.runtime?.reverseNodes ?? {};
  // Destinations and relative-to boards of interactions, by App id. nodes
  // and rootId are the page's when the element is on a page.
  const interactionLookups = (nodes, rootId) => (path, sourceNodeId) => ({
    unsupported: (message) => unsupported(message, { path }),
    page: (destination) => {
      const target = reverseNodes[destination];
      const screen = target && screenById.get(target.screenId);
      if (!screen) throw unsupported(`${path}: the link target is not a page in this package`, { path });
      return pageKey(screen);
    },
    relativeTo: (runtimeId) => {
      const target = reverseNodes[runtimeId];
      if (!target || !nodes) throw unsupported(`${path}: an overlay placed relative to an element works on page elements only`, { path });
      if (target.nodeId === sourceNodeId) return "self";
      if (target.nodeId === rootId) return "page";
      const parents = new Map();
      for (const [id, node] of Object.entries(nodes)) for (const child of node.children ?? []) parents.set(child, id);
      const wanted = nodes[target.nodeId]?.name?.toLowerCase();
      for (let current = parents.get(sourceNodeId); current && current !== rootId; current = parents.get(current)) {
        if (current === target.nodeId) return nodes[current].name;
        if (nodes[current].name.toLowerCase() === wanted) break;
      }
      throw unsupported(`${path}: the overlay is placed relative to an element that is not a board around this one`, { path });
    },
  });

  const baseCtx = {
    tokenName,
    tokenValue,
    componentById: (id, packageId) => (packageId === undefined || packageId === manifest.packageId ? componentById.get(id) : undefined),
    mediaPath: (mediaRef, file) => {
      const id = typeof mediaRef === "string" ? mediaRef : mediaRef?.assetId;
      const path = mediaPaths.get(id);
      return path && relativeFrom(file, path);
    },
    interactionLookups: interactionLookups(undefined, undefined),
  };
  // Called on the page or component ctx, so overrides see its file.
  baseCtx.instanceOverrides = function instanceOverrides(node, depth, path) {
    return instanceOverrideLines(node, depth, path, this, componentById);
  };
  // The root a copy is made from: a copy as big as it needs no size class.
  baseCtx.instanceRoot = (node) => {
    const source = sourceVariant(componentById.get(node.instance?.component?.assetId), node.instance?.variant);
    return source?.nodes[source.rootId];
  };

  const canvasByScreen = new Map();
  for (const canvas of manifest.canvases ?? []) {
    for (const screenId of canvas.screens) canvasByScreen.set(screenId, canvas.name);
  }
  const autoDefault = screens.find((screen) => screen.presentations.some((presentation) => presentation.prototypeFlows?.length)) ?? screens[0];

  for (const screen of screens) {
    if (screen.counterparts?.length) throw unsupported(`Page ${screen.name}: counterparts are not supported`);
    const key = pageKey(screen);
    const page = key.split("/").at(-1);
    const seen = new Set();
    for (const presentation of screen.presentations) {
      const platform = presentation.platform ?? presentation.name;
      if (!PLATFORMS.has(platform)) throw unsupported(`Page ${screen.name}: version ${presentation.name} is not desktop, mobile or tablet`);
      if (seen.has(platform)) throw unsupported(`Page ${screen.name} has two ${platform} versions`);
      seen.add(platform);
      if (presentation.interactions?.length) throw unsupported(`Page ${screen.name}: Canonical interactions are not supported; use element links`);
      if (presentation.rootIds?.length > 1) throw unsupported(`Page ${screen.name}: a page has one root`);
      const file = `pages/${key}${platform === "desktop" ? "" : `.${platform}`}.html`;
      const rootId = presentation.rootId ?? presentation.rootIds?.[0];
      remember("scr", `scr\0${key}`, screen.id);
      remember("pres", `pres\0${key}\0${platform}`, presentation.id);
      const pageNodes = withDistinctNames(presentation.nodes, rootId);
      rememberTree(pageNodes, rootId, `${key}\0${platform}`);
      const rootAttributes = [];
      const flows = presentation.prototypeFlows ?? [];
      if (flows.length > 1) throw unsupported(`Page ${screen.name}: one flow start per page`);
      if (flows.length === 1) {
        if (flows[0].startingNodeId !== rootId) throw unsupported(`Page ${screen.name}: a flow starts at the page itself`);
        rootAttributes.push(`data-flow="${escapeAttribute(flows[0].name)}"`);
      }
      const canvas = canvasByScreen.get(screen.id);
      if (canvas) rootAttributes.push(`data-canvas="${escapeAttribute(canvas)}"`);
      const ctx = {
        ...baseCtx,
        platformSize: PLATFORM_SIZES[platform],
        currentFile: file,
        interactionLookups: interactionLookups(pageNodes, rootId),
      };
      const body = encodeTree(pageNodes, rootId, ctx, {
        kind: "page",
        file,
        label: `${screen.name} (${platform})`,
        rootName: `${page} · ${platform}`,
        rootAttributes,
      });
      files.set(
        file,
        [
          "<!doctype html>",
          "<html>",
          "<head>",
          '  <meta charset="utf-8">',
          `  <title>${escapeText(page)}</title>`,
          `  <link rel="stylesheet" href="${relativeFrom(file, "tokens.css")}">`,
          "</head>",
          ...body,
          "</html>",
          "",
        ].join("\n"),
      );
    }
  }

  // Component files: one per entry when the entry is already a component
  // file, otherwise one per component.
  const byFile = new Map();
  for (const { entry, set } of componentSets) {
    // A component file keeps its entry; any other entry keeps its grouping
    // under the same base name.
    const file = /^components\/[^/]+\.html$/.test(entry)
      ? entry
      : `components/${slugFile(entry.split("/").at(-1).replace(/\.[^.]+$/, "") || set.name)}.html`;
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(set);
  }
  for (const [file, sets] of byFile) {
    for (const set of sets) {
      remember("cmp", `cmp\0${set.name}`, set.id);
      for (const axis of set.axes ?? []) remember("axis", `axis\0${set.name}\0${axis.name}`, axis.id);
      // The default variant's ids win for parts every variant shares.
      const isDefault = (variant) => (set.axes ?? []).every((axis) => variant.selection[axis.id] === axis.domain?.[0]);
      const ordered = [...(set.variants ?? [])].sort((left, right) => Number(isDefault(right)) - Number(isDefault(left)));
      for (const variant of ordered) {
        const combo = (set.axes ?? []).map((axis) => variant.selection[axis.id]);
        remember("var", `var\0${set.name}\0${combo.join("\0")}`, variant.id);
        rememberTree(withDistinctNames(variant.nodes, variant.rootId), variant.rootId, `cmp\0${set.name}`, { keep: true });
      }
    }
    const blocks = sets.map((set) => encodeComponent(set, { ...baseCtx, platformSize: undefined, currentFile: file }, file));
    files.set(file, `${blocks.join("\n\n")}\n`);
  }

  // index.html
  const head = [
    "<!doctype html>",
    `<html${defaults.map(([group, option]) => ` data-${group}="${escapeAttribute(option)}"`).join("")}>`,
    "<head>",
    '  <meta charset="utf-8">',
    `  <title>${escapeText(manifest.name)}</title>`,
    `  <meta name="smallpen:package-id" content="${escapeAttribute(manifest.packageId)}">`,
  ];
  const defaultScreen = manifest.defaultScreenId && screenById.get(manifest.defaultScreenId);
  if (defaultScreen && defaultScreen !== autoDefault) {
    head.push(`  <meta name="smallpen:default-page" content="${escapeAttribute(pageKey(defaultScreen))}">`);
  }
  // A canvas the App made that holds no page yet has no page to carry its
  // data-canvas; index.html declares it.
  for (const canvas of manifest.canvases ?? []) {
    if (!canvas.screens?.length) head.push(`  <meta name="smallpen:canvas" content="${escapeAttribute(canvas.name)}">`);
  }
  files.set("index.html", [...head, "</head>", "<body></body>", "</html>", ""].join("\n"));
  for (const canvas of manifest.canvases ?? []) remember("cnv", `cnv\0${canvas.name}`, canvas.id);
  return { files, assets, identity };
}

function assertManifest(manifest) {
  if (manifest.role !== "foundation") throw unsupported("Product packages with a Foundation are not supported; use one package");
  if (manifest.dependencies?.length) throw unsupported("Package dependencies are not supported");
  if (manifest.libraries?.length) throw unsupported("Remote libraries are not supported");
  if (manifest.draft) throw unsupported("Draft packages are not supported");
  for (const kind of ["contexts", "requirements", "scenarios"]) {
    if (manifest.entries[kind]?.length) throw unsupported(`${kind} are not supported`);
  }
  if (manifest.entries.assets.length > 1) throw unsupported("One asset library is supported");
}

// --- Components ---------------------------------------------------------

function nodePaths(nodes, rootId) {
  const paths = new Map();
  const parents = new Map();
  const visit = (id, path, parent) => {
    paths.set(id, path);
    parents.set(id, parent);
    for (const child of nodes[id]?.children ?? []) visit(child, [...path, nodes[child].name], id);
  };
  visit(rootId, [], undefined);
  return { paths, parents };
}

// JSON with sorted keys, for comparing model values.
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

// Siblings need distinct names to be found by name; later repeats are
// numbered as a copied layer is ("Icon", "Icon 2"). Returns cloned nodes.
export function withDistinctNames(nodes, rootId) {
  const copy = structuredClone(nodes);
  const visit = (id) => {
    const node = copy[id];
    if (!node) return;
    const used = new Set();
    for (const childId of node.children ?? []) {
      const child = copy[childId];
      if (!child) continue;
      const base = String(child.name ?? "");
      let name = base;
      for (let counter = 2; used.has(name.toLowerCase()); counter += 1) name = `${base} ${counter}`;
      used.add(name.toLowerCase());
      child.name = name;
      visit(childId);
    }
  };
  visit(rootId);
  return copy;
}

// Gives every variant the same layers: the union of all variants' layers,
// in an order every variant agrees with. A layer a variant lacks is added
// to it hidden. Returns variant-like { nodes, rootId } per combination.
function alignVariants(set, combos, variants) {
  const key = (path) => path.join("\0");
  const prepared = combos.map((combo) => {
    const variant = variants.get(combo.join("\0"));
    const nodes = withDistinctNames(variant.nodes, variant.rootId);
    const { paths } = nodePaths(nodes, variant.rootId);
    const byPath = new Map([...paths].map(([id, path]) => [key(path), id]));
    return { combo, nodes, rootId: variant.rootId, byPath, paths };
  });
  const base = prepared[0];
  // Union structure: path -> { id, source node, child path keys in order }.
  const union = new Map();
  const usedIds = new Set();
  const addNode = (pathKey, id, node, hidden) => {
    let unionId = id;
    for (let counter = 2; usedIds.has(unionId); counter += 1) unionId = `${id}_${counter}`;
    usedIds.add(unionId);
    const source = structuredClone(node);
    if (hidden) source.visible = false;
    union.set(pathKey, { id: unionId, source, children: [] });
  };
  for (const [id, path] of base.paths) addNode(key(path), id, base.nodes[id], false);
  for (const [id, path] of base.paths) {
    union.get(key(path)).children = (base.nodes[id].children ?? []).map((child) => key([...path, base.nodes[child].name]));
  }
  for (const variant of prepared.slice(1)) {
    const ordered = [...variant.paths].sort((left, right) => left[1].length - right[1].length);
    for (const [id, path] of ordered) {
      const pathKey = key(path);
      if (union.has(pathKey)) continue;
      addNode(pathKey, id, variant.nodes[id], true);
      const parentKey = key(path.slice(0, -1));
      const parentId = variant.byPath.get(parentKey);
      const siblings = (variant.nodes[parentId].children ?? []).map((child) => key([...path.slice(0, -1), variant.nodes[child].name]));
      const list = union.get(parentKey).children;
      let position = 0;
      for (const sibling of siblings.slice(0, siblings.indexOf(pathKey)).reverse()) {
        const at = list.indexOf(sibling);
        if (at !== -1) {
          position = at + 1;
          break;
        }
      }
      list.splice(position, 0, pathKey);
    }
  }
  // Every variant must agree with the union order.
  for (const variant of prepared) {
    for (const [id, path] of variant.paths) {
      const own = (variant.nodes[id].children ?? []).map((child) => key([...path, variant.nodes[child].name]));
      const order = union.get(key(path)).children.filter((child) => own.includes(child));
      if (order.join("\u0001") !== own.join("\u0001")) {
        throw unsupported(`Component ${set.name}: variant ${variant.combo.join(", ")} orders layers differently from the others; use one order and hide the layers a variant does not show`);
      }
    }
  }
  const aligned = new Map();
  for (const variant of prepared) {
    const nodes = {};
    for (const [pathKey, entry] of union) {
      const ownId = variant.byPath.get(pathKey);
      const node = ownId !== undefined ? structuredClone(variant.nodes[ownId]) : structuredClone(entry.source);
      if (ownId === undefined) node.visible = false;
      node.id = entry.id;
      node.children = entry.children.map((child) => union.get(child).id);
      nodes[entry.id] = node;
    }
    aligned.set(variant.combo.join("\0"), { nodes, rootId: union.get(key([])).id, selection: variants.get(variant.combo.join("\0")).selection });
  }
  return aligned;
}

// A grid child's cell and whether its lines are written (grid-cells.mjs).
function gridChildInfo(parent, nodes, childId) {
  if (parent?.layout !== "grid") return {};
  const byChild = cellsByChild(parent["layout-grid-cells"]);
  // The file lists a grid's children top layer first (node-encode.mjs).
  const placed = [...(parent.children ?? [])].reverse().filter((child) => byChild.has(child) && nodes[child]?.["layout-item-absolute"] !== true);
  const explicit = explicitLines(placed, byChild, (parent["layout-grid-columns"] ?? []).length, (parent["layout-grid-rows"] ?? []).length, parent["layout-grid-dir"] ?? "row");
  return { parentGrid: true, cell: byChild.get(childId), explicitLines: explicit.has(childId) };
}

function classGroups(node, ctx, info, path) {
  const writer = nodeClasses(node, ctx, path, info);
  const groups = new Map();
  for (const [group, classes] of writer.grouped) groups.set(group, classes.join(" "));
  return groups;
}

function encodeComponent(set, ctx, file) {
  for (const field of Object.keys(set)) {
    if (!["axes", "id", "name", "variants", "visibility"].includes(field)) {
      throw unsupported(`Component ${set.name}: ${field} is not supported`);
    }
  }
  if (set.visibility && set.visibility !== "public") throw unsupported(`Component ${set.name}: private components are not supported`);
  const axes = set.axes ?? [];
  const variantKey = (selection) => axes.map((axis) => selection[axis.id]).join("\0");
  const stored = new Map(set.variants.map((variant) => [variantKey(variant.selection), variant]));
  const combos = axes.reduce((list, axis) => list.flatMap((combo) => (axis.domain ?? []).map((value) => [...combo, value])), [[]]);
  if (axes.some((axis) => !axis.domain?.length)) throw unsupported(`Component ${set.name}: every property needs its values`);
  for (const combo of combos) {
    if (!stored.has(combo.join("\0"))) throw unsupported(`Component ${set.name}: variant ${combo.join(", ")} is missing; every combination needs a variant`);
  }
  if (stored.size !== combos.length) throw unsupported(`Component ${set.name}: variants must be the property combinations`);
  // A variant root may name its own component (Penpot main components do);
  // the file already says which component it is.
  for (const [key, variant] of stored) {
    const root = variant.nodes[variant.rootId];
    if (root?.componentId !== undefined) {
      if (root.componentId !== set.id) throw unsupported(`Component ${set.name}: a variant root names another component`);
      const { componentId, ...rest } = root;
      stored.set(key, { ...variant, nodes: { ...variant.nodes, [variant.rootId]: rest } });
    }
  }
  const variants = alignVariants(set, combos, stored);
  const base = variants.get(combos[0].join("\0"));
  const baseInfo = nodePaths(base.nodes, base.rootId);
  const groupsOf = (variant, id) => {
    const node = variant.nodes[id];
    const parentId = nodePaths(variant.nodes, variant.rootId).parents.get(id);
    const parent = parentId && variant.nodes[parentId];
    return classGroups(node, ctx, {
      parentFlex: parent?.layout === "flex",
      ...gridChildInfo(parent, variant.nodes, id),
      isRoot: id === variant.rootId,
      isPageRoot: false,
    }, `${set.name} / ${id}`);
  };
  const baseGroups = new Map([...baseInfo.paths.keys()].map((id) => [id, groupsOf(base, id)]));
  // A text's words, or the string Token it shows, as one value to compare.
  const variantText = (entry) => {
    const binding = entry.tokenBindings?.text;
    return JSON.stringify(binding ? { token: ctx.tokenName(binding) } : { text: entry.text ?? "" });
  };

  // Variants line up by name path (their own ids can differ); changes are
  // keyed by the default variant's node id: "nodeId\0group" -> classes.
  const pathKey = (path) => path.join("\0");
  const baseByPath = new Map([...baseInfo.paths].map(([id, path]) => [pathKey(path), id]));
  const desired = new Map();
  for (const combo of combos) {
    const variant = variants.get(combo.join("\0"));
    const info = nodePaths(variant.nodes, variant.rootId);
    const byPath = new Map([...info.paths].map(([id, path]) => [pathKey(path), id]));
    if (byPath.size !== baseByPath.size || [...byPath.keys()].some((key) => !baseByPath.has(key))) {
      throw unsupported(`Component ${set.name}: variant ${combo.join(", ")} has other layers than the default; give every variant the same layers and hide the extra ones`);
    }
    const changes = new Map();
    for (const [key, baseId] of baseByPath) {
      const id = byPath.get(key);
      const node = variant.nodes[id];
      const baseNode = base.nodes[baseId];
      const childNames = (entry, nodes) => (entry.children ?? []).map((child) => nodes[child]?.name).join("\0");
      if (childNames(node, variant.nodes) !== childNames(baseNode, base.nodes)) {
        throw unsupported(`Component ${set.name}: variant ${combo.join(", ")} orders layers differently`);
      }
      if (node.type !== baseNode.type) throw unsupported(`Component ${set.name}: a layer changes type between variants`);
      if (node.type === "INSTANCE" && stableJson(node.instance) !== stableJson(baseNode.instance)) {
        changes.set(`${baseId}\0#instance`, stableJson(node.instance));
      }
      if (JSON.stringify(node.interactions ?? null) !== JSON.stringify(baseNode.interactions ?? null)) {
        throw unsupported(`Component ${set.name}: links must not differ between variants`);
      }
      const groups = groupsOf(variant, id);
      const before = baseGroups.get(baseId);
      for (const group of new Set([...groups.keys(), ...before.keys()])) {
        const value = groups.get(group) ?? "";
        if (value !== (before.get(group) ?? "")) changes.set(`${baseId}\0${group}`, value);
      }
      if (node.type === "TEXT" && variantText(node) !== variantText(baseNode)) {
        if (!node.text && !node.tokenBindings?.text) throw unsupported(`Component ${set.name}: a variant cannot empty a text`);
        changes.set(`${baseId}\0#text`, variantText(node));
      }
      if (JSON.stringify(node.tokenBindings?.visible ?? null) !== JSON.stringify(baseNode.tokenBindings?.visible ?? null)) {
        throw unsupported(`Component ${set.name}: data-visible must not differ between variants; hide the layer with hidden in a variant instead`);
      }
    }
    desired.set(combo.join("\0"), changes);
  }

  // Single-property rules: changes shared by every variant with that value.
  const rules = [];
  axes.forEach((axis, axisIndex) => {
    for (const value of axis.domain.slice(1)) {
      const members = combos.filter((combo) => combo[axisIndex] === value);
      const keys = new Set(members.flatMap((combo) => [...desired.get(combo.join("\0")).keys()]));
      const shared = new Map();
      // The value most members want (no change counts as a value too); a
      // tie goes to the earliest member. Later full rules fix exceptions.
      for (const key of keys) {
        const tally = new Map();
        for (const combo of members) {
          const wanted = desired.get(combo.join("\0")).get(key);
          tally.set(wanted, (tally.get(wanted) ?? 0) + 1);
        }
        let chosen;
        let best = 0;
        for (const combo of members) {
          const wanted = desired.get(combo.join("\0")).get(key);
          if (tally.get(wanted) > best) {
            best = tally.get(wanted);
            chosen = wanted;
          }
        }
        if (chosen !== undefined && best * 2 >= members.length) shared.set(key, chosen);
      }
      if (shared.size) rules.push({ when: [[axis.name, value]], match: (combo) => combo[axisIndex] === value, changes: shared });
    }
  });
  // Full-selection rules for whatever remains.
  for (const combo of combos.slice(1)) {
    const effective = new Map();
    for (const rule of rules) if (rule.match(combo)) for (const [key, value] of rule.changes) effective.set(key, value);
    const wanted = desired.get(combo.join("\0"));
    const residual = new Map();
    for (const key of new Set([...wanted.keys(), ...effective.keys()])) {
      const target = wanted.get(key);
      const got = effective.get(key);
      if (target === got) continue;
      if (target === undefined) {
        // Back to the default variant's value.
        const [id, group] = key.split("\0");
        residual.set(
          key,
          group === "#text" ? variantText(base.nodes[id]) : group === "#instance" ? stableJson(base.nodes[id].instance) : baseGroups.get(id).get(group) ?? "",
        );
      } else residual.set(key, target);
    }
    if (residual.size) {
      rules.push({ when: axes.map((axis, index) => [axis.name, combo[index]]), match: () => false, changes: residual });
    }
  }
  if (combos.length > 1 && rules.length === 0 && combos.slice(1).some((combo) => desired.get(combo.join("\0")).size)) {
    throw unsupported(`Component ${set.name}: variant changes could not be written`);
  }

  const baseLines = encodeTree(base.nodes, base.rootId, ctx, { kind: "component", file, label: set.name, rootName: set.name, baseDepth: 1 });
  const props = axes.map((axis) => `${axis.name}: ${axis.domain.join(" | ")}`).join("; ");
  const lines = [`<sp-component name="${escapeAttribute(set.name)}"${props ? ` props="${escapeAttribute(props)}"` : ""}>`, ...baseLines];
  for (const rule of rules) {
    lines.push(...ruleLines(rule, base, baseInfo, baseGroups, ctx));
  }
  lines.push("</sp-component>");
  return lines.join("\n");
}

function resetFor(group, classes) {
  if (classes) return classes;
  if (Object.hasOwn(GROUP_RESETS, group) && GROUP_RESETS[group]) return GROUP_RESETS[group];
  if (group === "size" || group === "position" || group === "padding" || group === "gap" || group === "layout" || group === "item" || group === "text" || group === "textColor" || group === "pins" || group === "blend") {
    return undefined;
  }
  return undefined;
}

function ruleLines(rule, base, baseInfo, baseGroups, ctx) {
  const when = rule.when.map(([name, value]) => `${name}: ${value}`).join("; ");
  const byNode = new Map();
  for (const [key, value] of rule.changes) {
    const [id, group] = key.split("\0");
    if (!byNode.has(id)) byNode.set(id, { classes: [], text: undefined });
    if (group === "#text") byNode.get(id).text = value;
    else if (group === "#instance") byNode.get(id).instance = JSON.parse(value);
    else {
      const classes = resetFor(group, value);
      if (classes === undefined) {
        throw unsupported(`A variant removes ${group} from ${base.nodes[id].name}; set it explicitly in that variant instead`);
      }
      byNode.get(id).classes.push(classes);
    }
  }
  const rootChange = byNode.get(base.rootId);
  const lines = [`  <sp-variant when="${escapeAttribute(when)}"${rootChange?.classes.length ? ` class="${rootChange.classes.join(" ")}"` : ""}>`];
  // Build the nested element tree for the changed parts.
  const tree = new Map();
  for (const id of byNode.keys()) {
    if (id === base.rootId) continue;
    const path = baseInfo.paths.get(id);
    let level = tree;
    let current = base.rootId;
    for (let index = 0; index < path.length; index += 1) {
      const childId = (base.nodes[current].children ?? []).find((child) => base.nodes[child].name === path[index]);
      if (!level.has(childId)) level.set(childId, new Map());
      if (index === path.length - 1) break;
      level = level.get(childId);
      current = childId;
    }
  }
  const emit = (level, depth) => {
    for (const [id, children] of level) {
      const node = base.nodes[id];
      const change = byNode.get(id);
      const indent = "  ".repeat(depth);
      const classAttr = change?.classes.length ? ` class="${change.classes.join(" ")}"` : "";
      if (change?.instance) {
        // The copy restated for these variants: its props and overrides.
        const restated = { ...node, instance: change.instance };
        const component = ctx.componentById(change.instance.component?.assetId, change.instance.component?.packageId);
        if (!component) throw unsupported(`${node.name}: copy of a component outside this package`);
        const props = (component.axes ?? [])
          .filter((axis) => change.instance.variant?.[axis.id] !== undefined && change.instance.variant[axis.id] !== axis.domain[0])
          .map((axis) => `${axis.name}: ${change.instance.variant[axis.id]}`);
        const open = `${indent}<sp-use data-name="${escapeAttribute(node.name)}"${props.length ? ` props="${escapeAttribute(props.join("; "))}"` : ""}${classAttr}>`;
        const inner = ctx.instanceOverrides(restated, depth + 1, node.name);
        if (inner.length) lines.push(open, ...inner, `${indent}</sp-use>`);
        else lines.push(`${open}</sp-use>`);
        continue;
      }
      const tag = node.type === "TEXT" ? "p" : "div";
      // A text's words, or its string Token as data-text.
      const said = node.type === "TEXT" && change?.text !== undefined ? JSON.parse(change.text) : undefined;
      const dataText = said?.token ? ` data-text="${escapeAttribute(tokenTypeOfName(said.token)?.rest ?? said.token)}"` : "";
      const open = `${indent}<${tag} data-name="${escapeAttribute(node.name)}"${dataText}${classAttr}>`;
      if (children.size === 0) {
        const text = said && !said.token ? textContent(said.text) : "";
        lines.push(`${open}${text}</${tag}>`);
      } else {
        lines.push(open);
        emit(children, depth + 1);
        lines.push(`${indent}</${tag}>`);
      }
    }
  };
  emit(tree, 2);
  if (lines.length === 1) {
    lines[0] = `${lines[0]}</sp-variant>`;
  } else {
    lines.push("  </sp-variant>");
  }
  return lines;
}

// --- Instances ----------------------------------------------------------

function instanceOverrideLines(node, depth, path, ctx, componentById) {
  const overrides = node.instance?.overrides ?? {};
  if (Object.keys(overrides).length === 0) return [];
  const component = componentById.get(node.instance.component.assetId);
  const source = sourceVariant(component, node.instance.variant);
  if (!source) throw unsupported(`${path}: the copy's variant does not exist`, { path });
  // Group override fields by part key ("<partId>" or "<nested>__<partId>").
  const byPart = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    const colon = key.lastIndexOf(":");
    const part = key.slice(0, colon);
    const field = key.slice(colon + 1);
    if (!byPart.has(part)) byPart.set(part, {});
    byPart.get(part)[field] = value;
  }
  // Links on its parts count self and named boards from the copy.
  return overrideTree(source, component, byPart, "", depth, path, ctx, componentById, node.id);
}

function sourceVariant(component, selection) {
  return component?.variants.find((variant) => (component.axes ?? []).every((axis) => variant.selection[axis.id] === selection?.[axis.id]));
}

function overrideTree(source, component, byPart, prefix, depth, path, ctx, componentById, copyId) {
  const { paths } = nodePaths(source.nodes, source.rootId);
  // Parts with own changes or nested changes under this prefix.
  const relevant = new Set();
  for (const key of byPart.keys()) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const own = rest.split("__")[0];
    if (!source.nodes[own]) throw unsupported(`${path}: override names a missing part`, { path });
    relevant.add(own);
  }
  const tree = new Map();
  for (const id of relevant) {
    const partPath = paths.get(id);
    let level = tree;
    let current = source.rootId;
    for (let index = 0; index < partPath.length; index += 1) {
      const childId = (source.nodes[current].children ?? []).find((child) => source.nodes[child].name === partPath[index]);
      if (!level.has(childId)) level.set(childId, new Map());
      if (index === partPath.length - 1) break;
      level = level.get(childId);
      current = childId;
    }
  }
  const lines = [];
  const emit = (level, indentDepth) => {
    for (const [id, children] of level) {
      const part = source.nodes[id];
      const fields = byPart.get(`${prefix}${id}`) ?? {};
      const indent = "  ".repeat(indentDepth);
      const attrs = [`data-name="${escapeAttribute(part.name)}"`];
      const writer = createClassWriter({ tokenBindings: fields.tokenBindings ?? {} }, ctx, path);
      const projected = { ...fields };
      delete projected.tokenBindings;
      delete projected.text;
      delete projected.interactions;
      delete projected.variant;
      if (part.type === "TEXT" && part.growType === "auto-width") {
        delete projected.width;
        delete projected.height;
      }
      for (const field of Object.keys(projected)) {
        if (!["fills", "strokes", "cornerRadius", "shadow", "opacity", "visible", "width", "height", "textStyle"].includes(field)) {
          throw unsupported(`${path}: override ${field} has no SmallPen HTML form`, { path });
        }
      }
      const bindings = fields.tokenBindings ?? {};
      for (const [field, reference] of Object.entries(bindings)) {
        if (reference === null) throw unsupported(`${path}: an override that removes a Token binding is not supported`, { path });
        if (field === "text" || field === "visible") continue;
        const fieldFor = { fill: "fills", stroke: "strokes", strokeWidth: "strokes", cornerRadius: "cornerRadius", shadow: "shadow", opacity: "opacity", width: "width", height: "height" };
        if (fieldFor[field] && projected[fieldFor[field]] === undefined) {
          projected[fieldFor[field]] = part[fieldFor[field]] ?? (field === "fill" ? [{ color: "#000000", type: "solid" }] : 0);
        }
      }
      visualClasses(writer, projected, part.type, path, { explicitNone: true });
      for (const axis of ["width", "height"]) {
        if (projected[axis] === undefined) continue;
        if (!writer.token(axis === "width" ? "w" : "h", axis)) writer.add(`${axis === "width" ? "w" : "h"}-[${formatLength(projected[axis])}]`);
      }
      if (part.type === "TEXT" && (projected.textStyle || bindings.typography || bindings.fontFamily || bindings.fontSize || bindings.fontWeight || bindings.letterSpacing)) {
        textStyleClasses(writer, projected.textStyle ?? part.textStyle ?? {}, ctx, bindings.typography ? {} : part.textStyle ?? {});
      }
      if (bindings.text) attrs.push(`data-text="${escapeAttribute(writer.rest(ctx.tokenName(bindings.text)))}"`);
      if (bindings.visible) attrs.push(`data-visible="${escapeAttribute(writer.rest(ctx.tokenName(bindings.visible)))}"`);
      attrs.push(...interactionAttributes(fields.interactions, ctx, path, part.type, copyId));
      const nestedKeys = [...byPart.keys()].filter((key) => key.startsWith(`${prefix}${id}__`));
      const isInstance = part.type === "INSTANCE";
      if (isInstance && fields.variant) {
        const nested = componentById.get(part.instance.component.assetId);
        const props = (nested?.axes ?? [])
          .filter((axis) => fields.variant[axis.id] !== undefined)
          .map((axis) => `${axis.name}: ${fields.variant[axis.id]}`);
        attrs.push(`props="${escapeAttribute(props.join("; "))}"`);
      }
      if (writer.classes.length) attrs.push(`class="${writer.classes.join(" ")}"`);
      const tag = part.type === "TEXT" ? "p" : isInstance ? "sp-use" : "div";
      const open = `${indent}<${tag} ${attrs.join(" ")}>`;
      const innerLines = [];
      if (isInstance && nestedKeys.length) {
        const nested = componentById.get(part.instance.component.assetId);
        const nestedSource = sourceVariant(nested, fields.variant ?? part.instance.variant);
        innerLines.push(...overrideTree(nestedSource, nested, byPart, `${prefix}${id}__`, indentDepth + 1, path, ctx, componentById, copyId));
      }
      if (children.size) {
        const saved = lines.length;
        emit(children, indentDepth + 1);
        innerLines.push(...lines.splice(saved));
      }
      if (part.type === "TEXT" && fields.text !== undefined && !bindings.text) {
        lines.push(`${open}${textContent(fields.text)}</p>`);
      } else if (innerLines.length === 0) {
        lines.push(`${open}</${tag}>`);
      } else {
        lines.push(open, ...innerLines, `${indent}</${tag}>`);
      }
    }
  };
  emit(tree, depth);
  return lines;
}
