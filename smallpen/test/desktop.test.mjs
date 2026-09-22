import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { startDesktopHost } from "../apps/desktop/src/host.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "roundtrip.smallpen");

async function frontendFixture(parent) {
  const frontendRoot = join(parent, "penpot-frontend");
  await mkdir(join(frontendRoot, "js"), { recursive: true });
  await writeFile(
    join(frontendRoot, "index.html"),
    '<!doctype html><title>Penpot</title><div id="app"></div>',
  );
  return frontendRoot;
}

test("Desktop host starts at Home without requiring a Package", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-desktop-home-"));
  const frontendRoot = await frontendFixture(parent);
  context.after(() => rm(parent, { force: true, recursive: true }));
  const desktop = await startDesktopHost({
    applicationStatePath: join(parent, "application-state.json"),
    frontendRoot,
  });
  context.after(() => desktop.close());

  const url = new URL(desktop.url);
  assert.equal(url.hash, "#/smallpen");
  assert.equal(url.pathname, "/");
  assert.equal(desktop.packageName, undefined);
  assert.equal(desktop.packagePath, undefined);
  assert.equal((await fetch(`${url.origin}/health`)).status, 200);
  const sessions = await fetch(`${desktop.backgroundUrl}/v1/packages`).then(
    (response) => response.json(),
  );
  assert.equal(sessions.activeSessionId, null);
  assert.deepEqual(sessions.packages, []);
});

test("Desktop host starts the local Penpot workspace and opens independent files", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-desktop-host-"));
  const first = join(parent, "first.smallpen");
  const second = join(parent, "second.smallpen");
  await cp(fixture, first, { recursive: true });
  await cp(fixture, second, { recursive: true });
  const secondManifestPath = join(second, "manifest.json");
  const secondManifest = JSON.parse(await readFile(secondManifestPath, "utf8"));
  secondManifest.packageId = "pkg_second_desktop";
  await writeFile(secondManifestPath, JSON.stringify(secondManifest, null, 2));
  const frontendRoot = await frontendFixture(parent);
  context.after(() => rm(parent, { force: true, recursive: true }));
  const desktop = await startDesktopHost({
    applicationStatePath: join(parent, "application-state.json"),
    frontendRoot,
    packagePath: first,
  });
  context.after(() => desktop.close());

  const url = new URL(desktop.url);
  assert.equal(url.hostname, "127.0.0.1");
  assert.match(url.hash, /^#\/workspace\?/);
  assert.equal(url.pathname, "/");
  assert.equal(url.search, "");
  assert.doesNotMatch(desktop.url, /smallpen-backend|smallpen-package/);
  const initialQuery = new URLSearchParams(url.hash.split("?")[1]);
  assert.equal(initialQuery.get("team-id"), null);
  assert.equal(initialQuery.get("layout"), "layers");
  assert.equal((await fetch(`${url.origin}/health`)).status, 200);
  const response = await fetch(`${url.origin}/desktop/open-package`, {
    body: JSON.stringify({ locator: second }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(response.status, 201);
  const opened = await response.json();
  const openedUrl = new URL(opened.url);
  assert.match(openedUrl.hash, /^#\/workspace\?/);
  assert.equal(openedUrl.pathname, "/");
  assert.equal(openedUrl.search, "");
  const openedQuery = new URLSearchParams(openedUrl.hash.split("?")[1]);
  assert.notEqual(openedQuery.get("file-id"), initialQuery.get("file-id"));
  assert.equal(openedQuery.get("team-id"), null);
});
