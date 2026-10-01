import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { OPERATION_SCHEMAS, prepareOperationBatch } from "@smallpen/core";
import { openPackage } from "@smallpen/local-package";

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

async function acme(context) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-cli-errors-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(join(root, "answers.json"), JSON.stringify(INIT_ANSWERS_EXAMPLE));
  const init = await runCli(
    ["init", "acme", "--answers", "answers.json", "--confirm", "--json"],
    root,
  );
  assert.equal(init.code, 0, init.stdout);
  return {
    foundation: join(root, "acme", "acme-foundation.smallpen"),
    product: join(root, "acme", "acme.smallpen"),
    root,
  };
}

let batchCount = 0;

// Runs one batch through apply --dry-run and returns the parsed output.
async function dryRun(workspace, target, operations) {
  const packagePath = workspace[target];
  const inspected = JSON.parse((await runCli(["inspect", packagePath, "--json"], workspace.root)).stdout);
  batchCount += 1;
  const batchPath = join(workspace.root, `batch-${batchCount}.json`);
  await writeFile(
    batchPath,
    JSON.stringify({
      baseRevision: inspected.package.revision,
      batchId: `errors-${batchCount}`,
      operations,
    }),
  );
  const result = await runCli(
    ["apply", packagePath, "--batch", batchPath, "--dry-run", "--json"],
    workspace.root,
  );
  return { code: result.code, output: JSON.parse(result.stdout) };
}

async function rejected(snapshot, operations) {
  try {
    await prepareOperationBatch(snapshot, {
      baseRevision: snapshot.revision,
      batchId: "errors",
      operations,
    });
  } catch (error) {
    return error;
  }
  return undefined;
}

test("no operation error prints undefined, and missing fields are named", async (context) => {
  const workspace = await acme(context);
  const snapshots = {
    foundation: await openPackage(workspace.foundation),
    product: await openPackage(workspace.product),
  };
  for (const [type, schema] of Object.entries(OPERATION_SCHEMAS)) {
    const snapshot = snapshots[schema.package === "foundation" ? "foundation" : "product"];
    const bare = await rejected(snapshot, [{ type }]);
    if (bare) assert.doesNotMatch(bare.message, /undefined/, `${type}: ${bare.message}`);
    for (const [name, spec] of Object.entries(schema.fields)) {
      if (!spec.required) continue;
      const operation = structuredClone(schema.example);
      delete operation[name];
      const error = await rejected(snapshot, [operation]);
      assert.equal(error?.code, "missing_operation_field", `${type}.${name}`);
      assert.equal(error.details.field, name);
      assert.match(error.message, new RegExp(`requires ${name}`));
      assert.doesNotMatch(error.message, /undefined/);
      if (spec.type === "string") {
        const missing = await rejected(snapshot, [{ ...schema.example, [name]: "x_missing" }]);
        if (missing) {
          assert.doesNotMatch(missing.message, /undefined/, `${type}.${name}: ${missing.message}`);
        }
      }
    }
    const unknown = await rejected(snapshot, [{ ...schema.example, bogusField: 1 }]);
    assert.equal(unknown?.code, "unknown_operation_field", type);
    assert.deepEqual(unknown.details.allowedFields, ["type", ...Object.keys(schema.fields)]);
  }
});

test("operation errors list valid types, allowed fields, and near misses", async (context) => {
  const workspace = await acme(context);
  const wrongType = await dryRun(workspace, "foundation", [{ type: "color" }]);
  assert.equal(wrongType.code, 1);
  assert.equal(wrongType.output.error.code, "unsupported_operation");
  assert.match(wrongType.output.error.message, /put-token/);
  assert.match(wrongType.output.error.message, /smallpen schema operations/);
  assert.ok(wrongType.output.error.details.validTypes.includes("put-component-set"));

  const intentPath = join(workspace.root, "token-intent.json");
  await writeFile(intentPath, JSON.stringify({ operations: [{ type: "put-token" }] }));
  const token = await runCli(
    ["token", workspace.foundation, "--intent", intentPath, "--dry-run", "--json"],
    workspace.root,
  );
  const tokenError = JSON.parse(token.stdout).error;
  assert.equal(tokenError.code, "missing_operation_field");
  assert.match(tokenError.message, /put-token requires filePath/);
  assert.match(tokenError.details.expected, /definition: object/);

  const misplaced = await dryRun(workspace, "foundation", [{
    ...OPERATION_SCHEMAS["put-token"].example,
    $type: "color",
  }]);
  assert.equal(misplaced.output.error.details.suggestion, "definition.$type");

  const componentId = await dryRun(workspace, "foundation", [{
    changes: { name: "Button" },
    componentId: "cmp_button",
    nodeId: "node_button_root",
    type: "update-component-node",
    variantId: "var_button_default",
  }]);
  assert.equal(componentId.output.error.code, "unknown_operation_field");
  assert.equal(componentId.output.error.details.suggestion, "componentSetId");

  const missingSet = await dryRun(workspace, "foundation", [{
    changes: { name: "Button" },
    componentSetId: "cmp_buton",
    nodeId: "node_button_root",
    type: "update-component-node",
    variantId: "var_button_default",
  }]);
  assert.equal(missingSet.output.error.code, "missing_component");
  assert.match(missingSet.output.error.message, /Component Sets: cmp_button/);

  const missingPresentation = await dryRun(workspace, "product", [{
    ...OPERATION_SCHEMAS["update-presentation-node"].example,
    presentationId: "pres_home_desktop",
  }]);
  assert.match(missingPresentation.output.error.message, /Presentations: pres_home_mobile/);
});

test("unknown node change fields are rejected with the field that holds them", async (context) => {
  const workspace = await acme(context);
  const applied = await dryRun(workspace, "foundation", [
    OPERATION_SCHEMAS["put-component-set"].example,
  ]);
  assert.equal(applied.code, 0, JSON.stringify(applied.output));

  const textAlign = await dryRun(workspace, "foundation", [
    OPERATION_SCHEMAS["put-component-set"].example,
    {
      changes: { textAlign: "center" },
      componentSetId: "cmp_button",
      nodeId: "node_button_label",
      type: "update-component-node",
      variantId: "var_button_primary",
    },
  ]);
  assert.equal(textAlign.output.error.code, "unsupported_node_change");
  assert.equal(textAlign.output.error.details.suggestion, "textStyle.textAlign");
  assert.match(textAlign.output.error.message, /Did you mean textStyle\.textAlign/);

  const textOnFrame = await dryRun(workspace, "foundation", [
    OPERATION_SCHEMAS["put-component-set"].example,
    {
      changes: { textStyle: { textAlign: "center" } },
      componentSetId: "cmp_button",
      nodeId: "node_button_root",
      type: "update-component-node",
      variantId: "var_button_primary",
    },
  ]);
  assert.equal(textOnFrame.output.error.code, "unexpected_text_attribute");

  for (const [field, suggestion] of [["textAlign", "textStyle.textAlign"], ["fill", "fills"]]) {
    const node = await dryRun(workspace, "product", [{
      ...OPERATION_SCHEMAS["update-presentation-node"].example,
      changes: { [field]: "center" },
    }]);
    assert.equal(node.output.error.code, "unsupported_node_change", field);
    assert.equal(node.output.error.details.suggestion, suggestion, field);
    assert.ok(node.output.error.details.allowedFields.includes("textStyle"));
  }

  const width = await dryRun(workspace, "product", [{
    ...OPERATION_SCHEMAS["update-presentation"].example,
    changes: { width: 360 },
  }]);
  assert.equal(width.output.error.code, "unsupported_presentation_change");
  assert.equal(width.output.error.details.suggestion, "viewport");
  assert.match(width.output.error.message, /root node size/);
});

test("enum refusals list allowed values and Token errors show the expected shape", async (context) => {
  const workspace = await acme(context);
  const componentSet = structuredClone(OPERATION_SCHEMAS["put-component-set"].example);
  componentSet.componentSet.axes[0].role = "variant";
  const role = await dryRun(workspace, "foundation", [componentSet]);
  assert.equal(role.output.error.code, "invalid_variant_axis_role");
  assert.deepEqual(role.output.error.details.allowedValues, ["configuration", "state"]);
  assert.match(role.output.error.message, /"configuration" for authored options/);

  const typography = structuredClone(OPERATION_SCHEMAS["put-token"].example);
  typography.definition.$type = "typography";
  typography.definition.$value = "24px Inter";
  delete typography.definition.$extensions.smallpen.contextValues;
  const value = await dryRun(workspace, "foundation", [typography]);
  assert.equal(value.output.error.code, "invalid_token_value");
  assert.match(value.output.error.message, /fontSize: number/);
  assert.deepEqual(value.output.error.details.example, {
    fontFamily: "Inter",
    fontSize: 24,
    fontWeight: 700,
  });

  const noValue = structuredClone(OPERATION_SCHEMAS["put-token"].example);
  delete noValue.definition.$value;
  delete noValue.definition.$extensions.smallpen.contextValues;
  const empty = await dryRun(workspace, "foundation", [noValue]);
  assert.equal(empty.output.error.code, "invalid_token_definition");

  const contextual = structuredClone(OPERATION_SCHEMAS["put-token"].example);
  contextual.definition.$extensions.smallpen.contextValues = [
    { context: { axis_theme: "dark" }, value: "#000000" },
  ];
  const rule = await dryRun(workspace, "foundation", [contextual]);
  assert.equal(rule.output.error.code, "invalid_token_context_value");
  assert.match(rule.output.error.message, /"when":\{"axis_theme":"dark"\}/);

  const kind = await dryRun(workspace, "foundation", [{
    ...OPERATION_SCHEMAS["put-context-file"].example,
    contextFile: {
      axes: [{ ...OPERATION_SCHEMAS["put-context-file"].example.contextFile.axes[0], kind: "mode" }],
      profiles: [],
    },
  }]);
  assert.equal(kind.output.error.code, "invalid_context_axis_kind");
  assert.ok(kind.output.error.details.allowedValues.includes("theme"));
});

test("a batch that changes nothing says so", async (context) => {
  const workspace = await acme(context);
  const same = await dryRun(workspace, "foundation", [{
    tokenId: "tok_color_brand",
    type: "set-token-value",
    value: "#6750a4",
  }]);
  assert.equal(same.code, 0);
  assert.equal(same.output.changed, false);
  assert.equal(same.output.noChange.code, "no_change");
  const changed = await dryRun(workspace, "foundation", [
    OPERATION_SCHEMAS["set-token-value"].example,
  ]);
  assert.equal(changed.output.changed, true);
  assert.equal(changed.output.noChange, undefined);
});
