import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openPackage } from "@smallpen/local-package";
import { COMMAND_GROUPS } from "../apps/cli/bin/command-tree.mjs";

const cli = new URL("../apps/cli/bin/smallpen.mjs", import.meta.url).pathname;
const fixture = new URL("fixtures/variant-acme.smallpen", import.meta.url)
  .pathname;
async function run(argv, code = 0) {
  if (!argv.includes("--json")) argv = [...argv, "--json"];
  if (argv[0] === "schema") argv = [...argv, "--stdout"];
  let result;
  try {
    result = {
      code: 0,
      ...(await promisify(execFile)(process.execPath, [cli, ...argv])),
    };
  } catch (error) {
    result = error;
  }
  assert.equal(result.code, code, result.stdout || result.stderr);
  return JSON.parse(result.stdout);
}

test("help expands from objects to actions to one command contract", async () => {
  const root = await run(["help"]);
  assert.ok(root.commands.some(({ command }) => command === "project"));
  assert.ok(
    !root.commands.some(({ command }) => command === "effective-token"),
  );
  const group = await run(["help", "token"]);
  assert.deepEqual(
    group.actions.map(({ action }) => action),
    [
      "list",
      "show",
      "search",
      "explain",
      "set",
      "delete",
      "impact",
      "export",
      "import",
    ],
  );
  assert.equal(group.parameters, undefined);
  const action = await run(["help", "token", "show"]);
  assert.equal(action.command, "token show");
  const contract = await run(action.nextOperations[0].argv);
  assert.equal(contract.command, "token show");
  assert.ok(contract.parameters.path, "agents name Tokens by path");
  assert.ok(!contract.parameters.intent);
  const bad = await run(["token", "shwo", "missing.smallpen"], 1);
  assert.equal(bad.error.code, "unknown_action");
});

test("grouped commands read and edit real data by name, guard bad input and preserve retry identities", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-groups-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "acme.smallpen");
  await cp(fixture, path, { recursive: true });
  assert.ok((await run(["page", "list", path])).items.length);
  assert.ok((await run(["theme", "list", path])).groups.length);
  const input = join(root, "page.json");
  await writeFile(
    input,
    JSON.stringify({
      page: "Settings",
      platform: "mobile",
      children: [
        { name: "Title", text: "Settings" },
        { name: "Back", use: "Button" },
      ],
    }),
  );
  const created = await run([
    "page",
    "draw",
    path,
    "--intent",
    input,
    "--batch-id",
    "create-settings",
  ]);
  const retry = await run([
    "page",
    "draw",
    path,
    "--intent",
    input,
    "--batch-id",
    "create-settings",
  ]);
  assert.equal(retry.alreadyApplied, true);
  assert.equal(retry.revision, created.revision);
  const page = await run(["view", path, "--page", "Settings", "--as", "text"]);
  assert.equal(page.target.page, "Settings");
  assert.match(page.text, /Title/);
  assert.match(page.text, /Button/);
  await run(["page", "delete", path, "--page", "Settings"]);
  assert.ok(
    !(await run(["page", "list", path])).items.some(
      ({ name }) => name === "Settings",
    ),
  );
  const before = await readFile(join(path, "manifest.json"), "utf8");
  const rejected = await run(["theme", "add", path, "--theme", "Theme"], 1);
  assert.equal(rejected.error.code, "invalid_theme_name");
  assert.equal(await readFile(join(path, "manifest.json"), "utf8"), before);
});

test("flow means actual page interactions, set by page and element name", async (t) => {
  const help = await run(["help", "flow"]);
  assert.deepEqual(
    help.actions.map(({ action }) => action),
    Object.keys(COMMAND_GROUPS.flow.actions),
  );
  const link = await run(["schema", "command", "flow", "link"]);
  assert.equal(link.command, "flow link");
  assert.ok(link.parameters.from && link.parameters.to);
  assert.ok(
    !Object.values(link.parameters).some(
      ({ option }) => /-id$/.test(option) && option !== "--batch-id",
    ),
    "flow link takes names, not ids",
  );
  const root = await mkdtemp(join(tmpdir(), "smallpen-groups-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "acme.smallpen");
  await cp(fixture, path, { recursive: true });
  const input = join(root, "page.json");
  await writeFile(
    input,
    JSON.stringify({
      page: "Settings",
      platform: "mobile",
      children: [{ name: "Back", use: "Button" }],
    }),
  );
  await run(["page", "draw", path, "--intent", input]);
  await run(["flow", "link", path, "--from", "Settings / Back", "--to", "Home"]);
  await run(["flow", "start", path, "--page", "Settings"]);
  const flows = await run(["flow", "list", path]);
  assert.deepEqual(
    flows.starts.map(({ page }) => page),
    ["Settings"],
  );
  assert.deepEqual(
    flows.links.map(({ page, element, on, to }) => ({ page, element, on, to })),
    [{ page: "Settings", element: "Back", on: "click", to: "Home" }],
  );
  await run(["flow", "unlink", path, "--from", "Settings / Back"]);
  await run(["flow", "start", path, "--page", "Settings", "--remove"]);
  const cleared = await run(["flow", "list", path]);
  assert.deepEqual([cleared.starts, cleared.links], [[], []]);
});

test("every public action exposes an executable parameter and input schema", async () => {
  for (const [group, { actions }] of Object.entries(COMMAND_GROUPS)) {
    for (const action of Object.keys(actions)) {
      const help = await run(["help", group, action]);
      assert.ok(
        Buffer.byteLength(JSON.stringify(help)) < 3072,
        `${group} ${action}`,
      );
      for (const next of help.nextOperations) await run(next.argv);
    }
  }
});

test("component, Token and asset actions persist the intended resource by name", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-groups-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "acme.smallpen");
  await cp(fixture, path, { recursive: true });
  const file = join(root, "intent.json");
  const components = async () =>
    (await run(["view", path, "--components", "--as", "text"])).text;
  await writeFile(
    file,
    JSON.stringify({
      name: "Toggle",
      properties: { State: ["on", "off"] },
      base: { layout: "row", padding: 8, children: [{ name: "Label", text: "On" }] },
      variants: [{ when: { State: "off" }, set: { "Label.text": "Off" } }],
    }),
  );
  await run(["component", "define", path, "--intent", file]);
  assert.match(await components(), /Toggle · State: on\|off · 2 variants/);
  await run(["component", "rename", path, "--component", "Toggle", "--to", "Switch"]);
  assert.doesNotMatch(await components(), /Toggle/);
  await run([
    "component",
    "delete",
    path,
    "--component",
    "Switch",
    "--variant",
    "State=off",
  ]);
  assert.equal(
    (await run(["view", path, "--component", "Switch", "--as", "text"])).target
      .variants,
    1,
  );
  await run(["component", "delete", path, "--component", "Switch"]);
  assert.doesNotMatch(await components(), /Switch/);
  const beforeUsed = await readFile(
    join(path, "components", "components.json"),
    "utf8",
  );
  const used = await run(["component", "delete", path, "--component", "Button"], 1);
  assert.equal(used.error.writeState, "not-applied");
  assert.equal(
    await readFile(join(path, "components", "components.json"), "utf8"),
    beforeUsed,
    "a component a page uses stays",
  );
  await run(["theme", "add", path, "--theme", "Brand/Default"]);
  await writeFile(
    file,
    JSON.stringify({
      tokens: [{ name: "color.accent", type: "color", group: "Brand", value: "#6750a4" }],
    }),
  );
  await run(["token", "set", path, "--intent", file]);
  await writeFile(
    file,
    JSON.stringify({ tokens: [{ name: "color.accent", value: "#006699" }] }),
  );
  await run(["token", "set", path, "--intent", file]);
  assert.equal(
    (await run(["token", "show", path, "--path", "color.accent"])).value,
    "#006699",
  );
  await run(["token", "delete", path, "--path", "color.accent"]);
  assert.equal(
    (await run(["token", "list", path])).items.some(
      ({ token }) => token.path === "color.accent",
    ),
    false,
  );
  const colors = async () =>
    (await run(["asset", "list", path, "--kind", "colors"])).items.map(
      ({ asset }) => [asset.path, asset.name, asset.paint.color],
    );
  await run(["asset", "set", path, "--color", "Brand/Accent", "--value", "#006699"]);
  assert.deepEqual(await colors(), [["Brand", "Accent", "#006699"]]);
  await run(["asset", "set", path, "--color", "Brand/Accent", "--value", "#112233"]);
  assert.deepEqual(await colors(), [["Brand", "Accent", "#112233"]]);
  await run(["asset", "delete", path, "--color", "Brand/Accent"]);
  assert.deepEqual(await colors(), []);
});

test("view formats and PNG exports share one target named by component or page", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-groups-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "acme.smallpen");
  await cp(fixture, path, { recursive: true });
  for (const as of ["text", "wireframe"]) {
    const value = await run(["view", path, "--component", "Button", "--as", as]);
    assert.equal(value.as, as);
    assert.equal(value.target.component, "Button");
  }
  const exported = await run([
    "export",
    path,
    "--component",
    "Button",
    "--format",
    "png",
    "--output",
    join(root, "button.png"),
  ]);
  assert.equal(exported.mimeType, "image/png");
  assert.equal(exported.selection.componentId, undefined);
  // The export reply carries no target; its size matches the main variant
  // of the Button component as the named text view reports it.
  const outline = await run(["view", path, "--component", "Button"]);
  assert.equal(outline.target.component, "Button");
  const [, width, height] = outline.text.match(
    /Main variant structure:\nButton · COMPONENT (\d+)×(\d+)/,
  );
  assert.deepEqual(
    [exported.width, exported.height],
    [Number(width), Number(height)],
  );
  assert.equal(
    (await readFile(exported.output)).subarray(0, 8).toString("hex"),
    "89504e470d0a1a0a",
  );
  const page = await run([
    "view",
    path,
    "--page",
    "Home",
    "--as",
    "png",
    "--output",
    join(root, "home.png"),
  ]);
  assert.deepEqual(page.target, { page: "Home", platform: "mobile" });
  assert.equal(page.selection.screenId, undefined);
  assert.equal(
    (await readFile(page.output)).subarray(0, 8).toString("hex"),
    "89504e470d0a1a0a",
  );
});

test("export --evidence writes the review bundle for a page named by name", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-groups-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "acme.smallpen");
  await cp(fixture, path, { recursive: true });
  const evidence = await run([
    "export",
    path,
    "--page",
    "Home",
    "--format",
    "png",
    "--evidence",
    "--output",
    join(root, "review"),
  ]);
  assert.ok(await readFile(evidence.evidencePath));
});
