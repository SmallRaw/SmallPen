import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import {
  compileDraftMerge,
  diffDrafts,
  draftFromSnapshot,
  importTokens,
  projectEffectiveSnapshot,
  SmallPenError,
  SMALLPEN_FORMAT_CAPABILITIES,
  stableRuntimeUuid,
} from "@smallpen/core";
import {
  createBlankPackage,
  createEvidence,
  importDraft,
  LocalWorkspaceSession,
  openPackage,
  openRemoteLibrary,
} from "@smallpen/local-package";
import { compilePenpotChanges } from "@smallpen/penpot-adapter";
import { inspectImage } from "./media.mjs";
import { prepareFontFiles } from "./font.mjs";
import { LocalApplicationState } from "./application-state.mjs";
import { createWebWorkspaceSnapshot } from "./web-projection.mjs";
import {
  createCanvasWorkspace,
  createCatalogWorkspace,
  createCompareWorkspace,
  createDesignSystemWorkspace,
  createDesignWorkspace,
  createRepairWorkspace,
  createRequirementsWorkspace,
  createWorkspaceOverview,
} from "./workspace-view.mjs";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const MAX_FONT_BYTES = 50 * 1024 * 1024;
const MAX_UPLOAD_SESSIONS = 32;
const UPLOAD_SESSION_MAX_AGE = 15 * 60 * 1000;
const LOCAL_TEAM_ID = "00000000-0000-4000-8000-000000000001";

function loopbackHost(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function originFor(host, port) {
  const hostname = host.includes(":") ? `[${host}]` : host;
  return `http://${hostname}:${port}`;
}

function referencesPackage(snapshot, packageId) {
  let found = false;
  const visit = (value) => {
    if (found || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (typeof value !== "object") return;
    if (value.packageId === packageId && typeof value.assetId === "string") {
      found = true;
      return;
    }
    for (const child of Object.values(value)) visit(child);
  };
  for (const entry of Object.values(snapshot.entries)) visit(entry);
  return found;
}

function librarySummary(snapshot) {
  const variantCount = Object.keys(
    snapshot.runtime.reverseVariants ?? {},
  ).length;
  const locatedCount = Object.keys(snapshot.runtime.components ?? {}).filter(
    (componentId) => !snapshot.runtime.variants?.[componentId],
  ).length;
  return {
    colors: Object.keys(snapshot.runtime.reverseColors ?? {}).length,
    components: locatedCount + variantCount,
    graphics: Object.keys(snapshot.runtime.reverseMedia ?? {}).length,
    tokens: Object.keys(snapshot.runtime.reverseTokens ?? {}).length,
    typographies: Object.keys(snapshot.runtime.reverseTypographies ?? {})
      .length,
  };
}

function writeJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}

function writeError(response, error) {
  const status =
    error instanceof SmallPenError && error.code === "stale_revision"
      ? 409
      : error instanceof SmallPenError && error.code === "file_not_found"
        ? 404
        : 422;
  writeJson(response, status, {
    error: {
      code: error instanceof SmallPenError ? error.code : "internal_error",
      details: error instanceof SmallPenError ? error.details : {},
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

function mediaDescriptor(snapshot, runtimeId) {
  const mediaId = snapshot.runtime.reverseMedia?.[runtimeId]?.mediaId;
  if (!mediaId) return undefined;
  const entry = snapshot.manifest.entries.assets[0];
  return entry
    ? snapshot.entries[entry].media.find((media) => media.id === mediaId)
    : undefined;
}

function fontDescriptor(snapshot, runtimeId) {
  const reference = snapshot.runtime.reverseFontFiles?.[runtimeId];
  if (!reference) return undefined;
  const entry = snapshot.manifest.entries.assets[0];
  const font = entry
    ? snapshot.entries[entry].fonts.find(({ id }) => id === reference.fontId)
    : undefined;
  const variant = font?.variants.find(
    ({ id }) => id === reference.fontVariantId,
  );
  return variant?.files[reference.format];
}

function workspaceAssetDescriptor(description, runtimeId, descriptorFor) {
  const candidates = [
    description.workspace?.product ?? description.snapshot,
    description.workspace?.foundation,
    ...(description.workspace?.libraries ?? []),
  ];
  const seen = new Set();
  for (const snapshot of candidates) {
    if (!snapshot || seen.has(snapshot.manifest.packageId)) continue;
    seen.add(snapshot.manifest.packageId);
    const descriptor = descriptorFor(snapshot, runtimeId);
    if (descriptor) return { descriptor, snapshot };
  }
  return undefined;
}

function writeBinary(response, snapshot, descriptor, kind) {
  const body = snapshot.blobs.get(descriptor.blob);
  if (!body) {
    throw new SmallPenError(
      `missing_${kind.toLowerCase()}_blob`,
      `${kind} blob is unavailable: ${descriptor.blob}`,
    );
  }
  response.writeHead(200, {
    "access-control-allow-origin": "*",
    "cache-control": "private, max-age=31536000, immutable",
    "content-length": body.byteLength,
    "content-type": descriptor.mimeType,
    "cross-origin-resource-policy": "cross-origin",
    etag: `"sha256-${descriptor.sha256}"`,
    ...(kind === "Media"
      ? {
          "content-security-policy":
            "sandbox; default-src 'none'; img-src data:",
        }
      : {}),
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES)
      throw new SmallPenError("request_too_large", "Request body is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new SmallPenError(
      "invalid_json",
      "Request body must contain valid JSON",
    );
  }
}

async function readBytes(
  request,
  maximum = MAX_MEDIA_BYTES,
  {
    emptyCode = "invalid_media_blob",
    label = "Media",
    tooLargeCode = "media_too_large",
  } = {},
) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) {
      throw new SmallPenError(tooLargeCode, `Uploaded ${label} is too large`);
    }
    chunks.push(chunk);
  }
  if (size === 0) {
    throw new SmallPenError(emptyCode, `Uploaded ${label} is empty`);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function designSelector(url) {
  const selector = {};
  const fields = {
    "context-profile": "contextProfileId",
    presentation: "presentationId",
    scenario: "scenarioId",
    screen: "screenId",
  };
  for (const [query, field] of Object.entries(fields)) {
    const value = url.searchParams.get(query);
    if (value) selector[field] = value;
  }
  const context = {};
  for (const value of url.searchParams.getAll("context")) {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw new SmallPenError(
        "invalid_context_selector",
        `Context selector must use axis=value: ${value}`,
      );
    }
    context[value.slice(0, separator)] = value.slice(separator + 1);
  }
  if (Object.keys(context).length > 0) selector.context = context;
  return selector;
}

export async function serveLocalPackage({
  applicationStatePath,
  packagePath,
  host = "127.0.0.1",
  port = 43127,
}) {
  if (!loopbackHost(host)) {
    throw new SmallPenError(
      "invalid_background_host",
      "SmallPen Background must bind to a loopback host",
      { host },
    );
  }
  const application = await LocalApplicationState.open({
    statePath: applicationStatePath,
  });
  const libraryCacheRoot = applicationStatePath
    ? join(dirname(applicationStatePath), "library-cache")
    : undefined;
  const workspace = new LocalWorkspaceSession({
    libraryCacheRoot,
  });
  const opened = packagePath ? await workspace.open(packagePath) : undefined;
  if (opened) {
    await application.recordPackage({
      locator: opened.snapshot.locator,
      name: opened.snapshot.manifest.name,
      packageId: opened.snapshot.manifest.packageId,
      role: opened.snapshot.manifest.role,
    });
  }
  const initialBackend = opened?.backend;
  const packageIds = new Map();
  const locators = new Map();
  const eventStreams = new Set();
  const uploadSessions = new Map();
  // DSP-014-A: bounded memo for the design-system aggregation (see route).
  const designSystemMemo = { key: null, entries: [] };
  const sessionPath = `/${randomUUID()}`;
  let revisionNumber = 0;

  function packageSessionId(locator) {
    let id = packageIds.get(locator);
    if (!id) {
      id = randomUUID();
      packageIds.set(locator, id);
      locators.set(id, locator);
    }
    return id;
  }

  function packageSummary(item) {
    const { locator, ...summary } = item;
    return {
      ...summary,
      sessionId: packageSessionId(locator),
    };
  }

  function librarySnapshots(description) {
    const values = [
      description.workspace?.foundation,
      ...(description.workspace?.libraries ?? []),
    ].filter(Boolean);
    return values.map((value) => {
      const { blobs: _blobs, ...snapshot } = value;
      return {
        ...snapshot,
        formatCapabilities: SMALLPEN_FORMAT_CAPABILITIES,
        packageStatus: { readOnly: true, state: "ready" },
      };
    });
  }

  async function packageByFileId(fileId) {
    const opened = workspace.packages.find((item) => item.fileId === fileId);
    if (opened) return workspace.describe(opened.locator);

    for (const recent of application.recentPackages) {
      const recentFileId = await stableRuntimeUuid(
        recent.packageId,
        "file",
        recent.locator,
      );
      if (recentFileId !== fileId) continue;
      let description;
      try {
        description = await workspace.open(recent.locator);
      } catch (error) {
        if (
          error?.code !== "invalid_package_path" &&
          error?.code !== "ENOENT" &&
          error?.cause?.code !== "ENOENT"
        ) {
          throw error;
        }
        throw new SmallPenError(
          "file_not_found",
          `SmallPen file is unavailable: ${fileId}`,
          {
            fileId,
            reason: error instanceof Error ? error.message : String(error),
          },
        );
      }
      if (description.snapshot.runtime.file !== fileId) {
        await workspace.close(description.locator);
        throw new SmallPenError(
          "file_identity_mismatch",
          "The Package at the recorded location no longer matches this file URL",
          {
            actualFileId: description.snapshot.runtime.file,
            fileId,
            locator: recent.locator,
          },
        );
      }
      await application.recordPackage({
        locator: description.snapshot.locator,
        name: description.snapshot.manifest.name,
        packageId: description.snapshot.manifest.packageId,
        role: description.snapshot.manifest.role,
      });
      for (const item of workspace.packages) packageSessionId(item.locator);
      return description;
    }
    throw new SmallPenError(
      "file_not_found",
      `SmallPen file is not registered: ${fileId}`,
      { fileId },
    );
  }

  async function selectedPackage(request, url) {
    const fileId =
      request.headers["x-smallpen-file"] ?? url.searchParams.get("file-id");
    if (fileId) return packageByFileId(String(fileId));

    const sessionId =
      request.headers["x-smallpen-package"] ?? url.searchParams.get("package");
    if (sessionId) {
      const locator = locators.get(String(sessionId));
      if (!locator) {
        throw new SmallPenError(
          "package_not_open",
          `Package session is not open: ${sessionId}`,
        );
      }
      return workspace.describe(locator);
    }

    if (!workspace.activeLocator) {
      throw new SmallPenError("package_not_open", "No Package session is open");
    }
    return workspace.describe(workspace.activeLocator);
  }

  function packageBySessionId(id) {
    const locator = locators.get(String(id));
    if (!locator) {
      throw new SmallPenError(
        "package_not_open",
        `Package session is not open: ${id}`,
      );
    }
    return workspace.describe(locator);
  }

  for (const item of workspace.packages) packageSessionId(item.locator);

  const unsubscribe = workspace.subscribe((event) => {
    if (event.locator) packageSessionId(event.locator);
    const snapshot = event.snapshot;
    const safeEvent = {
      ...event,
      error: event.error
        ? {
            code: event.error.code ?? "invalid_external_state",
            details: event.error.details ?? {},
            message:
              event.error instanceof Error
                ? event.error.message
                : String(event.error),
          }
        : undefined,
      locator: undefined,
      revision: event.revision ?? snapshot?.revision ?? event.result?.revision,
      sessionId: event.locator ? packageSessionId(event.locator) : undefined,
      snapshot: undefined,
      value: undefined,
    };
    const payload = `data: ${JSON.stringify(safeEvent)}\n\n`;
    for (const stream of eventStreams) stream.write(payload);
  });

  const server = createServer(async (request, response) => {
    response.setHeader(
      "access-control-allow-headers",
      "content-type,x-smallpen-draft-kind,x-smallpen-draft-output,x-smallpen-draft-package-id,x-smallpen-file,x-smallpen-media-name,x-smallpen-package",
    );
    response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    response.setHeader("access-control-allow-origin", "*");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`,
    );
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, { status: "ok" });
        return;
      }
      if (!url.pathname.startsWith(sessionPath)) {
        writeJson(response, 404, {
          error: { code: "not_found", message: "Route not found" },
        });
        return;
      }
      const route = url.pathname.slice(sessionPath.length);
      if (request.method === "GET" && route === "/v1/application") {
        writeJson(response, 200, application.snapshot);
        return;
      }
      if (request.method === "POST" && route === "/v1/preferences") {
        writeJson(
          response,
          200,
          await application.updatePreferences(await readJson(request)),
        );
        return;
      }
      if (request.method === "GET" && route === "/v1/packages") {
        writeJson(response, 200, {
          activeSessionId: workspace.activeLocator
            ? packageSessionId(workspace.activeLocator)
            : null,
          packages: workspace.packages.map(packageSummary),
        });
        return;
      }
      if (request.method === "POST" && route === "/v1/packages/create") {
        const params = await readJson(request);
        const locator = String(params.locator ?? "").trim();
        if (locator.length === 0 || locator.length > 4096) {
          throw new SmallPenError(
            "invalid_package_locator",
            "Package locator must contain 1 to 4096 characters",
          );
        }
        const created = await createBlankPackage(locator, {
          name: params.name,
        });
        const description = await workspace.open(created.packagePath);
        await application.recordPackage({
          locator: description.snapshot.locator,
          name: description.snapshot.manifest.name,
          packageId: description.snapshot.manifest.packageId,
          role: description.snapshot.manifest.role,
        });
        workspace.setActive(description.locator);
        for (const item of workspace.packages) packageSessionId(item.locator);
        writeJson(response, 201, {
          activeSessionId: packageSessionId(description.locator),
          packagePath: description.locator,
          packages: workspace.packages.map(packageSummary),
        });
        return;
      }
      if (request.method === "POST" && route === "/v1/packages/open") {
        const params = await readJson(request);
        const locator = String(params.locator ?? "").trim();
        if (locator.length === 0 || locator.length > 4096) {
          throw new SmallPenError(
            "invalid_package_locator",
            "Package locator must contain 1 to 4096 characters",
          );
        }
        const description = await workspace.open(locator, params.viewState);
        await application.recordPackage({
          locator: description.snapshot.locator,
          name: description.snapshot.manifest.name,
          packageId: description.snapshot.manifest.packageId,
          role: description.snapshot.manifest.role,
        });
        workspace.setActive(description.locator);
        for (const item of workspace.packages) packageSessionId(item.locator);
        writeJson(response, 201, {
          activeSessionId: packageSessionId(description.locator),
          packages: workspace.packages.map(packageSummary),
        });
        return;
      }
      if (request.method === "POST" && route === "/v1/drafts/import") {
        const kind = String(request.headers["x-smallpen-draft-kind"] ?? "");
        let output;
        try {
          output = decodeURIComponent(
            String(request.headers["x-smallpen-draft-output"] ?? ""),
          );
        } catch {
          throw new SmallPenError(
            "invalid_draft_path",
            "Draft output header is not valid URI-encoded text",
          );
        }
        if (output.length === 0 || output.length > 4096) {
          throw new SmallPenError(
            "invalid_draft_path",
            "Draft output must contain 1 to 4096 characters",
          );
        }
        const bytes = await readBytes(request, MAX_MEDIA_BYTES, {
          emptyCode: "invalid_draft_input",
          label: "Draft input",
          tooLargeCode: "draft_input_too_large",
        });
        let html;
        if (kind === "figma") {
          try {
            html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            throw new SmallPenError(
              "invalid_draft_input",
              "Figma Draft input must be UTF-8 clipboard HTML",
            );
          }
        }
        const result = await importDraft({
          ...(kind === "figma" ? { html } : { bytes }),
          kind,
          output,
          packageId:
            String(
              request.headers["x-smallpen-draft-package-id"] ?? "",
            ).trim() || "pkg_figma_draft",
        });
        const description = await workspace.open(result.output);
        await application.recordPackage({
          locator: description.snapshot.locator,
          name: description.snapshot.manifest.name,
          packageId: description.snapshot.manifest.packageId,
          role: description.snapshot.manifest.role,
        });
        workspace.setActive(description.locator);
        for (const item of workspace.packages) packageSessionId(item.locator);
        writeJson(response, 201, {
          ...result,
          activeSessionId: packageSessionId(description.locator),
          packages: workspace.packages.map(packageSummary),
        });
        return;
      }
      if (request.method === "POST" && route === "/v1/drafts/diff") {
        const params = await readJson(request);
        const before = packageBySessionId(params.beforeSessionId);
        const after = packageBySessionId(params.afterSessionId);
        writeJson(
          response,
          200,
          diffDrafts(
            draftFromSnapshot(before.snapshot),
            draftFromSnapshot(after.snapshot),
          ),
        );
        return;
      }
      if (request.method === "POST" && route === "/v1/drafts/compile") {
        const params = await readJson(request);
        const target = packageBySessionId(params.targetSessionId);
        const draft = packageBySessionId(params.draftSessionId);
        writeJson(
          response,
          200,
          compileDraftMerge(
            target.snapshot,
            draftFromSnapshot(draft.snapshot),
            params.selections,
            { batchId: params.batchId },
          ),
        );
        return;
      }
      const packageAction =
        request.method === "POST"
          ? /^\/v1\/packages\/([a-f0-9-]{36})\/(activate|close)$/.exec(route)
          : null;
      if (packageAction) {
        const [, id, action] = packageAction;
        const locator = locators.get(id);
        if (!locator) {
          throw new SmallPenError(
            "package_not_open",
            `Package session is not open: ${id}`,
          );
        }
        if (action === "activate") {
          workspace.setActive(locator);
        } else {
          const target = workspace.describe(locator);
          const dependent = workspace.packages.find((item) => {
            if (item.locator === locator) return false;
            return workspace
              .describe(item.locator)
              .snapshot.manifest.dependencies?.some(
                ({ packageId }) =>
                  packageId === target.snapshot.manifest.packageId,
              );
          });
          if (dependent) {
            throw new SmallPenError(
              "package_dependency_in_use",
              "Foundation Package cannot close while an open Product depends on it",
              { dependentSessionId: packageSessionId(dependent.locator) },
            );
          }
          await workspace.close(locator);
          packageIds.delete(locator);
          locators.delete(id);
        }
        writeJson(response, 200, {
          activeSessionId: workspace.activeLocator
            ? packageSessionId(workspace.activeLocator)
            : null,
          packages: workspace.packages.map(packageSummary),
        });
        return;
      }

      const description = await selectedPackage(request, url);
      const { backend, locator } = description;
      if (request.method === "GET" && route === "/v1/libraries") {
        writeJson(response, 200, {
          libraries: librarySnapshots(description).map((snapshot) => ({
            fileId: snapshot.runtime.file,
            name: snapshot.manifest.name,
            packageId: snapshot.manifest.packageId,
            revision: snapshot.revision,
            role: snapshot.manifest.role,
            summary: librarySummary(snapshot),
            source:
              description.workspace?.librarySources?.find(
                ({ packageId }) => packageId === snapshot.manifest.packageId,
              )?.source ??
              (snapshot.manifest.packageId ===
              description.workspace?.foundation?.manifest.packageId
                ? {
                    path: backend.snapshot.manifest.dependencies?.[0]?.path,
                    type: "foundation",
                  }
                : undefined),
          })),
          warnings: description.status?.warnings ?? [],
        });
        return;
      }
      if (request.method === "POST" && route === "/v1/libraries/link") {
        const params = await readJson(request);
        const source = params.source;
        let library;
        if (source?.type === "local" && typeof source.path === "string") {
          library = await openPackage(resolve(dirname(locator), source.path));
        } else if (source?.type === "url" && typeof source.url === "string") {
          library = await openRemoteLibrary(source.url, {
            cacheRoot: libraryCacheRoot,
            refresh: true,
          });
        } else {
          throw new SmallPenError(
            "invalid_library_source",
            "Library source must be a local Package path or HTTP(S) URL",
          );
        }
        if (
          typeof params.packageId === "string" &&
          params.packageId !== library.manifest.packageId
        ) {
          throw new SmallPenError(
            "library_id_mismatch",
            `Library Package id ${library.manifest.packageId} does not match expected ${params.packageId}`,
            {
              actualPackageId: library.manifest.packageId,
              expectedPackageId: params.packageId,
            },
          );
        }
        const result = await workspace.commit(locator, {
          baseRevision: backend.snapshot.revision,
          batchId: `link-library-${randomUUID()}`,
          operations: [
            {
              library: {
                packageId: library.manifest.packageId,
                source,
              },
              type: "put-library",
            },
          ],
        });
        if (source.type === "local") {
          await workspace.open(library.locator);
        }
        const updated = workspace.describe(locator);
        writeJson(response, 200, {
          ...result,
          libraries: librarySnapshots(updated),
          librarySources: updated.workspace?.librarySources ?? [],
          warnings: updated.status?.warnings ?? [],
        });
        return;
      }
      if (request.method === "POST" && route === "/v1/libraries/unlink") {
        const params = await readJson(request);
        if (referencesPackage(backend.snapshot, params.packageId)) {
          throw new SmallPenError(
            "library_in_use",
            `Library still has live references: ${params.packageId}`,
            { packageId: params.packageId },
          );
        }
        const result = await workspace.commit(locator, {
          baseRevision: backend.snapshot.revision,
          batchId: `unlink-library-${randomUUID()}`,
          operations: [{ packageId: params.packageId, type: "remove-library" }],
        });
        const updated = workspace.describe(locator);
        writeJson(response, 200, {
          ...result,
          libraries: librarySnapshots(updated),
          librarySources: updated.workspace?.librarySources ?? [],
          warnings: updated.status?.warnings ?? [],
        });
        return;
      }
      if (request.method === "POST" && route === "/v1/libraries/refresh") {
        const params = await readJson(request);
        const linked = backend.snapshot.manifest.libraries?.find(
          ({ packageId }) => packageId === params.packageId,
        );
        if (!linked) {
          throw new SmallPenError(
            "missing_library",
            `Library is not linked: ${params.packageId}`,
          );
        }
        if (linked.source.type === "url") {
          const refreshed = await openRemoteLibrary(linked.source.url, {
            cacheRoot: libraryCacheRoot,
            expectedPackageId: linked.packageId,
            refresh: true,
          });
          if (refreshed.manifest.packageId !== linked.packageId) {
            throw new SmallPenError(
              "library_id_mismatch",
              "Refreshed URL returned a different Library Package",
              {
                actualPackageId: refreshed.manifest.packageId,
                expectedPackageId: linked.packageId,
              },
            );
          }
        }
        const updated = await workspace.refresh(locator);
        writeJson(response, 200, {
          libraries: librarySnapshots(updated),
          librarySources: updated.workspace?.librarySources ?? [],
          warnings: updated.status?.warnings ?? [],
        });
        return;
      }
      if (request.method === "GET" && route === "/v1/ui/overview") {
        writeJson(response, 200, createWorkspaceOverview(description));
        return;
      }
      if (request.method === "GET" && route === "/v1/ui/design") {
        writeJson(
          response,
          200,
          createDesignWorkspace(description, designSelector(url)),
        );
        return;
      }
      if (request.method === "POST" && route === "/v1/ui/compare") {
        const params = await readJson(request);
        writeJson(
          response,
          200,
          createCompareWorkspace(description, params.selectors),
        );
        return;
      }
      if (request.method === "GET" && route === "/v1/ui/canvas") {
        // DSC-009/010: generated canvas surface (scene+layout+render).
        // Observational combination via ?themes=<id,id>; read-only.
        const themes = (url.searchParams.get("themes") ?? "")
          .split(",")
          .filter((themeId) => themeId.length > 0);
        const payload = await createCanvasWorkspace(description, { themes });
        writeJson(response, 200, payload);
        return;
      }
      if (request.method === "GET" && route === "/v1/ui/design-system") {
        // DSP-014-A: the aggregation is a pure function of the package
        // snapshot, so memoize it per locator+revision (bounded LRU of 2)
        // to keep repeated workbench polls cheap. `status` stays live.
        const memoKey = `${locator}@${description.snapshot.revision}`;
        if (designSystemMemo.key !== memoKey) {
          const entries = designSystemMemo.entries.filter(
            (entry) => entry.key !== memoKey,
          );
          entries.push({ key: memoKey, value: createDesignSystemWorkspace(description) });
          designSystemMemo.entries = entries.slice(-2);
          designSystemMemo.key = memoKey;
        }
        const cached = designSystemMemo.entries.find(
          (entry) => entry.key === memoKey,
        );
        writeJson(
          response,
          200,
          cached?.value ?? createDesignSystemWorkspace(description),
        );
        return;
      }
      if (request.method === "GET" && route === "/v1/ui/requirements") {
        writeJson(response, 200, createRequirementsWorkspace(description));
        return;
      }
      if (request.method === "GET" && route === "/v1/ui/catalog") {
        writeJson(
          response,
          200,
          createCatalogWorkspace(description, designSelector(url).context),
        );
        return;
      }
      if (request.method === "GET" && route === "/v1/ui/repair") {
        writeJson(response, 200, createRepairWorkspace(description));
        return;
      }
      if (request.method === "GET" && route === "/v1/ui/evidence") {
        const product = description.workspace?.product ?? backend.snapshot;
        const foundation = description.workspace?.foundation;
        const bundle = await createEvidence(product, {
          foundation,
          libraries: description.workspace?.libraries ?? [],
          scale: 1,
          selector: designSelector(url),
        });
        writeJson(response, 200, {
          evidence: bundle.evidence,
          image: {
            base64: Buffer.from(bundle.render.bytes).toString("base64"),
            mimeType: bundle.render.mimeType,
          },
        });
        return;
      }
      if (request.method === "GET" && route === "/v1/workspace") {
        const effective = projectEffectiveSnapshot(backend.snapshot, {
          foundation: description.workspace?.foundation,
          libraries: description.workspace?.libraries ?? [],
        });
        const projected = await createWebWorkspaceSnapshot(effective, {
          foundation: description.workspace?.foundation,
          libraries: description.workspace?.libraries ?? [],
        });
        const { blobs: _blobs, ...snapshot } = projected;
        const projectionWarnings = projected.projectionErrors.map((error) => ({
          code: error.code,
          message: error.message,
          path: [error.screenId, error.presentationId, error.nodeId]
            .filter(Boolean)
            .join("/"),
        }));
        writeJson(response, 200, {
          ...snapshot,
          capabilities: backend.capabilities(),
          formatCapabilities: SMALLPEN_FORMAT_CAPABILITIES,
          libraries: librarySnapshots(description),
          librarySources: description.workspace?.librarySources ?? [],
          packageSessionId: packageSessionId(locator),
          packageStatus: {
            ...description.status,
            readOnly: description.status.readOnly || projectionWarnings.length > 0,
            warnings: [
              ...(description.status.warnings ?? []),
              ...projectionWarnings,
            ],
          },
          preferences: application.preferences,
          viewState: description.viewState,
        });
        return;
      }
      if (request.method === "POST" && route === "/v1/view-state") {
        const viewState = workspace.updateViewState(
          locator,
          await readJson(request),
        );
        writeJson(response, 200, { viewState });
        return;
      }
      if (request.method === "POST" && route === "/v1/history/undo") {
        const result = await workspace.undo(locator);
        revisionNumber += 1;
        writeJson(response, 200, {
          ...result,
          lagged: [],
          revn: revisionNumber,
        });
        return;
      }
      if (request.method === "POST" && route === "/v1/history/redo") {
        const result = await workspace.redo(locator);
        revisionNumber += 1;
        writeJson(response, 200, {
          ...result,
          lagged: [],
          revn: revisionNumber,
        });
        return;
      }
      if (request.method === "POST" && route === "/v1/save") {
        writeJson(response, 200, await workspace.save(locator));
        return;
      }
      if (request.method === "POST" && route === "/v1/tokens/import") {
        // Review-then-apply for the token import UI. Without apply this is a
        // pure dry run: the diff, warnings, and resulting library. With apply
        // the same selection is committed as one atomic Operation Batch.
        const params = await readJson(request);
        const result = importTokens(description.snapshot, params.document, {
          selection: Array.isArray(params.selection)
            ? params.selection
            : undefined,
          setName:
            typeof params.setName === "string" ? params.setName : undefined,
        });
        const review = {
          diff: result.diff,
          library: result.library,
          previousLibraryId: result.previousLibraryId,
          warnings: result.warnings,
        };
        if (params.apply !== true) {
          writeJson(response, 200, { ...review, applied: false });
          return;
        }
        const committed = await workspace.commit(locator, {
          baseRevision: description.snapshot.revision,
          batchId:
            typeof params.batchId === "string"
              ? params.batchId
              : `import_tokens_${randomUUID()}`,
          operations: result.operations,
        });
        revisionNumber += 1;
        writeJson(response, 200, { ...committed, ...review, applied: true });
        return;
      }
      if (request.method === "POST" && route === "/v1/operations") {
        const result = await workspace.commit(locator, await readJson(request));
        revisionNumber += 1;
        writeJson(response, 200, {
          ...result,
          lagged: [],
          revn: revisionNumber,
        });
        return;
      }
      if (request.method === "GET" && route.startsWith("/v1/media/")) {
        const [runtimeId, suffix, extra] = route
          .slice("/v1/media/".length)
          .split("/");
        if (
          extra !== undefined ||
          (suffix !== undefined && suffix !== "thumbnail")
        ) {
          writeJson(response, 404, {
            error: { code: "not_found", message: "Media route not found" },
          });
          return;
        }
        const resolved = workspaceAssetDescriptor(
          description,
          runtimeId,
          mediaDescriptor,
        );
        if (!resolved) {
          writeJson(response, 404, {
            error: { code: "missing_media", message: "Media not found" },
          });
          return;
        }
        writeBinary(response, resolved.snapshot, resolved.descriptor, "Media");
        return;
      }
      if (request.method === "GET" && route.startsWith("/v1/font/")) {
        const [runtimeId, extra] = route.slice("/v1/font/".length).split("/");
        if (extra !== undefined) {
          writeJson(response, 404, {
            error: { code: "not_found", message: "Font route not found" },
          });
          return;
        }
        const resolved = workspaceAssetDescriptor(
          description,
          runtimeId,
          fontDescriptor,
        );
        if (!resolved) {
          writeJson(response, 404, {
            error: { code: "missing_font", message: "Font not found" },
          });
          return;
        }
        writeBinary(response, resolved.snapshot, resolved.descriptor, "Font");
        return;
      }
      if (request.method === "POST" && route === "/v1/upload/session") {
        const now = Date.now();
        for (const [id, session] of uploadSessions) {
          if (now - session.createdAt > UPLOAD_SESSION_MAX_AGE) {
            uploadSessions.delete(id);
          }
        }
        if (uploadSessions.size >= MAX_UPLOAD_SESSIONS) {
          throw new SmallPenError(
            "too_many_upload_sessions",
            "Too many Font upload sessions are active",
          );
        }
        const params = await readJson(request);
        const totalChunks = params.totalChunks ?? params["total-chunks"];
        if (
          !Number.isSafeInteger(totalChunks) ||
          totalChunks < 1 ||
          totalChunks > 1024
        ) {
          throw new SmallPenError(
            "invalid_upload_session",
            "Font upload totalChunks must be between 1 and 1024",
          );
        }
        const id = randomUUID();
        uploadSessions.set(id, {
          chunks: new Map(),
          createdAt: now,
          locator,
          size: 0,
          totalChunks,
        });
        writeJson(response, 201, { "session-id": id });
        return;
      }
      const chunkRoute =
        request.method === "POST"
          ? /^\/v1\/upload\/session\/([a-f0-9-]{36})\/chunk\/(\d+)$/.exec(route)
          : null;
      if (chunkRoute) {
        const [, sessionId, rawIndex] = chunkRoute;
        const session = uploadSessions.get(sessionId);
        const index = Number(rawIndex);
        if (
          !session ||
          session.locator !== locator ||
          !Number.isSafeInteger(index) ||
          index >= session.totalChunks
        ) {
          throw new SmallPenError(
            "invalid_upload_session",
            "Font upload session or chunk index is invalid",
          );
        }
        if (session.chunks.has(index)) {
          throw new SmallPenError(
            "duplicate_upload_chunk",
            `Font upload chunk already exists: ${index}`,
          );
        }
        const bytes = await readBytes(request, MAX_FONT_BYTES, {
          emptyCode: "invalid_font_blob",
          label: "Font chunk",
          tooLargeCode: "font_too_large",
        });
        if (session.size + bytes.byteLength > MAX_FONT_BYTES) {
          throw new SmallPenError(
            "font_too_large",
            "Uploaded Font is too large",
          );
        }
        session.chunks.set(index, bytes);
        session.size += bytes.byteLength;
        writeJson(response, 200, { index, "session-id": sessionId });
        return;
      }
      if (request.method === "POST" && route === "/v1/media/assemble") {
        const params = await readJson(request);
        const sessionId = String(
          params.sessionId ?? params["session-id"] ?? "",
        );
        const session = uploadSessions.get(sessionId);
        if (
          !session ||
          session.locator !== locator ||
          session.chunks.size !== session.totalChunks
        ) {
          throw new SmallPenError(
            "incomplete_upload_session",
            `Media upload session is incomplete: ${sessionId}`,
          );
        }
        const ordered = Array.from(
          { length: session.totalChunks },
          (_, index) => session.chunks.get(index),
        );
        if (ordered.some((chunk) => !chunk)) {
          throw new SmallPenError(
            "incomplete_upload_session",
            `Media upload session is incomplete: ${sessionId}`,
          );
        }
        const bytes = new Uint8Array(Buffer.concat(ordered));
        const mimeType = String(params.mtype ?? "").toLowerCase();
        const name = String(params.name ?? "").trim();
        const { height, width } = inspectImage(bytes, mimeType);
        const runtimeId = randomUUID();
        const id = `media_${runtimeId.replaceAll("-", "")}`;
        const { descriptor, result } = await workspace.importMedia(locator, {
          bytes,
          height,
          id,
          mimeType,
          name,
          width,
        });
        uploadSessions.delete(sessionId);
        writeJson(response, 201, {
          "file-id": backend.snapshot.runtime.file,
          height: descriptor.height,
          id: backend.snapshot.runtime.media[id],
          "is-local": true,
          "media-id": backend.snapshot.runtime.mediaStorage[id],
          mtype: descriptor.mimeType,
          name: descriptor.name,
          revision: result.revision,
          width: descriptor.width,
        });
        return;
      }
      if (request.method === "POST" && route === "/v1/font/variant") {
        const params = await readJson(request);
        const rawFontId = String(params.fontId ?? params["font-id"] ?? "");
        const family = String(params.fontFamily ?? params["font-family"] ?? "");
        const style = String(params.fontStyle ?? params["font-style"] ?? "");
        const weight = params.fontWeight ?? params["font-weight"];
        const uploads = params.uploads;
        const runtimeFontId = rawFontId.replace(/^custom-/, "");
        const fontId =
          backend.snapshot.runtime.reverseFonts?.[runtimeFontId]?.fontId ??
          (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
            runtimeFontId,
          )
            ? `font_${runtimeFontId.replaceAll("-", "").toLowerCase()}`
            : null);
        if (!fontId || !uploads || typeof uploads !== "object") {
          throw new SmallPenError(
            "invalid_font_variant",
            "Font Variant identity or uploads are invalid",
          );
        }
        const input = {};
        const consumed = [];
        let totalSize = 0;
        for (const [mimeType, rawSessionId] of Object.entries(uploads)) {
          const sessionId = String(rawSessionId);
          const session = uploadSessions.get(sessionId);
          if (
            !session ||
            session.locator !== locator ||
            session.chunks.size !== session.totalChunks
          ) {
            throw new SmallPenError(
              "incomplete_upload_session",
              `Font upload session is incomplete: ${sessionId}`,
            );
          }
          const ordered = Array.from(
            { length: session.totalChunks },
            (_, index) => session.chunks.get(index),
          );
          if (ordered.some((chunk) => !chunk)) {
            throw new SmallPenError(
              "incomplete_upload_session",
              `Font upload session is incomplete: ${sessionId}`,
            );
          }
          const bytes = new Uint8Array(Buffer.concat(ordered));
          totalSize += bytes.byteLength;
          if (totalSize > MAX_FONT_BYTES) {
            throw new SmallPenError(
              "font_too_large",
              "Uploaded Font is too large",
            );
          }
          input[mimeType] = bytes;
          consumed.push(sessionId);
        }
        const files = prepareFontFiles(input);
        const id = `fvar_${randomUUID().replaceAll("-", "")}`;
        const name = `${style === "italic" ? "Italic " : ""}${weight}`;
        const imported = await workspace.importFontVariant(locator, {
          family,
          files,
          fontId,
          id,
          name,
          style,
          weight,
        });
        for (const sessionId of consumed) uploadSessions.delete(sessionId);
        const fontRuntimeId = backend.snapshot.runtime.fonts[fontId];
        const variantRuntimeId = backend.snapshot.runtime.fontVariants[id];
        const fileIds = backend.snapshot.runtime.fontFiles[id];
        writeJson(response, 201, {
          id: variantRuntimeId,
          "team-id": LOCAL_TEAM_ID,
          "font-id": fontRuntimeId,
          "font-family": family,
          "font-weight": weight,
          "font-style": style,
          "variant-name": name,
          "woff1-file-id": fileIds.woff,
          ...(fileIds.woff2 ? { "woff2-file-id": fileIds.woff2 } : {}),
          ...(fileIds.ttf ? { "ttf-file-id": fileIds.ttf } : {}),
          ...(fileIds.otf ? { "otf-file-id": fileIds.otf } : {}),
          revision: imported.result.revision,
        });
        return;
      }
      if (request.method === "POST" && route === "/v1/font/update") {
        const params = await readJson(request);
        const runtimeId = String(params.id ?? "").replace(/^custom-/, "");
        const fontId =
          backend.snapshot.runtime.reverseFonts?.[runtimeId]?.fontId;
        if (!fontId) throw new SmallPenError("missing_font", "Font not found");
        const result = await workspace.updateFontFamily(
          locator,
          fontId,
          params.name,
        );
        writeJson(response, 200, { revision: result.revision });
        return;
      }
      if (request.method === "POST" && route === "/v1/font/delete") {
        const params = await readJson(request);
        const runtimeId = String(params.id ?? "").replace(/^custom-/, "");
        const fontId =
          backend.snapshot.runtime.reverseFonts?.[runtimeId]?.fontId;
        if (!fontId) throw new SmallPenError("missing_font", "Font not found");
        const result = await workspace.deleteFontFamily(locator, fontId);
        writeJson(response, 200, { revision: result.revision });
        return;
      }
      if (request.method === "POST" && route === "/v1/font/variant/delete") {
        const params = await readJson(request);
        const fontVariantId =
          backend.snapshot.runtime.reverseFontVariants?.[String(params.id)]
            ?.fontVariantId;
        if (!fontVariantId) {
          throw new SmallPenError(
            "missing_font_variant",
            "Font Variant not found",
          );
        }
        const result = await workspace.deleteFontVariant(
          locator,
          fontVariantId,
        );
        writeJson(response, 200, { revision: result.revision });
        return;
      }
      if (request.method === "POST" && route === "/v1/media/import") {
        const mimeType = String(request.headers["content-type"] ?? "")
          .split(";", 1)[0]
          .trim()
          .toLowerCase();
        const rawName = String(
          request.headers["x-smallpen-media-name"] ?? "",
        ).trim();
        if (rawName.length === 0 || rawName.length > 255) {
          throw new SmallPenError(
            "invalid_library_media",
            "Uploaded Media name must contain 1 to 255 characters",
          );
        }
        const bytes = await readBytes(request);
        const { height, width } = inspectImage(bytes, mimeType);
        const runtimeId = randomUUID();
        const id = `media_${runtimeId.replaceAll("-", "")}`;
        const { descriptor, result } = await workspace.importMedia(locator, {
          bytes,
          height,
          id,
          mimeType,
          name: rawName,
          width,
        });
        const mediaRuntimeId = backend.snapshot.runtime.media[id];
        writeJson(response, 201, {
          "file-id": backend.snapshot.runtime.file,
          height: descriptor.height,
          id: mediaRuntimeId,
          "is-local": true,
          "media-id": backend.snapshot.runtime.mediaStorage[id],
          mtype: descriptor.mimeType,
          name: descriptor.name,
          revision: result.revision,
          width: descriptor.width,
        });
        return;
      }
      if (request.method === "GET" && route === "/v1/events") {
        response.writeHead(200, {
          "access-control-allow-origin": "*",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "content-type": "text/event-stream",
        });
        response.write(": connected\n\n");
        eventStreams.add(response);
        request.on("close", () => eventStreams.delete(response));
        return;
      }
      if (request.method === "POST" && route === "/v1/penpot/commit") {
        const commit = await readJson(request);
        if (
          typeof commit.baseRevision !== "string" ||
          commit.baseRevision.length === 0
        ) {
          throw new SmallPenError(
            "missing_base_revision",
            "Penpot commit must contain the projected baseRevision",
          );
        }
        if (commit.baseRevision !== backend.snapshot.revision) {
          throw new SmallPenError(
            "stale_revision",
            "Penpot projection is stale; reload the workspace before replaying the edit",
            {
              actualRevision: backend.snapshot.revision,
              baseRevision: commit.baseRevision,
            },
          );
        }
        const foundation = description.workspace?.foundation;
        const libraries = description.workspace?.libraries ?? [];
        const effective = projectEffectiveSnapshot(backend.snapshot, {
          foundation,
          libraries,
        });
        const projected = await createWebWorkspaceSnapshot(effective, {
          foundation,
          libraries,
        });
        const batch = compilePenpotChanges(
          { ...effective, runtime: projected.runtime },
          commit,
          { libraries: [foundation, ...libraries].filter(Boolean) },
        );
        const result = await workspace.commit(locator, batch);
        revisionNumber += 1;
        writeJson(response, 200, {
          ...result,
          // DSE-R26: the frontend re-derives the generated page when a
          // token-touching batch lands, so every bound specimen (other
          // combination columns, alias displays, component and page
          // occurrences) resyncs with the new Cell values.
          operationTypes: batch.operations.map((operation) => operation.type),
          lagged: [],
          revn: revisionNumber,
        });
        return;
      }
      writeJson(response, 404, {
        error: { code: "not_found", message: "Route not found" },
      });
    } catch (error) {
      writeError(response, error);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const selectedPort =
    typeof address === "object" && address ? address.port : port;

  return {
    backend: initialBackend,
    host,
    port: selectedPort,
    url: `${originFor(host, selectedPort)}${sessionPath}`,
    workspace,
    async close() {
      unsubscribe();
      for (const stream of eventStreams) stream.end();
      eventStreams.clear();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await workspace.closeAll();
    },
  };
}
