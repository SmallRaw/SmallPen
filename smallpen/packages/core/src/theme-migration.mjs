// Upgrade by copy (ADR 0003) from contextValues themes to Penpot token sets
// and themes. The function is pure: it returns the new entry values of each
// Package and the caller writes them to a new location.
//
// Each theme-kind Context Axis becomes a theme group named after the axis:
// set "base" holds every Token's default value under its existing id and
// name, one set per axis value holds that value's contextValues as Tokens of
// the same name, and one theme per value activates [base, value set].
import {
  isRecord,
} from "./internal.mjs";
import { hasLegacyShadowShape, normalizeShadowValue } from "./shadows.mjs";
import { packageTokenNameCollisions } from "./tokens-domain.mjs";

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

function themeAxesOf(snapshot) {
  return [...snapshot.domain.contextAxes.values()].filter(
    ({ kind }) => kind === "theme",
  );
}

// Superseded forms a Package still loads with: contextValues on theme axes
// and {x, y} shadows. `smallpen check` lists them with the upgrade, and
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
