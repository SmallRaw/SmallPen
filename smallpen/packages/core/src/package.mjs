import {
  canonicalJSON,
  hashCanonicalFiles,
  sha256Hex,
  stableRuntimeUuid,
} from "./canonical.mjs";
import { SMALLPEN_FORMAT_CAPABILITIES } from "./capabilities.mjs";
import { parseComponentEntries } from "./components-domain.mjs";
import { createComponentSamples } from "./component-samples.mjs";
import { parseContextEntries } from "./contexts.mjs";
import { validateDesignReferences } from "./design-validation.mjs";
import { fail } from "./errors.mjs";
import { parseRequirementEntries } from "./requirements-domain.mjs";
import { parseScenarioEntries } from "./scenarios-domain.mjs";
import { parseTokenEntries } from "./tokens-domain.mjs";

const ENTRY_KINDS = SMALLPEN_FORMAT_CAPABILITIES.canonicalPackage.entryKinds;
const NODE_TYPES = new Set(
  SMALLPEN_FORMAT_CAPABILITIES.canonicalPackage.nodeTypes,
);
const NODE_CHANGE_FIELDS = new Set(
  SMALLPEN_FORMAT_CAPABILITIES.canonicalWrite.nodeFields,
);
const OPTIONAL_NODE_FIELDS = new Set([
  "appliedTokens",
  "backgroundBlur",
  "blend-mode",
  "blur",
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
  "cornerRadius",
  "fills",
  "flipX",
  "flipY",
  "growType",
  "grids",
  "hide-fill-on-export",
  "hide-in-viewer",
  "interactions",
  "locked",
  "masked-group",
  "mediaRef",
  "opacity",
  "proportionLock",
  "rotation",
  "strokes",
  "shadow",
  "show-content",
  "textBlocks",
  "textStyle",
  "tokenBindings",
  "touched",
  "visible",
]);
const TOKEN_TYPES = new Set(
  SMALLPEN_FORMAT_CAPABILITIES.canonicalPackage.tokenTypes,
);
const APPLIED_TOKEN_ATTRIBUTES = new Set(
  SMALLPEN_FORMAT_CAPABILITIES.webProjection.appliedTokenAttributes,
);
const TOKEN_NAME_PATTERN = /^[a-zA-Z0-9_-][a-zA-Z0-9$_-]*(\.[a-zA-Z0-9$_-]+)*$/;
const TOKEN_BINDING_FIELDS = new Set([
  "backgroundBlur",
  "blur",
  "cornerRadius",
  "fill",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "height",
  "itemSpacing",
  "opacity",
  "paddingBottom",
  "paddingLeft",
  "paddingRight",
  "paddingTop",
  "shadow",
  "strokeWidth",
  "typography",
  "width",
]);
const COMPONENT_TOUCHED_GROUPS = new Set([
  "blur-group",
  "constraints-group",
  "content-group",
  "fill-group",
  "geometry-group",
  "layer-effects-group",
  "mask-group",
  "modifiable-group",
  "name-group",
  "radius-group",
  "shadow-group",
  "stroke-group",
  "text-display-group",
  "text-font-group",
  "visibility-group",
]);
const TEXT_GROW_TYPES = new Set(["auto-height", "auto-width", "fixed"]);
const TEXT_STYLE_ENUMS = {
  fontStyle: new Set(["italic", "normal", "oblique"]),
  textAlign: new Set(["center", "justify", "left", "right"]),
  textDecoration: new Set(["line-through", "none", "underline"]),
  textDirection: new Set(["ltr", "rtl"]),
  textTransform: new Set(["capitalize", "lowercase", "none", "uppercase"]),
  verticalAlign: new Set(["bottom", "center", "top"]),
};
const TEXT_STYLE_FIELDS = new Set([
  "fontFamily",
  "fontId",
  "fontSize",
  "fontStyle",
  "fontVariantId",
  "fontWeight",
  "letterSpacing",
  "lineHeight",
  "textAlign",
  "textDecoration",
  "textDirection",
  "textTransform",
  "verticalAlign",
  "typographyRef",
]);
const TYPOGRAPHY_STYLE_FIELDS = new Set([
  "fontFamily",
  "fontId",
  "fontSize",
  "fontStyle",
  "fontVariantId",
  "fontWeight",
  "letterSpacing",
  "lineHeight",
  "textTransform",
]);
const MEDIA_TYPES = new Set(
  SMALLPEN_FORMAT_CAPABILITIES.webProjection.supportedMediaTypes,
);
const FONT_TYPES = new Set(
  SMALLPEN_FORMAT_CAPABILITIES.webProjection.supportedFontTypes,
);
const FONT_WEIGHTS = new Set([
  100, 200, 300, 400, 500, 600, 700, 800, 900, 950,
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, code, message, details) {
  if (!isRecord(value)) fail(code, message, details);
  return value;
}

function safeEntry(entry) {
  if (
    typeof entry !== "string" ||
    entry.length === 0 ||
    entry.startsWith("/") ||
    entry.startsWith("\\") ||
    entry.includes("\\") ||
    /^[a-zA-Z]:[\\/]/.test(entry)
  ) {
    fail(
      "invalid_entry_path",
      `Invalid Canonical Package entry: ${String(entry)}`,
      { entry },
    );
  }
  const segments = entry.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    fail(
      "invalid_entry_path",
      `Canonical Package entry escapes the package: ${entry}`,
      { entry },
    );
  }
  return entry;
}

function stableId(value, prefix, code, path) {
  if (
    typeof value !== "string" ||
    !value.startsWith(prefix) ||
    !/^[a-zA-Z0-9_-]+$/.test(value)
  ) {
    fail(code, `${path} must begin with ${prefix}`, { path, value });
  }
  return value;
}

function validateDraftMetadata(value) {
  const draft = requireRecord(
    value,
    "invalid_draft_metadata",
    "manifest.json.draft must contain an object",
  );
  if (
    Object.keys(draft).length !== 2 ||
    !Array.isArray(draft.losses) ||
    !isRecord(draft.provenance)
  ) {
    fail(
      "invalid_draft_metadata",
      "manifest.json.draft requires losses and provenance",
    );
  }
  if (draft.losses.length > 10000) {
    fail("invalid_draft_losses", "Draft Loss Report is too large");
  }
  for (const [index, lossValue] of draft.losses.entries()) {
    const loss = requireRecord(
      lossValue,
      "invalid_draft_loss",
      `manifest.json.draft.losses[${index}] must contain an object`,
    );
    const fields = new Set(["code", "message", "nodeId", "severity"]);
    if (
      Object.keys(loss).some((field) => !fields.has(field)) ||
      typeof loss.code !== "string" ||
      loss.code.length === 0 ||
      typeof loss.message !== "string" ||
      loss.message.length === 0 ||
      !new Set(["info", "warning"]).has(loss.severity)
    ) {
      fail(
        "invalid_draft_loss",
        `manifest.json.draft.losses[${index}] is invalid`,
      );
    }
    if (loss.nodeId !== undefined) {
      stableId(
        loss.nodeId,
        "node_",
        "invalid_node_id",
        `manifest.json.draft.losses[${index}].nodeId`,
      );
    }
  }
  const provenance = draft.provenance;
  const provenanceFields = new Set([
    "dataType",
    "importedAt",
    "inputHash",
    "sourceFileId",
    "sourceKind",
    "sourcePasteId",
  ]);
  if (
    Object.keys(provenance).some((field) => !provenanceFields.has(field)) ||
    typeof provenance.importedAt !== "string" ||
    !Number.isFinite(Date.parse(provenance.importedAt)) ||
    typeof provenance.inputHash !== "string" ||
    !SHA256_PATTERN.test(provenance.inputHash) ||
    !new Set(["figma-structured", "png", "svg"]).has(provenance.sourceKind)
  ) {
    fail(
      "invalid_draft_provenance",
      "manifest.json.draft.provenance is invalid",
    );
  }
  for (const field of ["dataType", "sourceFileId"]) {
    if (
      provenance[field] !== undefined &&
      (typeof provenance[field] !== "string" || provenance[field].length === 0)
    ) {
      fail(
        "invalid_draft_provenance",
        `manifest.json.draft.provenance.${field} is invalid`,
      );
    }
  }
  if (
    provenance.sourcePasteId !== undefined &&
    !Number.isSafeInteger(provenance.sourcePasteId)
  ) {
    fail(
      "invalid_draft_provenance",
      "manifest.json.draft.provenance.sourcePasteId is invalid",
    );
  }
  return draft;
}

function validateManifest(value) {
  const manifest = requireRecord(
    value,
    "invalid_manifest",
    "manifest.json must contain an object",
  );
  if (manifest.formatVersion !== 1) {
    fail(
      "unsupported_format_version",
      "Only SmallPen formatVersion 1 is supported",
      {
        formatVersion: manifest.formatVersion,
      },
    );
  }
  if (manifest.role !== "foundation" && manifest.role !== "product") {
    fail(
      "invalid_manifest_role",
      "Manifest role must be foundation or product",
    );
  }
  if (manifest.draft !== undefined) {
    validateDraftMetadata(manifest.draft);
    if (manifest.role !== "foundation") {
      fail(
        "invalid_draft_role",
        "Imported Draft Packages must use the foundation role",
      );
    }
  }
  const dependencies = manifest.dependencies ?? [];
  if (!Array.isArray(dependencies)) {
    fail("invalid_dependencies", "Manifest dependencies must be an array");
  }
  for (const [index, dependency] of dependencies.entries()) {
    const path = `manifest.json.dependencies[${index}]`;
    if (
      !isRecord(dependency) ||
      Object.keys(dependency).length !== 2 ||
      typeof dependency.packageId !== "string" ||
      typeof dependency.path !== "string" ||
      dependency.path.length === 0 ||
      dependency.path.startsWith("/") ||
      dependency.path.includes("\\") ||
      /^[a-zA-Z]:[\\/]/.test(dependency.path) ||
      dependency.path
        .split("/")
        .some(
          (segment) =>
            segment.length === 0 || segment === "." || segment === "..",
        )
    ) {
      fail(
        "invalid_dependency",
        `${path} requires a Package id and safe relative workspace path`,
      );
    }
    stableId(
      dependency.packageId,
      "pkg_",
      "invalid_package_id",
      `${path}.packageId`,
    );
  }
  if (manifest.role === "foundation" && dependencies.length !== 0) {
    fail(
      "foundation_dependency_forbidden",
      "Foundation Packages cannot declare dependencies",
    );
  }
  if (manifest.role === "product" && dependencies.length !== 1) {
    fail(
      "product_dependency_count",
      "Product Packages must declare exactly one Foundation dependency",
    );
  }
  const libraries = manifest.libraries ?? [];
  if (!Array.isArray(libraries)) {
    fail("invalid_libraries", "Manifest libraries must be an array");
  }
  const libraryPackageIds = new Set(
    dependencies.map(({ packageId }) => packageId),
  );
  for (const [index, library] of libraries.entries()) {
    const path = `manifest.json.libraries[${index}]`;
    if (
      !isRecord(library) ||
      Object.keys(library).length !== 2 ||
      typeof library.packageId !== "string" ||
      !isRecord(library.source)
    ) {
      fail("invalid_library", `${path} requires packageId and source`, {
        path,
      });
    }
    stableId(
      library.packageId,
      "pkg_",
      "invalid_package_id",
      `${path}.packageId`,
    );
    if (
      library.packageId === manifest.packageId ||
      libraryPackageIds.has(library.packageId)
    ) {
      fail(
        "duplicate_library",
        `${path}.packageId must identify one unique external Library`,
        { packageId: library.packageId, path },
      );
    }
    libraryPackageIds.add(library.packageId);
    const sourceFields = Object.keys(library.source);
    if (library.source.type === "local") {
      if (
        sourceFields.length !== 2 ||
        typeof library.source.path !== "string" ||
        library.source.path.length === 0 ||
        library.source.path.includes("\0")
      ) {
        fail(
          "invalid_library_source",
          `${path}.source requires type local and a Package path`,
          { path: `${path}.source` },
        );
      }
    } else if (library.source.type === "url") {
      let parsed;
      try {
        parsed = new URL(library.source.url);
      } catch {
        parsed = undefined;
      }
      if (
        sourceFields.length !== 2 ||
        typeof library.source.url !== "string" ||
        !parsed ||
        (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      ) {
        fail(
          "invalid_library_source",
          `${path}.source requires type url and an HTTP(S) URL`,
          { path: `${path}.source` },
        );
      }
    } else {
      fail(
        "invalid_library_source",
        `${path}.source type must be local or url`,
        { path: `${path}.source` },
      );
    }
  }
  stableId(
    manifest.packageId,
    "pkg_",
    "invalid_package_id",
    "manifest.json.packageId",
  );
  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    fail("invalid_package_name", "Manifest name must be a non-empty string");
  }
  const entries = requireRecord(
    manifest.entries,
    "invalid_manifest_entries",
    "Manifest entries must contain an object",
  );
  const seen = new Set();
  for (const kind of ENTRY_KINDS) {
    if (!Array.isArray(entries[kind])) {
      fail(
        "invalid_manifest_entries",
        `Manifest entries.${kind} must be an array`,
      );
    }
    for (const entry of entries[kind]) {
      safeEntry(entry);
      if (seen.has(entry))
        fail("duplicate_entry", `Canonical entry is indexed twice: ${entry}`);
      seen.add(entry);
    }
  }
  return manifest;
}

function finiteNumber(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("invalid_node_number", `${path} must be a finite number`, {
      path,
      value,
    });
  }
}

function validateNodeName(value, path) {
  if (typeof value !== "string") {
    fail("invalid_node_name", `${path} must be a string`, { path, value });
  }
}

function validateNodeVisibility(value, path) {
  if (typeof value !== "boolean") {
    fail("invalid_node_visibility", `${path} must be a boolean`, {
      path,
      value,
    });
  }
}

function validateTouched(value, path) {
  if (!Array.isArray(value) || new Set(value).size !== value.length) {
    fail("invalid_component_touched", `${path} must be a unique array`);
  }
  for (const group of value) {
    if (!COMPONENT_TOUCHED_GROUPS.has(group)) {
      fail(
        "unsupported_component_touched_group",
        `${path} contains an unsupported touched group: ${String(group)}`,
      );
    }
  }
}

function validateAppliedTokens(value, path) {
  const applied = requireRecord(
    value,
    "invalid_applied_tokens",
    `${path} must contain an object`,
  );
  for (const [attribute, tokenName] of Object.entries(applied)) {
    if (!APPLIED_TOKEN_ATTRIBUTES.has(attribute)) {
      fail(
        "unsupported_applied_token_attribute",
        `${path}.${attribute} is unsupported`,
      );
    }
    if (typeof tokenName !== "string" || !TOKEN_NAME_PATTERN.test(tokenName)) {
      fail("invalid_token_name", `${path}.${attribute} is not a token name`);
    }
  }
}

function validateAssetReference(value, path, prefix) {
  const reference = requireRecord(
    value,
    "invalid_asset_reference",
    `${path} must contain an object`,
  );
  if (
    Object.keys(reference).length !== 2 ||
    typeof reference.packageId !== "string" ||
    typeof reference.assetId !== "string"
  ) {
    fail(
      "invalid_asset_reference",
      `${path} must contain only packageId and assetId`,
      { path },
    );
  }
  stableId(
    reference.packageId,
    "pkg_",
    "invalid_package_id",
    `${path}.packageId`,
  );
  stableId(reference.assetId, prefix, "invalid_asset_id", `${path}.assetId`);
}

function validateTokenBindings(value, path) {
  const bindings = requireRecord(
    value,
    "invalid_token_bindings",
    `${path} must contain an object`,
  );
  for (const [field, reference] of Object.entries(bindings)) {
    if (!TOKEN_BINDING_FIELDS.has(field) && !/^fills\.\d+$/.test(field)) {
      fail("unsupported_token_binding", `${path}.${field} is unsupported`, {
        field,
        path: `${path}.${field}`,
      });
    }
    validateAssetReference(reference, `${path}.${field}`, "tok_");
  }
}

function validateDomainInstance(value, path) {
  const instance = requireRecord(
    value,
    "invalid_component_instance",
    `${path} must contain an object`,
  );
  const fields = new Set(["component", "overrides", "variant"]);
  if (
    !Object.hasOwn(instance, "component") ||
    !Object.hasOwn(instance, "variant") ||
    Object.keys(instance).some((field) => !fields.has(field))
  ) {
    fail("invalid_component_instance", `${path} fields are invalid`);
  }
  validateAssetReference(instance.component, `${path}.component`, "cmp_");
  const variant = requireRecord(
    instance.variant,
    "invalid_component_variant_selection",
    `${path}.variant must contain an object`,
  );
  for (const [axisId, valueId] of Object.entries(variant)) {
    if (
      typeof axisId !== "string" ||
      !axisId.startsWith("axis_") ||
      typeof valueId !== "string" ||
      valueId.length === 0
    ) {
      fail(
        "invalid_component_variant_selection",
        `${path}.variant must map Axis ids to value ids`,
      );
    }
  }
  if (instance.overrides !== undefined) {
    const overrides = requireRecord(
      instance.overrides,
      "invalid_component_overrides",
      `${path}.overrides must contain an object`,
    );
    for (const [overridePath, override] of Object.entries(overrides)) {
      if (overridePath.length === 0) {
        fail(
          "invalid_component_override",
          `${path}.overrides has an empty path`,
        );
      }
      if (Array.isArray(override)) {
        validateFills(override, `${path}.overrides.${overridePath}`);
      } else if (
        typeof override !== "boolean" &&
        typeof override !== "number" &&
        typeof override !== "string"
      ) {
        fail(
          "invalid_component_override",
          `${path}.overrides.${overridePath} is unsupported`,
        );
      }
    }
  }
}

function validateTokenLibrary(value, entry) {
  const library = requireRecord(
    value,
    "invalid_token_library",
    `Token entry must contain an object: ${entry}`,
  );
  const libraryFields = new Set([
    "activeSetIds",
    "activeThemeIds",
    "id",
    "sets",
    "themes",
  ]);
  for (const field of Object.keys(library)) {
    if (!libraryFields.has(field)) {
      fail(
        "unsupported_token_library_field",
        `${entry}.${field} is unsupported`,
      );
    }
  }
  stableId(library.id, "tlib_", "invalid_token_library_id", `${entry}.id`);
  if (!Array.isArray(library.sets) || !Array.isArray(library.themes)) {
    fail("invalid_token_library", `${entry}.sets and themes must be arrays`);
  }
  const setIds = new Set();
  const setNames = new Set();
  const tokenIds = new Set();
  for (const [setIndex, setValue] of library.sets.entries()) {
    const setPath = `${entry}.sets[${setIndex}]`;
    const tokenSet = requireRecord(
      setValue,
      "invalid_token_set",
      `${setPath} must contain an object`,
    );
    for (const field of Object.keys(tokenSet)) {
      if (!new Set(["description", "id", "name", "tokens"]).has(field)) {
        fail(
          "unsupported_token_set_field",
          `${setPath}.${field} is unsupported`,
        );
      }
    }
    stableId(tokenSet.id, "tset_", "invalid_token_set_id", `${setPath}.id`);
    if (setIds.has(tokenSet.id)) {
      fail("duplicate_token_set_id", `Duplicate Token Set id: ${tokenSet.id}`);
    }
    if (
      typeof tokenSet.name !== "string" ||
      tokenSet.name.length === 0 ||
      tokenSet.name.trim() !== tokenSet.name
    ) {
      fail("invalid_token_set_name", `${setPath}.name is invalid`);
    }
    if (setNames.has(tokenSet.name)) {
      fail(
        "duplicate_token_set_name",
        `Duplicate Token Set name: ${tokenSet.name}`,
      );
    }
    if (typeof tokenSet.description !== "string") {
      fail(
        "invalid_token_set_description",
        `${setPath}.description must be a string`,
      );
    }
    if (!Array.isArray(tokenSet.tokens)) {
      fail("invalid_tokens", `${setPath}.tokens must be an array`);
    }
    const names = new Set();
    for (const [tokenIndex, tokenValue] of tokenSet.tokens.entries()) {
      const tokenPath = `${setPath}.tokens[${tokenIndex}]`;
      const token = requireRecord(
        tokenValue,
        "invalid_token",
        `${tokenPath} must contain an object`,
      );
      for (const field of Object.keys(token)) {
        if (
          !new Set(["description", "id", "name", "type", "value"]).has(field)
        ) {
          fail(
            "unsupported_token_field",
            `${tokenPath}.${field} is unsupported`,
          );
        }
      }
      stableId(token.id, "tok_", "invalid_token_id", `${tokenPath}.id`);
      if (tokenIds.has(token.id)) {
        fail("duplicate_token_id", `Duplicate Token id: ${token.id}`);
      }
      if (
        typeof token.name !== "string" ||
        !TOKEN_NAME_PATTERN.test(token.name)
      ) {
        fail("invalid_token_name", `${tokenPath}.name is invalid`);
      }
      if (names.has(token.name)) {
        fail("duplicate_token_name", `Duplicate Token name: ${token.name}`);
      }
      if (!TOKEN_TYPES.has(token.type)) {
        fail("unsupported_token_type", `${tokenPath}.type is unsupported`);
      }
      if (typeof token.description !== "string") {
        fail(
          "invalid_token_description",
          `${tokenPath}.description must be a string`,
        );
      }
      if (token.value === undefined) {
        fail("invalid_token_value", `${tokenPath}.value is required`);
      }
      tokenIds.add(token.id);
      names.add(token.name);
    }
    setIds.add(tokenSet.id);
    setNames.add(tokenSet.name);
  }
  const themeIds = new Set();
  const themePaths = new Set();
  for (const [themeIndex, themeValue] of library.themes.entries()) {
    const themePath = `${entry}.themes[${themeIndex}]`;
    const theme = requireRecord(
      themeValue,
      "invalid_token_theme",
      `${themePath} must contain an object`,
    );
    for (const field of Object.keys(theme)) {
      if (
        !new Set([
          "description",
          "externalId",
          "group",
          "id",
          "isSource",
          "name",
          "setIds",
        ]).has(field)
      ) {
        fail(
          "unsupported_token_theme_field",
          `${themePath}.${field} is unsupported`,
        );
      }
    }
    stableId(theme.id, "theme_", "invalid_token_theme_id", `${themePath}.id`);
    if (
      typeof theme.name !== "string" ||
      theme.name.length === 0 ||
      typeof theme.group !== "string" ||
      typeof theme.description !== "string" ||
      typeof theme.externalId !== "string" ||
      typeof theme.isSource !== "boolean" ||
      !Array.isArray(theme.setIds)
    ) {
      fail("invalid_token_theme", `${themePath} is invalid`);
    }
    const path = `${theme.group}/${theme.name}`;
    if (themeIds.has(theme.id) || themePaths.has(path)) {
      fail("duplicate_token_theme", `Duplicate Token Theme: ${theme.id}`);
    }
    if (
      new Set(theme.setIds).size !== theme.setIds.length ||
      theme.setIds.some((id) => !setIds.has(id))
    ) {
      fail("invalid_token_theme_sets", `${themePath}.setIds are invalid`);
    }
    themeIds.add(theme.id);
    themePaths.add(path);
  }
  for (const [field, ids, known] of [
    ["activeSetIds", library.activeSetIds, setIds],
    ["activeThemeIds", library.activeThemeIds, themeIds],
  ]) {
    if (
      !Array.isArray(ids) ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !known.has(id))
    ) {
      fail("invalid_token_activation", `${entry}.${field} is invalid`);
    }
  }
  return library;
}

function validateComponent(value, entry) {
  const component = requireRecord(
    value,
    "invalid_component",
    `Component entry must contain an object: ${entry}`,
  );
  if (Array.isArray(component.componentSets)) return component;
  const fields = new Set([
    "id",
    "mainNodeId",
    "name",
    "path",
    "presentationId",
    "screenId",
  ]);
  for (const field of Object.keys(component)) {
    if (!fields.has(field)) {
      fail("unsupported_component_field", `${entry}.${field} is unsupported`);
    }
  }
  stableId(component.id, "cmp_", "invalid_component_id", `${entry}.id`);
  stableId(
    component.mainNodeId,
    "node_",
    "invalid_node_id",
    `${entry}.mainNodeId`,
  );
  stableId(
    component.presentationId,
    "pres_",
    "invalid_presentation_id",
    `${entry}.presentationId`,
  );
  stableId(
    component.screenId,
    "scr_",
    "invalid_screen_id",
    `${entry}.screenId`,
  );
  if (typeof component.name !== "string" || component.name.length === 0) {
    fail("invalid_component_name", `${entry}.name must be non-empty`);
  }
  if (typeof component.path !== "string") {
    fail("invalid_component_path", `${entry}.path must be a string`);
  }
  return component;
}

function validateTextStyle(value, path) {
  const style = requireRecord(
    value,
    "invalid_text_style",
    `${path} must contain an object`,
  );
  for (const [field, fieldValue] of Object.entries(style)) {
    if (!TEXT_STYLE_FIELDS.has(field)) {
      fail("unsupported_text_style", `${path}.${field} is unsupported`);
    }
    if (
      ["fontSize", "fontWeight", "letterSpacing", "lineHeight"].includes(field)
    ) {
      finiteNumber(fieldValue, `${path}.${field}`);
      if (
        ["fontSize", "fontWeight", "lineHeight"].includes(field) &&
        fieldValue <= 0
      ) {
        fail("invalid_text_style", `${path}.${field} must be positive`);
      }
    } else if (field === "typographyRef") {
      if (isRecord(fieldValue)) {
        validateAssetReference(fieldValue, `${path}.${field}`, "typo_");
      } else {
        stableId(
          fieldValue,
          "typo_",
          "invalid_typography_id",
          `${path}.${field}`,
        );
      }
    } else if (["fontFamily", "fontId", "fontVariantId"].includes(field)) {
      if (typeof fieldValue !== "string" || fieldValue.length === 0) {
        fail("invalid_text_style", `${path}.${field} must be non-empty`);
      }
    } else if (!TEXT_STYLE_ENUMS[field]?.has(fieldValue)) {
      fail("invalid_text_style", `${path}.${field} is not supported`);
    }
  }
}

function validateTextBlocks(value, text, path) {
  if (!Array.isArray(value) || value.length === 0) {
    fail("invalid_text_blocks", `${path} must be a non-empty array`);
  }
  const paragraphs = value.map((blockValue, blockIndex) => {
    const blockPath = `${path}[${blockIndex}]`;
    const block = requireRecord(
      blockValue,
      "invalid_text_block",
      `${blockPath} must contain an object`,
    );
    for (const field of Object.keys(block)) {
      if (field !== "runs" && field !== "textStyle") {
        fail("unsupported_text_block", `${blockPath}.${field} is unsupported`);
      }
    }
    if (block.textStyle !== undefined) {
      validateTextStyle(block.textStyle, `${blockPath}.textStyle`);
    }
    if (!Array.isArray(block.runs) || block.runs.length === 0) {
      fail("invalid_text_runs", `${blockPath}.runs must be non-empty`);
    }
    return block.runs
      .map((runValue, runIndex) => {
        const runPath = `${blockPath}.runs[${runIndex}]`;
        const run = requireRecord(
          runValue,
          "invalid_text_run",
          `${runPath} must contain an object`,
        );
        for (const field of Object.keys(run)) {
          if (field !== "fills" && field !== "text" && field !== "textStyle") {
            fail("unsupported_text_run", `${runPath}.${field} is unsupported`);
          }
        }
        if (typeof run.text !== "string") {
          fail("invalid_text_run", `${runPath}.text must be a string`);
        }
        if (run.textStyle !== undefined) {
          validateTextStyle(run.textStyle, `${runPath}.textStyle`);
        }
        if (run.fills !== undefined) {
          validateFills(run.fills, `${runPath}.fills`);
        }
        return run.text;
      })
      .join("");
  });
  if (paragraphs.join("\n") !== text) {
    fail(
      "text_blocks_mismatch",
      `${path} does not reproduce the TEXT node's plain text`,
    );
  }
}

function validateCornerRadius(value, path) {
  const radii = typeof value === "number" ? [value] : value;
  if (!Array.isArray(radii) || (radii.length !== 1 && radii.length !== 4)) {
    fail(
      "invalid_corner_radius",
      `${path} must be a number or four-item array`,
      { path, value },
    );
  }
  for (const radius of radii) {
    if (typeof radius !== "number" || !Number.isFinite(radius) || radius < 0) {
      fail(
        "invalid_corner_radius",
        `${path} values must be finite non-negative numbers`,
        { path, value },
      );
    }
  }
}

function validateFills(value, path) {
  if (!Array.isArray(value)) {
    fail("invalid_node_fills", `${path} must be an array`, { path, value });
  }
  for (const [index, fillValue] of value.entries()) {
    const fillPath = `${path}[${index}]`;
    const fill = requireRecord(
      fillValue,
      "invalid_node_fill",
      `${fillPath} must contain an object`,
    );
    validatePaint(fill, fillPath);
  }
}

function validatePaintOpacity(value, path) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    fail("invalid_fill_opacity", `${path} must be between 0 and 1`);
  }
}

function validatePaint(paint, path, additionalFields = new Set()) {
  const gradient =
    paint.type === "linear-gradient" || paint.type === "radial-gradient";
  const image = paint.type === "image";
  const supportedFields = new Set(
    image
      ? ["mediaRef", "opacity", "type"]
      : gradient
        ? [
            "colorRef",
            "endX",
            "endY",
            "gradientWidth",
            "opacity",
            "startX",
            "startY",
            "stops",
            "type",
          ]
        : ["color", "colorRef", "opacity", "type"],
  );
  for (const field of additionalFields) supportedFields.add(field);
  if (!image && !gradient && paint.type !== "solid") {
    fail("unsupported_fill_type", `${path}.type is unsupported`, {
      path,
      type: paint.type,
    });
  }
  for (const field of Object.keys(paint)) {
    if (!supportedFields.has(field)) {
      fail("unsupported_fill_field", `${path}.${field} is unsupported`, {
        field,
        path,
      });
    }
  }
  if (image) {
    if (isRecord(paint.mediaRef)) {
      validateAssetReference(paint.mediaRef, `${path}.mediaRef`, "media_");
    } else {
      stableId(
        paint.mediaRef,
        "media_",
        "invalid_media_id",
        `${path}.mediaRef`,
      );
    }
  } else if (paint.colorRef !== undefined) {
    if (isRecord(paint.colorRef)) {
      validateAssetReference(paint.colorRef, `${path}.colorRef`, "color_");
    } else {
      stableId(
        paint.colorRef,
        "color_",
        "invalid_color_id",
        `${path}.colorRef`,
      );
    }
  }
  if (image) {
    // Media metadata is resolved from the local Asset Library.
  } else if (gradient) {
    for (const field of ["endX", "endY", "gradientWidth", "startX", "startY"]) {
      finiteNumber(paint[field], `${path}.${field}`);
    }
    if (!Array.isArray(paint.stops) || paint.stops.length === 0) {
      fail("invalid_gradient_stops", `${path}.stops must be non-empty`);
    }
    for (const [index, stopValue] of paint.stops.entries()) {
      const stopPath = `${path}.stops[${index}]`;
      const stop = requireRecord(
        stopValue,
        "invalid_gradient_stop",
        `${stopPath} must contain an object`,
      );
      for (const field of Object.keys(stop)) {
        if (!new Set(["color", "offset", "opacity"]).has(field)) {
          fail(
            "unsupported_gradient_stop",
            `${stopPath}.${field} is unsupported`,
          );
        }
      }
      if (typeof stop.color !== "string" || stop.color.length === 0) {
        fail("invalid_fill_color", `${stopPath}.color must be a string`);
      }
      finiteNumber(stop.offset, `${stopPath}.offset`);
      if (stop.offset < 0 || stop.offset > 1) {
        fail(
          "invalid_gradient_offset",
          `${stopPath}.offset must be between 0 and 1`,
        );
      }
      if (stop.opacity !== undefined) {
        validatePaintOpacity(stop.opacity, `${stopPath}.opacity`);
      }
    }
  } else if (typeof paint.color !== "string" || paint.color.length === 0) {
    fail("invalid_fill_color", `${path}.color must be a string`, {
      path,
      value: paint.color,
    });
  }
  if (paint.opacity !== undefined) {
    validatePaintOpacity(paint.opacity, `${path}.opacity`);
  }
}

function validateBinaryDescriptor(value, path, expectedMimeType) {
  const descriptor = requireRecord(
    value,
    "invalid_binary_descriptor",
    `${path} must contain an object`,
  );
  const fields = new Set(["blob", "byteLength", "mimeType", "sha256"]);
  if (
    Object.keys(descriptor).length !== fields.size ||
    Object.keys(descriptor).some((field) => !fields.has(field)) ||
    !Number.isSafeInteger(descriptor.byteLength) ||
    descriptor.byteLength <= 0 ||
    descriptor.mimeType !== expectedMimeType ||
    typeof descriptor.sha256 !== "string" ||
    !SHA256_PATTERN.test(descriptor.sha256) ||
    descriptor.blob !== `blobs/${descriptor.sha256}`
  ) {
    fail("invalid_binary_descriptor", `${path} is invalid`);
  }
  safeEntry(descriptor.blob);
  return descriptor;
}

function validateAssetLibrary(value, entry) {
  const library = requireRecord(
    value,
    "invalid_asset_library",
    `Asset entry must contain an object: ${entry}`,
  );
  for (const field of Object.keys(library)) {
    if (
      !new Set(["colors", "fonts", "id", "media", "typographies"]).has(field)
    ) {
      fail(
        "unsupported_asset_library_field",
        `${entry}.${field} is unsupported`,
      );
    }
  }
  stableId(library.id, "alib_", "invalid_asset_library_id", `${entry}.id`);
  if (
    !Array.isArray(library.colors) ||
    !Array.isArray(library.fonts) ||
    !Array.isArray(library.media) ||
    !Array.isArray(library.typographies)
  ) {
    fail(
      "invalid_asset_library",
      `${entry}.colors, fonts, media, and typographies must be arrays`,
    );
  }
  const colorIds = new Set();
  for (const [index, value] of library.colors.entries()) {
    const path = `${entry}.colors[${index}]`;
    const color = requireRecord(
      value,
      "invalid_library_color",
      `${path} must contain an object`,
    );
    for (const field of Object.keys(color)) {
      if (!new Set(["id", "name", "paint", "path"]).has(field)) {
        fail(
          "unsupported_library_color_field",
          `${path}.${field} is unsupported`,
        );
      }
    }
    stableId(color.id, "color_", "invalid_color_id", `${path}.id`);
    if (colorIds.has(color.id)) {
      fail("duplicate_color_id", `Duplicate Color id: ${color.id}`);
    }
    if (
      typeof color.name !== "string" ||
      color.name.length === 0 ||
      typeof color.path !== "string"
    ) {
      fail("invalid_library_color", `${path} name or path is invalid`);
    }
    const paint = requireRecord(
      color.paint,
      "invalid_library_color",
      `${path}.paint must contain an object`,
    );
    if (paint.colorRef !== undefined) {
      fail("nested_color_reference", `${path}.paint cannot reference a Color`);
    }
    validatePaint(paint, `${path}.paint`);
    colorIds.add(color.id);
  }
  const fontIds = new Set();
  const fontVariantIds = new Set();
  for (const [index, value] of library.fonts.entries()) {
    const path = `${entry}.fonts[${index}]`;
    const font = requireRecord(
      value,
      "invalid_library_font",
      `${path} must contain an object`,
    );
    const fields = new Set(["family", "id", "variants"]);
    if (
      Object.keys(font).length !== fields.size ||
      Object.keys(font).some((field) => !fields.has(field))
    ) {
      fail("invalid_library_font", `${path} fields are invalid`);
    }
    stableId(font.id, "font_", "invalid_font_id", `${path}.id`);
    if (fontIds.has(font.id)) {
      fail("duplicate_font_id", `Duplicate Font id: ${font.id}`);
    }
    if (
      typeof font.family !== "string" ||
      font.family.length === 0 ||
      font.family.length > 250 ||
      !/^[\p{L}\d _.-]+$/u.test(font.family) ||
      !Array.isArray(font.variants) ||
      font.variants.length === 0
    ) {
      fail("invalid_library_font", `${path} family or variants are invalid`);
    }
    for (const [variantIndex, variantValue] of font.variants.entries()) {
      const variantPath = `${path}.variants[${variantIndex}]`;
      const variant = requireRecord(
        variantValue,
        "invalid_font_variant",
        `${variantPath} must contain an object`,
      );
      const variantFields = new Set(["files", "id", "name", "style", "weight"]);
      if (
        Object.keys(variant).length !== variantFields.size ||
        Object.keys(variant).some((field) => !variantFields.has(field))
      ) {
        fail("invalid_font_variant", `${variantPath} fields are invalid`);
      }
      stableId(
        variant.id,
        "fvar_",
        "invalid_font_variant_id",
        `${variantPath}.id`,
      );
      if (fontVariantIds.has(variant.id)) {
        fail(
          "duplicate_font_variant_id",
          `Duplicate Font Variant id: ${variant.id}`,
        );
      }
      if (
        typeof variant.name !== "string" ||
        variant.name.length === 0 ||
        !FONT_WEIGHTS.has(variant.weight) ||
        !new Set(["italic", "normal"]).has(variant.style) ||
        !isRecord(variant.files) ||
        !Object.hasOwn(variant.files, "woff")
      ) {
        fail("invalid_font_variant", `${variantPath} is invalid`);
      }
      const fileTypes = {
        otf: "font/otf",
        ttf: "font/ttf",
        woff: "font/woff",
        woff2: "font/woff2",
      };
      for (const [format, file] of Object.entries(variant.files)) {
        const mimeType = fileTypes[format];
        if (!mimeType || !FONT_TYPES.has(mimeType)) {
          fail(
            "unsupported_font_file",
            `${variantPath}.files.${format} is unsupported`,
          );
        }
        validateBinaryDescriptor(
          file,
          `${variantPath}.files.${format}`,
          mimeType,
        );
      }
      fontVariantIds.add(variant.id);
    }
    fontIds.add(font.id);
  }
  const mediaIds = new Set();
  for (const [index, value] of library.media.entries()) {
    const path = `${entry}.media[${index}]`;
    const media = requireRecord(
      value,
      "invalid_library_media",
      `${path} must contain an object`,
    );
    const fields = new Set([
      "blob",
      "byteLength",
      "height",
      "id",
      "mimeType",
      "name",
      "path",
      "sha256",
      "width",
    ]);
    for (const field of Object.keys(media)) {
      if (!fields.has(field)) {
        fail(
          "unsupported_library_media_field",
          `${path}.${field} is unsupported`,
        );
      }
    }
    stableId(media.id, "media_", "invalid_media_id", `${path}.id`);
    if (mediaIds.has(media.id)) {
      fail("duplicate_media_id", `Duplicate Media id: ${media.id}`);
    }
    if (
      typeof media.name !== "string" ||
      media.name.length === 0 ||
      typeof media.path !== "string" ||
      !Number.isSafeInteger(media.width) ||
      media.width <= 0 ||
      !Number.isSafeInteger(media.height) ||
      media.height <= 0 ||
      !Number.isSafeInteger(media.byteLength) ||
      media.byteLength < 0 ||
      !MEDIA_TYPES.has(media.mimeType) ||
      typeof media.sha256 !== "string" ||
      !SHA256_PATTERN.test(media.sha256) ||
      media.blob !== `blobs/${media.sha256}`
    ) {
      fail("invalid_library_media", `${path} is invalid`);
    }
    safeEntry(media.blob);
    mediaIds.add(media.id);
  }
  const typographyIds = new Set();
  for (const [index, value] of library.typographies.entries()) {
    const path = `${entry}.typographies[${index}]`;
    const typography = requireRecord(
      value,
      "invalid_library_typography",
      `${path} must contain an object`,
    );
    for (const field of Object.keys(typography)) {
      if (!new Set(["id", "name", "path", "style"]).has(field)) {
        fail(
          "unsupported_library_typography_field",
          `${path}.${field} is unsupported`,
        );
      }
    }
    stableId(typography.id, "typo_", "invalid_typography_id", `${path}.id`);
    if (typographyIds.has(typography.id)) {
      fail(
        "duplicate_typography_id",
        `Duplicate Typography id: ${typography.id}`,
      );
    }
    if (
      typeof typography.name !== "string" ||
      typography.name.length === 0 ||
      typeof typography.path !== "string"
    ) {
      fail("invalid_library_typography", `${path} name or path is invalid`);
    }
    validateTextStyle(typography.style, `${path}.style`);
    const styleFields = Object.keys(typography.style);
    if (
      styleFields.length !== TYPOGRAPHY_STYLE_FIELDS.size ||
      styleFields.some((field) => !TYPOGRAPHY_STYLE_FIELDS.has(field))
    ) {
      fail(
        "invalid_library_typography",
        `${path}.style must contain every Typography style field`,
      );
    }
    typographyIds.add(typography.id);
  }
  return library;
}

function validateStrokes(value, path) {
  if (!Array.isArray(value)) {
    fail("invalid_node_strokes", `${path} must be an array`);
  }
  const strokeFields = new Set([
    "alignment",
    "capEnd",
    "capStart",
    "dash",
    "gap",
    "hidden",
    "style",
    "width",
  ]);
  for (const [index, strokeValue] of value.entries()) {
    const strokePath = `${path}[${index}]`;
    const stroke = requireRecord(
      strokeValue,
      "invalid_node_stroke",
      `${strokePath} must contain an object`,
    );
    validatePaint(stroke, strokePath, strokeFields);
    if (stroke.width !== undefined) {
      finiteNumber(stroke.width, `${strokePath}.width`);
      if (stroke.width < 0) {
        fail("invalid_stroke_width", `${strokePath}.width cannot be negative`);
      }
    }
    if (
      stroke.alignment !== undefined &&
      !new Set(["center", "inner", "outer"]).has(stroke.alignment)
    ) {
      fail(
        "invalid_stroke_alignment",
        `${strokePath}.alignment is unsupported`,
      );
    }
    if (
      stroke.style !== undefined &&
      !new Set(["dashed", "dotted", "mixed", "solid"]).has(stroke.style)
    ) {
      fail("invalid_stroke_style", `${strokePath}.style is unsupported`);
    }
    for (const field of ["dash", "gap"]) {
      if (stroke[field] !== undefined)
        finiteNumber(stroke[field], `${strokePath}.${field}`);
    }
    for (const field of ["capStart", "capEnd"]) {
      if (
        stroke[field] !== undefined &&
        !new Set([
          "circle-marker",
          "diamond-marker",
          "line-arrow",
          "round",
          "square",
          "square-marker",
          "triangle-arrow",
        ]).has(stroke[field])
      ) {
        fail("invalid_stroke_cap", `${strokePath}.${field} is unsupported`);
      }
    }
    if (stroke.hidden !== undefined && typeof stroke.hidden !== "boolean") {
      fail("invalid_stroke_visibility", `${strokePath}.hidden must be boolean`);
    }
  }
}

function validateNodeChange(field, value, nodeId) {
  const path = `${nodeId}.${field}`;
  if (value === null && OPTIONAL_NODE_FIELDS.has(field)) return;
  if (field === "appliedTokens") {
    validateAppliedTokens(value, path);
  } else if (field === "cornerRadius") {
    validateCornerRadius(value, path);
  } else if (field === "fills") {
    validateFills(value, path);
  } else if (field === "flipX" || field === "flipY") {
    if (typeof value !== "boolean") {
      fail("invalid_node_flip", `${path} must be boolean`);
    }
  } else if (field === "growType") {
    if (!TEXT_GROW_TYPES.has(value)) {
      fail("invalid_text_grow_type", `${path} is not a supported grow type`);
    }
  } else if (
    new Set([
      "hide-fill-on-export",
      "hide-in-viewer",
      "masked-group",
      "show-content",
    ]).has(field)
  ) {
    if (typeof value !== "boolean") {
      fail("invalid_node_boolean", `${path} must be boolean`);
    }
  } else if (field === "blend-mode") {
    if (typeof value !== "string" || value.length === 0) {
      fail("invalid_blend_mode", `${path} must be a non-empty string`);
    }
  } else if (field === "grids") {
    if (!Array.isArray(value) || value.some((grid) => !isRecord(grid))) {
      fail("invalid_grids", `${path} must be an array of objects`);
    }
  } else if (field === "interactions") {
    if (
      !Array.isArray(value) ||
      value.some((interaction) => !isRecord(interaction))
    ) {
      fail("invalid_node_interactions", `${path} must be an array of objects`);
    }
  } else if (field === "locked" || field === "proportionLock") {
    if (typeof value !== "boolean") {
      fail("invalid_node_boolean", `${path} must be boolean`);
    }
  } else if (field === "strokes") {
    validateStrokes(value, path);
  } else if (["shadow", "blur", "backgroundBlur"].includes(field)) {
    if (!(
      (Array.isArray(value) && value.every((entry) => isRecord(entry))) ||
      isRecord(value)
    )) {
      fail(
        "invalid_node_effect",
        `${path} must be an object or array of objects`,
      );
    }
  } else if (
    ["layout-gap", "layout-padding", "layout-item-margin"].includes(field)
  ) {
    if (!isRecord(value))
      fail("invalid_node_layout", `${path} must be an object`);
  } else if (field === "exports") {
    if (!Array.isArray(value))
      fail("invalid_node_export", `${path} must be an array`);
  } else if (["layout-item-absolute", "fixed-scroll"].includes(field)) {
    if (typeof value !== "boolean")
      fail("invalid_node_layout", `${path} must be boolean`);
  } else if (
    [
      "layout-item-max-h",
      "layout-item-min-h",
      "layout-item-max-w",
      "layout-item-min-w",
      "layout-item-z-index",
    ].includes(field)
  ) {
    finiteNumber(value, path);
  } else if (["constraints-h", "constraints-v"].includes(field)) {
    if (!(typeof value === "string" || isRecord(value)))
      fail("invalid_node_constraints", `${path} must be a string or object`);
  } else if (field.startsWith("layout")) {
    if (typeof value !== "string")
      fail("invalid_node_layout", `${path} must be a string`);
  } else if (["height", "width", "x", "y"].includes(field)) {
    finiteNumber(value, path);
  } else if (field === "mediaRef") {
    if (isRecord(value)) {
      validateAssetReference(value, path, "media_");
    } else {
      stableId(value, "media_", "invalid_media_id", path);
    }
  } else if (field === "name") {
    validateNodeName(value, path);
  } else if (field === "opacity") {
    finiteNumber(value, path);
    if (value < 0 || value > 1) {
      fail("invalid_opacity", "Node opacity must be between 0 and 1");
    }
  } else if (field === "rotation") {
    finiteNumber(value, path);
    if (value < 0 || value >= 360) {
      fail("invalid_node_rotation", `${path} must be between 0 and 360`);
    }
  } else if (field === "visible") {
    validateNodeVisibility(value, path);
  } else if (field === "text") {
    if (typeof value !== "string") {
      fail("invalid_text_content", `${path} must be a string`);
    }
  } else if (field === "textBlocks") {
    if (!Array.isArray(value)) {
      fail("invalid_text_blocks", `${path} must be an array`);
    }
  } else if (field === "textStyle") {
    validateTextStyle(value, path);
  } else if (field === "tokenBindings") {
    validateTokenBindings(value, path);
  } else if (field === "touched") {
    validateTouched(value, path);
  }
}

function presentationRootIds(presentation) {
  if (Array.isArray(presentation.rootIds)) return presentation.rootIds;
  return typeof presentation.rootId === "string" ? [presentation.rootId] : [];
}

function setPresentationRootIds(presentation, rootIds) {
  if (rootIds.length === 1) {
    presentation.rootId = rootIds[0];
    delete presentation.rootIds;
    return;
  }
  presentation.rootId = rootIds[0] ?? null;
  presentation.rootIds = [...rootIds];
}

function scalar(value) {
  return (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  );
}

function validateInteractionAction(actionValue, path, nodes) {
  const action = requireRecord(
    actionValue,
    "invalid_interaction_action",
    `${path} must contain an object`,
  );
  if (action.type === "navigate") {
    const fields = new Set(["presentationId", "screen", "type"]);
    if (Object.keys(action).some((field) => !fields.has(field))) {
      fail("unsupported_interaction_action", `${path} fields are invalid`);
    }
    validateAssetReference(action.screen, `${path}.screen`, "scr_");
    if (
      action.presentationId !== undefined &&
      (typeof action.presentationId !== "string" ||
        !action.presentationId.startsWith("pres_"))
    ) {
      fail("invalid_interaction_action", `${path}.presentationId is invalid`);
    }
    return;
  }
  if (action.type === "set-state") {
    if (
      Object.keys(action).length !== 3 ||
      typeof action.stateKey !== "string" ||
      action.stateKey.length === 0 ||
      !scalar(action.value)
    ) {
      fail("invalid_interaction_action", `${path} set-state is invalid`);
    }
    return;
  }
  if (action.type === "set-visibility") {
    if (
      Object.keys(action).length !== 3 ||
      typeof action.nodeId !== "string" ||
      !nodes[action.nodeId] ||
      typeof action.visible !== "boolean"
    ) {
      fail("invalid_interaction_action", `${path} set-visibility is invalid`);
    }
    return;
  }
  fail(
    "unsupported_interaction_action",
    `${path} must use a finite declarative action`,
  );
}

function validateInteractions(value, path, nodes) {
  if (!Array.isArray(value)) {
    fail("invalid_interactions", `${path} must be an array`);
  }
  const ids = new Set();
  for (const [index, interactionValue] of value.entries()) {
    const interactionPath = `${path}[${index}]`;
    const interaction = requireRecord(
      interactionValue,
      "invalid_interaction",
      `${interactionPath} must contain an object`,
    );
    const fields = new Set([
      "action",
      "condition",
      "id",
      "intentId",
      "name",
      "sourceNodeId",
      "trigger",
    ]);
    if (Object.keys(interaction).some((field) => !fields.has(field))) {
      fail("invalid_interaction", `${interactionPath} fields are invalid`);
    }
    stableId(
      interaction.id,
      "int_",
      "invalid_interaction_id",
      `${interactionPath}.id`,
    );
    if (ids.has(interaction.id)) {
      fail(
        "duplicate_interaction_id",
        `Duplicate Interaction id: ${interaction.id}`,
      );
    }
    ids.add(interaction.id);
    if (typeof interaction.name !== "string" || interaction.name.length === 0) {
      fail(
        "invalid_interaction_name",
        `${interactionPath}.name must be non-empty`,
      );
    }
    stableId(
      interaction.sourceNodeId,
      "node_",
      "invalid_node_id",
      `${interactionPath}.sourceNodeId`,
    );
    if (!nodes[interaction.sourceNodeId]) {
      fail(
        "missing_interaction_source",
        `${interactionPath}.sourceNodeId does not exist`,
      );
    }
    if (
      interaction.intentId !== undefined &&
      (typeof interaction.intentId !== "string" ||
        !interaction.intentId.startsWith("intent_"))
    ) {
      fail(
        "invalid_interaction_intent",
        `${interactionPath}.intentId is invalid`,
      );
    }
    if (!new Set(["activate", "change", "submit"]).has(interaction.trigger)) {
      fail(
        "invalid_interaction_trigger",
        `${interactionPath}.trigger is unsupported`,
      );
    }
    if (interaction.condition !== undefined) {
      const condition = requireRecord(
        interaction.condition,
        "invalid_interaction_condition",
        `${interactionPath}.condition must contain an object`,
      );
      if (
        Object.keys(condition).length !== 3 ||
        typeof condition.stateKey !== "string" ||
        condition.stateKey.length === 0 ||
        !new Set(["equals", "not-equals"]).has(condition.operator) ||
        !scalar(condition.value)
      ) {
        fail(
          "invalid_interaction_condition",
          `${interactionPath}.condition is invalid`,
        );
      }
    }
    validateInteractionAction(
      interaction.action,
      `${interactionPath}.action`,
      nodes,
    );
  }
}

function validatePrototypeFlows(value, path, nodes) {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    fail("invalid_prototype_flows", `${path} must be an array`);
  }
  const ids = new Set();
  for (const [index, flowValue] of value.entries()) {
    const flowPath = `${path}[${index}]`;
    const flow = requireRecord(
      flowValue,
      "invalid_prototype_flow",
      `${flowPath} must contain an object`,
    );
    if (
      Object.keys(flow).length !== 3 ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        flow.id,
      ) ||
      typeof flow.name !== "string" ||
      flow.name.length === 0
    ) {
      fail("invalid_prototype_flow", `${flowPath} is invalid`);
    }
    if (ids.has(flow.id)) {
      fail(
        "duplicate_prototype_flow",
        `Duplicate Prototype Flow id: ${flow.id}`,
      );
    }
    ids.add(flow.id);
    stableId(
      flow.startingNodeId,
      "node_",
      "invalid_node_id",
      `${flowPath}.startingNodeId`,
    );
    if (
      !nodes[flow.startingNodeId] ||
      nodes[flow.startingNodeId].type !== "FRAME"
    ) {
      fail(
        "invalid_prototype_flow_start",
        `${flowPath}.startingNodeId must identify a FRAME`,
      );
    }
  }
}

function validatePresentation(screen, presentation, path) {
  requireRecord(
    presentation,
    "invalid_presentation",
    `${path} must contain an object`,
  );
  stableId(presentation.id, "pres_", "invalid_presentation_id", `${path}.id`);
  if (typeof presentation.name !== "string" || presentation.name.length === 0) {
    fail(
      "invalid_presentation_name",
      `${path}.name must be a non-empty string`,
    );
  }
  if (
    !isRecord(presentation.viewport) ||
    typeof presentation.viewport.width !== "number" ||
    !Number.isFinite(presentation.viewport.width) ||
    presentation.viewport.width <= 0 ||
    typeof presentation.viewport.height !== "number" ||
    !Number.isFinite(presentation.viewport.height) ||
    presentation.viewport.height <= 0
  ) {
    fail(
      "invalid_presentation_viewport",
      `${path}.viewport must contain positive finite width and height`,
    );
  }
  if (
    presentation.platform !== undefined &&
    (typeof presentation.platform !== "string" ||
      presentation.platform.length === 0)
  ) {
    fail("invalid_presentation_platform", `${path}.platform is invalid`);
  }
  for (const field of ["background", "pixel-grid-color"]) {
    if (
      presentation[field] !== undefined &&
      typeof presentation[field] !== "string"
    ) {
      fail("invalid_presentation_color", `${path}.${field} must be a string`);
    }
  }
  if (
    presentation["pixel-grid-opacity"] !== undefined &&
    (typeof presentation["pixel-grid-opacity"] !== "number" ||
      !Number.isFinite(presentation["pixel-grid-opacity"]) ||
      presentation["pixel-grid-opacity"] < 0 ||
      presentation["pixel-grid-opacity"] > 1)
  ) {
    fail(
      "invalid_presentation_opacity",
      `${path}.pixel-grid-opacity must be between zero and one`,
    );
  }
  const nodes = requireRecord(
    presentation.nodes,
    "invalid_presentation_nodes",
    `${path}.nodes must contain an object`,
  );
  let rootIds;
  if (presentation.rootIds === undefined) {
    if (typeof presentation.rootId !== "string") {
      fail("invalid_presentation_root", `${path}.rootId must be a string`);
    }
    rootIds = [presentation.rootId];
  } else {
    if (!Array.isArray(presentation.rootIds)) {
      fail("invalid_presentation_roots", `${path}.rootIds must be an array`);
    }
    if (presentation.rootIds.length === 1) {
      fail(
        "noncanonical_presentation_roots",
        `${path} must use rootId for a single root`,
      );
    }
    if (new Set(presentation.rootIds).size !== presentation.rootIds.length) {
      fail(
        "duplicate_presentation_root",
        `${path}.rootIds must not contain duplicates`,
      );
    }
    rootIds = presentation.rootIds;
    const expectedRootId = rootIds[0] ?? null;
    if (presentation.rootId !== expectedRootId) {
      fail(
        "presentation_root_mismatch",
        `${path}.rootId must identify the first rootId`,
      );
    }
  }
  for (const rootId of rootIds) {
    if (typeof rootId !== "string" || !isRecord(nodes[rootId])) {
      fail(
        "missing_root_node",
        `Presentation root node does not exist: ${String(rootId)}`,
      );
    }
  }

  const parents = new Map();
  for (const [nodeId, value] of Object.entries(nodes)) {
    stableId(nodeId, "node_", "invalid_node_id", `${path}.nodes.${nodeId}`);
    const node = requireRecord(
      value,
      "invalid_node",
      `${path}.nodes.${nodeId} must contain an object`,
    );
    if (node.id !== nodeId)
      fail("node_id_mismatch", `Node key and id differ: ${nodeId}`);
    if (!NODE_TYPES.has(node.type))
      fail("unsupported_node_type", `Unsupported node type: ${node.type}`);
    validateNodeName(node.name, `${path}.nodes.${nodeId}.name`);
    for (const field of ["x", "y", "width", "height"])
      finiteNumber(node[field], `${path}.nodes.${nodeId}.${field}`);
    if (node.opacity !== undefined) {
      finiteNumber(node.opacity, `${path}.nodes.${nodeId}.opacity`);
      if (node.opacity < 0 || node.opacity > 1) {
        fail(
          "invalid_opacity",
          `Node opacity must be between 0 and 1: ${nodeId}`,
        );
      }
    }
    if (node.rotation !== undefined) {
      finiteNumber(node.rotation, `${path}.nodes.${nodeId}.rotation`);
      if (node.rotation < 0 || node.rotation >= 360) {
        fail(
          "invalid_node_rotation",
          `Node rotation must be between 0 and 360: ${nodeId}`,
        );
      }
    }
    for (const field of ["flipX", "flipY"]) {
      if (node[field] !== undefined && typeof node[field] !== "boolean") {
        fail(
          "invalid_node_flip",
          `${path}.nodes.${nodeId}.${field} must be boolean`,
        );
      }
    }
    if (node.visible !== undefined) {
      validateNodeVisibility(node.visible, `${path}.nodes.${nodeId}.visible`);
    }
    for (const field of ["locked", "proportionLock"]) {
      if (node[field] !== undefined && typeof node[field] !== "boolean") {
        fail(
          "invalid_node_boolean",
          `${path}.nodes.${nodeId}.${field} must be boolean`,
        );
      }
    }
    for (const field of [
      "blend-mode",
      "grids",
      "hide-fill-on-export",
      "hide-in-viewer",
      "masked-group",
      "show-content",
    ]) {
      if (node[field] !== undefined) {
        validateNodeChange(field, node[field], nodeId);
      }
    }
    if (node.cornerRadius !== undefined) {
      validateCornerRadius(
        node.cornerRadius,
        `${path}.nodes.${nodeId}.cornerRadius`,
      );
    }
    if (node.fills !== undefined) {
      validateFills(node.fills, `${path}.nodes.${nodeId}.fills`);
    }
    if (node.strokes !== undefined) {
      validateStrokes(node.strokes, `${path}.nodes.${nodeId}.strokes`);
    }
    if (node.appliedTokens !== undefined) {
      validateAppliedTokens(
        node.appliedTokens,
        `${path}.nodes.${nodeId}.appliedTokens`,
      );
    }
    if (node.tokenBindings !== undefined) {
      validateTokenBindings(
        node.tokenBindings,
        `${path}.nodes.${nodeId}.tokenBindings`,
      );
    }
    if (node.touched !== undefined) {
      validateTouched(node.touched, `${path}.nodes.${nodeId}.touched`);
    }
    for (const [field, prefix] of [
      ["componentId", "cmp_"],
      ["mediaRef", "media_"],
      ["sourceNodeId", "node_"],
    ]) {
      if (node[field] !== undefined) {
        if (
          (field === "componentId" || field === "mediaRef") &&
          isRecord(node[field])
        ) {
          validateAssetReference(
            node[field],
            `${path}.nodes.${nodeId}.${field}`,
            prefix,
          );
        } else {
          stableId(
            node[field],
            prefix,
            field === "componentId"
              ? "invalid_component_id"
              : field === "mediaRef"
                ? "invalid_media_id"
                : "invalid_node_id",
            `${path}.nodes.${nodeId}.${field}`,
          );
        }
      }
    }
    if (node.componentVariantId !== undefined) {
      stableId(
        node.componentVariantId,
        "var_",
        "invalid_variant_id",
        `${path}.nodes.${nodeId}.componentVariantId`,
      );
      if (node.type !== "INSTANCE" || node.componentId === undefined) {
        fail(
          "invalid_component_variant",
          `${path}.nodes.${nodeId}.componentVariantId requires an Instance`,
        );
      }
    }
    if (node.instance !== undefined) {
      if (node.type !== "INSTANCE" || node.componentId !== undefined) {
        fail(
          "invalid_component_instance",
          `${path}.nodes.${nodeId} cannot mix domain and located Component forms`,
        );
      }
      validateDomainInstance(node.instance, `${path}.nodes.${nodeId}.instance`);
    } else if (
      (node.type === "COMPONENT" || node.type === "INSTANCE") !==
      (node.componentId !== undefined)
    ) {
      fail(
        "invalid_component_node",
        `${path}.nodes.${nodeId} must pair its component type and componentId`,
      );
    }
    if (
      node.type === "INSTANCE" &&
      node.instance === undefined &&
      node.sourceNodeId === undefined
    ) {
      fail(
        "missing_component_source",
        `${path}.nodes.${nodeId} must identify its sourceNodeId`,
      );
    }
    if ((node.type === "IMAGE") !== (node.mediaRef !== undefined)) {
      fail(
        "invalid_image_node",
        `${path}.nodes.${nodeId} must pair IMAGE type and mediaRef`,
      );
    }
    if (node.type === "TEXT") {
      if (typeof node.text !== "string") {
        fail(
          "invalid_text_content",
          `${path}.nodes.${nodeId}.text must be a string`,
        );
      }
      if (node.growType !== undefined && !TEXT_GROW_TYPES.has(node.growType)) {
        fail(
          "invalid_text_grow_type",
          `${path}.nodes.${nodeId}.growType is not supported`,
        );
      }
      if (node.textStyle !== undefined) {
        validateTextStyle(node.textStyle, `${path}.nodes.${nodeId}.textStyle`);
      }
      if (node.textBlocks !== undefined) {
        validateTextBlocks(
          node.textBlocks,
          node.text,
          `${path}.nodes.${nodeId}.textBlocks`,
        );
      }
    } else if (
      node.text !== undefined ||
      node.textBlocks !== undefined ||
      node.growType !== undefined ||
      node.textStyle !== undefined
    ) {
      fail(
        "unexpected_text_attribute",
        `Only TEXT nodes can contain text attributes: ${nodeId}`,
      );
    }
    if (node.children !== undefined && !Array.isArray(node.children)) {
      fail(
        "invalid_node_children",
        `Node children must be an array: ${nodeId}`,
      );
    }
    for (const childId of node.children ?? []) {
      if (!isRecord(nodes[childId]))
        fail("missing_child_node", `Node child does not exist: ${childId}`);
      if (parents.has(childId))
        fail(
          "multiple_node_parents",
          `Node has more than one parent: ${childId}`,
        );
      parents.set(childId, nodeId);
    }
  }
  for (const rootId of rootIds) {
    if (parents.has(rootId)) {
      fail(
        "root_node_has_parent",
        `Presentation root node has a parent: ${rootId}`,
      );
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(nodeId) {
    if (visiting.has(nodeId))
      fail("node_cycle", `Node tree contains a cycle at: ${nodeId}`);
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const childId of nodes[nodeId].children ?? []) visit(childId);
    visiting.delete(nodeId);
    visited.add(nodeId);
  }
  for (const rootId of rootIds) visit(rootId);
  if (visited.size !== Object.keys(nodes).length) {
    fail(
      "orphan_node",
      `Presentation contains nodes outside its root tree: ${screen.id}`,
    );
  }
  validateInteractions(
    presentation.interactions,
    `${path}.interactions`,
    nodes,
  );
  validatePrototypeFlows(
    presentation.prototypeFlows,
    `${path}.prototypeFlows`,
    nodes,
  );
}

function screenPresentation(
  snapshotEntries,
  manifest,
  screenId,
  presentationId,
) {
  const entry = manifest.entries.screens.find(
    (candidate) => snapshotEntries[candidate].id === screenId,
  );
  const screen = entry ? snapshotEntries[entry] : undefined;
  return screen?.presentations.find(({ id }) => id === presentationId);
}

function validateComponentReferences(manifest, entries) {
  const components = new Map();
  const componentSets = new Map();
  const masterNodes = new Map();
  for (const entry of manifest.entries.components) {
    const component = entries[entry];
    if (Array.isArray(component.componentSets)) {
      for (const componentSet of component.componentSets) {
        componentSets.set(componentSet.id, componentSet);
      }
      continue;
    }
    if (components.has(component.id)) {
      fail("duplicate_component_id", `Duplicate Component id: ${component.id}`);
    }
    const presentation = screenPresentation(
      entries,
      manifest,
      component.screenId,
      component.presentationId,
    );
    const main = presentation?.nodes[component.mainNodeId];
    if (
      !main ||
      main.type !== "COMPONENT" ||
      main.componentId !== component.id
    ) {
      fail(
        "invalid_component_main",
        `Component main node is missing or inconsistent: ${component.id}`,
      );
    }
    if (masterNodes.has(component.mainNodeId)) {
      fail(
        "duplicate_component_main",
        `Component main node is indexed twice: ${component.mainNodeId}`,
      );
    }
    components.set(component.id, { component, presentation });
    masterNodes.set(component.mainNodeId, component.id);
  }

  function indexMasterSubtree(
    componentId,
    presentation,
    nodeId,
    parentSourceId,
    result,
  ) {
    const node = presentation.nodes[nodeId];
    if (
      nodeId !== result.rootId &&
      (node.type === "COMPONENT" || node.type === "INSTANCE")
    ) {
      fail(
        "unsupported_nested_component",
        `Nested component structures are not supported yet: ${nodeId}`,
      );
    }
    result.nodes.set(nodeId, { node, parentSourceId });
    for (const childId of node.children ?? []) {
      indexMasterSubtree(componentId, presentation, childId, nodeId, result);
    }
  }

  const masters = new Map();
  for (const [componentId, { component, presentation }] of components) {
    const result = { nodes: new Map(), rootId: component.mainNodeId };
    indexMasterSubtree(
      componentId,
      presentation,
      component.mainNodeId,
      null,
      result,
    );
    masters.set(componentId, result);
  }

  for (const entry of manifest.entries.screens) {
    const screen = entries[entry];
    for (const presentation of screen.presentations) {
      const parents = new Map();
      const copyIds = new Set();
      for (const node of Object.values(presentation.nodes)) {
        for (const childId of node.children ?? [])
          parents.set(childId, node.id);
      }
      for (const node of Object.values(presentation.nodes)) {
        if (node.type === "COMPONENT") {
          const component = components.get(node.componentId)?.component;
          if (
            !component ||
            component.mainNodeId !== node.id ||
            component.presentationId !== presentation.id ||
            component.screenId !== screen.id
          ) {
            fail(
              "invalid_component_main",
              `Unindexed Component node: ${node.id}`,
            );
          }
        }
        if (node.type !== "INSTANCE" || node.instance !== undefined) continue;
        let master = masters.get(node.componentId);
        if (node.componentVariantId !== undefined) {
          const componentSet = componentSets.get(node.componentId);
          const variant = componentSet?.variants.find(
            ({ id }) => id === node.componentVariantId,
          );
          if (variant) {
            master = { nodes: new Map(), rootId: variant.rootId };
            indexMasterSubtree(
              componentSet.id,
              { nodes: variant.nodes },
              variant.rootId,
              null,
              master,
            );
          } else if (!isRecord(node.componentId)) {
            fail(
              "invalid_component_source",
              `Invalid Instance source: ${node.id}`,
            );
          }
        }
        const external = isRecord(node.componentId);
        if (
          (!external && !master) ||
          (master && node.sourceNodeId !== master.rootId) ||
          (external && node.sourceNodeId === undefined)
        ) {
          fail(
            "invalid_component_source",
            `Invalid Instance source: ${node.id}`,
          );
        }
        const visitCopy = (copyId, expectedParentSourceId) => {
          const copy = presentation.nodes[copyId];
          const source = master?.nodes.get(copy.sourceNodeId);
          if (
            copy.sourceNodeId === undefined ||
            (master &&
              (!source || source.parentSourceId !== expectedParentSourceId))
          ) {
            fail("invalid_component_source", `Invalid copy source: ${copyId}`);
          }
          const expectedType = source
            ? copyId === node.id || source.node.type === "COMPONENT"
              ? "INSTANCE"
              : source.node.type
            : undefined;
          if (expectedType !== undefined && copy.type !== expectedType) {
            fail(
              "component_copy_type_mismatch",
              `Component copy type does not match its source: ${copyId}`,
            );
          }
          copyIds.add(copyId);
          if (copyId !== node.id && copy.componentId !== undefined) {
            fail(
              "unsupported_nested_component",
              `Nested component structures are not supported yet: ${copyId}`,
            );
          }
          for (const childId of copy.children ?? []) {
            visitCopy(childId, copy.sourceNodeId);
          }
        };
        visitCopy(node.id, null);
        if (parents.has(node.id)) {
          let ancestorId = parents.get(node.id);
          while (ancestorId) {
            if (presentation.nodes[ancestorId].type === "INSTANCE") {
              fail(
                "unsupported_nested_component",
                `Nested component structures are not supported yet: ${node.id}`,
              );
            }
            ancestorId = parents.get(ancestorId);
          }
        }
      }
      for (const node of Object.values(presentation.nodes)) {
        if (node.sourceNodeId !== undefined && !copyIds.has(node.id)) {
          fail(
            "unexpected_component_source",
            `Only component copies can identify a sourceNodeId: ${node.id}`,
          );
        }
        if (node.sourceNodeId === undefined && node.touched !== undefined) {
          fail(
            "unexpected_component_touched",
            `Only component copies can contain touched groups: ${node.id}`,
          );
        }
      }
    }
  }
}

function validateAppliedTokenReferences(manifest, entries, domain) {
  const tokenNames = new Set();
  for (const entry of manifest.entries.tokens) {
    for (const tokenSet of entries[entry].sets ?? []) {
      for (const token of tokenSet.tokens) tokenNames.add(token.name);
    }
  }
  for (const token of domain.tokens.values()) tokenNames.add(token.path);
  for (const entry of manifest.entries.screens) {
    const screen = entries[entry];
    for (const presentation of screen.presentations) {
      for (const node of Object.values(presentation.nodes)) {
        for (const tokenName of Object.values(node.appliedTokens ?? {})) {
          if (!tokenNames.has(tokenName)) {
            fail(
              "missing_applied_token",
              `Applied Token does not exist: ${tokenName}`,
              { nodeId: node.id, tokenName },
            );
          }
        }
      }
    }
  }
}

function validateAssetReferences(manifest, entries) {
  const colorIds = new Set();
  const fontIds = new Set();
  const mediaIds = new Set();
  const typographyIds = new Set();
  for (const entry of manifest.entries.assets) {
    const library = entries[entry];
    for (const color of library.colors) colorIds.add(color.id);
    for (const font of library.fonts) fontIds.add(font.id);
    for (const media of library.media) mediaIds.add(media.id);
    for (const typography of library.typographies) {
      typographyIds.add(typography.id);
    }
  }
  const validateStyle = (style, nodeId) => {
    if (style?.fontId?.startsWith("font_") && !fontIds.has(style.fontId)) {
      fail(
        "missing_font_reference",
        `Custom Font reference does not exist: ${style.fontId}`,
        { fontId: style.fontId, nodeId },
      );
    }
    if (
      typeof style?.typographyRef === "string" &&
      !typographyIds.has(style.typographyRef)
    ) {
      fail(
        "missing_typography_reference",
        `Typography reference does not exist: ${style.typographyRef}`,
        { nodeId },
      );
    }
  };
  const validatePaintReference = (paint, nodeId) => {
    if (typeof paint.colorRef === "string" && !colorIds.has(paint.colorRef)) {
      fail(
        "missing_color_reference",
        `Color reference does not exist: ${paint.colorRef}`,
        { nodeId },
      );
    }
    if (
      typeof paint.mediaRef === "string" &&
      !mediaIds.has(paint.mediaRef)
    ) {
      fail(
        "missing_media_reference",
        `Media reference does not exist: ${paint.mediaRef}`,
        { nodeId },
      );
    }
  };
  for (const entry of manifest.entries.assets) {
    for (const color of entries[entry].colors) {
      validatePaintReference(color.paint, color.id);
    }
  }
  for (const entry of manifest.entries.screens) {
    for (const presentation of entries[entry].presentations) {
      for (const node of Object.values(presentation.nodes)) {
        if (
          typeof node.mediaRef === "string" &&
          !mediaIds.has(node.mediaRef)
        ) {
          fail(
            "missing_media_reference",
            `Media reference does not exist: ${node.mediaRef}`,
            { nodeId: node.id },
          );
        }
        for (const paint of [...(node.fills ?? []), ...(node.strokes ?? [])]) {
          validatePaintReference(paint, node.id);
        }
        validateStyle(node.textStyle, node.id);
        for (const block of node.textBlocks ?? []) {
          validateStyle(block.textStyle, node.id);
          for (const run of block.runs) {
            validateStyle(run.textStyle, node.id);
            for (const paint of run.fills ?? []) {
              validatePaintReference(paint, node.id);
            }
          }
        }
      }
    }
  }
}

async function validateBlobValues(manifest, entries, values) {
  const blobs = new Map();
  const hashes = new Map();
  const descriptors = [];
  for (const entry of manifest.entries.assets) {
    for (const media of entries[entry].media) {
      descriptors.push({ descriptor: media, id: media.id, kind: "Media" });
    }
    for (const font of entries[entry].fonts) {
      for (const variant of font.variants) {
        for (const [format, descriptor] of Object.entries(variant.files)) {
          descriptors.push({
            descriptor,
            id: `${font.id}/${variant.id}/${format}`,
            kind: "Font",
          });
        }
      }
    }
  }
  const blobKinds = new Map(
    descriptors.map(({ descriptor, kind }) => [descriptor.blob, kind]),
  );
  for (const [path, value] of values) {
    if (!path.startsWith("blobs/")) continue;
    safeEntry(path);
    if (!/^blobs\/[a-f0-9]{64}$/.test(path) || !(value instanceof Uint8Array)) {
      fail(
        "invalid_media_blob",
        `Invalid content-addressed Media blob: ${path}`,
      );
    }
    const digest = await sha256Hex(value);
    if (path !== `blobs/${digest}`) {
      const kind = blobKinds.get(path) ?? "Binary";
      fail(
        `${kind.toLowerCase()}_blob_hash_mismatch`,
        `Content-addressed ${kind} blob has the wrong path: ${path}`,
        { actual: digest, expected: path.slice("blobs/".length) },
      );
    }
    hashes.set(path, digest);
    blobs.set(path, new Uint8Array(value));
  }
  for (const { descriptor, id, kind } of descriptors) {
    const prefix = kind.toLowerCase();
    const value = values.get(descriptor.blob);
    if (!(value instanceof Uint8Array)) {
      fail(
        `missing_${prefix}_blob`,
        `${kind} blob is missing: ${descriptor.blob}`,
        { blob: descriptor.blob, id, kind },
      );
    }
    if (value.byteLength !== descriptor.byteLength) {
      fail(
        `${prefix}_blob_size_mismatch`,
        `${kind} blob size does not match its descriptor: ${id}`,
        {
          actual: value.byteLength,
          expected: descriptor.byteLength,
          id,
          kind,
        },
      );
    }
    let digest = hashes.get(descriptor.blob);
    if (!digest) {
      digest = await sha256Hex(value);
      hashes.set(descriptor.blob, digest);
    }
    if (digest !== descriptor.sha256) {
      fail(
        `${prefix}_blob_hash_mismatch`,
        `${kind} blob hash does not match its descriptor: ${id}`,
        { actual: digest, expected: descriptor.sha256, id, kind },
      );
    }
  }
  return blobs;
}

function validateScreen(value, entry) {
  const screen = requireRecord(
    value,
    "invalid_screen",
    `Screen entry must contain an object: ${entry}`,
  );
  stableId(screen.id, "scr_", "invalid_screen_id", `${entry}.id`);
  if (typeof screen.name !== "string" || screen.name.length === 0) {
    fail("invalid_screen_name", `${entry}.name must be a non-empty string`);
  }
  if (
    !Array.isArray(screen.presentations) ||
    screen.presentations.length === 0
  ) {
    fail(
      "invalid_presentations",
      `Screen must contain at least one Presentation: ${entry}`,
    );
  }
  const ids = new Set();
  for (const [index, presentation] of screen.presentations.entries()) {
    validatePresentation(
      screen,
      presentation,
      `${entry}.presentations[${index}]`,
    );
    if (ids.has(presentation.id))
      fail(
        "duplicate_presentation_id",
        `Duplicate Presentation id: ${presentation.id}`,
      );
    ids.add(presentation.id);
  }
  if (!ids.has(screen.basePresentationId)) {
    fail(
      "invalid_base_presentation",
      `Base Presentation is not indexed by Screen: ${screen.id}`,
    );
  }
  if (!Array.isArray(screen.counterparts)) {
    fail("invalid_counterparts", `${entry}.counterparts must be an array`);
  }
  const counterpartIds = new Set();
  const presentations = new Map(
    screen.presentations.map((presentation) => [presentation.id, presentation]),
  );
  for (const [index, counterpartValue] of screen.counterparts.entries()) {
    const path = `${entry}.counterparts[${index}]`;
    const counterpart = requireRecord(
      counterpartValue,
      "invalid_counterpart",
      `${path} must contain an object`,
    );
    if (
      Object.keys(counterpart).length !== 3 ||
      !Object.hasOwn(counterpart, "from") ||
      !Object.hasOwn(counterpart, "id") ||
      !Object.hasOwn(counterpart, "to")
    ) {
      fail("invalid_counterpart", `${path} fields are invalid`);
    }
    stableId(
      counterpart.id,
      "counterpart_",
      "invalid_counterpart_id",
      `${path}.id`,
    );
    if (counterpartIds.has(counterpart.id)) {
      fail(
        "duplicate_counterpart_id",
        `Duplicate Counterpart id: ${counterpart.id}`,
      );
    }
    counterpartIds.add(counterpart.id);
    for (const endpointName of ["from", "to"]) {
      const endpointPath = `${path}.${endpointName}`;
      const endpoint = requireRecord(
        counterpart[endpointName],
        "invalid_counterpart_endpoint",
        `${endpointPath} must contain an object`,
      );
      if (
        Object.keys(endpoint).length !== 2 ||
        typeof endpoint.presentationId !== "string" ||
        typeof endpoint.nodeId !== "string"
      ) {
        fail("invalid_counterpart_endpoint", `${endpointPath} is invalid`);
      }
      const presentation = presentations.get(endpoint.presentationId);
      if (!presentation?.nodes[endpoint.nodeId]) {
        fail(
          "missing_counterpart_endpoint",
          `${endpointPath} does not identify a Presentation node`,
          { endpoint, path: endpointPath },
        );
      }
    }
  }
  return screen;
}

function runtimeUuidFromStableId(stableValue, prefix) {
  const match = new RegExp(`^${prefix}([a-f0-9]{32})$`, "i").exec(stableValue);
  if (!match) return null;
  const hex = match[1].toLowerCase();
  const uuid = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    uuid,
  )
    ? uuid
    : null;
}

function runtimeUuidFromNodeId(nodeId) {
  return runtimeUuidFromStableId(nodeId, "node_");
}

function runtimeUuidFromPresentationId(presentationId) {
  return runtimeUuidFromNodeId(presentationId.replace(/^pres_/, "node_"));
}

const DTCG_RUNTIME_TOKEN_SET_ID = "smallpen:dtcg";

// DSE-004: stable, deterministic source identities for the generated
// Design System page. Both the Web projection (frontend shapes) and the
// Penpot change adapter (write-back translation) consume these refs, so a
// specimen resolves to the same Token Cell on both sides. Only the
// package's OWN token library is referenced: linked libraries are
// read-only and must never become write targets.
function tokenLibraryEntry(manifest, entries) {
  for (const entry of manifest.entries.tokens) {
    const value = entries[entry];
    if (Array.isArray(value?.sets) && Array.isArray(value?.themes)) {
      return value;
    }
  }
  return null;
}

// Attribute a projected Token Cell display binds for direct edits.
// DSE-R19~R24/R26: EVERY canonical type binds at least one native attribute
// (or the scalar "value"/"content" path), so a locally-owned Cell of any of
// the 20 supported types has a real editing path on the generated page and
// none of them can be degraded to read-only by missing UI wiring.
function designSystemTokenAttribute(type) {
  switch (type) {
    case "color":
      return "fill";
    case "border-radius":
      return "radius";
    case "sizing":
      return "height";
    case "spacing":
      return "gap";
    case "stroke-width":
      return "stroke-width";
    case "shadow":
      return "shadow";
    case "opacity":
      return "opacity";
    case "rotation":
      return "rotation";
    case "dimensions":
      return "dimensions";
    case "font-size":
      return "font-size";
    case "letter-spacing":
      return "letter-spacing";
    case "font-family":
      return "font-family";
    case "font-weight":
      return "font-weight";
    case "text-case":
      return "text-transform";
    case "text-decoration":
      return "text-decoration";
    case "typography":
      return "typography";
    case "boolean":
    case "number":
    case "string":
    case "other":
      return "value";
    default:
      return null;
  }
}

// DSE-R18/R26: the valid Workbench Combinations declared by a token library
// — the cartesian product of the Paired Themes grouped per Token Domain.
// Nothing is fabricated: domains and variants come verbatim from the source
// themes; a library without themes yields exactly one "default" combination.
// The product is capped to keep pathological packages from flooding the
// panorama; hitting the cap records a diagnostic instead of silently
// sampling.
const MAX_WORKBENCH_COMBINATIONS = 64;

function listWorkbenchCombinations(library) {
  const domains = new Map();
  for (const theme of library.themes ?? []) {
    const domain = String(theme.group ?? "");
    if (!domains.has(domain)) domains.set(domain, []);
    domains.get(domain).push(theme);
  }
  const capped = { capped: false };
  const domainEntries = [...domains.entries()].sort(([a], [b]) =>
    a < b ? -1 : 1,
  );
  let combos = [
    { selection: [], setIds: [], themeIds: [], variantCountByDomain: {} },
  ];
  for (const [domain, variants] of domainEntries) {
    const next = [];
    for (const combo of combos) {
      for (const theme of variants) {
        next.push({
          selection: [
            ...combo.selection,
            { domain, themeId: theme.id, themeName: theme.name },
          ],
          setIds: [...combo.setIds, ...(theme.setIds ?? [])],
          themeIds: [...combo.themeIds, theme.id],
          variantCountByDomain: {
            ...combo.variantCountByDomain,
            [domain]: variants.length,
          },
        });
      }
    }
    if (next.length > MAX_WORKBENCH_COMBINATIONS) {
      capped.capped = true;
      next.length = MAX_WORKBENCH_COMBINATIONS;
    }
    combos = next;
  }
  const combinations = combos.map((combo) => {
    const varying = combo.selection.filter(
      (part) => combo.variantCountByDomain[part.domain] > 1,
    );
    return {
      id:
        combo.themeIds.length === 1
          ? combo.themeIds[0]
          : combo.themeIds.join("+"),
      label:
        varying.length > 0
          ? varying.map((part) => part.themeName).join(" · ")
          : "Default",
      selection: combo.selection,
      setIds: combo.setIds,
      themeIds: combo.themeIds,
    };
  });
  return { combinations, capped: capped.capped };
}

// Alias chain resolver inside one package token library: "{path}" looks up
// the token by NAME across the library sets (declaration order). Cycles and
// depth overruns return the raw value with a diagnostic status instead of
// throwing, so one broken alias can not break the whole panorama.
function resolveTokenCellAlias(library, raw) {
  let value = raw;
  let resolvedFrom = null;
  const seen = new Set();
  for (let depth = 0; depth < 8; depth += 1) {
    const match =
      typeof value === "string" ? /^\{([^{}]+)\}$/.exec(value) : null;
    if (!match) return { resolved: value, resolvedFrom };
    const path = match[1];
    if (seen.has(path)) return { resolved: value, resolvedFrom, cycle: true };
    seen.add(path);
    const target = (library.sets ?? [])
      .flatMap((set) => set.tokens ?? [])
      .find((token) => token.name === path);
    if (!target) return { resolved: value, resolvedFrom, unresolved: true };
    resolvedFrom = target.id;
    value = target.$value ?? target.value;
  }
  return { resolved: value, resolvedFrom, unresolved: true };
}

// DSE-R09/R10: EVERY Cell of every set in the package's token library —
// literal, alias, archived, typography, unknown — with a stable shape id and
// its display/edit contract. Literal Cells of a spec-supported type are
// direct write targets; alias Cells and typography Cells are visible
// displays that FAIL edits with a precise code (alias expressions must be
// replaced via the Token tooling, DSE-016, never overwritten from a shape).
function designSystemTokenRefs(manifest, entries) {
  const library = tokenLibraryEntry(manifest, entries);
  if (!library) return [];
  const refs = [];
  const activeSetIds = new Set(library.activeSetIds ?? []);
  let index = 0;
  for (const set of library.sets) {
    for (const token of set.tokens ?? []) {
      const type = String(token.type ?? "");
      const value = token.$value ?? token.value;
      // Alias syntax is exactly "{path}" with no nested braces — the same
      // strict shape the resolver accepts. A JSON-string `other` Cell with
      // inner braces is a literal, not an alias reference.
      const alias =
        typeof value === "string" && /^\{[^{}]+\}$/.test(value.trim());
      const attribute = designSystemTokenAttribute(type);
      refs.push({
        ownerPackageId: manifest.packageId,
        order: index,
        path: token.name,
        raw: value,
        setId: set.id,
        setName: set.name,
        status: activeSetIds.has(set.id) ? "active" : "archived",
        tokenId: token.id,
        type,
        value,
        attribute,
        // Direct edits only for literal Cells whose type maps to an
        // editable shape attribute; everything else displays and fails.
        writable: attribute !== null && !alias,
        alias,
      });
      index += 1;
    }
  }
  return refs;
}

async function createRuntime(manifest, entries, domain, locator) {
  const runtime = {
    colors: {},
    components: {},
    componentNodes: {},
    componentsPage: await stableRuntimeUuid(
      manifest.packageId,
      "components-page",
      manifest.packageId,
    ),
    designSystemPage: await stableRuntimeUuid(
      manifest.packageId,
      "design-system-page",
      manifest.packageId,
    ),
    designSystem: {
      board: await stableRuntimeUuid(
        manifest.packageId,
        "design-system-board",
        manifest.packageId,
      ),
      tokenLabel: await stableRuntimeUuid(
        manifest.packageId,
        "design-system-token-label",
        manifest.packageId,
      ),
      tokensSection: await stableRuntimeUuid(
        manifest.packageId,
        "design-system-tokens-section",
        manifest.packageId,
      ),
      componentsSection: await stableRuntimeUuid(
        manifest.packageId,
        "design-system-components-section",
        manifest.packageId,
      ),
      pagesSection: await stableRuntimeUuid(
        manifest.packageId,
        "design-system-pages-section",
        manifest.packageId,
      ),
      tokensEmpty: await stableRuntimeUuid(
        manifest.packageId,
        "design-system-tokens-empty",
        manifest.packageId,
      ),
      componentsEmpty: await stableRuntimeUuid(
        manifest.packageId,
        "design-system-components-empty",
        manifest.packageId,
      ),
      pagesEmpty: await stableRuntimeUuid(
        manifest.packageId,
        "design-system-pages-empty",
        manifest.packageId,
      ),
    },
    fontFiles: {},
    fonts: {},
    fontVariants: {},
    file: await stableRuntimeUuid(manifest.packageId, "file", locator),
    media: {},
    mediaStorage: {},
    nodes: {},
    pages: {},
    project: await stableRuntimeUuid(
      manifest.packageId,
      "project",
      manifest.packageId,
    ),
    reverseNodes: {},
    reversePages: {},
    reverseDesignSystem: {},
    reverseComponents: {},
    reverseComponentNodes: {},
    reverseVariants: {},
    reverseColors: {},
    reverseFontFiles: {},
    reverseFonts: {},
    reverseFontVariants: {},
    reverseMedia: {},
    reverseTokenSets: {},
    reverseTokenThemes: {},
    reverseTokens: {},
    reverseTypographies: {},
    team: await stableRuntimeUuid(
      manifest.packageId,
      "team",
      manifest.packageId,
    ),
    tokenSets: {},
    tokenThemes: {},
    tokens: {},
    typographies: {},
    variants: {},
  };
  const runtimeOwners = new Map([
    [runtime.file, `file:${manifest.packageId}`],
    [runtime.project, `project:${manifest.packageId}`],
    [runtime.team, `team:${manifest.packageId}`],
    [runtime.componentsPage, `components-page:${manifest.packageId}`],
    [runtime.designSystemPage, `design-system-page:${manifest.packageId}`],
  ]);
  function registerRuntimeId(runtimeId, owner) {
    if (runtimeOwners.has(runtimeId)) {
      fail("runtime_id_collision", `Runtime UUID collision: ${owner}`, {
        existingOwner: runtimeOwners.get(runtimeId),
        owner,
        runtimeId,
      });
    }
    runtimeOwners.set(runtimeId, owner);
  }
  for (const entry of manifest.entries.assets) {
    const library = entries[entry];
    for (const color of library.colors) {
      const runtimeId =
        runtimeUuidFromStableId(color.id, "color_") ??
        (await stableRuntimeUuid(manifest.packageId, "color", color.id));
      registerRuntimeId(runtimeId, `color:${color.id}`);
      runtime.colors[color.id] = runtimeId;
      runtime.reverseColors[runtimeId] = { colorId: color.id };
    }
    for (const font of library.fonts) {
      const fontRuntimeId =
        runtimeUuidFromStableId(font.id, "font_") ??
        (await stableRuntimeUuid(manifest.packageId, "font", font.id));
      registerRuntimeId(fontRuntimeId, `font:${font.id}`);
      runtime.fonts[font.id] = fontRuntimeId;
      runtime.reverseFonts[fontRuntimeId] = { fontId: font.id };
      for (const variant of font.variants) {
        const variantRuntimeId =
          runtimeUuidFromStableId(variant.id, "fvar_") ??
          (await stableRuntimeUuid(
            manifest.packageId,
            "font-variant",
            `${font.id}\0${variant.id}`,
          ));
        registerRuntimeId(variantRuntimeId, `font-variant:${variant.id}`);
        runtime.fontVariants[variant.id] = variantRuntimeId;
        runtime.reverseFontVariants[variantRuntimeId] = {
          fontId: font.id,
          fontVariantId: variant.id,
        };
        runtime.fontFiles[variant.id] = {};
        for (const format of Object.keys(variant.files).sort()) {
          const fileRuntimeId = await stableRuntimeUuid(
            manifest.packageId,
            "font-file",
            `${font.id}\0${variant.id}\0${format}`,
          );
          registerRuntimeId(
            fileRuntimeId,
            `font-file:${font.id}/${variant.id}/${format}`,
          );
          runtime.fontFiles[variant.id][format] = fileRuntimeId;
          runtime.reverseFontFiles[fileRuntimeId] = {
            fontId: font.id,
            fontVariantId: variant.id,
            format,
          };
        }
      }
    }
    for (const typography of library.typographies) {
      const runtimeId =
        runtimeUuidFromStableId(typography.id, "typo_") ??
        (await stableRuntimeUuid(
          manifest.packageId,
          "typography",
          typography.id,
        ));
      registerRuntimeId(runtimeId, `typography:${typography.id}`);
      runtime.typographies[typography.id] = runtimeId;
      runtime.reverseTypographies[runtimeId] = {
        typographyId: typography.id,
      };
    }
    for (const media of library.media) {
      const runtimeId =
        runtimeUuidFromStableId(media.id, "media_") ??
        (await stableRuntimeUuid(manifest.packageId, "media", media.id));
      const storageRuntimeId = await stableRuntimeUuid(
        manifest.packageId,
        "media-storage",
        media.id,
      );
      registerRuntimeId(runtimeId, `media:${media.id}`);
      registerRuntimeId(storageRuntimeId, `media-storage:${media.id}`);
      runtime.media[media.id] = runtimeId;
      runtime.mediaStorage[media.id] = storageRuntimeId;
      runtime.reverseMedia[runtimeId] = { mediaId: media.id };
    }
  }
  for (const entry of manifest.entries.tokens) {
    const library = entries[entry];
    for (const tokenSet of library.sets ?? []) {
      const setRuntimeId =
        runtimeUuidFromStableId(tokenSet.id, "tset_") ??
        (await stableRuntimeUuid(manifest.packageId, "token-set", tokenSet.id));
      registerRuntimeId(setRuntimeId, `token-set:${tokenSet.id}`);
      runtime.tokenSets[tokenSet.id] = setRuntimeId;
      runtime.reverseTokenSets[setRuntimeId] = { tokenSetId: tokenSet.id };
      for (const token of tokenSet.tokens) {
        const tokenRuntimeId =
          runtimeUuidFromStableId(token.id, "tok_") ??
          (await stableRuntimeUuid(manifest.packageId, "token", token.id));
        registerRuntimeId(tokenRuntimeId, `token:${token.id}`);
        runtime.tokens[token.id] = tokenRuntimeId;
        runtime.reverseTokens[tokenRuntimeId] = {
          tokenId: token.id,
          tokenSetId: tokenSet.id,
        };
      }
    }
    for (const theme of library.themes ?? []) {
      const themeRuntimeId =
        runtimeUuidFromStableId(theme.id, "theme_") ??
        (await stableRuntimeUuid(manifest.packageId, "token-theme", theme.id));
      registerRuntimeId(themeRuntimeId, `token-theme:${theme.id}`);
      runtime.tokenThemes[theme.id] = themeRuntimeId;
      runtime.reverseTokenThemes[themeRuntimeId] = { tokenThemeId: theme.id };
    }
  }
  const unownedTokens = [...domain.tokens.values()].filter(
    (token) => !runtime.tokens[token.id],
  );
  if (unownedTokens.length > 0) {
    const tokenSetRuntimeId = await stableRuntimeUuid(
      manifest.packageId,
      "token-set",
      DTCG_RUNTIME_TOKEN_SET_ID,
    );
    registerRuntimeId(
      tokenSetRuntimeId,
      `token-set:${DTCG_RUNTIME_TOKEN_SET_ID}`,
    );
    runtime.dtcgTokenSet = tokenSetRuntimeId;
    runtime.tokenSets[DTCG_RUNTIME_TOKEN_SET_ID] = tokenSetRuntimeId;
    runtime.reverseTokenSets[tokenSetRuntimeId] = {
      tokenSetId: DTCG_RUNTIME_TOKEN_SET_ID,
    };
  }
  for (const token of unownedTokens) {
    const tokenRuntimeId =
      runtimeUuidFromStableId(token.id, "tok_") ??
      (await stableRuntimeUuid(manifest.packageId, "token", token.id));
    registerRuntimeId(tokenRuntimeId, `token:${token.id}`);
    runtime.tokens[token.id] = tokenRuntimeId;
    runtime.reverseTokens[tokenRuntimeId] = {
      tokenId: token.id,
      tokenSetId: DTCG_RUNTIME_TOKEN_SET_ID,
    };
  }
  for (const entry of manifest.entries.components) {
    const component = entries[entry];
    const componentValues = Array.isArray(component.componentSets)
      ? component.componentSets
      : [component];
    for (const componentValue of componentValues) {
      const runtimeId =
        runtimeUuidFromStableId(componentValue.id, "cmp_") ??
        (await stableRuntimeUuid(
          manifest.packageId,
          "component",
          componentValue.id,
        ));
      registerRuntimeId(runtimeId, `component:${componentValue.id}`);
      runtime.components[componentValue.id] = runtimeId;
      runtime.reverseComponents[runtimeId] = {
        componentId: componentValue.id,
      };
      if (!Array.isArray(componentValue.variants)) continue;
      // Penpot models every variant as its own component with its own main
      // instance shapes, so each variant and each of its nodes needs a runtime
      // UUID. Variant node ids repeat across variants, so the full
      // set/variant/node path is always used instead of the embedded form.
      runtime.variants[componentValue.id] = {};
      runtime.componentNodes[componentValue.id] = {};
      for (const variant of componentValue.variants) {
        const variantRuntimeId = await stableRuntimeUuid(
          manifest.packageId,
          "component-variant",
          `${componentValue.id}\0${variant.id}`,
        );
        registerRuntimeId(variantRuntimeId, `component-variant:${variant.id}`);
        runtime.variants[componentValue.id][variant.id] = variantRuntimeId;
        runtime.reverseVariants[variantRuntimeId] = {
          componentId: componentValue.id,
          variantId: variant.id,
        };
        runtime.componentNodes[componentValue.id][variant.id] = {};
        for (const nodeId of Object.keys(variant.nodes)) {
          const nodeRuntimeId = await stableRuntimeUuid(
            manifest.packageId,
            "component-node",
            `${componentValue.id}\0${variant.id}\0${nodeId}`,
          );
          registerRuntimeId(nodeRuntimeId, `component-node:${nodeId}`);
          runtime.componentNodes[componentValue.id][variant.id][nodeId] =
            nodeRuntimeId;
          runtime.reverseComponentNodes[nodeRuntimeId] = {
            componentId: componentValue.id,
            nodeId,
            variantId: variant.id,
          };
        }
      }
    }
  }
  for (const entry of manifest.entries.screens) {
    const screen = entries[entry];
    runtime.nodes[screen.id] = {};
    runtime.pages[screen.id] = {};
    for (const presentation of screen.presentations) {
      runtime.nodes[screen.id][presentation.id] = {};
      const pageRuntimeId =
        runtimeUuidFromPresentationId(presentation.id) ??
        (await stableRuntimeUuid(
          manifest.packageId,
          "presentation",
          `${screen.id}\0${presentation.id}`,
        ));
      registerRuntimeId(pageRuntimeId, `presentation:${presentation.id}`);
      runtime.pages[screen.id][presentation.id] = pageRuntimeId;
      runtime.reversePages[pageRuntimeId] = {
        presentationId: presentation.id,
        screenId: screen.id,
      };
      for (const nodeId of Object.keys(presentation.nodes)) {
        const runtimeId =
          runtimeUuidFromNodeId(nodeId) ??
          (await stableRuntimeUuid(
            manifest.packageId,
            "node",
            `${screen.id}\0${presentation.id}\0${nodeId}`,
          ));
        registerRuntimeId(runtimeId, `node:${nodeId}`);
        runtime.nodes[screen.id][presentation.id][nodeId] = runtimeId;
        runtime.reverseNodes[runtimeId] = {
          nodeId,
          presentationId: presentation.id,
          screenId: screen.id,
        };
      }
    }
  }
  // DSE-004: register the generated Design System page's editable shapes so
  // the change adapter can translate native edits back to their source
  // (Token Cell / component definition). Decorations (board, label)
  // intentionally get NO entry: the adapter rejects writes to unmapped
  // shapes on this page, which is the isolation gate (DSE-005).
  {
    const specimens = {};
    const refs = {
      specimens,
    };
    // DSE-R18/R26: the source-declared valid Workbench Combinations and the
    // 20-type catalog travel with the refs so the projection can lay out one
    // column per combination and one section per canonical type without
    // re-deriving any of it client-side.
    const library = tokenLibraryEntry(manifest, entries);
    const tokenRefs = designSystemTokenRefs(manifest, entries);
    let combinations = [];
    let combinationCellIndex = new Map();
    if (library) {
      const { combinations: listed, capped } = listWorkbenchCombinations(
        library,
      );
      combinations = listed;
      if (capped) {
        refs.diagnostics = [
          {
            code: "combination_product_capped",
            message: `Workbench Combination product exceeded ${MAX_WORKBENCH_COMBINATIONS}; the panorama keeps the first ${MAX_WORKBENCH_COMBINATIONS}.`,
          },
        ];
      }
      const domainSetIds = new Set(
        (library.themes ?? []).flatMap((theme) => theme.setIds ?? []),
      );
      const activeSetIds = new Set(library.activeSetIds ?? []);
      const allCombinationIds = combinations.map((combo) => combo.id);
      for (const ref of tokenRefs) {
        let combinationIds;
        if (domainSetIds.has(ref.setId)) {
          combinationIds = combinations
            .filter((combo) => combo.setIds.includes(ref.setId))
            .map((combo) => combo.id);
        } else if (activeSetIds.has(ref.setId)) {
          // Active sets that no domain claims belong to every combination
          // observation (createWorkbenchPreview keeps activeSetIds on).
          combinationIds = allCombinationIds;
        } else {
          combinationIds = [];
        }
        combinationCellIndex.set(ref.tokenId, combinationIds);
        const { resolved, resolvedFrom, unresolved, cycle } =
          resolveTokenCellAlias(library, ref.raw);
        ref.resolved = resolved;
        ref.resolvedFrom = resolvedFrom;
        ref.unresolvedAlias = unresolved === true;
        ref.aliasCycle = cycle === true;
        ref.combinationIds = combinationIds;
      }
    }
    refs.combinations = combinations;
    // One specimen shape per (Cell × combination-in-view): the panorama
    // materializes every valid combination side by side, so a Cell active in
    // N combinations carries N shapes, all mapping back to the SAME Cell.
    // With at most one combination (or legacy refs without combinations) the
    // plain `design-system-specimen:<tokenId>` id is kept.
    const specimenKeyOf = (tokenId, combinationId) =>
      combinations.length > 1 ? `${tokenId}@${combinationId}` : tokenId;
    const multiCombination = combinations.length > 1;
    const tokenGroups = new Map();
    const typeCatalog = new Map(
      SMALLPEN_FORMAT_CAPABILITIES.canonicalPackage.tokenTypes.map(
        (type) => [type, { cells: 0, type }],
      ),
    );
    for (const candidate of tokenRefs) {
      const { attribute, alias } = candidate;
      if (typeCatalog.has(candidate.type)) {
        typeCatalog.get(candidate.type).cells += 1;
      }
      const combinationIds = multiCombination
        ? (candidate.combinationIds?.length
            ? candidate.combinationIds
            : [null])
        : [null];
      for (const combinationId of combinationIds) {
        const key = specimenKeyOf(candidate.tokenId, combinationId);
        const shape = await stableRuntimeUuid(
          manifest.packageId,
          "design-system-specimen",
          key,
        );
        registerRuntimeId(shape, `design-system-specimen:${key}`);
        const caption = await stableRuntimeUuid(
          manifest.packageId,
          "design-system-specimen-caption",
          key,
        );
        registerRuntimeId(
          caption,
          `design-system-specimen-caption:${key}`,
        );
        runtime.reverseDesignSystem[caption] = { kind: "label" };
        const ref = {
          ...candidate,
          attribute,
          caption,
          combinationId,
          shape,
          // DSE-R26: literal Cells of every supported type are editable
          // write targets (attribute- or value-path); alias Cells keep their
          // expression display-only for shape edits — the expression itself
          // is edited through the token-value path (Token inspector).
          writable: attribute !== null && !alias,
          alias,
        };
        if (attribute === "gap" && ref.writable) {
          // Spacing specimens visualize the gap with two filler rects; the
          // fillers are mapped as decoration so editing them is rejected with
          // a precise message instead of an unknown-shape error.
          ref.children = [];
          for (const childIndex of [0, 1]) {
            const child = await stableRuntimeUuid(
              manifest.packageId,
              "design-system-specimen-child",
              `${key}\0${childIndex}`,
            );
            registerRuntimeId(
              child,
              `design-system-specimen-child:${key}/${childIndex}`,
            );
            ref.children.push(child);
            runtime.reverseDesignSystem[child] = {
              kind: "specimen-child",
              ownerPackageId: candidate.ownerPackageId,
              tokenId: candidate.tokenId,
            };
          }
        }
        specimens[key] = ref;
        runtime.reverseDesignSystem[shape] = {
          kind: "token-cell",
          ...ref,
        };
      }
      const groupKey = [
        candidate.ownerPackageId,
        candidate.setId,
        candidate.type,
      ].join("\0");
      if (!tokenGroups.has(groupKey)) {
        const header = await stableRuntimeUuid(
          manifest.packageId,
          "design-system-token-group",
          groupKey,
        );
        registerRuntimeId(header, `design-system-token-group:${groupKey}`);
        runtime.reverseDesignSystem[header] = { kind: "label" };
        tokenGroups.set(groupKey, {
          header,
          ownerPackageId: candidate.ownerPackageId,
          setId: candidate.setId,
          setName: candidate.setName,
          type: candidate.type,
        });
      }
    }
    refs.tokenGroups = [...tokenGroups.values()];
    refs.types = [...typeCatalog.values()];
    // DSE-R18: Cells whose type is outside the canonical 20 are diagnosed,
    // never folded into the catalog as a 21st type.
    refs.unknownTypes = tokenRefs
      .filter((ref) => !typeCatalog.has(ref.type))
      .map((ref) => ({ path: ref.path, tokenId: ref.tokenId, type: ref.type }));
    refs.specimenKeysByToken = {};
    for (const key of Object.keys(specimens)) {
      const tokenId = specimens[key].tokenId;
      (refs.specimenKeysByToken[tokenId] ??= []).push(key);
    }
    // DSE-R17/R25: stable decoration ids for the combination column shells
    // (the floating controller focuses one combination by zooming to its
    // shell) and the 20-type catalog labels (the panorama gutter). Shells
    // and labels are presentation-only and map as labels: edits no-op.
    runtime.designSystem.combinations = {};
    for (const combo of combinations) {
      const shell = await stableRuntimeUuid(
        manifest.packageId,
        "design-system-combination-shell",
        combo.id,
      );
      registerRuntimeId(
        shell,
        `design-system-combination-shell:${combo.id}`,
      );
      runtime.designSystem.combinations[combo.id] = shell;
    }
    runtime.designSystem.types = {};
    for (const type of SMALLPEN_FORMAT_CAPABILITIES.canonicalPackage
      .tokenTypes) {
      const label = await stableRuntimeUuid(
        manifest.packageId,
        "design-system-type-label",
        type,
      );
      registerRuntimeId(label, `design-system-type-label:${type}`);
      runtime.designSystem.types[type] = label;
    }
    // DSE-R09/R11: FULL component family catalog for the generated page —
    // every Component Set variant and every located (mainNodeId) component,
    // with no first-with-TEXT sampling and no white/unused filtering. Board
    // copies of located trees reuse the source screen node runtime ids, so
    // native edits on the copy resolve to that very node (no second id
    // space, no duplicated source). Captions are presentation-only and map
    // as decoration so text reflow riding along with a commit is a no-op.
    const familyLabel = (set, variant) => {
      const parts = (set.axes ?? [])
        .map((axis) => {
          const value = variant.selection?.[axis.id];
          return value === undefined || value === null
            ? null
            : `${axis.name}=${value}`;
        })
        .filter((part) => part !== null);
      return parts.length > 0
        ? `${set.name} · ${parts.join(", ")}`
        : (set.name ?? "Component");
    };
    const families = [];
    {
      const setEntries = [];
      for (const entry of manifest.entries.components) {
        const value = entries[entry];
        if (!Array.isArray(value?.componentSets)) continue;
        for (const set of value.componentSets) setEntries.push(set);
      }
      setEntries.sort((left, right) =>
        String(left.id) < String(right.id) ? -1 : 1,
      );
      for (const set of setEntries) {
        for (const [variantIndex, variant] of (set.variants ?? []).entries()) {
          const caption = await stableRuntimeUuid(
            manifest.packageId,
            "design-system-component-caption",
            `${set.id}\0${variant.id}`,
          );
          registerRuntimeId(
            caption,
            `design-system-component-caption:${set.id}/${variant.id}`,
          );
          runtime.reverseDesignSystem[caption] = { kind: "label" };
          families.push({
            caption,
            componentSetId: set.id,
            kind: "variant",
            label: familyLabel(set, variant),
            rootId: variant.rootId,
            variantId: variant.id,
            variantIndex,
          });
        }
      }
    }
    {
      const locatedEntries = [...(domain.locatedComponents ?? new Map())];
      locatedEntries.sort(([left], [right]) => (left < right ? -1 : 1));
      for (const [componentId, component] of locatedEntries) {
        const caption = await stableRuntimeUuid(
          manifest.packageId,
          "design-system-component-caption",
          `${componentId}\0main`,
        );
        registerRuntimeId(
          caption,
          `design-system-component-caption:${componentId}/main`,
        );
        runtime.reverseDesignSystem[caption] = { kind: "label" };
        const family = {
          caption,
          componentId,
          kind: "located",
          label: component.name,
          mainNodeId: component.mainNodeId,
          nodeCount: 0,
          presentationId: component.presentationId,
          screenId: component.screenId,
        };
        const screenEntry = manifest.entries.screens.find(
          (candidate) => entries[candidate].id === component.screenId,
        );
        const presentation = screenEntry
          ? entries[screenEntry].presentations?.find(
              ({ id }) => id === component.presentationId,
            )
          : null;
        if (presentation?.nodes?.[component.mainNodeId]) {
          const stack = [component.mainNodeId];
          const seen = new Set();
          while (stack.length > 0) {
            const nodeId = stack.pop();
            if (seen.has(nodeId)) continue;
            seen.add(nodeId);
            const node = presentation.nodes[nodeId];
            if (!node) continue;
            seen.add(nodeId);
            family.nodeCount += 1;
            const nodeRuntimeId =
              runtime.nodes[component.screenId]?.[
                component.presentationId
              ]?.[nodeId];
            if (nodeRuntimeId) {
              runtime.reverseDesignSystem[nodeRuntimeId] = {
                componentId,
                kind: "located-component-node",
                nodeId,
                ownerPackageId: manifest.packageId,
                presentationId: component.presentationId,
                screenId: component.screenId,
              };
            }
            for (const child of node.children ?? []) stack.push(child);
          }
        }
        families.push(family);
      }
    }
    refs.families = families;
    const componentSamples = await createComponentSamples(
      { manifest, entries, domain }, families, combinations,
    );
    refs.componentSamples = componentSamples.samples;
    Object.assign(runtime.reverseDesignSystem, componentSamples.reverse);
    // DSE-R12: every screen presentation appears as a page-content entry.
    // Board copies reuse the source node runtime ids, so edits translate to
    // that occurrence on its own screen (instance overrides stay overrides —
    // masters are only touched through component-definition nodes).
    const pages = [];
    for (const entry of manifest.entries.screens) {
      const screen = entries[entry];
      for (const presentation of screen.presentations ?? []) {
        const rootIds = Array.isArray(presentation.rootIds)
          ? [...presentation.rootIds]
          : presentation.rootId
            ? [presentation.rootId]
            : [];
        const caption = await stableRuntimeUuid(
          manifest.packageId,
          "design-system-page-caption",
          `${screen.id}\0${presentation.id}`,
        );
        registerRuntimeId(
          caption,
          `design-system-page-caption:${screen.id}/${presentation.id}`,
        );
        runtime.reverseDesignSystem[caption] = { kind: "label" };
        const page = {
          caption,
          kind: "page",
          label: `${screen.name} · ${presentation.name}`,
          nodeCount: 0,
          presentationId: presentation.id,
          rootId: rootIds[0] ?? null,
          rootIds,
          screenId: screen.id,
        };
        for (const nodeId of Object.keys(presentation.nodes ?? {})) {
          const nodeRuntimeId =
            runtime.nodes[screen.id]?.[presentation.id]?.[nodeId];
          // Component-definition registrations (located trees) win: their
          // semantics are identical, but the precise kind is kept for
          // diagnostics.
          if (nodeRuntimeId && !runtime.reverseDesignSystem[nodeRuntimeId]) {
            runtime.reverseDesignSystem[nodeRuntimeId] = {
              kind: "page-node",
              nodeId,
              ownerPackageId: manifest.packageId,
              presentationId: presentation.id,
              screenId: screen.id,
            };
          }
        }
        page.nodeCount = Object.keys(presentation.nodes ?? {}).length;
        pages.push(page);
      }
    }
    refs.pages = pages;
    runtime.designSystemRefs = refs;
    runtime.reverseDesignSystem[runtime.designSystem.board] = {
      kind: "board",
    };
    runtime.reverseDesignSystem[runtime.designSystem.tokenLabel] = {
      kind: "label",
    };
    // Section headers are decoration: the workspace's text measurement pass
    // resizes auto-width texts on the open page, and those rides-along edits
    // must no-op instead of failing the whole commit.
    runtime.reverseDesignSystem[runtime.designSystem.tokensSection] = {
      kind: "label",
    };
    runtime.reverseDesignSystem[runtime.designSystem.componentsSection] = {
      kind: "label",
    };
    runtime.reverseDesignSystem[runtime.designSystem.pagesSection] = {
      kind: "label",
    };
    runtime.reverseDesignSystem[runtime.designSystem.tokensEmpty] = {
      kind: "label",
    };
    runtime.reverseDesignSystem[runtime.designSystem.componentsEmpty] = {
      kind: "label",
    };
    runtime.reverseDesignSystem[runtime.designSystem.pagesEmpty] = {
      kind: "label",
    };
  }
  return runtime;
}

export function listPackageEntries(manifestValue) {
  const manifest = validateManifest(structuredClone(manifestValue));
  return {
    entries: ENTRY_KINDS.flatMap((kind) => manifest.entries[kind]),
    manifest,
  };
}

export async function loadPackageFromValues(locator, values) {
  if (!(values instanceof Map)) {
    fail("invalid_package_values", "Canonical Package values must be a Map");
  }
  if (!values.has("manifest.json")) {
    fail("missing_manifest", "Canonical Package is missing manifest.json");
  }
  const { manifest } = listPackageEntries(values.get("manifest.json"));
  const entries = {};
  const canonicalFiles = new Map([["manifest.json", canonicalJSON(manifest)]]);
  const screenIds = new Set();
  if (manifest.entries.assets.length > 1) {
    fail(
      "unsupported_asset_library_count",
      "SmallPen currently supports at most one Asset Library entry",
    );
  }
  let penpotTokenLibraryCount = 0;
  for (const kind of ENTRY_KINDS) {
    for (const entry of manifest.entries[kind]) {
      if (!values.has(entry)) {
        fail("missing_entry", `Canonical Package entry is missing: ${entry}`, {
          entry,
        });
      }
      const value = structuredClone(values.get(entry));
      if (kind === "assets") {
        validateAssetLibrary(value, entry);
      } else if (kind === "screens") {
        const screen = validateScreen(value, entry);
        if (screenIds.has(screen.id)) {
          fail("duplicate_screen_id", `Duplicate Screen id: ${screen.id}`);
        }
        screenIds.add(screen.id);
      } else if (kind === "components") {
        validateComponent(value, entry);
      } else if (
        kind === "tokens" &&
        Array.isArray(value?.sets) &&
        Array.isArray(value?.themes)
      ) {
        penpotTokenLibraryCount += 1;
        if (penpotTokenLibraryCount > 1) {
          fail(
            "unsupported_token_library_count",
            "SmallPen supports at most one Penpot Token Library entry",
          );
        }
        validateTokenLibrary(value, entry);
      }
      entries[entry] = value;
      canonicalFiles.set(entry, canonicalJSON(value));
    }
  }
  const contexts = parseContextEntries(manifest, entries);
  const components = parseComponentEntries(manifest, entries);
  const requirements = parseRequirementEntries(manifest, entries);
  const domain = {
    annotations: requirements.annotations,
    componentSets: components.componentSets,
    contextAxes: contexts.axes,
    contextProfiles: contexts.profiles,
    flows: requirements.flows,
    locatedComponents: components.locatedComponents,
    requirements: requirements.requirements,
    scenarios: parseScenarioEntries(manifest, entries),
    tokens: parseTokenEntries(manifest, entries),
  };
  validateComponentReferences(manifest, entries);
  validateDesignReferences(manifest, entries, domain);
  validateAppliedTokenReferences(manifest, entries, domain);
  validateAssetReferences(manifest, entries);
  const blobs = await validateBlobValues(manifest, entries, values);
  if (
    manifest.entries.screens.length > 0 &&
    (!manifest.defaultScreenId ||
      !manifest.entries.screens.some(
        (entry) => entries[entry].id === manifest.defaultScreenId,
      ))
  ) {
    fail(
      "invalid_default_screen",
      "defaultScreenId must reference one indexed Screen",
    );
  }
  return {
    entries,
    blobs,
    domain,
    locator,
    manifest,
    revision: await hashCanonicalFiles(canonicalFiles),
    runtime: await createRuntime(manifest, entries, domain, locator),
  };
}

function findScreenEntry(snapshot, screenId) {
  const entry = snapshot.manifest.entries.screens.find(
    (candidate) => snapshot.entries[candidate].id === screenId,
  );
  if (!entry)
    fail("missing_screen", `Screen is not owned by this package: ${screenId}`);
  return entry;
}

function findScreenContext(snapshot, screenId) {
  const entry = findScreenEntry(snapshot, screenId);
  return { entry, screen: snapshot.entries[entry] };
}

function findPresentationContext(snapshot, operation) {
  const { entry, screen } = findScreenContext(snapshot, operation.screenId);
  const presentation = screen.presentations.find(
    (candidate) => candidate.id === operation.presentationId,
  );
  if (!presentation) {
    fail(
      "missing_presentation",
      `Presentation is not owned by this Screen: ${operation.presentationId}`,
    );
  }
  return { entry, presentation };
}

function findComponentContext(snapshot, componentId) {
  const index = snapshot.manifest.entries.components.findIndex(
    (entry) => snapshot.entries[entry].id === componentId,
  );
  if (index < 0) {
    fail(
      "missing_component",
      `Component is not owned by this package: ${componentId}`,
    );
  }
  const entry = snapshot.manifest.entries.components[index];
  return { component: snapshot.entries[entry], entry, index };
}

function componentEntry(componentId) {
  return safeEntry(`components/${componentId}.json`);
}

function applyAddComponent(snapshot, operation, inverseOperations) {
  const component = requireRecord(
    structuredClone(operation.component),
    "invalid_component",
    "add-component component must contain an object",
  );
  const entry = operation.entry ?? componentEntry(component.id);
  safeEntry(entry);
  if (
    snapshot.manifest.entries.components.some(
      (candidate) =>
        candidate === entry || snapshot.entries[candidate].id === component.id,
    )
  ) {
    fail("duplicate_component_id", `Component already exists: ${component.id}`);
  }
  const { entry: screenEntry, presentation } = findPresentationContext(
    snapshot,
    {
      presentationId: component.presentationId,
      screenId: component.screenId,
    },
  );
  const main = presentation.nodes[component.mainNodeId];
  if (!isRecord(main)) {
    fail(
      "missing_component_main",
      `Component main node does not exist: ${component.mainNodeId}`,
    );
  }
  if (main.type !== "FRAME" || main.componentId !== undefined) {
    fail(
      "invalid_component_main",
      `Only an unbound FRAME can become a Component: ${component.mainNodeId}`,
    );
  }
  const index = insertionIndex(
    operation.index,
    snapshot.manifest.entries.components.length,
  );
  snapshot.manifest.entries.components.splice(index, 0, entry);
  snapshot.entries[entry] = component;
  main.type = "COMPONENT";
  main.componentId = component.id;
  inverseOperations.unshift({
    componentId: component.id,
    type: "delete-component",
  });
  return {
    affectedIds: [component.id, component.mainNodeId],
    entries: ["manifest.json", entry, screenEntry],
  };
}

function applyDeleteComponent(snapshot, operation, inverseOperations) {
  const { component, entry, index } = findComponentContext(
    snapshot,
    operation.componentId,
  );
  for (const screenEntry of snapshot.manifest.entries.screens) {
    const screen = snapshot.entries[screenEntry];
    for (const presentation of screen.presentations) {
      if (
        Object.values(presentation.nodes).some(
          (node) =>
            node.type === "INSTANCE" && node.componentId === component.id,
        )
      ) {
        fail(
          "component_in_use",
          `Component still has instances: ${component.id}`,
        );
      }
    }
  }
  const { entry: screenEntry, presentation } = findPresentationContext(
    snapshot,
    {
      presentationId: component.presentationId,
      screenId: component.screenId,
    },
  );
  const main = presentation.nodes[component.mainNodeId];
  if (
    !isRecord(main) ||
    main.type !== "COMPONENT" ||
    main.componentId !== component.id
  ) {
    fail(
      "invalid_component_main",
      `Component main node is inconsistent: ${component.id}`,
    );
  }
  main.type = "FRAME";
  delete main.componentId;
  snapshot.manifest.entries.components.splice(index, 1);
  delete snapshot.entries[entry];
  inverseOperations.unshift({
    component: structuredClone(component),
    entry,
    index,
    type: "add-component",
  });
  return {
    affectedIds: [component.id, component.mainNodeId],
    deletedEntries: [entry],
    entries: ["manifest.json", screenEntry],
  };
}

function applyUpdateComponent(snapshot, operation, inverseOperations) {
  const { component, entry } = findComponentContext(
    snapshot,
    operation.componentId,
  );
  const changes = requireRecord(
    operation.changes,
    "invalid_component_changes",
    "update-component changes must contain an object",
  );
  if (
    Object.keys(changes).length === 0 ||
    Object.keys(changes).some((field) => field !== "name" && field !== "path")
  ) {
    fail(
      "unsupported_component_change",
      "Only Component name and path can be changed",
    );
  }
  const inverseChanges = {};
  for (const [field, value] of Object.entries(changes)) {
    if (typeof value !== "string" || (field === "name" && value.length === 0)) {
      fail(
        field === "name" ? "invalid_component_name" : "invalid_component_path",
        `Component ${field} is invalid`,
      );
    }
    inverseChanges[field] = component[field];
    component[field] = value;
  }
  inverseOperations.unshift({
    changes: inverseChanges,
    componentId: component.id,
    type: "update-component",
  });
  return { affectedIds: [component.id], entries: [entry] };
}

function tokenLibraryAffectedIds(library) {
  if (!library) return [];
  return [
    library.id,
    ...library.sets.flatMap((tokenSet) => [
      tokenSet.id,
      ...tokenSet.tokens.map((token) => token.id),
    ]),
    ...library.themes.map((theme) => theme.id),
  ];
}

function penpotTokenLibraryEntry(snapshot) {
  return snapshot.manifest.entries.tokens.find((entry) => {
    const value = snapshot.entries[entry];
    return Array.isArray(value?.sets) && Array.isArray(value?.themes);
  });
}

function applyReplaceTokenLibrary(snapshot, operation, inverseOperations) {
  const previousEntry = penpotTokenLibraryEntry(snapshot);
  const previous = previousEntry
    ? structuredClone(snapshot.entries[previousEntry])
    : null;
  const library =
    operation.library === null
      ? null
      : requireRecord(
          structuredClone(operation.library),
          "invalid_token_library",
          "replace-token-library library must contain an object or null",
        );
  const entry = previousEntry ?? operation.entry ?? "tokens/tokens.json";
  safeEntry(entry);
  if (previousEntry && canonicalJSON(previous) === canonicalJSON(library)) {
    // Keep validation strict even when canonical serialization omits undefineds.
    validateTokenLibrary(library, entry);
    return { affectedIds: [], entries: [] };
  }
  if (library === null) {
    if (!previousEntry) {
      fail("missing_token_library", "Token Library does not exist");
    }
    snapshot.manifest.entries.tokens = snapshot.manifest.entries.tokens.filter(
      (candidate) => candidate !== previousEntry,
    );
    delete snapshot.entries[previousEntry];
    inverseOperations.unshift({
      entry: previousEntry,
      library: previous,
      type: "replace-token-library",
    });
    return {
      affectedIds: tokenLibraryAffectedIds(previous),
      deletedEntries: [previousEntry],
      entries: ["manifest.json"],
    };
  }
  if (!previousEntry) snapshot.manifest.entries.tokens.push(entry);
  snapshot.entries[entry] = library;
  inverseOperations.unshift({
    ...(previousEntry ? {} : { entry }),
    library: previous,
    type: "replace-token-library",
  });
  return {
    affectedIds: [
      ...tokenLibraryAffectedIds(previous),
      ...tokenLibraryAffectedIds(library),
    ],
    entries: previousEntry ? [entry] : ["manifest.json", entry],
  };
}

function applySetActiveTokenThemes(snapshot, operation, inverseOperations) {
  const entry = penpotTokenLibraryEntry(snapshot);
  if (!entry) {
    fail("missing_token_library", "Token Library does not exist");
  }
  if (
    !Array.isArray(operation.themePaths) ||
    operation.themePaths.some(
      (path) => typeof path !== "string" || path.length === 0,
    ) ||
    new Set(operation.themePaths).size !== operation.themePaths.length
  ) {
    fail(
      "invalid_active_token_themes",
      "set-active-token-themes themePaths must be unique non-empty strings",
    );
  }
  const library = snapshot.entries[entry];
  const themesByPath = new Map(
    library.themes.map((theme) => [
      `${theme.group}/${theme.name}`,
      theme,
    ]),
  );
  const missingPaths = operation.themePaths.filter(
    (path) => !themesByPath.has(path),
  );
  if (missingPaths.length > 0) {
    fail(
      "missing_token_theme",
      `Token Theme does not exist: ${missingPaths[0]}`,
      { paths: missingPaths },
    );
  }
  const previousPaths = library.activeThemeIds.map((id) => {
    const theme = library.themes.find((candidate) => candidate.id === id);
    return `${theme.group}/${theme.name}`;
  });
  restoreEntryInverse(snapshot, "tokens", entry, inverseOperations);
  library.activeThemeIds = operation.themePaths.map(
    (path) => themesByPath.get(path).id,
  );
  return {
    affectedIds: [...new Set([
      ...library.activeThemeIds,
      ...previousPaths.map((path) => themesByPath.get(path).id),
    ])],
    entries: [entry],
  };
}

function assetLibraryAffectedIds(library) {
  if (!library) return [];
  return [
    library.id,
    ...library.colors.map((color) => color.id),
    ...library.fonts.flatMap((font) => [
      font.id,
      ...font.variants.map((variant) => variant.id),
    ]),
    ...library.media.map((media) => media.id),
    ...library.typographies.map((typography) => typography.id),
  ];
}

function applyReplaceAssetLibrary(snapshot, operation, inverseOperations) {
  const previousEntry = snapshot.manifest.entries.assets[0];
  const previous = previousEntry
    ? structuredClone(snapshot.entries[previousEntry])
    : null;
  const library =
    operation.library === null
      ? null
      : requireRecord(
          structuredClone(operation.library),
          "invalid_asset_library",
          "replace-asset-library library must contain an object or null",
        );
  const entry = previousEntry ?? operation.entry ?? "assets/assets.json";
  safeEntry(entry);
  if (library === null) {
    if (!previousEntry) {
      fail("missing_asset_library", "Asset Library does not exist");
    }
    snapshot.manifest.entries.assets = [];
    delete snapshot.entries[previousEntry];
    inverseOperations.unshift({
      entry: previousEntry,
      library: previous,
      type: "replace-asset-library",
    });
    return {
      affectedIds: assetLibraryAffectedIds(previous),
      deletedEntries: [previousEntry],
      entries: ["manifest.json"],
    };
  }
  if (!previousEntry) snapshot.manifest.entries.assets = [entry];
  snapshot.entries[entry] = library;
  inverseOperations.unshift({
    ...(previousEntry ? {} : { entry }),
    library: previous,
    type: "replace-asset-library",
  });
  return {
    affectedIds: [
      ...assetLibraryAffectedIds(previous),
      ...assetLibraryAffectedIds(library),
    ],
    entries: previousEntry ? [entry] : ["manifest.json", entry],
  };
}

function applyAddPresentation(snapshot, operation, inverseOperations) {
  const { entry, screen } = findScreenContext(snapshot, operation.screenId);
  const presentation = requireRecord(
    structuredClone(operation.presentation),
    "invalid_presentation",
    "add-presentation presentation must contain an object",
  );
  stableId(
    presentation.id,
    "pres_",
    "invalid_presentation_id",
    "operation.presentation.id",
  );
  if (screen.presentations.some(({ id }) => id === presentation.id)) {
    fail(
      "duplicate_presentation_id",
      `Presentation already exists: ${presentation.id}`,
    );
  }
  const index = insertionIndex(operation.index, screen.presentations.length);
  screen.presentations.splice(index, 0, presentation);
  if (operation.basePresentationId !== undefined) {
    screen.basePresentationId = operation.basePresentationId;
  }
  inverseOperations.unshift({
    presentationId: presentation.id,
    screenId: operation.screenId,
    type: "delete-presentation",
  });
  return { affectedIds: [presentation.id], entry };
}

function applyDeletePresentation(snapshot, operation, inverseOperations) {
  const { entry, screen } = findScreenContext(snapshot, operation.screenId);
  if (screen.presentations.length === 1) {
    fail(
      "cannot_delete_last_presentation",
      "A Screen must keep at least one Presentation",
    );
  }
  const index = screen.presentations.findIndex(
    ({ id }) => id === operation.presentationId,
  );
  if (index < 0) {
    fail(
      "missing_presentation",
      `Presentation is not owned by this Screen: ${operation.presentationId}`,
    );
  }
  const [presentation] = screen.presentations.splice(index, 1);
  const previousBasePresentationId = screen.basePresentationId;
  if (previousBasePresentationId === presentation.id) {
    screen.basePresentationId = screen.presentations[0].id;
  }
  inverseOperations.unshift({
    basePresentationId: previousBasePresentationId,
    index,
    presentation: structuredClone(presentation),
    screenId: operation.screenId,
    type: "add-presentation",
  });
  return {
    affectedIds: [presentation.id, ...Object.keys(presentation.nodes)],
    entry,
  };
}

function applyMovePresentation(snapshot, operation, inverseOperations) {
  const { entry, screen } = findScreenContext(snapshot, operation.screenId);
  const previousIndex = screen.presentations.findIndex(
    ({ id }) => id === operation.presentationId,
  );
  if (previousIndex < 0) {
    fail(
      "missing_presentation",
      `Presentation is not owned by this Screen: ${operation.presentationId}`,
    );
  }
  const [presentation] = screen.presentations.splice(previousIndex, 1);
  const index = insertionIndex(operation.index, screen.presentations.length);
  screen.presentations.splice(index, 0, presentation);
  inverseOperations.unshift({
    index: previousIndex,
    presentationId: presentation.id,
    screenId: operation.screenId,
    type: "move-presentation",
  });
  return { affectedIds: [presentation.id], entry };
}

function applyUpdatePresentation(snapshot, operation, inverseOperations) {
  const { entry, presentation } = findPresentationContext(snapshot, operation);
  const changes = requireRecord(
    operation.changes,
    "invalid_presentation_changes",
    "update-presentation changes must contain an object",
  );
  const fields = Object.keys(changes);
  const supported = new Set([
    "background",
    "name",
    "pixel-grid-color",
    "pixel-grid-opacity",
    "prototypeFlows",
  ]);
  if (fields.length === 0 || fields.some((field) => !supported.has(field))) {
    fail(
      "unsupported_presentation_change",
      "Presentation changes contain an unsupported field",
    );
  }
  if (fields.includes("prototypeFlows") && fields.length !== 1) {
    fail(
      "unsupported_presentation_change",
      "Prototype Flows must be changed independently",
    );
  }
  const inverseChanges = {};
  let affectedIds = [presentation.id];
  if (fields[0] === "prototypeFlows") {
    inverseChanges.prototypeFlows = Object.hasOwn(
      presentation,
      "prototypeFlows",
    )
      ? structuredClone(presentation.prototypeFlows)
      : null;
    if (changes.prototypeFlows === null) delete presentation.prototypeFlows;
    else presentation.prototypeFlows = structuredClone(changes.prototypeFlows);
    affectedIds = [
      presentation.id,
      ...(presentation.prototypeFlows ?? []).map(({ id }) => id),
    ];
  } else {
    if (
      fields.includes("name") &&
      (typeof changes.name !== "string" || changes.name.length === 0)
    ) {
      fail(
        "unsupported_presentation_change",
        "Presentation name must be non-empty",
      );
    }
    for (const field of fields) {
      inverseChanges[field] = Object.hasOwn(presentation, field)
        ? structuredClone(presentation[field])
        : null;
      if (changes[field] === null) delete presentation[field];
      else presentation[field] = structuredClone(changes[field]);
    }
  }
  inverseOperations.unshift({
    changes: inverseChanges,
    presentationId: operation.presentationId,
    screenId: operation.screenId,
    type: "update-presentation",
  });
  return { affectedIds, entry };
}

function findNodePosition(presentation, nodeId) {
  const rootIndex = presentationRootIds(presentation).indexOf(nodeId);
  if (rootIndex >= 0) return { index: rootIndex, parentId: null };
  for (const node of Object.values(presentation.nodes)) {
    const index = node.children?.indexOf(nodeId) ?? -1;
    if (index >= 0) return { index, parentId: node.id };
  }
  return undefined;
}

function childIdsForParent(presentation, parentId) {
  if (parentId === null) return presentationRootIds(presentation);
  const parent = presentation.nodes[parentId];
  if (!isRecord(parent)) {
    fail(
      "missing_parent_node",
      `Parent node does not exist: ${String(parentId)}`,
    );
  }
  return parent.children ?? [];
}

function setChildIdsForParent(presentation, parentId, childIds) {
  if (parentId === null) {
    setPresentationRootIds(presentation, childIds);
    return;
  }
  presentation.nodes[parentId].children = [...childIds];
}

function insertionIndex(index, length) {
  if (index === undefined || index === null) return length;
  if (!Number.isInteger(index) || index < 0 || index > length) {
    fail("invalid_child_index", "Child index is outside the parent", {
      index,
      length,
    });
  }
  return index;
}

function applyAddPresentationNode(snapshot, operation, inverseOperations) {
  const { entry, presentation } = findPresentationContext(snapshot, operation);
  const node = requireRecord(
    structuredClone(operation.node),
    "invalid_node",
    "add-presentation-node node must contain an object",
  );
  stableId(node.id, "node_", "invalid_node_id", "operation.node.id");
  if (presentation.nodes[node.id]) {
    fail("duplicate_node", `Presentation node already exists: ${node.id}`);
  }
  if (
    operation.parentId !== null &&
    !isRecord(presentation.nodes[operation.parentId])
  ) {
    fail(
      "missing_parent_node",
      `Parent node does not exist: ${String(operation.parentId)}`,
    );
  }
  const siblings = childIdsForParent(presentation, operation.parentId);
  if (!siblings.includes(node.id)) {
    const index = insertionIndex(operation.index, siblings.length);
    siblings.splice(index, 0, node.id);
    setChildIdsForParent(presentation, operation.parentId, siblings);
  }
  presentation.nodes[node.id] = node;
  inverseOperations.unshift({
    nodeId: node.id,
    presentationId: operation.presentationId,
    screenId: operation.screenId,
    type: "delete-presentation-node",
  });
  return { affectedIds: [node.id], entry };
}

function collectSubtree(presentation, nodeId, result = []) {
  const node = presentation.nodes[nodeId];
  if (!isRecord(node)) {
    fail("missing_node", `Presentation node does not exist: ${nodeId}`);
  }
  result.push(nodeId);
  for (const childId of node.children ?? []) {
    collectSubtree(presentation, childId, result);
  }
  return result;
}

function applyDeletePresentationNode(snapshot, operation, inverseOperations) {
  const { entry, presentation } = findPresentationContext(snapshot, operation);
  const position = findNodePosition(presentation, operation.nodeId);
  if (!position) {
    fail(
      "missing_node",
      `Presentation node does not exist: ${operation.nodeId}`,
    );
  }
  const subtreeIds = collectSubtree(presentation, operation.nodeId);
  const restores = subtreeIds.map((nodeId) => {
    const restorePosition = findNodePosition(presentation, nodeId);
    return {
      index: restorePosition.index,
      node: structuredClone(presentation.nodes[nodeId]),
      parentId: restorePosition.parentId,
      presentationId: operation.presentationId,
      screenId: operation.screenId,
      type: "add-presentation-node",
    };
  });
  setChildIdsForParent(
    presentation,
    position.parentId,
    childIdsForParent(presentation, position.parentId).filter(
      (nodeId) => nodeId !== operation.nodeId,
    ),
  );
  for (const nodeId of subtreeIds) delete presentation.nodes[nodeId];
  inverseOperations.unshift(...restores);
  return { affectedIds: subtreeIds, entry };
}

function applyMovePresentationNodes(snapshot, operation, inverseOperations) {
  const { entry, presentation } = findPresentationContext(snapshot, operation);
  if (!Array.isArray(operation.nodeIds) || operation.nodeIds.length === 0) {
    fail("invalid_node_move", "move-presentation-nodes requires nodeIds");
  }
  if (new Set(operation.nodeIds).size !== operation.nodeIds.length) {
    fail(
      "invalid_node_move",
      "move-presentation-nodes contains duplicate nodeIds",
    );
  }
  if (
    operation.parentId !== null &&
    !isRecord(presentation.nodes[operation.parentId])
  ) {
    fail(
      "missing_parent_node",
      `Parent node does not exist: ${String(operation.parentId)}`,
    );
  }
  const originals = operation.nodeIds.map((nodeId) => {
    const node = presentation.nodes[nodeId];
    if (!isRecord(node))
      fail("missing_node", `Presentation node does not exist: ${nodeId}`);
    if (
      operation.parentId !== null &&
      collectSubtree(presentation, nodeId, []).includes(operation.parentId)
    ) {
      fail("node_cycle", `Node cannot move into its own subtree: ${nodeId}`);
    }
    const original = findNodePosition(presentation, nodeId);
    if (!original) {
      fail("missing_node", `Presentation node does not exist: ${nodeId}`);
    }
    return {
      index: original.index,
      nodeId,
      parentId: original.parentId,
    };
  });

  for (const nodeId of operation.nodeIds) {
    for (const candidate of operation.nodeIds) {
      if (
        nodeId !== candidate &&
        collectSubtree(presentation, nodeId, []).includes(candidate)
      ) {
        fail(
          "overlapping_node_move",
          "Cannot move both a node and its descendant",
        );
      }
    }
  }

  for (const { nodeId, parentId } of originals) {
    setChildIdsForParent(
      presentation,
      parentId,
      childIdsForParent(presentation, parentId).filter(
        (candidate) => candidate !== nodeId,
      ),
    );
  }
  const targetChildren = childIdsForParent(presentation, operation.parentId);
  const index = insertionIndex(operation.index, targetChildren.length);
  targetChildren.splice(index, 0, ...operation.nodeIds);
  setChildIdsForParent(presentation, operation.parentId, targetChildren);

  const inverseMoves = [...originals]
    .sort((left, right) => {
      return (
        String(left.parentId ?? "").localeCompare(
          String(right.parentId ?? ""),
        ) || left.index - right.index
      );
    })
    .map(({ index: originalIndex, nodeId, parentId }) => ({
      index: originalIndex,
      nodeIds: [nodeId],
      parentId,
      presentationId: operation.presentationId,
      screenId: operation.screenId,
      type: "move-presentation-nodes",
    }));
  inverseOperations.unshift(...inverseMoves);
  return { affectedIds: operation.nodeIds, entry };
}

function applyReorderPresentationChildren(
  snapshot,
  operation,
  inverseOperations,
) {
  const { entry, presentation } = findPresentationContext(snapshot, operation);
  const current = childIdsForParent(presentation, operation.parentId);
  if (
    !Array.isArray(operation.childIds) ||
    new Set(operation.childIds).size !== operation.childIds.length ||
    operation.childIds.length !== current.length ||
    operation.childIds.some((nodeId) => !current.includes(nodeId))
  ) {
    fail(
      "invalid_child_order",
      "reorder-presentation-children must contain every child exactly once",
    );
  }
  const previous = [...current];
  setChildIdsForParent(presentation, operation.parentId, operation.childIds);
  inverseOperations.unshift({
    childIds: previous,
    parentId: operation.parentId,
    presentationId: operation.presentationId,
    screenId: operation.screenId,
    type: "reorder-presentation-children",
  });
  return {
    affectedIds:
      operation.parentId === null
        ? [...operation.childIds]
        : [operation.parentId, ...operation.childIds],
    entry,
  };
}

function applyUpdatePresentationNode(snapshot, operation, inverseOperations) {
  const { entry, presentation } = findPresentationContext(snapshot, operation);
  const node = presentation.nodes[operation.nodeId];
  if (!isRecord(node))
    fail(
      "missing_node",
      `Node is not owned by this Presentation: ${operation.nodeId}`,
    );
  const changes = requireRecord(
    operation.changes,
    "invalid_node_changes",
    "update-presentation-node changes must contain an object",
  );
  for (const field of Object.keys(changes)) {
    if (!NODE_CHANGE_FIELDS.has(field)) {
      fail(
        "unsupported_node_change",
        `Phase 0 cannot change node field: ${field}`,
        { field },
      );
    }
    if (
      (field === "text" ||
        field === "textBlocks" ||
        field === "growType" ||
        field === "textStyle") &&
      node.type !== "TEXT"
    ) {
      fail(
        "unexpected_text_attribute",
        `Only TEXT nodes can change ${field}: ${operation.nodeId}`,
      );
    }
    if (field === "mediaRef" && node.type !== "IMAGE") {
      fail(
        "unexpected_media_attribute",
        `Only IMAGE nodes can change ${field}: ${operation.nodeId}`,
      );
    }
    validateNodeChange(field, changes[field], operation.nodeId);
  }
  const inverseChanges = {};
  for (const [field, value] of Object.entries(changes)) {
    inverseChanges[field] = Object.hasOwn(node, field)
      ? structuredClone(node[field])
      : null;
    if (value === null) {
      delete node[field];
    } else {
      node[field] = structuredClone(value);
    }
  }
  inverseOperations.unshift({
    changes: inverseChanges,
    nodeId: operation.nodeId,
    presentationId: operation.presentationId,
    screenId: operation.screenId,
    type: "update-presentation-node",
  });
  return entry;
}

function restoreEntryInverse(snapshot, kind, entry, inverseOperations) {
  const index = snapshot.manifest.entries[kind].indexOf(entry);
  inverseOperations.unshift({
    entry,
    index: index < 0 ? snapshot.manifest.entries[kind].length : index,
    kind,
    type: "restore-canonical-entry",
    value:
      index < 0 || !Object.hasOwn(snapshot.entries, entry)
        ? null
        : structuredClone(snapshot.entries[entry]),
  });
}

function applyRestoreCanonicalEntry(snapshot, operation, inverseOperations) {
  if (!ENTRY_KINDS.includes(operation.kind)) {
    fail(
      "invalid_entry_kind",
      `Unknown Canonical entry kind: ${operation.kind}`,
    );
  }
  safeEntry(operation.entry);
  restoreEntryInverse(
    snapshot,
    operation.kind,
    operation.entry,
    inverseOperations,
  );
  const currentIndex = snapshot.manifest.entries[operation.kind].indexOf(
    operation.entry,
  );
  if (operation.value === null) {
    if (currentIndex >= 0) {
      snapshot.manifest.entries[operation.kind].splice(currentIndex, 1);
    }
    delete snapshot.entries[operation.entry];
    return {
      affectedIds: [operation.entry],
      deletedEntries: [operation.entry],
      entries: ["manifest.json"],
    };
  }
  if (!isRecord(operation.value)) {
    fail(
      "invalid_entry_value",
      "restore-canonical-entry value must contain an object or null",
    );
  }
  if (currentIndex < 0) {
    const index = insertionIndex(
      operation.index,
      snapshot.manifest.entries[operation.kind].length,
    );
    snapshot.manifest.entries[operation.kind].splice(index, 0, operation.entry);
  }
  snapshot.entries[operation.entry] = structuredClone(operation.value);
  return {
    affectedIds: [operation.entry],
    entries:
      currentIndex < 0 ? ["manifest.json", operation.entry] : [operation.entry],
  };
}

function collectionEntry(snapshot, kind, field, id, operation, defaultEntry) {
  const existing = snapshot.manifest.entries[kind].find((entry) =>
    snapshot.entries[entry]?.[field]?.some((candidate) => candidate.id === id),
  );
  if (existing) return { entry: existing, created: false };
  const compatible = snapshot.manifest.entries[kind].find((entry) =>
    Array.isArray(snapshot.entries[entry]?.[field]),
  );
  if (compatible) return { entry: compatible, created: false };
  const entry = operation.entry ?? defaultEntry;
  safeEntry(entry);
  if (snapshot.manifest.entries[kind].includes(entry)) {
    fail("entry_kind_mismatch", `Canonical entry has another schema: ${entry}`);
  }
  return { entry, created: true };
}

function putCollectionItem(
  snapshot,
  operation,
  inverseOperations,
  { defaultEntry, field, id, item, kind },
) {
  const target = collectionEntry(
    snapshot,
    kind,
    field,
    id,
    operation,
    defaultEntry,
  );
  restoreEntryInverse(snapshot, kind, target.entry, inverseOperations);
  if (target.created) {
    snapshot.manifest.entries[kind].push(target.entry);
    snapshot.entries[target.entry] = { [field]: [] };
  }
  const values = snapshot.entries[target.entry][field];
  const index = values.findIndex((candidate) => candidate.id === id);
  if (index < 0) values.push(structuredClone(item));
  else values[index] = structuredClone(item);
  return {
    affectedIds: [id],
    entries: target.created ? ["manifest.json", target.entry] : [target.entry],
  };
}

function deleteCollectionItem(
  snapshot,
  operation,
  inverseOperations,
  { field, id, kind, missingCode },
) {
  const entry = snapshot.manifest.entries[kind].find((candidate) =>
    snapshot.entries[candidate]?.[field]?.some((item) => item.id === id),
  );
  if (!entry) fail(missingCode, `${field} item does not exist: ${id}`);
  restoreEntryInverse(snapshot, kind, entry, inverseOperations);
  snapshot.entries[entry][field] = snapshot.entries[entry][field].filter(
    (item) => item.id !== id,
  );
  return { affectedIds: [id], entries: [entry] };
}

function applyPutComponentSet(snapshot, operation, inverseOperations) {
  const componentSet = requireRecord(
    operation.componentSet,
    "invalid_component_set",
    "put-component-set requires componentSet",
  );
  stableId(
    componentSet.id,
    "cmp_",
    "invalid_component_id",
    "operation.componentSet.id",
  );
  const applied = putCollectionItem(snapshot, operation, inverseOperations, {
    defaultEntry: "components/components.json",
    field: "componentSets",
    id: componentSet.id,
    item: componentSet,
    kind: "components",
  });
  return {
    ...applied,
    affectedIds: componentSetAffectedIds(componentSet),
  };
}

function applyDeleteComponentSet(snapshot, operation, inverseOperations) {
  const { componentSet } = componentSetRaw(snapshot, operation.componentSetId);
  const applied = deleteCollectionItem(snapshot, operation, inverseOperations, {
    field: "componentSets",
    id: operation.componentSetId,
    kind: "components",
    missingCode: "missing_component",
  });
  return {
    ...applied,
    affectedIds: componentSetAffectedIds(componentSet),
  };
}

function componentSetRaw(snapshot, componentSetId) {
  for (const entry of snapshot.manifest.entries.components) {
    const componentSet = snapshot.entries[entry]?.componentSets?.find(
      ({ id }) => id === componentSetId,
    );
    if (componentSet) return { componentSet, entry };
  }
  fail("missing_component", `Component does not exist: ${componentSetId}`);
}

function componentSetAffectedIds(componentSet) {
  return [
    componentSet.id,
    ...componentSet.axes.map(({ id }) => id),
    ...componentSet.variants.flatMap((variant) => [
      variant.id,
      ...Object.keys(variant.nodes),
    ]),
  ];
}

function applyPutVariant(snapshot, operation, inverseOperations) {
  const { componentSet, entry } = componentSetRaw(
    snapshot,
    operation.componentSetId,
  );
  const variant = requireRecord(
    operation.variant,
    "invalid_variant",
    "put-variant requires variant",
  );
  stableId(variant.id, "var_", "invalid_variant_id", "operation.variant.id");
  restoreEntryInverse(snapshot, "components", entry, inverseOperations);
  const index = componentSet.variants.findIndex(({ id }) => id === variant.id);
  if (index < 0) componentSet.variants.push(structuredClone(variant));
  else componentSet.variants[index] = structuredClone(variant);
  return {
    affectedIds: [componentSet.id, variant.id, ...Object.keys(variant.nodes)],
    entries: [entry],
  };
}

function applyDeleteVariant(snapshot, operation, inverseOperations) {
  const { componentSet, entry } = componentSetRaw(
    snapshot,
    operation.componentSetId,
  );
  const index = componentSet.variants.findIndex(
    ({ id }) => id === operation.variantId,
  );
  if (index < 0)
    fail("missing_variant", `Variant does not exist: ${operation.variantId}`);
  const variant = componentSet.variants[index];
  restoreEntryInverse(snapshot, "components", entry, inverseOperations);
  componentSet.variants.splice(index, 1);
  return {
    affectedIds: [
      componentSet.id,
      operation.variantId,
      ...Object.keys(variant.nodes),
    ],
    entries: [entry],
  };
}

function applyUpdateComponentNode(snapshot, operation, inverseOperations) {
  const { componentSet, entry } = componentSetRaw(
    snapshot,
    operation.componentSetId,
  );
  const variant = componentSet.variants.find(
    ({ id }) => id === operation.variantId,
  );
  const node = variant?.nodes[operation.nodeId];
  if (!node)
    fail("missing_node", `Variant Node does not exist: ${operation.nodeId}`);
  const changes = requireRecord(
    operation.changes,
    "invalid_node_changes",
    "update-component-node requires changes",
  );
  if (!Array.isArray(operation.unset ?? [])) {
    fail("invalid_node_unset", "update-component-node unset must be an array");
  }
  restoreEntryInverse(snapshot, "components", entry, inverseOperations);
  for (const field of operation.unset ?? []) delete node[field];
  for (const [field, value] of Object.entries(changes)) {
    node[field] = structuredClone(value);
  }
  return {
    affectedIds: [componentSet.id, variant.id, node.id],
    entries: [entry],
  };
}

function applyPutScenario(snapshot, operation, inverseOperations) {
  const scenario = requireRecord(
    operation.scenario,
    "invalid_scenario",
    "put-scenario requires scenario",
  );
  stableId(scenario.id, "scn_", "invalid_scenario_id", "operation.scenario.id");
  return putCollectionItem(snapshot, operation, inverseOperations, {
    defaultEntry: "scenarios/scenarios.json",
    field: "scenarios",
    id: scenario.id,
    item: scenario,
    kind: "scenarios",
  });
}

function applyDeleteScenario(snapshot, operation, inverseOperations) {
  return deleteCollectionItem(snapshot, operation, inverseOperations, {
    field: "scenarios",
    id: operation.scenarioId,
    kind: "scenarios",
    missingCode: "missing_scenario",
  });
}

function applyPutRequirementFile(snapshot, operation, inverseOperations) {
  const value = requireRecord(
    operation.requirementFile,
    "invalid_requirement_file",
    "put-requirement-file requires requirementFile",
  );
  const entry =
    operation.entry ??
    snapshot.manifest.entries.requirements[0] ??
    "requirements/requirements.json";
  safeEntry(entry);
  const created = !snapshot.manifest.entries.requirements.includes(entry);
  restoreEntryInverse(snapshot, "requirements", entry, inverseOperations);
  if (created) snapshot.manifest.entries.requirements.push(entry);
  snapshot.entries[entry] = structuredClone(value);
  return {
    affectedIds: requirementFileAffectedIds(value),
    entries: created ? ["manifest.json", entry] : [entry],
  };
}

function requirementFileAffectedIds(value) {
  return [
    ...(value.requirements ?? []).map(({ id }) => id),
    ...(value.flows ?? []).map(({ id }) => id),
    ...(value.annotations ?? []).map(({ id }) => id),
  ];
}

function applyDeleteRequirementFile(snapshot, operation, inverseOperations) {
  const entry = operation.entry ?? snapshot.manifest.entries.requirements[0];
  if (!entry || !snapshot.manifest.entries.requirements.includes(entry)) {
    fail("missing_requirement_file", "Requirement file does not exist");
  }
  const value = snapshot.entries[entry];
  restoreEntryInverse(snapshot, "requirements", entry, inverseOperations);
  snapshot.manifest.entries.requirements =
    snapshot.manifest.entries.requirements.filter(
      (candidate) => candidate !== entry,
    );
  delete snapshot.entries[entry];
  return {
    affectedIds: requirementFileAffectedIds(value),
    deletedEntries: [entry],
    entries: ["manifest.json"],
  };
}

function applyPutContextFile(snapshot, operation, inverseOperations) {
  const value = requireRecord(
    operation.contextFile,
    "invalid_context_file",
    "put-context-file requires contextFile",
  );
  const entry = operation.entry ?? "contexts/contexts.json";
  safeEntry(entry);
  const created = !snapshot.manifest.entries.contexts.includes(entry);
  restoreEntryInverse(snapshot, "contexts", entry, inverseOperations);
  if (created) snapshot.manifest.entries.contexts.push(entry);
  snapshot.entries[entry] = structuredClone(value);
  return {
    affectedIds: contextFileAffectedIds(value),
    entries: created ? ["manifest.json", entry] : [entry],
  };
}

function contextFileAffectedIds(value) {
  return [
    ...(value.axes ?? []).map(({ id }) => id),
    ...(value.profiles ?? []).map(({ id }) => id),
  ];
}

function applyDeleteContextFile(snapshot, operation, inverseOperations) {
  const entry = operation.entry;
  if (
    typeof entry !== "string" ||
    !snapshot.manifest.entries.contexts.includes(entry)
  ) {
    fail("missing_context_file", "Context file does not exist");
  }
  const value = snapshot.entries[entry];
  restoreEntryInverse(snapshot, "contexts", entry, inverseOperations);
  snapshot.manifest.entries.contexts =
    snapshot.manifest.entries.contexts.filter(
      (candidate) => candidate !== entry,
    );
  delete snapshot.entries[entry];
  return {
    affectedIds: contextFileAffectedIds(value),
    deletedEntries: [entry],
    entries: ["manifest.json"],
  };
}

function applyPutScreen(snapshot, operation, inverseOperations) {
  const screen = requireRecord(
    operation.screen,
    "invalid_screen",
    "put-screen requires screen",
  );
  stableId(screen.id, "scr_", "invalid_screen_id", "operation.screen.id");
  const existing = snapshot.manifest.entries.screens.find(
    (entry) => snapshot.entries[entry].id === screen.id,
  );
  const entry =
    existing ?? operation.entry ?? `screens/${screen.id.slice(4)}.json`;
  safeEntry(entry);
  const previousDefaultScreenId = snapshot.manifest.defaultScreenId;
  restoreEntryInverse(snapshot, "screens", entry, inverseOperations);
  if (!existing) snapshot.manifest.entries.screens.push(entry);
  snapshot.entries[entry] = structuredClone(screen);
  if (!snapshot.manifest.defaultScreenId) {
    snapshot.manifest.defaultScreenId = screen.id;
    inverseOperations.unshift({
      screenId: previousDefaultScreenId,
      type: "set-default-screen",
    });
  }
  return {
    affectedIds: screenAffectedIds(screen),
    entries: existing ? [entry] : ["manifest.json", entry],
  };
}

function screenAffectedIds(screen) {
  return [
    screen.id,
    ...screen.counterparts.map(({ id }) => id),
    ...screen.presentations.flatMap((presentation) => [
      presentation.id,
      ...presentation.interactions.map(({ id }) => id),
      ...Object.keys(presentation.nodes),
    ]),
  ];
}

function applyDeleteScreen(snapshot, operation, inverseOperations) {
  const entry = snapshot.manifest.entries.screens.find(
    (candidate) => snapshot.entries[candidate].id === operation.screenId,
  );
  if (!entry)
    fail("missing_screen", `Screen does not exist: ${operation.screenId}`);
  const screen = snapshot.entries[entry];
  const previousDefaultScreenId = snapshot.manifest.defaultScreenId;
  restoreEntryInverse(snapshot, "screens", entry, inverseOperations);
  inverseOperations.splice(1, 0, {
    screenId: previousDefaultScreenId,
    type: "set-default-screen",
  });
  snapshot.manifest.entries.screens = snapshot.manifest.entries.screens.filter(
    (candidate) => candidate !== entry,
  );
  delete snapshot.entries[entry];
  if (snapshot.manifest.defaultScreenId === operation.screenId) {
    snapshot.manifest.defaultScreenId = snapshot.manifest.entries.screens[0]
      ? snapshot.entries[snapshot.manifest.entries.screens[0]].id
      : undefined;
  }
  return {
    affectedIds: screenAffectedIds(screen),
    deletedEntries: [entry],
    entries: ["manifest.json"],
  };
}

function applySetDefaultScreen(snapshot, operation, inverseOperations) {
  if (
    operation.screenId !== undefined &&
    !snapshot.manifest.entries.screens.some(
      (entry) => snapshot.entries[entry].id === operation.screenId,
    )
  ) {
    fail("missing_screen", `Screen does not exist: ${operation.screenId}`);
  }
  inverseOperations.unshift({
    screenId: snapshot.manifest.defaultScreenId,
    type: "set-default-screen",
  });
  snapshot.manifest.defaultScreenId = operation.screenId;
  return {
    affectedIds: [operation.screenId ?? "default-screen"],
    entries: ["manifest.json"],
  };
}

function applySetFoundationDependency(snapshot, operation, inverseOperations) {
  if (snapshot.manifest.role !== "product") {
    fail(
      "foundation_dependency_requires_product",
      "Only a Product Package can select a Foundation dependency",
    );
  }
  const dependency = requireRecord(
    operation.dependency,
    "invalid_dependency",
    "set-foundation-dependency requires dependency",
  );
  if (
    Object.keys(dependency).length !== 2 ||
    typeof dependency.packageId !== "string" ||
    !dependency.packageId.startsWith("pkg_") ||
    typeof dependency.path !== "string"
  ) {
    fail(
      "invalid_dependency",
      "Foundation dependency requires packageId and relative path",
    );
  }
  inverseOperations.unshift({
    dependency: structuredClone(snapshot.manifest.dependencies[0]),
    type: "set-foundation-dependency",
  });
  snapshot.manifest.dependencies = [structuredClone(dependency)];
  return {
    affectedIds: [dependency.packageId],
    entries: ["manifest.json"],
  };
}

function applyPutLibrary(snapshot, operation, inverseOperations) {
  const library = requireRecord(
    structuredClone(operation.library),
    "invalid_library",
    "put-library requires a Library descriptor",
  );
  snapshot.manifest.libraries ??= [];
  const existing = snapshot.manifest.libraries.findIndex(
    ({ packageId }) => packageId === library.packageId,
  );
  const index =
    existing < 0
      ? insertionIndex(operation.index, snapshot.manifest.libraries.length)
      : existing;
  if (existing < 0) {
    inverseOperations.unshift({
      packageId: library.packageId,
      type: "remove-library",
    });
    snapshot.manifest.libraries.splice(index, 0, library);
  } else {
    inverseOperations.unshift({
      index,
      library: structuredClone(snapshot.manifest.libraries[index]),
      type: "put-library",
    });
    snapshot.manifest.libraries[index] = library;
  }
  return { affectedIds: [library.packageId], entries: ["manifest.json"] };
}

function applyRemoveLibrary(snapshot, operation, inverseOperations) {
  const libraries = snapshot.manifest.libraries ?? [];
  const index = libraries.findIndex(
    ({ packageId }) => packageId === operation.packageId,
  );
  if (index < 0) {
    fail("missing_library", `Library is not linked: ${operation.packageId}`);
  }
  const [library] = libraries.splice(index, 1);
  inverseOperations.unshift({ index, library, type: "put-library" });
  if (libraries.length === 0) delete snapshot.manifest.libraries;
  return { affectedIds: [operation.packageId], entries: ["manifest.json"] };
}

function interactionPresentation(snapshot, operation) {
  return findPresentationContext(snapshot, operation);
}

function applyPutInteraction(snapshot, operation, inverseOperations) {
  const { entry, presentation } = interactionPresentation(snapshot, operation);
  const interaction = requireRecord(
    operation.interaction,
    "invalid_interaction",
    "put-interaction requires interaction",
  );
  stableId(
    interaction.id,
    "int_",
    "invalid_interaction_id",
    "operation.interaction.id",
  );
  restoreEntryInverse(snapshot, "screens", entry, inverseOperations);
  const index = presentation.interactions.findIndex(
    ({ id }) => id === interaction.id,
  );
  if (index < 0) presentation.interactions.push(structuredClone(interaction));
  else presentation.interactions[index] = structuredClone(interaction);
  return { affectedIds: [interaction.id], entries: [entry] };
}

function applyDeleteInteraction(snapshot, operation, inverseOperations) {
  const { entry, presentation } = interactionPresentation(snapshot, operation);
  const index = presentation.interactions.findIndex(
    ({ id }) => id === operation.interactionId,
  );
  if (index < 0) {
    fail(
      "missing_interaction",
      `Interaction does not exist: ${operation.interactionId}`,
    );
  }
  restoreEntryInverse(snapshot, "screens", entry, inverseOperations);
  presentation.interactions.splice(index, 1);
  return { affectedIds: [operation.interactionId], entries: [entry] };
}

function dtcgTokenLocation(snapshot, tokenIdOrPath, byPath = false) {
  const token = byPath
    ? [...snapshot.domain.tokens.values()].find(
        (candidate) => candidate.path === tokenIdOrPath,
      )
    : snapshot.domain.tokens.get(tokenIdOrPath);
  if (!token) fail("missing_token", `Token does not exist: ${tokenIdOrPath}`);
  const root = snapshot.entries[token.filePath];
  if (Array.isArray(root?.sets) && Array.isArray(root?.themes)) {
    for (const tokenSet of root.sets) {
      const definition = tokenSet.tokens.find(({ id }) => id === token.id);
      if (definition) {
        return {
          definition,
          entry: token.filePath,
          format: "penpot",
          token,
        };
      }
    }
    fail("missing_token_path", `Token path does not exist: ${token.path}`);
  }
  let parent = root;
  const segments = token.path.split(".");
  for (const segment of segments.slice(0, -1)) parent = parent?.[segment];
  const definition = parent?.[segments.at(-1)];
  if (!isRecord(definition)) {
    fail("missing_token_path", `Token path does not exist: ${token.path}`);
  }
  return {
    definition,
    entry: token.filePath,
    key: segments.at(-1),
    parent,
    token,
  };
}

function applySetTokenValue(snapshot, operation, inverseOperations) {
  // Penpot-format libraries allow the same token name in several sets, so a
  // path-only lookup is ambiguous; prefer the permanent tokenId and fall back
  // to the path for DTCG documents and legacy callers.
  const location =
    typeof operation.tokenId === "string" && operation.tokenId.length > 0
      ? dtcgTokenLocation(snapshot, operation.tokenId, false)
      : dtcgTokenLocation(snapshot, operation.path, true);
  restoreEntryInverse(snapshot, "tokens", location.entry, inverseOperations);
  location.definition[location.format === "penpot" ? "value" : "$value"] =
    structuredClone(operation.value);
  return { affectedIds: [location.token.id], entries: [location.entry] };
}

function applyPutToken(snapshot, operation, inverseOperations) {
  safeEntry(operation.filePath);
  if (
    typeof operation.path !== "string" ||
    !TOKEN_NAME_PATTERN.test(operation.path)
  ) {
    fail("invalid_token_path", `Token path is invalid: ${operation.path}`);
  }
  stableId(operation.tokenId, "tok_", "invalid_token_id", "operation.tokenId");
  const definition = requireRecord(
    operation.definition,
    "invalid_token_definition",
    "put-token requires definition",
  );
  if (definition.$extensions?.smallpen?.id !== operation.tokenId) {
    fail(
      "token_id_mismatch",
      "put-token tokenId must match definition.$extensions.smallpen.id",
    );
  }
  const created = !snapshot.manifest.entries.tokens.includes(
    operation.filePath,
  );
  restoreEntryInverse(
    snapshot,
    "tokens",
    operation.filePath,
    inverseOperations,
  );
  if (created) {
    snapshot.manifest.entries.tokens.push(operation.filePath);
    snapshot.entries[operation.filePath] = {};
  }
  let parent = snapshot.entries[operation.filePath];
  const segments = operation.path.split(".");
  for (const segment of segments.slice(0, -1)) {
    if (parent[segment] === undefined) parent[segment] = {};
    if (!isRecord(parent[segment])) {
      fail("invalid_token_path", `Token group is not an object: ${segment}`);
    }
    parent = parent[segment];
  }
  parent[segments.at(-1)] = structuredClone(definition);
  return {
    affectedIds: [operation.tokenId],
    entries: created
      ? ["manifest.json", operation.filePath]
      : [operation.filePath],
  };
}

function applyRemoveToken(snapshot, operation, inverseOperations) {
  const location = dtcgTokenLocation(snapshot, operation.tokenId);
  restoreEntryInverse(snapshot, "tokens", location.entry, inverseOperations);
  delete location.parent[location.key];
  return { affectedIds: [operation.tokenId], entries: [location.entry] };
}

function applyDeprecateToken(snapshot, operation, inverseOperations) {
  const location = dtcgTokenLocation(snapshot, operation.tokenId);
  restoreEntryInverse(snapshot, "tokens", location.entry, inverseOperations);
  const extension = location.definition.$extensions?.smallpen;
  if (!isRecord(extension)) {
    fail(
      "missing_token_id",
      `Token has no SmallPen extension: ${operation.tokenId}`,
    );
  }
  extension.deprecated = true;
  if (operation.replacement !== undefined) {
    extension.replacement = structuredClone(operation.replacement);
  }
  return { affectedIds: [operation.tokenId], entries: [location.entry] };
}

function basePresentationContext(snapshot, operation) {
  const { entry, screen } = findScreenContext(snapshot, operation.screenId);
  const presentationId = operation.presentationId ?? screen.basePresentationId;
  const presentation = screen.presentations.find(
    ({ id }) => id === presentationId,
  );
  if (!presentation) {
    fail(
      "missing_presentation",
      `Presentation does not exist: ${presentationId}`,
    );
  }
  return { entry, presentation, screen };
}

function applySetTokenBinding(snapshot, operation, inverseOperations) {
  const { entry, presentation } = basePresentationContext(snapshot, operation);
  const node = presentation.nodes[operation.nodeId];
  if (!node) fail("missing_node", `Node does not exist: ${operation.nodeId}`);
  restoreEntryInverse(snapshot, "screens", entry, inverseOperations);
  node.tokenBindings ??= {};
  node.tokenBindings[operation.field] = structuredClone(operation.binding);
  return { affectedIds: [node.id], entries: [entry] };
}

function applyClearTokenBinding(snapshot, operation, inverseOperations) {
  const { entry, presentation } = basePresentationContext(snapshot, operation);
  const node = presentation.nodes[operation.nodeId];
  if (!node) fail("missing_node", `Node does not exist: ${operation.nodeId}`);
  if (!Object.hasOwn(node.tokenBindings ?? {}, operation.field)) {
    fail(
      "missing_token_binding",
      `Token binding does not exist: ${operation.field}`,
    );
  }
  restoreEntryInverse(snapshot, "screens", entry, inverseOperations);
  delete node.tokenBindings[operation.field];
  return { affectedIds: [node.id], entries: [entry] };
}

function applySelectInstanceVariant(snapshot, operation, inverseOperations) {
  const { entry, presentation } = basePresentationContext(snapshot, operation);
  const node = presentation.nodes[operation.nodeId];
  if (!node?.instance)
    fail("missing_instance", `Node is not an Instance: ${operation.nodeId}`);
  restoreEntryInverse(snapshot, "screens", entry, inverseOperations);
  node.instance.variant = structuredClone(operation.selection);
  return { affectedIds: [node.id], entries: [entry] };
}

function rawReferenceLocation(snapshot, referencePath) {
  const entry = Object.keys(snapshot.entries)
    .sort((left, right) => right.length - left.length)
    .find((candidate) => referencePath.startsWith(`${candidate}.`));
  if (!entry) {
    fail(
      "unsupported_repair_path",
      `Repair path is not a Canonical entry: ${referencePath}`,
    );
  }
  const source = referencePath.slice(entry.length + 1);
  const segments = [];
  const expression = /([^.\[\]]+)|\[(\d+)\]/g;
  let match;
  while ((match = expression.exec(source))) {
    segments.push(match[1] ?? Number(match[2]));
  }
  let parent = snapshot.entries[entry];
  for (const segment of segments.slice(0, -1)) parent = parent?.[segment];
  const key = segments.at(-1);
  if (!parent || key === undefined || !Object.hasOwn(parent, key)) {
    fail(
      "missing_repair_reference",
      `Repair reference is missing: ${referencePath}`,
    );
  }
  const kind = ENTRY_KINDS.find((candidate) =>
    snapshot.manifest.entries[candidate].includes(entry),
  );
  return { entry, key, kind, parent };
}

function applyRepairReference(snapshot, operation, inverseOperations) {
  if (
    operation.action !== "retarget-reference" &&
    operation.action !== "remove-dependent-usage"
  ) {
    fail(
      "unsupported_repair_action",
      `Repair action is unsupported: ${operation.action}`,
    );
  }
  const location = rawReferenceLocation(snapshot, operation.referencePath);
  restoreEntryInverse(
    snapshot,
    location.kind,
    location.entry,
    inverseOperations,
  );
  if (operation.action === "retarget-reference") {
    if (!isRecord(operation.replacement)) {
      fail(
        "missing_repair_replacement",
        "Retarget Repair requires replacement",
      );
    }
    location.parent[location.key] = structuredClone(operation.replacement);
  } else if (
    !Array.isArray(location.parent) &&
    isRecord(location.parent[location.key]) &&
    typeof location.parent[location.key].id === "string" &&
    location.parent[location.key].id.startsWith("node_") &&
    operation.referencePath.includes(".nodes.")
  ) {
    const removedIds = [];
    const removeNode = (nodeId) => {
      const node = location.parent[nodeId];
      if (!node) return;
      for (const childId of node.children ?? []) removeNode(childId);
      delete location.parent[nodeId];
      removedIds.push(nodeId);
    };
    removeNode(location.parent[location.key].id);
    for (const node of Object.values(location.parent)) {
      if (Array.isArray(node?.children)) {
        node.children = node.children.filter(
          (childId) => !removedIds.includes(childId),
        );
      }
    }
    return {
      affectedIds: removedIds,
      entries: [location.entry],
    };
  } else if (Array.isArray(location.parent)) {
    const removed = location.parent.splice(location.key, 1)[0];
    return {
      affectedIds: [removed?.id ?? operation.referencePath],
      entries: [location.entry],
    };
  } else {
    delete location.parent[location.key];
  }
  return {
    affectedIds:
      operation.action === "retarget-reference"
        ? [operation.replacement.assetId]
        : [operation.referencePath],
    entries: [location.entry],
  };
}

// Pre-commit protection (SP-014): reject batches whose final component state
// contains an instance reference cycle. Existing packages that already carry a
// cycle still load so the returned inverse batch can repair them.
function validateComponentAcyclicity(snapshot) {
  const graph = new Map();
  for (const componentSet of snapshot.domain.componentSets.values()) {
    const references = new Set();
    for (const variant of componentSet.variants ?? []) {
      for (const node of Object.values(variant.nodes ?? {})) {
        const reference = node.instance?.component;
        if (!reference) continue;
        const assetId =
          typeof reference === "string" ? reference : reference.assetId;
        const packageId =
          typeof reference === "string"
            ? snapshot.manifest.packageId
            : reference.packageId ?? snapshot.manifest.packageId;
        if (packageId !== snapshot.manifest.packageId) continue;
        references.add(assetId);
      }
    }
    graph.set(componentSet.id, references);
  }
  const status = new Map();
  const visit = (componentId, path) => {
    const state = status.get(componentId);
    if (state === "done") return;
    if (state === "visiting") {
      fail(
        "component_cycle",
        `Component reference cycle: ${[...path, componentId].join(" -> ")}`,
        { cycle: [...path, componentId] },
      );
    }
    status.set(componentId, "visiting");
    for (const next of graph.get(componentId) ?? []) {
      if (graph.has(next)) visit(next, [...path, componentId]);
    }
    status.set(componentId, "done");
  };
  for (const componentId of graph.keys()) visit(componentId, []);
}

export async function prepareOperationBatch(before, batch) {  if (
    !isRecord(batch) ||
    typeof batch.batchId !== "string" ||
    batch.batchId.length === 0 ||
    batch.batchId.length > 192 ||
    !/^[a-zA-Z0-9_.-]+$/.test(batch.batchId)
  ) {
    fail(
      "invalid_batch",
      "Operation Batch batchId must be a stable 1-192 character identity",
    );
  }
  if (batch.baseRevision !== before.revision) {
    fail(
      "stale_revision",
      "Operation Batch baseRevision is stale; refresh and replay the intent",
      {
        actualRevision: before.revision,
        baseRevision: batch.baseRevision,
        nextOperations: [
          {
            args: { locator: before.locator, revision: before.revision },
            operation: "smallpen.refresh",
          },
          {
            args: {
              baseRevision: before.revision,
              batchId: "<new-unique-batch-id>",
              operations: Array.isArray(batch.operations)
                ? structuredClone(batch.operations)
                : [],
            },
            operation: "smallpen.apply.replay-intent",
          },
        ],
      },
    );
  }
  if (!Array.isArray(batch.operations))
    fail("invalid_batch", "Operation Batch operations must be an array");

  const candidate = structuredClone(before);
  const affectedIds = new Set();
  const changedFiles = new Set();
  const deletedFiles = new Set();
  const inverseOperations = [];
  for (const operation of batch.operations) {
    if (!isRecord(operation)) {
      fail("invalid_operation", "Canonical operation must contain an object");
    }
    let applied;
    switch (operation.type) {
      case "add-component":
        applied = applyAddComponent(candidate, operation, inverseOperations);
        break;
      case "add-presentation":
        applied = applyAddPresentation(candidate, operation, inverseOperations);
        break;
      case "add-presentation-node":
        applied = applyAddPresentationNode(
          candidate,
          operation,
          inverseOperations,
        );
        break;
      case "clear-token-binding":
        applied = applyClearTokenBinding(
          candidate,
          operation,
          inverseOperations,
        );
        break;
      case "delete-component-set":
        applied = applyDeleteComponentSet(
          candidate,
          operation,
          inverseOperations,
        );
        break;
      case "delete-context-file":
        applied = applyDeleteContextFile(
          candidate,
          operation,
          inverseOperations,
        );
        break;
      case "delete-interaction":
        applied = applyDeleteInteraction(
          candidate,
          operation,
          inverseOperations,
        );
        break;
      case "delete-requirement-file":
        applied = applyDeleteRequirementFile(
          candidate,
          operation,
          inverseOperations,
        );
        break;
      case "delete-scenario":
        applied = applyDeleteScenario(candidate, operation, inverseOperations);
        break;
      case "delete-screen":
        applied = applyDeleteScreen(candidate, operation, inverseOperations);
        break;
      case "delete-variant":
        applied = applyDeleteVariant(candidate, operation, inverseOperations);
        break;
      case "deprecate-token":
        applied = applyDeprecateToken(candidate, operation, inverseOperations);
        break;
      case "delete-presentation":
        applied = applyDeletePresentation(
          candidate,
          operation,
          inverseOperations,
        );
        break;
      case "delete-presentation-node":
        applied = applyDeletePresentationNode(
          candidate,
          operation,
          inverseOperations,
        );
        break;
      case "delete-component":
        applied = applyDeleteComponent(candidate, operation, inverseOperations);
        break;
      case "move-presentation":
        applied = applyMovePresentation(
          candidate,
          operation,
          inverseOperations,
        );
        break;
      case "move-presentation-nodes":
        applied = applyMovePresentationNodes(
          candidate,
          operation,
          inverseOperations,
        );
        break;
      case "put-component-set":
        applied = applyPutComponentSet(candidate, operation, inverseOperations);
        break;
      case "put-context-file":
        applied = applyPutContextFile(candidate, operation, inverseOperations);
        break;
      case "put-interaction":
        applied = applyPutInteraction(candidate, operation, inverseOperations);
        break;
      case "put-library":
        applied = applyPutLibrary(candidate, operation, inverseOperations);
        break;
      case "put-requirement-file":
        applied = applyPutRequirementFile(
          candidate,
          operation,
          inverseOperations,
        );
        break;
      case "put-scenario":
        applied = applyPutScenario(candidate, operation, inverseOperations);
        break;
      case "put-screen":
        applied = applyPutScreen(candidate, operation, inverseOperations);
        break;
      case "put-token":
        applied = applyPutToken(candidate, operation, inverseOperations);
        break;
      case "put-variant":
        applied = applyPutVariant(candidate, operation, inverseOperations);
        break;
      case "remove-token":
        applied = applyRemoveToken(candidate, operation, inverseOperations);
        break;
      case "remove-library":
        applied = applyRemoveLibrary(candidate, operation, inverseOperations);
        break;
      case "repair-reference":
        applied = applyRepairReference(candidate, operation, inverseOperations);
        break;
      case "restore-canonical-entry":
        applied = applyRestoreCanonicalEntry(
          candidate,
          operation,
          inverseOperations,
        );
        break;
      case "update-presentation":
        applied = applyUpdatePresentation(
          candidate,
          operation,
          inverseOperations,
        );
        break;
      case "reorder-presentation-children":
        applied = applyReorderPresentationChildren(
          candidate,
          operation,
          inverseOperations,
        );
        break;
      case "replace-asset-library":
        applied = applyReplaceAssetLibrary(
          candidate,
          operation,
          inverseOperations,
        );
        break;
      case "replace-token-library":
        applied = applyReplaceTokenLibrary(
          candidate,
          operation,
          inverseOperations,
        );
        break;
      case "select-instance-variant":
        applied = applySelectInstanceVariant(
          candidate,
          operation,
          inverseOperations,
        );
        break;
      case "set-default-screen":
        applied = applySetDefaultScreen(
          candidate,
          operation,
          inverseOperations,
        );
        break;
      case "set-foundation-dependency":
        applied = applySetFoundationDependency(
          candidate,
          operation,
          inverseOperations,
        );
        break;
      case "set-active-token-themes":
        applied = applySetActiveTokenThemes(
          candidate,
          operation,
          inverseOperations,
        );
        break;
      case "set-token-binding":
        applied = applySetTokenBinding(candidate, operation, inverseOperations);
        break;
      case "set-token-value":
        applied = applySetTokenValue(candidate, operation, inverseOperations);
        break;
      case "update-component-node":
        applied = applyUpdateComponentNode(
          candidate,
          operation,
          inverseOperations,
        );
        break;
      case "update-node": {
        const { screen } = findScreenContext(candidate, operation.screenId);
        applied = {
          affectedIds: [operation.nodeId],
          entry: applyUpdatePresentationNode(
            candidate,
            {
              ...operation,
              presentationId: screen.basePresentationId,
              type: "update-presentation-node",
            },
            inverseOperations,
          ),
        };
        break;
      }
      case "update-presentation-node":
        applied = {
          affectedIds: [operation.nodeId],
          entry: applyUpdatePresentationNode(
            candidate,
            operation,
            inverseOperations,
          ),
        };
        break;
      case "update-component":
        applied = applyUpdateComponent(candidate, operation, inverseOperations);
        break;
      default:
        fail(
          "unsupported_operation",
          `Phase 0 cannot apply operation: ${String(operation?.type)}`,
        );
    }
    for (const entry of applied.entries ?? [applied.entry]) {
      changedFiles.add(entry);
      deletedFiles.delete(entry);
    }
    for (const entry of applied.deletedEntries ?? []) {
      changedFiles.delete(entry);
      deletedFiles.add(entry);
    }
    for (const nodeId of applied.affectedIds) affectedIds.add(nodeId);
  }

  if (changedFiles.size === 0 && deletedFiles.size === 0) {
    const inverseBatch = {
      baseRevision: before.revision,
      batchId: `${batch.batchId}_inverse`,
      operations: [],
    };
    return {
      result: {
        affectedIds: [],
        batchId: batch.batchId,
        changedFiles: [],
        deletedFiles: [],
        guidance: {
          refresh: {
            args: { affectedIds: [], revision: before.revision },
            operation: "smallpen.refresh-projection",
          },
          undo: {
            args: { batch: inverseBatch },
            operation: "smallpen.apply",
          },
        },
        inverseBatch,
        revision: before.revision,
      },
      snapshot: before,
    };
  }

  const values = new Map([["manifest.json", candidate.manifest]]);
  for (const [entry, value] of Object.entries(candidate.entries)) {
    values.set(entry, value);
  }
  for (const [entry, value] of candidate.blobs) {
    values.set(entry, value);
  }
  const validated = await loadPackageFromValues(before.locator, values);
  validateComponentAcyclicity(validated);
  const normalizedAffectedIds = [...affectedIds].sort();
  const inverseBatch = {
    baseRevision: validated.revision,
    batchId: `${batch.batchId}_inverse`,
    operations: inverseOperations,
  };
  return {
    result: {
      affectedIds: normalizedAffectedIds,
      batchId: batch.batchId,
      changedFiles: [...changedFiles].sort(),
      deletedFiles: [...deletedFiles].sort(),
      guidance: {
        refresh: {
          args: {
            affectedIds: normalizedAffectedIds,
            revision: validated.revision,
          },
          operation: "smallpen.refresh-projection",
        },
        undo: {
          args: { batch: inverseBatch },
          operation: "smallpen.apply",
        },
      },
      inverseBatch,
      revision: validated.revision,
    },
    snapshot: validated,
  };
}
