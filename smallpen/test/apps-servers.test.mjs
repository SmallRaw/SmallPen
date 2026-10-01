import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { serveLocalPackage } from "@smallpen/background";
import { servePenpotFrontend } from "@smallpen/web";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "roundtrip.smallpen");
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function startBackground(context) {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-apps-servers-"));
  const packagePath = join(parent, "first.smallpen");
  await cp(fixture, packagePath, { recursive: true });
  const background = await serveLocalPackage({ packagePath, port: 0 });
  context.after(async () => {
    await background.close();
    await rm(parent, { force: true, recursive: true });
  });
  return { background, parent };
}

async function startWeb(context, remoteFetch) {
  const { background, parent } = await startBackground(context);
  const frontendRoot = join(parent, "penpot-frontend");
  await mkdir(frontendRoot, { recursive: true });
  await writeFile(join(frontendRoot, "index.html"), "<!doctype html><p>Penpot");
  const web = await servePenpotFrontend({
    backendUrl: background.url,
    frontendRoot,
    port: 0,
    ...(remoteFetch ? { remoteFetch } : {}),
  });
  context.after(() => web.close());
  return { background, web };
}

// fetch() cannot set Host or send raw paths, so these use node:http directly.
function rawRequest(base, path, { body, headers = {}, method = "GET" } = {}) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        headers,
        host: url.hostname,
        method,
        path,
        port: url.port,
        setHost: headers.host === undefined,
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () =>
          resolve({ headers: response.headers, status: response.statusCode, text }),
        );
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}

// Writes bytes the HTTP client would refuse to produce and returns the reply.
function rawSocket(base, payload) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname);
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => (text += chunk));
    socket.on("end", () => resolve(text));
    socket.on("close", () => resolve(text));
    socket.on("error", reject);
    socket.write(payload);
    setTimeout(() => socket.end(), 200);
  });
}

test("Web font proxy refuses targets outside the fixed Google upstreams", async (context) => {
  const requests = [];
  const remoteFetch = async (target) => {
    requests.push(target.href);
    return new Response("<script>alert(1)</script>", {
      headers: { "content-type": "text/html" },
    });
  };
  const { web } = await startWeb(context, remoteFetch);

  for (const path of [
    "/internal/gfonts/font/https://evil.example/page",
    "/internal/gfonts/font//evil.example/page",
    "/internal/gfonts/font/%2e%2e/page",
  ]) {
    const response = await rawRequest(web.origin, path);
    assert.equal(response.status, 404, path);
  }
  assert.deepEqual(requests, [], "no escaped target reaches the network");

  const html = await fetch(`${web.origin}/internal/gfonts/font/inter/a.woff2`);
  assert.equal(html.status, 502);
  assert.equal((await html.json()).error.code, "google_font_invalid_type");
  const css = await fetch(`${web.origin}/internal/gfonts/css?family=Inter`);
  assert.equal(css.status, 502);
});

test("Web font proxy marks passed-through fonts as sandboxed and unsniffable", async (context) => {
  const remoteFetch = async (target) =>
    target.hostname === "fonts.googleapis.com"
      ? new Response("@font-face{}", {
          headers: { "content-type": "text/css; charset=utf-8" },
        })
      : new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "font/woff2" },
        });
  const { web } = await startWeb(context, remoteFetch);
  for (const path of ["/internal/gfonts/css?family=Inter", "/internal/gfonts/font/inter/a.woff2"]) {
    const response = await fetch(`${web.origin}${path}`);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("content-security-policy"), "sandbox");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  }
});

test("Web font proxy passes large CJK stylesheets and stops an endless body at the cap", async (context) => {
  // Penpot requests every variant of a family at once; for CJK families
  // Google lists ~100 unicode-range faces per weight (Noto Sans TC: ~1.1 MB).
  const face = "@font-face{font-family:'Zen Maru Gothic';src:url(https://fonts.gstatic.com/s/zen/a.woff2)}\n";
  const css = face.repeat(Math.ceil((1200 * 1024) / face.length));
  let pulled = 0;
  const remoteFetch = async (target) => {
    if (target.searchParams.get("family") === "Endless") {
      // No content-length: only the streamed size can enforce the cap.
      const chunk = new Uint8Array(64 * 1024);
      return new Response(
        new ReadableStream({
          pull(controller) {
            pulled += chunk.length;
            controller.enqueue(chunk);
          },
        }),
        { headers: { "content-type": "text/css" } },
      );
    }
    return new Response(css, { headers: { "content-type": "text/css; charset=utf-8" } });
  };
  const { web } = await startWeb(context, remoteFetch);

  const large = await fetch(`${web.origin}/internal/gfonts/css?family=Zen+Maru+Gothic:300,regular,500,700,900`);
  assert.equal(large.status, 200);
  assert.equal(await large.text(), css);

  const endless = await fetch(`${web.origin}/internal/gfonts/css?family=Endless`);
  assert.equal(endless.status, 502);
  assert.equal((await endless.json()).error.code, "google_font_too_large");
  assert.ok(pulled < 8 * 1024 * 1024, `read ${pulled} bytes past the cap`);
});

test("Web refuses foreign Host and Origin headers and non-JSON control bodies", async (context) => {
  const { web } = await startWeb(context);
  const port = new URL(web.origin).port;

  const rebound = await rawRequest(web.origin, "/health", {
    headers: { host: `attacker.example:${port}` },
  });
  assert.equal(rebound.status, 403);
  const otherPort = await rawRequest(web.origin, "/health", {
    headers: { host: "127.0.0.1:1" },
  });
  assert.equal(otherPort.status, 403);
  const localhost = await rawRequest(web.origin, "/health", {
    headers: { host: `localhost:${port}` },
  });
  assert.equal(localhost.status, 200);

  const body = JSON.stringify({ locator: "/tmp/x.smallpen" });
  const foreign = await rawRequest(web.origin, "/desktop/open-package", {
    body,
    headers: {
      "content-type": "application/json",
      origin: "http://attacker.example",
    },
    method: "POST",
  });
  assert.equal(foreign.status, 403);
  const simple = await rawRequest(web.origin, "/desktop/open-package", {
    body,
    headers: { "content-type": "text/plain", origin: web.origin },
    method: "POST",
  });
  assert.equal(simple.status, 415);
});

test("Web survives malformed Host headers and request targets", async (context) => {
  const { web } = await startWeb(context);
  const port = new URL(web.origin).port;
  const badHost = await rawSocket(
    web.origin,
    "GET /health HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n",
  );
  assert.match(badHost, /^HTTP\/1\.1 (400|403)/);
  const badTarget = await rawSocket(
    web.origin,
    `GET //[ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
  );
  assert.match(badTarget, /^HTTP\/1\.1 [45]\d\d/);
  assert.equal((await fetch(`${web.origin}/health`)).status, 200);
});

test("Background only grants CORS to loopback origins and refuses others", async (context) => {
  const { background } = await startBackground(context);
  const port = new URL(background.url).port;

  const plain = await fetch(`${background.url}/v1/packages`);
  assert.equal(plain.status, 200);
  assert.equal(plain.headers.get("access-control-allow-origin"), null);

  const local = await fetch(`${background.url}/v1/packages`, {
    headers: { origin: "http://127.0.0.1:43128" },
  });
  assert.equal(local.status, 200);
  assert.equal(
    local.headers.get("access-control-allow-origin"),
    "http://127.0.0.1:43128",
  );

  const preflight = await rawRequest(background.url, `${new URL(background.url).pathname}/v1/operations`, {
    headers: {
      "access-control-request-method": "POST",
      origin: "http://localhost:3449",
    },
    method: "OPTIONS",
  });
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers["access-control-allow-origin"],
    "http://localhost:3449",
  );

  for (const origin of ["http://attacker.example", "null", "https://127.0.0.1:43128"]) {
    const refused = await fetch(`${background.url}/v1/packages`, {
      headers: { origin },
    });
    assert.equal(refused.status, 403, origin);
    assert.equal(refused.headers.get("access-control-allow-origin"), null);
  }

  const rebound = await rawRequest(background.url, "/health", {
    headers: { host: `attacker.example:${port}` },
  });
  assert.equal(rebound.status, 403);
});

test("Background requires JSON bodies on JSON routes", async (context) => {
  const { background } = await startBackground(context);
  const response = await fetch(`${background.url}/v1/preferences`, {
    body: JSON.stringify({ renderer: "wasm" }),
    headers: { "content-type": "text/plain" },
    method: "POST",
  });
  assert.equal(response.status, 415);
  assert.equal((await response.json()).error.code, "unsupported_media_type");
});

test("Background survives malformed Host headers and request targets", async (context) => {
  const { background } = await startBackground(context);
  const port = new URL(background.url).port;
  const badHost = await rawSocket(
    background.url,
    "GET /health HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n",
  );
  assert.match(badHost, /^HTTP\/1\.1 (400|403)/);
  const badTarget = await rawSocket(
    background.url,
    `GET //[ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
  );
  assert.match(badTarget, /^HTTP\/1\.1 [45]\d\d/);
  assert.equal((await fetch(`${background.url}/v1/packages`)).status, 200);
});

test("Background decodes URI-encoded Media names and keeps raw legacy names", async (context) => {
  const { background } = await startBackground(context);
  const encoded = await fetch(`${background.url}/v1/media/import`, {
    body: pixel,
    headers: {
      "content-type": "image/png",
      "x-smallpen-media-name": encodeURIComponent("截图.png"),
    },
    method: "POST",
  });
  assert.equal(encoded.status, 201);
  assert.equal((await encoded.json()).name, "截图.png");

  const legacy = await fetch(`${background.url}/v1/media/import`, {
    body: pixel,
    headers: {
      "content-type": "image/png",
      "x-smallpen-media-name": "100% done.png",
    },
    method: "POST",
  });
  assert.equal(legacy.status, 201);
  assert.equal((await legacy.json()).name, "100% done.png");
});

test("Background token import rejects a stale baseRevision", async (context) => {
  const { background } = await startBackground(context);
  const document = {
    core: { color: { brand: { $type: "color", $value: "#336699" } } },
  };
  const post = (body) =>
    fetch(`${background.url}/v1/tokens/import`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  const initial = background.backend.snapshot.revision;

  const stale = await post({
    apply: true,
    baseRevision: "sha256-stale",
    document,
  });
  assert.equal(stale.status, 409);
  const staleError = (await stale.json()).error;
  assert.equal(staleError.code, "stale_revision");
  assert.deepEqual(staleError.details, {
    actualRevision: initial,
    baseRevision: "sha256-stale",
  });
  assert.equal(background.backend.snapshot.revision, initial);

  const invalid = await post({ apply: true, baseRevision: 7, document });
  assert.equal(invalid.status, 422);
  assert.equal((await invalid.json()).error.code, "invalid_base_revision");

  const current = await post({ apply: true, baseRevision: initial, document });
  assert.equal(current.status, 200);
  assert.equal((await current.json()).applied, true);
  assert.notEqual(background.backend.snapshot.revision, initial);

  // Callers that predate baseRevision keep working.
  const legacy = await post({ apply: false, document });
  assert.equal(legacy.status, 200);
});
