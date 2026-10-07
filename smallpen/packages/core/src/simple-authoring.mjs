// Name-based writes for agents. An agent names Tokens by path, themes by
// "Group/Option" and components and pages by name; these planners turn that
// into the existing canonical operations, so IDs, set layout and node tables
// stay the program's business. Every planner is deterministic for a given
// snapshot, input and ID generator.
import { fail } from "./errors.mjs";
import { createTokenRow, tokenGroupSets, writeTokenCell } from "./token-authoring.mjs";
import { defaultTokenThemeIds, tokenLibraryOf } from "./token-themes.mjs";

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function groupOf(setName) {
  const parts = String(setName).split("/");
  return parts.length >= 2 ? parts[0] : null;
}

function optionOf(setName) {
  return String(setName).split("/").slice(1).join("/");
}

function sameName(left, right) {
  return String(left).toLowerCase() === String(right).toLowerCase();
}

// The option Set a "Group/Option" key names.
function optionSet(library, key) {
  const [group, ...rest] = String(key).split("/");
  const option = rest.join("/");
  const sets = tokenGroupSets(library, group);
  const set = sets.find((candidate) => optionOf(candidate.name) === option) ??
    sets.find((candidate) => sameName(optionOf(candidate.name), option));
  if (!set)
    fail("unknown_theme_option", `No theme option ${key}`, {
      validOptions: (library?.sets ?? [])
        .filter((candidate) => candidate.name.includes("/"))
        .map((candidate) => candidate.name),
    });
  return set;
}

function defaultOptionSet(library, group) {
  const sets = tokenGroupSets(library, group);
  const defaults = new Set(defaultTokenThemeIds(library));
  const theme = (library?.themes ?? []).find(
    (candidate) => sameName(candidate.group, group) && defaults.has(candidate.id),
  );
  return (
    (theme && sets.find((set) => sameName(optionOf(set.name), theme.name))) ??
    sets.find((set) => sameName(optionOf(set.name), "Default")) ??
    sets[0]
  );
}

// Where a Token row lives: Sets every theme activates (no group) or one
// group's option Sets. Agents never see this; it only decides where a write
// lands.
function rowHome(library, name) {
  const sets = library?.sets ?? [];
  const shared = sets.filter((set) => !set.name.includes("/") && set.tokens.some((token) => token.name === name));
  if (shared.length) return { kind: "shared", sets: shared };
  const grouped = sets.filter((set) => set.name.includes("/") && set.tokens.some((token) => token.name === name));
  const groups = [...new Set(grouped.map((set) => groupOf(set.name)))];
  if (groups.length > 1)
    fail("ambiguous_token_name", `Token ${name} exists in several groups; pass group`, { groups });
  if (groups.length === 1) return { kind: "group", group: groups[0] };
  return null;
}

export const TOKEN_SET_FIELDS = Object.freeze(["name", "type?", "value?", "values?", "group?", "description?"]);

// tokens: [{ name, type, value, values: {"Group/Option": value}, group? }].
// The agent's model has no Sets: "value" is the Token's value wherever no
// option overrides it, "values" override named options. Storage follows the
// library: an existing Token stays where it is; a new one goes to the named
// group, else the group its values name, else the Set every theme activates
// when there is one, else the first group (one copy per option).
export function tokenSetOperations(snapshot, input, newTokenId) {
  const tokens = Array.isArray(input?.tokens) ? input.tokens : null;
  if (!tokens || tokens.length === 0)
    fail("invalid_token_set", "Expected {tokens: [{name, type, value, values?}]}", {
      example: { tokens: [{ name: "color.brand", type: "color", value: "#4f46e5", values: { "Theme/Dark": "#818cf8" } }] },
    });
  const names = new Set();
  const library = tokenLibraryOf(snapshot);
  if (!library) fail("missing_token_library", "This package has no Token library");
  const operations = [];
  const sharedSets = (library.sets ?? []).filter((set) => !set.name.includes("/"));
  const groups = [...new Set((library.sets ?? []).map((set) => groupOf(set.name)).filter(Boolean))];
  for (const [index, token] of tokens.entries()) {
    if (!isRecord(token) || typeof token.name !== "string" || !token.name.trim())
      fail("invalid_token_set", `tokens[${index}] needs a name`);
    for (const field of Object.keys(token))
      if (!TOKEN_SET_FIELDS.map((item) => item.replace("?", "")).includes(field))
        fail("unknown_token_set_field", `Unknown field ${field} in tokens[${index}]`, {
          allowedFields: TOKEN_SET_FIELDS,
        });
    if (names.has(token.name)) fail("duplicate_token_set_name", `${token.name} is listed twice`);
    names.add(token.name);
    const values = token.values ?? {};
    if (!isRecord(values)) fail("invalid_token_set", `tokens[${index}].values must map "Group/Option" to a value`);
    if (token.value === undefined && Object.keys(values).length === 0)
      fail("invalid_token_set", `${token.name} needs value or values`);
    const home = rowHome(library, token.name);
    const template = (sets) => sets.flatMap((set) => set.tokens).find((item) => item.name === token.name);
    const write = (set, value, base) => {
      const { created: _created, ...edit } = writeTokenCell(
        library.sets, set.id,
        base ?? { name: token.name, type: token.type, description: token.description ?? "" },
        value, newTokenId,
      );
      if (token.description !== undefined) edit.token.description = token.description;
      operations.push({ type: "put-set-token", ...edit });
    };
    const valueGroups = [...new Set(Object.keys(values).map((key) => key.split("/")[0]))];
    if (home?.kind === "shared") {
      const base = template(home.sets);
      if (token.value !== undefined) for (const set of home.sets) write(set, token.value, base);
      for (const [key, value] of Object.entries(values)) write(optionSet(library, key), value, base);
      continue;
    }
    // With one value and nowhere named, the first group carries it to every
    // option, so every combination sees it.
    const group = home?.group ?? token.group ?? (valueGroups.length === 1 ? valueGroups[0] : undefined) ??
      (sharedSets.length === 0 ? groups[0] : undefined);
    if (home && token.group && !sameName(home.group, token.group))
      fail("token_group_mismatch", `${token.name} lives in group ${home.group}, not ${token.group}`);
    if (!home && !token.type) fail("invalid_token_set", `New Token ${token.name} needs a type`);
    if (group === undefined) {
      if (!sharedSets.length)
        fail("missing_token_group", `Say which group ${token.name} belongs to`, { groups });
      // A shared Token: every theme sees it, options may override it.
      const set = sharedSets[0];
      write(set, token.value ?? Object.values(values)[0]);
      const base = { name: token.name, type: token.type, description: token.description ?? "" };
      for (const [key, value] of Object.entries(values)) write(optionSet(library, key), value, base);
      continue;
    }
    const groupSets = tokenGroupSets(library, group);
    if (!groupSets.length) fail("unknown_token_theme_group", `No theme group ${group}`, { groups });
    if (!home) {
      const initial = token.value ?? values[Object.keys(values)[0]];
      const created = createTokenRow(groupSets, groupSets.map((set) => set.id),
        { name: token.name, type: token.type, value: initial, description: token.description ?? "" }, newTokenId);
      const byOption = new Map();
      for (const [key, value] of Object.entries(values)) byOption.set(optionSet(library, key).id, value);
      for (const edit of created) {
        if (byOption.has(edit.setId)) edit.token.value = structuredClone(byOption.get(edit.setId));
        operations.push({ type: "put-set-token", ...edit });
      }
      // Options of other groups override the new row.
      const own = new Set(groupSets.map((set) => set.id));
      const row = { name: token.name, type: token.type, description: token.description ?? "" };
      for (const [key, value] of Object.entries(values)) {
        const set = optionSet(library, key);
        if (!own.has(set.id)) write(set, value, row);
      }
      continue;
    }
    const base = template(groupSets);
    if (token.value !== undefined) {
      // Options that still hold the old default value follow the new one;
      // options with their own value keep it.
      const defaultSet = defaultOptionSet(library, group);
      const valueIn = (set) => set.tokens.find((item) => item.name === token.name)?.value;
      const previous = JSON.stringify(valueIn(defaultSet));
      const named = new Set(Object.keys(values).map((key) => optionSet(library, key).id));
      for (const set of groupSets)
        if (set.id === defaultSet.id || (!named.has(set.id) && JSON.stringify(valueIn(set)) === previous))
          write(set, token.value, base);
    }
    for (const [key, value] of Object.entries(values)) write(optionSet(library, key), value, base);
  }
  return operations;
}

// token delete: every stored copy of the named Token, in every option.
export function tokenDeleteOperations(snapshot, name) {
  const library = tokenLibraryOf(snapshot);
  const ids = [...new Set((library?.sets ?? []).flatMap((set) =>
    set.tokens.filter((token) => token.name === name).map((token) => token.id)))];
  if (!ids.length)
    fail("unknown_token", `No Token named ${name}`, {
      similar: [...new Set((library?.sets ?? []).flatMap((set) => set.tokens.map((token) => token.name)))]
        .filter((candidate) => candidate.split(".")[0] === String(name).split(".")[0])
        .slice(0, 8),
    });
  return ids.map((tokenId) => ({ type: "remove-token", tokenId }));
}

// Theme options are named the way Token values and --theme name them:
// "Group/Option". These planners turn names into the App's theme intents.
function splitThemeName(name) {
  const text = String(name ?? "").trim();
  const slash = text.indexOf("/");
  if (slash <= 0 || slash === text.length - 1)
    fail("invalid_theme_name", `Name a theme option as Group/Option, for example Viewport/Mobile: ${text}`, {
      example: "Viewport/Mobile",
    });
  return { group: text.slice(0, slash).trim(), option: text.slice(slash + 1).trim() };
}

function themeGroup(library, group) {
  const themes = (library?.themes ?? []).filter((theme) => sameName(theme.group, group));
  return themes.length ? { name: themes[0].group, options: themes.map((theme) => theme.name) } : null;
}

function existingOption(library, name) {
  const { group, option } = splitThemeName(name);
  const found = themeGroup(library, group);
  const match = found?.options.find((candidate) => sameName(candidate, option));
  if (!match)
    fail("unknown_theme_option", `No theme option ${name}`, {
      validOptions: (library?.themes ?? []).map((theme) => `${theme.group}/${theme.name}`),
    });
  return { group: found.name, option: match };
}

function existingGroup(library, group) {
  const found = themeGroup(library, group);
  if (!found)
    fail("unknown_token_theme_group", `No theme group ${group}`, {
      groups: [...new Set((library?.themes ?? []).map((theme) => theme.group))],
    });
  return found;
}

// theme add: create each named option, and its group when the group is new.
// The first option named for a new group replaces the App's initial Default
// option and becomes the default.
export function themeAddIntents(snapshot, names) {
  const list = (Array.isArray(names) ? names : [names]).filter((name) => name !== undefined);
  if (!list.length) fail("invalid_theme_add", "Name at least one option as Group/Option");
  const library = tokenLibraryOf(snapshot);
  const wanted = new Map();
  for (const name of list) {
    const { group, option } = splitThemeName(name);
    const key = themeGroup(library, group)?.name ??
      [...wanted.keys()].find((candidate) => sameName(candidate, group)) ?? group;
    if (!wanted.has(key)) wanted.set(key, []);
    if (!wanted.get(key).some((candidate) => sameName(candidate, option))) wanted.get(key).push(option);
  }
  const intents = [];
  for (const [group, options] of wanted) {
    const existing = themeGroup(library, group);
    if (!existing) {
      intents.push({ action: "add-group", group });
      if (!sameName(options[0], "Default"))
        intents.push({ action: "rename-option", group, name: "Default", newName: options[0] });
      for (const name of options.slice(1)) intents.push({ action: "add-option", group, name });
      continue;
    }
    for (const name of options)
      if (!existing.options.some((candidate) => sameName(candidate, name)))
        intents.push({ action: "add-option", group, name });
  }
  if (!intents.length) fail("theme_options_exist", `Already there: ${list.join(", ")}`);
  return intents;
}

// theme rename: "Group/Option" to a new option name (or "Group/New"), or a
// group to a new group name.
export function themeRenameIntent(snapshot, { theme, group, to }) {
  const library = tokenLibraryOf(snapshot);
  const target = String(to ?? "").trim();
  if (!target) fail("invalid_theme_rename", "--to names the new name");
  if ((theme === undefined) === (group === undefined))
    fail("invalid_theme_rename", "Rename either one option (--theme Group/Option) or one group (--group Group)");
  if (group !== undefined) {
    const found = existingGroup(library, group);
    return { action: "rename-group", group: found.name, name: target };
  }
  const current = existingOption(library, theme);
  let newName = target;
  if (target.includes("/")) {
    const renamed = splitThemeName(target);
    if (!sameName(renamed.group, current.group))
      fail("invalid_theme_rename", "An option stays in its group; rename the group with --group", {
        group: current.group,
      });
    newName = renamed.option;
  }
  return { action: "rename-option", group: current.group, name: current.option, newName };
}

export function themeDefaultIntent(snapshot, theme) {
  const current = existingOption(tokenLibraryOf(snapshot), theme);
  return { action: "set-default", group: current.group, name: current.option };
}

export function themeDeleteIntent(snapshot, { theme, group }) {
  const library = tokenLibraryOf(snapshot);
  if ((theme === undefined) === (group === undefined))
    fail("invalid_theme_delete", "Delete either one option (--theme Group/Option) or one group (--group Group)");
  if (group !== undefined) return { action: "delete-group", group: existingGroup(library, group).name };
  const current = existingOption(library, theme);
  return { action: "delete-option", group: current.group, name: current.option };
}

// Each Token's value under every option of each group, where it differs
// from the selected value: "values" on a token list row.
export function tokenOptionValues(snapshot, rows, resolveUnder) {
  const library = tokenLibraryOf(snapshot);
  const themes = library?.themes ?? [];
  const groups = [...new Set(themes.map((theme) => theme.group))];
  const extra = new Map();
  for (const group of groups) {
    const options = themes.filter((theme) => theme.group === group);
    if (options.length < 2) continue;
    for (const option of options) {
      const resolved = resolveUnder(`${option.group}/${option.name}`);
      for (const row of rows) {
        const value = resolved.get(row.path);
        if (value === undefined || JSON.stringify(value) === JSON.stringify(row.value)) continue;
        if (!extra.has(row.path)) extra.set(row.path, {});
        extra.get(row.path)[`${option.group}/${option.name}`] = value;
      }
    }
  }
  return extra;
}
