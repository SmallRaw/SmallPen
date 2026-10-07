// Name-based edits of pages, components, links, colors, typographies,
// media and fonts, and the rule behind all of them: names never repeat.
// Each planner finds its target by the name an agent reads in outlines
// and returns the operations the ID-based commands would write, so the
// CLI and the App keep one storage model.
import { resolveCanvases } from "./canvases.mjs";
import { fail } from "./errors.mjs";
import { assetIntentOperations, listAssets } from "./local-authoring.mjs";
import {
  elementPath,
  findComponent,
  findElement,
  findPage,
  findPageElement,
  findPresentation,
  findVariant,
  variantLabel,
} from "./named-targets.mjs";
import { freeId, slug } from "./simple-design.mjs";
import { listTokenThemes } from "./token-themes.mjs";

const key = (name) => String(name).trim().toLowerCase();
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function screens(snapshot) {
  return snapshot.manifest.entries.screens.map((entry) => ({ entry, screen: snapshot.entries[entry] }));
}

// Fails when another object of this kind holds the name; current is the
// object's own name (a rename may change only its case).
export function checkNewName(kind, names, name, current) {
  if (typeof name !== "string" || !name.trim()) fail("invalid_name", `A ${kind} needs a name`);
  if (current !== undefined && key(current) === key(name)) return;
  const taken = names.find((other) => key(other) === key(name));
  if (taken !== undefined)
    fail("duplicate_name", `Another ${kind} is already named ${taken}; names do not repeat`, { kind, name: taken });
}

// --- pages ------------------------------------------------------------------

export function pageRenameOperations(snapshot, { page, platform, element, to }) {
  const found = findPage(snapshot, page);
  if (typeof to !== "string" || !to.trim()) fail("invalid_name", "--to names the new name");
  if (element !== undefined) {
    const presentation = findPresentation(found, platform);
    const nodeId = findElement(presentation.nodes, presentation.rootId, element, found.name);
    return [{ type: "update-presentation-node", screenId: found.id, presentationId: presentation.id, nodeId, changes: { name: to.trim() } }];
  }
  const module = found.name.includes(" / ") ? found.name.split(" / ").slice(0, -1).join(" / ") : undefined;
  const name = to.includes("/") || !module ? to.split("/").map((part) => part.trim()).filter(Boolean).join(" / ") : `${module} / ${to.trim()}`;
  // A name already taken is numbered by the batch ("List 2"), as in the App.
  const entry = snapshot.manifest.entries.screens.find((item) => snapshot.entries[item].id === found.id);
  const screen = structuredClone(found);
  const before = found.name.split(" / ").at(-1);
  const after = name.split(" / ").at(-1);
  screen.name = name;
  for (const presentation of screen.presentations) {
    // "List · desktop" boards and starts named after the page follow it.
    const root = presentation.nodes[presentation.rootId];
    const platform = presentation.platform ?? presentation.name;
    if (root && root.name === `${before} · ${platform}`) root.name = `${after} · ${platform}`;
    for (const flow of presentation.prototypeFlows ?? []) if (flow.name === found.name) flow.name = name;
  }
  return [{ type: "put-screen", screen, entry }];
}

// A whole page, one platform version, or one element (with its content).
export function pageDeleteOperations(snapshot, { page, platform, element }) {
  const screen = findPage(snapshot, page);
  if (element !== undefined) {
    const presentation = findPresentation(screen, platform);
    const nodeId = findElement(presentation.nodes, presentation.rootId, element, screen.name);
    return [{ type: "delete-presentation-node", screenId: screen.id, presentationId: presentation.id, nodeId }];
  }
  const incoming = flowLinks(snapshot).links.filter((link) =>
    link.toScreenId === screen.id && link.screenId !== screen.id &&
    (platform === undefined || link.toPlatform === undefined || key(link.toPlatform) === key(platform)));
  if (platform === undefined && incoming.length)
    fail("page_linked", `${screen.name} is the target of ${incoming.length} link${incoming.length === 1 ? "" : "s"}; unlink them first`, {
      links: incoming.map((link) => `${link.page} / ${link.element} → ${link.to}`),
    });
  if (platform !== undefined) {
    const presentation = findPresentation(screen, platform);
    if (screen.presentations.length === 1)
      fail("last_platform", `${screen.name} has only its ${platform} version; delete the page instead`);
    return [{ type: "delete-presentation", screenId: screen.id, presentationId: presentation.id }];
  }
  return [{ type: "delete-screen", screenId: screen.id }];
}

// --- components -------------------------------------------------------------

function ownComponent(snapshot, name, lookups) {
  const { owner, set } = findComponent(snapshot, name, lookups);
  if (owner !== snapshot)
    fail("component_not_here", `${set.name} belongs to ${owner.manifest.packageId}; edit it there`);
  return set;
}

export function componentRenameOperation(snapshot, { component, element, to }, lookups = {}) {
  const set = ownComponent(snapshot, component, lookups);
  if (typeof to !== "string" || !to.trim()) fail("invalid_name", "--to names the new name");
  const name = to.trim();
  if (element !== undefined) {
    // One element keeps one node id in every variant: rename it in all.
    const first = set.variants[0];
    const nodeId = findElement(first.nodes, first.rootId, element, set.name);
    const renamed = structuredClone(set);
    for (const variant of renamed.variants) {
      if (!variant.nodes[nodeId]) continue;
      variant.nodes[nodeId].name = name;
    }
    return { type: "put-component-set", componentSet: renamed };
  }
  // A name taken in this package is numbered by the batch, as in the App; a
  // Foundation or Library component of that name cannot be numbered here.
  const names = [lookups.foundation, ...(lookups.libraries ?? [])]
    .filter((owner) => owner && owner !== snapshot)
    .flatMap((owner) => [...owner.domain.componentSets.values()].map((other) => other.name));
  checkNewName("component", names, name);
  const renamed = structuredClone(set);
  renamed.name = name;
  // Variant roots named after the component follow it.
  for (const variant of renamed.variants) {
    const root = variant.nodes[variant.rootId];
    if (root?.name === set.name) root.name = name;
  }
  return { type: "put-component-set", componentSet: renamed };
}

// A whole component, or one variant ("Style=secondary"). Used components
// are protected by the operations themselves.
export function componentDeleteOperation(snapshot, { component, variant }, lookups = {}) {
  const set = ownComponent(snapshot, component, lookups);
  if (variant === undefined) return { type: "delete-component-set", componentId: set.id };
  const chosen = findVariant(set, variant);
  if (set.variants.length === 1)
    fail("last_variant", `${set.name} has only ${variantLabel(set, chosen) || "one variant"}; delete the component instead`);
  return { type: "delete-variant", componentId: set.id, variantId: chosen.id };
}

// --- links ------------------------------------------------------------------

const ACTION_NAMES = { navigate: "navigate", "open-overlay": "overlay", "toggle-overlay": "overlay", "close-overlay": "close", "prev-screen": "back", "open-url": "url" };

// Every prototype start and element link, by page and element names.
export function flowLinks(snapshot) {
  const byId = new Map(screens(snapshot).map(({ screen }) => [screen.id, screen]));
  const starts = [], links = [];
  for (const { screen } of screens(snapshot))
    for (const presentation of screen.presentations) {
      const platform = presentation.platform ?? presentation.name;
      for (const flow of presentation.prototypeFlows ?? [])
        starts.push({ page: screen.name, platform, name: flow.name, screenId: screen.id, presentationId: presentation.id, flowId: flow.id });
      for (const [nodeId, node] of Object.entries(presentation.nodes))
        for (const [index, native] of (node.interactions ?? []).entries()) {
          const target = typeof native.destination === "string" ? snapshot.runtime?.reverseNodes?.[native.destination] : undefined;
          const destination = target ? byId.get(target.screenId) : undefined;
          const version = destination?.presentations.find(({ id }) => id === target.presentationId);
          links.push({
            page: screen.name,
            platform,
            element: elementPath(presentation.nodes, presentation.rootId, nodeId),
            on: native["event-type"],
            action: ACTION_NAMES[native["action-type"]] ?? native["action-type"],
            ...(destination ? { to: destination.name, toScreenId: destination.id, toPlatform: version?.platform ?? version?.name } : {}),
            screenId: screen.id,
            presentationId: presentation.id,
            nodeId,
            index,
          });
        }
    }
  return { starts, links };
}

export function flowLinksText({ starts, links }) {
  const lines = [];
  if (starts.length) lines.push("Starts", ...starts.map((start) => `  ${start.page} (${start.platform})${start.name !== start.page ? ` "${start.name}"` : ""}`));
  if (links.length)
    lines.push("Links", ...links.map((link) =>
      `  ${link.page} / ${link.element} —${link.on}→ ${link.to ?? link.action}${link.to && link.action !== "navigate" ? ` (${link.action})` : ""}`));
  return lines.join("\n") || "No starts or links.";
}

// Removes an element's links, or only those on one trigger or to one page.
export function flowUnlinkOperation(snapshot, { from, on, to }) {
  const { screen, presentation, nodeId } = findPageElement(snapshot, from);
  const node = presentation.nodes[nodeId];
  const target = to === undefined ? undefined : findPage(snapshot, to);
  const matches = (link) =>
    (on === undefined || link.on === on) && (target === undefined || link.toScreenId === target.id);
  const mine = flowLinks(snapshot).links.filter((link) => link.screenId === screen.id && link.presentationId === presentation.id && link.nodeId === nodeId);
  const drop = new Set(mine.filter(matches).map((link) => link.index));
  if (!drop.size)
    fail("no_link", `${from} has no ${[on, target && `link to ${target.name}`].filter(Boolean).join(" ") || "link"}`, {
      links: mine.map((link) => `${link.on} → ${link.to ?? link.action}`),
    });
  return {
    type: "update-presentation-node",
    screenId: screen.id,
    presentationId: presentation.id,
    nodeId,
    changes: { interactions: (node.interactions ?? []).filter((_, index) => !drop.has(index)) },
  };
}

// The page stops being a prototype start.
export function flowStartRemoveOperation(snapshot, page) {
  const screen = findPage(snapshot, page);
  const presentation = findPresentation(screen);
  if (!(presentation.prototypeFlows ?? []).length) fail("no_start", `${screen.name} is not a start`);
  return { type: "update-presentation", screenId: screen.id, presentationId: presentation.id, changes: { prototypeFlows: [] } };
}

// --- colors, typographies, media, fonts -------------------------------------

const KIND_NAMES = { colors: "color", typographies: "typography", media: "media file", fonts: "font" };
const assetName = (kind, asset) =>
  kind === "fonts" ? asset.family : [asset.path, asset.name].filter(Boolean).join("/");
const normalAssetName = (name) => String(name).split("/").map((part) => part.trim()).filter(Boolean).join("/");

function assetNamed(snapshot, kind, name) {
  const all = listAssets(snapshot, { kind });
  const found = all.filter((item) => key(assetName(kind, item.asset)) === key(normalAssetName(name)));
  if (found.length === 1) return found[0];
  fail(found.length ? "ambiguous_asset" : "missing_asset",
    found.length ? `Several ${kind} are named ${name}` : `No ${KIND_NAMES[kind]} ${name}`,
    { names: all.map((item) => assetName(kind, item.asset)) });
}

// A typography stores every style field; a new one starts from these.
const TYPOGRAPHY_DEFAULTS = Object.freeze({
  fontFamily: "sourcesanspro",
  fontId: "sourcesanspro",
  fontSize: 14,
  fontStyle: "normal",
  fontVariantId: "regular",
  fontWeight: 400,
  letterSpacing: 0,
  lineHeight: 1.2,
  textTransform: "none",
});

function typographyStyle(snapshot, value) {
  const style = { ...TYPOGRAPHY_DEFAULTS, ...value };
  // A font imported into the package is named by its asset id.
  if (value.fontFamily !== undefined && value.fontId === undefined) {
    const font = listAssets(snapshot, { kind: "fonts" }).find((item) => key(item.asset.family) === key(value.fontFamily));
    style.fontId = font ? font.asset.id : value.fontFamily;
    // The imported variant of that weight and style, else the first one.
    const variants = font?.asset.variants ?? [];
    const variant = variants.find((item) => Number(item.weight) === Number(style.fontWeight) && (item.style ?? "normal") === style.fontStyle) ?? variants[0];
    if (variant && value.fontVariantId === undefined) style.fontVariantId = variant.id;
  }
  return style;
}

// A color (#hex value) or typography (style object) by its full name,
// "Brand/Primary": created when new, its value replaced otherwise.
export function assetSetOperations(snapshot, { kind, name, value }) {
  if (kind !== "colors" && kind !== "typographies") fail("invalid_asset_kind", "Set a color or a typography");
  const full = normalAssetName(name ?? "");
  if (!full) fail("invalid_name", `A ${KIND_NAMES[kind]} needs a name`);
  if (kind === "colors" && (typeof value !== "string" || !value.trim()))
    fail("invalid_color", "--value is a color, for example #1f6feb");
  if (kind === "typographies" && !isRecord(value))
    fail("invalid_typography", "--value is a style object, for example {\"fontFamily\":\"sourcesanspro\",\"fontSize\":16,\"fontWeight\":400}");
  if (kind === "typographies") {
    const unknown = Object.keys(value).filter((field) => !Object.hasOwn(TYPOGRAPHY_DEFAULTS, field));
    if (unknown.length)
      fail("invalid_typography", `A typography style has no ${unknown.join(", ")}`, { fields: Object.keys(TYPOGRAPHY_DEFAULTS) });
  }
  const all = listAssets(snapshot, { kind });
  const existing = all.find((item) => key(assetName(kind, item.asset)) === key(full));
  const field = kind === "colors"
    ? { paint: { type: "solid", color: value.trim() } }
    : { style: existing ? value : typographyStyle(snapshot, value) };
  if (existing)
    return assetIntentOperations(snapshot, { action: "update", kind, assetId: existing.asset.id, entry: existing.entry, changes: field });
  const parts = full.split("/");
  const id = freeId(kind === "colors" ? "color_" : "typo_", slug(parts.join(" ")), new Set(all.map((item) => item.asset.id)));
  return assetIntentOperations(snapshot, {
    action: "put",
    kind,
    asset: { id, name: parts.at(-1), path: parts.slice(0, -1).join("/"), ...field },
  });
}

// One color, typography or media file by name, or one font family (or
// one of its variants by name, "Bold").
export function assetDeleteOperations(snapshot, { kind, name, variant }) {
  const found = assetNamed(snapshot, kind, name);
  let variantId;
  if (variant !== undefined) {
    if (kind !== "fonts") fail("invalid_asset_intent", "Only fonts have variants");
    const match = (found.asset.variants ?? []).find((item) => key(item.name ?? "") === key(variant));
    if (!match)
      fail("missing_font_variant", `${found.asset.family} has no variant ${variant}`, { variants: (found.asset.variants ?? []).map((item) => item.name) });
    variantId = match.id;
  }
  return assetIntentOperations(snapshot, { action: "delete", kind, assetId: found.asset.id, entry: found.entry, ...(variantId ? { variantId } : {}) });
}

// --- duplicates already stored ---------------------------------------------

function repeats(names) {
  const seen = new Map();
  for (const name of names) {
    const at = key(name);
    seen.set(at, [...(seen.get(at) ?? []), name]);
  }
  return [...seen.values()].filter((group) => group.length > 1).map((group) => group[0]);
}

function siblingRepeats(nodes) {
  const found = [];
  for (const node of Object.values(nodes ?? {})) {
    const children = (node.children ?? []).map((id) => nodes[id]).filter(Boolean);
    for (const name of repeats(children.map((child) => child.name ?? "")))
      found.push({ parent: node.name, name });
  }
  return found;
}

// Names stored twice (by the App, an import or an older CLI): each one
// found is an issue, since a repeated name cannot be edited by name.
export function duplicateNameIssues(snapshot, { foundation } = {}) {
  const issues = [];
  const add = (kind, name, where) =>
    issues.push({
      code: "duplicate_name",
      severity: "warning",
      check: "names",
      kind,
      name,
      ...(where ? { where } : {}),
      message: `${where ? `${where}: ` : ""}more than one ${kind} is named ${name}; rename all but one`,
    });
  for (const name of repeats(screens(snapshot).map(({ screen }) => screen.name))) add("page", name);
  for (const name of repeats([...snapshot.domain.componentSets.values()].map((set) => set.name))) add("component", name);
  for (const name of repeats(resolveCanvases(snapshot.manifest, snapshot.entries).map((canvas) => canvas.name))) add("canvas", name);
  for (const name of repeats(listTokenThemes(snapshot, foundation).filter((theme) => theme.packageId === snapshot.manifest.packageId).map((theme) => theme.path)))
    add("theme option", name);
  for (const kind of ["colors", "typographies", "media", "fonts"])
    for (const name of repeats(listAssets(snapshot, { kind }).map((item) => assetName(kind, item.asset)))) add(KIND_NAMES[kind], name);
  for (const { screen } of screens(snapshot))
    for (const presentation of screen.presentations)
      for (const { parent, name } of siblingRepeats(presentation.nodes))
        add("element", name, `${screen.name} (${presentation.platform ?? presentation.name}) / ${parent}`);
  for (const set of snapshot.domain.componentSets.values())
    for (const variant of set.variants)
      for (const { parent, name } of siblingRepeats(variant.nodes))
        add("element", name, `${set.name} (${variantLabel(set, variant) || "default"}) / ${parent}`);
  // One duplicate per place: variants share their elements.
  return issues.filter((issue, index) => issues.findIndex((other) => other.kind === issue.kind && other.name === issue.name && (other.where ?? "").replace(/ \(.*\) \//, " /") === (issue.where ?? "").replace(/ \(.*\) \//, " /")) === index);
}

// --- uses in other packages -------------------------------------------------

// Every node of a package, with where it sits, by name.
function* namedNodes(snapshot) {
  const owner = snapshot.manifest.name ?? snapshot.manifest.packageId;
  for (const { screen } of screens(snapshot))
    for (const presentation of screen.presentations)
      for (const [id, node] of Object.entries(presentation.nodes))
        yield { node, where: () => `${owner}: ${screen.name} / ${elementPath(presentation.nodes, presentation.rootId, id)}` };
  for (const set of snapshot.domain.componentSets.values())
    for (const variant of set.variants)
      for (const [id, node] of Object.entries(variant.nodes))
        yield { node, where: () => `${owner}: ${set.name} / ${elementPath(variant.nodes, variant.rootId, id)}` };
}

// A package that depends on this one (a Product on its Foundation, or a
// package on a Library) still uses a component, one of its variants, or a
// Token: deleting it would break that package. Fails with the places.
export function checkNotUsedElsewhere(dependents, operations, snapshot) {
  const packageId = snapshot.manifest.packageId;
  const uses = [];
  for (const operation of operations) {
    const sets = operation.type === "delete-component-set" || operation.type === "delete-variant" ? [snapshot.domain.componentSets.get(operation.componentId)] : [];
    const variant = operation.type === "delete-variant" ? sets[0]?.variants.find(({ id }) => id === operation.variantId) : undefined;
    for (const dependent of dependents)
      for (const { node, where } of namedNodes(dependent)) {
        const reference = node.instance?.component;
        if (sets[0] && reference?.packageId === packageId && reference.assetId === sets[0].id &&
          (!variant || Object.entries(variant.selection ?? {}).every(([axis, value]) => (node.instance.variant ?? {})[axis] === value)))
          uses.push(where());
        if (operation.type === "remove-token" &&
          Object.values(node.tokenBindings ?? {}).some((binding) => binding?.packageId === packageId && binding.assetId === operation.tokenId))
          uses.push(where());
      }
  }
  if (uses.length)
    fail("used_elsewhere", `Another package still uses this: ${uses[0]}${uses.length > 1 ? ` and ${uses.length - 1} more` : ""}; change those first`, {
      uses: [...new Set(uses)].slice(0, 20),
    });
}
