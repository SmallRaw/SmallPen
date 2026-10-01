// `smallpen schema [topic]`: the JSON shapes a write needs. Field lists,
// types, enums, and examples come from the validators in @smallpen/core
// so this output and validation stay the same; a test applies every
// example to a workspace made by `smallpen init`.
import {
  AXIS_ROLES,
  CANONICAL_SCHEMA_RULES,
  CONTEXT_AXIS_KINDS,
  INITIALIZATION_QUESTION_IDS,
  initializationQuestions,
  INSTANCE_OVERRIDE_FIELDS,
  OPERATION_SCHEMAS,
  SMALLPEN_FORMAT_CAPABILITIES,
  SmallPenError,
  suggestField,
  TOKEN_BINDING_FIELD_TYPES,
  TOKEN_VALUE_SHAPES,
} from "@smallpen/core";

const FORMAT = SMALLPEN_FORMAT_CAPABILITIES;
const OPERATION_TYPES = FORMAT.canonicalWrite.operationTypes;
const FOUNDATION = "acme/acme-foundation.smallpen";
const PRODUCT = "acme/acme.smallpen";
const REVISION = "<package.revision from smallpen inspect PACKAGE --json>";

export const PACKAGE_ROLES = Object.freeze({
  foundation:
    "Shared Tokens, Context Axes (theme, density, ...), and shared Component Sets. Write them to the Foundation (<name>-foundation.smallpen).",
  product:
    "Screens, Presentations, Scenarios, requirements, Product-local Tokens and overrides. read-view, render, evidence, tokens, and search-* take the Product; it resolves Foundation Tokens and components through its dependency.",
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
    component: { assetId: "cmp_button", packageId: "pkg_acme_foundation" },
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
      defaultValue: "light",
      id: "axis_theme",
      kind: "theme",
      name: "Theme",
      values: ["light", "dark"],
    },
  ],
  firstJourney: "Add a task",
  firstOutput: "Task list screen",
  firstScenario: "Default",
  firstScreen: "Home",
  foundationChoice: "create-new",
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
  definition: {
    $extensions: { smallpen: { id: "tok_type_heading" } },
    $type: "typography",
    $value: { fontFamily: "Inter", fontSize: 24, fontWeight: 700 },
  },
  filePath: "tokens/foundation.json",
  path: "type.heading",
  tokenId: "tok_type_heading",
  type: "put-token",
};

// tokens -> component set -> screen nodes -> instance override -> render.
// Each step runs in a test against a fresh `smallpen init` workspace.
export const WORKED_EXAMPLE = Object.freeze([
  {
    title: "Create the Foundation and Product packages",
    argv: ["init", "acme", "--answers", "answers.json", "--confirm", "--json"],
    files: { "answers.json": INIT_ANSWERS_EXAMPLE },
    note: "Creates acme/acme-foundation.smallpen (pkg_acme_foundation) and acme/acme.smallpen (pkg_acme_product) with Screen scr_home, Presentation pres_home_mobile, root node_home_root. The reply lists these ids (packages, start) and the starter Tokens tok_color_brand, tok_spacing_md, tok_radius_md and Component Set cmp_button (seeded).",
  },
  {
    title: "Add Tokens to the Foundation (token intents need no revision)",
    argv: ["token", FOUNDATION, "--intent", "tokens.json", "--json"],
    files: { "tokens.json": { operations: [OPS["put-token"].example, TYPOGRAPHY_TOKEN] } },
  },
  {
    title: "Add a Button Component Set with a configuration axis",
    argv: ["apply", FOUNDATION, "--batch", "button.json", "--json"],
    files: {
      "button.json": batchFor([OPS["put-component-set"].example], "button-v1"),
    },
    note: "This replaces the starter cmp_button that init seeded (put-component-set with an existing id replaces it whole). baseRevision: run smallpen inspect acme/acme-foundation.smallpen --json and copy package.revision.",
  },
  {
    title: "Add a title and a Button Instance to the Product Screen",
    argv: ["page", PRODUCT, "--intent", "screen.json", "--json"],
    files: {
      "screen.json": {
        nodes: [
          {
            ...OPS["add-presentation-node"].example.node,
            tokenBindings: {
              typography: { assetId: "tok_type_heading", packageId: "pkg_acme_foundation" },
            },
          },
          INSTANCE_NODE_EXAMPLE,
        ],
        screenId: "scr_home",
      },
    },
    note: "Every intent node becomes a sibling under parentId (default: the Presentation root). Give children:[] and add nested nodes in a later intent with parentId.",
  },
  {
    title: "Resize the screen and override the Instance label",
    argv: ["apply", PRODUCT, "--batch", "screen-edit.json", "--json"],
    files: {
      "screen-edit.json": batchFor(
        [
          OPS["update-presentation-node"].example,
          OPS["update-presentation"].example,
          OPS["set-instance-override"].example,
        ],
        "screen-edit-1",
      ),
    },
    note: "The rendered size is the root node size; update-presentation only updates the declared viewport.",
  },
  {
    title: "Render the dark theme and collect review evidence",
    argv: ["render", PRODUCT, "--context", "axis_theme=dark", "--output", "home-dark.png", "--json"],
    files: {},
    note: "Then: smallpen evidence acme/acme.smallpen --output review --json",
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
    "An existing tokenId is replaced whole (no merge). init seeds one Token per initialTokens answer, for example tok_color_brand, tok_spacing_md, tok_radius_md; the init reply lists them in seeded.tokens.",
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
      type: { description: "Operation type", required: true, type: "string", value: type },
      ...schema.fields,
    },
    inverse: schema.inverse,
    package: schema.package,
    packageRole: PACKAGE_ROLES[schema.package] ?? "Either Package; it changes the Package you pass",
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
  constraints: "constraints-h / constraints-v: string or object",
  content: "Penpot path content",
  cornerRadius: "number or [topLeft, topRight, bottomRight, bottomLeft]",
  fills: '[{type:"solid", color:"#rrggbb", opacity?}] (also linear-gradient, radial-gradient, image)',
  flipX: "boolean",
  flipY: "boolean",
  grids: "array of objects",
  growType: `TEXT only: ${CANONICAL_SCHEMA_RULES.textGrowTypes.join(" | ")}`,
  interactions: "array of objects (prefer put-interaction)",
  layout: 'flex/grid layout: "flex" | "grid" plus layout-* fields (strings; layout-gap/layout-padding/layout-item-margin are objects)',
  locked: "boolean",
  mediaRef: "IMAGE only: media_... id or {packageId, assetId}",
  name: "non-empty string",
  opacity: "number from 0 to 1",
  pathData: "PATH only: SVG path data",
  points: "PATH only: array of points",
  proportionLock: "boolean",
  rotation: "number, 0 <= r < 360",
  shadow: "object or array of objects",
  strokes: '[{type:"solid", color, width, alignment?:center|inner|outer, style?:solid|dashed|dotted|mixed, capStart?, capEnd?}]',
  text: "TEXT only: plain text (string)",
  textBlocks: "TEXT only: [{runs:[{text, textStyle?, fills?}], textStyle?}] that join to text",
  textStyle: "TEXT only: see textStyle below",
  tokenBindings: "{field: {packageId, assetId:tok_...}}; see tokenBindings below",
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
      children: "array of child node ids (ids only; add each child as its own node)",
      height: "number",
      id: "node_... unique in its Presentation (or variant)",
      name: "non-empty string",
      type: CANONICAL_SCHEMA_RULES.nodeTypes.join(" | "),
      width: "number",
      x: "number, relative to the parent",
      y: "number, relative to the parent",
    },
    byType: nodeTypesTopic().types,
    fields: Object.fromEntries(
      CANONICAL_SCHEMA_RULES.nodeChangeFields.map((field) => [
        field,
        NODE_FIELD_TYPES[field] ??
          (field.startsWith("constraints") ? NODE_FIELD_TYPES.constraints
            : field.startsWith("layout") ? "layout field; see layout"
              : field === "height" || field === "width" || field === "x" || field === "y" ? "number"
                : "see validator"),
      ]),
    ),
    textStyle: {
      fields: CANONICAL_SCHEMA_RULES.textStyleFields,
      numbers: "fontSize, fontWeight, lineHeight, letterSpacing are numbers",
      values: CANONICAL_SCHEMA_RULES.textStyleEnums,
      note: "Text alignment is textStyle.textAlign, not a node field.",
    },
    tokenBindings: {
      shape: '{"fill": {"packageId":"pkg_acme_foundation","assetId":"tok_color_brand"}}',
      fieldTokenTypes: tokenBindingTable(),
      notBindable:
        "x, y, rotation, and layout-* fields (layout-gap, layout-padding) cannot bind Tokens; write numbers.",
      note:
        "A binding replaces the raw value when the design resolves. sizing Tokens on width/height change the rendered size. paddingTop/Right/Bottom/Left and itemSpacing accept spacing Tokens but only record intent: layout reads layout-padding and layout-gap, which take numbers.",
    },
    changes:
      "update-presentation-node, update-node, and update-component-node changes take the fields above; null clears an optional field; unknown fields are rejected with a suggestion.",
    example: NODE_EXAMPLE,
  };
}

function nodeTypesTopic() {
  return {
    types: {
      COMPONENT: "Root of a Component variant, or a located Component main node",
      ELLIPSE: "Ellipse inside x/y/width/height",
      FRAME: "Container; fills, strokes, cornerRadius, layout",
      GROUP: "Plain group of children",
      IMAGE: "Requires mediaRef (import with smallpen import-media)",
      INSTANCE: "Requires instance; see: smallpen schema instance",
      PATH: "pathData or points; strokes with capStart/capEnd for arrows",
      RECTANGLE: "Rectangle; fills, strokes, cornerRadius",
      TEXT: "Requires text; textStyle, textBlocks, growType",
    },
    presentationTypes: CANONICAL_SCHEMA_RULES.nodeTypes,
    variantTypes: "COMPONENT, COMPONENT_SET, FRAME, IMAGE, INSTANCE, RECTANGLE, TEXT",
  };
}

function tokenTopic() {
  return {
    summary:
      "Tokens are DTCG documents. Write shared Tokens to the Foundation (tokens/foundation.json); the Product resolves Product Tokens first, then Foundation Tokens.",
    definition: {
      $type: FORMAT.canonicalPackage.tokenTypes.join(" | "),
      $value: "value matching $type; see: smallpen schema token-types. An alias is \"{other.token.path}\"",
      $description: "optional string",
      "$extensions.smallpen": {
        id: "tok_... permanent id; must equal the operation's tokenId",
        contextValues:
          '[{"when":{"axis_theme":"dark"},"value":"#1c1b1f"}]: value per Context (exactly when + value)',
        visibility: "public | private",
        deprecated: "boolean",
      },
    },
    operations: {
      create: "put-token {filePath, path, tokenId, definition}",
      changeValue: "set-token-value {tokenId, value}",
      bind: "set-token-binding {screenId, nodeId, field, binding:{packageId, assetId}}, or tokenBindings on the node",
      remove: "deprecate-token, remove-token (fails while bound; see smallpen impact)",
    },
    tokenBindings: tokenBindingTable(),
    themes:
      "Theme values use contextValues on Context Axes (smallpen schema context). The Penpot-format library in tokens/product.json has sets and themes; switch them with set-active-token-themes {themePaths:[\"Theme/Default\"]}.",
    read: "smallpen tokens <product> --context axis_theme=dark --json lists resolved values",
    example: OPS["put-token"].example,
    typographyExample: TYPOGRAPHY_TOKEN,
    intent: { operations: [OPS["put-token"].example] },
  };
}

function tokenTypesTopic() {
  return {
    types: Object.fromEntries(
      FORMAT.canonicalPackage.tokenTypes.map((type) => [type, TOKEN_VALUE_SHAPES[type]]),
    ),
    alias: 'Any type also accepts "{path.of.another.token}" of the same type.',
  };
}

function componentSetTopic() {
  return {
    summary:
      "A Component Set is one component with variants. Axes name the choices; each variant selects one value per Axis and holds its own node tree.",
    fields: {
      id: "cmp_...",
      name: "non-empty string",
      axes: "[{id:axis_..., name, role, domain?}]",
      variants: "[{id:var_..., selection:{axisId: value}, rootId, nodes:{id: node}}]",
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
      state: "An interaction state: default, hover, pressed, disabled. domain is required.",
      modelling:
        "Model primary/secondary as one configuration Axis (axis_style, domain [primary, secondary]) and hover/disabled as a separate state Axis. Every variant must select every Axis, and each selection must be unique.",
    },
    variantNodes:
      "Variant node x/y are relative to the parent; the root is usually COMPONENT at 0,0. Node ids may repeat across variants so Instance overrides keep working.",
    operations: {
      create: "put-component-set (whole set) or put-variant (one variant)",
      edit: "update-component-node {componentSetId, variantId, nodeId, changes}",
      remove: "delete-variant, delete-component-set",
    },
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
        component: "{packageId: owning Package (pkg_acme_foundation), assetId: cmp_...}",
        variant: "{axisId: value} for every Axis of the Component Set",
        overrides: '{"<sourceNodeId>:<field>": value}; prefer set-instance-override',
      },
      size: "x/y/width/height of the Instance itself",
    },
    overrides: {
      path: "<sourceNodeId>:<field>, or <nestedInstanceId>__<sourceNodeId>:<field> inside a nested Instance",
      fields: [...INSTANCE_OVERRIDE_FIELDS],
      operations: "set-instance-override, clear-instance-override, select-instance-variant",
    },
    pageIntent:
      'In a page or flow intent an INSTANCE node may carry overrides {"node_button_label:text":"Add task"}; each becomes a checked set-instance-override in the same atomic batch.',
    find: "smallpen search-components <product> --query button --json returns recommendedInsertion.intent, a ready page intent",
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
      viewport: "{width, height}: the declared device size (metadata; render ignores it)",
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
    defaultScreen: "set-default-screen chooses the Screen reads and renders use without --screen",
    example: OPS["put-screen"].example.screen,
  };
}

function scenarioTopic() {
  return {
    summary:
      "A Scenario is a reproducible design state: a target Screen/Presentation, a Context, and declarative actions. Select it with --scenario.",
    fields: {
      id: "scn_...",
      name: "non-empty string",
      target: '{kind:"screen", screen:{packageId, assetId:scr_...}, presentationId}',
      context: "{axisId: value} for the Context Axes",
      actions: "[] or declarative actions (set-override, ...)",
      expectedVisibleNodeIds: "[node ids]",
      fixture: "{key: scalar}",
      viewport: "{width, height, scale}: declared size (metadata; render uses the root node size)",
    },
    update: "put-scenario with the same id replaces the Scenario, for example to keep its viewport in step with the root node.",
    example: OPS["put-scenario"].example.scenario,
  };
}

function contextTopic() {
  return {
    summary:
      "Context Axes are finite design dimensions such as theme or density. The Foundation declares them in contexts/*.json; select values with --context AXIS=VALUE.",
    axis: {
      id: "axis_...",
      name: "non-empty string",
      kind: CONTEXT_AXIS_KINDS.join(" | "),
      values: "[{id, name}]",
      defaultValue: "one value id",
    },
    profile: "{id:ctx_..., name, values:{axisId: value}, default?: boolean}",
    themes:
      "Give a Token a per-theme value with $extensions.smallpen.contextValues [{when:{axis_theme:\"dark\"}, value}], then render with --context axis_theme=dark.",
    init: "smallpen init asks for contextAxes as [{id, name, kind, values:[\"light\",\"dark\"], defaultValue}]",
    example: OPS["put-context-file"].example.contextFile,
  };
}

function batchTopic() {
  return {
    summary:
      "Every write is one atomic Operation Batch. Nothing is written unless every operation is valid.",
    batch: {
      baseRevision: "package.revision from smallpen inspect PACKAGE --json; a stale value is rejected",
      batchId: "1-192 characters [A-Za-z0-9_.-], new for every write",
      operations: "array; see: smallpen schema operations",
    },
    packages: PACKAGE_ROLES,
    commands: {
      apply: "smallpen apply PACKAGE --batch BATCH.json [--dry-run] [--explain] [--diff]",
      token: "smallpen token PACKAGE --intent {operations:[...]}: like apply, with baseRevision and batchId filled in",
      page: "smallpen page PRODUCT --intent {screenId, presentationId?, parentId?, index?, nodes:[node, ...]}: one add-presentation-node per node, all siblings under parentId (default: the root); overrides on an INSTANCE node become set-instance-override operations",
      flow: "smallpen flow PRODUCT --intent: same as page, for flowchart nodes",
    },
    result:
      "revision, changedFiles, affectedIds, inverseBatch (apply it to undo), changed (false when the batch changes nothing; then noChange explains it). --inverse-out FILE saves inverseBatch to a file; --compact drops inverseBatch and guidance and adds summary.",
    dryRun: "--dry-run validates and returns the result without writing",
    workedExample: WORKED_EXAMPLE,
  };
}

function initTopic() {
  return {
    summary:
      "smallpen init asks these questions in order. Answer them one per call with --answer ID=JSON and the same --state FILE, or all at once with --answers FILE.",
    questions: initializationQuestions("en"),
    answersFile: INIT_ANSWERS_EXAMPLE,
    run: "smallpen init ./acme --answers answers.json --confirm --json",
    order: INITIALIZATION_QUESTION_IDS,
  };
}

const TOPICS = {
  batch: { build: batchTopic, summary: "Batch contract, Package roles, and a worked example" },
  "component-set": { build: componentSetTopic, summary: "Component Set, Axis roles, variants" },
  context: { build: contextTopic, summary: "Context Axes, profiles, and theme values (alias: theme)" },
  init: { build: initTopic, summary: "Every init question and a complete --answers file" },
  instance: { build: instanceTopic, summary: "INSTANCE nodes and overrides" },
  node: { build: nodeTopic, summary: "Node fields, textStyle, tokenBindings" },
  "node-types": { build: nodeTypesTopic, summary: "What each node type requires" },
  operation: { summary: "One operation: fields, types, example, inverse (smallpen schema operation TYPE)" },
  operations: {
    build: () => ({
      operations: OPERATION_TYPES.map(operationSummary),
      next: "smallpen schema operation TYPE",
    }),
    summary: "Every operation type with its purpose and required fields",
  },
  presentation: { build: presentationTopic, summary: "Presentation fields, size, and resizing" },
  scenario: { build: scenarioTopic, summary: "Scenario fields and viewport" },
  screen: { build: screenTopic, summary: "Screen fields" },
  token: { build: tokenTopic, summary: "Token definition, contextValues, bindings" },
  "token-types": { build: tokenTypesTopic, summary: "The value each Token type accepts" },
};
const TOPIC_ALIASES = { theme: "context" };

export const SCHEMA_TOPICS = Object.freeze(Object.keys(TOPICS));

export function schemaTopic(topicName, argument) {
  if (topicName === undefined) {
    return {
      topics: Object.fromEntries(
        Object.entries(TOPICS).map(([name, { summary }]) => [name, summary]),
      ),
      usage: "smallpen schema TOPIC [--json]; smallpen schema operation TYPE",
    };
  }
  if (Object.hasOwn(OPS, topicName) && argument === undefined) {
    return schemaTopic("operation", topicName);
  }
  const name = TOPIC_ALIASES[topicName] ?? topicName;
  if (name === "operation") {
    if (!Object.hasOwn(OPS, argument ?? "")) {
      const suggestion = suggestField(argument, OPERATION_TYPES);
      throw new SmallPenError(
        "unknown_schema_operation",
        `${argument === undefined ? "smallpen schema operation requires TYPE" : `Unknown operation type: ${argument}`}.` +
          `${suggestion ? ` Did you mean ${suggestion}?` : ""} Types: ${OPERATION_TYPES.join(", ")}`,
        { validTypes: [...OPERATION_TYPES], ...(suggestion ? { suggestion } : {}) },
      );
    }
    return { topic: "operation", type: argument, ...operationDetail(argument) };
  }
  if (!Object.hasOwn(TOPICS, name)) {
    const suggestion = suggestField(name, Object.keys(TOPICS));
    throw new SmallPenError(
      "unknown_schema_topic",
      `Unknown schema topic: ${topicName}.${suggestion ? ` Did you mean ${suggestion}?` : ""} ` +
        `Topics: ${Object.keys(TOPICS).join(", ")}`,
      { validTopics: Object.keys(TOPICS), ...(suggestion ? { suggestion } : {}) },
    );
  }
  if (argument !== undefined) {
    throw new SmallPenError(
      "unexpected_argument",
      `smallpen schema ${name} takes no further argument: ${argument}`,
      { argument },
    );
  }
  return { topic: name, ...TOPICS[name].build() };
}
