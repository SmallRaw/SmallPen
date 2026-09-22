import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  applyTokenSelection,
  buildTokenLibrary,
  diffTokenLibraries,
  importTokens,
  listPackageEntries,
  loadPackageFromValues,
  normalizeTokenType,
  parseTokenDocument,
  prepareOperationBatch,
  pruneUnresolvableTokens,
} from "@smallpen/core";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "roundtrip.smallpen");

// The shape Penpot's own export-dtcg-json emits (see common tokens_lib_test).
const penpotExport = {
  $metadata: {
    activeSets: ["core"],
    activeThemes: ["group-1/theme-1"],
    tokenSetOrder: ["core", "brand"],
  },
  $themes: [
    {
      description: "",
      group: "group-1",
      id: "test-id-00",
      isSource: false,
      name: "theme-1",
      selectedTokenSets: { brand: "disabled", core: "enabled" },
    },
  ],
  brand: {
    accent: { $type: "color", $value: "#6750a4" },
  },
  core: {
    button: {
      primary: {
        background: { $description: "", $type: "color", $value: "{accent.default}" },
      },
    },
    colors: { red: { 600: { $description: "", $type: "color", $value: "#e53e3e" } } },
    radius: { md: { $type: "borderRadius", $value: 12 } },
    spacing: {
      "multi-value": {
        $description: "Two values",
        $type: "spacing",
        $value: "{dimension.sm} {dimension.xl}",
      },
    },
  },
};

const previousLibrary = {
  activeSetIds: ["tset_core_existing"],
  activeThemeIds: [],
  id: "tlib_existing",
  sets: [
    {
      description: "Kept description",
      id: "tset_core_existing",
      name: "core",
      tokens: [
        {
          description: "",
          id: "tok_existing_red",
          name: "colors.red.600",
          type: "color",
          value: "#ff0000",
        },
        {
          description: "",
          id: "tok_existing_gone",
          name: "colors.gone",
          type: "color",
          value: "#000000",
        },
      ],
    },
  ],
  themes: [],
};

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

async function snapshotWith(library) {
  const values = await fixtureValues();
  values.get("manifest.json").entries.tokens = ["tokens/tokens.json"];
  values.set("tokens/tokens.json", structuredClone(library));
  return loadPackageFromValues("memory://token-import.smallpen", values);
}

test("Penpot multi-set exports parse sets, themes, and activation by name", () => {
  const parsed = parseTokenDocument(penpotExport);
  assert.deepEqual(
    parsed.sets.map((set) => set.name),
    ["core", "brand"],
    "sets follow $metadata.tokenSetOrder",
  );
  const core = parsed.sets[0];
  assert.deepEqual(
    core.tokens.map((token) => [token.name, token.type, token.value]),
    [
      ["button.primary.background", "color", "{accent.default}"],
      ["colors.red.600", "color", "#e53e3e"],
      ["radius.md", "border-radius", 12],
      ["spacing.multi-value", "spacing", "{dimension.sm} {dimension.xl}"],
    ],
  );
  assert.equal(core.tokens[3].description, "Two values");
  assert.deepEqual(parsed.themes, [
    {
      description: "",
      externalId: "test-id-00",
      group: "group-1",
      isSource: false,
      name: "theme-1",
      setNames: ["core"],
    },
  ]);
  assert.deepEqual(parsed.activeThemes, ["group-1/theme-1"]);
  assert.deepEqual(parsed.activeSets, ["core"]);
  assert.deepEqual(parsed.warnings, []);
});

test("DTCG type names map to SmallPen types and unknown types are skipped", () => {
  assert.equal(normalizeTokenType("borderRadius"), "border-radius");
  assert.equal(normalizeTokenType("fontFamilies"), "font-family");
  assert.equal(normalizeTokenType("fontFamily"), "font-family");
  assert.equal(normalizeTokenType("borderWidth"), "stroke-width");
  assert.equal(normalizeTokenType("dimension"), "dimensions");
  assert.equal(normalizeTokenType("boxShadow"), "shadow");
  assert.equal(normalizeTokenType("border-radius"), "border-radius");
  assert.equal(normalizeTokenType("composition"), undefined);
  const parsed = parseTokenDocument(
    {
      layout: { $type: "composition", $value: { a: 1 } },
      ok: { $type: "sizing", $value: 4 },
    },
    { setName: "Loose" },
  );
  assert.deepEqual(
    parsed.sets[0].tokens.map((token) => token.name),
    ["ok"],
  );
  assert.deepEqual(parsed.warnings, [
    { code: "unsupported_token_type", name: "layout", set: "Loose", type: "composition" },
  ]);
});

test("legacy value/type files and group-level $type inheritance both import", () => {
  const parsed = parseTokenDocument({
    $metadata: { tokenSetOrder: ["legacy"] },
    legacy: {
      colors: {
        $type: "color",
        inherited: { $value: "#111111" },
        old: { description: "Legacy", type: "fontSizes", value: 14 },
      },
    },
  });
  assert.deepEqual(
    parsed.sets[0].tokens.map((token) => [token.name, token.type, token.value, token.description]),
    [
      ["colors.inherited", "color", "#111111", ""],
      ["colors.old", "font-size", 14, "Legacy"],
    ],
  );
});

test("a file without $themes or $metadata becomes one named set", () => {
  const parsed = parseTokenDocument(
    { color: { brand: { $type: "color", $value: "#123456" } } },
    { setName: "  Base  " },
  );
  assert.equal(parsed.sets.length, 1);
  assert.equal(parsed.sets[0].name, "Base");
  assert.deepEqual(parsed.themes, []);
  assert.throws(
    () => parseTokenDocument({ $description: "empty" }),
    (error) => error.code === "no_tokens_found",
  );
});

test("re-import keeps ids for sets, tokens, and themes that match by name", () => {
  const first = buildTokenLibrary(parseTokenDocument(penpotExport), previousLibrary);
  assert.equal(first.id, "tlib_existing");
  const core = first.sets.find((set) => set.name === "core");
  assert.equal(core.id, "tset_core_existing");
  assert.equal(core.description, "Kept description", "set description is kept");
  const red = core.tokens.find((token) => token.name === "colors.red.600");
  assert.equal(red.id, "tok_existing_red", "matching token keeps its id");
  assert.equal(red.value, "#e53e3e", "matching token takes the imported value");
  assert.equal(
    core.tokens.find((token) => token.name === "colors.gone"),
    undefined,
    "tokens absent from the file are removed",
  );
  const brand = first.sets.find((set) => set.name === "brand");
  assert.equal(brand.id, "tset_brand");
  assert.equal(brand.tokens[0].id, "tok_accent");
  assert.equal(first.themes[0].id, "theme_group-1_theme-1");
  assert.deepEqual(first.themes[0].setIds, ["tset_core_existing"]);
  assert.deepEqual(first.activeThemeIds, ["theme_group-1_theme-1"]);
  assert.deepEqual(first.activeSetIds, ["tset_core_existing"]);

  const second = buildTokenLibrary(parseTokenDocument(penpotExport), first);
  assert.deepEqual(second, first, "importing the same file twice is stable");
});

test("fresh ids never displace a reused id that shares the same slug", () => {
  const previous = {
    activeSetIds: [],
    activeThemeIds: [],
    id: "tlib_default",
    sets: [
      {
        description: "",
        id: "tset_a",
        name: "a",
        tokens: [
          { description: "", id: "tok_x", name: "x", type: "sizing", value: 1 },
        ],
      },
    ],
    themes: [],
  };
  const library = buildTokenLibrary(
    parseTokenDocument({
      $metadata: { tokenSetOrder: ["b", "a"] },
      a: { x: { $type: "sizing", $value: 1 } },
      b: { x: { $type: "sizing", $value: 2 } },
    }),
    previous,
  );
  const a = library.sets.find((set) => set.name === "a");
  const b = library.sets.find((set) => set.name === "b");
  assert.equal(a.tokens[0].id, "tok_x", "existing token keeps tok_x");
  assert.equal(b.tokens[0].id, "tok_x_2", "the new one is suffixed instead");
});

test("the diff lists added, changed, and removed tokens with real values", () => {
  const library = buildTokenLibrary(parseTokenDocument(penpotExport), previousLibrary);
  const diff = diffTokenLibraries(previousLibrary, library);
  assert.deepEqual(diff.summary, {
    themesAdded: 1,
    themesChanged: 0,
    themesRemoved: 0,
    tokensAdded: 4,
    tokensChanged: 1,
    tokensRemoved: 1,
  });
  assert.deepEqual(diff.tokens.changed, [
    {
      after: {
        description: "",
        name: "colors.red.600",
        set: "core",
        type: "color",
        value: "#e53e3e",
      },
      before: {
        description: "",
        name: "colors.red.600",
        set: "core",
        type: "color",
        value: "#ff0000",
      },
      fields: ["value"],
      name: "colors.red.600",
      set: "core",
    },
  ]);
  assert.deepEqual(
    diff.tokens.removed.map((token) => `${token.set}/${token.name}`),
    ["core/colors.gone"],
  );
  assert.deepEqual(
    diff.tokens.added.map((token) => `${token.set}/${token.name}`),
    [
      "brand/accent",
      "core/button.primary.background",
      "core/radius.md",
      "core/spacing.multi-value",
    ],
  );
  assert.deepEqual(diff.sets, { added: ["brand"], removed: [] });
  assert.equal(diff.themes.added[0].path, "group-1/theme-1");
});

test("a selection applies only the chosen rows", () => {
  const library = buildTokenLibrary(parseTokenDocument(penpotExport), previousLibrary);
  const diff = diffTokenLibraries(previousLibrary, library);
  const selected = applyTokenSelection(previousLibrary, library, diff, [
    "core/radius.md",
    { name: "colors.gone", set: "core" },
  ]);
  const core = selected.sets.find((set) => set.name === "core");
  const names = core.tokens.map((token) => token.name).sort();
  assert.deepEqual(names, ["colors.red.600", "radius.md"], "one added, one removed");
  assert.equal(
    core.tokens.find((token) => token.name === "colors.red.600").value,
    "#ff0000",
    "an unselected change keeps its current value",
  );
  assert.equal(
    selected.sets.find((set) => set.name === "brand").tokens.length,
    0,
    "an unselected added token is dropped",
  );
  const after = diffTokenLibraries(previousLibrary, selected);
  assert.equal(after.summary.tokensAdded, 1);
  assert.equal(after.summary.tokensChanged, 0);
  assert.equal(after.summary.tokensRemoved, 1);
});

test("tokens the Package loader would reject are pruned and reported", () => {
  const { library, warnings } = pruneUnresolvableTokens({
    activeSetIds: [],
    activeThemeIds: [],
    id: "tlib_default",
    sets: [
      {
        description: "",
        id: "tset_a",
        name: "a",
        tokens: [
          { description: "", id: "tok_base", name: "base", type: "color", value: "#112233" },
          { description: "", id: "tok_alias", name: "alias", type: "color", value: "{base}" },
          { description: "", id: "tok_chain", name: "chain", type: "color", value: "{alias}" },
          { description: "", id: "tok_dangling", name: "dangling", type: "color", value: "{nope}" },
          { description: "", id: "tok_orphan", name: "orphan", type: "color", value: "{dangling}" },
          { description: "", id: "tok_size", name: "size", type: "sizing", value: 4 },
          { description: "", id: "tok_mismatch", name: "mismatch", type: "color", value: "{size}" },
          { description: "", id: "tok_loop_a", name: "loop.a", type: "sizing", value: "{loop.b}" },
          { description: "", id: "tok_loop_b", name: "loop.b", type: "sizing", value: "{loop.a}" },
          { description: "", id: "tok_expr", name: "expr", type: "spacing", value: "{size} {size}" },
        ],
      },
    ],
    themes: [],
  });
  assert.deepEqual(
    library.sets[0].tokens.map((token) => token.name),
    ["base", "alias", "chain", "size"],
  );
  assert.deepEqual(
    warnings.map((warning) => [warning.name, warning.code]).sort(),
    [
      ["dangling", "missing_token_alias"],
      ["expr", "invalid_token_value"],
      ["loop.a", "token_alias_cycle"],
      ["loop.b", "token_alias_cycle"],
      ["mismatch", "token_alias_type_mismatch"],
      ["orphan", "missing_token_alias"],
    ],
  );
});

test("importTokens produces a batch that validates and replaces the library", async () => {
  const snapshot = await snapshotWith(previousLibrary);
  const result = importTokens(snapshot, penpotExport);
  assert.equal(result.previousLibraryId, "tlib_existing");
  assert.equal(result.operations[0].type, "replace-token-library");
  assert.deepEqual(
    result.warnings.map((warning) => [warning.name, warning.code]),
    [
      ["button.primary.background", "missing_token_alias"],
      ["spacing.multi-value", "invalid_token_value"],
    ],
    "Penpot-tolerated dangling aliases and expressions are reported, not imported",
  );
  assert.deepEqual(result.diff.summary, {
    themesAdded: 1,
    themesChanged: 0,
    themesRemoved: 0,
    tokensAdded: 2,
    tokensChanged: 1,
    tokensRemoved: 1,
  });
  const prepared = await prepareOperationBatch(snapshot, {
    baseRevision: snapshot.revision,
    batchId: "import_tokens_test",
    operations: result.operations,
  });
  assert.deepEqual(
    prepared.snapshot.entries["tokens/tokens.json"],
    result.library,
  );
  assert.deepEqual(prepared.result.changedFiles, ["tokens/tokens.json"]);
  const reversed = await prepareOperationBatch(
    prepared.snapshot,
    prepared.result.inverseBatch,
  );
  assert.deepEqual(
    reversed.snapshot.entries["tokens/tokens.json"],
    previousLibrary,
    "the inverse batch restores the previous library exactly",
  );
});

test("identical token reimport reports no changes and no redundant inverse payload", async () => {
  const snapshot = await snapshotWith(previousLibrary);
  const imported = importTokens(snapshot, penpotExport);
  const first = await prepareOperationBatch(snapshot, {
    baseRevision: snapshot.revision,
    batchId: "token_import_initial",
    operations: imported.operations,
  });
  const repeated = importTokens(first.snapshot, penpotExport);
  const second = await prepareOperationBatch(first.snapshot, {
    baseRevision: first.snapshot.revision,
    batchId: "token_import_identical",
    operations: repeated.operations,
  });
  assert.equal(second.snapshot.revision, first.snapshot.revision);
  assert.deepEqual(second.result.changedFiles, []);
  assert.deepEqual(second.result.deletedFiles, []);
  assert.deepEqual(second.result.affectedIds, []);
  assert.deepEqual(second.result.inverseBatch.operations, []);
  const reversed = await prepareOperationBatch(second.snapshot, second.result.inverseBatch);
  assert.equal(reversed.snapshot.revision, first.snapshot.revision);
  await assert.rejects(
    prepareOperationBatch(first.snapshot, {
      baseRevision: first.snapshot.revision,
      batchId: "token_import_invalid_noop",
      operations: [{
        library: { ...repeated.library, unsupported: undefined },
        type: "replace-token-library",
      }],
    }),
    (error) => error.code === "unsupported_token_library_field",
    "the no-op path must not bypass library validation",
  );
});

test("importTokens into a package without a Penpot library creates one", async () => {
  const values = await fixtureValues();
  values.get("manifest.json").entries.tokens = [];
  const snapshot = await loadPackageFromValues("memory://no-lib.smallpen", values);
  const result = importTokens(snapshot, penpotExport);
  assert.equal(result.previousLibraryId, null);
  assert.equal(result.library.id, "tlib_default");
  assert.equal(result.diff.summary.tokensAdded, 3);
  assert.equal(result.warnings.length, 2);
  const prepared = await prepareOperationBatch(snapshot, {
    baseRevision: snapshot.revision,
    batchId: "import_tokens_new",
    operations: result.operations,
  });
  assert.deepEqual(prepared.result.changedFiles, ["manifest.json", "tokens/tokens.json"]);
});

test("imported themes avoid existing DTCG token IDs without replacing their definitions", async () => {
  const values = await fixtureValues();
  const legacy = {
    color: {
      brand: {
        $extensions: { smallpen: { id: "tok_color_brand", visibility: "public" } },
        $type: "color",
        $value: "#6750a4",
      },
    },
    spacing: {
      md: {
        $extensions: { smallpen: { id: "tok_color_brand_2", visibility: "public" } },
        $type: "spacing",
        $value: 8,
      },
    },
  };
  values.get("manifest.json").entries.tokens = ["tokens/legacy.json"];
  values.set("tokens/legacy.json", legacy);
  const snapshot = await loadPackageFromValues("memory://dtcg-import.smallpen", values);
  const document = {
    $metadata: { tokenSetOrder: ["Light", "Dark"], activeSets: ["Light"] },
    Light: { color: { brand: { $type: "color", $value: "#112233" } } },
    Dark: { color: { brand: { $type: "color", $value: "#ddeeff" } } },
  };
  const imported = importTokens(snapshot, document);
  const ids = imported.library.sets.flatMap((set) => set.tokens.map((token) => token.id));
  assert.equal(new Set(ids).size, 2);
  assert.equal(ids.some((id) => snapshot.domain.tokens.has(id)), false);
  const applied = await prepareOperationBatch(snapshot, {
    baseRevision: snapshot.revision,
    batchId: "import_around_dtcg_ids",
    operations: imported.operations,
  });
  assert.deepEqual(applied.snapshot.entries["tokens/legacy.json"], legacy);
  assert.equal(applied.snapshot.domain.tokens.get("tok_color_brand").rawValue, "#6750a4");
  assert.equal(applied.snapshot.domain.tokens.get("tok_color_brand_2").rawValue, 8);
  const reimported = importTokens(applied.snapshot, document);
  assert.deepEqual(
    reimported.library.sets.flatMap((set) => set.tokens.map((token) => token.id)),
    ids,
    "reimport preserves imported identities while legacy IDs stay reserved",
  );
  const reversed = await prepareOperationBatch(applied.snapshot, applied.result.inverseBatch);
  assert.equal(reversed.snapshot.revision, snapshot.revision);
});

test("an alias inside an imported Penpot-shaped library resolves when the package loads", async () => {
  const snapshot = await snapshotWith(previousLibrary);
  const result = importTokens(snapshot, {
    $metadata: { tokenSetOrder: ["core"] },
    core: {
      colors: {
        $type: "color",
        base: { $value: "#336699" },
        link: { $value: "{colors.base}" },
      },
    },
  });
  assert.deepEqual(result.warnings, [], "the alias target exists, nothing is pruned");
  const prepared = await prepareOperationBatch(snapshot, {
    baseRevision: snapshot.revision,
    batchId: "import_tokens_alias",
    operations: result.operations,
  });
  const link = prepared.snapshot.domain.tokens.get("tok_colors_link");
  assert.equal(link.rawValue, "{colors.base}");
  assert.equal(link.resolvedValue, "#336699", "Form A aliases resolve like DTCG aliases");
});
