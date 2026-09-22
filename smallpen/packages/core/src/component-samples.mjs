import { stableRuntimeUuid } from "./canonical.mjs";
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

export async function createComponentSamples(snapshot, families, combinations) {
  const samples = [];
  const reverse = {};
  for (const family of families.filter((item) => item.kind === "variant")) {
    const set = snapshot.domain.componentSets.get(family.componentSetId);
    const variant = set.variants.find((item) => item.id === family.variantId);
    const occurrences = Object.values(variant.nodes).filter((node) => node.instance);
    for (const combination of combinations.length ? combinations : [null]) {
      const key = `${set.id}\0${variant.id}\0${combination?.id ?? "default"}`;
      const sample = {
        ...family, key, familyName: set.name, axes: set.axes,
        selection: variant.selection,
        classification: set.variants.some((item) => Object.values(item.nodes).some((node) => node.instance)) ? "Composite" : "Primitive",
        combinationId: combination?.id ?? null,
        combinationIndex: combination ? combinations.indexOf(combination) : 0,
        combinationLabel: combination?.label ?? "Default",
        caption: await stableRuntimeUuid(snapshot.manifest.packageId, "component-sample-caption", key),
        runtimeNodes: {}, sources: {},
      };
      reverse[sample.caption] = { kind: "label" };
      try {
        const view = componentCombinationSnapshot(snapshot, combination);
        sample.nodes = projectComponentVariant(view, variant);
        for (const [nodeId, node] of Object.entries(sample.nodes)) {
          const runtimeId = await stableRuntimeUuid(snapshot.manifest.packageId, "component-sample-node", `${key}\0${nodeId}`);
          // Longest exact occurrence prefix, never labels or array indices.
          const occurrence = occurrences.filter((item) => nodeId === item.id || nodeId.startsWith(`${item.id}__`))
            .sort((a, b) => b.id.length - a.id.length)[0];
          const source = {
            kind: "component-sample", componentId: set.id, variantId: variant.id,
            ownerPackageId: snapshot.manifest.packageId,
            nodeId: occurrence?.id ?? nodeId, displayNodeId: nodeId,
            combinationId: sample.combinationId, combinationLabel: sample.combinationLabel,
            familyName: set.name, selection: variant.selection,
            occurrencePath: occurrence ? nodeId : null,
            overrideNodeId: occurrence ? (nodeId === occurrence.id ? node.sourceNodeId : nodeId.slice(occurrence.id.length + 2)) : null,
            bindings: {},
          };
          for (const [field, reference] of Object.entries(node.tokenBindings ?? {})) {
            const resolved = resolveEffectiveToken(view, reference);
            source.bindings[field] = resolved ? {
              tokenId: resolved.sourceTokenId, ownerPackageId: resolved.sourcePackageId,
              path: resolved.token.path, value: resolved.value,
              alias: typeof resolved.token.rawValue === "string" && /^\{[^{}]+\}$/.test(resolved.token.rawValue),
              contextual: (resolved.token.contextValues?.length ?? 0) > 0,
            } : { missing: true };
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
