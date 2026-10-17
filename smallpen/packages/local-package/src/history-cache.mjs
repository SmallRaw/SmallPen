import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";
import { realpath } from "node:fs/promises";
import { SmallPenError } from "@smallpen/core";
import { readRegularFile } from "./fs-utils.mjs";

export const HISTORY_CACHE_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

export function defaultHistoryCacheRoot({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  if (env.SMALLPEN_HISTORY_CACHE_DIR) return resolve(env.SMALLPEN_HISTORY_CACHE_DIR);
  if (platform === "darwin") return posix.join(home, "Library", "Caches", "SmallPen", "history");
  if (platform === "win32") return win32.join(env.LOCALAPPDATA && win32.isAbsolute(env.LOCALAPPDATA)
    ? env.LOCALAPPDATA : win32.join(home, "AppData", "Local"), "SmallPen", "Cache", "history");
  return posix.join(env.XDG_CACHE_HOME && posix.isAbsolute(env.XDG_CACHE_HOME)
    ? env.XDG_CACHE_HOME : posix.join(home, ".cache"), "smallpen", "history");
}

// Resolve aliases before hashing. Copies keep separate histories even when
// their manifests share a Package ID; replacing a Package at the same path
// with another ID also starts a fresh history. No project names enter filenames.
export async function batchHistoryPath(locator) {
  const path = await realpath(resolve(locator));
  const manifest = JSON.parse(await readRegularFile(join(path, "manifest.json"), "utf8", { maxBytes: 4 * 1024 * 1024 }));
  if (typeof manifest.packageId !== "string" || !manifest.packageId)
    throw new SmallPenError("invalid_package_id", "Cannot locate history without a Package ID");
  const identity = createHash("sha256").update(path).update("\0").update(manifest.packageId).digest("hex");
  return join(defaultHistoryCacheRoot(), identity, "batches.json");
}
