import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { listPackageEntries } from "@smallpen/core";
import {
  defaultLibraryCacheRoot,
  openRemoteLibrary,
} from "@smallpen/local-package";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "roundtrip.smallpen");

test("the independent CLI cache has a stable user-level location", () => {
  assert.equal(
    defaultLibraryCacheRoot(),
    join(homedir(), ".smallpen", "library-cache"),
  );
});

async function remoteValues() {
  const manifest = JSON.parse(
    await readFile(join(fixture, "manifest.json"), "utf8"),
  );
  manifest.name = "Remote Library";
  manifest.packageId = "pkg_remote_library";
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of listPackageEntries(manifest).entries) {
    values.set(entry, JSON.parse(await readFile(join(fixture, entry), "utf8")));
  }
  return values;
}

function libraryFetch(values, requests) {
  return async (url) => {
    requests.push(url);
    const path = new URL(url).pathname.replace("/library/", "");
    const value = values.get(path);
    return value === undefined
      ? new Response("missing", { status: 404 })
      : new Response(JSON.stringify(value), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
  };
}

test("Remote Libraries retain their URL and reopen from a verified cache", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "smallpen-library-cache-"));
  const values = await remoteValues();
  const requests = [];
  const sourceUrl = "https://design.example/library/";
  const downloaded = await openRemoteLibrary(sourceUrl, {
    cacheRoot,
    fetchImpl: libraryFetch(values, requests),
    refresh: true,
  });

  assert.equal(downloaded.manifest.packageId, "pkg_remote_library");
  assert.equal(
    downloaded.remote.sourceUrl,
    "https://design.example/library/manifest.json",
  );
  assert.equal(downloaded.remote.cache, "refreshed");
  assert.ok(requests.length > 1);

  const cached = await openRemoteLibrary(sourceUrl, {
    cacheRoot,
    fetchImpl: async () => {
      throw new Error("network should not be used for a cache hit");
    },
  });
  assert.equal(cached.revision, downloaded.revision);
  assert.equal(cached.remote.cache, "hit");

  const offline = await openRemoteLibrary(sourceUrl, {
    cacheRoot,
    fetchImpl: async () => {
      throw new Error("offline");
    },
    refresh: true,
  });
  assert.equal(offline.revision, downloaded.revision);
  assert.equal(offline.remote.cache, "stale");
  assert.match(offline.remote.warning, /offline/);
});

test("a Remote Library Package ID mismatch remains detectable by its caller", async () => {
  const values = await remoteValues();
  const snapshot = await openRemoteLibrary(
    "https://design.example/library/manifest.json",
    { fetchImpl: libraryFetch(values, []), refresh: true },
  );
  assert.notEqual(snapshot.manifest.packageId, "pkg_expected_library");
});
