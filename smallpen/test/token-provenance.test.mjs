import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  listPackageEntries,
  loadPackageFromValues,
  projectScreen,
  selectTokenThemes,
} from "@smallpen/core";
import {
  componentLookup,
  resolveDesignLayout,
  selectedDesign,
} from "../apps/cli/bin/design-output.mjs";
import {
  inspectionReport,
  inspectionText,
} from "../apps/cli/bin/inspection-output.mjs";

const fixture = new URL("fixtures/variant-acme.smallpen/", import.meta.url);
const ref = (assetId) => ({ assetId, packageId: "pkg_acme" });

async function example(edit = () => {}) {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", fixture), "utf8"));
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of listPackageEntries(manifest).entries)
    values.set(entry, JSON.parse(await readFile(new URL(entry, fixture), "utf8")));
  const library = values.get("tokens/tokens.json");
  library.sets[0].tokens.push(
    { id: "tok_space4", name: "space.4", type: "spacing", value: 4, description: "" },
    { id: "tok_alpha", name: "alpha.muted", type: "opacity", value: 0.8, description: "" },
  );
  library.sets.find(({ id }) => id === "tset_theme_dark").tokens.push(
    { id: "tok_space4_dark", name: "space.4", type: "spacing", value: 6, description: "" },
  );
  const sets = values.get("components/components.json").componentSets;
  const source = sets[0].variants[0].nodes.node_button_root;
  Object.assign(source, {
    layout: "flex",
    "layout-flex-dir": "row",
    "layout-gap": { "row-gap": 1, "column-gap": 1 },
    "layout-padding": { p1: 0, p2: 0, p3: 0, p4: 0 },
    tokenBindings: { itemSpacing: ref("tok_space4"), paddingLeft: ref("tok_spacing_md"), opacity: ref("tok_alpha") },
  });
  const nodes = values.get("screens/first-design.json").presentations[0].nodes;
  nodes.node_button_one.tokenBindings = {};
  edit({ values, sets, source, instance: nodes.node_button_one, nodes });
  return loadPackageFromValues("memory://token-provenance.smallpen", values);
}

async function report(product, target = {}) {
  const workspace = { product, libraries: [] };
  const design = await resolveDesignLayout(workspace, selectedDesign(workspace, {}, target));
  const stored = product.entries["screens/first-design.json"].presentations[0].nodes;
  return inspectionReport(workspace, design, { components: componentLookup(workspace), stored, full: true });
}

test("empty instance bindings preserve the effective Token, theme and component source", async () => {
  const light = await example();
  const dark = selectTokenThemes({ product: light }, ["Theme/Dark"]).product;
  for (const [product, value, theme] of [[light, 4, "Theme/Light"], [dark, 6, "Theme/Dark"]]) {
    const projected = projectScreen(product, "scr_home", {}).nodes.node_button_one;
    assert.equal(projected["layout-gap"]["column-gap"], value);
    assert.deepEqual(projected.tokenBindings.itemSpacing, ref("tok_space4"));
    const spec = await report(product);
    const instance = spec.nodes.find(({ nodeId }) => nodeId === "node_button_one");
    assert.equal(instance.fields.gap.kind, "token");
    assert.equal(instance.fields.gap.value, value);
    assert.equal(instance.fields.gap.token.path, "space.4");
    assert.ok(instance.fields.gap.token.themes.includes(theme));
    assert.equal(instance.fields.gap.source, "Button / Button");
    assert.equal(instance.source.overrides.length, 0);
    assert.match(inspectionText(spec), new RegExp(`gap=${value} \\{space\\.4\\}`));
  }
});

test("a component definition, its page instance and a nested instance retain the same binding", async () => {
  const product = await example(({ sets }) => {
    const variant = sets[1].variants[0];
    variant.nodes.node_badge_root.children.push("node_nested");
    variant.nodes.node_nested = {
      id: "node_nested", type: "INSTANCE", name: "Nested button", x: 0, y: 0,
      width: 120, height: 40, children: [], tokenBindings: {},
      instance: { component: { packageId: "pkg_acme", assetId: "cmp_button" }, variant: {} },
    };
  });
  const definition = await report(product, { componentId: "cmp_button" });
  const page = await report(product);
  for (const node of [
    definition.nodes[0],
    page.nodes.find(({ nodeId }) => nodeId === "node_button_one"),
    page.nodes.find(({ nodeId }) => nodeId === "node_badge_one__node_nested"),
  ]) {
    assert.equal(node.fields.gap.kind, "token");
    assert.equal(node.fields.gap.token.path, "space.4");
    assert.equal(node.fields.gap.source, "Button / Button");
  }
});

test("an instance's one-axis Token overrides the aggregate gap without dropping other inherited bindings", async () => {
  const product = await example(({ instance }) => {
    instance.tokenBindings = { columnGap: ref("tok_spacing_md") };
  });
  const projected = projectScreen(product, "scr_home", {}).nodes.node_button_one;
  assert.deepEqual(projected["layout-gap"], { "row-gap": 4, "column-gap": 8 });
  const spec = await report(product);
  const node = spec.nodes.find(({ nodeId }) => nodeId === "node_button_one");
  assert.equal(node.fields.gap.token.path, "spacing.md");
  assert.match(node.fields.gap.source, /^instance override/);
  assert.equal(node.fields.paddingLeft.kind, "token");
  assert.equal(node.fields.paddingLeft.token.path, "spacing.md");
  assert.equal(node.fields.paddingLeft.source, "Button / Button");
});

test("clearing one inherited Token keeps the other fields bound and the rendered value unchanged", async () => {
  const product = await example(({ instance }) => {
    instance.instance.overrides = { "node_button_root:tokenBindings": { itemSpacing: null } };
  });
  const projected = projectScreen(product, "scr_home", {}).nodes.node_button_one;
  assert.equal(projected["layout-gap"]["column-gap"], 4);
  const node = (await report(product)).nodes.find(({ nodeId }) => nodeId === "node_button_one");
  assert.equal(node.fields.gap.kind, "literal");
  assert.equal(node.fields.gap.token, undefined);
  assert.match(node.fields.gap.source, /^instance override/);
  assert.equal(node.fields.paddingLeft.kind, "token");
});

test("literal instance fields and child overrides do not claim their source's Token", async () => {
  for (const override of [false, true]) {
    const product = await example(({ instance }) => {
      if (override) instance.instance.overrides = { "node_button_root:opacity": 0.3 };
      else instance.opacity = 0.3;
    });
    const projected = projectScreen(product, "scr_home", {}).nodes.node_button_one;
    assert.equal(projected.opacity, 0.3);
    const node = (await report(product)).nodes.find(({ nodeId }) => nodeId === "node_button_one");
    assert.equal(node.fields.opacity.kind, "literal");
    assert.equal(node.fields.opacity.token, undefined);
    assert.match(node.fields.opacity.source, /^instance override/);
    assert.equal(node.fields.gap.kind, "token");
  }
});

test("legacy applied Token names survive an empty instance binding table", async () => {
  const product = await example(({ source }) => {
    delete source.tokenBindings.itemSpacing;
    source.appliedTokens = { "row-gap": "space.4", "column-gap": "space.4" };
  });
  const node = (await report(product)).nodes.find(({ nodeId }) => nodeId === "node_button_one");
  assert.equal(node.fields.gap.kind, "token");
  assert.equal(node.fields.gap.token.path, "space.4");
});

test("a literal layout value on the instance reports its own source", async () => {
  const product = await example(({ instance }) => {
    instance["layout-gap"] = { "row-gap": 12, "column-gap": 12 };
  });
  const node = (await report(product)).nodes.find(({ nodeId }) => nodeId === "node_button_one");
  assert.equal(node.fields.gap.value, 12);
  assert.equal(node.fields.gap.kind, "literal");
  assert.match(node.fields.gap.source, /^instance override/);
  assert.equal(node.fields.paddingLeft.kind, "token");
});

test("an outer instance's nested field override keeps the nested component source", async () => {
  const product = await example(({ sets, nodes }) => {
    const variant = sets[1].variants[0];
    variant.nodes.node_badge_root.children.push("node_nested");
    variant.nodes.node_nested = {
      id: "node_nested", type: "INSTANCE", name: "Nested button", x: 0, y: 0,
      width: 120, height: 40, children: [], tokenBindings: {},
      instance: { component: { packageId: "pkg_acme", assetId: "cmp_button" }, variant: {} },
    };
    nodes.node_badge_one.instance.overrides = { "node_nested:opacity": 0.3 };
  });
  const node = (await report(product)).nodes.find(({ nodeId }) => nodeId === "node_badge_one__node_nested");
  assert.equal(node.fields.opacity.value, 0.3);
  assert.equal(node.fields.opacity.kind, "literal");
  assert.equal(node.fields.opacity.source, "instance override → Button / Button");
  assert.equal(node.fields.gap.kind, "token");
  assert.equal(node.fields.gap.source, "Button / Button");
});

test("instance summaries retain descendant overrides without changing the root field's source", async () => {
  const product = await example(({ sets, source, instance }) => {
    source.children = ["node_body"];
    sets[0].variants[0].nodes.node_body = {
      id: "node_body", name: "Body", type: "RECTANGLE", x: 0, y: 0,
      width: 20, height: 20, children: [], tokenBindings: { opacity: ref("tok_alpha") },
    };
    instance.instance.overrides = { "node_body:opacity": 0.3 };
  });
  const spec = await report(product);
  const root = spec.nodes.find(({ nodeId }) => nodeId === "node_button_one");
  const child = spec.nodes.find(({ nodeId }) => nodeId === "node_button_one__node_body");
  assert.deepEqual(root.source.overrides, [{ element: "Body", field: "opacity", value: 0.3 }]);
  assert.equal(root.fields.opacity.kind, "token");
  assert.equal(root.fields.opacity.source, "Button / Button");
  assert.equal(child.fields.opacity.kind, "literal");
  assert.equal(child.fields.opacity.source, "instance override → Button / Body");
  assert.equal(root.source.fieldOverrides, undefined, "field bookkeeping stays out of the public report");
  assert.match(inspectionText(spec), /page overrides: Body\.opacity=0.3/);
});
