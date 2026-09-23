import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  validateRelease,
  verifyManifest,
  publicationAction,
} from "../scripts/release.mjs";

test("release inputs reject shell syntax and mismatched channels", () => {
  assert.doesNotThrow(() => validateRelease("1.2.3-alpha.1", "alpha"));
  assert.doesNotThrow(() => validateRelease("1.2.3", "latest"));
  for (const [version, channel] of [
    ["$(id)", "alpha"],
    ["01.2.3", "latest"],
    ["1.2.3-alpha.1", "latest"],
    ["1.2.3", "alpha"],
    ["1.2.3-beta.1", "alpha"],
  ]) {
    assert.throws(() => validateRelease(version, channel));
  }
});

test("catalog CI test does not import from a developer's absolute file URL", async () => {
  const source = await readFile(
    new URL("./design-system-catalog.test.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /from\s+["']file:\/\//);
});

test("publication retries require identical tarball integrity", () => {
  assert.equal(publicationAction(undefined, "sha512-good"), "publish");
  assert.equal(
    publicationAction({ dist: { integrity: "sha512-good" } }, "sha512-good"),
    "existing",
  );
  assert.throws(() =>
    publicationAction({ dist: { integrity: "sha512-other" } }, "sha512-good"),
  );
});

test("release verification rejects wrong source, missing packages and path traversal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-release-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "artifact"));
  const dir = join(root, "artifact");
  const manifest = {
    version: "1.0.0-alpha.1",
    channel: "alpha",
    commit: "a".repeat(40),
    packages: [],
  };
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(verifyManifest(dir, "b".repeat(40)), /commit/);
  await assert.rejects(verifyManifest(dir, manifest.commit), /packages/);
  manifest.packages = [{ name: "@smallpen/core", filename: "../escape.tgz" }];
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(verifyManifest(dir, manifest.commit));
});

test("committed lock includes every declared workspace dependency", async () => {
  const root = new URL("../", import.meta.url);
  const lock = JSON.parse(await readFile(new URL("package-lock.json", root)));
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path.startsWith("apps/") && !path.startsWith("packages/")) continue;
    const pkg = JSON.parse(
      await readFile(new URL(`${path}/package.json`, root)),
    );
    assert.deepEqual(entry.dependencies, pkg.dependencies, path);
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      assert.ok(lock.packages[`node_modules/${dep}`], `${path}: ${dep}`);
    }
  }
});

test("desktop build tools have a complete separate registry lock", async () => {
  const root = new URL("../apps/desktop/tools/", import.meta.url);
  const pkg = JSON.parse(await readFile(new URL("package.json", root)));
  const lock = JSON.parse(await readFile(new URL("package-lock.json", root)));
  assert.equal(lock.lockfileVersion, 3);
  assert.deepEqual(lock.packages[""].dependencies, pkg.dependencies);
  for (const [name, version] of Object.entries(pkg.dependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+$/);
    assert.equal(lock.packages[`node_modules/${name}`].version, version);
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    assert.equal(
      new URL(entry.resolved).origin,
      "https://registry.npmjs.org",
      path,
    );
    assert.match(entry.integrity, /^sha512-/, path);
  }
});

test("artifact verification accepts intact files and rejects a modified tarball", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-artifact-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packages = [];
  for (const [i, name] of [
    "@smallpen/core",
    "@smallpen/local-package",
    "@smallpen/cli",
    "smallpen",
  ].entries()) {
    const filename = `package-${i}.tgz`;
    const bytes = `test artifact ${i}`;
    await writeFile(join(root, filename), bytes);
    packages.push({
      name,
      version: "1.0.0",
      filename,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    });
  }
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      version: "1.0.0",
      channel: "latest",
      commit: "a".repeat(40),
      packages,
    }),
  );
  await verifyManifest(root, "a".repeat(40));
  await writeFile(join(root, packages[0].filename), "changed");
  await assert.rejects(verifyManifest(root, "a".repeat(40)), /integrity/);
});

test("prepare keeps every workspace version and lock entry synchronized", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-version-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = new URL("../", import.meta.url);
  const lock = JSON.parse(await readFile(new URL("package-lock.json", source)));
  await cp(
    new URL("package-lock.json", source),
    join(root, "package-lock.json"),
  );
  for (const path of Object.keys(lock.packages).filter(
    (path) => !path || /^(apps|packages)\//.test(path),
  )) {
    await mkdir(join(root, path), { recursive: true });
    await cp(
      new URL(`${path ? `${path}/` : ""}package.json`, source),
      join(root, path, "package.json"),
    );
  }
  await mkdir(join(root, "scripts"));
  await cp(
    new URL("scripts/release.mjs", source),
    join(root, "scripts/release.mjs"),
  );
  const result = spawnSync(
    process.execPath,
    [join(root, "scripts/release.mjs"), "prepare", "2.3.4-alpha.5", "alpha"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const updated = JSON.parse(await readFile(join(root, "package-lock.json")));
  for (const [path, entry] of Object.entries(updated.packages)) {
    if (path.startsWith("node_modules/")) continue;
    const pkg = JSON.parse(await readFile(join(root, path, "package.json")));
    assert.equal(pkg.version, "2.3.4-alpha.5");
    assert.equal(entry.version, pkg.version);
    assert.deepEqual(entry.dependencies, pkg.dependencies);
    for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
      if (name.startsWith("@smallpen/")) assert.equal(version, pkg.version);
    }
  }
});
