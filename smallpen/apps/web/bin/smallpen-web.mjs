#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startWebHost } from "../src/host.mjs";

function argumentsOf(args) {
  const result = { open: true, port: 0 };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--no-open") result.open = false;
    else if (arg === "--json") result.json = true;
    else if (arg === "--port" || arg === "--frontend-root") {
      const value = args[++i];
      if (!value || value.startsWith("--"))
        throw new Error(`${arg} requires a value`);
      if (arg === "--port") {
        if (!/^\d+$/.test(value) || Number(value) > 65535)
          throw new Error("Port must be between 0 and 65535");
        result.port = Number(value);
      } else result.frontendRoot = resolve(value);
    } else if (arg.startsWith("-") || result.packagePath)
      throw new Error(`Unknown argument: ${arg}`);
    else result.packagePath = resolve(arg);
  }
  return result;
}

async function openBrowser(url) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  await new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", fail);
    child.once("close", (code) =>
      code === 0 ? done() : fail(new Error(`Browser launcher exited ${code}`)),
    );
  });
}

async function main(args) {
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw new Error("SmallPen Web requires Node.js 24 or newer");
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`SmallPen Web

Usage: smallpen-web [package.smallpen] [options]

  --port NUMBER   Listen on this local port (default: available port)
  --no-open       Start without opening a browser
  --json          Print the startup result as JSON
  --help          Show usage
  --version       Show version

Open and save local packages through the service. Ctrl+C stops it.`);
    return;
  }
  if (args.length === 1 && args[0] === "--version") {
    console.log(
      JSON.parse(await readFile(new URL("../package.json", import.meta.url)))
        .version,
    );
    return;
  }
  const options = argumentsOf(args);
  const host = await startWebHost({
    applicationStatePath:
      process.env.SMALLPEN_APPLICATION_STATE_PATH || undefined,
    frontendRoot: options.frontendRoot,
    packagePath: options.packagePath,
    webPort: options.port,
  });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try {
      await host.close();
      process.exit(0);
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  if (options.json)
    console.log(JSON.stringify({ status: "ready", url: host.url }));
  else
    console.log(`SmallPen: ${host.url}
Ctrl+C stops the service.`);
  if (options.open) {
    try {
      await openBrowser(host.url);
    } catch {
      console.error(`Open ${host.url} in your browser.`);
    }
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
