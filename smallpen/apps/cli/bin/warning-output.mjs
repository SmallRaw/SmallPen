// Presentation only: the core warning list and mutation semantics stay unchanged.
export function warningOutput(warnings, detail, { confirmUnmatched = false } = {}) {
  const rank = (warning) => warning.match === "exact"
    ? 0
    : warning.suggestions.length > 0 ? 1 : 2;
  const counts = {
    actionableExact: 0,
    unmatchedWithSuggestions: 0,
    unmatchedWithoutSuggestions: 0,
  };
  const countKeys = Object.keys(counts);
  for (const warning of warnings) counts[countKeys[rank(warning)]] += 1;
  // All advice in one batch comes from the same context search index.
  const warningSummary = {
    detail,
    total: warnings.length,
    counts,
    contextScope: warnings[0]?.contextScope,
  };
  if (detail === "full") {
    return {
      warningSummary,
      warnings: confirmUnmatched
        ? warnings.map((warning) =>
            warning.code === "design_token_value_unmatched"
              ? { ...warning, confirmed: true }
              : warning,
          )
        : warnings,
    };
  }

  const groups = new Map();
  for (const [warningIndex, warning] of warnings.entries()) {
    const { nodeId, operationIndex, value, contextScope, ...shared } = warning;
    const key = JSON.stringify(shared);
    let group = groups.get(key);
    if (!group) {
      group = { ...shared, count: 0, locations: [] };
      groups.set(key, group);
    }
    group.count += 1;
    group.locations.push({ warningIndex, operationIndex, nodeId, value });
  }
  const grouped = [...groups.values()].sort(
    (left, right) => rank(left) - rank(right),
  );
  return {
    warningSummary: confirmUnmatched
      ? {
          ...warningSummary,
          unmatchedConfirmed: counts.unmatchedWithSuggestions +
              counts.unmatchedWithoutSuggestions,
        }
      : warningSummary,
    warnings: confirmUnmatched
      ? grouped.map((group) =>
          group.code === "design_token_value_unmatched"
            ? { ...group, confirmed: true }
            : group,
        )
      : grouped,
  };
}
