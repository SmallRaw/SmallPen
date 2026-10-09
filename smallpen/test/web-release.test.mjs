import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
import test from "node:test";
import { buildWeb } from "../scripts/build-web.mjs";
import {
  commandLine,
  packWeb,
  smokeWeb,
  verifyManifest,
} from "../scripts/release.mjs";

test("the packed Web package runs through npm exec without CLI, Desktop or external installs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-web-release-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const frontend = join(root, "frontend");
  await mkdir(join(frontend, "js"), { recursive: true });
  await writeFile(
    join(frontend, "index.html"),
    "<!doctype html><title>SmallPen Web</title>",
  );
  for (const name of ["main.js", "main-workspace.js"])
    await writeFile(join(frontend, "js", name), "// built frontend");
  const output = join(root, "web");
  await buildWeb({ output, frontendRoot: frontend });
  const metadata = JSON.parse(
    await readFile(join(output, "package.json"), "utf8"),
  );
  assert.equal(metadata.name, "@smallpen/web");
  assert.equal(metadata.private, undefined);
  assert.ok(metadata.bundleDependencies.length > 0);
  assert.ok(
    !Object.keys(metadata.dependencies).some((name) =>
      /cli|desktop|electron/.test(name),
    ),
  );
  await assert.rejects(
    access(join(output, "node_modules", "@smallpen", "cli")),
  );
  await assert.rejects(
    access(join(output, "node_modules", "@smallpen", "desktop")),
  );
  await assert.rejects(
    buildWeb({ output, frontendRoot: frontend }),
    /already exists/,
  );
  const packages = [];
  for (const [index, name] of [
    "@smallpen/core",
    "@smallpen/local-package",
    "@smallpen/cli",
    "smallpen",
  ].entries()) {
    const filename = `package-${index}.tgz`;
    const bytes = `CLI artifact ${index}`;
    await writeFile(join(root, filename), bytes);
    packages.push({
      name,
      version: metadata.version,
      filename,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    });
  }
  const commit = "a".repeat(40);
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      version: metadata.version,
      channel: "alpha",
      commit,
      packages,
    }),
  );
  await assert.rejects(verifyManifest(root, commit, true), /packages/);
  await packWeb(root, metadata.version, "alpha", commit, output);
  const manifest = await verifyManifest(root, commit, true);
  const tarball = join(root, manifest.packages.at(-1).filename);
  await smokeWeb(root, commit);
  const [npm, args] = commandLine("npm", [
    "exec",
    "--yes",
    "--offline",
    "--cache",
    join(root, "cache"),
    "--package",
    tarball,
    "--",
    "smallpen-web",
    "--no-open",
    "--json",
  ]);
  const child = spawn(npm, args, {
    cwd: root,
    env: {
      ...process.env,
      SMALLPEN_APPLICATION_STATE_PATH: join(root, "state.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const exited = new Promise((resolve) => child.once("close", resolve));
  t.after(async () => {
    if (child.exitCode === null) {
      if (process.platform === "win32")
        execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
      else child.kill("SIGTERM");
    }
    await exited;
  });
  const ready = await new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(
      () => reject(new Error(`Web startup timed out: ${stderr}`)),
      30000,
    );
    child.stdout.on("data", (data) => {
      text += data;
      for (const line of text.split("\n")) {
        if (line.startsWith('{"status":"ready"')) {
          clearTimeout(timer);
          resolve(JSON.parse(line));
        }
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`Web exited ${code}: ${stderr}`));
    });
  });
  const html = await fetch(ready.url).then((response) => response.text());
  assert.match(html, /SmallPen Web/);
  assert.match(html, /smallpenLocalFilesReady/);
  const result = await fetch(new URL("/local/directories", ready.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(result.status, 200);
  await writeFile(tarball, "changed");
  await assert.rejects(verifyManifest(root, commit, true), /integrity/);
});
