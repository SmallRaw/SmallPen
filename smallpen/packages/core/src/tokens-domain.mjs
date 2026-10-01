import { SMALLPEN_FORMAT_CAPABILITIES } from "./capabilities.mjs";
import { fail } from "./errors.mjs";
import { isRecord, isReservedKey } from "./internal.mjs";

const TOKEN_TYPES = new Set([
  ...SMALLPEN_FORMAT_CAPABILITIES.canonicalPackage.tokenTypes,
  "dimension",
]);
const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

// The $value each Token type accepts, as tokenValueMatchesType checks it.
// Errors and `smallpen schema token-types` print these; a test checks every
// example against tokenValueMatchesType.
export const TOKEN_VALUE_SHAPES = Object.freeze({
  boolean: { example: true, shape: "boolean" },
  "border-radius": { example: 8, shape: "number (px)" },
  color: {
    example: "#6750a4",
    shape: '"#rrggbb" or "#rrggbbaa", or {colorSpace:"srgb", components:[r,g,b] in 0..1, alpha?}',
  },
  dimensions: { example: 16, shape: "number (px)" },
  "font-family": { example: "Inter", shape: "string" },
  "font-size": { example: 16, shape: "number (px), not a string" },
  "font-weight": { example: 700, shape: "number or string" },
  "letter-spacing": { example: 0.5, shape: "number" },
  number: { example: 1.5, shape: "number" },
  opacity: { example: 0.6, shape: "number from 0 to 1" },
  other: { example: "any text", shape: "string" },
  rotation: { example: 45, shape: "number (degrees)" },
  shadow: {
    example: { blur: 8, color: "#00000033", spread: 0, x: 0, y: 2 },
    shape: "object or array of objects",
  },
  sizing: { example: 48, shape: "number (px)" },
  spacing: { example: 16, shape: "number (px)" },
  string: { example: "Label", shape: "string" },
  "stroke-width": { example: 1, shape: "number (px)" },
  "text-case": { example: "uppercase", shape: "string" },
  "text-decoration": { example: "underline", shape: "string" },
  typography: {
    example: { fontFamily: "Inter", fontSize: 24, fontWeight: 700 },
    shape:
      "{fontFamily: string, fontSize: number, fontWeight: number, lineHeight?, letterSpacing?}",
  },
});

function expectedValue(type) {
  const shape = TOKEN_VALUE_SHAPES[type];
  return shape
    ? { expected: shape.shape, example: structuredClone(shape.example) }
    : {};
}

function expectedValueText(type) {
  const shape = TOKEN_VALUE_SHAPES[type];
  return shape
    ? `; ${type} expects ${shape.shape}, for example ${JSON.stringify(shape.example)}`
    : "";
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
      isReservedKey(field) ||
      typeof child !== "string" ||
      child.length === 0
    ) {
      fail(
        "invalid_token_context_rule",
        `${path} must map Axis ids to value ids, for example {"axis_theme":"dark"}`,
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
          `${candidatePath} requires exactly {when: {axisId: valueId}, value}, ` +
            'for example {"when":{"axis_theme":"dark"},"value":"#1c1b1f"}',
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
    if (isReservedKey(name)) {
      fail(
        "invalid_token_path",
        `${filePath}:${[...segments, name].join(".")} uses a reserved name`,
        { path: `${filePath}:${[...segments, name].join(".")}` },
      );
    }
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
        fail(
          "invalid_token_type",
          `Unsupported token type ${JSON.stringify(type ?? null)} at ${semanticPath}. ` +
            `Set $type to one of: ${SMALLPEN_FORMAT_CAPABILITIES.canonicalPackage.tokenTypes.join(", ")}`,
          {
            allowedValues: [...SMALLPEN_FORMAT_CAPABILITIES.canonicalPackage.tokenTypes],
            path: `${semanticPath}.$type`,
            type,
          },
        );
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
      // Penpot libraries allow the same token name in several sets.
      claimTokenPath(state.byPath, token.path, token);
    }
  }
}

// Alias targets resolve by path and the first declaration of a path wins:
// package entry order, then Token Set order. The Package loader and the token
// importer (pruneUnresolvableTokens) share this rule.
export function claimTokenPath(byPath, path, token) {
  if (!byPath.has(path)) byPath.set(path, token);
}

// Follows the alias chain with a loop, so a long chain fails validation
// instead of exhausting the stack.
function resolveBaseToken(token, byPath) {
  const chain = [];
  const visiting = new Set();
  let current = token;
  let value;
  for (;;) {
    if (current.resolvedValue !== undefined) {
      value = current.resolvedValue;
      break;
    }
    if (current.rawValue === undefined) {
      value = undefined;
      break;
    }
    if (visiting.has(current.id)) {
      fail("token_alias_cycle", `Token alias cycle includes ${current.path}`, {
        path: current.path,
        tokenId: current.id,
      });
    }
    visiting.add(current.id);
    chain.push(current);
    const alias = tokenAliasPath(current.rawValue);
    if (!alias) {
      value = current.rawValue;
      break;
    }
    const target = byPath.get(alias);
    if (!target) {
      fail("missing_token_alias", `Missing Token alias: ${alias}`, {
        path: current.path,
      });
    }
    if (target.type !== current.type) {
      fail(
        "token_alias_type_mismatch",
        `Token alias type does not match ${target.path}`,
        { path: current.path },
      );
    }
    current = target;
  }
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const link = chain[index];
    if (!tokenValueMatchesType(value, link.type)) {
      fail(
        "invalid_token_value",
        `Value ${JSON.stringify(value)} does not match Token type at ${link.path}` +
          expectedValueText(link.type),
        { path: link.path, tokenId: link.id, type: link.type, ...expectedValue(link.type) },
      );
    }
    link.resolvedValue = structuredClone(value);
    value = link.resolvedValue;
  }
  return value;
}

function contextValuePath(token, index) {
  return `${token.path}.contextValues[${index}]`;
}

function ruleSize(rule) {
  return Object.keys(rule).length;
}

// Every axis of `inner` is selected with the same value by `outer`.
function ruleWithin(inner, outer) {
  return Object.entries(inner).every(
    ([axisId, valueId]) => outer[axisId] === valueId,
  );
}

function rulesCompatible(left, right) {
  return Object.entries(left).every(
    ([axisId, valueId]) =>
      !Object.hasOwn(right, axisId) || right[axisId] === valueId,
  );
}

// The same checks effective-tokens.mjs applies when it resolves a Context
// value, made once at load for every rule: known Axes and values, and no two
// equally specific rules that some Context selects together without a more
// specific rule taking precedence. A Product also uses the Axes of its
// Foundation, which load separately, so only a Foundation's Axes are checked
// here; resolution checks a Product's rules against the combined Axes.
function validateContextRules(token, manifest, contextAxes) {
  const rules = token.contextValues.map(({ when }) => when);
  const checkAxes = contextAxes !== undefined && manifest.role === "foundation";
  for (const [index, rule] of checkAxes ? rules.entries() : []) {
    for (const [axisId, valueId] of Object.entries(rule)) {
      const axis = contextAxes.get(axisId);
      if (!axis || !axis.values.some(({ id }) => id === valueId)) {
        fail(
          "invalid_token_context_rule",
          "Token Context rule references an unknown Axis or value",
          {
            axisId,
            path: `${contextValuePath(token, index)}.when.${axisId}`,
            tokenId: token.id,
            valueId,
          },
        );
      }
    }
  }
  for (const [leftIndex, left] of rules.entries()) {
    for (const right of rules.slice(leftIndex + 1)) {
      if (ruleSize(left) !== ruleSize(right) || !rulesCompatible(left, right)) {
        continue;
      }
      const both = { ...left, ...right };
      const resolved = rules.some(
        (rule) => ruleSize(rule) > ruleSize(left) && ruleWithin(rule, both),
      );
      if (!resolved) {
        fail(
          "ambiguous_token_context_rule",
          `Equally specific Token Context rules match ${token.path}`,
          {
            path: `${token.path}.contextValues`,
            specificity: ruleSize(left),
            tokenId: token.id,
          },
        );
      }
    }
  }
}

// Context values follow the same alias rules as base values: the target must
// exist and share the Token type.
function validateContextValues(token, byPath) {
  for (const [index, contextual] of token.contextValues.entries()) {
    const path = `${contextValuePath(token, index)}.value`;
    const alias = tokenAliasPath(contextual.value);
    if (alias) {
      const target = byPath.get(alias);
      if (!target) {
        fail("missing_token_alias", `Missing Token alias: ${alias}`, {
          index,
          path,
          tokenId: token.id,
        });
      }
      if (target.type !== token.type) {
        fail(
          "token_alias_type_mismatch",
          `Token alias type does not match ${target.path}`,
          { index, path, tokenId: token.id },
        );
      }
    } else if (!tokenValueMatchesType(contextual.value, token.type)) {
      fail(
        "invalid_token_context_value",
        `Context value ${JSON.stringify(contextual.value)} does not match Token ` +
          `type at ${token.path}${expectedValueText(token.type)}`,
        { index, path, tokenId: token.id, type: token.type, ...expectedValue(token.type) },
      );
    }
  }
}

const MAX_CONTEXT_ALIAS_STATES = 100000;

function ruleKey(rule) {
  return Object.keys(rule)
    .sort()
    .map((axisId) => `${axisId}=${rule[axisId]}`)
    .join("&");
}

// A step from a token to an alias target is possible in a Context that
// satisfies `rule` only when no rule of the token certainly wins over it:
// a base value loses to any rule the Context selects, a Context value loses
// to a more specific rule the Context selects.
function aliasStepShadowed(token, step, rule) {
  if (step.when === null) {
    return token.contextValues.some(({ when }) => ruleWithin(when, rule));
  }
  return token.contextValues.some(
    ({ when }) =>
      ruleSize(when) > ruleSize(step.when) && ruleWithin(when, rule),
  );
}

// Base-only cycles fail in resolveBaseToken. A cycle through a Context value
// exists only in Contexts that select every rule on it, so the walk carries
// the union of the rules it followed and reports a cycle only when that union
// is consistent and every step on the cycle can be taken in it.
function validateContextAliasCycles(tokens, byPath) {
  const steps = new Map();
  const starts = [];
  for (const token of tokens.values()) {
    const tokenSteps = [];
    const baseTarget = byPath.get(tokenAliasPath(token.rawValue));
    if (baseTarget) tokenSteps.push({ target: baseTarget, when: null });
    for (const { value, when } of token.contextValues) {
      const target = byPath.get(tokenAliasPath(value));
      if (target) tokenSteps.push({ target, when });
    }
    steps.set(token.id, tokenSteps);
    if (tokenSteps.some(({ when }) => when !== null)) starts.push(token);
  }
  const done = new Set();
  let budget = MAX_CONTEXT_ALIAS_STATES;
  for (const start of starts) {
    const startKey = `${start.id}\0`;
    if (done.has(startKey)) continue;
    // Each frame: a state on the current path and the next step to try.
    const path = [
      { key: startKey, next: 0, rule: {}, step: null, token: start },
    ];
    const onPath = new Map([[startKey, 0]]);
    while (path.length > 0) {
      const frame = path.at(-1);
      const tokenSteps = steps.get(frame.token.id);
      if (frame.next >= tokenSteps.length) {
        path.pop();
        onPath.delete(frame.key);
        done.add(frame.key);
        continue;
      }
      const step = tokenSteps[frame.next];
      frame.next += 1;
      if (step.when !== null && !rulesCompatible(step.when, frame.rule)) {
        continue;
      }
      const rule =
        step.when === null ? frame.rule : { ...frame.rule, ...step.when };
      if (aliasStepShadowed(frame.token, step, rule)) continue;
      const key = `${step.target.id}\0${ruleKey(rule)}`;
      if (onPath.has(key)) {
        // Steps around the cycle and the tokens they leave from.
        const first = onPath.get(key);
        const cycle = [
          ...path.slice(first + 1),
          { step, token: step.target },
        ];
        const sources = path.slice(first);
        const feasible = cycle.every(
          (entry, index) =>
            !aliasStepShadowed(sources[index].token, entry.step, rule),
        );
        if (feasible) {
          fail(
            "token_alias_cycle",
            `Token alias cycle includes ${step.target.path}`,
            { path: step.target.path, tokenId: step.target.id },
          );
        }
        continue;
      }
      if (done.has(key)) continue;
      budget -= 1;
      // Resolution still detects cycles; stop proving at load past the bound.
      if (budget < 0) return;
      onPath.set(key, path.length);
      path.push({ key, next: 0, rule, step, token: step.target });
    }
  }
}

// contextAxes: the Package's own Context Axes. Without them, rules are not
// checked against Axes.
export function parseTokenEntries(manifest, entries, contextAxes) {
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
    validateContextRules(token, manifest, contextAxes);
    validateContextValues(token, state.byPath);
    if (token.rawValue !== undefined) {
      resolveBaseToken(token, state.byPath);
    } else if (!token.overrideOf || token.contextValues.length === 0) {
      fail(
        "missing_token_value",
        `Token ${token.path} requires a base value or Context values for an override`,
        { path: token.path, tokenId: token.id },
      );
    }
  }
  validateContextAliasCycles(state.tokens, state.byPath);
  return state.tokens;
}
