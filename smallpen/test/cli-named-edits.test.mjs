import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyOperationBatch, openPackage } from "@smallpen/local-package";

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
  const root = await mkdtemp(join(tmpdir(), "smallpen-named-"));
  const path = (await run(["project", "init", join(root, "demo"), "--json"])).packagePath;
  const file = async (name, value) => { const at = join(root, name); await writeFile(at, JSON.stringify(value)); return at; };
  const draw = async (spec) => run(["page", "draw", path, "--intent", await file(`${spec.page}.json`, spec), "--json"]);
  await draw({ page: "List", module: "Tasks", children: [{ name: "Title", text: "Tasks" }, { name: "Open", text: "Open" }] });
  await draw({ page: "Detail", module: "Tasks", children: [{ name: "Title", text: "Detail" }] });
  await draw({ page: "Detail", module: "Tasks", platform: "mobile", children: [{ name: "Title", text: "Detail" }] });
  await run(["flow", "link", path, "--from", "Tasks / List / Open", "--to", "Detail", "--json"]);
  await run(["flow", "start", path, "--page", "List", "--json"]);
  return { root, path, file, draw };
}

const pageNames = async (path) => {
  const snapshot = await openPackage(path);
  return snapshot.manifest.entries.screens.map((entry) => snapshot.entries[entry].name);
};

test("help lists only name-based actions and the id routes are gone", async () => {
  const page = await run(["help", "page", "--json"]);
  assert.deepEqual(page.actions.map(({ action }) => action), ["list", "draw", "set", "move", "rename", "delete"]);
  const flow = await run(["help", "flow", "--json"]);
  assert.deepEqual(flow.actions.map(({ action }) => action), ["list", "link", "start", "unlink"]);
  const asset = await run(["help", "asset", "--json"]);
  assert.deepEqual(asset.actions.map(({ action }) => action), ["media", "font"]);
  const styles = await run(["help", "advanced", "style", "--json"]);
  assert.deepEqual(styles.actions.map(({ action }) => action), ["list", "set", "delete"]);
  const top = await run(["help", "--json"]);
  const commands = top.commands.map(({ command }) => command);
  assert.ok(!commands.includes("config"), "page configurations take ids");
  assert.ok(commands.includes("changes"));
  const gone = await run(["help", "page", "delete-by-id", "--json"], 1);
  assert.equal(gone.error.code, "unknown_action");
});

test("pages are renamed and deleted by name; linked pages are protected", async () => {
  const { path } = await app();
  const linked = await run(["page", "delete", path, "--page", "Detail", "--json"], 1);
  assert.equal(linked.error.code, "page_linked");
  assert.deepEqual(linked.error.details.links, ["Tasks / List / Open → Tasks / Detail"]);

  // A taken name is numbered like an App edit, not refused.
  const taken = await run(["page", "rename", path, "--page", "Detail", "--to", "List", "--json"]);
  assert.deepEqual(taken.renamed, [{ kind: "page", requested: "Tasks / List", to: "Tasks / List 2" }]);
  assert.deepEqual((await pageNames(path)).filter((name) => name.startsWith("Tasks")), ["Tasks / List", "Tasks / List 2"]);
  assert.match((await run(["view", path, "--page", "List 2", "--json"])).text, /^List 2 · desktop/, "the board follows the numbered page name");
  await run(["page", "rename", path, "--page", "List 2", "--to", "Item", "--json"]);
  assert.deepEqual((await pageNames(path)).filter((name) => name.startsWith("Tasks")), ["Tasks / List", "Tasks / Item"]);
  const outline = await run(["view", path, "--page", "Item", "--json"]);
  assert.match(outline.text, /^Item · desktop/, "the board follows the page name");
  const flows = await run(["flow", "list", path, "--full", "--json"]);
  assert.deepEqual(flows.links, [{ page: "Tasks / List", platform: "desktop", element: "Open", on: "click", action: "navigate", to: "Tasks / Item" }]);
  assert.deepEqual(flows.starts.map(({ page }) => page), ["Tasks / List"]);

  await run(["page", "delete", path, "--page", "Item", "--platform", "mobile", "--json"]);
  const last = await run(["page", "delete", path, "--page", "Item", "--platform", "desktop", "--json"], 1);
  assert.equal(last.error.code, "last_platform");
  await run(["page", "delete", path, "--page", "List", "--element", "Title", "--json"]);
  assert.doesNotMatch((await run(["view", path, "--page", "List", "--json"])).text, /Title/);

  await run(["flow", "unlink", path, "--from", "List / Open", "--json"]);
  const none = await run(["flow", "unlink", path, "--from", "List / Open", "--json"], 1);
  assert.equal(none.error.code, "no_link");
  await run(["flow", "start", path, "--page", "List", "--remove", "--json"]);
  assert.equal((await run(["flow", "list", path, "--json"])).text, "No starts or links.");
  await run(["page", "delete", path, "--page", "Item", "--json"]);
  assert.ok(!(await pageNames(path)).includes("Tasks / Item"));
});

test("components are renamed and deleted by name, elements in every variant", async () => {
  const { path, file } = await app();
  await run(["component", "define", path, "--intent", await file("button.json", {
    name: "Button", properties: { Style: ["primary", "ghost"] },
    base: { layout: "row", children: [{ name: "Label", text: "Go" }, { name: "Icon", width: 12, height: 12 }] },
  }), "--json"]);
  await run(["component", "define", path, "--intent", await file("chip.json", { name: "Chip", base: { children: [{ text: "A" }] } }), "--json"]);
  // A taken name is numbered like an App edit, not refused.
  const chip = await run(["component", "rename", path, "--component", "Chip", "--to", "button", "--json"]);
  assert.deepEqual(chip.renamed.map(({ kind, to }) => [kind, to]), [["component", "button 2"]]);
  assert.equal(JSON.stringify(chip).match(/"(?!batchId")(id|\w+Ids?)":/), null, "the reply carries no ids");
  await run(["component", "rename", path, "--component", "button 2", "--to", "Chip", "--json"]);
  await run(["component", "rename", path, "--component", "Button", "--to", "Action button", "--json"]);
  await run(["component", "rename", path, "--component", "Action button", "--element", "Label", "--to", "Text", "--json"]);
  const taken = await run(["component", "rename", path, "--component", "Action button", "--element", "Icon", "--to", "text", "--json"]);
  // One numbered element per variant.
  assert.deepEqual(taken.renamed.map(({ kind, requested, to }) => [kind, requested, to]), [["element", "text", "text 2"], ["element", "text", "text 2"]]);
  assert.ok(taken.renamed.every(({ where }) => where.startsWith("Action button")));
  const snapshot = await openPackage(path);
  const set = [...snapshot.domain.componentSets.values()].find(({ name }) => name === "Action button");
  assert.equal(set.id, "cmp_button", "a rename keeps the id");
  assert.ok(set.variants.every((variant) => Object.values(variant.nodes).some(({ name }) => name === "Text")));
  assert.ok(set.variants.every((variant) => Object.values(variant.nodes).some(({ name }) => name === "text 2")), "the taken element name is numbered in every variant");
  assert.equal([...snapshot.domain.componentSets.values()].find(({ id }) => id === "cmp_chip")?.name, "Chip");

  // A new Button after the rename gets its own id.
  await run(["component", "define", path, "--intent", await file("button.json", {
    name: "Button", base: { children: [{ name: "Label", text: "Go" }] },
  }), "--json"]);
  assert.ok((await openPackage(path)).domain.componentSets.has("cmp_button_2"));
  await run(["component", "delete", path, "--component", "Action button", "--variant", "ghost", "--json"]);
  assert.equal((await run(["component", "delete", path, "--component", "Action button", "--variant", "primary", "--json"], 1)).error.code, "last_variant");
  await run(["component", "delete", path, "--component", "Action button", "--json"]);
  assert.deepEqual([...(await openPackage(path)).domain.componentSets.values()].map(({ name }) => name).sort(), ["Button", "Chip"]);
});

test("colors and typographies are set and deleted by name", async () => {
  const { path } = await app();
  await run(["advanced", "style", "set", path, "--color", "Brand/Primary", "--value", "#1f6feb", "--json"]);
  await run(["advanced", "style", "set", path, "--color", "Brand / Primary", "--value", "#ff0000", "--json"]);
  await run(["advanced", "style", "set", path, "--typography", "Text/Body", "--value", JSON.stringify({ fontSize: 16 }), "--json"]);
  await run(["advanced", "style", "set", path, "--typography", "Text/Body", "--value", JSON.stringify({ fontWeight: 600 }), "--json"]);
  const listed = await run(["advanced", "style", "list", path, "--json"]);
  const color = listed.items.find(({ kind }) => kind === "colors").asset;
  assert.deepEqual([color.path, color.name, color.paint.color], ["Brand", "Primary", "#ff0000"]);
  const typography = listed.items.find(({ kind }) => kind === "typographies").asset;
  assert.deepEqual([typography.style.fontSize, typography.style.fontWeight, typography.style.fontFamily], [16, 600, "sourcesanspro"]);
  assert.equal((await run(["advanced", "style", "set", path, "--typography", "Text/Body", "--value", '{"textAlign":"left"}', "--json"], 1)).error.code, "invalid_typography");
  await run(["advanced", "style", "delete", path, "--color", "brand/primary", "--json"]);
  await run(["advanced", "style", "delete", path, "--typography", "Text/Body", "--json"]);
  assert.equal((await run(["advanced", "style", "list", path, "--json"])).items.length, 0);
  assert.equal((await run(["asset", "media", "delete", path, "--media", "Logo", "--json"], 1)).error.code, "missing_asset");
  assert.equal((await run(["asset", "font", "delete", path, "--font", "Inter", "--json"], 1)).error.code, "missing_asset");
});

test("names never repeat: siblings, new repeats from any writer, and stored repeats are issues that can be fixed", async () => {
  const { path, draw } = await app();
  const twice = await run(["page", "draw", path, "--intent", await (async () => {
    const at = join(path, "..", "twice.json");
    await writeFile(at, JSON.stringify({ page: "Twice", children: [{ name: "Card", text: "a" }, { name: "card", text: "b" }] }));
    return at;
  })(), "--json"], 1);
  assert.equal(twice.error.code, "duplicate_name");
  await draw({ page: "Auto", children: [{ text: "Hi" }, { text: "Hi" }, { text: "Hi" }] });
  assert.match((await run(["view", path, "--page", "Auto", "--json"])).text, /Hi · TEXT[^\n]*\n\s+Hi 2 · TEXT[^\n]*\n\s+Hi 3 · TEXT/, "unnamed siblings are numbered");

  // Any writer (the App, a raw batch) is refused a new repeat.
  const snapshot = await openPackage(path);
  const entry = snapshot.manifest.entries.screens.find((name) => snapshot.entries[name].name === "Auto");
  const copy = structuredClone(snapshot.entries[entry]);
  copy.name = "Tasks / List";
  await assert.rejects(
    applyOperationBatch(path, { baseRevision: snapshot.revision, batchId: "repeat", operations: [{ type: "put-screen", entry, screen: copy }] }),
    (error) => error.code === "duplicate_name",
  );

  // A repeat already stored (an older file) is an issue, picked by number.
  const file = join(path, entry);
  const stored = JSON.parse(await readFile(file, "utf8"));
  stored.name = "Tasks / List";
  await writeFile(file, JSON.stringify(stored));
  const issues = await run(["view", path, "--as", "issues", "--json"]);
  assert.ok(issues.issues.some(({ code, kind, name }) => code === "duplicate_name" && kind === "page" && name === "Tasks / List"));
  const validated = await run(["validate", path, "--json"]);
  assert.ok(validated.issues.some(({ code }) => code === "duplicate_name"));
  const ambiguous = await run(["page", "rename", path, "--page", "Tasks / List", "--to", "Board", "--json"], 1);
  assert.deepEqual(ambiguous.error.details.pages, ["Tasks / List [1]", "Tasks / List [2]"]);
  await run(["page", "rename", path, "--page", "Tasks / List [2]", "--to", "Board", "--json"]);
  assert.ok(!(await run(["validate", path, "--json"])).issues.some(({ code }) => code === "duplicate_name"));
});

test("changes reports canvases, flow order and links by name", async () => {
  const { path, draw } = await app();
  await draw({ page: "Scratch", children: [{ name: "Note", text: "Idea" }] });
  const seen = (await run(["flow", "list", path, "--json"])).revision;
  await run(["page", "move", path, "--page", "Detail", "--direction", "left", "--json"]);
  await run(["canvas", "rename", path, "--canvas", "Pages", "--to", "App", "--json"]);
  await run(["canvas", "put", path, "--page", "Scratch", "--canvas", "Drafts", "--json"]);
  await run(["flow", "unlink", path, "--from", "List / Open", "--json"]);
  await run(["flow", "link", path, "--from", "List / Open", "--to", "Detail", "--on", "mouse-enter", "--json"]);
  await run(["flow", "start", path, "--page", "List", "--remove", "--json"]);
  const changes = await run(["changes", path, "--since", seen, "--json"]);
  assert.match(changes.text, /Canvases\n/);
  assert.match(changes.text, /App: renamed — was Pages/);
  assert.match(changes.text, /Drafts: added/);
  assert.match(changes.text, /Drafts \/ Scratch: page moved here — from Pages/);
  assert.match(changes.text, /App \/ Tasks row: page order — Tasks \/ Detail, Tasks \/ List \(was Tasks \/ List, Tasks \/ Detail\)/);
  assert.match(changes.text, /Tasks \/ List \(desktop\) \/ Open: link added — mouse-enter → Tasks \/ Detail/);
  assert.match(changes.text, /Tasks \/ List \(desktop\) \/ Open: link removed — click → Tasks \/ Detail/);
  assert.match(changes.text, /Tasks \/ List \(desktop\): no longer a start/);
});

test("in a Foundation and Product pair, writes go by name and a Foundation delete cannot break the Product", async () => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-pair-"));
  const init = await run(["project", "init", join(root, "ws"), "--layout", "foundation-product", "--json"]);
  const { foundationPath: foundation, productPath: product } = init;
  const file = async (name, value) => { const at = join(root, name); await writeFile(at, JSON.stringify(value)); return at; };
  await run(["token", "set", foundation, "--intent", await file("t.json", { tokens: [{ name: "color.brand", type: "color", value: "#4f46e5" }] }), "--json"]);
  await run(["component", "define", foundation, "--intent", await file("c.json", {
    name: "Button", properties: { Style: ["primary", "ghost"] }, base: { layout: "row", children: [{ name: "Label", text: "Go" }] },
  }), "--json"]);
  await run(["page", "draw", product, "--intent", await file("p.json", {
    page: "List", module: "Tasks", children: [{ name: "Title", text: "Tasks", color: "{color.brand}" }, { name: "Add", use: "Button" }],
  }), "--json"]);

  const elsewhere = await run(["component", "rename", product, "--component", "Button", "--to", "Action", "--json"], 1);
  assert.equal(elsewhere.error.code, "component_not_here");
  await run(["component", "rename", foundation, "--component", "Button", "--to", "Action", "--json"]);
  assert.match((await run(["view", product, "--page", "List", "--json"])).text, /Action \(Style=primary\)/);
  const same = await run(["component", "define", product, "--intent", await file("c2.json", { name: "Action", base: { children: [] } }), "--json"], 1);
  assert.equal(same.error.code, "duplicate_name", "a Product component cannot take a Foundation component's name");

  await run(["component", "delete", foundation, "--component", "Action", "--variant", "ghost", "--json"]);
  const used = await run(["component", "delete", foundation, "--component", "Action", "--json"], 1);
  assert.equal(used.error.code, "used_elsewhere");
  assert.deepEqual(used.error.details.uses, ["ws: Tasks / List / Add"]);
  const bound = await run(["token", "delete", foundation, "--path", "color.brand", "--json"], 1);
  assert.deepEqual(bound.error.details.uses, ["ws: Tasks / List / Title"]);
  assert.equal((await run(["validate", product, "--json"])).status, "valid");
});

test("an App edit that repeats a name is numbered like a copied folder: Card 2, Card 3", async () => {
  const { path, file } = await app();
  await run(["component", "define", path, "--intent", await file("button.json", { name: "Button", base: { children: [{ name: "Label", text: "Go" }] } }), "--json"]);
  const appBatch = async (batchId, change) => {
    const snapshot = await openPackage(path);
    return applyOperationBatch(path, { baseRevision: snapshot.revision, batchId, operations: change(snapshot), repeatedNames: "number" });
  };
  const entryOf = (snapshot, name) => snapshot.manifest.entries.screens.find((entry) => snapshot.entries[entry].name === name);

  // A copied layer keeps its name in Penpot; the Package numbers it.
  const copyTitle = (batchId) => appBatch(batchId, (snapshot) => {
    const entry = entryOf(snapshot, "Tasks / List");
    const screen = structuredClone(snapshot.entries[entry]);
    const presentation = screen.presentations[0];
    const root = presentation.nodes[presentation.rootId];
    const title = Object.values(presentation.nodes).find(({ name }) => name === "Title");
    const id = `${title.id}_copy_${batchId}`;
    presentation.nodes[id] = { ...structuredClone(title), id };
    root.children = [...root.children, id];
    return [{ type: "put-screen", entry, screen }];
  });
  assert.deepEqual((await copyTitle("copy1")).renamed, [{ kind: "element", requested: "Title", to: "Title 2", where: "Tasks / List / List · desktop" }]);
  assert.equal((await copyTitle("copy2")).renamed[0].to, "Title 3");

  // A page renamed to a taken name, and a copied component.
  const page = await appBatch("page", (snapshot) => {
    const entry = entryOf(snapshot, "Tasks / Detail");
    return [{ type: "put-screen", entry, screen: { ...structuredClone(snapshot.entries[entry]), name: "Tasks / List" } }];
  });
  assert.deepEqual(page.renamed.map(({ kind, to }) => [kind, to]), [["page", "Tasks / List 2"]]);
  const component = await appBatch("component", (snapshot) => {
    const set = structuredClone(snapshot.domain.componentSets.get("cmp_button"));
    set.id = "cmp_button_copy";
    set.variants = set.variants.map((variant) => ({ ...variant, id: `${variant.id}_copy` }));
    return [{ type: "put-component-set", componentSet: set }];
  });
  assert.deepEqual(component.renamed.map(({ kind, to }) => [kind, to]), [["component", "Button 2"]]);
  assert.ok(!(await run(["validate", path, "--json"])).issues.some(({ code }) => code === "duplicate_name"));
});
