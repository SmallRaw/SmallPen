import {
  projectDesignView,
  resolveDesignView,
  sha256Hex,
} from "@smallpen/core";
import { renderAppProjection } from "./render-shared.mjs";
import { inspectProjection } from "./layout-inspection.mjs";

// Rendering and measurement both use the App projector and Skia/WASM runtime.
export const renderProjection = renderAppProjection;

export async function measureProjectionText(product, projection, options = {}) {
  const textNodes = Object.values(projection.nodes).filter(
    (node) => node.type === "TEXT" && node.visible !== false && node.text,
  );
  if (!textNodes.length) return { items: [], diagnostics: [] };
  let rootId = "__smallpen_text_measurement__";
  while (Object.hasOwn(projection.nodes, rootId)) rootId += "_";
  const nodes = Object.fromEntries(
    textNodes.map((node) => [node.id, { ...node, children: [] }]),
  );
  nodes[rootId] = {
    id: rootId,
    type: "COMPONENT",
    name: "Text measurement",
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    children: textNodes.map((node) => node.id),
    fills: [],
  };
  const result = await renderAppProjection(
    product,
    { nodes, rootId },
    { ...options, crop: undefined, measureOnly: true },
  );
  return { items: result.textMetrics, diagnostics: result.diagnostics };
}

function flattenRegions(node, scale, width, height, origin, result = []) {
  const left = Math.max(0, Math.min(width, (node.bounds.x - origin.x) * scale));
  const top = Math.max(0, Math.min(height, (node.bounds.y - origin.y) * scale));
  const right = Math.max(
    0,
    Math.min(width, (node.bounds.x + node.bounds.width - origin.x) * scale),
  );
  const bottom = Math.max(
    0,
    Math.min(height, (node.bounds.y + node.bounds.height - origin.y) * scale),
  );
  result.push({
    height: Math.max(0, bottom - top),
    nodeId: node.id,
    width: Math.max(0, right - left),
    x: left,
    y: top,
  });
  for (const child of node.children)
    flattenRegions(child, scale, width, height, origin, result);
  return result;
}

export async function createEvidence(product, options = {}) {
  const resolved = resolveDesignView(product, options);
  const projection = projectDesignView(product, resolved, options);
  const inspection = await inspectProjection(product, projection, {
    ...options, raster: true, selection: resolved.selection,
  });
  const render = { ...inspection.render, diagnostics: inspection.snapshot.diagnostics };
  const semanticTree = inspection.tree;
  const origin = inspection.snapshot.viewport;
  return {
    projection,
    render,
    evidence: {
      diagnostics: render.diagnostics,
      layout: inspection.snapshot,
      snapshotId: inspection.snapshot.id,
      nodeRegions: flattenRegions(
        semanticTree.root,
        options.scale ?? 1,
        render.width,
        render.height,
        origin,
      ),
      packageHash: options.foundation
        ? await sha256Hex(`${product.revision}\0${options.foundation.revision}`)
        : product.revision,
      packageId: product.manifest.packageId,
      ...(options.foundation
        ? { foundationRevision: options.foundation.revision }
        : {}),
      productRevision: product.revision,
      renderHash: render.renderHash,
      renderer: render.renderer,
      kernelHash: render.kernelHash,
      revision: product.revision,
      selector: resolved.selection,
      semanticTree,
      viewport: {
        height: render.height,
        scale: options.scale ?? 1,
        width: render.width,
      },
    },
  };
}
