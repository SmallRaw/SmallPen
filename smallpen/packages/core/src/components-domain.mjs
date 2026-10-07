import { fail } from "./errors.mjs";
import {
  compareStrings,
  isRecord,
  MAX_NODE_DEPTH,
  ownValue,
  stableId,
} from "./internal.mjs";

// configuration: an option the designer picks (style, size, content).
// state: an interaction state the user causes (hover, pressed, disabled).
export const AXIS_ROLES = Object.freeze(["configuration", "state"]);

// The node types a Component variant may hold; Presentations also allow
// ELLIPSE, GROUP and PATH.
export const VARIANT_NODE_TYPES = Object.freeze([
  "COMPONENT",
  "COMPONENT_SET",
  "FRAME",
  "IMAGE",
  "INSTANCE",
  "RECTANGLE",
  "TEXT",
]);
const NODE_TYPES = new Set(VARIANT_NODE_TYPES);

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
    fail(
      "unsupported_node_type",
      `${path}.type ${JSON.stringify(nodeValue.type ?? null)} is unsupported in a Component variant. ` +
        `Variant node types: ${[...NODE_TYPES].join(", ")}` +
        (["ELLIPSE", "GROUP", "PATH"].includes(nodeValue.type)
          ? ` (${nodeValue.type} is allowed only in Screen Presentations; in a variant use a RECTANGLE ` +
            "with cornerRadius for a circle, a FRAME to group, an IMAGE for an icon)"
          : ""),
      { allowedValues: [...NODE_TYPES], path: `${path}.type`, type: nodeValue.type },
    );
  }
  nonEmpty(nodeValue.name, "invalid_node_name", `${path}.name`);
  for (const field of ["height", "width", "x", "y"]) {
    if (typeof nodeValue[field] !== "number" || !Number.isFinite(nodeValue[field])) {
      fail(
        "invalid_node_number",
        `${path}.${field} must be a finite number; received ${JSON.stringify(nodeValue[field]) ?? "nothing"}`,
        { path: `${path}.${field}` },
      );
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
  if (!isRecord(ownValue(nodesValue, rootId))) {
    fail("missing_root_node", `${path}.rootId does not exist`, { rootId });
  }
  const nodes = {};
  const parents = new Map();
  for (const [nodeId, nodeValue] of Object.entries(nodesValue)) {
    const node = validateNode(nodeValue, nodeId, `${path}.nodes.${nodeId}`);
    nodes[nodeId] = node;
    for (const childId of node.children) {
      if (!isRecord(ownValue(nodesValue, childId))) {
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
  // Single parents and a parentless root: a node met twice means a cycle.
  const visited = new Set();
  const stack = [[rootId, 1]];
  while (stack.length > 0) {
    const [nodeId, depth] = stack.pop();
    if (visited.has(nodeId)) fail("node_cycle", `Node cycle includes ${nodeId}`);
    if (depth > MAX_NODE_DEPTH) {
      fail(
        "node_tree_too_deep",
        `${path} is deeper than ${MAX_NODE_DEPTH} levels at ${nodeId}`,
        { maxDepth: MAX_NODE_DEPTH, nodeId },
      );
    }
    visited.add(nodeId);
    for (const childId of nodes[nodeId].children) stack.push([childId, depth + 1]);
  }
  if (visited.size !== Object.keys(nodes).length) {
    fail("orphan_node", `${path} contains nodes outside its root tree`);
  }
  return nodes;
}

function parseAxis(value, path) {
  if (!isRecord(value)) fail("invalid_variant_axis", `${path} is invalid`);
  stableId(value.id, "axis_", "invalid_variant_axis_id", `${path}.id`);
  const name = nonEmpty(value.name, "invalid_variant_axis_name", `${path}.name`);
  if (!AXIS_ROLES.includes(value.role)) {
    fail(
      "invalid_variant_axis_role",
      `${path}.role ${JSON.stringify(value.role ?? null)} is unsupported. Use ` +
        '"configuration" for authored options such as style, size, or ' +
        'content (primary/secondary), or "state" for interaction states ' +
        "such as hover or disabled (requires domain). See: smallpen schema component-set",
      { allowedValues: [...AXIS_ROLES], path: `${path}.role` },
    );
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
    fail(
      "missing_state_domain",
      `${path}.domain is required for a state Axis, for example ["default","hover","disabled"]`,
    );
  }
  return { ...(domain ? { domain } : {}), id: value.id, name, role: value.role };
}

function selectionKey(selection) {
  return Object.entries(selection)
    .sort(([left], [right]) => compareStrings(left, right))
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
      fail(
        "missing_variant_axis",
        `${path} must select ${axis.id}${axis.domain ? ` (one of ${axis.domain.join(", ")})` : ""}`,
      );
    }
    if (axis.domain && !axis.domain.includes(selection[axis.id])) {
      fail(
        "variant_outside_domain",
        `${path}.selection.${axis.id} ${JSON.stringify(selection[axis.id])} is outside the Axis domain: ` +
          axis.domain.join(", "),
        { allowedValues: [...axis.domain], path: `${path}.selection.${axis.id}` },
      );
    }
  }
  for (const axisId of Object.keys(selection)) {
    if (!axes.some((axis) => axis.id === axisId)) {
      fail(
        "unknown_variant_axis",
        `${path} selects unknown Axis ${axisId}; axes: ${axes.map(({ id }) => id).join(", ") || "none"}`,
      );
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
    fail(
      "invalid_component_visibility",
      `${path}.visibility must be "public" or "private"`,
      { allowedValues: ["private", "public"] },
    );
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

// The variant a stale selection is drawn with until it is repaired, by
// Penpot's variant distance: a differing Axis weighs more the earlier it is
// (2^(axes - index)); earlier variants win a tie, so with nothing in common
// it is the set's first variant. Deterministic, so every reader agrees.
export function closestComponentVariant(componentSet, selection) {
  const chosen = isRecord(selection) ? selection : {};
  const count = componentSet.axes.length;
  let best = componentSet.variants[0] ?? null;
  let bestDistance = Infinity;
  for (const variant of componentSet.variants) {
    const distance = componentSet.axes.reduce(
      (sum, axis, index) =>
        variant.selection[axis.id] === chosen[axis.id] ? sum : sum + 2 ** (count - index),
      0,
    );
    if (distance < bestDistance) {
      best = variant;
      bestDistance = distance;
    }
  }
  return best;
}

// A Package's Component Sets changed from `before` to `after`: the
// operations that keep `dependent`'s Instances on the same variants. A
// variant keeps its id when its values are renamed (in the editor or by
// put-component-set), so an Instance that selected its old values follows
// it to the new ones, as a Penpot copy follows its component. Instances of
// a deleted variant have nothing to follow and are left to Repair.
export function followedVariantOperations(before, after, dependent) {
  const ownerId = after.manifest.packageId;
  const moves = new Map();
  for (const [setId, oldSet] of before.domain?.componentSets ?? []) {
    const newSet = after.domain?.componentSets?.get(setId);
    if (!newSet) continue;
    for (const variant of oldSet.variants) {
      const next = newSet.variants.find(({ id }) => id === variant.id);
      if (next && selectionKey(next.selection) !== selectionKey(variant.selection)) {
        moves.set(`${setId}\0${selectionKey(variant.selection)}`, next.selection);
      }
    }
  }
  if (moves.size === 0) return [];
  const moved = (instance) =>
    instance?.component?.packageId === ownerId
      ? moves.get(`${instance.component.assetId}\0${selectionKey(instance.variant ?? {})}`)
      : undefined;
  const operations = [];
  for (const entry of dependent.manifest.entries.screens) {
    const screen = dependent.entries[entry];
    for (const presentation of screen.presentations) {
      for (const node of Object.values(presentation.nodes)) {
        const selection = moved(node.instance);
        if (!selection) continue;
        operations.push({
          nodeId: node.id,
          presentationId: presentation.id,
          screenId: screen.id,
          selection: structuredClone(selection),
          type: "select-instance-variant",
        });
      }
    }
  }
  for (const componentSet of dependent.domain?.componentSets?.values() ?? []) {
    for (const variant of componentSet.variants) {
      for (const node of Object.values(variant.nodes)) {
        const selection = moved(node.instance);
        if (!selection) continue;
        operations.push({
          changes: {
            instance: { ...structuredClone(node.instance), variant: structuredClone(selection) },
          },
          componentId: componentSet.id,
          nodeId: node.id,
          type: "update-component-node",
          unset: [],
          variantId: variant.id,
        });
      }
    }
  }
  return operations;
}

// Why `selection` matches no variant of `componentSet`, for errors and
// diagnostics: the Axis values that are wrong or missing, and the
// selections that exist.
export function variantMismatch(componentSet, selection) {
  const chosen = isRecord(selection) ? selection : {};
  const problems = [];
  for (const axis of componentSet.axes) {
    const used = [
      ...new Set(componentSet.variants.map((variant) => variant.selection[axis.id])),
    ];
    if (!Object.hasOwn(chosen, axis.id)) {
      problems.push(`${axis.id} is missing (values: ${used.join(", ")})`);
    } else if (!used.includes(chosen[axis.id])) {
      problems.push(
        `no variant selects ${axis.id} ${JSON.stringify(chosen[axis.id])} (values: ${used.join(", ")})`,
      );
    }
  }
  for (const axisId of Object.keys(chosen)) {
    if (!componentSet.axes.some(({ id }) => id === axisId)) {
      problems.push(
        `${axisId} is not an Axis of ${componentSet.id} (axes: ${componentSet.axes.map(({ id }) => id).join(", ") || "none"})`,
      );
    }
  }
  if (problems.length === 0) {
    problems.push("this combination of Axis values has no variant");
  }
  return {
    problems,
    validSelections: componentSet.variants.map((variant) =>
      structuredClone(variant.selection),
    ),
  };
}

export function variantMismatchText(componentSet, selection) {
  const { problems, validSelections } = variantMismatch(componentSet, selection);
  const shown = validSelections.slice(0, 12).map((value) => JSON.stringify(value));
  return (
    `${problems.join("; ")}. Variants of ${componentSet.id}: ${shown.join(", ") || "(none)"}` +
    (validSelections.length > shown.length ? `, ... (${validSelections.length} in all)` : "")
  );
}
