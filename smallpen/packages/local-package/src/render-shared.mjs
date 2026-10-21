import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { provisionFonts } from "./render-fonts.mjs";
import { inspectMedia } from "./media-inspect.mjs";
import { resolveFontResource } from "./font-resources.mjs";
import { SmallPenError, stableRuntimeUuid, elementPath } from "@smallpen/core";

const runtime = join(dirname(fileURLToPath(import.meta.url)), "..", "runtime");
let initialized;
let pending = Promise.resolve();

// The App's flex sizing rules (a hugging container cannot keep a child that
// fills it), for writers that build trees outside the App. Synchronous once
// loaded, so planners can call it.
export async function layoutSizingRules() {
  const engine = await (initialized ??= loadRenderer().catch((error) => {
    initialized = undefined;
    throw error;
  }));
  return (request) => engine.renderer.fixSizing(request);
}

async function loadRenderer() {
  try {
    const manifest = JSON.parse(
      await readFile(join(runtime, "manifest.json"), "utf8"),
    );
    const [renderer, factory, wasmBytes, rendererBytes, wrapperBytes] = await Promise.all([
      import(
        pathToFileURL(join(runtime, "renderer.mjs")).href +
          "?version=" +
          manifest.rendererHash
      ),
      import(
        pathToFileURL(join(runtime, "render-wasm.js")).href +
          "?version=" +
          manifest.wrapperHash
      ),
      readFile(join(runtime, "render-wasm.wasm")),
      readFile(join(runtime, "renderer.mjs")),
      readFile(join(runtime, "render-wasm.js")),
    ]);
    if (
      createHash("sha256").update(wasmBytes).digest("hex") !==
      manifest.kernelHash ||
      createHash("sha256").update(rendererBytes).digest("hex") !== manifest.rendererHash ||
      createHash("sha256").update(wrapperBytes).digest("hex") !== manifest.wrapperHash
    )
      throw new Error(
        "Rendering runtime changed during initialization; retry after the build finishes",
      );
    const module = await factory.default({
      wasmBinary: wasmBytes,
      noInitialRun: true,
    });
    renderer.initialize(module);
    const fonts = [];
    const families = renderer.builtinFonts().map((family) => ({
      fontId: family.id,
      names: [family.id, family.name, family.family],
      variants: family.variants,
    }));
    for (const family of families)
      for (const variant of family.variants)
        fonts.push({
          fontId: family.fontId,
          weight: Number(variant.weight),
          style: variant.style,
          names: family.names,
          bytes: await readFile(join(runtime, "fonts", variant["ttf-url"])),
        });
    return {
      renderer,
      fonts,
      families,
      kernelHash: createHash("sha256").update(wasmBytes).digest("hex"),
      runtimeHash: createHash("sha256").update(rendererBytes).update(wrapperBytes).digest("hex"),
    };
  } catch (cause) {
    throw new SmallPenError(
      "shared_renderer_unavailable",
      "The shared App rendering runtime is unavailable; build the SmallPen renderer first",
      { cause: cause.message },
    );
  }
}

async function resources(engine, product, options) {
  const fonts = [...engine.fonts],
    fontFamilies = [...engine.families],
    images = [];
  for (const snapshot of [
    product,
    options.foundation,
    ...(options.libraries ?? []),
  ].filter(Boolean)) {
    for (const entry of snapshot.manifest.entries.assets) {
      const library = snapshot.entries[entry];
      for (const family of library.fonts) {
        const fontId = `custom-${snapshot.runtime.fonts[family.id]}`;
        fontFamilies.push({
          fontId,
          names: [family.family],
          variants: family.variants.map((variant) => ({
            id: `${variant.style}-${variant.weight}`,
            weight: String(variant.weight),
            style: variant.style,
          })),
        });
        for (const variant of family.variants) {
          fonts.push({
            fontId,
            weight: variant.weight,
            style: variant.style,
            load: async () => (await resolveFontResource(snapshot, variant, "sfnt")).bytes,
          });
        }
      }
      for (const media of library.media)
        images.push({
          id: snapshot.runtime.media[media.id],
          bytes: snapshot.blobs.get(media.blob),
          mimeType: media.mimeType,
          width: media.width,
          height: media.height,
        });
    }
  }
  return { fonts, fontFamilies, images };
}

// Nodes have already resolved their components and Tokens. The App node
// projector only needs asset metadata and resource identities here. Sending
// every page and variant made each native measurement convert the entire
// package to Clojure data twice, even for a single button.
function renderSnapshot(snapshot) {
  const assets = snapshot.manifest.entries.assets;
  return {
    manifest: { packageId: snapshot.manifest.packageId, entries: { assets } },
    entries: Object.fromEntries(assets.map(entry => [entry, snapshot.entries[entry]])),
    runtime: { file: snapshot.runtime.file, fonts: snapshot.runtime.fonts, media: snapshot.runtime.media },
  };
}

export async function renderAppProjection(product, projection, options = {}) {
  if (projection.fallbackUsed)
    throw new SmallPenError(
      "preview_fallback_not_renderable",
      "Preview fallback cannot be used for strict rendering",
    );
  const root = projection.nodes[projection.rootId];
  if (!root)
    throw new SmallPenError(
      "missing_root_node",
      "Projection root is unavailable",
    );
  const scale = options.scale ?? 1;
  if (!Number.isFinite(scale) || scale <= 0 || scale > 8)
    throw new SmallPenError(
      "invalid_render_scale",
      "Render scale must be within (0, 8]",
    );
  const crop = options.crop;
  if (
    crop &&
    (![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) ||
      crop.width <= 0 ||
      crop.height <= 0)
  )
    throw new SmallPenError(
      "invalid_render_crop",
      "Crop must have finite x/y and positive width/height",
    );
  const width = Math.ceil((crop?.width ?? root.width) * scale),
    height = Math.ceil((crop?.height ?? root.height) * scale);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1 ||
    (!options.measureOnly && !options.cropNodeId &&
      (width > 8192 || height > 8192 || width * height > 32 * 1024 * 1024))
  )
    throw new SmallPenError(
      "render_size_exceeded",
      "Rendered image exceeds safety limits",
      { width, height, maxDimension: 8192, maxPixels: 32 * 1024 * 1024,
        correction: "Reduce --scale or export a selected --element; layout dimensions stay unchanged" },
    );
  const perform = async () => {
    const engine = await (initialized ??= loadRenderer().catch((error) => {
      initialized = undefined;
      throw error;
    }));
    let sourceIds = {};
    try {
      const assets = await resources(engine, product, options);
      let nodes = projection.nodes,
        rootId = projection.rootId;
      {
        const crop = options.crop ?? {
          x: 0,
          y: 0,
          width: root.width,
          height: root.height,
        };
        let cropId = "__smallpen_crop__";
        while (Object.hasOwn(nodes, cropId)) cropId += "_";
        nodes = {
          ...nodes,
          [rootId]: { ...root, x: -crop.x, y: -crop.y },
          [cropId]: {
            id: cropId,
            name: "Render crop",
            type: "COMPONENT",
            x: 0,
            y: 0,
            width: crop.width,
            height: crop.height,
            children: [rootId],
            fills: [],
            "show-content": false,
          },
        };
        rootId = cropId;
      }
      const nodeIds = Object.fromEntries(
        await Promise.all(
          Object.keys(nodes).map(async (id) => [
            id,
            await stableRuntimeUuid(
              product.manifest.packageId,
              "render-node",
              id,
            ),
          ]),
        ),
      );
      const request = {
        snapshot: {
          ...renderSnapshot(product),
          libraries: [options.foundation, ...(options.libraries ?? [])]
            .filter(Boolean)
            .map(renderSnapshot),
        },
        nodes,
        nodeIds,
        rootId,
        cropNodeId: options.cropNodeId ? nodeIds[options.cropNodeId] : undefined,
        scale,
        measureOnly: options.measureOnly === true,
        forExport: options.forExport === true,
        fontFamilies: assets.fontFamilies,
      };
      sourceIds = Object.fromEntries(
        Object.entries(nodeIds).map(([id, uuid]) => [uuid, id]),
      );
      const described = engine.renderer.describe(request);
      const fontResources = await provisionFonts(
        described.fonts,
        assets.fonts,
        sourceIds,
        (id) => projection.nodes[id]?.textStyle,
      );
      request.fonts = fontResources.fonts;
      request.images = assets.images
        .filter((image) => described.images.includes(image.id))
        .map((image) => {
          if (!image.bytes)
            throw new SmallPenError(
              "media_resource_unavailable",
              "A referenced media blob is unavailable",
              { id: image.id },
            );
          const actual = inspectMedia(image.bytes, image.mimeType);
          if (
            actual.width > 8192 ||
            actual.height > 8192 ||
            actual.width * actual.height > 32 * 1024 * 1024
          )
            throw new SmallPenError(
              "media_size_exceeded",
              "Image exceeds the renderer limits",
              { id: image.id },
            );
          if (image.mimeType === "image/svg+xml") {
            if (
              !Number.isFinite(image.width) ||
              !Number.isFinite(image.height) ||
              image.width < 1 ||
              image.height < 1 ||
              image.width > 8192 ||
              image.height > 8192 ||
              image.width * image.height > 32 * 1024 * 1024
            )
              throw new SmallPenError(
                "media_size_exceeded",
                "SVG image exceeds the rendering resource limit",
              );
            // Skia parses and draws the SVG; this only supplies its intrinsic size.
            image.svg = Buffer.from(image.bytes)
              .toString("utf8")
              .replace(
                /<svg\b([^>]*)>/i,
                (_match, attrs) =>
                  "<svg" +
                  attrs.replace(
                    /\s(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*')/gi,
                    "",
                  ) +
                  ' width="' +
                  image.width +
                  '" height="' +
                  image.height +
                  '">',
              );
          }
          return image;
        });
      const result = engine.renderer.render(request);
      const bytes = result.bytes ?? new Uint8Array();
      const buffer = Buffer.from(bytes);
      const bounds = Object.fromEntries(
        Object.entries(result.bounds).map(([uuid, box]) => [
          sourceIds[uuid],
          box,
        ]),
      );
      const textMetrics = Object.entries(result.textMetrics).map(
        ([uuid, metrics]) => ({
          nodeId: sourceIds[uuid],
          width: metrics["max-width"],
          height: metrics.height,
          growType: projection.nodes[sourceIds[uuid]]?.growType ?? "fixed",
          missingGlyphs: [
            ...(fontResources.missingGlyphs.get(sourceIds[uuid]) ?? []),
          ],
          longestPiece: fontResources.longest.get(sourceIds[uuid]),
        }),
      );
      return {
        bytes,
        width: bytes.length ? buffer.readUInt32BE(16) : width,
        height: bytes.length ? buffer.readUInt32BE(20) : height,
        mimeType: "image/png",
        diagnostics: [
          ...(options.measureOnly ? [] : (projection.diagnostics ?? [])),
          ...fontResources.diagnostics,
        ],
        renderer: "app-wasm",
        kernelHash: engine.kernelHash,
        runtimeHash: engine.runtimeHash,
        resourcesHash: createHash("sha256").update(JSON.stringify({
          fonts: fontResources.fonts.map(face => ({
            id: face.fontId, weight: face.weight, style: face.style,
            hash: createHash("sha256").update(face.bytes).digest("hex"),
          })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
          images: request.images.map(image => ({
            id: image.id,
            hash: createHash("sha256").update(image.svg ?? image.bytes).digest("hex"),
          })).sort((a, b) => a.id.localeCompare(b.id)),
        })).digest("hex"),
        renderHash: createHash("sha256").update(bytes).digest("hex"),
        geometry: result.geometry,
        layoutBoxes: Object.fromEntries(Object.entries(result.geometry).map(([uuid, value]) => [sourceIds[uuid], value])),
        bounds,
        textMetrics,
        fontRequests: described.fonts.filter(face => sourceIds[face.nodeId]).map(face => {
          const names = assets.fontFamilies.find(family => family.fontId === face.fontId)?.names;
          return { nodeId: sourceIds[face.nodeId], family: names?.[1] ?? names?.[0] ?? face.fontId,
            fontId: face.fontId, weight: face.weight, style: face.style };
        }),
      };
    } catch (error) {
      if (error instanceof SmallPenError) throw error;
      // A native panic invalidates the module. A later request can reload it.
      if (error instanceof WebAssembly.RuntimeError) initialized = undefined;
      const details = engine.renderer.errorDetails(error) ?? {};
      if (/panic|wasm/.test(details.code ?? "")) initialized = undefined;
      if (details.nodes) details.nodes = details.nodes.map(node => {
        const nodeId = sourceIds[node.nodeId] ?? node.nodeId;
        return { ...node, nodeId, path: elementPath(projection.nodes, projection.rootId, nodeId) };
      });
      throw new SmallPenError(
        details.code?.replaceAll("-", "_") ?? "shared_render_failed",
        error.message ?? "Shared App renderer failed",
        details,
      );
    }
  };
  const result = pending.then(perform);
  pending = result.catch(() => {});
  return result;
}
