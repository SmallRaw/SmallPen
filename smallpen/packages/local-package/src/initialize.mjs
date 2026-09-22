import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { canonicalJSON, SmallPenError } from "@smallpen/core";

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
  if (prefix === "font") return { path, type: "font-family", value: "Inter" };
  return {
    path,
    type: prefix === "spacing" ? "spacing" : "number",
    value: prefix === "spacing" ? 8 : 0,
  };
}

function setToken(root, descriptor, usedIds) {
  const segments = descriptor.path.split(".");
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent[segment] ??= {};
    parent = parent[segment];
  }
  let id = `tok_${slug(descriptor.path)}`;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `tok_${slug(descriptor.path)}_${suffix}`;
    suffix += 1;
  }
  usedIds.add(id);
  parent[segments.at(-1)] = {
    $extensions: { smallpen: { id, visibility: "public" } },
    $type: descriptor.type,
    $value: descriptor.value,
  };
}

function foundationFiles(proposal) {
  const brief = proposal.brief;
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
      .filter(({ id }) => id !== "axis_platform")
      .map(contextAxis),
  ];
  const defaults = Object.fromEntries(
    axes.map((axis) => [axis.id, axis.defaultValue]),
  );
  const tokens = {};
  const usedTokenIds = new Set();
  for (const token of brief.initialTokens) {
    setToken(tokens, tokenDescriptor(token), usedTokenIds);
  }
  const componentSets = brief.initialComponents.map((name) => {
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
    ["components/foundation.json", { componentSets }],
    [
      "contexts/foundation.json",
      {
        axes,
        profiles: [
          {
            default: true,
            id: `ctx_${slug(brief.platforms[0])}`,
            name: brief.platforms[0],
            values: defaults,
          },
        ],
      },
    ],
    ["tokens/foundation.json", tokens],
  ]);
}

function productFiles(proposal) {
  const { brief, firstDesign } = proposal;
  const rootId = `node_${slug(brief.firstScreen)}_root`;
  const width = brief.platforms[0].toLowerCase().includes("mobile") ? 390 : 1024;
  const height = brief.platforms[0].toLowerCase().includes("mobile") ? 844 : 768;
  const defaults = {
    axis_platform: slug(brief.platforms[0]),
    ...Object.fromEntries(
      brief.contextAxes
        .filter(({ id }) => id !== "axis_platform")
        .map((axis) => [axis.id, slug(axis.defaultValue)]),
    ),
  };
  return new Map([
    [
      "manifest.json",
      {
        defaultScreenId: firstDesign.screenId,
        dependencies: [
          {
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
            context: defaults,
            expectedVisibleNodeIds: [rootId],
            fixture: {},
            id: firstDesign.scenarioId,
            name: brief.firstScenario,
            target: {
              kind: "screen",
              presentationId: firstDesign.presentationId,
              screen: {
                assetId: firstDesign.screenId,
                packageId: proposal.packages.product.packageId,
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
    [
      "tokens/product.json",
      {
        activeSetIds: [],
        activeThemeIds: ["theme_default"],
        id: "tlib_product",
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

async function writeFiles(packagePath, files) {
  for (const [entry, value] of files) {
    const output = join(packagePath, entry);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, canonicalJSON(value), "utf8");
  }
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function blankPackageFiles(name) {
  const suffix = randomUUID().replaceAll("-", "");
  const screenId = `scr_${suffix}`;
  const presentationId = `pres_${suffix}_desktop`;
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
            name: "Desktop",
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
            platform: "desktop",
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
    await writeFiles(candidatePath, blankPackageFiles(name));
    await openPackage(candidatePath);
    await rename(candidatePath, packagePath);
    await rm(transactionPath, { force: true, recursive: true });
    return { packagePath, status: "created" };
  } catch (error) {
    await rm(transactionPath, { force: true, recursive: true });
    throw error;
  }
}

export async function initializeWorkspace(workspaceLocator, proposal, options = {}) {
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
  const foundationPath = join(
    candidatePath,
    proposal.packages.foundation.directoryName,
  );
  const productPath = join(candidatePath, proposal.packages.product.directoryName);
  try {
    await writeFiles(foundationPath, foundationFiles(proposal));
    await writeFiles(productPath, productFiles(proposal));
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
    await openPackage(foundationPath);
    await openWorkspace(productPath);
    await rename(candidatePath, workspacePath);
    await rm(transactionPath, { force: true, recursive: true });
    return {
      foundationPath: join(
        workspacePath,
        proposal.packages.foundation.directoryName,
      ),
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
      productPath: join(workspacePath, proposal.packages.product.directoryName),
      status: "initialized",
      workspacePath,
    };
  } catch (error) {
    await rm(transactionPath, { force: true, recursive: true });
    throw error;
  }
}
