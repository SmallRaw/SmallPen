import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { openPackage } from "@smallpen/local-package";

// Regressions found by blind agents using only help, schema and the Skill.
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
  const root = await mkdtemp(join(tmpdir(), "smallpen-blind-"));
  const path = (await run(["project", "init", join(root, "demo"), "--json"])).packages.package.path;
  const file = async (name, value) => { const at = join(root, name); await writeFile(at, JSON.stringify(value)); return at; };
  return { root, path, file };
}

const nodeNamed = async (path, page, name) => {
  const snapshot = await openPackage(path);
  const entry = snapshot.manifest.entries.screens.find((item) => snapshot.entries[item].name.endsWith(page));
  return Object.values(snapshot.entries[entry].presentations[0].nodes).find((node) => node.name === name);
};

test("renaming and redefining a component keeps the copies' overrides working", async () => {
  const { path, file } = await app();
  await run(["component", "define", path, "--intent", await file("c1.json", { name: "TopBar", base: { layout: "row", children: [{ name: "Title", text: "Title" }] } }), "--json"]);
  await run(["page", "draw", path, "--intent", await file("p.json", { page: "Detail", children: [{ name: "Bar", use: "TopBar", text: { Title: "Detail" } }] }), "--json"]);
  await run(["component", "rename", path, "--component", "TopBar", "--to", "App bar", "--json"]);
  await run(["component", "define", path, "--intent", await file("c2.json", { name: "App bar", base: { layout: "row", children: [{ name: "Title", text: "Title" }, { name: "Menu", text: "≡" }] } }), "--json"]);
  const view = await run(["view", path, "--page", "Detail", "--json"]);
  assert.match(view.text, /Bar: App bar "Detail \/ ≡"/, "the override survives and texts read in order");
  assert.equal((await run(["validate", path, "--json"])).status, "valid");
});

test("validate checks every page in every version and every component variant", async () => {
  const { path, file } = await app();
  await run(["component", "define", path, "--intent", await file("b.json", { name: "Button", properties: { Style: ["primary", "ghost"] }, base: { children: [{ name: "Label", text: "Go" }] } }), "--json"]);
  for (const platform of ["desktop", "mobile"])
    await run(["page", "draw", path, "--intent", await file(`${platform}.json`, { page: "List", platform, children: [{ name: "Title", text: "List" }] }), "--json"]);
  const report = await run(["validate", path, "--json"]);
  assert.ok(report.coverage.targets.includes("List (desktop)") && report.coverage.targets.includes("List (mobile)"));
  assert.ok(report.coverage.targets.includes("Button (2 variants)"));
  const full = await run(["validate", path, "--full", "--json"]);
  assert.ok(full.coverage.targets.includes("Button (Style=ghost)"));
  assert.ok(!JSON.stringify(report).includes("node_"), "no ids in the reply");
});

test("links and starts pick a page version and say which", async () => {
  const { path, file } = await app();
  for (const [page, platform, children] of [
    ["List", "mobile", [{ name: "Open", text: "Open" }]],
    ["List", "desktop", [{ name: "Side", children: [{ name: "Open", text: "Open" }] }]],
    ["Item", "mobile", [{ name: "T", text: "Item" }]],
    ["Item", "desktop", [{ name: "T", text: "Item" }]],
  ])
    await run(["page", "draw", path, "--intent", await file(`${page}-${platform}.json`, { page, platform, children }), "--json"]);
  const linked = await run(["flow", "link", path, "--from", "List / Side / Open", "--to", "Item", "--platform", "desktop", "--json"]);
  assert.deepEqual(linked.target, { page: "List", platform: "desktop" });
  const started = await run(["flow", "start", path, "--page", "List", "--platform", "desktop", "--json"]);
  assert.deepEqual(started.target, { page: "List", platform: "desktop" });
  const flows = await run(["flow", "list", path, "--json"]);
  assert.match(flows.text, /List \(desktop\) \/ Open —click→ Item/);
});

test("copy overrides find elements by whole name, by a name only one element has, and refuse hug", async () => {
  const { path, file } = await app();
  await run(["component", "define", path, "--intent", await file("card.json", {
    name: "Card", base: { layout: "row", children: [{ name: "Info", layout: "column", children: [{ name: "Title", text: "Drink water" }, { name: "hello@example.com", text: "mail" }] }] },
  }), "--json"]);
  await run(["page", "draw", path, "--intent", await file("page.json", {
    page: "Cards", children: [{ name: "Card A", use: "Card", text: { Title: "Read twenty pages of a book", "hello@example.com": "me@x.io" } }],
  }), "--json"]);
  const view = await run(["view", path, "--page", "Cards", "--json"]);
  assert.match(view.text, /"Read twenty pages of a book \/ me@x\.io"/);
  // The longer title widened the copy and the column that hugs it.
  const card = await nodeNamed(path, "Cards", "Card A");
  assert.ok(Object.keys(card.instance.overrides).some((key) => key.endsWith(":width")), JSON.stringify(card.instance.overrides));
  const hug = await run(["page", "draw", path, "--intent", await file("hug.json", { page: "Bad", children: [{ name: "C", use: "Card", set: { "Title.width": "hug" } }] }), "--json"], 1);
  assert.equal(hug.error.code, "invalid_instance_size");
});

test("a text bound to a string Token is sized for its longest translation", async () => {
  const { path, file } = await app();
  await run(["token", "theme", "add", path, "--theme", "Language/English", "--theme", "Language/Chinese", "--json"]);
  await run(["token", "set", path, "--intent", await file("t.json", { tokens: [{ name: "text.title", type: "string", value: "Tasks", values: { "Language/Chinese": "今天要完成的任务清单" } }] }), "--json"]);
  await run(["page", "draw", path, "--intent", await file("p.json", { page: "List", children: [{ name: "Title", text: "{text.title}", fontSize: 32 }] }), "--json"]);
  const title = await nodeNamed(path, "List", "Title");
  assert.ok(title.width > 250, `width ${title.width} fits the Chinese title`);
});

test("deleting a component its own package still uses names the copies", async () => {
  const { path, file } = await app();
  await run(["component", "define", path, "--intent", await file("b.json", { name: "Button", base: { children: [{ name: "Label", text: "Go" }] } }), "--json"]);
  await run(["page", "draw", path, "--intent", await file("p.json", { page: "Home", children: [{ name: "Add", use: "Button" }] }), "--json"]);
  const refused = await run(["component", "delete", path, "--component", "Button", "--json"], 1);
  assert.equal(refused.error.code, "in_use");
  assert.deepEqual(refused.error.details.uses, ["demo: Home / Add"]);
});

const EXAMPLE = join(dirname(fileURLToPath(import.meta.url)), "..", "examples", "common-components.smallpen");

async function example() {
  const root = await mkdtemp(join(tmpdir(), "smallpen-blind-"));
  const path = join(root, "common-components.smallpen");
  await cp(EXAMPLE, path, { recursive: true });
  return path;
}

test("an element renamed without a variant is renamed in every variant that has it", async () => {
  const path = await example();
  // The example draws each variant on its own: the same element has a
  // different node id in each one.
  await run(["component", "rename", path, "--component", "Button", "--element", "Add icon [2]", "--to", "Add icon vertical", "--json"]);
  const snapshot = await openPackage(path);
  const button = [...snapshot.domain.componentSets.values()].find((set) => set.name === "Button");
  const withIcon = button.variants.filter((variant) => Object.values(variant.nodes).some((node) => /^Add icon/.test(node.name)));
  assert.ok(withIcon.length > 1);
  for (const variant of withIcon)
    assert.ok(Object.values(variant.nodes).some((node) => node.name === "Add icon vertical"), variant.name);
  // Only one "Add icon" is left in each variant: "[2]" names nothing now.
  const gone = await run(["component", "rename", path, "--component", "Button", "--element", "Add icon [2]", "--to", "X", "--json"], 1);
  assert.equal(gone.error.code, "unknown_element");
});

test("validate counts every variant, groups what it skipped and names it", async () => {
  const path = await example();
  const report = await run(["validate", path, "--json"]);
  const button = [...(await openPackage(path)).domain.componentSets.values()].find((set) => set.name === "Button");
  assert.ok(report.coverage.targets.includes(`Button (${button.variants.length} variants)`), JSON.stringify(report.coverage.targets));
  assert.ok(report.coverage.targetCount > button.variants.length);
  assert.equal(report.coverage.skippedCount, report.coverage.skipped.reduce((sum, { count }) => sum + count, 0));
  assert.ok(!JSON.stringify(report).includes("node_"), "no ids in the reply");
  const one = await run(["validate", path, "--component", "Button", "--json"]);
  assert.deepEqual(one.coverage.targets, [`Button (${button.variants.length} variants)`]);
  assert.ok(one.outputBytes < 4000, `${one.outputBytes} bytes`);
});

test("a long outline says how many lines and characters it left out", async () => {
  const { path, file } = await app();
  const long = "A sentence that is much longer than an outline line can show in one go.";
  await run(["page", "draw", path, "--intent", await file("p.json", { page: "Long", children: [{ name: "Note", text: long, width: 600 }] }), "--json"]);
  const view = await run(["view", path, "--page", "Long", "--json"]);
  assert.match(view.text, /Note · TEXT .*"A sentence.*…" \(\+\d+ chars\)/);
  const short = await run(["view", path, "--page", "Long", "--limit", "1", "--json"]);
  assert.match(short.text, /… 1 more line: add --offset 1$/);
});

test("texts in a row hug unless one is alone, a filling text wraps and its container grows, overflow is an issue", async () => {
  const { path, file } = await app();
  await run(["page", "draw", path, "--intent", await file("p.json", { page: "Rows", children: [
    { name: "Pair", layout: "row", width: 260, gap: 8, children: [{ name: "Title", text: "Read twenty pages of a very long book today" }, { name: "Tag", text: "Overdue by three days" }] },
    { name: "Card", layout: "column", width: 300, padding: 12, children: [
      { name: "Body", width: "fill", text: "Removing someone keeps the files they created; ownership moves to the workspace admin. Pending invitations expire after 14 days." },
    ] },
  ] }), "--json"]);
  const title = await nodeNamed(path, "Rows", "Title");
  assert.equal(title["layout-item-h-sizing"], "auto", "two texts in a row hug");
  const body = await nodeNamed(path, "Rows", "Body");
  const card = await nodeNamed(path, "Rows", "Card");
  assert.ok(body.height > 40, `body wraps: ${body.height}`);
  assert.ok(card.height >= body.height + 24, `card grows: ${card.height}`);
  const report = await run(["validate", path, "--page", "Rows", "--json"]);
  const overflow = report.issues.find(({ code }) => code === "content_overflow");
  assert.equal(overflow?.where, "Pair");
  assert.match(overflow.message, /needs \d+px wide but it is 260px/);
});

test("changes speak the commands' words: page contents, no repeated rename, variants in one phrase", async () => {
  const { path, file } = await app();
  const since = (await run(["project", "show", path, "--json"])).revision;
  await run(["component", "define", path, "--intent", await file("b.json", { name: "Button", properties: { Style: ["primary", "ghost"], Size: ["sm", "md", "lg"] }, base: { layout: "row", children: [{ name: "Label", text: "Go" }] } }), "--json"]);
  await run(["page", "draw", path, "--intent", await file("p.json", { page: "Home", children: [{ name: "Add", use: "Button" }] }), "--json"]);
  const added = await run(["changes", path, "--since", since, "--json"]);
  assert.match(added.text, /Home: added — desktop \d+×\d+, 1 element, uses Button/);
  const middle = (await run(["project", "show", path, "--json"])).revision;
  await run(["page", "rename", path, "--page", "Home", "--to", "Start", "--json"]);
  await run(["component", "rename", path, "--component", "Button", "--element", "Label", "--to", "Text", "--json"]);
  const renamed = await run(["changes", path, "--since", middle, "--json"]);
  assert.equal(renamed.text.match(/Start/g).length, 1, renamed.text);
  assert.match(renamed.text, /Button \(all variants\) \/ Text: changed — name Label → Text/);
  const counts = (await run(["project", "show", path, "--json"])).counts;
  assert.equal(counts.pages, (await run(["page", "list", path, "--json"])).pages.length);
  assert.equal(counts.variants, 6);
});

test("a copy of a component drawn without auto layout widens for a longer one-line text", async () => {
  const path = await example();
  const { file } = await app();
  // The example draws Button without auto layout: a fixed text in a fixed box.
  await run(["page", "draw", path, "--intent", await file("w.json", { page: "Widen", children: [{ name: "Invite", use: "Button", text: { Continue: "Invite every teammate now" } }] }), "--json"]);
  const view = await run(["view", path, "--page", "Widen", "--json"]);
  const width = Number(/Invite: Button .* · (\d+)×44/.exec(view.text)?.[1]);
  assert.ok(width > 152, view.text);
  const report = await run(["validate", path, "--page", "Widen", "--json"]);
  assert.ok(!report.issues.some(({ code }) => code === "text_overflow"), JSON.stringify(report.issues));
});

test("writes say what they did; token list takes a name; flow list is one text; wireframes number in reading order", async () => {
  const { path, file } = await app();
  await run(["token", "set", path, "--intent", await file("t.json", { tokens: [{ name: "color.text.main", type: "color", value: "#111111" }, { name: "color.bg", type: "color", value: "#ffffff" }, { name: "space.md", type: "spacing", value: 16 }] }), "--json"]);
  const colors = await run(["token", "list", path, "--token", "color", "--json"]);
  assert.deepEqual(colors.items.map(({ token }) => token.path).sort(), ["color.bg", "color.text.main"]);
  await run(["page", "draw", path, "--intent", await file("p.json", { page: "Home", layout: "row", children: [{ name: "Left", text: "L" }, { name: "Right", width: 40, height: 20 }] }), "--json"]);
  const renamed = await run(["page", "rename", path, "--page", "Home", "--element", "Left", "--to", "Start", "--json"]);
  assert.match(renamed.done, /Home \(desktop\) \/ Start: changed — name Left → Start/);
  const flows = await run(["flow", "list", path, "--json"]);
  assert.deepEqual(Object.keys(flows).filter((key) => key !== "outputBytes"), ["text", "counts", "revision"]);
  const wireframe = await run(["view", path, "--page", "Home", "--as", "wireframe", "--json"]);
  assert.match(wireframe.text ?? wireframe.wireframe, /\[02\] TEXT "Start"\n\s+\[03\] RECTANGLE "Right"/);
});

test("page set changes one element without a redraw; texts rewrap and hugging containers follow", async () => {
  const { path, file } = await app();
  await run(["token", "set", path, "--intent", await file("t.json", { tokens: [{ name: "color.surface", type: "color", value: "#f4f4ff" }] }), "--json"]);
  await run(["page", "draw", path, "--intent", await file("p.json", { page: "Home", children: [
    { name: "Card", layout: "column", width: 300, padding: 12, children: [
      { name: "Body", width: "fill", text: "Removing someone keeps the files they created; ownership moves to the workspace admin." },
    ] },
  ] }), "--json"]);
  await run(["flow", "start", path, "--page", "Home", "--json"]);
  const before = await nodeNamed(path, "Home", "Body");
  const set = await run(["page", "set", path, "--page", "Home", "--element", "Card", "--set", "width=200", "--set", "fill={color.surface}", "--json"]);
  assert.match(set.done, /Home \(desktop\) \/ Card: changed — size 300×\d+ → 200×\d+/);
  const body = await nodeNamed(path, "Home", "Body");
  const card = await nodeNamed(path, "Home", "Card");
  assert.ok(body.height > before.height, `rewraps: ${before.height} → ${body.height}`);
  assert.ok(card.height >= body.height + 24, "the card hugs its taller text");
  assert.ok(card.tokenBindings.fill, "the fill follows the Token");
  assert.equal(body.id, before.id, "the element keeps its id");
  assert.match((await run(["flow", "list", path, "--json"])).text, /Home \(desktop\)/, "the start stays");
  await run(["page", "set", path, "--page", "Home", "--set", "width=800", "--set", "height=600", "--json"]);
  const view = await run(["view", path, "--page", "Home", "--json"]);
  assert.match(view.text, /^Home · desktop · FRAME 800×600/);
  const bad = await run(["page", "set", path, "--page", "Home", "--element", "Card", "--set", "colour=red", "--json"], 1);
  assert.equal(bad.error.code, "unknown_set_field");
});

test("component set changes an element in every variant; a copy's text over a Token replaces the binding", async () => {
  const { path, file } = await app();
  await run(["token", "set", path, "--intent", await file("t.json", { tokens: [{ name: "text.go", type: "string", value: "Go" }] }), "--json"]);
  await run(["component", "define", path, "--intent", await file("b.json", { name: "Button", properties: { Style: ["primary", "ghost"] }, base: { layout: "row", padding: [8, 16], children: [{ name: "Label", text: "{text.go}", fontSize: 14 }] } }), "--json"]);
  // Variants may differ on purpose: several need --variant or --all.
  const refused = await run(["component", "set", path, "--component", "Button", "--element", "Label", "--set", "fontSize=18", "--json"], 1);
  assert.equal(refused.error.code, "ambiguous_target");
  assert.deepEqual(refused.error.details.variants, ["Style=primary", "Style=ghost"]);
  const one = await run(["component", "set", path, "--component", "Button", "--variant", "ghost", "--element", "Label", "--set", "fontSize=16", "--json"]);
  assert.match(one.done, /Button \(Style=ghost\) \/ Label: changed — font size 14 → 16/);
  const changed = await run(["component", "set", path, "--component", "Button", "--element", "Label", "--all", "--set", "fontSize=18", "--json"]);
  // --all over variants that differed lists each one's old value.
  assert.match(changed.done, /Button \(Style=primary\) \/ Label: changed — font size 14 → 18/);
  assert.match(changed.done, /Button \(Style=ghost\) \/ Label: changed — font size 16 → 18/);
  await run(["page", "draw", path, "--intent", await file("p.json", { page: "Home", children: [{ name: "Save", use: "Button" }] }), "--json"]);
  const copy = await run(["page", "set", path, "--page", "Home", "--element", "Save", "--set", 'props={"Style":"ghost"}', "--set", 'text={"Label":"Save all changes"}', "--json"]);
  assert.match(copy.done, /Save: changed — variant Style=primary → Style=ghost; Label text none → "Save all changes"/);
  const view = await run(["view", path, "--page", "Home", "--json"]);
  assert.match(view.text, /Save: Button \(Style=ghost\) "Save all changes"/);
});

test("view --as spec reads positions, sizes, layout and visual Token bindings", async () => {
  const { path, file } = await app();
  await run(["token", "set", path, "--intent", await file("t.json", { tokens: [
    { name: "color.surface", type: "color", value: "#f4f4ff" }, { name: "space.md", type: "spacing", value: 12 }, { name: "text.title", type: "string", value: "Tasks" },
  ] }), "--json"]);
  await run(["component", "define", path, "--intent", await file("b.json", { name: "Button", base: { layout: "row", padding: 8, children: [{ name: "Label", text: "Go" }] } }), "--json"]);
  await run(["page", "draw", path, "--intent", await file("p.json", { page: "Home", padding: 24, children: [
    { name: "Card", layout: "column", width: 300, padding: "{space.md}", gap: 8, fill: "{color.surface}", radius: 8, children: [
      { name: "Title", text: "{text.title}", fontSize: 20, fontWeight: 600 },
      { name: "Save", use: "Button", text: { Label: "Save" } },
    ] },
  ] }), "--json"]);
  const spec = await run(["view", path, "--page", "Home", "--as", "spec", "--json"]);
  assert.match(spec.text, /^Spec · px, x\/y from the top-left/);
  assert.match(spec.text, /Card · frame · at 24,24 · 300×\d+ \(height hug\) · column · gap 8 · padding 12 \{space\.md\} · fill #f4f4ff \{color\.surface\} · radius 8/);
  assert.match(spec.text, /Title · text · at 36,36 · .*font .*20 weight 600.*text \{text\.title\} "Tasks"/);
  assert.match(spec.text, /Save · copy of Button · at \d+,\d+ · .*texts "Save" · changes Label text "Save"/);
  assert.ok(!spec.text.includes("node_"), "no ids");
});

test("an element inside a copy links by name; starts of a page's versions read apart", async () => {
  const { path, file } = await app();
  await run(["component", "define", path, "--intent", await file("c.json", { name: "Card", base: { layout: "row", children: [{ name: "Title", text: "Run" }, { name: "Open", text: "Open" }] } }), "--json"]);
  for (const platform of ["desktop", "mobile"])
    await run(["page", "draw", path, "--intent", await file(`l-${platform}.json`, { page: "List", platform, children: [{ name: "Run card", use: "Card" }] }), "--json"]);
  await run(["page", "draw", path, "--intent", await file("d.json", { page: "Detail", children: [{ name: "T", text: "Detail" }] }), "--json"]);
  const linked = await run(["flow", "link", path, "--from", "List / Run card / Open", "--to", "Detail", "--platform", "mobile", "--json"]);
  assert.match(linked.done, /List \(mobile\) \/ Run card \/ Open: link added — click → Detail/);
  assert.doesNotMatch(linked.done, /interactions/);
  for (const platform of ["desktop", "mobile"]) await run(["flow", "start", path, "--page", "List", "--platform", platform, "--json"]);
  const flows = await run(["flow", "list", path, "--full", "--json"]);
  assert.match(flows.text, /List \(mobile\) \/ Run card \/ Open —click→ Detail/);
  assert.deepEqual(flows.starts.map(({ name }) => name), ["List (desktop)", "List (mobile)"]);
  assert.equal((await run(["validate", path, "--json"])).status, "valid");
  await run(["flow", "unlink", path, "--from", "List / Run card / Open", "--platform", "mobile", "--json"]);
  assert.doesNotMatch((await run(["flow", "list", path, "--json"])).text, /Open —click→/);
});

test("project init makes a package without pages, named after --name", async () => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-init-"));
  const made = await run(["project", "init", join(root, "ws"), "--name", "Team App", "--json"]);
  assert.match(made.packages.package.path, /ws\/team-app\.smallpen$/);
  assert.equal((await run(["page", "list", made.packages.package.path, "--json"])).pages.length, 0);
});

test("page set refuses an element in several versions unless one is named or --all is given", async () => {
  const { path, file } = await app();
  for (const [platform, width] of [["desktop", 400], ["mobile", 300]])
    await run(["page", "draw", path, "--intent", await file(`${platform}.json`, { page: "List", platform, children: [{ name: "Card", width, height: 80 }] }), "--json"]);
  const refused = await run(["page", "set", path, "--page", "List", "--element", "Card", "--set", "width=500", "--json"], 1);
  assert.equal(refused.error.code, "ambiguous_target");
  assert.deepEqual(refused.error.details.platforms, ["desktop", "mobile"]);
  assert.match(refused.error.message, /--platform.*--all/);
  const root = await run(["page", "set", path, "--page", "List", "--set", "width=1280", "--json"], 1);
  assert.equal(root.error.code, "ambiguous_target");
  await run(["page", "set", path, "--page", "List", "--platform", "desktop", "--element", "Card", "--set", "width=500", "--json"]);
  const view = await run(["view", path, "--page", "List", "--platform", "mobile", "--json"]);
  assert.match(view.text, /Card · RECTANGLE 300×80/, "the mobile card keeps its own width");
  const every = await run(["page", "set", path, "--page", "List", "--element", "Card", "--all", "--set", "height=96", "--json"]);
  assert.match(every.done, /List \(desktop\) \/ Card/);
  assert.match(every.done, /List \(mobile\) \/ Card/);
});
