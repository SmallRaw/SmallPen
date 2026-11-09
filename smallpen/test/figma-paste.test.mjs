// Figma paste: the clipboard's fig-kiwi payload is read without running any
// code it carries, and its layers become plain SmallPen layers for reference.
import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { decodeFigmaClipboard, isFigmaClipboard, pasteFigmaClipboard } from "@smallpen/local-package";
import { compileSchema, encodeBinarySchema } from "../packages/local-package/src/kiwi-runtime.mjs";

const example = new URL("../examples/common-components.smallpen", import.meta.url).pathname;

const field = (name, type, value, isArray = false) => ({ isArray, isDeprecated: false, name, type, value });
const struct = (name, fields) => ({ kind: "STRUCT", name, fields: fields.map(([fieldName, type]) => field(fieldName, type, 0)) });
const message = (name, fields) => ({ kind: "MESSAGE", name, fields: fields.map(([fieldName, type, isArray], index) => field(fieldName, type, index + 1, isArray)) });

// Figma's own schema travels with each paste; this one keeps its shape.
const SCHEMA = {
  package: null,
  definitions: [
    struct("GUID", [["sessionID", "uint"], ["localID", "uint"]]),
    struct("Vector", [["x", "float"], ["y", "float"]]),
    struct("Color", [["r", "float"], ["g", "float"], ["b", "float"], ["a", "float"]]),
    struct("Matrix", [["m00", "float"], ["m01", "float"], ["m02", "float"], ["m10", "float"], ["m11", "float"], ["m12", "float"]]),
    { kind: "ENUM", name: "NodeType", fields: ["DOCUMENT", "CANVAS", "FRAME", "TEXT", "RECTANGLE", "VECTOR", "INSTANCE", "ELLIPSE"].map((name, index) => field(name, null, index)) },
    message("ParentIndex", [["guid", "GUID"], ["position", "string"]]),
    message("Paint", [["type", "string"], ["color", "Color"], ["opacity", "float"], ["visible", "bool"]]),
    message("FontName", [["family", "string"], ["style", "string"]]),
    message("TextData", [["characters", "string"]]),
    message("Number", [["value", "float"], ["units", "string"]]),
    message("NodeChange", [
      ["guid", "GUID"], ["parentIndex", "ParentIndex"], ["type", "NodeType"], ["name", "string"],
      ["size", "Vector"], ["transform", "Matrix"], ["fillPaints", "Paint", true], ["strokePaints", "Paint", true],
      ["strokeWeight", "float"], ["strokeAlign", "string"], ["cornerRadius", "float"], ["stackMode", "string"],
      ["stackSpacing", "float"], ["stackPadding", "float"], ["stackCounterAlignItems", "string"],
      ["stackChildPrimaryGrow", "float"], ["textData", "TextData"], ["fontName", "FontName"], ["fontSize", "float"],
      ["lineHeight", "Number"], ["opacity", "float"], ["textAutoResize", "string"],
    ]),
    message("Message", [["nodeChanges", "NodeChange", true]]),
  ],
};

const guid = (localID) => ({ sessionID: 1, localID });
const at = (x, y) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const solid = (r, g, b) => ({ type: "SOLID", color: { r, g, b, a: 1 }, opacity: 1, visible: true });

function clipboard(nodeChanges, schema = SCHEMA) {
  const schemaBytes = deflateSync(encodeBinarySchema(schema));
  const dataBytes = deflateSync(compileSchema(schema).encodeMessage({ nodeChanges }));
  const payload = new Uint8Array(20 + schemaBytes.byteLength + dataBytes.byteLength);
  const view = new DataView(payload.buffer);
  payload.set(new TextEncoder().encode("fig-kiwi"), 0);
  view.setUint32(8, 101, true);
  view.setUint32(12, schemaBytes.byteLength, true);
  payload.set(schemaBytes, 16);
  view.setUint32(16 + schemaBytes.byteLength, dataBytes.byteLength, true);
  payload.set(dataBytes, 20 + schemaBytes.byteLength);
  const meta = Buffer.from(JSON.stringify({ dataType: "NODE_CHANGES" })).toString("base64");
  return `<meta charset="utf-8"><meta>(figmeta)${meta}(/figmeta)</meta><div>(figma)${Buffer.from(payload).toString("base64")}(/figma)</div>`;
}

const CARD = [
  { guid: guid(1), type: "CANVAS", name: "Page 1" },
  {
    guid: guid(2), parentIndex: { guid: guid(1), position: "a" }, type: "FRAME", name: "Card",
    size: { x: 320, y: 120 }, transform: at(400, 300), fillPaints: [solid(1, 1, 1)], cornerRadius: 12,
    strokePaints: [solid(0.9, 0.9, 0.92)], strokeWeight: 1, strokeAlign: "INSIDE",
    stackMode: "HORIZONTAL", stackSpacing: 8, stackPadding: 16, stackCounterAlignItems: "CENTER",
  },
  {
    guid: guid(3), parentIndex: { guid: guid(2), position: "a" }, type: "TEXT", name: "Title",
    size: { x: 120, y: 20 }, transform: at(0, 0), fillPaints: [solid(0.1, 0.1, 0.1)],
    textData: { characters: "Hello Figma" }, fontName: { family: "Inter", style: "Semi Bold" }, fontSize: 16,
    lineHeight: { value: 24, units: "PIXELS" }, textAutoResize: "WIDTH_AND_HEIGHT",
  },
  {
    guid: guid(4), parentIndex: { guid: guid(2), position: "b" }, type: "RECTANGLE", name: "Swatch",
    size: { x: 40, y: 40 }, transform: at(0, 0), fillPaints: [{ type: "IMAGE", visible: true, opacity: 1 }],
    stackChildPrimaryGrow: 1,
  },
  {
    guid: guid(5), parentIndex: { guid: guid(2), position: "c" }, type: "VECTOR", name: "Swatch",
    size: { x: 24, y: 24 }, transform: at(0, 0),
  },
  {
    guid: guid(6), parentIndex: { guid: guid(1), position: "b" }, type: "INSTANCE", name: "Badge",
    size: { x: 80, y: 24 }, transform: at(760, 300), fillPaints: [solid(0.31, 0.27, 0.9)], opacity: 0.5,
  },
];

async function workspace(context) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-figma-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "demo.smallpen");
  await cp(example, path, { recursive: true });
  return path;
}

test("Figma's clipboard is recognised and decoded with the schema it carries", () => {
  const html = clipboard(CARD);
  assert.ok(isFigmaClipboard(html));
  assert.ok(!isFigmaClipboard("<p>hello</p>"));
  const { nodeChanges } = decodeFigmaClipboard(html);
  assert.equal(nodeChanges.length, 6);
  assert.equal(nodeChanges[1].type, "FRAME");
  assert.equal(nodeChanges[2].textData.characters, "Hello Figma");
  assert.deepEqual(nodeChanges[1].transform, at(400, 300));
});

test("pasted Figma layers become plain layers that read as a SmallPen page", async (context) => {
  const path = await workspace(context);
  const pasted = await pasteFigmaClipboard(path, clipboard(CARD));
  const byName = (name) => Object.values(pasted.nodes).find((node) => node.name === name);
  assert.equal(pasted.rootIds.length, 2);
  assert.ok(pasted.rootIds.every((id) => pasted.nodes[id]));
  assert.deepEqual(Object.keys(pasted.nodeIds).sort(), Object.keys(pasted.nodes).sort());

  const card = byName("Card");
  assert.equal(card.type, "FRAME");
  assert.equal(card.layout, "flex");
  assert.equal(card["layout-flex-dir"], "row");
  assert.equal(card["layout-align-items"], "center");
  assert.equal(card["layout-gap"]["column-gap"], 8);
  assert.deepEqual(card["layout-padding"], { p1: 16, p2: 16, p3: 16, p4: 16 });
  assert.equal(card.cornerRadius, 12);
  assert.equal(card.strokes[0].width, 1);
  assert.equal(card.x, 0);
  assert.equal(card.width, 320);

  const title = byName("Title");
  assert.equal(title.text, "Hello Figma");
  assert.equal(title.textStyle.fontSize, 16);
  assert.equal(title.textStyle.fontWeight, 600);
  assert.equal(title.textStyle.fontFamily, undefined, "Inter is not a font of the package");
  // Two siblings named Swatch: the second gets a number.
  assert.ok(byName("Swatch") && byName("Swatch 2"));
  assert.equal(byName("Swatch")["layout-item-h-sizing"], "fill");
  assert.equal(byName("Badge").type, "FRAME");
  assert.equal(byName("Badge").x, 360);
  assert.equal(byName("Badge").opacity, 0.5);

  const codes = pasted.losses.map((loss) => loss.code).sort();
  assert.deepEqual(codes, ["component", "font:Inter", "image", "vector"]);
  assert.match(pasted.page, /<p data-name="Title" class="text-\[#1a1a1a\] font-\[600\] text-\[16px\] leading-\[24px\]">Hello Figma<\/p>/);
});

test("a hostile clipboard runs no code and pollutes nothing", () => {
  const hostile = structuredClone(SCHEMA);
  hostile.definitions.find((definition) => definition.name === "NodeChange").fields.push(field("__proto__", "Paint", 99));
  const html = clipboard([{ guid: guid(1), type: "FRAME", name: "x", __proto__: undefined }], hostile);
  decodeFigmaClipboard(html);
  assert.equal({}.polluted, undefined);

  // A list longer than its data is refused, not allocated.
  const payload = /\(figma\)(.*?)\(\/figma\)/s.exec(clipboard(CARD))[1];
  const bytes = Buffer.from(payload, "base64");
  const cut = bytes.subarray(0, bytes.length - 10);
  assert.throws(() => decodeFigmaClipboard(`(figmeta)e30=(/figmeta)(figma)${cut.toString("base64")}(/figma)`), /invalid_figma_clipboard|cut short|Unable/);
});
