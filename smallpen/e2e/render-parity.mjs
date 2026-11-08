import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { serveLocalPackage } from "@smallpen/background";
import {
  createEvidence,
  openPackage,
  renderAppProjection,
} from "@smallpen/local-package";
import { servePenpotFrontend } from "@smallpen/web";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "..", "frontend", "package.json"));
const { chromium } = require("playwright");
const { PNG } = createRequire(import.meta.url)("pngjs");

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

// One contract scene exercises the shared semantics, rather than a page's
// styling, written as an agent writes a page. The page root is a frame
// without paint that holds both boards at their canvas places: Render
// parity at 0,0 and Precision boundary at x=1950.16, where texts at
// x=2014.16 cross the f32 exponent boundary.
const STROKES = ["inside", "center", "outside"].flatMap((alignment, index) =>
  [0, 12].map((radius) =>
    `    <div data-shape="rectangle" data-name="Stroke ${alignment} ${radius}" class="left-[${24 + index * 160}px] top-[${144 + (radius ? 100 : 0)}px] w-[120px] h-[64px] border-[2px] border-t-0 border-b-[8px] border-[#18181b] border-${alignment}${radius ? " rounded-[12px]" : ""}"></div>`));
const PRECISION_TEXT = "text-[#18181b] font-[Precision_Source_Sans] text-[14px] font-[400] leading-[1.5]";
const SCENE = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Parity</title>
  <link rel="stylesheet" href="../tokens.css">
</head>
<body data-name="Parity scene" class="w-[2400px] h-[600px] bg-none">
  <div data-name="Render parity" class="left-[0px] top-[0px] w-[800px] h-[600px] bg-[#ffffff]">
    <div data-name="Opacity" class="left-[24px] top-[24px] w-[80px] h-[80px] bg-[#18181b] opacity-[0.5]">
      <div data-shape="rectangle" data-name="White mark" class="left-[20px] top-[20px] w-[40px] h-[40px] bg-[#ffffff]"></div>
    </div>
    <div data-name="Nested" class="left-[128px] top-[24px] w-[80px] h-[80px] bg-[#18181b] opacity-[0.5]">
      <div data-shape="rectangle" data-name="Nested red" class="left-[20px] top-[20px] w-[40px] h-[40px] bg-[#ff0000] opacity-[0.5]"></div>
    </div>
    <div data-shape="rectangle" data-name="Alpha hex" class="left-[232px] top-[24px] w-[80px] h-[80px] bg-[#18181b00]"></div>
    <div data-shape="rectangle" data-name="Alpha fill" class="left-[336px] top-[24px] w-[80px] h-[80px] bg-[#ff000080]"></div>
    <div data-shape="rectangle" data-name="Opacity stroke" class="left-[440px] top-[24px] w-[80px] h-[80px] bg-[#18181b] opacity-[0.5] border-[8px] border-[#ffffff]"></div>
${STROKES.join("\n")}
    <div data-name="Fill row" class="flex flex-row items-center p-[12px] left-[24px] top-[360px] w-[400px] h-[100px]">
      <div data-name="Fill control" class="w-full h-[44px] bg-[#ffffff] border border-[#d4d4d8]">
        <div data-shape="rectangle" data-name="Focus outline" class="left-[-4px] top-[-4px] w-[384px] h-[52px] pin-x-stretch pin-y-stretch border-[2px] border-[#71717a]"></div>
      </div>
    </div>
    <div data-shape="rectangle" data-name="Shadow filled" class="left-[540px] top-[380px] w-[80px] h-[40px] bg-[#ffffff] shadow-[0_6px_12px_0_#0000004d]"></div>
    <div data-shape="rectangle" data-name="Shadow negative" class="left-[660px] top-[380px] w-[80px] h-[40px] bg-[#ffffff] shadow-[0_18px_0_-6px_#00000066]"></div>
    <p data-name="Measured text" class="left-[24px] top-[500px] w-[240px] text-[#18181b] text-[16px] font-[400] leading-[1.25]">Measured without a source edit</p>
  </div>
  <div data-name="Precision boundary" class="left-[1950.16px] top-[0px] w-[360px] h-[220px] bg-[#ffffff]">
    <p data-name="Precision fit" class="left-[64px] top-[12px] w-[56px] ${PRECISION_TEXT}">保存配置</p>
    <p data-name="Precision narrow" class="left-[64px] top-[84px] w-[54px] ${PRECISION_TEXT}">保存配置</p>
    <p data-name="CJK across rich text runs" class="left-[64px] top-[156px] w-[54px] ${PRECISION_TEXT}"><span class="text-[#18181b]">保存</span><span class="text-[#18181a]">配置</span></p>
  </div>
</body>
</html>
`;

// Both boards sit in the page's root board; open it in the layers panel
// before selecting one.
async function selectBoard(page, name) {
  const toggle = page
    .getByTestId("layer-row")
    .filter({ hasText: "Parity scene" })
    .first()
    .getByTestId("toggle-content");
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
  await page
    .getByTestId("layer-row")
    .filter({ hasText: name })
    .first()
    .click();
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
  // Embed the same face for all three renderers. Four one-em glyphs fit
  // exactly in 56px.
  const fonts = join(root, "..", "frontend", "resources", "public", "fonts");
  const precisionTtf = precisionFont(
    await readFile(join(fonts, "sourcesanspro-regular.ttf")),
  );
  await mkdir(join(packagePath, "pages"), { recursive: true });
  await mkdir(join(packagePath, "assets", "fonts"), { recursive: true });
  await writeFile(join(packagePath, "assets", "fonts", "precision.ttf"), precisionTtf);
  await writeFile(
    join(packagePath, "index.html"),
    '<!doctype html>\n<html>\n<head>\n  <meta charset="utf-8">\n  <title>Render parity</title>\n  <meta name="smallpen:package-id" content="pkg_render_parity">\n</head>\n<body></body>\n</html>\n',
  );
  await writeFile(
    join(packagePath, "tokens.css"),
    '@font-face {\n  font-family: "Precision Source Sans";\n  src: url(assets/fonts/precision.ttf);\n  font-weight: 400;\n  font-style: normal;\n}\n\n:root {\n}\n',
  );
  await writeFile(join(packagePath, "pages", "Parity.html"), SCENE);
  const product = await openPackage(packagePath);
  const evidence = await createEvidence(product, {
    selector: { viewFormat: "screenshot" },
  });
  const { nodes: projected } = evidence.projection;
  const idOf = (name) => {
    const id = Object.keys(projected).find((key) => projected[key].name === name);
    assert.ok(id, `the scene has ${name}`);
    return id;
  };
  evidence.render = await renderAppProjection(product, {
    ...evidence.projection,
    rootId: idOf("Render parity"),
  });
  // The page states the outline's box, 4px outside the control that fills
  // the row; laying out the page must keep both.
  assert.equal(projected[idOf("Fill control")].width, 376);
  assert.equal(projected[idOf("Focus outline")].width, 384);
  await writeFile(join(artifacts, "cli.png"), evidence.render.bytes);
  const cliPrecision = await renderAppProjection(product, {
    ...evidence.projection,
    rootId: idOf("Precision boundary"),
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
      await selectBoard(page, "Render parity");
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
      await selectBoard(page, "Precision boundary");
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
