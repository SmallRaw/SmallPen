// DSE-004/005/006: the generated Design System page translates native edits
// back to their real source (Token Cell / component definition), rejects
// decorations and structural mutations, and leaves ordinary page edits and
// the canonical manifest untouched.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { canonicalJSON } from "@smallpen/core";
import { compilePenpotChanges } from "@smallpen/penpot-adapter";
import { applyOperationBatch, openPackage } from "@smallpen/local-package";

import {
  buildEditorFoundationValues,
  buildEditorPackageValues,
  EDITOR_NESTED_NODES,
} from "./fixtures/design-system-editor-fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));

async function writePackage(dir, values) {
  for (const [entry, value] of values) {
    const path = join(dir, entry);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value, null, 2));
  }
}

async function editorPackage() {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-dse-gate-"));
  const packagePath = join(parent, "editor.smallpen");
  await writePackage(packagePath, buildEditorPackageValues());
  await writePackage(`${parent}/canvas-shared.smallpen`, buildEditorFoundationValues());
  const snapshot = await openPackage(packagePath);
  return { packagePath, parent, snapshot };
}

const COLOR_TOKEN_ID = "tok_canvas_color_light_primary";
const RADIUS_TOKEN_ID = "tok_canvas_radius_base";
const SIZING_TOKEN_ID = "tok_canvas_sizing_control";
const SPACING_TOKEN_ID = "tok_canvas_spacing_desktop_small";
const STROKE_TOKEN_ID = "tok_canvas_stroke_border_width";
const SHADOW_TOKEN_ID = "tok_canvas_effect_elevation";
const ALIAS_TOKEN_ID = "tok_canvas_radius_alias_pill";

// DSE-R17/R26: a Cell materializes ONE specimen per Workbench Combination
// in view. Edit tests are combination-agnostic (every specimen of a Cell
// writes that same Cell), so the helper resolves through the key index and
// picks the first specimen; combination-specific assertions use
// specimensOf().
function specimen(snapshot, tokenId) {
  const refs = snapshot.runtime.designSystemRefs;
  const keys = refs.specimenKeysByToken?.[tokenId] ?? [tokenId];
  return refs.specimens?.[keys[0]];
}

function specimensOf(snapshot, tokenId) {
  const refs = snapshot.runtime.designSystemRefs;
  const keys = refs.specimenKeysByToken?.[tokenId] ?? [tokenId];
  return keys.map((key) => refs.specimens[key]);
}

function modObject(id, operations, pageId) {
  return {
    id,
    operations,
    ...(pageId ? { "page-id": pageId } : {}),
    type: "mod-obj",
  };
}

test("runtime carries design-system refs for every supported token type", async () => {
  const { parent, snapshot } = await editorPackage();
  try {
    const refs = snapshot.runtime.designSystemRefs;
    assert.ok(refs, "designSystemRefs missing");
    const expected = [
      [COLOR_TOKEN_ID, "fill"],
      [RADIUS_TOKEN_ID, "radius"],
      [SIZING_TOKEN_ID, "height"],
      [STROKE_TOKEN_ID, "stroke-width"],
      [SHADOW_TOKEN_ID, "shadow"],
    ];
    for (const [tokenId, attribute] of expected) {
      const ref = specimen(snapshot, tokenId);
      assert.ok(ref, `specimen missing for ${tokenId}`);
      assert.equal(ref.attribute, attribute, `${tokenId} attribute`);
      assert.equal(ref.ownerPackageId, snapshot.manifest.packageId);
      assert.ok(snapshot.runtime.reverseDesignSystem[ref.shape]);
    }
    // Alias Cells are VISIBLE displays (DSE-R10) but must never become
    // direct write targets: their ref is marked not writable, and an edit
    // fails with a precise code instead of silently dropping.
    const aliasRef = specimen(snapshot, ALIAS_TOKEN_ID);
    assert.ok(aliasRef, "alias Cell missing from the catalog");
    assert.equal(aliasRef.writable, false, "alias Cell must not be writable");
    assert.equal(aliasRef.alias, true, "alias state must be explicit");
    assert.equal(aliasRef.status, "active", "active alias state must be explicit");
    assert.ok(aliasRef.caption, "alias Cell must have a visible caption id");
    assert.equal(
      snapshot.runtime.reverseDesignSystem[aliasRef.caption]?.kind,
      "label",
      "token captions must be projection-only decorations",
    );
    const archivedRef = Object.values(refs.specimens).find(
      (candidate) => candidate.status === "archived",
    );
    assert.ok(archivedRef, "archived Cell state missing from the catalog");
    assert.ok(
      !snapshot.entries["tokens/canvas.json"].activeSetIds.includes(
        archivedRef.setId,
      ),
      "archived status must follow the active Set combination",
    );
    assert.ok(
      refs.tokenGroups.some(
        (group) =>
          group.ownerPackageId === snapshot.manifest.packageId &&
          group.setId === archivedRef.setId &&
          group.type === archivedRef.type &&
          snapshot.runtime.reverseDesignSystem[group.header]?.kind === "label",
      ),
      "source / Token Set / type group must have a visible header",
    );
    assert.throws(
      () =>
        compilePenpotChanges(snapshot, {
          changes: [
            modObject(
              aliasRef.shape,
              [
                {
                  type: "set",
                  attr: "fills",
                  val: [{ "fill-color": "#22c55e", "fill-opacity": 1 }],
                },
              ],
              snapshot.runtime.designSystemPage,
            ),
          ],
          commitId: "dse-gate-alias",
        }),
      (error) => error.code === "design_system_token_readonly",
      "alias Cell edit must not silently no-op",
    );
    // DSE-R10: the renderer's text-measure pass emits pure `position-data`
    // syncs for the projected TEXT displays (typography Cells, captions).
    // That bookkeeping rides in the same commit as real edits, so a
    // bookkeeping-only mod-obj must compile to no operations instead of
    // failing the whole batch.
    const fillRef = specimen(snapshot, COLOR_TOKEN_ID);
    assert.ok(fillRef?.writable, "writable color specimen missing");
    const positionDataVal = { x1: 0, y1: 0, width: 96, height: 48 };
    const bookkeepingOnly = compilePenpotChanges(snapshot, {
      changes: [
        modObject(
          fillRef.shape,
          [{ type: "set", attr: "position-data", val: positionDataVal }],
          snapshot.runtime.designSystemPage,
        ),
      ],
      commitId: "dse-gate-position-data-only",
    });
    assert.deepEqual(
      bookkeepingOnly.operations,
      [],
      "render bookkeeping on a writable Cell must compile to no operations",
    );
    const aliasBookkeeping = compilePenpotChanges(snapshot, {
      changes: [
        modObject(
          aliasRef.shape,
          [{ type: "set", attr: "position-data", val: positionDataVal }],
          snapshot.runtime.designSystemPage,
        ),
      ],
      commitId: "dse-gate-alias-bookkeeping",
    });
    assert.deepEqual(
      aliasBookkeeping.operations,
      [],
      "render bookkeeping on a readonly display must compile to no operations",
    );
    const mixed = compilePenpotChanges(snapshot, {
      changes: [
        modObject(
          fillRef.shape,
          [
            { type: "set", attr: "position-data", val: positionDataVal },
            { type: "set", attr: "fills", val: [{ "fill-color": "#22c55e", "fill-opacity": 1 }] },
          ],
          snapshot.runtime.designSystemPage,
        ),
      ],
      commitId: "dse-gate-mixed-bookkeeping",
    });
    assert.equal(
      mixed.operations.length,
      1,
      "the bound fill edit must survive alongside render bookkeeping",
    );
    // DSE-R09/R11: the FULL component family catalog is exposed — every
    // variant of every set (including the text-less Badge variant) with no
    // first-with-TEXT sampling, plus captions mapped as decoration.
    const variantFamilies = refs.families.filter(
      (family) => family.kind === "variant",
    );
    assert.deepEqual(
      variantFamilies.map((family) => family.variantId).sort(),
      [
        "var_canvas_badge_default",
        "var_canvas_button_ghost",
        "var_canvas_button_primary",
        "var_canvas_button_secondary",
        "var_canvas_card_idle",
        "var_canvas_card_pressed",
        "var_canvas_input_default",
        "var_canvas_input_error",
      ],
      "family catalog must list every variant without text sampling",
    );
    assert.ok(
      variantFamilies.every(
        (family) =>
          family.caption &&
          snapshot.runtime.reverseDesignSystem[family.caption]?.kind ===
            "label",
      ),
      "variant captions must be mapped as decoration",
    );
    // Decorations are mapped so the adapter can reject them precisely.
    assert.equal(snapshot.runtime.reverseDesignSystem[snapshot.runtime.designSystem.board].kind, "board");
    assert.equal(snapshot.runtime.reverseDesignSystem[snapshot.runtime.designSystem.tokenLabel].kind, "label");
    // The generated page id is reserved but not a canonical presentation.
    assert.ok(snapshot.runtime.designSystemPage);
    assert.equal(snapshot.runtime.reversePages[snapshot.runtime.designSystemPage], undefined);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("page refs preserve canonical rootIds and empty presentations", async () => {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-dse-page-roots-"));
  const packagePath = join(parent, "editor.smallpen");
  try {
    const values = buildEditorPackageValues();
    const home = values.get("screens/canvas-page-home.json");
    const presentation = home.presentations[0];
    presentation.nodes.node_second_root = {
      children: [],
      height: 40,
      id: "node_second_root",
      name: "Second root",
      type: "RECTANGLE",
      width: 80,
      x: 900,
      y: 0,
    };
    presentation.rootIds = [presentation.rootId, "node_second_root"];
    home.presentations.push({
      ...structuredClone(presentation),
      id: "pres_empty",
      name: "Empty",
      nodes: {},
      rootId: null,
      rootIds: [],
    });
    await writePackage(packagePath, values);
    await writePackage(
      `${parent}/canvas-shared.smallpen`,
      buildEditorFoundationValues(),
    );

    const snapshot = await openPackage(packagePath);
    const pages = snapshot.runtime.designSystemRefs.pages;
    const multi = pages.find(
      (page) =>
        page.screenId === home.id && page.presentationId === presentation.id,
    );
    const empty = pages.find(
      (page) => page.screenId === home.id && page.presentationId === "pres_empty",
    );
    assert.deepEqual(multi.rootIds, presentation.rootIds);
    assert.deepEqual(empty.rootIds, []);
    assert.equal(empty.nodeCount, 0);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("token specimen fill edit writes the Cell, undo restores it", async () => {
  const { packagePath, parent, snapshot } = await editorPackage();
  try {
    const swatch = specimen(snapshot, COLOR_TOKEN_ID).shape;
    const commit = {
      changes: [
        modObject(
          swatch,
          [
            {
              type: "set",
              attr: "fills",
              val: [{ "fill-color": "#22c55e", "fill-opacity": 1 }],
            },
          ],
          snapshot.runtime.designSystemPage,
        ),
      ],
      commitId: "dse-gate-color",
    };
    const batch = compilePenpotChanges(snapshot, commit);
    const tokenOp = batch.operations.find(
      (operation) => operation.type === "set-token-value",
    );
    assert.ok(tokenOp, "set-token-value op missing");
    assert.equal(tokenOp.tokenId, COLOR_TOKEN_ID);
    assert.equal(tokenOp.value, "#22c55e");
    assert.deepEqual(
      batch.operations.filter((operation) => operation.type === "update-presentation-node"),
      [],
      "generated page leaked a presentation-node update",
    );

    const applied = await applyOperationBatch(packagePath, batch);
    const written = JSON.parse(
      await readFile(join(packagePath, "tokens/canvas.json"), "utf8"),
    );
    const lightSet = written.sets.find((set) => set.id === "tset_canvas_color_light");
    assert.equal(
      lightSet.tokens.find((token) => token.id === COLOR_TOKEN_ID).value,
      "#22c55e",
    );
    const manifest = JSON.parse(
      await readFile(join(packagePath, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.entries.screens.length, 2, "canonical screens drifted");

    // Undo replays the committed inverse batch against the new revision.
    const opened = await openPackage(packagePath);
    await applyOperationBatch(packagePath, {
      ...applied.inverseBatch,
      baseRevision: opened.revision,
    });
    const undone = JSON.parse(
      await readFile(join(packagePath, "tokens/canvas.json"), "utf8"),
    );
    const undoneSet = undone.sets.find((set) => set.id === "tset_canvas_color_light");
    assert.equal(
      undoneSet.tokens.find((token) => token.id === COLOR_TOKEN_ID).value,
      "#6750a4",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("component family tree edits write the component definition", async () => {
  const { packagePath, parent, snapshot } = await editorPackage();
  try {
    // DSE-R09/R11: pick the Button primary family from the FULL catalog.
    const family = snapshot.runtime.designSystemRefs.families.find(
      (candidate) =>
        candidate.kind === "variant" &&
        candidate.componentSetId === "cmp_canvas_button" &&
        candidate.variantId === "var_canvas_button_primary",
    );
    assert.ok(family, "Button primary family missing from the catalog");
    const componentsProbe = JSON.parse(
      await readFile(
        join(packagePath, snapshot.manifest.entries.components[0]),
        "utf8",
      ),
    );
    const probeSet = componentsProbe.componentSets.find(
      (candidate) => candidate.id === family.componentSetId,
    );
    const probeVariant = probeSet.variants.find(
      (candidate) => candidate.id === family.variantId,
    );
    const labelNodeId = Object.values(probeVariant.nodes).find(
      (node) => node.type === "TEXT",
    ).id;
    const labelRuntimeId =
      snapshot.runtime.componentNodes[family.componentSetId][
        family.variantId
      ][labelNodeId];
    assert.ok(labelRuntimeId, "sample label runtime id missing");

    // Fill edit on the variant root + text edit on the label.
    const rootRuntimeId =
      snapshot.runtime.componentNodes[family.componentSetId][
        family.variantId
      ][family.rootId];
    const commit = {
      changes: [
        modObject(
          rootRuntimeId,
          [
            {
              type: "set",
              attr: "fills",
              val: [{ "fill-color": "#ef4444", "fill-opacity": 1 }],
            },
          ],
        ),
        modObject(
          labelRuntimeId,
          [
            {
              type: "set",
              attr: "content",
              val: {
                children: [
                  {
                    children: [
                      { children: [{ text: "Primary!" }], type: "paragraph" },
                    ],
                    type: "paragraph-set",
                  },
                ],
                type: "root",
              },
            },
          ],
        ),
      ],
      commitId: "dse-gate-component",
    };
    // DSE-R10: the text editor registers the edited objects (reg-objects
    // bookkeeping) in the SAME commit as the fill/text mod-obj edits. On the
    // generated page that bookkeeping creates nothing and must not trip the
    // structural gate, or the whole edit batch dies with a 422.
    const withRegistration = compilePenpotChanges(snapshot, {
      changes: [
        {
          type: "reg-objects",
          "page-id": snapshot.runtime.designSystemPage,
          shapes: [labelRuntimeId],
        },
        modObject(
          labelRuntimeId,
          [
            {
              type: "set",
              attr: "fills",
              val: [{ "fill-color": "#ef4444", "fill-opacity": 1 }],
            },
          ],
          snapshot.runtime.designSystemPage,
        ),
      ],
      commitId: "dse-gate-reg-objects-ride-along",
    });
    assert.ok(
      withRegistration.operations.some(
        (operation) => operation.type === "update-component-node",
      ),
      "the fill edit must survive the reg-objects bookkeeping riding along",
    );
    const batch = compilePenpotChanges(snapshot, commit);
    const nodeOps = batch.operations.filter(
      (operation) => operation.type === "update-component-node",
    );
    assert.equal(nodeOps.length, 2, "expected root fill + label text ops");
    const rootOp = nodeOps.find((operation) => operation.nodeId === family.rootId);
    const labelOp = nodeOps.find((operation) => operation.nodeId === labelNodeId);
    assert.ok(rootOp, "root op missing");
    assert.ok(labelOp, "label op missing");
    assert.equal(rootOp.componentSetId, family.componentSetId);
    assert.equal(rootOp.variantId, family.variantId);
    assert.ok(rootOp.changes.fills, "root fill not compiled");
    assert.equal(labelOp.changes.text, "Primary!");

    const applied = await applyOperationBatch(packagePath, batch);
    const componentsEntry = snapshot.manifest.entries.components[0];
    const component = JSON.parse(
      await readFile(join(packagePath, componentsEntry), "utf8"),
    );
    const set = component.componentSets.find(
      (candidate) => candidate.id === family.componentSetId,
    );
    const variant = set.variants.find(
      (candidate) => candidate.id === family.variantId,
    );
    assert.equal(variant.nodes[family.rootId].fills[0].color, "#ef4444");
    assert.equal(variant.nodes[labelNodeId].text, "Primary!");

    // Undo restores both fields.
    const opened = await openPackage(packagePath);
    await applyOperationBatch(packagePath, {
      ...applied.inverseBatch,
      baseRevision: opened.revision,
    });
    const undone = JSON.parse(
      await readFile(join(packagePath, componentsEntry), "utf8"),
    );
    const undoneVariant = undone.componentSets
      .find((candidate) => candidate.id === family.componentSetId)
      .variants.find((candidate) => candidate.id === family.variantId);
    assert.equal(undoneVariant.nodes[family.rootId].fills[0].color, "#6750a4");
    assert.equal(
      undoneVariant.nodes[labelNodeId].text,
      probeVariant.nodes[labelNodeId].text,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("located component board edits write the source node (DSE-R11)", async () => {
  const { packagePath, parent, snapshot } = await editorPackage();
  try {
    // Create a located component over the nested Home container (the same
    // commit the ordinary create-component flow produces).
    const mainNodeId = "node_editor_nested";
    const pageId =
      snapshot.runtime.pages.scr_canvas_home.pres_canvas_home_desktop;
    const mainRuntimeId =
      snapshot.runtime.nodes.scr_canvas_home.pres_canvas_home_desktop[
        mainNodeId
      ];
    assert.ok(mainRuntimeId, "main node runtime id missing");
    const createBatch = compilePenpotChanges(snapshot, {
      changes: [
        {
          annotation: null,
          id: "c1000000-0000-4000-8000-0000000000c1",
          "main-instance-id": mainRuntimeId,
          "main-instance-page": pageId,
          name: "Nested Component",
          path: "Layouts",
          type: "add-component",
        },
        {
          id: mainRuntimeId,
          operations: [
            {
              attr: "component-id",
              type: "set",
              val: "c1000000-0000-4000-8000-0000000000c1",
            },
            {
              attr: "component-file",
              type: "set",
              val: snapshot.runtime.file,
            },
            { attr: "component-root", type: "set", val: true },
            { attr: "main-instance", type: "set", val: true },
          ],
          "page-id": pageId,
          type: "mod-obj",
        },
      ],
      commitId: "dse-gate-located-create",
    });
    await applyOperationBatch(packagePath, createBatch);

    // Re-open: the located component enters the FULL family catalog and its
    // main tree maps on the generated page.
    const reopened = await openPackage(packagePath);
    const refs = reopened.runtime.designSystemRefs;
    const located = refs.families.find((family) => family.kind === "located");
    assert.ok(located, "located component missing from families");
    assert.equal(located.label, "Nested Component");
    assert.equal(located.mainNodeId, mainNodeId);
    assert.ok(located.nodeCount >= 3, "main tree not fully cataloged");
    assert.equal(
      reopened.runtime.reverseDesignSystem[mainRuntimeId]?.kind,
      "located-component-node",
    );

    // A board edit of the copy translates to the source node on its own
    // screen, and board moves stay rejected.
    const designSystemPage = reopened.runtime.designSystemPage;
    const fillBatch = compilePenpotChanges(reopened, {
      changes: [
        modObject(
          mainRuntimeId,
          [
            {
              type: "set",
              attr: "fills",
              val: [{ "fill-color": "#0ea5e9", "fill-opacity": 1 }],
            },
          ],
          designSystemPage,
        ),
      ],
      commitId: "dse-gate-located-fill",
    });
    const update = fillBatch.operations.find(
      (operation) => operation.type === "update-presentation-node",
    );
    assert.ok(update, "board fill edit lost its source update");
    assert.equal(update.screenId, "scr_canvas_home");
    assert.equal(update.presentationId, "pres_canvas_home_desktop");
    assert.equal(update.nodeId, mainNodeId);
    assert.equal(update.changes.fills?.[0]?.color, "#0ea5e9");

    assert.throws(
      () =>
        compilePenpotChanges(reopened, {
          changes: [
            modObject(
              mainRuntimeId,
              [{ type: "set", attr: "x", val: 12 }],
              designSystemPage,
            ),
          ],
          commitId: "dse-gate-located-move",
        }),
      (error) => error.code === "design_system_layout_locked",
      "board moves must not write the source layout",
    );

    // The write really lands on the source node.
    await applyOperationBatch(packagePath, fillBatch);
    const screens = reopened.manifest.entries.screens;
    const screenPath = screens.find((entry) =>
      JSON.stringify(entry).includes("canvas-page-home"),
    );
    const screen = JSON.parse(await readFile(join(packagePath, screenPath), "utf8"));
    const home = screen.presentations.find(
      (candidate) => candidate.id === "pres_canvas_home_desktop",
    );
    assert.equal(home.nodes[mainNodeId].fills[0].color, "#0ea5e9");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("generated page decorations, structure and layout are rejected", async () => {
  const { parent, snapshot } = await editorPackage();
  try {
    const dsPage = snapshot.runtime.designSystemPage;
    const board = snapshot.runtime.designSystem.board;
    // Decoration edits are dropped (no ops reach the canonical Package),
    // including the auto-reflow updates text decorations emit.
    const decoBatch = compilePenpotChanges(snapshot, {
      changes: [modObject(board, [{ type: "set", attr: "x", val: 12 }], dsPage)],
      commitId: "dse-gate-deco",
    });
    assert.deepEqual(decoBatch.operations, [], "decoration edit leaked an operation");
    // Specimen position is auto-layout presentation state.
    const swatch = specimen(snapshot, COLOR_TOKEN_ID).shape;
    assert.throws(
      () =>
        compilePenpotChanges(snapshot, {
          changes: [modObject(swatch, [{ type: "set", attr: "x", val: 12 }], dsPage)],
          commitId: "dse-gate-move",
        }),
      (error) => error.code === "design_system_layout_locked",
    );
    // Structural mutation of the generated page.
    assert.throws(
      () =>
        compilePenpotChanges(snapshot, {
          changes: [
            {
              "page-id": dsPage,
              "parent-id": "00000000-0000-0000-0000-000000000000",
              type: "add-obj",
            },
          ],
          commitId: "dse-gate-add",
        }),
      (error) => error.code === "design_system_structure_locked",
    );
    // Unmapped shapes on the generated page are projection bookkeeping
    // (stale renderer syncs from earlier board generations — users cannot
    // create shapes here at all): their edits are dropped, not rejected.
    const unknownBatch = compilePenpotChanges(snapshot, {
      changes: [
        modObject(
          "00000000-0000-0000-0000-0000000000aa",
          [{ type: "set", attr: "x", val: 5 }],
          dsPage,
        ),
      ],
      commitId: "dse-gate-unknown",
    });
    assert.deepEqual(unknownBatch.operations, [], "unknown-shape edit leaked an operation");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("ordinary page edits keep the normal update path", async () => {
  const { packagePath, parent, snapshot } = await editorPackage();
  try {
    const screen = snapshot.manifest.entries.screens.find(
      (entry) => snapshot.entries[entry].id === "scr_canvas_home",
    );
    const home = JSON.parse(await readFile(join(packagePath, screen), "utf8"));
    const presentation = home.presentations[0];
    const pathNode = EDITOR_NESTED_NODES.node_editor_nested_path;
    const pathRuntimeId = snapshot.runtime.nodes["scr_canvas_home"][presentation.id][pathNode.id];
    assert.ok(pathRuntimeId);
    const commit = {
      changes: [
        modObject(pathRuntimeId, [{ type: "set", attr: "opacity", val: 0.5 }]),
      ],
      commitId: "dse-gate-normal",
    };
    const batch = compilePenpotChanges(snapshot, commit);
    const update = batch.operations.find(
      (operation) => operation.type === "update-presentation-node",
    );
    assert.ok(update, "ordinary page edit lost its presentation-node path");
    assert.equal(update.changes.opacity, 0.5);
    assert.equal(update.screenId, "scr_canvas_home");
    assert.deepEqual(
      batch.operations.filter((operation) => operation.type === "set-token-value"),
      [],
      "ordinary shape edit was misread as a Token Cell edit",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// --- DSE-R03/R04 rework (2026-09-15): native strokes and shadow edits use
// the REAL native formats (whole-array writes from the strokes and effects
// panels), must map to exactly one Token Cell write each, and must reject
// ambiguous targets without partial writes.

async function readStrokeToken(packagePath) {
  const written = JSON.parse(
    await readFile(join(packagePath, "tokens/canvas.json"), "utf8"),
  );
  const strokeSet = written.sets.find((set) => set.id === "tset_canvas_stroke");
  return strokeSet.tokens.find((token) => token.id === STROKE_TOKEN_ID).value;
}

test("token specimen native stroke edit writes the width Cell, undo restores it", async () => {
  const { packagePath, parent, snapshot } = await editorPackage();
  try {
    assert.equal(await readStrokeToken(packagePath), 1);
    const strokeSpecimen = specimen(snapshot, STROKE_TOKEN_ID).shape;
    // The native strokes panel rewrites the whole :strokes vector
    // (stroke.cljs -> change-stroke-attrs), so this is the format the
    // adapter must accept — not a hand-made top-level stroke-width.
    const commit = {
      changes: [
        modObject(
          strokeSpecimen,
          [
            {
              type: "set",
              attr: "strokes",
              val: [
                {
                  "stroke-alignment": "inner",
                  "stroke-color": "#111827",
                  "stroke-opacity": 1,
                  "stroke-style": "solid",
                  "stroke-width": 3,
                },
              ],
            },
          ],
          snapshot.runtime.designSystemPage,
        ),
      ],
      commitId: "dse-gate-stroke",
    };
    const batch = compilePenpotChanges(snapshot, commit);
    const tokenOp = batch.operations.find(
      (operation) => operation.type === "set-token-value",
    );
    assert.ok(tokenOp, "set-token-value op missing for native strokes edit");
    assert.equal(tokenOp.tokenId, STROKE_TOKEN_ID);
    assert.equal(tokenOp.value, 3);
    assert.deepEqual(
      batch.operations.filter(
        (operation) => operation.type === "update-presentation-node",
      ),
      [],
      "generated page leaked a presentation-node update",
    );

    const applied = await applyOperationBatch(packagePath, batch);
    assert.equal(await readStrokeToken(packagePath), 3);

    const opened = await openPackage(packagePath);
    await applyOperationBatch(packagePath, {
      ...applied.inverseBatch,
      baseRevision: opened.revision,
    });
    assert.equal(await readStrokeToken(packagePath), 1, "undo lost the Cell");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("ambiguous stroke edits on a width Cell are rejected without writes", async () => {
  const { parent, snapshot } = await editorPackage();
  try {
    const strokeSpecimen = specimen(snapshot, STROKE_TOKEN_ID).shape;
    const fillSpecimen = specimen(snapshot, COLOR_TOKEN_ID).shape;
    const dsPage = snapshot.runtime.designSystemPage;
    const compile = (val, id = strokeSpecimen) =>
      compilePenpotChanges(snapshot, {
        changes: [modObject(id, [{ type: "set", attr: "strokes", val }], dsPage)],
        commitId: "dse-gate-stroke-negative",
      });

    // Multiple strokes: no single width target.
    assert.throws(
      () =>
        compile([
          {
            "stroke-alignment": "inner",
            "stroke-color": "#111827",
            "stroke-opacity": 1,
            "stroke-style": "solid",
            "stroke-width": 3,
          },
          {
            "stroke-alignment": "outer",
            "stroke-color": "#111827",
            "stroke-opacity": 1,
            "stroke-style": "solid",
            "stroke-width": 5,
          },
        ]),
      (error) => error.code === "design_system_unsupported_attribute",
      "multi-stroke edit must be rejected",
    );
    // Stroke deletion: the Cell does not bind a removal.
    assert.throws(
      () => compile([]),
      (error) => error.code === "design_system_unsupported_attribute",
      "stroke deletion must be rejected",
    );
    // Missing or invalid width values.
    assert.throws(
      () =>
        compile([
          {
            "stroke-alignment": "inner",
            "stroke-color": "#111827",
            "stroke-style": "solid",
          },
        ]),
      (error) => error.code === "invalid_penpot_stroke",
      "missing stroke width must be rejected",
    );
    assert.throws(
      () =>
        compile([
          {
            "stroke-alignment": "inner",
            "stroke-color": "#111827",
            "stroke-opacity": 1,
            "stroke-style": "solid",
            "stroke-width": -2,
          },
        ]),
      (error) => error.code === "invalid_penpot_stroke",
      "negative stroke width must be rejected",
    );
    // A fill specimen does not bind strokes.
    assert.throws(
      () =>
        compile(
          [
            {
              "stroke-alignment": "inner",
              "stroke-color": "#111827",
              "stroke-opacity": 1,
              "stroke-style": "solid",
              "stroke-width": 3,
            },
          ],
          fillSpecimen,
        ),
      (error) => error.code === "design_system_unsupported_attribute",
      "strokes edit on a fill specimen must be rejected",
    );
    // A width-only-redundant edit (e.g. stroke color restyle) writes nothing:
    // it compiles to an empty commit the client rolls back.
    assert.throws(
      () =>
        compile([
          {
            "stroke-alignment": "inner",
            "stroke-color": "#0f172a",
            "stroke-opacity": 1,
            "stroke-style": "solid",
            "stroke-width": 1,
          },
        ]),
      (error) => error.code === "empty_penpot_commit",
      "unbound-field edit must not write the Cell",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a height edit with a ride-along position op writes the Cell, pure moves stay rejected", async () => {
  const { parent, snapshot } = await editorPackage();
  try {
    const sizingSpecimen = specimen(snapshot, SIZING_TOKEN_ID).shape;
    const dsPage = snapshot.runtime.designSystemPage;
    // A height resize can ride along with an auto-layout position op: the
    // bound field writes, the presentation op is dropped.
    const batch = compilePenpotChanges(snapshot, {
      changes: [
        modObject(
          sizingSpecimen,
          [
            { type: "set", attr: "y", val: 152 },
            { type: "set", attr: "height", val: 64 },
          ],
          dsPage,
        ),
      ],
      commitId: "dse-gate-sizing-mixed",
    });
    const tokenOp = batch.operations.find(
      (operation) => operation.type === "set-token-value",
    );
    assert.ok(tokenOp, "height edit lost its token op");
    assert.equal(tokenOp.tokenId, SIZING_TOKEN_ID);
    assert.equal(tokenOp.value, 64);
    assert.deepEqual(
      batch.operations.filter(
        (operation) => operation.type === "update-presentation-node",
      ),
      [],
      "position op leaked a presentation-node update",
    );
    // A pure position edit stays rejected.
    assert.throws(
      () =>
        compilePenpotChanges(snapshot, {
          changes: [
            modObject(sizingSpecimen, [{ type: "set", attr: "y", val: 99 }], dsPage),
          ],
          commitId: "dse-gate-sizing-pure-move",
        }),
      (error) => error.code === "design_system_layout_locked",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

async function readShadowToken(packagePath) {
  const written = JSON.parse(
    await readFile(join(packagePath, "tokens/canvas.json"), "utf8"),
  );
  const effectSet = written.sets.find((set) => set.id === "tset_canvas_effect");
  return effectSet.tokens.find((token) => token.id === SHADOW_TOKEN_ID).value;
}

test("token specimen native shadow array edit writes the effect Cell, undo restores it", async () => {
  const { packagePath, parent, snapshot } = await editorPackage();
  try {
    const shadowSpecimen = specimen(snapshot, SHADOW_TOKEN_ID).shape;
    // The native effects panel keeps :shadow as a vector of full shadow
    // records (shadow.cljs -> update-shapes on the shadow vector); the
    // color carries the native attrs {color: hex, opacity}.
    const commit = {
      changes: [
        modObject(
          shadowSpecimen,
          [
            {
              type: "set",
              attr: "shadow",
              val: [
                {
                  id: null,
                  style: "drop-shadow",
                  "offset-x": 4,
                  "offset-y": 8,
                  blur: 16,
                  spread: 2,
                  hidden: false,
                  color: { color: "#1a334d", opacity: 0.5 },
                },
              ],
            },
          ],
          snapshot.runtime.designSystemPage,
        ),
      ],
      commitId: "dse-gate-shadow",
    };
    const batch = compilePenpotChanges(snapshot, commit);
    const tokenOp = batch.operations.find(
      (operation) => operation.type === "set-token-value",
    );
    assert.ok(tokenOp, "set-token-value op missing for native shadow edit");
    assert.equal(tokenOp.tokenId, SHADOW_TOKEN_ID);
    // rgba channels round-trip without going black or losing alpha.
    assert.deepEqual(tokenOp.value, {
      blur: 16,
      color: "#1a334d80",
      offsetX: 4,
      offsetY: 8,
      spread: 2,
    });
    assert.deepEqual(
      batch.operations.filter(
        (operation) => operation.type === "update-presentation-node",
      ),
      [],
      "generated page leaked a presentation-node update",
    );

    const applied = await applyOperationBatch(packagePath, batch);
    assert.deepEqual(await readShadowToken(packagePath), {
      blur: 16,
      color: "#1a334d80",
      offsetX: 4,
      offsetY: 8,
      spread: 2,
    });

    const opened = await openPackage(packagePath);
    await applyOperationBatch(packagePath, {
      ...applied.inverseBatch,
      baseRevision: opened.revision,
    });
    assert.deepEqual(await readShadowToken(packagePath), {
      color: "rgba(0, 0, 0, 0.24)",
      offsetX: 0,
      offsetY: 2,
      blur: 4,
      spread: 0,
    });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("unsupported shadow edits are rejected without partial writes", async () => {
  const { parent, snapshot } = await editorPackage();
  try {
    const shadowSpecimen = specimen(snapshot, SHADOW_TOKEN_ID).shape;
    const dsPage = snapshot.runtime.designSystemPage;
    const compile = (val) =>
      compilePenpotChanges(snapshot, {
        changes: [modObject(shadowSpecimen, [{ type: "set", attr: "shadow", val }], dsPage)],
        commitId: "dse-gate-shadow-negative",
      });

    // Empty effect list: nothing to map to the Cell.
    assert.throws(
      () => compile([]),
      (error) => error.code === "invalid_penpot_effect",
    );
    // A specimen binds exactly one effect.
    assert.throws(
      () =>
        compile([
          {
            id: null,
            style: "drop-shadow",
            "offset-x": 0,
            "offset-y": 2,
            blur: 4,
            spread: 0,
            hidden: false,
            color: { color: "#000000", opacity: 1 },
          },
          {
            id: null,
            style: "drop-shadow",
            "offset-x": 1,
            "offset-y": 3,
            blur: 6,
            spread: 0,
            hidden: false,
            color: { color: "#000000", opacity: 1 },
          },
        ]),
      (error) => error.code === "design_system_unsupported_attribute",
    );
    // Inner shadows are not representable in the drop-shadow Cell.
    assert.throws(
      () =>
        compile([
          {
            id: null,
            style: "inner-shadow",
            "offset-x": 0,
            "offset-y": 2,
            blur: 4,
            spread: 0,
            hidden: false,
            color: { color: "#000000", opacity: 1 },
          },
        ]),
      (error) => error.code === "design_system_unsupported_attribute",
    );
    // Missing color must not silently write a black shadow.
    assert.throws(
      () =>
        compile([
          {
            id: null,
            style: "drop-shadow",
            "offset-x": 0,
            "offset-y": 2,
            blur: 4,
            spread: 0,
            hidden: false,
          },
        ]),
      (error) => error.code === "invalid_penpot_effect",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// --- DSE-R16 (2026-09-18 rework): the generated page NEVER persists. --------
// Every write class lands in its real source (Token Cell / component
// definition / page occurrence); decorations and lost-mapping specimens
// compile to no canonical operation; save + reopen leaves the canonical tree
// with exactly the intended source diffs and zero System Sheet residue; the
// board rebuilds from canonical with the same stable ids and fresh values.

async function readCanonicalFiles(packagePath, snapshot) {
  const files = new Map([
    ["manifest.json", JSON.parse(await readFile(join(packagePath, "manifest.json"), "utf8"))],
  ]);
  for (const entries of Object.values(snapshot.manifest.entries)) {
    for (const entry of entries) {
      files.set(entry, JSON.parse(await readFile(join(packagePath, entry), "utf8")));
    }
  }
  return files;
}

function assertNoGeneratedResidue(files, snapshot) {
  const runtime = snapshot.runtime;
  const generatedIds = new Set(
    [
      runtime.designSystemPage,
      runtime.componentsPage,
      runtime.designSystem?.board,
      runtime.designSystem?.tokenLabel,
      runtime.designSystem?.tokensSection,
      runtime.designSystem?.componentsSection,
      runtime.designSystem?.pagesSection,
      ...Object.keys(runtime.reverseDesignSystem ?? {}),
    ].filter((id) => typeof id === "string"),
  );
  const walk = (value, path) => {
    if (typeof value === "string") {
      if (generatedIds.has(value)) {
        throw new Error(`generated page id leaked into canonical file at ${path}`);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (key === "smallpen" && item && typeof item === "object" && !Array.isArray(item)) {
          for (const marker of Object.keys(item)) {
            if (marker.startsWith("design-system") || marker === "components-page") {
              throw new Error(
                `generated page plugin-data marker "${marker}" leaked into canonical file at ${path}`,
              );
            }
          }
          continue;
        }
        walk(item, `${path}.${key}`);
      }
    }
  };
  for (const [entry, value] of files) walk(value, entry);
}

test("the generated page never persists: every write class lands in its source, save + reopen carries zero System Sheet residue (DSE-R16)", async () => {
  const { packagePath, parent, snapshot } = await editorPackage();
  try {
    const dsPage = snapshot.runtime.designSystemPage;
    const baseline = await readCanonicalFiles(packagePath, snapshot);
    assert.equal(
      snapshot.runtime.reversePages[dsPage],
      undefined,
      "the generated page must not resolve to a canonical presentation",
    );

    // Write class 1 — Token Cell: the native fill edit on the generated page
    // compiles to set-token-value on the owning Cell.
    const fillRef = specimen(snapshot, COLOR_TOKEN_ID);
    assert.ok(fillRef.writable, "color Cell must be a direct write target");
    const tokenBatch = compilePenpotChanges(snapshot, {
      changes: [
        modObject(
          fillRef.shape,
          [{ type: "set", attr: "fills", val: [{ "fill-color": "#2563eb", "fill-opacity": 1 }] }],
          dsPage,
        ),
      ],
      commitId: "dse-r16-token",
    });
    assert.deepEqual(
      tokenBatch.operations.map((operation) => operation.type),
      ["set-token-value"],
    );
    assert.equal(tokenBatch.operations[0].tokenId, COLOR_TOKEN_ID);
    assert.equal(tokenBatch.operations[0].value, "#2563eb");
    const tokenApplied = await applyOperationBatch(packagePath, tokenBatch);
    // Write class 2 — Component definition: a fill edit on a variant tree
    // node shown on the generated page compiles to update-component-node on
    // master/variant/source node (reg-objects bookkeeping rides along).
    const family = snapshot.runtime.designSystemRefs.families.find(
      (candidate) =>
        candidate.kind === "variant" &&
        candidate.componentSetId === "cmp_canvas_button" &&
        candidate.variantId === "var_canvas_button_primary",
    );
    assert.ok(family, "Button primary family missing");
    const componentsProbe = JSON.parse(
      await readFile(
        join(packagePath, snapshot.manifest.entries.components[0]),
        "utf8",
      ),
    );
    const probeVariant = componentsProbe.componentSets
      .find((set) => set.id === family.componentSetId)
      .variants.find((variant) => variant.id === family.variantId);
    const labelNodeId = Object.values(probeVariant.nodes).find(
      (node) => node.type === "TEXT",
    ).id;
    const labelRuntimeId =
      snapshot.runtime.componentNodes[family.componentSetId][family.variantId][
        labelNodeId
      ];
    const componentBatch = compilePenpotChanges(snapshot, {
      changes: [
        { type: "reg-objects", "page-id": dsPage, shapes: [labelRuntimeId] },
        modObject(
          labelRuntimeId,
          [{ type: "set", attr: "fills", val: [{ "fill-color": "#dc2626", "fill-opacity": 1 }] }],
          dsPage,
        ),
      ],
      commitId: "dse-r16-component",
    });
    const componentOps = componentBatch.operations.filter(
      (operation) => operation.type === "update-component-node",
    );
    assert.equal(componentOps.length, 1, "expected one definition node op");
    assert.equal(componentOps[0].componentSetId, family.componentSetId);
    const afterToken = await openPackage(packagePath);
    const componentApplied = await applyOperationBatch(packagePath, {
      ...componentBatch,
      baseRevision: afterToken.revision,
    });

    // Write class 3 — Page instance: editing a node shown in the Pages
    // section compiles to update-presentation-node on THAT occurrence's
    // screen; the component master stays untouched (override, not master).
    const pageId =
      snapshot.runtime.pages.scr_canvas_home.pres_canvas_home_desktop;
    const noteRuntimeId =
      snapshot.runtime.nodes.scr_canvas_home.pres_canvas_home_desktop[
        "node_home_hidden_note"
      ];
    assert.ok(noteRuntimeId, "page node runtime id missing");
    const pageBatch = compilePenpotChanges(snapshot, {
      changes: [
        modObject(
          noteRuntimeId,
          [{ type: "set", attr: "fills", val: [{ "fill-color": "#16a34a", "fill-opacity": 1 }] }],
          dsPage,
        ),
      ],
      commitId: "dse-r16-page-instance",
    });
    const presentationOps = pageBatch.operations.filter(
      (operation) => operation.type === "update-presentation-node",
    );
    assert.equal(presentationOps.length, 1, "expected one occurrence op");
    assert.equal(presentationOps[0].screenId, "scr_canvas_home");
    assert.equal(presentationOps[0].presentationId, "pres_canvas_home_desktop");
    assert.equal(presentationOps[0].nodeId, "node_home_hidden_note");
    assert.deepEqual(
      pageBatch.operations.filter(
        (operation) => operation.type === "update-component-node",
      ),
      [],
      "a page instance edit must never write a component definition",
    );
    const afterComponent = await openPackage(packagePath);
    const pageApplied = await applyOperationBatch(packagePath, {
      ...pageBatch,
      baseRevision: afterComponent.revision,
    });

    // Decoration + lost-mapping specimens: explicit no-ops. Applying their
    // (empty) batches must not touch a single canonical byte.
    const noOpBatches = [
      {
        name: "board title rename",
        batch: compilePenpotChanges(snapshot, {
          changes: [
            modObject(
              snapshot.runtime.designSystem.tokenLabel,
              [{ type: "set", attr: "name", val: "Renamed" }],
              dsPage,
            ),
          ],
          commitId: "dse-r16-title-rename",
        }),
      },
      {
        name: "board layout move",
        batch: compilePenpotChanges(snapshot, {
          changes: [
            modObject(
              snapshot.runtime.designSystem.board,
              [{ type: "set", attr: "x", val: 42 }],
              dsPage,
            ),
          ],
          commitId: "dse-r16-board-move",
        }),
      },
      {
        name: "lost-mapping specimen",
        batch: compilePenpotChanges(snapshot, {
          changes: [
            modObject(
              "00000000-0000-0000-0000-0000000000aa",
              [{ type: "set", attr: "fills", val: [{ "fill-color": "#000000", "fill-opacity": 1 }] }],
              dsPage,
            ),
          ],
          commitId: "dse-r16-lost-mapping",
        }),
      },
    ];
    for (const { name, batch } of noOpBatches) {
      assert.deepEqual(
        batch.operations,
        [],
        `${name} must compile to no canonical operation`,
      );
      const fresh = await openPackage(packagePath);
      await applyOperationBatch(packagePath, {
        ...batch,
        baseRevision: fresh.revision,
      });
    }

    // Save + reopen: rebuild every runtime ref from the canonical tree.
    const saved = await openPackage(packagePath);
    const after = await readCanonicalFiles(packagePath, saved);

    // Exactly three canonical entries changed; manifest and every other
    // entry are byte-identical to the baseline.
    const changed = [...baseline.keys()].filter(
      (entry) => canonicalJSON(baseline.get(entry)) !== canonicalJSON(after.get(entry)),
    );
    assert.deepEqual(
      changed.sort(),
      [
        snapshot.manifest.entries.components[0],
        snapshot.manifest.entries.screens.find((entry) =>
          entry.endsWith("canvas-page-home.json"),
        ),
        snapshot.manifest.entries.tokens[0],
      ].sort(),
      "canonical diff must contain exactly the three intended source entries",
    );
    const tokensAfter = after.get(snapshot.manifest.entries.tokens[0]);
    const tokenSet = tokensAfter.sets.find((set) =>
      set.tokens.some((token) => token.id === COLOR_TOKEN_ID),
    );
    assert.equal(
      tokenSet.tokens.find((token) => token.id === COLOR_TOKEN_ID).value,
      "#2563eb",
    );
    const homeAfter = after.get(
      snapshot.manifest.entries.screens.find((entry) =>
        entry.endsWith("canvas-page-home.json"),
      ),
    );
    assert.equal(
      homeAfter.presentations[0].nodes.node_home_hidden_note.fills[0].color,
      "#16a34a",
    );

    // Zero System Sheet residue: no generated id and no projection-only
    // plugin-data marker anywhere in the canonical tree.
    assertNoGeneratedResidue(after, saved);

    // Rebuild proof: the reopened snapshot regenerates the SAME stable
    // specimen identity and reads the NEW canonical value.
    const rebuilt = specimen(saved, COLOR_TOKEN_ID);
    assert.equal(rebuilt.shape, fillRef.shape, "specimen id must be stable across rebuild");
    assert.equal(rebuilt.caption, fillRef.caption, "caption id must be stable across rebuild");
    assert.equal(rebuilt.value, "#2563eb", "rebuild must read the fresh canonical value");
    assert.equal(
      saved.runtime.reversePages[dsPage],
      undefined,
      "the rebuilt runtime must still not resolve the generated page to a canonical presentation",
    );
    assert.equal(
      saved.runtime.reverseDesignSystem[saved.runtime.designSystem.board].kind,
      "board",
      "the rebuilt board must stay a decoration",
    );

    // Undo every write class (reverse order) — the canonical tree returns to
    // byte-identical baseline and the board rebuilds with baseline values.
    const reopened = await openPackage(packagePath);
    await applyOperationBatch(packagePath, {
      ...pageApplied.inverseBatch,
      baseRevision: reopened.revision,
    });
    const afterPageUndo = await openPackage(packagePath);
    await applyOperationBatch(packagePath, {
      ...componentApplied.inverseBatch,
      baseRevision: afterPageUndo.revision,
    });
    const afterComponentUndo = await openPackage(packagePath);
    await applyOperationBatch(packagePath, {
      ...tokenApplied.inverseBatch,
      baseRevision: afterComponentUndo.revision,
    });
    const undoneFiles = await readCanonicalFiles(
      packagePath,
      await openPackage(packagePath),
    );
    assert.deepEqual(
      [...baseline.keys()].filter(
        (entry) => canonicalJSON(baseline.get(entry)) !== canonicalJSON(undoneFiles.get(entry)),
      ),
      [],
      "undo must restore the canonical tree byte-for-byte",
    );
    assertNoGeneratedResidue(undoneFiles, await openPackage(packagePath));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("external canonical updates rebuild the board with stable ids and fresh values (DSE-R16)", async () => {
  const { packagePath, parent, snapshot } = await editorPackage();
  try {
    const fillRef = specimen(snapshot, COLOR_TOKEN_ID);
    // An external agent edits the source directly through the canonical
    // operation API — no Design System UI, no native changes, no adapter.
    await applyOperationBatch(packagePath, {
      batchId: "dse-r16-external",
      baseRevision: snapshot.revision,
      operations: [
        { type: "set-token-value", tokenId: COLOR_TOKEN_ID, value: "#7c3aed" },
      ],
    });
    const reopened = await openPackage(packagePath);
    const rebuilt = specimen(reopened, COLOR_TOKEN_ID);
    assert.equal(rebuilt.shape, fillRef.shape, "external update must keep the stable specimen id");
    assert.equal(rebuilt.value, "#7c3aed", "the rebuilt board must show the externally written value");
    assert.equal(
      reopened.runtime.reversePages[reopened.runtime.designSystemPage],
      undefined,
      "an external cycle must not register the generated page as a canonical presentation",
    );
    assertNoGeneratedResidue(
      await readCanonicalFiles(packagePath, reopened),
      reopened,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// DSE-R17~R26: the fully-expanded Token panorama — combination-aware refs,
// the 20-type catalog, and a real write path for EVERY canonical type.
// ---------------------------------------------------------------------------

const COVERAGE_SET_ID = "tset_reference_coverage";
const COVERAGE_SET_NAME = "reference/coverage";

// One Cell per canonical type the editor fixture does not carry yet, plus an
// unknown-type Cell that must be diagnosed instead of silently dropped. The
// set is ACTIVE but claimed by no Token Domain, so it must appear in EVERY
// valid Workbench Combination view.
function coverageTokens() {
  return [
    ["tok_coverage_boolean", "flag", "boolean", true],
    ["tok_coverage_dimensions", "box", "dimensions", 120],
    ["tok_coverage_font_family", "family", "font-family", "Inter"],
    ["tok_coverage_font_size", "size", "font-size", 24],
    ["tok_coverage_font_weight", "weight", "font-weight", 700],
    ["tok_coverage_letter_spacing", "tracking", "letter-spacing", 1.5],
    ["tok_coverage_number", "count", "number", 12],
    ["tok_coverage_opacity", "veil", "opacity", 0.42],
    ["tok_coverage_other", "config", "other", '{"theme":{"dark":true},"steps":[1,2]}'],
    ["tok_coverage_rotation", "tilt", "rotation", -30],
    ["tok_coverage_string", "label", "string", "Hello 覆盖"],
    ["tok_coverage_text_case", "case", "text-case", "uppercase"],
    ["tok_coverage_text_decoration", "decoration", "text-decoration", "underline"],
  ].map(([id, name, type, value]) => ({
    description: `Coverage Cell ${name} (${type})`,
    id,
    name,
    type,
    value,
  }));
}

async function coveragePackage() {
  const values = buildEditorPackageValues();
  const libraryEntry = [...values.keys()].find((entry) =>
    entry.startsWith("tokens/"),
  );
  const library = values.get(libraryEntry);
  library.sets.push({
    description: "Coverage Cells for the 20 canonical token types",
    id: COVERAGE_SET_ID,
    name: COVERAGE_SET_NAME,
    tokens: coverageTokens(),
  });
  library.activeSetIds.push(COVERAGE_SET_ID);
  // An ARCHIVED set: neither active nor claimed by any Token Domain — its
  // Cell must still materialize (archived band), never be hidden.
  library.sets.push({
    description: "Archived Cells covered by no combination",
    id: "tset_reference_archived",
    name: "reference/archived",
    tokens: [
      {
        description: "Archived color Cell",
        id: "tok_reference_archived_color",
        name: "legacy.color",
        type: "color",
        value: "#cccccc",
      },
    ],
  });
  values.set(libraryEntry, library);
  const parent = await mkdtemp(join(tmpdir(), "smallpen-dse-coverage-"));
  const packagePath = join(parent, "coverage.smallpen");
  await writePackage(packagePath, values);
  await writePackage(`${parent}/canvas-shared.smallpen`, buildEditorFoundationValues());
  const snapshot = await openPackage(packagePath);
  return { packagePath, parent, snapshot, libraryEntry };
}

test("combination-aware refs materialize every Cell x valid Combination and catalog the 20 canonical types (DSE-R17/R18)", async () => {
  const { parent, snapshot } = await coveragePackage();
  try {
    const refs = snapshot.runtime.designSystemRefs;
    // device{Mobile,Desktop} x mode{Light,Dark} = 4 source-declared combos.
    assert.equal(refs.combinations.length, 4);
    assert.deepEqual(
      new Set(refs.combinations.map((combo) => combo.id)).size,
      4,
      "combination ids must be unique and stable",
    );
    for (const combo of refs.combinations) {
      assert.ok(combo.label.length > 0, "every combination needs a label");
      assert.ok(Array.isArray(combo.setIds) && combo.setIds.length > 0);
    }

    // The 20-type catalog: exactly the canonical types, no 21st entry, no
    // empty-type hiding, plus a diagnosis for the unknown type.
    assert.equal(refs.types.length, 20);
    const typeByName = new Map(refs.types.map((entry) => [entry.type, entry]));
    assert.equal(typeByName.get("color").cells, 9);
    assert.equal(typeByName.get("boolean").cells, 1);
    assert.equal(typeByName.get("spacing").cells, 4);
    // Unknown type input cannot reach the library at all: the canonical
    // boundary rejects it with a precise diagnostic (R18 未知输入诊断).
    const badValues = buildEditorPackageValues();
    const badLibrary = badValues.get([...badValues.keys()].find((entry) => entry.startsWith("tokens/")));
    badLibrary.sets.push({
      description: "bad type",
      id: "tset_reference_bad",
      name: "reference/bad",
      tokens: [{ description: "", id: "tok_reference_bad", name: "weird", type: "hypertype", value: 1 }],
    });
    const badDir = await mkdtemp(join(tmpdir(), "smallpen-dse-bad-"));
    try {
      const badPath = join(badDir, "bad.smallpen");
      await writePackage(badPath, badValues);
      await assert.rejects(
        () => openPackage(badPath),
        (error) => error.code === "unsupported_token_type",
        "unknown token types must be rejected at the canonical boundary",
      );
    } finally {
      await rm(badDir, { recursive: true, force: true });
    }

    // color/light Cells live in the two Light combinations; the coverage set
    // (active, unclaimed by any domain) appears in ALL four; archived Cells
    // (covered by no combination and not active) still get a specimen in the
    // archived band.
    const lightCombos = refs.combinations.filter((combo) =>
      combo.setIds.includes("tset_canvas_color_light"),
    );
    assert.equal(lightCombos.length, 2);
    const colorKeys = refs.specimenKeysByToken[COLOR_TOKEN_ID];
    assert.equal(colorKeys.length, lightCombos.length);
    const coverageKeys = refs.specimenKeysByToken.tok_coverage_number;
    assert.equal(coverageKeys.length, 4, "active unclaimed Cells observe every combination");
    const archivedSpecimen = Object.values(refs.specimens).find(
      (candidate) => candidate.combinationId === null,
    );
    assert.ok(archivedSpecimen, "archived Cells keep a specimen in the archived band");
    assert.equal(archivedSpecimen.tokenId, "tok_reference_archived_color");
    assert.equal(archivedSpecimen.status, "archived");

    // Every specimen maps back to its token cell through the reverse map,
    // with per-combination ids distinct from each other.
    for (const key of [...colorKeys, ...coverageKeys]) {
      const spec = refs.specimens[key];
      assert.equal(
        snapshot.runtime.reverseDesignSystem[spec.shape]?.kind,
        "token-cell",
        `specimen ${key} must be a write target`,
      );
    }
    assert.notEqual(
      refs.specimens[colorKeys[0]].shape,
      refs.specimens[colorKeys[1]].shape,
      "combination specimens of one Cell are distinct shapes",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("every canonical type has a real write path on the panorama (DSE-R19~R24/R26)", async () => {
  const { packagePath, parent, snapshot } = await coveragePackage();
  try {
    const pageId = snapshot.runtime.designSystemPage;
    const edit = (tokenId, attr, val, extra = []) =>
      compilePenpotChanges(snapshot, {
        changes: [
          modObject(
            specimen(snapshot, tokenId).shape,
            [{ type: "set", attr, val }, ...extra],
            pageId,
          ),
        ],
        commitId: `dse-gate-${tokenId}`,
      });

    // Shape-bound attribute edits.
    const cases = [
      ["tok_coverage_opacity", "opacity", 42, 0.42],
      ["tok_coverage_rotation", "rotation", -30, -30],
      ["tok_coverage_dimensions", "width", 96, 96],
      ["tok_coverage_dimensions", "height", 96, 96],
      ["tok_coverage_font_size", "font-size", 32, 32],
      ["tok_coverage_letter_spacing", "letter-spacing", 4, 4],
      ["tok_coverage_font_family", "font-family", "Sourcesanspro", "Sourcesanspro"],
      ["tok_coverage_font_weight", "font-weight", "800", 800],
      ["tok_coverage_text_case", "text-transform", "lowercase", "lowercase"],
      ["tok_coverage_text_decoration", "text-decoration", "line-through", "line-through"],
    ];
    for (const [tokenId, attr, val, expected] of cases) {
      const batch = edit(tokenId, attr, val);
      const op = batch.operations.find((candidate) => candidate.type === "set-token-value");
      assert.ok(op, `${attr} edit must compile for ${tokenId}`);
      assert.equal(op.tokenId, tokenId);
      assert.equal(op.value, expected, `${attr} value translation for ${tokenId}`);
    }

    // Scalar value cards: text content edits parse and validate per type.
    const scalarCases = [
      ["tok_coverage_string", "NEW 字面值", "NEW 字面值"],
      ["tok_coverage_number", " 42.5 ", 42.5],
      ["tok_coverage_boolean", "false", false],
      ["tok_coverage_other", '{"k":[1,2]}', '{"k":[1,2]}'],
    ];
    for (const [tokenId, text, expected] of scalarCases) {
      const batch = edit(tokenId, "content", {
        type: "root",
        children: [{ type: "paragraph-set", children: [{ type: "paragraph", children: [{ type: "text", text }] }] }],
      });
      const op = batch.operations.find((candidate) => candidate.type === "set-token-value");
      assert.ok(op, `content edit must compile for ${tokenId}`);
      assert.deepEqual(op.value, expected, `scalar parse for ${tokenId}`);
    }

    // Invalid scalar values fail BEFORE any write happens.
    for (const [tokenId, bad] of [
      ["tok_coverage_boolean", "true-ish"],
      ["tok_coverage_number", "abc"],
      ["tok_coverage_other", "{broken"],
    ]) {
      assert.throws(
        () =>
          edit(tokenId, "content", {
            type: "root",
            children: [{ type: "paragraph-set", children: [{ type: "paragraph", children: [{ type: "text", text: bad }] }] }],
          }),
        (error) => error.details?.code === "design_system_token_value_invalid" || error.code === "design_system_token_value_invalid",
        `invalid ${tokenId} value must be rejected`,
      );
    }

    // The Token inspector path: a full token-value rewrite (typography
    // record) compiles to one set-token-value.
    const typographyBatch = edit("tok_canvas_typography_desktop_heading", "token-value", {
      fontFamily: "Inter",
      fontId: "gfont-inter",
      fontSize: 40,
      fontWeight: 700,
      lineHeight: 1.4,
    });
    const typographyOp = typographyBatch.operations.find(
      (candidate) => candidate.type === "set-token-value",
    );
    assert.ok(typographyOp, "typography token-value edit must compile");
    assert.equal(typographyOp.value.fontSize, 40);
    assert.equal(typographyOp.value.fontWeight, 700);

    // A real applied batch writes the coverage Cell and Undo restores it.
    const applied = await applyOperationBatch(packagePath, edit("tok_coverage_opacity", "opacity", 80));
    const written = JSON.parse(
      await readFile(packagePath + "/tokens/canvas.json", "utf8"),
    );
    const coverageSet = written.sets.find((set) => set.id === COVERAGE_SET_ID);
    assert.equal(
      coverageSet.tokens.find((token) => token.id === "tok_coverage_opacity").value,
      0.8,
    );
    const opened = await openPackage(packagePath);
    await applyOperationBatch(packagePath, {
      ...applied.inverseBatch,
      baseRevision: opened.revision,
    });
    const undone = JSON.parse(
      await readFile(packagePath + "/tokens/canvas.json", "utf8"),
    );
    const undoneSet = undone.sets.find((set) => set.id === COVERAGE_SET_ID);
    assert.equal(
      undoneSet.tokens.find((token) => token.id === "tok_coverage_opacity").value,
      0.42,
      "undo must restore the coverage Cell",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("alias Cells keep attribute edits locked but rewrite the expression via the token-value path (DSE-R26)", async () => {
  const { parent, snapshot } = await coveragePackage();
  try {
    const aliasRef = specimen(snapshot, ALIAS_TOKEN_ID);
    const pageId = snapshot.runtime.designSystemPage;
    // Attribute edits on an alias display stay rejected without writes.
    assert.throws(
      () =>
        compilePenpotChanges(snapshot, {
          changes: [
            modObject(
              aliasRef.shape,
              [{ type: "set", attr: "r1", val: 24 }],
              pageId,
            ),
          ],
          commitId: "dse-gate-alias-attr",
        }),
      (error) =>
        error.details?.code === "design_system_token_readonly" ||
        error.code === "design_system_token_readonly",
    );
    // The token-value path rewrites the EXPRESSION (not a resolved value).
    const batch = compilePenpotChanges(snapshot, {
      changes: [
        modObject(
          aliasRef.shape,
          [{ type: "set", attr: "token-value", val: "{radius/md.base}" }],
          pageId,
        ),
      ],
      commitId: "dse-gate-alias-expression",
    });
    const op = batch.operations.find((candidate) => candidate.type === "set-token-value");
    assert.ok(op, "alias expression rewrite must compile");
    assert.equal(op.tokenId, ALIAS_TOKEN_ID);
    assert.equal(op.value, "{radius/md.base}", "the alias expression is the written value");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
