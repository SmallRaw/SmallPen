import {
  appliedTokenFields,
  asciiWireframe,
  createSemanticTree,
  defaultTokenThemeIds,
  listTokenThemes,
  layoutProjectionDiagnostics,
  projectComponentVariant,
  projectDesignView,
  resolveContext,
  resolveDesignView,
  resolveEffectiveToken,
  SmallPenError,
  tokenLibraryOf,
} from "@smallpen/core";
import { measureProjectionText } from "@smallpen/local-package";

export function themeSettings(workspace, { full = false } = {}) {
  const { product, foundation } = workspace;
  const themes = listTokenThemes(product, foundation);
  const defaults = new Map(
    [
      product,
      ...(foundation && foundation !== product ? [foundation] : []),
    ].map((snapshot) => [
      snapshot.manifest.packageId,
      defaultTokenThemeIds(tokenLibraryOf(snapshot)),
    ]),
  );
  const groups = [...new Set(themes.map(({ group }) => group))].map((name) => {
    const options = themes
      .filter(({ group }) => group === name)
      .map(({ setIds, sets, ...theme }) => ({
        ...theme,
        // Which token Sets an option activates is storage; --full shows it.
        ...(full ? { setIds, sets } : {}),
        default: defaults.get(theme.packageId)?.includes(theme.id) ?? false,
      }));
    // Agents name options as Group/Option; IDs and Sets need --full.
    if (!full)
      return {
        name,
        default: options.find((option) => option.default)?.path,
        selected: options.find(({ active }) => active)?.path,
        options: options.map(({ path }) => path),
      };
    return {
      name,
      default: options.find((option) => option.default),
      selected: options.find(({ active }) => active)?.path,
      options,
    };
  });
  return {
    groups,
    selection: {
      themes: themes.filter(({ active }) => active).map(({ path }) => path),
    },
    ...(full && workspace.appSelection
      ? { appSelection: workspace.appSelection }
      : {}),
  };
}

const CHANGE_LABELS = {
  cornerRadius: "radius",
  fills: "fill",
  height: "size",
  instance: "nested variant",
  strokes: "stroke",
  textBlocks: "text",
  tokenBindings: "token binding",
  visible: "visibility",
  width: "size",
  x: "position",
  y: "position",
};

function variantPositions(variant) {
  const nodes = new Map();
  const visit = (id, position) => {
    const node = variant.nodes[id];
    if (!node) return;
    nodes.set(position, node);
    for (const [index, childId] of (node.children ?? []).entries())
      visit(childId, `${position}/${index}`);
  };
  visit(variant.rootId, "root");
  return nodes;
}

// What one variant changes against another: node name -> change labels.
function variantChanges(left, right, changes = new Map()) {
  const add = (name, label) => {
    if (!changes.has(name)) changes.set(name, new Set());
    changes.get(name).add(label);
  };
  const a = variantPositions(left);
  const b = variantPositions(right);
  for (const position of new Set([...a.keys(), ...b.keys()])) {
    const before = a.get(position);
    const after = b.get(position);
    const name = (after ?? before).name;
    if (!before || !after) {
      add(name, before ? "removed" : "added");
      continue;
    }
    for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (["id", "name", "children", "sourceNodeId", "touched"].includes(field)) continue;
      if (JSON.stringify(before[field]) !== JSON.stringify(after[field]))
        add(name, CHANGE_LABELS[field] ?? field);
    }
  }
  return changes;
}

// "Node: a, b" lines; a rebinding that also changes the value says nothing more.
function changeLines(changes) {
  return [...changes].map(([name, labels]) => {
    const shown = [...labels].filter((label) =>
      label !== "token binding" || labels.size === 1);
    return `${name}: ${shown.join(", ")}`;
  });
}

export function axisLabel(axis, value) {
  return `${axis.name}=${axis.labels?.[value] ?? value}`;
}

// names: {token(reference) -> path, component(reference) -> name}, so the
// summary reads by name once IDs are left out of the reply.
export function componentSummary(component, names = {}) {
  const variants = component.variants;
  const first = variants[0];
  const tokens = new Map(),
    nested = new Map(),
    differences = new Set();
  const baseline = variantPositions(first);
  for (const variant of variants)
    for (const [position, node] of variantPositions(variant)) {
      const base = baseline.get(position);
      for (const field of new Set([...Object.keys(node), ...Object.keys(base ?? {})]))
        if (!["id", "name", "children"].includes(field) &&
            JSON.stringify(node[field]) !== JSON.stringify(base?.[field]))
          differences.add(field);
      if ((node.children ?? []).length !== (base?.children ?? []).length) differences.add("children");
      for (const reference of Object.values(node.tokenBindings ?? {}))
        tokens.set(JSON.stringify(reference), reference);
      if (node.instance)
        nested.set(JSON.stringify(node.instance.component), node.instance.component);
    }
  // Each property: what changes between variants that differ only in it.
  const axes = (component.axes ?? []).map((axis) => {
    const changes = new Map();
    let pairs = 0;
    for (const left of variants) {
      for (const right of variants) {
        if (pairs >= 24) break;
        if (left === right) continue;
        const only = (component.axes ?? []).every((other) =>
          other.id === axis.id
            ? left.selection?.[other.id] !== right.selection?.[other.id]
            : left.selection?.[other.id] === right.selection?.[other.id]);
        if (!only || left.selection?.[axis.id] !== first.selection?.[axis.id]) continue;
        pairs += 1;
        variantChanges(left, right, changes);
      }
    }
    const used = [...new Set(variants.map((variant) => variant.selection?.[axis.id]))]
      .filter((value) => value !== undefined);
    const values = (axis.domain ?? used).filter((value) => used.includes(value));
    const lines = changeLines(changes);
    return {
      id: axis.id,
      name: axis.name,
      values: values.map((value) => axis.labels?.[value] ?? value),
      changes: lines.slice(0, 6),
      ...(lines.length > 6 ? { moreChanges: lines.length - 6 } : {}),
    };
  });
  return {
    id: component.id,
    name: component.name,
    variantCount: variants.length,
    mainVariant: {
      id: first.id,
      selection: (component.axes ?? []).map((axis) => axisLabel(axis, first.selection?.[axis.id])),
    },
    axes,
    // Raw fields any variant changes against the main one.
    differences: [...differences].sort(),
    tokenBindings: [...tokens.values()].map((reference) => ({ ...reference, ...(names.token?.(reference) ? { path: names.token(reference) } : {}) })),
    nestedComponents: [...nested.values()].map((reference) => ({ ...reference, ...(names.component?.(reference) ? { name: names.component(reference) } : {}) })),
  };
}

// Readable header lines for a component summary.
// heading names what the structure below shows; by default the main variant.
export function componentSummaryText(summary, components, heading = "Main variant structure:") {
  const lines = [
    `${summary.name} · component · ${summary.variantCount} variant${summary.variantCount === 1 ? "" : "s"}${summary.mainVariant.selection.length ? ` · main: ${summary.mainVariant.selection.join(", ")}` : ""}`,
  ];
  for (const axis of summary.axes) {
    lines.push(`  ${axis.name}: ${axis.values.join(" / ")}${axis.changes.length ? ` → changes ${axis.changes.join("; ")}${axis.moreChanges ? `; +${axis.moreChanges} more` : ""}` : " → no visible change"}`);
  }
  if (summary.nestedComponents.length) {
    lines.push(`  nested: ${summary.nestedComponents.map((reference) => components?.(reference)?.name ?? reference.assetId).join(", ")}`);
  }
  lines.push(heading);
  return lines.join("\n");
}

// Component Sets by reference, across the Product, Foundation and libraries.
export function componentLookup(workspace) {
  const sets = new Map();
  for (const snapshot of [workspace.product, workspace.foundation, ...(workspace.libraries ?? [])]) {
    if (!snapshot) continue;
    for (const set of snapshot.domain.componentSets.values()) {
      sets.set(`${snapshot.manifest.packageId}\0${set.id}`, set);
      if (!sets.has(set.id)) sets.set(set.id, set);
    }
  }
  return (reference) =>
    reference
      ? (sets.get(`${reference.packageId}\0${reference.assetId}`) ?? sets.get(reference.assetId))
      : undefined;
}

export function selectedDesign(workspace, selector, target = {}) {
  const { product, foundation, libraries = [] } = workspace;
  const options = { foundation, libraries };
  let projection, selection, component;
  if (target.componentId) {
    const owners = [...new Set([product, foundation, ...libraries])].filter(
      (snapshot) =>
        snapshot?.domain.componentSets.has(target.componentId) &&
        (!target.packageId || target.packageId === snapshot.manifest.packageId),
    );
    if (owners.length > 1)
      throw new SmallPenError(
        "ambiguous_component",
        "Component ID exists in several owners; pass --package-id",
        { packageIds: owners.map((snapshot) => snapshot.manifest.packageId) },
      );
    const owner = owners[0];
    const set = owner?.domain.componentSets.get(target.componentId);
    if (!set)
      throw new SmallPenError(
        "missing_component",
        `No Component Set ${target.componentId}; use search-components to find its owning package`,
      );
    const variant = target.variantId
      ? set.variants.find(({ id }) => id === target.variantId)
      : set.variants[0];
    if (!variant)
      throw new SmallPenError(
        "missing_variant",
        `No variant ${target.variantId}`,
        { validVariantIds: set.variants.map(({ id }) => id) },
      );
    const context = resolveContext(product, foundation, selector.context ?? {});
    const nodes = projectComponentVariant(product, variant, {
      ...options,
      owner,
      context,
    });
    projection = {
      nodes,
      rootId: variant.rootId,
      context,
      diagnostics: layoutProjectionDiagnostics(nodes),
    };
    selection = {
      componentId: set.id,
      variantId: variant.id,
      packageId: owner.manifest.packageId,
      context,
    };
    const known = [product, options.foundation, ...(options.libraries ?? [])].filter(Boolean);
    const ownerOf = (reference) => known.find((snapshot) => snapshot.manifest.packageId === reference?.packageId);
    component = componentSummary(set, {
      token: (reference) => ownerOf(reference)?.domain.tokens.get(reference.assetId)?.path,
      component: (reference) => ownerOf(reference)?.domain.componentSets.get(reference.assetId)?.name,
    });
  } else {
    const resolved = resolveDesignView(product, {
      ...options,
      selector: { ...selector, viewFormat: "semantic" },
    });
    projection = projectDesignView(product, resolved, options);
    const { viewFormat: _format, ...resolvedSelection } = resolved.selection;
    selection = resolvedSelection;
  }
  const wholeTree = createSemanticTree(product, projection);
  const renderProjection = projection;
  let ancestors = [];
  const find = (node, parents = []) => {
    if (node.id === target.nodeId) {
      ancestors = parents;
      return node;
    }
    for (const child of node.children ?? []) {
      const found = find(child, [...parents, projection.nodes[node.id]]);
      if (found) return found;
    }
  };
  let root = target.nodeId ? find(wholeTree.root) : wholeTree.root;
  if (!root)
    throw new SmallPenError(
      "missing_node",
      `Projected Node not found: ${target.nodeId}`,
    );
  if (ancestors.some((node) => node.visible === false))
    root = { ...root, visible: false };
  if (target.nodeId) {
    const nodes = {};
    const visit = (node) => {
      nodes[node.id] = projection.nodes[node.id];
      for (const child of node.children) visit(child);
    };
    visit(root);
    const relevant = new Set([
      ...Object.keys(nodes),
      ...ancestors.map((node) => node.id),
    ]);
    projection = {
      ...projection,
      nodes,
      rootId: root.id,
      diagnostics: (projection.diagnostics ?? []).filter(
        (diagnostic) => !diagnostic.nodeId || relevant.has(diagnostic.nodeId),
      ),
    };
    selection = { ...selection, nodeId: target.nodeId };
  }
  const references = new Map();
  for (const node of Object.values(projection.nodes))
    for (const reference of Object.values(node.tokenBindings ?? {}))
      references.set(JSON.stringify(reference), reference);
  const tokenSources = [...references.values()].map((reference) => {
    const resolved = resolveEffectiveToken(product, reference, {
      ...options,
      context: selection.context,
    });
    return {
      reference,
      path: resolved.token.path,
      value: resolved.value,
      sourcePackageId: resolved.sourcePackageId,
      sourceTokenId: resolved.sourceTokenId,
    };
  });
  const origin = renderProjection.nodes[renderProjection.rootId];
  const crop = target.nodeId
    ? {
        x: root.bounds.x - origin.x,
        y: root.bounds.y - origin.y,
        width: root.bounds.width,
        height: root.bounds.height,
      }
    : undefined;
  return {
    projection,
    renderProjection,
    crop,
    ancestors,
    tree: { ...wholeTree, root },
    tokenSources,
    selection: { ...selection, ...themeSettings(workspace).selection },
    ...(component ? { component } : {}),
  };
}

// Texts in reading order: a flex line places its last stored child first.
function descendantTexts(node, projection) {
  if (!node.visible) return [];
  const raw = projection?.nodes?.[node.id];
  const direction = raw?.layout === "flex" ? raw["layout-flex-dir"] ?? "row" : null;
  const stored = node.children ?? [];
  const children = direction && !direction.endsWith("reverse") ? [...stored].reverse() : stored;
  return [node.text, ...children.flatMap((child) => descendantTexts(child, projection))].filter(
    Boolean,
  );
}
function instanceReference(node, projection) {
  const raw = projection.nodes[node.id];
  return raw.type === "INSTANCE" || raw.instance
    ? (node.component ?? raw.instance?.component)
    : undefined;
}

// Quoted; a long text says how much the outline left out, so a cut here is
// not read as text the design clips.
function shortText(texts, limit = 60) {
  const text = texts.join(" / ");
  return text.length > limit ? `"${text.slice(0, limit - 1)}…" (+${text.length - limit + 1} chars)` : `"${text}"`;
}

// Visual values written as literals: the places a Token could be bound.
function literalFields(raw) {
  // Applied Token names from older App edits bind as well.
  const applied = appliedTokenFields(raw.appliedTokens);
  const bound = (...fields) => fields.some((field) => raw.tokenBindings?.[field] || applied[field]);
  const literal = [];
  if (raw.fills?.length && !bound("fill", "fills.0")) literal.push("fill");
  if (raw.strokes?.length && !bound("stroke", "strokes.0")) literal.push("stroke");
  if (raw.cornerRadius && !bound("cornerRadius", "radiusTopLeft", "radiusTopRight", "radiusBottomRight", "radiusBottomLeft")) literal.push("radius");
  if (raw.shadow && (!Array.isArray(raw.shadow) || raw.shadow.length) && !bound("shadow")) literal.push("shadow");
  if (raw.type === "TEXT" && raw.textStyle && !bound("typography", "fontSize", "fontFamily", "fontWeight", "lineHeight", "letterSpacing")) literal.push("type");
  return literal;
}

// An instance's variant as "Property=value" pairs, in property order.
function variantPairs(selection, set) {
  if (!selection) return [];
  const axes = set?.axes ?? [];
  const known = axes.filter((axis) => selection[axis.id] !== undefined)
    .map((axis) => [axis.id, axisLabel(axis, selection[axis.id])]);
  const rest = Object.entries(selection)
    .filter(([id]) => !axes.some((axis) => axis.id === id))
    .map(([id, value]) => [id, `${id}=${value}`]);
  return [...known, ...rest];
}

// One line per meaningful element: what it is, its size and layout, its
// text, and any visual values left as literals. Component internals are
// folded; adjacent copies of one component share a line that lists only
// what differs between them.
// Node IDs show only with full: agents read and edit by name.
export function outlineTree(tree, projection, { full = false, components, ids = full } = {}) {
  const lines = [];
  const size = (node) => `${Math.round(node.bounds.width)}×${Math.round(node.bounds.height)}`;
  const describe = (node) => {
    const raw = projection.nodes[node.id];
    const reference = instanceReference(node, projection);
    if (reference) {
      const set = components?.(reference);
      return { reference, set, pairs: variantPairs(node.variant ?? raw.instance?.variant, set) };
    }
    return { reference: null };
  };
  const label = (node) => {
    const raw = projection.nodes[node.id];
    const { reference, set, pairs } = describe(node);
    if (reference) {
      const texts = descendantTexts(node, projection);
      // The element's own name first when it is not the component's, so
      // --element finds it: "Save button: Button (Style=primary)".
      const own = node.name && set?.name && node.name.trim().toLowerCase() !== set.name.trim().toLowerCase() ? `${node.name}: ` : "";
      return `${own}${set?.name ?? reference.assetId}${pairs.length ? ` (${pairs.map(([, text]) => text).join(", ")})` : ""}${texts.length ? ` ${shortText(texts)}` : ""} · ${size(node)}${ids ? ` #${node.id}` : ""}`;
    }
    const children = node.children.filter(({ visible }) => visible).length;
    const layout = raw.layout === "flex"
      ? ` · ${raw["layout-flex-dir"]?.startsWith("column") ? "column" : "row"} layout (${children})`
      : raw.layout
        ? ` · ${raw.layout} layout (${children})`
        : children && node.type !== "TEXT"
          ? ` · ${children} item${children === 1 ? "" : "s"}`
          : "";
    const literal = literalFields(raw);
    return `${node.name} · ${node.type} ${size(node)}${layout}${node.text ? ` ${shortText([node.text])}` : ""}${literal.length ? ` · literal ${literal.join(",")}` : ""}${ids ? ` #${node.id}` : ""}`;
  };
  const visit = (node, depth) => {
    if (!node.visible) return;
    const raw = projection.nodes[node.id];
    if (!full && raw.designSystem?.role === "decoration") return;
    lines.push(`${"  ".repeat(depth)}${label(node)}`);
    if (!full && node !== tree.root && instanceReference(node, projection))
      return;
    // A flex line places its last stored child first: list children in the
    // order they appear.
    const direction = raw.layout === "flex" ? raw["layout-flex-dir"] ?? "row" : null;
    const stored = node.children.filter(({ visible }) => visible);
    const children = direction && !direction.endsWith("reverse") ? [...stored].reverse() : stored;
    for (let i = 0; i < children.length;) {
      const child = children[i];
      const ref = instanceReference(child, projection);
      let end = i + 1;
      if (!full && ref)
        while (
          end < children.length &&
          JSON.stringify(instanceReference(children[end], projection)) ===
            JSON.stringify(ref)
        )
          end++;
      if (end - i > 1) {
        const group = children.slice(i, end).map((item) => ({ item, ...describe(item) }));
        // Variant pairs every copy shares are written once.
        const shared = group[0].pairs.filter(([id, text]) =>
          group.every(({ pairs }) => pairs.some(([other, value]) => other === id && value === text)));
        const sizes = new Set(group.map(({ item }) => size(item)));
        const items = group.map(({ item, pairs }) => {
          const own = pairs.filter(([id]) => !shared.some(([other]) => other === id)).map(([, text]) => text);
          const texts = descendantTexts(item, projection);
          // Without IDs a copy is named, so --element can find it.
          const shown = ids
            ? (texts.length ? shortText(texts, 48) : item.name)
            : `${item.name}${texts.length ? ` ${shortText(texts, 48)}` : ""}`;
          return `${shown}${own.length ? ` (${own.join(", ")})` : ""}${sizes.size > 1 ? ` ${size(item)}` : ""}${ids ? ` #${item.id}` : ""}`;
        });
        lines.push(
          `${"  ".repeat(depth + 1)}${group[0].set?.name ?? ref.assetId} ×${end - i}${shared.length ? ` (${shared.map(([, text]) => text).join(", ")})` : ""}${sizes.size === 1 ? ` · ${[...sizes][0]}` : ""}: ${items.join("; ")}`,
        );
      } else visit(child, depth + 1);
      i = end;
    }
  };
  visit(tree.root, 0);
  return lines.join("\n");
}

// Detailed design values: one line per element with its place (x,y from
// the top-left of the page or component), size and how it is sized, its
// layout, and every visual value with the Token it follows ({path}) or as
// a literal. Copies of a component name the component, variant and what
// they change; the component's own spec is view --component NAME --as spec.
export function specTree(tree, projection, { components, tokenName, heading, stored = {} } = {}) {
  const lines = heading ? [heading] : [];
  const origin = tree.root.bounds;
  const round = (value) => Math.round(Number(value) * 100) / 100;
  const tokenOf = (raw, ...fields) => {
    const applied = appliedTokenFields(raw.appliedTokens);
    for (const field of fields) {
      const reference = raw.tokenBindings?.[field];
      if (reference) return `{${tokenName(reference) ?? "unknown Token"}}`;
      if (applied[field]) return `{${applied[field]}}`;
    }
    return "";
  };
  const withToken = (value, token) => (token ? `${value} ${token}` : String(value));
  const paint = (list) => {
    const first = Array.isArray(list) ? list.find((item) => item && item.hidden !== true) : undefined;
    if (!first) return undefined;
    const color = first.color ?? first.type ?? "paint";
    const opacity = first.opacity !== undefined && first.opacity < 1 ? ` ${Math.round(first.opacity * 100)}%` : "";
    return `${color}${opacity}`;
  };
  const sizing = (raw, node) => {
    const word = (mode) => (mode === "fill" ? "fill" : mode === "auto" ? "hug" : undefined);
    const width = node.type === "TEXT" && raw.growType === "auto-width" ? "hug" : word(raw["layout-item-h-sizing"]);
    const height = node.type === "TEXT" && ["auto-width", "auto-height"].includes(raw.growType) ? "hug" : word(raw["layout-item-v-sizing"]);
    const parts = [width && `width ${width}`, height && `height ${height}`].filter(Boolean);
    return parts.length ? ` (${parts.join(", ")})` : "";
  };
  const box = (raw) => {
    const parts = [];
    if (raw.layout === "flex") {
      const direction = raw["layout-flex-dir"]?.startsWith("column") ? "column" : "row";
      parts.push(direction);
      const gap = raw["layout-gap"];
      const gapValue = direction === "column" ? gap?.["row-gap"] ?? gap?.["column-gap"] : gap?.["column-gap"] ?? gap?.["row-gap"];
      if (gapValue) parts.push(`gap ${withToken(round(gapValue), tokenOf(raw, "itemSpacing", direction === "column" ? "rowGap" : "columnGap"))}`);
      const pad = raw["layout-padding"];
      if (pad && [pad.p1, pad.p2, pad.p3, pad.p4].some((value) => Number(value))) {
        const sides = [pad.p1, pad.p2, pad.p3, pad.p4].map((value) => round(value ?? 0));
        const tokens = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].map((field) => tokenOf(raw, field));
        const same = sides.every((value) => value === sides[0]) && tokens.every((token) => token === tokens[0]);
        parts.push(same ? `padding ${withToken(sides[0], tokens[0])}` : `padding ${sides.map((value, index) => withToken(value, tokens[index])).join(" ")}`);
      }
      if (raw["layout-align-items"]) parts.push(`align ${raw["layout-align-items"]}`);
      if (raw["layout-justify-content"]) parts.push(`justify ${raw["layout-justify-content"]}`);
      if (raw["layout-wrap-type"] === "wrap") parts.push("wrap");
    } else if (raw.layout) parts.push(`${raw.layout} layout`);
    return parts;
  };
  const visuals = (raw) => {
    const parts = [];
    const isText = raw.type === "TEXT";
    const fill = paint(raw.fills);
    if (fill) parts.push(`${isText ? "color" : "fill"} ${withToken(fill, tokenOf(raw, "fill", "fills.0"))}`);
    const stroke = Array.isArray(raw.strokes) ? raw.strokes.find((item) => item && item.hidden !== true) : undefined;
    if (stroke) {
      const sides = ["Top", "Right", "Bottom", "Left"].map((side) => stroke[`width${side}`]);
      const width = sides.every((value) => value !== undefined) && !sides.every((value) => value === sides[0])
        ? sides.map((value) => `${round(value)}`).join(" ")
        : `${round(stroke.width ?? 1)}`;
      parts.push(`stroke ${withToken(`${width}px ${paint([stroke])}${stroke.style && stroke.style !== "solid" ? ` ${stroke.style}` : ""}${stroke.alignment ? ` ${stroke.alignment}` : ""}`, tokenOf(raw, "stroke", "strokes.0"))}`);
    }
    if (Array.isArray(raw.cornerRadius) ? raw.cornerRadius.some(Number) : Number(raw.cornerRadius)) {
      const corners = Array.isArray(raw.cornerRadius) ? raw.cornerRadius.map(round).join(" ") : round(raw.cornerRadius);
      parts.push(`radius ${withToken(corners, tokenOf(raw, "cornerRadius", "radiusTopLeft"))}`);
    }
    if (raw.opacity !== undefined && raw.opacity < 1) parts.push(`opacity ${withToken(round(raw.opacity), tokenOf(raw, "opacity"))}`);
    const shadows = (Array.isArray(raw.shadow) ? raw.shadow : raw.shadow ? [raw.shadow] : []).filter((item) => item && item.hidden !== true);
    if (shadows.length)
      parts.push(`shadow ${withToken(shadows.map((item) => `${round(item["offset-x"] ?? item.offsetX ?? 0)} ${round(item["offset-y"] ?? item.offsetY ?? 0)} ${round(item.blur ?? 0)} ${round(item.spread ?? 0)} ${paint([item.color ?? {}]) ?? item.color?.color ?? ""}`).join(", "), tokenOf(raw, "shadow"))}`);
    if (raw.rotation) parts.push(`rotation ${round(raw.rotation)}°`);
    for (const [key, field, word] of [["layout-item-min-w", "minWidth", "min width"], ["layout-item-max-w", "maxWidth", "max width"], ["layout-item-min-h", "minHeight", "min height"], ["layout-item-max-h", "maxHeight", "max height"]])
      if (raw[key] !== undefined) parts.push(`${word} ${withToken(round(raw[key]), tokenOf(raw, field))}`);
    const margin = raw["layout-item-margin"];
    if (margin && [margin.m1, margin.m2, margin.m3, margin.m4].some(Number))
      parts.push(`margin ${[margin.m1, margin.m2, margin.m3, margin.m4].map((value) => round(value ?? 0)).join(" ")}`);
    return parts;
  };
  const typeSpec = (raw) => {
    const style = raw.textStyle ?? {};
    const typography = tokenOf(raw, "typography");
    const parts = [];
    const font = [style.fontFamily, style.fontSize !== undefined ? `${round(style.fontSize)}${style.lineHeight !== undefined ? `/${round(style.lineHeight)}` : ""}` : undefined, style.fontWeight !== undefined ? `weight ${style.fontWeight}` : undefined].filter(Boolean).join(" ");
    // Unset text styles use the App's defaults.
    parts.push(`font ${font ? withToken(font, typography) : "default"}`);
    if (!paint(raw.fills)) parts.push("color default");
    for (const [key, field, word] of [["fontFamily", "fontFamily", "family"], ["fontSize", "fontSize", "size"], ["fontWeight", "fontWeight", "weight"], ["lineHeight", "lineHeight", "line height"]]) {
      const token = typography ? "" : tokenOf(raw, field);
      if (token && style[key] !== undefined) parts.push(`${word} ${token}`);
    }
    if (style.letterSpacing) parts.push(`letter spacing ${withToken(round(style.letterSpacing), tokenOf(raw, "letterSpacing"))}`);
    if (style.textAlign && style.textAlign !== "left") parts.push(`align ${style.textAlign}`);
    if (style.textTransform && style.textTransform !== "none") parts.push(`case ${style.textTransform}`);
    if (style.textDecoration && style.textDecoration !== "none") parts.push(style.textDecoration);
    return parts;
  };
  const place = (node) => `at ${Math.round(node.bounds.x - origin.x)},${Math.round(node.bounds.y - origin.y)} · ${Math.round(node.bounds.width)}×${Math.round(node.bounds.height)}`;
  const overrideLines = (raw, set) => {
    const overrides = (stored[raw.id] ?? raw).instance?.overrides ?? {};
    const variant = set?.variants.find((candidate) => Object.entries(raw.instance?.variant ?? {}).every(([axis, value]) => candidate.selection?.[axis] === value)) ?? set?.variants[0];
    const nameOf = (id) => variant?.nodes?.[id]?.name ?? set?.variants.map((candidate) => candidate.nodes?.[id]?.name).find(Boolean) ?? id;
    const parts = [];
    for (const [key, value] of Object.entries(overrides)) {
      const at = key.lastIndexOf(":");
      const element = nameOf(key.slice(0, at)), field = key.slice(at + 1);
      if (field === "tokenBindings") {
        for (const [binding, reference] of Object.entries(value ?? {})) if (reference) parts.push(`${element} ${binding} {${tokenName(reference) ?? "unknown Token"}}`);
      } else if (field === "text") parts.push(`${element} text ${JSON.stringify(String(value))}`);
      else if (field === "fills" || field === "strokes") parts.push(`${element} ${field === "fills" ? "fill" : "stroke"} ${paint(value) ?? "none"}`);
      else if (field === "variant") parts.push(`${element} variant ${Object.values(value ?? {}).join(", ")}`);
      else if (field === "textStyle") parts.push(`${element} text style ${Object.entries(value ?? {}).filter(([name]) => !/Id$/.test(name)).map(([name, part]) => `${name} ${part}`).join(", ")}`);
      else parts.push(`${element} ${field} ${typeof value === "object" ? JSON.stringify(value) : value}`);
    }
    return parts;
  };
  const visit = (node, depth) => {
    if (!node.visible) return;
    const raw = projection.nodes[node.id];
    const reference = instanceReference(node, projection);
    const indent = "  ".repeat(depth);
    if (reference && node !== tree.root) {
      const set = components?.(reference);
      const pairs = variantPairs(node.variant ?? raw.instance?.variant, set).map(([, text]) => text);
      const changes = overrideLines(raw, set);
      const texts = descendantTexts(node, projection);
      lines.push(`${indent}${node.name} · copy of ${set?.name ?? "a component"}${pairs.length ? ` (${pairs.join(", ")})` : ""} · ${place(node)}${sizing(raw, node)}${texts.length ? ` · texts ${texts.map((text) => JSON.stringify(text)).join(", ")}` : ""}${changes.length ? ` · changes ${changes.join("; ")}` : ""}`);
      return;
    }
    const parts = [
      `${node.name} · ${node.type === "TEXT" ? "text" : node.type.toLowerCase()} · ${place(node)}${sizing(raw, node)}`,
      ...box(raw),
      ...visuals(raw),
      ...(node.type === "TEXT" ? typeSpec(raw) : []),
    ];
    if (node.type === "TEXT") {
      const token = tokenOf(raw, "text");
      parts.push(`text ${token ? `${token} ` : ""}${JSON.stringify(String(node.text ?? raw.text ?? ""))}`);
    }
    lines.push(`${indent}${parts.join(" · ")}`);
    const direction = raw.layout === "flex" ? raw["layout-flex-dir"] ?? "row" : null;
    const stored = node.children.filter(({ visible }) => visible);
    const children = direction && !direction.endsWith("reverse") ? [...stored].reverse() : stored;
    for (const child of children) visit(child, depth + 1);
  };
  visit(tree.root, 0);
  return lines.join("\n");
}

export function localWireframe(design, { full = false } = {}) {
  const collapse = (node) => ({
    ...node,
    children:
      !full &&
      node !== design.tree.root &&
      instanceReference(node, design.projection)
        ? []
        : node.children.filter(({ visible }) => visible).map(collapse),
  });
  return asciiWireframe({ ...design.tree, root: collapse(design.tree.root) });
}

function solidColor(node) {
  if ((node.opacity ?? 1) !== 1 || node.fills?.length !== 1) return undefined;
  const paint = node.fills[0];
  if (
    paint.type !== "solid" ||
    (paint.opacity ?? 1) !== 1 ||
    !/^#[0-9a-f]{6}$/i.test(paint.color ?? "")
  )
    return undefined;
  return [1, 3, 5].map(
    (offset) => parseInt(paint.color.slice(offset, offset + 2), 16) / 255,
  );
}
const luminance = (rgb) =>
  rgb
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);

const PLATFORM_AXIS = /^(platform|viewport|device)$/i;

// Reminders, not issues: a Presentation for one platform checked without
// that platform's theme option, or using another platform's variant. The
// caller decides; nothing is stored.
export function platformHints(workspace, design) {
  const { product, foundation } = workspace;
  const selection = design.selection ?? {};
  if (!selection.screenId) return [];
  const screen = product.manifest.entries.screens
    .map((entry) => product.entries[entry])
    .find((candidate) => candidate.id === selection.screenId);
  const presentation = screen?.presentations?.find(({ id }) => id === selection.presentationId);
  const contextPlatform = Object.entries(selection.context ?? {})
    .find(([axis]) => /platform|viewport|device/i.test(axis))?.[1];
  const platform = String(presentation?.platform ?? contextPlatform ?? "").toLowerCase();
  if (!platform) return [];
  const hints = [];
  const chosen = new Set(selection.themes ?? []);
  const option = listTokenThemes(product, foundation)
    .find((theme) => theme.name.toLowerCase() === platform && !chosen.has(theme.path));
  if (option)
    hints.push({
      code: "platform_theme_available",
      message: `This Presentation is ${platform}; theme option ${option.path} exists but is not selected. Pass --theme ${option.path} to check its values.`,
      theme: option.path,
    });
  const components = componentLookup(workspace);
  const visit = (node, path) => {
    if (!node.visible) return;
    const raw = design.projection.nodes[node.id];
    const here = node === design.tree.root ? path : [...path, node.name];
    const reference = instanceReference(node, design.projection);
    if (reference && node !== design.tree.root) {
      const set = components(reference);
      const axis = set?.axes?.find((candidate) => PLATFORM_AXIS.test(candidate.name));
      const value = axis ? (node.variant ?? raw.instance?.variant)?.[axis.id] : undefined;
      const match = axis?.domain?.find((candidate) => String(candidate).toLowerCase() === platform);
      if (value !== undefined && match !== undefined && String(value).toLowerCase() !== platform)
        hints.push({
          code: "platform_variant_mismatch",
          nodeId: node.id,
          where: here.join(" › "),
          message: `A ${platform} Presentation uses ${axisLabel(axis, value)} of ${set.name}; ${axisLabel(axis, match)} exists.`,
        });
      return;
    }
    for (const child of node.children) visit(child, here);
  };
  visit(design.tree.root, []);
  return hints;
}

export async function validateDesign(workspace, design) {
  const issues = (design.projection.diagnostics ?? []).map((diagnostic) => ({
      ...diagnostic,
      severity: "warning",
    })),
    skipped = [];
  for (const diagnostic of design.projection.diagnostics ?? [])
    if (diagnostic.code === "layout_projection_partial")
      skipped.push({ check: "layout-reflow", ...diagnostic });
  const nodes = design.projection.nodes;
  const visibleIds = new Set();
  const visible = (node) => {
    if (!node.visible) return;
    visibleIds.add(node.id);
    for (const child of node.children) visible(child);
  };
  visible(design.tree.root);
  if (!visibleIds.size)
    skipped.push({
      check: "visual",
      reason: "The selected node is hidden by itself or an ancestor",
    });
  const metrics = await measureProjectionText(
    workspace.product,
    {
      ...design.projection,
      nodes: Object.fromEntries(
        Object.entries(nodes).filter(([id]) => visibleIds.has(id)),
      ),
    },
    workspace,
  );
  for (const item of metrics.items) {
    const node = nodes[item.nodeId];
    if (item.missingGlyphs.length) {
      skipped.push({
        check: "text-fit",
        nodeId: node.id,
        reason: "missing-glyphs",
        codepoints: item.missingGlyphs.map(
          (char) => `U+${char.codePointAt(0).toString(16)}`,
        ),
      });
      // Text in another language often needs another font; without one the
      // PNG and text checks cannot see it.
      issues.push({
        code: "text_missing_glyphs",
        severity: "warning",
        nodeId: node.id,
        message: `The font has no glyphs for ${[...new Set(item.missingGlyphs)].slice(0, 6).join(" ")}; import a font that covers this language with asset font import and use it in the text style`,
      });
    } else if (
      // Sub-pixel line-height rounding is not an overflow; a clipped word
      // or an extra line is.
      (item.growType !== "auto-width" &&
        item.width > node.width + Math.max(1, node.width * 0.02)) ||
      (!["auto-width", "auto-height"].includes(item.growType) &&
        item.height > node.height + Math.max(1.5, node.height * 0.08))
    ) {
      issues.push({
        code: "text_overflow",
        severity: "warning",
        nodeId: node.id,
        message: "Measured text exceeds its fixed box",
        measured: { width: item.width, height: item.height },
        box: { width: node.width, height: node.height },
      });
    }
  }
  for (const diagnostic of metrics.diagnostics)
    skipped.push({ check: "text-fit", ...diagnostic });
  const measuredText = new Map(metrics.items.filter((item) => !item.missingGlyphs.length).map((item) => [item.nodeId, item]));
  // Where each node sits, by name, so an issue reads without its ID.
  const places = new Map();
  const painted = [];
  const locate = (semantic, path) => {
    if (!semantic.visible) return;
    const here = semantic === design.tree.root ? path : [...path, semantic.name];
    places.set(semantic.id, here);
    painted.push(semantic);
    for (const child of semantic.children) locate(child, here);
  };
  locate(design.tree.root, []);
  const where = (id) => (places.get(id) ?? []).join(" › ") || design.tree.root.name;
  const contains = (outer, inner) =>
    outer.x <= inner.x + 0.5 &&
    outer.y <= inner.y + 0.5 &&
    outer.x + outer.width >= inner.x + inner.width - 0.5 &&
    outer.y + outer.height >= inner.y + inner.height - 0.5;
  // The opaque solid paint right under a text: the last node painted
  // before it that covers it (an ancestor, or a shape behind it).
  const backdrop = (semantic) => {
    for (let index = painted.indexOf(semantic) - 1; index >= 0; index -= 1) {
      const candidate = painted[index];
      const raw = nodes[candidate.id];
      if (raw.type === "TEXT" || !contains(candidate.bounds, semantic.bounds)) continue;
      if ((raw.opacity ?? 1) !== 1) return undefined;
      if (raw.fills?.length) return solidColor(raw);
    }
    return undefined;
  };
  const rootBounds = design.tree.root.bounds;
  const outside = (bounds, parent) =>
    bounds.x < parent.x - 0.5 ||
    bounds.y < parent.y - 0.5 ||
    bounds.x + bounds.width > parent.x + parent.width + 0.5 ||
    bounds.y + bounds.height > parent.y + parent.height + 0.5;
  const walk = (semantic, ancestors = [], holder = undefined) => {
    if (!semantic.visible) return;
    const node = nodes[semantic.id];
    // A text that hugs grows with a longer text; past its container's edge
    // it is cut (the box alone does not show that).
    const measured = measuredText.get(semantic.id);
    if (holder && node.type === "TEXT" && measured && node.growType === "auto-width" &&
      measured.width > semantic.bounds.width + Math.max(1, semantic.bounds.width * 0.02) &&
      semantic.bounds.x + measured.width > holder.bounds.x + holder.bounds.width + 0.5)
      issues.push({
        code: "text_overflow",
        severity: "warning",
        nodeId: node.id,
        message: `Text needs ${Math.ceil(measured.width)}px and runs past ${holder.name}; give it room, let it wrap (width fill) or shorten it`,
        measured: { width: measured.width, height: measured.height },
        box: { width: semantic.bounds.width, height: semantic.bounds.height },
      });
    if (semantic !== design.tree.root && outside(semantic.bounds, rootBounds))
      issues.push({
        code: "outside_root",
        severity: "warning",
        nodeId: node.id,
        message: "Node extends beyond the selected root",
        bounds: semantic.bounds,
      });
    if (node.type === "TEXT" && node.text) {
      const foreground = solidColor(node);
      let background = backdrop(semantic);
      if (!background)
        for (const ancestor of [...design.ancestors].reverse()) {
          if (ancestor.fills?.length) {
            background = solidColor(ancestor);
            break;
          }
        }
      const rich = node.textBlocks?.some((block) =>
        block.runs?.some((run) => run.fills || run.textStyle),
      );
      if (
        foreground &&
        background &&
        !rich &&
        ancestors.every((parent) => (parent.opacity ?? 1) === 1)
      ) {
        const a = luminance(foreground),
          b = luminance(background);
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        const size = node.textStyle?.fontSize ?? 14,
          weight = Number(node.textStyle?.fontWeight ?? 400);
        const minimum =
          size >= 24 || (size >= 18.67 && weight >= 700) ? 3 : 4.5;
        if (ratio < minimum)
          issues.push({
            code: "low_text_contrast",
            severity: "warning",
            nodeId: node.id,
            ratio: Math.round(ratio * 100) / 100,
            minimum,
            message:
              "Text contrast below the large/normal text threshold against the solid paint under it",
          });
      } else
        skipped.push({
          check: "text-contrast",
          nodeId: node.id,
          reason:
            "requires opaque solid text and ancestor backgrounds without mixed runs",
        });
    }
    const children = semantic.children.filter(({ visible }) => visible);
    // Content wider or taller than its container runs past its edge (the
    // root's own edge is outside_root). An auto layout says how much room
    // its content needs.
    if (semantic !== design.tree.root && children.length && ["FRAME", "COMPONENT"].includes(node.type)) {
      const past = children.filter((child) => nodes[child.id]?.["layout-item-absolute"] !== true && outside(child.bounds, semantic.bounds));
      if (past.length) {
        const flex = node.layout === "flex";
        const row = flex && !String(node["layout-flex-dir"] ?? "row").startsWith("column");
        const inFlow = children.filter((child) => nodes[child.id]?.["layout-item-absolute"] !== true);
        const gap = Number((row ? node["layout-gap"]?.["column-gap"] : node["layout-gap"]?.["row-gap"]) ?? 0);
        const pad = node["layout-padding"] ?? {};
        const needed = flex
          ? Math.round(inFlow.reduce((sum, child) => sum + (row ? child.bounds.width : child.bounds.height), 0) + gap * Math.max(0, inFlow.length - 1) +
            (row ? (pad.p2 ?? 0) + (pad.p4 ?? 0) : (pad.p1 ?? 0) + (pad.p3 ?? 0)))
          : undefined;
        const side = row ? "wide" : "tall";
        const has = Math.round(row ? semantic.bounds.width : semantic.bounds.height);
        issues.push({
          code: "content_overflow",
          severity: "warning",
          nodeId: node.id,
          message: flex && needed > has
            ? `Its content needs ${needed}px ${side} but it is ${has}px; give it more room, let it hug, or make a child smaller`
            : "Children run past its edge; give it more room or move them in",
          past: past.map((child) => child.name),
        });
      }
    }
    for (let i = 0; i < children.length; i++)
      for (let j = i + 1; j < children.length; j++) {
        const a = children[i],
          b = children[j];
        if (
          !["TEXT", "INSTANCE", "FRAME"].includes(a.type) ||
          !["TEXT", "INSTANCE", "FRAME"].includes(b.type)
        )
          continue;
        const width =
          Math.min(a.bounds.x + a.bounds.width, b.bounds.x + b.bounds.width) -
          Math.max(a.bounds.x, b.bounds.x);
        const height =
          Math.min(a.bounds.y + a.bounds.height, b.bounds.y + b.bounds.height) -
          Math.max(a.bounds.y, b.bounds.y);
        if (width > 1 && height > 1)
          issues.push({
            code: "possible_overlap",
            severity: "info",
            nodeId: a.id,
            otherNodeId: b.id,
            message: "Sibling bounds overlap; may be intentional",
            area: width * height,
          });
      }
    for (const child of children) walk(child, [...ancestors, node], semantic);
  };
  walk(design.tree.root, design.ancestors);
  for (const issue of issues) {
    if (issue.nodeId && places.has(issue.nodeId)) issue.where = where(issue.nodeId);
    if (issue.otherNodeId && places.has(issue.otherNodeId)) issue.otherWhere = where(issue.otherNodeId);
    const text = nodes[issue.nodeId]?.type === "TEXT" ? nodes[issue.nodeId].text : undefined;
    if (text) issue.text = text.length > 40 ? `${text.slice(0, 39)}…` : text;
  }
  skipped.push({
    check: "visual-intent",
    reason:
      "Automated geometry, text-fit and solid contrast cannot prove a design is visually correct; check the requested combinations and optionally PNG",
  });
  // One problem inside a component shows in every copy of it; it is fixed
  // once, in the component, so it is reported once with its copies counted.
  const grouped = [];
  const byDefinition = new Map();
  for (const issue of issues) {
    const segments = String(issue.nodeId ?? "").split("__");
    if (segments.length < 2 || issue.otherNodeId) {
      grouped.push(issue);
      continue;
    }
    // Copies differ in their text overrides, not in the definition at fault.
    const key = [issue.code, segments.at(-1), issue.ratio ?? ""].join("\0");
    const first = byDefinition.get(key);
    if (!first) {
      const entry = { ...issue, occurrences: 1 };
      byDefinition.set(key, entry);
      grouped.push(entry);
    } else {
      first.occurrences += 1;
      if ((first.alsoAt ??= []).length < 2 && issue.where) first.alsoAt.push(issue.where);
    }
  }
  for (const issue of grouped)
    if (issue.occurrences === undefined) continue;
    else if (issue.occurrences === 1) delete issue.occurrences;
    else issue.message = `${issue.message} (inside a component: ${issue.occurrences} copies; fix it in the component)`;
  issues.length = 0;
  issues.push(...grouped);
  const hints = platformHints(workspace, design);
  return {
    issues,
    ...(hints.length ? { hints } : {}),
    coverage: {
      complete: false,
      nodeCount: Object.keys(nodes).length,
      visibleNodeCount: visibleIds.size,
      checks: [
        "text-fit",
        "root-bounds",
        "sibling-overlap",
        "solid-text-contrast",
      ],
      skipped,
    },
    issueCount: issues.length,
  };
}
