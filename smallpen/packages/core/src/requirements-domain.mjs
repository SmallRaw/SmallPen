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

export function parseDesignTarget(value, path) {
  if (!isRecord(value) || typeof value.kind !== "string") {
    fail("invalid_design_target", `${path} is invalid`, { path });
  }
  if (value.kind === "node") {
    if (
      Object.keys(value).length !== 4 ||
      typeof value.presentationId !== "string" ||
      !value.presentationId.startsWith("pres_") ||
      typeof value.nodeId !== "string" ||
      !value.nodeId.startsWith("node_")
    ) {
      fail("invalid_design_target", `${path} Node target is invalid`);
    }
    return {
      kind: "node",
      nodeId: value.nodeId,
      presentationId: value.presentationId,
      screen: assetReference(value.screen, "scr_", `${path}.screen`),
    };
  }
  if (value.kind === "screen") {
    if (Object.keys(value).length !== 2) {
      fail("invalid_design_target", `${path} Screen target is invalid`);
    }
    return {
      kind: "screen",
      screen: assetReference(value.screen, "scr_", `${path}.screen`),
    };
  }
  const idFields = {
    flow: ["flowId", "flow_"],
    interaction: ["interactionId", "int_"],
    scenario: ["scenarioId", "scn_"],
  };
  const descriptor = idFields[value.kind];
  if (!descriptor || Object.keys(value).length !== 2) {
    fail("invalid_design_target", `${path}.kind is unsupported`, {
      kind: value.kind,
      path,
    });
  }
  const [field, prefix] = descriptor;
  stableId(value[field], prefix, "invalid_design_target", `${path}.${field}`);
  return structuredClone(value);
}

function parseRequirement(value, path) {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 4 ||
    !Array.isArray(value.links) ||
    typeof value.markdown !== "string"
  ) {
    fail("invalid_requirement", `${path} is invalid`);
  }
  stableId(value.id, "req_", "invalid_requirement_id", `${path}.id`);
  nonEmpty(value.title, "invalid_requirement_title", `${path}.title`);
  return {
    id: value.id,
    links: value.links.map((link, index) =>
      parseDesignTarget(link, `${path}.links[${index}]`),
    ),
    markdown: value.markdown,
    title: value.title,
  };
}

function parseFlow(value, path) {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    !Array.isArray(value.interactionIds) ||
    value.interactionIds.some(
      (id) => typeof id !== "string" || !id.startsWith("int_"),
    ) ||
    new Set(value.interactionIds).size !== value.interactionIds.length
  ) {
    fail("invalid_flow", `${path} is invalid`);
  }
  stableId(value.id, "flow_", "invalid_flow_id", `${path}.id`);
  nonEmpty(value.name, "invalid_flow_name", `${path}.name`);
  return {
    id: value.id,
    interactionIds: [...value.interactionIds],
    name: value.name,
  };
}

function parseAnnotation(value, path) {
  if (!isRecord(value) || !Array.isArray(value.tags)) {
    fail("invalid_semantic_annotation", `${path} is invalid`);
  }
  const fields = new Set(["description", "id", "role", "tags", "target"]);
  if (Object.keys(value).some((field) => !fields.has(field))) {
    fail("invalid_semantic_annotation", `${path} fields are invalid`);
  }
  stableId(value.id, "ann_", "invalid_annotation_id", `${path}.id`);
  if (
    value.description !== undefined &&
    typeof value.description !== "string"
  ) {
    fail(
      "invalid_annotation_description",
      `${path}.description must be a string`,
    );
  }
  if (
    value.role !== undefined &&
    (typeof value.role !== "string" || value.role.length === 0)
  ) {
    fail("invalid_annotation_role", `${path}.role must be non-empty`);
  }
  if (
    value.tags.some((tag) => typeof tag !== "string" || tag.length === 0) ||
    new Set(value.tags).size !== value.tags.length
  ) {
    fail("invalid_annotation_tags", `${path}.tags must contain unique strings`);
  }
  return {
    ...(value.description === undefined
      ? {}
      : { description: value.description }),
    id: value.id,
    ...(value.role === undefined ? {} : { role: value.role }),
    tags: [...value.tags],
    target: parseDesignTarget(value.target, `${path}.target`),
  };
}

export function parseRequirementEntries(manifest, entries) {
  const annotations = new Map();
  const flows = new Map();
  const requirements = new Map();
  for (const entry of manifest.entries.requirements) {
    const value = entries[entry];
    if (
      !isRecord(value) ||
      Object.keys(value).length !== 3 ||
      !Array.isArray(value.annotations) ||
      !Array.isArray(value.flows) ||
      !Array.isArray(value.requirements)
    ) {
      fail(
        "invalid_requirement_file",
        `${entry} requires annotations, flows, and requirements arrays`,
      );
    }
    for (const [index, candidate] of value.annotations.entries()) {
      const annotation = parseAnnotation(
        candidate,
        `${entry}.annotations[${index}]`,
      );
      if (annotations.has(annotation.id)) {
        fail(
          "duplicate_annotation_id",
          `Duplicate Annotation id: ${annotation.id}`,
        );
      }
      annotations.set(annotation.id, annotation);
    }
    for (const [index, candidate] of value.flows.entries()) {
      const flow = parseFlow(candidate, `${entry}.flows[${index}]`);
      if (flows.has(flow.id)) {
        fail("duplicate_flow_id", `Duplicate Flow id: ${flow.id}`);
      }
      flows.set(flow.id, flow);
    }
    for (const [index, candidate] of value.requirements.entries()) {
      const requirement = parseRequirement(
        candidate,
        `${entry}.requirements[${index}]`,
      );
      if (requirements.has(requirement.id)) {
        fail(
          "duplicate_requirement_id",
          `Duplicate Requirement id: ${requirement.id}`,
        );
      }
      requirements.set(requirement.id, requirement);
    }
  }
  return { annotations, flows, requirements };
}
