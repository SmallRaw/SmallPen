import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

// Keep both distributables on the same complete, locked runtime payload.
export async function copyRuntimeDependencies(sourceRoot, targetRoot) {
  for (const name of ["opentype.js", "@jsquash/webp", "wasm-feature-detect"]) {
    const target = join(targetRoot, "node_modules", name);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(sourceRoot, "node_modules", name), target, {
      recursive: true,
    });
  }
}
