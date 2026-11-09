// Fill layers, image fills, stroke lists, grid layout and every prototype
// trigger: read from HTML, checked with located errors, and written back
// the same way when the App saves them.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkPackageFiles, decodePackageFiles, encodePackage } from "@smallpen/core";
import { applyOperationBatch, openPackage } from "@smallpen/local-package";
import { compilePenpotChanges } from "@smallpen/penpot-adapter";
import { pageHtml, writePackage } from "./helpers/named.mjs";

const TOKENS = ":root {\n  --color-brand: #2563eb;\n  --border-thin: 1px;\n}\n";
const INDEX = '<!doctype html>\n<html>\n<head>\n  <meta charset="utf-8">\n  <title>Features</title>\n  <meta name="smallpen:package-id" content="pkg_features">\n</head>\n<body></body>\n</html>\n';
const MENU = pageHtml('<body class="w-[240px] h-[320px] bg-[#ffffff]">\n  <p data-name="Close" class="left-[16px] top-[16px]" data-click="close-overlay">Close</p>\n</body>', { title: "Menu" });

const files = (home, extra = {}) => new Map(Object.entries({
  "index.html": INDEX,
  "tokens.css": TOKENS,
  "pages/Home.html": pageHtml(home, { title: "Home" }),
  "pages/Menu.html": MENU,
  ...extra,
}));

async function decoded(home, extra) {
  const result = await decodePackageFiles(files(home, extra));
  const screen = result.values.get("pages/Home");
  const nodes = screen.presentations[0].nodes;
  const byName = (name) => Object.values(nodes).find((node) => node.name === name);
  return { result, nodes, byName };
}

const errors = (result) => result.issues.filter((issue) => issue.severity === "error");

test("a fill list is read top layer first, with a Token per layer", async () => {
  const { result, byName } = await decoded(`<body class="bg-[#ffffff]">
  <div data-name="Hero" class="left-[0px] top-[0px] w-[200px] h-[100px] bg-[linear-gradient(from_0.5_0_to_0.5_1,#00000000_0%,#000000_100%),var(--color-brand)]"></div>
</body>`);
  assert.deepEqual(errors(result), []);
  const hero = byName("Hero");
  assert.equal(hero.fills.length, 2);
  assert.equal(hero.fills[0].type, "linear-gradient");
  assert.deepEqual(hero.fills[1], { color: "#2563eb", type: "solid" });
  assert.deepEqual(Object.keys(hero.tokenBindings), ["fills.1"]);
});

test("a stroke list keeps each stroke's width, style, color and place", async () => {
  const { result, byName } = await decoded(`<body class="bg-[#ffffff]">
  <div data-name="Card" class="left-[0px] top-[0px] w-[200px] h-[100px] border-[1px_#e5e7eb,2px_dashed_var(--color-brand)_outside]"></div>
</body>`);
  assert.deepEqual(errors(result), []);
  assert.deepEqual(byName("Card").strokes, [
    { alignment: "inner", color: "#e5e7eb", type: "solid", width: 1 },
    { alignment: "outer", color: "#2563eb", style: "dashed", type: "solid", width: 2 },
  ]);
  assert.deepEqual(Object.keys(byName("Card").tokenBindings), ["strokes.1"]);
});

test("fill and stroke lists report what is wrong with a layer", async () => {
  const { result } = await decoded(`<body class="bg-[#ffffff]">
  <div data-name="A" class="left-[0px] top-[0px] w-[10px] h-[10px] bg-[#ffffff,var(--color-missing)]"></div>
  <div data-name="B" class="left-[0px] top-[0px] w-[10px] h-[10px] bg-[#ffffff,var(--border-thin)]"></div>
  <div data-name="C" class="left-[0px] top-[0px] w-[10px] h-[10px] bg-[url(../assets/a.png)_2]"></div>
  <div data-name="D" class="left-[0px] top-[0px] w-[10px] h-[10px] border-[1px,2px_#000000]"></div>
  <div data-name="E" class="left-[0px] top-[0px] w-[10px] h-[10px] bg-[url(../assets/nowhere.png)]"></div>
</body>`);
  const messages = errors(result).map((issue) => `${issue.line} ${issue.code} ${issue.message}`);
  assert.ok(messages.some((message) => /^9 unknown_token .*no Token --color-missing/.test(message)), messages.join("\n"));
  assert.ok(messages.some((message) => /^10 unknown_token .*--border-thin is a stroke-width Token/.test(message)), messages.join("\n"));
  assert.ok(messages.some((message) => /^11 invalid_literal/.test(message)), messages.join("\n"));
  assert.ok(messages.some((message) => /^12 invalid_literal/.test(message)), messages.join("\n"));
  assert.ok(messages.some((message) => /^13 missing_asset .*nowhere\.png/.test(message)), messages.join("\n"));
});

test("an image fill names a file in assets/, keeps its opacity and writes back", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-image-fill-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "image.smallpen");
  await writePackage(path, {
    "tokens.css": TOKENS,
    "assets/hero_photo.webp": await readFile(new URL("fixtures/quadrant-lossy.webp", import.meta.url)),
    "pages/Home.html": pageHtml(`<body class="bg-[#ffffff]">
  <div data-name="Hero" class="left-[0px] top-[0px] w-[200px] h-[100px] bg-[url(../assets/hero_photo.webp)_0.8,#000000]"></div>
</body>`, { title: "Home" }),
  });
  const snapshot = await openPackage(path);
  const hero = Object.values(snapshot.entries[snapshot.manifest.entries.screens[0]].presentations[0].nodes).find((node) => node.name === "Hero");
  assert.equal(hero.fills[0].type, "image");
  assert.equal(hero.fills[0].opacity, 0.8);
  assert.match(hero.fills[0].mediaRef, /^media_/);
  const page = encodePackage(snapshot).files.get("pages/Home.html");
  assert.match(page, /bg-\[url\(\.\.\/assets\/hero_photo\.webp\)_0\.8,#000000\]/, "the file name keeps its underscore");
});

test("grid children go to the first free cell in written order, or to their lines", async () => {
  const { result, byName } = await decoded(`<body class="bg-[#ffffff]">
  <div data-name="Grid" class="grid grid-cols-[120px_1fr_auto] gap-[8px] left-[0px] top-[0px] w-[600px] h-[300px]">
    <div data-name="A" class="w-full h-[40px] bg-[#ff0000]"></div>
    <div data-name="B" class="col-span-2 w-full h-[40px] bg-[#00ff00]"></div>
    <div data-name="C" class="col-start-3 row-start-3 self-center justify-self-end w-[30px] h-[30px] bg-[#0000ff]"></div>
    <p data-name="D">Auto</p>
  </div>
</body>`);
  assert.deepEqual(errors(result), []);
  const grid = byName("Grid");
  assert.deepEqual(grid["layout-grid-columns"], [{ type: "fixed", value: 120 }, { type: "flex", value: 1 }, { type: "auto" }]);
  assert.deepEqual(grid["layout-grid-rows"], [{ type: "auto" }, { type: "auto" }, { type: "auto" }], "rows are added as children need them");
  const cellOf = (name) => Object.values(grid["layout-grid-cells"]).find((cell) => cell.shapes.includes(byName(name).id));
  const at = (name) => [cellOf(name).row, cellOf(name).column, cellOf(name)["row-span"], cellOf(name)["column-span"]];
  assert.deepEqual(at("A"), [1, 1, 1, 1]);
  assert.deepEqual(at("B"), [1, 2, 1, 2]);
  assert.deepEqual(at("C"), [3, 3, 1, 1]);
  assert.deepEqual(at("D"), [2, 1, 1, 1]);
  assert.equal(cellOf("C")["align-self"], "center");
  assert.equal(cellOf("C")["justify-self"], "end");
  assert.equal(Object.keys(grid["layout-grid-cells"]).length, 8, "every free spot is an empty cell");
  assert.equal(byName("A")["layout-item-h-sizing"], "fill", "w-full fills the cell");
});

test("grid classes outside a grid and a taken cell are located errors", async () => {
  const { result } = await decoded(`<body class="bg-[#ffffff]">
  <div data-name="Flex" class="flex grid-cols-3 left-[0px] top-[0px] w-[100px] h-[100px]">
    <div data-name="X" class="col-span-2 w-[10px] h-[10px]"></div>
  </div>
  <div data-name="Grid" class="grid grid-cols-2 left-[0px] top-[0px] w-[100px] h-[100px]">
    <div data-name="A" class="w-[10px] h-[10px]"></div>
    <div data-name="B" class="col-start-1 row-start-1 w-[10px] h-[10px]"></div>
  </div>
</body>`);
  const codes = errors(result).map((issue) => [issue.line, issue.code]);
  assert.deepEqual(codes, [[9, "layout_required"], [10, "layout_not_in_app"], [14, "grid_cell_taken"]]);
});

test("a grid writes back with only the lines the reading rule needs", async () => {
  const home = `<body class="bg-[#ffffff]">
  <div data-name="Grid" class="grid grid-cols-3 gap-[8px] p-[16px] w-[600px] h-[300px]">
    <div data-name="A" class="h-[40px] bg-[#ff0000]"></div>
    <div data-name="B" class="h-[40px] col-span-2 bg-[#00ff00]"></div>
    <div data-name="C" class="w-[30px] h-[30px] col-start-3 row-start-3 self-center justify-self-end bg-[#0000ff]"></div>
    <p data-name="D">Auto</p>
  </div>
</body>`;
  const snapshot = await loadFiles(files(home));
  const page = encodePackage(snapshot).files.get("pages/Home.html");
  assert.ok(page.includes(home.replace('<body class="bg-[#ffffff]">', "").replace("</body>", "").trim()), page);
});

test("every trigger and action reads into the App's interaction", async () => {
  const { result, byName } = await decoded(`<body class="bg-[#ffffff]">
  <div data-name="Card" class="left-[0px] top-[0px] w-[200px] h-[100px]"
    data-click="https://example.com"
    data-press="toggle-overlay:Menu"
    data-hover="overlay:Menu; position: top-right; close-outside; backdrop; animation: slide in left 200ms ease-out offset"
    data-mouse-enter="Menu; preserve-scroll; animation: push up 400ms"
    data-mouse-leave="close-overlay:Menu"
    data-after-delay="Menu; delay: 1500ms"></div>
  <div data-name="Corner" class="left-[300px] top-[0px] w-[200px] h-[100px]">
    <div data-name="Button" class="left-[0px] top-[0px] w-[20px] h-[20px]" data-click="overlay:Menu; position: manual 20px 40px"></div>
  </div>
</body>`);
  assert.deepEqual(errors(result), []);
  const byTrigger = Object.fromEntries(byName("Card").interactions.map((interaction) => [interaction["event-type"], interaction]));
  assert.deepEqual(Object.keys(byTrigger), ["click", "mouse-press", "mouse-over", "mouse-enter", "mouse-leave", "after-delay"]);
  assert.deepEqual(byTrigger.click, { "action-type": "open-url", "event-type": "click", url: "https://example.com" });
  assert.equal(byTrigger["mouse-press"]["action-type"], "toggle-overlay");
  assert.equal(byTrigger["mouse-over"]["overlay-pos-type"], "top-right");
  assert.equal(byTrigger["mouse-over"]["close-click-outside"], true);
  assert.equal(byTrigger["mouse-over"]["background-overlay"], true);
  assert.deepEqual(byTrigger["mouse-over"].animation, { "animation-type": "slide", direction: "left", duration: 200, easing: "ease-out", "offset-effect": true, way: "in" });
  assert.deepEqual(byTrigger["mouse-enter"].animation, { "animation-type": "push", direction: "up", duration: 400, easing: "linear" });
  assert.equal(byTrigger["mouse-enter"]["preserve-scroll"], true);
  assert.equal(byTrigger["mouse-leave"]["action-type"], "close-overlay");
  assert.equal(byTrigger["after-delay"].delay, 1500);
  assert.match(byTrigger["mouse-over"].destination, /^[0-9a-f-]{36}$/);
  const manual = byName("Button").interactions[0];
  assert.equal(manual["overlay-pos-type"], "manual");
  assert.deepEqual(manual["overlay-position"], { x: 20, y: 40 });
  assert.match(manual["position-relative-to"], /^[0-9a-f-]{36}$/, "a manual position is relative to the element itself");
});

test("interaction mistakes name the attribute and the fix", async () => {
  const { result } = await decoded(`<body class="bg-[#ffffff]">
  <div data-name="A" class="left-[0px] top-[0px] w-[10px] h-[10px]" data-click="Menu; delay: 2s"></div>
  <div data-name="B" class="left-[0px] top-[0px] w-[10px] h-[10px]" data-click="Menu; position: center"></div>
  <p data-name="C" class="left-[0px] top-[0px]" data-after-delay="Menu">Text</p>
  <div data-name="D" class="left-[0px] top-[0px] w-[10px] h-[10px]" data-click="overlay:Home"></div>
  <div data-name="E" class="left-[0px] top-[0px] w-[10px] h-[10px]" data-click="overlay:Menu; animation: push left 300ms"></div>
  <div data-name="F" class="left-[0px] top-[0px] w-[10px] h-[10px]" data-hover="overlay:Nowhere"></div>
</body>`);
  const found = errors(result).map((issue) => `${issue.line} ${issue.code} ${issue.message}`);
  const expect = [
    /^9 invalid_interaction data-click="Menu; delay: 2s": delay works with data-after-delay only/,
    /^10 invalid_interaction .*position works with overlay: and toggle-overlay: only/,
    /^11 invalid_interaction data-after-delay works on a board/,
    /^12 invalid_interaction .*an overlay opens another page/,
    /^13 invalid_interaction .*push works only when going to a page/,
    /^14 unknown_link_target data-hover="overlay:Nowhere": no page pages\/Nowhere\.html/,
  ];
  for (const pattern of expect) assert.ok(found.some((message) => pattern.test(message)), `${pattern}\n${found.join("\n")}`);
});

test("relative-to works on page elements only", async () => {
  const result = await checkPackageFiles(files('<body class="bg-[#ffffff]"></body>', {
    "components/Chip.html": '<sp-component name="Chip">\n  <div class="w-[40px] h-[20px]" data-click="overlay:Menu; relative-to: self"></div>\n</sp-component>\n',
  }));
  const issue = errors(result).find((entry) => entry.file === "components/Chip.html");
  assert.match(issue.message, /relative-to works on page elements/);
});

test("interactions write back one attribute per trigger and drop fields of an earlier type", async () => {
  const home = `<body class="bg-[#ffffff]">
  <div data-name="Card" data-click="https://example.com" data-press="toggle-overlay:Menu" data-hover="overlay:Menu; position: top-right; close-outside; backdrop; animation: slide in left 200ms ease-out offset" data-mouse-enter="Menu; preserve-scroll; animation: push up 400ms linear" data-mouse-leave="close-overlay:Menu" data-after-delay="Menu; delay: 1500ms" class="w-[200px] h-[100px]"></div>
</body>`;
  const snapshot = await loadFiles(files(home));
  assert.ok(encodePackage(snapshot).files.get("pages/Home.html").includes(home.split("\n")[1]));
  // The App keeps a delay after a trigger changes from after-delay to click.
  const screen = snapshot.entries[snapshot.manifest.entries.screens.find((entry) => snapshot.entries[entry].name === "Home")];
  const card = Object.values(screen.presentations[0].nodes).find((node) => node.name === "Card");
  card.interactions = [{ ...card.interactions.find((entry) => entry["event-type"] === "after-delay"), "event-type": "click" }];
  assert.match(encodePackage(snapshot).files.get("pages/Home.html"), /data-click="Menu" class/);
});

test("an App save writes a second fill, a stroke list, a grid and a hover link", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-app-features-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "app.smallpen");
  await writePackage(path, {
    "tokens.css": TOKENS,
    "pages/Home.html": pageHtml(`<body class="bg-[#ffffff]">
  <div data-name="Box" class="left-[0px] top-[0px] w-[300px] h-[200px] bg-[#2563eb]">
    <div data-name="One" class="left-[0px] top-[0px] w-[20px] h-[20px] bg-[#ff0000]"></div>
    <div data-name="Two" class="left-[30px] top-[0px] w-[20px] h-[20px] bg-[#00ff00]"></div>
  </div>
</body>`, { title: "Home" }),
    "pages/Menu.html": MENU,
  }, { packageId: "pkg_features" });
  const before = await openPackage(path);
  const screen = before.entries[before.manifest.entries.screens.find((entry) => before.entries[entry].name === "Home")];
  const presentation = screen.presentations[0];
  const nodes = Object.values(presentation.nodes);
  const box = nodes.find((node) => node.name === "Box");
  const [one, two] = ["One", "Two"].map((name) => nodes.find((node) => node.name === name));
  const menuRoot = before.entries[before.manifest.entries.screens.find((entry) => before.entries[entry].name === "Menu")].presentations[0];
  const destination = Object.entries(before.runtime.reverseNodes).find(([, value]) => value.nodeId === menuRoot.rootId)[0];
  const cell = (id, row, column, shapes) => ({ id, row, column, "row-span": 1, "column-span": 1, position: "auto", shapes });
  await applyOperationBatch(path, {
    baseRevision: before.revision,
    batchId: "app-features",
    operations: [{
      changes: {
        fills: [{ color: "#ffffff", opacity: 0.5, type: "solid" }, { color: "#2563eb", type: "solid" }],
        strokes: [{ alignment: "inner", color: "#e5e7eb", type: "solid", width: 1 }, { alignment: "outer", color: "#111111", style: "dotted", type: "solid", width: 3 }],
        layout: "grid",
        "layout-grid-dir": "row",
        "layout-grid-columns": [{ type: "flex", value: 1 }, { type: "flex", value: 1 }],
        "layout-grid-rows": [{ type: "auto" }],
        "layout-grid-cells": {
          // As the App does: the top layer (Two, written last) takes the first cell.
          "0b3e6e5e-1c2d-4e5f-8a9b-0c1d2e3f4a01": cell("0b3e6e5e-1c2d-4e5f-8a9b-0c1d2e3f4a01", 1, 1, [two.id]),
          "0b3e6e5e-1c2d-4e5f-8a9b-0c1d2e3f4a02": cell("0b3e6e5e-1c2d-4e5f-8a9b-0c1d2e3f4a02", 1, 2, [one.id]),
        },
        interactions: [{
          "action-type": "open-overlay", "event-type": "mouse-over", destination,
          "overlay-pos-type": "center", "overlay-position": { x: 0, y: 0 }, "close-click-outside": false, "background-overlay": false,
          delay: 600,
        }],
      },
      nodeId: box.id,
      presentationId: presentation.id,
      screenId: screen.id,
      type: "update-presentation-node",
    }],
  });
  const page = await readFile(join(path, "pages", "Home.html"), "utf8");
  assert.match(page, /data-hover="overlay:Menu"/);
  // The App's grid aligns to the start, which CSS has to be told.
  assert.match(page, /class="grid grid-cols-2 items-start justify-items-start w-\[300px\] h-\[200px\] bg-\[#ffffff80,#2563eb\] border-\[1px_#e5e7eb,3px_dotted_#111111_outside\]"/);
  assert.doesNotMatch(page, /col-start/, "children in reading order need no lines");
  assert.ok(page.indexOf('data-name="Two"') < page.indexOf('data-name="One"'), "the file lists the grid in reading order");
  const reread = await openPackage(path);
  const rereadBox = Object.values(reread.entries[reread.manifest.entries.screens.find((entry) => reread.entries[entry].name === "Home")].presentations[0].nodes).find((node) => node.name === "Box");
  assert.equal(rereadBox.fills.length, 2);
  assert.equal(rereadBox.layout, "grid");
});

test("the App's grid toggle sets the board's child order, which is a reorder", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-grid-order-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "order.smallpen");
  await writePackage(path, {
    "pages/Home.html": pageHtml(`<body class="bg-[#ffffff]">
  <div data-name="Box" class="left-[0px] top-[0px] w-[300px] h-[200px]">
    <div data-name="One" class="left-[0px] top-[0px] w-[20px] h-[20px]"></div>
    <div data-name="Two" class="left-[30px] top-[0px] w-[20px] h-[20px]"></div>
  </div>
</body>`, { title: "Home" }),
  });
  const snapshot = await openPackage(path);
  const screen = snapshot.entries[snapshot.manifest.entries.screens[0]];
  const presentation = screen.presentations[0];
  const idOf = (name) => Object.values(presentation.nodes).find((node) => node.name === name).id;
  const runtimeOf = (nodeId) => snapshot.runtime.nodes[screen.id][presentation.id][nodeId];
  const batch = compilePenpotChanges(snapshot, {
    commitId: "grid-order",
    changes: [{
      id: runtimeOf(idOf("Box")),
      "page-id": snapshot.runtime.pages[screen.id][presentation.id],
      type: "mod-obj",
      operations: [{ attr: "shapes", type: "set", val: [runtimeOf(idOf("Two")), runtimeOf(idOf("One"))] }],
    }],
  });
  const reorder = batch.operations.find((operation) => operation.type === "reorder-presentation-children");
  assert.deepEqual(reorder.childIds, [idOf("Two"), idOf("One")]);
});

async function loadFiles(map) {
  const { loadPackageFromValues } = await import("@smallpen/core");
  const result = await decodePackageFiles(map);
  assert.deepEqual(errors(result), []);
  return loadPackageFromValues("memory://features.smallpen", result.values);
}

test("a mask's first child masks the rest and gives the group its box", async () => {
  const home = `<body class="bg-[#ffffff]">
  <div data-shape="mask" data-name="Avatar" class="left-[40px] top-[40px]">
    <div data-shape="ellipse" data-name="Circle" class="w-[64px] h-[64px] bg-[#000000]"></div>
    <div data-name="Photo" class="left-[-10px] top-[-10px] w-[100px] h-[100px] bg-[#ff0000]"></div>
  </div>
</body>`;
  const { result, byName } = await decoded(home);
  assert.deepEqual(errors(result), []);
  const avatar = byName("Avatar");
  assert.equal(avatar.type, "GROUP");
  assert.equal(avatar["masked-group"], true);
  assert.deepEqual([avatar.x, avatar.y, avatar.width, avatar.height], [40, 40, 64, 64]);
  assert.equal(avatar.children[0], byName("Circle").id, "the first child is the mask, the bottom layer");
  const page = encodePackage(await loadFiles(files(home))).files.get("pages/Home.html");
  assert.ok(page.includes(home.split("\n").slice(1, -1).join("\n")), page);
});

test("mask mistakes name the fix", async () => {
  const codes = async (body, extra) => {
    const result = await decodePackageFiles(files(body, extra));
    return errors(result).map(({ code, message }) => [code, message]);
  };
  assert.deepEqual((await codes('<body><div data-name="M" data-shape="mask"></div></body>'))[0][0], "mask_empty");
  const moved = await codes('<body><div data-name="M" data-shape="mask"><div data-name="Shape" class="left-[5px] w-[10px] h-[10px]"></div></div></body>');
  assert.equal(moved[0][0], "mask_position");
  assert.match(moved[0][1], /Shape .*left-\[0px\] top-\[0px\]/);
  const sized = await codes('<body><div data-name="M" data-shape="mask" class="w-[20px] h-[10px]"><div data-name="Shape" class="w-[10px] h-[10px]"></div></div></body>');
  assert.deepEqual(sized.map(([code]) => code), ["mask_size"]);
  assert.match(sized[0][1], /10×10/);
  const component = await codes("<body></body>", {
    "components/Avatar.html": '<sp-component name="Avatar">\n  <div class="w-[64px] h-[64px]">\n    <div data-name="M" data-shape="mask"><div data-name="Shape" class="w-[10px] h-[10px]"></div></div>\n  </div>\n</sp-component>\n',
  });
  assert.ok(component.some(([code]) => code === "page_only_element"), JSON.stringify(component));
});

test("hidden keeps a stroke, a shadow layer or a blur without drawing it", async () => {
  const home = `<body class="bg-[#ffffff]">
  <div data-name="Box" class="w-[100px] h-[100px] border border-[#111111] border-hidden blur-[4px_hidden] backdrop-blur-[8px] shadow-[0_2px_8px_0_#00000033_hidden,inset_0_1px_0_0_#ffffff]"></div>
  <div data-name="Card" class="left-[200px] w-[100px] h-[100px] border-[1px_#111111_hidden,2px_#222222]"></div>
  <svg data-name="Line" class="top-[200px] w-[100px] h-[10px] stroke-[#111111] stroke-hidden">
    <path d="M0 5 L100 5"></path>
  </svg>
</body>`;
  const { result, byName } = await decoded(home);
  assert.deepEqual(errors(result), []);
  const box = byName("Box");
  assert.equal(box.strokes[0].hidden, true);
  assert.equal(box.blur.hidden, true);
  assert.equal(box.backgroundBlur.hidden, false);
  assert.deepEqual(box.shadow.map((layer) => layer.hidden === true), [true, false]);
  assert.deepEqual(byName("Card").strokes.map((stroke) => stroke.hidden === true), [true, false]);
  assert.equal(byName("Line").strokes[0].hidden, true);
  const page = encodePackage(await loadFiles(files(home))).files.get("pages/Home.html");
  assert.ok(page.includes(home.split("\n").slice(1, -1).join("\n")), page);

  const wrong = await decodePackageFiles(files('<body><div data-name="B" class="w-[10px] h-[10px] blur-[4px_off]"></div></body>'));
  assert.match(errors(wrong)[0].message, /blur-\[4px_hidden\]/);
});

test("a variant shows a stroke the shared element hides with border-shown", async () => {
  const component = `<sp-component name="Chip" props="State: idle | focus">
  <div class="w-[80px] h-[32px] bg-[#ffffff] border-[2px] border-[#2563eb] border-hidden"></div>
  <sp-variant when="State: focus" class="border-shown"></sp-variant>
</sp-component>
`;
  const { values } = await decodePackageFiles(files("<body></body>", { "components/Chip.html": component }));
  const set = values.get("components/Chip.html").componentSets[0];
  const hidden = set.variants.map((variant) => [Object.values(variant.selection).join(), variant.nodes[variant.rootId].strokes[0].hidden === true]);
  assert.deepEqual(hidden.sort(), [["focus", false], ["idle", true]]);
  const snapshot = await loadFiles(files("<body></body>", { "components/Chip.html": component }));
  const written = encodePackage(snapshot).files.get("components/Chip.html");
  assert.match(written, /border-hidden/);
  assert.match(written, /<sp-variant when="State: focus" class="border-shown">/);
});

test("the App's shadow edits, eye buttons, mask and unmask save to the file", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-app-effects-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "effects.smallpen");
  await writePackage(path, {
    "pages/Home.html": pageHtml(`<body class="bg-[#ffffff]">
  <div data-name="Box" class="w-[300px] h-[200px] bg-[#eeeeee] border border-[#111111] blur-[4px] shadow-[0_2px_8px_0_#00000033]"></div>
  <div data-shape="ellipse" data-name="A" class="left-[400px] w-[64px] h-[64px] bg-[#000000]"></div>
  <div data-name="B" class="left-[410px] top-[10px] w-[100px] h-[100px] bg-[#ff0000]"></div>
</body>`, { title: "Home" }),
  });
  const save = async (changesFor) => {
    const snapshot = await openPackage(path);
    const screen = snapshot.entries[snapshot.manifest.entries.screens[0]];
    const presentation = screen.presentations[0];
    const runtime = snapshot.runtime.nodes[screen.id][presentation.id];
    const idOf = (name) => runtime[Object.values(presentation.nodes).find((node) => node.name === name).id];
    const pageId = snapshot.runtime.pages[screen.id][presentation.id];
    const mod = (name, operations) => ({ id: idOf(name), "page-id": pageId, type: "mod-obj", operations });
    const batch = compilePenpotChanges(snapshot, { commitId: "app-effects", changes: changesFor({ idOf, mod, pageId, root: runtime[presentation.rootId] }) });
    await applyOperationBatch(path, { baseRevision: snapshot.revision, batchId: `app-${Math.random()}`, operations: batch.operations });
    return readFile(join(path, "pages", "Home.html"), "utf8");
  };
  const set = (attr, val) => ({ attr, type: "set", val });

  // The effects panel keeps its own shadow record; the eye buttons set hidden.
  let page = await save(({ mod }) => [mod("Box", [
    set("shadow", [{ id: "6b1c1f9e-0000-4000-8000-000000000001", style: "drop-shadow", hidden: true, blur: 10, "offset-x": 4, "offset-y": 6, spread: 0, color: { color: "#000000", opacity: 0.25 } }]),
    set("blur", { id: "6b1c1f9e-0000-4000-8000-000000000002", type: "layer-blur", value: 4, hidden: true }),
    set("strokes", [{ "stroke-color": "#111111", "stroke-opacity": 1, "stroke-style": "solid", "stroke-alignment": "inner", "stroke-width": 1, hidden: true }]),
  ])]);
  assert.match(page, /class="w-\[300px\] h-\[200px\] bg-\[#eeeeee\] border border-\[#111111\] border-hidden blur-\[4px_hidden\] shadow-\[4px_6px_10px_0_#00000040_hidden\]"/);

  // Ctrl+M: a new group around A and B, masked by A, as big as A.
  const groupId = "cccccccc-4444-4444-8444-444444444444";
  const box = { x: 400, y: 0, width: 64, height: 64, x1: 400, y1: 0, x2: 464, y2: 64 };
  page = await save(({ idOf, mod, pageId, root }) => [
    { id: groupId, obj: { height: 10, id: groupId, name: "Mask", "parent-id": root, "frame-id": root, shapes: [], type: "group", width: 10, x: 0, y: 0 }, "page-id": pageId, "parent-id": root, "frame-id": root, type: "add-obj" },
    { "page-id": pageId, "parent-id": groupId, shapes: [idOf("A"), idOf("B")], type: "mov-objects" },
    { id: groupId, "page-id": pageId, type: "mod-obj", operations: [
      set("masked-group", true), set("selrect", box),
      set("points", [{ x: 400, y: 0 }, { x: 464, y: 0 }, { x: 464, y: 64 }, { x: 400, y: 64 }]),
      set("x", 400), set("y", 0), set("width", 64), set("height", 64),
    ] },
  ]);
  assert.match(page, /<div data-shape="mask" data-name="Mask" class="left-\[400px\]">\n    <div data-shape="ellipse" data-name="A" class="w-\[64px\] h-\[64px\] bg-\[#000000\]"><\/div>\n    <div data-name="B" class="left-\[10px\] top-\[10px\]/);

  // Ctrl+Shift+M removes the flag; the group stays.
  page = await save(({ mod }) => [mod("Mask", [set("masked-group", null)])]);
  assert.match(page, /<div data-shape="group" data-name="Mask" class="left-\[400px\] w-\[64px\] h-\[64px\]">/);
});
