// `smallpen schema [topic]`: the JSON shapes a write needs. Field lists,
// types, enums, and examples come from the validators in @smallpen/core
// so this output and validation stay the same; a test applies every
// example to a workspace made by `smallpen init`.
import {
  SmallPenError,
  suggestField,
  vocabularyReference,
} from "@smallpen/core";
import { COMMAND_CONTRACTS, commandContract } from "./command-contract.mjs";
import { CLI_RULES } from "./workflow.mjs";
import { helpTopic, nextQuery } from "./help-topics.mjs";
import { pageItems } from "./read-output.mjs";
import {
  COMMAND_GROUPS,
  PUBLIC_COMMANDS,
  groupDefinition,
  actionContract,
} from "./command-tree.mjs";


// The node an Instance example adds; it is also step 4 of the worked
// example.
export const INSTANCE_NODE_EXAMPLE = Object.freeze({
  children: [],
  height: 48,
  id: "node_add_button",
  instance: {
    component: { assetId: "cmp_button", packageId: "pkg_acme" },
    variant: { axis_style: "primary" },
  },
  name: "Add button",
  type: "INSTANCE",
  width: 328,
  x: 16,
  y: 576,
});

export const INIT_ANSWERS_EXAMPLE = Object.freeze({
  audience: "Small teams",
  contextAxes: [
    {
      defaultValue: "Light",
      id: "axis_theme",
      kind: "theme",
      name: "Theme",
      values: ["Light", "Dark"],
    },
  ],
  firstJourney: "Add a task",
  firstOutput: "Task list screen",
  firstScenario: "Default",
  firstScreen: "Home",
  foundationChoice: "self-contained",
  initialComponents: ["Button"],
  initialTokens: ["color.brand", "spacing.md", "radius.md"],
  kindDetails: ["responsive"],
  platforms: ["mobile"],
  projectKind: "application",
  projectName: "Acme",
  purpose: "Track daily tasks",
  sourceInputs: ["none"],
});


// The value each Token type takes in tokens.css, its variable prefix and
// the classes that bind it, from the same vocabulary check uses.
const TOKEN_CSS_EXAMPLES = {
  color: "--color-brand: #2563eb;",
  spacing: "--spacing-4: 16px;",
  sizing: "--size-control: 40px;",
  "border-radius": "--radius-md: 8px;",
  "stroke-width": "--border-thin: 1px;",
  shadow: "--shadow-card: 0 2px 8px 0 #00000033;",
  opacity: "--opacity-muted: 0.6;",
  typography: '--type-label: 600 14px/1.4 "Source Sans Pro"; --type-label--tracking: 0.5px;',
  "font-family": '--font-body: "Source Sans Pro";',
  "font-weight": "--font-weight-bold: 700;",
  "font-size": "--text-sm: 12px;",
  "letter-spacing": "--tracking-wide: 0.5px;",
  string: '--string-save: "Save";',
  boolean: "--flag-show-badge: true;",
};

function tokenTypesTopic() {
  const vocabulary = vocabularyReference();
  return {
    types: Object.fromEntries(
      vocabulary.tokenPrefixes.map(({ variable, type }) => [
        type,
        {
          variable,
          example: TOKEN_CSS_EXAMPLES[type],
          classes: vocabulary.valueClasses.filter(({ tokens }) => tokens.includes(type)).map(({ prefix }) => `${prefix}*`),
          ...(type === "string" ? { attribute: "data-text" } : {}),
          ...(type === "boolean" ? { attribute: "data-visible" } : {}),
        },
      ]),
    ),
    alias: "Any Token can be var(--another-token) of the same type.",
    themes: ":root holds base values; :root[data-GROUP=\"option\"] blocks override them by name.",
  };
}

function initTopic() {
  return {
    summary:
      "Create a blank package: index.html (name, package id) and tokens.css. No Tokens, components or pages; add them as files and run smallpen check.",
    command: "smallpen init PATH [--name NAME] --json",
    path: "A .smallpen path creates that package directly. A directory creates PATH/NAME.smallpen inside it, NAME being --name in lower case with dashes (or the directory's name without --name).",
    existing: "Reject an existing target without changing its contents.",
    examples: [
      "smallpen init ./project.smallpen --name Example --json",
      "smallpen init ./new-workspace --name Example --json",
    ],
    nextOperations: [
      nextQuery(["schema", "command", "init", "--json"]),
      nextQuery(["help", "rules", "format", "--json"]),
    ],
  };
}

const TOPICS = {
  workflow: {
    build: () => CLI_RULES,
    summary: "CLI operation rules (compatibility alias for help rules)",
  },
  command: {
    summary:
      "One command's parameters, types, defaults and constraints (smallpen schema command NAME)",
  },
  commands: {
    build: () => ({
      commands: PUBLIC_COMMANDS.map(({ command: name, purpose }) => ({
        name,
        purpose,
      })),
      next: "smallpen schema command NAME --json",
    }),
    summary: "Command names and purposes; fetch one parameter schema at a time",
  },
  init: {
    build: initTopic,
    summary: "Blank package paths and creation behavior",
  },
  "token-types": {
    build: tokenTypesTopic,
    summary: "The value each Token type accepts",
  },
};

// Agents edit HTML files (help rules format); the schema describes only the
// read commands and Token values.
export const SCHEMA_TOPICS = Object.freeze(Object.keys(TOPICS));


export function schemaTopic(
  name,
  argument,
  { full = true, limit, offset = 0, action } = {},
) {
  if (name === undefined) {
    return {
      topics: Object.fromEntries(SCHEMA_TOPICS.map((topic) => [topic, TOPICS[topic].summary])),
      usage: "smallpen schema TOPIC [--json]; smallpen schema command OBJECT ACTION",
    };
  }
  if (name === "command") {
    if (Object.hasOwn(COMMAND_GROUPS, argument)) {
      if (groupDefinition(argument, action)) return { topic: name, ...helpTopic(argument, action) };
      return { topic: name, ...actionContract(argument, action) };
    }
    if (action !== undefined)
      throw new SmallPenError(
        "unexpected_argument",
        `Unexpected command action: ${action}`,
      );
    // Only public commands and the engines behind public actions have a
    // schema; the engines of removed write commands are not part of the CLI.
    const publicNames = new Set([
      ...PUBLIC_COMMANDS.map(({ command }) => command),
      ...Object.values(COMMAND_GROUPS).flatMap(({ actions }) => Object.values(actions).map(({ engine }) => engine)),
    ]);
    if (Object.hasOwn(COMMAND_CONTRACTS, argument ?? "") && !publicNames.has(argument)) {
      throw new SmallPenError("unknown_schema_command", `Unknown command: ${argument}`, {
        validCommands: PUBLIC_COMMANDS.map(({ command }) => command),
        nextOperations: [nextQuery(["schema", "commands", "--json"])],
      });
    }
    return { topic: name, ...commandContract(argument) };
  }
  if (!SCHEMA_TOPICS.includes(name)) {
    const suggestion = suggestField(name, [...SCHEMA_TOPICS]);
    throw new SmallPenError(
      "unknown_schema_topic",
      `Unknown schema topic: ${name}.${suggestion ? ` Did you mean ${suggestion}?` : ""} ` +
        `Topics: ${SCHEMA_TOPICS.join(", ")}`,
      {
        validTopics: [...SCHEMA_TOPICS],
        ...(suggestion ? { suggestion } : {}),
      },
    );
  }
  if (name === "workflow") return helpTopic("workflow", argument, { full });
  const value = TOPICS[name].build();
  if (argument !== undefined) {
    throw new SmallPenError(
      "unexpected_argument",
      `smallpen schema ${name} takes no further argument: ${argument}`,
      { argument },
    );
  }
  if (["commands", "operations"].includes(name)) {
    const items = value[name].map((item) => {
      if (full || name === "commands") return item;
      const { required: _required, requiresOneOf: _oneOf, ...summary } = item;
      return summary;
    });
    const page = pageItems(items, {
      limit: limit ?? (full ? items.length : 20),
      offset,
    });
    return {
      topic: name,
      [name]: page.items,
      page: page.page,
      nextOperations: [
        ...(page.page.hasMore
          ? [
              nextQuery([
                "schema",
                name,
                "--limit",
                String(page.page.limit),
                "--offset",
                String(offset + page.page.limit),
                ...(full ? ["--full"] : []),
                "--json",
              ]),
            ]
          : []),
        nextQuery([
          "schema",
          name === "commands" ? "command" : "operation",
          name === "commands" ? "<name>" : "<type>",
          "--json",
        ]),
      ],
    };
  }
  return { topic: name, ...value };
}
