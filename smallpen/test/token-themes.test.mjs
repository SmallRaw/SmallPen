// Token themes are Penpot token sets + themes: read-time --theme selection,
// the Foundation + Product contract, the set/theme operations, canonical
// shadows, and migrate-themes (upgrade by copy).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  collectCanvasTokenCatalog,
  createWorkspaceRuntime,
  createInitializationState,
  createWorkbenchPreview,
  enumerateWorkbenchCombinations,
  formatWarningsForBatch,
  listEffectiveTokens,
  prepareOperationBatch,
  resolveEffectiveToken,
  selectTokenThemes,
} from "@smallpen/core";
import {
  applyOperationBatch,
  initializeWorkspace,
  migrateThemesByCopy,
  openPackage,
  openWorkspace,
} from "@smallpen/local-package";

import { serveLocalPackage } from "@smallpen/background";

import { createWebLibrarySnapshot } from "../apps/background/src/web-projection.mjs";
import { INIT_ANSWERS_EXAMPLE } from "../apps/cli/bin/schema.mjs";

const cli = fileURLToPath(new URL("../apps/cli/bin/smallpen.mjs", import.meta.url));

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

async function scratch(context, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  context.after(() => rm(root, { force: true, recursive: true }));
  return root;
}

async function initialized(context, layout = "self-contained") {
  const root = await scratch(context, "smallpen-token-themes-");
  const state = createInitializationState({
    ...INIT_ANSWERS_EXAMPLE,
    foundationChoice: layout,
  });
  const result = await initializeWorkspace(join(root, "acme"), state.proposal, {
    confirmed: true,
  });
  return { root, ...result };
}

async function prepare(snapshot, operations, options) {
  return prepareOperationBatch(
    snapshot,
    { baseRevision: snapshot.revision, batchId: "themes-test", operations },
    options,
  );
}

const darkBrand = {
  setId: "tset_theme_dark",
  token: { id: "tok_color_brand_dark", name: "color.brand", type: "color", value: "#d0bcff" },
  type: "put-set-token",
};

function brandValue(product, options = {}) {
  return resolveEffectiveToken(
    product,
    { assetId: "tok_color_brand", packageId: options.packageId ?? product.manifest.packageId },
    options,
  )?.value;
}

test("--theme selects token themes for one read without writing", async (context) => {
  const { packagePath } = await initialized(context);
  const before = await openPackage(packagePath);
  const { snapshot } = await prepare(before, [darkBrand]);
  assert.equal(brandValue(snapshot), "#6750a4");
  const dark = selectTokenThemes({ product: snapshot }, ["Theme/Dark"]);
  assert.equal(brandValue(dark.product), "#d0bcff");
  // The stored selection is unchanged; the view is a separate object.
  assert.deepEqual(snapshot.entries["tokens/tokens.json"].activeThemeIds, ["theme_theme_light"]);
  assert.deepEqual(dark.product.entries["tokens/tokens.json"].activeThemeIds, ["theme_theme_dark"]);
  assert.equal(
    listEffectiveTokens(dark.product).find(({ token }) => token.path === "color.brand").value,
    "#d0bcff",
  );

  assert.throws(() => selectTokenThemes({ product: snapshot }, ["Theme/Blue"]), (error) =>
    error.code === "unknown_token_theme" &&
    error.details.group === "Theme" &&
    error.details.validThemes.join() === "Theme/Light,Theme/Dark");
  assert.throws(() => selectTokenThemes({ product: snapshot }, ["Mode/Dark"]), (error) =>
    error.code === "unknown_token_theme" && error.details.validGroups.join() === "Theme");
  assert.throws(
    () => selectTokenThemes({ product: snapshot }, ["Theme/Light", "Theme/Dark"]),
    { code: "duplicate_token_theme_group" },
  );
  assert.throws(() => selectTokenThemes({ product: snapshot }, ["Dark"]), {
    code: "invalid_theme_argument",
  });
});

// Writes an exact operation batch through `advanced apply`.
async function applyCli(root, packagePath, operations, name) {
  const { revision } = await openPackage(packagePath);
  await writeFile(join(root, `${name}.json`), JSON.stringify({
    baseRevision: revision,
    batchId: name,
    operations,
  }));
  return runCli(["advanced", "apply", packagePath, "--batch", `${name}.json`, "--json"], root);
}

// The PNG render of a page by name; renderHash identifies the pixels.
function renderPage(root, packagePath, ...extra) {
  return runCli(["view", packagePath, "--page", "Home", "--as", "png", ...extra, "--json"], root);
}

test("the CLI reads take --theme", async (context) => {
  const { packagePath, root } = await initialized(context);
  const written = await applyCli(root, packagePath, [
    darkBrand,
    {
      binding: { assetId: "tok_color_brand", packageId: "pkg_acme" },
      field: "fill",
      nodeId: "node_home_root",
      screenId: "scr_home",
      type: "set-token-binding",
    },
  ], "dark");
  assert.equal(written.code, 0, written.stdout);

  const tokens = await runCli(["token", "list", packagePath, "--theme", "Theme/Dark", "--json"], root);
  assert.equal(tokens.code, 0, tokens.stdout);
  assert.equal(tokens.json.items.find(({ token }) => token.path === "color.brand").value, "#d0bcff");
  assert.deepEqual(
    tokens.json.themes.map(({ active, owner, path }) => [path, active, owner]),
    [["Theme/Light", false, "package"], ["Theme/Dark", true, "package"]],
  );
  const effective = await runCli([
    "token", "show", packagePath, "--path", "color.brand", "--theme", "Theme/Dark", "--json",
  ], root);
  assert.equal(effective.code, 0, effective.stdout);
  assert.equal(effective.json.value, "#d0bcff");
  // The reply names the source set; --full keeps the stored token id.
  assert.equal(effective.json.token.group, "Theme/Dark");
  assert.equal(effective.json.sourceTokenId, undefined);
  const full = await runCli([
    "token", "show", packagePath, "--path", "color.brand", "--theme", "Theme/Dark", "--full", "--stdout", "--json",
  ], root);
  assert.equal(full.code, 0, full.stdout);
  assert.equal(full.json.sourceTokenId, "tok_color_brand_dark");
  const light = await renderPage(root, packagePath);
  const dark = await renderPage(root, packagePath, "--theme", "Theme/Dark");
  assert.equal(light.code, 0, light.stdout);
  assert.equal(dark.code, 0, dark.stdout);
  assert.notEqual(light.json.renderHash, dark.json.renderHash);
  assert.deepEqual(dark.json.selection.themes, ["Theme/Dark"]);
  const viewed = await runCli(["view", packagePath, "--page", "Home", "--theme", "Theme/Dark", "--json"], root);
  assert.equal(viewed.code, 0, viewed.stdout);
  assert.deepEqual(viewed.json.selection.themes, ["Theme/Dark"]);
  const unknown = await renderPage(root, packagePath, "--theme", "Theme/Sepia");
  assert.equal(unknown.code, 1);
  assert.equal(unknown.json.error.code, "unknown_token_theme");
  assert.deepEqual(unknown.json.error.details.validThemes, ["Theme/Light", "Theme/Dark"]);
  // Reads never write.
  assert.equal((await openPackage(packagePath)).entries["tokens/tokens.json"].activeThemeIds[0], "theme_theme_light");
});

test("a Product resolves the Foundation's sets by its own theme selection, its sets on top", async (context) => {
  const { foundationPath, productPath } = await initialized(context, "create-new");
  const foundationBefore = await openPackage(foundationPath);
  const { snapshot: foundation } = await prepare(foundationBefore, [darkBrand]);
  const productBefore = await openPackage(productPath);
  const reference = { packageId: "pkg_acme_foundation" };
  assert.equal(brandValue(productBefore, { ...reference, foundation }), "#6750a4");

  // The Product's stored selection, not the Foundation's, decides.
  const { result, snapshot: product } = await prepare(
    productBefore,
    [{ themePaths: ["Theme/Dark"], type: "set-active-token-themes" }],
    { foundation },
  );
  assert.deepEqual(product.manifest.dependencies[0].activeThemeIds, ["theme_theme_dark"]);
  assert.deepEqual(foundation.entries["tokens/foundation.json"].activeThemeIds, ["theme_theme_light"]);
  assert.equal(brandValue(product, { ...reference, foundation }), "#d0bcff");
  assert.equal(brandValue(foundation), "#6750a4");
  // The inverse restores the dependency exactly.
  const undone = await prepareOperationBatch(product, result.inverseBatch, { foundation });
  assert.equal(undone.snapshot.revision, productBefore.revision);

  // Without a stored selection the Foundation's own active themes apply.
  const inherited = structuredClone(productBefore.manifest);
  delete inherited.dependencies[0].activeThemeIds;
  assert.equal(brandValue({ ...productBefore, manifest: inherited }, { ...reference, foundation }), "#6750a4");

  // --theme on a Product names Foundation themes; unknown ones list them.
  const view = selectTokenThemes({ foundation, product: productBefore }, ["Theme/Dark"]);
  assert.equal(brandValue(view.product, { ...reference, foundation: view.foundation }), "#d0bcff");

  // A Product token of the same name in an active Product set sits on top.
  const { snapshot: overlaid } = await prepare(product, [{
    setId: "tset_product",
    token: { id: "tok_product_brand", name: "color.brand", type: "color", value: "#ff0000" },
    type: "put-set-token",
  }]);
  const resolved = resolveEffectiveToken(
    overlaid,
    { assetId: "tok_color_brand", packageId: "pkg_acme_foundation" },
    { foundation },
  );
  assert.equal(resolved.value, "#ff0000");
  assert.equal(resolved.sourcePackageId, "pkg_acme_product");
  assert.deepEqual(resolved.sourceChain.map(({ role }) => role), ["target", "set-override"]);

  // A write that does not load the Foundation cannot pick its themes.
  await assert.rejects(
    prepare(productBefore, [{ themePaths: ["Theme/Dark"], type: "set-active-token-themes" }]),
    (error) => error.code === "missing_token_theme" && /loads the Foundation/.test(error.message),
  );
});

test("a Product write that names Foundation themes loads the Foundation itself", async (context) => {
  const { productPath } = await initialized(context, "create-new");
  const before = await openPackage(productPath);
  // The Web backend applies batches without loading the Foundation.
  const result = await applyOperationBatch(productPath, {
    baseRevision: before.revision,
    batchId: "backend-theme",
    operations: [{ themePaths: ["Theme/Dark"], type: "set-active-token-themes" }],
  });
  const after = await openPackage(productPath);
  assert.deepEqual(after.manifest.dependencies[0].activeThemeIds, ["theme_theme_dark"]);
  await applyOperationBatch(productPath, result.inverseBatch);
  assert.equal((await openPackage(productPath)).revision, before.revision);
});

test("token set and theme operations validate and invert exactly", async (context) => {
  const { packagePath } = await initialized(context);
  const before = await openPackage(packagePath);
  const steps = [
    [darkBrand],
    [{ set: { id: "tset_contrast_high", name: "contrast/high", tokens: [] }, type: "put-token-set" }],
    [{ theme: { group: "Contrast", id: "theme_contrast_high", name: "High", setIds: ["tset_base"] }, type: "put-token-theme" }],
    [{ setId: "tset_theme_light", type: "delete-token-set" }],
    [{ themeId: "theme_theme_dark", type: "delete-token-theme" }],
    [{ tokenId: "tok_spacing_md", type: "remove-token" }],
    [{ tokenId: "tok_color_brand", type: "set-token-value", value: "#000000" }],
  ];
  for (const operations of steps) {
    const { result, snapshot } = await prepare(before, operations);
    assert.notEqual(snapshot.revision, before.revision, operations[0].type);
    const undone = await prepareOperationBatch(snapshot, result.inverseBatch);
    assert.equal(undone.snapshot.revision, before.revision, `${operations[0].type} inverse`);
  }
  const { snapshot: deleted } = await prepare(before, [{ setId: "tset_theme_light", type: "delete-token-set" }]);
  const library = deleted.entries["tokens/tokens.json"];
  assert.deepEqual(library.themes.find(({ id }) => id === "theme_theme_light").setIds, ["tset_base"]);
  const removed = (await prepare(before, [{ tokenId: "tok_spacing_md", type: "remove-token" }])).snapshot;
  assert.equal(removed.domain.tokens.has("tok_spacing_md"), false);

  const rejected = async (operations, code, pattern) => {
    await assert.rejects(prepare(before, operations), (error) => {
      assert.equal(error.code, code, error.message);
      if (pattern) assert.match(error.message, pattern);
      return true;
    });
  };
  await rejected(
    [{ setId: "tset_base", token: { id: "tok_other", name: "color.brand", type: "color", value: "#000000" }, type: "put-set-token" }],
    "duplicate_token_name",
    /tok_color_brand/,
  );
  await rejected(
    [{ setId: "tset_nope", token: { id: "tok_x", name: "x", type: "color", value: "#000000" }, type: "put-set-token" }],
    "missing_token_set",
    /tset_base \(base\)/,
  );
  await rejected(
    [{ theme: { group: "Theme", id: "theme_x", name: "X", setIds: ["tset_nope"] }, type: "put-token-theme" }],
    "invalid_token_theme_sets",
  );
  await rejected(
    [{ theme: { group: "Theme", id: "theme_other", name: "Dark", setIds: [] }, type: "put-token-theme" }],
    "duplicate_token_theme",
    /theme_theme_dark/,
  );
  await rejected(
    [{ set: { id: "tset_other", name: "base", tokens: [] }, type: "put-token-set" }],
    "duplicate_token_set_name",
  );
  await rejected(
    [{ definition: { $extensions: { smallpen: { id: "tok_y" } }, $type: "color", $value: "#000000" },
      filePath: "tokens/tokens.json", path: "color.y", tokenId: "tok_y", type: "put-token" }],
    "token_library_entry",
    /put-set-token/,
  );
  await rejected([{ tokenId: "tok_color_brand", type: "deprecate-token" }], "unsupported_token_deprecation");
  await rejected(
    [{ themePaths: ["Theme/Nope"], type: "set-active-token-themes" }],
    "missing_token_theme",
    /Theme\/Light, Theme\/Dark/,
  );
});

test("put-token-set creates a library whose new sets start active until themes exist", async (context) => {
  const { foundationPath } = await initialized(context, "create-new");
  const foundation = await openPackage(foundationPath);
  // Drop the library to start from a Package without one.
  const { snapshot: bare } = await prepare(foundation, [{ library: null, type: "replace-token-library" }]);
  const { result, snapshot } = await prepare(bare, [{
    set: {
      id: "tset_core",
      name: "core",
      tokens: [{ id: "tok_core_gap", name: "space.gap", type: "spacing", value: 12 }],
    },
    type: "put-token-set",
  }]);
  const library = snapshot.entries["tokens/tokens.json"];
  assert.deepEqual(library.activeSetIds, ["tset_core"]);
  assert.equal(library.sets[0].tokens[0].description, "");
  assert.equal(
    resolveEffectiveToken(snapshot, { assetId: "tok_core_gap", packageId: "pkg_acme_foundation" }).value,
    12,
  );
  const undone = await prepareOperationBatch(snapshot, result.inverseBatch);
  assert.equal(undone.snapshot.revision, bare.revision);
});

test("writes use the canonical shadow shape and reject {x, y} with a suggestion", async (context) => {
  const { packagePath } = await initialized(context);
  const before = await openPackage(packagePath);
  const shadowToken = (value) => ({
    setId: "tset_base",
    token: { id: "tok_shadow_card", name: "shadow.card", type: "shadow", value },
    type: "put-set-token",
  });
  await assert.rejects(
    prepare(before, [shadowToken({ blur: 4, color: "#00000040", spread: 0, x: 0, y: 2 })]),
    (error) => {
      assert.equal(error.code, "invalid_shadow_shape");
      assert.match(error.message, /offsetX\/offsetY/);
      assert.deepEqual(error.details.suggestion, {
        blur: 4,
        color: "#00000040",
        offsetX: 0,
        offsetY: 2,
        spread: 0,
      });
      return true;
    },
  );
  await assert.rejects(
    prepare(before, [{
      changes: { shadow: [{ blur: 4, color: "#000000", y: 2 }] },
      nodeId: "node_home_root",
      presentationId: "pres_home_mobile",
      screenId: "scr_home",
      type: "update-presentation-node",
    }]),
    (error) => error.code === "invalid_shadow_shape" && error.details.path.endsWith("changes.shadow[0]"),
  );
  await assert.rejects(
    prepare(before, [shadowToken({ blur: "soft", color: "#000000", offsetX: 0, offsetY: 2 })]),
    (error) => error.code === "invalid_shadow_shape" && error.details.field === "blur",
  );
  // Canonical shapes, Penpot's string lengths, and aliases are accepted.
  await prepare(before, [shadowToken({ blur: 4, color: "#00000040", offsetX: 0, offsetY: 2, spread: 0 })]);
  await prepare(before, [shadowToken([{ blur: "4", color: "#000000", offsetX: "0", offsetY: "2px" }])]);
  // An inverse batch may restore a legacy entry as it was.
  const screen = structuredClone(before.entries["screens/first-design.json"]);
  screen.presentations[0].nodes.node_home_root.shadow = { blur: 4, color: "#000000", x: 0, y: 2 };
  await prepare(before, [{
    entry: "screens/first-design.json",
    kind: "screens",
    type: "restore-canonical-entry",
    value: screen,
  }]);
});

test("put-token contextValues are accepted with a context_values_deprecated warning", async (context) => {
  const { packagePath, root } = await initialized(context);
  const operation = {
    definition: {
      $extensions: {
        smallpen: { contextValues: [{ value: 4, when: { axis_platform: "mobile" } }], id: "tok_gap" },
      },
      $type: "spacing",
      $value: 8,
    },
    filePath: "tokens/legacy.json",
    path: "space.gap",
    tokenId: "tok_gap",
    type: "put-token",
  };
  const themeAxis = {
    contextFile: {
      axes: [{ defaultValue: "light", id: "axis_mode", kind: "theme", name: "Mode",
        values: [{ id: "light", name: "light" }] }],
      profiles: [],
    },
    entry: "contexts/mode.json",
    type: "put-context-file",
  };
  assert.deepEqual(
    formatWarningsForBatch({ operations: [operation, themeAxis] })
      .map(({ code, operationIndex }) => [code, operationIndex]),
    [["context_values_deprecated", 0], ["theme_context_axis_deprecated", 1]],
  );
  const written = await applyCli(root, packagePath, [operation], "legacy");
  assert.equal(written.code, 0, written.stdout);
  const warning = written.json.warnings.find(({ code }) => code === "context_values_deprecated");
  assert.match(warning.message, /put-set-token/);
  assert.equal(written.json.warningSummary.formatWarnings, 1);
});

// A Foundation + Product pair themed the old way: contextValues on a
// theme-kind axis.
function legacyPair({ multiAxis = false } = {}) {
  const entries = () => ({
    assets: [], components: [], contexts: [], requirements: [], scenarios: [], screens: [], tokens: [],
  });
  const foundation = new Map([
    ["manifest.json", {
      entries: { ...entries(), contexts: ["contexts/foundation.json"], tokens: ["tokens/foundation.json"] },
      formatVersion: 1,
      name: "Legacy Foundation",
      packageId: "pkg_legacy_foundation",
      role: "foundation",
    }],
    ["contexts/foundation.json", {
      axes: [
        { defaultValue: "desktop", id: "axis_platform", kind: "viewport", name: "Platform",
          values: [{ id: "desktop", name: "desktop" }] },
        { defaultValue: "light", id: "axis_theme", kind: "theme", name: "Theme",
          values: [{ id: "light", name: "Light" }, { id: "dark", name: "Dark" }] },
        { defaultValue: "regular", id: "axis_density", kind: "density", name: "Density",
          values: [{ id: "regular", name: "regular" }, { id: "compact", name: "compact" }] },
      ],
      profiles: [{ default: true, id: "ctx_desktop", name: "desktop",
        values: { axis_density: "regular", axis_platform: "desktop", axis_theme: "light" } }],
    }],
    ["tokens/foundation.json", {
      color: {
        $type: "color",
        ink: { $extensions: { smallpen: { id: "tok_color_ink" } }, $value: "#222222" },
        surface: {
          $extensions: { smallpen: { contextValues: [{ value: "#101010", when: { axis_theme: "dark" } }], id: "tok_color_surface" } },
          $value: "#fafafa",
        },
        text: {
          $extensions: { smallpen: { contextValues: [{ value: "#eeeeee", when: { axis_theme: "dark" } }], id: "tok_color_text" } },
          $value: "{color.ink}",
        },
        ...(multiAxis
          ? {
              accent: {
                $extensions: { smallpen: { contextValues: [
                  { value: "#00ffff", when: { axis_density: "compact", axis_theme: "dark" } },
                ], id: "tok_color_accent" } },
                $value: "#0000ff",
              },
            }
          : {}),
      },
      shadow: {
        card: {
          $extensions: { smallpen: { contextValues: [
            { value: { blur: 8, color: "#000000", spread: 0, x: 0, y: 6 }, when: { axis_theme: "dark" } },
          ], id: "tok_shadow_card" } },
          $type: "shadow",
          $value: { blur: 4, color: "#00000040", spread: 0, x: 0, y: 2 },
        },
      },
      space: {
        gap: {
          $extensions: { smallpen: { contextValues: [{ value: 4, when: { axis_density: "compact" } }], id: "tok_space_gap" } },
          $type: "spacing",
          $value: 8,
        },
      },
    }],
  ]);
  const product = new Map([
    ["manifest.json", {
      defaultScreenId: "scr_home",
      dependencies: [{ packageId: "pkg_legacy_foundation", path: "legacy-foundation.smallpen" }],
      entries: {
        ...entries(),
        scenarios: ["scenarios/product.json"],
        screens: ["screens/home.json"],
        tokens: ["tokens/product.json"],
      },
      formatVersion: 1,
      name: "Legacy",
      packageId: "pkg_legacy_product",
      role: "product",
    }],
    // The library older init seeded: an empty Theme/Default theme and set.
    ["tokens/product.json", {
      activeSetIds: [],
      activeThemeIds: ["theme_default"],
      id: "tlib_product",
      sets: [{ description: "", id: "tset_theme_default", name: "Theme/Default", tokens: [] }],
      themes: [{
        description: "", externalId: "", group: "Theme", id: "theme_default",
        isSource: false, name: "Default", setIds: ["tset_theme_default"],
      }],
    }],
    ["scenarios/product.json", { scenarios: [{
      actions: [],
      context: { axis_platform: "desktop", axis_theme: "dark" },
      expectedVisibleNodeIds: ["node_root"],
      fixture: {},
      id: "scn_dark",
      name: "Dark",
      target: { kind: "screen", presentationId: "pres_home", screen: { assetId: "scr_home", packageId: "pkg_legacy_product" } },
      viewport: { height: 120, scale: 1, width: 200 },
    }] }],
    ["screens/home.json", {
      basePresentationId: "pres_home",
      counterparts: [],
      id: "scr_home",
      name: "Home",
      presentations: [{
        id: "pres_home",
        interactions: [],
        name: "desktop",
        nodes: {
          node_card: {
            children: [],
            fills: [{ color: "#ffffff", type: "solid" }],
            height: 40,
            id: "node_card",
            name: "Card",
            shadow: { blur: 2, color: "#000000", spread: 0, x: 3, y: 3 },
            tokenBindings: {
              fill: { assetId: "tok_color_text", packageId: "pkg_legacy_foundation" },
            },
            type: "RECTANGLE",
            width: 80,
            x: 20,
            y: 20,
          },
          node_panel: {
            children: [],
            fills: [{ color: "#ffffff", type: "solid" }],
            height: 30,
            id: "node_panel",
            name: "Panel",
            tokenBindings: {
              fill: { assetId: "tok_color_surface", packageId: "pkg_legacy_foundation" },
              shadow: { assetId: "tok_shadow_card", packageId: "pkg_legacy_foundation" },
            },
            type: "RECTANGLE",
            width: 60,
            x: 120,
            y: 60,
          },
          node_root: {
            children: ["node_card", "node_panel"],
            fills: [{ color: "#ffffff", type: "solid" }],
            height: 120,
            id: "node_root",
            name: "Home",
            tokenBindings: {
              fill: { assetId: "tok_color_surface", packageId: "pkg_legacy_foundation" },
            },
            type: "FRAME",
            width: 200,
            x: 0,
            y: 0,
          },
        },
        platform: "desktop",
        rootId: "node_root",
        viewport: { height: 120, width: 200 },
      }],
    }],
  ]);
  return { foundation, product };
}

async function writePackage(path, values) {
  for (const [entry, value] of values) {
    await mkdir(dirname(join(path, entry)), { recursive: true });
    await writeFile(join(path, entry), `${JSON.stringify(value, null, 2)}\n`);
  }
}

async function tree(path) {
  const files = {};
  for (const entry of await readdir(path, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    files[file.slice(path.length)] = await readFile(file, "utf8");
  }
  return files;
}

test("migrate-themes preserves a generated token entry that replaces an identically named legacy entry", async (context) => {
  const root = await scratch(context, "smallpen-migrate-same-entry-");
  const legacy = legacyPair();
  const manifest = legacy.foundation.get("manifest.json");
  manifest.entries.tokens = ["tokens/tokens.json"];
  legacy.foundation.set("tokens/tokens.json", legacy.foundation.get("tokens/foundation.json"));
  delete legacy.foundation.get("tokens/tokens.json").space;
  legacy.foundation.delete("tokens/foundation.json");
  await writePackage(join(root, "old", "legacy-foundation.smallpen"), legacy.foundation);
  await writePackage(join(root, "old", "legacy.smallpen"), legacy.product);
  const original = await tree(join(root, "old"));
  const migrated = await runCli([
    "project",
    "migrate", join(root, "old", "legacy.smallpen"), "--output", join(root, "new"), "--json",
  ], root);
  assert.equal(migrated.code, 0, migrated.stdout);
  const library = JSON.parse(await readFile(join(root, "new", "legacy-foundation.smallpen", "tokens", "tokens.json"), "utf8"));
  assert.ok(library.themes.some(theme => theme.name === "Dark"));
  assert.deepEqual(await tree(join(root, "old")), original);
});

test("migrate-themes copies a pair to token sets and themes and renders the same", async (context) => {
  const root = await scratch(context, "smallpen-migrate-themes-");
  const legacy = legacyPair();
  await writePackage(join(root, "old", "legacy-foundation.smallpen"), legacy.foundation);
  await writePackage(join(root, "old", "legacy.smallpen"), legacy.product);
  const original = await tree(join(root, "old"));

  const migrated = await runCli([
    "project",
    "migrate", join(root, "old", "legacy.smallpen"), "--output", join(root, "new"), "--json",
  ], root);
  assert.equal(migrated.code, 0, migrated.stdout);
  assert.deepEqual(await tree(join(root, "old")), original, "the original stays untouched");
  // The reply names themes and Tokens; the stored ids are checked below.
  assert.deepEqual(
    migrated.json.themes.map(({ active, path }) => [path, active]),
    [["Theme/Light", true], ["Theme/Dark", false]],
  );
  // The density rule is not a theme: that Token stays as it was, listed.
  const notMigrated = migrated.json.warnings.filter(({ code }) => code === "context_values_not_migrated");
  assert.deepEqual(notMigrated.map(({ path }) => path), ["tokens/foundation.json:space.gap"]);
  assert.ok(migrated.json.warnings.some(({ code }) => code === "legacy_shadows_normalized"));
  const removed = migrated.json.warnings.filter(({ code }) => code === "empty_theme_removed" || code === "empty_set_removed");
  assert.deepEqual(removed.map(({ code }) => code), ["empty_theme_removed", "empty_set_removed"]);
  assert.ok(removed.every(({ message }) => message.includes("Theme/Default")));

  const { foundation, product } = await openWorkspace(join(root, "new", "legacy.smallpen"));
  assert.deepEqual([...foundation.domain.contextAxes.keys()].sort(), ["axis_density", "axis_platform"]);
  assert.deepEqual(product.manifest.dependencies[0].activeThemeIds, ["theme_theme_light"]);
  // No stray Product set or theme is left in the migrated Theme group.
  const productLibrary = product.entries["tokens/product.json"];
  assert.deepEqual([productLibrary.sets, productLibrary.themes], [[], []]);
  assert.deepEqual([productLibrary.activeSetIds, productLibrary.activeThemeIds], [[], []]);
  const library = foundation.entries["tokens/tokens.json"];
  assert.deepEqual(library.themes.map(({ id }) => id), ["theme_theme_light", "theme_theme_dark"]);
  assert.deepEqual(library.activeThemeIds, ["theme_theme_light"]);
  assert.deepEqual(library.sets.map(({ name }) => name), ["base", "theme/light", "theme/dark"]);
  assert.deepEqual(
    library.sets[2].tokens.map(({ id, name }) => [id, name]),
    [
      ["tok_color_surface__dark", "color.surface"],
      ["tok_color_text__dark", "color.text"],
      ["tok_shadow_card__dark", "shadow.card"],
    ],
  );
  assert.deepEqual(library.sets[0].tokens.find(({ id }) => id === "tok_shadow_card").value, {
    blur: 4, color: "#00000040", offsetX: 0, offsetY: 2, spread: 0,
  });
  assert.deepEqual(product.domain.scenarios.get("scn_dark").themes, ["Theme/Dark"]);
  assert.deepEqual(product.domain.scenarios.get("scn_dark").context, { axis_platform: "desktop" });
  const card = product.entries["screens/home.json"].presentations[0].nodes.node_card;
  assert.deepEqual(card.shadow, { blur: 2, color: "#000000", offsetX: 3, offsetY: 3, spread: 0 });

  // Every theme renders byte for byte as the old Context did.
  for (const [theme, value] of [["Light", "light"], ["Dark", "dark"]]) {
    const before = await renderPage(root, join(root, "old", "legacy.smallpen"), "--context", `axis_theme=${value}`);
    const after = await renderPage(root, join(root, "new", "legacy.smallpen"), "--theme", `Theme/${theme}`);
    assert.equal(before.code, 0, before.stdout);
    assert.equal(after.code, 0, after.stdout);
    assert.equal(after.json.renderHash, before.json.renderHash, theme);
    assert.ok(before.json.diagnostics.some(({ code }) => code === "legacy_shadow_shape"));
    assert.ok(!after.json.diagnostics.some(({ code }) => code === "legacy_shadow_shape"));
  }

  // validate names the superseded forms and the upgrade; the copy has none.
  const oldValidation = await runCli(["validate", join(root, "old", "legacy.smallpen"), "--json"], root);
  assert.deepEqual(
    // Each warning points at its package by the path its upgrade runs on.
    oldValidation.json.warnings.map(({ code, nextOperations }) => [code, nextOperations[0].argv[1].split("/").at(-1)]),
    [
      ["context_values_deprecated", "legacy-foundation.smallpen"],
      ["legacy_shadow_shape", "legacy-foundation.smallpen"],
      ["legacy_shadow_shape", "legacy.smallpen"],
    ],
  );
  assert.equal(oldValidation.json.warnings[0].nextOperations[0].operation, "smallpen.migrate-themes");
  const newValidation = await runCli(["validate", join(root, "new", "legacy.smallpen"), "--json"], root);
  assert.deepEqual(newValidation.json.warnings, []);

  const again = await runCli([
    "project",
    "migrate", join(root, "old", "legacy.smallpen"), "--output", join(root, "new"), "--json",
  ], root);
  assert.equal(again.json.error.code, "migration_output_exists");
  const nothing = await runCli([
    "project",
    "migrate", join(root, "new", "legacy.smallpen"), "--output", join(root, "newer"), "--json",
  ], root);
  assert.equal(nothing.json.error.code, "no_theme_axes");
});

test("migrate-themes lists multi-axis rules it cannot express and keeps their axis", async (context) => {
  const root = await scratch(context, "smallpen-migrate-themes-");
  const legacy = legacyPair({ multiAxis: true });
  await writePackage(join(root, "old", "legacy-foundation.smallpen"), legacy.foundation);
  // A single Package: the Foundation alone.
  const result = await migrateThemesByCopy(
    join(root, "old", "legacy-foundation.smallpen"),
    join(root, "single.smallpen"),
  );
  const notMigrated = result.warnings.filter(({ code }) => code === "context_values_not_migrated");
  assert.deepEqual(notMigrated.map(({ tokenId }) => tokenId).sort(), ["tok_color_accent", "tok_space_gap"]);
  assert.deepEqual(
    notMigrated.find(({ tokenId }) => tokenId === "tok_color_accent").rules,
    [{ value: "#00ffff", when: { axis_density: "compact", axis_theme: "dark" } }],
  );
  assert.ok(result.warnings.some(({ axisId, code }) => code === "theme_axis_kept" && axisId === "axis_theme"));
  const migrated = await openPackage(join(root, "single.smallpen"));
  assert.ok(migrated.domain.contextAxes.has("axis_theme"));
  // The kept Token still resolves through its Context.
  assert.equal(
    resolveEffectiveToken(
      migrated,
      { assetId: "tok_color_accent", packageId: "pkg_legacy_foundation" },
      { context: { axis_density: "compact", axis_theme: "dark" } },
    ).value,
    "#00ffff",
  );
  await assert.rejects(
    migrateThemesByCopy(join(root, "old", "legacy-foundation.smallpen"), join(root, "plain")),
    { code: "invalid_package_path" },
  );
});

test("a Product's Design System canvas and workbench include its Foundation's themes", async (context) => {
  const { foundationPath, productPath } = await initialized(context, "create-new");
  const { snapshot: foundation } = await prepare(await openPackage(foundationPath), [darkBrand]);
  const product = await openPackage(productPath);
  const enumeration = enumerateWorkbenchCombinations(product, { foundation });
  assert.deepEqual(enumeration.diagnostics, []);
  assert.deepEqual(
    enumeration.domains.map(({ currentProjectThemeId, domain, variants }) => [
      domain,
      currentProjectThemeId,
      variants.map(({ packageId, themeId }) => `${packageId}:${themeId}`),
    ]),
    [["Theme", "theme_theme_light", [
      "pkg_acme_foundation:theme_theme_light",
      "pkg_acme_foundation:theme_theme_dark",
    ]]],
  );
  // Without the Foundation the Product has no theme to offer.
  assert.deepEqual(enumerateWorkbenchCombinations(product).domains, []);

  const dark = [{ domainId: "domain_Theme", themeId: "theme_theme_dark" }];
  const catalog = collectCanvasTokenCatalog(product, { combination: dark, foundation });
  const brandRows = catalog.rows.filter(({ path }) => path === "color.brand");
  assert.deepEqual(
    brandRows.map(({ active, observed, ownerPackageId, setId }) => [ownerPackageId, setId, active, observed]),
    [
      ["pkg_acme_foundation", "tset_theme_dark", false, true],
      ["pkg_acme_foundation", "tset_base", true, true],
    ],
  );
  const preview = await createWorkbenchPreview(product, dark, { foundation });
  const brand = preview.tokens.find(({ path }) => path === "color.brand");
  assert.equal(brand.resolved, "#d0bcff");
  assert.equal(brand.ownerPackageId, "pkg_acme_foundation");
  assert.equal(brand.homeSetId, "tset_theme_dark");
  // The preview never writes the Product's stored selection.
  assert.deepEqual(product.manifest.dependencies[0].activeThemeIds, ["theme_theme_light"]);
});

test("search-tokens searches the active themes and says so; --all-themes searches every one", async (context) => {
  const { packagePath, root } = await initialized(context);
  const written = await applyCli(root, packagePath, [darkBrand], "dark");
  assert.equal(written.code, 0, written.stdout);
  const search = (...extra) =>
    runCli(["token", "search", packagePath, "--color", "#d0bcff", "--limit", "5", ...extra, "--json"], root);

  const active = await search();
  assert.deepEqual(active.json.themeScope, { mode: "active", selections: [["Theme/Light"]] });
  assert.notEqual(active.json.items[0].value, "#d0bcff");
  const explicit = await search("--theme", "Theme/Dark");
  assert.deepEqual(explicit.json.themeScope, { mode: "explicit", selections: [["Theme/Dark"]] });
  assert.equal(explicit.json.items[0].value, "#d0bcff");
  const all = await search("--all-themes");
  assert.deepEqual(all.json.themeScope, { mode: "all", selections: [["Theme/Light"], ["Theme/Dark"]] });
  assert.equal(all.json.items[0].value, "#d0bcff");
  assert.deepEqual(all.json.items[0].themes, [["Theme/Dark"]]);
  const both = await search("--all-themes", "--theme", "Theme/Dark");
  assert.equal(both.json.error.code, "conflicting_theme_options");
});

test("a Product's generated Design System page shows the Foundation's token sets and themes", async (context) => {
  const { foundationPath, productPath } = await initialized(context, "create-new");
  const { snapshot: foundation } = await prepare(await openPackage(foundationPath), [darkBrand]);
  const product = await openPackage(productPath);
  // Loaded alone the Product shows one "Default" combination and no Cell.
  assert.deepEqual(product.runtime.designSystemRefs.combinations.map(({ label }) => label), ["Default"]);
  assert.deepEqual(Object.keys(product.runtime.designSystemRefs.specimens), []);
  const runtime = await createWorkspaceRuntime(product, { foundation });
  const refs = runtime.designSystemRefs;
  assert.deepEqual(refs.combinations.map(({ id }) => id), ["theme_theme_light", "theme_theme_dark"]);
  const brand = Object.values(refs.specimens).filter(({ path }) => path === "color.brand");
  assert.deepEqual(
    brand.map(({ combinationId, ownerPackageId, readOnly, resolved, setId, status, writable }) =>
      [combinationId, setId, resolved, status, ownerPackageId, writable, readOnly]),
    [
      ["theme_theme_light", "tset_base", "#6750a4", "active", "pkg_acme_foundation", false, true],
      ["theme_theme_dark", "tset_base", "#6750a4", "active", "pkg_acme_foundation", false, true],
      ["theme_theme_dark", "tset_theme_dark", "#d0bcff", "archived", "pkg_acme_foundation", false, true],
    ],
  );
  // Runtime ids of the Product itself do not move.
  assert.equal(runtime.file, product.runtime.file);
  assert.deepEqual(runtime.nodes, product.runtime.nodes);
  // A Foundation change shows on the next build; no Foundation, no change.
  const { snapshot: changed } = await prepare(foundation, [{ tokenId: "tok_color_brand", type: "set-token-value", value: "#000000" }]);
  const rebuilt = (await createWorkspaceRuntime(product, { foundation: changed })).designSystemRefs;
  assert.equal(
    Object.values(rebuilt.specimens).find(({ path, setId }) => path === "color.brand" && setId === "tset_base").resolved,
    "#000000",
  );
  assert.equal(await createWorkspaceRuntime(product), product.runtime);
});

test("the Web workspace of a Product carries the Foundation's Design System Cells and follows Foundation edits", async (context) => {
  const { foundationPath, productPath } = await initialized(context, "create-new");
  const service = await serveLocalPackage({ packagePath: productPath, port: 0 });
  context.after(() => service.close());
  const read = () => fetch(`${service.url}/v1/workspace`).then((response) => response.json());
  // The page data is not part of the workspace: the page fetches it.
  const refs = () =>
    fetch(`${service.url}/v1/design-system-refs`).then((response) => response.json());
  const brandBase = ({ designSystemRefs }) =>
    Object.values(designSystemRefs.specimens)
      .find(({ path, setId }) => path === "color.brand" && setId === "tset_base")?.resolved;
  const first = await read();
  assert.equal(first.runtime.designSystemRefs, undefined);
  assert.equal(first.runtime.designSystemRefsDeferred, true);
  const firstRefs = await refs();
  assert.equal(firstRefs.revision, first.revision);
  assert.deepEqual(
    firstRefs.designSystemRefs.combinations.map(({ id }) => id),
    ["theme_theme_light", "theme_theme_dark"],
  );
  // The Foundation travels as the Web loads it as a library file: its own
  // entries and runtime, with its component trees expanded.
  const stored = await createWebLibrarySnapshot(await openPackage(foundationPath));
  assert.equal(first.libraries.length, 1);
  assert.deepEqual(first.libraries[0].entries, JSON.parse(JSON.stringify(stored.entries)));
  assert.deepEqual(first.libraries[0].runtime, JSON.parse(JSON.stringify(stored.runtime)));
  // The Product never shows the Foundation's own Design System page.
  assert.equal(first.libraries[0].runtime.designSystemRefs, undefined);
  assert.equal(first.libraries[0].runtime.reverseDesignSystem, undefined);
  assert.equal(brandBase(firstRefs), "#6750a4");
  // An outside write to the Foundation reaches the Product's next read.
  const foundation = await openPackage(foundationPath);
  await applyOperationBatch(foundationPath, {
    baseRevision: foundation.revision,
    batchId: "foundation-brand",
    operations: [{ tokenId: "tok_color_brand", type: "set-token-value", value: "#123456" }],
  });
  let value;
  for (let attempt = 0; attempt < 50 && value !== "#123456"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    value = brandBase(await refs());
  }
  assert.equal(value, "#123456");
});

test("Foundation specimens on a Product's Design System page have the own-package specimen shape", async (context) => {
  // The same Cells, once in a self-contained Package and once in a Foundation.
  const cells = [
    { id: "tok_space_1", name: "space.1", type: "spacing", value: 4 },
    { id: "tok_space_alias", name: "space.alias", type: "spacing", value: "{space.1}" },
    { id: "tok_size_1", name: "size.1", type: "sizing", value: 24 },
    { id: "tok_width_1", name: "border.width", type: "stroke-width", value: 1 },
    { id: "tok_shadow_1", name: "shadow.1", type: "shadow", value: { blur: 4, color: "#00000033", offsetX: 0, offsetY: 2, spread: 0 } },
    { id: "tok_type_1", name: "type.body", type: "typography", value: { fontFamily: "Source Sans Pro", fontSize: 14, fontWeight: 400 } },
    { id: "tok_opacity_1", name: "opacity.1", type: "opacity", value: 0.5 },
    { id: "tok_rotation_1", name: "rotation.1", type: "rotation", value: 45 },
    { id: "tok_number_1", name: "number.1", type: "number", value: 2 },
    { id: "tok_string_1", name: "string.1", type: "string", value: "Label" },
    { id: "tok_family_1", name: "font.family", type: "font-family", value: "Source Sans Pro" },
    { id: "tok_weight_1", name: "font.weight", type: "font-weight", value: 700 },
  ];
  const operations = [
    ...cells.map((token) => ({ setId: "tset_base", token, type: "put-set-token" })),
    darkBrand,
    {
      setId: "tset_theme_dark",
      token: { id: "tok_space_1_dark", name: "space.1", type: "spacing", value: 6 },
      type: "put-set-token",
    },
  ];
  const single = await initialized(context);
  const { snapshot: own } = await prepare(await openPackage(single.packagePath), operations);
  const pair = await initialized(context, "create-new");
  const { snapshot: foundation } = await prepare(await openPackage(pair.foundationPath), operations);
  const product = await openPackage(pair.productPath);
  const ownSpecimens = own.runtime.designSystemRefs.specimens;
  const workspace = (await createWorkspaceRuntime(product, { foundation })).designSystemRefs.specimens;
  const prefix = "pkg_acme_foundation:";
  const shape = (specimen) => Object.keys(specimen).sort().join(",");
  let compared = 0;
  for (const [key, specimen] of Object.entries(ownSpecimens)) {
    const foreign = workspace[`${prefix}${key}`];
    assert.ok(foreign, `missing Foundation specimen ${key}`);
    assert.equal(shape(foreign), shape(specimen), key);
    assert.equal(foreign.children?.length, specimen.children?.length, `${key} children`);
    for (const child of foreign.children ?? []) assert.match(child, /^[0-9a-f-]{36}$/);
    assert.equal(foreign.readOnly, true);
    assert.equal(specimen.readOnly, false);
    compared += 1;
  }
  assert.ok(compared >= cells.length * 2, `compared ${compared}`);
  // Every gap specimen, read-only ones included, has its two filler ids.
  for (const specimen of Object.values(workspace)) {
    if (specimen.attribute === "gap") assert.equal(specimen.children?.length, 2, specimen.path);
  }
});
