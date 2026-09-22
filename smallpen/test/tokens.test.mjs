import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  listEffectiveTokens,
  listPackageEntries,
  loadPackageFromValues,
  prepareOperationBatch,
  projectEffectiveSnapshot,
  resolveEffectiveToken,
} from "@smallpen/core";
import { compilePenpotChanges } from "@smallpen/penpot-adapter";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "roundtrip.smallpen");

const setId = "tset_11111111111141118111111111111111";
const setRuntimeId = "11111111-1111-4111-8111-111111111111";
const colorTokenId = "tok_22222222222242228222222222222222";
const colorTokenRuntimeId = "22222222-2222-4222-8222-222222222222";
const sizeTokenId = "tok_33333333333343338333333333333333";
const themeId = "theme_44444444444444448444444444444444";
const themeRuntimeId = "44444444-4444-4444-8444-444444444444";
const addedTokenRuntimeId = "55555555-5555-4555-8555-555555555555";

async function fixtureValues() {
  const manifest = JSON.parse(
    await readFile(join(fixture, "manifest.json"), "utf8"),
  );
  const { entries } = listPackageEntries(manifest);
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of entries) {
    values.set(entry, JSON.parse(await readFile(join(fixture, entry), "utf8")));
  }
  return values;
}

async function tokenValues() {
  const values = await fixtureValues();
  values.get("manifest.json").entries.tokens = ["tokens/design.json"];
  values.set("tokens/design.json", {
    activeSetIds: [setId],
    activeThemeIds: [themeId],
    id: "tlib_design",
    sets: [
      {
        description: "Product defaults",
        id: setId,
        name: "core",
        tokens: [
          {
            description: "Primary brand color",
            id: colorTokenId,
            name: "color.primary",
            type: "color",
            value: "#2563eb",
          },
          {
            description: "Card width",
            id: sizeTokenId,
            name: "size.card",
            type: "sizing",
            value: 240,
          },
        ],
      },
    ],
    themes: [
      {
        description: "Light product theme",
        externalId: "smallpen-light",
        group: "Product",
        id: themeId,
        isSource: false,
        name: "Light",
        setIds: [setId],
      },
    ],
  });
  values.get("screens/roundtrip.json").presentations[0].nodes[
    "node_rectangle"
  ].appliedTokens = {
    fill: "color.primary",
    width: "size.card",
  };
  return values;
}

async function dtcgValues() {
  const values = await fixtureValues();
  values.get("manifest.json").entries.tokens = ["tokens/foundation.json"];
  values.set("tokens/foundation.json", {
    color: {
      brand: {
        $extensions: {
          smallpen: { id: "tok_brand", visibility: "public" },
        },
        $type: "color",
        $value: "#6750a4",
      },
    },
  });
  return values;
}

test("canonical structured colors reject unsupported color spaces and components", async () => {
  const cases = [
    {
      alpha: 1,
      colorSpace: "display-p3",
      components: [1, 0, 0],
    },
    {
      alpha: 1,
      colorSpace: "srgb",
      components: [1, "none", 0],
    },
  ];

  for (const [index, value] of cases.entries()) {
    const values = await dtcgValues();
    values.get("tokens/foundation.json").color.brand.$value = value;
    await assert.rejects(
      loadPackageFromValues(
        `memory://invalid-structured-color-${index}.smallpen`,
        values,
      ),
      (error) => error?.code === "invalid_token_value",
    );
  }
});

test("Token Sets, Tokens, and Themes receive stable runtime identities", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://tokens.smallpen",
    await tokenValues(),
  );
  assert.equal(snapshot.runtime.tokenSets[setId], setRuntimeId);
  assert.equal(snapshot.runtime.tokens[colorTokenId], colorTokenRuntimeId);
  assert.equal(snapshot.runtime.tokenThemes[themeId], themeRuntimeId);
  assert.deepEqual(snapshot.runtime.reverseTokens[colorTokenRuntimeId], {
    tokenId: colorTokenId,
    tokenSetId: setId,
  });

  const invalid = await tokenValues();
  invalid.get("screens/roundtrip.json").presentations[0].nodes[
    "node_rectangle"
  ].appliedTokens.fill = "color.missing";
  await assert.rejects(
    loadPackageFromValues("memory://missing-token.smallpen", invalid),
    (error) => error?.code === "missing_applied_token",
  );
});

test("set-token-value updates a Penpot Token by path and reverses exactly", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://set-penpot-token.smallpen",
    await tokenValues(),
  );
  const prepared = await prepareOperationBatch(snapshot, {
    baseRevision: snapshot.revision,
    batchId: "batch_set_penpot_token",
    operations: [
      { path: "color.primary", type: "set-token-value", value: "#db2777" },
    ],
  });

  assert.equal(
    prepared.snapshot.entries["tokens/design.json"].sets[0].tokens[0].value,
    "#db2777",
  );
  const reversed = await prepareOperationBatch(
    prepared.snapshot,
    prepared.result.inverseBatch,
  );
  assert.equal(reversed.snapshot.revision, snapshot.revision);
});

test("active Penpot Themes drive CLI token values and projected node attributes", async () => {
  const values = await tokenValues();
  const library = values.get("tokens/design.json");
  const darkSetId = "tset_55555555555545558555555555555555";
  const darkTokenId = "tok_66666666666646668666666666666666";
  const darkThemeId = "theme_77777777777747778777777777777777";
  library.sets.push({
    description: "Dark values",
    id: darkSetId,
    name: "mode/dark",
    tokens: [
      {
        description: "Dark brand color",
        id: darkTokenId,
        name: "color.primary",
        type: "color",
        value: "#111827",
      },
    ],
  });
  library.themes.push({
    description: "Dark product theme",
    externalId: "smallpen-dark",
    group: "Product",
    id: darkThemeId,
    isSource: false,
    name: "Dark",
    setIds: [darkSetId],
  });
  library.activeSetIds = [];
  library.activeThemeIds = [darkThemeId];
  const rectangle = values.get("screens/roundtrip.json").presentations[0].nodes
    .node_rectangle;
  rectangle.tokenBindings = {
    fill: { assetId: colorTokenId, packageId: "pkg_roundtrip" },
  };

  const snapshot = await loadPackageFromValues(
    "memory://active-penpot-theme.smallpen",
    values,
  );
  const reference = { assetId: colorTokenId, packageId: "pkg_roundtrip" };
  const effective = resolveEffectiveToken(snapshot, reference);
  assert.equal(effective.sourceTokenId, darkTokenId);
  assert.equal(effective.value, "#111827");
  assert.deepEqual(
    listEffectiveTokens(snapshot).map(({ token }) => token.path),
    ["color.primary"],
  );
  assert.equal(
    projectEffectiveSnapshot(snapshot).entries["screens/roundtrip.json"]
      .presentations[0].nodes.node_rectangle.fills[0].color,
    "#111827",
  );

  const switched = await prepareOperationBatch(snapshot, {
    baseRevision: snapshot.revision,
    batchId: "switch-active-penpot-theme",
    operations: [
      {
        themePaths: ["Product/Light"],
        type: "set-active-token-themes",
      },
    ],
  });
  const light = resolveEffectiveToken(switched.snapshot, reference);
  assert.equal(light.sourceTokenId, colorTokenId);
  assert.equal(light.value, "#2563eb");
  assert.equal(
    projectEffectiveSnapshot(switched.snapshot).entries[
      "screens/roundtrip.json"
    ].presentations[0].nodes.node_rectangle.fills[0].color,
    "#2563eb",
  );
  const reversed = await prepareOperationBatch(
    switched.snapshot,
    switched.result.inverseBatch,
  );
  assert.equal(reversed.snapshot.revision, snapshot.revision);
});

test("native TokensStatus updates round-trip and reject unknown identities", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://native-token-status.smallpen",
    await tokenValues(),
  );
  const compile = (changes) =>
    compilePenpotChanges(snapshot, {
      changes,
      commitId: "native-token-status",
      fileId: snapshot.runtime.file,
    });
  const batch = compile([
    {
      type: "set-tokens-status",
      "theme-ids": [],
      "set-ids": [setRuntimeId],
    },
  ]);
  const prepared = await prepareOperationBatch(snapshot, batch);
  const library = prepared.snapshot.entries["tokens/design.json"];
  assert.deepEqual(library.activeThemeIds, []);
  assert.deepEqual(library.activeSetIds, [setId]);
  const reversed = await prepareOperationBatch(
    prepared.snapshot,
    prepared.result.inverseBatch,
  );
  assert.equal(reversed.snapshot.revision, snapshot.revision);
  assert.throws(
    () =>
      compile([
        {
          type: "set-tokens-status",
          "theme-ids": [addedTokenRuntimeId],
          "set-ids": [],
        },
      ]),
    /Unknown Token identity/,
  );
});

test("DTCG Tokens receive one synthetic runtime Set for read-only projection", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://dtcg-tokens.smallpen",
    await dtcgValues(),
  );
  const tokenRuntimeId = snapshot.runtime.tokens.tok_brand;
  const tokenSetRuntimeId = snapshot.runtime.dtcgTokenSet;

  assert.match(tokenSetRuntimeId, /^[a-f0-9-]{36}$/);
  assert.equal(snapshot.runtime.tokenSets["smallpen:dtcg"], tokenSetRuntimeId);
  assert.deepEqual(snapshot.runtime.reverseTokens[tokenRuntimeId], {
    tokenId: "tok_brand",
    tokenSetId: "smallpen:dtcg",
  });
});

test("public Tokens from a declared Library resolve and project into Product nodes", async () => {
  const productValues = await tokenValues();
  productValues.get("manifest.json").packageId = "pkg_product";
  const rectangle = productValues.get("screens/roundtrip.json").presentations[0]
    .nodes.node_rectangle;
  rectangle.tokenBindings = {
    fill: { assetId: "tok_brand", packageId: "pkg_remote_tokens" },
  };
  const product = await loadPackageFromValues(
    "memory://library-token-product.smallpen",
    productValues,
  );

  const libraryValues = await dtcgValues();
  libraryValues.get("manifest.json").packageId = "pkg_remote_tokens";
  libraryValues.get("manifest.json").name = "Remote Tokens";
  const library = await loadPackageFromValues(
    "memory://remote-token-library.smallpen",
    libraryValues,
  );
  const reference = {
    assetId: "tok_brand",
    packageId: "pkg_remote_tokens",
  };

  const effective = resolveEffectiveToken(product, reference, {
    libraries: [library],
  });
  assert.equal(effective.value, "#6750a4");
  assert.equal(effective.sourcePackageId, "pkg_remote_tokens");
  assert.equal(
    listEffectiveTokens(product, { libraries: [library] }).some(
      ({ target }) =>
        target.packageId === "pkg_remote_tokens" &&
        target.assetId === "tok_brand",
    ),
    true,
  );
  assert.equal(
    projectEffectiveSnapshot(product, { libraries: [library] }).entries[
      "screens/roundtrip.json"
    ].presentations[0].nodes.node_rectangle.fills[0].color,
    "#6750a4",
  );
});

test("Penpot applied-tokens edits compile, apply, and reverse exactly", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://applied-tokens.smallpen",
    await tokenValues(),
  );
  const runtimeId =
    snapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle;
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        id: runtimeId,
        operations: [
          {
            attr: "applied-tokens",
            type: "set",
            val: { fill: "color.primary" },
          },
        ],
        type: "mod-obj",
      },
    ],
    commitId: "applied-tokens",
  });
  assert.deepEqual(batch.operations[0].changes, {
    appliedTokens: { fill: "color.primary" },
  });

  const prepared = await prepareOperationBatch(snapshot, batch);
  assert.deepEqual(
    prepared.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_rectangle.appliedTokens,
    { fill: "color.primary" },
  );
  const reversed = await prepareOperationBatch(
    prepared.snapshot,
    prepared.result.inverseBatch,
  );
  assert.equal(reversed.snapshot.revision, snapshot.revision);
});

test("Token schema rejects unsupported types and ambiguous identities", async () => {
  const unsupported = await tokenValues();
  unsupported.get("tokens/design.json").sets[0].tokens[0].type = "motion";
  await assert.rejects(
    loadPackageFromValues("memory://unsupported-token.smallpen", unsupported),
    (error) => error?.code === "unsupported_token_type",
  );

  const duplicate = await tokenValues();
  duplicate.get("tokens/design.json").sets[0].tokens[1].id = colorTokenId;
  await assert.rejects(
    loadPackageFromValues("memory://duplicate-token.smallpen", duplicate),
    (error) => error?.code === "duplicate_token_id",
  );
});

test("Penpot Token, Set, Theme, and activation changes replace one library atomically", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://token-lifecycle.smallpen",
    await tokenValues(),
  );
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        attrs: {
          description: "Updated brand color",
          id: colorTokenRuntimeId,
          name: "color.primary",
          type: "color",
          value: "#1d4ed8",
        },
        "set-id": setRuntimeId,
        "token-id": colorTokenRuntimeId,
        type: "set-token",
      },
      {
        attrs: {
          description: "Medium radius",
          id: addedTokenRuntimeId,
          name: "radius.medium",
          type: "border-radius",
          value: 12,
        },
        "set-id": setRuntimeId,
        "token-id": addedTokenRuntimeId,
        type: "set-token",
      },
      {
        attrs: {
          description: "Renamed product defaults",
          id: setRuntimeId,
          name: "foundations",
        },
        id: setRuntimeId,
        type: "set-token-set",
      },
      {
        attrs: { sets: ["foundations"] },
        id: "00000000-0000-0000-0000-000000000000",
        type: "set-token-theme",
      },
      {
        attrs: {
          description: "Updated light theme",
          "external-id": "smallpen-light",
          group: "Product",
          id: themeRuntimeId,
          "is-source": false,
          name: "Light",
          sets: ["foundations"],
        },
        id: themeRuntimeId,
        type: "set-token-theme",
      },
      {
        "theme-paths": ["Product/Light"],
        type: "set-active-token-themes",
      },
    ],
    commitId: "token-lifecycle",
  });
  assert.equal(batch.operations.length, 1);
  assert.equal(batch.operations[0].type, "replace-token-library");

  const prepared = await prepareOperationBatch(snapshot, batch);
  const library = prepared.snapshot.entries["tokens/design.json"];
  assert.deepEqual(
    {
      activeSetIds: library.activeSetIds,
      activeThemeIds: library.activeThemeIds,
      setDescription: library.sets[0].description,
      setName: library.sets[0].name,
      tokenNames: library.sets[0].tokens.map(({ name }) => name),
      tokenValue: library.sets[0].tokens[0].value,
      themeSets: library.themes[0].setIds,
    },
    {
      activeSetIds: [setId],
      activeThemeIds: [themeId],
      setDescription: "Renamed product defaults",
      setName: "foundations",
      tokenNames: ["color.primary", "size.card", "radius.medium"],
      tokenValue: "#1d4ed8",
      themeSets: [setId],
    },
  );

  const reversed = await prepareOperationBatch(
    prepared.snapshot,
    prepared.result.inverseBatch,
  );
  assert.equal(reversed.snapshot.revision, snapshot.revision);
});

test("Penpot Token Set and group moves preserve order and Theme references", async () => {
  const values = await tokenValues();
  const library = values.get("tokens/design.json");
  const extraSets = [
    ["tset_55555555555545558555555555555555", "alpha/one"],
    ["tset_66666666666646668666666666666666", "alpha/two"],
    ["tset_77777777777747778777777777777777", "beta/three"],
    ["tset_88888888888848888888888888888888", "last"],
  ];
  library.sets = extraSets.map(([id, name]) => ({
    description: name,
    id,
    name,
    tokens: [],
  }));
  library.activeSetIds = [extraSets[0][0]];
  library.themes[0].setIds = extraSets.map(([id]) => id);
  values.get("screens/roundtrip.json").presentations[0].nodes[
    "node_rectangle"
  ].appliedTokens = {};
  const snapshot = await loadPackageFromValues(
    "memory://token-moves.smallpen",
    values,
  );

  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        "set-group-fname": "foundations",
        "set-group-path": ["alpha"],
        type: "rename-token-set-group",
      },
      {
        "before-group": false,
        "before-path": ["foundations", "two"],
        "from-path": ["last"],
        "to-path": ["foundations", "last"],
        type: "move-token-set",
      },
      {
        "before-group": true,
        "before-path": ["foundations"],
        "from-path": ["beta"],
        "to-path": ["foundations", "beta"],
        type: "move-token-set-group",
      },
    ],
    commitId: "token-moves",
  });
  const prepared = await prepareOperationBatch(snapshot, batch);
  const moved = prepared.snapshot.entries["tokens/design.json"];
  assert.deepEqual(
    moved.sets.map(({ name }) => name),
    [
      "foundations/beta/three",
      "foundations/one",
      "foundations/last",
      "foundations/two",
    ],
  );
  assert.deepEqual(
    moved.themes[0].setIds,
    extraSets.map(([id]) => id),
  );

  const reversed = await prepareOperationBatch(
    prepared.snapshot,
    prepared.result.inverseBatch,
  );
  assert.equal(reversed.snapshot.revision, snapshot.revision);
});

test("the first Penpot Token changes create one library entry whose inverse removes it", async () => {
  const values = await fixtureValues();
  values.get("manifest.json").entries.tokens = [];
  values.delete("tokens/tokens.json");
  const snapshot = await loadPackageFromValues(
    "memory://create-token-library.smallpen",
    values,
  );
  const batch = compilePenpotChanges(snapshot, {
    changes: [
      {
        attrs: {
          description: "Created locally",
          id: setRuntimeId,
          name: "core",
          tokens: {},
        },
        id: setRuntimeId,
        type: "set-token-set",
      },
      {
        attrs: {
          description: "Primary brand color",
          id: colorTokenRuntimeId,
          name: "color.primary",
          type: "color",
          value: "#2563eb",
        },
        "set-id": setRuntimeId,
        "token-id": colorTokenRuntimeId,
        type: "set-token",
      },
      {
        attrs: {
          description: "Light",
          "external-id": "smallpen-light",
          group: "Product",
          id: themeRuntimeId,
          "is-source": false,
          name: "Light",
          sets: ["core"],
        },
        id: themeRuntimeId,
        type: "set-token-theme",
      },
      {
        attrs: { sets: ["core"] },
        id: "00000000-0000-0000-0000-000000000000",
        type: "set-token-theme",
      },
      {
        "theme-paths": ["Product/Light"],
        type: "set-active-token-themes",
      },
    ],
    commitId: "create-token-library",
  });
  const prepared = await prepareOperationBatch(snapshot, batch);
  assert.deepEqual(prepared.snapshot.manifest.entries.tokens, [
    "tokens/tokens.json",
  ]);
  assert.equal(prepared.snapshot.runtime.tokenSets[setId], setRuntimeId);
  assert.equal(
    prepared.snapshot.entries["tokens/tokens.json"].sets[0].tokens[0].id,
    colorTokenId,
  );

  const reversed = await prepareOperationBatch(
    prepared.snapshot,
    prepared.result.inverseBatch,
  );
  assert.equal(reversed.snapshot.revision, snapshot.revision);
  assert.deepEqual(reversed.result.deletedFiles, ["tokens/tokens.json"]);
});
