import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("short npm entry delegates arguments and exit status through the scoped launcher", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-npm-entry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wrapper = new URL("../apps/npm-cli/", import.meta.url);
  const implementation = new URL("../apps/cli/", import.meta.url);
  const installed = join(root, "node_modules/smallpen");
  const scoped = join(installed, "node_modules/@smallpen/cli");
  await cp(wrapper, installed, { recursive: true });
  await mkdir(join(scoped, "bin"), { recursive: true });
  await cp(new URL("package.json", implementation), join(scoped, "package.json"));
  await cp(new URL("bin/smallpen-check.cjs", implementation), join(scoped, "bin/smallpen-check.cjs"));
  // Replace only the command implementation, leaving both real launchers and
  // the actual package exports in the isolated installation layout.
  await writeFile(join(scoped, "bin/smallpen.mjs"),
    'console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 7;');
  const result = spawnSync(process.execPath, [join(installed, "bin/smallpen.cjs"), "--help", "a path with spaces"], { encoding: "utf8" });
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["--help", "a path with spaces"]);
});

test("public wrapper pins the scoped CLI version and owns the short command", async () => {
  const wrapper = JSON.parse(await readFile(new URL("../apps/npm-cli/package.json", import.meta.url), "utf8"));
  const implementation = JSON.parse(await readFile(new URL("../apps/cli/package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.equal(wrapper.name, "smallpen");
  assert.equal(implementation.name, "@smallpen/cli");
  assert.equal(wrapper.dependencies[implementation.name], implementation.version);
  assert.equal(wrapper.bin.smallpen, "./bin/smallpen.cjs");
  assert.equal(lock.packages["node_modules/smallpen"].resolved, "apps/npm-cli");
  assert.equal(lock.packages["node_modules/@smallpen/cli"].resolved, "apps/cli");
});
