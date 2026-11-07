import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// The App reads its capability list from a file generated from core; a
// stale file would make the App refuse to open a package.
test("the App's capability file is generated from core and current", () => {
  const script = new URL("../scripts/build-web-capabilities.mjs", import.meta.url).pathname;
  const result = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
