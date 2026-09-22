import assert from "node:assert/strict";
import test from "node:test";

import {
  designTokenWarningsForBatch,
  loadPackageFromValues,
  prepareOperationBatch,
  searchEffectiveTokens,
} from "@smallpen/core";

function values() {
  return new Map([
    [
      "manifest.json",
      {
        defaultScreenId: "scr_home",
        entries: {
          assets: [],
          components: [],
          contexts: [],
          requirements: [],
          scenarios: [],
          screens: ["screens/home.json"],
          tokens: ["tokens/design.json"],
        },
        formatVersion: 1,
        name: "Token Advice",
        packageId: "pkg_token_advice",
        role: "foundation",
      },
    ],
    [
      "screens/home.json",
      {
        basePresentationId: "pres_home",
        counterparts: [],
        id: "scr_home",
        name: "Home",
        presentations: [
          {
            id: "pres_home",
            interactions: [],
            name: "Home",
            nodes: {
              node_card: {
                children: [],
                fills: [{ color: "#ffffff", type: "solid" }],
                height: 120,
                id: "node_card",
                name: "Card",
                type: "RECTANGLE",
                width: 240,
                x: 0,
                y: 0,
              },
            },
            platform: "desktop",
            rootId: "node_card",
            viewport: { height: 600, width: 800 },
          },
        ],
      },
    ],
    [
      "tokens/design.json",
      {
        color: {
          $type: "color",
          accent: {
            $extensions: {
              smallpen: { id: "tok_accent", visibility: "public" },
            },
            $value: "#6750a4",
          },
          nearby: {
            $extensions: {
              smallpen: { id: "tok_nearby", visibility: "public" },
            },
            $value: "#6851a5",
          },
        },
      },
    ],
  ]);
}

test("Token search ranks exact and nearby color values without session state", async () => {
  const product = await loadPackageFromValues("memory://token-advice.smallpen", values());
  const result = searchEffectiveTokens(product, { value: "#6750A4" });

  assert.equal(result.items[0].path, "color.accent");
  assert.equal(result.items[0].exactValue, true);
  assert.equal(result.items[1].path, "color.nearby");
  assert.equal(result.items[1].exactValue, false);
  assert.ok(result.items[1].distance > 0);
});

test("Token search normalizes renderer color syntax and DTCG sRGB objects", async () => {
  const source = values();
  source.get("tokens/design.json").color.accent.$value = {
    alpha: 1,
    colorSpace: "srgb",
    components: [103 / 255, 80 / 255, 164 / 255],
  };
  const product = await loadPackageFromValues("memory://dtcg-color.smallpen", source);

  for (const value of ["#6750a4", "rgb(103, 80, 164)"]) {
    const result = searchEffectiveTokens(product, { type: "color", value });
    assert.equal(result.items[0].path, "color.accent");
    assert.equal(result.items[0].exactValue, true);
  }
});

test("Operation Batch warns about a hard-coded color with reusable Tokens", async () => {
  const product = await loadPackageFromValues("memory://token-advice.smallpen", values());
  const batch = {
    baseRevision: product.revision,
    batchId: "batch_hard_coded_color",
    operations: [
      {
        changes: { fills: [{ color: "#6750a4", type: "solid" }] },
        nodeId: "node_card",
        presentationId: "pres_home",
        screenId: "scr_home",
        type: "update-presentation-node",
      },
    ],
  };
  const prepared = await prepareOperationBatch(product, batch);
  const warnings = designTokenWarningsForBatch(prepared.snapshot, batch);

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "design_token_not_used");
  assert.equal(warnings[0].field, "fills.0");
  assert.equal(warnings[0].suggestions[0].path, "color.accent");
  assert.equal(warnings[0].suggestions[0].exactValue, true);
});

test("Operation Batch does not warn when the final node binds the value to a Token", async () => {
  const product = await loadPackageFromValues("memory://token-advice.smallpen", values());
  const batch = {
    baseRevision: product.revision,
    batchId: "batch_bound_color",
    operations: [
      {
        changes: {
          fills: [{ color: "#6750a4", type: "solid" }],
          tokenBindings: {
            "fills.0": {
              assetId: "tok_accent",
              packageId: "pkg_token_advice",
            },
          },
        },
        nodeId: "node_card",
        presentationId: "pres_home",
        screenId: "scr_home",
        type: "update-presentation-node",
      },
    ],
  };
  const prepared = await prepareOperationBatch(product, batch);

  assert.deepEqual(designTokenWarningsForBatch(prepared.snapshot, batch), []);
});

test("Token search finds the Contexts where an actual value resolves", async () => {
  const source = values();
  source.get("manifest.json").entries.contexts = ["contexts/platform.json"];
  source.set("contexts/platform.json", {
    axes: [
      {
        defaultValue: "web",
        id: "axis_platform",
        kind: "viewport",
        name: "Platform",
        values: [
          { id: "web", name: "Web" },
          { id: "desktop", name: "Desktop" },
        ],
      },
    ],
    profiles: [],
  });
  source.get("tokens/design.json").color.accent.$extensions.smallpen.contextValues = [
    { value: "#123456", when: { axis_platform: "desktop" } },
  ];
  const product = await loadPackageFromValues(
    "memory://context-token-advice.smallpen",
    source,
  );

  const allContexts = searchEffectiveTokens(product, { value: "#123456" });
  assert.equal(allContexts.contextScope.mode, "all");
  assert.deepEqual(allContexts.items[0].contexts, [
    { axis_platform: "desktop" },
  ]);
  assert.equal(allContexts.items[0].exactValue, true);

  const webOnly = searchEffectiveTokens(product, {
    context: { axis_platform: "web" },
    value: "#123456",
  });
  assert.equal(webOnly.contextScope.mode, "explicit");
  assert.equal(webOnly.items.some(({ exactValue }) => exactValue), false);
});

test("Operation Batch warns when no Design Token resolves to the actual value", async () => {
  const product = await loadPackageFromValues("memory://token-advice.smallpen", values());
  const batch = {
    baseRevision: product.revision,
    batchId: "batch_unmatched_color",
    operations: [
      {
        changes: { fills: [{ color: "#123456", type: "solid" }] },
        nodeId: "node_card",
        presentationId: "pres_home",
        screenId: "scr_home",
        type: "update-presentation-node",
      },
    ],
  };
  const prepared = await prepareOperationBatch(product, batch);
  const warnings = designTokenWarningsForBatch(prepared.snapshot, batch);

  assert.equal(warnings[0].code, "design_token_value_unmatched");
  assert.equal(warnings[0].match, "none");
  assert.equal(Object.hasOwn(warnings[0], "recommendedBinding"), false);
  assert.match(warnings[0].message, /No Design Token resolves to/);
  assert.ok(warnings[0].suggestions.length > 0);
});

test("put-screen checks every inserted node for unbound Design Token values", async () => {
  const product = await loadPackageFromValues("memory://put-screen-advice.smallpen", values());
  const screen = structuredClone(product.entries["screens/home.json"]);
  screen.presentations[0].nodes.node_card.fills = [
    { color: "rgb(103, 80, 164)", type: "solid" },
  ];
  const batch = {
    baseRevision: product.revision,
    batchId: "batch_put_screen_token_advice",
    operations: [{ screen, type: "put-screen" }],
  };
  const prepared = await prepareOperationBatch(product, batch);
  const warnings = designTokenWarningsForBatch(prepared.snapshot, batch);

  assert.equal(
    warnings.some(
      ({ code, field, nodeId }) =>
        code === "design_token_not_used" &&
        field === "fills.0" &&
        nodeId === "node_card",
    ),
    true,
  );
  assert.equal(warnings.some(({ field }) => field === "height"), true);
  assert.equal(warnings.some(({ field }) => field === "width"), true);
});
