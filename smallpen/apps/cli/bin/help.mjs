import {
  COMMAND_CONTRACTS,
  commandContract,
  commandHelp,
} from "./command-contract.mjs";
import { commandOverview, printBriefHelp } from "./help-topics.mjs";
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
  ...["view", "changes", "export", "validate", "help", "schema", "version"].map((name) => [name, COMMAND_CONTRACTS[name].purpose]),
];
// Help texts are kept per engine; they print with the grouped path a caller
// types ("smallpen apply" reads "smallpen advanced apply").
const publicName = (name) => publicArgv([name]).join(" ");
const publicText = (text) =>
  text.replace(/\b(smallpen|SmallPen) ([a-z][a-z-]*)/g, (match, word, name) =>
    Object.hasOwn(COMMAND_CONTRACTS, name) ? `${word} ${publicName(name)}` : match);

const WRITE_REPLY = `Reply size:
  Default: batchId, revision, changed/alreadyApplied/dryRun, counts, warnings,
  and summary. changeReportPath records exact before/after values. reverseEdit
  describes an explicit new write at the confirmed revision; inverseBatchPath
  locates its JSON. This does not rewind history. --inverse-out FILE chooses a
  durable caller-owned file (only when the batch commits). --compact is default.
  --full includes inverseBatch, guidance, and exact before/after diff values.
  After later edits, read current values and restore intended fields in a new
  scoped edit. Never force an old snapshot by replacing its baseRevision.
  For safe retries choose batchId before the first call and reuse it with the
  same input. The local ledger retains at most 500 batch identities.
  smallpen apply PACKAGE --batch FILE --inverse-out FILE.reverse.json`;

const HELP = {
  assets: `Usage:
  smallpen advanced style list PACKAGE [--kind colors|typographies]
                 [--limit N] [--offset N] [--json]

Read the App's stored color and typography assets. Use token for design values
and token theme for their options and defaults. File assets are managed through
asset media and asset font. Write styles in their owning package.`,
  help: `Usage:
  smallpen help [OBJECT [GROUP] [ACTION]|rules [TOPIC]] [--json]

Use COMMAND --help for options, or schema for JSON input shapes. Use help rules for shared operation rules; schema command OBJECT ACTION
describes one command at a time.`,
  themes: `Usage:
  smallpen token theme list PACKAGE [--theme GROUP/NAME]... [--json]

Read project-defined groups, options (named Group/Option), defaults and this
call's selection. This is a lightweight settings query, with no Token inventory.
selection and option active flags mean this command's parameters and defaults,
never a previous CLI call. The stored App selection is unrelated to this query
and omitted by default; --full includes appSelection for explicit inspection.
It never supplies the CLI defaults.
No --theme uses project defaults; App current selection is independent.
--theme overrides only named groups. No data or App state is written.
Write: token theme add|rename|default|delete --theme Group/Option.`,
  view: `Usage:
  smallpen view PACKAGE [what] [--as text|wireframe|png|issues] [--theme G/O]...

Look at anything by name; no IDs. What:
  (nothing)                      the whole package: themes, Tokens, components, pages
  --tokens | --token color       every Token, or those under a name
  --components                   every component
  --component Button             one component: every variant
    [--variant "Style=secondary"] [--element Label]   one variant, one part of it
  --pages [--platform mobile]    every page
  --page Board                   one page ("Board" or "Tasks / Board")
    [--platform mobile] [--element "Top bar"]          one version, one part of it
--as text (default) is a compact outline; wireframe is a text drawing of regions;
png writes an image (inspect it only if you can see images); issues lists layout,
text and contrast problems by element. Tokens have text, wireframe and png.
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
                  [--format text|wireframe|png] [--output FILE] [--scale N] [--json]

Save a page, component or region as a text wireframe (default) or a PNG file,
named the way view names it. Nothing named is the main page. Request PNG with
--format png; read text and wireframes first, and inspect PNG only when the
caller can see images. Text files contain LF newlines and alignment spaces.
Missing --output uses a temporary file. Returns path, hash, bytes, target,
themes and revisions. --design-system exports the generated Token/component
page; do not draw a copy. --evidence adds review evidence to a page PNG.`,
  version: `Usage:
  smallpen version [--json]

Output:
  JSON {name,version} for the installed CLI package.
  No package path is required; design files are unchanged and no services start.`,
  schema: `Usage:
  smallpen schema [TOPIC] [--json]
  smallpen schema operation TYPE [--json]

Purpose:
  Print the exact JSON that apply, token, page, flow, and init accept: fields,
  types, allowed values, a valid example, and the inverse each operation
  returns. No package is opened. Field lists come from the validators, and every
  example is tested against a workspace made by smallpen init.

Topics:
  command NAME   one command: parameters, types, defaults and constraints
  commands       command names and purposes
  operations     every operation type, its purpose, Package, required fields
  operation TYPE one operation in full
  batch          batch contract, Foundation vs Product, worked example
  node           node fields, textStyle, tokenBindings
  node-types     what each node type requires
  token          Tokens in token sets, DTCG files, bindings
  theme          token sets and themes, --theme, Foundation + Product themes
  token-types    the value each Token type accepts
  component-set  Component Set, Axis roles (configuration, state), variants
  instance       INSTANCE nodes and overrides
  presentation   Presentation fields, size, and resizing
  screen         Screen fields
  scenario       Scenario fields and viewport
  context        Context Axes (viewport, density, locale, ...)
  init           blank package paths, layouts and creation behavior

Examples:
  smallpen schema operations
  smallpen schema operation update-component-node
  smallpen schema component-set`,
  init: `Usage:
  smallpen project init PATH [--name NAME] [--layout single|foundation-product] [--json]

Create a blank package immediately. PATH ending in .smallpen creates that
package; a directory creates a new workspace containing a package. The default
is one self-contained package with one canvas and Theme/Default, no Tokens,
components, business flows or platform copies. Existing targets are rejected.
--layout foundation-product creates two blank packages with a local dependency.
No business questionnaire, saved selection or initialization state is required.

Examples:
  smallpen project init ./acme.smallpen --name Acme --json
  smallpen project init ./acme --layout foundation-product --json

Next: smallpen schema command project init --json`,

  validate: `Usage:
  smallpen validate PACKAGE [--page P [--platform X] [--element E]]
                    [--component C [--variant V] [--element E]] [--design-system]
                    [--theme G/O]... [--limit N] [--offset N] [--json]

Purpose:
  Validate the stored data, references and the Product/Foundation dependency,
  and check text fit, bounds, overlaps and contrast for the target. A page
  checks every version unless --platform names one; a component every variant
  unless --variant names one. Nothing named checks the main page and lists
  names stored twice.

Output:
  status/dataStatus valid means the data and references are valid. Visual
  issues are separate: read visualStatus, issueCount, issues and
  coverage.skipped. Valid data is not visual approval. Issue pagination does
  not shrink coverage. Dependency conflicts return repair_required with exact
  choices. view --as issues gives the same issues by element name.

Next:
  smallpen view <package> --as issues --json
  smallpen project repair <product> --json`,
  inspect: `Usage:
  smallpen inspect <package.smallpen> [--json]

Purpose:
  Return Package identity, revision, and domain counts. --full includes all
  domain summaries and format capabilities.

Next:
  smallpen view <package> --json`,
  list: `Usage:
  smallpen list <package.smallpen> [--kind KIND] [--offset N] [--limit N] [--json]

Values:
  KIND: all|screens|presentations|contexts|tokens|components|scenarios|requirements|flows
  Defaults: kind=all, offset=0, limit=20. Return identities and counts, without
  node trees or variants. page includes total/hasMore; --full includes definitions.
  Default item fields follow the public allowlist in schema command list.
  Descriptions and editor root IDs belong to target reads, not this directory.
  Omit visibility=public and deprecated=false. Only report private visibility,
  actual deprecation and a configured replacement when they affect reuse.
  JSON is compact in all modes; --full adds data, not pretty-printing.

Next:
  Look at one by name: smallpen view <package> --page NAME | --component NAME.`,
  catalog: `Usage:
  smallpen catalog <product.smallpen> [--context AXIS=VALUE]... [--theme GROUP/NAME]...
                   [--offset N] [--limit N] [--full] [--json]

Purpose:
  Return Component identities (limit=20) and domain counts. Use component for one
  candidate's legal selections, tokens/search-tokens for values, or --full for
  the complete Catalog. Token definitions, effective values and inventory are
  not repeated in the default response. Default items use the same public
  discovery fields as list; descriptions require a target read.`,
  "search-components": `Usage:
  smallpen search-components <product.smallpen> --query TEXT [--limit N] [--json]

Purpose:
  Find reusable Product, public Foundation, and linked Library components before
  drawing a custom replacement. Matches stable ID, name, category, and description and returns the
  owning Package, source layer, variant count, and an executable
  owner-scoped component command (argv plus a POSIX-shell command).
  Default candidates use the public discovery fields; read component for
  descriptions and legal choices. Private reuse restrictions remain explicit.

State:
  Every query is explicit and self-contained. It never creates a current component
  or affects a later command.`,
  tokens: `Usage:
  smallpen tokens <package.smallpen> [--theme GROUP/NAME]... [--context AXIS=VALUE]...
                  [--offset N] [--limit N] [--locale LOCALE] [--full] [--json]
  smallpen tokens <package.smallpen> --definitions [--group GROUP]
                  [--offset N] [--limit N] [--full] [--json]

Purpose:
  List Effective Tokens: the active token sets of the selected themes (a later
  set overrides an earlier one by name; a Product's own sets sit on top of its
  Foundation's), then Context specificity for legacy contextValues. themes[]
  lists every theme with active, owner (package|foundation) and its sets.
  --theme selects themes for this read only (one per group); unknown groups or
  names exit unknown_token_theme with validThemes. labels follow --locale or the
  environment. Default: 20 items with target, Token id/path/type and resolved
  value, plus page.total/hasMore. --full includes every definition and source chain.
  --definitions reads exact stored Tokens in every option Set, with owning
  packageId, setId, group and option. Optional --group filters the App Set group.
  Missing cells have no item; they do not inherit Default. This mode cannot take
  --theme or --context. Use the ordinary tokens read to resolve a combination.`,
  "search-tokens": `Usage:
  smallpen search-tokens <product.smallpen> (--color COLOR | --value JSON | --query TEXT | --type TYPE)
                         [--context AXIS=VALUE]... [--theme GROUP/NAME]... [--all-themes]
                         [--limit N] [--json]

Purpose:
  Find reusable Product and Foundation Design Tokens before writing a hard-coded
  design value. Color and numeric searches rank exact matches first, then nearest
  values. Without --context, every finite Web/Desktop/theme/etc. Context is searched
  and each resolved value reports its matching Contexts. Repeating --context restricts
  the search explicitly. Name queries match Token path, description, and type.
  Token themes: by default project defaults are searched; --theme overrides only
  named groups, as every resolved read does. --all-themes searches every
  selection of one theme per group (at most 64) and gives each item themes[],
  the selections where it has that value. themeScope {mode active|explicit|all,
  selections} says which themes were searched.

Examples:
  smallpen search-tokens product.smallpen --color '#6750a4' --json
  smallpen search-tokens product.smallpen --type spacing --value 16 --json
  smallpen search-tokens product.smallpen --query surface --json

State:
  Every search is self-contained. It never reads or writes a current selection,
  previous result, session, or Web UI state.`,
  "effective-token": `Usage:
  smallpen token show <package.smallpen> --path TOKEN.NAME
                      [--theme GROUP/NAME]... [--json]

Defaults:
  Themes use project defaults, independently of the App's active selection.
  --theme overrides only named groups.`,
  "explain-token": `Usage:
  smallpen token explain <package.smallpen> --path TOKEN.NAME
                         [--theme GROUP/NAME]... [--json]

Output:
  Chosen source/value plus all candidates, specificity, rejection reasons, and layer.`,
  "import-media": `Usage:
  smallpen asset media import <package.smallpen> --file MEDIA_FILE
                        [--media-path PATH] [--name NAME] [--json]

Import is the public binary Media entry for an existing Product: PNG, JPEG, GIF,
WebP, and SVG are detected from bytes, dimensions are validated, and the blob is
content-addressed (identical bytes in one package share one blob). JSON apply
still forbids blob writes; asset media import is a file entry, not a batch operation.
asset media delete --media NAME deletes the descriptor; the content-addressed blob
itself is immutable and shared.

Errors and recovery:
  Corrupt or unsupported bytes exit 1 invalid_media_file and write nothing.

Output:
  descriptor and revision, plus batchId and the revision-guarded reverse edit (inverseBatch).

`,
  "import-font": `Usage:
  smallpen asset font import <package.smallpen> --file FONT_FILE --family NAME
                      [--weight 400] [--style normal] [--name NAME] [--json]

Public Font entry for an existing Product. TTF and OTF are validated by SFNT
signature and converted to WOFF (the renderer loads ttf/otf/woff). WOFF imports
as-is after table validation. A valid WOFF2 reaches an explicit
unsupported_font_conversion boundary (no WOFF2 decoder is bundled); corrupt
fonts fail invalid_font_blob. Either way nothing is written. Success returns
the family, files, revision, batchId, and the exact inverseBatch. Use the
family by name: "fontFamily": "Inter", or a font-family Token.

`,
  "library-refresh": `Usage:
  smallpen library-refresh <package.smallpen> [--library PACKAGE_ID|URL] [--json]

Explicitly re-fetches one declared URL Library from its origin into the same
verified cache. The refreshed snapshot must match the declared Package ID; a
mismatch exits library_id_mismatch with expected/actual identities and leaves the
previous verified snapshot readable offline. Success reports before/after
revisions; failures keep the previous revision.

When a fetch fails and a verified cache exists, the command exits 0 with
after.cache "stale", the cached revision, and after.warning naming the cause.
With no cache the Library cannot resolve: the command exits repair_required
with a library_unavailable conflict whose message names the cause. Requests
follow at most five redirects, only within the Library's origin; each file
is capped at 50 MB.

`,
  "import-draft": `Usage:
  smallpen import-draft <new-draft.smallpen> --kind figma|svg|png --input FILE
                        [--package-id PKG] [--json]

Purpose:
  Create one new, independent .smallpen Draft file. Figma structured clipboard HTML
  is decoded first; SVG and PNG preserve the source bytes as flat IMAGE fallbacks.
  Provenance and a Loss Report are canonical Draft metadata.

Safety:
  The output must not already exist. Import never opens or modifies a Product or
  Foundation file and reimport always creates another Draft file.

Next:
  smallpen draft-diff earlier.smallpen --after reimport.smallpen --json
  smallpen draft-compile product.smallpen --draft reimport.smallpen --selections selections.json --json`,
  "import-tokens": `Usage:
  smallpen import-tokens <package.smallpen> --input TOKENS.json [--set-name NAME]
                         [--select SET/NAME]... [--apply] [--dry-run]
                         [--batch-id ID] [--compact] [--inverse-out FILE] [--json]

Purpose:
  Import a DTCG token file (Penpot or Tokens Studio export, single-set, multi-set
  with $themes/$metadata, or legacy value/type) into the package's Penpot-shaped
  Token Library. Without --apply the command only reviews: it prints the diff of
  tokens, sets, and themes that would be added, changed, or removed (counts and
  up to 20 identities per action). --full includes the replacement library and
  exact before/after values.
  --dry-run keeps the operation in no-write review mode even with --apply;
  that combination also validates the prepared Operation Batch without committing.

Identity:
  Sets match by name, tokens by set name plus token name, themes by group/name.
  Matching entries keep their existing ids; everything else gets a fresh id.
  --select limits the applied token rows to the listed "set/name" keys; an
  unselected change keeps its current value, an unselected addition is dropped,
  an unselected removal is kept. Sets and themes always follow the file.

Types:
  DTCG $type names (borderRadius, fontFamilies, borderWidth, ...) are mapped to
  SmallPen types. Tokens with unsupported types are skipped and reported in
  warnings. --set-name names the single set of a file without $themes/$metadata.

Output:
  Review: {diff, warnings, library, dryRun:true}. With --apply: the atomic apply
  result plus the same diff and warnings. With --apply --dry-run: the prepared
  batch result, diff, warnings, and dryRun:true (not the review library field).`,
  "draft-diff": `Usage:
  smallpen draft-diff <before-draft.smallpen> --after AFTER.smallpen [--json]

Purpose:
  Compare semantic projections and Loss Reports from two independent Draft files.
  Neither Draft nor any Canonical Product is modified.`,
  "draft-compile": `Usage:
  smallpen draft-compile <canonical.smallpen> --draft DRAFT.smallpen
                         --selections FILE [--batch-id ID] [--json]

Selections:
  JSON array of explicit matching nodes and fields, for example:
  [{"screenId":"scr_home","nodeId":"node_title","fields":["text","x"]}]

Output:
  A typed Operation Batch whose baseRevision is the current Canonical revision.
  This command does not apply the batch. Review it, then use smallpen apply.`,
  impact: `Usage:
  smallpen token impact <package.smallpen> --path TOKEN.NAME [--json]

Purpose:
  Find every element whose bindings use the Token, by page, component and
  element, so an Agent can see what a change touches before making it.
  Foundation Tokens are resolved through the Product dependency.`,
  apply: `Usage:
  smallpen apply <package.smallpen> --batch BATCH.json [--dry-run] [--explain] [--diff]
                 [--warning-detail compact|full] [--confirm-unmatched]
                 [--compact] [--inverse-out FILE] [--json]

Batch contract:
  {"baseRevision":"...","batchId":"unique-id","operations":[...]}
  baseRevision is package.revision from smallpen inspect PACKAGE --json.
  The whole candidate validates and commits atomically. Success returns revision,
  affected stable IDs/files, a revision-guarded reverse edit, and changed
  (false, with noChange, when the batch leaves the Package as it was).
  Revisions are content hashes, not increasing counters: restoring the exact
  Canonical content restores its previous revision.

Operations:
  smallpen schema operations         every type, purpose, Package, required fields
  smallpen schema operation TYPE     fields, allowed values, example, inverse
  Unknown operation types and unknown fields are rejected, with a suggestion.
  In the default layout everything goes to the one Package. In the
  foundation-product layout Tokens, themes, Context Axes, and shared Component
  Sets go to the Foundation; Screens, nodes, Instances, and Scenarios go to the
  Product.
  Example: {"baseRevision":"<revision>","batchId":"resize-home-1","operations":[
    {"type":"update-presentation-node","screenId":"scr_home",
     "presentationId":"pres_home_mobile","nodeId":"node_home_root",
     "changes":{"width":360,"height":640}}]}

Component instance overrides:
  set-instance-override {screenId, presentationId?, nodeId, overridePath, value}
  and clear-instance-override {screenId, presentationId?, nodeId, overridePath}
  change one field of one Instance node without touching the shared component.
  overridePath is "<sourceNodeId>:<field>", or "<nestedInstanceId>__<sourceNodeId>:<field>"
  inside a nested instance. Fields: fills, name, opacity, text, visible.

Token references on nodes:
  tokenBindings uses package-qualified references, for example
  {"fill":{"packageId":"pkg_foundation","assetId":"tok_brand"}}.
  Use this field for Foundation and linked Library Tokens. appliedTokens is an
  optional local-name compatibility field, not a cross-Package reference; do not
  add it for an external binding or copy Tokens just to satisfy that field.

Raw-value confirmation policy:
  Writes that resolve to no Token return a non-blocking design_token_value_unmatched
  warning; the write itself is not gated. Warnings are design advice, not
  validity: validate does not repeat them, and warningSummary.note says so. Raw
  width/height values are listed only when a Token resolves to them or lies within
  10% (at least 2); the rest are counted in warningSummary.suppressed. --confirm-unmatched is an explicit,
  machine-readable acknowledgment: the response marks those warning groups with
  "confirmed": true. Omitting the flag changes nothing about the write.

Warning output:
  Default compact mode groups identical advice, puts exact matches first, and
  shares contextScope in warningSummary. Each warning group retains all node
  locations (warningIndex, operationIndex, nodeId, value); count is its occurrence
  count. No warnings are dropped. Expand locations with the group's shared fields
  and summary contextScope, then sort by warningIndex to recover the original list.
  Select --warning-detail full before executing to emit the original flat list.
  Do not replay an already applied batch just to expand warnings: compact output
  already contains every listed occurrence, and stale-revision checks still apply.

${WRITE_REPLY}

Errors and recovery:
  Committed batch identities are recorded beside the Package. Retrying the same
  batchId with the same baseRevision and operations, from any process, returns the
  recorded confirmation with alreadyApplied:true and writes nothing, as long as
  the Package is still at the recorded revision. If the batch's effect was undone
  (the Package is back at its baseRevision) the retry applies it again as a new
  write. If later writes moved the Package elsewhere the retry exits
  batch_superseded with committedRevision and currentRevision. The same batchId
  with a different baseRevision or operations exits batch_id_conflict.
  The name-based writes (page, component, flow, token, theme, asset, canvas)
  and import-tokens rebuild the batch from the current
  revision; rerunning one with the same --batch-id and input after success
  returns alreadyApplied:true under the same rules.
  stale_revision returns actual/base revisions. Inspect current content first:
  the intended change may already be committed. Rebuild only the remaining intent
  against the actual revision and use a new unique batch ID; do not blindly replay.
  --dry-run validates and returns the result/inverse without writing. --explain
  adds per-operation targets and --diff a before/after field diff of every
  changed entry; both are previews that never write, with or without --dry-run.
  Invalid batches never write.`,
  watch: `Usage:
  smallpen watch <package.smallpen> [--interval MS] [--max-events N] [--json]

Watch is the public live mode: it polls the Canonical Package and emits one NDJSON
{event:"revision", packageId, revision} line whenever the on-disk revision
changes. An unreadable package emits one {event:"invalid", code, message} line
(again only when the error changes); recovery emits its revision line again.
The initial revision is emitted immediately. --max-events bounds the run for
scripted use; Ctrl-C exits 0. Watch never writes.

`,
  "migrate-themes": `Usage:
  smallpen migrate-themes <package.smallpen> --output NEW_PATH [--json]

Purpose:
  Upgrade by copy (the original stays untouched): write a new Package whose
  theme-kind Context Axes and Token contextValues are Penpot token sets and
  themes. For a Product with a Foundation, both are copied: --output names the new
  workspace directory, which receives the Foundation and the Product under their
  current directory names, still linked. Otherwise --output is the new
  <name>.smallpen path.

Conversion:
  Each theme-kind axis becomes a theme group named after the axis. The set base
  holds every Token's default value (Token ids, names and bindings stay as they
  are); one set per non-default value holds that value's overrides as Tokens of
  the same name (ids tok_<base id>__<value>); one theme per value activates
  [base, its set]; the default value's theme is active. DTCG token files become
  the token library. A Product stores the active Foundation theme on its
  dependency. Scenario contexts on theme axes become Scenario themes. Legacy
  {x, y} shadows become {offsetX, offsetY}.

Warnings:
  contextValues whose when names a non-theme axis, or more than one axis, cannot
  be a theme set: they are kept as they were and listed in warnings with their
  Tokens. Product Token overrides (overrideOf) stay DTCG Tokens.

Next:
  smallpen view NEW_PATH --theme Theme/Dark --json`,
  repair: `Usage:
  smallpen repair <product.smallpen> [--conflict N] [--action ACTION]
                  [action arguments] [--batch-id ID] [--json]

Actions:
  select-instance-variant  [--selection JSON]; default: the closest variant
  retarget-reference       --replacement-package-id PKG --replacement-asset-id ID
  remove-dependent-usage  no additional arguments
  choose-foundation        --foundation PATH
  recreate-product-asset  --asset-kind token|component --asset FILE

Without --action, returns all typed conflicts and choices. Each action is checked
against the selected conflict and committed through one atomic Operation Batch.
After each step the workspace is resolved again; remaining conflicts stay explicit.

Instances whose variant is gone:
  An Instance selects variant values. When its Foundation renames those values
  while the Product is open in the same Desktop or Web session, the Product's
  Instances follow the variant in a batch of their own (with its own undo).
  When the variant is deleted, or the rename happened elsewhere, the Product
  enters Repair: the conflict is missing_variant with degraded:true, the
  Instance still renders with the closest variant (a stale_instance_variant
  diagnostic says so), and the choices are select-instance-variant (the closest
  variant; --selection picks one of validSelections), retarget-reference or
  remove-dependent-usage (delete the Instance).`,
};

export function printHelp(command, { full = false, route } = {}) {
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
    return;
  }
  say(`SmallPen Canonical Package CLI

Model:
  One .smallpen directory is one Canonical Package. init creates one
  self-contained Package (<name>.smallpen) by default: token sets and themes,
  Context Axes, Component Sets, Screens, Presentations, Scenarios. Write
  everything to it and pass it to view, validate, export, token list and
  search. With init --layout foundation-product it creates a Foundation
  (<name>-foundation.smallpen: token sets and themes, Context Axes, shared
  Component Sets) and a Product (<name>.smallpen: Screens, Presentations,
  Scenarios) instead: write Tokens and components to the Foundation, Screens and
  nodes to the Product, and pass the Product to the reads.
  Themes are Penpot token sets + themes. token theme list reads groups/options/defaults;
  token theme add|rename|default|delete write them by Group/Option name. Resolved reads take
  --theme GROUP/NAME for this call only: project defaults, then an explicit
  Scenario, then explicit overrides of named groups. App active selection is
  independent. set-active-token-themes explicitly stores the App selection.
  A Product references exactly one same-workspace Foundation by permanent Package
  ID and relative path. Every CLI call
  receives its Package locator and complete selectors explicitly; there is no current
  selection, current page, or cross-call session state. Packages are never merged into
  a synthetic multi-root file. CLI, Desktop, renderer, and Agents share one resolver
  and one typed Operation Batch contract. No PostgreSQL, collaboration server, MCP,
  or built-in AI Chat is required.

CLI entry point:
  smallpen help
  smallpen help OBJECT ACTION
  smallpen schema command OBJECT ACTION --json
  smallpen help rules
  CLI usage is complete without a Skill. Scene Skills supply task-specific rules.

Separate actions:
  settings    token/component/page/canvas/asset/flow actions save changes by
              name; advanced apply runs an exact batch, such as an undo batch.
  definitions token theme list is a cheap settings query; search finds reusable Tokens
              and components.
  view        Compact layout outline, or a page/component/region text wireframe.
  validate    Problems and coverage; data validity is separate from visual QA.
  export      Actual text, wireframe or PNG files with size/hash/selection.
  Read compact text/issues first, then text wireframes. Inspect PNG only when
  useful and the caller supports image input; reuse an unchanged renderHash.
  export defaults to a text wireframe; PNG requires --format png. The CLI does
  not detect model image capability. Text-only models may export PNG deliverables
  but must review text/wireframes and must not claim visual inspection of a PNG.

Usage:
  smallpen <command> [arguments] [--json]
  smallpen <command> --help
  smallpen version --json

Commands:
${PUBLIC_PATHS.map(([name, summary]) => `  ${name.padEnd(24)} ${summary}`).join("\n")}

Query examples:
  smallpen init ./acme --json
  smallpen themes ./acme/acme.smallpen --json
  smallpen help rules --json
  smallpen validate ./acme/acme.smallpen --json
  smallpen search-tokens ./acme/acme.smallpen --color '#6750a4' --json
  smallpen search-components ./acme/acme.smallpen --query button --json
  smallpen catalog ./acme/acme.smallpen --json
  smallpen view ./acme/acme.smallpen --json
  smallpen apply ./acme/acme.smallpen --batch batch.json --json
  smallpen export ./acme/acme.smallpen --format text --json
  smallpen export ./acme/acme.smallpen --format png --json
  smallpen export ./acme/acme.smallpen --design-system --json
  smallpen import-draft ./acme/import-1.smallpen --kind figma --input clipboard.html --json
  smallpen repair ./acme/acme.smallpen --json

Output:
  Defaults are summaries, paginated identities, and artifact paths (8 KiB budget).
  JSON is compact. Directory fields are a public CLI contract, not a dump of
  internal objects. Reuse restrictions appear only when they affect a decision.
  Read one target before editing. --full requests complete data; --base64 requests
  image bytes. Operation schemas are available individually: smallpen schema operation TYPE.
  smallpen schema returns cliVersion/contractRevision for stable contract caching.
  Package reads return revision; workspace views also return dependency revisions.
  Cache a view by those revisions plus its selectors, theme, context and locale.

Worked example:
  smallpen schema batch --full

Every write input has a schema and a tested example: smallpen schema
(operations, node, token, theme, component-set, instance, presentation, batch, init).
Run smallpen <command> --help for syntax, defaults, values, examples, outputs,
errors, and relevant next commands.
`);
}

export const COMMAND_NAMES = Object.freeze(COMMANDS.map(([name]) => name));
export function commandGuidance(command, route) {
  if (route && (command === "assets" || route.fixed || !HELP[command])) {
    const contract = commandContract(route.name);
    const args = contract.arguments.map(({ name, required }) => required ? `<${name}>` : `[${name}]`).join(" ");
    return `Usage:\n  smallpen ${route.name} ${args} [options]\n\n${route.purpose}`;
  }
  return HELP[command] ? publicText(HELP[command]) : undefined;
}
