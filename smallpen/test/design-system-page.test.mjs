import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDesignSystemPage,
  expandDesignSystemPage,
  loadPackageFromValues,
} from "@smallpen/core";
import {
  allTokenSpecimens,
  colorFamily,
  designSystemColumns,
  representativeComponentSamples,
} from "../packages/core/src/design-system-page.mjs";
import { renderProjection } from "@smallpen/local-package";
import { buildEditorPackageValues } from "./fixtures/design-system-editor-fixture.mjs";

const combos = [
  { id: "cb-light", label: "Light", setIds: ["s1"] },
  { id: "cb-dark", label: "Dark", setIds: ["s2"] },
];

let next = 0;
const uuid = () => {
  next += 1;
  return `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`;
};

function cell(fields) {
  return {
    alias: false,
    aliasCycle: false,
    attribute: "fill",
    caption: uuid(),
    combinationId: null,
    combinationIds: [],
    order: 0,
    ownerPackageId: "pkg",
    path: "color.brand.base",
    raw: "#4f46e5",
    setId: "s0",
    setName: "base",
    shape: uuid(),
    status: "active",
    tokenId: "tok",
    type: "color",
    unresolvedAlias: false,
    value: "#4f46e5",
    ...fields,
  };
}

function samples(axes, selections, build) {
  return selections.map((selection, index) => ({
    axes,
    caption: uuid(),
    classification: "Composite",
    combinationId: selection.theme ?? null,
    combinationLabel: selection.theme ?? null,
    componentSetId: "cmp_test",
    familyName: "Card",
    kind: "variant",
    nodes: {
      node_root: {
        children: [],
        height: 100,
        id: "node_root",
        name: "Card",
        type: "FRAME",
        width: 200,
        x: 0,
        y: 0,
        ...build(selection),
      },
    },
    rootId: "node_root",
    selection,
    variantId: `var_${index}`,
    variantIndex: index,
  }));
}

const roleNodes = (page, role) =>
  Object.values(page.nodes).filter((node) => node.designSystem.role === role);

function assertComponentNotesClear(page, sampleRole) {
  const notes = Object.values(page.nodes).filter((node) => node.type === "TEXT");
  for (const note of notes)
    for (const sample of roleNodes(page, sampleRole)) {
      const gapX = Math.max(sample.x - note.x - note.width, note.x - sample.x - sample.width, 0);
      const gapY = Math.max(sample.y - note.y - note.height, note.y - sample.y - sample.height, 0);
      assert.ok(Math.max(gapX, gapY) >= 23.99, `${note.name} leaves clear space around ${sample.name}`);
    }
}

test("every Token Cell shows once, and Cells sharing a path carry their theme", () => {
  const specimens = {
    "a@cb-light": cell({ combinationId: "cb-light", combinationIds: ["cb-light", "cb-dark"], path: "radius.md", tokenId: "a", type: "border-radius", attribute: "radius", raw: 8, value: 8 }),
    "a@cb-dark": cell({ combinationId: "cb-dark", combinationIds: ["cb-light", "cb-dark"], path: "radius.md", tokenId: "a", type: "border-radius", attribute: "radius", raw: 8, value: 8 }),
    light: cell({ combinationIds: ["cb-light"], path: "color.bg", setId: "s1", tokenId: "light", raw: "#ffffff", value: "#ffffff" }),
    dark: cell({ combinationIds: ["cb-dark"], path: "color.bg", setId: "s2", tokenId: "dark", raw: "#111111", value: "#111111" }),
    same: cell({ path: "color.other", tokenId: "same", raw: "#ffffff", value: "#ffffff" }),
  };
  const cells = allTokenSpecimens(specimens, combos);
  assert.deepEqual(cells.map((ref) => ref.tokenId).sort(), ["a", "dark", "light", "same"]);
  assert.equal(cells.find((ref) => ref.tokenId === "light").themeLabel, "Light");
  assert.equal(cells.find((ref) => ref.tokenId === "dark").themeLabel, "Dark");
  assert.equal(cells.find((ref) => ref.tokenId === "same").themeLabel, undefined);

  const page = buildDesignSystemPage({ combinations: combos, specimens }, {}, { locale: "en" });
  const shown = roleNodes(page, "token-cell").map((node) => page.runtimeIds[node.id]);
  assert.equal(shown.length, 4, "equal values and repeated combinations still show each Cell once");
  assert.equal(new Set(shown).size, 4);
  for (const ref of cells) assert.ok(shown.includes(ref.shape));
  const captions = roleNodes(page, "caption").map((node) => page.runtimeIds[node.id]);
  for (const ref of cells) assert.ok(captions.includes(ref.caption));
});

test("colors group by family into rows per theme with rounded swatches", () => {
  assert.equal(colorFamily("color.status.backlog.base"), "color.status");
  assert.equal(colorFamily("color.neutral.500"), "color.neutral");
  assert.equal(colorFamily("color-1"), "");
  const specimens = {
    base: cell({ path: "color.bg.canvas", tokenId: "base", combinationIds: ["cb-light", "cb-dark"], raw: "#fafafa", value: "#fafafa" }),
    dark: cell({ path: "color.bg.canvas", tokenId: "dark", setId: "s2", combinationIds: ["cb-dark"], raw: "#0b0b0b", value: "#0b0b0b" }),
    brand: cell({ path: "color.brand.base", tokenId: "brand" }),
    alpha: cell({ path: "color.brand.overlay", tokenId: "alpha", raw: "#33669980", value: "#33669980" }),
    clear: cell({ path: "color.brand.clear", tokenId: "clear", raw: "#00000000", value: "#00000000" }),
  };
  const page = buildDesignSystemPage({ combinations: combos, specimens }, {}, { locale: "en" });
  const names = Object.values(page.nodes).map((node) => node.name);
  assert.ok(names.includes("Token type · color · color.bg"));
  assert.ok(names.includes("Token type · color · color.brand"));
  const texts = Object.values(page.nodes).filter((node) => node.type === "TEXT").map((node) => node.text);
  assert.ok(texts.includes("Default") && texts.includes("Dark"), "the bg card labels its theme rows");
  assert.ok(texts.includes("canvas"), "a family card names a color by its last segments");
  const swatch = (tokenId) =>
    roleNodes(page, "token-cell").find((node) => page.runtimeIds[node.id] === specimens[tokenId].shape);
  assert.deepEqual([swatch("brand").width, swatch("brand").height], [72, 40]);
  assert.deepEqual(swatch("alpha").fills, [{ color: "#336699", opacity: 128 / 255, type: "solid" }]);
  assert.equal(swatch("clear").strokes[0].style, "dashed");
  assert.ok(swatch("dark").y > swatch("base").y, "the Dark row sits under the default row");
});

test("spacing draws as a bar six times the value, whose gap is the Cell value", () => {
  const specimens = Object.fromEntries([4, 16, 32].map((value) => [
    `gap${value}`,
    cell({ attribute: "gap", children: [uuid(), uuid()], path: `space.${value}`, raw: value, tokenId: `gap${value}`, type: "spacing", value }),
  ]));
  const page = buildDesignSystemPage({ specimens }, {}, { locale: "en" });
  for (const ref of Object.values(specimens)) {
    const frame = roleNodes(page, "token-cell").find((node) => page.runtimeIds[node.id] === ref.shape);
    assert.equal(frame.type, "FRAME");
    assert.deepEqual(frame["layout-gap"], { "column-gap": ref.value, "row-gap": ref.value });
    assert.equal(frame.width, 6 * ref.value);
    assert.deepEqual(frame.children.map((id) => page.runtimeIds[id]).sort(), [...ref.children].sort());
  }
});

test("large spacing samples and their captions stay clear of other Token sections", () => {
  for (const value of [224, 800]) {
    const spacing = cell({ attribute: "gap", children: [uuid(), uuid()], path: "space.pageX", raw: value, tokenId: "pageX", type: "spacing", value });
    const dimension = cell({ attribute: "width", path: "size.frameWidth", raw: 1280, tokenId: "frameWidth", type: "dimensions", value: 1280 });
    const page = buildDesignSystemPage({ specimens: { spacing, dimension } }, {}, { locale: "en" });
    const frame = roleNodes(page, "token-cell").find((node) => page.runtimeIds[node.id] === spacing.shape);
    const caption = roleNodes(page, "caption").find((node) => page.runtimeIds[node.id] === spacing.caption);
    assert.ok(frame.x + frame.width <= caption.x || caption.x + caption.width <= frame.x, "the bar does not cover its caption");
    assert.ok(Math.max(frame.x + frame.width, caption.x + caption.width) <= page.width, "the whole row fits on the board");
    for (const node of Object.values(page.nodes).filter((node) => node.name === "Token type · dimensions" || page.runtimeIds[node.id] === dimension.shape)) {
      const overlaps = frame.x < node.x + node.width && node.x < frame.x + frame.width && frame.y < node.y + node.height && node.y < frame.y + frame.height;
      assert.equal(overlaps, false, "the bar does not enter the Dimensions section");
    }
    assert.equal(frame["layout-gap"]["column-gap"], value, "the editable gap retains the actual Token value");
  }
});

test("spacing labels sit immediately before aligned bar starts", () => {
  const specimens = Object.fromEntries([4, 16, 224].map((value) => [
    `gap${value}`,
    cell({ attribute: "gap", path: `space.${value}`, raw: value, tokenId: `gap${value}`, type: "spacing", value }),
  ]));
  const page = buildDesignSystemPage({ specimens }, {}, { locale: "en" });
  const starts = [];
  for (const ref of Object.values(specimens)) {
    const frame = roleNodes(page, "token-cell").find((node) => page.runtimeIds[node.id] === ref.shape);
    const caption = roleNodes(page, "caption").find((node) => page.runtimeIds[node.id] === ref.caption);
    const distance = frame.x - caption.x - caption.width;
    assert.ok(distance > 0 && distance <= 16, "short and long bars both sit next to their label");
    assert.equal(caption.textStyle.textAlign, "right", "label text ends next to the bar");
    starts.push(frame.x);
  }
  assert.equal(new Set(starts).size, 1, "bar lengths share a starting point for comparison");
});

test("wrapped spacing captions have enough height and do not touch the next row", () => {
  const first = cell({ attribute: "gap", path: "space.reading.details.content.horizontal.padding", raw: 224, tokenId: "first", type: "spacing", value: 224 });
  const second = cell({ attribute: "gap", path: "space.reading.details.content.vertical.padding", raw: 240, tokenId: "second", type: "spacing", value: 240 });
  const page = buildDesignSystemPage({ specimens: { first, second } }, {}, { locale: "en" });
  const captions = [first, second].map((ref) => roleNodes(page, "caption").find((node) => page.runtimeIds[node.id] === ref.caption));
  for (const caption of captions) {
    assert.ok(caption.text.includes("\n"), "a long Token name wraps explicitly");
    assert.ok(caption.height >= caption.text.split("\n").length * 12 * 1.4, "all caption lines fit");
  }
  assert.ok(captions[0].y + captions[0].height < captions[1].y, "caption rows have a gap");
});

test("typography shows each style at its own size with its numbers", () => {
  const value = { fontFamily: "Source Sans Pro", fontSize: 32, fontWeight: 700, lineHeight: 1.25 };
  const ref = cell({ attribute: "typography", path: "type.display", raw: value, tokenId: "display", type: "typography", value });
  const page = buildDesignSystemPage({ specimens: { display: ref } }, {}, { locale: "en" });
  const text = roleNodes(page, "token-cell")[0];
  assert.equal(text.type, "TEXT");
  assert.equal(text.text, "Display 32/700");
  assert.equal(text.textStyle.fontSize, 32);
  assert.equal(text.textStyle.fontWeight, 700);
});

test("page labels follow the requested language", () => {
  const ids = { board: uuid(), componentsSection: uuid(), tokenLabel: uuid() };
  const zh = buildDesignSystemPage({}, ids, { locale: "zh_cn" });
  const en = buildDesignSystemPage({}, ids, { locale: "en" });
  const title = (page) => Object.values(page.nodes).find((node) => page.runtimeIds[node.id] === ids.tokenLabel).text;
  assert.equal(title(zh), "设计系统");
  assert.equal(title(en), "Design System");
  assert.equal(zh.runtimeIds[zh.rootId], ids.board);
  assert.ok(Object.values(zh.nodes).some((node) => node.text === "暂无令牌"));
});

test("identical themes collapse to one sample, palette-only themes add no structure", () => {
  const same = samples([], [{ theme: "Light" }, { theme: "Dark" }], () => ({ fills: [{ color: "#ffffff", type: "solid" }] }));
  assert.equal(representativeComponentSamples(same).length, 1);

  const axes = [{ domain: ["primary", "secondary"], id: "style", name: "Style" }];
  const palette = samples(
    axes,
    ["primary", "secondary"].flatMap((style) => ["Light", "Dark"].map((theme) => ({ style, theme }))),
    ({ style, theme }) => ({
      fills: [{ color: { "primary-Light": "#4f46e5", "primary-Dark": "#818cf8", "secondary-Light": "#ffffff", "secondary-Dark": "#111827" }[`${style}-${theme}`], type: "solid" }],
    }),
  );
  assert.deepEqual(
    representativeComponentSamples(palette).map((sample) => sample.nodes.node_root.fills[0].color).sort(),
    ["#4f46e5", "#818cf8", "#ffffff"],
  );

  const copy = samples(
    [{ domain: ["short", "long"], id: "content", name: "Content" }],
    [{ content: "short" }, { content: "long" }],
    ({ content }) => ({ locked: content === "long", text: content, type: "TEXT" }),
  );
  assert.equal(representativeComponentSamples(copy).length, 1, "copy and metadata add no preview");
});

test("samples show every new visual feature without the whole cartesian product", () => {
  const axes = [
    { domain: ["primary", "secondary", "ghost"], id: "style", name: "Style" },
    { domain: ["sm", "md"], id: "size", name: "Size" },
    { domain: ["default", "disabled"], id: "state", name: "State" },
  ];
  const all = samples(
    axes,
    ["primary", "secondary", "ghost"].flatMap((style) =>
      ["sm", "md"].flatMap((size) =>
        ["default", "disabled"].flatMap((state) => ["Light", "Dark"].map((theme) => ({ size, state, style, theme }))))),
    ({ size, state, style }) => ({
      fills: [{ color: { ghost: "#eeeeee", primary: "#4f46e5", secondary: "#ffffff" }[style], type: "solid" }],
      height: 40,
      opacity: state === "disabled" ? 0.4 : 1,
      width: size === "sm" ? 96 : 112,
    }),
  );
  const chosen = representativeComponentSamples(all);
  assert.ok(chosen.length < 12);
  assert.deepEqual(new Set(chosen.map((sample) => sample.nodes.node_root.width)), new Set([96, 112]));
  assert.deepEqual(new Set(chosen.map((sample) => sample.nodes.node_root.opacity)), new Set([0.4, 1]));

  const ordered = samples(
    [{ domain: ["sm", "lg"], id: "size", name: "Size" }, { domain: ["default", "error", "warning"], id: "state", name: "State" }],
    ["sm", "lg"].flatMap((size) =>
      ["default", "error", "warning"].flatMap((state) => ["Light", "Dark"].map((theme) => ({ size, state, theme })))),
    ({ size, state, theme }) => ({
      cornerRadius: size === "lg" && state !== "default" ? (state === "error" ? 14 : 22) : 0,
      fills: [{ color: theme === "Light" ? "#ffffff" : "#111827", type: "solid" }],
      opacity: state === "default" ? 1 : 0.6,
      width: size === "lg" ? 480 : 320,
    }),
  );
  assert.deepEqual(representativeComponentSamples(ordered).map((sample) => sample.variantIndex), [0, 6, 2, 1, 8, 10]);
});

test("a family card captions its axes once and each sample by what differs", () => {
  const axes = [{ domain: ["primary", "secondary"], id: "style", name: "Style" }];
  const refs = {
    componentSamples: samples(axes, [{ style: "primary" }, { style: "secondary" }], ({ style }) => ({
      fills: [{ color: style === "primary" ? "#4f46e5" : "#e5e7eb", type: "solid" }],
    })),
  };
  const page = buildDesignSystemPage(refs, {}, { locale: "en" });
  const texts = Object.values(page.nodes).filter((node) => node.type === "TEXT").map((node) => node.text);
  // In English the values read as the file writes them.
  assert.ok(texts.some((text) => text.startsWith("Style: primary / secondary\n")));
  assert.ok(texts.includes("primary") && texts.includes("secondary"), "the first sample names its own values");
  assert.ok(texts.includes("Composite · 1"));
  const placeholders = roleNodes(page, "component-sample");
  assert.deepEqual(placeholders.map((node) => node.designSystem.sample).sort(), [0, 1]);
  assert.ok(placeholders.every((node) => node.children.length === 0));
});

test("transparent component captions name every property without relying on sample order", () => {
  const axes = [
    { id: "style", name: "Style", domain: ["primary", "secondary"] },
    { id: "size", name: "Size", domain: ["md", "sm"] },
  ];
  const choices = [{ style: "primary", size: "md" }, { style: "secondary", size: "sm" },
    { style: "primary", size: "sm" }, { style: "secondary", size: "md" }];
  const componentSamples = samples(axes, choices, () => ({ width: 74, height: 33 }));
  for (const [locale, styles] of [["en", ["primary", "secondary"]], ["zh_cn", ["主要", "次要"]], ["zh_hant", ["主要", "次要"]]]) {
    const options = { only: "components", transparentComponents: true, locale };
    const complete = buildDesignSystemPage({ componentSamples }, {}, { ...options, allVariantsOf: new Set(["cmp_test"]) });
    assert.deepEqual(roleNodes(complete, "caption").map((node) => node.text),
      choices.map(({ style, size }) => `${styles[style === "primary" ? 0 : 1]} · ${size}`));
    assert.ok(complete.width < 600);
    assert.equal(new Set(roleNodes(complete, "component-sample").map((node) => node.x)).size, 2);
    assertComponentNotesClear(complete, "component-sample");
    const representative = buildDesignSystemPage({ componentSamples }, {}, options);
    for (const caption of roleNodes(representative, "caption")) {
      const sample = componentSamples.find((sample) => sample.caption === representative.runtimeIds[caption.id]);
      assert.equal(caption.text, `${styles[sample.selection.style === "primary" ? 0 : 1]} · ${sample.selection.size}`);
    }
  }
  const normal = buildDesignSystemPage({ componentSamples }, {}, { allVariantsOf: new Set(["cmp_test"]) });
  assert.deepEqual(roleNodes(normal, "caption").map((node) => node.text),
    ["primary · md", "secondary · sm", "sm", "secondary"], "normal App captions keep their format, values as the file writes them");
});

test("transparent captions include the theme on baseline and changed samples", () => {
  const componentSamples = samples([{ id: "size", name: "Size", domain: ["md", "sm"] }],
    [{ size: "md", theme: "Light" }, { size: "sm", theme: "Light" }, { size: "md", theme: "Dark" }],
    ({ size, theme }) => ({ width: size === "md" ? 74 : 60, height: 33,
      fills: [{ type: "solid", color: theme === "Light" ? "#ffffff" : "#000000" }] }));
  const page = buildDesignSystemPage({ componentSamples }, {}, { only: "components", transparentComponents: true });
  assert.deepEqual(roleNodes(page, "caption").map((node) => node.text), ["md · Light", "sm · Light", "md · Dark"]);
  assertComponentNotesClear(page, "component-sample");
});

test("complete long captions wrap without widening or resizing the components", () => {
  const choices = [{ state: "ready with helpful details", size: "compact with supporting text" },
    { state: "busy with helpful details", size: "compact with supporting text" }];
  const axes = [{ id: "state", name: "State", domain: choices.map(({ state }) => state) },
    { id: "size", name: "Size", domain: [choices[0].size] }];
  const componentSamples = samples(axes, choices, () => ({ width: 200, height: 40 }));
  const page = buildDesignSystemPage({ componentSamples }, {}, {
    only: "components", transparentComponents: true, allVariantsOf: new Set(["cmp_test"]),
  });
  assert.ok(page.width < 700, "long annotations do not restore a desktop-width canvas");
  assert.deepEqual(roleNodes(page, "caption").map((node) => node.text.replaceAll("\n", "")),
    choices.map(({ state, size }) => `${state} · ${size}`));
  assert.ok(roleNodes(page, "caption").every((node) => node.text.includes("\n")));
  assert.deepEqual(roleNodes(page, "component-sample").map((node) => [node.width, node.height]), [[200, 40], [200, 40]]);
  assertComponentNotesClear(page, "component-sample");
});

test("catalogs report the variants they display and the combinations they omit", () => {
  const axes = [
    { id: "style", name: "Style", domain: ["primary", "secondary"] },
    { id: "size", name: "Size", domain: ["md", "sm"] },
  ];
  const refs = { componentSamples: samples(axes, [
    { style: "primary", size: "md" }, { style: "primary", size: "sm" },
    { style: "secondary", size: "md" }, { style: "secondary", size: "sm" },
  ], ({ style, size }) => ({
    fills: [{ color: style === "primary" ? "#2563eb" : "#e5e7eb", type: "solid" }],
    height: size === "md" ? 40 : 32,
  })) };
  const page = buildDesignSystemPage(refs, {}, { only: "components", locale: "en" });
  const [coverage] = page.preview.components;
  assert.equal(coverage.mode, "representative");
  assert.equal(coverage.shownVariants, 3);
  assert.equal(coverage.totalVariants, 4);
  assert.equal(coverage.shownSamples, roleNodes(page, "component-sample").length);
  assert.equal(coverage.omittedVariants.length, 1);
  const displayed = roleNodes(page, "component-sample").map((node) => refs.componentSamples[node.designSystem.sample].selection);
  assert.ok(!displayed.some((selection) => selection.style === coverage.omittedVariants[0].Style && selection.size === coverage.omittedVariants[0].Size));
  assert.ok(Object.values(page.nodes).some((node) => node.text?.includes("3 / 4 variants shown")));
  assert.deepEqual(expandDesignSystemPage(page, refs).preview, page.preview);

  const complete = buildDesignSystemPage(refs, {}, { only: "components", allVariantsOf: new Set(["cmp_test"]) });
  assert.equal(complete.preview.components[0].shownVariants, 4);
  assert.equal(complete.preview.components[0].mode, "all-variants");
  assert.deepEqual(complete.preview.components[0].omittedVariants, []);
});

test("variant coverage counts a variant once across multiple theme samples", () => {
  const refs = { componentSamples: samples([{ id: "style", name: "Style" }], [
    { style: "primary", theme: "Light" }, { style: "primary", theme: "Dark" },
  ], ({ theme }) => ({ fills: [{ color: theme === "Light" ? "#ffffff" : "#000000", type: "solid" }] })) };
  refs.componentSamples.forEach((sample, index) => Object.assign(sample, { variantId: "same-variant", variantIndex: 0, combinationIndex: index }));
  const page = buildDesignSystemPage(refs, {}, { only: "components" });
  assert.equal(page.preview.components[0].totalVariants, 1);
  assert.equal(page.preview.components[0].shownVariants, 1);
  assert.equal(page.preview.components[0].shownSamples, 2);
  const complete = buildDesignSystemPage(refs, {}, { only: "components", allVariantsOf: new Set(["cmp_test"]) });
  assert.equal(complete.preview.components[0].shownVariants, 1);
  assert.equal(complete.preview.components[0].shownSamples, 1, "all variants is still one theme combination");
});

test("a transparent compound does not get a dark backdrop for white text inside its opaque button", () => {
  const [sample] = samples([], [{}], () => ({ fills: [], children: ["input", "button"] }));
  Object.assign(sample.nodes, {
    input: { id: "input", type: "FRAME", fills: [{ color: "#ffffff", type: "solid" }], children: [] },
    button: { id: "button", type: "FRAME", fills: [{ color: "#2563eb", type: "solid" }], children: ["label"] },
    label: { id: "label", type: "TEXT", text: "Search", fills: [{ color: "#ffffff", type: "solid" }], children: [] },
  });
  const before = structuredClone(sample);
  const page = buildDesignSystemPage({ componentSamples: [sample] }, {}, { only: "components" });
  assert.deepEqual(page.preview.components[0].backdrops, [{ variant: {}, color: "#f1f5f9" }]);
  assert.ok(!Object.values(page.nodes).some((node) => node.type !== "TEXT" && node.fills?.some((fill) => fill.color === "#111827")));
  assert.ok(Object.values(page.nodes).some((node) => node.text?.includes("Preview background: #f1f5f9")));
  assert.deepEqual(sample, before, "a preview never changes the authored component");
});

test("an exposed light label keeps a dark preview backdrop while hidden labels do not request one", () => {
  for (const hidden of [false, true, "transparent"]) {
    const [sample] = samples([], [{}], () => ({ fills: [], children: ["group"] }));
    Object.assign(sample.nodes, {
      group: { id: "group", type: "FRAME", children: ["label"], ...(hidden === true ? { visible: false } : hidden === "transparent" ? { opacity: 0 } : {}) },
      label: { id: "label", type: "TEXT", text: "Light", fills: [{ color: "#ffffff", type: "solid" }], children: [] },
    });
    const page = buildDesignSystemPage({ componentSamples: [sample] }, {}, { only: "components" });
    assert.deepEqual(page.preview.components[0].backdrops, hidden ? [] : [{ variant: {}, color: "#111827" }]);
  }
});

test("transparent component sheets keep unbacked notes clear of authored sample regions", () => {
  const [sample] = samples([], [{}], () => ({ fills: [], children: ["label"] }));
  sample.nodes.label = { id: "label", type: "TEXT", text: "White label", fills: [{ color: "#ffffff", type: "solid" }], children: [] };
  const before = structuredClone(sample);
  const page = buildDesignSystemPage({ componentSamples: [sample] }, {}, { only: "components", transparentComponents: true });
  assert.deepEqual(page.nodes[page.rootId].fills, []);
  assert.deepEqual(page.preview.components[0].backdrops, []);
  assert.equal(page.preview.componentBackground, "transparent");
  assert.equal(page.preview.annotationBackground, "transparent");
  assert.equal(page.preview.annotationBorder, "none");
  assert.ok(!Object.values(page.nodes).some((node) => node.name.startsWith("Component card")));
  assert.equal(roleNodes(page, "annotation-background").length, 0, "component notes add no opaque panels or frames");
  assertComponentNotesClear(page, "component-sample");
  const text = Object.values(page.nodes).filter((node) => node.type === "TEXT");
  assert.equal(text.filter((node) => node.text.startsWith("Note · ")).length, 1, "one note heading names the component");
  assert.equal(roleNodes(page, "annotation-label").length, 0, "notes have no repeated side badges");
  assert.ok(!text.some((node) => node.text === "Components" || node.text === "Composite · 1"), "component notes do not repeat generic section headings");
  const title = text.find((node) => node.name === "Card");
  const scope = text.find((node) => node.text.includes("variants"));
  assert.ok(title && scope, "unbacked notes retain both the title and variant scope");
  assert.deepEqual(sample, before);
});

test("long annotation titles wrap inside masonry columns and never cover another component", () => {
  const componentSamples = [40, 200, 40, 40, 40].map((height, index) => {
    const [sample] = samples([], [{}], () => ({ height, fills: [{ color: "#2563eb", type: "solid" }] }));
    return { ...sample, componentSetId: `cmp_${index}`, familyName: index === 4
      ? "Administration navigation / Expanded desktop menu / With active item and notifications"
      : `Button ${index}` };
  });
  const page = buildDesignSystemPage({ componentSamples }, {}, { only: "components", transparentComponents: true });
  const title = Object.values(page.nodes).find((node) => node.name === componentSamples[4].familyName && node.type === "TEXT");
  assert.ok(title.text.includes("\n"), "long titles wrap before annotation panels are placed");
  assertComponentNotesClear(page, "component-sample");
});

test("multiline variant notes reserve their gutters even beside wider component samples", () => {
  const values = ["on", "off\nwith details\non another line"];
  const componentSamples = samples([{ id: "state", name: "State", domain: values }], values.map((state) => ({ state })), () => ({
    width: 200, height: 80, fills: [{ color: "#2563eb", type: "solid" }],
  }));
  const page = buildDesignSystemPage({ componentSamples }, {}, { only: "components", transparentComponents: true });
  assertComponentNotesClear(page, "component-sample");
});

test("located component notes reserve multiline height and a separate annotation gutter", () => {
  const families = ["Located short", "Located\nwith details\non another line"].map((label) => ({ kind: "located", label }));
  const page = buildDesignSystemPage({ families }, {}, {
    only: "components", transparentComponents: true, locatedSize: () => [200, 80],
  });
  assertComponentNotesClear(page, "located-family");
});

test("compact component sheets fit four small variants in a content-sized grid", () => {
  const values = ["a", "b", "c", "d"];
  const componentSamples = samples([{ id: "kind", name: "Kind", domain: values }],
    values.map((kind) => ({ kind })), () => ({ width: 74, height: 33, fills: [{ type: "solid", color: "#2563eb" }] }));
  const page = buildDesignSystemPage({ componentSamples }, {}, {
    only: "components", transparentComponents: true, allVariantsOf: new Set(["cmp_test"]),
  });
  const shown = roleNodes(page, "component-sample");
  assert.equal(shown.length, 4);
  assert.ok(page.width < 600, "a small component sheet does not reserve a desktop-width canvas");
  assert.equal(new Set(shown.map((node) => node.x)).size, 2);
  assert.equal(new Set(shown.map((node) => node.y)).size, 2);
  for (const node of shown) {
    assert.deepEqual([node.width, node.height], [74, 33], "compacting the sheet never scales authored components");
    assert.ok(node.x >= 24 && node.y >= 24 && node.x + node.width <= page.width - 24 && node.y + node.height <= page.height - 24);
  }
  assertComponentNotesClear(page, "component-sample");
});

test("a compact single-variant sheet drops only the redundant default caption", () => {
  const componentSamples = samples([], [{}], () => ({ width: 366, height: 33 }));
  const options = { only: "components", transparentComponents: true };
  const page = buildDesignSystemPage({ componentSamples }, {}, options);
  assert.ok(page.width < 500, "the canvas follows the component and note width");
  assert.equal(roleNodes(page, "caption").length, 0);
  assert.equal(page.preview.components[0].shownVariants, 1);
  assert.deepEqual(roleNodes(page, "component-sample").map((node) => [node.width, node.height]), [[366, 33]]);
  assertComponentNotesClear(page, "component-sample");
  const named = samples([{ id: "density", name: "Density", domain: ["compact"] }], [{ density: "compact" }], () => ({ width: 366, height: 33 }));
  const namedPage = buildDesignSystemPage({ componentSamples: named }, {}, options);
  assert.equal(roleNodes(namedPage, "caption").length, 1, "an authored property label is retained");
  const themed = componentSamples.map((sample) => ({ ...sample, combinationLabel: "Dark" }));
  assert.equal(roleNodes(buildDesignSystemPage({ componentSamples: themed }, {}, options), "caption").length, 1, "a selected combination retains its caption");
  const minimum = buildDesignSystemPage({ componentSamples }, {}, { ...options, minWidth: 800 });
  assert.ok(minimum.width >= 848, "an explicitly requested minimum content width is respected");
});

test("expanding the page inserts each sample's own nodes at its placeholder", () => {
  const refs = {
    componentSamples: samples([], [{}], () => ({ children: ["node_child"], x: 40, y: 30 })).map((sample) => ({
      ...sample,
      nodes: {
        ...sample.nodes,
        node_child: { children: [], height: 10, id: "node_child", name: "Child", type: "RECTANGLE", width: 10, x: 5, y: 6 },
      },
    })),
  };
  const page = buildDesignSystemPage(refs, {}, { locale: "en" });
  const tree = expandDesignSystemPage(page, refs);
  const placeholder = roleNodes(page, "component-sample")[0];
  const root = tree.nodes[`${placeholder.id}::node_root`];
  assert.deepEqual(tree.nodes[placeholder.id].children, [`${placeholder.id}::node_root`]);
  assert.deepEqual([root.x, root.y], [0, 0], "the sample sits exactly on its placeholder");
  assert.deepEqual(root.children, [`${placeholder.id}::node_child`]);
  assert.equal(tree.nodes[`${placeholder.id}::node_child`].x, 5);
  assert.ok(Object.values(tree.nodes).every((node) => node.designSystem === undefined));
});

test("columns grow slowly with content, and many samples widen a card instead of stretching it", () => {
  const card = (height) => ({ height, width: 600 });
  assert.equal(designSystemColumns([card(200)], 3, 8), 1);
  const few = designSystemColumns(Array.from({ length: 12 }, () => card(300)), 3, 8);
  const many = designSystemColumns(Array.from({ length: 60 }, () => card(300)), 3, 8);
  const lots = designSystemColumns(Array.from({ length: 400 }, () => card(300)), 3, 8);
  assert.ok(few >= 3 && few <= 4);
  assert.ok(many > few && many <= 8);
  assert.equal(lots, 8);

  const wide = samples(
    [{ domain: Array.from({ length: 12 }, (_, index) => `v${index}`), id: "kind", name: "Kind" }],
    Array.from({ length: 12 }, (_, index) => ({ kind: `v${index}` })),
    ({ kind }) => ({ cornerRadius: Number(kind.slice(1)), height: 120, width: 240 }),
  );
  const page = buildDesignSystemPage({ componentSamples: wide }, {}, { locale: "en" });
  const shell = Object.values(page.nodes).find((node) => node.name === "Component card · Card");
  assert.ok(shell.height <= shell.width, "a card with many samples spans columns");
});

test("a real Package's page shows every Cell and renders with the CLI renderer", async () => {
  const snapshot = await loadPackageFromValues("memory://page.smallpen", buildEditorPackageValues());
  const refs = snapshot.runtime.designSystemRefs;
  const page = buildDesignSystemPage(refs, snapshot.runtime.designSystem, { locale: "en" });
  const shown = new Set(roleNodes(page, "token-cell").map((node) => page.runtimeIds[node.id]));
  for (const ref of allTokenSpecimens(refs.specimens, refs.combinations)) {
    assert.ok(shown.has(ref.shape), `Cell ${ref.path} is on the page`);
  }
  assert.ok(roleNodes(page, "component-sample").length > 0);
  for (const node of Object.values(page.nodes)) {
    for (const child of node.children) assert.ok(page.nodes[child], `child ${child} exists`);
  }
  assert.deepEqual(buildDesignSystemPage(refs, snapshot.runtime.designSystem, { locale: "en" }), page, "deterministic");
  const render = await renderProjection(snapshot, expandDesignSystemPage(page, refs));
  assert.equal(render.width, Math.ceil(page.width));
  assert.deepEqual(render.diagnostics.filter((item) => item.code === "text_missing_glyph"), []);
});

test("export --design-system draws the page, and refuses a page beside it", async () => {
  const { spawn } = await import("node:child_process");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const cli = new URL("../apps/cli/bin/smallpen.mjs", import.meta.url).pathname;
  const pkg = new URL("../examples/common-components.smallpen", import.meta.url).pathname;
  const run = (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, LANG: "zh_CN.UTF-8" } });
      let stdout = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.on("close", (code) => resolve({ code, stdout }));
    });
  const directory = await mkdtemp(join(tmpdir(), "smallpen-ds-render-"));
  try {
    const output = join(directory, "page.png");
    const result = await run(["export", pkg, "--design-system", "--format", "png", "--output", output, "--json"]);
    assert.equal(result.code, 0, result.stdout);
    const reply = JSON.parse(result.stdout);
    assert.equal(reply.selection.designSystem, true);
    assert.equal(reply.selection.locale, "en", "English by default: the renderer has Latin glyphs only");
    assert.equal(reply.output, output);
    assert.ok(reply.width > 0 && reply.height > 0);
    const bytes = await readFile(output);
    assert.equal(bytes.subarray(1, 4).toString(), "PNG");
    const conflict = await run(["export", pkg, "--design-system", "--page", "Home", "--json"]);
    assert.equal(conflict.code, 1);
    const error = JSON.parse(conflict.stdout).error;
    assert.equal(error.code, "conflicting_read_target");
    assert.deepEqual(error.details.fields, ["designSystem", "page"]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

