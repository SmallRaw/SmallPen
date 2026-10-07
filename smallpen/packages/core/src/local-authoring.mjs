import { fail } from "./errors.mjs";
import { isRecord, ownValue, stableId } from "./internal.mjs";

function input(value, fields) {
  if (!isRecord(value))
    fail("invalid_authoring_intent", "An intent must be an object");
  const unknown = Object.keys(value).filter((key) => !fields.includes(key));
  if (unknown.length)
    fail("unknown_authoring_field", `Unknown fields: ${unknown.join(", ")}`, {
      allowedFields: fields,
    });
}
function insertionIndex(index, length) {
  if (index === undefined) return length;
  if (!Number.isInteger(index) || index < 0 || index > length)
    fail("invalid_node_index", `index must be between 0 and ${length}`);
  return index;
}

export const COMPONENT_EDIT_ACTIONS = Object.freeze({
  "update-component": {
    fields: ["componentId", "changes", "unset?"],
    purpose:
      "Partially edit name, axes, category, description, visibility, deprecated, replacement or replaces",
  },
  "update-variant": {
    fields: ["componentId", "variantId", "changes"],
    purpose: "Change one variant's selection while preserving its node tree",
  },
  "reorder-variants": {
    fields: ["componentId", "variantIds"],
    purpose:
      "Supply every current variant once; the first becomes the App primary variant",
  },
  "add-node": {
    fields: ["componentId", "variantId", "parentId", "node", "index?"],
    purpose:
      "Add one node under a container; program preserves the rest of the variant",
  },
  "update-node": {
    fields: ["componentId", "variantId", "nodeId", "changes", "unset?"],
    purpose: "Partially update one node using update-component-node fields",
  },
  "move-node": {
    fields: ["componentId", "variantId", "nodeId", "parentId", "index?"],
    purpose: "Move a subtree to a container; reject cycles and root moves",
  },
  "delete-node": {
    fields: ["componentId", "variantId", "nodeId"],
    purpose:
      "Remove a subtree; referenced content is protected by atomic validation",
  },
  "reorder-children": {
    fields: ["componentId", "variantId", "parentId", "childIds"],
    purpose: "Supply every current child once, in Penpot layer order",
  },
});

export function componentIntentOperations(snapshot, intent) {
  const contract = ownValue(COMPONENT_EDIT_ACTIONS, intent?.action);
  if (!contract)
    fail(
      "invalid_component_intent",
      "Use an action listed in schema component-edit-intent",
      { allowedActions: Object.keys(COMPONENT_EDIT_ACTIONS) },
    );
  input(intent, [
    "action",
    ...contract.fields.map((field) => field.replace(/\?$/, "")),
  ]);
  const stored = snapshot.manifest.entries.components
    .flatMap((entry) => snapshot.entries[entry].componentSets ?? [])
    .find((set) => set.id === intent.componentId);
  const set = stored ?? snapshot.domain.componentSets.get(intent.componentId);
  if (!set)
    fail(
      "missing_component",
      `No locally owned Component ${intent.componentId}`,
    );
  if (intent.action === "update-component") {
    const fields = [
      "name",
      "axes",
      "category",
      "description",
      "visibility",
      "deprecated",
      "replacement",
      "replaces",
    ];
    input(intent.changes, fields);
    if (
      intent.unset !== undefined &&
      (!Array.isArray(intent.unset) ||
        intent.unset.some((field) => !fields.includes(field)))
    )
      fail(
        "unknown_authoring_field",
        "unset must contain editable component fields",
      );
    const componentSet = {
      ...structuredClone(set),
      ...structuredClone(intent.changes),
    };
    for (const field of intent.unset ?? []) delete componentSet[field];
    return [{ type: "put-component-set", componentSet }];
  }
  if (intent.action === "reorder-variants") {
    const ids = intent.variantIds;
    if (
      !Array.isArray(ids) ||
      ids.length !== set.variants.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !set.variants.some((v) => v.id === id))
    )
      fail(
        "invalid_variant_order",
        "variantIds must contain each current variant exactly once",
      );
    return [
      {
        type: "put-component-set",
        componentSet: {
          ...structuredClone(set),
          variants: ids.map((id) =>
            structuredClone(set.variants.find((v) => v.id === id)),
          ),
        },
      },
    ];
  }
  const original = set.variants.find(
    (variant) => variant.id === intent.variantId,
  );
  if (!original)
    fail("missing_variant", `No Variant ${intent.variantId}`, {
      validVariantIds: set.variants.map((v) => v.id),
    });
  if (intent.action === "update-variant") {
    input(intent.changes, ["selection"]);
    return [
      {
        type: "put-variant",
        componentId: set.id,
        variant: {
          ...structuredClone(original),
          ...structuredClone(intent.changes),
        },
      },
    ];
  }
  if (intent.action === "update-node")
    return [
      {
        type: "update-component-node",
        componentId: set.id,
        variantId: original.id,
        nodeId: intent.nodeId,
        changes: intent.changes,
        ...(intent.unset ? { unset: intent.unset } : {}),
      },
    ];
  const variant = structuredClone(original),
    nodes = variant.nodes;
  const node = (id) =>
    ownValue(nodes, id) ?? fail("missing_node", `No Variant Node ${id}`);
  const container = (id) => {
    const result = node(id);
    if (!["FRAME", "COMPONENT", "COMPONENT_SET"].includes(result.type))
      fail("invalid_node_parent", `Node ${id} is not a container`);
    return result;
  };
  const descendants = (id) => [id, ...node(id).children.flatMap(descendants)];
  const detach = (id) => {
    if (id === variant.rootId)
      fail(
        "invalid_node_move",
        "The component root cannot be moved or deleted",
      );
    for (const parent of Object.values(nodes))
      parent.children = parent.children.filter((child) => child !== id);
  };
  if (intent.action === "add-node") {
    if (!isRecord(intent.node)) fail("invalid_node", "node must be an object");
    const id = stableId(intent.node.id, "node_", "invalid_node_id", "node.id");
    if (ownValue(nodes, id))
      fail("duplicate_node_id", `Node ${id} already exists`);
    if ((intent.node.children ?? []).length)
      fail(
        "invalid_node_children",
        "Add a node with empty children, then add its children separately",
      );
    const parent = container(intent.parentId);
    parent.children.splice(
      insertionIndex(intent.index, parent.children.length),
      0,
      id,
    );
    nodes[id] = { ...structuredClone(intent.node), children: [] };
  } else if (intent.action === "move-node") {
    if (descendants(intent.nodeId).includes(intent.parentId))
      fail(
        "invalid_node_move",
        "A node cannot move inside itself or its descendants",
      );
    const parent = container(intent.parentId);
    detach(intent.nodeId);
    parent.children.splice(
      insertionIndex(intent.index, parent.children.length),
      0,
      intent.nodeId,
    );
  } else if (intent.action === "delete-node") {
    const ids = descendants(intent.nodeId);
    detach(intent.nodeId);
    for (const id of ids) delete nodes[id];
  } else {
    const parent = container(intent.parentId),
      ids = intent.childIds;
    if (
      !Array.isArray(ids) ||
      ids.length !== parent.children.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !parent.children.includes(id))
    )
      fail(
        "invalid_child_order",
        "childIds must contain each current child exactly once",
      );
    parent.children = [...ids];
  }
  return [{ type: "put-variant", componentId: set.id, variant }];
}

export const ASSET_KINDS = Object.freeze([
  "colors",
  "fonts",
  "media",
  "typographies",
]);
export const ASSET_EDIT_FIELDS = Object.freeze({
  colors: ["name", "path", "paint"],
  fonts: ["family"],
  media: ["name", "path"],
  typographies: ["name", "path", "style"],
  fontVariant: ["name", "style", "weight"],
});
export function listAssets(snapshot, { kind, assetId } = {}) {
  if (kind && !ASSET_KINDS.includes(kind))
    fail("invalid_asset_kind", "Use colors, fonts, media or typographies");
  return snapshot.manifest.entries.assets.flatMap((entry) =>
    (kind ? [kind] : ASSET_KINDS).flatMap((k) =>
      snapshot.entries[entry][k]
        .filter((asset) => !assetId || asset.id === assetId)
        .map((asset) => ({
          packageId: snapshot.manifest.packageId,
          entry,
          kind: k,
          asset: structuredClone(asset),
        })),
    ),
  );
}
export function assetIntentOperations(snapshot, intent) {
  input(intent, [
    "action",
    "kind",
    "assetId",
    "asset",
    "changes",
    "variantId",
    "entry",
  ]);
  if (
    !ASSET_KINDS.includes(intent.kind) ||
    !["put", "update", "delete"].includes(intent.action)
  )
    fail(
      "invalid_asset_intent",
      "Use put/update/delete with colors/fonts/media/typographies",
    );
  const id = intent.action === "put" ? intent.asset?.id : intent.assetId;
  if (typeof id !== "string" || !id)
    fail(
      "invalid_asset_intent",
      "put requires asset.id; update/delete require assetId",
    );
  const allowed =
    intent.action === "put"
      ? ["action", "kind", "asset", "entry"]
      : intent.action === "update"
        ? ["action", "kind", "assetId", "changes", "variantId", "entry"]
        : ["action", "kind", "assetId", "variantId", "entry"];
  input(intent, allowed);
  const matches = listAssets(snapshot, {
    kind: intent.kind,
    assetId: id,
  }).filter((item) => !intent.entry || item.entry === intent.entry);
  if (matches.length > 1)
    fail("ambiguous_asset", "Pass entry to select the asset library", {
      entries: matches.map((item) => item.entry),
    });
  const entry =
    matches[0]?.entry ??
    intent.entry ??
    snapshot.manifest.entries.assets[0] ??
    "assets/assets.json";
  if (
    snapshot.entries[entry] &&
    !snapshot.manifest.entries.assets.includes(entry)
  )
    fail("invalid_asset_entry", "entry is not an Asset Library");
  const library = structuredClone(
    snapshot.entries[entry] ?? {
      id: "alib_local",
      colors: [],
      fonts: [],
      media: [],
      typographies: [],
    },
  );
  const assets = library[intent.kind],
    index = assets.findIndex((asset) => asset.id === id);
  if (intent.action === "put") {
    if (!["colors", "typographies"].includes(intent.kind))
      fail(
        "invalid_asset_intent",
        "Use font import or media import to create binary assets",
      );
    if (!isRecord(intent.asset))
      fail("invalid_asset_intent", "put requires an asset object");
    if (index < 0) assets.push(structuredClone(intent.asset));
    else assets[index] = structuredClone(intent.asset);
  } else {
    if (index < 0) fail("missing_asset", `No ${intent.kind} asset ${id}`);
    let target = assets[index];
    const variantIndex = intent.variantId
      ? target.variants?.findIndex((v) => v.id === intent.variantId)
      : undefined;
    if (
      intent.variantId &&
      (intent.kind !== "fonts" ||
        variantIndex === undefined ||
        variantIndex < 0)
    )
      fail("missing_font_variant", `No Font Variant ${intent.variantId}`);
    if (intent.action === "delete") {
      if (variantIndex !== undefined) {
        target.variants.splice(variantIndex, 1);
        if (!target.variants.length) assets.splice(index, 1);
      } else assets.splice(index, 1);
    } else {
      const fields =
        ASSET_EDIT_FIELDS[
          variantIndex === undefined ? intent.kind : "fontVariant"
        ];
      input(intent.changes, fields);
      if (variantIndex !== undefined) target = target.variants[variantIndex];
      const changes = structuredClone(intent.changes);
      if (intent.kind === "typographies" && changes.style !== undefined) {
        if (!isRecord(changes.style))
          fail(
            "invalid_asset_intent",
            "Typography style changes must be an object",
          );
        changes.style = { ...target.style, ...changes.style };
      }
      Object.assign(target, changes);
    }
  }
  return [{ type: "replace-asset-library", entry, library }];
}
