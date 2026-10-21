import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SmallPenError } from "@smallpen/core";
import { inspectFont, sfntToWoff, woffToSfnt } from "./font-convert.mjs";
import { defaultHistoryCacheRoot } from "./history-cache.mjs";
import { readRegularFile } from "./fs-utils.mjs";

// Disposable, bounded conversion cache. Nothing here changes a Package or
// its revision; losing the cache only makes the next request convert again.
const CACHE_VERSION = "font-container-v1";
const MAX_CACHE_BYTES = 128 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 64 * 1024 * 1024;
const pending = new Map();
const hash = (bytes) => createHash("sha256").update(bytes).digest();
const mimeOfSfnt = (bytes) => (bytes[0] === 0x4f ? "font/otf" : "font/ttf");

export function defaultFontCacheRoot() {
  return (
    process.env.SMALLPEN_FONT_CACHE_DIR ||
    join(
      dirname(
        defaultHistoryCacheRoot({
          env: { ...process.env, SMALLPEN_HISTORY_CACHE_DIR: undefined },
        }),
      ),
      "fonts",
    )
  );
}

async function prune(root) {
  const files = await Promise.all(
    (await readdir(root))
      .filter((name) => /^[a-f0-9]{64}\.font$/.test(name))
      .map(async (name) => ({ name, ...(await stat(join(root, name))) })),
  );
  files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  let bytes = 0;
  for (const file of files) {
    bytes += file.size;
    if (bytes > MAX_CACHE_BYTES)
      await rm(join(root, file.name), { force: true });
  }
}

async function converted(source, sourceType, target) {
  const key = hash(
    Buffer.concat([Buffer.from(`${CACHE_VERSION}/${target}/`), hash(source)]),
  ).toString("hex");
  const root = defaultFontCacheRoot(),
    path = join(root, `${key}.font`);
  const validate = (bytes) =>
    inspectFont(bytes, target === "woff" ? "font/woff" : mimeOfSfnt(bytes));
  try {
    const info = await stat(path);
    if (info.size > MAX_RESOURCE_BYTES + 32)
      throw new Error("Oversized cached font");
    const cached = await readRegularFile(path, undefined, {
        maxBytes: MAX_RESOURCE_BYTES + 32,
      }),
      bytes = cached.subarray(32);
    if (cached.length < 36 || !hash(bytes).equals(cached.subarray(0, 32)))
      throw new Error("Damaged cached font");
    validate(bytes);
    return bytes;
  } catch {
    /* A cache miss or damaged cache never prevents conversion. */
  }
  const bytes =
    target === "woff" ? sfntToWoff(source, sourceType) : woffToSfnt(source);
  validate(bytes);
  let temporary;
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, Buffer.concat([hash(bytes), bytes]), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
    temporary = undefined;
    await prune(root);
  } catch {
    /* Read-only or full cache: serve the converted font anyway. */
  } finally {
    if (temporary) await rm(temporary, { force: true }).catch(() => {});
  }
  return bytes;
}

export async function resolveFontResource(snapshot, variant, target = "sfnt") {
  // Original resources keep their IDs and bytes for older Apps and links.
  const direct =
    target === "sfnt"
      ? (variant.files.ttf ?? variant.files.otf)
      : variant.files[target];
  let descriptor = direct,
    bytes = descriptor && snapshot.blobs.get(descriptor.blob);
  if (!descriptor) {
    if (!["sfnt", "woff"].includes(target))
      throw new SmallPenError(
        "missing_font_resource",
        `Font has no ${target} resource`,
      );
    descriptor = variant.files.ttf ?? variant.files.otf ?? variant.files.woff;
    const source = descriptor && snapshot.blobs.get(descriptor.blob);
    if (!source)
      throw new SmallPenError(
        "missing_font_blob",
        "Font source bytes are unavailable",
      );
    if (source.length > MAX_RESOURCE_BYTES)
      throw new SmallPenError(
        "font_resource_too_large",
        "Font exceeds the resource limit",
      );
    const key = `${defaultFontCacheRoot()}/${target}/${descriptor.sha256}`;
    let conversion = pending.get(key);
    if (!conversion) {
      conversion = converted(source, descriptor.mimeType, target).finally(() =>
        pending.delete(key),
      );
      pending.set(key, conversion);
    }
    bytes = await conversion;
  }
  if (!bytes)
    throw new SmallPenError(
      "missing_font_blob",
      "Font source bytes are unavailable",
    );
  return {
    bytes,
    mimeType:
      target === "sfnt" ? mimeOfSfnt(bytes) : (direct?.mimeType ?? "font/woff"),
    sha256: hash(bytes).toString("hex"),
  };
}
