import { sha256Hex } from "./canonical.mjs";
import { fail } from "./errors.mjs";
import { defaultTokenThemeIds, tokenLibraryOf } from "./token-themes.mjs";

const action = (fields, example, purpose) => ({ fields, example, purpose });
export const THEME_INTENT_ACTIONS = Object.freeze({
  "add-group": action(
    ["group", "setIds?"],
    { action: "add-group", group: "Brand" },
    "Create a real Group/Default set and paired theme, like the App",
  ),
  "add-option": action(
    ["group", "name", "source?"],
    { action: "add-option", group: "Brand", name: "Other" },
    "Copy the group's default option into an independent set; source optionally names another option",
  ),
  "set-default": action(
    ["group", "name"],
    { action: "set-default", group: "Brand", name: "Other" },
    "Change the project default without changing the App's active selection",
  ),
  "rename-group": action(
    ["group", "name"],
    { action: "rename-group", group: "Brand", name: "Identity" },
    "Rename a group and its matching set paths, preserving identities and values",
  ),
  "rename-option": action(
    ["group", "name", "newName"],
    {
      action: "rename-option",
      group: "Brand",
      name: "Other",
      newName: "Alternate",
    },
    "Rename an option and its own set, preserving references and default",
  ),
  "delete-option": action(
    ["group", "name"],
    { action: "delete-option", group: "Brand", name: "Other" },
    "Remove an option and its unshared set; referenced Tokens prevent deletion",
  ),
  "delete-group": action(
    ["group"],
    { action: "delete-group", group: "Brand" },
    "Remove a group and its unshared sets; referenced Tokens prevent deletion",
  ),
});

function validateIntent(intent) {
  if (
    !intent ||
    typeof intent !== "object" ||
    Array.isArray(intent) ||
    !Object.hasOwn(THEME_INTENT_ACTIONS, intent.action)
  ) {
    fail(
      "invalid_theme_intent",
      "Expected a theme intent with a supported action",
      {
        actions: Object.keys(THEME_INTENT_ACTIONS),
        nextOperations: [
          {
            argv: ["schema", "theme-intent", "--json"],
            operation: "smallpen.schema",
          },
        ],
      },
    );
  }
  const fields = THEME_INTENT_ACTIONS[intent.action].fields;
  const allowed = [
    "action",
    ...fields.map((field) => field.replace(/\?$/, "")),
  ];
  for (const field of Object.keys(intent)) {
    if (!allowed.includes(field))
      fail(
        "unknown_theme_intent_field",
        `Unknown ${intent.action} field: ${field}`,
        { allowedFields: allowed },
      );
  }
  for (const field of fields) {
    const name = field.replace(/\?$/, "");
    if (intent[name] === undefined && field.endsWith("?")) continue;
    if (name === "setIds") {
      if (
        !Array.isArray(intent[name]) ||
        intent[name].some((id) => typeof id !== "string")
      )
        fail(
          "invalid_theme_intent",
          "setIds must be an array of Token Set ids",
        );
    } else if (
      typeof intent[name] !== "string" ||
      !intent[name].trim() ||
      intent[name] !== intent[name].trim() ||
      intent[name].includes("/")
    ) {
      fail("invalid_theme_intent", `${name} must be a nonempty name without /`);
    }
  }
}

// Produces one atomic, undoable library edit. No active selection is changed
// except when its option is deleted; a newly created group starts at Default.
export async function themeIntentOperations(snapshot, intent) {
  validateIntent(intent);
  const library = structuredClone(
    tokenLibraryOf(snapshot) ?? {
      id: "tlib_design",
      sets: [],
      themes: [],
      activeSetIds: [],
      activeThemeIds: [],
    },
  );
  library.defaultThemeIds = defaultTokenThemeIds(library);
  const group = library.themes.filter((theme) => theme.group === intent.group);
  const operations = [];
  const rewritePaths = (replacements) => {
    for (const scenario of snapshot.domain.scenarios.values()) {
      if (!scenario.themes?.some((path) => replacements.has(path))) continue;
      operations.push({
        type: "put-scenario",
        scenario: {
          ...scenario,
          themes: scenario.themes.map((path) => replacements.get(path) ?? path),
        },
      });
    }
  };
  const newId = async (prefix, identity) => {
    const occupied = new Set([
      library.id,
      ...library.themes.map(({ id }) => id),
      ...library.sets.flatMap((set) => [
        set.id,
        ...set.tokens.map(({ id }) => id),
      ]),
    ]);
    const base = `${prefix}${(await sha256Hex(identity)).slice(0, 16)}`;
    let id = base,
      suffix = 2;
    while (occupied.has(id)) id = `${base}_${suffix++}`;
    return id;
  };
  const newTheme = async (name, setIds) => ({
    id: await newId("theme_", `${intent.group}/${name}`),
    group: intent.group,
    name,
    setIds,
    description: "",
    externalId: "",
    isSource: false,
  });
  const option = (name) => {
    const found = group.find((theme) => theme.name === name);
    if (!found)
      fail("unknown_token_theme", `No option ${intent.group}/${name}`, {
        validThemes: group.map(({ name }) => `${intent.group}/${name}`),
      });
    return found;
  };
  const ownSet = (theme) =>
    library.sets.find(
      (set) =>
        set.name.toLowerCase() === `${theme.group}/${theme.name}`.toLowerCase(),
    ) ??
    library.sets.find(
      (set) =>
        set.id === theme.setIds.at(-1) &&
        !library.defaultSetIds?.includes(set.id) &&
        !library.themes.some(
          (other) => other.id !== theme.id && other.setIds.includes(set.id),
        ),
    );
  const renameSet = (set, name) => {
    if (!set) return;
    if (
      library.sets.some((other) => other.id !== set.id && other.name === name)
    )
      fail("duplicate_token_set_name", `Token Set already exists: ${name}`);
    set.name = name;
  };
  if (intent.action === "add-group") {
    if (group.length)
      fail(
        "duplicate_token_theme_group",
        `Group already exists: ${intent.group}`,
      );
    const set = {
      id: await newId("tset_", `${intent.group}/Default`),
      name: `${intent.group}/Default`,
      description: "",
      tokens: [],
    };
    library.sets.push(set);
    const theme = await newTheme("Default", [
      ...new Set([...(intent.setIds ?? []), set.id]),
    ]);
    library.themes.push(theme);
    library.defaultThemeIds.push(theme.id);
    library.activeThemeIds.push(theme.id);
  } else {
    if (!group.length)
      fail(
        "unknown_token_theme_group",
        `Group does not exist: ${intent.group}`,
        { validGroups: [...new Set(library.themes.map(({ group }) => group))] },
      );
    if (intent.action === "add-option") {
      if (group.some(({ name }) => name === intent.name))
        fail(
          "duplicate_token_theme",
          `Option already exists: ${intent.group}/${intent.name}`,
        );
      const source = option(
        intent.source ??
          group.find(({ id }) => library.defaultThemeIds.includes(id)).name,
      );
      const sourceSet =
        ownSet(source) ??
        library.sets.find((set) => set.id === source.setIds.at(-1));
      if (!sourceSet)
        fail("missing_token_set", "The source option has no Token Set to copy");
      const set = {
        ...structuredClone(sourceSet),
        id: await newId("tset_", `${intent.group}/${intent.name}`),
        // A legacy domain can have a differently cased native path. Keep new
        // options in that App domain instead of splitting it into another one.
        name: `${sourceSet.name.includes("/") ? sourceSet.name.split("/")[0] : intent.group}/${intent.name}`,
        tokens: await Promise.all(
          sourceSet.tokens.map(async (token) => ({
            ...structuredClone(token),
            id: await newId(
              "tok_",
              `${intent.group}/${intent.name}/${token.name}`,
            ),
          })),
        ),
      };
      library.sets.push(set);
      library.themes.push(
        await newTheme(
          intent.name,
          source.setIds.map((id) => (id === sourceSet.id ? set.id : id)),
        ),
      );
    } else if (intent.action === "set-default") {
      const selected = option(intent.name);
      library.defaultThemeIds = library.defaultThemeIds.filter(
        (id) => !group.some((theme) => theme.id === id),
      );
      library.defaultThemeIds.push(selected.id);
    } else if (intent.action === "rename-group") {
      if (library.themes.some(({ group }) => group === intent.name))
        fail(
          "duplicate_token_theme_group",
          `Group already exists: ${intent.name}`,
        );
      rewritePaths(
        new Map(
          group.map((theme) => [
            `${theme.group}/${theme.name}`,
            `${intent.name}/${theme.name}`,
          ]),
        ),
      );
      for (const theme of group) {
        const set = ownSet(theme);
        if (
          set?.name.toLowerCase().startsWith(`${intent.group}/`.toLowerCase())
        )
          renameSet(set, `${intent.name}/${theme.name}`);
        theme.group = intent.name;
      }
    } else if (intent.action === "rename-option") {
      const theme = option(intent.name);
      if (group.some(({ name }) => name === intent.newName))
        fail(
          "duplicate_token_theme",
          `Option already exists: ${intent.group}/${intent.newName}`,
        );
      rewritePaths(
        new Map([
          [
            `${intent.group}/${intent.name}`,
            `${intent.group}/${intent.newName}`,
          ],
        ]),
      );
      renameSet(ownSet(theme), `${intent.group}/${intent.newName}`);
      theme.name = intent.newName;
    } else {
      const removed =
        intent.action === "delete-group" ? group : [option(intent.name)];
      if (intent.action === "delete-option" && group.length === 1)
        fail("last_theme_option", "Use delete-group to remove the last option");
      const paths = new Set(
        removed.map((theme) => `${theme.group}/${theme.name}`),
      );
      const scenarios = [...snapshot.domain.scenarios.values()].filter(
        (scenario) => scenario.themes?.some((path) => paths.has(path)),
      );
      if (scenarios.length)
        fail(
          "theme_option_in_use",
          "Update or remove the saved Scenarios before deleting their selected theme options",
          {
            scenarioIds: scenarios.map(({ id }) => id),
            themePaths: [...paths],
            nextOperations: [
              {
                argv: ["schema", "operation", "put-scenario", "--json"],
                operation: "smallpen.schema",
              },
            ],
          },
        );
      const ids = new Set(removed.map(({ id }) => id));
      const sets = new Set(
        removed
          .map(ownSet)
          .filter(Boolean)
          .map(({ id }) => id),
      );
      const wasActive = library.activeThemeIds.some((id) => ids.has(id));
      library.themes = library.themes.filter(({ id }) => !ids.has(id));
      library.defaultThemeIds = library.defaultThemeIds.filter(
        (id) => !ids.has(id),
      );
      library.defaultThemeIds = defaultTokenThemeIds(library);
      library.activeThemeIds = library.activeThemeIds.filter(
        (id) => !ids.has(id),
      );
      const remaining = library.themes.find(
        (theme) =>
          theme.group === intent.group &&
          library.defaultThemeIds.includes(theme.id),
      );
      if (wasActive && remaining) library.activeThemeIds.push(remaining.id);
      for (const theme of library.themes)
        for (const id of theme.setIds) sets.delete(id);
      library.sets = library.sets.filter(({ id }) => !sets.has(id));
      library.activeSetIds = library.activeSetIds.filter((id) => !sets.has(id));
      if (library.defaultSetIds)
        library.defaultSetIds = library.defaultSetIds.filter(
          (id) => !sets.has(id),
        );
    }
  }
  library.defaultThemeIds = defaultTokenThemeIds(library);
  return [{ type: "replace-token-library", library }, ...operations];
}
