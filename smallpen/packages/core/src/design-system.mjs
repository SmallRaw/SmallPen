// DSP-003: Workbench Combination enumeration, pure preview evaluation and
// explicit edit-target resolution for the design system workbench.
//
// Terminology (CONTEXT.md): a Token Domain groups Token Variants; a Paired
// Theme activates one Variant's Token Set. The Workbench Combination is the
// *observed* selection and never mutates the project's Current Combination.
import { listEffectiveTokens } from "./effective-tokens.mjs";
import { loadPackageFromValues } from "./package.mjs";
import {
  listTokenThemes,
  productFoundationThemeIds,
  selectTokenThemes,
  tokenLibraryOf,
} from "./token-themes.mjs";

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function aliasPathOf(value) {
  if (typeof value !== "string") return null;
  return /^\{([^{}]+)\}$/.exec(value)?.[1] ?? null;
}

// DSP-003-A: enumerate the Workbench Combinations offered to the user, from
// the Paired Themes already defined in the package. No names are hardcoded;
// selection is by stable theme ids. The project Current Combination is
// reported per domain so the UI can show what the workbench does NOT change.
// options.foundation: a Product's Foundation, whose themes it selects; its
// variants carry the owning packageId.
export function enumerateWorkbenchCombinations(snapshot, options = {}) {
  const domains = new Map();
  for (const theme of listTokenThemes(snapshot, options.foundation)) {
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
    if (theme.active) record.currentProjectThemeId = theme.id;
    record.variants.push({
      name: theme.name,
      packageId: theme.packageId,
      setIds: [...theme.setIds],
      themeId: theme.id,
    });
  }
  const diagnostics = [];
  const known = (library) => new Set((library?.themes ?? []).map(({ id }) => id));
  const ownKnown = known(tokenLibraryOf(snapshot));
  const foundationKnown = known(tokenLibraryOf(options.foundation));
  for (const themeId of [
    ...(tokenLibraryOf(snapshot)?.activeThemeIds ?? []).filter((id) => !ownKnown.has(id)),
    ...(options.foundation && options.foundation !== snapshot
      ? productFoundationThemeIds(snapshot, options.foundation).filter(
          (id) => !foundationKnown.has(id),
        )
      : []),
  ]) {
    diagnostics.push({
      code: "combination_unknown_active_theme",
      message: `Active theme id is not defined in any token library: ${themeId}`,
      themeId,
    });
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
function validateWorkbenchCombination(snapshot, combination, options = {}) {
  const { diagnostics: enumerationDiagnostics, domains } =
    enumerateWorkbenchCombinations(snapshot, options);
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

// Raw/alias/resolved/source rows over an already-built preview snapshot;
// with a Foundation, its Tokens read from their own Package.
function previewTokenRows(previewSnapshot, foundation) {
  return listEffectiveTokens(previewSnapshot, { foundation }).map((effective) => {
    const token = effective.token;
    const owner =
      foundation && effective.sourcePackageId === foundation.manifest.packageId
        ? foundation
        : previewSnapshot;
    const home = homeSetOf(owner, token) ?? {
      setId: null,
      setName: null,
    };
    const raw = rawValueOf(owner, token);
    return {
      alias: aliasPathOf(raw),
      homeSetId: home.setId,
      homeSetName: home.setName,
      ownerPackageId: owner.manifest.packageId,
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
export async function createWorkbenchPreview(snapshot, combination, options = {}) {
  const { diagnostics } = validateWorkbenchCombination(snapshot, combination, options);
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
  const enumeration = enumerateWorkbenchCombinations(snapshot, options);
  if (options.foundation && options.foundation !== snapshot) {
    // A Product observes Product and Foundation themes alike through a
    // read-only theme view; nothing is written.
    const paths = (combination ?? []).map((selection) => {
      const domain = enumeration.domains.find(
        (candidate) => candidate.domainId === selection.domainId,
      );
      const variant = domain.variants.find(
        (candidate) =>
          candidate.themeId === selection.themeId &&
          (selection.packageId === undefined || candidate.packageId === selection.packageId),
      );
      return `${domain.domain}/${variant.name}`;
    });
    const view = selectTokenThemes(
      { foundation: options.foundation, product: snapshot },
      paths,
    );
    return {
      combination: (combination ?? []).map((selection) => ({ ...selection })),
      preview: view.product,
      tokens: previewTokenRows(view.product, view.foundation),
    };
  }
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

