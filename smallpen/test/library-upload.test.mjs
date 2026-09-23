import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { listPackageEntries } from "@smallpen/core";
import { openPackage } from "@smallpen/local-package";
import { serveLocalPackage } from "@smallpen/background";
import { importLibraryUpload } from "../apps/background/src/library-upload.mjs";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures/roundtrip.smallpen");

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-upload-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const locator = join(root, "project.smallpen");
  await cp(fixture, locator, { recursive: true });
  const manifest = JSON.parse(await readFile(join(fixture, "manifest.json"), "utf8"));
  manifest.packageId = "pkg_imported";
  const form = new FormData();
  form.append("My Library/manifest.json", new Blob([JSON.stringify(manifest)]), "manifest.json");
  for (const entry of listPackageEntries(manifest).entries) {
    form.append(`My Library/${entry}`, new Blob([await readFile(join(fixture, entry))]), "file");
  }
  return { root, locator, form };
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
  const { locator, form } = await setup(t);
  const service = await serveLocalPackage({ packagePath: locator, port: 0 });
  t.after(() => service.close());
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
