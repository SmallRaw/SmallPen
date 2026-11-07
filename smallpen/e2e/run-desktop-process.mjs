import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

export function runDesktopProcess(
  executable,
  args,
  { env, log, timeoutMs = 120000 },
) {
  writeFileSync(log, "");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    let forceKill;
    const record = (chunk) => appendFileSync(log, chunk);
    child.stdout.on("data", record);
    child.stderr.on("data", record);
    const timer = setTimeout(() => {
      timedOut = true;
      record(`\nTimed out after ${timeoutMs} ms; terminating App\n`);
      child.kill();
      forceKill = setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(forceKill);
    };
    child.once("error", (error) => {
      cleanup();
      record(`${error.stack}\n`);
      reject(error);
    });
    child.once("close", (code, signal) => {
      cleanup();
      const result = { code, signal, timedOut };
      record(`\n${JSON.stringify(result)}\n`);
      resolve(result);
    });
  });
}
