import { listEffectiveTokens } from "./effective-tokens.mjs";

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function componentCatalog(snapshot, source, publicOnly = false) {
  const componentSets = [...snapshot.domain.componentSets.values()]
    .filter((componentSet) => componentSet.deprecated !== true)
    .filter((componentSet) => !publicOnly || componentSet.visibility === "public")
    .map((componentSet) => ({
      category: componentSet.category,
      description: componentSet.description,
      id: componentSet.id,
      kind: "set",
      legalSelections: componentSet.variants.map((variant) =>
        structuredClone(variant.selection),
      ),
      name: componentSet.name,
      packageId: snapshot.manifest.packageId,
      replaces: structuredClone(componentSet.replaces),
      revision: snapshot.revision,
      scenarios: [...snapshot.domain.scenarios.values()]
        .filter(
          (scenario) =>
            scenario.target.kind === "component" &&
            scenario.target.component.assetId === componentSet.id,
        )
        .map(({ id }) => id)
        .sort(),
      source,
      // DSP-002-B: variant identities so consumers can switch selections.
      variants: componentSet.variants.map((variant) => ({
        id: variant.id,
        rootId: variant.rootId,
        selection: structuredClone(variant.selection),
      })),
    }));
  const located = [...snapshot.domain.locatedComponents.values()].map(
    (component) => ({
      category: component.path,
      id: component.id,
      kind: "located",
      legalSelections: [{}],
      mainNodeId: component.mainNodeId,
      name: component.name,
      packageId: snapshot.manifest.packageId,
      presentationId: component.presentationId,
      revision: snapshot.revision,
      scenarios: [],
      screenId: component.screenId,
      source,
    }),
  );
  return [...componentSets, ...located].sort((left, right) =>
    compareText(left.id, right.id),
  );
}

// SP-023: public asset inventory per Library snapshot with qualified ownership.
function assetInventory(snapshot) {
  const assets = snapshot.manifest.entries.assets
    .map((entry) => snapshot.entries[entry])
    .sort((left, right) => compareText(left.id, right.id));
  return {
    colors: assets
      .flatMap((asset) =>
        asset.colors.map(({ id, name, path }) => ({ id, name, path })))
      .sort((left, right) => compareText(left.id, right.id)),
    fonts: assets
      .flatMap((asset) =>
        asset.fonts.map((family) => ({
          family: family.family,
          id: family.id,
          variants: family.variants.map(({ id, name, style, weight }) => ({
            id,
            name,
            style,
            weight,
          })),
        })))
      .sort((left, right) => compareText(left.id, right.id)),
    media: assets
      .flatMap((asset) =>
        asset.media.map(({ height, id, mimeType, name, path, width }) => ({
          height,
          id,
          mimeType,
          name,
          path,
          width,
        })))
      .sort((left, right) => compareText(left.id, right.id)),
    typographies: assets
      .flatMap((asset) =>
        asset.typographies.map(({ id, name, path }) => ({ id, name, path })))
      .sort((left, right) => compareText(left.id, right.id)),
  };
}

function screens(snapshot) {
  return snapshot.manifest.entries.screens
    .map((entry) => snapshot.entries[entry])
    .sort((left, right) => compareText(left.id, right.id))
    .map((screen) => ({
      basePresentationId: screen.basePresentationId,
      id: screen.id,
      name: screen.name,
      presentations: screen.presentations.map(({ id, name, platform }) => ({
        id,
        name,
        ...(platform ? { platform } : {}),
      })),
    }));
}


// DSP-002-A: full token inventory across the package, its Foundation and
// linked Libraries. Rows keep a qualified key and carry an active flag so
// consumers can separate the current combination from archived cells.
export function tokenInventoryRows(snapshot, source) {
  const packageId = snapshot.manifest.packageId;
  const readOnly = source !== "product";
  const rows = [];
  for (const entry of snapshot.manifest.entries.tokens) {
    const library = snapshot.entries[entry];
    const activeSets = new Set([
      ...(library.activeSetIds ?? []),
      ...(library.themes ?? [])
        .filter((theme) => (library.activeThemeIds ?? []).includes(theme.id))
        .flatMap((theme) => theme.setIds),
    ]);
    for (const set of library.sets ?? []) {
      for (const token of set.tokens ?? []) {
        const raw = token.value;
        const aliasMatch =
          typeof raw === "string" ? /^\{([^{}]+)\}$/.exec(raw) : null;
        rows.push({
          active: activeSets.has(set.id),
          deprecated: token.deprecated === true,
          definitionSource: { packageId, setName: set.name },
          path: token.name,
          tokenId: token.id,
          qualifiedKey: `${packageId}/${set.name}/${token.name}`,
          readOnly,
          setId: set.id,
          setName: set.name,
          source,
          // aliasPath is the raw alias reference; the aggregation pass below
          // resolves it against earlier sources and fills effective fields.
          status: aliasMatch ? `alias:${aliasMatch[1]}` : "ok",
          type: token.type,
          value: structuredClone(raw),
        });
      }
    }
  }
  return rows.sort(
    (left, right) =>
      compareText(left.qualifiedKey, right.qualifiedKey) ||
      compareText(left.setId, right.setId),
  );
}

// DSP-002-C: aggregate per-source inventories, resolving alias rows against
// rows defined earlier (product, then foundation, then libraries — mirroring
// the effective-token precedence). Returns rows plus a synthesized inventory
// revision over the contributing source revisions.
export function aggregateTokenInventory(sources) {
  const resolvedByPath = new Map();
  const rows = [];
  const sourceRevisions = [];
  for (const { revision, rows: sourceRows, source } of sources) {
    sourceRevisions.push(`${source}:${packageIdOf(sourceRows)}@${revision}`);
    for (const row of sourceRows) {
      const aliasMatch = /^alias:(.+)$/.exec(row.status);
      if (!aliasMatch) {
        const resolved = {
          ...row,
          effectiveSource: {
            ownerPackageId: row.definitionSource.packageId,
            path: row.path,
            setName: row.definitionSource.setName,
          },
          effectiveValue: structuredClone(row.value),
          status: "ok",
        };
        resolvedByPath.set(row.path, {
          ownerPackageId: row.definitionSource.packageId,
          path: row.path,
          setName: row.definitionSource.setName,
          value: row.value,
        });
        rows.push(resolved);
        continue;
      }
      const target = resolvedByPath.get(aliasMatch[1]);
      if (!target) {
        rows.push({
          ...row,
          effectiveSource: null,
          effectiveValue: null,
          status: `unresolved_alias:${aliasMatch[1]}`,
        });
        continue;
      }
      rows.push({
        ...row,
        effectiveSource: {
          ownerPackageId: target.ownerPackageId,
          path: target.path,
          setName: target.setName,
        },
        effectiveValue: structuredClone(target.value),
        status: "ok",
      });
    }
  }
  return {
    rows: rows.sort(
      (left, right) =>
        compareText(left.qualifiedKey, right.qualifiedKey) ||
        compareText(left.setId, right.setId),
    ),
    revision: synthesizeInventoryRevision(rows, sourceRevisions),
  };
}

function packageIdOf(rows) {
  return rows[0]?.ownerPackageId ?? "unknown";
}

function synthesizeInventoryRevision(rows, sourceRevisions) {
  // Deterministic non-cryptographic digest: document order-sensitive inputs.
  let hash = 0x811c9dc5;
  const input = `${sourceRevisions.join("|")}#${rows
    .map((row) => row.qualifiedKey)
    .join(",")}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `inv_${hash.toString(16).padStart(8, "0")}`;
}

export function createCatalog(product, options = {}) {
  const foundation = options.foundation;
  const libraries = options.libraries ?? [];
  const effective = listEffectiveTokens(product, {
    context: options.context,
    foundation,
    libraries: options.libraries,
  });
  const tokenInventory = aggregateTokenInventory([
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

  return {
    components: [
      ...componentCatalog(product, "product"),
      ...(foundation
        ? componentCatalog(foundation, "foundation", true)
        : []),
      ...libraries.flatMap((library) =>
        componentCatalog(library, "library", true),
      ),
    ].sort(
      (left, right) =>
        compareText(left.name, right.name) ||
        compareText(left.packageId, right.packageId) ||
        compareText(left.id, right.id),
    ),
    contexts: [
      ...product.domain.contextProfiles.values(),
      ...(foundation?.domain.contextProfiles.values() ?? []),
    ]
      .sort((left, right) => compareText(left.id, right.id))
      .map(({ default: isDefault, id, name, values }) => ({
        default: isDefault,
        id,
        name,
        values: structuredClone(values),
      })),
    effectiveTokens: effective.map(({ sourceChain, target, token, value }) => ({
      id: target.assetId,
      path: token.path,
      sourceChain,
      target,
      value,
    })),
    libraries: libraries.map((library) => ({
      assets: assetInventory(library),
      packageId: library.manifest.packageId,
      revision: library.revision,
    })),
    inherited: foundation
      ? {
          components: [...foundation.domain.componentSets.values()]
            .filter(({ deprecated, visibility }) =>
              visibility === "public" && deprecated !== true)
            .map(({ id }) => id)
            .concat([...foundation.domain.locatedComponents.keys()])
            .sort(),
          packageId: foundation.manifest.packageId,
          tokens: [...foundation.domain.tokens.values()]
            .filter(({ visibility }) => visibility === "public")
            .map(({ id }) => id)
            .sort(),
        }
      : undefined,
    packageId: product.manifest.packageId,
    requirements: [...product.domain.requirements.values()]
      .sort((left, right) => compareText(left.id, right.id))
      .map(({ id, links, title }) => ({
        coverage: links.length === 0 ? "missing" : "linked",
        id,
        linkCount: links.length,
        title,
      })),
    role: product.manifest.role,
    scenarios: [...product.domain.scenarios.values()]
      .sort((left, right) => compareText(left.id, right.id))
      .map(({ id, name, target }) => ({ id, name, targetKind: target.kind })),
    screens: screens(product),
    tokenInventory: tokenInventory.rows,
    tokenInventoryRevision: tokenInventory.revision,
    tokens: [...product.domain.tokens.values()]
      .sort((left, right) => compareText(left.id, right.id))
      .map(({ deprecated, id, path, type }) => ({
        deprecated,
        id,
        path,
        type,
      })),
    warnings: [...product.domain.requirements.values()]
      .filter(({ links }) => links.length === 0)
      .map(({ id }) => ({
        code: "missing_requirement_coverage",
        message: `Requirement has no Design Link: ${id}`,
        requirementId: id,
        severity: "warning",
      })),
  };
}
