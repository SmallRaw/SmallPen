import { SMALLPEN_FORMAT_CAPABILITIES } from "./capabilities.mjs";
import { fail } from "./errors.mjs";

const TOKEN_TYPES = new Set([
  ...SMALLPEN_FORMAT_CAPABILITIES.canonicalPackage.tokenTypes,
  "dimension",
]);
const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assetReference(value, path) {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    typeof value.assetId !== "string" ||
    value.assetId.length === 0 ||
    typeof value.packageId !== "string" ||
    !value.packageId.startsWith("pkg_") ||
    !ID_PATTERN.test(value.packageId)
  ) {
    fail("invalid_asset_reference", `${path} must contain Package and asset ids`, {
      path,
    });
  }
  return structuredClone(value);
}

function stringRecord(value, path) {
  if (!isRecord(value)) {
    fail("invalid_token_context_rule", `${path} must contain an object`, {
      path,
    });
  }
  for (const [field, child] of Object.entries(value)) {
    if (
      field.length === 0 ||
      typeof child !== "string" ||
      child.length === 0
    ) {
      fail(
        "invalid_token_context_rule",
        `${path} must map Axis ids to value ids`,
        { path },
      );
    }
  }
  return structuredClone(value);
}

function extension(value, path) {
  const extensions = value.$extensions;
  const smallpen = isRecord(extensions) ? extensions.smallpen : undefined;
  if (!isRecord(smallpen)) {
    fail(
      "missing_token_id",
      `${path} requires $extensions.smallpen.id`,
      { path: `${path}.$extensions.smallpen.id` },
    );
  }
  const fields = new Set([
    "contextValues",
    "deprecated",
    "draft",
    "id",
    "overrideOf",
    "replacement",
    "visibility",
  ]);
  const unsupported = Object.keys(smallpen).filter((field) => !fields.has(field));
  if (unsupported.length > 0) {
    fail(
      "unsupported_token_extension",
      `${path} contains unsupported SmallPen extension field ${unsupported[0]}`,
      { fields: unsupported, path: `${path}.$extensions.smallpen` },
    );
  }
  if (
    typeof smallpen.id !== "string" ||
    !smallpen.id.startsWith("tok_") ||
    !ID_PATTERN.test(smallpen.id)
  ) {
    fail("invalid_token_id", `${path} requires a permanent tok_ id`, {
      path: `${path}.$extensions.smallpen.id`,
      value: smallpen.id,
    });
  }
  if (
    smallpen.visibility !== undefined &&
    smallpen.visibility !== "private" &&
    smallpen.visibility !== "public"
  ) {
    fail("invalid_token_visibility", `${path} visibility is invalid`, {
      path: `${path}.$extensions.smallpen.visibility`,
    });
  }
  for (const field of ["deprecated", "draft"]) {
    if (smallpen[field] !== undefined && typeof smallpen[field] !== "boolean") {
      fail("invalid_token_extension", `${path} ${field} must be boolean`, {
        path: `${path}.$extensions.smallpen.${field}`,
      });
    }
  }
  let contextValues = [];
  if (smallpen.contextValues !== undefined) {
    if (!Array.isArray(smallpen.contextValues)) {
      fail(
        "invalid_token_context_values",
        `${path} contextValues must be an array`,
        { path: `${path}.$extensions.smallpen.contextValues` },
      );
    }
    contextValues = smallpen.contextValues.map((candidate, index) => {
      const candidatePath =
        `${path}.$extensions.smallpen.contextValues[${index}]`;
      if (
        !isRecord(candidate) ||
        Object.keys(candidate).length !== 2 ||
        !Object.hasOwn(candidate, "value") ||
        !Object.hasOwn(candidate, "when")
      ) {
        fail(
          "invalid_token_context_value",
          `${candidatePath} requires value and when`,
          { path: candidatePath },
        );
      }
      return {
        value: structuredClone(candidate.value),
        when: stringRecord(candidate.when, `${candidatePath}.when`),
      };
    });
  }
  return {
    contextValues,
    deprecated: smallpen.deprecated === true,
    draft: smallpen.draft === true,
    id: smallpen.id,
    overrideOf: assetReference(
      smallpen.overrideOf,
      `${path}.$extensions.smallpen.overrideOf`,
    ),
    replacement: assetReference(
      smallpen.replacement,
      `${path}.$extensions.smallpen.replacement`,
    ),
    visibility: smallpen.visibility === "private" ? "private" : "public",
  };
}

export function tokenAliasPath(value) {
  if (typeof value !== "string") return null;
  return /^\{([^{}]+)\}$/.exec(value)?.[1] ?? null;
}

export function tokenValueMatchesType(value, type) {
  if (type === "color") {
    return (
      (typeof value === "string" && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) ||
      (isRecord(value) &&
        String(value.colorSpace).toLowerCase() === "srgb" &&
        Array.isArray(value.components) &&
        value.components.length === 3 &&
        value.components.every(
          (component) =>
            typeof component === "number" &&
            Number.isFinite(component) &&
            component >= 0 &&
            component <= 1,
        ) &&
        (value.alpha === undefined ||
          (typeof value.alpha === "number" &&
            Number.isFinite(value.alpha) &&
            value.alpha >= 0 &&
            value.alpha <= 1)))
    );
  }
  if (
    new Set([
      "border-radius",
      "dimension",
      "dimensions",
      "font-size",
      "letter-spacing",
      "number",
      "rotation",
      "sizing",
      "spacing",
      "stroke-width",
    ]).has(type)
  ) {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (type === "opacity") {
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 1
    );
  }
  if (type === "boolean") return typeof value === "boolean";
  if (
    new Set([
      "font-family",
      "font-weight",
      "other",
      "string",
      "text-case",
      "text-decoration",
    ]).has(type)
  ) {
    return typeof value === "string" ||
      (type === "font-weight" && typeof value === "number");
  }
  if (type === "typography") {
    return (
      isRecord(value) &&
      typeof value.fontFamily === "string" &&
      typeof value.fontSize === "number" &&
      Number.isFinite(value.fontSize) &&
      typeof value.fontWeight === "number" &&
      Number.isFinite(value.fontWeight)
    );
  }
  if (type === "shadow") return isRecord(value) || Array.isArray(value);
  return value !== undefined;
}

function visitDtcgGroup(value, segments, inheritedType, filePath, state) {
  const declaredType =
    typeof value.$type === "string" ? value.$type : inheritedType;
  for (const [name, child] of Object.entries(value)) {
    if (name.startsWith("$")) continue;
    if (!isRecord(child)) {
      fail(
        "invalid_token_group",
        `${filePath}:${[...segments, name].join(".")} must contain an object`,
      );
    }
    const pathSegments = [...segments, name];
    const tokenPath = pathSegments.join(".");
    const semanticPath = `${filePath}:${tokenPath}`;
    const smallpen = child.$extensions?.smallpen;
    const hasContextValues =
      isRecord(smallpen) && Array.isArray(smallpen.contextValues);
    if (Object.hasOwn(child, "$value") || hasContextValues) {
      const type = typeof child.$type === "string" ? child.$type : declaredType;
      if (!TOKEN_TYPES.has(type)) {
        fail("invalid_token_type", `Unsupported token type at ${semanticPath}`, {
          path: `${semanticPath}.$type`,
          type,
        });
      }
      const metadata = extension(child, semanticPath);
      if (state.tokens.has(metadata.id)) {
        fail("duplicate_token_id", `Duplicate Token id: ${metadata.id}`, {
          path: semanticPath,
          tokenId: metadata.id,
        });
      }
      if (state.byPath.has(tokenPath)) {
        fail("duplicate_token_path", `Duplicate Token path: ${tokenPath}`, {
          path: semanticPath,
        });
      }
      const token = {
        contextValues: metadata.contextValues,
        deprecated: metadata.deprecated,
        description:
          typeof child.$description === "string" ? child.$description : undefined,
        draft: metadata.draft,
        filePath,
        group: segments.join("."),
        id: metadata.id,
        overrideOf: metadata.overrideOf,
        path: tokenPath,
        rawValue: Object.hasOwn(child, "$value")
          ? structuredClone(child.$value)
          : undefined,
        replacement: metadata.replacement,
        type,
        visibility: metadata.visibility,
      };
      state.tokens.set(token.id, token);
      state.byPath.set(token.path, token);
      continue;
    }
    visitDtcgGroup(child, pathSegments, declaredType, filePath, state);
  }
}

function addPenpotLibraryTokens(library, filePath, state) {
  for (const tokenSet of library.sets) {
    for (const tokenValue of tokenSet.tokens) {
      const token = {
        contextValues: [],
        deprecated: false,
        description: tokenValue.description,
        draft: false,
        filePath,
        group: tokenSet.name,
        id: tokenValue.id,
        overrideOf: undefined,
        path: tokenValue.name,
        rawValue: structuredClone(tokenValue.value),
        replacement: undefined,
        type: tokenValue.type,
        visibility: "public",
      };
      if (state.tokens.has(token.id)) {
        fail("duplicate_token_id", `Duplicate Token id: ${token.id}`, {
          path: filePath,
          tokenId: token.id,
        });
      }
      state.tokens.set(token.id, token);
      // Aliases ("{group.token}") resolve by path. Penpot libraries allow the
      // same token name in several sets, so the first occurrence wins rather
      // than failing the whole library.
      if (!state.byPath.has(token.path)) {
        state.byPath.set(token.path, token);
      }
    }
  }
}

function resolveBaseToken(token, byPath, visiting) {
  if (token.resolvedValue !== undefined) return token.resolvedValue;
  if (token.rawValue === undefined) return undefined;
  if (visiting.has(token.id)) {
    fail("token_alias_cycle", `Token alias cycle includes ${token.path}`, {
      path: token.path,
      tokenId: token.id,
    });
  }
  const alias = tokenAliasPath(token.rawValue);
  let resolved = token.rawValue;
  if (alias) {
    const target = byPath.get(alias);
    if (!target) {
      fail("missing_token_alias", `Missing Token alias: ${alias}`, {
        path: token.path,
      });
    }
    if (target.type !== token.type) {
      fail(
        "token_alias_type_mismatch",
        `Token alias type does not match ${target.path}`,
        { path: token.path },
      );
    }
    visiting.add(token.id);
    resolved = resolveBaseToken(target, byPath, visiting);
    visiting.delete(token.id);
  }
  if (!tokenValueMatchesType(resolved, token.type)) {
    fail("invalid_token_value", `Value does not match Token type at ${token.path}`, {
      path: token.path,
      tokenId: token.id,
      type: token.type,
    });
  }
  token.resolvedValue = structuredClone(resolved);
  return token.resolvedValue;
}

export function parseTokenEntries(manifest, entries) {
  const state = { byPath: new Map(), tokens: new Map() };
  for (const entry of manifest.entries.tokens) {
    const value = entries[entry];
    if (!isRecord(value)) {
      fail("invalid_token_file", `${entry} must contain an object`, { entry });
    }
    if (Array.isArray(value.sets) && Array.isArray(value.themes)) {
      addPenpotLibraryTokens(value, entry, state);
    } else {
      visitDtcgGroup(value, [], undefined, entry, state);
    }
  }
  for (const token of state.tokens.values()) {
    for (const [index, contextual] of token.contextValues.entries()) {
      if (!tokenValueMatchesType(contextual.value, token.type)) {
        fail(
          "invalid_token_context_value",
          `Context value does not match Token type at ${token.path}`,
          {
            index,
            path: `${token.path}.contextValues[${index}].value`,
            tokenId: token.id,
            type: token.type,
          },
        );
      }
    }
    if (token.rawValue !== undefined) {
      resolveBaseToken(token, state.byPath, new Set());
    } else if (!token.overrideOf || token.contextValues.length === 0) {
      fail(
        "missing_token_value",
        `Token ${token.path} requires a base value or Context values for an override`,
        { path: token.path, tokenId: token.id },
      );
    }
  }
  return state.tokens;
}
