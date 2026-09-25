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
    /select\(\.name == env.NPM_ARTIFACT or \.name == env.FRONTEND_ARTIFACT\)/,
  );
  assert.match(cleanup, /actions\/runs\/\$RUN_ID\/artifacts/);
  assert.match(cleanup, /gh api --method DELETE/);
});
