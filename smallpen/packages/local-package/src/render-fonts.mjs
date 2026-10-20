import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import opentype from "opentype.js";
import { SmallPenError } from "@smallpen/core";

const cache = join(homedir(), ".cache", "smallpen", "render-fonts");
const downloads = new Map();
const parsed = new WeakMap();
export const faceKey = (face) => `${face.fontId}/${face.weight}/${face.style}`;

async function catalogFont(url) {
  const address = new URL(url);
  if (
    address.protocol !== "https:" ||
    address.hostname !== "fonts.gstatic.com" ||
    !address.pathname.startsWith("/s/") ||
    address.username ||
    address.password ||
    address.port
  )
    throw new SmallPenError(
      "invalid_font_url",
      "The shared font catalog returned an invalid font URL",
    );
  const path = join(
    cache,
    createHash("sha256").update(url).digest("hex") + ".ttf",
  );
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new SmallPenError(
      "font_resource_unavailable",
      `Font download failed (${response.status})`,
    );
  const limit = 32 * 1024 * 1024;
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > limit)
      throw new SmallPenError(
        "font_resource_too_large",
        "Font exceeds the resource limit",
      );
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  await mkdir(cache, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
  return bytes;
}

// Host resource loading only. Family/weight/style and fallback selection come
// from App's shared font catalog; Skia owns shaping, metrics and drawing.
export async function provisionFonts(requests, available, sourceIds, styleOf = () => ({})) {
  const faces = new Map(available.map((face) => [faceKey(face), face]));
  const selected = new Map();
  const diagnostics = [];
  for (const request of requests) {
    const key = faceKey(request);
    if (selected.has(key)) continue;
    let face = faces.get(key);
    if (!face && request.url) {
      let download = downloads.get(request.url);
      if (!download) {
        download = catalogFont(request.url).catch((error) => {
          downloads.delete(request.url);
          throw error;
        });
        downloads.set(request.url, download);
      }
      face = { ...request, bytes: await download };
    }
    if (
      !face &&
      !request.fontId.startsWith("custom-") &&
      !request.fontId.startsWith("gfont-")
    ) {
      face = faces.get(faceKey({ ...request, fontId: "sourcesanspro" }));
    }
    if (!face?.bytes)
      throw new SmallPenError(
        "font_resource_unavailable",
        `Shared renderer cannot load ${request.fontId} ${request.weight} ${request.style}`,
      );
    selected.set(key, {
      ...face,
      fontId: request.fontId,
      isFallback: request.isFallback,
      isEmoji: request.isEmoji,
    });
  }
  const fonts = [...selected.values()];
  const coverage = (face) => {
    let font = parsed.get(face.bytes);
    if (!font) {
      const bytes = face.bytes;
      font = opentype.parse(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
      );
      parsed.set(bytes, font);
    }
    return font;
  };
  const fallback = fonts.filter((face) => face.isFallback);
  const missingGlyphs = new Map();
  const substitutions = new Set();
  for (const request of requests) {
    if (!request.nodeId) continue;
    const nodeId = sourceIds[request.nodeId];
    const primaryFace = selected.get(faceKey(request));
    const identity = (value) =>
      String(value)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
    const renamedBuiltin =
      request.fontId === "sourcesanspro" &&
      request.family &&
      !primaryFace.names?.some(
        (name) => identity(name) === identity(request.family),
      );
    if (
      ((!faces.has(faceKey(request)) && !request.url) || renamedBuiltin) &&
      !substitutions.has(nodeId)
    ) {
      substitutions.add(nodeId);
      const requestedFont = request.family ?? request.fontId;
      diagnostics.push({
        code: "font_render_fallback",
        nodeId,
        path: nodeId,
        message: `Renderer substituted Source Sans Pro for ${requestedFont}`,
        details: { requestedFont, substituteFont: "Source Sans Pro" },
      });
    }
    const primary = coverage(selected.get(faceKey(request)));
    const missing = missingGlyphs.get(nodeId) ?? new Set();
    for (const character of new Set(request.text)) {
      if (/\s|[\u200B-\u200F\uFE00-\uFE0F]/u.test(character)) continue;
      if (
        !primary.charToGlyphIndex(character) &&
        !fallback.some((face) => coverage(face).charToGlyphIndex(character))
      )
        missing.add(character);
    }
    missingGlyphs.set(nodeId, missing);
  }
  const longest = longestPieces(requests, (request) => coverage(selected.get(faceKey(request))), sourceIds, styleOf);
  for (const [nodeId, missing] of missingGlyphs)
    if (missing.size)
      diagnostics.push({
        code: "text_missing_glyph",
        nodeId,
        path: nodeId,
        message: `No shared font covers ${[...missing].map((c) => "U+" + c.codePointAt(0).toString(16).toUpperCase()).join(", ")}`,
      });
  return { fonts, diagnostics, missingGlyphs, longest };
}

// Lines break at spaces, after - / and dashes, and around CJK characters;
// anything else is one piece a line cannot split without breaking a word.
const BREAK_AFTER = /[-/\u2010-\u2014]/u;
const ANYWHERE = /[\u2E80-\u303F\u3040-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/u;

// Each text's widest unbreakable piece, measured with its primary face:
// a box narrower than it makes the renderer split the word.
function longestPieces(requests, fontOf, sourceIds, styleOf) {
  const widest = new Map();
  let nodeId, piece = "", width = 0, missing = false;
  const close = () => {
    // One character cannot be split; a fallback face draws what the
    // primary one lacks, so such pieces are not measured here.
    if ([...piece].length > 1 && !missing && width > (widest.get(nodeId)?.width ?? 0)) widest.set(nodeId, { text: piece, width: Math.round(width * 10) / 10 });
    missing = false;
    piece = "";
    width = 0;
  };
  for (const request of requests) {
    if (!request.nodeId || request.isFallback || !request.text) continue;
    const id = sourceIds[request.nodeId];
    if (id !== nodeId) close();
    nodeId = id;
    const font = fontOf(request);
    const style = styleOf(id) ?? {};
    const size = Number(style.fontSize) || 14;
    const spacing = Number(style.letterSpacing) || 0;
    let text = String(request.text);
    if (style.textTransform === "uppercase") text = text.toUpperCase();
    let chunk = "";
    // Plain glyph advances: shaping some fonts' substitution tables throws
    // in opentype.js, and a missing glyph counts as nothing.
    const scale = size / (font.unitsPerEm || 1000);
    const measure = () => {
      for (const character of chunk) {
        let advance = 0;
        try {
          if (font.charToGlyphIndex(character)) advance = font.charToGlyph(character).advanceWidth ?? 0;
          else missing = true;
        } catch {
          missing = true;
        }
        width += advance * scale + spacing;
      }
      chunk = "";
    };
    for (const character of text) {
      if (/\s/u.test(character)) {
        measure();
        close();
      } else if (ANYWHERE.test(character)) {
        measure();
        close();
        piece = chunk = character;
        measure();
        close();
      } else {
        piece += character;
        chunk += character;
        if (BREAK_AFTER.test(character)) {
          measure();
          close();
        }
      }
    }
    measure();
  }
  close();
  return widest;
}
