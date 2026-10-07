import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openPackage } from "@smallpen/local-package";

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

async function blank() {
  const root = await mkdtemp(join(tmpdir(), "smallpen-simple-"));
  const init = await run(["project", "init", join(root, "demo"), "--json"]);
  return { root, path: init.packagePath };
}

async function file(root, name, value) {
  const path = join(root, name);
  await writeFile(path, JSON.stringify(value));
  return path;
}

const rows = async (path, ...args) =>
  Object.fromEntries(
    (await run(["token", "list", path, ...args, "--json"])).items.map((item) => [
      item.token.path,
      { type: item.token.type, value: item.value, values: item.values ?? {} },
    ]),
  );

test("theme commands name options as Group/Option, like Token values", async () => {
  const { path } = await blank();
  await run(["theme", "add", path, "--theme", "Viewport/Desktop", "--theme", "Viewport/Mobile", "--json"]);
  await run(["theme", "add", path, "--theme", "Viewport/Tablet", "--json"]);
  const viewport = () => run(["theme", "list", path, "--json"]).then(({ groups }) => groups.find(({ name }) => name === "Viewport"));
  assert.deepEqual(await viewport(), {
    name: "Viewport",
    default: "Viewport/Desktop",
    selected: "Viewport/Desktop",
    options: ["Viewport/Desktop", "Viewport/Mobile", "Viewport/Tablet"],
  });
  const again = await run(["theme", "add", path, "--theme", "Viewport/Mobile", "--json"], 1);
  assert.equal(again.error.code, "theme_options_exist");
  const bare = await run(["theme", "add", path, "--theme", "Tablet", "--json"], 1);
  assert.equal(bare.error.code, "invalid_theme_name");

  await run(["theme", "rename", path, "--theme", "Viewport/Desktop", "--to", "Web", "--json"]);
  await run(["theme", "default", path, "--theme", "Viewport/Mobile", "--json"]);
  await run(["theme", "delete", path, "--theme", "Viewport/Tablet", "--json"]);
  await run(["theme", "rename", path, "--group", "Viewport", "--to", "Platform", "--json"]);
  const groups = (await run(["theme", "list", path, "--json"])).groups;
  const platform = groups.find(({ name }) => name === "Platform");
  assert.deepEqual(platform.options, ["Platform/Web", "Platform/Mobile"]);
  assert.equal(platform.default, "Platform/Mobile");
  await run(["theme", "delete", path, "--group", "Platform", "--json"]);
  assert.equal((await run(["theme", "list", path, "--json"])).groups.some(({ name }) => name === "Platform"), false);
});

test("token set writes Tokens by name with default and per-option values in one call", async () => {
  const { root, path } = await blank();
  await run(["theme", "add", path, "--theme", "Theme/Light", "--theme", "Theme/Dark", "--json"]);
  await run(["theme", "add", path, "--theme", "Viewport/Desktop", "--theme", "Viewport/Mobile", "--json"]);
  const created = await run(["token", "set", path, "--intent", await file(root, "tokens.json", {
    tokens: [
      { name: "color.brand", type: "color", value: "#4f46e5", values: { "Theme/Dark": "#818cf8" } },
      { name: "color.action", type: "color", value: "{color.brand}" },
      { name: "space.4", type: "spacing", value: 16, values: { "Viewport/Mobile": 12 } },
    ],
  }), "--json"]);
  assert.ok(created.revision);
  let tokens = await rows(path);
  assert.deepEqual(tokens["color.brand"], { type: "color", value: "#4f46e5", values: { "Theme/Dark": "#818cf8" } });
  assert.deepEqual(tokens["color.action"].values, { "Theme/Dark": "#818cf8" }, "an alias follows its target per option");
  assert.deepEqual(tokens["space.4"], { type: "spacing", value: 16, values: { "Viewport/Mobile": 12 } });

  // Changing a Token touches only what the call names.
  await run(["token", "set", path, "--intent", await file(root, "update.json", {
    tokens: [
      { name: "color.brand", values: { "Theme/Dark": "#a5b4fc" } },
      { name: "space.4", value: 20 },
    ],
  }), "--json"]);
  tokens = await rows(path);
  assert.deepEqual(tokens["color.brand"], { type: "color", value: "#4f46e5", values: { "Theme/Dark": "#a5b4fc" } });
  assert.deepEqual(tokens["space.4"], { type: "spacing", value: 20, values: { "Viewport/Mobile": 12 } });
  assert.deepEqual(Object.keys(await rows(path, "--type", "spacing")), ["space.4"]);
});

test("token set hides storage: value follows every option without its own value", async () => {
  const { root, path } = await blank();
  await run(["theme", "add", path, "--theme", "Viewport/Desktop", "--theme", "Viewport/Mobile", "--theme", "Viewport/Tablet", "--json"]);
  await run(["theme", "add", path, "--theme", "Theme/Light", "--theme", "Theme/Dark", "--json"]);
  await run(["token", "set", path, "--intent", await file(root, "a.json", {
    tokens: [
      { name: "space.page", type: "spacing", group: "Viewport", value: 32, values: { "Viewport/Mobile": 16 } },
      { name: "color.text", type: "color", value: "#111111", values: { "Theme/Dark": "#eeeeee", "Viewport/Mobile": "#222222" } },
    ],
  }), "--json"]);
  await run(["token", "set", path, "--intent", await file(root, "b.json", {
    tokens: [{ name: "space.page", value: 40 }],
  }), "--json"]);
  const tokens = await rows(path);
  assert.deepEqual(tokens["space.page"], { type: "spacing", value: 40, values: { "Viewport/Mobile": 16 } },
    "Tablet had no value of its own, so it follows the new default");
  assert.deepEqual(tokens["color.text"].values, { "Theme/Dark": "#eeeeee", "Viewport/Mobile": "#222222" });

  const themes = await run(["theme", "list", path, "--json"]);
  assert.ok(!JSON.stringify(themes).includes('"sets"') && !JSON.stringify(themes).includes("setIds"));
  const list = await run(["token", "list", path, "--json"]);
  assert.ok(!JSON.stringify(list).includes('"sets"'));
  assert.ok(JSON.stringify(await run(["theme", "list", path, "--full", "--json"])).includes("setIds"));

  const shown = await run(["token", "show", path, "--path", "space.page", "--theme", "Viewport/Mobile", "--json"]);
  assert.equal(JSON.stringify(shown).includes("16"), true);
  await run(["token", "delete", path, "--path", "color.text", "--json"]);
  assert.equal("color.text" in (await rows(path)), false);
  const gone = await run(["token", "delete", path, "--path", "color.text", "--json"], 1);
  assert.equal(gone.error.code, "unknown_token");
});

test("token set reports what it cannot resolve without writing", async () => {
  const { root, path } = await blank();
  const unknown = await run(["token", "set", path, "--intent", await file(root, "bad.json", {
    tokens: [{ name: "color.x", type: "color", value: "#000000", values: { "Theme/Night": "#111111" } }],
  }), "--json"], 1);
  assert.equal(unknown.error.code, "unknown_theme_option");
  assert.equal(unknown.error.writeState, "not-applied");
  const untyped = await run(["token", "set", path, "--intent", await file(root, "untyped.json", {
    tokens: [{ name: "color.y", value: "#000000" }],
  }), "--json"], 1);
  assert.equal(untyped.error.code, "invalid_token_set");
});

// Stored component data, read straight from the package.
async function storedComponent(path, name) {
  const pkg = await openPackage(path);
  return Object.values(pkg.entries)
    .flatMap((entry) => entry.componentSets ?? [])
    .find((set) => set.name === name);
}

async function designed() {
  const { root, path } = await blank();
  await run(["token", "set", path, "--intent", await file(root, "tokens.json", {
    tokens: [
      { name: "color.brand", type: "color", value: "#4f46e5" },
      { name: "space.2", type: "spacing", value: 8 },
    ],
  }), "--json"]);
  await run(["component", "define", path, "--intent", await file(root, "button.json", {
    name: "Button",
    properties: { Style: ["primary", "secondary"] },
    base: {
      layout: "row", padding: ["{space.2}", 16], fill: "{color.brand}", radius: 8,
      children: [{ name: "Label", text: "Go", color: "#ffffff", fontSize: 14 }],
    },
    variants: [{ when: { Style: "secondary" }, set: { fill: "#ffffff", "Label.color": "{color.brand}" } }],
  }), "--json"]);
  return { root, path };
}

test("component define builds every variant from a base tree, binds Tokens by path and keeps element ids", async () => {
  const { path } = await designed();
  const set = await storedComponent(path, "Button");
  assert.deepEqual(set.axes.map(({ name, domain }) => [name, domain]), [["Style", ["primary", "secondary"]]]);
  assert.equal(set.variants.length, 2);
  const [primary, secondary] = set.variants;
  const root = primary.nodes[primary.rootId];
  const label = Object.values(primary.nodes).find(({ name }) => name === "Label");
  assert.equal(root.tokenBindings.fill.assetId.startsWith("tok_"), true);
  assert.equal(root.tokenBindings.paddingTop.assetId, root.tokenBindings.paddingBottom.assetId);
  assert.equal(root.width, Math.ceil(label.width) + 32, "the row hugs its measured label and padding");
  assert.equal(label["layout-item-h-sizing"], "fill", "a text in a row grows with it");
  assert.deepEqual(Object.keys(secondary.nodes).sort(), Object.keys(primary.nodes).sort(), "one element, one id in every variant");
  assert.equal(secondary.nodes[secondary.rootId].fills[0].color, "#ffffff");
  assert.ok(Object.values(secondary.nodes).find(({ name }) => name === "Label").tokenBindings.fill);
});

test("page draw lays out named elements in order, widens instances for longer text, and keeps links on redraw", async () => {
  const { root, path } = await designed();
  const board = await file(root, "board.json", {
    page: "Board", module: "Tasks", layout: "row",
    children: [
      { name: "Sidebar", width: 240, height: "fill" },
      { name: "Content", width: "fill", height: "fill", children: [
        { name: "Top bar", layout: "row", width: "fill", children: [
          { name: "Title", text: "Sprint" },
          { name: "New task", use: "Button", text: { Label: "Create a new task" } },
        ] },
      ] },
    ],
  });
  await run(["page", "draw", path, "--intent", board, "--json"]);
  await run(["page", "draw", path, "--intent", await file(root, "detail.json", {
    page: "Task detail", module: "Tasks", children: [{ name: "Heading", text: "Task" }],
  }), "--json"]);
  const pages = (await run(["page", "list", path, "--json"])).items.map(({ name }) => name);
  assert.ok(pages.includes("Tasks / Board") && pages.includes("Tasks / Task detail"));
  const view = await run(["view", path, "--page", "Board", "--as", "text", "--json"]);
  assert.equal(view.target.page, "Tasks / Board");
  assert.ok(view.text.indexOf("Sidebar") < view.text.indexOf("Content"), "elements read in drawing order");
  assert.ok(view.text.indexOf("Title") < view.text.indexOf("Button"));
  const button = (await storedComponent(path, "Button")).variants[0];
  const instanceWidth = Number(/Button \(Style=primary\) "Create a new task" · (\d+)×/.exec(view.text)[1]);
  assert.ok(instanceWidth > button.nodes[button.rootId].width, "the instance grew for its longer label");

  await run(["flow", "link", path, "--from", "Board / New task", "--to", "Task detail", "--json"]);
  await run(["flow", "start", path, "--page", "Board", "--json"]);
  const before = await run(["flow", "list", path, "--json"]);
  assert.deepEqual(
    before.links.map(({ page, element, to }) => [page, element, to]),
    [["Tasks / Board", "New task", "Tasks / Task detail"]],
  );
  assert.deepEqual(before.starts.map(({ page }) => page), ["Tasks / Board"]);
  await run(["page", "draw", path, "--intent", board, "--json"]);
  const after = await run(["flow", "list", path, "--json"]);
  assert.deepEqual(after.links, before.links, "redrawing keeps the link of an element drawn under the same name");
  assert.deepEqual(after.starts, before.starts);
  const missing = await run(["flow", "link", path, "--from", "Board / Nope", "--to", "Task detail", "--json"], 1);
  assert.equal(missing.error.code, "unknown_element");
});

test("Chinese page and element names get distinct ids and read back by name", async () => {
  const { root, path } = await blank();
  for (const [page, children] of [
    ["看板", [{ name: "标题", text: "冲刺看板" }, { name: "正文", text: "任务列表" }]],
    ["设置", [{ name: "标题", text: "设置" }]],
  ])
    await run(["page", "draw", path, "--intent", await file(root, `${page}.json`, { page, children }), "--json"]);
  const listed = (await run(["page", "list", path, "--json"])).items.map(({ name }) => name);
  assert.ok(["看板", "设置"].every((name) => listed.includes(name)), "page list names both pages");
  // Replies leave out ids; the stored package keeps them.
  const snapshot = await openPackage(path);
  const pages = snapshot.manifest.entries.screens.map((entry) => snapshot.entries[entry]);
  const ids = pages.filter(({ name }) => ["看板", "设置"].includes(name)).map(({ id }) => id);
  assert.equal(ids.length, 2);
  assert.ok(ids.every((id) => typeof id === "string" && id.length > 0));
  assert.equal(new Set(ids).size, 2, "two Chinese pages never share an id");
  const board = await run(["view", path, "--page", "看板", "--json"]);
  assert.match(board.text, /标题 · TEXT .*"冲刺看板"/);
  assert.match(board.text, /正文 · TEXT .*"任务列表"/);
  const part = await run(["view", path, "--page", "看板", "--element", "正文", "--json"]);
  assert.match(part.text, /^正文 ·/);
});
