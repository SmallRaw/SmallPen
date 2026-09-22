import { findComponentVariant } from "./components-domain.mjs";
import { fail } from "./errors.mjs";

function screenIndex(manifest, entries) {
  return new Map(
    manifest.entries.screens.map((entry) => {
      const screen = entries[entry];
      return [screen.id, screen];
    }),
  );
}

function interactionIndex(screens) {
  const interactions = new Map();
  for (const screen of screens.values()) {
    for (const presentation of screen.presentations) {
      for (const interaction of presentation.interactions) {
        if (interactions.has(interaction.id)) {
          fail(
            "duplicate_interaction_id",
            `Duplicate Interaction id: ${interaction.id}`,
          );
        }
        interactions.set(interaction.id, {
          interaction,
          presentation,
          screen,
        });
      }
    }
  }
  return interactions;
}

function localScreenTarget(target, manifest, screens, path) {
  if (target.screen.packageId !== manifest.packageId) return undefined;
  const screen = screens.get(target.screen.assetId);
  if (!screen) {
    fail("missing_screen", `Screen not found: ${target.screen.assetId}`, {
      path,
      reference: target.screen,
    });
  }
  return screen;
}

function localComponentTarget(target, manifest, componentSets, path) {
  if (target.component.packageId !== manifest.packageId) return undefined;
  const componentSet = componentSets.get(target.component.assetId);
  if (!componentSet) {
    fail(
      "missing_component",
      `Component not found: ${target.component.assetId}`,
      { path, reference: target.component },
    );
  }
  const match = findComponentVariant(componentSet, target.variant);
  if (!match.variant) {
    fail(
      "missing_variant",
      `No exact variant exists for ${target.component.assetId}`,
      { path, selection: target.variant },
    );
  }
  return match.variant;
}

function validateScenario(
  scenario,
  manifest,
  screens,
  componentSets,
  contextAxes,
) {
  const path = `scenarios.${scenario.id}`;
  let nodes;
  if (scenario.target.kind === "screen") {
    const screen = localScreenTarget(
      scenario.target,
      manifest,
      screens,
      `${path}.target.screen`,
    );
    if (screen) {
      const presentation = screen.presentations.find(
        ({ id }) => id === scenario.target.presentationId,
      );
      if (!presentation) {
        fail(
          "missing_presentation",
          `Presentation not found: ${scenario.target.presentationId}`,
          { path: `${path}.target.presentationId` },
        );
      }
      nodes = presentation.nodes;
    }
  } else {
    const variant = localComponentTarget(
      scenario.target,
      manifest,
      componentSets,
      `${path}.target.component`,
    );
    nodes = variant?.nodes;
  }
  for (const [axisId, valueId] of Object.entries(scenario.context)) {
    const axis = contextAxes.get(axisId);
    if (!axis) {
      if (manifest.role === "foundation") {
        fail(
          "invalid_scenario_context",
          `Scenario references unknown Context Axis ${axisId}`,
          { axisId, path: `${path}.context.${axisId}`, valueId },
        );
      }
      continue;
    }
    if (!axis.values.some(({ id }) => id === valueId)) {
      fail(
        "invalid_scenario_context",
        `Scenario references unknown Context value ${valueId}`,
        { axisId, path: `${path}.context.${axisId}`, valueId },
      );
    }
  }
  if (!nodes) return;
  for (const nodeId of scenario.expectedVisibleNodeIds) {
    if (!nodes[nodeId]) {
      fail(
        "missing_scenario_node",
        `Scenario visibility expectation references missing Node ${nodeId}`,
        { nodeId, path: `${path}.expectedVisibleNodeIds` },
      );
    }
  }
  for (const [index, action] of scenario.actions.entries()) {
    if (
      (action.type === "set-text" || action.type === "set-visibility") &&
      !nodes[action.nodeId]
    ) {
      fail(
        "missing_scenario_node",
        `Scenario action references missing Node ${action.nodeId}`,
        { nodeId: action.nodeId, path: `${path}.actions[${index}].nodeId` },
      );
    }
    if (action.type === "set-text" && nodes[action.nodeId].type !== "TEXT") {
      fail(
        "scenario_node_type_mismatch",
        `set-text target is not a TEXT Node: ${action.nodeId}`,
        { nodeId: action.nodeId, path: `${path}.actions[${index}].nodeId` },
      );
    }
  }
}

function validateDesignTarget(
  target,
  manifest,
  screens,
  interactions,
  flows,
  scenarios,
  path,
) {
  if (target.kind === "interaction") {
    if (!interactions.has(target.interactionId)) {
      fail(
        "missing_interaction",
        `Interaction not found: ${target.interactionId}`,
        { path },
      );
    }
    return;
  }
  if (target.kind === "flow") {
    if (!flows.has(target.flowId)) {
      fail("missing_flow", `Flow not found: ${target.flowId}`, { path });
    }
    return;
  }
  if (target.kind === "scenario") {
    if (!scenarios.has(target.scenarioId)) {
      fail("missing_scenario", `Scenario not found: ${target.scenarioId}`, {
        path,
      });
    }
    return;
  }
  const screen = localScreenTarget(target, manifest, screens, path);
  if (!screen || target.kind === "screen") return;
  const presentation = screen.presentations.find(
    ({ id }) => id === target.presentationId,
  );
  if (!presentation) {
    fail(
      "missing_presentation",
      `Presentation not found: ${target.presentationId}`,
      { path },
    );
  }
  if (!presentation.nodes[target.nodeId]) {
    fail("missing_node", `Node not found: ${target.nodeId}`, { path });
  }
}

function validateLocalAssetReferences(manifest, entries, domain) {
  const ids = new Set([
    ...domain.tokens.keys(),
    ...domain.componentSets.keys(),
    ...domain.locatedComponents.keys(),
    ...manifest.entries.screens.map((entry) => entries[entry].id),
  ]);
  const visit = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, `${path}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") return;
    if (
      typeof value.packageId === "string" &&
      typeof value.assetId === "string"
    ) {
      if (value.packageId === manifest.packageId && !ids.has(value.assetId)) {
        fail("missing_local_asset", `Local asset is missing: ${value.assetId}`, {
          path,
          reference: structuredClone(value),
        });
      }
      return;
    }
    for (const [field, child] of Object.entries(value)) {
      visit(child, `${path}.${field}`);
    }
  };
  for (const entry of Object.keys(entries).sort()) visit(entries[entry], entry);
}

export function validateDesignReferences(manifest, entries, domain) {
  const screens = screenIndex(manifest, entries);
  const interactions = interactionIndex(screens);
  for (const screen of screens.values()) {
    for (const presentation of screen.presentations) {
      for (const interaction of presentation.interactions) {
        const action = interaction.action;
        if (action.type !== "navigate") continue;
        const target = localScreenTarget(
          { screen: action.screen },
          manifest,
          screens,
          `interactions.${interaction.id}.action.screen`,
        );
        if (
          target &&
          action.presentationId !== undefined &&
          !target.presentations.some(({ id }) => id === action.presentationId)
        ) {
          fail(
            "missing_presentation",
            `Presentation not found: ${action.presentationId}`,
            { path: `interactions.${interaction.id}.action.presentationId` },
          );
        }
      }
      for (const node of Object.values(presentation.nodes)) {
        if (!node.instance) continue;
        localComponentTarget(
          {
            component: node.instance.component,
            variant: node.instance.variant,
          },
          manifest,
          domain.componentSets,
          `nodes.${node.id}.instance.component`,
        );
      }
    }
  }
  for (const scenario of domain.scenarios.values()) {
    validateScenario(
      scenario,
      manifest,
      screens,
      domain.componentSets,
      domain.contextAxes,
    );
  }
  for (const flow of domain.flows.values()) {
    for (const interactionId of flow.interactionIds) {
      if (!interactions.has(interactionId)) {
        fail(
          "missing_interaction",
          `Flow ${flow.id} references missing Interaction ${interactionId}`,
          { flowId: flow.id, interactionId },
        );
      }
    }
  }
  for (const requirement of domain.requirements.values()) {
    requirement.links.forEach((target, index) =>
      validateDesignTarget(
        target,
        manifest,
        screens,
        interactions,
        domain.flows,
        domain.scenarios,
        `requirements.${requirement.id}.links[${index}]`,
      ),
    );
  }
  for (const annotation of domain.annotations.values()) {
    validateDesignTarget(
      annotation.target,
      manifest,
      screens,
      interactions,
      domain.flows,
      domain.scenarios,
      `annotations.${annotation.id}.target`,
    );
  }
  validateLocalAssetReferences(manifest, entries, domain);
}
