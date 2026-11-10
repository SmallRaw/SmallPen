// INPUT:  every file of a .smallpen directory: path -> text or bytes
// OUTPUT: package-model values (manifest, entries, blobs) plus located issues
// POS:    The single HTML reader behind openPackage, check and the App.
//         It never throws for content problems: it reports them all.

import { sha256Hex, stableRuntimeUuid } from "../canonical.mjs";
import { attributeValue, createLineIndex, elementChildren, findElement, parseHtml } from "./html-parse.mjs";
import { unquoteCss } from "./css-parse.mjs";
import { createIdResolver, uuidFromKey } from "./ids.mjs";
import { decodeElement, elementType, readText, seedGeometry, TRIGGER_ATTRIBUTES } from "./node-decode.mjs";
import { parseInteraction, TRIGGERS } from "./interactions.mjs";
import { createState, readClasses, textStyleOf, valueOf, visualFields } from "./style-slots.mjs";
import { decodeTokensCss, resolveTokenValue } from "./tokens-codec.mjs";
import { formatShadow, suggestion, tokensWithValue } from "./vocabulary.mjs";

// A raw value that recurs is probably a design decision without a name.
const RAW_REPEAT = 3;
const SPACING_SLOTS = new Set([
  "padding", "paddingX", "paddingY", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "margin", "marginX", "marginY", "marginTop", "marginRight", "marginBottom", "marginLeft",
  "gap", "rowGap", "columnGap",
]);

// [what it is, the Token types that could name it, the value] for the raw
// values worth counting; positions and sizes are this place's own.
function rawKind(slot, payload) {
  const number = typeof payload.value === "number" ? payload.value : undefined;
  if (SPACING_SLOTS.has(slot)) return number ? ["spacing", ["spacing"], number, `${number}px`] : undefined;
  if (slot.startsWith("radius")) return number ? ["radius", ["border-radius"], number, `${number}px`] : undefined;
  if (slot.startsWith("strokeWidth")) return number ? ["border width", ["stroke-width"], number, `${number}px`] : undefined;
  if (slot === "opacity") return number !== undefined && number !== 1 ? ["opacity", ["opacity"], number, String(number)] : undefined;
  if (slot === "shadow" && Array.isArray(payload.value)) return ["shadow", ["shadow"], payload.value, formatShadow(payload.value)];
  if (["fill", "text", "border", "svgFill", "svgStroke"].includes(slot)) {
    if (typeof payload.color === "string") {
      const color = payload.color.toLowerCase();
      // A fully transparent colour is the absence of one.
      return /^#[0-9a-f]{6}00$/.test(color) ? undefined : ["color", ["color"], color, color];
    }
    if (slot === "text" && number) return ["font size", ["font-size"], number, `${number}px`];
    if (slot === "border" && number) return ["border width", ["stroke-width"], number, `${number}px`];
  }
  return undefined;
}

export const PLATFORM_SIZES = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
  tablet: { width: 834, height: 1194 },
};
const PLATFORM_ORDER = ["desktop", "tablet", "mobile"];
const PAGE_PATH = /^pages\/(?:([^/]+)\/)?([^/.]+)(?:\.(desktop|mobile|tablet))?\.html$/;
const FONT_EXTENSIONS = { ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2" };
const OVERRIDABLE = new Set([
  "cornerRadius", "fills", "height", "interactions", "opacity", "shadow", "strokes",
  "text", "textStyle", "tokenBindings", "visible", "width",
]);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

const TOKENS_ENTRY = "tokens.css";
const ASSETS_ENTRY = "assets";

function asText(value) {
  return typeof value === "string" ? value : decoder.decode(value);
}

function asBytes(value) {
  return typeof value === "string" ? encoder.encode(value) : value;
}

export { uuidFromKey } from "./ids.mjs";

function parseProps(text, report) {
  const axes = [];
  if (!text?.trim()) return axes;
  for (const part of text.split(";")) {
    if (!part.trim()) continue;
    const colon = part.indexOf(":");
    if (colon === -1) {
      report(`props needs Name: value | value, got ${part.trim()}`);
      continue;
    }
    const name = part.slice(0, colon).trim();
    const values = part.slice(colon + 1).split("|").map((value) => value.trim()).filter(Boolean);
    if (!name || values.length === 0) {
      report(`props needs Name: value | value, got ${part.trim()}`);
      continue;
    }
    if (new Set(values).size !== values.length) report(`${name} lists a value twice`);
    axes.push({ name, values });
  }
  return axes;
}

function parseSelection(text, report) {
  const selection = new Map();
  if (!text?.trim()) return selection;
  for (const part of text.split(";")) {
    if (!part.trim()) continue;
    const colon = part.indexOf(":");
    if (colon === -1) {
      report(`expected Name: value, got ${part.trim()}`);
      continue;
    }
    selection.set(part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).trim());
  }
  return selection;
}

function combinations(axes) {
  let result = [[]];
  for (const axis of axes) {
    const next = [];
    for (const combo of result) for (const value of axis.values) next.push([...combo, value]);
    result = next;
  }
  return result;
}

// Names every child element as decodeElement will, without reporting.
function namedChildren(element) {
  const children = elementChildren(element).filter((child) => elementType(child));
  const used = new Set();
  const names = new Map();
  for (const child of children) {
    const name = attributeValue(child, "data-name");
    if (name) {
      used.add(name.toLowerCase());
      names.set(child, name);
    }
  }
  for (const child of children) {
    if (names.has(child)) continue;
    const type = elementType(child);
    let base;
    if (type === "TEXT") base = textName(readText(child, { issue() {} }).text);
    else if (type === "INSTANCE") base = attributeValue(child, "component") || "Copy";
    else if (type === "IMAGE") base = (attributeValue(child, "src") ?? "").split("/").at(-1)?.replace(/\.[^.]+$/, "") || "Image";
    else base = { FRAME: "Board", RECTANGLE: "Rectangle", ELLIPSE: "Ellipse", GROUP: "Group", PATH: "Path" }[type] ?? "Layer";
    let name = base;
    for (let counter = 2; used.has(name.toLowerCase()); counter += 1) name = `${base} ${counter}`;
    used.add(name.toLowerCase());
    names.set(child, name);
  }
  return children.map((child) => ({ element: child, name: names.get(child) }));
}

// A text without data-name is named by its first 40 characters.
function textName(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 40) || "Text";
}

// A text named by its text is renamed by a text edit; overrides that name
// the old text then find nothing.
const textNameHint = (name) =>
  `A text without data-name is named by its text, so editing the text renames it; write data-name="${name}" on that text to keep the old name`;

// A part deeper down: the names from here to it, so a rule or override
// can nest the same way. Elements (variant rules) or source nodes (copies).
function deepPartPath(children, name) {
  const wanted = name.toLowerCase();
  const queue = children().map((entry) => ({ entry, path: [entry.name] }));
  while (queue.length) {
    const { entry, path } = queue.shift();
    if (path.length > 1 && entry.name.toLowerCase() === wanted) return path;
    if (path.length < 8) for (const child of entry.children()) queue.push({ entry: child, path: [...path, child.name] });
  }
  return undefined;
}

function nestHint(path) {
  const opens = path.slice(0, -1).map((name) => `<div data-name="${name}">`).join("");
  const closes = path.slice(0, -1).map(() => "</div>").join("");
  return `; it is inside ${path.slice(0, -1).join(" › ")}, so nest it the same way: ${opens}<… data-name="${path.at(-1)}">${closes}`;
}

const elementParts = (element) => () => namedChildren(element).map(({ name, element: child }) => ({ name, children: elementParts(child) }));
const nodeParts = (nodes, id) => () => (nodes[id]?.children ?? []).filter((child) => nodes[child]).map((child) => ({ name: nodes[child].name, children: nodeParts(nodes, child) }));

function childByName(element, name) {
  const key = name.toLowerCase();
  return namedChildren(element).find((child) => child.name.toLowerCase() === key)?.element;
}

function resolveRelative(fromFile, target) {
  if (/^[a-z]+:/i.test(target) || target.startsWith("/")) return undefined;
  const parts = fromFile.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(segment);
  }
  return parts.join("/");
}


// files: Map(path -> string | Uint8Array). options.inspectMedia(bytes,
// path) -> { mimeType, width, height } | undefined (supplied by Node or the
// browser). Returns { values, issues, summary }.
export async function decodePackageFiles(files, options = {}) {
  const issues = [];
  const idFor = createIdResolver(options.identity);
  const positions = new Map();
  // A rule shared by many variants is read once per variant; its problem is
  // reported once.
  const reported = new Set();
  // Warnings muted by <!-- smallpen-ignore … --> on an element.
  const ignored = [];
  const isIgnored = (file, code, offset) => ignored.some((range) =>
    range.file === file && offset >= range.start && offset <= range.end && range.codes.includes(code));
  // Raw values by kind and value: { kind, value, label, types, places, first }.
  const rawValues = new Map();
  const rawSeen = new Set();
  const report = (file, code, message, offset = 0, severity = "error", details) => {
    if (severity === "warning" && isIgnored(file, code, offset)) return;
    const key = `${file}\0${offset}\0${code}\0${message}`;
    if (reported.has(key)) return;
    reported.add(key);
    let position = positions.get(file);
    if (!position && files.has(file)) {
      position = createLineIndex(asText(files.get(file)));
      positions.set(file, position);
    }
    const at = position ? position(offset) : { line: 1, column: 1 };
    const entry = { file, line: at.line, column: at.column, severity, code, message };
    if (details?.candidates || details?.typeMismatch) {
      entry.details = {};
      if (details.typeMismatch) entry.details.typeMismatch = details.typeMismatch;
    }
    issues.push(entry);
  };

  // Classify files.
  const pageFiles = [];
  const componentFiles = [];
  const assetFiles = new Map();
  for (const path of [...files.keys()].sort()) {
    if (path === "index.html" || path === TOKENS_ENTRY) continue;
    if (PAGE_PATH.test(path)) pageFiles.push(path);
    else if (/^components\/[^/]+\.html$/.test(path)) componentFiles.push(path);
    else if (path.startsWith("assets/")) assetFiles.set(path, files.get(path));
    else if (path.startsWith("pages/") || path.startsWith("components/")) {
      report(path, "unknown_file", "Pages are pages/<Module>/<Page>[.mobile|.tablet].html and components are components/<Name>.html", 0, "warning");
    } else {
      report(path, "unknown_file", "This file is not part of the package format and is ignored", 0, "warning");
    }
  }

  for (const path of options.assets?.keys() ?? []) if (!assetFiles.has(path)) assetFiles.set(path, undefined);

  // index.html
  let packageName = "Untitled";
  let packageId;
  let defaultPage;
  const emptyCanvases = [];
  const defaults = new Map();
  if (!files.has("index.html")) {
    report("index.html", "missing_file", "The package needs index.html");
  } else {
    const source = asText(files.get("index.html"));
    const { root, issues: parseIssues } = parseHtml(source);
    for (const entry of parseIssues) report("index.html", entry.code, entry.message, entry.offset);
    const html = findElement(root, "html");
    const title = html && findElement(html, "title");
    const titleText = title?.children.map((child) => child.text ?? "").join("").trim();
    if (titleText) packageName = titleText;
    else report("index.html", "missing_title", "index.html needs <title> with the package name", html?.offset ?? 0);
    for (const attr of html?.attrs ?? []) {
      if (attr.name.startsWith("data-")) defaults.set(attr.name.slice(5), attr.value);
      else if (attr.name !== "lang") report("index.html", "unknown_attribute", `<html> does not take ${attr.name}`, attr.offset);
    }
    const metas = [];
    const collect = (element) => {
      for (const child of elementChildren(element)) {
        if (child.tag === "meta") metas.push(child);
        collect(child);
      }
    };
    if (html) collect(html);
    for (const meta of metas) {
      const name = attributeValue(meta, "name");
      if (name === "smallpen:package-id") packageId = attributeValue(meta, "content");
      if (name === "smallpen:default-page") defaultPage = attributeValue(meta, "content");
      if (name === "smallpen:canvas") {
        const canvas = attributeValue(meta, "content")?.trim();
        if (canvas) emptyCanvases.push(canvas);
        else report("index.html", "invalid_canvas", "smallpen:canvas needs a canvas name", meta.offset);
      }
    }
    if (!packageId || !/^pkg_[A-Za-z0-9_-]+$/.test(packageId)) {
      report("index.html", "missing_package_id", 'index.html needs <meta name="smallpen:package-id" content="pkg_…">', html?.offset ?? 0);
      packageId = "pkg_unknown";
    }
  }

  // tokens.css
  const tokensSource = files.has(TOKENS_ENTRY) ? asText(files.get(TOKENS_ENTRY)) : ":root {\n}\n";
  if (!files.has(TOKENS_ENTRY)) report(TOKENS_ENTRY, "missing_file", "The package needs tokens.css", 0, "warning");
  const decodedTokens = decodeTokensCss(tokensSource, defaults, idFor);
  for (const entry of decodedTokens.issues) {
    report(entry.file ?? TOKENS_ENTRY, entry.code, entry.message, entry.offset, entry.severity ?? "error");
  }
  const tokenTable = decodedTokens.tokens;
  const selection = new Map();
  for (const theme of decodedTokens.library.themes) {
    if (decodedTokens.library.defaultThemeIds.includes(theme.id)) selection.set(theme.group, theme.name);
  }
  const tokenIdByName = new Map();
  for (const set of decodedTokens.library.sets) {
    for (const token of set.tokens) if (!tokenIdByName.has(token.name)) tokenIdByName.set(token.name, token.id);
  }
  const tokenRef = (name) => ({ assetId: tokenIdByName.get(name), packageId });
  const tokenValue = (name) => resolveTokenValue(tokenTable, name, selection);

  // Assets: media referenced by <img>, fonts by @font-face.
  const blobs = new Map();
  const mediaByPath = new Map();
  const media = [];
  const fonts = [];
  const sha = async (bytes) => sha256Hex(bytes);
  // Asset facts: from options.assets (path -> { sha256, byteLength,
  // mimeType?, width?, height? }) when the reader already knows them, so
  // no font or image is read here; otherwise from bytes in `files`.
  const blobPaths = new Map();
  // A very large file is loaded by every App and render that opens the
  // package; say so once.
  const LARGE_ASSET = 10 * 1024 * 1024;
  const sizeNote = (path, facts) => {
    if (facts?.byteLength > LARGE_ASSET)
      report(path, "large_asset", `${path} is ${Math.round(facts.byteLength / 1024 / 1024)} MB; every App and render that opens the package loads it. ${path.startsWith("assets/fonts/") ? "Use a font subset with only the characters you need" : "Use a smaller image"}`, 0, "warning");
    return facts;
  };
  const assetFacts = async (path, media) => sizeNote(path, await assetFactsOf(path, media));
  const assetFactsOf = async (path, media) => {
    const known = options.assets?.get(path);
    if (known) {
      blobPaths.set(`blobs/${known.sha256}`, path);
      return known;
    }
    const bytes = asBytes(assetFiles.get(path));
    const facts = { sha256: await sha(bytes), byteLength: bytes.byteLength };
    if (media) {
      const info = options.inspectMedia ? await options.inspectMedia(bytes, path) : undefined;
      if (info) Object.assign(facts, { mimeType: info.mimeType, width: info.width, height: info.height });
    }
    blobs.set(`blobs/${facts.sha256}`, bytes);
    blobPaths.set(`blobs/${facts.sha256}`, path);
    return facts;
  };
  const mediaPromises = new Map();
  const ensureMedia = (path) => {
    if (!mediaPromises.has(path)) {
      mediaPromises.set(path, (async () => {
        const info = await assetFacts(path, true);
        if (!info.mimeType || !info.width || !info.height) return undefined;
        const sha256 = info.sha256;
        const entry = {
          blob: `blobs/${sha256}`,
          byteLength: info.byteLength,
          height: info.height,
          id: idFor("media", `media\0${path}`, path.split("/").at(-1)),
          mimeType: info.mimeType,
          name: path.split("/").at(-1).replace(/\.[^.]+$/, ""),
          path: "",
          sha256,
          width: info.width,
        };
        media.push(entry);
        mediaByPath.set(path, entry);
        return entry;
      })());
    }
    return mediaPromises.get(path);
  };

  // Font faces.
  const fontFamilies = new Map();
  for (const face of decodedTokens.fonts) {
    const family = unquoteCss(face["font-family"]?.value ?? "") ?? face["font-family"]?.value;
    const srcMatch = /^url\(\s*(?:"([^"]+)"|'([^']+)'|([^)\s]+))\s*\)$/.exec(face.src?.value ?? "");
    const src = srcMatch && (srcMatch[1] ?? srcMatch[2] ?? srcMatch[3]);
    const weight = Number(face["font-weight"]?.value ?? 400);
    const style = face["font-style"]?.value ?? "normal";
    if (!family || !src) {
      report(TOKENS_ENTRY, "invalid_font_face", "@font-face needs font-family and src: url(assets/fonts/…)", face.offset);
      continue;
    }
    const path = resolveRelative(TOKENS_ENTRY, src);
    const extension = path?.split(".").at(-1)?.toLowerCase();
    if (!path?.startsWith("assets/fonts/") || !assetFiles.has(path)) {
      report(TOKENS_ENTRY, "missing_asset", `Font file ${src} is not in assets/fonts/`, face.src?.offset ?? face.offset);
      continue;
    }
    if (extension === "woff2") {
      report(TOKENS_ENTRY, "unsupported_font_conversion", "WOFF2 fonts are not supported; use TTF, OTF or WOFF", face.src.offset);
      continue;
    }
    if (!FONT_EXTENSIONS[extension]) {
      report(TOKENS_ENTRY, "unsupported_font_file", `${src}: fonts are .ttf, .otf or .woff`, face.src.offset);
      continue;
    }
    if (!Number.isInteger(weight) || weight < 100 || weight > 950 || !["normal", "italic"].includes(style)) {
      report(TOKENS_ENTRY, "invalid_font_face", "font-weight takes 100–950 and font-style normal or italic", face.offset);
      continue;
    }
    const facts = await assetFacts(path, false);
    const { sha256 } = facts;
    if (!fontFamilies.has(family)) {
      fontFamilies.set(family, { family, id: idFor("font", `font\0${family}`, family), variants: [] });
    }
    fontFamilies.get(family).variants.push({
      files: { [extension]: { blob: `blobs/${sha256}`, byteLength: facts.byteLength, mimeType: FONT_EXTENSIONS[extension], sha256 } },
      id: idFor("fvar", `fvar\0${family}\0${weight}\0${style}`, `${family}_${weight}_${style}`),
      name: `${weight}${style === "italic" ? " italic" : ""}`,
      style,
      weight,
    });
  }
  fonts.push(...fontFamilies.values());

  // Components.
  const components = new Map();
  const componentEntries = new Map();
  const componentOrder = [];
  for (const file of componentFiles) {
    const source = asText(files.get(file));
    const { root, issues: parseIssues } = parseHtml(source);
    for (const entry of parseIssues) report(file, entry.code, entry.message, entry.offset);
    const sets = [];
    for (const element of elementChildren(root)) {
      if (element.tag !== "sp-component") {
        report(file, "unknown_element", `Component files hold <sp-component> elements, not <${element.tag}>`, element.offset);
        continue;
      }
      const name = attributeValue(element, "name");
      if (!name?.trim()) {
        report(file, "missing_name", "<sp-component> needs name", element.offset);
        continue;
      }
      if (components.has(name.toLowerCase())) {
        const first = components.get(name.toLowerCase());
        report(file, "duplicate_name", `Component ${name} is defined twice; the other one is in ${first.file}. Rename one, or remove the one you no longer use`, element.offset);
        continue;
      }
      for (const attr of element.attrs) {
        if (!["name", "props"].includes(attr.name)) report(file, "unknown_attribute", `<sp-component> does not take ${attr.name}`, attr.offset);
      }
      const children = elementChildren(element);
      const base = children[0];
      if (!base || base.tag === "sp-variant") {
        report(file, "missing_component_root", "<sp-component> starts with the element every variant shares", element.offset);
        continue;
      }
      const rules = children.slice(1);
      const propsAttr = element.attrs.find((attr) => attr.name === "props");
      const axes = parseProps(propsAttr?.value, (message) => report(file, "invalid_props", message, propsAttr?.valueOffset ?? element.offset));
      const component = {
        name,
        file,
        element,
        base,
        rules: rules.filter((rule) => {
          if (rule.tag === "sp-variant") return true;
          report(file, "unknown_element", "After the shared element, a component holds only <sp-variant> rules", rule.offset);
          return false;
        }),
        id: idFor("cmp", `cmp\0${name}`, name),
        axes: axes.map((axis) => ({
          id: idFor("axis", `axis\0${name}\0${axis.name}`, axis.name, `axis\0${name}`),
          name: axis.name,
          domain: axis.values,
        })),
      };
      components.set(name.toLowerCase(), component);
      componentOrder.push(component);
      sets.push(component);
    }
    componentEntries.set(file, sets);
  }

  const pageIndex = new Map();
  const pages = [];
  for (const file of pageFiles) {
    const [, module, page, platform = "desktop"] = PAGE_PATH.exec(file);
    const key = module ? `${module}/${page}` : page;
    if (!pageIndex.has(key)) {
      const screen = {
        key,
        module,
        page,
        name: module ? `${module} / ${page}` : page,
        id: idFor("scr", `scr\0${key}`, key),
        presentations: new Map(),
      };
      pageIndex.set(key, screen);
      pages.push(screen);
    }
    const screen = pageIndex.get(key);
    screen.presentations.set(platform, {
      file,
      platform,
      id: idFor("pres", `pres\0${key}\0${platform}`, `${key}_${platform}`),
    });
  }

  const pendingInteractions = [];
  const pageRoots = new Map();

  let treeCounter = 0;
  const makeContext = (file, kind, scopeKey, extra = {}) => {
    const treeScope = `node\0${(treeCounter += 1)}`;
    const pathIds = new Map();
    const namedByText = new Set();
    const ctx = {
      file,
      kind,
      nodes: {},
      sizing: new Map(),
      tokenTable,
      tokenValue,
      tokenRef,
      issue: (code, message, offset, details) => report(file, code, message, offset, details?.severity ?? "error", details),
      warn: (code, message, offset) => report(file, code, message, offset, "warning"),
      ignore: (start, end, codes) => ignored.push({ file, start, end, codes }),
      // A rule shared by variants is read once per variant: count it once.
      raw: (slot, payload, offset) => {
        const kind = rawKind(slot, payload);
        if (!kind || isIgnored(file, "repeated_raw_value", offset)) return;
        const place = `${file}\0${offset}\0${slot}`;
        if (rawSeen.has(place)) return;
        rawSeen.add(place);
        const [label, types, value, text] = kind;
        const key = `${label}\0${text}`;
        if (!rawValues.has(key)) rawValues.set(key, { label, types, value, text, places: 0, files: new Set(), first: { file, offset } });
        const entry = rawValues.get(key);
        entry.places += 1;
        entry.files.add(file);
      },
      // nodeId gives an element its id (each call a new one); nodeIdOf finds
      // the id an element at that path was given.
      nodeId: (path) => {
        const id = idFor("node", `${scopeKey}\0${path.join("\0")}`, path.length ? `${path.at(-1)}` : "root", treeScope);
        if (!pathIds.has(path.join("\0"))) pathIds.set(path.join("\0"), id);
        return id;
      },
      nodeIdOf: (path) => pathIds.get(path.join("\0")),
      namedByText,
      mediaRef: (src, element) => {
        const path = resolveRelative(file, src);
        if (!path || !assetFiles.has(path) || path.startsWith("assets/fonts/")) {
          report(file, "missing_asset", `Image ${src} is not in assets/`, element.offset);
          return undefined;
        }
        const reference = { path, element, value: undefined };
        ctx.pendingMedia.push(reference);
        return reference;
      },
      pendingMedia: [],
      // A trigger attribute's value -> a Penpot interaction. Destinations
      // and relative-to boards resolve to App ids once every page is read.
      // path: the element's names from the page root; on a part of a copy,
      // the copy's (onCopyPart), so self and named boards count from it.
      interaction: (value, element, { trigger = "click", path = [], onCopyPart = false } = {}) => {
        const attribute = TRIGGERS[trigger] ?? "data-click";
        const where = `${attribute}="${value}"`;
        const parsed = parseInteraction(value, trigger);
        if (parsed.error) {
          report(file, "invalid_interaction", `${where}: ${parsed.error}`, element.offset);
          return undefined;
        }
        const { interaction, target, relativeTo } = parsed;
        if (target !== undefined) {
          const screen = pageIndex.get(target);
          if (!screen) {
            const hint = suggestion(target, [...pageIndex.keys()]);
            report(file, "unknown_link_target", `${where}: no page pages/${target}.html${hint ? `; did you mean ${hint}?` : ""}`, element.offset);
            return undefined;
          }
          // The same platform's version, else the desktop one: a mobile page
          // may open a page that only has a desktop version.
          const presentation = screen.presentations.get(extra.platform) ?? screen.presentations.get("desktop") ?? [...screen.presentations.values()][0];
          if (interaction["action-type"] !== "navigate" && kind === "page" && presentation.id === extra.presentationId) {
            report(file, "invalid_interaction", `${where}: an overlay opens another page, not the page it is on`, element.offset);
            return undefined;
          }
          interaction.destination = undefined;
          pendingInteractions.push({ interaction, field: "destination", screen, presentation });
        }
        if (relativeTo !== undefined) {
          if (kind !== "page") {
            report(file, "invalid_interaction", `${where}: relative-to works on page elements; in a component the overlay opens where the copy is`, element.offset);
            return undefined;
          }
          let nodePath;
          if (relativeTo.toLowerCase() === "self") nodePath = path;
          else if (relativeTo.toLowerCase() === "page") nodePath = [];
          else {
            // An enclosing board or copy; on a copy's part the copy itself
            // counts too.
            for (let depth = onCopyPart ? path.length : path.length - 1; depth >= 1; depth -= 1) {
              if (path[depth - 1].toLowerCase() === relativeTo.toLowerCase()) {
                nodePath = path.slice(0, depth);
                break;
              }
            }
            // The copy itself is still being read (not in ctx.nodes yet).
            const kindAt = (at) => (onCopyPart && at.length === path.length ? "INSTANCE" : ctx.nodes[ctx.nodeIdOf(at)]?.type);
            if (!nodePath || !["FRAME", "INSTANCE"].includes(kindAt(nodePath))) {
              const around = [];
              for (let depth = onCopyPart ? path.length : path.length - 1; depth >= 1; depth -= 1)
                if (["FRAME", "INSTANCE"].includes(kindAt(path.slice(0, depth)))) around.push(path[depth - 1]);
              report(file, "invalid_interaction", `${where}: relative-to names ${relativeTo}, which is not a board or copy around this element; use self, page${around.length ? ` or one of ${around.join(", ")}` : ""}`, element.offset);
              return undefined;
            }
          }
          interaction["position-relative-to"] = undefined;
          pendingInteractions.push({
            interaction,
            field: "position-relative-to",
            runtimeKey: `${extra.screenId}\0${extra.presentationId}\0${ctx.nodeIdOf(nodePath)}`,
          });
        }
        return interaction;
      },
      decodeInstance: (element, node, path) => decodeInstance(element, node, path, ctx),
      ...extra,
    };
    return ctx;
  };

  // Component variants, decoded on first use so one component can contain
  // copies of another wherever it is defined.
  const componentSets = new Map();
  const decoding = new Set();
  function ensureComponent(component) {
    if (componentSets.has(component)) return componentSets.get(component);
    if (decoding.has(component)) {
      report(component.file, "component_cycle", `${component.name} contains a copy of itself`, component.element.offset);
      return [];
    }
    decoding.add(component);
    decodeComponent(component);
    decoding.delete(component);
    return componentSets.get(component);
  }
  for (const component of componentOrder) ensureComponent(component);

  function decodeComponent(component) {
    const combos = component.axes.length ? combinations(component.axes.map((axis) => ({ values: axis.domain }))) : [[]];
    const ruleSpecs = component.rules.map((rule) => {
      const when = parseSelection(attributeValue(rule, "when"), (message) => report(component.file, "invalid_variant_rule", message, rule.offset));
      for (const [axisName, value] of when) {
        const axis = component.axes.find((candidate) => candidate.name.toLowerCase() === axisName);
        if (!axis) report(component.file, "invalid_variant_rule", `when names ${axisName}, which ${component.name} does not have`, rule.offset);
        else if (!axis.domain.includes(value)) report(component.file, "invalid_variant_rule", `${axis.name} has no value ${value}`, rule.offset);
      }
      for (const attr of rule.attrs) {
        if (!["when", "class"].includes(attr.name)) report(component.file, "unknown_attribute", `<sp-variant> does not take ${attr.name}`, attr.offset);
      }
      return { rule, when };
    });
    const variants = [];
    // Per part a rule changes: in how many variants the change applies, and
    // in how many the part is shown. Shown in none: the rule does nothing.
    const effect = new Map();
    for (const combo of combos) {
      const selected = new Map(component.axes.map((axis, index) => [axis.name.toLowerCase(), combo[index]]));
      const extraClasses = new Map();
      const textOverrides = new Map();
      const restatedCopies = new Map();
      const changed = [];
      for (const { rule, when } of ruleSpecs) {
        if (![...when].every(([axis, value]) => selected.get(axis) === value)) continue;
        const classAttr = rule.attrs.find((attr) => attr.name === "class");
        if (classAttr) {
          const list = extraClasses.get(component.base) ?? [];
          list.push({ value: classAttr.value, offset: classAttr.valueOffset });
          extraClasses.set(component.base, list);
        }
        matchOverrides(rule, component.base, component.file, extraClasses, textOverrides, restatedCopies, changed);
      }
      const ctx = makeContext(component.file, "component", `cmp\0${component.name}`, { extraClasses, textOverrides, restatedCopies, rootSize: { width: 0, height: 0 }, elementIds: new Map() });
      const rootId = decodeElement(component.base, ctx, undefined, [], component.name);
      if (!rootId) continue;
      const parents = new Map();
      for (const [id, node] of Object.entries(ctx.nodes)) for (const child of node.children ?? []) parents.set(child, id);
      const shown = (id) => {
        for (let at = id; at; at = parents.get(at)) if (ctx.nodes[at]?.visible === false) return false;
        return true;
      };
      for (const { child, target } of changed) {
        const id = ctx.elementIds.get(target);
        const entry = effect.get(child) ?? { applied: 0, shown: 0 };
        entry.applied += 1;
        if (id && shown(id)) entry.shown += 1;
        effect.set(child, entry);
      }
      const selection = Object.fromEntries(component.axes.map((axis, index) => [axis.id, combo[index]]));
      const variant = {
        id: idFor("var", `var\0${component.name}\0${combo.join("\0")}`, [component.name, ...combo].join("_")),
        nodes: ctx.nodes,
        rootId,
        selection,
      };
      variants.push({ variant, ctx });
    }
    // One warning per component: the parts whose changes show nowhere.
    const idle = [...effect].filter(([, { applied, shown }]) => applied && !shown).map(([child]) => child);
    if (idle.length) {
      const lines = createLineIndex(asText(files.get(component.file)));
      const where = idle.map((child) => `${attributeValue(child, "data-name")} (line ${lines(child.offset).line})`);
      report(component.file, "rule_has_no_effect", `${component.name}: ${idle.length} rule part${idle.length === 1 ? " changes" : "s change"} a part hidden in every variant ${idle.length === 1 ? "it applies" : "they apply"} to, so the change shows nowhere (hidden and shown still apply): ${where.slice(0, 6).join(", ")}${where.length > 6 ? `, and ${where.length - 6} more` : ""}. Remove those classes or words`, idle[0].offset, "warning");
    }
    componentSets.set(component, variants);
  }
  // Component bodies are hoisted functions above; seed them now that every
  // component exists.

  function matchOverrides(ruleElement, baseElement, file, extraClasses, textOverrides, restatedCopies, changed) {
    for (const child of elementChildren(ruleElement)) {
      const name = attributeValue(child, "data-name");
      if (!name) {
        report(file, "missing_name", "An element inside <sp-variant> names the part it changes with data-name", child.offset);
        continue;
      }
      const target = childByName(baseElement, name);
      if (!target) {
        const parts = namedChildren(baseElement);
        const textNamed = parts.some(({ element }) => elementType(element) === "TEXT" && !attributeValue(element, "data-name"));
        const deeper = deepPartPath(elementParts(baseElement), name);
        report(
          file,
          "unknown_part",
          `No part named ${name} here${deeper ? nestHint(deeper) : parts.length ? `; parts: ${parts.map((part) => part.name).join(", ")}` : ""}` +
            (!deeper && textNamed ? `. ${textNameHint(name)}` : ""),
          child.offset,
        );
        continue;
      }
      // A part in a rule changes classes, a text's words or string Token,
      // and a copy's props; anything else would be dropped, so it is named.
      const allowed = new Set(["data-name", "class", ...(child.tag === "p" ? ["data-text"] : []), ...(child.tag === "sp-use" ? ["props", "component"] : [])]);
      for (const attr of child.attrs) {
        if (allowed.has(attr.name)) continue;
        const fix = attr.name === "data-visible"
          ? "hide or show the part with hidden / shown in the variant's class"
          : attr.name === "data-text"
            ? "data-text goes on a <p>"
            : `put ${attr.name} on the shared element; it is the same in every variant`;
        report(file, "override_not_allowed", `A variant cannot change ${attr.name} of ${name}; ${fix}`, attr.offset);
      }
      // A rule that finds a text by its words breaks when the words change.
      if (elementType(target) === "TEXT" && attributeValue(target, "data-name") === undefined) {
        report(file, "part_named_by_text", `${name} is found by its words; give that <p> data-name="${name}" (or another name) so changing its text keeps this rule`, child.offset, "warning");
      }
      const classAttr = child.attrs.find((attr) => attr.name === "class");
      if (classAttr) {
        const list = extraClasses.get(target) ?? [];
        list.push({ value: classAttr.value, offset: classAttr.valueOffset });
        extraClasses.set(target, list);
      }
      // What a rule changes besides showing or hiding the part.
      const changes = (classAttr?.value ?? "").split(/\s+/).some((name) => name && name !== "hidden" && name !== "shown") ||
        (child.tag === "p" && (attributeValue(child, "data-text") !== undefined || elementChildren(child).length > 0 || child.children.some((node) => node.type === "text" && node.text.trim())));
      if (changes && child.tag !== "sp-use") changed?.push({ child, target });
      if (child.tag === "p") {
        // Words or a string Token for these variants; either replaces the
        // shared element's.
        const text = readText(child, { issue: (code, message, offset) => report(file, code, message, offset) });
        const tokenText = attributeValue(child, "data-text");
        if (tokenText !== undefined) textOverrides.set(target, { ...text, tokenText, offset: child.offset });
        else if (text.text) textOverrides.set(target, { ...text, tokenText: undefined, offset: child.offset });
      }
      // A copy restated in a rule: its props and part overrides replace the
      // shared element's for these variants.
      if (child.tag === "sp-use") {
        if (target.tag !== "sp-use") {
          report(file, "unknown_part", `${name} is not a component copy`, child.offset);
          continue;
        }
        const component = attributeValue(child, "component");
        if (component && component !== attributeValue(target, "component")) {
          report(file, "override_not_allowed", "A variant cannot swap a copy's component; change its props", child.offset);
        }
        restatedCopies?.set(target, child);
        continue;
      }
      matchOverrides(child, target, file, extraClasses, textOverrides, restatedCopies, changed);
    }
  }

  function variantFor(component, selection) {
    const variants = ensureComponent(component) ?? [];
    return variants.find(({ variant }) => component.axes.every((axis) => variant.selection[axis.id] === selection[axis.id]));
  }

  function decodeInstance(element, node, path, ctx) {
    const name = attributeValue(element, "component");
    const component = name && components.get(name.toLowerCase());
    if (!component) {
      const hint = name && suggestion(name, componentOrder.map((entry) => entry.name));
      ctx.issue(name ? "unknown_component" : "missing_component", name ? `No component ${name}${hint ? `; did you mean ${hint}?` : ""}` : "<sp-use> needs component", element.offset);
      node.type = "FRAME";
      node.fills = node.fills ?? [];
      return;
    }
    const spec = ctx.restatedCopies?.get(element) ?? element;
    const selection = readInstanceSelection(spec, component, ctx);
    node.instance = {
      component: { assetId: component.id, packageId },
      variant: selection,
    };
    const source = variantFor(component, selection);
    const overrides = {};
    // A link on a part of the copy places an overlay relative to the copy
    // (relative-to: self), the element the page holds.
    if (source) collectInstanceOverrides(spec, source.variant.rootId, source.variant.nodes, component, overrides, "", ctx, path, source.ctx.namedByText);
    if (Object.keys(overrides).length) node.instance.overrides = overrides;
    return source?.variant.nodes[source.variant.rootId];
  }

  function readInstanceSelection(element, component, ctx) {
    const propsAttr = element.attrs.find((attr) => attr.name === "props");
    const chosen = parseSelection(propsAttr?.value, (message) => ctx.issue("invalid_props", message, propsAttr?.valueOffset ?? element.offset));
    const selection = {};
    for (const axis of component.axes) {
      const value = chosen.get(axis.name.toLowerCase());
      if (value !== undefined && !axis.domain.includes(value)) {
        ctx.issue("invalid_prop_value", `${component.name} ${axis.name} takes ${axis.domain.join(" | ")}, not ${value}`, propsAttr.valueOffset);
      }
      selection[axis.id] = value !== undefined && axis.domain.includes(value) ? value : axis.domain[0];
    }
    for (const [axisName] of chosen) {
      if (!component.axes.some((axis) => axis.name.toLowerCase() === axisName)) {
        ctx.issue("unknown_prop", `${component.name} has no property ${axisName}`, propsAttr.valueOffset);
      }
    }
    return selection;
  }

  // Override elements inside <sp-use> name source parts; their classes and
  // text become Instance overrides of those parts.
  function collectInstanceOverrides(container, sourceId, sourceNodes, component, overrides, prefix, ctx, copyPath, namedByText) {
    const sourceNode = sourceNodes[sourceId];
    for (const child of elementChildren(container)) {
      const name = attributeValue(child, "data-name");
      if (!name) {
        ctx.issue("missing_name", "An element inside <sp-use> names the part it changes with data-name", child.offset);
        continue;
      }
      const partId = (sourceNode?.children ?? []).find((id) => sourceNodes[id]?.name.toLowerCase() === name.toLowerCase());
      if (!partId) {
        const names = (sourceNode?.children ?? []).map((id) => sourceNodes[id]?.name).filter(Boolean);
        const textNamed = (sourceNode?.children ?? []).some((id) =>
          sourceNodes[id]?.type === "TEXT" && sourceNodes[id].name === textName(sourceNodes[id].text));
        const deeper = deepPartPath(nodeParts(sourceNodes, sourceId), name);
        ctx.issue(
          "unknown_part",
          `${component.name} has no part ${name} here${deeper ? nestHint(deeper) : names.length ? `; parts: ${names.join(", ")}` : ""}` +
            (!deeper && textNamed ? `. ${textNameHint(name)}` : ""),
          child.offset,
        );
        continue;
      }
      const part = sourceNodes[partId];
      const key = `${prefix}${partId}`;
      if (namedByText?.has(partId)) {
        ctx.warn?.("part_named_by_text", `${component.name}'s part ${name} is found by its words; give it data-name in the component so changing its text keeps this override`, child.offset);
      }
      // A nested copy takes props (its variant), part overrides inside it,
      // and the same class overrides as any other part (size, fill...).
      const nestedCopy = child.tag === "sp-use" && part.type === "INSTANCE";
      if (nestedCopy) {
        if (attributeValue(child, "component")) {
          ctx.issue("override_not_allowed", "A copy cannot swap its parts' components; change props instead", child.offset);
        }
        const nested = componentOrder.find((entry) => entry.id === part.instance.component.assetId);
        if (nested && child.attrs.some((attr) => attr.name === "props")) {
          const selection = readInstanceSelection(child, nested, ctx);
          overrides[`${key}:variant`] = selection;
        }
        const nestedSource = nested && variantFor(nested, overrides[`${key}:variant`] ?? part.instance.variant);
        if (nestedSource) {
          collectInstanceOverrides(child, nestedSource.variant.rootId, nestedSource.variant.nodes, nested, overrides, `${key}__`, ctx, copyPath, nestedSource.ctx.namedByText);
        }
      }
      const classAttr = child.attrs.find((attr) => attr.name === "class");
      const state = readClasses(createState(), classAttr ? [{ value: classAttr.value, offset: classAttr.valueOffset }] : [], tokenTable, (code, message, offset = child.offset, details) => ctx.issue(code, message, offset, details));
      ctx.currentElement = child;
      const { fields, bindings } = visualFields(part.type, state, ctx);
      if (part.type === "TEXT") {
        const textBindings = {};
        const style = textStyleOf(state, ctx, textBindings);
        if (Object.keys(style).length) fields.textStyle = { ...(part.textStyle ?? {}), ...style };
        Object.assign(bindings, textBindings);
        const tokenText = attributeValue(child, "data-text");
        if (tokenText !== undefined) {
          const tokenName = `string-${tokenText}`;
          if (!tokenTable.has(tokenName)) ctx.issue("unknown_token", `data-text="${tokenText}": no Token --${tokenName}`, child.offset);
          else {
            fields.text = String(tokenValue(tokenName) ?? "");
            bindings.text = tokenRef(tokenName);
          }
        } else if (child.tag === "p") {
          const text = readText(child, ctx);
          if (text.text) fields.text = text.text;
        }
      }
      for (const axis of ["width", "height"]) {
        const spec = state[axis];
        if (!spec) continue;
        if (spec.mode) {
          ctx.issue("override_not_allowed", `A copy's part takes a fixed ${axis} override only`, child.offset);
          continue;
        }
        const resolved = valueOf(spec, ctx, axis);
        fields[axis] = resolved.value;
        if (resolved.binding) bindings[axis] = resolved.binding[1];
      }
      const visibleToken = attributeValue(child, "data-visible");
      if (visibleToken !== undefined) {
        const tokenName = `flag-${visibleToken}`;
        if (!tokenTable.has(tokenName)) ctx.issue("unknown_token", `data-visible="${visibleToken}": no Token --${tokenName}`, child.offset);
        else bindings.visible = tokenRef(tokenName);
      }
      const interactions = [];
      for (const [attribute, trigger] of TRIGGER_ATTRIBUTES) {
        const value = attributeValue(child, attribute);
        if (value === undefined) continue;
        if (trigger === "after-delay" && !["FRAME", "INSTANCE"].includes(part.type)) {
          ctx.issue("invalid_interaction", "data-after-delay works on a board or a component copy", child.offset);
          continue;
        }
        const interaction = ctx.interaction(value, child, { trigger, path: copyPath, onCopyPart: true });
        if (interaction) interactions.push(interaction);
      }
      if (interactions.length) fields.interactions = interactions;
      const disallowed = [...state.touched].filter((slot) => !OVERRIDE_SLOTS.has(slot));
      if (disallowed.length) {
        ctx.issue("override_not_allowed", `A copy cannot override ${disallowed.join(", ")} of its parts`, child.offset);
      }
      for (const [field, value] of Object.entries(fields)) {
        if (OVERRIDABLE.has(field)) overrides[`${key}:${field}`] = value;
      }
      if (Object.keys(bindings).length) overrides[`${key}:tokenBindings`] = bindings;
      if (!nestedCopy && elementChildren(child).length) {
        collectInstanceOverrides(child, partId, sourceNodes, component, overrides, prefix, ctx, copyPath, namedByText);
      }
    }
  }

  // Instance sizes for seeding come from their source variant roots.
  const instanceSize = (node) => {
    const component = componentOrder.find((entry) => entry.id === node.instance?.component.assetId);
    const source = component && variantFor(component, node.instance.variant);
    const root = source?.variant.nodes[source.variant.rootId];
    return root ? { width: root.width, height: root.height } : undefined;
  };
  for (const variants of componentSets.values()) {
    for (const { variant, ctx } of variants) seedGeometry(variant.nodes, variant.rootId, ctx.sizing, instanceSize);
  }

  // Pages.
  const canvases = new Map();
  const screensOut = [];
  for (const screen of pages) {
    const presentations = [];
    let flowNames = [];
    for (const platform of PLATFORM_ORDER) {
      const entry = screen.presentations.get(platform);
      if (!entry) continue;
      const source = asText(files.get(entry.file));
      const { root, issues: parseIssues } = parseHtml(source);
      for (const issue of parseIssues) report(entry.file, issue.code, issue.message, issue.offset);
      const html = elementChildren(root).find((element) => element.tag === "html");
      const body = html && elementChildren(html).find((element) => element.tag === "body");
      if (!body) {
        report(entry.file, "missing_body", "A page is a complete HTML document with <body>", 0);
        continue;
      }
      const head = elementChildren(html).find((element) => element.tag === "head");
      for (const child of head ? elementChildren(head) : []) {
        if (child.tag === "meta" || child.tag === "title") continue;
        if (child.tag === "link" && attributeValue(child, "rel") === "stylesheet") {
          const href = resolveRelative(entry.file, attributeValue(child, "href") ?? "");
          if (href !== TOKENS_ENTRY) report(entry.file, "invalid_stylesheet", "A page links only tokens.css", child.offset);
          continue;
        }
        report(entry.file, "unknown_element", `<head> holds meta, title and the tokens.css link, not <${child.tag}>`, child.offset);
      }
      const bodyState = readClasses(createState(), [{ value: attributeValue(body, "class") ?? "", offset: 0 }], tokenTable, () => {});
      const rootSize = {
        width: bodyState.width?.value ?? (bodyState.width?.token ? tokenValue(bodyState.width.token) : PLATFORM_SIZES[platform].width),
        height: bodyState.height?.value ?? (bodyState.height?.token ? tokenValue(bodyState.height.token) : PLATFORM_SIZES[platform].height),
      };
      const ctx = makeContext(entry.file, "page", `${screen.key}\0${platform}`, { platform, rootSize, screenId: screen.id, presentationId: entry.id });
      const rootName = attributeValue(body, "data-name") ?? `${screen.page} · ${platform}`;
      const rootId = decodeElement(body, ctx, undefined, [], rootName);
      seedGeometry(ctx.nodes, rootId, ctx.sizing, instanceSize);
      pageRoots.set(entry.id, rootId);
      const presentation = {
        id: entry.id,
        interactions: [],
        name: platform,
        nodes: ctx.nodes,
        platform,
        rootId,
        viewport: { height: ctx.nodes[rootId].height, width: ctx.nodes[rootId].width },
      };
      const flow = attributeValue(body, "data-flow");
      if (flow !== undefined) {
        if (!flow.trim()) report(entry.file, "invalid_flow", "data-flow needs a flow name", body.offset);
        else {
          presentation.prototypeFlows = [{ id: uuidFromKey(`flow\0${screen.key}\0${platform}\0${flow}`), name: flow, startingNodeId: rootId }];
          flowNames.push(flow);
        }
      }
      const canvas = attributeValue(body, "data-canvas");
      if (canvas !== undefined && platform === PLATFORM_ORDER.find((candidate) => screen.presentations.has(candidate))) {
        if (!canvases.has(canvas)) canvases.set(canvas, []);
        canvases.get(canvas).push(screen.id);
      }
      presentations.push({ presentation, ctx });
    }
    if (presentations.length === 0) continue;
    screensOut.push({ screen, presentations, flowNames });
  }

  // Resolve media references and interaction destinations.
  const allContexts = [
    ...[...componentSets.values()].flatMap((variants) => variants.map(({ ctx }) => ctx)),
    ...screensOut.flatMap(({ presentations }) => presentations.map(({ ctx }) => ctx)),
  ];
  for (const ctx of allContexts) {
    for (const reference of ctx.pendingMedia) {
      const entry = await ensureMedia(reference.path);
      if (!entry) report(ctx.file, "unsupported_media", `${reference.path} is not a supported image`, reference.element.offset);
    }
  }
  // Every image in assets/ belongs to the asset library, placed or not, as
  // the App's Assets panel shows images that no layer uses yet.
  for (const path of [...assetFiles.keys()].sort()) {
    if (!path.startsWith("assets/fonts/") && /\.(?:png|jpe?g|gif|webp|svg)$/i.test(path)) await ensureMedia(path);
  }
  // An image layer whose file is missing was reported; the layer is dropped.
  const mediaId = (reference) => (reference?.path ? mediaByPath.get(reference.path)?.id : undefined);
  const fixFills = (fills) => {
    if (!Array.isArray(fills) || !fills.some((fill) => fill.type === "image")) return fills;
    return fills
      .map((fill) => (fill.type === "image" && typeof fill.mediaRef === "object" ? { ...fill, mediaRef: mediaId(fill.mediaRef) } : fill))
      .filter((fill) => fill.type !== "image" || fill.mediaRef);
  };
  const fixMedia = (nodes) => {
    for (const node of Object.values(nodes)) {
      if (node.mediaRef && typeof node.mediaRef === "object" && node.mediaRef.path) {
        const entry = mediaByPath.get(node.mediaRef.path);
        if (entry) node.mediaRef = entry.id;
        else delete node.mediaRef;
      }
      if (node.fills) node.fills = fixFills(node.fills);
      for (const [key, value] of Object.entries(node.instance?.overrides ?? {})) {
        if (key.endsWith(":fills")) node.instance.overrides[key] = fixFills(value);
      }
    }
  };
  for (const ctx of allContexts) fixMedia(ctx.nodes);
  for (const pending of pendingInteractions) {
    if (pending.field === "destination") {
      const rootId = pageRoots.get(pending.presentation.id);
      pending.interaction.destination = rootId
        ? await stableRuntimeUuid(packageId, "node", `${pending.screen.id}\0${pending.presentation.id}\0${rootId}`)
        : undefined;
    } else {
      pending.interaction[pending.field] = await stableRuntimeUuid(packageId, "node", pending.runtimeKey);
    }
  }

  // Assemble the package-model values.
  const screenEntries = [];
  const values = new Map();
  for (const { screen, presentations } of screensOut) {
    const entryKey = `pages/${screen.key}`;
    const value = {
      basePresentationId: presentations[0].presentation.id,
      counterparts: [],
      id: screen.id,
      name: screen.name,
      presentations: presentations.map(({ presentation }) => presentation),
    };
    values.set(entryKey, value);
    screenEntries.push(entryKey);
  }
  const componentEntryKeys = [];
  for (const [file, sets] of componentEntries) {
    const value = {
      componentSets: sets.map((component) => ({
        axes: component.axes.map((axis) => ({ domain: axis.domain, id: axis.id, name: axis.name, role: "configuration" })),
        id: component.id,
        name: component.name,
        variants: (componentSets.get(component) ?? []).map(({ variant }) => variant),
        visibility: "public",
      })),
    };
    values.set(file, value);
    componentEntryKeys.push(file);
  }
  values.set(TOKENS_ENTRY, decodedTokens.library);
  const hasAssets = media.length > 0 || fonts.length > 0;
  if (hasAssets) {
    values.set(ASSETS_ENTRY, { colors: [], fonts, id: "alib_default", media, typographies: [] });
  }
  for (const [path, bytes] of blobs) values.set(path, bytes);

  let defaultScreenId;
  if (screensOut.length) {
    const byKey = defaultPage && pageIndex.get(defaultPage);
    if (defaultPage && !byKey) report("index.html", "unknown_link_target", `smallpen:default-page names ${defaultPage}, which has no page file`, 0);
    defaultScreenId = (byKey ?? screensOut.find(({ flowNames }) => flowNames.length)?.screen ?? screensOut[0].screen).id;
  }
  const manifest = {
    entries: {
      assets: hasAssets ? [ASSETS_ENTRY] : [],
      components: componentEntryKeys,
      contexts: [],
      requirements: [],
      scenarios: [],
      screens: screenEntries,
      tokens: [TOKENS_ENTRY],
    },
    formatVersion: 1,
    name: packageName,
    packageId,
    role: "foundation",
  };
  if (defaultScreenId) manifest.defaultScreenId = defaultScreenId;
  for (const name of emptyCanvases) if (!canvases.has(name)) canvases.set(name, []);
  if (canvases.size) {
    manifest.canvases = [...canvases].map(([name, screenIds]) => ({
      id: idFor("cnv", `cnv\0${name}`, name),
      name,
      screens: screenIds,
    }));
  }
  values.set("manifest.json", manifest);

  // A raw value written in many places is probably one design decision
  // that wants a name. Equal values do not say the places mean the same,
  // so Tokens of that value are offered, not prescribed.
  for (const entry of rawValues.values()) {
    if (entry.places < RAW_REPEAT) continue;
    const literal = typeof entry.value === "string" ? { color: entry.value } : typeof entry.value === "number" ? { value: entry.value } : {};
    const same = tokensWithValue(literal, entry.types, tokenTable).map(({ name }) => `--${name}`);
    const files = entry.files.size === 1 ? "1 file" : `${entry.files.size} files`;
    report(
      entry.first.file,
      "repeated_raw_value",
      `${entry.label} ${entry.text} is written raw in ${entry.places} places (${files}); if they are one design decision, name it with a Token and use its class${same.length ? ` (Tokens of this value: ${same.join(", ")}; use one only where it means the same)` : ""}; a value used once may stay raw`,
      entry.first.offset,
      "warning",
    );
  }
  issues.sort((left, right) =>
    left.file < right.file ? -1 : left.file > right.file ? 1 : left.line - right.line || left.column - right.column,
  );
  return {
    values,
    issues,
    blobPaths,
    summary: {
      pages: screensOut.length,
      pageVersions: screensOut.reduce((sum, entry) => sum + entry.presentations.length, 0),
      components: componentOrder.length,
      variants: [...componentSets.values()].reduce((sum, variants) => sum + variants.length, 0),
      tokens: tokenTable.size,
    },
  };
}

const OVERRIDE_SLOTS = new Set([
  "fill", "textColor", "text", "border", "strokeWidth", "stroke", "strokeStyle", "strokeAlignment",
  "radius", "radiusTopLeft", "radiusTopRight", "radiusBottomRight", "radiusBottomLeft",
  "shadow", "opacity", "visible", "width", "height", "font", "typography", "lineHeight",
  "letterSpacing", "textAlign", "fontStyle", "textTransform", "textDecoration",
  "verticalAlign", "textDirection",
]);
