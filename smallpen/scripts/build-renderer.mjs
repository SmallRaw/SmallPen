import { createRequire } from "node:module";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { copyRenderer } from "./copy-renderer.mjs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frontend = resolve(root, "../frontend");
const require = createRequire(join(frontend, "package.json"));
const { build } = require("esbuild");
const output = join(frontend, "resources/public/rendering-runtime");
await mkdir(dirname(output), { recursive: true });
const candidate = await mkdtemp(join(dirname(output), ".rendering-runtime-"));
await build({
  entryPoints: [join(frontend, "target/smallpen-render/renderer.js")],
  outfile: join(candidate, "renderer.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
});
for (const name of ["render-wasm.js", "render-wasm.wasm"])
  await cp(join(frontend, "resources/public/js", name), join(candidate, name));
await mkdir(join(candidate, "fonts"), { recursive: true });
for (const name of await readdir(join(frontend, "resources/public/fonts")))
  if (/^sourcesanspro-.*\.ttf$/.test(name))
    await cp(
      join(frontend, "resources/public/fonts", name),
      join(candidate, "fonts", name),
    );
await cp(
  join(root, "packages/local-package/assets/fonts/SourceSansPro-OFL.txt"),
  join(candidate, "fonts/OFL.txt"),
);
const wasm = await readFile(join(candidate, "render-wasm.wasm"));
await writeFile(
  join(candidate, "manifest.json"),
  JSON.stringify(
    {
      renderer: "app-wasm",
      kernelHash: createHash("sha256").update(wasm).digest("hex"),
      kernelBytes: wasm.byteLength,
      rendererHash: createHash("sha256")
        .update(await readFile(join(candidate, "renderer.mjs")))
        .digest("hex"),
      wrapperHash: createHash("sha256")
        .update(await readFile(join(candidate, "render-wasm.js")))
        .digest("hex"),
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ output, kernelBytes: wasm.byteLength }));
await copyRenderer(candidate, output);
await copyRenderer(candidate, join(root, "packages/local-package/runtime"));
await rm(candidate, { recursive: true, force: true });
