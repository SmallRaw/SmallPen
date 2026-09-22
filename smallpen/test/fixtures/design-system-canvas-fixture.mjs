// DSC-002: two-axis (device × mode) four-combination source fixture for the
// design-system canvas. Pure data + expected value table; no server, no UI.
//
// The product package carries every canonical token family (color,
// typography, spacing, border-radius, sizing, stroke-width, shadow) with:
//   - real axis differences (Mobile spacing/typography ≠ Desktop; Dark
//     colors ≠ Light),
//   - an alias chain inside one domain (radius/alias.pill → {base}) and one
//     across domains (stroke/md.border-color → {primary}),
//   - an unset Cell (color/light.disabled has no Dark Cell),
//   - same-name different-owner rows via the read-only canvas foundation.
// Reads are pure: loading and previewing never mutates the source values.
export const CANVAS_PACKAGE_ID = "pkg_canvas";
export const CANVAS_FOUNDATION_ID = "pkg_canvas_shared";

export const CANVAS_THEME_IDS = {
  deviceMobile: "theme_device_mobile",
  deviceDesktop: "theme_device_desktop",
  modeLight: "theme_mode_light",
  modeDark: "theme_mode_dark",
};

export const CANVAS_DOMAIN_IDS = {
  device: "domain_device",
  mode: "domain_mode",
};

// The four Workbench Combinations as stable-id pairs.
export function canvasCombinations() {
  const t = CANVAS_THEME_IDS;
  return [
    [
      { domainId: CANVAS_DOMAIN_IDS.device, themeId: t.deviceDesktop },
      { domainId: CANVAS_DOMAIN_IDS.mode, themeId: t.modeLight },
    ],
    [
      { domainId: CANVAS_DOMAIN_IDS.device, themeId: t.deviceMobile },
      { domainId: CANVAS_DOMAIN_IDS.mode, themeId: t.modeLight },
    ],
    [
      { domainId: CANVAS_DOMAIN_IDS.device, themeId: t.deviceDesktop },
      { domainId: CANVAS_DOMAIN_IDS.mode, themeId: t.modeDark },
    ],
    [
      { domainId: CANVAS_DOMAIN_IDS.device, themeId: t.deviceMobile },
      { domainId: CANVAS_DOMAIN_IDS.mode, themeId: t.modeDark },
    ],
  ];
}

export function combinationKey(combination) {
  const device = combination.find(({ domainId }) => domainId === CANVAS_DOMAIN_IDS.device)
    .themeId.endsWith("mobile")
    ? "mobile"
    : "desktop";
  const mode = combination.find(({ domainId }) => domainId === CANVAS_DOMAIN_IDS.mode)
    .themeId.endsWith("dark")
    ? "dark"
    : "light";
  return `${device}/${mode}`;
}

function token(id, name, type, value, description) {
  return { description, id, name, type, value };
}

function canvasTokenLibrary() {
  const typography = (idPrefix, namePrefix, size, lineHeight, weight) => ({
    description: `${namePrefix} typography Cell for this device variant.`,
    id: idPrefix,
    name: namePrefix,
    type: "typography",
    value: {
      fontFamily: "Inter",
      fontId: "gfont-inter",
      fontSize: size,
      fontWeight: weight,
      lineHeight,
    },
  });
  return {
    id: "tlib_canvas",
    activeSetIds: [
      "tset_canvas_color_light",
      "tset_canvas_spacing_desktop",
      "tset_canvas_typography_desktop",
      "tset_canvas_radius",
      "tset_canvas_radius_alias",
      "tset_canvas_sizing",
      "tset_canvas_stroke",
      "tset_canvas_effect",
    ],
    sets: [
      {
        description: "Light mode color Cells.",
        id: "tset_canvas_color_light",
        name: "color/light",
        tokens: [
          token("tok_canvas_color_light_surface", "surface", "color", "#ffffff", "Observed surface under the Light mode variant."),
          token("tok_canvas_color_light_primary", "primary", "color", "#6750a4", "Primary brand color for Light."),
          token("tok_canvas_color_light_on_primary", "on-primary", "color", "#ffffff", "Foreground on primary for Light."),
          // Unset Cell: no Dark counterpart; Dark must not resolve this to
          // 0/"" — absence stays observable.
          token("tok_canvas_color_light_disabled", "disabled", "color", "#d9d9d9", "Light-only Cell: Dark intentionally has no Cell (unset)."),
        ],
      },
      {
        description: "Dark mode color Cells.",
        id: "tset_canvas_color_dark",
        name: "color/dark",
        tokens: [
          token("tok_canvas_color_dark_surface", "surface", "color", "#1b1b1f", "Observed surface under the Dark mode variant."),
          token("tok_canvas_color_dark_primary", "primary", "color", "#d0bcff", "Primary brand color for Dark."),
          token("tok_canvas_color_dark_on_primary", "on-primary", "color", "#1b1b1f", "Foreground on primary for Dark."),
        ],
      },
      {
        description: "Desktop spacing Cells.",
        id: "tset_canvas_spacing_desktop",
        name: "spacing/desktop",
        tokens: [
          token("tok_canvas_spacing_desktop_small", "space-small", "spacing", 8, "Desktop small spacing Cell."),
          token("tok_canvas_spacing_desktop_medium", "space-medium", "spacing", 16, "Desktop medium spacing Cell."),
        ],
      },
      {
        description: "Mobile spacing Cells.",
        id: "tset_canvas_spacing_mobile",
        name: "spacing/mobile",
        tokens: [
          token("tok_canvas_spacing_mobile_small", "space-small", "spacing", 4, "Mobile small spacing Cell."),
          token("tok_canvas_spacing_mobile_medium", "space-medium", "spacing", 8, "Mobile medium spacing Cell."),
        ],
      },
      {
        description: "Desktop typography Cells.",
        id: "tset_canvas_typography_desktop",
        name: "typography/desktop",
        tokens: [
          typography("tok_canvas_typography_desktop_heading", "heading", 28, 1.2, 600),
          typography("tok_canvas_typography_desktop_body", "body", 16, 1.5, 400),
        ],
      },
      {
        description: "Mobile typography Cells.",
        id: "tset_canvas_typography_mobile",
        name: "typography/mobile",
        tokens: [
          typography("tok_canvas_typography_mobile_heading", "heading", 20, 1.3, 600),
          typography("tok_canvas_typography_mobile_body", "body", 14, 1.4, 400),
        ],
      },
      {
        description: "Axis-independent base radius Cells.",
        id: "tset_canvas_radius",
        name: "radius/md",
        tokens: [token("tok_canvas_radius_base", "base", "border-radius", 8, "Axis-independent base radius Cell; alias chain target.")],
      },
      {
        description: "Alias demo Cells referencing the base radius.",
        id: "tset_canvas_radius_alias",
        name: "radius/alias",
        tokens: [token("tok_canvas_radius_alias_pill", "pill", "border-radius", "{base}", "Alias expression referencing {base}.")],
      },
      {
        description: "Control sizing Cells.",
        id: "tset_canvas_sizing",
        name: "sizing/md",
        tokens: [token("tok_canvas_sizing_control", "control", "sizing", 40, "Control height sizing Cell.")],
      },
      {
        description: "Stroke width and color Cells.",
        id: "tset_canvas_stroke",
        name: "stroke/md",
        tokens: [
          token("tok_canvas_stroke_border_width", "border-width", "stroke-width", 1, "Border stroke width Cell."),
          // Cross-domain alias: follows the observed mode combination.
          token("tok_canvas_stroke_border_color", "border-color", "color", "{primary}", "Cross-domain alias following the observed mode."),
        ],
      },
      {
        description: "Elevation effect Cells.",
        id: "tset_canvas_effect",
        name: "effect/md",
        tokens: [
          token(
            "tok_canvas_effect_elevation",
            "elevation-1",
            "shadow",
            {
              color: "rgba(0, 0, 0, 0.24)",
              offsetX: 0,
              offsetY: 2,
              blur: 4,
              spread: 0,
            },
            "Elevation shadow effect Cell.",
          ),
        ],
      },
    ],
    themes: [
      {
        description: "Mobile device variant.",
        externalId: "canvas-device-mobile",
        group: "device",
        id: CANVAS_THEME_IDS.deviceMobile,
        isSource: true,
        name: "Mobile",
        setIds: [
          "tset_canvas_spacing_mobile",
          "tset_canvas_typography_mobile",
          ...["tset_canvas_radius", "tset_canvas_radius_alias", "tset_canvas_sizing", "tset_canvas_stroke", "tset_canvas_effect"],
        ],
      },
      {
        description: "Desktop device variant.",
        externalId: "canvas-device-desktop",
        group: "device",
        id: CANVAS_THEME_IDS.deviceDesktop,
        isSource: true,
        name: "Desktop",
        setIds: [
          "tset_canvas_spacing_desktop",
          "tset_canvas_typography_desktop",
          ...["tset_canvas_radius", "tset_canvas_radius_alias", "tset_canvas_sizing", "tset_canvas_stroke", "tset_canvas_effect"],
        ],
      },
      {
        description: "Light mode variant.",
        externalId: "canvas-mode-light",
        group: "mode",
        id: CANVAS_THEME_IDS.modeLight,
        isSource: true,
        name: "Light",
        setIds: ["tset_canvas_color_light", ...["tset_canvas_radius", "tset_canvas_radius_alias", "tset_canvas_sizing", "tset_canvas_stroke", "tset_canvas_effect"]],
      },
      {
        description: "Dark mode variant.",
        externalId: "canvas-mode-dark",
        group: "mode",
        id: CANVAS_THEME_IDS.modeDark,
        isSource: true,
        name: "Dark",
        setIds: ["tset_canvas_color_dark", ...["tset_canvas_radius", "tset_canvas_radius_alias", "tset_canvas_sizing", "tset_canvas_stroke", "tset_canvas_effect"]],
      },
    ],
    activeThemeIds: [
      CANVAS_THEME_IDS.deviceDesktop,
      CANVAS_THEME_IDS.modeLight,
    ],
  };
}

// The read-only foundation carries same-name tokens with different values so
// owner disambiguation (qualifiedKey, readOnly) is testable.
function canvasFoundationLibrary() {
  return {
    id: "tlib_canvas_shared",
    activeSetIds: ["tset_canvas_shared_light"],
    sets: [
      {
        description: "Same-name read-only color Cells from the foundation.",
        id: "tset_canvas_shared_light",
        name: "color/light",
        tokens: [
          token(
            "tok_canvas_shared_surface",
            "surface",
            "color",
            "#eef2ff",
            "Read-only foundation surface with the same name as the product.",
          ),
          token(
            "tok_canvas_shared_primary",
            "primary",
            "color",
            "#4338ca",
            "Read-only foundation primary with the same name as the product.",
          ),
        ],
      },
    ],
    themes: [
      {
        description: "Shared foundation color variant.",
        externalId: "canvas-shared-light",
        group: "color",
        id: "theme_canvas_shared_light",
        isSource: true,
        name: "Light",
        setIds: ["tset_canvas_shared_light"],
      },
    ],
    activeThemeIds: ["theme_canvas_shared_light"],
  };
}

// ---------------------------------------------------------------------------
// DSC-003: real component families and two ordinary pages.
// ---------------------------------------------------------------------------

const INTER_TEXT = (fontSize, fontWeight) => ({
  fontFamily: "Inter",
  fontId: "gfont-inter",
  fontVariantId: String(fontWeight),
  fontSize,
  fontWeight,
  lineHeight: 1.2,
});

function textNode(id, name, text, x, y, width, height, fontSize, fontWeight) {
  return {
    children: [],
    fills: [{ color: "#111827", type: "solid" }],
    height,
    id,
    name,
    text,
    textStyle: INTER_TEXT(fontSize, fontWeight),
    type: "TEXT",
    width,
    x,
    y,
  };
}

function canvasComponents() {
  const buttonVariant = (variantId, axisValue, label, fill, textColor) => ({
    id: variantId,
    nodes: {
      [`node_canvas_button_${axisValue}_root`]: {
        children: [`node_canvas_button_${axisValue}_label`],
        componentId: "cmp_canvas_button",
        cornerRadius: 8,
        fills: [{ color: fill, type: "solid" }],
        height: 40,
        id: `node_canvas_button_${axisValue}_root`,
        name: `Button / ${axisValue}`,
        tokenBindings: {
          cornerRadius: {
            assetId: "tok_canvas_radius_base",
            packageId: CANVAS_PACKAGE_ID,
          },
        },
        type: "COMPONENT",
        width: 120,
        x: 0,
        y: 0,
      },
      [`node_canvas_button_${axisValue}_label`]: {
        children: [],
        fills: [{ color: textColor, type: "solid" }],
        height: 20,
        id: `node_canvas_button_${axisValue}_label`,
        name: "Label",
        text: label,
        textStyle: INTER_TEXT(14, 500),
        type: "TEXT",
        width: 88,
        x: 16,
        y: 10,
      },
    },
    rootId: `node_canvas_button_${axisValue}_root`,
    selection: { axis_variant: axisValue },
  });
  const inputVariant = (variantId, axisValue, placeholder, borderColor) => ({
    id: variantId,
    nodes: {
      [`node_canvas_input_${axisValue}_root`]: {
        children: [`node_canvas_input_${axisValue}_label`],
        componentId: "cmp_canvas_input",
        cornerRadius: 8,
        fills: [{ color: "#ffffff", type: "solid" }],
        height: 40,
        id: `node_canvas_input_${axisValue}_root`,
        name: `Input / ${axisValue}`,
        tokenBindings: {
          cornerRadius: {
            assetId: "tok_canvas_radius_base",
            packageId: CANVAS_PACKAGE_ID,
          },
        },
        type: "COMPONENT",
        width: 200,
        x: 0,
        y: 0,
      },
      [`node_canvas_input_${axisValue}_label`]: {
        children: [],
        fills: [{ color: borderColor, type: "solid" }],
        height: 20,
        id: `node_canvas_input_${axisValue}_label`,
        name: "Placeholder",
        text: placeholder,
        textStyle: INTER_TEXT(14, 400),
        type: "TEXT",
        width: 168,
        x: 16,
        y: 10,
      },
    },
    rootId: `node_canvas_input_${axisValue}_root`,
    selection: { axis_state: axisValue },
  });
  const cardVariant = (variantId, axisValue, fill, title) => ({
    id: variantId,
    nodes: {
      [`node_canvas_card_${axisValue}_root`]: {
        children: [`node_canvas_card_${axisValue}_title`],
        componentId: "cmp_canvas_card",
        cornerRadius: 8,
        fills: [{ color: fill, type: "solid" }],
        height: 120,
        id: `node_canvas_card_${axisValue}_root`,
        name: `Card / ${axisValue}`,
        tokenBindings: {
          cornerRadius: {
            assetId: "tok_canvas_radius_base",
            packageId: CANVAS_PACKAGE_ID,
          },
        },
        type: "COMPONENT",
        width: 200,
        x: 0,
        y: 0,
      },
      [`node_canvas_card_${axisValue}_title`]: {
        children: [],
        fills: [{ color: "#111827", type: "solid" }],
        height: 24,
        id: `node_canvas_card_${axisValue}_title`,
        name: "Title",
        text: title,
        textStyle: INTER_TEXT(16, 600),
        type: "TEXT",
        width: 168,
        x: 16,
        y: 16,
      },
    },
    rootId: `node_canvas_card_${axisValue}_root`,
    selection: { axis_state: axisValue },
  });
  return {
    componentSets: [
      {
        axes: [
          {
            domain: ["primary", "secondary", "ghost"],
            id: "axis_variant",
            name: "Variant",
            role: "configuration",
          },
        ],
        id: "cmp_canvas_button",
        name: "Button",
        variants: [
          buttonVariant("var_canvas_button_primary", "primary", "Primary", "#6750a4", "#ffffff"),
          buttonVariant("var_canvas_button_secondary", "secondary", "Secondary", "#e7e0ec", "#1b1b1f"),
          buttonVariant("var_canvas_button_ghost", "ghost", "Ghost", "transparent", "#6750a4"),
        ],
        visibility: "public",
      },
      {
        axes: [
          {
            domain: ["default", "error"],
            id: "axis_state",
            name: "State",
            role: "state",
          },
        ],
        id: "cmp_canvas_input",
        name: "Input",
        variants: [
          inputVariant("var_canvas_input_default", "default", "Placeholder", "#111827"),
          inputVariant("var_canvas_input_error", "error", "Invalid email", "#b3261e"),
        ],
        visibility: "public",
      },
      {
        axes: [
          {
            domain: ["default"],
            id: "axis_state",
            name: "State",
            role: "state",
          },
        ],
        id: "cmp_canvas_badge",
        name: "Badge",
        variants: [
          {
            id: "var_canvas_badge_default",
            nodes: {
              node_canvas_badge_default_root: {
                children: [],
                componentId: "cmp_canvas_badge",
                cornerRadius: 8,
                fills: [{ color: "#d9d9d9", type: "solid" }],
                height: 24,
                id: "node_canvas_badge_default_root",
                name: "Badge / default",
                type: "COMPONENT",
                width: 64,
                x: 0,
                y: 0,
              },
            },
            rootId: "node_canvas_badge_default_root",
            selection: { axis_state: "default" },
          },
        ],
        visibility: "public",
      },
      {
        axes: [
          {
            domain: ["idle", "pressed"],
            id: "axis_state",
            name: "State",
            role: "state",
          },
        ],
        id: "cmp_canvas_card",
        name: "Card",
        variants: [
          cardVariant("var_canvas_card_idle", "idle", "#ffffff", "Card title"),
          cardVariant("var_canvas_card_pressed", "pressed", "#e7e0ec", "Card title"),
        ],
        visibility: "public",
      },
    ],
  };
}

// Returns a nodes-map fragment: the unregistered header frame plus its
// title text node. No component registration and no token bindings
// (SPEC §2.4 unregistered composition).
function unregisteredHeader(pageName, idPrefix, title) {
  return {
    [`${idPrefix}_header`]: {
      children: [`${idPrefix}_title`],
      fills: [{ color: "#f4f4f5", type: "solid" }],
      height: 64,
      id: `${idPrefix}_header`,
      name: `${pageName} Header`,
      type: "FRAME",
      width: 800,
      x: 0,
      y: 0,
    },
    [`${idPrefix}_title`]: textNode(
      `${idPrefix}_title`,
      `${pageName} Title`,
      title,
      24,
      20,
      200,
      24,
      18,
      600,
    ),
  };
}

function canvasScreens() {
  const home = {
    basePresentationId: "pres_canvas_home_desktop",
    counterparts: [],
    id: "scr_canvas_home",
    name: "Home",
    presentations: [
      {
        id: "pres_canvas_home_desktop",
        interactions: [],
        name: "Desktop",
        nodes: {
          node_canvas_home: {
            children: [
              "node_home_header",
              "node_home_content",
            ],
            fills: [{ color: "#ffffff", type: "solid" }],
            height: 600,
            id: "node_canvas_home",
            name: "Home",
            type: "FRAME",
            width: 800,
            x: 0,
            y: 0,
          },
          ...unregisteredHeader("Home", "node_home", "Home"),
          node_home_content: {
            children: [
              "node_home_button_primary",
              "node_home_card",
              "node_home_hidden_note",
              "node_home_hardcoded_caption",
            ],
            fills: [{ color: "#fafafa", type: "solid" }],
            height: 500,
            id: "node_home_content",
            name: "Content",
            type: "FRAME",
            width: 800,
            x: 0,
            y: 64,
          },
          node_home_button_primary: {
            children: [],
            height: 40,
            id: "node_home_button_primary",
            instance: {
              component: {
                assetId: "cmp_canvas_button",
                packageId: CANVAS_PACKAGE_ID,
              },
              variant: { axis_variant: "primary" },
            },
            name: "Button instance / primary",
            type: "INSTANCE",
            width: 120,
            x: 40,
            y: 40,
          },
          node_home_card: {
            children: [],
            height: 120,
            id: "node_home_card",
            instance: {
              component: {
                assetId: "cmp_canvas_card",
                packageId: CANVAS_PACKAGE_ID,
              },
              variant: { axis_state: "idle" },
            },
            name: "Card instance / idle",
            type: "INSTANCE",
            width: 200,
            x: 40,
            y: 120,
          },
          // DSC-007: hidden content must be countable, not invisible to
          // the catalog.
          node_home_hidden_note: {
            children: [],
            fills: [{ color: "#a1a1aa", type: "solid" }],
            height: 24,
            id: "node_home_hidden_note",
            name: "Hidden note",
            text: "Hidden note",
            textStyle: INTER_TEXT(12, 400),
            type: "TEXT",
            visible: false,
            width: 160,
            x: 40,
            y: 240,
          },
          // Hardcoded negative control: looks bindable, intentionally is not.
          node_home_hardcoded_caption: {
            children: [],
            fills: [{ color: "#94a3b8", type: "solid" }],
            height: 24,
            id: "node_home_hardcoded_caption",
            name: "Hardcoded Caption (negative control)",
            text: "Hardcoded caption",
            textStyle: INTER_TEXT(14, 400),
            type: "TEXT",
            width: 240,
            x: 40,
            y: 280,
          },
        },
        platform: "desktop",
        rootId: "node_canvas_home",
        viewport: { height: 600, width: 800 },
      },
    ],
    rootId: "node_canvas_home",
  };
  const settings = {
    basePresentationId: "pres_canvas_settings_desktop",
    counterparts: [],
    id: "scr_canvas_settings",
    name: "Settings",
    presentations: [
      {
        id: "pres_canvas_settings_desktop",
        interactions: [],
        name: "Desktop",
        nodes: {
          node_canvas_settings: {
            children: [
              "node_settings_header",
              "node_settings_content",
            ],
            fills: [{ color: "#ffffff", type: "solid" }],
            height: 600,
            id: "node_canvas_settings",
            name: "Settings",
            type: "FRAME",
            width: 800,
            x: 0,
            y: 0,
          },
          ...unregisteredHeader("Settings", "node_settings", "Settings"),
          node_settings_content: {
            children: [
              "node_settings_button_primary",
              "node_settings_input_default",
              "node_settings_input_error",
            ],
            fills: [{ color: "#fafafa", type: "solid" }],
            height: 500,
            id: "node_settings_content",
            name: "Content",
            type: "FRAME",
            width: 800,
            x: 0,
            y: 64,
          },
          // Cross-page shared instance (same component as Home) with an
          // explicit text override on the label child.
          node_settings_button_primary: {
            children: [],
            height: 40,
            id: "node_settings_button_primary",
            instance: {
              component: {
                assetId: "cmp_canvas_button",
                packageId: CANVAS_PACKAGE_ID,
              },
              overrides: {
                "node_canvas_button_primary_label:text": "Save",
              },
              variant: { axis_variant: "primary" },
            },
            name: "Button instance / primary (override Save)",
            type: "INSTANCE",
            width: 120,
            x: 40,
            y: 40,
          },
          node_settings_input_default: {
            children: [],
            height: 40,
            id: "node_settings_input_default",
            instance: {
              component: {
                assetId: "cmp_canvas_input",
                packageId: CANVAS_PACKAGE_ID,
              },
              variant: { axis_state: "default" },
            },
            name: "Input instance / default",
            type: "INSTANCE",
            width: 200,
            x: 40,
            y: 120,
          },
          node_settings_input_error: {
            children: [],
            height: 40,
            id: "node_settings_input_error",
            instance: {
              component: {
                assetId: "cmp_canvas_input",
                packageId: CANVAS_PACKAGE_ID,
              },
              variant: { axis_state: "error" },
            },
            name: "Input instance / error",
            type: "INSTANCE",
            width: 200,
            x: 40,
            y: 180,
          },
        },
        platform: "desktop",
        rootId: "node_canvas_settings",
        viewport: { height: 600, width: 800 },
      },
    ],
    rootId: "node_canvas_settings",
  };
  return [home, settings];
}

function canvasManifest(libraries) {
  return {
    entries: {
      assets: [],
      components: ["components/canvas-components.json"],
      contexts: [],
      requirements: [],
      scenarios: [],
      screens: ["screens/canvas-page-home.json", "screens/canvas-page-settings.json"],
      tokens: ["tokens/canvas.json"],
    },
    formatVersion: 1,
    name: "Design System Canvas Fixture",
    packageId: CANVAS_PACKAGE_ID,
    role: "foundation",
    defaultScreenId: "scr_canvas_home",
    ...(libraries ? { libraries } : {}),
  };
}

function canvasFoundationManifest() {
  return {
    entries: {
      assets: [],
      components: [],
      contexts: [],
      requirements: [],
      scenarios: [],
      screens: [],
      tokens: ["tokens/canvas-shared.json"],
    },
    formatVersion: 1,
    name: "Canvas Shared Foundation",
    packageId: CANVAS_FOUNDATION_ID,
    role: "foundation",
    defaultScreenId: null,
  };
}

// Values map for the editable product package.
export function buildCanvasPackageValues() {
  const manifest = canvasManifest([
    {
      packageId: CANVAS_FOUNDATION_ID,
      source: { path: "canvas-shared.smallpen", type: "local" },
    },
  ]);
  return new Map([
    ["components/canvas-components.json", canvasComponents()],
    ["manifest.json", manifest],
    ["screens/canvas-page-home.json", canvasScreens()[0]],
    ["screens/canvas-page-settings.json", canvasScreens()[1]],
    ["tokens/canvas.json", canvasTokenLibrary()],
  ]);
}

// Values map for the read-only foundation package.
export function buildCanvasFoundationValues() {
  return new Map([
    ["manifest.json", canvasFoundationManifest()],
    ["tokens/canvas-shared.json", canvasFoundationLibrary()],
  ]);
}

// Expected observation table (raw = authored Cell, resolved = authoritative
// resolver output). Used by the fixture test to lock the four combinations.
export function canvasExpected() {
  const typography = (size, lineHeight) => ({
    fontFamily: "Inter",
    fontId: "gfont-inter",
    fontSize: size,
    fontWeight: 600,
    lineHeight,
  });
  const shadow = {
    color: "rgba(0, 0, 0, 0.24)",
    offsetX: 0,
    offsetY: 2,
    blur: 4,
    spread: 0,
  };
  return {
    // key: tokenPath | {device}/{mode}
    "desktop/light": {
      surface: { raw: "#ffffff", resolved: "#ffffff" },
      primary: { raw: "#6750a4", resolved: "#6750a4" },
      "space-medium": { raw: 16, resolved: 16 },
      "space-small": { raw: 8, resolved: 8 },
      heading: { resolvedFontSize: 28, resolvedLineHeight: 1.2 },
      "border-color": { raw: "{primary}", resolved: "#6750a4" },
      pill: { raw: "{base}", resolved: 8 },
      control: { raw: 40, resolved: 40 },
      "border-width": { raw: 1, resolved: 1 },
      "elevation-1": { raw: shadow, resolved: shadow },
    },
    "mobile/light": {
      surface: { raw: "#ffffff", resolved: "#ffffff" },
      "space-medium": { raw: 8, resolved: 8 },
      "space-small": { raw: 4, resolved: 4 },
      heading: { resolvedFontSize: 20, resolvedLineHeight: 1.3 },
      "border-color": { raw: "{primary}", resolved: "#6750a4" },
      pill: { raw: "{base}", resolved: 8 },
    },
    "desktop/dark": {
      surface: { raw: "#1b1b1f", resolved: "#1b1b1f" },
      primary: { raw: "#d0bcff", resolved: "#d0bcff" },
      "on-primary": { raw: "#1b1b1f", resolved: "#1b1b1f" },
      "space-medium": { raw: 16, resolved: 16 },
      heading: { resolvedFontSize: 28, resolvedLineHeight: 1.2 },
      "border-color": { raw: "{primary}", resolved: "#d0bcff" },
      pill: { raw: "{base}", resolved: 8 },
      // color/light.disabled has no Dark Cell: must stay unset, never 0.
      disabled: { unset: true },
    },
    "mobile/dark": {
      surface: { raw: "#1b1b1f", resolved: "#1b1b1f" },
      primary: { raw: "#d0bcff", resolved: "#d0bcff" },
      "space-medium": { raw: 8, resolved: 8 },
      heading: { resolvedFontSize: 20, resolvedLineHeight: 1.3 },
      "border-color": { raw: "{primary}", resolved: "#d0bcff" },
      pill: { raw: "{base}", resolved: 8 },
      disabled: { unset: true },
    },
  };
}
