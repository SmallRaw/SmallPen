import { readFile, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MAX_CONTROL_BODY_BYTES = 16 * 1024;
const MAX_GOOGLE_FONT_CSS_BYTES = 256 * 1024;
const MAX_GOOGLE_FONT_FILE_BYTES = 16 * 1024 * 1024;
const GOOGLE_FONT_CSS_URL = "https://fonts.googleapis.com/css";
const GOOGLE_FONT_FILE_PREFIX = "https://fonts.gstatic.com/s/";
const SHADOW_MODULE_LOADED_CALL =
  "shadow.cljs.devtools.client.env.module_loaded(";
const SAFE_SHADOW_MODULE_LOADED_CALL =
  "globalThis.shadow?.cljs?.devtools?.client?.env?.module_loaded?.(";
const defaultFrontendRoot = fileURLToPath(
  new URL("../../../../frontend/resources/public/", import.meta.url),
);

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".ttf", "font/ttf"],
  [".wasm", "application/wasm"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function loopbackHost(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function originFor(host, port) {
  const hostname = host.includes(":") ? `[${host}]` : host;
  return `http://${hostname}:${port}`;
}

function normalizeBackendUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Background URL must use http or https");
  }
  if (!loopbackHost(url.hostname)) {
    throw new Error("Background URL must use a loopback host");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

function backendEndpoint(backendUrl, path) {
  const target = new URL(backendUrl.href);
  target.pathname = `${backendUrl.pathname}${path}`;
  return target;
}

function writeJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function writeError(response, status, code, message) {
  writeJson(response, status, { error: { code, message } });
}

async function proxyGoogleFont(
  request,
  response,
  target,
  maxBytes,
  remoteFetch,
) {
  const upstream = await remoteFetch(target, {
    headers: {
      accept: String(request.headers.accept ?? "*/*"),
      "user-agent": String(request.headers["user-agent"] ?? "SmallPen"),
    },
  });
  if (!upstream.ok) {
    writeError(
      response,
      502,
      "google_font_unavailable",
      `Google Fonts request failed (${upstream.status})`,
    );
    return;
  }
  const declaredLength = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    writeError(
      response,
      502,
      "google_font_too_large",
      "Google Fonts response is too large",
    );
    return;
  }
  const body = Buffer.from(await upstream.arrayBuffer());
  if (body.length > maxBytes) {
    writeError(
      response,
      502,
      "google_font_too_large",
      "Google Fonts response is too large",
    );
    return;
  }
  response.writeHead(200, {
    "cache-control":
      upstream.headers.get("cache-control") ?? "public, max-age=3600",
    "content-length": body.length,
    "content-type":
      upstream.headers.get("content-type") ?? "application/octet-stream",
    "x-content-type-options": "nosniff",
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

async function serveGoogleFont(request, response, url, remoteFetch) {
  if (url.pathname === "/internal/gfonts/css") {
    const target = new URL(GOOGLE_FONT_CSS_URL);
    target.search = url.search;
    await proxyGoogleFont(
      request,
      response,
      target,
      MAX_GOOGLE_FONT_CSS_BYTES,
      remoteFetch,
    );
    return true;
  }
  const prefix = "/internal/gfonts/font/";
  if (!url.pathname.startsWith(prefix)) return false;
  const suffix = url.pathname.slice(prefix.length);
  if (
    suffix.length === 0 ||
    suffix.includes("\\") ||
    suffix.split("/").some((part) => part === "..")
  ) {
    writeError(response, 404, "not_found", "Google Font path is invalid");
    return true;
  }
  const target = new URL(suffix, GOOGLE_FONT_FILE_PREFIX);
  target.search = url.search;
  await proxyGoogleFont(
    request,
    response,
    target,
    MAX_GOOGLE_FONT_FILE_BYTES,
    remoteFetch,
  );
  return true;
}

async function readJson(request) {
  if (
    !String(request.headers["content-type"] ?? "").startsWith(
      "application/json",
    )
  ) {
    throw new Error("Request body must use application/json");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_CONTROL_BODY_BYTES) {
      throw new Error("Request body is too large");
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const value = await response.json();
  if (!response.ok) {
    throw new Error(
      value?.error?.message ?? `Background request failed (${response.status})`,
    );
  }
  return value;
}

function workspaceHash(snapshot) {
  const screen = snapshot.manifest.entries.screens
    .map((entry) => snapshot.entries[entry])
    .find((entry) => entry.id === snapshot.manifest.defaultScreenId);
  const pageId = screen
    ? snapshot.runtime.pages[screen.id]?.[screen.basePresentationId]
    : undefined;
  const route = new URLSearchParams({
    "file-id": snapshot.runtime.file,
  });
  if (pageId) route.set("page-id", pageId);
  route.set("layout", "layers");
  return `#/workspace?${route}`;
}

function workspaceUrl(origin, snapshot) {
  const url = new URL("/", origin);
  url.hash = workspaceHash(snapshot);
  return url.href;
}

function homeUrl(origin) {
  return new URL("/", origin).href;
}

async function selectedWorkspace(
  backendUrl,
  { fileId, packageSessionId } = {},
) {
  const url = backendEndpoint(backendUrl, "/v1/workspace");
  const headers = packageSessionId
    ? { "x-smallpen-package": packageSessionId }
    : fileId
      ? { "x-smallpen-file": fileId }
      : undefined;
  return fetchJson(url, { headers });
}

async function openPackage(backendUrl, locator) {
  const opened = await fetchJson(
    backendEndpoint(backendUrl, "/v1/packages/open"),
    {
      body: JSON.stringify({ locator }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  return selectedWorkspace(backendUrl, {
    packageSessionId: opened.activeSessionId,
  });
}

async function createPackage(backendUrl, locator) {
  const created = await fetchJson(
    backendEndpoint(backendUrl, "/v1/packages/create"),
    {
      body: JSON.stringify({ locator }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  return selectedWorkspace(backendUrl, {
    packageSessionId: created.activeSessionId,
  });
}

function extension(path) {
  const index = path.lastIndexOf(".");
  return index === -1 ? "" : path.slice(index).toLowerCase();
}

function staticPath(frontendRoot, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  const requested =
    decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const target = resolve(frontendRoot, requested);
  const pathFromRoot = relative(frontendRoot, target);
  if (
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`)
  ) {
    return undefined;
  }
  if (isAbsolute(pathFromRoot)) return undefined;
  return target;
}

function isWithinRoot(rootPath, candidatePath) {
  const pathFromRoot = relative(rootPath, candidatePath);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
}

function prepareStaticBody(target, body) {
  if (extension(target) !== ".js") return body;
  const source = body.toString("utf8");
  if (!source.includes(SHADOW_MODULE_LOADED_CALL)) return body;
  return Buffer.from(
    source.replaceAll(
      SHADOW_MODULE_LOADED_CALL,
      SAFE_SHADOW_MODULE_LOADED_CALL,
    ),
  );
}

async function serveStatic(request, response, frontendRoot, pathname) {
  const requestedTarget = staticPath(frontendRoot, pathname);
  if (!requestedTarget) return false;
  let target;
  let descriptor;
  try {
    target = await realpath(requestedTarget);
    if (!isWithinRoot(frontendRoot, target)) return false;
    descriptor = await stat(target);
  } catch {
    return false;
  }
  if (!descriptor.isFile()) return false;
  const body = prepareStaticBody(target, await readFile(target));
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": body.length,
    "content-type":
      contentTypes.get(extension(target)) ?? "application/octet-stream",
    "x-content-type-options": "nosniff",
  });
  response.end(request.method === "HEAD" ? undefined : body);
  return true;
}

function runtimeScript(backendUrl, desktop) {
  const runtime = JSON.stringify({
    backendUrl: backendUrl.href,
    desktop,
  }).replaceAll("<", "\\u003c");
  return `<script>globalThis.smallpenRuntime=${runtime};</script>`;
}

function writeRuntimeIndex(request, response, indexBody, backendUrl, desktop) {
  const source = indexBody.toString("utf8");
  const doctype = /^\s*<!doctype\s+html[^>]*>/i.exec(source);
  const insertion = doctype ? doctype.index + doctype[0].length : 0;
  const body = Buffer.from(
    `${source.slice(0, insertion)}${runtimeScript(backendUrl, desktop)}${source.slice(insertion)}`,
  );
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": body.length,
    "content-type": "text/html; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function workspaceFileId(value, origin) {
  const workspace = parseUrl(value);
  if (workspace?.origin !== origin) return undefined;
  const match = /^#\/workspace\?(.*)$/.exec(workspace.hash);
  if (!match) return undefined;
  const fileId = new URLSearchParams(match[1]).get("file-id");
  return /^[a-f0-9-]{36}$/.test(fileId ?? "") ? fileId : undefined;
}

export async function servePenpotFrontend({
  backendUrl: backendValue,
  desktop = false,
  frontendRoot: frontendValue = defaultFrontendRoot,
  host = "127.0.0.1",
  port = 43128,
  remoteFetch = fetch,
}) {
  if (!loopbackHost(host)) {
    throw new Error("Penpot frontend must bind to a loopback host");
  }
  const backendUrl = normalizeBackendUrl(backendValue);
  const frontendRoot = await realpath(resolve(frontendValue));
  const indexPath = await realpath(resolve(frontendRoot, "index.html")).catch(
    () => undefined,
  );
  const index =
    indexPath && isWithinRoot(frontendRoot, indexPath)
      ? await stat(indexPath).catch(() => undefined)
      : undefined;
  if (!index?.isFile()) {
    throw new Error(
      `Penpot frontend build is missing index.html: ${frontendRoot}`,
    );
  }
  const initialSessions = await fetchJson(
    backendEndpoint(backendUrl, "/v1/packages"),
  );
  let initialWorkspace;
  if (initialSessions.activeSessionId) {
    try {
      initialWorkspace = await selectedWorkspace(backendUrl, {
        packageSessionId: initialSessions.activeSessionId,
      });
    } catch {
      // The static Web shell must remain available when the selected Package
      // cannot be projected. The browser will request /v1/workspace itself,
      // present the structured error, and return to SmallPen Home. Failing the
      // Web server here would leave no UI capable of reporting the problem.
    }
  }
  let origin;
  const server = createServer(async (request, response) => {
    const url = new URL(
      request.url ?? "/",
      origin ?? `http://${request.headers.host ?? "127.0.0.1"}`,
    );
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, { status: "ok", ui: "penpot" });
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/desktop/open-package"
      ) {
        const params = await readJson(request);
        const locator = String(params.locator ?? "").trim();
        if (locator.length === 0 || locator.length > 4096) {
          writeError(
            response,
            422,
            "invalid_package_locator",
            "Package locator is invalid",
          );
          return;
        }
        const snapshot = await openPackage(backendUrl, locator);
        writeJson(response, 201, {
          url: workspaceUrl(origin, snapshot),
        });
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/desktop/create-package"
      ) {
        const params = await readJson(request);
        const locator = String(params.locator ?? "").trim();
        if (locator.length === 0 || locator.length > 4096) {
          writeError(
            response,
            422,
            "invalid_package_locator",
            "Package locator is invalid",
          );
          return;
        }
        const snapshot = await createPackage(backendUrl, locator);
        writeJson(response, 201, {
          url: workspaceUrl(origin, snapshot),
        });
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/desktop/close-package"
      ) {
        const params = await readJson(request);
        const explicitFileId = String(params.fileId ?? "");
        const fileId = /^[a-f0-9-]{36}$/.test(explicitFileId)
          ? explicitFileId
          : workspaceFileId(String(params.url ?? ""), origin);
        if (!fileId) {
          writeError(
            response,
            422,
            "invalid_workspace_url",
            "Workspace URL is not open",
          );
          return;
        }
        const snapshot = await selectedWorkspace(backendUrl, { fileId });
        await fetchJson(
          backendEndpoint(
            backendUrl,
            `/v1/packages/${encodeURIComponent(snapshot.packageSessionId)}/close`,
          ),
          { method: "POST" },
        );
        writeJson(response, 200, { status: "closed" });
        return;
      }

      if (
        (request.method === "GET" || request.method === "HEAD") &&
        url.pathname === "/js/config.js"
      ) {
        const body = [
          'var penpotFlags = "";',
          `var penpotPublicURI = ${JSON.stringify(`${origin}/`)};`,
          "",
        ].join("\n");
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-length": Buffer.byteLength(body),
          "content-type": "text/javascript; charset=utf-8",
          "x-content-type-options": "nosniff",
        });
        response.end(request.method === "HEAD" ? undefined : body);
        return;
      }
      if (request.method === "GET" || request.method === "HEAD") {
        if (await serveGoogleFont(request, response, url, remoteFetch)) return;
        if (url.pathname === "/") {
          writeRuntimeIndex(
            request,
            response,
            await readFile(indexPath),
            backendUrl,
            desktop,
          );
          return;
        }
        if (await serveStatic(request, response, frontendRoot, url.pathname))
          return;
      }
      writeError(response, 404, "not_found", "Route not found");
    } catch (error) {
      writeError(
        response,
        502,
        "local_workspace_unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolveListen);
  });
  const address = server.address();
  const selectedPort =
    typeof address === "object" && address ? address.port : port;
  origin = originFor(host, selectedPort);

  return {
    backendUrl: backendUrl.href,
    frontendRoot,
    host,
    origin,
    port: selectedPort,
    url: homeUrl(origin),
    workspaceUrl: initialWorkspace
      ? workspaceUrl(origin, initialWorkspace)
      : undefined,
    async close() {
      await new Promise((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      });
    },
  };
}
