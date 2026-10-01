import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { OPERATION_SCHEMAS } from "@smallpen/core";

import { INIT_ANSWERS_EXAMPLE } from "../apps/cli/bin/schema.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "apps", "cli", "bin", "smallpen.mjs");

function runCli(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "", LC_MESSAGES: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout }));
  });
}

// The JSON block that follows `heading` in a help text, joined across its
// indented lines.
function helpJson(help, heading) {
  const block = help.split(heading)[1].split(/\n\s*\n/)[0];
  const source = block.replace(/\n\s*/g, "");
  return JSON.parse(source.slice(source.indexOf("{")));
}

test("write command help points to smallpen schema with a real example", async () => {
  for (const command of ["apply", "token", "page", "flow", "component", "init"]) {
    const help = (await runCli([command, "--help"])).stdout;
    assert.match(help, /smallpen schema/, command);
  }
  const top = (await runCli(["--help"])).stdout;
  assert.match(top, /schema\s+Print the JSON shape/);
  assert.match(top, /Write Tokens\s+and components to the Foundation/);
  assert.match(top, /renders at the size of its root node/);
  assert.match(top, /Worked example/);
  const schemaHelp = (await runCli(["schema", "--help"])).stdout;
  assert.match(schemaHelp, /component-set\s+Component Set, Axis roles \(configuration, state\)/);
});

test("the JSON examples in token, page, apply, and component help apply", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-cli-help-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(join(root, "answers.json"), JSON.stringify(INIT_ANSWERS_EXAMPLE));
  assert.equal(
    (await runCli(["init", "acme", "--answers", "answers.json", "--confirm", "--json"], root)).code,
    0,
  );
  const foundation = "acme/acme-foundation.smallpen";
  const product = "acme/acme.smallpen";
  const revision = async (path) =>
    JSON.parse((await runCli(["inspect", path, "--json"], root)).stdout).package.revision;

  const tokenIntent = helpJson((await runCli(["token", "--help"])).stdout, "Intent example");
  await writeFile(join(root, "tokens.json"), JSON.stringify(tokenIntent));
  const tokens = await runCli(["token", foundation, "--intent", "tokens.json", "--json"], root);
  assert.equal(tokens.code, 0, tokens.stdout);

  await writeFile(join(root, "button.json"), JSON.stringify({
    baseRevision: await revision(foundation),
    batchId: "help-button",
    operations: [OPERATION_SCHEMAS["put-component-set"].example],
  }));
  assert.equal((await runCli(["apply", foundation, "--batch", "button.json", "--json"], root)).code, 0);

  const variantEdit = helpJson((await runCli(["component", "--help"])).stdout, "Edit a variant:");
  await writeFile(join(root, "variant.json"), JSON.stringify({
    baseRevision: await revision(foundation),
    batchId: "help-variant",
    operations: [variantEdit],
  }));
  const edited = await runCli(["apply", foundation, "--batch", "variant.json", "--dry-run", "--json"], root);
  assert.equal(edited.code, 0, edited.stdout);

  const pageIntent = helpJson((await runCli(["page", "--help"])).stdout, "Intent example");
  await writeFile(join(root, "page.json"), JSON.stringify(pageIntent));
  const page = await runCli(["page", product, "--intent", "page.json", "--json"], root);
  assert.equal(page.code, 0, page.stdout);

  const applyHelp = (await runCli(["apply", "--help"])).stdout;
  const batch = helpJson(applyHelp, "Unknown operation types");
  await writeFile(join(root, "resize.json"), JSON.stringify({
    ...batch,
    baseRevision: await revision(product),
  }));
  const resized = await runCli(["apply", product, "--batch", "resize.json", "--json"], root);
  assert.equal(resized.code, 0, resized.stdout);
  assert.equal(JSON.parse(resized.stdout).changed, true);
});
