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
import { createEvidence, renderProjection, openPackage } from "@smallpen/local-package";

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
  const result = await runCli(["advanced", "apply", packagePath, "--batch", `${batchId}.json`, "--json"], root);
  assert.equal(result.code, 0, result.stdout);
}

// smallpen init --layout foundation-product, the Button Component Set in
// the Foundation, and one Button Instance on the Product's Home screen.
async function acmeWithInstance(context) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-batch-followups-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(join(root, "answers.json"), JSON.stringify(INIT_ANSWERS_EXAMPLE));
  const init = await runCli(
    [
      "init",
      "acme",
      "--answers",
      "answers.json",
      "--layout",
      "foundation-product",
      "--confirm",
      "--json",
    ],
    root,
  );
  assert.equal(init.code, 0, init.stdout);
  const foundationPath = join(root, "acme", "acme-foundation.smallpen");
  const productPath = join(root, "acme", "acme.smallpen");
  await apply(root, foundationPath, [OPERATION_SCHEMAS["put-component-set"].example], "button");
  await apply(root, productPath, [{
    node: {
      ...INSTANCE_NODE_EXAMPLE,
      instance: {
        ...INSTANCE_NODE_EXAMPLE.instance,
        component: { assetId: "cmp_button", packageId: "pkg_acme_foundation" },
      },
    },
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

test("font fallback diagnostics name both fonts as structured details", async () => {
  const example = await openPackage(join(here, "..", "examples", "common-components.smallpen"));
  const render = await renderProjection(example, { rootId: "root", nodes: {
    root: { id: "root", type: "FRAME", name: "Font fallback", x: 0, y: 0,
      width: 200, height: 100, fills: [], children: ["text"] },
    text: { id: "text", type: "TEXT", name: "Unknown font", x: 0, y: 0,
      width: 100, height: 30, children: [], text: "Hello",
      textStyle: { fontId: "missing-fixture-sans", fontFamily: "Missing Fixture Sans", fontSize: 16 } },
  } });
  const fallback = render.diagnostics.find(({ code }) => code === "font_render_fallback");
  assert.deepEqual(fallback.details, {
    requestedFont: "Missing Fixture Sans",
    substituteFont: "Source Sans Pro",
  });
  assert.equal(fallback.message, "Renderer substituted Source Sans Pro for Missing Fixture Sans");
});

