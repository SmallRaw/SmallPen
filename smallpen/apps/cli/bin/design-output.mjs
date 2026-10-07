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

function descendantTexts(node) {
  if (!node.visible) return [];
  return [node.text, ...(node.children ?? []).flatMap(descendantTexts)].filter(
    Boolean,
  );
}
function instanceReference(node, projection) {
  const raw = projection.nodes[node.id];
  return raw.type === "INSTANCE" || raw.instance
    ? (node.component ?? raw.instance?.component)
    : undefined;
}

function shortText(texts, limit = 60) {
  const text = texts.join(" / ");
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
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
      const texts = descendantTexts(node);
      return `${set?.name ?? reference.assetId}${pairs.length ? ` (${pairs.map(([, text]) => text).join(", ")})` : ""}${texts.length ? ` "${shortText(texts)}"` : ""} · ${size(node)}${ids ? ` #${node.id}` : ""}`;
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
    return `${node.name} · ${node.type} ${size(node)}${layout}${node.text ? ` "${shortText([node.text])}"` : ""}${literal.length ? ` · literal ${literal.join(",")}` : ""}${ids ? ` #${node.id}` : ""}`;
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
          const texts = descendantTexts(item);
          // Without IDs a copy is named, so --element can find it.
          const shown = ids
            ? (texts.length ? `"${shortText(texts, 48)}"` : item.name)
            : `${item.name}${texts.length ? ` "${shortText(texts, 48)}"` : ""}`;
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
        message: `The font has no glyphs for ${[...new Set(item.missingGlyphs)].slice(0, 6).join(" ")}; import a font that covers this language with font import and use it in the text style`,
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
  const walk = (semantic, ancestors = []) => {
    if (!semantic.visible) return;
    const node = nodes[semantic.id];
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
    for (const child of children) walk(child, [...ancestors, node]);
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
