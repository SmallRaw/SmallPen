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
import { onlyScreen, pageHtml, seedLegacyIds } from "./helpers/named.mjs";

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

// The roundtrip package plus, written as files, the brand color Token and a
// one-variant Button bound to it (the parts tokenOperation() and
// componentOperation() name).
async function configuredCliPackage(context, operations = []) {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-cli-configured-"));
  context.after(() => rm(parent, { force: true, recursive: true }));
  const packagePath = join(parent, "configured.smallpen");
  await cp(fixture, packagePath, { recursive: true });
  await seedLegacyIds(packagePath, "roundtrip");
  const types = new Set(operations.map(({ type }) => type));
  if (types.has("put-token")) {
    await writeFile(join(packagePath, "tokens.css"), ":root {\n  --color-brand: #6750a4;\n}\n");
  }
  if (types.has("put-component-set")) {
    await mkdir(join(packagePath, "components"), { recursive: true });
    await writeFile(
      join(packagePath, "components", "components.html"),
      '<sp-component name="Button" props="State: idle">\n  <div class="w-[120px] h-[40px] bg-brand"></div>\n</sp-component>\n',
    );
  }
  if (types.size) {
    const checked = await runCli(["check", packagePath, "--json"]);
    assert.equal(checked.code, 0, checked.stdout);
  }
  return { packagePath, parent };
}

// A blank package from project init plus the Home page an agent writes.
async function initializedCliWorkspace(context) {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-cli-agent-"));
  context.after(() => rm(parent, { force: true, recursive: true }));
  const workspacePath = join(parent, "workspace");
  const result = await runCli(["init", workspacePath, "--json"]);
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const initialized = JSON.parse(result.stdout);
  await writeFile(
    join(initialized.packagePath, "tokens.css"),
    ":root {\n  --color-brand: #4f46e5;\n}\n",
  );
  await mkdir(join(initialized.packagePath, "pages"), { recursive: true });
  await writeFile(
    join(initialized.packagePath, "pages", "Home.html"),
    pageHtml(`<body class="flex flex-col p-[24px] gap-[16px] bg-[#ffffff]">
  <p data-name="Title" class="text-[24px] font-[700]">Home</p>
  <div data-name="Banner" class="w-[320px] h-[120px] bg-brand rounded-[12px]"></div>
</body>`, { title: "Home" }),
  );
  const checked = await runCli(["check", initialized.packagePath, "--json"]);
  assert.equal(checked.code, 0, checked.stdout);
  return { ...initialized, productPath: initialized.packagePath, parent };
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
  assert.match(root.stdout, /init\s+Create a blank package/);
  assert.match(root.stdout, /check\s+Check the package's HTML/);
  assert.match(root.stdout, /view\s+Look by name: spec for implementation/);
  assert.match(root.stdout, /export\s+Export spec, wireframe or PNG; --format html/);
  for (const command of [
    "help",
    "view",
    "export",
    "version",
    "init",
    "check",
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
    ["tokens", "token list"],
    ["token-export", "token export"],
    ["validate", "check --render"],
  ]) {
    const result = await runCli([command, "--help"]);
    assert.equal(result.code, 1, command);
    const { error } = JSON.parse(result.stdout);
    assert.equal(error.code, "unknown_command", command);
    assert.equal(error.details.suggestion, suggestion, command);
  }

  // Reads an agent does on the files themselves are gone.
  for (const removed of [
    "project",
    "component",
    "page",
    "flow",
    "canvas",
    "asset",
    "inspect",
    "list",
    "catalog",
    "search-components",
    "search-tokens",
    "impact",
    "apply",
    "repair",
    "import-draft",
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
  assert.match(view.stdout, /--as text\|spec\|wireframe\|png\|issues/);
  assert.match(view.stdout, /wireframe for\s+spatial orientation/);
  assert.match(view.stdout, /issues lists layout, text\s+and contrast problems/);

  const exported = await runCli(["export", "--help", "--full"]);
  assert.equal(exported.code, 0, exported.stderr);
  assert.match(exported.stdout, /--format text\|spec\|wireframe\|png/);
  assert.match(exported.stdout, /--evidence.*specification|--evidence writes PNG/s);
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

test("project creation preserves spaces in paths and does not write question state", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-cli-path-"));
  context.after(() => rm(parent, { force: true, recursive: true }));
  const path = join(parent, "workspace with spaces");
  const result = await runCli([
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
  assert.equal(result.productRevision, undefined, "one package: revision says it");
  assert.equal(result.component.name, "Button");
  assert.equal(result.component.variantCount, 1);
  assert.equal(result.component.axes[0].name, "State");
  assert.deepEqual(result.component.axes[0].values, ["idle"]);
  assert.deepEqual(result.component.mainVariant, {
    selection: ["State: idle"],
  });
  assert.deepEqual(result.tokenSources, [
    { path: "color-brand", value: "#6750a4" },
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
  // Ids come from names when the files carry none.
  assert.match(full.component.id, /^cmp_button/);
  assert.match(full.component.mainVariant.id, /^var_/);
  assert.deepEqual(full.component.mainVariant.selection, ["State: idle"]);
  assert.equal(full.component.tokenBindings.length, 1);
  assert.match(full.component.tokenBindings[0].assetId, /^tok_/);
  assert.equal(full.component.tokenBindings[0].packageId, "pkg_roundtrip");
  assert.equal(full.component.tokenBindings[0].path, "color-brand");


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

test("a malformed package file is named with its line and a check continuation", async (context) => {
  const { packagePath, parent } = await configuredCliPackage(context);
  const canonicalPath = await realpath(packagePath);
  const alias = join(parent, "linked-owner.smallpen");
  await symlink(packagePath, alias, "dir");
  const before = JSON.parse(
    (await runCli(["view", packagePath, "--json"])).stdout,
  ).revision;

  for (const entry of ["pages/Round Trip.html", "index.html"]) {
    const file = join(packagePath, entry);
    const original = await readFile(file);
    const invalid = "<!doctype html>\n<html>\n<body><div";
    await writeFile(file, invalid);

    const failed = await runCli(["view", alias, "--json"]);
    assert.equal(failed.code, 1);
    assert.equal(failed.stderr, "");
    const error = JSON.parse(failed.stdout).error;
    assert.equal(error.code, "html_parse_error");
    assert.equal(error.details.packagePath, canonicalPath);
    assert.equal(error.details.issues[0].file, entry);
    assert.ok(error.details.issues[0].line > 0);
    const next = error.details.nextOperations[0];
    assert.equal(next.when, "after-fixing-the-files");
    assert.deepEqual(next.argv, ["check", canonicalPath, "--json"]);

    const stillInvalid = await runCli(next.argv);
    assert.equal(stillInvalid.code, 1);
    assert.equal(JSON.parse(stillInvalid.stdout).issues[0].file, entry);
    assert.equal(await readFile(file, "utf8"), invalid);

    await writeFile(file, original);
    const valid = await runCli(next.argv);
    assert.equal(valid.code, 0, valid.stdout);
    assert.equal(JSON.parse(valid.stdout).revision, before);
  }
});

test("an external Agent can initialize, inspect, view and export by name using only public CLI", async (context) => {
  const initialized = await initializedCliWorkspace(context);
  assert.equal(initialized.status, "initialized");
  assert.equal(initialized.nextQuestion, undefined);

  const checked = await runCli(["check", initialized.productPath, "--render", "--json"]);
  assert.equal(checked.code, 0, checked.stderr);
  const inspected = JSON.parse(checked.stdout);
  assert.equal(inspected.ok, true);
  assert.equal(inspected.render.status, "valid");
  assertNoIds(inspected);
  assert.equal(inspected.summary.pages, 1);
  const stored = await openPackage(initialized.productPath);
  assert.equal(onlyScreen(stored).id, stored.manifest.defaultScreenId);


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
  assert.match(JSON.parse(wireframe.stdout).text, /\nASCII WIREFRAME\n/);

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
    "check",
    initialized.productPath,
    "--render",
    "--page",
    "Home",
    "--json",
  ]);
  assert.equal(validatedPage.code, 0, validatedPage.stderr);
  const pageCheck = JSON.parse(validatedPage.stdout);
  assert.equal(pageCheck.render.status, "valid");
  assert.equal(pageCheck.render.coverage.targetCount, 1);
  assertNoIds(pageCheck);
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
  assert.equal(image.revision, revision);
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
      (await runCli(["view", packagePath, "--json"])).stdout,
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
  // The agent recolors the rectangle in the page file.
  const pagePath = join(packagePath, "pages", "Round Trip.html");
  await writeFile(pagePath, (await readFile(pagePath, "utf8")).replace("bg-[#7c3aed]", "bg-[#ff0000]"));
  const tree = await imageDeliveryTree(parent);
  const after = await runCli(args, { cwd: parent });
  assert.equal(after.code, 0, after.stdout);
  const second = JSON.parse(after.stdout);
  const current = JSON.parse(
    (await runCli(["view", packagePath, "--json"])).stdout,
  );
  assertInlineImage(second, current.revision);
  assert.notEqual(second.revision, first.revision);
  assert.notEqual(second.renderHash, first.renderHash);
  assert.deepEqual(await imageDeliveryTree(parent), tree);
});

test("export rejects inline bytes and evidence without --format png", async (context) => {
  const { packagePath, parent } = await configuredCliPackage(context);
  // The first read leaves the reusable empty package lock directory.
  const warm = await runCli(["view", packagePath, "--json"], { cwd: parent });
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
    ["check", "--json"],
    ["check", "--json"],
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
    ["check", "--node-id", "node_rectangle"],
    ["check", "--all", undefined],
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

