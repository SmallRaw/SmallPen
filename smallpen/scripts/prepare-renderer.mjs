import { readFile } from "node:fs/promises";
import { copyRenderer } from "./copy-renderer.mjs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export async function prepareRenderer() {
  const source = resolve(
    root,
    "../frontend/resources/public/rendering-runtime",
  );
  const target = join(root, "packages/local-package/runtime");
  const [manifest, wasm, appWasm] = await Promise.all([
    readFile(join(source, "manifest.json"), "utf8").then(JSON.parse),
    readFile(join(source, "render-wasm.wasm")),
    readFile(resolve(root, "../frontend/resources/public/js/render-wasm.wasm")),
  ]);
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  if (manifest.kernelHash !== hash(wasm) || hash(wasm) !== hash(appWasm))
    throw new Error(
      "CLI and App must package the same rendering kernel; rebuild the frontend bundle",
    );
  try {
    const installed = JSON.parse(
      await readFile(join(target, "manifest.json"), "utf8"),
    );
    if (
      JSON.stringify(installed) === JSON.stringify(manifest) &&
      hash(await readFile(join(target, "renderer.mjs"))) ===
        manifest.rendererHash &&
      hash(await readFile(join(target, "render-wasm.js"))) ===
        manifest.wrapperHash &&
      hash(await readFile(join(target, "render-wasm.wasm"))) ===
        manifest.kernelHash
    )
      return target;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await copyRenderer(source, target);
  return target;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await prepareRenderer();
