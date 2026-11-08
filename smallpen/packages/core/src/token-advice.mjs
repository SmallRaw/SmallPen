import { combineContextAxes, resolveContext } from "./contexts.mjs";
import { listEffectiveTokens } from "./effective-tokens.mjs";
import { listTokenThemes, selectTokenThemes } from "./token-themes.mjs";

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

