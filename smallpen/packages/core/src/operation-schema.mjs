// The documented shape of every canonical Operation. prepareOperationBatch
// checks each Operation against it before applying, and `smallpen schema`
// prints it, so the help and the validator cannot drift apart. Deeper value
// rules (node attributes, Token values, Component Sets) stay with the
// validators that own them.
import { SMALLPEN_FORMAT_CAPABILITIES } from "./capabilities.mjs";
import { fail } from "./errors.mjs";
import { isRecord } from "./internal.mjs";

const OPERATION_TYPES = SMALLPEN_FORMAT_CAPABILITIES.canonicalWrite.operationTypes;

function field(type, description, extra = {}) {
  return { description, required: false, type, ...extra };
}

function required(type, description, extra = {}) {
  return { ...field(type, description, extra), required: true };
}

const SCREEN_ID = required("string", "Screen id (scr_...)", { prefix: "scr_" });
const PRESENTATION_ID = required("string", "Presentation id (pres_...)", {
  prefix: "pres_",
});
const BASE_PRESENTATION_ID = field(
  "string",
  "Presentation id (pres_...); defaults to the Screen's Base Presentation",
  { prefix: "pres_" },
);
const NODE_ID = required("string", "Node id (node_...)", { prefix: "node_" });
const COMPONENT_ID = required("string", "Component id (cmp_...)", {
  prefix: "cmp_",
});
const PARENT_ID = required(
  "string|null",
  "Parent node id, or null for a Presentation root",
);
const INDEX = field("integer|null", "Position among siblings; default: last");
const NODE_CHANGES = required(
  "object",
  "Mutable node fields to set; null clears an optional field. id, type and children are structural and cannot be changed here. See: smallpen schema node",
);
const ASSET_REFERENCE = "{packageId:pkg_..., assetId:...}";

// Each entry: purpose, the Package that normally owns the change, fields,
// the inverse an apply returns, and a minimal example. Examples use the
// workspace `smallpen init` creates for the project name "Acme" (see
// `smallpen schema batch`) and are applied in a test against such a
// workspace, so they stay valid.
export const OPERATION_SCHEMAS = Object.freeze({
  "add-component": {
    purpose:
      "Turn an unbound FRAME of a Presentation into a located Component (legacy form; prefer put-component-set)",
    package: "product",
    fields: {
      component: required(
        "object",
        "{id:cmp_..., name, path, screenId, presentationId, mainNodeId}",
      ),
      entry: field("string", "Entry path; default components/<id>.json"),
      index: INDEX,
    },
    inverse: "delete-component",
    example: {
      component: {
        id: "cmp_settings_panel",
        mainNodeId: "node_settings_root",
        name: "Settings panel",
        path: "",
        presentationId: "pres_settings_mobile",
        screenId: "scr_settings",
      },
      type: "add-component",
    },
  },
  "add-presentation": {
    purpose: "Add another Presentation (for example a tablet layout) to a Screen",
    package: "product",
    fields: {
      screenId: SCREEN_ID,
      presentation: required(
        "object",
        "Presentation; see: smallpen schema presentation",
      ),
      index: INDEX,
      basePresentationId: field(
        "string",
        "Make this Presentation id the Screen's Base Presentation",
      ),
    },
    inverse: "delete-presentation",
    example: {
      presentation: {
        id: "pres_home_tablet",
        interactions: [],
        name: "tablet",
        nodes: {
          node_home_tablet_root: {
            children: [],
            height: 1024,
            id: "node_home_tablet_root",
            name: "Home",
            type: "FRAME",
            width: 768,
            x: 0,
            y: 0,
          },
        },
        platform: "tablet",
        rootId: "node_home_tablet_root",
        viewport: { height: 1024, width: 768 },
      },
      screenId: "scr_home",
      type: "add-presentation",
    },
  },
  "add-presentation-node": {
    purpose:
      "Add one node (and only that node) under a parent; x/y are relative to the parent",
    package: "product",
    fields: {
      screenId: SCREEN_ID,
      presentationId: PRESENTATION_ID,
      parentId: PARENT_ID,
      node: required("object", "Node; see: smallpen schema node"),
      index: INDEX,
    },
    inverse: "delete-presentation-node",
    example: {
      node: {
        children: [],
        height: 32,
        id: "node_title",
        name: "Title",
        text: "Tasks",
        textStyle: { fontSize: 24, fontWeight: 700 },
        type: "TEXT",
        width: 312,
        x: 24,
        y: 48,
      },
      parentId: "node_home_root",
      presentationId: "pres_home_mobile",
      screenId: "scr_home",
      type: "add-presentation-node",
    },
  },
  "clear-instance-override": {
    purpose: "Remove one override from an Instance node",
    package: "product",
    fields: {
      screenId: SCREEN_ID,
      presentationId: BASE_PRESENTATION_ID,
      nodeId: NODE_ID,
      overridePath: required(
        "string",
        "<sourceNodeId>:<field>; see: smallpen schema instance",
      ),
    },
    inverse: "set-instance-override",
    example: {
      nodeId: "node_add_button",
      overridePath: "node_button_label:text",
      screenId: "scr_home",
      type: "clear-instance-override",
    },
  },
  "clear-token-binding": {
    purpose: "Remove one Token binding from a node",
    package: "product",
    fields: {
      screenId: SCREEN_ID,
      presentationId: BASE_PRESENTATION_ID,
      nodeId: NODE_ID,
      field: required("string", "Bound field; see: smallpen schema token"),
    },
    inverse: "restore-canonical-entry",
    example: {
      field: "fill",
      nodeId: "node_home_root",
      screenId: "scr_home",
      type: "clear-token-binding",
    },
  },
  "delete-component-set": {
    purpose: "Delete a Component Set (fails while a Product still uses it)",
    package: "foundation",
    fields: {
      componentId: COMPONENT_ID,
    },
    inverse: "restore-canonical-entry",
    example: { componentId: "cmp_button", type: "delete-component-set" },
  },
  "delete-context-file": {
    purpose: "Delete one Context file",
    package: "foundation",
    fields: { entry: required("string", "Context entry path") },
    inverse: "restore-canonical-entry",
    example: { entry: "contexts/density.json", type: "delete-context-file" },
  },
  "delete-interaction": {
    purpose: "Delete one Interaction from a Presentation",
    package: "product",
    fields: {
      screenId: SCREEN_ID,
      presentationId: PRESENTATION_ID,
      interactionId: required("string", "Interaction id (int_...)", {
        prefix: "int_",
      }),
    },
    inverse: "restore-canonical-entry",
    example: {
      interactionId: "int_open_settings",
      presentationId: "pres_home_mobile",
      screenId: "scr_home",
      type: "delete-interaction",
    },
  },
  "delete-requirement-file": {
    purpose: "Delete one requirements file",
    package: "product",
    fields: {
      entry: field("string", "Requirements entry path; default: the first one"),
    },
    inverse: "restore-canonical-entry",
    example: { entry: "requirements/notes.json", type: "delete-requirement-file" },
  },
  "delete-scenario": {
    purpose: "Delete one Scenario",
    package: "product",
    fields: {
      scenarioId: required("string", "Scenario id (scn_...)", { prefix: "scn_" }),
    },
    inverse: "restore-canonical-entry",
    example: { scenarioId: "scn_home_dark", type: "delete-scenario" },
  },
  "delete-screen": {
    purpose: "Delete a Screen and all its Presentations",
    package: "product",
    fields: { screenId: SCREEN_ID },
    inverse: "restore-canonical-entry + set-default-screen",
    example: { screenId: "scr_settings", type: "delete-screen" },
  },
  "delete-variant": {
    purpose: "Delete one variant of a Component Set",
    package: "foundation",
    fields: {
      componentId: COMPONENT_ID,
      variantId: required("string", "Variant id (var_...)", { prefix: "var_" }),
    },
    inverse: "restore-canonical-entry",
    example: {
      componentId: "cmp_button",
      type: "delete-variant",
      variantId: "var_button_secondary",
    },
  },
  "deprecate-token": {
    purpose: "Mark a DTCG Token deprecated, optionally naming its replacement (Tokens in token sets have no flag)",
    package: "foundation",
    fields: {
      tokenId: required("string", "Token id (tok_...)", { prefix: "tok_" }),
      replacement: field("object", `Replacement Token ${ASSET_REFERENCE}`),
    },
    inverse: "restore-canonical-entry",
    example: { tokenId: "tok_color_surface", type: "deprecate-token" },
  },
  "delete-presentation": {
    purpose: "Delete a Presentation (a Screen keeps at least one)",
    package: "product",
    fields: {
      screenId: SCREEN_ID,
      presentationId: PRESENTATION_ID,
      basePresentationId: field(
        "string",
        "Base Presentation to restore (used by inverse batches)",
      ),
    },
    inverse: "add-presentation",
    example: {
      presentationId: "pres_home_tablet",
      screenId: "scr_home",
      type: "delete-presentation",
    },
  },
  "delete-presentation-node": {
    purpose: "Delete a node and its whole subtree",
    package: "product",
    fields: {
      screenId: SCREEN_ID,
      presentationId: PRESENTATION_ID,
      nodeId: NODE_ID,
    },
    inverse: "add-presentation-node (one per deleted node)",
    example: {
      nodeId: "node_add_button",
      presentationId: "pres_home_mobile",
      screenId: "scr_home",
      type: "delete-presentation-node",
    },
  },
  "delete-component": {
    purpose: "Unbind a located Component and turn its main node back into a FRAME",
    package: "product",
    fields: {
      componentId: required("string", "Located Component id (cmp_...)", {
        prefix: "cmp_",
      }),
    },
    inverse: "add-component",
    example: { componentId: "cmp_settings_panel", type: "delete-component" },
  },
  "move-presentation": {
    purpose: "Reorder the Presentations of a Screen",
    package: "product",
    fields: {
      screenId: SCREEN_ID,
      presentationId: PRESENTATION_ID,
      index: INDEX,
    },
    inverse: "move-presentation",
    example: {
      index: 0,
      presentationId: "pres_home_tablet",
      screenId: "scr_home",
      type: "move-presentation",
    },
  },
  "move-presentation-nodes": {
    purpose: "Move nodes to another parent or position inside one Presentation",
    package: "product",
    fields: {
      screenId: SCREEN_ID,
      presentationId: PRESENTATION_ID,
      nodeIds: required("array", "Node ids to move, in order"),
      parentId: PARENT_ID,
      index: INDEX,
    },
    inverse: "move-presentation-nodes",
    example: {
      index: 0,
      nodeIds: ["node_add_button"],
      parentId: "node_home_root",
      presentationId: "pres_home_mobile",
      screenId: "scr_home",
      type: "move-presentation-nodes",
    },
  },
  "put-component-set": {
    purpose:
      "Create or replace a whole Component Set (axes plus variants); put shared components in the Foundation",
    package: "foundation",
    fields: {
      componentSet: required(
        "object",
        "Component Set; see: smallpen schema component-set",
      ),
      entry: field(
        "string",
        "Components entry to create when none exists; default components/components.json",
      ),
      index: field(
        "integer|null",
        "Position of a new Component Set in its entry; default: last",
      ),
    },
    inverse: "restore-canonical-entry",
    example: {
      componentSet: {
        axes: [
          {
            domain: ["primary", "secondary"],
            id: "axis_style",
            name: "Style",
            role: "configuration",
          },
        ],
        id: "cmp_button",
        name: "Button",
        variants: [
          {
            id: "var_button_primary",
            nodes: {
              node_button_label: {
                children: [],
                height: 20,
                id: "node_button_label",
                name: "Label",
                text: "Button",
                textStyle: { fontSize: 14, fontWeight: 600, textAlign: "center" },
                type: "TEXT",
                width: 120,
                x: 0,
                y: 10,
              },
              node_button_root: {
                children: ["node_button_label"],
                cornerRadius: 8,
                fills: [{ color: "#6750a4", type: "solid" }],
                height: 40,
                id: "node_button_root",
                name: "Button",
                tokenBindings: {
                  cornerRadius: {
                    assetId: "tok_radius_md",
                    packageId: "pkg_acme",
                  },
                  fill: {
                    assetId: "tok_color_brand",
                    packageId: "pkg_acme",
                  },
                },
                type: "COMPONENT",
                width: 120,
                x: 0,
                y: 0,
              },
            },
            rootId: "node_button_root",
            selection: { axis_style: "primary" },
          },
        ],
        visibility: "public",
      },
      type: "put-component-set",
    },
  },
  "put-context-file": {
    purpose: "Create or replace one Context file (finite Axes plus profiles)",
    package: "foundation",
    fields: {
      contextFile: required(
        "object",
        "{axes:[...], profiles:[...]}; see: smallpen schema context",
      ),
      entry: field("string", "Context entry path; default contexts/contexts.json"),
    },
    inverse: "restore-canonical-entry",
    example: {
      contextFile: {
        axes: [
          {
            defaultValue: "regular",
            id: "axis_density",
            kind: "density",
            name: "Density",
            values: [
              { id: "regular", name: "Regular" },
              { id: "compact", name: "Compact" },
            ],
          },
        ],
        profiles: [],
      },
      entry: "contexts/density.json",
      type: "put-context-file",
    },
  },
  "put-interaction": {
    purpose: "Create or replace one Interaction on a Presentation",
    package: "product",
    fields: {
      screenId: SCREEN_ID,
      presentationId: PRESENTATION_ID,
      interaction: required(
        "object",
        "{id:int_..., name, sourceNodeId, trigger:activate|change|submit, action:{type:navigate|set-state|set-visibility,...}, condition?, intentId?}",
      ),
    },
    inverse: "restore-canonical-entry",
    example: {
      interaction: {
        action: {
          screen: { assetId: "scr_settings", packageId: "pkg_acme" },
          type: "navigate",
        },
        id: "int_open_settings",
        name: "Open settings",
        sourceNodeId: "node_add_button",
        trigger: "activate",
      },
      presentationId: "pres_home_mobile",
      screenId: "scr_home",
      type: "put-interaction",
    },
  },
  "put-library": {
    purpose: "Link or replace an external component/Token Library",
    package: "product",
    fields: {
      library: required(
        "object",
        "{packageId:pkg_..., source:{type:local, path} | {type:url, url}}",
      ),
      index: INDEX,
    },
    inverse: "remove-library or put-library",
    example: {
      library: {
        packageId: "pkg_shared_icons",
        source: { path: "../icons/icons.smallpen", type: "local" },
      },
      type: "put-library",
    },
  },
  "put-requirement-file": {
    purpose: "Create or replace one requirements file",
    package: "product",
    fields: {
      requirementFile: required(
        "object",
        "{annotations:[], flows:[{id:flow_..., name, interactionIds}], requirements:[{id:req_..., title, markdown, links}]}",
      ),
      entry: field("string", "Entry path; default: the first requirements file"),
    },
    inverse: "restore-canonical-entry",
    example: {
      entry: "requirements/notes.json",
      requirementFile: {
        annotations: [],
        flows: [],
        requirements: [
          {
            id: "req_dark_mode",
            links: [{ kind: "scenario", scenarioId: "scn_home_default" }],
            markdown: "The home screen supports a dark theme.",
            title: "Dark mode",
          },
        ],
      },
      type: "put-requirement-file",
    },
  },
  "put-scenario": {
    purpose:
      "Create or replace one Scenario (a reproducible state; the same id replaces it, for example to change its viewport)",
    package: "product",
    fields: {
      scenario: required(
        "object",
        "Scenario; see: smallpen schema scenario",
      ),
      entry: field("string", "Entry to create when none exists"),
    },
    inverse: "restore-canonical-entry",
    example: {
      scenario: {
        actions: [],
        context: { axis_platform: "mobile" },
        expectedVisibleNodeIds: ["node_home_root"],
        fixture: {},
        id: "scn_home_dark",
        name: "Dark",
        target: {
          kind: "screen",
          presentationId: "pres_home_mobile",
          screen: { assetId: "scr_home", packageId: "pkg_acme" },
        },
        themes: ["Theme/Dark"],
        viewport: { height: 640, scale: 1, width: 360 },
      },
      type: "put-scenario",
    },
  },
  "put-screen": {
    purpose: "Create or replace a whole Screen",
    package: "product",
    fields: {
      screen: required("object", "Screen; see: smallpen schema screen"),
      entry: field("string", "Entry path; default screens/<id without scr_>.json"),
    },
    inverse: "restore-canonical-entry",
    example: {
      screen: {
        basePresentationId: "pres_settings_mobile",
        counterparts: [],
        id: "scr_settings",
        name: "Settings",
        presentations: [
          {
            id: "pres_settings_mobile",
            interactions: [],
            name: "mobile",
            nodes: {
              node_settings_root: {
                children: [],
                fills: [{ color: "#ffffff", type: "solid" }],
                height: 640,
                id: "node_settings_root",
                name: "Settings",
                type: "FRAME",
                width: 360,
                x: 0,
                y: 0,
              },
            },
            platform: "mobile",
            rootId: "node_settings_root",
            viewport: { height: 640, width: 360 },
          },
        ],
      },
      type: "put-screen",
    },
  },
  "put-set-token": {
    purpose:
      "Create or replace one Token inside a token set (by token id); a theme's set overrides the base set by name",
    package: "foundation",
    fields: {
      setId: required("string", "Token set id (tset_...)", { prefix: "tset_" }),
      token: required(
        "object",
        "{id:tok_..., name:\"color.surface\", type, value, description?}; value matches type (smallpen schema token-types)",
      ),
    },
    inverse: "restore-canonical-entry",
    example: {
      setId: "tset_theme_dark",
      token: {
        id: "tok_color_brand_dark",
        name: "color.brand",
        type: "color",
        value: "#d0bcff",
      },
      type: "put-set-token",
    },
  },
  "put-token-set": {
    purpose:
      "Create or replace one token set (sets, themes, active selection: smallpen schema theme)",
    package: "foundation",
    fields: {
      set: required(
        "object",
        "{id:tset_..., name, description?, tokens:[{id:tok_..., name, type, value, description?}]}",
      ),
      index: field("integer|null", "Position among the sets of a new set; default: last. Later sets override earlier ones"),
      entry: field("string", "Token library entry to create when the Package has none; default tokens/tokens.json"),
    },
    inverse: "restore-canonical-entry",
    example: {
      set: {
        id: "tset_contrast_high",
        name: "contrast/high",
        tokens: [
          {
            id: "tok_color_brand_contrast",
            name: "color.brand",
            type: "color",
            value: "#21005d",
          },
        ],
      },
      type: "put-token-set",
    },
  },
  "put-token-theme": {
    purpose:
      "Create or replace one token theme: a group/name that activates a list of sets (one theme per group is active)",
    package: "foundation",
    fields: {
      theme: required(
        "object",
        "{id:theme_..., group, name, setIds:[tset_...], description?}",
      ),
    },
    inverse: "restore-canonical-entry",
    example: {
      theme: {
        group: "Contrast",
        id: "theme_contrast_high",
        name: "High",
        setIds: ["tset_base", "tset_theme_dark"],
      },
      type: "put-token-theme",
    },
  },
  "delete-token-set": {
    purpose: "Delete one token set and its tokens; themes stop listing it (fails while nodes bind its tokens)",
    package: "foundation",
    fields: {
      setId: required("string", "Token set id (tset_...)", { prefix: "tset_" }),
    },
    inverse: "restore-canonical-entry",
    example: { setId: "tset_theme_light", type: "delete-token-set" },
  },
  "delete-token-theme": {
    purpose: "Delete one token theme (its sets stay)",
    package: "foundation",
    fields: {
      themeId: required("string", "Token theme id (theme_...)", { prefix: "theme_" }),
    },
    inverse: "restore-canonical-entry",
    example: { themeId: "theme_contrast_high", type: "delete-token-theme" },
  },
  "put-token": {
    purpose:
      "Create or replace one DTCG Token in a DTCG token file; themes use put-set-token in token sets instead",
    package: "foundation",
    fields: {
      filePath: required(
        "string",
        "DTCG token file, created when missing, for example tokens/dtcg.json. Not the token library with sets and themes that init makes (tokens/foundation.json or tokens/tokens.json): add Tokens there with put-set-token. smallpen tokens PACKAGE --json shows each Token's filePath",
      ),
      path: required("string", "Dot path inside the file, for example color.surface"),
      tokenId: required("string", "Permanent id (tok_...); equals definition.$extensions.smallpen.id", {
        prefix: "tok_",
      }),
      definition: required(
        "object",
        "{$type, $value, $extensions:{smallpen:{id}}}; see: smallpen schema token. contextValues are deprecated: theme values go in token sets (smallpen schema theme)",
      ),
    },
    inverse: "restore-canonical-entry",
    example: {
      definition: {
        $extensions: { smallpen: { id: "tok_color_surface" } },
        $type: "color",
        $value: "#ffffff",
      },
      filePath: "tokens/dtcg.json",
      path: "color.surface",
      tokenId: "tok_color_surface",
      type: "put-token",
    },
  },
  "put-variant": {
    purpose: "Create or replace one variant of an existing Component Set",
    package: "foundation",
    fields: {
      componentId: COMPONENT_ID,
      variant: required(
        "object",
        "{id:var_..., selection:{axisId:value}, rootId, nodes}; see: smallpen schema component-set",
      ),
    },
    inverse: "restore-canonical-entry",
    example: {
      componentId: "cmp_button",
      type: "put-variant",
      variant: {
        id: "var_button_secondary",
        nodes: {
          node_button_label: {
            children: [],
            height: 20,
            id: "node_button_label",
            name: "Label",
            text: "Button",
            textStyle: { fontSize: 14, textAlign: "center" },
            type: "TEXT",
            width: 120,
            x: 0,
            y: 10,
          },
          node_button_root: {
            children: ["node_button_label"],
            cornerRadius: 8,
            fills: [{ color: "#ffffff", type: "solid" }],
            height: 40,
            id: "node_button_root",
            name: "Button",
            strokes: [{ color: "#6750a4", type: "solid", width: 1 }],
            type: "COMPONENT",
            width: 120,
            x: 0,
            y: 0,
          },
        },
        rootId: "node_button_root",
        selection: { axis_style: "secondary" },
      },
    },
  },
  "remove-token": {
    purpose: "Delete one DTCG Token (fails while nodes still bind it)",
    package: "foundation",
    fields: {
      tokenId: required("string", "Token id (tok_...)", { prefix: "tok_" }),
    },
    inverse: "restore-canonical-entry",
    example: { tokenId: "tok_spacing_md", type: "remove-token" },
  },
  "remove-library": {
    purpose: "Unlink an external Library",
    package: "product",
    fields: {
      packageId: required("string", "Library Package id (pkg_...)", {
        prefix: "pkg_",
      }),
    },
    inverse: "put-library",
    example: { packageId: "pkg_shared_icons", type: "remove-library" },
  },
  "repair-reference": {
    purpose:
      "Retarget or remove one reference; smallpen repair prints the exact referencePath",
    package: "product",
    fields: {
      action: required("string", "What to do with the reference", {
        values: ["retarget-reference", "remove-dependent-usage"],
      }),
      referencePath: required(
        "string",
        "<entry>.<json path>, for example screens/first-design.json.presentations[0].nodes.node_home_root.tokenBindings.fill",
      ),
      replacement: field(
        "object",
        `New target ${ASSET_REFERENCE}; required for retarget-reference`,
      ),
    },
    inverse: "restore-canonical-entry",
    example: {
      action: "retarget-reference",
      referencePath:
        "screens/first-design.json.presentations[0].nodes.node_home_root.tokenBindings.fill",
      replacement: { assetId: "tok_color_brand", packageId: "pkg_acme" },
      type: "repair-reference",
    },
  },
  "reorder-presentation-children": {
    purpose: "Set the full child order of one parent",
    package: "product",
    fields: {
      screenId: SCREEN_ID,
      presentationId: PRESENTATION_ID,
      parentId: PARENT_ID,
      childIds: required("array", "Every current child id exactly once, in the new order"),
    },
    inverse: "reorder-presentation-children",
    example: {
      childIds: ["node_title", "node_add_button"],
      parentId: "node_home_root",
      presentationId: "pres_home_mobile",
      screenId: "scr_home",
      type: "reorder-presentation-children",
    },
  },
  "replace-asset-library": {
    purpose: "Replace the whole local Asset Library (colors, fonts, media, typographies)",
    package: "product",
    fields: {
      library: required(
        "object|null",
        "{id:alib_..., colors, fonts, media, typographies} or null to remove it",
      ),
      entry: field("string", "Entry to create; default assets/assets.json"),
    },
    inverse: "replace-asset-library",
    example: {
      library: {
        colors: [
          {
            id: "color_brand",
            name: "Brand",
            paint: { color: "#6750a4", type: "solid" },
            path: "",
          },
        ],
        fonts: [],
        id: "alib_product",
        media: [],
        typographies: [],
      },
      type: "replace-asset-library",
    },
  },
  "replace-token-library": {
    purpose:
      "Replace the whole Penpot-format Token Library (sets and themes) of a Package; prefer put-token-set / put-set-token / put-token-theme for one change",
    package: "foundation",
    fields: {
      library: required(
        "object|null",
        "{id:tlib_..., sets:[{id:tset_..., name, description, tokens:[{id, name, type, value, description}]}], themes:[{id:theme_..., group, name, setIds, description, externalId, isSource}], activeThemeIds, activeSetIds} or null",
      ),
      entry: field("string", "Entry to create; default tokens/tokens.json"),
      index: INDEX,
    },
    inverse: "replace-token-library",
    example: {
      library: {
        activeSetIds: ["tset_base"],
        activeThemeIds: ["theme_theme_light"],
        id: "tlib_acme",
        sets: [
          {
            description: "",
            id: "tset_base",
            name: "base",
            tokens: [
              { description: "", id: "tok_color_brand", name: "color.brand", type: "color", value: "#6750a4" },
              { description: "", id: "tok_spacing_md", name: "spacing.md", type: "spacing", value: 8 },
              { description: "", id: "tok_radius_md", name: "radius.md", type: "border-radius", value: 8 },
            ],
          },
          { description: "", id: "tset_theme_light", name: "theme/light", tokens: [] },
          {
            description: "",
            id: "tset_theme_dark",
            name: "theme/dark",
            tokens: [
              { description: "", id: "tok_color_brand_dark", name: "color.brand", type: "color", value: "#d0bcff" },
            ],
          },
        ],
        themes: [
          {
            description: "",
            externalId: "",
            group: "Theme",
            id: "theme_theme_light",
            isSource: false,
            name: "Light",
            setIds: ["tset_base", "tset_theme_light"],
          },
          {
            description: "",
            externalId: "",
            group: "Theme",
            id: "theme_theme_dark",
            isSource: false,
            name: "Dark",
            setIds: ["tset_base", "tset_theme_dark"],
          },
        ],
      },
      type: "replace-token-library",
    },
  },
  "restore-canonical-entry": {
    purpose:
      "Write or delete one whole Canonical entry; inverse batches use it, prefer typed operations",
    package: "any",
    fields: {
      kind: required("string", "Entry kind", {
        values: SMALLPEN_FORMAT_CAPABILITIES.canonicalPackage.entryKinds,
      }),
      entry: required("string", "Entry path"),
      value: required("object|null", "Whole entry value, or null to delete it"),
      index: INDEX,
    },
    inverse: "restore-canonical-entry",
    example: {
      entry: "requirements/notes.json",
      kind: "requirements",
      type: "restore-canonical-entry",
      value: { annotations: [], flows: [], requirements: [] },
    },
  },
  "select-instance-variant": {
    purpose: "Switch an Instance node to another variant",
    package: "product",
    fields: {
      screenId: SCREEN_ID,
      presentationId: BASE_PRESENTATION_ID,
      nodeId: NODE_ID,
      selection: required("object", "{axisId: value} for every Axis of the Component Set"),
    },
    inverse: "restore-canonical-entry",
    example: {
      nodeId: "node_add_button",
      screenId: "scr_home",
      selection: { axis_style: "secondary" },
      type: "select-instance-variant",
    },
  },
  "put-canvases": {
    purpose: "Store which pages sit on which canvas and in what order; null returns to canvases by business module",
    package: "product",
    fields: {
      canvases: field("array", "[{id: cnv_..., name, screens: [screen ids in order]}], every canvas in order; omit to return to canvases by business module"),
    },
    inverse: "put-canvases",
    example: { canvases: [{ id: "cnv_settings", name: "Settings", screens: ["scr_settings"] }], type: "put-canvases" },
  },
  "set-default-screen": {
    purpose: "Choose the Screen that reads and renders use by default",
    package: "product",
    fields: {
      screenId: field("string", "Screen id; omit to clear the default", {
        prefix: "scr_",
      }),
    },
    inverse: "set-default-screen",
    example: { screenId: "scr_settings", type: "set-default-screen" },
  },
  "set-foundation-dependency": {
    purpose: "Point a Product at its Foundation Package",
    package: "product",
    fields: {
      dependency: required(
        "object",
        "{packageId:pkg_..., path: relative Package path, activeThemeIds?: the Foundation theme ids this Product uses}",
      ),
    },
    inverse: "set-foundation-dependency",
    example: {
      dependency: {
        activeThemeIds: ["theme_theme_light"],
        packageId: "pkg_acme_foundation",
        path: "acme-foundation.smallpen",
      },
      type: "set-foundation-dependency",
    },
  },
  "set-active-token-themes": {
    purpose:
      "Store the active token themes (the whole selection, one theme per group); a Product may name its Foundation's themes",
    package: "any",
    fields: {
      themePaths: required(
        "array",
        "Unique \"<group>/<name>\" theme paths; reads take --theme GROUP/NAME without writing",
      ),
    },
    inverse: "restore-canonical-entry and/or set-foundation-dependency",
    example: {
      themePaths: ["Theme/Dark"],
      type: "set-active-token-themes",
    },
  },
  "set-instance-override": {
    purpose:
      "Override one field of one node inside an Instance without changing the shared component",
    package: "product",
    fields: {
      screenId: SCREEN_ID,
      presentationId: BASE_PRESENTATION_ID,
      nodeId: required("string", "The INSTANCE node id", { prefix: "node_" }),
      overridePath: required(
        "string",
        "<sourceNodeId>:<field>, or <nestedInstanceId>__<sourceNodeId>:<field>",
      ),
      value: required("any", "New value for the field"),
    },
    inverse: "clear-instance-override or set-instance-override",
    example: {
      nodeId: "node_add_button",
      overridePath: "node_button_label:text",
      screenId: "scr_home",
      type: "set-instance-override",
      value: "Add task",
    },
  },
  "set-token-binding": {
    purpose: "Bind one node field to a Token",
    package: "product",
    fields: {
      screenId: SCREEN_ID,
      presentationId: BASE_PRESENTATION_ID,
      nodeId: NODE_ID,
      field: required(
        "string",
        `Bindable field: ${SMALLPEN_FORMAT_CAPABILITIES.canonicalPackage.tokenBindingFields.join(", ")}`,
      ),
      binding: required("object", `Token ${ASSET_REFERENCE}`),
    },
    inverse: "restore-canonical-entry",
    example: {
      binding: { assetId: "tok_color_surface", packageId: "pkg_acme" },
      field: "fill",
      nodeId: "node_home_root",
      screenId: "scr_home",
      type: "set-token-binding",
    },
  },
  "set-token-value": {
    purpose: "Change the base value of one Token (tokenId preferred, or path)",
    package: "foundation",
    fields: {
      tokenId: field("string", "Token id (tok_...)", { prefix: "tok_" }),
      path: field("string", "Token path, when tokenId is not given"),
      value: required("any", "New value; must match the Token type (smallpen schema token-types)"),
      filePath: field("string", "Accepted for compatibility and ignored"),
    },
    oneOf: [["tokenId", "path"]],
    inverse: "restore-canonical-entry",
    example: { tokenId: "tok_color_brand", type: "set-token-value", value: "#7f67be" },
  },
  "update-component-node": {
    purpose: "Change fields of one node inside one Component variant",
    package: "foundation",
    fields: {
      componentId: COMPONENT_ID,
      variantId: required("string", "Variant id (var_...)", { prefix: "var_" }),
      nodeId: NODE_ID,
      changes: {
        ...NODE_CHANGES,
        description: `${NODE_CHANGES.description}. To change children, read the complete variant and replace it with put-variant.`,
      },
      unset: field("array", "Field names to remove"),
    },
    inverse: "restore-canonical-entry",
    example: {
      changes: { textStyle: { fontSize: 14, fontWeight: 600, textAlign: "center" } },
      componentId: "cmp_button",
      nodeId: "node_button_label",
      type: "update-component-node",
      variantId: "var_button_secondary",
    },
  },
  "update-node": {
    purpose: "update-presentation-node on the Screen's Base Presentation",
    package: "product",
    fields: { screenId: SCREEN_ID, nodeId: NODE_ID, changes: NODE_CHANGES },
    inverse: "update-presentation-node",
    example: {
      changes: { name: "Home screen" },
      nodeId: "node_home_root",
      screenId: "scr_home",
      type: "update-node",
    },
  },
  "update-presentation": {
    purpose:
      "Change Presentation fields: name, viewport, background, pixel grid, or prototypeFlows",
    package: "product",
    fields: {
      screenId: SCREEN_ID,
      presentationId: PRESENTATION_ID,
      changes: required("object", "Presentation fields to set; see: smallpen schema presentation"),
    },
    inverse: "update-presentation",
    example: {
      changes: { name: "Mobile", viewport: { height: 640, width: 360 } },
      presentationId: "pres_home_mobile",
      screenId: "scr_home",
      type: "update-presentation",
    },
  },
  "update-presentation-node": {
    purpose: "Change fields of one node (resize the root to resize the rendered screen)",
    package: "product",
    fields: {
      screenId: SCREEN_ID,
      presentationId: PRESENTATION_ID,
      nodeId: NODE_ID,
      changes: NODE_CHANGES,
    },
    inverse: "update-presentation-node",
    example: {
      changes: { height: 640, width: 360 },
      nodeId: "node_home_root",
      presentationId: "pres_home_mobile",
      screenId: "scr_home",
      type: "update-presentation-node",
    },
  },
  "update-component": {
    purpose: "Rename a located Component or change its path",
    package: "product",
    fields: {
      componentId: required("string", "Located Component id (cmp_...)", {
        prefix: "cmp_",
      }),
      changes: required("object", "{name?, path?}"),
    },
    inverse: "update-component",
    example: {
      changes: { path: "Panels" },
      componentId: "cmp_settings_panel",
      type: "update-component",
    },
  },
});

// Optimal string alignment distance, bounded: small typos only.
function editDistance(left, right) {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  const rows = Array.from({ length: a.length + 1 }, (_, index) => [index]);
  for (let column = 1; column <= b.length; column += 1) rows[0][column] = column;
  for (let row = 1; row <= a.length; row += 1) {
    for (let column = 1; column <= b.length; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      rows[row][column] = Math.min(
        rows[row - 1][column] + 1,
        rows[row][column - 1] + 1,
        rows[row - 1][column - 1] + cost,
      );
      if (
        row > 1 &&
        column > 1 &&
        a[row - 1] === b[column - 2] &&
        a[row - 2] === b[column - 1]
      ) {
        rows[row][column] = Math.min(rows[row][column], rows[row - 2][column - 2] + 1);
      }
    }
  }
  return rows[a.length][b.length];
}

// The closest allowed name for a misspelled or misplaced field, or undefined.
// `corrections` gives a useful target for a misplaced field.
export function suggestField(name, allowed, corrections = {}) {
  if (typeof name !== "string") return undefined;
  if (Object.hasOwn(corrections, name)) return corrections[name];
  let best;
  let bestDistance = Infinity;
  for (const candidate of allowed) {
    const distance = editDistance(name, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  const limit = Math.max(1, Math.min(3, Math.floor(name.length / 3)));
  return bestDistance <= limit ? best : undefined;
}

const OPERATION_FIELD_CORRECTIONS = {
  "put-token": {
    $extensions: "definition.$extensions",
    $type: "definition.$type",
    $value: "definition.$value",
    id: "tokenId",
    value: "definition.$value",
  },
  "set-token-binding": { token: "binding", tokenId: "binding" },
};

function matchesType(value, type) {
  return type.split("|").some((candidate) => {
    switch (candidate) {
      case "any":
        return value !== undefined;
      case "array":
        return Array.isArray(value);
      case "boolean":
        return typeof value === "boolean";
      case "integer":
        return Number.isInteger(value);
      case "null":
        return value === null;
      case "number":
        return typeof value === "number" && Number.isFinite(value);
      case "object":
        return isRecord(value);
      case "string":
        return typeof value === "string" && value.length > 0;
      default:
        return false;
    }
  });
}

// One-line shape of an operation for error messages.
export function operationShape(type) {
  const schema = OPERATION_SCHEMAS[type];
  return Object.entries(schema.fields)
    .map(([name, spec]) => `${name}${spec.required ? "" : "?"}: ${spec.type}`)
    .join(", ");
}

// Checks the operation's type, required fields, field types, and unknown
// fields. Throws a typed error naming the field and the expected shape.
export function checkOperationShape(operation, operationIndex = 0) {
  if (!isRecord(operation)) fail("invalid_operation", "Canonical operation must contain an object", { operationIndex });
  const type = operation.type;
  if (typeof type !== "string" || !Object.hasOwn(OPERATION_SCHEMAS, type)) {
    const suggestion = suggestField(type, OPERATION_TYPES);
    fail(
      "unsupported_operation",
      `Unsupported operation type: ${typeof type === "string" ? type : "(missing type)"}.` +
        `${suggestion ? ` Did you mean ${suggestion}?` : ""} Valid types: ` +
        `${OPERATION_TYPES.join(", ")}. Run: smallpen schema operations`,
      {
        operationIndex,
        ...(suggestion ? { suggestion } : {}),
        type: type ?? null,
        validTypes: [...OPERATION_TYPES],
      },
    );
  }
  const schema = OPERATION_SCHEMAS[type];
  const details = (fieldName, extra = {}) => ({
    expected: operationShape(type),
    received: typeof operation[fieldName] === "string"
      ? operation[fieldName].slice(0, 256)
      : (Array.isArray(operation[fieldName]) ? { type: "array", length: operation[fieldName].length }
        : isRecord(operation[fieldName]) ? { type: "object" } : operation[fieldName] ?? null),
    field: fieldName,
    path: `operations[${operationIndex}].${fieldName}`,
    operationIndex,
    operationType: type,
    schemaCommand: `smallpen schema operation ${type}`,
    ...extra,
  });
  // Unknown fields first: a misnamed field also looks like a missing one,
  // and the suggestion names the right one.
  const allowed = ["type", ...Object.keys(schema.fields)];
  for (const name of Object.keys(operation)) {
    if (allowed.includes(name)) continue;
    const suggestion = suggestField(name, allowed, OPERATION_FIELD_CORRECTIONS[type]);
    fail(
      "unknown_operation_field",
      `${type} does not accept field ${name}.` +
        `${suggestion ? ` Did you mean ${suggestion}?` : ""} Allowed fields: ${allowed.join(", ")}`,
      details(name, { allowedFields: allowed, ...(suggestion ? { suggestion } : {}) }),
    );
  }
  for (const [name, spec] of Object.entries(schema.fields)) {
    const value = operation[name];
    if (value === undefined) {
      if (spec.required) {
        fail(
          "missing_operation_field",
          `${type} requires ${name} (${spec.type}): ${spec.description}. ` +
            `Shape: {type, ${operationShape(type)}}`,
          details(name, { expectedType: spec.type, received: null }),
        );
      }
      continue;
    }
    if (!spec.required && value === null) continue;
    if (!matchesType(value, spec.type)) {
      fail(
        "invalid_operation_field",
        `${type}.${name} must be ${spec.type}: ${spec.description}`,
        details(name, { expectedType: spec.type }),
      );
    }
    if (spec.values && !spec.values.includes(value)) {
      fail(
        "invalid_operation_field",
        `${type}.${name} must be one of: ${spec.values.join(", ")}`,
        details(name, { allowedValues: [...spec.values] }),
      );
    }
  }
  if (type === "put-set-token" && operation.token.value === undefined) fail("invalid_token_value", "put-set-token requires token.value", {
    ...details("token.value"), expected: `a ${typeof operation.token.type === "string" ? operation.token.type : "typed"} Token value`,
    received: null, schemaCommand: "smallpen schema token-types",
  });
  for (const group of schema.oneOf ?? []) {
    if (group.every((name) => operation[name] === undefined || operation[name] === "")) {
      fail(
        "missing_operation_field",
        `${type} requires one of: ${group.join(", ")}`,
        details(group[0], { oneOf: [...group] }),
      );
    }
  }
}
