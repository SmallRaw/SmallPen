import { fail } from "./errors.mjs";
import { tokenLibraryOf } from "./token-themes.mjs";

// Both the App and CLI call these planners. IDs and value representation belong
// to their transport layers; set selection and copy/update semantics live here.
export function createTokenRow(sets, setIds, template, newTokenId) {
  const targets = [...new Set(setIds)]
    .map((id) => sets.find((set) => set.id === id))
    .filter(Boolean);
  for (const set of targets) {
    const existing = set.tokens.find((token) => token.name === template.name);
    if (existing)
      fail(
        "duplicate_token_name",
        `Token set ${set.name} already has ${template.name}`,
        {
          setId: set.id,
          tokenId: existing.id,
          name: template.name,
        },
      );
  }
  const { id, modifiedAt, "modified-at": modified, ...fields } = template;
  return targets.map((set) => ({
    setId: set.id,
    token: { ...structuredClone(fields), id: newTokenId() },
  }));
}

export function writeTokenCell(sets, setId, template, value, newTokenId) {
  const set = sets.find((candidate) => candidate.id === setId);
  if (!set) fail("unknown_token_set", `Token Set does not exist: ${setId}`);
  const existing = set.tokens.find((token) => token.name === template.name);
  return {
    setId,
    created: !existing,
    token: existing
      ? { ...structuredClone(existing), value: structuredClone(value) }
      : {
          id: newTokenId(),
          name: template.name,
          type: template.type,
          description: template.description ?? "",
          value: structuredClone(value),
        },
  };
}

export const TOKEN_INTENT_ACTIONS = Object.freeze({
  "create-row": {
    fields: ["group", "name", "type", "value", "description?"],
    example: {
      action: "create-row",
      group: "Brand",
      name: "color.accent",
      type: "color",
      value: "#6750a4",
    },
    purpose:
      "Like App Add Token: create independent copies with the initial value in every option Set of this group",
  },
  "set-value": {
    fields: ["group", "option", "name", "value"],
    example: {
      action: "set-value",
      group: "Brand",
      option: "Ocean",
      name: "color.accent",
      value: "#006699",
    },
    purpose:
      "Like editing one App cell: preserve its ID and metadata, or fill an empty cell from an existing row's name/type/description",
  },
});

// App matrix columns come from the native Set paths, not a theme's dependency
// Sets. In particular, creating a Brand row must never write a shared base Set.
export function tokenGroupSets(library, group) {
  const sets = (library?.sets ?? []).filter((set) => set.name.includes("/"));
  const exact = sets.filter((set) => set.name.split("/")[0] === group);
  if (exact.length) return exact;
  const matching = sets.filter(
    (set) => set.name.split("/")[0].toLowerCase() === group.toLowerCase(),
  );
  if (new Set(matching.map((set) => set.name.split("/")[0])).size > 1)
    fail(
      "ambiguous_token_theme_group",
      `Multiple native Token groups match ${group}; use the exact name`,
      {
        validGroups: [
          ...new Set(matching.map((set) => set.name.split("/")[0])),
        ],
      },
    );
  return matching;
}

export function listTokenDefinitions(snapshot, { group } = {}) {
  const library = tokenLibraryOf(snapshot);
  const sets =
    group === undefined
      ? (library?.sets ?? [])
      : tokenGroupSets(library, group);
  return sets.flatMap((set) => {
    const parts = set.name.split("/");
    return set.tokens.map((token) => ({
      packageId: snapshot.manifest.packageId,
      setId: set.id,
      setName: set.name,
      group: parts.length >= 2 ? parts[0] : null,
      option: parts.length >= 2 ? parts.slice(1).join("/") : null,
      token: structuredClone(token),
    }));
  });
}

export function tokenIntentOperations(
  snapshot,
  intent,
  newTokenId = () =>
    `tok_${globalThis.crypto.randomUUID().replaceAll("-", "")}`,
) {
  if (
    !intent ||
    typeof intent !== "object" ||
    Array.isArray(intent) ||
    !Object.hasOwn(TOKEN_INTENT_ACTIONS, intent.action)
  )
    fail(
      "invalid_token_intent",
      "Expected create-row, set-value, or an operations intent",
      {
        nextOperations: [
          {
            operation: "smallpen.schema",
            argv: ["schema", "token-intent", "--json"],
          },
        ],
      },
    );
  const contract = TOKEN_INTENT_ACTIONS[intent.action];
  const allowed = [
    "action",
    ...contract.fields.map((field) => field.replace(/\?$/, "")),
  ];
  for (const field of Object.keys(intent)) {
    if (!allowed.includes(field))
      fail(
        "unknown_token_intent_field",
        `Unknown ${intent.action} field: ${field}`,
        { allowedFields: allowed },
      );
  }
  for (const field of contract.fields) {
    const name = field.replace(/\?$/, "");
    if (intent[name] === undefined && field.endsWith("?")) continue;
    if (name === "value") {
      if (intent.value === undefined)
        fail("invalid_token_intent", "value is required");
    } else if (name === "description") {
      if (typeof intent.description !== "string")
        fail("invalid_token_intent", "description must be a string");
    } else if (
      typeof intent[name] !== "string" ||
      !intent[name].trim() ||
      intent[name] !== intent[name].trim()
    ) {
      fail("invalid_token_intent", `${name} must be a nonempty string`);
    }
  }
  const library = tokenLibraryOf(snapshot);
  const sets = tokenGroupSets(library, intent.group);
  if (!sets.length)
    fail("unknown_token_theme_group", `No Token Set group ${intent.group}`, {
      validGroups: [
        ...new Set(
          (library?.sets ?? [])
            .filter((set) => set.name.includes("/"))
            .map((set) => set.name.split("/")[0]),
        ),
      ],
      nextOperations: [
        {
          operation: "smallpen.theme",
          argv: [
            "theme",
            "<package>",
            "--intent",
            "<add-group.json>",
            "--json",
          ],
        },
      ],
    });
  if (intent.action === "create-row") {
    const { name, type, value, description = "" } = intent;
    return createTokenRow(
      sets,
      sets.map((set) => set.id),
      { name, type, value, description },
      newTokenId,
    ).map((edit) => ({ type: "put-set-token", ...edit }));
  }
  const optionName = (set) => set.name.split("/").slice(1).join("/");
  const exactSet = sets.find((set) => optionName(set) === intent.option);
  const matching = sets.filter(
    (set) => optionName(set).toLowerCase() === intent.option.toLowerCase(),
  );
  if (!exactSet && matching.length > 1)
    fail(
      "ambiguous_token_option",
      `Multiple options match ${intent.option}; use the exact name`,
      { validOptions: matching.map(optionName) },
    );
  const set = exactSet ?? matching[0];
  if (!set)
    fail("unknown_token_option", `No option ${intent.group}/${intent.option}`, {
      validOptions: sets.map(optionName),
    });
  const template = sets
    .flatMap((set) => set.tokens)
    .find((token) => token.name === intent.name);
  if (!template)
    fail(
      "unknown_token_name",
      `No Token ${intent.name} in ${intent.group}; create the row first`,
      {
        validNames: [
          ...new Set(
            sets.flatMap((set) => set.tokens.map((token) => token.name)),
          ),
        ],
        nextOperations: [
          {
            operation: "smallpen.schema",
            argv: ["schema", "token-intent", "--json"],
          },
        ],
      },
    );
  const { created, ...edit } = writeTokenCell(
    sets,
    set.id,
    template,
    intent.value,
    newTokenId,
  );
  return [{ type: "put-set-token", ...edit }];
}
