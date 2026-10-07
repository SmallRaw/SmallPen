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
  // Schema and full-value checks opt into stdout; fixed-file transport is tested separately.
  if (
    (args[0] === "schema" || args.includes("--full")) &&
    !args.includes("--stdout")
  )
    args = [...args, "--stdout"];
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
  for (const command of [
    ["advanced"],
    ["advanced", "apply"],
    ["token"],
    ["token", "set"],
    ["page"],
    ["page", "draw"],
    ["flow"],
    ["component"],
    ["component", "define"],
    ["project", "init"],
  ]) {
    const help = (await runCli([...command, "--help"])).stdout;
    assert.match(help, /smallpen schema/, command.join(" "));
  }
  // Engine names no longer run; they name their grouped path.
  for (const [command, suggestion] of [
    ["apply", "advanced apply"],
    ["init", "project init"],
  ]) {
    const result = await runCli([command, "--help"]);
    assert.equal(result.code, 1, command);
    const { error } = JSON.parse(result.stdout);
    assert.equal(error.code, "unknown_command", command);
    assert.equal(error.details.suggestion, suggestion, command);
  }
  const top = (await runCli(["--help", "--full"])).stdout;
  assert.match(top, /schema\s+Print the JSON shape/);
  assert.match(top, /project\s+Create, inspect/);
  assert.match(top, /help OBJECT ACTION/);
  assert.doesNotMatch(top, /Worked example/);
  const schemaHelp = (await runCli(["schema", "--help", "--full"])).stdout;
  assert.match(
    schemaHelp,
    /component-set\s+Component Set, Axis roles \(configuration, state\)/,
  );
});

test("help and schema write examples execute against a fresh package", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-cli-help-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    join(root, "answers.json"),
    JSON.stringify(INIT_ANSWERS_EXAMPLE),
  );
  assert.equal(
    (
      await runCli(
        ["project", "init", "acme", "--answers", "answers.json", "--confirm", "--json"],
        root,
      )
    ).code,
    0,
  );
  // The default layout is one self-contained Package for both roles.
  const pkg = "acme/acme.smallpen";
  const revision = async (path) =>
    JSON.parse((await runCli(["project", "show", path, "--json"], root)).stdout).package
      .revision;
  const example = async (topic) =>
    JSON.parse((await runCli(["schema", topic, "--json"], root)).stdout)
      .example;

  // The operation example applies as an exact batch.
  await writeFile(
    join(root, "button.json"),
    JSON.stringify({
      baseRevision: await revision(pkg),
      batchId: "help-button",
      operations: [OPERATION_SCHEMAS["put-component-set"].example],
    }),
  );
  const button = await runCli(
    ["advanced", "apply", pkg, "--batch", "button.json", "--json"],
    root,
  );
  assert.equal(button.code, 0, button.stdout);

  // The component and page examples reference Tokens the blank package
  // does not have yet; create them by name first.
  await writeFile(
    join(root, "prerequisites.json"),
    JSON.stringify({
      tokens: [
        {
          name: "type.label",
          type: "typography",
          value: { fontFamily: "Source Sans Pro", fontSize: 14, fontWeight: 600 },
        },
        { name: "color.bg.canvas", type: "color", value: "#f8fafc" },
      ],
    }),
  );
  const prerequisites = await runCli(
    ["token", "set", pkg, "--intent", "prerequisites.json", "--json"],
    root,
  );
  assert.equal(prerequisites.code, 0, prerequisites.stdout);

  // Each name-based write runs the example its own input query prints.
  for (const [group, action, topic] of [
    ["token", "set", "token-set"],
    ["component", "define", "component-define"],
    ["page", "draw", "page-draw"],
  ]) {
    await writeFile(
      join(root, `${topic}.json`),
      JSON.stringify(await example(topic)),
    );
    const written = await runCli(
      [group, action, pkg, "--intent", `${topic}.json`, "--json"],
      root,
    );
    assert.equal(written.code, 0, `${topic}: ${written.stdout}`);
  }

  const applyHelp = (await runCli(["advanced", "apply", "--help", "--full"])).stdout;
  // The full help carries a worked batch example.
  assert.match(applyHelp, /Unknown operation types/);
  const batch = helpJson(applyHelp, "Unknown operation types");
  await writeFile(
    join(root, "resize.json"),
    JSON.stringify({
      ...batch,
      baseRevision: await revision(pkg),
    }),
  );
  const resized = await runCli(
    ["advanced", "apply", pkg, "--batch", "resize.json", "--json"],
    root,
  );
  assert.equal(resized.code, 0, resized.stdout);
  assert.equal(JSON.parse(resized.stdout).changed, true);
});
