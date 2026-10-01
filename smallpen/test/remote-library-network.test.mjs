import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { listPackageEntries } from "@smallpen/core";
import { openRemoteLibrary, resolveWorkspace } from "@smallpen/local-package";

import { isPublicAddress } from "../packages/local-package/src/library-network.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "roundtrip.smallpen");

async function rejectsWith(promise, code) {
  let caught;
  await assert.rejects(promise, (error) => {
    caught = error;
    return error?.code === code;
  });
  return caught;
}

async function serve(context, handler) {
  const hits = [];
  const server = createServer((request, response) => {
    hits.push(request.url);
    handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return { hits, port: server.address().port };
}

async function libraryFiles() {
  const manifest = JSON.parse(await readFile(join(fixture, "manifest.json"), "utf8"));
  manifest.name = "Remote Library";
  manifest.packageId = "pkg_remote_library";
  const files = new Map([["/library/manifest.json", JSON.stringify(manifest)]]);
  for (const entry of listPackageEntries(manifest).entries) {
    files.set(`/library/${entry}`, await readFile(join(fixture, entry), "utf8"));
  }
  return files;
}

test("non-public Library addresses are classified by range", () => {
  for (const address of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fe80::1", "fe80::1%lo0", "fd00::1", "fc00::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:a00:1", "64:ff9b::7f00:1", "64:ff9b::10.0.0.1",
    "2002:7f00:1::1", "2002:c0a8:101::",
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of [
    "8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.1", "198.18.0.5",
    "2606:4700:10::ac42:93f3", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::",
  ]) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test("a Package-declared Library cannot reach loopback, link-local or private hosts", async (context) => {
  const { hits, port } = await serve(context, (_request, response) => {
    response.writeHead(403);
    response.end("internal");
  });
  for (const url of [
    `http://127.0.0.1:${port}/admin/`,
    `http://localhost:${port}/admin/`,
    `http://[::ffff:127.0.0.1]:${port}/admin/`,
    `http://0x7f000001:${port}/admin/`,
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/library/",
    "http://[fe80::1]/library/",
    "http://[fd12::1]/library/",
  ]) {
    const error = await rejectsWith(
      openRemoteLibrary(url, { refresh: true, requestTimeoutMs: 2000 }),
      "remote_library_private_address",
    );
    assert.equal(error.details.env, "SMALLPEN_ALLOW_PRIVATE_LIBRARY_HOSTS", url);
  }
  // Refused before any request is sent.
  assert.deepEqual(hits, []);
});

test("local development opts into private Library hosts", async (context) => {
  const files = await libraryFiles();
  const { hits, port } = await serve(context, (request, response) => {
    const body = files.get(request.url);
    response.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" });
    response.end(body ?? "missing");
  });
  const snapshot = await openRemoteLibrary(`http://localhost:${port}/library/`, {
    allowPrivateNetwork: true,
    refresh: true,
  });
  assert.equal(snapshot.manifest.packageId, "pkg_remote_library");
  assert.equal(hits.length, files.size);

  process.env.SMALLPEN_ALLOW_PRIVATE_LIBRARY_HOSTS = "1";
  context.after(() => delete process.env.SMALLPEN_ALLOW_PRIVATE_LIBRARY_HOSTS);
  const viaEnv = await openRemoteLibrary(`http://127.0.0.1:${port}/library/`, { refresh: true });
  assert.equal(viaEnv.revision, snapshot.revision);
});

test("network failures carry the system error code", async () => {
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  const refused = await rejectsWith(
    openRemoteLibrary(`http://127.0.0.1:${port}/library/`, {
      allowPrivateNetwork: true,
      refresh: true,
    }),
    "remote_library_unavailable",
  );
  assert.equal(refused.details.cause, "ECONNREFUSED");

  // fetch() wraps the code in `cause`; a caller-supplied fetch keeps it too.
  const wrapped = await rejectsWith(
    openRemoteLibrary("https://design.example/library/", {
      fetchImpl: async () => {
        const cause = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
        throw new TypeError("fetch failed", { cause });
      },
      refresh: true,
    }),
    "remote_library_unavailable",
  );
  assert.equal(wrapped.details.cause, "ENOTFOUND");
  const tls = await rejectsWith(
    openRemoteLibrary("https://design.example/library/", {
      fetchImpl: async () => {
        const failure = Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" });
        throw new TypeError("fetch failed", { cause: new AggregateError([failure]) });
      },
      refresh: true,
    }),
    "remote_library_unavailable",
  );
  assert.equal(tls.details.cause, "CERT_HAS_EXPIRED");
});

test("a remote manifest listing too many files is refused before downloading them", async () => {
  const manifest = JSON.parse(await readFile(join(fixture, "manifest.json"), "utf8"));
  manifest.entries.screens = Array.from({ length: 10001 }, (_, index) => `screens/s${index}.json`);
  const requests = [];
  const error = await rejectsWith(
    openRemoteLibrary("https://design.example/library/", {
      fetchImpl: async (url) => {
        requests.push(url);
        return new Response(JSON.stringify(manifest), { status: 200 });
      },
      refresh: true,
    }),
    "remote_library_too_large",
  );
  assert.ok(error.details.count > 10000, JSON.stringify(error.details));
  assert.equal(requests.length, 1);

  // The manifest itself has a much smaller byte budget than entry files.
  const padded = `${JSON.stringify(manifest)}${" ".repeat(5 * 1024 * 1024)}`;
  const oversized = await rejectsWith(
    openRemoteLibrary("https://design.example/library/", {
      fetchImpl: async () => new Response(padded, { status: 200 }),
      refresh: true,
    }),
    "remote_library_too_large",
  );
  assert.equal(oversized.details.limit, 4 * 1024 * 1024);
});

test("Workspace conflicts name only the typed code of a failed URL Library", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-remote-conflict-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const product = join(root, "product.smallpen");
  await cp(fixture, product, { recursive: true });
  const manifestPath = join(product, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.libraries = [
    {
      packageId: "pkg_remote_library",
      source: { type: "url", url: "https://design.example/library/" },
    },
  ];
  await writeFile(manifestPath, JSON.stringify(manifest));

  const resolved = await resolveWorkspace(product, {
    fetchImpl: async () => new Response("Internal admin console", { status: 418, statusText: "Teapot" }),
    libraryCacheRoot: join(root, "cache"),
    refreshRemoteLibraries: true,
  });
  const conflict = resolved.conflicts.find(({ code }) => code === "library_unavailable");
  assert.ok(conflict, JSON.stringify(resolved.conflicts));
  assert.match(conflict.message, /remote_library_unavailable$/);
  assert.doesNotMatch(conflict.message, /418|HTTP|Teapot|admin/);
});
