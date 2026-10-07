import { printText } from "./result-files.mjs";
import { SmallPenError } from "@smallpen/core";
import { commandContract } from "./command-contract.mjs";
import { CLI_RULES } from "./workflow.mjs";
import {
  COMMAND_GROUPS,
  PUBLIC_COMMANDS,
  actionContract,
  inputQueries,
  groupRoute,
  publicGuidance,
} from "./command-tree.mjs";

export const nextQuery = (argv) => ({ operation: `smallpen.${argv[0]}`, argv });
const query = (...argv) => nextQuery([...argv, "--json"]);
const rules = {
  project: [
    "Blank packages and workspace ownership",
    () => [CLI_RULES.modelling.packages],
  ],
  flows: [
    "Prototype triggers and destinations",
    () => [CLI_RULES.actions.flows],
  ],
  validate: [
    "Check scope, issues and coverage",
    () => [CLI_RULES.actions.validate],
  ],
  themes: [
    "Temporary theme combinations and defaults",
    () =>
      Object.values(CLI_RULES.selection).filter(
        (value) => typeof value === "string",
      ),
  ],
  tokens: [
    "Token layers, rows and option values",
    () => [CLI_RULES.modelling.tokenLayers, CLI_RULES.modelling.tokenWrites],
  ],
  components: [
    "Component variants and generated design system",
    () => [
      CLI_RULES.modelling.componentVariants,
      CLI_RULES.modelling.designSystem,
    ],
  ],
  platforms: [
    "Desktop, mobile and other platforms: themes, variants or Presentations",
    () => [CLI_RULES.modelling.platforms],
  ],
  targets: [
    "Packages, Screens and Presentations",
    () => [CLI_RULES.modelling.packages, CLI_RULES.modelling.presentations],
  ],
  output: [
    "Small replies, text, wireframes and explicit images",
    () =>
      Object.values(CLI_RULES.output)
        .filter((value) => typeof value === "string")
        .slice(0, 3),
  ],
  writes: [
    "Atomic edits, retries and explicit reverse edits",
    () => [CLI_RULES.actions.settings, CLI_RULES.output.writes],
  ],
};

const inputs = {
  apply: "batch",
  init: "init",
  "import-tokens": "token",
};
const notes = {
  themes: [
    "Read available groups/options/defaults. This call resolves only its arguments; no selection is remembered.",
  ],
  view: [
    "Names the target: --page, --component, --token, --canvas or nothing for the whole package; --as text first.",
  ],
  export: [
    "Defaults to a text wireframe. Request --format png explicitly; image inspection requires an image-capable caller.",
  ],
  validate: [
    "A page checks every version and a component every variant unless --platform or --variant names one; read coverage and skipped checks.",
  ],
  "import-tokens": [
    "Review without --apply first. --dry-run takes precedence over --apply and never commits.",
  ],
};

export function commandOverview(name) {
  const contract = commandContract(name);
  const positional = contract.arguments.map(({ name, required }) =>
    required ? `<${name}>` : `[${name}]`,
  );
  const required = Object.values(contract.parameters)
    .filter((parameter) => parameter.required)
    .map(
      ({ option, type }) => `${option}${type === "boolean" ? "" : " <value>"}`,
    );
  return {
    command: name,
    purpose: contract.purpose,
    usage: ["smallpen", name, ...positional, ...required, "[options]"].join(
      " ",
    ),
    options: Object.values(contract.parameters).map(({ option }) => option),
    ...(notes[name] ? { notes: notes[name] } : {}),
    nextOperations: [
      query("schema", "command", name),
      ...(inputs[name] ? [query("schema", inputs[name])] : []),
    ],
  };
}

function unknown(topic, section) {
  throw new SmallPenError(
    "unknown_help_topic",
    `Unknown help topic: ${[topic, section].filter(Boolean).join(" ")}`,
    {
      nextOperations: [
        query(
          "help",
          ...(["workflow", "rules"].includes(topic) ? [topic] : []),
        ),
      ],
    },
  );
}

export function helpTopic(topic, section, { full = false } = {}) {
  if (!topic) {
    if (section) return unknown(topic, section);
    return {
      purpose: "Manage local SmallPen design packages",
      usage: "smallpen COMMAND [arguments] [options]",
      notes: [
        "Use help OBJECT to list actions, help OBJECT ACTION for usage, and schema command OBJECT ACTION for parameters and input queries. Common rules: help rules.",
        "One .smallpen directory is one Canonical Package. Each call is independent; there is no current selection, current page, or cross-call session state.",
        "Reads start small. --full expands data; large results use a temporary resultFile with SHA-256. --stdout explicitly allows large stdout. Random names share one temporary folder; files older than 30 minutes are cleaned each invocation. --output retains exports.",
      ],
      commands: PUBLIC_COMMANDS,
    };
  }
  if (Object.hasOwn(COMMAND_GROUPS, topic)) {
    if (!section)
      return {
        command: topic,
        purpose: COMMAND_GROUPS[topic].purpose,
        usage: `smallpen ${topic} ACTION [arguments] [options]`,
        options: ["--help", "--json"],
        actions: Object.entries(COMMAND_GROUPS[topic].actions)
          .filter(([, { hidden }]) => !hidden)
          .map(([action, { purpose }]) => ({ action, purpose })),
        nextOperations: [query("schema", "command", topic)],
      };
    const route = groupRoute(topic, section);
    const contract = actionContract(topic, section);
    const engineNotes = notes[route.engine];
    const required = Object.values(contract.parameters)
      .filter((p) => p.required)
      .map((p) => `${p.option} <value>`);
    return {
      command: route.name,
      purpose: route.purpose,
      usage: [
        "smallpen",
        route.name,
        ...contract.arguments.map((a) =>
          a.required ? `<${a.name}>` : `[${a.name}]`,
        ),
        ...required,
        "[options]",
      ].join(" "),
      options: Object.values(contract.parameters).map((p) => p.option),
      ...(engineNotes ? { notes: engineNotes } : {}),
      nextOperations: [
        query("schema", "command", topic, section),
        ...inputQueries(route),
      ],
      ...(full
        ? {
            parameters: contract.parameters,
            intentActions: contract.intentActions,
          }
        : {}),
    };
  }
  if (topic === "workflow") return helpTopic("rules", section, { full });
  if (topic === "rules") {
    if (full && !section) return CLI_RULES;
    if (section) {
      if (!Object.hasOwn(rules, section)) return unknown(topic, section);
      const [title, read] = rules[section];
      return { topic, id: section, title, notes: read() };
    }
    return {
      topic,
      rules: Object.entries(rules).map(([id, [title]]) => ({
        id,
        title,
        nextOperations: [query("help", "rules", id)],
      })),
    };
  }
  if (section) return unknown(topic, section);
  return commandOverview(topic);
}

export function printBriefHelp(topic, section, options) {
  const value = helpTopic(topic, section, options);
  if (["rules", "workflow"].includes(topic) && options?.full && !section) {
    printText(JSON.stringify(value, null, 2) + "\n");
    return;
  }
  const lines = [
    topic && topic !== "help"
      ? `SmallPen ${topic}${section ? ` ${section}` : ""}`
      : "SmallPen Canonical Package CLI",
    value.purpose ?? value.title ?? "",
    value.usage ? `Usage: ${value.usage}` : "",
  ];
  if (value.options) lines.push(`Options: ${value.options.join(" ")}`);
  lines.push(...(value.notes ?? []));
  if (value.guidance) lines.push(value.guidance);
  for (const entry of value.stages ?? value.rules ?? [])
    lines.push(
      `${entry.id}: ${entry.title}`,
      `  smallpen ${entry.nextOperations[0].argv.join(" ")}`,
    );
  for (const { command, purpose } of value.commands ?? [])
    lines.push(`  ${command.padEnd(20)} ${purpose}`);
  for (const { action, purpose } of value.actions ?? [])
    lines.push(`  ${action.padEnd(20)} ${purpose}`);
  for (const { argv } of value.nextOperations ?? [])
    lines.push(`Next: smallpen ${argv.join(" ")}`);
  printText(lines.filter(Boolean).join("\n") + "\n");
}
