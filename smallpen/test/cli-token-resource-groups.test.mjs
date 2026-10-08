import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const cli = new URL("../apps/cli/bin/smallpen.mjs", import.meta.url).pathname;
const fixture = new URL("fixtures/variant-acme.smallpen", import.meta.url)
  .pathname;

async function run(argv, code = 0) {
  let result;
  try {
    result = {
      code: 0,
      ...(await promisify(execFile)(process.execPath, [
        cli,
        ...argv,
        "--json",
      ])),
    };
  } catch (error) {
    result = error;
  }
  assert.equal(result.code, code, result.stdout || result.stderr);
  return JSON.parse(result.stdout);
}

test("Token settings and file assets expand from two separate entry points", async () => {
  const root = await run(["help"]);
  const commands = root.commands.map(({ command }) => command);
  assert.ok(commands.includes("token") && commands.includes("asset"));
  for (const name of ["theme", "font", "media"])
    assert.ok(!commands.includes(name), name);
  const tokens = await run(["help", "token"]);
  assert.ok(tokens.actions.some(({ action }) => action === "theme"));
  assert.ok(!tokens.actions.some(({ action }) => action.includes(" ")));
  const themes = await run(["help", "token", "theme"]);
  assert.deepEqual(
    themes.actions.map(({ action }) => action),
    ["list", "add", "rename", "default", "delete"],
  );
  const assets = await run(["help", "asset"]);
  assert.deepEqual(
    assets.actions.map(({ action }) => action),
    ["media", "font"],
  );
  for (const argv of [
    ["token", "theme", "add"],
    ["asset", "font", "import"],
    ["asset", "media", "import"],
    ["advanced", "style", "set"],
  ]) {
    const help = await run(["help", ...argv]);
    assert.equal(help.command, argv.join(" "));
    assert.ok(help.options.length);
    for (const next of help.nextOperations)
      await run(next.argv.filter((arg) => arg !== "--json"));
    assert.equal((await run([...argv, "--help"])).command, help.command);
  }
});

test("nested theme settings share Token defaults without remembering a read selection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-token-groups-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "acme.smallpen");
  await cp(fixture, path, { recursive: true });
  await run([
    "token",
    "theme",
    "add",
    path,
    "--theme",
    "Brand/Light",
    "--theme",
    "Brand/Dark",
  ]);
  const input = join(root, "tokens.json");
  await writeFile(
    input,
    JSON.stringify({
      tokens: [
        {
          name: "color.test",
          type: "color",
          value: "#ffffff",
          values: { "Brand/Dark": "#111111" },
        },
      ],
    }),
  );
  await run(["token", "set", path, "--intent", input]);
  const before = await run([
    "token",
    "theme",
    "list",
    path,
    "--full",
    "--stdout",
  ]);
  assert.equal(
    (
      await run([
        "token",
        "show",
        path,
        "--path",
        "color.test",
        "--theme",
        "Brand/Dark",
      ])
    ).value,
    "#111111",
  );
  assert.equal(
    (await run(["token", "show", path, "--path", "color.test"])).value,
    "#ffffff",
  );
  const after = await run([
    "token",
    "theme",
    "list",
    path,
    "--full",
    "--stdout",
  ]);
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.appSelection, before.appSelection);
  await run(["token", "theme", "default", path, "--theme", "Brand/Dark"]);
  assert.equal(
    (await run(["token", "show", path, "--path", "color.test"])).value,
    "#111111",
  );
});

test("nested actions reject invalid input and return a runnable parent help query", async () => {
  const bad = await run(["token", "theme", "unknown"], 1);
  assert.equal(bad.error.code, "unknown_action");
  assert.equal(bad.error.writeState, "not-applied");
  const query = bad.error.details.nextOperations[0].argv.filter(
    (arg) => arg !== "--json",
  );
  assert.equal((await run(query)).command, "token theme");
  const duplicate = await run(
    [
      "asset",
      "font",
      "import",
      "missing.smallpen",
      "--family",
      "One",
      "--family",
      "Two",
      "--file",
      "font.ttf",
    ],
    1,
  );
  assert.equal(duplicate.error.code, "duplicate_option");
});

test("full help retains each asset route's own path and supported parameters", async () => {
  for (const path of [
    ["asset", "font", "list"],
    ["asset", "media", "list"],
    ["advanced", "style", "list"],
  ]) {
    const { stdout } = await promisify(execFile)(process.execPath, [
      cli,
      "help",
      ...path,
      "--full",
    ]);
    assert.match(stdout, new RegExp(`^SmallPen ${path.join(" ")}\\n`));
    const json = await run(["help", ...path, "--full"]);
    assert.match(json.guidance, new RegExp(`smallpen ${path.join(" ")} `));
    if (path[0] === "asset") {
      assert.doesNotMatch(stdout, /advanced style list|--kind/);
      assert.doesNotMatch(json.guidance, /advanced style list|--kind/);
      assert.equal(json.parameters.kind, undefined);
    } else {
      assert.deepEqual(json.parameters.kind.values, ["colors", "typographies"]);
      assert.doesNotMatch(stdout, /colors\|fonts\|media\|typographies/);
    }
  }
});
