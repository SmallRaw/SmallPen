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
    for (const file of ["index.html", "js/main.js", "js/main-workspace.js"])
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
    await access(
      join(resources, "app/node_modules/@smallpen/local-package/assets/fonts"),
    );
    await access(join(resources, "app/node_modules/@jsquash/webp/utils.js"));
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
    assert.equal(new URL(ready.web).hash, "#/smallpen");
    assert.equal((await fetch(new URL("/health", ready.web))).status, 200);
    child.stdin.end();
    const [code] = await closed;
    assert.equal(code, 0, errors);
    await assert.rejects(fetch(new URL("/health", ready.web)));
  },
);
