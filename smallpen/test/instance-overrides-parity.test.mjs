import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalJSON, defaultTokenWorkspace, projectScreen, selectTokenThemes } from "@smallpen/core";
import { openPackage } from "@smallpen/local-package";
import { PNG } from "pngjs";

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

test("a placed copy overrides what Penpot lets a copy change, Tokens and nested variants included", async () => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-copies-"));
  const path = (await run(["project", "init", join(root, "demo"), "--json"])).packagePath;
  const file = async (name, value) => { const at = join(root, name); await writeFile(at, JSON.stringify(value)); return at; };
  await run(["token", "theme", "add", path, "--theme", "Mode/Light", "--theme", "Mode/Dark", "--json"]);
  await run(["token", "set", path, "--intent", await file("tokens.json", { tokens: [
    { name: "color.accent", type: "color", group: "Mode", value: "#e11d48", values: { "Mode/Dark": "#fb7185" } },
    { name: "radius.pill", type: "border-radius", value: 999 },
  ] }), "--json"]);
  await run(["component", "define", path, "--intent", await file("icon.json", {
    name: "Icon", properties: { Size: ["sm", "lg"] },
    base: { width: 16, height: 16, fill: "#111111" },
    variants: [{ when: { Size: "lg" }, set: { width: 24, height: 24 } }],
  }), "--json"]);
  await run(["component", "define", path, "--intent", await file("button.json", {
    name: "Button",
    base: { layout: "row", gap: 8, padding: [8, 16], fill: "#ffffff", children: [
      { name: "Icon", use: "Icon" },
      { name: "Label", text: "Go", color: "#111111", fontSize: 14 },
    ] },
  }), "--json"]);
  await run(["page", "draw", path, "--intent", await file("page.json", {
    page: "Board", children: [{
      name: "Delete", use: "Button",
      text: { Label: "Delete" },
      set: {
        "Label.color": "{color.accent}", "Label.fontSize": 18,
        stroke: "{color.accent}", radius: "{radius.pill}",
        "Icon.props": { Size: "lg" },
      },
    }],
  }), "--json"]);

  const snapshot = await openPackage(path);
  const under = (theme) => {
    const selected = selectTokenThemes(defaultTokenWorkspace({ product: snapshot }), [theme]);
    const nodes = Object.values(projectScreen(selected.product, "scr_board").nodes);
    return {
      label: nodes.find(({ name, type }) => name === "Label" && type === "TEXT"),
      icon: nodes.find(({ id }) => id.endsWith("__node_button_button_icon")),
    };
  };
  const light = under("Mode/Light");
  assert.equal(light.label.text, "Delete");
  assert.equal(light.label.fills[0].color, "#e11d48");
  assert.equal(light.label.textStyle.fontSize, 18);
  assert.equal(light.icon.width, 24, "the nested Icon switched to Size=lg");
  const dark = under("Mode/Dark");
  assert.equal(dark.label.fills[0].color, "#fb7185", "the copy's own Token follows the theme");

  // A variant name that does not exist names the ones that do.
  const wrong = await run(["page", "draw", path, "--intent", await file("wrong.json", {
    page: "Wrong", children: [{ name: "B", use: "Button", set: { "Icon.props": { Size: "huge" } } }],
  }), "--json"], 1);
  assert.equal(wrong.error.code, "unknown_property_value");
});

test("editing one nested component property preserves earlier choices and matches the preview", async () => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-nested-choices-"));
  const path = (await run(["project", "init", join(root, "demo"), "--json"])).packagePath;
  const file = async (name, value) => { const at = join(root, name); await writeFile(at, JSON.stringify(value)); return at; };
  await run(["component", "define", path, "--intent", await file("sender.json", {
    name: "Sender", properties: { Kind: ["secondary", "primary"], State: ["idle", "loading"], Content: ["icon", "text"] },
    base: { layout: "row", padding: 8, children: [{ name: "Label", text: "Idle" }] },
    variants: [{ when: { Kind: "primary" }, set: { fill: "#2563eb" } },
      { when: { State: "loading" }, set: { "Label.text": "Loading" } },
      { when: { Content: "text" }, set: { padding: 16 } }],
  }), "--json"]);
  await run(["component", "define", path, "--intent", await file("composer.json", {
    name: "Composer", base: { layout: "row", children: [{ name: "Send", use: "Sender" }] },
  }), "--json"]);
  await run(["page", "draw", path, "--intent", await file("page.json", {
    page: "Compose", children: [
      { name: "Direct", use: "Sender", props: { Kind: "primary", Content: "text" } },
      { name: "Nested", use: "Composer", set: { "Send.props": { Kind: "primary", Content: "text" } } },
    ],
  }), "--json"]);
  const before = await openPackage(path);
  const components = canonicalJSON([...before.domain.componentSets.values()]);
  const pageId = before.manifest.entries.screens.map((entry) => before.entries[entry]).find((screen) => screen.name === "Compose").id;
  const beforeNodes = Object.values(projectScreen(before, pageId).nodes);
  const ids = beforeNodes.map(({ id }) => id).sort();
  const expected = { axis_kind: "primary", axis_state: "loading", axis_content: "text" };
  for (const [element, set] of [
    ["Direct", { props: { State: "loading" } }],
    ["Nested", { set: { "Send.props": { State: "loading" } } }],
  ]) {
    await run(["page", "set", path, "--page", "Compose", "--element", element, "--intent", await file(`${element}.json`, { set }), "--json"]);
    const snapshot = await openPackage(path);
    const nodes = Object.values(projectScreen(snapshot, pageId).nodes);
    const sender = nodes.find((node) => node.name === (element === "Direct" ? "Direct" : "Send"));
    assert.deepEqual(sender.variantSelection, expected, `${element}: changing State keeps Kind and Content`);
    assert.equal(sender.fills[0].color, "#2563eb");
    if (element === "Nested") {
      const parent = nodes.find((node) => node.name === "Nested");
      assert.ok(sender.y >= 0 && parent.height >= sender.y + sender.height,
        "a hugging parent must contain the newly selected nested variant");
    }
    const label = nodes.find((node) => node.name === "Label" && node.id.startsWith(`${sender.id}__`));
    assert.equal(label.text, "Loading");
    assert.equal(canonicalJSON([...snapshot.domain.componentSets.values()]), components, "editing a copy leaves definitions unchanged");
    assert.deepEqual(nodes.map(({ id }) => id).sort(), ids, "editing keeps canonical and projected IDs stable");
  }
  const revision = (await openPackage(path)).revision;
  const preview = await run(["export", path, "--page", "Compose", "--element", "Nested", "--format", "png", "--evidence", "--output", join(root, "preview"), "--json"]);
  const image = PNG.sync.read(await readFile(preview.imagePath));
  let bluePixels = 0;
  for (let i = 0; i < image.data.length; i += 4)
    if (image.data[i] === 37 && image.data[i + 1] === 99 && image.data[i + 2] === 235 && image.data[i + 3] === 255) bluePixels++;
  assert.ok(bluePixels > 100, "the native preview retains the primary color after changing only State");
  const spec = await run(["view", path, "--page", "Compose", "--element", "Nested", "--as", "spec", "--json"]);
  assert.equal(spec.layout.hash, preview.layout.hash, "preview and specification describe the same native layout");
  assert.equal((await openPackage(path)).revision, revision, "rendering does not rewrite the design");
});

test("editing one text style in a copy preserves its earlier style overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-copy-style-"));
  const path = (await run(["project", "init", join(root, "demo"), "--json"])).packagePath;
  const file = async (name, value) => { const at = join(root, name); await writeFile(at, JSON.stringify(value)); return at; };
  await run(["component", "define", path, "--intent", await file("button.json", {
    name: "Button", base: { layout: "row", padding: 8, children: [{ name: "Label", text: "Save", fontSize: 14, fontWeight: 400 }] },
  }), "--json"]);
  await run(["page", "draw", path, "--intent", await file("page.json", {
    page: "Styles", children: [{ name: "Save", use: "Button", set: { "Label.fontSize": 20 } }],
  }), "--json"]);
  await run(["page", "set", path, "--page", "Styles", "--element", "Save", "--set", 'set={"Label.fontWeight":700}', "--json"]);
  const snapshot = await openPackage(path);
  const label = Object.values(projectScreen(snapshot, "scr_styles").nodes).find((node) => node.name === "Label");
  assert.equal(label.textStyle.fontWeight, 700);
  assert.equal(label.textStyle.fontSize, 20, "changing weight must not reset the earlier font size to the definition's 14");
});
