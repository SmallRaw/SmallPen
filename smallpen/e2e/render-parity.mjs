import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { serveLocalPackage } from "@smallpen/background";
import {
  createEvidence,
  importFontVariant,
  openPackage,
  renderAppProjection,
  sfntToWoff,
} from "@smallpen/local-package";
import { servePenpotFrontend } from "@smallpen/web";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "..", "frontend", "package.json"));
const { chromium } = require("playwright");
const { PNG } = createRequire(import.meta.url)("pngjs");

const solid = (color) => [{ type: "solid", color }];
const rect = (id, x, y, width, height, extra = {}) => ({
  id,
  name: id,
  type: "RECTANGLE",
  children: [],
  x,
  y,
  width,
  height,
  fills: solid("#18181b"),
  ...extra,
});

// Reuse a bundled outline but give four CJK codepoints an exact one-em
// advance. This tests CJK line breaking without depending on system fonts.
function precisionFont(source) {
  const font = require("opentype.js").parse(
    source.buffer.slice(
      source.byteOffset,
      source.byteOffset + source.byteLength,
    ),
  );
  const glyph = font.charToGlyph("1").index;
  const count = source.readUInt16BE(4),
    tables = [];
  for (let i = 0; i < count; i++) {
    const offset = 12 + i * 16;
    tables.push({
      tag: source.toString("ascii", offset, offset + 4),
      bytes: Buffer.from(
        source.subarray(
          source.readUInt32BE(offset + 8),
          source.readUInt32BE(offset + 8) + source.readUInt32BE(offset + 12),
        ),
      ),
    });
  }
  const codes = [..."保存配置"]
    .map((c) => c.codePointAt(0))
    .sort((a, b) => a - b)
    .concat(65535);
  const segments = codes.length,
    cmap = Buffer.alloc(12 + 16 + segments * 8);
  cmap.writeUInt16BE(1, 2);
  cmap.writeUInt16BE(3, 4);
  cmap.writeUInt16BE(1, 6);
  cmap.writeUInt32BE(12, 8);
  cmap.writeUInt16BE(4, 12);
  cmap.writeUInt16BE(cmap.length - 12, 14);
  cmap.writeUInt16BE(segments * 2, 18);
  cmap.writeUInt16BE(8, 20);
  cmap.writeUInt16BE(2, 22);
  cmap.writeUInt16BE(2, 24);
  for (let i = 0; i < segments; i++) {
    cmap.writeUInt16BE(codes[i], 26 + i * 2);
    cmap.writeUInt16BE(codes[i], 28 + segments * 2 + i * 2);
    cmap.writeUInt16BE(
      ((codes[i] === 65535 ? 0 : glyph) - codes[i]) & 65535,
      28 + segments * 4 + i * 2,
    );
  }
  tables.find((t) => t.tag === "cmap").bytes = cmap;
  tables
    .find((t) => t.tag === "hmtx")
    .bytes.writeUInt16BE(font.unitsPerEm, glyph * 4);
  tables.find((t) => t.tag === "head").bytes.writeUInt32BE(0, 8);
  const checksum = (bytes) => {
    let sum = 0;
    for (let i = 0; i < bytes.length; i += 4)
      sum = (sum + bytes.readUInt32BE(i)) >>> 0;
    return sum;
  };
  const header = Buffer.from(source.subarray(0, 12 + count * 16));
  let offset = header.length;
  for (let i = 0; i < tables.length; i++) {
    const table = tables[i],
      padded = Buffer.alloc(Math.ceil(table.bytes.length / 4) * 4);
    table.bytes.copy(padded);
    table.padded = padded;
    table.offset = offset;
    header.writeUInt32BE(checksum(padded), 16 + i * 16);
    header.writeUInt32BE(offset, 20 + i * 16);
    header.writeUInt32BE(table.bytes.length, 24 + i * 16);
    offset += padded.length;
  }
  const bytes = Buffer.concat([header, ...tables.map((t) => t.padded)]);
  bytes.writeUInt32BE(
    (0xb1b0afba - checksum(bytes)) >>> 0,
    tables.find((t) => t.tag === "head").offset + 8,
  );
  return bytes;
}

// One contract scene exercises the shared semantics, rather than a page's styling.
function nodes() {
  const result = {
    node_canvas: rect("node_canvas", 0, 0, 800, 600, {
      name: "Render parity",
      type: "FRAME",
      fills: solid("#ffffff"),
      children: [],
    }),
    node_opacity: rect("node_opacity", 24, 24, 80, 80, {
      type: "FRAME",
      opacity: 0.5,
      children: ["node_white_mark"],
    }),
    node_white_mark: rect("node_white_mark", 20, 20, 40, 40, {
      fills: solid("#ffffff"),
    }),
    node_nested: rect("node_nested", 128, 24, 80, 80, {
      type: "FRAME",
      opacity: 0.5,
      children: ["node_nested_red"],
    }),
    node_nested_red: rect("node_nested_red", 20, 20, 40, 40, {
      opacity: 0.5,
      fills: solid("#ff0000"),
    }),
    node_alpha_hex: rect("node_alpha_hex", 232, 24, 80, 80, {
      fills: solid("#18181b00"),
    }),
    node_alpha_rgba: rect("node_alpha_rgba", 336, 24, 80, 80, {
      fills: [{ type: "solid", color: "rgba(255, 0, 0, 0.5)", opacity: 0.5 }],
    }),
    node_opacity_stroke: rect("node_opacity_stroke", 440, 24, 80, 80, {
      opacity: 0.5,
      strokes: [
        { type: "solid", color: "#ffffff", width: 8, alignment: "inner" },
      ],
    }),
    node_fill_row: rect("node_fill_row", 24, 360, 400, 100, {
      type: "FRAME",
      fills: [],
      children: ["node_fill_control"],
      layout: "flex",
      "layout-flex-dir": "row",
      "layout-align-items": "center",
      "layout-padding": { p1: 12, p2: 12, p3: 12, p4: 12 },
    }),
    node_fill_control: rect("node_fill_control", 0, 0, 160, 44, {
      type: "FRAME",
      fills: solid("#ffffff"),
      children: ["node_focus_outline"],
      "layout-item-h-sizing": "fill",
      "layout-item-v-sizing": "fix",
      strokes: [
        { type: "solid", color: "#d4d4d8", width: 1, alignment: "inner" },
      ],
    }),
    node_focus_outline: rect("node_focus_outline", -4, -4, 168, 52, {
      fills: [],
      "layout-item-absolute": true,
      "constraints-h": "leftright",
      "constraints-v": "topbottom",
      strokes: [
        { type: "solid", color: "#71717a", width: 2, alignment: "inner" },
      ],
    }),
    node_shadow_filled: rect("node_shadow_filled", 540, 380, 80, 40, {
      fills: solid("#ffffff"),
      shadow: [
        { offsetX: 0, offsetY: 6, blur: 12, spread: 0, color: "#0000004d" },
      ],
    }),
    node_shadow_negative: rect("node_shadow_negative", 660, 380, 80, 40, {
      fills: solid("#ffffff"),
      shadow: [
        { offsetX: 0, offsetY: 18, blur: 0, spread: -6, color: "#00000066" },
      ],
    }),
    node_measured_text: rect("node_measured_text", 24, 500, 240, 36, {
      type: "TEXT",
      text: "Measured without a source edit",
      growType: "auto-height",
      textStyle: {
        fontFamily: "Source Sans Pro",
        fontId: "sourcesanspro",
        fontVariantId: "regular",
        fontWeight: 400,
        fontSize: 16,
        lineHeight: 1.25,
      },
    }),
  };
  for (const [index, alignment] of ["inner", "center", "outer"].entries()) {
    for (const radius of [0, 12]) {
      const id = `node_stroke_${alignment}_${radius}`;
      result[id] = rect(
        id,
        24 + index * 160,
        144 + (radius ? 100 : 0),
        120,
        64,
        {
          cornerRadius: radius,
          fills: [],
          strokes: [
            {
              type: "solid",
              color: "#18181b",
              style: "solid",
              alignment,
              width: 2,
              widthTop: 0,
              widthBottom: 8,
            },
          ],
        },
      );
    }
  }
  const descendants = new Set(
    Object.values(result).flatMap((node) => node.children),
  );
  result.node_canvas.children = Object.keys(result).filter(
    (id) => id !== "node_canvas" && !descendants.has(id),
  );
  return result;
}

async function stableScreenshot(page, clip) {
  let previous;
  for (let attempt = 0; attempt < 20; attempt++) {
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const bytes = await page.screenshot({ clip });
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash === previous) return bytes;
    previous = hash;
  }
  throw new Error("Renderer never reached a stable frame");
}

function compareGeometry(expectedBytes, actualBytes) {
  const expected = PNG.sync.read(Buffer.from(expectedBytes));
  const actual = PNG.sync.read(actualBytes);
  assert.equal(actual.width, expected.width);
  assert.equal(actual.height, expected.height);
  let bad = 0,
    total = 0;
  // Font rasterization has a separate contract. All paint/layout pixels stay in scope.
  for (let y = 0; y < 480; y++)
    for (let x = 0; x < actual.width; x++) {
      const i = (y * actual.width + x) * 4;
      let difference = 0;
      for (let channel = 0; channel < 3; channel++) {
        difference = Math.max(
          difference,
          Math.abs(expected.data[i + channel] - actual.data[i + channel]),
        );
      }
      total += difference;
      if (difference > 16) bad++;
    }
  return {
    differencePercent: (100 * bad) / (actual.width * 480),
    meanMaxChannelError: total / (actual.width * 480),
  };
}

async function main() {
  const artifacts = await mkdtemp(join(tmpdir(), "smallpen-render-parity-"));
  const packagePath = join(artifacts, "contract.smallpen");
  await cp(join(root, "test", "fixtures", "roundtrip.smallpen"), packagePath, {
    recursive: true,
  });
  const screenPath = join(packagePath, "screens", "roundtrip.json");
  const screen = JSON.parse(await readFile(screenPath, "utf8"));
  screen.presentations[0].nodes = nodes();
  const scene = screen.presentations[0];
  scene.rootIds = ["node_canvas", "node_precision_root"];
  scene.nodes.node_precision_root = rect(
    "node_precision_root",
    1950.16,
    0,
    360,
    220,
    {
      type: "FRAME",
      name: "Precision boundary",
      fills: solid("#ffffff"),
      children: [
        "node_precision_fit",
        "node_precision_narrow",
        "node_precision_rich",
      ],
    },
  );
  for (const [id, y, width] of [
    ["node_precision_fit", 12, 56],
    ["node_precision_narrow", 84, 54],
  ]) {
    scene.nodes[id] = rect(id, 64, y, width, 57, {
      type: "TEXT",
      text: "保存配置",
      growType: "auto-height",
      textStyle: {
        fontFamily: "Precision Source Sans",
        fontId: "font_precision",
        fontSize: 14,
        fontWeight: 400,
        lineHeight: 1.5,
      },
    });
  }
  scene.nodes.node_precision_rich = {
    ...scene.nodes.node_precision_narrow,
    id: "node_precision_rich",
    name: "CJK across rich text runs",
    y: 156,
    textBlocks: [{ runs: [{ text: "保存" }, { text: "配置" }] }],
  };
  // Embed the same face for all three renderers. Four one-em glyphs fit
  // exactly in 56px; x=2014.16 crosses the f32 exponent boundary.
  const fonts = join(root, "..", "frontend", "resources", "public", "fonts");
  const precisionTtf = precisionFont(
    await readFile(join(fonts, "sourcesanspro-regular.ttf")),
  );
  await importFontVariant(packagePath, {
    family: "Precision Source Sans",
    fontId: "font_precision",
    id: "fvar_precision_regular",
    name: "Regular",
    style: "normal",
    weight: 400,
    files: {
      ttf: { bytes: precisionTtf, mimeType: "font/ttf" },
      woff: {
        bytes: sfntToWoff(precisionTtf, "font/ttf"),
        mimeType: "font/woff",
      },
    },
  });
  await writeFile(screenPath, JSON.stringify(screen, null, 2));
  const product = await openPackage(packagePath);
  const evidence = await createEvidence(product, {
    selector: { viewFormat: "screenshot" },
  });
  evidence.render = await renderAppProjection(product, {
    ...evidence.projection,
    rootId: "node_canvas",
  });
  const { nodes: projected } = evidence.projection;
  assert.equal(projected.node_fill_control.width, 376);
  assert.equal(projected.node_focus_outline.width, 384);
  await writeFile(join(artifacts, "cli.png"), evidence.render.bytes);
  const cliPrecision = await renderAppProjection(product, {
    ...evidence.projection,
    rootId: "node_precision_root",
  });
  await writeFile(join(artifacts, "cli-precision.png"), cliPrecision.bytes);

  const background = await serveLocalPackage({ packagePath, port: 0 });
  const web = await servePenpotFrontend({
    backendUrl: background.url,
    frontendRoot: join(root, "..", "frontend", "resources", "public"),
    port: 0,
  });
  const browser = await chromium.launch({ headless: true });
  const errors = [],
    metrics = {};
  try {
    const page = await browser.newPage({
      viewport: { width: 1800, height: 1200 },
      deviceScaleFactor: 1,
    });
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("response", (response) => {
      if (response.status() >= 400)
        errors.push(`${response.status()} ${response.url()}`);
    });
    for (const mode of ["svg", "webgl"]) {
      await page.goto(web.workspaceUrl);
      await page.getByTestId("layer-row").first().waitFor({ timeout: 60_000 });
      if (mode === "webgl") {
        await page
          .getByRole("button", { name: "Main menu", exact: true })
          .click();
        await page.getByTestId("preferences").click();
        await page.getByText(/Enable WebGL/i).click();
        await page.locator("canvas#render").waitFor({ timeout: 60_000 });
      }
      const row = page
        .getByTestId("layer-row")
        .filter({ hasText: "Render parity" })
        .first();
      await row.click();
      await page.keyboard.press("Shift+2");
      await page.keyboard.press("Shift+0");
      await page.waitForFunction(
        () =>
          Math.abs(
            document.querySelector("svg.viewport-controls")?.getScreenCTM()?.a -
              1,
          ) < 1e-8,
      );
      await page.evaluate(() => document.fonts.ready);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(750); // Let the WebGL pan/zoom debounce finish.
      await page.addStyleTag({
        content: "svg.viewport-controls { visibility: hidden; }",
      });
      const clip = await page
        .locator("svg.viewport-controls")
        .evaluate((svg) => {
          const matrix = svg.getScreenCTM();
          return { x: matrix.e, y: matrix.f, width: 800, height: 600 };
        });
      const bytes = await stableScreenshot(page, clip);
      await writeFile(join(artifacts, `${mode}.png`), bytes);
      const diff = compareGeometry(evidence.render.bytes, bytes);
      metrics[mode] = diff;
      // Controlled geometry leaves only curved-edge AA; a border/layout/opacity
      // regression exceeds either bound. Keep both so large errors cannot average out.
      assert.ok(
        diff.differencePercent < 0.15,
        `${mode}: ${JSON.stringify(diff)}`,
      );
      assert.ok(
        diff.meanMaxChannelError < 0.3,
        `${mode}: ${JSON.stringify(diff)}`,
      );
      await page
        .getByTestId("layer-row")
        .filter({ hasText: "Precision boundary" })
        .first()
        .click();
      await page.keyboard.press("Shift+2");
      await page.keyboard.press("Shift+0");
      await page.waitForLoadState("networkidle");
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(750);
      const precisionClip = await page
        .locator("svg.viewport-controls")
        .evaluate((svg) => {
          const m = svg.getScreenCTM();
          return { x: 1950.16 * m.a + m.e, y: m.f, width: 360, height: 220 };
        });
      const precision = await stableScreenshot(page, precisionClip);
      await writeFile(join(artifacts, `${mode}-precision.png`), precision);
      function inkHeight(bytes, top, bottom) {
        const pixels = PNG.sync.read(Buffer.from(bytes));
        let first = Infinity,
          last = -Infinity;
        for (let y = top; y < bottom; y++)
          for (let x = 0; x < pixels.width; x++) {
            const offset = (y * pixels.width + x) * 4;
            if (
              pixels.data[offset] < 100 &&
              pixels.data[offset + 1] < 100 &&
              pixels.data[offset + 2] < 100
            ) {
              first = Math.min(first, y);
              last = Math.max(last, y);
            }
          }
        return last - first + 1;
      }
      const fitHeight = inkHeight(precision, 0, 80),
        narrowHeight = inkHeight(precision, 80, 150),
        richHeight = inkHeight(precision, 150, 220);
      const cliFitHeight = inkHeight(cliPrecision.bytes, 0, 80),
        cliNarrowHeight = inkHeight(cliPrecision.bytes, 80, 150),
        cliRichHeight = inkHeight(cliPrecision.bytes, 150, 220);
      assert.ok(
        cliFitHeight > 4 && cliFitHeight < 15,
        `cli: exact-fit text wrapped (${cliFitHeight}px)`,
      );
      assert.ok(
        cliNarrowHeight > 20,
        `cli: narrow text stopped wrapping (${cliNarrowHeight}px)`,
      );
      assert.equal(
        cliRichHeight,
        cliNarrowHeight,
        "CLI rich text uses the same CJK breaks",
      );
      assert.ok(
        fitHeight > 4 && fitHeight < 15,
        `${mode}: exact-fit text wrapped (${fitHeight}px)`,
      );
      assert.ok(
        narrowHeight > 20,
        `${mode}: genuinely narrow text stopped wrapping (${narrowHeight}px)`,
      );
      assert.equal(
        richHeight,
        narrowHeight,
        `${mode}: rich text uses the same CJK breaks`,
      );
      metrics[mode].precision = {
        fitHeight,
        narrowHeight,
        cliFitHeight,
        cliNarrowHeight,
        richHeight,
        cliRichHeight,
      };
      assert.equal(
        (await openPackage(packagePath)).revision,
        product.revision,
        `${mode}: opening the workspace wrote computed geometry into the package`,
      );
    }
    assert.deepEqual(errors, []);
    await writeFile(
      join(artifacts, "results.json"),
      JSON.stringify({ revision: product.revision, metrics, errors }, null, 2),
    );
    console.log(JSON.stringify({ status: "passed", artifacts, metrics }));
  } catch (error) {
    await writeFile(
      join(artifacts, "results.json"),
      JSON.stringify(
        { revision: product.revision, metrics, errors, error: String(error) },
        null,
        2,
      ),
    );
    console.error(`Render parity artifacts: ${artifacts}`);
    throw error;
  } finally {
    await browser.close();
    await web.close();
    await background.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
