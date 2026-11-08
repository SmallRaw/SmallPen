// Find pages, platforms, components, variants and elements by the names an
// agent sees in outlines, so reads never need IDs. Each finder fails with
// the names it could have matched.
import { fail } from "./errors.mjs";
import { findComponentVariant } from "./components-domain.mjs";
import { MAX_NODE_DEPTH } from "./internal.mjs";

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

// References are package-qualified: a local component may share an ID with
// a library component without being the source of that library's copies.
export function componentReferenceLookup(snapshot, { foundation, libraries = [] } = {}) {
  return (reference) => {
    const owner = [snapshot, foundation, ...libraries].find(candidate =>
      candidate?.manifest.packageId === reference.packageId);
    const set = owner?.domain.componentSets.get(reference.assetId);
    if (!set) fail("missing_component", `Component not found: ${reference.assetId}`, { reference });
    return { owner, set };
  };
}

// A variant override selects axes independently; an outer copy may change
// one axis while retaining axes selected on the nested copy itself.
export function mergeInstanceOverrides(...tables) {
  const result = {};
  for (const table of tables)
    for (const [path, value] of Object.entries(table ?? {}))
      result[path] = path.endsWith(":variant") ? { ...result[path], ...value } : value;
  return result;
}

// A read-only source tree with the same nested IDs used by Instance
// overrides. Keep nested copies as nodes, with their selected content below
// them, so name lookup and reverse lookup share one ancestry model.
export function instanceSourceTree(instance, components) {
  const nodes = {};
  const stack = new Set();
  const expand = (copy, prefix = "", extra = {}, depth = 0) => {
    const { owner, set } = components(copy.component);
    const key = `${owner.manifest.packageId}:${set.id}`;
    if (stack.has(key)) fail("component_instance_cycle", `Component instance cycle includes ${set.id}`, { componentId: set.id });
    if (depth >= MAX_NODE_DEPTH) fail("node_depth_exceeded", `Component instances are deeper than ${MAX_NODE_DEPTH} levels`, { maxDepth: MAX_NODE_DEPTH });
    const variant = findComponentVariant(set, copy.variant ?? {}).variant;
    if (!variant) fail("missing_variant", `${set.name} has no variant for this copy`, { componentId: set.id, selection: copy.variant });
    stack.add(key);
    const overrides = mergeInstanceOverrides(copy.overrides, extra);
    const idOf = id => id === variant.rootId && prefix ? prefix : prefix ? `${prefix}__${id}` : id;
    const visit = (sourceId) => {
      const source = variant.nodes[sourceId];
      const id = idOf(sourceId);
      const fields = Object.fromEntries(Object.entries(overrides)
        .filter(([path]) => path.startsWith(`${sourceId}:`))
        .map(([path, value]) => [path.slice(sourceId.length + 1), value]));
      let node = { ...structuredClone(source), ...structuredClone(fields), id };
      if (source.instance) {
        const nested = { ...structuredClone(source.instance), variant: { ...source.instance.variant, ...fields.variant } };
        const nestedOverrides = Object.fromEntries(Object.entries(overrides)
          .filter(([path]) => path.startsWith(`${sourceId}__`))
          .map(([path, value]) => [path.slice(sourceId.length + 2), value]));
        expand(nested, id, nestedOverrides, depth + 1);
        node = { ...nodes[id], ...node, children: nodes[id].children, instance: nested };
      } else {
        node.children = (source.children ?? []).map(idOf);
        for (const child of source.children ?? []) visit(child);
      }
      nodes[id] = node;
    };
    visit(variant.rootId);
    stack.delete(key);
    return idOf(variant.rootId);
  };
  return { nodes, rootId: expand(instance) };
}

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
      if (!sets.some((item) => item.set.id === set.id && item.owner.manifest.packageId === owner.manifest.packageId)) sets.push({ owner, set });
  }
  const { matches, one } = pickOne((text) => sets.filter(({ set }) => same(set.name, text)), name);
  if (one) return one;
  fail(matches.length ? "ambiguous_component" : "unknown_component",
    matches.length ? `${matches.length} components are named ${matches[0].set.name}; pick one as "${matches[0].set.name} [1]" and rename it` : `No component ${name}`,
    { components: matches.length ? numberedNames(matches.map(({ set }) => set.name)) : sets.map(({ set }) => set.name) });
}

// "Style: secondary; Size: sm" as in a file's props, "Style=secondary,
// Size=sm", or bare values "secondary sm". Every variant the text names:
// unnamed properties match any value.
function findVariants(set, text) {
  if (text === undefined) return set.variants;
  const wanted = String(text)
    .split(/[,;]|\s+(?=[^=:\s]+\s*[=:])/)
    .map((item) => item.trim())
    .filter(Boolean)
    .flatMap((item) => {
      const at = item.search(/[=:]/);
      if (at !== -1) return [{ axis: item.slice(0, at).trim(), value: item.slice(at + 1).trim() }];
      // Bare values: "secondary md" is two unless one value has a space.
      const whole = set.axes.some((axis) => axis.domain.some((value) => same(value, item)));
      return (whole ? [item] : item.split(/\s+/)).map((value) => ({ axis: undefined, value }));
    });
  const labels = set.variants.map((variant) => variantLabel(set, variant));
  const resolved = wanted.map(({ axis, value }) => {
    const candidates = set.axes.filter((candidate) =>
      axis === undefined
        ? candidate.domain.some((item) => same(item, value))
        : same(candidate.name, axis));
    if (candidates.length !== 1)
      fail("unknown_variant", `${set.name} has no ${axis ? `${axis}: ${value}` : value}`, { variants: labels });
    const option = candidates[0].domain.find((item) => same(item, value));
    if (option === undefined)
      fail("unknown_variant", `${set.name} has no ${candidates[0].name}: ${value}`, { variants: labels });
    return [candidates[0].id, option];
  });
  const found = set.variants.filter((variant) => resolved.every(([axis, value]) => variant.selection?.[axis] === value));
  if (!found.length) fail("unknown_variant", `${set.name} has no variant ${text}`, { variants: labels });
  return found;
}

// The one variant to read: of several matches, the one that differs least
// from the first variant. Edits use findVariants.
export function findVariant(set, text) {
  if (text === undefined) return set.variants[0];
  const distance = (variant) => set.axes.filter((axis) =>
    variant.selection?.[axis.id] !== set.variants[0].selection?.[axis.id]).length;
  return findVariants(set, text)
    .map((variant) => ({ variant, distance: distance(variant) }))
    .sort((left, right) => left.distance - right.distance)[0].variant;
}

export function variantLabel(set, variant) {
  return set.axes.map((axis) => `${axis.name}: ${variant.selection?.[axis.id]}`).join("; ");
}

// "Top bar", or a path "Content / Top bar" when the name repeats. Path
// parts are ancestors in order; when several elements match, the one whose
// path ends with exactly those parents ("Content / Heading" is Heading
// directly in Content) wins, then the one whose whole path it is.
export function findElement(nodes, rootId, text, where, { allowRoot = false } = {}) {
  const parent = new Map();
  for (const [id, node] of Object.entries(nodes))
    for (const child of node.children ?? []) parent.set(child, id);
  const chain = (id) => {
    const names = [];
    for (let at = id; at !== undefined && at !== rootId; at = parent.get(at)) names.unshift(nodes[at]?.name);
    return names;
  };
  const endsWith = (names, path) =>
    names.length >= path.length && path.every((name, index) => same(names[names.length - path.length + index], name));
  const find = (wanted) => {
    const path = parts(wanted);
    const all = Object.keys(nodes).filter((id) => {
      if (id === rootId || !same(nodes[id].name, path.at(-1))) return false;
      const names = chain(id).slice(0, -1);
      let index = 0;
      for (const name of names) if (index < path.length - 1 && same(name, path[index])) index += 1;
      return index === path.length - 1;
    });
    if (all.length < 2) return all;
    const direct = all.filter((id) => endsWith(chain(id), path));
    if (direct.length === 1) return direct;
    const whole = direct.filter((id) => chain(id).length === path.length);
    return whole.length === 1 ? whole : direct.length ? direct : all;
  };
  // The shortest path that finds this element alone.
  const uniquePath = (id) => {
    const names = chain(id);
    for (let size = 1; size <= names.length; size += 1) {
      const path = names.slice(-size).join(" / ");
      const found = find(path);
      if (found.length === 1 && found[0] === id) return path;
    }
    return names.join(" / ");
  };
  const { matches, one } = pickOne(find, text);
  if (one) return one;
  // Reads and field edits can name the root. Descendant paths keep their
  // meaning; move and delete callers still exclude the root by default.
  if (!matches.length && allowRoot && same(nodes[rootId]?.name, text)) return rootId;
  // Siblings stored under one name: only a number tells them apart.
  const siblings = matches.length > 1 && matches.every((id) => parent.get(id) === parent.get(matches[0]));
  fail(matches.length ? "ambiguous_element" : "unknown_element",
    matches.length
      ? siblings
        ? `${matches.length} elements in ${where} are named ${nodes[matches[0]].name}; pick one as "${text} [1]" and rename it`
        : `Several elements match ${text} in ${where}; name one by its path, for example "${uniquePath(matches[0])}"`
      : `No element ${text} in ${where}`,
    {
      elements: siblings
        ? numberedNames(matches.map((id) => chain(id).join(" / ")))
        : matches.length
          ? matches.slice(0, 40).map(uniquePath)
          : Object.keys(nodes).filter((id) => id !== rootId || allowRoot).slice(0, 40).map((id) => id === rootId ? nodes[id].name : chain(id).join(" / ")),
    });
}

// The shortest path that names an element on its page: "Open", or
// "Card / Open" when another element is also named Open.
export function elementPath(nodes, rootId, id, { full = false } = {}) {
  const parent = new Map();
  for (const [key, node] of Object.entries(nodes))
    for (const child of node.children ?? []) parent.set(child, key);
  const chain = [];
  for (let at = id; at !== undefined && at !== rootId; at = parent.get(at)) chain.unshift(nodes[at]?.name ?? at);
  if (full) return chain.join(" / ");
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
