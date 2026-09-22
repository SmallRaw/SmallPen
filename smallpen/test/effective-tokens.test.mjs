import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  explainEffectiveToken,
  listEffectiveTokens,
  loadPackageFromValues,
  projectEffectiveSnapshot,
  resolveContext,
  resolveEffectiveToken,
} from "@smallpen/core";

const cli = fileURLToPath(
  new URL("../apps/cli/bin/smallpen.mjs", import.meta.url),
);

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr, stdout }));
  });
}

async function writeValues(root, values) {
  for (const [entry, value] of values) {
    const target = join(root, entry);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
  }
}

const emptyEntries = () => ({
  assets: [],
  components: [],
  contexts: [],
  requirements: [],
  scenarios: [],
  screens: [],
  tokens: [],
});

function foundationValues() {
  const manifest = {
    entries: {
      ...emptyEntries(),
      contexts: ["contexts/foundation.json"],
      tokens: ["tokens/foundation.json"],
    },
    formatVersion: 1,
    name: "Foundation",
    packageId: "pkg_foundation",
    role: "foundation",
  };
  return new Map([
    ["manifest.json", manifest],
    [
      "contexts/foundation.json",
      {
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
          {
            defaultValue: "desktop",
            id: "axis_viewport",
            kind: "viewport",
            name: "Viewport",
            values: [
              { id: "desktop", name: "Desktop" },
              { id: "mobile", name: "Mobile" },
            ],
          },
        ],
        profiles: [
          {
            default: true,
            id: "ctx_default",
            name: "Default",
            values: { axis_theme: "light", axis_viewport: "desktop" },
          },
        ],
      },
    ],
    [
      "tokens/foundation.json",
      {
        color: {
          $type: "color",
          brand: {
            $extensions: {
              smallpen: { id: "tok_color_brand", visibility: "public" },
            },
            $value: "#6750a4",
          },
          button: {
            $extensions: {
              smallpen: {
                contextValues: [
                  { value: "#bb86fc", when: { axis_theme: "dark" } },
                ],
                id: "tok_color_button",
                visibility: "public",
              },
            },
            $value: "{color.brand}",
          },
        },
      },
    ],
  ]);
}

function productValues() {
  const manifest = {
    dependencies: [
      { packageId: "pkg_foundation", path: "foundation.smallpen" },
    ],
    entries: { ...emptyEntries(), tokens: ["tokens/product.json"] },
    formatVersion: 1,
    name: "Product",
    packageId: "pkg_product",
    role: "product",
  };
  return new Map([
    ["manifest.json", manifest],
    [
      "tokens/product.json",
      {
        color: {
          $type: "color",
          buttonOverride: {
            $extensions: {
              smallpen: {
                contextValues: [
                  {
                    value: "#e53935",
                    when: { axis_viewport: "mobile" },
                  },
                  {
                    value: "#ef5350",
                    when: { axis_theme: "dark", axis_viewport: "mobile" },
                  },
                ],
                id: "tok_product_button_override",
                overrideOf: {
                  assetId: "tok_color_button",
                  packageId: "pkg_foundation",
                },
                visibility: "private",
              },
            },
          },
          surface: {
            $extensions: {
              smallpen: { id: "tok_product_surface", visibility: "private" },
            },
            $value: "#f7f2fa",
          },
        },
      },
    ],
  ]);
}

async function workspace() {
  return {
    foundation: await loadPackageFromValues(
      "memory://foundation.smallpen",
      foundationValues(),
    ),
    product: await loadPackageFromValues(
      "memory://product.smallpen",
      productValues(),
    ),
  };
}

test("Effective Tokens resolve defaults, specificity, Product priority, and Foundation fallback", async () => {
  const { foundation, product } = await workspace();
  const reference = {
    assetId: "tok_color_button",
    packageId: "pkg_foundation",
  };

  assert.deepEqual(resolveContext(product, foundation), {
    axis_theme: "light",
    axis_viewport: "desktop",
  });
  assert.deepEqual(
    resolveEffectiveToken(product, reference, { foundation }),
    {
      context: { axis_theme: "light", axis_viewport: "desktop" },
      sourceChain: [
        {
          packageId: "pkg_foundation",
          role: "target",
          tokenId: "tok_color_button",
        },
      ],
      sourcePackageId: "pkg_foundation",
      sourceTokenId: "tok_color_button",
      target: reference,
      token: {
        ...foundation.domain.tokens.get("tok_color_button"),
        resolvedValue: "#6750a4",
      },
      value: "#6750a4",
    },
  );
  assert.equal(
    resolveEffectiveToken(product, reference, {
      context: { axis_theme: "dark" },
      foundation,
    }).value,
    "#bb86fc",
  );
  assert.deepEqual(
    resolveEffectiveToken(product, reference, {
      context: { axis_viewport: "mobile" },
      foundation,
    }),
    {
      context: { axis_theme: "light", axis_viewport: "mobile" },
      sourceChain: [
        {
          packageId: "pkg_foundation",
          role: "target",
          tokenId: "tok_color_button",
        },
        {
          packageId: "pkg_product",
          role: "override",
          tokenId: "tok_product_button_override",
        },
      ],
      sourcePackageId: "pkg_product",
      sourceTokenId: "tok_product_button_override",
      target: reference,
      token: {
        ...product.domain.tokens.get("tok_product_button_override"),
        resolvedValue: "#e53935",
      },
      value: "#e53935",
    },
  );
  assert.equal(
    resolveEffectiveToken(product, reference, {
      context: { axis_theme: "dark", axis_viewport: "mobile" },
      foundation,
    }).value,
    "#ef5350",
  );
});

test("Effective Token explain names why an unmatched Context candidate is rejected", async () => {
  const { foundation, product } = await workspace();
  const reference = {
    assetId: "tok_color_button",
    packageId: "pkg_foundation",
  };
  const options = { foundation };
  const explanation = explainEffectiveToken(product, reference, options);
  assert.equal(explanation.status, "resolved");
  assert.deepEqual(explanation.candidates[0], {
    layer: "product",
    matched: false,
    reason: "no-compatible-context-value",
    rule: null,
    specificity: -1,
    tokenId: "tok_product_button_override",
  });
  assert.equal(explanation.candidates[1].matched, true);
  assert.equal(explanation.candidates[1].reason, undefined);
  assert.deepEqual(
    explanation.resolution,
    resolveEffectiveToken(product, reference, options),
  );
  assert.equal(explanation.resolution.value, "#6750a4");
  assert.equal(explanation.resolution.sourcePackageId, "pkg_foundation");

  const direct = explainEffectiveToken(product, {
    assetId: "tok_product_button_override",
    packageId: "pkg_product",
  }, options);
  assert.equal(direct.status, "missing");
  assert.equal(direct.resolution, null);
  assert.deepEqual(direct.candidates, [explanation.candidates[0]]);
});

test("Effective Token explain and list expose the same source decision", async () => {
  const { foundation, product } = await workspace();
  const reference = {
    assetId: "tok_color_button",
    packageId: "pkg_foundation",
  };
  const explanation = explainEffectiveToken(product, reference, {
    context: { axis_viewport: "mobile" },
    foundation,
  });
  assert.equal(explanation.status, "resolved");
  assert.deepEqual(explanation.candidates, [
    {
      layer: "product",
      matched: true,
      rule: { axis_viewport: "mobile" },
      specificity: 1,
      tokenId: "tok_product_button_override",
    },
  ]);
  assert.equal(explanation.resolution.value, "#e53935");
  const listed = listEffectiveTokens(product, {
    context: { axis_viewport: "mobile" },
    foundation,
  });
  assert.deepEqual(
    listed.map(({ target, value }) => ({ target, value })),
    [
      {
        target: {
          assetId: "tok_color_brand",
          packageId: "pkg_foundation",
        },
        value: "#6750a4",
      },
      { target: reference, value: "#e53935" },
      {
        target: {
          assetId: "tok_product_surface",
          packageId: "pkg_product",
        },
        value: "#f7f2fa",
      },
    ],
  );
});

test("the shared projection applies the same Effective Token decision to nodes", async () => {
  const foundation = await loadPackageFromValues(
    "memory://foundation.smallpen",
    foundationValues(),
  );
  const values = productValues();
  values.get("manifest.json").defaultScreenId = "scr_product";
  values.get("manifest.json").entries.screens = ["screens/product.json"];
  values.set("screens/product.json", {
    basePresentationId: "pres_product",
    counterparts: [],
    id: "scr_product",
    name: "Product",
    presentations: [
      {
        id: "pres_product",
        interactions: [],
        name: "Product",
        nodes: {
          node_root: {
            children: [],
            height: 100,
            id: "node_root",
            name: "Root",
            tokenBindings: {
              fill: {
                assetId: "tok_color_button",
                packageId: "pkg_foundation",
              },
            },
            type: "FRAME",
            width: 100,
            x: 0,
            y: 0,
          },
        },
        rootId: "node_root",
        viewport: { height: 100, width: 100 },
      },
    ],
  });
  const product = await loadPackageFromValues(
    "memory://projected-product.smallpen",
    values,
  );
  const projection = projectEffectiveSnapshot(product, {
    context: { axis_viewport: "mobile" },
    foundation,
  });
  assert.deepEqual(projection.projection.context, {
    axis_theme: "light",
    axis_viewport: "mobile",
  });
  assert.deepEqual(
    projection.entries["screens/product.json"].presentations[0].nodes.node_root
      .fills,
    [{ color: "#e53935", type: "solid" }],
  );
  assert.equal(
    product.entries["screens/product.json"].presentations[0].nodes.node_root
      .fills,
    undefined,
  );
});

test("the CLI exposes Effective Token and explain reads from the shared resolver", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-effective-cli-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const foundationPath = join(root, "foundation.smallpen");
  const productPath = join(root, "product.smallpen");
  await writeValues(foundationPath, foundationValues());
  await writeValues(productPath, productValues());

  const effectiveResult = await runCli([
    "effective-token",
    productPath,
    "--package-id",
    "pkg_foundation",
    "--token-id",
    "tok_color_button",
    "--context",
    "axis_viewport=mobile",
    "--json",
  ]);
  assert.equal(effectiveResult.code, 0, effectiveResult.stderr);
  const effective = JSON.parse(effectiveResult.stdout);
  assert.equal(effective.value, "#e53935");
  assert.equal(effective.sourcePackageId, "pkg_product");

  const searchResult = await runCli([
    "search-tokens",
    productPath,
    "--color",
    "#6750a4",
    "--json",
  ]);
  assert.equal(searchResult.code, 0, searchResult.stderr);
  const search = JSON.parse(searchResult.stdout);
  assert.equal(search.items[0].path, "color.brand");
  assert.equal(search.items[0].packageId, "pkg_foundation");
  assert.equal(search.items[0].exactValue, true);

  const explainResult = await runCli([
    "explain-token",
    productPath,
    "--package-id",
    "pkg_foundation",
    "--token-id",
    "tok_color_button",
    "--context",
    "axis_theme=dark",
    "--context",
    "axis_viewport=mobile",
    "--json",
  ]);
  assert.equal(explainResult.code, 0, explainResult.stderr);
  const explanation = JSON.parse(explainResult.stdout);
  assert.equal(explanation.status, "resolved");
  assert.equal(explanation.resolution.value, "#ef5350");
  assert.equal(explanation.candidates[0].specificity, 2);
});

test("Effective Tokens reject ambiguous rules, incompatible overrides, and invalid Contexts", async () => {
  const ambiguousValues = productValues();
  ambiguousValues
    .get("tokens/product.json")
    .color.buttonOverride.$extensions.smallpen.contextValues.push({
      value: "#000000",
      when: { axis_viewport: "mobile" },
    });
  const foundation = await loadPackageFromValues(
    "memory://foundation.smallpen",
    foundationValues(),
  );
  const ambiguous = await loadPackageFromValues(
    "memory://ambiguous.smallpen",
    ambiguousValues,
  );
  const reference = {
    assetId: "tok_color_button",
    packageId: "pkg_foundation",
  };
  assert.throws(
    () =>
      resolveEffectiveToken(ambiguous, reference, {
        context: { axis_viewport: "mobile" },
        foundation,
      }),
    (error) => error?.code === "ambiguous_token_context_rule",
  );

  const incompatibleValues = productValues();
  incompatibleValues.get(
    "tokens/product.json",
  ).color.buttonOverride.$type = "number";
  incompatibleValues
    .get("tokens/product.json")
    .color.buttonOverride.$extensions.smallpen.contextValues.forEach(
      (candidate, index) => {
        candidate.value = index + 1;
      },
    );
  const incompatible = await loadPackageFromValues(
    "memory://incompatible.smallpen",
    incompatibleValues,
  );
  assert.throws(
    () => resolveEffectiveToken(incompatible, reference, { foundation }),
    (error) => error?.code === "product_token_override_type_mismatch",
  );
  assert.throws(
    () => resolveContext(incompatible, foundation, { axis_theme: "sepia" }),
    (error) => error?.code === "invalid_context_selection",
  );
});

test("Context files reject invalid defaults and Product Axis redefinition", async () => {
  const invalidDefault = foundationValues();
  invalidDefault.get(
    "contexts/foundation.json",
  ).axes[0].defaultValue = "sepia";
  await assert.rejects(
    loadPackageFromValues("memory://invalid-context.smallpen", invalidDefault),
    (error) => error?.code === "missing_context_default",
  );

  const { foundation } = await workspace();
  const productWithAxis = productValues();
  productWithAxis.get("manifest.json").entries.contexts = [
    "contexts/product.json",
  ];
  productWithAxis.set("contexts/product.json", {
    axes: [
      {
        defaultValue: "light",
        id: "axis_theme",
        kind: "theme",
        name: "Duplicate Theme",
        values: [{ id: "light", name: "Light" }],
      },
    ],
    profiles: [],
  });
  const product = await loadPackageFromValues(
    "memory://product-axis.smallpen",
    productWithAxis,
  );
  assert.throws(
    () => resolveContext(product, foundation),
    (error) => error?.code === "duplicate_workspace_context_axis",
  );
});
