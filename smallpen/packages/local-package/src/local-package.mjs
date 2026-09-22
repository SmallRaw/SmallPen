import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import {
  canonicalJSON,
  fail,
  listPackageEntries,
  loadPackageFromValues,
  prepareOperationBatch,
  sha256Hex,
  SmallPenError,
} from "@smallpen/core";

function isWithinRoot(rootPath, candidatePath) {
  const child = relative(rootPath, candidatePath);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

const execFileAsync = promisify(execFile);

async function processIdentity(pid) {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]);
    const value = stdout.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function commitJournalPath(packagePath) {
  return join(dirname(packagePath), `.${basename(packagePath)}.commit.json`);
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
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
    !basename(transactionPath).startsWith(".smallpen-transaction-") ||
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
    journal = JSON.parse(await readFile(journalPath, "utf8"));
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
  return entryPath;
}

async function readJson(path, code, details) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
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
      values.set(path, await readFile(await resolveEntry(packagePath, path)));
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

async function abandonedWriteClaim(claimPath) {
  let owner;
  try {
    owner = JSON.parse(await readFile(claimPath, "utf8"));
  } catch {
    let info;
    try {
      info = await lstat(claimPath);
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      throw error;
    }
    return Date.now() - info.mtimeMs > 1000;
  }
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) {
    const info = await lstat(claimPath);
    return Date.now() - info.mtimeMs > 1000;
  }
  try {
    process.kill(owner.pid, 0);
    const currentIdentity = await processIdentity(owner.pid);
    return Boolean(
      owner.processIdentity &&
      currentIdentity &&
      owner.processIdentity !== currentIdentity
    );
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

function orderedWriteClaims(names) {
  return names
    .filter((name) => name === "owner.json" || /^\d{16}-.+\.json$/.test(name))
    .sort((left, right) => {
      if (left === "owner.json") return -1;
      if (right === "owner.json") return 1;
      return left.localeCompare(right);
    });
}

async function activeWriteClaim(activePath) {
  try {
    const value = JSON.parse(await readFile(activePath, "utf8"));
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
  const lockPath = join(
    dirname(packagePath),
    `.${basename(packagePath)}.write-lock`,
  );
  const ownerProcessIdentity = await processIdentity(process.pid);
  await mkdir(lockPath, { recursive: true });
  const claimName = `${String(Date.now()).padStart(16, "0")}-${randomUUID()}.json`;
  const claimPath = join(lockPath, claimName);
  const activePath = join(lockPath, "active");
  await writeFile(
    claimPath,
    JSON.stringify({
      createdAt: new Date().toISOString(),
      pid: process.pid,
      processIdentity: ownerProcessIdentity,
    }),
    { flag: "wx" },
  );
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
          return () => releaseWriteClaim(
            activePath,
            claimName,
            claimPath,
          );
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
    await releaseWriteClaim(activePath, claimName, claimPath);
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
  const release = await acquireWriteLock(target);
  try {
    await recoverInterruptedCommit(target);
    return await openPackageUnlocked(target);
  } finally {
    await release();
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
    join(dirname(originalPath), ".smallpen-transaction-"),
  );
  const candidatePath = join(transactionPath, "candidate.smallpen");
  try {
    await cp(originalPath, candidatePath, { recursive: true });
    for (const entry of changedFiles) {
      const target = join(candidatePath, entry);
      const value =
        entry === "manifest.json"
          ? snapshot.manifest
          : snapshot.entries[entry];
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, canonicalJSON(value), "utf8");
    }
    for (const entry of deletedFiles) {
      const target = resolve(candidatePath, entry);
      if (!isWithinRoot(candidatePath, target)) {
        fail("invalid_entry_path", `Deleted entry escapes the Package: ${entry}`);
      }
      await rm(target, { force: true });
    }
    for (const [entry, bytes] of blobWrites) {
      const target = resolve(candidatePath, entry);
      if (!isWithinRoot(candidatePath, target)) {
        fail("invalid_entry_path", `Media blob escapes the Package: ${entry}`);
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
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
  try {
    await writeFile(
      journalTemporary,
      JSON.stringify({ backupPath, candidatePath, transactionPath }),
      { flag: "wx" },
    );
    await rename(journalTemporary, journalPath);
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
  await cleanup([backupPath, transactionPath, journalPath]);
}

async function applyOperationBatchLocked(locator, batch) {
  const before = await openPackageUnlocked(locator);
  const blobWrites = batch.blobs ?? new Map();
  if (!(blobWrites instanceof Map)) {
    fail("invalid_blob_writes", "Operation Batch blobs must be a Map");
  }
  for (const [entry, bytes] of blobWrites) {
    before.blobs.set(entry, bytes);
  }
  const prepared = await prepareOperationBatch(before, batch);
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
  if (
    prepared.result.changedFiles.length === 0 &&
    prepared.result.deletedFiles.length === 0
  ) {
    return prepared.result;
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
    return {
      ...prepared.result,
      changedFiles: [
        ...new Set([...prepared.result.changedFiles, ...blobWrites.keys()]),
      ].sort(),
    };
  } catch (error) {
    await cleanup([transaction.transactionPath]);
    throw error;
  }
}

function batchLedgerPath(packagePath) {
  return `${packagePath}.batches.json`;
}

async function readBatchLedger(packagePath) {
  try {
    const parsed = JSON.parse(
      await readFile(batchLedgerPath(packagePath), "utf8"),
    );
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

async function writeBatchLedger(packagePath, ledger) {
  const temporary = `${batchLedgerPath(packagePath)}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`);
  await rename(temporary, batchLedgerPath(packagePath));
}

// SP-039/040: a process-local batch ledger gives the public CLI stable
// idempotency. Replaying the same batch identity with the same operations
// returns the recorded confirmation without a second write; replaying the same
// identity with different operations is rejected with a correction path.
// Public replay check used by the CLI before stale-revision validation: an
// already-committed batch identity with identical operations replays its
// recorded confirmation instead of failing or writing again.
export async function replayRecordedBatch(locator, batch) {
  const packagePath = await lockTarget(locator);
  const release = await acquireWriteLock(packagePath);
  try {
    const resolvedPackagePath = await resolvePackageRoot(packagePath);
    const ledger = await readBatchLedger(resolvedPackagePath);
    const recorded = ledger[batch?.batchId];
    if (!recorded) return undefined;
    const operationsHash = await sha256Hex(
      new TextEncoder().encode(canonicalJSON({ operations: batch.operations ?? [] })),
    );
    if (recorded.operationsHash !== operationsHash) {
      fail(
        "batch_id_conflict",
        "Batch ID was already committed with different operations",
        {
          batchId: batch.batchId,
          committedRevision: recorded.revision,
          correction:
            "Pick a new unique batchId for the different intent; do not reuse committed batch identities.",
        },
      );
    }
    return { ...recorded.result, alreadyApplied: true };
  } finally {
    await release();
  }
}

export async function applyOperationBatch(locator, batch) {
  const packagePath = await lockTarget(locator);
  const release = await acquireWriteLock(packagePath);
  try {
    await recoverInterruptedCommit(packagePath);
    const resolvedPackagePath = await resolvePackageRoot(packagePath);
    const ledger = await readBatchLedger(resolvedPackagePath);
    const recorded = ledger[batch?.batchId];
    if (recorded) {
      const operationsHash = await sha256Hex(
        new TextEncoder().encode(canonicalJSON({ operations: batch.operations ?? [] })),
      );
      if (recorded.operationsHash !== operationsHash) {
        fail(
          "batch_id_conflict",
          "Batch ID was already committed with different operations",
          {
            batchId: batch.batchId,
            committedRevision: recorded.revision,
            correction:
              "Pick a new unique batchId for the different intent; do not reuse committed batch identities.",
          },
        );
      }
      return {
        ...recorded.result,
        alreadyApplied: true,
        revision: recorded.result.revision,
      };
    }
    const result = await applyOperationBatchLocked(resolvedPackagePath, batch);
    if (!result.alreadyApplied && Array.isArray(batch?.operations)) {
      try {
        ledger[batch.batchId] = {
          committedAt: new Date().toISOString(),
          operationsHash: await sha256Hex(
            new TextEncoder().encode(
              canonicalJSON({ operations: batch.operations ?? [] }),
            ),
          ),
          result,
          revision: result.revision,
        };
        await writeBatchLedger(resolvedPackagePath, ledger);
      } catch {
        // Ledger persistence is best-effort; the canonical commit stands.
      }
    }
    return result;
  } finally {
    await release();
  }
}

export async function importMedia(
  locator,
  { bytes, height, id, mimeType, name, path = "", width },
) {
  if (!(bytes instanceof Uint8Array)) {
    fail("invalid_media_blob", "Imported Media bytes must be a Uint8Array");
  }
  const before = await openPackage(locator);
  const entry = before.manifest.entries.assets[0] ?? "assets/assets.json";
  const library = before.manifest.entries.assets[0]
    ? structuredClone(before.entries[entry])
    : { colors: [], fonts: [], id: "alib_design", media: [], typographies: [] };
  if (library.media.some((media) => media.id === id)) {
    fail("duplicate_media_id", `Media already exists: ${id}`);
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
  const result = await applyOperationBatch(locator, {
    baseRevision: before.revision,
    batchId: `import_${id}`,
    blobs: new Map([[blob, bytes]]),
    operations: [
      {
        ...(before.manifest.entries.assets[0] ? {} : { entry }),
        library,
        type: "replace-asset-library",
      },
    ],
  });
  return { descriptor, result };
}

export async function removeMedia(locator, mediaId) {
  const before = await openPackage(locator);
  if (!before.manifest.entries.assets[0]) {
    fail("missing_media", `Media does not exist: ${mediaId}`);
  }
  const { entry, library } = assetLibraryForWrite(before);
  if (!library.media.some((media) => media.id === mediaId)) {
    fail("missing_media", `Media does not exist: ${mediaId}`);
  }
  library.media = library.media.filter((media) => media.id !== mediaId);
  return replaceAssetLibrary(locator, before, entry, library, `remove_${mediaId}`);
}

function assetLibraryForWrite(snapshot) {
  const entry = snapshot.manifest.entries.assets[0] ?? "assets/assets.json";
  const library = snapshot.manifest.entries.assets[0]
    ? structuredClone(snapshot.entries[entry])
    : { colors: [], fonts: [], id: "alib_design", media: [], typographies: [] };
  return { entry, library };
}

async function replaceAssetLibrary(locator, before, entry, library, batchId, blobs) {
  return applyOperationBatch(locator, {
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
  });
}

export async function importFontVariant(
  locator,
  { family, files, fontId, id, name, style, weight },
) {
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
  if (!descriptors.woff) {
    fail("missing_font_woff", "Imported Font Variant must include a WOFF file");
  }
  const variant = { files: descriptors, id, name, style, weight };
  font.variants.push(variant);
  const result = await replaceAssetLibrary(
    locator,
    before,
    entry,
    library,
    `import_${id}`,
    blobs,
  );
  return { result, variant };
}

export async function updateFontFamily(locator, fontId, family) {
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
    `update_${fontId}`,
  );
}

export async function deleteFontFamily(locator, fontId) {
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
    `delete_${fontId}`,
  );
}

export async function deleteFontVariant(locator, fontVariantId) {
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
    `delete_${fontVariantId}`,
  );
}
