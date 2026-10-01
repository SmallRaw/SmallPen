import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  canonicalJSON,
  listPackageEntries,
  loadPackageFromValues,
  sha256Hex,
  SmallPenError,
} from "@smallpen/core";

import { createLibraryFetch } from "./library-network.mjs";

const MAX_REMOTE_FILE_BYTES = 50 * 1024 * 1024;
const MAX_REMOTE_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_REMOTE_PACKAGE_BYTES = 200 * 1024 * 1024;
const REMOTE_REQUEST_TIMEOUT_MS = 30000;
const MAX_REMOTE_REDIRECTS = 5;
// Each entry and blob is one request: a manifest listing millions of tiny
// files must not turn one Library open into millions of downloads.
export const MAX_REMOTE_FILES = 10000;

export function defaultLibraryCacheRoot() {
  return join(homedir(), ".smallpen", "library-cache");
}

export function remoteManifestUrl(sourceUrl) {
  return manifestUrl(sourceUrl).href;
}

function manifestUrl(sourceUrl) {
  const parsed = new URL(sourceUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SmallPenError(
      "invalid_library_source",
      "Remote Library URL must use HTTP or HTTPS",
      { url: sourceUrl },
    );
  }
  parsed.hash = "";
  if (!parsed.pathname.endsWith("/manifest.json")) {
    parsed.pathname = `${parsed.pathname.replace(/\/?$/, "/")}manifest.json`;
  }
  return parsed;
}

function tooLarge(label, byteLength, url, limit) {
  return new SmallPenError(
    "remote_library_too_large",
    `${label} exceeds the remote Library file limit`,
    { byteLength, limit, url },
  );
}

// Reads the body as a stream and stops as soon as it passes the file limit,
// so an oversized or endless response is never buffered whole.
async function responseBytes(response, label, url, limit) {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new SmallPenError(
      "remote_library_unavailable",
      `${label} returned HTTP ${response.status}`,
      { status: response.status, url },
    );
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge(label, declared, url, limit);
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) {
      throw tooLarge(label, bytes.byteLength, url, limit);
    }
    return bytes;
  }
  const chunks = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > limit) {
      await reader.cancel().catch(() => {});
      throw tooLarge(label, byteLength, url, limit);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// Every request has a total time budget (headers and body) and follows
// redirects only within the Library's origin: a Library URL must not be able
// to steer Background requests to another host.
async function fetchBytes(
  { fetchImpl, timeoutMs },
  url,
  label,
  limit = MAX_REMOTE_FILE_BYTES,
) {
  const signal = AbortSignal.timeout(timeoutMs);
  const origin = new URL(url).origin;
  let current = url;
  try {
    for (let redirects = 0; ; redirects += 1) {
      const response = await fetchImpl(current, { redirect: "manual", signal });
      if (!(response.status >= 300 && response.status < 400)) {
        return await responseBytes(response, label, current, limit);
      }
      await response.body?.cancel().catch(() => {});
      const location = response.headers.get("location");
      const next = location ? new URL(location, current) : undefined;
      if (!next || next.origin !== origin || redirects >= MAX_REMOTE_REDIRECTS) {
        throw new SmallPenError(
          "remote_library_redirect",
          `${label} redirected outside the Library origin`,
          { status: response.status, url: current },
        );
      }
      current = next.href;
    }
  } catch (error) {
    if (signal.aborted && !(error instanceof SmallPenError)) {
      throw new SmallPenError(
        "remote_library_timeout",
        `${label} did not finish within ${timeoutMs} ms`,
        { url },
      );
    }
    // Refused connections, DNS and TLS failures arrive as bare transport
    // errors; name the Library and keep the system error code.
    if (!(error instanceof SmallPenError)) {
      const cause = networkErrorCode(error);
      throw new SmallPenError(
        "remote_library_unavailable",
        `${label} could not be fetched: ${cause ?? error?.message ?? error}`,
        cause ? { cause, url } : { url },
      );
    }
    throw error;
  }
}

// fetch() wraps the system error in `cause`, and a failed multi-address
// connect is an AggregateError: find the first ECONNREFUSED/ENOTFOUND/
// CERT_*-style code anywhere in that chain.
function networkErrorCode(error, depth = 0) {
  if (!error || typeof error !== "object" || depth > 4) return undefined;
  if (typeof error.code === "string" && /^[A-Z][A-Z0-9_]+$/.test(error.code)) {
    return error.code;
  }
  for (const child of [error.cause, ...(Array.isArray(error.errors) ? error.errors : [])]) {
    const code = networkErrorCode(child, depth + 1);
    if (code) return code;
  }
  return undefined;
}

async function fetchValue(request, url, label, limit) {
  const bytes = await fetchBytes(request, url, label, limit);
  let value;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    // JSON.parse messages quote the payload; never echo remote content.
    throw new SmallPenError(
      "invalid_remote_library",
      `${label} is not valid JSON`,
      { url },
    );
  }
  return { bytes, value };
}

function collectBlobPaths(value, result = new Set()) {
  if (Array.isArray(value)) {
    for (const child of value) collectBlobPaths(child, result);
    return result;
  }
  if (!value || typeof value !== "object") return result;
  for (const child of Object.values(value)) {
    if (typeof child === "string" && /^blobs\/[a-f0-9]{64}$/.test(child)) {
      result.add(child);
    } else {
      collectBlobPaths(child, result);
    }
  }
  return result;
}

function tooManyFiles(count, manifest) {
  return new SmallPenError(
    "remote_library_too_large",
    "Remote Library lists more files than the package limit",
    { count, limit: MAX_REMOTE_FILES, url: manifest.href },
  );
}

async function downloadRemotePackage(sourceUrl, request) {
  const manifest = manifestUrl(sourceUrl);
  const base = new URL("./", manifest);
  const manifestResult = await fetchValue(
    request,
    manifest.href,
    "Remote Library manifest",
    MAX_REMOTE_MANIFEST_BYTES,
  );
  const { entries } = listPackageEntries(manifestResult.value);
  if (entries.length > MAX_REMOTE_FILES) throw tooManyFiles(entries.length, manifest);
  const values = new Map([["manifest.json", manifestResult.value]]);
  let totalBytes = manifestResult.bytes.byteLength;
  for (const entry of entries) {
    const result = await fetchValue(
      request,
      new URL(entry, base).href,
      `Remote Library entry ${entry}`,
    );
    totalBytes += result.bytes.byteLength;
    if (totalBytes > MAX_REMOTE_PACKAGE_BYTES) {
      throw new SmallPenError(
        "remote_library_too_large",
        "Remote Library exceeds the package size limit",
        { byteLength: totalBytes, url: manifest.href },
      );
    }
    values.set(entry, result.value);
  }
  const blobs = collectBlobPaths([...values.values()]);
  if (entries.length + blobs.size > MAX_REMOTE_FILES) {
    throw tooManyFiles(entries.length + blobs.size, manifest);
  }
  for (const blob of blobs) {
    const bytes = await fetchBytes(
      request,
      new URL(blob, base).href,
      `Remote Library blob ${blob}`,
    );
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_REMOTE_PACKAGE_BYTES) {
      throw new SmallPenError(
        "remote_library_too_large",
        "Remote Library exceeds the package size limit",
        { byteLength: totalBytes, url: manifest.href },
      );
    }
    values.set(blob, bytes);
  }
  return loadPackageFromValues(manifest.href, values);
}

async function cacheDirectory(cacheRoot, sourceUrl) {
  const key = await sha256Hex(
    new TextEncoder().encode(manifestUrl(sourceUrl).href),
  );
  return join(cacheRoot, key);
}

async function writeSnapshotCache(cacheRoot, sourceUrl, snapshot) {
  if (!cacheRoot) return;
  const root = await cacheDirectory(cacheRoot, sourceUrl);
  const snapshotRoot = join(root, snapshot.revision);
  await mkdir(snapshotRoot, { recursive: true });
  await writeFile(
    join(snapshotRoot, "manifest.json"),
    `${canonicalJSON(snapshot.manifest)}\n`,
  );
  for (const [entry, value] of Object.entries(snapshot.entries)) {
    await mkdir(dirname(join(snapshotRoot, entry)), { recursive: true });
    await writeFile(join(snapshotRoot, entry), `${canonicalJSON(value)}\n`);
  }
  for (const [blob, value] of snapshot.blobs ?? []) {
    await mkdir(dirname(join(snapshotRoot, blob)), { recursive: true });
    await writeFile(join(snapshotRoot, blob), value);
  }
  const pointer = join(root, "current.json");
  const temporary = join(root, `.current.${snapshot.revision}.tmp`);
  await writeFile(
    temporary,
    `${canonicalJSON({ revision: snapshot.revision, sourceUrl })}\n`,
  );
  await rename(temporary, pointer);
}

async function readSnapshotCache(cacheRoot, sourceUrl) {
  if (!cacheRoot) return undefined;
  try {
    const root = await cacheDirectory(cacheRoot, sourceUrl);
    const pointer = JSON.parse(
      await readFile(join(root, "current.json"), "utf8"),
    );
    if (!/^[a-f0-9]{64}$/.test(pointer.revision)) return undefined;
    const snapshotRoot = join(root, pointer.revision);
    const manifest = JSON.parse(
      await readFile(join(snapshotRoot, "manifest.json"), "utf8"),
    );
    const { entries } = listPackageEntries(manifest);
    const values = new Map([["manifest.json", manifest]]);
    for (const entry of entries) {
      values.set(
        entry,
        JSON.parse(await readFile(join(snapshotRoot, entry), "utf8")),
      );
    }
    for (const blob of collectBlobPaths([...values.values()])) {
      values.set(
        blob,
        new Uint8Array(await readFile(join(snapshotRoot, blob))),
      );
    }
    const snapshot = await loadPackageFromValues(
      manifestUrl(sourceUrl).href,
      values,
    );
    if (snapshot.revision !== pointer.revision) {
      throw new SmallPenError(
        "remote_library_cache_corrupt",
        "Cached Library content no longer matches its pinned revision",
        {
          expectedRevision: pointer.revision,
          foundRevision: snapshot.revision,
          sourceUrl: manifestUrl(sourceUrl).href,
        },
      );
    }
    return snapshot;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    if (error instanceof SmallPenError && error.code === "remote_library_cache_corrupt") {
      throw error;
    }
    // Any other failure (truncated JSON, blob hash mismatch, …) is a corrupt
    // cache: never surface raw content, always the typed error (SP-026-B).
    if (!(error instanceof SmallPenError)) {
      throw new SmallPenError(
        "remote_library_cache_corrupt",
        "Cached Library content failed integrity validation",
        {
          // JSON.parse messages quote the (remote-origin) cached content.
          reason:
            error instanceof SyntaxError
              ? "invalid JSON"
              : error instanceof Error
                ? error.message
                : String(error),
          sourceUrl: manifestUrl(sourceUrl).href,
        },
      );
    }
    throw new SmallPenError(
      "remote_library_cache_corrupt",
      "Cached Library content failed integrity validation",
      {
        ...(error.details ?? {}),
        reason: error.message,
        sourceUrl: manifestUrl(sourceUrl).href,
      },
    );
  }
}

export async function openRemoteLibrary(
  sourceUrl,
  {
    cacheRoot,
    allowPrivateNetwork,
    expectedPackageId,
    // A caller-supplied fetch owns its own destination policy.
    fetchImpl = createLibraryFetch({ allowPrivateNetwork }),
    refresh = false,
    requestTimeoutMs = REMOTE_REQUEST_TIMEOUT_MS,
  } = {},
) {
  let cached;
  let corruptCacheError;
  if (!refresh) {
    try {
      cached = await readSnapshotCache(cacheRoot, sourceUrl);
    } catch (error) {
      if (error?.code !== "remote_library_cache_corrupt") throw error;
      // A corrupted cache is never trusted; recovery falls through to a safe
      // online re-fetch and the corrupt error only surfaces when offline.
      corruptCacheError = error;
    }
    if (cached) {
      return {
        ...cached,
        remote: { cache: "hit", sourceUrl: manifestUrl(sourceUrl).href },
      };
    }
  }
  try {
    const snapshot = await downloadRemotePackage(sourceUrl, {
      fetchImpl,
      timeoutMs: requestTimeoutMs,
    });
    if (
      expectedPackageId !== undefined &&
      snapshot.manifest.packageId !== expectedPackageId
    ) {
      // The verified cache pointer is intentionally left untouched.
      throw new SmallPenError(
        "library_id_mismatch",
        "Refreshed Library Package ID does not match the declared dependency",
        {
          actualPackageId: snapshot.manifest.packageId,
          expectedPackageId,
          sourceUrl: manifestUrl(sourceUrl).href,
        },
      );
    }
    await writeSnapshotCache(cacheRoot, sourceUrl, snapshot);
    return {
      ...snapshot,
      remote: { cache: "refreshed", sourceUrl: manifestUrl(sourceUrl).href },
    };
  } catch (error) {
    if (error?.code === "library_id_mismatch") throw error;
    if (corruptCacheError && !cached) throw corruptCacheError;
    if (!cached) cached = await readSnapshotCache(cacheRoot, sourceUrl);
    if (!cached) throw error;
    return {
      ...cached,
      remote: {
        cache: "stale",
        sourceUrl: manifestUrl(sourceUrl).href,
        warning: error instanceof Error ? error.message : String(error),
        warningCode: error?.code ?? "remote_library_unavailable",
      },
    };
  }
}
