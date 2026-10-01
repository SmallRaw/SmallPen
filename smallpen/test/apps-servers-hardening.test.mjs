import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { serveLocalPackage } from "@smallpen/background";
import { servePenpotFrontend } from "@smallpen/web";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "roundtrip.smallpen");

async function copyFixture(context) {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-apps-hardening-"));
  // After hooks run in order and stop at the first failure: servers close
  // before the directory goes, since a live Background writes lock claims
  // beside its Package and an early rm could fail and skip close().
  const closers = [];
  context.after(async () => {
    for (const close of closers.reverse()) await close();
    await rm(parent, { force: true, maxRetries: 3, recursive: true });
  });
  const packagePath = join(parent, "first.smallpen");
  await cp(fixture, packagePath, { recursive: true });
  return { closeLater: (close) => closers.push(close), packagePath, parent };
}

async function frontendRoot(parent) {
  const root = join(parent, "penpot-frontend");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "index.html"), "<!doctype html><p>Penpot");
  return root;
}

function postJson(url, body, headers = {}) {
  return fetch(url, {
    body,
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });
}

// Sends headers and one byte of a declared 1000-byte body, then stalls.
function stalledRequest(base, path) {
  const url = new URL(base);
  const request = httpRequest({
    headers: { "content-length": 1000, "content-type": "application/json" },
    host: url.hostname,
    method: "POST",
    path: `${url.pathname.replace(/\/$/, "")}${path}`,
    port: url.port,
  });
  request.on("error", () => {});
  request.write("{");
  return request;
}

function openEvents(base) {
  const url = new URL(`${base}/v1/events`);
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, (response) => {
      response.on("error", () => {});
      response.once("data", () => resolve(request));
    });
    request.on("error", reject);
    request.end();
  });
}

async function closesWithin(server, milliseconds) {
  const started = Date.now();
  let timer;
  const outcome = await Promise.race([
    server.close().then(() => "closed"),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve("timeout"), milliseconds);
    }),
  ]);
  clearTimeout(timer);
  return { elapsed: Date.now() - started, outcome };
}

test("Background close() is not held open by a stalled request or SSE client", async (context) => {
  const { packagePath } = await copyFixture(context);
  const background = await serveLocalPackage({ packagePath, port: 0 });
  const events = await openEvents(background.url);
  const stalled = stalledRequest(background.url, "/v1/operations");
  context.after(() => {
    events.destroy();
    stalled.destroy();
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const { outcome } = await closesWithin(background, 4000);
  assert.equal(outcome, "closed");
});

test("Web close() is not held open by a stalled control request", async (context) => {
  const { closeLater, packagePath, parent } = await copyFixture(context);
  const background = await serveLocalPackage({ packagePath, port: 0 });
  closeLater(() => background.close());
  const web = await servePenpotFrontend({
    backendUrl: background.url,
    frontendRoot: await frontendRoot(parent),
    port: 0,
  });
  const stalled = stalledRequest(web.origin, "/desktop/open-package");
  context.after(() => stalled.destroy());
  await new Promise((resolve) => setTimeout(resolve, 50));

  const { outcome } = await closesWithin(web, 4000);
  assert.equal(outcome, "closed");
});

test("Background refuses JSON bodies that are not objects explicitly", async (context) => {
  const { closeLater, packagePath } = await copyFixture(context);
  const background = await serveLocalPackage({ packagePath, port: 0 });
  closeLater(() => background.close());
  for (const route of [
    "/v1/preferences",
    "/v1/packages/open",
    "/v1/operations",
    "/v1/penpot/commit",
    "/v1/tokens/import",
    "/v1/font/variant",
  ]) {
    for (const body of ["null", "[]", "7", '"text"']) {
      const response = await postJson(`${background.url}${route}`, body);
      const { error } = await response.json();
      assert.equal(error.code, "invalid_json", `${route} ${body}`);
    }
  }
});

test("Web refuses non-object bodies and keeps Background refusal codes", async (context) => {
  const { closeLater, packagePath, parent } = await copyFixture(context);
  const background = await serveLocalPackage({ packagePath, port: 0 });
  closeLater(() => background.close());
  const web = await servePenpotFrontend({
    backendUrl: background.url,
    frontendRoot: await frontendRoot(parent),
    port: 0,
  });
  closeLater(() => web.close());

  for (const path of ["/desktop/open-package", "/desktop/close-package"]) {
    const response = await postJson(`${web.origin}${path}`, "null");
    assert.equal(response.status, 400, path);
    assert.equal((await response.json()).error.code, "invalid_json");
  }

  // A refusal from the Background is the caller's problem, not a gateway
  // failure: keep its status and code.
  const unknown = await postJson(
    `${web.origin}/desktop/close-package`,
    JSON.stringify({ fileId: "00000000-0000-4000-8000-000000000000" }),
  );
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, "file_not_found");
  const missing = await postJson(
    `${web.origin}/desktop/open-package`,
    JSON.stringify({ locator: join(parent, "missing.smallpen") }),
  );
  assert.equal(missing.status, 422);
  assert.equal((await missing.json()).error.code, "invalid_package_path");
});

test("Background selects the open session for aliased and concurrent opens", async (context) => {
  const { closeLater, packagePath, parent } = await copyFixture(context);
  const second = join(parent, "second.smallpen");
  await cp(fixture, second, { recursive: true });
  const alias = join(parent, "alias.smallpen");
  await symlink(packagePath, alias);
  const background = await serveLocalPackage({ packagePath, port: 0 });
  closeLater(() => background.close());
  const open = async (locator) => {
    const response = await postJson(
      `${background.url}/v1/packages/open`,
      JSON.stringify({ locator }),
    );
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    return body;
  };
  const { packages } = await fetch(`${background.url}/v1/packages`).then(
    (response) => response.json(),
  );
  const firstSessionId = packages[0].sessionId;

  const aliased = await open(alias);
  assert.equal(aliased.activeSessionId, firstSessionId);
  assert.equal(aliased.packages.length, 1);

  const concurrent = await Promise.all([1, 2, 3, 4].map(() => open(second)));
  const sessionIds = new Set(concurrent.map((body) => body.activeSessionId));
  assert.equal(sessionIds.size, 1);
  assert.equal(concurrent.at(-1).packages.length, 2);
});

test("Background Font Variant uploads refuse prototype-named formats explicitly", async (context) => {
  const { closeLater, packagePath } = await copyFixture(context);
  const background = await serveLocalPackage({ packagePath, port: 0 });
  closeLater(() => background.close());
  for (const format of ["constructor", "toString", "__proto__"]) {
    const session = await postJson(
      `${background.url}/v1/upload/session`,
      JSON.stringify({ totalChunks: 1 }),
    ).then((response) => response.json());
    const chunk = await fetch(
      `${background.url}/v1/upload/session/${session["session-id"]}/chunk/0`,
      { body: new Uint8Array([0, 1, 0, 0]), method: "POST" },
    );
    assert.equal(chunk.status, 200);
    const response = await postJson(
      `${background.url}/v1/font/variant`,
      `{"fontFamily":"Probe","fontId":"18181818-bbbb-4bbb-8bbb-bbbbbbbbbbbb","fontStyle":"normal","fontWeight":400,"uploads":{"${format}":"${session["session-id"]}"}}`,
    );
    assert.equal(response.status, 422, format);
    assert.equal((await response.json()).error.code, "invalid_font_blob", format);
  }
});

test("Background reports an unreachable remote Library explicitly", async (context) => {
  const { closeLater, packagePath } = await copyFixture(context);
  const background = await serveLocalPackage({ packagePath, port: 0 });
  closeLater(() => background.close());
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  const link = () =>
    postJson(
      `${background.url}/v1/libraries/link`,
      JSON.stringify({
        source: { type: "url", url: `http://127.0.0.1:${port}/library.smallpen` },
      }),
    );

  // Loopback is not a public Library host unless local development opts in.
  const refused = await link();
  assert.equal(refused.status, 422);
  assert.equal((await refused.json()).error.code, "remote_library_private_address");

  process.env.SMALLPEN_ALLOW_PRIVATE_LIBRARY_HOSTS = "1";
  context.after(() => delete process.env.SMALLPEN_ALLOW_PRIVATE_LIBRARY_HOSTS);
  const response = await link();
  assert.equal(response.status, 422);
  const { error } = await response.json();
  assert.equal(error.code, "remote_library_unavailable");
  assert.equal(error.details.cause, "ECONNREFUSED");
});
