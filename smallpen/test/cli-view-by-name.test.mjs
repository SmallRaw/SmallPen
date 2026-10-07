import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
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

let shared;
async function designed() {
  if (shared) return shared;
  shared = (async () => {
    const root = await mkdtemp(join(tmpdir(), "smallpen-look-"));
    const path = (await run(["project", "init", join(root, "demo"), "--json"])).packagePath;
    await run(["token", "set", path, "--intent", await file(root, "tokens.json", {
      tokens: [
        { name: "color.brand", type: "color", value: "#4f46e5" },
        { name: "space.2", type: "spacing", value: 8 },
        { name: "space.4", type: "spacing", value: 16 },
      ],
    }), "--json"]);
    await run(["component", "define", path, "--intent", await file(root, "button.json", {
      name: "Button",
      properties: { Style: ["primary", "secondary"], Size: ["md", "sm"] },
      base: {
        layout: "row", padding: ["{space.2}", "{space.4}"], fill: "{color.brand}", radius: 8,
        children: [{ name: "Label", text: "Go", color: "#ffffff", fontSize: 14 }],
      },
      variants: [
        { when: { Style: "secondary" }, set: { fill: "#ffffff", "Label.color": "{color.brand}" } },
        { when: { Size: "sm" }, set: { "Label.fontSize": 12 } },
      ],
    }), "--json"]);
    await run(["page", "draw", path, "--intent", await file(root, "board.json", {
      page: "Board", module: "Tasks", layout: "row",
      children: [
        { name: "Sidebar", width: 240, height: "fill" },
        { name: "Content", width: "fill", height: "fill", children: [
          { name: "Top bar", layout: "row", width: "fill", children: [
            { name: "Title", text: "Sprint" },
            { name: "New task", use: "Button", text: { Label: "New task" } },
          ] },
        ] },
      ],
    }), "--json"]);
    return { root, path };
  })();
  return shared;
}

test("view by name reads the package, every kind and one thing as text, without IDs", async () => {
  const { path } = await designed();
  const overview = await run(["view", path, "--as", "text", "--json"]);
  assert.match(overview.text, /Button · Style: primary\|secondary · Size: md\|sm · 4 variants/);
  assert.match(overview.text, /Tasks \/ Board — desktop 1440×900\n\s+Sidebar, Content/);

  const tokens = await run(["view", path, "--token", "space", "--json"]);
  assert.match(tokens.text, /space\.2\s+8\n\s+space\.4\s+16/, "Tokens read in natural order");
  assert.equal(tokens.tokenCount, 2);

  const page = await run(["view", path, "--page", "Board", "--json"]);
  assert.deepEqual(page.target, { page: "Tasks / Board", platform: "desktop" });
  assert.doesNotMatch(page.text, /#node_/);
  const part = await run(["view", path, "--page", "Board", "--element", "Top bar", "--json"]);
  assert.match(part.text, /^Top bar ·/);
  assert.doesNotMatch(part.text, /Sidebar/, "a part shows only that part");

  const variant = await run(["view", path, "--component", "Button", "--variant", "secondary", "--json"]);
  assert.equal(variant.target.variant, "Style=secondary, Size=md");
  assert.match(variant.text, /Structure of Style=secondary, Size=md:/);
  const element = await run(["view", path, "--component", "Button", "--variant", "Size=sm", "--element", "Label", "--json"]);
  assert.match(element.text, /Element in Style=primary, Size=sm:\nLabel · TEXT/);
});

test("view by name draws sheets and pages as wireframes and PNGs", async () => {
  const { path } = await designed();
  const sheet = await run(["view", path, "--component", "Button", "--as", "png", "--json"]);
  assert.equal(sheet.target.variants, 4);
  assert.ok((await stat(sheet.output)).size > 0);
  assert.ok(sheet.width < 2000, "a part draws on a narrow sheet");
  const wire = await run(["view", path, "--page", "Board", "--as", "wireframe", "--json"]);
  assert.match(wire.wireframe, /ASCII WIREFRAME/);
  const pages = await run(["view", path, "--pages", "--as", "png", "--json"]);
  assert.equal(pages.items.length, 2);
  assert.ok(pages.items.every(({ output }) => output.endsWith(".png")));
});

test("view by name lists issues by name and names what it cannot find", async () => {
  const { path } = await designed();
  const issues = await run(["view", path, "--as", "issues", "--json"]);
  assert.equal(issues.checked, 3);
  assert.equal(issues.issueCount, 0, "variants are measured one by one, so no label overflows");
  assert.ok(!JSON.stringify(issues).includes("nodeId"));
  const page = await run(["view", path, "--page", "Nope", "--json"], 1);
  assert.equal(page.error.code, "unknown_page");
  assert.ok(page.error.details.pages.includes("Tasks / Board"));
  const variant = await run(["view", path, "--component", "Button", "--variant", "huge", "--json"], 1);
  assert.equal(variant.error.code, "unknown_variant");
  assert.ok(variant.error.details.variants.includes("Style=secondary, Size=sm"));
  const element = await run(["view", path, "--page", "Board", "--element", "Nope", "--json"], 1);
  assert.ok(element.error.details.elements.includes("Content / Top bar / New task"));
  const two = await run(["view", path, "--page", "Board", "--tokens", "--json"], 1);
  assert.equal(two.error.code, "too_many_view_targets");
  const tokenIssues = await run(["view", path, "--tokens", "--as", "issues", "--json"], 1);
  assert.equal(tokenIssues.error.code, "issues_not_for_tokens");
});
