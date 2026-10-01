#!/usr/bin/env node

import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyRuntimeDependencies } from "./copy-runtime-dependencies.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const smallpenRoot = resolve(here, "..");
const defaultOutput = join(smallpenRoot, "dist", "SmallPen-CLI");

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

// The build replaces its output wholesale. Only the default dist folder is
// ours to replace; any other existing content may be user data.
async function assertReplaceable(output) {
  if (output === defaultOutput) return;
  let descriptor;
  try {
    descriptor = await stat(output);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (descriptor.isDirectory() && (await readdir(output)).length === 0) return;
  throw new Error(
    `Output already exists: ${output}. Move it or choose a new --output path.`,
  );
}

async function build(output) {
  if (output === parse(output).root) {
    throw new Error("CLI output cannot be a filesystem root");
  }
  await assertReplaceable(output);
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
    await copyRuntimeDependencies(smallpenRoot, appRoot);

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

const output = resolve(option(process.argv.slice(2), "--output") ?? defaultOutput);

build(output)
  .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
