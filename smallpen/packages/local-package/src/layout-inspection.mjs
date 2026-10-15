import { canonicalJSON, createSemanticTree } from "@smallpen/core";
import { createHash } from "node:crypto";
import { renderAppProjection } from "./render-shared.mjs";

const hash = (value) =>
  createHash("sha256").update(canonicalJSON(value)).digest("hex");
const box = (value) =>
  value &&
  ["x", "y", "width", "height"].every((key) => Number.isFinite(value[key]))
    ? Object.fromEntries(
        ["x", "y", "width", "height"].map((key) => [key, value[key]]),
      )
    : null;

// Specifications, diagnostics, wireframes and raster evidence consume this
// result. Authored constraints stay in projection; only native results are
// allowed to supply actual geometry. In particular, missing measurements
// must never silently fall back to the projection's seed rectangles.
export async function inspectProjection(product, projection, options = {}) {
  const root = projection.nodes[projection.rootId];
  let render, failure;
  try {
    render = await renderAppProjection(product, projection, {
      ...options,
      cropNodeId: options.crop
        ? undefined
        : (options.nodeId ?? projection.rootId),
      measureOnly: !options.raster,
    });
  } catch (error) {
    if (
      options.raster ||
      ![
        "shared_renderer_unavailable",
        "shared_render_failed",
        "layout_not_settled",
        "font_resource_unavailable",
        "preview_fallback_not_renderable",
      ].includes(error.code)
    )
      throw error;
    failure = { code: error.code, message: error.message };
  }
  const origin = {
    x: (root?.x ?? 0) + (options.crop?.x ?? 0),
    y: (root?.y ?? 0) + (options.crop?.y ?? 0),
  };
  const translate = (value) => {
    const actual = box(value);
    return actual
      ? { ...actual, x: actual.x + origin.x, y: actual.y + origin.y }
      : null;
  };
  const tree = createSemanticTree(product, projection, {
    selection: options.selection,
  });
  const ids = [];
  const collect = (node) => {
    ids.push(node.id);
    node.children.forEach(collect);
  };
  collect(tree.root);
  const nodes = Object.fromEntries(
    ids.map((id) => {
      const bounds = translate(render?.bounds[id]);
      return [
        id,
        {
          status: bounds ? "resolved" : "partial",
          bounds,
          layoutBox: translate(render?.layoutBoxes[id]),
          ...(bounds
            ? {}
            : { reason: failure?.code ?? "native_bounds_unavailable" }),
        },
      ];
    }),
  );
  const update = (node, parentVisible = true) => {
    node.bounds = nodes[node.id]?.bounds ?? null;
    node.visible = parentVisible && node.visible;
    nodes[node.id].visible = node.visible;
    for (const child of node.children) update(child, node.visible);
  };
  update(tree.root);
  const diagnostics = failure
    ? [failure]
    : (render?.diagnostics ?? []).filter(
        (item) => item.code !== "layout_projection_partial",
      );
  const snapshot = {
    status: Object.values(nodes).every((node) => node.status === "resolved")
      ? "resolved"
      : "partial",
    renderer: render?.renderer ?? "app-wasm",
    kernelHash: render?.kernelHash ?? null,
    runtimeHash: render?.runtimeHash ?? null,
    resourcesHash: render?.resourcesHash ?? null,
    revision: product.revision,
    ...(options.foundation
      ? { foundationRevision: options.foundation.revision }
      : {}),
    libraries: (options.libraries ?? []).map((library) => ({
      packageId: library.manifest.packageId,
      revision: library.revision,
    })),
    selection: options.selection ?? {},
    coordinateSpace: "page",
    viewport: options.crop
      ? { ...origin, width: options.crop.width, height: options.crop.height }
      : (nodes[options.nodeId ?? projection.rootId]?.bounds ?? null),
    nodes,
    diagnostics,
  };
  snapshot.id = hash({
    ...snapshot,
    // Two theme/viewport/context selections must not share an identity merely
    // because they happen to paint the same pixels.
    packageId: product.manifest.packageId,
    projection,
  });
  snapshot.hash = snapshot.id;
  return { snapshot, tree, render };
}
