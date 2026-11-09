import assert from "node:assert/strict";
import test from "node:test";

import {
  checkPackageFiles,
  decodePackageFiles,
  encodePackage,
  loadPackageFromValues,
  parseHtml,
  stableRuntimeUuid,
} from "@smallpen/core";

const INDEX = `<!doctype html>
<html data-mode="light">
<head>
  <meta charset="utf-8">
  <title>Flowboard</title>
  <meta name="smallpen:package-id" content="pkg_sample">
</head>
<body></body>
</html>
`;

const TOKENS = `:root {
  --color-on-brand: #ffffff;
  --color-primary: var(--color-brand);
  --spacing-4: 16px;
  --radius-md: 8px;
  --type-label: 600 14px/1.4 "Source Sans Pro";
  --type-title: 700 24px/1.3 "Source Sans Pro";
  --type-title--tracking: 0.5px;
  --shadow-card: 0 2px 8px 0 #00000033;
  --string-save: "保存";
  --flag-badge: true;
}

:root[data-mode="light"] {
  --color-brand: #2563eb;
  --color-canvas: #f8fafc;
}

:root[data-mode="dark"] {
  --color-brand: #93c5fd;
  --color-canvas: #0f172a;
}
`;

const BUTTON = `<sp-component name="Button" props="Style: primary | secondary; Size: sm | md">
  <div class="flex flex-row items-center py-[8px] px-4 bg-brand rounded-md">
    <p data-name="Label" class="text-on-brand type-label">Button</p>
  </div>
  <sp-variant when="Style: secondary" class="bg-[#ffffff] border border-brand">
    <p data-name="Label" class="text-brand"></p>
  </sp-variant>
  <sp-variant when="Size: md" class="py-[12px] px-[24px]"></sp-variant>
</sp-component>
`;

const page = (body, title = "Board") => `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <link rel="stylesheet" href="../../tokens.css">
</head>
${body}
</html>
`;

const BOARD = page(`<body data-flow="main" class="flex flex-row bg-canvas">
  <div data-name="Sidebar" class="flex flex-col p-4 w-[240px] h-full">
    <p data-name="Logo" class="type-title">Flowboard</p>
  </div>
  <div data-name="Content" class="flex flex-col gap-[16px] p-[24px] w-full h-full">
    <div data-name="Top bar" class="flex flex-row items-center w-full">
      <p data-name="Title" class="w-full type-title">Sprint 24</p>
      <sp-use component="Button" data-name="New task" data-click="Tasks/Detail">
        <p data-name="Label">New task</p>
      </sp-use>
    </div>
    <div data-name="Card" class="flex flex-col p-[16px] w-full bg-[#ffffff] rounded-md shadow-card">
      <p data-name="Card title">Design review</p>
      <p data-name="Save" data-text="save" data-visible="badge"></p>
    </div>
  </div>
</body>`);

const DETAIL = page(`<body class="flex flex-col p-[24px] bg-canvas">
  <p data-name="Heading" class="type-title">Task detail</p>
  <sp-use component="Button" props="Style: secondary; Size: md" data-name="Back" data-click="back">
    <p data-name="Label">Back</p>
  </sp-use>
</body>`, "Detail");

function sample(overrides = {}) {
  return new Map(
    Object.entries({
      "index.html": INDEX,
      "tokens.css": TOKENS,
      "components/Button.html": BUTTON,
      "pages/Tasks/Board.html": BOARD,
      "pages/Tasks/Detail.html": DETAIL,
      ...overrides,
    }).filter(([, value]) => value !== undefined),
  );
}

function nodeNamed(presentation, name) {
  return Object.values(presentation.nodes).find((node) => node.name === name);
}

test("the HTML reader reports structure problems with offsets", () => {
  const { issues } = parseHtml('<div class="a">\n  <div/>\n  <p>x &bogus; y</p>\n');
  const codes = issues.map((issue) => issue.code);
  assert.ok(codes.includes("html_parse_error"));
  assert.ok(codes.includes("unknown_entity"));
  const selfClosing = issues.find((issue) => issue.message.includes("<div/>"));
  assert.equal(selfClosing.offset, 18);
});

test("a sample package decodes into a valid package model", async () => {
  const { values, issues, summary } = await decodePackageFiles(sample());
  assert.deepEqual(issues.filter((issue) => issue.severity === "error"), []);
  // The pages' 24px margin is written raw on each page: one decision without a name.
  assert.ok(issues.every((issue) => issue.code === "repeated_raw_value" && issue.severity === "warning"), JSON.stringify(issues));
  assert.deepEqual(summary, { pages: 2, pageVersions: 2, components: 1, variants: 4, tokens: 11 });
  const snapshot = await loadPackageFromValues("sample", values);
  const board = snapshot.entries["pages/Tasks/Board"];
  const presentation = board.presentations[0];
  const root = presentation.nodes[presentation.rootId];
  assert.equal(root.layout, "flex");
  assert.equal(root["layout-flex-dir"], "row");
  assert.equal(root.width, 1440);
  // Flex rows store the last displayed child first (Penpot layer order).
  assert.deepEqual(root.children.map((id) => presentation.nodes[id].name), ["Content", "Sidebar"]);
  assert.equal(nodeNamed(presentation, "Title")["layout-item-h-sizing"], "fill");
  assert.equal(nodeNamed(presentation, "Title").growType, "auto-height");
  // A paragraph in a column without a width stretches across it, as in CSS.
  assert.equal(nodeNamed(presentation, "Logo").growType, "auto-height");
  assert.equal(nodeNamed(presentation, "Logo")["layout-item-h-sizing"], "fill");
  assert.equal(nodeNamed(presentation, "Save").text, "保存");
  assert.ok(nodeNamed(presentation, "Save").tokenBindings.visible);
  assert.equal(presentation.prototypeFlows[0].name, "main");
  const copy = nodeNamed(presentation, "New task");
  assert.equal(copy.type, "INSTANCE");
  assert.deepEqual(Object.values(copy.instance.overrides), ["New task"]);
  const detail = snapshot.entries["pages/Tasks/Detail"];
  const detailPresentation = detail.presentations[0];
  const expected = await stableRuntimeUuid(
    "pkg_sample",
    "node",
    `${detail.id}\0${detailPresentation.id}\0${detailPresentation.rootId}`,
  );
  assert.equal(copy.interactions[0].destination, expected);
  assert.equal(nodeNamed(detailPresentation, "Back").interactions[0]["action-type"], "prev-screen");
});

test("variant rules apply on top of the shared element", async () => {
  const { values } = await decodePackageFiles(sample());
  const set = values.get("components/Button.html").componentSets[0];
  assert.equal(set.variants.length, 4);
  const pick = (style, size) => set.variants.find((variant) => {
    const values = Object.values(variant.selection);
    return values.includes(style) && values.includes(size);
  });
  const rootOf = (variant) => variant.nodes[variant.rootId];
  assert.equal(rootOf(pick("primary", "sm")).fills[0].color, "#2563eb");
  assert.equal(rootOf(pick("secondary", "sm")).fills[0].color, "#ffffff");
  assert.equal(rootOf(pick("secondary", "md")).strokes[0].width, 1);
  assert.deepEqual(rootOf(pick("primary", "md"))["layout-padding"], { p1: 12, p2: 24, p3: 12, p4: 24 });
  assert.equal(rootOf(pick("primary", "md")).tokenBindings.paddingLeft, undefined);
  assert.ok(rootOf(pick("primary", "sm")).tokenBindings.paddingLeft);
  // Parts keep one id across variants, so copy overrides follow them.
  const labelIds = new Set(set.variants.map((variant) => rootOf(variant).children[0]));
  assert.equal(labelIds.size, 1);
});

test("check reports located, actionable issues", async () => {
  const broken = page(`<body class="bg-canvas">
  <div data-name="Box" class="flex-column w-full bg-brnd" style="color:red">
    loose text
  </div>
  <sp-use component="Buton" data-name="X"></sp-use>
  <sp-use component="Button" props="Style: tertiary" data-name="Y">
    <p data-name="Caption">Hi</p>
  </sp-use>
  <div data-name="Box" class="w-[10px] h-[10px]" data-click="Tasks/Nowhere"></div>
  <script>alert(1)</script>
</body>`);
  const result = await checkPackageFiles(sample({ "pages/Tasks/Board.html": broken }));
  assert.equal(result.ok, false);
  const byCode = (code) => result.issues.filter((issue) => issue.code === code);
  const unknownClass = byCode("unknown_class")[0];
  assert.match(unknownClass.message, /flex-column .*flex-col/);
  assert.equal(unknownClass.file, "pages/Tasks/Board.html");
  assert.equal(unknownClass.line, 9);
  assert.ok(byCode("unknown_token").some((issue) => issue.message.includes("--color-brnd")));
  assert.ok(byCode("layout_not_in_app").some((issue) => issue.message.includes("w-full")));
  assert.equal(byCode("inline_style_forbidden").length, 1);
  assert.equal(byCode("text_outside_p").length, 1);
  assert.match(byCode("unknown_component")[0].message, /did you mean Button/);
  assert.equal(byCode("invalid_prop_value").length, 1);
  assert.match(byCode("unknown_part")[0].message, /parts: Label/);
  assert.equal(byCode("duplicate_name").length, 1);
  assert.equal(byCode("unknown_link_target").length, 1);
  assert.equal(byCode("unknown_element").length, 1);
});

test("a text named by its text: editing it is reported once per rule, with the fix", async () => {
  const chip = (label) => `<sp-component name="Chip" props="Tone: plain | bold | loud; Size: sm | md">
  <div class="flex flex-row w-fit h-fit">
    <p class="type-label">${label}</p>
  </div>
  <sp-variant when="Tone: bold">
    <p data-name="Continue" class="text-brand"></p>
  </sp-variant>
  <sp-variant when="Tone: loud">
    <p data-name="Continue" class="text-on-brand"></p>
  </sp-variant>
</sp-component>
`;
  assert.equal((await checkPackageFiles(sample({ "components/Chip.html": chip("Continue") }))).ok, true);
  const renamed = await checkPackageFiles(sample({ "components/Chip.html": chip("Next") }));
  const parts = renamed.issues.filter((issue) => issue.code === "unknown_part");
  // Each rule is read for every variant it applies to, but reported once.
  assert.deepEqual(parts.map((issue) => issue.line), [6, 9]);
  assert.match(parts[0].message, /parts: Next/);
  assert.match(parts[0].message, /write data-name="Continue" on that text/);
  const kept = chip("Next").replace('<p class="type-label">', '<p data-name="Continue" class="type-label">');
  assert.equal((await checkPackageFiles(sample({ "components/Chip.html": kept }))).ok, true);
});

test("tokens.css problems point at the declaration", async () => {
  const result = await checkPackageFiles(sample({
    "tokens.css": `${TOKENS}\n:root[data-mode="dim"] {\n  --colour-brand: #000;\n  --color-loop: var(--color-loop);\n  --spacing-bad: 4em;\n}\n`,
  }));
  const codes = result.issues.map((issue) => issue.code);
  assert.ok(codes.includes("invalid_token_name"));
  assert.ok(codes.includes("token_alias_cycle"));
  assert.ok(codes.includes("invalid_token_value"));
  const name = result.issues.find((issue) => issue.code === "invalid_token_name");
  assert.equal(name.file, "tokens.css");
  assert.equal(name.line, 25);
});

test("writing a decoded package reproduces its files", async () => {
  const files = sample();
  const { values } = await decodePackageFiles(files);
  const snapshot = await loadPackageFromValues("sample", values);
  const { files: written } = encodePackage(snapshot);
  const again = encodePackage(
    await loadPackageFromValues("sample", (await decodePackageFiles(written)).values),
  ).files;
  assert.deepEqual([...again.keys()].sort(), [...written.keys()].sort());
  for (const [path, content] of written) assert.equal(again.get(path), content, path);
  // The canonical form keeps what an author wrote in these files.
  assert.equal(written.get("components/Button.html"), BUTTON);
  assert.equal(written.get("pages/Tasks/Detail.html"), DETAIL);
});

test("the identity map keeps ids across a rename made by the App", async () => {
  const { values } = await decodePackageFiles(sample());
  const snapshot = await loadPackageFromValues("sample", values);
  const board = snapshot.entries["pages/Tasks/Board"].presentations[0];
  const card = nodeNamed(board, "Card");
  card.name = "Task card";
  const { files, identity } = encodePackage(snapshot);
  assert.match(files.get("pages/Tasks/Board.html"), /data-name="Task card"/);
  const reread = await decodePackageFiles(files, { identity });
  const reloaded = reread.values.get("pages/Tasks/Board").presentations[0];
  assert.equal(nodeNamed(reloaded, "Task card").id, card.id);
  assert.equal(nodeNamed(reloaded, "Card title").id, nodeNamed(board, "Card title").id);
});

test("variants that differ per combination keep a full-selection rule", async () => {
  const chip = `<sp-component name="Chip" props="Tone: plain | bold; Size: sm | lg">
  <div class="flex flex-row px-[8px] bg-[#eeeeee]">
    <p data-name="Text">Chip</p>
  </div>
  <sp-variant when="Tone: bold" class="bg-[#222222]"></sp-variant>
  <sp-variant when="Tone: bold; Size: lg" class="bg-[#000000]"></sp-variant>
</sp-component>
`;
  const files = sample({ "components/Chip.html": chip });
  const snapshot = await loadPackageFromValues("sample", (await decodePackageFiles(files)).values);
  const written = encodePackage(snapshot).files.get("components/Chip.html");
  assert.equal(written, chip);
});

test("a layer only some variants have is written once and hidden elsewhere", async () => {
  const { values } = await decodePackageFiles(sample());
  const snapshot = await loadPackageFromValues("sample", values);
  const set = snapshot.entries["components/Button.html"].componentSets[0];
  const style = set.axes.find((axis) => axis.name === "Style");
  // As the App would: a designer adds an icon to the secondary variants only.
  for (const variant of set.variants) {
    if (variant.selection[style.id] !== "secondary") continue;
    const root = variant.nodes[variant.rootId];
    variant.nodes.node_icon_added = {
      children: [], fills: [{ color: "#2563eb", type: "solid" }], height: 16, id: "node_icon_added",
      "layout-item-h-sizing": "fix", "layout-item-v-sizing": "fix", name: "Icon", type: "RECTANGLE", width: 16, x: 0, y: 0,
    };
    root.children = [...root.children, "node_icon_added"];
  }
  const { files } = encodePackage(snapshot);
  const button = files.get("components/Button.html");
  assert.match(button, /<div data-shape="rectangle" data-name="Icon" class="[^"]*hidden[^"]*">/);
  assert.match(button, /<sp-variant when="Style: secondary"[^>]*>\n(?:.*\n)*?\s+<div data-name="Icon" class="shown"><\/div>/);
  const reread = await loadPackageFromValues("sample", (await decodePackageFiles(files)).values);
  const rereadSet = reread.entries["components/Button.html"].componentSets[0];
  for (const variant of rereadSet.variants) {
    const icon = Object.values(variant.nodes).find((node) => node.name === "Icon");
    assert.equal(icon.visible !== false, variant.selection[style.id] === "secondary");
  }
  assert.equal(encodePackage(reread).files.get("components/Button.html"), button);
});

test("siblings with one name are numbered so they can be found by name", async () => {
  const { values } = await decodePackageFiles(sample());
  const snapshot = await loadPackageFromValues("sample", values);
  const board = snapshot.entries["pages/Tasks/Board"].presentations[0];
  const card = nodeNamed(board, "Card");
  nodeNamed(board, "Card title").name = "Line";
  nodeNamed(board, "Save").name = "Line";
  assert.ok(card.children.length === 2);
  const { files } = encodePackage(snapshot);
  const html = files.get("pages/Tasks/Board.html");
  assert.match(html, /data-name="Line"/);
  assert.match(html, /data-name="Line 2"/);
  const result = await checkPackageFiles(files);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});

test("gradients, per-side borders and blurs read and write exactly", async () => {
  const board = page(`<body class="flex flex-col p-[24px] bg-canvas">
  <div data-name="Hero" class="w-[320px] h-[120px] bg-[linear-gradient(from_0.5_0_to_0.5_1,#2563eb_0%,#93c5fd80_100%)] blur-[2px]"></div>
  <div data-name="Glass" class="w-[320px] h-[80px] bg-[radial-gradient(from_0.5_0.5_to_1_1_width_0.8,#ffffff_0%,#ffffff00_100%)] backdrop-blur-[12px]"></div>
  <div data-name="Row" class="w-[320px] h-[40px] border-0 border-b-[1px] border-t-[2px] border-[#e5e7eb]"></div>
</body>`);
  const files = sample({ "pages/Tasks/Board.html": board });
  const decoded = await decodePackageFiles(files);
  assert.deepEqual(decoded.issues.filter((issue) => issue.severity === "error"), []);
  const snapshot = await loadPackageFromValues("sample", decoded.values);
  const presentation = snapshot.entries["pages/Tasks/Board"].presentations[0];
  const hero = nodeNamed(presentation, "Hero");
  assert.equal(hero.fills[0].type, "linear-gradient");
  assert.deepEqual(hero.fills[0].stops, [{ color: "#2563eb", offset: 0 }, { color: "#93c5fd", offset: 1, opacity: 0.5 }]);
  assert.equal(hero.blur.type, "layer-blur");
  assert.equal(hero.blur.value, 2);
  assert.equal(nodeNamed(presentation, "Glass").backgroundBlur.value, 12);
  assert.equal(nodeNamed(presentation, "Glass").fills[0].gradientWidth, 0.8);
  const stroke = nodeNamed(presentation, "Row").strokes[0];
  assert.equal(stroke.width, 0);
  assert.equal(stroke.widthTop, 2);
  assert.equal(stroke.widthBottom, 1);
  const written = encodePackage(snapshot).files.get("pages/Tasks/Board.html");
  // A top-to-bottom gradient is written in its CSS form.
  assert.match(written, /bg-\[linear-gradient\(to_bottom,#2563eb_0%,#93c5fd80_100%\)\] blur-\[2px\]/);
  assert.match(written, /bg-\[radial-gradient\(from_0\.5_0\.5_to_1_1_width_0\.8,#ffffff_0%,#ffffff00_100%\)\] backdrop-blur-\[12px\]/);
  assert.match(written, /h-\[40px\] border-t-\[2px\] border-b border-\[#e5e7eb\]/);
});

test("Token and theme names from the App are written as tokens.css names and keep their ids", async () => {
  const { values } = await decodePackageFiles(sample());
  const snapshot = await loadPackageFromValues("sample", values);
  const library = snapshot.entries["tokens.css"];
  const base = library.sets.find((set) => set.id === "tset_base");
  // The App's token panel and DTCG imports name Tokens with dots.
  base.tokens.push(
    { description: "", id: "tok_app_brand", name: "core.color.Brand", type: "color", value: "#123456" },
    { description: "", id: "tok_app_alias", name: "color.link", type: "color", value: "{core.color.Brand}" },
  );
  for (const theme of library.themes) theme.group = "Mode";
  const { files, identity } = encodePackage(snapshot);
  const css = files.get("tokens.css");
  assert.match(css, /--color-core-color-brand: #123456;/);
  assert.match(css, /--color-link: var\(--color-core-color-brand\);/);
  assert.match(css, /:root\[data-mode="dark"\]/);
  const reread = await decodePackageFiles(files, { identity });
  const tokens = reread.values.get("tokens.css").sets.flatMap((set) => set.tokens);
  assert.equal(tokens.find((token) => token.name === "color-core-color-brand").id, "tok_app_brand");
  assert.equal(tokens.find((token) => token.name === "color-link").id, "tok_app_alias");
});

test("a Token set outside the theme options joins :root when on and is refused when off", async () => {
  const { values } = await decodePackageFiles(sample());
  const snapshot = await loadPackageFromValues("sample", values);
  const library = snapshot.entries["tokens.css"];
  library.sets.push({ description: "", id: "tset_extra", name: "extra", tokens: [{ description: "", id: "tok_extra", name: "color-extra", type: "color", value: "#abcdef" }] });
  library.activeSetIds = [...library.activeSetIds, "tset_extra"];
  assert.match(encodePackage(snapshot).files.get("tokens.css").split("\n\n")[0], /--color-extra: #abcdef;/);
  library.activeSetIds = library.activeSetIds.filter((id) => id !== "tset_extra");
  assert.throws(() => encodePackage(snapshot), (error) => error.code === "unsupported_in_html_format" && /extra/.test(error.message));
  library.sets.at(-1).tokens[0].type = "number";
  library.activeSetIds = [...library.activeSetIds, "tset_extra"];
  assert.throws(() => encodePackage(snapshot), (error) => error.code === "unsupported_in_html_format" && /number/.test(error.message));
});
