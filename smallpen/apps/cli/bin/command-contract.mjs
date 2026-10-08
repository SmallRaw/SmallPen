// One definition drives command schemas, help, argument validation and errors.
import {
  INIT_LAYOUTS,
  SMALLPEN_FORMAT_CAPABILITIES,
  SmallPenError,
  suggestField,
} from "@smallpen/core";
import { DISCOVERY_OUTPUT } from "./read-output.mjs";

const parameter = (option, type, description, extra = {}) => ({
  option,
  type,
  description,
  required: false,
  repeatable: false,
  ...extra,
});
const flag = (option, description) =>
  parameter(option, "boolean", description, { default: false });
const path = (option, description) => parameter(option, "path", description);
const id = (name, prefix, description, extra = {}) =>
  parameter(`--${name}-id`, "string", description, { prefix, ...extra });
const integer = (option, description, extra = {}) =>
  parameter(option, "integer", description, {
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
    ...extra,
  });

const PARAMETERS = {
  stdout: flag(
    "--stdout",
    "Print large results to stdout instead of saving a temporary result file",
  ),
  assetId: id(
    "asset",
    undefined,
    "Local color, typography, media or font identifier",
  ),
  flowId: id(
    "flow",
    undefined,
    "App prototype start UUID in the selected Presentation",
  ),
  steps: path(
    "--steps",
    "JSON {steps:[{nodeId,trigger?,phase?,index?,interactionId?,waitMs?,expect?}]} for read-only prototype verification",
  ),
  all: flag(
    "--all",
    "Check every variant of one --component-id, or every Presentation of one --screen-id; never all components/pages or theme combinations",
  ),
  action: parameter(
    "--action",
    "string",
    "One action offered by the selected repair conflict",
  ),
  after: path("--after", "The second Draft package"),
  allThemes: flag("--all-themes", "Search inactive token themes too"),
  answer: parameter(
    "--answer",
    "assignment",
    "QUESTION_ID=JSON initialization answer",
    { repeatable: true, uniqueBy: "assignment-key" },
  ),
  answers: path(
    "--answers",
    "Compatibility import of a complete legacy initialization brief; not used by project init",
  ),
  apply: flag("--apply", "Commit the reviewed token import"),
  asset: parameter("--asset", "string", "Repair asset identifier"),
  assetKind: parameter("--asset-kind", "string", "Repair asset kind"),
  base64: flag(
    "--base64",
    "Include inline image bytes; disables the small reply budget",
  ),
  batch: path(
    "--batch",
    "JSON batch with batchId, baseRevision and operations",
  ),
  batchId: parameter(
    "--batch-id",
    "string",
    "Stable retry identity; reuse with identical input",
    {
      defaultFrom: "a new random identity; supply one before a retryable write",
    },
  ),
  color: parameter("--color", "string", "Search tokens near this color"),
  compact: flag("--compact", "Explicit alias for the default small reply"),
  componentId: id(
    "component",
    "cmp_",
    "Component identifier in its owning package",
  ),
  confirm: flag("--confirm", "With --answers: create the workspace the answers propose (a plain init creates a blank one at once)"),
  confirmUnmatched: flag(
    "--confirm-unmatched",
    "Accept creation of an unmatched component selection",
  ),
  conflict: integer("--conflict", "Index of the repair conflict", {
    default: 0,
  }),
  context: parameter(
    "--context",
    "assignment",
    "CONTEXT=VALUE by name (Density=Compact) for this call",
    { repeatable: true, uniqueBy: "assignment-key" },
  ),
  contextProfileId: id("context-profile", undefined, "Named Context profile"),
  contexts: path("--contexts", "JSON file containing render-matrix selectors"),
  evidence: flag(
    "--evidence",
    "Export PNG and its review evidence; requires --format png",
  ),
  designSystem: flag(
    "--design-system",
    "Render the generated Design System page (every Token and representative component samples) instead of a Screen",
  ),
  definitions: flag(
    "--definitions",
    "Read stored Token definitions in all option Sets, without resolving a theme combination",
  ),
  group: parameter(
    "--group",
    "string",
    "Only Tokens that take values in this theme group (Brand); requires --definitions",
  ),
  diff: flag("--diff", "Preview the batch diff without writing"),
  from: parameter("--from", "string", "Source element as \"Page / Element\""),
  to: parameter("--to", "string", "Destination page name"),
  on: parameter("--on", "string", "Trigger; default click", {
    values: ["click", "mouse-enter", "mouse-leave", "after-delay", "mouse-press", "mouse-over"],
    errorCode: "invalid_flow_trigger",
  }),
  page: parameter("--page", "string", "Page name"),
  by: parameter("--by", "string", "Theme group: one file per option, for example Language"),
  tokenFormat: parameter("--format", "string", "json (nested by name) or flat (one key per Token name)", {
    values: ["json", "flat"],
    errorCode: "unknown_token_format",
  }),
  since: parameter("--since", "string", "A revision you saw; every read and write reports one"),
  canvas: parameter("--canvas", "string", "Canvas name"),
  direction: parameter("--direction", "string", "up, down, left or right", {
    values: ["up", "down", "left", "right"],
    errorCode: "invalid_direction",
  }),
  moveSteps: parameter("--steps", "integer", "How many places to move; default 1"),
  colorName: parameter("--color", "string", "Color name, as Group/Name, for example Brand/Primary"),
  typographyName: parameter("--typography", "string", "Typography name, as Group/Name, for example Text/Body"),
  assetValue: parameter("--value", "string", "A color (#1f6feb) for --color; a style object for --typography, for example {\"fontFamily\":\"sourcesanspro\",\"fontSize\":16}"),
  mediaName: parameter("--media", "string", "Media file name, as Group/Name"),
  fontFamily: parameter("--font", "string", "Font family name"),
  removeStart: flag("--remove", "Stop the page being a start"),
  as: parameter("--as", "string", "What to return: text (default), wireframe, png, issues, or spec (detailed positions, sizes, layout, visual values and Token bindings)", {
    values: ["text", "wireframe", "png", "issues", "spec"],
    errorCode: "unknown_view_as",
  }),
  component: parameter("--component", "string", "Component name"),
  setField: parameter(
    "--set",
    "assignment",
    'FIELD=VALUE as in page draw: width=320, fill={color.surface}, padding=[8,16], text="Save", props={"Style":"ghost"}; a JSON value or plain text',
    { repeatable: true },
  ),
  variant: parameter("--variant", "string", 'One variant, as "Style=secondary" (or just "secondary")'),
  element: parameter("--element", "string", 'Element name, or "Parent / Element" when the name repeats'),
  platform: parameter("--platform", "string", "Page version: desktop, mobile, ..."),
  token: parameter("--token", "string", "Token name or prefix, for example color or color.brand"),
  allTokens: flag("--tokens", "Every Token"),
  allComponents: flag("--components", "Every component"),
  allPages: flag("--pages", "Every page"),
  draft: path("--draft", "Source Draft package"),
  dryRun: flag("--dry-run", "Validate without committing a batch"),
  explain: flag(
    "--explain",
    "Preview affected targets and fields without writing",
  ),
  family: parameter("--family", "string", "Font family name"),
  file: path("--file", "Source binary file"),
  fontId: id("font", "font_", "Imported font identifier"),
  foundation: path("--foundation", "Replacement Foundation package"),
  full: flag(
    "--full",
    "Expand selected data; large results still use files. --stdout opts into large stdout. View nodes honor explicit pagination",
  ),
  help: flag("--help", "Print this command's help"),
  includeImage: flag(
    "--include-image",
    "Include a PNG artifact in the view receipt",
  ),
  input: path("--input", "Source import file"),
  intent: path("--intent", "JSON file containing the drawing or token intent"),
  interval: integer(
    "--interval",
    "Watch poll interval in milliseconds; values below 100 use 100",
    { default: 500, maximum: 3_600_000 },
  ),
  inverseOut: path(
    "--inverse-out",
    "Durable output file for the exact undo batch",
  ),
  json: flag("--json", "Machine-readable output with stable keys"),
  kind: parameter("--kind", "string", "Object kind"),
  layout: parameter("--layout", "string", "Workspace layout", {
    default: "single",
    values: Object.keys(INIT_LAYOUTS),
    errorCode: "invalid_init_layout",
  }),
  library: parameter(
    "--library",
    "string",
    "Declared Library package identifier or source URL",
    { defaultFrom: "the first declared URL Library" },
  ),
  limit: integer("--limit", "Maximum items in this page", {
    default: 20,
    maximum: 100,
  }),
  locale: parameter(
    "--locale",
    "string",
    "Label locale; stable JSON keys stay English",
    { defaultFrom: "LC_ALL, LC_MESSAGES, LANG, then English" },
  ),
  maxEvents: integer("--max-events", "Maximum watch events before exit", {
    minimum: 1,
    maximum: 10_000,
    defaultFrom: "unlimited",
  }),
  mediaId: id("media", "media_", "Imported media identifier"),
  mediaPath: parameter("--media-path", "string", "Media catalog path", {
    default: "",
  }),
  name: parameter("--name", "string", "Display name"),
  nodeId: id(
    "node",
    "node_",
    "Node identifier in the selected presentation or variant",
  ),
  offset: integer("--offset", "First item index in this page", { default: 0 }),
  output: path(
    "--output",
    "Output artifact path; image commands otherwise return temporary file paths",
  ),
  packageId: id(
    "package",
    "pkg_",
    "Owning package identifier for a cross-package reference",
  ),
  path: parameter(
    "--path",
    "string",
    "Token name, for example color.brand",
  ),
  presentationId: id("presentation", "pres_", "Presentation identifier", {
    defaultFrom: "the selected Screen's Base Presentation",
  }),
  query: parameter("--query", "string", "Search text"),
  replacementAssetId: id(
    "replacement-asset",
    undefined,
    "Replacement asset identifier",
  ),
  replacementPackageId: id(
    "replacement-package",
    "pkg_",
    "Replacement asset's package identifier",
  ),
  scale: parameter("--scale", "number", "Raster scale within (0, 8]", {
    default: 1,
    exclusiveMinimum: 0,
    maximum: 8,
    errorCode: "invalid_render_scale",
  }),
  scenarioId: id("scenario", "scn_", "Reproducible Scenario identifier"),
  screenId: id("screen", "scr_", "Screen identifier", {
    defaultFrom: "manifest.defaultScreenId",
  }),
  select: parameter("--select", "string", "SET/NAME token to import", {
    repeatable: true,
  }),
  selection: parameter("--selection", "json", "JSON component axis selection", {
    errorCode: "invalid_repair_selection",
  }),
  selections: path("--selections", "JSON file naming Draft fields to compile"),
  selector: parameter("--selector", "json", "JSON Design View selector", {
    repeatable: true,
    errorCode: "invalid_compare_selector",
  }),
  setName: parameter("--set-name", "string", "Imported token set name"),
  state: path("--state", "Initialization state to resume explicitly"),
  style: parameter("--style", "string", "Font style", {
    default: "normal",
    values: ["normal", "italic", "oblique"],
  }),
  theme: parameter(
    "--theme",
    "string",
    "GROUP/NAME token theme for this call; one per group",
    {
      repeatable: true,
      defaultFrom:
        "project group defaults; explicit Scenario themes then explicit --theme override named groups for this call; independent of App active selection",
    },
  ),
  tokenId: id("token", "tok_", "Token identifier in its owning package"),
  type: parameter("--type", "string", "Token type filter", {
    values: SMALLPEN_FORMAT_CAPABILITIES.canonicalPackage.tokenTypes,
    errorCode: "invalid_token_type",
  }),
  value: parameter(
    "--value",
    "string",
    "Token value filter; JSON when valid, otherwise text",
  ),
  variantId: id(
    "variant",
    "var_",
    "Component variant identifier; import-font uses a font variant id",
  ),
  viewFormat: parameter("--format", "string", "Design View representation", {
    default: "structure",
    values: ["structure", "semantic", "wireframe", "screenshot"],
    errorCode: "unknown_view_format",
  }),
  designFormat: parameter(
    "--format",
    "string",
    "Resolved design representation",
    {
      default: "outline",
      values: ["outline", "wireframe", "spec", "structure", "semantic"],
      errorCode: "unknown_view_format",
    },
  ),
  artifactFormat: parameter("--format", "string", "Export artifact", {
    default: "wireframe",
    values: ["text", "wireframe", "png"],
    errorCode: "unknown_export_format",
  }),
  warningDetail: parameter(
    "--warning-detail",
    "string",
    "Design advice detail",
    {
      default: "compact",
      values: ["compact", "full"],
      errorCode: "invalid_warning_detail",
    },
  ),
  weight: integer("--weight", "Font weight", {
    default: 400,
    values: [100, 200, 300, 400, 500, 600, 700, 800, 900, 950],
  }),
};

const PAGE = ["limit", "offset"];
const VIEW = ["context", "theme"];
// A design target by name, as view takes it.
const TARGET = ["page", "platform", "element", "component", "variant"];
const WRITE = [
  "compact",
  "confirmUnmatched",
  "diff",
  "dryRun",
  "explain",
  "inverseOut",
  "warningDetail",
];
const TOKEN = ["context", "theme"];
const COMMON = ["json", "full", "stdout", "help"];
const command = (purpose, fields = [], extra = {}) => ({
  purpose,
  fields,
  ...extra,
});
const required = (field, code) => ({ field, code });

export const COMMAND_CONTRACTS = {
  help: command("Print command usage and options", [], {
    locator: false,
    arguments: [
      { name: "topic", type: "string", required: false },
      {
        name: "section",
        type: "string",
        required: false,
        when: "an action, subgroup or rules topic",
      },
      { name: "action", type: "string", required: false, when: "section is a command subgroup" },
    ],
  }),
  version: command("Print the CLI version", [], { locator: false }),
  schema: command(
    "Print the JSON shape and parameters of each command and write input",
    PAGE,
    {
      locator: false,
      arguments: [
        { name: "topic", type: "string", required: false },
        {
          name: "name",
          type: "string",
          required: false,
          when: "topic is command, operation, workflow or an intent action directory",
        },
        { name: "action", type: "string", required: false, when: "topic is command" },
        { name: "subaction", type: "string", required: false, when: "name and action identify a command subgroup" },
      ],
    },
  ),
  init: command(
    "Create a blank package or workspace",
    ["name", "layout", "locale", "answers", "confirm"],
    { locatorName: "workspace" },
  ),
  themes: command(
    "Read project theme groups, options, defaults and this call's selection",
    ["theme", ...PAGE],
  ),
  assets: command(
    "Read local asset definitions, including fonts, media, colors and typographies",
    ["kind", ...PAGE],
    {
      overrides: {
        kind: { values: ["colors", "fonts", "media", "typographies"] },
      },
    },
  ),
  "token-export": command(
    "Export resolved Token values as JSON; --by GROUP writes one file per option",
    ["type", "token", "by", "tokenFormat", "theme", "output"],
    { overrides: { output: { description: "Directory for the files; default a temporary directory" } } },
  ),
  changes: command(
    "What changed since a revision you saw, by name: themes, Tokens, components and pages, including edits made in the App",
    ["since", "limit"],
  ),
  view: command(
    "Look at anything by name: the package, every or one page, component, variant, element or Tokens, as text, wireframe, png or issues",
    [
      "as",
      "canvas",
      "page",
      "platform",
      "component",
      "variant",
      "element",
      "token",
      "allTokens",
      "allComponents",
      "allPages",
      "scale",
      "output",
      ...VIEW,
      "designSystem",
      "locale",
      ...PAGE,
    ],
    { conflicts: { designSystem: ["page", "component", "canvas", "token", "allTokens", "allComponents", "allPages"] } },
  ),
  export: command(
    "Export a page, component or the design system page as a text wireframe or PNG file, by name",
    [
      ...TARGET,
      ...VIEW,
      "designSystem",
      "artifactFormat",
      "locale",
      "scale",
      "output",
      "evidence",
      "base64",
    ],
    {
      conflicts: {
        evidence: ["component", "variant", "designSystem", "locale"],
        designSystem: ["page", "component"],
      },
      requires: [
        {
          field: "artifactFormat",
          when: ["evidence", "base64"],
          code: "missing_png_format",
        },
      ],
    },
  ),
  validate: command(
    "Validate canonical data and report text/layout/contrast issues and coverage; a page checks every version and a component every variant unless one is named",
    [...TARGET, ...VIEW, "designSystem", "limit", "offset"],
    { conflicts: { designSystem: ["page", "component"] } },
  ),
  inspect: command("Read package identity, revision and counts"),
  list: command("Locate objects by kind", ["kind", ...PAGE], {
    output: DISCOVERY_OUTPUT,
    overrides: {
      limit: { defaultWhenFull: 100 },
      kind: {
        default: "all",
        values: [
          "all",
          "screens",
          "presentations",
          "contexts",
          "tokens",
          "components",
          "scenarios",
          "requirements",
          "flows",
        ],
        errorCode: "unknown_list_kind",
      },
    },
  }),
  catalog: command(
    "Read the design-system catalog",
    ["context", "theme", ...PAGE],
    { output: DISCOVERY_OUTPUT },
  ),
  "search-components": command(
    "Find reusable components",
    ["query", "theme", "limit"],
    {
      output: DISCOVERY_OUTPUT,
      required: [required("query", "missing_component_search")],
      overrides: {
        query: {
          nonBlank: true,
          errorCode: "missing_component_search",
        },
        limit: { minimum: 1, errorCode: "invalid_component_search_limit" },
      },
    },
  ),
  tokens: command("Read effective Tokens for this theme and Context", [
    "definitions",
    "token",
    "group",
    "type",
    "context",
    "locale",
    "theme",
    ...PAGE,
  ]),
  "search-tokens": command(
    "Find reusable Tokens",
    [
      "allThemes",
      "color",
      "context",
      "query",
      "theme",
      "type",
      "value",
      "limit",
    ],
    {
      atLeastOne: [
        {
          fields: ["query", "type", "value", "color"],
          code: "missing_token_search",
        },
      ],
      conflictsWith: [
        { fields: ["color", "value"], code: "ambiguous_token_search_value" },
        { fields: ["allThemes", "theme"], code: "conflicting_theme_options" },
      ],
      overrides: {
        query: { nonBlank: true, errorCode: "missing_token_search" },
        limit: { minimum: 1, errorCode: "invalid_token_search_limit" },
        type: {
          valuesWhen: [
            {
              when: ["color"],
              values: ["color"],
              errorCode: "conflicting_token_search_type",
            },
          ],
        },
      },
    },
  ),
  "effective-token": command("Resolve one Token", [...TOKEN, "path"], {
    required: [required("path", "missing_token_path")],
  }),
  "explain-token": command("Explain one Token resolution", [...TOKEN, "path"], {
    required: [required("path", "missing_token_path")],
  }),
  "import-draft": command(
    "Import a separate Draft package",
    ["input", "kind", "packageId"],
    {
      required: [required("input", "missing_draft_input")],
      overrides: {
        kind: { default: "figma", values: ["figma", "svg", "png"] },
      },
    },
  ),
  "import-media": command(
    "Import a media file",
    ["file", "inverseOut", "mediaPath", "name"],
    { required: [required("file", "missing_media_file")] },
  ),
  "import-font": command(
    "Import a font file",
    [
      "family",
      "file",
      "inverseOut",
      "name",
      "style",
      "weight",
    ],
    {
      required: [
        required("file", "missing_font_file"),
        required("family", "missing_font_family"),
      ],
    },
  ),
  "import-tokens": command(
    "Review or apply a token import",
    [
      "apply",
      "batchId",
      "compact",
      "dryRun",
      "input",
      "inverseOut",
      "select",
      "setName",
    ],
    { required: [required("input", "missing_import_input")] },
  ),
  "library-refresh": command("Refresh a declared URL Library", ["library"]),
  "draft-diff": command("Compare two Drafts", ["after"], {
    required: [required("after", "missing_draft_after")],
  }),
  "draft-compile": command(
    "Compile selected Draft fields into a batch",
    ["batchId", "draft", "selections"],
    {
      required: [
        required("draft", "missing_draft_compile_input"),
        required("selections", "missing_draft_compile_input"),
      ],
    },
  ),
  "token-set": command(
    "Create or change Tokens by name; one call sets default and theme option values",
    ["intent", "batchId", ...WRITE],
    { required: [required("intent", "missing_intent")] },
  ),
  "component-define": command(
    "Define a component by name: a base element tree, properties and variant changes",
    ["intent", "batchId", ...WRITE],
    { required: [required("intent", "missing_intent")] },
  ),
  "page-draw": command(
    "Draw a page (or one container) from a tree of named elements and component instances",
    ["intent", "batchId", ...WRITE],
    { required: [required("intent", "missing_intent")] },
  ),
  "page-move": command(
    "Move an element up, down, left or right among its siblings, or (without --element) a page left or right in its row on the canvas; the CLI picks the coordinates and keeps things from overlapping",
    ["page", "platform", "element", "direction", "moveSteps", "batchId", ...WRITE],
    {
      required: [required("page", "missing_page"), required("direction", "missing_direction")],
      overrides: { element: { description: 'Element to move, or "Parent / Element" when the name repeats' } },
    },
  ),
  "page-set": command(
    "Change fields of one element, or of the page itself, without drawing it again: sizes, colors, text, layout, a copy's props, text and set. Texts are measured and containers that hug grow, as page draw does",
    ["page", "platform", "element", "all", "setField", "intent", "batchId", ...WRITE],
    {
      required: [required("page", "missing_page")],
      overrides: {
        all: { description: "Change every version that has the element; without it an element in several versions needs --platform" },
        element: { description: 'Element to change ("Parent / Element" when the name repeats); without it the page itself (its size, fill, layout)' },
        platform: { description: "One version; needed when the element (or the page) is in several, unless --all" },
        intent: { description: 'JSON file {"set": {...}} for values awkward on a command line; --set adds to it' },
      },
    },
  ),
  "component-set": command(
    "Change fields of one element of a component, or of the component itself, without defining it again: in the one variant that has it, the one --variant names, or every one with --all",
    ["component", "variant", "element", "all", "setField", "intent", "batchId", ...WRITE],
    {
      required: [required("component", "missing_component")],
      overrides: {
        all: { description: "Change every variant that has the element; without it an element in several variants needs --variant" },
        element: { description: "Element to change; without it the component itself" },
        intent: { description: 'JSON file {"set": {...}}; --set adds to it' },
      },
    },
  ),
  "canvas-list": command("List canvases, the rows on each (one per module) and their pages left to right", []),
  "canvas-rename": command("Rename a canvas", ["canvas", "to", "batchId", ...WRITE], {
    required: [required("canvas", "missing_canvas"), required("to", "missing_to")],
    overrides: { to: { description: "New canvas name" } },
  }),
  "canvas-put": command(
    "Put a page on a canvas (made when it does not exist); by default every page is on one canvas",
    ["page", "canvas", "batchId", ...WRITE],
    { required: [required("page", "missing_page"), required("canvas", "missing_canvas")] },
  ),
  "flow-link": command(
    "Link an element to a page by name; --platform picks the version (default: the page's main one)",
    ["from", "to", "on", "action", "platform", "batchId", ...WRITE],
    {
      required: [required("from", "missing_from")],
      overrides: {
        action: {
          description: "navigate (default), overlay or back",
          values: ["navigate", "overlay", "back"],
          errorCode: "invalid_flow_action",
        },
      },
    },
  ),
  "flow-start": command(
    "Make a page version the start of a prototype flow, or (--remove) stop it being one; the flow's row on the canvas starts with it",
    ["page", "platform", "removeStart", "batchId", ...WRITE],
    { required: [required("page", "missing_page")] },
  ),
  "flow-list": command("List prototype starts and element links by page and element name", []),
  "flow-unlink": command(
    "Remove an element's links; --on or --to removes only those",
    ["from", "on", "to", "platform", "batchId", ...WRITE],
    {
      required: [required("from", "missing_from")],
      overrides: { to: { description: "Remove only the link to this page" }, on: { description: "Remove only links on this trigger" } },
    },
  ),
  "page-rename": command(
    "Rename a page (its boards and start follow), or one of its elements (--element). A used name is numbered (\"List 2\")",
    ["page", "platform", "element", "to", "batchId", ...WRITE],
    {
      required: [required("page", "missing_page"), required("to", "missing_to")],
      overrides: {
        to: { description: "New name: \"Module / Page\" or a last part that keeps the module; with --element, the element's new name" },
        element: { description: 'Rename this element instead: a name, "Parent / Element", or "Name [2]" when siblings share a name' },
        platform: { description: "The version --element is in; default the main one" },
      },
    },
  ),
  "page-delete": command(
    "Delete a page, one platform version (--platform) or one element (--element); pages other pages link to are protected",
    ["page", "platform", "element", "batchId", ...WRITE],
    {
      required: [required("page", "missing_page")],
      overrides: {
        platform: { description: "Delete only this version, or the version --element is in" },
        element: { description: 'Delete this element and its content: a name, or "Parent / Element"' },
      },
    },
  ),
  "component-rename": command(
    "Rename a component (copies keep pointing at it), or one of its elements in every variant that has it (--element; with --variant only there). A used name is numbered",
    ["component", "element", "variant", "to", "batchId", ...WRITE],
    {
      required: [required("component", "missing_component"), required("to", "missing_to")],
      overrides: {
        to: { description: "New component name, or the element's new name with --element" },
        element: { description: 'Rename this element instead: a name, "Parent / Element", or "Name [2]" when siblings share a name' },
      },
    },
  ),
  "component-delete": command(
    "Delete a component, or one variant (--variant); components in use are protected",
    ["component", "variant", "batchId", ...WRITE],
    { required: [required("component", "missing_component")] },
  ),
  "asset-set": command(
    "Create or change a color or typography by name",
    ["colorName", "typographyName", "assetValue", "batchId", ...WRITE],
    {
      exactlyOne: [["colorName", "typographyName"]],
      required: [required("assetValue", "missing_value")],
    },
  ),
  "asset-delete": command(
    "Delete a color or typography by name",
    ["colorName", "typographyName", "batchId", ...WRITE],
    { exactlyOne: [["colorName", "typographyName"]] },
  ),
  "media-delete": command(
    "Delete a media file by name",
    ["mediaName", "batchId", ...WRITE],
    { required: [required("mediaName", "missing_media")] },
  ),
  "font-delete": command(
    "Delete a font family, or one of its variants (--variant Bold)",
    ["fontFamily", "variant", "batchId", ...WRITE],
    {
      required: [required("fontFamily", "missing_font")],
      overrides: { variant: { description: "One font variant by name, for example Bold" } },
    },
  ),
  "theme-add": command(
    "Add theme options by full name; a new group is created with them",
    ["theme", "batchId", ...WRITE],
    {
      required: [required("theme", "missing_theme")],
      overrides: {
        theme: {
          description:
            "Option to add as Group/Option, for example Viewport/Tablet; repeat for several. The first option of a new group is its default",
          defaultFrom: undefined,
        },
      },
    },
  ),
  "theme-rename": command(
    "Rename one theme option or one theme group",
    ["theme", "group", "to", "batchId", ...WRITE],
    {
      exactlyOne: [["theme", "group"]],
      required: [required("to", "missing_to")],
      overrides: {
        theme: { description: "Option to rename, as Group/Option", defaultFrom: undefined },
        group: { description: "Group to rename" },
        to: { description: "New name: an option name (or Group/New) for --theme, a group name for --group" },
      },
    },
  ),
  "theme-default": command(
    "Make one option its group's default",
    ["theme", "batchId", ...WRITE],
    {
      required: [required("theme", "missing_theme")],
      overrides: {
        theme: { description: "Option to make the default, as Group/Option", defaultFrom: undefined },
      },
    },
  ),
  "theme-delete": command(
    "Delete one theme option or a whole group",
    ["theme", "group", "batchId", ...WRITE],
    {
      exactlyOne: [["theme", "group"]],
      overrides: {
        theme: { description: "Option to delete, as Group/Option", defaultFrom: undefined },
        group: { description: "Group to delete with all its options" },
      },
    },
  ),
  "token-delete": command(
    "Delete a Token by name from every theme option; bound Tokens are protected",
    ["path", "batchId", ...WRITE],
    {
      required: [required("path", "missing_token_path")],
      overrides: { path: { description: "Token name, for example color.brand" } },
    },
  ),
  impact: command(
    "Locate bindings of one Token",
    ["path", "theme"],
    { required: [required("path", "missing_token_path")] },
  ),
  apply: command("Apply one atomic batch", ["batch", ...WRITE], {
    required: [required("batch", "missing_batch")],
  }),
  watch: command("Emit changed package revisions", ["interval", "maxEvents"]),
  repair: command(
    "Read conflicts or apply one offered repair",
    [
      "action",
      "asset",
      "assetKind",
      "batchId",
      "conflict",
      "foundation",
      "replacementAssetId",
      "replacementPackageId",
      "selection",
    ],
    {
      requires: [
        {
          field: "replacementPackageId",
          when: { action: "retarget-reference" },
          code: "missing_repair_replacement",
        },
        {
          field: "replacementAssetId",
          when: { action: "retarget-reference" },
          code: "missing_repair_replacement",
        },
        {
          field: "foundation",
          when: { action: "choose-foundation" },
          code: "missing_foundation_path",
        },
        {
          field: "asset",
          when: { action: "recreate-product-asset" },
          code: "missing_recreated_asset",
        },
        {
          field: "assetKind",
          when: { action: "recreate-product-asset" },
          code: "missing_recreated_asset",
        },
      ],
      overrides: {
        asset: {
          type: "path",
          description: "JSON file containing the recreated asset",
        },
        assetKind: {
          valuesWhen: [
            {
              when: { action: "recreate-product-asset" },
              values: ["token", "component"],
              errorCode: "missing_recreated_asset",
            },
          ],
        },
      },
    },
  ),
  "migrate-themes": command("Copy a package with migrated themes", ["output"], {
    required: [required("output", "missing_migration_output")],
  }),
};

export function commandContract(name) {
  const spec = Object.hasOwn(COMMAND_CONTRACTS, name)
    ? COMMAND_CONTRACTS[name]
    : undefined;
  if (!spec)
    throw new SmallPenError(
      "unknown_schema_command",
      `Unknown command: ${name ?? "(missing)"}`,
      {
        received: name ?? null,
        nextOperations: [
          {
            argv: ["schema", "commands", "--json"],
            operation: "smallpen.schema",
          },
        ],
      },
    );
  const parameters = Object.fromEntries(
    [...spec.fields, ...(spec.common ?? COMMON)].map((field) => {
      const { errorCode: _code, ...definition } = {
        ...PARAMETERS[field],
        ...spec.overrides?.[field],
      };
      const required = (spec.required ?? []).some(
        (item) => item.field === field,
      );
      return [
        field,
        {
          ...definition,
          required,
          ...(required && ["path", "string"].includes(definition.type)
            ? { minLength: 1 }
            : {}),
          ...(definition.valuesWhen
            ? {
                valuesWhen: definition.valuesWhen.map(
                  ({ errorCode: _code, ...rule }) => rule,
                ),
              }
            : {}),
        },
      ];
    }),
  );
  return {
    command: name,
    purpose: spec.purpose,
    arguments:
      spec.arguments ??
      (spec.locator === false
        ? []
        : [
            {
              name: spec.locatorName ?? "package",
              type: "path",
              required: true,
            },
          ]),
    parameters,
    ...(spec.output ? { output: spec.output } : {}),
    ...(spec.requires ? { requires: spec.requires } : {}),
    ...(spec.conflicts ? { conflicts: spec.conflicts } : {}),
    ...(spec.exactlyOne ? { exactlyOne: spec.exactlyOne } : {}),
    ...(spec.atLeastOne
      ? { atLeastOne: spec.atLeastOne.map(({ fields }) => fields) }
      : {}),
    conflictsWith: [
      ...[["full", "compact"]].filter((group) =>
        group.every((field) => parameters[field]),
      ),
      ...(spec.conflictsWith ?? []).map(({ fields }) => fields),
    ],
    next: ["schema", "command", name, "--json"],
  };
}

function conditionMatches(when, seen) {
  return Array.isArray(when)
    ? when.every((field) => seen.has(field))
    : Object.entries(when).every(([field, value]) =>
        seen.get(field)?.includes(value),
      );
}

function conditionText(when, parameters) {
  return (
    Array.isArray(when)
      ? when.map((field) => parameters[field].option)
      : Object.entries(when).map(
          ([field, value]) => `${parameters[field].option} ${value}`,
        )
  ).join(" and ");
}

export function commandHelp(name) {
  const spec = commandContract(name);
  const options = (fields) =>
    fields.map((field) => spec.parameters[field].option).join(" or ");
  const rules = [
    ...(spec.requires ?? []).map(
      ({ field, when }) =>
        `${spec.parameters[field].option} is required with ${conditionText(when, spec.parameters)}`,
    ),
    ...Object.entries(spec.conflicts ?? {}).map(
      ([field, others]) =>
        `${spec.parameters[field].option} conflicts with ${options(others)}`,
    ),
    ...(spec.exactlyOne ?? []).map(
      (fields) => `Choose exactly one of ${options(fields)}`,
    ),
    ...(spec.atLeastOne ?? []).map(
      (fields) => `Supply at least one of ${options(fields)}`,
    ),
    ...spec.conflictsWith.map(
      (fields) => `Choose at most one of ${options(fields)}`,
    ),
    ...Object.entries(spec.parameters).flatMap(([_field, parameter]) =>
      (parameter.valuesWhen ?? []).map(
        ({ when, values }) =>
          `${parameter.option} accepts ${values.join("|")} with ${conditionText(when, spec.parameters)}`,
      ),
    ),
  ];
  return (
    `Options:\n` +
    Object.entries(spec.parameters)
      .map(([_field, parameter]) => {
        const {
          option,
          type,
          description,
          required,
          repeatable,
          values,
          minimum,
          maximum,
          exclusiveMinimum,
          minLength,
          nonBlank,
          minItems,
          maxItems,
          default: fallback,
          defaultFrom,
        } = parameter;
        const facts = [
          type,
          required ? "required" : "optional",
          ...(repeatable ? ["repeatable"] : []),
          ...(values ? [values.join("|")] : []),
          ...(minimum !== undefined ? [`min=${minimum}`] : []),
          ...(maximum !== undefined ? [`max=${maximum}`] : []),
          ...(exclusiveMinimum !== undefined ? [`>${exclusiveMinimum}`] : []),
          ...(minLength !== undefined ? [`minLength=${minLength}`] : []),
          ...(nonBlank ? ["non-blank"] : []),
          ...(minItems !== undefined ? [`minItems=${minItems}`] : []),
          ...(maxItems !== undefined ? [`maxItems=${maxItems}`] : []),
          ...(fallback !== undefined ? [`default=${fallback}`] : []),
          ...(defaultFrom ? [`default: ${defaultFrom}`] : []),
        ];
        return `  ${option} (${facts.join("; ")})\n    ${description}`;
      })
      .join("\n") +
    (rules.length
      ? `\nConstraints:\n${rules.map((rule) => `  ${rule}`).join("\n")}`
      : "")
  );
}

export function parameterExpectation(spec) {
  const parts = [spec.type, spec.description];
  if (spec.values) parts.push(`one of: ${spec.values.join(" | ")}`);
  if (spec.minimum !== undefined) parts.push(`minimum ${spec.minimum}`);
  if (spec.maximum !== undefined) parts.push(`maximum ${spec.maximum}`);
  if (spec.exclusiveMinimum !== undefined)
    parts.push(`greater than ${spec.exclusiveMinimum}`);
  if (spec.minLength !== undefined)
    parts.push(`at least ${spec.minLength} character(s)`);
  if (spec.nonBlank) parts.push("non-blank text");
  return parts.join("; ");
}

function facts(command, field, received = null) {
  const spec = commandContract(command).parameters[field];
  if (typeof received === "string" && received.length > 256)
    received = `${received.slice(0, 256)}…`;
  return {
    command,
    field,
    option: spec.option,
    path: spec.option,
    expected: parameterExpectation(spec),
    expectedType: spec.type,
    received,
    ...(spec.values ? { validValues: spec.values } : {}),
    nextOperations: [
      {
        argv: ["schema", "command", command, "--json"],
        operation: "smallpen.schema",
      },
    ],
  };
}

// Validate the single command spelling before opening a package.
export function validateCommandArguments(command, args) {
  const spec = commandContract(command);
  const argument = spec.arguments[0];
  if (argument?.required && (!args[1] || args[1].startsWith("-")))
    throw new SmallPenError(
      argument.name === "workspace" ? "missing_workspace" : "missing_package",
      `A ${argument.name} path is required`,
      {
        command,
        field: argument.name,
        path: "arguments[0]",
        expected: `a non-empty ${argument.name} path`,
        expectedType: argument.type,
        received: null,
        nextOperations: [{ argv: spec.next, operation: "smallpen.schema" }],
      },
    );
  const byOption = new Map(
    Object.entries(spec.parameters).map(([field, parameter]) => [
      parameter.option,
      { field, parameter },
    ]),
  );
  const seen = new Map();
  const hasValue = (field) =>
    seen.get(field) === true ||
    (seen.get(field) ?? []).some((value) => value !== "");
  for (let index = 2; index < args.length; index += 1) {
    const option = args[index];
    const match = byOption.get(option);
    if (!match) {
      const code = option.startsWith("-")
        ? "unknown_option"
        : "unexpected_argument";
      const validOptions = [...byOption.keys()].sort();
      const suggestion = suggestField(option, validOptions);
      throw new SmallPenError(
        code,
        `${code === "unknown_option" ? "Unknown option" : "Unexpected positional argument"}: ${option}`,
        {
          command,
          option,
          validOptions,
          ...(suggestion ? { suggestion } : {}),
          nextOperations: [
            {
              argv: ["schema", "command", command, "--json"],
              operation: "smallpen.schema",
            },
          ],
        },
      );
    }
    const { field, parameter } = match;
    if (seen.has(field) && !parameter.repeatable)
      throw new SmallPenError(
        "duplicate_option",
        `${parameter.option} may be given only once`,
        facts(command, field, option),
      );
    if (parameter.type === "boolean") {
      seen.set(field, true);
      continue;
    }
    const value = args[++index];
    if (value === undefined || value.startsWith("--"))
      throw new SmallPenError(
        "missing_option_value",
        `${parameter.option} requires a value`,
        facts(command, field),
      );
    const definition = {
      ...PARAMETERS[field],
      ...COMMAND_CONTRACTS[command].overrides?.[field],
    };
    if (
      (parameter.minLength !== undefined &&
        value.length < parameter.minLength) ||
      (parameter.nonBlank && value.trim() === "")
    )
      throw new SmallPenError(
        definition.errorCode ??
          COMMAND_CONTRACTS[command].required?.find(
            (item) => item.field === field,
          )?.code ??
          "invalid_option_value",
        `${parameter.option} requires a non-empty value`,
        facts(command, field, value),
      );
    if (parameter.type === "integer" || parameter.type === "number") {
      const parsed = Number(value);
      if (
        value.trim() === "" ||
        !Number.isFinite(parsed) ||
        (parameter.type === "integer" && !Number.isSafeInteger(parsed)) ||
        (parameter.minimum !== undefined && parsed < parameter.minimum) ||
        (parameter.maximum !== undefined && parsed > parameter.maximum) ||
        (parameter.exclusiveMinimum !== undefined &&
          parsed <= parameter.exclusiveMinimum)
      ) {
        throw new SmallPenError(
          definition.errorCode ??
            (parameter.type === "integer"
              ? "invalid_integer_option"
              : "invalid_number_option"),
          `${parameter.option} is outside its ${parameter.type} range`,
          facts(command, field, value),
        );
      }
    }
    const enumValue =
      parameter.type === "integer" || parameter.type === "number"
        ? Number(value)
        : value;
    if (parameter.values && !parameter.values.includes(enumValue))
      throw new SmallPenError(
        definition.errorCode ?? "invalid_option_value",
        `${parameter.option} must be one of: ${parameter.values.join(", ")}`,
        facts(command, field, value),
      );
    if (parameter.type === "assignment" && !/^[^=]+=[\s\S]+$/.test(value))
      throw new SmallPenError(
        field === "context"
          ? "invalid_context_argument"
          : "invalid_initialization_answer_argument",
        `${parameter.option} requires ${field === "context" ? "CONTEXT=VALUE" : "QUESTION_ID=JSON"}`,
        facts(command, field, value),
      );
    if (parameter.type === "json" || field === "answer") {
      const source =
        field === "answer" ? value.slice(value.indexOf("=") + 1) : value;
      try {
        JSON.parse(source);
      } catch {
        throw new SmallPenError(
          field === "answer"
            ? "invalid_initialization_answer_json"
            : definition.errorCode,
          `${parameter.option} requires valid JSON`,
          {
            ...facts(command, field, value),
            ...(field === "answer"
              ? { questionId: value.slice(0, value.indexOf("=")) }
              : {}),
          },
        );
      }
    }
    if (
      parameter.uniqueBy === "assignment-key" &&
      (seen.get(field) ?? []).some(
        (previous) =>
          previous.slice(0, previous.indexOf("=")) ===
          value.slice(0, value.indexOf("=")),
      )
    )
      throw new SmallPenError(
        "duplicate_option",
        `${parameter.option} cannot set the same key twice`,
        facts(command, field, value),
      );
    seen.set(field, [
      ...(Array.isArray(seen.get(field)) ? seen.get(field) : []),
      value,
    ]);
  }
  for (const [field, parameter] of Object.entries(spec.parameters)) {
    const count = seen.get(field)?.length ?? 0;
    if (
      (parameter.minItems !== undefined && count < parameter.minItems) ||
      (parameter.maxItems !== undefined && count > parameter.maxItems)
    )
      throw new SmallPenError(
        "invalid_compare_count",
        `${parameter.option} requires ${parameter.minItems} to ${parameter.maxItems} items`,
        facts(command, field, count),
      );
  }
  for (const group of spec.conflictsWith)
    if (group.every((field) => seen.has(field)))
      throw new SmallPenError(
        COMMAND_CONTRACTS[command].conflictsWith?.find(
          ({ fields }) => fields.join() === group.join(),
        )?.code ?? "conflicting_output_options",
        `Choose at most one of ${group.map((field) => spec.parameters[field].option).join(" or ")}`,
        {
          ...facts(
            command,
            group[0],
            seen.get(group[0]) === true ? true : seen.get(group[0])[0],
          ),
          fields: group,
          expected: "at most one of the listed options",
        },
      );
  for (const item of COMMAND_CONTRACTS[command].required ?? [])
    if (!seen.has(item.field))
      throw new SmallPenError(
        item.code,
        `${command} requires ${spec.parameters[item.field].option}`,
        facts(command, item.field),
      );
  for (const item of spec.requires ?? [])
    if (conditionMatches(item.when, seen) && !hasValue(item.field))
      throw new SmallPenError(
        item.code,
        `${spec.parameters[item.field].option} is required with ${conditionText(item.when, spec.parameters)}`,
        {
          ...facts(command, item.field, seen.get(item.field)?.[0] ?? null),
          expected: `${parameterExpectation(spec.parameters[item.field])}; required with ${conditionText(item.when, spec.parameters)}`,
        },
      );
  for (const [field, parameter] of Object.entries(spec.parameters))
    for (const rule of {
      ...PARAMETERS[field],
      ...COMMAND_CONTRACTS[command].overrides?.[field],
    }.valuesWhen ?? [])
      if (
        seen.has(field) &&
        conditionMatches(rule.when, seen) &&
        !rule.values.includes(seen.get(field)[0])
      )
        throw new SmallPenError(
          rule.errorCode,
          `${parameter.option} accepts ${rule.values.join(" or ")} with ${conditionText(rule.when, spec.parameters)}`,
          {
            ...facts(command, field, seen.get(field)[0]),
            expected: `${rule.values.join(" or ")} with ${conditionText(rule.when, spec.parameters)}`,
            validValues: rule.values,
          },
        );
  for (const { fields, code } of COMMAND_CONTRACTS[command].atLeastOne ?? [])
    if (!fields.some((field) => seen.has(field)))
      throw new SmallPenError(
        code,
        `Supply at least one of ${fields.map((field) => spec.parameters[field].option).join(" or ")}`,
        {
          ...facts(command, fields[0]),
          fields,
          expected: "at least one of the listed options",
        },
      );
  for (const [field, others] of Object.entries(spec.conflicts ?? {}))
    if (seen.has(field) && others.some((other) => seen.has(other)))
      throw new SmallPenError(
        "conflicting_read_target",
        "Choose one Token, Component, or Screen/Presentation target",
        {
          ...facts(command, field, seen.get(field)[0]),
          fields: [field, ...others.filter((other) => seen.has(other))],
        },
      );
  for (const group of spec.exactlyOne ?? [])
    if (group.filter(hasValue).length !== 1)
      throw new SmallPenError(
        group.includes("theme")
          ? "missing_theme_target"
          : group.includes("colorName")
            ? "missing_asset_target"
            : "missing_token_reference",
        `Choose exactly one of ${group.map((field) => spec.parameters[field].option).join(" or ")}`,
        {
          ...facts(command, group[0], seen.get(group[0])?.[0] ?? null),
          fields: group,
          expected: "exactly one target",
          nextOperations: [{ argv: spec.next, operation: "smallpen.schema" }],
        },
      );
  return args;
}

export function numericDefault(command, option, full) {
  const spec = Object.values(commandContract(command).parameters).find(
    (parameter) => parameter.option === option,
  );
  return (
    (full ? spec.defaultWhenFull : undefined) ??
    spec.default ??
    Number.POSITIVE_INFINITY
  );
}
