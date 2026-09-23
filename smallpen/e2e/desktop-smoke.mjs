import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const fixture = join(root, "test", "fixtures", "roundtrip.smallpen");
const buildScript = join(root, "apps", "desktop", "scripts", "build-macos.mjs");

function run(command, args, timeout = 60_000, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    child.stderr.setEncoding("utf8");
    child.stdout.setEncoding("utf8");
    child.stderr.on("data", (value) => (stderr += value));
    child.stdout.on("data", (value) => (stdout += value));
    child.once("error", reject);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, stdout });
    });
  });
}

async function hostProcesses(runtime) {
  const result = await run("ps", ["-axo", "command="]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result.stdout.split("\n").filter((line) => line.includes(`${runtime} `));
}

async function assertHostStopped(runtime) {
  for (let attempt = 0; attempt < 20 && (await hostProcesses(runtime)).length > 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(await hostProcesses(runtime), []);
}

async function main() {
  if (process.platform !== "darwin") {
    process.stdout.write(`${JSON.stringify({ reason: "macOS-only native shell", status: "skipped" })}\n`);
    return;
  }
  const parent = await mkdtemp(join(tmpdir(), "smallpen-desktop-e2e-"));
  const existing = process.argv[2];
  const app = existing ?? join(parent, "SmallPen.app");
  try {
    if (!existing) {
      const built = await run(process.execPath, [buildScript, "--output", app]);
      assert.equal(built.code, 0, built.stderr || built.stdout);
    }
    const executable = join(app, "Contents", "MacOS", "SmallPen");
    const runtime = join(app, "Contents", "Resources", "runtime", "node");
    const penpotIndex = join(
      app,
      "Contents",
      "Resources",
      "frontend",
      "resources",
      "public",
      "index.html",
    );
    await access(executable);
    await access(runtime);
    await access(penpotIndex);

    const plist = await run("plutil", ["-lint", join(app, "Contents", "Info.plist")]);
    assert.equal(plist.code, 0, plist.stderr || plist.stdout);
    const signature = await run("codesign", ["--verify", "--deep", "--strict", app]);
    assert.equal(signature.code, 0, signature.stderr || signature.stdout);

    const smoke = await run(
      executable,
      ["--smoke", fixture],
      60_000,
      {
        ...process.env,
        SMALLPEN_APPLICATION_STATE_PATH: join(parent, "application-state.json"),
      },
    );
    assert.equal(smoke.code, 0, smoke.stderr || smoke.stdout);
    assert.deepEqual(JSON.parse(smoke.stdout.trim()), {
      packageName: "SmallPen Round Trip",
      status: "ready",
      ui: "penpot",
    });
    await assertHostStopped(runtime);
    const home = await run(
      executable,
      ["--smoke-home"],
      60_000,
      {
        ...process.env,
        SMALLPEN_APPLICATION_STATE_PATH: join(parent, "home-application-state.json"),
      },
    );
    assert.equal(home.code, 0, home.stderr || home.stdout);
    assert.deepEqual(JSON.parse(home.stdout.trim()), {
      status: "ready",
      ui: "home",
    });
    await assertHostStopped(runtime);
    process.stdout.write(`${JSON.stringify({ app, status: "passed" })}\n`);
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
