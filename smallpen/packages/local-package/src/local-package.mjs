import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import {
  canonicalJSON,
  checkOperationShape,
  fail,
  listPackageEntries,
  loadPackageFromValues,
  prepareOperationBatch,
  sha256Hex,
  SmallPenError,
} from "@smallpen/core";

import {
  isWithinRoot,
  pathExists,
  readRegularFile,
  syncDirectory,
  writeFileDurable,
} from "./fs-utils.mjs";
import { batchHistoryPath, HISTORY_CACHE_IDLE_MS } from "./history-cache.mjs";
import { prepareFontFiles } from "./font-convert.mjs";

const execFileAsync = promisify(execFile);

// Writers and waiters refresh their claim file while it exists. When a claim
// owner's PID is alive but its identity cannot be verified (Windows has no
// `ps`, or the claim carries no identity), a claim that stopped refreshing
// belongs to a dead process whose PID was reused.
const CLAIM_HEARTBEAT_MS = 2000;
const UNVERIFIED_CLAIM_STALE_MS = 10000;
const MAX_BATCH_LEDGER_ENTRIES = 500;
// Control files and cached histories are read whole; a huge or endless file
// must fail fast instead of exhausting memory. Undo records can be
// large, so the ledger enforces both byte and record limits on every write.
const MAX_BATCH_LEDGER_BYTES = 32 * 1024 * 1024;
const UNREADABLE_BATCH_LEDGER = Symbol("unreadableBatchLedger");
export const BATCH_HISTORY_LIMITS = Object.freeze({
  maxBytes: MAX_BATCH_LEDGER_BYTES,
  maxBatches: MAX_BATCH_LEDGER_ENTRIES,
  maxIdleMs: HISTORY_CACHE_IDLE_MS,
});
const MAX_CONTROL_FILE_BYTES = 64 * 1024;
// Errors that mean this process cannot create the lock next to the Package.
const UNWRITABLE_LOCATION_CODES = new Set(["EACCES", "EPERM", "EROFS"]);

async function processIdentity(pid) {
  if (process.platform === "win32") return undefined;
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]);
    const value = stdout.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

let ownProcessIdentity;

// The identity of this process never changes. Resolve it once instead of
// spawning `ps` on every lock acquisition (every Package read takes the lock).
function currentProcessIdentity() {
  ownProcessIdentity ??= processIdentity(process.pid);
  return ownProcessIdentity;
}

function commitJournalPath(packagePath) {
  return join(dirname(packagePath), `.${basename(packagePath)}.commit.json`);
}

function validatedCommitJournal(packagePath, journal) {
  const parent = dirname(packagePath);
  const packageName = basename(packagePath);
  const backupPath = resolve(String(journal?.backupPath ?? ""));
  const candidatePath = resolve(String(journal?.candidatePath ?? ""));
  const transactionPath = resolve(String(journal?.transactionPath ?? ""));
  if (
    dirname(backupPath) !== parent ||
    !basename(backupPath).startsWith(`.${packageName}.backup-`) ||
    dirname(transactionPath) !== parent ||
    !(
      basename(transactionPath).startsWith(`.${packageName}.transaction-`) ||
      // Journals written before transactions carried the Package name.
      basename(transactionPath).startsWith(".smallpen-transaction-")
    ) ||
    candidatePath !== join(transactionPath, "candidate.smallpen")
  ) {
    fail("invalid_commit_journal", "Package commit journal is invalid", {
      packagePath,
    });
  }
  return { backupPath, candidatePath, transactionPath };
}

async function recoverInterruptedCommit(packagePath) {
  const journalPath = commitJournalPath(packagePath);
  let journal;
  try {
    journal = JSON.parse(
      await readRegularFile(journalPath, "utf8", {
        maxBytes: MAX_CONTROL_FILE_BYTES,
      }),
    );
  } catch (error) {
    if (error?.code === "ENOENT") return;
    if (await pathExists(packagePath)) {
      await cleanup([journalPath]);
      return;
    }
    fail(
      "invalid_commit_journal",
      `Unable to recover Package commit: ${error.message}`,
      { packagePath },
    );
  }
  const { backupPath, candidatePath, transactionPath } = validatedCommitJournal(
    packagePath,
    journal,
  );
  if (!(await pathExists(packagePath))) {
    const recoverySource = (await pathExists(candidatePath))
      ? candidatePath
      : backupPath;
    if (!(await pathExists(recoverySource))) {
      fail(
        "incomplete_commit_recovery",
        "Package commit cannot be recovered because its candidate and backup are missing",
        { packagePath },
      );
    }
    try {
      await rename(recoverySource, packagePath);
    } catch (error) {
      if (!(await pathExists(packagePath))) throw error;
    }
  }
  await cleanup([backupPath, transactionPath, journalPath]);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A writer killed mid-commit leaves its transaction, backup, and temporary
// journal or ledger files next to the Package. Only the holder of the write
// lock creates them, so while it is held and no commit journal remains, any
// that exist are abandoned.
async function removeAbandonedCommitFiles(packagePath) {
  const parent = dirname(packagePath);
  const name = escapeRegExp(basename(packagePath));
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const abandoned = new RegExp(
    `^(?:\\.${name}\\.transaction-[A-Za-z0-9]{6}|\\.${name}\\.backup-${uuid}|\\.${name}\\.commit\\.json\\.${uuid}\\.tmp|${name}\\.batches\\.json\\.${uuid}\\.tmp)$`,
  );
  let names;
  try {
    names = await readdir(parent);
  } catch {
    return;
  }
  await cleanup(
    names.filter((entry) => abandoned.test(entry)).map((entry) => join(parent, entry)),
  );
}

async function resolvePackageRoot(locator) {
  let packagePath;
  try {
    packagePath = await realpath(resolve(locator));
  } catch (error) {
    fail("invalid_package_path", `Unable to open Package: ${error.message}`);
  }
  const packageInfo = await stat(packagePath);
  if (!packageInfo.isDirectory() || !packagePath.endsWith(".smallpen")) {
    fail(
      "invalid_package_path",
      "SmallPen Package must be a directory with the .smallpen extension",
      { packagePath },
    );
  }
  return packagePath;
}

async function resolveEntry(packagePath, entry) {
  const candidatePath = resolve(packagePath, entry);
  if (!isWithinRoot(packagePath, candidatePath)) {
    fail(
      "invalid_entry_path",
      `Canonical entry escapes the Package: ${entry}`,
    );
  }
  let entryInfo;
  try {
    entryInfo = await lstat(candidatePath);
  } catch (error) {
    fail(
      "invalid_entry_path",
      `Unable to resolve Canonical entry ${entry}: ${error.message}`,
      { entry },
    );
  }
  if (entryInfo.isSymbolicLink()) {
    fail("invalid_entry_path", `Canonical entry cannot be a symlink: ${entry}`);
  }
  const entryPath = await realpath(candidatePath);
  if (!isWithinRoot(packagePath, entryPath)) {
    fail(
      "invalid_entry_path",
      `Canonical entry resolves outside the Package: ${entry}`,
    );
  }
  // Case- and normalization-insensitive file systems (macOS, Windows) resolve
  // an entry that differs from the file name only in case or Unicode form; a
  // case-sensitive system (Linux, CI) would not. Require the exact name.
  const onDisk = relative(packagePath, entryPath).split(sep).join("/");
  if (onDisk !== entry) {
    fail(
      "invalid_entry_path",
      `Canonical entry ${entry} does not match the file name ${onDisk}`,
      { entry, onDisk },
    );
  }
  return entryPath;
}

async function readJson(path, code, details) {
  try {
    return JSON.parse(await readRegularFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SmallPenError) throw error;
    fail(code, `Unable to read ${basename(path)}: ${error.message}`, details);
  }
}

async function readPackageValues(packagePath) {
  const manifest = await readJson(
    await resolveEntry(packagePath, "manifest.json"),
    "invalid_manifest_json",
    { packagePath },
  );
  const { entries } = listPackageEntries(manifest);
  const values = new Map([["manifest.json", manifest]]);
  await Promise.all(
    entries.map(async (entry) => {
      values.set(
        entry,
        await readJson(
          await resolveEntry(packagePath, entry),
          "invalid_entry_json",
          { entry, packagePath },
        ),
      );
    }),
  );
  const blobsPath = join(packagePath, "blobs");
  let blobEntries = [];
  try {
    const info = await lstat(blobsPath);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      fail("invalid_media_blob_directory", "Package blobs must be a directory");
    }
    blobEntries = await readdir(blobsPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await Promise.all(
    blobEntries.map(async (entry) => {
      if (!entry.isFile() || !/^[a-f0-9]{64}$/.test(entry.name)) {
        fail(
          "invalid_media_blob",
          `Package blob entry is invalid: blobs/${entry.name}`,
        );
      }
      const path = `blobs/${entry.name}`;
      values.set(
        path,
        await readRegularFile(await resolveEntry(packagePath, path)),
      );
    }),
  );
  return values;
}

async function openPackageUnlocked(locator) {
  const packagePath = await resolvePackageRoot(locator);
  return loadPackageFromValues(
    packagePath,
    await readPackageValues(packagePath),
  );
}

async function cleanup(paths) {
  await Promise.allSettled(
    paths.map((path) => rm(path, { force: true, recursive: true })),
  );
}

async function claimOlderThan(claimPath, milliseconds) {
  let info;
  try {
    info = await lstat(claimPath);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  return Date.now() - info.mtimeMs > milliseconds;
}

async function abandonedWriteClaim(claimPath) {
  let owner;
  try {
    owner = JSON.parse(
      await readRegularFile(claimPath, "utf8", {
        maxBytes: MAX_CONTROL_FILE_BYTES,
      }),
    );
  } catch {
    return claimOlderThan(claimPath, 1000);
  }
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) {
    return claimOlderThan(claimPath, 1000);
  }
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    // EPERM: the PID is alive but owned by another user; verify it below.
  }
  if (owner.processIdentity) {
    const currentIdentity =
      owner.pid === process.pid
        ? await currentProcessIdentity()
        : await processIdentity(owner.pid);
    if (currentIdentity) return owner.processIdentity !== currentIdentity;
  }
  return claimOlderThan(claimPath, UNVERIFIED_CLAIM_STALE_MS);
}

function orderedWriteClaims(names) {
  return names
    .filter((name) => name === "owner.json" || /^\d{16}-.+\.json$/.test(name))
    .sort((left, right) => {
      if (left === "owner.json") return -1;
      if (right === "owner.json") return 1;
      return left < right ? -1 : left > right ? 1 : 0;
    });
}

async function activeWriteClaim(activePath) {
  try {
    const value = JSON.parse(
      await readRegularFile(activePath, "utf8", {
        maxBytes: MAX_CONTROL_FILE_BYTES,
      }),
    );
    return typeof value?.claimName === "string" ? value.claimName : undefined;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    return undefined;
  }
}

async function releaseWriteClaim(activePath, claimName, claimPath) {
  if (await activeWriteClaim(activePath) === claimName) {
    await rm(activePath, { force: true });
  }
  await rm(claimPath, { force: true });
  // Keep the claim directory as the stable synchronization point. Removing it
  // here can race with a waiter that has already created its claim and would
  // either delete that live claim or leave the waiter operating on an unlinked
  // directory. Empty lock directories contain no ownership state and are safe
  // to reuse on the next acquisition.
}

async function acquireWriteLock(packagePath) {
  // Library and Foundation paths come from Package manifests: never create a
  // lock directory beside a path that cannot be a Package.
  if (!packagePath.endsWith(".smallpen")) {
    fail(
      "invalid_package_path",
      "SmallPen Package must be a directory with the .smallpen extension",
      { packagePath },
    );
  }
  const lockPath = join(
    dirname(packagePath),
    `.${basename(packagePath)}.write-lock`,
  );
  const ownerProcessIdentity = await currentProcessIdentity();
  const claimName = `${String(Date.now()).padStart(16, "0")}-${randomUUID()}.json`;
  const claimPath = join(lockPath, claimName);
  const activePath = join(lockPath, "active");
  try {
    await mkdir(lockPath, { recursive: true });
    // Claims are read, written and removed by name inside the lock directory:
    // a symlink there (an archive can carry one) would aim that at any folder.
    if ((await lstat(lockPath)).isSymbolicLink()) {
      fail(
        "invalid_write_lock",
        "Package write lock must be a directory, not a symlink",
        { lockPath, packagePath },
      );
    }
    await writeFile(
      claimPath,
      JSON.stringify({
        createdAt: new Date().toISOString(),
        pid: process.pid,
        processIdentity: ownerProcessIdentity,
      }),
      { flag: "wx" },
    );
  } catch (error) {
    if (!UNWRITABLE_LOCATION_CODES.has(error?.code)) throw error;
    fail(
      "package_not_writable",
      `Package location is not writable: ${error.message}`,
      { lockPath, packagePath },
    );
  }
  const heartbeat = setInterval(() => {
    const now = new Date();
    utimes(claimPath, now, now).catch(() => {});
  }, CLAIM_HEARTBEAT_MS);
  heartbeat.unref?.();
  const release = () => {
    clearInterval(heartbeat);
    return releaseWriteClaim(activePath, claimName, claimPath);
  };
  const deadline = Date.now() + 30000;
  try {
    while (true) {
      const claims = orderedWriteClaims(await readdir(lockPath));
      for (const name of claims) {
        const candidate = join(lockPath, name);
        if (candidate !== claimPath && await abandonedWriteClaim(candidate)) {
          await rm(candidate, { force: true });
        }
      }
      const activeClaims = orderedWriteClaims(await readdir(lockPath));
      if (activeClaims[0] === claimName) {
        try {
          await writeFile(activePath, JSON.stringify({ claimName }), { flag: "wx" });
          return release;
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
          const activeClaimName = await activeWriteClaim(activePath);
          const activeClaimPath = activeClaimName
            ? join(lockPath, activeClaimName)
            : undefined;
          if (
            !activeClaimPath ||
            !activeClaims.includes(activeClaimName) ||
            await abandonedWriteClaim(activeClaimPath)
          ) {
            await rm(activePath, { force: true });
          }
        }
      }
      if (Date.now() >= deadline) {
        fail(
          "package_write_locked",
          "Timed out waiting for another Package writer",
          { packagePath },
        );
      }
      await delay(10);
    }
  } catch (error) {
    await release();
    throw error;
  }
}

async function lockTarget(locator) {
  const requested = resolve(locator);
  try {
    return await realpath(requested);
  } catch (error) {
    if (error?.code === "ENOENT") return requested;
    throw error;
  }
}

export async function openPackage(locator) {
  const target = await lockTarget(locator);
  // A missing Package without a commit journal fails without creating a
  // lock directory (or its missing parents) for a mistyped path.
  if (
    !(await pathExists(target)) &&
    !(await pathExists(commitJournalPath(target)))
  ) {
    return openPackageUnlocked(target);
  }
  let release;
  try {
    release = await acquireWriteLock(target);
  } catch (error) {
    // This process cannot write here, so it cannot commit here either: read
    // the Package as is. An interrupted commit still needs a writable owner.
    if (
      error?.code !== "package_not_writable" ||
      (await pathExists(commitJournalPath(target)))
    ) {
      throw error;
    }
    return openPackageUnlocked(target);
  }
  try {
    await recoverInterruptedCommit(target);
    const snapshot = await openPackageUnlocked(target);
    if (await pathExists(`${target}.batches.json`)) {
      try { await readBatchLedger(target); }
      catch (error) {
        // Auxiliary history migration must not prevent opening a valid design.
        process.emitWarning(`Legacy history migration deferred: ${error.message}`, { code: "SMALLPEN_HISTORY_CACHE_UNAVAILABLE" });
      }
    }
    return snapshot;
  } finally {
    await release();
  }
}

async function copyFileDurable(source, target, flags = 0) {
  await copyFile(source, target, flags);
  const handle = await open(target, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Builds the candidate Package from hard links to the live files instead of
// copying every byte. A linked file already sits on stable storage, so only
// new directory entries need a sync. This is safe with the commit journal:
// commits never write through a link (changed files are unlinked and written
// as new inodes), recovery only renames whole directories, and removing the
// backup or transaction directory only drops one link to each shared inode.
// File systems without hard links fall back to a synced copy.
async function linkPackageTree(source, target, directories) {
  await mkdir(target);
  directories.add(target);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      await linkPackageTree(from, to, directories);
    } else if (entry.isSymbolicLink()) {
      await symlink(await readlink(from), to);
    } else if (entry.isFile()) {
      try {
        await link(from, to);
      } catch (error) {
        if (
          !["EPERM", "EXDEV", "ENOTSUP", "EMLINK", "EACCES", "ENOSYS"].includes(
            error?.code,
          )
        ) {
          throw error;
        }
        await copyFileDurable(from, to);
      }
    }
  }
}

// Stray symlinks in a Package are carried into the candidate unchanged, so a
// write must never pass through one: a symlinked directory would make the
// commit delete and write files outside the Package before validation
// rejects the candidate.
async function assertNoSymlinkAncestors(candidatePath, entry) {
  let current = candidatePath;
  for (const segment of entry.split("/").slice(0, -1)) {
    current = join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      fail(
        "invalid_entry_path",
        `Package entry passes through a symlink or file: ${entry}`,
        { entry },
      );
    }
  }
}

async function writeCandidate(
  originalPath,
  snapshot,
  changedFiles,
  deletedFiles,
  blobWrites = new Map(),
) {
  const transactionPath = await mkdtemp(
    join(dirname(originalPath), `.${basename(originalPath)}.transaction-`),
  );
  const candidatePath = join(transactionPath, "candidate.smallpen");
  try {
    const directories = new Set([transactionPath]);
    await linkPackageTree(originalPath, candidatePath, directories);
    // Changed files and blobs are always written as new inodes: unlink the
    // shared hard link first so the live Package is never modified in place.
    const replace = async (target, data, encoding) => {
      await rm(target, { force: true });
      await mkdir(dirname(target), { recursive: true });
      directories.add(dirname(target));
      await writeFileDurable(target, data, encoding);
    };
    for (const entry of changedFiles) {
      const target = resolve(candidatePath, entry);
      if (!isWithinRoot(candidatePath, target)) {
        fail("invalid_entry_path", `Changed entry escapes the Package: ${entry}`);
      }
      await assertNoSymlinkAncestors(candidatePath, entry);
      const value =
        entry === "manifest.json"
          ? snapshot.manifest
          : snapshot.entries[entry];
      await replace(target, canonicalJSON(value), "utf8");
    }
    for (const entry of deletedFiles) {
      const target = resolve(candidatePath, entry);
      if (!isWithinRoot(candidatePath, target)) {
        fail("invalid_entry_path", `Deleted entry escapes the Package: ${entry}`);
      }
      await assertNoSymlinkAncestors(candidatePath, entry);
      await rm(target, { force: true });
      directories.add(dirname(target));
    }
    for (const [entry, bytes] of blobWrites) {
      const target = resolve(candidatePath, entry);
      if (!isWithinRoot(candidatePath, target)) {
        fail("invalid_entry_path", `Media blob escapes the Package: ${entry}`);
      }
      await assertNoSymlinkAncestors(candidatePath, entry);
      await replace(target, bytes);
    }
    for (const directory of directories) {
      if (await pathExists(directory)) await syncDirectory(directory);
    }
    return { candidatePath, transactionPath };
  } catch (error) {
    await cleanup([transactionPath]);
    throw error;
  }
}

async function commitCandidate(originalPath, candidatePath, transactionPath) {
  const backupPath = join(
    dirname(originalPath),
    `.${basename(originalPath)}.backup-${randomUUID()}`,
  );
  const journalPath = commitJournalPath(originalPath);
  const journalTemporary = `${journalPath}.${randomUUID()}.tmp`;
  const parent = dirname(originalPath);
  try {
    await writeFileDurable(
      journalTemporary,
      JSON.stringify({ backupPath, candidatePath, transactionPath }),
    );
    await rename(journalTemporary, journalPath);
    await syncDirectory(parent);
  } catch (error) {
    await cleanup([journalTemporary]);
    throw error;
  }
  await rename(originalPath, backupPath);
  try {
    await rename(candidatePath, originalPath);
  } catch (error) {
    try {
      await rename(backupPath, originalPath);
      await cleanup([journalPath]);
    } catch {
      // Keep the journal so the next Package open can complete recovery.
    }
    throw error;
  }
  // The swap must be durable before the backup and journal disappear.
  await syncDirectory(parent);
  await cleanup([backupPath, transactionPath, journalPath]);
}

// A Product's set-active-token-themes may name its Foundation's themes; a
// caller that did not load the Foundation (the Web backend) gets it here.
async function themeSelectionDependencies(locator, before, batch, dependencies) {
  if (
    dependencies.foundation ||
    before.manifest.role !== "product" ||
    !batch?.operations?.some?.((operation) => operation?.type === "set-active-token-themes")
  ) {
    return dependencies;
  }
  const dependency = before.manifest.dependencies[0];
  try {
    const foundation = await openPackageUnlocked(join(dirname(locator), dependency.path));
    return foundation.manifest.packageId === dependency.packageId
      ? { ...dependencies, foundation }
      : dependencies;
  } catch (error) {
    if (error instanceof SmallPenError) return dependencies;
    throw error;
  }
}

async function applyOperationBatchLocked(locator, batch, dependencies = {}) {
  const before = await openPackageUnlocked(locator);
  const blobWrites = batch.blobs ?? new Map();
  if (!(blobWrites instanceof Map)) {
    fail("invalid_blob_writes", "Operation Batch blobs must be a Map");
  }
  for (const [entry, bytes] of blobWrites) {
    before.blobs.set(entry, bytes);
  }
  const prepared = await prepareOperationBatch(
    before,
    batch,
    await themeSelectionDependencies(locator, before, batch, dependencies),
  );
  const referencedBlobs = new Set(
    prepared.snapshot.manifest.entries.assets.flatMap((entry) =>
      [
        ...prepared.snapshot.entries[entry].media.map((media) => media.blob),
        ...prepared.snapshot.entries[entry].fonts.flatMap((font) =>
          font.variants.flatMap((variant) =>
            Object.values(variant.files).map(({ blob }) => blob),
          ),
        ),
      ],
    ),
  );
  for (const entry of blobWrites.keys()) {
    if (!referencedBlobs.has(entry)) {
      fail(
        "unreferenced_blob_write",
        `Operation Batch binary blob is not referenced: ${entry}`,
      );
    }
  }
  const result = {
    ...prepared.result,
    changedFiles: [...new Set([...prepared.result.changedFiles, ...blobWrites.keys()])].sort(),
  };
  if (
    prepared.result.changedFiles.length === 0 &&
    prepared.result.deletedFiles.length === 0
  ) {
    return result;
  }

  const transaction = await writeCandidate(
    before.locator,
    prepared.snapshot,
    prepared.result.changedFiles,
    prepared.result.deletedFiles,
    blobWrites,
  );
  try {
    const validated = await openPackage(transaction.candidatePath);
    if (validated.revision !== prepared.result.revision) {
      fail(
        "candidate_revision_mismatch",
        "Candidate Package revision changed during validation",
        {
          actualRevision: validated.revision,
          expectedRevision: prepared.result.revision,
        },
      );
    }
    await commitCandidate(
      before.locator,
      transaction.candidatePath,
      transaction.transactionPath,
    );
    return result;
  } catch (error) {
    await cleanup([transaction.transactionPath]);
    throw error;
  }
}

// The ledger is a null-prototype map so batch IDs such as "__proto__" stay
// plain keys.
function emptyBatchLedger() {
  return Object.create(null);
}

async function readLedgerFile(path, { expire = true } = {}) {
  let parsed;
  try {
    const info = await lstat(path);
    if (expire && Date.now() - info.mtimeMs > HISTORY_CACHE_IDLE_MS) return emptyBatchLedger();
    parsed = JSON.parse(
      await readRegularFile(path, "utf8", {
        maxBytes: MAX_BATCH_LEDGER_BYTES,
      }),
    );
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    // Reads never erase evidence. A writer archives this exact file before
    // installing a fresh ledger; history reads report the unavailable window.
    process.emitWarning(
      `Unreadable SmallPen batch ledger retained at ${path}: ${error?.message ?? error}`,
      { code: "SMALLPEN_BATCH_LEDGER_UNREADABLE" },
    );
    return Object.assign(emptyBatchLedger(), { [UNREADABLE_BATCH_LEDGER]: { error, path } });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    process.emitWarning(`Malformed SmallPen batch ledger retained at ${path}`, {
      code: "SMALLPEN_BATCH_LEDGER_UNREADABLE",
    });
    return Object.assign(emptyBatchLedger(), { [UNREADABLE_BATCH_LEDGER]: { error: new Error("Invalid batch ledger object"), path } });
  }
  return Object.assign(emptyBatchLedger(), parsed);
}

// Called while the Package write lock is held. A read-only owner can read
// legacy history but never tries to move it or prune cache files.
async function readBatchLedger(packagePath, { migrate = true } = {}) {
  const path = await batchHistoryPath(packagePath);
  if (migrate) {
    try { await pruneHistoryCache(path); }
    catch (error) {
      process.emitWarning(`History cache cleanup failed: ${error.message}`, { code: "SMALLPEN_HISTORY_CACHE_UNAVAILABLE" });
    }
  }
  const cached = await readLedgerFile(path);
  const legacy = `${packagePath}.batches.json`;
  if (!await pathExists(legacy)) return cached ?? emptyBatchLedger();
  if (!migrate) return cached ?? await readLedgerFile(legacy, { expire: false }) ?? emptyBatchLedger();
  try {
    return await migrateBatchLedger(packagePath, path, legacy, cached);
  } catch (error) {
    if (error instanceof SmallPenError) throw error;
    if (!["EACCES", "EPERM", "EROFS", "ENOSPC", "ENOTDIR", "EEXIST"].includes(error.code)) throw error;
    // A cache failure must not prevent saving a valid design. Preserve the
    // old sidecar; the write reports unavailable history if caching also fails.
    process.emitWarning(`Legacy history migration deferred: ${error.message}`, { code: "SMALLPEN_HISTORY_CACHE_UNAVAILABLE" });
    const present = await readLedgerFile(path);
    if (present && !present[UNREADABLE_BATCH_LEDGER]) return present;
    return await readLedgerFile(legacy, { expire: false }) ?? present ?? emptyBatchLedger();
  }
}

async function migrateBatchLedger(packagePath, path, legacy, cached) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (!cached) {
    await moveHistoryFile(legacy, path);
    await utimes(path, new Date(), new Date());
    return await readLedgerFile(path) ?? emptyBatchLedger();
  }
  const older = await readLedgerFile(legacy, { expire: false });
  if (older?.[UNREADABLE_BATCH_LEDGER]) {
    const recoveryPath = `${path}.unreadable-${randomUUID()}.bak`;
    await moveHistoryFile(legacy, recoveryPath);
    process.emitWarning(`Unreadable legacy history preserved at ${recoveryPath}`, { code: "SMALLPEN_BATCH_LEDGER_RECOVERED" });
    return cached;
  }
  if (cached[UNREADABLE_BATCH_LEDGER]) {
    await moveHistoryFile(path, `${path}.unreadable-${randomUUID()}.bak`);
    await moveHistoryFile(legacy, path);
    await utimes(path, new Date(), new Date());
    return await readLedgerFile(path) ?? emptyBatchLedger();
  }
  // During an upgrade an older App can recreate its adjacent ledger. Merge
  // it under the same Package lock, preserving the newer version's records.
  for (const [id, entry] of Object.entries(older ?? {})) {
    if (cached[id] && cached[id].identityHash !== entry?.identityHash)
      fail("batch_id_conflict", "Legacy and cached histories contain different batches with the same ID", { batchId: id, legacyPath: legacy, cachePath: path });
    if (!cached[id] || String(entry?.committedAt) > String(cached[id]?.committedAt)) cached[id] = entry;
  }
  const newest = Object.entries(cached).sort(([, a], [, b]) => String(a?.committedAt ?? "").localeCompare(String(b?.committedAt ?? ""))).at(-1)?.[0];
  await writeBatchLedger(packagePath, newest ? serializeBatchLedger(cached, newest) : "{}\n");
  await rm(legacy);
  await syncDirectory(dirname(legacy));
  return await readLedgerFile(path) ?? emptyBatchLedger();
}

async function moveHistoryFile(source, target) {
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink())
    fail("invalid_batch_history", "Legacy history must be a regular file", { path: source });
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  try {
    await rename(source, target);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    // A malicious sparse legacy file must not fill another filesystem.
    if (info.size > 8 * MAX_BATCH_LEDGER_BYTES)
      fail("batch_history_migration_too_large", "Legacy history is too large to copy to the cache; move it out of the project and retry", { path: source });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await copyFileDurable(source, temporary, fsConstants.COPYFILE_EXCL);
      await rename(temporary, target);
      await syncDirectory(dirname(target));
      await rm(source);
    } finally {
      await cleanup([temporary]);
    }
  }
  await syncDirectory(dirname(target));
  await syncDirectory(dirname(source));
}

async function pruneHistoryCache(path) {
  let names;
  try { names = await readdir(dirname(path)); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const name of names) {
    if (!/^batches\.json(?:\.unreadable-[0-9a-f-]+\.bak)?(?:\.[0-9a-f-]+\.tmp)?$/.test(name)) continue;
    const candidate = join(dirname(path), name);
    const info = await lstat(candidate).catch(error => { if (error.code === "ENOENT") return; throw error; });
    if (info?.isFile() && Date.now() - info.mtimeMs > HISTORY_CACHE_IDLE_MS) await rm(candidate);
  }
}

// Guidance carries the same inverse as inverseBatch. Store it once and
// restore the public reply when replaying, including records from older Apps.
function cachedBatchResult(result, includeInverse = true) {
  const cached = { ...result };
  if (cached.inverseBatch && cached.guidance?.undo) {
    const { batch: _batch, ...args } = cached.guidance.undo.args ?? {};
    cached.guidance = { ...cached.guidance, undo: { ...cached.guidance.undo, args } };
  }
  if (!includeInverse) {
    delete cached.inverseBatch;
    if (cached.guidance) {
      const { undo: _undo, ...guidance } = cached.guidance;
      cached.guidance = guidance;
    }
  }
  return cached;
}

function replayBatchResult(result) {
  if (!result?.inverseBatch || !result.guidance?.undo) return result;
  return { ...result, guidance: { ...result.guidance, undo: {
    ...result.guidance.undo,
    args: { ...result.guidance.undo.args, batch: result.inverseBatch },
  } } };
}

function serializeBatchLedger(ledger, newestBatchId) {
  const entries = Object.entries(ledger).filter(([id]) => id !== newestBatchId).sort(([, left], [, right]) =>
    String(left?.committedAt ?? "").localeCompare(
      String(right?.committedAt ?? ""),
    ),
  );
  // Even a clock adjustment or a future-dated imported record must not evict
  // the write being committed now.
  entries.push([newestBatchId, ledger[newestBatchId]]);
  // Keep a contiguous suffix of complete records. Count UTF-8 bytes of the
  // exact compact JSON that the bounded reader will open, including framing.
  const parts = [];
  let bytes = 3; // braces and final newline
  for (const [id, entry] of entries.reverse()) {
    const record = entry?.result ? { ...entry, result: cachedBatchResult(entry.result) } : entry;
    const part = `${JSON.stringify(id)}:${JSON.stringify(record)}`;
    const size = Buffer.byteLength(part, "utf8");
    if (id === newestBatchId && size + 3 > MAX_BATCH_LEDGER_BYTES)
      fail("batch_history_entry_too_large", "This batch's inverse exceeds the history cache capacity", {
        maxBytes: MAX_BATCH_LEDGER_BYTES, requiredBytes: size + 3,
      });
    if (parts.length >= MAX_BATCH_LEDGER_ENTRIES || bytes + size + (parts.length ? 1 : 0) > MAX_BATCH_LEDGER_BYTES) break;
    bytes += size + (parts.length ? 1 : 0);
    parts.unshift(part);
  }
  return `{${parts.join(",")}}\n`;
}

async function writeBatchLedger(packagePath, serialized, unreadable) {
  const path = await batchHistoryPath(packagePath);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFileDurable(temporary, serialized, "utf8");
    if (unreadable) {
      const recoveryPath = `${path}.unreadable-${randomUUID()}.bak`;
      await moveHistoryFile(unreadable.path, recoveryPath);
      process.emitWarning(`Previous SmallPen batch ledger preserved at ${recoveryPath}`, {
        code: "SMALLPEN_BATCH_LEDGER_RECOVERED", detail: recoveryPath,
      });
    }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await cleanup([temporary]);
  }
}

function hashCanonical(value) {
  return sha256Hex(new TextEncoder().encode(canonicalJSON(value)));
}

// A batch identity is its ID plus everything it was prepared against: the
// same operations at another base revision are a different intent.
function batchIdentityHash(batch) {
  return hashCanonical({
    baseRevision: batch.baseRevision ?? null,
    operations: batch.operations,
    ...(batch.cliIntent ? { cliIntent: batch.cliIntent } : {}),
  });
}

function batchOperationsHash(batch) {
  return hashCanonical({ operations: batch.operations });
}

// SP-039/040: a machine-local cached ledger gives the public CLI stable
// idempotency. A recorded batch ID replays only while its effect is the
// current state, so a replay never writes twice and never reports a
// revision other than the current one as success:
// - current revision is the recorded result: return the recorded
//   confirmation with alreadyApplied:true and write nothing;
// - current revision is the batch's base again (the effect was undone):
//   apply it as a new write;
// - otherwise later writes moved the Package on: fail batch_superseded.
// `options.rebuilt` marks a batch a high-level command rebuilt from the
// current revision with the caller's --batch-id: a retry of the same command
// after success carries the same operations on top of the recorded result.
async function recordedBatchReplay(ledger, batch, readRevision, options = {}) {
  const batchId = batch?.batchId;
  if (typeof batchId !== "string" || !Object.hasOwn(ledger, batchId)) {
    return undefined;
  }
  const recorded = ledger[batchId];
  if (!recorded || typeof recorded !== "object") return undefined;
  const operationsHash = await batchOperationsHash(batch);
  const sameBatch = recorded.identityHash === (await batchIdentityHash(batch));
  const sameCommandRetry =
    typeof recorded.identityHash === "string" &&
    options.rebuilt === true &&
    (recorded.operationsHash === operationsHash ||
      (batch.cliIntent && recorded.cliIntentHash === await hashCanonical(batch.cliIntent))) &&
    typeof batch.baseRevision === "string";
  if (!sameBatch && !sameCommandRetry) {
    fail(
      "batch_id_conflict",
      "Batch ID was already committed with a different base revision or operations",
      {
        batchId,
        committedRevision: recorded.revision,
        correction:
          "A batchId names one committed intent. Retrying it replays only the identical batch (same baseRevision and operations, or the same high-level command input); for any other change pick a new unique batchId.",
      },
    );
  }
  const currentRevision = await readRevision();
  if (currentRevision === recorded.revision) {
    batch.operations.forEach(checkOperationShape);
    return { ...replayBatchResult(recorded.result), alreadyApplied: true };
  }
  if (
    (sameBatch && currentRevision === batch.baseRevision) ||
    (sameCommandRetry && recorded.baseRevision === currentRevision && batch.baseRevision === currentRevision)
  ) return undefined;
  fail(
    "batch_superseded",
    "Batch ID was already committed, and later writes changed the Package",
    {
      batchId,
      committedRevision: recorded.revision,
      currentRevision,
      correction:
        "Do not resend this batch. Read the Package at currentRevision, check whether the intent still holds, and build any further change against currentRevision with a new unique batchId.",
    },
  );
}

function currentRevisionReader(packagePath) {
  return async () => (await openPackageUnlocked(packagePath)).revision;
}

// The committed batches, oldest first: what each changed, when, from which
// revision, and the inverse that restores the revision before it, when cached.
// The design stays unchanged; caches can migrate or expire on access.
// `smallpen changes` rebuilds an earlier revision from the retained records.
export async function readBatchHistory(locator) {
  const resolvedPackagePath = await resolvePackageRoot(await lockTarget(locator));
  let release;
  try { release = await acquireWriteLock(resolvedPackagePath); }
  catch (error) { if (error.code !== "package_not_writable") throw error; }
  try {
    if (release) await recoverInterruptedCommit(resolvedPackagePath);
    const ledger = await readBatchLedger(resolvedPackagePath, { migrate: Boolean(release) });
    if (ledger[UNREADABLE_BATCH_LEDGER])
      fail("batch_history_unavailable", "The history cannot be read; its original file is preserved", {
        ledgerPath: ledger[UNREADABLE_BATCH_LEDGER].path, ...BATCH_HISTORY_LIMITS,
      });
    return Object.entries(ledger)
    .map(([batchId, entry]) => ({
      affectedIds: entry?.result?.affectedIds ?? [],
      baseRevision: entry?.baseRevision,
      batchId,
      committedAt: entry?.committedAt,
      inverseBatch: entry?.result?.inverseBatch,
      ...(entry?.result?.history ? { history: entry.result.history } : {}),
      revision: entry?.revision ?? entry?.result?.revision,
      // CLI writes carry the intent that produced them; App edits do not.
      source: entry?.cliIntentHash ? "cli" : "app",
    }))
      .sort((left, right) => String(left.committedAt ?? "").localeCompare(String(right.committedAt ?? "")));
  } finally {
    await release?.();
  }
}

// Public replay check used by the CLI before stale-revision validation and
// before high-level commands rebuild a batch: a committed batch identity
// replays its recorded confirmation instead of failing or writing again.
export async function replayRecordedBatch(locator, batch, options = {}) {
  const packagePath = await lockTarget(locator);
  let release;
  try {
    release = await acquireWriteLock(packagePath);
  } catch (error) {
    // Nothing commits where this process cannot lock; read the ledger as is.
    if (error?.code !== "package_not_writable") throw error;
    const resolvedPackagePath = await resolvePackageRoot(packagePath);
    return recordedBatchReplay(
      await readBatchLedger(resolvedPackagePath, { migrate: false }),
      batch,
      currentRevisionReader(resolvedPackagePath),
      options,
    );
  }
  try {
    await recoverInterruptedCommit(packagePath);
    const resolvedPackagePath = await resolvePackageRoot(packagePath);
    return await recordedBatchReplay(
      await readBatchLedger(resolvedPackagePath),
      batch,
      currentRevisionReader(resolvedPackagePath),
      options,
    );
  } finally {
    await release();
  }
}

// `options.onCommitted(snapshot)` receives the Package as it stands right
// after this batch, read while the write lock is still held, so callers never
// mistake a later external write for their own commit.
export async function applyOperationBatch(locator, batch, options = {}) {
  const packagePath = await lockTarget(locator);
  const release = await acquireWriteLock(packagePath);
  try {
    await recoverInterruptedCommit(packagePath);
    const resolvedPackagePath = await resolvePackageRoot(packagePath);
    await removeAbandonedCommitFiles(resolvedPackagePath);
    const ledger = await readBatchLedger(resolvedPackagePath);
    let result = await recordedBatchReplay(
      ledger,
      batch,
      currentRevisionReader(resolvedPackagePath),
    );
    if (!result) {
      result = await applyOperationBatchLocked(
        resolvedPackagePath,
        batch,
        options.dependencies,
      );
      if (Array.isArray(batch?.operations)) {
        try {
          ledger[batch.batchId] = {
            baseRevision: batch.baseRevision,
            committedAt: new Date().toISOString(),
            identityHash: await batchIdentityHash(batch),
            operationsHash: await batchOperationsHash(batch),
            ...(batch.cliIntent ? { cliIntentHash: await hashCanonical(batch.cliIntent) } : {}),
            result,
            revision: result.revision,
          };
          let serialized;
          try {
            serialized = serializeBatchLedger(ledger, batch.batchId);
          } catch (error) {
            if (error.code !== "batch_history_entry_too_large") throw error;
            // Saving the design does not depend on auxiliary cache capacity.
            // Keep the small confirmation so a timeout retry cannot write twice.
            result = { ...result, history: {
              status: "partial", reason: "inverse_exceeds_capacity", replayRetained: true,
              ...error.details,
              message: "Design saved and retry receipt retained; the inverse exceeds the history cache capacity. Read the current design when an older revision cannot be reconstructed.",
            } };
            ledger[batch.batchId].result = cachedBatchResult(result, false);
            serialized = serializeBatchLedger(ledger, batch.batchId);
          }
          await writeBatchLedger(resolvedPackagePath, serialized, ledger[UNREADABLE_BATCH_LEDGER]);
        } catch (error) {
          // The canonical commit stands, but callers must know replay and
          // changes tracking were not recorded instead of assuming success.
          result = { ...result, history: { status: "unavailable", message: error.message,
            ledgerPath: await batchHistoryPath(resolvedPackagePath) } };
          process.emitWarning(`Design saved but batch history was not recorded: ${error.message}`, {
            code: "SMALLPEN_BATCH_LEDGER_WRITE_FAILED",
          });
        }
      }
    }
    if (options.onCommitted) {
      options.onCommitted(await openPackageUnlocked(resolvedPackagePath));
    }
    return result;
  } finally {
    await release();
  }
}

// Helper writes (media, fonts) get a fresh identity per call: the same
// intent can legitimately repeat (import, remove, import again).
function helperBatchId(kind, id) {
  return `${kind}_${String(id).slice(0, 120)}_${randomUUID()}`;
}

export async function importMedia(
  locator,
  { bytes, height, id, mimeType, name, path = "", width },
  options = {},
) {
  if (!(bytes instanceof Uint8Array)) {
    fail("invalid_media_blob", "Imported Media bytes must be a Uint8Array");
  }
  const before = await openPackage(locator);
  const entry = before.manifest.entries.assets[0] ?? "assets/assets.json";
  const library = before.manifest.entries.assets[0]
    ? structuredClone(before.entries[entry])
    : { colors: [], fonts: [], id: "alib_design", media: [], typographies: [] };
  const existing = library.media.find((media) => media.id === id);
  if (existing) {
    fail("duplicate_media_id", `Media already exists: ${id}`, {
      descriptor: existing,
    });
  }
  const sha256 = await sha256Hex(bytes);
  const blob = `blobs/${sha256}`;
  const descriptor = {
    blob,
    byteLength: bytes.byteLength,
    height,
    id,
    mimeType,
    name,
    path,
    sha256,
    width,
  };
  library.media.push(descriptor);
  const result = await replaceAssetLibrary(
    locator,
    before,
    entry,
    library,
    helperBatchId("import", id),
    new Map([[blob, bytes]]),
    options,
  );
  return { descriptor, result };
}

export async function removeMedia(locator, mediaId, options = {}) {
  const before = await openPackage(locator);
  if (!before.manifest.entries.assets[0]) {
    fail("missing_media", `Media does not exist: ${mediaId}`);
  }
  const { entry, library } = assetLibraryForWrite(before);
  if (!library.media.some((media) => media.id === mediaId)) {
    fail("missing_media", `Media does not exist: ${mediaId}`);
  }
  library.media = library.media.filter((media) => media.id !== mediaId);
  return replaceAssetLibrary(
    locator,
    before,
    entry,
    library,
    helperBatchId("remove", mediaId),
    undefined,
    options,
  );
}

function assetLibraryForWrite(snapshot) {
  const entry = snapshot.manifest.entries.assets[0] ?? "assets/assets.json";
  const library = snapshot.manifest.entries.assets[0]
    ? structuredClone(snapshot.entries[entry])
    : { colors: [], fonts: [], id: "alib_design", media: [], typographies: [] };
  return { entry, library };
}

async function replaceAssetLibrary(
  locator,
  before,
  entry,
  library,
  batchId,
  blobs,
  options,
) {
  return applyOperationBatch(
    locator,
    {
      baseRevision: before.revision,
      batchId,
      ...(blobs ? { blobs } : {}),
      operations: [
        {
          ...(before.manifest.entries.assets[0] ? {} : { entry }),
          library,
          type: "replace-asset-library",
        },
      ],
    },
    options,
  );
}

export async function importFontVariant(
  locator,
  { family, files, fontId, id, name, style, weight },
  options = {},
) {
  files = prepareFontFiles(Object.fromEntries(Object.values(files).map(file => [file.mimeType, file.bytes])));
  const before = await openPackage(locator);
  const { entry, library } = assetLibraryForWrite(before);
  let font = library.fonts.find((candidate) => candidate.id === fontId);
  if (font && font.family !== family) {
    fail("font_family_mismatch", `Font family does not match ${fontId}`);
  }
  if (!font) {
    font = { family, id: fontId, variants: [] };
    library.fonts.push(font);
  }
  if (
    font.variants.some(
      (variant) =>
        variant.id === id ||
        (variant.style === style && variant.weight === weight),
    )
  ) {
    fail(
      "duplicate_font_variant",
      `Font Variant already exists: ${fontId}/${style}-${weight}`,
    );
  }
  const blobs = new Map();
  const descriptors = {};
  for (const [format, { bytes, mimeType }] of Object.entries(files)) {
    if (!(bytes instanceof Uint8Array)) {
      fail("invalid_font_blob", `Imported Font ${format} must be a Uint8Array`);
    }
    const sha256 = await sha256Hex(bytes);
    const blob = `blobs/${sha256}`;
    blobs.set(blob, bytes);
    descriptors[format] = {
      blob,
      byteLength: bytes.byteLength,
      mimeType,
      sha256,
    };
  }
  if (!["ttf", "otf", "woff"].some((format) => descriptors[format])) {
    fail("unsupported_font_conversion", "Imported Font Variant must include TTF, OTF or WOFF");
  }
  const variant = { files: descriptors, id, name, style, weight };
  font.variants.push(variant);
  const result = await replaceAssetLibrary(
    locator,
    before,
    entry,
    library,
    helperBatchId("import", id),
    blobs,
    options,
  );
  return { result, variant };
}

export async function updateFontFamily(locator, fontId, family, options = {}) {
  const before = await openPackage(locator);
  const { entry, library } = assetLibraryForWrite(before);
  const font = library.fonts.find(({ id }) => id === fontId);
  if (!font) fail("missing_font", `Font does not exist: ${fontId}`);
  font.family = family;
  return replaceAssetLibrary(
    locator,
    before,
    entry,
    library,
    helperBatchId("update", fontId),
    undefined,
    options,
  );
}

export async function deleteFontFamily(locator, fontId, options = {}) {
  const before = await openPackage(locator);
  const { entry, library } = assetLibraryForWrite(before);
  const index = library.fonts.findIndex(({ id }) => id === fontId);
  if (index < 0) fail("missing_font", `Font does not exist: ${fontId}`);
  library.fonts.splice(index, 1);
  return replaceAssetLibrary(
    locator,
    before,
    entry,
    library,
    helperBatchId("delete", fontId),
    undefined,
    options,
  );
}

export async function deleteFontVariant(locator, fontVariantId, options = {}) {
  const before = await openPackage(locator);
  const { entry, library } = assetLibraryForWrite(before);
  const font = library.fonts.find((candidate) =>
    candidate.variants.some(({ id }) => id === fontVariantId),
  );
  if (!font) {
    fail("missing_font_variant", `Font Variant does not exist: ${fontVariantId}`);
  }
  font.variants = font.variants.filter(({ id }) => id !== fontVariantId);
  if (font.variants.length === 0) {
    library.fonts = library.fonts.filter(({ id }) => id !== font.id);
  }
  return replaceAssetLibrary(
    locator,
    before,
    entry,
    library,
    helperBatchId("delete", fontVariantId),
    undefined,
    options,
  );
}
