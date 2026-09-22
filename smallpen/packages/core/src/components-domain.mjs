import { fail } from "./errors.mjs";

const NODE_TYPES = new Set([
  "COMPONENT",
  "COMPONENT_SET",
  "FRAME",
  "IMAGE",
  "INSTANCE",
  "RECTANGLE",
  "TEXT",
]);

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
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(code, `${path} must be a non-empty string`, { path, value });
  }
  return value.trim();
}

function assetReference(value, path, prefix) {
  if (value === undefined) return undefined;
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

function stringRecord(value, code, path) {
  if (!isRecord(value)) fail(code, `${path} must contain an object`, { path });
  for (const [field, child] of Object.entries(value)) {
    if (field.length === 0 || typeof child !== "string" || child.length === 0) {
      fail(code, `${path} must map strings to strings`, { path });
    }
  }
  return structuredClone(value);
}

function validateNode(nodeValue, nodeId, path) {
  if (!isRecord(nodeValue) || nodeValue.id !== nodeId) {
    fail("node_id_mismatch", `${path} key and id must match`, { nodeId, path });
  }
  stableId(nodeId, "node_", "invalid_node_id", `${path}.id`);
  if (!NODE_TYPES.has(nodeValue.type)) {
    fail("unsupported_node_type", `${path}.type is unsupported`, {
      path: `${path}.type`,
      type: nodeValue.type,
    });
  }
  nonEmpty(nodeValue.name, "invalid_node_name", `${path}.name`);
  for (const field of ["height", "width", "x", "y"]) {
    if (typeof nodeValue[field] !== "number" || !Number.isFinite(nodeValue[field])) {
      fail("invalid_node_number", `${path}.${field} must be finite`, {
        path: `${path}.${field}`,
      });
    }
  }
  if (!Array.isArray(nodeValue.children)) {
    fail("invalid_node_children", `${path}.children must be an array`);
  }
  if (new Set(nodeValue.children).size !== nodeValue.children.length) {
    fail("duplicate_node_child", `${path}.children contains duplicates`);
  }
  if (nodeValue.tokenBindings !== undefined) {
    const bindings = stringRecordObject(
      nodeValue.tokenBindings,
      "invalid_token_bindings",
      `${path}.tokenBindings`,
    );
    for (const [field, reference] of Object.entries(bindings)) {
      assetReference(reference, `${path}.tokenBindings.${field}`, "tok_");
    }
  }
  if (nodeValue.instance !== undefined) {
    const instance = nodeValue.instance;
    if (!isRecord(instance) || nodeValue.type !== "INSTANCE") {
      fail("invalid_component_instance", `${path}.instance is invalid`);
    }
    assetReference(instance.component, `${path}.instance.component`, "cmp_");
    stringRecord(
      instance.variant,
      "invalid_component_variant_selection",
      `${path}.instance.variant`,
    );
  }
  if (nodeValue.type === "TEXT" && typeof nodeValue.text !== "string") {
    fail("invalid_text_content", `${path}.text must be a string`);
  }
  return structuredClone(nodeValue);
}

function stringRecordObject(value, code, path) {
  if (!isRecord(value)) fail(code, `${path} must contain an object`, { path });
  return value;
}

function validateNodeTree(nodesValue, rootId, path) {
  if (!isRecord(nodesValue)) {
    fail("invalid_variant_nodes", `${path}.nodes must contain an object`);
  }
  stableId(rootId, "node_", "invalid_node_id", `${path}.rootId`);
  if (!nodesValue[rootId]) {
    fail("missing_root_node", `${path}.rootId does not exist`, { rootId });
  }
  const nodes = {};
  const parents = new Map();
  for (const [nodeId, nodeValue] of Object.entries(nodesValue)) {
    const node = validateNode(nodeValue, nodeId, `${path}.nodes.${nodeId}`);
    nodes[nodeId] = node;
    for (const childId of node.children) {
      if (!nodesValue[childId]) {
        fail("missing_child_node", `Node child does not exist: ${childId}`);
      }
      if (parents.has(childId)) {
        fail("multiple_node_parents", `Node has more than one parent: ${childId}`);
      }
      parents.set(childId, nodeId);
    }
  }
  if (parents.has(rootId)) {
    fail("root_node_has_parent", `Variant root has a parent: ${rootId}`);
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (nodeId) => {
    if (visiting.has(nodeId)) fail("node_cycle", `Node cycle includes ${nodeId}`);
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const childId of nodes[nodeId].children) visit(childId);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  visit(rootId);
  if (visited.size !== Object.keys(nodes).length) {
    fail("orphan_node", `${path} contains nodes outside its root tree`);
  }
  return nodes;
}

function parseAxis(value, path) {
  if (!isRecord(value)) fail("invalid_variant_axis", `${path} is invalid`);
  stableId(value.id, "axis_", "invalid_variant_axis_id", `${path}.id`);
  const name = nonEmpty(value.name, "invalid_variant_axis_name", `${path}.name`);
  if (value.role !== "configuration" && value.role !== "state") {
    fail("invalid_variant_axis_role", `${path}.role is unsupported`);
  }
  let domain;
  if (value.domain !== undefined) {
    if (
      !Array.isArray(value.domain) ||
      value.domain.length === 0 ||
      value.domain.some((entry) => typeof entry !== "string" || entry.length === 0) ||
      new Set(value.domain).size !== value.domain.length
    ) {
      fail("invalid_variant_axis_domain", `${path}.domain is invalid`);
    }
    domain = [...value.domain];
  }
  if (value.role === "state" && !domain) {
    fail("missing_state_domain", `${path}.domain is required for a state Axis`);
  }
  return { ...(domain ? { domain } : {}), id: value.id, name, role: value.role };
}

function selectionKey(selection) {
  return Object.entries(selection)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function parseVariant(value, axes, path) {
  if (!isRecord(value)) fail("invalid_variant", `${path} is invalid`);
  stableId(value.id, "var_", "invalid_variant_id", `${path}.id`);
  const selection = stringRecord(
    value.selection,
    "invalid_variant_selection",
    `${path}.selection`,
  );
  for (const axis of axes) {
    if (!Object.hasOwn(selection, axis.id)) {
      fail("missing_variant_axis", `${path} must select ${axis.id}`);
    }
    if (axis.domain && !axis.domain.includes(selection[axis.id])) {
      fail(
        "variant_outside_domain",
        `${path}.selection.${axis.id} is outside the Axis domain`,
      );
    }
  }
  for (const axisId of Object.keys(selection)) {
    if (!axes.some((axis) => axis.id === axisId)) {
      fail("unknown_variant_axis", `${path} selects unknown Axis ${axisId}`);
    }
  }
  return {
    id: value.id,
    nodes: validateNodeTree(value.nodes, value.rootId, path),
    rootId: value.rootId,
    selection,
  };
}

function optionalText(value, code, path) {
  if (value === undefined) return undefined;
  return nonEmpty(value, code, path);
}

function parseComponentSet(value, path) {
  if (!isRecord(value)) fail("invalid_component_set", `${path} is invalid`);
  stableId(value.id, "cmp_", "invalid_component_id", `${path}.id`);
  const name = nonEmpty(value.name, "invalid_component_name", `${path}.name`);
  if (!Array.isArray(value.axes) || !Array.isArray(value.variants)) {
    fail("invalid_component_set", `${path} requires axes and variants arrays`);
  }
  const axes = value.axes.map((axis, index) =>
    parseAxis(axis, `${path}.axes[${index}]`),
  );
  if (new Set(axes.map(({ id }) => id)).size !== axes.length) {
    fail("duplicate_variant_axis", `${path}.axes contains duplicate ids`);
  }
  const variants = value.variants.map((variant, index) =>
    parseVariant(variant, axes, `${path}.variants[${index}]`),
  );
  if (new Set(variants.map(({ id }) => id)).size !== variants.length) {
    fail("duplicate_variant_id", `${path}.variants contains duplicate ids`);
  }
  const selections = variants.map(({ selection }) => selectionKey(selection));
  if (new Set(selections).size !== selections.length) {
    fail(
      "duplicate_variant_selection",
      `${path}.variants contains duplicate selections`,
    );
  }
  if (
    value.visibility !== undefined &&
    value.visibility !== "private" &&
    value.visibility !== "public"
  ) {
    fail("invalid_component_visibility", `${path}.visibility is invalid`);
  }
  if (value.deprecated !== undefined && typeof value.deprecated !== "boolean") {
    fail("invalid_component_deprecated", `${path}.deprecated must be boolean`);
  }
  return {
    axes,
    category: optionalText(
      value.category,
      "invalid_component_category",
      `${path}.category`,
    ),
    deprecated: value.deprecated === true,
    description: optionalText(
      value.description,
      "invalid_component_description",
      `${path}.description`,
    ),
    id: value.id,
    name,
    replacement: assetReference(value.replacement, `${path}.replacement`, "cmp_"),
    replaces: assetReference(value.replaces, `${path}.replaces`, "cmp_"),
    variants,
    visibility: value.visibility === "private" ? "private" : "public",
  };
}

export function parseComponentEntries(manifest, entries) {
  const componentSets = new Map();
  const locatedComponents = new Map();
  for (const entry of manifest.entries.components) {
    const value = entries[entry];
    if (Array.isArray(value?.componentSets)) {
      for (const [index, candidate] of value.componentSets.entries()) {
        const componentSet = parseComponentSet(
          candidate,
          `${entry}.componentSets[${index}]`,
        );
        if (componentSets.has(componentSet.id)) {
          fail(
            "duplicate_component_id",
            `Duplicate Component id: ${componentSet.id}`,
          );
        }
        componentSets.set(componentSet.id, componentSet);
      }
    } else {
      if (componentSets.has(value.id) || locatedComponents.has(value.id)) {
        fail("duplicate_component_id", `Duplicate Component id: ${value.id}`);
      }
      locatedComponents.set(value.id, value);
    }
  }
  for (const id of locatedComponents.keys()) {
    if (componentSets.has(id)) {
      fail("duplicate_component_id", `Duplicate Component id: ${id}`);
    }
  }
  return { componentSets, locatedComponents };
}

export function findComponentVariant(componentSet, selection, options = {}) {
  const key = selectionKey(selection);
  const exact = componentSet.variants.find(
    (variant) => selectionKey(variant.selection) === key,
  );
  if (exact) return { fallbackUsed: false, variant: exact };
  return {
    fallbackUsed: options.allowPreviewFallback === true,
    variant:
      options.allowPreviewFallback === true
        ? (componentSet.variants[0] ?? null)
        : null,
  };
}
