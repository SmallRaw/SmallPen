import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDesktopProcess } from "../e2e/run-desktop-process.mjs";

test("desktop readiness uses the viewport test id, not a compiled CSS class", async () => {
  const source = await readFile(
    new URL("../apps/desktop/src/electron-main.mjs", import.meta.url),
    "utf8",
  );
  assert.ok(source.includes('[data-testid="viewport"]'));
  assert.doesNotMatch(source, /#workspace \.viewport/);
});

test("Electron entry finishes loading before app readiness", () => {
  // Electron emits ready only after its ESM entry finishes evaluating.
  // Keep readiness pending and verify the real entry can still be imported.
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { registerHooks } from "node:module";
    const stub = 'data:text/javascript,' + encodeURIComponent(\`
      import { EventEmitter } from "node:events";
      export const app = new EventEmitter();
      app.requestSingleInstanceLock = () => true;
      app.whenReady = () => new Promise(() => {});
      export const BrowserWindow = {}, dialog = {}, Menu = {},
        session = {}, utilityProcess = {};
    \`);
    registerHooks({ resolve(specifier, context, next) {
      return specifier === "electron"
        ? { url: stub, shortCircuit: true } : next(specifier, context);
    }});
    const timer = setTimeout(() => {
      console.error("Entry is blocking Electron readiness");
      process.exit(1);
    }, 1000);
    await import(process.argv[1]);
    clearTimeout(timer);
  `,
      new URL("../apps/desktop/src/electron-main.mjs", import.meta.url).href,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.status, 0, result.stderr);
});

for (const scenario of ["quit", "last-window", "close-failure"]) {
  test(`desktop shutdown drains package closes: ${scenario}`, () => {
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
      app.exit = code => { globalThis.exitCode = code; };
      export class BrowserWindow extends EventEmitter {
        constructor() {
          super();
          globalThis.window = this;
          this.webContents = new EventEmitter();
          this.webContents.setWindowOpenHandler = () => {};
        }
        loadURL() { return Promise.resolve(); }
      }
      export const dialog = { showErrorBox: (_, message) => {
        globalThis.failure = message;
      }};
      export const Menu = { buildFromTemplate: value => value,
        setApplicationMenu() {} };
      export const session = { defaultSession: new EventEmitter() };
      session.defaultSession.setPermissionCheckHandler = () => {};
      session.defaultSession.setPermissionRequestHandler = () => {};
      export const utilityProcess = { fork() {
        const service = new EventEmitter();
        globalThis.service = service;
        service.postMessage = () => {
          globalThis.stopped = true;
          service.emit("exit", 0);
        };
        setImmediate(() => service.emit("message", {
          url: "http://127.0.0.1:12345/#/smallpen"
        }));
        return service;
      }};
    \`);
    registerHooks({ resolve(specifier, context, next) {
      return specifier === "electron"
        ? { url: stub, shortCircuit: true } : next(specifier, context);
    }});
    const scenario = process.argv[2];
    const pending = [];
    let requests = 0;
    globalThis.fetch = () => {
      requests++;
      return new Promise((resolve, reject) => { pending.push(() => {
        if (scenario === "close-failure") reject(new Error("close failed"));
        else resolve({ ok: true, json: async () => ({}) });
      }); });
    };
    await import(process.argv[1]);
    const { app } = await import("electron");
    for (let i = 0; !globalThis.window && i < 100; i++)
      await new Promise(resolve => setImmediate(resolve));
    assert.ok(globalThis.window, "entry must create its window");
    const navigate = id => window.webContents.emit("did-navigate-in-page",
      {}, "http://127.0.0.1:12345/#/workspace?file-id=" + id, true);
    navigate("first");
    navigate("second");
    assert.equal(requests, 1);
    if (scenario === "last-window") window.emit("closed");
    app.emit("before-quit");
    if (scenario !== "last-window") window.emit("closed");
    app.emit("will-quit", { preventDefault() {} });
    assert.equal(globalThis.stopped, undefined,
      "service must remain alive until pending closes finish");
    assert.equal(requests, scenario === "last-window" ? 2 : 1,
      "quitting must not issue another close");
    pending.forEach(finish => finish());
    for (let i = 0; !globalThis.stopped && i < 100; i++)
      await new Promise(resolve => setImmediate(resolve));
    assert.equal(globalThis.stopped, true);
    assert.equal(globalThis.exitCode, scenario === "close-failure" ? 1 : 0);
    assert.equal(globalThis.failure,
      scenario === "close-failure" ? "close failed" : undefined);
  `,
        new URL("../apps/desktop/src/electron-main.mjs", import.meta.url).href,
        scenario,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(result.status, 0, result.stderr);
  });
}

test("desktop test distinguishes timeouts, failed exits and successful exits", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "smallpen-process-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, "app.log");
  const success = await runDesktopProcess(
    process.execPath,
    ["-e", "console.log('ready'); console.error('diagnostic')"],
    { log },
  );
  assert.deepEqual(success, { code: 0, signal: null, timedOut: false });
  assert.match(
    await readFile(log, "utf8"),
    /ready[\s\S]*diagnostic|diagnostic[\s\S]*ready/,
  );
  const failure = await runDesktopProcess(
    process.execPath,
    ["-e", "process.exit(7)"],
    { log },
  );
  assert.equal(failure.code, 7);
  assert.equal(failure.timedOut, false);
  const hung = await runDesktopProcess(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { log, timeoutMs: 100 },
  );
  assert.equal(hung.timedOut, true);
  assert.match(await readFile(log, "utf8"), /Timed out after 100 ms/);
});

test("desktop artifacts are uploaded before smoke tests without bypassing publication gates", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/smallpen.yml", import.meta.url),
    "utf8",
  );
  const testStep = workflow.indexOf("- name: Test the packaged App");
  assert.ok(testStep > workflow.indexOf("name: SmallPen-macOS-arm64-"));
  assert.ok(testStep > workflow.indexOf("name: SmallPen-Windows-x64-"));
  assert.match(workflow, /failure\(\) && steps\.smoke\.outcome == 'failure'/);
  assert.match(workflow, /publish:[\s\S]*needs: \[test, cli, desktop\]/);
  assert.doesNotMatch(workflow, /continue-on-error/);
});

test("intermediate artifacts are removed after all consumers finish", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/smallpen.yml", import.meta.url),
    "utf8",
  );
  const cleanup = workflow.slice(workflow.indexOf("  cleanup:"));
  assert.match(cleanup, /needs: \[cli, frontend, desktop, publish\]/);
  assert.match(cleanup, /if: always\(\)/);
  assert.match(
    cleanup,
    /select\(\.name == env.FRONTEND_ARTIFACT or \(\.name == env.NPM_ARTIFACT and env.PUBLISH_RESULT == "success"\)\)/,
  );
  assert.match(cleanup, /PUBLISH_RESULT: \$\{\{ needs.publish.result \}\}/);
  assert.match(cleanup, /actions\/runs\/\$RUN_ID\/artifacts/);
  assert.match(cleanup, /gh api --method DELETE/);
});
