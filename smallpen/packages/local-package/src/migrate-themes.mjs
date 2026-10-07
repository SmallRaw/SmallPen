// `smallpen migrate-themes`: ADR 0003 upgrade by copy. The original Package
// (or Foundation + Product pair) stays untouched; the converted copy is
// written beside it in one rename.
import { cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  canonicalJSON,
  migrateTokenThemes,
  SmallPenError,
} from "@smallpen/core";

import { pathExists } from "./fs-utils.mjs";
import { openWorkspace } from "./workspace.mjs";

async function writePackage(packagePath, { deletedEntries, entries, manifest }) {
  await writeFile(join(packagePath, "manifest.json"), canonicalJSON(manifest), "utf8");
  for (const [entry, value] of Object.entries(entries)) {
    const output = join(packagePath, entry);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, canonicalJSON(value), "utf8");
  }
  for (const entry of deletedEntries) {
    if (Object.hasOwn(entries, entry)) continue;
    await rm(join(packagePath, entry), { force: true });
  }
}

export async function migrateThemesByCopy(locator, outputLocator) {
  if (typeof outputLocator !== "string" || outputLocator.length === 0) {
    throw new SmallPenError(
      "missing_migration_output",
      "migrate-themes requires --output NEW_PATH; the original is never changed",
    );
  }
  const workspace = await openWorkspace(locator);
  const { foundation, product } = workspace;
  const pair = Boolean(foundation) && foundation !== product;
  const outputPath = resolve(outputLocator);
  if (!pair && !outputPath.toLowerCase().endsWith(".smallpen")) {
    throw new SmallPenError(
      "invalid_package_path",
      "--output must be a new <name>.smallpen path for a single Package",
      { outputPath },
    );
  }
  if (await pathExists(outputPath)) {
    throw new SmallPenError(
      "migration_output_exists",
      `Migration output already exists: ${outputPath}`,
      { outputPath },
    );
  }
  const result = migrateTokenThemes({ foundation, product });
  const parent = dirname(outputPath);
  await mkdir(parent, { recursive: true });
  const transactionPath = await mkdtemp(join(parent, ".smallpen-migrate-"));
  const candidatePath = join(transactionPath, basename(outputPath));
  const dependency = pair
    ? product.manifest.dependencies.find(
        ({ packageId }) => packageId === foundation.manifest.packageId,
      )
    : undefined;
  // Package directory of each migrated Package, relative to candidatePath.
  const targets = new Map(
    pair
      ? [
          [foundation.manifest.packageId, dependency.path],
          [product.manifest.packageId, basename(product.locator)],
        ]
      : [[product.manifest.packageId, "."]],
  );
  const sources = new Map(
    [foundation, product].filter(Boolean).map((snapshot) => [
      snapshot.manifest.packageId,
      snapshot.locator,
    ]),
  );
  try {
    for (const migrated of result.packages) {
      const target = join(candidatePath, targets.get(migrated.packageId));
      // Copy everything first so blobs and other files travel along.
      await cp(sources.get(migrated.packageId), target, { recursive: true });
      await writePackage(target, migrated);
    }
    const productTarget = join(candidatePath, targets.get(product.manifest.packageId));
    const opened = await openWorkspace(productTarget);
    await rename(candidatePath, outputPath);
    await rm(transactionPath, { force: true, recursive: true });
    const finalPath = (packageId) => join(outputPath, targets.get(packageId));
    return {
      original: pair
        ? { foundationPath: foundation.locator, productPath: product.locator }
        : { packagePath: product.locator },
      output: pair
        ? {
            foundationPath: finalPath(foundation.manifest.packageId),
            productPath: finalPath(product.manifest.packageId),
            workspacePath: outputPath,
          }
        : { packagePath: outputPath },
      packages: [opened.foundation, opened.product]
        .filter(Boolean)
        .map((snapshot) => ({
          packageId: snapshot.manifest.packageId,
          revision: snapshot.revision,
        })),
      status: "migrated",
      themes: result.themes,
      warnings: result.warnings,
    };
  } catch (error) {
    await rm(transactionPath, { force: true, recursive: true });
    throw error;
  }
}
