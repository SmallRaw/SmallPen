import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { canonicalJSON } from "@smallpen/core";
import { replayRecordedBatch } from "@smallpen/local-package";

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
  const { value } = await run(["project", "show", packagePath, "--json"]);
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
  ]);
  const operation = (
    await run(["schema", "operation", "update-component-node", "--json"])
  ).value;
  assert.equal(operation.contractRevision, value.contractRevision);
  assert.ok(operation.fields.componentId.required);
  assert.equal(operation.fields.componentId.aliases, undefined);
  assert.equal(operation.fields.componentSetId, undefined);
  assert.equal(operation.example.operations[0].componentId, "cmp_button");
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
    [["validate"], "--node-id", "node_button_root"],
    [["validate"], "--all", undefined],
    [["token", "show"], "--token-id", "tok_x"],
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
  assert.ok(guide.commands.some(({ command }) => command === "project"));
  const help = await run(["-h"]);
  assert.match(help.stdout, /Usage:/);
  assert.match(
    (await run(["view", "/missing.smallpen", "-h"])).stdout,
    /SmallPen view/,
  );
  assert.match((await run(["--version"])).stdout, /alpha/);
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
      ["project", "list", "/missing.smallpen", "--limit", "101"],
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
    [["advanced", "apply", "/missing.smallpen"], "missing_batch", "batch", null],
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
    [["--component", "Chip", "--variant", "typo"], "unknown_variant", "variants", "Tone=brand"],
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
    variant: "Tone=brand",
    element: "Label",
  });
});

test("canonical component batches retry idempotently and return canonical undo", async (context) => {
  const { root, packagePath, revision } = await packageCopy(context);
  const batchPath = join(root, "edit.json");
  const operation = {
    type: "update-component-node",
    componentId: "cmp_button",
    variantId: "var_button_default",
    nodeId: "node_button_root",
    changes: { width: 160 },
  };
  const batch = {
    baseRevision: revision,
    batchId: "contract-component-edit",
    operations: [operation],
  };
  await writeFile(batchPath, JSON.stringify(batch));
  const first = (
    await run(["advanced", "apply", packagePath, "--batch", batchPath, "--json"])
  ).value;
  assert.equal(first.changed, true);
  const ledger = JSON.parse(
    await readFile(`${packagePath}.batches.json`, "utf8"),
  );
  const hash = createHash("sha256")
    .update(canonicalJSON({ baseRevision: revision, operations: [operation] }))
    .digest("hex");
  assert.equal(ledger[batch.batchId].identityHash, hash);
  const retry = (
    await run(["advanced", "apply", packagePath, "--batch", batchPath, "--json"])
  ).value;
  assert.equal(retry.alreadyApplied, true);
  assert.equal(retry.revision, first.revision);
  const view = (
    await run(["view", packagePath, "--component", "Button", "--json"])
  ).value;
  assert.equal(view.target.component, "Button");
  assert.equal(view.selection.componentId, undefined);
  assert.match(view.text, /COMPONENT 160×40/);
  const undo = JSON.parse(await readFile(first.inverseBatchPath, "utf8"));
  assert.ok(
    undo.operations.every(
      (operation) => !Object.hasOwn(operation, "componentSetId"),
    ),
  );
  await writeFile(batchPath, JSON.stringify(undo));
  await run(["advanced", "apply", packagePath, "--batch", batchPath, "--json"]);
  assert.equal(
    (await run(["project", "show", packagePath, "--json"])).value.revision,
    revision,
  );
});

test("old component fields are unknown input and leave the package unchanged", async (context) => {
  const { root, packagePath, revision } = await packageCopy(context);
  const batchPath = join(root, "old-field.json");
  for (const type of [
    "update-component-node",
    "delete-variant",
    "delete-component-set",
    "put-variant",
  ]) {
    for (const includeCanonical of [false, true]) {
      await writeFile(
        batchPath,
        JSON.stringify({
          baseRevision: revision,
          batchId: "old-field",
          operations: [
            {
              type,
              componentSetId: "cmp_button",
              ...(includeCanonical ? { componentId: "cmp_button" } : {}),
              ...(type === "update-component-node"
                ? {
                    variantId: "var_button_default",
                    nodeId: "node_button_root",
                    changes: { width: 160 },
                  }
                : {}),
              ...(type === "delete-variant"
                ? { variantId: "var_button_default" }
                : {}),
              ...(type === "put-variant"
                ? {
                    variant: {
                      id: "var_probe",
                      selection: {},
                      rootId: "node_root",
                      nodes: {
                        node_root: {
                          id: "node_root",
                          type: "FRAME",
                          children: [],
                          width: 160,
                          height: 40,
                        },
                      },
                    },
                  }
                : {}),
            },
          ],
        }),
      );
      const error = (
        await run(["advanced", "apply", packagePath, "--batch", batchPath, "--json"], 1)
      ).value.error;
      assert.equal(error.code, "unknown_operation_field");
      assert.equal(error.details.path, "operations[0].componentSetId");
      assert.equal(error.details.suggestion, "componentId");
      assert.equal(error.writeState, "not-applied");
      assert.equal(
        (await run(["project", "show", packagePath, "--json"])).value.revision,
        revision,
      );
    }
  }
});

test("retry identity uses the current contract without legacy ledger fallback", async (context) => {
  const { root, packagePath, revision } = await packageCopy(context);
  const batchPath = join(root, "ledger.json");
  const batch = {
    baseRevision: revision,
    batchId: "current-identity",
    operations: [
      {
        type: "update-component-node",
        componentId: "cmp_button",
        variantId: "var_button_default",
        nodeId: "node_button_root",
        changes: { width: 160 },
      },
    ],
  };
  await writeFile(batchPath, JSON.stringify(batch));
  await run(["advanced", "apply", packagePath, "--batch", batchPath, "--json"]);
  const ledgerPath = `${packagePath}.batches.json`;
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  delete ledger[batch.batchId].identityHash;
  await writeFile(ledgerPath, JSON.stringify(ledger));
  const error = (
    await run(["advanced", "apply", packagePath, "--batch", batchPath, "--json"], 1)
  ).value.error;
  assert.equal(error.code, "batch_id_conflict");
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
  await writeFile(
    `${packagePath}.batches.json`,
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
    (await run(["project", "show", packagePath, "--json"])).value.revision,
    revision,
  );
});

test("Token value errors identify the write input rather than an internal file path", async (context) => {
  const { root, packagePath, revision } = await packageCopy(context);
  const batchPath = join(root, "token.json");
  await writeFile(
    batchPath,
    JSON.stringify({
      baseRevision: revision,
      batchId: "missing-token-value",
      operations: [
        {
          type: "put-set-token",
          setId: "tset_base",
          token: { id: "tok_probe", name: "color.probe", type: "color" },
        },
      ],
    }),
  );
  const error = (
    await run(
      ["advanced", "apply", packagePath, "--batch", batchPath, "--dry-run", "--json"],
      1,
    )
  ).value.error;
  assert.equal(error.code, "invalid_token_value");
  assert.equal(error.details.path, "operations[0].token.value");
  assert.equal(error.details.received, null);
  assert.match(error.details.expected, /color/);
  assert.equal(error.writeState, "not-applied");
});

test("all commands have a small parameter contract and inherited names fail typed", async () => {
  const index = (await run(["schema", "commands", "--full", "--json"])).value;
  for (const { name } of index.commands) {
    const { value, bytes } = await run(["schema", "command", name, "--json"]);
    assert.equal(value.command, name);
    assert.ok(bytes < 16_384, `${name}: ${bytes} bytes`);
    if (value.actions) {
      for (const { action } of value.actions) {
        const detail = (
          await run(["schema", "command", name, action, "--json"])
        ).value;
        assert.ok(Object.keys(detail.parameters).length);
      }
      continue;
    }
    assert.ok(Object.keys(value.parameters).length);
    assert.ok(
      Object.values(value.parameters).every(
        (parameter) => !Object.hasOwn(parameter, "aliases"),
      ),
    );
  }
  const bad = (await run(["schema", "command", "__proto__", "--json"], 1)).value
    .error;
  assert.equal(bad.code, "unknown_schema_command");
  assert.ok(
    (await run(bad.details.nextOperations[0].argv)).value.commands.length,
  );
});

test("malformed JSON and repeated assignment keys fail before any workspace read", async () => {
  for (const [argv, code] of [
    [
      [
        "view",
        "/missing.smallpen",
        "--context",
        "axis_device=mobile",
        "--context",
        "axis_device=desktop",
      ],
      "duplicate_option",
    ],
    [
      ["project", "init", "/missing-workspace", "--answer", "projectKind={bad}"],
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

test("canonical component ids remain present in previews and Token reuse advice", async (context) => {
  const { root, packagePath, revision } = await packageCopy(context);
  const batchPath = join(root, "component-advice.json");
  await writeFile(
    batchPath,
    JSON.stringify({
      baseRevision: revision,
      batchId: "component-advice",
      operations: [
        {
          type: "update-component-node",
          componentId: "cmp_button",
          variantId: "var_button_default",
          nodeId: "node_button_root",
          changes: { fills: [{ type: "solid", color: "#6750a4" }] },
        },
      ],
    }),
  );
  const result = (
    await run([
      "advanced",
      "apply",
      packagePath,
      "--batch",
      batchPath,
      "--explain",
      "--json",
    ])
  ).value;
  assert.equal(result.explain[0].target.componentId, "cmp_button");
  assert.ok(
    result.warnings.length,
    "same Token reuse advice must survive the target rename",
  );
});

test("command schemas describe search requirements and conditional option combinations", async () => {
  const schema = async (name) =>
    (await run(["schema", "command", name, "--json"])).value;
  const components = await schema("search-components");
  assert.equal(components.parameters.query.required, true);
  assert.equal(components.parameters.query.nonBlank, true);
  assert.equal(components.parameters.query.default, undefined);
  assert.equal(components.parameters.limit.minimum, 1);
  const tokens = await schema("search-tokens");
  assert.deepEqual(tokens.atLeastOne, [["query", "type", "value", "color"]]);
  assert.equal(tokens.parameters.query.nonBlank, true);
  assert.equal(tokens.parameters.limit.minimum, 1);
  assert.ok(tokens.parameters.type.values.includes("color"));
  assert.ok(
    tokens.conflictsWith.some((fields) => fields.join() === "color,value"),
  );
  assert.ok(
    tokens.conflictsWith.some((fields) => fields.join() === "allThemes,theme"),
  );
  assert.deepEqual(tokens.parameters.type.valuesWhen, [
    { when: ["color"], values: ["color"] },
  ]);
  for (const command of ["effective-token", "explain-token", "impact"]) {
    assert.equal((await schema(command)).parameters.path.required, true);
  }
  for (const command of ["view", "export"]) {
    assert.equal((await schema(command)).parameters.scale.maximum, 8);
  }
  const repair = await schema("repair");
  assert.ok(
    repair.requires.some(
      ({ field, when }) =>
        field === "foundation" && when.action === "choose-foundation",
    ),
  );
  assert.deepEqual(repair.parameters.assetKind.valuesWhen, [
    {
      when: { action: "recreate-product-asset" },
      values: ["token", "component"],
    },
  ]);
});

test("command-specific constraints fail with recovery facts before opening a package", async () => {
  for (const [command, options, code, field] of [
    [["component", "search"], [], "missing_component_search", "query"],
    [
      ["component", "search"],
      ["--query", "   "],
      "missing_component_search",
      "query",
    ],
    [
      ["component", "search"],
      ["--query", "button", "--limit", "0"],
      "invalid_component_search_limit",
      "limit",
    ],
    [["token", "search"], [], "missing_token_search", "query"],
    [["token", "search"], ["--query", ""], "missing_token_search", "query"],
    [["token", "search"], ["--query", "   "], "missing_token_search", "query"],
    [
      ["token", "search"],
      ["--query", "color", "--limit", "0"],
      "invalid_token_search_limit",
      "limit",
    ],
    [
      ["token", "search"],
      ["--color", "#ffffff", "--value", "16"],
      "ambiguous_token_search_value",
      "color",
    ],
    [
      ["token", "search"],
      ["--query", "color", "--all-themes", "--theme", "Theme/Dark"],
      "conflicting_theme_options",
      "allThemes",
    ],
    [
      ["token", "search"],
      ["--color", "#ffffff", "--type", "spacing"],
      "conflicting_token_search_type",
      "type",
    ],
    [["token", "search"], ["--type", "invalid"], "invalid_token_type", "type"],
    [["advanced", "apply"], ["--batch", ""], "missing_batch", "batch"],
    [["media", "import"], ["--file", ""], "missing_media_file", "file"],
    [["token", "show"], [], "missing_token_path", "path"],
    [["token", "explain"], [], "missing_token_path", "path"],
    [["token", "impact"], [], "missing_token_path", "path"],
    [["view"], ["--scale", "9"], "invalid_render_scale", "scale"],
    [["export"], ["--scale", "9"], "invalid_render_scale", "scale"],
    [
      ["project", "repair"],
      ["--action", "retarget-reference"],
      "missing_repair_replacement",
      "replacementPackageId",
    ],
    [
      ["project", "repair"],
      [
        "--action",
        "retarget-reference",
        "--replacement-package-id",
        "pkg_acme",
      ],
      "missing_repair_replacement",
      "replacementAssetId",
    ],
    [
      ["project", "repair"],
      ["--action", "choose-foundation"],
      "missing_foundation_path",
      "foundation",
    ],
    [
      ["project", "repair"],
      ["--action", "recreate-product-asset", "--asset-kind", "token"],
      "missing_recreated_asset",
      "asset",
    ],
    [
      ["project", "repair"],
      ["--action", "recreate-product-asset", "--asset", "asset.json"],
      "missing_recreated_asset",
      "assetKind",
    ],
    [
      ["project", "repair"],
      [
        "--action",
        "recreate-product-asset",
        "--asset",
        "asset.json",
        "--asset-kind",
        "invalid",
      ],
      "missing_recreated_asset",
      "assetKind",
    ],
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

test("search limits and zero-item pagination retain their distinct valid behavior", async () => {
  const list = (
    await run([
      "project",
      "list",
      fixture,
      "--kind",
      "components",
      "--limit",
      "0",
      "--json",
    ])
  ).value;
  assert.deepEqual(list.items, []);
  assert.equal(list.page.limit, 0);
  assert.ok(list.page.total > 0);
  const components = (
    await run([
      "component",
      "search",
      fixture,
      "--query",
      "button",
      "--limit",
      "1",
      "--json",
    ])
  ).value;
  assert.equal(components.items.length, 1);
  const tokens = (
    await run([
      "token",
      "search",
      fixture,
      "--color",
      "#6750a4",
      "--type",
      "color",
      "--limit",
      "1",
      "--json",
    ])
  ).value;
  assert.ok(tokens.items.length <= 1);
  for (const query of ["", "   "]) {
    const error = (
      await run(["token", "search", fixture, "--query", query, "--json"], 1)
    ).value.error;
    assert.equal(error.code, "missing_token_search");
    assert.equal(error.details.field, "query");
    assert.equal(error.details.received, query);
  }
});

test("missing positional paths use the same actionable parameter errors", async () => {
  for (const [command, code, field] of [
    [["view"], "missing_package", "package"],
    [["project", "init"], "missing_workspace", "workspace"],
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
