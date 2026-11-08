import { fail } from "./errors.mjs";

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
