// INPUT:  a package's files on disk and its last accepted version
// OUTPUT: which changed files check accepts, which it rejects, and the
//         rollback of the rejected ones
// POS:    the gate between an agent's direct file edits and the package.
//
// Agents edit the HTML files directly, possibly many at once. Every version
// that passes check (or that the App saved) is the "accepted" version. When a
// later check finds errors, the changed files that keep the package valid are
// accepted and the files with errors are rejected; `check --revert` puts the
// rejected files back to their accepted content. The accepted version lives
// in the system cache beside the history, never in the project.
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { isTextPath, packageCacheDirectory, packageRevision, readPackageFiles } from "./html-store.mjs";

// The files that make a package: its text and its assets. A README or notes
// beside them are not checked, accepted or reverted.
export function isPackagePath(path) {
  return isTextPath(path) || path.startsWith("assets/");
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function gateDirectory(packagePath) {
  return join(await packageCacheDirectory(packagePath, "accepted"), "gate");
}

async function writeAtomic(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
}

// The accepted version: text files whole, assets by content hash with their
// bytes kept once per hash so a rejected asset can be restored.
export async function readAccepted(packagePath) {
  try {
    const bytes = await readFile(join(await gateDirectory(packagePath), "accepted.gz"));
    const record = JSON.parse(gunzipSync(bytes).toString("utf8"));
    return {
      revision: record.revision,
      acceptedAt: record.acceptedAt,
      text: new Map(record.text),
      assets: new Map(record.assets),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    return undefined;
  }
}

async function readAcceptedBlob(packagePath, hash) {
  try {
    return await readFile(join(await gateDirectory(packagePath), "blobs", hash));
  } catch {
    return undefined;
  }
}

// Records `files` (path -> bytes, package paths only) as the accepted version.
export async function writeAccepted(packagePath, files) {
  const directory = await gateDirectory(packagePath);
  const text = [];
  const assets = [];
  const keep = new Set();
  for (const [path, bytes] of [...files].sort(([left], [right]) => (left < right ? -1 : 1))) {
    if (!isPackagePath(path)) continue;
    if (isTextPath(path)) {
      text.push([path, Buffer.from(bytes).toString("utf8")]);
      continue;
    }
    const hash = sha256(bytes);
    assets.push([path, { sha256: hash, byteLength: bytes.byteLength }]);
    keep.add(hash);
    const blob = join(directory, "blobs", hash);
    try {
      await stat(blob);
    } catch {
      await writeAtomic(blob, bytes);
    }
  }
  const revision = packageRevision(new Map(text), new Map(assets));
  await writeAtomic(
    join(directory, "accepted.gz"),
    gzipSync(Buffer.from(JSON.stringify({ revision, acceptedAt: new Date().toISOString(), text, assets }))),
  );
  // Blobs no accepted asset uses any more are dropped.
  try {
    const { readdir } = await import("node:fs/promises");
    for (const name of await readdir(join(directory, "blobs"))) {
      if (!keep.has(name)) await rm(join(directory, "blobs", name), { force: true });
    }
  } catch {
    // No blobs yet.
  }
  return revision;
}

// Package files that differ between the accepted version and `files`.
export function changedPaths(accepted, files) {
  const paths = new Set();
  const current = new Map([...files].filter(([path]) => isPackagePath(path)));
  for (const [path, bytes] of current) {
    if (isTextPath(path)) {
      if (accepted.text.get(path) !== Buffer.from(bytes).toString("utf8")) paths.add(path);
    } else if (accepted.assets.get(path)?.sha256 !== sha256(bytes)) {
      paths.add(path);
    }
  }
  for (const path of [...accepted.text.keys(), ...accepted.assets.keys()]) {
    if (!current.has(path)) paths.add(path);
  }
  return [...paths].sort();
}

// The accepted content of one path, or undefined when the path is new.
async function acceptedBytes(packagePath, accepted, path) {
  if (accepted.text.has(path)) return Buffer.from(accepted.text.get(path));
  const facts = accepted.assets.get(path);
  if (!facts) return undefined;
  const bytes = await readAcceptedBlob(packagePath, facts.sha256);
  if (!bytes) {
    throw Object.assign(new Error(`The accepted bytes of ${path} are no longer in the cache`), {
      code: "accepted_asset_missing",
      path,
    });
  }
  return bytes;
}

// Files other files depend on come first when an error cannot be pinned on
// the file it is reported in.
const said = (issue) => `${issue.file}\0${issue.code}\0${issue.message}`;

// The errors of `before` that `after` no longer has (by what they say; lines
// move between versions), as a multiset.
function minus(before, after) {
  const left = new Map();
  for (const issue of after) left.set(said(issue), (left.get(said(issue)) ?? 0) + 1);
  return before.filter((issue) => {
    const count = left.get(said(issue)) ?? 0;
    if (count === 0) return true;
    left.set(said(issue), count - 1);
    return false;
  });
}

function sharedFirst(path) {
  if (path === "tokens.css") return 0;
  if (path === "index.html") return 1;
  if (path.startsWith("components/")) return 2;
  if (path.startsWith("assets/")) return 3;
  return 4;
}

// Finds which changed files can stay. Starting from every change, files the
// check reports errors in go back to their accepted content until the
// package passes. An error in a file that did not change (or in no file)
// comes from another change: shared files (tokens.css, index.html,
// components, assets) go back one at a time until it is gone.
// `check(files)` returns { issues } like checkPackageFiles.
export async function gateFiles(packagePath, accepted, files, check) {
  const changed = changedPaths(accepted, files);
  const candidate = new Map([...files].filter(([path]) => isPackagePath(path)));
  const rejected = new Map();
  const acceptedVersion = async (path) => acceptedBytes(packagePath, accepted, path);
  const without = async (map, path) => {
    const next = new Map(map);
    const bytes = await acceptedVersion(path);
    if (bytes === undefined) next.delete(path);
    else next.set(path, bytes);
    return next;
  };
  const errorsOf = async (map) => (await check(map)).issues.filter((issue) => issue.severity === "error");
  let last = await check(candidate);
  let errors = last.issues.filter((issue) => issue.severity === "error");
  for (let round = 0; errors.length && round <= changed.length; round += 1) {
    // A changed file is to blame for its errors when its accepted content
    // has fewer: an error it inherits from another change does not count.
    // Every change is tried, so a page whose errors a component's revert
    // also clears (a part or component renamed) is that change's victim.
    const open = changed.filter((path) => !rejected.has(path)).slice(0, 24);
    const cleared = new Map();
    for (const path of open) {
      const trial = await errorsOf(await without(candidate, path));
      cleared.set(path, { trial, gone: minus(errors, trial) });
    }
    const upstream = (left, right) => sharedFirst(left) < sharedFirst(right) || (sharedFirst(left) === sharedFirst(right) && left < right);
    const blamed = open.filter((path) => {
      const mine = cleared.get(path).gone.filter((issue) => issue.file === path);
      if (!mine.length) return false;
      const victim = mine.every((issue) => open.some((other) =>
        other !== path && upstream(other, path) && cleared.get(other).gone.some((item) => said(item) === said(issue))));
      return !victim;
    });
    if (blamed.length) {
      for (const path of blamed) {
        const { gone } = cleared.get(path);
        // Its own errors, and the ones it causes in other files (pages that
        // use what it changed).
        const own = gone.filter((issue) => issue.file === path);
        const elsewhere = gone.filter((issue) => issue.file !== path).map((issue) => ({ ...issue, causedBy: path }));
        rejected.set(path, [...own, ...elsewhere]);
        const bytes = await acceptedVersion(path);
        if (bytes === undefined) candidate.delete(path);
        else candidate.set(path, bytes);
      }
    } else {
      // The errors come from another file's change (a Token or component
      // removed, a page renamed). The change whose accepted content clears
      // the most of them goes back, one per round; on a tie, shared files
      // (tokens.css, index.html, components, assets) go first.
      const order = changed
        .filter((path) => !rejected.has(path))
        .sort((left, right) => sharedFirst(left) - sharedFirst(right) || (left < right ? -1 : 1));
      let next = order[0];
      let remaining;
      for (const path of order.slice(0, 16)) {
        const trial = await errorsOf(await without(candidate, path));
        if (trial.length < (remaining ?? errors).length) {
          remaining = trial;
          next = path;
        }
      }
      if (!next) break;
      // The errors it causes are the ones that go away with it.
      const key = (issue) => `${issue.file}\0${issue.line}\0${issue.column}\0${issue.code}\0${issue.message}`;
      const left = new Set((remaining ?? []).map(key));
      const caused = remaining ? errors.filter((issue) => !left.has(key(issue))) : errors;
      rejected.set(next, caused.map((issue) => ({ ...issue, causedBy: next })));
      const bytes = await acceptedVersion(next);
      if (bytes === undefined) candidate.delete(next);
      else candidate.set(next, bytes);
    }
    last = await check(candidate);
    errors = last.issues.filter((issue) => issue.severity === "error");
  }
  const kind = (path) =>
    !accepted.text.has(path) && !accepted.assets.has(path)
      ? "added"
      : !files.has(path)
        ? "deleted"
        : "modified";
  return {
    changed,
    accepted: changed.filter((path) => !rejected.has(path)),
    rejected: [...rejected].map(([path, issues]) => ({ path, change: kind(path), issues })),
    candidate,
    // What the accepted version holds once the rejected files go back.
    summary: last.summary,
  };
}

// Puts the rejected files back: their accepted content, or no file when the
// agent added them. Caller holds the package write lock.
export async function revertFiles(packagePath, accepted, paths) {
  const reverted = [];
  for (const path of paths) {
    const target = join(packagePath, path);
    const bytes = await acceptedBytes(packagePath, accepted, path);
    if (bytes === undefined) {
      try {
        if ((await lstat(target)).isFile()) await unlink(target);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      reverted.push({ path, action: "removed" });
    } else {
      await writeAtomic(target, bytes);
      reverted.push({ path, action: "restored" });
    }
  }
  return reverted;
}

// Accepts the package as it is on disk (after an App save or init).
export async function acceptPackageFiles(packagePath) {
  return writeAccepted(packagePath, await readPackageFiles(packagePath));
}
