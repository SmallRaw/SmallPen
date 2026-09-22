// DSP-017: Authoring Intent data contract and mapping to canonical operations.
//
// The workbench expresses edits as Authoring Intents; this module validates
// each intent (owner/readOnly/alias-vs-value) and compiles it into existing
// canonical Operation Batch operations. No new write paths are introduced.
import { fail } from "./errors.mjs";

const SUPPORTED_ACTIONS = new Set([
  "set-token-value",
  "set-token-alias",
  "clear-token-alias",
  "add-variant-override",
  "remove-variant-override",
  "update-component-definition",
]);

const READ_ONLY_SOURCES = new Set(["library", "foundation"]);

export function validateAuthoringIntent(intent) {
  if (!intent || typeof intent !== "object") {
    return { ok: false, code: "invalid_intent", message: "Intent must be an object" };
  }
  if (!SUPPORTED_ACTIONS.has(intent.action)) {
    return {
      ok: false,
      code: "unsupported_action",
      message: `Unsupported authoring action: ${intent.action}`,
    };
  }
  if (!intent.target || typeof intent.target !== "object") {
    return { ok: false, code: "missing_target", message: "Intent target is required" };
  }
  const target = intent.target;
  if (!target.ownerPackageId || typeof target.ownerPackageId !== "string") {
    return { ok: false, code: "missing_owner", message: "Intent target ownerPackageId is required" };
  }
  if (READ_ONLY_SOURCES.has(target.source)) {
    return {
      ok: false,
      code: "read_only_source",
      message: `Cannot write to read-only source: ${target.source}`,
    };
  }
  if (intent.action === "set-token-value" || intent.action === "set-token-alias") {
    if (intent.value === undefined) {
      return { ok: false, code: "missing_value", message: "Token value is required" };
    }
    // Resolved values must not overwrite alias expressions.
    if (
      intent.action === "set-token-alias" &&
      typeof intent.value === "string" &&
      !/^\{[^{}]+\}$/.test(intent.value)
    ) {
      return {
        ok: false,
        code: "invalid_alias_expression",
        message: `Alias expression must be {path}, got: ${intent.value}`,
      };
    }
  }
  return { ok: true };
}

export function intentToOperations(intent, snapshot) {
  const validation = validateAuthoringIntent(intent);
  if (!validation.ok) {
    fail(validation.code, validation.message);
  }
  const target = intent.target;
  const packageId = target.ownerPackageId;
  switch (intent.action) {
    case "set-token-value": {
      return [{
        type: "set-token-value",
        filePath: target.filePath ?? "tokens/tokens.json",
        path: target.path,
        tokenId: target.tokenId,
        value: intent.value,
      }];
    }
    case "set-token-alias": {
      return [{
        type: "set-token-value",
        filePath: target.filePath ?? "tokens/tokens.json",
        path: target.path,
        tokenId: target.tokenId,
        value: intent.value,
      }];
    }
    case "clear-token-alias": {
      return [{
        type: "set-token-value",
        filePath: target.filePath ?? "tokens/tokens.json",
        path: target.path,
        tokenId: target.tokenId,
        value: intent.fallbackValue,
      }];
    }
    default:
      fail("unsupported_intent_action", `No compiler for action: ${intent.action}`);
  }
}
