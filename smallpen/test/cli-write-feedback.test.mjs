import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { findElement } from "@smallpen/core";
import { openPackage } from "@smallpen/local-package";

// Regressions from an agent maintaining a 36-page package through the
// name-based writes: each write did something other than what it said.
const cli = new URL("../apps/cli/bin/smallpen.mjs", import.meta.url);

async function run(args, expected = 0) {
  const child = spawn(process.execPath, [cli.pathname, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, expected, stdout || stderr);
  return JSON.parse(stdout);
}

async function app() {
  const root = await mkdtemp(join(tmpdir(), "smallpen-feedback-"));
  const path = (await run(["project", "init", join(root, "demo"), "--json"])).packages.package.path;
  const file = async (name, value) => { const at = join(root, name); await writeFile(at, JSON.stringify(value)); return at; };
  return { root, path, file };
}

async function item(path, file) {
  await run(["token", "set", path, "--intent", await file("t.json", { tokens: [
    { name: "flag.desktop", type: "boolean", value: true },
    { name: "color.line", type: "color", value: "#cccccc" },
  ] }), "--json"]);
  await run(["component", "define", path, "--intent", await file("icon.json", { name: "Icon", base: { width: 16, height: 16, fill: "#333333" } }), "--json"]);
  await run(["component", "define", path, "--intent", await file("item.json", {
    name: "Resource item", properties: { State: ["default", "hover"], Mode: ["browse", "edit"] },
    base: { layout: "row", padding: 8, stroke: { color: "{color.line}", width: 1 }, children: [
      { name: "Label", text: "Item" },
      { name: "More", use: "Icon", visible: "{flag.desktop}" },
    ] },
  }), "--json"]);
}

const variantsOf = async (path, name) =>
  [...(await openPackage(path)).domain.componentSets.values()].find((set) => set.name === name).variants;
const named = (variant, name) => Object.values(variant.nodes).find((node) => node.name === name);

async function packageBytes(path) {
  const files = (await readdir(path, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
  return Object.fromEntries(await Promise.all(files.map(async (entry) => {
    const at = join(entry.parentPath, entry.name);
    return [at, (await readFile(at)).toString("base64")];
  })));
}

test("invalid layout input fails explicitly and leaves all package files unchanged", async (context) => {
  const { root, path, file } = await app();
  context.after(() => rm(root, { recursive: true, force: true }));
  await run(["page", "draw", path, "--intent", await file("page.json", {
    page: "Actions", layout: "row", align: "center", justify: "center", children: [{ name: "Label", text: "Save" }],
  }), "--json"]);
  const before = await packageBytes(path);
  for (const [args, code, field] of [
    [["--set", "align=middle"], "invalid_alignment", "align"],
    [["--element", "Label", "--set", "align=center"], "inapplicable_field", "align"],
    [["--set", "justify=center", "--set", "justify=end"], "conflicting_set_field", "justify"],
  ]) {
    const reply = await run(["page", "set", path, "--page", "Actions", ...args, "--json"], 1);
    assert.equal(reply.error.code, code);
    assert.equal(reply.error.details.field, field);
    assert.equal(reply.error.writeState, "not-applied");
    assert.deepEqual(await packageBytes(path), before);
  }
});

test("unsupported children fail before page or component files can be written", async (context) => {
  const { root, path, file } = await app();
  context.after(() => rm(root, { recursive: true, force: true }));
  await run(["component", "define", path, "--intent", await file("action.json", {
    name: "Action", base: { layout: "row", children: [{ name: "Label", text: "Save" }] },
  }), "--json"]);
  const before = await packageBytes(path);
  for (const element of [{ name: "Copy", use: "Action" }, { name: "Label", text: "Save" }]) {
    const invalid = { ...element, children: [{ name: "Missing", text: "Do not drop this content" }] };
    for (const [command, intent] of [
      [["page", "draw"], { page: "Invalid", children: [invalid] }],
      [["component", "define"], { name: "Invalid", base: { children: [invalid] } }],
    ]) {
      const reply = await run([...command, path, "--intent", await file("invalid.json", intent), "--json"], 1);
      assert.equal(reply.error.code, "inapplicable_field");
      assert.equal(reply.error.details.field, "children");
      assert.equal(reply.error.writeState, "not-applied");
      assert.deepEqual(await packageBytes(path), before);
    }
  }
});

test("a repeated value reports zero changed files in previews, compact and full receipts", async (context) => {
  const { root, path, file } = await app();
  context.after(() => rm(root, { recursive: true, force: true }));
  await run(["page", "draw", path, "--intent", await file("page.json", {
    page: "Actions", layout: "row", justify: "center", children: [{ name: "Label", text: "Save" }],
  }), "--json"]);
  const before = await packageBytes(path);
  for (const flags of [[], ["--dry-run"], ["--diff"], ["--full", "--stdout"]]) {
    const reply = await run(["page", "set", path, "--page", "Actions", "--set", "justify=center", "--set", 'justify="center"', ...flags, "--json"]);
    assert.equal(reply.changed, false);
    assert.deepEqual(reply.changedFiles, []);
    assert.equal(reply.noChange.code, "no_change");
    if (!flags.includes("--full")) {
      assert.match(reply.summary, /No changes.*0 changed file\(s\)/);
    } else assert.deepEqual(reply.inverseBatch.operations, []);
    assert.deepEqual(await packageBytes(path), before);
  }
});

test("conflicting fields from an intent and --set are rejected before writing", async (context) => {
  const { root, path, file } = await app();
  context.after(() => rm(root, { recursive: true, force: true }));
  await run(["component", "define", path, "--intent", await file("component.json", {
    name: "Action", base: { layout: "row", width: 240, height: 48 },
  }), "--json"]);
  const before = await packageBytes(path);
  const intent = await file("set.json", { set: { justify: "center" } });
  const reply = await run(["component", "set", path, "--component", "Action", "--intent", intent, "--set", "justify=end", "--json"], 1);
  assert.equal(reply.error.code, "conflicting_set_field");
  assert.equal(reply.error.details.field, "justify");
  assert.equal(reply.error.writeState, "not-applied");
  assert.deepEqual(await packageBytes(path), before);
});

test("a field invalid in one page version rejects the whole --all edit", async (context) => {
  const { root, path, file } = await app();
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const [platform, target] of [
    ["desktop", { name: "Target", layout: "row", width: 120, height: 40 }],
    ["mobile", { name: "Target", text: "Save" }],
  ]) {
    await run(["page", "draw", path, "--intent", await file(`${platform}.json`, {
      page: "Actions", platform, children: [target],
    }), "--json"]);
  }
  const before = await packageBytes(path);
  const reply = await run(["page", "set", path, "--page", "Actions", "--element", "Target", "--all", "--set", "align=center", "--json"], 1);
  assert.equal(reply.error.code, "inapplicable_field");
  assert.equal(reply.error.writeState, "not-applied");
  assert.deepEqual(await packageBytes(path), before);
});

test("a value written over a copy's Token binding replaces the binding", async () => {
  const { path, file } = await app();
  await item(path, file);
  await run(["component", "set", path, "--component", "Resource item", "--element", "More", "--all", "--set", "visible=false", "--json"]);
  for (const variant of await variantsOf(path, "Resource item")) {
    const more = named(variant, "More");
    assert.equal(more.visible, false);
    assert.equal(more.tokenBindings?.visible, undefined, "the binding would show it again");
  }
  await run(["component", "set", path, "--component", "Resource item", "--variant", "State=hover, Mode=edit", "--element", "More", "--set", "visible={flag.desktop}", "--json"]);
  const hover = (await variantsOf(path, "Resource item")).find((variant) => ["hover", "edit"].every((value) => Object.values(variant.selection).includes(value)));
  assert.ok(named(hover, "More").tokenBindings.visible, "a Token becomes the binding again");
});

test("stroke=none removes the stroke, an alpha survives, and an unknown color is refused when written", async () => {
  const { path, file } = await app();
  await item(path, file);
  const root = async () => { const [variant] = await variantsOf(path, "Resource item"); return variant.nodes[variant.rootId]; };
  const set = (value, expected) => run(["component", "set", path, "--component", "Resource item", "--variant", "State=default, Mode=browse", "--set", value, "--json"], expected);
  for (const value of ["stroke=none", "stroke=null", "stroke=[]"]) {
    await set('stroke={"color":"#000000","width":1}');
    await set(value);
    assert.deepEqual((await root()).strokes, [], value);
    assert.equal((await root()).tokenBindings?.stroke, undefined);
  }
  await set('stroke={"color":"#FFFFFF00","width":1}');
  assert.deepEqual((({ color, opacity }) => ({ color, opacity }))((await root()).strokes[0]), { color: "#FFFFFF", opacity: 0 });
  assert.equal((await set('stroke={"width":0}', 1)).error.code, "invalid_stroke");
  assert.equal((await set("fill=hsl(0,0%,0%)", 1)).error.code, "invalid_color");
  await set("fill=none");
  assert.deepEqual((await root()).fills, []);
});

test("a --variant naming some properties names every variant that has them", async () => {
  const { path, file } = await app();
  await item(path, file);
  const refused = await run(["component", "set", path, "--component", "Resource item", "--variant", "State=default", "--element", "Label", "--set", "fontSize=18", "--json"], 1);
  assert.equal(refused.error.code, "ambiguous_target");
  assert.deepEqual(refused.error.details.variants, ["State=default, Mode=browse", "State=default, Mode=edit"]);
  await run(["component", "set", path, "--component", "Resource item", "--variant", "State=default", "--element", "Label", "--all", "--set", "fontSize=18", "--json"]);
  const sizes = (await variantsOf(path, "Resource item")).map((variant) => named(variant, "Label").textStyle?.fontSize);
  assert.deepEqual(sizes, [18, 18, undefined, undefined]);
  const deleting = await run(["component", "delete", path, "--component", "Resource item", "--variant", "State=default", "--json"], 1);
  assert.equal(deleting.error.code, "ambiguous_variant");
});

test("an element path picks the element directly inside the named parents", () => {
  const node = (id, name, children = []) => [id, { id, name, children }];
  const nodes = Object.fromEntries([
    node("root", "Page", ["main"]), node("main", "Main", ["content"]),
    node("content", "Content", ["heading", "section"]), node("heading", "Heading"),
    node("section", "Principles", ["inner"]), node("inner", "Heading"),
  ]);
  assert.equal(findElement(nodes, "root", "Main / Content / Heading", "Brand"), "heading");
  assert.equal(findElement(nodes, "root", "Content / Heading", "Brand"), "heading");
  assert.equal(findElement(nodes, "root", "Principles / Heading", "Brand"), "inner");
  assert.throws(() => findElement(nodes, "root", "Heading", "Brand"), (error) =>
    error.code === "ambiguous_element" && error.message.includes('"Content / Heading"') &&
    error.details.elements.join() === "Content / Heading,Principles / Heading");
});

test("validate reports a wrapping text narrower than one of its words", async () => {
  const { path, file } = await app();
  await run(["page", "draw", path, "--intent", await file("p.json", { page: "Narrow", children: [
    { name: "Box", layout: "column", width: 300, children: [
      { name: "Path", text: "packages/web/skills/frontend-design", width: 40 },
      { name: "Words", text: "short words wrap fine", width: 120 },
      { name: "CJK", text: "中文可以在任意字符之间换行", width: 40 },
    ] },
  ] }), "--json"]);
  const report = await run(["validate", path, "--page", "Narrow", "--json"]);
  const split = report.issues.filter((issue) => issue.code === "text_word_split");
  assert.deepEqual(split.map((issue) => issue.where), ["Box › Path"]);
  assert.equal(split[0].measured.text, "packages/");
});

test("a copy drawn again by name keeps its Token-bound and fill sizes", async () => {
  const { path, file } = await app();
  await run(["token", "set", path, "--intent", await file("t.json", { tokens: [{ name: "size.control", type: "sizing", value: 34 }] }), "--json"]);
  await run(["component", "define", path, "--intent", await file("b.json", { name: "Button", base: { layout: "row", padding: [2, 8], children: [{ name: "Label", text: "Go" }] } }), "--json"]);
  await run(["page", "draw", path, "--intent", await file("p1.json", { page: "Toolbar", children: [{ name: "Bar", layout: "row", width: 400, children: [
    { name: "Action", use: "Button", height: "{size.control}" }, { name: "Wide", use: "Button", width: "fill" },
  ] }] }), "--json"]);
  await run(["page", "draw", path, "--intent", await file("p2.json", { page: "Toolbar", into: "Bar", children: [
    { name: "Action", use: "Button" }, { name: "Wide", use: "Button" }, { name: "New", use: "Button" },
  ] }), "--json"]);
  const snapshot = await openPackage(path);
  const page = snapshot.entries[snapshot.manifest.entries.screens.find((entry) => snapshot.entries[entry].name === "Toolbar")];
  const nodes = Object.values(page.presentations[0].nodes);
  const action = nodes.find((node) => node.name === "Action");
  assert.equal(action.height, 34);
  assert.ok(action.tokenBindings.height);
  assert.equal(nodes.find((node) => node.name === "Wide")["layout-item-h-sizing"], "fill");
  assert.notEqual(nodes.find((node) => node.name === "New").height, 34);
});

// The App never keeps a child that fills a row which hugs it: it fixes the
// row when a child fills (fix-parent-sizing), and the child when the row
// starts to hug (fix-child-sizing). The CLI applies the same rules.
test("written sizes follow the App's rules for a row that hugs what a child fills", async () => {
  const { path, file } = await app();
  await run(["component", "define", path, "--intent", await file("plain.json", { name: "Plain", base: { layout: "row", padding: [8, 16], children: [{ name: "Label", text: "Go" }] } }), "--json"]);
  await run(["component", "define", path, "--intent", await file("filled.json", { name: "Filled", base: { layout: "row", padding: [8, 16], children: [{ name: "Label", text: "Go", width: "fill" }] } }), "--json"]);
  const sizing = async (name) => {
    const [variant] = await variantsOf(path, name);
    const label = named(variant, "Label");
    return [variant.nodes[variant.rootId]["layout-item-h-sizing"], label["layout-item-h-sizing"] === "fix" && label.growType === "auto-width" ? "hug" : label["layout-item-h-sizing"]];
  };
  assert.deepEqual(await sizing("Plain"), ["auto", "hug"], "a lone text in a hugging row hugs (auto width)");
  assert.deepEqual(await sizing("Filled"), ["fix", "fill"], "a row whose child fills is fixed");
  await run(["page", "draw", path, "--intent", await file("cards.json", { page: "Cards", children: [
    { name: "Card", layout: "row", width: 300, children: [{ name: "Body", text: "Hello there", width: "fill" }] },
  ] }), "--json"]);
  await run(["page", "set", path, "--page", "Cards", "--element", "Card", "--set", "width=hug", "--json"]);
  const snapshot = await openPackage(path);
  const page = snapshot.entries[snapshot.manifest.entries.screens.find((entry) => snapshot.entries[entry].name === "Cards")];
  const nodes = Object.values(page.presentations[0].nodes);
  const body = nodes.find((node) => node.name === "Body"), card = nodes.find((node) => node.name === "Card");
  assert.deepEqual([body["layout-item-h-sizing"], body.width], ["fix", 300], "the child keeps the width it filled");
  assert.deepEqual([card["layout-item-h-sizing"], card.width], ["auto", 300]);
  for (const name of ["Plain", "Filled"]) {
    const report = await run(["validate", path, "--component", name, "--json"]);
    assert.equal(report.issueCount, 0, name);
  }
});

// What the CLI sets is what the App can set: hug only on a row or column
// container (a text hugs by its grow type), min / max only on an axis that
// fills; anything else is refused with what to write instead.
test("only settings the App offers are written; the rest are refused with how to fix them", async () => {
  const { path, file } = await app();
  const page = async (name, children, expected = 0) =>
    run(["page", "draw", path, "--intent", await file(`${name}.json`, { page: name, children }), "--json"], expected);
  await page("Texts", [{ name: "Row", layout: "row", width: 300, children: [{ name: "One", text: "one" }, { name: "Two", text: "two" }] },
    { name: "Fixed", text: "fixed", width: 100, height: 40 }]);
  const snapshot = await openPackage(path);
  const texts = Object.values(snapshot.entries[snapshot.manifest.entries.screens.find((entry) => snapshot.entries[entry].name === "Texts")].presentations[0].nodes);
  const one = texts.find((node) => node.name === "One"), fixed = texts.find((node) => node.name === "Fixed");
  assert.deepEqual([one["layout-item-h-sizing"], one["layout-item-v-sizing"], one.growType], ["fix", "fix", "auto-width"], "a hugging text is the App's auto width text");
  assert.equal(fixed.growType, "fixed", "a fixed height is kept only by a fixed text");
  assert.equal((await page("Box", [{ name: "Box", width: "hug", height: 20 }], 1)).error.code, "invalid_size");
  assert.equal((await page("Tall", [{ name: "T", text: "x", height: 40 }], 1)).error.code, "invalid_size");
  assert.equal((await page("Limit", [{ name: "Row", layout: "row", width: 300, children: [{ name: "A", text: "a" }, { name: "B", text: "b", maxWidth: 240 }] }], 1)).error.code, "invalid_size_limit");
  await page("Limit", [{ name: "Row", layout: "row", width: 300, children: [{ name: "A", text: "a" }, { name: "B", text: "b", width: "fill", maxWidth: 240 }] }]);
  const set = (args, expected = 0) => run(["page", "set", path, "--page", "Limit", ...args, "--json"], expected);
  assert.equal((await set(["--element", "A", "--set", "maxWidth=100"], 1)).error.code, "invalid_size_limit");
  assert.equal((await set(["--element", "Row", "--set", "layout=none"], 1)).error.code, "invalid_size", "a hugging container needs a size without its layout");
  await set(["--element", "Row", "--set", "fill=#eeeeee"]);
  await run(["component", "define", path, "--intent", await file("icon.json", { name: "Icon", base: { width: 16, height: 16, fill: "#333333" } }), "--json"]);
  assert.equal((await page("Icons", [{ name: "Row", layout: "row", width: 300, children: [{ name: "I", use: "Icon", width: "hug" }] }], 1)).error.code, "invalid_size");
  await page("Icons", [{ name: "Row", layout: "row", width: 300, children: [{ name: "I", use: "Icon" }] }]);
  assert.equal((await run(["page", "set", path, "--page", "Icons", "--element", "I", "--set", "width=hug", "--json"], 1)).error.code, "invalid_size");
});

test("validate reports stored sizes the App cannot set, and the fix it names clears them", async () => {
  const { path, file } = await app();
  await run(["component", "define", path, "--intent", await file("b.json", { name: "Button", base: { layout: "row", children: [{ name: "Label", text: "Go" }] } }), "--json"]);
  // A package written before these rules: the label fills a hugging button.
  const at = join(path, "components", "components.json");
  const stored = JSON.parse(await readFile(at, "utf8"));
  const label = Object.values(stored.componentSets[0].variants[0].nodes).find((node) => node.name === "Label");
  Object.assign(label, { "layout-item-h-sizing": "fill", growType: "auto-height" });
  await writeFile(at, JSON.stringify(stored));
  const report = await run(["validate", path, "--component", "Button", "--json", "--stdout"]);
  const codes = report.issues.map((issue) => `${issue.code} ${issue.where}`);
  assert.ok(codes.includes("layout_not_in_app Button"), codes.join("; "));
  await run(["component", "set", path, "--component", "Button", "--element", "Label", "--set", "width=hug", "--json"]);
  assert.equal((await run(["validate", path, "--component", "Button", "--json", "--stdout"])).issueCount, 0);
});

// A component may hide an element its copies show: the element's settings
// still count, and a size limit is removed with null.
test("validate checks what a copy shows of its component, and null removes a size limit", async () => {
  const { path, file } = await app();
  await run(["component", "define", path, "--intent", await file("item.json", { name: "Item", base: { layout: "row", width: 300, children: [
    { name: "Name", text: "Name" }, { name: "Origin", text: "origin", width: "fill", maxWidth: 240, visible: false },
  ] } }), "--json"]);
  // Stored before these rules: the hidden text hugs but keeps a max width.
  const at = join(path, "components", "components.json");
  const stored = JSON.parse(await readFile(at, "utf8"));
  const set = stored.componentSets.find((item) => item.name === "Item");
  for (const variant of set.variants) Object.assign(Object.values(variant.nodes).find((node) => node.name === "Origin"), { "layout-item-h-sizing": "auto", growType: "auto-height" });
  await writeFile(at, JSON.stringify(stored));
  await run(["page", "draw", path, "--intent", await file("p.json", { page: "List", children: [
    { name: "Row", use: "Item", set: { "Origin.visible": true }, text: { Origin: "packages/web/skills/frontend-design" } },
  ] }), "--json"]);
  const report = await run(["validate", path, "--page", "List", "--json", "--stdout"]);
  const messages = report.issues.filter((issue) => issue.code === "layout_not_in_app").map((issue) => issue.message);
  assert.ok(messages.some((message) => /Origin has maxWidth 240/.test(message)), messages.join("\n"));
  assert.ok(messages.some((message) => /Origin: a text cannot hug its width/.test(message)), messages.join("\n"));
  const fixed = await run(["component", "set", path, "--component", "Item", "--element", "Origin", "--set", "width=hug", "--set", "maxWidth=null", "--json"]);
  assert.match(fixed.done, /max width 240 → none/);
  const after = await run(["validate", path, "--page", "List", "--json", "--stdout"]);
  assert.ok(!after.issues.some((issue) => issue.code === "layout_not_in_app"), JSON.stringify(after.issues));
});

// Texts written as hug before the CLI stored what the App does are offered
// one repair that stores them the App's way and moves nothing.
test("project repair offers and stores old hugging texts the App's way", async () => {
  const { path, file } = await app();
  await run(["page", "draw", path, "--intent", await file("p.json", { page: "Old", children: [
    { name: "Row", layout: "row", width: 300, children: [{ name: "A", text: "alpha" }, { name: "B", text: "beta", width: 120 }] },
  ] }), "--json"]);
  const snapshot = await openPackage(path);
  const entry = snapshot.manifest.entries.screens.find((item) => snapshot.entries[item].name === "Old");
  const at = join(path, entry);
  const stored = JSON.parse(await readFile(at, "utf8"));
  for (const node of Object.values(stored.presentations[0].nodes))
    if (node.type === "TEXT") Object.assign(node, { "layout-item-h-sizing": node.name === "A" ? "auto" : "fix", "layout-item-v-sizing": "auto" });
  await writeFile(at, JSON.stringify(stored));
  const before = await run(["validate", path, "--page", "Old", "--json", "--stdout"]);
  assert.equal(before.issues.filter((issue) => /a text cannot hug/.test(issue.message)).length, 3);
  const offered = await run(["project", "repair", path, "--json"]);
  assert.deepEqual(offered.repairs.map(({ action, count }) => [action, count]), [["text-sizing", 3]]);
  const repaired = await run(["project", "repair", path, "--action", "text-sizing", "--json"]);
  assert.equal(repaired.count, 3);
  const nodes = Object.values((await openPackage(path)).entries[entry].presentations[0].nodes).filter((node) => node.type === "TEXT");
  assert.deepEqual(nodes.map((node) => [node.name, node["layout-item-h-sizing"], node["layout-item-v-sizing"], node.growType]).sort(),
    [["A", "fix", "fix", "auto-width"], ["B", "fix", "fix", "auto-height"]]);
  const after = await run(["validate", path, "--page", "Old", "--json", "--stdout"]);
  assert.ok(!after.issues.some((issue) => issue.code === "layout_not_in_app"), JSON.stringify(after.issues));
  assert.equal((await run(["project", "repair", path, "--json"])).repairs, undefined, "nothing left to offer");
});

// A panel pushes its button down with a filling Space; a page reuses it as
// a hugging copy and hides the Space. Hidden elements take no room, so the
// copy hugs what is shown (as the renderer and the App's placing rule do);
// the same copy with the Space shown is a container that hugs what fills it.
test("a hidden filling element does not make a hugging container an App layout issue", async () => {
  const { path, file } = await app();
  await run(["component", "define", path, "--intent", await file("panel.json", { name: "Panel", base: {
    layout: "column", width: 208, height: 300, children: [
      { name: "Label", text: "Folders" }, { name: "Space", width: "fill", height: "fill" }, { name: "Register", text: "Add folder" },
    ] } }), "--json"]);
  const issues = async (page, set) => {
    await run(["page", "draw", path, "--intent", await file(`${page}.json`, { page, children: [{ name: "Tree", use: "Panel", height: "hug", ...(set ? { set } : {}) }] }), "--json"]);
    const report = await run(["validate", path, "--page", page, "--json", "--stdout"]);
    return report.issues.filter((issue) => issue.code === "layout_not_in_app").map((issue) => issue.message);
  };
  assert.deepEqual(await issues("Hidden space", { "Space.visible": false }), []);
  const shown = await issues("Shown space");
  assert.ok(shown.some((message) => /Tree hugs its height while Space fills it/.test(message)), shown.join("\n"));
});
