import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defaultTokenWorkspace, projectScreen, selectTokenThemes } from "@smallpen/core";
import { openPackage } from "@smallpen/local-package";

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
  await run(["theme", "add", path, "--theme", "Mode/Light", "--theme", "Mode/Dark", "--json"]);
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
