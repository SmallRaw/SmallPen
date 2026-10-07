import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyOperationBatch, openPackage } from "../packages/local-package/src/index.mjs";

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

async function file(root, name, value) {
  const path = join(root, name);
  await writeFile(path, JSON.stringify(value));
  return path;
}

test("changes tells an agent, by name, what a person changed in the App since the revision it saw", async () => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-changes-"));
  const path = (await run(["project", "init", join(root, "demo"), "--json"])).packagePath;
  await run(["token", "set", path, "--intent", await file(root, "tokens.json", {
    tokens: [{ name: "color.brand", type: "color", value: "#4f46e5" }],
  }), "--json"]);
  const drawn = await run(["page", "draw", path, "--intent", await file(root, "board.json", {
    page: "Board", module: "Tasks", layout: "row",
    children: [{ name: "Sidebar", width: 240, height: "fill" }, { name: "Content", width: "fill", height: "fill" }],
  }), "--json"]);
  const seen = drawn.revision;
  assert.equal((await run(["changes", path, "--since", seen, "--json"])).changeCount, 0);

  // A person widens the sidebar in the App: the App writes a batch as well.
  const snapshot = await openPackage(path);
  const entry = snapshot.manifest.entries.screens.find((name) => snapshot.entries[name].name === "Tasks / Board");
  const screen = structuredClone(snapshot.entries[entry]);
  const sidebar = Object.values(screen.presentations[0].nodes).find(({ name }) => name === "Sidebar");
  sidebar.width = 280;
  await applyOperationBatch(path, {
    baseRevision: snapshot.revision,
    batchId: "app-edit-1",
    operations: [{ type: "put-screen", entry, screen }],
  });
  // The agent itself changes a Token too.
  await run(["token", "set", path, "--intent", await file(root, "brand.json", {
    tokens: [{ name: "color.brand", value: "#5b21b6" }],
  }), "--json"]);

  const changes = await run(["changes", path, "--since", seen, "--json"]);
  assert.deepEqual(changes.by, { app: 1, cli: 1 });
  assert.match(changes.text, /color\.brand: changed — #4f46e5 → #5b21b6/);
  assert.match(changes.text, /Tasks \/ Board \(desktop\) \/ Sidebar: changed — size 240×fill → 280×fill/);
  assert.ok(!changes.text.includes("node_"), "names, not IDs");
  assert.ok(changes.nextOperations.some(({ argv }) => argv.includes("--page")));

  const recent = await run(["changes", path, "--json"]);
  assert.equal(recent.recent[1].by, "app");
  // Each recent write names what it changed, down to the element.
  assert.deepEqual(recent.recent[1].changed, ["Tasks / Board (desktop) / Sidebar"]);
  const unknown = await run(["changes", path, "--since", "deadbeef", "--json"], 1);
  assert.equal(unknown.error.code, "unknown_revision");
});

test("changes names what a person changed inside a placed component copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-changes-copy-"));
  const path = (await run(["project", "init", join(root, "demo"), "--json"])).packagePath;
  await run(["token", "set", path, "--intent", await file(root, "tokens.json", {
    tokens: [{ name: "text.task.new", type: "string", value: "New task" }, { name: "color.brand", type: "color", value: "#4f46e5" }],
  }), "--json"]);
  await run(["component", "define", path, "--intent", await file(root, "button.json", {
    name: "Button", properties: { Style: ["primary", "secondary"] },
    base: { layout: "row", padding: [8, 16], fill: "{color.brand}", children: [{ name: "Label", text: "Go", color: "#ffffff" }] },
    variants: [{ when: { Style: "secondary" }, set: { fill: "#ffffff" } }],
  }), "--json"]);
  const seen = (await run(["page", "draw", path, "--intent", await file(root, "board.json", {
    page: "Board", children: [{ name: "New task", use: "Button", text: { Label: "{text.task.new}" } }],
  }), "--json"])).revision;

  // In the App a person retypes the label and switches the copy to secondary.
  const snapshot = await openPackage(path);
  const entry = snapshot.manifest.entries.screens.find((name) => snapshot.entries[name].name === "Board");
  const screen = structuredClone(snapshot.entries[entry]);
  const copy = Object.values(screen.presentations[0].nodes).find(({ name }) => name === "New task");
  const label = Object.keys(copy.instance.overrides)[0].split(":")[0];
  copy.instance.variant = { ...copy.instance.variant, axis_style: "secondary" };
  copy.instance.overrides = { [`${label}:text`]: "Add task" };
  await applyOperationBatch(path, {
    baseRevision: snapshot.revision,
    batchId: "app-copy-edit",
    operations: [{ type: "put-screen", entry, screen }],
  });
  const changes = await run(["changes", path, "--since", seen, "--json"]);
  assert.match(changes.text, /New task: changed — .*variant Style=primary → Style=secondary/);
  assert.match(changes.text, /Label text text\.task\.new → "Add task"/, "the label stopped following its Token");
  assert.ok(!/node_|axis_|overrides changed/.test(changes.text), "names only");
});

test("changes leaves out what auto layout decides: a flex child's place and a filled size", async () => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-changes-flex-"));
  const path = (await run(["project", "init", join(root, "demo"), "--json"])).packages.package.path;
  const drawn = await run(["page", "draw", path, "--intent", await file(root, "row.json", {
    page: "Row", layout: "row", children: [
      { name: "Fixed", width: 100, height: 40 },
      { name: "Grow", width: "fill", height: 40 },
      { name: "Free", width: 50, height: 50, x: 10, y: 10 },
    ],
  }), "--json"]);
  // The App writes back the places and sizes its layout computed.
  const snapshot = await openPackage(path);
  const entry = snapshot.manifest.entries.screens.find((name) => snapshot.entries[name].name === "Row");
  const screen = structuredClone(snapshot.entries[entry]);
  const nodes = Object.values(screen.presentations[0].nodes);
  const byName = (name) => nodes.find((node) => node.name === name);
  byName("Fixed").x = 240;
  byName("Grow").x = 360;
  byName("Grow").width = 977;
  byName("Fixed").height = 44;
  await applyOperationBatch(path, { baseRevision: snapshot.revision, batchId: "app-reflow", operations: [{ type: "put-screen", entry, screen }] });
  const changes = await run(["changes", path, "--since", drawn.revision, "--json"]);
  assert.doesNotMatch(changes.text, /position/, "a flex child's place is the layout's");
  assert.doesNotMatch(changes.text, /Grow/, "a filled width is the layout's");
  assert.match(changes.text, /Fixed: changed — size 100×40 → 100×44/, "a fixed size is the design's");
});
