import { canonicalJSON } from "./canonical.mjs";
import {
  closestComponentVariant,
  findComponentVariant,
  variantMismatchText,
} from "./components-domain.mjs";
import { resolveContext } from "./contexts.mjs";
import { fail } from "./errors.mjs";
import {
  OVERRIDE_FIELDS,
  overrideTouchedGroups,
  ownValue,
} from "./internal.mjs";
import {
  applyEffectiveTokenBindings,
  resolveOverrideBindings,
  normalizedLayoutGap,
} from "./projection-values.mjs";

function screenById(snapshot, screenId) {
  const entry = snapshot.manifest.entries.screens.find(
    (candidate) => snapshot.entries[candidate].id === screenId,
  );
  if (!entry) fail("missing_screen", `Screen not found: ${screenId}`, { screenId });
  return { entry, screen: snapshot.entries[entry] };
}

function replacementFor(product, reference) {
  const replacements = [...product.domain.componentSets.values()].filter(
    (componentSet) =>
      componentSet.replaces?.packageId === reference.packageId &&
      componentSet.replaces.assetId === reference.assetId,
  );
  if (replacements.length > 1) {
    fail(
      "duplicate_product_component_replacement",
      `More than one Product Component replaces ${reference.assetId}`,
      { componentIds: replacements.map(({ id }) => id), reference },
    );
  }
  return replacements[0];
}

function componentTarget(product, foundation, libraries, reference) {
  const replacement = replacementFor(product, reference);
  if (replacement) return { componentSet: replacement, owner: product };
  if (reference.packageId === product.manifest.packageId) {
    const componentSet = product.domain.componentSets.get(reference.assetId);
    return componentSet ? { componentSet, owner: product } : null;
  }
  if (reference.packageId === foundation?.manifest.packageId) {
    const componentSet = foundation.domain.componentSets.get(reference.assetId);
    if (componentSet?.visibility === "public") {
      return { componentSet, owner: foundation };
    }
  }
  const library = libraries.find(
    (candidate) => candidate.manifest.packageId === reference.packageId,
  );
  const componentSet = library?.domain.componentSets.get(reference.assetId);
  if (componentSet?.visibility === "public") {
    return { componentSet, owner: library };
  }
  return null;
}

function qualifyReference(reference, owner, product) {
  if (
    typeof reference !== "string" ||
    owner.manifest.packageId === product.manifest.packageId
  ) {
    return reference;
  }
  return {
    assetId: reference,
    packageId: owner.manifest.packageId,
  };
}

function qualifyPaintReferences(paints, owner, product) {
  return paints?.map((paint) => ({
    ...paint,
    ...(paint.colorRef
      ? { colorRef: qualifyReference(paint.colorRef, owner, product) }
      : {}),
    ...(paint.mediaRef
      ? { mediaRef: qualifyReference(paint.mediaRef, owner, product) }
      : {}),
  }));
}

function qualifyTextStyle(style, owner, product) {
  if (!style?.typographyRef) return style;
  return {
    ...style,
    typographyRef: qualifyReference(style.typographyRef, owner, product),
  };
}

function qualifyComponentAssetReferences(node, owner, product) {
  if (owner.manifest.packageId === product.manifest.packageId) return node;
  return {
    ...node,
    ...(node.mediaRef
      ? { mediaRef: qualifyReference(node.mediaRef, owner, product) }
      : {}),
    ...(node.fills
      ? { fills: qualifyPaintReferences(node.fills, owner, product) }
      : {}),
    ...(node.strokes
      ? { strokes: qualifyPaintReferences(node.strokes, owner, product) }
      : {}),
    ...(node.textStyle
      ? { textStyle: qualifyTextStyle(node.textStyle, owner, product) }
      : {}),
    ...(node.textBlocks
      ? {
          textBlocks: node.textBlocks.map((block) => ({
            ...block,
            ...(block.fills
              ? { fills: qualifyPaintReferences(block.fills, owner, product) }
              : {}),
            ...(block.textStyle
              ? { textStyle: qualifyTextStyle(block.textStyle, owner, product) }
              : {}),
            runs: (block.runs ?? []).map((run) => ({
              ...run,
              ...(run.fills
                ? { fills: qualifyPaintReferences(run.fills, owner, product) }
                : {}),
              ...(run.textStyle
                ? { textStyle: qualifyTextStyle(run.textStyle, owner, product) }
                : {}),
            })),
          })),
        }
      : {}),
  };
}

function prefixedNodeId(instanceId, sourceNodeId) {
  return `${instanceId}__${sourceNodeId}`;
}

// The plain text a TEXT node's rich blocks spell, one paragraph per block.
function textBlocksText(blocks) {
  return blocks
    .map((block) => (block.runs ?? []).map((run) => run.text).join(""))
    .join("\n");
}

// Applies one Instance override field to a projected node, in place. A text
// override replaces the plain text; rich blocks that no longer spell it fold
// into the style of their first run, since the override carries no runs.
function applyOverrideField(node, field, value) {
  if (
    field === "text" &&
    node.textBlocks?.length &&
    textBlocksText(node.textBlocks) !== value
  ) {
    const block = node.textBlocks[0];
    const run = block.runs?.[0] ?? {};
    const textStyle = {
      ...(node.textStyle ?? {}),
      ...(block.textStyle ?? {}),
      ...(run.textStyle ?? {}),
    };
    if (Object.keys(textStyle).length > 0) node.textStyle = textStyle;
    if (run.fills) node.fills = structuredClone(run.fills);
    delete node.textBlocks;
  }
  if (field === "tokenBindings") {
    // The copy's own bindings: a reference per field, null drops the
    // source's binding.
    const bindings = { ...(node.tokenBindings ?? {}) };
    for (const [binding, reference] of Object.entries(value ?? {}))
      if (reference === null) delete bindings[binding];
      else bindings[binding] = structuredClone(reference);
    if (Object.keys(bindings).length) node.tokenBindings = bindings;
    else delete node.tokenBindings;
    return;
  }
  if (field === "variant") return; // applied when the nested copy is drawn
  node[field] = structuredClone(value);
}

// Instance override fields and their touched groups, for writers that turn
// Penpot copy edits into overrides.
export { OVERRIDE_FIELDS as INSTANCE_OVERRIDE_FIELDS, overrideTouchedGroups };

// Applies a node's Instance overrides ({field: value}) the way projection
// does: text first, so an explicit fills override wins over the fills a
// folded text run carries, and the touched groups Penpot keeps for them.
export function applyNodeOverrides(node, overrides) {
  const fields = Object.keys(overrides).sort((left, right) =>
    left === "text" ? -1 : right === "text" ? 1 : left < right ? -1 : 1,
  );
  if (fields.length === 0) return node;
  const touched = new Set(node.touched ?? []);
  for (const field of fields) {
    // A text override with another paragraph count changes the structure.
    if (
      field === "text" &&
      String(node.text ?? "").split("\n").length !==
        String(overrides.text).split("\n").length
    ) {
      touched.add("text-content-structure");
    }
    applyOverrideField(node, field, overrides[field]);
    for (const group of overrideTouchedGroups(field, node.type, overrides[field])) {
      touched.add(group);
    }
  }
  node.touched = [...touched].sort();
  return node;
}

const ROOT_FIELD_DEFAULTS = new Map([
  ["opacity", 1],
  ["visible", true],
]);

// An Instance node's own name, fills, opacity or visibility override its
// source root. Penpot must see those as touched, or its component sync and
// "Reset overrides" write the source value back over them.
function rootOverrideTouched(root, instance, sourceRoot) {
  const touched = new Set(root.touched ?? []);
  for (const field of ["fills", "name", "opacity", "visible"]) {
    if (!Object.hasOwn(instance, field)) continue;
    const fallback = ROOT_FIELD_DEFAULTS.get(field);
    if (
      canonicalJSON(instance[field] ?? fallback ?? null) !==
      canonicalJSON(sourceRoot[field] ?? fallback ?? null)
    ) {
      for (const group of overrideTouchedGroups(field, sourceRoot.type)) {
        touched.add(group);
      }
    }
  }
  if (touched.size > 0) root.touched = [...touched].sort();
}

function applyInstanceOverrides(nodes, instance, resolve) {
  const byNode = new Map();
  for (const [overridePath, value] of Object.entries(
    instance.instance.overrides ?? {},
  )) {
    const separator = overridePath.indexOf(":");
    if (separator <= 0 || separator === overridePath.length - 1) {
      fail(
        "invalid_component_override_path",
        `Component override path is invalid: ${overridePath}`,
        { instanceId: instance.id, overridePath },
      );
    }
    const sourceNodeId = overridePath.slice(0, separator);
    const field = overridePath.slice(separator + 1);
    const nodeId =
      sourceNodeId === instance.sourceNodeId
        ? instance.id
        : prefixedNodeId(instance.id, sourceNodeId);
    const node = ownValue(nodes, nodeId);
    if (!node) {
      fail(
        "missing_component_override_target",
        `Component override target is missing: ${overridePath}`,
        { instanceId: instance.id, overridePath },
      );
    }
    if (!OVERRIDE_FIELDS.has(field)) {
      fail(
        "unsupported_component_override",
        `Component override field is unsupported: ${field}`,
        { field, instanceId: instance.id, overridePath },
      );
    }
    if (field === "text" && node.type !== "TEXT") {
      fail(
        "component_override_type_mismatch",
        `Text override target is not TEXT: ${sourceNodeId}`,
        { instanceId: instance.id, overridePath },
      );
    }
    if (!byNode.has(node)) byNode.set(node, {});
    byNode.get(node)[field] = value;
  }
  for (const [node, overrides] of byNode) {
    applyNodeOverrides(node, overrides);
    if (overrides.tokenBindings && resolve) resolve(node, overrides.tokenBindings);
  }
}

// Shapes Penpot draws as boards: their children pin left/top by default.
const BOARD_TYPES = new Set(["COMPONENT", "FRAME", "INSTANCE"]);

// A child's constraint on one axis ("h" or "v"). Without one, Penpot pins a
// board's direct child to its left/top and scales any other shape with its
// parent (geom/shapes/constraints.cljc default-constraints-h/-v).
function constraintOf(child, parent, axis) {
  const value = child[`constraints-${axis}`];
  if (typeof value === "string") return value;
  if (!BOARD_TYPES.has(parent.type)) return "scale";
  return axis === "h" ? "left" : "top";
}

// A child's parent-relative start and size on one axis after its parent
// grows from `before` to `after`, per Penpot's constraint modifiers.
function constrainedAxis(constraint, start, size, before, after) {
  const delta = after - before;
  if (constraint === "right" || constraint === "bottom") return [start + delta, size];
  // Penpot scales the side to its new length, which never goes negative.
  if (constraint === "leftright" || constraint === "topbottom") {
    return [start, Math.abs(size + delta)];
  }
  if (constraint === "center") return [start + delta / 2, size];
  if (constraint === "scale") {
    const ratio = before > 0 ? after / before : 1;
    return [start * ratio, size * ratio];
  }
  return [start, size];
}

// Resizes the subtree under `parentId`, which was `before` ({width, height})
// in its source, the way Penpot resizes a component copy: every child
// follows its constraints, children a flex layout places are left to the
// layout reflow, and a resized child passes the change on to its own.
function applyResizeConstraints(nodes, parentId, before) {
  const parent = nodes[parentId];
  if (
    !parent ||
    ![parent.width, parent.height, before.width, before.height].every(Number.isFinite) ||
    (parent.width === before.width && parent.height === before.height)
  ) {
    return;
  }
  for (const childId of parent.children ?? []) {
    const child = nodes[childId];
    if (!child) continue;
    if (
      (parent.layout === "flex" || parent.layout === "grid") &&
      child["layout-item-absolute"] !== true
    ) {
      continue;
    }
    const childBefore = { height: child.height, width: child.width };
    [child.x, child.width] = constrainedAxis(
      constraintOf(child, parent, "h"),
      child.x,
      child.width,
      before.width,
      parent.width,
    );
    [child.y, child.height] = constrainedAxis(
      constraintOf(child, parent, "v"),
      child.y,
      child.height,
      before.height,
      parent.height,
    );
    applyResizeConstraints(nodes, childId, childBefore);
  }
}

function instantiateComponent(instanceValue, product, options, stack) {
  const instance = structuredClone(instanceValue);
  const target = componentTarget(
    product,
    options.foundation,
    options.libraries ?? [],
    instance.instance.component,
  );
  if (!target) {
    fail(
      "missing_component",
      `Component not found: ${instance.instance.component.assetId}`,
      { instanceId: instance.id, reference: instance.instance.component },
    );
  }
  if (stack.has(target.componentSet.id)) {
    fail(
      "component_instance_cycle",
      `Component instance cycle includes ${target.componentSet.id}`,
      { componentId: target.componentSet.id },
    );
  }
  const match = findComponentVariant(
    target.componentSet,
    instance.instance.variant,
    { allowPreviewFallback: options.allowPreviewFallback },
  );
  // An Instance whose selection no variant has any more (its Foundation
  // renamed a value or deleted the variant) is a Repair, not an unreadable
  // file: it draws with the closest variant and says so.
  const stale = [];
  if (!match.variant) {
    match.variant = closestComponentVariant(
      target.componentSet,
      instance.instance.variant,
    );
    if (!match.variant) {
      fail(
        "missing_variant",
        `${target.componentSet.id} has no variant to draw ${instance.id} with`,
        { componentId: target.componentSet.id, instanceId: instance.id },
      );
    }
    const label = (selection) =>
      (target.componentSet.axes ?? []).filter((axis) => selection?.[axis.id] !== undefined)
        .map((axis) => `${axis.name}=${selection[axis.id]}`).join(", ") || "no selection";
    stale.push({
      code: "stale_instance_variant",
      component: { ...structuredClone(instance.instance.component), name: target.componentSet.name },
      fallbackSelection: structuredClone(match.variant.selection),
      instanceId: instance.id,
      message:
        `${instance.name ?? "A copy"} uses ${target.componentSet.name} with ${label(instance.instance.variant)}, ` +
        `which it no longer has; it is drawn as ${label(match.variant.selection)} until a variant is chosen`,
      selection: structuredClone(instance.instance.variant ?? {}),
      severity: "error",
    });
  }
  stack.add(target.componentSet.id);
  const result = {};
  const sourceNodes = match.variant.nodes;
  let nestedFallbackUsed = false;
  const visit = (sourceId) => {
    const source = qualifyComponentAssetReferences(
      applyEffectiveTokenBindings(sourceNodes[sourceId], product, {
        context: options.context,
        foundation: options.foundation,
        libraries: options.libraries,
      }),
      target.owner,
      product,
    );
    const derivedId = sourceId === match.variant.rootId
      ? instance.id
      : prefixedNodeId(instance.id, sourceId);
    if (source.instance) {
      // A copy may switch a nested copy's variant ("<nested>:variant").
      const switched = instance.instance.overrides?.[`${sourceId}:variant`];
      // A switched copy takes the size of its new variant, as Penpot's swap.
      const nestedSource = switched
        ? { ...source, width: undefined, height: undefined, instance: { ...source.instance, variant: { ...(source.instance.variant ?? {}), ...switched } } }
        : source;
      const nested = instantiateComponent(
        { ...nestedSource, id: derivedId },
        product,
        options,
        stack,
      );
      Object.assign(result, nested.nodes);
      nestedFallbackUsed ||= nested.fallbackUsed;
      stale.push(...nested.staleInstances);
      return;
    }
    const children = source.children.map((childId) =>
      childId === match.variant.rootId
        ? instance.id
        : prefixedNodeId(instance.id, childId),
    );
    result[derivedId] = {
      ...source,
      ...(sourceId === match.variant.rootId ? instance : {}),
      children,
      componentRef: structuredClone(instance.instance.component),
      id: derivedId,
      sourceNodeId: sourceId,
      variantId: match.variant.id,
      variantSelection: structuredClone(match.variant.selection),
      ...(sourceId === match.variant.rootId
        ? {
            height: instance.height ?? sourceNodes[match.variant.rootId].height,
            name: instance.name,
            type: "INSTANCE",
            width: instance.width ?? sourceNodes[match.variant.rootId].width,
            x: instance.x,
            y: instance.y,
          }
        : {}),
    };
    if (
      sourceId === match.variant.rootId &&
      Object.keys(instance.tokenBindings ?? {}).length > 0
    ) {
      // Resolve the copy's own bindings against its complete layout. The
      // source supplies unbound sides; the copy's raw values and Tokens win.
      const root = result[derivedId];
      if (
        ["itemSpacing", "rowGap", "columnGap"].some((field) =>
          Object.hasOwn(instance.tokenBindings, field),
        )
      ) {
        root["layout-gap"] = {
          ...normalizedLayoutGap(source["layout-gap"]),
          ...normalizedLayoutGap(instance["layout-gap"]),
        };
      }
      if (
        ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].some(
          (field) => Object.hasOwn(instance.tokenBindings, field),
        )
      ) {
        root["layout-padding"] = {
          ...source["layout-padding"],
          ...instance["layout-padding"],
        };
      }
      result[derivedId] = applyEffectiveTokenBindings(root, product, {
        context: options.context,
        foundation: options.foundation,
        libraries: options.libraries,
      });
    }
    delete result[derivedId].instance;
    for (const childId of source.children) visit(childId);
  };
  visit(match.variant.rootId);
  const root = result[instance.id];
  const sourceRoot = sourceNodes[match.variant.rootId];
  applyResizeConstraints(result, instance.id, {
    height: sourceRoot.height,
    width: sourceRoot.width,
  });
  rootOverrideTouched(
    root,
    instance,
    applyEffectiveTokenBindings(sourceNodes[match.variant.rootId], product, {
      context: options.context,
      foundation: options.foundation,
      libraries: options.libraries,
    }),
  );
  root.sourceNodeId = match.variant.rootId;
  root.componentId = target.componentSet.id;
  root.componentOwnerPackageId = target.owner.manifest.packageId;
  applyInstanceOverrides(
    result,
    { ...instance, sourceNodeId: match.variant.rootId },
    (node, bindings) =>
      resolveOverrideBindings(node, bindings, product, {
        context: options.context,
        foundation: options.foundation,
        libraries: options.libraries,
      }),
  );
  stack.delete(target.componentSet.id);
  return {
    fallbackUsed: match.fallbackUsed || nestedFallbackUsed,
    nodes: result,
    staleInstances: stale,
  };
}

function projectNodes(sourceNodes, product, options) {
  const nodes = {};
  let fallbackUsed = false;
  const staleInstances = [];
  for (const node of Object.values(sourceNodes)) {
    if (node.instance) {
      const instance = instantiateComponent(node, product, options, new Set());
      Object.assign(nodes, instance.nodes);
      fallbackUsed ||= instance.fallbackUsed;
      staleInstances.push(...instance.staleInstances);
    } else {
      nodes[node.id] = applyEffectiveTokenBindings(node, product, {
        context: options.context,
        foundation: options.foundation,
        libraries: options.libraries,
      });
    }
  }
  for (const node of Object.values(nodes)) {
    node.children = (node.children ?? []).flatMap((childId) =>
      sourceNodes[childId]?.instance ? [childId] : [childId],
    );
  }
  applyLocatedCopyInheritance(nodes, product, options);
  return { fallbackUsed, nodes, staleInstances };
}

const COPY_TOUCHED_FIELDS = new Map([
  ["blur-group", ["backgroundBlur", "blur"]],
  ["content-group", ["text", "textBlocks"]],
  ["fill-group", ["fills"]],
  ["geometry-group", ["height", "rotation", "width"]],
  ["mask-group", ["masked-group", "show-content"]],
  ["radius-group", ["cornerRadius"]],
  ["shadow-group", ["shadow"]],
  ["stroke-group", ["strokes"]],
  ["text-display-group", ["textStyle"]],
  ["text-font-group", ["textStyle"]],
  ["visibility-group", ["visible"]],
]);

// Untouched located component copies re-read the master's shared fields on
// every projection so later master edits propagate (CMP-005). Fields in the
// copy's `touched` groups keep the copy's own values.
function applyLocatedCopyInheritance(nodes, product, options) {
  const mastersBySourceNodeId = new Map();
  const resolveSource = (node) =>
    // Masters inherit from their token-evaluated values, not raw Canonical
    // fields, so a copy follows the same resolved color as its master.
    applyEffectiveTokenBindings(node, product, {
      context: options?.context,
      foundation: options?.foundation,
      libraries: options?.libraries,
    });
  for (const component of product.domain.locatedComponents.values()) {
    const entry = product.manifest.entries.screens.find(
      (candidate) => product.entries[candidate].id === component.screenId,
    );
    const presentation = entry
      ? product.entries[entry].presentations.find(
          ({ id }) => id === component.presentationId,
        )
      : undefined;
    if (!presentation) continue;
    const masterNode = presentation.nodes[component.mainNodeId];
    if (!masterNode) continue;
    mastersBySourceNodeId.set(component.mainNodeId, resolveSource(masterNode));
    const visit = (nodeId) => {
      const node = presentation.nodes[nodeId];
      if (!node) return;
      if (nodeId !== component.mainNodeId) {
        mastersBySourceNodeId.set(nodeId, resolveSource(node));
      }
      for (const childId of node.children ?? []) visit(childId);
    };
    visit(component.mainNodeId);
  }
  if (mastersBySourceNodeId.size === 0) return;
  for (const node of Object.values(nodes)) {
    if (node.sourceNodeId === undefined) continue;
    // Instance expansions also carry sourceNodeId; only located copies inherit.
    if (node.componentRef !== undefined || node.variantSelection !== undefined) {
      continue;
    }
    const master = mastersBySourceNodeId.get(node.sourceNodeId);
    if (!master) continue;
    const touchedGroups = new Set(node.touched ?? []);
    // Identity fields never inherit: a located copy stays its own INSTANCE
    // node with its own placement and master link (RV-001-A).
    const ownFields = new Set([
      "children",
      "componentId",
      "id",
      "name",
      "sourceNodeId",
      "touched",
      "type",
      "x",
      "y",
    ]);
    for (const [group, fields] of COPY_TOUCHED_FIELDS) {
      if (touchedGroups.has(group)) {
        for (const field of fields) ownFields.add(field);
      }
    }
    if (touchedGroups.has("modifiable-group")) ownFields.add("name");
    for (const field of Object.keys(master)) {
      if (ownFields.has(field)) continue;
      if (master[field] === undefined) continue;
      node[field] = structuredClone(master[field]);
    }
  }
}

function layoutPaddingOf(node) {
  const padding = node["layout-padding"];
  if (!padding || typeof padding !== "object") {
    return { bottom: 0, left: 0, right: 0, top: 0 };
  }
  const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  return {
    bottom: number(padding.p3),
    left: number(padding.p4),
    right: number(padding.p2),
    top: number(padding.p1),
  };
}

function isColumnLayout(node) {
  const direction = node["layout-flex-dir"];
  return direction === "column" || direction === "column-reverse";
}

// Penpot writes row-gap/column-gap; older packages hold rowGap/columnGap.
function layoutMainGapOf(node) {
  const gap = node["layout-gap"];
  if (!gap || typeof gap !== "object") return 0;
  const number = (...values) => {
    const value = values.find((item) => item !== undefined && item !== null);
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  };
  return isColumnLayout(node)
    ? number(gap["row-gap"], gap.rowGap)
    : number(gap["column-gap"], gap.columnGap);
}

// Deterministic flex reflow for projected nodes: gap/padding/direction drive
// child positions (relative to the parent origin) so layout changes are
// visible in pixels and semantic bounds.
function reflowFlexLayout(nodes, nodeId) {
  const node = nodes[nodeId];
  if (!node) return;
  for (const childId of node.children ?? []) reflowFlexLayout(nodes, childId);
  if (node.layout !== "flex") return;
  // Like Penpot (flex_layout/layout_data.cljc), a row or column starts
  // with the top layer, the last child; a -reverse direction starts with
  // the first child.
  const direction = node["layout-flex-dir"];
  const children =
    direction === "row-reverse" || direction === "column-reverse"
      ? (node.children ?? [])
      : [...(node.children ?? [])].reverse();
  const items = children
    .map((childId) => nodes[childId])
    .filter((child) => child && child.visible !== false && child["layout-item-absolute"] !== true);
  if (items.length === 0) return;
  const column = isColumnLayout(node);
  const padding = layoutPaddingOf(node);
  const gap = layoutMainGapOf(node);
  const innerWidth = Math.max(0, node.width - padding.left - padding.right);
  const innerHeight = Math.max(0, node.height - padding.top - padding.bottom);
  const mainSize = (child) => (column ? child.height : child.width);
  const crossSize = (child) => (column ? child.width : child.height);
  const fillMainField = column ? "layout-item-v-sizing" : "layout-item-h-sizing";
  const fillCrossField = column ? "layout-item-h-sizing" : "layout-item-v-sizing";
  const fillItems = items.filter((child) => child[fillMainField] === "fill");
  if (fillItems.length > 0) {
    const fixedTotal = items
      .filter((child) => child[fillMainField] !== "fill")
      .reduce((sum, child) => sum + mainSize(child), 0);
    const availableMain =
      (column ? innerHeight : innerWidth) - gap * (items.length - 1);
    const fillEach = Math.max(
      0,
      (availableMain - fixedTotal) / fillItems.length,
    );
    for (const child of fillItems) {
      if (column) child.height = fillEach;
      else child.width = fillEach;
    }
  }
  for (const child of items) {
    if (child[fillCrossField] !== "fill") continue;
    if (column) child.width = innerWidth;
    else child.height = innerHeight;
  }
  const contentMain =
    items.reduce((sum, child) => sum + mainSize(child), 0) +
    gap * (items.length - 1);
  const justify = node["layout-justify-content"];
  // Like Penpot, center and end let overflowing content run past the
  // start edge; space-between never shrinks the gap.
  const free = (column ? innerHeight : innerWidth) - contentMain;
  const spaceBetween =
    justify === "space-between" && items.length > 1
      ? Math.max(0, free) / (items.length - 1)
      : 0;
  let cursor = column ? padding.top : padding.left;
  if (justify === "center") cursor += free / 2;
  else if (justify === "end") cursor += free;
  for (const child of items) {
    const align = child["layout-item-align-self"] ?? node["layout-align-items"];
    const crossFree = column ? innerWidth : innerHeight;
    let crossOffset = column ? padding.left : padding.top;
    if (align === "center") crossOffset += (crossFree - crossSize(child)) / 2;
    else if (align === "end") crossOffset += crossFree - crossSize(child);
    if (column) {
      child.x = crossOffset;
      child.y = cursor;
    } else {
      child.x = cursor;
      child.y = crossOffset;
    }
    cursor += mainSize(child) + gap + spaceBetween;
    // A fill-sized container must lay out its own children at its new size.
    if (child.layout === "flex") reflowFlexLayout(nodes, child.id);
  }
}

// Persisting a native layout field does not mean the local projection executes
// it. Every consumer can report these gaps rather than approving stored bounds.
export function layoutProjectionDiagnostics(nodes) {
  const diagnostics = [];
  for (const node of Object.values(nodes)) {
    if (!node.layout || node.visible === false) continue;
    const unsupported = [];
    if (node.layout !== "flex") unsupported.push("layout");
    else {
      const allowed = {
        "layout-flex-dir": ["row", "row-reverse", "column", "column-reverse"],
        "layout-wrap-type": ["nowrap"],
        "layout-justify-content": ["start", "center", "end", "space-between"],
        "layout-align-items": ["start", "center", "end"],
        "layout-align-content": ["start"],
      };
      for (const [field, values] of Object.entries(allowed))
        if (node[field] !== undefined && !values.includes(node[field])) unsupported.push(field);
      for (const childId of node.children ?? []) {
        const child = nodes[childId];
        if (!child || child.visible === false || child["layout-item-absolute"] === true) continue;
        for (const field of ["layout-item-h-sizing", "layout-item-v-sizing"])
          if (child[field] !== undefined && !["fill", "fix"].includes(child[field])) unsupported.push(`${childId}.${field}`);
        if (child["layout-item-align-self"] !== undefined && !["start", "center", "end"].includes(child["layout-item-align-self"])) unsupported.push(`${childId}.layout-item-align-self`);
        if (Object.values(child["layout-item-margin"] ?? {}).some(value => Number(value) !== 0)) unsupported.push(`${childId}.layout-item-margin`);
        for (const field of ["layout-item-min-h", "layout-item-max-h", "layout-item-min-w", "layout-item-max-w"])
          if (child[field] !== undefined) unsupported.push(`${childId}.${field}`);
      }
    }
    if (unsupported.length) diagnostics.push({ code: "layout_projection_partial", nodeId: node.id, unsupportedFields: unsupported,
      message: "Local projection does not compute these native layout fields; stored bounds are only a partial preview. App layout can differ. Do not treat geometry checks or PNG as complete layout validation." });
  }
  return diagnostics;
}

function reflowProjection(nodes, rootId) {
  if (nodes[rootId]) reflowFlexLayout(nodes, rootId);
}

export function projectComponentVariant(product, variant, options = {}) {
  const sourceNodes = options.owner
    ? Object.fromEntries(Object.entries(variant.nodes).map(([id, node]) => [
        id, qualifyComponentAssetReferences(node, options.owner, product),
      ]))
    : variant.nodes;
  const projected = projectNodes(sourceNodes, product, {
    ...options,
    context: resolveContext(product, options.foundation, options.context ?? {}),
    allowPreviewFallback: false,
  });
  reflowProjection(projected.nodes, variant.rootId);
  return projected.nodes;
}

export function projectScreen(product, screenId, options = {}) {
  const { screen } = screenById(product, screenId);
  const presentationId = options.presentationId ?? screen.basePresentationId;
  const presentation = screen.presentations.find(({ id }) => id === presentationId);
  if (!presentation) {
    fail("missing_presentation", `Presentation not found: ${presentationId}`, {
      presentationId,
      screenId,
    });
  }
  const context = resolveContext(
    product,
    options.foundation,
    options.context ?? {},
  );
  const projected = projectNodes(presentation.nodes, product, {
    allowPreviewFallback: options.allowPreviewFallback === true,
    context,
    foundation: options.foundation,
    libraries: options.libraries,
  });
  reflowProjection(projected.nodes, presentation.rootId);
  return {
    context,
    diagnostics: [...projected.staleInstances, ...layoutProjectionDiagnostics(projected.nodes)],
    fallbackUsed: projected.fallbackUsed,
    nodes: projected.nodes,
    presentation: { ...structuredClone(presentation), nodes: projected.nodes },
    presentationId,
    rootId: presentation.rootId,
    screen: structuredClone(screen),
    screenId,
  };
}

function projectComponentScenario(product, scenario, options) {
  const target = componentTarget(
    product,
    options.foundation,
    options.libraries ?? [],
    scenario.target.component,
  );
  if (!target) {
    fail(
      "missing_component",
      `Component not found: ${scenario.target.component.assetId}`,
    );
  }
  const selection = structuredClone(scenario.target.variant);
  for (const action of scenario.actions) {
    if (action.type === "set-state") selection[action.axisId] = action.value;
  }
  const match = findComponentVariant(target.componentSet, selection, {
    allowPreviewFallback: options.allowPreviewFallback,
  });
  if (!match.variant) {
    fail(
      "missing_variant",
      `No exact variant exists for ${target.componentSet.id} ` +
        `${JSON.stringify(selection)}: ${variantMismatchText(target.componentSet, selection)}`,
      { componentId: target.componentSet.id, selection },
    );
  }
  const projected = projectNodes(match.variant.nodes, product, {
    allowPreviewFallback: options.allowPreviewFallback === true,
    context: options.context,
    foundation: options.foundation,
    libraries: options.libraries,
  });
  reflowProjection(projected.nodes, match.variant.rootId);
  const nodes = projected.nodes;
  for (const action of scenario.actions) {
    if (action.type !== "set-override") continue;
    const separator = action.overridePath.indexOf(":");
    const nodeId = action.overridePath.slice(0, separator);
    const field = action.overridePath.slice(separator + 1);
    const node = ownValue(nodes, nodeId);
    if (separator <= 0 || !node) {
      fail(
        "missing_component_override_target",
        `Scenario override target is missing: ${action.overridePath}`,
      );
    }
    if (!OVERRIDE_FIELDS.has(field)) {
      fail(
        "unsupported_component_override",
        `Component override field is unsupported: ${field}`,
        { field, overridePath: action.overridePath },
      );
    }
    node[field] = structuredClone(action.value);
  }
  return {
    context: options.context,
    diagnostics: [...projected.staleInstances, ...layoutProjectionDiagnostics(projected.nodes)],
    fallbackUsed: match.fallbackUsed || projected.fallbackUsed,
    nodes,
    presentationId: null,
    rootId: match.variant.rootId,
    screenId: null,
  };
}

function applyScenarioActions(projection, scenario) {
  for (const action of scenario.actions) {
    if (action.type === "set-state" || action.type === "set-override") continue;
    const node = ownValue(projection.nodes, action.nodeId);
    if (!node) {
      fail("missing_scenario_node", `Scenario Node is missing: ${action.nodeId}`);
    }
    if (action.type === "set-text") {
      if (node.type !== "TEXT") {
        fail(
          "scenario_node_type_mismatch",
          `set-text target is not TEXT: ${action.nodeId}`,
        );
      }
      node.text = action.value;
    } else if (action.type === "set-visibility") {
      node.visible = action.visible;
    }
  }
}

export function projectScenario(product, scenarioId, options = {}) {
  const scenario = product.domain.scenarios.get(scenarioId);
  if (!scenario) {
    fail("missing_scenario", `Scenario not found: ${scenarioId}`, { scenarioId });
  }
  const context = resolveContext(product, options.foundation, {
    ...scenario.context,
    ...(options.context ?? {}),
  });
  const projection =
    scenario.target.kind === "screen"
      ? projectScreen(product, scenario.target.screen.assetId, {
          ...options,
          context,
          presentationId: scenario.target.presentationId,
        })
      : projectComponentScenario(product, scenario, {
          ...options,
          context,
        });
  applyScenarioActions(projection, scenario);
  // Expectations use the same canonical IDs accepted by put-scenario. Instance
  // internals are generated projection IDs, not independently saved nodes.
  let sourceNodes;
  if (scenario.target.kind === "screen") {
    const { screen } = screenById(product, scenario.target.screen.assetId);
    sourceNodes = screen.presentations.find(({ id }) => id === projection.presentationId).nodes;
  } else {
    const target = componentTarget(product, options.foundation, options.libraries ?? [], scenario.target.component);
    const selection = { ...scenario.target.variant };
    for (const action of scenario.actions) if (action.type === "set-state") selection[action.axisId] = action.value;
    sourceNodes = findComponentVariant(target.componentSet, selection, { allowPreviewFallback: options.allowPreviewFallback }).variant.nodes;
  }
  const visibleNodeIds = [];
  const visit = (id) => {
    const node = projection.nodes[id];
    if (!node || node.visible === false) return;
    if (Object.hasOwn(sourceNodes, id)) visibleNodeIds.push(id);
    for (const childId of node.children ?? []) visit(childId);
  };
  visit(projection.rootId);
  visibleNodeIds.sort();
  const expectedVisibleNodeIds = [...scenario.expectedVisibleNodeIds].sort();
  return {
    ...projection,
    diagnostics: [
      ...(projection.diagnostics ?? []),
      ...(JSON.stringify(visibleNodeIds) === JSON.stringify(expectedVisibleNodeIds)
        ? []
        : [
            {
              code: "scenario_visibility_mismatch",
              expectedVisibleNodeIds,
              message: "Projected visibility differs from Scenario expectation",
              visibleNodeIds,
            },
          ]),
    ],
    scenario: structuredClone(scenario),
    scenarioId,
  };
}
