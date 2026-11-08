// Writing that looks like HTML and Tailwind means what it means there, or
// check names the problem: found by blind trials where the file passed
// check but the drawing was not what was written.
import assert from "node:assert/strict";
import test from "node:test";

import { decodePackageFiles, encodePackage, findVariant, loadPackageFromValues, variantLabel } from "@smallpen/core";
import { pageHtml } from "./helpers/named.mjs";

const TOKENS = ":root {\n  --color-outline: #e5e7eb;\n  --border-thin: 1px;\n  --size-control: 44px;\n}\n";
const INDEX = '<!doctype html>\n<html>\n<head>\n  <meta charset="utf-8">\n  <title>Trial</title>\n  <meta name="smallpen:package-id" content="pkg_trial">\n</head>\n<body></body>\n</html>\n';

const files = (home, extra = {}) => new Map(Object.entries({
  "index.html": INDEX,
  "tokens.css": TOKENS,
  "pages/Home.html": pageHtml(home, { title: "Home" }),
  ...extra,
}));

const errors = (result) => result.issues.filter((issue) => issue.severity === "error");

async function decoded(home, extra) {
  const result = await decodePackageFiles(files(home, extra));
  const nodes = result.values.get("pages/Home").presentations[0].nodes;
  const byName = (name) => Object.values(nodes).find((node) => node.name === name);
  return { result, byName };
}

async function written(home, extra, path = "pages/Home.html") {
  const result = await decodePackageFiles(files(home, extra));
  assert.deepEqual(errors(result), []);
  const snapshot = await loadPackageFromValues("memory://trial.smallpen", result.values);
  return encodePackage(snapshot).files.get(path);
}

test("border-b alone draws the bottom only, as in CSS", async () => {
  const home = `<body class="bg-[#ffffff]">
  <div data-name="Bar" class="w-[200px] h-[40px] border-b-thin border-outline"></div>
  <div data-name="Rule" class="top-[50px] w-[200px] h-[40px] border-b border-[#111111]"></div>
  <div data-name="Open" class="top-[100px] w-[200px] h-[40px] border-[2px] border-t-0 border-[#111111]"></div>
</body>`;
  const { result, byName } = await decoded(home);
  assert.deepEqual(errors(result), []);
  assert.equal(byName("Bar").strokes[0].width, 0);
  assert.equal(byName("Bar").strokes[0].widthBottom, 1);
  assert.equal(byName("Rule").strokes[0].width, 0);
  assert.equal(byName("Rule").strokes[0].widthBottom, 1);
  assert.equal(byName("Open").strokes[0].width, 2);
  assert.equal(byName("Open").strokes[0].widthTop, 0);
  const page = await written(home);
  assert.ok(page.includes(home.split("\n").slice(1, -1).join("\n")), page);

  const scale = await decodePackageFiles(files('<body><div data-name="B" class="w-[10px] h-[10px] border-2 border-[#111111]"></div></body>'));
  assert.match(errors(scale)[0].message, /border-2: no Token --color-2 or --border-2; write border-\[2px\], or a Token: border-thin \(1px\)/);
});

const BUTTON = `<sp-component name="Button" props="Style: primary | ghost">
  <div data-name="Button" class="flex flex-row items-center px-[20px] w-fit h-control bg-[#4f46e5]">
    <p data-name="Label">Save</p>
  </div>
</sp-component>
`;

test("a copy without w- or h- is as big as its component", async () => {
  const home = `<body class="bg-[#ffffff]">
  <div data-name="Bar" class="flex flex-row gap-[8px] w-[400px]">
    <sp-use component="Button" data-name="Save"></sp-use>
    <sp-use component="Button" data-name="Short" class="h-fit"></sp-use>
    <sp-use component="Button" data-name="Tall" class="h-[60px]"></sp-use>
  </div>
</body>`;
  const extra = { "components/Button.html": BUTTON };
  const { result, byName } = await decoded(home, extra);
  assert.deepEqual(errors(result), []);
  const save = byName("Save");
  assert.equal(save["layout-item-v-sizing"], "fix");
  assert.equal(save.height, 44);
  assert.ok(save.tokenBindings?.height, "the copy keeps the component's size Token");
  assert.equal(save["layout-item-h-sizing"], "auto");
  assert.equal(byName("Short")["layout-item-v-sizing"], "auto");
  assert.equal(byName("Tall").height, 60);
  const page = await written(home, extra);
  assert.ok(page.includes(home.split("\n").slice(1, -1).join("\n")), page);
});

const STATUS = `<sp-component name="Habit" props="Status: todo | done | skipped">
  <div class="flex flex-row w-[240px] h-[48px] bg-[#ffffff]">
    <p data-name="Status" data-text="not-done" class="text-[#6b7280]"></p>
  </div>
  <sp-variant when="Status: done">
    <p data-name="Status" data-text="done" class="text-[#166534]"></p>
  </sp-variant>
  <sp-variant when="Status: skipped">
    <p data-name="Status">Skipped</p>
  </sp-variant>
</sp-component>
`;
const STRINGS = ":root {\n  --string-not-done: \"Not done\";\n  --string-done: \"Done\";\n}\n";

test("a variant changes a text's words or its string Token", async () => {
  const extra = { "components/Habit.html": STATUS };
  const tokens = TOKENS.replace("}\n", "") + STRINGS.replace(":root {\n", "");
  const map = files("<body></body>", extra);
  map.set("tokens.css", tokens);
  const { values, issues } = await decodePackageFiles(map);
  assert.deepEqual(issues.filter((issue) => issue.severity === "error"), []);
  const set = values.get("components/Habit.html").componentSets[0];
  const status = Object.fromEntries(set.variants.map((variant) => {
    const node = Object.values(variant.nodes).find((entry) => entry.name === "Status");
    return [Object.values(variant.selection)[0], [node.text, Boolean(node.tokenBindings?.text)]];
  }));
  assert.deepEqual(status, { todo: ["Not done", true], done: ["Done", true], skipped: ["Skipped", false] });
  const snapshot = await loadPackageFromValues("memory://trial.smallpen", values);
  const component = encodePackage(snapshot).files.get("components/Habit.html");
  assert.equal(component, STATUS);
});

test("a variant names what it cannot change instead of dropping it", async () => {
  const component = `<sp-component name="Tab" props="State: idle | active">
  <div data-name="Tab" class="w-[80px] h-[32px] bg-[#ffffff]">
    <p data-name="Label">Tab</p>
  </div>
  <sp-variant when="State: active">
    <p data-name="Label" data-click="back" data-visible="on">Tab</p>
  </sp-variant>
</sp-component>
`;
  const { issues } = await decodePackageFiles(files("<body></body>", { "components/Tab.html": component }));
  const messages = issues.filter((issue) => issue.code === "override_not_allowed").map((issue) => issue.message);
  assert.equal(messages.length, 2, JSON.stringify(issues));
  assert.match(messages.join("\n"), /cannot change data-click of Label; put data-click on the shared element/);
  assert.match(messages.join("\n"), /cannot change data-visible of Label; hide or show the part with hidden \/ shown/);
});

test("fill on a hugging parent's cross axis works as in the App; every child filling is named", async () => {
  const card = (name, extra = "") => `<div data-name="${name}" class="flex flex-col w-full ${extra} bg-[#ffffff]"><p>${name}</p></div>`;
  const ok = await decoded(`<body class="bg-[#ffffff]">
  <div data-name="Row" class="flex flex-row gap-[8px] w-[400px]">
    <div data-name="Tall" class="w-[100px] h-[80px] bg-[#eeeeee]"></div>
    <div data-name="Side" class="w-[100px] h-full bg-[#dddddd]"></div>
  </div>
  <div data-name="Cards" class="grid grid-cols-2 gap-[8px] top-[100px] w-[400px]">
    ${card("A", "h-full")}
    ${card("B", "h-[120px]")}
  </div>
</body>`);
  assert.deepEqual(errors(ok.result), []);
  assert.equal(ok.byName("Side")["layout-item-v-sizing"], "fill");

  const allFill = await decodePackageFiles(files(`<body class="bg-[#ffffff]">
  <div data-name="Cards" class="grid grid-cols-2 gap-[8px] w-[400px]">
    ${card("A", "h-full")}
    ${card("B", "h-full")}
  </div>
</body>`));
  assert.match(errors(allFill)[0].message, /Every child has h-full in a grid that hugs its height.*grid-rows-\[160px_160px\]/);

  const sized = await decodePackageFiles(files(`<body class="bg-[#ffffff]">
  <div data-name="Cards" class="grid grid-cols-2 grid-rows-[160px] gap-[8px] w-[400px]">
    ${card("A", "h-full")}
    ${card("B", "h-full")}
  </div>
</body>`));
  assert.deepEqual(errors(sized), []);

  const mainAxis = await decodePackageFiles(files(`<body class="bg-[#ffffff]">
  <div data-name="Row" class="flex flex-row w-fit h-[40px]">
    <div data-name="A" class="w-full h-[40px] bg-[#eeeeee]"></div>
    <div data-name="B" class="w-[40px] h-[40px] bg-[#eeeeee]"></div>
  </div>
</body>`));
  assert.match(errors(mainAxis)[0].message, /w-full inside a parent that hugs its width/);
});

test("items-stretch that would not resize a child is a warning", async () => {
  const { result } = await decoded(`<body class="bg-[#ffffff]">
  <div data-name="Cards" class="grid grid-cols-2 items-stretch gap-[8px] w-[400px]">
    <div data-name="A" class="w-full h-[80px] bg-[#eeeeee]"></div>
    <div data-name="B" class="w-full h-[120px] bg-[#eeeeee]"></div>
  </div>
</body>`);
  assert.deepEqual(errors(result), []);
  const warning = result.issues.find((issue) => issue.code === "stretch_not_in_app");
  assert.match(warning?.message ?? "", /items-stretch does not resize children in the App.*h-full/);
});

test("--variant takes the props a file writes, and labels read the same way", () => {
  const set = {
    name: "Button",
    axes: [
      { id: "style", name: "Style", domain: ["primary", "secondary"] },
      { id: "size", name: "Size", domain: ["sm", "md"] },
    ],
    variants: [["primary", "sm"], ["primary", "md"], ["secondary", "sm"], ["secondary", "md"]]
      .map(([style, size]) => ({ selection: { style, size } })),
  };
  const pick = (text) => variantLabel(set, findVariant(set, text));
  assert.equal(pick("Style: secondary; Size: md"), "Style: secondary; Size: md");
  assert.equal(pick("Style=secondary, Size=md"), "Style: secondary; Size: md");
  assert.equal(pick("Style: secondary Size: md"), "Style: secondary; Size: md");
  assert.equal(pick("secondary md"), "Style: secondary; Size: md");
  assert.throws(() => findVariant(set, "Style: huge"), /Button has no Style: huge/);
});

test("misspelled Tokens and classes name the nearest ones", async () => {
  const wrong = await decodePackageFiles(files(`<body class="bg-[#ffffff]">
  <div data-name="A" class="w-[10px] h-[10px] border-outlin"></div>
  <div data-name="B" class="w-[10px] h-[10px] bg-outline-glass"></div>
  <div data-name="C" class="flex flex-colum w-[10px] h-[10px]"></div>
  <div data-name="D" class="w-[10px] h-[10px] itemz-center"></div>
</body>`));
  const messages = errors(wrong).map((issue) => issue.message).join("\n");
  assert.match(messages, /border-outlin: no Token .*did you mean border-outline\?/);
  assert.match(messages, /bg-outline-glass: no Token .*Tokens like it: bg-outline/);
  assert.match(messages, /flex-colum is not a SmallPen class; did you mean flex-col\?/);
  assert.match(messages, /itemz-center is not a SmallPen class; did you mean items-center\?/);
});

test("a part named one level too high says how to nest it", async () => {
  const card = `<sp-component name="Card" props="State: todo | done">
  <div class="flex flex-col w-[200px] h-[80px] bg-[#ffffff]">
    <div data-name="Info" class="flex flex-col w-full h-fit">
      <p data-name="Title">Water</p>
    </div>
  </div>
  <sp-variant when="State: done">
    <p data-name="Title" class="text-[#166534]"></p>
  </sp-variant>
</sp-component>
`;
  const home = `<body class="bg-[#ffffff]">
  <sp-use component="Card" data-name="One">
    <p data-name="Title">Run</p>
  </sp-use>
</body>`;
  const { issues } = await decodePackageFiles(files(home, { "components/Card.html": card }));
  const messages = issues.filter((issue) => issue.code === "unknown_part").map((issue) => issue.message);
  assert.equal(messages.length, 2, JSON.stringify(issues));
  for (const message of messages) assert.match(message, /it is inside Info, so nest it the same way: <div data-name="Info"><… data-name="Title"><\/div>/);
});

test("a mobile page links to a page that only has a desktop version", async () => {
  const result = await decodePackageFiles(new Map(Object.entries({
    "index.html": INDEX,
    "tokens.css": TOKENS,
    "pages/Home.mobile.html": pageHtml('<body class="bg-[#ffffff]">\n  <p data-name="Go" data-click="Detail">Go</p>\n</body>', { title: "Home" }),
    "pages/Detail.html": pageHtml('<body class="bg-[#ffffff]"></body>', { title: "Detail" }),
  })));
  assert.deepEqual(errors(result), []);
});

test("a literal that copies a colour or a scale step names the Token; sizes, white and black do not", async () => {
  const tokens = ":root {\n  --color-brand: #4f46e5;\n  --color-on-brand: #ffffff;\n  --spacing-4: 16px;\n  --size-card: 120px;\n}\n";
  const map = files(`<body class="bg-[#ffffff]">
  <div data-name="A" class="flex flex-col gap-[16px] p-[16px] w-[120px] h-[120px] bg-[#4f46e5]"></div>
</body>`);
  map.set("tokens.css", tokens);
  const { issues } = await decodePackageFiles(map);
  const notes = issues.filter((issue) => issue.code === "literal_matches_token").map((issue) => issue.message);
  assert.deepEqual(notes.sort(), [
    "bg-[#4f46e5] is the value of --color-brand; bg-brand follows the Token when it changes",
    "gap-[16px] is the value of --spacing-4; gap-4 follows the Token when it changes",
    "p-[16px] is the value of --spacing-4; p-4 follows the Token when it changes",
  ]);
  assert.ok(issues.every((issue) => issue.severity === "warning"));
});

test("rules and overrides that find a text by its words, and rules that change only hidden parts, are named", async () => {
  const badge = `<sp-component name="Badge" props="Tone: neutral | success">
  <div class="w-[80px] h-[24px] bg-[#eeeeee]">
    <p class="left-[4px] top-[2px]">Pending</p>
    <div data-name="Dot" class="hidden left-[60px] top-[8px] w-[8px] h-[8px] bg-[#999999]"></div>
  </div>
  <sp-variant when="Tone: success">
    <p data-name="Pending" class="text-[#166534]"></p>
    <div data-name="Dot" class="bg-[#16a34a]"></div>
  </sp-variant>
</sp-component>
`;
  const home = `<body class="bg-[#ffffff]">
  <sp-use component="Badge" data-name="One">
    <p data-name="Pending">Waiting</p>
  </sp-use>
</body>`;
  const { issues } = await decodePackageFiles(files(home, { "components/Badge.html": badge }));
  const by = (code) => issues.filter((issue) => issue.code === code).map((issue) => issue.message);
  assert.equal(by("part_named_by_text").length, 2, JSON.stringify(issues));
  assert.match(by("part_named_by_text").join("\n"), /Pending is found by its words; give that <p> data-name="Pending"/);
  assert.match(by("part_named_by_text").join("\n"), /Badge's part Pending is found by its words/);
  assert.match(by("rule_has_no_effect")[0], /Badge: 1 rule part changes a part hidden in every variant it applies to.*Dot \(line 8\)/);
});

test("a duplicate component says where the other one is, and a broken quote is reported once", async () => {
  const one = '<sp-component name="Tag">\n  <div class="w-[10px] h-[10px] bg-[#000000]"></div>\n</sp-component>\n';
  const duplicate = await decodePackageFiles(files("<body></body>", { "components/A.html": one, "components/B.html": one }));
  assert.match(errors(duplicate)[0].message, /Component Tag is defined twice; the other one is in components\/A\.html/);
  const broken = await decodePackageFiles(files('<body class="bg-[#ffffff]">\n  <div data-name="Box class="left-[10px] top-[10px] w-[10px] h-[10px]"></div>\n</body>'));
  const messages = errors(broken).map((issue) => issue.message);
  assert.match(messages.join("\n"), /data-name="Box is missing its closing quote, so class= became part of its value/);
  assert.ok(!messages.some((message) => /does not take|Unexpected character/.test(message)), messages.join("\n"));
});

test("a very large asset is a warning", async () => {
  const map = files("<body></body>");
  map.set("assets/fonts/Big.ttf", new Uint8Array(11 * 1024 * 1024));
  map.set("tokens.css", '@font-face {\n  font-family: "Big";\n  src: url(assets/fonts/Big.ttf);\n}\n' + TOKENS);
  const { issues } = await decodePackageFiles(map);
  const large = issues.find((issue) => issue.code === "large_asset");
  assert.match(large?.message ?? JSON.stringify(issues), /assets\/fonts\/Big\.ttf is 11 MB.*font subset/);
});

test("rounded-full is a pill as in Tailwind and writes back the same", async () => {
  const home = `<body class="bg-[#ffffff]">
  <div data-name="Pill" class="w-[80px] h-[24px] bg-[#eeeeee] rounded-full"></div>
</body>`;
  const { result, byName } = await decoded(home);
  assert.deepEqual(errors(result), []);
  assert.equal(byName("Pill").cornerRadius, 9999);
  const page = await written(home);
  assert.ok(page.includes('class="w-[80px] h-[24px] bg-[#eeeeee] rounded-full"'), page);
});

test("relative-to on a copy's part counts from the copy, names it, and writes back", async () => {
  const bar = `<sp-component name="Bar">
  <div class="flex flex-row w-[400px] h-[48px] bg-[#ffffff]">
    <div data-name="Menu" class="w-[24px] h-[24px] bg-[#eeeeee]"></div>
  </div>
</sp-component>
`;
  const menu = pageHtml('<body class="w-[200px] h-[120px] bg-[#ffffff]"></body>', { title: "Menu" });
  const home = `<body class="bg-[#ffffff]">
  <sp-use component="Bar" data-name="Top">
    <div data-name="Menu" data-hover="overlay:Menu; position: bottom-right; relative-to: Top"></div>
  </sp-use>
  <sp-use component="Bar" data-name="Second" class="top-[60px]">
    <div data-name="Menu" data-click="overlay:Menu; position: manual 10px 20px"></div>
  </sp-use>
</body>`;
  const extra = { "components/Bar.html": bar, "pages/Menu.html": menu };
  const { result } = await decoded(home, extra);
  assert.deepEqual(errors(result), []);
  const page = await written(home, extra);
  assert.ok(page.includes('data-hover="overlay:Menu; position: bottom-right; relative-to: Top"') || page.includes('data-hover="overlay:Menu; position: bottom-right; relative-to: self"'), page);
  assert.ok(page.includes('data-click="overlay:Menu; position: manual 10px 20px"'), page);
  const wrong = await decodePackageFiles(files(home.replace("relative-to: Top", "relative-to: Nowhere"), extra));
  assert.match(errors(wrong)[0].message, /relative-to names Nowhere, which is not a board or copy around this element; use self, page or one of Top/);
});

test("Tailwind's number scale is explained with the nearest Tokens", async () => {
  const map = files('<body><div data-name="A" class="flex flex-col px-5 w-[10px] h-[10px]"></div></body>');
  map.set("tokens.css", ":root {\n  --spacing-4: 16px;\n  --spacing-6: 24px;\n  --spacing-12: 48px;\n}\n");
  const message = errors(await decodePackageFiles(map))[0].message;
  assert.match(message, /px-5: no Token --spacing-5; in Tailwind px-5 is 20px: write px-\[20px\], or a Token: px-4 \(16px\), px-6 \(24px\)/);
});
