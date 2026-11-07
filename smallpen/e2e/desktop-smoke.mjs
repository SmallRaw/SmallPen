import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDesktopProcess } from "./run-desktop-process.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const platformApp =
  process.platform === "darwin" ? "SmallPen.app" : "SmallPen-Windows-x64";
const app = process.argv[2] ?? join(root, "apps/desktop/dist", platformApp);
const executable =
  process.platform === "darwin"
    ? join(app, "Contents/MacOS/SmallPen")
    : join(app, "SmallPen.exe");
const parent = await mkdtemp(join(tmpdir(), "smallpen-electron-smoke-"));
const evidence =
  process.env.SMALLPEN_SMOKE_EVIDENCE ?? join(parent, "evidence");
await mkdir(evidence, { recursive: true });
const fixture = join(parent, "Round trip.smallpen");
await cp(join(root, "test/fixtures/roundtrip.smallpen"), fixture, {
  recursive: true,
});

try {
  for (const ui of ["home", "penpot"]) {
    const report = join(evidence, `${ui}.json`);
    const log = join(evidence, `${ui}.log`);
    const result = await runDesktopProcess(
      executable,
      ui === "home" ? ["--smoke-home"] : ["--smoke", fixture],
      {
        log,
        env: {
          ...process.env,
          SMALLPEN_APPLICATION_STATE_PATH: join(parent, `${ui}-state.json`),
          SMALLPEN_SMOKE_PROFILE: join(parent, `${ui}-profile`),
          SMALLPEN_SMOKE_REPORT: report,
        },
      },
    );
    const output = await readFile(log, "utf8");
    if (result.timedOut)
      throw new Error(`${ui}: App timed out after 120 seconds\n${output}`);
    assert.equal(
      result.code,
      0,
      `${ui}: App exited with signal ${result.signal}\n${output}`,
    );
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
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify({ status: "passed" }),
  );
  console.log(JSON.stringify({ status: "passed", app, evidence }));
} catch (error) {
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify({ status: "failed", error: error.stack }),
  );
  console.error(error);
  console.error(`Evidence retained at ${evidence}`);
  process.exitCode = 1;
}
