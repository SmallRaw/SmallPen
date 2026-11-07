import { createHash } from "node:crypto";
import { canonicalJSON } from "@smallpen/core";

const cache = new WeakMap();

// Only validated canonical entries and blobs are exported. No host paths,
// journals, lock files, or caller-provided filesystem names are read here.
export function packageFiles(snapshot) {
  if (cache.has(snapshot)) return cache.get(snapshot);
  const bytes = new Map([
    ["manifest.json", Buffer.from(canonicalJSON(snapshot.manifest))],
    ...Object.entries(snapshot.entries).map(([path, value]) => [
      path,
      Buffer.from(canonicalJSON(value)),
    ]),
    ...[...snapshot.blobs].map(([path, value]) => [path, Buffer.from(value)]),
  ]);
  const files = [...bytes].map(([path, body]) => ({
    path,
    sha256: createHash("sha256").update(body).digest("hex"),
    size: body.length,
  }));
  const result = { bytes, files };
  cache.set(snapshot, result);
  return result;
}
