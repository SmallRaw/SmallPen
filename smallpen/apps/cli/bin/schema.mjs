// `smallpen schema [topic]`: the JSON shapes a write needs. Field lists,
// types, enums, and examples come from the validators in @smallpen/core
// so this output and validation stay the same; a test applies every
// example to a workspace made by `smallpen init`.
import {
  AXIS_ROLES,
  CANONICAL_SCHEMA_RULES,
  CONTEXT_AXIS_KINDS,
  INSTANCE_OVERRIDE_FIELDS,
  OPERATION_SCHEMAS,
  SMALLPEN_FORMAT_CAPABILITIES,
  SmallPenError,
  suggestField,
  TOKEN_BINDING_FIELD_TYPES,
  TOKEN_VALUE_SHAPES,
  THEME_INTENT_ACTIONS,
  TOKEN_INTENT_ACTIONS,
  TOKEN_SET_FIELDS,
  COMPONENT_EDIT_ACTIONS,
  ASSET_KINDS,
  ASSET_EDIT_FIELDS,
  INTERACTION_INTENT_ACTIONS,
  PROTOTYPE_EVENTS,
  PROTOTYPE_ACTIONS,
  VARIANT_NODE_TYPES,
} from "@smallpen/core";
import { COMMAND_CONTRACTS, commandContract } from "./command-contract.mjs";
import { CLI_RULES } from "./workflow.mjs";
import { helpTopic, nextQuery } from "./help-topics.mjs";
import { pageItems } from "./read-output.mjs";
import {
  COMMAND_GROUPS,
  PUBLIC_COMMANDS,
  actionContract,
} from "./command-tree.mjs";

const FORMAT = SMALLPEN_FORMAT_CAPABILITIES;
const OPERATION_TYPES = FORMAT.canonicalWrite.operationTypes;
// The default `smallpen init` layout: one self-contained Package.
const PACKAGE = "acme/acme.smallpen";
const REVISION = "<package.revision from smallpen inspect PACKAGE --json>";

export const PACKAGE_ROLES = Object.freeze({
  foundation:
    "Token sets and themes, Context Axes (density, viewport, ...) and Component Sets. In the default layout (one self-contained Package) write them to that Package; in the foundation-product layout write them to the Foundation (<name>-foundation.smallpen).",
  product:
    "Screens, Presentations, Scenarios, requirements. In the default layout they live in the same self-contained Package; in the foundation-product layout they live in the Product, which resolves the Foundation's Tokens, themes and components through its dependency. view, validate, export, token list and search take the Package with the Screens.",
});

function batchFor(operations, batchId) {
  return { baseRevision: REVISION, batchId, operations };
}

const OPS = OPERATION_SCHEMAS;

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

const TYPOGRAPHY_TOKEN = {
  setId: "tset_base",
  token: {
    id: "tok_type_heading",
    name: "type.heading",
    type: "typography",
    value: { fontFamily: "Source Sans Pro", fontSize: 24, fontWeight: 700 },
  },
  type: "put-set-token",
};

// A generic, executable atomic-write example. Scene design order lives in Skills.
export const WORKED_EXAMPLE = Object.freeze([
  {
    title: "Create a blank package",
    argv: ["project", "init", PACKAGE, "--name", "Acme", "--json"],
    files: {},
    note: "The reply returns the package revision and initial canvas IDs. No business brief is needed.",
  },
  {
    title: "Create one canvas through an atomic batch",
    argv: ["advanced", "apply", PACKAGE, "--batch", "canvas.json", "--json"],
    files: {
      "canvas.json": batchFor(
        [
          {
            type: "put-screen",
            screen: {
              id: "scr_demo",
              name: "Canvas",
              basePresentationId: "pres_demo_base",
              counterparts: [],
              presentations: [
                {
                  id: "pres_demo_base",
                  name: "Base",
                  rootId: "node_demo_root",
                  interactions: [],
                  viewport: { width: 600, height: 400 },
                  nodes: {
                    node_demo_root: {
                      id: "node_demo_root",
                      name: "Canvas",
                      type: "FRAME",
                      children: [],
                      x: 0,
                      y: 0,
                      width: 600,
                      height: 400,
                      fills: [{ type: "solid", color: "#ffffff" }],
                    },
                  },
                },
              ],
            },
          },
        ],
        "canvas-v1",
      ),
    },
    note: "Copy the revision from the previous reply (or inspect PACKAGE) into baseRevision before applying the batch. Existing IDs replace whole definitions; use update for partial edits.",
  },
  {
    title: "Add text to that canvas",
    argv: ["advanced", "apply", PACKAGE, "--batch", "text.json", "--json"],
    files: {
      "text.json": batchFor(
        [
          {
            type: "add-presentation-node",
            screenId: "scr_demo",
            presentationId: "pres_demo_base",
            parentId: "node_demo_root",
            node: {
            id: "node_title",
            type: "TEXT",
            name: "Title",
            text: "Example",
            children: [],
            x: 16,
            y: 16,
            width: 300,
            height: 32,
            fills: [{ type: "solid", color: "#111111" }],
            textStyle: {
              fontFamily: "Source Sans Pro",
              fontSize: 18,
              fontWeight: 400,
              lineHeight: 1.3,
            },
            },
          },
        ],
        "text-v1",
      ),
    },
    note: "Use the revision the previous write returned. Day-to-day pages are drawn by name with page draw; apply is for exact operations such as an undo batch.",
  },
  {
    title: "Read the selected canvas as a text wireframe",
    argv: ["view", PACKAGE, "--page", "Canvas", "--as", "wireframe", "--json"],
    files: {},
  },
]);

function compact(value) {
  return JSON.stringify(value);
}

export function workedExampleText() {
  return WORKED_EXAMPLE.map((step, index) => {
    const lines = [`  ${index + 1}. ${step.title}`];
    for (const [name, value] of Object.entries(step.files)) {
      lines.push(`     ${name}: ${compact(value)}`);
    }
    lines.push(`     smallpen ${step.argv.join(" ")}`);
    if (step.note) lines.push(`     ${step.note}`);
    return lines.join("\n");
  }).join("\n");
}

function operationSummary(type) {
  const schema = OPS[type];
  return {
    package: schema.package,
    purpose: schema.purpose,
    required: Object.entries(schema.fields)
      .filter(([, spec]) => spec.required)
      .map(([name]) => name),
    ...(schema.oneOf ? { requiresOneOf: schema.oneOf } : {}),
    type,
  };
}

// put-* operations replace an existing object with the same id whole;
// init seeds a few, so say which.
const EXISTING_ID_NOTES = {
  "put-component-set":
    "An existing componentSet.id is replaced whole (no merge). init seeds one Component Set per initialComponents answer, for example cmp_button with variant var_button_default and no axes; the init reply lists them in seeded.componentSets.",
  "put-token":
    "An existing tokenId is replaced whole (no merge). init seeds one Token per initialTokens answer, for example tok_color_brand, tok_spacing_md, tok_radius_md (in the token set tset_base: change them with put-set-token or set-token-value); the init reply lists them in seeded.tokens.",
  "put-set-token":
    "An existing token id in the set is replaced whole (no merge). init seeds one Token per initialTokens answer in tset_base, for example tok_color_brand, tok_spacing_md, tok_radius_md; the init reply lists them in seeded.tokens.",
};

function existingIdNote(type, schema) {
  if (EXISTING_ID_NOTES[type]) return EXISTING_ID_NOTES[type];
  return type.startsWith("put-") && /replace/i.test(schema.purpose)
    ? "An existing object with the same id is replaced whole (no merge)."
    : undefined;
}

function operationDetail(type) {
  const schema = OPS[type];
  const existingId = existingIdNote(type, schema);
  return {
    ...(existingId ? { existingId } : {}),
    fields: {
      type: {
        description: "Operation type",
        required: true,
        type: "string",
        value: type,
      },
      ...schema.fields,
    },
    inverse: schema.inverse,
    package: schema.package,
    packageRole:
      PACKAGE_ROLES[schema.package] ??
      "Either Package; it changes the Package you pass",
    purpose: schema.purpose,
    ...(schema.oneOf ? { requiresOneOf: schema.oneOf } : {}),
    unknownFields: "rejected with unknown_operation_field",
    example: batchFor([schema.example], `example-${type}`),
    run: `smallpen apply <${schema.package === "foundation" ? "foundation" : "product"}.smallpen> --batch BATCH.json --dry-run --json`,
  };
}

const NODE_FIELD_TYPES = {
  appliedTokens: "object; local-name compatibility only, prefer tokenBindings",
  backgroundBlur: "object or array of objects",
  blur: "object or array of objects",
  "blend-mode": "string",
  constraints: `constraints-h: ${CANONICAL_SCHEMA_RULES.constraints["constraints-h"].join(" | ")}; constraints-v: ${CANONICAL_SCHEMA_RULES.constraints["constraints-v"].join(" | ")} (how a child follows its parent when the parent is resized in the editor). When a copy is resized: left keeps x; right moves x by the growth; leftright grows width by it; center moves x by half of it; scale scales x and width by new/old size (top, bottom, topbottom alike). Without a constraint, a child of a FRAME, COMPONENT or INSTANCE stays left/top; other children scale. A flex layout places its children unless they are layout-item-absolute`,
  content: "Penpot path content",
  cornerRadius: "number or [topLeft, topRight, bottomRight, bottomLeft]",
  fills:
    '[{type:"solid", color:"#rrggbb", opacity?}] (also linear-gradient, radial-gradient, image)',
  flipX: "boolean",
  flipY: "boolean",
  grids: "array of objects",
  growType: `TEXT only: ${CANONICAL_SCHEMA_RULES.textGrowTypes.join(" | ")}`,
  interactions:
    "array of native App configurations; set them by name with flow link and flow unlink. Canonical put-interaction is separate.",
  layout:
    'flex/grid layout: "flex" | "grid" plus layout-* fields (strings; layout-gap/layout-padding/layout-item-margin are objects)',
  locked: "boolean",
  mediaRef: "IMAGE only: media_... id or {packageId, assetId}",
  name: "non-empty string",
  opacity: "number from 0 to 1",
  pathData: "PATH only: SVG path data",
  points: "PATH only: array of points",
  proportionLock: "boolean",
  rotation: "number, 0 <= r < 360",
  shadow:
    '{offsetX, offsetY, blur, spread, color, opacity?, inset?, hidden?} or an array of them; px numbers, for example {"offsetX":0,"offsetY":2,"blur":8,"spread":0,"color":"#00000033"}. Bind a shadow Token with tokenBindings.shadow instead to follow themes',
  strokes: `[{type:"solid", color, width, alignment?:${CANONICAL_SCHEMA_RULES.strokeAlignments.join("|")}, style?:${CANONICAL_SCHEMA_RULES.strokeStyles.join("|")}, dash?, gap?, capStart?, capEnd?}]. alignment defaults to inner; an open path always strokes centered. Dash patterns follow Penpot, for stroke width w: dashed = w+10 on, w+10 off (dash/gap override them); dotted = round dots w across, w+5 apart; mixed = w+5 on, w+5 off, w+1 on, w+5 off. capStart/capEnd (PATH ends): ${CANONICAL_SCHEMA_RULES.strokeCaps.join(" | ")}; cap sizes grow with w: triangle-arrow tip 1.42w past the end and 8.5w wide, circle-marker radius 2w, square-marker side 4.24w, diamond-marker corners 3w from the end`,
  text: "TEXT only: plain text (string)",
  textBlocks:
    "TEXT only: [{runs:[{text, textStyle?, fills?}], textStyle?}] that join to text",
  textStyle: "TEXT only: see textStyle below",
  tokenBindings:
    "{field: {packageId, assetId:tok_...}}; see tokenBindings below",
  touched: "array of Penpot touched groups",
  visible: "boolean",
};

function tokenBindingTable() {
  return Object.fromEntries(
    FORMAT.canonicalPackage.tokenBindingFields.map((field) => [
      field,
      TOKEN_BINDING_FIELD_TYPES.get(field === "fills.N" ? "fill" : field) ?? [],
    ]),
  );
}

const NODE_EXAMPLE = OPS["add-presentation-node"].example.node;

function nodeTopic() {
  return {
    summary:
      "A node is one layer. A Presentation stores nodes flat in nodes:{id: node}; children lists child ids. x and y are relative to the parent node.",
    required: {
      children:
        "array of child node ids (ids only; add each child as its own node)",
      height: "number",
      id: "must start with node_ (node_[A-Za-z0-9_-]+), unique in its Presentation (or variant); the nodes key equals id",
      name: "non-empty string",
      type: `${CANONICAL_SCHEMA_RULES.nodeTypes.join(" | ")}. Inside a Component variant only ${VARIANT_NODE_TYPES.join(", ")} (no ELLIPSE, GROUP or PATH)`,
      width: "number",
      x: "number, relative to the parent",
      y: "number, relative to the parent",
    },
    byType: nodeTypesTopic().types,
    fields: Object.fromEntries(
      CANONICAL_SCHEMA_RULES.nodeChangeFields.map((field) => [
        field,
        NODE_FIELD_TYPES[field] ??
          (field.startsWith("constraints")
            ? NODE_FIELD_TYPES.constraints
            : field.startsWith("layout")
              ? "layout field; see layout"
              : field === "height" ||
                  field === "width" ||
                  field === "x" ||
                  field === "y"
                ? "number"
                : "see validator"),
      ]),
    ),
    layout: {
      values: {
        layout: ["flex", "grid"],
        "layout-flex-dir": ["row", "row-reverse", "column", "column-reverse"],
        "layout-wrap-type": ["nowrap", "wrap"],
        "layout-justify-content": [
          "start",
          "center",
          "end",
          "space-between",
          "space-around",
          "space-evenly",
          "stretch",
        ],
        "layout-align-items": ["start", "end", "center", "stretch"],
        "layout-item-h-sizing": ["fill", "fix", "auto"],
        "layout-item-v-sizing": ["fill", "fix", "auto"],
      },
      objects: {
        "layout-gap": '{"row-gap":12,"column-gap":12}; numeric pixels',
        "layout-padding":
          '{"p1":16,"p2":16,"p3":16,"p4":16}; top, right, bottom, left',
        "layout-item-margin":
          '{"m1":0,"m2":0,"m3":0,"m4":0}; top, right, bottom, left',
      },
      childOrder:
        "children uses Penpot layer order. row/column positions the last child first; row-reverse/column-reverse positions the first child first. For a row displaying A then B, store children:[B,A].",
      sizing:
        "Set layout-item-h-sizing on a child for horizontal size and layout-item-v-sizing for vertical size. fill shares the remaining main-axis space after fixed children, gap and padding; on the cross axis it fills the inner parent size. fix uses stored width/height. auto currently uses stored width/height too; supply measured text bounds. layout-item-absolute:true excludes a child from flex flow.",
      projection:
        "These are Penpot layout values, not enforced enum constraints. SmallPen reflows one flex line with gap, padding, direction, fill, start/center/end alignment and start/center/end/space-between justification. Grid, wrapping, margins, auto/min/max sizing, stretch and other modes report layout_projection_partial in view/check/PNG and skipped layout reflow in coverage; stored bounds are not App-equivalent layout validation.",
      example: {
        rootId: "node_layout_root",
        nodes: {
          node_layout_root: {
            id: "node_layout_root",
            name: "Row",
            type: "FRAME",
            x: 0,
            y: 0,
            width: 320,
            height: 80,
            children: ["node_fill", "node_fixed"],
            layout: "flex",
            "layout-flex-dir": "row",
            "layout-gap": { "row-gap": 12, "column-gap": 12 },
            "layout-padding": { p1: 16, p2: 16, p3: 16, p4: 16 },
          },
          node_fixed: {
            id: "node_fixed",
            name: "First, fixed",
            type: "RECTANGLE",
            x: 0,
            y: 0,
            width: 80,
            height: 48,
            children: [],
            "layout-item-h-sizing": "fix",
          },
          node_fill: {
            id: "node_fill",
            name: "Second, fill",
            type: "RECTANGLE",
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            children: [],
            "layout-item-h-sizing": "fill",
            "layout-item-v-sizing": "fill",
          },
        },
      },
    },
    textStyle: {
      fields: CANONICAL_SCHEMA_RULES.textStyleFields,
      numbers:
        "fontSize (px), fontWeight (100-950), lineHeight, letterSpacing (px) are numbers",
      lineHeight:
        "A multiplier of fontSize: 1.4 means 140% (Penpot's line height). Not px: the editor reads 24 as 24 times the font size. The same holds for lineHeight in a typography Token. Default 1.2.",
      fonts:
        "Only Source Sans Pro (Latin) is bundled. Any other fontFamily, including one for Chinese or another script, must be imported into the package first with smallpen font import; otherwise render falls back to Source Sans Pro, reports font_render_fallback, and text it cannot draw is a text_missing_glyphs issue.",
      values: CANONICAL_SCHEMA_RULES.textStyleEnums,
      note: "Text alignment is textStyle.textAlign, not a node field.",
    },
    tokenBindings: {
      shape: '{"fill": {"packageId":"pkg_acme","assetId":"tok_color_brand"}}',
      fieldTokenTypes: tokenBindingTable(),
      notBindable:
        "x, y, rotation, and layout-* fields cannot bind Tokens directly. Use itemSpacing, rowGap/columnGap, or paddingTop/Right/Bottom/Left to bind layout spacing.",
      note: "A binding replaces the raw value when the design resolves. width/height drive size. itemSpacing drives both layout-gap axes; rowGap/columnGap override one axis. paddingTop/Right/Bottom/Left drive layout-padding p1/p2/p3/p4. Unbound sides keep their raw numbers; bound spacing is at least zero.",
    },
    changes:
      "update-presentation-node, update-node, and update-component-node changes take only the mutable fields above; null clears an optional field. id, type and children cannot be changed here. For Presentation child order use reorder-presentation-children; for membership use add/move/remove-presentation-node. For a component's elements prefer component define, which redraws the variants by name.",
    example: NODE_EXAMPLE,
  };
}

function nodeTypesTopic() {
  return {
    types: {
      COMPONENT:
        "Root of a Component variant, or a located Component main node",
      ELLIPSE: "Ellipse inside x/y/width/height",
      FRAME: "Container; fills, strokes, cornerRadius, layout",
      GROUP: "Plain group of children",
      IMAGE: "Requires mediaRef (import with smallpen media import)",
      INSTANCE: "Requires instance; see: smallpen schema instance",
      PATH: "pathData or points; strokes with capStart/capEnd for arrows",
      RECTANGLE: "Rectangle; fills, strokes, cornerRadius",
      TEXT: "Requires text; textStyle, textBlocks, growType",
    },
    presentationTypes: CANONICAL_SCHEMA_RULES.nodeTypes,
    variantTypes: VARIANT_NODE_TYPES.join(", "),
    variantNote:
      "ELLIPSE, GROUP and PATH are allowed only in Screen Presentations, not in Component variants: use a RECTANGLE with cornerRadius for a circle, a FRAME to group.",
  };
}

function tokenTopic() {
  return {
    summary:
      'Tokens live in token sets (Penpot / Tokens Studio / DTCG $themes model). A Token is {id:tok_..., name:"color.surface", type, value}. Themes switch which sets are active; see: smallpen schema theme.',
    setToken: {
      id: "tok_... permanent id; bindings reference it",
      name: "dot path, for example color.surface; a later active set overrides an earlier one with the same name. A name is either a Token or a group, never both: with color.brand present, color.brand.hover is rejected (token_name_collision); use color.brand-hover, or name them color.brand.default and color.brand.hover from the start",
      type: FORMAT.canonicalPackage.tokenTypes.join(" | "),
      value:
        'value matching type; see: smallpen schema token-types. An alias is "{other.token.name}"',
      description: "optional string",
    },
    operations: {
      appCreate: TOKEN_INTENT_ACTIONS["create-row"].example,
      appChangeValue: TOKEN_INTENT_ACTIONS["set-value"].example,
      create: "put-set-token {setId, token}",
      changeValue: "set-token-value {tokenId, value}",
      bind: "set-token-binding {screenId, nodeId, field, binding:{packageId, assetId}}, or tokenBindings on the node",
      remove: "remove-token (fails while bound; see smallpen impact)",
      sets: "put-token-set, delete-token-set; themes: put-token-theme, delete-token-theme, set-active-token-themes",
    },
    dtcgFiles:
      "put-token {filePath, path, tokenId, definition:{$type, $value, $extensions:{smallpen:{id}}}} writes a DTCG token file. Prefer put-set-token: init makes no DTCG file. filePath names a DTCG file (created when missing, for example tokens/dtcg.json); it must not be the token library entry with sets and themes (tokens/foundation.json or tokens/tokens.json after init; smallpen tokens PACKAGE --json shows each Token's filePath). Its Tokens are always active and do not take part in themes; $extensions.smallpen.contextValues still resolve with --context but are deprecated for themes (warning context_values_deprecated).",
    tokenBindings: tokenBindingTable(),
    themes: "smallpen schema theme",
    read: "smallpen tokens <package> --theme Theme/Dark --json lists resolved values and the themes (themes[].active)",
    definitions:
      "smallpen tokens <package> --definitions [--group GROUP] --json lists exact stored Token objects in all option Sets, including packageId/setId/group/option. Missing cells have no item and do not inherit Default. --theme/--context cannot be combined with --definitions.",
    authoring:
      "token set PACKAGE --intent FILE writes Tokens by name with default and per-option values; token delete --path removes one. See schema token-set.",
    example: OPS["put-set-token"].example,
    typographyExample: TYPOGRAPHY_TOKEN,
    intent: { operations: [OPS["put-set-token"].example] },
  };
}

function themeTopic() {
  return {
    summary:
      "A theme is Penpot's token theme: group/name plus the token sets it activates. One theme per group is active. A Token resolves to the last active set that defines its name, so a theme set overrides the base set by name. This is the model Penpot's token manager, Tokens Studio and DTCG $themes share.",
    model: {
      set: "{id:tset_..., name, description?, tokens:[{id:tok_..., name, type, value}]}",
      theme: "{id:theme_..., group, name, setIds:[tset_...], description?}",
      selection:
        "activeThemeIds/activeSetIds = stored App selection; defaultThemeIds = optional independent project defaults, one per group. Missing defaults use Default, else first library option. With no themes, CLI uses defaultSetIds, or all library sets in order for legacy data",
    },
    initLayout:
      "init turns every theme-kind contextAxes answer into one group: set base (active in every theme) plus one native Group/Option Set per value, preserving group/option labels, and a theme per value activating [base, that value's set]. Example: Theme/Light = [base, Theme/Light], Theme/Dark = [base, Theme/Dark]. Stable IDs still use slugs. Existing packages keep their original Set paths.",
    recipe: [
      'put-set-token {setId:"tset_base", token:{id:"tok_color_surface", name:"color.surface", type:"color", value:"#ffffff"}}',
      'put-set-token {setId:"tset_theme_dark", token:{id:"tok_color_surface_dark", name:"color.surface", type:"color", value:"#1c1b1f"}}',
      "bind nodes to tok_color_surface (the base id); Theme/Dark shows #1c1b1f",
      'smallpen view PACKAGE --theme Theme/Dark --json (read only); set-active-token-themes {themePaths:["Theme/Dark"]} stores it',
    ],
    read: "theme list, view, validate and export use project defaults, not App active themes; --theme GROUP/NAME overrides only named groups. None of these reads write. A Presentation alone does not choose themes. Use themes PACKAGE to discover project-defined groups/options/defaults; platform, language and light/dark are optional examples, not required dimensions.",
    foundationProduct:
      "In the foundation-product layout the Foundation owns the sets and themes. The Product stores which Foundation themes it uses in manifest dependencies[0].activeThemeIds (Foundation theme ids); set-active-token-themes on the Product writes it. The Product's own active sets sit on top of the Foundation's by name.",
    operations: {
      createSet: OPS["put-token-set"].example,
      addToken: OPS["put-set-token"].example,
      createTheme: OPS["put-token-theme"].example,
      activate: OPS["set-active-token-themes"].example,
    },
    contexts:
      "Context Axes (smallpen schema context) are for non-token choices such as viewport or platform. Token contextValues on theme axes are deprecated; smallpen migrate-themes PACKAGE --output NEW converts them to sets and themes.",
  };
}

function tokenTypesTopic() {
  return {
    types: Object.fromEntries(
      FORMAT.canonicalPackage.tokenTypes.map((type) => [
        type,
        TOKEN_VALUE_SHAPES[type],
      ]),
    ),
    alias: 'Any type also accepts "{path.of.another.token}" of the same type.',
  };
}

function componentSetTopic() {
  return {
    summary:
      "A Component Set is one component with variants. Axes name the choices; each variant selects one value per Axis and holds its own node tree.",
    variantNodeTypes: `${VARIANT_NODE_TYPES.join(", ")} only. ELLIPSE, GROUP and PATH are rejected in variants (they work in Screen Presentations): use a RECTANGLE with cornerRadius for a circle, a FRAME to group, an IMAGE (media import) for an icon.`,
    fields: {
      id: "cmp_...",
      name: "non-empty string",
      axes: "[{id:axis_..., name, role, domain?}]",
      variants:
        "[{id:var_..., selection:{axisId: value}, rootId, nodes:{id: node}}]",
      visibility: "public | private (default public)",
      category: "optional string",
      description: "optional string",
      deprecated: "optional boolean",
      replacement: "optional {packageId, assetId:cmp_...}",
    },
    axisRoles: {
      values: AXIS_ROLES,
      configuration:
        "An option the designer picks: style (primary/secondary), size, content, icon. domain is optional but recommended.",
      state:
        "An interaction state: default, hover, pressed, disabled. domain is required.",
      modelling:
        "Model primary/secondary as one configuration Axis (axis_style, domain [primary, secondary]) and hover/disabled as a separate state Axis. Every variant must select every Axis, and each selection must be unique.",
    },
    variantNodes:
      "Variant node x/y are relative to the parent; the root is usually COMPONENT at 0,0. Node ids may repeat across variants so Instance overrides keep working.",
    operations: {
      create: "put-component-set (whole set) or put-variant (one variant)",
      edit: "update-component-node {componentId, variantId, nodeId, changes}",
      remove: "delete-variant, delete-component-set",
    },
    instancesAfterChanges:
      "A write that leaves an Instance in the same Package selecting a variant that no longer exists (deleted variant, changed Axes) is rejected with stale_instance_variant. Product Instances of a Foundation set are checked by smallpen validate PRODUCT and listed in staleInstances; fix them with select-instance-variant.",
    package: "foundation",
    example: OPS["put-component-set"].example.componentSet,
  };
}

function instanceTopic() {
  return {
    summary:
      "An INSTANCE node places a Component Set variant. It references the component by Package and id, and may override fields of nodes inside it.",
    node: {
      type: "INSTANCE",
      instance: {
        component: "{packageId: owning Package (pkg_acme), assetId: cmp_...}",
        variant: "{axisId: value} for every Axis of the Component Set",
        overrides:
          '{"<sourceNodeId>:<field>": value}; prefer set-instance-override',
      },
      size: "x/y/width/height of the Instance itself",
    },
    overrides: {
      path: "<sourceNodeId>:<field>, or <nestedInstanceId>__<sourceNodeId>:<field> inside a nested Instance",
      fields: [...INSTANCE_OVERRIDE_FIELDS],
      operations:
        "set-instance-override, clear-instance-override, select-instance-variant",
    },
    pageIntent:
      'In page draw an element {"use":"Button","props":{"Style":"secondary"},"set":{"Label.text":"Add task"}} places a copy; each setting becomes a checked instance override.',
    find: "smallpen component search <product> --query button --json returns recommendedInsertion.element, ready to add to a page draw intent",
    example: {
      node: INSTANCE_NODE_EXAMPLE,
      parentId: "node_home_root",
      presentationId: "pres_home_mobile",
      screenId: "scr_home",
      type: "add-presentation-node",
    },
  };
}

function presentationTopic() {
  return {
    summary:
      "A Presentation is one layout of a Screen (mobile, desktop, ...). Its rendered size is the bounds of its root node(s), not viewport.",
    fields: {
      id: "pres_...",
      name: "non-empty string",
      platform: "optional string",
      viewport:
        "{width, height}: the declared device size (metadata; render ignores it)",
      nodes: "{node_id: node}",
      rootId: "root node id (or rootIds for several roots)",
      interactions: "[] (see put-interaction)",
      background: "optional color string",
      prototypeFlows: "optional array",
    },
    resize:
      "To change the rendered size, resize the root node with update-presentation-node {changes:{width, height}}. Keep viewport in step with update-presentation {changes:{viewport:{width, height}}} and Scenario viewports with put-scenario.",
    updatePresentationFields: CANONICAL_SCHEMA_RULES.presentationChangeFields,
    example: OPS["add-presentation"].example.presentation,
  };
}

function screenTopic() {
  return {
    summary:
      "A Screen holds one or more Presentations; basePresentationId is the default. Screens live in the Product.",
    fields: {
      id: "scr_...",
      name: "non-empty string",
      basePresentationId: "pres_... of one of its Presentations",
      presentations: "[Presentation]; see: smallpen schema presentation",
      counterparts: "[] (links between Presentations)",
    },
    defaultScreen:
      "set-default-screen chooses the page reads and renders use when no page is named",
    example: OPS["put-screen"].example.screen,
  };
}

function scenarioTopic() {
  return {
    summary:
      "A Scenario is a reproducible design state: a target Screen/Presentation, a Context, optional token themes, and declarative actions.",
    fields: {
      id: "scn_...",
      name: "non-empty string",
      target:
        '{kind:"screen", screen:{packageId, assetId:scr_...}, presentationId}',
      context: "{axisId: value} for the Context Axes",
      themes:
        'optional ["Group/Name"] token themes the Scenario shows; --theme overrides them',
      actions: "[] or declarative actions (set-override, ...)",
      expectedVisibleNodeIds:
        "Exact set of visible canonical target Node IDs after actions, excluding nodes hidden by ancestors. Instance internals are generated IDs and must not be listed. Use read --full for editable IDs; validate reports the actual canonical visibleNodeIds on mismatch.",
      fixture: "{key: scalar}",
      viewport:
        "{width, height, scale}: declared size (metadata; render uses the root node size)",
    },
    update:
      "put-scenario with the same id replaces the Scenario, for example to keep its viewport in step with the root node.",
    example: OPS["put-scenario"].example.scenario,
  };
}

function contextTopic() {
  return {
    summary:
      "Context Axes are finite design dimensions such as viewport, density or locale. The Package (or the Foundation of a pair) declares them in contexts/*.json; select values with --context AXIS=VALUE. Themes are token themes instead (smallpen schema theme).",
    axis: {
      id: "axis_...",
      name: "non-empty string",
      kind: CONTEXT_AXIS_KINDS.join(" | "),
      values: "[{id, name}]",
      defaultValue: "one value id",
    },
    profile: "{id:ctx_..., name, values:{axisId: value}, default?: boolean}",
    themes:
      "Themes are token sets + themes, not Context Axes: see smallpen schema theme. A theme-kind init answer becomes token themes.",
    init: "project init creates no Context Axes. Use explicit operations to add project-defined axes when needed.",
    example: OPS["put-context-file"].example.contextFile,
  };
}

function batchTopic() {
  return {
    summary:
      "Every write is one atomic Operation Batch. Nothing is written unless every operation is valid.",
    batch: {
      baseRevision:
        "package.revision from smallpen inspect PACKAGE --json; a stale value is rejected",
      batchId: "1-192 characters [A-Za-z0-9_.-], new for every write",
      operations: "array; see: smallpen schema operations",
    },
    packages: PACKAGE_ROLES,
    commands: {
      apply:
        "smallpen apply PACKAGE --batch BATCH.json [--dry-run] [--explain] [--diff]",
      token:
        "smallpen token PACKAGE --intent {operations:[...]}: like apply, with baseRevision and batchId filled in",
      page: "smallpen page PRODUCT --intent {screenId, presentationId?, parentId?, index?, nodes:[node, ...]}: one add-presentation-node per node, all siblings under parentId (default: the root); overrides on an INSTANCE node become set-instance-override operations",
      flow: "smallpen flow PRODUCT --intent: same as page, for flowchart nodes",
    },
    result:
      "batchId, revision, changedFiles, affectedIds, changed (false for no-op or replay), alreadyApplied, dryRun and summary. changeReportPath records exact before/after values. reverseEdit/inverseBatchPath describe an explicit new apply write with its own identity and a fixed baseRevision, not history rollback. After later edits, read current fields and construct a new scoped edit; do not force an old snapshot by changing its baseRevision. --inverse-out FILE chooses a durable file. --full includes exact details. Reuse batchId only for identical retries; ledger retains at most 500 identities.",
    dryRun: "--dry-run validates and returns the result without writing",
    workedExample: WORKED_EXAMPLE,
  };
}

function initTopic() {
  return {
    summary:
      "Create a blank package with one canvas and Theme/Default. No business brief, question state, starter Tokens, components or platform copies.",
    command:
      "smallpen project init PATH [--name NAME] [--layout single|foundation-product] --json",
    path: "A .smallpen path creates that package directly; a directory creates PATH/BASENAME.smallpen inside a new workspace; --name changes the display name, not the filename.",
    layouts: {
      single: "Default: one self-contained package.",
      "foundation-product":
        "A new directory containing a blank Foundation and a Product that resolves its Tokens and components.",
    },
    existing: "Reject an existing target without changing its contents.",
    nextOperations: [
      nextQuery(["schema", "command", "project", "init", "--json"]),
    ],
  };
}

const TOPICS = {
  workflow: {
    build: () => CLI_RULES,
    summary: "CLI operation rules (compatibility alias for help rules)",
  },
  "component-define": {
    build: () => ({
      command: "component define PACKAGE --intent FILE --json",
      fields: {
        name: "component name; defining it again replaces it and keeps its id",
        properties: "{Property: [values]}; every combination becomes a variant",
        base: "element tree (see element) shared by all variants",
        variants: '[{when: {Property: value}, set: {"Child.prop": value}}]: changes applied to matching variants, in order',
      },
      element: {
        name: "element name; children are found by name in set paths and instance text",
        text: "makes a text element; color, font ({typography token}), fontFamily (a family imported with font import, or {font-family token}), fontSize, fontWeight, lineHeight, textAlign",
        children: "child elements; a container lays them out as a column unless layout says row or none",
        layout: "row | column | none; in none the CLI places children so they do not overlap: give place (\"below Header\", {rightOf: \"Sidebar\", gap: 24}) or nothing, x/y only to pin one",
        "gap / padding": "number or {token}; padding takes 1, 2 or 4 values",
        "align / justify": "start | center | end (align also stretch; justify also space-between)",
        "width / height": 'number, "fill" (or "100%") or "hug"; a text in a row fills by default',
        "fill / stroke / radius / opacity / shadow": 'value or {token}; stroke is a color or {color, width, style}, width one value or four sides [top, right, bottom, left]; radius is one value or four corners [top-left, top-right, bottom-right, bottom-left]',
        margin: "number or {token}; 1, 2 or 4 values, like padding",
        "minWidth / maxWidth / minHeight / maxHeight": "number or {token}",
        "letterSpacing / lineHeight / textTransform / textDecoration": "text only; value or {token} (textTransform: uppercase|lowercase|capitalize|none, textDecoration: underline|line-through|none)",
        rotation: "degrees or {token}",
        visible: "false hides it (for example per platform in a variant), or {flag} for a boolean Token",
        use: 'component name for an instance, with props {Property: value}, text {"Element": "text"} and set {"Element.field": value}; field is text, visible, opacity, fill, color, name, stroke, radius, width, height, shadow, fontSize, fontWeight, fontFamily, letterSpacing, lineHeight, or props (switch a nested component: {"Icon.props": {"Size": "lg"}}); no element name sets the copy itself; a {token} value is the copy\'s own binding',
      },
      example: {
        name: "Button",
        properties: { Style: ["primary", "secondary"], Size: ["sm", "md"] },
        base: { layout: "row", padding: [8, "{space.4}"], fill: "{color.brand}", radius: "{radius.md}", align: "center",
          children: [{ name: "Label", text: "Button", color: "#ffffff", font: "{type.label}" }] },
        variants: [
          { when: { Style: "secondary" }, set: { fill: "#ffffff", stroke: "{color.brand}", "Label.color": "{color.brand}" } },
          { when: { Size: "md" }, set: { padding: [12, 24] } },
        ],
      },
      notes: [
        "The CLI creates node ids, child order, layout fields and Token bindings; text is measured with the renderer's fonts and hugging elements are sized from it.",
        "A value in braces binds that Token by path; any other value is literal. view marks literal visual values so you can bind them later.",
        "text: \"{text.path}\" binds a string Token and visible: \"{flag.path}\" a boolean one, so text follows the language option and an element shows or hides per option; instance text: {Label: \"{text.path}\"} works too.",
      ],
    }),
    summary: "Define a component by name: base elements, properties and variant changes",
  },
  "page-draw": {
    build: () => ({
      command: "page draw PACKAGE --intent FILE --json",
      fields: {
        page: "page name; a new page is created",
        module: "business module; pages of one module share the name prefix Module / Page and one row block on the canvas",
        canvas: "optional canvas name; by default every page is on one canvas (Penpot links and prototype flows only reach boards on the same canvas); give a name only to split pages off",
        platform: "desktop (default), mobile or tablet: the page version to draw; size defaults to the platform's",
        into: "redraw only this container's content",
        children: "element tree (schema component-define, element); instances use components by name",
      },
      example: {
        page: "Board", module: "Tasks", platform: "desktop", layout: "row", fill: "{color.bg.canvas}",
        children: [
          { name: "Sidebar", width: 240, height: "fill", children: [{ name: "Logo", text: "Flowboard" }] },
          { name: "Content", width: "fill", height: "fill", padding: 24, gap: 16, children: [
            { name: "Top bar", layout: "row", width: "fill", align: "center", children: [
              { name: "Title", text: "Sprint 24", width: "fill" },
              { name: "New task", use: "Button", props: { Style: "primary" }, text: { Label: "New task" } },
            ] },
          ] },
        ],
      },
      notes: [
        "Drawing a page again redraws it; elements drawn again under the same names keep their ids and interactions.",
        "An instance whose new text is longer than its slot grows by the measured difference.",
        "Link elements with flow link --from \"Page / Element\" --to Page.",
        "Move an element later with page move --page Page --element Name --direction up|down|left|right [--steps N]; the CLI picks the coordinates.",
        "The CLI lays the canvas out: each business flow (module) is a block of rows, one per platform, pages left to right in flow order (from the flow start along links), more room between flows. Reorder a page with page move --page Page --direction left|right; see it with canvas list or view --canvas NAME.",
        "Strings are Tokens: bind text with \"{text.path}\" (string Token) and visibility with \"{flag.path}\" (boolean Token); check a language with view --theme Language/zh-CN.",
      ],
    }),
    summary: "Draw a page or one container from named elements and component instances",
  },
  "token-set": {
    build: () => ({
      command: "token set PACKAGE --intent FILE --json",
      fields: { tokens: `[{${TOKEN_SET_FIELDS.join(", ")}}]` },
      example: {
        tokens: [
          { name: "color.brand", type: "color", value: "#4f46e5", values: { "Theme/Dark": "#818cf8" } },
          { name: "space.4", type: "spacing", value: 16 },
          { name: "color.action", type: "color", value: "{color.brand}" },
        ],
      },
      notes: [
        "Name Tokens by path and theme options as Group/Option. Where values are stored is the CLI's business.",
        "value is the Token's value wherever no option overrides it; values override named options. Each call changes only what it names.",
        "group (optional) names the theme group whose options a new Token should vary by. type is required for a new Token.",
        "Write an alias as a value in braces, for example {color.brand}. Read results with token list: each row lists values that differ under other options.",
        "Strings and flags are Tokens too: type string (with a Language group, values per language) and boolean. token export --type string --by Language writes one file per language for code.",
      ],
    }),
    summary: "Set Tokens by name: default and per-option values in one call",
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
  batch: {
    build: batchTopic,
    summary: "Batch contract, Package roles, and a worked example",
  },
  "component-set": {
    build: componentSetTopic,
    summary: "Component Set, Axis roles, variants",
  },
  context: {
    build: contextTopic,
    summary: "Context Axes and profiles (viewport, density, locale, ...)",
  },
  init: {
    build: initTopic,
    summary: "Blank package paths, layouts and creation behavior",
  },
  instance: { build: instanceTopic, summary: "INSTANCE nodes and overrides" },
  node: { build: nodeTopic, summary: "Node fields, textStyle, tokenBindings" },
  "node-types": {
    build: nodeTypesTopic,
    summary: "What each node type requires",
  },
  operation: {
    summary:
      "One operation: fields, types, example, inverse (smallpen schema operation TYPE)",
  },
  operations: {
    build: () => ({
      operations: OPERATION_TYPES.map(operationSummary),
      next: "smallpen schema operation TYPE",
    }),
    summary: "Every operation type with its purpose and required fields",
  },
  presentation: {
    build: presentationTopic,
    summary: "Presentation fields, size, and resizing",
  },
  scenario: { build: scenarioTopic, summary: "Scenario fields and viewport" },
  screen: { build: screenTopic, summary: "Screen fields" },
  theme: {
    build: themeTopic,
    summary: "Token sets and themes, --theme, Foundation + Product themes",
  },
  token: {
    build: tokenTopic,
    summary: "Tokens in token sets, DTCG files, bindings",
  },
  "token-types": {
    build: tokenTypesTopic,
    summary: "The value each Token type accepts",
  },
};

export const SCHEMA_TOPICS = Object.freeze(Object.keys(TOPICS));


export function schemaTopic(
  name,
  argument,
  { full = true, limit, offset = 0, action } = {},
) {
  if (name === undefined) {
    return {
      topics: Object.fromEntries(
        Object.entries(TOPICS).map(([name, { summary }]) => [name, summary]),
      ),
      usage: "smallpen schema TOPIC [--json]; smallpen schema operation TYPE",
    };
  }
  if (name === "command") {
    if (Object.hasOwn(COMMAND_GROUPS, argument)) {
      if (!action) return { topic: name, ...helpTopic(argument) };
      return { topic: name, ...actionContract(argument, action) };
    }
    if (action !== undefined)
      throw new SmallPenError(
        "unexpected_argument",
        `Unexpected command action: ${action}`,
      );
    return { topic: name, ...commandContract(argument) };
  }
  if (name === "operation") {
    if (!Object.hasOwn(OPS, argument ?? "")) {
      const suggestion = suggestField(argument, OPERATION_TYPES);
      throw new SmallPenError(
        "unknown_schema_operation",
        `${argument === undefined ? "smallpen schema operation requires TYPE" : `Unknown operation type: ${argument}`}.` +
          `${suggestion ? ` Did you mean ${suggestion}?` : ""} Types: ${OPERATION_TYPES.join(", ")}`,
        {
          validTypes: [...OPERATION_TYPES],
          ...(suggestion ? { suggestion } : {}),
        },
      );
    }
    const detail = operationDetail(argument);
    return { topic: "operation", type: argument, ...detail };
  }
  if (!Object.hasOwn(TOPICS, name)) {
    const suggestion = suggestField(name, Object.keys(TOPICS));
    throw new SmallPenError(
      "unknown_schema_topic",
      `Unknown schema topic: ${name}.${suggestion ? ` Did you mean ${suggestion}?` : ""} ` +
        `Topics: ${Object.keys(TOPICS).join(", ")}`,
      {
        validTopics: Object.keys(TOPICS),
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
