import { fail } from "./errors.mjs";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableId(value, prefix, code, path) {
  if (
    typeof value !== "string" ||
    !value.startsWith(prefix) ||
    !/^[a-zA-Z0-9_-]+$/.test(value)
  ) {
    fail(code, `${path} must begin with ${prefix}`, { path, value });
  }
  return value;
}

function nonEmpty(value, code, path) {
  if (typeof value !== "string" || value.length === 0) {
    fail(code, `${path} must be a non-empty string`, { path, value });
  }
  return value;
}

function stringRecord(value, code, path) {
  if (!isRecord(value)) fail(code, `${path} must contain an object`, { path });
  for (const [field, child] of Object.entries(value)) {
    if (field.length === 0 || typeof child !== "string" || child.length === 0) {
      fail(code, `${path} must map strings to strings`, { path });
    }
  }
  return structuredClone(value);
}

function assetReference(value, prefix, path) {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    typeof value.packageId !== "string" ||
    !value.packageId.startsWith("pkg_") ||
    typeof value.assetId !== "string" ||
    !value.assetId.startsWith(prefix)
  ) {
    fail("invalid_asset_reference", `${path} is invalid`, { path });
  }
  return structuredClone(value);
}

function parseTarget(value, path) {
  if (!isRecord(value)) fail("invalid_scenario_target", `${path} is invalid`);
  if (value.kind === "screen") {
    if (
      Object.keys(value).length !== 3 ||
      typeof value.presentationId !== "string" ||
      !value.presentationId.startsWith("pres_")
    ) {
      fail("invalid_screen_reference", `${path} Screen target is invalid`);
    }
    return {
      kind: "screen",
      presentationId: value.presentationId,
      screen: assetReference(value.screen, "scr_", `${path}.screen`),
    };
  }
  if (value.kind === "component") {
    if (Object.keys(value).length !== 3) {
      fail("invalid_component_target", `${path} Component target is invalid`);
    }
    return {
      component: assetReference(
        value.component,
        "cmp_",
        `${path}.component`,
      ),
      kind: "component",
      variant: stringRecord(
        value.variant,
        "invalid_component_variant_selection",
        `${path}.variant`,
      ),
    };
  }
  fail(
    "invalid_scenario_target_kind",
    `${path}.kind must be screen or component`,
  );
}

function parseOverrideValue(value, path) {
  if (
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (
    Array.isArray(value) &&
    value.every(
      (paint) =>
        isRecord(paint) &&
        paint.type === "solid" &&
        typeof paint.color === "string" &&
        (paint.opacity === undefined ||
          (typeof paint.opacity === "number" &&
            Number.isFinite(paint.opacity) &&
            paint.opacity >= 0 &&
            paint.opacity <= 1)),
    )
  ) {
    return structuredClone(value);
  }
  fail("invalid_scenario_override", `${path} is unsupported`, { path });
}

function parseAction(value, path) {
  if (!isRecord(value) || typeof value.type !== "string") {
    fail("invalid_scenario_action", `${path} must contain an object`);
  }
  if (
    value.type === "set-state" &&
    Object.keys(value).length === 3 &&
    typeof value.axisId === "string" &&
    value.axisId.startsWith("axis_") &&
    typeof value.value === "string" &&
    value.value.length > 0
  ) {
    return structuredClone(value);
  }
  if (
    value.type === "set-text" &&
    Object.keys(value).length === 3 &&
    typeof value.nodeId === "string" &&
    value.nodeId.startsWith("node_") &&
    typeof value.value === "string"
  ) {
    return structuredClone(value);
  }
  if (
    value.type === "set-visibility" &&
    Object.keys(value).length === 3 &&
    typeof value.nodeId === "string" &&
    value.nodeId.startsWith("node_") &&
    typeof value.visible === "boolean"
  ) {
    return structuredClone(value);
  }
  if (
    value.type === "set-override" &&
    Object.keys(value).length === 3 &&
    typeof value.overridePath === "string" &&
    value.overridePath.length > 0
  ) {
    return {
      overridePath: value.overridePath,
      type: "set-override",
      value: parseOverrideValue(value.value, `${path}.value`),
    };
  }
  fail(
    "unsupported_scenario_action",
    `${path} must use a finite declarative Scenario action`,
    { path, type: value.type },
  );
}

function parseScenario(value, path) {
  if (!isRecord(value)) fail("invalid_scenario", `${path} is invalid`);
  const fields = new Set([
    "actions",
    "context",
    "expectedVisibleNodeIds",
    "fixture",
    "id",
    "name",
    "target",
    "viewport",
  ]);
  if (
    Object.keys(value).length !== fields.size ||
    Object.keys(value).some((field) => !fields.has(field))
  ) {
    fail("invalid_scenario", `${path} fields are invalid`);
  }
  stableId(value.id, "scn_", "invalid_scenario_id", `${path}.id`);
  nonEmpty(value.name, "invalid_scenario_name", `${path}.name`);
  if (!Array.isArray(value.actions)) {
    fail("invalid_scenario_actions", `${path}.actions must be an array`);
  }
  if (
    !Array.isArray(value.expectedVisibleNodeIds) ||
    value.expectedVisibleNodeIds.some(
      (nodeId) => typeof nodeId !== "string" || !nodeId.startsWith("node_"),
    ) ||
    new Set(value.expectedVisibleNodeIds).size !==
      value.expectedVisibleNodeIds.length
  ) {
    fail(
      "invalid_visibility_expectation",
      `${path}.expectedVisibleNodeIds must contain unique Node ids`,
    );
  }
  if (
    !isRecord(value.fixture) ||
    Object.values(value.fixture).some(
      (entry) =>
        entry !== null &&
        typeof entry !== "boolean" &&
        typeof entry !== "string" &&
        (typeof entry !== "number" || !Number.isFinite(entry)),
    )
  ) {
    fail("invalid_fixture", `${path}.fixture must contain scalar values`);
  }
  if (
    !isRecord(value.viewport) ||
    !["height", "scale", "width"].every(
      (field) =>
        typeof value.viewport[field] === "number" &&
        Number.isFinite(value.viewport[field]) &&
        value.viewport[field] > 0,
    ) ||
    Object.keys(value.viewport).length !== 3
  ) {
    fail("invalid_viewport", `${path}.viewport values must be positive`);
  }
  return {
    actions: value.actions.map((action, index) =>
      parseAction(action, `${path}.actions[${index}]`),
    ),
    context: stringRecord(
      value.context,
      "invalid_scenario_context",
      `${path}.context`,
    ),
    expectedVisibleNodeIds: [...value.expectedVisibleNodeIds],
    fixture: structuredClone(value.fixture),
    id: value.id,
    name: value.name,
    target: parseTarget(value.target, `${path}.target`),
    viewport: structuredClone(value.viewport),
  };
}

export function parseScenarioEntries(manifest, entries) {
  const scenarios = new Map();
  for (const entry of manifest.entries.scenarios) {
    const value = entries[entry];
    if (
      !isRecord(value) ||
      Object.keys(value).length !== 1 ||
      !Array.isArray(value.scenarios)
    ) {
      fail(
        "invalid_scenario_file",
        `${entry} must contain a scenarios array`,
      );
    }
    for (const [index, candidate] of value.scenarios.entries()) {
      const scenario = parseScenario(candidate, `${entry}.scenarios[${index}]`);
      if (scenarios.has(scenario.id)) {
        fail("duplicate_scenario_id", `Duplicate Scenario id: ${scenario.id}`);
      }
      scenarios.set(scenario.id, scenario);
    }
  }
  return scenarios;
}
