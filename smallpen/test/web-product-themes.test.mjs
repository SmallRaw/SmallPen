import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createInitializationState,
  createWorkspaceRuntime,
  prepareOperationBatch,
  resolveEffectiveToken,
} from "@smallpen/core";
import { initializeWorkspace, openPackage } from "@smallpen/local-package";
import { compilePenpotChanges } from "@smallpen/penpot-adapter";

import { createWebWorkspaceSnapshot } from "../apps/background/src/web-projection.mjs";
import {
  createCanvasWorkspace,
  createDesignSystemWorkspace,
} from "../apps/background/src/workspace-view.mjs";
import { INIT_ANSWERS_EXAMPLE } from "../apps/cli/bin/schema.mjs";

// The Web token manager of a Product holds its Foundation's sets and themes
// (projection.cljs project-token-parts); docs/TOKEN-THEMES.md 3 and 5.
async function pair(context) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-web-themes-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const state = createInitializationState({
    ...INIT_ANSWERS_EXAMPLE,
    foundationChoice: "create-new",
  });
  const { foundationPath, productPath } = await initializeWorkspace(
    join(root, "acme"),
    state.proposal,
    { confirmed: true },
  );
  const foundationBefore = await openPackage(foundationPath);
  const { snapshot: foundation } = await prepareOperationBatch(foundationBefore, {
    baseRevision: foundationBefore.revision,
    batchId: "dark-brand",
    operations: [{
      setId: "tset_theme_dark",
      token: { id: "tok_color_brand_dark", name: "color.brand", type: "color", value: "#d0bcff" },
      type: "put-set-token",
    }],
  });
  return { foundation, product: await openPackage(productPath) };
}

function themeStatus(foundation, themeId, setIds) {
  return {
    "set-ids": setIds.map((id) => foundation.runtime.tokenSets[id]),
    "theme-ids": [foundation.runtime.tokenThemes[themeId]],
    type: "set-tokens-status",
  };
}

function commit(product, foundation, changes) {
  return compilePenpotChanges(
    product,
    { changes, commitId: "web-product-themes" },
    { libraries: [foundation] },
  );
}

test("a Product's theme switch in the Web token manager stores the whole selection", async (context) => {
  const { foundation, product } = await pair(context);
  const batch = commit(product, foundation, [
    themeStatus(foundation, "theme_theme_dark", ["tset_base", "tset_theme_dark"]),
  ]);
  assert.deepEqual(batch.operations, [
    { themePaths: ["Theme/Dark"], type: "set-active-token-themes" },
  ]);
  const { result, snapshot } = await prepareOperationBatch(product, batch, { foundation });
  assert.deepEqual(snapshot.manifest.dependencies[0].activeThemeIds, ["theme_theme_dark"]);
  assert.equal(
    resolveEffectiveToken(
      snapshot,
      { assetId: "tok_color_brand", packageId: foundation.manifest.packageId },
      { foundation },
    ).value,
    "#d0bcff",
  );
  // Penpot's undo sends the previous status; its inverse restores exactly.
  const undone = await prepareOperationBatch(snapshot, result.inverseBatch, { foundation });
  assert.equal(undone.snapshot.revision, product.revision);
  // Re-sending the active selection writes nothing.
  assert.deepEqual(
    commit(product, foundation, [
      themeStatus(foundation, "theme_theme_light", ["tset_base", "tset_theme_light"]),
    ]).operations,
    [],
  );
});

test("a Product cannot edit its Foundation's tokens or switch bare sets", async (context) => {
  const { foundation, product } = await pair(context);
  assert.throws(
    () => commit(product, foundation, [{
      attrs: { name: "base", tokens: {} },
      id: foundation.runtime.tokenSets.tset_base,
      type: "set-token-set",
    }]),
    { code: "foundation_tokens_read_only" },
  );
  assert.throws(
    () => commit(product, foundation, [{
      "set-ids": [foundation.runtime.tokenSets.tset_theme_dark],
      "theme-ids": [],
      type: "set-tokens-status",
    }]),
    { code: "token_set_selection_unsupported" },
  );
  assert.throws(
    () => commit(product, foundation, [
      themeStatus(foundation, "theme_theme_light", [
        "tset_base", "tset_theme_light", "tset_theme_dark",
      ]),
    ]),
    { code: "token_set_selection_unsupported" },
  );
});

test("the Web snapshot and the workbench list a Product's selection of Foundation themes", async (context) => {
  const { foundation, product: before } = await pair(context);
  const { snapshot: product } = await prepareOperationBatch(before, {
    baseRevision: before.revision,
    batchId: "pick-dark",
    operations: [{ themePaths: ["Theme/Dark"], type: "set-active-token-themes" }],
  }, { foundation });
  const web = await createWebWorkspaceSnapshot(product, { foundation, libraries: [] });
  assert.deepEqual(
    web.tokenThemes.map(({ active, owner, path }) => [path, owner, active]),
    [["Theme/Light", "foundation", false], ["Theme/Dark", "foundation", true]],
  );
  const workbench = createDesignSystemWorkspace({
    status: {},
    workspace: { foundation, libraries: [], product },
  });
  const domain = workbench.themeDomains.find((item) => item.domain === "Theme");
  assert.equal(domain.readOnly, true);
  assert.deepEqual(
    domain.themes.map(({ active, name }) => [name, active]),
    [["Light", false], ["Dark", true]],
  );
});

test("a Product's generated canvas offers and resolves its Foundation's themes", async (context) => {
  const { foundation, product } = await pair(context);
  const description = { status: {}, workspace: { foundation, libraries: [], product } };
  const current = await createCanvasWorkspace(description);
  const domain = current.enumeration.domains.find((item) => item.domain === "Theme");
  assert.deepEqual(domain.variants.map(({ name }) => name), ["Light", "Dark"]);
  assert.deepEqual(current.combination, [
    { domainId: domain.domainId, themeId: "theme_theme_light" },
  ]);
  // One specimen per winning token: the dark set's color.brand under Dark.
  const brand = (canvas) =>
    Object.values(canvas.render)
      .filter((row) => row.path === "color.brand")
      .map(({ resolved, setName }) => [setName, resolved]);
  assert.deepEqual(brand(current), [["base", "#6750a4"]]);
  const dark = await createCanvasWorkspace(description, { themes: ["theme_theme_dark"] });
  assert.deepEqual(dark.combination, [
    { domainId: domain.domainId, themeId: "theme_theme_dark" },
  ]);
  assert.deepEqual(brand(dark), [["Theme/Dark", "#d0bcff"]]);
});

test("a Product's Design System page refuses edits of Foundation Token Cells", async (context) => {
  const { foundation, product } = await pair(context);
  const runtime = await createWorkspaceRuntime(product, { foundation });
  const [shape, cell] = Object.entries(runtime.reverseDesignSystem).find(
    ([, ref]) => ref.kind === "token-cell" && ref.attribute === "fill" && ref.readOnly === true,
  );
  assert.equal(cell.ownerPackageId, foundation.manifest.packageId);
  const edit = (operations) => commit({ ...product, runtime }, foundation, [{
    id: shape,
    operations,
    "page-id": runtime.designSystemPage,
    type: "mod-obj",
  }]);
  assert.throws(
    () => edit([{ attr: "fills", type: "set", val: [{ "fill-color": "#ff0000", "fill-opacity": 1 }] }]),
    { code: "foundation_tokens_read_only" },
  );
  // The renderer's text and layout bookkeeping on those cells stays a no-op.
  assert.deepEqual(edit([{ attr: "position-data", type: "set", val: [] }]).operations, []);
});
