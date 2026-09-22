// DSP-001-C: supported token type inventory, negative controls, and the
// baseline invariant snapshot for the design-system fixture.
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
  SMALLPEN_FORMAT_CAPABILITIES,
} from "@smallpen/core";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "design-system.smallpen");
const invalidDir = join(here, "fixtures", "expected-invalid");
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

async function invalidValues(name) {
  const dir = join(invalidDir, `${name}.smallpen`);
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  const { entries } = listPackageEntries(manifest);
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of entries) {
    values.set(entry, JSON.parse(await readFile(join(dir, entry), "utf8")));
  }
  return loadPackageFromValues(`memory://invalid-${name}.smallpen`, values);
}

test("every canonical token type is inventoried in the baseline", async () => {
  const baseline = JSON.parse(
    await readFile(join(here, "fixtures", "design-system-baseline.json"), "utf8"),
  );
  const supported = SMALLPEN_FORMAT_CAPABILITIES.canonicalPackage.tokenTypes;
  assert.deepEqual(baseline.supportedTokenTypes, supported);
  // Unknown types are not silently supported.
  assert.ok(!supported.includes("quantum"));
});

test("alias positive control resolves through base without rewriting the source", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://design-system.smallpen",
    await fixtureValues(),
  );
  const alias = resolveEffectiveToken(snapshot, {
    assetId: "tok_alias_demo_radius",
    packageId: "pkg_design_system",
  });
  assert.equal(alias.value, 8);
  // The alias token keeps its expression; resolution never overwrites it.
  const library = (await fixtureValues()).get("tokens/tokens.json");
  const aliasToken = library.sets
    .find((set) => set.id === "tset_alias_demo")
    .tokens.find((token) => token.id === "tok_alias_demo_radius");
  assert.equal(aliasToken.value, "{base}");
});

test("negative controls are independently rejected with typed errors", async () => {
  const expectations = {
    "unknown-type": "unsupported_token_type",
    "duplicate-id": "duplicate_token_id",
    "missing-alias": "missing_token_alias",
    "alias-cycle": "token_alias_cycle",
  };
  for (const [name, expectedCode] of Object.entries(expectations)) {
    await assert.rejects(
      invalidValues(name),
      (error) => error?.code === expectedCode,
      `${name} must fail with ${expectedCode}`,
    );
  }
});

test("CLI validate rejects every negative fixture with its typed error", async () => {
  const expectations = {
    "unknown-type": "unsupported_token_type",
    "duplicate-id": "duplicate_token_id",
    "missing-alias": "missing_token_alias",
    "alias-cycle": "token_alias_cycle",
  };
  for (const name of Object.keys(expectations)) {
    const target = join(invalidDir, `${name}.smallpen`);
    await assert.rejects(
      execFileAsync(process.execPath, [cli, "validate", target, "--json"], {
        cwd: join(here, ".."),
      }),
      (error) => {
        const payload = JSON.parse(error?.stdout ?? "{}");
        return error.code === 1 && payload.error?.code === expectations[name];
      },
      `${name} must fail CLI validate with ${expectations[name]}`,
    );
  }
});

test("baseline invariant snapshot pins tree, revision and active combination", async () => {
  const baseline = JSON.parse(
    await readFile(join(here, "fixtures", "design-system-baseline.json"), "utf8"),
  );
  const { stdout } = await execFileAsync(
    process.execPath,
    [cli, "validate", fixture, "--json"],
    { cwd: join(here, "..") },
  );
  const validated = JSON.parse(stdout);
  assert.equal(validated.status, baseline.status);
  assert.equal(validated.revision, baseline.revision);
  const library = (await fixtureValues()).get("tokens/tokens.json");
  const active = library.activeThemeIds.map((id) => {
    const theme = library.themes.find((candidate) => candidate.id === id);
    return `${theme.group}/${theme.name}`;
  });
  assert.deepEqual(active.sort(), [...baseline.activeCombination].sort());
});
