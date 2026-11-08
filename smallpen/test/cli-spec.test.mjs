import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openPackage } from "@smallpen/local-package";
import { seedLegacyIds } from "./helpers/named.mjs";

const cli = new URL("../apps/cli/bin/smallpen.mjs", import.meta.url).pathname;
const fixture = new URL("fixtures/variant-acme.smallpen", import.meta.url)
  .pathname;
async function run(argv, code = 0) {
  // Schema and full-value checks opt into stdout; fixed-file transport is tested separately.
  if (
    (argv[0] === "schema" || argv.includes("--full")) &&
    !argv.includes("--stdout")
  )
    argv = [...argv, "--stdout"];
  const child = spawn(process.execPath, [cli, ...argv, "--json"]);
  let out = "",
    err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  assert.equal(
    await new Promise((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    }),
    code,
    out || err,
  );
  return JSON.parse(out);
}
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "smallpen-spec-"));
  const path = join(root, "acme.smallpen");
  await cp(fixture, path, { recursive: true });
  await seedLegacyIds(path, "variant-acme");
  return { root, path };
}
// check --render's rendering report.
const renderOf = async ([path, ...rest]) => (await run(["check", path, "--render", ...rest])).render;
// Stored data, read directly; CLI reads only show names.
async function stored(path) {
  const { revision, manifest, entries, runtime } = await openPackage(path);
  return structuredClone({ revision, manifest, entries, runtime });
}

test("component validation covers every variant unless one is named and paginates results without reducing coverage", async () => {
  const { path } = await workspace();
  const before = await stored(path);
  // The plain reply counts coverage and carries no ids.
  const brief = await renderOf([
    path,
    "--component",
    "Chip",
    "--limit",
    "1",
  ]);
  assert.equal(brief.coverage.targetCount, 2);
  assert.ok(brief.issues.length <= 1);
  assert.ok(brief.coverage.targets.every((t) => t.variantId === undefined));
  // --full keeps the stored ids that show which variants were covered.
  const all = await renderOf([
    path,
    "--component",
    "Chip",
    "--limit",
    "1",
    "--full",
  ]);
  assert.deepEqual(
    all.coverage.targets.map((t) => t.variantId),
    ["var_chip_neutral", "var_chip_brand"],
  );
  assert.equal(all.coverage.targetCount, 2);
  assert.ok(all.issues.length <= 1);
  assert.ok(all.issues.every((i) => i.target.componentId === "cmp_chip"));
  const oneBrief = await renderOf([
    path,
    "--component",
    "Chip",
    "--variant",
    "Tone=brand",
  ]);
  assert.equal(oneBrief.coverage.targetCount, 1);
  const one = await renderOf([
    path,
    "--component",
    "Chip",
    "--variant",
    "Tone=brand",
    "--full",
  ]);
  assert.equal(one.selection.variantId, "var_chip_brand");
  assert.deepEqual(
    one.coverage.targets.map((t) => t.variantId),
    ["var_chip_brand"],
  );
  assert.deepEqual(await stored(path), before);
});

test("whole-page text wireframes preserve line endings and export the decoded text", async () => {
  const { root, path } = await workspace();
  const before = await stored(path);
  const view = await run([
    "view",
    path,
    "--page",
    "Home",
    "--as",
    "wireframe",
  ]);
  assert.equal(view.textLayout.lineEnding, "LF");
  assert.equal(view.textLayout.monospace, true);
  assert.equal(view.lineCount, view.text.split("\n").length);
  assert.ok(view.lineCount > 1);
  const output = join(root, "wireframe.txt");
  await run([
    "export",
    path,
    "--page",
    "Home",
    "--format",
    "wireframe",
    "--output",
    output,
  ]);
  assert.ok((await readFile(output, "utf8")).endsWith(`${view.text}\n`));
  assert.deepEqual(await stored(path), before);
});

test("default exports remain text wireframes even with full output; PNG is explicitly requested", async () => {
  const { root, path } = await workspace();
  const before = await stored(path);
  const view = await run([
    "view",
    path,
    "--page",
    "Home",
    "--as",
    "wireframe",
  ]);
  for (const extra of [[], ["--full"]]) {
    const exported = await run(["export", path, "--page", "Home", ...extra]);
    assert.equal(exported.mimeType, "text/plain");
    assert.ok(
      (await readFile(exported.output, "utf8")).endsWith(`${view.text}\n`),
    );
    assert.equal(exported.base64, undefined);
  }
  const png = await run([
    "export",
    path,
    "--page",
    "Home",
    "--format",
    "png",
    "--output",
    join(root, "explicit.png"),
  ]);
  assert.equal(png.mimeType, "image/png");
  assert.equal((await readFile(png.output)).subarray(1, 4).toString(), "PNG");
  assert.equal(png.base64, undefined);
  assert.deepEqual(await stored(path), before);
});

test("a page checks every version and an element check stays inside that element", async () => {
  const { root, path } = await workspace();
  const mobile = join(path, "pages", "Home.mobile.html");
  const source = await readFile(mobile, "utf8");
  await writeFile(
    mobile,
    source.replace(
      "</body>",
      '  <div data-name="Other region" class="left-[12px] top-[500px] w-[100px] h-[100px]"></div>\n</body>',
    ),
  );
  await writeFile(join(path, "pages", "Home.tablet.html"), source);
  const before = await stored(path);
  const brief = (await run(["check", path, "--render", "--page", "Home"])).render;
  assert.equal(brief.coverage.targetCount, 2, "both versions are checked");
  const report = (await run(["check", path, "--render", "--page", "Home", "--full"])).render;
  assert.equal(new Set(report.coverage.targets.map((t) => t.presentationId)).size, 2);
  const view = await run(["view", path, "--page", "Home", "--platform", "tablet", "--full"]);
  assert.equal(view.selection.platform ?? "tablet", "tablet");
  const local = (await run(["check", path, "--render", "--page", "Home", "--element", "Button one", "--full"])).render;
  assert.ok(local.selection.nodeId);
  assert.ok(!JSON.stringify(local.issues).includes("Other region"));
  const png = await run([
    "export",
    path,
    "--page",
    "Home",
    "--element",
    "Button one",
    "--output",
    join(root, "local.png"),
    "--format",
    "png",
  ]);
  // Diagnostics name elements; the unrelated region is never among them.
  assert.ok(!png.diagnostics.some((issue) => /Other region/.test(JSON.stringify(issue))));
  assert.deepEqual(await stored(path), before);
});

