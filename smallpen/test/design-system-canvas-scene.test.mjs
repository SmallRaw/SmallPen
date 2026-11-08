// DSC-004: canvas scene protocol tests — stable ids, collision freedom,
// decoration write-target absence, and the serialization contract.
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCanvasScene,
  loadPackageFromValues,
  CANVAS_SCENE_VERSION,
} from "@smallpen/core";

import {
  buildCanvasFoundationValues,
  buildCanvasPackageValues,
  CANVAS_FOUNDATION_ID,
  CANVAS_PACKAGE_ID,
  canvasCombinations,
} from "./fixtures/design-system-canvas-fixture.mjs";

async function loadAll() {
  const product = await loadPackageFromValues(
    `memory://${CANVAS_PACKAGE_ID}.smallpen`,
    buildCanvasPackageValues(),
  );
  const foundation = await loadPackageFromValues(
    `memory://${CANVAS_FOUNDATION_ID}.smallpen`,
    buildCanvasFoundationValues(),
  );
  return { foundation, product };
}

test("scene rebuilds of the same source and combination are byte-stable", async () => {
  const { foundation, product } = await loadAll();
  const sceneA = buildCanvasScene(product, {
    combination: canvasCombinations()[0],
    foundation,
  });
  const sceneB = buildCanvasScene(product, {
    combination: canvasCombinations()[0],
    foundation,
  });
  assert.deepEqual(sceneA, sceneB);
  assert.equal(sceneA.sceneVersion, CANVAS_SCENE_VERSION);
  assert.equal(sceneA.revision, product.revision);
});

test("different owners and different instances never collide", async () => {
  const { foundation, product } = await loadAll();
  const scene = buildCanvasScene(product, {
    combination: canvasCombinations()[0],
    foundation,
  });
  const byRef = (predicate) =>
    Object.values(scene.nodes)
      .filter((node) => predicate(node.sourceRef))
      .map((node) => node.id);
  const ids = (list) => new Set(list);

  // Same-name tokens across owners keep distinct scene ids.
  const productSurface = byRef(
    (ref) => ref.kind === "token-cell" && ref.ownerPackageId === CANVAS_PACKAGE_ID && ref.path === "surface",
  );
  const foundationSurface = byRef(
    (ref) => ref.kind === "token-cell" && ref.ownerPackageId === CANVAS_FOUNDATION_ID && ref.path === "surface",
  );
  // The token board lists the FULL inventory (active and inactive rows),
  // so the product owns two surface Cells (light + dark) and the
  // foundation one; every row keeps a distinct scene id.
  assert.equal(productSurface.length, 2);
  assert.equal(foundationSurface.length, 1);
  assert.equal(new Set([...productSurface, ...foundationSurface]).size, 3);

  // Cross-page instances of the same component keep distinct scene ids.
  const homeButton = scene.nodes[
    byRef(
      (ref) =>
        ref.kind === "page-occurrence" &&
        ref.pageId === "scr_canvas_home" &&
        ref.sourceNodeId === "node_home_button_primary",
    )[0]
  ];
  const settingsButton = scene.nodes[
    byRef(
      (ref) =>
        ref.kind === "page-occurrence" &&
        ref.pageId === "scr_canvas_settings" &&
        ref.sourceNodeId === "node_settings_button_primary",
    )[0]
  ];
  assert.notEqual(homeButton.id, settingsButton.id);
  // And the occurrence carries the shared component identity explicitly.
  assert.deepEqual(homeButton.sourceRef.instanceOf.component, {
    assetId: "cmp_canvas_button",
    packageId: CANVAS_PACKAGE_ID,
  });

  // Definition nodes never share ids with page occurrence nodes.
  const definitionIds = ids(
    byRef((ref) => ref.kind === "component-definition"),
  );
  assert.ok(!definitionIds.has(homeButton.id));
});

test("decorations have no write target and no editable fields", async () => {
  const { product } = await loadAll();
  const scene = buildCanvasScene(product, {
    combination: canvasCombinations()[0],
  });
  const decorations = Object.values(scene.nodes).filter(
    (node) => node.decoration,
  );
  assert.ok(decorations.length > 0, "scene contains generated decorations");
  for (const node of decorations) {
    // No write target: the decoration kind plus zero editable fields is
    // the whole contract. ownerPackageId, when present, is informational
    // grouping (a component section names the package it groups).
    assert.equal(node.sourceRef.kind, "decoration");
    assert.deepEqual(node.editableFields, []);
  }
  // Purely structural boards keep no owner at all.
  for (const node of decorations.filter((entry) => entry.kind === "board")) {
    assert.equal(node.sourceRef.ownerPackageId, null);
  }
  // Boards and section headers are decorations; specimens are not.
  assert.ok(decorations.some((node) => node.kind === "board"));
  assert.ok(decorations.some((node) => node.kind === "section"));
});

test("every sourceRef kind of the protocol appears on the fixture", async () => {
  const { foundation, product } = await loadAll();
  const scene = buildCanvasScene(product, {
    combination: canvasCombinations()[0],
    foundation,
  });
  const kinds = new Set(
    Object.values(scene.nodes).map((node) => node.sourceRef.kind),
  );
  for (const kind of [
    "token-cell",
    "component-definition",
    "page-occurrence",
    "page-node",
    "decoration",
  ]) {
    assert.ok(kinds.has(kind), `sourceRef kind present: ${kind}`);
  }
  // Instance occurrences expose only canonical-override editable fields.
  const occurrences = Object.values(scene.nodes).filter(
    (node) => node.kind === "page-occurrence",
  );
  const allowed = new Set(["fills", "name", "opacity", "text", "visible"]);
  for (const occurrence of occurrences) {
    for (const field of occurrence.editableFields) {
      assert.ok(allowed.has(field), `override field allowed: ${field}`);
    }
  }
  // Token specimens are editable in their Cell value.
  const specimen = Object.values(scene.nodes).find(
    (node) => node.sourceRef.kind === "token-cell",
  );
  assert.deepEqual(specimen.editableFields, ["value"]);
});

// ---------------------------------------------------------------------------
// DSC-005/006/007: catalog collectors.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// DSC-008: deterministic auto-layout.
// ---------------------------------------------------------------------------
import { CANVAS_LAYOUT_VERSION, layoutCanvasScene } from "@smallpen/core";

test("DSC-008: layout is deterministic and versioned", async () => {
  const { foundation, product } = await loadAll();
  const scene = buildCanvasScene(product, {
    combination: canvasCombinations()[0],
    foundation,
  });
  const layoutA = layoutCanvasScene(scene);
  const layoutB = layoutCanvasScene(scene);
  assert.deepEqual(layoutA, layoutB, "same input, same layout");
  assert.equal(layoutA.layoutVersion, CANVAS_LAYOUT_VERSION);
  assert.ok(layoutA.bounds.width > 0 && layoutA.bounds.height > 0);
  // Every scene node receives bounds.
  for (const node of Object.values(scene.nodes)) {
    assert.ok(layoutA.nodes[node.id]?.bounds, `bounds for ${node.id}`);
  }
});

test("DSC-008: long labels widen columns and never overlap siblings", async () => {
  const { foundation, product } = await loadAll();
  const scene = buildCanvasScene(product, {
    combination: canvasCombinations()[0],
    foundation,
  });
  const measure = (text) => (text.length > 10 ? 4000 : 20);
  const layout = layoutCanvasScene(scene, { measureText: measure });
  const specimens = Object.values(layout.nodes).filter(
    (node) => !node.decoration && node.parent,
  );
  let overlaps = 0;
  for (let i = 0; i < specimens.length; i += 1) {
    for (let j = i + 1; j < specimens.length; j += 1) {
      if (specimens[i].parent !== specimens[j].parent) continue;
      const a = specimens[i].bounds;
      const b = specimens[j].bounds;
      if (
        a &&
        b &&
        a.x < b.x + b.width &&
        b.x < a.x + a.width &&
        a.y < b.y + b.height &&
        b.y < a.y + a.height
      ) {
        overlaps += 1;
      }
    }
  }
  assert.equal(overlaps, 0, "measured layout prevents sibling overlap");
  assert.equal(layout.measure, "injected");
});

test("DSC-008: adding and removing sources rebuilds a fresh layout", async () => {
  const values = buildCanvasPackageValues();
  const foundationValues = buildCanvasFoundationValues();
  const product = await loadPackageFromValues("memory://canvas", values);
  const foundation = await loadPackageFromValues(
    "memory://canvas-shared",
    foundationValues,
  );
  const before = layoutCanvasScene(
    buildCanvasScene(product, { combination: canvasCombinations()[0], foundation }),
  );
  // Remove a token set from the source and rebuild.
  const library = values.get("tokens/canvas.json");
  library.sets = library.sets.filter((set) => set.name !== "effect/md");
  for (const theme of library.themes) {
    theme.setIds = theme.setIds.filter((setId) => setId !== "tset_canvas_effect");
  }
  library.activeSetIds = library.activeSetIds.filter(
    (setId) => setId !== "tset_canvas_effect",
  );
  const reduced = await loadPackageFromValues("memory://canvas", values);
  const after = layoutCanvasScene(
    buildCanvasScene(reduced, { combination: canvasCombinations()[0], foundation }),
  );
  assert.ok(
    before.bounds.height > after.bounds.height,
    "fewer tokens shrink the canvas",
  );
  assert.ok(
    !Object.keys(after.nodes).some((id) => id.includes("effect/md")),
    "removed family leaves the layout",
  );
});
