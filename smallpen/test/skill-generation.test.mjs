import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const script = new URL("../scripts/build-skills.mjs", import.meta.url).pathname;
async function run(args, code = 0) {
  let result;
  try {
    result = {
      code: 0,
      ...(await promisify(execFile)(process.execPath, [script, ...args])),
    };
  } catch (error) {
    result = error;
  }
  assert.equal(result.code, code, result.stdout || result.stderr);
}

test("Skill generation is deterministic, independent and detects stale output without rewriting it", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-skill-build-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const first = join(parent, "first");
  const second = join(parent, "second");
  await run(["--output", first]);
  await run(["--output", second]);
  assert.deepEqual(await readdir(first), ["smallpen-ui-design"]);
  const path = join(first, "smallpen-ui-design", "SKILL.md");
  const content = await readFile(path, "utf8");
  assert.equal(
    content,
    await readFile(join(second, "smallpen-ui-design", "SKILL.md"), "utf8"),
  );
  await run(["--output", first, "--check"]);
  await writeFile(path, `${content}\nlocal change\n`);
  await run(["--output", first, "--check"], 1);
  assert.equal(await readFile(path, "utf8"), `${content}\nlocal change\n`);
  await run(["--output", first]);
  assert.equal(await readFile(path, "utf8"), content);
  await run(["--output", join(parent, "missing"), "--check"], 1);
  assert.deepEqual((await readdir(parent)).sort(), ["first", "second"]);
});
