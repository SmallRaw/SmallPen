import { canonicalJSON } from "./canonical.mjs";
import { SMALLPEN_FORMAT_CAPABILITIES } from "./capabilities.mjs";
import { fail } from "./errors.mjs";
import { normalizeShadowValue } from "./shadows.mjs";
import {
  assertValueDepth,
  compareStrings,
  isRecord,
  isTokenName,
} from "./internal.mjs";
import {
  claimTokenPath,
  tokenAliasPath,
  tokenValueMatchesType,
} from "./tokens-domain.mjs";

// Import a DTCG token document (Penpot / Tokens Studio export, single-set,
// multi-set, or legacy value/type form) into the Penpot-shaped Token Library
// (Form A) that the Package stores and the workspace projection reads.
//
// Identity is by name: a Token Set keeps its id when its name matches, a Token
// keeps its id when its (set name, token name) matches, a Theme keeps its id
// when its group/name matches. Nothing else is tracked between imports; the
// reviewer decides per row from the diff.

const TOKEN_TYPES = new Set(
  SMALLPEN_FORMAT_CAPABILITIES.canonicalPackage.tokenTypes,
);

// DTCG / Tokens Studio "$type" → SmallPen (Penpot-internal) type. Mirrors
// dtcg-token-type->token-type in common/src/app/common/types/token.cljc,
// including the singular spellings Penpot accepts for backwards compatibility.
const DTCG_TYPE_TO_TOKEN_TYPE = new Map([
  ["boolean", "boolean"],
  ["borderRadius", "border-radius"],
  ["borderWidth", "stroke-width"],
  ["boxShadow", "shadow"],
  ["color", "color"],
  ["dimension", "dimensions"],
  ["fontFamilies", "font-family"],
  ["fontFamily", "font-family"],
  ["fontSize", "font-size"],
  ["fontSizes", "font-size"],
  ["fontWeight", "font-weight"],
  ["fontWeights", "font-weight"],
  ["letterSpacing", "letter-spacing"],
  ["number", "number"],
  ["opacity", "opacity"],
  ["other", "other"],
  ["rotation", "rotation"],
  ["shadow", "shadow"],
  ["sizing", "sizing"],
  ["spacing", "spacing"],
  ["string", "string"],
  ["textCase", "text-case"],
  ["textDecoration", "text-decoration"],
  ["typography", "typography"],
]);

export function normalizeTokenType(type) {
  if (typeof type !== "string") return undefined;
  if (DTCG_TYPE_TO_TOKEN_TYPE.has(type)) return DTCG_TYPE_TO_TOKEN_TYPE.get(type);
  // SmallPen's own type names (already Penpot-internal) pass through.
  if (TOKEN_TYPES.has(type)) return type;
  return undefined;
}

const LENGTH_TOKEN_TYPES = new Set([
  "border-radius",
  "dimension",
  "dimensions",
  "font-size",
  "letter-spacing",
  "sizing",
  "spacing",
  "stroke-width",
]);
const NUMBER_TOKEN_TYPES = new Set([
  ...LENGTH_TOKEN_TYPES,
  "number",
  "opacity",
  "rotation",
]);

// Penpot stores and exports numeric values as strings ("8", "16px") and
// accepts 3- and 4-digit hex colors. The Package loader requires numbers and
// 6- or 8-digit hex, so convert the forms that lose nothing; px is Penpot's
// unit for lengths. Everything else is kept and judged by the loader rules.
function normalizeTokenValue(type, value) {
  // Tokens Studio writes shadow offsets as x/y; SmallPen and Penpot use
  // offsetX/offsetY.
  if (type === "shadow") return normalizeShadowValue(value);
  if (typeof value !== "string") return value;
  if (NUMBER_TOKEN_TYPES.has(type)) {
    const match = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))(px)?\s*$/.exec(value);
    if (match && (match[2] === undefined || LENGTH_TOKEN_TYPES.has(type))) {
      return Number(match[1]);
    }
    return value;
  }
  if (type === "color") {
    const match = /^#([0-9a-f]{3,4})$/i.exec(value.trim());
    if (match) {
      return `#${[...match[1]].map((digit) => digit + digit).join("")}`;
    }
  }
  return value;
}

function isDtcgLeaf(node) {
  return isRecord(node) && Object.hasOwn(node, "$value");
}

function isLegacyLeaf(node) {
  return (
    isRecord(node) &&
    !Object.hasOwn(node, "$value") &&
    Object.hasOwn(node, "value") &&
    typeof node.type === "string"
  );
}

// Flatten one set's nested group tree into tokens named "group.sub.token".
// A group-level "$type" is inherited by leaves without their own, per the
// DTCG Format Module.
function flattenSet(tree, setName, warnings) {
  const tokens = [];
  const names = new Set();
  const walk = (node, segments, inheritedType) => {
    const groupType =
      typeof node.$type === "string" ? node.$type : inheritedType;
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith("$") || !isRecord(child)) continue;
      const path = [...segments, key];
      const name = path.join(".");
      if (isDtcgLeaf(child) || isLegacyLeaf(child)) {
        const dtcg = isDtcgLeaf(child);
        const rawType = dtcg ? child.$type : child.type;
        const rawValue = dtcg ? child.$value : child.value;
        const rawDescription = dtcg ? child.$description : child.description;
        const sourceType = typeof rawType === "string" ? rawType : groupType;
        const type = normalizeTokenType(sourceType);
        if (type === undefined) {
          warnings.push({
            code: "unsupported_token_type",
            name,
            set: setName,
            type: sourceType ?? null,
          });
          continue;
        }
        if (!isTokenName(name)) {
          warnings.push({ code: "invalid_token_name", name, set: setName });
          continue;
        }
        // "a.b" as one key and as a nested group name the same token. The
        // first wins, as it does for alias targets (claimTokenPath).
        if (names.has(name)) {
          warnings.push({ code: "duplicate_token_name", name, set: setName });
          continue;
        }
        names.add(name);
        // A token cannot also be a group; Penpot ignores such children too.
        const ignored = Object.entries(child)
          .filter(
            ([childKey, value]) =>
              !childKey.startsWith("$") &&
              !(!dtcg && ["description", "type", "value"].includes(childKey)) &&
              isRecord(value),
          )
          .map(([childKey]) => childKey);
        if (ignored.length > 0) {
          warnings.push({
            children: ignored,
            code: "token_children_ignored",
            name,
            set: setName,
          });
        }
        tokens.push({
          description:
            typeof rawDescription === "string" ? rawDescription : "",
          name,
          type,
          value: normalizeTokenValue(type, structuredClone(rawValue)),
        });
        continue;
      }
      walk(child, path, groupType);
    }
  };
  walk(tree, [], undefined);
  return tokens;
}

function themePath(group, name) {
  return `${group}/${name}`;
}

// Parse a token document into a neutral shape: sets (in tokenSetOrder), themes,
// and activation, plus per-token warnings for what was skipped.
export function parseTokenDocument(documentValue, options = {}) {
  if (!isRecord(documentValue)) {
    fail("invalid_token_document", "Token import requires a JSON object");
  }
  // The walks below recurse; bound them before they start.
  assertValueDepth(documentValue, "token document");
  const warnings = [];
  const multiSet =
    Object.hasOwn(documentValue, "$themes") ||
    Object.hasOwn(documentValue, "$metadata");
  let sets;
  if (multiSet) {
    sets = Object.entries(documentValue)
      .filter(([key, value]) => !key.startsWith("$") && isRecord(value))
      .filter(([name]) => {
        // validateTokenLibrary rejects these names; skip the set instead.
        if (name.length > 0 && name.trim() === name) return true;
        warnings.push({ code: "invalid_token_set_name", set: name });
        return false;
      })
      .map(([name, tree]) => ({ name, tokens: flattenSet(tree, name, warnings) }));
  } else {
    const name =
      typeof options.setName === "string" && options.setName.trim().length > 0
        ? options.setName.trim()
        : "Imported";
    sets = [{ name, tokens: flattenSet(documentValue, name, warnings) }];
  }
  const metadata = isRecord(documentValue.$metadata) ? documentValue.$metadata : {};
  const order = Array.isArray(metadata.tokenSetOrder) ? metadata.tokenSetOrder : [];
  const rank = new Map(order.map((name, index) => [name, index]));
  sets = sets
    .map((set, index) => ({ index, set }))
    .sort((left, right) => {
      const l = rank.has(left.set.name)
        ? rank.get(left.set.name)
        : order.length + left.index;
      const r = rank.has(right.set.name)
        ? rank.get(right.set.name)
        : order.length + right.index;
      return l - r;
    })
    .map(({ set }) => set);
  const themes = (Array.isArray(documentValue.$themes) ? documentValue.$themes : [])
    .filter(isRecord)
    .map((theme) => ({
      description: typeof theme.description === "string" ? theme.description : "",
      externalId: typeof theme.id === "string" ? theme.id : "",
      group: typeof theme.group === "string" ? theme.group : "",
      isSource: theme.isSource === true || theme["is-source"] === true,
      name: typeof theme.name === "string" ? theme.name : "",
      setNames: isRecord(theme.selectedTokenSets)
        ? Object.entries(theme.selectedTokenSets)
            .filter(([, state]) => state === "enabled" || state === "source")
            .map(([name]) => name)
        : [],
    }))
    .filter((theme) => theme.name.length > 0)
    .filter((theme, index, all) => {
      const path = themePath(theme.group, theme.name);
      if (
        all.findIndex((other) => themePath(other.group, other.name) === path) ===
        index
      ) {
        return true;
      }
      warnings.push({ code: "duplicate_token_theme", theme: path });
      return false;
    });
  // References to sets or themes the document does not define are dropped
  // when the library is built; say so here.
  const setNames = new Set(sets.map((set) => set.name));
  for (const theme of themes) {
    for (const name of theme.setNames) {
      if (!setNames.has(name)) {
        warnings.push({
          code: "missing_theme_set",
          set: name,
          theme: themePath(theme.group, theme.name),
        });
      }
    }
  }
  const strings = (value) =>
    Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  const activeSets = strings(metadata.activeSets);
  const activeThemes = strings(metadata.activeThemes);
  for (const name of activeSets) {
    if (!setNames.has(name)) {
      warnings.push({ code: "missing_active_set", set: name });
    }
  }
  const themePaths = new Set(
    themes.map((theme) => themePath(theme.group, theme.name)),
  );
  for (const path of activeThemes) {
    if (!themePaths.has(path)) {
      warnings.push({ code: "missing_active_theme", theme: path });
    }
  }
  const parsed = {
    activeSets,
    activeThemes,
    sets,
    themes,
    warnings,
  };
  if (sets.every((set) => set.tokens.length === 0) && themes.length === 0) {
    fail(
      "no_tokens_found",
      "No tokens, sets, or themes were found in the document",
      { warnings },
    );
  }
  return parsed;
}

function slugId(prefix, ...parts) {
  const body = parts
    .join("_")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${prefix}${body.length > 0 ? body : "item"}`;
}

function claimUnique(preferred, used) {
  let candidate = preferred;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${preferred}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function previousIndex(previous) {
  const sets = new Map();
  const tokens = new Map();
  const themes = new Map();
  for (const set of previous?.sets ?? []) {
    sets.set(set.name, set);
    for (const token of set.tokens) {
      tokens.set(`${set.name}\0${token.name}`, token);
    }
  }
  for (const theme of previous?.themes ?? []) {
    themes.set(themePath(theme.group, theme.name), theme);
  }
  return { sets, themes, tokens };
}

// Build a Form A Token Library from a parsed document, reusing ids from the
// previous library wherever a set, token, or theme matches by name. Reused ids
// are reserved first so a fresh slug can never displace an existing identity.
export function buildTokenLibrary(parsed, previous = null, options = {}) {
  const prior = previousIndex(previous);
  const usedSetIds = new Set();
  const usedTokenIds = new Set(options.reservedTokenIds ?? []);
  const usedThemeIds = new Set();
  const setIds = new Map();
  const tokenIds = new Map();
  const themeIds = new Map();
  // Every prior id stays reserved, also for rows the document dropped: an
  // unselected removal keeps such a row, so a fresh slug must never take its
  // id (applyTokenSelection).
  for (const set of previous?.sets ?? []) {
    usedSetIds.add(set.id);
    for (const token of set.tokens) usedTokenIds.add(token.id);
  }
  for (const theme of previous?.themes ?? []) usedThemeIds.add(theme.id);
  // A token that only moved to another set keeps its id, so bindings to it
  // survive: its name left exactly one prior row and arrives in exactly one
  // new row.
  const parsedKeys = new Set(
    parsed.sets.flatMap((set) =>
      set.tokens.map((token) => `${set.name}\0${token.name}`),
    ),
  );
  const leftByName = new Map();
  for (const [key, token] of prior.tokens) {
    if (parsedKeys.has(key)) continue;
    leftByName.set(token.name, [...(leftByName.get(token.name) ?? []), token]);
  }
  const arrivedByName = new Map();
  for (const set of parsed.sets) {
    for (const token of set.tokens) {
      const key = `${set.name}\0${token.name}`;
      if (prior.tokens.has(key)) continue;
      arrivedByName.set(token.name, [
        ...(arrivedByName.get(token.name) ?? []),
        key,
      ]);
    }
  }
  for (const [name, keys] of arrivedByName) {
    const left = leftByName.get(name) ?? [];
    if (keys.length === 1 && left.length === 1) {
      tokenIds.set(keys[0], left[0].id);
    }
  }
  for (const set of parsed.sets) {
    const priorSet = prior.sets.get(set.name);
    if (priorSet) {
      setIds.set(set.name, priorSet.id);
      usedSetIds.add(priorSet.id);
    }
    for (const token of set.tokens) {
      const key = `${set.name}\0${token.name}`;
      const priorToken = prior.tokens.get(key);
      if (priorToken) {
        tokenIds.set(key, priorToken.id);
        usedTokenIds.add(priorToken.id);
      }
    }
  }
  for (const theme of parsed.themes) {
    const key = themePath(theme.group, theme.name);
    const priorTheme = prior.themes.get(key);
    if (priorTheme) {
      themeIds.set(key, priorTheme.id);
      usedThemeIds.add(priorTheme.id);
    }
  }
  const sets = parsed.sets.map((set) => {
    const id =
      setIds.get(set.name) ?? claimUnique(slugId("tset_", set.name), usedSetIds);
    const tokens = set.tokens.map((token) => {
      const key = `${set.name}\0${token.name}`;
      const tokenId =
        tokenIds.get(key) ??
        claimUnique(slugId("tok_", token.name), usedTokenIds);
      return {
        description: token.description,
        id: tokenId,
        name: token.name,
        type: token.type,
        value: structuredClone(token.value),
      };
    });
    return {
      description: prior.sets.get(set.name)?.description ?? "",
      id,
      name: set.name,
      tokens,
    };
  });
  const setIdByName = new Map(sets.map((set) => [set.name, set.id]));
  const themes = parsed.themes.map((theme) => {
    const key = themePath(theme.group, theme.name);
    const id =
      themeIds.get(key) ??
      claimUnique(slugId("theme_", theme.group, theme.name), usedThemeIds);
    return {
      description: theme.description,
      externalId: theme.externalId,
      group: theme.group,
      id,
      isSource: theme.isSource,
      name: theme.name,
      setIds: theme.setNames
        .map((name) => setIdByName.get(name))
        .filter((value) => value !== undefined),
    };
  });
  const themeIdByPath = new Map(
    themes.map((theme) => [themePath(theme.group, theme.name), theme.id]),
  );
  return {
    activeSetIds: [
      ...new Set(
        parsed.activeSets
          .map((name) => setIdByName.get(name))
          .filter((value) => value !== undefined),
      ),
    ],
    activeThemeIds: [
      ...new Set(
        parsed.activeThemes
          .map((path) => themeIdByPath.get(path))
          .filter((value) => value !== undefined),
      ),
    ],
    id: previous?.id ?? "tlib_default",
    ...(previous?.defaultThemeIds ? { defaultThemeIds: previous.defaultThemeIds.filter((id) => themes.some((theme) => theme.id === id)) } : {}),
    ...(previous?.defaultSetIds && (previous.defaultSetIds.length === 0 || previous.defaultSetIds.some((id) => sets.some((set) => set.id === id)))
      ? { defaultSetIds: previous.defaultSetIds.filter((id) => sets.some((set) => set.id === id)) } : {}),
    sets,
    themes,
  };
}

// The Package loader (tokens-domain parseTokenEntries) rejects a whole library
// when any token has a dangling alias, an alias of another type, an alias
// cycle, or a resolved value that does not fit its type. Penpot tolerates those
// on import and lets the user fix them later; SmallPen does not. Apply the same
// rules here so every token left in the library is one the loader accepts, and
// report each dropped token instead of failing the import. Dropping a token can
// orphan an alias that pointed at it, so repeat until nothing changes.
//
// options.externalTokens: tokens of the package's other token files, as
// { name, type, value, precedesLibrary }, with value already resolved. Aliases
// resolve against them exactly as the loader does (claimTokenPath): a file
// before the library wins a shared path; a DTCG path after it may not also be
// a library token name.
export function pruneUnresolvableTokens(library, options = {}) {
  const warnings = [];
  const pruned = structuredClone(library);
  const external = options.externalTokens ?? [];
  const laterPaths = new Set(
    external
      .filter(({ precedesLibrary }) => !precedesLibrary)
      .map(({ name }) => name),
  );
  for (;;) {
    const byName = new Map();
    for (const token of external) {
      if (token.precedesLibrary) claimTokenPath(byName, token.name, token);
    }
    for (const set of pruned.sets) {
      for (const token of set.tokens) claimTokenPath(byName, token.name, token);
    }
    const reject = (set, token, code, details = {}) => {
      warnings.push({ code, name: token.name, set: set.name, ...details });
    };
    const problem = (set, token) => {
      if (laterPaths.has(token.name)) return ["duplicate_token_path", {}];
      const visiting = new Set();
      let current = token;
      let alias = tokenAliasPath(current.value);
      while (alias !== null) {
        if (visiting.has(current.name)) return ["token_alias_cycle", {}];
        visiting.add(current.name);
        const target = byName.get(alias);
        if (!target) return ["missing_token_alias", { alias }];
        if (target.type !== token.type) {
          return ["token_alias_type_mismatch", { alias, aliasType: target.type }];
        }
        current = target;
        alias = tokenAliasPath(current.value);
      }
      if (!tokenValueMatchesType(current.value, token.type)) {
        return ["invalid_token_value", { value: structuredClone(current.value) }];
      }
      return null;
    };
    let dropped = 0;
    for (const set of pruned.sets) {
      set.tokens = set.tokens.filter((token) => {
        const found = problem(set, token);
        if (found === null) return true;
        reject(set, token, found[0], found[1]);
        dropped += 1;
        return false;
      });
    }
    if (dropped === 0) break;
  }
  return { library: pruned, warnings };
}

function tokenView(setName, token) {
  return {
    description: token.description,
    name: token.name,
    set: setName,
    type: token.type,
    value: structuredClone(token.value),
  };
}

// The Package stores values with sorted keys, so compare canonically: an
// object value whose keys arrive in another order is not a change.
function sameJson(left, right) {
  return canonicalJSON(left) === canonicalJSON(right);
}

function sameToken(left, right) {
  return (
    left.type === right.type &&
    left.description === right.description &&
    sameJson(left.value, right.value)
  );
}

function indexTokens(library) {
  const index = new Map();
  for (const set of library?.sets ?? []) {
    for (const token of set.tokens) {
      index.set(`${set.name}\0${token.name}`, tokenView(set.name, token));
    }
  }
  return index;
}

function themeView(theme) {
  return {
    description: theme.description,
    externalId: theme.externalId,
    group: theme.group,
    isSource: theme.isSource,
    name: theme.name,
    path: themePath(theme.group, theme.name),
    setIds: [...theme.setIds],
  };
}

// The review payload: every token, set, and theme that the import would add,
// remove, or change, with the real before/after values.
export function diffTokenLibraries(before, after) {
  const beforeTokens = indexTokens(before);
  const afterTokens = indexTokens(after);
  const tokens = { added: [], changed: [], removed: [] };
  for (const [key, token] of afterTokens) {
    const previous = beforeTokens.get(key);
    if (!previous) tokens.added.push(token);
    else if (!sameToken(previous, token)) {
      // Name the fields that differ so a reviewer can tell a value change
      // from a description- or type-only change at a glance.
      const fields = [];
      if (!sameJson(previous.value, token.value)) fields.push("value");
      if (previous.type !== token.type) fields.push("type");
      if (previous.description !== token.description) fields.push("description");
      tokens.changed.push({
        after: token,
        before: previous,
        fields,
        name: token.name,
        set: token.set,
      });
    }
  }
  for (const [key, token] of beforeTokens) {
    if (!afterTokens.has(key)) tokens.removed.push(token);
  }
  const beforeSets = new Set((before?.sets ?? []).map((set) => set.name));
  const afterSets = new Set((after?.sets ?? []).map((set) => set.name));
  const sets = {
    added: [...afterSets].filter((name) => !beforeSets.has(name)),
    removed: [...beforeSets].filter((name) => !afterSets.has(name)),
  };
  const beforeThemes = new Map(
    (before?.themes ?? []).map((theme) => [
      themePath(theme.group, theme.name),
      theme,
    ]),
  );
  const afterThemes = new Map(
    (after?.themes ?? []).map((theme) => [
      themePath(theme.group, theme.name),
      theme,
    ]),
  );
  const themes = { added: [], changed: [], removed: [] };
  for (const [path, theme] of afterThemes) {
    const previous = beforeThemes.get(path);
    if (!previous) themes.added.push(themeView(theme));
    else if (!sameJson(themeView(previous), themeView(theme))) {
      themes.changed.push({
        after: themeView(theme),
        before: themeView(previous),
        path,
      });
    }
  }
  for (const [path, theme] of beforeThemes) {
    if (!afterThemes.has(path)) themes.removed.push(themeView(theme));
  }
  const byKey = (items, key) =>
    items.sort((left, right) => compareStrings(key(left), key(right)));
  byKey(tokens.added, (token) => `${token.set}/${token.name}`);
  byKey(tokens.changed, (token) => `${token.set}/${token.name}`);
  byKey(tokens.removed, (token) => `${token.set}/${token.name}`);
  return {
    sets,
    summary: {
      themesAdded: themes.added.length,
      themesChanged: themes.changed.length,
      themesRemoved: themes.removed.length,
      tokensAdded: tokens.added.length,
      tokensChanged: tokens.changed.length,
      tokensRemoved: tokens.removed.length,
    },
    themes,
    tokens,
  };
}

function selectionKey(item) {
  if (typeof item === "string") return item;
  if (
    isRecord(item) &&
    typeof item.set === "string" &&
    typeof item.name === "string"
  ) {
    return `${item.set}/${item.name}`;
  }
  fail(
    "invalid_token_selection",
    'Token selection entries must be "set/name" or {set, name}',
  );
}

// Keep only the selected token rows of a diff: an unselected change keeps its
// previous value, an unselected addition is dropped, an unselected removal is
// kept. Sets and themes always follow the imported document.
// options.reservedTokenIds: ids owned outside the library (other token files).
export function applyTokenSelection(
  before,
  after,
  diff,
  selection,
  options = {},
) {
  const selected = new Set(selection.map(selectionKey));
  const beforeSets = new Map((before?.sets ?? []).map((set) => [set.name, set]));
  const library = structuredClone(after);
  const setsByName = new Map(library.sets.map((set) => [set.name, set]));
  const ensureSet = (name) => {
    let set = setsByName.get(name);
    if (!set) {
      const prior = beforeSets.get(name);
      set = {
        description: prior?.description ?? "",
        id: prior?.id ?? slugId("tset_", name),
        name,
        tokens: [],
      };
      library.sets.push(set);
      setsByName.set(name, set);
    }
    return set;
  };
  const priorToken = (setName, tokenName) =>
    beforeSets.get(setName)?.tokens.find((token) => token.name === tokenName);
  for (const change of diff.tokens.changed) {
    if (selected.has(`${change.set}/${change.name}`)) continue;
    const set = setsByName.get(change.set);
    const index = set.tokens.findIndex((token) => token.name === change.name);
    set.tokens[index] = structuredClone(priorToken(change.set, change.name));
  }
  for (const added of diff.tokens.added) {
    if (selected.has(`${added.set}/${added.name}`)) continue;
    const set = setsByName.get(added.set);
    set.tokens = set.tokens.filter((token) => token.name !== added.name);
  }
  const restored = [];
  for (const removed of diff.tokens.removed) {
    if (selected.has(`${removed.set}/${removed.name}`)) continue;
    const token = structuredClone(priorToken(removed.set, removed.name));
    ensureSet(removed.set).tokens.push(token);
    restored.push(token);
  }
  // A kept row owns its prior id. A moved copy that inherited the id (see
  // buildTokenLibrary) takes a fresh one instead.
  const usedIds = new Set([
    ...(options.reservedTokenIds ?? []),
    ...(before?.sets ?? []).flatMap((set) => set.tokens.map(({ id }) => id)),
    ...library.sets.flatMap((set) => set.tokens.map(({ id }) => id)),
  ]);
  const restoredTokens = new Set(restored);
  const restoredIds = new Set(restored.map(({ id }) => id));
  for (const set of library.sets) {
    for (const other of set.tokens) {
      if (restoredIds.has(other.id) && !restoredTokens.has(other)) {
        other.id = claimUnique(slugId("tok_", other.name), usedIds);
      }
    }
  }
  return library;
}

export function findTokenLibrary(snapshot) {
  for (const entry of snapshot.manifest.entries.tokens) {
    const value = snapshot.entries[entry];
    if (Array.isArray(value?.sets) && Array.isArray(value?.themes)) return value;
  }
  return null;
}

// One call for the CLI and the review UI: parse, build, diff, optionally
// narrow to a selection, and hand back the Operation Batch that applies it.
export function importTokens(snapshot, documentValue, options = {}) {
  const previous = findTokenLibrary(snapshot);
  const parsed = parseTokenDocument(documentValue, { setName: options.setName });
  // Other DTCG entries remain in the package when the Form A library is replaced.
  // Their identities belong to existing bindings and cannot be reused by imports.
  const previousIds = new Set(
    (previous?.sets ?? []).flatMap((set) => set.tokens.map((token) => token.id)),
  );
  const reservedTokenIds = [...snapshot.domain.tokens.keys()].filter(
    (id) => !previousIds.has(id),
  );
  // The replaced library keeps its entry; a new one is appended.
  const libraryEntry = snapshot.manifest.entries.tokens.find(
    (entry) => snapshot.entries[entry] === previous,
  );
  const tokenEntries = snapshot.manifest.entries.tokens;
  const libraryIndex = libraryEntry
    ? tokenEntries.indexOf(libraryEntry)
    : tokenEntries.length;
  const externalTokens = [...snapshot.domain.tokens.values()]
    .filter((token) => token.filePath !== libraryEntry)
    .map((token) => ({
      name: token.path,
      precedesLibrary: tokenEntries.indexOf(token.filePath) < libraryIndex,
      type: token.type,
      value: structuredClone(token.resolvedValue),
    }));
  const built = pruneUnresolvableTokens(
    buildTokenLibrary(parsed, previous, { reservedTokenIds }),
    { externalTokens },
  );
  let library = built.library;
  // Fail the review exactly as the apply would.
  assertValueDepth([{ library }], "operations");
  let diff = diffTokenLibraries(previous, library);
  if (Array.isArray(options.selection)) {
    library = applyTokenSelection(previous, library, diff, options.selection, {
      reservedTokenIds,
    });
    diff = diffTokenLibraries(previous, library);
  }
  return {
    diff,
    library,
    operations: [{ library, type: "replace-token-library" }],
    previousLibraryId: previous?.id ?? null,
    warnings: [...parsed.warnings, ...built.warnings],
  };
}
