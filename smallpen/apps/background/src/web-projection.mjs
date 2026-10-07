import {
  annotatePenpotAppliedTokens,
  listTokenThemes,
  ownTokenNames,
  projectComponentVariant,
  projectScreen,
  projectPrototypeInteraction,
  SmallPenError,
  stableRuntimeUuid,
} from "@smallpen/core";

function projectionError(error, screenId, presentationId, nodeId) {
  return {
    code: error?.code ?? "web_projection_failed",
    details: error?.details ?? {},
    message: error instanceof Error ? error.message : String(error),
    ...(nodeId ? { nodeId } : {}),
    presentationId,
    screenId,
  };
}

function penpotInteraction(snapshot, presentation, interaction) {
  return projectPrototypeInteraction(snapshot, presentation, interaction);
}

function adaptLocatedInstances(nodes) {
  const result = structuredClone(nodes);
  for (const node of Object.values(result)) {
    if (node.componentId && node.variantId) {
      // The Web projector accepts a full Asset Reference here. Keeping the
      // owner package is required for Foundation instances; a bare stable id
      // would incorrectly resolve against the Product package.
      node.componentId = structuredClone(node.componentRef);
      node.componentVariantId = node.variantId;
    }
    delete node.componentOwnerPackageId;
    delete node.componentRef;
    delete node.variantId;
    delete node.variantSelection;
  }
  return result;
}

function attachInteractions(snapshot, screen, presentation, nodes, errors) {
  const result = structuredClone(nodes);
  const descriptor = { ...presentation, screenId: screen.id };
  for (const interaction of presentation.interactions ?? []) {
    try {
      const source = result[interaction.sourceNodeId];
      if (!source) {
        throw new Error(
          `Interaction source Node is unavailable: ${interaction.sourceNodeId}`,
        );
      }
      source.interactions = [
        ...(source.interactions ?? []),
        penpotInteraction(snapshot, descriptor, interaction),
      ];
    } catch (error) {
      errors.push(
        projectionError(
          error,
          screen.id,
          presentation.id,
          interaction.sourceNodeId,
        ),
      );
    }
  }
  return result;
}

function webProjectionFailure(error, screen, presentation) {
  return new SmallPenError(
    "web_projection_failed",
    `SmallPen cannot load ${screen.name} / ${presentation.name} in Web: ${
      error instanceof Error ? error.message : String(error)
    }`,
    {
      causeCode: error?.code ?? "web_projection_failed",
      causeDetails: error?.details ?? {},
      presentationId: presentation.id,
      presentationName: presentation.name,
      screenId: screen.id,
      screenName: screen.name,
    },
  );
}

async function registerExpandedNodes(
  product,
  runtime,
  screen,
  presentation,
  nodes,
) {
  const nodeIds = runtime.nodes[screen.id][presentation.id];
  for (const nodeId of Object.keys(nodes)) {
    if (nodeIds[nodeId]) continue;
    const runtimeId = await stableRuntimeUuid(
      product.manifest.packageId,
      "node",
      `${screen.id}\0${presentation.id}\0${nodeId}`,
    );
    nodeIds[nodeId] = runtimeId;
    runtime.reverseNodes[runtimeId] = {
      nodeId,
      presentationId: presentation.id,
      screenId: screen.id,
    };
  }
}

// Expands every Component Set variant into the node trees the native
// Components page draws, registering the derived descendants' runtime ids.
async function expandComponentSets(product, entries, runtime, options) {
  // The native Components page is projected even when the user opens the
  // generated system sheet. It needs the same expanded trees as screens;
  // canonical INSTANCE descriptors alone have no native component reference.
  for (const entry of product.manifest.entries.components) {
    for (const set of entries[entry].componentSets ?? []) {
      for (const variant of set.variants) {
        variant.nodes = annotatePenpotAppliedTokens(
          adaptLocatedInstances(projectComponentVariant(product, variant, options)),
          product,
          options.names,
        );
        const ids = runtime.componentNodes[set.id][variant.id];
        for (const nodeId of Object.keys(variant.nodes)) {
          if (ids[nodeId]) continue;
          ids[nodeId] = await stableRuntimeUuid(
            product.manifest.packageId,
            "component-node",
            `${set.id}\0${variant.id}\0${nodeId}`,
          );
          // Derived descendants are not canonical nodes. Do not register an
          // unsafe direct write target; system-sheet samples carry their own
          // occurrence-aware reverse mapping for nested overrides.
        }
      }
    }
  }
}

// The generated Design System page data as the Web reads it: sample trees
// with their Instances in the Web form. Core shares its samples between
// runtimes built from equal inputs, so each sample is adapted into a new
// object once and the core value is never changed.
const webSamples = new WeakMap();

// With the package, sample nodes also carry the applied Tokens the App shows.
export function webDesignSystemRefs(refs, product) {
  if (!refs?.componentSamples) return refs;
  const names = product ? ownTokenNames(product) : undefined;
  return {
    ...refs,
    componentSamples: refs.componentSamples.map((sample) => {
      if (!webSamples.has(sample)) {
        const nodes = adaptLocatedInstances(sample.nodes);
        if (product) annotatePenpotAppliedTokens(nodes, product, names);
        webSamples.set(sample, { ...sample, nodes });
      }
      return webSamples.get(sample);
    }),
  };
}

// The page data as it travels to the Web (format "compact-1"). Every
// sample node's source repeats its sample: the wire keeps only what is the
// node's own, and the Web merges the rest back from the sample.
//   sample.ownerPackageId    the Package of all its sources
//   refs.componentAxes       axes per Component Set (sample.axes dropped)
//   refs.componentBindings   each distinct resolved binding once
//   sources[displayNodeId] = { nodeId (when not displayNodeId),
//     occurrence: true (occurrencePath = displayNodeId, else null),
//     overrideNodeId (with an occurrence), bindings: { field: index } }
// A full source is { kind: "component-sample", componentId:
// sample.componentSetId, variantId, ownerPackageId, combinationId,
// combinationLabel, allCombinations (when set), familyName, selection } of
// the sample, plus displayNodeId and the fields above.
export function compactDesignSystemRefs(refs) {
  if (!refs?.componentSamples) return refs;
  const componentAxes = {};
  const componentBindings = [];
  const bindingIndexes = new Map();
  const bindingIndex = (binding) => {
    const key = JSON.stringify(binding);
    if (!bindingIndexes.has(key)) {
      bindingIndexes.set(key, componentBindings.length);
      componentBindings.push(binding);
    }
    return bindingIndexes.get(key);
  };
  const componentSamples = refs.componentSamples.map((sample) => {
    const { axes, sources, ...rest } = sample;
    componentAxes[sample.componentSetId] ??= axes;
    const compact = {};
    let ownerPackageId;
    for (const [nodeId, source] of Object.entries(sources ?? {})) {
      ownerPackageId ??= source.ownerPackageId;
      const item = {};
      if (source.nodeId !== nodeId) item.nodeId = source.nodeId;
      if (source.occurrencePath !== null) {
        item.occurrence = true;
        if (source.overrideNodeId !== undefined) {
          item.overrideNodeId = source.overrideNodeId;
        }
      }
      const fields = Object.entries(source.bindings ?? {});
      if (fields.length > 0) {
        item.bindings = Object.fromEntries(
          fields.map(([field, binding]) => [field, bindingIndex(binding)]),
        );
      }
      compact[nodeId] = item;
    }
    return {
      ...rest,
      ...(ownerPackageId === undefined ? {} : { ownerPackageId }),
      sources: compact,
    };
  });
  return {
    ...refs,
    componentAxes,
    componentBindings,
    componentSamples,
    format: "compact-1",
  };
}

// Runtime ids are cloned because a projection registers more of them; the
// Design System page data is large, read-only here, and served on its own
// (server.mjs /v1/design-system-refs), so it is shared instead of cloned.
function cloneRuntime(value, product) {
  const { designSystemRefs, reverseDesignSystem, ...ids } = value;
  const runtime = structuredClone(ids);
  if (designSystemRefs !== undefined) {
    runtime.designSystemRefs = webDesignSystemRefs(designSystemRefs, product);
  }
  if (reverseDesignSystem !== undefined) {
    runtime.reverseDesignSystem = reverseDesignSystem;
  }
  return runtime;
}

// A Library loads in the Web as a library file. Nothing shows its
// generated Design System page, so its page data stays on the server.
export function withoutDesignSystemRefs(snapshot) {
  const {
    designSystemRefs: _refs,
    reverseDesignSystem: _reverse,
    ...runtime
  } = snapshot.runtime;
  return { ...snapshot, runtime };
}

// The Penpot ids a session gave to Component Set items (a new variant
// container, a duplicated variant and its nodes, a variant combined into
// another set) stay their runtime ids for that session, so a reprojection
// keeps the shapes, selection and undo history the workspace already holds.
// Screen node descriptors (the children of a new or switched Instance) only
// resolve commits; removed items are remembered for an exact undo.
export function applySessionRuntimeIds(runtime, sessionIds) {
  for (const [runtimeId, descriptor] of sessionIds ?? []) {
    const { componentId, kind, nodeId, variantId } = descriptor;
    if (kind === "component-set") {
      const previous = runtime.components?.[componentId];
      if (previous === undefined) continue;
      delete runtime.reverseComponents[previous];
      runtime.components[componentId] = runtimeId;
      runtime.reverseComponents[runtimeId] = { componentId };
    } else if (kind === "variant") {
      const ids = runtime.variants?.[componentId];
      if (ids?.[variantId] === undefined) continue;
      delete runtime.reverseVariants[ids[variantId]];
      ids[variantId] = runtimeId;
      runtime.reverseVariants[runtimeId] = { componentId, variantId };
    } else if (kind === "component-node") {
      const ids = runtime.componentNodes?.[componentId]?.[variantId];
      if (ids?.[nodeId] === undefined) continue;
      delete runtime.reverseComponentNodes[ids[nodeId]];
      ids[nodeId] = runtimeId;
      runtime.reverseComponentNodes[runtimeId] = { componentId, nodeId, variantId };
    } else if (kind === "removed-component-node") {
      runtime.removedComponentItems ??= {};
      runtime.removedComponentItems[runtimeId] = { ...descriptor, kind: "node" };
    } else if (kind === "component-set-position") {
      runtime.componentSetPositions ??= {};
      runtime.componentSetPositions[componentId] = {
        entry: descriptor.entry,
        index: descriptor.index,
      };
    } else if (kind === "component-set-state") {
      runtime.componentSetStates ??= {};
      runtime.componentSetStates[runtimeId] = descriptor.set;
    } else if (kind === "removed-component") {
      runtime.removedComponentItems ??= {};
      runtime.removedComponentItems[runtimeId] = { ...descriptor, kind: "component" };
    } else if (kind === "removed-component-set") {
      runtime.removedComponentItems ??= {};
      runtime.removedComponentItems[runtimeId] = { ...descriptor, kind: "set" };
    } else if (kind === undefined) {
      runtime.reverseNodes[runtimeId] ??= descriptor;
    }
  }
  return runtime;
}

export async function createWebWorkspaceSnapshot(product, options = {}) {
  const entries = structuredClone(product.entries);
  const runtime = applySessionRuntimeIds(
    cloneRuntime(product.runtime, product),
    options.sessionRuntimeIds,
  );
  const errors = [];
  // Applied Tokens are computed here, from core's one table, for every node
  // the App draws; the App translates no binding itself.
  const names = ownTokenNames(product);

  await expandComponentSets(product, entries, runtime, { ...options, names });

  for (const entry of product.manifest.entries.screens) {
    const screen = product.entries[entry];
    const presentations = [];
    for (const presentation of screen.presentations) {
      try {
        const projected = projectScreen(product, screen.id, {
          foundation: options.foundation,
          libraries: options.libraries,
          presentationId: presentation.id,
        });
        const locatedNodes = adaptLocatedInstances(projected.nodes);
        await registerExpandedNodes(
          product,
          runtime,
          screen,
          presentation,
          locatedNodes,
        );
        const nodes = attachInteractions(
          { ...product, runtime },
          screen,
          presentation,
          locatedNodes,
          errors,
        );
        annotatePenpotAppliedTokens(nodes, product, names);
        presentations.push({ ...structuredClone(presentation), nodes });
      } catch (error) {
        // A failed design projection is not an invitation to rewrite the
        // user's design. The request fails with precise context instead, so
        // the Web client can leave its loading state and present the error.
        // The canonical Package remains untouched and can be repaired by the
        // authoring tool that produced the unsupported reference.
        throw webProjectionFailure(error, screen, presentation);
      }
    }
    entries[entry].presentations = presentations;
  }

  return {
    ...product,
    domain: product.domain,
    entries,
    projectionErrors: errors,
    runtime,
    // The themes the Web token manager offers and which are active: the
    // Package's own and, for a Product, its selection of the Foundation's.
    tokenThemes: listTokenThemes(product, options.foundation),
  };
}

// A Library as the Web projects its file: Component Set variants and
// screens with their Instances expanded, like the workspace's own Package.
// Canonical INSTANCE nodes carry no native component reference, so the
// raw Library cannot load as a Penpot library file. A Library that cannot
// be expanded travels as it is, as before.
export async function createWebLibrarySnapshot(value, options = {}) {
  const library = withoutDesignSystemRefs(value);
  try {
    const entries = structuredClone(library.entries);
    const runtime = structuredClone(library.runtime);
    await expandComponentSets(library, entries, runtime, options);
    for (const entry of library.manifest.entries.screens) {
      const screen = library.entries[entry];
      entries[entry].presentations = [];
      for (const presentation of screen.presentations) {
        const projected = projectScreen(library, screen.id, {
          libraries: options.libraries,
          presentationId: presentation.id,
        });
        const nodes = annotatePenpotAppliedTokens(adaptLocatedInstances(projected.nodes), library);
        await registerExpandedNodes(library, runtime, screen, presentation, nodes);
        entries[entry].presentations.push({ ...structuredClone(presentation), nodes });
      }
    }
    return { ...library, entries, runtime };
  } catch {
    return library;
  }
}
