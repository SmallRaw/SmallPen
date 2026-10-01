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

// Reads the canvas size from the RIFF header without decoding, so callers can
// apply size limits before libwebp allocates pixels. Returns undefined when
// the header is not recognized (the decoder then reports the error).
export function webpDimensions(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const tag = (offset) => String.fromCharCode(...view.subarray(offset, offset + 4));
  if (view.length < 30 || tag(0) !== "RIFF" || tag(8) !== "WEBP") {
    return undefined;
  }
  const chunk = tag(12);
  if (chunk === "VP8 ") {
    return {
      height: (view[28] | (view[29] << 8)) & 0x3fff,
      width: (view[26] | (view[27] << 8)) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    const bits = view[21] | (view[22] << 8) | (view[23] << 16) | (view[24] << 24);
    return {
      height: ((bits >>> 14) & 0x3fff) + 1,
      width: (bits & 0x3fff) + 1,
    };
  }
  if (chunk === "VP8X") {
    return {
      height: (view[27] | (view[28] << 8) | (view[29] << 16)) + 1,
      width: (view[24] | (view[25] << 8) | (view[26] << 16)) + 1,
    };
  }
  return undefined;
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
