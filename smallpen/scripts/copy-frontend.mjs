import { cp } from "node:fs/promises";
import { join } from "node:path";

// Both distributables ship the built frontend without its source maps: they
// are half of its text and only a debugger reads them. A local build keeps
// them in frontend/resources/public.
export async function copyFrontend(frontendRoot, targetRoot) {
  await cp(frontendRoot, join(targetRoot, "frontend", "resources", "public"), {
    recursive: true,
    dereference: true,
    filter: (source) => !source.endsWith(".map"),
  });
}
