import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  canonicalJSON,
  initializationTokenThemes,
  SmallPenError,
} from "@smallpen/core";

import { pathExists } from "./fs-utils.mjs";
import { openPackage } from "./local-package.mjs";
import { openWorkspace } from "./workspace.mjs";

function slug(value) {
  return (
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "item"
  );
}

function contextAxis(axis) {
  return {
    defaultValue: slug(axis.defaultValue),
    id: axis.id,
    kind: axis.kind,
    name: axis.name,
    values: axis.values.map((value) => ({ id: slug(value), name: value })),
  };
}

function tokenDescriptor(name) {
  const path = name
    .split(".")
    .map((part) => slug(part))
    .join(".");
  const prefix = path.split(".")[0];
  if (prefix === "color") return { path, type: "color", value: "#6750a4" };
  if (prefix === "opacity") return { path, type: "opacity", value: 1 };
  if (prefix === "radius") return { path, type: "border-radius", value: 8 };
  if (prefix === "font") {
    return { path, type: "font-family", value: "Source Sans Pro" };
  }
  return {
    path,
    type: prefix === "spacing" ? "spacing" : "number",
    value: prefix === "spacing" ? 8 : 0,
  };
}

// The starter token library: initial Tokens in the base set, and the token
// themes the theme-kind axes describe (see initializationTokenThemes).
function tokenLibrary(brief, libraryId) {
  const usedIds = new Set();
  const usedNames = new Set();
  const baseTokens = [];
  for (const name of brief.initialTokens) {
    const descriptor = tokenDescriptor(name);
    if (usedNames.has(descriptor.path)) continue;
    usedNames.add(descriptor.path);
    let id = `tok_${slug(descriptor.path)}`;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `tok_${slug(descriptor.path)}_${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);
    baseTokens.push({
      description: "",
      id,
      name: descriptor.path,
      type: descriptor.type,
      value: descriptor.value,
    });
  }
  const { sets, themes } = initializationTokenThemes(brief.contextAxes);
  return {
    activeSetIds: ["tset_base"],
    activeThemeIds: themes.filter(({ active }) => active).map(({ id }) => id),
    defaultThemeIds: themes.filter(({ active }) => active).map(({ id }) => id),
    defaultSetIds: ["tset_base"],
    id: libraryId,
    sets: sets.map(({ id, name }) => ({
      description: "",
      id,
      name,
      tokens: id === "tset_base" ? baseTokens : [],
    })),
    themes: themes.map(({ group, id, name, setIds }) => ({
      description: "",
      externalId: "",
      group,
      id,
      isSource: false,
      name,
      setIds,
    })),
  };
}

// Context axes: the platform viewport plus every non-theme axis. Theme-kind
// axes are token themes instead.
function contextFile(brief) {
  const platformValues = brief.platforms.map((value) => ({
    id: slug(value),
    name: value,
  }));
  const axes = [
    {
      defaultValue: platformValues[0].id,
      id: "axis_platform",
      kind: "viewport",
      name: "Platform",
      values: platformValues,
    },
    ...brief.contextAxes
      .filter(({ id, kind }) => id !== "axis_platform" && kind !== "theme")
      .map(contextAxis),
  ];
  return {
    axes,
    profiles: [
      {
        default: true,
        id: `ctx_${slug(brief.platforms[0])}`,
        name: brief.platforms[0],
        values: Object.fromEntries(
          axes.map((axis) => [axis.id, axis.defaultValue]),
        ),
      },
    ],
  };
}

function contextDefaults(brief) {
  return contextFile(brief).profiles[0].values;
}

function starterComponentSets(brief) {
  return brief.initialComponents.map((name) => {
    const id = slug(name);
    const nodeId = `node_${id}_root`;
    return {
      axes: [],
      id: `cmp_${id}`,
      name,
      variants: [
        {
          id: `var_${id}_default`,
          nodes: {
            [nodeId]: {
              children: [],
              fills: [{ color: "#6750a4", type: "solid" }],
              height: 40,
              id: nodeId,
              name,
              type: "COMPONENT",
              width: 120,
              x: 0,
              y: 0,
            },
          },
          rootId: nodeId,
          selection: {},
        },
      ],
      visibility: "public",
    };
  });
}

function foundationFiles(proposal) {
  const brief = proposal.brief;
  return new Map([
    [
      "manifest.json",
      {
        entries: {
          assets: [],
          components: ["components/foundation.json"],
          contexts: ["contexts/foundation.json"],
          requirements: [],
          scenarios: [],
          screens: [],
          tokens: ["tokens/foundation.json"],
        },
        formatVersion: 1,
        name: proposal.packages.foundation.name,
        packageId: proposal.packages.foundation.packageId,
        role: "foundation",
      },
    ],
    [
      "components/foundation.json",
      { componentSets: starterComponentSets(brief) },
    ],
    ["contexts/foundation.json", contextFile(brief)],
    ["tokens/foundation.json", tokenLibrary(brief, "tlib_foundation")],
  ]);
}

// Screens, Scenarios and requirements of the first design; `owner` is the
// Package that holds them.
function designFiles(proposal, owner) {
  const { brief, firstDesign } = proposal;
  const rootId = `node_${slug(brief.firstScreen)}_root`;
  const width = brief.platforms[0].toLowerCase().includes("mobile")
    ? 390
    : 1024;
  const height = brief.platforms[0].toLowerCase().includes("mobile")
    ? 844
    : 768;
  return new Map([
    [
      "requirements/product.json",
      {
        annotations: [],
        flows: [
          {
            id: firstDesign.flowId,
            interactionIds: [],
            name: brief.firstJourney,
          },
        ],
        requirements: [
          {
            id: firstDesign.requirementId,
            links: [{ flowId: firstDesign.flowId, kind: "flow" }],
            markdown: `${brief.purpose}\n\nFirst output: ${brief.firstOutput}`,
            title: brief.firstJourney,
          },
        ],
      },
    ],
    [
      "scenarios/product.json",
      {
        scenarios: [
          {
            actions: [],
            context: contextDefaults(brief),
            expectedVisibleNodeIds: [rootId],
            fixture: {},
            id: firstDesign.scenarioId,
            name: brief.firstScenario,
            target: {
              kind: "screen",
              presentationId: firstDesign.presentationId,
              screen: {
                assetId: firstDesign.screenId,
                packageId: owner.packageId,
              },
            },
            viewport: { height, scale: 1, width },
          },
        ],
      },
    ],
    [
      "screens/first-design.json",
      {
        basePresentationId: firstDesign.presentationId,
        counterparts: [],
        id: firstDesign.screenId,
        name: firstDesign.name,
        presentations: [
          {
            id: firstDesign.presentationId,
            interactions: [],
            name: brief.platforms[0],
            nodes: {
              [rootId]: {
                children: [],
                fills: [{ color: "#ffffff", type: "solid" }],
                height,
                id: rootId,
                name: firstDesign.name,
                type: "FRAME",
                width,
                x: 0,
                y: 0,
              },
            },
            platform: brief.platforms[0],
            rootId,
            viewport: { height, width },
          },
        ],
      },
    ],
  ]);
}

function productFiles(proposal) {
  const { firstDesign } = proposal;
  const foundationThemes = tokenLibrary(proposal.brief, "tlib_foundation");
  return new Map([
    [
      "manifest.json",
      {
        defaultScreenId: firstDesign.screenId,
        dependencies: [
          {
            // The Product's selection of the Foundation's token themes.
            activeThemeIds: foundationThemes.activeThemeIds,
            packageId: proposal.packages.foundation.packageId,
            path: proposal.packages.foundation.directoryName,
          },
        ],
        entries: {
          assets: [],
          components: [],
          contexts: [],
          requirements: ["requirements/product.json"],
          scenarios: ["scenarios/product.json"],
          screens: ["screens/first-design.json"],
          tokens: ["tokens/product.json"],
        },
        formatVersion: 1,
        name: proposal.packages.product.name,
        packageId: proposal.packages.product.packageId,
        role: "product",
      },
    ],
    ...designFiles(proposal, proposal.packages.product),
    [
      "tokens/product.json",
      {
        // Product sets sit on top of the Foundation's active sets by name.
        activeSetIds: ["tset_product"],
        activeThemeIds: [],
        id: "tlib_product",
        sets: [
          {
            description: "",
            id: "tset_product",
            name: "product",
            tokens: [],
          },
        ],
        themes: [],
      },
    ],
  ]);
}

// The default layout: one self-contained Package with token sets and
// themes, Components and the first design.
function singlePackageFiles(proposal) {
  const { brief, firstDesign } = proposal;
  const owner = proposal.packages.package;
  return new Map([
    [
      "manifest.json",
      {
        defaultScreenId: firstDesign.screenId,
        entries: {
          assets: [],
          components: ["components/components.json"],
          contexts: ["contexts/contexts.json"],
          requirements: ["requirements/product.json"],
          scenarios: ["scenarios/product.json"],
          screens: ["screens/first-design.json"],
          tokens: ["tokens/tokens.json"],
        },
        formatVersion: 1,
        name: owner.name,
        packageId: owner.packageId,
        role: "foundation",
      },
    ],
    [
      "components/components.json",
      { componentSets: starterComponentSets(brief) },
    ],
    ["contexts/contexts.json", contextFile(brief)],
    ...designFiles(proposal, owner),
    [
      "tokens/tokens.json",
      tokenLibrary(brief, `tlib_${owner.packageId.replace(/^pkg_/, "")}`),
    ],
  ]);
}

// A package without pages: the CLI draws the first one with page draw.
function withoutPages(files) {
  const manifest = files.get("manifest.json");
  for (const entry of manifest.entries.screens) files.delete(entry);
  manifest.entries.screens = [];
  delete manifest.defaultScreenId;
  return files;
}

// The package file is named after --name when given ("Team App" ->
// team-app.smallpen), else after its folder.
function packageFileStem(name, folder) {
  const slug = String(name ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  return slug || folder;
}

async function writeFiles(packagePath, files) {
  for (const [entry, value] of files) {
    const output = join(packagePath, entry);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, canonicalJSON(value), "utf8");
  }
}

function blankPackageFiles(name, { neutral = false } = {}) {
  const suffix = randomUUID().replaceAll("-", "");
  const screenId = `scr_${suffix}`;
  const presentationId = `pres_${suffix}_${neutral ? "base" : "desktop"}`;
  const rootId = `node_${suffix}_root`;
  return new Map([
    [
      "manifest.json",
      {
        defaultScreenId: screenId,
        entries: {
          assets: [],
          components: [],
          contexts: [],
          requirements: [],
          scenarios: [],
          screens: ["screens/page-1.json"],
          tokens: ["tokens/tokens.json"],
        },
        formatVersion: 1,
        name,
        packageId: `pkg_${randomUUID().replaceAll("-", "")}`,
        role: "foundation",
      },
    ],
    [
      "screens/page-1.json",
      {
        basePresentationId: presentationId,
        counterparts: [],
        id: screenId,
        name: "Page 1",
        presentations: [
          {
            id: presentationId,
            interactions: [],
            name: neutral ? "Base" : "Desktop",
            nodes: {
              [rootId]: {
                children: [],
                fills: [{ color: "#ffffff", type: "solid" }],
                height: 768,
                id: rootId,
                name: "Board",
                type: "FRAME",
                width: 1024,
                x: 0,
                y: 0,
              },
            },
            ...(neutral ? {} : { platform: "desktop" }),
            rootId,
            viewport: { height: 768, width: 1024 },
          },
        ],
      },
    ],
    [
      "tokens/tokens.json",
      {
        activeSetIds: [],
        activeThemeIds: ["theme_default"],
        id: "tlib_default",
        sets: [
          {
            description: "",
            id: "tset_theme_default",
            name: "Theme/Default",
            tokens: [],
          },
        ],
        themes: [
          {
            description: "",
            externalId: "",
            group: "Theme",
            id: "theme_default",
            isSource: false,
            name: "Default",
            setIds: ["tset_theme_default"],
          },
        ],
      },
    ],
  ]);
}

// CLI creation has no business brief. Keep the same blank model as the App,
// with one Base canvas; workspace publication remains an atomic rename.
export async function initializeBlankWorkspace(locator, options = {}) {
  const workspacePath = resolve(locator);
  const layout = options.layout ?? "single";
  if (!["single", "foundation-product"].includes(layout)) {
    throw new SmallPenError("invalid_init_layout", "Unknown workspace layout", {
      validValues: ["foundation-product", "single"],
      value: layout,
    });
  }
  if (workspacePath.toLowerCase().endsWith(".smallpen")) {
    if (layout !== "single") {
      throw new SmallPenError(
        "invalid_init_layout",
        "A paired workspace requires a directory, not a .smallpen path",
      );
    }
    const created = await createBlankPackage(workspacePath, {
      ...options,
      neutral: true,
    });
    return { ...created, layout, status: "initialized" };
  }
  if (workspacePath === dirname(workspacePath)) {
    throw new SmallPenError(
      "invalid_workspace_path",
      "Workspace cannot be a filesystem root",
    );
  }
  if (await pathExists(workspacePath)) {
    throw new SmallPenError(
      "workspace_already_exists",
      `Workspace target already exists: ${workspacePath}`,
      { workspacePath },
    );
  }
  const folder = basename(workspacePath);
  const name = String(options.name ?? folder).trim() || "Untitled";
  if (name.length > 255) {
    throw new SmallPenError(
      "invalid_package_name",
      "Package name must contain at most 255 characters",
    );
  }
  await mkdir(dirname(workspacePath), { recursive: true });
  const transaction = await mkdtemp(
    join(dirname(workspacePath), ".smallpen-init-"),
  );
  const candidate = join(transaction, folder);
  try {
    const files = options.page === false ? withoutPages(blankPackageFiles(name, { neutral: true })) : blankPackageFiles(name, { neutral: true });
    const stem = options.name !== undefined ? packageFileStem(options.name, folder) : folder;
    if (layout === "single") {
      const filename = `${stem}.smallpen`;
      await writeFiles(join(candidate, filename), files);
      await openPackage(join(candidate, filename));
      await rename(candidate, workspacePath);
      return {
        layout,
        packagePath: join(workspacePath, filename),
        status: "initialized",
        workspacePath,
      };
    }
    const foundationName = `${stem}-foundation.smallpen`;
    const productName = `${stem}.smallpen`;
    const foundationFiles = blankPackageFiles(`${name} Foundation`, {
      neutral: true,
    });
    const foundationManifest = foundationFiles.get("manifest.json");
    for (const entry of foundationManifest.entries.screens)
      foundationFiles.delete(entry);
    foundationManifest.entries.screens = [];
    delete foundationManifest.defaultScreenId;
    const manifest = files.get("manifest.json");
    manifest.role = "product";
    manifest.dependencies = [
      {
        packageId: foundationManifest.packageId,
        path: foundationName,
        activeThemeIds: ["theme_default"],
      },
    ];
    files.set("tokens/tokens.json", {
      id: "tlib_product",
      sets: [],
      themes: [],
      activeSetIds: [],
      activeThemeIds: [],
    });
    await writeFiles(join(candidate, foundationName), foundationFiles);
    await writeFiles(join(candidate, productName), files);
    await openWorkspace(join(candidate, productName));
    await rename(candidate, workspacePath);
    return {
      foundationPath: join(workspacePath, foundationName),
      layout,
      productPath: join(workspacePath, productName),
      status: "initialized",
      workspacePath,
    };
  } finally {
    await rm(transaction, { recursive: true, force: true });
  }
}

export async function createBlankPackage(packageLocator, options = {}) {
  const packagePath = resolve(packageLocator);
  if (!packagePath.toLowerCase().endsWith(".smallpen")) {
    throw new SmallPenError(
      "invalid_package_path",
      "SmallPen Package must use the .smallpen extension",
      { packagePath },
    );
  }
  if (await pathExists(packagePath)) {
    throw new SmallPenError(
      "package_already_exists",
      `Package target already exists: ${packagePath}`,
      { packagePath },
    );
  }
  const defaultName = basename(packagePath).replace(/\.smallpen$/i, "");
  const name = String(options.name ?? defaultName).trim() || "Untitled";
  if (name.length > 255) {
    throw new SmallPenError(
      "invalid_package_name",
      "Package name must contain at most 255 characters",
    );
  }
  const parent = dirname(packagePath);
  await mkdir(parent, { recursive: true });
  const transactionPath = await mkdtemp(join(parent, ".smallpen-create-"));
  const candidatePath = join(transactionPath, basename(packagePath));
  try {
    const files = blankPackageFiles(name, options);
    await writeFiles(candidatePath, options.page === false ? withoutPages(files) : files);
    await openPackage(candidatePath);
    await rename(candidatePath, packagePath);
    await rm(transactionPath, { force: true, recursive: true });
    return { packagePath, status: "created" };
  } catch (error) {
    await rm(transactionPath, { force: true, recursive: true });
    throw error;
  }
}

export async function initializeWorkspace(
  workspaceLocator,
  proposal,
  options = {},
) {
  if (options.confirmed !== true) {
    throw new SmallPenError(
      "initialization_confirmation_required",
      "Initialization Proposal must be explicitly confirmed",
      {
        nextOperations: [
          {
            args: { confirm: true, proposal },
            operation: "smallpen.init.confirm",
          },
        ],
      },
    );
  }
  const workspacePath = resolve(workspaceLocator);
  if (await pathExists(workspacePath)) {
    throw new SmallPenError(
      "workspace_already_exists",
      `Initialization target already exists: ${workspacePath}`,
      { workspacePath },
    );
  }
  const parent = dirname(workspacePath);
  await mkdir(parent, { recursive: true });
  const transactionPath = await mkdtemp(join(parent, ".smallpen-init-"));
  const candidatePath = join(transactionPath, basename(workspacePath));
  // Proposals written before layouts existed always describe the pair.
  const single = (proposal.layout ?? "foundation-product") === "single";
  try {
    if (single) {
      await writeFiles(
        join(candidatePath, proposal.packages.package.directoryName),
        singlePackageFiles(proposal),
      );
    } else {
      await writeFiles(
        join(candidatePath, proposal.packages.foundation.directoryName),
        foundationFiles(proposal),
      );
      await writeFiles(
        join(candidatePath, proposal.packages.product.directoryName),
        productFiles(proposal),
      );
    }
    await mkdir(join(candidatePath, "initialization"), { recursive: true });
    await writeFile(
      join(candidatePath, "initialization", "brief.json"),
      canonicalJSON(proposal.brief),
      "utf8",
    );
    await writeFile(
      join(candidatePath, "initialization", "proposal.json"),
      canonicalJSON(proposal),
      "utf8",
    );
    if (single) {
      await openWorkspace(
        join(candidatePath, proposal.packages.package.directoryName),
      );
    } else {
      await openPackage(
        join(candidatePath, proposal.packages.foundation.directoryName),
      );
      await openWorkspace(
        join(candidatePath, proposal.packages.product.directoryName),
      );
    }
    await rename(candidatePath, workspacePath);
    await rm(transactionPath, { force: true, recursive: true });
    const paths = single
      ? {
          layout: "single",
          packagePath: join(
            workspacePath,
            proposal.packages.package.directoryName,
          ),
        }
      : {
          foundationPath: join(
            workspacePath,
            proposal.packages.foundation.directoryName,
          ),
          layout: "foundation-product",
          productPath: join(
            workspacePath,
            proposal.packages.product.directoryName,
          ),
        };
    return {
      ...paths,
      initializationBriefPath: join(
        workspacePath,
        "initialization",
        "brief.json",
      ),
      initializationProposalPath: join(
        workspacePath,
        "initialization",
        "proposal.json",
      ),
      status: "initialized",
      workspacePath,
    };
  } catch (error) {
    await rm(transactionPath, { force: true, recursive: true });
    throw error;
  }
}
