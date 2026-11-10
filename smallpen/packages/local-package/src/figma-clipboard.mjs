// INPUT:  the HTML Figma puts on the clipboard, and the package to paste into
// OUTPUT: canonical nodes for the App to paste, the page they read from, and
//         what did not come across
// POS:    Figma paste. The clipboard carries a fig-kiwi payload: a schema and
//         a message that uses it. Both come from the clipboard, so nothing
//         about them is trusted: the message is read field by field from the
//         schema (no code is generated or run), sizes are bounded, and the
//         result is a SmallPen page the package's own reader turns into layers.

import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { inflateSync, zstdDecompressSync } from "node:zlib";

import { decodePackageFiles, fail, figmaPageHtml, SmallPenError } from "@smallpen/core";

import { readPackageFiles } from "./html-store.mjs";
import { ByteBuffer, decodeBinarySchema } from "./kiwi-runtime.mjs";

const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 128 * 1024 * 1024;
const MAX_DEPTH = 64;
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const UNSAFE_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const PASTE_PAGE = "pages/Figma paste.html";

export function isFigmaClipboard(html) {
  return typeof html === "string" && /\(figmeta\)/.test(html) && /\(figma\)/.test(html);
}

function decodeBase64(value, label) {
  const bytes = Buffer.from(String(value ?? "").replace(/\s+/g, ""), "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_INPUT_BYTES) {
    fail("invalid_figma_clipboard", `${label} is empty or too large`);
  }
  return new Uint8Array(bytes);
}

// fig-kiwi: "fig-kiwi", a version, then length-prefixed chunks (schema, data).
function figKiwiChunks(binary) {
  if (binary.byteLength < 20 || new TextDecoder("ascii").decode(binary.slice(0, 8)) !== "fig-kiwi") {
    fail("invalid_figma_clipboard", "The Figma clipboard payload is not fig-kiwi");
  }
  const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
  const chunks = [];
  let offset = 12;
  while (offset < binary.byteLength) {
    if (offset + 4 > binary.byteLength) fail("invalid_figma_clipboard", "A Figma clipboard chunk header is cut short");
    const length = view.getUint32(offset, true);
    offset += 4;
    if (offset + length > binary.byteLength) fail("invalid_figma_clipboard", "A Figma clipboard chunk is cut short");
    chunks.push(binary.slice(offset, offset + length));
    offset += length;
  }
  if (chunks.length < 2) fail("invalid_figma_clipboard", "The Figma clipboard payload has no data");
  return chunks;
}

function decompress(bytes, label) {
  try {
    const zstd = ZSTD_MAGIC.every((byte, index) => bytes[index] === byte);
    const result = zstd
      ? zstdDecompressSync(bytes, { maxOutputLength: MAX_DECOMPRESSED_BYTES })
      : inflateSync(bytes, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
    return new Uint8Array(result);
  } catch (error) {
    fail("invalid_figma_clipboard", `Unable to decompress the Figma ${label}: ${error.message}`);
  }
}

// Reads one value of the schema's root type, interpreting the schema.
export function decodeWithSchema(schema, rootName, bytes) {
  const byName = new Map(schema.definitions.map((definition) => [definition.name, definition]));
  const enums = new Map(schema.definitions.filter((definition) => definition.kind === "ENUM")
    .map((definition) => [definition.name, new Map(definition.fields.map((field) => [field.value, field.name]))]));
  const tags = new Map(schema.definitions.filter((definition) => definition.kind === "MESSAGE")
    .map((definition) => [definition.name, new Map(definition.fields.map((field) => [field.value, field]))]));
  const bb = new ByteBuffer(bytes);
  let depth = 0;
  const remaining = () => bb.length - bb.offset;
  const readValue = (type) => {
    switch (type) {
      case "bool": return !!bb.readByte();
      case "byte": return bb.readByte();
      case "int": return bb.readVarInt();
      case "uint": return bb.readVarUint();
      case "float": return bb.readVarFloat();
      case "string": return bb.readString();
      case "int64": return bb.readVarInt64();
      case "uint64": return bb.readVarUint64();
      default: {
        const definition = byName.get(type);
        if (!definition) throw new Error(`unknown type ${String(type)}`);
        if (definition.kind === "ENUM") return enums.get(type).get(bb.readVarUint());
        return readDefinition(definition);
      }
    }
  };
  const readField = (field) => {
    if (!field.isArray) return readValue(field.type);
    if (field.type === "byte") return bb.readByteArray();
    const length = bb.readVarUint();
    if (length > remaining()) throw new Error("an array is longer than the data");
    const values = new Array(length);
    for (let index = 0; index < length; index += 1) values[index] = readValue(field.type);
    return values;
  };
  const store = (result, field, value) => {
    if (!UNSAFE_NAMES.has(field.name)) result[field.name] = value;
  };
  const readDefinition = (definition) => {
    depth += 1;
    if (depth > MAX_DEPTH) throw new Error("the data nests too deep");
    const result = {};
    if (definition.kind === "STRUCT") {
      for (const field of definition.fields) store(result, field, readField(field));
    } else {
      const fields = tags.get(definition.name);
      for (;;) {
        const tag = bb.readVarUint();
        if (tag === 0) break;
        const field = fields.get(tag);
        if (!field) throw new Error(`field ${tag} is not in ${definition.name}`);
        store(result, field, readField(field));
      }
    }
    depth -= 1;
    return result;
  };
  return readValue(rootName);
}

export function decodeFigmaClipboard(html) {
  if (typeof html !== "string" || Buffer.byteLength(html) > MAX_INPUT_BYTES) {
    fail("invalid_figma_clipboard", "The Figma clipboard is not text, or too large");
  }
  const meta = /\(figmeta\)(.*?)\(\/figmeta\)/s.exec(html);
  const buffer = /\(figma\)(.*?)\(\/figma\)/s.exec(html);
  if (!meta || !buffer) fail("invalid_figma_clipboard", "This is not Figma's clipboard: its (figma) markers are missing");
  const chunks = figKiwiChunks(decodeBase64(buffer[1], "Figma clipboard payload"));
  try {
    const schema = decodeBinarySchema(new ByteBuffer(decompress(chunks[0], "schema")));
    if (!schema.definitions.some((definition) => definition.name === "Message")) {
      fail("invalid_figma_clipboard", "The Figma clipboard schema has no Message");
    }
    const message = decodeWithSchema(schema, "Message", decompress(chunks[1], "data"));
    const nodeChanges = message.nodeChanges ?? [];
    if (!Array.isArray(nodeChanges)) fail("invalid_figma_clipboard", "The Figma clipboard nodes are not a list");
    return { nodeChanges };
  } catch (error) {
    if (error instanceof SmallPenError) throw error;
    fail("invalid_figma_clipboard", `Unable to read the Figma clipboard: ${error.message}`);
  }
}

const asText = (bytes) => (typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8"));

// The Figma clipboard as nodes to paste into the package at locator:
// { nodes, rootIds, nodeIds, losses, page }. nodes are canonical (as the
// package reads them), nodeIds give each a fresh App id.
export async function pasteFigmaClipboard(locator, html) {
  const { nodeChanges } = decodeFigmaClipboard(html);
  const root = await realpath(resolve(locator));
  // Only what a page needs to read: Tokens, fonts and their files.
  const files = new Map([...await readPackageFiles(root)]
    .filter(([path]) => path === "index.html" || path === "tokens.css" || path.startsWith("assets/fonts/")));
  const fontFamilies = [...asText(files.get("tokens.css") ?? "").matchAll(/@font-face\s*\{[^}]*?font-family\s*:\s*["']?([^;"'}]+)["']?/g)]
    .map((match) => match[1].trim());
  const { html: page, losses } = figmaPageHtml(nodeChanges, { fontFamilies });
  if (!page) fail("empty_figma_clipboard", losses[0]?.message ?? "The Figma clipboard holds nothing to draw");
  files.set(PASTE_PAGE, Buffer.from(page));
  const decoded = await decodePackageFiles(files);
  const errors = decoded.issues.filter((issue) => issue.severity === "error" && issue.file === PASTE_PAGE);
  if (errors.length) {
    fail("figma_paste_unreadable", `The Figma layers did not read as a page: ${errors.slice(0, 3).map((issue) => `${issue.line}:${issue.column} ${issue.message}`).join("; ")}`, { page });
  }
  const presentation = decoded.values.get(PASTE_PAGE.replace(/\.html$/, "")).presentations[0];
  const nodes = { ...presentation.nodes };
  const rootIds = [...(nodes[presentation.rootId].children ?? [])];
  delete nodes[presentation.rootId];
  const nodeIds = Object.fromEntries(Object.keys(nodes).map((id) => [id, randomUUID()]));
  return { nodes, rootIds, nodeIds, losses, page };
}
