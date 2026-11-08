// What an agent reads back from check, changes, token list and view: named
// places, no element ids, one line per problem rather than one per text.
// Found by blind trials where the output hid or repeated what mattered.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const cli = new URL("../apps/cli/bin/smallpen.mjs", import.meta.url).pathname;
const example = new URL("../examples/common-components.smallpen", import.meta.url).pathname;

async function run(args, expected = 0) {
  const child = spawn(process.execPath, [cli, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, expected, stdout || stderr);
  return { stdout, stderr };
}

async function copy(context) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-trial-output-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "demo.smallpen");
  await cp(example, path, { recursive: true });
  return path;
}

async function edit(path, file, from, to) {
  const full = join(path, file);
  const text = await readFile(full, "utf8");
  assert.ok(text.includes(from), `${file} has ${from}`);
  await writeFile(full, text.replace(from, to));
}

test("check --render names the page or variant, folds a missing font and stays quiet for agents", async (context) => {
  const path = await copy(context);
  await edit(path, "tokens.css", '--type-demo-label: 600 14px/1.2 "Source Sans Pro";', '--type-demo-label: 600 14px/1.2 "Inter";');
  await edit(path, "tokens.css", "--color-demo-muted: #625f6b;", "--color-demo-muted: #9a97a3;");
  const { stdout, stderr } = await run(["check", path, "--render"]);
  assert.equal(stderr, "", "no progress lines when nobody watches a terminal");
  const fonts = stdout.split("\n").filter((line) => line.includes("font_render_fallback"));
  assert.equal(fonts.length, 1, stdout);
  assert.match(fonts[0], /Inter is not available, so \d+ texts in \d+ page versions and variants are drawn and measured with Source Sans Pro/);
  assert.match(stdout, /^render Showcase \/ Composition example \(desktop\): .* low_text_contrast Text contrast [\d.]+:1 is below 4.5:1/m);
  assert.match(stdout, /^revision [0-9a-f]{64}$/m);
  assert.ok(!/node_|"path"/.test(stdout));

  const reply = JSON.parse((await run(["check", path, "--render", "--json", "--stdout"])).stdout);
  assert.ok(reply.render.issues.every((issue) => issue.path === undefined && issue.nodeId === undefined));
  assert.ok(!reply.render.coverage.skipped.some((skip) => skip.check === "text-fit" && /font/i.test(skip.code ?? "")),
    "text fit runs with the font drawn");
});

test("a file rejected for another file's error shows that error, and the counts are of what was accepted", async (context) => {
  const path = await copy(context);
  await run(["check", path]);
  await edit(path, "tokens.css", "  --opacity-veil: 0.42;", '  --opacity-veil: 0.42;\n  --string-brand-new: "New";\n  --color-bad: notacolor;');
  await edit(path, "pages/Showcase/Design System Fixture.html", "</body>", '  <p data-name="New" class="left-[10px] top-[470px]" data-text="brand-new"></p>\n</body>');
  await writeFile(join(path, "pages/Showcase/Extra.html"), '<!doctype html>\n<html>\n<head>\n  <meta charset="utf-8">\n  <title>Extra</title>\n</head>\n<body class="w-[100px] h-[100px] bg-surfac"></body>\n</html>\n');
  const { stdout } = await run(["check", path], 1);
  assert.match(stdout, /rejected pages\/Showcase\/Design System Fixture\.html \(modified\): causes 1 error, with the other rejected files put back:\n {2}pages\/Showcase\/Design System Fixture\.html:\d+:\d+ error unknown_token data-text="brand-new"/);
  assert.match(stdout, /bg-surfac: no Token --color-surfac; did you mean bg-surface\?/);
  assert.match(stdout, /failed: 2 errors, 0 warnings; accepted version: 2 pages \(2 versions\)/);
});

test("renaming a used component blames the deleted file, not the new one", async (context) => {
  const path = await copy(context);
  await run(["check", path]);
  const badge = await readFile(join(path, "components/Badge.html"), "utf8");
  await rm(join(path, "components/Badge.html"));
  await writeFile(join(path, "components/Tag.html"), badge.replace('name="Badge"', 'name="Tag"'));
  const { stdout } = await run(["check", path], 1);
  assert.match(stdout, /^rejected components\/Badge\.html \(deleted\): causes 1 error in pages\/Showcase\/Composition example\.html$/m);
  assert.match(stdout, /^accepted components\/Tag\.html \(added\)$/m);
  assert.match(stdout, /error unknown_component No component Badge ← caused by the change to components\/Badge\.html \(deleted\), which this check rejected/);
});

test("a language option missing a string is a warning", async (context) => {
  const path = await copy(context);
  await edit(path, "tokens.css", '  --string-label: "Hello 覆盖";\n}', '  --string-label: "Hello";\n  --string-save: "Save";\n}\n\n:root[data-language="en"] {\n}\n\n:root[data-language="zh"] {\n  --string-label: "你好";\n}');
  await edit(path, "index.html", '<html data-color="light">', '<html data-color="light" data-language="en">');
  const { stdout } = await run(["check", path]);
  assert.match(stdout, /warning missing_translation --string-save has no value in :root\[data-language="zh"\], so language zh shows "Save"/);
  assert.ok(!stdout.includes("--string-label has no value"));
});

test("token list shows each definition as tokens.css writes it", async (context) => {
  const path = await copy(context);
  const reply = JSON.parse((await run(["token", "list", path, "--definitions", "--token", "radius"])).stdout);
  assert.deepEqual(reply.items, [
    { block: ":root", token: { name: "radius-base", type: "border-radius", value: 8 } },
    { block: ":root", token: { name: "radius-alias", type: "border-radius", value: "var(--radius-base)" } },
  ]);
  const ink = JSON.parse((await run(["token", "list", path, "--definitions", "--token", "color-demo-ink"])).stdout);
  assert.deepEqual(ink.items.map((item) => item.block), [':root[data-color="light"]', ':root[data-color="dark"]']);
});

test("changes reads a rename as a rename and a Token change once", async (context) => {
  const path = await copy(context);
  const before = (await run(["check", path])).stdout.match(/^revision (\S+)$/m)[1];
  await edit(path, "pages/Showcase/Composition example.html", 'data-name="Dialog instance"', 'data-name="Invite dialog"');
  await edit(path, "tokens.css", '--type-demo-label: 600 14px/1.2 "Source Sans Pro";', '--type-demo-label: 700 14px/1.3 "Source Sans Pro";');
  await run(["check", path]);
  const text = JSON.parse((await run(["changes", path, "--since", before, "--json"])).stdout).text;
  assert.match(text, /type-demo-label: changed — font weight 600 → 700, line height 1\.2 → 1\.3/);
  assert.match(text, /Invite dialog: renamed — was Dialog instance/);
  assert.ok(!/removed|added|link /.test(text), text);
  assert.ok(!/Label: changed — font weight/.test(text), "texts that follow the Token are not listed again");
  assert.ok(!/node_|[0-9a-f]{8}-[0-9a-f]{4}-/.test(text), text);
});

test("spec lists every fill and stroke with its Token, children in reading order", async (context) => {
  const path = await copy(context);
  await edit(path, "pages/Showcase/Design System Fixture.html", 'class="left-[40px] top-[160px] w-[120px] h-[80px] bg-[#0ea5e9]"',
    'class="left-[40px] top-[160px] w-[120px] h-[80px] bg-[linear-gradient(from_0.5_0_to_0.5_1,#ffffff00_0%,#ffffff_100%),var(--color-primary)] border-[1px_var(--color-demo-border),4px_#00000022_outside]"');
  await run(["check", path]);
  const spec = JSON.parse((await run(["view", path, "--page", "Showcase/Design System Fixture", "--as", "spec", "--json", "--stdout"])).stdout).text;
  assert.match(spec, /style: fill linear-gradient\(to bottom, #ffffff00 0%, #ffffff 100%\) · fill2 #6750a4 \{color-primary\} · stroke 1px #d7d3df inner \{color-demo-border\} · stroke2 4px #000000 13% outer/);
  const order = [...spec.matchAll(/^ {2}\[\d+\] ([^\n→]+?)(?: →.*)?$/gm)].map((match) => match[1].trim());
  // Freely placed: rows top to bottom, each left to right.
  assert.deepEqual(order.slice(0, 3), ["Primary Swatch", "Card instance / idle", "Radius Swatch"]);
  assert.ok(!/disabled reason|interaction: unspecified|ellipsis: unspecified/.test(spec));
});

test("the HTML review plays hover overlays and names elements instead of ids", async (context) => {
  const path = await copy(context);
  await edit(path, "pages/Showcase/Composition example.html", 'data-name="Badge instance"', 'data-name="Badge instance" data-hover="overlay:Showcase/Design System Fixture; position: top-right"');
  await edit(path, "pages/Showcase/Composition example.html", 'data-name="Save button"', 'data-name="Save button" data-click="Showcase/Design System Fixture"');
  await run(["check", path]);
  const output = join(path, "..", "review");
  await run(["export", path, "--format", "html", "--canvas", "Pages", "--output", output, "--json"]);
  const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
  const links = manifest.pages.flatMap((page) => page.links);
  const hover = links.find((link) => link.trigger === "mouse-over");
  assert.equal(hover.status, "resolved", JSON.stringify(manifest.unresolved));
  assert.equal(hover.action, "open-overlay");
  assert.equal(hover.element, "Badge instance");
  assert.equal(hover.overlay.position, "top-right");
  assert.equal(manifest.coverage.unresolvedCount, 0);
  assert.ok(!/node_|"nodeId"|"screenId"/.test(JSON.stringify(manifest)));
  assert.ok(manifest.defaultPage);
});

test("relative-to and manual overlays point at the element the page holds, on a copy's part too", async (context) => {
  const path = await copy(context);
  await edit(path, "pages/Showcase/Composition example.html", 'data-name="Badge instance"', 'data-name="Badge instance" data-hover="overlay:Showcase/Design System Fixture; position: bottom-right; relative-to: self"');
  await edit(path, "pages/Showcase/Composition example.html", '<p data-name="Label">Save changes</p>', '<p data-name="Label" data-hover="overlay:Showcase/Design System Fixture; position: manual 10px 20px">Save changes</p>');
  await run(["check", path]);
  const output = join(path, "..", "review");
  await run(["export", path, "--format", "html", "--canvas", "Pages", "--output", output, "--json"]);
  const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
  assert.equal(manifest.coverage.unresolvedCount, 0, JSON.stringify(manifest.unresolved));
  const hovers = manifest.pages.flatMap((page) => page.links).filter((link) => link.trigger === "mouse-over");
  assert.equal(hovers.length, 2);
  const badge = hovers.find((link) => link.element === "Badge instance");
  assert.deepEqual(Object.keys(badge.overlay.relativeTo).sort(), ["height", "width", "x", "y"]);
  const label = hovers.find((link) => link.element.endsWith("Label"));
  assert.equal(label.overlay.position, "manual");
  assert.ok(label.overlay.relativeTo, "a copy's part places the overlay relative to the copy");
});

test("view text reads sizes from the native layout, grid children in written order, hidden ones counted", async (context) => {
  const path = await copy(context);
  await writeFile(join(path, "pages/Showcase/Grid.html"), `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Grid</title>
  <link rel="stylesheet" href="../../tokens.css">
</head>
<body class="flex flex-col gap-[16px] p-[16px] w-[600px] h-[400px] bg-surface">
  <div data-name="Cards" class="grid grid-cols-2 gap-[8px] w-full">
    <sp-use component="Button" data-name="First"></sp-use>
    <sp-use component="Button" data-name="Second"></sp-use>
    <p data-name="Gone" class="hidden">Gone</p>
  </div>
</body>
</html>
`);
  await run(["check", path]);
  const text = JSON.parse((await run(["view", path, "--page", "Showcase/Grid", "--json"])).stdout).text;
  assert.match(text, /Cards · FRAME 568×\d+ · grid layout \(2, 1 hidden\)/);
  assert.match(text, /Button ×2 \(Style: primary; Content: text; State: default\) · 152×44: First "Continue"; Second "Continue"/);
});

test("spec lists links with their options and grid gaps with their Tokens; CSS export keeps aliases", async (context) => {
  const path = await copy(context);
  await edit(path, "pages/Showcase/Composition example.html", 'data-name="Badge instance"', 'data-name="Badge instance" data-click="Showcase/Design System Fixture; animation: slide in left 300ms ease-out"');
  await run(["check", path]);
  const spec = JSON.parse((await run(["view", path, "--page", "Showcase/Composition example", "--element", "Badge instance", "--as", "spec", "--json"])).stdout).text;
  assert.match(spec, /link: click → navigate Showcase \/ Design System Fixture \(desktop\) · animation slide in left 300ms ease-out/);
  const output = join(path, "..", "tokens-css");
  await run(["token", "export", path, "--by", "color", "--format", "css", "--output", output]);
  const dark = await readFile(join(output, "dark.css"), "utf8");
  assert.match(dark, /^:root \{\n/);
  assert.match(dark, /--radius-alias: var\(--radius-base\);/);
  assert.match(dark, /--color-demo-ink: #f2eef7;/);
  assert.match(dark, /--spacing-space-large: 16px;/);
});

test("check counts unused Tokens and token list names them with their uses", async (context) => {
  const path = await copy(context);
  const { stdout } = await run(["check", path]);
  assert.match(stdout, /32 Tokens \(17 not used by any page or component; token list --unused names them\)/);
  const unused = JSON.parse((await run(["token", "list", path, "--unused", "--limit", "100"])).stdout);
  assert.equal(unused.items.length, 17);
  assert.ok(unused.items.every((item) => item.uses === 0));
  const all = JSON.parse((await run(["token", "list", path, "--token", "color-primary"])).stdout);
  assert.ok(all.items[0].uses > 0);
});

test("changes reads a renamed component as a rename", async (context) => {
  const path = await copy(context);
  const before = (await run(["check", path])).stdout.match(/^revision (\S+)$/m)[1];
  const badge = await readFile(join(path, "components/Badge.html"), "utf8");
  await rm(join(path, "components/Badge.html"));
  await writeFile(join(path, "components/Tag.html"), badge.replace('name="Badge"', 'name="Tag"'));
  await edit(path, "pages/Showcase/Composition example.html", 'component="Badge"', 'component="Tag"');
  await run(["check", path]);
  const reply = JSON.parse((await run(["changes", path, "--since", before, "--json"])).stdout);
  assert.match(reply.text, /Tag: renamed — was Badge/);
  assert.ok(!/Tag: added|Badge: removed|visible true → true/.test(reply.text), reply.text);
  assert.equal(reply.edits, undefined);
});

test("check --render names strokes a clipping parent cuts and outlines too faint to see", async (context) => {
  const path = await copy(context);
  await edit(path, "pages/Showcase/Design System Fixture.html", "</body>", `  <div data-name="Field" class="flex flex-col left-[20px] top-[460px] w-[120px] h-fit">
    <div data-name="Input" class="w-full h-[30px] bg-surface border-[1px_#6750a4,4px_#d0bcff_outside]"></div>
  </div>
  <div data-name="Check" class="left-[160px] top-[460px] w-[20px] h-[20px] rounded-[10px] border border-[#e9e9ee]"></div>
</body>`);
  await run(["check", path]);
  const { stdout } = await run(["check", path, "--render", "--page", "Showcase/Design System Fixture"]);
  assert.match(stdout, /Field › Input clipped_by_parent its outside stroke is cut off by Field, which clips its content \(4px left, 4px right/);
  assert.match(stdout, /Check low_ui_contrast This 20×20 control is drawn only by its outline, at [\d.]+:1/);
});

test("changes reads a component renamed with a new value, a move into a new container, a Token option and an alignment", async (context) => {
  const path = await copy(context);
  const before = (await run(["check", path])).stdout.match(/^revision (\S+)$/m)[1];
  const badge = await readFile(join(path, "components/Badge.html"), "utf8");
  await rm(join(path, "components/Badge.html"));
  await writeFile(join(path, "components/Tag.html"), badge.replace('name="Badge" props="Tone: neutral | success | danger"', 'name="Tag" props="Tone: neutral | success | danger | info"'));
  await edit(path, "pages/Showcase/Composition example.html", 'component="Badge"', 'component="Tag"');
  await edit(path, "pages/Showcase/Composition example.html", '  <sp-use component="Title" data-name="Title instance" class="left-[24px] top-[24px] w-[320px] h-[76px]"></sp-use>\n',
    '  <div data-name="Header" class="left-[24px] top-[24px] w-[320px] h-[76px]">\n    <sp-use component="Title" data-name="Title instance" class="w-[320px] h-[76px]"></sp-use>\n  </div>\n');
  await edit(path, "tokens.css", "--color-demo-muted: #625f6b;", "--color-demo-muted: #5d5a66;");
  await edit(path, "components/Card.html", 'text-demo-ink type-demo-label">Card</p>', 'text-demo-ink type-demo-label text-center">Card</p>');
  const { stdout } = await run(["check", path]);
  assert.match(stdout, /^ok:/m, stdout);
  const text = JSON.parse((await run(["changes", path, "--since", before, "--json"])).stdout).text;
  assert.match(text, /Tag: renamed — was Badge/);
  assert.match(text, /Tag: changed — properties Tone: neutral\|success\|danger → Tone: neutral\|success\|danger\|info/);
  assert.match(text, /Header \/ Title instance: moved — was Title instance/);
  assert.match(text, /color-demo-muted: changed — color\/light #625f6b → #5d5a66/);
  assert.match(text, /Card \(all variants\) \/ Label: changed — text style|text align/);
  assert.ok(!/Badge: removed|Title instance: removed|order /.test(text), text);
});

test("a Token missing from a theme option is named, and a partial accept says its revision", async (context) => {
  const path = await copy(context);
  await run(["check", path]);
  await edit(path, "tokens.css", "  --color-demo-ink: #25232c;\n", "");
  const { stdout } = await run(["check", path]);
  assert.match(stdout, /warning missing_theme_value --color-demo-ink has a value for color\/dark but none for color\/light and none in :root, so under color\/light it shows another option's value/);
  await edit(path, "pages/Showcase/Composition example.html", "</body>", '  <div data-name="Bad" class="w-[10px] h-[10px] bg-nope"></div>\n</body>');
  const failed = await run(["check", path], 1);
  assert.match(failed.stdout, /^accepted revision [0-9a-f]{64}$/m);
  const reply = JSON.parse((await run(["check", path, "--json"], 1)).stdout);
  assert.match(reply.acceptedRevision, /^[0-9a-f]{64}$/);
  assert.equal(reply.summary.pages, 2);
});

test("check --render --all-themes checks every combination and names it", async (context) => {
  const path = await copy(context);
  const { stdout } = await run(["check", path, "--render", "--all-themes", "--page", "Showcase/Composition example"]);
  assert.match(stdout, /rendering problems? under 2 theme combinations/);
  const plain = await run(["check", path, "--render", "--page", "Showcase/Composition example"]);
  assert.match(plain.stdout, /under color\/light \(defaults; --all-themes checks every combination\)/);
});

test("a component spec lists what each variant changes, with values and Tokens", async (context) => {
  const path = await copy(context);
  const spec = JSON.parse((await run(["view", path, "--component", "Badge", "--as", "spec", "--json", "--stdout"])).stdout).text;
  assert.match(spec, /Variants: what each changes against Tone: neutral\n {2}Tone: success — Label fill #12663f \{color-demo-success\}, text "Active"\n {2}Tone: danger — Label fill #b42318 \{color-demo-danger\}, text "Attention"/);
});

test("Token uses count places, and a PNG output without an extension gets one", async (context) => {
  const path = await copy(context);
  const primary = JSON.parse((await run(["token", "list", path, "--token", "color-primary"])).stdout).items[0];
  assert.ok(primary.uses > 0 && primary.uses <= 10, `${primary.uses} places, not one per variant`);
  const output = join(path, "..", "shot");
  const reply = JSON.parse((await run(["view", path, "--component", "Badge", "--as", "png", "--output", output, "--json"])).stdout);
  assert.ok(String(reply.output ?? JSON.stringify(reply)).includes("shot.png"), JSON.stringify(reply).slice(0, 300));
});
