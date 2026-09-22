import { createSemanticTree, diffSemanticTrees, projectDesignView, resolveDesignView } from "./design-read.mjs";
import { fail } from "./errors.mjs";

const SUPPORTED_FIGMA_NODE_TYPES = new Set([
  "COMPONENT",
  "COMPONENT_SET",
  "FRAME",
  "INSTANCE",
  "RECTANGLE",
  "ROUNDED_RECTANGLE",
  "SYMBOL",
  "TEXT",
]);

const NON_VISUAL_FIGMA_NODE_TYPES = new Set([
  "CANVAS",
  "DOCUMENT",
  "INTERNAL_ONLY_NODE",
  "STYLE",
  "STYLE_SET",
  "VARIABLE",
  "VARIABLE_COLLECTION",
  "VARIABLE_SET",
]);

const MERGEABLE_FIELDS = new Set([
  "cornerRadius",
  "fills",
  "flipX",
  "flipY",
  "height",
  "name",
  "opacity",
  "rotation",
  "strokes",
  "text",
  "textBlocks",
  "textStyle",
  "visible",
  "width",
  "x",
  "y",
]);

const REQUIRED_MERGE_FIELDS = new Set(["height", "name", "text", "width", "x", "y"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stablePart(value) {
  return String(value ?? "unknown")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/^_+|_+$/g, "") || "unknown";
}

function jsonSafe(value, seen = new WeakSet()) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return {
      byteLength: value.byteLength,
      omitted: true,
      type: value.constructor.name,
    };
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const result = value.map((item) => jsonSafe(item, seen));
    seen.delete(value);
    return result;
  }
  if (isRecord(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (!["function", "symbol", "undefined"].includes(typeof item)) {
        result[key] = jsonSafe(item, seen);
      }
    }
    seen.delete(value);
    return result;
  }
  return String(value);
}

function guid(value) {
  if (!isRecord(value)) return undefined;
  if (!Number.isFinite(value.sessionID) || !Number.isFinite(value.localID)) return undefined;
  return `${value.sessionID}:${value.localID}`;
}

function nodeId(value) {
  return `node_figma_${stablePart(value).replaceAll(":", "_")}`;
}

function componentSetId(value) {
  return `cmp_figma_${stablePart(value).replaceAll(":", "_")}`;
}

function variantId(value) {
  return `var_figma_${stablePart(value).replaceAll(":", "_")}`;
}

function axisId(value) {
  return `axis_figma_${stablePart(value).replaceAll(":", "_").toLowerCase()}`;
}

function colorChannel(value) {
  const bounded = Math.max(0, Math.min(1, Number(value) || 0));
  return Math.round(bounded * 255).toString(16).padStart(2, "0");
}

function colorHex(value) {
  return `#${colorChannel(value?.r)}${colorChannel(value?.g)}${colorChannel(value?.b)}`;
}

function finite(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizedRotation(value) {
  const normalized = value % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function transform(node) {
  const width = finite(node.size?.x, 100);
  const height = finite(node.size?.y, 100);
  const matrix = node.transform;
  if (!isRecord(matrix)) {
    return { flipX: false, flipY: false, height, rotation: 0, width, x: 0, y: 0 };
  }
  const m00 = finite(matrix.m00, 1);
  const m01 = finite(matrix.m01, 0);
  const m02 = finite(matrix.m02, 0);
  const m10 = finite(matrix.m10, 0);
  const m11 = finite(matrix.m11, 1);
  const m12 = finite(matrix.m12, 0);
  const flipX = m00 * m11 - m01 * m10 < 0;
  const rotation = normalizedRotation(
    Math.atan2(m10, flipX ? m11 : m00) * (180 / Math.PI),
  );
  const radians = rotation * (Math.PI / 180);
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const centerX = width / 2;
  const centerY = height / 2;
  const linear00 = flipX ? -cosine : cosine;
  const linear01 = flipX ? sine : -sine;
  return {
    flipX,
    flipY: false,
    height,
    rotation,
    width,
    x: m02 - centerX + linear00 * centerX + linear01 * centerY,
    y: m12 - centerY + sine * centerX + cosine * centerY,
  };
}

function componentPropertyValue(value) {
  if (!isRecord(value)) return undefined;
  if (typeof value.boolValue === "boolean") return String(value.boolValue);
  if (typeof value.textValue === "string") return value.textValue;
  if (typeof value.textValue?.characters === "string") return value.textValue.characters;
  const reference = guid(value.guidValue);
  return reference;
}

function variantNameValues(name) {
  if (typeof name !== "string" || !name.includes("=")) return {};
  return Object.fromEntries(
    name.split(",").flatMap((part) => {
      const separator = part.indexOf("=");
      if (separator < 1) return [];
      return [[part.slice(0, separator).trim(), part.slice(separator + 1).trim()]];
    }),
  );
}

function variantValues(node, definitions) {
  const byDefinition = new Map(
    definitions.map((definition) => [guid(definition.id), definition]),
  );
  const fromSpecs = {};
  for (const spec of node.variantPropSpecs ?? []) {
    const definition = byDefinition.get(guid(spec.propDefId));
    if (definition && typeof spec.value === "string") {
      fromSpecs[definition.name] = spec.value;
    }
  }
  return Object.keys(fromSpecs).length > 0 ? fromSpecs : variantNameValues(node.name);
}

function textStyle(node) {
  const result = {
    fontFamily: node.fontName?.family ?? "Inter",
    fontSize: finite(node.fontSize, 14),
    fontStyle: String(node.fontName?.style ?? "").toLowerCase().includes("italic")
      ? "italic"
      : "normal",
    fontWeight: /bold/i.test(node.fontName?.style ?? "") ? 700 : 400,
    letterSpacing: finite(node.letterSpacing?.value, 0),
    lineHeight: finite(node.lineHeight?.value, finite(node.fontSize, 14) * 1.2),
    textAlign: String(node.textAlignHorizontal ?? "LEFT").toLowerCase(),
    textDecoration: "none",
    textDirection: "ltr",
    textTransform: "none",
    verticalAlign: String(node.textAlignVertical ?? "TOP").toLowerCase(),
  };
  if (!new Set(["center", "justify", "left", "right"]).has(result.textAlign)) {
    result.textAlign = "left";
  }
  if (!new Set(["bottom", "center", "top"]).has(result.verticalAlign)) {
    result.verticalAlign = "top";
  }
  return result;
}

function figmaMetadata(node) {
  return {
    ...(Array.isArray(node.componentPropAssignments)
      ? { componentPropAssignments: jsonSafe(node.componentPropAssignments) }
      : {}),
    ...(Array.isArray(node.componentPropDefs)
      ? { componentPropDefs: jsonSafe(node.componentPropDefs) }
      : {}),
    guid: guid(node.guid),
    sourceType: node.type,
    ...(Array.isArray(node.variantPropSpecs)
      ? { variantPropSpecs: jsonSafe(node.variantPropSpecs) }
      : {}),
  };
}

function supportedFills(node, losses, stableNodeId) {
  const fills = [];
  for (const paint of node.fillPaints ?? []) {
    if (paint.visible === false) continue;
    if (paint.type === "SOLID") {
      fills.push({
        color: colorHex(paint.color),
        ...(typeof paint.opacity === "number" ? { opacity: paint.opacity } : {}),
        type: "solid",
      });
    } else {
      losses.push({
        code: "figma_fill_unsupported",
        message: `Figma ${String(paint.type)} fill remains in read-only source metadata`,
        nodeId: stableNodeId,
        severity: "warning",
      });
    }
  }
  return fills;
}

function mappedNodeType(node) {
  if (node.type === "SYMBOL") return "COMPONENT";
  if (node.type === "ROUNDED_RECTANGLE") return "RECTANGLE";
  if (SUPPORTED_FIGMA_NODE_TYPES.has(node.type)) return node.type;
  return "FRAME";
}

function primitiveOverrides(node, idByGuid, losses, stableNodeId) {
  const result = {};
  for (const override of node.symbolData?.symbolOverrides ?? []) {
    const overrideGuid = guid(override.guid ?? override.overrideGUID ?? override.targetGUID);
    const target = overrideGuid ? idByGuid.get(overrideGuid) ?? nodeId(overrideGuid) : stableNodeId;
    let value;
    if (typeof override.value === "boolean" || typeof override.value === "number" || typeof override.value === "string") {
      value = override.value;
    } else if (typeof override.text === "string") {
      value = override.text;
    } else if (typeof override.textData?.characters === "string") {
      value = override.textData.characters;
    } else if (typeof override.visible === "boolean") {
      value = override.visible;
    }
    if (value !== undefined) {
      result[`${target}:${override.field ?? override.type ?? "value"}`] = value;
    } else {
      losses.push({
        code: "instance_override_unsupported",
        message: "A Figma instance override remains only in read-only source metadata",
        nodeId: stableNodeId,
        severity: "warning",
      });
    }
  }
  return result;
}

function createConverter(nodeChanges, packageId, losses, componentByNodeGuid) {
  const byGuid = new Map();
  const childrenByGuid = new Map();
  const idByGuid = new Map();
  for (const node of nodeChanges) {
    const identity = guid(node.guid);
    if (!identity) continue;
    byGuid.set(identity, node);
    idByGuid.set(identity, nodeId(identity));
    const parent = guid(node.parentIndex?.guid);
    if (parent) {
      const children = childrenByGuid.get(parent) ?? [];
      children.push(identity);
      childrenByGuid.set(parent, children);
    }
  }

  function convert(identity, scope = new Set()) {
    const source = byGuid.get(identity);
    if (!source) fail("missing_figma_node", `Figma node is missing: ${identity}`);
    const stableNodeId = idByGuid.get(identity);
    const type = mappedNodeType(source);
    if (!SUPPORTED_FIGMA_NODE_TYPES.has(source.type)) {
      losses.push({
        code: "node_type_flattened",
        message: `Converted unsupported Figma node type ${String(source.type)} to FRAME`,
        nodeId: stableNodeId,
        severity: "warning",
      });
    }
    const node = {
      children: (childrenByGuid.get(identity) ?? [])
        .filter((child) => !scope.has(child))
        .filter((child) => !NON_VISUAL_FIGMA_NODE_TYPES.has(byGuid.get(child)?.type))
        .map((child) => idByGuid.get(child)),
      fills: supportedFills(source, losses, stableNodeId),
      id: stableNodeId,
      name: typeof source.name === "string" ? source.name : String(source.type ?? "Figma Node"),
      opacity: Math.max(0, Math.min(1, finite(source.opacity, 1))),
      sourceMetadata: { figma: figmaMetadata(source) },
      type,
      visible: source.visible !== false,
      ...transform(source),
    };
    if (typeof source.cornerRadius === "number" && source.cornerRadius >= 0) {
      node.cornerRadius = source.cornerRadius;
    }
    if (source.type === "TEXT") {
      node.text = source.textData?.characters ?? "";
      node.textStyle = textStyle(source);
    }
    if ((source.strokePaints?.length ?? 0) > 0 || (source.effects?.length ?? 0) > 0) {
      losses.push({
        code: "visual_style_partial",
        message: "Figma strokes/effects remain in read-only source metadata",
        nodeId: stableNodeId,
        severity: "warning",
      });
    }
    if (source.stackMode === "HORIZONTAL" || source.stackMode === "VERTICAL") {
      node.layoutMode = source.stackMode;
      node.itemSpacing = finite(source.stackSpacing, 0);
      const basePadding = finite(source.stackPadding, 0);
      node.paddingTop = finite(source.stackVerticalPadding, basePadding);
      node.paddingBottom = finite(source.stackPaddingBottom, basePadding);
      node.paddingLeft = finite(source.stackHorizontalPadding, basePadding);
      node.paddingRight = finite(source.stackPaddingRight, basePadding);
    }
    if (source.type === "INSTANCE") {
      const sourceComponent = guid(source.symbolData?.symbolID);
      const component = sourceComponent ? componentByNodeGuid.get(sourceComponent) : undefined;
      if (component) {
        const overrides = primitiveOverrides(source, idByGuid, losses, stableNodeId);
        node.instance = {
          component: { assetId: component.componentSetId, packageId },
          ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
          variant: structuredClone(component.selection),
        };
      } else {
        node.type = "FRAME";
        losses.push({
          code: "orphaned_instance",
          message: "Figma instance source was not present; the Draft keeps it as a FRAME",
          nodeId: stableNodeId,
          severity: "warning",
        });
      }
    }
    return node;
  }

  function tree(rootIdentity) {
    const nodes = {};
    const visit = (identity) => {
      const converted = convert(identity);
      nodes[converted.id] = converted;
      for (const child of childrenByGuid.get(identity) ?? []) {
        if (!NON_VISUAL_FIGMA_NODE_TYPES.has(byGuid.get(child)?.type)) visit(child);
      }
    };
    visit(rootIdentity);
    return nodes;
  }

  return { byGuid, childrenByGuid, convert, idByGuid, tree };
}

function createComponents(nodeChanges, packageId, losses) {
  const preliminary = createConverter(nodeChanges, packageId, losses, new Map());
  const sets = [];
  const componentByNodeGuid = new Map();
  for (const [identity, sourceSet] of preliminary.byGuid) {
    const isSet =
      sourceSet.type === "COMPONENT_SET" ||
      sourceSet.componentPropDefs?.some(({ type }) => type === "VARIANT");
    if (!isSet) continue;
    const componentIdentities = (preliminary.childrenByGuid.get(identity) ?? []).filter((child) =>
      new Set(["COMPONENT", "SYMBOL"]).has(preliminary.byGuid.get(child)?.type),
    );
    if (componentIdentities.length === 0) continue;
    const definitions = (sourceSet.componentPropDefs ?? []).filter(({ type }) => type === "VARIANT");
    const domains = new Map(definitions.map((definition) => [definition.name, new Set(definition.preferredValues?.stringValues ?? [])]));
    const valuesByComponent = new Map();
    for (const componentIdentity of componentIdentities) {
      const values = variantValues(preliminary.byGuid.get(componentIdentity), definitions);
      valuesByComponent.set(componentIdentity, values);
      for (const [name, value] of Object.entries(values)) {
        const domain = domains.get(name) ?? new Set();
        domain.add(value);
        domains.set(name, domain);
      }
    }
    const axes = definitions.map((definition) => {
      const domain = [...(domains.get(definition.name) ?? [])].sort();
      return {
        ...(domain.length > 0 ? { domain } : {}),
        id: axisId(guid(definition.id) ?? definition.name),
        name: definition.name,
        role: /state|status|interaction/i.test(definition.name) ? "state" : "configuration",
      };
    });
    for (const axis of axes) {
      if (axis.role === "state" && !axis.domain?.length) {
        axis.domain = ["default"];
        losses.push({
          code: "variant_axis_domain_inferred",
          message: `State Axis ${axis.name} had no explicit Figma domain; default was inferred`,
          nodeId: preliminary.idByGuid.get(identity),
          severity: "warning",
        });
      }
    }
    const setId = componentSetId(identity);
    const variants = [];
    for (const componentIdentity of componentIdentities) {
      const source = preliminary.byGuid.get(componentIdentity);
      const values = valuesByComponent.get(componentIdentity);
      const selection = Object.fromEntries(
        axes.map((axis) => [
          axis.id,
          values[axis.name] ?? axis.domain?.[0] ?? componentPropertyValue(
            definitions.find(({ name }) => name === axis.name)?.initialValue,
          ) ?? "default",
        ]),
      );
      componentByNodeGuid.set(componentIdentity, { componentSetId: setId, selection });
      variants.push({
        id: variantId(componentIdentity),
        nodes: {},
        rootId: nodeId(componentIdentity),
        selection,
        source,
      });
    }
    sets.push({ axes, id: setId, name: sourceSet.name ?? "Figma Component Set", variants, visibility: "public" });
  }
  const converter = createConverter(nodeChanges, packageId, losses, componentByNodeGuid);
  for (const set of sets) {
    for (const variant of set.variants) {
      const identity = guid(variant.source.guid);
      variant.nodes = converter.tree(identity);
      delete variant.source;
    }
  }
  return { componentByNodeGuid, converter, sets };
}

export function createFigmaDraftValues({ importedAt, inputHash, meta, nodeChanges, packageId }) {
  if (!Array.isArray(nodeChanges) || nodeChanges.length === 0) {
    fail("empty_figma_clipboard", "Figma structured clipboard contains no nodes");
  }
  const losses = [];
  const { converter, sets } = createComponents(nodeChanges, packageId, losses);
  const componentSetGuids = new Set(
    [...converter.byGuid].filter(([, node]) =>
      node.type === "COMPONENT_SET" || node.componentPropDefs?.some(({ type }) => type === "VARIANT"),
    ).map(([identity]) => identity),
  );
  const topLevel = [...converter.byGuid].flatMap(([identity, node]) => {
    if (NON_VISUAL_FIGMA_NODE_TYPES.has(node.type) || componentSetGuids.has(identity)) return [];
    const parent = guid(node.parentIndex?.guid);
    if (parent && converter.byGuid.has(parent) && !NON_VISUAL_FIGMA_NODE_TYPES.has(converter.byGuid.get(parent)?.type)) return [];
    return [identity];
  });
  if (topLevel.length === 0) {
    fail("empty_figma_clipboard", "Figma clipboard has no visual top-level nodes");
  }
  const nodes = {};
  const visit = (identity) => {
    if (componentSetGuids.has(identity)) return;
    const converted = converter.convert(identity, componentSetGuids);
    converted.children = converted.children.filter((childId) =>
      ![...componentSetGuids].some((candidate) => converter.idByGuid.get(candidate) === childId),
    );
    nodes[converted.id] = converted;
    for (const child of converter.childrenByGuid.get(identity) ?? []) visit(child);
  };
  for (const identity of topLevel) visit(identity);
  const rootId = "node_import_root";
  const bounds = topLevel.map((identity) => nodes[converter.idByGuid.get(identity)]);
  const maximumX = Math.max(1, ...bounds.map((node) => node.x + node.width));
  const maximumY = Math.max(1, ...bounds.map((node) => node.y + node.height));
  const minimumX = Math.min(0, ...bounds.map((node) => node.x));
  const minimumY = Math.min(0, ...bounds.map((node) => node.y));
  nodes[rootId] = {
    children: topLevel.map((identity) => converter.idByGuid.get(identity)),
    height: maximumY - minimumY,
    id: rootId,
    name: "Figma Import",
    type: "FRAME",
    width: maximumX - minimumX,
    x: minimumX,
    y: minimumY,
  };
  const provenance = {
    dataType: typeof meta?.dataType === "string" ? meta.dataType : "NODE_CHANGES",
    importedAt,
    inputHash,
    ...(typeof meta?.fileKey === "string" ? { sourceFileId: meta.fileKey } : {}),
    ...(Number.isSafeInteger(meta?.pasteID) ? { sourcePasteId: meta.pasteID } : {}),
    sourceKind: "figma-structured",
  };
  const entries = {
    assets: [],
    components: sets.length > 0 ? ["components/imported.json"] : [],
    contexts: [],
    requirements: [],
    scenarios: [],
    screens: ["screens/imported.json"],
    tokens: [],
  };
  const values = new Map([
    [
      "manifest.json",
      {
        defaultScreenId: "scr_figma_import",
        draft: { losses, provenance },
        entries,
        formatVersion: 1,
        name: "Imported Figma Draft",
        packageId,
        role: "foundation",
      },
    ],
    [
      "screens/imported.json",
      {
        basePresentationId: "pres_figma_import",
        counterparts: [],
        id: "scr_figma_import",
        name: "Figma Import",
        presentations: [
          {
            id: "pres_figma_import",
            interactions: [],
            name: "Imported",
            nodes,
            rootId,
            viewport: { height: maximumY - minimumY, width: maximumX - minimumX },
          },
        ],
      },
    ],
  ]);
  if (sets.length > 0) values.set("components/imported.json", { componentSets: sets });
  return { losses, provenance, values };
}

export function createFlatDraftValues({ bytes, height, importedAt, inputHash, mimeType, packageId, sourceKind, width }) {
  const mediaId = `media_draft_${inputHash.slice(0, 24)}`;
  const blob = `blobs/${inputHash}`;
  const provenance = { importedAt, inputHash, sourceKind };
  const losses = [
    {
      code: "flat_media_only",
      message: `${sourceKind.toUpperCase()} fallback preserves pixels but has no editable design structure`,
      severity: "warning",
    },
  ];
  return {
    losses,
    provenance,
    values: new Map([
      [
        "manifest.json",
        {
          defaultScreenId: "scr_flat_import",
          draft: { losses, provenance },
          entries: {
            assets: ["assets/imported.json"],
            components: [],
            contexts: [],
            requirements: [],
            scenarios: [],
            screens: ["screens/imported.json"],
            tokens: [],
          },
          formatVersion: 1,
          name: `${sourceKind.toUpperCase()} Fallback Draft`,
          packageId,
          role: "foundation",
        },
      ],
      [
        "assets/imported.json",
        {
          colors: [],
          fonts: [],
          id: "alib_draft_import",
          media: [
            {
              blob,
              byteLength: bytes.byteLength,
              height,
              id: mediaId,
              mimeType,
              name: `${sourceKind.toUpperCase()} Import`,
              path: "Draft imports",
              sha256: inputHash,
              width,
            },
          ],
          typographies: [],
        },
      ],
      [
        "screens/imported.json",
        {
          basePresentationId: "pres_flat_import",
          counterparts: [],
          id: "scr_flat_import",
          name: `${sourceKind.toUpperCase()} Import`,
          presentations: [
            {
              id: "pres_flat_import",
              interactions: [],
              name: "Imported",
              nodes: {
                node_flat_import: {
                  children: [],
                  height,
                  id: "node_flat_import",
                  mediaRef: mediaId,
                  name: `${sourceKind.toUpperCase()} Import`,
                  type: "IMAGE",
                  width,
                  x: 0,
                  y: 0,
                },
              },
              rootId: "node_flat_import",
              viewport: { height, width },
            },
          ],
        },
      ],
      [blob, bytes],
    ]),
  };
}

export function draftFromSnapshot(snapshot) {
  if (!isRecord(snapshot?.manifest?.draft)) {
    fail("not_a_draft", "SmallPen Package is not an imported Draft");
  }
  return {
    losses: structuredClone(snapshot.manifest.draft.losses),
    provenance: structuredClone(snapshot.manifest.draft.provenance),
    snapshot,
  };
}

function lossDiff(before, after) {
  const key = (loss) => `${loss.code}:${loss.nodeId ?? ""}`;
  const beforeByKey = new Map(before.losses.map((loss) => [key(loss), loss]));
  const afterByKey = new Map(after.losses.map((loss) => [key(loss), loss]));
  const result = [];
  for (const path of [...new Set([...beforeByKey.keys(), ...afterByKey.keys()])].sort()) {
    const previous = beforeByKey.get(path);
    const next = afterByKey.get(path);
    if (!previous && next) result.push({ after: structuredClone(next), kind: "added", path });
    else if (previous && !next) result.push({ before: structuredClone(previous), kind: "removed", path });
    else if (JSON.stringify(previous) !== JSON.stringify(next)) {
      result.push({ after: structuredClone(next), before: structuredClone(previous), kind: "changed", path });
    }
  }
  return result;
}

function draftSemanticTree(draft) {
  const resolved = resolveDesignView(draft.snapshot, {});
  const projection = projectDesignView(draft.snapshot, resolved);
  return createSemanticTree(draft.snapshot, projection, {
    scenarioId: resolved.scenarioId,
    selection: resolved.selection,
  });
}

export function diffDrafts(beforeValue, afterValue) {
  const before = beforeValue.snapshot ? beforeValue : draftFromSnapshot(beforeValue);
  const after = afterValue.snapshot ? afterValue : draftFromSnapshot(afterValue);
  return {
    losses: lossDiff(before, after),
    semantic: diffSemanticTrees(
      draftSemanticTree(before),
      draftSemanticTree(after),
    ),
  };
}

function presentation(snapshot, selection) {
  const screenEntry = snapshot.manifest.entries.screens.find(
    (entry) => snapshot.entries[entry].id === selection.screenId,
  );
  const screen = screenEntry ? snapshot.entries[screenEntry] : undefined;
  const presentationId = selection.presentationId ?? screen?.basePresentationId;
  return screen?.presentations.find(({ id }) => id === presentationId);
}

export function compileDraftMerge(canonical, draftValue, selections, options = {}) {
  const draft = draftValue.snapshot ? draftValue : draftFromSnapshot(draftValue);
  if (!Array.isArray(selections) || selections.length === 0) {
    fail("missing_draft_selections", "Draft compile requires at least one explicit selection");
  }
  const operations = selections.map((selection, selectionIndex) => {
    if (!isRecord(selection) || !Array.isArray(selection.fields) || selection.fields.length === 0) {
      fail("invalid_draft_selection", `Draft selection ${selectionIndex} is invalid`);
    }
    if (new Set(selection.fields).size !== selection.fields.length) {
      fail("invalid_draft_selection", `Draft selection ${selectionIndex} contains duplicate fields`);
    }
    const canonicalPresentation = presentation(canonical, selection);
    const draftPresentation = presentation(draft.snapshot, selection);
    const canonicalNode = canonicalPresentation?.nodes[selection.nodeId];
    const draftNode = draftPresentation?.nodes[selection.nodeId];
    if (!canonicalNode || !draftNode) {
      fail(
        "missing_draft_merge_node",
        "Draft selection must reference matching owned Canonical and Draft nodes",
        { nodeId: selection.nodeId, screenId: selection.screenId },
      );
    }
    const changes = {};
    for (const field of selection.fields) {
      if (!MERGEABLE_FIELDS.has(field)) {
        fail("unsupported_draft_merge_field", `Draft merge cannot change field: ${field}`, { field });
      }
      const value = draftNode[field];
      if (value === undefined && REQUIRED_MERGE_FIELDS.has(field)) {
        fail("missing_draft_merge_value", `Draft field is missing: ${selection.nodeId}.${field}`);
      }
      changes[field] = value === undefined ? null : structuredClone(value);
    }
    return {
      changes,
      nodeId: selection.nodeId,
      presentationId: canonicalPresentation.id,
      screenId: selection.screenId,
      type: "update-presentation-node",
    };
  });
  return {
    baseRevision: canonical.revision,
    batchId: options.batchId ?? `draft_${globalThis.crypto.randomUUID()}`,
    operations,
  };
}
