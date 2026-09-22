// DSC-002: verifies the two-axis four-combination canvas fixture against the
// expected raw/resolved table. Pure reads only: loading and previewing must
// not mutate the source values.
import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkbenchPreview,
  enumerateWorkbenchCombinations,
  loadPackageFromValues,
  projectScreen,
  tokenInventoryRows,
} from "@smallpen/core";

import {
  buildCanvasFoundationValues,
  buildCanvasPackageValues,
  CANVAS_DOMAIN_IDS,
  CANVAS_FOUNDATION_ID,
  CANVAS_PACKAGE_ID,
  CANVAS_THEME_IDS,
  canvasCombinations,
  canvasExpected,
  combinationKey,
} from "./fixtures/design-system-canvas-fixture.mjs";

async function loadCanvas() {
  return loadPackageFromValues(
    `memory://${CANVAS_PACKAGE_ID}.smallpen`,
    buildCanvasPackageValues(),
  );
}

// Within one observed combination the visible token paths are unique (the
// paired theme activates exactly one set per axis family), so path is the
// stable lookup key across device/mode switches.
function rowsByPath(previewResult) {
  return new Map(previewResult.tokens.map((row) => [row.path, row]));
}

test("canvas fixture enumerates exactly the device and mode domains", async () => {
  const snapshot = await loadCanvas();
  const enumeration = enumerateWorkbenchCombinations(snapshot);
  assert.deepEqual(enumeration.diagnostics, []);
  assert.deepEqual(
    enumeration.domains.map((domain) => domain.domain),
    ["device", "mode"],
  );
  const [device, mode] = enumeration.domains;
  assert.deepEqual(
    device.variants.map((variant) => variant.name),
    ["Mobile", "Desktop"],
  );
  assert.deepEqual(
    mode.variants.map((variant) => variant.name),
    ["Light", "Dark"],
  );
  // Four combinations are constructible and each validates cleanly.
  for (const combination of canvasCombinations()) {
    const validation = await import("@smallpen/core").then(({ validateWorkbenchCombination }) =>
      validateWorkbenchCombination(snapshot, combination),
    );
    assert.deepEqual(validation.diagnostics, []);
  }
});

for (const combination of canvasCombinations()) {
  const key = combinationKey(combination);
  test(`combination ${key} matches the expected raw/resolved table`, async () => {
    const snapshot = await loadCanvas();
    const preview = await createWorkbenchPreview(snapshot, combination);
    const rows = rowsByPath(preview);
    const expected = canvasExpected()[key];
    assert.ok(expected, `expected table has ${key}`);

    const assertRow = (tokenId, expectations) => {
      const row = rows.get(tokenId);
      if (expectations.unset) {
        // Unset = the Cell's home set is not observed under this
        // combination, so the whole row is absent. Absence must be total:
        // no stale row with a 0/"" value is acceptable.
        assert.ok(
          row === undefined ||
            row.resolved === undefined ||
            row.resolved === null,
          `unset token must not surface a stale value: ${JSON.stringify(row)}`,
        );
        return;
      }
      assert.ok(row, `row exists for ${tokenId}`);
      if (expectations.raw !== undefined) {
        assert.deepEqual(row.raw, expectations.raw, `${tokenId} raw`);
      }
      if (expectations.resolved !== undefined) {
        assert.deepEqual(row.resolved, expectations.resolved, `${tokenId} resolved`);
      }
      if (expectations.resolvedFontSize !== undefined) {
        assert.equal(row.resolved.fontSize, expectations.resolvedFontSize);
        assert.equal(row.resolved.lineHeight, expectations.resolvedLineHeight);
      }
    };

    for (const [name, expectations] of Object.entries(expected)) {
      assertRow(name, expectations);
    }
  });
}

test("same-name tokens keep distinct read-only owners in the inventory", async () => {
  const product = await loadCanvas();
  const foundation = await loadPackageFromValues(
    `memory://${CANVAS_FOUNDATION_ID}.smallpen`,
    buildCanvasFoundationValues(),
  );
  const rows = [
    ...tokenInventoryRows(product, "product"),
    ...tokenInventoryRows(foundation, "foundation"),
  ].map((row) => ({
    // The qualified key prefix is the owner identity.
    qualifiedKey: row.qualifiedKey,
    owner: row.qualifiedKey.split("/")[0],
    path: row.path,
    value: row.value,
    status: row.status,
    readOnly: row.qualifiedKey.split("/")[0] !== CANVAS_PACKAGE_ID,
  }));
  const surfaces = rows.filter((row) => row.path === "surface");
  // Same name, three distinct owners/sets: product Light, product Dark and
  // the read-only foundation — each with its own qualified key.
  assert.equal(surfaces.length, 3);
  assert.ok(
    surfaces.some(
      (row) =>
        row.qualifiedKey ===
          `${CANVAS_PACKAGE_ID}/color/light/surface` && row.value === "#ffffff",
    ),
  );
  assert.ok(
    surfaces.some(
      (row) =>
        row.qualifiedKey ===
          `${CANVAS_PACKAGE_ID}/color/dark/surface` && row.value === "#1b1b1f",
    ),
  );
  assert.ok(
    surfaces.some(
      (row) =>
        row.qualifiedKey ===
          `${CANVAS_FOUNDATION_ID}/color/light/surface` &&
        row.value === "#eef2ff",
    ),
  );
  assert.ok(
    surfaces.some((row) => row.owner === CANVAS_FOUNDATION_ID && row.readOnly),
    "foundation rows are read-only",
  );
  const primaries = rows.filter(
    (row) => row.path === "primary" && row.status === "ok",
  );
  assert.equal(primaries.length, 3, "primary also exists in both owners");
});

test("reads are pure: loading and previewing do not mutate the source values", async () => {
  const values = buildCanvasPackageValues();
  const libraryBefore = structuredClone(values.get("tokens/canvas.json"));
  const snapshot = await loadCanvas();
  const enumeration = enumerateWorkbenchCombinations(snapshot);
  const dark = [
    { domainId: CANVAS_DOMAIN_IDS.device, themeId: CANVAS_THEME_IDS.deviceDesktop },
    { domainId: CANVAS_DOMAIN_IDS.mode, themeId: CANVAS_THEME_IDS.modeDark },
  ];
  await createWorkbenchPreview(snapshot, dark);
  assert.deepEqual(
    values.get("tokens/canvas.json").activeThemeIds,
    libraryBefore.activeThemeIds,
    "observed combination must not leak into the source",
  );
  assert.deepEqual(
    values.get("tokens/canvas.json"),
    libraryBefore,
    "source values unchanged after preview",
  );
  assert.equal(
    snapshot.entries["tokens/canvas.json"].activeThemeIds.length,
    libraryBefore.activeThemeIds.length,
  );
  void enumeration;
});

// ---------------------------------------------------------------------------
// DSC-003: real component families, two ordinary pages, cross-page shared
// instance with override, unregistered headers and the hardcoded negative.
// ---------------------------------------------------------------------------

test("component families expose every variant with real text children", async () => {
  const values = buildCanvasPackageValues();
  const components = values.get("components/canvas-components.json");
  const byName = new Map(
    components.componentSets.map((set) => [set.name, set]),
  );
  assert.deepEqual(
    [...byName.keys()].sort(),
    ["Badge", "Button", "Card", "Input"],
    "component families",
  );
  const button = byName.get("Button");
  assert.equal(button.variants.length, 3, "Button has three variants");
  assert.deepEqual(
    button.variants.map((variant) => variant.selection.axis_variant).sort(),
    ["ghost", "primary", "secondary"],
  );
  for (const variant of button.variants) {
    const label = Object.values(variant.nodes).find(
      (node) => node.type === "TEXT",
    );
    assert.ok(label, `Button/${variant.selection.axis_variant} has a TEXT child`);
    assert.ok(label.textStyle.fontId, "label carries a real font id");
  }
  assert.equal(byName.get("Input").variants.length, 2, "Input has two variants");
  assert.ok(byName.get("Card").variants.length >= 1, "Card exists");
});

test("two ordinary pages carry unregistered headers and instance sources", async () => {
  const values = buildCanvasPackageValues();
  const manifest = values.get("manifest.json");
  assert.deepEqual(manifest.entries.screens, [
    "screens/canvas-page-home.json",
    "screens/canvas-page-settings.json",
  ]);
  const home = values.get("screens/canvas-page-home.json");
  const settings = values.get("screens/canvas-page-settings.json");

  // Unregistered headers: plain FRAME compositions, no Header component.
  const components = values.get("components/canvas-components.json");
  assert.ok(
    !components.componentSets.some((set) => /header/i.test(set.name)),
    "no Header component may be registered",
  );
  for (const screen of [home, settings]) {
    const nodes = screen.presentations[0].nodes;
    const header = Object.values(nodes).find((node) =>
      / Header$/.test(node.name),
    );
    assert.ok(header, `${screen.name} has a header`);
    assert.equal(header.type, "FRAME", "header is an unregistered composition");
    assert.ok(
      !header.tokenBindings,
      "unregistered header carries no token bindings",
    );
  }

  // Instance sources: each INSTANCE names its component and variant.
  const homeNodes = home.presentations[0].nodes;
  const homeInstances = Object.values(homeNodes).filter(
    (node) => node.type === "INSTANCE",
  );
  assert.deepEqual(
    homeInstances.map((instance) => [
      instance.instance.component.assetId,
      JSON.stringify(instance.instance.variant),
    ]),
    [
      ["cmp_canvas_button", '{"axis_variant":"primary"}'],
      ["cmp_canvas_card", '{"axis_state":"idle"}'],
    ],
  );
  const settingsNodes = settings.presentations[0].nodes;
  const settingsButton = settingsNodes.node_settings_button_primary;
  assert.equal(
    settingsButton.instance.component.assetId,
    "cmp_canvas_button",
    "settings reuses the same Button component (cross-page share)",
  );
  assert.deepEqual(
    settingsButton.instance.overrides,
    { "node_canvas_button_primary_label:text": "Save" },
    "settings button carries the explicit text override",
  );

  // Hardcoded negative control: no bindings, literal values only.
  const negative = homeNodes.node_home_hardcoded_caption;
  assert.ok(negative, "hardcoded negative control exists");
  assert.ok(!negative.tokenBindings, "negative control has no bindings");
});

test("projectScreen applies the override on Settings but not on Home", async () => {
  const product = await loadCanvas();
  const home = await projectScreen(product, "scr_canvas_home");
  const settings = await projectScreen(product, "scr_canvas_settings");

  const labelOf = (projection, instanceId, sourceNodeId) => {
    const prefixed = projection.nodes[`${instanceId}__${sourceNodeId}`];
    return prefixed ? prefixed.text : undefined;
  };
  const homeLabel = labelOf(
    home,
    "node_home_button_primary",
    "node_canvas_button_primary_label",
  );
  assert.equal(homeLabel, "Primary", "Home label keeps the main definition");
  const settingsLabel = labelOf(
    settings,
    "node_settings_button_primary",
    "node_canvas_button_primary_label",
  );
  assert.equal(settingsLabel, "Save", "Settings override applied locally");

  // Home keeps its own instance roots untouched (negative control).
  const homeRoot = home.nodes.node_home_button_primary;
  assert.ok(homeRoot, "Home instance root still projected");
});
