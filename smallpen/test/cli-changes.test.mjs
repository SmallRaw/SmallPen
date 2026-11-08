import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { applyOperationBatch, openPackage } from "../packages/local-package/src/index.mjs";
import { pageHtml } from "./helpers/named.mjs";

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

// The agent's side of the loop: write files, check them, keep the revision.
async function write(path, files) {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(path, name)), { recursive: true });
    await writeFile(join(path, name), content);
  }
  const checked = await run(["check", path, "--json"]);
  assert.equal(checked.ok, true, JSON.stringify(checked.issues));
  return checked.revision;
}

// A person's edit in the App: the App replaces the page through a batch.
async function appEdit(path, pageName, batchId, edit) {
  const snapshot = await openPackage(path);
  const entry = snapshot.manifest.entries.screens.find((name) => snapshot.entries[name].name === pageName);
  const screen = structuredClone(snapshot.entries[entry]);
  edit(Object.values(screen.presentations[0].nodes), screen);
  await applyOperationBatch(path, { baseRevision: snapshot.revision, batchId, operations: [{ type: "put-screen", entry, screen }] });
}

test("changes tells an agent, by name, what a person changed in the App since the revision it saw", async () => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-changes-"));
  const path = (await run(["init", join(root, "demo"), "--json"])).packagePath;
  const seen = await write(path, {
    "tokens.css": ":root {\n  --color-brand: #4f46e5;\n}\n",
    "pages/Tasks/Board.html": pageHtml(`<body class="flex flex-row">
  <div data-name="Sidebar" class="w-[240px] h-full"></div>
  <div data-name="Content" class="w-full h-full"></div>
</body>`, { title: "Board", depth: 2 }),
  });
  assert.equal((await run(["changes", path, "--since", seen, "--json"])).changeCount, 0);

  // A person widens the sidebar in the App.
  await appEdit(path, "Tasks / Board", "app-edit-1", (nodes) => {
    nodes.find(({ name }) => name === "Sidebar").width = 280;
  });
  // The agent itself edits tokens.css too.
  await write(path, { "tokens.css": ":root {\n  --color-brand: #5b21b6;\n}\n" });

  const changes = await run(["changes", path, "--since", seen, "--json"]);
  assert.equal(changes.appSaves, 1);
  assert.match(changes.text, /color-brand: changed — #4f46e5 → #5b21b6/);
  assert.match(changes.text, /Tasks \/ Board \(desktop\) \/ Sidebar: changed — size 240×fill → 280×fill/);
  assert.ok(!changes.text.includes("node_"), "names, not IDs");
  assert.ok(changes.nextOperations.some(({ argv }) => argv.includes("--page")));

  const recent = await run(["changes", path, "--json"]);
  assert.equal(recent.recent[0].by, "app");
  // Each recent write names what it changed, down to the element.
  assert.deepEqual(recent.recent[0].changed, ["Tasks / Board (desktop) / Sidebar"]);
  const unknown = await run(["changes", path, "--since", "deadbeef", "--json"], 1);
  assert.equal(unknown.error.code, "unknown_revision");
});

test("changes names what a person changed inside a placed component copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-changes-copy-"));
  const path = (await run(["init", join(root, "demo"), "--json"])).packagePath;
  const seen = await write(path, {
    "tokens.css": ':root {\n  --color-brand: #4f46e5;\n  --string-task-new: "New task";\n}\n',
    "components/Button.html": `<sp-component name="Button" props="Style: primary | secondary">
  <div class="flex flex-row px-[16px] py-[8px] bg-brand">
    <p data-name="Label" class="text-[#ffffff]">Go</p>
  </div>
  <sp-variant when="Style: secondary" class="bg-[#ffffff]"></sp-variant>
</sp-component>
`,
    "pages/Board.html": pageHtml(`<body>
  <sp-use component="Button" data-name="New task">
    <p data-name="Label" data-text="task-new"></p>
  </sp-use>
</body>`, { title: "Board" }),
  });

  // In the App a person retypes the label and switches the copy to secondary.
  await appEdit(path, "Board", "app-copy-edit", (nodes) => {
    const copy = nodes.find(({ name }) => name === "New task");
    const label = Object.keys(copy.instance.overrides).find((key) => key.endsWith(":text")).split(":")[0];
    const style = Object.keys(copy.instance.variant)[0];
    copy.instance.variant = { ...copy.instance.variant, [style]: "secondary" };
    copy.instance.overrides = { [`${label}:text`]: "Add task" };
  });
  const changes = await run(["changes", path, "--since", seen, "--json"]);
  assert.match(changes.text, /New task: changed — .*variant Style: primary → Style: secondary/);
  assert.match(changes.text, /Label text string-task-new → "Add task"/, "the label stopped following its Token");
  assert.ok(!/node_|axis_|overrides changed/.test(changes.text), "names only");
});

test("changes leaves out what auto layout decides: a flex child's place and a filled size", async () => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-changes-flex-"));
  const path = (await run(["init", join(root, "demo"), "--json"])).packagePath;
  const seen = await write(path, {
    "pages/Row.html": pageHtml(`<body class="flex flex-row">
  <div data-name="Fixed" class="w-[100px] h-[40px]"></div>
  <div data-name="Grow" class="w-full h-[40px]"></div>
  <div data-name="Free" class="absolute left-[10px] top-[10px] w-[50px] h-[50px]"></div>
</body>`, { title: "Row" }),
  });
  // The App writes back the places and sizes its layout computed.
  await appEdit(path, "Row", "app-reflow", (nodes) => {
    const byName = (name) => nodes.find((node) => node.name === name);
    byName("Fixed").x = 240;
    byName("Grow").x = 360;
    byName("Grow").width = 977;
    byName("Fixed").height = 44;
  });
  const changes = await run(["changes", path, "--since", seen, "--json"]);
  assert.doesNotMatch(changes.text, /position/, "a flex child's place is the layout's");
  assert.doesNotMatch(changes.text, /Grow/, "a filled width is the layout's");
  assert.match(changes.text, /Fixed: changed — size 100×40 → 100×44/, "a fixed size is the design's");
});
