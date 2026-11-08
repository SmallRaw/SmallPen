// Name-based writes for agents. An agent names Tokens by path, themes by
// "Group/Option" and components and pages by name; these planners turn that
// into the existing canonical operations, so IDs, set layout and node tables
// stay the program's business. Every planner is deterministic for a given
// snapshot, input and ID generator.
import {
  tokenLibraryOf,
} from "./token-themes.mjs";

export const TOKEN_SET_FIELDS = Object.freeze(["name", "type?", "value?", "values?", "group?", "description?"]);

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
