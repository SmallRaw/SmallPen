import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import {
  canonicalJSON,
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
  #listeners = new Set();
  #packagePath;
  #pollTimer;
  #refreshPromise;
  #redoStack = [];
  #timer;
  #undoStack = [];
  #watchers = [];

  changes = [];
  snapshot;
  status = { readOnly: true, state: "closed" };

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
    this.snapshot = await openPackage(resolve(locator));
    this.#packagePath = this.snapshot.locator;
    this.#markReady();
    this.#startWatchers();
    return this.snapshot;
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
    return this.#write(async () => {
      const imported = await importPackageMedia(this.#packagePath, media);
      return { result: imported.result, value: imported };
    });
  }

  importFontVariant(font) {
    return this.#write(async () => {
      const imported = await importPackageFontVariant(this.#packagePath, font);
      return { result: imported.result, value: imported };
    });
  }

  updateFontFamily(fontId, family) {
    return this.#write(async () => ({
      result: await updatePackageFontFamily(this.#packagePath, fontId, family),
    }));
  }

  deleteFontFamily(fontId) {
    return this.#write(async () => ({
      result: await deletePackageFontFamily(this.#packagePath, fontId),
    }));
  }

  deleteFontVariant(fontVariantId) {
    return this.#write(async () => ({
      result: await deletePackageFontVariant(this.#packagePath, fontVariantId),
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
      const next = await openPackage(this.#packagePath);
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
      this.snapshot = next;
      this.#markReady();
      this.#recordChange(change);
      this.#startWatchers();
      this.#emit({ change, snapshot: next, type: "external-revision" });
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
        const result = await applyOperationBatch(this.#packagePath, batch);
        this.snapshot = await openPackage(this.#packagePath);
        this.#markReady();
        this.#startWatchers();
        this.#confirmedBatches.set(batch.batchId, { identity, result });
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
        const { result, value } = await operation();
        this.snapshot = await openPackage(this.#packagePath);
        this.#markReady();
        this.#startWatchers();
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

  #scheduleRefresh() {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.refresh(), 120);
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
