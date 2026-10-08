// Find pages, platforms, components, variants and elements by the names an
// agent sees in outlines, so reads never need IDs. Each finder fails with
// the names it could have matched.
import { fail } from "./errors.mjs";

const same = (left, right) =>
  String(left).trim().toLowerCase() === String(right).trim().toLowerCase();
const parts = (text) =>
  String(text)
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);

// "List [2]": the second of several objects stored under one name, so a
// repeated name can still be picked and renamed.
function numbered(text) {
  const match = /^(.*?)\s*\[(\d+)\]$/.exec(String(text).trim());
  return match ? { name: match[1], index: Number(match[2]) } : undefined;
}

// The one match for text, or the nth match for "text [n]".
function pickOne(find, text) {
  const matches = find(text);
  if (matches.length) return { matches, one: matches.length === 1 ? matches[0] : undefined };
  const wanted = numbered(text);
  if (!wanted) return { matches };
  const again = find(wanted.name);
  // "Name [2]" when fewer than two remain names nothing; "[1]" of one is it.
  if (wanted.index > again.length) return { matches: [] };
  return { matches: again, one: again[wanted.index - 1] };
}

const numberedNames = (names) => names.map((name, index) => `${name} [${index + 1}]`);

function screens(snapshot) {
  return snapshot.manifest.entries.screens.map((entry) => snapshot.entries[entry]);
}

// "Tasks / Board" or just "Board".
export function findPage(snapshot, name) {
  const all = screens(snapshot);
  const { matches, one } = pickOne((text) => {
    // "Tasks/List" is "Tasks / List".
    const exact = all.filter((screen) => same(parts(screen.name).join("/"), parts(text).join("/")));
    return exact.length ? exact : all.filter((screen) => same(parts(screen.name).at(-1), text));
  }, name);
  if (one) return one;
  const names = matches.map((screen) => screen.name);
  const repeated = names.length > 1 && names.every((item) => same(item, names[0]));
  fail(matches.length ? "ambiguous_page" : "unknown_page",
    matches.length
      ? repeated ? `${names.length} pages are named ${names[0]}; pick one as "${names[0]} [1]" and rename it` : `Several pages are named ${name}; use the full name`
      : `No page ${name}`,
    { pages: matches.length ? (repeated ? numberedNames(names) : names) : all.map((screen) => screen.name) });
}

// A platform names a page's Presentation (desktop, mobile, ...); none
// means the page's main one.
export function findPresentation(screen, platform) {
  const base = screen.presentations.find(({ id }) => id === screen.basePresentationId) ?? screen.presentations[0];
  if (platform === undefined) return base;
  const found = screen.presentations.find((candidate) =>
    same(candidate.platform ?? "", platform) || same(candidate.name ?? "", platform));
  if (!found)
    fail("unknown_platform", `${screen.name} has no ${platform} version`, {
      platforms: screen.presentations.map((candidate) => candidate.platform ?? candidate.name),
    });
  return found;
}

export function findComponent(snapshot, name, { foundation, libraries = [] } = {}) {
  const sets = [];
  for (const owner of [snapshot, foundation, ...libraries]) {
    if (!owner) continue;
    for (const set of owner.domain.componentSets.values())
      if (!sets.some((item) => item.set.id === set.id)) sets.push({ owner, set });
  }
  const { matches, one } = pickOne((text) => sets.filter(({ set }) => same(set.name, text)), name);
  if (one) return one;
  fail(matches.length ? "ambiguous_component" : "unknown_component",
    matches.length ? `${matches.length} components are named ${matches[0].set.name}; pick one as "${matches[0].set.name} [1]" and rename it` : `No component ${name}`,
    { components: matches.length ? numberedNames(matches.map(({ set }) => set.name)) : sets.map(({ set }) => set.name) });
}

// "Style=secondary, Size=sm", or bare values "secondary sm". Unnamed
// properties keep the first variant's value.
export function findVariant(set, text) {
  if (text === undefined) return set.variants[0];
  const wanted = String(text)
    .split(/[,;]|\s+(?=[^=\s]+=)/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [left, right] = item.includes("=") ? item.split("=") : [undefined, item];
      return { axis: left?.trim(), value: right.trim() };
    });
  const labels = set.variants.map((variant) =>
    set.axes.map((axis) => `${axis.name}=${variant.selection?.[axis.id]}`).join(", "));
  const resolved = wanted.map(({ axis, value }) => {
    const candidates = set.axes.filter((candidate) =>
      axis === undefined
        ? candidate.domain.some((item) => same(item, value))
        : same(candidate.name, axis));
    if (candidates.length !== 1)
      fail("unknown_variant", `${set.name} has no ${axis ? `${axis}=${value}` : value}`, { variants: labels });
    const option = candidates[0].domain.find((item) => same(item, value));
    if (option === undefined)
      fail("unknown_variant", `${set.name} has no ${candidates[0].name}=${value}`, { variants: labels });
    return [candidates[0].id, option];
  });
  const scored = set.variants
    .filter((variant) => resolved.every(([axis, value]) => variant.selection?.[axis] === value))
    .map((variant) => ({
      variant,
      // Prefer the variant that differs least from the first one.
      distance: set.axes.filter((axis) =>
        variant.selection?.[axis.id] !== set.variants[0].selection?.[axis.id]).length,
    }))
    .sort((left, right) => left.distance - right.distance);
  if (!scored.length) fail("unknown_variant", `${set.name} has no variant ${text}`, { variants: labels });
  return scored[0].variant;
}

export function variantLabel(set, variant) {
  return set.axes.map((axis) => `${axis.name}=${variant.selection?.[axis.id]}`).join(", ");
}

// "Top bar", or a path "Content / Top bar" when the name repeats.
export function findElement(nodes, rootId, text, where) {
  const parent = new Map();
  for (const [id, node] of Object.entries(nodes))
    for (const child of node.children ?? []) parent.set(child, id);
  const chain = (id) => {
    const names = [];
    for (let at = id; at !== undefined && at !== rootId; at = parent.get(at)) names.unshift(nodes[at]?.name);
    return names;
  };
  const find = (wanted) => {
    const path = parts(wanted);
    return Object.keys(nodes).filter((id) => {
      if (id === rootId || !same(nodes[id].name, path.at(-1))) return false;
      // Earlier path parts must be ancestors, in order.
      const names = chain(id).slice(0, -1);
      let index = 0;
      for (const name of names) if (index < path.length - 1 && same(name, path[index])) index += 1;
      return index === path.length - 1;
    });
  };
  const { matches, one } = pickOne(find, text);
  if (one) return one;
  // Siblings stored under one name: only a number tells them apart.
  const siblings = matches.length > 1 && matches.every((id) => parent.get(id) === parent.get(matches[0]));
  fail(matches.length ? "ambiguous_element" : "unknown_element",
    matches.length
      ? siblings
        ? `${matches.length} elements in ${where} are named ${nodes[matches[0]].name}; pick one as "${text} [1]" and rename it`
        : `Several elements match ${text} in ${where}; name a parent too, for example "${chain(matches[0]).slice(-2).join(" / ")}"`
      : `No element ${text} in ${where}`,
    {
      elements: siblings
        ? numberedNames(matches.map((id) => chain(id).join(" / ")))
        : (matches.length ? matches : Object.keys(nodes).filter((id) => id !== rootId))
          .slice(0, 40)
          .map((id) => chain(id).join(" / ")),
    });
}

// "Tasks / List / Open" or "List / Card / Open": the longest leading part
// that names a page, and the element path after it.
// "Page / Element", or "Page / Copy / Element" for an element inside a copy
// of a component: then nodeId is the copy and inside names the component's
// element (sourcePath, its name and type). lookups find the component.
export function findPageElement(snapshot, text, platform, lookups) {
  const path = parts(text);
  for (let cut = path.length - 1; cut >= 1; cut -= 1) {
    const name = path.slice(0, cut).join(" / ");
    const all = screens(snapshot);
    const exact = all.filter((screen) => same(screen.name, name));
    const matches = exact.length ? exact : all.filter((screen) => same(parts(screen.name).at(-1), name));
    if (matches.length !== 1) continue;
    const screen = matches[0];
    const presentation = findPresentation(screen, platform);
    const rest = path.slice(cut);
    try {
      const nodeId = findElement(presentation.nodes, presentation.rootId, rest.join(" / "), screen.name);
      return { screen, presentation, nodeId };
    } catch (error) {
      if (error?.code !== "unknown_element" || !lookups) throw error;
      const inside = findInsideCopy(snapshot, presentation, rest, screen.name, lookups);
      if (!inside) throw error;
      return { screen, presentation, nodeId: inside.copyId, inside };
    }
  }
  fail("unknown_page", `${text} does not start with a page name: "Page / Element"`, {
    pages: screens(snapshot).map((screen) => screen.name),
  });
}

// "Copy / Element": the longest leading part that names a stored copy, then
// the element in the variant that copy shows.
function findInsideCopy(snapshot, presentation, rest, where, { foundation, libraries = [] }) {
  for (let split = rest.length - 1; split >= 1; split -= 1) {
    let copyId;
    try {
      copyId = findElement(presentation.nodes, presentation.rootId, rest.slice(0, split).join(" / "), where);
    } catch {
      continue;
    }
    const copy = presentation.nodes[copyId];
    if (!copy.instance) continue;
    const set = [snapshot, foundation, ...libraries].filter(Boolean)
      .map((owner) => owner.domain.componentSets.get(copy.instance.component.assetId)).find(Boolean);
    if (!set) continue;
    const variant = set.variants.find((candidate) =>
      Object.entries(copy.instance.variant ?? {}).every(([axis, value]) => candidate.selection?.[axis] === value)) ?? set.variants[0];
    const sourcePath = findElement(variant.nodes, variant.rootId, rest.slice(split).join(" / "), `${copy.name} (${set.name})`);
    const element = variant.nodes[sourcePath];
    return { copyId, sourcePath, name: element.name, type: element.type, component: set.name, path: [copy.name, element.name].join(" / ") };
  }
  return undefined;
}

// The shortest path that names an element on its page: "Open", or
// "Card / Open" when another element is also named Open.
export function elementPath(nodes, rootId, id) {
  const parent = new Map();
  for (const [key, node] of Object.entries(nodes))
    for (const child of node.children ?? []) parent.set(child, key);
  const chain = [];
  for (let at = id; at !== undefined && at !== rootId; at = parent.get(at)) chain.unshift(nodes[at]?.name ?? at);
  for (let length = 1; length <= chain.length; length += 1) {
    const candidate = chain.slice(-length).join(" / ");
    try {
      if (findElement(nodes, rootId, candidate, "") === id) return candidate;
    } catch {
      // Still ambiguous: name one more parent.
    }
  }
  return chain.join(" / ");
}
