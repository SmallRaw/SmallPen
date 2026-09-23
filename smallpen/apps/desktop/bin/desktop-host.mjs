#!/usr/bin/env node

import { startDesktopHost } from "../src/host.mjs";
import { parseHostArguments } from "../src/arguments.mjs";

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(args) {
  const { packagePath, frontendRoot, parentStdio } = parseHostArguments(args);
  const host = await startDesktopHost({
    applicationStatePath:
      process.env.SMALLPEN_APPLICATION_STATE_PATH || undefined,
    frontendRoot,
    packagePath,
  });
  print({
    background: host.backgroundUrl,
    frontend: host.frontendRoot,
    ...(host.packagePath ? { package: host.packagePath } : {}),
    ...(host.packageName ? { packageName: host.packageName } : {}),
    ...(host.revision ? { revision: host.revision } : {}),
    status: "ready",
    web: host.url,
  });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await host.close();
    process.exit(0);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  if (parentStdio) {
    process.stdin.once("end", close);
    process.stdin.once("error", close);
    process.stdin.resume();
  }
}

main(process.argv.slice(2)).catch((error) => {
  print({
    error: {
      code: error?.code ?? "desktop_host_error",
      details: error?.details ?? {},
      message: error instanceof Error ? error.message : String(error),
    },
  });
  process.exitCode = 1;
});
