import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "apps", "cli", "bin", "smallpen.mjs");

function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: {
        ...process.env,
        LANG: "en_US.UTF-8",
        LC_ALL: "",
        LC_MESSAGES: "",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, json: JSON.parse(stdout) }));
  });
}

async function workspace(context) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-cli-init-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  return join(root, "acme");
}

test("the compatibility init alias creates a blank project without questions in any locale", async (context) => {
  const target = await workspace(context);
  const result = await runCli([
    "project",
    "init",
    target,
    "--locale",
    "zh-TW",
    "--name",
    "画板",
    "--json",
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.json.status, "initialized");
  assert.equal(result.json.nextQuestion, undefined);
  assert.equal(result.json.statePath, undefined);
});

test("removed questionnaire parameters are rejected before creating state", async (context) => {
  const target = await workspace(context);
  for (const args of [
    ["--state", `${target}.state.json`],
    ["--answer", 'projectKind="application"'],
  ]) {
    const result = await runCli(["project", "init", target, ...args, "--json"]);
    assert.equal(result.code, 1);
    assert.equal(result.json.error.code, "unknown_option");
    assert.equal(result.json.error.writeState, "not-applied");
  }
});
