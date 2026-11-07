import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { projectScreen } from "@smallpen/core";
import {
  LocalWorkspaceSession,
  openPackage,
  resolveWorkspace,
} from "@smallpen/local-package";

// A Foundation with the Button set (Style x Size) and a Product whose Screen
// holds two Button Instances: the situation a Foundation edit can turn stale.
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "apps", "cli", "bin", "smallpen.mjs");

function smallpen(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args, "--json"], (error, stdout) => {
      resolve({ code: error?.code ?? 0, json: JSON.parse(stdout) });
    });
  });
}

// The session closes before its directory goes (it holds write locks).
async function pair(context, workspace) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-variant-follow-"));
  context.after(async () => {
    await workspace.closeAll();
    await rm(root, { force: true, maxRetries: 10, recursive: true, retryDelay: 50 });
  });
  const foundationPath = join(root, "foundation.smallpen");
  await cp(join(here, "fixtures", "variant-button.smallpen"), foundationPath, {
    recursive: true,
  });
  const productPath = join(root, "product.smallpen");
  await mkdir(join(productPath, "screens"), { recursive: true });
  await mkdir(join(productPath, "tokens"), { recursive: true });
  const write = (path, value) =>
    writeFile(join(productPath, path), `${JSON.stringify(value, null, 2)}\n`);
  await write("manifest.json", {
    defaultScreenId: "scr_home",
    dependencies: [
      { activeThemeIds: [], packageId: "pkg_flowboard_foundation", path: "foundation.smallpen" },
    ],
    entries: {
      assets: [],
      components: [],
      contexts: [],
      requirements: [],
      scenarios: [],
      screens: ["screens/home.json"],
      tokens: ["tokens/product.json"],
    },
    formatVersion: 1,
    name: "Product",
    packageId: "pkg_variant_product",
    role: "product",
  });
  await write("tokens/product.json", {
    activeSetIds: [],
    activeThemeIds: [],
    id: "tlib_product",
    sets: [],
    themes: [],
  });
  const button = (id, x, selection) => ({
    children: [],
    height: 32,
    id,
    instance: {
      component: { assetId: "cmp_button", packageId: "pkg_flowboard_foundation" },
      variant: selection,
    },
    name: id,
    type: "INSTANCE",
    width: 96,
    x,
    y: 20,
  });
  await write("screens/home.json", {
    basePresentationId: "pres_home",
    counterparts: [],
    id: "scr_home",
    name: "Home",
    presentations: [
      {
        id: "pres_home",
        interactions: [],
        name: "desktop",
        nodes: {
          node_home: {
            children: ["node_ok", "node_cancel"],
            height: 100,
            id: "node_home",
            name: "Home",
            type: "FRAME",
            width: 300,
            x: 0,
            y: 0,
          },
          node_cancel: button("node_cancel", 140, { axis_size: "md", axis_style: "ghost" }),
          node_ok: button("node_ok", 20, { axis_size: "md", axis_style: "primary" }),
        },
        platform: "desktop",
        rootId: "node_home",
        viewport: { height: 100, width: 300 },
      },
    ],
  });
  return { foundationPath, productPath };
}

// The Foundation's Button set with `edit` applied, as one put-component-set.
async function putButton(locator, edit) {
  const foundation = await openPackage(locator);
  const set = structuredClone(foundation.domain.componentSets.get("cmp_button"));
  edit(set);
  return {
    baseRevision: foundation.revision,
    batchId: `edit_${Math.random().toString(16).slice(2)}`,
    operations: [{ componentSet: set, type: "put-component-set" }],
  };
}

async function homeInstances(productPath) {
  const screen = JSON.parse(await readFile(join(productPath, "screens/home.json"), "utf8"));
  const nodes = screen.presentations[0].nodes;
  return { cancel: nodes.node_cancel.instance.variant, ok: nodes.node_ok.instance.variant };
}

test("a Foundation value rename re-points the open Product's Instances in a batch of its own", async (context) => {
  const workspace = new LocalWorkspaceSession();
  const { foundationPath, productPath } = await pair(context, workspace);
  const product = await workspace.open(productPath);
  const foundation = workspace.describe((await openPackage(foundationPath)).locator);
  const result = await workspace.commit(
    foundation.locator,
    await putButton(foundation.locator, (set) => {
      set.axes[0].domain = set.axes[0].domain.map((value) => (value === "primary" ? "brand" : value));
      for (const variant of set.variants) {
        if (variant.selection.axis_style === "primary") variant.selection.axis_style = "brand";
      }
    }),
  );
  assert.equal(result.followedVariants.length, 1);
  assert.equal(result.followedVariants[0].instances, 1);
  assert.deepEqual(await homeInstances(productPath), {
    cancel: { axis_size: "md", axis_style: "ghost" },
    ok: { axis_size: "md", axis_style: "brand" },
  });
  assert.equal((await resolveWorkspace(productPath)).status, "ready");
  // The Product's follow-up is its own undo entry.
  await workspace.undo(product.locator);
  assert.deepEqual((await homeInstances(productPath)).ok, {
    axis_size: "md",
    axis_style: "primary",
  });
});

test("an Instance of a deleted Foundation variant draws with the closest one and waits in Repair", async (context) => {
  const workspace = new LocalWorkspaceSession();
  const { foundationPath, productPath } = await pair(context, workspace);
  await workspace.open(productPath);
  const foundation = workspace.describe((await openPackage(foundationPath)).locator);
  const result = await workspace.commit(
    foundation.locator,
    await putButton(foundation.locator, (set) => {
      set.variants = set.variants.filter(({ id }) => id !== "var_button_ghost_md");
    }),
  );
  assert.equal(result.followedVariants, undefined);

  const resolution = await resolveWorkspace(productPath);
  assert.equal(resolution.status, "repair");
  const [conflict] = resolution.conflicts;
  assert.equal(conflict.code, "missing_variant");
  assert.equal(conflict.degraded, true);
  assert.equal(conflict.path, "screens/home.json.presentations[0].nodes.node_cancel.instance.component");
  assert.deepEqual(
    conflict.choices.map(({ action }) => action),
    ["select-instance-variant", "retarget-reference", "recreate-product-asset", "remove-dependent-usage"],
  );
  // The closest variant agrees on the most Axes: ghost/sm.
  assert.deepEqual(conflict.choices[0].selection, { axis_size: "sm", axis_style: "ghost" });

  // Reads go on: the Instance draws with that variant and says why.
  const projection = projectScreen(resolution.product, "scr_home", {
    foundation: resolution.foundation,
  });
  assert.equal(projection.nodes.node_cancel.variantId, "var_button_ghost_sm");
  assert.deepEqual(
    projection.diagnostics.map(({ code, instanceId }) => [code, instanceId]),
    [["stale_instance_variant", "node_cancel"]],
  );
});

test("the CLI renders a Product with a stale Instance and repairs it with a chosen variant", async (context) => {
  const workspace = new LocalWorkspaceSession();
  const { foundationPath, productPath } = await pair(context, workspace);
  await workspace.open(productPath);
  const foundation = workspace.describe((await openPackage(foundationPath)).locator);
  await workspace.commit(
    foundation.locator,
    await putButton(foundation.locator, (set) => {
      set.variants = set.variants.filter(({ id }) => id !== "var_button_ghost_md");
    }),
  );
  await workspace.closeAll();

  const rendered = await smallpen(["export", productPath, "--page", "Home", "--format", "png", "--output", join(productPath, "..", "home.png")]);
  assert.equal(rendered.code, 0);
  // Replies leave out ids; the diagnostic names the Instance element.
  assert.deepEqual(
    rendered.json.diagnostics.map(({ code, element }) => [code, element]),
    [["stale_instance_variant", "node_cancel"]],
  );

  const listed = await smallpen(["project", "repair", productPath]);
  assert.equal(listed.json.status, "repair");
  const [select] = listed.json.conflicts[0].choices;
  assert.equal(select.action, "select-instance-variant");
  assert.deepEqual(select.command.argv.slice(-3), [
    "--selection",
    JSON.stringify({ axis_size: "sm", axis_style: "ghost" }),
    "--json",
  ]);

  const repaired = await smallpen([
    "project",
    "repair",
    productPath,
    "--conflict",
    "0",
    "--action",
    "select-instance-variant",
    "--selection",
    JSON.stringify({ axis_size: "md", axis_style: "secondary" }),
  ]);
  assert.equal(repaired.code, 0);
  assert.deepEqual((await homeInstances(productPath)).cancel, {
    axis_size: "md",
    axis_style: "secondary",
  });
  assert.equal((await resolveWorkspace(productPath)).status, "ready");
});
