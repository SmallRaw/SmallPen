// DSP-003-A/B/C: workbench combination enumeration, pure preview evaluation
// and explicit edit targets over the design-system fixture.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildWorkbenchSheet,
  createWorkbenchPreview,
  enumerateWorkbenchCombinations,
  listPackageEntries,
  loadPackageFromValues,
  resolveWorkbenchEditTargets,
  validateWorkbenchCombination,
} from "@smallpen/core";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "design-system.smallpen");

async function fixtureSnapshot() {
  const manifest = JSON.parse(
    await readFile(join(fixture, "manifest.json"), "utf8"),
  );
  const { entries } = listPackageEntries(manifest);
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of entries) {
    values.set(entry, JSON.parse(await readFile(join(fixture, entry), "utf8")));
  }
  return loadPackageFromValues("memory://design-system.smallpen", values);
}

const LIGHT_COMBINATION = [
  { domainId: "domain_alias", themeId: "theme_alias_demo" },
  { domainId: "domain_color", themeId: "theme_color_light" },
  { domainId: "domain_radius", themeId: "theme_radius_md" },
  { domainId: "domain_spacing", themeId: "theme_spacing_md" },
  { domainId: "domain_typography", themeId: "theme_typography_md" },
];

test("DSP-003-A: enumerates domains and variants from Paired Themes by stable id", async () => {
  const snapshot = await fixtureSnapshot();
  const enumeration = enumerateWorkbenchCombinations(snapshot);
  assert.equal(enumeration.diagnostics.length, 0);
  const domains = enumeration.domains.map((domain) => domain.domain);
  assert.deepEqual(domains, ["alias", "color", "radius", "spacing", "typography"]);
  const color = enumeration.domains.find((domain) => domain.domain === "color");
  assert.equal(color.domainId, "domain_color");
  assert.equal(color.currentProjectThemeId, "theme_color_light");
  assert.deepEqual(
    color.variants.map((variant) => variant.themeId).sort(),
    ["theme_color_dark", "theme_color_light"],
  );
});

test("DSP-003-A: invalid combinations produce typed diagnostics", async () => {
  const snapshot = await fixtureSnapshot();
  const unknownTheme = validateWorkbenchCombination(snapshot, [
    { domainId: "domain_color", themeId: "theme_color_neon" },
  ]);
  assert.ok(
    unknownTheme.diagnostics.some(
      (entry) => entry.code === "combination_unknown_variant",
    ),
  );
  const unknownDomain = validateWorkbenchCombination(snapshot, [
    { domainId: "domain_nope", themeId: "theme_color_light" },
  ]);
  assert.ok(
    unknownDomain.diagnostics.some(
      (entry) => entry.code === "combination_unknown_domain",
    ),
  );
  const missing = validateWorkbenchCombination(snapshot, [
    { domainId: "domain_color", themeId: "theme_color_light" },
  ]);
  assert.ok(
    missing.diagnostics.some(
      (entry) => entry.code === "combination_missing_domain",
    ),
  );
  const duplicate = validateWorkbenchCombination(snapshot, [
    { domainId: "domain_color", themeId: "theme_color_light" },
    { domainId: "domain_color", themeId: "theme_color_dark" },
  ]);
  assert.ok(
    duplicate.diagnostics.some(
      (entry) => entry.code === "combination_duplicate_domain",
    ),
  );
});

test("DSP-003-B: preview resolves Dark without touching project combination", async () => {
  const snapshot = await fixtureSnapshot();
  const revisionBefore = snapshot.revision;
  const darkCombination = LIGHT_COMBINATION.map((selection) =>
    selection.domainId === "domain_color"
      ? { domainId: "domain_color", themeId: "theme_color_dark" }
      : selection,
  );
  const preview = await createWorkbenchPreview(snapshot, darkCombination);
  const surface = preview.tokens.find((row) => row.path === "surface");
  assert.equal(surface.resolved, "#1b1b1f");
  assert.equal(surface.alias, null);
  const radius = preview.tokens.find((row) => row.path === "base");
  assert.equal(radius.resolved, 8);
  // Pure: the source snapshot is untouched.
  assert.equal(snapshot.revision, revisionBefore);
  const libraryOnDisk = JSON.parse(
    await readFile(join(fixture, "tokens", "tokens.json"), "utf8"),
  );
  assert.equal(
    libraryOnDisk.activeThemeIds.includes("theme_color_dark"),
    false,
  );
});

test("DSP-003-B: alias row keeps its expression and resolves through the preview", async () => {
  const snapshot = await fixtureSnapshot();
  const preview = await createWorkbenchPreview(snapshot, LIGHT_COMBINATION);
  const aliasRow = preview.tokens.find((row) => row.path === "radius.alias");
  assert.equal(aliasRow.alias, "base");
  assert.equal(aliasRow.raw, "{base}");
  assert.equal(aliasRow.resolved, 8);
});

test("DSP-003-A: preview refuses invalid combinations with typed errors", async () => {
  const snapshot = await fixtureSnapshot();
  await assert.rejects(
    createWorkbenchPreview(snapshot, [
      { domainId: "domain_color", themeId: "theme_color_neon" },
    ]),
    (error) => error.code === "invalid_workbench_combination",
  );
});

test("DSP-003-C: plain cell offers exactly the cell target", async () => {
  const snapshot = await fixtureSnapshot();
  const preview = await createWorkbenchPreview(snapshot, LIGHT_COMBINATION);
  const { targets } = resolveWorkbenchEditTargets(
    preview.preview,
    LIGHT_COMBINATION,
    { ownerPackageId: "pkg_design_system", path: "base" },
  );
  assert.equal(targets.length, 1);
  assert.equal(targets[0].kind, "cell");
  assert.equal(targets[0].tokenId, "tok_radius_md_base");
  assert.equal(targets[0].readOnly, false);
});

test("DSP-003-C: alias value offers alias-expression and shared-cell targets", async () => {
  const snapshot = await fixtureSnapshot();
  const preview = await createWorkbenchPreview(snapshot, LIGHT_COMBINATION);
  const { targets } = resolveWorkbenchEditTargets(
    preview.preview,
    LIGHT_COMBINATION,
    { ownerPackageId: "pkg_design_system", path: "radius.alias" },
  );
  const kinds = targets.map((target) => target.kind).sort();
  assert.deepEqual(kinds, ["alias-expression", "cell", "shared-cell"]);
  const shared = targets.find((target) => target.kind === "shared-cell");
  assert.equal(shared.tokenId, "tok_radius_md_base");
  // Editing the alias must never overwrite the shared target value and vice
  // versa: both targets stay distinct token identities.
  const alias = targets.find((target) => target.kind === "alias-expression");
  assert.equal(alias.current, "{base}");
  assert.notEqual(alias.tokenId, shared.tokenId);
});

test("DSP-004-B: generated sheet has stable ids, real targets and flagged decorations", async () => {
  const snapshot = await fixtureSnapshot();
  const sheet = buildWorkbenchSheet(snapshot, {});
  // Deterministic: regenerating yields identical specimen identities.
  const again = buildWorkbenchSheet(snapshot, {});
  assert.deepEqual(sheet, again);
  assert.equal(sheet.kind, "system-sheet");
  assert.equal(sheet.regenerable, true);

  const tokenSpecimens = sheet.sections.flatMap((s) =>
    s.specimens.filter((sp) => sp.kind === "token"),
  );
  const componentSpecimens = sheet.sections.flatMap((s) =>
    s.specimens.filter((sp) => sp.kind === "component"),
  );
  // Every token specimen points at a real, qualified token cell.
  for (const sp of tokenSpecimens) {
    assert.equal(sp.kind, "token");
    assert.equal(sp.decoration, false);
    assert.equal(sp.target.kind, "token-cell");
    assert.ok(sp.target.tokenId);
    assert.match(sp.specimenId, /^dsp-specimen\/pkg_design_system\//);
  }
  // Radius target is the documented source cell.
  const radius = tokenSpecimens.find(
    (sp) => sp.target.qualifiedKey === "pkg_design_system/radius/md/base",
  );
  assert.equal(radius.target.tokenId, "tok_radius_md_base");

  // Component specimens reference the real variant definitions.
  for (const sp of componentSpecimens) {
    assert.equal(sp.target.kind, "component-definition");
    assert.ok(sp.target.variantId);
    assert.match(sp.specimenId, /^dsp-specimen\/component\/pkg_design_system\/cmp_card_set\//);
  }
  assert.ok(componentSpecimens.length >= 2, "both variants present");

  // Sections (headers/rulers) are generated decorations.
  for (const section of sheet.sections) {
    assert.equal(section.decoration, true);
  }
});
