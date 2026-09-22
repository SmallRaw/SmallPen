#!/usr/bin/env node

import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const smallpenRoot = resolve(here, "..");

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function copyModule(targetRoot, sourceRelative, targetRelative, children) {
  const source = join(smallpenRoot, sourceRelative);
  const target = join(targetRoot, targetRelative);
  await mkdir(target, { recursive: true });
  for (const child of children) {
    await cp(join(source, child), join(target, child), { recursive: true });
  }
}

async function build(output) {
  if (output === parse(output).root) {
    throw new Error("CLI output cannot be a filesystem root");
  }
  await mkdir(dirname(output), { recursive: true });
  const transaction = await mkdtemp(join(dirname(output), ".smallpen-cli-build-"));
  const candidate = join(transaction, basename(output));
  try {
    const appRoot = join(candidate, "app");
    await copyModule(appRoot, "apps/cli", "apps/cli", ["package.json", "bin"]);
    await copyModule(join(appRoot, "node_modules", "@smallpen"), "packages/core", "core", [
      "package.json",
      "src",
    ]);
    await copyModule(
      join(appRoot, "node_modules", "@smallpen"),
      "packages/local-package",
      "local-package",
      ["assets", "package.json", "src"],
    );
    await copyModule(appRoot, "node_modules/opentype.js", "node_modules/opentype.js", [
      "LICENSE",
      "dist",
      "package.json",
    ]);
    await copyModule(
      appRoot,
      "node_modules/@jsquash/webp",
      "node_modules/@jsquash/webp",
      ["codec", "decode.js", "encode.js", "index.js", "LICENSE", "package.json", "README.md"],
    );

    const unixLauncher = `#!/bin/sh
set -eu
SMALLPEN_CLI_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SMALLPEN_CLI_ROOT/app/apps/cli/bin/smallpen-check.cjs" "$@"
`;
    await writeFile(join(candidate, "smallpen"), unixLauncher, "utf8");
    await chmod(join(candidate, "smallpen"), 0o755);
    await writeFile(
      join(candidate, "smallpen.cmd"),
      '@echo off\r\nnode "%~dp0app\\apps\\cli\\bin\\smallpen-check.cjs" %*\r\n',
      "utf8",
    );
    await writeFile(
      join(candidate, "README.txt"),
      [
        "SmallPen CLI alpha",
        "",
        "Requires Node.js 24 or newer on PATH.",
        "macOS/Linux: ./smallpen --help",
        "Windows: smallpen.cmd --help",
        "",
      ].join("\n"),
      "utf8",
    );

    await rm(output, { force: true, recursive: true });
    await rename(candidate, output);
    await rm(transaction, { force: true, recursive: true });
    return { output, status: "built" };
  } catch (error) {
    await rm(transaction, { force: true, recursive: true });
    throw error;
  }
}

const output = resolve(
  option(process.argv.slice(2), "--output") ?? join(smallpenRoot, "dist", "SmallPen-CLI"),
);

build(output)
  .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
