import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openPackage } from "@smallpen/local-package";
import { pageHtml, writePackage } from "./helpers/named.mjs";
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

// A package written as files: Home has only a mobile version.
async function workspace(files) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-review-"));
  const path = join(root, "acme.smallpen");
  await writePackage(path, files, { name: "Acme", packageId: "pkg_acme" });
  const checked = await run(["check", path, "--json"]);
  assert.equal(checked.ok, true, JSON.stringify(checked.issues));
  return { root, path };
}

const mobileHome = (body) => pageHtml(`<body class="w-[390px] h-[844px] bg-[#ffffff]">
${body}
</body>`, { title: "Home" });

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
  assert.match(outline, /Button ×2 \(Size: md\) · 112×40: "Save" \(Style: primary\) #node_save; "Cancel" \(Style: ghost\) #node_cancel/);
  assert.match(outline, /Chip · RECTANGLE 20×20 · literal fill #node_chip/);
  assert.ok(outline.indexOf("Button ×2") < outline.indexOf("Chip"), "a flex row reads in its visual order");
  assert.doesNotMatch(outline, /Label/, "component internals stay folded");
  const named = outlineTree(tree, projection, { components: () => button });
  assert.doesNotMatch(named, /#node_/, "agents read names, not IDs");
  assert.match(named, /Button ×2 \(Size: md\) · 112×40: Action Save "Save" \(Style: primary\); Action Cancel "Cancel" \(Style: ghost\)/);
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
  assert.deepEqual(summary.mainVariant.selection, ["Style: primary", "Size: sm"]);
  const text = componentSummaryText(summary);
  assert.match(text, /^Button · component · 4 variants · main: Style: primary; Size: sm$/m);
  assert.match(text, /^ {2}Style: primary \/ ghost → changes Button: fill$/m);
});

test("validate skips sub-pixel text rounding, reads the paint under a text and says where each issue is", async () => {
  const { path } = await workspace({
    "pages/Home.mobile.html": mobileHome(`  <div data-name="Panel" class="left-[0px] top-[0px] w-[400px] h-[200px] bg-[#ffffff]">
    <div data-shape="rectangle" data-name="Badge" class="left-[10px] top-[10px] w-[60px] h-[30px] bg-[#111111]"></div>
    <p data-name="Badge text" class="left-[10px] top-[10px] w-[60px] h-[30px] text-[#ffffff] text-[14px]">OK</p>
    <p data-name="Tight" class="left-[10px] top-[60px] w-[200px] h-[16px] text-[#111111] text-[12px] leading-[1.4]">Fits</p>
    <p data-name="Long" class="left-[10px] top-[100px] w-[40px] h-[16px] text-[#111111] text-[12px]">A label far too long for this box</p>
  </div>`),
  });
  const report = (await run(["check", path, "--render", "--page", "Home", "--json"])).render;
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
  const { path } = await workspace({
    "components/Button.html": `<sp-component name="Button">
  <div class="w-[120px] h-[40px] bg-[#ffffff]">
    <p data-name="Faint label" class="left-[8px] top-[8px] w-[100px] h-[24px] text-[#bbbbbb] text-[14px]">Go</p>
  </div>
</sp-component>
`,
    "pages/Home.mobile.html": mobileHome(["a", "b", "c"].map((name, index) =>
      `  <sp-use component="Button" data-name="Copy ${name}" class="left-[${10 + index * 140}px] top-[10px]"></sp-use>`).join("\n")),
  });
  const report = (await run(["check", path, "--render", "--page", "Home", "--json"])).render;
  const faint = report.issues.filter(({ code }) => code === "low_text_contrast");
  assert.equal(faint.length, 1);
  assert.equal(faint[0].occurrences, 3);
  assert.equal(faint[0].alsoAt.length, 2);
  assert.match(faint[0].message, /fix it in the component/);
});

test("a mobile Presentation hints at its theme option and at another platform's variant", async () => {
  const { path } = await workspace({
    "tokens.css": ':root {\n}\n\n:root[data-viewport="desktop"] {\n}\n\n:root[data-viewport="mobile"] {\n}\n',
    "components/Button.html": `<sp-component name="Button" props="Platform: desktop | mobile">
  <div class="w-[120px] h-[40px] bg-[#4f46e5]"></div>
</sp-component>
`,
    "pages/Home.mobile.html": mobileHome('  <sp-use component="Button" props="Platform: desktop" data-name="Call to action" class="left-[10px] top-[10px]"></sp-use>'),
  });
  // scr_home's only Presentation is the mobile one.
  const view = await run(["view", path, "--page", "Home", "--json"]);
  const codes = view.hints.map(({ code }) => code);
  assert.ok(codes.includes("platform_theme_available"));
  assert.equal(view.hints.find(({ code }) => code === "platform_theme_available").theme, "viewport/mobile");
  const mismatch = view.hints.find(({ code }) => code === "platform_variant_mismatch");
  assert.equal(mismatch.nodeId, undefined);
  assert.match(mismatch.where, /(^|› )Call to action$/);
  assert.equal(view.revision, (await openPackage(path)).revision, "view says which revision it read");
  assert.match(mismatch.message, /Platform: desktop.*Platform: mobile/);
  const report = (await run(["check", path, "--render", "--page", "Home", "--theme", "viewport/mobile", "--json"])).render;
  assert.ok(!(report.hints ?? []).some(({ code }) => code === "platform_theme_available"),
    "no theme hint once the option is selected");
  assert.ok(report.hints.some(({ code }) => code === "platform_variant_mismatch"));
  assert.ok(!report.issues.some(({ code }) => code.startsWith("platform_")), "hints are not issues");
});
