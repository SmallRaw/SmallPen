// INPUT:  real local Package, nested component links, native renderer
// OUTPUT: offline review coverage, shared-solve and safe-output regressions
// POS:    HTML export integration tests through the real package/render paths
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultTokenWorkspace } from "@smallpen/core";
import { openPackage } from "@smallpen/local-package";
import { exportHtmlReview, htmlReviewTargets } from "../packages/local-package/src/html-review.mjs";
import { componentLookup, localWireframe, resolveDesignLayout, selectedDesign } from "../apps/cli/bin/design-output.mjs";
import { inspectionReport, inspectionText } from "../apps/cli/bin/inspection-output.mjs";
import { pageHtml, seedLegacyIds, writePackage } from "./helpers/named.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const fixture = new URL("fixtures/roundtrip.smallpen", import.meta.url).pathname;

// Three nested components and a two-page module, written as files the way
// an agent writes them. The link sits on a label three copies deep.
const COMPONENTS = `  <sp-component name="Action">
    <div class="flex flex-row p-[8px] w-[120px] h-[44px]">
      <p data-name="Label" class="text-[14px]">Open</p>
    </div>
  </sp-component>
  <sp-component name="Panel">
    <div class="flex flex-col p-[16px] w-fit h-fit">
      <sp-use component="Action" data-name="Action"></sp-use>
    </div>
  </sp-component>
  <sp-component name="Shell">
    <div class="flex flex-col p-[20px] w-fit h-fit">
      <sp-use component="Panel" data-name="Panel"></sp-use>
    </div>
  </sp-component>
`;
const startPage = ({ width, flow = false, hidden = false, link = true }) => pageHtml(`<body${flow ? ' data-flow="Review"' : ""} class="w-[${width}px] h-[500px] bg-[#ffffff]">
  <sp-use component="Shell" data-name="Shell" class="left-[0px] top-[0px]${hidden ? " hidden" : ""}">
    <sp-use data-name="Panel">
      <sp-use data-name="Action">
        <p data-name="Label"${link ? ' data-click="Review/End"' : ""}></p>
      </sp-use>
    </sp-use>
  </sp-use>
</body>`, { title: "Start", depth: 2 });
const END_PAGE = pageHtml(`<body class="w-[361px] h-[500px] bg-[#ffffff]">
  <p data-name="Back" data-click="back" class="left-[0px] top-[0px]">Back</p>
  <div data-name="Sheet" class="left-[0px] top-[40px] w-[150px] h-[100px]">
    <p data-name="Title" class="left-[0px] top-[0px]">A sheet</p>
  </div>
</body>`, { title: "End", depth: 2 });

async function reviewPackage() {
  const root = await mkdtemp(join(tmpdir(), "smallpen-html-review-"));
  const path = join(root, "design.smallpen");
  await cp(fixture, path, { recursive: true });
  await seedLegacyIds(path, "roundtrip");
  await writePackage(path, {
    "tokens.css": ':root {\n  --color-surface: #ffffff;\n}\n\n:root[data-theme="default"] {\n  --color-surface: #ffffff;\n}\n\n:root[data-theme="dark"] {\n  --color-surface: #111827;\n}\n',
    "components/review.html": COMPONENTS,
    "pages/Review/Start.mobile.html": startPage({ width: 361, flow: true }),
    // End has no desktop version, so only the mobile Start links to it.
    "pages/Review/Start.html": startPage({ width: 900, link: false }),
    "pages/Review/End.mobile.html": END_PAGE,
  }, { keepIndex: true });
  const product = await openPackage(path);
  return { root, path, product };
}
let built;
const sharedPackage = () => built ??= reviewPackage();
async function cli(args, expected = 0) {
  const child = spawn(process.execPath, [new URL("../apps/cli/bin/smallpen.mjs", import.meta.url).pathname, ...args, "--json"]);
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => stdout += chunk);
  child.stderr.on("data", chunk => stderr += chunk);
  const code = await new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  assert.equal(code, expected, stdout || stderr);
  return JSON.parse(stdout);
}

function renderer(workspace, snapshots = []) {
  return async target => {
    const design = await resolveDesignLayout(workspace,
      selectedDesign(workspace, { screenId: target.screenId, presentationId: target.presentationId }),
      { raster: true, forExport: true });
    snapshots.push(design.layoutSnapshot);
    const report = inspectionReport(workspace, design, { components: componentLookup(workspace), full: true });
    return { projection: design.projection, snapshot: design.layoutSnapshot, render: design.render,
      tree: design.tree, selection: design.selection, evidence: report,
      specification: inspectionText(report), wireframe: localWireframe(design) };
  };
}

test("real native HTML export covers every page version and deep INSTANCE links without changing the Package", async () => {
  const { root, path, product } = await sharedPackage();
  const workspace = defaultTokenWorkspace({ product });
  const snapshots = [], output = join(root, "review");
  const result = await exportHtmlReview(workspace, { canvas: "Pages", output }, renderer(workspace, snapshots));
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  assert.equal(result.coverage.versionCount, product.manifest.entries.screens.reduce((sum, entry) => sum + product.entries[entry].presentations.length, 0));
  assert.equal(result.coverage.combinations, 1);
  assert.equal(manifest.defaultPage, manifest.pages.find(page => page.default)?.id);
  assert.ok(manifest.defaultPage, "the review opens on the default page");
  assert.ok(!/node_|"screenId"|"presentationId"|"nodeId"/.test(JSON.stringify(manifest)), "the manifest names elements and pages, not ids");
  assert.equal(result.coverage.resolvedLinks, 2);
  assert.deepEqual(manifest.starts.map(start => [start.name, start.status]), [["Review", "resolved"]]);
  assert.equal(manifest.unresolved.filter(issue => issue.reason === "unsupported_action").length, 0);
  const start = manifest.pages.find(page => page.name === "Review / Start" && page.platform === "mobile");
  const link = start.links[0];
  assert.ok(link.element.includes(" › "), "source is deep inside a component instance");
  assert.equal(link.status, "resolved");
  const evidence = JSON.parse(await readFile(join(output, start.artifacts.evidence), "utf8"));
  const nativeLink = evidence.prototype.links.find(item => item.name === link.name);
  assert.ok(nativeLink.nodeId.includes("__"));
  const measured = evidence.layout.nodes[nativeLink.nodeId].bounds;
  assert.equal(link.region.x, (measured.x - evidence.layout.viewport.x) / evidence.layout.viewport.width * start.width);
  assert.equal(evidence.snapshotId, start.layoutHash);
  assert.equal(evidence.revision, product.revision);
  assert.match(await readFile(join(output, start.artifacts.spec), "utf8"), new RegExp(start.layoutHash));
  assert.match(await readFile(join(output, start.artifacts.wireframe), "utf8"), new RegExp(start.layoutHash));
  for (const file of manifest.files) assert.equal(sha256(await readFile(join(output, file.path))), file.sha256, file.path);
  assert.equal(sha256(await readFile(join(output, start.artifacts.image))), start.renderHash);
  const html = await readFile(result.indexPath, "utf8"), script = await readFile(join(output, "review.js"), "utf8");
  assert.ok(html.includes('type="application/json"'));
  assert.ok(!/fetch\(|XMLHttpRequest|https?:\/\//.test(script), "viewer works from file without a server");
  assert.equal((await openPackage(path)).revision, product.revision);
  assert.equal(snapshots.length, result.coverage.versionCount, "one solve per exported version");
});

test("a page exports all its versions; multiple canvases require an explicit selection", async () => {
  const { product } = await sharedPackage();
  assert.equal(htmlReviewTargets(product, { page: "Start" }).targets.length, 2);
  assert.equal(htmlReviewTargets(product, { page: "Start", platform: "mobile" }).targets.length, 1);
  const split = structuredClone(product);
  const screens = split.manifest.entries.screens.map(entry => split.entries[entry].id);
  split.manifest.canvases = [{ id: "cnv_other", name: "Other", screens: [screens[0]] }];
  assert.throws(() => htmlReviewTargets(split), error => error.code === "ambiguous_review_canvas");
  assert.equal(htmlReviewTargets(split, { canvas: "Other" }).targets.length, split.entries[split.manifest.entries.screens[0]].presentations.length);
  assert.throws(() => htmlReviewTargets(split, { canvas: "Missing" }), error => error.code === "unknown_canvas");
});

test("inside-package, aliased and nonempty output directories are rejected without replacing files", async () => {
  const { root, path, product } = await sharedPackage();
  const workspace = defaultTokenWorkspace({ product });
  const never = () => assert.fail("invalid output must fail before rendering");
  await assert.rejects(exportHtmlReview(workspace, { output: join(path, "review") }, never), error => error.code === "review_output_inside_package");
  await assert.rejects(exportHtmlReview(workspace, { output: join(path, "..review") }, never), error => error.code === "review_output_inside_package");
  const alias = join(root, "alias"); await symlink(path, alias, "dir");
  await assert.rejects(exportHtmlReview(workspace, { output: join(alias, "review") }, never), error => error.code === "review_output_inside_package");
  const output = join(root, "existing"); await cp(path, output, { recursive: true });
  const before = await readFile(join(output, "index.html"));
  await assert.rejects(exportHtmlReview(workspace, { output }, never), error => error.code === "review_output_exists");
  assert.deepEqual(await readFile(join(output, "index.html")), before);
});

test("a failed native render leaves no index, and missing geometry never becomes a guessed hotspot", async () => {
  const { root, product } = await sharedPackage();
  const workspace = defaultTokenWorkspace({ product });
  const failed = join(root, "failed");
  await assert.rejects(exportHtmlReview(workspace, { page: "Start", output: failed }, async () => { throw new Error("native render failed"); }), /native render failed/);
  assert.ok(!(await readdir(failed)).includes("index.html"));
  const native = renderer(workspace);
  const result = await exportHtmlReview(workspace, { page: "Start", platform: "mobile", output: join(root, "partial") }, async target => {
    const value = await native(target);
    const source = Object.values(value.projection.nodes).find(node => node.interactions?.length);
    value.snapshot.nodes[source.id] = { status: "partial", bounds: null, reason: "native_bounds_unavailable" };
    return value;
  });
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  assert.equal(manifest.pages[0].links[0].region, undefined);
  assert.equal(manifest.pages[0].links[0].status, "unresolved");
  assert.equal(manifest.coverage.resolvedLinks, 0);
});

test("a native rectangle under a hidden INSTANCE ancestor never creates a clickable hotspot", async () => {
  const { root, path } = await sharedPackage();
  const hiddenPath = join(root, "hidden.smallpen");
  await cp(path, hiddenPath, { recursive: true });
  await writePackage(hiddenPath, { "pages/Review/Start.mobile.html": startPage({ width: 361, flow: true, hidden: true }) }, { keepIndex: true });
  const product = await openPackage(hiddenPath);
  const workspace = defaultTokenWorkspace({ product });
  const result = await exportHtmlReview(workspace, { page: "Start", platform: "mobile", output: join(root, "hidden-review") }, renderer(workspace));
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  const link = manifest.pages[0].links[0];
  const evidence = JSON.parse(await readFile(join(result.output, manifest.pages[0].artifacts.evidence), "utf8"));
  const nativeLink = evidence.prototype.links.find(item => item.name === link.name);
  assert.equal(evidence.layout.nodes[nativeLink.nodeId].visible, false, "semantic visibility includes every ancestor");
  assert.equal(link.region, undefined);
  assert.equal(link.status, "unresolved");
  assert.equal(link.reason, "source_hidden");
  assert.equal(result.coverage.resolvedLinks, 0);
});

test("the public CLI discovers HTML export and renders every selected version with one theme", async () => {
  const { root, path, product } = await sharedPackage();
  const schema = await cli(["schema", "command", "export"]);
  assert.ok(schema.parameters.artifactFormat.values.includes("html"));
  assert.equal(schema.parameters.canvas.option, "--canvas");
  assert.equal((await cli(["export", path, "--format", "html"], 1)).error.code, "missing_review_output");
  const result = await cli(["export", path, "--format", "html", "--canvas", "Pages", "--theme", "theme/default", "--output", join(root, "cli-review")]);
  assert.equal(result.coverage.versionCount, 4);
  assert.equal(result.coverage.combinations, 1);
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  assert.ok(manifest.pages.every(page => page.selection.themes.includes("theme/default")));
  const single = await cli(["export", path, "--format", "html", "--page", "Review / Start", "--output", join(root, "cli-page")]);
  assert.equal(single.coverage.versionCount, 2, "page export never silently picks its main version");
  assert.equal(single.coverage.resolvedLinks, 0, "the destination is outside this explicit page scope");
  assert.equal((await cli(["export", path, "--format", "html", "--canvas", "Pages", "--output", result.output], 1)).error.code, "review_output_exists");
  assert.equal((await cli(["export", path, "--format", "png", "--canvas", "Pages"], 1)).error.code, "unsupported_canvas_export_format");
  assert.equal((await openPackage(path)).revision, product.revision);
});

test("a source revision changed during native rendering cannot publish an index", async () => {
  const { root, path } = await sharedPackage();
  const changedPath = join(root, "changing.smallpen"), output = join(root, "stale-review");
  await cp(path, changedPath, { recursive: true });
  const product = await openPackage(changedPath), workspace = defaultTokenWorkspace({ product });
  const native = renderer(workspace);
  await assert.rejects(exportHtmlReview(workspace, { page: "Start", platform: "mobile", output }, async target => {
    const result = await native(target);
    await writePackage(changedPath, { "pages/New state.html": pageHtml('<body><p data-name="Title">Changed</p></body>') }, { keepIndex: true });
    return result;
  }), error => error.code === "stale_review_export");
  assert.ok(!(await readdir(output)).includes("index.html"));
});
