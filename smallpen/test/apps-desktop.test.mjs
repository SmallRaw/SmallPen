import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  packagePathArguments,
  workspaceFileId,
} from "../apps/desktop/src/electron-policy.mjs";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const fixture = join(fixtures, "roundtrip.smallpen");
const entry = new URL("../apps/desktop/src/electron-main.mjs", import.meta.url)
  .href;

test("package arguments resolve against the reporting instance directory", () => {
  assert.deepEqual(
    packagePathArguments(
      ["/Applications/SmallPen", "--flag", "a.smallpen", "notes.txt"],
      "/work/project",
    ),
    [resolve("/work/project", "a.smallpen")],
  );
  assert.deepEqual(packagePathArguments(["/abs/B.SMALLPEN"], "/elsewhere"), [
    resolve("/abs/B.SMALLPEN"),
  ]);
  assert.deepEqual(packagePathArguments(["a.smallpen"]), [
    resolve("a.smallpen"),
  ]);
});

test("workspace file identity is read only from workspace routes", () => {
  assert.equal(
    workspaceFileId("http://127.0.0.1:1/?screen=workspace&file-id=abc&page-id=p"),
    "abc",
  );
  assert.equal(
    workspaceFileId("http://127.0.0.1:1/?screen=viewer&file-id=abc"),
    undefined,
  );
  assert.equal(
    workspaceFileId("http://127.0.0.1:1/#/workspace?file-id=abc&page-id=p"),
    "abc",
  );
  assert.equal(workspaceFileId("http://127.0.0.1:1/#/viewer?file-id=abc"), undefined);
  assert.equal(workspaceFileId("http://127.0.0.1:1/#/workspace?page-id=p"), undefined);
  assert.equal(workspaceFileId("not a url"), undefined);
});

// Runs the real Electron entry against a stub `electron` module. The scenario
// body receives `app`, `windows` (every BrowserWindow created), `requests`
// (every fetch body) and `settle()`.
function runEntry(scenario, argv = []) {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from "node:assert/strict";
    import { registerHooks } from "node:module";
    const stub = 'data:text/javascript,' + encodeURIComponent(\`
      import { EventEmitter } from "node:events";
      export const app = new EventEmitter();
      app.requestSingleInstanceLock = () => true;
      app.whenReady = () => Promise.resolve();
      app.quit = () => { globalThis.quit = true; };
      app.exit = code => { globalThis.exitCode = code; };
      globalThis.windows = [];
      export class BrowserWindow extends EventEmitter {
        constructor() {
          super();
          globalThis.windows.push(this);
          this.focused = 0;
          this.webContents = new EventEmitter();
          this.webContents.setWindowOpenHandler = () => {};
        }
        loadURL(url) { this.url = url; return Promise.resolve(); }
        show() {}
        focus() { this.focused += 1; }
      }
      export const dialog = { showErrorBox: (_, message) => {
        (globalThis.failures ??= []).push(message);
      }};
      export const Menu = { buildFromTemplate: value => value,
        setApplicationMenu() {} };
      export const session = { defaultSession: new EventEmitter() };
      session.defaultSession.setPermissionCheckHandler = () => {};
      session.defaultSession.setPermissionRequestHandler = () => {};
      export const utilityProcess = { fork() {
        const service = new EventEmitter();
        service.postMessage = () => service.emit("exit", 0);
        setImmediate(() => service.emit("message", {
          url: "http://127.0.0.1:12345/"
        }));
        return service;
      }};
    \`);
    registerHooks({ resolve(specifier, context, next) {
      return specifier === "electron"
        ? { url: stub, shortCircuit: true } : next(specifier, context);
    }});
    const requests = [];
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ path: new URL(url).pathname, body });
      return { ok: true, json: async () => ({
        url: "http://127.0.0.1:12345/#/workspace?file-id=" +
          (globalThis.nextFileId ?? "opened"),
      }) };
    };
    const settle = async () => {
      for (let i = 0; i < 50; i++)
        await new Promise(resolve => setImmediate(resolve));
    };
    const fixture = process.env.SMALLPEN_TEST_FIXTURE;
    const fixtures = process.env.SMALLPEN_TEST_FIXTURES;
    await import(process.argv[1]);
    const { app } = await import("electron");
    await settle();
    const windows = globalThis.windows;
    ${scenario}
  `,
      entry,
      ...argv,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        SMALLPEN_TEST_FIXTURE: realpathSync(fixture),
        SMALLPEN_TEST_FIXTURES: fixtures,
      },
      timeout: 10000,
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test("an unreadable startup package reports its error and the App stays open", () => {
  runEntry(
    `
    assert.equal(globalThis.quit, undefined, "the App must not quit");
    assert.equal(globalThis.failures.length, 1);
    assert.match(globalThis.failures[0], /missing\\.smallpen/);
    assert.equal(windows.length, 1, "Home opens instead");
    assert.equal(windows[0].url, "http://127.0.0.1:12345/");
    assert.equal(requests.length, 0);
  `,
    [join(fixtures, "missing.smallpen")],
  );
});

test("a later startup package still opens after an earlier one fails", () => {
  runEntry(
    `
    assert.equal(globalThis.quit, undefined, "the App must not quit");
    assert.equal(globalThis.failures.length, 1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.locator, fixture);
    assert.equal(windows.length, 1);
    assert.match(windows[0].url, /#\\/workspace\\?file-id=opened$/);
  `,
    [join(fixtures, "missing.smallpen"), realpathSync(fixture)],
  );
});

test("a second instance resolves relative package paths in its own directory", () => {
  runEntry(`
    app.emit("second-instance", {}, ["SmallPen", "roundtrip.smallpen"],
      fixtures);
    await settle();
    assert.equal(globalThis.failures, undefined);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, "/desktop/open-package");
    assert.equal(requests[0].body.locator, fixture);
  `);
});

test("opening a package already shown from Recent focuses that window", () => {
  runEntry(`
    assert.equal(windows.length, 1);
    const home = windows[0];
    home.webContents.emit("did-navigate-in-page", {},
      "http://127.0.0.1:12345/#/workspace?file-id=recent-file", true);
    globalThis.nextFileId = "recent-file";
    app.emit("open-file", { preventDefault() {} }, fixture);
    await settle();
    assert.equal(globalThis.failures, undefined);
    assert.equal(windows.length, 1, "no second window for the same package");
    assert.equal(home.focused, 1);
    app.emit("open-file", { preventDefault() {} }, fixture);
    await settle();
    assert.equal(windows.length, 1);
    assert.equal(home.focused, 2);
    assert.equal(requests.length, 1,
      "the stored locator short-circuits the second open");
  `);
});
