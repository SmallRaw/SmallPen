import { fail } from "./errors.mjs";

const CONTEXT_KINDS = new Set([
  "accessibility",
  "custom",
  "density",
  "locale",
  "theme",
  "viewport",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value, code, path) {
  if (typeof value !== "string" || value.length === 0) {
    fail(code, `${path} must be a non-empty string`, { path, value });
  }
  return value;
}

function stableId(value, prefix, code, path) {
  nonEmptyString(value, code, path);
  if (!value.startsWith(prefix) || !/^[a-zA-Z0-9_-]+$/.test(value)) {
    fail(code, `${path} must begin with ${prefix}`, { path, value });
  }
  return value;
}

function stringRecord(value, code, path) {
  if (!isRecord(value)) fail(code, `${path} must contain an object`, { path });
  for (const [key, child] of Object.entries(value)) {
    if (
      typeof key !== "string" ||
      key.length === 0 ||
      typeof child !== "string" ||
      child.length === 0
    ) {
      fail(code, `${path} must map non-empty strings to non-empty strings`, {
        path,
      });
    }
  }
  return value;
}

function parseAxis(value, path) {
  if (!isRecord(value)) {
    fail("invalid_context_axis", `${path} must contain an object`, { path });
  }
  const fields = new Set(["defaultValue", "id", "kind", "name", "values"]);
  if (
    Object.keys(value).length !== fields.size ||
    Object.keys(value).some((field) => !fields.has(field))
  ) {
    fail("invalid_context_axis", `${path} fields are invalid`, { path });
  }
  stableId(value.id, "axis_", "invalid_context_axis_id", `${path}.id`);
  nonEmptyString(value.name, "invalid_context_axis", `${path}.name`);
  if (!CONTEXT_KINDS.has(value.kind)) {
    fail("invalid_context_axis_kind", `${path}.kind is unsupported`, {
      path: `${path}.kind`,
      value: value.kind,
    });
  }
  if (!Array.isArray(value.values) || value.values.length === 0) {
    fail(
      "invalid_context_axis_values",
      `${path}.values must be a finite non-empty array`,
      { path: `${path}.values` },
    );
  }
  const ids = new Set();
  const values = value.values.map((candidate, index) => {
    const valuePath = `${path}.values[${index}]`;
    if (
      !isRecord(candidate) ||
      Object.keys(candidate).length !== 2 ||
      typeof candidate.id !== "string" ||
      candidate.id.length === 0 ||
      typeof candidate.name !== "string" ||
      candidate.name.length === 0
    ) {
      fail(
        "invalid_context_axis_value",
        `${valuePath} requires id and name`,
        { path: valuePath },
      );
    }
    if (ids.has(candidate.id)) {
      fail(
        "duplicate_context_axis_value",
        `${path}.values contains duplicate id ${candidate.id}`,
        { path: `${path}.values`, valueId: candidate.id },
      );
    }
    ids.add(candidate.id);
    return structuredClone(candidate);
  });
  if (!ids.has(value.defaultValue)) {
    fail(
      "missing_context_default",
      `${path}.defaultValue must name one declared value`,
      { path: `${path}.defaultValue`, value: value.defaultValue },
    );
  }
  return {
    defaultValue: value.defaultValue,
    id: value.id,
    kind: value.kind,
    name: value.name,
    values,
  };
}

function parseProfile(value, path) {
  if (!isRecord(value)) {
    fail("invalid_context_profile", `${path} must contain an object`, { path });
  }
  const fields = new Set(["default", "id", "name", "values"]);
  if (Object.keys(value).some((field) => !fields.has(field))) {
    fail("invalid_context_profile", `${path} fields are invalid`, { path });
  }
  stableId(value.id, "ctx_", "invalid_context_profile_id", `${path}.id`);
  nonEmptyString(value.name, "invalid_context_profile", `${path}.name`);
  if (value.default !== undefined && typeof value.default !== "boolean") {
    fail(
      "invalid_context_profile",
      `${path}.default must be boolean when present`,
      { path: `${path}.default` },
    );
  }
  return {
    default: value.default === true,
    id: value.id,
    name: value.name,
    values: structuredClone(
      stringRecord(
        value.values,
        "invalid_context_profile",
        `${path}.values`,
      ),
    ),
  };
}

export function parseContextEntries(manifest, entries) {
  const axes = new Map();
  const profiles = new Map();
  for (const entry of manifest.entries.contexts) {
    const value = entries[entry];
    if (
      !isRecord(value) ||
      !Array.isArray(value.axes) ||
      !Array.isArray(value.profiles) ||
      Object.keys(value).some((field) => field !== "axes" && field !== "profiles")
    ) {
      fail(
        "invalid_context_file",
        `${entry} requires axes and profiles arrays`,
        { entry },
      );
    }
    for (const [index, candidate] of value.axes.entries()) {
      const axis = parseAxis(candidate, `${entry}.axes[${index}]`);
      if (axes.has(axis.id)) {
        fail("duplicate_context_axis", `Duplicate Context Axis: ${axis.id}`, {
          axisId: axis.id,
          entry,
        });
      }
      axes.set(axis.id, axis);
    }
    for (const [index, candidate] of value.profiles.entries()) {
      const profile = parseProfile(candidate, `${entry}.profiles[${index}]`);
      if (profiles.has(profile.id)) {
        fail(
          "duplicate_context_profile",
          `Duplicate Context profile: ${profile.id}`,
          { entry, profileId: profile.id },
        );
      }
      profiles.set(profile.id, profile);
    }
  }
  const defaults = [...profiles.values()].filter((profile) => profile.default);
  if (defaults.length > 1) {
    fail(
      "multiple_default_context_profiles",
      "At most one Context profile may be the default",
      { profileIds: defaults.map(({ id }) => id) },
    );
  }
  for (const profile of profiles.values()) {
    for (const [axisId, valueId] of Object.entries(profile.values)) {
      const axis = axes.get(axisId);
      if (!axis || !axis.values.some(({ id }) => id === valueId)) {
        fail(
          "invalid_context_profile_value",
          `Context profile ${profile.id} references an unknown Axis or value`,
          {
            axisId,
            path: `contexts.${profile.id}.values.${axisId}`,
            profileId: profile.id,
            valueId,
          },
        );
      }
    }
  }
  return { axes, profiles };
}

export function combineContextAxes(product, foundation) {
  const axes = new Map(foundation?.domain?.contextAxes ?? []);
  for (const [axisId, axis] of product.domain.contextAxes) {
    if (axes.has(axisId)) {
      fail(
        "duplicate_workspace_context_axis",
        "Product cannot redefine a Foundation Context Axis",
        { axisId, path: `contexts.${axisId}` },
      );
    }
    axes.set(axisId, axis);
  }
  return axes;
}

export function resolveContext(product, foundation, selection = {}) {
  const axes = combineContextAxes(product, foundation);
  stringRecord(selection, "invalid_context_selection", "context");
  for (const [axisId, valueId] of Object.entries(selection)) {
    const axis = axes.get(axisId);
    if (!axis || !axis.values.some(({ id }) => id === valueId)) {
      fail(
        "invalid_context_selection",
        "Context selection references an unknown Axis or value",
        { axisId, path: `context.${axisId}`, valueId },
      );
    }
  }
  return Object.fromEntries(
    [...axes.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((axis) => [axis.id, selection[axis.id] ?? axis.defaultValue]),
  );
}
