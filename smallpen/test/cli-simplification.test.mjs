import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { openPackage } from "@smallpen/local-package";

const cli = new URL("../apps/cli/bin/smallpen.mjs", import.meta.url).pathname;
const execute = promisify(execFile);
async function run(args, expected = 0) {
  let result;
  try {
    result = { code: 0, ...await execute(process.execPath, [cli, ...args]) };
  } catch (error) {
    result = error;
  }
  assert.equal(result.code, expected, result.stdout || result.stderr);
  return JSON.parse(result.stdout);
}
async function example(t) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-simplification-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "project.smallpen");
  await run(["project", "init", path, "--json"]);
  const component = join(root, "action.json");
  await writeFile(component, JSON.stringify({
    name: "Action", properties: { Style: ["solid", "quiet"] },
    base: { layout: "row", padding: 8, children: [{ name: "Label", text: "Save", fontSize: 16 }] },
  }));
  await run(["component", "define", path, "--intent", component, "--json"]);
  return { root, path };
}

test("issue views retain the selected targets and skipped checks instead of implying a complete review", async (t) => {
  const { path } = await example(t);
  const before = (await openPackage(path)).revision;
  for (const selectors of [["--component", "Action"], ["--component", "Action", "--variant", "Style=quiet"]]) {
    const expected = await run(["validate", path, ...selectors, "--json"]);
    const viewed = await run(["view", path, ...selectors, "--as", "issues", "--json"]);
    assert.ok(expected.coverage.skippedCount > 0, "a transparent component has no opaque background for contrast checks");
    assert.deepEqual(viewed.coverage, expected.coverage);
    assert.deepEqual(viewed.selection, expected.selection);
    assert.equal(viewed.revision, expected.revision);
    assert.equal(viewed.issueCount, expected.issueCount);
    assert.equal((await openPackage(path)).revision, before);
  }
});

test("a stale candidate offers read-only recovery before a fresh scoped edit preserves later work", async (t) => {
  const { root, path } = await example(t);
  const intent = join(root, "page.json");
  await writeFile(intent, JSON.stringify({ page: "Board", children: [{ name: "Title", text: "Old draft" }] }));
  const candidate = await run(["page", "draw", path, "--intent", intent, "--preview", "--json"]);
  await run(["page", "draw", path, "--intent", intent, "--json"]);
  await run(["page", "set", path, "--page", "Board", "--element", "Title", "--set", "text=Human edit", "--json"]);
  const before = (await openPackage(path)).revision;
  const { error } = await run(candidate.preview.apply.argv, 1);
  assert.equal(error.code, "stale_revision");
  assert.equal(error.writeState, "not-applied");
  assert.deepEqual(error.details.nextOperations.map(({ argv }) => argv[0]), ["changes", "view"]);
  assert.equal(error.details.nextOperations[0].argv.at(-2), candidate.preview.baseRevision);
  for (const { argv } of error.details.nextOperations) await run(argv);
  assert.equal((await openPackage(path)).revision, before);
  await run(["page", "set", path, "--page", "Board", "--element", "Title", "--set", "fontSize=20", "--json"]);
  const current = await run(["export", path, "--page", "Board", "--format", "spec", "--json"]);
  assert.match(await readFile(current.output, "utf8"), /Human edit/);
});

test("a batch without a base revision offers a current read with no missing argv values", async (t) => {
  const { root, path } = await example(t);
  const file = join(root, "missing-base.json");
  await writeFile(file, JSON.stringify({ batchId: "missing-base", operations: [] }));
  const { error } = await run(["advanced", "apply", path, "--batch", file, "--json"], 1);
  assert.equal(error.code, "stale_revision");
  assert.deepEqual(error.details.nextOperations.map(({ argv }) => argv), [["view", path, "--json"]]);
  await run(error.details.nextOperations[0].argv);
});

test("an element check reports its actual region in both issue view and validation", async (t) => {
  const { path } = await example(t);
  const target = ["--component", "Action", "--variant", "Style=quiet", "--element", "Label"];
  const validated = await run(["validate", path, ...target, "--json"]);
  const viewed = await run(["view", path, ...target, "--as", "issues", "--json"]);
  assert.equal(validated.coverage.targetCount, 1);
  assert.deepEqual(validated.coverage.targets, ["Action (Style=quiet) / Label"]);
  assert.deepEqual(viewed.coverage, validated.coverage);
  assert.ok(validated.issues.every(({ target }) => target.endsWith(" / Label")));
});
