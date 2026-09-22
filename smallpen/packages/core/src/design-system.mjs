// DSP-003: Workbench Combination enumeration, pure preview evaluation and
// explicit edit-target resolution for the design system workbench.
//
// Terminology (CONTEXT.md): a Token Domain groups Token Variants; a Paired
// Theme activates one Variant's Token Set. The Workbench Combination is the
// *observed* selection and never mutates the project's Current Combination.
import { listEffectiveTokens } from "./effective-tokens.mjs";
import { tokenInventoryRows } from "./catalog.mjs";
import { loadPackageFromValues } from "./package.mjs";

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function tokenLibraryEntries(snapshot) {
  return snapshot.manifest.entries.tokens.map((entry) => ({
    entry,
    library: snapshot.entries[entry],
  }));
}

function aliasPathOf(value) {
  if (typeof value !== "string") return null;
  return /^\{([^{}]+)\}$/.exec(value)?.[1] ?? null;
}

// DSP-003-A: enumerate the Workbench Combinations offered to the user, from
// the Paired Themes already defined in the package. No names are hardcoded;
// selection is by stable theme ids. The project Current Combination is
// reported per domain so the UI can show what the workbench does NOT change.
export function enumerateWorkbenchCombinations(snapshot) {
  const domains = new Map();
  const activeThemeIds = new Set();
  const libraries = tokenLibraryEntries(snapshot);
  for (const { library } of libraries) {
    for (const themeId of library.activeThemeIds ?? []) {
      activeThemeIds.add(themeId);
    }
  }
  for (const { library } of libraries) {
    for (const theme of library.themes ?? []) {
      const domain = theme.group;
      if (!domains.has(domain)) {
        domains.set(domain, {
          currentProjectThemeId: null,
          domain,
          domainId: `domain_${domain}`,
          variants: [],
        });
      }
      const record = domains.get(domain);
      if (activeThemeIds.has(theme.id)) {
        record.currentProjectThemeId = theme.id;
      }
      record.variants.push({
        name: theme.name,
        setIds: [...(theme.setIds ?? [])],
        themeId: theme.id,
      });
    }
  }
  const diagnostics = [];
  const knownThemeIds = new Set(
    libraries.flatMap(({ library }) =>
      (library.themes ?? []).map((theme) => theme.id),
    ),
  );
  for (const themeId of activeThemeIds) {
    if (!knownThemeIds.has(themeId)) {
      diagnostics.push({
        code: "combination_unknown_active_theme",
        message: `Active theme id is not defined in any token library: ${themeId}`,
        themeId,
      });
    }
  }
  const domainsList = [...domains.values()].sort((left, right) =>
    compareText(left.domain, right.domain),
  );
  for (const domain of domainsList) {
    if (!domain.currentProjectThemeId) {
      diagnostics.push({
        code: "combination_domain_unselected",
        domain: domain.domain,
        domainId: domain.domainId,
        message: `Token Domain has no active Paired Theme: ${domain.domain}`,
      });
    }
  }
  return { diagnostics, domains: domainsList };
}

// DSP-003-A: validate a workbench selection given as stable-id pairs
// [{domainId, themeId}]. Empty diagnostics means the combination is usable.
export function validateWorkbenchCombination(snapshot, combination) {
  const { diagnostics: enumerationDiagnostics, domains } =
    enumerateWorkbenchCombinations(snapshot);
  const diagnostics = [...enumerationDiagnostics];
  const byId = new Map(domains.map((domain) => [domain.domainId, domain]));
  const seen = new Set();
  for (const selection of combination ?? []) {
    const domain = byId.get(selection?.domainId);
    if (!domain) {
      diagnostics.push({
        code: "combination_unknown_domain",
        domainId: selection?.domainId ?? null,
        message: `Unknown Token Domain: ${String(selection?.domainId)}`,
      });
      continue;
    }
    if (seen.has(domain.domainId)) {
      diagnostics.push({
        code: "combination_duplicate_domain",
        domainId: domain.domainId,
        message: `Domain selected more than once: ${domain.domain}`,
      });
      continue;
    }
    seen.add(domain.domainId);
    const variant = domain.variants.find(
      (candidate) => candidate.themeId === selection?.themeId,
    );
    if (!variant) {
      diagnostics.push({
        code: "combination_unknown_variant",
        domainId: domain.domainId,
        message: `Theme is not a variant of Token Domain ${domain.domain}: ${String(selection?.themeId)}`,
        themeId: selection?.themeId ?? null,
      });
    }
  }
  for (const domain of domains) {
    if (!seen.has(domain.domainId) && domain.variants.length > 0) {
      diagnostics.push({
        code: "combination_missing_domain",
        domain: domain.domain,
        domainId: domain.domainId,
        message: `Workbench Combination must select Token Domain: ${domain.domain}`,
      });
    }
  }
  return { diagnostics };
}

function clonePackageValues(snapshot) {
  const values = new Map();
  values.set("manifest.json", structuredClone(snapshot.manifest));
  for (const [entry, value] of Object.entries(snapshot.entries)) {
    values.set(entry, structuredClone(value));
  }
  return values;
}

function homeSetOf(previewSnapshot, token) {
  const filePath = token.filePath;
  const library = previewSnapshot.entries[filePath];
  if (!library || !Array.isArray(library.sets)) return null;
  for (const set of library.sets) {
    if ((set.tokens ?? []).some((candidate) => candidate.id === token.id)) {
      return { setId: set.id, setName: set.name };
    }
  }
  return null;
}

function rawValueOf(previewSnapshot, token) {
  const library = previewSnapshot.entries[token.filePath];
  for (const set of library?.sets ?? []) {
    for (const candidate of set.tokens ?? []) {
      if (candidate.id === token.id) return candidate.value;
    }
  }
  return undefined;
}

// Raw/alias/resolved/source rows over an already-built preview snapshot.
function previewTokenRows(previewSnapshot) {
  return listEffectiveTokens(previewSnapshot).map((effective) => {
    const token = effective.token;
    const home = homeSetOf(previewSnapshot, token) ?? {
      setId: null,
      setName: null,
    };
    const raw = rawValueOf(previewSnapshot, token);
    return {
      alias: aliasPathOf(raw),
      homeSetId: home.setId,
      homeSetName: home.setName,
      ownerPackageId: previewSnapshot.manifest.packageId,
      path: token.path,
      raw,
      resolved: effective.value,
      setId: home.setId,
      setName: home.setName,
      sourceTokenId: token.id,
      type: token.type,
    };
  });
}

// DSP-003-B: pure evaluation preview. Patches the *observed* active themes in
// a cloned package (never the source, never an activate event) and runs the
// authoritative token resolver over it.
export async function createWorkbenchPreview(snapshot, combination) {
  const { diagnostics } = validateWorkbenchCombination(snapshot, combination);
  if (diagnostics.length > 0) {
    const error = new Error(
      `Invalid workbench combination: ${diagnostics
        .map((entry) => entry.code)
        .join(", ")}`,
    );
    error.code = "invalid_workbench_combination";
    error.diagnostics = diagnostics;
    throw error;
  }
  const enumeration = enumerateWorkbenchCombinations(snapshot);
  const values = clonePackageValues(snapshot);
  const observedThemeByGroup = new Map(
    (combination ?? []).map((selection) => {
      const domain = enumeration.domains.find(
        (candidate) => candidate.domainId === selection.domainId,
      );
      return [domain.domain, selection.themeId];
    }),
  );
  for (const libraryEntry of values.values()) {
    if (!libraryEntry || !Array.isArray(libraryEntry.themes)) continue;
    libraryEntry.activeThemeIds = libraryEntry.themes
      .filter(
        (theme) => observedThemeByGroup.get(theme.group) === theme.id,
      )
      .map((theme) => theme.id);
  }
  const preview = await loadPackageFromValues(snapshot.locator, values);
  return {
    combination: (combination ?? []).map((selection) => ({ ...selection })),
    preview,
    tokens: previewTokenRows(preview),
  };
}

function editablePackageId(previewSnapshot) {
  return previewSnapshot.manifest.packageId;
}

// DSP-003-C: explicit edit targets for one displayed value. Targets are only
// offered when unambiguous: the owning cell, the alias expression (when the
// raw value is an alias), the alias's shared target cell, and a variant
// override when the observed variant set differs from the cell's home set.
export function resolveWorkbenchEditTargets(
  previewSnapshot,
  combination,
  token,
) {
  const rows = previewTokenRows(previewSnapshot);
  const row = rows.find(
    (candidate) =>
      candidate.path === token.path &&
      candidate.ownerPackageId === token.ownerPackageId,
  );
  if (!row) {
    return {
      diagnostics: [{ code: "token_not_in_preview", path: token.path }],
      targets: [],
    };
  }
  const editablePackage = editablePackageId(previewSnapshot);
  const homeReadOnly = row.ownerPackageId !== editablePackage;
  const targets = [
    {
      kind: "cell",
      ownerPackageId: row.ownerPackageId,
      path: row.path,
      readOnly: homeReadOnly,
      setId: row.setId,
      tokenId: row.sourceTokenId,
    },
  ];
  if (row.alias) {
    targets.push({
      kind: "alias-expression",
      current: `{${row.alias}}`,
      ownerPackageId: row.ownerPackageId,
      path: row.path,
      readOnly: homeReadOnly,
      tokenId: row.sourceTokenId,
    });
    const target = rows.find((candidate) => candidate.path === row.alias);
    if (target) {
      targets.push({
        kind: "shared-cell",
        ownerPackageId: target.ownerPackageId,
        path: target.path,
        readOnly: target.ownerPackageId !== editablePackage,
        setId: target.setId,
        tokenId: target.sourceTokenId,
      });
    }
  }
  const domain = row.homeSetName ? row.homeSetName.split("/")[0] : null;
  const selection = (combination ?? []).find(
    (candidate) => candidate.domainId === `domain_${domain}`,
  );
  if (domain && selection) {
    const observed = findSetByTheme(previewSnapshot, selection.themeId);
    if (observed && observed.id !== row.setId) {
      targets.push({
        kind: "variant-override",
        observedSetId: observed.id,
        observedSetName: observed.name,
        ownerPackageId: row.ownerPackageId,
        path: row.path,
        readOnly: homeReadOnly,
      });
    }
  }
  return { diagnostics: [], targets };
}

function findSetByTheme(previewSnapshot, themeId) {
  for (const entry of Object.values(previewSnapshot.entries)) {
    if (!Array.isArray(entry?.themes)) continue;
    const theme = entry.themes.find((candidate) => candidate.id === themeId);
    if (theme) {
      const set = (entry.sets ?? []).find((candidate) =>
        (theme.setIds ?? []).includes(candidate.id),
      );
      if (set) return set;
    }
  }
  return null;
}

// DSP-004-B: build the generated System Sheet as pure data. Every specimen
// carries a stable projection identity derived from its qualified source key
// and points at the real editable target (Token Cell or component variant).
// Decorative elements (labels, section headers, rulers, scale) are flagged
// separately and are never design nodes.
export function buildWorkbenchSheet(snapshot, options = {}) {
  const libraries = options.libraries ?? [];
  const foundation = options.foundation;
  const packageId = snapshot.manifest.packageId;
  const sections = new Map();
  const sources = [
    { rows: tokenInventoryRows(snapshot, "product"), owner: packageId, source: "product" },
    ...(foundation
      ? [{ rows: tokenInventoryRows(foundation, "foundation"), owner: foundation.manifest.packageId, source: "foundation" }]
      : []),
    ...libraries.map((library) => ({
      rows: tokenInventoryRows(library, "library"),
      owner: library.manifest.packageId,
      source: "library",
    })),
  ];
  for (const { rows, owner } of sources) {
    for (const row of rows) {
      const domain = row.setName.split("/")[0];
      const sectionId = `dsp-section-${domain}`;
      if (!sections.has(sectionId)) {
        sections.set(sectionId, {
          id: sectionId,
          kind: "section",
          name: domain,
          // The section header/ruler are generated decorations.
          decoration: true,
          specimens: [],
        });
      }
      sections.get(sectionId).specimens.push({
        specimenId: `dsp-specimen/${row.qualifiedKey}`,
        kind: "token",
        decoration: false,
        active: row.active,
        readOnly: owner !== packageId,
        target: {
          kind: "token-cell",
          ownerPackageId: row.ownerPackageId,
          qualifiedKey: row.qualifiedKey,
          setId: row.setId,
          setName: row.setName,
          tokenId: row.tokenId ?? row.path,
          path: row.path,
        },
        display: { type: row.type, value: row.value },
      });
    }
  }
  // Component specimens: one per (component set, variant).
  const componentSetsOf = (snapshot, source, owner) =>
    [...snapshot.manifest.entries.components]
      .map((entry) => snapshot.entries[entry])
      .filter((componentFile) => Array.isArray(componentFile.componentSets))
      .flatMap((componentFile) => componentFile.componentSets)
      .filter((componentSet) => !publicFilter(componentSet))
      .flatMap((componentSet) =>
        componentSet.variants.map((variant) => ({
          specimenId: `dsp-specimen/component/${owner}/${componentSet.id}/${variant.id}`,
          kind: "component",
          decoration: false,
          readOnly: source !== "product",
          target: {
            kind: "component-definition",
            componentSetId: componentSet.id,
            ownerPackageId: owner,
            variantId: variant.id,
            rootId: variant.rootId,
          },
          display: { name: componentSet.name, selection: variant.selection },
        })),
      );
  function publicFilter(componentSet) {
    return componentSet.deprecated === true;
  }
  for (const specimen of componentSetsOf(snapshot, "product", packageId)) {
    const sectionId = "dsp-section-components";
    if (!sections.has(sectionId)) {
      sections.set(sectionId, {
        id: sectionId,
        kind: "section",
        name: "Components",
        decoration: true,
        specimens: [],
      });
    }
    sections.get(sectionId).specimens.push(specimen);
  }
  const orderedSections = [...sections.values()].sort((left, right) =>
    compareText(left.id, right.id),
  );
  return {
    id: "dsp-system-sheet",
    kind: "system-sheet",
    // Regenerable: the sheet is derived data and never persisted as pages.
    regenerable: true,
    sections: orderedSections,
  };
}
