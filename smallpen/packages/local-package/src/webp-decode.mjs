import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { SmallPenError } from "@smallpen/core";

// WebP static decoding via Google's libwebp compiled to WebAssembly
// (@jsquash/webp, BSD-3). The emscripten codec is pre-loaded with its .wasm
// bytes read from disk so decoding also works in the Node CLI (SP-031).
const here = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

let decoderModule;
let decoderInitPromise;

async function loadDecoder() {
  if (decoderModule) return decoderModule;
  decoderInitPromise ??= (async () => {
    const { default: webpDec } = await import(
      "@jsquash/webp/codec/dec/webp_dec.js"
    );
    // Resolve the wasm via Node module resolution (works in workspace and
    // packaged CLI layouts).
    const wasmPath = require_.resolve("@jsquash/webp/codec/dec/webp_dec.wasm");
    const wasmBinary = await readFile(wasmPath);
    decoderModule = await webpDec({ wasmBinary, noInitialRun: true });
    return decoderModule;
  })();
  return decoderInitPromise;
}

export async function initWebpDecoder() {
  await loadDecoder();
}

// Synchronous decode of a complete WebP image to RGBA pixels. Requires a
// prior initWebpDecoder(); the renderer initializes it once per projection.
export function decodeWebpSync(bytes, diagnostics, path) {
  let module;
  try {
    module = decoderModule;
  } catch {
    module = undefined;
  }
  if (!module) {
    throw new SmallPenError(
      "media_decode_failed",
      "WebP decoder is not initialized",
      { path },
    );
  }
  try {
    const result = module.decode(
      bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    );
    if (!result) throw new Error("decoder returned no image");
    return {
      width: result.width,
      height: result.height,
      pixels: new Uint8ClampedArray(result.data),
    };
  } catch (error) {
    diagnostics?.push({
      code: "media_decode_failed",
      message: `Renderer could not decode WebP image: ${
        error instanceof Error ? error.message : String(error)
      }`,
      path,
    });
    return undefined;
  }
}
