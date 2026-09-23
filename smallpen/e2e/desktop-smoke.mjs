import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const platformApp =
  process.platform === "darwin" ? "SmallPen.app" : "SmallPen-Windows-x64";
const app = process.argv[2] ?? join(root, "apps/desktop/dist", platformApp);
const executable =
  process.platform === "darwin"
    ? join(app, "Contents/MacOS/SmallPen")
    : join(app, "SmallPen.exe");
const parent = await mkdtemp(join(tmpdir(), "smallpen-electron-smoke-"));
const fixture = join(parent, "Round trip.smallpen");
await cp(join(root, "test/fixtures/roundtrip.smallpen"), fixture, {
  recursive: true,
});

try {
  for (const ui of ["home", "penpot"]) {
    const report = join(parent, `${ui}.json`);
    const result = await new Promise((resolveRun, reject) => {
      const child = spawn(
        executable,
        ui === "home" ? ["--smoke-home"] : ["--smoke", fixture],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            SMALLPEN_APPLICATION_STATE_PATH: join(parent, `${ui}-state.json`),
            SMALLPEN_SMOKE_PROFILE: join(parent, `${ui}-profile`),
            SMALLPEN_SMOKE_REPORT: report,
          },
        },
      );
      let output = "";
      child.stdout.on("data", (part) => {
        output += part;
      });
      child.stderr.on("data", (part) => {
        output += part;
      });
      const timer = setTimeout(() => child.kill(), 120000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolveRun({ code, output });
      });
    });
    assert.equal(result.code, 0, result.output);
    const data = JSON.parse(await readFile(report));
    assert.equal(data.status, "ready", JSON.stringify(data));
    assert.equal(data.ui, ui);
    assert.ok(data.metrics.some(({ type }) => type === "Tab"));
    await assert.rejects(
      fetch(new URL("/health", data.url), {
        signal: AbortSignal.timeout(1000),
      }),
    );
    assert.throws(() => process.kill(data.servicePid, 0), { code: "ESRCH" });
    console.log(JSON.stringify(data));
  }
  console.log(JSON.stringify({ status: "passed", app, evidence: parent }));
} catch (error) {
  console.error(error);
  console.error(`Evidence retained at ${parent}`);
  process.exitCode = 1;
}
