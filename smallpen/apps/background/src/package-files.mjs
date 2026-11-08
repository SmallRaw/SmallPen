import { createHash } from "node:crypto";

const cache = new WeakMap();

// The package's own files: its HTML and CSS from memory, assets by their
// recorded hash and size. Asset bytes load only when one is requested.
// No host paths, journals, lock files, or caller-provided names are read.
export function packageFiles(snapshot) {
  if (cache.has(snapshot)) return cache.get(snapshot);
  const text = new Map(
    [...(snapshot.files ?? [])].map(([path, value]) => [path, Buffer.from(value)]),
  );
  const assets = new Map(snapshot.assets ?? []);
  const files = [
    ...[...text].map(([path, body]) => ({
      path,
      sha256: createHash("sha256").update(body).digest("hex"),
      size: body.length,
    })),
    ...[...assets].map(([path, facts]) => ({ path, sha256: facts.sha256, size: facts.byteLength })),
  ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const bytes = {
    get(path) {
      if (text.has(path)) return text.get(path);
      const facts = assets.get(path);
      const blob = facts && snapshot.blobs.get(`blobs/${facts.sha256}`);
      return blob ? Buffer.from(blob) : undefined;
    },
  };
  const result = { bytes, files };
  cache.set(snapshot, result);
  return result;
}
