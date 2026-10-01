// Stroke color Token bindings: core validation and resolution per Context,
// the Web projection, and the Penpot applied stroke-color Token.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import test from "node:test";

import {
  listPackageEntries,
  loadPackageFromValues,
  prepareOperationBatch,
  projectEffectiveSnapshot,
  projectScreen,
  readDesignView,
  SMALLPEN_FORMAT_CAPABILITIES,
} from "@smallpen/core";
import { createEvidence, openPackage } from "@smallpen/local-package";
import { compilePenpotChanges } from "@smallpen/penpot-adapter";

import { createWebWorkspaceSnapshot } from "../apps/background/src/web-projection.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "apps", "cli", "bin", "smallpen.mjs");
const ROUNDTRIP = join(here, "fixtures", "roundtrip.smallpen");
const DESIGN_SYSTEM = join(here, "fixtures", "design-system.smallpen");
const SCREEN = "scr_design_system";
const PRESENTATION = "pres_desktop";
const SWATCH = "node_swatch_primary";

async function fixtureValues(fixture) {
  const manifest = JSON.parse(await readFile(join(fixture, "manifest.json"), "utf8"));
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of listPackageEntries(manifest).entries) {
    values.set(entry, JSON.parse(await readFile(join(fixture, entry), "utf8")));
  }
  return values;
}

// The roundtrip rectangle with two strokes and a border Token whose dark
// Context value differs from its base value.
async function contextualStrokeValues() {
  const values = await fixtureValues(ROUNDTRIP);
  const manifest = values.get("manifest.json");
  manifest.entries.tokens = ["tokens/dtcg.json"];
  manifest.entries.contexts = ["contexts/design.json"];
  values.set("tokens/dtcg.json", {
    color: {
      border: {
        $extensions: {
          smallpen: {
            contextValues: [{ value: "#ff0000", when: { axis_theme: "dark" } }],
            id: "tok_border",
            visibility: "public",
          },
        },
        $type: "color",
        $value: "#0000ff",
      },
    },
    size: {
      card: {
        $extensions: { smallpen: { id: "tok_card", visibility: "public" } },
        $type: "sizing",
        $value: 240,
      },
    },
  });
  values.set("contexts/design.json", {
    axes: [{
      defaultValue: "light",
      id: "axis_theme",
      kind: "theme",
      name: "Theme",
      values: [{ id: "light", name: "Light" }, { id: "dark", name: "Dark" }],
    }],
    profiles: [],
  });
  const rectangle = values.get("screens/roundtrip.json").presentations[0].nodes.node_rectangle;
  rectangle.strokes = [
    { alignment: "inner", color: "#000000", type: "solid", width: 10 },
    { alignment: "outer", color: "#00ff00", type: "solid", width: 2 },
  ];
  return values;
}

function bind(snapshot, field, assetId, nodeId = "node_rectangle") {
  return prepareOperationBatch(snapshot, {
    baseRevision: snapshot.revision,
    batchId: `bind-${field}`,
    operations: [{
      binding: { assetId, packageId: snapshot.manifest.packageId },
      field,
      nodeId,
      screenId: "scr_roundtrip",
      type: "set-token-binding",
    }],
  });
}

function pngPixel(bytes, width, x, y) {
  const chunks = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = Buffer.from(bytes).readUInt32BE(offset);
    const type = Buffer.from(bytes.slice(offset + 4, offset + 8)).toString("ascii");
    if (type === "IDAT") chunks.push(bytes.slice(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const pixels = inflateSync(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  const row = y * (width * 4 + 1);
  return [...pixels.slice(row + 1 + x * 4, row + 1 + x * 4 + 4)];
}

test("stroke and strokes.N are advertised colour binding fields", () => {
  const fields = SMALLPEN_FORMAT_CAPABILITIES.canonicalPackage.tokenBindingFields;
  assert.ok(fields.includes("stroke"));
  assert.ok(fields.includes("strokes.N"));
});

test("a stroke binding resolves per Context and the dark render changes the stroke", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://stroke.smallpen",
    await contextualStrokeValues(),
  );
  const bound = (await bind(snapshot, "stroke", "tok_border")).snapshot;
  const view = (axisTheme) =>
    readDesignView(bound, {
      selector: { context: { axis_theme: axisTheme }, viewFormat: "structure" },
    }).result.nodes.node_rectangle.strokes;
  // Only the first stroke's color follows the Token; width and the second
  // stroke stay the node's own.
  assert.deepEqual(view("light"), [
    { alignment: "inner", color: "#0000ff", type: "solid", width: 10 },
    { alignment: "outer", color: "#00ff00", type: "solid", width: 2 },
  ]);
  assert.equal(view("dark")[0].color, "#ff0000");
  assert.equal(view("dark")[0].width, 10);

  const render = async (axisTheme) =>
    (await createEvidence(bound, {
      scale: 1,
      selector: { context: { axis_theme: axisTheme }, viewFormat: "screenshot" },
    })).render;
  const light = await render("light");
  const dark = await render("dark");
  // The rectangle sits at (80, 96); its inner stroke covers the first 10px.
  assert.deepEqual(pngPixel(light.bytes, light.width, 83, 150), [0, 0, 255, 255]);
  assert.deepEqual(pngPixel(dark.bytes, dark.width, 83, 150), [255, 0, 0, 255]);

  const second = (await bind(snapshot, "strokes.1", "tok_border")).snapshot;
  const secondDark = readDesignView(second, {
    selector: { context: { axis_theme: "dark" }, viewFormat: "structure" },
  }).result.nodes.node_rectangle.strokes;
  assert.equal(secondDark[0].color, "#000000");
  assert.equal(secondDark[1].color, "#ff0000");
  assert.equal(secondDark[1].width, 2);
});

test("stroke bindings fail on a missing stroke or a non-color Token", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://stroke.smallpen",
    await contextualStrokeValues(),
  );
  await assert.rejects(bind(snapshot, "strokes.2", "tok_border"), (error) =>
    error.code === "missing_token_binding_target");
  await assert.rejects(bind(snapshot, "stroke", "tok_card"), (error) =>
    error.code === "binding_type_mismatch");
  await assert.rejects(bind(snapshot, "strokes.x", "tok_border"), (error) =>
    error.code === "unsupported_token_binding");
});

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
    child.once("close", (code) => resolve({ code, stdout }));
  });
}

test("smallpen schema documents stroke color bindings", async () => {
  const node = await runCli(["schema", "node", "--json"], here);
  assert.equal(node.code, 0, node.stdout);
  const types = JSON.parse(node.stdout).tokenBindings.fieldTokenTypes;
  assert.deepEqual(types.stroke, ["color"]);
  assert.deepEqual(types["strokes.N"], ["color"]);
  const operation = await runCli(["schema", "set-token-binding", "--json"], here);
  assert.equal(operation.code, 0, operation.stdout);
  assert.match(operation.stdout, /stroke, strokes\.N/);
});

function runtimeId(snapshot, nodeId) {
  return Object.entries(snapshot.runtime.reverseNodes).find(
    ([, value]) => value.nodeId === nodeId,
  )[0];
}

function modObj(snapshot, nodeId, operations) {
  return {
    id: runtimeId(snapshot, nodeId),
    operations,
    "page-id": snapshot.runtime.pages[SCREEN][PRESENTATION],
    type: "mod-obj",
  };
}

const userSet = (attr, val) => ({
  attr,
  "ignore-geometry": false,
  "ignore-touched": false,
  type: "set",
  val,
});

async function served(snapshot) {
  const effective = projectEffectiveSnapshot(snapshot, {});
  const projected = await createWebWorkspaceSnapshot(effective, {});
  return { ...effective, runtime: projected.runtime, web: projected };
}

function swatch(snapshot) {
  return snapshot.entries["screens/screen.json"].presentations[0].nodes[SWATCH];
}

const STROKE = {
  "stroke-alignment": "inner",
  "stroke-color": "#6750a4",
  "stroke-opacity": 1,
  "stroke-style": "solid",
  "stroke-width": 4,
};

test("CLI stroke binding round-trips through the Web projection and Penpot", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-stroke-binding-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const packagePath = join(root, "design-system.smallpen");
  await cp(DESIGN_SYSTEM, packagePath, { recursive: true });
  await cp(join(here, "fixtures", "dsp-shared.smallpen"), join(root, "dsp-shared.smallpen"), {
    recursive: true,
  });
  const before = await openPackage(packagePath);
  await writeFile(join(root, "bind.json"), JSON.stringify({
    baseRevision: before.revision,
    batchId: "bind-stroke",
    operations: [
      {
        changes: { strokes: [{ alignment: "inner", color: "#000000", type: "solid", width: 4 }] },
        nodeId: SWATCH,
        presentationId: PRESENTATION,
        screenId: SCREEN,
        type: "update-presentation-node",
      },
      {
        binding: { assetId: "tok_color_light_primary", packageId: "pkg_design_system" },
        field: "stroke",
        nodeId: SWATCH,
        screenId: SCREEN,
        type: "set-token-binding",
      },
    ],
  }));
  const applied = await runCli(["apply", packagePath, "--batch", "bind.json", "--json"], root);
  assert.equal(applied.code, 0, applied.stdout);

  // The Web projection carries the binding with the active (Light) value.
  const light = await served(await openPackage(packagePath));
  const projected = light.web.entries["screens/screen.json"].presentations[0].nodes[SWATCH];
  assert.deepEqual(projected.tokenBindings.stroke, {
    assetId: "tok_color_light_primary",
    packageId: "pkg_design_system",
  });
  assert.equal(projected.strokes[0].color, "#6750a4");

  // Switching the active color theme to Dark changes the stroke.
  const darkValues = await fixtureValues(packagePath);
  darkValues.get("tokens/tokens.json").activeThemeIds = darkValues
    .get("tokens/tokens.json").activeThemeIds
    .map((id) => (id === "theme_color_light" ? "theme_color_dark" : id));
  const dark = await loadPackageFromValues("memory://dark.smallpen", darkValues);
  assert.equal(
    projectScreen(dark, SCREEN, {}).nodes[SWATCH].strokes[0].color,
    "#d0bcff",
  );

  // Penpot shows it as the stroke-color applied Token; applying the same
  // Token again (with other Tokens) keeps the binding and adds no name.
  const same = compilePenpotChanges(light, {
    changes: [modObj(light, SWATCH, [userSet("applied-tokens", { "stroke-color": "primary" })])],
    commitId: "same-stroke-token",
  });
  for (const { changes } of same.operations) {
    assert.equal(changes.tokenBindings, undefined);
    assert.equal(changes.appliedTokens, undefined);
  }

  // Detaching the Token in Penpot clears the binding; the stroke keeps the
  // value it showed.
  const detached = compilePenpotChanges(light, {
    changes: [modObj(light, SWATCH, [userSet("applied-tokens", {})])],
    commitId: "detach-stroke-token",
  });
  assert.deepEqual(detached.operations.map(({ changes }) => changes), [
    { tokenBindings: null },
  ]);
  const cleared = (await prepareOperationBatch(light, detached)).snapshot;
  assert.equal(swatch(cleared).tokenBindings, undefined);
  assert.equal(swatch(cleared).strokes[0].type, "solid");

  // Applying a color Token to the stroke in Penpot binds it by name to the
  // active set's Token, with the stroke color Penpot wrote.
  const reserved = await served(cleared);
  const reapplied = compilePenpotChanges(reserved, {
    changes: [
      modObj(reserved, SWATCH, [userSet("applied-tokens", { "stroke-color": "on-primary" })]),
      modObj(reserved, SWATCH, [userSet("strokes", [{ ...STROKE, "stroke-color": "#ffffff" }])]),
    ],
    commitId: "apply-stroke-token",
  });
  const rebound = (await prepareOperationBatch(reserved, reapplied)).snapshot;
  assert.deepEqual(swatch(rebound).tokenBindings, {
    stroke: { assetId: "tok_color_light_on_primary", packageId: "pkg_design_system" },
  });
  assert.equal(swatch(rebound).appliedTokens, undefined);
  assert.equal(swatch(rebound).strokes[0].color, "#ffffff");

  // An unknown Token name fails explicitly.
  assert.throws(
    () => compilePenpotChanges(reserved, {
      changes: [modObj(reserved, SWATCH, [userSet("applied-tokens", { "stroke-color": "nope" })])],
      commitId: "unknown-stroke-token",
    }),
    (error) => error.code === "missing_applied_token",
  );
});

test("page changes on the generated Components page fail with a clear code", async () => {
  const snapshot = await served(
    await loadPackageFromValues("memory://pages.smallpen", await fixtureValues(DESIGN_SYSTEM)),
  );
  assert.ok(snapshot.runtime.componentsPage);
  for (const change of [
    { id: snapshot.runtime.componentsPage, name: "Renamed", type: "mod-page" },
    { id: snapshot.runtime.componentsPage, index: 0, type: "mov-page" },
    { id: snapshot.runtime.componentsPage, type: "del-page" },
  ]) {
    assert.throws(
      () => compilePenpotChanges(snapshot, { changes: [change], commitId: change.type }),
      (error) => error.code === "generated_page_locked" && /Components page/.test(error.message),
      change.type,
    );
  }
});

const EXAMPLE = join(here, "..", "examples", "common-components.smallpen");
const CARD = "node_card_hardcoded";

function cardOf(snapshot) {
  return snapshot.entries["screens/screen.json"].presentations[0].nodes[CARD];
}

test("a shadow Token applied in Penpot binds the shadow and resolves to the Token", async () => {
  const snapshot = await served(
    await loadPackageFromValues("memory://example.smallpen", await fixtureValues(EXAMPLE)),
  );
  // Recorded shape of Penpot's apply: the applied Token, then the shadow
  // Penpot resolved from it.
  const penpotShadow = [{
    blur: 4,
    color: { color: "#000000", opacity: 0.24 },
    hidden: false,
    id: "6a1d3c5e-0000-4000-8000-000000000001",
    "offset-x": 0,
    "offset-y": 2,
    spread: 0,
    style: "drop-shadow",
  }];
  const applied = compilePenpotChanges(snapshot, {
    changes: [
      modObj(snapshot, CARD, [userSet("applied-tokens", { shadow: "elevation-1" })]),
      modObj(snapshot, CARD, [userSet("shadow", penpotShadow)]),
    ],
    commitId: "apply-shadow-token",
  });
  const bound = (await prepareOperationBatch(snapshot, applied)).snapshot;
  assert.deepEqual(cardOf(bound).tokenBindings, {
    shadow: { assetId: "tok_demo_effect_elevation", packageId: bound.manifest.packageId },
  });
  assert.equal(cardOf(bound).appliedTokens, undefined);
  // Every read resolves the binding to the Token's DTCG shadow.
  assert.deepEqual(projectScreen(bound, SCREEN, {}).nodes[CARD].shadow, {
    blur: 4,
    color: "rgba(0, 0, 0, 0.24)",
    offsetX: 0,
    offsetY: 2,
    spread: 0,
  });
  const evidence = await createEvidence(bound, {
    scale: 1,
    selector: { viewFormat: "screenshot" },
  });
  assert.deepEqual(
    evidence.render.diagnostics.filter(({ nodeId }) => nodeId === CARD),
    [],
  );

  // Removing it in Penpot clears the binding.
  const reserved = await served(bound);
  const detached = compilePenpotChanges(reserved, {
    changes: [modObj(reserved, CARD, [userSet("applied-tokens", {})])],
    commitId: "detach-shadow-token",
  });
  assert.deepEqual(detached.operations.map(({ changes }) => changes), [
    { tokenBindings: null },
  ]);
});

test("a shadow Token saved from Penpot keeps the Package's DTCG shadow form", async () => {
  const snapshot = await served(
    await loadPackageFromValues("memory://example.smallpen", await fixtureValues(EXAMPLE)),
  );
  const batch = compilePenpotChanges(snapshot, {
    changes: [{
      attrs: {
        description: "",
        id: snapshot.runtime.tokens.tok_demo_effect_elevation,
        name: "elevation-1",
        type: "shadow",
        value: [{
          blur: "6",
          color: "rgba(0, 0, 0, 0.24)",
          inset: false,
          "offset-x": "0",
          "offset-y": "3",
          spread: "0",
        }],
      },
      "set-id": snapshot.runtime.tokenSets.tset_demo_effect,
      "token-id": snapshot.runtime.tokens.tok_demo_effect_elevation,
      type: "set-token",
    }],
    commitId: "edit-shadow-token",
  });
  const saved = (await prepareOperationBatch(snapshot, batch)).snapshot;
  const token = saved.entries["tokens/tokens.json"].sets
    .find(({ id }) => id === "tset_demo_effect").tokens
    .find(({ id }) => id === "tok_demo_effect_elevation");
  assert.deepEqual(token.value, {
    blur: 6,
    color: "rgba(0, 0, 0, 0.24)",
    offsetX: 0,
    offsetY: 3,
    spread: 0,
  });
});

test("the renderer draws shadows kept in Penpot's form", async () => {
  const values = await fixtureValues(ROUNDTRIP);
  const rectangle = values.get("screens/roundtrip.json").presentations[0].nodes.node_rectangle;
  rectangle.shadow = [{
    blur: 0,
    color: { color: "#ff0000", opacity: 1 },
    hidden: false,
    id: "6a1d3c5e-0000-4000-8000-000000000002",
    "offset-x": 20,
    "offset-y": 20,
    spread: 0,
    style: "drop-shadow",
  }];
  const snapshot = await loadPackageFromValues("memory://shadow.smallpen", values);
  const { render } = await createEvidence(snapshot, {
    scale: 1,
    selector: { viewFormat: "screenshot" },
  });
  // The rectangle spans (80..320, 96..216); its shadow shows past the
  // bottom-right corner, red.
  assert.deepEqual(pngPixel(render.bytes, render.width, 330, 226), [255, 0, 0, 255]);
});
