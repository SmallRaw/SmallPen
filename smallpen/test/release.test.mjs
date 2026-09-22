import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const buildScript = join(root, "scripts", "build-cli.mjs");
const fixture = join(root, "test", "fixtures", "roundtrip.smallpen");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    child.stderr.setEncoding("utf8");
    child.stdout.setEncoding("utf8");
    child.stderr.on("data", (value) => (stderr += value));
    child.stdout.on("data", (value) => (stdout += value));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr, stdout }));
  });
}

test("the CLI release is self-contained apart from its documented Node runtime", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-cli-release-"));
  const output = join(parent, "SmallPen-CLI");
  context.after(() => rm(parent, { force: true, recursive: true }));

  const built = await run(process.execPath, [buildScript, "--output", output]);
  assert.equal(built.code, 0, built.stderr || built.stdout);
  await access(join(output, "smallpen"));
  await access(join(output, "smallpen.cmd"));
  await access(join(output, "app", "node_modules", "@smallpen", "core", "src", "index.mjs"));
  await access(
    join(output, "app", "node_modules", "@smallpen", "local-package", "src", "index.mjs"),
  );
  assert.match(await readFile(join(output, "README.txt"), "utf8"), /Node\.js 24/);

  const cli = join(output, "app", "apps", "cli", "bin", "smallpen.mjs");
  const validated = await run(process.execPath, [cli, "validate", fixture, "--json"]);
  assert.equal(validated.code, 0, validated.stderr || validated.stdout);
  assert.equal(JSON.parse(validated.stdout).status, "valid");
});
