import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  OPERATION_SCHEMAS,
  SMALLPEN_FORMAT_CAPABILITIES,
  TOKEN_VALUE_SHAPES,
  tokenValueMatchesType,
} from "@smallpen/core";

import * as cliSchema from "../apps/cli/bin/schema.mjs";

const { INIT_ANSWERS_EXAMPLE, INSTANCE_NODE_EXAMPLE, SCHEMA_TOPICS } =
  cliSchema;

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "apps", "cli", "bin", "smallpen.mjs");
const OPERATION_TYPES =
  SMALLPEN_FORMAT_CAPABILITIES.canonicalWrite.operationTypes;

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
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr, stdout }));
  });
}

async function scratch(context) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-cli-schema-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  return root;
}

async function initAcme(root, layout) {
  await writeFile(
    join(root, "answers.json"),
    JSON.stringify(INIT_ANSWERS_EXAMPLE),
  );
  if (layout === "foundation-product") {
    const pair = await runCli(
      [
        "project",
        "init",
        "pair",
        "--answers",
        "answers.json",
        "--layout",
        layout,
        "--confirm",
        "--json",
      ],
      root,
    );
    assert.equal(pair.code, 0, pair.stdout);
    return {
      foundation: join(root, "pair", "acme-foundation.smallpen"),
      product: join(root, "pair", "acme.smallpen"),
    };
  }
  const init = await runCli(
    ["project", "init", "acme", "--answers", "answers.json", "--confirm", "--json"],
    root,
  );
  assert.equal(init.code, 0, init.stdout);
  // The default layout is one self-contained Package for both roles.
  return {
    foundation: join(root, "acme", "acme.smallpen"),
    product: join(root, "acme", "acme.smallpen"),
  };
}

async function revision(packagePath, root) {
  const inspected = await runCli(["project", "show", packagePath, "--json"], root);
  assert.equal(inspected.code, 0, inspected.stdout);
  return JSON.parse(inspected.stdout).revision;
}

// Operation examples in an order where each one's targets exist: create in
// the Foundation, build the Product, then delete what the earlier steps made.
const INSTANCE_STEP = {
  node: INSTANCE_NODE_EXAMPLE,
  parentId: "node_home_root",
  presentationId: "pres_home_mobile",
  screenId: "scr_home",
  type: "add-presentation-node",
};
const SEQUENCE = [
  "put-token",
  "set-token-value",
  "deprecate-token",
  "put-set-token",
  "put-token-set",
  "put-token-theme",
  "delete-token-theme",
  "delete-token-set",
  "put-component-set",
  "put-variant",
  "update-component-node",
  "put-context-file",
  "put-screen",
  "set-default-screen",
  "put-canvases",
  "set-token-binding",
  "repair-reference",
  "add-presentation",
  "move-presentation",
  "update-presentation",
  "update-presentation-node",
  "update-node",
  "add-presentation-node",
  { example: INSTANCE_STEP, name: "instance topic" },
  "set-instance-override",
  "select-instance-variant",
  "clear-instance-override",
  "move-presentation-nodes",
  "reorder-presentation-children",
  "put-interaction",
  "delete-interaction",
  "put-scenario",
  "delete-scenario",
  "put-requirement-file",
  "delete-requirement-file",
  "restore-canonical-entry",
  "replace-token-library",
  "set-active-token-themes",
  "replace-asset-library",
  // A Foundation dependency exists only in the foundation-product layout.
  { name: "set-foundation-dependency", pair: true },
  // A linked Library must resolve on later reads, so these two only preview.
  { dryRun: true, name: "put-library" },
  { dryRun: true, name: "remove-library", setup: ["put-library"] },
  "add-component",
  "update-component",
  "delete-component",
  "clear-token-binding",
  "delete-presentation-node",
  "delete-presentation",
  "delete-screen",
  "delete-variant",
  "delete-context-file",
  "remove-token",
  "delete-component-set",
];

test("every operation type has a schema entry, and every schema entry is an operation type", () => {
  assert.deepEqual(
    Object.keys(OPERATION_SCHEMAS).sort(),
    [...OPERATION_TYPES].sort(),
  );
  for (const [type, schema] of Object.entries(OPERATION_SCHEMAS)) {
    assert.equal(schema.example.type, type, type);
    assert.ok(schema.purpose && schema.inverse, type);
    assert.ok(["any", "foundation", "product"].includes(schema.package), type);
  }
  const covered = SEQUENCE.map((step) =>
    typeof step === "string" ? step : step.name,
  );
  for (const type of OPERATION_TYPES)
    assert.ok(covered.includes(type), `${type} example is not tested`);
});

test("every Token type documents a value shape whose example validates", () => {
  for (const type of SMALLPEN_FORMAT_CAPABILITIES.canonicalPackage.tokenTypes) {
    const shape = TOKEN_VALUE_SHAPES[type];
    assert.ok(shape, `${type} has no documented value shape`);
    assert.equal(tokenValueMatchesType(shape.example, type), true, type);
  }
});

test("smallpen schema prints every topic and every operation from the validators", async (context) => {
  const root = await scratch(context);
  const index = JSON.parse((await runCli(["schema"], root)).stdout);
  assert.deepEqual(Object.keys(index.topics), [...SCHEMA_TOPICS]);
  for (const topic of SCHEMA_TOPICS.filter(
    (name) => name !== "operation",
  )) {
    const result = await runCli(
      ["schema", topic, ...(topic === "command" ? ["view"] : []), "--json"],
      root,
    );
    assert.equal(result.code, 0, `${topic}: ${result.stdout}`);
    assert.equal(
      JSON.parse(result.stdout).topic,
      topic === "workflow" ? "rules" : topic,
    );
  }
  const listed = JSON.parse(
    (await runCli(["schema", "operations", "--full"], root)).stdout,
  );
  assert.deepEqual(
    listed.operations.map(({ type }) => type),
    [...OPERATION_TYPES],
  );
  const detail = JSON.parse(
    (await runCli(["schema", "operation", "put-token"], root)).stdout,
  );
  assert.deepEqual(detail.example.operations, [
    OPERATION_SCHEMAS["put-token"].example,
  ]);
  assert.equal(detail.fields.filePath.required, true);
  // Themes are token sets + themes, documented in their own topic.
  const theme = JSON.parse((await runCli(["schema", "theme"], root)).stdout);
  assert.equal(theme.topic, "theme");
  assert.deepEqual(
    theme.operations.createTheme,
    OPERATION_SCHEMAS["put-token-theme"].example,
  );
  assert.match(theme.read, /--theme GROUP\/NAME/);
  assert.match(theme.foundationProduct, /dependencies\[0\]\.activeThemeIds/);

  const typo = await runCli(["schema", "operation", "put-tokn"], root);
  assert.equal(typo.code, 1);
  const typoError = JSON.parse(typo.stdout).error;
  assert.equal(typoError.code, "unknown_schema_operation");
  assert.equal(typoError.details.suggestion, "put-token");
  const unknown = await runCli(["schema", "nodes"], root);
  assert.equal(JSON.parse(unknown.stdout).error.details.suggestion, "node");
  const option = await runCli(["schema", "node", "--verbose"], root);
  assert.equal(JSON.parse(option.stdout).error.code, "unknown_option");

  const init = JSON.parse((await runCli(["schema", "init"], root)).stdout);
  assert.equal(init.questions, undefined);
  assert.equal(init.answersFile, undefined);
  const contract = JSON.parse(
    (await runCli(init.nextOperations[0].argv, root)).stdout,
  );
  assert.equal(contract.command, "project init");
  assert.ok(contract.parameters.name);
});

test("every operation example applies to a workspace made by smallpen init", async (context) => {
  const root = await scratch(context);
  const single = await initAcme(root);
  const pair = await initAcme(root, "foundation-product");
  // Revisions by Package path: both roles may name the same Package.
  const revisions = {};
  for (const path of [single.foundation, pair.foundation, pair.product]) {
    revisions[path] = await revision(path, root);
  }
  for (const [index, step] of SEQUENCE.entries()) {
    const packages = step.pair ? pair : single;
    const name = typeof step === "string" ? step : step.name;
    const example = step.example ?? OPERATION_SCHEMAS[name].example;
    const target =
      OPERATION_SCHEMAS[example.type].package === "foundation"
        ? "foundation"
        : "product";
    const operations = [
      ...(step.setup ?? []).map((type) => OPERATION_SCHEMAS[type].example),
      example,
    ];
    const batchPath = join(root, `step-${index}.json`);
    await writeFile(
      batchPath,
      JSON.stringify({
        baseRevision: revisions[packages[target]],
        batchId: `example-${index}`,
        operations,
      }),
    );
    const result = await runCli(
      [
        "advanced",
        "apply",
        packages[target],
        "--batch",
        batchPath,
        ...(step.dryRun ? ["--dry-run"] : []),
        "--json",
      ],
      root,
    );
    assert.equal(result.code, 0, `${name}: ${result.stdout}`);
    const applied = JSON.parse(result.stdout);
    // Re-pointing the Product at its own Foundation, and linking then
    // unlinking a Library in one batch, keep every byte; the result says so
    // instead of passing silently.
    assert.equal(
      applied.changed,
      !["remove-library", "set-foundation-dependency"].includes(name),
      name,
    );
    if (!step.dryRun) revisions[packages[target]] = applied.revision;
  }
  const validated = await runCli(["validate", single.product, "--json"], root);
  assert.equal(validated.code, 0, validated.stdout);
});

test("the worked example in smallpen schema batch --full runs end to end", async (context) => {
  const root = await scratch(context);
  const help = (await runCli(["advanced", "apply", "--help"], root)).stdout;
  assert.match(help, /smallpen schema batch/);
  const schema = JSON.parse(
    (await runCli(["schema", "batch", "--full"], root)).stdout,
  );
  assert.ok(cliSchema.WORKED_EXAMPLE, "schema.mjs exports WORKED_EXAMPLE");
  assert.deepEqual(schema.workedExample, cliSchema.WORKED_EXAMPLE);
  for (const step of schema.workedExample) {
    for (const [name, value] of Object.entries(step.files)) {
      let content = value;
      if (value.baseRevision !== undefined) {
        content = {
          ...value,
          baseRevision: await revision(join(root, "acme/acme.smallpen"), root),
        };
      }
      await writeFile(join(root, name), JSON.stringify(content));
    }
    const result = await runCli(step.argv, root);
    assert.equal(result.code, 0, `${step.title}: ${result.stdout}`);
  }
  // Every step names commands that still exist and leaves a valid package.
  const validated = await runCli(
    ["validate", "acme/acme.smallpen", "--json"],
    root,
  );
  assert.equal(validated.code, 0, validated.stdout);
});
