// DSP-001-A: base token + Light/Dark combination fixture for the design
// system workbench. Asserts each Cell's owner/set/path/raw/resolved value and
// the fixture's structural boundaries.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  listPackageEntries,
  loadPackageFromValues,
  resolveEffectiveToken,
} from "@smallpen/core";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "design-system.smallpen");
const repositoryRoot = join(here, "..", "..");
const cli = join(here, "..", "apps", "cli", "bin", "smallpen.mjs");

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

test("design-system fixture is a legal package with fixed readable ids", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [cli, "validate", fixture, "--json"],
    { cwd: join(here, "..") },
  );
  const validated = JSON.parse(stdout);
  assert.equal(validated.status, "valid");
  assert.equal(validated.packageId, "pkg_design_system");

  const snapshot = await loadPackageFromValues(
    "memory://design-system.smallpen",
    await fixtureValues(),
  );
  assert.equal(snapshot.manifest.packageId, "pkg_design_system");
  // Structural boundary: exactly one ordinary Screen, no system page.
  // (DSP-001-B later added the component set entry; asserted there.)
  assert.equal(snapshot.manifest.entries.screens.length, 1);
});

test("every Token Cell has the documented owner/set/path/raw value", async () => {
  const values = await fixtureValues();
  const library = values.get("tokens/tokens.json");
  const setByName = new Map(library.sets.map((set) => [set.name, set]));

  const cell = (setName, tokenName) => {
    const set = setByName.get(setName);
    assert.ok(set, `set ${setName} exists`);
    const token = set.tokens.find((candidate) => candidate.name === tokenName);
    assert.ok(token, `token ${tokenName} exists in ${setName}`);
    return {
      owner: "pkg_design_system",
      raw: token.value,
      set: set.name,
      setId: set.id,
      tokenId: token.id,
      type: token.type,
    };
  };

  // base.radius.md = 8 (Domain radius, Variant md, Row base).
  assert.deepEqual(cell("radius/md", "base"), {
    owner: "pkg_design_system",
    raw: 8,
    set: "radius/md",
    setId: "tset_radius_md",
    tokenId: "tok_radius_md_base",
    type: "border-radius",
  });
  // Light/Dark color cells with per-variant values.
  assert.equal(cell("color/light", "surface").raw, "#ffffff");
  assert.equal(cell("color/dark", "surface").raw, "#1b1b1f");
  assert.equal(cell("color/light", "primary").raw, "#6750a4");
  assert.equal(cell("color/dark", "primary").raw, "#d0bcff");
  // Spacing rows.
  assert.equal(cell("spacing/md", "space.small").raw, 4);
  assert.equal(cell("spacing/md", "space.medium").raw, 8);
  assert.equal(cell("spacing/md", "space.large").raw, 16);
  // Typography rows are composite values.
  const heading = cell("typography/md", "heading");
  assert.equal(heading.type, "typography");
  assert.equal(heading.raw.fontSize, 28);
  const body = cell("typography/md", "body");
  assert.equal(body.raw.fontSize, 16);

  // Paired Themes activate one set per Domain.
  const themeByName = new Map(
    library.themes.map((theme) => [`${theme.group}/${theme.name}`, theme]),
  );
  assert.deepEqual(themeByName.get("color/Light").setIds, ["tset_color_light"]);
  assert.deepEqual(themeByName.get("color/Dark").setIds, ["tset_color_dark"]);
  assert.deepEqual(themeByName.get("radius/md").setIds, ["tset_radius_md"]);
  // Current Combination: Light for colors, md elsewhere, plus the alias
  // demo domain added by DSP-001-C.
  assert.deepEqual(library.activeThemeIds, [
    "theme_radius_md",
    "theme_color_light",
    "theme_spacing_md",
    "theme_typography_md",
    "theme_alias_demo",
  ]);
});

test("resolved values follow the active Light combination", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://design-system.smallpen",
    await fixtureValues(),
  );
  const light = resolveEffectiveToken(snapshot, {
    assetId: "tok_color_light_surface",
    packageId: "pkg_design_system",
  });
  assert.equal(light.value, "#ffffff");

  const radius = resolveEffectiveToken(snapshot, {
    assetId: "tok_radius_md_base",
    packageId: "pkg_design_system",
  });
  assert.equal(radius.value, 8);
});

test("fixture screen content is ordinary design data, not a system sheet", async () => {
  const screen = JSON.parse(
    await readFile(join(fixture, "screens", "screen.json"), "utf8"),
  );
  const presentation = screen.presentations[0];
  assert.equal(presentation.nodes.node_canvas.name, "Fixture Canvas");
  // No generated workbench decorations are stored: only fixture-authored
  // nodes (swatches from DSP-001-A, instances + negative control from B).
  assert.deepEqual(presentation.nodes.node_canvas.children, [
    "node_swatch_primary",
    "node_swatch_radius",
    "node_card_instance_idle",
    "node_card_instance_pressed",
    "node_card_hardcoded",
  ]);
});
