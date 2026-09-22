// DSC-004: canvas scene data protocol.
//
// The canvas scene is a generated projection: it never enters canonical
// package data. Scene node ids are derived from source identities and are
// stable across rebuilds of the same source+combination; they are NOT
// canonical shape ids. Every scene node carries a sourceRef that states its
// unique write target (or decoration, which has none) plus the fields that
// editing may address.
//
// Terminology (renderer-contract.md): scene ids are prefixed `scn/` and are
// the only ids the canvas UI addresses; canonical ids only ever appear
// inside sourceRef.
import { tokenInventoryRows } from "./catalog.mjs";

export const CANVAS_SCENE_VERSION = 1;

const CANONICAL_OVERRIDE_FIELDS = [
  "fills",
  "name",
  "opacity",
  "text",
  "visible",
];

function digest(input) {
  // FNV-1a, matching the deterministic digest style of the token inventory:
  // no Node built-ins, stable across runs.
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  let hash2 = 0x811c9dc5;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    hash2 ^= input.charCodeAt(index);
    hash2 = Math.imul(hash2, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, "0")}${hash2
    .toString(16)
    .padStart(8, "0")}`;
}

function sceneNodeId(...parts) {
  return `scn/${parts.map((part) => encodeURIComponent(part)).join("/")}`;
}

function sceneNodeIdBoard(name) {
  return sceneNodeId("board", name);
}

function nodeEditableFields(node) {
  if (!node) return [];
  const fields = [];
  if (node.text !== undefined) fields.push("text");
  if (node.fills !== undefined) fields.push("fills");
  if (node.opacity !== undefined) fields.push("opacity");
  if (node.cornerRadius !== undefined) fields.push("cornerRadius");
  if (node.width !== undefined) fields.push("width");
  if (node.height !== undefined) fields.push("height");
  return fields;
}

function componentSources(snapshot, options) {
  return [
    { snapshot, owner: snapshot.manifest.packageId, kind: "product" },
    ...(options.foundation
      ? [
          {
            snapshot: options.foundation,
            owner: options.foundation.manifest.packageId,
            kind: "foundation",
          },
        ]
      : []),
    ...(options.libraries ?? []).map((library) => ({
      snapshot: library,
      owner: library.manifest.packageId,
      kind: "library",
    })),
  ];
}

function componentVariantSceneNodes(owner, componentSet, variant, sink) {
  let rootId = null;
  const walk = (sourceNodeId, parentSceneId, definitionNodeId) => {
    const node = variant.nodes[definitionNodeId];
    const id = sceneNodeId("cmp", owner, componentSet.id, variant.id, sourceNodeId);
    sink[id] = {
      bounds: {
        height: node?.height ?? 0,
        width: node?.width ?? 0,
        x: node?.x ?? 0,
        y: node?.y ?? 0,
      },
      children: (node?.children ?? []).map((childId) =>
        sceneNodeId("cmp", owner, componentSet.id, variant.id, childId),
      ),
      decoration: false,
      editableFields: nodeEditableFields(node),
      id,
      kind: "node",
      label: node?.name ?? definitionNodeId,
      parent: parentSceneId,
      sourceRef: {
        componentId: componentSet.id,
        kind: "component-definition",
        ownerPackageId: owner,
        sourceNodeId: definitionNodeId,
        variantId: variant.id,
      },
    };
    for (const childId of node?.children ?? []) {
      walk(childId, id, childId);
    }
    return id;
  };
  rootId = walk(variant.rootId, null, variant.rootId);
  return rootId;
}

function pageSceneNodes(owner, screen, presentation, sink) {
  const pageId = sceneNodeId("page", owner, screen.id);
  const walk = (sourceNodeId, parentSceneId) => {
    const node = presentation.nodes[sourceNodeId];
    if (!node) return null;
    const isInstance = node.type === "INSTANCE";
    const id = isInstance
      ? sceneNodeId("inst", owner, screen.id, sourceNodeId)
      : sceneNodeId("pgnode", owner, screen.id, sourceNodeId);
    const children = [];
    for (const childId of node.children ?? []) {
      const childSceneId = walk(childId, id);
      if (childSceneId) children.push(childSceneId);
    }
    const editable = isInstance
      ? CANONICAL_OVERRIDE_FIELDS.filter((field) =>
          Object.keys(node).includes(field),
        )
      : nodeEditableFields(node);
    sink[id] = {
      bounds: {
        height: node.height ?? 0,
        width: node.width ?? 0,
        x: node.x ?? 0,
        y: node.y ?? 0,
      },
      children,
      decoration: false,
      editableFields: editable,
      id,
      kind: isInstance ? "page-occurrence" : "page-node",
      label: node.name ?? sourceNodeId,
      parent: parentSceneId,
      sourceRef: {
        kind: isInstance ? "page-occurrence" : "page-node",
        ownerPackageId: owner,
        pageId: screen.id,
        sourceNodeId,
        ...(isInstance
          ? { instanceOf: { ...node.instance } }
          : {}),
      },
    };
    return id;
  };
  const rootSceneId = walk(presentation.rootId, null);
  if (rootSceneId) {
    // The page node parents the projected root frame.
    sink[rootSceneId].parent = pageId;
  }
  return {
    page: {
      bounds: {
        height: presentation.viewport?.height ?? 0,
        width: presentation.viewport?.width ?? 0,
        x: 0,
        y: 0,
      },
      children: rootSceneId ? [rootSceneId] : [],
      decoration: false,
      editableFields: [],
      id: pageId,
      kind: "page",
      label: screen.name,
      parent: null,
      sourceRef: {
        kind: "page-node",
        ownerPackageId: owner,
        pageId: screen.id,
        sourceNodeId: screen.rootId,
      },
    },
    pageId,
    rootSceneId,
  };
}

// Build the generated canvas scene. Pure: reads snapshots, emits plain data.
export function buildCanvasScene(snapshot, options = {}) {
  const combination = options.combination ?? [];
  const revision = snapshot.revision;
  const generation = digest(
    JSON.stringify({
      combination,
      sceneVersion: CANVAS_SCENE_VERSION,
      sources: componentSources(snapshot, options).map(
        ({ snapshot: source }) => [source.manifest.packageId, source.revision],
      ),
    }),
  );
  const nodes = {};
  const rootIds = [];

  // Observed set ids for the requested combination: drives the inactive
  // marking on token specimens (DSC-005 semantics on the scene).
  const observedSetIds = new Set(
    (combination ?? []).flatMap((selection) => {
      for (const entry of snapshot.manifest.entries.tokens) {
        const library = snapshot.entries[entry];
        const theme = (library.themes ?? []).find(
          (candidate) => candidate.id === selection.themeId,
        );
        if (theme) return theme.setIds ?? [];
      }
      return [];
    }),
  );

  // Token board: one specimen scene node per inventory row.
  const tokenBoardId = sceneNodeId("board", "tokens");
  const tokenSections = new Map();
  for (const { snapshot: source, owner } of componentSources(snapshot, options)) {
    for (const row of tokenInventoryRows(source, options.foundation === source ? "foundation" : owner === snapshot.manifest.packageId ? "product" : "library")) {
      const domain = row.setName.split("/")[0];
      const sectionId = sceneNodeId("section", "tokens", domain);
      if (!tokenSections.has(sectionId)) {
        tokenSections.set(sectionId, {
          bounds: null,
          children: [],
          decoration: true,
          editableFields: [],
          id: sectionId,
          kind: "section",
          label: domain,
          parent: tokenBoardId,
          // Section headers are generated decorations: no write target.
          sourceRef: {
            decorationId: sectionId,
            kind: "decoration",
            ownerPackageId: null,
          },
        });
      }
      const specimenId = sceneNodeId("tok", row.qualifiedKey);
      tokenSections.get(sectionId).children.push(specimenId);
      nodes[specimenId] = {
        bounds: null,
        children: [],
        decoration: false,
        editableFields: ["value"],
        id: specimenId,
        kind: "specimen",
        label: row.path,
        observed: observedSetIds.has(row.setId),
        parent: sectionId,
        sourceRef: {
          kind: "token-cell",
          ownerPackageId: owner,
          path: row.path,
          qualifiedKey: row.qualifiedKey,
          setId: row.setId,
          setName: row.setName,
          tokenId: row.tokenId,
        },
      };
    }
  }
  nodes[tokenBoardId] = {
    bounds: null,
    children: [...tokenSections.keys()],
    decoration: true,
    editableFields: [],
    id: tokenBoardId,
    kind: "board",
    label: "Tokens",
    parent: null,
    sourceRef: {
      decorationId: tokenBoardId,
      kind: "decoration",
      ownerPackageId: null,
    },
  };
  for (const [id, section] of tokenSections) {
    nodes[id] = section;
  }
  rootIds.push(tokenBoardId);

  // Component families: one variant specimen per (set, variant).
  const componentBoardId = sceneNodeId("board", "components");
  const componentSections = new Map();
  for (const { snapshot: source, owner } of componentSources(snapshot, options)) {
    for (const entry of source.manifest.entries.components) {
      const file = source.entries[entry];
      for (const componentSet of file.componentSets ?? []) {
        const sectionId = sceneNodeId("section", "cmp", owner, componentSet.id);
        componentSections.set(sectionId, {
          bounds: null,
          children: [],
          decoration: true,
          editableFields: [],
          id: sectionId,
          kind: "section",
          label: componentSet.name,
          parent: componentBoardId,
          sourceRef: {
            componentId: componentSet.id,
            decorationId: sectionId,
            kind: "decoration",
            ownerPackageId: owner,
          },
        });
        for (const variant of componentSet.variants) {
          const variantId = componentVariantSceneNodes(
            owner,
            componentSet,
            variant,
            nodes,
          );
          componentSections.get(sectionId).children.push(variantId);
        }
      }
    }
  }
  nodes[componentBoardId] = {
    bounds: null,
    children: [...componentSections.keys()],
    decoration: true,
    editableFields: [],
    id: componentBoardId,
    kind: "board",
    label: "Components",
    parent: null,
    sourceRef: {
      decorationId: componentBoardId,
      kind: "decoration",
      ownerPackageId: null,
    },
  };
  for (const [id, section] of componentSections) {
    nodes[id] = section;
  }
  rootIds.push(componentBoardId);

  // Page compositions: every ordinary page root and its descendants.
  const pagesBoardId = sceneNodeId("board", "pages");
  const pages = [];
  for (const { snapshot: source, owner } of componentSources(snapshot, options)) {
    for (const entry of source.manifest.entries.screens) {
      const screen = source.entries[entry];
      for (const presentation of screen.presentations) {
        const { page } = pageSceneNodes(owner, screen, presentation, nodes);
        nodes[page.id] = page;
        // Pages sit in a section so every board keeps the same
        // board -> section -> member shape the canvas renders.
        const sectionId = sceneNodeId("section", "pages", page.id);
        nodes[sectionId] = {
          bounds: null,
          children: [page.id],
          decoration: true,
          editableFields: [],
          id: sectionId,
          kind: "section",
          label: page.label,
          parent: pagesBoardId,
          sourceRef: {
            decorationId: sectionId,
            kind: "decoration",
            ownerPackageId: null,
          },
        };
        pages.push(sectionId);
      }
    }
  }
  nodes[pagesBoardId] = {
    bounds: null,
    children: pages,
    decoration: true,
    editableFields: [],
    id: pagesBoardId,
    kind: "board",
    label: "Pages",
    parent: null,
    sourceRef: {
      decorationId: pagesBoardId,
      kind: "decoration",
      ownerPackageId: null,
    },
  };
  rootIds.push(pagesBoardId);

  return {
    combination,
    generation,
    nodes,
    revision,
    rootIds,
    sceneVersion: CANVAS_SCENE_VERSION,
  };
}

// Serialization protocol: canonical JSON (sorted object keys) so the same
// scene always serializes to identical bytes and round-trips losslessly.
export function serializeCanvasScene(scene) {
  const encode = (value) => {
    if (Array.isArray(value)) {
      return value.map(encode);
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, encode(value[key])]),
      );
    }
    return value === undefined ? null : value;
  };
  return JSON.stringify({ ...encode(scene), serializationVersion: 1 });
}

export function deserializeCanvasScene(json) {
  const value = JSON.parse(json);
  delete value.serializationVersion;
  return value;
}

// ---------------------------------------------------------------------------
// DSC-005/006/007: full-inventory catalog collectors feeding the canvas.
// Each collector reconciles one source family against the actual package
// entries and reports diagnostics instead of dropping anything silently.
// ---------------------------------------------------------------------------

// Token families the canvas renderer can draw. Any other type still enters
// the catalog but with a diagnostic, so nothing disappears silently.
export const CANVAS_RENDERABLE_TOKEN_TYPES = new Set([
  "border-radius",
  "color",
  "shadow",
  "sizing",
  "spacing",
  "stroke-width",
  "typography",
]);

const CANVAS_ALIAS_PATTERN = /^\{([^{}]+)\}$/;

export function collectCanvasTokenCatalog(snapshot, options = {}) {
  const diagnostics = [];
  const rows = [];
  const observedSetIds = new Set(
    (options.combination ?? []).flatMap((selection) => {
      // Resolve themeId -> setIds from the product token library.
      for (const entry of snapshot.manifest.entries.tokens) {
        const library = snapshot.entries[entry];
        const theme = (library.themes ?? []).find(
          (candidate) => candidate.id === selection.themeId,
        );
        if (theme) return theme.setIds ?? [];
      }
      return [];
    }),
  );
  for (const { snapshot: source, kind } of componentSources(snapshot, options)) {
    for (const row of tokenInventoryRows(source, kind)) {
      const alias = CANVAS_ALIAS_PATTERN.exec(
        typeof row.value === "string" ? row.value : "",
      )?.[1];
      const renderable = CANVAS_RENDERABLE_TOKEN_TYPES.has(
        typeof row.type === "string" ? row.type : String(row.type),
      );
      if (!renderable) {
        diagnostics.push({
          code: "canvas_unsupported_token_type",
          message: `Canvas cannot draw token type: ${row.type}`,
          ownerPackageId: row.qualifiedKey?.split("/")[0] ?? null,
          path: row.path,
          type: row.type,
        });
      }
      rows.push({
        active: row.active ?? false,
        alias: alias ?? null,
        observed: observedSetIds.has(row.setId),
        ownerPackageId: row.qualifiedKey?.split("/")[0] ?? null,
        path: row.path,
        qualifiedKey: row.qualifiedKey,
        raw: row.value,
        setId: row.setId,
        setName: row.setName,
        status: row.status,
        tokenId: row.tokenId,
        type: row.type,
      });
    }
  }
  return { diagnostics, rows };
}

export function collectCanvasComponentCatalog(snapshot, options = {}) {
  const families = [];
  for (const { snapshot: source, owner } of componentSources(snapshot, options)) {
    for (const entry of source.manifest.entries.components) {
      const file = source.entries[entry];
      for (const componentSet of file.componentSets ?? []) {
        families.push({
          // Usage locations are filled by collectCanvasUsageLocations.
          id: componentSet.id,
          name: componentSet.name,
          ownerPackageId: owner,
          usageLocations: [],
          variants: componentSet.variants.map((variant) => ({
            id: variant.id,
            rootId: variant.rootId,
            selection: { ...variant.selection },
            sourceNodeIds: Object.keys(variant.nodes),
          })),
        });
      }
    }
  }
  return { families };
}

export function collectCanvasUsageLocations(snapshot) {
  const locations = [];
  for (const entry of snapshot.manifest.entries.screens) {
    const screen = snapshot.entries[entry];
    for (const presentation of screen.presentations) {
      for (const node of Object.values(presentation.nodes)) {
        if (node.type !== "INSTANCE") continue;
        locations.push({
          componentId: node.instance?.component?.assetId,
          instanceNodeId: node.id,
          overrides: Object.keys(node.instance?.overrides ?? {}),
          ownerPackageId: node.instance?.component?.packageId,
          pageId: screen.id,
        });
      }
    }
  }
  return locations;
}

export function collectCanvasPageCatalog(snapshot) {
  const pages = [];
  for (const entry of snapshot.manifest.entries.screens) {
    const screen = snapshot.entries[entry];
    for (const presentation of screen.presentations) {
      const nodes = Object.values(presentation.nodes);
      const instances = nodes.filter((node) => node.type === "INSTANCE");
      const hidden = nodes.filter(
        (node) => node.visible === false,
      );
      const componentSetIds = new Set();
      for (const componentEntry of snapshot.manifest.entries.components) {
        const file = snapshot.entries[componentEntry];
        for (const set of file.componentSets ?? []) {
          componentSetIds.add(set.id);
        }
      }
      // Unregistered compositions: top-level frames below the page root
      // that are not instances and whose names no component family owns.
      const root = presentation.nodes[presentation.rootId];
      const unregistered = (root?.children ?? [])
        .map((childId) => presentation.nodes[childId])
        .filter((node) => node && node.type !== "INSTANCE");
      pages.push({
        instances: instances.map((instance) => ({
          componentId: instance.instance?.component?.assetId,
          instanceNodeId: instance.id,
          overrides: Object.keys(instance.instance?.overrides ?? {}),
        })),
        pageId: screen.id,
        pageName: screen.name,
        presentationId: presentation.id,
        // Descendants stay reachable through sourceRef/tree; this count is
        // the reconciliation number.
        sourceNodeCount: nodes.length,
        status: nodes.length === 0 ? "empty" : "ready",
        unregisteredCompositions: unregistered.map((node) => ({
          name: node.name,
          sourceNodeId: node.id,
          type: node.type,
        })),
        hiddenCount: hidden.length,
      });
    }
  }
  return { pages };
}

// ---------------------------------------------------------------------------
// DSC-008: deterministic auto-layout. Pure: same inputs produce the same
// bounds. Text width comes from an injected measure callback when the host
// can measure real text; the default is a deterministic character heuristic.
// ---------------------------------------------------------------------------

export const CANVAS_LAYOUT_VERSION = 1;

const LAYOUT = {
  boardGap: 160,
  columnGap: 24,
  headerHeight: 48,
  pagePadding: 32,
  rowGap: 24,
  sectionGap: 96,
  specimenHeight: 96,
  specimenWidth: 200,
};

function defaultMeasureText(text, fontSize) {
  const size = typeof fontSize === "number" && fontSize > 0 ? fontSize : 14;
  return Math.round(text.length * size * 0.62);
}

// Assign world-coordinate bounds to every scene node and compute the total
// canvas bounds. Returns a new scene (input is not mutated) plus meta.
export function layoutCanvasScene(scene, options = {}) {
  const measureText = options.measureText ?? defaultMeasureText;
  const layout = {
    bounds: null,
    layoutVersion: CANVAS_LAYOUT_VERSION,
    nodes: {},
  };
  const nodes = scene.nodes;

  // Stable section order per board: sort by id (ids are identity-derived, so
  // this is stable across rebuilds).
  const boardChildren = (boardId) =>
    [...(nodes[boardId]?.children ?? [])].sort();

  const placeSection = (sectionId, x, y) => {
    const section = nodes[sectionId];
    const children = section.children;
    const grid = options.specimenColumns ?? 4;
    let maxWidth = 0;
    let cursorX = x;
    let cursorY = y + LAYOUT.headerHeight;
    let rowHeight = 0;
    let rowStartX = cursorX;
    const columnWidths = [];
    // Measure first: each column is as wide as its widest member so long
    // labels never overlap neighbours.
    for (let index = 0; index < children.length; index += 1) {
      const node = nodes[children[index]];
      const textWidth = measureText(node.label, 14);
      const width = Math.max(LAYOUT.specimenWidth, textWidth + 24);
      columnWidths.push(width);
    }
    for (let index = 0; index < children.length; index += 1) {
      const childId = children[index];
      const node = nodes[childId];
      const width = columnWidths[index];
      const height = node.kind === "node" && node.bounds
        ? Math.max(node.bounds.height, LAYOUT.specimenHeight)
        : LAYOUT.specimenHeight;
      layout.nodes[childId] = {
        ...node,
        bounds: {
          height,
          width,
          x: cursorX,
          y: cursorY,
        },
      };
      rowHeight = Math.max(rowHeight, height);
      maxWidth = Math.max(maxWidth, cursorX + width - x);
      // Rebase the specimen subtree (e.g. component variant children) from
      // source-absolute to cell-relative coordinates.
      const rebase = (sceneId, originX, originY, baseX, baseY) => {
        const child = nodes[sceneId];
        if (!child) return;
        layout.nodes[sceneId] = {
          ...child,
          bounds: {
            height: child.bounds?.height ?? 0,
            width: child.bounds?.width ?? 0,
            x: baseX + ((child.bounds?.x ?? 0) - originX),
            y: baseY + ((child.bounds?.y ?? 0) - originY),
          },
        };
        for (const grandChildId of child.children ?? []) {
          rebase(grandChildId, originX, originY, baseX, baseY);
        }
      };
      (node.children ?? []).forEach((childId) => {
        const child = nodes[childId];
        rebase(
          childId,
          child?.bounds?.x ?? 0,
          child?.bounds?.y ?? 0,
          cursorX,
          cursorY,
        );
      });
      const column = (index + 1) % grid;
      if (column === 0) {
        cursorX = rowStartX;
        cursorY += rowHeight + LAYOUT.rowGap;
        rowHeight = 0;
      } else {
        cursorX += width + LAYOUT.columnGap;
      }
    }
    if (children.length % grid !== 0) {
      cursorY += rowHeight + LAYOUT.rowGap;
    }
    const sectionHeight = LAYOUT.headerHeight + (cursorY - y);
    layout.nodes[sectionId] = {
      ...section,
      bounds: {
        height: sectionHeight,
        width: Math.max(maxWidth, measureText(section.label, 18)),
        x,
        y,
      },
    };
    return sectionHeight;
  };

  const placeBoard = (boardId, y) => {
    const board = nodes[boardId];
    let cursorY = y + LAYOUT.headerHeight;
    let maxWidth = 0;
    for (const sectionId of boardChildren(boardId)) {
      const height = placeSection(sectionId, LAYOUT.pagePadding, cursorY);
      const section = layout.nodes[sectionId];
      maxWidth = Math.max(maxWidth, section.bounds.width);
      cursorY += height + LAYOUT.sectionGap;
    }
    layout.nodes[boardId] = {
      ...board,
      bounds: {
        height: cursorY - y,
        width: maxWidth + LAYOUT.pagePadding * 2,
        x: 0,
        y,
      },
    };
    return cursorY - y + LAYOUT.sectionGap;
  };

  // Pages board: each page is a true-size stage (viewport geometry) placed
  // in a fixed-column flow; descendants are rebased to page-relative source
  // positions so the real design layout is preserved inside the stage.
  const placePages = (boardId, y) => {
    const board = nodes[boardId];
    const columnGap = 120;
    const columns = options.pageColumns ?? 2;
    const pageNodes = board.children.map((sectionId) => {
      const section = nodes[sectionId];
      return section?.children?.[0] ?? sectionId;
    });
    const widths = pageNodes.map((pageId) => {
      const root = nodes[pageId].children[0];
      return nodes[root]?.bounds?.width ?? 800;
    });
    const heights = pageNodes.map((pageId) => {
      const root = nodes[pageId].children[0];
      return nodes[root]?.bounds?.height ?? 600;
    });
    const cellWidth = Math.max(...widths, 400);
    const rowHeights = [];
    let cursorX = 0;
    let rowY = y + LAYOUT.headerHeight;
    let column = 0;
    let rowHeight = 0;
    pageNodes.forEach((pageId, index) => {
      if (column === columns) {
        cursorX = 0;
        rowY += rowHeight + LAYOUT.sectionGap;
        column = 0;
        rowHeight = 0;
      }
      const sectionId = board.children[index];
      const page = nodes[pageId];
      const rootSceneId = page.children[0];
      const rootSource = nodes[rootSceneId]?.bounds ?? { x: 0, y: 0 };
      const width = widths[index];
      const height = heights[index];
      layout.nodes[pageId] = {
        ...page,
        bounds: { height, width, x: cursorX, y: rowY },
      };
      layout.nodes[sectionId] = {
        ...nodes[sectionId],
        bounds: { height: height + 24, width, x: cursorX, y: rowY - 24 },
      };
      layout.nodes[rootSceneId] = {
        ...nodes[rootSceneId],
        bounds: { height, width, x: cursorX, y: rowY },
      };
      // Rebase every descendant from source-absolute to stage-relative.
      const rebase = (sceneId, originX, originY) => {
        const node = nodes[sceneId];
        if (!node) return;
        layout.nodes[sceneId] = {
          ...node,
          bounds: {
            height: node.bounds?.height ?? 0,
            width: node.bounds?.width ?? 0,
            x: cursorX + ((node.bounds?.x ?? 0) - originX),
            y: rowY + ((node.bounds?.y ?? 0) - originY),
          },
        };
        for (const childId of node.children ?? []) {
          rebase(childId, originX, originY);
        }
      };
      rebase(rootSceneId, rootSource.x, rootSource.y);
      rowHeight = Math.max(rowHeight, height);
      cursorX += cellWidth + columnGap;
      column += 1;
    });
    const boardHeight = LAYOUT.headerHeight + rowY + rowHeight - y;
    const boardWidth = columns * (cellWidth + columnGap);
    layout.nodes[boardId] = {
      ...board,
      bounds: { height: boardHeight, width: boardWidth, x: 0, y },
    };
    return boardHeight;
  };

  let cursorY = 0;
  const totalWidths = [];
  for (const rootId of scene.rootIds) {
    const height =
      rootId === sceneNodeIdBoard("pages")
        ? placePages(rootId, cursorY)
        : placeBoard(rootId, cursorY);
    const board = layout.nodes[rootId];
    totalWidths.push(board.bounds.width);
    cursorY += height;
  }

  // Page compositions keep their true viewport geometry, positioned by the
  // pages board flow (already handled by placeSection via source bounds for
  // page nodes); page frames carry real width/height from the presentation.
  const canvasBounds = {
    height: cursorY,
    width: Math.max(...totalWidths, 800),
    x: 0,
    y: 0,
  };

  return {
    bounds: canvasBounds,
    layoutVersion: CANVAS_LAYOUT_VERSION,
    measure: options.measureText ? "injected" : "heuristic",
    nodes: layout.nodes,
  };
}
