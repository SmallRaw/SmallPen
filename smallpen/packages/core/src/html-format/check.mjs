// INPUT:  every file of a .smallpen directory: path -> text or bytes
// OUTPUT: located issues (file:line:column), counts and the loaded snapshot
// POS:    `smallpen check`: syntax and rule checks without rendering. The
//         strict model validation runs last, on what the reader produced.

import { loadPackageFromValues } from "../package.mjs";
import { decodePackageFiles } from "./package-decode.mjs";

export async function checkPackageFiles(files, options = {}) {
  const decoded = await decodePackageFiles(files, options);
  const issues = [...decoded.issues];
  let snapshot;
  if (!issues.some((issue) => issue.severity === "error") && options.load !== false) {
    try {
      snapshot = await loadPackageFromValues(options.locator ?? "package", decoded.values, options.loadOptions);
    } catch (error) {
      issues.push({
        file: "",
        line: 0,
        column: 0,
        severity: "error",
        code: error.code ?? "invalid_package",
        message: error.message,
      });
    }
  }
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const uses = tokenUseCounts(decoded.values.values());
  const unused = [...uses.values()].filter((count) => count === 0).length;
  return {
    ok: errors === 0,
    errors,
    warnings: issues.length - errors,
    issues,
    summary: { ...decoded.summary, ...(unused ? { unusedTokens: unused } : {}) },
    values: decoded.values,
    snapshot,
  };
}

// One line per issue: path:line:column severity code message.
export function formatIssues(issues) {
  return issues
    .map((issue) =>
      `${issue.file || "package"}${issue.line ? `:${issue.line}:${issue.column}` : ""} ${issue.severity} ${issue.code} ${issue.message}`,
    )
    .join("\n");
}

// In how many places each Token (by name) is used: each page and each
// component that binds it (its copies' overrides too) counts once, and each
// Token that is an alias of it. A Token used by no design may still be
// meant for code; this only counts the design.
export function tokenUseCounts(values) {
  const names = new Map();
  const list = [...values];
  for (const value of list)
    for (const set of value?.sets ?? [])
      for (const token of set.tokens ?? []) names.set(token.id, token.name);
  const uses = new Map([...new Set(names.values())].map((name) => [name, 0]));
  const count = (name) => uses.has(name) && uses.set(name, uses.get(name) + 1);
  const walk = (value, seen) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, seen);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (typeof value.assetId === "string" && names.has(value.assetId)) seen.add(names.get(value.assetId));
    for (const item of Object.values(value)) walk(item, seen);
  };
  for (const value of list) {
    if (value?.sets) {
      for (const set of value.sets)
        for (const token of set.tokens ?? []) {
          const alias = typeof token.value === "string" ? /^\{([^{}]+)\}$/.exec(token.value) : null;
          if (alias) count(alias[1]);
        }
    } else {
      // A page file or a component file: each Token it uses counts once.
      const seen = new Set();
      walk(value, seen);
      for (const name of seen) count(name);
    }
  }
  return uses;
}
