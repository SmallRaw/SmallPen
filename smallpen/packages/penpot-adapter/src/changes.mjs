import {
  applyEffectiveTokenBindings,
  applyNodeOverrides,
  componentCombinationSnapshot,
  defaultTokenThemeIds,
  fail,
  INSTANCE_OVERRIDE_FIELDS,
  bindingTargetField,
  CORNER_BINDINGS,
  PENPOT_TOKEN_BINDINGS,
  canvasLayout,
  explicitCanvases,
  listTokenThemes,
  overrideTouchedGroups,
  projectScreen,
  resolveEffectiveToken,
  SMALLPEN_FORMAT_CAPABILITIES,
  tokenLibraryOf,
} from "@smallpen/core";

import {
  compileComponentSetState,
  compileInstanceVariantSwitches,
} from "./variants.mjs";

const PENPOT_WRITE = SMALLPEN_FORMAT_CAPABILITIES.penpotWrite;
const PENPOT_ATTRIBUTES = new Set(PENPOT_WRITE.attributes);
const PENPOT_CHANGE_TYPES = new Set(PENPOT_WRITE.changeTypes);
const PENPOT_DERIVED_ATTRIBUTES = new Set(PENPOT_WRITE.derivedAttributes);
const PENPOT_GEOMETRY_ATTRIBUTES = new Set(["height", "width", "x", "y"]);
const PENPOT_PAGE_ATTRIBUTES = new Set(PENPOT_WRITE.pageAttributes);
const COMPONENT_TOUCHED_GROUPS = new Set(
  SMALLPEN_FORMAT_CAPABILITIES.webProjection.touchedGroups,
);
const APPLIED_TOKEN_ATTRIBUTES = new Set(
  SMALLPEN_FORMAT_CAPABILITIES.webProjection.appliedTokenAttributes,
);
const TOKEN_NAME_PATTERN = /^[a-zA-Z0-9_-][a-zA-Z0-9$_-]*(\.[a-zA-Z0-9$_-]+)*$/;
const PENPOT_CORNER_ATTRIBUTES = new Map([
  ["r1", 0],
  ["r2", 1],
  ["r3", 2],
  ["r4", 3],
]);
const PENPOT_FILL_FIELDS = new Set([
  "fill-color",
  "fill-color-gradient",
  "fill-color-ref-file",
  "fill-color-ref-id",
  "fill-image",
  "fill-opacity",
]);
const PENPOT_STROKE_FIELDS = new Set([
  "hidden",
  "stroke-alignment",
  "stroke-cap-end",
  "stroke-cap-start",
  "stroke-color",
  "stroke-color-gradient",
  "stroke-color-ref-file",
  "stroke-color-ref-id",
  "stroke-image",
  "stroke-dash",
  "stroke-gap",
  "stroke-opacity",
  "stroke-style",
  "stroke-width",
]);
const PENPOT_STROKE_SIDE_FIELDS = [
  "stroke-width-bottom",
  "stroke-width-left",
  "stroke-width-right",
  "stroke-width-top",
];
const DEFAULT_TEXT_STYLE = {
  fontFamily: "sourcesanspro",
  fontId: "sourcesanspro",
  fontSize: 14,
  fontStyle: "normal",
  fontVariantId: "regular",
  fontWeight: 400,
  letterSpacing: 0,
  lineHeight: 1.2,
  textAlign: "left",
  textDecoration: "none",
  textDirection: "ltr",
  textTransform: "none",
  verticalAlign: "top",
};
const PENPOT_TEXT_STYLE_FIELDS = new Map([
  ["direction", "textDirection"],
  ["font-family", "fontFamily"],
  ["font-id", "fontId"],
  ["font-size", "fontSize"],
  ["font-style", "fontStyle"],
  ["font-variant-id", "fontVariantId"],
  ["font-weight", "fontWeight"],
  ["letter-spacing", "letterSpacing"],
  ["line-height", "lineHeight"],
  ["text-align", "textAlign"],
  ["text-decoration", "textDecoration"],
  ["text-direction", "textDirection"],
  ["text-transform", "textTransform"],
  ["vertical-align", "verticalAlign"],
]);
// Penpot copies the library grouping path from a Typography asset into the
// rich-text nodes when that asset is applied. It is asset metadata, not a text
// style, so it must not leak into the canonical node style.
const TEXT_STRUCTURAL_FIELDS = new Set([
  "children",
  "key",
  "path",
  "text",
  "type",
]);
const DEFAULT_TEXT_FILLS = [{ color: "#000000", opacity: 1, type: "solid" }];
const TOKEN_CHANGE_TYPES = new Set([
  "move-token-set",
  "move-token-set-group",
  "rename-token-set-group",
  "set-active-token-themes",
  "set-tokens-status",
  "set-token",
  "set-token-set",
  "set-token-theme",
]);
const ASSET_CHANGE_TYPES = new Set([
  "add-color",
  "add-media",
  "add-typography",
  "del-color",
  "del-media",
  "del-typography",
  "mod-color",
  "mod-media",
  "mod-typography",
]);
const HIDDEN_TOKEN_THEME_PATH = "/__PENPOT__HIDDEN__TOKEN__THEME__";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeType(value) {
  return typeof value === "string" ? value.replace(/^:/, "") : value;
}

function canonicalNumber(value) {
  const rounded = Number(value.toFixed(9));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function referencedLibrary(snapshot, refFile) {
  if (String(refFile) === String(snapshot.runtime.file)) return snapshot;
  const library = snapshot.libraries?.find(
    (candidate) => String(candidate.runtime.file) === String(refFile),
  );
  if (!library) {
    fail(
      "unknown_external_library",
      `Penpot references an unavailable Library file: ${String(refFile)}`,
      { fileId: String(refFile) },
    );
  }
  return library;
}

function compileColorReference(snapshot, refId, refFile, index) {
  if (
    (refId === undefined || refId === null) &&
    (refFile === undefined || refFile === null)
  ) {
    return undefined;
  }
  if (
    refId === undefined ||
    refId === null ||
    refFile === undefined ||
    refFile === null
  ) {
    fail(
      "invalid_color_reference",
      "Penpot Color reference must contain id and file",
      { index },
    );
  }
  const owner = referencedLibrary(snapshot, refFile);
  const colorId =
    owner.runtime.reverseColors?.[String(refId)]?.colorId ??
    stableIdFromRuntime(refId, "color_", "invalid_runtime_color");
  return owner === snapshot
    ? colorId
    : { assetId: colorId, packageId: owner.manifest.packageId };
}

function canonicalMedia(snapshot, mediaId) {
  const entry = snapshot.manifest.entries.assets[0];
  return entry
    ? snapshot.entries[entry].media.find(({ id }) => id === mediaId)
    : undefined;
}

function referencedMedia(snapshot, runtimeId) {
  for (const owner of [snapshot, ...(snapshot.libraries ?? [])]) {
    const mediaId = owner.runtime.reverseMedia?.[String(runtimeId)]?.mediaId;
    if (mediaId) return { mediaId, owner };
  }
  return {
    mediaId: stableIdFromRuntime(
      runtimeId,
      "media_",
      "invalid_runtime_media",
    ),
    owner: snapshot,
  };
}

function compileMediaReference(snapshot, value, index) {
  if (!isRecord(value)) {
    fail(
      "invalid_media_reference",
      "Penpot Media reference must be an object",
      {
        index,
      },
    );
  }
  const supported = new Set([
    "height",
    "id",
    "keep-aspect-ratio",
    "mtype",
    "name",
    "width",
  ]);
  const unsupported = Object.keys(value).filter(
    (field) => !supported.has(field),
  );
  if (unsupported.length > 0) {
    fail(
      "unsupported_media_reference",
      `Penpot Media reference field is unsupported: ${unsupported[0]}`,
      { fields: unsupported, index },
    );
  }
  const { mediaId, owner } = referencedMedia(snapshot, value.id);
  const descriptor = canonicalMedia(owner, mediaId);
  if (
    descriptor &&
    ((value.width !== undefined && value.width !== descriptor.width) ||
      (value.height !== undefined && value.height !== descriptor.height) ||
      (value.mtype !== undefined && value.mtype !== descriptor.mimeType))
  ) {
    fail(
      "media_reference_mismatch",
      `Penpot Media metadata does not match the local asset: ${mediaId}`,
      { index, mediaId },
    );
  }
  return owner === snapshot
    ? mediaId
    : { assetId: mediaId, packageId: owner.manifest.packageId };
}

function compileFills(value, snapshot, existing = []) {
  if (!Array.isArray(value)) {
    fail("invalid_penpot_fills", "Penpot fills must be an array", { value });
  }
  return value.map((fill, index) => {
    if (!isRecord(fill)) {
      fail("invalid_penpot_fill", "Penpot fill must contain an object", {
        index,
        value: fill,
      });
    }
    const unsupportedFields = Object.entries(fill)
      .filter(([field, fieldValue]) => {
        return !PENPOT_FILL_FIELDS.has(field) && fieldValue !== null;
      })
      .map(([field]) => field);
    if (unsupportedFields.length > 0) {
      fail(
        "unsupported_penpot_fill",
        "Penpot fill contains unsupported gradient, image, or reference data",
        { fields: unsupportedFields, index },
      );
    }
    const color = fill["fill-color"];
    const gradient = fill["fill-color-gradient"];
    const image = fill["fill-image"];
    const opacity = fill["fill-opacity"];
    if (
      [color, gradient, image].filter((item) => item !== undefined).length !== 1
    ) {
      fail(
        "invalid_penpot_fill",
        "Penpot fill must contain exactly one color, gradient, or image",
        { index },
      );
    }
    if (
      opacity !== undefined &&
      (typeof opacity !== "number" ||
        !Number.isFinite(opacity) ||
        opacity < 0 ||
        opacity > 1)
    ) {
      fail(
        "invalid_fill_opacity",
        "Penpot fill-opacity must be between 0 and 1",
        { index, value: opacity },
      );
    }
    const includeOpacity =
      opacity !== undefined &&
      (opacity !== 1 || existing[index]?.opacity !== undefined);
    const result =
      image !== undefined
        ? {
            mediaRef: compileMediaReference(snapshot, image, index),
            ...(includeOpacity ? { opacity } : {}),
            type: "image",
          }
        : gradient === undefined
          ? {
              color,
              ...(includeOpacity ? { opacity } : {}),
              type: "solid",
            }
          : {
              ...compileGradient(gradient),
              ...(includeOpacity ? { opacity } : {}),
            };
    const colorRef = compileColorReference(
      snapshot,
      fill["fill-color-ref-id"],
      fill["fill-color-ref-file"],
      index,
    );
    if (colorRef !== undefined) {
      if (image !== undefined) {
        fail(
          "invalid_penpot_fill",
          "Penpot image fill cannot reference a Color",
        );
      }
      result.colorRef = colorRef;
    }
    return result;
  });
}

function compileGradient(value) {
  if (!isRecord(value)) {
    fail("invalid_penpot_gradient", "Penpot gradient must contain an object");
  }
  const type = normalizeType(value.type);
  if (type !== "linear" && type !== "radial") {
    fail(
      "unsupported_penpot_gradient",
      `Unsupported Penpot gradient: ${String(type)}`,
    );
  }
  for (const field of ["start-x", "start-y", "end-x", "end-y", "width"]) {
    if (typeof value[field] !== "number" || !Number.isFinite(value[field])) {
      fail(
        "invalid_penpot_gradient",
        `Penpot gradient ${field} must be finite`,
      );
    }
  }
  if (!Array.isArray(value.stops) || value.stops.length === 0) {
    fail("invalid_penpot_gradient", "Penpot gradient stops must be non-empty");
  }
  return {
    endX: value["end-x"],
    endY: value["end-y"],
    gradientWidth: value.width,
    startX: value["start-x"],
    startY: value["start-y"],
    stops: value.stops.map((stop, index) => {
      if (
        !isRecord(stop) ||
        typeof stop.color !== "string" ||
        typeof stop.offset !== "number" ||
        !Number.isFinite(stop.offset) ||
        stop.offset < 0 ||
        stop.offset > 1
      ) {
        fail(
          "invalid_penpot_gradient_stop",
          `Invalid Penpot gradient stop: ${index}`,
        );
      }
      if (
        stop.opacity !== undefined &&
        (typeof stop.opacity !== "number" ||
          !Number.isFinite(stop.opacity) ||
          stop.opacity < 0 ||
          stop.opacity > 1)
      ) {
        fail(
          "invalid_penpot_gradient_stop",
          `Invalid Penpot stop opacity: ${index}`,
        );
      }
      return {
        color: stop.color,
        offset: stop.offset,
        ...(stop.opacity === undefined ? {} : { opacity: stop.opacity }),
      };
    }),
    type: `${type}-gradient`,
  };
}

function compileStrokes(value, snapshot) {
  if (!Array.isArray(value)) {
    fail("invalid_penpot_strokes", "Penpot strokes must be an array");
  }
  return value.map((stroke, index) => {
    if (!isRecord(stroke)) {
      fail(
        "invalid_penpot_stroke",
        `Penpot stroke must be an object: ${index}`,
      );
    }
    const unsupported = Object.entries(stroke)
      .filter(([field, fieldValue]) => {
        // The width input writes every side along with stroke-width; only
        // sides that differ from it are a per-side width.
        if (PENPOT_STROKE_SIDE_FIELDS.includes(field)) return false;
        return !PENPOT_STROKE_FIELDS.has(field) && fieldValue !== null;
      })
      .map(([field]) => field);
    if (unsupported.length > 0) {
      fail(
        "unsupported_penpot_stroke",
        "Penpot stroke contains an unsupported image or reference",
        { fields: unsupported, index },
      );
    }
    const color = stroke["stroke-color"];
    const gradient = stroke["stroke-color-gradient"];
    const image = stroke["stroke-image"];
    if (
      [color, gradient, image].filter((item) => item !== undefined).length !== 1
    ) {
      fail(
        "invalid_penpot_stroke",
        "Penpot stroke must contain exactly one color, gradient, or image",
      );
    }
    const result =
      image !== undefined
        ? {
            mediaRef: compileMediaReference(snapshot, image, index),
            type: "image",
          }
        : gradient === undefined
          ? { color, type: "solid" }
          : compileGradient(gradient);
    const mappings = [
      ["stroke-alignment", "alignment"],
      ["stroke-cap-end", "capEnd"],
      ["stroke-cap-start", "capStart"],
      ["stroke-dash", "dash"],
      ["stroke-gap", "gap"],
      ["stroke-opacity", "opacity"],
      ["stroke-style", "style"],
      ["stroke-width", "width"],
      ["hidden", "hidden"],
    ];
    for (const [source, target] of mappings) {
      if (stroke[source] !== undefined && stroke[source] !== null) {
        result[target] = [
          "stroke-alignment",
          "stroke-cap-end",
          "stroke-cap-start",
          "stroke-style",
        ].includes(source)
          ? normalizeType(stroke[source])
          : stroke[source];
      }
    }
    // A side that differs from the stroke width is its own width.
    for (const [attribute, field] of [
      ["stroke-width-top", "widthTop"],
      ["stroke-width-right", "widthRight"],
      ["stroke-width-bottom", "widthBottom"],
      ["stroke-width-left", "widthLeft"],
    ]) {
      const side = stroke[attribute];
      if (side !== undefined && side !== null && side !== stroke["stroke-width"]) result[field] = side;
    }
    const colorRef = compileColorReference(
      snapshot,
      stroke["stroke-color-ref-id"],
      stroke["stroke-color-ref-file"],
      index,
    );
    if (colorRef !== undefined) {
      if (image !== undefined) {
        fail(
          "invalid_penpot_stroke",
          "Penpot image stroke cannot reference a Color",
        );
      }
      result.colorRef = colorRef;
    }
    return result;
  });
}

function normalizedFills(value) {
  return value.map((fill) => {
    if (fill.type === "solid") {
      return {
        color: fill.color.toLowerCase(),
        ...(fill.colorRef === undefined ? {} : { colorRef: fill.colorRef }),
        opacity: fill.opacity ?? 1,
        type: fill.type,
      };
    }
    if (fill.type === "image") {
      return {
        mediaRef: fill.mediaRef,
        opacity: fill.opacity ?? 1,
        type: fill.type,
      };
    }
    return {
      ...fill,
      opacity: fill.opacity ?? 1,
      stops: fill.stops.map((stop) => ({
        ...stop,
        color: stop.color.toLowerCase(),
        opacity: stop.opacity ?? 1,
      })),
    };
  });
}

function sameFills(left, right) {
  return (
    JSON.stringify(normalizedFills(left)) ===
    JSON.stringify(normalizedFills(right))
  );
}

function textStyleValue(field, value) {
  if (
    ["fontSize", "fontWeight", "letterSpacing", "lineHeight"].includes(field)
  ) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      fail("invalid_penpot_text_style", `Penpot ${field} must be numeric`);
    }
    return numeric;
  }
  if (typeof value !== "string" || value.length === 0) {
    fail("invalid_penpot_text_style", `Penpot ${field} must be non-empty`);
  }
  return value;
}

function canonicalFontId(snapshot, value) {
  const fontId = textStyleValue("fontId", value);
  if (!fontId.startsWith("custom-")) return fontId;
  const runtimeId = fontId.slice("custom-".length);
  const stableFontId = snapshot.runtime.reverseFonts?.[runtimeId]?.fontId;
  if (!stableFontId) {
    fail("invalid_runtime_font", `Custom Font does not exist: ${fontId}`);
  }
  return stableFontId;
}

function mergeTextStyle(inherited, value, allowFills = false, snapshot) {
  const style = { ...inherited };
  if (
    Object.hasOwn(value, "typography-ref-file") ||
    Object.hasOwn(value, "typography-ref-id")
  ) {
    const refFile = value["typography-ref-file"];
    const refId = value["typography-ref-id"];
    if (refFile === null && refId === null) {
      delete style.typographyRef;
    } else {
      if (
        refFile === undefined ||
        refFile === null ||
        refId === undefined ||
        refId === null
      ) {
        fail(
          "invalid_typography_reference",
          "Penpot Typography reference must contain id and file",
        );
      }
      const owner = referencedLibrary(snapshot, refFile);
      const typographyId =
        owner.runtime.reverseTypographies?.[String(refId)]?.typographyId ??
        stableIdFromRuntime(refId, "typo_", "invalid_runtime_typography");
      style.typographyRef =
        owner === snapshot
          ? typographyId
          : { assetId: typographyId, packageId: owner.manifest.packageId };
    }
  }
  for (const [field, fieldValue] of Object.entries(value)) {
    if (TEXT_STRUCTURAL_FIELDS.has(field)) continue;
    if (field === "fills" && allowFills) continue;
    if (field === "typography-ref-file" || field === "typography-ref-id") {
      continue;
    }
    // A font-weight Token merges its variant ({weight, style}) into the
    // text node beside the font-weight and font-style it sets.
    if (
      (field === "weight" && fieldValue === value["font-weight"]) ||
      (field === "style" && fieldValue === value["font-style"])
    ) {
      continue;
    }
    const canonicalField = PENPOT_TEXT_STYLE_FIELDS.get(field);
    if (!canonicalField) {
      fail(
        "unsupported_penpot_rich_text",
        `Penpot text style is not supported yet: ${field}`,
        { field, value: fieldValue },
      );
    }
    if (normalizeType(fieldValue) === "unset") continue;
    style[canonicalField] =
      canonicalField === "fontId"
        ? canonicalFontId(snapshot, fieldValue)
        : textStyleValue(canonicalField, fieldValue);
  }
  return style;
}

function sameTextStyle(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function textStyleOverrides(style) {
  return Object.fromEntries(
    Object.entries(style).filter(([field, value]) => {
      return value !== DEFAULT_TEXT_STYLE[field];
    }),
  );
}

function textStyleDifference(style, inherited) {
  return Object.fromEntries(
    Object.entries(style).filter(
      ([field, value]) => value !== inherited[field],
    ),
  );
}

function compilePlainTextContent(
  value,
  { allowMissing = false, snapshot } = {},
) {
  if (value === undefined && allowMissing) {
    return {
      fills: DEFAULT_TEXT_FILLS,
      text: "",
      textBlocks: undefined,
      textStyle: {},
    };
  }
  if (
    !isRecord(value) ||
    value.type !== "root" ||
    !Array.isArray(value.children)
  ) {
    fail(
      "invalid_penpot_text_content",
      "Penpot text content must contain a root",
    );
  }
  const rootStyle = mergeTextStyle(DEFAULT_TEXT_STYLE, value, false, snapshot);
  const paragraphs = [];
  const textBlocks = [];
  let uniformFills;
  let uniformStyle;
  let fillsAreUniform = true;
  let stylesAreUniform = true;
  for (const paragraphSet of value.children) {
    if (
      !isRecord(paragraphSet) ||
      paragraphSet.type !== "paragraph-set" ||
      !Array.isArray(paragraphSet.children) ||
      paragraphSet.children.length === 0
    ) {
      fail(
        "invalid_penpot_text_content",
        "Penpot text root must contain non-empty paragraph sets",
      );
    }
    const paragraphSetStyle = mergeTextStyle(
      rootStyle,
      paragraphSet,
      false,
      snapshot,
    );
    for (const paragraph of paragraphSet.children) {
      if (
        !isRecord(paragraph) ||
        paragraph.type !== "paragraph" ||
        !Array.isArray(paragraph.children) ||
        paragraph.children.length === 0
      ) {
        fail(
          "invalid_penpot_text_content",
          "Penpot paragraph must contain at least one text span",
        );
      }
      const paragraphStyle = mergeTextStyle(
        paragraphSetStyle,
        paragraph,
        true,
        snapshot,
      );
      const paragraphFills =
        paragraph.fills === undefined || paragraph.fills === null
          ? undefined
          : compileFills(paragraph.fills, snapshot);
      let paragraphText = "";
      const runs = [];
      for (const span of paragraph.children) {
        if (
          !isRecord(span) ||
          typeof span.text !== "string" ||
          span.type !== undefined
        ) {
          fail(
            "invalid_penpot_text_content",
            "Penpot paragraph child must be a text span",
          );
        }
        const spanStyle = mergeTextStyle(paragraphStyle, span, true, snapshot);
        // Penpot keeps stale paragraph attributes on text spans when alignment
        // or direction changes. Those controls are paragraph-scoped, so the
        // paragraph must remain authoritative over its spans.
        spanStyle.textAlign = paragraphStyle.textAlign;
        spanStyle.textDirection = paragraphStyle.textDirection;
        paragraphText += span.text;
        const fills =
          span.fills === undefined || span.fills === null
            ? (paragraphFills ?? DEFAULT_TEXT_FILLS)
            : compileFills(span.fills, snapshot);
        if (uniformFills && !sameFills(uniformFills, fills)) {
          fillsAreUniform = false;
        }
        uniformFills ??= fills;
        if (uniformStyle && !sameTextStyle(uniformStyle, spanStyle)) {
          stylesAreUniform = false;
        }
        uniformStyle ??= spanStyle;
        const runStyle = textStyleDifference(spanStyle, paragraphStyle);
        runs.push({
          fills,
          text: span.text,
          ...(Object.keys(runStyle).length === 0
            ? {}
            : { textStyle: runStyle }),
        });
      }
      paragraphs.push(paragraphText);
      const blockStyle = textStyleDifference(paragraphStyle, rootStyle);
      textBlocks.push({
        runs,
        ...(Object.keys(blockStyle).length === 0
          ? {}
          : { textStyle: blockStyle }),
      });
    }
  }
  if (paragraphs.length === 0) {
    fail("invalid_penpot_text_content", "Penpot text must contain a paragraph");
  }
  const rich = !fillsAreUniform || !stylesAreUniform;
  if (rich) {
    for (const block of textBlocks) {
      for (const run of block.runs) {
        if (fillsAreUniform) delete run.fills;
      }
    }
  }
  return {
    fills: fillsAreUniform
      ? (uniformFills ?? DEFAULT_TEXT_FILLS)
      : DEFAULT_TEXT_FILLS,
    text: paragraphs.join("\n"),
    textBlocks: rich ? textBlocks : undefined,
    textStyle: rich
      ? textStyleOverrides(rootStyle)
      : textStyleOverrides(uniformStyle ?? rootStyle),
  };
}

// Penpot PATH shapes carry :content as a segment vector
// ({command: "move-to"|"line-to"|"curve-to"|"close-path", params: {...}}) in
// page-absolute coordinates, already turned by the shape's transform. The
// canonical package format stores path geometry as the pathData string LOCAL
// to the node box (packages/local-package/src/render.mjs), so map every point
// through the inverse of the node's absolute matrix.
function compilePathContent(value, inverse = [1, 0, 0, 1, 0, 0]) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) {
    fail(
      "invalid_penpot_path",
      "Penpot path content must be a segment array or a pathData string",
      { value },
    );
  }
  let pathData = "";
  for (const segment of value) {
    if (!isRecord(segment)) {
      fail("invalid_penpot_path", "Penpot path segment must be an object", {
        value: segment,
      });
    }
    const command = normalizeType(segment.command);
    const params = isRecord(segment.params) ? segment.params : {};
    const number = (key) => {
      const coordinate = params[key];
      if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) {
        fail(
          "invalid_penpot_path",
          `Penpot path segment ${command} is missing a finite ${key}`,
          { value: segment },
        );
      }
      return coordinate;
    };
    const point = (prefix = "") => {
      const local = matrixPoint(
        inverse,
        number(`${prefix}x`),
        number(`${prefix}y`),
      );
      return `${canonicalNumber(local.x)},${canonicalNumber(local.y)}`;
    };
    if (command === "move-to") {
      pathData += `M${point()}`;
    } else if (command === "line-to") {
      pathData += `L${point()}`;
    } else if (command === "curve-to") {
      pathData += `C${point("c1")},${point("c2")},${point()}`;
    } else if (command === "close-path") {
      pathData += "Z";
    } else {
      fail("invalid_penpot_path", `Penpot path command is unknown: ${String(segment.command)}`, {
        value: segment,
      });
    }
  }
  if (pathData.length === 0) {
    fail("invalid_penpot_path", "Penpot path content is empty", { value });
  }
  return pathData;
}

function compileTextContent(operation, value, node, snapshot) {
  if (node.type !== "TEXT") {
    fail(
      "unexpected_text_attribute",
      "Only a Penpot text shape can change content",
    );
  }
  const compiled = compilePlainTextContent(value, { snapshot });
  if (compiled.text !== node.text) operation.changes.text = compiled.text;
  if (compiled.textBlocks === undefined) {
    if (Object.hasOwn(node, "textBlocks")) operation.changes.textBlocks = null;
  } else if (
    JSON.stringify(compiled.textBlocks) !== JSON.stringify(node.textBlocks)
  ) {
    operation.changes.textBlocks = compiled.textBlocks;
  }
  if (Object.keys(compiled.textStyle).length === 0) {
    if (Object.hasOwn(node, "textStyle")) operation.changes.textStyle = null;
  } else if (!sameTextStyle(compiled.textStyle, node.textStyle ?? {})) {
    operation.changes.textStyle = compiled.textStyle;
  }
  if (sameFills(compiled.fills, DEFAULT_TEXT_FILLS)) {
    if (Object.hasOwn(node, "fills")) operation.changes.fills = null;
  } else if (!node.fills || !sameFills(compiled.fills, node.fills)) {
    operation.changes.fills = compiled.fills;
  }
}

function projectedSnapshotNodes(snapshot, descriptor) {
  const dependencyIds = new Set(
    (snapshot.manifest.dependencies ?? []).map(({ packageId }) => packageId),
  );
  const foundation = (snapshot.libraries ?? []).find(({ manifest }) =>
    dependencyIds.has(manifest.packageId),
  );
  const libraries = (snapshot.libraries ?? []).filter(
    (candidate) => candidate !== foundation,
  );
  return projectScreen(snapshot, descriptor.screenId, {
    context: snapshot.projection?.context,
    foundation,
    libraries,
    presentationId: descriptor.presentationId,
  }).nodes;
}

function projectedNode(snapshot, descriptor, projections) {
  const key = `${descriptor.screenId}\0${descriptor.presentationId}`;
  let nodes = projections.get(key);
  if (!nodes) {
    nodes = projectedSnapshotNodes(snapshot, descriptor);
    projections.set(key, nodes);
  }
  return nodes[descriptor.nodeId];
}

// What a cleared (nil) Penpot attribute means: flags read as false, corners
// and turns as zero.
const PENPOT_NULL_DEFAULTS = new Map([
  ["blocked", false],
  ["flip-x", false],
  ["flip-y", false],
  ["hidden", false],
  ["proportion-lock", false],
  ["r1", 0],
  ["r2", 0],
  ["r3", 0],
  ["r4", 0],
  ["rotation", 0],
]);
// Every Penpot shape keeps these; a nil one is rejected by its validator.
const PENPOT_REQUIRED_ATTRIBUTES = new Set(["height", "name", "width"]);
// Cleared Penpot attributes whose canonical field has another name.
const PENPOT_NULL_FIELDS = new Map([
  ["applied-tokens", "appliedTokens"],
  ["background-blur", "backgroundBlur"],
]);

function cornerRadii(value) {
  if (typeof value === "number") return [value, value, value, value];
  if (Array.isArray(value) && value.length === 4) return [...value];
  return [0, 0, 0, 0];
}

function compileAttribute(operation, attr, value, node, snapshot) {
  if (value === null && !PENPOT_REQUIRED_ATTRIBUTES.has(attr)) {
    // Penpot inverse/undo edits clear attributes with an explicit null
    // (changes_builder `update-shapes` sets an attr the shape lacked back to
    // nil, and Penpot dissocs it). Flags and corners fall back to their
    // Penpot default; any other attr removes its canonical field, which the
    // update-presentation-node contract spells as null.
    if (PENPOT_NULL_DEFAULTS.has(attr)) {
      compileAttribute(
        operation,
        attr,
        PENPOT_NULL_DEFAULTS.get(attr),
        node,
        snapshot,
      );
      return;
    }
    if (attr === "grow-type" || attr === "metadata") {
      // A shape that cannot grow or hold media has nothing to clear.
      const field = attr === "grow-type" ? "growType" : "mediaRef";
      if (Object.hasOwn(node, field)) operation.changes[field] = null;
      return;
    }
    if (attr === "applied-tokens") {
      compileAppliedTokenBindings(operation, {}, node, snapshot);
    }
    operation.changes[PENPOT_NULL_FIELDS.get(attr) ?? attr] = null;
    return;
  }
  if (attr === "applied-tokens") {
    const applied = compileAppliedTokens(value);
    compileAppliedTokenBindings(operation, applied, node, snapshot);
    // Applied Tokens are bindings now; only an attribute the format cannot
    // bind stays a name. Older names give way to the bindings.
    if (Object.keys(applied).length > 0) operation.changes.appliedTokens = applied;
    else if (node.appliedTokens !== undefined) operation.changes.appliedTokens = null;
    return;
  }
  const cornerIndex = PENPOT_CORNER_ATTRIBUTES.get(attr);
  if (cornerIndex !== undefined) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      fail(
        "invalid_corner_radius",
        `Penpot ${attr} must be a finite non-negative number`,
        { attr, value },
      );
    }
    const radii = cornerRadii(
      operation.changes.cornerRadius ?? node.cornerRadius,
    );
    radii[cornerIndex] = canonicalNumber(value);
    operation.changes.cornerRadius = radii.every((radius) => radius === 0)
      ? null
      : radii;
    return;
  }
  if (attr === "fills") {
    operation.changes.fills = compileFills(value, snapshot, node.fills);
    return;
  }
  if (attr === "content") {
    // PATH content is normalized to local pathData in compileNodeUpdate
    // (where the shape's absolute origin is known); everything else is text.
    compileTextContent(operation, value, node, snapshot);
    return;
  }
  if (attr === "strokes") {
    operation.changes.strokes = compileStrokes(value, snapshot);
    return;
  }
  if (attr === "interactions") {
    if (
      !Array.isArray(value) ||
      value.some((interaction) => !isRecord(interaction))
    ) {
      fail(
        "invalid_penpot_interactions",
        "Penpot interactions must be an array of objects",
      );
    }
    operation.changes.interactions = structuredClone(value);
    return;
  }
  if (attr === "shadow" || attr === "blur" || attr === "background-blur") {
    if (!(
      (Array.isArray(value) && value.every((entry) => isRecord(entry))) ||
      isRecord(value)
    )) {
      fail(
        "invalid_penpot_effect",
        `Penpot ${attr} must be an object or array of objects`,
        { attr, value },
      );
    }
    const field = attr === "background-blur" ? "backgroundBlur" : attr;
    operation.changes[field] = structuredClone(value);
    return;
  }
  const layoutFields = new Set([
    "layout",
    "layout-flex-dir",
    "layout-gap-type",
    "layout-gap",
    "layout-align-items",
    "layout-justify-content",
    "layout-align-content",
    "layout-wrap-type",
    "layout-padding-type",
    "layout-padding",
    "layout-item-margin",
    "layout-item-margin-type",
    "layout-item-h-sizing",
    "layout-item-v-sizing",
    "layout-item-max-h",
    "layout-item-min-h",
    "layout-item-max-w",
    "layout-item-min-w",
    "layout-item-align-self",
    "layout-item-absolute",
    "layout-item-z-index",
    "constraints-h",
    "constraints-v",
    "fixed-scroll",
    "exports",
    "content",
    "pathData",
    "points",
  ]);
  if (layoutFields.has(attr)) {
    if (value === null || value === undefined) {
      operation.changes[attr] = null;
      return;
    }
    if (
      [
        "layout-gap",
        "layout-padding",
        "layout-item-margin",
        "constraints-h",
        "constraints-v",
        "exports",
        "content",
        "pathData",
        "points",
      ].includes(attr)
    ) {
      if (!isRecord(value)) {
        if (
          ["content", "pathData"].includes(attr) &&
          typeof value !== "string"
        ) {
          fail("invalid_penpot_path", `Penpot ${attr} must be a string`, {
            attr,
            value,
          });
        }
        if (attr === "points" && !Array.isArray(value)) {
          fail("invalid_penpot_path", "Penpot points must be an array", {
            attr,
            value,
          });
        }
        if (
          attr !== "exports" &&
          !["content", "pathData", "points"].includes(attr) &&
          !(
            attr === "constraints-h" ||
            (attr === "constraints-v" && typeof value === "string")
          )
        ) {
          fail("invalid_penpot_layout", `Penpot ${attr} must be an object`, {
            attr,
            value,
          });
        }
      }
      if (attr === "exports" && !Array.isArray(value)) {
        fail("invalid_penpot_export", "Penpot exports must be an array", {
          attr,
          value,
        });
      }
    } else if (["layout-item-absolute", "fixed-scroll"].includes(attr)) {
      if (typeof value !== "boolean") {
        fail("invalid_penpot_layout", `Penpot ${attr} must be boolean`, {
          attr,
          value,
        });
      }
    } else if (
      [
        "layout-item-max-h",
        "layout-item-min-h",
        "layout-item-max-w",
        "layout-item-min-w",
        "layout-item-z-index",
      ].includes(attr)
    ) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        fail(
          "invalid_penpot_layout",
          `Penpot ${attr} must be a finite number`,
          { attr, value },
        );
      }
    } else if (typeof value !== "string") {
      fail("invalid_penpot_layout", `Penpot ${attr} must be a string`, {
        attr,
        value,
      });
    }
    operation.changes[attr] = structuredClone(value);
    return;
  }
  if (attr === "metadata") {
    if (node.type !== "IMAGE") {
      fail(
        "unexpected_media_attribute",
        "Only a Penpot image can change metadata",
      );
    }
    operation.changes.mediaRef = compileMediaReference(snapshot, value);
    return;
  }
  if (attr === "touched") {
    if (!Array.isArray(value)) {
      fail("invalid_component_touched", "Penpot touched must be an array");
    }
    const groups = value.map(normalizeType);
    if (
      new Set(groups).size !== groups.length ||
      groups.some((group) => !COMPONENT_TOUCHED_GROUPS.has(group))
    ) {
      fail(
        "unsupported_component_touched_group",
        "Penpot touched contains an unsupported or duplicate group",
      );
    }
    operation.changes.touched = groups;
    return;
  }
  if (attr === "rotation") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      fail("invalid_node_rotation", "Penpot rotation must be finite");
    }
    const rotation = ((value % 360) + 360) % 360;
    if (rotation === 0) {
      if (Object.hasOwn(node, "rotation")) operation.changes.rotation = null;
    } else {
      operation.changes.rotation = rotation;
    }
    return;
  }
  if (attr === "flip-x" || attr === "flip-y") {
    if (typeof value !== "boolean") {
      fail("invalid_node_flip", `Penpot ${attr} must be boolean`);
    }
    const field = attr === "flip-x" ? "flipX" : "flipY";
    if (value) {
      operation.changes[field] = true;
    } else if (Object.hasOwn(node, field)) {
      operation.changes[field] = null;
    }
    return;
  }
  if (attr === "grow-type") {
    if (node.type !== "TEXT") {
      fail("unexpected_text_attribute", "Only a Penpot text shape can grow");
    }
    const growType = normalizeType(value);
    if (!new Set(["auto-height", "auto-width", "fixed"]).has(growType)) {
      fail(
        "invalid_text_grow_type",
        `Unsupported Penpot grow-type: ${String(value)}`,
      );
    }
    if (growType === "fixed") {
      if (Object.hasOwn(node, "growType")) operation.changes.growType = null;
    } else {
      operation.changes.growType = growType;
    }
    return;
  }
  if (PENPOT_GEOMETRY_ATTRIBUTES.has(attr)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      fail("invalid_node_number", `Penpot ${attr} must be a finite number`, {
        attr,
        value,
      });
    }
    operation.changes[attr] = canonicalNumber(value);
    return;
  }
  if (attr === "hidden") {
    if (typeof value !== "boolean") {
      fail("invalid_node_visibility", "Penpot hidden must be a boolean", {
        value,
      });
    }
    operation.changes.visible = !value;
    return;
  }
  if (attr === "blocked" || attr === "proportion-lock") {
    if (typeof value !== "boolean") {
      fail("invalid_node_boolean", `Penpot ${attr} must be a boolean`, {
        value,
      });
    }
    const field = attr === "blocked" ? "locked" : "proportionLock";
    if (value) {
      operation.changes[field] = true;
    } else if (Object.hasOwn(node, field)) {
      operation.changes[field] = null;
    }
    return;
  }
  const booleanFields = new Set([
    "hide-fill-on-export",
    "hide-in-viewer",
    "masked-group",
    "show-content",
  ]);
  if (booleanFields.has(attr)) {
    if (typeof value !== "boolean") {
      fail("invalid_node_boolean", `Penpot ${attr} must be a boolean`, {
        attr,
        value,
      });
    }
    operation.changes[attr] = value;
    return;
  }
  if (attr === "blend-mode") {
    const blendMode = normalizeType(value);
    if (typeof blendMode !== "string" || blendMode.length === 0) {
      fail("invalid_blend_mode", "Penpot blend-mode must be a non-empty name");
    }
    operation.changes[attr] = blendMode;
    return;
  }
  if (attr === "grids") {
    if (!Array.isArray(value) || value.some((grid) => !isRecord(grid))) {
      fail("invalid_grids", "Penpot grids must be an array of objects");
    }
    operation.changes.grids = structuredClone(value);
    return;
  }
  if (attr === "name") {
    if (typeof value !== "string") {
      fail("invalid_node_name", "Penpot name must be a string", { value });
    }
    operation.changes.name = value;
    return;
  }
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    fail(
      "invalid_opacity",
      "Penpot opacity must be a finite number between 0 and 1",
    );
  }
  operation.changes.opacity = value;
}

function runtimeNodeId(runtimeId) {
  const value = String(runtimeId).toLowerCase();
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value,
    )
  ) {
    fail("invalid_runtime_node", `Penpot node ID is not a UUID: ${value}`);
  }
  return `node_${value.replaceAll("-", "")}`;
}

function runtimePresentationId(runtimeId) {
  const value = String(runtimeId).toLowerCase();
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value,
    )
  ) {
    fail("invalid_runtime_page", `Penpot page ID is not a UUID: ${value}`);
  }
  return `pres_${value.replaceAll("-", "")}`;
}

function runtimeComponentId(runtimeId) {
  const value = String(runtimeId).toLowerCase();
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value,
    )
  ) {
    fail(
      "invalid_runtime_component",
      `Penpot component ID is not a UUID: ${value}`,
    );
  }
  return `cmp_${value.replaceAll("-", "")}`;
}

function pageDescriptorById(snapshot, pageId) {
  const descriptor = snapshot.runtime.reversePages?.[String(pageId)];
  if (!descriptor && snapshot.addedPages?.has(String(pageId))) {
    fail(
      "duplicate_canvas_unsupported",
      "Copying a whole canvas is not supported yet; ask the agent to copy the pages with the CLI (page draw)",
    );
  }
  if (!descriptor) {
    fail(
      "unknown_runtime_page",
      `Penpot runtime page is not mapped to SmallPen: ${String(pageId)}`,
    );
  }
  return descriptor;
}

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

// A canvas holds several page versions (boards). An edit belongs to the
// board of the shape it touches, of its parent, or of the frame it is in;
// a canvas with one board answers for it directly, as a page did.
function pageWithBoard(snapshot, page, ids) {
  if (page.screenId !== undefined) return page;
  for (const id of ids) {
    if (id === undefined || id === null || String(id) === ZERO_UUID) continue;
    const board = snapshot.runtime.reverseNodes?.[String(id)] ?? snapshot.addedBoards?.get(String(id));
    if (board?.screenId)
      return { ...page, presentationId: board.presentationId, screenId: board.screenId };
  }
  fail(
    "canvas_board_unknown",
    "This edit is on a canvas with several pages and belongs to none of them. Draw a new page with the CLI (page draw); App edits work inside the pages",
    { canvas: page.canvasName },
  );
}

// Where a board's top-level shapes sit on the canvas versus where they are
// stored: the canvas layout's shift (none when the layout was not applied).
function boardOffset(snapshot, board) {
  const placed = snapshot.canvases?.flatMap((canvas) => canvas.boards)
    .find((item) => item.screenId === board.screenId && item.presentationId === board.presentationId);
  return { dx: placed?.dx ?? 0, dy: placed?.dy ?? 0 };
}

// A shape dropped outside every board on a shared canvas belongs to the
// board nearest to where it landed, and moves with that board.
function nearestBoard(snapshot, page, x, y) {
  let best;
  for (const board of page.boards ?? []) {
    const presentation = snapshotPresentation(snapshot, board);
    const roots = (Array.isArray(presentation?.rootIds) ? presentation.rootIds : [presentation?.rootId])
      .map((id) => presentation?.nodes?.[id]).filter(Boolean);
    for (const root of roots) {
      const dx = Math.max(root.x - x, 0, x - (root.x + root.width));
      const dy = Math.max(root.y - y, 0, y - (root.y + root.height));
      const distance = Math.hypot(dx, dy);
      if (!best || distance < best.distance) best = { board, distance };
    }
  }
  return best?.board;
}

function pageDescriptor(snapshot, change) {
  const pageId = change.pageId ?? change["page-id"];
  const page = pageDescriptorById(snapshot, pageId);
  const parent = String(change["parent-id"] ?? change.parentId ?? change.obj?.["parent-id"] ?? "");
  if (page.screenId === undefined && normalizeType(change.type) === "add-obj" && parent === ZERO_UUID) {
    const board = snapshot.addedBoards?.get(String(change.id ?? change.obj?.id)) ??
      nearestBoard(snapshot, page, change.obj?.x ?? 0, change.obj?.y ?? 0);
    if (board) return { ...page, presentationId: board.presentationId, screenId: board.screenId, loose: true };
  }
  return pageWithBoard(snapshot, page, [
    change.id,
    change.obj?.id,
    change["parent-id"],
    change.parentId,
    change.obj?.["parent-id"],
    change["frame-id"],
    change.obj?.["frame-id"],
    change.params?.["starting-frame"],
    ...(change.shapes ?? []),
  ]);
}

// The board each shape a commit adds belongs to, from its parent, in order.
function addedShapeBoards(snapshot, changes) {
  const boards = new Map();
  for (const change of changes) {
    if (normalizeType(change?.type) !== "add-obj") continue;
    const id = String(change.id ?? change.obj?.id);
    const parent = String(change["parent-id"] ?? change.parentId ?? change.obj?.["parent-id"] ?? ZERO_UUID);
    let board = snapshot.runtime.reverseNodes?.[parent] ?? boards.get(parent);
    if (!board && parent === ZERO_UUID) {
      const page = snapshot.runtime.reversePages?.[String(change.pageId ?? change["page-id"])];
      board = page && page.screenId === undefined ? nearestBoard(snapshot, page, change.obj?.x ?? 0, change.obj?.y ?? 0) : undefined;
    }
    if (board?.screenId) boards.set(id, { presentationId: board.presentationId, screenId: board.screenId });
  }
  return boards;
}

function nodeDescriptor(snapshot, runtimeId, page, allowNew = false) {
  const value = String(runtimeId);
  const existing = snapshot.runtime.reverseNodes[value];
  if (existing) {
    if (
      page &&
      (existing.screenId !== page.screenId ||
        existing.presentationId !== page.presentationId)
    ) {
      fail(
        "runtime_page_mismatch",
        `Penpot node is owned by another page: ${value}`,
      );
    }
    return existing;
  }
  if (allowNew && page) {
    return {
      nodeId: snapshot.addedNodeIds?.get(value) ?? runtimeNodeId(value),
      presentationId: page.presentationId,
      screenId: page.screenId,
    };
  }
  fail(
    "unknown_runtime_node",
    `Penpot runtime node is not mapped to SmallPen: ${value}`,
  );
}

function parentDescriptor(snapshot, runtimeId, page) {
  if (String(runtimeId) === "00000000-0000-0000-0000-000000000000") {
    return {
      nodeId: null,
      presentationId: page.presentationId,
      screenId: page.screenId,
    };
  }
  return nodeDescriptor(snapshot, runtimeId, page, true);
}

function snapshotPresentation(snapshot, page) {
  const screenEntry = snapshot.manifest.entries.screens.find(
    (entry) => snapshot.entries[entry].id === page.screenId,
  );
  return snapshot.entries[screenEntry]?.presentations.find(
    (presentation) => presentation.id === page.presentationId,
  );
}

// Children of a component instance exist only in the projection (the web
// runtime maps their derived ids too). Penpot keeps copies structurally
// locked; a change that still adds, removes or reorders their tree would be
// an instance override no canonical operation can write.
function requireCanonicalStructure(snapshot, runtimeId, descriptor) {
  if (
    descriptor.nodeId === null ||
    snapshot.runtime.reverseNodes?.[String(runtimeId)] === undefined ||
    presentationNodes(snapshot, descriptor)?.[descriptor.nodeId]
  ) {
    return;
  }
  fail(
    "component_instance_override_unsupported",
    "Edit the Component source before changing the structure of this projected child",
    { instanceNodeId: descriptor.nodeId },
  );
}

// Canonical nodes (not projected instance children) that a commit deletes.
function deletedCanonicalNodeIds(snapshot, changes) {
  const deleted = new Set();
  for (const change of changes) {
    if (normalizeType(change?.type) !== "del-obj") continue;
    const descriptor = snapshot.runtime.reverseNodes?.[String(change.id)];
    if (descriptor && presentationNodes(snapshot, descriptor)?.[descriptor.nodeId]) {
      deleted.add(descriptor.nodeId);
    }
  }
  return deleted;
}

// A projected instance child whose owning instance node (the leading
// "<instanceId>__" segment of its composed id) is deleted in the same commit.
function deletedWithOwnerInstance(snapshot, descriptor, deletedNodeIds) {
  if (
    descriptor.nodeId === null ||
    snapshot.runtime.reverseNodes === undefined ||
    presentationNodes(snapshot, descriptor)?.[descriptor.nodeId]
  ) {
    return false;
  }
  for (const nodeId of deletedNodeIds) {
    if (descriptor.nodeId.startsWith(`${nodeId}__`)) return true;
  }
  return false;
}

function presentationNodes(snapshot, page) {
  return snapshotPresentation(snapshot, page)?.nodes;
}

function canonicalParentId(nodes, nodeId) {
  for (const node of Object.values(nodes ?? {})) {
    if ((node.children ?? []).includes(nodeId)) return node.id;
  }
  return null;
}

// Canonical node geometry is parent-relative: a node's x/y, rotation and
// flips apply inside its parent's FULL transform, the matrix local-package
// render.mjs `nodeTransform` builds and composes down the tree. Penpot shapes
// are page-absolute: a selrect (x/y/width/height) turned by a linear
// :transform about its center, with :rotation/:flip-x/:flip-y as page-level
// values. A "placement" is that absolute Penpot geometry plus its matrix; the
// frontend projection (projection.cljs `absolute-origins`) composes the same
// chain in the other direction. Matrices are [a, b, c, d, e, f]:
// x' = a*x + c*y + e, y' = b*x + d*y + f.
const QUARTER_TURNS = new Map([
  [0, [1, 0]],
  [90, [0, 1]],
  [180, [-1, 0]],
  [270, [0, -1]],
]);
const ROOT_PLACEMENT = Object.freeze({
  flipX: false,
  flipY: false,
  height: 0,
  linear: [1, 0, 0, 1],
  matrix: [1, 0, 0, 1, 0, 0],
  rotation: 0,
  width: 0,
  x: 0,
  y: 0,
});
const PLACEMENT_ATTRIBUTES = new Set([
  "flip-x",
  "flip-y",
  "height",
  "rotation",
  "selrect",
  "transform",
  "width",
  "x",
  "y",
]);

function multiplyMatrix(left, right) {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function invertMatrix(matrix) {
  const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
    fail("invalid_node_transform", "Node transform cannot be inverted", {
      matrix,
    });
  }
  return [
    matrix[3] / determinant,
    -matrix[1] / determinant,
    -matrix[2] / determinant,
    matrix[0] / determinant,
    (matrix[2] * matrix[5] - matrix[3] * matrix[4]) / determinant,
    (matrix[1] * matrix[4] - matrix[0] * matrix[5]) / determinant,
  ];
}

function matrixPoint(matrix, x, y) {
  return {
    x: matrix[0] * x + matrix[2] * y + matrix[4],
    y: matrix[1] * x + matrix[3] * y + matrix[5],
  };
}

function translationOnly(matrix) {
  return (
    matrix[0] === 1 && matrix[1] === 0 && matrix[2] === 0 && matrix[3] === 1
  );
}

function normalizedRotation(value) {
  const rotation = canonicalNumber((((value % 360) + 360) % 360));
  return rotation === 360 ? 0 : rotation;
}

// R(rotation)·diag(flipX ? -1 : 1, flipY ? -1 : 1), exact on quarter turns.
function rotationLinear(rotation, flipX, flipY) {
  const turn = ((rotation % 360) + 360) % 360;
  const angle = (turn * Math.PI) / 180;
  const [cos, sin] = QUARTER_TURNS.get(turn) ?? [
    Math.cos(angle),
    Math.sin(angle),
  ];
  const horizontal = flipX ? -1 : 1;
  const vertical = flipY ? -1 : 1;
  return [cos * horizontal, sin * horizontal, -sin * vertical, cos * vertical];
}

// A width x height box at (x, y) turned by `linear` about its center: the
// canonical nodeTransform and Penpot's selrect + :transform alike.
function boxMatrix(x, y, width, height, linear) {
  if (translationOnly(linear)) return [1, 0, 0, 1, x, y];
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  return multiplyMatrix(
    [1, 0, 0, 1, x + halfWidth, y + halfHeight],
    multiplyMatrix([...linear, 0, 0], [1, 0, 0, 1, -halfWidth, -halfHeight]),
  );
}

function canonicalNodeMatrix(node) {
  return boxMatrix(
    node.x ?? 0,
    node.y ?? 0,
    node.width ?? 0,
    node.height ?? 0,
    rotationLinear(node.rotation ?? 0, node.flipX === true, node.flipY === true),
  );
}

function placementFromMatrix(matrix, width, height, rotation, flipX, flipY) {
  let { 4: x, 5: y } = matrix;
  if (!translationOnly(matrix)) {
    const center = matrixPoint(matrix, width / 2, height / 2);
    x = center.x - width / 2;
    y = center.y - height / 2;
  }
  return {
    flipX,
    flipY,
    height,
    linear: matrix.slice(0, 4),
    matrix,
    rotation: ((rotation % 360) + 360) % 360,
    width,
    x,
    y,
  };
}

// Compose a canonical node into its parent's absolute placement. A mirrored
// parent turns its children the other way: diag(-1, 1)·R(t) = R(-t)·diag(-1, 1).
function childPlacement(parent, node) {
  const rotation = node.rotation ?? 0;
  return placementFromMatrix(
    multiplyMatrix(parent.matrix, canonicalNodeMatrix(node)),
    node.width ?? 0,
    node.height ?? 0,
    parent.flipX !== parent.flipY
      ? parent.rotation - rotation
      : parent.rotation + rotation,
    parent.flipX !== (node.flipX === true),
    parent.flipY !== (node.flipY === true),
  );
}

function canonicalParentIndex(nodes) {
  const parents = new Map();
  for (const node of Object.values(nodes ?? {})) {
    for (const childId of node.children ?? []) parents.set(childId, node.id);
  }
  return parents;
}

// The absolute placement of a canonical node: its ancestors' transforms
// composed from the root down.
function canonicalTreePlacement(nodes, nodeId, origin = ROOT_PLACEMENT) {
  if (!nodes?.[nodeId]) return null;
  const parents = canonicalParentIndex(nodes);
  const chain = [];
  const visited = new Set();
  for (
    let currentId = nodeId;
    currentId !== undefined;
    currentId = parents.get(currentId)
  ) {
    if (visited.has(currentId)) {
      fail(
        "node_cycle",
        `Canonical node hierarchy contains a cycle: ${currentId}`,
      );
    }
    visited.add(currentId);
    const node = nodes[currentId];
    if (!node) return null;
    chain.unshift(node);
  }
  return chain.reduce(childPlacement, origin);
}

function canonicalAbsolutePlacement(snapshot, page, nodeId) {
  return canonicalTreePlacement(presentationNodes(snapshot, page), nodeId);
}

function finiteRect(value) {
  return isRecord(value) &&
    ["x", "y", "width", "height"].every((key) => Number.isFinite(value[key]))
    ? value
    : undefined;
}

function penpotLinear(transform) {
  if (!isRecord(transform)) return undefined;
  const linear = ["a", "b", "c", "d"].map((key) => transform[key]);
  if (linear.some((value) => !Number.isFinite(value))) return undefined;
  const determinant = linear[0] * linear[3] - linear[1] * linear[2];
  return Math.abs(determinant) < 1e-9 ? undefined : linear;
}

function isPenpotPath(type) {
  return ["path", "bool"].includes(normalizeType(type));
}

// Penpot's absolute placement once `values` (a whole Penpot object, or the
// merged set operations of a commit) override `baseline`. Penpot moves a path
// by rewriting :content and :selrect only, so a path's box is its selrect.
// The matrix comes from :transform when it is a real matrix; Penpot's
// :rotation and flips are display values that drift from it after mirrored
// rotations, so they only rebuild the matrix when no :transform is sent.
function penpotPlacement(values, baseline, path = false) {
  const selrect = path ? finiteRect(values.selrect) : undefined;
  const box = (key) =>
    selrect?.[key] ??
    (Number.isFinite(values[key]) ? values[key] : baseline[key]);
  const flip = (key, fallback) =>
    values[key] === undefined ? fallback : values[key] === true;
  const flipX = flip("flip-x", baseline.flipX);
  const flipY = flip("flip-y", baseline.flipY);
  const rotation =
    values.rotation === undefined
      ? baseline.rotation
      : Number.isFinite(values.rotation)
        ? values.rotation
        : 0;
  const turned =
    values.rotation !== undefined ||
    values["flip-x"] !== undefined ||
    values["flip-y"] !== undefined;
  const linear =
    penpotLinear(values.transform) ??
    (turned ? rotationLinear(rotation, flipX, flipY) : baseline.linear);
  const placement = {
    flipX,
    flipY,
    height: box("height"),
    linear,
    rotation: ((rotation % 360) + 360) % 360,
    width: box("width"),
    x: box("x"),
    y: box("y"),
  };
  placement.matrix = boxMatrix(
    placement.x,
    placement.y,
    placement.width,
    placement.height,
    linear,
  );
  return placement;
}

// Express an absolute placement in its parent's frame: the canonical x/y,
// rotation and flips that compose back to it. A mirror is either flip plus
// some turn, so `preferred` flip pairs win when they fit the determinant.
function relativePlacement(parent, placement, preferred = []) {
  const local = multiplyMatrix(invertMatrix(parent.matrix), placement.matrix);
  const { height, width } = placement;
  let { 4: x, 5: y } = local;
  if (!translationOnly(local)) {
    const center = matrixPoint(local, width / 2, height / 2);
    x = center.x - width / 2;
    y = center.y - height / 2;
  }
  const mirrored = local[0] * local[3] - local[1] * local[2] < 0;
  const flips = [...preferred, { flipX: mirrored, flipY: false }].find(
    (candidate) => (candidate.flipX !== candidate.flipY) === mirrored,
  );
  // linear = R(t)·diag(sx, sy), so the first column of R(t) is sx·(a, b).
  const horizontal = flips.flipX ? -1 : 1;
  return {
    flipX: flips.flipX,
    flipY: flips.flipY,
    rotation: normalizedRotation(
      (Math.atan2(local[1] * horizontal, local[0] * horizontal) * 180) /
        Math.PI,
    ),
    x: canonicalNumber(x),
    y: canonicalNumber(y),
  };
}

// The flips Penpot itself reports, re-expressed against the parent.
function penpotRelativeFlips(parent, placement) {
  return {
    flipX: placement.flipX !== parent.flipX,
    flipY: placement.flipY !== parent.flipY,
  };
}

// The matrix that maps a node's local geometry (canonical pathData) to the
// page once `relative` is stored on it.
function relativeNodeMatrix(parent, relative, width, height) {
  return multiplyMatrix(
    parent.matrix,
    canonicalNodeMatrix({ ...relative, height, width }),
  );
}

function penpotGeometryContext(changes) {
  const added = new Map();
  const parents = new Map();
  const values = new Map();
  for (const change of changes) {
    const type = normalizeType(change?.type);
    if (type === "add-obj" && isRecord(change.obj)) {
      const runtimeId = String(change.id ?? change.obj.id);
      parents.set(
        runtimeId,
        String(
          change["parent-id"] ??
            change.parentId ??
            change.obj["parent-id"] ??
            "00000000-0000-0000-0000-000000000000",
        ),
      );
      added.set(runtimeId, change.obj);
    } else if (type === "mod-obj" && Array.isArray(change.operations)) {
      const runtimeId = String(change.id);
      const provided = values.get(runtimeId) ?? {};
      for (const operation of change.operations) {
        const attr = normalizeType(operation?.attr);
        if (
          normalizeType(operation?.type) === "set" &&
          PLACEMENT_ATTRIBUTES.has(attr)
        ) {
          provided[attr] = operation.val;
        }
      }
      if (Object.keys(provided).length > 0) values.set(runtimeId, provided);
    } else if (type === "mov-objects" && Array.isArray(change.shapes)) {
      const parentRuntimeId = String(
        change["parent-id"] ?? change.parentId,
      );
      for (const runtimeId of change.shapes) {
        parents.set(String(runtimeId), parentRuntimeId);
      }
    }
  }
  // Where a commit does not move a layer's parent, the parent's current
  // geometry the frontend sends along still places it (Components page).
  for (const change of changes) {
    const parent = change?.["smallpen-parent"];
    if (isRecord(parent?.geometry) && !values.has(String(parent.id))) {
      values.set(String(parent.id), parent.geometry);
    }
  }
  return { added, parents, values };
}

function runtimeParentId(snapshot, page, runtimeId, geometry) {
  const overridden = geometry.parents.get(String(runtimeId));
  if (overridden !== undefined) return overridden;
  const descriptor = nodeDescriptor(snapshot, runtimeId, page, true);
  const nodes = presentationNodes(snapshot, page);
  const parentId = canonicalParentId(nodes, descriptor.nodeId);
  if (parentId === null) return "00000000-0000-0000-0000-000000000000";
  return snapshot.runtime.nodes?.[page.screenId]?.[page.presentationId]?.[
    parentId
  ];
}

// The placement Penpot holds for a shape once the commit applies: the
// canonical composition, overridden by whatever geometry the commit sends.
function runtimeAbsolutePlacement(snapshot, page, runtimeId, geometry) {
  if (
    runtimeId === undefined ||
    runtimeId === null ||
    String(runtimeId) === "00000000-0000-0000-0000-000000000000"
  ) {
    return ROOT_PLACEMENT;
  }
  const added = geometry.added.get(String(runtimeId));
  if (added) {
    // A later mod-obj in the same commit moves the new shape again.
    const path = isPenpotPath(added.type);
    const created = penpotPlacement(added, ROOT_PLACEMENT, path);
    const provided = geometry.values.get(String(runtimeId));
    return provided ? penpotPlacement(provided, created, path) : created;
  }
  const descriptor = nodeDescriptor(snapshot, runtimeId, page, true);
  const node = presentationNodes(snapshot, page)?.[descriptor.nodeId];
  const baseline =
    canonicalAbsolutePlacement(snapshot, page, descriptor.nodeId) ??
    ROOT_PLACEMENT;
  const provided = geometry.values.get(String(runtimeId));
  return provided
    ? penpotPlacement(provided, baseline, node?.type === "PATH")
    : baseline;
}

function parentAbsolutePlacement(snapshot, page, runtimeId, geometry) {
  return runtimeAbsolutePlacement(
    snapshot,
    page,
    runtimeParentId(snapshot, page, runtimeId, geometry),
    geometry,
  );
}

function canonicalNodeType(value) {
  switch (normalizeType(value)) {
    case "frame":
      return "FRAME";
    case "ellipse":
      return "ELLIPSE";
    case "group":
      return "GROUP";
    case "image":
      return "IMAGE";
    case "rect":
      return "RECTANGLE";
    case "path":
    case "line":
      return "PATH";
    case "text":
      return "TEXT";
    default:
      fail(
        "unsupported_penpot_node_type",
        `Penpot node type is not supported: ${String(value)}`,
      );
  }
}

function componentDescriptor(snapshot, runtimeId) {
  const descriptor = snapshot.runtime.reverseComponents?.[String(runtimeId)];
  if (!descriptor) {
    fail(
      "unknown_runtime_component",
      `Penpot component is not mapped to SmallPen: ${String(runtimeId)}`,
    );
  }
  return descriptor;
}

function referencedComponentDescriptor(snapshot, runtimeId, refFile) {
  const owner = referencedLibrary(snapshot, refFile ?? snapshot.runtime.file);
  const descriptor =
    owner.runtime.reverseComponents?.[String(runtimeId)] ??
    owner.runtime.reverseVariants?.[String(runtimeId)];
  if (!descriptor) {
    fail(
      "unknown_runtime_component",
      `Penpot component is not mapped to SmallPen: ${String(runtimeId)}`,
      { fileId: String(owner.runtime.file) },
    );
  }
  return { descriptor, owner };
}

function referencedSourceNodeDescriptor(snapshot, runtimeId) {
  for (const owner of [snapshot, ...(snapshot.libraries ?? [])]) {
    const descriptor =
      owner.runtime.reverseNodes?.[String(runtimeId)] ??
      owner.runtime.reverseComponentNodes?.[String(runtimeId)];
    if (descriptor) return { descriptor, owner };
  }
  fail(
    "unknown_runtime_node",
    `Penpot source node is not mapped to SmallPen: ${String(runtimeId)}`,
  );
}

function compileTouched(value) {
  if (value === undefined || value === null) return undefined;
  const items = value instanceof Set ? [...value] : value;
  if (!Array.isArray(items)) {
    fail("invalid_component_touched", "Penpot touched must be an array or set");
  }
  const groups = items.map(normalizeType);
  if (
    new Set(groups).size !== groups.length ||
    groups.some((group) => !COMPONENT_TOUCHED_GROUPS.has(group))
  ) {
    fail(
      "unsupported_component_touched_group",
      "Penpot touched contains an unsupported or duplicate group",
    );
  }
  return groups;
}

function compileAppliedTokens(value) {
  if (!isRecord(value)) {
    fail("invalid_applied_tokens", "Penpot applied-tokens must be an object");
  }
  const applied = {};
  let entries = Object.entries(value);
  // A stroke width Token applies to every side at once; one Token on all
  // four sides is the stroke-width binding.
  const sides = entries.filter(([attribute]) =>
    PENPOT_STROKE_SIDE_FIELDS.includes(attribute),
  );
  const sideTokens = new Set(sides.map(([, tokenName]) => tokenName));
  if (
    sides.length === PENPOT_STROKE_SIDE_FIELDS.length &&
    sideTokens.size === 1 &&
    [undefined, ...sideTokens].includes(value["stroke-width"])
  ) {
    entries = entries.filter(
      ([attribute]) => !PENPOT_STROKE_SIDE_FIELDS.includes(attribute),
    );
    if (value["stroke-width"] === undefined) {
      entries.push(["stroke-width", [...sideTokens][0]]);
    }
  }
  for (const [rawAttribute, tokenName] of entries) {
    const attribute = normalizeType(rawAttribute);
    if (!APPLIED_TOKEN_ATTRIBUTES.has(attribute)) {
      fail(
        "unsupported_applied_token_attribute",
        `Penpot applied Token attribute is unsupported: ${attribute}`,
      );
    }
    if (typeof tokenName !== "string" || !TOKEN_NAME_PATTERN.test(tokenName)) {
      fail(
        "invalid_token_name",
        `Penpot applied Token name is invalid: ${tokenName}`,
      );
    }
    applied[attribute] = tokenName;
  }
  return applied;
}

// Applied Token attributes that are canonical Token bindings. The Web
// projection shows local bindings as applied Tokens
// (projection.cljs binding-applied-tokens),
// so applying one binds the field and removing it clears the binding.
// Every Token the App applies becomes a Canonical binding (core
// token-attributes.mjs); gaps and corners are grouped below.
const APPLIED_TOKEN_BINDINGS = new Map(PENPOT_TOKEN_BINDINGS);

// The Tokens the Web token library holds: the Form A sets (the active ones
// first, so a name shared by Light and Dark finds the applied one), then the
// DTCG token files.
function webLibraryTokens(snapshot) {
  const library = currentTokenLibrary(snapshot);
  const activeSetIds = new Set(
    library.activeThemeIds.length > 0
      ? library.themes
          .filter(({ id }) => library.activeThemeIds.includes(id))
          .flatMap(({ setIds }) => setIds)
      : library.activeSetIds,
  );
  const sets = [
    ...library.sets.filter(({ id }) => activeSetIds.has(id)),
    ...library.sets.filter(({ id }) => !activeSetIds.has(id)),
  ];
  const formA = new Set(sets.flatMap(({ tokens }) => tokens.map(({ id }) => id)));
  return [
    ...sets.flatMap(({ tokens }) => tokens.map(({ id, name }) => ({ id, name }))),
    ...[...(snapshot.domain?.tokens?.values() ?? [])]
      .filter(({ id }) => !formA.has(id))
      .map(({ id, path }) => ({ id, name: path })),
  ];
}

// Text and visibility bound to a string or boolean Token follow that Token.
// A person who edits them in the App sets their own value: the binding goes,
// as Penpot drops an applied Token when its attribute is edited by hand.
function detachEditedValueBindings(operation, node) {
  for (const field of ["text", "visible"]) {
    if (!Object.hasOwn(operation.changes, field) || !node?.tokenBindings?.[field]) continue;
    if (sameJsonValue(operation.changes[field], node[field])) continue;
    const base =
      operation.changes.tokenBindings === undefined
        ? node.tokenBindings
        : (operation.changes.tokenBindings ?? {});
    const bindings = structuredClone(base);
    delete bindings[field];
    operation.changes.tokenBindings =
      Object.keys(bindings).length > 0 || node.instance ? bindings : null;
  }
}

function compileAppliedTokenBindings(operation, applied, node, snapshot) {
  const packageId = snapshot.manifest.packageId;
  const current = node.tokenBindings ?? {};
  const bindings = structuredClone(current);
  let tokens;
  const libraryTokens = () => (tokens ??= webLibraryTokens(snapshot));
  const localToken = (reference) =>
    reference?.packageId === packageId
      ? libraryTokens().find(({ id }) => id === reference.assetId)
      : undefined;
  const tokenReference = (name, attribute) => {
    const token = libraryTokens().find((token) => token.name === name);
    if (!token) {
      fail("missing_applied_token", `Applied Token does not exist: ${name}`, {
        attribute,
        nodeId: node.id,
        tokenName: name,
      });
    }
    return { assetId: token.id, packageId };
  };
  // itemSpacing shows as two independently editable Penpot attributes.
  // Split it only when an axis changes; a repeated application stays a no-op.
  const gapBindings = {
    rowGap: current.rowGap ?? current.itemSpacing,
    columnGap: current.columnGap ?? current.itemSpacing,
  };
  const nextGapBindings = { ...gapBindings };
  let detachedGap = false;
  for (const [attribute, field] of [
    ["row-gap", "rowGap"],
    ["column-gap", "columnGap"],
  ]) {
    const name = applied[attribute];
    delete applied[attribute];
    const shown = localToken(gapBindings[field]);
    if (name === undefined) {
      if (shown) {
        delete nextGapBindings[field];
        detachedGap = true;
      }
    } else if (shown?.name !== name) {
      nextGapBindings[field] = tokenReference(name, attribute);
    }
  }
  if (!sameJsonValue(gapBindings, nextGapBindings)) {
    for (const field of ["itemSpacing", "rowGap", "columnGap"]) {
      delete bindings[field];
    }
    const { rowGap, columnGap } = nextGapBindings;
    if (rowGap && columnGap && sameJsonValue(rowGap, columnGap)) {
      bindings.itemSpacing = rowGap;
    } else {
      if (rowGap) bindings.rowGap = rowGap;
      if (columnGap) bindings.columnGap = columnGap;
    }
    // A detach keeps the number the editor showed, even when the stored
    // fallback predates the Token. A manual edit later in the commit wins.
    if (detachedGap) {
      operation.changes["layout-gap"] ??= structuredClone(node["layout-gap"]);
    }
  }
  // The four corners show as r1..r4; one Token on all four is cornerRadius.
  const cornerShown = Object.fromEntries(
    CORNER_BINDINGS.map(([attribute, field]) => [attribute, localToken(current[field] ?? current.cornerRadius)?.name]),
  );
  const cornerNext = Object.fromEntries(CORNER_BINDINGS.map(([attribute]) => [attribute, applied[attribute]]));
  for (const [attribute] of CORNER_BINDINGS) delete applied[attribute];
  if (!sameJsonValue(cornerShown, cornerNext)) {
    for (const field of ["cornerRadius", ...CORNER_BINDINGS.map(([, field]) => field)]) delete bindings[field];
    const names = CORNER_BINDINGS.map(([attribute]) => cornerNext[attribute]);
    if (names[0] !== undefined && names.every((name) => name === names[0])) {
      bindings.cornerRadius = tokenReference(names[0], "r1");
    } else {
      CORNER_BINDINGS.forEach(([attribute, field]) => {
        if (cornerNext[attribute] !== undefined) bindings[field] = tokenReference(cornerNext[attribute], attribute);
      });
    }
    // A detach keeps the radius the editor showed.
    if (names.some((name, index) => name === undefined && Object.values(cornerShown)[index] !== undefined))
      operation.changes.cornerRadius ??= structuredClone(node.cornerRadius);
  }
  for (const [attribute, fields] of APPLIED_TOKEN_BINDINGS) {
    const tokenName = applied[attribute];
    delete applied[attribute];
    const shown = fields.filter(
      (field) =>
        bindings[field]?.packageId === packageId &&
        libraryTokens().some(({ id }) => id === bindings[field].assetId),
    );
    const shownName = (field) =>
      libraryTokens().find(({ id }) => id === bindings[field].assetId).name;
    if (tokenName !== undefined && shown.some((field) => shownName(field) === tokenName)) {
      continue;
    }
    for (const field of shown) delete bindings[field];
    if (tokenName === undefined) {
      if (shown.length > 0 && attribute.startsWith("p")) {
        operation.changes["layout-padding"] ??= structuredClone(
          node["layout-padding"],
        );
      } else if (shown.length > 0 && node.instance) {
        const field = attribute === "stroke-color" ? "strokes" : "shadow";
        operation.changes[field] ??= structuredClone(node[field]);
      }
      continue;
    }
    bindings[fields[0]] = tokenReference(tokenName, attribute);
  }
  if (!sameJsonValue(bindings, current)) {
    operation.changes.tokenBindings =
      Object.keys(bindings).length > 0 || node.instance ? bindings : null;
  }
}

// Supported attributes canonicalAddedNode does not place itself.
const PENPOT_ADDED_ATTRIBUTES = PENPOT_WRITE.attributes.filter(
  (attr) =>
    ![
      "applied-tokens",
      "content",
      "fills",
      "flip-x",
      "flip-y",
      "grow-type",
      "height",
      "hidden",
      "interactions",
      "metadata",
      "name",
      "opacity",
      "pathData",
      "r1",
      "r2",
      "r3",
      "r4",
      "rotation",
      "strokes",
      "touched",
      "width",
      "x",
      "y",
    ].includes(attr),
);

function canonicalAddedNode(
  snapshot,
  value,
  page,
  runtimeId = value?.id,
  parentPlacement = ROOT_PLACEMENT,
  movedChildIds = null,
) {
  if (!isRecord(value)) {
    fail("invalid_penpot_node", "Penpot node must contain an object");
  }
  if (String(value.id) !== String(runtimeId)) {
    fail("penpot_node_id_mismatch", "Penpot node key and id differ");
  }
  const descriptor = nodeDescriptor(snapshot, runtimeId, page, true);
  const baseType = canonicalNodeType(value.type);
  const componentRuntimeId = value["component-id"];
  const shapeRef = value["shape-ref"];
  const mainInstance = value["main-instance"] === true;
  const instanceRoot = value["component-root"] === true;
  const type = mainInstance
    ? "COMPONENT"
    : instanceRoot && shapeRef !== undefined && shapeRef !== null
      ? "INSTANCE"
      : baseType;
  if (
    value.rotation !== undefined &&
    value.rotation !== null &&
    (typeof value.rotation !== "number" || !Number.isFinite(value.rotation))
  ) {
    fail("invalid_node_rotation", "Penpot rotation must be finite");
  }
  const path = type === "PATH";
  if (!(path && finiteRect(value.selrect))) {
    for (const axis of ["x", "y"]) {
      if (!Number.isFinite(value[axis])) {
        fail("invalid_node_number", `Penpot ${axis} must be a finite number`, {
          attr: axis,
          value: value[axis],
        });
      }
    }
  }
  const placement = penpotPlacement(value, ROOT_PLACEMENT, path);
  const relative = relativePlacement(parentPlacement, placement, [
    penpotRelativeFlips(parentPlacement, placement),
  ]);
  const node = {
    // Children a same-commit mov-objects re-parents must not ride on the
    // parent node: the move attaches them, and keeping the reference would
    // give them two parents in the Package.
    children: (value.shapes ?? [])
      .filter((childRuntimeId) => {
        return !(movedChildIds && movedChildIds.has(String(childRuntimeId)));
      })
      .map((childRuntimeId) => {
        return nodeDescriptor(snapshot, childRuntimeId, page, true).nodeId;
      }),
    height: path && finiteRect(value.selrect) ? placement.height : value.height,
    id: descriptor.nodeId,
    name: value.name,
    type,
    width: path && finiteRect(value.selrect) ? placement.width : value.width,
    x: relative.x,
    y: relative.y,
  };
  if (value["applied-tokens"] !== undefined && value["applied-tokens"] !== null) {
    const applied = compileAppliedTokens(value["applied-tokens"]);
    const bound = { changes: {} };
    compileAppliedTokenBindings(bound, applied, node, snapshot);
    node.appliedTokens = applied;
    if (bound.changes.tokenBindings) {
      node.tokenBindings = bound.changes.tokenBindings;
    }
  }
  if (value.interactions !== undefined && value.interactions !== null) {
    if (
      !Array.isArray(value.interactions) ||
      value.interactions.some((interaction) => !isRecord(interaction))
    ) {
      fail(
        "invalid_penpot_interactions",
        "Penpot interactions must be an array of objects",
      );
    }
    node.interactions = structuredClone(value.interactions);
  }
  if (componentRuntimeId !== undefined && componentRuntimeId !== null) {
    const { descriptor: component, owner } = referencedComponentDescriptor(
      snapshot,
      componentRuntimeId,
      value["component-file"],
    );
    node.componentId =
      owner === snapshot
        ? component.componentId
        : {
            assetId: component.componentId,
            packageId: owner.manifest.packageId,
          };
    if (component.variantId !== undefined) {
      node.componentVariantId = component.variantId;
    }
  }
  if (shapeRef !== undefined && shapeRef !== null) {
    node.sourceNodeId = referencedSourceNodeDescriptor(
      snapshot,
      shapeRef,
    ).descriptor.nodeId;
  }
  const touched = compileTouched(value.touched);
  if (touched !== undefined) node.touched = touched;
  if (type === "TEXT") {
    if (Array.isArray(value.fills) && value.fills.length > 0) {
      fail(
        "unsupported_penpot_text_shape_fills",
        "Penpot text color must be stored in its content spans",
      );
    }
    const content = compilePlainTextContent(value.content, {
      allowMissing: true,
      snapshot,
    });
    node.text = content.text;
    if (content.textBlocks !== undefined) {
      node.textBlocks = content.textBlocks;
    }
    if (Object.keys(content.textStyle).length > 0) {
      node.textStyle = content.textStyle;
    }
    if (!sameFills(content.fills, DEFAULT_TEXT_FILLS)) {
      node.fills = content.fills;
    }
    const growType = normalizeType(value["grow-type"] ?? "fixed");
    if (!new Set(["auto-height", "auto-width", "fixed"]).has(growType)) {
      fail(
        "invalid_text_grow_type",
        `Unsupported Penpot grow-type: ${String(growType)}`,
      );
    }
    if (growType !== "fixed") node.growType = growType;
  } else if (type === "IMAGE") {
    node.mediaRef = compileMediaReference(snapshot, value.metadata);
    if (Array.isArray(value.fills))
      node.fills = compileFills(value.fills, snapshot);
  } else if (Array.isArray(value.fills)) {
    node.fills = compileFills(value.fills, snapshot);
  }
  if (
    [value.r1, value.r2, value.r3, value.r4].some((item) => item !== undefined)
  ) {
    node.cornerRadius = [
      value.r1 ?? 0,
      value.r2 ?? 0,
      value.r3 ?? 0,
      value.r4 ?? 0,
    ];
  }
  if (value.opacity !== undefined && value.opacity !== null) {
    node.opacity = value.opacity;
  }
  // An undo restoring a deleted shape, a duplicate or a paste sends the whole
  // Penpot object: keep every other supported attribute it carries. Penpot
  // defaults stay implicit, as for a shape drawn from scratch.
  const carried = { changes: {} };
  for (const attr of PENPOT_ADDED_ATTRIBUTES) {
    const attrValue = value[attr];
    if (
      attrValue === undefined ||
      attrValue === null ||
      attrValue === false ||
      normalizeType(attrValue) === "normal" ||
      (Array.isArray(attrValue) && attrValue.length === 0)
    ) {
      continue;
    }
    compileAttribute(carried, attr, attrValue, node, snapshot);
  }
  for (const [field, fieldValue] of Object.entries(carried.changes)) {
    if (fieldValue !== null) node[field] = fieldValue;
  }
  if (relative.rotation !== 0) node.rotation = relative.rotation;
  if (relative.flipX) node.flipX = true;
  if (relative.flipY) node.flipY = true;
  if (Array.isArray(value.strokes) && value.strokes.length > 0) {
    node.strokes = compileStrokes(value.strokes, snapshot);
  }
  if (value.hidden !== undefined) node.visible = !value.hidden;
  if (type === "PATH") {
    // Penpot :points are the transformed box corners, derived from the box
    // and the transform; the canonical node keeps only its own geometry.
    if (value["path-data"] !== undefined) {
      node.pathData = structuredClone(value["path-data"]);
    }
    if (value["content"] !== undefined) {
      node.pathData = compilePathContent(
        value["content"],
        invertMatrix(
          relativeNodeMatrix(
            parentPlacement,
            relative,
            node.width,
            node.height,
          ),
        ),
      );
    }
  }
  return node;
}

function compileAddedNode(snapshot, change, geometry, movedChildIds, domain) {
  const page = pageDescriptor(snapshot, change);
  const value = change.obj;
  if (!isRecord(value)) {
    fail("invalid_penpot_node", "Penpot add-obj must contain obj");
  }
  const runtimeId = change.id ?? value.id;
  const parent = parentDescriptor(
    snapshot,
    change["parent-id"] ?? change.parentId ?? value["parent-id"],
    page,
  );
  const parentPlacement = parentAbsolutePlacement(
    snapshot,
    page,
    runtimeId,
    geometry,
  );
  const root = domain?.roots.get(String(runtimeId));
  const node = root
    ? canonicalDomainInstance(
        snapshot,
        change,
        page,
        root,
        parentPlacement,
        domain,
      )
    : canonicalAddedNode(
        snapshot,
        value,
        page,
        runtimeId,
        parentPlacement,
        movedChildIds,
      );
  if (parent.nodeId === null) {
    // A top-level shape is stored where its board's layout shift puts it back.
    const { dx, dy } = boardOffset(snapshot, page);
    if (dx || dy) Object.assign(node, { x: (node.x ?? 0) - dx, y: (node.y ?? 0) - dy });
  }
  return {
    index: change.index,
    node: requireCanonicalNodeFields(node),
    parentId: parent.nodeId,
    presentationId: page.presentationId,
    screenId: page.screenId,
    type: "add-presentation-node",
  };
}

// The fields a canonical node may hold. Penpot attributes are compiled to
// these names; a raw Penpot attribute reaching a node is a compiler bug.
const CANONICAL_NODE_FIELDS = new Set([
  ...SMALLPEN_FORMAT_CAPABILITIES.canonicalWrite.nodeFields,
  "children",
  "componentId",
  "componentVariantId",
  "id",
  "instance",
  "sourceNodeId",
  "type",
]);

function requireCanonicalNodeFields(node) {
  const fields = Object.keys(node).filter(
    (field) => !CANONICAL_NODE_FIELDS.has(field),
  );
  if (fields.length > 0) {
    fail(
      "non_canonical_node_field",
      "Penpot node compiled to fields the Package does not define",
      { fields, nodeId: node.id },
    );
  }
  return node;
}

// Penpot attributes of a domain Instance root that override its source, and
// the root field each one is stored as.
const DOMAIN_ROOT_OVERRIDE_FIELDS = new Map([
  ["fills", "fills"],
  ["hidden", "visible"],
  ["name", "name"],
  ["opacity", "opacity"],
]);

// What a new domain Instance root keeps from a mod-obj in the commit that
// creates it: placement, render bookkeeping, and the fields an Instance node
// holds over its source. Penpot's relocation defaults (constraints,
// hide-in-viewer on a board moved into a board) are not edits of the copy.
const DOMAIN_INSTANCE_ROOT_ATTRIBUTES = new Set([
  ...PLACEMENT_ATTRIBUTES,
  ...PENPOT_DERIVED_ATTRIBUTES,
  "fills",
  "hidden",
  "interactions",
  "name",
  "opacity",
]);

// The canonical Component Set variant a Penpot copy root instantiates, or
// null when the copy is not one (a located component, a plain shape).
function domainInstanceSource(snapshot, value) {
  if (
    value["component-root"] !== true ||
    value["main-instance"] === true ||
    value["component-id"] === undefined ||
    value["component-id"] === null ||
    value["shape-ref"] === undefined ||
    value["shape-ref"] === null
  ) {
    return null;
  }
  const { descriptor, owner } = referencedComponentDescriptor(
    snapshot,
    value["component-id"],
    value["component-file"],
  );
  if (descriptor.variantId === undefined) return null;
  for (const entry of owner.manifest.entries.components) {
    const sets = owner.entries[entry]?.componentSets;
    const set = Array.isArray(sets)
      ? sets.find(({ id }) => id === descriptor.componentId)
      : undefined;
    const variant = set?.variants?.find(({ id }) => id === descriptor.variantId);
    if (variant) {
      return {
        component: { assetId: set.id, packageId: owner.manifest.packageId },
        owner,
        set,
        variant,
      };
    }
  }
  return null;
}

// Copies of canonical Component Set variants this commit adds (a variant
// dropped from Assets, an undo restoring a deleted Instance). Each copy root
// becomes a domain `instance` node; the copy's children are that node's
// projection, so they are tracked here and never written as nodes. An undo
// restores the root under its old runtime id: the node id its plugin data
// names is reused when that id is still free, so the restored Instance gets
// its own id back.
function domainInstanceAdds(snapshot, changes) {
  const roots = new Map();
  const children = new Map();
  const nodeIds = new Map();
  const generatedPages = new Set(
    [snapshot.runtime?.componentsPage, snapshot.runtime?.designSystemPage]
      .filter((pageId) => pageId !== undefined)
      .map(String),
  );
  for (const change of changes) {
    if (normalizeType(change?.type) !== "add-obj" || !isRecord(change.obj)) {
      continue;
    }
    const value = change.obj;
    const runtimeId = String(change.id ?? value.id);
    const parentId = String(
      change["parent-id"] ?? change.parentId ?? value["parent-id"],
    );
    const rootId = roots.has(parentId)
      ? parentId
      : children.get(parentId)?.rootId;
    if (rootId !== undefined) {
      if (value["shape-ref"] === undefined || value["shape-ref"] === null) {
        fail(
          "component_instance_override_unsupported",
          "Edit the Component source before adding shapes to an Instance",
          { instanceNodeId: roots.get(rootId).nodeId },
        );
      }
      children.set(runtimeId, { rootId, value });
      continue;
    }
    const pageId = String(change.pageId ?? change["page-id"] ?? "");
    const page = snapshot.runtime?.reversePages?.[pageId];
    if (
      !page ||
      generatedPages.has(pageId) ||
      snapshot.runtime.reverseNodes?.[runtimeId] !== undefined
    ) {
      continue;
    }
    const source = domainInstanceSource(snapshot, value);
    if (!source) continue;
    const plugin = value["plugin-data"]?.smallpen;
    const pluginNodeId =
      isRecord(plugin) &&
      plugin["screen-id"] === page.screenId &&
      plugin["presentation-id"] === page.presentationId &&
      typeof plugin["node-id"] === "string" &&
      /^node_[a-zA-Z0-9_-]+$/.test(plugin["node-id"]) &&
      !plugin["node-id"].includes("__")
        ? plugin["node-id"]
        : undefined;
    const taken = new Set(nodeIds.values());
    const nodeId =
      pluginNodeId !== undefined &&
      !taken.has(pluginNodeId) &&
      !Object.hasOwn(presentationNodes(snapshot, page) ?? {}, pluginNodeId)
        ? pluginNodeId
        : runtimeNodeId(runtimeId);
    nodeIds.set(runtimeId, nodeId);
    roots.set(runtimeId, { ...source, nodeId, pluginNodeId });
  }
  return { childNodeIds: new Map(), children, nodeIds, roots };
}

// Drops the changes that address the projected children of a new domain
// Instance, and the root attributes DOMAIN_INSTANCE_ROOT_ATTRIBUTES leaves
// out.
function withoutProjectedCopyChanges(changes, domain) {
  if (domain.roots.size === 0) return changes;
  const result = [];
  for (const change of changes) {
    const type = normalizeType(change?.type);
    const runtimeId = String(change?.id);
    if (
      (type === "add-obj" || type === "mod-obj") &&
      domain.children.has(runtimeId)
    ) {
      continue;
    }
    if (type === "mov-objects" && Array.isArray(change.shapes)) {
      const shapes = change.shapes.filter(
        (shape) => !domain.children.has(String(shape)),
      );
      if (shapes.length === change.shapes.length) result.push(change);
      else if (shapes.length > 0) result.push({ ...change, shapes });
      continue;
    }
    if (
      type === "mod-obj" &&
      domain.roots.has(runtimeId) &&
      Array.isArray(change.operations)
    ) {
      const operations = change.operations.filter((item) => {
        if (!isRecord(item)) return true;
        const itemType = normalizeType(item.type);
        if (itemType === "set-touched") return false;
        return (
          itemType !== "set" ||
          DOMAIN_INSTANCE_ROOT_ATTRIBUTES.has(normalizeType(item.attr))
        );
      });
      if (operations.length > 0) result.push({ ...change, operations });
      continue;
    }
    result.push(change);
  }
  return result;
}

// The presentation projected with `node` (a domain Instance without
// overrides) added: what the Instance draws from its source alone.
function domainInstanceProjection(snapshot, page, node) {
  const entry = snapshot.manifest.entries.screens.find(
    (candidate) => snapshot.entries[candidate].id === page.screenId,
  );
  const screen = structuredClone(snapshot.entries[entry]);
  screen.presentations.find(({ id }) => id === page.presentationId).nodes[
    node.id
  ] = structuredClone(node);
  return projectedSnapshotNodes(
    { ...snapshot, entries: { ...snapshot.entries, [entry]: screen } },
    page,
  );
}

// The override path of a copy child: the variant node its shape-ref names
// (projected variant ids included, for nested Instances), else the source
// part of the composed id its plugin data carries.
function domainInstanceSourcePath(root, value) {
  const shapeRef = String(value["shape-ref"]);
  const ids =
    root.owner.runtime.componentNodes?.[root.set.id]?.[root.variant.id] ?? {};
  for (const [nodeId, runtimeId] of Object.entries(ids)) {
    if (String(runtimeId) === shapeRef) return nodeId;
  }
  const pluginNodeId = value["plugin-data"]?.smallpen?.["node-id"];
  if (
    root.pluginNodeId !== undefined &&
    typeof pluginNodeId === "string" &&
    pluginNodeId.startsWith(`${root.pluginNodeId}__`)
  ) {
    return pluginNodeId.slice(root.pluginNodeId.length + 2);
  }
  fail(
    "component_instance_override_unsupported",
    "A copy child does not map to a node of its Component variant",
    { instanceNodeId: root.nodeId },
  );
}

function overrideFieldValue(field, node) {
  if (field === "text" && node.text === undefined && node.textBlocks) {
    return node.textBlocks
      .map((block) => (block.runs ?? []).map((run) => run.text).join(""))
      .join("\n");
  }
  return overrideValue(field, node[field], node);
}

// A Penpot copy root of a canonical Component Set variant as a domain
// Instance node: placement, name, the variant it selects, and what the copy
// holds over its source. The root keeps differing override fields as its own
// fields (as an edit of the root does); children become `instance.overrides`.
// Only INSTANCE_OVERRIDE_FIELDS are compared: the copy's other attributes are
// what the source projects.
function canonicalDomainInstance(
  snapshot,
  change,
  page,
  root,
  parentPlacement,
  domain,
) {
  const runtimeId = String(change.id ?? change.obj.id);
  // A domain Instance keeps no touched groups: its overrides say what the
  // copy changes, and the projection derives the groups from them.
  const located = canonicalAddedNode(
    snapshot,
    { ...change.obj, touched: undefined },
    page,
    runtimeId,
    parentPlacement,
  );
  const node = {
    children: [],
    height: located.height,
    id: located.id,
    instance: {
      component: structuredClone(root.component),
      variant: structuredClone(root.variant.selection),
    },
    name: located.name,
    type: "INSTANCE",
    width: located.width,
    x: located.x,
    y: located.y,
  };
  for (const field of ["flipX", "flipY", "rotation"]) {
    if (located[field] !== undefined) node[field] = located[field];
  }
  if (located.interactions?.length > 0) {
    node.interactions = located.interactions;
  }
  const projected = domainInstanceProjection(snapshot, page, node);
  const differs = (field, base, value) =>
    !(field === "text" && base.type !== "TEXT") &&
    !sameChildField(
      field,
      overrideFieldValue(field, base),
      overrideFieldValue(field, value),
    );
  // The root keeps its own placement, size and bindings.
  for (const field of INSTANCE_OVERRIDE_FIELDS) {
    if (["name", "tokenBindings", "variant", "width", "height"].includes(field)) continue;
    if (differs(field, projected[node.id], located)) {
      node[field] = overrideFieldValue(field, located);
    }
  }
  // Bindings the copy root holds beyond its source's.
  const rootBindings = Object.fromEntries(
    Object.entries(bindingDiff(projected[node.id]?.tokenBindings, located.tokenBindings)).filter(([, reference]) => reference),
  );
  if (Object.keys(rootBindings).length) node.tokenBindings = rootBindings;
  const overrides = {};
  for (const [childRuntimeId, child] of domain.children) {
    if (child.rootId !== runtimeId) continue;
    const sourcePath = domainInstanceSourcePath(root, child.value);
    domain.childNodeIds.set(childRuntimeId, {
      nodeId: `${node.id}__${sourcePath}`,
      presentationId: page.presentationId,
      screenId: page.screenId,
    });
    const base = projected[`${node.id}__${sourcePath}`];
    if (!base) {
      fail(
        "component_instance_override_unsupported",
        "A copy child is not part of its Component variant projection",
        { instanceNodeId: node.id, sourcePath },
      );
    }
    const value = canonicalAddedNode(
      snapshot,
      { ...child.value, touched: undefined },
      page,
      childRuntimeId,
    );
    for (const field of INSTANCE_OVERRIDE_FIELDS) {
      if (field === "variant") continue;
      if (field === "tokenBindings") {
        const diff = bindingDiff(base.tokenBindings, value.tokenBindings);
        if (Object.keys(diff).length) overrides[`${sourcePath}:tokenBindings`] = diff;
        continue;
      }
      if (differs(field, base, value)) {
        overrides[`${sourcePath}:${field}`] = overrideFieldValue(field, value);
      }
    }
  }
  if (Object.keys(overrides).length > 0) node.instance.overrides = overrides;
  return node;
}

function screenDescriptor(snapshot, screenId) {
  const entry = snapshot.manifest.entries.screens.find(
    (candidate) => snapshot.entries[candidate].id === screenId,
  );
  if (!entry) {
    fail(
      "missing_screen",
      `SmallPen Screen does not exist: ${String(screenId)}`,
    );
  }
  return { entry, screen: snapshot.entries[entry] };
}

function defaultScreenDescriptor(snapshot) {
  return screenDescriptor(snapshot, snapshot.manifest.defaultScreenId);
}

function canonicalComponent(snapshot, componentId) {
  const entry = snapshot.manifest.entries.components.find(
    (candidate) => snapshot.entries[candidate].id === componentId,
  );
  if (!entry) {
    fail(
      "missing_component",
      `SmallPen Component does not exist: ${componentId}`,
    );
  }
  return snapshot.entries[entry];
}

function compileAddedComponent(snapshot, change) {
  const componentId = runtimeComponentId(change.id);
  if (snapshot.runtime.reverseComponents?.[String(change.id)]) {
    fail(
      "duplicate_runtime_component",
      `Penpot component already exists: ${change.id}`,
    );
  }
  const page = pageWithBoard(snapshot, pageDescriptorById(snapshot, change["main-instance-page"]), [change["main-instance-id"]]);
  // Penpot's create-component flow adds the main shape in the same commit, so
  // the main-instance id is not yet in the runtime mapping here.
  const main = nodeDescriptor(snapshot, change["main-instance-id"], page, true);
  if (typeof change.name !== "string" || change.name.length === 0) {
    fail("invalid_component_name", "Penpot Component name must be non-empty");
  }
  if (typeof change.path !== "string") {
    fail("invalid_component_path", "Penpot Component path must be a string");
  }
  for (const field of ["annotation", "variant-id", "variant-properties"]) {
    if (change[field] !== undefined && change[field] !== null) {
      fail(
        "unsupported_penpot_component",
        `Penpot Component field is not supported yet: ${field}`,
      );
    }
  }
  return {
    component: {
      id: componentId,
      mainNodeId: main.nodeId,
      name: change.name,
      path: change.path,
      presentationId: page.presentationId,
      screenId: page.screenId,
    },
    type: "add-component",
  };
}

function compileUpdatedComponent(snapshot, change) {
  const descriptor = componentDescriptor(snapshot, change.id);
  const component = canonicalComponent(snapshot, descriptor.componentId);
  if (
    change["main-instance-id"] !== undefined &&
    change["main-instance-id"] !== null &&
    String(change["main-instance-id"]) !==
      String(
        snapshot.runtime.nodes[component.screenId][component.presentationId][
          component.mainNodeId
        ],
      )
  ) {
    fail("unsupported_component_relocation", "Component main node cannot move");
  }
  if (
    change["main-instance-page"] !== undefined &&
    change["main-instance-page"] !== null &&
    String(change["main-instance-page"]) !==
      String(
        snapshot.runtime.pages[component.screenId][component.presentationId],
      )
  ) {
    fail("unsupported_component_relocation", "Component main page cannot move");
  }
  for (const field of [
    "annotation",
    "objects",
    "variant-id",
    "variant-properties",
  ]) {
    if (change[field] !== undefined && change[field] !== null) {
      fail(
        "unsupported_penpot_component",
        `Penpot Component field is not supported yet: ${field}`,
      );
    }
  }
  const changes = {};
  if (change.name !== undefined && change.name !== component.name) {
    if (typeof change.name !== "string" || change.name.length === 0) {
      fail("invalid_component_name", "Penpot Component name must be non-empty");
    }
    changes.name = change.name;
  }
  if (change.path !== undefined && change.path !== component.path) {
    if (typeof change.path !== "string") {
      fail("invalid_component_path", "Penpot Component path must be a string");
    }
    changes.path = change.path;
  }
  if (Object.keys(changes).length === 0) {
    return null;
  }
  return {
    changes,
    componentId: component.id,
    type: "update-component",
  };
}

function compileDeletedComponent(snapshot, change) {
  return {
    componentId: componentDescriptor(snapshot, change.id).componentId,
    type: "delete-component",
  };
}

function validateRegisteredObjects(snapshot, change) {
  if (!Array.isArray(change.shapes)) {
    fail("invalid_penpot_change", "Penpot reg-objects requires shapes");
  }
  if (change["page-id"] !== undefined && change["page-id"] !== null) {
    if (
      snapshot.runtime.componentsPage &&
      String(change["page-id"]) === String(snapshot.runtime.componentsPage)
    ) {
      // Projected variant masters have no canonical screen page. Bounds
      // registration is renderer bookkeeping, not a source-page mutation.
      for (const id of change.shapes) {
        if (
          String(id) !== "00000000-0000-0000-0000-000000000000" &&
          !snapshot.runtime.reverseComponentNodes?.[String(id)]
        ) {
          fail("unknown_runtime_node", `Unknown projected component node: ${id}`);
        }
      }
      return;
    }
    pageDescriptorById(snapshot, change["page-id"]);
    return;
  }
  if (
    change["component-id"] !== undefined &&
    change["component-id"] !== null
  ) {
    componentDescriptor(snapshot, change["component-id"]);
    return;
  }
  fail(
    "invalid_penpot_change",
    "Penpot reg-objects requires a page-id or component-id",
  );
}

const COMPONENT_METADATA_ATTRIBUTES = new Set([
  "component-file",
  "component-id",
  "component-root",
  "main-instance",
  "shape-ref",
  "touched",
]);

function componentMetadataNodes(snapshot, changes) {
  const result = new Map();
  for (const change of changes) {
    if (normalizeType(change?.type) !== "add-component") continue;
    const page = pageWithBoard(snapshot, pageDescriptorById(snapshot, change["main-instance-page"]), [change["main-instance-id"]]);
    const mainInstanceIsNew =
      snapshot.runtime.reverseNodes?.[String(change["main-instance-id"])] ===
      undefined;
    if (mainInstanceIsNew) {
      // Penpot's create-component flow adds the main shape in this same
      // commit: the snapshot has no subtree to walk yet, so map only the main.
      result.set(String(change["main-instance-id"]), {
        componentRuntimeId: String(change.id),
        root: true,
      });
    } else {
      const main = nodeDescriptor(snapshot, change["main-instance-id"], page);
      void main;
    }
    // Shapes whose component metadata is rewritten in the same commit (e.g.
    // the shape a component was created from gets its metadata cleared) need
    // descriptors so the metadata ops strip cleanly.
    for (const candidate of changes) {
      if (
        normalizeType(candidate?.type) !== "mod-obj" ||
        result.has(String(candidate.id)) ||
        !Array.isArray(candidate.operations) ||
        !candidate.operations.some((op) =>
          COMPONENT_METADATA_ATTRIBUTES.has(normalizeType(op?.attr)),
        )
      ) {
        continue;
      }
      const componentIdOp = candidate.operations.find(
        (op) => normalizeType(op?.attr) === "component-id",
      );
      const instanceComponentRuntimeId =
        componentIdOp && componentIdOp.val !== null && componentIdOp.val !== undefined
          ? String(componentIdOp.val)
          : undefined;
      if (
        instanceComponentRuntimeId !== undefined &&
        instanceComponentRuntimeId !== String(change.id)
      ) {
        continue;
      }
      result.set(String(candidate.id), {
        componentRuntimeId: String(change.id),
        root: false,
        instanceComponentRuntimeId,
      });
    }
    if (mainInstanceIsNew) continue;
    const main = nodeDescriptor(snapshot, change["main-instance-id"], page);
    const screenEntry = snapshot.manifest.entries.screens.find(
      (entry) => snapshot.entries[entry].id === page.screenId,
    );
    const presentation = snapshot.entries[screenEntry].presentations.find(
      ({ id }) => id === page.presentationId,
    );
    const visit = (nodeId, root) => {
      const runtimeId =
        snapshot.runtime.nodes[page.screenId][page.presentationId][nodeId];
      result.set(String(runtimeId), {
        componentRuntimeId: root ? String(change.id) : null,
        root,
      });
      for (const childId of presentation.nodes[nodeId].children ?? []) {
        visit(childId, false);
      }
    };
    visit(main.nodeId, true);
  }
  // Undo batches clear the component metadata (component-id: null & friends)
  // without an add-component change in the same commit. Register clearing
  // mod-objs on mapped nodes so the metadata ops strip cleanly; the
  // del-component in the same batch removes the definition itself.
  for (const change of changes) {
    if (normalizeType(change?.type) !== "mod-obj" || result.has(String(change.id))) {
      continue;
    }
    if (!snapshot.runtime.reverseNodes?.[String(change.id)]) continue;
    const ops = Array.isArray(change.operations) ? change.operations : [];
    const metadataOps = ops.filter((op) =>
      COMPONENT_METADATA_ATTRIBUTES.has(normalizeType(op?.attr)),
    );
    if (metadataOps.length === 0) continue;
    const allClear = metadataOps.every((op) => {
      if (normalizeType(op?.type) !== "set") return false;
      const value = op?.val;
      return value === null || value === undefined || value === false;
    });
    if (allClear) result.set(String(change.id), { root: false });
  }
  return result;
}

function withoutComponentMetadata(change, descriptor, snapshot) {
  const operations = [];
  for (const operation of change.operations ?? []) {
    const attr = normalizeType(operation?.attr);
    if (!COMPONENT_METADATA_ATTRIBUTES.has(attr)) {
      operations.push(operation);
      continue;
    }
    if (normalizeType(operation?.type) !== "set") {
      fail("unsupported_penpot_operation", "Component metadata must use set");
    }
    const value = operation.val;
    const valid =
      attr === "component-id"
        ? descriptor.root
          ? String(value) === descriptor.componentRuntimeId
          : value === null ||
            value === undefined ||
            (descriptor.instanceComponentRuntimeId !== undefined &&
              String(value) === descriptor.instanceComponentRuntimeId)
        : attr === "component-file"
          ? descriptor.root
            ? String(value) === String(snapshot.runtime.file)
            : value === null ||
              value === undefined ||
              (descriptor.instanceComponentRuntimeId !== undefined &&
                String(value) === String(snapshot.runtime.file))
          : attr === "component-root" || attr === "main-instance"
            ? descriptor.root
              ? value === true
              : value === null || value === undefined || value === false
            : value === null || value === undefined;
    if (!valid) {
      fail(
        "invalid_component_metadata",
        `Penpot Component metadata is inconsistent: ${attr}`,
        { attr, changeId: change.id },
      );
    }
  }
  return { ...change, operations };
}

function stableIdFromRuntime(runtimeId, prefix, code) {
  const value = String(runtimeId).toLowerCase();
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value,
    )
  ) {
    fail(code, `Penpot runtime ID is not a UUID: ${value}`);
  }
  return `${prefix}${value.replaceAll("-", "")}`;
}

function currentTokenLibrary(snapshot) {
  const entry = snapshot.manifest.entries.tokens.find((candidate) => {
    const value = snapshot.entries[candidate];
    return Array.isArray(value?.sets) && Array.isArray(value?.themes);
  });
  return entry
    ? structuredClone(snapshot.entries[entry])
    : {
        activeSetIds: [],
        activeThemeIds: [],
        id: "tlib_design",
        sets: [],
        themes: [],
      };
}

function tokenCompilerState(snapshot) {
  return {
    library: currentTokenLibrary(snapshot),
    runtimeSets: new Map(
      Object.entries(snapshot.runtime.reverseTokenSets ?? {}).map(
        ([runtimeId, { tokenSetId }]) => [runtimeId, tokenSetId],
      ),
    ),
    runtimeThemes: new Map(
      Object.entries(snapshot.runtime.reverseTokenThemes ?? {}).map(
        ([runtimeId, { tokenThemeId }]) => [runtimeId, tokenThemeId],
      ),
    ),
    runtimeTokens: new Map(
      Object.entries(snapshot.runtime.reverseTokens ?? {}).map(
        ([runtimeId, { tokenId }]) => [runtimeId, tokenId],
      ),
    ),
  };
}

function stableRuntimeReference(map, runtimeId, prefix, code) {
  const key = String(runtimeId);
  let stableId = map.get(key);
  if (!stableId) {
    stableId = stableIdFromRuntime(runtimeId, prefix, code);
    map.set(key, stableId);
  }
  return stableId;
}

function tokenSetById(state, setId) {
  const tokenSet = state.library.sets.find(({ id }) => id === setId);
  if (!tokenSet)
    fail("missing_token_set", `Token Set does not exist: ${setId}`);
  return tokenSet;
}

function tokenSetIdByName(state, name) {
  const tokenSet = state.library.sets.find(
    (candidate) => candidate.name === name,
  );
  if (!tokenSet) fail("missing_token_set", `Token Set does not exist: ${name}`);
  return tokenSet.id;
}

function tokenThemePath(theme) {
  return theme.group ? `${theme.group}/${theme.name}` : `/${theme.name}`;
}

function listValue(value, code, message) {
  const result = value instanceof Set ? [...value] : value;
  if (!Array.isArray(result)) fail(code, message);
  return result;
}

function compileTokenRecord(state, runtimeId, attrs, previous = {}) {
  const id = stableRuntimeReference(
    state.runtimeTokens,
    runtimeId,
    "tok_",
    "invalid_runtime_token",
  );
  if (attrs.id !== undefined && String(attrs.id) !== String(runtimeId)) {
    fail("token_id_mismatch", "Penpot Token attrs id does not match token-id");
  }
  const name = attrs.name ?? previous.name;
  const type = normalizeType(attrs.type ?? previous.type);
  const description = attrs.description ?? previous.description ?? "";
  const value = Object.hasOwn(attrs, "value")
    ? type === "shadow" ? canonicalShadowTokenValue(attrs.value) : attrs.value
    : previous.value;
  if (
    typeof name !== "string" ||
    !TOKEN_NAME_PATTERN.test(name) ||
    typeof type !== "string" ||
    typeof description !== "string" ||
    value === undefined
  ) {
    fail("invalid_token", "Penpot Token attrs are incomplete or invalid");
  }
  return { description, id, name, type, value };
}

// Penpot holds a shadow Token as a list of shadows with kebab-case keys and
// string lengths (projection.cljs penpot-token-value); the Package keeps
// DTCG shadow objects, one object for a single shadow.
function canonicalShadowTokenValue(value) {
  const shadows = Array.isArray(value) ? value : [value];
  if (!shadows.every((shadow) => isRecord(shadow) && Object.hasOwn(shadow, "offset-x"))) {
    return value;
  }
  const length = (raw) => {
    const number = Number(raw);
    return typeof raw === "string" && raw.trim() !== "" && Number.isFinite(number)
      ? number
      : raw;
  };
  const canonical = shadows.map((shadow) => ({
    blur: length(shadow.blur ?? 0),
    color: shadow.color,
    ...(shadow.inset === true ? { inset: true } : {}),
    offsetX: length(shadow["offset-x"]),
    offsetY: length(shadow["offset-y"] ?? 0),
    spread: length(shadow.spread ?? 0),
  }));
  return canonical.length === 1 ? canonical[0] : canonical;
}

function compileTokenSetTokens(state, value, previousTokens = []) {
  if (value === undefined) return structuredClone(previousTokens);
  if (!isRecord(value) && !Array.isArray(value)) {
    fail(
      "invalid_tokens",
      "Penpot Token Set tokens must be an object or array",
    );
  }
  const records = Array.isArray(value) ? value : Object.values(value);
  return records.map((attrs) => {
    if (!isRecord(attrs) || attrs.id === undefined) {
      fail("invalid_token", "Penpot Token Set contains an invalid Token");
    }
    const previous = previousTokens.find(
      (token) =>
        token.id === state.runtimeTokens.get(String(attrs.id)) ||
        token.name === attrs.name,
    );
    return compileTokenRecord(state, attrs.id, attrs, previous);
  });
}

function applySetToken(state, change) {
  const setId = stableRuntimeReference(
    state.runtimeSets,
    change["set-id"],
    "tset_",
    "invalid_runtime_token_set",
  );
  const tokenSet = tokenSetById(state, setId);
  const tokenId = stableRuntimeReference(
    state.runtimeTokens,
    change["token-id"],
    "tok_",
    "invalid_runtime_token",
  );
  const index = tokenSet.tokens.findIndex(({ id }) => id === tokenId);
  if (change.attrs === null || change.attrs === undefined) {
    if (index < 0) fail("missing_token", `Token does not exist: ${tokenId}`);
    tokenSet.tokens.splice(index, 1);
    return;
  }
  if (!isRecord(change.attrs))
    fail("invalid_token", "Penpot Token attrs are invalid");
  const token = compileTokenRecord(
    state,
    change["token-id"],
    change.attrs,
    index < 0 ? {} : tokenSet.tokens[index],
  );
  if (index < 0) tokenSet.tokens.push(token);
  else tokenSet.tokens[index] = token;
}

function applySetTokenSet(state, change) {
  const setId = stableRuntimeReference(
    state.runtimeSets,
    change.id,
    "tset_",
    "invalid_runtime_token_set",
  );
  const index = state.library.sets.findIndex(({ id }) => id === setId);
  if (change.attrs === null || change.attrs === undefined) {
    if (index < 0)
      fail("missing_token_set", `Token Set does not exist: ${setId}`);
    state.library.sets.splice(index, 1);
    state.library.activeSetIds = state.library.activeSetIds.filter(
      (id) => id !== setId,
    );
    for (const theme of state.library.themes) {
      theme.setIds = theme.setIds.filter((id) => id !== setId);
    }
    return;
  }
  if (!isRecord(change.attrs)) {
    fail("invalid_token_set", "Penpot Token Set attrs are invalid");
  }
  if (
    change.attrs.id !== undefined &&
    String(change.attrs.id) !== String(change.id)
  ) {
    fail(
      "token_set_id_mismatch",
      "Penpot Token Set attrs id does not match id",
    );
  }
  const previous = index < 0 ? {} : state.library.sets[index];
  const name = change.attrs.name ?? previous.name;
  const description = change.attrs.description ?? previous.description ?? "";
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    typeof description !== "string"
  ) {
    fail(
      "invalid_token_set",
      "Penpot Token Set attrs are incomplete or invalid",
    );
  }
  const tokenSet = {
    description,
    id: setId,
    name,
    tokens: compileTokenSetTokens(state, change.attrs.tokens, previous.tokens),
  };
  if (index < 0) state.library.sets.push(tokenSet);
  else state.library.sets[index] = tokenSet;
}

function applySetTokenTheme(state, change) {
  const runtimeId = String(change.id);
  if (runtimeId === "00000000-0000-0000-0000-000000000000") {
    if (!isRecord(change.attrs)) {
      fail(
        "invalid_hidden_token_theme",
        "Hidden Token Theme cannot be deleted",
      );
    }
    const names = listValue(
      change.attrs.sets ?? [],
      "invalid_token_theme_sets",
      "Hidden Token Theme sets must be an array",
    );
    state.library.activeSetIds = names.map((name) =>
      tokenSetIdByName(state, name),
    );
    return;
  }
  const themeId = stableRuntimeReference(
    state.runtimeThemes,
    change.id,
    "theme_",
    "invalid_runtime_token_theme",
  );
  const index = state.library.themes.findIndex(({ id }) => id === themeId);
  if (change.attrs === null || change.attrs === undefined) {
    if (index < 0)
      fail("missing_token_theme", `Token Theme does not exist: ${themeId}`);
    state.library.themes.splice(index, 1);
    state.library.activeThemeIds = state.library.activeThemeIds.filter(
      (id) => id !== themeId,
    );
    return;
  }
  if (!isRecord(change.attrs)) {
    fail("invalid_token_theme", "Penpot Token Theme attrs are invalid");
  }
  const previous = index < 0 ? {} : state.library.themes[index];
  const name = change.attrs.name ?? previous.name;
  const group = change.attrs.group ?? previous.group ?? "";
  const description = change.attrs.description ?? previous.description ?? "";
  const externalId =
    change.attrs["external-id"] ?? previous.externalId ?? String(change.id);
  const isSource = change.attrs["is-source"] ?? previous.isSource ?? false;
  const setNames = listValue(
    change.attrs.sets ??
      (previous.setIds ?? []).map((id) => tokenSetById(state, id).name),
    "invalid_token_theme_sets",
    "Penpot Token Theme sets must be an array",
  );
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    typeof group !== "string" ||
    typeof description !== "string" ||
    typeof externalId !== "string" ||
    typeof isSource !== "boolean"
  ) {
    fail(
      "invalid_token_theme",
      "Penpot Token Theme attrs are incomplete or invalid",
    );
  }
  const theme = {
    description,
    externalId,
    group,
    id: themeId,
    isSource,
    name,
    setIds: setNames.map((setName) => tokenSetIdByName(state, setName)),
  };
  if (index < 0) state.library.themes.push(theme);
  else state.library.themes[index] = theme;
}

function applyActiveTokenThemes(state, change) {
  const paths = listValue(
    change["theme-paths"],
    "invalid_active_token_themes",
    "Penpot active Token Theme paths must be an array",
  );
  if (paths.length === 1 && paths[0] === HIDDEN_TOKEN_THEME_PATH) {
    state.library.activeThemeIds = [];
    return;
  }
  state.library.activeThemeIds = paths.map((path) => {
    const theme = state.library.themes.find(
      (candidate) => tokenThemePath(candidate) === path,
    );
    if (!theme)
      fail("missing_token_theme", `Token Theme path does not exist: ${path}`);
    return theme.id;
  });
}

function pathValue(value, field) {
  return listValue(
    value,
    "invalid_token_set_path",
    `Penpot ${field} must be an array`,
  ).join("/");
}

function insertTokenSets(state, moving, beforePath, beforeGroup) {
  if (beforePath === null || beforePath === undefined) {
    state.library.sets.push(...moving);
    return;
  }
  const beforeName = pathValue(beforePath, "before-path");
  const index = state.library.sets.findIndex(({ name }) =>
    beforeGroup
      ? name === beforeName || name.startsWith(`${beforeName}/`)
      : name === beforeName,
  );
  if (index < 0) {
    fail(
      "missing_token_set_destination",
      `Token Set destination does not exist: ${beforeName}`,
    );
  }
  state.library.sets.splice(index, 0, ...moving);
}

function applyMoveTokenSet(state, change) {
  const fromName = pathValue(change["from-path"], "from-path");
  const toName = pathValue(change["to-path"], "to-path");
  const index = state.library.sets.findIndex(({ name }) => name === fromName);
  if (index < 0)
    fail("missing_token_set", `Token Set does not exist: ${fromName}`);
  const [moving] = state.library.sets.splice(index, 1);
  moving.name = toName;
  insertTokenSets(
    state,
    [moving],
    change["before-path"],
    change["before-group"],
  );
}

function applyMoveTokenSetGroup(state, change) {
  const fromName = pathValue(change["from-path"], "from-path");
  const toName = pathValue(change["to-path"], "to-path");
  const moving = state.library.sets.filter(
    ({ name }) => name === fromName || name.startsWith(`${fromName}/`),
  );
  if (moving.length === 0) {
    fail(
      "missing_token_set_group",
      `Token Set group does not exist: ${fromName}`,
    );
  }
  state.library.sets = state.library.sets.filter(
    (tokenSet) => !moving.includes(tokenSet),
  );
  for (const tokenSet of moving) {
    tokenSet.name = `${toName}${tokenSet.name.slice(fromName.length)}`;
  }
  insertTokenSets(state, moving, change["before-path"], change["before-group"]);
}

function applyRenameTokenSetGroup(state, change) {
  const path = listValue(
    change["set-group-path"],
    "invalid_token_set_path",
    "Penpot Token Set group path must be an array",
  );
  if (path.length === 0 || typeof change["set-group-fname"] !== "string") {
    fail("invalid_token_set_group", "Penpot Token Set group rename is invalid");
  }
  const fromName = path.join("/");
  const toName = [...path.slice(0, -1), change["set-group-fname"]].join("/");
  let changed = false;
  for (const tokenSet of state.library.sets) {
    if (tokenSet.name.startsWith(`${fromName}/`)) {
      tokenSet.name = `${toName}${tokenSet.name.slice(fromName.length)}`;
      changed = true;
    }
  }
  if (!changed) {
    fail(
      "missing_token_set_group",
      `Token Set group does not exist: ${fromName}`,
    );
  }
}

function compileTokenLibraryChanges(snapshot, changes) {
  const state = tokenCompilerState(snapshot);
  for (const change of changes) {
    const type = normalizeType(change.type);
    if (type === "set-token") applySetToken(state, change);
    else if (type === "set-token-set") applySetTokenSet(state, change);
    else if (type === "set-token-theme") applySetTokenTheme(state, change);
    else if (type === "set-active-token-themes")
      applyActiveTokenThemes(state, change);
    else if (type === "set-tokens-status") {
      const resolveIds = (field, map, entries, code) =>
        listValue(change[field], code, `${field} must be an array`).map(
          (id) => {
            const stableId = map.get(String(id));
            if (!stableId || !entries.some((entry) => entry.id === stableId))
              fail(code, `Unknown Token identity: ${id}`);
            return stableId;
          },
        );
      state.library.activeThemeIds = resolveIds(
        "theme-ids",
        state.runtimeThemes,
        state.library.themes,
        "missing_token_theme",
      );
      state.library.activeSetIds = resolveIds(
        "set-ids",
        state.runtimeSets,
        state.library.sets,
        "missing_token_set",
      );
    }
    else if (type === "move-token-set") applyMoveTokenSet(state, change);
    else if (type === "move-token-set-group")
      applyMoveTokenSetGroup(state, change);
    else if (type === "rename-token-set-group")
      applyRenameTokenSetGroup(state, change);
  }
  if (state.library.defaultThemeIds) {
    state.library.defaultThemeIds = state.library.defaultThemeIds.filter((id) =>
      state.library.themes.some((theme) => theme.id === id));
    state.library.defaultThemeIds = defaultTokenThemeIds(state.library);
  }
  if (state.library.defaultSetIds) state.library.defaultSetIds = state.library.defaultSetIds.filter((id) => state.library.sets.some((set) => set.id === id));
  return { library: state.library, type: "replace-token-library" };
}

const TOKEN_STATUS_CHANGE_TYPES = new Set([
  "set-active-token-themes",
  "set-tokens-status",
]);

// The Foundation whose Form A library a Product's Web token manager shows
// beside its own (projection.cljs project-token-parts), or undefined.
function productTokenFoundation(snapshot) {
  for (const dependency of snapshot.manifest.dependencies ?? []) {
    const foundation = snapshot.libraries.find(
      (library) => library.manifest.packageId === dependency.packageId,
    );
    if (foundation && tokenLibraryOf(foundation)) return foundation;
  }
  return undefined;
}

// A Product's token manager holds its Foundation's sets and themes, which
// belong to the Foundation: editing them from the Product fails. Its theme
// selection, the Foundation's themes included, is one
// set-active-token-themes with every active path (docs/TOKEN-THEMES.md 3.5).
function compileProductTokenChanges(snapshot, foundation, changes) {
  const runtime = foundation.runtime ?? {};
  const foundationIds = new Set([
    ...Object.keys(runtime.reverseTokenSets ?? {}),
    ...Object.keys(runtime.reverseTokenThemes ?? {}),
    ...Object.keys(runtime.reverseTokens ?? {}),
  ]);
  const foundationSetNames = new Set(
    tokenLibraryOf(foundation).sets.map(({ name }) => name),
  );
  const pathNames = (change) =>
    ["from-path", "to-path", "before-path", "set-group-path"]
      .filter((field) => Array.isArray(change[field]))
      .map((field) => change[field].join("/"));
  const edits = [];
  let status;
  for (const change of changes) {
    const type = normalizeType(change.type);
    if (TOKEN_STATUS_CHANGE_TYPES.has(type)) {
      status = change;
      continue;
    }
    const names = pathNames(change);
    if (
      ["id", "set-id", "token-id"].some((field) =>
        foundationIds.has(String(change[field] ?? "")),
      ) ||
      names.some(
        (name) =>
          foundationSetNames.has(name) ||
          [...foundationSetNames].some((setName) => setName.startsWith(`${name}/`)),
      )
    ) {
      fail(
        "foundation_tokens_read_only",
        `Token sets and themes of the Foundation ${foundation.manifest.name} are read-only in this Product; edit them in the Foundation`,
        { changeType: type, foundationPackageId: foundation.manifest.packageId },
      );
    }
    edits.push(change);
  }
  const operations =
    edits.length > 0 ? [compileTokenLibraryChanges(snapshot, edits)] : [];
  if (status) {
    const selection = productThemeSelection(snapshot, foundation, status);
    if (selection) operations.push(selection);
  }
  return operations;
}

// The set-active-token-themes a Product's status change asks for, or null
// when it keeps the current selection.
function productThemeSelection(snapshot, foundation, change) {
  const themes = listTokenThemes(snapshot, foundation);
  const ownRuntime = snapshot.runtime.reverseTokenThemes ?? {};
  const foundationRuntime = foundation.runtime?.reverseTokenThemes ?? {};
  const themeOf = (runtimeId) => {
    const own = ownRuntime[runtimeId];
    const inFoundation = foundationRuntime[runtimeId];
    const match = own
      ? themes.find((theme) => theme.owner === "package" && theme.id === own.tokenThemeId)
      : inFoundation
        ? themes.find((theme) => theme.owner === "foundation" && theme.id === inFoundation.tokenThemeId)
        : undefined;
    if (!match) fail("missing_token_theme", `Unknown Token Theme identity: ${runtimeId}`);
    return match;
  };
  let selected;
  if (normalizeType(change.type) === "set-tokens-status") {
    selected = listValue(
      change["theme-ids"],
      "invalid_active_token_themes",
      "theme-ids must be an array",
    )
      .map(String)
      .filter((id) => id !== "00000000-0000-0000-0000-000000000000")
      .map(themeOf);
  } else {
    selected = listValue(
      change["theme-paths"],
      "invalid_active_token_themes",
      "Penpot active Token Theme paths must be an array",
    )
      .filter((path) => path !== HIDDEN_TOKEN_THEME_PATH)
      .map((path) => {
        const match = themes.find((theme) => theme.path === path);
        if (!match) fail("missing_token_theme", `Token Theme path does not exist: ${path}`);
        return match;
      });
  }
  const setSelectionFails = () =>
    fail(
      "token_set_selection_unsupported",
      "A Product selects token themes; choose a theme instead of switching token sets",
    );
  if (selected.length === 0) setSelectionFails();
  if (Array.isArray(change["set-ids"])) {
    // The sets a status may name: those of the chosen themes, plus the
    // activeSetIds of a library none of whose themes is chosen.
    const allowed = new Set();
    for (const [owner, source] of [["package", snapshot], ["foundation", foundation]]) {
      const library = tokenLibraryOf(source);
      if (!library) continue;
      const chosen = selected.filter((theme) => theme.owner === owner);
      const setIds = chosen.length > 0
        ? chosen.flatMap((theme) => theme.setIds)
        : library.activeSetIds;
      for (const id of setIds) {
        const runtimeId = source.runtime?.tokenSets?.[id];
        if (runtimeId) allowed.add(String(runtimeId));
      }
    }
    if (change["set-ids"].some((id) => !allowed.has(String(id)))) setSelectionFails();
  }
  const key = ({ owner, id }) => `${owner}\0${id}`;
  const current = new Set(themes.filter(({ active }) => active).map(key));
  const next = new Set(selected.map(key));
  if (current.size === next.size && [...next].every((item) => current.has(item))) {
    return null;
  }
  return {
    themePaths: [...new Set(selected.map(({ path }) => path))],
    type: "set-active-token-themes",
  };
}

function currentAssetLibrary(snapshot) {
  const entry = snapshot.manifest.entries.assets[0];
  return entry
    ? structuredClone(snapshot.entries[entry])
    : { colors: [], fonts: [], id: "alib_design", media: [], typographies: [] };
}

function compileLibraryPaint(state, value) {
  const opacity = value.opacity;
  if (
    opacity !== undefined &&
    opacity !== null &&
    (typeof opacity !== "number" ||
      !Number.isFinite(opacity) ||
      opacity < 0 ||
      opacity > 1)
  ) {
    fail("invalid_fill_opacity", "Penpot library Color opacity is invalid");
  }
  if (value.image !== undefined && value.image !== null) {
    return {
      mediaRef: compileMediaReference(state.snapshot, value.image),
      ...(value.opacity === undefined || value.opacity === null
        ? {}
        : { opacity: value.opacity }),
      type: "image",
    };
  }
  if (typeof value.color === "string" && value.gradient == null) {
    return {
      color: value.color,
      ...(opacity === undefined || opacity === null ? {} : { opacity }),
      type: "solid",
    };
  }
  if (
    value.gradient !== undefined &&
    value.gradient !== null &&
    value.color == null
  ) {
    return {
      ...compileGradient(value.gradient),
      ...(opacity === undefined || opacity === null ? {} : { opacity }),
    };
  }
  fail(
    "invalid_library_color",
    "Penpot library Color must contain exactly one color or gradient",
  );
}

function compileLibraryColor(state, value) {
  if (!isRecord(value)) {
    fail("invalid_library_color", "Penpot library Color must be an object");
  }
  const id = stableRuntimeReference(
    state.runtimeColors,
    value.id,
    "color_",
    "invalid_runtime_color",
  );
  if (typeof value.name !== "string" || value.name.length === 0) {
    fail(
      "invalid_library_color",
      "Penpot library Color name must be non-empty",
    );
  }
  if (
    value.path !== undefined &&
    value.path !== null &&
    typeof value.path !== "string"
  ) {
    fail("invalid_library_color", "Penpot library Color path must be a string");
  }
  return {
    id,
    name: value.name,
    paint: compileLibraryPaint(state, value),
    path: value.path ?? "",
  };
}

function compileLibraryTypography(state, value) {
  if (!isRecord(value)) {
    fail("invalid_library_typography", "Penpot Typography must be an object");
  }
  const id = stableRuntimeReference(
    state.runtimeTypographies,
    value.id,
    "typo_",
    "invalid_runtime_typography",
  );
  if (typeof value.name !== "string" || value.name.length === 0) {
    fail(
      "invalid_library_typography",
      "Penpot Typography name must be non-empty",
    );
  }
  if (
    value.path !== undefined &&
    value.path !== null &&
    typeof value.path !== "string"
  ) {
    fail(
      "invalid_library_typography",
      "Penpot Typography path must be a string",
    );
  }
  const style = {};
  for (const [field, canonicalField] of [
    ["font-family", "fontFamily"],
    ["font-id", "fontId"],
    ["font-size", "fontSize"],
    ["font-style", "fontStyle"],
    ["font-variant-id", "fontVariantId"],
    ["font-weight", "fontWeight"],
    ["letter-spacing", "letterSpacing"],
    ["line-height", "lineHeight"],
    ["text-transform", "textTransform"],
  ]) {
    if (value[field] === undefined || value[field] === null) {
      fail(
        "invalid_library_typography",
        `Penpot Typography is missing ${field}`,
      );
    }
    style[canonicalField] =
      canonicalField === "fontId"
        ? canonicalFontId(state.snapshot, value[field])
        : textStyleValue(canonicalField, value[field]);
  }
  return { id, name: value.name, path: value.path ?? "", style };
}

function existingMediaId(state, runtimeId) {
  return stableRuntimeReference(
    state.runtimeMedia,
    runtimeId,
    "media_",
    "invalid_runtime_media",
  );
}

function compileLibraryMedia(state, value, type) {
  if (!isRecord(value)) {
    fail("invalid_library_media", "Penpot Media must contain an object");
  }
  const id = existingMediaId(state, value.id);
  const index = state.library.media.findIndex((media) => media.id === id);
  if (index < 0) {
    fail(
      "missing_uploaded_media",
      "Penpot Media must be uploaded to the local Package before its library change",
      { mediaId: id },
    );
  }
  const previous = state.library.media[index];
  if (
    (value.width !== undefined && value.width !== previous.width) ||
    (value.height !== undefined && value.height !== previous.height) ||
    (value.mtype !== undefined && value.mtype !== previous.mimeType)
  ) {
    fail(
      "immutable_media_content",
      "Penpot Media content cannot change through a library metadata edit",
      { mediaId: id },
    );
  }
  if (type === "add-media") return;
  if (typeof value.name !== "string" || value.name.length === 0) {
    fail("invalid_library_media", "Penpot Media name must be non-empty");
  }
  if (
    value.path !== undefined &&
    value.path !== null &&
    typeof value.path !== "string"
  ) {
    fail("invalid_library_media", "Penpot Media path must be a string");
  }
  state.library.media[index] = {
    ...previous,
    name: value.name,
    path: value.path ?? previous.path,
  };
}

function compileAssetLibraryChanges(snapshot, changes) {
  const state = {
    library: currentAssetLibrary(snapshot),
    snapshot,
    runtimeColors: new Map(
      Object.entries(snapshot.runtime.reverseColors ?? {}).map(
        ([runtimeId, { colorId }]) => [runtimeId, colorId],
      ),
    ),
    runtimeTypographies: new Map(
      Object.entries(snapshot.runtime.reverseTypographies ?? {}).map(
        ([runtimeId, { typographyId }]) => [runtimeId, typographyId],
      ),
    ),
    runtimeMedia: new Map(
      Object.entries(snapshot.runtime.reverseMedia ?? {}).map(
        ([runtimeId, { mediaId }]) => [runtimeId, mediaId],
      ),
    ),
  };
  for (const change of changes) {
    const type = normalizeType(change.type);
    if (type === "add-color" || type === "mod-color") {
      const color = compileLibraryColor(state, change.color);
      const index = state.library.colors.findIndex(({ id }) => id === color.id);
      if (type === "add-color" && index >= 0) {
        fail("duplicate_color_id", `Color already exists: ${color.id}`);
      }
      if (type === "mod-color" && index < 0) {
        fail("missing_color", `Color does not exist: ${color.id}`);
      }
      if (index < 0) state.library.colors.push(color);
      else state.library.colors[index] = color;
    } else if (type === "del-color") {
      const colorId = stableRuntimeReference(
        state.runtimeColors,
        change.id,
        "color_",
        "invalid_runtime_color",
      );
      const index = state.library.colors.findIndex(({ id }) => id === colorId);
      if (index < 0)
        fail("missing_color", `Color does not exist: ${String(change.id)}`);
      state.library.colors.splice(index, 1);
    } else if (type === "add-media" || type === "mod-media") {
      compileLibraryMedia(state, change.object, type);
    } else if (type === "del-media") {
      const mediaId = existingMediaId(state, change.id);
      const index = state.library.media.findIndex(({ id }) => id === mediaId);
      if (index < 0) {
        fail("missing_media", `Media does not exist: ${String(change.id)}`);
      }
      state.library.media.splice(index, 1);
    } else if (type === "add-typography" || type === "mod-typography") {
      const typography = compileLibraryTypography(state, change.typography);
      const index = state.library.typographies.findIndex(
        ({ id }) => id === typography.id,
      );
      if (type === "add-typography" && index >= 0) {
        fail(
          "duplicate_typography_id",
          `Typography already exists: ${typography.id}`,
        );
      }
      if (type === "mod-typography" && index < 0) {
        fail(
          "missing_typography",
          `Typography does not exist: ${typography.id}`,
        );
      }
      if (index < 0) state.library.typographies.push(typography);
      else state.library.typographies[index] = typography;
    } else if (type === "del-typography") {
      const typographyId = stableRuntimeReference(
        state.runtimeTypographies,
        change.id,
        "typo_",
        "invalid_runtime_typography",
      );
      const index = state.library.typographies.findIndex(
        ({ id }) => id === typographyId,
      );
      if (index < 0) {
        fail(
          "missing_typography",
          `Typography does not exist: ${String(change.id)}`,
        );
      }
      state.library.typographies.splice(index, 1);
    }
  }
  return { library: state.library, type: "replace-asset-library" };
}

function presentationTemplate(screen) {
  return screen.presentations.find(
    ({ id }) => id === screen.basePresentationId,
  );
}

function applyPresentationRoots(presentation, rootIds) {
  presentation.rootId = rootIds[0] ?? null;
  if (rootIds.length !== 1) presentation.rootIds = rootIds;
  return presentation;
}

// --- canvases ----------------------------------------------------------
// A Penpot page is a canvas; its boards are page versions. Adding, renaming,
// moving and deleting a page change the canvas list (put-canvases).

function canvasDescriptor(snapshot, runtimeId) {
  const page = pageDescriptorById(snapshot, runtimeId);
  return { ...page, canvas: explicitCanvases(snapshot.manifest, snapshot.entries).find(({ id }) => id === page.canvasId) };
}

function compileAddedCanvas(snapshot, change) {
  const runtimeId = change.id ?? change.page?.id;
  if (snapshot.runtime.reversePages?.[String(runtimeId)]) {
    fail("duplicate_runtime_page", `Penpot page already exists: ${String(runtimeId)}`);
  }
  const name = change.name ?? change.page?.name;
  if (typeof name !== "string" || name.length === 0) {
    fail("invalid_presentation_name", "Penpot page name must be non-empty");
  }
  // A page that arrives with shapes is a copy of a canvas and its pages.
  const objects = Object.keys(change.page?.objects ?? {}).filter((key) => key !== ZERO_UUID);
  if (objects.length > 0) {
    fail(
      "duplicate_canvas_unsupported",
      "Copying a whole canvas is not supported yet; ask the agent to copy the pages with the CLI (page draw)",
    );
  }
  // The canvas keeps the page's identity: its id carries the page UUID.
  const id = runtimePresentationId(runtimeId).replace(/^pres_/, "cnv_");
  return {
    canvases: [...explicitCanvases(snapshot.manifest, snapshot.entries), { id, name, screens: [] }],
    type: "put-canvases",
  };
}

// Deleting a page deletes what is on it, as in Penpot: each page whose every
// version is there, or just the versions that are, then the canvas.
function compileDeletedCanvas(snapshot, change) {
  const { boards = [], canvasId } = canvasDescriptor(snapshot, change.id);
  const operations = [];
  const deletedScreens = new Set();
  for (const { screenId, presentationId } of boards) {
    if (deletedScreens.has(screenId)) continue;
    const entry = snapshot.manifest.entries.screens.find((name) => snapshot.entries[name].id === screenId);
    const screen = snapshot.entries[entry];
    const here = boards.filter((board) => board.screenId === screenId).map((board) => board.presentationId);
    if (screen.presentations.every(({ id }) => here.includes(id))) {
      operations.push({ screenId, type: "delete-screen" });
      deletedScreens.add(screenId);
    } else {
      operations.push({ presentationId, screenId, type: "delete-presentation" });
    }
  }
  const remaining = explicitCanvases(snapshot.manifest, snapshot.entries)
    .filter(({ id }) => id !== canvasId)
    .map((canvas) => ({ ...canvas, screens: canvas.screens.filter((id) => !deletedScreens.has(id)) }));
  operations.push({ canvases: remaining, type: "put-canvases" });
  return operations;
}

function compileRenamedCanvas(snapshot, change) {
  const { canvasId, canvasName } = canvasDescriptor(snapshot, change.id);
  if (typeof change.name !== "string" || change.name.length === 0)
    fail("invalid_presentation_name", "Penpot page name must be non-empty");
  if (change.name === canvasName) return undefined;
  return {
    canvases: explicitCanvases(snapshot.manifest, snapshot.entries).map((canvas) =>
      canvas.id === canvasId ? { ...canvas, name: change.name } : canvas),
    type: "put-canvases",
  };
}

function compileMovedCanvas(snapshot, change) {
  const { canvasId } = canvasDescriptor(snapshot, change.id);
  const canvases = explicitCanvases(snapshot.manifest, snapshot.entries);
  if (!Number.isInteger(change.index) || change.index < 0)
    fail("invalid_page_index", "Penpot page index is outside the file");
  const moved = canvases.find(({ id }) => id === canvasId);
  const rest = canvases.filter(({ id }) => id !== canvasId);
  // Generated pages (Components, Design System) always follow the canvases.
  rest.splice(Math.min(change.index, rest.length), 0, moved);
  return { canvases: rest, type: "put-canvases" };
}

// A board dragged on its canvas changes the order of its business flow's
// pages, by where it was dropped; the CLI lays the canvas out again.
function boardMovesAsOrder(snapshot, operations) {
  const moves = [];
  const kept = [];
  for (const operation of operations) {
    if (operation.type !== "update-presentation-node" || !("x" in (operation.changes ?? {}) || "y" in (operation.changes ?? {}))) {
      kept.push(operation);
      continue;
    }
    const presentation = presentationNodes(snapshot, operation) && snapshotPresentation(snapshot, operation);
    const roots = presentation ? (Array.isArray(presentation.rootIds) ? presentation.rootIds : [presentation.rootId]) : [];
    if (!roots.includes(operation.nodeId)) {
      kept.push(operation);
      continue;
    }
    if (roots.length > 1) {
      // Several top-level shapes (a board and loose shapes beside it): a
      // move is a move, stored without the layout shift.
      const { dx, dy } = boardOffset(snapshot, operation);
      const changes = { ...operation.changes };
      if (changes.x !== undefined) changes.x -= dx;
      if (changes.y !== undefined) changes.y -= dy;
      kept.push({ ...operation, changes });
      continue;
    }
    const { x, y: _y, ...changes } = operation.changes;
    if (x !== undefined) moves.push({ screenId: operation.screenId, presentationId: operation.presentationId, x });
    if (Object.keys(changes).length) kept.push({ ...operation, changes });
  }
  if (!moves.length) return operations;
  const layout = canvasLayout(snapshot.manifest, snapshot.entries, snapshot.runtime);
  const canvases = explicitCanvases(snapshot.manifest, snapshot.entries);
  for (const move of moves) {
    const canvas = layout.find((candidate) => candidate.boards.some((board) => board.screenId === move.screenId));
    const board = canvas.boards.find((candidate) => candidate.screenId === move.screenId && candidate.presentationId === move.presentationId);
    const row = canvas.boards.filter((candidate) => candidate.flow === board.flow && candidate.platform === board.platform);
    const order = row
      .map((candidate) => ({ screenId: candidate.screenId, x: candidate.screenId === move.screenId ? move.x : candidate.x }))
      .sort((left, right) => left.x - right.x)
      .map(({ screenId }) => screenId);
    const target = canvases.find(({ id }) => id === canvas.id);
    // Pages of this flow take the dropped order; other pages keep theirs.
    const flowPages = target.screens.filter((id) => order.includes(id));
    let index = 0;
    target.screens = target.screens.map((id) => (flowPages.includes(id) ? order[index++] : id));
  }
  kept.push({ canvases, type: "put-canvases" });
  return kept;
}

function compileAddedPresentation(snapshot, change) {
  const runtimeId = change.id ?? change.page?.id;
  if (snapshot.runtime.reversePages?.[String(runtimeId)]) {
    fail(
      "duplicate_runtime_page",
      `Penpot page already exists: ${String(runtimeId)}`,
    );
  }
  const presentationId = runtimePresentationId(runtimeId);
  const { screen } = defaultScreenDescriptor(snapshot);
  const descriptor = { presentationId, screenId: screen.id };
  const template = presentationTemplate(screen);
  const page = change.page;
  const name = change.name ?? page?.name;
  if (typeof name !== "string" || name.length === 0) {
    fail("invalid_presentation_name", "Penpot page name must be non-empty");
  }
  if (page !== undefined && !isRecord(page)) {
    fail("invalid_penpot_page", "Penpot add-page page must contain an object");
  }
  if (page && String(page.id) !== String(runtimeId)) {
    fail(
      "penpot_page_id_mismatch",
      "Penpot page id does not match add-page id",
    );
  }

  const presentation = {
    id: presentationId,
    interactions: [],
    name,
    nodes: {},
  };
  if (template?.platform !== undefined) {
    presentation.platform = structuredClone(template.platform);
  }
  if (template?.viewport !== undefined) {
    presentation.viewport = structuredClone(template.viewport);
  }

  if (!page) {
    applyPresentationRoots(presentation, []);
  } else {
    const objects = page.objects;
    if (!isRecord(objects)) {
      fail("invalid_penpot_page", "Penpot page objects must contain an object");
    }
    const root = objects["00000000-0000-0000-0000-000000000000"];
    if (!isRecord(root) || !Array.isArray(root.shapes)) {
      fail(
        "invalid_penpot_page_root",
        "Penpot page must contain its root object",
      );
    }
    const placements = new Map(
      Object.entries(objects)
        .filter(
          ([objectId, value]) =>
            objectId !== "00000000-0000-0000-0000-000000000000" &&
            isRecord(value),
        )
        .map(([objectId, value]) => [
          String(objectId),
          penpotPlacement(value, ROOT_PLACEMENT, isPenpotPath(value.type)),
        ]),
    );
    for (const [objectId, value] of Object.entries(objects)) {
      if (objectId === "00000000-0000-0000-0000-000000000000") continue;
      const parentPlacement =
        placements.get(String(value?.["parent-id"])) ?? ROOT_PLACEMENT;
      const node = canonicalAddedNode(
        snapshot,
        value,
        descriptor,
        objectId,
        parentPlacement,
      );
      presentation.nodes[node.id] = node;
    }
    applyPresentationRoots(
      presentation,
      root.shapes.map((nodeId) => {
        return nodeDescriptor(snapshot, nodeId, descriptor, true).nodeId;
      }),
    );
  }
  return {
    presentation,
    screenId: screen.id,
    type: "add-presentation",
  };
}

function compileDeletedPresentation(snapshot, change) {
  const descriptor = pageDescriptorById(snapshot, change.id);
  return {
    presentationId: descriptor.presentationId,
    screenId: descriptor.screenId,
    type: "delete-presentation",
  };
}

// A mod-page rename to the name the presentation already carries is a no-op
// and is dropped; every other name is Canonical data and is saved verbatim.
// Prefix stripping or display-name composition would guess user intent and is
// intentionally not done here (RV-002-A) — no-edit blurs are suppressed by the
// sitemap UI before a change is ever compiled.
function resolveCanonicalPresentationName(snapshot, descriptor, change) {
  if (!Object.hasOwn(change, "name") || typeof change.name !== "string") {
    return change;
  }
  const screenEntry = snapshot.manifest.entries.screens.find(
    (entry) => snapshot.entries[entry].id === descriptor.screenId,
  );
  const presentation = screenEntry
    ? snapshot.entries[screenEntry].presentations.find(
        ({ id }) => id === descriptor.presentationId,
      )
    : undefined;
  if (presentation && change.name === presentation.name) {
    const { name: _dropped, ...rest } = change;
    return rest;
  }
  return change;
}

function compileUpdatedPresentation(snapshot, change) {
  const descriptor = pageDescriptorById(snapshot, change.id);
  const original = change;
  change = resolveCanonicalPresentationName(snapshot, descriptor, change);
  const changedAttributes = [
    "background",
    "name",
    "pixel-grid-color",
    "pixel-grid-opacity",
  ].filter((attribute) => Object.hasOwn(change, attribute));
  const unsupported = changedAttributes.filter(
    (attribute) => !PENPOT_PAGE_ATTRIBUTES.has(attribute),
  );
  // A canvas color Token link has no canonical home. Clearing it (every
  // plain color change and the detach action send background-token nil)
  // changes nothing; applying one cannot be stored.
  const backgroundToken = change["background-token"];
  if (backgroundToken !== undefined && backgroundToken !== null) {
    unsupported.push("background-token");
  }
  if (unsupported.length > 0) {
    fail(
      "unsupported_penpot_page_attribute",
      `Penpot page attribute is not supported: ${unsupported[0]}`,
      { attributes: unsupported },
    );
  }
  if (changedAttributes.length === 0) {
    // Only a cleared Token link or the name it already has.
    if (["background-token", "name"].some((key) => Object.hasOwn(original, key))) {
      return null;
    }
    fail(
      "invalid_penpot_page_change",
      "Penpot mod-page must contain at least one supported attribute",
    );
  }
  if (
    Object.hasOwn(change, "name") &&
    (typeof change.name !== "string" || change.name.length === 0)
  ) {
    fail("invalid_penpot_page_change", "Penpot page name must be non-empty");
  }
  // nil clears an attribute (an undo back to the default background).
  for (const attribute of ["background", "pixel-grid-color"]) {
    if (
      Object.hasOwn(change, attribute) &&
      change[attribute] !== null &&
      typeof change[attribute] !== "string"
    ) {
      fail(
        "invalid_penpot_page_change",
        `Penpot ${attribute} must be a color string`,
      );
    }
  }
  if (
    Object.hasOwn(change, "pixel-grid-opacity") &&
    change["pixel-grid-opacity"] !== null &&
    (typeof change["pixel-grid-opacity"] !== "number" ||
      !Number.isFinite(change["pixel-grid-opacity"]) ||
      change["pixel-grid-opacity"] < 0 ||
      change["pixel-grid-opacity"] > 1)
  ) {
    fail(
      "invalid_penpot_page_change",
      "Penpot pixel-grid-opacity must be between zero and one",
    );
  }
  return {
    changes: Object.fromEntries(
      changedAttributes.map((attribute) => [attribute, change[attribute]]),
    ),
    presentationId: descriptor.presentationId,
    screenId: descriptor.screenId,
    type: "update-presentation",
  };
}

function compilePrototypeFlow(snapshot, change) {
  const page = pageDescriptor(snapshot, change);
  const screenEntry = snapshot.manifest.entries.screens.find(
    (entry) => snapshot.entries[entry].id === page.screenId,
  );
  const presentation = snapshot.entries[screenEntry].presentations.find(
    ({ id }) => id === page.presentationId,
  );
  const flowId = String(change.id);
  let prototypeFlows = structuredClone(presentation.prototypeFlows ?? []);
  const index = prototypeFlows.findIndex(({ id }) => id === flowId);
  if (change.params === null || change.params === undefined) {
    if (index < 0) {
      fail(
        "missing_prototype_flow",
        `Prototype Flow does not exist: ${flowId}`,
      );
    }
    prototypeFlows.splice(index, 1);
  } else {
    if (!isRecord(change.params)) {
      fail(
        "invalid_prototype_flow",
        "Penpot set-flow params must be an object",
      );
    }
    const name = change.params.name;
    if (typeof name !== "string" || name.length === 0) {
      fail("invalid_prototype_flow", "Penpot Flow name must be non-empty");
    }
    const startingFrame =
      change.params["starting-frame"] ?? change.params.startingFrame;
    const descriptor = nodeDescriptor(snapshot, startingFrame, page, true);
    const node = presentation.nodes[descriptor.nodeId];
    if (node?.type !== "FRAME") {
      fail(
        "invalid_prototype_flow_start",
        "Penpot Flow must start from a FRAME",
      );
    }
    const flow = {
      id: flowId,
      name,
      startingNodeId: descriptor.nodeId,
    };
    if (index < 0) prototypeFlows.push(flow);
    else prototypeFlows[index] = flow;
  }
  return {
    changes: { prototypeFlows },
    presentationId: page.presentationId,
    screenId: page.screenId,
    type: "update-presentation",
  };
}

function orderedPageDescriptors(snapshot) {
  return snapshot.manifest.entries.screens.flatMap((entry) => {
    const screen = snapshot.entries[entry];
    return screen.presentations.map((presentation) => ({
      presentationId: presentation.id,
      runtimeId: snapshot.runtime.pages[screen.id][presentation.id],
      screenId: screen.id,
    }));
  });
}

function compileMovedPresentation(snapshot, change) {
  const descriptor = pageDescriptorById(snapshot, change.id);
  const pages = orderedPageDescriptors(snapshot);
  if (
    !Number.isInteger(change.index) ||
    change.index < 0 ||
    change.index > pages.length
  ) {
    fail("invalid_page_index", "Penpot page index is outside the file");
  }
  const before = pages
    .slice(0, change.index)
    .filter(({ runtimeId }) => runtimeId !== String(change.id));
  const after = pages
    .slice(change.index)
    .filter(({ runtimeId }) => runtimeId !== String(change.id));
  const desired = [
    ...before,
    { ...descriptor, runtimeId: String(change.id) },
    ...after,
  ];
  if (
    desired.some(({ screenId }, index) => screenId !== pages[index].screenId)
  ) {
    fail(
      "unsupported_page_move_scope",
      "Penpot pages can currently move only within their SmallPen Screen",
    );
  }
  const localOrder = desired.filter(
    ({ screenId }) => screenId === descriptor.screenId,
  );
  return {
    index: localOrder.findIndex(
      ({ presentationId }) => presentationId === descriptor.presentationId,
    ),
    presentationId: descriptor.presentationId,
    screenId: descriptor.screenId,
    type: "move-presentation",
  };
}

function compileNodeUpdate(
  snapshot,
  change,
  operations,
  operationsByNode,
  updateStatesByNode,
  projections,
  geometry,
  addedNodes = new Map(),
  rootTouched = new Map(),
) {
  const page =
    change.pageId !== undefined || change["page-id"] !== undefined
      ? pageDescriptor(snapshot, change)
      : null;
  const descriptor = nodeDescriptor(snapshot, change.id, page, Boolean(page));
  if (!Array.isArray(change.operations)) {
    fail(
      "invalid_penpot_change",
      "Penpot mod-obj change must contain operations",
    );
  }
  const key = `${descriptor.screenId}\0${descriptor.presentationId}\0${descriptor.nodeId}`;
  const screenEntry = snapshot.manifest.entries.screens.find(
    (entry) => snapshot.entries[entry].id === descriptor.screenId,
  );
  const presentation = snapshot.entries[screenEntry].presentations.find(
    (value) => value.id === descriptor.presentationId,
  );
  // A shape created earlier in this commit (Penpot sends add-obj, then the
  // typed text or other edits as a mod-obj in the same commit) is not in the
  // snapshot yet: edit the node its add-presentation-node creates.
  const canonicalNode =
    presentation.nodes[descriptor.nodeId] ?? addedNodes.get(key);
  const node =
    canonicalNode ?? projectedNode(snapshot, descriptor, projections) ?? {};
  const projectedOnly = canonicalNode === undefined && node.type !== undefined;
  const domainRoot = canonicalNode?.instance !== undefined;
  const coordinatePage = {
    presentationId: descriptor.presentationId,
    screenId: descriptor.screenId,
  };
  // Penpot geometry is page-absolute; canonical geometry is relative to the
  // parent's full transform. Re-express the shape's FINAL placement (every
  // geometry set in this commit applied) against its FINAL parent, so a
  // move, turn or reparent in the same commit is applied exactly once.
  // A projected-only node (a component instance child) sits in the
  // projected tree, not the canonical one.
  const projectedNodes = projectedOnly
    ? projectedPresentationNodes(snapshot, descriptor, projections)
    : null;
  const projectedParentId = projectedOnly
    ? canonicalParentIndex(projectedNodes).get(descriptor.nodeId)
    : undefined;
  const parentPlacement = projectedOnly
    ? projectedParentId === undefined
      ? ROOT_PLACEMENT
      : projectedAbsolutePlacement(
          snapshot,
          coordinatePage,
          projectedNodes,
          projectedParentId,
          geometry,
        )
    : parentAbsolutePlacement(snapshot, coordinatePage, change.id, geometry);
  const placement = projectedOnly
    ? projectedAbsolutePlacement(
        snapshot,
        coordinatePage,
        projectedNodes,
        descriptor.nodeId,
        geometry,
      )
    : runtimeAbsolutePlacement(snapshot, coordinatePage, change.id, geometry);
  const relative = relativePlacement(parentPlacement, placement, [
    penpotRelativeFlips(parentPlacement, placement),
    { flipX: node.flipX === true, flipY: node.flipY === true },
  ]);
  const relativeValues = {
    "flip-x": relative.flipX,
    "flip-y": relative.flipY,
    rotation: relative.rotation,
    x: relative.x,
    y: relative.y,
  };
  let placed = geometry.values.has(String(change.id));
  let operation = operationsByNode.get(key);
  if (!operation) {
    operation = {
      changes: {},
      nodeId: descriptor.nodeId,
      presentationId: descriptor.presentationId,
      screenId: descriptor.screenId,
      type: "update-presentation-node",
    };
    operationsByNode.set(key, operation);
    operations.push(operation);
  }
  let updateState = updateStatesByNode.get(key);
  if (!updateState) {
    updateState = {
      changesGeometry: false,
      changesProportionLock: false,
      changesText: false,
      changesTransform: false,
      derivedAttributes: [],
    };
    updateStatesByNode.set(key, updateState);
  }
  // A projected-only node is a component instance child: its edits become
  // Instance overrides once every change of the commit is known.
  if (projectedOnly) {
    updateState.instanceChild ??= {
      changes: {},
      descriptor,
      editedFields: new Set(),
      node,
      syncedFields: new Set(),
      touched: undefined,
    };
  }
  const instanceChild = updateState.instanceChild;
  for (const item of change.operations) {
    if (!isRecord(item)) {
      fail(
        "unsupported_penpot_operation",
        `Phase 0 cannot compile Penpot operation: ${String(item?.type)}`,
      );
    }
    const itemType = normalizeType(item.type);
    if (!PENPOT_WRITE.operationTypes.includes(itemType)) {
      fail(
        "unsupported_penpot_operation",
        `Phase 0 cannot compile Penpot operation: ${String(item?.type)}`,
      );
    }
    if (itemType === "set-remote-synced") {
      // Penpot's mark for copies synced from a remote library. SmallPen
      // copies always project from their source, so it has nothing to keep.
      continue;
    }
    if (itemType === "set-touched" && instanceChild) {
      // The groups Penpot keeps touched from here on; a nil set is a reset.
      instanceChild.touched = Array.isArray(item.touched) ? item.touched : [];
      instanceChild.editedFields.clear();
      continue;
    }
    if (itemType === "set-touched" && domainRoot) {
      // A domain Instance stores no touched groups; the projection derives
      // them from the fields the Instance holds over its source.
      continue;
    }
    if (
      domainRoot &&
      itemType === "set" &&
      item["ignore-touched"] === true &&
      !PLACEMENT_ATTRIBUTES.has(normalizeType(item.attr)) &&
      !PENPOT_DERIVED_ATTRIBUTES.has(normalizeType(item.attr))
    ) {
      // Penpot writes copies with ignore-touched in two cases. A component
      // sync re-applies the source to an untouched copy: the Instance
      // projects its source already, so pinning the value would stop later
      // source edits from reaching it. An undo or Reset overrides also sets
      // the copy's touched groups in the same commit: a field whose group is
      // no longer touched goes back to its source.
      const touched = rootTouched.get(String(change.id));
      if (touched === undefined) continue;
      const field = DOMAIN_ROOT_OVERRIDE_FIELDS.get(normalizeType(item.attr));
      if (
        field !== undefined &&
        field !== "name" &&
        !overrideTouchedGroups(field, node.type).some((group) =>
          touched.has(group),
        )
      ) {
        if (Object.hasOwn(node, field)) operation.changes[field] = null;
        continue;
      }
    }
    if (itemType === "set-touched") {
      if (item.touched === null || item.touched === undefined) {
        if (Object.hasOwn(node, "touched")) operation.changes.touched = null;
      } else {
        compileAttribute(operation, "touched", item.touched, node, snapshot);
      }
      continue;
    }
    const attr = normalizeType(item.attr);
    if (PENPOT_DERIVED_ATTRIBUTES.has(attr)) {
      updateState.derivedAttributes.push(attr);
      continue;
    }
    if (!PENPOT_ATTRIBUTES.has(attr)) {
      fail(
        "unsupported_penpot_attribute",
        `Phase 0 cannot compile Penpot attribute: ${String(attr)}`,
      );
    }
    updateState.changesGeometry ||= PENPOT_GEOMETRY_ATTRIBUTES.has(attr);
    updateState.changesProportionLock ||= attr === "proportion-lock";
    updateState.changesText ||= attr === "content";
    updateState.changesTransform ||=
      attr === "flip-x" || attr === "flip-y" || attr === "rotation";
    // Invalid values pass through so compileAttribute rejects them. A nil
    // flip or turn (an undo restoring an unset attr) is already folded into
    // the placement as false / 0, like Penpot's own dissoc.
    const itemValue =
      Object.hasOwn(relativeValues, attr) &&
      (item.val === null ||
        (attr.startsWith("flip-")
          ? typeof item.val === "boolean"
          : Number.isFinite(item.val)))
        ? relativeValues[attr]
        : item.val;
    if (attr === "content" && node.type === "PATH") {
      // Penpot path content is page-absolute and already turned; canonical
      // pathData is local to the node box it is stored with.
      placed = true;
      operation.changes.pathData = compilePathContent(
        itemValue,
        invertMatrix(
          relativeNodeMatrix(
            parentPlacement,
            relative,
            placement.width,
            placement.height,
          ),
        ),
      );
      continue;
    }
    const before = instanceChild ? { ...operation.changes } : undefined;
    compileAttribute(
      operation,
      attr,
      itemValue,
      {
        // A domain Instance's root inherits the source's bindings and
        // layout. Applied Token edits act on what the editor actually shows.
        ...(attr === "applied-tokens" && domainRoot
          ? {
              ...projectedNode(snapshot, descriptor, projections),
              instance: node.instance,
            }
          : node),
        ...operation.changes,
      },
      snapshot,
    );
    if (instanceChild) {
      // A user edit touches what it changes; syncs, undos, resets and text
      // layout write with ignore-touched and leave touched to set-touched.
      const fields =
        item["ignore-touched"] === true
          ? instanceChild.syncedFields
          : instanceChild.editedFields;
      for (const field of Object.keys(operation.changes)) {
        if (!sameJsonValue(before[field], operation.changes[field])) {
          fields.add(field);
        }
      }
    }
  }
  if (!instanceChild) detachEditedValueBindings(operation, node);
  if (placed && canonicalNode !== undefined) {
    compileImpliedPlacement(operation, canonicalNode, relative, {
      height: placement.height,
      width: placement.width,
    });
  }
  if (projectedOnly) {
    // update-presentation-node cannot write a projected child; its changes
    // wait for compileInstanceOverrides.
    delete operation.changes.touched;
    Object.assign(instanceChild.changes, operation.changes);
    operation.changes = {};
  }
}

// The canonical Instance node a projected child id derives from: the
// longest canonical Instance id it extends with `__` (design-projection
// `prefixedNodeId`), and the override source path that remains.
function owningInstance(snapshot, descriptor) {
  let owner;
  for (const candidate of Object.values(
    presentationNodes(snapshot, descriptor) ?? {},
  )) {
    if (
      candidate.instance &&
      descriptor.nodeId.startsWith(`${candidate.id}__`) &&
      (owner === undefined || candidate.id.length > owner.id.length)
    ) {
      owner = candidate;
    }
  }
  if (!owner) {
    fail(
      "component_instance_override_unsupported",
      "This projected child does not belong to a canonical Instance",
      { instanceNodeId: descriptor.nodeId },
    );
  }
  return { owner, sourcePath: descriptor.nodeId.slice(owner.id.length + 2) };
}

// The projected nodes of a presentation as they would be without any
// override of the given Instance: what Penpot's main component holds, laid
// out at the size and place the commit gives the Instance (a resized copy
// moves and stretches its children by their constraints).
function unoverriddenNodes(snapshot, descriptor, owner, cache, operations = []) {
  const key = `${descriptor.screenId}\0${descriptor.presentationId}\0${owner.id}`;
  if (!cache.has(key)) {
    const entry = snapshot.manifest.entries.screens.find(
      (candidate) => snapshot.entries[candidate].id === descriptor.screenId,
    );
    const screen = structuredClone(snapshot.entries[entry]);
    const presentation = screen.presentations.find(
      ({ id }) => id === descriptor.presentationId,
    );
    delete presentation.nodes[owner.id].instance.overrides;
    for (const operation of operations) {
      if (
        operation.type === "update-presentation-node" &&
        operation.nodeId === owner.id &&
        operation.screenId === descriptor.screenId &&
        operation.presentationId === descriptor.presentationId
      ) {
        for (const field of ["height", "rotation", "width", "x", "y"]) {
          if (Object.hasOwn(operation.changes, field)) {
            presentation.nodes[owner.id][field] = operation.changes[field];
          }
        }
      }
    }
    cache.set(
      key,
      projectedSnapshotNodes(
        { ...snapshot, entries: { ...snapshot.entries, [entry]: screen } },
        descriptor,
      ),
    );
  }
  return cache.get(key);
}

const TEXT_CONTENT_GROUPS = [
  "text-content-attribute",
  "text-content-structure",
  "text-content-text",
];

const GEOMETRY_OVERRIDES = new Set(["width", "height"]);

// The bindings of a copy that differ from its source's: a reference where it
// binds something else, null where it dropped one.
function bindingDiff(source = {}, copy = {}) {
  const diff = {};
  for (const [field, reference] of Object.entries(copy ?? {}))
    if (!sameJsonValue(source?.[field], reference)) diff[field] = reference;
  for (const field of Object.keys(source ?? {}))
    if (!Object.hasOwn(copy ?? {}, field)) diff[field] = null;
  return diff;
}

// Whether Penpot's touched groups keep `field` overridden. A content group
// without any text sub-group (older Penpot) covers text and fills alike; a
// structure change is a change of the text.
function overrideTouched(field, nodeType, touched) {
  const [group, part] = overrideTouchedGroups(field, nodeType);
  if (!touched.has(group)) return false;
  if (part === undefined) return true;
  if (!TEXT_CONTENT_GROUPS.some((candidate) => touched.has(candidate))) {
    return true;
  }
  return (
    touched.has(part) ||
    (field === "text" && touched.has("text-content-structure"))
  );
}

// Compiled text styles leave out Penpot defaults that a source may spell.
function sameChildField(field, current, value) {
  if (field !== "textStyle") return sameNodeField(field, current, value);
  return sameJsonValue(
    textStyleOverrides({ ...DEFAULT_TEXT_STYLE, ...(current ?? {}) }),
    textStyleOverrides({ ...DEFAULT_TEXT_STYLE, ...(value ?? {}) }),
  );
}

// Overrides the format can hold for a node, with the value Penpot leaves when
// it clears one.
function overrideValue(field, value, node) {
  if (value !== null && value !== undefined) return value;
  if (field === "fills") {
    return node.type === "TEXT" ? structuredClone(DEFAULT_TEXT_FILLS) : [];
  }
  return NODE_FIELD_DEFAULTS.get(field);
}

// Turns the accumulated edits of each projected instance child into
// set-/clear-instance-override operations on its canonical Instance. Penpot
// marks what a copy overrides with touched groups: a user edit touches the
// groups it changes, set-touched replaces them (nil on Reset overrides), and
// every changed value must then be what the source plus the remaining
// overrides project. Anything else (geometry, strokes, rich text runs) has
// no override in the format and fails explicitly.
function compileInstanceOverrides(snapshot, updateStatesByNode, operations) {
  const cache = new Map();
  for (const { instanceChild: child } of updateStatesByNode.values()) {
    if (!child) continue;
    const { descriptor, editedFields, node } = child;
    // Without set-touched in the commit, ignore-touched writes are Penpot's
    // component sync of an untouched copy: the projection derives them from
    // the source, so they are not overrides. An undo or Reset overrides
    // always sets the touched groups along with its values.
    const changes =
      child.touched === undefined
        ? Object.fromEntries(
            Object.entries(child.changes).filter(
              ([field]) =>
                editedFields.has(field) || !child.syncedFields.has(field),
            ),
          )
        : child.changes;
    const changedFields = Object.keys(changes).filter(
      (field) => !sameChildField(field, node[field], changes[field]),
    );
    if (changedFields.length === 0 && child.touched === undefined) continue;
    const { owner, sourcePath } = owningInstance(snapshot, descriptor);
    const current = {};
    for (const [overridePath, value] of Object.entries(
      owner.instance.overrides ?? {},
    )) {
      if (overridePath.startsWith(`${sourcePath}:`)) {
        current[overridePath.slice(sourcePath.length + 1)] = value;
      }
    }
    const touched = new Set(
      child.touched ??
        Object.keys(current).flatMap((field) =>
          overrideTouchedGroups(field, node.type, current[field]),
        ),
    );
    const edited = new Set(
      [...editedFields].filter(
        (field) =>
          INSTANCE_OVERRIDE_FIELDS.has(field) && changedFields.includes(field),
      ),
    );
    for (const field of edited) {
      for (const group of overrideTouchedGroups(field, node.type, changes[field])) {
        touched.add(group);
      }
    }
    const base = unoverriddenNodes(snapshot, descriptor, owner, cache, operations)[
      descriptor.nodeId
    ];
    const next = {};
    // The copy's own Token bindings: what differs from its source, a
    // reference per field or null where it dropped the source's binding.
    // A value edited by hand stops following its Token, as in Penpot.
    const ownBindings = Object.hasOwn(changes, "tokenBindings")
      ? bindingDiff(base.tokenBindings, changes.tokenBindings)
      : { ...(current.tokenBindings ?? {}) };
    for (const field of edited)
      for (const binding of Object.keys(ownBindings))
        if (field !== "tokenBindings" && bindingTargetField(binding) === field && !Object.hasOwn(changes, "tokenBindings"))
          delete ownBindings[binding];
    if (Object.keys(ownBindings).length) next.tokenBindings = ownBindings;
    for (const field of INSTANCE_OVERRIDE_FIELDS) {
      if (field === "tokenBindings" || field === "variant") continue;
      if (!overrideTouched(field, node.type, touched)) continue;
      if (Object.hasOwn(changes, field)) {
        // A touched group can cover more than one field (a TEXT node's
        // content holds text and fills). An undo or sync that writes the
        // source value back leaves no override; a user edit always does.
        // Geometry is laid out again on every projection (constraints
        // stretch a copy's children): only a size the projection would not
        // give is the copy's own.
        if (GEOMETRY_OVERRIDES.has(field)) {
          if (!sameChildField(field, base[field], changes[field])) next[field] = changes[field];
        } else if (
          edited.has(field) ||
          !sameChildField(field, base[field], changes[field])
        ) {
          next[field] = overrideValue(field, changes[field], node);
        }
      } else if (Object.hasOwn(current, field)) {
        next[field] = current[field];
      }
    }
    const expected = applyNodeOverrides(structuredClone(base), next);
    // An auto-sized text grows or shrinks with its override; Penpot reports
    // that measured box without touching it. The source box stays canonical
    // and the projection hands it back for Penpot to measure again.
    const measured =
      node.type === "TEXT" &&
      (node.growType === "auto-width" || node.growType === "auto-height");
    const fields = Object.keys(changes).filter(
      (field) =>
        !sameChildField(field, expected[field], changes[field]) &&
        !(
          measured &&
          PENPOT_GEOMETRY_ATTRIBUTES.has(field) &&
          child.syncedFields.has(field) &&
          !editedFields.has(field)
        ),
    );
    if (fields.length > 0) {
      fail(
        "component_instance_override_unsupported",
        "Edit the Component source before changing these fields of a projected child; Instance overrides hold what Penpot lets a copy change: fill, stroke, text and its style, size, radius, shadow, opacity, name, visibility and Token bindings",
        { fields, instanceNodeId: descriptor.nodeId },
      );
    }
    const target = {
      nodeId: owner.id,
      presentationId: descriptor.presentationId,
      screenId: descriptor.screenId,
    };
    for (const field of INSTANCE_OVERRIDE_FIELDS) {
      if (field === "variant") continue;
      const overridePath = `${sourcePath}:${field}`;
      if (Object.hasOwn(next, field)) {
        if (
          !Object.hasOwn(current, field) ||
          !sameJsonValue(current[field], next[field])
        ) {
          operations.push({
            ...target,
            overridePath,
            type: "set-instance-override",
            value: next[field],
          });
        }
      } else if (Object.hasOwn(current, field)) {
        operations.push({
          ...target,
          overridePath,
          type: "clear-instance-override",
        });
      }
    }
  }
}

// Canonical node field defaults: an absent field and its default value are
// the same node.
const NODE_FIELD_DEFAULTS = new Map([
  ["flipX", false],
  ["flipY", false],
  ["locked", false],
  ["opacity", 1],
  ["proportionLock", false],
  ["rotation", 0],
  ["visible", true],
]);

function sameJsonValue(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameJsonValue(item, right[index]))
    );
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const keys = Object.keys(left).filter((key) => left[key] !== undefined);
    return (
      keys.length ===
        Object.keys(right).filter((key) => right[key] !== undefined).length &&
      keys.every((key) => sameJsonValue(left[key], right[key]))
    );
  }
  return left === right;
}

function sameNodeField(field, current, value) {
  const fallback = NODE_FIELD_DEFAULTS.get(field);
  const left = current === undefined || current === null ? fallback : current;
  const right = value === null ? fallback : value;
  // One radius is the same as four equal corners.
  if (field === "cornerRadius") return sameJsonValue(cornerRadii(left ?? 0), cornerRadii(right ?? 0));
  return sameJsonValue(left, right);
}

function projectedPresentationNodes(snapshot, descriptor, projections) {
  projectedNode(snapshot, descriptor, projections);
  return projections.get(`${descriptor.screenId}\0${descriptor.presentationId}`);
}

// The placement Penpot holds for a node of the projected tree once the
// commit applies: canonical nodes as runtimeAbsolutePlacement sees them,
// derived instance children composed through the projection.
function projectedAbsolutePlacement(snapshot, page, nodes, nodeId, geometry) {
  const runtimeId =
    snapshot.runtime.nodes?.[page.screenId]?.[page.presentationId]?.[nodeId];
  if (presentationNodes(snapshot, page)?.[nodeId] && runtimeId !== undefined) {
    return runtimeAbsolutePlacement(snapshot, page, runtimeId, geometry);
  }
  const baseline = canonicalTreePlacement(nodes, nodeId) ?? ROOT_PLACEMENT;
  const provided =
    (runtimeId === undefined
      ? undefined
      : geometry.values.get(String(runtimeId))) ??
    sessionGeometry(snapshot, page, nodeId, geometry);
  return provided
    ? penpotPlacement(provided, baseline, nodes[nodeId]?.type === "PATH")
    : baseline;
}

// The children of a copy dropped in this session keep the runtime ids
// Penpot gave them (projectedRuntimeIds), not the ids the projection
// derives, so their geometry arrives under those ids.
function sessionGeometry(snapshot, page, nodeId, geometry) {
  for (const [runtimeId, descriptor] of Object.entries(
    snapshot.runtime.reverseNodes ?? {},
  )) {
    if (
      descriptor.nodeId === nodeId &&
      descriptor.screenId === page.screenId &&
      descriptor.presentationId === page.presentationId &&
      geometry.values.has(runtimeId)
    ) {
      return geometry.values.get(runtimeId);
    }
  }
  return undefined;
}

// A Penpot edit sends only the absolute attributes it touched, but inside a
// turned parent one absolute move changes both canonical x and y, and a
// path's new selrect moves and resizes its box: store every relative field
// that now differs and that the edit did not set itself.
function compileImpliedPlacement(operation, node, relative, size) {
  const implied = [
    ["x", "x", relative.x, node.x ?? 0],
    ["y", "y", relative.y, node.y ?? 0],
    ["rotation", "rotation", relative.rotation, node.rotation ?? 0],
    ["flipX", "flip-x", relative.flipX, node.flipX === true],
    ["flipY", "flip-y", relative.flipY, node.flipY === true],
  ];
  if (node.type === "PATH") {
    implied.push(
      ["width", "width", size.width, node.width],
      ["height", "height", size.height, node.height],
    );
  }
  for (const [field, attr, value, current] of implied) {
    if (Object.hasOwn(operation.changes, field) || value === current) continue;
    compileAttribute(
      operation,
      attr,
      typeof value === "number" ? canonicalNumber(value) : value,
      { ...node, ...operation.changes },
    );
  }
}

function validateNodeUpdateStates(updateStatesByNode) {
  for (const updateState of updateStatesByNode.values()) {
    const {
      changesGeometry,
      changesProportionLock,
      changesText,
      changesTransform,
      derivedAttributes,
    } = updateState;
    const textLayoutOnly =
      derivedAttributes.length > 0 &&
      derivedAttributes.every((attribute) => attribute === "position-data");
    if (
      derivedAttributes.length > 0 &&
      !textLayoutOnly &&
      !changesGeometry &&
      !(
        changesProportionLock &&
        derivedAttributes.every((attribute) => attribute === "proportion")
      ) &&
      !changesText &&
      !changesTransform
    ) {
      fail(
        "unsupported_penpot_derived_attribute",
        "Penpot derived geometry requires a supported completed geometry edit",
        { attributes: derivedAttributes },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// DSE-004/005/006: the generated Design System page and the Components page
// project real source content (Token Cell specimens, component variant
// trees). Native edits on those shapes are translated back to their source:
//   - token-cell specimens  -> set-token-value on the owning Token Cell
//   - component node shapes -> update-component-node on the variant node
// Generated decorations (board, label, specimen fillers) and auto-layout
// geometry are presentation-only and are rejected with precise codes so the
// client rolls its optimistic state back instead of storing a generated
// page into the Package.
// ---------------------------------------------------------------------------

function penpotRgbaToHex(value) {
  if (typeof value === "string" && value.startsWith("#")) return value;
  if (!isRecord(value)) return undefined;
  const channel = (input) => {
    const number = Number(input);
    if (!Number.isFinite(number)) return 0;
    const scaled = number <= 1 ? number * 255 : number;
    return Math.max(0, Math.min(255, Math.round(scaled)));
  };
  const hex = (input) => channel(input).toString(16).padStart(2, "0");
  const alpha = value.a === undefined ? 1 : Number(value.a);
  const color = `#${hex(value.r)}${hex(value.g)}${hex(value.b)}`;
  return alpha >= 1 ? color : `${color}${hex(alpha * 255)}`;
}

// Native shadow color attrs ({color: "#hex", opacity: 0..1}) -> the DTCG
// literal stored in the Cell: "#rrggbb", or "#rrggbbaa" when translucent.
function penpotShadowColorToCell(color) {
  if (!isRecord(color)) return undefined;
  const hex = typeof color.color === "string" ? color.color : undefined;
  const opacity = color.opacity === undefined ? 1 : Number(color.opacity);
  if (hex === undefined || !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex)) {
    return undefined;
  }
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
    return undefined;
  }
  const full =
    hex.length === 4
      ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
      : hex;
  if (opacity >= 1) return full;
  const alpha = Math.max(0, Math.min(255, Math.round(opacity * 255)));
  return `${full}${alpha.toString(16).padStart(2, "0")}`;
}

function penpotShadowToCell(value) {
  const single = Array.isArray(value) ? value[0] : value;
  if (!isRecord(single)) {
    fail("invalid_penpot_effect", "Penpot shadow must be an object", { value });
  }
  // The native effects panel keeps :shadow as a vector of full shadow
  // records (id/style/hidden/color attrs), but a Token Cell only holds the
  // DTCG drop-shadow literal; other styles are not representable.
  const style = normalizeType(single.style);
  if (style !== undefined && style !== "drop-shadow") {
    fail(
      "design_system_unsupported_attribute",
      `Penpot shadow style is not representable in a Token Cell: ${String(single.style)}`,
      { style: String(single.style) },
    );
  }
  const color = penpotShadowColorToCell(single.color);
  if (color === undefined) {
    fail("invalid_penpot_effect", "Penpot shadow color must be a hex color with opacity", {
      color: single.color,
    });
  }
  const blur = Number(single.blur ?? 0);
  const offsetX = Number(single["offset-x"] ?? single.offsetX ?? 0);
  const offsetY = Number(single["offset-y"] ?? single.offsetY ?? 0);
  const spread = Number(single.spread ?? 0);
  if (
    ![blur, offsetX, offsetY, spread].every((number) =>
      Number.isFinite(number),
    )
  ) {
    fail("invalid_penpot_effect", "Penpot shadow geometry needs finite numbers", {
      value,
    });
  }
  return { blur, color, offsetX, offsetY, spread };
}

function sameShadowCell(cellValue, other) {
  return (
    isRecord(cellValue) &&
    Number(cellValue.blur) === other.blur &&
    Number(cellValue.offsetX) === other.offsetX &&
    Number(cellValue.offsetY) === other.offsetY &&
    Number(cellValue.spread) === other.spread &&
    typeof cellValue.color === "string" &&
    cellValue.color.toLowerCase() === other.color.toLowerCase()
  );
}

// Presentation-state attributes a Token Cell shape never binds.
const TOKEN_CELL_PRESENTATION_ATTRIBUTES = new Set([
  "x",
  "y",
  "points",
  "selrect",
  "position-data",
]);

// Attributes a Token Cell specimen can bind (write through to the Cell).
// DSE-R19~R24: every canonical type binds its natural native attribute (or
// the scalar value/content path), so all 20 types have a real write route.
const TOKEN_CELL_BOUND_ATTRIBUTES = new Set([
  "fills",
  "fill-color",
  "r1",
  "r2",
  "r3",
  "r4",
  "height",
  "width",
  "layout-gap",
  "strokes",
  "stroke-width",
  "shadow",
  "opacity",
  "rotation",
  "font-size",
  "letter-spacing",
  "font-family",
  "font-weight",
  "text-transform",
  "text-decoration",
  "content",
  "token-value",
]);

// DSE-R24: parse a scalar Cell literal from its value-card text (or the
// Token inspector input). `type` selects the accepted syntax; anything else
// fails with a precise code BEFORE any write happens.
function parseScalarTokenValue(type, raw) {
  if (typeof raw !== "string") return raw;
  const text = raw.trim();
  switch (type) {
    case "boolean":
      if (text === "true" || text === "false") return text === "true";
      fail(
        "design_system_token_value_invalid",
        `Boolean Token Cell needs "true" or "false": ${JSON.stringify(raw)}`,
        { type, value: raw },
      );
      return undefined;
    case "number": {
      const parsed = Number(text);
      if (text.length > 0 && Number.isFinite(parsed)) return parsed;
      fail(
        "design_system_token_value_invalid",
        `Number Token Cell needs a finite number: ${JSON.stringify(raw)}`,
        { type, value: raw },
      );
      return undefined;
    }
    case "string":
      return raw;
    case "other":
      // Canonical `other` Cells hold a STRING (commonly JSON-as-text), so
      // the edit is validated as parseable JSON but stored verbatim —
      // reformatting the author's text would be a silent rewrite.
      try {
        JSON.parse(text);
      } catch {
        fail(
          "design_system_token_value_invalid",
          "Other Token Cell needs valid JSON",
          { type, value: raw },
        );
        return undefined;
      }
      return raw;
    default:
      return raw;
  }
}

// DSE-R24/R26: validate a complete Cell value (literal or "{ref}" alias
// expression) against its type. The Token inspector edits alias Cells by
// rewriting the expression, so "{...}" values are legal for every type.
function validatedTokenValue(ref, raw) {
  if (typeof raw === "string" && /^\{[^{}]+\}$/.test(raw.trim())) {
    return raw.trim();
  }
  switch (ref.type) {
    case "typography":
    case "shadow":
      if (!isRecord(raw)) {
        fail(
          "design_system_token_value_invalid",
          `${ref.type} Token Cell needs a ${ref.type} record`,
          { type: ref.type, value: raw },
        );
      }
      return raw;
    case "boolean":
    case "number":
    case "string":
    case "other":
      return parseScalarTokenValue(ref.type, raw);
    case "dimensions":
    case "sizing":
    case "spacing":
    case "stroke-width":
    case "border-radius":
    case "font-size":
    case "letter-spacing":
    case "opacity":
    case "rotation": {
      const parsed = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(parsed)) {
        fail(
          "design_system_token_value_invalid",
          `${ref.type} Token Cell needs a finite number: ${JSON.stringify(raw)}`,
          { type: ref.type, value: raw },
        );
      }
      return parsed;
    }
    default:
      if (raw === undefined || raw === null) {
        fail(
          "design_system_token_value_invalid",
          `Token Cell ${ref.path} needs a value`,
          { type: ref.type },
        );
      }
      return raw;
  }
}

// DSE-R24: pull the plain text out of native text content ({:type "root"}
// → paragraph-set → paragraphs → runs) so scalar value cards can parse the
// user's edit.
function extractTextContent(value) {
  const collect = (node, acc) => {
    if (typeof node === "string") {
      acc.push(node);
      return acc;
    }
    if (!isRecord(node)) return acc;
    if (typeof node.text === "string") {
      acc.push(node.text);
    }
    for (const child of Array.isArray(node.children) ? node.children : []) {
      collect(child, acc);
    }
    return acc;
  };
  return collect(value, []).join("");
}

// A Product's Design System page shows its Foundation's Token Cells; they
// belong to the Foundation and are edited there.
function foundationTokenReadOnly(snapshot, ref) {
  const owner = snapshot.libraries.find(
    (library) => library.manifest.packageId === ref.ownerPackageId,
  );
  fail(
    "foundation_tokens_read_only",
    `Token ${ref.path} belongs to the Foundation ${owner?.manifest.name ?? ref.ownerPackageId} and is read-only in this Product; edit it in the Foundation`,
    { foundationPackageId: ref.ownerPackageId, tokenId: ref.tokenId },
  );
}

function tokenCellUpdate(snapshot, ref, change, operationsByToken) {
  if (ref.readOnly === true) foundationTokenReadOnly(snapshot, ref);
  const key = String(ref.tokenId);
  let operation = operationsByToken.get(key);
  if (!operation) {
    operation = { tokenId: ref.tokenId, path: ref.path, type: "set-token-value" };
    operationsByToken.set(key, operation);
  }
  for (const item of change.operations ?? []) {
    if (!isRecord(item)) {
      fail("unsupported_penpot_operation", `Phase 0 cannot compile Penpot operation: ${String(item?.type)}`);
    }
    const itemType = normalizeType(item.type);
    if (itemType === "set-touched" || itemType === "set-remote-synced") {
      continue;
    }
    const attr = normalizeType(item.attr);
    if (itemType === "unset") {
      fail(
        "design_system_unsupported_attribute",
        `Token Cell ${ref.path} cannot clear ${attr}; edit the Cell value instead`,
        { attr, tokenId: ref.tokenId },
      );
    }
    if (!PENPOT_WRITE.operationTypes.includes(itemType)) {
      fail("unsupported_penpot_operation", `Phase 0 cannot compile Penpot operation: ${String(item?.type)}`);
    }
    switch (attr) {
      case "fills": {
        if (ref.attribute !== "fill") {
          fail("design_system_unsupported_attribute", `Token Cell ${ref.path} does not bind a fill color`, { attr });
        }
        // The color picker rewrites the whole fills array; a Token Cell
        // specimen binds the first solid fill's color.
        const solid = (Array.isArray(item.val) ? item.val : [item.val]).find(
          (fill) => isRecord(fill) && fill["fill-color"] !== undefined,
        );
        const hex = solid === undefined ? undefined : penpotRgbaToHex(solid["fill-color"]);
        if (typeof hex !== "string" || !hex.startsWith("#")) {
          fail("invalid_penpot_fill", "Token Cell fill must be a solid color", { value: item.val });
        }
        const opacity = solid["fill-opacity"];
        if (opacity !== undefined && opacity !== 1) {
          fail(
            "design_system_token_opacity_unsupported",
            `Token Cell ${ref.path} keeps its own opacity; edit the Cell color value`,
            { tokenId: ref.tokenId, value: opacity },
          );
        }
        operation.value = hex;
        break;
      }
      case "fill-color": {
        if (ref.attribute !== "fill") {
          fail("design_system_unsupported_attribute", `Token Cell ${ref.path} does not bind fill color`, { attr });
        }
        const hex = penpotRgbaToHex(item.val);
        if (typeof hex !== "string" || !hex.startsWith("#")) {
          fail("invalid_penpot_fill", "Token Cell fill must be a solid color", { value: item.val });
        }
        operation.value = hex;
        break;
      }
      case "fill-opacity": {
        if (item.val === 1 || item.val === undefined) break;
        fail(
          "design_system_token_opacity_unsupported",
          `Token Cell ${ref.path} keeps its own opacity; edit the Cell color value`,
          { tokenId: ref.tokenId, value: item.val },
        );
        break;
      }
      case "r1":
      case "r2":
      case "r3":
      case "r4": {
        if (ref.attribute !== "radius") {
          fail("design_system_unsupported_attribute", `Token Cell ${ref.path} does not bind corner radius`, { attr });
        }
        if (typeof item.val !== "number" || !Number.isFinite(item.val) || item.val < 0) {
          fail("invalid_corner_radius", "Radius Token Cell needs a finite non-negative value", { value: item.val });
        }
        operation.value = item.val;
        break;
      }
      case "height":
      case "width": {
        if (ref.attribute === "dimensions") {
          // DSE-R21: a dimensions Cell drives BOTH box dimensions; the two
          // native fields bind the same single value. Same-value edits in
          // one batch collapse to one write, differing values are ambiguous
          // and rejected without writes.
          if (typeof item.val !== "number" || !Number.isFinite(item.val)) {
            fail("invalid_node_number", "Dimensions Token Cell needs a finite number", { value: item.val });
          }
          if (
            operation.value !== undefined &&
            Number(operation.value) !== item.val
          ) {
            fail(
              "design_system_unsupported_attribute",
              `Token Cell ${ref.path} binds one dimension value; width and height must match`,
              { value: item.val },
            );
          }
          operation.value = item.val;
          break;
        }
        if (ref.attribute !== "height") {
          fail("design_system_unsupported_attribute", `Token Cell ${ref.path} does not bind size`, { attr });
        }
        if (typeof item.val !== "number" || !Number.isFinite(item.val)) {
          fail("invalid_node_number", "Size Token Cell needs a finite number", { value: item.val });
        }
        operation.value = item.val;
        break;
      }
      case "layout-gap": {
        if (ref.attribute !== "gap") {
          fail("design_system_unsupported_attribute", `Token Cell ${ref.path} does not bind spacing`, { attr });
        }
        // Penpot writes row-gap/column-gap; older specimens held camelCase.
        const rowGap = item.val?.["row-gap"] ?? item.val?.rowGap;
        const columnGap = item.val?.["column-gap"] ?? item.val?.columnGap;
        if (!Number.isFinite(rowGap) || !Number.isFinite(columnGap)) {
          fail("invalid_penpot_layout", "Spacing Token Cell needs numeric gaps", { value: item.val });
        }
        if (rowGap !== columnGap) {
          fail(
            "design_system_unsupported_attribute",
            `Token Cell ${ref.path} binds one spacing value; row and column gap must match`,
            { value: item.val },
          );
        }
        operation.value = rowGap;
        break;
      }
      case "stroke-width": {
        if (ref.attribute !== "stroke-width") {
          fail("design_system_unsupported_attribute", `Token Cell ${ref.path} does not bind stroke width`, { attr });
        }
        if (typeof item.val !== "number" || !Number.isFinite(item.val) || item.val < 0) {
          fail("invalid_penpot_stroke", "Stroke width Token Cell needs a finite non-negative number", { value: item.val });
        }
        operation.value = item.val;
        break;
      }
      case "strokes": {
        if (ref.attribute !== "stroke-width") {
          fail("design_system_unsupported_attribute", `Token Cell ${ref.path} does not bind strokes`, { attr });
        }
        // The native strokes panel rewrites the whole :strokes vector; the
        // Cell binds exactly one stroke's width, so anything else (multiple
        // strokes, deletions) has no unambiguous target.
        if (
          !Array.isArray(item.val) ||
          item.val.length !== 1 ||
          !isRecord(item.val[0])
        ) {
          fail(
            "design_system_unsupported_attribute",
            `Token Cell ${ref.path} binds a single stroke width; only a one-stroke edit can be mapped`,
            { attr, count: Array.isArray(item.val) ? item.val.length : undefined },
          );
        }
        const width = item.val[0]["stroke-width"];
        if (typeof width !== "number" || !Number.isFinite(width) || width < 0) {
          fail("invalid_penpot_stroke", "Stroke width Token Cell needs a finite non-negative number", { value: width });
        }
        // The Cell binds only the width: a restyle of unbound fields (color,
        // opacity, alignment) leaves the width unchanged and must not write.
        if (ref.value === width) break;
        operation.value = width;
        break;
      }
      case "shadow": {
        if (ref.attribute !== "shadow") {
          fail("design_system_unsupported_attribute", `Token Cell ${ref.path} does not bind an effect`, { attr });
        }
        // The native effects panel keeps :shadow as a vector; the specimen
        // binds exactly one effect.
        if (Array.isArray(item.val) && item.val.length === 0) {
          fail("invalid_penpot_effect", "Penpot shadow edit removed every effect; clear the Cell value instead", { value: item.val });
        }
        const shadows = Array.isArray(item.val) ? item.val : [item.val];
        if (shadows.length !== 1) {
          fail(
            "design_system_unsupported_attribute",
            `Token Cell ${ref.path} binds one effect; only a single shadow can be mapped`,
            { attr, count: shadows.length },
          );
        }
        const cellValue = penpotShadowToCell(shadows[0]);
        // Visibility/ordering restyles that keep the literal value compile
        // to no write at all.
        if (sameShadowCell(ref.value, cellValue)) break;
        operation.value = cellValue;
        break;
      }
      case "opacity": {
        if (ref.attribute !== "opacity") {
          fail("design_system_unsupported_attribute", `Token Cell ${ref.path} does not bind opacity`, { attr });
        }
        // Native shape opacity is 0..100 percent; a Token Cell keeps 0..1.
        const raw = Number(item.val);
        if (!Number.isFinite(raw) || raw < 0 || raw > 100) {
          fail("invalid_node_number", "Opacity Token Cell needs a number between 0 and 100", { value: item.val });
        }
        operation.value = raw > 1 ? Math.round(raw) / 100 : raw;
        break;
      }
      case "rotation": {
        if (ref.attribute !== "rotation") {
          fail("design_system_unsupported_attribute", `Token Cell ${ref.path} does not bind rotation`, { attr });
        }
        // Degrees are kept verbatim: negative angles and values beyond a
        // full turn are legal Cell values (DSE-R23 boundary display).
        if (typeof item.val !== "number" || !Number.isFinite(item.val)) {
          fail("invalid_node_number", "Rotation Token Cell needs a finite number of degrees", { value: item.val });
        }
        operation.value = item.val;
        break;
      }
      case "font-size": {
        if (ref.attribute !== "font-size" && ref.attribute !== "typography") {
          fail("design_system_unsupported_attribute", `Token Cell ${ref.path} does not bind font size`, { attr });
        }
        if (typeof item.val !== "number" || !Number.isFinite(item.val) || item.val <= 0) {
          fail("invalid_node_number", "Font size needs a positive finite number", { value: item.val });
        }
        if (ref.attribute === "typography") {
          operation.value = { ...(ref.value ?? {}), fontSize: item.val };
        } else {
          operation.value = item.val;
        }
        break;
      }
      case "letter-spacing": {
        if (ref.attribute !== "letter-spacing" && ref.attribute !== "typography") {
          fail("design_system_unsupported_attribute", `Token Cell ${ref.path} does not bind letter spacing`, { attr });
        }
        if (typeof item.val !== "number" || !Number.isFinite(item.val)) {
          fail("invalid_node_number", "Letter spacing needs a finite number", { value: item.val });
        }
        if (ref.attribute === "typography") {
          operation.value = { ...(ref.value ?? {}), letterSpacing: item.val };
        } else {
          operation.value = item.val;
        }
        break;
      }
      case "font-family": {
        if (ref.attribute !== "font-family" && ref.attribute !== "typography") {
          fail("design_system_unsupported_attribute", `Token Cell ${ref.path} does not bind a font family`, { attr });
        }
        if (typeof item.val !== "string" || item.val.trim().length === 0) {
          fail("design_system_token_value_invalid", "Font family needs a non-empty name", { value: item.val });
        }
        if (ref.attribute === "typography") {
          operation.value = { ...(ref.value ?? {}), fontFamily: item.val, fontId: undefined };
        } else {
          operation.value = item.val;
        }
        break;
      }
      case "font-weight": {
        if (ref.attribute !== "font-weight" && ref.attribute !== "typography") {
          fail("design_system_unsupported_attribute", `Token Cell ${ref.path} does not bind a font weight`, { attr });
        }
        // Native font variants may arrive as variant ids; a Cell keeps the
        // numeric weight when the value is numeric, otherwise the raw name.
        const weight =
          typeof item.val === "number"
            ? item.val
            : Number.isFinite(Number(item.val)) && String(item.val).trim() !== ""
              ? Number(item.val)
              : item.val;
        if (weight === undefined || weight === null || weight === "") {
          fail("design_system_token_value_invalid", "Font weight needs a value", { value: item.val });
        }
        if (ref.attribute === "typography") {
          operation.value = { ...(ref.value ?? {}), fontWeight: weight };
        } else {
          operation.value = weight;
        }
        break;
      }
      case "text-transform": {
        if (ref.attribute !== "text-transform" && ref.attribute !== "typography") {
          fail("design_system_unsupported_attribute", `Token Cell ${ref.path} does not bind text case`, { attr });
        }
        const allowedCase = ["none", "uppercase", "lowercase", "title-case"];
        if (!allowedCase.includes(item.val)) {
          fail(
            "design_system_token_value_invalid",
            `Text case must be one of ${allowedCase.join(", ")}`,
            { value: item.val },
          );
        }
        if (ref.attribute === "typography") {
          operation.value = { ...(ref.value ?? {}), textCase: item.val };
        } else {
          operation.value = item.val;
        }
        break;
      }
      case "text-decoration": {
        if (ref.attribute !== "text-decoration" && ref.attribute !== "typography") {
          fail("design_system_unsupported_attribute", `Token Cell ${ref.path} does not bind text decoration`, { attr });
        }
        const allowedDecoration = ["none", "underline", "line-through"];
        if (!allowedDecoration.includes(item.val)) {
          fail(
            "design_system_token_value_invalid",
            `Text decoration must be one of ${allowedDecoration.join(", ")}`,
            { value: item.val },
          );
        }
        if (ref.attribute === "typography") {
          operation.value = { ...(ref.value ?? {}), textDecoration: item.val };
        } else {
          operation.value = item.val;
        }
        break;
      }
      case "line-height": {
        if (ref.attribute !== "typography") {
          fail("design_system_unsupported_attribute", `Token Cell ${ref.path} does not bind line height`, { attr });
        }
        // Native line height is a record ({type, value}); the Cell keeps the
        // unitless number.
        const lh =
          isRecord(item.val) ? Number(item.val.value) : Number(item.val);
        if (!Number.isFinite(lh) || lh <= 0) {
          fail("invalid_node_number", "Line height needs a positive finite number", { value: item.val });
        }
        operation.value = { ...(ref.value ?? {}), lineHeight: lh };
        break;
      }
      case "content": {
        // DSE-R24: scalar value cards are native TEXT shapes; editing the
        // text rewrites the Cell literal (string verbatim, boolean/number/
        // other parsed+validated). Typography displays keep their fixed
        // "Ag" glyph text — editing it is not a Cell edit.
        if (ref.attribute !== "value") {
          fail(
            "design_system_unsupported_attribute",
            `Token Cell ${ref.path} does not bind display text; edit the Cell value instead`,
            { attr },
          );
        }
        const text = extractTextContent(item.val);
        operation.value = parseScalarTokenValue(ref.type, text);
        break;
      }
      case "token-value": {
        // DSE-R26: the Token inspector rewrites the whole Cell value —
        // literal or "{ref}" alias expression — explicitly distinguished
        // from attribute edits. Legal on alias Cells (that is HOW their
        // expression changes) and on every literal Cell.
        operation.value = validatedTokenValue(ref, item.val);
        break;
      }
      case "name":
        fail("design_system_decoration", "Specimen names are presentation state and follow the Token Cell", {
          tokenId: ref.tokenId,
        });
        break;
      case "x":
      case "y":
      case "points":
      case "selrect":
      case "position-data": {
        // Position and derived geometry are presentation state on the
        // auto-arranged board. A PURE position edit stays rejected; such an
        // op riding along with a bound-field edit (e.g. a height resize
        // recompute) is dropped.
        const hasBoundEdit = (change.operations ?? []).some((op) => {
          if (!isRecord(op) || normalizeType(op.type) !== "set") return false;
          const boundAttr = normalizeType(op.attr);
          return (
            !TOKEN_CELL_PRESENTATION_ATTRIBUTES.has(boundAttr) &&
            TOKEN_CELL_BOUND_ATTRIBUTES.has(boundAttr)
          );
        });
        if (!hasBoundEdit) {
          fail(
            "design_system_layout_locked",
            "The Design System board is auto-arranged; object positions are presentation state",
            { attr },
          );
        }
        break;
      }
      default:
        fail(
          "design_system_unsupported_attribute",
          `Phase 0 cannot map Penpot attribute ${attr} to a Token Cell`,
          { attr, tokenId: ref.tokenId },
        );
    }
  }
}

function componentSetWithVariant(snapshot, componentSetId, variantId) {
  for (const entry of snapshot.manifest.entries.components) {
    const value = snapshot.entries[entry];
    const sets = Array.isArray(value?.componentSets) ? value.componentSets : [value];
    const set = sets.find((candidate) => candidate?.id === componentSetId);
    if (!set) continue;
    const variant = (set.variants ?? []).find((candidate) => candidate?.id === variantId);
    if (variant) return { entry, set, variant };
  }
  fail("missing_component", `SmallPen Component variant does not exist: ${componentSetId}/${variantId}`);
}

const COMPONENT_NODE_UNSET_FIELDS = new Map([
  ["grow-type", "growType"],
  ["hidden", "visible"],
  ["proportion-lock", "proportionLock"],
]);

function componentNodeUpdate(
  snapshot,
  descriptor,
  change,
  operations,
  operationsByNode,
  operationsByToken,
) {
  const { componentId, nodeId, variantId } = descriptor;
  const { variant } = componentSetWithVariant(snapshot, componentId, variantId);
  const sourceNode = variant.nodes?.[nodeId];
  const combination = snapshot.runtime.designSystemRefs?.combinations?.find(
    (item) => item.id === descriptor.combinationId,
  );
  const view = componentCombinationSnapshot(snapshot, combination);
  const sample = snapshot.runtime.designSystemRefs?.componentSamples?.find(
    (item) => item.componentSetId === componentId && item.variantId === variantId && item.combinationId === descriptor.combinationId,
  );
  const canonicalNode = descriptor.occurrencePath
    ? sample?.nodes[descriptor.displayNodeId]
    : sourceNode && applyEffectiveTokenBindings(sourceNode, view, { libraries: snapshot.libraries });
  if (!canonicalNode) {
    fail("missing_node", `Variant Node does not exist: ${nodeId}`);
  }
  const key = `${componentId}\0${variantId}\0${nodeId}`;
  let operation = operationsByNode.get(key);
  if (!operation) {
    operation = {
      changes: {},
      componentId,
      nodeId,
      type: "update-component-node",
      unset: [],
      variantId,
    };
    operationsByNode.set(key, operation);
    operations.push(operation);
  }
  // Variant geometry is relative to the parent's full transform inside the
  // variant tree, like screen nodes; turns, flips and path content convert
  // against the composed tree (x/y stay locked below).
  const variantNodes = { ...variant.nodes, [nodeId]: canonicalNode };
  const parentNodeId = canonicalParentIndex(variantNodes).get(nodeId);
  // On the Components page the parent may move in the same commit (the
  // main is dragged or reflowed): variants.mjs passes its final placement.
  const parentPlacement =
    snapshot.variantParentPlacements?.get(String(change.id)) ??
    ((parentNodeId && canonicalTreePlacement(variantNodes, parentNodeId)) ||
      ROOT_PLACEMENT);
  const provided = {};
  for (const item of change.operations ?? []) {
    const itemAttr = normalizeType(item?.attr);
    if (normalizeType(item?.type) === "set" && PLACEMENT_ATTRIBUTES.has(itemAttr)) {
      provided[itemAttr] = item.val;
    }
  }
  // The layer as Penpot holds it now (Components page) completes what the
  // change leaves out; else its canonical place.
  const current = change["smallpen-parent"]?.child;
  const placement = penpotPlacement(
    provided,
    isRecord(current) && Object.keys(current).length > 0
      ? penpotPlacement(current, ROOT_PLACEMENT, canonicalNode.type === "PATH")
      : (canonicalTreePlacement(variantNodes, nodeId) ?? ROOT_PLACEMENT),
    canonicalNode.type === "PATH",
  );
  const relative = relativePlacement(parentPlacement, placement, [
    penpotRelativeFlips(parentPlacement, placement),
    { flipX: canonicalNode.flipX === true, flipY: canonicalNode.flipY === true },
  ]);
  const relativeValues = {
    "flip-x": relative.flipX,
    "flip-y": relative.flipY,
    rotation: relative.rotation,
  };
  for (const item of change.operations ?? []) {
    if (!isRecord(item)) {
      fail("unsupported_penpot_operation", `Phase 0 cannot compile Penpot operation: ${String(item?.type)}`);
    }
    const itemType = normalizeType(item.type);
    if (!PENPOT_WRITE.operationTypes.includes(itemType)) {
      fail("unsupported_penpot_operation", `Phase 0 cannot compile Penpot operation: ${String(item?.type)}`);
    }
    // Remote-library sync state: nothing in the source to write.
    if (itemType === "set-remote-synced") continue;
    const attr = normalizeType(item.attr);
    if (PENPOT_DERIVED_ATTRIBUTES.has(attr)) continue;
    if (descriptor.kind === "component-sample" && (itemType === "set-touched" || attr === "touched")) continue;
    if (itemType === "unset") {
      if (!PENPOT_ATTRIBUTES.has(attr)) {
        fail("unsupported_penpot_attribute", `Phase 0 cannot compile Penpot attribute: ${attr}`);
      }
      operation.unset.push(COMPONENT_NODE_UNSET_FIELDS.get(attr) ?? attr);
      continue;
    }
    if (itemType === "set-touched") {
      compileAttribute(operation, "touched", item.touched, canonicalNode, snapshot);
      continue;
    }
    if (!PENPOT_ATTRIBUTES.has(attr)) {
      fail("unsupported_penpot_attribute", `Phase 0 cannot compile Penpot attribute: ${attr}`);
    }
    if ((attr === "x" || attr === "y") && descriptor.kind === undefined) {
      // A variant node on the Components page: its place inside its parent
      // is the edit. The main's own place is presentation only.
      if (nodeId !== variant.rootId) {
        for (const axis of ["x", "y"]) {
          if (relative[axis] !== (canonicalNode[axis] ?? 0)) {
            operation.changes[axis] = relative[axis];
          }
        }
      }
      continue;
    }
    if (attr === "x" || attr === "y") {
      if ((change.operations ?? []).some((item) => ["width", "height"].includes(normalizeType(item.attr)))) continue;
      fail("design_system_layout_locked", "Variant node positions are source layout; move the node on its own screen or edit width/height", {
        attr,
        componentSetId: componentId,
        nodeId,
      });
    }
    if (attr === "content" && canonicalNode.type === "PATH") {
      // Penpot path content is page-absolute and already turned; canonical
      // pathData is local to the node box inside the variant tree.
      operation.changes.pathData = compilePathContent(
        item.val,
        invertMatrix(
          relativeNodeMatrix(
            parentPlacement,
            relative,
            placement.width,
            placement.height,
          ),
        ),
      );
      continue;
    }
    compileAttribute(
      operation,
      attr,
      Object.hasOwn(relativeValues, attr) &&
        (item.val === null ||
          (attr === "rotation"
            ? Number.isFinite(item.val)
            : typeof item.val === "boolean"))
        ? relativeValues[attr]
        : item.val,
      { ...canonicalNode, ...operation.changes },
      snapshot,
    );
  }
  if (descriptor.occurrencePath) {
    // An expanded child is an occurrence override in its owning family,
    // never a write into the shared child definition. A change with only
    // derived attributes (the renderer's text measuring) overrides nothing.
    if (
      operation.unset.length === 0 &&
      Object.keys(operation.changes).every((field) => field === "instance")
    ) {
      return;
    }
    const instance = structuredClone(operation.changes.instance ?? sourceNode.instance);
    instance.overrides ??= {};
    if (operation.unset.length) fail("component_override_unsupported", "Cannot clear an inherited field from this specimen");
    for (const [field, value] of Object.entries(operation.changes)) {
      if (field === "instance") continue;
      if (!INSTANCE_OVERRIDE_FIELDS.has(field) || field === "variant") {
        fail("component_override_unsupported", `Nested occurrence cannot override ${field}; edit the child component source explicitly`, { ...descriptor, field });
      }
      instance.overrides[`${descriptor.overrideNodeId}:${field}`] = value;
    }
    operation.changes = { instance };
    return;
  }
  const compiledChanges = { ...operation.changes };
  const routedFields = new Set();
  for (const [field, reference] of Object.entries(sourceNode.tokenBindings ?? {})) {
    const targetField = field === "fill" || field.startsWith("fills.") ? "fills"
      : field === "typography" || ["fontFamily", "fontSize", "fontWeight"].includes(field) ? "textStyle"
      : field === "strokeWidth" || field === "stroke" || field.startsWith("strokes.") ? "strokes"
        : field;
    if (operation.unset.includes(targetField)) fail("component_binding_locked", `Cannot clear bound ${field}; edit its Token source`);
    if (!Object.hasOwn(compiledChanges, targetField)) continue;
    const resolved = resolveEffectiveToken(view, reference, { libraries: snapshot.libraries });
    if (!resolved || resolved.sourcePackageId !== snapshot.manifest.packageId ||
        (resolved.token.contextValues?.length ?? 0) > 0 ||
        (typeof resolved.token.rawValue === "string" && /^\{[^{}]+\}$/.test(resolved.token.rawValue))) {
      fail("component_binding_source_locked", `Bound ${field} requires an explicit Token source edit (alias, context or external owner)`, { ...descriptor, field, reference });
    }
    let value = compiledChanges[targetField];
    if (field === "cornerRadius") {
      const edits = (change.operations ?? []).filter((item) => PENPOT_CORNER_ATTRIBUTES.has(normalizeType(item.attr)));
      const values = [...new Set(edits.map((item) => item.val))];
      if (values.length !== 1) fail("component_binding_uniform_radius", "A scalar radius Token requires a single radius value");
      value = values[0];
    } else if (targetField === "fills") {
      const index = field === "fill" ? 0 : Number(field.slice(6));
      const fill = value?.[index];
      if (!Array.isArray(value) || value.length !== canonicalNode.fills?.length || fill?.type !== "solid" || (fill.opacity ?? 1) !== 1) {
        fail("component_binding_source_locked", "Bound fill edits must preserve paint structure and opacity");
      }
      value = fill.color;
    } else if (field === "stroke" || field.startsWith("strokes.")) {
      const index = field === "stroke" ? 0 : Number(field.slice(8));
      const stroke = value?.[index];
      if (!Array.isArray(value) || value.length !== canonicalNode.strokes?.length || stroke?.type !== "solid" || (stroke.opacity ?? 1) !== 1) {
        fail("component_binding_source_locked", "Bound stroke color edits must preserve paint structure and opacity");
      }
      value = stroke.color;
    } else if (field === "strokeWidth") {
      value = value?.[0]?.width;
      if (!Array.isArray(compiledChanges.strokes) || compiledChanges.strokes.some((stroke) => stroke.width !== value)) {
        fail("component_binding_source_locked", "A stroke width Token requires one shared width");
      }
    } else if (targetField === "textStyle" && field !== "typography") {
      value = value?.[field];
    }
    if (value === undefined) fail("component_binding_source_locked", `Cannot resolve edited ${field}`);
    const previous = operationsByToken.get(resolved.sourceTokenId);
    if (previous && JSON.stringify(previous.value) !== JSON.stringify(value)) {
      fail("component_binding_conflict", "Selected specimens request different values for the same Token", { tokenId: resolved.sourceTokenId });
    }
    operationsByToken.set(resolved.sourceTokenId, {
      type: "set-token-value", tokenId: resolved.sourceTokenId,
      path: resolved.token.path, value,
    });
    routedFields.add(targetField);
  }
  for (const field of routedFields) {
    if (field === "fills" && !sourceNode.tokenBindings.fill) {
      // Individual fill bindings must not erase edits to other paints.
      const remaining = structuredClone(compiledChanges.fills);
      for (const binding of Object.keys(sourceNode.tokenBindings)) {
        if (binding.startsWith("fills.")) {
          const index = Number(binding.slice(6));
          remaining[index] = structuredClone(sourceNode.fills[index]);
        }
      }
      if (JSON.stringify(remaining) !== JSON.stringify(sourceNode.fills)) {
        operation.changes.fills = remaining;
        continue;
      }
    } else if (field === "textStyle" && !sourceNode.tokenBindings.typography) {
      const remaining = { ...compiledChanges.textStyle };
      for (const binding of ["fontFamily", "fontSize", "fontWeight"]) {
        if (!sourceNode.tokenBindings[binding]) continue;
        if (sourceNode.textStyle?.[binding] === undefined) delete remaining[binding];
        else remaining[binding] = sourceNode.textStyle[binding];
      }
      if (!sameTextStyle(remaining, sourceNode.textStyle ?? {})) {
        operation.changes.textStyle = remaining;
        continue;
      }
    } else if (field === "strokes") {
      const bound = sourceNode.tokenBindings;
      const remaining = compiledChanges.strokes.map((stroke, index) => ({
        ...stroke,
        ...(bound.strokeWidth ? { width: sourceNode.strokes?.[index]?.width } : {}),
        ...(bound[`strokes.${index}`] || (index === 0 && bound.stroke)
          ? { color: sourceNode.strokes?.[index]?.color, type: sourceNode.strokes?.[index]?.type }
          : {}),
      }));
      if (JSON.stringify(remaining) !== JSON.stringify(sourceNode.strokes)) {
        operation.changes.strokes = remaining;
        continue;
      }
    }
    delete operation.changes[field];
  }
}

// Penpot keeps a shape's page-absolute geometry when mov-objects reparents
// it (group, ungroup, drag into a board) and sends no geometry change, but
// canonical geometry is relative to the parent's full transform. Re-express
// each moved node's unchanged placement against its final parent, unless the
// same commit sets its geometry itself (compileNodeUpdate then converts it
// against the final parent). Nodes created in this commit are placed by
// compileAddedNode.
function compileReparentedPositions(
  snapshot,
  changes,
  geometry,
  operations,
  operationsByNode,
) {
  const deleted = new Set();
  for (const change of changes) {
    if (normalizeType(change?.type) === "del-obj") {
      deleted.add(String(change.id));
    }
  }
  const visited = new Set();
  for (const change of changes) {
    if (
      normalizeType(change?.type) !== "mov-objects" ||
      !Array.isArray(change.shapes)
    ) {
      continue;
    }
    const page = pageDescriptor(snapshot, change);
    for (const shape of change.shapes) {
      const runtimeId = String(shape);
      if (
        visited.has(runtimeId) ||
        deleted.has(runtimeId) ||
        geometry.values.has(runtimeId)
      ) {
        continue;
      }
      visited.add(runtimeId);
      const descriptor = nodeDescriptor(snapshot, runtimeId, page, true);
      const node = presentationNodes(snapshot, page)?.[descriptor.nodeId];
      if (!node) continue;
      const placement = canonicalAbsolutePlacement(
        snapshot,
        page,
        descriptor.nodeId,
      );
      if (!placement) continue;
      const parentPlacement = runtimeAbsolutePlacement(
        snapshot,
        page,
        geometry.parents.get(runtimeId),
        geometry,
      );
      const relative = relativePlacement(parentPlacement, placement, [
        penpotRelativeFlips(parentPlacement, placement),
        { flipX: node.flipX === true, flipY: node.flipY === true },
      ]);
      const key = `${descriptor.screenId}\0${descriptor.presentationId}\0${descriptor.nodeId}`;
      let operation = operationsByNode.get(key);
      if (!operation) {
        operation = {
          changes: {},
          nodeId: descriptor.nodeId,
          presentationId: descriptor.presentationId,
          screenId: descriptor.screenId,
          type: "update-presentation-node",
        };
        operationsByNode.set(key, operation);
        operations.push(operation);
      }
      compileImpliedPlacement(operation, node, relative, {
        height: node.height,
        width: node.width,
      });
    }
  }
}

// Penpot only sends the shapes whose page placement changed. When it refits
// a group or bool box around an edited child (changes_builder
// `resize-parents`), or resizes a board whose children stay put, the
// children it does not send keep their page placement; their canonical x/y
// are relative to the parent box, so restate them against the new box.
function compileUntouchedChildPositions(
  snapshot,
  changes,
  geometry,
  placedRuntimeIds,
  operations,
  operationsByNode,
) {
  const skipped = new Set(geometry.parents.keys());
  for (const change of changes) {
    const type = normalizeType(change?.type);
    if (type === "del-obj" || type === "add-obj") skipped.add(String(change.id));
  }
  for (const runtimeId of placedRuntimeIds) {
    const descriptor = snapshot.runtime.reverseNodes[runtimeId];
    if (!descriptor) continue;
    const page = {
      presentationId: descriptor.presentationId,
      screenId: descriptor.screenId,
    };
    const nodes = presentationNodes(snapshot, page);
    const parentNode = nodes?.[descriptor.nodeId];
    if (!parentNode?.children?.length) continue;
    const before = canonicalAbsolutePlacement(snapshot, page, descriptor.nodeId);
    const after = runtimeAbsolutePlacement(snapshot, page, runtimeId, geometry);
    if (!before || before.matrix.every((value, index) => value === after.matrix[index])) {
      continue;
    }
    const runtimeIds =
      snapshot.runtime.nodes?.[page.screenId]?.[page.presentationId] ?? {};
    for (const childId of parentNode.children) {
      const node = nodes[childId];
      const childRuntimeId = String(runtimeIds[childId]);
      if (
        !node ||
        runtimeIds[childId] === undefined ||
        skipped.has(childRuntimeId) ||
        geometry.values.has(childRuntimeId)
      ) {
        continue;
      }
      const relative = relativePlacement(after, childPlacement(before, node), [
        { flipX: node.flipX === true, flipY: node.flipY === true },
      ]);
      const key = `${descriptor.screenId}\0${descriptor.presentationId}\0${childId}`;
      let operation = operationsByNode.get(key);
      if (!operation) {
        operation = {
          changes: {},
          nodeId: childId,
          presentationId: descriptor.presentationId,
          screenId: descriptor.screenId,
          type: "update-presentation-node",
        };
        operationsByNode.set(key, operation);
        operations.push(operation);
      }
      compileImpliedPlacement(operation, node, relative, {
        height: node.height,
        width: node.width,
      });
    }
  }
}

// Penpot orders siblings with changes.cljc `insert-at-index`: the shapes land
// at `index` of the parent's current list (the shapes themselves included,
// wherever they are), and an index past either end clamps to it.
function penpotInsertAt(list, index, ids) {
  const moving = new Set(ids);
  const at = Math.max(0, Math.min(index, list.length));
  return [
    ...list.slice(0, at).filter((id) => !moving.has(id)),
    ...ids,
    ...list.slice(at).filter((id) => !moving.has(id)),
  ];
}

// files/helpers.cljc `append-at-the-end`: a shape already in the list keeps
// its place.
function penpotAppend(list, ids) {
  const result = [...list];
  for (const id of ids) if (!result.includes(id)) result.push(id);
  return result;
}

// Sibling lists of each Presentation while a commit applies, seeded from the
// snapshot. A Presentation the snapshot lacks (a page added by the same
// commit) is not tracked.
function childOrderTracker(snapshot) {
  const states = new Map();
  const state = (page) => {
    const key = `${page.screenId}\0${page.presentationId}`;
    if (!states.has(key)) {
      const presentation = snapshotPresentation(snapshot, page);
      let value = null;
      if (presentation) {
        const children = new Map([
          [
            null,
            Array.isArray(presentation.rootIds)
              ? [...presentation.rootIds]
              : typeof presentation.rootId === "string"
                ? [presentation.rootId]
                : [],
          ],
        ]);
        const parents = new Map();
        for (const id of children.get(null)) parents.set(id, null);
        for (const node of Object.values(presentation.nodes ?? {})) {
          children.set(node.id, [...(node.children ?? [])]);
          for (const id of node.children ?? []) parents.set(id, node.id);
        }
        value = { children, parents };
      }
      states.set(key, value);
    }
    return states.get(key);
  };
  const tracker = {
    tracks: (page) => state(page) !== null,
    has: (page, nodeId) =>
      nodeId === null || state(page).children.has(nodeId),
    list: (page, parentId) => state(page).children.get(parentId) ?? [],
    set(page, parentId, list) {
      const { children, parents } = state(page);
      children.set(parentId, list);
      for (const id of list) parents.set(id, parentId);
    },
    // A new shape's own :shapes do not leave their current parent: Penpot
    // detaches them when the following mov-objects lands.
    add(page, parentId, nodeId, list, childIds) {
      tracker.set(page, parentId, list);
      state(page).children.set(nodeId, [...childIds]);
    },
    detach(page, nodeId, keepParentId) {
      const { children, parents } = state(page);
      const parentId = parents.get(nodeId);
      if (parentId === undefined || parentId === keepParentId) return;
      children.set(
        parentId,
        (children.get(parentId) ?? []).filter((id) => id !== nodeId),
      );
      parents.delete(nodeId);
    },
    remove(page, nodeId) {
      tracker.detach(page, nodeId);
      state(page).children.delete(nodeId);
    },
  };
  return tracker;
}

// changes.cljc `process-children-reordering`: the current children sorted by
// their position in `shapes`; children it does not name go first, in their
// current order, and names that are not children are ignored.
function penpotReordered(list, ids) {
  const position = new Map();
  ids.forEach((id, index) => {
    if (!position.has(id)) position.set(id, index);
  });
  return list
    .map((id, index) => ({ id, index, rank: position.get(id) ?? -1 }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ id }) => id);
}

// Where a Penpot mov-objects puts its shapes (changes.cljc :mov-objects): an
// `after-shape` found among the target's children wins over `index`, and no
// index at all appends.
function penpotMovedOrder(list, ids, spec) {
  const after =
    spec.afterShape === null ? -1 : list.indexOf(spec.afterShape);
  const index = after >= 0 ? after + 1 : spec.index;
  return Number.isInteger(index)
    ? penpotInsertAt(list, index, ids)
    : penpotAppend(list, ids);
}

// Penpot resolves sibling positions against the parent's current children,
// in commit order; canonical add/move operations take an index into the
// children that remain once the moved nodes are taken out, and node
// additions run first (compilePenpotChanges). Re-derive every add and move
// index from the Penpot rule against the canonical order at that point, then
// restore the exact Penpot order for any parent that still differs.
function compileChildOrder(snapshot, sourceChanges, operations, specs) {
  const penpot = childOrderTracker(snapshot);
  const touched = new Map();
  const touch = (page, parentId) => {
    touched.set(`${page.screenId}\0${page.presentationId}\0${parentId}`, {
      page,
      parentId,
    });
  };
  for (const change of sourceChanges) {
    const type = normalizeType(change?.type);
    if (
      !["add-obj", "del-obj", "mov-objects", "reorder-children"].includes(type)
    ) {
      continue;
    }
    const page = pageDescriptor(snapshot, change);
    if (!penpot.tracks(page)) continue;
    if (type === "add-obj") {
      const parentId = parentDescriptor(
        snapshot,
        change["parent-id"] ?? change.parentId ?? change.obj?.["parent-id"],
        page,
      ).nodeId;
      const nodeId = nodeDescriptor(
        snapshot,
        change.id ?? change.obj?.id,
        page,
        true,
      ).nodeId;
      const list = penpot.list(page, parentId);
      penpot.add(
        page,
        parentId,
        nodeId,
        list.includes(nodeId)
          ? list
          : Number.isInteger(change.index)
            ? penpotInsertAt(list, change.index, [nodeId])
            : [...list, nodeId],
        (change.obj?.shapes ?? []).map(
          (runtimeId) => nodeDescriptor(snapshot, runtimeId, page, true).nodeId,
        ),
      );
      touch(page, parentId);
    } else if (type === "del-obj") {
      penpot.remove(page, nodeDescriptor(snapshot, change.id, page, true).nodeId);
    } else if (type === "reorder-children") {
      const spec = specs.get(change);
      if (!spec || !penpot.has(page, spec.parentId)) continue;
      penpot.set(
        page,
        spec.parentId,
        penpotReordered(penpot.list(page, spec.parentId), spec.nodeIds),
      );
      touch(page, spec.parentId);
    } else {
      const spec = specs.get(change);
      if (!spec) continue;
      for (const nodeId of spec.nodeIds) {
        penpot.detach(page, nodeId, spec.parentId);
      }
      penpot.set(
        page,
        spec.parentId,
        penpotMovedOrder(penpot.list(page, spec.parentId), spec.nodeIds, spec),
      );
      touch(page, spec.parentId);
    }
  }
  if (touched.size === 0) return;

  const canonical = childOrderTracker(snapshot);
  for (const operation of operations) {
    const page = {
      presentationId: operation.presentationId,
      screenId: operation.screenId,
    };
    if (
      ![
        "add-presentation-node",
        "delete-presentation-node",
        "move-presentation-nodes",
        "reorder-presentation-children",
      ].includes(operation.type) ||
      !canonical.tracks(page)
    ) {
      continue;
    }
    if (operation.type === "add-presentation-node") {
      const list = canonical.list(page, operation.parentId);
      let next = list;
      if (!list.includes(operation.node.id)) {
        if (Number.isInteger(operation.index)) {
          operation.index = Math.max(
            0,
            Math.min(operation.index, list.length),
          );
        }
        next = [...list];
        next.splice(operation.index ?? list.length, 0, operation.node.id);
      }
      canonical.add(
        page,
        operation.parentId,
        operation.node.id,
        next,
        operation.node.children ?? [],
      );
    } else if (operation.type === "delete-presentation-node") {
      canonical.remove(page, operation.nodeId);
    } else if (operation.type === "reorder-presentation-children") {
      if (specs.has(operation) && canonical.has(page, operation.parentId)) {
        operation.childIds = penpotReordered(
          canonical.list(page, operation.parentId),
          specs.get(operation).nodeIds,
        );
      }
      canonical.set(page, operation.parentId, [...operation.childIds]);
    } else {
      const spec = specs.get(operation);
      const moving = new Set(operation.nodeIds);
      if (spec) {
        const order = penpotMovedOrder(
          canonical.list(page, operation.parentId),
          operation.nodeIds,
          spec,
        );
        const first = order.findIndex((id) => moving.has(id));
        operation.index = order
          .slice(0, first)
          .filter((id) => !moving.has(id)).length;
      }
      for (const nodeId of operation.nodeIds) canonical.detach(page, nodeId);
      const remaining = canonical
        .list(page, operation.parentId)
        .filter((id) => !moving.has(id));
      remaining.splice(
        operation.index ?? remaining.length,
        0,
        ...operation.nodeIds,
      );
      canonical.set(page, operation.parentId, remaining);
    }
  }
  for (const { page, parentId } of touched.values()) {
    if (!penpot.has(page, parentId) || !canonical.has(page, parentId)) continue;
    const expected = penpot.list(page, parentId);
    const actual = canonical.list(page, parentId);
    if (
      expected.length !== actual.length ||
      expected.every((id, index) => actual[index] === id) ||
      !expected.every((id) => actual.includes(id))
    ) {
      continue;
    }
    operations.push({
      childIds: [...expected],
      parentId,
      presentationId: page.presentationId,
      screenId: page.screenId,
      type: "reorder-presentation-children",
    });
  }
}

// The generated Components and Design System pages draw a source tree
// shifted by a layout offset (projection.cljs `shift-origins`). The frontend
// sends that shift with an edit made there, so the shape's page-absolute
// geometry is moved back to the source layout before it is compiled. A copy
// instantiated from a generated main keeps the main's plugin data, offset
// included: on any other page the shape is drawn unshifted.
function withoutLayoutOffset(snapshot, change) {
  const offset = change?.["smallpen-layout-offset"];
  if (offset === undefined || offset === null) return change;
  const pageId = String(change.pageId ?? change["page-id"] ?? "");
  if (
    pageId !== String(snapshot.runtime?.componentsPage) &&
    pageId !== String(snapshot.runtime?.designSystemPage)
  ) {
    const unshifted = { ...change };
    delete unshifted["smallpen-layout-offset"];
    return unshifted;
  }
  const added =
    normalizeType(change.type) === "add-obj" && isRecord(change.obj);
  if (
    !(added || normalizeType(change.type) === "mod-obj") ||
    !isRecord(offset) ||
    !Number.isFinite(offset.x) ||
    !Number.isFinite(offset.y) ||
    !(added || Array.isArray(change.operations))
  ) {
    fail(
      "invalid_penpot_change",
      "smallpen-layout-offset must be a finite {x, y} on a mod-obj or add-obj change",
      { offset },
    );
  }
  const shift = (value, axis) =>
    Number.isFinite(value) ? canonicalNumber(value - offset[axis]) : value;
  const shiftPoint = (value, prefix = "") =>
    isRecord(value)
      ? {
          ...value,
          [`${prefix}x`]: shift(value[`${prefix}x`], "x"),
          [`${prefix}y`]: shift(value[`${prefix}y`], "y"),
        }
      : value;
  const shiftValue = (attr, value) => {
    if (attr === "x" || attr === "y") return shift(value, attr);
    if (attr === "selrect" && isRecord(value)) {
      return ["x1", "x2"].reduce(
        (rect, key) => ({ ...rect, [key]: shift(rect[key], "x") }),
        ["y1", "y2"].reduce(
          (rect, key) => ({ ...rect, [key]: shift(rect[key], "y") }),
          shiftPoint(value),
        ),
      );
    }
    if (attr === "points" && Array.isArray(value)) {
      return value.map((point) => shiftPoint(point));
    }
    if (attr === "content" && Array.isArray(value)) {
      return value.map((segment) =>
        isRecord(segment) && isRecord(segment.params)
          ? {
              ...segment,
              params: shiftPoint(
                shiftPoint(shiftPoint(segment.params), "c1"),
                "c2",
              ),
            }
          : segment,
      );
    }
    return value;
  };
  // The parent's current geometry (Components page, see variants.mjs) is in
  // the same drawn frame as the edit.
  const shiftGeometry = (geometry) =>
    isRecord(geometry)
      ? Object.fromEntries(
          Object.entries(geometry).map(([attr, value]) => [attr, shiftValue(attr, value)]),
        )
      : geometry;
  const parent = isRecord(change["smallpen-parent"])
    ? {
        ...change["smallpen-parent"],
        child: shiftGeometry(change["smallpen-parent"].child),
        geometry: shiftGeometry(change["smallpen-parent"].geometry),
      }
    : change["smallpen-parent"];
  if (added) {
    // A shape added inside a tree drawn away from its source (a new layer in
    // a variant main): its whole geometry moves back to the source frame.
    const obj = { ...change.obj };
    for (const attr of ["x", "y", "selrect", "points", "content"]) {
      if (obj[attr] !== undefined) obj[attr] = shiftValue(attr, obj[attr]);
    }
    return { ...change, obj, ...(parent ? { "smallpen-parent": parent } : {}) };
  }
  return {
    ...change,
    ...(parent ? { "smallpen-parent": parent } : {}),
    operations: change.operations.map((item) =>
      isRecord(item) && normalizeType(item.type) === "set"
        ? { ...item, val: shiftValue(normalizeType(item.attr), item.val) }
        : item,
    ),
  };
}

function completedOperations(operations) {
  return operations.filter(
    (operation) =>
      operation.type !== "update-presentation-node" ||
      Object.keys(operation.changes).length > 0,
  );
}

// Penpot sends a mov-objects with no shapes when a drag ends in the same
// parent and treats it as a no-op; it moves nothing here either.
function isEmptyMove(change) {
  return (
    normalizeType(change?.type) === "mov-objects" &&
    Array.isArray(change.shapes) &&
    change.shapes.length === 0
  );
}

export function compilePenpotChanges(snapshotValue, commit, options = {}) {
  let snapshot = {
    ...snapshotValue,
    libraries: options.libraries ?? [],
  };
  if (!isRecord(commit) || !Array.isArray(commit.changes)) {
    fail("invalid_penpot_commit", "Penpot commit must contain a changes array");
  }
  if (typeof commit.commitId !== "string" || commit.commitId.length === 0) {
    fail("invalid_penpot_commit", "Penpot commit must contain a commitId");
  }
  const shiftedChanges = commit.changes.map((change) =>
    withoutLayoutOffset(snapshot, change),
  );
  // Native variants: a variant switch on a copy, and every structural edit
  // of a Component Set on the Components page (state based, variants.mjs).
  const switches = compileInstanceVariantSwitches(
    snapshot,
    shiftedChanges,
    options,
  );
  const componentSetState = compileComponentSetState(
    snapshot,
    switches.changes,
    options,
  );
  snapshot = componentSetState.snapshot;
  const unshiftedChanges = componentSetState.changes;
  const domainInstances = domainInstanceAdds(snapshot, unshiftedChanges);
  snapshot.addedNodeIds = domainInstances.nodeIds;
  snapshot.addedBoards = addedShapeBoards(snapshot, unshiftedChanges);
  snapshot.addedPages = new Set(
    unshiftedChanges.filter((change) => normalizeType(change?.type) === "add-page").map((change) => String(change.id ?? change.page?.id)),
  );
  const commitChanges = withoutProjectedCopyChanges(
    unshiftedChanges,
    domainInstances,
  );
  // The touched groups each shape ends the commit with, when it sets them.
  const touchedByRuntimeId = new Map();
  for (const change of commitChanges) {
    if (normalizeType(change?.type) !== "mod-obj") continue;
    for (const item of Array.isArray(change.operations) ? change.operations : []) {
      if (isRecord(item) && normalizeType(item.type) === "set-touched") {
        touchedByRuntimeId.set(
          String(change.id),
          new Set((Array.isArray(item.touched) ? item.touched : []).map(normalizeType)),
        );
      }
    }
  }

  const operations = [
    ...switches.operations,
    ...componentSetState.operations,
  ];
  const movedChildIds = new Set();
  for (const change of commitChanges) {
    if (normalizeType(change?.type) === "mov-objects" && Array.isArray(change.shapes)) {
      for (const shapeId of change.shapes) movedChildIds.add(String(shapeId));
    }
  }
  const operationsByNode = new Map();
  const operationsByToken = new Map();
  const updateStatesByNode = new Map();
  const projections = new Map();
  const placedRuntimeIds = new Set();
  const addedNodes = new Map();
  const childOrderSpecs = new Map();
  let acceptedNoOp =
    switches.operations.length > 0 || componentSetState.accepted === true;
  // DSE-004/005: split the commit into generated-page changes (translated or
  // rejected) and everything else. Structural mutations of the generated
  // Design System page never reach the canonical Package.
  const designSystemPageId = snapshot.runtime?.designSystemPage;
  const reverseDesignSystem = snapshot.runtime?.reverseDesignSystem ?? {};
  const reverseComponentNodes = snapshot.runtime?.reverseComponentNodes ?? {};
  const isDesignSystemPageChange = (change) =>
    designSystemPageId !== undefined &&
    String(change?.pageId ?? change?.["page-id"] ?? "") ===
      String(designSystemPageId);
  const sourceChanges = [];
  for (const change of commitChanges) {
    const type = normalizeType(change?.type);
    if (isEmptyMove(change)) continue;
    if (isDesignSystemPageChange(change) && type !== "mod-obj") {
      if (type === "reg-objects") {
        // The text editor registers the edited objects in the SAME commit
        // as the actual mod-obj edits. The registration itself creates and
        // changes nothing on the generated page; dropping it keeps the real
        // edit alive instead of failing the batch (DSE-R10).
        acceptedNoOp = true;
        continue;
      }
      fail(
        "design_system_structure_locked",
        `The generated Design System page cannot be structurally changed (${type}); edit the source pages or Token Cells instead`,
        { changeType: type },
      );
    }
    sourceChanges.push(change);
  }
  const metadataNodes = componentMetadataNodes(snapshot, sourceChanges);
  const geometry = penpotGeometryContext(sourceChanges);
  for (const change of sourceChanges) {
    const type = normalizeType(change?.type);
    if (type === "add-component") {
      operations.push(compileAddedComponent(snapshot, change));
    } else if (type === "mod-component") {
      // Component metadata sync rides along on unrelated commits with an
      // empty operations list and no component fields; skip that instead of
      // failing the whole batch. Real updates carry fields or operations.
      const hasComponentPayload =
        Array.isArray(change.operations) && change.operations.length > 0;
      const hasComponentFields = ["annotation", "name", "objects", "path"].some(
        (field) => change[field] !== undefined && change[field] !== null,
      );
      if (!hasComponentPayload && !hasComponentFields) {
        acceptedNoOp = true;
      } else if (snapshot.runtime?.reverseVariants?.[String(change.id)]) {
        // Variant component metadata sync (name/path of a per-variant
        // component) is bookkeeping, not a user edit; the canonical source
        // of variant naming is the Component Set itself.
        acceptedNoOp = true;
      } else {
        const operation = compileUpdatedComponent(snapshot, change);
        if (operation) {
          operations.push(operation);
        } else {
          acceptedNoOp = true;
        }
      }
    } else if (type === "reg-objects") {
      validateRegisteredObjects(snapshot, change);
      acceptedNoOp = true;
    } else if (type === "del-component") {
      operations.push(compileDeletedComponent(snapshot, change));
    }
  }
  const tokenChanges = commitChanges.filter((change) =>
    TOKEN_CHANGE_TYPES.has(normalizeType(change?.type)),
  );
  if (tokenChanges.length > 0) {
    const foundation = productTokenFoundation(snapshot);
    if (foundation) {
      const compiled = compileProductTokenChanges(snapshot, foundation, tokenChanges);
      operations.push(...compiled);
      if (compiled.length === 0) acceptedNoOp = true;
    } else {
      operations.push(compileTokenLibraryChanges(snapshot, tokenChanges));
    }
  }
  const assetChanges = commitChanges.filter((change) =>
    ASSET_CHANGE_TYPES.has(normalizeType(change?.type)),
  );
  if (assetChanges.length > 0) {
    operations.push(compileAssetLibraryChanges(snapshot, assetChanges));
  }
  const deletedNodeIds = deletedCanonicalNodeIds(snapshot, commitChanges);
  for (const originalChange of commitChanges) {
    const originalType = normalizeType(originalChange?.type);
    if (isEmptyMove(originalChange)) {
      acceptedNoOp = true;
      continue;
    }
    if (
      originalType === "add-component" ||
      originalType === "mod-component" ||
      originalType === "del-component" ||
      originalType === "reg-objects" ||
      TOKEN_CHANGE_TYPES.has(originalType) ||
      ASSET_CHANGE_TYPES.has(originalType)
    ) {
      continue;
    }
    const metadata = metadataNodes.get(String(originalChange?.id));
    const change = metadata
      ? withoutComponentMetadata(originalChange, metadata, snapshot)
      : originalChange;
    const type = normalizeType(change?.type);
    if (!isRecord(change) || !PENPOT_CHANGE_TYPES.has(type)) {
      fail(
        "unsupported_penpot_change",
        `Phase 0 cannot compile Penpot change: ${String(change?.type)}`,
      );
    }
    if (
      ["del-page", "mod-page", "mov-page"].includes(type) &&
      snapshot.runtime.componentsPage &&
      String(change.id) === String(snapshot.runtime.componentsPage)
    ) {
      fail(
        "generated_page_locked",
        "The Components page is generated from the Package's Components; it cannot be renamed, moved or deleted",
        { changeType: type },
      );
    }
    if (type === "add-page") {
      operations.push(compileAddedCanvas(snapshot, change));
    } else if (type === "del-page") {
      operations.push(...compileDeletedCanvas(snapshot, change));
    } else if (type === "mod-page") {
      // The page name is the canvas name; a one-board canvas still takes
      // the page's other settings (background, pixel grid) as before.
      const { name, ...settings } = change;
      const renamed = name !== undefined ? compileRenamedCanvas(snapshot, change) : undefined;
      const others = Object.keys(settings).some((key) => ["background", "pixel-grid-color", "pixel-grid-opacity"].includes(key));
      const page = pageDescriptorById(snapshot, change.id);
      const operation = others && page.screenId !== undefined ? compileUpdatedPresentation(snapshot, settings) : undefined;
      if (renamed) operations.push(renamed);
      if (operation) operations.push(operation);
      if (!renamed && !operation) acceptedNoOp = true;
    } else if (type === "mov-page") {
      operations.push(compileMovedCanvas(snapshot, change));
    } else if (type === "set-flow") {
      operations.push(compilePrototypeFlow(snapshot, change));
    } else if (type === "mod-obj") {
      if (
        metadata &&
        originalChange.operations?.length > 0 &&
        change.operations.length === 0
      ) {
        // Only validated Component metadata (an undo clearing it): the
        // canonical node has nothing to change.
        acceptedNoOp = true;
      } else if (change.operations?.length > 0) {
        if (
          snapshot.runtime.componentsPage &&
          String(change.pageId ?? change["page-id"]) === String(snapshot.runtime.componentsPage) &&
          change.operations.every((item) =>
            isRecord(item) && normalizeType(item.type) === "set" &&
            normalizeType(item.attr) === "position-data")
        ) {
          // Expanded nested instances have projected-only text IDs. Their
          // browser measurements are not edits to a canonical source node.
          acceptedNoOp = true;
          continue;
        }
        const targetId = String(change.id);
        const componentRef = reverseComponentNodes[targetId];
        const designRef = reverseDesignSystem[targetId];
        if (designRef?.kind === "component-sample" && designRef.readOnly === true) {
          // A Product's page shows its Foundation's components read-only.
          fail(
            "foundation_components_read_only",
            `Component ${designRef.familyName ?? designRef.componentId} belongs to the Foundation and is read-only in this Product; edit it in the Foundation`,
            { componentId: designRef.componentId, foundationPackageId: designRef.ownerPackageId },
          );
        }
        if (componentRef || designRef?.kind === "component-sample") {
          // DSE-004: a component variant node projected on the Components
          // page or the Design System board writes its definition.
          componentNodeUpdate(snapshot, componentRef ?? designRef, change, operations, operationsByNode, operationsByToken);
        } else if (designRef?.kind === "token-cell") {
          // DSE-R10: projected typography displays are native TEXT shapes,
          // so the renderer's measure pass emits pure `position-data` syncs
          // for them. That is render bookkeeping on the generated page, not
          // a user edit: it must neither fail the whole commit (it rides in
          // the same batch as real edits, e.g. a component creation) nor
          // trip the alias/typography readonly guard.
          const cellOps = (Array.isArray(change.operations) ? change.operations : []).filter(isRecord);
          const renderBookkeepingOnly =
            cellOps.length > 0 &&
            cellOps.every(
              (item) =>
                normalizeType(item.type) === "set" &&
                normalizeType(item.attr) === "position-data",
            );
          if (renderBookkeepingOnly) {
            acceptedNoOp = true;
          } else if (designRef.readOnly === true) {
            foundationTokenReadOnly(snapshot, designRef);
          } else if (
            designRef.writable === false &&
            !cellOps.some(
              (item) =>
                isRecord(item) &&
                normalizeType(item.type) === "set" &&
                normalizeType(item.attr) === "token-value",
            )
          ) {
            // DSE-011: alias displays are visible but their bound shape
            // attributes are not direct-edit targets: overwriting an alias
            // expression from a shape attribute would silently destroy it.
            // The explicit token-value path (Token inspector) is the ONE
            // legal way to rewrite the expression (DSE-R26).
            fail(
              "design_system_token_readonly",
              `This Token Cell display is not directly editable (alias Cells change via the Token tooling): ${designRef.tokenId}`,
              { tokenId: designRef.tokenId },
            );
          } else {
            tokenCellUpdate(snapshot, designRef, change, operationsByToken);
          }
        } else if (
          (designRef?.kind === "located-component-node" ||
            designRef?.kind === "page-node") &&
          isDesignSystemPageChange(change)
        ) {
          // DSE-R11: a board copy of a located component's main tree shares
          // the source node's runtime id, so the edit translates to that
          // node on its own screen page. x/y stay locked to the source
          // layout, exactly like variant nodes: board placement is
          // projection-only.
          const movesSourceLayout = (change.operations ?? []).some(
            (item) =>
              isRecord(item) &&
              normalizeType(item.type) === "set" &&
              ["x", "y"].includes(normalizeType(item.attr)),
          );
          if (movesSourceLayout) {
            fail(
              "design_system_layout_locked",
              "Component definition layout is edited on its own screen; board positions are presentation-only",
            );
          }
          // A path's box is its page-absolute selrect: without the board's
          // layout offset it would move the source node to the board spot.
          const sourceNode = presentationNodes(snapshot, designRef)?.[
            designRef.nodeId
          ];
          if (
            sourceNode?.type === "PATH" &&
            change["smallpen-layout-offset"] === undefined &&
            (change.operations ?? []).some(
              (item) =>
                isRecord(item) &&
                normalizeType(item.type) === "set" &&
                ["content", "selrect"].includes(normalizeType(item.attr)),
            )
          ) {
            fail(
              "design_system_layout_offset_missing",
              "A path edit on the Design System board needs the board layout offset to map back to its source screen",
              { nodeId: designRef.nodeId },
            );
          }
          compileNodeUpdate(
            snapshot,
            {
              ...change,
              "page-id":
                snapshot.runtime.pages[designRef.screenId]?.[
                  designRef.presentationId
                ],
            },
            operations,
            operationsByNode,
            updateStatesByNode,
            projections,
            geometry,
          );
        } else if (isDesignSystemPageChange(change)) {
          // Everything else on the generated page is presentation state:
          // decorations (board, labels, captions, fillers) and unmapped
          // shapes alike. Renderer syncs may target shapes of an older
          // board generation, and users cannot create shapes here at all
          // (the structural gate rejects add-obj), so these edits drop
          // instead of failing the batch or leaking into the Package.
          acceptedNoOp = true;
        } else {
          compileNodeUpdate(
            snapshot,
            change,
            operations,
            operationsByNode,
            updateStatesByNode,
            projections,
            geometry,
            addedNodes,
            touchedByRuntimeId,
          );
          placedRuntimeIds.add(targetId);
        }
      }
    } else if (type === "add-obj") {
      const added = compileAddedNode(
        snapshot,
        change,
        geometry,
        movedChildIds,
        domainInstances,
      );
      addedNodes.set(
        `${added.screenId}\0${added.presentationId}\0${added.node.id}`,
        added.node,
      );
      operations.push(added);
    } else {
      const page = pageDescriptor(snapshot, change);
      if (type === "del-obj") {
        const descriptor = nodeDescriptor(snapshot, change.id, page, true);
        if (deletedWithOwnerInstance(snapshot, descriptor, deletedNodeIds)) {
          // Penpot deletes each projected child before the instance root;
          // removing the root already removes them.
          acceptedNoOp = true;
          continue;
        }
        if (
          snapshot.runtime.reverseNodes?.[String(change.id)] === undefined &&
          !presentationNodes(snapshot, page)?.[descriptor.nodeId] &&
          [...deletedNodeIds].some(
            (nodeId) => presentationNodes(snapshot, page)?.[nodeId]?.instance,
          )
        ) {
          // A copy child of an Instance dropped in this session keeps the
          // runtime id Penpot gave it until the page reloads; a Background
          // that no longer knows it (projectedRuntimeIds below) still sees
          // the Instance it belongs to deleted in the same commit.
          acceptedNoOp = true;
          continue;
        }
        requireCanonicalStructure(snapshot, change.id, descriptor);
        operations.push({
          nodeId: descriptor.nodeId,
          presentationId: page.presentationId,
          screenId: page.screenId,
          type: "delete-presentation-node",
        });
      } else if (type === "mov-objects") {
        if (!Array.isArray(change.shapes)) {
          fail("invalid_penpot_change", "Penpot mov-objects requires shapes");
        }
        const parent = parentDescriptor(
          snapshot,
          change["parent-id"] ?? change.parentId,
          page,
        );
        requireCanonicalStructure(
          snapshot,
          change["parent-id"] ?? change.parentId,
          parent,
        );
        const afterShape = change["after-shape"] ?? change.afterShape;
        const move = {
          index: change.index,
          nodeIds: change.shapes.map((runtimeId) => {
            const descriptor = nodeDescriptor(snapshot, runtimeId, page, true);
            requireCanonicalStructure(snapshot, runtimeId, descriptor);
            return descriptor.nodeId;
          }),
          parentId: parent.nodeId,
          presentationId: page.presentationId,
          screenId: page.screenId,
          type: "move-presentation-nodes",
        };
        const spec = {
          afterShape:
            afterShape === undefined || afterShape === null
              ? null
              : nodeDescriptor(snapshot, afterShape, page, true).nodeId,
          index: change.index,
          nodeIds: move.nodeIds,
          parentId: move.parentId,
        };
        childOrderSpecs.set(originalChange, spec);
        childOrderSpecs.set(move, spec);
        operations.push(move);
      } else if (type === "reorder-children") {
        if (!Array.isArray(change.shapes)) {
          fail(
            "invalid_penpot_change",
            "Penpot reorder-children requires shapes",
          );
        }
        const parent = parentDescriptor(
          snapshot,
          change["parent-id"] ?? change.parentId,
          page,
        );
        requireCanonicalStructure(
          snapshot,
          change["parent-id"] ?? change.parentId,
          parent,
        );
        const reorder = {
          childIds: change.shapes.map((runtimeId) => {
            return nodeDescriptor(snapshot, runtimeId, page, true).nodeId;
          }),
          parentId: parent.nodeId,
          presentationId: page.presentationId,
          screenId: page.screenId,
          type: "reorder-presentation-children",
        };
        const spec = {
          nodeIds: reorder.childIds,
          parentId: reorder.parentId,
        };
        childOrderSpecs.set(originalChange, spec);
        childOrderSpecs.set(reorder, spec);
        operations.push(reorder);
      }
    }
  }
  compileReparentedPositions(
    snapshot,
    sourceChanges,
    geometry,
    operations,
    operationsByNode,
  );
  compileUntouchedChildPositions(
    snapshot,
    sourceChanges,
    geometry,
    placedRuntimeIds,
    operations,
    operationsByNode,
  );
  // Components are compiled in an earlier loop than node changes, but the
  // Package requires a component's main node to exist when add-component
  // applies: run node additions first (stable order inside each group).
  {
    const nodeAdds = [];
    const componentAdds = [];
    const rest = [];
    for (const operation of operations) {
      if (operation.type === "add-presentation-node") nodeAdds.push(operation);
      else if (operation.type === "add-component") componentAdds.push(operation);
      else rest.push(operation);
    }
    operations.length = 0;
    operations.push(...nodeAdds, ...componentAdds, ...rest);
  }
  compileChildOrder(snapshot, sourceChanges, operations, childOrderSpecs);
  for (const tokenOperation of operationsByToken.values()) {
    if (tokenOperation.value !== undefined) {
      operations.push(tokenOperation);
    }
  }
  compileInstanceOverrides(snapshot, updateStatesByNode, operations);
  validateNodeUpdateStates(updateStatesByNode);
  const completed = completedOperations(operations).filter((operation) => {
    if (operation.type !== "update-component-node") return true;
    return (
      Object.keys(operation.changes).length > 0 || operation.unset.length > 0
    );
  });
  const textLayoutOnly =
    updateStatesByNode.size > 0 &&
    [...updateStatesByNode.values()].every(
      ({ derivedAttributes }) =>
        derivedAttributes.length > 0 &&
        derivedAttributes.every((attribute) => attribute === "position-data"),
    );
  const acceptedNodeNoOp =
    operationsByNode.size > 0 &&
    [...operationsByNode.values()].every(
      ({ changes }) => Object.keys(changes).length === 0,
    );
  if (
    completed.length === 0 &&
    !textLayoutOnly &&
    !acceptedNoOp &&
    !acceptedNodeNoOp
  ) {
    fail(
      "empty_penpot_commit",
      "Penpot commit did not contain a supported completed edit",
    );
  }
  // The copy children of new domain Instances keep the runtime ids Penpot
  // gave them until the page reloads; the caller maps them to the projected
  // nodes they now are for later commits of the session.
  for (const [runtimeId, descriptor] of domainInstances.childNodeIds) {
    options.projectedRuntimeIds?.set(runtimeId, descriptor);
  }
  const ordered = boardMovesAsOrder(snapshot, completed);
  if (ordered.length === 0)
    return { baseRevision: snapshot.revision, batchId: `penpot_${commit.commitId}`, operations: [] };
  return {
    baseRevision: snapshot.revision,
    batchId: `penpot_${commit.commitId}`,
    operations: ordered,
  };
}

// Shared with variants.mjs (native Penpot variants).
export {
  canonicalAddedNode,
  canonicalDomainInstance,
  canonicalTreePlacement,
  domainInstanceSource,
  isRecord,
  normalizeType,
  parentAbsolutePlacement,
  penpotGeometryContext,
  penpotPlacement,
  PENPOT_DERIVED_ATTRIBUTES,
  PLACEMENT_ATTRIBUTES,
  presentationNodes,
  relativePlacement,
  ROOT_PLACEMENT,
  runtimeNodeId,
};
