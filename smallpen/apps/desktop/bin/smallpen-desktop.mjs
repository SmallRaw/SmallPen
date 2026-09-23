#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const defaultExecutable =
  process.platform === "win32"
    ? join(here, "..", "dist", "SmallPen-Windows-x64", "SmallPen.exe")
    : join(here, "..", "dist", "SmallPen.app", "Contents", "MacOS", "SmallPen");

async function main(args) {
  const buildTarget = process.platform === "win32" ? "windows" : "macos";
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`SmallPen Desktop\n\n`);
    process.stdout.write(`Usage:\n`);
    process.stdout.write(
      `  smallpen-desktop <package.smallpen> [--smoke] [--app EXECUTABLE]\n\n`,
    );
    process.stdout.write(
      `Build first with: npm run --workspace @smallpen/desktop build:${buildTarget}\n`,
    );
    return;
  }
  const appIndex = args.indexOf("--app");
  const executable =
    appIndex === -1 ? defaultExecutable : resolve(args[appIndex + 1] ?? "");
  if (appIndex !== -1 && !args[appIndex + 1])
    throw new Error("--app requires an executable path");
  const childArgs =
    appIndex === -1
      ? args
      : args.filter((_, index) => index !== appIndex && index !== appIndex + 1);
  await access(executable).catch(() => {
    throw new Error(
      `SmallPen Desktop is not built: ${executable}\nRun npm run --workspace @smallpen/desktop build:${buildTarget}`,
    );
  });
  const code = await new Promise((resolveCode, reject) => {
    const child = spawn(executable, childArgs, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (status) => resolveCode(status ?? 1));
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, () => child.kill(signal));
    }
  });
  process.exitCode = code;
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
