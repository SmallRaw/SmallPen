import { promisify } from "node:util";
import {
  brotliCompress,
  constants,
  createBrotliCompress,
  createGzip,
  gzip,
} from "node:zlib";

// Bodies below this size are sent as they are: the headers cost more.
export const MIN_COMPRESSED_BYTES = 1024;

// Brotli at a low quality compresses JSON about as well as gzip -9 at a
// fraction of the time; quality 11 would cost seconds on a large workspace.
const BROTLI_OPTIONS = {
  params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
};
const GZIP_OPTIONS = { level: 6 };

// The encoding to answer with: br, then gzip, when the client accepts it
// (q=0 refuses), otherwise null for an identity body.
export function negotiateEncoding(header) {
  const accepted = new Map();
  for (const part of String(header ?? "").split(",")) {
    const [name, ...parameters] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    const quality = parameters
      .map((parameter) => parameter.trim())
      .find((parameter) => parameter.startsWith("q="));
    accepted.set(name, quality ? Number(quality.slice(2)) : 1);
  }
  for (const encoding of ["br", "gzip"]) {
    const quality = accepted.get(encoding) ?? accepted.get("*");
    if (quality > 0) return encoding;
  }
  return null;
}

export function createCompressor(encoding) {
  return encoding === "br"
    ? createBrotliCompress(BROTLI_OPTIONS)
    : createGzip(GZIP_OPTIONS);
}

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

export function compressBuffer(body, encoding) {
  return encoding === "br"
    ? brotliAsync(body, BROTLI_OPTIONS)
    : gzipAsync(body, GZIP_OPTIONS);
}
