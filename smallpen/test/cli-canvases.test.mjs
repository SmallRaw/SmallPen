import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canvasLayout } from "@smallpen/core";
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

async function app() {
  const root = await mkdtemp(join(tmpdir(), "smallpen-canvas-"));
  const path = (await run(["project", "init", join(root, "demo"), "--json"])).packagePath;
  const file = async (name, value) => { const at = join(root, name); await writeFile(at, JSON.stringify(value)); return at; };
  const draw = async (page, module, platform = "desktop", extra = {}) =>
    run(["page", "draw", path, "--intent", await file(`${module}-${page}-${platform}.json`, {
      page, module, platform, children: [{ name: "Title", text: page }], ...extra,
    }), "--json"]);
  // Tasks: list → detail → edit, drawn out of order; one mobile version.
  await draw("Edit", "Tasks");
  await draw("List", "Tasks");
  await draw("Detail", "Tasks");
  await draw("List", "Tasks", "mobile");
  await draw("Login", "Account");
  await run(["flow", "start", path, "--page", "List", "--json"]);
  await run(["page", "draw", path, "--intent", await file("list-link.json", {
    page: "List", module: "Tasks", children: [{ name: "Open", text: "Open" }],
  }), "--json"]);
  await run(["flow", "link", path, "--from", "Tasks / List / Open", "--to", "Detail", "--json"]);
  await run(["page", "draw", path, "--intent", await file("detail-link.json", {
    page: "Detail", module: "Tasks", children: [{ name: "Edit button", text: "Edit" }],
  }), "--json"]);
  await run(["flow", "link", path, "--from", "Tasks / Detail / Edit button", "--to", "Edit", "--json"]);
  return { path, file, draw };
}

const layoutOf = async (path) => {
  const snapshot = await openPackage(path);
  const names = new Map(snapshot.manifest.entries.screens.map((entry) => [snapshot.entries[entry].id, snapshot.entries[entry].name]));
  return canvasLayout(snapshot.manifest, snapshot.entries, snapshot.runtime).map((canvas) => ({
    name: canvas.name,
    boards: canvas.boards.map((board) => ({ ...board, page: names.get(board.screenId) })),
  }));
};

test("every page sits on one canvas: a business flow per row block, pages in flow order, versions lined up", async () => {
  const { path } = await app();
  const [canvas, ...others] = await layoutOf(path);
  assert.equal(others.length, 0, "the starter page and every other page share the one canvas");
  const tasks = canvas.boards.filter(({ flow }) => flow === "Tasks");
  const desktop = tasks.filter(({ platform }) => platform === "desktop");
  assert.deepEqual(desktop.map(({ page }) => page), ["Tasks / List", "Tasks / Detail", "Tasks / Edit"], "start, then along the links");
  assert.ok(desktop[0].x < desktop[1].x && desktop[1].x < desktop[2].x && new Set(desktop.map(({ y }) => y)).size === 1);
  const mobile = tasks.find(({ platform }) => platform === "mobile");
  assert.equal(mobile.x, desktop[0].x, "a page's versions line up in one column");
  assert.ok(mobile.y > desktop[0].y + desktop[0].height);
  const account = canvas.boards.find(({ flow }) => flow === "Account");
  const tasksBottom = Math.max(...tasks.map(({ y, height }) => y + height));
  assert.ok(account.y - tasksBottom >= 400, "another business flow starts lower, with more room");
  const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  for (const [index, a] of canvas.boards.entries())
    for (const b of canvas.boards.slice(index + 1)) assert.ok(!overlaps(a, b), `${a.page} and ${b.page} do not overlap`);
});

test("pages move left or right in their flow, onto other canvases, and canvases take names", async () => {
  const { path } = await app();
  await run(["page", "move", path, "--page", "Edit", "--direction", "left", "--json"]);
  let canvas = (await layoutOf(path))[0];
  assert.deepEqual(
    canvas.boards.filter(({ flow, platform }) => flow === "Tasks" && platform === "desktop").map(({ page }) => page),
    ["Tasks / List", "Tasks / Edit", "Tasks / Detail"],
  );
  const across = await run(["page", "move", path, "--page", "Edit", "--direction", "up", "--json"], 1);
  assert.equal(across.error.code, "move_across_layout");

  await run(["canvas", "put", path, "--page", "Login", "--canvas", "Account flows", "--json"]);
  await run(["canvas", "rename", path, "--canvas", "Pages", "--to", "App", "--json"]);
  const listed = await run(["canvas", "list", path, "--json"]);
  assert.deepEqual(listed.canvases.map(({ name }) => name), ["App", "Account flows"]);
  assert.match(listed.text, /Tasks row \[desktop, mobile\]: Tasks \/ List, Tasks \/ Edit, Tasks \/ Detail/);
});

test("view --canvas reads and draws the whole canvas", async () => {
  const { path } = await app();
  const text = await run(["view", path, "--canvas", "Pages", "--json"]);
  assert.match(text.text, /Tasks row\n\s+desktop: Tasks \/ List [0-9]+×[0-9]+, Tasks \/ Detail/);
  const png = await run(["view", path, "--canvas", "Pages", "--as", "png", "--json"]);
  assert.ok((await stat(png.output)).size > 0);
  const unknown = await run(["view", path, "--canvas", "Nope", "--json"], 1);
  assert.equal(unknown.error.code, "unknown_canvas");
});

test("dragging a page's board in the App reorders its flow; the CLI keeps the layout", async () => {
  const { compilePenpotChanges } = await import("@smallpen/penpot-adapter");
  const { projectEffectiveSnapshot, withCanvasPositions, prepareOperationBatch } = await import("@smallpen/core");
  const { path } = await app();
  const snapshot = await openPackage(path);
  const served = withCanvasPositions(projectEffectiveSnapshot(snapshot, {}));
  const board = served.canvases[0].boards.find(({ screenId, platform }) => screenId === "scr_tasks_edit" && platform === "desktop");
  const list = served.canvases[0].boards.find(({ screenId, platform }) => screenId === "scr_tasks_list" && platform === "desktop");
  // Drop Edit just left of List.
  const rootId = served.runtime.nodes.scr_tasks_edit.pres_tasks_edit_desktop.node_tasks_edit_desktop_root;
  const compiled = compilePenpotChanges(served, {
    changes: [{
      id: rootId, type: "mod-obj", "page-id": served.runtime.canvases[0].pageId,
      operations: [{ attr: "x", type: "set", val: list.x - 50 }, { attr: "y", type: "set", val: board.y }],
    }],
    commitId: "drag-board",
  });
  // (Penpot also sends the children's new positions; this test sends the
  // board alone, so only the board itself is checked.)
  assert.ok(!compiled.operations.some(({ nodeId }) => nodeId === "node_tasks_edit_desktop_root"), "the board's position is not stored");
  assert.ok(compiled.operations.some(({ type }) => type === "put-canvases"), "its order is");
  const next = (await prepareOperationBatch(snapshot, { ...compiled, operations: compiled.operations.filter(({ type }) => type === "put-canvases") })).snapshot;
  const order = canvasLayout(next.manifest, next.entries, next.runtime)[0].boards
    .filter(({ flow, platform }) => flow === "Tasks" && platform === "desktop")
    .map(({ screenId }) => screenId);
  assert.deepEqual(order, ["scr_tasks_edit", "scr_tasks_list", "scr_tasks_detail"]);
});
