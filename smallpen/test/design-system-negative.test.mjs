// DSP-001-C: supported token type inventory, negative controls, and the
// baseline invariant snapshot for the design-system fixture.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { resolveEffectiveToken, SMALLPEN_FORMAT_CAPABILITIES } from "@smallpen/core";
import { openPackage } from "@smallpen/local-package";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "design-system.smallpen");
const invalidDir = join(here, "fixtures", "expected-invalid");
const cli = join(here, "..", "apps", "cli", "bin", "smallpen.mjs");

const expectations = {
  "unknown-type": "invalid_token_name",
  "duplicate-id": "duplicate_token",
  "missing-alias": "token_alias_missing",
  "alias-cycle": "token_alias_cycle",
};

function tokenId(snapshot, path) {
  for (const [id, token] of snapshot.domain.tokens) if (token.path === path) return id;
  throw new Error(`No Token ${path}`);
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
  const snapshot = await openPackage(fixture);
  const alias = resolveEffectiveToken(snapshot, {
    assetId: tokenId(snapshot, "radius-alias"),
    packageId: snapshot.manifest.packageId,
  }, { traceSources: true });
  assert.equal(alias.value, 8);
  assert.equal(alias.aliasChain.length, 2);
  assert.equal(alias.aliasChain.at(-1).path, "radius-base");
  // The alias keeps its expression in tokens.css; resolution never rewrites it.
  const css = await readFile(join(fixture, "tokens.css"), "utf8");
  assert.match(css, /--radius-alias: var\(--radius-base\);/);
});

test("negative controls are independently rejected with typed errors", async () => {
  for (const [name, expectedCode] of Object.entries(expectations)) {
    await assert.rejects(
      openPackage(join(invalidDir, `${name}.smallpen`)),
      (error) => error?.code === expectedCode && error.details.issues[0].file === "tokens.css",
      `${name} must fail with ${expectedCode}`,
    );
  }
});

test("CLI view and check reject every negative fixture with its typed error", async () => {
  for (const [name, code] of Object.entries(expectations)) {
    const target = join(invalidDir, `${name}.smallpen`);
    await assert.rejects(
      execFileAsync(process.execPath, [cli, "view", target, "--json"], { cwd: join(here, "..") }),
      (error) => error.code === 1 && JSON.parse(error.stdout ?? "{}").error?.code === code,
      `${name} must fail CLI view with ${code}`,
    );
    await assert.rejects(
      execFileAsync(process.execPath, [cli, "check", target, "--json"], { cwd: join(here, "..") }),
      (error) => error.code === 1 && JSON.parse(error.stdout).issues.some((issue) => issue.code === code),
      `${name} must fail CLI check with ${code}`,
    );
  }
});

test("baseline invariant snapshot pins status, revision and active combination", async () => {
  const baseline = JSON.parse(
    await readFile(join(here, "fixtures", "design-system-baseline.json"), "utf8"),
  );
  const { stdout } = await execFileAsync(
    process.execPath,
    [cli, "check", fixture, "--render", "--json"],
    { cwd: join(here, "..") },
  );
  const validated = JSON.parse(stdout);
  assert.equal(validated.render.status, baseline.status);
  assert.equal(validated.revision, baseline.revision);
  const snapshot = await openPackage(fixture);
  const library = snapshot.entries[snapshot.manifest.entries.tokens[0]];
  const active = library.defaultThemeIds.map((id) => {
    const theme = library.themes.find((candidate) => candidate.id === id);
    return `${theme.group}/${theme.name}`;
  });
  assert.deepEqual(active.sort(), [...baseline.activeCombination].sort());
});
