// INPUT:  a .smallpen directory on disk
// OUTPUT: package snapshots, with text in memory and assets by reference
// POS:    Filesystem side of the HTML package format. Pages, components,
//         index.html and tokens.css are read whole (a few MB at most); fonts
//         and images are only stat-ed, identified through a stat-keyed
//         cache, and read when something renders them. A process cache keeps
//         the last decoded state, so an unchanged package is not read again.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  decodePackageFiles,
  fail,
  formatIssues,
  loadPackageFromValues,
} from "@smallpen/core";

import { defaultHistoryCacheRoot, HISTORY_CACHE_IDLE_MS } from "./history-cache.mjs";
import { inspectMedia } from "./media-inspect.mjs";

const IGNORED_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const MAX_FILES = 20000;
const MAX_TEXT_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOTS = 200;
const PACKAGE_ID = /<meta\s+name=["']smallpen:package-id["']\s+content=["']([^"']+)["']/i;

export function isTextPath(path) {
  return !path.startsWith("assets/") && /\.(?:html|css)$/i.test(path);
}

function sortedEntries(map) {
  return [...map].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

// Stats of every regular file: path -> { absolute, size, mtimeMs, ctimeMs, ino }.
export async function statPackageFiles(packagePath) {
  const stats = new Map();
  const walk = async (directory, prefix) => {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      if (IGNORED_NAMES.has(entry.name)) return undefined;
      const absolute = join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        fail("invalid_entry_path", `Package files cannot be symlinks: ${relative}`, { entry: relative });
      }
      if (entry.isDirectory()) return walk(absolute, relative);
      // A FIFO, socket or device could block a read or stand for nothing a
      // package holds; it is refused before anything is read.
      if (!entry.isFile()) fail("invalid_entry_path", `Package files must be regular files: ${relative}`, { entry: relative });
      if (stats.size >= MAX_FILES) fail("package_too_large", `A package holds at most ${MAX_FILES} files`);
      const info = await lstat(absolute);
      stats.set(relative, { absolute, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino });
      return undefined;
    }));
  };
  await walk(packagePath, "");
  return new Map(sortedEntries(stats));
}

function statSignature(stats) {
  const hash = createHash("sha256");
  for (const [path, info] of stats) hash.update(`${path}\0${info.size}\0${info.mtimeMs}\0${info.ctimeMs}\0${info.ino}\n`);
  return hash.digest("hex");
}

// Text files read whole; used by tests and tools that want every byte.
export async function readPackageFiles(packagePath) {
  const stats = await statPackageFiles(packagePath);
  const files = new Map();
  await Promise.all([...stats].map(async ([path, info]) => {
    files.set(path, await readFile(info.absolute));
  }));
  return new Map(sortedEntries(files));
}

export function packageIdOf(files) {
  const index = files.get("index.html");
  if (!index) return undefined;
  return PACKAGE_ID.exec(Buffer.from(index).toString("utf8"))?.[1];
}

// The revision hashes every text file and every asset's content hash, so
// any edit by the App, the CLI or an editor makes a new revision.
export function packageRevision(textFiles, assets) {
  const hash = createHash("sha256");
  const rows = new Map(textFiles);
  for (const [path, facts] of assets ?? []) rows.set(path, `sha256:${facts.sha256}`);
  for (const [path, value] of sortedEntries(rows)) {
    hash.update(path);
    hash.update("\0");
    hash.update(typeof value === "string" ? Buffer.from(value) : value);
    hash.update("\0");
  }
  return hash.digest("hex");
}

// Kept for callers that hold every byte in one map.
export function filesRevision(files) {
  const text = new Map();
  const assets = new Map();
  for (const [path, bytes] of files) {
    if (isTextPath(path)) text.set(path, bytes);
    else if (path.startsWith("assets/")) assets.set(path, { sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return packageRevision(text, assets);
}

export async function packageCacheDirectory(packagePath, packageId) {
  const path = await realpath(resolve(packagePath));
  const key = createHash("sha256").update(path).update("\0").update(packageId).digest("hex");
  return join(defaultHistoryCacheRoot(), key);
}

async function readCacheFile(path, { expire = true } = {}) {
  try {
    const info = await stat(path);
    if (expire && Date.now() - info.mtimeMs > HISTORY_CACHE_IDLE_MS) return undefined;
    return await readFile(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeCacheFile(path, bytes) {
  await mkdir(join(path, ".."), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
}

async function readGzipJson(path) {
  try {
    const bytes = await readCacheFile(path);
    return bytes ? JSON.parse(gunzipSync(bytes).toString("utf8")) : undefined;
  } catch {
    return undefined;
  }
}

// identity key -> id, remembered from the last write so that ids survive
// a package being written and read again.
export async function readIdentity(packagePath, packageId) {
  if (!packageId) return undefined;
  const rows = await readGzipJson(join(await packageCacheDirectory(packagePath, packageId), "identity.gz"));
  return rows ? new Map(rows) : undefined;
}

export async function writeIdentity(packagePath, packageId, identity) {
  if (!packageId || !identity) return;
  const path = join(await packageCacheDirectory(packagePath, packageId), "identity.gz");
  await writeCacheFile(path, gzipSync(Buffer.from(JSON.stringify([...identity]))));
}

// --- Assets ---------------------------------------------------------------

function inspectMediaBytes(bytes) {
  try {
    const info = inspectMedia(bytes);
    return { mimeType: info.mimeType, width: info.width, height: info.height };
  } catch {
    return undefined;
  }
}

const IMAGE_PATH = /\.(?:png|jpe?g|gif|webp|svg)$/i;

// Asset facts (hash, size, image type and size) by path. A fact is reused
// while the file's stat is unchanged; otherwise the file is read once.
async function assetFacts(packagePath, packageId, stats, memo) {
  const cachePath = packageId ? join(await packageCacheDirectory(packagePath, packageId), "assets.gz") : undefined;
  const stored = memo ?? new Map(cachePath ? (await readGzipJson(cachePath)) ?? [] : []);
  const facts = new Map();
  let changed = false;
  await Promise.all([...stats].map(async ([path, info]) => {
    // Only assets/ holds package assets; other files (notes, a README) are
    // not part of the package and never enter its revision or exports.
    if (isTextPath(path) || !path.startsWith("assets/")) return;
    const known = stored.get(path);
    if (known && known.size === info.size && known.mtimeMs === info.mtimeMs && known.ino === info.ino) {
      facts.set(path, known);
      return;
    }
    const bytes = await readFile(info.absolute);
    const entry = {
      size: info.size,
      mtimeMs: info.mtimeMs,
      ino: info.ino,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
    };
    if (IMAGE_PATH.test(path)) Object.assign(entry, inspectMediaBytes(bytes) ?? {});
    facts.set(path, entry);
    changed = true;
  }));
  if (changed && cachePath) {
    try {
      await writeCacheFile(cachePath, gzipSync(Buffer.from(JSON.stringify(sortedEntries(facts)))));
    } catch {
      // A missing fact cache only costs a re-read next time.
    }
  }
  return facts;
}

// Blob bytes load from their file on first use and stay in memory after.
export class LazyBlobMap extends Map {
  #paths = new Map();

  constructor(paths = new Map(), loaded = []) {
    super();
    for (const [key, path] of paths) this.#paths.set(key, path);
    for (const [key, value] of loaded) super.set(key, value);
  }

  has(key) {
    return super.has(key) || this.#paths.has(key);
  }

  get(key) {
    if (super.has(key)) return super.get(key);
    const path = this.#paths.get(key);
    if (path === undefined) return undefined;
    const bytes = new Uint8Array(readFileSync(path));
    super.set(key, bytes);
    return bytes;
  }

  set(key, value) {
    return super.set(key, value);
  }

  delete(key) {
    this.#paths.delete(key);
    return super.delete(key);
  }

  get size() {
    return new Set([...super.keys(), ...this.#paths.keys()]).size;
  }

  *keys() {
    yield* new Set([...super.keys(), ...this.#paths.keys()]);
  }

  *entries() {
    for (const key of this.keys()) yield [key, this.get(key)];
  }

  *values() {
    for (const key of this.keys()) yield this.get(key);
  }

  [Symbol.iterator]() {
    return this.entries();
  }

  forEach(callback, thisArg) {
    for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
  }

  // A copy that shares the paths and the bytes loaded so far.
  clone() {
    const copy = new LazyBlobMap(this.#paths, super.entries());
    return copy;
  }

  pathOf(key) {
    return this.#paths.get(key);
  }
}

// --- Snapshots ----------------------------------------------------------

const processCache = new Map();

// The error carries the first problem's code, so a package with one problem
// fails with that problem; details list them all.
function reportIssues(errors, packagePath) {
  fail(
    errors[0]?.code ?? "invalid_package_files",
    `The package has ${errors.length} problem${errors.length === 1 ? "" : "s"}; run smallpen check for all of them:\n${formatIssues(errors.slice(0, 5))}`,
    {
      issues: errors.slice(0, 100),
      errorCount: errors.length,
      packagePath,
      nextOperations: [{ argv: ["check", packagePath, "--json"], operation: "smallpen.check", when: "after-fixing-the-files" }],
    },
  );
}

// Decodes text files plus asset facts into a snapshot. Content problems fail
// with every located issue attached; `smallpen check` prints them all.
export async function decodeSnapshot(packagePath, textFiles, assets, options = {}) {
  const packageId = packageIdOf(textFiles);
  const identity = options.identity ?? await readIdentity(packagePath, packageId);
  const absolute = options.assetPaths ?? new Map();
  const decoded = await decodePackageFiles(textFiles, { identity, assets, inspectMedia: inspectMediaBytes });
  const errors = decoded.issues.filter((issue) => issue.severity === "error");
  if (errors.length) reportIssues(errors, packagePath);
  const blobs = new LazyBlobMap(
    [...decoded.blobPaths].map(([key, path]) => [key, absolute.get(path) ?? join(packagePath, path)]),
    options.loadedBlobs ?? [],
  );
  const revision = options.revision ?? packageRevision(textFiles, assets);
  const state = {
    values: decoded.values,
    blobs,
    revision,
    warnings: decoded.issues.filter((issue) => issue.severity !== "error"),
  };
  return { state, snapshot: await snapshotOfState(packagePath, state, textFiles, assets) };
}

async function snapshotOfState(packagePath, state, textFiles, assets) {
  const snapshot = await loadPackageFromValues(packagePath, state.values, {
    revision: state.revision,
    blobs: state.blobs.clone(),
  });
  Object.defineProperty(snapshot, "files", { value: textFiles, enumerable: false });
  Object.defineProperty(snapshot, "assets", { value: assets, enumerable: false });
  Object.defineProperty(snapshot, "warnings", { value: state.warnings, enumerable: false });
  return snapshot;
}

// --- Drafts ---------------------------------------------------------------

// A draft is a page kept outside the package for review (view, export or
// check with --draft). While one is laid over a package, reads in this
// process see it as one more page file; nothing about it is cached,
// remembered or written, so the package never holds it.
const draftOverlays = new Map();

export async function overlayDraft(locator, draft) {
  const key = await realpath(resolve(locator));
  draftOverlays.set(key, { path: draft.path, bytes: Buffer.from(draft.bytes) });
  return key;
}

export function draftOverlay(packagePath) {
  return draftOverlays.get(packagePath);
}

// Opens a package. Unchanged files (same stats) reuse the decoded state
// from memory; only changed packages are read and decoded again.
export async function openSnapshot(packagePath, options = {}) {
  const draft = draftOverlays.get(packagePath);
  const stats = await statPackageFiles(packagePath);
  const signature = statSignature(stats);
  const cached = !options.identity && !draft && processCache.get(packagePath);
  if (cached && cached.signature === signature) {
    return snapshotOfState(packagePath, cached.state, cached.textFiles, cached.assets);
  }
  const textFiles = new Map();
  let textBytes = 0;
  await Promise.all([...stats].filter(([path]) => isTextPath(path)).map(async ([path, info]) => {
    textBytes += info.size;
    if (textBytes > MAX_TEXT_BYTES) fail("package_too_large", "Pages, components and tokens hold at most 64 MiB of text");
    textFiles.set(path, await readFile(info.absolute));
  }));
  if (draft) textFiles.set(draft.path, draft.bytes);
  const sortedText = new Map(sortedEntries(textFiles));
  const packageId = packageIdOf(sortedText);
  const assets = await assetFacts(packagePath, packageId, stats, cached?.assetMemo);
  const assetPaths = new Map([...stats].map(([path, info]) => [path, info.absolute]));
  const { state, snapshot } = await decodeSnapshot(packagePath, sortedText, assets, { identity: options.identity, assetPaths });
  if (!options.identity && !draft) {
    processCache.set(packagePath, { signature, state, textFiles: sortedText, assets, assetMemo: assets });
  }
  return snapshot;
}

// After a commit the writer already holds the new state: put it in the
// process cache under the files' new stats, so the next read is free.
export async function rememberCommittedState(packagePath, state, textFiles, assets) {
  const stats = await statPackageFiles(packagePath);
  processCache.set(packagePath, { signature: statSignature(stats), state, textFiles, assets, assetMemo: assets });
}

export function forgetPackage(packagePath) {
  processCache.delete(packagePath);
}

// --- Revision snapshots -------------------------------------------------

// The revision of files a caller read whole (smallpen check), remembered
// like any other read so `changes --since` can start from it.
export async function rememberPackageFiles(packagePath, files) {
  const text = new Map();
  const assets = new Map();
  for (const [path, bytes] of files) {
    if (isTextPath(path)) text.set(path, bytes);
    else if (path.startsWith("assets/")) {
      assets.set(path, {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength,
        ...(IMAGE_PATH.test(path) ? inspectMediaBytes(bytes) ?? {} : {}),
      });
    }
  }
  const revision = packageRevision(new Map(sortedEntries(text)), assets);
  try {
    await rememberRevision(packagePath, packageIdOf(text), revision, text, assets);
  } catch (error) {
    process.emitWarning(`Revision cache unavailable: ${error.message}`, { code: "SMALLPEN_HISTORY_CACHE_UNAVAILABLE" });
  }
  return revision;
}

// `changes --since` compares the files of a revision a caller saw with the
// current ones. Text files are stored; assets by content hash.
export async function rememberRevision(packagePath, packageId, revision, textFiles, assets = new Map()) {
  if (!packageId) return;
  const directory = join(await packageCacheDirectory(packagePath, packageId), "revisions");
  const target = join(directory, `${revision}.gz`);
  try {
    await stat(target);
    return;
  } catch {
    // Not stored yet.
  }
  const record = [];
  for (const [path, bytes] of textFiles) record.push([path, Buffer.from(bytes).toString("utf8")]);
  for (const [path, facts] of assets) record.push([path, { ...facts }]);
  await writeCacheFile(target, gzipSync(Buffer.from(JSON.stringify(record))));
  await pruneRevisions(directory);
}

async function pruneRevisions(directory) {
  let names;
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".gz"));
  } catch {
    return;
  }
  if (names.length <= MAX_SNAPSHOTS) return;
  const dated = await Promise.all(names.map(async (name) => [name, (await stat(join(directory, name))).mtimeMs]));
  dated.sort((left, right) => left[1] - right[1]);
  await Promise.all(dated.slice(0, dated.length - MAX_SNAPSHOTS).map(([name]) => rm(join(directory, name), { force: true })));
}

// The snapshot of a remembered revision. Assets whose content is still in
// the package resolve to the current files; others are left out.
export async function openRevisionSnapshot(current, revision) {
  const packageId = current.manifest.packageId;
  if (!packageId || !/^[0-9a-f]{64}$/.test(revision)) return undefined;
  const directory = join(await packageCacheDirectory(current.locator, packageId), "revisions");
  const rows = await readGzipJson(join(directory, `${revision}.gz`));
  if (!rows) return undefined;
  const textFiles = new Map();
  const assets = new Map();
  for (const [path, value] of rows) {
    if (typeof value === "string") textFiles.set(path, Buffer.from(value));
    else assets.set(path, value);
  }
  const byHash = new Map([...(current.assets ?? [])].map(([path, facts]) => [facts.sha256, path]));
  const assetPaths = new Map();
  for (const [path, facts] of assets) {
    const now = byHash.get(facts.sha256);
    if (now) assetPaths.set(path, join(current.locator, now));
    else assets.delete(path);
  }
  const { snapshot } = await decodeSnapshot(current.locator, textFiles, assets, { revision, assetPaths });
  return snapshot;
}

// Kept for tools that hold every file in memory (tests, conversions).
export async function snapshotFromFiles(packagePath, files, options = {}) {
  const text = new Map();
  const loaded = [];
  const assets = new Map();
  for (const [path, bytes] of files) {
    if (isTextPath(path)) text.set(path, bytes);
    else if (path.startsWith("assets/")) {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const facts = { sha256, byteLength: bytes.byteLength, ...(IMAGE_PATH.test(path) ? inspectMediaBytes(bytes) ?? {} : {}) };
      assets.set(path, facts);
      loaded.push([`blobs/${sha256}`, new Uint8Array(bytes)]);
    }
  }
  const { snapshot } = await decodeSnapshot(packagePath, new Map(sortedEntries(text)), assets, { ...options, loadedBlobs: loaded });
  return snapshot;
}
