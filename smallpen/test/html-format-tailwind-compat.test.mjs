// Tailwind and CSS habits mean what they mean there. Tailwind's default
// scale is read as raw values (p-4 is p-[16px]); a package Token of the same
// name wins, as a theme value does in Tailwind.
import assert from "node:assert/strict";
import test from "node:test";

import { decodePackageFiles, encodePackage, loadPackageFromValues } from "@smallpen/core";
import { pageHtml } from "./helpers/named.mjs";

const INDEX = '<!doctype html>\n<html>\n<head>\n  <meta charset="utf-8">\n  <title>Compat</title>\n  <meta name="smallpen:package-id" content="pkg_compat">\n</head>\n<body></body>\n</html>\n';

const files = (home, tokens = ":root {\n}\n") => new Map(Object.entries({
  "index.html": INDEX,
  "tokens.css": tokens,
  "pages/Home.html": pageHtml(home, { title: "Home" }),
}));

const errors = (result) => result.issues.filter((issue) => issue.severity === "error");

async function decoded(home, tokens) {
  const result = await decodePackageFiles(files(home, tokens));
  const nodes = result.values.get("pages/Home")?.presentations[0].nodes ?? {};
  const byName = (name) => Object.values(nodes).find((node) => node.name === name);
  return { result, byName };
}

async function written(home, tokens) {
  const result = await decodePackageFiles(files(home, tokens));
  assert.deepEqual(errors(result), []);
  const snapshot = await loadPackageFromValues("memory://compat.smallpen", result.values);
  return encodePackage(snapshot).files.get("pages/Home.html");
}

test("the Tailwind spacing scale is n × 4px, a raw value", async () => {
  const { result, byName } = await decoded(`<body class="bg-[#ffffff]">
  <div data-name="Box" class="flex flex-row p-4 px-0.5 gap-2 left-4 top-px w-64 h-10">
    <div data-name="Square" class="size-6 bg-black"></div>
  </div>
  <div data-name="Wide" class="top-[100px] w-md h-2"></div>
</body>`);
  assert.deepEqual(errors(result), []);
  const box = byName("Box");
  assert.deepEqual(box["layout-padding"], { p1: 16, p2: 2, p3: 16, p4: 2 });
  assert.equal(box["layout-gap"]["column-gap"], 8);
  assert.equal(box.x, 16);
  assert.equal(box.y, 1);
  assert.equal(box.width, 256);
  assert.equal(box.height, 40);
  assert.equal(box.tokenBindings, undefined);
  assert.equal(byName("Square").width, 24);
  assert.equal(byName("Square").height, 24);
  assert.equal(byName("Wide").width, 448);
});

test("a package Token of the same name wins over the Tailwind default", async () => {
  const { result, byName } = await decoded(
    '<body class="bg-[#ffffff]"><div data-name="Box" class="flex p-4 w-[100px] h-[100px] rounded-lg"></div></body>',
    ":root {\n  --spacing-4: 20px;\n  --radius-lg: 10px;\n}\n",
  );
  assert.deepEqual(errors(result), []);
  assert.equal(byName("Box")["layout-padding"].p1, 20);
  assert.equal(byName("Box").cornerRadius, 10);
  assert.ok(byName("Box").tokenBindings.cornerRadius);
});

test("named Tailwind scales: radius, shadow, blur, weight, size, tracking, opacity, border, colors", async () => {
  const { result, byName } = await decoded(`<body class="bg-white">
  <div data-name="Card" class="w-[100px] h-[100px] rounded-lg shadow-md blur-sm opacity-50 border-2 border-black bg-white"></div>
  <div data-name="Plain" class="left-[200px] w-[10px] h-[10px] rounded shadow blur bg-transparent"></div>
  <p data-name="Label" class="top-[200px] font-bold text-sm tracking-wide text-white">Label</p>
</body>`);
  assert.deepEqual(errors(result), []);
  const card = byName("Card");
  assert.equal(card.cornerRadius, 8);
  assert.equal(card.shadow.length, 2);
  assert.equal(card.shadow[0].offsetY, 4);
  assert.equal(card.shadow[0].spread, -1);
  assert.equal(card.blur.value, 8);
  assert.equal(card.opacity, 0.5);
  assert.equal(card.strokes[0].width, 2);
  assert.equal(card.strokes[0].color, "#000000");
  const plain = byName("Plain");
  assert.equal(plain.cornerRadius, 4);
  assert.equal(plain.shadow.length, 2);
  assert.equal(plain.blur.value, 8);
  assert.deepEqual(plain.fills, []);
  const label = byName("Label");
  assert.equal(label.textStyle.fontWeight, 700);
  assert.equal(label.textStyle.fontSize, 14);
  assert.equal(label.textStyle.lineHeight, Math.round((20 / 14) * 10000) / 10000);
  assert.equal(label.textStyle.letterSpacing, 0.35);
  assert.equal(label.fills[0].color, "#ffffff");
});

test("line height: a number is a multiple, px is px, steps and names as in Tailwind", async () => {
  const { result, byName } = await decoded(`<body class="bg-white">
  <p data-name="Ratio" class="text-[16px] leading-[1.5]">A</p>
  <p data-name="Px" class="top-[40px] text-[13px] leading-[20px]">B</p>
  <p data-name="Step" class="top-[80px] text-[16px] leading-6">C</p>
  <p data-name="Name" class="top-[120px] text-[16px] leading-tight">D</p>
  <p data-name="Pair" class="top-[160px] text-sm/6">E</p>
  <p data-name="Order" class="top-[200px] leading-[30px] text-sm">F</p>
</body>`);
  assert.deepEqual(errors(result), []);
  assert.equal(byName("Ratio").textStyle.lineHeight, 1.5);
  assert.equal(byName("Px").textStyle.lineHeight, 1.5385);
  assert.equal(byName("Step").textStyle.lineHeight, 1.5);
  assert.equal(byName("Name").textStyle.lineHeight, 1.25);
  assert.equal(byName("Pair").textStyle.fontSize, 14);
  assert.equal(byName("Pair").textStyle.lineHeight, Math.round((24 / 14) * 10000) / 10000);
  // A leading class wins over the line height text-sm brings, in any order.
  assert.equal(byName("Order").textStyle.lineHeight, Math.round((30 / 14) * 10000) / 10000);
});

test("a line height only px explain is written back as px", async () => {
  const page = await written('<body class="bg-white"><p data-name="Px" class="text-[13px] leading-[20px]">B</p><p data-name="Ratio" class="top-[40px] text-[16px] leading-[1.5]">A</p></body>');
  assert.match(page, /text-\[13px\] leading-\[20px\]/);
  assert.match(page, /text-\[16px\] leading-\[1\.5\]/);
});

test("Tailwind classes are written back as the raw values they are", async () => {
  const page = await written('<body class="bg-white"><div data-name="Box" class="flex p-4 w-64 h-10 rounded-lg"></div></body>');
  assert.match(page, /p-\[16px\]/);
  assert.match(page, /w-\[256px\]/);
  assert.match(page, /rounded-\[8px\]/);
});

test("relative, block, inline-flex and absolute are accepted with their CSS meaning", async () => {
  const { result, byName } = await decoded(`<body class="bg-white">
  <div data-name="Frame" class="relative block w-[200px] h-[100px]">
    <div data-name="Dot" class="absolute left-[10px] top-[20px] w-[4px] h-[4px] bg-black"></div>
  </div>
  <div data-name="Row" class="inline-flex top-[120px] w-[200px] h-[40px]"></div>
</body>`);
  assert.deepEqual(errors(result), []);
  assert.equal(byName("Dot").x, 10);
  assert.equal(byName("Dot").y, 20);
  assert.equal(byName("Row").layout, "flex");
});

test("flex-1 and grow fill the parent's room along its direction", async () => {
  const { result, byName } = await decoded(`<body class="bg-white">
  <div data-name="Row" class="flex flex-row w-[300px] h-[40px]">
    <div data-name="Side" class="w-[100px] h-[40px] shrink-0"></div>
    <div data-name="Main" class="flex-1 h-[40px]"></div>
  </div>
  <div data-name="Column" class="flex flex-col top-[60px] w-[100px] h-[300px]">
    <div data-name="Body" class="grow w-[100px]"></div>
  </div>
</body>`);
  assert.deepEqual(errors(result), []);
  assert.equal(byName("Main")["layout-item-h-sizing"], "fill");
  assert.equal(byName("Main").width, 200);
  assert.equal(byName("Body")["layout-item-v-sizing"], "fill");
});

test("negative left, top and tracking; other minus forms are named", async () => {
  const { result, byName } = await decoded(`<body class="bg-white">
  <div data-name="Box" class="-left-2 -top-[3px] w-[10px] h-[10px]"></div>
  <p data-name="Tight" class="top-[40px] text-[20px] -tracking-wide">T</p>
</body>`);
  assert.deepEqual(errors(result), []);
  assert.equal(byName("Box").x, -8);
  assert.equal(byName("Box").y, -3);
  assert.equal(byName("Tight").textStyle.letterSpacing, -0.5);
  const bad = await decoded('<body class="bg-white"><div data-name="B" class="-p-2 w-[10px] h-[10px]"></div></body>');
  assert.match(errors(bad.result)[0].message, /-p-2: only left, top, right, bottom, inset and tracking take a minus/);
});

test("what Tailwind means but the App cannot hold is named", async () => {
  const { result } = await decoded(`<body class="bg-white">
  <div data-name="A" class="w-1/2 h-[10px] bg-blue-500"></div>
  <div data-name="B" class="w-auto h-[10px]"></div>
  <p data-name="C" class="font-mono">C</p>
</body>`);
  const messages = errors(result).map((issue) => issue.message).join("\n");
  assert.match(messages, /w-1\/2: the App has no percent sizes/);
  assert.match(messages, /bg-blue-500: Tailwind's color palette is not built in/);
  assert.match(messages, /w-auto depends on the parent in CSS; write w-fit .* or w-full/);
  assert.match(messages, /font-mono: Tailwind's font stacks are not built in/);
});

test("right, bottom and inset pin to the parent's far side, as absolute children do in CSS", async () => {
  const home = `<body class="bg-white">
  <div data-name="Card" class="w-[300px] h-[200px] bg-white">
    <div data-name="Close" class="right-[8px] top-[8px] w-[24px] h-[24px] bg-black"></div>
    <div data-name="Bar" class="left-[16px] right-[16px] bottom-0 h-[40px] bg-black"></div>
    <div data-name="Ring" class="-inset-1 border-2 border-black"></div>
  </div>
</body>`;
  const { result, byName } = await decoded(home);
  assert.deepEqual(errors(result), []);
  const close = byName("Close");
  assert.equal(close.x, 268);
  assert.equal(close["constraints-h"], "right");
  const bar = byName("Bar");
  assert.equal(bar.x, 16);
  assert.equal(bar.width, 268);
  assert.equal(bar.y, 160);
  assert.equal(bar["constraints-h"], "leftright");
  assert.equal(bar["constraints-v"], "bottom");
  const ring = byName("Ring");
  assert.deepEqual([ring.x, ring.y, ring.width, ring.height], [-4, -4, 308, 208]);
  assert.equal(ring["constraints-h"], "leftright");
  assert.equal(ring["constraints-v"], "topbottom");

  const page = await written(home);
  assert.match(page, /data-name="Close" class="right-\[8px\] top-\[8px\] w-\[24px\] h-\[24px\]/);
  assert.match(page, /data-name="Bar" class="inset-x-\[16px\] bottom-0 h-\[40px\]/);
  assert.match(page, /data-name="Ring" class="inset-\[-4px\]/);
  assert.doesNotMatch(page, /pin-/);
});

test("right with left and a width is named, as CSS would drop right", async () => {
  const { result } = await decoded('<body class="bg-white"><div data-name="A" class="w-[100px] h-[100px]"><div data-name="B" class="left-0 right-0 w-[10px] h-[10px]"></div></div></body>');
  assert.match(errors(result)[0].message, /left, right and w-\* together: CSS drops right/);
});

test("spaces fold as in HTML unless whitespace-pre-wrap keeps them; the writer keeps them", async () => {
  const home = `<body class="bg-white">
  <p data-name="Folded">  a   b
  c</p>
  <p data-name="Kept" class="top-[40px] whitespace-pre-wrap">    v  site<br>x</p>
  <p data-name="Lines" class="top-[80px] whitespace-pre-line">one
  two</p>
</body>`;
  const { result, byName } = await decoded(home);
  assert.deepEqual(errors(result), []);
  assert.equal(byName("Folded").text, "a b c");
  assert.equal(byName("Kept").text, "    v  site\nx");
  assert.equal(byName("Lines").text, "one\ntwo");
  const page = await written(home);
  assert.match(page, /data-name="Kept" class="top-\[40px\] whitespace-pre-wrap">    v  site<br>x<\/p>/);
  assert.match(page, /data-name="Folded">a b c<\/p>/);
});

test("what the App cannot draw of CSS text wrapping is named", async () => {
  const { result } = await decoded(`<body class="bg-white">
  <p data-name="A" class="w-[100px] truncate">A</p>
  <p data-name="B" class="top-[40px] w-[100px] whitespace-nowrap">B</p>
</body>`);
  const messages = errors(result).map((issue) => issue.message).join("\n");
  assert.match(messages, /truncate: the App has no text ellipsis/);
  assert.match(messages, /whitespace-nowrap with a width/);
});

test("CSS gradients: sides, angles and corners map to box points; the writer keeps the CSS form", async () => {
  const home = `<body class="bg-white">
  <div data-name="Down" class="w-[100px] h-[50px] bg-[linear-gradient(to_bottom,#000000,#ffffff)]"></div>
  <div data-name="Right" class="top-[60px] w-[100px] h-[50px] bg-[linear-gradient(90deg,#000000_0%,#ff0000,#ffffff_100%)]"></div>
  <div data-name="Corner" class="top-[120px] w-[200px] h-[100px] bg-[linear-gradient(to_bottom_right,#000000,#ffffff)]"></div>
  <div data-name="Glow" class="top-[240px] w-[100px] h-[100px] bg-[radial-gradient(#ffffff,#00000000)]"></div>
</body>`;
  const { result, byName } = await decoded(home);
  assert.deepEqual(errors(result), []);
  const down = byName("Down").fills[0];
  assert.deepEqual([down.startX, down.startY, down.endX, down.endY], [0.5, 0, 0.5, 1]);
  const right = byName("Right").fills[0];
  assert.deepEqual([right.startX, right.endX], [0, 1]);
  assert.deepEqual(right.stops.map((stop) => stop.offset), [0, 0.5, 1]);
  const corner = byName("Corner").fills[0];
  assert.equal(corner.cssDirection, undefined);
  // For 200×100 the gradient line runs from (60, -30) to (140, 130): the 0%
  // line passes through the top-left corner, the 100% line the bottom-right.
  assert.deepEqual([corner.startX, corner.startY, corner.endX, corner.endY], [0.3, -0.3, 0.7, 1.3]);
  const glow = byName("Glow").fills[0];
  assert.equal(glow.type, "radial-gradient");
  assert.equal(glow.stops[1].opacity, 0);

  const page = await written(home);
  assert.match(page, /bg-\[linear-gradient\(to_bottom,#000000_0%,#ffffff_100%\)\]/);
  assert.match(page, /bg-\[linear-gradient\(to_right,#000000_0%,#ff0000_50%,#ffffff_100%\)\]/);
  assert.match(page, /bg-\[linear-gradient\(from_0\.3_-0\.3_to_0\.7_1\.3,#000000_0%,#ffffff_100%\)\]/);
  assert.match(page, /bg-\[radial-gradient\(#ffffff_0%,#00000000_100%\)\]/);
});

test("flex and grid stretch a child with no size across them, as CSS does", async () => {
  const home = `<body class="bg-white">
  <div data-name="Column" class="flex flex-col gap-2 w-[300px] h-[200px]">
    <p data-name="Title">Title</p>
    <div data-name="Rule" class="h-px bg-black"></div>
    <p data-name="Short" class="w-fit">Short</p>
    <div data-name="Centered" class="self-center w-[40px] h-[10px] bg-black"></div>
  </div>
  <div data-name="Row" class="flex flex-row top-[220px] w-[300px] h-[60px]">
    <div data-name="Cell" class="w-[40px] bg-black"></div>
    <p data-name="Label">Label</p>
  </div>
  <div data-name="Start" class="flex flex-col items-start top-[300px] w-[300px] h-[100px]">
    <p data-name="Plain">Plain</p>
  </div>
  <div data-name="Hug" class="flex flex-col top-[420px]">
    <p data-name="Inner">Inner</p>
  </div>
</body>`;
  const { result, byName } = await decoded(home);
  assert.deepEqual(errors(result), []);
  assert.equal(byName("Column")["layout-align-items"], "stretch");
  assert.equal(byName("Title")["layout-item-h-sizing"], "fill");
  assert.equal(byName("Title").growType, "auto-height");
  assert.equal(byName("Rule").width, 300);
  assert.equal(byName("Short").growType, "auto-width");
  assert.equal(byName("Centered").width, 40);
  assert.equal(byName("Cell")["layout-item-v-sizing"], "fill");
  assert.equal(byName("Cell").height, 60);
  assert.equal(byName("Label").growType, "auto-width");
  assert.equal(byName("Start")["layout-align-items"], "start");
  assert.equal(byName("Plain").growType, "auto-width");
  assert.equal(byName("Inner").growType, "auto-width");

  const page = await written(home);
  assert.match(page, /data-name="Column" class="flex flex-col gap-\[8px\] w-\[300px\] h-\[200px\]"/);
  // Stretching is the default there, so the writer leaves w-full out.
  assert.match(page, /<p>Title<\/p>/);
  assert.match(page, /<p class="w-fit">Short<\/p>/);
  assert.match(page, /data-name="Start" class="flex flex-col items-start/);
  const again = await written(page.slice(page.indexOf("<body"), page.indexOf("</html>")));
  assert.equal(again, page);
});

test("an App flex board with the App's default alignment is written items-start", async () => {
  const { result } = await decoded('<body class="bg-white"><div data-name="Box" class="flex flex-row items-start w-[100px] h-[100px]"><p data-name="A">A</p></div></body>');
  const values = result.values;
  const nodes = values.get("pages/Home").presentations[0].nodes;
  const box = Object.values(nodes).find((node) => node.name === "Box");
  delete box["layout-align-items"];
  const snapshot = await loadPackageFromValues("memory://compat.smallpen", values);
  const page = encodePackage(snapshot).files.get("pages/Home.html");
  assert.match(page, /class="flex flex-row items-start w-\[100px\] h-\[100px\]"/);
});

test("a raw value written in many places is one warning naming same-value Tokens", async () => {
  const rows = Array.from({ length: 4 }, (_, index) => `  <div data-name="Row ${index}" class="flex gap-2 top-[${index * 50}px] w-[100px] h-[40px]"></div>`).join("\n");
  const home = `<body class="bg-white">\n${rows}\n  <div data-name="Once" class="flex gap-[12px] top-[300px] w-[100px] h-[40px]"></div>\n  <div data-name="Other" class="flex gap-[8px] top-[400px] w-[100px] h-[40px]"></div>\n</body>`;
  const { result } = await decoded(home, ":root {\n  --spacing-row: 8px;\n}\n");
  const repeated = result.issues.filter((issue) => issue.code === "repeated_raw_value");
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].severity, "warning");
  assert.match(repeated[0].message, /^spacing 8px is written raw in 5 places \(1 file\); if they are one design decision, name it with a Token and use its class \(Tokens of this value: --spacing-row; use one only where it means the same\)/);
  assert.equal(result.issues.filter((issue) => issue.code === "literal_matches_token").length, 0);
});

test("<!-- smallpen-ignore --> mutes a warning on the next element and survives writing", async () => {
  const rows = Array.from({ length: 3 }, (_, index) => `  <!-- smallpen-ignore repeated_raw_value -->\n  <div data-name="Row ${index}" class="flex gap-2 top-[${index * 50}px] w-[100px] h-[40px]"></div>`).join("\n");
  const home = `<body class="bg-white">\n${rows}\n</body>`;
  const { result, byName } = await decoded(home);
  assert.equal(result.issues.filter((issue) => issue.code === "repeated_raw_value").length, 0);
  assert.deepEqual(byName("Row 0")["lint-ignore"], ["repeated_raw_value"]);
  const page = await written(home);
  assert.match(page, /  <!-- smallpen-ignore repeated_raw_value -->\n  <div data-name="Row 0"/);
});

test("a single text class beats the same field of a type Token, with a warning a comment mutes", async () => {
  const tokens = ':root {\n  --type-title: 400 22px/1.35 "Source Sans Pro";\n}\n';
  const home = `<body class="bg-white">
  <p data-name="Metric" class="leading-[30px] type-title">12.6%</p>
  <!-- smallpen-ignore typography_overridden -->
  <p data-name="Quiet" class="top-[60px] type-title leading-[30px]">7</p>
</body>`;
  const { result, byName } = await decoded(home, tokens);
  assert.deepEqual(errors(result), []);
  const warnings = result.issues.filter((issue) => issue.code === "typography_overridden");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /^line height \(leading-\*\) replaces type-title's; the rest still follows type-title/);
  assert.equal(byName("Metric").textStyle.lineHeight, Math.round((30 / 22) * 10000) / 10000);
  assert.equal(byName("Metric").textStyle.fontSize, 22);
  assert.ok(byName("Metric").tokenBindings.typography);
});

test("Token names from the App or an import keep their words: camelCase splits, a type word is not doubled", async () => {
  const { cssTokenName } = await import("../packages/core/src/html-format/tokens-codec.mjs");
  assert.equal(cssTokenName("space.sm", "spacing"), "spacing-sm");
  assert.equal(cssTokenName("color.accentSoft", "color"), "color-accent-soft");
  assert.equal(cssTokenName("type.vaultTitle", "typography"), "type-vault-title");
  assert.equal(cssTokenName("font-size.sm", "font-size"), "text-sm");
  assert.equal(cssTokenName("radius.control", "border-radius"), "radius-control");
  assert.equal(cssTokenName("core.color.Brand", "color"), "color-core-color-brand");
});
