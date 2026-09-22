import {
  projectComponentVariant,
  projectScreen,
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

function screenByReference(snapshot, reference) {
  if (reference?.packageId !== snapshot.manifest.packageId) return undefined;
  const entry = snapshot.manifest.entries.screens.find(
    (candidate) => snapshot.entries[candidate].id === reference.assetId,
  );
  return entry ? snapshot.entries[entry] : undefined;
}

function destinationRuntimeId(snapshot, interaction) {
  const screen = screenByReference(snapshot, interaction.action.screen);
  if (!screen) {
    throw new Error(
      `Interaction destination Screen is unavailable: ${interaction.action.screen?.assetId}`,
    );
  }
  const presentationId =
    interaction.action.presentationId ?? screen.basePresentationId;
  const presentation = screen.presentations.find(
    (candidate) => candidate.id === presentationId,
  );
  const rootId = presentation?.rootId ?? presentation?.rootIds?.[0];
  const runtimeId =
    rootId && snapshot.runtime.nodes?.[screen.id]?.[presentationId]?.[rootId];
  if (!runtimeId) {
    throw new Error(
      `Interaction destination runtime Node is unavailable: ${screen.id}/${presentationId}`,
    );
  }
  return runtimeId;
}

function penpotInteraction(snapshot, presentation, interaction) {
  if (
    interaction.trigger !== "activate" ||
    interaction.action?.type !== "navigate"
  ) {
    throw new Error(
      `Web projection does not support Interaction ${interaction.id}: ${interaction.trigger}/${interaction.action?.type}`,
    );
  }
  const sourceRuntimeId =
    snapshot.runtime.nodes?.[presentation.screenId]?.[presentation.id]?.[
      interaction.sourceNodeId
    ];
  if (!sourceRuntimeId) {
    throw new Error(
      `Interaction source runtime Node is unavailable: ${interaction.sourceNodeId}`,
    );
  }
  return {
    "action-type": "navigate",
    destination: destinationRuntimeId(snapshot, interaction),
    "event-type": "click",
    "position-relative-to": sourceRuntimeId,
    "preserve-scroll": false,
  };
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

export async function createWebWorkspaceSnapshot(product, options = {}) {
  const entries = structuredClone(product.entries);
  const runtime = structuredClone(product.runtime);
  const errors = [];

  // The native Components page is projected even when the user opens the
  // generated system sheet. It needs the same expanded trees as screens;
  // canonical INSTANCE descriptors alone have no native component reference.
  for (const entry of product.manifest.entries.components) {
    for (const set of entries[entry].componentSets ?? []) {
      for (const variant of set.variants) {
        variant.nodes = adaptLocatedInstances(
          projectComponentVariant(product, variant, options),
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
  for (const sample of runtime.designSystemRefs?.componentSamples ?? []) {
    sample.nodes = adaptLocatedInstances(sample.nodes);
  }

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
  };
}
