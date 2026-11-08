import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The test runner owns this directory. Workers and CLI subprocesses inherit
// it, so regression tests never fill or modify the user's real history cache.
if (!process.env.SMALLPEN_HISTORY_CACHE_DIR) {
  const directory = mkdtempSync(join(tmpdir(), "smallpen-test-history-"));
  process.env.SMALLPEN_HISTORY_CACHE_DIR = directory;
  process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
}
if (!process.env.SMALLPEN_FONT_CACHE_DIR) {
  const directory = mkdtempSync(join(tmpdir(), "smallpen-test-fonts-"));
  process.env.SMALLPEN_FONT_CACHE_DIR = directory;
  process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
}

// Test fixtures are HTML packages; their former ids (recorded App sessions
// and many assertions name them) live in test/fixtures/model/*.identity.json.
// Seed them once per run so every read of a fixture yields those ids.
if (!process.env.SMALLPEN_TEST_FIXTURE_IDS) {
  process.env.SMALLPEN_TEST_FIXTURE_IDS = "1";
  const { readdirSync, readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const fixtures = fileURLToPath(new URL("../test/fixtures/", import.meta.url));
  const { writeIdentity, packageIdOf } = await import("../packages/local-package/src/html-store.mjs");
  for (const name of readdirSync(join(fixtures, "model"))) {
    if (!name.endsWith(".identity.json")) continue;
    const packagePath = join(fixtures, name.replace(/\.identity\.json$/, ".smallpen"));
    try {
      const index = readFileSync(join(packagePath, "index.html"));
      const rows = JSON.parse(readFileSync(join(fixtures, "model", name), "utf8"));
      await writeIdentity(packagePath, packageIdOf(new Map([["index.html", index]])), new Map(rows));
    } catch {
      // A fixture without an index.html is not an HTML package.
    }
  }
}
