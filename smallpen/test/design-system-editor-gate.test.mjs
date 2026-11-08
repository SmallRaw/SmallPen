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

import { readModelEntry, tokenEntry, writeModelPackage } from "./helpers/named.mjs";
import {
  buildEditorPackageValues,
  EDITOR_NESTED_NODES,
} from "./fixtures/design-system-editor-fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const writePackage = (dir, values) => writeModelPackage(dir, values);

async function editorPackage() {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-dse-gate-"));
  const packagePath = join(parent, "editor.smallpen");
  await writePackage(packagePath, buildEditorPackageValues());
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
      !tokenEntry(snapshot).activeSetIds.includes(
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
    const written = await readModelEntry(packagePath, "tokens/canvas.json");
    const lightSet = written.sets.find((set) => set.id === "tset_canvas_color_light");
    assert.equal(
      lightSet.tokens.find((token) => token.id === COLOR_TOKEN_ID).value,
      "#22c55e",
    );
    const manifest = await readModelEntry(packagePath, "manifest.json");
    assert.equal(manifest.entries.screens.length, 2, "canonical screens drifted");

    // Undo replays the committed inverse batch against the new revision.
    const opened = await openPackage(packagePath);
    await applyOperationBatch(packagePath, {
      ...applied.inverseBatch,
      baseRevision: opened.revision,
    });
    const undone = await readModelEntry(packagePath, "tokens/canvas.json");
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
    const componentsProbe = await readModelEntry(packagePath, snapshot.manifest.entries.components[0]);
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
    assert.equal(rootOp.componentId, family.componentSetId);
    assert.equal(rootOp.variantId, family.variantId);
    assert.ok(rootOp.changes.fills, "root fill not compiled");
    assert.equal(labelOp.changes.text, "Primary!");

    const applied = await applyOperationBatch(packagePath, batch);
    const componentsEntry = snapshot.manifest.entries.components[0];
    const component = await readModelEntry(packagePath, componentsEntry);
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
    const undone = await readModelEntry(packagePath, componentsEntry);
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
    const home = await readModelEntry(packagePath, screen);
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
  const written = await readModelEntry(packagePath, "tokens/canvas.json");
  return written.sets.flatMap((set) => set.tokens).find((token) => token.id === STROKE_TOKEN_ID).value;
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

test("token specimen gap edit reads Penpot's row-gap / column-gap keys", async () => {
  const { parent, snapshot } = await editorPackage();
  try {
    const ref = specimen(snapshot, SPACING_TOKEN_ID);
    assert.equal(ref.attribute, "gap");
    const compile = (val) =>
      compilePenpotChanges(snapshot, {
        changes: [
          modObject(
            ref.shape,
            [{ type: "set", attr: "layout-gap", val }],
            snapshot.runtime.designSystemPage,
          ),
        ],
        commitId: "dse-gate-gap",
      }).operations.find((operation) => operation.type === "set-token-value");
    // The Penpot layout panel writes kebab-case gap keys.
    const op = compile({ "row-gap": 12, "column-gap": 12 });
    assert.equal(op.tokenId, SPACING_TOKEN_ID);
    assert.equal(op.value, 12);
    assert.equal(compile({ columnGap: 6, rowGap: 6 }).value, 6);
    assert.throws(
      () => compile({ "row-gap": 12, "column-gap": 4 }),
      (error) => error.code === "design_system_unsupported_attribute",
    );
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
  const written = await readModelEntry(packagePath, "tokens/canvas.json");
  return written.sets.flatMap((set) => set.tokens).find((token) => token.id === SHADOW_TOKEN_ID).value;
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
    // tokens.css stores colors as hex, so the restored value reads as hex.
    assert.deepEqual(await readShadowToken(packagePath), {
      color: "#0000003d",
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
    ["manifest.json", await readModelEntry(packagePath, "manifest.json")],
  ]);
  for (const entries of Object.values(snapshot.manifest.entries)) {
    for (const entry of entries) {
      files.set(entry, await readModelEntry(packagePath, entry));
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
    const componentsProbe = await readModelEntry(packagePath, snapshot.manifest.entries.components[0]);
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
    assert.equal(componentOps[0].componentId, family.componentSetId);
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
        snapshot.manifest.entries.screens.find((entry) => snapshot.entries[entry].name === "Home"),
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
        snapshot.entries[entry].name === "Home",
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

// One Cell per tokens.css type the editor fixture does not carry yet. The
// set is ACTIVE but claimed by no Token Domain, so it must appear in EVERY
// valid Workbench Combination view.
function coverageTokens() {
  return [
    ["tok_coverage_boolean", "flag", "boolean", true],
    ["tok_coverage_font_family", "family", "font-family", "Inter"],
    ["tok_coverage_font_size", "size", "font-size", 24],
    ["tok_coverage_font_weight", "weight", "font-weight", 700],
    ["tok_coverage_letter_spacing", "tracking", "letter-spacing", 1.5],
    ["tok_coverage_opacity", "veil", "opacity", 0.42],
    ["tok_coverage_string", "label", "string", "Hello 覆盖"],
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
  values.set(libraryEntry, library);
  const parent = await mkdtemp(join(tmpdir(), "smallpen-dse-coverage-"));
  const packagePath = join(parent, "coverage.smallpen");
  await writePackage(packagePath, values);
  const snapshot = await openPackage(packagePath);
  return { packagePath, parent, snapshot, libraryEntry };
}

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
