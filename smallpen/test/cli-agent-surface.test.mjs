import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { openPackage } from "@smallpen/local-package";

import { COMMAND_GROUPS } from "../apps/cli/bin/command-tree.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "apps", "cli", "bin", "smallpen.mjs");
const fixture = join(here, "fixtures", "roundtrip.smallpen");

function runCli(args, { cwd, env } = {}) {
  // These semantic checks request complete values; file transport has its own integration tests.
  if (args.includes("--full") && !args.includes("--stdout"))
    args = [...args, "--stdout"];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: env && { ...process.env, ...env },
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

// Replies leave out stored IDs unless the call passes --full; batchId stays.
function idKeys(value, path = "$") {
  if (Array.isArray(value))
    return value.flatMap((item, index) => idKeys(item, `${path}[${index}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => [
    ...(key !== "batchId" && (key === "id" || /(?:Id|Ids)$/.test(key))
      ? [`${path}.${key}`]
      : []),
    ...idKeys(item, `${path}.${key}`),
  ]);
}

function assertNoIds(value) {
  assert.deepEqual(idKeys(value), []);
}

function initializationAnswers() {
  return {
    audience: "Product team",
    contextAxes: [
      {
        defaultValue: "light",
        id: "axis_theme",
        kind: "theme",
        name: "Theme",
        values: ["light", "dark"],
      },
    ],
    firstJourney: "Activate account",
    firstOutput: "Reviewed home screen",
    firstScenario: "Default",
    firstScreen: "Home",
    foundationChoice: "create-new",
    initialComponents: ["Button"],
    initialTokens: ["color.brand", "spacing.md"],
    kindDetails: ["responsive", "local-first"],
    platforms: ["desktop", "mobile"],
    projectKind: "application",
    projectName: "Agent Surface",
    purpose: "Help users activate an account",
    sourceInputs: ["none"],
  };
}

function contextFile() {
  return {
    axes: [
      {
        defaultValue: "light",
        id: "axis_theme",
        kind: "theme",
        name: "Theme",
        values: [
          { id: "light", name: "Light" },
          { id: "dark", name: "Dark" },
        ],
      },
    ],
    profiles: [
      {
        default: true,
        id: "ctx_light",
        name: "Light",
        values: { axis_theme: "light" },
      },
      {
        default: false,
        id: "ctx_dark",
        name: "Dark",
        values: { axis_theme: "dark" },
      },
    ],
  };
}

function tokenOperation() {
  return {
    definition: {
      $extensions: {
        smallpen: { id: "tok_brand", visibility: "public" },
      },
      $type: "color",
      $value: "#6750a4",
    },
    filePath: "tokens/design.json",
    path: "color.brand",
    tokenId: "tok_brand",
    type: "put-token",
  };
}

function componentOperation() {
  return {
    componentSet: {
      axes: [
        {
          domain: ["idle"],
          id: "axis_state",
          name: "State",
          role: "state",
        },
      ],
      id: "cmp_button",
      name: "Button",
      variants: [
        {
          id: "var_button_idle",
          nodes: {
            node_button_source: {
              children: [],
              height: 40,
              id: "node_button_source",
              name: "Button",
              tokenBindings: {
                fill: { assetId: "tok_brand", packageId: "pkg_roundtrip" },
              },
              type: "COMPONENT",
              width: 120,
              x: 0,
              y: 0,
            },
          },
          rootId: "node_button_source",
          selection: { axis_state: "idle" },
        },
      ],
      visibility: "public",
    },
    type: "put-component-set",
  };
}

async function configuredCliPackage(context, operations = []) {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-cli-configured-"));
  context.after(() => rm(parent, { force: true, recursive: true }));
  const packagePath = join(parent, "configured.smallpen");
  await cp(fixture, packagePath, { recursive: true });
  if (operations.length === 0) return { packagePath, parent };

  const inspected = await runCli(["project", "show", packagePath, "--json"]);
  assert.equal(inspected.code, 0, inspected.stderr);
  const batchPath = join(parent, "setup-batch.json");
  await writeFile(
    batchPath,
    JSON.stringify({
      baseRevision: JSON.parse(inspected.stdout).revision,
      batchId: "batch_cli_configured_setup",
      operations,
    }),
  );
  const applied = await runCli([
    "advanced",
    "apply",
    packagePath,
    "--batch",
    batchPath,
    "--json",
  ]);
  assert.equal(applied.code, 0, `${applied.stderr}\n${applied.stdout}`);
  return { packagePath, parent };
}

async function initializedCliWorkspace(context) {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-cli-agent-"));
  context.after(() => rm(parent, { force: true, recursive: true }));
  const workspacePath = join(parent, "workspace");
  const answersPath = join(parent, "answers.json");
  const statePath = join(parent, "init-state.json");
  await writeFile(answersPath, JSON.stringify(initializationAnswers()));
  const result = await runCli([
    "project",
    "init",
    workspacePath,
    "--answers",
    answersPath,
    "--confirm",
    "--json",
  ]);
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  return { ...JSON.parse(result.stdout), answersPath, parent, statePath };
}

test("version is discoverable without a package and unknown commands give executable recovery", async () => {
  const metadata = JSON.parse(
    await readFile(join(here, "..", "apps", "cli", "package.json"), "utf8"),
  );
  const version = await runCli(["version"]);
  assert.equal(version.code, 0, version.stdout);
  assert.equal(version.stderr, "");
  assert.deepEqual(JSON.parse(version.stdout), {
    name: metadata.name,
    version: metadata.version,
  });
  const json = await runCli(["version", "--json"]);
  assert.equal(json.code, 0, json.stdout);
  assert.deepEqual(JSON.parse(json.stdout), {
    name: metadata.name,
    version: metadata.version,
  });
  const invalid = await runCli(["nonexistent-command"]);
  assert.equal(invalid.code, 1);
  const recovery = JSON.parse(invalid.stdout).error.details.nextOperations[0];
  assert.equal(recovery.operation, "smallpen.schema");
  assert.deepEqual(recovery.argv, ["schema", "commands", "--json"]);
  assert.equal((await runCli(recovery.argv)).code, 0);
});

test("root and every public command provide standalone help", async () => {
  const root = await runCli(["--help", "--full"]);
  assert.equal(root.code, 0, root.stderr);
  assert.match(
    root.stdout,
    /One \.smallpen directory is one Canonical Package/,
  );
  assert.match(
    root.stdout,
    /there is no current\s+selection, current page, or cross-call session state/,
  );
  assert.match(root.stdout, /smallpen help rules/);
  assert.match(root.stdout, /project\s+Create, inspect/);
  assert.match(root.stdout, /view\s+Look at anything by name/);
  assert.match(root.stdout, /validate\s+Validate canonical data/);
  assert.match(root.stdout, /export\s+Export a page, component/);
  for (const command of [
    "help",
    "view",
    "export",
    "version",
    "validate",
    "changes",
  ]) {
    const result = await runCli([command, "--help"]);
    assert.equal(result.code, 0, `${command}: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(`SmallPen ${command}`));
    assert.match(result.stdout, /Usage:/);
  }
  for (const [group, { actions }] of Object.entries(COMMAND_GROUPS)) {
    for (const command of [[group], ...Object.keys(actions).map((a) => [group, a])]) {
      const name = command.join(" ");
      const result = await runCli([...command, "--help"]);
      assert.equal(result.code, 0, `${name}: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`SmallPen ${name}\n`), name);
      assert.match(result.stdout, /Usage:/, name);
    }
  }

  // Engine names no longer run; each failure names its grouped path.
  for (const [command, suggestion] of [
    ["themes", "token theme list"],
    ["init", "project init"],
    ["inspect", "project show"],
    ["list", "project list"],
    ["catalog", "component list"],
    ["search-components", "component search"],
    ["tokens", "token list"],
    ["search-tokens", "token search"],
    ["effective-token", "token show"],
    ["explain-token", "token explain"],
    ["import-draft", "advanced import-draft"],
    ["draft-diff", "advanced draft-diff"],
    ["draft-compile", "advanced draft-compile"],
    ["impact", "token impact"],
    ["apply", "advanced apply"],
    ["repair", "project repair"],
  ]) {
    const result = await runCli([command, "--help"]);
    assert.equal(result.code, 1, command);
    const { error } = JSON.parse(result.stdout);
    assert.equal(error.code, "unknown_command", command);
    assert.equal(error.details.suggestion, suggestion, command);
  }

  for (const removed of [
    "read",
    "read-view",
    "inspect-view",
    "render",
    "render-matrix",
    "evidence",
    "compare",
    "discover",
  ]) {
    const result = await runCli([removed, "--help"]);
    assert.equal(result.code, 1, removed);
    assert.equal(JSON.parse(result.stdout).error.code, "unknown_command");
  }

  const view = await runCli(["view", "--help", "--full"]);
  assert.equal(view.code, 0, view.stderr);
  assert.match(view.stdout, /Look at anything by name; no IDs/);
  assert.match(view.stdout, /--as text\|wireframe\|png\|issues/);
  assert.match(view.stdout, /wireframe is a text drawing of regions/);
  assert.match(view.stdout, /issues lists layout,\s+text and contrast problems/);

  const exported = await runCli(["export", "--help", "--full"]);
  assert.equal(exported.code, 0, exported.stderr);
  assert.match(exported.stdout, /--format text\|wireframe\|png/);
  assert.match(exported.stdout, /--evidence adds review evidence/);
});

test("view help names every name-based selector and no ID selector", async () => {
  const result = await runCli(["view", "--help", "--full"]);
  assert.equal(result.code, 0);
  for (const option of [
    "--page",
    "--platform",
    "--element",
    "--component",
    "--variant",
    "--token",
    "--tokens",
    "--components",
    "--pages",
    "--canvas",
    "--as",
    "--theme",
    "--context",
    "--scale",
    "--locale",
  ]) {
    assert.match(result.stdout, new RegExp(`${option}\\s`), option);
  }
  for (const removed of [
    "--format",
    "--selector",
    "--screen-id",
    "--presentation-id",
    "--component-id",
    "--variant-id",
    "--node-id",
    "--package-id",
    "--scenario-id",
    "--context-profile-id",
  ]) {
    assert.doesNotMatch(result.stdout, new RegExp(`${removed}\\s`), removed);
  }
});

test("import-tokens help explains explicit dry-run precedence", async () => {
  const result = await runCli(["token", "import", "--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /--dry-run/);
  assert.match(
    result.stdout,
    /--dry-run takes precedence over --apply and never commits/,
  );
});

test("project creation preserves spaces in paths and does not write question state", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-cli-path-"));
  context.after(() => rm(parent, { force: true, recursive: true }));
  const path = join(parent, "workspace with spaces");
  const result = await runCli([
    "project",
    "init",
    path,
    "--name",
    "My App",
    "--json",
  ]);
  assert.equal(result.code, 0, result.stdout);
  const created = JSON.parse(result.stdout);
  assert.equal(
    created.packagePath,
    join(path, "my-app.smallpen"),
  );
  assert.equal(created.statePath, undefined);
  assert.equal(created.nextQuestion, undefined);
});

test("apply returns Design Token warnings for hard-coded style values", async (context) => {
  const { packagePath, parent } = await configuredCliPackage(context, [
    tokenOperation(),
  ]);
  const inspected = await runCli(["project", "show", packagePath, "--full", "--json"]);
  assert.equal(inspected.code, 0, inspected.stderr);
  assert.deepEqual(
    JSON.parse(inspected.stdout).guidance.beforeDesigning.map(
      ({ operation }) => operation,
    ),
    ["smallpen.search-components", "smallpen.search-tokens"],
  );
  const batchPath = join(parent, "hard-coded-color.json");
  await writeFile(
    batchPath,
    JSON.stringify({
      baseRevision: JSON.parse(inspected.stdout).revision,
      batchId: "batch_cli_hard_coded_color",
      operations: [
        {
          changes: { fills: [{ color: "#6750a4", type: "solid" }] },
          nodeId: "node_rectangle",
          presentationId: "pres_desktop",
          screenId: "scr_roundtrip",
          type: "update-presentation-node",
        },
      ],
    }),
  );

  const applied = await runCli([
    "advanced",
    "apply",
    packagePath,
    "--batch",
    batchPath,
    "--json",
  ]);
  assert.equal(applied.code, 0, `${applied.stderr}\n${applied.stdout}`);
  const result = JSON.parse(applied.stdout);
  assert.equal(result.warnings[0].code, "design_token_not_used");
  assert.equal(result.warnings[0].suggestions[0].path, "color.brand");
  assert.equal(result.warnings[0].suggestions[0].exactValue, true);
  assert.deepEqual(result.warnings[0].recommendedBinding, {
    field: "fills.0",
    token: "color.brand",
    reference: { assetId: "tok_brand", packageId: "pkg_roundtrip" },
  });

  const after = await runCli(["project", "show", packagePath, "--full", "--json"]);
  const unmatchedPath = join(parent, "unmatched-color.json");
  await writeFile(
    unmatchedPath,
    JSON.stringify({
      baseRevision: JSON.parse(after.stdout).revision,
      batchId: "batch_cli_unmatched_color",
      operations: [
        {
          changes: { fills: [{ color: "#123456", type: "solid" }] },
          nodeId: "node_rectangle",
          presentationId: "pres_desktop",
          screenId: "scr_roundtrip",
          type: "update-presentation-node",
        },
      ],
    }),
  );
  const unmatched = await runCli([
    "advanced",
    "apply",
    packagePath,
    "--batch",
    unmatchedPath,
    "--json",
  ]);
  assert.equal(unmatched.code, 0, unmatched.stderr);
  const unmatchedResult = JSON.parse(unmatched.stdout);
  const unmatchedWarning = unmatchedResult.warnings[0];
  assert.equal(unmatchedWarning.code, "design_token_value_unmatched");
  assert.equal(unmatchedWarning.valueSource, "raw-unbound");
  assert.equal(unmatchedResult.warningSummary.contextScope.mode, "all");
});

test("bulk write warnings are compact, actionable-first, and losslessly expandable", async (context) => {
  const { packagePath, parent } = await configuredCliPackage(context, [
    tokenOperation(),
  ]);
  const inspected = await runCli(["project", "show", packagePath, "--json"]);
  const revision = JSON.parse(inspected.stdout).revision;
  const batchPath = join(parent, "bulk-warning-batch.json");
  await writeFile(
    batchPath,
    JSON.stringify({
      baseRevision: revision,
      batchId: "batch_bulk_warning_output",
      operations: Array.from({ length: 12 }, (_, index) => ({
        type: "add-presentation-node",
        screenId: "scr_roundtrip",
        presentationId: "pres_desktop",
        parentId: "node_canvas",
        node: {
          id: `node_bulk_${index}`,
          type: "RECTANGLE",
          name: `Repeated card ${index}`,
          children: [],
          x: index * 10,
          y: 10,
          width: 70 + index,
          height: 40,
          fills: [{ type: "solid", color: "#6750a4" }],
        },
      })),
    }),
  );
  const base = [
    "advanced",
    "apply",
    packagePath,
    "--batch",
    batchPath,
    "--dry-run",
    "--json",
  ];
  const compactRead = await runCli(base);
  assert.equal(compactRead.code, 0, compactRead.stdout);
  const compact = JSON.parse(compactRead.stdout);
  assert.equal(compact.warningSummary?.detail, "compact");
  // Raw width/height with no near sizing Token are counted, not listed.
  assert.equal(compact.warningSummary.total, 12);
  assert.deepEqual(compact.warningSummary.suppressed.fields, {
    height: 12,
    width: 12,
  });
  assert.equal(compact.warnings[0].code, "design_token_not_used");
  assert.equal(compact.warnings[0].count, 12);
  const fullRead = await runCli([
    ...base,
    "--warning-detail",
    "full",
    "--stdout",
  ]);
  assert.equal(fullRead.code, 0, fullRead.stdout);
  const full = JSON.parse(fullRead.stdout);
  assert.equal(full.warningSummary.detail, "full");
  const expanded = compact.warnings
    .flatMap(({ count, locations, ...details }) => {
      assert.equal(count, locations.length);
      return locations.map(({ warningIndex, ...location }) => ({
        warningIndex,
        warning: {
          ...details,
          ...location,
          contextScope: compact.warningSummary.contextScope,
        },
      }));
    })
    .sort((left, right) => left.warningIndex - right.warningIndex);
  assert.deepEqual(
    expanded.map(({ warningIndex }) => warningIndex),
    Array.from({ length: 12 }, (_, index) => index),
  );
  assert.deepEqual(
    expanded.map(({ warning }) => warning),
    full.warnings,
  );
  assert.ok(
    JSON.stringify({
      warnings: compact.warnings,
      warningSummary: compact.warningSummary,
    }).length <
      JSON.stringify(full.warnings).length * 0.65,
  );
  const invalid = await runCli([...base, "--warning-detail", "none"]);
  assert.equal(invalid.code, 1);
  assert.equal(JSON.parse(invalid.stdout).error.code, "invalid_warning_detail");
  const after = await runCli(["project", "show", packagePath, "--json"]);
  assert.equal(JSON.parse(after.stdout).revision, revision);
});

test("search-tokens rejects a type that conflicts with --color", async (context) => {
  const { packagePath } = await configuredCliPackage(context, [
    tokenOperation(),
  ]);
  const result = await runCli([
    "token",
    "search",
    packagePath,
    "--color",
    "#6750a4",
    "--type",
    "spacing",
    "--json",
  ]);
  assert.equal(result.code, 1);
  assert.equal(
    JSON.parse(result.stdout).error.code,
    "conflicting_token_search_type",
  );
});

test("init ignores an implicit stale state file", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-cli-stale-init-"));
  context.after(() => rm(parent, { force: true, recursive: true }));
  const workspacePath = join(parent, "workspace");
  await writeFile(
    `${workspacePath}.smallpen-init.json`,
    JSON.stringify({ answers: initializationAnswers(), status: "proposal" }),
  );

  const result = await runCli(["project", "init", workspacePath, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const state = JSON.parse(result.stdout);
  assert.equal(state.status, "initialized");
  assert.equal(state.nextQuestion, undefined);
  assert.deepEqual(
    JSON.parse(await readFile(`${workspacePath}.smallpen-init.json`, "utf8"))
      .answers,
    initializationAnswers(),
  );
});

test("view shows one Component Set by name and rejects unknown names", async (context) => {
  const { packagePath } = await configuredCliPackage(context, [
    tokenOperation(),
    componentOperation(),
  ]);

  const inspected = await runCli([
    "view",
    packagePath,
    "--component",
    "Button",
    "--json",
  ]);
  assert.equal(inspected.code, 0, inspected.stderr);
  const result = JSON.parse(inspected.stdout);
  assert.deepEqual(result.target, { component: "Button", variants: 1 });
  assertNoIds(result);
  assert.equal(result.revision, result.productRevision);
  assert.equal(result.component.name, "Button");
  assert.equal(result.component.variantCount, 1);
  assert.equal(result.component.axes[0].name, "State");
  assert.deepEqual(result.component.axes[0].values, ["idle"]);
  assert.deepEqual(result.component.mainVariant, {
    selection: ["State=idle"],
  });
  assert.deepEqual(result.tokenSources, [
    { path: "color.brand", value: "#6750a4" },
  ]);

  // --full keeps the stored IDs and binding references.
  const fullRead = await runCli([
    "view",
    packagePath,
    "--component",
    "Button",
    "--full",
    "--json",
  ]);
  assert.equal(fullRead.code, 0, fullRead.stderr);
  const full = JSON.parse(fullRead.stdout);
  assert.equal(full.component.id, "cmp_button");
  assert.deepEqual(full.component.mainVariant, {
    id: "var_button_idle",
    selection: ["State=idle"],
  });
  assert.deepEqual(full.component.tokenBindings, [
    { assetId: "tok_brand", packageId: "pkg_roundtrip", path: "color.brand" },
  ]);

  const searched = await runCli([
    "component",
    "search",
    packagePath,
    "--query",
    "button",
    "--json",
  ]);
  assert.equal(searched.code, 0, searched.stderr);
  const searchResult = JSON.parse(searched.stdout);
  assertNoIds(searchResult);
  const [item] = searchResult.items;
  assert.equal(item.name, "Button");
  assert.deepEqual(item.variants, ["State=idle"]);
  assert.deepEqual(item.recommendedInsertion.element, {
    use: "Button",
    props: { State: "idle" },
  });
  assert.deepEqual(item.recommendedInsertion.nextOperations[0].argv, [
    "schema",
    "page-draw",
    "--json",
  ]);
  const next = item.nextOperations[0];
  assert.deepEqual(next.argv.slice(2), ["--component", "Button", "--json"]);
  assert.equal(next.argv[0], "view");
  assert.equal(await realpath(next.argv[1]), await realpath(packagePath));
  const detail = await runCli(next.argv);
  assert.equal(detail.code, 0, detail.stdout);
  assert.equal(JSON.parse(detail.stdout).component.name, "Button");

  const unknown = await runCli([
    "view",
    packagePath,
    "--component",
    "Missing",
    "--json",
  ]);
  assert.equal(unknown.code, 1);
  const error = JSON.parse(unknown.stdout).error;
  assert.equal(error.code, "unknown_component");
  assert.deepEqual(error.details.components, ["Button"]);
});

test("malformed package JSON names its file and gives a safe validation continuation", async (context) => {
  const { packagePath, parent } = await configuredCliPackage(context);
  const canonicalPath = await realpath(packagePath);
  const alias = join(parent, "linked-owner.smallpen");
  await symlink(packagePath, alias, "dir");
  const before = JSON.parse(
    (await runCli(["project", "show", packagePath, "--json"])).stdout,
  ).revision;

  for (const entry of ["screens/roundtrip.json", "manifest.json"]) {
    const file = join(packagePath, entry);
    const original = await readFile(file);
    const invalid = '{"unfinished":';
    await writeFile(file, invalid);

    const failed = await runCli(["view", alias, "--json"]);
    assert.equal(failed.code, 1);
    assert.equal(failed.stderr, "");
    const error = JSON.parse(failed.stdout).error;
    const code =
      entry === "manifest.json"
        ? "invalid_manifest_json"
        : "invalid_entry_json";
    assert.equal(error.code, code);
    assert.equal(error.details.packagePath, canonicalPath);
    assert.equal(error.details.entryPath, join(canonicalPath, entry));
    assert.match(error.details.recovery, /restore/i);
    const next = error.details.nextOperations[0];
    assert.equal(next.when, "after-restoring-valid-json");
    assert.deepEqual(next.argv, ["validate", canonicalPath, "--json"]);

    const stillInvalid = await runCli(next.argv);
    assert.equal(stillInvalid.code, 1);
    assert.equal(JSON.parse(stillInvalid.stdout).error.code, code);
    assert.equal(await readFile(file, "utf8"), invalid);

    await writeFile(file, original);
    const valid = await runCli(next.argv);
    assert.equal(valid.code, 0, valid.stdout);
    assert.equal(JSON.parse(valid.stdout).revision, before);
  }
});

test("component search includes linked Libraries and executable owner-scoped detail commands", async (context) => {
  const initialized = await initializedCliWorkspace(context);
  const libraryPath = join(
    dirname(initialized.productPath),
    "Team's UI library.smallpen",
  );
  await cp(fixture, libraryPath, { recursive: true });
  const libraryManifestPath = join(libraryPath, "manifest.json");
  const libraryManifest = JSON.parse(
    await readFile(libraryManifestPath, "utf8"),
  );
  libraryManifest.packageId = "pkg_ui_library";
  await writeFile(libraryManifestPath, JSON.stringify(libraryManifest));

  for (const [packagePath, id] of [
    [initialized.foundationPath, "cmp_foundation_button"],
    [libraryPath, "cmp_library_button"],
  ]) {
    const operation = componentOperation();
    operation.componentSet.id = id;
    // Names do not repeat within a package.
    operation.componentSet.name = id === "cmp_foundation_button" ? "Foundation button" : "Library button";
    delete operation.componentSet.variants[0].nodes.node_button_source
      .tokenBindings;
    const inspected = await runCli(["project", "show", packagePath, "--json"]);
    assert.equal(inspected.code, 0, inspected.stdout);
    const batchPath = join(initialized.parent, `${id}.json`);
    await writeFile(
      batchPath,
      JSON.stringify({
        baseRevision: JSON.parse(inspected.stdout).revision,
        batchId: `batch_${id}`,
        operations: [operation],
      }),
    );
    const applied = await runCli([
      "advanced",
      "apply",
      packagePath,
      "--batch",
      batchPath,
      "--json",
    ]);
    assert.equal(applied.code, 0, applied.stdout);
  }

  const manifestPath = join(initialized.productPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.libraries = [
    {
      packageId: "pkg_ui_library",
      source: { path: "Team's UI library.smallpen", type: "local" },
    },
  ];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const searched = await runCli([
    "component",
    "search",
    initialized.productPath,
    "--query",
    "button",
    "--json",
  ]);
  assert.equal(searched.code, 0, searched.stdout);
  const result = JSON.parse(searched.stdout);
  assertNoIds(result);
  assert.deepEqual(result.items.map(({ name }) => name).sort(), [
    "Button",
    "Foundation button",
    "Library button",
  ]);
  // The next read names the searched package: view resolves its Foundation
  // and Libraries, whoever owns the component.
  for (const item of result.items) {
    const next = item.nextOperations[0];
    assert.deepEqual(next.argv, [
      "view",
      resolvePath(initialized.productPath),
      "--component",
      item.name,
      "--json",
    ]);
    const detail = await runCli(next.argv);
    assert.equal(detail.code, 0, detail.stdout);
    assert.equal(JSON.parse(detail.stdout).target.component, item.name);
    assert.ok(next.command.startsWith("smallpen view "));
  }
});

test("CLI discovery includes a Penpot located Component shown by Web Assets", async (context) => {
  const parent = await mkdtemp(
    join(tmpdir(), "smallpen-cli-located-component-"),
  );
  context.after(() => rm(parent, { force: true, recursive: true }));
  const packagePath = join(parent, "located.smallpen");
  await cp(fixture, packagePath, { recursive: true });

  const manifestPath = join(packagePath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.entries.components = ["components/button.json"];
  await writeFile(manifestPath, JSON.stringify(manifest));

  const screenPath = join(packagePath, "screens", "roundtrip.json");
  const screen = JSON.parse(await readFile(screenPath, "utf8"));
  const main = screen.presentations[0].nodes.node_rectangle;
  main.componentId = "cmp_button_located";
  main.type = "COMPONENT";
  await writeFile(screenPath, JSON.stringify(screen));

  await mkdir(join(packagePath, "components"));
  await writeFile(
    join(packagePath, "components", "button.json"),
    JSON.stringify({
      id: "cmp_button_located",
      mainNodeId: "node_rectangle",
      name: "Button / Located",
      path: "Controls",
      presentationId: "pres_desktop",
      screenId: "scr_roundtrip",
    }),
  );

  const inspected = await runCli(["project", "show", packagePath, "--full", "--json"]);
  assert.equal(inspected.code, 0, inspected.stderr);
  assert.deepEqual(
    JSON.parse(inspected.stdout).components.map(({ id }) => id),
    ["cmp_button_located"],
  );

  const listed = await runCli([
    "project",
    "list",
    packagePath,
    "--kind",
    "components",
    "--json",
  ]);
  assert.equal(listed.code, 0, listed.stderr);
  assertNoIds(JSON.parse(listed.stdout));
  assert.deepEqual(
    JSON.parse(listed.stdout).items.map(({ item }) => item.name),
    ["Button / Located"],
  );

  const catalog = await runCli(["component", "list", packagePath, "--full", "--json"]);
  assert.equal(catalog.code, 0, catalog.stderr);
  assert.deepEqual(
    JSON.parse(catalog.stdout).components.map(({ id }) => id),
    ["cmp_button_located"],
  );

  const searched = await runCli([
    "component",
    "search",
    packagePath,
    "--query",
    "located",
    "--json",
  ]);
  assert.equal(searched.code, 0, searched.stderr);
  const items = JSON.parse(searched.stdout).items;
  assertNoIds(items);
  assert.deepEqual(
    items.map(({ name }) => name),
    ["Button / Located"],
  );

  // The detail command search hands out must work for this Component.
  const next = items[0].nextOperations[0];
  assert.deepEqual(next.argv.slice(2), [
    "--component",
    "Button / Located",
    "--json",
  ]);
  const component = await runCli(next.argv);
  assert.equal(component.code, 0, component.stdout);
  const shown = JSON.parse(component.stdout);
  assert.equal(shown.target.component, "Button / Located");
  assert.equal(shown.target.page, "Round Trip");

  const viewed = await runCli(["view", packagePath, "--components", "--json"]);
  assert.equal(viewed.code, 0, viewed.stderr);
  assert.match(JSON.parse(viewed.stdout).text, /Button \/ Located/);
});

test("an external Agent can initialize, inspect, view and export by name using only public CLI", async (context) => {
  const initialized = await initializedCliWorkspace(context);
  assert.equal(initialized.status, "initialized");
  assert.equal(initialized.nextQuestion, undefined);

  const validate = await runCli([
    "validate",
    initialized.productPath,
    "--json",
  ]);
  assert.equal(validate.code, 0, validate.stderr);
  assert.equal(JSON.parse(validate.stdout).status, "valid");

  const inspect = await runCli(["project", "show", initialized.productPath, "--json"]);
  assert.equal(inspect.code, 0, inspect.stderr);
  const inspected = JSON.parse(inspect.stdout);
  assert.equal(inspected.role, "product");
  assertNoIds(inspected);
  assert.equal(inspected.counts.pages, 1);
  const stored = await openPackage(initialized.productPath);
  assert.equal(stored.manifest.defaultScreenId, "scr_home");

  const list = await runCli([
    "project",
    "list",
    initialized.productPath,
    "--kind",
    "requirements",
    "--json",
  ]);
  assert.equal(list.code, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout).page.total, 1);

  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
  const looked = await runCli([
    "view",
    initialized.productPath,
    "--page",
    "Home",
    "--as",
    "png",
    "--json",
  ]);
  assert.equal(looked.code, 0, looked.stderr);
  const lookedImage = JSON.parse(looked.stdout);
  assert.deepEqual(lookedImage.target, { page: "Home", platform: "desktop" });
  assert.equal(lookedImage.mimeType, "image/png");
  assertNoIds(lookedImage);
  assert.deepEqual(
    [...new Uint8Array(await readFile(lookedImage.output)).slice(0, 8)],
    pngSignature,
  );

  const wireframe = await runCli([
    "view",
    initialized.productPath,
    "--page",
    "Home",
    "--as",
    "wireframe",
    "--json",
  ]);
  assert.equal(wireframe.code, 0, wireframe.stderr);
  assert.match(JSON.parse(wireframe.stdout).wireframe, /^ASCII WIREFRAME\n/);

  const renderPath = join(initialized.parent, "home.png");
  const render = await runCli([
    "export",
    initialized.productPath,
    "--page",
    "Home",
    "--format",
    "png",
    "--output",
    renderPath,
    "--json",
  ]);
  assert.equal(render.code, 0, render.stderr);
  const rendered = JSON.parse(render.stdout);
  assert.equal(rendered.mimeType, "image/png");
  assert.equal(await realpath(rendered.output), await realpath(renderPath));
  assert.equal(rendered.renderHash, lookedImage.renderHash);
  assert.ok((await stat(renderPath)).size > 100);
  assert.deepEqual(
    [...new Uint8Array(await readFile(renderPath)).slice(0, 8)],
    pngSignature,
  );

  const validatedPage = await runCli([
    "validate",
    initialized.productPath,
    "--page",
    "Home",
    "--json",
  ]);
  assert.equal(validatedPage.code, 0, validatedPage.stderr);
  const pageCheck = JSON.parse(validatedPage.stdout);
  assert.equal(pageCheck.status, "valid");
  assertNoIds(pageCheck);
  const validatedFull = await runCli([
    "validate",
    initialized.productPath,
    "--page",
    "Home",
    "--full",
    "--json",
  ]);
  assert.equal(validatedFull.code, 0, validatedFull.stderr);
  assert.equal(JSON.parse(validatedFull.stdout).selection.screenId, "scr_home");
});

test("export --evidence writes a page PNG and its review evidence by name", async (context) => {
  const initialized = await initializedCliWorkspace(context);
  const render = await runCli([
    "export",
    initialized.productPath,
    "--page",
    "Home",
    "--format",
    "png",
    "--output",
    join(initialized.parent, "home.png"),
    "--json",
  ]);
  assert.equal(render.code, 0, render.stderr);
  const rendered = JSON.parse(render.stdout);

  const prefix = join(initialized.parent, "review");
  const evidence = await runCli([
    "export",
    initialized.productPath,
    "--page",
    "Home",
    "--format",
    "png",
    "--evidence",
    "--output",
    prefix,
    "--json",
  ]);
  assert.equal(evidence.code, 0, evidence.stdout);
  const bundle = JSON.parse(evidence.stdout);
  assert.equal(bundle.renderHash, rendered.renderHash);
  assert.equal(
    JSON.parse(await readFile(`${prefix}.json`, "utf8")).renderHash,
    rendered.renderHash,
  );
  assert.ok((await stat(`${prefix}.png`)).size > 100);
});

async function imageDeliveryTree(directory) {
  const result = {};
  for (const entry of (await readdir(directory, { recursive: true })).sort()) {
    const path = join(directory, entry);
    result[entry] = (await stat(path)).isDirectory()
      ? null
      : createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
  }
  return result;
}

// export names its inline bytes imageBase64; the evidence bundle nests an
// image whose bytes are base64.
function assertInlineImage(image, revision) {
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.revision, revision);
  assert.equal(image.productRevision, revision);
  assertNoIds(image);
  const encoded = image.imageBase64 ?? image.base64;
  assert.match(encoded, /^[A-Za-z0-9+/]+={0,2}$/, "inline bytes are base64");
  const bytes = Buffer.from(encoded, "base64");
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    image.renderHash,
  );
  assert.equal(bytes.readUInt32BE(16), image.width);
  assert.equal(bytes.readUInt32BE(20), image.height);
}

const withoutOutput = ({ output: _output, outputBytes: _bytes, ...rest }) =>
  rest;

for (const [label, extra] of [
  ["export --format png", []],
  ["export --format png --evidence", ["--evidence"]],
]) {
  test(`${label} --base64 delivers fresh inline images without touching the working folder`, async (context) => {
    const { packagePath, parent } = await configuredCliPackage(context);
    for (const name of [
      "smallpen.png",
      "smallpen-view.png",
      "smallpen-evidence.png",
      "smallpen-evidence.json",
    ]) {
      await writeFile(
        join(parent, name),
        "stale image sentinel: never consume or replace",
      );
    }
    const inspected = JSON.parse(
      (await runCli(["project", "show", packagePath, "--json"])).stdout,
    );
    const before = await imageDeliveryTree(parent);
    const results = await Promise.all(
      [1, 0.5].map((scale) =>
        runCli(
          [
            "export",
            packagePath,
            "--page",
            "Round Trip",
            "--format",
            "png",
            ...extra,
            "--base64",
            "--scale",
            String(scale),
            "--json",
          ],
          { cwd: parent },
        ),
      ),
    );
    const images = [];
    for (const result of results) {
      assert.equal(result.code, 0, result.stdout);
      assert.equal(result.stderr, "");
      const value = JSON.parse(result.stdout);
      assertNoIds(value);
      assert.equal(value.imagePath, undefined);
      assert.equal(value.evidencePath, undefined);
      const image = value.image ?? value;
      assertInlineImage(image, inspected.revision);
      images.push(image);
    }
    assert.equal(images[0].width, images[1].width * 2);
    assert.notEqual(images[0].renderHash, images[1].renderHash);
    assert.deepEqual(await imageDeliveryTree(parent), before);

    const beforeFailure = await imageDeliveryTree(parent);
    const failed = await runCli(
      [
        "export",
        packagePath,
        "--page",
        "Missing page",
        "--format",
        "png",
        ...extra,
        "--base64",
        "--json",
      ],
      { cwd: parent },
    );
    assert.equal(failed.code, 1);
    assert.equal(failed.stderr, "");
    const { error, ...rest } = JSON.parse(failed.stdout);
    assert.equal(error.code, "unknown_page");
    assert.deepEqual(error.details.pages, ["Round Trip"]);
    assert.deepEqual(Object.keys(withoutOutput(rest)), []);
    assert.doesNotMatch(
      failed.stdout,
      /"(?:base64|imageBase64|output|imagePath|evidencePath)"/,
    );
    assert.deepEqual(await imageDeliveryTree(parent), beforeFailure);
  });
}

test("cold inline image delivery retains only the reusable empty package lock directory", async (context) => {
  const { packagePath, parent } = await configuredCliPackage(context);
  const before = await imageDeliveryTree(parent);
  const args = ["export", packagePath, "--format", "png", "--base64", "--json"];
  const result = await runCli(args, { cwd: parent });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.stderr, "");
  const image = JSON.parse(result.stdout);
  assertInlineImage(image, image.revision);
  const after = await imageDeliveryTree(parent);
  const added = Object.keys(after).filter((key) => !(key in before));
  assert.ok(
    added.every((key) => key === ".configured.smallpen.write-lock"),
    `unexpected files: ${added}`,
  );
  if (added.length > 0)
    assert.equal(after[".configured.smallpen.write-lock"], null);
  const repeated = await runCli(args, { cwd: parent });
  assert.equal(repeated.code, 0, repeated.stdout);
  assert.equal(repeated.stderr, "");
  assert.deepEqual(
    withoutOutput(JSON.parse(repeated.stdout)),
    withoutOutput(image),
  );
  assert.deepEqual(await imageDeliveryTree(parent), after);
});

test("inline image delivery follows committed edits", async (context) => {
  const { packagePath, parent } = await configuredCliPackage(context);
  const args = [
    "export",
    packagePath,
    "--page",
    "Round Trip",
    "--format",
    "png",
    "--base64",
    "--json",
  ];
  const before = await runCli(args, { cwd: parent });
  assert.equal(before.code, 0, before.stdout);
  const first = JSON.parse(before.stdout);
  assertInlineImage(first, first.revision);
  const batchPath = join(parent, "edit.json");
  await writeFile(
    batchPath,
    JSON.stringify({
      baseRevision: first.revision,
      batchId: "inline_image_freshness",
      operations: [
        {
          type: "update-presentation-node",
          screenId: "scr_roundtrip",
          presentationId: "pres_desktop",
          nodeId: "node_rectangle",
          changes: { fills: [{ type: "solid", color: "#ff0000" }] },
        },
      ],
    }),
  );
  const applied = await runCli([
    "advanced",
    "apply",
    packagePath,
    "--batch",
    batchPath,
    "--json",
  ]);
  assert.equal(applied.code, 0, applied.stdout);
  const tree = await imageDeliveryTree(parent);
  const after = await runCli(args, { cwd: parent });
  assert.equal(after.code, 0, after.stdout);
  const second = JSON.parse(after.stdout);
  const current = JSON.parse(
    (await runCli(["project", "show", packagePath, "--json"])).stdout,
  );
  assertInlineImage(second, current.revision);
  assert.notEqual(second.revision, first.revision);
  assert.notEqual(second.renderHash, first.renderHash);
  assert.deepEqual(await imageDeliveryTree(parent), tree);
});

test("export rejects inline bytes and evidence without --format png", async (context) => {
  const { packagePath, parent } = await configuredCliPackage(context);
  // The first read leaves the reusable empty package lock directory.
  const warm = await runCli(["project", "show", packagePath, "--json"], { cwd: parent });
  assert.equal(warm.code, 0, warm.stdout);
  for (const options of [["--base64"], ["--evidence"]]) {
    const before = await imageDeliveryTree(parent);
    const result = await runCli(
      ["export", packagePath, ...options, "--json"],
      { cwd: parent },
    );
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    const error = JSON.parse(result.stdout).error;
    assert.equal(error.code, "missing_png_format", options.join(" "));
    assert.match(error.message, /--format png/);
    assert.deepEqual(await imageDeliveryTree(parent), before);
  }
});

test("the public Repair command can choose a Foundation and remove a broken reference", async (context) => {
  const initialized = await initializedCliWorkspace(context);
  const manifestPath = join(initialized.productPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.dependencies[0].path = "missing.smallpen";
  await writeFile(manifestPath, JSON.stringify(manifest));

  const inspectRepair = await runCli([
    "project",
    "repair",
    initialized.productPath,
    "--json",
  ]);
  assert.equal(inspectRepair.code, 0, inspectRepair.stderr);
  assert.equal(
    JSON.parse(inspectRepair.stdout).conflicts[0].code,
    "foundation_unavailable",
  );

  const choose = await runCli([
    "project",
    "repair",
    initialized.productPath,
    "--action",
    "choose-foundation",
    "--foundation",
    initialized.foundationPath,
    "--json",
  ]);
  assert.equal(choose.code, 0, `${choose.stderr}\n${choose.stdout}`);
  assert.equal(JSON.parse(choose.stdout).status, "ready");

  const screenPath = join(
    initialized.productPath,
    "screens",
    "first-design.json",
  );
  const screen = JSON.parse(await readFile(screenPath, "utf8"));
  screen.presentations[0].nodes.node_home_root.tokenBindings = {
    fill: { assetId: "tok_missing", packageId: "pkg_agent_surface_foundation" },
  };
  await writeFile(screenPath, JSON.stringify(screen));
  const broken = await runCli(["project", "repair", initialized.productPath, "--json"]);
  assert.equal(broken.code, 0, broken.stderr);
  assert.equal(
    JSON.parse(broken.stdout).conflicts[0].code,
    "missing_foundation_asset",
  );

  const removed = await runCli([
    "project",
    "repair",
    initialized.productPath,
    "--action",
    "remove-dependent-usage",
    "--json",
  ]);
  assert.equal(removed.code, 0, `${removed.stderr}\n${removed.stdout}`);
  assert.equal(JSON.parse(removed.stdout).status, "ready");
  const repairedScreen = JSON.parse(await readFile(screenPath, "utf8"));
  assert.deepEqual(
    repairedScreen.presentations[0].nodes.node_home_root.tokenBindings,
    {},
  );

  repairedScreen.presentations[0].nodes.node_home_root.tokenBindings = {
    fill: {
      assetId: "tok_deleted_again",
      packageId: "pkg_agent_surface_foundation",
    },
  };
  await writeFile(screenPath, JSON.stringify(repairedScreen));
  const recreatedAssetPath = join(initialized.parent, "recreated-token.json");
  await writeFile(
    recreatedAssetPath,
    JSON.stringify({
      definition: {
        $extensions: {
          smallpen: { id: "tok_product_recreated", visibility: "public" },
        },
        $type: "color",
        $value: "#336699",
      },
      filePath: "tokens/recreated.json",
      path: "color.recreated",
      tokenId: "tok_product_recreated",
    }),
  );
  const recreated = await runCli([
    "project",
    "repair",
    initialized.productPath,
    "--action",
    "recreate-product-asset",
    "--asset-kind",
    "token",
    "--asset",
    recreatedAssetPath,
    "--json",
  ]);
  assert.equal(recreated.code, 0, `${recreated.stderr}\n${recreated.stdout}`);
  assert.equal(JSON.parse(recreated.stdout).status, "ready");
  const recreatedScreen = JSON.parse(await readFile(screenPath, "utf8"));
  assert.deepEqual(
    recreatedScreen.presentations[0].nodes.node_home_root.tokenBindings.fill,
    {
      assetId: "tok_product_recreated",
      packageId: "pkg_agent_surface_product",
    },
  );
});

test("high-level write commands refuse a Product workspace in Repair", async (context) => {
  const initialized = await initializedCliWorkspace(context);
  const manifestPath = join(initialized.productPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.dependencies[0].path = "missing.smallpen";
  await writeFile(manifestPath, JSON.stringify(manifest));
  const before = await runCli(["project", "show", initialized.productPath, "--json"]);
  const beforeRevision = JSON.parse(before.stdout).revision;
  const pageIntent = join(initialized.parent, "repair-page.json");
  const tokenIntent = join(initialized.parent, "repair-token.json");
  await writeFile(
    pageIntent,
    JSON.stringify({
      page: "Repair page",
      children: [{ name: "Box", width: 100, height: 40 }],
    }),
  );
  await writeFile(
    tokenIntent,
    JSON.stringify({
      tokens: [{ name: "color.repair", type: "color", value: "#123456" }],
    }),
  );

  for (const [object, action, ...options] of [
    ["page", "draw", "--intent", pageIntent],
    ["flow", "start", "--page", "Home"],
    ["component", "rename", "--component", "Button", "--to", "Action"],
    ["token", "set", "--intent", tokenIntent],
  ]) {
    const result = await runCli([
      object,
      action,
      initialized.productPath,
      ...options,
      "--json",
    ]);
    assert.equal(
      result.code,
      1,
      `${object} ${action}: ${result.stderr}\n${result.stdout}`,
    );
    assert.equal(JSON.parse(result.stdout).error.code, "repair_required");
    const unchanged = await runCli(["project", "show", initialized.productPath, "--json"]);
    assert.equal(JSON.parse(unchanged.stdout).revision, beforeRevision);
  }

  const batchPath = join(initialized.parent, "repair-generic-apply.json");
  const screenEntry = manifest.entries.screens[0];
  const screen = JSON.parse(
    await readFile(join(initialized.productPath, screenEntry), "utf8"),
  );
  const presentation = screen.presentations[0];
  const nodeId = presentation.rootIds?.[0] ?? presentation.rootId;
  await writeFile(
    batchPath,
    JSON.stringify({
      baseRevision: beforeRevision,
      batchId: "batch_repair_generic_apply",
      operations: [
        {
          changes: { opacity: 0.73 },
          nodeId,
          presentationId: presentation.id,
          screenId: screen.id,
          type: "update-presentation-node",
        },
      ],
    }),
  );
  const genericApply = await runCli([
    "advanced",
    "apply",
    initialized.productPath,
    "--batch",
    batchPath,
    "--json",
  ]);
  assert.equal(
    genericApply.code,
    0,
    `${genericApply.stderr}\n${genericApply.stdout}`,
  );
  const after = await runCli(["project", "show", initialized.productPath, "--json"]);
  assert.notEqual(JSON.parse(after.stdout).revision, beforeRevision);
});

test("impact reports Product usages of a Foundation Token", async (context) => {
  const initialized = await initializedCliWorkspace(context);
  const applyOperations = async (packagePath, batchId, operations) => {
    const inspected = await runCli(["project", "show", packagePath, "--json"]);
    assert.equal(inspected.code, 0, inspected.stderr);
    const batchPath = join(initialized.parent, `${batchId}.json`);
    await writeFile(
      batchPath,
      JSON.stringify({
        baseRevision: JSON.parse(inspected.stdout).revision,
        batchId,
        operations,
      }),
    );
    const applied = await runCli([
      "advanced",
      "apply",
      packagePath,
      "--batch",
      batchPath,
      "--json",
    ]);
    assert.equal(applied.code, 0, `${applied.stderr}\n${applied.stdout}`);
  };
  await applyOperations(
    initialized.foundationPath,
    "batch_foundation_impact_token",
    [
      {
        definition: {
          $extensions: {
            smallpen: { id: "tok_foundation_impact", visibility: "public" },
          },
          $type: "color",
          $value: "#336699",
        },
        filePath: "tokens/foundation-impact.json",
        path: "color.foundation-impact",
        tokenId: "tok_foundation_impact",
        type: "put-token",
      },
    ],
  );
  await applyOperations(
    initialized.productPath,
    "batch_foundation_impact_binding",
    [
      {
        binding: {
          assetId: "tok_foundation_impact",
          packageId: "pkg_agent_surface_foundation",
        },
        field: "fill",
        nodeId: "node_home_root",
        screenId: "scr_home",
        type: "set-token-binding",
      },
    ],
  );

  const impact = await runCli([
    "token",
    "impact",
    initialized.productPath,
    "--path",
    "color.foundation-impact",
    "--json",
  ]);

  assert.equal(impact.code, 0, `${impact.stderr}\n${impact.stdout}`);
  const result = JSON.parse(impact.stdout);
  const foundation = JSON.parse(
    (await runCli(["project", "show", initialized.foundationPath, "--json"])).stdout,
  );
  const product = JSON.parse(
    (await runCli(["project", "show", initialized.productPath, "--json"])).stdout,
  );
  assertNoIds(result);
  assert.equal(result.ownerRevision, foundation.revision);
  assert.equal(result.foundationRevision, foundation.revision);
  assert.equal(result.productRevision, product.revision);
  assert.deepEqual(result.token, {
    path: "color.foundation-impact",
    type: "color",
  });
  assert.deepEqual(result.locations, [
    {
      kind: "screen-node",
      page: "Home",
      platform: "desktop",
      element: "Home",
      field: "fill",
    },
  ]);

  const fullImpact = await runCli([
    "token",
    "impact",
    initialized.productPath,
    "--path",
    "color.foundation-impact",
    "--full",
    "--json",
  ]);
  assert.equal(fullImpact.code, 0, fullImpact.stdout);
  const full = JSON.parse(fullImpact.stdout);
  assert.equal(full.packageId, "pkg_agent_surface_foundation");
  assert.equal(full.token.id, "tok_foundation_impact");
  assert.equal(full.locations[0].nodeId, "node_home_root");
  assert.equal(full.locations[0].screenId, "scr_home");
});

test("CLI stale-write errors include exact refresh and replay operations", async (context) => {
  const initialized = await initializedCliWorkspace(context);
  const batchPath = join(initialized.parent, "stale.json");
  await writeFile(
    batchPath,
    JSON.stringify({
      baseRevision: "stale",
      batchId: "batch_stale_cli",
      operations: [],
    }),
  );
  const result = await runCli([
    "advanced",
    "apply",
    initialized.productPath,
    "--batch",
    batchPath,
    "--json",
  ]);
  assert.equal(result.code, 1);
  const error = JSON.parse(result.stdout).error;
  assert.equal(error.code, "stale_revision");
  // Refresh reads the package by name; replay reruns the grouped apply.
  assert.deepEqual(
    error.details.nextOperations.map(({ operation }) => operation),
    ["smallpen.view", "smallpen.advanced.apply"],
  );
  assert.deepEqual(error.details.nextOperations[0].argv, [
    "view",
    initialized.productPath,
    "--json",
  ]);
  assert.deepEqual(error.details.nextOperations[1].argv.slice(0, 3), [
    "advanced",
    "apply",
    initialized.productPath,
  ]);
  assert.equal(
    error.details.nextOperations[1].args.baseRevision,
    error.details.actualRevision,
  );
});

test("CLI rejects option typos instead of silently guessing", async () => {
  const result = await runCli([
    "view",
    "/tmp/example.smallpen",
    "--pag",
    "Home",
    "--json",
  ]);
  assert.equal(result.code, 1);
  const error = JSON.parse(result.stdout).error;
  assert.equal(error.code, "unknown_option");
  assert.ok(error.details.validOptions.includes("--page"));
  const recovery = error.details.nextOperations[0];
  assert.deepEqual(recovery.argv, ["schema", "command", "view", "--json"]);
  const help = await runCli(recovery.argv);
  assert.equal(help.code, 0);
  assert.equal(help.stderr, "");
  assert.match(help.stdout, /--page/);
});

test("CLI reports a missing package before interpreting flags as paths", async () => {
  for (const args of [
    ["project", "show", "--json"],
    ["advanced", "apply", "--json"],
  ]) {
    const result = await runCli(args);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).error.code, "missing_package");
  }
});

test("view, export and validate reject the removed ID selectors", async () => {
  for (const [command, option, value] of [
    ["view", "--format", "screenshot"],
    ["view", "--screen-id", "scr_roundtrip"],
    ["view", "--component-id", "cmp_button"],
    ["export", "--presentation-id", "pres_desktop"],
    ["export", "--contexts", "contexts.json"],
    ["validate", "--node-id", "node_rectangle"],
    ["validate", "--all", undefined],
  ]) {
    const result = await runCli([
      command,
      "/tmp/example.smallpen",
      option,
      ...(value === undefined ? [] : [value]),
      "--json",
    ]);
    assert.equal(result.code, 1, `${command} ${option}`);
    const error = JSON.parse(result.stdout).error;
    assert.equal(error.code, "unknown_option", `${command} ${option}`);
    assert.equal(error.details.option, option);
  }
});

test("apply dry-run and real apply reject JSON blob fields consistently", async (context) => {
  const { packagePath, parent } = await configuredCliPackage(context);
  const inspected = await runCli(["project", "show", packagePath, "--json"]);
  const batchPath = join(parent, "invalid-json-blobs.json");
  await writeFile(
    batchPath,
    JSON.stringify({
      baseRevision: JSON.parse(inspected.stdout).revision,
      batchId: "batch_invalid_json_blobs",
      blobs: {},
      operations: [],
    }),
  );

  for (const extra of [[], ["--dry-run"]]) {
    const result = await runCli([
      "advanced",
      "apply",
      packagePath,
      "--batch",
      batchPath,
      ...extra,
      "--json",
    ]);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).error.code, "invalid_blob_writes");
  }
});

test("concurrent CLI writers reject the stale batch instead of losing an update", async (context) => {
  const { packagePath, parent } = await configuredCliPackage(context);
  const inspected = await runCli(["project", "show", packagePath, "--json"]);
  assert.equal(inspected.code, 0, inspected.stderr);
  const revision = JSON.parse(inspected.stdout).revision;
  const batch = (batchId, opacity) => ({
    baseRevision: revision,
    batchId,
    operations: [
      {
        changes: { opacity },
        nodeId: "node_rectangle",
        presentationId: "pres_desktop",
        screenId: "scr_roundtrip",
        type: "update-presentation-node",
      },
    ],
  });
  const firstPath = join(parent, "concurrent-first.json");
  const secondPath = join(parent, "concurrent-second.json");
  await writeFile(
    firstPath,
    JSON.stringify(batch("batch_concurrent_first", 0.2)),
  );
  await writeFile(
    secondPath,
    JSON.stringify(batch("batch_concurrent_second", 0.8)),
  );

  const results = await Promise.all([
    runCli(["advanced", "apply", packagePath, "--batch", firstPath, "--json"]),
    runCli(["advanced", "apply", packagePath, "--batch", secondPath, "--json"]),
  ]);

  assert.equal(results.filter(({ code }) => code === 0).length, 1);
  const rejected = results.find(({ code }) => code !== 0);
  assert.equal(JSON.parse(rejected.stdout).error.code, "stale_revision");
});

test("view resolves Tokens with the selected Context values", async (context) => {
  const { packagePath } = await configuredCliPackage(context, [
    {
      contextFile: contextFile(),
      entry: "contexts/design.json",
      type: "put-context-file",
    },
    tokenOperation(),
    {
      binding: { assetId: "tok_brand", packageId: "pkg_roundtrip" },
      field: "fill",
      nodeId: "node_rectangle",
      screenId: "scr_roundtrip",
      type: "set-token-binding",
    },
  ]);

  for (const value of ["light", "dark"]) {
    const result = await runCli([
      "view",
      packagePath,
      "--page",
      "Round Trip",
      "--context",
      `axis_theme=${value}`,
      "--full",
      "--json",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const view = JSON.parse(result.stdout);
    assert.deepEqual(view.selection.context, { axis_theme: value });
    assert.deepEqual(
      view.tokenSources.map(({ path, value, reference }) => ({
        path,
        value,
        reference,
      })),
      [
        {
          path: "color.brand",
          value: "#6750a4",
          reference: { assetId: "tok_brand", packageId: "pkg_roundtrip" },
        },
      ],
    );
  }
});

test("impact includes Token bindings inside Component Set variants", async (context) => {
  const { packagePath } = await configuredCliPackage(context, [
    tokenOperation(),
    componentOperation(),
  ]);

  const result = await runCli([
    "token",
    "impact",
    packagePath,
    "--path",
    "color.brand",
    "--json",
  ]);
  assert.equal(result.code, 0, result.stderr);
  const impact = JSON.parse(result.stdout);
  assertNoIds(impact);
  assert.deepEqual(impact.token, { path: "color.brand", type: "color" });
  assert.deepEqual(impact.locations, [
    {
      kind: "component-node",
      component: "Button",
      variant: "State=idle",
      element: "Button",
      field: "fill",
    },
  ]);

  const fullRead = await runCli([
    "token",
    "impact",
    packagePath,
    "--path",
    "color.brand",
    "--full",
    "--json",
  ]);
  assert.equal(fullRead.code, 0, fullRead.stderr);
  const full = JSON.parse(fullRead.stdout);
  assert.equal(full.token.id, "tok_brand");
  assert.deepEqual(
    full.locations.map(({ componentId, nodeId, variantId }) => ({
      componentId,
      nodeId,
      variantId,
    })),
    [
      {
        componentId: "cmp_button",
        nodeId: "node_button_source",
        variantId: "var_button_idle",
      },
    ],
  );
});
