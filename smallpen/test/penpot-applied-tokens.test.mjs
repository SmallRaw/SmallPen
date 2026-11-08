import assert from "node:assert/strict";
import test from "node:test";

import { penpotAppliedTokens } from "@smallpen/core";
import { createWebWorkspaceSnapshot } from "../apps/background/src/web-projection.mjs";
import { openPackage } from "@smallpen/local-package";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pageHtml, writePackage } from "./helpers/named.mjs";

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

test("the Background sends the applied Tokens with screen, variant and copy nodes", async () => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-applied-"));
  const path = join(root, "demo.smallpen");
  await writePackage(path, {
    "tokens.css": ":root {\n  --color-brand: #4f46e5;\n}\n",
    "components/components.html": '<sp-component name="Chip">\n  <div class="w-[40px] h-[20px] bg-brand"></div>\n</sp-component>\n',
    "pages/Board.html": pageHtml(`<body class="w-[390px] h-[200px]">
  <div data-name="Box" class="left-[0px] top-[0px] w-[40px] h-[40px] bg-brand"></div>
  <sp-use component="Chip" data-name="Copy" class="left-[0px] top-[60px]"></sp-use>
</body>`, { title: "Board" }),
  });
  const snapshot = await createWebWorkspaceSnapshot(await openPackage(path));
  const screenEntry = snapshot.manifest.entries.screens.find((entry) => snapshot.entries[entry].name === "Board");
  const screenNodes = Object.values(snapshot.entries[screenEntry].presentations[0].nodes);
  assert.equal(screenNodes.find(({ name }) => name === "Box").penpotAppliedTokens.fill, "color-brand");
  assert.equal(screenNodes.find(({ name }) => name === "Copy")?.penpotAppliedTokens?.fill, "color-brand",
    "a placed copy shows its source's Token");
  const variant = snapshot.entries[snapshot.manifest.entries.components[0]].componentSets[0].variants[0];
  assert.equal(variant.nodes[variant.rootId].penpotAppliedTokens.fill, "color-brand");
});
