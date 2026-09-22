#!/usr/bin/env node

import { SmallPenError } from "@smallpen/core";

import {
  defaultApplicationStatePath,
  serveLocalPackage,
} from "../src/index.mjs";

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function help() {
  process.stdout.write(`SmallPen Background\n\n`);
  process.stdout.write(`Usage:\n`);
  process.stdout.write(
    `  smallpen-background <package.smallpen> [--host 127.0.0.1] [--port 43127]\n`,
  );
}

function workspaceLocation(snapshot) {
  const screen = snapshot.manifest.entries.screens
    .map((entry) => snapshot.entries[entry])
    .find((entry) => entry.id === snapshot.manifest.defaultScreenId);
  const pageId = screen
    ? snapshot.runtime.pages[screen.id]?.[screen.basePresentationId]
    : undefined;
  const workspace = {
    fileId: snapshot.runtime.file,
    pageId,
    projectId: snapshot.runtime.project,
  };
  const route = new URLSearchParams({
    "file-id": workspace.fileId,
  });
  if (workspace.pageId) route.set("page-id", workspace.pageId);
  route.set("layout", "layers");
  return {
    penpotPath: `#/workspace?${route}`,
    workspace,
  };
}

async function main(args) {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    help();
    return;
  }
  const packagePath = args[0];
  const host = option(args, "--host") ?? "127.0.0.1";
  const portValue = option(args, "--port") ?? "43127";
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new SmallPenError("invalid_port", `Invalid port: ${portValue}`);
  }
  const service = await serveLocalPackage({
    applicationStatePath: defaultApplicationStatePath(),
    host,
    packagePath,
    port,
  });
  const location = workspaceLocation(service.backend.snapshot);
  printJson({
    backend: service.url,
    package: service.backend.snapshot.locator,
    ...location,
    revision: service.backend.snapshot.revision,
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
      code: error instanceof SmallPenError ? error.code : "internal_error",
      details: error instanceof SmallPenError ? error.details : {},
      message: error instanceof Error ? error.message : String(error),
    },
  });
  process.exitCode = 1;
});
