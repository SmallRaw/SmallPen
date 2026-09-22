// DSP-001-B: component/variant/instance/reference/permission fixture.
// Asserts the located component set, its radius-bound variants, the two
// bound instances, the hardcoded negative control, and the read-only shared
// library's same-named token with a qualified owner.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createCatalog,
  listPackageEntries,
  loadPackageFromValues,
  projectScreen,
} from "@smallpen/core";


const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "design-system.smallpen");
const sharedFixture = join(here, "fixtures", "dsp-shared.smallpen");

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

async function sharedValues() {
  const manifest = JSON.parse(
    await readFile(join(sharedFixture, "manifest.json"), "utf8"),
  );
  const { entries } = listPackageEntries(manifest);
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of entries) {
    values.set(entry, JSON.parse(await readFile(join(sharedFixture, entry), "utf8")));
  }
  return values;
}

test("component set defines a State axis with two legal FRAME variants bound to radius", async () => {
  const values = await fixtureValues();
  const snapshot = await loadPackageFromValues(
    "memory://design-system.smallpen",
    values,
  );
  const componentsEntry = snapshot.entries[
    snapshot.manifest.entries.components[0]
  ];
  assert.equal(componentsEntry.componentSets.length, 1);
  const set = componentsEntry.componentSets[0];
  assert.equal(set.id, "cmp_card_set");
  assert.equal(set.axes.length, 1);
  assert.deepEqual(set.axes[0].domain, ["idle", "pressed"]);
  assert.equal(set.variants.length, 2);

  for (const variant of set.variants) {
    const root = variant.nodes[variant.rootId];
    assert.equal(root.type, "COMPONENT");
    // A real FRAME main: FRAME-typed component root with a radius token
    // binding (never a hardcoded radius).
    assert.equal(typeof root.children, "object");
    assert.deepEqual(root.tokenBindings.cornerRadius, {
      assetId: "tok_radius_md_base",
      packageId: "pkg_design_system",
    });
  }
  const selections = set.variants.map((variant) => variant.selection.axis_state);
  assert.deepEqual(selections.sort(), ["idle", "pressed"]);
});

test("screen carries two radius-bound instances and one hardcoded control", async () => {
  const values = await fixtureValues();
  const snapshot = await loadPackageFromValues(
    "memory://design-system.smallpen",
    values,
  );
  const presentation = snapshot.manifest.entries.screens
    .map((entry) => snapshot.entries[entry])
    .find((screen) => screen.presentations[0]).presentations[0];
  const nodes = presentation.nodes;

  const instances = Object.values(nodes).filter((n) => n.type === "INSTANCE");
  assert.equal(instances.length, 2);
  const variants = instances
    .map((instance) => instance.instance.variant.axis_state)
    .sort();
  assert.deepEqual(variants, ["idle", "pressed"]);
  for (const instance of instances) {
    assert.deepEqual(instance.instance.component, {
      assetId: "cmp_card_set",
      packageId: "pkg_design_system",
    });
  }

  // Hardcoded negative control: same kind of rounded shape, no binding.
  const hardcoded = nodes.node_card_hardcoded;
  assert.equal(hardcoded.type, "RECTANGLE");
  assert.equal(hardcoded.cornerRadius, 12);
  assert.equal(hardcoded.tokenBindings, undefined);
  // The negative control is NOT a component reference.
  assert.equal(hardcoded.componentId, undefined);
  assert.equal(hardcoded.instance, undefined);
});

test("read-only shared library keeps a same-named token under a distinct owner", async () => {
  const values = await fixtureValues();
  const product = await loadPackageFromValues(
    "memory://design-system.smallpen",
    values,
  );
  const sharedLibraryValues = await sharedValues();
  const shared = await loadPackageFromValues(
    "memory://dsp-shared.smallpen",
    sharedLibraryValues,
  );
  assert.equal(shared.manifest.packageId, "pkg_dsp_shared");

  // Same-named row, distinct owner and value: qualification is by package.
  const productSurface = values
    .get("tokens/tokens.json")
    .sets.flatMap((set) => set.tokens)
    .find((token) => token.name === "surface");
  const sharedSurface = sharedLibraryValues
    .get("tokens/dsp-shared.json")
    .sets.flatMap((set) => set.tokens)
    .find((token) => token.name === "surface");
  assert.equal(productSurface.name, sharedSurface.name);
  assert.notEqual(productSurface.value, sharedSurface.value);
  assert.equal(productSurface.id, "tok_color_light_surface");
  assert.equal(sharedSurface.id, "tok_shared_color_light_surface");

  // The product declares the shared library as its read-only local source.
  assert.deepEqual(product.manifest.libraries, [
    {
      packageId: "pkg_dsp_shared",
      source: { path: "dsp-shared.smallpen", type: "local" },
    },
  ]);
  const catalog = createCatalog(product, { libraries: [shared] });
  assert.equal(catalog.libraries[0].packageId, "pkg_dsp_shared");
});

test("screen projection resolves the component instances", async () => {
  const values = await fixtureValues();
  const product = await loadPackageFromValues(
    "memory://design-system.smallpen",
    values,
  );
  const projection = projectScreen(product, "scr_design_system", {});
  const root = projection.nodes.node_card_instance_idle;
  assert.equal(root.type, "INSTANCE");
  assert.equal(root.componentId, "cmp_card_set");
  // The hardcoded control stays an ordinary rectangle with its literal radius.
  assert.equal(projection.nodes.node_card_hardcoded.cornerRadius, 12);
});
