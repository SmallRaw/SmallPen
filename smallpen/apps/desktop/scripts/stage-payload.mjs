import { access, cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { copyRuntimeDependencies } from "../../../scripts/copy-runtime-dependencies.mjs";

export async function stagePayload(smallpenRoot, resources, frontendRoot) {
  for (const required of ["index.html", "js/main.js", "js/main-workspace.js"]) {
    await access(join(frontendRoot, required));
  }
  const appRoot = join(resources, "app");
  for (const [name, relative, children] of [
    ["background", "apps/background", ["package.json", "src"]],
    ["web", "apps/web", ["package.json", "src"]],
    ["desktop", "apps/desktop", ["package.json", "bin", "src"]],
    ["core", "packages/core", ["package.json", "src"]],
    [
      "local-package",
      "packages/local-package",
      ["package.json", "src", "assets"],
    ],
    ["penpot-adapter", "packages/penpot-adapter", ["package.json", "src"]],
  ]) {
    const target = join(appRoot, "node_modules", "@smallpen", name);
    await mkdir(target, { recursive: true });
    for (const child of children)
      await cp(join(smallpenRoot, relative, child), join(target, child), {
        recursive: true,
      });
  }
  // Keep the application launch path stable without junctions in Windows ZIPs.
  await cp(
    join(appRoot, "node_modules", "@smallpen", "desktop"),
    join(appRoot, "apps", "desktop"),
    { recursive: true },
  );
  await copyRuntimeDependencies(smallpenRoot, appRoot);
  await cp(frontendRoot, join(resources, "frontend", "resources", "public"), {
    recursive: true,
  });
}
