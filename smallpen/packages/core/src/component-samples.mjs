import { sha256Hex, stableRuntimeUuid } from "./canonical.mjs";
import { projectComponentVariant } from "./design-projection.mjs";
import { resolveEffectiveToken } from "./effective-tokens.mjs";

// A view changes resolution, never the canonical active themes or node tree.
export function componentCombinationSnapshot(snapshot, combination) {
  if (!combination) return snapshot;
  const entries = { ...snapshot.entries };
  for (const path of snapshot.manifest.entries.tokens) {
    const library = entries[path];
    if (!Array.isArray(library?.sets)) continue;
    const themed = new Set(library.themes.flatMap((theme) => theme.setIds));
    entries[path] = {
      ...library,
      activeThemeIds: [],
      activeSetIds: [...new Set([
        ...library.activeSetIds.filter((id) => !themed.has(id)),
        ...combination.setIds,
      ])],
    };
  }
  return { ...snapshot, entries };
}

// Samples depend only on these inputs, so a commit that leaves them alone
// (a screen edit, a rename elsewhere) reuses the previous samples instead
// of projecting every variant in every combination again.
const SAMPLE_CACHE_LIMIT = 4;
const sampleCache = new Map();

async function sampleInputKey(snapshot, families, combinations) {
  const { entries, manifest } = snapshot;
  return sha256Hex(JSON.stringify([
    manifest.packageId,
    ...["components", "contexts", "tokens"].flatMap((kind) =>
      (manifest.entries[kind] ?? []).map((path) => [path, entries[path]])),
    families,
    combinations,
  ]));
}

function bindingSource(resolved) {
  return resolved ? {
    tokenId: resolved.sourceTokenId, ownerPackageId: resolved.sourcePackageId,
    path: resolved.token.path, value: resolved.value,
    alias: typeof resolved.token.rawValue === "string" && /^\{[^{}]+\}$/.test(resolved.token.rawValue),
    contextual: (resolved.token.contextValues?.length ?? 0) > 0,
  } : { missing: true };
}

// The same samples are shared by every runtime built from equal inputs:
// callers read them and never mutate them.
export async function createComponentSamples(snapshot, families, combinations) {
  const variantFamilies = families.filter((item) => item.kind === "variant");
  const key = await sampleInputKey(snapshot, variantFamilies, combinations);
  let result = sampleCache.get(key);
  if (result) {
    sampleCache.delete(key);
  } else {
    result = await buildComponentSamples(snapshot, variantFamilies, combinations);
  }
  sampleCache.set(key, result);
  while (sampleCache.size > SAMPLE_CACHE_LIMIT) {
    sampleCache.delete(sampleCache.keys().next().value);
  }
  return { samples: [...result.samples], reverse: result.reverse };
}

async function buildComponentSamples(snapshot, families, combinations) {
  const samples = [];
  const reverse = {};
  const views = new Map();
  const viewOf = (combination) => {
    if (!views.has(combination)) {
      views.set(combination, componentCombinationSnapshot(snapshot, combination));
    }
    return views.get(combination);
  };
  const resolutions = new Map();
  const bindingOf = (view, reference) => {
    if (!resolutions.has(view)) resolutions.set(view, new Map());
    const cache = resolutions.get(view);
    const id = `${reference?.packageId}\0${reference?.assetId}`;
    if (!cache.has(id)) cache.set(id, bindingSource(resolveEffectiveToken(view, reference)));
    return cache.get(id);
  };
  // A combination in which every Token bound in a set resolves as in the
  // canonical active themes draws that set as the canonical projection
  // does. When that holds for every combination, the set gets one sample
  // per variant for all themes instead of one per combination.
  const canonicalProjections = (set) => {
    const projected = new Map();
    const same = new Set(combinations);
    try {
      for (const variant of set.variants) {
        const nodes = projectComponentVariant(snapshot, variant);
        projected.set(variant.id, nodes);
        for (const node of Object.values(nodes)) {
          for (const reference of Object.values(node.tokenBindings ?? {})) {
            const canonical = JSON.stringify(bindingOf(snapshot, reference));
            for (const combination of same) {
              if (JSON.stringify(bindingOf(viewOf(combination), reference)) !== canonical) {
                same.delete(combination);
              }
            }
          }
        }
      }
    } catch {
      return null;
    }
    return { all: combinations.length > 1 && same.size === combinations.length, projected, same };
  };
  const canonical = new Map();
  for (const setId of new Set(families.map((family) => family.componentSetId))) {
    canonical.set(setId, canonicalProjections(snapshot.domain.componentSets.get(setId)));
  }
  for (const family of families) {
    const set = snapshot.domain.componentSets.get(family.componentSetId);
    const variant = set.variants.find((item) => item.id === family.variantId);
    const occurrences = Object.values(variant.nodes).filter((node) => node.instance);
    const projections = canonical.get(set.id);
    const sharedNodes = projections?.all ? projections.projected.get(variant.id) : undefined;
    for (const combination of sharedNodes ? [null] : combinations.length ? combinations : [null]) {
      const key = `${set.id}\0${variant.id}\0${sharedNodes ? "all" : combination?.id ?? "default"}`;
      const sample = {
        ...family, key, familyName: set.name, axes: set.axes,
        selection: variant.selection,
        classification: set.variants.some((item) => Object.values(item.nodes).some((node) => node.instance)) ? "Composite" : "Primitive",
        combinationId: combination?.id ?? null,
        combinationIndex: combination ? combinations.indexOf(combination) : 0,
        combinationLabel: sharedNodes ? null : combination?.label ?? "Default",
        ...(sharedNodes ? { allCombinations: true } : {}),
        caption: await stableRuntimeUuid(snapshot.manifest.packageId, "component-sample-caption", key),
        runtimeNodes: {}, sources: {},
      };
      reverse[sample.caption] = { kind: "label" };
      try {
        const view = viewOf(combination);
        sample.nodes = projections && (!combination || projections.same.has(combination))
          ? projections.projected.get(variant.id)
          : projectComponentVariant(view, variant);
        const nodeIds = Object.keys(sample.nodes);
        const runtimeIds = await Promise.all(nodeIds.map((nodeId) =>
          stableRuntimeUuid(snapshot.manifest.packageId, "component-sample-node", `${key}\0${nodeId}`)));
        for (const [index, nodeId] of nodeIds.entries()) {
          const node = sample.nodes[nodeId];
          const runtimeId = runtimeIds[index];
          // Longest exact occurrence prefix, never labels or array indices.
          const occurrence = occurrences.filter((item) => nodeId === item.id || nodeId.startsWith(`${item.id}__`))
            .sort((a, b) => b.id.length - a.id.length)[0];
          const source = {
            kind: "component-sample", componentId: set.id, variantId: variant.id,
            ownerPackageId: snapshot.manifest.packageId,
            nodeId: occurrence?.id ?? nodeId, displayNodeId: nodeId,
            combinationId: sample.combinationId, combinationLabel: sample.combinationLabel,
            ...(sharedNodes ? { allCombinations: true } : {}),
            familyName: set.name, selection: variant.selection,
            occurrencePath: occurrence ? nodeId : null,
            overrideNodeId: occurrence ? (nodeId === occurrence.id ? node.sourceNodeId : nodeId.slice(occurrence.id.length + 2)) : null,
            bindings: {},
          };
          for (const [field, reference] of Object.entries(node.tokenBindings ?? {})) {
            source.bindings[field] = bindingOf(view, reference);
          }
          sample.runtimeNodes[nodeId] = runtimeId;
          sample.sources[nodeId] = source;
          reverse[runtimeId] = source;
        }
      } catch (error) {
        sample.error = `${error.code ?? "component_projection_failed"}: ${error.message}`;
        sample.nodes = {};
      }
      samples.push(sample);
    }
  }
  return { samples, reverse };
}
