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

const MAX_REMOTE_FILE_BYTES = 50 * 1024 * 1024;
const MAX_REMOTE_PACKAGE_BYTES = 200 * 1024 * 1024;

export function defaultLibraryCacheRoot() {
  return join(homedir(), ".smallpen", "library-cache");
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

async function responseBytes(response, label) {
  if (!response.ok) {
    throw new SmallPenError(
      "remote_library_unavailable",
      `${label} returned HTTP ${response.status}`,
      { status: response.status, url: response.url },
    );
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REMOTE_FILE_BYTES) {
    throw new SmallPenError(
      "remote_library_too_large",
      `${label} exceeds the remote Library file limit`,
      { byteLength: declared, url: response.url },
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_REMOTE_FILE_BYTES) {
    throw new SmallPenError(
      "remote_library_too_large",
      `${label} exceeds the remote Library file limit`,
      { byteLength: bytes.byteLength, url: response.url },
    );
  }
  return bytes;
}

async function fetchValue(fetchImpl, url, label) {
  const bytes = await responseBytes(await fetchImpl(url), label);
  let value;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new SmallPenError(
      "invalid_remote_library",
      `${label} is not valid JSON`,
      { reason: error instanceof Error ? error.message : String(error), url },
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

async function downloadRemotePackage(sourceUrl, fetchImpl) {
  const manifest = manifestUrl(sourceUrl);
  const base = new URL("./", manifest);
  const manifestResult = await fetchValue(
    fetchImpl,
    manifest.href,
    "Remote Library manifest",
  );
  const { entries } = listPackageEntries(manifestResult.value);
  const values = new Map([["manifest.json", manifestResult.value]]);
  let totalBytes = manifestResult.bytes.byteLength;
  for (const entry of entries) {
    const result = await fetchValue(
      fetchImpl,
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
  for (const blob of collectBlobPaths([...values.values()])) {
    const bytes = await responseBytes(
      await fetchImpl(new URL(blob, base).href),
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
          reason: error instanceof Error ? error.message : String(error),
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
  { cacheRoot, expectedPackageId, fetchImpl = fetch, refresh = false } = {},
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
    const snapshot = await downloadRemotePackage(sourceUrl, fetchImpl);
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
      },
    };
  }
}
