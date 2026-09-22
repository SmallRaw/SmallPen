import { resolveContext } from "./contexts.mjs";
import { projectScenario, projectScreen } from "./design-projection.mjs";
import { fail } from "./errors.mjs";

const VIEW_FORMATS = ["structure", "semantic", "wireframe", "screenshot"];
const DESIGN_SELECTOR_FIELDS = new Set([
  "context",
  "contextProfileId",
  "presentationId",
  "scenarioId",
  "screenId",
  "viewFormat",
]);

function designSelector(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_design_selector", "Design selector must contain an object");
  }
  const fields = Object.keys(value)
    .filter((field) => !DESIGN_SELECTOR_FIELDS.has(field))
    .sort();
  if (fields.length > 0) {
    fail(
      "unknown_design_selector_field",
      `Design selector contains unknown fields: ${fields.join(", ")}`,
      { fields, validFields: [...DESIGN_SELECTOR_FIELDS].sort() },
    );
  }
  return value;
}

function screenById(snapshot, screenId) {
  const entry = snapshot.manifest.entries.screens.find(
    (candidate) => snapshot.entries[candidate].id === screenId,
  );
  return entry ? snapshot.entries[entry] : undefined;
}

function workspaceProfiles(product, foundation) {
  const profiles = new Map(foundation?.domain.contextProfiles ?? []);
  for (const [id, profile] of product.domain.contextProfiles) {
    if (profiles.has(id)) {
      fail(
        "duplicate_workspace_context_profile",
        `Product cannot redefine Foundation Context profile ${id}`,
        { path: `contexts.${id}`, profileId: id },
      );
    }
    profiles.set(id, profile);
  }
  return profiles;
}

function scenarioSelection(product, selector) {
  if (!selector.scenarioId) return undefined;
  const scenario = product.domain.scenarios.get(selector.scenarioId);
  if (!scenario) {
    fail("unknown_scenario", `Unknown Scenario: ${selector.scenarioId}`, {
      path: "scenarioId",
    });
  }
  return scenario;
}

export function resolveDesignView(product, options = {}) {
  const selector = designSelector(options.selector ?? {});
  const scenario = scenarioSelection(product, selector);
  const scenarioTarget = scenario?.target;
  if (
    selector.screenId &&
    scenarioTarget &&
    (scenarioTarget.kind !== "screen" ||
      selector.screenId !== scenarioTarget.screen.assetId)
  ) {
    fail("selector_conflict", "Scenario and Screen selectors disagree", {
      path: "screenId",
    });
  }
  if (
    selector.presentationId &&
    scenarioTarget &&
    (scenarioTarget.kind !== "screen" ||
      selector.presentationId !== scenarioTarget.presentationId)
  ) {
    fail(
      "selector_conflict",
      "Scenario and Presentation selectors disagree",
      { path: "presentationId" },
    );
  }
  const componentScenario =
    scenarioTarget?.kind === "component" ? scenario : undefined;
  if (componentScenario) {
    // Component Scenarios resolve a component-targeted design view without a
    // Screen; the projection renders the selected variant of the component.
    const profiles = workspaceProfiles(product, options.foundation);
    const profile = selector.contextProfileId
      ? profiles.get(selector.contextProfileId)
      : undefined;
    if (selector.contextProfileId && !profile) {
      fail(
        "unknown_context_profile",
        `Unknown Context profile: ${selector.contextProfileId}`,
        { path: "contextProfileId" },
      );
    }
    const context = resolveContext(product, options.foundation, {
      ...(profile?.values ?? {}),
      ...(scenario?.context ?? {}),
      ...(selector.context ?? {}),
    });
    const viewFormat = selector.viewFormat ?? "structure";
    if (!VIEW_FORMATS.includes(viewFormat)) {
      fail("unknown_view_format", `Unknown View Format: ${viewFormat}`, {
        path: "viewFormat",
      });
    }
    return {
      scenarioId: scenario.id,
      selection: {
        context,
        ...(scenario ? { scenarioId: scenario.id } : {}),
        viewFormat,
      },
    };
  }
  const screenId =
    selector.screenId ??
    scenarioTarget?.screen.assetId ??
    product.manifest.defaultScreenId;
  if (!screenId) {
    fail(
      "missing_default_screen",
      "Package has no default Screen",
      { path: "manifest.json.defaultScreenId" },
    );
  }
  const screen = screenById(product, screenId);
  if (!screen) {
    fail("unknown_screen", `Unknown Screen: ${screenId}`, { path: "screenId" });
  }
  const presentationId =
    selector.presentationId ?? scenarioTarget?.presentationId ?? screen.basePresentationId;
  const presentation = screen.presentations.find(({ id }) => id === presentationId);
  if (!presentation) {
    fail(
      "unknown_presentation",
      `Unknown Presentation on Screen ${screenId}: ${presentationId}`,
      { path: "presentationId" },
    );
  }
  const profiles = workspaceProfiles(product, options.foundation);
  const profile = selector.contextProfileId
    ? profiles.get(selector.contextProfileId)
    : undefined;
  if (selector.contextProfileId && !profile) {
    fail(
      "unknown_context_profile",
      `Unknown Context profile: ${selector.contextProfileId}`,
      { path: "contextProfileId" },
    );
  }
  const context = resolveContext(product, options.foundation, {
    ...(profile?.values ?? {}),
    ...(scenario?.context ?? {}),
    ...(selector.context ?? {}),
  });
  const viewFormat = selector.viewFormat ?? "structure";
  if (!VIEW_FORMATS.includes(viewFormat)) {
    fail("unknown_view_format", `Unknown View Format: ${viewFormat}`, {
      path: "viewFormat",
    });
  }
  return {
    presentation: structuredClone(presentation),
    scenarioId: scenario?.id,
    screen: structuredClone(screen),
    selection: {
      context,
      presentationId,
      ...(scenario ? { scenarioId: scenario.id } : {}),
      screenId,
      viewFormat,
    },
  };
}

function labels(locale) {
  return locale?.toLowerCase().startsWith("zh")
    ? {
        context: "外观设置",
        presentation: "页面稿",
        scenario: "设计状态",
        "view-format": "查看方式",
      }
    : {
        context: "Design Context",
        presentation: "Presentation",
        scenario: "Scenario",
        "view-format": "View Format",
      };
}

function command(args) {
  return ["smallpen", "read-view", "<package.smallpen>"]
    .concat(
      Object.entries(args).flatMap(([name, rawValue]) =>
        (Array.isArray(rawValue) ? rawValue : [rawValue]).flatMap((value) => [
          `--${name}`,
          String(value),
        ]),
      ),
    )
    .map((part) => (/\s/.test(part) ? JSON.stringify(part) : part))
    .join(" ");
}

function selectionArguments(selection, options = {}) {
  return {
    ...(options.context === false
      ? {}
      : {
          context: Object.entries(selection.context)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([axis, value]) => `${axis}=${value}`),
        }),
    format: selection.viewFormat,
    presentation: selection.presentationId,
    ...(options.scenario === false || !selection.scenarioId
      ? {}
      : { scenario: selection.scenarioId }),
    screen: selection.screenId,
  };
}

function discoveryEntry(kind, id, name, label, args, metadata = {}) {
  return {
    args,
    command: { args, operation: "smallpen.read" },
    copyableCommand: command(args),
    id,
    kind,
    label,
    name,
    nextOperation: "smallpen.read",
    selectorParameters: Object.keys(args),
    summary: name,
    ...metadata,
  };
}

export function createDiscoveryGuide(product, resolved, options = {}) {
  const localized = labels(options.locale);
  const entries = [];
  for (const presentation of resolved.screen?.presentations ?? []) {
    if (presentation.id === resolved.selection.presentationId) continue;
    entries.push(
      discoveryEntry(
        "presentation",
        presentation.id,
        presentation.name,
        localized.presentation,
        {
          ...selectionArguments(resolved.selection, { scenario: false }),
          presentation: presentation.id,
        },
        {
          defaults: { presentation: resolved.screen.basePresentationId },
          validValues: resolved.screen.presentations.map(({ id }) => id),
        },
      ),
    );
  }
  const axes = new Map(options.foundation?.domain.contextAxes ?? []);
  for (const [id, axis] of product.domain.contextAxes) axes.set(id, axis);
  for (const axis of [...axes.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    for (const value of axis.values) {
      if (resolved.selection.context[axis.id] === value.id) continue;
      entries.push(
        discoveryEntry(
          "context",
          `${axis.id}=${value.id}`,
          `${axis.name}: ${value.name}`,
          localized.context,
          {
            ...selectionArguments(resolved.selection),
            context: Object.entries({
              ...resolved.selection.context,
              [axis.id]: value.id,
            })
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([contextAxis, contextValue]) =>
                `${contextAxis}=${contextValue}`,
              ),
          },
          {
            defaults: { [axis.id]: axis.defaultValue },
            validValues: axis.values.map(({ id }) => id),
          },
        ),
      );
    }
  }
  for (const profile of [...workspaceProfiles(product, options.foundation).values()].sort(
    (left, right) => left.id.localeCompare(right.id),
  )) {
    entries.push(
      discoveryEntry(
        "context",
        profile.id,
        profile.name,
        localized.context,
        {
          ...selectionArguments(resolved.selection, { context: false }),
          "context-profile": profile.id,
        },
        { defaults: {}, validValues: [profile.id] },
      ),
    );
  }
  for (const scenario of [...product.domain.scenarios.values()]
    .filter(
      (candidate) =>
        candidate.target.kind === "screen" &&
        candidate.target.screen.assetId === resolved.screen?.id,
    )
    .sort((left, right) => left.id.localeCompare(right.id))) {
    if (scenario.id === resolved.selection.scenarioId) continue;
    entries.push(
      discoveryEntry(
        "scenario",
        scenario.id,
        scenario.name,
        localized.scenario,
        {
          ...selectionArguments(resolved.selection, { scenario: false }),
          presentation:
            scenario.target.presentationId ?? resolved.selection.presentationId,
          scenario: scenario.id,
          screen: scenario.target.screen.assetId,
        },
        {
          defaults: { scenario: null },
          validValues: [...product.domain.scenarios.keys()].sort(),
        },
      ),
    );
  }
  for (const viewFormat of VIEW_FORMATS) {
    if (viewFormat === resolved.selection.viewFormat) continue;
    entries.push(
      discoveryEntry(
        "view-format",
        viewFormat,
        viewFormat,
        localized["view-format"],
        { ...selectionArguments(resolved.selection), format: viewFormat },
        { defaults: { format: "structure" }, validValues: VIEW_FORMATS },
      ),
    );
  }
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.max(1, Math.min(100, options.limit ?? 20));
  return {
    entries: entries.slice(offset, offset + limit),
    list: {
      complete: offset === 0 && offset + limit >= entries.length,
      kind: "finite",
      total: entries.length,
    },
    page: {
      hasMore: offset + limit < entries.length,
      limit,
      offset,
      total: entries.length,
    },
    selection: structuredClone(resolved.selection),
  };
}

export function projectDesignView(product, resolved, options = {}) {
  return resolved.scenarioId
    ? projectScenario(product, resolved.scenarioId, {
        context: resolved.selection.context,
        foundation: options.foundation,
        libraries: options.libraries,
      })
    : projectScreen(product, resolved.screen.id, {
        context: resolved.selection.context,
        foundation: options.foundation,
        libraries: options.libraries,
        presentationId: resolved.presentation.id,
      });
}

function multiplyMatrix(left, right) {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function translationMatrix(x, y) {
  return [1, 0, 0, 1, x, y];
}

function semanticNodeMatrix(node) {
  const angle = ((node.rotation ?? 0) * Math.PI) / 180;
  const horizontal = node.flipX ? -1 : 1;
  const vertical = node.flipY ? -1 : 1;
  const transform = [
    Math.cos(angle) * horizontal,
    Math.sin(angle) * horizontal,
    -Math.sin(angle) * vertical,
    Math.cos(angle) * vertical,
    0,
    0,
  ];
  return multiplyMatrix(
    translationMatrix(node.x, node.y),
    multiplyMatrix(
      translationMatrix(node.width / 2, node.height / 2),
      multiplyMatrix(
        transform,
        translationMatrix(-node.width / 2, -node.height / 2),
      ),
    ),
  );
}

function matrixPoint(matrix, x, y) {
  return {
    x: matrix[0] * x + matrix[2] * y + matrix[4],
    y: matrix[1] * x + matrix[3] * y + matrix[5],
  };
}

function semanticBounds(matrix, node) {
  const corners = [
    matrixPoint(matrix, 0, 0),
    matrixPoint(matrix, node.width, 0),
    matrixPoint(matrix, 0, node.height),
    matrixPoint(matrix, node.width, node.height),
  ];
  const left = Math.min(...corners.map(({ x }) => x));
  const right = Math.max(...corners.map(({ x }) => x));
  const top = Math.min(...corners.map(({ y }) => y));
  const bottom = Math.max(...corners.map(({ y }) => y));
  return { height: bottom - top, width: right - left, x: left, y: top };
}

function semanticNode(nodes, nodeId, parentMatrix, ancestors) {
  if (ancestors.has(nodeId)) fail("node_cycle", `Projection cycle includes ${nodeId}`);
  const node = nodes[nodeId];
  if (!node) fail("missing_node", `Projected Node is missing: ${nodeId}`);
  const matrix = multiplyMatrix(parentMatrix, semanticNodeMatrix(node));
  const bounds = semanticBounds(matrix, node);
  const next = new Set(ancestors);
  next.add(nodeId);
  return {
    bounds,
    children: (node.children ?? []).map((childId) =>
      semanticNode(nodes, childId, matrix, next),
    ),
    ...(node.componentRef ? { component: structuredClone(node.componentRef) } : {}),
    constraints: {
      horizontal: node.horizontalConstraint ?? "MIN",
      vertical: node.verticalConstraint ?? "MIN",
    },
    id: node.id,
    name: node.name,
    tokenBindings: structuredClone(node.tokenBindings ?? {}),
    ...(typeof node.text === "string" ? { text: node.text } : {}),
    ...(node.textStyle ? { textStyle: structuredClone(node.textStyle) } : {}),
    type: node.type,
    ...(node.variantSelection
      ? { variant: structuredClone(node.variantSelection) }
      : {}),
    visible: node.visible !== false,
  };
}

export function createSemanticTree(product, projection, options = {}) {
  const interactions = projection.presentation?.interactions ?? [];
  return {
    ...(options.foundationRevision
      ? { foundationRevision: options.foundationRevision }
      : {}),
    ...(interactions.length > 0
      ? { interactions: structuredClone(interactions) }
      : {}),
    packageId: product.manifest.packageId,
    productRevision: product.revision,
    revision: product.revision,
    root: semanticNode(
      projection.nodes,
      projection.rootId,
      [1, 0, 0, 1, 0, 0],
      new Set(),
    ),
    ...(options.scenarioId ? { scenarioId: options.scenarioId } : {}),
    selection: options.selection ? structuredClone(options.selection) : undefined,
  };
}

const WIREFRAME_COLUMNS = 72;
const WIREFRAME_MIN_ROWS = 18;
const WIREFRAME_MAX_ROWS = 36;

function wireframeNumber(value) {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

function wireframeBounds(bounds) {
  const x = Number.isFinite(bounds?.x) ? bounds.x : 0;
  const y = Number.isFinite(bounds?.y) ? bounds.y : 0;
  const width = Number.isFinite(bounds?.width) ? Math.max(0, bounds.width) : 0;
  const height = Number.isFinite(bounds?.height) ? Math.max(0, bounds.height) : 0;
  return { height, width, x, y };
}

function wireframeLayers(root) {
  const result = [];
  const visit = (node, depth, parentIndex) => {
    const index = result.length + 1;
    result.push({ depth, index, node, parentIndex });
    for (const child of node.children ?? []) visit(child, depth + 1, index);
  };
  visit(root, 0, undefined);
  const digits = Math.max(2, String(result.length).length);
  return result.map((layer) => ({
    ...layer,
    marker: `${layer.node.visible === false ? "(" : "["}${String(layer.index).padStart(digits, "0")}${layer.node.visible === false ? ")" : "]"}`,
  }));
}

function wireframeGrid(rootBounds) {
  const aspect = rootBounds.width > 0 && rootBounds.height > 0
    ? rootBounds.width / rootBounds.height
    : 1;
  const rows = Math.max(
    WIREFRAME_MIN_ROWS,
    Math.min(
      WIREFRAME_MAX_ROWS,
      Math.round(WIREFRAME_COLUMNS / aspect / 2),
    ),
  );
  return Array.from({ length: rows }, () =>
    Array.from({ length: WIREFRAME_COLUMNS }, () => " "),
  );
}

function wireframeCellBounds(bounds, viewport, columns, rows) {
  const horizontal = (value) =>
    Math.max(
      0,
      Math.min(
        columns - 1,
        Math.round(((value - viewport.x) / (viewport.width || 1)) * (columns - 1)),
      ),
    );
  const vertical = (value) =>
    Math.max(
      0,
      Math.min(
        rows - 1,
        Math.round(((value - viewport.y) / (viewport.height || 1)) * (rows - 1)),
      ),
    );
  const normalized = wireframeBounds(bounds);
  const left = horizontal(normalized.x);
  const right = horizontal(normalized.x + normalized.width);
  const top = vertical(normalized.y);
  const bottom = vertical(normalized.y + normalized.height);
  return {
    bottom: Math.max(top, bottom),
    left: Math.min(left, right),
    right: Math.max(left, right),
    top: Math.min(top, bottom),
  };
}

function drawWireframeBounds(grid, bounds, hidden) {
  const horizontal = hidden ? "." : "-";
  const vertical = hidden ? ":" : "|";
  const corner = hidden ? "." : "+";
  for (let column = bounds.left; column <= bounds.right; column += 1) {
    grid[bounds.top][column] = horizontal;
    grid[bounds.bottom][column] = horizontal;
  }
  for (let row = bounds.top; row <= bounds.bottom; row += 1) {
    grid[row][bounds.left] = vertical;
    grid[row][bounds.right] = vertical;
  }
  grid[bounds.top][bounds.left] = corner;
  grid[bounds.top][bounds.right] = corner;
  grid[bounds.bottom][bounds.left] = corner;
  grid[bounds.bottom][bounds.right] = corner;
}

function wireframeMarkerPosition(
  grid,
  occupied,
  text,
  bounds,
  includeWholeGrid,
) {
  const rows = grid.length;
  const columns = grid[0].length;
  const preferredRow = Math.min(
    bounds.bottom,
    bounds.top + (bounds.bottom - bounds.top >= 2 ? 1 : 0),
  );
  const preferredColumn = Math.min(
    Math.max(0, columns - text.length),
    bounds.left + (bounds.right - bounds.left >= text.length + 1 ? 1 : 0),
  );
  const candidates = [];
  for (let row = bounds.top; row <= bounds.bottom; row += 1) {
    for (
      let column = bounds.left;
      column <= Math.min(bounds.right - text.length + 1, columns - text.length);
      column += 1
    ) {
      candidates.push({
        column,
        distance: Math.abs(row - preferredRow) + Math.abs(column - preferredColumn),
        row,
      });
    }
  }
  if (includeWholeGrid) {
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column <= columns - text.length; column += 1) {
        candidates.push({
          column,
          distance:
            rows +
            Math.abs(row - preferredRow) +
            Math.abs(column - preferredColumn),
          row,
        });
      }
    }
  }
  candidates.sort(
    (left, right) =>
      left.distance - right.distance ||
      left.row - right.row ||
      left.column - right.column,
  );
  return candidates.find(({ column, row }) =>
    text
      .split("")
      .every((_, offset) => occupied[row][column + offset] === false),
  );
}

function writeWireframeText(grid, occupied, text, position) {
  text.split("").forEach((character, offset) => {
    grid[position.row][position.column + offset] = character;
    occupied[position.row][position.column + offset] = true;
  });
}

function placeWireframeMarker(grid, occupied, layer, bounds) {
  const marker = layer.marker;
  const position = wireframeMarkerPosition(
    grid,
    occupied,
    marker,
    bounds,
    true,
  );
  if (!position) return;
  writeWireframeText(grid, occupied, marker, position);
}

function wireframeLayerLine(layer) {
  const node = layer.node;
  const hidden = node.visible === false ? "HIDDEN " : "";
  return `${"  ".repeat(layer.depth)}${layer.marker} ${hidden}${node.type} ${JSON.stringify(node.name)} #${node.id}`;
}

export function asciiWireframe(tree) {
  const viewport = wireframeBounds(tree.root.bounds);
  const layers = wireframeLayers(tree.root);
  const grid = wireframeGrid(viewport);
  const occupied = grid.map((row) => row.map(() => false));
  const cellBounds = new Map();
  for (const layer of layers) {
    const bounds = wireframeCellBounds(
      layer.node.bounds,
      viewport,
      grid[0].length,
      grid.length,
    );
    cellBounds.set(layer.index, bounds);
    drawWireframeBounds(grid, bounds, layer.node.visible === false);
  }
  for (const layer of layers) {
    placeWireframeMarker(
      grid,
      occupied,
      layer,
      cellBounds.get(layer.index),
    );
  }
  const canvas = grid.map((row) => row.join("")).join("\n");
  const layerIndex = layers
    .map((layer) => wireframeLayerLine(layer))
    .join("\n");
  return [
    "ASCII WIREFRAME",
    `viewport: ${wireframeNumber(viewport.width)}x${wireframeNumber(viewport.height)} @ ${wireframeNumber(viewport.x)},${wireframeNumber(viewport.y)} | canvas: ${grid[0].length}x${grid.length} chars`,
    "markers: [NN]=visible (NN)=hidden; geometry is approximate; exact data is in semanticTree",
    "CANVAS",
    canvas,
    "LAYER KEY (back-to-front; indentation shows containment)",
    layerIndex,
    "",
  ].join("\n");
}

function semanticValues(value, path, result) {
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      semanticValues(child, `${path}[${index}]`, result),
    );
  } else if (value && typeof value === "object") {
    for (const [name, child] of Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (
        name === "revision" ||
        name === "productRevision" ||
        name === "foundationRevision"
      ) continue;
      semanticValues(child, path ? `${path}.${name}` : name, result);
    }
  } else {
    result.set(path, JSON.stringify(value));
  }
}

export function diffSemanticTrees(before, after) {
  const beforeValues = new Map();
  const afterValues = new Map();
  semanticValues(before, "", beforeValues);
  semanticValues(after, "", afterValues);
  return [...new Set([...beforeValues.keys(), ...afterValues.keys()])]
    .sort()
    .flatMap((path) => {
      const beforeValue = beforeValues.get(path);
      const afterValue = afterValues.get(path);
      if (beforeValue === afterValue) return [];
      if (beforeValue === undefined) return [{ after: afterValue, kind: "added", path }];
      if (afterValue === undefined) return [{ before: beforeValue, kind: "removed", path }];
      return [{ after: afterValue, before: beforeValue, kind: "changed", path }];
    });
}

export function readDesignView(product, options = {}) {
  const resolved = resolveDesignView(product, options);
  const projection = projectDesignView(product, resolved, options);
  const semantic = createSemanticTree(product, projection, {
    foundationRevision: options.foundation?.revision,
    scenarioId: resolved.scenarioId,
    selection: resolved.selection,
  });
  const formats = {
    screenshot: { projection, status: "render_required" },
    semantic,
    structure: projection,
    wireframe: asciiWireframe(semantic),
  };
  return {
    discovery: createDiscoveryGuide(product, resolved, {
      foundation: options.foundation,
      limit: options.limit,
      locale: options.locale,
      offset: options.offset,
    }),
    format: resolved.selection.viewFormat,
    ...(options.foundation
      ? { foundationRevision: options.foundation.revision }
      : {}),
    productRevision: product.revision,
    revision: product.revision,
    result: formats[resolved.selection.viewFormat],
    selection: resolved.selection,
  };
}

export function createCompareView(product, selectors, options = {}) {
  if (!Array.isArray(selectors) || selectors.length < 2 || selectors.length > 4) {
    fail(
      "invalid_compare_count",
      "Compare requires two to four explicitly selected Design Views",
      {
        next: {
          args: { maximum: 4, minimum: 2 },
          operation: "smallpen.compare.select",
        },
        path: "selectors",
      },
    );
  }
  return {
    items: selectors.map((selector) => {
      const resolved = resolveDesignView(product, { ...options, selector });
      return {
        projection: projectDesignView(product, resolved, options),
        selection: resolved.selection,
      };
    }),
  };
}
