import { SmallPenError } from "@smallpen/core";
import {
  COMMAND_CONTRACTS,
  commandContract,
  validateCommandArguments,
} from "./command-contract.mjs";

const action = (engine, purpose, extra = {}) => ({ engine, purpose, ...extra });

// Public command paths specialize the existing contracts and run the same
// engines. Every action names things the way outlines show them; only
// advanced apply (the undo batches writes return) and project repair (the
// choices it offers) carry IDs.
export const COMMAND_GROUPS = {
  project: {
    purpose: "Create, inspect and maintain a project",
    actions: {
      init: action("init", "Create a blank package or workspace"),
      show: action("inspect", "Read the package name, revision and counts"),
      list: action("list", "Locate project objects by kind"),
      watch: action("watch", "Watch package revision changes"),
      repair: action("repair", "Inspect conflicts or apply an offered repair"),
      migrate: action("migrate-themes", "Copy a package with migrated themes"),
    },
  },
  theme: {
    purpose: "Read and edit theme groups, options and project defaults",
    actions: {
      list: action(
        "themes",
        "Read groups, options and defaults; --theme selects values for this call only",
      ),
      add: action(
        "theme-add",
        "Add options by full name: --theme Viewport/Desktop --theme Viewport/Mobile",
      ),
      rename: action(
        "theme-rename",
        "Rename an option (--theme Viewport/Desktop --to Web) or a group (--group Viewport --to Platform)",
      ),
      default: action("theme-default", "Make an option its group's default: --theme Viewport/Mobile"),
      delete: action("theme-delete", "Delete an option (--theme Viewport/Tablet) or a group (--group Viewport)"),
    },
  },
  token: {
    purpose: "Read, resolve, search and edit Tokens",
    actions: {
      list: action(
        "tokens",
        "Read resolved Tokens; --definitions reads stored option values",
      ),
      show: action(
        "effective-token",
        "Resolve one Token for the supplied themes",
      ),
      search: action("search-tokens", "Find reusable Tokens"),
      explain: action("explain-token", "Explain one Token's value and sources"),
      set: action(
        "token-set",
        "Create or change Tokens by name, with default and per-option values",
        { topic: "token-set" },
      ),
      delete: action(
        "token-delete",
        "Delete a Token by name: --path color.brand; bound Tokens are protected",
      ),
      impact: action("impact", "Locate bindings of one Token"),
      export: action(
        "token-export",
        "Write Token values to files for code: --type string --by Language writes en.json, zh-CN.json, ...",
      ),
      import: action("import-tokens", "Review or apply a Token import"),
    },
  },
  canvas: {
    purpose: "Arrange pages on canvases; the CLI lays every canvas out (one row per business flow)",
    actions: {
      list: action("canvas-list", "List canvases, their business flows and pages"),
      rename: action("canvas-rename", "Rename a canvas: --canvas Pages --to App"),
      put: action("canvas-put", "Put a page on a canvas: --page \"Tasks / Board\" --canvas Reviews"),
    },
  },
  component: {
    purpose: "Find and edit components and their variants",
    actions: {
      list: action("catalog", "List reusable components"),
      search: action("search-components", "Find reusable components"),
      define: action(
        "component-define",
        "Define or redefine a component by name: base elements, properties, variant changes",
        { topic: "component-define" },
      ),
      rename: action("component-rename", "Rename a component: --component Button --to \"Action button\""),
      delete: action(
        "component-delete",
        "Delete a component, or one variant: --component Button [--variant Style=ghost]; used components are protected",
      ),
    },
  },
  page: {
    purpose: "Draw and arrange pages from named elements and component instances",
    actions: {
      list: action("list", "List pages", { fixed: ["--kind", "screens"] }),
      draw: action(
        "page-draw",
        "Draw a page or one container from named elements and component instances",
        { topic: "page-draw" },
      ),
      move: action(
        "page-move",
        "Move an element up, down, left or right; the CLI picks coordinates and avoids overlaps",
      ),
      rename: action("page-rename", "Rename a page: --page \"Tasks / List\" --to Overview"),
      delete: action(
        "page-delete",
        "Delete a page, a platform version (--platform) or an element (--element)",
      ),
    },
  },
  asset: {
    purpose: "Read and edit colors and typographies",
    actions: {
      list: action("assets", "List colors and typographies; --kind media or fonts lists those"),
      set: action(
        "asset-set",
        "Create or change by name: --color Brand/Primary --value \"#1f6feb\", or --typography Text/Body --value '{...}'",
      ),
      delete: action("asset-delete", "Delete by name: --color Brand/Primary or --typography Text/Body"),
    },
  },
  media: {
    purpose: "Import and manage media files",
    actions: {
      list: action("assets", "List media", { fixed: ["--kind", "media"] }),
      import: action("import-media", "Import a media file"),
      delete: action("media-delete", "Delete a media file by name: --media Logos/Mark"),
    },
  },
  font: {
    purpose: "Import and manage font families and variants",
    actions: {
      list: action("assets", "List fonts", { fixed: ["--kind", "fonts"] }),
      import: action("import-font", "Import a font file"),
      delete: action("font-delete", "Delete a font family, or one variant: --font Inter [--variant Bold]"),
    },
  },
  flow: {
    purpose: "Read and set prototype starts and element links by name",
    actions: {
      list: action("flow-list", "List starts and links by page and element name"),
      link: action(
        "flow-link",
        "Link an element to a page: --from \"Page / Element\" --to Page [--on click] [--action navigate|overlay|back]",
      ),
      start: action("flow-start", "Make a page the start of a prototype flow: --page Page; --remove stops it"),
      unlink: action("flow-unlink", "Remove an element's links: --from \"Page / Element\" [--to Page] [--on click]"),
    },
  },
  advanced: {
    purpose: "Use atomic batches, draft imports and remote libraries",
    actions: {
      apply: action(
        "apply",
        "Apply an explicit revision-guarded atomic batch, such as the undo batch a write returns",
        { topic: "batch" },
      ),
      "import-draft": action("import-draft", "Import a separate Draft package"),
      "draft-diff": action("draft-diff", "Compare two Drafts"),
      "draft-compile": action(
        "draft-compile",
        "Compile selected Draft fields into a batch",
      ),
      "library-refresh": action(
        "library-refresh",
        "Refresh a declared URL Library",
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
  ...Object.entries(COMMAND_GROUPS).map(([command, { purpose }]) => ({ command, purpose })),
  ...["view", "changes", "export", "validate", "help", "schema", "version"].map(
    (command) => ({ command, purpose: COMMAND_CONTRACTS[command].purpose }),
  ),
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
          { operation: "smallpen.help", argv: ["help", group, "--json"] },
        ],
      },
    );
  return route;
}

export function actionContract(group, actionName) {
  const route = groupRoute(group, actionName);
  const contract = commandContract(route.name);
  return {
    ...contract,
    next: ["schema", "command", group, actionName, "--json"],
    nextOperations: inputQueries(route),
  };
}

export function inputQueries(route) {
  const queries = route.topic ? [["schema", route.topic, "--json"]] : [];
  return queries.map((argv) => ({ operation: "smallpen.schema", argv }));
}

export function routeCommand(argv) {
  const group = COMMAND_GROUPS[argv[0]];
  if (!group) return { args: argv };
  if (argv.length === 1 || ["--help", "-h"].includes(argv[1]))
    return {
      args: [
        "help",
        argv[0],
        ...argv.slice(1).filter((a) => a !== "--help" && a !== "-h"),
      ],
    };
  // Existing package-path commands remain compatibility aliases, not discovery entries.
  if (
    !group.actions[argv[1]] &&
    (/[/.\\]/.test(argv[1]) || argv[1].includes("://"))
  )
    return { args: argv };
  const route = groupRoute(argv[0], argv[1]);
  if (argv.slice(2).includes("--help") || argv.slice(2).includes("-h"))
    return {
      args: [
        "help",
        argv[0],
        argv[1],
        ...argv
          .slice(2)
          .filter((a) => ["--json", "--full", "--stdout"].includes(a)),
      ],
    };
  const validated = validateCommandArguments(route.name, [
    route.name,
    ...argv.slice(2),
  ]);
  return {
    route,
    args: [route.engine, ...validated.slice(1), ...(route.fixed ?? [])],
  };
}

const ALIASES = {
  init: ["project", "init"],
  inspect: ["project", "show"],
  list: ["project", "list"],
  watch: ["project", "watch"],
  repair: ["project", "repair"],
  "migrate-themes": ["project", "migrate"],
  themes: ["theme", "list"],
  tokens: ["token", "list"],
  "effective-token": ["token", "show"],
  "explain-token": ["token", "explain"],
  "search-tokens": ["token", "search"],
  impact: ["token", "impact"],
  "import-tokens": ["token", "import"],
  catalog: ["component", "list"],
  "token-export": ["token", "export"],
  "search-components": ["component", "search"],
  assets: ["asset", "list"],
  "import-media": ["media", "import"],
  "import-font": ["font", "import"],
  apply: ["advanced", "apply"],
  "import-draft": ["advanced", "import-draft"],
  "draft-diff": ["advanced", "draft-diff"],
  "draft-compile": ["advanced", "draft-compile"],
  "library-refresh": ["advanced", "library-refresh"],
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
    if (!route.fixed) ENGINE_ROUTES.set(route.engine, ENGINE_ROUTES.has(route.engine) ? null : [group, name]);

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
            .slice(0, COMMAND_GROUPS[publicArgv(value.argv)[0]] ? 2 : 1)
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
