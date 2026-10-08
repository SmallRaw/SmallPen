import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openPackage } from "@smallpen/local-package";
import { INIT_ANSWERS_EXAMPLE } from "../apps/cli/bin/schema.mjs";
import {
  componentSummary,
  componentSummaryText,
  outlineTree,
} from "../apps/cli/bin/design-output.mjs";

const cli = new URL("../apps/cli/bin/smallpen.mjs", import.meta.url);

async function run(args, expected = 0) {
  const child = spawn(process.execPath, [cli.pathname, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, expected, stdout || stderr);
  return JSON.parse(stdout);
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "smallpen-review-"));
  const answers = join(root, "answers.json");
  await writeFile(answers, JSON.stringify(INIT_ANSWERS_EXAMPLE));
  const initialized = await run([
    "project",
    "init", join(root, "acme"), "--answers", answers, "--layout", "single", "--confirm", "--json",
  ]);
  return { root, path: initialized.packages.package.path };
}

// Applies exact operations through `advanced apply`.
async function apply(path, root, operations) {
  const { revision } = await openPackage(path);
  const name = `batch-${Math.random().toString(16).slice(2)}`;
  const file = join(root, `${name}.json`);
  await writeFile(file, JSON.stringify({ baseRevision: revision, batchId: name, operations }));
  return run(["advanced", "apply", path, "--batch", file, "--json"]);
}

// Adds nodes to the Home page's mobile Presentation, under its root unless a
// parent is named.
function addNodes(path, root, nodes, parentId = "node_home_root") {
  return apply(path, root, nodes.map((node) => ({
    node, parentId, presentationId: "pres_home_mobile", screenId: "scr_home", type: "add-presentation-node",
  })));
}

async function buttonSet(path) {
  const snapshot = await openPackage(path);
  for (const entry of Object.values(snapshot.entries)) {
    const set = entry?.componentSets?.find(({ id }) => id === "cmp_button");
    if (set) return structuredClone(set);
  }
  throw new Error("cmp_button not found");
}

const button = {
  id: "cmp_button",
  name: "Button",
  axes: [
    { id: "axis_style", name: "Style", domain: ["primary", "ghost"] },
    { id: "axis_size", name: "Size", domain: ["sm", "md"] },
  ],
};

const box = (x, y, width, height) => ({ x, y, width, height });

test("an outline names components and their variants, folds copies and marks literal values", () => {
  const instance = (id, text, style) => ({
    id, name: `Action ${text}`, type: "INSTANCE", visible: true, bounds: box(0, 0, 112, 40),
    tokenBindings: {}, variant: { axis_style: style, axis_size: "md" },
    component: { assetId: "cmp_button", packageId: "pkg" },
    children: [{ id: `${id}__label`, name: "Label", type: "TEXT", visible: true, text, bounds: box(0, 0, 112, 40), tokenBindings: {}, children: [] }],
  });
  const tree = {
    root: {
      id: "node_root", name: "Toolbar", type: "FRAME", visible: true, bounds: box(0, 0, 400, 60), tokenBindings: {},
      // Stored as Penpot keeps a flex row: last child first. It reads
      // Save, Cancel, Chip.
      children: [
        { id: "node_chip", name: "Chip", type: "RECTANGLE", visible: true, bounds: box(0, 0, 20, 20), tokenBindings: {}, children: [] },
        instance("node_cancel", "Cancel", "ghost"),
        instance("node_save", "Save", "primary"),
      ],
    },
  };
  const raw = (node) => ({ ...node, children: node.children.map(({ id }) => id) });
  const projection = {
    nodes: {
      node_root: { ...raw(tree.root), layout: "flex", "layout-flex-dir": "row" },
      node_save: { ...raw(tree.root.children[2]), instance: { component: { assetId: "cmp_button", packageId: "pkg" }, variant: { axis_style: "primary", axis_size: "md" } } },
      node_cancel: { ...raw(tree.root.children[1]), instance: { component: { assetId: "cmp_button", packageId: "pkg" }, variant: { axis_style: "ghost", axis_size: "md" } } },
      node_chip: { ...raw(tree.root.children[0]), fills: [{ type: "solid", color: "#ff0000" }] },
    },
  };
  const outline = outlineTree(tree, projection, { components: () => button, ids: true });
  assert.match(outline, /^Toolbar · FRAME 400×60 · row layout \(3\) #node_root$/m);
  assert.match(outline, /Button ×2 \(Size=md\) · 112×40: "Save" \(Style=primary\) #node_save; "Cancel" \(Style=ghost\) #node_cancel/);
  assert.match(outline, /Chip · RECTANGLE 20×20 · literal fill #node_chip/);
  assert.ok(outline.indexOf("Button ×2") < outline.indexOf("Chip"), "a flex row reads in its visual order");
  assert.doesNotMatch(outline, /Label/, "component internals stay folded");
  const named = outlineTree(tree, projection, { components: () => button });
  assert.doesNotMatch(named, /#node_/, "agents read names, not IDs");
  assert.match(named, /Button ×2 \(Size=md\) · 112×40: Action Save "Save" \(Style=primary\); Action Cancel "Cancel" \(Style=ghost\)/);
});

test("a component summary says what each property changes", () => {
  const variant = (style, size) => ({
    id: `var_${style}_${size}`,
    rootId: "node_root",
    selection: { axis_style: style, axis_size: size },
    nodes: {
      node_root: {
        id: "node_root", name: "Button", type: "COMPONENT", x: 0, y: 0, children: ["node_label"],
        width: size === "sm" ? 96 : 112, height: 40,
        fills: [{ type: "solid", color: style === "primary" ? "#4f46e5" : "#ffffff" }],
      },
      node_label: { id: "node_label", name: "Label", type: "TEXT", text: "Save", x: 0, y: 0, width: 80, height: 20, children: [] },
    },
  });
  const summary = componentSummary({
    ...button,
    variants: [variant("primary", "sm"), variant("ghost", "sm"), variant("primary", "md"), variant("ghost", "md")],
  });
  const [style, size] = summary.axes;
  assert.deepEqual(style.values, ["primary", "ghost"]);
  assert.deepEqual(style.changes, ["Button: fill"]);
  assert.deepEqual(size.changes, ["Button: size"]);
  assert.deepEqual(summary.mainVariant.selection, ["Style=primary", "Size=sm"]);
  const text = componentSummaryText(summary);
  assert.match(text, /^Button · component · 4 variants · main: Style=primary, Size=sm$/m);
  assert.match(text, /^ {2}Style: primary \/ ghost → changes Button: fill$/m);
});

test("validate skips sub-pixel text rounding, reads the paint under a text and says where each issue is", async () => {
  const { root, path } = await workspace();
  await addNodes(path, root, [{
    id: "node_panel", type: "FRAME", name: "Panel", x: 0, y: 0, width: 400, height: 200,
    fills: [{ type: "solid", color: "#ffffff" }], children: [],
  }]);
  await addNodes(path, root, [
      { id: "node_badge", type: "RECTANGLE", name: "Badge", x: 10, y: 10, width: 60, height: 30, children: [], fills: [{ type: "solid", color: "#111111" }] },
      { id: "node_badge_text", type: "TEXT", name: "Badge text", x: 10, y: 10, width: 60, height: 30, children: [], text: "OK", fills: [{ type: "solid", color: "#ffffff" }], textStyle: { fontSize: 14 } },
      { id: "node_tight", type: "TEXT", name: "Tight", x: 10, y: 60, width: 200, height: 16, children: [], text: "Fits", fills: [{ type: "solid", color: "#111111" }], textStyle: { fontSize: 12, lineHeight: 1.4 } },
      { id: "node_long", type: "TEXT", name: "Long", x: 10, y: 100, width: 40, height: 16, children: [], text: "A label far too long for this box", fills: [{ type: "solid", color: "#111111" }], textStyle: { fontSize: 12 } },
  ], "node_panel");
  const report = await run(["validate", path, "--page", "Home", "--json"]);
  const issues = report.issues;
  assert.ok(issues.every(({ nodeId }) => nodeId === undefined), "issues name elements, not IDs");
  assert.ok(!issues.some(({ where }) => where === "Panel › Badge text"),
    "white text on its dark badge is checked against the badge, not the panel");
  assert.ok(!issues.some(({ code, where }) => code === "text_overflow" && where === "Panel › Tight"),
    "a 0.8px line-height rounding is no overflow");
  const long = issues.find(({ code, where }) => code === "text_overflow" && where === "Panel › Long");
  assert.ok(long, "a clipped label is reported");
  assert.equal(long.where, "Panel › Long");
  assert.equal(long.text, "A label far too long for this box");
});

test("one problem inside a component is reported once with its copies counted", async () => {
  const { root, path } = await workspace();
  // Replies leave out ids; an apply batch reads the stored packageId.
  const { packageId } = (await openPackage(path)).manifest;
  const variant = (await buttonSet(path)).variants.find(({ id }) => id === "var_button_default");
  variant.nodes[variant.rootId] = {
    ...variant.nodes[variant.rootId], width: 120, height: 40, children: ["node_faint"],
    fills: [{ type: "solid", color: "#ffffff" }], tokenBindings: {},
  };
  variant.nodes.node_faint = {
    id: "node_faint", type: "TEXT", name: "Faint label", children: [], text: "Go",
    x: 8, y: 8, width: 100, height: 24, fills: [{ type: "solid", color: "#bbbbbb" }], textStyle: { fontSize: 14 },
  };
  await apply(path, root, [{ type: "put-variant", componentId: "cmp_button", variant }]);
  const copy = (id, x) => ({
    id, type: "INSTANCE", name: `Copy ${id}`, children: [], width: 120, height: 40, x, y: 10,
    instance: { component: { assetId: "cmp_button", packageId }, variant: {}, overrides: {} },
  });
  await addNodes(path, root, [copy("node_a", 10), copy("node_b", 150), copy("node_c", 290)]);
  const report = await run(["validate", path, "--page", "Home", "--json"]);
  const faint = report.issues.filter(({ code }) => code === "low_text_contrast");
  assert.equal(faint.length, 1);
  assert.equal(faint[0].occurrences, 3);
  assert.equal(faint[0].alsoAt.length, 2);
  assert.match(faint[0].message, /fix it in the component/);
});

test("a write reminder names only the Token equal to a literal value", async () => {
  const { root, path } = await workspace();
  const tokens = await run(["token", "list", path, "--json"]);
  const brand = tokens.items.find(({ token }) => token.type === "color");
  assert.ok(brand, "the initialized package has a color Token");
  const result = await addNodes(path, root, [{
    id: "node_literal", type: "RECTANGLE", name: "Literal", children: [], x: 0, y: 0, width: 20, height: 20,
    fills: [{ type: "solid", color: brand.value }],
  }]);
  const reminder = result.reuseReminders.find(({ code }) => code === "design_token_not_used");
  assert.ok(reminder);
  assert.ok(reminder.suggestions.length >= 1);
  assert.ok(reminder.suggestions.every((suggestion) =>
    suggestion.value === brand.value && Object.keys(suggestion).sort().join() === "path,reference,value"));
});

test("a mobile Presentation hints at its theme option and at another platform's variant", async () => {
  const { root, path } = await workspace();
  // Replies leave out ids; an apply batch reads the stored packageId.
  const { packageId } = (await openPackage(path)).manifest;
  await run(["token", "theme", "add", path, "--theme", "Viewport/Desktop", "--theme", "Viewport/Mobile", "--json"]);
  const set = await buttonSet(path);
  const [base] = set.variants;
  set.axes = [{ id: "axis_platform", name: "Platform", domain: ["desktop", "mobile"], role: "configuration" }];
  set.variants = ["desktop", "mobile"].map((platform) => ({
    ...structuredClone(base), id: `var_button_${platform}`, selection: { axis_platform: platform },
  }));
  await apply(path, root, [{ type: "put-component-set", componentSet: set }]);
  await addNodes(path, root, [{
    id: "node_cta", type: "INSTANCE", name: "Call to action", children: [], width: 120, height: 40, x: 10, y: 10,
    instance: { component: { assetId: "cmp_button", packageId }, variant: { axis_platform: "desktop" }, overrides: {} },
  }]);
  // scr_home's only Presentation is the mobile one.
  const view = await run(["view", path, "--page", "Home", "--json"]);
  const codes = view.hints.map(({ code }) => code);
  assert.ok(codes.includes("platform_theme_available"));
  assert.equal(view.hints.find(({ code }) => code === "platform_theme_available").theme, "Viewport/Mobile");
  const mismatch = view.hints.find(({ code }) => code === "platform_variant_mismatch");
  assert.equal(mismatch.nodeId, undefined);
  assert.match(mismatch.where, /(^|› )Call to action$/);
  assert.equal(view.revision, (await openPackage(path)).revision, "view says which revision it read");
  assert.match(mismatch.message, /Platform=desktop.*Platform=mobile/);
  const report = await run(["validate", path, "--page", "Home", "--theme", "Viewport/Mobile", "--json"]);
  assert.ok(!(report.hints ?? []).some(({ code }) => code === "platform_theme_available"),
    "no theme hint once the option is selected");
  assert.ok(report.hints.some(({ code }) => code === "platform_variant_mismatch"));
  assert.ok(!report.issues.some(({ code }) => code.startsWith("platform_")), "hints are not issues");
});
