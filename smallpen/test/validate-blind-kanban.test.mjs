// Regressions from a blind CLI run that built a design system: Token names
// that are both a Token and a group, Instances left on a deleted variant,
// errors without the received value, and gaps in `smallpen schema`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { OPERATION_SCHEMAS } from "@smallpen/core";

import { INIT_ANSWERS_EXAMPLE } from "../apps/cli/bin/schema.mjs";
import { readModelEntry } from "./helpers/named.mjs";

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
    child.once("close", (code) =>
      resolve({ code, json: parse(stdout), stdout }),
    );
  });
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function scratch(context) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-blind-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  return root;
}

async function initAcme(root, layout) {
  await writeFile(
    join(root, "answers.json"),
    JSON.stringify(INIT_ANSWERS_EXAMPLE),
  );
  const result = await runCli(
    [
      "init",
      "acme",
      "--answers",
      "answers.json",
      "--confirm",
      "--json",
      ...(layout ? ["--layout", layout] : []),
    ],
    root,
  );
  assert.equal(result.code, 0, result.stdout);
  return layout
    ? {
        foundation: join(root, "acme", "acme-foundation.smallpen"),
        product: join(root, "acme", "acme.smallpen"),
      }
    : {
        foundation: join(root, "acme", "acme.smallpen"),
        product: join(root, "acme", "acme.smallpen"),
      };
}

let intentCount = 0;
// Token operations go through `advanced apply`, the exact batch route.
function token(root, packagePath, operations) {
  return apply(root, packagePath, operations);
}

// Adds Instance nodes under a Screen's base Presentation root, the batch
// the removed `page --intent` route used to compile.
function addToScreen(root, packagePath, nodes) {
  return apply(
    root,
    packagePath,
    nodes.map((node) => ({
      node,
      parentId: "node_home_root",
      presentationId: "pres_home_mobile",
      screenId: "scr_home",
      type: "add-presentation-node",
    })),
  );
}

async function apply(root, packagePath, operations) {
  const inspected = await runCli(["check", packagePath, "--json"], root);
  const file = join(root, `batch-${(intentCount += 1)}.json`);
  await writeFile(
    file,
    JSON.stringify({
      baseRevision: inspected.json.revision,
      batchId: `blind-${intentCount}`,
      operations,
    }),
  );
  return runCli(["advanced", "apply", packagePath, "--batch", file, "--json"], root);
}

function setToken(setId, id, name, value = "#ff0000") {
  return {
    setId,
    token: { id, name, type: "color", value },
    type: "put-set-token",
  };
}

const CARD_SET = {
  componentSet: {
    axes: [],
    id: "cmp_card",
    name: "Card",
    variants: [
      {
        id: "var_card_default",
        nodes: {
          node_card_action: {
            children: [],
            height: 40,
            id: "node_card_action",
            instance: {
              component: { assetId: "cmp_button", packageId: "pkg_acme" },
              variant: { axis_style: "primary" },
            },
            name: "Action",
            type: "INSTANCE",
            width: 120,
            x: 16,
            y: 16,
          },
          node_card_root: {
            children: ["node_card_action"],
            height: 72,
            id: "node_card_root",
            name: "Card",
            type: "COMPONENT",
            width: 200,
            x: 0,
            y: 0,
          },
        },
        rootId: "node_card_root",
        selection: {},
      },
    ],
    visibility: "public",
  },
  type: "put-component-set",
};

function buttonWithSecondary() {
  const example = structuredClone(
    OPERATION_SCHEMAS["put-component-set"].example,
  );
  const primary = example.componentSet.variants[0];
  example.componentSet.variants.push({
    ...structuredClone(primary),
    id: "var_button_secondary",
    selection: { axis_style: "secondary" },
  });
  return example;
}

