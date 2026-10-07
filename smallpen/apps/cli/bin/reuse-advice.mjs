import { canonicalJSON, listEffectiveTokens } from "@smallpen/core";

// Only this batch's new definitions are compared. Same-name Tokens in other
// options are intentional theme values, not duplicate-token suggestions.
export function definitionReuseAdvice(before, batch, options) {
  if (
    !batch.operations.some((operation) =>
      ["put-set-token", "put-component-set"].includes(operation.type),
    )
  )
    return [];
  const items = [];
  const tokens = listEffectiveTokens(before, options);
  const components = [before, options.foundation]
    .filter(Boolean)
    .flatMap((snapshot) =>
      [...snapshot.domain.componentSets.values()].map((component) => ({
        ...component,
        packageId: snapshot.manifest.packageId,
      })),
    );
  for (const [operationIndex, operation] of batch.operations.entries()) {
    if (
      operation.type === "put-set-token" &&
      !before.domain.tokens.has(operation.token.id)
    ) {
      const token = operation.token;
      const similar = tokens.filter(
        (item) =>
          item.token.path !== token.name &&
          item.token.type === token.type &&
          canonicalJSON(item.value) === canonicalJSON(token.value),
      );
      if (similar.length)
        items.push({
          code: "existing_token_value",
          operationIndex,
          tokenId: token.id,
          message:
            "An existing Token has this type and value; consider reuse or a semantic alias",
          candidates: similar
            .slice(0, 3)
            .map(({ target, token }) => ({ target, path: token.path })),
        });
    }
    if (
      operation.type === "put-component-set" &&
      !before.domain.componentSets.has(operation.componentSet.id)
    ) {
      const component = operation.componentSet;
      const normalize = (name) => name.toLowerCase().replace(/[\s_-]+/g, "");
      const name = normalize(component.name);
      const similar = components.filter(
        (candidate) =>
          candidate.id !== component.id &&
          (normalize(candidate.name).includes(name) ||
            name.includes(normalize(candidate.name))),
      );
      if (similar.length)
        items.push({
          code: "similar_component",
          operationIndex,
          componentId: component.id,
          message:
            "A similarly named component exists; inspect it before adding another",
          candidates: similar
            .slice(0, 3)
            .map(({ id, name, packageId }) => ({ id, name, packageId })),
        });
    }
  }
  return items;
}
