import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "apps", "cli", "bin", "smallpen-check.cjs");
const buildScript = join(here, "..", "scripts", "build-cli.mjs");
const fixture = join(here, "fixtures", "roundtrip.smallpen");

function run(args, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stderr, stdout }));
  });
}

test("watch rejects a non-numeric --interval instead of polling nonstop", async () => {
  for (const value of ["abc", "-5", "1.5"]) {
    const result = await run([cli, "watch", fixture, "--interval", value, "--json"]);
    assert.equal(result.signal, null, `watch --interval ${value} must exit`);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout + result.stderr, /invalid_integer_option/);
  }
});

test("CLI build refuses to replace an existing non-empty --output", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-cli-output-"));
  context.after(() => rm(parent, { force: true, recursive: true }));
  const output = join(parent, "keep-me");
  await mkdir(output);
  await writeFile(join(output, "notes.txt"), "user data");

  const refused = await run([buildScript, "--output", output]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /Output already exists/);
  assert.equal(await readFile(join(output, "notes.txt"), "utf8"), "user data");

  const file = join(parent, "file-output");
  await writeFile(file, "user file");
  const refusedFile = await run([buildScript, "--output", file]);
  assert.notEqual(refusedFile.code, 0);
  assert.equal(await readFile(file, "utf8"), "user file");
});
