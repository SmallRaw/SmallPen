#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const smallpenRoot = resolve(desktopRoot, "..", "..");
const repositoryRoot = resolve(smallpenRoot, "..");

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    child.stderr.setEncoding("utf8");
    child.stdout.setEncoding("utf8");
    child.stderr.on("data", (value) => (stderr += value));
    child.stdout.on("data", (value) => (stdout += value));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolveRun({ stderr, stdout });
      else reject(new Error(`${command} exited ${code}\n${stdout}${stderr}`));
    });
  });
}

async function copyModule(appRoot, relative, children) {
  const source = join(smallpenRoot, relative);
  const target = join(appRoot, relative);
  await mkdir(target, { recursive: true });
  for (const child of children) {
    await cp(join(source, child), join(target, child), { recursive: true });
  }
}

async function build(output, frontendRoot) {
  if (process.platform !== "darwin") {
    throw new Error("SmallPen native Desktop currently builds on macOS only");
  }
  await mkdir(dirname(output), { recursive: true });
  const transaction = await mkdtemp(join(dirname(output), ".smallpen-desktop-build-"));
  const app = join(transaction, "SmallPen.app");
  const contents = join(app, "Contents");
  const executable = join(contents, "MacOS", "SmallPen");
  const resources = join(contents, "Resources");
  const appRoot = join(resources, "app");
  try {
    for (const required of ["index.html", "js/main.js", "js/main-workspace.js"]) {
      await access(join(frontendRoot, required)).catch(() => {
        throw new Error(
          `Penpot frontend build is missing ${required}: ${frontendRoot}\n` +
          "Build frontend resources before packaging SmallPen Desktop.",
        );
      });
    }
    await mkdir(dirname(executable), { recursive: true });
    await mkdir(join(resources, "runtime"), { recursive: true });
    await cp(join(desktopRoot, "native", "macos", "Info.plist"), join(contents, "Info.plist"));
    await writeFile(join(contents, "PkgInfo"), "APPL????", "utf8");
    await cp(process.execPath, join(resources, "runtime", "node"));
    await chmod(join(resources, "runtime", "node"), 0o755);

    await copyModule(appRoot, "apps/background", ["package.json", "src"]);
    await copyModule(appRoot, "apps/web", ["package.json", "src"]);
    await copyModule(appRoot, "apps/desktop", ["package.json", "bin", "src"]);
    await copyModule(appRoot, "packages/core", ["package.json", "src"]);
    await copyModule(appRoot, "packages/local-package", ["package.json", "src"]);
    await copyModule(appRoot, "packages/penpot-adapter", ["package.json", "src"]);
    await cp(
      frontendRoot,
      join(resources, "frontend", "resources", "public"),
      { recursive: true },
    );

    const scope = join(appRoot, "node_modules", "@smallpen");
    await mkdir(scope, { recursive: true });
    for (const [name, target] of [
      ["background", "apps/background"],
      ["core", "packages/core"],
      ["desktop", "apps/desktop"],
      ["local-package", "packages/local-package"],
      ["penpot-adapter", "packages/penpot-adapter"],
      ["web", "apps/web"],
    ]) {
      await symlink(`../../${target}`, join(scope, name), "dir");
    }

    await run("swiftc", [
      "-framework",
      "Cocoa",
      "-framework",
      "WebKit",
      join(desktopRoot, "native", "macos", "SmallPenDesktop.swift"),
      "-o",
      executable,
    ]);
    await chmod(executable, 0o755);
    await run("codesign", ["--force", "--deep", "--sign", "-", app]);
    await rm(output, { force: true, recursive: true });
    await rename(app, output);
    await rm(transaction, { force: true, recursive: true });
    return {
      app: output,
      executable: join(output, "Contents", "MacOS", "SmallPen"),
      frontend: join(output, "Contents", "Resources", "frontend", "resources", "public"),
      runtime: join(output, "Contents", "Resources", "runtime", "node"),
      status: "built",
    };
  } catch (error) {
    await rm(transaction, { force: true, recursive: true });
    throw error;
  }
}

const output = resolve(
  option(process.argv.slice(2), "--output") ?? join(desktopRoot, "dist", "SmallPen.app"),
);
const frontendRoot = resolve(
  option(process.argv.slice(2), "--frontend-root") ??
    join(repositoryRoot, "frontend", "resources", "public"),
);

build(output, frontendRoot)
  .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
