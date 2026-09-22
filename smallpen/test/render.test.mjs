import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inflateSync } from "node:zlib";

import { loadPackageFromValues } from "@smallpen/core";
import { createEvidence } from "@smallpen/local-package";
import { openPackage } from "@smallpen/local-package";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "roundtrip.smallpen");

function pngPixels(bytes, width) {
  const chunks = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = Buffer.from(bytes).readUInt32BE(offset);
    const type = Buffer.from(bytes.slice(offset + 4, offset + 8)).toString("ascii");
    if (type === "IDAT") chunks.push(bytes.slice(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const pixels = inflateSync(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  for (let row = 0; row < pixels.length; row += width * 4 + 1) {
    assert.equal(pixels[row], 0);
  }
  return pixels;
}

function pngPixel(bytes, width, x, y) {
  const pixels = pngPixels(bytes, width);
  const row = y * (width * 4 + 1);
  return [...pixels.slice(row + 1 + x * 4, row + 1 + x * 4 + 4)];
}

function pngColors(bytes, width, bounds) {
  const pixels = pngPixels(bytes, width);
  const colors = new Set();
  for (let y = bounds.top; y < bounds.bottom; y += 1) {
    const row = y * (width * 4 + 1);
    for (let x = bounds.left; x < bounds.right; x += 1) {
      colors.add(
        [...pixels.slice(row + 1 + x * 4, row + 1 + x * 4 + 4)].join(","),
      );
    }
  }
  return colors;
}

test("the local renderer emits deterministic PNG and evidence from one projection", async () => {
  const product = await openPackage(fixture);
  const first = await createEvidence(product, {
    scale: 1,
    selector: { viewFormat: "screenshot" },
  });
  const second = await createEvidence(product, {
    scale: 1,
    selector: { viewFormat: "screenshot" },
  });

  assert.deepEqual([...first.render.bytes.slice(0, 8)], [
    137, 80, 78, 71, 13, 10, 26, 10,
  ]);
  assert.equal(first.render.width, 800);
  assert.equal(first.render.height, 600);
  assert.equal(first.render.mimeType, "image/png");
  assert.equal(first.render.renderHash, second.render.renderHash);
  assert.deepEqual(first.render.bytes, second.render.bytes);
  assert.equal(first.evidence.packageHash, product.revision);
  assert.equal(first.evidence.revision, product.revision);
  assert.equal(first.evidence.selector.screenId, "scr_roundtrip");
  assert.deepEqual(first.evidence.nodeRegions, [
    { height: 600, nodeId: "node_canvas", width: 800, x: 0, y: 0 },
    {
      height: 120,
      nodeId: "node_rectangle",
      width: 240,
      x: 80,
      y: 96,
    },
  ]);
  assert.deepEqual(first.evidence.diagnostics, []);
});

test("the local renderer rejects unsafe output sizes before allocation", async () => {
  const product = await openPackage(fixture);
  await assert.rejects(
    createEvidence(product, {
      scale: 16,
      selector: { viewFormat: "screenshot" },
    }),
    (error) => error?.code === "invalid_render_scale",
  );
});

test("the local renderer rasterizes glyph outlines and ellipse silhouettes", async () => {
  const product = await openPackage(fixture);
  const presentation = product.entries["screens/roundtrip.json"].presentations[0];
  presentation.nodes.node_canvas.children.push("node_text", "node_ellipse");
  presentation.nodes.node_text = {
    children: [],
    fills: [{ color: "#111827", type: "solid" }],
    height: 32,
    id: "node_text",
    name: "Rendered text",
    text: "IIII",
    textStyle: {
      fontFamily: "sourcesanspro",
      fontId: "sourcesanspro",
      fontSize: 24,
      fontStyle: "normal",
      fontWeight: 400,
      letterSpacing: 0,
      lineHeight: 1.2,
      textAlign: "left",
      verticalAlign: "top",
    },
    type: "TEXT",
    width: 160,
    x: 360,
    y: 96,
  };
  presentation.nodes.node_ellipse = {
    children: [],
    fills: [{ color: "#2563eb", type: "solid" }],
    height: 48,
    id: "node_ellipse",
    name: "Rendered ellipse",
    type: "ELLIPSE",
    width: 80,
    x: 360,
    y: 160,
  };

  const narrow = await createEvidence(product);
  assert.deepEqual(pngPixel(narrow.render.bytes, narrow.render.width, 363, 102), [
    17, 24, 39, 255,
  ]);
  presentation.nodes.node_text.text = "WWWW";
  const wide = await createEvidence(product);
  assert.ok(
    pngColors(wide.render.bytes, wide.render.width, {
      bottom: 128,
      left: 360,
      right: 460,
      top: 96,
    }).size >= 10,
  );
  assert.notEqual(narrow.render.renderHash, wide.render.renderHash);

  presentation.nodes.node_ellipse.type = "RECTANGLE";
  const rectangle = await createEvidence(product);
  assert.notEqual(wide.render.renderHash, rectangle.render.renderHash);
  assert.deepEqual(rectangle.render.diagnostics, []);
});

test("the local renderer wraps bounded text without losing words or explicit line breaks", async (context) => {
  for (const [growType, textAlign, verticalAlign] of [
    [undefined, "left", "top"],
    ["fixed", "center", "center"],
    ["auto-height", "right", "bottom"],
  ]) {
    for (const scale of [1, 2]) {
      await context.test(`${growType ?? "default"} ${textAlign}/${verticalAlign} at ${scale}x`, async () => {
        const product = await openPackage(fixture);
        const presentation = product.entries["screens/roundtrip.json"].presentations[0];
        const node = {
          children: [],
          fills: [{ color: "#111827", type: "solid" }],
          ...(growType ? { growType } : {}),
          height: 180,
          id: "node_wrapped_text",
          name: "Width-constrained text",
          text: "Hello world\n\nHello world",
          textStyle: {
            fontFamily: "sourcesanspro",
            fontSize: 24,
            fontWeight: 400,
            lineHeight: 1.25,
            textAlign,
            verticalAlign,
          },
          type: "TEXT",
          width: 80,
          x: 360,
          y: 96,
        };
        presentation.nodes.node_canvas.children.push(node.id);
        presentation.nodes[node.id] = node;
        const wrapped = await createEvidence(product, { scale });
        // break-spaces retains the space at the end of the first visual line.
        node.text = "Hello \nworld\n\nHello \nworld";
        const explicit = await createEvidence(product, { scale });
        assert.equal(wrapped.render.renderHash, explicit.render.renderHash);
        assert.deepEqual(wrapped.render.bytes, explicit.render.bytes);

        node.growType = "auto-width";
        node.text = "Hello world\n\nHello world";
        const autoWidth = await createEvidence(product, { scale });
        assert.notEqual(autoWidth.render.renderHash, wrapped.render.renderHash);
      });
    }
  }
});

test("text decorations draw visible lines across each aligned text line", async (context) => {
  for (const textDecoration of ["underline", "line-through"]) {
    for (const scale of [1, 2]) {
      await context.test(`${textDecoration} at ${scale}x`, async () => {
        const product = await openPackage(fixture);
        const node =
          product.entries["screens/roundtrip.json"].presentations[0].nodes
            .node_rectangle;
        Object.assign(node, {
          fills: [{ color: "#111827", type: "solid" }],
          height: 120,
          text: "IIII IIII\nIIII IIII",
          textStyle: {
            fontFamily: "sourcesanspro",
            fontSize: 32,
            fontWeight: 400,
            lineHeight: 1.5,
            textAlign: "center",
            textDecoration: "none",
          },
          type: "TEXT",
          width: 240,
        });
        const plain = (await createEvidence(product, { scale })).render;
        node.textStyle.textDecoration = textDecoration;
        const decorated = (await createEvidence(product, { scale })).render;
        assert.notEqual(
          decorated.renderHash,
          plain.renderHash,
          "decoration must change actual pixels",
        );
        const before = pngPixels(plain.bytes, plain.width);
        const after = pngPixels(decorated.bytes, decorated.width);
        for (const lineIndex of [0, 1]) {
          const lineTop = (node.y + lineIndex * 48) * scale;
          const glyph = [];
          const changed = [];
          for (let y = lineTop; y < lineTop + 48 * scale; y += 1) {
            for (
              let x = node.x * scale;
              x < (node.x + node.width) * scale;
              x += 1
            ) {
              const offset = y * (plain.width * 4 + 1) + 1 + x * 4;
              if (before[offset] < 150) glyph.push({ x, y });
              if (
                !before
                  .subarray(offset, offset + 4)
                  .equals(after.subarray(offset, offset + 4))
              ) {
                changed.push({ x, y });
              }
            }
          }
          assert.ok(glyph.length > 0, "plain line contains visible glyphs");
          assert.ok(changed.length > 0, "each line has its own decoration");
          const glyphTop = Math.min(...glyph.map(({ y }) => y));
          const glyphBottom = Math.max(...glyph.map(({ y }) => y));
          const changedTop = Math.min(...changed.map(({ y }) => y));
          const changedBottom = Math.max(...changed.map(({ y }) => y));
          const glyphWidth =
            Math.max(...glyph.map(({ x }) => x)) -
            Math.min(...glyph.map(({ x }) => x));
          const changedWidth =
            Math.max(...changed.map(({ x }) => x)) -
            Math.min(...changed.map(({ x }) => x));
          assert.ok(
            changedWidth >= glyphWidth * 0.8,
            "decoration spans the aligned line, including its space",
          );
          assert.ok(
            changedBottom - changedTop < 8 * scale,
            "decoration is a narrow line, not a block fill",
          );
          if (textDecoration === "underline") {
            assert.ok(
              changedTop > glyphBottom,
              "underline is below capital glyphs",
            );
          } else {
            assert.ok(
              changedTop > glyphTop && changedBottom < glyphBottom,
              "strike passes through the glyph body",
            );
          }
        }
        assert.deepEqual(decorated.diagnostics, []);
      });
    }
  }
});

async function createValidatedTextEvidence(product, options) {
  const validated = await loadPackageFromValues(
    product.locator,
    new Map([
      ["manifest.json", product.manifest],
      ...Object.entries(product.entries),
    ]),
  );
  return createEvidence(validated, options);
}

test("rich text inherits block styles and applies run typography and paint", async (context) => {
  for (const owner of ["block", "run"]) {
    await context.test(
      `${owner} overrides match the equivalent plain-text control`,
      async () => {
        const product = await openPackage(fixture);
        const node =
          product.entries["screens/roundtrip.json"].presentations[0].nodes
            .node_rectangle;
        const baseStyle = {
          fontFamily: "sourcesanspro",
          fontSize: 18,
          fontWeight: 400,
          lineHeight: 1.5,
          textAlign: "center",
        };
        const text = "Styled text";
        const overrides = {
          fills: [{ color: "#dc2626", type: "solid" }],
          textStyle: {
            fontSize: 36,
            fontWeight: 700,
            textDecoration: "underline",
          },
        };
        Object.assign(node, {
          fills: [{ color: "#2563eb", type: "solid" }],
          height: 120,
          text,
          textBlocks: [
            owner === "block"
              ? {
                  textStyle: overrides.textStyle,
                  runs: [{ fills: overrides.fills, text }],
                }
              : { runs: [{ ...overrides, text }] },
          ],
          textStyle: baseStyle,
          type: "TEXT",
          width: 300,
        });
        const rich = (await createValidatedTextEvidence(product)).render;
        delete node.textBlocks;
        node.textStyle = { ...baseStyle, ...overrides.textStyle };
        node.fills = overrides.fills;
        const control = (await createValidatedTextEvidence(product)).render;
        assert.equal(
          rich.renderHash,
          control.renderHash,
          "resolved rich style matches plain style pixel-for-pixel",
        );
        assert.deepEqual(rich.bytes, control.bytes);
        assert.deepEqual(rich.diagnostics, []);
      },
    );
  }
  await context.test(
    "adjacent runs retain their own paint instead of the node fill",
    async () => {
      const product = await openPackage(fixture);
      const node =
        product.entries["screens/roundtrip.json"].presentations[0].nodes
          .node_rectangle;
      Object.assign(node, {
        fills: [{ color: "#111827", type: "solid" }],
        height: 90,
        text: "Red Blue",
        textBlocks: [
          {
            runs: [
              { text: "Red ", fills: [{ color: "#dc2626", type: "solid" }] },
              {
                text: "Blue",
                fills: [{ color: "#2563eb", type: "solid" }],
                textStyle: { fontSize: 36, fontWeight: 700 },
              },
            ],
          },
        ],
        textStyle: {
          fontFamily: "sourcesanspro",
          fontSize: 24,
          lineHeight: 1.5,
        },
        type: "TEXT",
        width: 300,
      });
      const { render } = await createValidatedTextEvidence(product);
      const colors = pngColors(render.bytes, render.width, {
        left: node.x,
        right: node.x + node.width,
        top: node.y,
        bottom: node.y + node.height,
      });
      assert.ok(colors.has("220,38,38,255"), "first run uses its red paint");
      assert.ok(colors.has("37,99,235,255"), "second run uses its blue paint");
      assert.equal(
        colors.has("17,24,39,255"),
        false,
        "overridden runs do not retain the node paint",
      );
      assert.deepEqual(render.diagnostics, []);
    },
  );
});

test("rich text preserves plain kerning, wrapping, and blank lines across run boundaries", async () => {
  for (const scale of [1, 2]) {
    const product = await openPackage(fixture);
    const node =
      product.entries["screens/roundtrip.json"].presentations[0].nodes
        .node_rectangle;
    Object.assign(node, {
      fills: [{ color: "#111827", type: "solid" }],
      height: 240,
      text: "AVATAR word\n\nAVATAR word",
      textStyle: {
        fontFamily: "sourcesanspro",
        fontSize: 24,
        fontWeight: 400,
        letterSpacing: 1.25,
        lineHeight: 1.5,
        textAlign: "center",
        verticalAlign: "center",
      },
      type: "TEXT",
      width: 100,
    });
    const plain = (await createValidatedTextEvidence(product, { scale })).render;
    node.textBlocks = [
      {
        runs: [
          { text: "AV" },
          { text: "ATAR word\n\nAVA" },
          { text: "TAR word" },
        ],
      },
    ];
    const rich = (await createValidatedTextEvidence(product, { scale })).render;
    assert.equal(
      rich.renderHash,
      plain.renderHash,
      `same typography across run boundaries at ${scale}x`,
    );
    assert.deepEqual(rich.bytes, plain.bytes);
    assert.deepEqual(rich.diagnostics, []);
  }
});

test("the local renderer reserves one em for a fallback symbol", async () => {
  const product = await openPackage(fixture);
  const presentation = product.entries["screens/roundtrip.json"].presentations[0];
  presentation.nodes.node_canvas.children.push("node_symbol_text");
  presentation.nodes.node_symbol_text = {
    children: [],
    fills: [{ color: "#111827", type: "solid" }],
    height: 24,
    id: "node_symbol_text",
    name: "Fallback symbol text",
    text: "←  Back",
    textStyle: {
      fontFamily: "sourcesanspro",
      fontId: "sourcesanspro",
      fontSize: 16,
      fontStyle: "normal",
      fontWeight: 600,
      letterSpacing: 0,
      lineHeight: 1.2,
      textAlign: "left",
      verticalAlign: "top",
    },
    type: "TEXT",
    width: 160,
    x: 360,
    y: 96,
  };

  const bundle = await createEvidence(product);

  assert.deepEqual(pngPixel(bundle.render.bytes, bundle.render.width, 380, 103), [
    244, 244, 245, 255,
  ]);
  assert.notDeepEqual(
    pngPixel(bundle.render.bytes, bundle.render.width, 384, 103),
    [244, 244, 245, 255],
  );
});

test("the local renderer clamps oversized rectangle radii to pill geometry", async () => {
  const product = await openPackage(fixture);
  const node =
    product.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_rectangle;
  node.cornerRadius = 999;
  node.fills = [{ color: "#2563eb", type: "solid" }];
  node.height = 48;
  node.strokes = [
    {
      alignment: "inner",
      color: "#111827",
      opacity: 1,
      style: "solid",
      type: "solid",
      width: 1,
    },
  ];
  node.width = 80;
  node.x = 80;
  node.y = 96;

  const bundle = await createEvidence(product);

  assert.deepEqual(pngPixel(bundle.render.bytes, bundle.render.width, 120, 120), [
    37, 99, 235, 255,
  ]);
  assert.deepEqual(pngPixel(bundle.render.bytes, bundle.render.width, 82, 98), [
    244, 244, 245, 255,
  ]);
  assert.deepEqual(pngPixel(bundle.render.bytes, bundle.render.width, 80, 96), [
    244, 244, 245, 255,
  ]);
});

test("rectangle strokes retain all four straight edges at their requested width", async (t) => {
  for (const cornerRadius of [0, 12, [0, 8, 12, 4]]) {
    for (const width of [1, 3]) {
      for (const scale of [1, 2]) {
        await t.test(`radius ${JSON.stringify(cornerRadius)}, width ${width}, scale ${scale}`, async () => {
          const product = await openPackage(fixture);
          const node = product.entries["screens/roundtrip.json"].presentations[0].nodes.node_rectangle;
          Object.assign(node, {
            cornerRadius,
            fills: [{ color: "#2563eb", type: "solid" }],
            height: 48,
            strokes: [{ alignment: "inner", color: "#111827", opacity: 1, style: "solid", type: "solid", width }],
            width: 80,
            x: 80,
            y: 96,
          });

          const { render } = await createEvidence(product, { scale });
          const pixels = pngPixels(render.bytes, render.width);
          const pixel = (x, y) => {
            const offset = y * (render.width * 4 + 1) + 1 + x * 4;
            return [...pixels.slice(offset, offset + 4)];
          };
          const left = node.x * scale;
          const top = node.y * scale;
          const right = left + node.width * scale;
          const bottom = top + node.height * scale;
          const centerX = left + 40 * scale;
          const centerY = top + 24 * scale;
          const thickness = width * scale;
          const stroke = [17, 24, 39, 255];
          const fill = [37, 99, 235, 255];

          for (let depth = 0; depth < thickness; depth += 1) {
            assert.deepEqual(pixel(centerX, top + depth), stroke, "top edge");
            assert.deepEqual(pixel(centerX, bottom - 1 - depth), stroke, "bottom edge");
            assert.deepEqual(pixel(left + depth, centerY), stroke, "left edge");
            assert.deepEqual(pixel(right - 1 - depth, centerY), stroke, "right edge");
          }
          assert.deepEqual(pixel(centerX, top + thickness), fill, "inside top edge");
          assert.deepEqual(pixel(centerX, bottom - 1 - thickness), fill, "inside bottom edge");
          assert.deepEqual(pixel(left + thickness, centerY), fill, "inside left edge");
          assert.deepEqual(pixel(right - 1 - thickness, centerY), fill, "inside right edge");
          assert.deepEqual(pixel(centerX, top - 1), [244, 244, 245, 255], "outside shape");
          assert.deepEqual(render.diagnostics, []);
        });
      }
    }
  }
});

test("the local renderer rasterizes qualified SVG Media references", async () => {
  const product = await openPackage(fixture);
  const library = await openPackage(fixture);
  const svg = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120"><rect width="120" height="120" rx="24" fill="#EF7B45"/><path d="M30 60h60M60 30v60" stroke="#fff" stroke-width="14" stroke-linecap="round"/></svg>',
  );
  const blob = "blobs/test-svg";
  library.manifest.packageId = "pkg_media_render_library";
  library.manifest.entries.assets = ["assets/media.json"];
  library.entries["assets/media.json"] = {
    colors: [],
    fonts: [],
    id: "alib_media",
    media: [
      {
        blob,
        byteLength: svg.byteLength,
        height: 120,
        id: "media_test_svg",
        mimeType: "image/svg+xml",
        name: "Test SVG",
        path: "",
        sha256: "0".repeat(64),
        width: 120,
      },
    ],
    typographies: [],
  };
  library.blobs.set(blob, svg);
  const node =
    product.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_rectangle;
  node.type = "IMAGE";
  node.mediaRef = {
    assetId: "media_test_svg",
    packageId: "pkg_media_render_library",
  };
  delete node.fills;

  const bundle = await createEvidence(product, { libraries: [library] });
  assert.equal(
    bundle.render.diagnostics.some(
      ({ code }) => code === "image_render_placeholder",
    ),
    false,
  );
  assert.deepEqual(pngPixel(bundle.render.bytes, bundle.render.width, 110, 126), [
    239, 123, 69, 255,
  ]);
  assert.deepEqual(pngPixel(bundle.render.bytes, bundle.render.width, 200, 156), [
    255, 255, 255, 255,
  ]);
});

test("evidence identity includes the Foundation revision", async () => {
  const product = await openPackage(fixture);
  const firstFoundation = { ...product, revision: "1".repeat(64) };
  const secondFoundation = { ...product, revision: "2".repeat(64) };
  const first = await createEvidence(product, {
    foundation: firstFoundation,
    selector: { viewFormat: "screenshot" },
  });
  const second = await createEvidence(product, {
    foundation: secondFoundation,
    selector: { viewFormat: "screenshot" },
  });

  assert.equal(first.evidence.productRevision, product.revision);
  assert.equal(first.evidence.foundationRevision, firstFoundation.revision);
  assert.notEqual(first.evidence.packageHash, second.evidence.packageHash);
});

test("Semantic evidence regions include nested rotation transforms", async () => {
  const product = await openPackage(fixture);
  const screen = product.entries["screens/roundtrip.json"];
  screen.presentations[0].nodes.node_rectangle.rotation = 90;
  const bundle = await createEvidence(product, {
    scale: 1,
    selector: { viewFormat: "screenshot" },
  });
  assert.deepEqual(bundle.evidence.nodeRegions[1], {
    height: 240,
    nodeId: "node_rectangle",
    width: 120,
    x: 140,
    y: 36,
  });
});
