// Every attribute a Penpot Token applies to, and the Canonical tokenBindings
// field that stands for it. The App applies Tokens by these attributes and
// the CLI binds them by these fields; both read and write the same binding.
// The frontend projection keeps the same table (smallpen/projection.cljs).
// row-gap/column-gap (rowGap, columnGap or both as itemSpacing) and the four
// corners (each, or all four as cornerRadius) are grouped by the adapter.
export const PENPOT_TOKEN_BINDINGS = Object.freeze([
  ["fill", ["fill", "fills.0"]],
  ["stroke-color", ["stroke", "strokes.0"]],
  ["width", ["width"]],
  ["height", ["height"]],
  ["layout-item-min-w", ["minWidth"]],
  ["layout-item-max-w", ["maxWidth"]],
  ["layout-item-min-h", ["minHeight"]],
  ["layout-item-max-h", ["maxHeight"]],
  ["p1", ["paddingTop"]],
  ["p2", ["paddingRight"]],
  ["p3", ["paddingBottom"]],
  ["p4", ["paddingLeft"]],
  ["m1", ["marginTop"]],
  ["m2", ["marginRight"]],
  ["m3", ["marginBottom"]],
  ["m4", ["marginLeft"]],
  ["stroke-width", ["strokeWidth"]],
  ["stroke-width-top", ["strokeWidthTop"]],
  ["stroke-width-right", ["strokeWidthRight"]],
  ["stroke-width-bottom", ["strokeWidthBottom"]],
  ["stroke-width-left", ["strokeWidthLeft"]],
  ["font-family", ["fontFamily"]],
  ["font-size", ["fontSize"]],
  ["font-weight", ["fontWeight"]],
  ["letter-spacing", ["letterSpacing"]],
  ["line-height", ["lineHeight"]],
  ["text-case", ["textTransform"]],
  ["text-decoration", ["textDecoration"]],
  ["typography", ["typography"]],
  ["opacity", ["opacity"]],
  ["rotation", ["rotation"]],
  ["shadow", ["shadow"]],
  ["x", ["x"]],
  ["y", ["y"]],
]);

// Penpot r1..r4: top-left, top-right, bottom-right, bottom-left, the order of
// a Canonical cornerRadius array.
export const CORNER_BINDINGS = Object.freeze([
  ["r1", "radiusTopLeft"],
  ["r2", "radiusTopRight"],
  ["r3", "radiusBottomRight"],
  ["r4", "radiusBottomLeft"],
]);

// The binding fields an applied Token name stands for, for nodes written
// before the adapter stored bindings: {"fill": "color.brand"} binds fill.
export function appliedTokenFields(appliedTokens) {
  const fields = {};
  for (const [attribute, name] of Object.entries(appliedTokens ?? {})) {
    const corner = CORNER_BINDINGS.find(([key]) => key === attribute);
    if (corner) fields[corner[1]] = name;
    else if (attribute === "row-gap") fields.rowGap = name;
    else if (attribute === "column-gap") fields.columnGap = name;
    else {
      const entry = PENPOT_TOKEN_BINDINGS.find(([key]) => key === attribute);
      if (entry) fields[entry[1][0]] = name;
    }
  }
  return fields;
}

// The applied Tokens the App shows for a node: each binding to a Token in
// the package's own library, by the attributes it applies to, plus names an
// older App stored. The Background sends this with every node, so the App
// translates nothing itself. names: Map of Token id to name; packageId: the
// package whose library the App holds.
export function penpotAppliedTokens(node, names, packageId) {
  const bindings = node.tokenBindings ?? {};
  const name = (reference) =>
    reference && reference.packageId === packageId ? names.get(reference.assetId) : undefined;
  const applied = { ...(node.appliedTokens ?? {}) };
  const set = (attribute, reference) => {
    const token = name(reference);
    if (token) applied[attribute] = token;
  };
  // One Token on both gap axes, or per axis; one on four corners, or per corner.
  set("row-gap", bindings.rowGap ?? bindings.itemSpacing);
  set("column-gap", bindings.columnGap ?? bindings.itemSpacing);
  for (const [attribute, field] of CORNER_BINDINGS) set(attribute, bindings[field] ?? bindings.cornerRadius);
  for (const [attribute, fields] of PENPOT_TOKEN_BINDINGS) {
    const field = fields.find((candidate) => bindings[candidate]);
    if (field) set(attribute, bindings[field]);
  }
  return applied;
}

// Token names of a package's own library: its token sets and DTCG files.
export function ownTokenNames(snapshot) {
  const names = new Map();
  for (const entry of snapshot.manifest.entries.tokens ?? []) {
    const value = snapshot.entries[entry];
    for (const set of value?.sets ?? []) for (const token of set.tokens ?? []) names.set(token.id, token.name);
  }
  for (const token of snapshot.domain?.tokens?.values() ?? []) if (!names.has(token.id)) names.set(token.id, token.path);
  return names;
}

// Marks every node of a node map with the applied Tokens the App shows.
export function annotatePenpotAppliedTokens(nodes, snapshot, names = ownTokenNames(snapshot)) {
  const packageId = snapshot.manifest.packageId;
  for (const node of Object.values(nodes ?? {})) {
    const applied = penpotAppliedTokens(node, names, packageId);
    if (Object.keys(applied).length) node.penpotAppliedTokens = applied;
  }
  return nodes;
}
