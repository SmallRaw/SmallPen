import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  INITIALIZATION_QUESTION_IDS,
  OPERATION_SCHEMAS,
  SMALLPEN_FORMAT_CAPABILITIES,
  TOKEN_VALUE_SHAPES,
  tokenValueMatchesType,
} from "@smallpen/core";

import {
  INIT_ANSWERS_EXAMPLE,
  INSTANCE_NODE_EXAMPLE,
  SCHEMA_TOPICS,
  WORKED_EXAMPLE,
} from "../apps/cli/bin/schema.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "apps", "cli", "bin", "smallpen.mjs");
const OPERATION_TYPES = SMALLPEN_FORMAT_CAPABILITIES.canonicalWrite.operationTypes;

function runCli(args, cwd) {
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

async function initAcme(root) {
  await writeFile(join(root, "answers.json"), JSON.stringify(INIT_ANSWERS_EXAMPLE));
  const init = await runCli(
    ["init", "acme", "--answers", "answers.json", "--confirm", "--json"],
    root,
  );
  assert.equal(init.code, 0, init.stdout);
  return {
    foundation: join(root, "acme", "acme-foundation.smallpen"),
    product: join(root, "acme", "acme.smallpen"),
  };
}

async function revision(packagePath, root) {
  const inspected = await runCli(["inspect", packagePath, "--json"], root);
  assert.equal(inspected.code, 0, inspected.stdout);
  return JSON.parse(inspected.stdout).package.revision;
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
  "put-component-set",
  "put-variant",
  "update-component-node",
  "put-context-file",
  "put-screen",
  "set-default-screen",
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
  "set-foundation-dependency",
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
  assert.deepEqual(Object.keys(OPERATION_SCHEMAS).sort(), [...OPERATION_TYPES].sort());
  for (const [type, schema] of Object.entries(OPERATION_SCHEMAS)) {
    assert.equal(schema.example.type, type, type);
    assert.ok(schema.purpose && schema.inverse, type);
    assert.ok(["any", "foundation", "product"].includes(schema.package), type);
  }
  const covered = SEQUENCE.map((step) => (typeof step === "string" ? step : step.name));
  for (const type of OPERATION_TYPES) assert.ok(covered.includes(type), `${type} example is not tested`);
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
  for (const topic of SCHEMA_TOPICS.filter((name) => name !== "operation")) {
    const result = await runCli(["schema", topic, "--json"], root);
    assert.equal(result.code, 0, `${topic}: ${result.stdout}`);
    assert.equal(JSON.parse(result.stdout).topic, topic);
  }
  const listed = JSON.parse((await runCli(["schema", "operations"], root)).stdout);
  assert.deepEqual(listed.operations.map(({ type }) => type), [...OPERATION_TYPES]);
  const detail = JSON.parse((await runCli(["schema", "operation", "put-token"], root)).stdout);
  assert.deepEqual(detail.example.operations, [OPERATION_SCHEMAS["put-token"].example]);
  assert.equal(detail.fields.filePath.required, true);
  const shorthand = JSON.parse((await runCli(["schema", "put-token"], root)).stdout);
  assert.deepEqual(shorthand, detail);
  const theme = JSON.parse((await runCli(["schema", "theme"], root)).stdout);
  assert.equal(theme.topic, "context");

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
  assert.deepEqual(Object.keys(init.answersFile).sort(), [...INITIALIZATION_QUESTION_IDS].sort());
  const axes = init.questions.find(({ id }) => id === "contextAxes");
  assert.deepEqual(Object.keys(axes.schema.items.properties).sort(), [
    "defaultValue",
    "id",
    "kind",
    "name",
    "values",
  ]);
});

test("every operation example applies to a workspace made by smallpen init", async (context) => {
  const root = await scratch(context);
  const packages = await initAcme(root);
  const revisions = {
    foundation: await revision(packages.foundation, root),
    product: await revision(packages.product, root),
  };
  for (const [index, step] of SEQUENCE.entries()) {
    const name = typeof step === "string" ? step : step.name;
    const example = step.example ?? OPERATION_SCHEMAS[name].example;
    const target =
      (OPERATION_SCHEMAS[example.type].package === "foundation") ? "foundation" : "product";
    const operations = [
      ...(step.setup ?? []).map((type) => OPERATION_SCHEMAS[type].example),
      example,
    ];
    const batchPath = join(root, `step-${index}.json`);
    await writeFile(
      batchPath,
      JSON.stringify({ baseRevision: revisions[target], batchId: `example-${index}`, operations }),
    );
    const result = await runCli(
      ["apply", packages[target], "--batch", batchPath, ...(step.dryRun ? ["--dry-run"] : []), "--json"],
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
    if (!step.dryRun) revisions[target] = applied.revision;
  }
  const validated = await runCli(["validate", packages.product, "--json"], root);
  assert.equal(validated.code, 0, validated.stdout);
});

test("the worked example in smallpen --help runs end to end", async (context) => {
  const root = await scratch(context);
  const help = (await runCli(["--help"], root)).stdout;
  for (const step of WORKED_EXAMPLE) {
    assert.ok(help.includes(`smallpen ${step.argv.join(" ")}`), step.title);
    for (const [name, value] of Object.entries(step.files)) {
      assert.ok(help.includes(`${name}: ${JSON.stringify(value)}`), name);
      let content = value;
      if (value.baseRevision !== undefined) {
        content = { ...value, baseRevision: await revision(join(root, step.argv[1]), root) };
      }
      await writeFile(join(root, name), JSON.stringify(content));
    }
    const result = await runCli(step.argv, root);
    assert.equal(result.code, 0, `${step.title}: ${result.stdout}`);
  }
  const semantic = JSON.parse(
    (await runCli(["read-view", "acme/acme.smallpen", "--format", "semantic", "--json"], root)).stdout,
  );
  const text = JSON.stringify(semantic);
  assert.match(text, /Add task/);
  assert.match(text, /node_title/);
});
