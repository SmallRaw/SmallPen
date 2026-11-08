// Name-based edits of pages, components, links, colors, typographies,
// media and fonts, and the rule behind all of them: names never repeat.
// Each planner finds its target by the name an agent reads in outlines
// and returns the operations the ID-based commands would write, so the
// CLI and the App keep one storage model.
import { resolveCanvases } from "./canvases.mjs";
import {
  listAssets,
} from "./local-authoring.mjs";
import {
  elementPath,
  componentReferenceLookup,
  instanceSourceTree,
  variantLabel,
} from "./named-targets.mjs";
import { listTokenThemes } from "./token-themes.mjs";

const key = (name) => String(name).trim().toLowerCase();
function screens(snapshot) {
  return snapshot.manifest.entries.screens.map((entry) => ({ entry, screen: snapshot.entries[entry] }));
}

// --- pages ------------------------------------------------------------------

// --- components -------------------------------------------------------------

// --- links ------------------------------------------------------------------

const ACTION_NAMES = { navigate: "navigate", "open-overlay": "overlay", "toggle-overlay": "overlay", "close-overlay": "close", "prev-screen": "back", "open-url": "url" };

// Every prototype start and element link, by page and element names.
// Links from elements inside copies are the copies' "<element>:interactions"
// overrides; lookups name the component's element when it is not here.
export function flowLinks(snapshot, { foundation, libraries = [] } = {}) {
  const byId = new Map(screens(snapshot).map(({ screen }) => [screen.id, screen]));
  const components = componentReferenceLookup(snapshot, { foundation, libraries });
  const elementName = (copy, sourcePath) => {
    const tree = instanceSourceTree(copy.instance, components);
    return tree.nodes[sourcePath] ? elementPath(tree.nodes, tree.rootId, sourcePath, { full: true }) : "element";
  };
  const starts = [], links = [];
  for (const { screen } of screens(snapshot))
    for (const presentation of screen.presentations) {
      const platform = presentation.platform ?? presentation.name;
      for (const flow of presentation.prototypeFlows ?? [])
        starts.push({ page: screen.name, platform, name: flow.name, screenId: screen.id, presentationId: presentation.id, flowId: flow.id });
      const add = (nodeId, element, list, sourcePath) => {
        for (const [index, native] of (list ?? []).entries()) {
          const target = typeof native.destination === "string" ? snapshot.runtime?.reverseNodes?.[native.destination] : undefined;
          const destination = target ? byId.get(target.screenId) : undefined;
          const version = destination?.presentations.find(({ id }) => id === target.presentationId);
          links.push({
            page: screen.name,
            platform,
            element,
            on: native["event-type"],
            action: ACTION_NAMES[native["action-type"]] ?? native["action-type"],
            ...(destination ? { to: destination.name, toScreenId: destination.id, toPlatform: version?.platform ?? version?.name } : {}),
            screenId: screen.id,
            presentationId: presentation.id,
            nodeId,
            ...(sourcePath !== undefined ? { sourcePath } : {}),
            index,
          });
        }
      };
      for (const [nodeId, node] of Object.entries(presentation.nodes)) {
        const path = elementPath(presentation.nodes, presentation.rootId, nodeId);
        add(nodeId, path, node.interactions);
        for (const [key, list] of Object.entries(node.instance?.overrides ?? {}))
          if (key.endsWith(":interactions")) {
            const sourcePath = key.slice(0, -":interactions".length);
            add(nodeId, `${path} / ${elementName(node, sourcePath)}`, list, sourcePath);
          }
      }
    }
  return { starts, links };
}

export function flowLinksText({ starts, links }) {
  const lines = [];
  if (starts.length) lines.push("Starts", ...starts.map((start) => `  ${start.page} (${start.platform})${![start.page, `${start.page} (${start.platform})`].includes(start.name) ? ` "${start.name}"` : ""}`));
  if (links.length)
    lines.push("Links", ...links.map((link) =>
      `  ${link.page} (${link.platform}) / ${link.element} —${link.on}→ ${link.to ?? link.action}${link.to && link.action !== "navigate" ? ` (${link.action})` : ""}`));
  return lines.join("\n") || "No starts or links.";
}

// --- colors, typographies, media, fonts -------------------------------------

const KIND_NAMES = { colors: "color", typographies: "typography", media: "media file", fonts: "font" };
const assetName = (kind, asset) =>
  kind === "fonts" ? asset.family : [asset.path, asset.name].filter(Boolean).join("/");
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

