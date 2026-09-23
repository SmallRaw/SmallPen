import {
  applyEffectiveTokenBindings,
  componentCombinationSnapshot,
  fail,
  projectScreen,
  resolveEffectiveToken,
  SMALLPEN_FORMAT_CAPABILITIES,
} from "@smallpen/core";

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
        return !PENPOT_STROKE_FIELDS.has(field) && fieldValue !== null;
      })
      .map(([field]) => field);
    if (unsupported.length > 0) {
      fail(
        "unsupported_penpot_stroke",
        "Penpot stroke contains an image, reference, or per-side width",
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
// page-absolute coordinates. The canonical package format stores path
// geometry as the pathData string LOCAL to the node origin
// (packages/local-package/src/render.mjs), so compile it and subtract the
// shape's absolute origin.
function compilePathContent(value, origin = { x: 0, y: 0 }) {
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
      return coordinate - origin[key.slice(-1)];
    };
    if (command === "move-to") {
      pathData += `M${number("x")},${number("y")}`;
    } else if (command === "line-to") {
      pathData += `L${number("x")},${number("y")}`;
    } else if (command === "curve-to") {
      pathData += `C${number("c1x")},${number("c1y")},${number("c2x")},${number("c2y")},${number("x")},${number("y")}`;
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

function projectedNode(snapshot, descriptor, projections) {
  const key = `${descriptor.screenId}\0${descriptor.presentationId}`;
  let nodes = projections.get(key);
  if (!nodes) {
    const dependencyIds = new Set(
      (snapshot.manifest.dependencies ?? []).map(({ packageId }) => packageId),
    );
    const foundation = (snapshot.libraries ?? []).find(({ manifest }) =>
      dependencyIds.has(manifest.packageId),
    );
    const libraries = (snapshot.libraries ?? []).filter(
      (candidate) => candidate !== foundation,
    );
    nodes = projectScreen(snapshot, descriptor.screenId, {
      context: snapshot.projection?.context,
      foundation,
      libraries,
      presentationId: descriptor.presentationId,
    }).nodes;
    projections.set(key, nodes);
  }
  return nodes[descriptor.nodeId];
}

function cornerRadii(value) {
  if (typeof value === "number") return [value, value, value, value];
  if (Array.isArray(value) && value.length === 4) return [...value];
  return [0, 0, 0, 0];
}

function compileAttribute(operation, attr, value, node, snapshot) {
  if (value === null) {
    // Penpot inverse/undo edits clear attributes with an explicit null; the
    // update-presentation-node contract treats null as "remove the field"
    // (same convention the layout attributes already rely on).
    operation.changes[attr] = null;
    return;
  }
  if (attr === "applied-tokens") {
    operation.changes.appliedTokens = compileAppliedTokens(value);
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
  if (!descriptor) {
    fail(
      "unknown_runtime_page",
      `Penpot runtime page is not mapped to SmallPen: ${String(pageId)}`,
    );
  }
  return descriptor;
}

function pageDescriptor(snapshot, change) {
  const pageId = change.pageId ?? change["page-id"];
  return pageDescriptorById(snapshot, pageId);
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
      nodeId: runtimeNodeId(value),
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

function presentationNodes(snapshot, page) {
  const screenEntry = snapshot.manifest.entries.screens.find(
    (entry) => snapshot.entries[entry].id === page.screenId,
  );
  return snapshot.entries[screenEntry]?.presentations.find(
    (presentation) => presentation.id === page.presentationId,
  )?.nodes;
}

function canonicalParentId(nodes, nodeId) {
  for (const node of Object.values(nodes ?? {})) {
    if ((node.children ?? []).includes(nodeId)) return node.id;
  }
  return null;
}

function canonicalAbsoluteOrigin(snapshot, page, nodeId) {
  const nodes = presentationNodes(snapshot, page);
  let currentId = nodeId;
  let x = 0;
  let y = 0;
  const visited = new Set();
  while (currentId !== null && currentId !== undefined) {
    if (visited.has(currentId)) {
      fail("node_cycle", `Canonical node hierarchy contains a cycle: ${currentId}`);
    }
    visited.add(currentId);
    const node = nodes?.[currentId];
    if (!node) return null;
    x += node.x ?? 0;
    y += node.y ?? 0;
    currentId = canonicalParentId(nodes, currentId);
  }
  return { x, y };
}

function penpotGeometryContext(changes) {
  const parents = new Map();
  const positions = new Map();
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
      positions.set(runtimeId, { x: change.obj.x, y: change.obj.y });
    } else if (type === "mod-obj" && Array.isArray(change.operations)) {
      const position = positions.get(String(change.id)) ?? {};
      for (const operation of change.operations) {
        const attr = normalizeType(operation?.attr);
        if ((attr === "x" || attr === "y") && Number.isFinite(operation.val)) {
          position[attr] = operation.val;
        }
      }
      if (Object.keys(position).length > 0) {
        positions.set(String(change.id), position);
      }
    } else if (type === "mov-objects" && Array.isArray(change.shapes)) {
      const parentRuntimeId = String(
        change["parent-id"] ?? change.parentId,
      );
      for (const runtimeId of change.shapes) {
        parents.set(String(runtimeId), parentRuntimeId);
      }
    }
  }
  return { parents, positions };
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

function runtimeAbsoluteOrigin(snapshot, page, runtimeId, geometry) {
  if (
    runtimeId === undefined ||
    runtimeId === null ||
    String(runtimeId) === "00000000-0000-0000-0000-000000000000"
  ) {
    return { x: 0, y: 0 };
  }
  const provided = geometry.positions.get(String(runtimeId));
  const descriptor = nodeDescriptor(snapshot, runtimeId, page, true);
  const canonical = canonicalAbsoluteOrigin(snapshot, page, descriptor.nodeId);
  return {
    x: provided?.x ?? canonical?.x ?? 0,
    y: provided?.y ?? canonical?.y ?? 0,
  };
}

function parentAbsoluteOrigin(snapshot, page, runtimeId, geometry) {
  return runtimeAbsoluteOrigin(
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
  for (const [rawAttribute, tokenName] of Object.entries(value)) {
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

function canonicalAddedNode(
  snapshot,
  value,
  page,
  runtimeId = value?.id,
  parentOrigin = { x: 0, y: 0 },
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
    height: value.height,
    id: descriptor.nodeId,
    name: value.name,
    type,
    width: value.width,
    x: canonicalNumber(value.x - parentOrigin.x),
    y: canonicalNumber(value.y - parentOrigin.y),
  };
  if (value["applied-tokens"] !== undefined) {
    node.appliedTokens = compileAppliedTokens(value["applied-tokens"]);
  }
  if (value.interactions !== undefined) {
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
  if (value.opacity !== undefined) node.opacity = value.opacity;
  if (value.rotation !== undefined && value.rotation !== null) {
    if (
      typeof value.rotation !== "number" ||
      !Number.isFinite(value.rotation)
    ) {
      fail("invalid_node_rotation", "Penpot rotation must be finite");
    }
    const rotation = ((value.rotation % 360) + 360) % 360;
    if (rotation !== 0) node.rotation = rotation;
  }
  if (value["flip-x"] === true) node.flipX = true;
  if (value["flip-y"] === true) node.flipY = true;
  if (Array.isArray(value.strokes) && value.strokes.length > 0) {
    node.strokes = compileStrokes(value.strokes, snapshot);
  }
  if (value.hidden !== undefined) node.visible = !value.hidden;
  if (type === "PATH") {
    for (const [source, target] of [
      ["path-data", "pathData"],
      ["points", "points"],
    ]) {
      if (value[source] !== undefined)
        node[target] = structuredClone(value[source]);
    }
    if (value["content"] !== undefined) {
      node.pathData = compilePathContent(value["content"], {
        x: value.x ?? 0,
        y: value.y ?? 0,
      });
    }
  }
  return node;
}

function compileAddedNode(snapshot, change, geometry, movedChildIds) {
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
  const parentOrigin = parentAbsoluteOrigin(
    snapshot,
    page,
    runtimeId,
    geometry,
  );
  return {
    index: change.index,
    node: canonicalAddedNode(
      snapshot,
      value,
      page,
      runtimeId,
      parentOrigin,
      movedChildIds,
    ),
    parentId: parent.nodeId,
    presentationId: page.presentationId,
    screenId: page.screenId,
    type: "add-presentation-node",
  };
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
  const page = pageDescriptorById(snapshot, change["main-instance-page"]);
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
    const page = pageDescriptorById(snapshot, change["main-instance-page"]);
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
  const value = Object.hasOwn(attrs, "value") ? attrs.value : previous.value;
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
  return { library: state.library, type: "replace-token-library" };
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
    const absoluteOrigins = new Map(
      Object.entries(objects).map(([objectId, value]) => [
        String(objectId),
        { x: value?.x ?? 0, y: value?.y ?? 0 },
      ]),
    );
    for (const [objectId, value] of Object.entries(objects)) {
      if (objectId === "00000000-0000-0000-0000-000000000000") continue;
      const parentOrigin =
        absoluteOrigins.get(String(value["parent-id"])) ?? { x: 0, y: 0 };
      const node = canonicalAddedNode(
        snapshot,
        value,
        descriptor,
        objectId,
        parentOrigin,
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
  if (unsupported.length > 0) {
    fail(
      "unsupported_penpot_page_attribute",
      `Penpot page attribute is not supported: ${unsupported[0]}`,
      { attributes: unsupported },
    );
  }
  if (changedAttributes.length === 0) {
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
  for (const attribute of ["background", "pixel-grid-color"]) {
    if (
      Object.hasOwn(change, attribute) &&
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
  const canonicalNode = presentation.nodes[descriptor.nodeId];
  const node =
    canonicalNode ?? projectedNode(snapshot, descriptor, projections) ?? {};
  const projectedOnly = canonicalNode === undefined && node.type !== undefined;
  const coordinatePage = {
    presentationId: descriptor.presentationId,
    screenId: descriptor.screenId,
  };
  const parentOrigin = parentAbsoluteOrigin(
    snapshot,
    coordinatePage,
    change.id,
    geometry,
  );
  // Penpot path content is page-absolute; canonical pathData is local to the
  // node origin. When the same change moves x/y, normalize the content with
  // the FINAL runtime position or the move is applied twice.
  let runtimeOriginX = parentOrigin.x + (node.x ?? 0);
  let runtimeOriginY = parentOrigin.y + (node.y ?? 0);
  for (const item of change.operations) {
    if (!isRecord(item) || normalizeType(item.type) !== "set") continue;
    const itemAttr = normalizeType(item.attr);
    if (itemAttr === "x" && Number.isFinite(item.val)) runtimeOriginX = item.val;
    if (itemAttr === "y" && Number.isFinite(item.val)) runtimeOriginY = item.val;
  }
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
      if (process.env.SMALLPEN_ADAPTER_DEBUG) {
        console.error("[dbg] unsupported attr", attr, new Error().stack?.split("\n").slice(2, 5).join(" | "));
      }
      fail(
        "unsupported_penpot_attribute",
        `Phase 0 cannot compile Penpot attribute: ${String(attr)}`,
      );
    }
    if (projectedOnly && attr === "content") {
      const compiled = compilePlainTextContent(item.val, { snapshot });
      if (compiled.text === node.text) continue;
      fail(
        "component_instance_override_unsupported",
        "Edit the Component source or add an explicit instance text override before changing this projected child",
        {
          instanceNodeId: descriptor.nodeId,
          projectedText: node.text,
          requestedText: compiled.text,
        },
      );
    }
    updateState.changesGeometry ||= PENPOT_GEOMETRY_ATTRIBUTES.has(attr);
    updateState.changesProportionLock ||= attr === "proportion-lock";
    updateState.changesText ||= attr === "content";
    updateState.changesTransform ||=
      attr === "flip-x" || attr === "flip-y" || attr === "rotation";
    const itemValue =
      attr === "x"
        ? item.val - parentOrigin.x
        : attr === "y"
          ? item.val - parentOrigin.y
          : item.val;
    if (attr === "content" && node.type === "PATH") {
      // Penpot path content is page-absolute; canonical pathData is local to
      // the node origin (runtime x = parentOrigin + canonical x).
      operation.changes.pathData = compilePathContent(itemValue, {
        x: runtimeOriginX,
        y: runtimeOriginY,
      });
      continue;
    }
    compileAttribute(
      operation,
      attr,
      itemValue,
      {
        ...node,
        ...operation.changes,
      },
      snapshot,
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

function tokenCellUpdate(snapshot, ref, change, operationsByToken) {
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
    if (itemType === "set-touched") continue;
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
        const rowGap = item.val?.rowGap;
        const columnGap = item.val?.columnGap;
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

function variantNodeOrigin(variant, nodeId) {
  const nodes = variant.nodes ?? {};
  let x = 0;
  let y = 0;
  let cursor = nodeId;
  const seen = new Set();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node = nodes[cursor];
    if (!node) break;
    x += node.x ?? 0;
    y += node.y ?? 0;
    cursor = Object.values(nodes).find(
      (candidate) => candidate.children?.includes(cursor),
    )?.id;
  }
  return { x, y };
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
      componentSetId: componentId,
      nodeId,
      type: "update-component-node",
      unset: [],
      variantId,
    };
    operationsByNode.set(key, operation);
    operations.push(operation);
  }
  const origin = variantNodeOrigin(variant, nodeId);
  let runtimeOriginX = origin.x + (canonicalNode.x ?? 0);
  let runtimeOriginY = origin.y + (canonicalNode.y ?? 0);
  for (const item of change.operations ?? []) {
    if (isRecord(item) && normalizeType(item.type) === "set") {
      const itemAttr = normalizeType(item.attr);
      if (itemAttr === "x" && Number.isFinite(item.val)) runtimeOriginX = item.val;
      if (itemAttr === "y" && Number.isFinite(item.val)) runtimeOriginY = item.val;
    }
  }
  for (const item of change.operations ?? []) {
    if (!isRecord(item)) {
      fail("unsupported_penpot_operation", `Phase 0 cannot compile Penpot operation: ${String(item?.type)}`);
    }
    const itemType = normalizeType(item.type);
    if (!PENPOT_WRITE.operationTypes.includes(itemType)) {
      fail("unsupported_penpot_operation", `Phase 0 cannot compile Penpot operation: ${String(item?.type)}`);
    }
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
    if (attr === "x" || attr === "y") {
      if ((change.operations ?? []).some((item) => ["width", "height"].includes(normalizeType(item.attr)))) continue;
      fail("design_system_layout_locked", "Variant node positions are source layout; move the node on its own screen or edit width/height", {
        attr,
        componentSetId: componentId,
        nodeId,
      });
    }
    if (attr === "content" && canonicalNode.type === "PATH") {
      // Penpot path content is page-absolute; canonical pathData is local
      // to the node origin inside the variant tree.
      operation.changes.pathData = compilePathContent(item.val, {
        x: runtimeOriginX,
        y: runtimeOriginY,
      });
      continue;
    }
    compileAttribute(
      operation,
      attr,
      item.val,
      { ...canonicalNode, ...operation.changes },
      snapshot,
    );
  }
  if (descriptor.occurrencePath) {
    // An expanded child is an occurrence override in its owning family,
    // never a write into the shared child definition.
    const instance = structuredClone(operation.changes.instance ?? sourceNode.instance);
    instance.overrides ??= {};
    if (operation.unset.length) fail("component_override_unsupported", "Cannot clear an inherited field from this specimen");
    for (const [field, value] of Object.entries(operation.changes)) {
      if (field === "instance") continue;
      if (!["fills", "name", "opacity", "text", "visible"].includes(field)) {
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
      : field === "strokeWidth" ? "strokes" : field;
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
      const remaining = compiledChanges.strokes.map((stroke, index) => ({ ...stroke, width: sourceNode.strokes?.[index]?.width }));
      if (JSON.stringify(remaining) !== JSON.stringify(sourceNode.strokes)) {
        operation.changes.strokes = remaining;
        continue;
      }
    }
    delete operation.changes[field];
  }
}

function completedOperations(operations) {
  return operations.filter(
    (operation) =>
      operation.type !== "update-presentation-node" ||
      Object.keys(operation.changes).length > 0,
  );
}

export function compilePenpotChanges(snapshotValue, commit, options = {}) {
  const snapshot = {
    ...snapshotValue,
    libraries: options.libraries ?? [],
  };
  if (!isRecord(commit) || !Array.isArray(commit.changes)) {
    fail("invalid_penpot_commit", "Penpot commit must contain a changes array");
  }
  if (typeof commit.commitId !== "string" || commit.commitId.length === 0) {
    fail("invalid_penpot_commit", "Penpot commit must contain a commitId");
  }

  const operations = [];
  const movedChildIds = new Set();
  for (const change of commit.changes) {
    if (normalizeType(change?.type) === "mov-objects" && Array.isArray(change.shapes)) {
      for (const shapeId of change.shapes) movedChildIds.add(String(shapeId));
    }
  }
  const operationsByNode = new Map();
  const operationsByToken = new Map();
  const updateStatesByNode = new Map();
  const projections = new Map();
  let acceptedNoOp = false;
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
  for (const change of commit.changes) {
    const type = normalizeType(change?.type);
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
  const tokenChanges = commit.changes.filter((change) =>
    TOKEN_CHANGE_TYPES.has(normalizeType(change?.type)),
  );
  if (tokenChanges.length > 0) {
    operations.push(compileTokenLibraryChanges(snapshot, tokenChanges));
  }
  const assetChanges = commit.changes.filter((change) =>
    ASSET_CHANGE_TYPES.has(normalizeType(change?.type)),
  );
  if (assetChanges.length > 0) {
    operations.push(compileAssetLibraryChanges(snapshot, assetChanges));
  }
  for (const originalChange of commit.changes) {
    const originalType = normalizeType(originalChange?.type);
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
    if (type === "add-page") {
      operations.push(compileAddedPresentation(snapshot, change));
    } else if (type === "del-page") {
      operations.push(compileDeletedPresentation(snapshot, change));
    } else if (type === "mod-page") {
      operations.push(compileUpdatedPresentation(snapshot, change));
    } else if (type === "mov-page") {
      operations.push(compileMovedPresentation(snapshot, change));
    } else if (type === "set-flow") {
      operations.push(compilePrototypeFlow(snapshot, change));
    } else if (type === "mod-obj") {
      if (change.operations?.length > 0) {
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
          );
        }
      }
    } else if (type === "add-obj") {
      operations.push(compileAddedNode(snapshot, change, geometry, movedChildIds));
    } else {
      const page = pageDescriptor(snapshot, change);
      if (type === "del-obj") {
        const descriptor = nodeDescriptor(snapshot, change.id, page, true);
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
        operations.push({
          index: change.index,
          nodeIds: change.shapes.map((runtimeId) => {
            return nodeDescriptor(snapshot, runtimeId, page, true).nodeId;
          }),
          parentId: parent.nodeId,
          presentationId: page.presentationId,
          screenId: page.screenId,
          type: "move-presentation-nodes",
        });
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
        operations.push({
          childIds: change.shapes.map((runtimeId) => {
            return nodeDescriptor(snapshot, runtimeId, page, true).nodeId;
          }),
          parentId: parent.nodeId,
          presentationId: page.presentationId,
          screenId: page.screenId,
          type: "reorder-presentation-children",
        });
      }
    }
  }
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
  for (const tokenOperation of operationsByToken.values()) {
    if (tokenOperation.value !== undefined) {
      operations.push(tokenOperation);
    }
  }
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
  return {
    baseRevision: snapshot.revision,
    batchId: `penpot_${commit.commitId}`,
    operations: completed,
  };
}
