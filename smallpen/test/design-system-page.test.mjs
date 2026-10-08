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
  assert.ok(texts.includes("Style: Primary / Secondary"));
  assert.ok(texts.includes("Primary") && texts.includes("Secondary"), "the first sample names its own values");
  assert.ok(texts.includes("Composite · 1"));
  const placeholders = roleNodes(page, "component-sample");
  assert.deepEqual(placeholders.map((node) => node.designSystem.sample).sort(), [0, 1]);
  assert.ok(placeholders.every((node) => node.children.length === 0));
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

test("a Product's page shows the Foundation Component Sets its Screens use, read-only", async (context) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { createInitializationState, createWorkspaceRuntime, prepareOperationBatch } = await import("@smallpen/core");
  const { initializeWorkspace, openPackage } = await import("@smallpen/local-package");
  const { compilePenpotChanges } = await import("@smallpen/penpot-adapter");
  const { INIT_ANSWERS_EXAMPLE } = await import("../apps/cli/bin/schema.mjs");
  const root = await mkdtemp(join(tmpdir(), "smallpen-ds-product-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const state = createInitializationState({ ...INIT_ANSWERS_EXAMPLE, foundationChoice: "create-new" });
  const paths = await initializeWorkspace(join(root, "acme"), state.proposal, { confirmed: true });
  const foundation = await openPackage(paths.foundationPath);
  const product = await openPackage(paths.productPath);
  const alone = await createWorkspaceRuntime(product, { foundation });
  assert.equal(alone.designSystemRefs.componentSamples.length, 0, "an unused Foundation set stays off the page");

  const button = foundation.domain.componentSets.get("cmp_button");
  const screen = product.entries[product.manifest.entries.screens[0]];
  const presentation = screen.presentations[0];
  const prepared = await prepareOperationBatch(
    product,
    {
      baseRevision: product.revision,
      batchId: "ds-product-instance",
      operations: [{
        node: {
          children: [],
          height: button.variants[0].nodes[button.variants[0].rootId].height,
          id: "node_cta",
          instance: {
            component: { assetId: "cmp_button", packageId: foundation.manifest.packageId },
            variant: button.variants[0].selection,
          },
          name: "Call to action",
          type: "INSTANCE",
          width: button.variants[0].nodes[button.variants[0].rootId].width,
          x: 0,
          y: 0,
        },
        parentId: presentation.rootId,
        presentationId: presentation.id,
        screenId: screen.id,
        type: "add-presentation-node",
      }],
    },
    { foundation },
  );
  const runtime = await createWorkspaceRuntime(prepared.snapshot, { foundation });
  const samples = runtime.designSystemRefs.componentSamples;
  assert.ok(samples.length >= button.variants.length);
  assert.ok(samples.every((sample) => sample.componentSetId === "cmp_button" && sample.readOnly === true));
  assert.ok(samples.every((sample) => Object.values(sample.sources).every((source) =>
    source.readOnly === true && source.ownerPackageId === foundation.manifest.packageId)));
  const own = new Set(foundation.runtime.designSystemRefs.componentSamples.flatMap((sample) => Object.values(sample.runtimeNodes)));
  assert.ok(samples.every((sample) => Object.values(sample.runtimeNodes).every((id) => !own.has(id))),
    "the Product's page has its own shape ids");

  const page = buildDesignSystemPage(runtime.designSystemRefs, runtime.designSystem, { locale: "en" });
  assert.ok(roleNodes(page, "component-sample").length > 0);

  const snapshot = { ...prepared.snapshot, runtime };
  const target = Object.values(samples[0].runtimeNodes)[0];
  assert.throws(
    () => compilePenpotChanges(snapshot, {
      changes: [{ id: target, operations: [{ attr: "opacity", type: "set", val: 0.5 }], "page-id": runtime.designSystemPage, type: "mod-obj" }],
      commitId: "ds-product-readonly",
    }),
    (error) => error.code === "foundation_components_read_only",
  );
});
