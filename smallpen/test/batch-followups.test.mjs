// Instance overrides checked against Foundation components, structured font
// fallback diagnostics, and one inverse restore per written entry.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { OPERATION_SCHEMAS, prepareOperationBatch } from "@smallpen/core";
import { createEvidence, openPackage } from "@smallpen/local-package";

import { INIT_ANSWERS_EXAMPLE, INSTANCE_NODE_EXAMPLE } from "../apps/cli/bin/schema.mjs";

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

async function apply(root, packagePath, operations, batchId) {
  const before = await openPackage(packagePath);
  await writeFile(
    join(root, `${batchId}.json`),
    JSON.stringify({ baseRevision: before.revision, batchId, operations }),
  );
  const result = await runCli(["apply", packagePath, "--batch", `${batchId}.json`, "--json"], root);
  assert.equal(result.code, 0, result.stdout);
}

// smallpen init, the Button Component Set in the Foundation, and one Button
// Instance on the Product's Home screen.
async function acmeWithInstance(context) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-batch-followups-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(join(root, "answers.json"), JSON.stringify(INIT_ANSWERS_EXAMPLE));
  const init = await runCli(
    ["init", "acme", "--answers", "answers.json", "--confirm", "--json"],
    root,
  );
  assert.equal(init.code, 0, init.stdout);
  const foundationPath = join(root, "acme", "acme-foundation.smallpen");
  const productPath = join(root, "acme", "acme.smallpen");
  await apply(root, foundationPath, [OPERATION_SCHEMAS["put-component-set"].example], "button");
  await apply(root, productPath, [{
    node: INSTANCE_NODE_EXAMPLE,
    parentId: "node_home_root",
    presentationId: "pres_home_mobile",
    screenId: "scr_home",
    type: "add-presentation-node",
  }], "instance");
  return {
    foundation: await openPackage(foundationPath),
    product: await openPackage(productPath),
  };
}

test("an override path is checked against a Foundation component", async (context) => {
  const { foundation, product } = await acmeWithInstance(context);
  const override = (overridePath) => ({
    baseRevision: product.revision,
    batchId: "override",
    operations: [{ ...OPERATION_SCHEMAS["set-instance-override"].example, overridePath }],
  });
  await assert.rejects(
    prepareOperationBatch(product, override("node_button_lable:text"), { foundation }),
    (error) => error.code === "missing_component_override_target",
  );
  await assert.rejects(
    prepareOperationBatch(product, override("node_button_root:text"), { foundation }),
    (error) => error.code === "component_override_type_mismatch",
  );
  const valid = await prepareOperationBatch(
    product,
    override("node_button_label:text"),
    { foundation },
  );
  assert.notEqual(valid.snapshot.revision, product.revision);
});

test("font fallback diagnostics name both fonts as structured details", async () => {
  const example = await openPackage(join(here, "..", "examples", "common-components.smallpen"));
  const { render } = await createEvidence(example, {
    scale: 1,
    selector: { viewFormat: "screenshot" },
  });
  const fallback = render.diagnostics.find(({ code }) => code === "font_render_fallback");
  assert.deepEqual(fallback.details, {
    requestedFont: "Inter",
    substituteFont: "Source Sans Pro",
  });
  assert.equal(fallback.message, "Renderer substituted Source Sans Pro for Inter");
});

test("many writes to one token file keep one restore in the inverse batch", async (context) => {
  const { foundation } = await acmeWithInstance(context);
  const putToken = (name) => ({
    definition: {
      $extensions: { smallpen: { id: `tok_color_${name}` } },
      $type: "color",
      $value: "#123456",
    },
    filePath: "tokens/foundation.json",
    path: `color.${name}`,
    tokenId: `tok_color_${name}`,
    type: "put-token",
  });
  const prepared = await prepareOperationBatch(foundation, {
    baseRevision: foundation.revision,
    batchId: "many-tokens",
    operations: ["one", "two", "three", "four"].map(putToken),
  });
  assert.deepEqual(
    prepared.result.inverseBatch.operations.map(({ entry, type }) => [type, entry]),
    [["restore-canonical-entry", "tokens/foundation.json"]],
  );
  const restored = await prepareOperationBatch(
    prepared.snapshot,
    prepared.result.inverseBatch,
  );
  assert.equal(restored.snapshot.revision, foundation.revision);
});
