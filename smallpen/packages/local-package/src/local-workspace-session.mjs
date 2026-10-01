import { dirname, join, resolve } from "node:path";

import { SmallPenError } from "@smallpen/core";

import { LocalPackageBackend } from "./local-package-backend.mjs";
import {
  localLibraryLocator,
  MAX_LIBRARY_DECLARATIONS,
  resolveWorkspace,
} from "./workspace.mjs";

// A Package in Repair because a linked Foundation or Library is unavailable
// gets no event when that link is fixed, so its status is resolved again.
const LINK_REPAIR_RETRY_MS = 1000;

function collectStableIds(value, result) {
  if (Array.isArray(value)) {
    for (const child of value) collectStableIds(child, result);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (typeof value.id === "string") result.add(value.id);
  for (const child of Object.values(value)) collectStableIds(child, result);
}

function screenById(snapshot, screenId) {
  const entry = snapshot.manifest.entries.screens.find(
    (candidate) => snapshot.entries[candidate].id === screenId,
  );
  return entry ? snapshot.entries[entry] : undefined;
}

function defaultTokenLibrary() {
  return {
    activeSetIds: [],
    activeThemeIds: ["theme_default"],
    id: "tlib_default",
    sets: [
      {
        description: "",
        id: "tset_theme_default",
        name: "Theme/Default",
        tokens: [],
      },
    ],
    themes: [
      {
        description: "",
        externalId: "",
        group: "Theme",
        id: "theme_default",
        isSource: false,
        name: "Default",
        setIds: ["tset_theme_default"],
      },
    ],
  };
}

export function reconcilePackageViewState(snapshot, value = {}) {
  const firstScreenEntry = snapshot.manifest.entries.screens[0];
  const defaultScreen =
    screenById(snapshot, snapshot.manifest.defaultScreenId) ??
    (firstScreenEntry ? snapshot.entries[firstScreenEntry] : undefined);
  const selectedScreen = screenById(snapshot, value.screenId) ?? defaultScreen;
  const presentation =
    selectedScreen?.presentations.find(
      ({ id }) => id === value.presentationId,
    ) ??
    selectedScreen?.presentations.find(
      ({ id }) => id === selectedScreen.basePresentationId,
    );
  const stableIds = new Set();
  collectStableIds(snapshot.manifest, stableIds);
  collectStableIds(snapshot.entries, stableIds);
  return {
    presentationId: presentation?.id,
    screenId: selectedScreen?.id,
    selectedIds: (value.selectedIds ?? []).filter((id) => stableIds.has(id)),
    viewport: {
      x: value.viewport?.x ?? 0,
      y: value.viewport?.y ?? 0,
      zoom: value.viewport?.zoom ?? 1,
    },
  };
}

export class LocalWorkspaceSession {
  #fetchImpl;
  #libraryCacheRoot;
  #listeners = new Set();
  // Opens still running: requests, dependency events and Repair retries.
  #opening = new Set();
  #packages = new Map();
  // Remote Library snapshots verified by this session, keyed by manifest URL.
  // Status updates after commits reuse them so a slow or unreachable remote
  // never blocks a local write; open() and refresh() read them again.
  #remoteLibraries = new Map();

  activeLocator;

  constructor({ fetchImpl, libraryCacheRoot } = {}) {
    this.#fetchImpl = fetchImpl;
    this.#libraryCacheRoot = libraryCacheRoot;
  }

  get packages() {
    return [...this.#packages.values()].map((session) => ({
      active: session.locator === this.activeLocator,
      changes: structuredClone(session.backend.changes),
      draft: session.backend.snapshot.manifest.draft !== undefined,
      locator: session.locator,
      fileId: session.backend.snapshot.runtime.file,
      name: session.backend.snapshot.manifest.name,
      packageId: session.backend.snapshot.manifest.packageId,
      revision: session.backend.snapshot.revision,
      role: session.backend.snapshot.manifest.role,
      status: structuredClone(session.workspaceStatus),
      viewState: structuredClone(session.viewState),
    }));
  }

  open(locator, viewState = {}) {
    const opening = this.#open(locator, viewState);
    this.#opening.add(opening);
    const settled = () => this.#opening.delete(opening);
    opening.then(settled, settled);
    return opening;
  }

  async #open(locator, viewState) {
    const requested = resolve(locator);
    const existing = this.#find(requested);
    if (existing) {
      this.activeLocator = existing.locator;
      return this.describe(existing.locator);
    }
    // Opening never writes: a Package without Tokens is served with the
    // default Theme projected in memory and persisted by its first commit.
    const backend = new LocalPackageBackend({
      defaultTokenLibrary: defaultTokenLibrary(),
    });
    let session;
    let opened;
    try {
      const snapshot = await backend.open(requested);
      // A symlinked or non-canonical spelling of an open Package, or a
      // concurrent open of the same one, selects the session already open.
      opened = this.#packages.get(snapshot.locator);
      if (!opened) {
        const duplicate = [...this.#packages.values()].find(
          (candidate) =>
            candidate.backend.snapshot.runtime.file === snapshot.runtime.file,
        );
        if (duplicate) {
          throw new SmallPenError(
            "duplicate_file_id",
            "Another open Package has the same persistent file identity",
            {
              fileId: snapshot.runtime.file,
              locator: snapshot.locator,
              openLocator: duplicate.locator,
              packageId: snapshot.manifest.packageId,
            },
          );
        }
        session = {
          backend,
          locator: snapshot.locator,
          unsubscribe: undefined,
          statusSequence: 0,
          viewState: reconcilePackageViewState(snapshot, viewState),
          workspaceStatus: structuredClone(backend.status),
        };
      }
    } finally {
      if (!session) await backend.close();
    }
    if (opened) {
      this.activeLocator = opened.locator;
      return this.describe(opened.locator);
    }
    const { snapshot } = backend;
    session.unsubscribe = backend.subscribe((event) => {
      if (event.snapshot) {
        session.viewState = reconcilePackageViewState(
          event.snapshot,
          session.viewState,
        );
      }
      // An external edit can retarget the Foundation or a Library.
      const linked = event.snapshot
        ? this.#openLinkedPackages(event.snapshot)
        : Promise.resolve();
      void linked.then(() => this.#updateWorkspaceStatus(session));
      this.#emit({ ...event, locator: session.locator });
      if (
        event.type === "external-revision" ||
        event.type === "invalid-external-state" ||
        event.type === "external-recovered"
      ) {
        this.#emitDependencyChanges(session, event);
      }
    });
    this.#packages.set(session.locator, session);
    this.activeLocator ??= session.locator;
    await this.#openLinkedPackages(snapshot);
    await this.#updateWorkspaceStatus(session, { reuseRemoteLibraries: false });
    this.#emit({ locator: session.locator, snapshot, type: "package-opened" });
    return this.describe(session.locator);
  }

  describe(locator) {
    const session = this.#required(locator);
    return {
      backend: session.backend,
      locator: session.locator,
      snapshot: session.backend.snapshot,
      status: structuredClone(session.workspaceStatus),
      viewState: structuredClone(session.viewState),
      workspace: structuredClone(
        session.lastValidWorkspace ?? session.repairWorkspace,
      ),
    };
  }

  setActive(locator) {
    const session = this.#required(locator);
    this.activeLocator = session.locator;
    this.#emit({ locator: session.locator, type: "active-package-changed" });
    return this.describe(session.locator);
  }

  async refresh(locator) {
    const session = this.#required(locator);
    await this.#updateWorkspaceStatus(session, { reuseRemoteLibraries: false });
    return this.describe(session.locator);
  }

  updateViewState(locator, changes) {
    const session = this.#required(locator);
    session.viewState = reconcilePackageViewState(session.backend.snapshot, {
      ...session.viewState,
      ...structuredClone(changes),
      viewport: {
        ...session.viewState.viewport,
        ...(changes.viewport ?? {}),
      },
    });
    this.#emit({
      locator: session.locator,
      type: "package-view-state-changed",
      viewState: structuredClone(session.viewState),
    });
    return structuredClone(session.viewState);
  }

  async commit(locator, batch) {
    const session = this.#required(locator);
    this.#assertWorkspaceWritable(session);
    const result = await session.backend.commit(batch);
    await this.#openLinkedPackages(session.backend.snapshot);
    await this.#updateWorkspaceStatus(session);
    session.viewState = reconcilePackageViewState(
      session.backend.snapshot,
      session.viewState,
    );
    this.#emit({
      change: session.backend.changes.at(-1),
      locator: session.locator,
      result,
      type: "package-committed",
    });
    this.#emitDependencyChanges(session, { type: "package-committed" });
    return result;
  }

  async undo(locator) {
    const session = this.#required(locator);
    this.#assertWorkspaceWritable(session);
    const result = await session.backend.undo();
    await this.#updateWorkspaceStatus(session);
    session.viewState = reconcilePackageViewState(
      session.backend.snapshot,
      session.viewState,
    );
    this.#emit({ locator: session.locator, result, type: "package-undone" });
    this.#emitDependencyChanges(session, { type: "package-undone" });
    return result;
  }

  async redo(locator) {
    const session = this.#required(locator);
    this.#assertWorkspaceWritable(session);
    const result = await session.backend.redo();
    await this.#updateWorkspaceStatus(session);
    session.viewState = reconcilePackageViewState(
      session.backend.snapshot,
      session.viewState,
    );
    this.#emit({ locator: session.locator, result, type: "package-redone" });
    this.#emitDependencyChanges(session, { type: "package-redone" });
    return result;
  }

  async save(locator) {
    const session = this.#required(locator);
    this.#assertWorkspaceWritable(session);
    const result = await session.backend.save();
    await this.#updateWorkspaceStatus(session);
    return result;
  }

  importMedia(locator, media) {
    return this.#write(locator, "package-media-imported", (backend) =>
      backend.importMedia(media),
    );
  }

  importFontVariant(locator, font) {
    return this.#write(locator, "package-font-variant-imported", (backend) =>
      backend.importFontVariant(font),
    );
  }

  updateFontFamily(locator, fontId, family) {
    return this.#write(locator, "package-font-updated", (backend) =>
      backend.updateFontFamily(fontId, family),
    );
  }

  deleteFontFamily(locator, fontId) {
    return this.#write(locator, "package-font-deleted", (backend) =>
      backend.deleteFontFamily(fontId),
    );
  }

  deleteFontVariant(locator, fontVariantId) {
    return this.#write(locator, "package-font-variant-deleted", (backend) =>
      backend.deleteFontVariant(fontVariantId),
    );
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(locator) {
    const session = this.#required(locator);
    clearTimeout(session.repairRetry);
    session.repairRetry = undefined;
    session.unsubscribe?.();
    await session.backend.close();
    this.#packages.delete(session.locator);
    if (this.activeLocator === session.locator) {
      this.activeLocator = this.#packages.keys().next().value;
    }
    this.#emit({ locator: session.locator, type: "package-closed" });
  }

  // An open still in flight can register a Package (or its Foundation and
  // Libraries) after the loop has passed; its watchers would keep the
  // process alive, so close until no open is pending.
  async closeAll() {
    while (this.#packages.size > 0 || this.#opening.size > 0) {
      for (const locator of [...this.#packages.keys()]) await this.close(locator);
      await Promise.allSettled([...this.#opening]);
    }
  }

  #find(locator) {
    return (
      this.#packages.get(locator) ??
      [...this.#packages.values()].find(
        (session) => resolve(session.locator) === resolve(locator),
      )
    );
  }

  #required(locator) {
    const session = this.#find(locator);
    if (!session) {
      throw new SmallPenError(
        "package_not_open",
        `Package is not open: ${locator}`,
      );
    }
    return session;
  }

  // Opens the Foundation and local Libraries a Package links to, so their
  // external edits reach it. Links that cannot be opened stay in Repair and
  // are retried while the owner's status is not ready. The active Package
  // never changes here.
  async #openLinkedPackages(snapshot) {
    const locators = [];
    if (snapshot.manifest.role === "product") {
      const dependency = snapshot.manifest.dependencies[0];
      locators.push(join(dirname(snapshot.locator), dependency.path));
    }
    // Resolution never follows more declarations than this, so retrying
    // the rest would only spend CPU on every Repair retry.
    for (const library of (snapshot.manifest.libraries ?? []).slice(
      0,
      MAX_LIBRARY_DECLARATIONS,
    )) {
      if (library.source.type !== "local") continue;
      try {
        locators.push(localLibraryLocator(snapshot.locator, library.source));
      } catch {
        // Composite status exposes the invalid Library source for Repair.
      }
    }
    for (const locator of locators) {
      if (this.#find(locator)) continue;
      const active = this.activeLocator;
      try {
        await this.open(locator);
      } catch {
        // Composite status retains the owner and exposes the Repair.
      } finally {
        this.activeLocator = active ?? this.activeLocator;
      }
    }
  }

  // Every open Package whose composite Workspace includes the changed one,
  // directly or through a Foundation or Library chain.
  #dependentSessions(changed) {
    const dependents = [];
    const seen = new Set([changed]);
    const pending = [changed];
    while (pending.length > 0) {
      const packageId = pending.shift().backend.snapshot?.manifest.packageId;
      if (!packageId) continue;
      for (const session of this.#packages.values()) {
        if (seen.has(session)) continue;
        const manifest = session.backend.snapshot?.manifest;
        if (
          manifest?.dependencies?.some(
            (dependency) => dependency.packageId === packageId,
          ) ||
          manifest?.libraries?.some((library) => library.packageId === packageId)
        ) {
          seen.add(session);
          dependents.push(session);
          pending.push(session);
        }
      }
    }
    return dependents;
  }

  #emitDependencyChanges(changed, event) {
    for (const session of this.#dependentSessions(changed)) {
      void this.#updateWorkspaceStatus(session).then(() => {
        this.#emit({
          dependencyEvent: event.type,
          dependencyLocator: changed.locator,
          locator: session.locator,
          status: structuredClone(session.workspaceStatus),
          type: "package-dependency-changed",
        });
      });
    }
  }

  #scheduleLinkRepairRetry(session) {
    clearTimeout(session.repairRetry);
    session.repairRetry = undefined;
    // A Package whose own state is invalid recovers through its Backend.
    if (
      session.workspaceStatus.state !== "repair" ||
      session.backend.status.state !== "ready"
    ) {
      return;
    }
    session.repairRetry = setTimeout(async () => {
      session.repairRetry = undefined;
      if (this.#packages.get(session.locator) !== session) return;
      const before = JSON.stringify(session.workspaceStatus);
      await this.#openLinkedPackages(session.backend.snapshot);
      if (this.#packages.get(session.locator) !== session) return;
      await this.#updateWorkspaceStatus(session, { emitUnchanged: false });
      if (JSON.stringify(session.workspaceStatus) === before) return;
      this.#emit({
        dependencyEvent: "link-repair-retry",
        locator: session.locator,
        status: structuredClone(session.workspaceStatus),
        type: "package-dependency-changed",
      });
    }, LINK_REPAIR_RETRY_MS);
    session.repairRetry.unref?.();
  }

  async #updateWorkspaceStatus(
    session,
    { emitUnchanged = true, reuseRemoteLibraries = true } = {},
  ) {
    // Updates run concurrently (events do not await them); only the latest
    // one started may set the status, so a slow older read never wins.
    session.statusSequence += 1;
    const sequence = session.statusSequence;
    const before = JSON.stringify(session.workspaceStatus);
    let resolution;
    let failure;
    try {
      resolution = await resolveWorkspace(session.locator, {
        fetchImpl: this.#fetchImpl,
        libraryCacheRoot: this.#libraryCacheRoot,
        remoteLibrarySnapshots: this.#remoteLibraries,
        reuseRemoteLibrarySnapshots: reuseRemoteLibraries,
      });
    } catch (error) {
      failure = error;
    }
    if (sequence !== session.statusSequence) return session.workspaceStatus;
    if (resolution) {
      if (resolution.status === "ready") {
        session.lastValidWorkspace = resolution.workspace;
        session.repairWorkspace = undefined;
        session.workspaceStatus = {
          foundationRevision: resolution.workspace.foundation?.revision,
          lastValidRevision: resolution.workspace.product.revision,
          readOnly: false,
          state: "ready",
          warnings: resolution.warnings,
        };
      } else {
        // On a first open there is no last-valid composite Workspace yet.
        // Keep the resolved dependencies available for diagnostics without
        // promoting the invalid Product to last-valid state. This lets Web
        // identify the actual broken reference instead of failing on the
        // first otherwise-valid Foundation instance it encounters.
        session.repairWorkspace = {
          ...(resolution.foundation
            ? { foundation: resolution.foundation }
            : {}),
          libraries: resolution.libraries ?? [],
          product: resolution.product,
        };
        session.workspaceStatus = {
          conflicts: resolution.conflicts,
          foundationRevision:
            session.lastValidWorkspace?.foundation?.revision ??
            resolution.foundation?.revision,
          lastValidRevision:
            session.lastValidWorkspace?.product?.revision ??
            session.backend.snapshot.revision,
          readOnly: true,
          state: "repair",
        };
      }
    } else {
      const error = failure;
      session.workspaceStatus = {
        error: {
          code: error?.code ?? "invalid_workspace_state",
          details: error?.details ?? {},
          message: error instanceof Error ? error.message : String(error),
        },
        foundationRevision: session.lastValidWorkspace?.foundation?.revision,
        lastValidRevision:
          session.lastValidWorkspace?.product?.revision ??
          session.backend.snapshot.revision,
        readOnly: true,
        state: "repair",
      };
    }
    this.#scheduleLinkRepairRetry(session);
    if (emitUnchanged || JSON.stringify(session.workspaceStatus) !== before) {
      this.#emit({
        locator: session.locator,
        status: structuredClone(session.workspaceStatus),
        type: "package-workspace-status",
      });
    }
    return session.workspaceStatus;
  }

  async #write(locator, type, operation) {
    const session = this.#required(locator);
    this.#assertWorkspaceWritable(session);
    const value = await operation(session.backend);
    await this.#updateWorkspaceStatus(session);
    session.viewState = reconcilePackageViewState(
      session.backend.snapshot,
      session.viewState,
    );
    this.#emit({
      change: session.backend.changes.at(-1),
      locator: session.locator,
      type,
      value,
    });
    this.#emitDependencyChanges(session, { type });
    return value;
  }

  #assertWorkspaceWritable(session) {
    if (session.workspaceStatus?.readOnly) {
      throw new SmallPenError(
        "workspace_repair_read_only",
        "Product Workspace is read-only until Package or Foundation Repair succeeds",
        { status: session.workspaceStatus },
      );
    }
  }

  #emit(event) {
    for (const listener of this.#listeners) listener(event);
  }
}
