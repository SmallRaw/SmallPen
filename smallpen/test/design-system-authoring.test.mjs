// DSP-017: Authoring Intent validation and mapping to canonical operations.
import assert from "node:assert/strict";
import test from "node:test";
import {
  intentToOperations,
  validateAuthoringIntent,
} from "@smallpen/core";

const validIntent = {
  action: "set-token-value",
  target: {
    ownerPackageId: "pkg_design_system",
    source: "product",
    path: "base",
    tokenId: "tok_radius_md_base",
    filePath: "tokens/tokens.json",
  },
  value: 12,
};

test("validates a well-formed authoring intent", () => {
  const result = validateAuthoringIntent(validIntent);
  assert.equal(result.ok, true);
});

test("rejects read-only source targets", () => {
  const intent = {
    ...validIntent,
    target: { ...validIntent.target, source: "library" },
  };
  const result = validateAuthoringIntent(intent);
  assert.equal(result.ok, false);
  assert.equal(result.code, "read_only_source");
});

test("rejects missing owner", () => {
  const intent = { ...validIntent, target: { ...validIntent.target, ownerPackageId: undefined } };
  const result = validateAuthoringIntent(intent);
  assert.equal(result.ok, false);
  assert.equal(result.code, "missing_owner");
});

test("rejects unsupported actions", () => {
  const intent = { ...validIntent, action: "delete-everything" };
  const result = validateAuthoringIntent(intent);
  assert.equal(result.ok, false);
  assert.equal(result.code, "unsupported_action");
});

test("rejects alias set with a non-expression value", () => {
  const intent = {
    action: "set-token-alias",
    target: validIntent.target,
    value: "#ff0000",
  };
  const result = validateAuthoringIntent(intent);
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_alias_expression");
});

test("accepts alias set with a proper {path} expression", () => {
  const intent = {
    action: "set-token-alias",
    target: validIntent.target,
    value: "{color.primary}",
  };
  const result = validateAuthoringIntent(intent);
  assert.equal(result.ok, true);
});

test("intentToOperations maps set-token-value to canonical op", () => {
  const ops = intentToOperations(validIntent, {});
  assert.equal(ops.length, 1);
  assert.equal(ops[0].type, "set-token-value");
  assert.equal(ops[0].value, 12);
  assert.equal(ops[0].tokenId, "tok_radius_md_base");
});

test("intentToOperations maps set-token-alias to canonical op with expression", () => {
  const intent = {
    action: "set-token-alias",
    target: validIntent.target,
    value: "{color.primary}",
  };
  const ops = intentToOperations(intent, {});
  assert.equal(ops[0].value, "{color.primary}");
});

test("rejects intents targeting resolved-only values (no raw path)", () => {
  const intent = {
    action: "set-token-value",
    target: { source: "product" },
    value: 8,
  };
  const result = validateAuthoringIntent(intent);
  assert.equal(result.ok, false);
  assert.equal(result.code, "missing_owner");
});
