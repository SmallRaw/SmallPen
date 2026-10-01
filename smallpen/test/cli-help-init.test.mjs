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
      env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "", LC_MESSAGES: "", ...env },
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

test("single --answer calls with the same --state build up the answers", async (context) => {
  const target = await workspace(context);
  const state = `${target}.state.json`;
  for (const [id, value] of [
    ["projectKind", "application"],
    ["projectName", "Acme"],
    ["purpose", "Track daily tasks"],
  ]) {
    const result = await runCli([
      "init", target, "--state", state, "--answer", `${id}=${JSON.stringify(value)}`, "--json",
    ]);
    assert.equal(result.code, 0);
    assert.equal(result.json.stateNotice, undefined);
  }
  const last = await runCli(["init", target, "--state", state, "--json"]);
  assert.deepEqual(last.json.answers, {
    projectKind: "application",
    projectName: "Acme",
    purpose: "Track daily tasks",
  });
  assert.equal(last.json.nextQuestion.id, "audience");
});

test("init without --state warns that it did not read earlier answers", async (context) => {
  const target = await workspace(context);
  await runCli(["init", target, "--answer", 'projectKind="application"', "--json"]);
  const second = await runCli(["init", target, "--answer", 'projectName="Acme"', "--json"]);
  assert.equal(second.json.nextQuestion.id, "projectKind");
  assert.match(second.json.stateNotice, /--state/);
  assert.match(second.json.answersTemplate, /smallpen schema init/);
  const continuation = second.json.nextQuestion.continuation.args;
  assert.equal(continuation[continuation.indexOf("--state") + 1], second.json.statePath);
});

test("init labels and locale follow the environment unless --locale is given", async (context) => {
  const target = await workspace(context);
  const english = await runCli(["init", target, "--json"]);
  assert.equal(english.json.nextQuestion.label, "Project kind");
  assert.deepEqual(english.json.nextQuestion.continuation.args.slice(-2), ["--locale", "en"]);

  const chinese = await runCli(["init", target, "--json"], { LANG: "zh_TW.UTF-8" });
  assert.equal(chinese.json.nextQuestion.label, "專案類型");
  assert.deepEqual(chinese.json.nextQuestion.continuation.args.slice(-2), ["--locale", "zh-TW"]);

  const overridden = await runCli(["init", target, "--json"], {
    LANG: "zh_CN.UTF-8",
    LC_ALL: "en_GB.UTF-8",
  });
  assert.equal(overridden.json.nextQuestion.label, "Project kind");

  const explicit = await runCli(["init", target, "--locale", "zh-TW", "--json"]);
  assert.equal(explicit.json.nextQuestion.label, "專案類型");
});

test("an invalid contextAxes answer returns the full item schema", async (context) => {
  const target = await workspace(context);
  const result = await runCli([
    "init", target, "--answer", 'contextAxes=["theme"]', "--json",
  ]);
  assert.equal(result.code, 1);
  const { schema } = result.json.error.details;
  assert.deepEqual(schema.items.properties.kind.enum, [
    "accessibility",
    "custom",
    "density",
    "locale",
    "theme",
    "viewport",
  ]);
  assert.equal(schema.items.properties.values.items.type, "string");
});
