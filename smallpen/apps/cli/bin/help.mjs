import {
  COMMAND_CONTRACTS,
  commandContract,
  commandHelp,
} from "./command-contract.mjs";
import { commandOverview, helpTopic, printBriefHelp } from "./help-topics.mjs";
import { schemaTopic } from "./schema.mjs";
import { printText } from "./result-files.mjs";
import { COMMAND_GROUPS, publicArgv } from "./command-tree.mjs";

const COMMANDS = Object.entries(COMMAND_CONTRACTS).map(
  ([name, { purpose }]) => [name, purpose],
);
// What help lists: every grouped action and the shared commands.
const PUBLIC_PATHS = [
  ...Object.entries(COMMAND_GROUPS).flatMap(([group, { actions }]) =>
    Object.entries(actions).map(([action, { purpose }]) => [`${group} ${action}`, purpose]),
  ),
  ...["init", "check", "view", "changes", "export", "help", "schema", "version"].map((name) => [name, COMMAND_CONTRACTS[name].purpose]),
];
// Help texts are kept per engine; they print with the grouped path a caller
// types ("smallpen tokens" reads "smallpen token list").
const publicName = (name) => publicArgv([name]).join(" ");
const publicText = (text) =>
  text.replace(/\b(smallpen|SmallPen) ([a-z][a-z-]*)/g, (match, word, name) =>
    Object.hasOwn(COMMAND_CONTRACTS, name) ? `${word} ${publicName(name)}` : match);

// init's input details fit in its help reply; the schema query stays
// an optional detail rather than a required discovery step.
export function helpWithInput(topic, section, options) {
  const value = helpTopic(topic, section, options);
  if (value.command !== "init") return value;
  const { intentExample, ...input } = schemaTopic("init");
  if (intentExample) input.example = intentExample;
  return {
    ...value,
    input,
    nextOperations: value.nextOperations.map((query) => ({ ...query, optional: true })),
  };
}

const HELP = {
  help: `Usage:
  smallpen help [OBJECT [GROUP] [ACTION]|rules [TOPIC]] [--json]

Use COMMAND --help for options, or schema for JSON input shapes. Use help rules for shared operation rules; schema command OBJECT ACTION
describes one command at a time.`,
  view: `Usage:
  smallpen view PACKAGE [what] [--as text|spec|wireframe|png|issues] [--theme G/O]...

Look at anything by name; no IDs. What:
  (nothing)                      the whole package: themes, Tokens, components, pages
  --tokens | --token color       every Token, or those under a name
  --components                   every component
  --component Button             one component: every variant
    [--variant "Style: secondary"] [--element Label]  one variant, one part of it
  --pages [--platform mobile]    every page
  --page Board                   one page ("Board" or "Tasks / Board")
    [--platform mobile] [--element "Top bar"]          one version, one part of it
Three design outputs: spec for implementation and provenance, wireframe for
spatial orientation, PNG for high-fidelity appearance. --as spec reports actual
bounds separately from fixed/fill/hug constraints, Token/component sources and
node diagnostics. --element expands details. Compare layout.hash and selection
across outputs. ?/partial means unresolved; never implement from seed geometry.
--as text (default) is a compact navigation outline; issues lists layout, text
and contrast problems. Tokens have text, wireframe and png. Specifications
target one page/component; choose a target before requesting --as spec.
--theme Group/Option shows values under that option for this call only.
Large results go to a file. Unknown names fail with the names that exist;
"Name [2]" picks one of a name stored twice.
Next: changes PACKAGE --since REVISION after someone edits the design.`,
  "token-export": `Usage:
  smallpen token export PACKAGE [--type TYPE] [--token PREFIX] [--by GROUP]
                        [--format json|flat] [--theme G/O]... [--output DIR] [--json]

Export resolved Token values as JSON. --by GROUP writes one file
per option of that theme group, named after the option (--type string
--by Language with options English and Chinese -> English.json, Chinese.json);
without it one file, tokens.json, holds the values of the selected themes
(project defaults, or --theme). json nests by name
(text.task.new -> {"text":{"task":{"new":...}}}); flat keeps one key per name.
Other groups use the project defaults or --theme.`,
  changes: `Usage:
  smallpen changes PACKAGE [--since REVISION] [--limit N] [--full] [--json]

What changed since a revision you saw, by name: themes, Tokens (with values),
components (per variant and element) and pages (per platform and element),
including edits a person made in the App. Every read and write reports a
revision; keep the latest one and pass it as --since to align code with the
design. Without --since: the most recent edits, who made them (app or cli) and
the revision before each. --full adds the structured list. Nothing is stored
for the caller.`,
  export: `Usage:
  smallpen export PACKAGE [--page P [--platform X] [--element E]]
                  [--component C [--variant V] [--element E]] [--design-system]
                  [--format text|spec|wireframe|png] [--output FILE] [--scale N] [--json]
  smallpen export PACKAGE --format html [--canvas NAME | --page P [--platform X]]
                  --output DIR [--theme GROUP/OPTION] [--json]

Save a specification (implementation), wireframe (structure, default) or PNG
(appearance), named the way view names it. Nothing named is the main page.
Read --format spec before implementation; inspect PNG only when the caller
can see images. Text files contain LF newlines and alignment spaces.
Missing --output uses a temporary file. Returns path, hash, bytes, target,
themes and revisions. --design-system exports the generated Token/component
page; do not write a copy of it. --format png --evidence writes PNG, .spec.txt,
.wireframe.txt and JSON evidence from one native layout snapshot. Read skipped
coverage; untested sizes/states and undeclared business rules remain unknown.

HTML exports all page versions on one canvas (or all versions of --page unless
--platform selects one), with grouping, search, native PNG hotspots, back/forward
navigation and local spec/wireframe/evidence links. With no selector, exactly one
canvas must exist. One theme combination is rendered, not every theme.
Only declared click/navigate to exported page roots and click/prev-screen run;
other actions, hidden sources and missing geometry are unresolved in manifest.json.
No business input, persistence or recording is simulated. DIR must be new/empty
and outside source Packages. Existing files are never cleared; index is written
only after all native artifacts and the manifest. Open index.html offline.`,
  version: `Usage:
  smallpen version [--json]

Output:
  JSON {name,version} for the installed CLI package.
  No package path is required; design files are unchanged and no services start.`,
  schema: `Usage:
  smallpen schema [TOPIC] [--json]
  smallpen schema command OBJECT ACTION [--json]

Purpose:
  Print each read command's parameters, types, allowed values and defaults.
  No package is opened. The package itself is HTML files: smallpen help rules
  format and smallpen help rules classes describe them.

Topics:
  command NAME   one command: parameters, types, defaults and constraints
  commands       command names and purposes
  token-types    the value each Token type accepts
  init           blank package paths and creation behavior
  workflow       the common rules (same as smallpen help rules)

Examples:
  smallpen schema commands
  smallpen schema command view
  smallpen schema token-types`,
  init: `Usage:
  smallpen init PATH [--name NAME] [--json]

Create a blank package immediately: index.html (name, package id) and
tokens.css. PATH ending in .smallpen creates that package; a directory creates
a new workspace containing a package. There are no Tokens, components or pages;
add them as files (smallpen help rules format) and run smallpen check.
Existing targets are rejected. No business questionnaire or saved state.

Examples:
  smallpen init ./acme.smallpen --name Acme --json
  smallpen init ./acme --json

Next: smallpen schema command init --json`,

  tokens: `Usage:
  smallpen tokens <package.smallpen> [--theme GROUP/NAME]...
                  [--offset N] [--limit N] [--locale LOCALE] [--full] [--json]
  smallpen tokens <package.smallpen> --definitions [--group GROUP]
                  [--offset N] [--limit N] [--full] [--json]

Purpose:
  List resolved Tokens: the :root values of tokens.css, with each theme group's
  selected option block on top. themes[] lists every option and whether it is
  selected.
  --theme selects themes for this read only (one per group); unknown groups or
  names exit unknown_token_theme with validThemes. labels follow --locale or the
  environment. Default: 20 items with target, Token id/path/type and resolved
  value, plus page.total/hasMore. --full includes every definition and source chain.
  --definitions reads the value each option block stores, with its group and
  option. Optional --group filters one theme group.
  Missing cells have no item; they do not inherit Default. This mode cannot take
  --theme. Use the ordinary tokens read to resolve a combination.`,
};

export function printHelp(command, { full = false, route, input } = {}) {
  const say = (text) => printText(publicText(text));
  const name = route?.name ?? command;
  if (Object.hasOwn(COMMAND_GROUPS, command) || !command) {
    printBriefHelp(command, undefined, { full });
    say(
      "\nOptions: -h, --help; --version\nUse smallpen help OBJECT ACTION for options. Common rules: smallpen help rules\n",
    );
    return;
  }
  if (!full) {
    if (!command) {
      printBriefHelp();
      say(
        "\nOptions: -h, --help; --version\nUse smallpen COMMAND --help for options. Common rules: smallpen help rules\n",
      );
    } else
      say(
        `SmallPen ${command}\n\n${commandContract(command).purpose}\n\nUsage: smallpen ${command} ${commandContract(
          command,
        )
          .arguments.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`))
          .join(
            " ",
          )} [options]\n\n${commandHelp(command)}\n\nInput shapes: smallpen schema command ${command} --json\n`,
      );
    if (command && commandOverview(command).notes)
      say(commandOverview(command).notes.join("\n") + "\n");
    return;
  }
  const guidance = commandGuidance(command, route);
  if (command && guidance) {
    say(`SmallPen ${name}\n\n${guidance}

${commandHelp(name)}

Common output and error contract:
  Default JSON is compact and bounded to 8 KiB. Large complete results are saved
  to resultFile.path with bytes/SHA-256; stdout retains status and write receipts.
  Search/read the JSON with jq or your file tools, and text with rg/sed.
  Each call uses random filenames of a fixed format in one system temporary
  folder: smallpen-TIMESTAMP-UUID-KIND.ext. Every invocation cleans CLI files
  whose mtime is older than 30 minutes; active calls are protected.
  --output chooses a retained file. Lists default to 20 items; --full expands data
  but still uses files for large results. --stdout opts into large stdout.
  --base64 explicitly requests inline image bytes; PNG paths are the default.
  --json emits stable English keys; localized labels remain additional data and
  follow --locale where offered, else LC_ALL, LC_MESSAGES, or LANG (zh* selects
  Chinese, anything else English). Success
  exits 0. Errors exit 1 as {error:{code,message,details,writeState}} and include exact
  nextOperations when recovery requires refresh, replay, Repair, or confirmation.
  Unknown options are not part of the command contract shown above. Only options
  shown with ..., repeated, or described as repeatable may appear more than once;
  any other option given twice exits duplicate_option.

Help / next:
  smallpen --help
  smallpen ${name} --help
`);
    if (input) printText(`\nInput details and example:\n${JSON.stringify(input, null, 2)}\n`);
    return;
  }
  say(`SmallPen CLI

Model:
  One .smallpen directory is one Canonical Package: a folder of HTML files.
  index.html names it and holds theme defaults; tokens.css holds the Tokens
  and theme options; components/*.html the components and their variants;
  pages/<Module>/<Page>[.mobile|.tablet].html the pages; assets/ images and
  fonts. Read, search and edit these files directly (several agents may work
  on different files at once), then run smallpen check. The App
  (Penpot) opens the same folder and writes its edits back to these files.
  Each call is independent; there is no current selection, current page, or
  cross-call session state. No PostgreSQL, collaboration server, MCP, or
  built-in AI Chat is required.

CLI entry point:
  smallpen help
  smallpen help rules format
  smallpen help rules classes
  smallpen schema command NAME --json
  CLI usage is complete without a Skill. Scene Skills supply task-specific rules.

The loop:
  init        Create a blank package.
  check       After every edit: one line per problem, file:line:column, with
              the fix. --render also draws the pages and components and adds
              text overflow, bounds, overlap and contrast problems. Exit code 1
              on errors only.
  view        Navigate with text; implement with spec; orient with wireframe;
              inspect appearance with PNG. Choose one page/component/region.
  export      Spec, wireframe, PNG, an offline HTML review, the Design System
              page.
  changes     What changed since a revision you saw, by name, including edits
              made in the App.
  token       Resolved Token values per theme (aliases and theme blocks
              applied) and exports for application code.
  Three design outputs: spec for implementation and provenance; wireframe for
  structure; PNG for appearance. --format png --evidence writes all three from
  one native solve. Match layout.hash and selection; read unknowns and coverage.
  export defaults to a text wireframe; PNG requires --format png. Text-only
  models may export PNG deliverables but must not claim visual inspection.

Usage:
  smallpen <command> [arguments] [--json]
  smallpen <command> --help
  smallpen version --json

Commands:
${PUBLIC_PATHS.map(([name, summary]) => `  ${name.padEnd(24)} ${summary}`).join("\n")}

Query examples:
  smallpen init ./acme --json
  smallpen check ./acme/acme.smallpen
  smallpen check ./acme/acme.smallpen --render --page "Tasks/Board"
  smallpen token list ./acme/acme.smallpen --theme mode/dark --json
  smallpen view ./acme/acme.smallpen --page Board --as png --json
  smallpen changes ./acme/acme.smallpen --since REVISION --json
  smallpen export ./acme/acme.smallpen --format png --json
  smallpen export ./acme/acme.smallpen --design-system --json

Output:
  Defaults are summaries and artifact paths (8 KiB budget). JSON is compact.
  --full requests complete data; --base64 requests image
  bytes. smallpen schema returns cliVersion/contractRevision for stable contract
  caching. Package reads return revision; cache a view by that revision plus its
  selectors, theme and locale.

Run smallpen <command> --help for syntax, defaults, values, examples, outputs,
errors, and relevant next commands.
`);
}

export const COMMAND_NAMES = Object.freeze(COMMANDS.map(([name]) => name));
export function commandGuidance(command, route) {
  if (route && (route.fixed || !HELP[command])) {
    const contract = commandContract(route.name);
    const args = contract.arguments.map(({ name, required }) => required ? `<${name}>` : `[${name}]`).join(" ");
    return `Usage:\n  smallpen ${route.name} ${args} [options]\n\n${route.purpose}`;
  }
  return HELP[command] ? publicText(HELP[command]) : undefined;
}
