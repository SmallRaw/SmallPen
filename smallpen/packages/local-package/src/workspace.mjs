import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import {
  combineContextAxes,
  listEffectiveTokens,
  projectScenario,
  projectScreen,
  SmallPenError,
} from "@smallpen/core";

import { openPackage } from "./local-package.mjs";
import { openRemoteLibrary } from "./remote-library.mjs";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isWithinRoot(rootPath, candidatePath) {
  const child = relative(rootPath, candidatePath);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function chooseFoundation(dependency) {
  return {
    action: "choose-foundation",
    currentPath: dependency.path,
    expectedPackageId: dependency.packageId,
  };
}

function conflict(code, message, path, choices) {
  return { choices, code, message, path, severity: "error" };
}

function warning(code, message, path) {
  return { code, message, path, severity: "warning" };
}

function repair(product, conflicts, foundation, libraries = [], warnings = []) {
  return {
    conflicts,
    ...(foundation ? { foundation } : {}),
    libraries,
    product,
    status: "repair",
    warnings,
  };
}

function recreatedAssetKind(reference) {
  if (reference.assetId.startsWith("tok_")) return "token";
  if (reference.assetId.startsWith("cmp_")) return "component";
  return undefined;
}

function dependentUsagePath(path) {
  for (const pattern of [
    /^(.*\.presentations\[\d+\]\.nodes\.[^.]+)\.instance\.component$/,
    /^(.*\.scenarios\[\d+\])\.target\.(?:component|screen)$/,
    /^(.*\.requirements\[\d+\]\.links\[\d+\])(?:\.screen)?$/,
    /^(.*\.annotations\[\d+\])\.target(?:\.screen)?$/,
  ]) {
    const match = pattern.exec(path);
    if (match) return match[1];
  }
  return path;
}

function referenceRepairChoices(path, reference) {
  const assetKind = recreatedAssetKind(reference);
  return [
    { action: "retarget-reference", reference, referencePath: path },
    ...(assetKind
      ? [
          {
            action: "recreate-product-asset",
            assetKind,
            reference,
            referencePath: path,
          },
        ]
      : []),
    {
      action: "remove-dependent-usage",
      referencePath: dependentUsagePath(path),
    },
  ];
}

function externalReferences(product) {
  const result = [];
  const visit = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, `${path}[${index}]`));
      return;
    }
    if (!isRecord(value)) return;
    if (
      typeof value.packageId === "string" &&
      typeof value.assetId === "string"
    ) {
      if (value.packageId !== product.manifest.packageId) {
        result.push({ path, reference: structuredClone(value) });
      }
      return;
    }
    for (const [field, child] of Object.entries(value)) {
      visit(child, path ? `${path}.${field}` : field);
    }
  };
  for (const entry of Object.keys(product.entries).sort()) {
    visit(product.entries[entry], entry);
  }
  return result;
}

function packageAssets(foundation) {
  const assets = new Map();
  const add = (id, value, kind) => {
    if (typeof id !== "string") return;
    assets.set(id, {
      kind,
      visibility:
        value?.visibility ??
        value?.$extensions?.smallpen?.visibility ??
        "public",
    });
  };
  const visitDtcg = (value) => {
    if (!isRecord(value)) return;
    add(value.$extensions?.smallpen?.id, value, "token");
    for (const child of Object.values(value)) visitDtcg(child);
  };
  for (const entry of foundation.manifest.entries.tokens) {
    const value = foundation.entries[entry];
    if (Array.isArray(value?.sets)) {
      for (const set of value.sets) {
        for (const token of set.tokens ?? []) add(token.id, token, "token");
      }
    } else {
      visitDtcg(value);
    }
  }
  for (const entry of foundation.manifest.entries.components) {
    const value = foundation.entries[entry];
    add(value?.id, value, "component");
    for (const componentSet of value?.componentSets ?? []) {
      add(componentSet.id, componentSet, "component");
    }
  }
  for (const entry of foundation.manifest.entries.assets) {
    const library = foundation.entries[entry];
    for (const field of ["colors", "fonts", "media", "typographies"]) {
      for (const asset of library?.[field] ?? []) add(asset.id, asset, field);
    }
  }
  for (const entry of foundation.manifest.entries.screens) {
    add(foundation.entries[entry]?.id, foundation.entries[entry], "screen");
  }
  return assets;
}

function validateExternalReferences(product, libraries) {
  const packages = new Map(
    libraries.map((library) => [
      library.manifest.packageId,
      { assets: packageAssets(library), library },
    ]),
  );
  const conflicts = [];
  for (const usage of externalReferences(product)) {
    const choices = referenceRepairChoices(usage.path, usage.reference);
    const target = packages.get(usage.reference.packageId);
    if (!target) {
      conflicts.push({
        ...conflict(
          "undeclared_package_reference",
          `Asset references undeclared Library ${usage.reference.packageId}`,
          usage.path,
          choices,
        ),
        reference: usage.reference,
      });
      continue;
    }
    const asset = target.assets.get(usage.reference.assetId);
    const foundation = target.library.manifest.role === "foundation";
    if (!asset) {
      conflicts.push({
        ...conflict(
          foundation ? "missing_foundation_asset" : "missing_library_asset",
          `${foundation ? "Foundation" : "Library"} asset is missing: ${usage.reference.assetId}`,
          usage.path,
          choices,
        ),
        reference: usage.reference,
      });
    } else if (asset.visibility === "private") {
      conflicts.push({
        ...conflict(
          foundation ? "private_foundation_asset" : "private_library_asset",
          `Product cannot reference private ${foundation ? "Foundation" : "Library"} asset: ${usage.reference.assetId}`,
          usage.path,
          choices,
        ),
        reference: usage.reference,
      });
    }
  }
  return conflicts;
}

function contextSelections(product, foundation) {
  const axes = [...combineContextAxes(product, foundation).values()].sort(
    (left, right) => left.id.localeCompare(right.id),
  );
  let selections = [{}];
  for (const axis of axes) {
    selections = selections.flatMap((selection) =>
      axis.values.map(({ id }) => ({ ...selection, [axis.id]: id })),
    );
    if (selections.length > 4096) {
      throw new SmallPenError(
        "context_matrix_too_large",
        "Workspace Context matrix exceeds 4096 combinations",
        { count: selections.length },
      );
    }
  }
  return selections;
}

const DEPENDENCY_PROJECTION_CODES = new Set([
  "ambiguous_token_context_rule",
  "binding_type_mismatch",
  "duplicate_product_component_replacement",
  "duplicate_product_token_override",
  "duplicate_workspace_context_axis",
  "invalid_scenario_context",
  "invalid_token_context_rule",
  "missing_component",
  "missing_token",
  "missing_variant",
  "product_token_override_type_mismatch",
]);

function validateWorkspaceProjections(product, foundation, libraries = []) {
  try {
    for (const context of contextSelections(product, foundation)) {
      listEffectiveTokens(product, { context, foundation, libraries });
    }
    for (const entry of product.manifest.entries.screens) {
      const screen = product.entries[entry];
      for (const presentation of screen.presentations) {
        projectScreen(product, screen.id, {
          foundation,
          libraries,
          presentationId: presentation.id,
        });
      }
    }
    for (const scenario of product.domain.scenarios.values()) {
      projectScenario(product, scenario.id, { foundation, libraries });
    }
    return [];
  } catch (error) {
    if (
      !(error instanceof SmallPenError) ||
      !DEPENDENCY_PROJECTION_CODES.has(error.code)
    ) {
      throw error;
    }
    let path = error.details.path;
    let reference = error.details.reference;
    if (!path && error.details.instanceId) {
      const suffix = `.nodes.${error.details.instanceId}.instance.component`;
      const usage = externalReferences(product).find((candidate) =>
        candidate.path.endsWith(suffix),
      );
      path = usage?.path;
      reference = usage?.reference;
    }
    if (!path && error.details.scenarioId) {
      for (const entry of product.manifest.entries.scenarios) {
        const index = product.entries[entry].scenarios.findIndex(
          ({ id }) => id === error.details.scenarioId,
        );
        if (index >= 0) {
          path = `${entry}.scenarios[${index}]`;
          break;
        }
      }
    }
    path ??= "workspace.projection";
    const choices = reference
      ? referenceRepairChoices(path, reference)
      : [{ action: "remove-dependent-usage", referencePath: path }];
    return [
      {
        ...conflict(error.code, error.message, path, choices),
        ...(reference ? { reference } : {}),
      },
    ];
  }
}

function chooseLibrarySource(library) {
  return {
    action: "choose-library-source",
    expectedPackageId: library.packageId,
    source: structuredClone(library.source),
  };
}

async function resolveDeclaredLibraries(owners, options, workspaceRoot) {
  const conflicts = [];
  const records = new Map();
  const warnings = [];

  const visit = async (owner, library, index, depth, stack) => {
    const path = `manifest.json.libraries[${index}]`;
    const choice = chooseLibrarySource(library);
    if (stack.has(library.packageId)) {
      conflicts.push(
        conflict(
          "circular_library_reference",
          `Library cycle includes ${library.packageId}`,
          path,
          [choice],
        ),
      );
      return;
    }
    let snapshot;
    try {
      if (library.source.type === "url") {
        snapshot = await openRemoteLibrary(library.source.url, {
          cacheRoot: options.libraryCacheRoot,
          expectedPackageId: library.packageId,
          fetchImpl: options.fetchImpl,
          refresh: options.refreshRemoteLibraries === true,
        });
      } else {
        if (owner.remote) {
          throw new SmallPenError(
            "remote_library_local_dependency",
            "A Remote Library cannot resolve a machine-local child Library",
            { packageId: library.packageId },
          );
        }
        const candidate = resolve(dirname(owner.locator), library.source.path);
        const locator = await realpath(candidate);
        snapshot = await openPackage(locator);
        if (!isWithinRoot(workspaceRoot, locator)) {
          warnings.push(
            warning(
              "external_library_path",
              `Library ${snapshot.manifest.name} is outside the Workspace directory and may be harder to move or share`,
              `${path}.source.path`,
            ),
          );
        }
      }
    } catch (error) {
      conflicts.push(
        conflict(
          "library_unavailable",
          `Library ${library.packageId} cannot be opened: ${error.message}`,
          `${path}.source`,
          [choice],
        ),
      );
      return;
    }
    if (snapshot.manifest.packageId !== library.packageId) {
      conflicts.push(
        conflict(
          "library_id_mismatch",
          `Library Package id ${snapshot.manifest.packageId} does not match expected ${library.packageId}`,
          `${path}.packageId`,
          [choice],
        ),
      );
      return;
    }
    const existing = records.get(library.packageId);
    if (existing && existing.snapshot.revision !== snapshot.revision) {
      conflicts.push(
        conflict(
          "ambiguous_library_source",
          `Library ${library.packageId} resolves to more than one revision`,
          path,
          [choice],
        ),
      );
      return;
    }
    const record = existing ?? {
      direct: depth === 0,
      snapshot,
      source: structuredClone(library.source),
    };
    record.direct ||= depth === 0;
    records.set(library.packageId, record);
    if (snapshot.remote?.cache === "stale") {
      warnings.push(
        warning(
          "remote_library_offline",
          `Library ${snapshot.manifest.name} is using its last verified cache: ${snapshot.remote.warning}`,
          `${path}.source.url`,
        ),
      );
    }
    if (existing) return;
    const nextStack = new Set(stack);
    nextStack.add(library.packageId);
    for (const [childIndex, child] of (
      snapshot.manifest.libraries ?? []
    ).entries()) {
      await visit(snapshot, child, childIndex, depth + 1, nextStack);
    }
  };

  const rootIds = new Set(owners.map(({ manifest }) => manifest.packageId));
  for (const owner of owners) {
    for (const [index, library] of (owner.manifest.libraries ?? []).entries()) {
      await visit(owner, library, index, 0, rootIds);
    }
  }
  return {
    conflicts,
    libraries: [...records.values()].map(({ snapshot }) => snapshot),
    librarySources: [...records.values()].map((record) => ({
      ...(record.snapshot.remote?.cache
        ? { cache: record.snapshot.remote.cache }
        : {}),
      direct: record.direct,
      fileId: record.snapshot.runtime.file,
      name: record.snapshot.manifest.name,
      packageId: record.snapshot.manifest.packageId,
      revision: record.snapshot.revision,
      role: record.snapshot.manifest.role,
      source: record.source,
    })),
    warnings,
  };
}

export async function resolveWorkspace(productLocator, options = {}) {
  const product = await openPackage(productLocator);
  const workspaceRoot = dirname(product.locator);
  if (product.manifest.role === "foundation") {
    const resolved = await resolveDeclaredLibraries(
      [product],
      options,
      workspaceRoot,
    );
    const referenceConflicts =
      resolved.conflicts.length === 0
        ? validateExternalReferences(product, resolved.libraries)
        : [];
    const conflicts = [...resolved.conflicts, ...referenceConflicts];
    if (conflicts.length > 0) {
      return repair(
        product,
        conflicts,
        undefined,
        resolved.libraries,
        resolved.warnings,
      );
    }
    return {
      status: "ready",
      warnings: resolved.warnings,
      workspace: {
        libraries: resolved.libraries,
        librarySources: resolved.librarySources,
        product,
      },
    };
  }
  const dependency = product.manifest.dependencies[0];
  const choice = chooseFoundation(dependency);
  const candidatePath = resolve(workspaceRoot, dependency.path);
  let foundationPath;
  try {
    foundationPath = await realpath(candidatePath);
  } catch (error) {
    return repair(product, [
      conflict(
        "foundation_unavailable",
        `Foundation cannot be opened at ${dependency.path}: ${error.message}`,
        "manifest.json.dependencies[0].path",
        [choice],
      ),
    ]);
  }
  let foundation;
  try {
    foundation = await openPackage(foundationPath);
  } catch (error) {
    return repair(product, [
      conflict(
        "foundation_invalid",
        `Foundation Package is invalid: ${error.message}`,
        dependency.path,
        [choice],
      ),
    ]);
  }
  const conflicts = [];
  const warnings = [];
  if (!isWithinRoot(workspaceRoot, foundationPath)) {
    warnings.push(
      warning(
        "external_foundation_path",
        "Foundation is outside the Workspace directory and may be harder to move or share",
        "manifest.json.dependencies[0].path",
      ),
    );
  }
  if (foundation.manifest.role !== "foundation") {
    conflicts.push(
      conflict(
        "dependency_not_foundation",
        "Product dependency must have the Foundation role",
        "manifest.json.dependencies[0].path",
        [choice],
      ),
    );
  }
  if (foundation.manifest.packageId !== dependency.packageId) {
    conflicts.push(
      conflict(
        "dependency_id_mismatch",
        `Foundation Package id ${foundation.manifest.packageId} does not match expected ${dependency.packageId}`,
        "manifest.json.dependencies[0].packageId",
        [choice],
      ),
    );
  }
  const resolved =
    conflicts.length === 0
      ? await resolveDeclaredLibraries(
          [product, foundation],
          options,
          workspaceRoot,
        )
      : { conflicts: [], libraries: [], librarySources: [], warnings: [] };
  conflicts.push(...resolved.conflicts);
  warnings.push(...resolved.warnings);
  if (conflicts.length === 0) {
    conflicts.push(
      ...validateExternalReferences(product, [
        foundation,
        ...resolved.libraries,
      ]),
    );
  }
  if (conflicts.length === 0) {
    conflicts.push(
      ...validateWorkspaceProjections(product, foundation, resolved.libraries),
    );
  }
  if (conflicts.length > 0) {
    return repair(product, conflicts, foundation, resolved.libraries, warnings);
  }
  return {
    status: "ready",
    warnings,
    workspace: {
      foundation,
      libraries: resolved.libraries,
      librarySources: resolved.librarySources,
      product,
    },
  };
}

export async function openWorkspace(productLocator, options = {}) {
  const resolution = await resolveWorkspace(productLocator, options);
  if (resolution.status === "repair") {
    throw new SmallPenError(
      "repair_required",
      "SmallPen workspace requires dependency Repair",
      { conflicts: resolution.conflicts },
    );
  }
  return resolution.workspace;
}
