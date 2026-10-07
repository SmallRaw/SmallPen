import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  canonicalJSON,
  findTokenLibrary,
  importTokens,
  listEffectiveTokens,
  listPackageEntries,
  loadPackageFromValues,
  prepareOperationBatch,
  pruneUnresolvableTokens,
  resolveEffectiveToken,
} from "@smallpen/core";

const here = dirname(fileURLToPath(import.meta.url));

async function fixtureValues(name = "roundtrip.smallpen") {
  const root = join(here, "fixtures", name);
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of listPackageEntries(manifest).entries) {
    values.set(entry, JSON.parse(await readFile(join(root, entry), "utf8")));
  }
  return values;
}

const load = (values) => loadPackageFromValues("memory://hardening.smallpen", values);

function apply(snapshot, operations, batchId = "b") {
  return prepareOperationBatch(snapshot, {
    baseRevision: snapshot.revision,
    batchId,
    operations,
  });
}

function presentationOf(values, entry = "screens/roundtrip.json") {
  return values.get(entry).presentations[0];
}

function withDtcg(values, document, entry = "tokens/dtcg.json") {
  values.get("manifest.json").entries.tokens.push(entry);
  values.set(entry, document);
  return values;
}

const tokenExt = (id, extra = {}) => ({ smallpen: { id, ...extra } });

function assertPrototypeClean() {
  for (const key of ["children", "name", "polluted", "tokenBindings", "x"]) {
    assert.equal(Object.hasOwn(Object.prototype, key), false, key);
  }
}

const rejectsWith = (promise, code) =>
  assert.rejects(promise, (error) => {
    assert.equal(error?.code, code, error?.message);
    return true;
  });

test("the revision does not depend on the host locale", async () => {
  const values = await fixtureValues();
  const presentation = presentationOf(values);
  for (const id of ["node_aa", "node_ab", "node_B"]) {
    presentation.nodes.node_canvas.children.push(id);
    presentation.nodes[id] = {
      children: [],
      height: 1,
      id,
      name: id,
      type: "RECTANGLE",
      width: 1,
      x: 0,
      y: 0,
    };
  }
  const expected = (await load(structuredClone(values))).revision;
  // Danish collation sorts "aa" after "ab"; Core must not follow it.
  const original = String.prototype.localeCompare;
  const danish = new Intl.Collator("da");
  String.prototype.localeCompare = function localeCompare(other) {
    return danish.compare(String(this), String(other));
  };
  try {
    assert.equal((await load(structuredClone(values))).revision, expected);
    assert.deepEqual(
      Object.keys(JSON.parse(canonicalJSON({ a: 1, aa: 2, ab: 3, B: 4 }))),
      ["B", "a", "aa", "ab"],
    );
  } finally {
    String.prototype.localeCompare = original;
  }
});

test("the loader never resolves node ids through Object.prototype", async () => {
  const rootProto = await fixtureValues();
  presentationOf(rootProto).rootId = "__proto__";
  await rejectsWith(load(rootProto), "missing_root_node");

  const childProto = await fixtureValues();
  presentationOf(childProto).nodes.node_rectangle.children = ["constructor"];
  await rejectsWith(load(childProto), "missing_child_node");

  const visibility = await fixtureValues();
  presentationOf(visibility).interactions = [
    {
      action: { nodeId: "constructor", type: "set-visibility", visible: true },
      id: "int_a",
      name: "a",
      sourceNodeId: "node_canvas",
      trigger: "activate",
    },
  ];
  await rejectsWith(load(visibility), "invalid_interaction_action");

  const counterpart = await fixtureValues();
  counterpart.get("screens/roundtrip.json").counterparts = [
    {
      from: { nodeId: "constructor", presentationId: "pres_desktop" },
      id: "counterpart_a",
      to: { nodeId: "node_canvas", presentationId: "pres_desktop" },
    },
  ];
  await rejectsWith(load(counterpart), "missing_counterpart_endpoint");
});

test("operations with prototype ids fail without touching Object.prototype", async () => {
  const values = withDtcg(await fixtureValues(), {
    color: {
      $type: "color",
      brand: { $extensions: tokenExt("tok_brand"), $value: "#ffffff" },
    },
  });
  const snapshot = await load(values);
  const cases = [
    [
      {
        changes: { name: "polluted" },
        nodeId: "__proto__",
        screenId: "scr_roundtrip",
        type: "update-node",
      },
      "missing_node",
    ],
    [
      {
        index: 0,
        node: {
          height: 1,
          id: "node_new",
          name: "n",
          type: "RECTANGLE",
          width: 1,
          x: 0,
          y: 0,
        },
        parentId: "__proto__",
        presentationId: "pres_desktop",
        screenId: "scr_roundtrip",
        type: "add-presentation-node",
      },
      "missing_parent_node",
    ],
    [
      {
        nodeIds: ["node_rectangle"],
        parentId: "constructor",
        presentationId: "pres_desktop",
        screenId: "scr_roundtrip",
        type: "move-presentation-nodes",
      },
      "missing_parent_node",
    ],
    [
      {
        definition: {
          $type: "color",
          $value: "#ffffff",
          $extensions: tokenExt("tok_p"),
        },
        filePath: "tokens/x.json",
        path: "__proto__.polluted",
        tokenId: "tok_p",
        type: "put-token",
      },
      "invalid_token_path",
    ],
    [
      {
        action: "retarget-reference",
        referencePath: "screens/roundtrip.json.__proto__.polluted",
        replacement: { assetId: "tok_brand", packageId: "pkg_roundtrip" },
        type: "repair-reference",
      },
      "unsupported_repair_path",
    ],
    [
      {
        binding: { assetId: "tok_brand", packageId: "pkg_roundtrip" },
        field: "__proto__",
        nodeId: "node_rectangle",
        screenId: "scr_roundtrip",
        type: "set-token-binding",
      },
      "unsupported_token_binding",
    ],
    [
      {
        binding: { assetId: "tok_brand", packageId: "pkg_roundtrip" },
        field: "fill",
        nodeId: "toString",
        screenId: "scr_roundtrip",
        type: "set-token-binding",
      },
      "missing_node",
    ],
  ];
  for (const [operation, code] of cases) {
    await rejectsWith(apply(snapshot, [operation]), code);
    assertPrototypeClean();
  }
  assert.equal(typeof Object.prototype.toString, "function");
  assert.equal({}.toString(), "[object Object]");

  const design = await load(await fixtureValues("design-system.smallpen"));
  await rejectsWith(
    apply(design, [
      {
        changes: JSON.parse('{"__proto__": {"polluted": true}}'),
        componentId: "cmp_card_set",
        nodeId: "node_card_idle_label",
        type: "update-component-node",
        variantId: "var_card_idle",
      },
    ]),
    "unsupported_node_change",
  );
  await rejectsWith(
    apply(design, [
      {
        changes: {},
        componentId: "cmp_card_set",
        nodeId: "constructor",
        type: "update-component-node",
        variantId: "var_card_idle",
      },
    ]),
    "missing_node",
  );
  assertPrototypeClean();
});

test("reserved names are rejected in token paths, Scenario overrides, and entries", async () => {
  const group = withDtcg(
    await fixtureValues(),
    JSON.parse(
      '{"__proto__": {"$type": "color", "x": {"$value": "#ffffff", "$extensions": {"smallpen": {"id": "tok_p"}}}}}',
    ),
  );
  await rejectsWith(load(group), "invalid_token_path");

  const scenario = await fixtureValues("design-system.smallpen");
  scenario.get("manifest.json").entries.scenarios.push("scenarios/s.json");
  scenario.set("scenarios/s.json", {
    scenarios: [
      {
        actions: [
          { overridePath: "__proto__:name", type: "set-override", value: "x" },
        ],
        context: {},
        expectedVisibleNodeIds: [],
        fixture: {},
        id: "scn_x",
        name: "x",
        target: {
          component: { assetId: "cmp_card_set", packageId: "pkg_design_system" },
          kind: "component",
          variant: { axis_state: "idle" },
        },
        viewport: { height: 40, scale: 1, width: 120 },
      },
    ],
  });
  await rejectsWith(load(scenario), "unsupported_scenario_action");
  assertPrototypeClean();

  for (const entry of [
    "__proto__",
    "req/constructor/a.json",
    "C:req.json",
    "req/x.json:ads",
    "req/CON",
    "req/nul.json",
    "req/a.json.",
    "req/a?.json",
  ]) {
    const values = await fixtureValues();
    values.get("manifest.json").entries.requirements.push(entry);
    values.set(entry, { annotations: [], flows: [], requirements: [] });
    await rejectsWith(load(values), "invalid_entry_path");
  }
  const collision = await fixtureValues();
  collision
    .get("manifest.json")
    .entries.requirements.push("req/A.json", "req/a.json");
  for (const entry of ["req/A.json", "req/a.json"]) {
    collision.set(entry, { annotations: [], flows: [], requirements: [] });
  }
  await rejectsWith(load(collision), "entry_case_collision");
});

test("Context values follow the alias rules of base values at load", async () => {
  const dangling = withDtcg(await fixtureValues(), {
    font: {
      $type: "font-family",
      body: {
        $extensions: tokenExt("tok_body", {
          contextValues: [{ value: "{nope.missing}", when: {} }],
        }),
        $value: "Inter",
      },
    },
  });
  await rejectsWith(load(dangling), "missing_token_alias");

  const crossType = withDtcg(await fixtureValues(), {
    color: {
      $type: "color",
      a: {
        $extensions: tokenExt("tok_a", {
          contextValues: [{ value: "{size.s}", when: {} }],
        }),
        $value: "#ffffff",
      },
    },
    size: { $type: "sizing", s: { $extensions: tokenExt("tok_s"), $value: 4 } },
  });
  await rejectsWith(load(crossType), "token_alias_type_mismatch");

  const cycle = withDtcg(await fixtureValues(), {
    font: {
      $type: "font-family",
      a: {
        $extensions: tokenExt("tok_a", {
          contextValues: [{ value: "{font.b}", when: {} }],
        }),
        $value: "Inter",
      },
      b: { $extensions: tokenExt("tok_b"), $value: "{font.a}" },
    },
  });
  await rejectsWith(load(cycle), "token_alias_cycle");

  // A color alias in a Context value loads and resolves like a base alias.
  const colorAlias = withDtcg(await fixtureValues(), {
    color: {
      $type: "color",
      a: {
        $extensions: tokenExt("tok_ca", {
          contextValues: [{ value: "{color.b}", when: {} }],
        }),
        $value: "#ffffff",
      },
      b: { $extensions: tokenExt("tok_cb"), $value: "#000000" },
    },
  });
  const snapshot = await load(colorAlias);
  assert.equal(
    resolveEffectiveToken(snapshot, {
      assetId: "tok_ca",
      packageId: "pkg_roundtrip",
    }).value,
    "#000000",
  );
});

function themedValues(values, tokens) {
  values.get("manifest.json").entries.contexts.push("contexts/contexts.json");
  values.set("contexts/contexts.json", {
    axes: [
      {
        defaultValue: "light",
        id: "axis_theme",
        kind: "theme",
        name: "Theme",
        values: [
          { id: "light", name: "Light" },
          { id: "dark", name: "Dark" },
        ],
      },
    ],
    profiles: [],
  });
  return withDtcg(values, tokens);
}

test("Context alias cycles are rejected only when one Context selects them", async () => {
  // light: a -> b, dark: b -> a. No Context selects both rules.
  const swap = themedValues(await fixtureValues(), {
    color: {
      $type: "color",
      a: {
        $extensions: tokenExt("tok_a", {
          contextValues: [{ value: "{color.b}", when: { axis_theme: "light" } }],
        }),
        $value: "#111111",
      },
      b: {
        $extensions: tokenExt("tok_b", {
          contextValues: [{ value: "{color.a}", when: { axis_theme: "dark" } }],
        }),
        $value: "#222222",
      },
    },
  });
  const snapshot = await load(swap);
  const reference = { assetId: "tok_b", packageId: "pkg_roundtrip" };
  assert.equal(
    resolveEffectiveToken(snapshot, reference, {
      context: { axis_theme: "dark" },
    }).value,
    "#111111",
  );
  assert.equal(
    resolveEffectiveToken(snapshot, reference, {
      context: { axis_theme: "light" },
    }).value,
    "#222222",
  );

  const darkCycle = themedValues(await fixtureValues(), {
    color: {
      $type: "color",
      a: {
        $extensions: tokenExt("tok_a", {
          contextValues: [{ value: "{color.b}", when: { axis_theme: "dark" } }],
        }),
        $value: "#111111",
      },
      b: {
        $extensions: tokenExt("tok_b", {
          contextValues: [{ value: "{color.a}", when: { axis_theme: "dark" } }],
        }),
        $value: "#222222",
      },
    },
  });
  await rejectsWith(load(darkCycle), "token_alias_cycle");

  const unknownAxis = themedValues(await fixtureValues(), {
    color: {
      $type: "color",
      a: {
        $extensions: tokenExt("tok_a", {
          contextValues: [{ value: "#000000", when: { axis_theme: "sepia" } }],
        }),
        $value: "#111111",
      },
    },
  });
  await rejectsWith(load(unknownAxis), "invalid_token_context_rule");
});

test("a moved token with a partial selection keeps unique ids", async () => {
  let snapshot = await load(await fixtureValues());
  const first = importTokens(snapshot, {
    $metadata: { tokenSetOrder: ["A"] },
    A: { c: { $type: "color", $value: "#ffffff" } },
  });
  snapshot = (await apply(snapshot, first.operations, "i1")).snapshot;
  const moved = {
    $metadata: { tokenSetOrder: ["B"] },
    B: { c: { $type: "color", $value: "#000000" } },
  };

  const all = importTokens(snapshot, moved);
  assert.deepEqual(
    all.library.sets.flatMap((set) => set.tokens.map(({ id }) => id)),
    ["tok_c"],
    "a plain move keeps the token id",
  );

  const partial = importTokens(snapshot, moved, { selection: ["B/c"] });
  const ids = partial.library.sets.flatMap((set) =>
    set.tokens.map(({ id }) => id),
  );
  assert.equal(new Set(ids).size, ids.length);
  const kept = partial.library.sets.find(({ name }) => name === "A");
  assert.equal(kept.tokens[0].id, "tok_c", "the kept row owns its id");
  await apply(snapshot, partial.operations, "i2");
});

test("token pruning resolves aliases the way the loader does", async () => {
  // The loader resolves a name shared by two sets to the first set.
  const snapshot = await load(await fixtureValues());
  const result = importTokens(snapshot, {
    $metadata: { tokenSetOrder: ["S1", "S2"] },
    S1: { x: { $type: "color", $value: "#ffffff" } },
    S2: {
      x: { $type: "spacing", $value: 4 },
      y: { $type: "spacing", $value: "{x}" },
    },
  });
  assert.deepEqual(
    result.warnings.map(({ code, name }) => [name, code]),
    [["y", "token_alias_type_mismatch"]],
  );
  await apply(snapshot, result.operations, "i3");

  // Aliases may target DTCG tokens of other files; a later DTCG path cannot
  // also name a library token.
  const library = {
    activeSetIds: [],
    activeThemeIds: [],
    id: "tlib_default",
    sets: [
      {
        description: "",
        id: "tset_a",
        name: "a",
        tokens: [
          { description: "", id: "tok_u", name: "uses", type: "color", value: "{ext.c}" },
          { description: "", id: "tok_l", name: "late", type: "color", value: "#000000" },
        ],
      },
    ],
    themes: [],
  };
  const pruned = pruneUnresolvableTokens(library, {
    externalTokens: [
      { name: "ext.c", precedesLibrary: true, type: "color", value: "#ffffff" },
      { name: "late", precedesLibrary: false, type: "color", value: "#ffffff" },
    ],
  });
  assert.deepEqual(
    pruned.library.sets[0].tokens.map(({ name }) => name),
    ["uses"],
  );
  assert.deepEqual(
    pruned.warnings.map(({ code, name }) => [name, code]),
    [["late", "duplicate_token_path"]],
  );

  const withExternal = withDtcg(
    await fixtureValues(),
    { ext: { $type: "color", c: { $extensions: tokenExt("tok_ext"), $value: "#ffffff" } } },
    "tokens/a-ext.json",
  );
  withExternal.get("manifest.json").entries.tokens.reverse();
  const external = await load(withExternal);
  const imported = importTokens(external, {
    $metadata: { tokenSetOrder: ["S"] },
    S: { uses: { $type: "color", $value: "{ext.c}" } },
  });
  assert.deepEqual(imported.warnings, []);
  await apply(external, imported.operations, "i4");
  assert.ok(findTokenLibrary(external));
});

// Every Operation type, applied and then undone with its inverse batch, must
// return the package to its original revision.
test("every operation's inverse batch restores the original revision", async () => {
  const roundtrip = async () =>
    withDtcg(await fixtureValues(), {
      color: {
        $type: "color",
        brand: { $extensions: tokenExt("tok_brand"), $value: "#7c3aed" },
      },
    });
  const design = () => fixtureValues("design-system.smallpen");
  const product = async () => {
    const values = await fixtureValues();
    Object.assign(values.get("manifest.json"), {
      dependencies: [{ packageId: "pkg_base", path: "base" }],
      role: "product",
    });
    return values;
  };
  // A second Component Set: the fixture's set with every id renamed.
  const extraSet = (values) =>
    JSON.parse(
      JSON.stringify(
        values.get("components/components.json").componentSets[0],
      ).replaceAll("card", "extra").replaceAll("Card", "Extra"),
    );
  const node = (id) => ({
    children: [],
    height: 10,
    id,
    name: id,
    type: "RECTANGLE",
    width: 10,
    x: 1,
    y: 2,
  });
  const at = { presentationId: "pres_desktop", screenId: "scr_roundtrip" };
  const binding = { assetId: "tok_brand", packageId: "pkg_roundtrip" };
  const secondScreen = (values) => {
    const screen = structuredClone(values.get("screens/roundtrip.json"));
    screen.id = "scr_second";
    screen.name = "Second";
    return screen;
  };
  const secondPresentation = (values) => ({
    ...structuredClone(presentationOf(values)),
    id: "pres_mobile",
    name: "Mobile",
  });
  const scenario = {
    actions: [],
    context: {},
    expectedVisibleNodeIds: [],
    fixture: {},
    id: "scn_x",
    name: "x",
    target: {
      component: { assetId: "cmp_card_set", packageId: "pkg_design_system" },
      kind: "component",
      variant: { axis_state: "idle" },
    },
    viewport: { height: 40, scale: 1, width: 120 },
  };
  const contextFile = {
    axes: [
      {
        defaultValue: "light",
        id: "axis_theme",
        kind: "theme",
        name: "Theme",
        values: [{ id: "light", name: "Light" }],
      },
    ],
    profiles: [],
  };
  const requirementFile = { annotations: [], flows: [], requirements: [] };
  const interaction = {
    action: { nodeId: "node_rectangle", type: "set-visibility", visible: false },
    id: "int_hide",
    name: "Hide",
    sourceNodeId: "node_canvas",
    trigger: "activate",
  };
  const library = {
    packageId: "pkg_other",
    source: { path: "other.smallpen", type: "local" },
  };
  const cases = [
    ["update-node", roundtrip, () => [], () => [
      { changes: { name: "Renamed", x: 5 }, nodeId: "node_rectangle", screenId: "scr_roundtrip", type: "update-node" },
    ]],
    ["update-presentation-node", roundtrip, () => [], () => [
      { ...at, changes: { opacity: 0.5, visible: null }, nodeId: "node_rectangle", type: "update-presentation-node" },
    ]],
    ["add-presentation-node", roundtrip, () => [], () => [
      { ...at, index: 0, node: node("node_new"), parentId: "node_canvas", type: "add-presentation-node" },
    ]],
    ["delete-presentation-node", roundtrip, () => [
      { ...at, index: 1, node: node("node_child"), parentId: "node_canvas", type: "add-presentation-node" },
      { ...at, node: node("node_grandchild"), parentId: "node_child", type: "add-presentation-node" },
    ], () => [
      { ...at, nodeId: "node_child", type: "delete-presentation-node" },
    ]],
    ["move-presentation-nodes", roundtrip, () => [], () => [
      { ...at, nodeIds: ["node_rectangle"], parentId: null, type: "move-presentation-nodes" },
    ]],
    ["reorder-presentation-children", roundtrip, () => [
      { ...at, node: node("node_second"), parentId: "node_canvas", type: "add-presentation-node" },
    ], () => [
      { ...at, childIds: ["node_second", "node_rectangle"], parentId: "node_canvas", type: "reorder-presentation-children" },
    ]],
    ["add-presentation", roundtrip, () => [], (values) => [
      { basePresentationId: "pres_mobile", presentation: secondPresentation(values), screenId: "scr_roundtrip", type: "add-presentation" },
    ]],
    ["delete-presentation", roundtrip, (values) => [
      { basePresentationId: "pres_mobile", presentation: secondPresentation(values), screenId: "scr_roundtrip", type: "add-presentation" },
    ], () => [
      { presentationId: "pres_mobile", screenId: "scr_roundtrip", type: "delete-presentation" },
    ]],
    ["move-presentation", roundtrip, (values) => [
      { presentation: secondPresentation(values), screenId: "scr_roundtrip", type: "add-presentation" },
    ], () => [
      { index: 0, presentationId: "pres_mobile", screenId: "scr_roundtrip", type: "move-presentation" },
    ]],
    ["update-presentation", roundtrip, () => [], () => [
      { ...at, changes: { background: "#000000", name: "Wide" }, type: "update-presentation" },
    ]],
    ["put-screen", roundtrip, () => [], (values) => [
      { screen: secondScreen(values), type: "put-screen" },
    ]],
    ["delete-screen", roundtrip, (values) => [
      { screen: secondScreen(values), type: "put-screen" },
    ], () => [
      { screenId: "scr_roundtrip", type: "delete-screen" },
    ]],
    ["set-default-screen", roundtrip, (values) => [
      { screen: secondScreen(values), type: "put-screen" },
    ], () => [
      { screenId: "scr_second", type: "set-default-screen" },
    ]],
    ["put-interaction", roundtrip, () => [], () => [
      { ...at, interaction, type: "put-interaction" },
    ]],
    ["delete-interaction", roundtrip, () => [
      { ...at, interaction, type: "put-interaction" },
    ], () => [
      { ...at, interactionId: "int_hide", type: "delete-interaction" },
    ]],
    ["put-token", roundtrip, () => [], () => [
      { definition: { $type: "color", $value: "#000000", $extensions: tokenExt("tok_ink") }, filePath: "tokens/dtcg.json", path: "color.ink", tokenId: "tok_ink", type: "put-token" },
    ]],
    ["put-token (new file)", roundtrip, () => [], () => [
      { definition: { $type: "color", $value: "#000000", $extensions: tokenExt("tok_ink") }, filePath: "tokens/more.json", path: "ink.base", tokenId: "tok_ink", type: "put-token" },
    ]],
    ["remove-token", roundtrip, () => [], () => [
      { tokenId: "tok_brand", type: "remove-token" },
    ]],
    ["deprecate-token", roundtrip, () => [], () => [
      { tokenId: "tok_brand", type: "deprecate-token" },
    ]],
    ["set-token-value", roundtrip, () => [], () => [
      { tokenId: "tok_brand", type: "set-token-value", value: "#000000" },
    ]],
    ["set-token-binding", roundtrip, () => [], () => [
      { binding, field: "fill", nodeId: "node_rectangle", screenId: "scr_roundtrip", type: "set-token-binding" },
    ]],
    ["clear-token-binding", roundtrip, () => [
      { binding, field: "fill", nodeId: "node_rectangle", screenId: "scr_roundtrip", type: "set-token-binding" },
    ], () => [
      { field: "fill", nodeId: "node_rectangle", screenId: "scr_roundtrip", type: "clear-token-binding" },
    ]],
    ["replace-token-library", roundtrip, () => [], (values) => {
      const library = structuredClone(values.get("tokens/tokens.json"));
      library.sets[0].tokens.push({ description: "", id: "tok_new", name: "new", type: "sizing", value: 4 });
      return [{ library, type: "replace-token-library" }];
    }],
    ["replace-token-library (remove)", roundtrip, () => [], () => [
      { library: null, type: "replace-token-library" },
    ]],
    ["replace-asset-library", roundtrip, () => [], (values) => {
      const library = structuredClone(values.get("assets/assets.json"));
      library.colors.push({ id: "color_new", name: "New", paint: { color: "#000000", type: "solid" }, path: "" });
      return [{ library, type: "replace-asset-library" }];
    }],
    ["put-library", roundtrip, () => [], () => [
      { library, type: "put-library" },
    ]],
    ["remove-library", roundtrip, () => [
      { library, type: "put-library" },
    ], () => [
      { packageId: "pkg_other", type: "remove-library" },
    ]],
    ["put-context-file", roundtrip, () => [], () => [
      { contextFile, type: "put-context-file" },
    ]],
    ["delete-context-file", roundtrip, () => [
      { contextFile, type: "put-context-file" },
    ], () => [
      { entry: "contexts/contexts.json", type: "delete-context-file" },
    ]],
    ["put-requirement-file", roundtrip, () => [], () => [
      { requirementFile, type: "put-requirement-file" },
    ]],
    ["delete-requirement-file", roundtrip, () => [
      { requirementFile, type: "put-requirement-file" },
    ], () => [
      { type: "delete-requirement-file" },
    ]],
    ["restore-canonical-entry", roundtrip, () => [], () => [
      { entry: "requirements/restored.json", kind: "requirements", type: "restore-canonical-entry", value: requirementFile },
    ]],
    ["repair-reference", roundtrip, () => [], () => [
      { action: "remove-dependent-usage", referencePath: "screens/roundtrip.json.presentations[0].nodes.node_rectangle", type: "repair-reference" },
    ]],
    ["add-component", roundtrip, () => [
      { ...at, node: { ...node("node_frame"), type: "FRAME" }, parentId: "node_canvas", type: "add-presentation-node" },
    ], () => [
      { component: { id: "cmp_frame", mainNodeId: "node_frame", name: "Frame", path: "", presentationId: "pres_desktop", screenId: "scr_roundtrip" }, type: "add-component" },
    ]],
    ["update-component", roundtrip, () => [
      { ...at, node: { ...node("node_frame"), type: "FRAME" }, parentId: "node_canvas", type: "add-presentation-node" },
      { component: { id: "cmp_frame", mainNodeId: "node_frame", name: "Frame", path: "", presentationId: "pres_desktop", screenId: "scr_roundtrip" }, type: "add-component" },
    ], () => [
      { changes: { name: "Renamed", path: "Group" }, componentId: "cmp_frame", type: "update-component" },
    ]],
    ["delete-component", roundtrip, () => [
      { ...at, node: { ...node("node_frame"), type: "FRAME" }, parentId: "node_canvas", type: "add-presentation-node" },
      { component: { id: "cmp_frame", mainNodeId: "node_frame", name: "Frame", path: "", presentationId: "pres_desktop", screenId: "scr_roundtrip" }, type: "add-component" },
    ], () => [
      { componentId: "cmp_frame", type: "delete-component" },
    ]],
    ["update-component-node", design, () => [], () => [
      { changes: { name: "Caption" }, componentId: "cmp_card_set", nodeId: "node_card_idle_label", type: "update-component-node", unset: ["fills"], variantId: "var_card_idle" },
    ]],
    ["put-variant", design, () => [], (values) => {
      const variant = structuredClone(values.get("components/components.json").componentSets[0].variants[0]);
      variant.nodes[variant.rootId].name = "Card / idle (edited)";
      return [{ componentId: "cmp_card_set", type: "put-variant", variant }];
    }],
    ["put-component-set", design, () => [], (values) => {
      const componentSet = structuredClone(values.get("components/components.json").componentSets[0]);
      componentSet.name = "Card (edited)";
      return [{ componentSet, type: "put-component-set" }];
    }],
    ["select-instance-variant", design, () => [], () => [
      { nodeId: "node_card_instance_idle", screenId: "scr_design_system", selection: { axis_state: "pressed" }, type: "select-instance-variant" },
    ]],
    ["set-active-token-themes", design, () => [], () => [
      { themePaths: ["color/Dark", "radius/md"], type: "set-active-token-themes" },
    ]],
    ["delete-variant", design, (values) => [
      { componentSet: extraSet(values), type: "put-component-set" },
    ], () => [
      { componentId: "cmp_extra_set", type: "delete-variant", variantId: "var_extra_pressed" },
    ]],
    ["delete-component-set", design, (values) => [
      { componentSet: extraSet(values), type: "put-component-set" },
    ], () => [
      { componentId: "cmp_extra_set", type: "delete-component-set" },
    ]],
    ["set-foundation-dependency", product, () => [], () => [
      { dependency: { packageId: "pkg_other_base", path: "other" }, type: "set-foundation-dependency" },
    ]],
    ["put-scenario", design, () => [], () => [
      { scenario, type: "put-scenario" },
    ]],
    ["delete-scenario", design, () => [
      { scenario, type: "put-scenario" },
    ], () => [
      { scenarioId: "scn_x", type: "delete-scenario" },
    ]],
  ];
  const failures = [];
  for (const [name, fixture, setup, operations] of cases) {
    try {
      const values = await fixture();
      let snapshot = await load(values);
      const setupOperations = setup(values);
      if (setupOperations.length > 0) {
        snapshot = (await apply(snapshot, setupOperations, "setup")).snapshot;
      }
      const applied = await apply(snapshot, operations(values), "op");
      if (applied.result.revision === snapshot.revision) {
        failures.push(`${name}: no change`);
        continue;
      }
      const undone = await prepareOperationBatch(
        applied.snapshot,
        applied.result.inverseBatch,
      );
      if (undone.result.revision !== snapshot.revision) {
        failures.push(`${name}: inverse changed the revision`);
      }
    } catch (error) {
      failures.push(`${name}: ${error.code ?? ""} ${error.message}`);
    }
  }
  assert.deepEqual(failures, []);
});

test("deep trees fail validation and large subtrees delete in linear time", async () => {
  const deep = await fixtureValues();
  const nodes = presentationOf(deep).nodes;
  let parentId = "node_rectangle";
  nodes[parentId].type = "FRAME";
  for (let index = 0; index < 20000; index += 1) {
    const id = `node_deep_${index}`;
    nodes[parentId].children = [id];
    nodes[id] = { ...nodes.node_rectangle, children: [], id, name: id, type: "FRAME" };
    parentId = id;
  }
  await rejectsWith(load(deep), "node_tree_too_deep");

  const wide = await fixtureValues();
  const canvas = presentationOf(wide).nodes.node_canvas;
  for (let index = 0; index < 20000; index += 1) {
    const id = `node_wide_${index}`;
    canvas.children.push(id);
    presentationOf(wide).nodes[id] = {
      children: [],
      height: 1,
      id,
      name: id,
      type: "RECTANGLE",
      width: 1,
      x: index,
      y: 0,
    };
  }
  const snapshot = await load(wide);
  const started = performance.now();
  const deleted = await apply(snapshot, [
    {
      nodeId: "node_canvas",
      presentationId: "pres_desktop",
      screenId: "scr_roundtrip",
      type: "delete-presentation-node",
    },
  ]).catch((error) => error);
  // The last root cannot go, but the subtree walk runs before that check.
  assert.ok(performance.now() - started < 5000);
  assert.ok(deleted instanceof Error || deleted.result);
});

test("long alias chains load and list without quadratic work", async () => {
  const values = await fixtureValues();
  const color = { $type: "color" };
  for (let index = 0; index < 20000; index += 1) {
    color[`t${index}`] = {
      $extensions: tokenExt(`tok_${index}`),
      $value: index === 0 ? "#123456" : `{color.t${index - 1}}`,
    };
  }
  const snapshot = await load(withDtcg(values, { color }));
  const started = performance.now();
  const listed = listEffectiveTokens(snapshot);
  assert.ok(performance.now() - started < 5000);
  assert.equal(listed.length, 20000);
  assert.ok(listed.every(({ value }) => value === "#123456"));
});

test("writes reuse verified blobs and still hash caller bytes", async () => {
  const values = await fixtureValues();
  const bytes = new Uint8Array(4096).map((_, index) => index % 251);
  const sha = createHash("sha256").update(bytes).digest("hex");
  values.get("assets/assets.json").media.push({
    blob: `blobs/${sha}`,
    byteLength: bytes.byteLength,
    height: 1,
    id: "media_sample",
    mimeType: "image/png",
    name: "sample",
    path: "",
    sha256: sha,
    width: 1,
  });
  values.set(`blobs/${sha}`, bytes);
  const snapshot = await load(values);
  const update = [
    {
      changes: { x: 3 },
      nodeId: "node_rectangle",
      screenId: "scr_roundtrip",
      type: "update-node",
    },
  ];
  const written = await apply(snapshot, update);
  assert.equal(
    written.snapshot.blobs.get(`blobs/${sha}`),
    snapshot.blobs.get(`blobs/${sha}`),
  );
  const forged = new Map(snapshot.blobs);
  forged.set(`blobs/${sha}`, new Uint8Array(bytes.byteLength));
  await rejectsWith(
    apply({ ...snapshot, blobs: forged }, update),
    "media_blob_hash_mismatch",
  );
});
