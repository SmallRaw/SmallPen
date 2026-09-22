import { resolveContext } from "./contexts.mjs";
import { resolveEffectiveToken } from "./effective-tokens.mjs";
import { fail } from "./errors.mjs";

const FIELD_TYPES = new Map([
  ["backgroundBlur", ["other", "number"]],
  ["blur", ["other", "number"]],
  ["cornerRadius", ["border-radius", "dimension", "dimensions", "number"]],
  ["fill", ["color"]],
  ["fontFamily", ["font-family", "string"]],
  ["fontSize", ["dimension", "dimensions", "font-size", "number"]],
  ["fontWeight", ["font-weight", "number"]],
  ["height", ["dimension", "dimensions", "number", "sizing"]],
  ["itemSpacing", ["dimension", "dimensions", "number", "spacing"]],
  ["opacity", ["number", "opacity"]],
  ["paddingBottom", ["dimension", "dimensions", "number", "spacing"]],
  ["paddingLeft", ["dimension", "dimensions", "number", "spacing"]],
  ["paddingRight", ["dimension", "dimensions", "number", "spacing"]],
  ["paddingTop", ["dimension", "dimensions", "number", "spacing"]],
  ["shadow", ["shadow"]],
  ["strokeWidth", ["stroke-width", "dimension", "dimensions", "number"]],
  ["typography", ["typography"]],
  ["width", ["dimension", "dimensions", "number", "sizing"]],
]);

function compatible(field, token) {
  const baseField = field.startsWith("fills.") ? "fill" : field;
  return FIELD_TYPES.get(baseField)?.includes(token.type) === true;
}

function assign(node, field, value) {
  if (field === "fill") {
    node.fills = [{ color: value, type: "solid" }];
    return;
  }
  if (field === "strokeWidth") {
    if (!Array.isArray(node.strokes) || node.strokes.length === 0) {
      fail(
        "missing_token_binding_target",
        `Token binding target is missing: ${field}`,
        { field, nodeId: node.id },
      );
    }
    node.strokes = node.strokes.map((stroke) => ({
      ...stroke,
      width: value,
    }));
    return;
  }
  const fillMatch = /^fills\.(\d+)$/.exec(field);
  if (fillMatch) {
    const index = Number(fillMatch[1]);
    const fills = structuredClone(node.fills ?? []);
    if (!fills[index]) {
      fail("missing_token_binding_target", `Token binding target is missing: ${field}`, {
        field,
        nodeId: node.id,
      });
    }
    fills[index] = { ...fills[index], color: value, type: "solid" };
    node.fills = fills;
    return;
  }
  if (field === "typography") {
    node.textStyle = { ...(node.textStyle ?? {}), ...structuredClone(value) };
    return;
  }
  if (["fontFamily", "fontSize", "fontWeight"].includes(field)) {
    node.textStyle = { ...(node.textStyle ?? {}), [field]: value };
    return;
  }
  node[field] = structuredClone(value);
}

export function applyEffectiveTokenBindings(nodeValue, product, options = {}) {
  const node = structuredClone(nodeValue);
  for (const [field, reference] of Object.entries(node.tokenBindings ?? {})) {
    const effective = resolveEffectiveToken(product, reference, options);
    if (!effective) {
      fail("missing_token", `Token not found: ${reference.assetId}`, {
        field,
        nodeId: node.id,
        path: `${node.id}.tokenBindings.${field}`,
        reference,
      });
    }
    if (!compatible(field, effective.token)) {
      fail(
        "binding_type_mismatch",
        `Token type ${effective.token.type} cannot bind to ${field}`,
        {
          field,
          nodeId: node.id,
          path: `${node.id}.tokenBindings.${field}`,
          tokenId: effective.token.id,
          tokenType: effective.token.type,
        },
      );
    }
    assign(node, field, effective.value);
  }
  return node;
}

export function projectEffectiveSnapshot(product, options = {}) {
  const foundation = options.foundation;
  const libraries = options.libraries ?? [];
  const context = resolveContext(product, foundation, options.context ?? {});
  const entries = structuredClone(product.entries);
  for (const entry of product.manifest.entries.screens) {
    for (const presentation of entries[entry].presentations) {
      for (const [nodeId, node] of Object.entries(presentation.nodes)) {
        presentation.nodes[nodeId] = applyEffectiveTokenBindings(node, product, {
          context,
          foundation,
          libraries,
        });
      }
    }
  }
  for (const entry of product.manifest.entries.components) {
    for (const set of entries[entry].componentSets ?? []) {
      for (const variant of set.variants ?? []) {
        for (const [nodeId, node] of Object.entries(variant.nodes)) {
          variant.nodes[nodeId] = applyEffectiveTokenBindings(node, product, {
            context, foundation, libraries,
          });
        }
      }
    }
  }
  return {
    ...product,
    domain: product.domain,
    entries,
    projection: { context },
  };
}
