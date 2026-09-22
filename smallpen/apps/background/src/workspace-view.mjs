import {
  buildCanvasScene,
  createCatalog,
  createCompareView,
  createWorkbenchPreview,
  enumerateWorkbenchCombinations,
  layoutCanvasScene,
  projectScreen,
  readDesignView,
  resolveEffectiveToken,
  tokenInventoryRows,
  aggregateTokenInventory,
} from "@smallpen/core";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function screenSummaries(snapshot) {
  return snapshot.manifest.entries.screens.map((entry) => {
    const screen = snapshot.entries[entry];
    return {
      basePresentationId: screen.basePresentationId,
      id: screen.id,
      name: screen.name,
      presentations: screen.presentations.map(
        ({ id, name, platform, viewport }) => ({
          id,
          name,
          platform,
          viewport: clone(viewport),
        }),
      ),
    };
  });
}

function ownerAsset(owner, value, readOnly) {
  return {
    ...clone(value),
    owner: {
      name: owner.manifest.name,
      packageId: owner.manifest.packageId,
      role: owner.manifest.role,
    },
    readOnly,
  };
}

function contextValues(snapshot, readOnly) {
  return {
    axes: [...snapshot.domain.contextAxes.values()].map((value) =>
      ownerAsset(snapshot, value, readOnly),
    ),
    profiles: [...snapshot.domain.contextProfiles.values()].map((value) =>
      ownerAsset(snapshot, value, readOnly),
    ),
  };
}

function tokenValues(snapshot, readOnly) {
  return [...snapshot.domain.tokens.values()]
    .map((value) => ownerAsset(snapshot, value, readOnly))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function componentValues(snapshot, readOnly) {
  return [...snapshot.domain.componentSets.values()]
    .map((value) => ownerAsset(snapshot, value, readOnly))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function composite(description) {
  return {
    foundation: description.workspace?.foundation,
    libraries: description.workspace?.libraries ?? [],
    product: description.workspace?.product ?? description.snapshot,
  };
}

export function createWorkspaceOverview(description) {
  const { foundation, product } = composite(description);
  const counts = {
    annotations: product.domain.annotations.size,
    components: product.domain.componentSets.size,
    contexts:
      product.domain.contextAxes.size + product.domain.contextProfiles.size,
    flows: product.domain.flows.size,
    requirements: product.domain.requirements.size,
    scenarios: product.domain.scenarios.size,
    screens: product.manifest.entries.screens.length,
    tokens: product.domain.tokens.size,
  };
  return {
    counts,
    dependency: foundation
      ? {
          name: foundation.manifest.name,
          packageId: foundation.manifest.packageId,
          revision: foundation.revision,
          role: foundation.manifest.role,
        }
      : undefined,
    draft: product.manifest.draft
      ? clone(product.manifest.draft)
      : undefined,
    package: {
      formatVersion: product.manifest.formatVersion,
      name: product.manifest.name,
      packageId: product.manifest.packageId,
      revision: product.revision,
      role: product.manifest.role,
    },
    screens: screenSummaries(product),
    status: clone(description.status),
  };
}

export function createDesignWorkspace(description, selector = {}) {
  const { foundation, libraries, product } = composite(description);
  const read = readDesignView(product, {
    foundation,
    libraries,
    locale: "zh-TW",
    selector: { ...selector, viewFormat: "structure" },
  });
  const contexts = contextValues(product, false);
  if (foundation) {
    const inherited = contextValues(foundation, true);
    contexts.axes.push(...inherited.axes);
    contexts.profiles.push(...inherited.profiles);
  }
  return {
    discovery: read.discovery,
    projection: read.result,
    selection: read.selection,
    selectorOptions: {
      contextAxes: contexts.axes,
      contextProfiles: contexts.profiles,
      scenarios: [...product.domain.scenarios.values()]
        .filter(({ target }) => target.kind === "screen")
        .map(({ id, name, target }) => ({
          id,
          name,
          presentationId: target.presentationId,
          screenId: target.screen.assetId,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      screens: screenSummaries(product),
    },
    status: clone(description.status),
  };
}

export function createCompareWorkspace(description, selectors) {
  const { foundation, libraries, product } = composite(description);
  return {
    ...createCompareView(product, selectors, { foundation, libraries }),
    status: clone(description.status),
  };
}

export function createDesignSystemWorkspace(description) {
  const { foundation, libraries, product } = composite(description);
  const tokenInventoryAggregate = aggregateTokenInventory([
    {
      revision: product.revision,
      rows: tokenInventoryRows(product, "product"),
      source: "product",
    },
    ...(foundation
      ? [
          {
            revision: foundation.revision,
            rows: tokenInventoryRows(foundation, "foundation"),
            source: "foundation",
          },
        ]
      : []),
    ...libraries.map((library) => ({
      revision: library.revision,
      rows: tokenInventoryRows(library, "library"),
      source: "library",
    })),
  ]);
  // DSP-005-A: Paired Themes grouped by Token Domain, so the workbench can
  // offer an observation-combination toolbar without reading source files.
  const themeDomains = new Map();
  const themeSources = [
    ...(foundation ? [{ snapshot: foundation, readOnly: true }] : []),
    { snapshot: product, readOnly: false },
    ...libraries.map((library) => ({ snapshot: library, readOnly: true })),
  ];
  for (const { snapshot, readOnly } of themeSources) {
    const packageId = snapshot.manifest.packageId;
    for (const entry of snapshot.manifest.entries.tokens) {
      const libraryData = snapshot.entries[entry];
      for (const theme of libraryData.themes ?? []) {
        const domain = theme.group;
        if (!themeDomains.has(domain)) {
          themeDomains.set(domain, { domain, readOnly, themes: [] });
        }
        const record = themeDomains.get(domain);
        record.readOnly = record.readOnly && readOnly;
        if (
          !record.themes.some((candidate) => candidate.themeId === theme.id)
        ) {
          record.themes.push({
            active: (libraryData.activeThemeIds ?? []).includes(theme.id),
            name: theme.name,
            readOnly,
            setId: theme.setIds?.[0] ?? null,
            themeId: theme.id,
          });
        }
      }
    }
  }
  const productContexts = contextValues(product, false);
  const foundationContexts = foundation
    ? contextValues(foundation, true)
    : { axes: [], profiles: [] };
  return {
    components: [
      ...componentValues(product, false),
      ...(foundation ? componentValues(foundation, true) : []),
    ],
    // The live product revision: the workbench uses it as Operation Batch
    // baseRevision for authoring writes (DSP-006+).
    revision: product.revision,
    themeDomains: [...themeDomains.values()],
    tokenInventory: tokenInventoryAggregate.rows,
    tokenInventoryRevision: tokenInventoryAggregate.revision,
    contexts: {
      axes: [...productContexts.axes, ...foundationContexts.axes],
      files: product.manifest.entries.contexts.map((entry) => ({
        entry,
        value: clone(product.entries[entry]),
      })),
      profiles: [...productContexts.profiles, ...foundationContexts.profiles],
    },
    status: clone(description.status),
    tokens: [
      ...tokenValues(product, false),
      ...(foundation ? tokenValues(foundation, true) : []),
    ],
  };
}

export function createRequirementsWorkspace(description) {
  const { product } = composite(description);
  const interactions = [];
  for (const screen of screenSummaries(product)) {
    const source = product.entries[
      product.manifest.entries.screens.find(
        (entry) => product.entries[entry].id === screen.id,
      )
    ];
    for (const presentation of source.presentations) {
      for (const interaction of presentation.interactions) {
        interactions.push({
          ...clone(interaction),
          presentationId: presentation.id,
          screenId: screen.id,
        });
      }
    }
  }
  return {
    annotations: [...product.domain.annotations.values()].map(clone),
    files: product.manifest.entries.requirements.map((entry) => ({
      entry,
      value: clone(product.entries[entry]),
    })),
    flows: [...product.domain.flows.values()].map(clone),
    interactions,
    requirements: [...product.domain.requirements.values()].map(clone),
    status: clone(description.status),
  };
}

export function createCatalogWorkspace(description, context = {}) {
  const { foundation, libraries, product } = composite(description);
  return {
    catalog: createCatalog(product, { context, foundation, libraries }),
    status: clone(description.status),
  };
}

export function createRepairWorkspace(description) {
  return {
    changes: clone(description.backend.changes),
    readOnly: description.status.readOnly,
    status: clone(description.status),
  };
}

// ---------------------------------------------------------------------------
// DSC-009/010: the generated canvas surface. Scene + layout + render payload
// in one read-only response. Combination is observational (theme ids).
// ---------------------------------------------------------------------------
export async function createCanvasWorkspace(description, { themes } = {}) {
  const { foundation, libraries, product } = composite(description);

  const enumeration = enumerateWorkbenchCombinations(product);
  const domainByTheme = new Map();
  for (const domain of enumeration.domains) {
    for (const variant of domain.variants) {
      domainByTheme.set(variant.themeId, domain.domainId);
    }
  }
  const requested = (themes ?? []).filter((themeId) =>
    domainByTheme.has(themeId),
  );
  const combination = (
    requested.length > 0
      ? requested.map((themeId) => ({
          domainId: domainByTheme.get(themeId),
          themeId,
        }))
      : enumeration.domains
          .filter((domain) => domain.currentProjectThemeId)
          .map((domain) => ({
            domainId: domain.domainId,
            themeId: domain.currentProjectThemeId,
          }))
  );

  const scene = buildCanvasScene(product, {
    combination,
    foundation,
    libraries,
  });
  const layout = layoutCanvasScene(scene);
  const preview = await createWorkbenchPreview(product, combination);
  const resolvedByTokenId = new Map(
    preview.tokens.map((row) => [row.sourceTokenId, row.resolved]),
  );

  const render = {};

  // Token specimens: raw + combination-resolved value.
  for (const row of preview.tokens) {
    const owner =
      row.ownerPackageId ??
      product.manifest.packageId;
    const specimenId = `scn/tok/${encodeURIComponent(
      `${owner}/${row.setName}/${row.path}`,
    )}`;
    render[specimenId] = {
      path: row.path,
      raw: row.raw,
      resolved: row.resolved,
      setId: row.setId,
      setName: row.setName,
      type: row.type,
    };
  }

  // Component variants: real trees with token bindings resolved against the
  // observed combination.
  const variantRender = (snapshot, owner) => {
    for (const entry of snapshot.manifest.entries.components) {
      const file = snapshot.entries[entry];
      for (const componentSet of file.componentSets ?? []) {
        for (const variant of componentSet.variants) {
          const nodes = structuredClone(variant.nodes);
          for (const node of Object.values(nodes)) {
            for (const [field, binding] of Object.entries(
              node.tokenBindings ?? {},
            )) {
              const resolution = resolveEffectiveToken(
                product,
                { assetId: binding.assetId, packageId: binding.packageId },
                { foundation, libraries },
              );
              if (resolution.status === "resolved") {
                node[field] = structuredClone(
                  resolution.resolution.value,
                );
              }
            }
          }
          const sceneId = `scn/cmp/${encodeURIComponent(
            owner,
          )}/${componentSet.id}/${variant.id}/${encodeURIComponent(
            variant.rootId,
          )}`;
          render[sceneId] = { nodes, rootId: variant.rootId };
        }
      }
    }
  };
  variantRender(product, product.manifest.packageId);
  if (foundation) variantRender(foundation, foundation.manifest.packageId);
  for (const library of libraries) variantRender(library, library.manifest.packageId);

  // Page compositions: full projection (instances expanded, bindings
  // resolved) keyed by the page scene root.
  for (const entry of product.manifest.entries.screens) {
    const screen = product.entries[entry];
    const projection = projectScreen(product, screen.id, {
      foundation,
      libraries,
    });
    const sceneId = `scn/page/${encodeURIComponent(
      product.manifest.packageId,
    )}/${screen.id}`;
    render[sceneId] = {
      nodes: projection.nodes,
      ownerPackageId: product.manifest.packageId,
      rootId: projection.rootId,
      screenId: screen.id,
      viewport:
        screen.presentations.find(({ id }) => id === projection.presentationId)
          ?.viewport ?? { width: 800, height: 600 },
    };
  }

  return {
    combination,
    enumeration,
    layout,
    render,
    scene,
    status: clone(description.status),
  };
}
