#!/usr/bin/env node
// Launch gate (SP-050): the CLI's module graph uses Node 24+ APIs; fail with a
// clear message before ESM instantiation instead of an opaque engine error.
const [major] = process.versions.node.split(".").map(Number);
if (!Number.isFinite(major) || major < 24) {
  process.stdout.write(
    `${JSON.stringify({
      error: {
        code: "unsupported_node_runtime",
        details: {
          found: process.versions.node,
          required: "Node.js 24 or newer on PATH",
        },
        message: `SmallPen CLI requires Node.js 24 or newer on PATH (found ${process.versions.node}). Upgrade Node and retry the same command.`,
      },
    }, null, 2)}\n`,
  );
  process.exit(1);
}
import("./smallpen.mjs").catch((error) => {
  process.stdout.write(
    `${JSON.stringify({
      error: {
        code: error instanceof Error && error.name === "SmallPenError" ? "smallpen_error" : "internal_error",
        message: error instanceof Error ? error.message : String(error),
      },
    }, null, 2)}\n`,
  );
  process.exit(1);
});
