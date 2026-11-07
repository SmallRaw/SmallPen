// The canonical shadow is {offsetX, offsetY, blur, spread, color} with
// optional opacity, inset, hidden, style and id (a DTCG shadow, which is
// also what Penpot's token manager writes). Shadows edited in Penpot keep
// its kebab-case offset-x/offset-y. Older packages used {x, y}: they still
// load and read as offsetX/offsetY, but writes reject them.
import { fail } from "./errors.mjs";
import { isRecord } from "./internal.mjs";

const NUMBER_FIELDS = ["blur", "offset-x", "offset-y", "offsetX", "offsetY", "spread"];
const LEGACY_FIELDS = { x: "offsetX", y: "offsetY" };

function entries(value) {
  return Array.isArray(value) ? value : [value];
}

export function hasLegacyShadowShape(value) {
  return entries(value).some(
    (shadow) =>
      isRecord(shadow) &&
      Object.keys(LEGACY_FIELDS).some((field) => Object.hasOwn(shadow, field)),
  );
}

// Reads a legacy {x, y} shadow as {offsetX, offsetY}; other values pass
// through unchanged.
export function normalizeShadowValue(value) {
  if (!hasLegacyShadowShape(value)) return value;
  const normalize = (shadow) => {
    if (!isRecord(shadow)) return shadow;
    const { x, y, ...rest } = shadow;
    return {
      ...rest,
      ...(x !== undefined && rest.offsetX === undefined ? { offsetX: x } : {}),
      ...(y !== undefined && rest.offsetY === undefined ? { offsetY: y } : {}),
    };
  };
  return Array.isArray(value) ? value.map(normalize) : normalize(value);
}

function received(value) {
  return value === undefined ? "received nothing" : `received ${JSON.stringify(value)}`;
}

function checkShadow(value, path) {
  if (typeof value === "string" && /^\{[^{}]+\}$/.test(value)) return;
  if (!isRecord(value) && !Array.isArray(value)) {
    fail(
      "invalid_shadow_shape",
      `${path} must be a shadow {offsetX, offsetY, blur, spread, color} or an array of them; ${received(value)}`,
      { path, value },
    );
  }
  for (const [index, shadow] of entries(value).entries()) {
    const shadowPath = Array.isArray(value) ? `${path}[${index}]` : path;
    if (!isRecord(shadow)) {
      fail(
        "invalid_shadow_shape",
        `${shadowPath} must be an object {offsetX, offsetY, blur, spread, color}; ${received(shadow)}`,
        { path: shadowPath, value: shadow },
      );
    }
    const legacy = Object.keys(LEGACY_FIELDS).filter((field) =>
      Object.hasOwn(shadow, field),
    );
    if (legacy.length > 0) {
      const suggestion = normalizeShadowValue(shadow);
      fail(
        "invalid_shadow_shape",
        `${shadowPath} uses ${legacy.join("/")}; shadow offsets are ` +
          `${legacy.map((field) => LEGACY_FIELDS[field]).join("/")}. ` +
          `Did you mean ${JSON.stringify(suggestion)}?`,
        {
          field: legacy[0],
          path: shadowPath,
          suggestion,
          validFields: ["offsetX", "offsetY", "blur", "spread", "color", "opacity", "inset"],
        },
      );
    }
    for (const field of NUMBER_FIELDS) {
      const length = shadow[field];
      // Penpot's token manager keeps lengths as strings ("4" or "4px").
      if (
        length !== undefined &&
        !(typeof length === "number" && Number.isFinite(length)) &&
        !(typeof length === "string" && /^\s*-?(\d+(\.\d*)?|\.\d+)(px)?\s*$/.test(length)) &&
        !(typeof length === "string" && /^\{[^{}]+\}$/.test(length))
      ) {
        fail(
          "invalid_shadow_shape",
          `${shadowPath}.${field} must be a number (px); ${received(length)}`,
          { field, path: `${shadowPath}.${field}`, value: length },
        );
      }
    }
  }
}

// Every shadow value an operation writes: node shadow fields, DTCG
// definitions and Form A tokens of type shadow, overrides of shadow.
// tokenType(tokenId) answers set-token-value targets.
export function checkOperationShadows(operation, operationIndex, tokenType) {
  const path = `operations[${operationIndex}]`;
  if (operation.type === "set-token-value") {
    const type = tokenType(operation.tokenId, operation.path);
    if (type === "shadow") checkShadow(operation.value, `${path}.value`);
    return;
  }
  if (
    operation.type === "set-instance-override" &&
    typeof operation.overridePath === "string" &&
    operation.overridePath.endsWith(":shadow")
  ) {
    checkShadow(operation.value, `${path}.value`);
    return;
  }
  const visit = (value, valuePath, depth) => {
    if (depth > 64 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, `${valuePath}[${index}]`, depth + 1));
      return;
    }
    if (value.$type === "shadow") {
      if (Object.hasOwn(value, "$value")) checkShadow(value.$value, `${valuePath}.$value`);
      for (const [index, candidate] of (
        value.$extensions?.smallpen?.contextValues ?? []
      ).entries()) {
        if (isRecord(candidate) && Object.hasOwn(candidate, "value")) {
          checkShadow(
            candidate.value,
            `${valuePath}.$extensions.smallpen.contextValues[${index}].value`,
          );
        }
      }
    }
    if (value.type === "shadow" && Object.hasOwn(value, "value")) {
      checkShadow(value.value, `${valuePath}.value`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "shadow" && child !== null && child !== undefined) {
        checkShadow(child, `${valuePath}.shadow`);
      } else {
        visit(child, `${valuePath}.${key}`, depth + 1);
      }
    }
  };
  visit(operation, path, 0);
}
