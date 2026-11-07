import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import test from "node:test";
import { listPackageEntries } from "@smallpen/core";
import { openPackage } from "@smallpen/local-package";
import { serveLocalPackage } from "@smallpen/background";
import { importLibraryUpload } from "../apps/background/src/library-upload.mjs";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures/roundtrip.smallpen");

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-upload-test-"));
  // After hooks run in order and stop at the first failure. The directory is
  // removed only after every server is closed: a live Background writes lock
  // claims beside its Package, so an early rm can fail with ENOTEMPTY and skip
  // close(), leaving the test process running forever.
  const closers = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const locator = join(root, "project.smallpen");
  await cp(fixture, locator, { recursive: true });
  const manifest = JSON.parse(await readFile(join(fixture, "manifest.json"), "utf8"));
  manifest.packageId = "pkg_imported";
  const form = new FormData();
  form.append("My Library/manifest.json", new Blob([JSON.stringify(manifest)]), "manifest.json");
  for (const entry of listPackageEntries(manifest).entries) {
    form.append(`My Library/${entry}`, new Blob([await readFile(join(fixture, entry))]), "file");
  }
  return { closeLater: (close) => closers.push(close), root, locator, form };
}

test("browser upload copies a valid library beside the project without overwriting previous imports", async (t) => {
  const { root, locator, form } = await setup(t);
  const original = await readFile(join(locator, "manifest.json"));
  const first = await importLibraryUpload(locator, form);
  const second = await importLibraryUpload(locator, form);
  assert.notEqual(first.path, second.path);
  assert.equal((await openPackage(join(root, first.path))).manifest.packageId, "pkg_imported");
  assert.deepEqual(await readFile(join(locator, "manifest.json")), original);
});

test("unsafe, duplicate and mixed-root uploads cannot write files", async (t) => {
  const { root, locator } = await setup(t);
  for (const path of ["../escape", "/absolute/file", "lib/../escape", "lib/a\\b", "lib/C:/x", "lib/.env", "lib/CON"]) {
    const form = new FormData();
    form.append(path, new Blob(["bad"]));
    await assert.rejects(importLibraryUpload(locator, form), { code: "invalid_library_upload" });
  }
  for (const paths of [["lib/a", "lib/A"], ["lib/a", "other/b"]]) {
    const form = new FormData();
    for (const path of paths) form.append(path, new Blob(["bad"]));
    await assert.rejects(importLibraryUpload(locator, form), { code: "invalid_library_upload" });
  }
  assert.deepEqual(await readdir(root), ["project.smallpen"]);
});

test("invalid package contents leave no partial copy", async (t) => {
  const { root, locator, form } = await setup(t);
  form.delete("My Library/tokens/tokens.json");
  await assert.rejects(importLibraryUpload(locator, form));
  assert.deepEqual(await readdir(root), ["project.smallpen"]);
});

test("external library dependencies cannot resolve against unrelated local files", async (t) => {
  const { root, locator, form } = await setup(t);
  const manifest = JSON.parse(await form.get("My Library/manifest.json").text());
  manifest.dependencies = [{ path: "../../outside.smallpen" }];
  form.set("My Library/manifest.json", new Blob([JSON.stringify(manifest)]));
  await assert.rejects(importLibraryUpload(locator, form), { code: "invalid_library_upload" });
  assert.deepEqual(await readdir(root), ["project.smallpen"]);
});

test("empty and oversized uploads are rejected before any directory is created", async (t) => {
  const { root, locator } = await setup(t);
  await assert.rejects(importLibraryUpload(locator, new FormData()), { code: "invalid_library_upload" });
  const oversized = new FormData();
  oversized.append("lib/manifest.json", new Blob([new Uint8Array(50 * 1024 * 1024 + 1)]));
  await assert.rejects(importLibraryUpload(locator, oversized), { code: "invalid_library_upload" });
  assert.deepEqual(await readdir(root), ["project.smallpen"]);
});

test("browser multipart upload returns a relative path usable by the existing link API", async (t) => {
  const { closeLater, locator, form } = await setup(t);
  const service = await serveLocalPackage({ packagePath: locator, port: 0 });
  closeLater(() => service.close());
  const response = await fetch(`${service.url}/v1/libraries/import-local`, { method: "POST", body: form });
  assert.equal(response.status, 200, await response.clone().text());
  const { path } = await response.json();
  const linked = await fetch(`${service.url}/v1/libraries/link`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: { type: "local", path } }),
  });
  assert.equal(linked.status, 200, await linked.clone().text());
  assert.ok((await linked.json()).libraries.some((library) => library.manifest.packageId === "pkg_imported"));
});

// A handle left open by close() keeps the process alive after its last test.
function liveResources() {
  const counts = {};
  for (const type of process.getActiveResourcesInfo()) {
    if (["FSEventWrap", "TCPServerWrap", "TCPWrap", "Timeout"].includes(type)) {
      counts[type] = (counts[type] ?? 0) + 1;
    }
  }
  return counts;
}

test("closing the Background after a library link leaves no server, watcher or timer", async (t) => {
  const { locator, form } = await setup(t);
  const before = liveResources();
  const service = await serveLocalPackage({ packagePath: locator, port: 0 });
  try {
    const imported = await fetch(`${service.url}/v1/libraries/import-local`, { method: "POST", body: form });
    const { path } = await imported.json();
    const linked = await fetch(`${service.url}/v1/libraries/link`, {
      method: "POST", headers: { "content-type": "application/json", connection: "close" },
      body: JSON.stringify({ source: { type: "local", path } }),
    });
    assert.equal(linked.status, 200, await linked.text());
    assert.notDeepEqual(liveResources(), before);
  } finally {
    await service.close();
  }
  // Closed handles leave the list once libuv runs their close callbacks.
  for (let attempt = 0; attempt < 20 && !isDeepStrictEqual(liveResources(), before); attempt += 1) {
    await delay(50);
  }
  assert.deepEqual(liveResources(), before);
});
