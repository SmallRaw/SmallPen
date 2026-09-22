import { combineContextAxes, resolveContext } from "./contexts.mjs";
import { fail } from "./errors.mjs";
import { tokenAliasPath, tokenValueMatchesType } from "./tokens-domain.mjs";

function contextualDefinition(token, context, axes) {
  for (const [index, candidate] of token.contextValues.entries()) {
    for (const [axisId, valueId] of Object.entries(candidate.when)) {
      const axis = axes.get(axisId);
      if (!axis || !axis.values.some(({ id }) => id === valueId)) {
        fail(
          "invalid_token_context_rule",
          "Token Context rule references an unknown Axis or value",
          {
            axisId,
            path: `${token.path}.contextValues[${index}].when.${axisId}`,
            tokenId: token.id,
            valueId,
          },
        );
      }
    }
  }
  const matches = token.contextValues
    .filter((candidate) =>
      Object.entries(candidate.when).every(
        ([axisId, valueId]) => context[axisId] === valueId,
      ),
    )
    .sort(
      (left, right) =>
        Object.keys(right.when).length - Object.keys(left.when).length,
    );
  if (matches.length > 0) {
    const specificity = Object.keys(matches[0].when).length;
    const equallySpecific = matches.filter(
      (candidate) => Object.keys(candidate.when).length === specificity,
    );
    if (equallySpecific.length > 1) {
      fail(
        "ambiguous_token_context_rule",
        `Equally specific Token Context rules match ${token.path}`,
        {
          path: `${token.path}.contextValues`,
          specificity,
          tokenId: token.id,
        },
      );
    }
    return {
      found: true,
      rule: structuredClone(matches[0].when),
      specificity,
      value: structuredClone(matches[0].value),
    };
  }
  return token.rawValue === undefined
    ? { found: false, rule: null, specificity: -1 }
    : {
        found: true,
        rule: null,
        specificity: 0,
        value: structuredClone(token.rawValue),
      };
}

function penpotTokenEntry(snapshot) {
  return snapshot.manifest.entries.tokens.find((entry) => {
    const value = snapshot.entries[entry];
    return Array.isArray(value?.sets) && Array.isArray(value?.themes);
  });
}

function tokenPathIndex(snapshot) {
  const result = new Map();
  const entry = penpotTokenEntry(snapshot);
  if (entry) {
    const library = snapshot.entries[entry];
    const activeSetIds = new Set(
      library.activeThemeIds.length > 0
        ? library.themes
            .filter(({ id }) => library.activeThemeIds.includes(id))
            .flatMap(({ setIds }) => setIds)
        : library.activeSetIds,
    );
    for (const tokenSet of library.sets) {
      if (!activeSetIds.has(tokenSet.id)) continue;
      for (const token of tokenSet.tokens) {
        result.set(token.name, snapshot.domain.tokens.get(token.id));
      }
    }
  }
  for (const token of snapshot.domain.tokens.values()) {
    if (token.filePath !== entry && !result.has(token.path)) {
      result.set(token.path, token);
    }
  }
  return result;
}

function tokenByPath(snapshot, path, byPath) {
  return byPath.get(path) ??
    [...snapshot.domain.tokens.values()].find(
      (candidate) => candidate.path === path,
    );
}

function activeTargetToken(owner, token, byPath) {
  return token?.filePath === penpotTokenEntry(owner)
    ? (byPath.get(token.path) ?? token)
    : token;
}

function contextualTokenValue(token, owner, context, axes, visiting, byPath) {
  if (visiting.has(token.id)) {
    fail("token_alias_cycle", `Token alias cycle includes ${token.path}`, {
      path: token.path,
      tokenId: token.id,
    });
  }
  const definition = contextualDefinition(token, context, axes);
  if (!definition.found) return { ...definition, value: undefined };
  const alias = tokenAliasPath(definition.value);
  let value = definition.value;
  if (alias) {
    const target = tokenByPath(owner, alias, byPath);
    if (!target) {
      fail("missing_token_alias", `Missing Token alias: ${alias}`, {
        path: token.path,
        tokenId: token.id,
      });
    }
    if (target.type !== token.type) {
      fail(
        "token_alias_type_mismatch",
        `Token alias type does not match ${target.path}`,
        { path: token.path, tokenId: token.id },
      );
    }
    visiting.add(token.id);
    value = contextualTokenValue(
      target,
      owner,
      context,
      axes,
      visiting,
      byPath,
    ).value;
    visiting.delete(token.id);
  }
  if (!tokenValueMatchesType(value, token.type)) {
    fail(
      "invalid_token_value",
      "Value does not match Token type in the selected Context",
      { path: token.path, tokenId: token.id, type: token.type },
    );
  }
  return { ...definition, value: structuredClone(value) };
}

function overrideForReference(product, reference) {
  const overrides = [...product.domain.tokens.values()].filter(
    (token) =>
      token.overrideOf?.packageId === reference.packageId &&
      token.overrideOf.assetId === reference.assetId,
  );
  if (overrides.length > 1) {
    fail(
      "duplicate_product_token_override",
      `More than one Product Token overrides ${reference.assetId}`,
      { path: reference.assetId, tokenIds: overrides.map(({ id }) => id) },
    );
  }
  return overrides[0];
}

function tokenOwner(product, foundation, libraries, reference) {
  if (reference.packageId === product.manifest.packageId) return product;
  if (foundation?.manifest.packageId === reference.packageId) return foundation;
  return libraries.find(
    (library) => library.manifest.packageId === reference.packageId,
  );
}

function resolveInternal(product, reference, options = {}) {
  if (
    !reference ||
    typeof reference.packageId !== "string" ||
    typeof reference.assetId !== "string"
  ) {
    fail("invalid_asset_reference", "Token reference requires Package and asset ids");
  }
  const foundation = options.foundation;
  const libraries = options.libraries ?? [];
  const owner = tokenOwner(product, foundation, libraries, reference);
  const ownerTokensByPath = owner ? tokenPathIndex(owner) : new Map();
  const targetToken = owner
    ? activeTargetToken(
        owner,
        owner.domain.tokens.get(reference.assetId),
        ownerTokensByPath,
      )
    : undefined;
  const axes = combineContextAxes(product, foundation);
  const context = resolveContext(product, foundation, options.context ?? {});
  if (
    !owner ||
    !targetToken ||
    (owner !== product && targetToken.visibility !== "public")
  ) {
    return {
      candidates: [],
      context,
      resolution: null,
      status: "missing",
      target: structuredClone(reference),
    };
  }
  const candidates = [];
  if (owner !== product) {
    const override = overrideForReference(product, reference);
    if (override) {
      if (override.type !== targetToken.type) {
        fail(
          "product_token_override_type_mismatch",
          "Product Token Override type must match its Foundation Token",
          { path: override.path, tokenId: override.id },
        );
      }
      const contextual = contextualTokenValue(
        override,
        product,
        context,
        axes,
        new Set(),
        tokenPathIndex(product),
      );
      candidates.push({
        layer: "product",
        matched: contextual.found,
        ...(!contextual.found ? { reason: "no-compatible-context-value" } : {}),
        rule: contextual.rule,
        specificity: contextual.specificity,
        tokenId: override.id,
      });
      if (contextual.found) {
        return {
          candidates,
          context,
          resolution: {
            context,
            sourceChain: [
              {
                packageId: owner.manifest.packageId,
                role: "target",
                tokenId: targetToken.id,
              },
              {
                packageId: product.manifest.packageId,
                role: "override",
                tokenId: override.id,
              },
            ],
            sourcePackageId: product.manifest.packageId,
            sourceTokenId: override.id,
            target: structuredClone(reference),
            token: {
              ...structuredClone(override),
              resolvedValue: structuredClone(contextual.value),
            },
            value: structuredClone(contextual.value),
          },
          status: "resolved",
          target: structuredClone(reference),
        };
      }
    }
  }
  const contextual = contextualTokenValue(
    targetToken,
    owner,
    context,
    axes,
    new Set(),
    ownerTokensByPath,
  );
  candidates.push({
    layer:
      owner === product
        ? "product"
        : owner === foundation
          ? "foundation"
          : "library",
    matched: contextual.found,
    ...(!contextual.found ? { reason: "no-compatible-context-value" } : {}),
    rule: contextual.rule,
    specificity: contextual.specificity,
    tokenId: targetToken.id,
  });
  if (!contextual.found) {
    return {
      candidates,
      context,
      resolution: null,
      status: "missing",
      target: structuredClone(reference),
    };
  }
  return {
    candidates,
    context,
    resolution: {
      context,
      sourceChain: [
        {
          packageId: owner.manifest.packageId,
          role: "target",
          tokenId: targetToken.id,
        },
      ],
      sourcePackageId: owner.manifest.packageId,
      sourceTokenId: targetToken.id,
      target: structuredClone(reference),
      token: {
        ...structuredClone(targetToken),
        resolvedValue: structuredClone(contextual.value),
      },
      value: structuredClone(contextual.value),
    },
    status: "resolved",
    target: structuredClone(reference),
  };
}

export function resolveEffectiveToken(product, reference, options = {}) {
  return resolveInternal(product, reference, options).resolution;
}

export function explainEffectiveToken(product, reference, options = {}) {
  return resolveInternal(product, reference, options);
}

export function listEffectiveTokens(product, options = {}) {
  const foundation = options.foundation;
  const libraries = options.libraries ?? [];
  const visibleTargets = (snapshot, publicOnly) => {
    const entry = penpotTokenEntry(snapshot);
    const tokens = [
      ...tokenPathIndex(snapshot).values(),
      ...[...snapshot.domain.tokens.values()].filter(
        (token) => token.filePath !== entry,
      ),
    ];
    return [...new Map(tokens.map((token) => [token.id, token])).values()]
      .filter((token) => !publicOnly || token.visibility === "public")
      .map((token) => ({
        assetId: token.id,
        packageId: snapshot.manifest.packageId,
      }));
  };
  const targets = [
    ...libraries.flatMap((library) => visibleTargets(library, true)),
    ...(foundation
      ? visibleTargets(foundation, true)
      : []),
    ...visibleTargets(product, false).filter(
      ({ assetId }) => !product.domain.tokens.get(assetId).overrideOf,
    ),
  ];
  return targets
    .sort((left, right) =>
      `${left.packageId}/${left.assetId}`.localeCompare(
        `${right.packageId}/${right.assetId}`,
      ),
    )
    .map((reference) => resolveEffectiveToken(product, reference, options))
    .filter(Boolean);
}
