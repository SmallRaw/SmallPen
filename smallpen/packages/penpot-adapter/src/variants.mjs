// Penpot native variants <-> canonical Component Sets.
//
// The projection draws a Component Set with axes as a Penpot variant
// container (the set's runtime component id is the container shape id) whose
// children are the variant mains; a set without axes is a plain component.
// Penpot edits that structure through many small changes (add a variant,
// add/rename/remove a property, change a value, reorder, combine components
// as variants, delete a variant, undo of any of them). Translating each one
// separately would chase every upstream change of those operations, so this
// module is state based: it replays the commit on a model of the Components
// page, rebuilds every Component Set from the resulting Penpot state, and
// writes the sets that changed with one `put-component-set` each. Canonical
// ids survive for everything Penpot kept; new Penpot items get new stable
// ids, and the Penpot ids that now stand for canonical items are reported to
// the caller as session runtime ids so a reprojection keeps them.

import { fail } from "@smallpen/core";

import {
  canonicalAddedNode,
  canonicalDomainInstance,
  canonicalTreePlacement,
  domainInstanceSource,
  isRecord,
  normalizeType,
  parentAbsolutePlacement,
  penpotGeometryContext,
  penpotPlacement,
  PENPOT_DERIVED_ATTRIBUTES,
  PLACEMENT_ATTRIBUTES,
  presentationNodes,
  relativePlacement,
  ROOT_PLACEMENT,
  runtimeNodeId,
} from "./changes.mjs";

const ZERO = "00000000-0000-0000-0000-000000000000";
const STRUCTURE_CHANGE_TYPES = new Set([
  "add-obj",
  "del-obj",
  "mov-objects",
  "reorder-children",
]);
const COMPONENT_CHANGE_TYPES = new Set([
  "add-component",
  "del-component",
  "mod-component",
  "restore-component",
]);
// Shape attributes that only describe the variant structure; the rebuilt
// Component Set already says all of it.
const VARIANT_ATTRIBUTES = new Set([
  "is-variant-container",
  "variant-error",
  "variant-id",
  "variant-name",
]);
const PLACEMENT_EPSILON = 0.01;
// What Penpot sets on a shape it moves into or out of a board.
const RELOCATION_ATTRIBUTES = new Set([
  "constraints-h",
  "constraints-v",
  "fixed-scroll",
  "hide-in-viewer",
  "layout-item-absolute",
]);

function changeType(change) {
  return normalizeType(change?.type);
}

function changePageId(change) {
  return String(change?.pageId ?? change?.["page-id"] ?? "");
}

// Key order is not meaning: the Package writes canonical JSON.
function sortedJson(value) {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, sortedJson(value[key])]),
  );
}

function sameJson(left, right) {
  return JSON.stringify(sortedJson(left)) === JSON.stringify(sortedJson(right));
}

// Everything of a Component Set Penpot shows: what a rebuild can tell apart.
// Axis domains (their order, the values no variant uses) are SmallPen-only.
function setStructure(set) {
  return JSON.stringify(
    sortedJson({
      ...set,
      axes: set.axes.map(({ domain: _domain, ...axis }) => axis),
    }),
  );
}

// FNV-1a: a short session key for a set structure.
function structureKey(structure) {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < structure.length; index += 1) {
    hash ^= BigInt(structure.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `component-set-state:${hash.toString(16)}`;
}

function slug(value) {
  const text = String(value ?? "")
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return /^[a-z0-9_]+$/.test(text) && text.length > 0 ? text.slice(0, 48) : "";
}

function uniqueId(prefix, base, taken) {
  const stem = `${prefix}${base || "new"}`;
  let candidate = stem;
  for (let index = 2; taken.has(candidate); index += 1) {
    candidate = `${stem}_${index}`;
  }
  taken.add(candidate);
  return candidate;
}

// Penpot names repeated properties "Name (1)", "Name (2)"; the projection
// does the same, so a canonical axis is found again under that name.
function projectedAxisNames(axes) {
  const names = [];
  for (const axis of axes) {
    const base = axis.name;
    let name = base;
    for (let index = 1; names.includes(name); index += 1) {
      name = `${base} (${index})`;
    }
    names.push(name);
  }
  return names;
}

// Penpot paths: "/"-separated groups, trimmed, joined with " / ".
function splitPath(value) {
  return String(value ?? "")
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

// The projection files a set's components under its category (their Penpot
// path) and names the variant container and its mains after both, as
// Penpot requires: "Category / Name".
function projectedSetName(set) {
  const path = splitPath(set.category).join(" / ");
  return path.length > 0 ? `${path} / ${set.name}` : set.name;
}

// The name and category a renamed container gives its set. A container
// that keeps its projected name keeps both as stored.
function setNaming(oldSet, fullName) {
  if (oldSet && fullName === projectedSetName(oldSet)) {
    return { category: oldSet.category, name: oldSet.name };
  }
  const parts = splitPath(fullName);
  return {
    category: parts.length > 1 ? parts.slice(0, -1).join(" / ") : undefined,
    name: parts.at(-1) ?? fullName,
  };
}

function ownedComponentSets(snapshot) {
  const sets = new Map();
  for (const entry of snapshot.manifest.entries.components ?? []) {
    const value = snapshot.entries[entry];
    if (!Array.isArray(value?.componentSets)) continue;
    value.componentSets.forEach((set, index) => {
      if (typeof set?.id === "string") sets.set(set.id, { entry, index, set });
    });
  }
  return sets;
}

function isNestedInstance(node) {
  return node?.type === "INSTANCE" || isRecord(node?.instance);
}

// ---------------------------------------------------------------------------
// Instance variant switch (screens)

// Penpot switches a copy (the properties panel, the Plugin API) by deleting
// it and instantiating the chosen variant under the SAME root id, then
// carrying the overrides that still apply onto the fresh copy. The Instance
// node stays what it is: only its selection and its overrides change.
export function compileInstanceVariantSwitches(snapshot, changes, options = {}) {
  const deleted = new Set(
    changes
      .filter((change) => changeType(change) === "del-obj")
      .map((change) => String(change.id)),
  );
  const roots = new Map();
  for (const change of changes) {
    if (changeType(change) !== "add-obj" || !isRecord(change.obj)) continue;
    const runtimeId = String(change.id ?? change.obj.id);
    const descriptor = snapshot.runtime.reverseNodes?.[runtimeId];
    const page = snapshot.runtime.reversePages?.[changePageId(change)];
    if (!deleted.has(runtimeId) || !descriptor || !page) continue;
    if (
      descriptor.screenId !== page.screenId ||
      descriptor.presentationId !== page.presentationId
    ) {
      continue;
    }
    const node = presentationNodes(snapshot, page)?.[descriptor.nodeId];
    if (!isRecord(node?.instance)) continue;
    const source = domainInstanceSource(snapshot, change.obj);
    if (
      !source ||
      source.component.packageId !== node.instance.component?.packageId ||
      source.component.assetId !== node.instance.component?.assetId
    ) {
      continue;
    }
    roots.set(runtimeId, {
      change: { ...change, obj: structuredClone(change.obj) },
      node,
      page,
      source,
    });
  }
  if (roots.size === 0) return { changes, operations: [] };

  const children = new Map();
  for (const change of changes) {
    if (changeType(change) !== "add-obj" || !isRecord(change.obj)) continue;
    const runtimeId = String(change.id ?? change.obj.id);
    if (roots.has(runtimeId)) continue;
    const parentId = String(
      change["parent-id"] ?? change.parentId ?? change.obj["parent-id"],
    );
    const rootId = roots.has(parentId) ? parentId : children.get(parentId)?.rootId;
    if (rootId !== undefined) {
      children.set(runtimeId, { rootId, value: structuredClone(change.obj) });
    }
  }
  // The copy as the commit leaves it: later mod-obj changes carry the
  // overrides Penpot kept (text, fills, ...) onto the fresh shapes.
  const added = new Set();
  for (const change of changes) {
    if (changeType(change) === "add-obj") added.add(String(change.id ?? change.obj?.id));
    if (changeType(change) !== "mod-obj") continue;
    const runtimeId = String(change.id);
    // Edits of the old root before Penpot deletes it are not the new copy's.
    const value = added.has(runtimeId)
      ? (children.get(runtimeId)?.value ?? roots.get(runtimeId)?.change.obj)
      : undefined;
    if (!value) continue;
    for (const item of change.operations ?? []) {
      if (!isRecord(item)) continue;
      const type = normalizeType(item.type);
      if (type === "set") value[normalizeType(item.attr)] = item.val;
      else if (type === "unset") delete value[normalizeType(item.attr)];
    }
  }

  const operations = [];
  const geometry = penpotGeometryContext(changes);
  for (const [runtimeId, { change, node, page, source }] of roots) {
    const domain = {
      childNodeIds: new Map(),
      children,
      roots: new Map([[runtimeId, { ...source, nodeId: node.id }]]),
    };
    const built = canonicalDomainInstance(
      snapshot,
      change,
      page,
      { ...source, nodeId: node.id },
      parentAbsolutePlacement(snapshot, page, runtimeId, geometry),
      domain,
    );
    const target = {
      nodeId: node.id,
      presentationId: page.presentationId,
      screenId: page.screenId,
    };
    if (!sameJson(built.instance.variant, node.instance.variant ?? {})) {
      operations.push({
        ...target,
        selection: built.instance.variant,
        type: "select-instance-variant",
      });
    }
    const before = node.instance.overrides ?? {};
    const after = built.instance.overrides ?? {};
    for (const [overridePath, value] of Object.entries(after)) {
      if (!sameJson(before[overridePath], value)) {
        operations.push({
          ...target,
          overridePath,
          type: "set-instance-override",
          value,
        });
      }
    }
    for (const overridePath of Object.keys(before)) {
      if (!Object.hasOwn(after, overridePath)) {
        operations.push({
          ...target,
          overridePath,
          type: "clear-instance-override",
        });
      }
    }
    for (const [childId, descriptor] of domain.childNodeIds) {
      options.projectedRuntimeIds?.set(childId, descriptor);
    }
  }

  // Everything the swap sent is said by the operations above.
  const switchedNodes = new Map(
    [...roots.values()].map(({ node, page }) => [node.id, page]),
  );
  const oldCopyChild = (runtimeId) => {
    const descriptor = snapshot.runtime.reverseNodes?.[runtimeId];
    if (!descriptor) return false;
    const page = switchedNodes.get(descriptor.nodeId.split("__")[0]);
    return (
      page !== undefined &&
      descriptor.nodeId.includes("__") &&
      descriptor.screenId === page.screenId &&
      descriptor.presentationId === page.presentationId
    );
  };
  const swapped = (runtimeId) =>
    roots.has(runtimeId) || children.has(runtimeId);
  const remaining = [];
  for (const change of changes) {
    const type = changeType(change);
    const runtimeId = String(change?.id);
    // The old copy goes away: edits Penpot makes to its children before
    // deleting them (an undo resetting the overrides it carried) are gone too.
    const oldChild = oldCopyChild(runtimeId) && deleted.has(runtimeId);
    if (
      (type === "del-obj" && (swapped(runtimeId) || oldCopyChild(runtimeId))) ||
      (type === "mod-obj" && oldChild) ||
      ((type === "add-obj" || type === "mod-obj") && swapped(runtimeId))
    ) {
      continue;
    }
    if (type === "mov-objects" && Array.isArray(change.shapes)) {
      const shapes = change.shapes.filter((shape) => !swapped(String(shape)));
      if (shapes.length === 0) continue;
      if (shapes.length !== change.shapes.length) {
        remaining.push({ ...change, shapes });
        continue;
      }
    }
    remaining.push(change);
  }
  return { changes: remaining, operations };
}

// ---------------------------------------------------------------------------
// Components page model

function componentsPageChange(snapshot, change) {
  return (
    snapshot.runtime.componentsPage !== undefined &&
    changePageId(change) === String(snapshot.runtime.componentsPage)
  );
}

function variantComponentChange(snapshot, change) {
  const runtimeId = String(change?.id);
  if (snapshot.runtime.reverseVariants?.[runtimeId]) return true;
  if (snapshot.runtime.removedComponentItems?.[runtimeId]?.kind === "component") {
    return true;
  }
  if (componentsPageChange(snapshot, change)) return true;
  if (change?.["variant-id"] !== undefined && change["variant-id"] !== null) {
    return true;
  }
  const page = change?.["main-instance-page"] ?? change?.mainInstancePage;
  return (
    page !== undefined &&
    page !== null &&
    String(page) === String(snapshot.runtime.componentsPage)
  );
}

function variantModelChange(snapshot, change, model) {
  const type = changeType(change);
  if (COMPONENT_CHANGE_TYPES.has(type)) {
    return (
      variantComponentChange(snapshot, change) ||
      (model !== undefined && model.components.has(String(change.id)))
    );
  }
  return componentsPageChange(snapshot, change) && STRUCTURE_CHANGE_TYPES.has(type);
}

// Whether a commit touches the Components page or a variant component. Even
// a plain edit there goes through the page model: a main dragged across the
// page moves its whole tree, which is no edit of its nodes.
function touchesComponentSets(snapshot, changes) {
  return changes.some(
    (change) =>
      variantModelChange(snapshot, change) || componentsPageChange(snapshot, change),
  );
}

// The Components page as the projection drew it: one container per set with
// axes (first variant on top, Penpot's primary variant is the last child),
// one main per set without axes, and the component of every variant.
function initialModel(snapshot, owned) {
  const shapes = new Map();
  const components = new Map();
  const root = { children: [], id: ZERO };
  shapes.set(ZERO, root);
  const runtime = snapshot.runtime;
  for (const [setId, { set }] of [...owned].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    const containerId = set.axes.length > 0 ? runtime.components?.[setId] : undefined;
    if (set.axes.length > 0 && containerId === undefined) continue;
    const axisNames = projectedAxisNames(set.axes);
    const rootIds = [];
    for (const variant of set.variants) {
      const ids = runtime.componentNodes?.[setId]?.[variant.id] ?? {};
      const mainId = ids[variant.rootId];
      const componentId = runtime.variants?.[setId]?.[variant.id];
      if (mainId === undefined || componentId === undefined) continue;
      const walk = (nodeId, parentId) => {
        const node = variant.nodes[nodeId];
        const runtimeId = ids[nodeId];
        if (!node || runtimeId === undefined) return;
        shapes.set(runtimeId, {
          children: isNestedInstance(node)
            ? []
            : (node.children ?? []).map((childId) => ids[childId]).filter(Boolean),
          id: runtimeId,
          origin: { componentId: setId, nodeId, variantId: variant.id },
          parentId,
        });
        if (!isNestedInstance(node)) {
          for (const childId of node.children ?? []) walk(childId, runtimeId);
        }
      };
      walk(variant.rootId, containerId ?? ZERO);
      rootIds.push(mainId);
      components.set(componentId, {
        id: componentId,
        mainInstanceId: mainId,
        name: set.name,
        origin: { componentId: setId, variantId: variant.id },
        variantId: containerId ?? null,
        variantProperties:
          containerId === undefined
            ? null
            : set.axes.map((axis, index) => ({
                name: axisNames[index],
                value: String(variant.selection[axis.id] ?? ""),
              })),
      });
    }
    if (containerId !== undefined) {
      shapes.set(containerId, {
        attrs: { name: projectedSetName(set) },
        children: [...rootIds].reverse(),
        container: true,
        id: containerId,
        parentId: ZERO,
        setId,
      });
      root.children.push(containerId);
    } else {
      root.children.push(...rootIds);
    }
  }
  return { components, shapes };
}

function detach(model, runtimeId) {
  const shape = model.shapes.get(runtimeId);
  const parent = shape && model.shapes.get(shape.parentId);
  if (parent) parent.children = parent.children.filter((id) => id !== runtimeId);
}

function insertChildren(list, index, ids) {
  if (index === undefined || index === null) {
    return [...list, ...ids.filter((id) => !list.includes(id))];
  }
  const moving = new Set(ids);
  const before = list.slice(0, index).filter((id) => !moving.has(id));
  const after = list.slice(index).filter((id) => !moving.has(id));
  return [...before, ...ids, ...after];
}

function removeSubtree(model, runtimeId) {
  const shape = model.shapes.get(runtimeId);
  if (!shape) return;
  detach(model, runtimeId);
  const pending = [runtimeId];
  while (pending.length > 0) {
    const id = pending.pop();
    const current = model.shapes.get(id);
    if (!current) continue;
    pending.push(...current.children);
    model.removed.set(id, current);
    model.shapes.delete(id);
  }
}

// A variant component this session deleted, as it was then: an undo
// restores it by id alone.
function restoredComponent(snapshot, runtimeId) {
  const item = snapshot.runtime.removedComponentItems?.[runtimeId];
  return item?.kind === "component" ? structuredClone(item.component) : undefined;
}

function applyStructure(snapshot, model, change) {
  const type = changeType(change);
  if (type === "add-obj") {
    const obj = change.obj;
    if (!isRecord(obj)) {
      fail("invalid_penpot_node", "Penpot add-obj must contain obj");
    }
    const runtimeId = String(change.id ?? obj.id);
    const parentId = String(
      change["parent-id"] ?? change.parentId ?? obj["parent-id"] ?? ZERO,
    );
    // An undo restores a deleted shape under its old id: it is the same
    // canonical node again.
    const previous = model.removed.get(runtimeId);
    model.removed.delete(runtimeId);
    if (model.shapes.has(runtimeId)) removeSubtree(model, runtimeId);
    model.shapes.set(runtimeId, {
      attrs: {},
      children: [],
      id: runtimeId,
      obj: structuredClone(obj),
      origin: previous?.origin,
      parentId,
    });
    const parent = model.shapes.get(parentId);
    if (!parent) {
      fail(
        "variant_structure_unsupported",
        "A shape was added under a parent the Components page does not hold",
        { parentId },
      );
    }
    parent.children = insertChildren(parent.children, change.index, [runtimeId]);
  } else if (type === "del-obj") {
    removeSubtree(model, String(change.id));
  } else if (type === "mov-objects") {
    const parentId = String(change["parent-id"] ?? change.parentId);
    const parent = model.shapes.get(parentId);
    const shapes = (change.shapes ?? []).map(String);
    if (!parent || shapes.some((id) => !model.shapes.has(id))) {
      fail(
        "variant_structure_unsupported",
        "A move on the Components page names a shape it does not hold",
        { parentId },
      );
    }
    const afterShape = change["after-shape"] ?? change.afterShape;
    const afterIndex =
      afterShape === undefined || afterShape === null
        ? -1
        : parent.children.indexOf(String(afterShape));
    const index = afterIndex >= 0 ? afterIndex + 1 : change.index;
    parent.children = insertChildren(parent.children, index, shapes);
    for (const id of shapes) {
      const shape = model.shapes.get(id);
      if (shape.parentId !== parentId) {
        shape.relocated = true;
        const old = model.shapes.get(shape.parentId);
        if (old) old.children = old.children.filter((childId) => childId !== id);
        shape.parentId = parentId;
      }
    }
  } else if (type === "reorder-children") {
    const parent = model.shapes.get(String(change["parent-id"] ?? change.parentId));
    if (parent) {
      const shapes = (change.shapes ?? []).map(String);
      parent.children = [
        ...shapes.filter((id) => parent.children.includes(id)),
        ...parent.children.filter((id) => !shapes.includes(id)),
      ];
    }
  } else if (type === "add-component") {
    model.components.set(String(change.id), {
      added: true,
      id: String(change.id),
      mainInstanceId: String(change["main-instance-id"]),
      name: change.name,
      variantId: change["variant-id"] == null ? null : String(change["variant-id"]),
      variantProperties: change["variant-properties"] ?? null,
    });
  } else if (type === "mod-component") {
    const runtimeId = String(change.id);
    const component =
      model.components.get(runtimeId) ?? restoredComponent(snapshot, runtimeId);
    if (!component) return;
    model.components.set(runtimeId, component);
    if (change.name != null) component.name = change.name;
    if (change["main-instance-id"] != null) {
      component.mainInstanceId = String(change["main-instance-id"]);
    }
    // Penpot sends the whole component, so a missing variant id removes it
    // (ctkl/mod-component): the main left its container ("make no variant").
    // A main that stays in its container keeps it (metadata-only syncs).
    if (Object.hasOwn(change, "variant-id")) {
      component.variantId =
        change["variant-id"] == null ? null : String(change["variant-id"]);
      component.variantProperties = change["variant-properties"] ?? null;
      component.variantDropped = component.variantId === null;
    } else {
      component.variantDropped = true;
    }
  } else if (type === "del-component") {
    const component = model.components.get(String(change.id));
    if (component) component.deleted = true;
  } else if (type === "restore-component") {
    const runtimeId = String(change.id);
    const component =
      model.components.get(runtimeId) ?? restoredComponent(snapshot, runtimeId);
    if (component) {
      component.deleted = false;
      model.components.set(runtimeId, component);
    }
  }
}

function applyShapeAttributes(model, change) {
  const shape = model.shapes.get(String(change.id));
  if (!shape) return;
  for (const item of change.operations ?? []) {
    if (!isRecord(item)) continue;
    const type = normalizeType(item.type);
    const attr = normalizeType(item.attr);
    if (type === "set") {
      shape.attrs = { ...shape.attrs, [attr]: item.val };
      if (shape.obj) shape.obj[attr] = item.val;
    } else if (type === "unset") {
      shape.attrs = { ...shape.attrs, [attr]: undefined };
      if (shape.obj) delete shape.obj[attr];
    } else if (type === "set-touched" && shape.obj) {
      shape.obj.touched = item.touched;
    }
  }
}

function attribute(shape, attr) {
  if (shape.attrs && Object.hasOwn(shape.attrs, attr)) return shape.attrs[attr];
  return shape.obj?.[attr];
}

function isContainer(shape) {
  const value = attribute(shape, "is-variant-container");
  return value === undefined ? shape.container === true : value === true;
}

// ---------------------------------------------------------------------------
// Rebuilding the canonical Component Sets

function canonicalNodeAt(owned, origin) {
  if (!origin) return undefined;
  const variant = owned
    .get(origin.componentId)
    ?.set.variants.find(({ id }) => id === origin.variantId);
  const node = variant?.nodes?.[origin.nodeId];
  return node ? structuredClone(node) : undefined;
}

// The canonical node a new Penpot shape copies, when it carries the plugin
// data of a projected variant node (a duplicated variant keeps it).
function pluginOrigin(owned, obj) {
  const plugin = obj?.["plugin-data"]?.smallpen;
  if (!isRecord(plugin)) return undefined;
  const origin = {
    componentId: plugin["component-id"],
    nodeId: plugin["node-id"],
    variantId: plugin["variant-id"],
  };
  if (
    typeof origin.nodeId !== "string" ||
    origin.nodeId.includes("__") ||
    canonicalNodeAt(owned, origin) === undefined
  ) {
    return undefined;
  }
  return origin;
}

// Removed canonical items this session still remembers (an undo restores
// them exactly): nodes by the runtime id of their shape, sets by the runtime
// id of their container.
function removedItem(snapshot, runtimeId, kind) {
  const item = snapshot.runtime.removedComponentItems?.[runtimeId];
  return item?.kind === kind ? item : undefined;
}

function nodeTreeFor(snapshot, owned, model, mainId, geometry) {
  const nodes = {};
  const runtimeIds = new Map();
  const page = { presentationId: "__components", screenId: "__components" };
  // Penpot geometry of a shape in the canonical frame: a new shape's own
  // object (its layout offset already removed), else its canonical place.
  const absolute = (shape) => {
    if (shape.obj) {
      return penpotPlacement(
        shape.obj,
        ROOT_PLACEMENT,
        normalizeType(shape.obj.type) === "path",
      );
    }
    const variant = owned
      .get(shape.origin.componentId)
      .set.variants.find(({ id }) => id === shape.origin.variantId);
    const baseline =
      canonicalTreePlacement(variant.nodes, shape.origin.nodeId) ?? ROOT_PLACEMENT;
    const provided = geometry.values.get(shape.id);
    return provided
      ? penpotPlacement(provided, baseline, variant.nodes[shape.origin.nodeId].type === "PATH")
      : baseline;
  };
  const visit = (runtimeId, parentShape) => {
    const shape = model.shapes.get(runtimeId);
    if (!shape) return undefined;
    // A live canonical node, else one this session removed (an undo brings
    // it back), else the node a duplicate copies, else the Penpot object.
    let node = canonicalNodeAt(owned, shape.origin);
    if (!node && removedItem(snapshot, runtimeId, "node")) {
      node = structuredClone(removedItem(snapshot, runtimeId, "node").node);
    }
    node ??= canonicalNodeAt(owned, pluginOrigin(owned, shape.obj));
    if (!node) {
      if (shape.obj?.["component-id"] != null && parentShape !== undefined) {
        fail(
          "variant_nested_instance_unsupported",
          "Placing a component copy inside a variant is not supported yet; edit the Component Set with smallpen",
          { runtimeId },
        );
      }
      node = canonicalAddedNode(
        snapshot,
        { ...shape.obj, shapes: [] },
        page,
        runtimeId,
        parentShape ? absolute(parentShape) : ROOT_PLACEMENT,
      );
      for (const field of ["componentId", "componentVariantId", "sourceNodeId", "touched"]) {
        delete node[field];
      }
      if (parentShape === undefined) {
        node.type = "COMPONENT";
        node.x = 0;
        node.y = 0;
      } else if (node.type === "COMPONENT") {
        node.type = "FRAME";
      }
    }
    if (Object.hasOwn(nodes, node.id)) node.id = runtimeNodeId(runtimeId);
    nodes[node.id] = node;
    runtimeIds.set(node.id, runtimeId);
    if (isNestedInstance(node)) {
      node.children ??= [];
      return node.id;
    }
    node.children = shape.children
      .map((childId) => visit(childId, shape))
      .filter((childId) => childId !== undefined);
    return node.id;
  };
  const rootId = visit(mainId, undefined);
  return { nodes, rootId, runtimeIds };
}

// Penpot properties are positional. A property keeps the axis of the same
// (projected) name; the ones left pair with the remaining axes in order (a
// rename); any still left are new axes.
function matchAxes(oldAxes, names) {
  const oldNames = projectedAxisNames(oldAxes);
  const matched = names.map(() => undefined);
  const used = new Set();
  names.forEach((name, index) => {
    const found = oldNames.findIndex(
      (candidate, oldIndex) => candidate === name && !used.has(oldIndex),
    );
    if (found >= 0) {
      matched[index] = { axis: oldAxes[found], renamed: false };
      used.add(found);
    }
  });
  const unusedOld = oldAxes.filter((_, index) => !used.has(index));
  names.forEach((name, index) => {
    if (matched[index] !== undefined || unusedOld.length === 0) return;
    matched[index] = { axis: unusedOld.shift(), renamed: true };
  });
  return matched;
}

function rebuiltAxes(oldSet, names, values) {
  const takenAxisIds = new Set(oldSet?.axes.map(({ id }) => id) ?? []);
  return matchAxes(oldSet?.axes ?? [], names).map((match, index) => {
    const present = [...new Set(values.map((row) => row[index]))];
    if (!match) {
      return {
        domain: present,
        id: uniqueId("axis_", slug(names[index]), takenAxisIds),
        name: names[index],
        role: "configuration",
      };
    }
    const axis = structuredClone(match.axis);
    if (match.renamed) axis.name = names[index];
    if (axis.domain) {
      const before = new Set(
        oldSet.variants.map((variant) => variant.selection[axis.id]),
      );
      axis.domain = [
        ...axis.domain.filter((value) => present.includes(value) || !before.has(value)),
        ...present.filter((value) => !axis.domain.includes(value)),
      ];
    }
    return axis;
  });
}

function componentByMain(model, mainId) {
  for (const component of model.components.values()) {
    if (component.mainInstanceId === mainId && !component.deleted) return component;
  }
  return undefined;
}

function shapeName(shape, fallback) {
  const name = attribute(shape, "name");
  return typeof name === "string" && name.trim().length > 0 ? name.trim() : fallback;
}

// The variant a main shape is the root of, when it is the original main of
// an existing variant (not a duplicate carrying its plugin data).
function mainOrigin(owned, shape) {
  const origin = shape.origin;
  if (!origin) return undefined;
  const variant = owned
    .get(origin.componentId)
    ?.set.variants.find(({ id }) => id === origin.variantId);
  return variant?.rootId === origin.nodeId ? origin : undefined;
}

// Rebuilds every Component Set the Components page holds once the commit
// applies. Returns the sets by id, the sets the initial page held, and the
// canonical item each Penpot id now stands for.
function rebuildSets(snapshot, owned, model, geometry) {
  const sets = new Map();
  const runtimeIds = new Map();
  const takenSetIds = new Set([
    ...owned.keys(),
    ...Object.keys(snapshot.runtime.components ?? {}),
  ]);
  const claimedSets = new Set();
  const root = model.shapes.get(ZERO);

  const claimSet = (preferred, name) => {
    const setId =
      preferred !== undefined && !claimedSets.has(preferred)
        ? preferred
        : uniqueId("cmp_", slug(name), takenSetIds);
    claimedSets.add(setId);
    return setId;
  };

  const buildVariants = (setId, mains) => {
    const takenVariantIds = new Set();
    const ids = mains.map(() => undefined);
    // Original mains keep their variant ids, then restored ones (undo of a
    // delete); duplicates and new mains get new ids.
    mains.forEach(({ shape }, index) => {
      const origin = mainOrigin(owned, shape);
      if (origin && !takenVariantIds.has(origin.variantId)) {
        ids[index] = origin.variantId;
        takenVariantIds.add(origin.variantId);
      }
    });
    mains.forEach(({ shape }, index) => {
      const restored = removedItem(snapshot, shape.id, "node");
      if (
        ids[index] === undefined &&
        restored?.componentId === setId &&
        !takenVariantIds.has(restored.variantId)
      ) {
        ids[index] = restored.variantId;
        takenVariantIds.add(restored.variantId);
      }
    });
    return mains.map(({ component, shape, values }, index) => {
      const variantId =
        ids[index] ??
        uniqueId("var_", slug(values.length > 0 ? values.join("_") : "default"), takenVariantIds);
      const tree = nodeTreeFor(snapshot, owned, model, shape.id, geometry);
      runtimeIds.set(component.id, { componentId: setId, kind: "variant", variantId });
      for (const [nodeId, runtimeId] of tree.runtimeIds) {
        runtimeIds.set(runtimeId, {
          componentId: setId,
          kind: "component-node",
          nodeId,
          variantId,
        });
      }
      return { id: variantId, nodes: tree.nodes, rootId: tree.rootId, selection: {} };
    });
  };

  // Containers claim their set ids first: a main dragged out of a container
  // starts a new set, and after an undo of "combine as variants" each main
  // gets its own set back.
  const tops = root.children.map((id) => model.shapes.get(id)).filter(Boolean);
  const ordered = [...tops.filter(isContainer), ...tops.filter((shape) => !isContainer(shape))];
  const liveSetIds = new Set(
    tops.flatMap((shape) => [shape.setId, mainOrigin(owned, shape)?.componentId]).filter(Boolean),
  );
  for (const shape of ordered) {
    if (!isContainer(shape)) {
      const component = componentByMain(model, shape.id);
      if (!component) {
        fail(
          "component_page_shape_unsupported",
          "Only components can be placed on the Components page",
          { shapeId: shape.id },
        );
      }
      if (component.variantId !== null && !component.variantDropped) {
        fail("variant_outside_container", "A variant must stay inside its variant container", {
          shapeId: shape.id,
        });
      }
      const origin = mainOrigin(owned, shape);
      const restored = removedItem(snapshot, shape.id, "node");
      const name =
        typeof component.name === "string" && component.name.trim().length > 0
          ? component.name.trim()
          : "Component";
      const preferred =
        origin?.componentId ??
        (restored && !liveSetIds.has(restored.componentId)
          ? restored.componentId
          : undefined);
      const setId = claimSet(preferred, name);
      const oldSet = owned.get(setId)?.set;
      sets.set(setId, {
        ...structuredClone(oldSet ?? { visibility: "public" }),
        axes: [],
        id: setId,
        name,
        variants: buildVariants(setId, [{ component, shape, values: [] }]),
      });
      continue;
    }

    const mains = [...shape.children].reverse().map((mainId) => {
      const main = model.shapes.get(mainId);
      const component = main && componentByMain(model, mainId);
      if (!component || component.variantId !== shape.id) {
        fail(
          "variant_container_content_unsupported",
          "A variant container can only hold the mains of its variants",
          { containerId: shape.id, shapeId: mainId },
        );
      }
      return { component, shape: main };
    });
    const names = (mains[0]?.component.variantProperties ?? []).map(({ name }) =>
      String(name ?? "").trim(),
    );
    for (const main of mains) {
      const properties = main.component.variantProperties ?? [];
      if (!sameJson(properties.map(({ name }) => String(name ?? "").trim()), names)) {
        fail(
          "variant_properties_mismatch",
          "Every variant of a Component Set must have the same properties",
          { containerId: shape.id },
        );
      }
      main.values = properties.map(({ value }) => String(value ?? "").trim());
      const missing = main.values.findIndex((value) => value.length === 0);
      if (missing >= 0) {
        fail("variant_value_missing", `Every variant needs a value for ${names[missing]}`, {
          property: names[missing],
        });
      }
    }
    if (names.some((name) => name.length === 0) || new Set(names).size !== names.length) {
      fail("variant_property_name_invalid", "Property names must be unique and not empty", {
        containerId: shape.id,
      });
    }
    // Which set the container is: its own; after an undo, the set it was;
    // when combining components as variants, the set of the first former
    // plain component; else a new set.
    const restoredSet = removedItem(snapshot, shape.id, "set");
    let preferred = shape.setId ?? (restoredSet && !owned.has(restoredSet.componentId)
      ? restoredSet.componentId
      : undefined);
    if (preferred === undefined) {
      for (const { shape: main } of mains) {
        const origin = mainOrigin(owned, main);
        if (origin && owned.get(origin.componentId)?.set.axes.length === 0) {
          preferred = origin.componentId;
          break;
        }
      }
    }
    const fullName = shapeName(
      shape,
      owned.get(preferred) ? projectedSetName(owned.get(preferred).set) : "Component",
    );
    const setId = claimSet(preferred, setNaming(owned.get(preferred)?.set, fullName).name);
    const oldSet = owned.get(setId)?.set ?? restoredSet?.set;
    const { category, name } = setNaming(oldSet, fullName);
    const axes = rebuiltAxes(
      oldSet?.axes.length > 0 ? oldSet : undefined,
      names,
      mains.map(({ values }) => values),
    );
    const variants = buildVariants(setId, mains);
    mains.forEach(({ values }, index) => {
      variants[index].selection = Object.fromEntries(
        axes.map((axis, axisIndex) => [axis.id, values[axisIndex]]),
      );
    });
    const keys = variants.map(({ selection }) => selectionKey(selection));
    const duplicate = keys.findIndex((key, index) => keys.indexOf(key) !== index);
    if (duplicate >= 0) {
      fail(
        "variant_duplicate_selection",
        `Two variants of ${name} have the same property values (${mains[duplicate].values.join(", ")}); every variant needs its own combination`,
        { componentSetId: setId },
      );
    }
    const rebuilt = {
      ...structuredClone(oldSet ?? { visibility: "public" }),
      axes,
      id: setId,
      name,
      variants,
    };
    if (category === undefined) delete rebuilt.category;
    else rebuilt.category = category;
    sets.set(setId, rebuilt);
    if (snapshot.runtime.components?.[setId] !== shape.id) {
      runtimeIds.set(shape.id, { componentId: setId, kind: "component-set" });
    }
  }
  return { runtimeIds, sets };
}

// ---------------------------------------------------------------------------
// Instances of a changed set

function instanceUsers(snapshot) {
  const packageId = snapshot.manifest.packageId;
  const users = [];
  const owns = (node) =>
    isRecord(node?.instance) && node.instance.component?.packageId === packageId;
  for (const entry of snapshot.manifest.entries.screens ?? []) {
    const screen = snapshot.entries[entry];
    for (const [index, presentation] of (screen?.presentations ?? []).entries()) {
      for (const node of Object.values(presentation.nodes ?? {})) {
        if (!owns(node)) continue;
        users.push({
          kind: "screen",
          node,
          path: `${entry}.presentations[${index}].nodes.${node.id}.instance`,
          presentationId: presentation.id,
          screenId: screen.id,
        });
      }
    }
  }
  for (const { set } of ownedComponentSets(snapshot).values()) {
    for (const variant of set.variants) {
      for (const node of Object.values(variant.nodes ?? {})) {
        if (owns(node)) {
          users.push({ componentSetId: set.id, kind: "component", node, variantId: variant.id });
        }
      }
    }
  }
  return users;
}

function selectionKey(selection) {
  return Object.entries(selection ?? {})
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

// Instances of the changed or removed sets follow their variant: the same
// variant under its new selection, or in the set it was combined into. An
// Instance of a variant that no longer exists is refused, not left broken.
function instanceOperations(snapshot, owned, sets, changed, removed, runtimeIds) {
  const packageId = snapshot.manifest.packageId;
  const operations = [];
  for (const user of instanceUsers(snapshot)) {
    const { instance } = user.node;
    const oldSet = owned.get(instance.component.assetId)?.set;
    if (!oldSet || !(changed.has(oldSet.id) || removed.has(oldSet.id))) continue;
    const variant = oldSet.variants.find(
      ({ selection }) => selectionKey(selection) === selectionKey(instance.variant),
    );
    const moved =
      variant &&
      runtimeIds.get(snapshot.runtime.variants?.[oldSet.id]?.[variant.id] ?? "");
    const destinationSet = moved && sets.get(moved.componentId);
    const destination = destinationSet?.variants.find(({ id }) => id === moved.variantId);
    if (!destination) {
      fail(
        "variant_in_use",
        `${oldSet.name} is still used by ${user.node.name ?? user.node.id}; switch or delete that instance first`,
        { componentSetId: oldSet.id, nodeId: user.node.id },
      );
    }
    const next = {
      ...structuredClone(instance),
      component: { assetId: destinationSet.id, packageId },
      variant: structuredClone(destination.selection),
    };
    if (sameJson(next, instance)) continue;
    if (user.kind === "component") {
      const rewritten = sets.get(user.componentSetId);
      const node = rewritten?.variants.find(({ id }) => id === user.variantId)?.nodes[user.node.id];
      if (node && changed.has(user.componentSetId)) {
        // That set is rewritten in this batch: correct it in place.
        node.instance = next;
      } else {
        operations.push({
          changes: { instance: next },
          componentId: user.componentSetId,
          nodeId: user.node.id,
          type: "update-component-node",
          unset: [],
          variantId: user.variantId,
        });
      }
    } else if (next.component.assetId !== instance.component.assetId) {
      operations.push({
        action: "retarget-reference",
        referencePath: user.path,
        replacement: next,
        type: "repair-reference",
      });
    } else {
      operations.push({
        nodeId: user.node.id,
        presentationId: user.presentationId,
        screenId: user.screenId,
        selection: next.variant,
        type: "select-instance-variant",
      });
    }
  }
  return operations;
}

// ---------------------------------------------------------------------------
// Entry point

// What the node-level compiler still has to do with a mod-obj of the
// Components page: the content edits of variant nodes. Structure, variant
// attributes, container presentation and the place of variant mains are said
// by the rebuilt sets; a node that only moves with its main is no edit.
function variantNodeEdit(context, change) {
  const { geometry, model, owned, runtime, sets } = context;
  const runtimeId = String(change.id);
  const shape = model.shapes.get(runtimeId);
  // A shape the commit deletes takes its edits with it. Shapes the page
  // model never held (inside a nested Instance) are the node-level
  // compiler's to accept or refuse.
  if (!shape) return model.removed.has(runtimeId) ? undefined : change;
  if (isContainer(shape) || context.rebuilt.has(runtimeId)) return undefined;
  const main = context.mains.has(runtimeId);
  let operations = (change.operations ?? []).filter((item) => {
    if (!isRecord(item)) return true;
    const attr = normalizeType(item.attr);
    if (VARIANT_ATTRIBUTES.has(attr)) return false;
    if (!main) return true;
    // A main is no copy (touched means nothing on it), its place is the
    // page's, and Penpot's relocation defaults (moving it into or out of a
    // container) are no edit of the component.
    if (normalizeType(item.type) === "set-touched") return false;
    if (["name", "touched", "x", "y"].includes(attr)) return false;
    return !(shape.relocated && RELOCATION_ATTRIBUTES.has(attr));
  });
  const descriptor = runtime.reverseComponentNodes[runtimeId];
  const variant =
    descriptor &&
    (sets.get(descriptor.componentId) ?? owned.get(descriptor.componentId)?.set)?.variants.find(
      ({ id }) => id === descriptor.variantId,
    );
  const node = variant?.nodes[descriptor.nodeId];
  if (!main && node) {
    const parentNodeId = Object.values(variant.nodes).find((candidate) =>
      (candidate.children ?? []).includes(node.id),
    )?.id;
    const baseline = (nodeId) => canonicalTreePlacement(variant.nodes, nodeId) ?? ROOT_PLACEMENT;
    const provided = geometry.values.get(String(shape.parentId));
    const parentPlacement =
      parentNodeId === undefined
        ? ROOT_PLACEMENT
        : provided
          ? penpotPlacement(provided, baseline(parentNodeId), variant.nodes[parentNodeId].type === "PATH")
          : baseline(parentNodeId);
    context.parentPlacements.set(runtimeId, parentPlacement);
    const values = geometry.values.get(runtimeId);
    if (values) {
      const current = change["smallpen-parent"]?.child;
      const placement = penpotPlacement(
        values,
        isRecord(current) && Object.keys(current).length > 0
          ? penpotPlacement(current, ROOT_PLACEMENT, node.type === "PATH")
          : baseline(node.id),
        node.type === "PATH",
      );
      const relative = relativePlacement(parentPlacement, placement, [
        { flipX: node.flipX === true, flipY: node.flipY === true },
      ]);
      const near = (left, right) => Math.abs(left - right) < PLACEMENT_EPSILON;
      if (
        near(relative.x, node.x ?? 0) &&
        near(relative.y, node.y ?? 0) &&
        near(relative.rotation, node.rotation ?? 0) &&
        near(placement.width, node.width ?? 0) &&
        near(placement.height, node.height ?? 0)
      ) {
        operations = operations.filter(
          (item) =>
            !isRecord(item) ||
            !(
              PLACEMENT_ATTRIBUTES.has(normalizeType(item.attr)) ||
              PENPOT_DERIVED_ATTRIBUTES.has(normalizeType(item.attr))
            ),
        );
      }
    }
  }
  if (
    operations.every(
      (item) => isRecord(item) && PENPOT_DERIVED_ATTRIBUTES.has(normalizeType(item.attr)),
    )
  ) {
    return undefined;
  }
  return { ...change, operations };
}

// Replays the Component Set part of a commit (see the module comment).
// Returns the remaining changes for the node-level compiler, the operations
// that rewrite the changed sets, and the snapshot updated to the rebuilt sets
// so later node edits of the commit find the variants they address.
export function compileComponentSetState(snapshot, changes, options = {}) {
  if (!touchesComponentSets(snapshot, changes)) {
    return { changes, operations: [], snapshot };
  }
  const owned = ownedComponentSets(snapshot);
  const model = { ...initialModel(snapshot, owned), removed: new Map() };
  const initialSetIds = new Set(
    [...model.shapes.values()].flatMap((shape) =>
      shape.setId ? [shape.setId] : shape.origin ? [shape.origin.componentId] : [],
    ),
  );
  const consumed = new Set();
  for (const change of changes) {
    if (variantModelChange(snapshot, change, model)) {
      applyStructure(snapshot, model, change);
      consumed.add(change);
    } else if (changeType(change) === "mod-obj" && componentsPageChange(snapshot, change)) {
      applyShapeAttributes(model, change);
    }
  }
  const geometry = penpotGeometryContext(changes);
  const { runtimeIds, sets } = rebuildSets(snapshot, owned, model, geometry);
  // A set that comes back to a structure it had earlier this session (an
  // undo, a redo) comes back exactly, SmallPen-only metadata included.
  for (const [setId, set] of sets) {
    const structure = setStructure(set);
    const remembered = snapshot.runtime.componentSetStates?.[structureKey(structure)];
    if (remembered && setStructure(remembered) === structure) {
      sets.set(setId, structuredClone(remembered));
    }
  }
  const changed = new Set(
    [...sets].filter(([setId, set]) => !sameJson(set, owned.get(setId)?.set)).map(([setId]) => setId),
  );
  const removed = new Set([...initialSetIds].filter((setId) => !sets.has(setId)));

  // Session memory of what this commit removes, so an undo that brings the
  // shapes back restores the canonical items exactly.
  const kept = new Set(
    [...runtimeIds].filter(([, descriptor]) => descriptor.kind === "component-node").map(([id]) => id),
  );
  for (const setId of initialSetIds) {
    const { set } = owned.get(setId);
    for (const variant of set.variants) {
      for (const [nodeId, node] of Object.entries(variant.nodes)) {
        const runtimeId = snapshot.runtime.componentNodes?.[setId]?.[variant.id]?.[nodeId];
        if (runtimeId === undefined || kept.has(runtimeId)) continue;
        options.projectedRuntimeIds?.set(runtimeId, {
          componentId: setId,
          kind: "removed-component-node",
          node: structuredClone(node),
          variantId: variant.id,
        });
      }
    }
    for (const variant of set.variants) {
      const componentId = snapshot.runtime.variants?.[setId]?.[variant.id];
      const component = model.components.get(componentId);
      if (component && (component.deleted || !runtimeIds.has(componentId))) {
        options.projectedRuntimeIds?.set(componentId, {
          component: { ...structuredClone(component), deleted: false },
          componentId: setId,
          kind: "removed-component",
          variantId: variant.id,
        });
      }
    }
    if (removed.has(setId)) {
      const { entry, index } = owned.get(setId);
      options.projectedRuntimeIds?.set(`component-set-position:${setId}`, {
        componentId: setId,
        entry,
        index,
        kind: "component-set-position",
      });
    }
    const containerId = snapshot.runtime.components?.[setId];
    if (removed.has(setId) && set.axes.length > 0 && containerId !== undefined) {
      options.projectedRuntimeIds?.set(containerId, {
        componentId: setId,
        kind: "removed-component-set",
        set: { ...structuredClone(set), variants: [] },
      });
    }
  }

  for (const setId of [...changed, ...removed]) {
    const previous = owned.get(setId)?.set;
    if (previous) {
      options.projectedRuntimeIds?.set(structureKey(setStructure(previous)), {
        kind: "component-set-state",
        set: structuredClone(previous),
      });
    }
  }
  const operations = [];
  for (const setId of changed) {
    // A set this session removed goes back where it was (an undo).
    const position = owned.has(setId)
      ? undefined
      : snapshot.runtime.componentSetPositions?.[setId];
    const entry = position?.entry ?? snapshot.manifest.entries.components?.[0];
    const length = snapshot.entries[entry]?.componentSets?.length ?? 0;
    operations.push({
      componentSet: sets.get(setId),
      ...(owned.has(setId) || entry === undefined ? {} : { entry }),
      ...(position ? { index: Math.min(position.index, length) } : {}),
      type: "put-component-set",
    });
  }
  operations.push(...instanceOperations(snapshot, owned, sets, changed, removed, runtimeIds));
  for (const setId of removed) {
    operations.push({ componentId: setId, type: "delete-component-set" });
  }

  // The snapshot the rest of the commit compiles against.
  const working = { ...snapshot, entries: { ...snapshot.entries } };
  const writeSets = (entry, update) => {
    const value = { ...(working.entries[entry] ?? {}) };
    value.componentSets = update([...(value.componentSets ?? [])]);
    working.entries[entry] = value;
  };
  for (const setId of changed) {
    const location = owned.get(setId);
    const entry = location?.entry ?? snapshot.manifest.entries.components?.[0];
    if (!entry) continue;
    writeSets(entry, (list) => {
      if (location) list[location.index] = sets.get(setId);
      else list.push(sets.get(setId));
      return list;
    });
  }
  for (const setId of removed) {
    writeSets(owned.get(setId).entry, (list) => list.filter(({ id }) => id !== setId));
  }
  const runtime = {
    ...snapshot.runtime,
    reverseComponentNodes: { ...snapshot.runtime.reverseComponentNodes },
    reverseComponents: { ...snapshot.runtime.reverseComponents },
    reverseVariants: { ...snapshot.runtime.reverseVariants },
  };
  for (const [runtimeId, descriptor] of runtimeIds) {
    const { componentId, kind, nodeId, variantId } = descriptor;
    let current;
    if (kind === "component-node") {
      runtime.reverseComponentNodes[runtimeId] = { componentId, nodeId, variantId };
      current = snapshot.runtime.componentNodes?.[componentId]?.[variantId]?.[nodeId];
    } else if (kind === "variant") {
      runtime.reverseVariants[runtimeId] = { componentId, variantId };
      current = snapshot.runtime.variants?.[componentId]?.[variantId];
    } else {
      runtime.reverseComponents[runtimeId] = { componentId };
      current = snapshot.runtime.components?.[componentId];
    }
    if (current !== runtimeId) options.projectedRuntimeIds?.set(runtimeId, descriptor);
  }
  working.runtime = runtime;

  const context = {
    geometry,
    mains: new Set([...model.components.values()].map(({ mainInstanceId }) => mainInstanceId)),
    model,
    owned,
    parentPlacements: new Map(),
    // Shapes built from their Penpot objects already hold their final state.
    rebuilt: new Set(
      [...runtimeIds]
        .filter(([id, { kind }]) => {
          const shape = model.shapes.get(id);
          return (
            kind === "component-node" &&
            shape?.obj !== undefined &&
            !shape.origin &&
            !pluginOrigin(owned, shape.obj) &&
            !removedItem(snapshot, id, "node")
          );
        })
        .map(([id]) => id),
    ),
    runtime,
    sets,
  };
  const remaining = [];
  let dropped = false;
  for (const change of changes) {
    if (consumed.has(change)) continue;
    if (changeType(change) === "mod-obj" && componentsPageChange(snapshot, change)) {
      const edit = variantNodeEdit(context, change);
      if (edit) remaining.push(edit);
      else dropped = true;
    } else {
      remaining.push(change);
    }
  }
  working.variantParentPlacements = context.parentPlacements;
  return {
    accepted: consumed.size > 0 || operations.length > 0 || dropped,
    changes: remaining,
    operations,
    snapshot: working,
  };
}
