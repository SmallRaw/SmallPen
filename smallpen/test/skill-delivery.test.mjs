import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const root = new URL("../", import.meta.url).pathname;
const cli = join(root, "apps/cli/bin/smallpen.mjs");

test("CLI discovery returns a readable independent Skill for either design workflow", async () => {
  for (const flags of [[], ["--full"]]) {
    const { stdout } = await exec(process.execPath, [cli, "help", "skills", "--json", ...flags]);
    const discovery = JSON.parse(stdout);
    assert.equal(discovery.skills.length, 1);
    const skill = discovery.skills[0];
    assert.equal(skill.name, "smallpen-ui-design");
    const content = await readFile(skill.path, "utf8");
    assert.match(content, /^---\nname: smallpen-ui-design\n/);
    const version = JSON.parse(await readFile(join(root, "apps/cli/package.json"))).version;
    assert.ok(content.includes(`cli-version: "${version}"`));
    assert.equal(dirname(skill.path), skill.directory);
  }
});

test("the npm CLI contains the same generated Skill as the independently installable directory", async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), "smallpen-skill-delivery-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  await exec(process.execPath, [join(root, "scripts/build-skills.mjs")]);
  const { stdout } = await exec("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], {
    cwd: join(root, "apps/cli"),
  });
  const [packed] = JSON.parse(stdout);
  assert.ok(packed.files.some(({ path }) => path === "skills/smallpen-ui-design/SKILL.md"));
  const { stdout: included } = await exec("tar", ["-xOf", join(temporary, packed.filename), "package/skills/smallpen-ui-design/SKILL.md"]);
  assert.equal(included, await readFile(join(root, "skills/smallpen-ui-design/SKILL.md"), "utf8"));
});
