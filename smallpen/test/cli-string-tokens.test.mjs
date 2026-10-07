import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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

test("strings are Tokens in a Language group: bound text, instance labels, checks and files for code", async () => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-strings-"));
  const path = (await run(["project", "init", join(root, "demo"), "--json"])).packagePath;
  await run(["theme", "add", path, "--theme", "Language/en", "--theme", "Language/zh-CN", "--json"]);
  await run(["token", "set", path, "--intent", await file(root, "strings.json", {
    tokens: [
      { name: "text.board.title", type: "string", group: "Language", value: "Sprint board", values: { "Language/zh-CN": "冲刺看板" } },
      { name: "text.task.new", type: "string", group: "Language", value: "New task", values: { "Language/zh-CN": "新建任务" } },
      { name: "flag.sidebar", type: "boolean", group: "Language", value: true, values: { "Language/zh-CN": false } },
      { name: "color.brand", type: "color", value: "#4f46e5" },
    ],
  }), "--json"]);
  await run(["component", "define", path, "--intent", await file(root, "button.json", {
    name: "Button",
    base: { layout: "row", padding: [8, 16], fill: "{color.brand}", children: [{ name: "Label", text: "Go", color: "#ffffff" }] },
  }), "--json"]);
  await run(["page", "draw", path, "--intent", await file(root, "board.json", {
    page: "Board", layout: "row",
    children: [
      { name: "Sidebar", width: 240, height: "fill", visible: "{flag.sidebar}" },
      { name: "Content", width: "fill", children: [
        { name: "Title", text: "{text.board.title}" },
        { name: "New task", use: "Button", text: { Label: "{text.task.new}" } },
      ] },
    ],
  }), "--json"]);

  const english = await run(["view", path, "--page", "Board", "--json"]);
  assert.match(english.text, /Sidebar/);
  assert.match(english.text, /Title · TEXT .*"Sprint board"/);
  assert.match(english.text, /Button "New task"/);
  const chinese = await run(["view", path, "--page", "Board", "--theme", "Language/zh-CN", "--json"]);
  assert.doesNotMatch(chinese.text, /Sidebar/, "a boolean Token hides the sidebar");
  assert.match(chinese.text, /"冲刺看板"/);
  assert.match(chinese.text, /Button "新建任务"/, "an instance label follows its string Token");
  // The bundled font is Latin only: Chinese needs a font in the package.
  const issues = await run(["view", path, "--page", "Board", "--theme", "Language/zh-CN", "--as", "issues", "--json"]);
  assert.ok(issues.issues.some(({ code, message, where }) =>
    code === "text_missing_glyphs" && /Title/.test(where) && /font import/.test(message)),
    "text the fonts cannot draw is an issue that says to import a font");

  const exported = await run(["token", "export", path, "--type", "string", "--by", "Language", "--output", join(root, "i18n"), "--json"]);
  assert.deepEqual(exported.files.map(({ option }) => option), ["Language/en", "Language/zh-CN"]);
  assert.deepEqual(JSON.parse(await readFile(join(root, "i18n", "zh-CN.json"), "utf8")), {
    text: { board: { title: "冲刺看板" }, task: { new: "新建任务" } },
  });
  const flat = await run(["token", "export", path, "--token", "text.task", "--format", "flat", "--json"]);
  assert.deepEqual(JSON.parse(await readFile(flat.files[0].file, "utf8")), { "text.task.new": "New task" });

  const wrong = await run(["page", "draw", path, "--intent", await file(root, "wrong.json", {
    page: "Wrong", children: [{ name: "Title", text: "{color.brand}" }],
  }), "--json"], 1);
  assert.equal(wrong.error.code, "binding_type_mismatch");
});

// A tiny font holding a few Chinese glyphs, so the test needs no large file.
async function chineseFont(path, characters) {
  const opentype = (await import("opentype.js")).default;
  const notdef = new opentype.Glyph({ advanceWidth: 1000, name: ".notdef", path: new opentype.Path(), unicode: 0 });
  const glyphs = [...characters].map((character) => {
    const shape = new opentype.Path();
    shape.moveTo(100, 0); shape.lineTo(900, 0); shape.lineTo(900, 800); shape.lineTo(100, 800); shape.close();
    return new opentype.Glyph({ advanceWidth: 1000, name: `u${character.codePointAt(0).toString(16)}`, path: shape, unicode: character.codePointAt(0) });
  });
  const font = new opentype.Font({ ascender: 880, descender: -120, familyName: "Test Hei", glyphs: [notdef, ...glyphs], styleName: "Regular", unitsPerEm: 1000 });
  await writeFile(path, Buffer.from(font.toArrayBuffer()));
}

test("a project that needs Chinese imports a font into its package and uses it by Token", async () => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-cjk-"));
  const path = (await run(["project", "init", join(root, "demo"), "--json"])).packagePath;
  const fontFile = join(root, "test-hei.otf");
  await chineseFont(fontFile, "冲刺看板");
  await run(["font", "import", path, "--family", "Test Hei", "--file", fontFile, "--json"]);
  await run(["token", "set", path, "--intent", await file(root, "font.json", {
    tokens: [{ name: "font.family.base", type: "font-family", value: "Test Hei" }],
  }), "--json"]);
  await run(["page", "draw", path, "--intent", await file(root, "page.json", {
    page: "Board", children: [
      { name: "Title", text: "冲刺看板", fontFamily: "{font.family.base}", fontSize: 16 },
      { name: "Plain", text: "冲刺看板", fontSize: 16 },
    ],
  }), "--json"]);
  const issues = await run(["view", path, "--page", "Board", "--as", "issues", "--json"]);
  const missing = issues.issues.filter(({ code }) => code === "text_missing_glyphs").map(({ where }) => where);
  assert.deepEqual(missing, ["Plain"], "the imported font draws Chinese; the bundled one does not");
  const view = await run(["view", path, "--page", "Board", "--json"]);
  assert.match(view.text, /Title · TEXT 64×/, "four glyphs of one em at 16px");
});
