import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openPackage } from "@smallpen/local-package";

const cli = new URL("../apps/cli/bin/smallpen.mjs", import.meta.url).pathname;
async function run(args, expected = 0) {
  const child = spawn(process.execPath, [cli, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, expected, stdout || stderr);
  return JSON.parse(stdout);
}
async function packageBytes(path) {
  const files = (await readdir(path, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
  return Object.fromEntries(await Promise.all(files.map(async (entry) => {
    const at = join(entry.parentPath, entry.name);
    return [at, (await readFile(at)).toString("base64")];
  })));
}
async function example(context) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-composition-preview-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = (await run(["project", "init", join(root, "demo"), "--json"])).packagePath;
  const intent = join(root, "page.json");
  await writeFile(intent, JSON.stringify({
    page: "Candidate", width: 480, height: 240, layout: "column", padding: 24, gap: 12, fill: "#ffffff",
    children: [{ name: "Heading", text: "Preview before saving", fontSize: 24 },
      { name: "Actions", width: "fill", layout: "row", gap: 8, children: [
        { name: "Save", use: "Button", text: { Label: "Save draft" } },
        { name: "Hint", text: "Nothing has been saved", width: "fill" },
      ] }],
  }));
  const component = join(root, "button.json");
  await writeFile(component, JSON.stringify({ name: "Button", base: {
    layout: "row", padding: [8, 16], fill: "#2563eb", radius: 8,
    children: [{ name: "Label", text: "Save", color: "#ffffff" }],
  } }));
  await run(["component", "define", path, "--intent", component, "--json"]);
  return { root, path, intent };
}

test("a composition preview renders without writes and its exact batch produces the same saved image", async (context) => {
  const { root, path, intent } = await example(context);
  const before = await packageBytes(path);
  const baseRevision = (await openPackage(path)).revision;
  let savedPreview;
  for (const flags of [[], ["--dry-run"], ["--explain", "--diff"]]) {
    const reply = await run(["page", "draw", path, "--intent", intent, "--preview", "--batch-id", "candidate-preview", ...flags, "--json"]);
    assert.equal(reply.dryRun, true);
    assert.equal(reply.preview.baseRevision, baseRevision);
    assert.equal(reply.preview.candidateRevision, reply.revision);
    assert.equal(reply.preview.layout.status, "resolved");
    assert.deepEqual(await packageBytes(path), before);
    const image = await readFile(reply.preview.imagePath);
    assert.equal(image.readUInt32BE(16), 480);
    assert.equal(image.readUInt32BE(20), 240);
    assert.match(await readFile(reply.preview.specPath, "utf8"), /Preview before saving/);
    const batch = JSON.parse(await readFile(reply.preview.batchPath, "utf8"));
    assert.equal(batch.baseRevision, baseRevision);
    assert.equal(batch.batchId, "candidate-preview");
    if (flags.length) continue;
    savedPreview = reply.preview;
  }
  const preview = savedPreview;
  await run(preview.apply.argv);
  assert.equal((await openPackage(path)).revision, preview.candidateRevision);
  const saved = await run(["export", path, "--page", "Candidate", "--format", "png", "--evidence", "--output", join(root, "saved"), "--json"]);
  assert.equal(saved.layout.hash, preview.layout.hash);
  assert.equal(saved.renderHash, preview.renderHash);
  assert.deepEqual(await readFile(saved.imagePath), await readFile(preview.imagePath));
  const again = await run(["page", "draw", path, "--intent", intent, "--preview", "--batch-id", "candidate-preview", "--json"]);
  assert.equal(again.dryRun, true, "a used batch ID cannot replay an old write receipt instead of rendering");
  assert.ok(again.preview.imagePath);
});

test("an intervening edit rejects the preview batch and keeps the new work", async (context) => {
  const { path, intent } = await example(context);
  const reply = await run(["page", "draw", path, "--intent", intent, "--preview", "--json"]);
  await run(["component", "set", path, "--component", "Button", "--set", "radius=12", "--json"]);
  const before = await packageBytes(path);
  const refused = await run(reply.preview.apply.argv, 1);
  assert.equal(refused.error.code, "stale_revision");
  assert.equal(refused.error.writeState, "not-applied");
  assert.deepEqual(await packageBytes(path), before);
});

test("preview theme selection and render failures leave the package unchanged", async (context) => {
  const { root, path, intent } = await example(context);
  await run(["token", "theme", "add", path, "--theme", "Mode/Light", "--theme", "Mode/Dark", "--json"]);
  const tokens = join(root, "tokens.json");
  await writeFile(tokens, JSON.stringify({ tokens: [{ name: "color.canvas", type: "color", group: "Mode", value: "#ffffff", values: { "Mode/Dark": "#111827" } }] }));
  await run(["token", "set", path, "--intent", tokens, "--json"]);
  const tree = JSON.parse(await readFile(intent, "utf8"));
  tree.fill = "{color.canvas}";
  await writeFile(intent, JSON.stringify(tree));
  const before = await packageBytes(path);
  const reply = await run(["page", "draw", path, "--intent", intent, "--preview", "--theme", "Mode/Dark", "--scale", "0.5", "--json"]);
  assert.ok(reply.preview.selection.themes.includes("Mode/Dark"));
  assert.equal(reply.preview.width, 240);
  assert.deepEqual(await packageBytes(path), before);
  const missingPreview = await run(["page", "draw", path, "--intent", intent, "--theme", "Mode/Dark", "--json"], 1);
  assert.equal(missingPreview.error.code, "preview_required");
  tree.width = 9000;
  await writeFile(intent, JSON.stringify(tree));
  const failed = await run(["page", "draw", path, "--intent", intent, "--preview", "--json"], 1);
  assert.equal(failed.error.code, "render_size_exceeded");
  assert.equal(failed.error.writeState, "not-applied");
  assert.deepEqual(await packageBytes(path), before);
});

test("a composition retains shared dimension rules while selected copies use literal, hug or fill sizing", async (context) => {
  const { root, path, intent } = await example(context);
  const tokens = join(root, "sizes.json");
  const dimensions = async (height, width) => {
    await writeFile(tokens, JSON.stringify({ tokens: [
      { name: "size.control", type: "sizing", value: height },
      { name: "size.controlWidth", type: "sizing", value: width },
    ] }));
    await run(["token", "set", path, "--intent", tokens, "--json"]);
  };
  await dimensions(40, 160);
  const component = join(root, "button.json");
  await writeFile(component, JSON.stringify({ name: "Button", base: {
    layout: "row", width: "{size.controlWidth}", height: "{size.control}", padding: 8,
    children: [{ name: "Label", text: "Save", width: "hug", fontSize: 14 }],
  } }));
  await run(["component", "define", path, "--intent", component, "--json"]);
  await writeFile(intent, JSON.stringify({ page: "Sizes", width: 480, height: 300, layout: "column", padding: 24, gap: 8,
    children: [
      { name: "Shared", use: "Button", width: "{size.controlWidth}", height: "{size.control}" },
      { name: "Literal", use: "Button", width: 120, height: 32 },
      { name: "Hug", use: "Button", width: "hug", height: "hug" },
      { name: "Fill", use: "Button", width: "fill", height: "{size.control}" },
    ],
  }));
  for (const [height, width] of [[40, 160], [48, 200]]) {
    if (height !== 40) await dimensions(height, width);
    const before = await packageBytes(path);
    const reply = await run(["page", "draw", path, "--intent", intent, "--preview", "--json"]);
    const evidence = JSON.parse(await readFile(reply.preview.evidencePath, "utf8"));
    const bounds = name => evidence.nodes.find(node => node.name === name).geometry.bounds;
    assert.equal(bounds("Shared").height, height, "the composition carries the shared control-height constraint");
    assert.equal(bounds("Shared").width, width);
    assert.equal(bounds("Literal").height, 32);
    assert.equal(bounds("Literal").width, 120);
    assert.ok(bounds("Hug").height < 40 && bounds("Hug").width < 160);
    assert.equal(bounds("Fill").width, 432);
    assert.equal(bounds("Fill").height, height);
    assert.deepEqual(await packageBytes(path), before);
  }
});
