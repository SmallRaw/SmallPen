import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  validateRelease,
  verifyManifest,
  publicationAction,
  readRelease,
} from "../scripts/release.mjs";

test("publishing does not query registry visibility or tags after submission", async () => {
  const source = await readFile(
    new URL("../scripts/release.mjs", import.meta.url),
    "utf8",
  );
  const body = source.slice(
    source.indexOf("async function publish("),
    source.indexOf("async function main("),
  );
  const submissions = body.slice(body.indexOf("for (let i = 0;"));
  assert.ok(submissions.includes('run("npm", ['));
  assert.doesNotMatch(
    submissions,
    /await|fetch\(|published\(|waitForPublication|dist-tags/,
  );
  assert.doesNotMatch(
    source,
    /waitForPublication|publishedTags|node:timers\/promises/,
  );
});

test("publish submits every missing package without waiting and propagates npm errors", async () => {
  const source = await readFile(
    new URL("../scripts/release.mjs", import.meta.url),
    "utf8",
  );
  const body = source.slice(
    source.indexOf("async function publish("),
    source.indexOf("async function main("),
  );
  const packages = ["core", "local-package", "cli", "smallpen"].map((name) => ({
    name,
    version: "0.1.0-alpha.2",
    integrity: "same",
    filename: `${name}.tgz`,
  }));
  for (const failAt of [undefined, "cli.tgz"]) {
    const submitted = [];
    const publish = runInNewContext(`${body}; publish`, {
      assert,
      join,
      publicationAction,
      process: { env: { GITHUB_ACTIONS: "true" } },
      registry: "https://registry.npmjs.org",
      console: { log() {} },
      verifyManifest: async () => ({ packages, channel: "alpha" }),
      published: async (name) => {
        assert.equal(
          submitted.length,
          0,
          "registry reads must finish before submission",
        );
        return name === "core" ? { dist: { integrity: "same" } } : undefined;
      },
      run: (_command, args) => {
        if (args[0] === "--version") return "11.5.1";
        submitted.push(args[1]);
        if (args[1] === failAt) throw new Error("npm publish failed");
      },
    });
    if (failAt)
      await assert.rejects(publish(".", "commit"), /npm publish failed/);
    else await publish(".", "commit");
    assert.deepEqual(
      submitted,
      failAt
        ? ["local-package.tgz", "cli.tgz"]
        : ["local-package.tgz", "cli.tgz", "smallpen.tgz"],
    );
  }
});

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
  assert.deepEqual(await readRelease(root), {
    version: "2.3.4-alpha.5",
    channel: "alpha",
  });
  const corePath = join(root, "packages/core/package.json");
  const core = JSON.parse(await readFile(corePath));
  await writeFile(corePath, JSON.stringify({ ...core, version: "9.0.0" }));
  await assert.rejects(readRelease(root), /version mismatch/);
  await writeFile(corePath, JSON.stringify(core));
  updated.packages["packages/core"].version = "9.0.0";
  await writeFile(join(root, "package-lock.json"), JSON.stringify(updated));
  await assert.rejects(readRelease(root), /version mismatch/);
  for (const [version, channel] of [
    ["2.3.4-beta.1", "beta"],
    ["2.3.4-rc.1", "rc"],
    ["2.3.4", "latest"],
  ]) {
    const prepared = spawnSync(
      process.execPath,
      [join(root, "scripts/release.mjs"), "prepare", version, channel],
      { encoding: "utf8" },
    );
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.deepEqual(await readRelease(root), { version, channel });
  }
  const cliPath = join(root, "apps/cli/package.json");
  const cli = JSON.parse(await readFile(cliPath));
  cli.dependencies["@smallpen/core"] = "9.0.0";
  await writeFile(cliPath, JSON.stringify(cli));
  await assert.rejects(readRelease(root), /lock dependencies mismatch/);
  const changedLock = JSON.parse(
    await readFile(join(root, "package-lock.json")),
  );
  changedLock.packages["apps/cli"].dependencies = cli.dependencies;
  await writeFile(join(root, "package-lock.json"), JSON.stringify(changedLock));
  await assert.rejects(readRelease(root), /version mismatch/);
});

test("CI reads the committed version without dispatch version overrides", async () => {
  const release = await readRelease();
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url)),
  );
  assert.equal(release.version, pkg.version);
  validateRelease(release.version, release.channel);
  const workflow = await readFile(
    new URL("../../.github/workflows/smallpen.yml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(workflow, /inputs\.(version|channel)/);
  assert.match(workflow, /release\.mjs info/);
  assert.match(workflow, /workflow_dispatch: \{\}/);
  assert.doesNotMatch(workflow, /inputs[.:]/);
  assert.match(workflow, /needs: \[test, cli, desktop\]/);
});
