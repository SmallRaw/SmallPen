import { combineContextAxes, resolveContext } from "./contexts.mjs";
import { listEffectiveTokens } from "./effective-tokens.mjs";
import { listTokenThemes, selectTokenThemes } from "./token-themes.mjs";

// Token types advised for a field. A plain number Token (a count, a ratio)
// is not advised for sizes and spacing, which have their own types; it can
// still be bound by name.
const FIELD_TYPES = new Map([
  ["backgroundBlur", ["number", "other"]],
  ["blur", ["number", "other"]],
  ["cornerRadius", ["border-radius", "dimensions"]],
  ["fill", ["color"]],
  ["fontFamily", ["font-family", "string"]],
  ["fontSize", ["dimensions", "font-size"]],
  ["fontWeight", ["font-weight", "number"]],
  ["height", ["dimensions", "sizing"]],
  ["itemSpacing", ["dimensions", "spacing"]],
  ["opacity", ["number", "opacity"]],
  ["paddingBottom", ["dimensions", "spacing"]],
  ["paddingLeft", ["dimensions", "spacing"]],
  ["paddingRight", ["dimensions", "spacing"]],
  ["paddingTop", ["dimensions", "spacing"]],
  ["shadow", ["shadow"]],
  ["stroke", ["color"]],
  ["typography", ["typography"]],
  ["width", ["dimensions", "sizing"]],
]);

const NAMED_COLORS = new Map([
  ["black", [0, 0, 0, 255]], ["blue", [0, 0, 255, 255]],
  ["gray", [128, 128, 128, 255]], ["green", [0, 128, 0, 255]],
  ["grey", [128, 128, 128, 255]], ["red", [255, 0, 0, 255]],
  ["transparent", [0, 0, 0, 0]], ["white", [255, 255, 255, 255]],
]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparable(value) {
  if (Array.isArray(value)) return value.map(comparable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, child]) => [key, comparable(child)]));
  }
  return value;
}

function equalValue(left, right) {
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

function clamp(value, lower, upper) {
  return Math.min(Math.max(value, lower), upper);
}

function colorComponents(value) {
  if (value !== null && typeof value === "object" &&
      String(value.colorSpace ?? "").toLowerCase() === "srgb" &&
      Array.isArray(value.components) && value.components.length === 3 &&
      value.components.every((part) => typeof part === "number" && Number.isFinite(part))) {
    const alpha = value.alpha === undefined ? 1 : value.alpha;
    if (typeof alpha !== "number" || !Number.isFinite(alpha)) return undefined;
    return [...value.components.map((part) => Math.round(clamp(part, 0, 1) * 255)),
      Math.round(clamp(alpha, 0, 1) * 255)];
  }
  if (typeof value !== "string") return undefined;
  const source = value.trim().toLowerCase();
  if (NAMED_COLORS.has(source)) return [...NAMED_COLORS.get(source)];
  if (source.startsWith("#")) {
    const hex = source.slice(1);
    if (![3, 4, 6, 8].includes(hex.length) || !/^[0-9a-f]+$/.test(hex)) return undefined;
    const pairs = hex.length <= 4 ? [...hex].map((part) => part + part) : hex.match(/../g);
    return [Number.parseInt(pairs[0], 16), Number.parseInt(pairs[1], 16),
      Number.parseInt(pairs[2], 16), pairs[3] === undefined ? 255 : Number.parseInt(pairs[3], 16)];
  }
  const match = /^rgba?\(([^)]+)\)$/.exec(source);
  if (!match) return undefined;
  const parts = match[1].split(",").map((part) => Number(part.trim()));
  if ((parts.length !== 3 && parts.length !== 4) || !parts.every(Number.isFinite)) return undefined;
  return [clamp(Math.round(parts[0]), 0, 255), clamp(Math.round(parts[1]), 0, 255),
    clamp(Math.round(parts[2]), 0, 255),
    parts[3] === undefined ? 255 : clamp(Math.round(parts[3] * 255), 0, 255)];
}

function valueDistance(requested, candidate) {
  const requestedColor = colorComponents(requested);
  const candidateColor = colorComponents(candidate);
  if (requestedColor && candidateColor) {
    return Math.sqrt(requestedColor.reduce(
      (sum, component, index) => sum + (component - candidateColor[index]) ** 2, 0));
  }
  if (typeof requested === "number" && typeof candidate === "number") return Math.abs(requested - candidate);
  return equalValue(requested, candidate) ? 0 : Number.POSITIVE_INFINITY;
}

function contextSelections(product, options) {
  if (Object.hasOwn(options, "context")) return [resolveContext(product, options.foundation, options.context)];
  const axes = [...combineContextAxes(product, options.foundation).values()]
    .sort((left, right) => compareText(left.id, right.id));
  return axes.reduce((selections, axis) => selections.flatMap((selection) =>
    axis.values.map(({ id }) => ({ ...selection, [axis.id]: id }))), [{}]);
}

const MAX_THEME_SELECTIONS = 64;

// Every selection of one theme per group, across the Package and its
// Foundation, capped so a large theme matrix cannot flood a search.
function allThemeSelections(product, foundation) {
  const groups = new Map();
  for (const theme of listTokenThemes(product, foundation)) {
    groups.set(theme.group, [...(groups.get(theme.group) ?? []), theme.path]);
  }
  let selections = [[]];
  let capped = false;
  for (const paths of groups.values()) {
    selections = selections.flatMap((selection) => paths.map((path) => [...selection, path]));
    if (selections.length > MAX_THEME_SELECTIONS) {
      selections.length = MAX_THEME_SELECTIONS;
      capped = true;
    }
  }
  return { capped, selections };
}

// Searches the active theme selection by default (as every read does);
// allThemes searches every selection and tags each value with its themes.
function themeScope(product, options) {
  const active = listTokenThemes(product, options.foundation)
    .filter(({ active: isActive }) => isActive)
    .map(({ path }) => path);
  if (!options.allThemes) {
    return {
      mode: options.themeMode ?? "active",
      selections: [active],
      views: [{ foundation: options.foundation, product, themes: active }],
    };
  }
  const { capped, selections } = allThemeSelections(product, options.foundation);
  return {
    ...(capped ? { capped: true, maxSelections: MAX_THEME_SELECTIONS } : {}),
    mode: "all",
    selections,
    views: selections.map((themes) => ({
      ...selectTokenThemes({ foundation: options.foundation, product }, themes),
      themes,
    })),
  };
}

function createSearchIndex(product, options) {
  const contexts = contextSelections(product, options);
  const themes = themeScope(product, options);
  const grouped = new Map();
  for (const view of themes.views) {
    for (const context of contexts) {
      for (const effective of listEffectiveTokens(view.product, {
        context,
        foundation: view.foundation,
        libraries: options.libraries,
      })) {
        const key = JSON.stringify([effective.target.packageId, effective.target.assetId,
          effective.token.type, comparable(effective.value)]);
        const existing = grouped.get(key);
        if (existing) {
          if (!existing.contexts.some((candidate) => equalValue(candidate, context))) {
            existing.contexts.push(structuredClone(context));
          }
          if (themes.mode === "all" &&
              !existing.themes.some((candidate) => equalValue(candidate, view.themes))) {
            existing.themes.push([...view.themes]);
          }
          continue;
        }
        grouped.set(key, {
          contexts: [structuredClone(context)], deprecated: effective.token.deprecated,
          description: effective.token.description, packageId: effective.target.packageId,
          path: effective.token.path, reference: structuredClone(effective.target),
          sourcePackageId: effective.sourcePackageId, sourceTokenId: effective.sourceTokenId,
          ...(themes.mode === "all" ? { themes: [[...view.themes]] } : {}),
          type: effective.token.type, value: structuredClone(effective.value),
        });
      }
    }
  }
  const { views, ...scope } = themes;
  return { contexts, items: [...grouped.values()], themeScope: scope };
}

function searchItems(product, options, suppliedIndex) {
  const query = String(options.query ?? "").trim().toLowerCase();
  const requestedTypes = options.types ? new Set(options.types) : options.type ? new Set([options.type]) : undefined;
  const hasValue = Object.hasOwn(options, "value");
  const index = suppliedIndex ?? createSearchIndex(product, options);
  const items = index.items
    .filter((item) => item.deprecated !== true)
    .filter((item) => !requestedTypes || requestedTypes.has(item.type))
    .filter((item) => !query || [item.path, item.description, item.type].filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query)))
    .map((item) => {
      const distance = hasValue ? valueDistance(options.value, item.value) : undefined;
      return { ...item, distance, exactValue: hasValue ? distance === 0 : undefined };
    })
    .filter((item) => !hasValue || Number.isFinite(item.distance))
    .sort((left, right) => {
      if (hasValue && left.distance !== right.distance) return left.distance - right.distance;
      return compareText(left.path, right.path) || compareText(left.packageId, right.packageId) ||
        compareText(JSON.stringify(comparable(left.value)), JSON.stringify(comparable(right.value)));
    });
  return { contexts: index.contexts, items, themeScope: index.themeScope };
}

export function searchEffectiveTokens(product, options = {}) {
  const requestedLimit = Number(options.limit ?? 20);
  const limit = Number.isSafeInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 100)) : 20;
  const searched = searchItems(product, options);
  return {
    contextScope: { contexts: searched.contexts, mode: Object.hasOwn(options, "context") ? "explicit" : "all" },
    items: searched.items.slice(0, limit), query: options.query ?? null,
    requestedType: options.type ?? null,
    requestedValue: Object.hasOwn(options, "value") ? structuredClone(options.value) : null,
    themeScope: searched.themeScope,
    total: searched.items.length,
  };
}

function presentationNode(snapshot, operation) {
  const entry = snapshot.manifest.entries.screens.find((candidate) => snapshot.entries[candidate].id === operation.screenId);
  const screen = snapshot.entries[entry];
  if (!screen) return undefined;
  // Advice stays available for batches that target a screen's base
  // presentation without repeating its id.
  const presentation = operation.presentationId === undefined
    ? screen.presentations.find(({ id }) => id === screen.basePresentationId)
    : screen.presentations.find(({ id }) => id === operation.presentationId);
  return presentation?.nodes[operation.nodeId ?? operation.node?.id];
}

function componentNode(snapshot, operation) {
  for (const entry of snapshot.manifest.entries.components) {
    const componentSet = snapshot.entries[entry]?.componentSets?.find(({ id }) => id === operation.componentId);
    const variant = componentSet?.variants.find(({ id }) => id === operation.variantId);
    if (variant?.nodes[operation.nodeId]) return variant.nodes[operation.nodeId];
  }
  return undefined;
}

function nodesInPresentation(presentation) {
  return Object.values(presentation?.nodes ?? {}).map((node) => ({ changes: node, node }));
}

function nodesForOperation(snapshot, operation, before) {
  if (["add-presentation-node", "update-node", "update-presentation-node"].includes(operation.type)) {
    const node = presentationNode(snapshot, operation);
    return node ? [{ changes: operation.node ?? operation.changes ?? {}, node }] : [];
  }
  if (operation.type === "update-component-node") {
    const node = componentNode(snapshot, operation);
    return node ? [{ changes: operation.changes ?? {}, node }] : [];
  }
  if (operation.type === "add-presentation") return nodesInPresentation(operation.presentation);
  // A whole screen or component written again: only the nodes it changed
  // get advice, so a rename or a move does not repeat old advice.
  if (operation.type === "put-screen") {
    const oldEntry = before?.manifest.entries.screens.find((entry) => before.entries[entry]?.id === operation.screen?.id);
    const old = oldEntry ? before.entries[oldEntry] : undefined;
    return (operation.screen?.presentations ?? []).flatMap((presentation) => {
      const oldNodes = old?.presentations.find(({ id }) => id === presentation.id)?.nodes ?? {};
      return nodesInPresentation(presentation).filter(({ node }) => JSON.stringify(oldNodes[node.id]) !== JSON.stringify(node));
    });
  }
  if (operation.type === "put-component-set") {
    const old = before?.domain.componentSets.get(operation.componentSet?.id);
    return (operation.componentSet?.variants ?? []).flatMap((variant) => {
      const oldNodes = old?.variants.find(({ id }) => id === variant.id)?.nodes ?? {};
      return Object.values(variant.nodes ?? {})
        .filter((node) => JSON.stringify(oldNodes[node.id]) !== JSON.stringify(node))
        .map((node) => ({ changes: node, node }));
    });
  }
  if (operation.type === "put-variant") {
    return Object.values(operation.variant?.nodes ?? {}).map((node) => ({ changes: node, node }));
  }
  return [];
}

function assignments(changes) {
  const result = [];
  for (const [field, types] of FIELD_TYPES) {
    if (field === "fill" || field === "stroke" || field === "typography") continue;
    if (Object.hasOwn(changes, field) && changes[field] !== null) {
      result.push({ bindingField: field, field, types, value: changes[field] });
    }
  }
  for (const [index, paint] of (changes.fills ?? []).entries()) {
    if (paint?.color !== undefined) result.push({ bindingField: `fills.${index}`,
      field: `fills.${index}`, types: FIELD_TYPES.get("fill"), value: paint.color });
  }
  for (const [index, paint] of (changes.strokes ?? []).entries()) {
    if (paint?.color !== undefined) result.push({ bindingField: `strokes.${index}`,
      field: `strokes.${index}`, types: FIELD_TYPES.get("stroke"), value: paint.color });
  }
  if (changes.textStyle !== undefined && changes.textStyle !== null) {
    result.push({ bindingField: "typography", field: "textStyle",
      types: FIELD_TYPES.get("typography"), value: changes.textStyle });
    for (const field of ["fontFamily", "fontSize", "fontWeight"]) {
      if (Object.hasOwn(changes.textStyle, field)) result.push({ bindingField: field,
        field: `textStyle.${field}`, types: FIELD_TYPES.get(field), value: changes.textStyle[field] });
    }
  }
  return result;
}

function hasBinding(node, bindingField) {
  const bindings = node.tokenBindings ?? {};
  if (Object.hasOwn(bindings, bindingField)) return true;
  if (bindingField.startsWith("fills.") && Object.hasOwn(bindings, "fill")) return true;
  // stroke binds the first stroke's color only.
  if (bindingField === "strokes.0" && Object.hasOwn(bindings, "stroke")) return true;
  // A text style bound field by field needs no typography Token.
  if (bindingField === "typography")
    return ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing"].some((field) => Object.hasOwn(bindings, field));
  return ["fontFamily", "fontSize", "fontWeight"].includes(bindingField) && Object.hasOwn(bindings, "typography");
}

// Layout geometry rarely maps to Tokens: width/height advice is kept only
// when a Token resolves to the value or lies near it (within 10%, at least
// 2). The rest is counted, not listed, so a screen of raw sizes does not
// bury the advice that can act.
const GEOMETRY_FIELDS = new Set(["height", "width"]);

function nearGeometryToken(value, suggestions) {
  if (typeof value !== "number") return suggestions.length > 0;
  const tolerance = Math.max(2, Math.abs(value) * 0.1);
  return suggestions.some((item) => typeof item.value === "number" &&
    Math.abs(item.value - value) <= tolerance);
}

export function designTokenAdviceForBatch(product, batch, options = {}) {
  const warnings = [];
  const suppressedFields = {};
  // Context 展开和 Effective Token 解析每批只做一次；字段只做类型和值过滤。
  const searchIndex = createSearchIndex(product, options);
  for (const [operationIndex, operation] of (batch.operations ?? []).entries()) {
    for (const { changes, node } of nodesForOperation(product, operation, options.before)) {
      for (const assignment of assignments(changes)) {
        if (hasBinding(node, assignment.bindingField)) continue;
        const searched = searchItems(product,
          { ...options, types: assignment.types, value: assignment.value }, searchIndex);
        const suggestions = searched.items.slice(0, 3);
        const exactSuggestion = suggestions.find(({ exactValue }) => exactValue);
        if (GEOMETRY_FIELDS.has(assignment.field) &&
            !nearGeometryToken(assignment.value, suggestions)) {
          suppressedFields[assignment.field] = (suppressedFields[assignment.field] ?? 0) + 1;
          continue;
        }
        warnings.push({
          code: exactSuggestion ? "design_token_not_used" : "design_token_value_unmatched",
          field: assignment.field,
          contextScope: { contexts: searched.contexts,
            mode: Object.hasOwn(options, "context") ? "explicit" : "all" },
          match: exactSuggestion ? "exact" : "none",
          message: exactSuggestion
            ? `A Design Token resolves to the hard-coded ${assignment.field} value in one or more Contexts`
            : `No Design Token resolves to the hard-coded ${assignment.field} value; confirm that the raw value is intentional`,
          nodeId: node.id, element: node.name, operationIndex,
          ...(exactSuggestion ? { recommendedBinding: { field: assignment.bindingField,
            token: exactSuggestion.token?.path ?? exactSuggestion.path,
            reference: structuredClone(exactSuggestion.reference) } } : {}),
          severity: "warning", suggestions, valueSource: "raw-unbound",
          value: structuredClone(assignment.value),
        });
      }
    }
  }
  const count = Object.values(suppressedFields).reduce((sum, value) => sum + value, 0);
  return {
    suppressed: count === 0 ? undefined : {
      count,
      fields: suppressedFields,
      reason: "Raw width/height values with no exact or near (within 10%) Token are not listed; no action is needed.",
    },
    warnings,
  };
}

export function designTokenWarningsForBatch(product, batch, options = {}) {
  return designTokenAdviceForBatch(product, batch, options).warnings;
}
