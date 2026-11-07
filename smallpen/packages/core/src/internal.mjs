// Helpers shared by Core modules. Not exported from index.mjs.
import { fail } from "./errors.mjs";

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function stableId(value, prefix, code, path) {
  if (
    typeof value !== "string" ||
    !value.startsWith(prefix) ||
    !/^[a-zA-Z0-9_-]+$/.test(value)
  ) {
    fail(code, `${path} must begin with ${prefix}`, { path, value });
  }
  return value;
}

// Locale-independent string order (UTF-16 code units). Use it wherever the
// order reaches canonical bytes, revisions, ids, or other persisted output:
// localeCompare depends on the host locale (Danish sorts "aa" after "ab").
export function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Property names that resolve through, or replace, Object.prototype. Ids,
// path segments, and token names that become property keys must not use them.
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function isReservedKey(key) {
  return RESERVED_KEYS.has(key);
}

// Own-property lookup for id-indexed records and path traversal, so a
// package- or operation-controlled key never resolves to an inherited value.
export function ownValue(record, key) {
  return record !== null &&
    typeof record === "object" &&
    (typeof key === "string" || typeof key === "number") &&
    Object.hasOwn(record, key)
    ? record[key]
    : undefined;
}

// Token names are dot-separated paths. validateTokenLibrary, put-token, and
// the token importer all apply this one rule.
const TOKEN_NAME_PATTERN = /^[a-zA-Z0-9_-][a-zA-Z0-9$_-]*(\.[a-zA-Z0-9$_-]+)*$/;

export function isTokenName(value) {
  return (
    typeof value === "string" &&
    TOKEN_NAME_PATTERN.test(value) &&
    !value.split(".").some(isReservedKey)
  );
}

// Fields an Instance or Scenario override may write on a projected node:
// what Penpot lets a copy change (its touched groups). tokenBindings holds
// the copy's own Token bindings, only where they differ from its source
// ({field: reference}, or null to drop a source binding); variant switches
// a nested instance. A copy's children keep their source positions: moving
// one would need its position in the copy's frame, which projection does
// not compare yet.
export const OVERRIDE_FIELDS = new Set([
  "cornerRadius",
  "fills",
  "height",
  // Links from an element inside a copy (Penpot keeps them on the copy's
  // child).
  "interactions",
  "name",
  "opacity",
  "shadow",
  "strokes",
  "text",
  "textStyle",
  "tokenBindings",
  "variant",
  "visible",
  "width",
]);

// The node field each Token binding writes, for touched groups and for
// dropping a binding when its value is edited by hand.
export function bindingTargetField(field) {
  if (field === "fill" || field.startsWith("fills.")) return "fills";
  if (field === "stroke" || field.startsWith("strokes.") || field.startsWith("strokeWidth")) return "strokes";
  if (field === "cornerRadius" || field.startsWith("radius")) return "cornerRadius";
  if (["typography", "fontFamily", "fontSize", "fontWeight", "letterSpacing", "lineHeight", "textTransform", "textDecoration"].includes(field))
    return "textStyle";
  if (["width", "minWidth", "maxWidth"].includes(field)) return "width";
  if (["height", "minHeight", "maxHeight"].includes(field)) return "height";
  return field;
}

// The Penpot touched groups an Instance override of `field` stands for. A
// TEXT node keeps text, fills and its text style in its content: Penpot
// touches the content group plus the sub-group naming which part changed,
// and its main-component sync keeps only the parts so named. Token bindings
// touch the groups of the fields they write.
export function overrideTouchedGroups(field, nodeType, value) {
  if (field === "text") return ["content-group", "text-content-text"];
  if (field === "fills" || field === "textStyle") {
    return nodeType === "TEXT"
      ? ["content-group", "text-content-attribute"]
      : field === "fills" ? ["fill-group"] : [];
  }
  if (field === "name") return ["name-group"];
  if (field === "opacity") return ["layer-effects-group"];
  if (field === "visible") return ["visibility-group"];
  if (field === "strokes") return ["stroke-group"];
  if (field === "width" || field === "height") return ["geometry-group"];
  if (field === "cornerRadius") return ["radius-group"];
  if (field === "shadow") return ["shadow-group"];
  if (field === "tokenBindings" && value && typeof value === "object") {
    return [...new Set(Object.keys(value).flatMap((binding) =>
      overrideTouchedGroups(bindingTargetField(binding), nodeType)))];
  }
  return [];
}

// Nesting limit for node trees. Validation, projection, and reads walk trees
// recursively; a deeper tree fails validation instead of exhausting the stack.
export const MAX_NODE_DEPTH = 512;

// Package values are JSON trees that cloning, validation and canonical output
// walk recursively. A deeper value fails here instead of exhausting the stack.
const MAX_VALUE_DEPTH = 256;

export function assertValueDepth(value, entry) {
  const stack = [[value, 0]];
  while (stack.length > 0) {
    const [current, depth] = stack.pop();
    if (current === null || typeof current !== "object") continue;
    if (ArrayBuffer.isView(current)) continue;
    if (depth >= MAX_VALUE_DEPTH) {
      fail(
        "package_value_too_deep",
        `${entry} nests deeper than ${MAX_VALUE_DEPTH} levels`,
        { entry, maxDepth: MAX_VALUE_DEPTH },
      );
    }
    for (const child of Object.values(current)) stack.push([child, depth + 1]);
  }
}
