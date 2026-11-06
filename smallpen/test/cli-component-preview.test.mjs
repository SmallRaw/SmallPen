import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { openPackage } from "@smallpen/local-package";
import { PNG } from "pngjs";

const cli = new URL("../apps/cli/bin/smallpen.mjs", import.meta.url).pathname;
const execute = promisify(execFile);
async function run(args, expected = 0) {
  let result;
  try { result = { code: 0, ...await execute(process.execPath, [cli, ...args]) }; }
  catch (error) { result = error; }
  assert.equal(result.code, expected, result.stdout || result.stderr);
  return JSON.parse(result.stdout);
}
async function designed(t) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-component-preview-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "project.smallpen");
  await run(["project", "init", path, "--json"]);
  const intent = join(root, "button.json");
  await writeFile(intent, JSON.stringify({
    name: "Button", properties: { Style: ["primary", "secondary"], Size: ["md", "sm"] },
    base: { name: "ButtonRoot", layout: "row", padding: [8, 16], fill: "#2563eb", children: [{ name: "Label", text: "Go", color: "#ffffff" }] },
    variants: [
      { when: { Style: "secondary" }, set: { fill: "#e5e7eb", "Label.color": "#111827" } },
      { when: { Size: "sm" }, set: { padding: [4, 8] } },
    ],
  }));
  await run(["component", "define", path, "--intent", intent, "--json"]);
  return { root, path };
}

test("a representative preview says what it omitted and gives a runnable full-variant query", async (t) => {
  const { root, path } = await designed(t);
  const output = join(root, "catalog.png");
  const before = (await openPackage(path)).entries;
  const catalog = await run(["view", path, "--components", "--as", "png", "--locale", "zh_cn", "--scale", "1", "--output", output, "--json"]);
  const coverage = catalog.preview.components.find(({ component }) => component === "Button");
  assert.equal(coverage.shownVariants, 3);
  assert.equal(coverage.totalVariants, 4);
  assert.equal(coverage.omittedVariants.length, 1);
  const operation = catalog.nextOperations.find(({ argv }) => argv.includes("--component"));
  assert.ok(operation, "missing variants are available in one suggested query");
  assert.ok(!operation.argv.includes("--output"), "the suggested query must not overwrite the catalog");
  assert.equal(operation.argv[operation.argv.indexOf("--locale") + 1], "zh_cn");
  const catalogBytes = await readFile(output);
  const complete = await run(operation.argv);
  assert.equal(complete.preview.components[0].shownVariants, 4);
  assert.deepEqual(complete.preview.components[0].omittedVariants, []);
  assert.deepEqual(await readFile(output), catalogBytes);
  assert.deepEqual((await openPackage(path)).entries, before, "previewing leaves the native package unchanged");
});

test("view and export show the same complete component for PNG and wireframe", async (t) => {
  const { root, path } = await designed(t);
  const before = (await openPackage(path)).revision;
  for (const format of ["png", "wireframe"]) {
    const viewed = await run(["view", path, "--component", "Button", "--as", format, "--locale", "zh_cn", "--json"]);
    const exported = await run(["export", path, "--component", "Button", "--format", format, "--locale", "zh_cn", "--output", join(root, `button.${format === "png" ? "png" : "txt"}`), "--json"]);
    assert.deepEqual(exported.preview, viewed.preview);
    assert.equal(exported.preview.components[0].shownVariants, 4);
    assert.equal(exported.layout.hash, viewed.layout.hash);
    if (format === "png") {
      assert.deepEqual([exported.width, exported.height], [viewed.width, viewed.height]);
      assert.deepEqual(await readFile(exported.output), await readFile(viewed.output));
    } else assert.ok((await readFile(exported.output, "utf8")).includes(viewed.wireframe));
  }
  assert.equal((await openPackage(path)).revision, before);
});

test("whole-component evidence labels its preview scope and explicit variants keep definition evidence", async (t) => {
  const { root, path } = await designed(t);
  const whole = await run(["export", path, "--component", "Button", "--format", "png", "--evidence", "--output", join(root, "all"), "--json"]);
  const evidence = JSON.parse(await readFile(whole.evidencePath, "utf8"));
  assert.equal(evidence.preview.components[0].shownVariants, 4);
  assert.equal(evidence.renderHash, whole.renderHash);
  assert.equal(evidence.snapshot.hash, whole.layout.hash);
  const one = await run(["export", path, "--component", "Button", "--variant", "Style=secondary, Size=sm", "--format", "png", "--evidence", "--output", join(root, "one"), "--json"]);
  const definition = JSON.parse(await readFile(one.evidencePath, "utf8"));
  assert.equal(one.preview, undefined);
  assert.equal(definition.nodes[0].source.role, "definition");
  assert.equal(definition.nodes[0].source.name, "Button");
  const viewed = await run(["view", path, "--component", "Button", "--variant", "Style=secondary, Size=sm", "--as", "png", "--json"]);
  assert.equal(one.layout.hash, viewed.layout.hash);
});

test("single-variant definition exports and invalid target rejection remain unchanged", async (t) => {
  const { root, path } = await designed(t);
  const intent = join(root, "tag.json");
  await writeFile(intent, JSON.stringify({ name: "Tag", base: { layout: "row", padding: 8, children: [{ name: "Label", text: "Tag" }] } }));
  await run(["component", "define", path, "--intent", intent, "--json"]);
  const one = await run(["export", path, "--component", "Tag", "--format", "png", "--evidence", "--output", join(root, "tag"), "--json"]);
  const evidence = JSON.parse(await readFile(one.evidencePath, "utf8"));
  assert.equal(evidence.nodes[0].source.role, "definition");
  const bad = await run(["export", path, "--page", "Missing", "--component", "Button", "--format", "png", "--json"], 1);
  assert.equal(bad.error.code, "too_many_view_targets");
});

test("whole component previews include library and unused Foundation definitions", async (t) => {
  const { root, path } = await designed(t);
  const library = join(root, "library.smallpen");
  await run(["project", "init", library, "--json"]);
  const intent = join(root, "library-button.json");
  await writeFile(intent, JSON.stringify({ name: "LibraryButton", properties: { Style: ["primary", "secondary"] }, base: { layout: "row", padding: 8, children: [{ name: "Label", text: "Library Button" }] } }));
  await run(["component", "define", library, "--intent", intent, "--json"]);
  const manifestPath = join(path, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const source = JSON.parse(await readFile(join(library, "manifest.json"), "utf8"));
  manifest.libraries = [{ packageId: source.packageId, source: { type: "local", path: "library.smallpen" } }];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const pair = await run(["project", "init", join(root, "pair"), "--layout", "foundation-product", "--json"]);
  await run(["component", "define", pair.foundationPath, "--intent", intent, "--json"]);
  for (const packagePath of [path, pair.productPath]) {
    const before = (await openPackage(packagePath)).revision;
    for (const [command, formatFlag] of [["view", "--as"], ["export", "--format"]]) {
      const reply = await run([command, packagePath, "--component", "LibraryButton", formatFlag, "png", "--json"]);
      assert.equal(reply.preview.components[0].shownVariants, 2);
      assert.equal(reply.preview.components[0].component, "LibraryButton");
    }
    assert.equal((await openPackage(packagePath)).revision, before);
  }
  const detached = JSON.parse(await readFile(manifestPath, "utf8"));
  delete detached.libraries;
  await writeFile(manifestPath, JSON.stringify(detached));
  await run(["component", "define", path, "--intent", intent, "--json"]);
  const linked = JSON.parse(await readFile(manifestPath, "utf8"));
  linked.libraries = manifest.libraries;
  await writeFile(manifestPath, JSON.stringify(linked));
  for (const name of ["LibraryButton [1]", "LibraryButton [2]"]) {
    const reply = await run(["export", path, "--component", name, "--format", "png", "--json"]);
    assert.equal(reply.preview.components[0].shownVariants, 2);
  }
});

test("whole component images and evidence resolve the requested theme as each definition does", async (t) => {
  const { root, path } = await designed(t);
  await run(["token", "theme", "add", path, "--theme", "Theme/Light", "--theme", "Theme/Dark", "--json"]);
  const tokens = join(root, "theme-tokens.json");
  await writeFile(tokens, JSON.stringify({ tokens: [{ name: "color.brand", type: "color", value: "#ffffff", values: { "Theme/Dark": "#000000" } }] }));
  await run(["token", "set", path, "--intent", tokens, "--json"]);
  const intent = join(root, "themed.json");
  await writeFile(intent, JSON.stringify({ name: "Themed", properties: { Style: ["primary", "secondary"] }, base: { layout: "row", fill: "{color.brand}", padding: 8, children: [{ name: "Label", text: "Themed" }] } }));
  await run(["component", "define", path, "--intent", intent, "--json"]);
  const whole = await run(["export", path, "--component", "Themed", "--theme", "Theme/Dark", "--format", "png", "--evidence", "--output", join(root, "dark"), "--json"]);
  const evidence = JSON.parse(await readFile(whole.evidencePath, "utf8"));
  const fills = evidence.nodes.filter((node) => node.fields?.fill?.token?.path === "color.brand");
  assert.equal(fills.length, 2);
  for (const node of fills) {
    assert.equal(node.fields.fill.value.color, "#000000");
    assert.equal(node.fields.fill.token.value, "#000000");
  }
  const viewed = await run(["view", path, "--component", "Themed", "--theme", "Theme/Dark", "--as", "png", "--json"]);
  assert.equal(whole.renderHash, viewed.renderHash);
});

test("whole component previews resolve named context values consistently", async (t) => {
  const { root, path } = await designed(t);
  const manifestPath = join(path, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await mkdir(join(path, "contexts"), { recursive: true });
  await writeFile(join(path, "contexts/probe.json"), JSON.stringify({
    axes: [{ id: "axis_density", name: "Density", kind: "density", defaultValue: "regular", values: [{ id: "regular", name: "Regular" }, { id: "compact", name: "Dense" }] }], profiles: [],
  }));
  manifest.entries.contexts.push("contexts/probe.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  const whole = await run(["export", path, "--component", "Button", "--context", "Density=Dense", "--format", "png", "--evidence", "--output", join(root, "dense"), "--json"]);
  const evidence = JSON.parse(await readFile(whole.evidencePath, "utf8"));
  assert.equal(evidence.selector.context.axis_density, "compact");
  const viewed = await run(["view", path, "--component", "Button", "--context", "Density=Dense", "--as", "png", "--json"]);
  assert.equal(whole.renderHash, viewed.renderHash);
  assert.equal(viewed.selection.context.axis_density, "compact");
});

test("component sheet PNGs preserve alpha in margins, component gaps and annotation whitespace", async (t) => {
  const { root, path } = await designed(t);
  const intent = join(root, "clear.json");
  await writeFile(intent, JSON.stringify({
    name: "ClearPart", properties: { State: ["on", "off"] },
    base: { name: "ClearRoot", width: 200, height: 40, layout: "row", gap: 40, children: [
      { name: "Blue", width: 40, height: 40, fill: "#2563eb" },
      { name: "White", width: 40, height: 40, fill: "#ffffff" },
    ] },
  }));
  await run(["component", "define", path, "--intent", intent, "--json"]);
  const before = (await openPackage(path)).revision;
  const reply = await run(["export", path, "--component", "ClearPart", "--format", "png", "--evidence", "--locale", "zh_cn", "--output", join(root, "clear"), "--json"]);
  assert.equal(reply.issueCount, 0, "generated annotation labels do not introduce false layout issues");
  const png = PNG.sync.read(await readFile(reply.imagePath));
  assert.ok(png.width < 640, "named component exports do not force a 1040px review canvas");
  const pixel = (x, y) => [...png.data.subarray((Math.floor(y) * png.width + Math.floor(x)) * 4, (Math.floor(y) * png.width + Math.floor(x)) * 4 + 4)];
  assert.equal(pixel(0, 0)[3], 0, "PNG canvas is transparent");
  const evidence = JSON.parse(await readFile(reply.evidencePath, "utf8"));
  function flatten(node) { return [node, ...(node.children ?? []).flatMap(flatten)]; }
  const nodes = flatten(evidence.semanticTree.root);
  const samples = nodes.filter((node) => node.name === "ClearRoot");
  assert.equal(samples.length, 2);
  for (const sample of samples) {
    const { x, y } = sample.bounds;
    assert.deepEqual(pixel(x + 10, y + 20), [37, 99, 235, 255], "authored blue remains opaque");
    assert.equal(pixel(x + 50, y + 20)[3], 0, "component gap has no preview backing");
    assert.deepEqual(pixel(x + 90, y + 20), [255, 255, 255, 255], "authored white is preserved");
  }
  const title = nodes.find((node) => node.name === "ClearPart" && node.type === "TEXT");
  assert.equal(pixel(title.bounds.x - 4, title.bounds.y + 8)[3], 0, "annotation text has no opaque backing");
  const viewed = await run(["view", path, "--component", "ClearPart", "--as", "png", "--locale", "zh_cn", "--json"]);
  assert.deepEqual(await readFile(viewed.output), await readFile(reply.imagePath));
  assert.equal((await openPackage(path)).revision, before);
});

test("compact component headings keep wide-letter names clear of the scope note", async (t) => {
  const { root, path } = await designed(t);
  const name = "WWWWWWWWWWWWWW";
  const intent = join(root, "wide-title.json");
  await writeFile(intent, JSON.stringify({ name, base: { name: "WideRoot", width: 200, height: 80, fill: "#2563eb" } }));
  await run(["component", "define", path, "--intent", intent, "--json"]);
  const reply = await run(["view", path, "--component", name, "--as", "png", "--json"]);
  assert.equal(reply.issueCount, 0, "native text fitting and scope separation survive a narrow heading");
  assert.ok(reply.width < 600, "a long heading wraps instead of restoring the desktop-size canvas");
});
