import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import test from "node:test";
import { parseHostArguments } from "../apps/desktop/src/arguments.mjs";
import { stagePayload } from "../apps/desktop/scripts/stage-payload.mjs";
import { retryDownloads } from "../apps/desktop/scripts/retry-download.mjs";

test("Electron downloads retry server and network errors, not a 404", async () => {
  const failing = (...errors) => {
    const downloader = {
      calls: 0,
      async download(url, target) {
        const error = errors[downloader.calls++];
        if (error) throw error;
        return `${url} -> ${target}`;
      },
    };
    return downloader;
  };
  const http = (status) =>
    Object.assign(new Error(`Response code ${status}`), {
      response: { status },
    });
  const quick = { delayMs: 0, log() {} };

  const flaky = failing(http(504), new TypeError("fetch failed"));
  assert.equal(
    await retryDownloads(flaky, quick).download("zip", "file"),
    "zip -> file",
  );
  assert.equal(flaky.calls, 3);

  const missing = failing(http(404));
  await assert.rejects(
    retryDownloads(missing, quick).download("zip", "file"),
    /404/,
  );
  assert.equal(missing.calls, 1, "a missing file is not retried");

  const down = failing(http(503), http(503), http(503), http(503), http(503));
  await assert.rejects(
    retryDownloads(down, quick).download("zip", "file"),
    /503/,
  );
  assert.equal(down.calls, 4, "the build gives up after four tries");
});

test("host options never become a package path", () => {
  assert.deepEqual(
    parseHostArguments([
      "--frontend-root",
      "C:\\app files\\frontend",
      "--parent-stdio",
    ]),
    { frontendRoot: "C:\\app files\\frontend", parentStdio: true },
  );
  assert.deepEqual(
    parseHostArguments(["--frontend-root", "/frontend", "/a.smallpen"]),
    { frontendRoot: "/frontend", packagePath: "/a.smallpen" },
  );
  for (const args of [
    ["--frontend-root"],
    ["--frontend-root", "--parent-stdio"],
    ["--unknown"],
    ["a", "b"],
  ])
    assert.throws(() => parseHostArguments(args));
});

test(
  "portable Desktop payload starts from a path with spaces and stops on parent EOF",
  { timeout: 20000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "smallpen desktop "));
    t.after(() => rm(root, { recursive: true, force: true }));
    const frontend = join(root, "frontend");
    await mkdir(join(frontend, "js"), { recursive: true });
    for (const file of ["index.html", "js/main.js", "js/main-workspace.js", "js/main.js.map"])
      await writeFile(
        join(frontend, file),
        file.endsWith("html") ? "<!doctype html><title>SmallPen</title>" : "",
      );
    const resources = join(root, "resources");
    await stagePayload(
      fileURLToPath(new URL("../", import.meta.url)),
      resources,
      frontend,
    );
    await access(join(resources, "frontend/resources/public/js/main.js"));
    await assert.rejects(
      access(join(resources, "frontend/resources/public/js/main.js.map")),
      "source maps stay out of the Desktop payload",
    );
    await access(
      join(resources, "app/node_modules/@smallpen/local-package/assets/fonts"),
    );
    await access(join(resources, "app/node_modules/@smallpen/local-package/runtime/render-wasm.wasm"));
    const child = spawn(
      process.execPath,
      [
        join(resources, "app/apps/desktop/bin/desktop-host.mjs"),
        "--frontend-root",
        join(resources, "frontend/resources/public"),
        "--parent-stdio",
      ],
      {
        env: {
          ...process.env,
          SMALLPEN_APPLICATION_STATE_PATH: join(root, "state.json"),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const closed = once(child, "close");
    t.after(async () => {
      if (child.exitCode === null) child.kill();
      await closed;
    });
    let errors = "";
    child.stderr.on("data", (part) => (errors += part));
    const line = await new Promise((resolve, reject) => {
      let text = "";
      child.once("error", reject);
      child.once("exit", () =>
        reject(new Error(errors || "Host exited before ready")),
      );
      child.stdout.on("data", (part) => {
        text += part;
        if (text.includes("\n")) resolve(text.split("\n")[0]);
      });
    });
    const ready = JSON.parse(line);
    assert.equal(ready.status, "ready", errors);
    assert.equal(new URL(ready.web).search, "?screen=smallpen-home");
    assert.equal((await fetch(new URL("/health", ready.web))).status, 200);
    child.stdin.end();
    const [code] = await closed;
    assert.equal(code, 0, errors);
    await assert.rejects(fetch(new URL("/health", ready.web)));
  },
);
