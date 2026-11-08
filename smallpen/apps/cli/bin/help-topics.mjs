import { printText } from "./result-files.mjs";
import { SmallPenError, vocabularyReference } from "@smallpen/core";
import { commandContract } from "./command-contract.mjs";
import { CLI_RULES } from "./workflow.mjs";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMMAND_GROUPS,
  PUBLIC_COMMANDS,
  actionContract,
  inputQueries,
  groupRoute,
  groupDefinition,
  groupActions,
} from "./command-tree.mjs";

export const nextQuery = (argv) => ({ operation: `smallpen.${argv[0]}`, argv });
const query = (...argv) => nextQuery([...argv, "--json"]);
const rules = {
  start: [
    "Edit, check, look, ask what changed",
    () => CLI_RULES.start,
  ],
  project: [
    "Blank packages",
    () => [CLI_RULES.modelling.packages],
  ],
  flows: [
    "Prototype triggers and destinations",
    () => [CLI_RULES.actions.flows],
  ],
  validate: [
    "Check scope, problems and coverage",
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
    "Desktop, mobile and other platforms",
    () => [CLI_RULES.modelling.platforms],
  ],
  targets: [
    "Packages, pages and page versions",
    () => [CLI_RULES.modelling.packages, CLI_RULES.modelling.presentations],
  ],
  output: [
    "Spec, wireframe and PNG output",
    () =>
      Object.values(CLI_RULES.output)
        .filter((value) => typeof value === "string")
        .slice(0, 3),
  ],
  writes: [
    "Editing files, App saves and changes",
    () => [CLI_RULES.actions.settings, CLI_RULES.output.writes],
  ],
  format: [
    "Files, elements, attributes, sizing",
    () => formatReference(),
  ],
  classes: [
    "Token variables and classes",
    () => classReference(),
  ],
};

// The HTML format, from the same vocabulary check and the reader use.
function formatReference() {
  return [
    "Files: index.html (<title> name, <meta name=\"smallpen:package-id\">, theme defaults as data-GROUP on <html>, optional <meta name=\"smallpen:default-page\" content=\"Module/Page\">, <meta name=\"smallpen:canvas\" content=\"Name\"> for a canvas with no page yet); tokens.css; components/<Name>.html (only <sp-component> elements; one file may hold several); pages/[<Module>/]<Page>[.mobile|.tablet].html (a full HTML document; <head> holds meta, title and the tokens.css link); assets/ for images, assets/fonts/ for TTF/OTF/WOFF.",
    "Elements: <body> page root (desktop 1440x900, mobile 390x844, tablet 834x1194 unless w-/h- set); <div> container; <div data-shape=\"rectangle|ellipse|group|mask\"> (a mask's first child masks the rest and gives its size); <p> text with <span> runs and <br>; <img src>; <svg viewBox><path d></svg> (svg, ellipse, group and mask are page-only); <sp-use component props> a component copy whose children override named parts; <sp-component name props> with one shared element then <sp-variant when class> rules.",
    "Attributes: data-name (unique among siblings), data-text (string Token without --string-), data-visible (boolean Token without --flag-), data-flow and data-canvas on <body>. No style, <style> or <script>.",
    "Prototype: one attribute per trigger: data-click, data-press, data-hover, data-mouse-enter, data-mouse-leave, data-after-delay (boards only). Value: Module/Page, back, overlay:PAGE, toggle-overlay:PAGE, close-overlay[:PAGE] or an https/mailto/tel URL, then options after ;: delay: 1500ms; animation: dissolve|slide in|out left|right|up|down|push left 300ms ease-out [offset]; position: center|top-left|top-center|top-right|bottom-left|bottom-center|bottom-right|manual 20px 40px; relative-to: self (the element; on a copy's part, the copy)|page|an enclosing board or copy's name; close-outside; backdrop; preserve-scroll.",
    "Sizing: w-[n]/w-<size Token> fixed, w-fit hugs (flex and grid containers, copies, text), w-full fills a flex parent's room or a grid cell (allowed across a row or column; along it the parent must not hug; a hugging parent needs one child that does not fill); min/max apply to a filling axis. A copy without w-/h- is as big as its component. Unlike CSS, items-stretch does not resize children and grid rows do not stretch cards: give them h-full and size the rows (grid-rows-[160px]) or the cards. Without flex or grid, a container places children by left-[x]/top-[y]. Text hugs both axes by default; with a width it wraps and its height follows. Text without type-/font- is Source Sans Pro 14px, the built-in font; any other font needs @font-face in tokens.css and a file in assets/fonts/.",
    "Classes and Token variables: smallpen help rules classes.",
  ];
}

// Keyword families written once: items-{start|center|end|stretch}.
const KEYWORD_FAMILIES = [
  "mix-blend-", "pin-x-", "pin-y-", "justify-items-", "justify-self-", "justify-", "content-",
  "items-", "self-", "grid-flow-", "flex-", "border-", "stroke-", "text-", "align-", "viewer-", "overflow-", "flip-",
];

function compactKeywords(keywords) {
  const groups = new Map();
  for (const keyword of keywords) {
    const family = KEYWORD_FAMILIES.find((prefix) => keyword.startsWith(prefix) && keyword.length > prefix.length);
    const key = family ?? keyword;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(family ? keyword.slice(family.length) : "");
  }
  return [...groups].map(([key, rests]) => (rests.length === 1 && rests[0] === "" ? key : `${key}{${rests.join("|")}}`)).join(" ");
}

// Side families written once: border-{t|r|b|l}-*, p{x|y|t|r|b|l}-*.
function compactSides(text) {
  return text
    .replace("border-t-* border-r-* border-b-* border-l-*", "border-{t|r|b|l}-*")
    .replace("rounded-tl-* rounded-tr-* rounded-br-* rounded-bl-*", "rounded-{tl|tr|br|bl}-*")
    .replace("p-* px-* py-* pt-* pr-* pb-* pl-*", "p-* p{x|y|t|r|b|l}-*")
    .replace("m-* mx-* my-* mt-* mr-* mb-* ml-*", "m-* m{x|y|t|r|b|l}-*")
    .replace("min-w-* max-w-* min-h-* max-h-*", "{min|max}-{w|h}-*");
}

function classReference() {
  const vocabulary = vocabularyReference();
  const byExample = new Map();
  for (const { prefix, literal } of vocabulary.valueClasses) {
    const example = literal ? literal.slice(prefix.length) : "(Token only)";
    if (!byExample.has(example)) byExample.set(example, []);
    byExample.get(example).push(`${prefix}*`);
  }
  return [
    `Token variables: ${vocabulary.tokenPrefixes.map(({ variable, type }) => `${variable} ${type}`).join("; ")}. Values: px lengths, #hex colors, CSS box-shadow, font shorthand "600 14px/1.4 \"Family\"", quoted strings, true/false, var(--alias).`,
    `Value classes take a Token name without its type prefix or a bracket literal (spaces are _): ${compactSides([...byExample].map(([example, prefixes]) => `${prefixes.join(" ")} ${example}`).join("; "))}.`,
    "text-<Token> is a color or font-size Token by its type; border alone is 1px, border-b alone the bottom only. Fills and strokes, top first as in CSS: bg-[url(../assets/a.png)_0.8,linear-gradient(from_0.5_0_to_0.5_1,#000_0%,#fff_100%),var(--color-brand)]; border-[1px_#e5e7eb,2px_dashed_var(--color-brand)_outside] (width, color, optional solid|dashed|dotted|mixed and inside|center|outside). hidden keeps a layer but does not draw it, as the App's eye button: shadow-[0_2px_8px_0_#00000033_hidden], blur-[4px_hidden], a stroke in a list, or border-hidden for every stroke.",
    "Grid: grid with grid-cols-3 or grid-cols-[240px_1fr_auto_25%], grid-rows-*, grid-flow-row|col, justify-items-*, items-*, justify-*, content-*, gap-*, p-*. Children go in written order to the first free cell; col-start-N row-start-N place one, col-span-N row-span-N span, self-* and justify-self-* align it in its cell.",
    `Keyword classes: ${compactKeywords(vocabulary.keywords)}.`,
  ];
}

const inputs = {
  init: "init",
};
const notes = {
  view: [
    "Names the target: --page, --component, --token, --canvas or nothing for the whole package; --as text first.",
    "Component catalogs show representative samples; preview.components reports shownVariants, totalVariants and omittedVariants for each component. view PACKAGE --component NAME --as png shows all its variants. Component regions keep authored alpha without added backgrounds; component notes use larger bold text on transparent space, with no background or frame and clear separation from samples.",
  ],
  export: [
    "Three outputs: --format spec for implementation, wireframe for structure, png for appearance. --format png --evidence writes all three from one native layout. Compare layout.hash; image inspection requires an image-capable caller.",
    "Whole-component PNG/wireframe exports show every variant, matching view. --variant or --element selects one definition target. Whole-component sheet evidence describes a catalog layout; select a variant for its authored geometry and sources.",
    "--format html --canvas NAME --output DIR writes an offline page/state review with grouping, search, native PNG hotspots and local spec/evidence links. --page exports every version unless --platform selects one. No selector requires exactly one canvas. One theme combination is exported; unsupported prototype actions and unknown/hidden geometry stay unresolved. Existing output files and source Packages are never replaced.",
    "HTML renders each page in an isolated native worker and reports progress to stderr. The included project default page opens first; prototype starts are the fallback.",
  ],
  check: [
    "--render: a page checks every version and a component every variant unless --platform or --variant names one; read render.coverage and its skipped checks.",
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
    options: Object.values(contract.parameters).filter(({ hidden }) => !hidden).map(({ option }) => option),
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
        "Design by editing the package's HTML files directly (help rules format, help rules classes); read and search them as files. After every edit run check: it accepts the files that pass and rejects the ones with errors, and check --revert puts those back. check --render and view draw the design. Common rules: help rules.",
        "Scene guidance for complete designs and component/content previews: help skills.",
        "One .smallpen directory is one Canonical Package. Each call is independent; there is no current selection, current page, or cross-call session state.",
        "Reads start small. --full expands data; large results use a temporary resultFile with SHA-256. --stdout explicitly allows large stdout. Random names share one temporary folder; files older than 30 minutes are cleaned each invocation. --output retains exports.",
      ],
      commands: PUBLIC_COMMANDS,
      nextOperations: [query("help", "rules", "start")],
    };
  }
  if (Object.hasOwn(COMMAND_GROUPS, topic)) {
    const definition = groupDefinition(topic, section);
    if (definition)
      return {
        command: [topic, section].filter(Boolean).join(" "),
        purpose: definition.purpose,
        usage: `smallpen ${[topic, section].filter(Boolean).join(" ")} ACTION [arguments] [options]`,
        options: ["--help", "--json"],
        actions: groupActions(topic, section),
        nextOperations: [
          query("schema", "command", topic, ...(section?.split(" ") ?? [])),
        ],
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
      options: Object.values(contract.parameters).filter((p) => !p.hidden).map((p) => p.option),
      ...(engineNotes ? { notes: engineNotes } : {}),
      nextOperations: [
        query("schema", "command", ...route.name.split(" ")),
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
  if (topic === "skills") {
    if (section) return unknown(topic, section);
    const locations = [
      new URL("../../../skills/smallpen-ui-design/SKILL.md", import.meta.url),
      new URL("../skills/smallpen-ui-design/SKILL.md", import.meta.url),
    ];
    const path = fileURLToPath(locations.find(existsSync) ?? locations[1]);
    return {
      topic,
      purpose: "Skill guidance for complete screens and flows, reusable UI systems and content previews",
      skills: [{ name: "smallpen-ui-design", path, directory: dirname(path), available: existsSync(path) }],
      notes: [
        `Read ${path}, or install its directory with your AI host's Skill installer.`,
        "Load the Skill for the task; bundled files alone do not mean the AI loaded them. The Skill reads project specifications and uses CLI checks and native previews.",
      ],
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
  const value = options?.value ?? helpTopic(topic, section, options);
  if (["rules", "workflow"].includes(topic) && options?.full && !section) {
    printText(JSON.stringify(value, null, 2) + "\n");
    return;
  }
  const lines = [
    topic && topic !== "help"
      ? `SmallPen ${topic}${section ? ` ${section}` : ""}`
      : "SmallPen CLI",
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
  if (value.input) lines.push("Input details and example:", JSON.stringify(value.input, null, 2));
  for (const { argv, optional } of value.nextOperations ?? [])
    lines.push(`${optional ? "Details (optional)" : "Next"}: smallpen ${argv.join(" ")}`);
  printText(lines.filter(Boolean).join("\n") + "\n");
}
