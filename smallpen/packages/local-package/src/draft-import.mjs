import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { inflateSync, zstdDecompressSync } from "node:zlib";

import {
  canonicalJSON,
  createFigmaDraftValues,
  createFlatDraftValues,
  fail,
  listPackageEntries,
  loadPackageFromValues,
  sha256Hex,
  SmallPenError,
} from "@smallpen/core";

import {
  ByteBuffer,
  compileSchema,
  decodeBinarySchema,
} from "./kiwi-runtime.mjs";

const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 128 * 1024 * 1024;
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

function decodeBase64(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail("invalid_figma_clipboard", `${label} is missing`);
  }
  const bytes = Buffer.from(value.replace(/\s+/g, ""), "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_INPUT_BYTES) {
    fail("invalid_figma_clipboard", `${label} is empty or too large`);
  }
  return new Uint8Array(bytes);
}

function parseFigKiwiChunks(binary) {
  if (
    binary.byteLength < 20 ||
    new TextDecoder("ascii").decode(binary.slice(0, 8)) !== "fig-kiwi"
  ) {
    fail("invalid_figma_clipboard", "Figma clipboard payload is not fig-kiwi");
  }
  const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
  const chunks = [];
  let offset = 12;
  while (offset < binary.byteLength) {
    if (offset + 4 > binary.byteLength) {
      fail("invalid_figma_clipboard", "Figma clipboard chunk header is truncated");
    }
    const length = view.getUint32(offset, true);
    offset += 4;
    if (length <= 0 || offset + length > binary.byteLength) {
      fail("invalid_figma_clipboard", "Figma clipboard chunk length is invalid");
    }
    chunks.push(binary.slice(offset, offset + length));
    offset += length;
  }
  if (chunks.length < 2) {
    fail("invalid_figma_clipboard", "Figma clipboard requires schema and data chunks");
  }
  return chunks;
}

function isZstd(bytes) {
  return ZSTD_MAGIC.every((byte, index) => bytes[index] === byte);
}

function decompress(bytes, label) {
  try {
    const result = isZstd(bytes)
      ? zstdDecompressSync(bytes, { maxOutputLength: MAX_DECOMPRESSED_BYTES })
      : inflateSync(bytes, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
    return new Uint8Array(result);
  } catch (error) {
    fail(
      "invalid_figma_clipboard",
      `Unable to decompress Figma ${label}: ${error.message}`,
    );
  }
}

export async function decodeFigmaClipboard(html) {
  if (typeof html !== "string" || Buffer.byteLength(html) > MAX_INPUT_BYTES) {
    fail("invalid_figma_clipboard", "Figma clipboard HTML is invalid or too large");
  }
  const metaMatch = /\(figmeta\)(.*?)\(\/figmeta\)/s.exec(html);
  const bufferMatch = /\(figma\)(.*?)\(\/figma\)/s.exec(html);
  if (!metaMatch || !bufferMatch) {
    fail(
      "invalid_figma_clipboard",
      "Input does not contain Figma structured clipboard markers",
    );
  }
  let meta;
  try {
    meta = JSON.parse(Buffer.from(metaMatch[1], "base64").toString("utf8"));
  } catch (error) {
    fail("invalid_figma_clipboard", `Figma clipboard metadata is invalid: ${error.message}`);
  }
  const chunks = parseFigKiwiChunks(decodeBase64(bufferMatch[1], "Figma clipboard payload"));
  try {
    const schema = decodeBinarySchema(new ByteBuffer(decompress(chunks[0], "schema")));
    const compiled = compileSchema(schema);
    if (typeof compiled.decodeMessage !== "function") {
      fail("invalid_figma_clipboard", "Figma clipboard schema has no Message decoder");
    }
    const message = compiled.decodeMessage(decompress(chunks[1], "data"));
    const nodeChanges = message.nodeChanges ?? [];
    if (!Array.isArray(nodeChanges)) {
      fail("invalid_figma_clipboard", "Figma clipboard nodeChanges are invalid");
    }
    return {
      blobCount: Array.isArray(message.blobs) ? message.blobs.length : 0,
      meta,
      nodeChanges,
    };
  } catch (error) {
    if (error instanceof SmallPenError) throw error;
    fail("invalid_figma_clipboard", `Unable to decode Figma clipboard: ${error.message}`);
  }
}

function inspectPng(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    bytes.byteLength < 24 ||
    signature.some((byte, index) => bytes[index] !== byte) ||
    new TextDecoder("ascii").decode(bytes.slice(12, 16)) !== "IHDR"
  ) {
    fail("invalid_draft_media", "Draft PNG has an invalid signature or IHDR");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { height: view.getUint32(20), width: view.getUint32(16) };
}

function inspectSvg(bytes) {
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    fail("invalid_draft_media", `Draft SVG is not UTF-8: ${error.message}`);
  }
  const root = /<svg\b([^>]*)>/i.exec(source)?.[1];
  if (root === undefined) fail("invalid_draft_media", "Draft SVG has no svg root");
  const attribute = (name) =>
    new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(root)?.[1];
  const length = (value) => {
    const match = /^\s*([0-9]+(?:\.[0-9]+)?)(?:px)?\s*$/i.exec(value ?? "");
    return match ? Math.round(Number(match[1])) : undefined;
  };
  let width = length(attribute("width"));
  let height = length(attribute("height"));
  const viewBox = attribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if ((!width || !height) && viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
    width ??= Math.round(viewBox[2]);
    height ??= Math.round(viewBox[3]);
  }
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    fail("invalid_draft_media", "Draft SVG dimensions are invalid");
  }
  return { height, width };
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function writeDraftPackage(outputValue, values) {
  const output = resolve(outputValue);
  if (!output.endsWith(".smallpen")) {
    fail("invalid_draft_path", "Draft output must end in .smallpen", { output });
  }
  if (await pathExists(output)) {
    fail("draft_output_exists", "Draft output already exists and will not be overwritten", {
      output,
    });
  }
  await mkdir(dirname(output), { recursive: true });
  const transaction = await mkdtemp(join(dirname(output), ".smallpen-draft-"));
  const candidate = join(transaction, `${basename(output)}-${randomUUID()}.smallpen`);
  try {
    const loaded = await loadPackageFromValues(candidate, values);
    await mkdir(candidate);
    const { entries } = listPackageEntries(loaded.manifest);
    for (const entry of ["manifest.json", ...entries]) {
      const path = join(candidate, entry);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        canonicalJSON(entry === "manifest.json" ? loaded.manifest : loaded.entries[entry]),
        "utf8",
      );
    }
    for (const [entry, bytes] of loaded.blobs) {
      const path = join(candidate, entry);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }
    if (await pathExists(output)) {
      fail("draft_output_exists", "Draft output appeared during import and was not overwritten", {
        output,
      });
    }
    await rename(candidate, output);
    await rm(transaction, { force: true, recursive: true });
    return { ...loaded, locator: output };
  } catch (error) {
    await rm(transaction, { force: true, recursive: true });
    throw error;
  }
}

export async function importDraft({
  bytes,
  html,
  importedAt = new Date().toISOString(),
  kind,
  output,
  packageId = "pkg_figma_draft",
}) {
  if (!new Set(["figma", "png", "svg"]).has(kind)) {
    fail("invalid_draft_kind", "Draft import kind must be figma, svg, or png");
  }
  let model;
  if (kind === "figma") {
    const input = new TextEncoder().encode(html ?? "");
    const decoded = await decodeFigmaClipboard(html);
    model = createFigmaDraftValues({
      importedAt,
      inputHash: await sha256Hex(input),
      meta: decoded.meta,
      nodeChanges: decoded.nodeChanges,
      packageId,
    });
    if (decoded.blobCount > 0) {
      model.losses.push({
        code: "figma_binary_blobs_not_embedded",
        message: `${decoded.blobCount} Figma binary image/font blobs remain source-only in this Draft`,
        severity: "warning",
      });
      model.values.get("manifest.json").draft.losses = model.losses;
    }
  } else {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_INPUT_BYTES) {
      fail("invalid_draft_media", "Draft fallback bytes are empty or too large");
    }
    const dimensions = kind === "png" ? inspectPng(bytes) : inspectSvg(bytes);
    const inputHash = await sha256Hex(bytes);
    model = createFlatDraftValues({
      bytes,
      ...dimensions,
      importedAt,
      inputHash,
      mimeType: kind === "png" ? "image/png" : "image/svg+xml",
      packageId,
      sourceKind: kind,
    });
  }
  const written = await writeDraftPackage(output, model.values);
  return {
    losses: model.losses,
    output: written.locator,
    packageId: written.manifest.packageId,
    provenance: model.provenance,
    revision: written.revision,
  };
}
