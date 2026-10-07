import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createInitializationState,
  INITIALIZATION_QUESTION_IDS,
} from "@smallpen/core";
import {
  createBlankPackage,
  initializeWorkspace,
  openPackage,
  openWorkspace,
} from "@smallpen/local-package";

function answers() {
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
    firstOutput: "A reviewed home screen",
    firstScenario: "Signed out",
    firstScreen: "Home",
    foundationChoice: "create-new",
    initialComponents: ["Button"],
    initialTokens: ["color.brand", "spacing.md", "radius.md"],
    kindDetails: ["responsive", "local-first"],
    platforms: ["desktop", "mobile"],
    projectKind: "application",
    projectName: "Quincy Test",
    purpose: "Help users activate an account",
    sourceInputs: ["none"],
  };
}

test("a blank Package starts with one editable view and Theme Default", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-blank-package-"));
  const packagePath = join(parent, "Untitled.smallpen");
  context.after(() => rm(parent, { force: true, recursive: true }));

  const created = await createBlankPackage(packagePath);
  const snapshot = await openPackage(packagePath);
  const screen = snapshot.entries[snapshot.manifest.entries.screens[0]];
  const tokens = snapshot.entries[snapshot.manifest.entries.tokens[0]];

  assert.equal(created.packagePath, packagePath);
  assert.equal(snapshot.manifest.name, "Untitled");
  assert.equal(snapshot.manifest.defaultScreenId, screen.id);
  assert.equal(screen.name, "Page 1");
  assert.equal(screen.presentations.length, 1);
  assert.deepEqual(tokens.sets.map(({ name }) => name), ["Theme/Default"]);
  assert.deepEqual(
    tokens.themes.map(({ group, name }) => ({ group, name })),
    [{ group: "Theme", name: "Default" }],
  );
});

test("Initialization uses a stable persisted question protocol", () => {
  const initial = createInitializationState({}, {
    locale: "zh-TW",
    statePath: "/tmp/quincy-init.json",
  });
  assert.equal(initial.status, "needs_input");
  assert.equal(initial.nextQuestion.id, "projectKind");
  assert.equal(initial.nextQuestion.label, "專案類型");
  assert.equal(initial.nextQuestion.schema.type, "string");
  assert.deepEqual(initial.nextQuestion.continuation, {
    args: [
      "init",
      "<workspace-directory>",
      "--state",
      "/tmp/quincy-init.json",
      "--answer",
      "projectKind=<JSON>",
      "--json",
    ],
    operation: "smallpen.init.answer",
  });
  assert.deepEqual(initial.pendingQuestionIds, INITIALIZATION_QUESTION_IDS);
});

test("a confirmed Initialization Proposal atomically creates a valid workspace", async (context) => {
  const state = createInitializationState(answers());
  assert.equal(state.status, "proposal");
  assert.equal(state.proposal.packages.foundation.role, "foundation");
  assert.equal(state.proposal.packages.product.role, "product");

  const parent = await mkdtemp(join(tmpdir(), "smallpen-initialize-"));
  context.after(() => rm(parent, { force: true, recursive: true }));
  const workspacePath = join(parent, "quincy-workspace");
  await assert.rejects(
    initializeWorkspace(workspacePath, state.proposal),
    (error) => error?.code === "initialization_confirmation_required",
  );
  const initialized = await initializeWorkspace(
    workspacePath,
    state.proposal,
    { confirmed: true },
  );
  assert.equal(initialized.status, "initialized");
  const workspace = await openWorkspace(initialized.productPath);
  assert.equal(workspace.foundation.manifest.role, "foundation");
  assert.equal(workspace.product.manifest.role, "product");
  assert.equal(workspace.product.domain.scenarios.size, 1);
  assert.equal(workspace.product.domain.requirements.size, 1);
  assert.equal(workspace.foundation.domain.componentSets.size, 1);
  assert.equal(workspace.foundation.domain.tokens.size, 3);
  assert.equal(initialized.layout, "foundation-product");
  // The theme answer is the Foundation's token themes; the Product selects
  // them on its dependency and has an empty set of its own on top.
  const foundationTokens = JSON.parse(
    await readFile(join(initialized.foundationPath, "tokens", "foundation.json"), "utf8"),
  );
  assert.deepEqual(foundationTokens.sets.map(({ name }) => name), ["base", "Theme/light", "Theme/dark"]);
  assert.deepEqual(
    foundationTokens.themes.map(({ group, id, name, setIds }) => ({ group, id, name, setIds })),
    [
      { group: "Theme", id: "theme_theme_light", name: "light", setIds: ["tset_base", "tset_theme_light"] },
      { group: "Theme", id: "theme_theme_dark", name: "dark", setIds: ["tset_base", "tset_theme_dark"] },
    ],
  );
  assert.deepEqual(foundationTokens.activeThemeIds, ["theme_theme_light"]);
  assert.deepEqual(workspace.product.manifest.dependencies[0].activeThemeIds, ["theme_theme_light"]);
  assert.equal(workspace.foundation.domain.contextAxes.has("axis_theme"), false);
  const productTokens = JSON.parse(
    await readFile(join(initialized.productPath, "tokens", "product.json"), "utf8"),
  );
  assert.deepEqual(productTokens.sets.map(({ name }) => name), ["product"]);
  assert.deepEqual(productTokens.themes, []);
  assert.deepEqual(
    JSON.parse(await readFile(initialized.initializationBriefPath, "utf8")),
    answers(),
  );
  assert.deepEqual(
    JSON.parse(await readFile(initialized.initializationProposalPath, "utf8")),
    state.proposal,
  );

  await assert.rejects(
    initializeWorkspace(workspacePath, state.proposal, { confirmed: true }),
    (error) => error?.code === "workspace_already_exists",
  );
});

test("the default layout is one self-contained Package with token themes", async (context) => {
  const state = createInitializationState({
    ...answers(),
    contextAxes: [
      ...answers().contextAxes,
      {
        defaultValue: "Normal",
        id: "axis_contrast",
        kind: "theme",
        name: "Contrast",
        values: ["Normal", "High"],
      },
      {
        defaultValue: "regular",
        id: "axis_density",
        kind: "density",
        name: "Density",
        values: ["regular", "compact"],
      },
    ],
    foundationChoice: "self-contained",
  });
  assert.equal(state.proposal.layout, "single");
  assert.deepEqual(Object.keys(state.proposal.packages), ["package"]);
  const parent = await mkdtemp(join(tmpdir(), "smallpen-initialize-"));
  context.after(() => rm(parent, { force: true, recursive: true }));
  const initialized = await initializeWorkspace(join(parent, "single"), state.proposal, {
    confirmed: true,
  });
  assert.equal(initialized.layout, "single");
  assert.equal(initialized.productPath, undefined);
  const workspace = await openWorkspace(initialized.packagePath);
  assert.equal(workspace.foundation, undefined);
  const snapshot = workspace.product;
  assert.equal(snapshot.manifest.role, "foundation");
  assert.equal(snapshot.manifest.packageId, "pkg_quincy_test");
  assert.equal(snapshot.domain.componentSets.size, 1);
  assert.equal(snapshot.domain.scenarios.size, 1);
  // Theme-kind axes became theme groups; the density axis stays a Context.
  assert.deepEqual([...snapshot.domain.contextAxes.keys()].sort(), ["axis_density", "axis_platform"]);
  const library = snapshot.entries["tokens/tokens.json"];
  assert.deepEqual(library.sets.map(({ id }) => id), [
    "tset_base",
    "tset_theme_light",
    "tset_theme_dark",
    "tset_contrast_normal",
    "tset_contrast_high",
  ]);
  assert.deepEqual(library.sets[0].tokens.map(({ id }) => id), [
    "tok_color_brand",
    "tok_spacing_md",
    "tok_radius_md",
  ]);
  assert.deepEqual(
    library.themes.map((theme) => `${theme.group}/${theme.name}`),
    ["Theme/light", "Theme/dark", "Contrast/Normal", "Contrast/High"],
  );
  assert.deepEqual(library.activeThemeIds, ["theme_theme_light", "theme_contrast_normal"]);
  assert.deepEqual(
    state.proposal.tokenThemes.map(({ active, path }) => [path, active]),
    [["Theme/light", true], ["Theme/dark", false], ["Contrast/Normal", true], ["Contrast/High", false]],
  );
});
