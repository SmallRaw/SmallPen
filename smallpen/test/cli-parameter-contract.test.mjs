import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { canonicalJSON } from "@smallpen/core";
import { batchHistoryPath, replayRecordedBatch } from "@smallpen/local-package";
import { seedLegacyIds } from "./helpers/named.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../apps/cli/bin/smallpen.mjs");
const fixture = join(here, "fixtures/variant-acme.smallpen");

async function run(argv, exitCode = 0) {
  // These semantic checks request complete values; file transport has its own integration tests.
  if (argv.includes("--full") && !argv.includes("--stdout"))
    argv = [...argv, "--stdout"];
  const child = spawn(process.execPath, [cli, ...argv], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, exitCode, stdout || stderr);
  return {
    value: /^[\[{]/.test(stdout.trim()) ? JSON.parse(stdout) : undefined,
    stdout,
    bytes: Buffer.byteLength(stdout),
  };
}

async function packageCopy(context) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-parameter-contract-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const packagePath = join(root, "acme.smallpen");
  await cp(fixture, packagePath, { recursive: true });
  await seedLegacyIds(packagePath, "variant-acme");
  const { value } = await run(["check", packagePath, "--json"]);
  return { root, packagePath, revision: value.revision };
}

test("one command schema describes only canonical selectors, values and defaults", async () => {
  const { value, bytes } = await run(["schema", "command", "view", "--json"]);
  assert.equal(value.topic, "command");
  assert.equal(value.command, "view");
  assert.ok(bytes < 8192);
  assert.equal(value.parameters.page.option, "--page");
  assert.equal(value.parameters.component.option, "--component");
  assert.ok(
    Object.values(value.parameters).every(
      (parameter) =>
        !Object.hasOwn(parameter, "aliases") &&
        !/-id$/.test(parameter.option),
    ),
  );
  assert.equal(value.parameters.limit.type, "integer");
  assert.equal(value.parameters.limit.default, 20);
  assert.equal(value.parameters.limit.maximum, 100);
  assert.equal(value.parameters.theme.repeatable, true);
  assert.deepEqual(value.parameters.as.values, [
    "text",
    "wireframe",
    "png",
    "issues",
    "spec",
  ]);
  // Batch operations are the App's; agents edit files, so they have no schema.
  assert.equal((await run(["schema", "operation", "update-component-node", "--json"], 1)).value.error.code, "unknown_schema_topic");
});

test("name selectors work and ID selectors fail before reading a package", async () => {
  const named = (
    await run(["view", fixture, "--page", "Home", "--platform", "mobile", "--json"])
  ).value;
  assert.deepEqual(named.target, { page: "Home", platform: "mobile" });
  for (const [command, option, value] of [
    [["view"], "--screen-id", "scr_home"],
    [["view"], "--presentation-id", "pres_home_mobile"],
    [["view"], "--scenario-id", "scn_home"],
    [["view"], "--context-profile-id", "ctx_default"],
    [["view"], "--format", "wireframe"],
    [["export"], "--component-id", "cmp_button"],
    [["check"], "--node-id", "node_button_root"],
    [["check"], "--all", undefined],
    [["token", "list"], "--token-id", "tok_x"],
  ]) {
    const error = (
      await run(
        [
          ...command,
          "/missing.smallpen",
          option,
          ...(value ? [value] : []),
          "--json",
        ],
        1,
      )
    ).value.error;
    assert.equal(error.code, "unknown_option");
    assert.equal(error.details.option, option);
    assert.ok(!error.details.validOptions.includes(option));
    assert.equal(error.writeState, "not-applied");
    assert.equal(error.details.command, command.join(" "));
    const next = error.details.nextOperations[0].argv;
    assert.deepEqual(next, ["schema", "command", ...command, "--json"]);
    assert.equal((await run(next)).value.command, command.join(" "));
  }
  const duplicate = (
    await run(
      ["view", "/missing.smallpen", "--page", "Home", "--page", "Other", "--json"],
      1,
    )
  ).value.error;
  assert.equal(duplicate.code, "duplicate_option");
  assert.equal(duplicate.details.field, "page");
});

test("schema names stay exact while ordinary CLI help/version flags are supported", async () => {
  for (const argv of [
    ["schema", "themes"],
    ["schema", "token-sets"],
    ["schema", "put-token"],
  ]) {
    const error = (await run([...argv, "--json"], 1)).value.error;
    assert.equal(error.code, "unknown_schema_topic");
  }
  const guide = (await run(["help", "--json"])).value;
  assert.ok(guide.commands.some(({ command }) => command === "check"));
  const help = await run(["-h"]);
  assert.match(help.stdout, /Usage:/);
  assert.match(
    (await run(["view", "/missing.smallpen", "-h"])).stdout,
    /SmallPen view/,
  );
  const { version: cliVersion } = JSON.parse(
    await readFile(join(here, "../apps/cli/package.json"), "utf8"),
  );
  assert.equal(
    (await run(["--version"])).stdout,
    `@smallpen/cli ${cliVersion}\n`,
  );
  const globalVersion = (await run(["--version", "--json"])).value;
  assert.equal(typeof globalVersion.version, "string");
  const version = (await run(["version"])).value;
  assert.equal(typeof version.version, "string");
});

test("command errors include bounded input facts and an executable schema lookup", async () => {
  for (const [argv, code, field, received] of [
    [
      ["view", "/missing.smallpen", "--as", "bad"],
      "unknown_view_as",
      "as",
      "bad",
    ],
    [
      ["token", "list", "/missing.smallpen", "--limit", "101"],
      "invalid_integer_option",
      "limit",
      "101",
    ],
    [
      ["export", "/missing.smallpen", "--output"],
      "missing_option_value",
      "output",
      null,
    ],
  ]) {
    const { value, bytes } = await run([...argv, "--json"], 1);
    assert.equal(value.error.code, code);
    assert.equal(value.error.details.field, field);
    assert.equal(value.error.details.received, received);
    assert.ok(value.error.details.expected);
    assert.equal(value.error.writeState, "not-applied");
    assert.ok(bytes < 4096);
    const command = argv.slice(0, argv.indexOf("/missing.smallpen"));
    assert.equal(value.error.details.command, command.join(" "));
    const followup = value.error.details.nextOperations[0].argv;
    assert.deepEqual(followup, ["schema", "command", ...command, "--json"]);
    assert.equal((await run(followup)).value.command, command.join(" "));
  }
});

test("missing variants, elements and versions list the valid names", async () => {
  for (const [argv, code, list, valid] of [
    [["--component", "Chip", "--variant", "typo"], "unknown_variant", "variants", "Tone: brand"],
    [["--component", "Chip", "--element", "Missing"], "unknown_element", "elements", "Label"],
    [["--page", "Home", "--platform", "typo"], "unknown_platform", "platforms", "mobile"],
    [["--page", "Nope"], "unknown_page", "pages", "Home"],
  ]) {
    const error = (await run(["view", fixture, ...argv, "--json"], 1)).value
      .error;
    assert.equal(error.code, code);
    assert.equal(error.writeState, "not-applied");
    assert.ok(error.details[list].includes(valid), JSON.stringify(error));
  }
  // The listed names select the target.
  const element = (
    await run([
      "view",
      fixture,
      "--component",
      "Chip",
      "--variant",
      "Tone=brand",
      "--element",
      "Label",
      "--json",
    ])
  ).value;
  assert.deepEqual(element.target, {
    component: "Chip",
    variant: "Tone: brand",
    element: "Label",
  });
});

test("recorded confirmations still enforce the current operation fields", async (context) => {
  const { packagePath, revision } = await packageCopy(context);
  const batch = {
    baseRevision: revision,
    batchId: "old-confirmation",
    operations: [
      {
        type: "update-component-node",
        componentSetId: "cmp_button",
        variantId: "var_button_default",
        nodeId: "node_button_root",
        changes: { width: 160 },
      },
    ],
  };
  const hash = (value) =>
    createHash("sha256").update(canonicalJSON(value)).digest("hex");
  const ledgerPath = await batchHistoryPath(packagePath);
  await mkdir(dirname(ledgerPath), { recursive: true });
  await writeFile(
    ledgerPath,
    JSON.stringify({
      [batch.batchId]: {
        identityHash: hash({
          baseRevision: revision,
          operations: batch.operations,
        }),
        operationsHash: hash({ operations: batch.operations }),
        revision,
        result: { batchId: batch.batchId, revision },
      },
    }),
  );
  await assert.rejects(
    replayRecordedBatch(packagePath, batch),
    (error) =>
      error.code === "unknown_operation_field" &&
      error.details.field === "componentSetId",
  );
  assert.equal(
    (await run(["check", packagePath, "--json"])).value.revision,
    revision,
  );
});

test("all commands have a small parameter contract and inherited names fail typed", async () => {
  const index = (await run(["schema", "commands", "--full", "--json"])).value;
  async function verify(path) {
    const { value, bytes } = await run(["schema", "command", ...path, "--json"]);
    assert.equal(value.command, path.join(" "));
    assert.ok(bytes < 16_384, `${path.join(" ")}: ${bytes} bytes`);
    if (value.actions) {
      for (const { action } of value.actions) await verify([...path, action]);
      return;
    }
    assert.ok(Object.keys(value.parameters).length);
    assert.ok(Object.values(value.parameters).every((parameter) => !Object.hasOwn(parameter, "aliases")));
  }
  for (const { name } of index.commands) {
    await verify([name]);
  }
  const bad = (await run(["schema", "command", "__proto__", "--json"], 1)).value
    .error;
  assert.equal(bad.code, "unknown_schema_command");
  assert.ok(
    (await run(bad.details.nextOperations[0].argv)).value.commands.length,
  );
});

test("repeated single-value options and removed options fail before any workspace read", async () => {
  for (const [argv, code] of [
    [
      ["view", "/missing.smallpen", "--as", "text", "--as", "png"],
      "duplicate_option",
    ],
    [
      ["init", "/missing-workspace", "--answer", "projectKind={bad}"],
      "unknown_option",
    ],
  ]) {
    const error = (await run([...argv, "--json"], 1)).value.error;
    assert.equal(error.code, code);
    assert.equal(error.writeState, "not-applied");
    assert.ok(error.details.nextOperations.length);
  }
});

test("long invalid values preserve a small actionable diagnostic", async () => {
  const { value, bytes } = await run(
    ["view", "/missing.smallpen", "--as", "bad".repeat(20_000), "--json"],
    1,
  );
  assert.ok(bytes < 4096);
  assert.equal(value.error.details.field, "as");
  assert.ok(value.error.details.received.length < 300);
  assert.deepEqual(value.error.details.nextOperations[0].argv, [
    "schema",
    "command",
    "view",
    "--json",
  ]);
});

test("command schemas describe their limits, and removed commands have none", async () => {
  const schema = async (name) =>
    (await run(["schema", "command", name, "--json"])).value;
  for (const command of ["view", "export"]) {
    assert.equal((await schema(command)).parameters.scale.maximum, 8);
  }
  assert.equal((await schema("check")).parameters.render.type, "boolean");
  for (const removed of ["repair", "search-components", "search-tokens", "impact", "validate"]) {
    assert.equal((await run(["schema", "command", removed, "--json"], 1)).value.error.code, "unknown_schema_command", removed);
  }
});

test("command-specific constraints fail with recovery facts before opening a package", async () => {
  for (const [command, options, code, field] of [
    [["view"], ["--scale", "9"], "invalid_render_scale", "scale"],
    [["export"], ["--scale", "9"], "invalid_render_scale", "scale"],
    [["token", "list"], ["--limit", "101"], "invalid_integer_option", "limit"],
  ]) {
    const { value, bytes } = await run(
      [...command, "/missing.smallpen", ...options, "--json"],
      1,
    );
    const error = value.error;
    assert.equal(error.code, code, command.join(" "));
    assert.equal(error.details.field, field, command.join(" "));
    assert.ok(error.details.expected, command.join(" "));
    assert.ok(Object.hasOwn(error.details, "received"), command.join(" "));
    assert.equal(error.writeState, "not-applied");
    assert.ok(bytes < 4096);
    assert.equal(error.details.command, command.join(" "));
    const next = error.details.nextOperations[0].argv;
    assert.deepEqual(next, ["schema", "command", ...command, "--json"]);
    assert.equal((await run(next)).value.command, command.join(" "));
  }
});

test("zero-item pagination keeps its total", async () => {
  const tokens = (await run(["token", "list", fixture, "--limit", "0", "--json"])).value;
  assert.deepEqual(tokens.items, []);
  assert.equal(tokens.page.limit, 0);
  assert.ok(tokens.page.total > 0);
});

test("missing positional paths use the same actionable parameter errors", async () => {
  for (const [command, code, field] of [
    [["view"], "missing_package", "package"],
    [["init"], "missing_workspace", "workspace"],
  ]) {
    const error = (await run([...command, "--json"], 1)).value.error;
    assert.equal(error.details.command, command.join(" "));
    assert.equal(error.code, code);
    assert.equal(error.details.field, field);
    assert.equal(error.details.expectedType, "path");
    assert.equal(error.details.received, null);
    assert.ok(error.details.expected);
    assert.equal(error.writeState, "not-applied");
    assert.deepEqual(error.details.nextOperations[0].argv, [
      "schema",
      "command",
      ...command,
      "--json",
    ]);
  }
});
