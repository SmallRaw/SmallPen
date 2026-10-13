import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareRenderer } from "./prepare-renderer.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = join(root, "test");
// Data and rendering regressions run in CI with one complete CLI workflow.
// Repeated CLI command matrices remain in npm test; product release jobs
// verify the actual installable packages.
const files = (await readdir(directory, { recursive: true }))
  .filter((file) => {
    const name = basename(file);
    return (
      name.endsWith(".test.mjs") &&
      (!name.startsWith("cli-") || name === "cli-workflow.test.mjs") &&
      name !== "release.test.mjs"
    );
  })
  .sort()
  .map((file) => join(directory, file));
if (!files.length) throw new Error("No CI regression tests found");
await prepareRenderer();
console.log(
  `CI: ${files.length} test files; npm test runs the full command matrix`,
);
const result = spawnSync(
  process.execPath,
  ["--test", "--test-concurrency=4", "--test-timeout=120000", ...files],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
