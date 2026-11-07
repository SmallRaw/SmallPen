// Token themes are Penpot token sets + themes ("Form A"): one library per
// Package with sets, themes {group, name, setIds} and the active selection.
// A Product of a Foundation + Product pair keeps its own selection of the
// Foundation's themes on its dependency (dependencies[0].activeThemeIds);
// see docs/TOKEN-THEMES.md for the contract.
import { fail } from "./errors.mjs";

export function tokenLibraryEntry(snapshot) {
  return snapshot?.manifest.entries.tokens.find((entry) => {
    const value = snapshot.entries[entry];
    return Array.isArray(value?.sets) && Array.isArray(value?.themes);
  });
}

export function tokenLibraryOf(snapshot) {
  const entry = tokenLibraryEntry(snapshot);
  return entry ? snapshot.entries[entry] : undefined;
}

// Project defaults are independent of the editor's active selection. Older
// libraries use the real Default option, or the first option in library order.
// Never infer a default from activeThemeIds: those are mutable editor state.
export function defaultTokenThemeIds(library) {
  if (!library) return [];
  const groups = new Map();
  for (const theme of library.themes) {
    if (!groups.has(theme.group)) groups.set(theme.group, []);
    groups.get(theme.group).push(theme);
  }
  return [...groups.values()].map((themes) => (
    themes.find(({ id }) => library.defaultThemeIds?.includes(id)) ??
    themes.find(({ name }) => name === "Default") ?? themes[0]
  ).id);
}

export function defaultTokenWorkspace({ product, foundation }) {
  let view = product;
  const library = tokenLibraryOf(product);
  if (library) view = withLibrary(view, defaultTokenThemeIds(library), library.defaultSetIds ?? library.sets.map(({ id }) => id));
  let foundationView = foundation;
  const foundationLibrary = tokenLibraryOf(foundation);
  if (foundationLibrary && foundation !== product) foundationView = withLibrary(foundation, defaultTokenThemeIds(foundationLibrary), foundationLibrary.defaultSetIds ?? foundationLibrary.sets.map(({ id }) => id));
  const dependency = foundationDependency(product, foundation);
  if (dependency && tokenLibraryOf(foundation)) {
    view = { ...view, manifest: { ...view.manifest,
      dependencies: view.manifest.dependencies.map((candidate) =>
        candidate.packageId === dependency.packageId
          ? { ...candidate, activeThemeIds: defaultTokenThemeIds(tokenLibraryOf(foundation)) }
          : candidate),
    } };
  }
  return { product: view, foundation: foundation === product ? view : foundationView };
}

export function themePath(theme) {
  return `${theme.group}/${theme.name}`;
}

function foundationDependency(product, foundation) {
  if (!foundation || product === foundation) return undefined;
  return product.manifest.dependencies?.find(
    ({ packageId }) => packageId === foundation.manifest.packageId,
  );
}

// The Foundation theme ids a Product selects: its own stored selection, or
// the Foundation library's active themes when it stores none.
export function productFoundationThemeIds(product, foundation) {
  const library = tokenLibraryOf(foundation);
  if (!library) return [];
  const dependency = foundationDependency(product, foundation);
  return [...(dependency?.activeThemeIds ?? library.activeThemeIds)];
}

function themeRows(snapshot, owner, activeIds) {
  const library = tokenLibraryOf(snapshot);
  if (!library) return [];
  const setNames = new Map(library.sets.map(({ id, name }) => [id, name]));
  return library.themes.map((theme) => ({
    active: activeIds.includes(theme.id),
    group: theme.group,
    id: theme.id,
    name: theme.name,
    owner,
    packageId: snapshot.manifest.packageId,
    path: themePath(theme),
    setIds: [...theme.setIds],
    sets: theme.setIds.map((id) => setNames.get(id)),
  }));
}

// Every theme a read of `product` can select: the Product's own, then its
// Foundation's (with the Product's selection of them).
export function listTokenThemes(product, foundation) {
  const own = tokenLibraryOf(product);
  return [
    ...themeRows(product, "package", own?.activeThemeIds ?? []),
    ...(foundationDependency(product, foundation)
      ? themeRows(
          foundation,
          "foundation",
          productFoundationThemeIds(product, foundation),
        )
      : []),
  ];
}

function invalidThemeArgument(value, valid) {
  fail(
    "invalid_theme_argument",
    `--theme requires GROUP/NAME, for example Theme/Dark; got ${JSON.stringify(value)}. ` +
      `Themes: ${valid.join(", ") || "(none)"}`,
    { validThemes: valid, value },
  );
}

// Resolves theme paths ("Group/Name") against the themes a read can select.
// Each group may be named once, as Penpot activates one theme per group.
export function resolveThemeSelection(product, foundation, themePaths) {
  const themes = listTokenThemes(product, foundation);
  const valid = [...new Set(themes.map(({ path }) => path))];
  const groups = [...new Set(themes.map(({ group }) => group))];
  const selected = [];
  const seenGroups = new Map();
  for (const value of themePaths) {
    if (typeof value !== "string" || !value.includes("/")) {
      invalidThemeArgument(value, valid);
    }
    const matches = themes.filter(({ path }) => path === value);
    if (matches.length === 0) {
      const group = value.slice(0, value.lastIndexOf("/"));
      const known = groups.includes(group);
      fail(
        "unknown_token_theme",
        known
          ? `Token theme group ${group} has no theme ${value.slice(value.lastIndexOf("/") + 1)}. ` +
              `Themes in ${group}: ${themes.filter((theme) => theme.group === group).map(({ path }) => path).join(", ")}`
          : `Unknown token theme ${value}. ` +
              (valid.length > 0
                ? `Themes: ${valid.join(", ")}`
                : "This Package has no token themes; create them with put-token-set and put-token-theme (smallpen schema theme)"),
        {
          ...(known ? { group } : { validGroups: groups }),
          theme: value,
          validThemes: valid,
        },
      );
    }
    if (matches.length > 1) {
      fail(
        "ambiguous_token_theme",
        `Token theme ${value} exists in the Product and in its Foundation; rename one of them`,
        { packageIds: matches.map(({ packageId }) => packageId), theme: value },
      );
    }
    const [theme] = matches;
    if (seenGroups.has(theme.group)) {
      fail(
        "duplicate_token_theme_group",
        `--theme names group ${theme.group} twice (${seenGroups.get(theme.group)} and ${value}); ` +
          "one theme per group is active, as in Penpot",
        { group: theme.group, themes: [seenGroups.get(theme.group), value] },
      );
    }
    seenGroups.set(theme.group, value);
    selected.push(theme);
  }
  return selected;
}

function withLibrary(snapshot, activeThemeIds, activeSetIds) {
  const entry = tokenLibraryEntry(snapshot);
  return {
    ...snapshot,
    entries: {
      ...snapshot.entries,
      [entry]: { ...snapshot.entries[entry], activeThemeIds, ...(activeSetIds ? { activeSetIds } : {}) },
    },
  };
}

function nextActiveIds(current, themes, groups, owner) {
  const byId = new Map(themes.map((theme) => [theme.id, theme]));
  return [
    ...current.filter((id) => !groups.has(byId.get(id)?.group)),
    ...themes
      .filter((theme) => theme.owner === owner && theme.selected)
      .map(({ id }) => id),
  ];
}

// A read-only view of the workspace with the given themes active, one per
// group: other themes of those groups turn off, in the Package and in its
// Foundation alike (they share Penpot's group namespace). Nothing is
// written; the stored selection stays as it is.
export function selectTokenThemes({ foundation, product }, themePaths) {
  if (!themePaths || themePaths.length === 0) return { foundation, product };
  const chosen = resolveThemeSelection(product, foundation, themePaths);
  const chosenKeys = new Set(chosen.map(({ id, owner }) => `${owner}\0${id}`));
  const themes = listTokenThemes(product, foundation).map((theme) => ({
    ...theme,
    selected: chosenKeys.has(`${theme.owner}\0${theme.id}`),
  }));
  const groups = new Set(chosen.map(({ group }) => group));
  let view = product;
  const own = tokenLibraryOf(product);
  if (own) {
    view = withLibrary(
      view,
      nextActiveIds(
        own.activeThemeIds,
        themes.filter(({ owner }) => owner === "package"),
        groups,
        "package",
      ),
    );
  }
  const dependency = foundationDependency(product, foundation);
  if (dependency && tokenLibraryOf(foundation)) {
    const activeThemeIds = nextActiveIds(
      productFoundationThemeIds(product, foundation),
      themes.filter(({ owner }) => owner === "foundation"),
      groups,
      "foundation",
    );
    view = {
      ...view,
      manifest: {
        ...view.manifest,
        dependencies: view.manifest.dependencies.map((candidate) =>
          candidate === dependency ? { ...candidate, activeThemeIds } : candidate,
        ),
      },
    };
  }
  return { foundation, product: view };
}

const FOUNDATION_VIEWS = new WeakMap();

// The Foundation as a Product reads it: the Product's theme selection
// replaces the Foundation library's own, and the Product's active Form A
// tokens sit on top by name (productOverlay). Memoized so the per-snapshot
// caches of one read see one object.
export function foundationTokenView(product, foundation) {
  if (!foundation || product === foundation) return foundation;
  if (!foundationDependency(product, foundation)) return foundation;
  let byFoundation = FOUNDATION_VIEWS.get(product);
  if (!byFoundation) {
    byFoundation = new WeakMap();
    FOUNDATION_VIEWS.set(product, byFoundation);
  }
  if (byFoundation.has(foundation)) return byFoundation.get(foundation);
  const library = tokenLibraryOf(foundation);
  const view = {
    ...(library
      ? withLibrary(foundation, productFoundationThemeIds(product, foundation))
      : foundation),
    productOverlay: tokenLibraryOf(product) ? product : undefined,
  };
  byFoundation.set(foundation, view);
  return view;
}

// Set ids active in a library: the sets of its active themes, or its
// activeSetIds when no theme is active (Penpot's hidden theme).
export function activeTokenSetIds(library) {
  return new Set(
    library.activeThemeIds.length > 0
      ? library.themes
          .filter(({ id }) => library.activeThemeIds.includes(id))
          .flatMap(({ setIds }) => setIds)
      : library.activeSetIds,
  );
}

// Writes that still work but use a superseded form. Themes are token sets +
// themes; a contextValues theme is not visible in Penpot's token manager.
export function formatWarningsForBatch(batch) {
  const warnings = [];
  for (const [operationIndex, operation] of (batch?.operations ?? []).entries()) {
    const themeAxes =
      operation?.type === "put-context-file" && Array.isArray(operation.contextFile?.axes)
        ? operation.contextFile.axes.filter((axis) => axis?.kind === "theme")
        : [];
    if (themeAxes.length > 0) {
      warnings.push({
        code: "theme_context_axis_deprecated",
        message:
          `put-context-file declares the theme-kind Context Axis ${themeAxes.map(({ id }) => id).join(", ")}. ` +
          "Themes are token sets and themes (put-token-set, put-token-theme; smallpen schema theme); " +
          "Context Axes are for viewport, density, locale and other non-token choices. The write was accepted.",
        nextOperations: [{ args: ["schema", "theme"], operation: "smallpen.schema" }],
        operationIndex,
        severity: "warning",
      });
    }
    const contextValues =
      operation?.type === "put-token"
        ? operation.definition?.$extensions?.smallpen?.contextValues
        : undefined;
    if (!Array.isArray(contextValues) || contextValues.length === 0) continue;
    warnings.push({
      code: "context_values_deprecated",
      message:
        `put-token ${operation.tokenId} uses $extensions.smallpen.contextValues, which are deprecated for ` +
        "themes and do not show in Penpot's token manager. Put the base value in a token set and each " +
        "theme's value in a theme set with the same token name (put-set-token), and activate them with " +
        "put-token-theme / set-active-token-themes. See: smallpen schema theme. The write was accepted.",
      nextOperations: [
        { args: ["schema", "theme"], operation: "smallpen.schema" },
      ],
      operationIndex,
      severity: "warning",
      tokenId: operation.tokenId,
    });
  }
  return warnings;
}

// The token sets a Design System combination observes, as
// `${packageId}\0${setId}` keys. A selection is {themeId, packageId?}; a
// Product's selections may name its Foundation's themes.
export function combinationSetKeys(product, foundation, combination = []) {
  const themes = listTokenThemes(product, foundation);
  const keys = new Set();
  for (const selection of combination ?? []) {
    const theme = themes.find(
      ({ id, packageId }) =>
        id === selection?.themeId &&
        (selection.packageId === undefined || packageId === selection.packageId),
    );
    for (const setId of theme?.setIds ?? []) keys.add(`${theme.packageId}\0${setId}`);
  }
  return keys;
}
