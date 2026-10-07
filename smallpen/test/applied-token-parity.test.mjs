import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  listPackageEntries,
  loadPackageFromValues,
  projectEffectiveSnapshot,
} from "@smallpen/core";
import { openPackage } from "@smallpen/local-package";
import { compilePenpotChanges } from "@smallpen/penpot-adapter";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "roundtrip.smallpen");
const cli = new URL("../apps/cli/bin/smallpen.mjs", import.meta.url);

const cell = (id, name, type, value) => ({ description: "", id, name, type, value });

// Two theme options with different values, so a binding visibly follows them.
async function snapshot(active = "theme_default", edit) {
  const manifest = JSON.parse(await readFile(join(fixture, "manifest.json"), "utf8"));
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of listPackageEntries(manifest).entries)
    values.set(entry, JSON.parse(await readFile(join(fixture, entry), "utf8")));
  values.set("tokens/tokens.json", {
    activeSetIds: [],
    activeThemeIds: [active],
    id: "tlib_default",
    sets: [
      { description: "", id: "tset_theme_default", name: "Theme/Default", tokens: [
        cell("tok_brand", "color.brand", "color", "#4f46e5"),
        cell("tok_radius", "radius.lg", "border-radius", 12),
        cell("tok_radius_sm", "radius.sm", "border-radius", 4),
        cell("tok_space", "space.4", "spacing", 16),
        cell("tok_size", "size.min", "sizing", 80),
        cell("tok_tracking", "tracking.wide", "letter-spacing", 2),
        cell("tok_case", "case.upper", "text-case", "uppercase"),
      ] },
      { description: "", id: "tset_theme_compact", name: "Theme/Compact", tokens: [
        cell("tok_brand_c", "color.brand", "color", "#111827"),
        cell("tok_radius_c", "radius.lg", "border-radius", 6),
        cell("tok_radius_sm_c", "radius.sm", "border-radius", 2),
        cell("tok_space_c", "space.4", "spacing", 8),
        cell("tok_size_c", "size.min", "sizing", 40),
        cell("tok_tracking_c", "tracking.wide", "letter-spacing", 1),
        cell("tok_case_c", "case.upper", "text-case", "uppercase"),
      ] },
    ],
    themes: [
      { description: "", externalId: "", group: "Theme", id: "theme_default", isSource: false, name: "Default", setIds: ["tset_theme_default"] },
      { description: "", externalId: "", group: "Theme", id: "theme_compact", isSource: false, name: "Compact", setIds: ["tset_theme_compact"] },
    ],
  });
  edit?.(values.get("screens/roundtrip.json").presentations[0].nodes.node_rectangle);
  return loadPackageFromValues("memory://parity.smallpen", values);
}

const nodeOf = (value) => value.entries["screens/roundtrip.json"].presentations[0].nodes.node_rectangle;

function apply(loaded, applied) {
  const id = loaded.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle;
  return compilePenpotChanges(loaded, {
    changes: [{ id, type: "mod-obj", operations: [{ attr: "applied-tokens", type: "set", val: applied }] }],
    commitId: "apply",
  }).operations[0].changes;
}

test("every Token the App applies is stored as the same binding the CLI writes", async () => {
  const loaded = await snapshot();
  const ref = (assetId) => ({ assetId, packageId: "pkg_roundtrip" });
  assert.deepEqual(apply(loaded, { fill: "color.brand", width: "size.min", m1: "space.4", "layout-item-min-w": "size.min" }).tokenBindings, {
    fill: ref("tok_brand"), width: ref("tok_size"), marginTop: ref("tok_space"), minWidth: ref("tok_size"),
  });
  assert.deepEqual(apply(loaded, { r1: "radius.lg", r2: "radius.lg", r3: "radius.lg", r4: "radius.lg" }).tokenBindings,
    { cornerRadius: ref("tok_radius") }, "one Token on four corners is the whole radius");
  assert.deepEqual(apply(loaded, { r1: "radius.lg", r2: "radius.sm", r3: "radius.lg", r4: "radius.sm" }).tokenBindings, {
    radiusTopLeft: ref("tok_radius"), radiusTopRight: ref("tok_radius_sm"),
    radiusBottomRight: ref("tok_radius"), radiusBottomLeft: ref("tok_radius_sm"),
  }, "each corner can have its own Token");
});

test("bindings follow the theme for corners, margins, size limits and text style", async () => {
  const ref = (assetId) => ({ assetId, packageId: "pkg_roundtrip" });
  const bind = (node) => {
    node.type = "TEXT";
    node.text = "Hello";
    node.cornerRadius = [12, 4, 12, 4];
    node.tokenBindings = {
      radiusTopLeft: ref("tok_radius"), radiusTopRight: ref("tok_radius_sm"),
      marginLeft: ref("tok_space"), minWidth: ref("tok_size"),
      letterSpacing: ref("tok_tracking"), textTransform: ref("tok_case"),
    };
  };
  const compact = nodeOf(projectEffectiveSnapshot(await snapshot("theme_compact", bind)));
  assert.deepEqual(compact.cornerRadius, [6, 2, 12, 4], "only the bound corners follow");
  assert.equal(compact["layout-item-margin"].m4, 8);
  assert.equal(compact["layout-item-min-w"], 40);
  assert.equal(compact.textStyle.letterSpacing, 1);
  assert.equal(compact.textStyle.textTransform, "uppercase");
});

test("names the App stored before bindings still bind by name", async () => {
  const legacy = (node) => { node.appliedTokens = { fill: "color.brand", r1: "radius.lg" }; };
  const node = nodeOf(projectEffectiveSnapshot(await snapshot("theme_compact", legacy)));
  assert.equal(node.fills[0].color, "#111827");
  assert.equal(node.cornerRadius[0], 6);
  // The App applying them again stores bindings and drops the old names.
  const changes = apply(await snapshot("theme_default", legacy), { fill: "color.brand", r1: "radius.lg" });
  assert.ok(changes.tokenBindings.fill && changes.tokenBindings.radiusTopLeft);
  assert.equal(changes.appliedTokens, null);
});

async function run(args, expected = 0) {
  const child = spawn(process.execPath, [cli.pathname, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, expected, stdout || stderr);
  return JSON.parse(stdout);
}

// Stored nodes of a page's first version, read straight from the package.
async function pageNodes(path, name) {
  const pkg = await openPackage(path);
  const screen = Object.values(pkg.entries).find(
    (entry) => entry.presentations && entry.name === name,
  );
  return Object.values(screen.presentations[0].nodes);
}

test("page draw binds corners, margins, size limits and text style by name", async () => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-parity-"));
  const path = (await run(["project", "init", join(root, "demo"), "--json"])).packagePath;
  const file = async (name, value) => { const at = join(root, name); await writeFile(at, JSON.stringify(value)); return at; };
  await run(["token", "set", path, "--intent", await file("tokens.json", { tokens: [
    { name: "radius.lg", type: "border-radius", value: 12 },
    { name: "space.4", type: "spacing", value: 16 },
    { name: "size.min", type: "sizing", value: 80 },
    { name: "tracking.wide", type: "letter-spacing", value: 2 },
    { name: "case.upper", type: "text-case", value: "uppercase" },
  ] }), "--json"]);
  await run(["page", "draw", path, "--intent", await file("page.json", {
    page: "Card", children: [{
      name: "Card", radius: ["{radius.lg}", 0, 0, "{radius.lg}"], margin: [0, "{space.4}"], minWidth: "{size.min}",
      layout: "column", children: [{ name: "Tag", text: "new", letterSpacing: "{tracking.wide}", textTransform: "{case.upper}" }],
    }],
  }), "--json"]);
  const card = await run(["view", path, "--page", "Card", "--element", "Card", "--json"]);
  assert.doesNotMatch(card.text, /^Card .*literal[^\n]*radius/m, "bound corners are not literal");
  const nodes = await pageNodes(path, "Card");
  // The page root is named Card too; the card is the element with bindings.
  const shape = nodes.find(({ name, tokenBindings }) => name === "Card" && tokenBindings);
  assert.deepEqual(Object.keys(shape.tokenBindings).sort(), ["marginLeft", "marginRight", "minWidth", "radiusBottomLeft", "radiusTopLeft"]);
  assert.deepEqual(shape.cornerRadius, [12, 0, 0, 12]);
  const tag = nodes.find(({ name }) => name === "Tag");
  assert.deepEqual(Object.keys(tag.tokenBindings).sort(), ["letterSpacing", "textTransform"]);
});

test("a stroke can have its own width per side, bound and rendered", async () => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-sides-"));
  const path = (await run(["project", "init", join(root, "demo"), "--json"])).packagePath;
  const file = async (name, value) => { const at = join(root, name); await writeFile(at, JSON.stringify(value)); return at; };
  await run(["token", "set", path, "--intent", await file("tokens.json", { tokens: [
    { name: "border.thick", type: "stroke-width", value: 6 },
  ] }), "--json"]);
  await run(["page", "draw", path, "--intent", await file("page.json", {
    page: "Card", layout: "none", fill: "#ffffff", children: [{
      name: "Card", x: 20, y: 20, width: 100, height: 60, fill: "#ffffff",
      stroke: { color: "#000000", width: [0, 0, "{border.thick}", 0] },
    }],
  }), "--json"]);
  const card = (await pageNodes(path, "Card")).find(({ name, tokenBindings }) => name === "Card" && tokenBindings);
  assert.deepEqual(Object.keys(card.tokenBindings), ["strokeWidthBottom"]);
  assert.deepEqual([card.strokes[0].widthTop, card.strokes[0].widthBottom], [0, 6]);
  // Only the bottom edge is drawn: dark at the bottom band, white at the top.
  const png = await run(["view", path, "--page", "Card", "--as", "png", "--json"]);
  const bytes = await readFile(png.output);
  const chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString("ascii", offset + 4, offset + 8) === "IDAT") chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const { inflateSync } = await import("node:zlib");
  const pixels = inflateSync(Buffer.concat(chunks));
  const red = (x, y) => pixels[y * (png.width * 4 + 1) + 1 + x * 4];
  assert.ok(red(70, 77) < 80, "the bottom side is drawn");
  assert.ok(red(70, 22) > 200, "the top side is not");
});
