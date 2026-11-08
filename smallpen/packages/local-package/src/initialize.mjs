// INPUT:  a new package or workspace path and an optional name
// OUTPUT: a blank HTML package (index.html, tokens.css, optional first page)
// POS:    `project init` and the App's New Package. Publication is one atomic
//         rename of a fully written and validated candidate.

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { SmallPenError } from "@smallpen/core";

import { pathExists } from "./fs-utils.mjs";
import { openPackage } from "./local-package.mjs";

function escapeText(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// The files of a blank package. With a page (the App's New Package), it
// also holds one empty white board to start drawing on.
export function blankPackageFiles(name, { page = true } = {}) {
  const files = new Map([
    [
      "index.html",
      [
        "<!doctype html>",
        "<html>",
        "<head>",
        '  <meta charset="utf-8">',
        `  <title>${escapeText(name)}</title>`,
        `  <meta name="smallpen:package-id" content="pkg_${randomUUID().replaceAll("-", "")}">`,
        "</head>",
        "<body></body>",
        "</html>",
        "",
      ].join("\n"),
    ],
    ["tokens.css", ":root {\n}\n"],
  ]);
  if (page) {
    files.set(
      "pages/Page 1.html",
      [
        "<!doctype html>",
        "<html>",
        "<head>",
        '  <meta charset="utf-8">',
        "  <title>Page 1</title>",
        '  <link rel="stylesheet" href="../tokens.css">',
        "</head>",
        '<body class="w-[1024px] h-[768px] bg-[#ffffff]"></body>',
        "</html>",
        "",
      ].join("\n"),
    );
  }
  return files;
}

// The package file is named after --name when given ("Team App" ->
// team-app.smallpen), else after its folder.
function packageFileStem(name, folder) {
  const slug = String(name ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  return slug || folder;
}

async function writeFiles(packagePath, files) {
  for (const [entry, value] of files) {
    const output = join(packagePath, entry);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, value, "utf8");
  }
}

function packageName(value, fallback) {
  const name = String(value ?? fallback).trim() || "Untitled";
  if (name.length > 255) {
    throw new SmallPenError("invalid_package_name", "Package name must contain at most 255 characters");
  }
  return name;
}

// CLI creation: a .smallpen path makes that package; any other path makes
// a workspace folder holding one package.
export async function initializeBlankWorkspace(locator, options = {}) {
  const workspacePath = resolve(locator);
  const layout = options.layout ?? "single";
  if (layout !== "single") {
    throw new SmallPenError("invalid_init_layout", "SmallPen packages are single packages; omit --layout", {
      validValues: ["single"],
      value: layout,
    });
  }
  if (workspacePath.toLowerCase().endsWith(".smallpen")) {
    const created = await createBlankPackage(workspacePath, options);
    return { ...created, layout, status: "initialized" };
  }
  if (workspacePath === dirname(workspacePath)) {
    throw new SmallPenError("invalid_workspace_path", "Workspace cannot be a filesystem root");
  }
  if (await pathExists(workspacePath)) {
    throw new SmallPenError("workspace_already_exists", `Workspace target already exists: ${workspacePath}`, { workspacePath });
  }
  const folder = basename(workspacePath);
  const name = packageName(options.name, folder);
  await mkdir(dirname(workspacePath), { recursive: true });
  const transaction = await mkdtemp(join(dirname(workspacePath), ".smallpen-init-"));
  const candidate = join(transaction, folder);
  try {
    const stem = options.name !== undefined ? packageFileStem(options.name, folder) : folder;
    const filename = `${stem}.smallpen`;
    await writeFiles(join(candidate, filename), blankPackageFiles(name, { page: options.page !== false }));
    await openPackage(join(candidate, filename));
    await rename(candidate, workspacePath);
    return { layout, packagePath: join(workspacePath, filename), status: "initialized", workspacePath };
  } finally {
    await rm(transaction, { recursive: true, force: true });
  }
}

export async function createBlankPackage(packageLocator, options = {}) {
  const packagePath = resolve(packageLocator);
  if (!packagePath.toLowerCase().endsWith(".smallpen")) {
    throw new SmallPenError("invalid_package_path", "SmallPen Package must use the .smallpen extension", { packagePath });
  }
  if (await pathExists(packagePath)) {
    throw new SmallPenError("package_already_exists", `Package target already exists: ${packagePath}`, { packagePath });
  }
  const name = packageName(options.name, basename(packagePath).replace(/\.smallpen$/i, ""));
  const parent = dirname(packagePath);
  await mkdir(parent, { recursive: true });
  const transactionPath = await mkdtemp(join(parent, ".smallpen-create-"));
  const candidatePath = join(transactionPath, basename(packagePath));
  try {
    await writeFiles(candidatePath, blankPackageFiles(name, { page: options.page !== false }));
    await openPackage(candidatePath);
    await rename(candidatePath, packagePath);
    await rm(transactionPath, { force: true, recursive: true });
    return { packagePath, status: "created" };
  } catch (error) {
    await rm(transactionPath, { force: true, recursive: true });
    throw error;
  }
}
