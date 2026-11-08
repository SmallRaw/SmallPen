import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openPackage } from "@smallpen/local-package";
import { COMMAND_GROUPS } from "../apps/cli/bin/command-tree.mjs";
import { pageHtml, seedLegacyIds } from "./helpers/named.mjs";

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
  assert.ok(root.commands.some(({ command }) => command === "check"));
  assert.ok(!root.commands.some(({ command }) => command === "project"));
  assert.ok(
    !root.commands.some(({ command }) => command === "effective-token"),
  );
  const group = await run(["help", "token"]);
  assert.deepEqual(
    group.actions.map(({ action }) => action),
    // Reads only: Tokens change by editing tokens.css.
    ["list", "export"],
  );
  assert.equal(group.parameters, undefined);
  const action = await run(["help", "token", "list"]);
  assert.equal(action.command, "token list");
  const contract = await run(action.nextOperations[0].argv);
  assert.equal(contract.command, "token list");
  assert.ok(contract.parameters.token, "agents name Tokens by name");
  assert.ok(!contract.parameters.intent);
  const bad = await run(["token", "shwo", "missing.smallpen"], 1);
  assert.equal(bad.error.code, "unknown_action");
});

test("a page is a file to add or remove, and view reads it by name", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-groups-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "acme.smallpen");
  await cp(fixture, path, { recursive: true });
  await seedLegacyIds(path, "variant-acme");
  assert.ok((await run(["token", "list", path])).themes.length);
  const settings = join(path, "pages", "Settings.mobile.html");
  await writeFile(settings, pageHtml(`<body>
  <p data-name="Title" class="left-[24px] top-[24px]">Settings</p>
  <sp-use component="Button" data-name="Back" class="left-[24px] top-[80px]"></sp-use>
</body>`, { title: "Settings" }));
  assert.equal((await run(["check", path])).ok, true);
  const page = await run(["view", path, "--page", "Settings", "--as", "text"]);
  assert.equal(page.target.page, "Settings");
  assert.match(page.text, /Title/);
  assert.match(page.text, /Button/);
  await rm(settings);
  assert.equal((await run(["view", path, "--page", "Settings"], 1)).error.code, "unknown_page");
});

test("every public action exposes an executable parameter and input schema", async () => {
  for (const [group, { actions }] of Object.entries(COMMAND_GROUPS)) {
    for (const action of Object.keys(actions)) {
      const help = await run(["help", group, action]);
      assert.ok(
        Buffer.byteLength(JSON.stringify(help)) < (help.input ? 8192 : 3072),
        `${group} ${action}`,
      );
      for (const next of help.nextOperations) await run(next.argv);
    }
  }
});

test("view formats and PNG exports share one target named by component or page", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-groups-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "acme.smallpen");
  await cp(fixture, path, { recursive: true });
  await seedLegacyIds(path, "variant-acme");
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
  await seedLegacyIds(path, "variant-acme");
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
