import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { openPackage } from "@smallpen/local-package";

const execute = promisify(execFile);
const cli = new URL("../apps/cli/bin/smallpen.mjs", import.meta.url).pathname;

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-edit-preservation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = async (...args) => {
    const { stdout } = await execute(process.execPath, [
      cli,
      ...args,
      "--json",
    ]);
    return JSON.parse(stdout);
  };
  const path = (await run("project", "init", join(root, "app"))).packages
    .package.path;
  const intent = async (name, value) => {
    const file = join(root, name);
    await writeFile(file, JSON.stringify(value));
    return file;
  };
  return { path, run, intent };
}

async function instance(path, page, name) {
  const snapshot = await openPackage(path);
  const screen = snapshot.manifest.entries.screens
    .map((entry) => snapshot.entries[entry])
    .find((item) => item.name === page);
  return Object.values(screen.presentations[0].nodes).find(
    (node) => node.name === name,
  );
}

for (const into of [undefined, "Content"]) {
  test(`page draw preserves links inside surviving copies${into ? " when redrawing a container" : ""}`, async (t) => {
    const { path, run, intent } = await project(t);
    await run(
      "component",
      "define",
      path,
      "--intent",
      await intent("card.json", {
        name: "Card",
        base: {
          children: [
            { name: "Actions", children: [{ name: "Open", text: "Open" }] },
          ],
        },
      }),
    );
    const children = [{ name: "C", use: "Card" }];
    const page = await intent("page.json", {
      page: "Links",
      children: [{ name: "Content", children }],
    });
    await run("page", "draw", path, "--intent", page);
    await run(
      "page",
      "draw",
      path,
      "--intent",
      await intent("detail.json", {
        page: "Detail",
        children: [{ name: "Title", text: "Detail" }],
      }),
    );
    await run(
      "flow",
      "link",
      path,
      "--from",
      "Links / Content / C / Actions / Open",
      "--to",
      "Detail",
    );
    const before = await run("flow", "list", path);
    const redraw = into
      ? await intent("redraw.json", { page: "Links", into, children })
      : page;
    await run("page", "draw", path, "--intent", redraw);
    const after = await run("flow", "list", path);
    assert.equal(after.text, before.text);
    assert.equal(after.counts.links, 1);
    assert.equal((await run("validate", path)).status, "valid");
    await run(
      "flow",
      "unlink",
      path,
      "--from",
      "Links / Content / C / Actions / Open",
    );
    assert.equal((await run("flow", "list", path)).counts.links, 0);
  });
}

test("repeating an instance text edit keeps the same stored and projected size", async (t) => {
  const { path, run, intent } = await project(t);
  await run(
    "component",
    "define",
    path,
    "--intent",
    await intent("button.json", {
      name: "Button",
      base: {
        layout: "row",
        padding: 8,
        children: [{ name: "Label", text: "Go" }],
      },
    }),
  );
  await run(
    "page",
    "draw",
    path,
    "--intent",
    await intent("home.json", {
      page: "Home",
      children: [{ name: "Save", use: "Button" }],
    }),
  );
  const args = [
    "page",
    "set",
    path,
    "--page",
    "Home",
    "--element",
    "Save",
    "--set",
    'text={"Label":"Save all changes"}',
  ];
  await run(...args);
  const first = await instance(path, "Home", "Save");
  const view = await run("view", path, "--page", "Home");
  await run(...args);
  const second = await instance(path, "Home", "Save");
  assert.deepEqual(second, first);
  assert.equal((await run("view", path, "--page", "Home")).text, view.text);
});

test("editing one label retains another label's required space and can shrink back", async (t) => {
  const { path, run, intent } = await project(t);
  await run(
    "component",
    "define",
    path,
    "--intent",
    await intent("pair.json", {
      name: "Pair",
      base: {
        layout: "row",
        padding: 8,
        gap: 8,
        children: [
          { name: "Left", text: "A" },
          { name: "Right", text: "B" },
        ],
      },
    }),
  );
  await run(
    "page",
    "draw",
    path,
    "--intent",
    await intent("home.json", {
      page: "Home",
      children: [{ name: "Pair", use: "Pair" }],
    }),
  );
  const initial = await instance(path, "Home", "Pair");
  const set = (...args) =>
    run("page", "set", path, "--page", "Home", "--element", "Pair", ...args);
  await set(
    "--set",
    'text={"Left":"A very long left label","Right":"A very long right label"}',
  );
  const wide = await instance(path, "Home", "Pair");
  await set("--set", 'text={"Right":"A very long right label"}');
  assert.equal((await instance(path, "Home", "Pair")).width, wide.width);
  await set("--set", 'text={"Left":"A","Right":"B"}');
  const short = await instance(path, "Home", "Pair");
  assert.equal(short.width, initial.width);
  const report = await run("validate", path, "--page", "Home");
  assert.ok(
    !report.issues.some(({ code }) =>
      ["content_overflow", "outside_root", "text_overflow"].includes(code),
    ),
    JSON.stringify(report.issues),
  );
});

test("an explicit instance width survives later and simultaneous text edits", async (t) => {
  const { path, run, intent } = await project(t);
  await run(
    "component",
    "define",
    path,
    "--intent",
    await intent("button.json", {
      name: "Button",
      base: {
        layout: "row",
        padding: 8,
        children: [{ name: "Label", text: "Go" }],
      },
    }),
  );
  await run(
    "page",
    "draw",
    path,
    "--intent",
    await intent("home.json", {
      page: "Home",
      children: [{ name: "Save", use: "Button" }],
    }),
  );
  const set = (...args) =>
    run("page", "set", path, "--page", "Home", "--element", "Save", ...args);
  await set("--set", 'text={"Label":"Save all changes"}');
  await set("--set", "width=300");
  for (let repeat = 0; repeat < 2; repeat += 1) {
    await set("--set", 'text={"Label":"Go"}');
    assert.equal((await instance(path, "Home", "Save")).width, 300);
  }
  await set("--set", "width=240", "--set", 'text={"Label":"Save all changes"}');
  assert.equal((await instance(path, "Home", "Save")).width, 240);
});

test("redrawing a copy as a different component does not retain its old child links", async (t) => {
  const { path, run, intent } = await project(t);
  for (const name of ["Card", "Other"])
    await run(
      "component",
      "define",
      path,
      "--intent",
      await intent(`${name}.json`, {
        name,
        base: { children: [{ name: "Open", text: "Open" }] },
      }),
    );
  await run(
    "page",
    "draw",
    path,
    "--intent",
    await intent("home.json", {
      page: "Home",
      children: [{ name: "C", use: "Card" }],
    }),
  );
  await run(
    "page",
    "draw",
    path,
    "--intent",
    await intent("detail.json", {
      page: "Detail",
      children: [{ name: "Title", text: "Detail" }],
    }),
  );
  await run(
    "flow",
    "link",
    path,
    "--from",
    "Home / C / Open",
    "--to",
    "Detail",
  );
  await run(
    "page",
    "draw",
    path,
    "--intent",
    await intent("redraw.json", {
      page: "Home",
      children: [{ name: "C", use: "Other" }],
    }),
  );
  assert.equal((await run("flow", "list", path)).counts.links, 0);
  assert.equal((await run("validate", path)).status, "valid");
});
