import { findComponentVariant } from "./components-domain.mjs";
import { resolveContext } from "./contexts.mjs";
import { fail } from "./errors.mjs";
import { applyEffectiveTokenBindings } from "./projection-values.mjs";

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

function applyInstanceOverrides(nodes, instance) {
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
    const node = nodes[nodeId];
    if (!node) {
      fail(
        "missing_component_override_target",
        `Component override target is missing: ${overridePath}`,
        { instanceId: instance.id, overridePath },
      );
    }
    if (!new Set(["fills", "name", "opacity", "text", "visible"]).has(field)) {
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
    node[field] = structuredClone(value);
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
  if (!match.variant) {
    fail(
      "missing_variant",
      `No exact variant exists for ${target.componentSet.id}`,
      {
        componentId: target.componentSet.id,
        instanceId: instance.id,
        selection: instance.instance.variant,
      },
    );
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
      const nested = instantiateComponent(
        { ...source, id: derivedId },
        product,
        options,
        stack,
      );
      Object.assign(result, nested.nodes);
      nestedFallbackUsed ||= nested.fallbackUsed;
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
            height: instance.height,
            name: instance.name,
            type: "INSTANCE",
            width: instance.width,
            x: instance.x,
            y: instance.y,
          }
        : {}),
    };
    delete result[derivedId].instance;
    for (const childId of source.children) visit(childId);
  };
  visit(match.variant.rootId);
  const root = result[instance.id];
  root.sourceNodeId = match.variant.rootId;
  root.componentId = target.componentSet.id;
  root.componentOwnerPackageId = target.owner.manifest.packageId;
  applyInstanceOverrides(result, {
    ...instance,
    sourceNodeId: match.variant.rootId,
  });
  stack.delete(target.componentSet.id);
  return {
    fallbackUsed: match.fallbackUsed || nestedFallbackUsed,
    nodes: result,
  };
}

function projectNodes(sourceNodes, product, options) {
  const nodes = {};
  let fallbackUsed = false;
  for (const node of Object.values(sourceNodes)) {
    if (node.instance) {
      const instance = instantiateComponent(node, product, options, new Set());
      Object.assign(nodes, instance.nodes);
      fallbackUsed ||= instance.fallbackUsed;
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
  return { fallbackUsed, nodes };
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

function layoutMainGapOf(node) {
  const gap = node["layout-gap"];
  if (!gap || typeof gap !== "object") return 0;
  const rowGap = Number.isFinite(Number(gap.rowGap)) ? Number(gap.rowGap) : 0;
  const columnGap = Number.isFinite(Number(gap.columnGap)) ? Number(gap.columnGap) : 0;
  return node["layout-flex-dir"] === "column" ? rowGap : columnGap;
}

// Deterministic flex reflow for projected nodes: gap/padding/direction drive
// child positions (relative to the parent origin) so layout changes are
// visible in pixels and semantic bounds.
function reflowFlexLayout(nodes, nodeId) {
  const node = nodes[nodeId];
  if (!node) return;
  for (const childId of node.children ?? []) reflowFlexLayout(nodes, childId);
  if (node.layout !== "flex") return;
  const items = (node.children ?? [])
    .map((childId) => nodes[childId])
    .filter((child) => child && child["layout-item-absolute"] !== true);
  if (items.length === 0) return;
  const column = node["layout-flex-dir"] === "column";
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
  const free = Math.max(0, (column ? innerHeight : innerWidth) - contentMain);
  const spaceBetween =
    justify === "space-between" && items.length > 1 ? free / (items.length - 1) : 0;
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
  }
}

function reflowProjection(nodes, rootId) {
  if (nodes[rootId]) reflowFlexLayout(nodes, rootId);
}

export function projectComponentVariant(product, variant, options = {}) {
  const projected = projectNodes(variant.nodes, product, {
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
      `No exact variant exists for ${target.componentSet.id}`,
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
    if (separator <= 0 || !nodes[nodeId] || !field) {
      fail(
        "missing_component_override_target",
        `Scenario override target is missing: ${action.overridePath}`,
      );
    }
    nodes[nodeId][field] = structuredClone(action.value);
  }
  return {
    context: options.context,
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
    const node = projection.nodes[action.nodeId];
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
  const visibleNodeIds = Object.values(projection.nodes)
    .filter((node) => node.visible !== false)
    .map(({ id }) => id)
    .sort();
  const expectedVisibleNodeIds = [...scenario.expectedVisibleNodeIds].sort();
  return {
    ...projection,
    diagnostics:
      JSON.stringify(visibleNodeIds) === JSON.stringify(expectedVisibleNodeIds)
        ? []
        : [
            {
              code: "scenario_visibility_mismatch",
              expectedVisibleNodeIds,
              message: "Projected visibility differs from Scenario expectation",
              visibleNodeIds,
            },
          ],
    scenario: structuredClone(scenario),
    scenarioId,
  };
}
