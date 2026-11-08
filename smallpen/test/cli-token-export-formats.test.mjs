import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const cli = new URL("../apps/cli/bin/smallpen.mjs", import.meta.url).pathname;

async function run(args, expected = 0) {
  let result;
  try {
    result = {
      code: 0,
      ...(await execute(process.execPath, [cli, ...args, "--json"])),
    };
  } catch (error) {
    result = error;
  }
  assert.equal(result.code, expected, result.stdout || result.stderr);
  return JSON.parse(result.stdout);
}

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-token-export-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const created = await run(["init", join(root, "app")]);
  return { root, path: created.packages.package.path };
}

test("token export advertises JSON and CSS custom properties", async () => {
  const schema = await run(["schema", "command", "token", "export"]);
  assert.deepEqual(schema.parameters.tokenFormat.values, ["json", "flat", "css"]);
});

for (const format of ["ts"]) {
  test(`token export refuses ${format} before writing any files`, async (t) => {
    const { root, path } = await project(t);
    const revision = (await run(["check", path])).revision;
    const output = join(root, "output");
    const result = await run(
      ["token", "export", path, "--format", format, "--output", output],
      1,
    );
    assert.equal(result.error.code, "unknown_token_format");
    await assert.rejects(access(output), { code: "ENOENT" });
    assert.equal((await run(["check", path])).revision, revision);
  });
}

for (const format of [undefined, "flat"]) {
  test(`token export retains ${format ?? "default nested JSON"} values and selection`, async (t) => {
    const { root, path } = await project(t);
    await writeFile(
      join(path, "tokens.css"),
      ':root {\n  --color-surface: #ffffff;\n  --spacing-md: 16px;\n  --string-title: "Tasks";\n  --flag-sidebar: false;\n}\n',
    );
    const result = await run([
      "token",
      "export",
      path,
      "--output",
      join(root, "output"),
      ...(format ? ["--format", format] : []),
    ]);
    assert.equal(result.format, format ?? "json");
    assert.equal(basename(result.files[0].file), "tokens.json");
    assert.deepEqual(result.themes, []);
    const actual = JSON.parse(await readFile(result.files[0].file, "utf8"));
    const expected =
      format === "flat"
        ? {
            "color-surface": "#ffffff",
            "spacing-md": 16,
            "string-title": "Tasks",
            "flag-sidebar": false,
          }
        : {
            color: { surface: "#ffffff" },
            spacing: { md: 16 },
            string: { title: "Tasks" },
            flag: { sidebar: false },
          };
    assert.deepEqual(actual, expected);
  });
}
