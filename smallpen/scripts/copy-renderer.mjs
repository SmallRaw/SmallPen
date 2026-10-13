import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

// Readers must never import a partially copied JavaScript module or WASM file.
export async function copyRenderer(source, target) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === "manifest.json") continue;
    const destination = join(target, entry.name);
    if (entry.isDirectory())
      await copyRenderer(join(source, entry.name), destination);
    else
      await atomicWrite(destination, await readFile(join(source, entry.name)));
  }
  try {
    await atomicWrite(
      join(target, "manifest.json"),
      await readFile(join(source, "manifest.json")),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export async function atomicWrite(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
