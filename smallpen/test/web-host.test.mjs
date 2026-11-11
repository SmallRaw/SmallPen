import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWebHost } from "../apps/web/src/host.mjs";
import { seedLegacyIds } from "./helpers/named.mjs";

async function start(t, packageSelected = false, chooseSystemPath) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "smallpen-web-host-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const packagePath = join(root, "Original.smallpen");
  await cp(
    new URL("./fixtures/roundtrip.smallpen", import.meta.url),
    packagePath,
    { recursive: true },
  );
  await seedLegacyIds(packagePath, "roundtrip");
  await mkdir(join(root, "Folder"));
  await writeFile(join(root, "private.txt"), "not a directory");
  const frontendRoot = join(root, "frontend");
  await mkdir(frontendRoot);
  await writeFile(
    join(frontendRoot, "index.html"),
    "<!doctype html><title>SmallPen</title>",
  );
  const host = await startWebHost({
    applicationStatePath: join(root, "state.json"),
    directoryRoot: root,
    frontendRoot,
    ...(packageSelected ? { packagePath } : {}),
    ...(chooseSystemPath ? { chooseSystemPath } : {}),
  });
  t.after(() => host.close());
  return { host, root, packagePath };
}

function post(host, route, body, origin = host.origin) {
  return fetch(new URL(route, host.origin), {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

test("the independent Web host opens Home and uses server file access", async (t) => {
  const { host } = await start(t);
  assert.equal(new URL(host.url).searchParams.get("screen"), "smallpen-home");
  const html = await fetch(host.url).then((response) => response.text());
  assert.match(html, /"localFiles":true/);
  assert.match(html, /"desktop":false/);
  assert.match(html, /smallpenLocalFilesReady/);
  assert.doesNotMatch(html, /smallpenNativeFilesReady=/);
  assert.equal(
    (await fetch(new URL("/smallpen/local-files.mjs", host.origin))).status,
    200,
  );
  await host.close();
  await host.close();
  await assert.rejects(fetch(new URL("/health", host.origin)));
});

test("server directory browsing returns folders and packages, not file contents", async (t) => {
  const { host, root, packagePath } = await start(t);
  const response = await post(host, "/local/directories", {});
  assert.equal(response.status, 200);
  const listing = await response.json();
  assert.equal(listing.path, root);
  assert.ok(
    listing.entries.some((entry) => entry.name === "Folder" && !entry.package),
  );
  assert.ok(
    listing.entries.some(
      (entry) => entry.path === packagePath && entry.package,
    ),
  );
  assert.ok(!listing.entries.some((entry) => entry.name === "private.txt"));
  assert.ok(!JSON.stringify(listing).includes("not a directory"));
});

test("directory browsing rejects foreign origins and invalid paths", async (t) => {
  const { host } = await start(t);
  assert.equal(
    (await post(host, "/local/directories", {}, "https://example.com")).status,
    403,
  );
  for (const path of [7, "a\u0000b", "x".repeat(4097)]) {
    assert.equal(
      (await post(host, "/local/directories", { path })).status,
      422,
    );
  }
  assert.equal(
    (
      await post(host, "/local/directories", {
        path: "/smallpen-does-not-exist",
      })
    ).status,
    404,
  );
});

test("opening and editing through the Web service saves the original package", async (t) => {
  const { host, packagePath, root } = await start(t);
  const before = await readFile(join(packagePath, "pages", "Round Trip.html"), "utf8");
  const opened = await post(host, "/desktop/open-package", {
    locator: packagePath,
  });
  assert.equal(opened.status, 201);
  const url = new URL((await opened.json()).url);
  assert.equal(url.searchParams.get("screen"), "workspace");
  const state = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
  assert.equal(state.recentPackages[0].locator, packagePath);
  assert.equal(
    await readFile(join(packagePath, "pages", "Round Trip.html"), "utf8"),
    before,
  );
  const overview = await fetch(`${host.backgroundUrl}/v1/ui/overview`).then(
    (response) => response.json(),
  );
  const edited = await fetch(`${host.backgroundUrl}/v1/operations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseRevision: overview.package.revision,
      batchId: "web-original-write",
      operations: [
        {
          type: "update-presentation-node",
          screenId: "scr_roundtrip",
          presentationId: "pres_desktop",
          nodeId: "node_rectangle",
          changes: { opacity: 0.72 },
        },
      ],
    }),
  });
  assert.equal(edited.status, 200, JSON.stringify(await edited.json()));
  const page = await readFile(join(packagePath, "pages", "Round Trip.html"), "utf8");
  assert.match(page, /data-name="Editable Rectangle"[^>]*opacity-\[0\.72\]/);
});

test("a package argument opens the selected original directly", async (t) => {
  const { host, packagePath } = await start(t, true);
  assert.equal(new URL(host.url).searchParams.get("screen"), "workspace");
  assert.equal(host.packagePath, packagePath);
});

test("the system dialog opens and creates packages by their real path", async (t) => {
  const calls = [];
  let next;
  const { host, root, packagePath } = await start(
    t,
    false,
    async (action, { chinese, directory }) => {
      calls.push({ action, chinese, directory });
      return next;
    },
  );
  const choose = (action, locale = "en") =>
    post(host, "/local/choose-package", { action, locale });

  next = packagePath;
  const opened = await choose("open", "zh-CN");
  assert.equal(opened.status, 201);
  const url = new URL((await opened.json()).url);
  assert.equal(url.searchParams.get("screen"), "workspace");
  assert.deepEqual(calls[0], {
    action: "open",
    chinese: true,
    directory: root,
  });

  next = join(root, "Fresh");
  const created = await choose("create");
  assert.equal(created.status, 201);
  assert.ok((await stat(join(root, "Fresh.smallpen"))).isDirectory());

  next = null;
  const cancelled = await choose("open");
  assert.equal(cancelled.status, 200);
  assert.deepEqual(await cancelled.json(), { cancelled: true });

  next = join(root, "Folder");
  const plain = await choose("open", "zh-CN");
  assert.equal(plain.status, 422);
  assert.deepEqual((await plain.json()).error, {
    code: "not_a_package",
    message: "请选择 .smallpen 文件夹。",
  });

  next = undefined;
  const unavailable = await choose("open");
  assert.equal(unavailable.status, 501);
  assert.equal(
    (await unavailable.json()).error.code,
    "system_dialog_unavailable",
  );
});

test("the system dialog refuses bad requests, a second dialog and closed pages", async (t) => {
  let started;
  let finish;
  let aborted;
  const { host } = await start(t, false, (_action, { signal }) => {
    started();
    return new Promise((resolve) => {
      finish = resolve;
      signal.addEventListener("abort", () => {
        aborted();
        resolve(null);
      });
    });
  });
  const route = "/local/choose-package";
  assert.equal((await post(host, route, { action: "delete" })).status, 422);
  assert.equal(
    (await post(host, route, { action: "open" }, "https://example.com")).status,
    403,
  );

  let opening = new Promise((resolve) => (started = resolve));
  const first = post(host, route, { action: "open" });
  await opening;
  const second = await post(host, route, { action: "create" });
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error.code, "system_dialog_open");
  finish(null);
  assert.equal((await first).status, 200);

  // Closing the page closes the dialog it asked for.
  opening = new Promise((resolve) => (started = resolve));
  const closed = new Promise((resolve) => (aborted = resolve));
  const controller = new AbortController();
  const request = fetch(new URL(route, host.origin), {
    method: "POST",
    headers: { "content-type": "application/json", origin: host.origin },
    body: JSON.stringify({ action: "open" }),
    signal: controller.signal,
  }).catch((error) => error.name);
  await opening;
  controller.abort();
  assert.equal(await request, "AbortError");
  await closed;
  opening = new Promise((resolve) => (started = resolve));
  const again = post(host, route, { action: "open" });
  await opening;
  finish(null);
  assert.equal((await again).status, 200);
});
