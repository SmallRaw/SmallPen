const COMMANDS = [
  ["version", "Print the CLI package version without opening a workspace"],
  ["init", "Persist a guided Brief/Proposal and create Foundation + Product"],
  ["validate", "Validate a package and its same-workspace Foundation"],
  ["inspect", "Inspect package identity, capabilities, and domain summary"],
  ["list", "List stable domain objects by kind"],
  ["read", "Read the complete validated Canonical Snapshot"],
  ["read-view", "Read the deterministic default or selected Design View"],
  ["discover", "Discover exact selectors and executable next reads"],
  ["catalog", "Derive the Design System Catalog and requirement coverage"],
  ["search-components", "Find reusable Product and Foundation components"],
  ["component", "Inspect a Component Set and its legal variants"],
  ["compare", "Compare two to four explicitly selected Design Views"],
  ["tokens", "List Effective Tokens for a Context"],
  ["search-tokens", "Find reusable Tokens by name, type, or design value"],
  ["effective-token", "Resolve one Effective Token"],
  ["explain-token", "Explain one Effective Token resolution decision"],
  ["render", "Render the selected Design View to deterministic PNG"],
  ["inspect-view", "Return wireframe, semanticTree, optional image, and supporting context"],
  ["render-matrix", "Render multiple design contexts for AI comparison"],
  ["evidence", "Return PNG plus deterministic review evidence; --output exports files"],
  ["import-draft", "Import Figma clipboard, SVG, or PNG as a separate Draft file"],
  ["import-media", "Import binary Media (PNG/JPEG/GIF/WebP/SVG) into a Product Asset Library"],
  ["remove-media", "Remove an imported Media descriptor from the Asset Library"],
  ["import-font", "Import a TTF/OTF/WOFF font and convert SFNT to WOFF"],
  ["import-tokens", "Review and import a DTCG / Tokens Studio token file into the Token Library"],
  ["library-refresh", "Re-fetch a declared URL Library into its verified cache"],
  ["draft-diff", "Compare two independent Draft files without changing Canonical"],
  ["draft-compile", "Compile selected Draft fields into a current-revision batch"],
  ["flow", "Create flowchart nodes from a declarative intent"],
  ["page", "Create page nodes from a declarative intent"],
  ["token", "Apply declarative Token operations atomically"],
  ["impact", "Find every node and component using a Token"],
  ["apply", "Atomically apply one typed Operation Batch"],
  ["watch", "Emit NDJSON revision events for local external changes"],
  ["repair", "Inspect or execute one explicit Repair choice"],
];

const DESIGN_SELECTORS = `Design selectors:
  --screen ID                 Screen; default: manifest defaultScreenId
  --presentation ID           Presentation; default: Screen Base Presentation
  --scenario ID               Reproducible Scenario; default: canonical initial state
  --context-profile ID        Named Context profile
  --context AXIS=VALUE        Repeatable finite Context selection`;

const VIEW_SELECTORS = `${DESIGN_SELECTORS}
  --format FORMAT             structure|semantic|wireframe|screenshot`;

const HELP = {
  version: `Usage:
  smallpen --version
  smallpen version [--json]

Output:
  The installed CLI package version, or {name,version} with --json.
  No package path is required; design files are unchanged and no services start.`,
  init: `Usage:
  smallpen init <workspace-directory> [--state FILE] [--answers FILE]
                [--answer QUESTION_ID=JSON]... [--confirm] [--locale LOCALE] [--json]

Purpose:
  Persist a progressively completed Initialization Brief and validated Proposal.
  No hidden conversational state is used. --confirm atomically creates one local
  Foundation and one Product; an existing target is never overwritten.

Defaults and values:
  --state defaults to <workspace-directory>.smallpen-init.json.
  Project kinds: application|motion|custom. Foundation choice: create-new.
  --answer values are JSON (for example projectKind=\"application\").

Examples:
  smallpen init ./quincy --json
  smallpen init ./quincy --state ./quincy-init.json --answer projectKind=\"application\" --json
  smallpen init ./quincy --answers ./answers.json --confirm --json

Output:
  status needs_input returns a stable question id, localized label, schema,
  optional recommendation, and continuation args with an answer placeholder. Replace
  <JSON> with your schema-valid answer; if no recommendation is present, supply the
  project's own purpose, audience, or deliverable. status proposal returns the
  persisted Proposal and confirmation args. Only --confirm creates the packages;
  status initialized returns both package paths.

Errors and next commands:
  Malformed --answer JSON identifies the question; schema-invalid values also return
  its schema. Correct the answer and retry with the same --state. After confirming:
  smallpen validate <product.smallpen> --json`,
  validate: `Usage:
  smallpen validate <product.smallpen> [--json]

Purpose:
  Validate Canonical JSON, IDs, references, Product/Foundation dependency, all Context
  combinations used by projections, and strict Scenario/component selections.

Output:
  status valid with Product and Foundation revisions; dependency conflicts return
  repair_required with exact choices.

Next:
  smallpen inspect <package> --json
  smallpen repair <product> --json`,
  inspect: `Usage:
  smallpen inspect <package.smallpen> [--json]

Purpose:
  Return package identity/revision, format capabilities, Contexts, Screens,
  Presentations, Tokens, Component Sets, Scenarios, requirements, Flows, and
  machine-readable Design System preflight operations.

Next:
  smallpen list <package> --kind screens --json
  smallpen read-view <package> --json`,
  list: `Usage:
  smallpen list <package.smallpen> [--kind KIND] [--offset N] [--limit N] [--json]

Values:
  KIND: all|screens|presentations|contexts|tokens|components|scenarios|requirements|flows
  Defaults: kind=all, offset=0, limit=100. Lists include total/range pagination.

Next:
  Use returned stable IDs with read-view, effective-token, or compare.`,
  read: `Usage:
  smallpen read <package.smallpen> [--json]

Purpose:
  Return the complete validated Canonical Snapshot used by adapters. Binary blobs are
  not embedded in JSON. Prefer inspect/list/read-view for bounded Agent reads.

Next:
  smallpen inspect <package> --json`,
  "read-view": `Usage:
  smallpen read-view <product.smallpen> [selectors] [--offset N] [--limit N]
                     [--locale LOCALE] [--json]

${VIEW_SELECTORS}

Defaults:
  Base Presentation + default Context values + canonical initial state + structure.
  All formats resolve the same selection.

Choose a format:
  wireframe  A scaled 2D ASCII canvas for fast spatial reasoning, followed by a
             compact marker key with hierarchy, layer type, name, and stable ID.
  semantic   Exact machine-readable hierarchy, bounds, text, alignment, resolved
             typography, component references, variants, and Token bindings.
  screenshot Rendered PNG metadata only; use render/evidence for inline pixels,
             or add --output to explicitly write PNG files.
             The PNG image itself is raster pixels only: it has no layer IDs,
             hierarchy, bounds, component references, or Token bindings.

Agent guidance:
  Use wireframe or semantic to understand and edit the design. Use PNG to inspect
  high-fidelity color, typography, spacing, effects, and rendering. Use inspect-view
  --include-image when both structural reasoning and visual QA are required.

Next:
  Execute any Discovery Guide command without inventing arguments.`,
  discover: `Usage:
  smallpen discover <product.smallpen> [selectors] [--offset N] [--limit N]
                    [--locale LOCALE] [--json]

${VIEW_SELECTORS}

Output:
  Exact selector parameters, defaults, finite valid values, localized summaries,
  machine operation/args, copyable commands, and pagination metadata.`,
  catalog: `Usage:
  smallpen catalog <product.smallpen> [--context AXIS=VALUE]... [--json]

Purpose:
  Derive legal Component variants, inherited assets, Effective Tokens, Contexts,
  Scenarios, Screens, and requirement coverage from the same validated workspace.`,
  "search-components": `Usage:
  smallpen search-components <product.smallpen> --query TEXT [--limit N] [--json]

Purpose:
  Find reusable Product, public Foundation, and linked Library components before
  drawing a custom replacement. Matches stable ID, name, category, and description and returns the
  owning Package, source layer, legal variant selections, and an executable
  owner-scoped component command (argv plus a POSIX-shell command).

State:
  Every query is explicit and self-contained. It never creates a current component
  or affects a later command.`,
  component: `Usage:
  smallpen component <package.smallpen> --component-id CMP [--json]

Purpose:
  Return one exact Component Set, its legal variant selections, replacement metadata,
  and component-targeted Scenarios. This is read-only and uses stable Canonical IDs.
  The package path must identify the owning Package. For inherited components,
  execute the owner-scoped command returned by search-components.
  An HTTP(S) Library URL is also accepted and uses the normal Library cache.

Next:
  Use a returned selection with read-view or inspect-view to review the design.`,
  compare: `Usage:
  smallpen compare <product.smallpen> --selector JSON --selector JSON
                   [--selector JSON] [--selector JSON] [--json]

Values:
  Exactly two to four selector objects. Example:
  smallpen compare product.smallpen --selector '{"presentationId":"pres_desktop"}' \\
    --selector '{"presentationId":"pres_mobile"}' --json`,
  tokens: `Usage:
  smallpen tokens <product.smallpen> [--context AXIS=VALUE]... [--json]

Purpose:
  List Effective Tokens using Product first, Context specificity within a layer,
  then Foundation fallback.`,
  "search-tokens": `Usage:
  smallpen search-tokens <product.smallpen> (--color COLOR | --value JSON | --query TEXT | --type TYPE)
                         [--context AXIS=VALUE]... [--limit N] [--json]

Purpose:
  Find reusable Product and Foundation Design Tokens before writing a hard-coded
  design value. Color and numeric searches rank exact matches first, then nearest
  values. Without --context, every finite Web/Desktop/theme/etc. Context is searched
  and each resolved value reports its matching Contexts. Repeating --context restricts
  the search explicitly. Name queries match Token path, description, and type.

Examples:
  smallpen search-tokens product.smallpen --color '#6750a4' --json
  smallpen search-tokens product.smallpen --type spacing --value 16 --json
  smallpen search-tokens product.smallpen --query surface --json

State:
  Every search is self-contained. It never reads or writes a current selection,
  previous result, session, or Web UI state.`,
  "effective-token": `Usage:
  smallpen effective-token <product.smallpen> --token-id TOK [--package-id PKG]
                           [--context AXIS=VALUE]... [--json]

Defaults:
  package-id defaults to the Product Package ID; Context axes use defaults.`,
  "explain-token": `Usage:
  smallpen explain-token <product.smallpen> --token-id TOK [--package-id PKG]
                         [--context AXIS=VALUE]... [--json]

Output:
  Chosen source/value plus all candidates, specificity, rejection reasons, and layer.`,
  render: `Usage:
  smallpen render <product.smallpen> [selectors] [--scale N] [--output FILE] [--json]

${DESIGN_SELECTORS}

Defaults and limits:
  No --output: return a PNG as bare base64 in one JSON result; no image file or
  temporary image is created. This also applies without --json.
  Explicit --output FILE: write that PNG and return its absolute output path
  instead of base64. Existing FILE is replaced only after a successful write.
  scale=1, scale range (0,8], maximum dimension 8192,
  maximum 32M pixels. Output is deterministic PNG with revision/render hash. The
  PNG image itself is raster pixels only and contains no layer IDs, hierarchy,
  bounds, component references, or Token bindings. Use it for high-fidelity visual
  QA of color, typography, spacing, effects, alignment, and rendering.
  Decode the current response in an image-capable client; base64 text alone is
  not visual QA. Verify decoded bytes against renderHash (SHA-256), and use the
  accompanying revision and selection. On failure, never open a previous file.

Wireframe:
  Use smallpen read-view <product.smallpen> --format wireframe --json.
  It returns a scaled 2D ASCII canvas and compact marker key. Use semanticTree
  from inspect-view when exact bounds, text, component, and Token data is needed.`,
  "inspect-view": `Usage:
  smallpen inspect-view <product.smallpen> [selectors] [--include-image]
                         [--output FILE] [--base64] [--json]

${DESIGN_SELECTORS}
  --scale N                   Image scale; default: 1 (requires --include-image to render)
  --locale LOCALE             Localized view labels; default: zh-TW

Purpose:
  Return one AI-readable view bundle.

Three complementary view parts:
  wireframe     Scaled 2D ASCII canvas plus a compact layer marker key.
  semanticTree  Exact hierarchy, bounds, text, alignment, typography, component,
                variant, and Token data.
  image         Optional high-fidelity PNG and metadata; add --include-image to render it.

Supporting context:
  Effective Tokens, component catalog, selected Context, and revision metadata.
  Without --output, image.base64 contains bare PNG base64 in this one JSON result
  (also without --json). No image file or temporary image is created.
  Explicit --output FILE writes the image and returns image.output instead of
  base64; add --base64 only when both file and inline bytes are wanted.
  --output and --base64 require --include-image.

Agent guidance:
  Use this when the Agent needs both structure and visual QA. Start with wireframe
  for spatial relationships, query semanticTree for exact data, and inspect image
  only when pixel-level visual QA is needed. The PNG itself contains no layer or
  Token metadata. Decode this response in an image-capable client; base64 text
  alone is not visual QA. image.revision/selection identify the rendered snapshot;
  image.renderHash is the SHA-256 of the decoded PNG. Never reuse an old image
  after an error, or infer freshness from a filename.`,
  "render-matrix": `Usage:
  smallpen render-matrix <product.smallpen> --contexts CONTEXTS.json
                         [--output DIRECTORY] [--scale N] [--json]

Purpose:
  Render a deterministic PNG for every explicit design selector in CONTEXTS.json.
  Each selector may choose context axes, screen, presentation, and scenario.
  Without --output, one JSON result contains ordered images with bare base64,
  dimensions, exact selectors, per-image revisions, and PNG SHA-256 renderHash.
  No image files or temporary images are created, including if a later selector
  fails. This also applies without --json.
  Explicit --output DIRECTORY writes PNG files and returns each image.output
  instead of base64. Different render hashes retain separate files; there is no
  automatic cleanup or all-or-nothing multi-file export. Only consume images
  from a successful current response; never fall back to earlier matrix files.`,
  evidence: `Usage:
  smallpen evidence <product.smallpen> [selectors] [--scale N] [--output PREFIX] [--json]

${DESIGN_SELECTORS}

Output:
  Without --output, return one JSON evidence bundle with image.base64 (bare PNG
  base64); no PNG, evidence JSON file, or temporary image is created. This also
  applies without --json. image includes the current revision/selection and
  renderHash (SHA-256 of decoded PNG bytes), not a cache locator.
  Explicit --output PREFIX writes PREFIX.png and PREFIX.json instead of base64.
  Evidence contains revision/package hash, resolved selectors,
  render hash, node-to-image regions, Semantic Tree, viewport, and diagnostics.
  PREFIX.png is an unannotated high-fidelity raster image. Semantic details live in
  PREFIX.json and are not embedded visibly in the PNG.
  Decode the current inline response in an image-capable client for visual QA.
  Failed exports do not authorize reading an old file; multi-file export is not
  an all-or-nothing transaction and existing files are not automatically cleaned.

Wireframe:
  Use smallpen read-view <product.smallpen> --format wireframe --json.
  It returns a scaled 2D ASCII canvas with one [NN] marker per layer.`,
  "import-media": `Usage:
  smallpen import-media <package.smallpen> --file MEDIA_FILE [--media-id media_...]
                        [--media-path PATH] [--name NAME] [--json]

Import is the public binary Media entry for an existing Product: PNG, JPEG, GIF,
WebP, and SVG are detected from bytes, dimensions are validated, and the blob is
content-addressed (identical bytes in one package share one blob). JSON apply
still forbids blob writes; media import is a file entry, not a batch operation.
remove-media deletes the descriptor (metadata lifecycle is reversible); the
content-addressed blob itself is immutable and shared.

Errors and recovery:
  Corrupt or unsupported bytes exit 1 invalid_media_file and write nothing.
  Reusing --media-id exits duplicate_media_id with the existing descriptor.

`,
  "remove-media": `Usage:
  smallpen remove-media <package.smallpen> --media-id MEDIA [--json]

Removes one Media descriptor from the Asset Library atomically; the inverse batch
restores it. Unknown ids exit missing_media.

`,
  "import-font": `Usage:
  smallpen import-font <package.smallpen> --file FONT_FILE --family NAME
                      [--font-id font_...] [--variant-id fvar_...]
                      [--weight 400] [--style normal] [--name NAME] [--json]

Public Font entry for an existing Product. TTF and OTF are validated by SFNT
signature and converted to WOFF (the renderer loads ttf/otf/woff). WOFF imports
as-is after table validation. A valid WOFF2 reaches an explicit
unsupported_font_conversion boundary (no WOFF2 decoder is bundled); corrupt
fonts fail invalid_font_blob. Either way nothing is written.

`,
  "library-refresh": `Usage:
  smallpen library-refresh <package.smallpen> [--library PACKAGE_ID|URL] [--json]

Explicitly re-fetches one declared URL Library from its origin into the same
verified cache. The refreshed snapshot must match the declared Package ID; a
mismatch exits library_id_mismatch with expected/actual identities and leaves the
previous verified snapshot readable offline. Success reports before/after
revisions; failures keep the previous revision.

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
                         [--batch-id ID] [--json]

Purpose:
  Import a DTCG token file (Penpot or Tokens Studio export, single-set, multi-set
  with $themes/$metadata, or legacy value/type) into the package's Penpot-shaped
  Token Library. Without --apply the command only reviews: it prints the diff of
  tokens, sets, and themes that would be added, changed, or removed, with values.
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
  flow: `Usage:
  smallpen flow <product.smallpen> --intent INTENT.json [--batch-id ID] [--dry-run]
                [--warning-detail compact|full] [--json]

Purpose:
  Compile and atomically apply a declarative flowchart intent. The intent contains
  screenId, optional presentationId/parentId, and nodes. Each node becomes a
  canonical add-presentation-node operation and receives an exact inverse batch.

Intent example:
  {"screenId":"scr_home","nodes":[{"id":"node_start","type":"ELLIPSE",
    "name":"Start","x":80,"y":80,"width":120,"height":56,"children":[]}]}

Node types:
  FRAME|ELLIPSE|GROUP|PATH|RECTANGLE|TEXT. PATH nodes may carry pathData, points,
  strokes, and tokenBindings; arrowheads use stroke cap fields.

  Output:
  The normal atomic apply result. Follow with read-view or render to inspect it.`,
  page: `Usage:
  smallpen page <product.smallpen> --intent INTENT.json [--batch-id ID] [--dry-run]
                [--warning-detail compact|full] [--json]

Purpose:
  Compile and atomically apply declarative page nodes. The intent uses the same
  screenId, optional presentationId/parentId, and nodes schema as flow. Use page
  for general UI nodes and flow for flowchart-oriented PATH/ELLIPSE nodes.
  Warning output follows apply; see smallpen apply --help for the compact schema.`,
  token: `Usage:
  smallpen token <product.smallpen> --intent INTENT.json [--batch-id ID] [--dry-run]
                 [--warning-detail compact|full] [--json]

Purpose:
  Apply declarative Token operations through the canonical atomic batch contract.
  Intent JSON contains an operations array using put-token, set-token-value,
  set-active-token-themes, set-token-binding, clear-token-binding, remove-token,
  or deprecate-token. Theme selection uses themePaths such as Product/Dark.
  The current package revision is read immediately before applying the intent.`,
  impact: `Usage:
  smallpen impact <product.smallpen> (--token-id TOK | --path TOKEN.PATH) [--package-id PKG] [--json]

Purpose:
  Find all Canonical nodes whose tokenBindings reference the selected Token. The
  result includes screen, presentation, component, node, and field locations so
  an Agent can preview the exact blast radius before changing a Token. Foundation
  Tokens are resolved through the Product dependency; use --package-id to
  disambiguate a Token ID or path that exists in both Packages.`,
  apply: `Usage:
  smallpen apply <package.smallpen> --batch BATCH.json [--dry-run]
                 [--warning-detail compact|full] [--confirm-unmatched] [--json]

Batch contract:
  {"baseRevision":"...","batchId":"unique-id","operations":[...]}
  The whole candidate validates and commits atomically. Success returns revision,
  affected stable IDs/files, and an exact inverseBatch for Undo/Redo.
  Revisions are content hashes, not increasing counters: restoring the exact
  Canonical content restores its previous revision.

Token references on nodes:
  tokenBindings uses package-qualified references, for example
  {"fill":{"packageId":"pkg_foundation","assetId":"tok_brand"}}.
  Use this field for Foundation and linked Library Tokens. appliedTokens is an
  optional local-name compatibility field, not a cross-Package reference; do not
  add it for an external binding or copy Tokens just to satisfy that field.

Raw-value confirmation policy:
  Writes that resolve to no Token return a non-blocking design_token_value_unmatched
  warning; the write itself is not gated. --confirm-unmatched is an explicit,
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
  already contains every occurrence, and stale-revision checks still apply.

Errors and recovery:
  Each CLI call is independent; confirmed batch results are not retained across
  calls. Retrying a committed batch against its old base returns stale_revision,
  not a cached success. Batch IDs do not provide cross-process deduplication.
  stale_revision returns actual/base revisions. Inspect current content first:
  the intended change may already be committed. Rebuild only the remaining intent
  against the actual revision and use a new unique batch ID; do not blindly replay.
  --dry-run validates and returns the result/inverse without writing.
  Invalid batches never write.`,
  watch: `Usage:
  smallpen watch <package.smallpen> [--interval MS] [--max-events N] [--json]

Watch is the public live mode: it polls the Canonical Package and emits one NDJSON
{event:"revision", packageId, revision} line whenever the on-disk revision
changes, and {event:"invalid"} lines when the package is temporarily unreadable.
The initial revision is emitted immediately. --max-events bounds the run for
scripted use; Ctrl-C exits 0. Watch never writes.

`,
  repair: `Usage:
  smallpen repair <product.smallpen> [--conflict N] [--action ACTION]
                  [action arguments] [--batch-id ID] [--json]

Actions:
  retarget-reference       --replacement-package-id PKG --replacement-asset-id ID
  remove-dependent-usage  no additional arguments
  choose-foundation        --foundation PATH
  recreate-product-asset  --asset-kind token|component --asset FILE

Without --action, returns all typed conflicts and choices. Each action is checked
against the selected conflict and committed through one atomic Operation Batch.
After each step the workspace is resolved again; remaining conflicts stay explicit.`,
};

export function printHelp(command) {
  if (command && HELP[command]) {
    process.stdout.write(`SmallPen ${command}\n\n${HELP[command]}

Common output and error contract:
  --json emits stable English keys; localized labels remain additional data. Success
  exits 0. Errors exit 1 as {error:{code,message,details}} and include exact
  nextOperations when recovery requires refresh, replay, Repair, or confirmation.
  Unknown options are not part of the command contract shown above.

Help / next:
  smallpen --help
  smallpen ${command} --help
`);
    return;
  }
  process.stdout.write(`SmallPen Canonical Package CLI

Model:
  One .smallpen directory is one Canonical Package. A Product references exactly one
  same-workspace Foundation by permanent Package ID and relative path. Every CLI call
  receives its Package locator and complete selectors explicitly; there is no current
  selection, current page, or cross-call session state. Packages are never merged into
  a synthetic multi-root file. CLI, Desktop, renderer, and Agents share one resolver
  and one typed Operation Batch contract. No PostgreSQL, collaboration server, MCP,
  or built-in AI Chat is required.

Choose an Agent view:
  wireframe   Fast 2D spatial reasoning from a scaled ASCII canvas plus a compact
              [NN] key containing hierarchy, layer type, name, and stable ID.
  semantic    Exact hierarchy, bounds, text, alignment, typography, component,
              variant, and Token properties.
  PNG         High-fidelity visual QA. The image is raster pixels only; it contains
              no layer IDs, hierarchy, component references, or Token bindings.
  both        Use inspect-view --include-image, then reason from structure and verify
              appearance from the PNG.

Usage:
  smallpen <command> [arguments] [--json]
  smallpen <command> --help
  smallpen --version

Commands:
${COMMANDS.map(([name, summary]) => `  ${name.padEnd(18)} ${summary}`).join("\n")}

Common workflow:
  smallpen init ./workspace --json
  smallpen validate ./workspace/product.smallpen --json
  smallpen search-tokens ./workspace/product.smallpen --color '#6750a4' --json
  smallpen search-components ./workspace/product.smallpen --query button --json
  smallpen catalog ./workspace/product.smallpen --json
  smallpen read-view ./workspace/product.smallpen --json
  smallpen discover ./workspace/product.smallpen --json
  smallpen apply ./workspace/product.smallpen --batch batch.json --json
  smallpen evidence ./workspace/product.smallpen --output review --json
  smallpen import-draft ./workspace/import-1.smallpen --kind figma --input clipboard.html --json
  smallpen repair ./workspace/product.smallpen --json

Run smallpen <command> --help for syntax, defaults, values, examples, outputs,
errors, and relevant next commands.
`);
}

export const COMMAND_NAMES = Object.freeze(COMMANDS.map(([name]) => name));
