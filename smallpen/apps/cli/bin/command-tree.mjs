import { SmallPenError } from "@smallpen/core";
import {
  COMMAND_CONTRACTS,
  commandContract,
  validateCommandArguments,
} from "./command-contract.mjs";

const action = (engine, purpose, extra = {}) => ({ engine, purpose, ...extra });

// Public command paths specialize the existing contracts and run the same
// engines. Every action is a read and names things the way outlines show
// them; designs change by editing the package's HTML files.
export const COMMAND_GROUPS = {
  token: {
    purpose: "Resolved Token values per theme, and Token exports for application code (edit tokens.css to change Tokens)",
    actions: {
      list: action(
        "tokens",
        "Read resolved Tokens and the theme options; --definitions reads each option block's stored values",
      ),
      export: action(
        "token-export",
        "Export Token values for application code: --by GROUP writes one file per option (any group, e.g. --by color); --type limits the types; --format json|flat|css",
      ),
    },
  },
};

for (const [group, { actions }] of Object.entries(COMMAND_GROUPS)) {
  for (const [name, route] of Object.entries(actions)) {
    route.name = `${group} ${name}`;
    const base = COMMAND_CONTRACTS[route.engine];
    const fixedOptions = route.fixed?.filter((_, i) => i % 2 === 0) ?? [];
    const baseParameters = commandContract(route.engine).parameters;
    const removed = Object.entries(baseParameters)
      .filter(([, p]) => fixedOptions.includes(p.option))
      .map(([key]) => key);
    const spec = {
      ...base,
      purpose: route.purpose,
      overrides: { ...base.overrides, ...route.overrides },
      fields: [
        ...base.fields.filter(
          (field) => !removed.includes(field) && !route.omit?.includes(field),
        ),
        ...(route.fields ?? []),
      ],
      required: base.required ?? [],
    };
    Object.defineProperty(COMMAND_CONTRACTS, route.name, { value: spec });
  }
}

export const PUBLIC_COMMANDS = [
  ...["init", "check", "view", "export", "changes"].map((command) => ({ command, purpose: COMMAND_CONTRACTS[command].purpose })),
  ...Object.entries(COMMAND_GROUPS).map(([command, { purpose }]) => ({ command, purpose })),
  ...["help", "schema", "version"].map((command) => ({ command, purpose: COMMAND_CONTRACTS[command].purpose })),
];

export function groupRoute(group, actionName) {
  const actions = Object.hasOwn(COMMAND_GROUPS, group)
    ? COMMAND_GROUPS[group].actions
    : undefined;
  const route =
    actions && Object.hasOwn(actions, actionName)
      ? actions[actionName]
      : undefined;
  if (!route)
    throw new SmallPenError(
      "unknown_action",
      `Unknown ${group} action: ${actionName}`,
      {
        nextOperations: [
          {
            operation: "smallpen.help",
            argv: [
              "help",
              group,
              ...parentGroup(group, actionName).split(" ").filter(Boolean),
              "--json",
            ],
          },
        ],
      },
    );
  return route;
}

function parentGroup(group, section = "") {
  return (
    Object.keys(COMMAND_GROUPS[group]?.groups ?? {})
      .filter((name) => section === name || section.startsWith(`${name} `))
      .sort((a, b) => b.length - a.length)[0] ?? ""
  );
}

export function groupDefinition(group, section = "") {
  if (!Object.hasOwn(COMMAND_GROUPS, group)) return undefined;
  if (!section) return COMMAND_GROUPS[group];
  const groups = COMMAND_GROUPS[group].groups;
  return groups && Object.hasOwn(groups, section) ? groups[section] : undefined;
}

// Store leaf routes once; discovery shows only the next level of their path.
export function groupActions(group, section = "") {
  const prefix = section ? `${section} ` : "";
  const actions = new Map();
  for (const [name, route] of Object.entries(COMMAND_GROUPS[group].actions)) {
    if (!name.startsWith(prefix) || route.hidden) continue;
    const action = name.slice(prefix.length).split(" ")[0];
    const child = [section, action].filter(Boolean).join(" ");
    actions.set(action, {
      action,
      purpose: groupDefinition(group, child)?.purpose ?? route.purpose,
    });
  }
  return [...actions.values()];
}

export function commandMatch(argv) {
  const group = argv[0];
  if (!Object.hasOwn(COMMAND_GROUPS, group)) return undefined;
  let section = "";
  let length = 1;
  for (; length < argv.length && !argv[length].startsWith("-"); length++) {
    section = [section, argv[length]].filter(Boolean).join(" ");
    const actions = COMMAND_GROUPS[group].actions;
    const route = Object.hasOwn(actions, section)
      ? actions[section]
      : undefined;
    if (route) return { group, section, route, length: length + 1 };
    if (!groupDefinition(group, section))
      return { group, section, length: length + 1 };
  }
  return { group, section, length };
}

export function actionContract(group, actionName) {
  const route = groupRoute(group, actionName);
  const contract = commandContract(route.name);
  return {
    ...contract,
    next: ["schema", "command", ...route.name.split(" "), "--json"],
    nextOperations: inputQueries(route),
  };
}

export function inputQueries(route) {
  const queries = route.topic ? [["schema", route.topic, "--json"]] : [];
  return queries.map((argv) => ({ operation: "smallpen.schema", argv }));
}

export function routeCommand(argv) {
  if (!Object.hasOwn(COMMAND_GROUPS, argv[0])) return { args: argv };
  const group = COMMAND_GROUPS[argv[0]];
  const matched = commandMatch(argv);
  if (!matched.route && groupDefinition(matched.group, matched.section))
    return {
      args: [
        "help",
        matched.group,
        ...matched.section.split(" ").filter(Boolean),
        ...argv
          .slice(matched.length)
          .filter((a) => a !== "--help" && a !== "-h"),
      ],
    };
  // Existing package-path commands remain compatibility aliases, not discovery entries.
  if (
    !group.actions[argv[1]] &&
    (/[/.\\]/.test(argv[1]) || argv[1].includes("://"))
  )
    return { args: argv };
  const route = matched.route ?? groupRoute(matched.group, matched.section);
  if (
    argv.slice(matched.length).includes("--help") ||
    argv.slice(matched.length).includes("-h")
  )
    return {
      args: [
        "help",
        ...route.name.split(" "),
        ...argv
          .slice(matched.length)
          .filter((a) => ["--json", "--full", "--stdout"].includes(a)),
      ],
    };
  const validated = validateCommandArguments(route.name, [
    route.name,
    ...argv.slice(matched.length),
  ]);
  return {
    route,
    args: [route.engine, ...validated.slice(1), ...(route.fixed ?? [])],
  };
}

const ALIASES = {
  tokens: ["token", "list"],
  "token-export": ["token", "export"],
};

export function publicArgv(argv) {
  if (!Array.isArray(argv) || !argv.length) return argv;
  if (argv[0].includes(" ") && COMMAND_GROUPS[argv[0].split(" ")[0]])
    return [...argv[0].split(" "), ...argv.slice(1)];
  if (argv[0] === "schema" && argv[1] === "command" && argv[2]?.includes(" "))
    return [...argv.slice(0, 2), ...argv[2].split(" "), ...argv.slice(3)];
  if (COMMAND_GROUPS[argv[0]]?.actions[argv[1]]) return argv;
  if (
    argv[0] === "schema" &&
    argv[1] === "command" &&
    Object.hasOwn(COMMAND_GROUPS, argv[2]) &&
    Object.hasOwn(COMMAND_GROUPS[argv[2]].actions, argv[3])
  )
    return argv;
  if (
    (argv[0] === "help" && argv.length === 3) ||
    (argv[0] === "schema" && argv[1] === "command")
  ) {
    const index = argv[0] === "help" ? 1 : 2;
    const alias = ALIASES[argv[index]];
    if (alias)
      return [...argv.slice(0, index), ...alias, ...argv.slice(index + 1)];
  }
  const alias = ALIASES[argv[0]] ?? ENGINE_ROUTES.get(argv[0]);
  return alias ? [...alias, ...argv.slice(1)] : argv;
}

// The public path of an engine that one action runs ("component-rename" is
// component rename).
const ENGINE_ROUTES = new Map();
for (const [group, { actions }] of Object.entries(COMMAND_GROUPS))
  for (const [name, route] of Object.entries(actions))
    if (!route.fixed)
      ENGINE_ROUTES.set(
        route.engine,
        ENGINE_ROUTES.has(route.engine) ? null : route.name.split(" "),
      );

// Rewrite only command guidance; design strings and stored operation payloads stay exact.
export function publicGuidance(value) {
  if (Array.isArray(value)) return value.map(publicGuidance);
  if (!value || typeof value !== "object" || value instanceof Map) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (key === "argv" && Array.isArray(child))
        return [key, publicArgv(child)];
      if (key === "operation" && Array.isArray(value.argv))
        return [
          key,
          `smallpen.${publicArgv(value.argv)
            .slice(0, commandMatch(publicArgv(value.argv))?.length ?? 1)
            .join(".")}`,
        ];
      if (
        [
          "nextOperations",
          "reverseEdit",
          "undoError",
          "error",
          "details",
          "stages",
          "commands",
          "actions",
          "rules",
          "diagnostics",
          "reuseReminders",
        ].includes(key)
      )
        return [key, publicGuidance(child)];
      return [key, child];
    }),
  );
}
