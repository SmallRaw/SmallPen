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
  const productTokens = JSON.parse(
    await readFile(join(initialized.productPath, "tokens", "product.json"), "utf8"),
  );
  assert.deepEqual(productTokens.sets.map(({ name }) => name), ["Theme/Default"]);
  assert.deepEqual(
    productTokens.themes.map(({ group, name }) => ({ group, name })),
    [{ group: "Theme", name: "Default" }],
  );
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
