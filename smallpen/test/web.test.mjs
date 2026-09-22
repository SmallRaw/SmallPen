import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { serveLocalPackage } from "@smallpen/background";
import { servePenpotFrontend } from "@smallpen/web";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "roundtrip.smallpen");

async function copyFixture(parent, name, packageId) {
  const packagePath = join(parent, `${name}.smallpen`);
  await cp(fixture, packagePath, { recursive: true });
  if (packageId) {
    const manifestPath = join(packagePath, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.packageId = packageId;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  }
  return packagePath;
}

async function createPenpotFrontend(parent) {
  const frontendRoot = join(parent, "penpot-frontend");
  await mkdir(join(frontendRoot, "js"), { recursive: true });
  await writeFile(
    join(frontendRoot, "index.html"),
    '<!doctype html><title>Penpot | Full-stack design</title><div id="app"></div><script type="module" src="./js/main.js"></script>',
  );
  await writeFile(
    join(frontendRoot, "js", "main.js"),
    "export const penpot = true;\n",
  );
  await writeFile(
    join(frontendRoot, "js", "main-workspace.js"),
    'shadow.cljs.devtools.client.env.module_loaded("main-workspace");\n',
  );
  return frontendRoot;
}

test("Web serves Penpot frontend assets and opens the SmallPen local Home route", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-penpot-web-"));
  const packagePath = await copyFixture(parent, "first");
  const frontendRoot = await createPenpotFrontend(parent);
  const background = await serveLocalPackage({ packagePath, port: 0 });
  const web = await servePenpotFrontend({
    backendUrl: background.url,
    frontendRoot,
    port: 0,
  });
  context.after(async () => {
    await web.close();
    await background.close();
    await rm(parent, { force: true, recursive: true });
  });

  const workspaceUrl = new URL(web.url);
  assert.equal(workspaceUrl.origin, web.origin);
  assert.equal(workspaceUrl.pathname, "/");
  assert.equal(workspaceUrl.search, "");
  assert.equal(workspaceUrl.hash, "");

  const editorUrl = new URL(web.workspaceUrl);
  const editorQuery = new URLSearchParams(editorUrl.hash.split("?")[1]);
  assert.match(editorQuery.get("file-id"), /^[a-f0-9-]{36}$/);
  assert.match(editorQuery.get("page-id"), /^[a-f0-9-]{36}$/);
  assert.equal(editorQuery.get("layout"), "layers");
  assert.equal(editorQuery.get("team-id"), null);
  assert.equal(editorQuery.get("wasm"), null);

  const page = await fetch(web.url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /^<!doctype html>/i);
  assert.ok(
    html.indexOf("globalThis.smallpenRuntime") >
      html.indexOf("<!doctype html>"),
  );
  assert.match(html, /Penpot \| Full-stack design/);
  assert.doesNotMatch(html, /SmallPen Package Workspace/);
  assert.match(html, /globalThis\.smallpenRuntime/);
  assert.match(
    html,
    new RegExp(background.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.doesNotMatch(html, /packageSessionId/);

  await writeFile(
    join(frontendRoot, "index.html"),
    '<!doctype html><title>Updated Penpot</title><div id="app"></div>',
  );
  const updatedHtml = await fetch(web.url).then((response) => response.text());
  assert.match(updatedHtml, /Updated Penpot/);

  const main = await fetch(`${web.origin}/js/main.js`);
  assert.equal(main.status, 200);
  assert.match(await main.text(), /penpot = true/);

  const workspace = await fetch(`${web.origin}/js/main-workspace.js`);
  assert.equal(workspace.status, 200);
  const workspaceSource = await workspace.text();
  assert.doesNotMatch(
    workspaceSource,
    /(?<!\?\.)shadow\.cljs\.devtools\.client\.env\.module_loaded\(/,
  );
  assert.match(
    workspaceSource,
    /globalThis\.shadow\?\.cljs\?\.devtools\?\.client\?\.env\?\.module_loaded\?\.\(/,
  );

  const config = await fetch(`${web.origin}/js/config.js`);
  assert.equal(config.status, 200);
  assert.match(await config.text(), /penpotPublicURI/);
  assert.equal((await fetch(`${web.origin}/app.js`)).status, 404);
});

test("Web proxies Penpot Google Font CSS and files through fixed upstreams", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-penpot-fonts-"));
  const packagePath = await copyFixture(parent, "first");
  const frontendRoot = await createPenpotFrontend(parent);
  const background = await serveLocalPackage({ packagePath, port: 0 });
  const requests = [];
  const remoteFetch = async (target) => {
    requests.push(target.href);
    if (target.hostname === "fonts.googleapis.com") {
      return new Response(
        "@font-face{font-family:Inter;src:url(https://fonts.gstatic.com/s/inter/demo.woff2)}",
        { headers: { "content-type": "text/css; charset=utf-8" } },
      );
    }
    return new Response(new Uint8Array([0x77, 0x4f, 0x46, 0x32]), {
      headers: { "content-type": "font/woff2" },
    });
  };
  const web = await servePenpotFrontend({
    backendUrl: background.url,
    frontendRoot,
    port: 0,
    remoteFetch,
  });
  context.after(async () => {
    await web.close();
    await background.close();
    await rm(parent, { force: true, recursive: true });
  });

  const css = await fetch(
    `${web.origin}/internal/gfonts/css?family=Inter:regular&display=block`,
  );
  assert.equal(css.status, 200);
  assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");
  assert.match(await css.text(), /font-family:Inter/);

  const font = await fetch(
    `${web.origin}/internal/gfonts/font/inter/demo.woff2`,
  );
  assert.equal(font.status, 200);
  assert.equal(font.headers.get("content-type"), "font/woff2");
  assert.deepEqual(
    new Uint8Array(await font.arrayBuffer()),
    new Uint8Array([0x77, 0x4f, 0x46, 0x32]),
  );
  assert.deepEqual(requests, [
    "https://fonts.googleapis.com/css?family=Inter:regular&display=block",
    "https://fonts.gstatic.com/s/inter/demo.woff2",
  ]);
});

test("opening another package returns another Penpot workspace URL", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-penpot-tabs-"));
  const first = await copyFixture(parent, "first");
  const second = await copyFixture(parent, "second", "pkg_second_web");
  const frontendRoot = await createPenpotFrontend(parent);
  const background = await serveLocalPackage({ packagePath: first, port: 0 });
  const web = await servePenpotFrontend({
    backendUrl: background.url,
    frontendRoot,
    port: 0,
  });
  context.after(async () => {
    await web.close();
    await background.close();
    await rm(parent, { force: true, recursive: true });
  });

  const response = await fetch(`${web.origin}/desktop/open-package`, {
    body: JSON.stringify({ locator: second }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(response.status, 201);
  const opened = await response.json();
  const openedUrl = new URL(opened.url);
  assert.equal(openedUrl.origin, web.origin);
  assert.equal(openedUrl.pathname, "/");
  assert.equal(openedUrl.search, "");
  assert.doesNotMatch(opened.url, /smallpen-backend|smallpen-package/);
  assert.match(openedUrl.hash, /^#\/workspace\?/);
  const initialQuery = new URLSearchParams(
    new URL(web.workspaceUrl).hash.split("?")[1],
  );
  const openedQuery = new URLSearchParams(openedUrl.hash.split("?")[1]);
  assert.notEqual(openedQuery.get("file-id"), initialQuery.get("file-id"));
  assert.equal(openedQuery.get("team-id"), null);
  assert.equal(openedQuery.get("layout"), "layers");

  const openedPage = await fetch(opened.url);
  assert.equal(openedPage.status, 200);
  const openedHtml = await openedPage.text();
  assert.match(openedHtml, /globalThis\.smallpenRuntime/);
  assert.doesNotMatch(openedHtml, /packageSessionId/);

  const routedMain = await fetch(new URL("js/main.js", opened.url));
  assert.equal(routedMain.status, 200);
  assert.match(await routedMain.text(), /penpot = true/);
  const routedConfig = await fetch(new URL("js/config.js", opened.url));
  assert.equal(routedConfig.status, 200);
  assert.match(await routedConfig.text(), /penpotPublicURI/);

  const closed = await fetch(`${web.origin}/desktop/close-package`, {
    body: JSON.stringify({
      fileId: openedQuery.get("file-id"),
      url: `${web.origin}/#/viewer?file-id=unrelated-navigation`,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(closed.status, 200);
  assert.equal((await fetch(opened.url)).status, 200);

  const restored = await fetch(`${background.url}/v1/workspace`, {
    headers: { "x-smallpen-file": openedQuery.get("file-id") },
  });
  assert.equal(restored.status, 200);
  assert.equal(
    (await restored.json()).runtime.file,
    openedQuery.get("file-id"),
  );

  const invalidClose = await fetch(`${web.origin}/desktop/close-package`, {
    body: JSON.stringify({ url: "not-a-url" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(invalidClose.status, 422);
});

test("Web refuses static symlinks that escape the frontend root", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-web-symlink-"));
  const packagePath = await copyFixture(parent, "first");
  const frontendRoot = await createPenpotFrontend(parent);
  const secretPath = join(parent, "secret.txt");
  await writeFile(secretPath, "not public");
  await symlink(secretPath, join(frontendRoot, "leak.txt"));
  const background = await serveLocalPackage({ packagePath, port: 0 });
  const web = await servePenpotFrontend({
    backendUrl: background.url,
    frontendRoot,
    port: 0,
  });
  context.after(async () => {
    await web.close();
    await background.close();
    await rm(parent, { force: true, recursive: true });
  });

  assert.equal((await fetch(`${web.origin}/leak.txt`)).status, 404);
});
