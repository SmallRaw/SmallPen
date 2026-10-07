import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { openPackage, openWorkspace } from "@smallpen/local-package";

const cli = new URL("../apps/cli/bin/smallpen.mjs", import.meta.url).pathname;
async function run(args, code = 0) {
  let result;
  try {
    result = {
      code: 0,
      ...(await promisify(execFile)(process.execPath, [
        cli,
        ...args,
        "--json",
      ])),
    };
  } catch (error) {
    result = error;
  }
  assert.equal(result.code, code, result.stdout || result.stderr);
  return JSON.parse(result.stdout);
}

test("an AI can discover and create a blank package without a business brief or Skill", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-neutral-init-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const group = await run(["help", "project"]);
  assert.ok(group.actions.some(({ action }) => action === "init"));
  const help = await run(["help", "project", "init"]);
  const schema = await run(
    help.nextOperations[0].argv.filter((arg) => arg !== "--json"),
  );
  assert.ok(schema.parameters.name);
  assert.equal(schema.command, "project init");
  // No interactive brief: question-by-question answers and state files are gone.
  for (const key of ["answer", "state"])
    assert.equal(schema.parameters[key], undefined);
  // A complete legacy brief may still be imported, but nothing requires one.
  assert.equal(schema.parameters.answers?.required ?? false, false);
  if (schema.parameters.answers)
    assert.match(schema.parameters.answers.description, /compatibility/i);
  assert.equal(schema.parameters.confirm?.required ?? false, false);
  assert.ok(
    Object.values(schema.parameters).every(({ required }) => !required),
  );
  const path = join(parent, "素材.smallpen");
  const result = await run(["project", "init", path, "--name", "素材画板"]);
  const snapshot = await openPackage(result.packagePath);
  assert.equal(snapshot.manifest.name, "素材画板");
  assert.equal(snapshot.domain.tokens.size, 0);
  assert.equal(snapshot.domain.componentSets.size, 0);
  assert.equal(snapshot.domain.contextAxes.size, 0);
  assert.equal(snapshot.domain.scenarios.size, 0);
  assert.equal(snapshot.manifest.entries.screens.length, 1);
  assert.equal(
    snapshot.entries[snapshot.manifest.entries.screens[0]].presentations.length,
    1,
  );
  assert.equal(
    snapshot.entries[snapshot.manifest.entries.screens[0]].presentations[0]
      .name,
    "Base",
  );
  assert.equal(
    snapshot.entries[snapshot.manifest.entries.screens[0]].presentations[0]
      .platform,
    undefined,
  );
  assert.equal(result.nextQuestion, undefined);
  assert.equal(result.statePath, undefined);
  assert.deepEqual((await readdir(parent)).sort(), [
    ".素材.smallpen.write-lock",
    "素材.smallpen",
  ]);
  const themes = await run(["theme", "list", path]);
  assert.deepEqual(themes.selection.themes, ["Theme/Default"]);
  const before = await readFile(join(path, "manifest.json"), "utf8");
  const duplicate = await run(["project", "init", path], 1);
  assert.equal(duplicate.error.code, "package_already_exists");
  assert.equal(await readFile(join(path, "manifest.json"), "utf8"), before);
});

test("blank workspace layouts create no starter business content", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-neutral-workspace-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  for (const layout of ["single", "foundation-product"]) {
    const result = await run([
      "project",
      "init",
      join(parent, layout),
      "--layout",
      layout,
    ]);
    const workspace = await openWorkspace(
      result.packagePath ?? result.productPath,
    );
    assert.equal(workspace.product.domain.tokens.size, 0);
    assert.equal(workspace.product.domain.scenarios.size, 0);
    assert.equal(workspace.product.domain.componentSets.size, 0);
    if (layout === "foundation-product") {
      assert.equal(workspace.foundation.domain.tokens.size, 0);
      assert.equal(workspace.foundation.domain.componentSets.size, 0);
      assert.equal(workspace.foundation.manifest.entries.screens.length, 0);
    }
  }
});

test("invalid creation inputs leave no workspace or question state", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-neutral-invalid-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const path = join(parent, "invalid.smallpen");
  await run(["project", "init", path, "--name", "x".repeat(256)], 1);
  await run(
    ["project", "init", path, "--state", join(parent, "state.json")],
    1,
  );
  assert.deepEqual(await readdir(parent), []);
});
