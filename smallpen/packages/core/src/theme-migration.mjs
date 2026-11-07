// Upgrade by copy (ADR 0003) from contextValues themes to Penpot token sets
// and themes. The function is pure: it returns the new entry values of each
// Package and the caller writes them to a new location.
//
// Each theme-kind Context Axis becomes a theme group named after the axis:
// set "base" holds every Token's default value under its existing id and
// name, one set per axis value holds that value's contextValues as Tokens of
// the same name, and one theme per value activates [base, value set].
import { fail } from "./errors.mjs";
import { isRecord, isTokenName } from "./internal.mjs";
import { hasLegacyShadowShape, normalizeShadowValue } from "./shadows.mjs";
import { defaultTokenThemeIds, tokenLibraryEntry } from "./token-themes.mjs";
import { packageTokenNameCollisions } from "./tokens-domain.mjs";

function slug(value) {
  return (
    String(value)
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "theme"
  );
}

function unique(candidate, used) {
  let value = candidate;
  let suffix = 2;
  while (used.has(value)) {
    value = `${candidate}_${suffix}`;
    suffix += 1;
  }
  used.add(value);
  return value;
}

function uniqueName(candidate, used) {
  let value = candidate;
  let suffix = 2;
  while (used.has(value)) {
    value = `${candidate}-${suffix}`;
    suffix += 1;
  }
  used.add(value);
  return value;
}

// Every DTCG Token of a token file: {path, node, type, segments}.
function dtcgTokens(root) {
  const tokens = [];
  const visit = (group, segments, inheritedType) => {
    const declaredType =
      typeof group.$type === "string" ? group.$type : inheritedType;
    for (const [name, child] of Object.entries(group)) {
      if (name.startsWith("$") || !isRecord(child)) continue;
      const path = [...segments, name];
      const contextValues = child.$extensions?.smallpen?.contextValues;
      if (Object.hasOwn(child, "$value") || Array.isArray(contextValues)) {
        tokens.push({
          node: child,
          path: path.join("."),
          segments: path,
          type: typeof child.$type === "string" ? child.$type : declaredType,
        });
      } else {
        visit(child, path, declaredType);
      }
    }
  };
  visit(root, [], undefined);
  return tokens;
}

// Removes a Token from its DTCG tree and prunes groups it leaves empty.
function removeDtcgToken(root, segments) {
  const parents = [root];
  for (const segment of segments.slice(0, -1)) parents.push(parents.at(-1)[segment]);
  delete parents.at(-1)[segments.at(-1)];
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const group = parents[index + 1];
    if (Object.keys(group).some((key) => !key.startsWith("$"))) break;
    delete parents[index][segments[index]];
  }
}

function normalizeShadowTokens(value, counter) {
  if (Array.isArray(value)) {
    for (const child of value) normalizeShadowTokens(child, counter);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "shadow" && hasLegacyShadowShape(child)) {
      value[key] = normalizeShadowValue(child);
      counter.count += 1;
    } else {
      normalizeShadowTokens(child, counter);
    }
  }
}

function shadowValue(type, value, counter) {
  if (type !== "shadow" || !hasLegacyShadowShape(value)) return value;
  counter.count += 1;
  return normalizeShadowValue(value);
}

// Removes the empty themes of a library that sit in a migrated group (the
// seeded Theme/Default) together with the empty sets only they used, so
// Penpot's theme dialog shows no stray row in that group. Returns the removed
// themes and sets.
function removeEmptyGroupThemes(library, groups) {
  const setsById = new Map(library.sets.map((set) => [set.id, set]));
  const removedThemes = library.themes.filter(
    (theme) =>
      groups.has(theme.group) &&
      theme.setIds.every((id) => (setsById.get(id)?.tokens.length ?? 0) === 0),
  );
  library.themes = library.themes.filter((theme) => !removedThemes.includes(theme));
  const stillUsed = new Set(library.themes.flatMap(({ setIds }) => setIds));
  const removedSets = library.sets.filter(
    (set) =>
      set.tokens.length === 0 &&
      !stillUsed.has(set.id) &&
      removedThemes.some(({ setIds }) => setIds.includes(set.id)),
  );
  library.sets = library.sets.filter((set) => !removedSets.includes(set));
  library.activeThemeIds = library.activeThemeIds.filter((id) =>
    library.themes.some((theme) => theme.id === id),
  );
  library.activeSetIds = library.activeSetIds.filter((id) =>
    library.sets.some((set) => set.id === id),
  );
  return { removedSets, removedThemes };
}

function themeAxesOf(snapshot) {
  return [...snapshot.domain.contextAxes.values()].filter(
    ({ kind }) => kind === "theme",
  );
}

// Converts one Package that owns theme axes. Returns its new entries, the
// themes it created and warnings.
function migrateOwner(snapshot, warnings, shadowCounter) {
  const entries = structuredClone(snapshot.entries);
  const manifest = structuredClone(snapshot.manifest);
  const axes = themeAxesOf(snapshot);
  const axisIds = new Set(axes.map(({ id }) => id));
  const libraryEntry = tokenLibraryEntry(snapshot);
  const existing = libraryEntry
    ? entries[libraryEntry]
    : { activeSetIds: [], activeThemeIds: [], id: `tlib_${slug(manifest.packageId.replace(/^pkg_/, ""))}`, sets: [], themes: [] };
  for (const set of existing.sets) {
    for (const token of set.tokens) {
      token.value = shadowValue(token.type, token.value, shadowCounter);
    }
  }
  const usedSetIds = new Set(existing.sets.map(({ id }) => id));
  const usedSetNames = new Set(existing.sets.map(({ name }) => name));
  const usedThemeIds = new Set(existing.themes.map(({ id }) => id));
  const usedTokenIds = new Set([...snapshot.domain.tokens.keys()]);
  const baseSet = {
    description: "Default values (migrated from the Token $value)",
    id: unique("tset_base", usedSetIds),
    name: uniqueName("base", usedSetNames),
    tokens: [],
  };
  const valueSets = new Map();
  const themes = [];
  for (const axis of axes) {
    const group = slug(axis.name);
    for (const value of axis.values) {
      const set = {
        description: `${axis.name} ${value.name} (migrated from contextValues on ${axis.id})`,
        id: unique(`tset_${group}_${slug(value.id)}`, usedSetIds),
        name: uniqueName(`${group}/${slug(value.id)}`, usedSetNames),
        tokens: [],
      };
      valueSets.set(`${axis.id}\0${value.id}`, set);
      themes.push({
        axisId: axis.id,
        default: value.id === axis.defaultValue,
        theme: {
          description: "",
          externalId: "",
          group: axis.name,
          id: unique(`theme_${group}_${slug(value.id)}`, usedThemeIds),
          isSource: false,
          name: value.name,
          setIds: [baseSet.id, set.id],
        },
        valueId: value.id,
      });
    }
  }
  const keptAxes = new Set();
  const migratedTokens = [];
  const dtcgEntries = manifest.entries.tokens.filter(
    (entry) => entry !== libraryEntry,
  );
  for (const entry of dtcgEntries) {
    const root = entries[entry];
    for (const token of dtcgTokens(root)) {
      const smallpen = token.node.$extensions?.smallpen ?? {};
      const rules = Array.isArray(smallpen.contextValues)
        ? smallpen.contextValues
        : [];
      const themeRule = (rule) =>
        isRecord(rule?.when) &&
        Object.keys(rule.when).length === 1 &&
        axisIds.has(Object.keys(rule.when)[0]);
      const blocked = rules.filter((rule) => !themeRule(rule));
      const reasons = [];
      if (smallpen.overrideOf) reasons.push("it overrides another Package's Token (overrideOf)");
      if (!Object.hasOwn(token.node, "$value")) reasons.push("it has no base $value");
      if (!isTokenName(token.path)) reasons.push("its path is not a token-set name");
      if (blocked.length > 0) {
        reasons.push(
          "a contextValues rule names a non-theme axis or more than one axis",
        );
      }
      if (reasons.length > 0) {
        if (rules.length > 0 || smallpen.overrideOf) {
          for (const rule of rules) {
            for (const axisId of Object.keys(rule?.when ?? {})) {
              if (axisIds.has(axisId)) keptAxes.add(axisId);
            }
          }
          warnings.push({
            code: "context_values_not_migrated",
            message:
              `${token.path} stays a DTCG Token with its contextValues: ` +
              `${reasons.join("; ")}.`,
            path: `${entry}:${token.path}`,
            rules: structuredClone(blocked.length > 0 ? blocked : rules),
            tokenId: smallpen.id,
          });
        }
        if (token.type === "shadow") {
          if (Object.hasOwn(token.node, "$value")) {
            token.node.$value = shadowValue("shadow", token.node.$value, shadowCounter);
          }
          for (const rule of rules) {
            if (isRecord(rule)) rule.value = shadowValue("shadow", rule.value, shadowCounter);
          }
        }
        continue;
      }
      const dropped = ["deprecated", "draft", "replacement"].filter(
        (field) => smallpen[field] !== undefined && smallpen[field] !== false,
      );
      if (smallpen.visibility === "private") dropped.push("visibility private");
      if (dropped.length > 0) {
        warnings.push({
          code: "token_metadata_dropped",
          message: `${token.path}: token sets have no ${dropped.join(", ")}; the Token is public and current after migration`,
          tokenId: smallpen.id,
        });
      }
      baseSet.tokens.push({
        description:
          typeof token.node.$description === "string" ? token.node.$description : "",
        id: smallpen.id,
        name: token.path,
        type: token.type,
        value: shadowValue(token.type, structuredClone(token.node.$value), shadowCounter),
      });
      for (const rule of rules) {
        const [[axisId, valueId]] = Object.entries(rule.when);
        const set = valueSets.get(`${axisId}\0${valueId}`);
        if (!set) {
          fail(
            "invalid_token_context_rule",
            `${token.path} names an unknown value ${valueId} of ${axisId}`,
            { path: `${entry}:${token.path}`, tokenId: smallpen.id },
          );
        }
        set.tokens.push({
          description: "",
          id: unique(`${smallpen.id}__${slug(valueId)}`, usedTokenIds),
          name: token.path,
          type: token.type,
          value: shadowValue(token.type, structuredClone(rule.value), shadowCounter),
        });
      }
      migratedTokens.push({ entry, segments: token.segments });
    }
  }
  for (const { entry, segments } of migratedTokens) {
    removeDtcgToken(entries[entry], segments);
  }
  const deletedEntries = [];
  for (const entry of dtcgEntries) {
    if (Object.keys(entries[entry]).every((key) => key.startsWith("$"))) {
      delete entries[entry];
      manifest.entries.tokens = manifest.entries.tokens.filter(
        (candidate) => candidate !== entry,
      );
      deletedEntries.push(entry);
    }
  }
  // Empty themes (and their empty sets) of the existing library in a group a
  // migrated axis takes over would compete with the new themes; they go.
  const { removedSets, removedThemes } = removeEmptyGroupThemes(
    existing,
    new Set(axes.map(({ name }) => name)),
  );
  for (const theme of removedThemes) {
    warnings.push({
      code: "empty_theme_removed",
      message: `Removed the empty theme ${theme.group}/${theme.name}: the migrated ${theme.group} themes replace it`,
      themeId: theme.id,
    });
  }
  for (const set of removedSets) {
    warnings.push({
      code: "empty_set_removed",
      message: `Removed the empty token set ${set.name} that only a removed theme used`,
      setId: set.id,
    });
  }
  const library = {
    activeSetIds: [baseSet.id, ...existing.activeSetIds],
    defaultSetIds: [baseSet.id, ...(existing.defaultSetIds ?? existing.sets.map(({ id }) => id)).filter((id) => existing.sets.some((set) => set.id === id))],
    defaultThemeIds: [...themes.filter((entry) => entry.default).map(({ theme }) => theme.id), ...defaultTokenThemeIds(existing)],
    activeThemeIds: [
      ...themes.filter((entry) => entry.default).map(({ theme }) => theme.id),
      ...existing.activeThemeIds,
    ],
    id: existing.id,
    sets: [baseSet, ...valueSets.values(), ...existing.sets],
    themes: [...themes.map(({ theme }) => theme), ...existing.themes],
  };
  let targetEntry = libraryEntry;
  if (!targetEntry) {
    targetEntry = ["tokens/tokens.json", "tokens/themes.json"].find(
      (candidate) => !Object.hasOwn(entries, candidate),
    ) ?? `tokens/themes-${slug(manifest.packageId)}.json`;
    manifest.entries.tokens.push(targetEntry);
  }
  entries[targetEntry] = library;
  const migratedAxes = axes.filter(({ id }) => !keptAxes.has(id));
  for (const axisId of keptAxes) {
    warnings.push({
      code: "theme_axis_kept",
      message: `Context Axis ${axes.find(({ id }) => id === axisId)?.name ?? axisId} stays because Tokens that were not migrated still name it; its themes exist as token themes too`,
      axisId,
    });
  }
  removeContextAxes(manifest, entries, new Set(migratedAxes.map(({ id }) => id)));
  return {
    deletedEntries,
    entries,
    manifest,
    migratedAxisIds: new Set(migratedAxes.map(({ id }) => id)),
    themes,
  };
}

function removeContextAxes(manifest, entries, axisIds) {
  for (const entry of manifest.entries.contexts) {
    const file = entries[entry];
    file.axes = file.axes.filter(({ id }) => !axisIds.has(id));
    for (const profile of file.profiles) {
      for (const axisId of axisIds) delete profile.values[axisId];
    }
  }
}

// Scenario contexts on migrated axes become Scenario themes.
function migrateScenarios(manifest, entries, themes, migratedAxisIds) {
  for (const entry of manifest.entries.scenarios) {
    for (const scenario of entries[entry].scenarios) {
      const selected = [];
      for (const axisId of migratedAxisIds) {
        const valueId = scenario.context[axisId];
        const theme =
          themes.find((candidate) => candidate.axisId === axisId && candidate.valueId === valueId) ??
          themes.find((candidate) => candidate.axisId === axisId && candidate.default);
        delete scenario.context[axisId];
        if (theme) selected.push(`${theme.theme.group}/${theme.theme.name}`);
      }
      if (selected.length > 0) {
        scenario.themes = [...new Set([...(scenario.themes ?? []), ...selected])];
      }
    }
  }
}

function normalizeDesignShadows(manifest, entries, counter) {
  for (const entry of [...manifest.entries.screens, ...manifest.entries.components]) {
    normalizeShadowTokens(entries[entry], counter);
  }
}

// workspace: {product, foundation?}. product is the Package the caller
// named (a single Package, or the Product of a pair).
export function migrateTokenThemes({ foundation, product }) {
  const warnings = [];
  const shadowCounter = { count: 0 };
  const pair = Boolean(foundation) && foundation !== product;
  const owner = pair ? foundation : product;
  if (themeAxesOf(owner).length === 0 && (!pair || themeAxesOf(product).length === 0)) {
    fail(
      "no_theme_axes",
      "Nothing to migrate: the Package declares no theme-kind Context Axis. Its themes, if any, are already token sets and themes",
      { packageId: owner.manifest.packageId },
    );
  }
  if (pair && themeAxesOf(product).length > 0) {
    fail(
      "unsupported_theme_migration",
      "The Product declares its own theme axes; migrate them by hand (Product themes would compete with the Foundation's)",
      { axisIds: themeAxesOf(product).map(({ id }) => id) },
    );
  }
  const migrated = migrateOwner(owner, warnings, shadowCounter);
  const packages = [];
  if (pair) {
    normalizeDesignShadows(migrated.manifest, migrated.entries, shadowCounter);
    packages.push({ role: "foundation", snapshot: foundation, ...migrated });
    const manifest = structuredClone(product.manifest);
    const entries = structuredClone(product.entries);
    manifest.dependencies = manifest.dependencies.map((dependency) =>
      dependency.packageId === foundation.manifest.packageId
        ? {
            ...dependency,
            activeThemeIds: migrated.themes
              .filter((entry) => entry.default)
              .map(({ theme }) => theme.id),
          }
        : dependency,
    );
    // The Product's own empty themes in a migrated group would compete with
    // the Foundation's in Penpot's shared group namespace.
    const libraryEntry = tokenLibraryEntry(product);
    const deletedEntries = [];
    if (libraryEntry) {
      const { removedSets, removedThemes } = removeEmptyGroupThemes(
        entries[libraryEntry],
        new Set(migrated.themes.map(({ theme }) => theme.group)),
      );
      for (const theme of removedThemes) {
        warnings.push({
          code: "empty_theme_removed",
          message: `Removed the Product's empty theme ${theme.group}/${theme.name}: the Foundation's ${theme.group} themes replace it`,
          packageId: product.manifest.packageId,
          themeId: theme.id,
        });
      }
      for (const set of removedSets) {
        warnings.push({
          code: "empty_set_removed",
          message: `Removed the Product's empty token set ${set.name} that only a removed theme used`,
          packageId: product.manifest.packageId,
          setId: set.id,
        });
      }
    }
    for (const token of product.domain.tokens.values()) {
      if (token.contextValues.some(({ when }) =>
        Object.keys(when).some((axisId) => migrated.migratedAxisIds.has(axisId)))) {
        warnings.push({
          code: "context_values_not_migrated",
          message: `Product Token ${token.path} keeps contextValues on a migrated Foundation axis; they no longer apply. Move them to a Product token set`,
          tokenId: token.id,
        });
      }
    }
    migrateScenarios(manifest, entries, migrated.themes, migrated.migratedAxisIds);
    normalizeDesignShadows(manifest, entries, shadowCounter);
    packages.push({
      deletedEntries,
      entries,
      manifest,
      role: "product",
      snapshot: product,
    });
  } else {
    migrateScenarios(
      migrated.manifest,
      migrated.entries,
      migrated.themes,
      migrated.migratedAxisIds,
    );
    normalizeDesignShadows(migrated.manifest, migrated.entries, shadowCounter);
    packages.push({ role: "package", snapshot: product, ...migrated });
  }
  if (shadowCounter.count > 0) {
    warnings.push({
      code: "legacy_shadows_normalized",
      count: shadowCounter.count,
      message: `Rewrote ${shadowCounter.count} shadow value(s) from {x, y} to {offsetX, offsetY}`,
    });
  }
  return {
    packages: packages.map(({ deletedEntries, entries, manifest, role, snapshot }) => ({
      deletedEntries,
      entries,
      manifest,
      packageId: snapshot.manifest.packageId,
      role,
    })),
    themes: migrated.themes.map(({ axisId, default: active, theme, valueId }) => ({
      active,
      axisId,
      path: `${theme.group}/${theme.name}`,
      setIds: [...theme.setIds],
      themeId: theme.id,
      valueId,
    })),
    warnings,
  };
}

// Superseded forms a Package still loads with: contextValues on theme axes
// and {x, y} shadows. `smallpen validate` lists them with the upgrade, and
// Token names that are both a Token and a group (writes reject new ones).
export function packageFormatWarnings(snapshot) {
  const warnings = [];
  const axisIds = new Set(themeAxesOf(snapshot).map(({ id }) => id));
  const themed = [...snapshot.domain.tokens.values()].filter(({ contextValues }) =>
    contextValues.some(({ when }) => Object.keys(when).some((axisId) => axisIds.has(axisId))),
  );
  const upgrade = {
    argv: ["migrate-themes", snapshot.locator, "--output", "<new path>", "--json"],
    operation: "smallpen.migrate-themes",
  };
  if (themed.length > 0) {
    warnings.push({
      code: "context_values_deprecated",
      message:
        `${themed.length} Token(s) of ${snapshot.manifest.name ?? "this package"} give theme values with contextValues on ` +
        `${themeAxesOf(snapshot).filter(({ id }) => axisIds.has(id)).map(({ id, name }) => name ?? id).join(", ")}. They resolve with --context but Penpot's token manager does not show ` +
        "them; migrate-themes converts them to token sets and themes by copy.",
      nextOperations: [upgrade],
      packageId: snapshot.manifest.packageId,
      tokenIds: themed.map(({ id }) => id),
    });
  }
  const counter = { count: 0 };
  const entries = structuredClone(snapshot.entries);
  for (const entry of [...snapshot.manifest.entries.screens, ...snapshot.manifest.entries.components]) {
    normalizeShadowTokens(entries[entry], counter);
  }
  for (const token of snapshot.domain.tokens.values()) {
    if (token.type !== "shadow") continue;
    for (const value of [token.rawValue, ...token.contextValues.map(({ value: candidate }) => candidate)]) {
      if (hasLegacyShadowShape(value)) counter.count += 1;
    }
  }
  if (counter.count > 0) {
    warnings.push({
      code: "legacy_shadow_shape",
      count: counter.count,
      message:
        `${counter.count} shadow value(s) of ${snapshot.manifest.packageId} use {x, y}; reads treat them as ` +
        "{offsetX, offsetY}, writes need offsetX/offsetY. migrate-themes rewrites them by copy.",
      nextOperations: [upgrade],
      packageId: snapshot.manifest.packageId,
    });
  }
  const label = ({ filePath, id, name, set }) =>
    `${name} (${id ?? "no id"}${set ? `, set ${set}` : `, ${filePath}`})`;
  for (const { group, token } of packageTokenNameCollisions(snapshot.manifest, snapshot.entries)) {
    warnings.push({
      code: "token_name_collision",
      message:
        `Token ${label(token)} sits inside Token ${label(group)} of ${snapshot.manifest.packageId}: a name is ` +
        "either a Token or a group of Tokens, never both (as in Penpot), so the inner Token does not resolve " +
        `where both are active. Rename one, for example ${token.name.slice(0, group.name.length)}-` +
        `${token.name.slice(group.name.length + 1).replaceAll(".", "-")} or ${group.name}.default.`,
      packageId: snapshot.manifest.packageId,
      tokenIds: [group.id, token.id].filter(Boolean),
      tokens: [group.name, token.name],
    });
  }
  return warnings;
}
