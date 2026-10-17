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
