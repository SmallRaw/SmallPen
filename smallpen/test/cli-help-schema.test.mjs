import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  rm,
} from "node:fs/promises";
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

