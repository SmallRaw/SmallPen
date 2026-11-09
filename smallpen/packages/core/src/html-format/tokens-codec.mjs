// INPUT:  tokens.css text (decode) or a Penpot Token library (encode)
// OUTPUT: the package's Token library and fonts, or tokens.css text
// POS:    tokens.css <-> token sets + themes. :root is the base set; each
//         :root[data-group="option"] block is one theme option.

import { parseTokensCss, quoteCss, splitCssValue, unquoteCss } from "./css-parse.mjs";
import { derivedId } from "./ids.mjs";
import {
  formatLength,
  formatNumber,
  formatShadow,
  normalizeHex,
  parseLength,
  parseShadow,
  TOKEN_NAME_PATTERN,
  TYPE_PREFIX,
  tokenTypeOfName,
} from "./vocabulary.mjs";

const BASE_SET_ID = "tset_base";
const TOKEN_LIBRARY_ID = "tlib_default";
const GROUP_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const ALIAS = /^var\(\s*--([a-z][a-z0-9-]*)\s*\)$/;
const LENGTH_TYPES = new Set([
  "spacing", "sizing", "border-radius", "stroke-width", "font-size", "letter-spacing",
]);

function issueAt(issues, code, message, offset, severity = "error") {
  issues.push({ code, message, offset, severity });
}

// Parses a CSS font shorthand: [italic] [weight] size[/line-height] family.
function parseFontShorthand(text) {
  const parts = splitCssValue(text);
  let index = 0;
  const value = {};
  if (parts[index] === "normal" || parts[index] === "italic") {
    if (parts[index] === "italic") value.fontStyle = "italic";
    index += 1;
  }
  if (/^\d{3}$/.test(parts[index] ?? "")) {
    value.fontWeight = Number(parts[index]);
    index += 1;
  }
  const sizePart = parts[index];
  if (!sizePart) return undefined;
  const [sizeText, lineText] = sizePart.split("/");
  const fontSize = parseLength(sizeText);
  if (!fontSize) return undefined;
  value.fontSize = fontSize;
  if (lineText !== undefined) {
    if (!/^\d+(?:\.\d+)?$/.test(lineText)) return undefined;
    value.lineHeight = Number(lineText);
  }
  index += 1;
  const familyText = parts.slice(index).join(" ");
  if (!familyText || familyText.includes(",")) return undefined;
  value.fontFamily = unquoteCss(familyText) ?? familyText;
  value.fontWeight ??= 400;
  return value;
}

function formatFontShorthand(value) {
  const parts = [];
  if (value.fontStyle === "italic") parts.push("italic");
  parts.push(String(value.fontWeight ?? 400));
  parts.push(
    `${formatLength(value.fontSize)}${value.lineHeight !== undefined ? `/${formatNumber(value.lineHeight)}` : ""}`,
  );
  parts.push(quoteCss(value.fontFamily ?? "Source Sans Pro"));
  return parts.join(" ");
}

// CSS value text -> model value for one Token type. Returns undefined when
// the text does not fit the type.
function decodeTokenValue(type, text) {
  const alias = ALIAS.exec(text);
  if (alias) return { value: `{${alias[1]}}`, alias: alias[1] };
  switch (type) {
    case "color":
      return HEX.test(text) ? { value: normalizeHex(text) } : undefined;
    case "opacity": {
      if (!/^\d+(?:\.\d+)?$/.test(text)) return undefined;
      const value = Number(text);
      return value <= 1 ? { value } : undefined;
    }
    case "shadow": {
      const value = parseShadow(text);
      return value === undefined ? undefined : { value };
    }
    case "typography": {
      const value = parseFontShorthand(text);
      if (!value) return undefined;
      delete value.fontStyle;
      return { value };
    }
    case "font-family": {
      const value = unquoteCss(text) ?? (/^[A-Za-z][\w -]*$/.test(text) ? text : undefined);
      return value ? { value } : undefined;
    }
    case "font-weight": {
      if (!/^\d{3}$/.test(text)) return undefined;
      const value = Number(text);
      return value >= 100 && value <= 950 ? { value } : undefined;
    }
    case "string": {
      const value = unquoteCss(text);
      return value === undefined ? undefined : { value };
    }
    case "boolean":
      return text === "true" ? { value: true } : text === "false" ? { value: false } : undefined;
    default:
      if (LENGTH_TYPES.has(type)) {
        const value = parseLength(text, { signed: type === "letter-spacing" });
        return value === undefined ? undefined : { value };
      }
      return undefined;
  }
}

function encodeTokenValue(type, value) {
  if (typeof value === "string" && /^\{[^{}]+\}$/.test(value)) {
    return `var(--${value.slice(1, -1)})`;
  }
  switch (type) {
    case "color":
      return colorText(value);
    case "opacity":
      return formatNumber(Number(value));
    case "shadow":
      return formatShadow(value);
    case "typography":
      return formatFontShorthand(value);
    case "font-family":
      return quoteCss(value);
    case "font-weight":
      return String(Number.parseInt(value, 10));
    case "string":
      return quoteCss(value);
    case "boolean":
      return value === true || value === "true" ? "true" : "false";
    default:
      if (LENGTH_TYPES.has(type)) return formatLength(Number(value));
      throw Object.assign(new Error(`Token type ${type} has no tokens.css form`), {
        code: "unsupported_token_type",
      });
  }
}

// One Token as a CSS custom property, as tokens.css writes it: an alias as
// var(--name), lengths with px, a typography Token as the font shorthand.
export function tokenCssDeclaration(name, type, value) {
  let tracking = "";
  if (type === "typography" && value && typeof value === "object" && value.letterSpacing !== undefined) {
    tracking = `\n  --${name}--tracking: ${formatLength(value.letterSpacing)};`;
    value = { ...value };
    delete value.letterSpacing;
  }
  return `  --${name}: ${encodeTokenValue(type, value)};${tracking}`;
}

function colorText(value) {
  if (typeof value === "string") return normalizeHex(value);
  if (value && typeof value === "object" && Array.isArray(value.components)) {
    const hex = value.components
      .slice(0, 3)
      .map((part) => Math.round(Math.max(0, Math.min(1, part)) * 255).toString(16).padStart(2, "0"))
      .join("");
    const alpha = value.alpha === undefined || value.alpha === 1
      ? ""
      : Math.round(value.alpha * 255).toString(16).padStart(2, "0");
    return `#${hex}${alpha}`;
  }
  throw Object.assign(new Error("Color Token value is not a color"), { code: "invalid_token_value" });
}

// Reads tokens.css. defaults: Map(group -> option) from index.html.
// Returns { library, tokens, groups, fonts, issues } where tokens is
// Map(name -> { type, rest, scopes: Map(scope -> { value, offset }) }).
export function decodeTokensCss(source, defaults = new Map(), idFor = (prefix, key, label) => derivedId(prefix, key, label)) {
  const { rules, issues: parseIssues } = parseTokensCss(source);
  const issues = parseIssues.map((entry) => ({ ...entry, severity: "error" }));
  const tokens = new Map();
  const groups = new Map();
  const fonts = [];
  const scopeOrder = ["base"];
  const tracking = [];

  for (const rule of rules) {
    if (rule.kind === "font-face") {
      const face = { offset: rule.offset };
      for (const declaration of rule.declarations) {
        face[declaration.name] = declaration;
      }
      fonts.push(face);
      continue;
    }
    if (rule.kind === "unsupported") continue;
    let scope = "base";
    if (rule.kind === "theme") {
      if (!GROUP_PATTERN.test(rule.group) || !GROUP_PATTERN.test(rule.option)) {
        issueAt(issues, "invalid_theme_name", `Theme group and option names use lowercase letters, digits and dashes: ${rule.selector}`, rule.offset);
        continue;
      }
      scope = `${rule.group}/${rule.option}`;
      if (!groups.has(rule.group)) groups.set(rule.group, []);
      const options = groups.get(rule.group);
      if (!options.includes(rule.option)) options.push(rule.option);
      if (!scopeOrder.includes(scope)) scopeOrder.push(scope);
    }
    for (const declaration of rule.declarations) {
      if (!declaration.name.startsWith("--")) {
        issueAt(issues, "unsupported_css_rule", `${declaration.name}: tokens.css only declares --Token variables here`, declaration.offset);
        continue;
      }
      const name = declaration.name.slice(2);
      const trackingMatch = /^(type-[a-z0-9-]+)--tracking$/.exec(name);
      if (trackingMatch) {
        tracking.push({ name: trackingMatch[1], scope, declaration });
        continue;
      }
      const info = tokenTypeOfName(name);
      if (!info || !TOKEN_NAME_PATTERN.test(name)) {
        issueAt(
          issues,
          "invalid_token_name",
          `--${name}: start the name with a type prefix such as --color-, --spacing-, --size-, --radius-, --type-`,
          declaration.offset,
        );
        continue;
      }
      if (!tokens.has(name)) tokens.set(name, { name, type: info.type, rest: info.rest, scopes: new Map(), offset: declaration.offset });
      const token = tokens.get(name);
      if (token.scopes.has(scope)) {
        issueAt(issues, "duplicate_token", `--${name} is declared twice in ${scope === "base" ? ":root" : scope}`, declaration.offset);
      }
      const decoded = decodeTokenValue(info.type, declaration.value);
      if (!decoded) {
        issueAt(issues, "invalid_token_value", `--${name}: ${declaration.value} is not a valid ${info.type} value`, declaration.valueOffset);
        continue;
      }
      token.scopes.set(scope, { value: decoded.value, alias: decoded.alias, offset: declaration.valueOffset });
    }
  }

  for (const { name, scope, declaration } of tracking) {
    const token = tokens.get(name);
    const entry = token?.scopes.get(scope);
    const value = parseLength(declaration.value, { signed: true });
    if (!entry || token.type !== "typography") {
      issueAt(issues, "invalid_token_name", `--${name}--tracking needs --${name} in the same block`, declaration.offset);
    } else if (value === undefined) {
      issueAt(issues, "invalid_token_value", `--${name}--tracking takes a px value`, declaration.valueOffset);
    } else if (typeof entry.value === "object") {
      entry.value = { ...entry.value, letterSpacing: value };
    }
  }

  // Aliases must point at a Token of the same type, without cycles.
  for (const token of tokens.values()) {
    for (const entry of token.scopes.values()) {
      if (!entry.alias) continue;
      const target = tokens.get(entry.alias);
      if (!target) {
        issueAt(issues, "token_alias_missing", `--${token.name} refers to --${entry.alias}, which does not exist`, entry.offset);
      } else if (target.type !== token.type) {
        issueAt(issues, "token_type_mismatch", `--${token.name} (${token.type}) refers to --${entry.alias} (${target.type})`, entry.offset);
      }
    }
  }
  for (const token of tokens.values()) {
    const seen = new Set([token.name]);
    let current = token;
    for (;;) {
      const alias = current.scopes.get("base")?.alias ?? [...current.scopes.values()].find((entry) => entry.alias)?.alias;
      if (!alias) break;
      if (seen.has(alias)) {
        issueAt(issues, "token_alias_cycle", `--${token.name} is part of an alias cycle`, token.offset);
        break;
      }
      seen.add(alias);
      current = tokens.get(alias);
      if (!current) break;
    }
  }

  // Two Tokens that would produce the same class (text-sm as color and
  // font size) make the class ambiguous.
  const byClassRest = new Map();
  const classOwners = {
    "font-family": "font", "font-weight": "font", color: "text", "font-size": "text",
  };
  for (const token of tokens.values()) {
    const owner = classOwners[token.type];
    if (!owner) continue;
    const key = `${owner}:${token.rest}`;
    if (byClassRest.has(key)) {
      issueAt(issues, "token_class_collision", `--${token.name} and --${byClassRest.get(key)} both produce ${owner}-${token.rest}`, token.offset);
    } else byClassRest.set(key, token.name);
  }

  missingThemeValues(tokens, groups, issues);
  missingTranslations(tokens, groups, defaults, issues);
  const library = buildLibrary(tokens, groups, scopeOrder, defaults, issues, idFor);
  return { library, tokens, groups, fonts, issues };
}

// An option that gives some strings its own words (a language) should give
// all of them: a string it leaves out shows :root's words there. The option
// selected by default holds :root's words, so it may leave them out.
// A Token with no :root value takes its value from the options that set
// it; under an option of the same group that leaves it out it has none,
// and a page draws another option's value. A warning, so packages made
// that way in the App still open.
function missingThemeValues(tokens, groups, issues) {
  for (const token of tokens.values()) {
    if (token.scopes.has("base")) continue;
    for (const [group, options] of groups) {
      const set = options.filter((option) => token.scopes.has(`${group}/${option}`));
      if (!set.length) continue;
      for (const option of options) {
        if (set.includes(option)) continue;
        issueAt(
          issues,
          "missing_theme_value",
          `--${token.name} has a value for ${set.map((name) => `${group}/${name}`).join(", ")} but none for ${group}/${option} and none in :root, so under ${group}/${option} it shows another option's value; add it to :root[data-${group}="${option}"] (or to :root for every option)`,
          token.offset,
          "warning",
        );
      }
    }
  }
}

function missingTranslations(tokens, groups, defaults, issues) {
  const strings = [...tokens.values()].filter((token) => token.type === "string");
  for (const [group, options] of groups) {
    const chosen = options.includes(defaults.get(group)) ? defaults.get(group) : options.includes("default") ? "default" : options[0];
    for (const option of options) {
      if (option === chosen) continue;
      const scope = `${group}/${option}`;
      if (!strings.some((token) => token.scopes.has(scope))) continue;
      for (const token of strings) {
        // No :root value either: missingThemeValues reports it as an error.
        if (token.scopes.has(scope) || !token.scopes.has("base")) continue;
        const shown = token.scopes.get("base")?.value;
        issueAt(
          issues,
          "missing_translation",
          `--${token.name} has no value in :root[data-${group}="${option}"], so ${group} ${option} shows ${shown === undefined ? "no text" : JSON.stringify(shown)}; add it to that block`,
          token.offset,
          "warning",
        );
      }
    }
  }
}

function buildLibrary(tokens, groups, scopeOrder, defaults, issues, idFor) {
  const sets = [];
  const setIdFor = new Map();
  for (const scope of scopeOrder) {
    const id = scope === "base" ? BASE_SET_ID : idFor("tset", `set\0${scope}`, scope);
    setIdFor.set(scope, id);
    const setTokens = [];
    for (const token of tokens.values()) {
      const entry = token.scopes.get(scope);
      if (!entry) continue;
      setTokens.push({
        description: "",
        id: idFor("tok", `token\0${scope}\0${token.name}`, token.name),
        name: token.name,
        type: token.type,
        value: entry.value,
      });
    }
    sets.push({ description: "", id, name: scope, tokens: setTokens });
  }
  const themes = [];
  const defaultThemeIds = [];
  for (const [group, options] of groups) {
    const wanted = defaults.get(group);
    if (wanted !== undefined && !options.includes(wanted)) {
      issues.push({ code: "unknown_theme_option", message: `index.html selects ${group}="${wanted}", but tokens.css has no :root[data-${group}="${wanted}"] block`, offset: 0, severity: "error", file: "index.html" });
    }
    const chosen = options.includes(wanted) ? wanted : options.includes("default") ? "default" : options[0];
    for (const option of options) {
      const id = idFor("theme", `theme\0${group}/${option}`, `${group}_${option}`);
      themes.push({
        description: "",
        externalId: "",
        group,
        id,
        isSource: false,
        name: option,
        setIds: [BASE_SET_ID, setIdFor.get(`${group}/${option}`)],
      });
      if (option === chosen) defaultThemeIds.push(id);
    }
  }
  for (const [group] of defaults) {
    if (!groups.has(group)) {
      issues.push({ code: "unknown_theme_option", message: `index.html sets data-${group}, but tokens.css has no ${group} options`, offset: 0, severity: "error", file: "index.html" });
    }
  }
  // Active sets are the sets of the selected options, as Penpot computes
  // them from its active themes: the base set plus one set per group.
  const selectedSetIds = new Set(themes.filter((theme) => defaultThemeIds.includes(theme.id)).flatMap((theme) => theme.setIds));
  return {
    activeSetIds: themes.length ? sets.map((set) => set.id).filter((id) => selectedSetIds.has(id)) : [BASE_SET_ID],
    activeThemeIds: [...defaultThemeIds],
    defaultThemeIds,
    id: TOKEN_LIBRARY_ID,
    sets,
    themes,
  };
}

// Token library -> { css, defaults: [[group, option]] }. Every Token name,
// group and option must already fit the CSS form.
// Names the App and Token imports use ("color.brand", "Core / Brand",
// theme "Mode" / "Dark") become tokens.css names the way gofmt formats code:
// lowercase, dashes, the type prefix added when missing. Aliases follow the
// rename; ids stay, so bindings and the identity map are unaffected.
// Words a name may start with that already say its type: space.sm is
// --spacing-sm, not --spacing-space-sm. Longest first.
const TYPE_WORDS = {
  spacing: ["spacing", "space"],
  sizing: ["sizing", "size"],
  "border-radius": ["border-radius", "radius", "rounded"],
  "stroke-width": ["stroke-width", "border-width", "stroke", "border"],
  color: ["colors", "color"],
  typography: ["typography", "type"],
  "font-family": ["font-family", "fonts", "font"],
  "font-size": ["font-size", "text"],
  "font-weight": ["font-weight", "weight"],
  "letter-spacing": ["letter-spacing", "tracking"],
  opacity: ["opacity"],
  shadow: ["shadows", "shadow"],
  string: ["string"],
  boolean: ["boolean", "flag"],
};

export function cssTokenName(name, type) {
  const prefix = TYPE_PREFIX[type];
  if (!prefix) return name;
  if (TOKEN_NAME_PATTERN.test(name) && tokenTypeOfName(name)?.type === type) return name;
  // accentSoft is accent-soft: a capital starts a word, as dashes do.
  const slug = String(name).replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "token";
  if (slug.startsWith(prefix) && tokenTypeOfName(slug)?.type === type) return slug;
  const word = (TYPE_WORDS[type] ?? []).find((candidate) => slug.startsWith(`${candidate}-`) && slug.length > candidate.length + 1);
  return `${prefix}${word ? slug.slice(word.length + 1) : slug}`;
}

export function cssThemeName(name) {
  if (GROUP_PATTERN.test(name)) return name;
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

export function cssTokenLibrary(library) {
  if (!library) return library;
  const renames = new Map();
  const taken = new Map();
  for (const set of library.sets ?? []) {
    for (const token of set.tokens ?? []) {
      const key = `${token.type}\0${token.name}`;
      if (renames.has(key)) continue;
      let name = cssTokenName(token.name, token.type);
      for (let counter = 2; taken.has(name) && taken.get(name) !== key; counter += 1) name = `${cssTokenName(token.name, token.type)}-${counter}`;
      taken.set(name, key);
      renames.set(key, name);
      if (!renames.has(token.name)) renames.set(token.name, name);
    }
  }
  const changed = [...renames].some(([key, name]) => key.includes("\0") && key.split("\0")[1] !== name);
  const themesChanged = (library.themes ?? []).some((theme) => cssThemeName(theme.group) !== theme.group || cssThemeName(theme.name) !== theme.name);
  if (!changed && !themesChanged) return library;
  const alias = (value) => {
    if (typeof value === "string") return value.replace(/\{([^{}]+)\}/g, (match, name) => (renames.has(name) ? `{${renames.get(name)}}` : match));
    if (Array.isArray(value)) return value.map(alias);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, alias(item)]));
    return value;
  };
  return {
    ...library,
    sets: (library.sets ?? []).map((set) => ({
      ...set,
      tokens: (set.tokens ?? []).map((token) => ({
        ...token,
        name: renames.get(`${token.type}\0${token.name}`),
        value: alias(token.value),
      })),
    })),
    themes: (library.themes ?? []).map((theme) => ({ ...theme, group: cssThemeName(theme.group), name: cssThemeName(theme.name) })),
  };
}

export function encodeTokensCss(library, { fontFaces = [] } = {}) {
  const sets = new Map((library?.sets ?? []).map((set) => [set.id, set]));
  const themes = library?.themes ?? [];
  const groups = new Map();
  for (const theme of themes) {
    if (!groups.has(theme.group)) groups.set(theme.group, []);
    groups.get(theme.group).push(theme);
  }
  // A group with one option is always on: its sets join :root.
  const multiGroups = [...groups].filter(([, members]) => members.length > 1);
  const alwaysOnSetIds = new Set();
  if (themes.length === 0) {
    const active = library?.activeSetIds?.length ? library.activeSetIds : [...sets.keys()];
    for (const id of active) alwaysOnSetIds.add(id);
  }
  for (const [, members] of groups) {
    if (members.length === 1) for (const id of members[0].setIds) alwaysOnSetIds.add(id);
  }
  if (multiGroups.length > 0) {
    const everyTheme = multiGroups.flatMap(([, members]) => members);
    for (const id of everyTheme[0].setIds) {
      if (everyTheme.every((theme) => theme.setIds.includes(id))) alwaysOnSetIds.add(id);
    }
  }
  // A set the App turned on outside the themes applies everywhere, so it
  // joins :root. A set that is off and in no option has no place in
  // tokens.css; its Tokens are refused rather than dropped.
  const optionSetIds = new Set(multiGroups.flatMap(([, members]) => members.flatMap((theme) => theme.setIds)));
  for (const id of library?.activeSetIds ?? []) if (!optionSetIds.has(id) && sets.has(id)) alwaysOnSetIds.add(id);
  const unplaced = [...sets.values()].filter((set) => !alwaysOnSetIds.has(set.id) && !optionSetIds.has(set.id) && set.tokens?.length);
  if (unplaced.length) {
    throw Object.assign(
      new Error(`Token set ${unplaced.map((set) => set.name).join(", ")} is off and in no theme option, so tokens.css cannot hold it; turn it on, add it to an option, or delete it`),
      { code: "unsupported_in_html_format", details: { sets: unplaced.map((set) => set.name) } },
    );
  }
  const blocks = [];
  const identity = [];
  const rootTokens = mergeSets(
    [...sets.values()].filter((set) => alwaysOnSetIds.has(set.id)),
  );
  for (const token of rootTokens) identity.push([`tok\0token\0base\0${token.name}`, token.id]);
  blocks.push(formatBlock(":root", rootTokens));
  const defaults = [];
  const defaultIds = new Set(library?.defaultThemeIds ?? library?.activeThemeIds ?? []);
  for (const [group, members] of multiGroups) {
    assertCssName(group, "theme group");
    let chosen;
    for (const theme of members) {
      assertCssName(theme.name, "theme option");
      const own = theme.setIds
        .filter((id) => !alwaysOnSetIds.has(id))
        .map((id) => sets.get(id))
        .filter(Boolean);
      const merged = mergeSets(own);
      const scope = `${group}/${theme.name}`;
      for (const token of merged) identity.push([`tok\0token\0${scope}\0${token.name}`, token.id]);
      if (own[0]) identity.push([`tset\0set\0${scope}`, own[0].id]);
      identity.push([`theme\0theme\0${scope}`, theme.id]);
      blocks.push(formatBlock(`:root[data-${group}="${theme.name}"]`, merged));
      if (defaultIds.has(theme.id)) chosen = theme.name;
    }
    if (chosen !== undefined) defaults.push([group, chosen]);
  }
  for (const face of fontFaces) blocks.push(face);
  return { css: `${blocks.join("\n\n")}\n`, defaults, identity };
}

function mergeSets(list) {
  const merged = new Map();
  for (const set of list) {
    for (const token of set.tokens ?? []) {
      merged.delete(token.name);
      merged.set(token.name, token);
    }
  }
  return [...merged.values()];
}

function formatBlock(selector, tokens) {
  if (tokens.length === 0) return `${selector} {\n}`;
  const lines = [];
  for (const token of tokens) {
    assertTokenName(token);
    let value = token.value;
    let trackingLine;
    if (token.type === "typography" && value && typeof value === "object" && value.letterSpacing !== undefined) {
      trackingLine = `  --${token.name}--tracking: ${formatLength(value.letterSpacing)};`;
      value = { ...value };
      delete value.letterSpacing;
    }
    lines.push(`  --${token.name}: ${encodeTokenValue(token.type, value)};`);
    if (trackingLine) lines.push(trackingLine);
  }
  return `${selector} {\n${lines.join("\n")}\n}`;
}

function assertTokenName(token) {
  if (!TYPE_PREFIX[token.type]) {
    throw Object.assign(new Error(`Token ${token.name}: ${token.type} Tokens have no tokens.css form; use a class literal instead`), {
      code: "unsupported_in_html_format",
      details: { name: token.name, type: token.type },
    });
  }
  const info = tokenTypeOfName(token.name);
  if (!TOKEN_NAME_PATTERN.test(token.name) || info?.type !== token.type) {
    throw Object.assign(
      new Error(`Token ${token.name} (${token.type}) has no tokens.css name; name it --${TYPE_PREFIX[token.type] ?? "?"}…`),
      { code: "token_name_not_css", details: { name: token.name, type: token.type } },
    );
  }
}

function assertCssName(name, what) {
  if (!GROUP_PATTERN.test(name)) {
    throw Object.assign(new Error(`The ${what} ${name} must use lowercase letters, digits and dashes`), {
      code: "theme_name_not_css",
      details: { name },
    });
  }
}

// Resolves a Token's value for the given theme selection (Map group ->
// option), following aliases. Returns undefined for unknown names.
export function resolveTokenValue(tokens, name, selection, depth = 0) {
  const token = tokens.get(name);
  if (!token || depth > 16) return undefined;
  let entry = token.scopes.get("base");
  for (const [scope, candidate] of token.scopes) {
    if (scope === "base") continue;
    const [group, option] = scope.split("/");
    if (selection.get(group) === option) entry = candidate;
  }
  entry ??= [...token.scopes.values()][0];
  if (!entry) return undefined;
  if (entry.alias) return resolveTokenValue(tokens, entry.alias, selection, depth + 1);
  return entry.value;
}
