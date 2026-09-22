// DSE delivery entry: serve the user's actual Design System package with the
// freshly built frontend and keep running, so the generated System Sheet can
// be opened for review. The package is served IN PLACE — no copy, no rewrite
// (originalHash is printed before serving so the reviewer can re-check it).
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { serveLocalPackage } from "@smallpen/background";
import { servePenpotFrontend } from "@smallpen/web";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const repositoryRoot = join(root, "..");
const frontendRoot = join(repositoryRoot, "frontend", "resources", "public");
const packagePath = process.argv[2] ?? "/private/tmp/smallpen-live-demo/design-system.smallpen";
const port = Number(process.argv[3] ?? 3449);

async function hashTree(dirPath) {
  const hash = createHash("sha256");
  const files = [];
  async function walk(current) {
    for (const item of await readdir(current, { withFileTypes: true })) {
      const full = join(current, item.name);
      if (item.isDirectory()) await walk(full);
      else files.push(full);
    }
  }
  await walk(dirPath);
  files.sort();
  for (const file of files) {
    hash.update(file.slice(dirPath.length));
    hash.update(await readFile(file));
  }
  return hash.digest("hex");
}

const originalHash = await hashTree(packagePath);
const bg = await serveLocalPackage({ packagePath, port });
const web = await servePenpotFrontend({ backendUrl: bg.url, frontendRoot, port: port + 1 });
const snapshot = await (await fetch(`${bg.url}/v1/workspace`)).json();
const fileId = snapshot.runtime?.file;

console.log("DSE delivery server");
console.log("  package:", packagePath);
console.log("  originalHash:", originalHash);
console.log("  packageRevision:", snapshot.revision);
console.log("  open:", `${web.url}/#/design-system?file-id=${fileId}`);
