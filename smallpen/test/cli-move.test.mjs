import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "smallpen-move-"));
  const path = (await run(["project", "init", join(root, "demo"), "--json"])).packagePath;
  const file = async (name, value) => { const at = join(root, name); await writeFile(at, JSON.stringify(value)); return at; };
  return { path, file };
}

const nodesOf = async (path, page) => {
  const { entries } = await openPackage(path);
  const screen = Object.entries(entries).find(([key, value]) => key.startsWith("screens/") && value?.name === page)?.[1];
  assert.ok(screen, `page ${page} is stored`);
  return Object.fromEntries(Object.values(screen.presentations[0].nodes).map((node) => [node.name, node]));
};
const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test("without auto layout the CLI places elements so none overlap, next to a named sibling when asked", async () => {
  const { path, file } = await setup();
  await run(["page", "draw", path, "--intent", await file("board.json", {
    page: "Board", layout: "none", gap: 20, children: [
      { name: "Header", width: 300, height: 40 },
      { name: "Hero", width: 300, height: 120 },
      { name: "Aside", width: 100, height: 120, place: "rightOf Hero" },
      { name: "Note", width: 200, height: 30, place: { below: "Aside", gap: 8 } },
      { name: "Pinned", width: 50, height: 50, x: 400, y: 0 },
    ],
  }), "--json"]);
  const nodes = await nodesOf(path, "Board");
  assert.deepEqual([nodes.Header.y, nodes.Hero.y], [0, 60], "unplaced elements stack with the gap");
  assert.deepEqual([nodes.Aside.x, nodes.Aside.y], [320, 60]);
  assert.deepEqual([nodes.Note.x, nodes.Note.y], [320, 188]);
  assert.deepEqual([nodes.Pinned.x, nodes.Pinned.y], [400, 0], "an element's own x/y stays");
  const placed = ["Header", "Hero", "Aside", "Note"].map((name) => nodes[name]);
  for (const [index, a] of placed.entries())
    for (const b of placed.slice(index + 1)) assert.ok(!overlap(a, b), `${a.name} and ${b.name} do not overlap`);
});

test("page move reorders auto layout and swaps places otherwise, never by coordinates", async () => {
  const { path, file } = await setup();
  await run(["page", "draw", path, "--intent", await file("list.json", {
    page: "List", children: [
      { name: "First", width: 100, height: 20 },
      { name: "Second", width: 100, height: 20 },
      { name: "Third", width: 100, height: 20 },
    ],
  }), "--json"]);
  await run(["page", "move", path, "--page", "List", "--element", "Third", "--direction", "up", "--steps", "2", "--json"]);
  const list = await run(["view", path, "--page", "List", "--json"]);
  assert.ok(list.text.indexOf("Third") < list.text.indexOf("First"), "Third is now first in the column");
  const across = await run(["page", "move", path, "--page", "List", "--element", "First", "--direction", "left", "--json"], 1);
  assert.equal(across.error.code, "move_across_layout");

  await run(["page", "draw", path, "--intent", await file("free.json", {
    page: "Free", layout: "none", children: [
      { name: "Top", width: 200, height: 40 },
      { name: "Bottom", width: 200, height: 80 },
    ],
  }), "--json"]);
  await run(["page", "move", path, "--page", "Free", "--element", "Bottom", "--direction", "up", "--json"]);
  const free = await nodesOf(path, "Free");
  assert.deepEqual([free.Bottom.y, free.Top.y], [0, 96], "the two swap places and keep their gap");
  const edge = await run(["page", "move", path, "--page", "Free", "--element", "Bottom", "--direction", "up", "--json"], 1);
  assert.equal(edge.error.code, "nothing_to_move_past");
});
