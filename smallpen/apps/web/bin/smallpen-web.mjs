#!/usr/bin/env node

import { servePenpotFrontend } from "../src/server.mjs";

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function help() {
  process.stdout.write(`SmallPen Penpot Frontend\n\n`);
  process.stdout.write(`Usage:\n`);
  process.stdout.write(
    `  smallpen-web <background-session-url> [--frontend-root PATH] [--host 127.0.0.1] [--port 43128]\n`,
  );
}

async function main(args) {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    help();
    return;
  }
  const backendUrl = args[0];
  const host = option(args, "--host") ?? "127.0.0.1";
  const frontendRoot = option(args, "--frontend-root");
  const portValue = option(args, "--port") ?? "43128";
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${portValue}`);
  }
  const service = await servePenpotFrontend({
    backendUrl,
    ...(frontendRoot ? { frontendRoot } : {}),
    host,
    port,
  });
  printJson({
    backend: service.backendUrl,
    frontend: service.url,
    status: "ready",
  });
  const close = async () => {
    await service.close();
    process.exit(0);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

main(process.argv.slice(2)).catch((error) => {
  printJson({
    error: {
      code: "penpot_frontend_error",
      message: error instanceof Error ? error.message : String(error),
    },
  });
  process.exitCode = 1;
});
