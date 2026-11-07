import assert from "node:assert/strict";
import test from "node:test";

import { penpotAppliedTokens } from "@smallpen/core";
import { createWebWorkspaceSnapshot } from "../apps/background/src/web-projection.mjs";
import { openPackage } from "@smallpen/local-package";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

// The one translation from bindings to the attributes the App shows:
// core computes it and the Background sends it with every node.
const names = new Map([["tok_md", "size.md"], ["tok_lg", "size.lg"], ["tok_border", "color.border"]]);
const md = { assetId: "tok_md", packageId: "pkg" };
const lg = { assetId: "tok_lg", packageId: "pkg" };
const applied = (tokenBindings, appliedTokens) => penpotAppliedTokens({ tokenBindings, appliedTokens }, names, "pkg");

test("every binding shows as the Penpot attribute it applies to", () => {
  assert.deepEqual(applied({ cornerRadius: md }), { r1: "size.md", r2: "size.md", r3: "size.md", r4: "size.md" });
  assert.deepEqual(applied({ cornerRadius: md, radiusTopLeft: lg }), { r1: "size.lg", r2: "size.md", r3: "size.md", r4: "size.md" },
    "a corner's own Token wins over the whole radius");
  assert.deepEqual(applied({ itemSpacing: md, rowGap: lg }), { "row-gap": "size.lg", "column-gap": "size.md" });
  assert.deepEqual(applied({ paddingTop: md, marginLeft: lg, minWidth: md, width: lg, opacity: md, fill: md }), {
    p1: "size.md", m4: "size.lg", "layout-item-min-w": "size.md", width: "size.lg", opacity: "size.md", fill: "size.md",
  });
  assert.deepEqual(applied({ "strokes.0": { assetId: "tok_border", packageId: "pkg" }, strokeWidthBottom: md }), {
    "stroke-color": "color.border", "stroke-width-bottom": "size.md",
  });
  assert.deepEqual(applied({ letterSpacing: md, lineHeight: lg, textTransform: md, textDecoration: lg }), {
    "letter-spacing": "size.md", "line-height": "size.lg", "text-case": "size.md", "text-decoration": "size.lg",
  });
});

test("a Token of another package stays a value; names an older App stored still show", () => {
  assert.deepEqual(applied({ fill: { assetId: "tok_md", packageId: "pkg_other" } }), {});
  assert.deepEqual(applied({ width: md }, { fill: "color.legacy" }), { fill: "color.legacy", width: "size.md" });
});

async function run(args) {
  const child = spawn(process.execPath, [new URL("../apps/cli/bin/smallpen.mjs", import.meta.url).pathname, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  await new Promise((resolve) => child.once("close", resolve));
  return JSON.parse(stdout);
}

test("the Background sends the applied Tokens with screen, variant and copy nodes", async () => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-applied-"));
  const path = (await run(["project", "init", join(root, "demo"), "--json"])).packagePath;
  const file = async (name, value) => { const at = join(root, name); await writeFile(at, JSON.stringify(value)); return at; };
  await run(["token", "set", path, "--intent", await file("t.json", { tokens: [{ name: "color.brand", type: "color", value: "#4f46e5" }] }), "--json"]);
  await run(["component", "define", path, "--intent", await file("c.json", { name: "Chip", base: { width: 40, height: 20, fill: "{color.brand}" } }), "--json"]);
  await run(["page", "draw", path, "--intent", await file("p.json", { page: "Board", children: [
    { name: "Box", width: 40, height: 40, fill: "{color.brand}" },
    { name: "Copy", use: "Chip" },
  ] }), "--json"]);
  const snapshot = await createWebWorkspaceSnapshot(await openPackage(path));
  const screenEntry = snapshot.manifest.entries.screens.find((entry) => snapshot.entries[entry].name === "Board");
  const screenNodes = Object.values(snapshot.entries[screenEntry].presentations[0].nodes);
  assert.equal(screenNodes.find(({ name }) => name === "Box").penpotAppliedTokens.fill, "color.brand");
  assert.equal(screenNodes.find(({ id }) => id.includes("__") || id.endsWith("_copy"))?.penpotAppliedTokens?.fill, "color.brand",
    "a placed copy shows its source's Token");
  const variant = snapshot.entries[snapshot.manifest.entries.components[0]].componentSets[0].variants[0];
  assert.equal(variant.nodes[variant.rootId].penpotAppliedTokens.fill, "color.brand");
});
