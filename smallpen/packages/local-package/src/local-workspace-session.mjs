import { dirname, join, resolve } from "node:path";

import { SmallPenError } from "@smallpen/core";

import { LocalPackageBackend } from "./local-package-backend.mjs";
import { resolveWorkspace } from "./workspace.mjs";

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

async function seedDefaultTheme(backend, snapshot) {
  if (snapshot.manifest.entries.tokens.length > 0) return snapshot;
  await backend.commit({
    baseRevision: snapshot.revision,
    batchId: `seed-default-theme-${snapshot.revision.slice(0, 12)}`,
    operations: [
      {
        entry: "tokens/tokens.json",
        library: defaultTokenLibrary(),
        type: "replace-token-library",
      },
    ],
  });
  return backend.snapshot;
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
  #libraryCacheRoot;
  #listeners = new Set();
  #packages = new Map();

  activeLocator;

  constructor({ libraryCacheRoot } = {}) {
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

  async open(locator, viewState = {}) {
    const requested = resolve(locator);
    const existing = this.#find(requested);
    if (existing) {
      this.activeLocator = existing.locator;
      return this.describe(existing.locator);
    }
    const backend = new LocalPackageBackend();
    let snapshot = await backend.open(requested);
    const duplicate = [...this.#packages.values()].find(
      (candidate) =>
        candidate.backend.snapshot.runtime.file === snapshot.runtime.file,
    );
    if (duplicate) {
      await backend.close();
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
    snapshot = await seedDefaultTheme(backend, snapshot);
    const session = {
      backend,
      locator: snapshot.locator,
      unsubscribe: undefined,
      viewState: reconcilePackageViewState(snapshot, viewState),
      workspaceStatus: structuredClone(backend.status),
    };
    session.unsubscribe = backend.subscribe((event) => {
      if (event.snapshot) {
        session.viewState = reconcilePackageViewState(
          event.snapshot,
          session.viewState,
        );
      }
      void this.#updateWorkspaceStatus(session);
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
    if (snapshot.manifest.role === "product") {
      const dependency = snapshot.manifest.dependencies[0];
      try {
        await this.open(join(dirname(snapshot.locator), dependency.path));
      } catch {
        // Composite status below retains Product and exposes dependency Repair.
      }
    }
    for (const library of snapshot.manifest.libraries ?? []) {
      if (library.source.type !== "local") continue;
      try {
        await this.open(
          resolve(dirname(snapshot.locator), library.source.path),
        );
      } catch {
        // Composite status below retains the owner and exposes Library Repair.
      }
    }
    await this.#updateWorkspaceStatus(session);
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
    await this.#updateWorkspaceStatus(session);
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
    session.unsubscribe?.();
    await session.backend.close();
    this.#packages.delete(session.locator);
    if (this.activeLocator === session.locator) {
      this.activeLocator = this.#packages.keys().next().value;
    }
    this.#emit({ locator: session.locator, type: "package-closed" });
  }

  async closeAll() {
    for (const locator of [...this.#packages.keys()]) await this.close(locator);
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

  #emitDependencyChanges(changed, event) {
    const packageId = changed.backend.snapshot?.manifest.packageId;
    if (!packageId) return;
    for (const session of this.#packages.values()) {
      if (session === changed) continue;
      if (
        session.backend.snapshot.manifest.dependencies?.some(
          (dependency) => dependency.packageId === packageId,
        ) ||
        session.backend.snapshot.manifest.libraries?.some(
          (library) => library.packageId === packageId,
        )
      ) {
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
  }

  async #updateWorkspaceStatus(session) {
    try {
      const resolution = await resolveWorkspace(session.locator, {
        libraryCacheRoot: this.#libraryCacheRoot,
      });
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
    } catch (error) {
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
    this.#emit({
      locator: session.locator,
      status: structuredClone(session.workspaceStatus),
      type: "package-workspace-status",
    });
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
