// A draft is a page kept outside the package for review: view, export and
// check draw it with the package's Tokens and components, and the package
// never holds it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const cli = new URL("../apps/cli/bin/smallpen.mjs", import.meta.url).pathname;
const example = new URL("../examples/common-components.smallpen", import.meta.url).pathname;

async function run(args, { expected = 0, input } = {}) {
  const child = spawn(process.execPath, [cli, ...args], { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  if (input !== undefined) child.stdin.end(input);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, expected, stdout || stderr);
  return { stdout, stderr };
}

async function workspace(context) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-drafts-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "demo.smallpen");
  await cp(example, path, { recursive: true });
  await mkdir(join(root, "drafts"));
  return { root, path, drafts: join(root, "drafts") };
}

const page = (body) => `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Draft</title>
  <link rel="stylesheet" href="../demo.smallpen/tokens.css">
</head>
${body}
</html>
`;

const SIGN_IN = page(`<body class="flex flex-col items-center justify-center gap-4 w-[480px] h-[320px] bg-surface">
  <p class="type-heading">Sign in</p>
  <sp-use component="Input" data-name="Email"></sp-use>
  <sp-use component="Button" props="Style: primary" data-name="Continue"></sp-use>
</body>`);

async function packageFiles(path) {
  const files = [];
  const walk = async (dir, prefix = "") => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(join(dir, entry.name), `${name}/`);
      else files.push(`${name}:${(await readFile(join(dir, entry.name))).toString("base64")}`);
    }
  };
  await walk(path);
  return files.sort();
}

test("a draft file is checked, drawn and exported with the package's components, and the package is untouched", async (context) => {
  const { path, drafts } = await workspace(context);
  const before = await packageFiles(path);
  const revision = JSON.parse((await run(["view", path, "--as", "text", "--json"])).stdout).revision;
  await writeFile(join(drafts, "Sign in.html"), SIGN_IN);

  const checked = await run(["check", path, "--draft", join(drafts, "Sign in.html"), "--render"]);
  assert.match(checked.stdout, /^ok: draft Sign in: 0 errors, 0 warnings, 0 rendering problems .*; nothing was written to the package$/m);

  const shot = join(drafts, "sign-in.png");
  const viewed = JSON.parse((await run(["view", path, "--draft", join(drafts, "Sign in.html"), "--as", "png", "--output", shot, "--json"])).stdout);
  assert.deepEqual(viewed.draft, { file: join(drafts, "Sign in.html"), page: "Sign in" });
  assert.equal(viewed.revision, undefined, "a draft is not a revision of the package");
  assert.equal((await readFile(shot)).subarray(1, 4).toString(), "PNG");

  const spec = JSON.parse((await run(["export", path, "--draft", join(drafts, "Sign in.html"), "--format", "spec", "--json"])).stdout);
  assert.equal(spec.draft.page, "Sign in");

  assert.deepEqual(await packageFiles(path), before);
  const after = JSON.parse((await run(["view", path, "--as", "text", "--json"])).stdout);
  assert.equal(after.revision, revision);
  const changes = JSON.parse((await run(["changes", path, "--since", revision, "--json"])).stdout);
  assert.doesNotMatch(JSON.stringify(changes), /Sign in/);
});

test("a draft on standard input names its problems by line, and a broken draft writes nothing", async (context) => {
  const { path } = await workspace(context);
  const broken = page(`<body class="w-[300px] h-[200px] bg-surface">
  <sp-use component="Buton"></sp-use>
</body>`);
  const { stdout } = await run(["check", path, "--draft", "-", "--draft-name", "Option B"], { expected: 1, input: broken });
  assert.match(stdout, /^<stdin>:9:3 error unknown_component No component Buton; did you mean Button\?$/m);
  assert.match(stdout, /^failed: draft Option B: 1 error, 0 warnings; nothing was written to the package$/m);
  const viewed = await run(["view", path, "--draft", "-", "--as", "png"], { expected: 1, input: broken });
  assert.match(viewed.stdout, /<stdin>:9:3 error unknown_component/);
});

test("a draft's platform comes from its file name, and a page's name is not a draft's", async (context) => {
  const { path, drafts } = await workspace(context);
  const mobile = SIGN_IN.replace("w-[480px] h-[320px]", "w-[390px] h-[600px]");
  await writeFile(join(drafts, "Sign in.mobile.html"), mobile);
  const viewed = JSON.parse((await run(["view", path, "--draft", join(drafts, "Sign in.mobile.html"), "--as", "text", "--json"])).stdout);
  assert.deepEqual(viewed.draft, { file: join(drafts, "Sign in.mobile.html"), page: "Sign in", platform: "mobile" });

  await writeFile(join(path, "pages", "Taken.html"), SIGN_IN.replace("../demo.smallpen/tokens.css", "../tokens.css"));
  await writeFile(join(drafts, "Taken.html"), SIGN_IN);
  const taken = await run(["view", path, "--draft", join(drafts, "Taken.html"), "--as", "png", "--json"], { expected: 1 });
  assert.match(taken.stdout + taken.stderr, /draft_name_taken/);
});
