// DSP-018-A/B/C: Token Cell editing via the authoring path.
// A: scalar write to the correct Cell.
// B: alias expression edit preserves shared target.
// C: variant override creates a new Cell without overwriting base.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  listPackageEntries,
  loadPackageFromValues,
  prepareOperationBatch,
  resolveEffectiveToken,
} from "@smallpen/core";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "design-system.smallpen");

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

async function snapshot() {
  return loadPackageFromValues("memory://dsp018.smallpen", await fixtureValues());
}

function tokenCell(snapshot, setName, tokenName) {
  const lib = snapshot.entries[snapshot.manifest.entries.tokens[0]];
  const set = lib.sets.find((s) => s.name === setName);
  return set?.tokens.find((t) => t.name === tokenName);
}

test("DSP-018-A: set-token-value writes the correct Cell", async () => {
  const before = await snapshot();
  const rev0 = before.revision;
  const batch = {
    baseRevision: rev0,
    batchId: "dsp018a-write-1",
    operations: [{
      type: "set-token-value",
      filePath: "tokens/tokens.json",
      path: "base",
      value: 12,
    }],
  };
  const after = await prepareOperationBatch(before, batch);
  const lib = after.snapshot.entries["tokens/tokens.json"];
  const base = lib.sets.find((s) => s.name === "radius/md")
    ?.tokens.find((t) => t.id === "tok_radius_md_base");
  assert.equal(base.value, 12);
  // Other cells unchanged
  const surface = lib.sets.find((s) => s.name === "color/light")
    ?.tokens.find((t) => t.name === "surface");
  assert.equal(surface.value, "#ffffff");
});

test("DSP-018-B: alias edit preserves expression and source chain", async () => {
  const before = await snapshot();
  // The fixture has an alias: radius.alias = "{base}" in set alias/demo.
  const libBefore = before.entries["tokens/tokens.json"];
  const aliasBefore = libBefore.sets.find((s) => s.id === "tset_alias_demo")
    ?.tokens.find((t) => t.id === "tok_alias_demo_radius");
  assert.equal(aliasBefore.value, "{base}");

  // Change the shared target: base goes from 8 to 16.
  const batchBase = {
    baseRevision: before.revision,
    batchId: "dsp018b-base-1",
    operations: [{
      type: "set-token-value",
      filePath: "tokens/tokens.json",
      path: "base",
      value: 16,
    }],
  };
  const afterBase = await prepareOperationBatch(before, batchBase);
  const libAfter = afterBase.snapshot.entries["tokens/tokens.json"];
  const base = libAfter.sets.find((s) => s.id === "tset_radius_md")
    ?.tokens.find((t) => t.id === "tok_radius_md_base");
  assert.equal(base.value, 16);
  // The alias expression is preserved (still references base, not 16).
  const alias = libAfter.sets.find((s) => s.id === "tset_alias_demo")
    ?.tokens.find((t) => t.id === "tok_alias_demo_radius");
  assert.equal(alias.value, "{base}");
});



test("DSP-018-D: tokenId disambiguates same-name tokens across sets", async () => {
  const before = await snapshot();
  // "surface" exists in color/light, color/dark and color/archived.
  const libBefore = before.entries["tokens/tokens.json"];
  const lightBefore = libBefore.sets.find((s) => s.id === "tset_color_light")
    ?.tokens.find((t) => t.id === "tok_color_light_surface");
  const darkBefore = libBefore.sets.find((s) => s.id === "tset_color_dark")
    ?.tokens.find((t) => t.id === "tok_color_dark_surface");
  assert.equal(lightBefore.value, "#ffffff");
  assert.equal(darkBefore.value, "#1b1b1f");

  // A path-only write would hit the first "surface" (color/light); the
  // tokenId must steer the Cell write to the color/dark definition.
  const batch = {
    baseRevision: before.revision,
    batchId: "dsp018d-dark-surface-1",
    operations: [{
      type: "set-token-value",
      filePath: "tokens/tokens.json",
      path: "surface",
      tokenId: "tok_color_dark_surface",
      value: "#202024",
    }],
  };
  const after = await prepareOperationBatch(before, batch);
  const lib = after.snapshot.entries["tokens/tokens.json"];
  const light = lib.sets.find((s) => s.id === "tset_color_light")
    ?.tokens.find((t) => t.id === "tok_color_light_surface");
  const dark = lib.sets.find((s) => s.id === "tset_color_dark")
    ?.tokens.find((t) => t.id === "tok_color_dark_surface");
  assert.equal(dark.value, "#202024");
  assert.equal(light.value, "#ffffff", "same-name sibling must stay untouched");
});
