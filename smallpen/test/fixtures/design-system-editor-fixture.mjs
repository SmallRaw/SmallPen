// DSE-002 fixture: reuses the DSC-003 canvas fixture (two pages, 3-variant
// Button, Input, unregistered headers, instance override, two-axis four
// combinations, alias chain, read-only foundation) and extends the Home page
// with a nested layout container (frame → flex frame → text) and a PATH node
// so the ordinary-page parity baseline covers nesting and vector content.
// Pure data, no server, no UI.
import {
  buildCanvasFoundationValues,
  buildCanvasPackageValues,
} from "./design-system-canvas-fixture.mjs";

const INTER_TEXT = (fontSize, fontWeight) => ({
  fontFamily: "Inter",
  fontId: "gfont-inter",
  fontVariantId: String(fontWeight),
  fontSize,
  fontWeight,
  lineHeight: 1.2,
});

export const EDITOR_NESTED_NODES = {
  node_editor_nested: {
    children: ["node_editor_nested_row", "node_editor_nested_path"],
    fills: [{ color: "#fafafa", type: "solid" }],
    height: 160,
    id: "node_editor_nested",
    name: "Nested Container",
    type: "FRAME",
    width: 320,
    x: 40,
    y: 340,
  },
  // Flex row container so the baseline exercises layout attributes.
  node_editor_nested_row: {
    children: ["node_editor_nested_text"],
    fills: [{ color: "#eef2ff", type: "solid" }],
    height: 48,
    id: "node_editor_nested_row",
    layout: "flex",
    "layout-flex-dir": "row",
    "layout-gap": { rowGap: 8, columnGap: 8, type: "fixed" },
    "layout-padding": { p1: 8, p2: 8, p3: 8, p4: 8 },
    "layout-padding-type": "fixed",
    "layout-gap-type": "fixed",
    name: "Nested Row",
    type: "FRAME",
    width: 280,
    x: 20,
    y: 20,
  },
  node_editor_nested_text: {
    children: [],
    fills: [{ color: "#111827", type: "solid" }],
    height: 24,
    id: "node_editor_nested_text",
    name: "Nested Text",
    text: "Nested text",
    textStyle: INTER_TEXT(14, 400),
    type: "TEXT",
    width: 96,
    x: 0,
    y: 0,
  },
  // Vector content: closed triangle path, SVG pathData string.
  node_editor_nested_path: {
    children: [],
    fills: [{ color: "#6750a4", type: "solid" }],
    height: 64,
    id: "node_editor_nested_path",
    name: "Nested Triangle",
    pathData: "M 0 64 L 32 0 L 64 64 Z",
    type: "PATH",
    width: 64,
    x: 20,
    y: 80,
  },
};

// Same values shape as buildCanvasPackageValues(): Map entry path → JSON.
export function buildEditorPackageValues() {
  const values = buildCanvasPackageValues();
  const home = values.get("screens/canvas-page-home.json");
  const presentation = home.presentations[0];
  presentation.nodes.node_home_content.children.push("node_editor_nested");
  for (const [id, node] of Object.entries(EDITOR_NESTED_NODES)) {
    presentation.nodes[id] = structuredClone(node);
  }
  return values;
}

export function buildEditorFoundationValues() {
  return buildCanvasFoundationValues();
}
