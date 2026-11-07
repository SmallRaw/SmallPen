import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { listPackageEntries } from "@smallpen/core";
import { openPackage } from "@smallpen/local-package";
import { serveLocalPackage } from "@smallpen/background";
import { servePenpotFrontend } from "@smallpen/web";

const fixture = fileURLToPath(
  new URL("./fixtures/roundtrip.smallpen", import.meta.url),
);

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-package-upload-"));
  const frontendRoot = join(root, "frontend");
  await mkdir(frontendRoot);
  await writeFile(
    join(frontendRoot, "index.html"),
    "<!doctype html><div id=app></div>",
  );
  const statePath = join(root, "app-data", "state.json");
  const background = await serveLocalPackage({
    applicationStatePath: statePath,
    port: 0,
  });
  const web = await servePenpotFrontend({
    backendUrl: background.url,
    frontendRoot,
    port: 0,
  });
  t.after(async () => {
    await web.close();
    await background.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const manifest = JSON.parse(
    await readFile(join(fixture, "manifest.json"), "utf8"),
  );
  const form = new FormData();
  form.append(
    "Design.smallpen/manifest.json",
    new Blob([JSON.stringify(manifest)]),
    "manifest.json",
  );
  for (const entry of listPackageEntries(manifest).entries)
    form.append(
      `Design.smallpen/${entry}`,
      new Blob([await readFile(join(fixture, entry))]),
      "file",
    );
  return { root, statePath, background, web, form };
}

test("Web directory upload opens an independent persistent Package and saves edits to its copy", async (t) => {
  const { statePath, background, web, form } = await setup(t);
  const original = await readFile(join(fixture, "screens/roundtrip.json"));
  form.append(
    "Design.smallpen/assets/uploaded.png",
    new Blob([Uint8Array.from([137, 80, 78, 71])]),
    "uploaded.png",
  );
  const response = await fetch(`${web.origin}/packages/import`, {
    method: "POST",
    body: form,
  });
  assert.equal(response.status, 201, await response.clone().text());
  const { url } = await response.json();
  const target = new URL(url);
  assert.equal(target.origin, web.origin);
  assert.equal(target.searchParams.get("screen"), "workspace");
  const fileId = target.searchParams.get("file-id");
  assert.match(fileId, /^[a-f0-9-]{36}$/);
  const application = JSON.parse(await readFile(statePath, "utf8"));
  const locator = application.recentPackages[0].locator;
  assert.ok(
    locator.startsWith(await realpath(join(dirname(statePath), "imports"))),
  );
  assert.equal(
    (await openPackage(locator)).manifest.packageId,
    "pkg_roundtrip",
  );
  assert.deepEqual(
    await readFile(join(locator, "assets/uploaded.png")),
    Buffer.from([137, 80, 78, 71]),
  );
  const headers = {
    "content-type": "application/json",
    "x-smallpen-file": fileId,
  };
  const snapshot = await fetch(`${background.url}/v1/workspace`, {
    headers,
  }).then((r) => r.json());
  const saved = await fetch(`${background.url}/v1/operations`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      batchId: "edit-uploaded-copy",
      baseRevision: snapshot.revision,
      operations: [
        {
          type: "update-node",
          screenId: "scr_roundtrip",
          nodeId: "node_rectangle",
          changes: { name: "Edited uploaded copy" },
        },
      ],
    }),
  });
  assert.equal(saved.status, 200, await saved.clone().text());
  const screen = JSON.parse(
    await readFile(join(locator, "screens/roundtrip.json"), "utf8"),
  );
  assert.equal(
    screen.presentations[0].nodes.node_rectangle.name,
    "Edited uploaded copy",
  );
  assert.deepEqual(
    await readFile(join(fixture, "screens/roundtrip.json")),
    original,
  );
  const next = await fetch(`${web.origin}/packages/import`, {
    method: "POST",
    body: form,
  });
  assert.equal(next.status, 201, await next.clone().text());
  const reopened = await fetch(`${background.url}/v1/application`).then((r) =>
    r.json(),
  );
  assert.equal(reopened.recentPackages.length, 2);
  assert.notEqual(reopened.recentPackages[0].locator, locator);
  assert.equal(
    (await openPackage(locator)).entries["screens/roundtrip.json"]
      .presentations[0].nodes.node_rectangle.name,
    "Edited uploaded copy",
  );
});

test("browser writeback exports only canonical files at the selected Package revision", async (t) => {
  const { background, web, form } = await setup(t);
  form.append("Design.smallpen/notes.txt", new Blob(["unrelated"]));
  const opened = await fetch(`${web.origin}/packages/import`, {
    method: "POST",
    body: form,
  }).then((r) => r.json());
  const fileId = new URL(opened.url).searchParams.get("file-id");
  const endpoint = `${background.url}/v1/package-files?file-id=${fileId}`;
  const index = await fetch(endpoint).then((r) => r.json());
  assert.ok(index.files.some((item) => item.path === "manifest.json"));
  assert.ok(index.files.some((item) => item.path === "screens/roundtrip.json"));
  assert.equal(
    index.files.some((item) => item.path === "notes.txt"),
    false,
  );
  for (const item of index.files) {
    const response = await fetch(
      `${endpoint}&revision=${index.revision}&path=${encodeURIComponent(item.path)}`,
    );
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, item.size);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), item.sha256);
  }
  for (const path of ["../outside", ".env", "notes.txt"])
    assert.equal(
      (await fetch(`${endpoint}&path=${encodeURIComponent(path)}`)).status,
      422,
    );
  assert.equal(
    (await fetch(`${endpoint}&revision=outdated&path=manifest.json`)).status,
    409,
  );
});

test("invalid and unsafe directory uploads leave no partial Package or recent entry", async (t) => {
  const { statePath, background, web, form } = await setup(t);
  const cases = [new FormData()];
  for (const path of [
    "../escape",
    "Design.smallpen/../escape",
    "Design.smallpen/C:/escape",
    "Design.smallpen/.env",
    "Design.smallpen/CON",
    "Other.smallpen/extra.json",
    "Design.smallpen/ASSETS/ASSETS.JSON",
  ]) {
    const candidate = new FormData();
    for (const [name, file] of form) candidate.append(name, file);
    candidate.append(path, new Blob(["bad"]));
    cases.push(candidate);
  }
  const missing = new FormData();
  missing.append(
    "Design.smallpen/manifest.json",
    form.get("Design.smallpen/manifest.json"),
  );
  cases.push(missing);
  for (const body of cases) {
    const response = await fetch(`${web.origin}/packages/import`, {
      method: "POST",
      body,
    });
    assert.equal(response.status, 422, await response.clone().text());
    assert.ok((await response.json()).error.code);
  }
  const application = await fetch(`${background.url}/v1/application`).then(
    (r) => r.json(),
  );
  assert.deepEqual(application.recentPackages, []);
  const dirs = await readdir(join(dirname(statePath), "imports")).catch((e) => {
    if (e.code === "ENOENT") return [];
    throw e;
  });
  assert.deepEqual(dirs, []);
});

test("directory uploads reject foreign origins and malformed or oversized multipart bodies", async (t) => {
  const { web, form } = await setup(t);
  const foreign = await fetch(`${web.origin}/packages/import`, {
    method: "POST",
    body: form,
    headers: { origin: "https://foreign.example" },
  });
  assert.equal(foreign.status, 403);
  const malformed = await fetch(`${web.origin}/packages/import`, {
    method: "POST",
    body: "bad",
    headers: { "content-type": "multipart/form-data; boundary=broken" },
  });
  assert.equal(malformed.status, 422, await malformed.clone().text());
  const text = await fetch(`${web.origin}/packages/import`, {
    method: "POST",
    body: "not a directory",
  });
  assert.equal(text.status, 415);
  const oversized = new FormData();
  oversized.append(
    "Design.smallpen/manifest.json",
    new Blob([new Uint8Array(50 * 1024 * 1024 + 1)]),
  );
  const big = await fetch(`${web.origin}/packages/import`, {
    method: "POST",
    body: oversized,
  });
  assert.equal(big.status, 413, await big.clone().text());
});

test("uploaded Products report missing Foundation dependencies without reading outside the upload", async (t) => {
  const { web, background, form } = await setup(t);
  const manifest = JSON.parse(
    await form.get("Design.smallpen/manifest.json").text(),
  );
  manifest.role = "product";
  manifest.dependencies = [
    { packageId: "pkg_missing_foundation", path: "missing.smallpen" },
  ];
  form.set(
    "Design.smallpen/manifest.json",
    new Blob([JSON.stringify(manifest)]),
    "manifest.json",
  );
  const opened = await fetch(`${web.origin}/packages/import`, {
    method: "POST",
    body: form,
  });
  assert.equal(opened.status, 201, await opened.clone().text());
  const { url } = await opened.json();
  const fileId = new URL(url).searchParams.get("file-id");
  const snapshot = await fetch(`${background.url}/v1/workspace`, {
    headers: { "x-smallpen-file": fileId },
  }).then((r) => r.json());
  assert.equal(snapshot.packageStatus.state, "repair");
  assert.ok(snapshot.packageStatus.conflicts.length);
  manifest.libraries = [
    {
      packageId: "pkg_outside",
      source: { type: "local", path: "../../outside.smallpen" },
    },
  ];
  form.set(
    "Design.smallpen/manifest.json",
    new Blob([JSON.stringify(manifest)]),
    "manifest.json",
  );
  const refused = await fetch(`${web.origin}/packages/import`, {
    method: "POST",
    body: form,
  });
  assert.equal(refused.status, 422);
  assert.equal((await refused.json()).error.code, "invalid_package_upload");
  const packages = await fetch(`${background.url}/v1/packages`).then((r) =>
    r.json(),
  );
  assert.equal(packages.packages.length, 1);
});
