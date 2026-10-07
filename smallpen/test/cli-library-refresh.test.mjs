import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { listPackageEntries } from "@smallpen/core";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "apps", "cli", "bin", "smallpen.mjs");
const fixture = join(here, "fixtures", "roundtrip.smallpen");

async function runCli(args, home) {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [cli, ...args], {
      // The Library server listens on loopback.
      env: {
        ...process.env,
        HOME: home,
        SMALLPEN_ALLOW_PRIVATE_LIBRARY_HOSTS: "1",
        USERPROFILE: home,
      },
    });
    return { code: 0, json: JSON.parse(stdout) };
  } catch (error) {
    return { code: error.code, json: JSON.parse(error.stdout) };
  }
}

async function serveLibrary() {
  const manifest = JSON.parse(
    await readFile(join(fixture, "manifest.json"), "utf8"),
  );
  manifest.name = "Remote Library";
  manifest.packageId = "pkg_remote_library";
  const files = new Map([["manifest.json", JSON.stringify(manifest)]]);
  for (const entry of listPackageEntries(manifest).entries) {
    files.set(entry, await readFile(join(fixture, entry), "utf8"));
  }
  const server = createServer((request, response) => {
    const body = files.get(request.url.replace(/^\/library\//, ""));
    response.writeHead(body === undefined ? 404 : 200, {
      "content-type": "application/json",
    });
    response.end(body ?? "missing");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

test("library-refresh reports why a failed refresh fell back to the cache", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-library-refresh-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const server = await serveLibrary();
  const url = `http://127.0.0.1:${server.address().port}/library/`;
  const product = join(root, "product.smallpen");
  await cp(fixture, product, { recursive: true });
  const manifestPath = join(product, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.libraries = [
    { packageId: "pkg_remote_library", source: { type: "url", url } },
  ];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const online = await runCli(["advanced", "library-refresh", product, "--json"], root);
  assert.equal(online.code, 0, JSON.stringify(online.json));
  assert.equal(online.json.after.cache, "refreshed");
  assert.equal(online.json.after.warning, undefined);

  await new Promise((resolve) => server.close(resolve));
  const offline = await runCli(["advanced", "library-refresh", product, "--json"], root);
  assert.equal(offline.code, 0, JSON.stringify(offline.json));
  assert.equal(offline.json.after.cache, "stale");
  assert.equal(offline.json.after.revision, online.json.after.revision);
  assert.match(offline.json.after.warning, /could not be fetched/);
});
