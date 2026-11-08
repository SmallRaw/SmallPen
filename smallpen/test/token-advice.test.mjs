import assert from "node:assert/strict";
import test from "node:test";

import {
  loadPackageFromValues,
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

