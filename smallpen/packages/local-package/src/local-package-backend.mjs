import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  canonicalJSON,
  loadPackageFromValues,
  SmallPenError,
  SMALLPEN_RUNTIME_CAPABILITIES,
} from "@smallpen/core";

import {
  applyOperationBatch,
  deleteFontFamily as deletePackageFontFamily,
  deleteFontVariant as deletePackageFontVariant,
  importFontVariant as importPackageFontVariant,
  importMedia as importPackageMedia,
  openPackage,
  updateFontFamily as updatePackageFontFamily,
} from "./local-package.mjs";

const MAX_CHANGE_HISTORY = 200;
const DEFAULT_TOKEN_ENTRY = "tokens/tokens.json";
// File systems with coarse timestamps (HFS+, FAT) can hide a same-size edit
// made in the same timestamp granule as the fingerprint. A fingerprint that
// contains a timestamp this recent is never trusted to skip a reload.
const FINGERPRINT_SETTLE_MS = 2000;

// A cheap stat-only fingerprint of the Package directory, its manifest, its
// entries, its blob directory, and its blobs. Commits replace the whole
// directory, and external edits change a file's size or timestamps, so an
// unchanged fingerprint means a full reload would read the same content.
async function packageFingerprint(packagePath, entries) {
  const parts = [];
  let newest = 0n;
  for (const path of [
    packagePath,
    join(packagePath, "manifest.json"),
    join(packagePath, "blobs"),
    ...entries.map((entry) => join(packagePath, entry)),
  ]) {
    try {
      const info = await lstat(path, { bigint: true });
      parts.push(`${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`);
      for (const time of [info.mtimeMs, info.ctimeMs]) {
        if (time > newest) newest = time;
      }
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") return undefined;
      parts.push("-");
    }
  }
  if (Date.now() - Number(newest) < FINGERPRINT_SETTLE_MS) return undefined;
  return parts.join("|");
}

// Blobs are listed too: an in-place blob edit changes no entry or directory.
function diskEntries(snapshot) {
  return [
    ...Object.values(snapshot.manifest.entries).flat(),
    ...[...snapshot.blobs.keys()].sort(),
  ];
}

// Projects an in-memory default Token library into a Package that has none,
// so opening never writes. The first commit made against the projected
// revision persists the library together with the edit.
async function projectDefaultTokenLibrary(snapshot, library) {
  if (!library || snapshot.manifest.entries.tokens.length > 0) return snapshot;
  const manifest = structuredClone(snapshot.manifest);
  manifest.entries.tokens = [DEFAULT_TOKEN_ENTRY];
  const values = new Map([["manifest.json", manifest]]);
  for (const [entry, value] of Object.entries(snapshot.entries)) {
    values.set(entry, structuredClone(value));
  }
  values.set(DEFAULT_TOKEN_ENTRY, structuredClone(library));
  for (const [blob, bytes] of snapshot.blobs) values.set(blob, bytes);
  return loadPackageFromValues(snapshot.locator, values);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameCanonical(left, right) {
  return canonicalJSON(left) === canonicalJSON(right);
}

function changedStableIds(before, after, result) {
  if (sameCanonical(before, after)) return;
  for (const candidate of [before, after]) {
    if (isRecord(candidate) && typeof candidate.id === "string") {
      result.add(candidate.id);
    }
  }
  if (Array.isArray(before) || Array.isArray(after)) {
    const left = Array.isArray(before) ? before : [];
    const right = Array.isArray(after) ? after : [];
    const keyed = [...left, ...right].every(
      (value) => isRecord(value) && typeof value.id === "string",
    );
    if (keyed) {
      const leftById = new Map(left.map((value) => [value.id, value]));
      const rightById = new Map(right.map((value) => [value.id, value]));
      for (const id of new Set([...leftById.keys(), ...rightById.keys()])) {
        changedStableIds(leftById.get(id), rightById.get(id), result);
      }
    } else {
      for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        changedStableIds(left[index], right[index], result);
      }
    }
    return;
  }
  if (isRecord(before) || isRecord(after)) {
    const left = isRecord(before) ? before : {};
    const right = isRecord(after) ? after : {};
    for (const field of new Set([...Object.keys(left), ...Object.keys(right)])) {
      changedStableIds(left[field], right[field], result);
    }
  }
}

function externalChange(before, after) {
  const changedFiles = [];
  const affectedIds = new Set();
  if (!sameCanonical(before.manifest, after.manifest)) {
    changedFiles.push("manifest.json");
    changedStableIds(before.manifest, after.manifest, affectedIds);
  }
  const entries = new Set([
    ...Object.keys(before.entries),
    ...Object.keys(after.entries),
  ]);
  for (const entry of [...entries].sort()) {
    if (sameCanonical(before.entries[entry], after.entries[entry])) continue;
    changedFiles.push(entry);
    changedStableIds(before.entries[entry], after.entries[entry], affectedIds);
  }
  for (const blob of new Set([...before.blobs.keys(), ...after.blobs.keys()])) {
    if (before.blobs.has(blob) !== after.blobs.has(blob)) changedFiles.push(blob);
  }
  return {
    affectedIds: [...affectedIds].sort(),
    batchId: null,
    changedFiles: changedFiles.sort(),
    revision: after.revision,
    source: "external",
  };
}

function errorDescriptor(error) {
  return {
    code: error instanceof SmallPenError ? error.code : "invalid_external_state",
    details: error instanceof SmallPenError ? error.details : {},
    message: error instanceof Error ? error.message : String(error),
  };
}

export class LocalPackageBackend {
  #changeSequence = 0;
  #confirmedBatches = new Map();
  #commitQueue = Promise.resolve();
  #defaultTokenLibrary;
  #diskEntries = [];
  #fingerprint;
  #listeners = new Set();
  #packagePath;
  #pollTimer;
  #projection;
  #refreshPromise;
  #redoStack = [];
  #timer;
  #undoStack = [];
  #watchers = [];

  changes = [];
  snapshot;
  status = { readOnly: true, state: "closed" };

  // `defaultTokenLibrary`: when set, a Package without Token entries is
  // served with this library projected in memory (see
  // projectDefaultTokenLibrary); nothing is written until the first commit.
  constructor({ defaultTokenLibrary } = {}) {
    this.#defaultTokenLibrary = defaultTokenLibrary
      ? structuredClone(defaultTokenLibrary)
      : undefined;
  }

  capabilities() {
    return structuredClone(SMALLPEN_RUNTIME_CAPABILITIES);
  }

  async open(locator) {
    await this.close();
    this.#confirmedBatches.clear();
    this.#redoStack = [];
    this.#undoStack = [];
    this.#changeSequence = 0;
    this.changes = [];
    const disk = await openPackage(resolve(locator));
    this.#packagePath = disk.locator;
    this.snapshot = await this.#project(disk);
    this.#fingerprint = undefined;
    this.#markReady();
    this.#startWatchers();
    return this.snapshot;
  }

  async #project(disk) {
    const snapshot = await projectDefaultTokenLibrary(
      disk,
      this.#defaultTokenLibrary,
    );
    this.#projection =
      snapshot === disk
        ? undefined
        : { diskRevision: disk.revision };
    this.#diskEntries = diskEntries(disk);
    return snapshot;
  }

  // A batch prepared against the projected revision is rebased onto the
  // Package on disk with the projected default Token library prepended, so
  // the commit persists exactly the state the client edited.
  #diskBatch(batch) {
    if (!this.#projection || batch?.baseRevision !== this.snapshot?.revision) {
      return batch;
    }
    return {
      ...batch,
      baseRevision: this.#projection.diskRevision,
      operations: Array.isArray(batch.operations)
        ? [
            {
              entry: DEFAULT_TOKEN_ENTRY,
              library: structuredClone(this.#defaultTokenLibrary),
              type: "replace-token-library",
            },
            ...batch.operations,
          ]
        : batch.operations,
    };
  }

  commit(batch, options = {}) {
    return this.#commit(batch, options.historyMode ?? "normal");
  }

  async undo() {
    const batch = this.#undoStack.pop();
    if (!batch) {
      throw new SmallPenError("nothing_to_undo", "Local Package history has no Undo");
    }
    try {
      return await this.#commit(
        { ...batch, batchId: `undo_${randomUUID()}` },
        "undo",
      );
    } catch (error) {
      this.#undoStack.push(batch);
      throw error;
    }
  }

  async redo() {
    const batch = this.#redoStack.pop();
    if (!batch) {
      throw new SmallPenError("nothing_to_redo", "Local Package history has no Redo");
    }
    try {
      return await this.#commit(
        { ...batch, batchId: `redo_${randomUUID()}` },
        "redo",
      );
    } catch (error) {
      this.#redoStack.push(batch);
      throw error;
    }
  }

  async save() {
    await this.#commitQueue;
    const refreshed = await this.refresh();
    if (!refreshed) {
      throw new SmallPenError(
        "repair_required",
        "Save cannot validate the current external Package state",
        { status: this.status },
      );
    }
    return {
      revision: refreshed.revision,
      status: "saved",
    };
  }

  importMedia(media) {
    return this.#write(async (options) => {
      const imported = await importPackageMedia(this.#packagePath, media, options);
      return { result: imported.result, value: imported };
    });
  }

  importFontVariant(font) {
    return this.#write(async (options) => {
      const imported = await importPackageFontVariant(
        this.#packagePath,
        font,
        options,
      );
      return { result: imported.result, value: imported };
    });
  }

  updateFontFamily(fontId, family) {
    return this.#write(async (options) => ({
      result: await updatePackageFontFamily(
        this.#packagePath,
        fontId,
        family,
        options,
      ),
    }));
  }

  deleteFontFamily(fontId) {
    return this.#write(async (options) => ({
      result: await deletePackageFontFamily(this.#packagePath, fontId, options),
    }));
  }

  deleteFontVariant(fontVariantId) {
    return this.#write(async (options) => ({
      result: await deletePackageFontVariant(
        this.#packagePath,
        fontVariantId,
        options,
      ),
    }));
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  refresh() {
    if (this.#refreshPromise) return this.#refreshPromise;
    const running = this.#performRefresh();
    const tracked = running.finally(() => {
      if (this.#refreshPromise === tracked) this.#refreshPromise = undefined;
    });
    this.#refreshPromise = tracked;
    return tracked;
  }

  async #performRefresh() {
    if (!this.#packagePath) return undefined;
    try {
      // Stat before reading: a change that lands during the read alters the
      // next fingerprint, so it is never hidden behind this one.
      const entries = this.#diskEntries;
      const fingerprint = await packageFingerprint(this.#packagePath, entries);
      if (
        fingerprint !== undefined &&
        fingerprint === this.#fingerprint &&
        this.status.state === "ready"
      ) {
        return this.snapshot;
      }
      const next = await this.#project(await openPackage(this.#packagePath));
      this.#fingerprint =
        canonicalJSON(entries) === canonicalJSON(this.#diskEntries)
          ? fingerprint
          : undefined;
      const recovered = this.status.state === "repair";
      if (next.revision === this.snapshot?.revision) {
        this.#markReady();
        if (recovered) {
          this.#startWatchers();
          this.#emit({ snapshot: next, type: "external-recovered" });
        }
        return next;
      }
      const before = this.snapshot;
      const change = externalChange(before, next);
      // Every local inverse batch targets a revision that no longer exists,
      // so Undo and Redo could only fail with stale_revision from here on.
      const historyCleared =
        this.#undoStack.length > 0 || this.#redoStack.length > 0;
      this.#redoStack = [];
      this.#undoStack = [];
      this.snapshot = next;
      this.#markReady();
      this.#recordChange(change);
      this.#startWatchers();
      this.#emit({
        change,
        historyCleared,
        snapshot: next,
        type: "external-revision",
      });
      return next;
    } catch (error) {
      const alreadyRepair = this.status.state === "repair";
      this.status = {
        error: errorDescriptor(error),
        lastValidRevision: this.snapshot?.revision,
        readOnly: true,
        state: "repair",
      };
      // The last valid snapshot stays served read-only. The transition event is
      // emitted once per failure episode; re-emitting it on every poll would
      // keep waking clients that have already entered Repair.
      if (!alreadyRepair) {
        this.#emit({ error, snapshot: this.snapshot, status: this.status, type: "invalid-external-state" });
      }
      this.#fingerprint = undefined;
      return undefined;
    }
  }

  async close() {
    await this.#commitQueue;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#closeWatchers();
    await this.#refreshPromise;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#closeWatchers();
    this.#packagePath = undefined;
    this.#diskEntries = [];
    this.#fingerprint = undefined;
    this.#projection = undefined;
    this.snapshot = undefined;
    this.status = { readOnly: true, state: "closed" };
    this.#confirmedBatches.clear();
    this.#redoStack = [];
    this.#undoStack = [];
  }

  #commit(batch, historyMode) {
    const execute = async () => {
      await this.#refreshPromise;
      this.#assertWritable();
      this.#closeWatchers();
      try {
        const identity = canonicalJSON({
          baseRevision: batch.baseRevision,
          batchId: batch.batchId,
          operations: batch.operations,
        });
        const confirmed = this.#confirmedBatches.get(batch.batchId);
        if (confirmed) {
          if (confirmed.identity !== identity) {
            throw new SmallPenError(
              "duplicate_batch_id",
              "Operation Batch identity was already used with another payload",
              { batchId: batch.batchId },
            );
          }
          this.#startWatchers();
          return { ...confirmed.result, duplicate: true };
        }
        const result = await this.#applyCommitted((options) =>
          applyOperationBatch(this.#packagePath, this.#diskBatch(batch), options),
        );
        this.#confirmedBatches.set(batch.batchId, { identity, result });
        if (result.alreadyApplied) {
          // Replayed from the persistent ledger: nothing was written now, so
          // its (possibly stale) inverse must not enter local history.
          return result;
        }
        if (historyMode === "normal") {
          this.#undoStack.push(result.inverseBatch);
          this.#redoStack = [];
        } else if (historyMode === "undo") {
          this.#redoStack.push(result.inverseBatch);
        } else if (historyMode === "redo") {
          this.#undoStack.push(result.inverseBatch);
        }
        this.#recordChange({
          affectedIds: result.affectedIds,
          batchId: result.batchId,
          changedFiles: result.changedFiles,
          revision: result.revision,
          source: historyMode === "normal" ? "local" : historyMode,
        });
        return result;
      } catch (error) {
        this.#startWatchers();
        throw error;
      }
    };
    const pending = this.#commitQueue.then(execute, execute);
    this.#commitQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  #write(operation) {
    const execute = async () => {
      await this.#refreshPromise;
      this.#assertWritable();
      this.#closeWatchers();
      try {
        let value;
        const result = await this.#applyCommitted(async (options) => {
          const written = await operation(options);
          value = written.value;
          return written.result;
        });
        if (result.alreadyApplied) return value ?? result;
        this.#undoStack.push(result.inverseBatch);
        this.#redoStack = [];
        this.#recordChange({
          affectedIds: result.affectedIds,
          batchId: result.batchId,
          changedFiles: result.changedFiles,
          revision: result.revision,
          source: "local",
        });
        return value ?? result;
      } catch (error) {
        this.#startWatchers();
        throw error;
      }
    };
    const pending = this.#commitQueue.then(execute, execute);
    this.#commitQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  // Runs one write and adopts the Package state read under its write lock.
  // Reopening after the lock is released could absorb an external revision
  // that landed in between without reporting it; instead the fingerprint is
  // dropped so the next refresh compares the disk against this snapshot and
  // emits an external-revision event for anything newer.
  async #applyCommitted(write) {
    let committed;
    const result = await write({
      onCommitted: (snapshot) => {
        committed = snapshot;
      },
    });
    this.snapshot = await this.#project(
      committed ?? (await openPackage(this.#packagePath)),
    );
    this.#fingerprint = undefined;
    this.#markReady();
    this.#startWatchers();
    this.#scheduleRefresh();
    // Clients use the reported revision as their next base revision; while a
    // default Token library is projected that is the projected revision.
    return this.#projection
      ? { ...result, revision: this.snapshot.revision }
      : result;
  }

  #assertWritable() {
    if (!this.#packagePath) {
      throw new SmallPenError("package_not_open", "Local Package Backend is not open");
    }
    if (this.status.readOnly) {
      throw new SmallPenError(
        "repair_read_only",
        "The last valid projection is read-only until external Package Repair succeeds",
        { status: this.status },
      );
    }
  }

  #markReady() {
    this.status = {
      lastValidRevision: this.snapshot?.revision,
      readOnly: false,
      state: "ready",
    };
  }

  #recordChange(change) {
    this.changes.push({ ...change, index: this.#changeSequence });
    this.#changeSequence += 1;
    if (this.changes.length > MAX_CHANGE_HISTORY) this.changes.shift();
  }

  // A pending refresh is never pushed back: a steady stream of external
  // writes (or watcher events) must not postpone it indefinitely.
  #scheduleRefresh() {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.refresh();
    }, 120);
  }

  #startWatchers() {
    this.#closeWatchers();
    if (!this.#packagePath || !this.snapshot) return;
    const parent = dirname(this.#packagePath);
    const packageName = basename(this.#packagePath);
    const addWatcher = (path, callback) => {
      try {
        const watcher = watch(path, callback);
        watcher.on("error", () => this.#scheduleRefresh());
        this.#watchers.push(watcher);
      } catch {
        // A concurrently replaced directory is covered by the parent watcher.
      }
    };
    addWatcher(parent, (_eventType, filename) => {
      if (filename && String(filename) !== packageName) return;
      this.#scheduleRefresh();
    });
    const directories = new Set([this.#packagePath]);
    for (const kind of Object.keys(this.snapshot.manifest.entries)) {
      for (const entry of this.snapshot.manifest.entries[kind]) {
        directories.add(dirname(join(this.#packagePath, entry)));
      }
    }
    if (this.snapshot.blobs.size > 0) {
      directories.add(join(this.#packagePath, "blobs"));
    }
    for (const directory of directories) {
      addWatcher(directory, () => this.#scheduleRefresh());
    }
    this.#pollTimer = setInterval(() => this.#scheduleRefresh(), 1000);
    this.#pollTimer.unref?.();
  }

  #closeWatchers() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    clearInterval(this.#pollTimer);
    this.#pollTimer = undefined;
    for (const watcher of this.#watchers) watcher.close();
    this.#watchers = [];
  }

  #emit(event) {
    for (const listener of this.#listeners) listener(event);
  }
}
