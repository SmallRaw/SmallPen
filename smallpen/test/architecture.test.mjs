import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function moduleFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? moduleFiles(path) : [path];
    }),
  );
  return files.flat().filter((path) => path.endsWith(".mjs"));
}

test("the shared Core has no Node, CLI, Background, or Penpot dependencies", async () => {
  const files = await moduleFiles(join(root, "packages", "core", "src"));
  assert.ok(files.length > 0);

  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /(?:from|import\()\s*["']node:/);
    assert.doesNotMatch(source, /\.\.\/(?:adapters|background|bin|node)\//);
  }
});

test("CLI, Background, Web, and Desktop are separate executable entry points", async () => {
  const cliRoot = join(root, "apps", "cli");
  const backgroundRoot = join(root, "apps", "background");
  const webRoot = join(root, "apps", "web");
  const desktopRoot = join(root, "apps", "desktop");
  const cliManifest = JSON.parse(
    await readFile(join(cliRoot, "package.json"), "utf8"),
  );
  const backgroundManifest = JSON.parse(
    await readFile(join(backgroundRoot, "package.json"), "utf8"),
  );
  const webManifest = JSON.parse(
    await readFile(join(webRoot, "package.json"), "utf8"),
  );
  const desktopManifest = JSON.parse(
    await readFile(join(desktopRoot, "package.json"), "utf8"),
  );
  assert.equal(cliManifest.bin.smallpen, "./bin/smallpen-check.cjs");
  assert.equal(
    backgroundManifest.bin["smallpen-background"],
    "./bin/smallpen-background.mjs",
  );
  assert.equal(webManifest.bin["smallpen-web"], "./bin/smallpen-web.mjs");
  assert.equal(
    desktopManifest.bin["smallpen-desktop"],
    "./bin/smallpen-desktop.mjs",
  );
  assert.deepEqual(webManifest.dependencies ?? {}, {});

  const cli = await readFile(join(cliRoot, cliManifest.bin.smallpen), "utf8");
  assert.doesNotMatch(cli, /serveLocalPackage|background\/server/);
});
