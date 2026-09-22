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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "apps", "cli", "bin", "smallpen.mjs");
const fixture = join(here, "fixtures", "roundtrip.smallpen");

function runCli(args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
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

  const inspected = await runCli(["inspect", packagePath, "--json"]);
  assert.equal(inspected.code, 0, inspected.stderr);
  const batchPath = join(parent, "setup-batch.json");
  await writeFile(
    batchPath,
    JSON.stringify({
      baseRevision: JSON.parse(inspected.stdout).package.revision,
      batchId: "batch_cli_configured_setup",
      operations,
    }),
  );
  const applied = await runCli([
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
    "init",
    workspacePath,
    "--answers",
    answersPath,
    "--state",
    statePath,
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
  for (const args of [["--version"], ["version"]]) {
    const result = await runCli(args);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.trim(), metadata.version);
  }
  const json = await runCli(["version", "--json"]);
  assert.equal(json.code, 0, json.stdout);
  assert.deepEqual(JSON.parse(json.stdout), {
    name: metadata.name,
    version: metadata.version,
  });
  const invalid = await runCli(["nonexistent-command"]);
  assert.equal(invalid.code, 1);
  const recovery = JSON.parse(invalid.stdout).error.details.nextOperations[0];
  assert.equal(recovery.command, "smallpen --help");
  assert.deepEqual(recovery.argv, ["--help"]);
  assert.equal((await runCli(recovery.argv)).code, 0);
});

test("root and every public command provide standalone help", async () => {
  const root = await runCli(["--help"]);
  assert.equal(root.code, 0, root.stderr);
  assert.match(root.stdout, /One \.smallpen directory is one Canonical Package/);
  assert.match(root.stdout, /there is no current\s+selection, current page, or cross-call session state/);
  assert.match(root.stdout, /Choose an Agent view:/);
  assert.match(root.stdout, /wireframe.*2D spatial reasoning/s);
  assert.match(root.stdout, /wireframe.*compact.*\[NN\] key/s);
  assert.doesNotMatch(root.stdout, /wireframe.*detailed.*\[NN\]/s);
  assert.match(root.stdout, /PNG.*raster pixels only/s);
  for (const command of [
    "version",
    "init",
    "validate",
    "inspect",
    "list",
    "read",
    "read-view",
    "discover",
    "catalog",
    "search-components",
    "component",
    "compare",
    "tokens",
    "search-tokens",
    "effective-token",
    "explain-token",
    "render",
    "inspect-view",
    "render-matrix",
    "evidence",
    "import-draft",
    "draft-diff",
    "draft-compile",
    "flow",
    "page",
    "token",
    "impact",
    "apply",
    "repair",
  ]) {
    const result = await runCli([command, "--help"]);
    assert.equal(result.code, 0, `${command}: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(`SmallPen ${command}`));
    assert.match(result.stdout, /Usage:/);
  }

  const render = await runCli(["render", "--help"]);
  assert.doesNotMatch(render.stdout, /--format FORMAT/);
  assert.match(
    render.stdout,
    /read-view <product\.smallpen> --format wireframe/,
  );

  const readView = await runCli(["read-view", "--help"]);
  assert.match(
    readView.stdout,
    /--format FORMAT\s+structure\|semantic\|wireframe\|screenshot/,
  );
  assert.match(readView.stdout, /wireframe.*scaled 2D ASCII canvas/s);
  assert.match(readView.stdout, /semantic.*Exact machine-readable hierarchy/s);
  assert.match(readView.stdout, /alignment, resolved\s+typography/);
  assert.match(readView.stdout, /PNG image itself is raster pixels only/s);

  const inspectView = await runCli(["inspect-view", "--help"]);
  assert.match(
    inspectView.stdout,
    /Use this when the Agent needs both structure and visual QA/,
  );
  assert.match(
    inspectView.stdout,
    /Three complementary view parts:.*wireframe.*semanticTree.*image/s,
  );
});

test("inspect-view help names every supported design selector", async () => {
  const result = await runCli(["inspect-view", "--help"]);
  assert.equal(result.code, 0);
  for (const option of [
    "--screen", "--presentation", "--scenario", "--context-profile",
    "--context", "--scale", "--locale",
  ]) {
    assert.match(result.stdout, new RegExp(`${option}\\s`), option);
  }
});

test("import-tokens help explains explicit dry-run precedence", async () => {
  const result = await runCli(["import-tokens", "--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /--dry-run/);
  assert.match(result.stdout, /--dry-run.*review.*even with --apply/s);
});

test("init continuation retains the workspace locator and selected locale", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-cli-continuation-"));
  context.after(() => rm(parent, { force: true, recursive: true }));
  const workspace = join(parent, "workspace with spaces");
  const statePath = join(parent, "custom state.json");
  const started = await runCli([
    "init", workspace, "--state", statePath, "--locale", "en", "--json",
  ]);
  assert.equal(started.code, 0, started.stdout);
  const question = JSON.parse(started.stdout).nextQuestion;
  assert.equal(question.continuation.args[1], workspace);
  assert.equal(question.continuation.args.includes("<workspace-directory>"), false);
  const resumed = await runCli(question.continuation.args.map((argument) =>
    argument === `${question.id}=<JSON>`
      ? `${question.id}=${JSON.stringify(question.recommendation)}`
      : argument,
  ));
  assert.equal(resumed.code, 0, resumed.stdout);
  const next = JSON.parse(resumed.stdout);
  assert.equal(next.answers[question.id], question.recommendation);
  assert.equal(next.nextQuestion.label, next.nextQuestion.labels.en);
  assert.equal(next.nextQuestion.continuation.args[1], workspace);
  assert.equal(next.statePath, statePath);
});

test("invalid init answers return retry argv that preserves workspace state and locale", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-cli-init-retry-"));
  context.after(() => rm(parent, { force: true, recursive: true }));
  const workspace = join(parent, "workspace with spaces");
  const statePath = join(parent, "custom state.json");
  const base = ["init", workspace, "--state", statePath, "--locale", "en", "--json"];
  assert.equal((await runCli(base)).code, 0);
  for (const [value, code] of [
    ["not-json", "invalid_initialization_answer_json"],
    ['"invalid-kind"', "invalid_initialization_answer"],
  ]) {
    const before = await readFile(statePath, "utf8");
    const invalid = await runCli([...base, "--answer", `projectKind=${value}`]);
    assert.equal(invalid.code, 1);
    const error = JSON.parse(invalid.stdout).error;
    assert.equal(error.code, code);
    assert.equal(await readFile(statePath, "utf8"), before);
    assert.ok(Array.isArray(error.details.nextOperations?.[0]?.argv));
    const retry = error.details.nextOperations[0].argv;
    assert.equal(retry[1], workspace);
    assert.equal(retry[retry.indexOf("--state") + 1], statePath);
    assert.equal(retry[retry.indexOf("--locale") + 1], "en");
    const resumed = await runCli(retry.map((argument) =>
      argument === "projectKind=<JSON>" ? 'projectKind="application"' : argument,
    ));
    assert.equal(resumed.code, 0, resumed.stdout);
    const next = JSON.parse(resumed.stdout);
    assert.equal(next.answers.projectKind, "application");
    assert.equal(next.nextQuestion.label, next.nextQuestion.labels.en);
  }
});

test("apply returns Design Token warnings for hard-coded style values", async (context) => {
  const { packagePath, parent } = await configuredCliPackage(context, [
    tokenOperation(),
  ]);
  const inspected = await runCli(["inspect", packagePath, "--json"]);
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
      baseRevision: JSON.parse(inspected.stdout).package.revision,
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
    reference: { assetId: "tok_brand", packageId: "pkg_roundtrip" },
  });

  const after = await runCli(["inspect", packagePath, "--json"]);
  const unmatchedPath = join(parent, "unmatched-color.json");
  await writeFile(
    unmatchedPath,
    JSON.stringify({
      baseRevision: JSON.parse(after.stdout).package.revision,
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
  const { packagePath, parent } = await configuredCliPackage(context, [tokenOperation()]);
  const inspected = await runCli(["inspect", packagePath, "--json"]);
  const revision = JSON.parse(inspected.stdout).package.revision;
  const batchPath = join(parent, "bulk-warning-batch.json");
  await writeFile(batchPath, JSON.stringify({
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
  }));
  const base = ["apply", packagePath, "--batch", batchPath, "--dry-run", "--json"];
  const compactRead = await runCli(base);
  assert.equal(compactRead.code, 0, compactRead.stdout);
  const compact = JSON.parse(compactRead.stdout);
  assert.equal(compact.warningSummary?.detail, "compact");
  assert.equal(compact.warningSummary.total, 36);
  assert.equal(compact.warnings[0].code, "design_token_not_used");
  assert.equal(compact.warnings[0].count, 12);
  const fullRead = await runCli([...base, "--warning-detail", "full"]);
  assert.equal(fullRead.code, 0, fullRead.stdout);
  const full = JSON.parse(fullRead.stdout);
  assert.equal(full.warningSummary.detail, "full");
  const expanded = compact.warnings.flatMap(({ count, locations, ...details }) => {
    assert.equal(count, locations.length);
    return locations.map(({ warningIndex, ...location }) => ({
      warningIndex,
      warning: { ...details, ...location, contextScope: compact.warningSummary.contextScope },
    }));
  }).sort((left, right) => left.warningIndex - right.warningIndex);
  assert.deepEqual(expanded.map(({ warningIndex }) => warningIndex), Array.from({ length: 36 }, (_, index) => index));
  assert.deepEqual(expanded.map(({ warning }) => warning), full.warnings);
  assert.ok(JSON.stringify({ warnings: compact.warnings, warningSummary: compact.warningSummary }).length < JSON.stringify(full.warnings).length * 0.65);
  const invalid = await runCli([...base, "--warning-detail", "none"]);
  assert.equal(invalid.code, 1);
  assert.equal(JSON.parse(invalid.stdout).error.code, "invalid_warning_detail");
  const after = await runCli(["inspect", packagePath, "--json"]);
  assert.equal(JSON.parse(after.stdout).package.revision, revision);
});

test("search-tokens rejects a type that conflicts with --color", async (context) => {
  const { packagePath } = await configuredCliPackage(context, [tokenOperation()]);
  const result = await runCli([
    "search-tokens",
    packagePath,
    "--color",
    "#6750a4",
    "--type",
    "spacing",
    "--json",
  ]);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).error.code, "conflicting_token_search_type");
});

test("init ignores an implicit stale state file", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-cli-stale-init-"));
  context.after(() => rm(parent, { force: true, recursive: true }));
  const workspacePath = join(parent, "workspace");
  await writeFile(
    `${workspacePath}.smallpen-init.json`,
    JSON.stringify({ answers: initializationAnswers(), status: "proposal" }),
  );

  const result = await runCli(["init", workspacePath, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const state = JSON.parse(result.stdout);
  assert.equal(state.status, "needs_input");
  assert.equal(state.nextQuestion.id, "projectKind");
});

test("component inspects one exact Component Set and rejects invalid selectors", async (context) => {
  const { packagePath } = await configuredCliPackage(context, [
    tokenOperation(),
    componentOperation(),
  ]);

  const inspected = await runCli([
    "component",
    packagePath,
    "--component-id",
    "cmp_button",
    "--json",
  ]);
  assert.equal(inspected.code, 0, inspected.stderr);
  const result = JSON.parse(inspected.stdout);
  assert.equal(result.component.id, "cmp_button");
  assert.equal(result.component.name, "Button");
  assert.deepEqual(result.component.axes[0].domain, ["idle"]);
  assert.deepEqual(result.component.variants[0].selection, { axis_state: "idle" });

  const searched = await runCli([
    "search-components",
    packagePath,
    "--query",
    "button",
    "--json",
  ]);
  assert.equal(searched.code, 0, searched.stderr);
  assert.equal(JSON.parse(searched.stdout).items[0].id, "cmp_button");

  const missingId = await runCli(["component", packagePath, "--json"]);
  assert.equal(missingId.code, 1);
  const missingError = JSON.parse(missingId.stdout).error;
  assert.equal(missingError.code, "missing_component_id");
  const discovery = missingError.details.nextOperations.find((item) => item.argv[0] === "list");
  assert.deepEqual(discovery.argv.slice(2), ["--kind", "components", "--json"]);
  assert.equal(await realpath(discovery.argv[1]), await realpath(packagePath));
  const discovered = await runCli(discovery.argv);
  assert.equal(discovered.code, 0, discovered.stdout);
  assert.ok(JSON.parse(discovered.stdout).items.some(({ item }) => item.id === "cmp_button"));

  const remoteMissing = await runCli(["component", "https://example.com/library.smallpen", "--json"]);
  assert.equal(remoteMissing.code, 1);
  const remoteError = JSON.parse(remoteMissing.stdout).error;
  assert.equal(remoteError.code, "missing_component_id");
  assert.deepEqual(remoteError.details.nextOperations.map((item) => item.argv), [["component", "--help"]]);
  assert.equal((await runCli(remoteError.details.nextOperations[0].argv)).code, 0);

  const unknown = await runCli([
    "component",
    packagePath,
    "--component-id",
    "cmp_missing",
    "--json",
  ]);
  assert.equal(unknown.code, 1);
  assert.equal(JSON.parse(unknown.stdout).error.code, "missing_component");
});

test("malformed package JSON names its file and gives a safe validation continuation", async (context) => {
  const { packagePath, parent } = await configuredCliPackage(context);
  const canonicalPath = await realpath(packagePath);
  const alias = join(parent, "linked-owner.smallpen");
  await symlink(packagePath, alias, "dir");
  const before = JSON.parse((await runCli(["inspect", packagePath, "--json"])).stdout).package.revision;

  for (const entry of ["screens/roundtrip.json", "manifest.json"]) {
    const file = join(packagePath, entry);
    const original = await readFile(file);
    const invalid = "{\"unfinished\":";
    await writeFile(file, invalid);

    const failed = await runCli(["read", alias, "--json"]);
    assert.equal(failed.code, 1);
    assert.equal(failed.stderr, "");
    const error = JSON.parse(failed.stdout).error;
    const code = entry === "manifest.json" ? "invalid_manifest_json" : "invalid_entry_json";
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
  const libraryPath = join(dirname(initialized.productPath), "Team's UI library.smallpen");
  await cp(fixture, libraryPath, { recursive: true });
  const libraryManifestPath = join(libraryPath, "manifest.json");
  const libraryManifest = JSON.parse(await readFile(libraryManifestPath, "utf8"));
  libraryManifest.packageId = "pkg_ui_library";
  await writeFile(libraryManifestPath, JSON.stringify(libraryManifest));

  for (const [packagePath, id] of [
    [initialized.foundationPath, "cmp_foundation_button"],
    [libraryPath, "cmp_library_button"],
  ]) {
    const operation = componentOperation();
    operation.componentSet.id = id;
    delete operation.componentSet.variants[0].nodes.node_button_source.tokenBindings;
    const inspected = await runCli(["inspect", packagePath, "--json"]);
    assert.equal(inspected.code, 0, inspected.stdout);
    const batchPath = join(initialized.parent, `${id}.json`);
    await writeFile(batchPath, JSON.stringify({
      baseRevision: JSON.parse(inspected.stdout).package.revision,
      batchId: `batch_${id}`,
      operations: [operation],
    }));
    const applied = await runCli(["apply", packagePath, "--batch", batchPath, "--json"]);
    assert.equal(applied.code, 0, applied.stdout);
  }

  const manifestPath = join(initialized.productPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.libraries = [{
    packageId: "pkg_ui_library",
    source: { path: "Team's UI library.smallpen", type: "local" },
  }];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const searched = await runCli([
    "search-components", initialized.productPath, "--query", "button", "--json",
  ]);
  assert.equal(searched.code, 0, searched.stdout);
  const result = JSON.parse(searched.stdout);
  assert.deepEqual(result.items.map(({ id }) => id).sort(), [
    "cmp_button", "cmp_foundation_button", "cmp_library_button",
  ]);
  for (const item of result.items) {
    const ownerPath = await realpath(
      item.source === "foundation" ? initialized.foundationPath : libraryPath,
    );
    const next = item.nextOperations[0];
    assert.deepEqual(next.argv, ["component", ownerPath, "--component-id", item.id, "--json"]);
    const detail = await runCli(next.argv);
    assert.equal(detail.code, 0, detail.stdout);
    assert.equal(JSON.parse(detail.stdout).component.id, item.id);
    assert.equal(JSON.parse(detail.stdout).packageId, item.packageId);
    assert.ok(next.command.startsWith("smallpen component "));
  }
});

test("component details accept a remote Library locator returned by search", async (context) => {
  const { packagePath, parent } = await configuredCliPackage(context, [
    tokenOperation(), componentOperation(),
  ]);
  const manifest = JSON.parse(await readFile(join(packagePath, "manifest.json"), "utf8"));
  const files = new Map();
  for (const path of ["manifest.json", ...Object.values(manifest.entries).flat()]) {
    files.set(`/${path}`, await readFile(join(packagePath, path)));
  }
  const server = createServer((request, response) => {
    const bytes = files.get(request.url);
    response.writeHead(bytes ? 200 : 404, { "content-type": "application/json" });
    response.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const locator = `http://127.0.0.1:${server.address().port}/manifest.json`;
  const inspected = await runCli([
    "component", locator, "--component-id", "cmp_button", "--json",
  ], { cwd: parent });
  assert.equal(inspected.code, 0, inspected.stdout);
  const result = JSON.parse(inspected.stdout);
  assert.equal(result.component.id, "cmp_button");
  assert.equal(result.packageId, manifest.packageId);
});

test("CLI discovery includes a Penpot located Component shown by Web Assets", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-cli-located-component-"));
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

  const inspected = await runCli(["inspect", packagePath, "--json"]);
  assert.equal(inspected.code, 0, inspected.stderr);
  assert.deepEqual(
    JSON.parse(inspected.stdout).components.map(({ id }) => id),
    ["cmp_button_located"],
  );

  const listed = await runCli([
    "list",
    packagePath,
    "--kind",
    "components",
    "--json",
  ]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(
    JSON.parse(listed.stdout).items.map(({ item }) => item.id),
    ["cmp_button_located"],
  );

  for (const command of ["catalog", "inspect-view"]) {
    const result = await runCli([command, packagePath, "--json"]);
    assert.equal(result.code, 0, `${command}: ${result.stderr}`);
    assert.deepEqual(
      JSON.parse(result.stdout).components.map(({ id }) => id),
      ["cmp_button_located"],
    );
  }

  const searched = await runCli([
    "search-components",
    packagePath,
    "--query",
    "located",
    "--json",
  ]);
  assert.equal(searched.code, 0, searched.stderr);
  assert.deepEqual(
    JSON.parse(searched.stdout).items.map(({ id }) => id),
    ["cmp_button_located"],
  );

  const component = await runCli([
    "component",
    packagePath,
    "--component-id",
    "cmp_button_located",
    "--json",
  ]);
  assert.equal(component.code, 0, component.stderr);
  assert.equal(JSON.parse(component.stdout).component.kind, "located");
});

test("an external Agent can initialize, inspect, render, and produce evidence using only public CLI", async (context) => {
  const initialized = await initializedCliWorkspace(context);
  assert.equal(initialized.status, "initialized");
  assert.equal(JSON.parse(await readFile(initialized.statePath, "utf8")).status, "initialized");

  const validate = await runCli(["validate", initialized.productPath, "--json"]);
  assert.equal(validate.code, 0, validate.stderr);
  assert.equal(JSON.parse(validate.stdout).status, "valid");

  const inspect = await runCli(["inspect", initialized.productPath, "--json"]);
  assert.equal(inspect.code, 0, inspect.stderr);
  const inspected = JSON.parse(inspect.stdout);
  assert.equal(inspected.package.role, "product");
  assert.equal(inspected.screens[0].id, "scr_home");
  assert.equal(inspected.scenarios[0].id, "scn_home_default");

  const list = await runCli([
    "list",
    initialized.productPath,
    "--kind",
    "requirements",
    "--json",
  ]);
  assert.equal(list.code, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout).page.total, 1);

  const read = await runCli([
    "read-view",
    initialized.productPath,
    "--format",
    "screenshot",
    "--json",
  ]);
  assert.equal(read.code, 0, read.stderr);
  assert.equal(JSON.parse(read.stdout).result.status, "rendered");

  const renderPath = join(initialized.parent, "home.png");
  const render = await runCli([
    "render",
    initialized.productPath,
    "--output",
    renderPath,
    "--json",
  ]);
  assert.equal(render.code, 0, render.stderr);
  const rendered = JSON.parse(render.stdout);
  assert.equal(rendered.mimeType, "image/png");
  assert.ok((await stat(renderPath)).size > 100);
  assert.deepEqual([...new Uint8Array(await readFile(renderPath)).slice(0, 8)], [
    137, 80, 78, 71, 13, 10, 26, 10,
  ]);

  const viewPath = join(initialized.parent, "view.png");
  const view = await runCli([
    "inspect-view",
    initialized.productPath,
    "--include-image",
    "--base64",
    "--output",
    viewPath,
    "--json",
  ]);
  assert.equal(view.code, 0, view.stderr);
  const inspectedView = JSON.parse(view.stdout);
  assert.match(inspectedView.wireframe, /\[01\] FRAME "Home" #/);
  assert.equal(inspectedView.image.mimeType, "image/png");
  assert.ok(inspectedView.image.base64.length > 100);
  assert.ok((await stat(viewPath)).size > 100);

  const contextsPath = join(initialized.parent, "contexts.json");
  await writeFile(
    contextsPath,
    JSON.stringify([
      {},
      { viewFormat: "screenshot", screenId: "scr_home" },
    ]),
  );
  const matrix = await runCli([
    "render-matrix",
    initialized.productPath,
    "--contexts",
    contextsPath,
    "--output",
    join(initialized.parent, "matrix"),
    "--json",
  ]);
  assert.equal(matrix.code, 0, matrix.stderr);
  const renderedMatrix = JSON.parse(matrix.stdout);
  assert.equal(renderedMatrix.count, 2);
  assert.equal(renderedMatrix.images[0].mimeType, "image/png");
  assert.ok((await stat(renderedMatrix.images[1].output)).size > 100);

  const prefix = join(initialized.parent, "review");
  const evidence = await runCli([
    "evidence",
    initialized.productPath,
    "--output",
    prefix,
    "--json",
  ]);
  assert.equal(evidence.code, 0, evidence.stderr);
  const bundle = JSON.parse(evidence.stdout);
  assert.equal(bundle.renderHash, rendered.renderHash);
  assert.equal(JSON.parse(await readFile(`${prefix}.json`, "utf8")).renderHash, rendered.renderHash);
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

function assertInlineImage(image, revision) {
  assert.equal(image.output, undefined);
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.revision, revision);
  assert.equal(image.productRevision, revision);
  assert.ok(image.packageId);
  assert.ok(image.selection.screenId);
  const bytes = Buffer.from(image.base64, "base64");
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

for (const command of ["render", "evidence", "inspect-view", "render-matrix"]) {
  test(`${command} delivers fresh inline images without writing or reusing files`, async (context) => {
    const { packagePath, parent } = await configuredCliPackage(context);
    const contextsPath = join(parent, "contexts.json");
    await writeFile(
      contextsPath,
      JSON.stringify([{}, { screenId: "scr_roundtrip" }]),
    );
    await mkdir(join(parent, "smallpen-matrix"));
    for (const name of [
      "smallpen.png",
      "smallpen-view.png",
      "smallpen-evidence.png",
      "smallpen-evidence.json",
      "smallpen-matrix/old.png",
    ]) {
      await writeFile(
        join(parent, name),
        "stale image sentinel: never consume or replace",
      );
    }
    const args =
      command === "inspect-view"
        ? ["--include-image"]
        : command === "render-matrix"
          ? ["--contexts", contextsPath]
          : [];
    const inspected = JSON.parse(
      (await runCli(["inspect", packagePath, "--json"])).stdout,
    );
    const before = await imageDeliveryTree(parent);
    const results = await Promise.all(
      [1, 0.5].map((scale) =>
        runCli(
          [command, packagePath, ...args, "--scale", String(scale), "--json"],
          { cwd: parent },
        ),
      ),
    );
    const images = [];
    for (const result of results) {
      assert.equal(result.code, 0, result.stdout);
      assert.equal(result.stderr, "");
      const value = JSON.parse(result.stdout);
      assert.equal(value.imagePath, undefined);
      assert.equal(value.evidencePath, undefined);
      const delivered =
        command === "render-matrix" ? value.images : [value.image ?? value];
      for (const image of delivered)
        assertInlineImage(image, inspected.package.revision);
      images.push(delivered[0]);
    }
    assert.equal(images[0].width, images[1].width * 2);
    assert.notEqual(images[0].renderHash, images[1].renderHash);
    assert.deepEqual(await imageDeliveryTree(parent), before);

    if (command === "render-matrix") {
      await writeFile(
        contextsPath,
        JSON.stringify([{}, { screenId: "missing_screen" }]),
      );
    }
    const beforeFailure = await imageDeliveryTree(parent);
    const failed = await runCli(
      [
        command,
        packagePath,
        ...args,
        ...(command === "render-matrix" ? [] : ["--screen", "missing_screen"]),
        "--json",
      ],
      { cwd: parent },
    );
    assert.equal(failed.code, 1);
    assert.equal(failed.stderr, "");
    assert.deepEqual(Object.keys(JSON.parse(failed.stdout)), ["error"]);
    assert.doesNotMatch(
      failed.stdout,
      /"(?:base64|output|imagePath|evidencePath)"/,
    );
    assert.deepEqual(await imageDeliveryTree(parent), beforeFailure);
  });
}

test("cold inline image delivery retains only the reusable empty package lock directory", async (context) => {
  const { packagePath, parent } = await configuredCliPackage(context);
  const before = await imageDeliveryTree(parent);
  const args = ["render", packagePath];
  const result = await runCli(args, { cwd: parent });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.stderr, "");
  const image = JSON.parse(result.stdout);
  assertInlineImage(image, image.revision);
  const after = await imageDeliveryTree(parent);
  assert.deepEqual(after, {
    ...before,
    ".configured.smallpen.write-lock": null,
  });
  const repeated = await runCli(args, { cwd: parent });
  assert.equal(repeated.code, 0, repeated.stdout);
  assert.equal(repeated.stderr, "");
  assert.deepEqual(JSON.parse(repeated.stdout), image);
  assert.deepEqual(await imageDeliveryTree(parent), after);
});

test("inline image delivery follows committed edits and base64 alone never requests a file", async (context) => {
  const { packagePath, parent } = await configuredCliPackage(context);
  const args = [
    "inspect-view",
    packagePath,
    "--include-image",
    "--base64",
    "--json",
  ];
  const before = await runCli(args, { cwd: parent });
  assert.equal(before.code, 0, before.stdout);
  const first = JSON.parse(before.stdout);
  assertInlineImage(first.image, first.revision);
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
    (await runCli(["inspect", packagePath, "--json"])).stdout,
  );
  assertInlineImage(second.image, current.package.revision);
  assert.notEqual(second.revision, first.revision);
  assert.notEqual(second.image.renderHash, first.image.renderHash);
  assert.deepEqual(await imageDeliveryTree(parent), tree);
});

test("inspect-view rejects image output flags without include-image", async (context) => {
  const { packagePath, parent } = await configuredCliPackage(context);
  for (const options of [
    ["--base64"],
    ["--output", join(parent, "ignored.png")],
  ]) {
    const before = await imageDeliveryTree(parent);
    const result = await runCli(
      ["inspect-view", packagePath, ...options, "--json"],
      { cwd: parent },
    );
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    const error = JSON.parse(result.stdout).error;
    assert.equal(error.code, "missing_include_image");
    assert.match(error.message, /--include-image/);
    assert.deepEqual(await imageDeliveryTree(parent), before);
  }
});

test("an Agent can create flowchart nodes from a declarative intent", async (context) => {
  const initialized = await initializedCliWorkspace(context);
  const intentPath = join(initialized.parent, "flow.json");
  await writeFile(
    intentPath,
    JSON.stringify({
      nodes: [
        {
          children: [],
          height: 56,
          id: "node_start",
          name: "Start",
          type: "ELLIPSE",
          width: 120,
          x: 80,
          y: 80,
        },
        {
          children: [],
          height: 40,
          id: "node_connector",
          name: "Connector",
          pathData: "M 200 108 L 320 108",
          strokes: [
            {
              capEnd: "triangle-arrow",
              color: "#000000",
              opacity: 1,
              type: "solid",
              width: 2,
            },
          ],
          type: "PATH",
          width: 120,
          x: 200,
          y: 108,
        },
      ],
      screenId: "scr_home",
    }),
  );
  const dryRun = await runCli([
    "flow",
    initialized.productPath,
    "--intent",
    intentPath,
    "--dry-run",
    "--json",
  ]);
  assert.equal(dryRun.code, 0, dryRun.stderr);
  assert.equal(JSON.parse(dryRun.stdout).dryRun, true);

  const result = await runCli([
    "flow",
    initialized.productPath,
    "--intent",
    intentPath,
    "--batch-id",
    "flow_cli_surface",
    "--json",
  ]);
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const applied = JSON.parse(result.stdout);
  assert.deepEqual(applied.affectedIds.sort(), ["node_connector", "node_start"]);
  assert.equal(applied.inverseBatch.operations.length, 2);

  const read = await runCli([
    "read-view",
    initialized.productPath,
    "--format",
    "wireframe",
    "--json",
  ]);
  assert.equal(read.code, 0, read.stderr);
  const view = JSON.parse(read.stdout);
  assert.match(view.result, /\[02\] ELLIPSE "Start" #node_start/);
  assert.match(view.result, /\[03\] PATH "Connector" #node_connector/);
});

test("the public Repair command can choose a Foundation and remove a broken reference", async (context) => {
  const initialized = await initializedCliWorkspace(context);
  const manifestPath = join(initialized.productPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.dependencies[0].path = "missing.smallpen";
  await writeFile(manifestPath, JSON.stringify(manifest));

  const inspectRepair = await runCli(["repair", initialized.productPath, "--json"]);
  assert.equal(inspectRepair.code, 0, inspectRepair.stderr);
  assert.equal(JSON.parse(inspectRepair.stdout).conflicts[0].code, "foundation_unavailable");

  const choose = await runCli([
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

  const screenPath = join(initialized.productPath, "screens", "first-design.json");
  const screen = JSON.parse(await readFile(screenPath, "utf8"));
  screen.presentations[0].nodes.node_home_root.tokenBindings = {
    fill: { assetId: "tok_missing", packageId: "pkg_agent_surface_foundation" },
  };
  await writeFile(screenPath, JSON.stringify(screen));
  const broken = await runCli(["repair", initialized.productPath, "--json"]);
  assert.equal(broken.code, 0, broken.stderr);
  assert.equal(JSON.parse(broken.stdout).conflicts[0].code, "missing_foundation_asset");

  const removed = await runCli([
    "repair",
    initialized.productPath,
    "--action",
    "remove-dependent-usage",
    "--json",
  ]);
  assert.equal(removed.code, 0, `${removed.stderr}\n${removed.stdout}`);
  assert.equal(JSON.parse(removed.stdout).status, "ready");
  const repairedScreen = JSON.parse(await readFile(screenPath, "utf8"));
  assert.deepEqual(repairedScreen.presentations[0].nodes.node_home_root.tokenBindings, {});

  repairedScreen.presentations[0].nodes.node_home_root.tokenBindings = {
    fill: { assetId: "tok_deleted_again", packageId: "pkg_agent_surface_foundation" },
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
  const before = await runCli(["inspect", initialized.productPath, "--json"]);
  const beforeRevision = JSON.parse(before.stdout).package.revision;
  const flowIntent = join(initialized.parent, "repair-flow.json");
  const tokenIntent = join(initialized.parent, "repair-token.json");
  await writeFile(
    flowIntent,
    JSON.stringify({ nodes: [{}], screenId: "scr_home" }),
  );
  await writeFile(tokenIntent, JSON.stringify({ operations: [{}] }));

  for (const [command, intent] of [
    ["flow", flowIntent],
    ["page", flowIntent],
    ["token", tokenIntent],
  ]) {
    const result = await runCli([
      command,
      initialized.productPath,
      "--intent",
      intent,
      "--json",
    ]);
    assert.equal(result.code, 1, `${command}: ${result.stderr}\n${result.stdout}`);
    assert.equal(JSON.parse(result.stdout).error.code, "repair_required");
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
    "apply",
    initialized.productPath,
    "--batch",
    batchPath,
    "--json",
  ]);
  assert.equal(genericApply.code, 0, `${genericApply.stderr}\n${genericApply.stdout}`);
  const after = await runCli(["inspect", initialized.productPath, "--json"]);
  assert.notEqual(JSON.parse(after.stdout).package.revision, beforeRevision);
});

test("impact reports Product usages of a Foundation Token", async (context) => {
  const initialized = await initializedCliWorkspace(context);
  const applyOperations = async (packagePath, batchId, operations) => {
    const inspected = await runCli(["inspect", packagePath, "--json"]);
    assert.equal(inspected.code, 0, inspected.stderr);
    const batchPath = join(initialized.parent, `${batchId}.json`);
    await writeFile(
      batchPath,
      JSON.stringify({
        baseRevision: JSON.parse(inspected.stdout).package.revision,
        batchId,
        operations,
      }),
    );
    const applied = await runCli([
      "apply",
      packagePath,
      "--batch",
      batchPath,
      "--json",
    ]);
    assert.equal(applied.code, 0, `${applied.stderr}\n${applied.stdout}`);
  };
  await applyOperations(initialized.foundationPath, "batch_foundation_impact_token", [
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
  ]);
  await applyOperations(initialized.productPath, "batch_foundation_impact_binding", [
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
  ]);

  const impact = await runCli([
    "impact",
    initialized.productPath,
    "--token-id",
    "tok_foundation_impact",
    "--package-id",
    "pkg_agent_surface_foundation",
    "--json",
  ]);

  assert.equal(impact.code, 0, `${impact.stderr}\n${impact.stdout}`);
  const result = JSON.parse(impact.stdout);
  const foundation = JSON.parse((await runCli([
    "inspect",
    initialized.foundationPath,
    "--json",
  ])).stdout);
  const product = JSON.parse((await runCli([
    "inspect",
    initialized.productPath,
    "--json",
  ])).stdout);
  assert.equal(result.packageId, "pkg_agent_surface_foundation");
  assert.equal(result.ownerRevision, foundation.package.revision);
  assert.equal(result.foundationRevision, foundation.package.revision);
  assert.equal(result.productRevision, product.package.revision);
  assert.equal(result.locations.length, 1);
  assert.equal(result.locations[0].nodeId, "node_home_root");
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
    "apply",
    initialized.productPath,
    "--batch",
    batchPath,
    "--json",
  ]);
  assert.equal(result.code, 1);
  const error = JSON.parse(result.stdout).error;
  assert.equal(error.code, "stale_revision");
  assert.deepEqual(
    error.details.nextOperations.map(({ operation }) => operation),
    ["smallpen.refresh", "smallpen.apply.replay-intent"],
  );
  assert.equal(
    error.details.nextOperations[1].args.baseRevision,
    error.details.actualRevision,
  );
});

test("CLI rejects option typos instead of silently guessing", async () => {
  const result = await runCli([
    "read-view",
    "/tmp/example.smallpen",
    "--presentaton",
    "pres_typo",
    "--json",
  ]);
  assert.equal(result.code, 1);
  const error = JSON.parse(result.stdout).error;
  assert.equal(error.code, "unknown_option");
  assert.ok(error.details.validOptions.includes("--presentation"));
  const recovery = error.details.nextOperations[0];
  assert.deepEqual(recovery.argv, ["read-view", "--help"]);
  const help = await runCli(recovery.argv);
  assert.equal(help.code, 0);
  assert.equal(help.stderr, "");
  assert.match(help.stdout, /--presentation ID/);
});

test("CLI reports a missing package before interpreting flags as paths", async () => {
  for (const args of [["inspect", "--json"], ["apply", "--json"]]) {
    const result = await runCli(args);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).error.code, "missing_package");
  }
});

test("inspect-view rejects the unsupported format option", async () => {
  const result = await runCli([
    "inspect-view",
    "/tmp/example.smallpen",
    "--format",
    "screenshot",
    "--json",
  ]);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).error.code, "unknown_option");
});

test("apply dry-run and real apply reject JSON blob fields consistently", async (context) => {
  const { packagePath, parent } = await configuredCliPackage(context);
  const inspected = await runCli(["inspect", packagePath, "--json"]);
  const batchPath = join(parent, "invalid-json-blobs.json");
  await writeFile(
    batchPath,
    JSON.stringify({
      baseRevision: JSON.parse(inspected.stdout).package.revision,
      batchId: "batch_invalid_json_blobs",
      blobs: {},
      operations: [],
    }),
  );

  for (const extra of [[], ["--dry-run"]]) {
    const result = await runCli([
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
  const inspected = await runCli(["inspect", packagePath, "--json"]);
  assert.equal(inspected.code, 0, inspected.stderr);
  const revision = JSON.parse(inspected.stdout).package.revision;
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
  await writeFile(firstPath, JSON.stringify(batch("batch_concurrent_first", 0.2)));
  await writeFile(secondPath, JSON.stringify(batch("batch_concurrent_second", 0.8)));

  const results = await Promise.all([
    runCli(["apply", packagePath, "--batch", firstPath, "--json"]),
    runCli(["apply", packagePath, "--batch", secondPath, "--json"]),
  ]);

  assert.equal(results.filter(({ code }) => code === 0).length, 1);
  const rejected = results.find(({ code }) => code !== 0);
  assert.equal(JSON.parse(rejected.stdout).error.code, "stale_revision");
});

test("inspect-view resolves Tokens with the selected Context profile", async (context) => {
  const { packagePath } = await configuredCliPackage(context, [
    { contextFile: contextFile(), entry: "contexts/design.json", type: "put-context-file" },
    tokenOperation(),
  ]);

  const result = await runCli([
    "inspect-view",
    packagePath,
    "--context-profile",
    "ctx_dark",
    "--json",
  ]);
  assert.equal(result.code, 0, result.stderr);
  const view = JSON.parse(result.stdout);
  assert.deepEqual(view.selection.context, { axis_theme: "dark" });
  assert.deepEqual(view.tokens[0].context, view.selection.context);
});

test("impact includes Token bindings inside Component Set variants", async (context) => {
  const { packagePath } = await configuredCliPackage(context, [
    tokenOperation(),
    componentOperation(),
  ]);

  const result = await runCli([
    "impact",
    packagePath,
    "--token-id",
    "tok_brand",
    "--json",
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).locations, [
    {
      componentId: "cmp_button",
      field: "fill",
      kind: "component-node",
      nodeId: "node_button_source",
      variantId: "var_button_idle",
    },
  ]);
});

test("JSON design selectors reject unknown fields", async (context) => {
  const { packagePath, parent } = await configuredCliPackage(context);
  const contextsPath = join(parent, "invalid-contexts.json");
  await writeFile(contextsPath, JSON.stringify([{ screenID: "scr_roundtrip" }]));

  const result = await runCli([
    "render-matrix",
    packagePath,
    "--contexts",
    contextsPath,
    "--output",
    join(parent, "matrix"),
    "--json",
  ]);
  assert.equal(result.code, 1);
  const error = JSON.parse(result.stdout).error;
  assert.equal(error.code, "unknown_design_selector_field");
  assert.deepEqual(error.details.fields, ["screenID"]);
});

test("read serializes derived Snapshot indexes without embedding blobs", async (context) => {
  const { packagePath } = await configuredCliPackage(context, [tokenOperation()]);

  const result = await runCli(["read", packagePath, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const snapshot = JSON.parse(result.stdout);
  assert.equal(snapshot.domain.tokens.tok_brand.id, "tok_brand");
  assert.equal(snapshot.blobs, undefined);
});
