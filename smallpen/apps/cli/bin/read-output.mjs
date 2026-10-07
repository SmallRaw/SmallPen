import { SmallPenError } from "@smallpen/core";

// Public discovery fields are independent of the stored object shape.
export const DISCOVERY_ITEM_FIELDS = Object.freeze([
  "id",
  "name",
  "path",
  "type",
  "kind",
  "category",
  "packageId",
  "source",
  "revision",
  "screenId",
  "presentationId",
  "platform",
  "viewport",
  "variantCount",
  "presentationCount",
  "nodeCount",
]);

export const DISCOVERY_OUTPUT = Object.freeze({
  encoding: "compact-json",
  itemFields: DISCOVERY_ITEM_FIELDS,
  conditionalItemFields: {
    visibility:
      "Only private: reuse is limited to the owning package; omission means no restriction.",
    deprecated:
      "Only true: avoid new reuse; omission means no deprecation warning.",
    replacement:
      "Only a deprecated asset's replacement {packageId,assetId} when configured.",
  },
  definitions:
    "Descriptions, editable definitions and node trees require a target read or explicit --full.",
  compatibility:
    "Default items use this public allowlist, never stored-object passthrough. Consumers must allow omitted optional fields and use contractRevision to refresh schemas.",
});

export function reuseStatus(item) {
  return {
    ...(item.visibility === "private" ? { visibility: "private" } : {}),
    ...(item.deprecated === true ? { deprecated: true } : {}),
    ...(item.deprecated === true && item.replacement
      ? {
          replacement: {
            packageId: item.replacement.packageId,
            assetId: item.replacement.assetId,
          },
        }
      : {}),
  };
}

export function discoverySummary(item, status = item) {
  const summary = itemSummary(item);
  return {
    ...Object.fromEntries(
      DISCOVERY_ITEM_FIELDS.filter(
        (field) => summary[field] !== undefined && summary[field] !== "",
      ).map((field) => [
        field,
        field === "viewport"
          ? Object.fromEntries(
              ["width", "height", "scale"]
                .filter((key) => summary.viewport[key] !== undefined)
                .map((key) => [key, summary.viewport[key]]),
            )
          : summary[field],
      ]),
    ),
    ...reuseStatus(status),
  };
}

export function pageItems(items, { limit = 20, offset = 0 } = {}) {
  return {
    items: items.slice(offset, offset + limit),
    page: {
      hasMore: offset + limit < items.length,
      limit,
      offset,
      total: items.length,
    },
  };
}

// Discovery returns identities and counts. Definitions belong to target reads.
export function itemSummary(item) {
  const fields = [
    "id",
    "name",
    "path",
    "type",
    "kind",
    "category",
    "description",
    "packageId",
    "source",
    "revision",
    "rootId",
    "platform",
    "viewport",
    "screenId",
    "presentationId",
    "mainNodeId",
    "basePresentationId",
  ];
  return {
    ...Object.fromEntries(
      fields
        .filter((field) => item[field] !== undefined && item[field] !== "")
        .map((field) => [field, item[field]]),
    ),
    ...reuseStatus(item),
    ...(item.variants ? { variantCount: item.variants.length } : {}),
    ...(item.presentations
      ? { presentationCount: item.presentations.length }
      : {}),
    ...(item.nodes ? { nodeCount: Object.keys(item.nodes).length } : {}),
  };
}

export function packageSummary(snapshot) {
  const screens = snapshot.manifest.entries.screens.map(
    (entry) => snapshot.entries[entry],
  );
  const presentations = screens.flatMap((screen) => screen.presentations);
  return {
    packageId: snapshot.manifest.packageId,
    name: snapshot.manifest.name,
    role: snapshot.manifest.role,
    formatVersion: snapshot.manifest.formatVersion,
    defaultScreenId: snapshot.manifest.defaultScreenId,
    revision: snapshot.revision,
    counts: {
      components:
        snapshot.domain.componentSets.size +
        snapshot.domain.locatedComponents.size,
      contextAxes: snapshot.domain.contextAxes.size,
      contextProfiles: snapshot.domain.contextProfiles.size,
      flows: snapshot.domain.flows.size,
      nodes: presentations.reduce(
        (total, presentation) => total + Object.keys(presentation.nodes).length,
        0,
      ),
      presentations: presentations.length,
      requirements: snapshot.domain.requirements.size,
      scenarios: snapshot.domain.scenarios.size,
      screens: screens.length,
      tokens: snapshot.domain.tokens.size,
    },
  };
}

function missing(kind, id) {
  throw new SmallPenError("missing_read_target", `Unknown ${kind}: ${id}`, {
    id,
    kind,
  });
}


// A semantic read keeps one flat node list, with child IDs instead of subtrees.
export function semanticNodes(tree) {
  const nodes = [];
  const visit = (node) => {
    if (!node) return;
    nodes.push({
      ...node,
      children: (node.children ?? []).map((child) => child.id),
    });
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree.root);
  return nodes;
}

export function viewSummary(
  read,
  { nodeId, full = false, ...pagination } = {},
) {
  if (typeof read.result === "string" || read.format === "screenshot")
    return read;
  const projection = read.result;
  const nodes =
    read.format === "semantic"
      ? semanticNodes(projection)
      : Object.values(projection.nodes);
  const selected = nodeId ? nodes.filter((node) => node.id === nodeId) : nodes;
  if (nodeId && selected.length === 0) missing("projected node", nodeId);
  const { items, page } = pageItems(
    selected,
    nodeId
      ? { limit: 1 }
      : {
          ...pagination,
          limit: pagination.limit ?? (full ? selected.length : 20),
        },
  );
  const result =
    read.format === "semantic"
      ? { rootId: projection.root?.id, nodes: items, page }
      : {
          context: projection.context,
          diagnostics: projection.diagnostics,
          fallbackUsed: projection.fallbackUsed,
          nodes: Object.fromEntries(items.map((node) => [node.id, node])),
          page,
          presentation: itemSummary(projection.presentation ?? {}),
          rootId: projection.rootId,
          screen: itemSummary(projection.screen ?? {}),
        };
  const { discovery, ...details } = read;
  return { ...details, ...(!nodeId ? { discovery } : {}), result };
}

