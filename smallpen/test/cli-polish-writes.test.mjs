import { commandGuidance } from "../apps/cli/bin/help.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { OPERATION_SCHEMAS } from "@smallpen/core";
import { openPackage } from "@smallpen/local-package";

import { INIT_ANSWERS_EXAMPLE } from "../apps/cli/bin/schema.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "apps", "cli", "bin", "smallpen.mjs");

function runCli(args, cwd, env = {}) {
  // Schema and full-value checks opt into stdout; fixed-file transport is tested separately.
  if (
    (args[0] === "schema" || args.includes("--full")) &&
    !args.includes("--stdout")
  )
    args = [...args, "--stdout"];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: {
        ...process.env,
        LANG: "en_US.UTF-8",
        LC_ALL: "",
        LC_MESSAGES: "",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      let json;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = undefined;
      }
      resolve({ code, json, stdout });
    });
  });
}

async function initAcme(context) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "smallpen-cli-polish-")),
  );
  context.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    join(root, "answers.json"),
    JSON.stringify(INIT_ANSWERS_EXAMPLE),
  );
  const init = await runCli(
    ["project", "init", "acme", "--answers", "answers.json", "--confirm", "--json"],
    root,
  );
  assert.equal(init.code, 0, init.stdout);
  // The default layout is one self-contained Package for both roles.
  return {
    foundation: join(root, "acme", "acme.smallpen"),
    init: init.json,
    product: join(root, "acme", "acme.smallpen"),
    root,
  };
}

async function revisionOf(path, root) {
  return (await runCli(["project", "show", path, "--json"], root)).json.revision;
}

async function writeJson(root, name, value) {
  const path = join(root, name);
  await writeFile(path, JSON.stringify(value));
  return path;
}

async function addButton({ foundation, root }) {
  const batch = await writeJson(root, "button.json", {
    baseRevision: await revisionOf(foundation, root),
    batchId: "button-v1",
    operations: [OPERATION_SCHEMAS["put-component-set"].example],
  });
  const applied = await runCli(
    ["advanced", "apply", foundation, "--batch", batch, "--json"],
    root,
  );
  assert.equal(applied.code, 0, applied.stdout);
}

// init seeds a scenario that expects the Home root, so drawings go into it.
function homeDrawing(children) {
  return { children, into: "Home", page: "Home", platform: "mobile" };
}

function buttonInstance(extra = {}) {
  return {
    name: "Add button",
    props: { Style: "primary" },
    use: "Button",
    ...extra,
  };
}

async function homeNodes(path) {
  const pkg = await openPackage(path);
  return Object.values(
    pkg.entries["screens/first-design.json"].presentations[0].nodes,
  );
}

// Replies name things; stored ids only come back with --full.
function idKeys(value, path = "$") {
  if (Array.isArray(value))
    return value.flatMap((item, index) => idKeys(item, `${path}[${index}]`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => [
    ...((key === "id" || /(Id|Ids)$/.test(key)) && key !== "batchId"
      ? [`${path}.${key}`]
      : []),
    ...idKeys(item, `${path}.${key}`),
  ]);
}

test("init returns package, screen, root, and seeded ids", async (context) => {
  const { init, product, root } = await initAcme(context);
  assert.equal(init.layout, "single");
  assert.deepEqual(Object.keys(init.packages), ["package"]);
  assert.equal(init.packages.package.path, product);
  assert.equal(init.packages.package.revision, await revisionOf(product));
  assert.deepEqual(idKeys(init), [], "the default reply leaves out ids");
  assert.deepEqual(init.start.rootNode, { height: 844, width: 390 });
  assert.deepEqual(init.start.contextAxes, [
    { defaultValue: "mobile", name: "Platform", values: ["mobile"] },
  ]);
  assert.deepEqual(init.themes, [
    { active: true, path: "Theme/Light" },
    { active: false, path: "Theme/Dark" },
  ]);
  assert.deepEqual(
    init.seeded.tokens.map(({ path, type }) => [path, type]).sort(),
    [
      ["color.brand", "color"],
      ["radius.md", "border-radius"],
      ["spacing.md", "spacing"],
    ],
  );
  assert.deepEqual(
    init.seeded.tokenSets.map(({ name }) => name),
    ["base", "Theme/Light", "Theme/Dark"],
  );
  assert.deepEqual(
    init.seeded.componentSets.map(({ name, variants }) => [
      name,
      variants.length,
    ]),
    [["Button", 1]],
  );
  assert.match(init.themeUsage, /--theme Theme\/Dark/);
  assert.match(init.seeded.note, /by name/);
  assert.doesNotMatch(init.seeded.note, /\bids?\b/, "the guidance does not send the agent to ids");

  // --full returns the stored ids an apply batch needs.
  const fullRun = await runCli(
    ["project", "init", "acme-full", "--answers", "answers.json", "--confirm", "--json", "--full"],
    root,
  );
  assert.equal(fullRun.code, 0, fullRun.stdout);
  const full = fullRun.json;
  assert.equal(full.packages.package.packageId, "pkg_acme");
  assert.equal(full.start.screenId, "scr_home");
  assert.equal(full.start.presentationId, "pres_home_mobile");
  assert.equal(full.start.rootNode.id, "node_home_root");
  // The theme answer became token themes, not a Context axis.
  assert.deepEqual(
    full.start.contextAxes.map(({ id }) => id),
    ["axis_platform"],
  );
  assert.deepEqual(
    full.themes.map(({ active, path, setIds, themeId }) => [
      themeId,
      path,
      active,
      setIds,
    ]),
    [
      [
        "theme_theme_light",
        "Theme/Light",
        true,
        ["tset_base", "tset_theme_light"],
      ],
      [
        "theme_theme_dark",
        "Theme/Dark",
        false,
        ["tset_base", "tset_theme_dark"],
      ],
    ],
  );
  assert.deepEqual(
    full.seeded.tokens
      .map(({ path, setId, tokenId }) => [tokenId, path, setId])
      .sort(),
    [
      ["tok_color_brand", "color.brand", "tset_base"],
      ["tok_radius_md", "radius.md", "tset_base"],
      ["tok_spacing_md", "spacing.md", "tset_base"],
    ],
  );
  assert.deepEqual(
    full.seeded.componentSets.map(({ componentId, variants }) => [
      componentId,
      variants.map(({ variantId }) => variantId),
    ]),
    [["cmp_button", ["var_button_default"]]],
  );
});

test("init --layout foundation-product keeps the pair and the Product selects Foundation themes", async (context) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "smallpen-cli-polish-")),
  );
  context.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    join(root, "answers.json"),
    JSON.stringify(INIT_ANSWERS_EXAMPLE),
  );
  const {
    code,
    json: init,
    stdout,
  } = await runCli(
    [
      "project",
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
  assert.equal(code, 0, stdout);
  assert.equal(init.layout, "foundation-product");
  assert.equal(init.packages.foundation.packageId, undefined);
  assert.equal(init.packages.product.packageId, undefined);
  const foundationManifest = JSON.parse(
    await readFile(
      join(root, "acme", "acme-foundation.smallpen", "manifest.json"),
      "utf8",
    ),
  );
  assert.equal(foundationManifest.packageId, "pkg_acme_foundation");
  assert.equal(
    init.packages.foundation.path,
    join(root, "acme", "acme-foundation.smallpen"),
  );
  assert.equal(init.packages.product.path, join(root, "acme", "acme.smallpen"));
  assert.deepEqual(
    init.themes.map(({ path }) => path),
    ["Theme/Light", "Theme/Dark"],
  );
  const manifest = JSON.parse(
    await readFile(
      join(root, "acme", "acme.smallpen", "manifest.json"),
      "utf8",
    ),
  );
  assert.equal(manifest.packageId, "pkg_acme_product");
  assert.deepEqual(manifest.dependencies, [
    {
      activeThemeIds: ["theme_theme_light"],
      packageId: "pkg_acme_foundation",
      path: "acme-foundation.smallpen",
    },
  ]);
  const conflict = await runCli(
    [
      "project",
      "init",
      "acme2",
      "--layout",
      "foundation-product",
      "--answer",
      'foundationChoice="self-contained"',
      "--json",
    ],
    root,
  );
  assert.equal(conflict.json.error.code, "unknown_option");
  const invalid = await runCli(
    ["project", "init", "acme3", "--layout", "pair", "--json"],
    root,
  );
  assert.equal(invalid.json.error.code, "invalid_init_layout");
  assert.deepEqual(invalid.json.error.details.validValues, [
    "foundation-product",
    "single",
  ]);
});

test("help and schema explain replacement, blank creation and Foundation ownership", async () => {
  const applyHelp = commandGuidance("apply");
  assert.match(
    applyHelp,
    /foundation-product layout Tokens, themes, Context Axes, and shared Component\s+Sets go to the Foundation/,
  );
  assert.match(applyHelp, /--compact\] \[--inverse-out FILE\]/);
  const initHelp = (await runCli(["project", "init", "--help", "--full"])).stdout;
  assert.match(initHelp, /blank package/);
  assert.doesNotMatch(initHelp, /QUESTION_ID|status needs_input|cmp_button/);
  const putToken = (await runCli(["schema", "operation", "put-token"])).json;
  assert.match(putToken.existingId, /replaced whole/);
  assert.match(putToken.existingId, /tok_color_brand/);
  const putSet = (await runCli(["schema", "operation", "put-component-set"]))
    .json;
  assert.match(putSet.existingId, /cmp_button/);
  for (const command of [
    ["page", "draw"],
    ["flow", "link"],
    ["token", "set"],
  ]) {
    const help = (await runCli(["help", ...command])).stdout;
    assert.match(help, /--compact/, command.join(" "));
    assert.match(help, /--inverse-out/, command.join(" "));
  }
});

test("width/height advice is listed only near a sizing Token", async (context) => {
  const { foundation, product, root } = await initAcme(context);
  const card = (name, height) => ({
    fill: "#6750a4",
    height,
    name,
    width: 300,
  });
  const cards = await writeJson(
    root,
    "cards.json",
    homeDrawing([card("Card A", 47), card("Card B", 120)]),
  );
  const first = await runCli(
    ["page", "draw", product, "--intent", cards, "--dry-run", "--json"],
    root,
  );
  assert.equal(first.code, 0, first.stdout);
  assert.equal(
    first.json.warnings.some(
      ({ field }) => field === "width" || field === "height",
    ),
    false,
  );
  const suppressed = first.json.warningSummary.suppressed.fields;
  assert.ok(suppressed.height >= 2);
  assert.ok(suppressed.width >= 2);
  assert.match(first.json.warningSummary.note, /validate does not repeat/);

  const sizing = await runCli(
    [
      "token",
      "set",
      foundation,
      "--intent",
      await writeJson(root, "sizing.json", {
        tokens: [{ name: "size.control", type: "sizing", value: 48 }],
      }),
      "--json",
    ],
    root,
  );
  assert.equal(sizing.code, 0, sizing.stdout);
  const second = await runCli(
    [
      "page",
      "draw",
      product,
      "--intent",
      cards,
      "--dry-run",
      "--warning-detail",
      "full",
      "--json",
    ],
    root,
  );
  assert.equal(second.code, 0, second.stdout);
  const heights = second.json.warnings.filter(
    ({ field }) => field === "height",
  );
  assert.equal(
    (await homeNodes(product)).length,
    1,
    "dry runs leave only the Home root",
  );
  assert.equal(heights.length, 1);
  // Card A (height 47) is the one near size.control; the reply names no id.
  assert.equal(heights[0].value, 47);
  assert.equal(heights[0].nodeId, undefined);
  assert.equal(heights[0].suggestions[0].path, "size.control");
  assert.deepEqual(second.json.warningSummary.suppressed.fields, {
    height: suppressed.height - 1,
    width: suppressed.width,
  });
  const validated = await runCli(["validate", product, "--json"], root);
  assert.deepEqual(validated.json.warnings, []);
});

test("tokens labels follow the environment locale and --locale", async (context) => {
  const { product, root } = await initAcme(context);
  const english = await runCli(["token", "list", product, "--json"], root, {
    LANG: "en_US.UTF-8",
  });
  assert.deepEqual(english.json.labels, {
    context: "Design Context",
    items: "Effective Tokens",
  });
  assert.doesNotMatch(english.stdout, /[一-鿿]/);
  const chinese = await runCli(["token", "list", product, "--json"], root, {
    LANG: "zh_CN.UTF-8",
  });
  assert.deepEqual(chinese.json.labels, {
    context: "設計狀態",
    items: "有效設計變數",
  });
  const overridden = await runCli(
    ["token", "list", product, "--locale", "en", "--json"],
    root,
    {
      LANG: "zh_CN.UTF-8",
    },
  );
  assert.equal(overridden.json.labels.context, "Design Context");
  for (const target of [[], ["--page", "Home"]]) {
    const read = await runCli(["view", product, ...target, "--json"], root, {
      LANG: "en_US.UTF-8",
    });
    assert.equal(read.code, 0, read.stdout);
    assert.doesNotMatch(read.stdout, /[一-鿿]/, target.join(" "));
  }
});

test("page drawing instance text compiles to checked instance overrides", async (context) => {
  const workspace = await initAcme(context);
  const { product, root } = workspace;
  await addButton(workspace);
  const before = await revisionOf(product, root);
  const bad = await runCli(
    [
      "page",
      "draw",
      product,
      "--intent",
      await writeJson(
        root,
        "bad.json",
        homeDrawing([buttonInstance({ text: { Missing: "Add task" } })]),
      ),
      "--json",
    ],
    root,
  );
  assert.equal(bad.code, 1);
  assert.equal(bad.json.error.code, "unknown_element");
  // The component's elements by path below its root.
  assert.deepEqual(bad.json.error.details.elements.sort(), ["Label"]);
  assert.equal(await revisionOf(product, root), before);

  const good = await runCli(
    [
      "page",
      "draw",
      product,
      "--intent",
      await writeJson(
        root,
        "good.json",
        homeDrawing([buttonInstance({ text: { Label: "Add task" } })]),
      ),
      "--json",
    ],
    root,
  );
  assert.equal(good.code, 0, good.stdout);
  const inverse = JSON.parse(
    await readFile(good.json.inverseBatchPath, "utf8"),
  );
  assert.equal(inverse.baseRevision, good.json.revision);
  const node = (await homeNodes(product)).find(
    ({ name }) => name === "Add button",
  );
  assert.equal(node.type, "INSTANCE");
  assert.equal(node.instance.component.assetId, "cmp_button");
  assert.deepEqual(node.instance.overrides, {
    "node_button_label:text": "Add task",
  });
  assert.equal(Object.hasOwn(node, "overrides"), false);
});

test("--compact drops the inverse batch and --inverse-out keeps undo", async (context) => {
  const { foundation, root } = await initAcme(context);
  const intent = await writeJson(root, "tokens.json", {
    tokens: [{ name: "color.brand", value: "#123456" }],
  });
  const before = await revisionOf(foundation, root);
  const full = await runCli(
    [
      "token",
      "set",
      foundation,
      "--intent",
      intent,
      "--dry-run",
      "--full",
      "--json",
    ],
    root,
  );
  assert.equal(full.code, 0, full.stdout);
  assert.ok(full.json.inverseBatch, "--full keeps inverseBatch");
  assert.ok(full.json.guidance.undo);

  const undoPath = join(root, "undo.json");
  const compact = await runCli(
    [
      "token",
      "set",
      foundation,
      "--intent",
      intent,
      "--compact",
      "--inverse-out",
      undoPath,
      "--json",
    ],
    root,
  );
  assert.equal(compact.code, 0, compact.stdout);
  assert.equal(compact.json.inverseBatch, undefined);
  assert.equal(compact.json.guidance, undefined);
  assert.equal(compact.json.inverseBatchPath, undoPath);
  assert.equal(compact.json.undo.argv.at(-1), undoPath);
  assert.match(compact.json.summary, /^Applied token-set_.*1 changed file\(s\)/);
  assert.ok(compact.stdout.length < full.stdout.length);

  const undo = await runCli(
    ["advanced", "apply", foundation, "--batch", undoPath, "--compact", "--json"],
    root,
  );
  assert.equal(undo.code, 0, undo.stdout);
  assert.equal(undo.json.revision, before);
  assert.ok(undo.json.inverseBatchPath);
  assert.deepEqual(
    JSON.parse(await readFile(undoPath, "utf8")).baseRevision,
    compact.json.revision,
  );
});

test("a font fallback names the available fonts and the asset font import command", async (context) => {
  const { product, root } = await initAcme(context);
  const text = (name) => ({
    fontFamily: "Inter",
    fontSize: 16,
    name,
    text: "Hello",
  });
  const page = await runCli(
    [
      "page",
      "draw",
      product,
      "--intent",
      await writeJson(root, "text.json", homeDrawing([text("T1"), text("T2")])),
      "--json",
    ],
    root,
  );
  assert.equal(page.code, 0, page.stdout);
  const names = (await homeNodes(product))
    .filter(({ type }) => type === "TEXT")
    .map(({ name }) => name)
    .sort();
  assert.deepEqual(names, ["T1", "T2"]);
  const rendered = await runCli(
    [
      "export",
      product,
      "--page",
      "Home",
      "--format",
      "png",
      "--evidence",
      "--output",
      join(root, "r"),
      "--json",
    ],
    root,
  );
  assert.equal(rendered.code, 0, rendered.stdout);
  const fallbacks = rendered.json.diagnostics.filter(
    ({ code }) => code === "font_render_fallback",
  );
  assert.equal(fallbacks.length, 1);
  assert.equal(fallbacks[0].requestedFont, "Inter");
  assert.deepEqual([...fallbacks[0].elements].sort(), names);
  assert.equal(fallbacks[0].nodeIds, undefined);
  assert.deepEqual(fallbacks[0].availableFonts, ["Source Sans Pro (bundled)"]);
  assert.deepEqual(fallbacks[0].details, {
    requestedFont: "Inter",
    substituteFont: "Source Sans Pro",
  });
  assert.match(fallbacks[0].message, /asset font import/);
  assert.deepEqual(fallbacks[0].nextOperations[0].argv.slice(0, 4), [
    "asset", "font", "import",
    product,
  ]);
});

test("apply checks override paths against Foundation components", async (context) => {
  const workspace = await initAcme(context);
  const { product, root } = workspace;
  await addButton(workspace);
  const placed = await runCli(
    [
      "page",
      "draw",
      product,
      "--intent",
      await writeJson(root, "instance.json", homeDrawing([buttonInstance()])),
      "--json",
    ],
    root,
  );
  assert.equal(placed.code, 0, placed.stdout);
  const { id: nodeId } = (await homeNodes(product)).find(
    ({ name }) => name === "Add button",
  );
  const before = await revisionOf(product, root);
  const override = (overridePath) =>
    writeJson(root, `override-${overridePath.length}.json`, {
      baseRevision: before,
      batchId: `override-${overridePath.length}`,
      operations: [
        {
          nodeId,
          overridePath,
          screenId: "scr_home",
          type: "set-instance-override",
          value: "Add task",
        },
      ],
    });
  const misspelled = await runCli(
    [
      "advanced",
      "apply",
      product,
      "--batch",
      await override("node_buton_label:text"),
      "--json",
    ],
    root,
  );
  assert.equal(misspelled.code, 1, misspelled.stdout);
  assert.equal(misspelled.json.error.code, "missing_component_override_target");
  assert.equal(await revisionOf(product, root), before);
  const correct = await runCli(
    [
      "advanced",
      "apply",
      product,
      "--batch",
      await override("node_button_label:text"),
      "--json",
    ],
    root,
  );
  assert.equal(correct.code, 0, correct.stdout);
});
