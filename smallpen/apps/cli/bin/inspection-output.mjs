import {
  appliedTokenFields,
  listTokenThemes,
  resolveEffectiveToken,
  tokenLibraryOf,
  wireframeLayers,
} from "@smallpen/core";

const number = (value) =>
  Number.isFinite(value) ? String(Math.round(value * 100) / 100) : "?";
const size = (bounds) => `${number(bounds?.width)}×${number(bounds?.height)}`;
const known = (bounds) =>
  bounds &&
  ["x", "y", "width", "height"].every((key) => Number.isFinite(bounds[key]));
const plain = (value) =>
  typeof value === "string" ? value : JSON.stringify(value);

export function inspectionCoverage(coverage) {
  const grouped = new Map();
  for (const item of coverage.skipped) {
    const key = JSON.stringify([item.check, item.reason, item.code]);
    const entry = grouped.get(key);
    if (entry) entry.count++;
    else
      grouped.set(key, {
        check: item.check,
        reason: item.reason,
        code: item.code,
        count: 1,
      });
  }
  return {
    ...coverage,
    skipped: [...grouped.values()],
    skippedCount: coverage.skipped.length,
  };
}

export function inspectionTree(design, { full = false } = {}) {
  const visit = (node) => ({
    ...node,
    children:
      !full &&
      node !== design.tree.root &&
      (design.projection.nodes[node.id]?.type === "INSTANCE" ||
        design.projection.nodes[node.id]?.instance)
        ? []
        : node.children.map(visit),
  });
  return { ...design.tree, root: visit(design.tree.root) };
}

// Raw values retain the sizing contract; native bounds supply actual values.
// A value equal to a Token is still a literal unless a binding exists.
export function inspectionReport(
  workspace,
  design,
  { components, stored = {}, full = false } = {},
) {
  const snapshot = design.layoutSnapshot;
  const projection = design.authoredProjection ?? design.projection;
  const owners = [
    workspace.product,
    workspace.foundation,
    ...(workspace.libraries ?? []),
  ].filter(Boolean);
  const ownerOf = (id) =>
    owners.find((owner) => owner.manifest.packageId === id);
  const ownerName = (owner) =>
    owner?.manifest.name ?? owner?.manifest.packageId ?? "unknown package";
  const ownerToken = (owner, id) => owner?.domain.tokens.get(id);
  const layers = wireframeLayers(inspectionTree(design, { full }).root);
  const references = new Map(
    layers.map((layer) => [
      layer.node.id,
      String(layer.index).padStart(2, "0"),
    ]),
  );
  const parents = new Map();
  const index = (node) => {
    node.children.forEach((child) => {
      parents.set(child.id, node);
      index(child);
    });
  };
  index(design.tree.root);
  const ancestry = (node) => {
    const result = [];
    for (
      let parent = parents.get(node.id);
      parent;
      parent = parents.get(parent.id)
    )
      result.unshift(projection.nodes[parent.id]);
    return [...(design.ancestors ?? []), ...result];
  };
  const componentInfo = (node) => {
    const raw = projection.nodes[node.id];
    const reference =
      raw.componentRef ?? raw.instance?.component ?? node.component;
    if (!reference && design.selection.componentId) {
      const set = components?.({
        assetId: design.selection.componentId,
        packageId: design.selection.packageId,
      });
      const variant = set?.variants.find(
        (item) => item.id === design.selection.variantId,
      );
      const source = variant?.nodes?.[raw.id];
      return {
        name: set?.name ?? "unknown shared component",
        package: ownerName(ownerOf(design.selection.packageId)),
        element: source?.name ?? "unknown source element",
        role: "definition",
        variant: (set?.axes ?? [])
          .filter((axis) => variant?.selection?.[axis.id] !== undefined)
          .map((axis) => `${axis.name}=${variant.selection[axis.id]}`),
        overrides: [],
        overridesKnown: Boolean(source),
        ...(source
          ? {}
          : { status: "partial", reason: "component_definition_unavailable" }),
      };
    }
    if (!reference) {
      if (!raw.componentId && !raw.sourceNodeId) return null;
      const owner = owners.find((candidate) =>
        candidate.domain.locatedComponents?.has(raw.componentId),
      );
      const located = owner?.domain.locatedComponents.get(raw.componentId);
      return {
        name: located?.name ?? "unknown shared component",
        package: ownerName(owner),
        element: "unknown source element",
        variant: [],
        overrides: [],
        overridesKnown: false,
        status: "partial",
        reason: "located_component_field_chain_not_exposed",
      };
    }
    const set = components?.(reference);
    const selection =
      raw.variantSelection ?? raw.instance?.variant ?? node.variant ?? {};
    const variant =
      set?.variants.find((candidate) => candidate.id === raw.variantId) ??
      set?.variants.find((candidate) =>
        Object.entries(selection).every(
          ([key, value]) => candidate.selection?.[key] === value,
        ),
      );
    const source = variant?.nodes?.[raw.sourceNodeId ?? variant.rootId];
    const copies = [...ancestry(node), raw].filter(
      (candidate) => (stored[candidate.id] ?? candidate).instance,
    );
    const overrides = [];
    const fieldOverrides = [];
    for (const copy of copies) {
      for (const [key, value] of Object.entries((stored[copy.id] ?? copy).instance?.overrides ?? {})) {
        const path = key.slice(0, key.lastIndexOf(":"));
        const target = path === copy.sourceNodeId ? copy.id : `${copy.id}__${path}`;
        const item = {
          element: target === raw.id ? source?.name ?? "component element"
            : variant?.nodes?.[path]?.name ?? projection.nodes[target]?.name ?? "component element",
          field: key.slice(key.lastIndexOf(":") + 1),
          value,
        };
        // The instance summary includes edits inside it. A field's source
        // depends only on overrides that target that exact projected node.
        if (copy.id === raw.id || target === raw.id) overrides.push(item);
        if (target === raw.id) fieldOverrides.push(item);
      }
    }
    const placed = stored[raw.id];
    if (placed?.instance && source) {
      for (const name of [
        "fills",
        "strokes",
        "opacity",
        "visible",
        "textStyle",
        "tokenBindings",
        "layout-gap",
        "layout-padding",
        "layout-item-margin",
        "cornerRadius",
        "shadow",
      ])
        if (
          Object.hasOwn(placed, name) &&
          (name !== "tokenBindings" || Object.keys(placed[name] ?? {}).length > 0) &&
          JSON.stringify(placed[name]) !== JSON.stringify(source[name])
        ) {
          const item = {
            element: source.name,
            field: name,
            value: placed[name],
          };
          overrides.push(item);
          fieldOverrides.push(item);
        }
    }
    return {
      name: set?.name ?? "unknown component",
      package: ownerName(ownerOf(reference.packageId)),
      element: source?.name ?? "unknown source element",
      variant: (set?.axes ?? [])
        .filter((axis) => selection[axis.id] !== undefined)
        .map((axis) => `${axis.name}=${selection[axis.id]}`),
      overrides,
      fieldOverrides,
      // A located App copy may lack its full source chain. Absence of
      // metadata is not proof that no overrides exist.
      overridesKnown:
        copies.length > 0 || Boolean(design.selection.componentId),
    };
  };
  const resolveToken = (reference) => {
    const resolution = resolveEffectiveToken(workspace.product, reference, {
      ...workspace,
      context: design.selection.context ?? {},
      traceSources: true,
    });
    if (!resolution)
      return {
        status: "unknown",
        path: "unknown Token",
        reason: "token_value_unavailable",
      };
    const owner = ownerOf(resolution.sourcePackageId);
    const library = tokenLibraryOf(owner);
    const set = library?.sets.find((candidate) =>
      candidate.tokens.some((item) => item.id === resolution.sourceTokenId),
    );
    return {
      status: "resolved",
      path:
        ownerToken(ownerOf(reference.packageId), reference.assetId)?.path ??
        resolution.token.path,
      effectivePath: resolution.token.path,
      value: resolution.value,
      package: ownerName(owner),
      ...(set ? { set: set.name } : {}),
      themes: listTokenThemes(workspace.product, workspace.foundation)
        .filter(
          (theme) =>
            theme.active &&
            theme.packageId === resolution.sourcePackageId &&
            (!set || theme.setIds.includes(set.id)),
        )
        .map((theme) => theme.path),
      chain: (resolution.sourceChain ?? []).map((source) => ({
        package: ownerName(ownerOf(source.packageId)),
        path:
          ownerToken(ownerOf(source.packageId), source.tokenId)?.path ??
          "unknown Token",
        role: source.role,
      })),
      aliases: (resolution.aliasChain ?? []).map((source) => {
        const owner = ownerOf(source.packageId);
        const set = tokenLibraryOf(owner)?.sets.find((candidate) =>
          candidate.tokens.some((token) => token.id === source.tokenId),
        );
        return {
          path: source.path,
          package: ownerName(owner),
          set: set?.name,
          alias: source.alias,
          contextRule: source.rule,
        };
      }),
    };
  };
  const tokenCache = new Map();
  const token = (reference) => {
    const key = `${reference.packageId}\0${reference.assetId}`;
    if (!tokenCache.has(key)) tokenCache.set(key, resolveToken(reference));
    return tokenCache.get(key);
  };
  const field = (raw, component, name, value, aliases = [], fallback) => {
    const keys = [name, ...aliases];
    let reference = keys.map((key) => raw.tokenBindings?.[key]).find(Boolean);
    if (!reference) {
      const applied = appliedTokenFields(raw.appliedTokens);
      const path = keys.map((key) => applied[key]).find(Boolean);
      if (path) {
        const owner = owners.find((candidate) =>
          [...candidate.domain.tokens.values()].some(
            (item) => item.path === path,
          ),
        );
        const found =
          owner &&
          [...owner.domain.tokens.values()].find((item) => item.path === path);
        if (found)
          reference = {
            packageId: owner.manifest.packageId,
            assetId: found.id,
          };
        else
          return {
            value: value ?? fallback,
            kind: "unknown",
            path,
            reason: "token_source_unavailable",
          };
      }
    }
    const overridden = (component?.fieldOverrides ?? component?.overrides)?.some(
      (item) =>
        item.element === component.element &&
        (keys.includes(item.field) ||
          (name === "fill" && item.field === "fills") ||
          (name === "stroke" && item.field === "strokes") ||
          (name === "gap" && item.field === "layout-gap") ||
          (name.startsWith("padding") && item.field === "layout-padding") ||
          (name.startsWith("margin") && item.field === "layout-item-margin") ||
          (name.startsWith("radius") && item.field === "cornerRadius") ||
          (item.field === "textStyle" &&
            Object.hasOwn(item.value ?? {}, name)) ||
          (item.field === "tokenBindings" &&
            keys.some((key) => Object.hasOwn(item.value ?? {}, key)))),
    );
    return {
      value: value ?? fallback,
      kind: reference ? "token" : value === undefined ? "default" : "literal",
      ...(reference ? { token: token(reference) } : {}),
      source:
        component?.status === "partial"
          ? `unknown (${component.reason})`
          : overridden
            ? `instance override → ${component.name} / ${component.element}`
            : component
              ? `${component.name} / ${component.element}`
              : "page",
    };
  };
  const metrics = new Map(
    (design.render?.textMetrics ?? []).map((item) => [item.nodeId, item]),
  );
  const interactionRule = (rule) => {
    const destination = rule.destination ?? rule.target;
    const location =
      typeof destination === "string"
        ? workspace.product.runtime.reverseNodes?.[destination]
        : destination;
    const screen =
      location &&
      workspace.product.manifest.entries.screens
        .map((entry) => workspace.product.entries[entry])
        .find((candidate) => candidate.id === location.screenId);
    const presentation = screen?.presentations.find(
      (candidate) => candidate.id === location.presentationId,
    );
    return {
      on: rule["event-type"] ?? rule.trigger ?? "unspecified",
      action: rule["action-type"] ?? rule.type ?? rule.action ?? "unspecified",
      ...(destination
        ? {
            destination: screen
              ? {
                  page: screen.name,
                  ...(presentation
                    ? { platform: presentation.platform ?? presentation.name }
                    : {}),
                }
              : { status: "unknown", reason: "destination_name_unavailable" },
          }
        : {}),
      ...(rule.url ? { url: rule.url } : {}),
      ...(rule.delay !== undefined ? { delay: rule.delay } : {}),
    };
  };
  const nodes = layers.map(({ node, depth, index }) => {
    const raw = projection.nodes[node.id];
    const component = componentInfo(node);
    const { fieldOverrides: _fieldOverrides, ...componentSource } = component ?? {};
    const actual = snapshot.nodes[node.id];
    const parent = parents.get(node.id);
    const parentBounds =
      parent?.bounds ?? snapshot.nodes[design.ancestors?.at(-1)?.id]?.bounds;
    const fields = {};
    const add = (name, value, aliases, fallback) =>
      (fields[name] = field(raw, component, name, value, aliases, fallback));
    const sizing = (axis, mode) =>
      mode === "fill"
        ? "fill"
        : mode === "auto"
          ? "hug"
          : raw.type === "TEXT" &&
              (raw.growType === "auto-width" ||
                (axis === "height" && raw.growType === "auto-height"))
            ? "hug"
            : "fixed";
    const constraints = {
      width: sizing("width", raw["layout-item-h-sizing"]),
      height: sizing("height", raw["layout-item-v-sizing"]),
      position: raw["layout-item-absolute"] ? "absolute" : "flow",
      horizontal: raw.horizontalConstraint ?? "MIN",
      vertical: raw.verticalConstraint ?? "MIN",
    };
    for (const axis of ["width", "height"])
      if (constraints[axis] === "fixed" || raw.tokenBindings?.[axis])
        add(axis, raw[axis]);
    for (const [key, binding] of [
      ["min-w", "minWidth"],
      ["max-w", "maxWidth"],
      ["min-h", "minHeight"],
      ["max-h", "maxHeight"],
    ])
      if (raw[`layout-item-${key}`] !== undefined)
        add(binding, raw[`layout-item-${key}`]);
    let layout;
    if (raw.layout) {
      const direction = raw["layout-flex-dir"] ?? "row";
      const column = direction.startsWith("column");
      layout = {
        type: raw.layout,
        direction,
        justify: raw["layout-justify-content"] ?? "start",
        align: raw["layout-align-items"] ?? "start",
        wrap: raw["layout-wrap-type"] ?? "nowrap",
      };
      add(
        "gap",
        raw["layout-gap"]?.[column ? "row-gap" : "column-gap"],
        [column ? "rowGap" : "columnGap", "itemSpacing"],
        0,
      );
      for (const [side, key] of [
        ["Top", "p1"],
        ["Right", "p2"],
        ["Bottom", "p3"],
        ["Left", "p4"],
      ])
        add(`padding${side}`, raw["layout-padding"]?.[key], [], 0);
      const children = node.children.filter(
        (child) =>
          child.visible &&
          !projection.nodes[child.id]?.["layout-item-absolute"],
      );
      if (!direction.endsWith("reverse")) children.reverse();
      const transformed = [
        ...ancestry(node),
        raw,
        ...children.map((child) => projection.nodes[child.id]),
      ].some((item) => item.rotation || item.flipX || item.flipY);
      if (raw.layout !== "flex" || layout.wrap !== "nowrap")
        layout.spacingUnknown = "wrapped_or_grid_spacing_not_exposed";
      layout.spaces =
        raw.layout === "flex" && layout.wrap === "nowrap"
          ? children.slice(1).map((child, i) => {
              const a = children[i].bounds,
                b = child.bounds;
              const start = column ? "y" : "x",
                extent = column ? "height" : "width";
              const distance =
                !transformed && known(a) && known(b)
                  ? direction.endsWith("reverse")
                    ? a[start] - b[start] - b[extent]
                    : b[start] - a[start] - a[extent]
                  : null;
              return {
                from: children[i].name,
                to: child.name,
                actual: distance,
                source:
                  layout.justify === "space-between"
                    ? "space-between allocation (includes gap and margins)"
                    : "resolved edge distance (includes gap and margins)",
                ...(distance === null
                  ? {
                      reason: transformed
                        ? "transformed_spacing_not_exposed"
                        : "native_bounds_unavailable",
                    }
                  : {}),
              };
            })
          : [];
    }
    const margin = raw["layout-item-margin"];
    if (margin)
      for (const [side, key] of [
        ["Top", "m1"],
        ["Right", "m2"],
        ["Bottom", "m3"],
        ["Left", "m4"],
      ])
        add(`margin${side}`, margin[key], [], 0);
    const visible = add("visible", raw.visible, [], true);
    for (const [name, value, aliases] of [
      ["fill", raw.fills?.[0], ["fills.0"]],
      ["stroke", raw.strokes?.[0], ["strokes.0"]],
      ["opacity", raw.opacity],
      ["rotation", raw.rotation],
      ["shadow", raw.shadow],
      ["hideFillOnExport", raw["hide-fill-on-export"]],
    ])
      if (value !== undefined) add(name, value, aliases);
    if (raw.cornerRadius !== undefined)
      for (const [i, corner] of [
        "TopLeft",
        "TopRight",
        "BottomRight",
        "BottomLeft",
      ].entries())
        add(
          `radius${corner}`,
          Array.isArray(raw.cornerRadius)
            ? raw.cornerRadius[i]
            : raw.cornerRadius,
          ["cornerRadius"],
        );
    let text;
    if (raw.type === "TEXT") {
      add("text", raw.text, [], "");
      for (const [key, value] of Object.entries(raw.textStyle ?? {}))
        add(key, value, ["typography"]);
      const measured = metrics.get(node.id);
      text = {
        value: raw.text ?? "",
        growType: raw.growType ?? "fixed",
        wrapping:
          raw.growType === "auto-width"
            ? "unconstrained width"
            : "constrained by resolved width",
        measured: measured
          ? { width: measured.width, height: measured.height }
          : null,
        primaryFaces: [
          ...new Map(
            (design.render?.fontRequests ?? [])
              .filter((face) => face.nodeId === node.id)
              .map(({ nodeId, ...face }) => [JSON.stringify(face), face]),
          ).values(),
        ],
        glyphFallback: {
          status: "unknown",
          reason: "native_per_glyph_font_not_exposed",
        },
        lines: { status: "unknown", reason: "native_line_count_not_exposed" },
        truncation: {
          status: "unspecified",
          reason: "no_explicit_ellipsis_rule",
        },
      };
    }
    const interactions =
      (design.renderProjection ?? design.projection).presentation
        ?.interactions ?? [];
    const defined = [
      ...(raw.interactions ?? []),
      ...interactions.filter(
        (item) => item.nodeId === node.id || item.sourceNodeId === node.id,
      ),
    ];
    return {
      ref: String(index).padStart(2, "0"),
      nodeId: node.id,
      name: node.name,
      depth,
      geometry: {
        ...actual,
        coordinateSpace: "page",
        relativeToParent:
          known(node.bounds) && known(parentBounds)
            ? {
                x: node.bounds.x - parentBounds.x,
                y: node.bounds.y - parentBounds.y,
              }
            : null,
      },
      constraints,
      ...(layout ? { layout } : {}),
      fields,
      source: component
        ? { kind: "component", ...componentSource }
        : { kind: "page" },
      visibility: {
        value: node.visible,
        source: visible,
        ...(!node.visible && raw.visible !== false
          ? { reason: "hidden by ancestor" }
          : {}),
      },
      interaction: defined.length
        ? {
            status: "declared",
            rules: defined,
            readable: defined.map(interactionRule),
          }
        : { status: "unspecified" },
      disabledReason: {
        status: "unspecified",
        reason: "no_declared_business_rule",
      },
      ...(text ? { text } : {}),
    };
  });
  const refOf = (id) => {
    for (let current = id; current; current = parents.get(current)?.id)
      if (references.has(current)) return references.get(current);
    return null;
  };
  const issues = (design.validation?.issues ?? snapshot.diagnostics).map(
    (issue) => ({
      ...issue,
      ...(issue.nodeId ? { ref: refOf(issue.nodeId) } : {}),
      ...(issue.otherNodeId ? { otherRef: refOf(issue.otherNodeId) } : {}),
    }),
  );
  for (const node of nodes)
    if (node.source.status === "partial")
      issues.push({
        ref: node.ref,
        nodeId: node.nodeId,
        code: "component_source_unavailable",
        severity: "warning",
        message: `Component field provenance is unknown: ${node.source.reason}`,
      });
  for (const node of nodes)
    for (const [name, value] of Object.entries(node.fields))
      if (value.kind === "unknown" || value.token?.status === "unknown")
        issues.push({
          ref: node.ref,
          nodeId: node.nodeId,
          field: name,
          code: "token_source_unavailable",
          severity: "warning",
          message: `${name}: ${value.path ?? value.token?.path ?? "Token"} has no known source`,
        });
  const screen = workspace.product.manifest.entries.screens
    .map((entry) => workspace.product.entries[entry])
    .find((candidate) => candidate.id === design.selection.screenId);
  const presentation = screen?.presentations.find(
    (candidate) => candidate.id === design.selection.presentationId,
  );
  const set =
    design.selection.componentId &&
    components?.({
      packageId: design.selection.packageId,
      assetId: design.selection.componentId,
    });
  const target = {
    ...(screen
      ? {
          page: screen.name,
          platform: presentation?.platform ?? presentation?.name,
        }
      : {}),
    ...(set
      ? {
          component: set.name,
          variant: (set.axes ?? [])
            .map((axis) => {
              const chosen = set.variants.find(
                (variant) => variant.id === design.selection.variantId,
              )?.selection;
              return chosen?.[axis.id] !== undefined
                ? `${axis.name}=${chosen[axis.id]}`
                : undefined;
            })
            .filter(Boolean)
            .join(" · "),
        }
      : {}),
    ...(design.selection.nodeId ? { element: design.tree.root.name } : {}),
  };
  return {
    snapshot: { ...snapshot, nodes: undefined, target },
    nodes,
    issues,
    coverage: {
      ...(design.validation?.coverage ?? {
        checks: ["native-layout"],
        skipped: [],
      }),
      selection: design.selection,
      viewport: snapshot.viewport,
      combinations: 1,
      otherSizesAndStates: "not checked",
    },
  };
}

function fieldText(field) {
  const value =
    typeof field.value === "object"
      ? plain(field.value)
      : String(field.value ?? "?");
  if (field.kind === "token") {
    const token = field.token;
    const source =
      token.chain?.length > 1
        ? token.chain
            .map((item) => `${item.package} / ${item.path}`)
            .join(" → ")
        : token.package;
    const aliases =
      token.aliases
        ?.slice(1)
        .map(
          (item) =>
            `${item.path} (${item.package}${item.set ? ` / ${item.set}` : ""})`,
        ) ?? [];
    return `${value} {${token.path}} ← ${source}${token.set ? ` / ${token.set}` : ""}${aliases.length ? ` → ${aliases.join(" → ")}` : ""}`;
  }
  return `${value} · ${field.kind}${field.kind === "unknown" ? ` (${field.reason})` : ""}`;
}

export function inspectionText(report, { details = false } = {}) {
  const { snapshot } = report;
  const lines = [
    `SPEC · px · coordinates: page; local coordinates: parent top-left (page axes)`,
    `Target: ${
      Object.entries(snapshot.target)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${value}`)
        .join(" · ") ||
      report.nodes[0]?.name ||
      "selected design"
    }`,
    `Theme: ${snapshot.selection.themes?.join(" + ") || "defaults"} · viewport ${size(snapshot.viewport)}`,
    `Geometry: ${snapshot.status} · renderer: ${snapshot.renderer} · revision: ${snapshot.revision}`,
    `Snapshot: ${snapshot.id}`,
    "Use constraints for implementation; PNG for appearance; wireframe for spatial orientation.",
  ];
  for (const node of report.nodes) {
    const bounds = node.geometry.bounds;
    const layout = node.geometry.layoutBox;
    const indent = "  ".repeat(node.depth);
    lines.push(
      `${indent}[${node.ref}] ${node.name}${node.source.kind === "component" ? ` → ${node.source.name}${node.source.variant.length ? ` (${node.source.variant.join(" · ")})` : ""}` : ""}${node.visibility.value ? "" : " · hidden"}`,
    );
    lines.push(
      `${indent}  x=${number(bounds?.x)}, y=${number(bounds?.y)} · width=${node.constraints.width} → ${number(layout?.width)}px · height=${node.constraints.height} → ${number(layout?.height)}px${node.geometry.status === "partial" ? ` · partial (${node.geometry.reason})` : ""}`,
    );
    if (node.geometry.relativeToParent)
      lines.push(
        `${indent}  local: x=${number(node.geometry.relativeToParent.x)}, y=${number(node.geometry.relativeToParent.y)}`,
      );
    for (const axis of ["width", "height"])
      if (node.fields[axis]?.kind === "token")
        lines.push(
          `${indent}  ${axis} constraint: ${fieldText(node.fields[axis])}`,
        );
    const margins = Object.entries(node.fields).filter(
      ([key, value]) =>
        key.startsWith("margin") && (value.value || value.kind === "token"),
    );
    if (margins.length)
      lines.push(
        `${indent}  margin: ${margins.map(([key, value]) => `${key}=${fieldText(value)}`).join(" / ")}`,
      );
    if (node.fields.hideFillOnExport?.value)
      lines.push(
        `${indent}  export rule: hide fill; preview keeps the authored fill`,
      );
    if (node.layout) {
      lines.push(
        `${indent}  layout: ${node.layout.type === "flex" ? node.layout.direction : node.layout.type} · gap=${fieldText(node.fields.gap)} · justify=${node.layout.justify} · align=${node.layout.align} · ${node.layout.wrap}`,
      );
      lines.push(
        `${indent}  padding T/R/B/L: ${["Top", "Right", "Bottom", "Left"].map((side) => fieldText(node.fields[`padding${side}`])).join(" / ")}`,
      );
      for (const space of node.layout.spaces)
        lines.push(
          `${indent}  ${space.from} ↔ ${space.to}: ${number(space.actual)}px · ${space.source}${space.reason ? ` · partial (${space.reason})` : ""}`,
        );
      if (node.layout.spacingUnknown)
        lines.push(
          `${indent}  actual inter-item spacing: ? · partial (${node.layout.spacingUnknown})`,
        );
    }
    if (node.source.kind === "component") {
      lines.push(
        `${indent}  source: ${node.source.package} / ${node.source.name} / ${node.source.element}${node.source.role === "definition" ? " · shared definition" : ""}`,
      );
      if (node.source.status === "partial")
        lines.push(`${indent}  source chain: partial (${node.source.reason})`);
      lines.push(
        `${indent}  page overrides: ${node.source.overrides.length ? node.source.overrides.map((item) => `${item.element}.${item.field}=${plain(item.value)}`).join("; ") : node.source.role === "definition" ? "not applicable (shared definition)" : node.source.overridesKnown ? "none" : "unknown (source chain unavailable)"}`,
      );
    }
    if (node.fields.visible.kind === "token" || !node.visibility.value)
      lines.push(
        `${indent}  visible constraint: ${fieldText(node.fields.visible)} → ${node.visibility.value ? "visible" : "hidden"}${node.visibility.reason ? ` (${node.visibility.reason})` : ""}`,
      );
    if (node.text) {
      const content =
        !details && node.text.value.length > 120
          ? `${node.text.value.slice(0, 120)}… (+${node.text.value.length - 120} chars; expand --element)`
          : node.text.value;
      lines.push(
        `${indent}  text: ${JSON.stringify(content)} · ${node.text.wrapping} · lines=? (${node.text.lines.reason}) · ellipsis: unspecified`,
      );
    }
    if (node.interaction.status === "declared")
      lines.push(`${indent}  interaction: ${plain(node.interaction.readable)}`);
    if (details) {
      if (known(bounds))
        lines.push(
          `${indent}  axis-aligned bounds: ${size(bounds)} at ${number(bounds.x)},${number(bounds.y)}`,
        );
      if (node.text)
        lines.push(
          `${indent}  App primary faces: ${
            node.text.primaryFaces.length
              ? node.text.primaryFaces
                  .map((face) => `${face.family} ${face.weight} ${face.style}`)
                  .join(", ")
              : "? (native font plan unavailable)"
          } · per-glyph fallback: ? (${node.text.glyphFallback.reason})`,
        );
      for (const [name, value] of Object.entries(node.fields)) {
        if (/^(padding|gap$|visible$)/.test(name)) continue;
        lines.push(
          `${indent}  ${name}: ${fieldText(value)} · from ${value.source}`,
        );
      }
      lines.push(
        `${indent}  disabled reason: unspecified (no declared business rule)`,
      );
      if (node.interaction.status === "unspecified")
        lines.push(`${indent}  interaction: unspecified`);
    }
    for (const issue of report.issues.filter((item) => item.ref === node.ref))
      lines.push(
        `${indent}  ! ${issue.code}${issue.where ? ` (${issue.where})` : ""}: ${issue.message}${issue.otherRef ? ` [${issue.otherRef}]` : ""}`,
      );
  }
  for (const issue of report.issues.filter((item) => !item.ref))
    lines.push(`! ${issue.code}: ${issue.message}`);
  lines.push(
    `Coverage: 1 selected combination · ${report.coverage.checks.join(", ")} · other sizes/states: not checked`,
  );
  for (const skipped of inspectionCoverage(report.coverage).skipped)
    lines.push(
      `Skipped: ${skipped.check} ×${skipped.count} · ${skipped.reason ?? skipped.code}`,
    );
  return lines.join("\n");
}
