import assert from "node:assert/strict";
import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  listPackageEntries,
  loadPackageFromValues,
  prepareOperationBatch,
} from "@smallpen/core";
import { applyOperationBatch, openPackage } from "@smallpen/local-package";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "roundtrip.smallpen");

async function fixtureValues() {
  const manifest = JSON.parse(
    await readFile(join(fixture, "manifest.json"), "utf8"),
  );
  const { entries } = listPackageEntries(manifest);
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of entries) {
    values.set(
      entry,
      JSON.parse(await readFile(join(fixture, entry), "utf8")),
    );
  }
  return values;
}

function contextFile() {
  return {
    axes: [
      {
        defaultValue: "light",
        id: "axis_theme",
        kind: "theme",
        name: "Theme",
        values: [
          { id: "light", name: "Light" },
          { id: "dark", name: "Dark" },
        ],
      },
    ],
    profiles: [
      {
        default: true,
        id: "ctx_light",
        name: "Light",
        values: { axis_theme: "light" },
      },
    ],
  };
}

function tokenDefinition(id = "tok_brand") {
  return {
    $extensions: { smallpen: { id, visibility: "public" } },
    $type: "color",
    $value: "#6750a4",
  };
}

function componentSet() {
  return {
    axes: [
      {
        domain: ["idle", "pressed"],
        id: "axis_state",
        name: "State",
        role: "state",
      },
    ],
    id: "cmp_button",
    name: "Button",
    variants: [
      {
        id: "var_button_idle",
        nodes: {
          node_button_source: {
            children: [],
            height: 40,
            id: "node_button_source",
            name: "Button",
            tokenBindings: {
              fill: { assetId: "tok_brand", packageId: "pkg_roundtrip" },
            },
            type: "COMPONENT",
            width: 120,
            x: 0,
            y: 0,
          },
        },
        rootId: "node_button_source",
        selection: { axis_state: "idle" },
      },
    ],
    visibility: "public",
  };
}

function scenario() {
  return {
    actions: [],
    context: { axis_theme: "light" },
    expectedVisibleNodeIds: ["node_button_source"],
    fixture: {},
    id: "scn_button_idle",
    name: "Button / Idle",
    target: {
      component: { assetId: "cmp_button", packageId: "pkg_roundtrip" },
      kind: "component",
      variant: { axis_state: "idle" },
    },
    viewport: { height: 120, scale: 1, width: 240 },
  };
}

function requirementFile() {
  return {
    annotations: [],
    flows: [
      {
        id: "flow_activate",
        interactionIds: ["int_activate"],
        name: "Activate",
      },
    ],
    requirements: [
      {
        id: "req_activate",
        links: [{ interactionId: "int_activate", kind: "interaction" }],
        markdown: "The user must be able to activate.",
        title: "Activate",
      },
    ],
  };
}

function interaction() {
  return {
    action: {
      nodeId: "node_rectangle",
      type: "set-visibility",
      visible: false,
    },
    id: "int_activate",
    intentId: "intent_activate",
    name: "Activate",
    sourceNodeId: "node_rectangle",
    trigger: "activate",
  };
}

function domainBatch(baseRevision) {
  return {
    baseRevision,
    batchId: "batch_domain_create",
    operations: [
      {
        contextFile: contextFile(),
        entry: "contexts/design.json",
        type: "put-context-file",
      },
      {
        definition: tokenDefinition(),
        filePath: "tokens/design.json",
        path: "color.brand",
        tokenId: "tok_brand",
        type: "put-token",
      },
      { componentSet: componentSet(), type: "put-component-set" },
      { scenario: scenario(), type: "put-scenario" },
      { requirementFile: requirementFile(), type: "put-requirement-file" },
      {
        changes: { name: "Updated by domain Operation" },
        nodeId: "node_rectangle",
        screenId: "scr_roundtrip",
        type: "update-node",
      },
      {
        binding: { assetId: "tok_brand", packageId: "pkg_roundtrip" },
        field: "fill",
        nodeId: "node_rectangle",
        screenId: "scr_roundtrip",
        type: "set-token-binding",
      },
      {
        interaction: interaction(),
        presentationId: "pres_desktop",
        screenId: "scr_roundtrip",
        type: "put-interaction",
      },
    ],
  };
}

test("one typed domain batch creates every new entry and its inverse restores the exact revision", async () => {
  const before = await loadPackageFromValues(
    "memory://domain-operations.smallpen",
    await fixtureValues(),
  );
  const prepared = await prepareOperationBatch(before, domainBatch(before.revision));
  assert.equal(prepared.snapshot.domain.contextAxes.has("axis_theme"), true);
  assert.equal(prepared.snapshot.domain.tokens.has("tok_brand"), true);
  assert.equal(prepared.snapshot.domain.componentSets.has("cmp_button"), true);
  assert.equal(prepared.snapshot.domain.scenarios.has("scn_button_idle"), true);
  assert.equal(prepared.snapshot.domain.requirements.has("req_activate"), true);
  const node =
    prepared.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_rectangle;
  assert.equal(node.name, "Updated by domain Operation");
  assert.deepEqual(node.tokenBindings.fill, {
    assetId: "tok_brand",
    packageId: "pkg_roundtrip",
  });
  assert.deepEqual(prepared.result.changedFiles, [
    "components/components.json",
    "contexts/design.json",
    "manifest.json",
    "requirements/requirements.json",
    "scenarios/scenarios.json",
    "screens/roundtrip.json",
    "tokens/design.json",
  ]);
  assert.ok(
    prepared.result.inverseBatch.operations.some(
      ({ type }) => type === "restore-canonical-entry",
    ),
  );

  const undone = await prepareOperationBatch(
    prepared.snapshot,
    prepared.result.inverseBatch,
  );
  assert.equal(undone.result.revision, before.revision);
  assert.deepEqual(undone.snapshot.manifest, before.manifest);
  assert.deepEqual(undone.snapshot.entries, before.entries);
});

test("Token, Component Variant, instance selection, and Repair Operations are reversible", async () => {
  const base = await loadPackageFromValues(
    "memory://domain-operations.smallpen",
    await fixtureValues(),
  );
  const created = await prepareOperationBatch(base, domainBatch(base.revision));
  const variant = {
    id: "var_button_pressed",
    nodes: {
      node_button_pressed: {
        children: [],
        height: 40,
        id: "node_button_pressed",
        name: "Pressed",
        type: "COMPONENT",
        width: 120,
        x: 0,
        y: 0,
      },
    },
    rootId: "node_button_pressed",
    selection: { axis_state: "pressed" },
  };
  const changed = await prepareOperationBatch(created.snapshot, {
    baseRevision: created.snapshot.revision,
    batchId: "batch_domain_change",
    operations: [
      { path: "color.brand", type: "set-token-value", value: "#123456" },
      { deprecated: true, tokenId: "tok_brand", type: "deprecate-token" },
      {
        definition: tokenDefinition("tok_accent"),
        filePath: "tokens/design.json",
        path: "color.accent",
        tokenId: "tok_accent",
        type: "put-token",
      },
      { componentSetId: "cmp_button", type: "put-variant", variant },
      {
        changes: { name: "Pressed Button" },
        componentSetId: "cmp_button",
        nodeId: "node_button_pressed",
        type: "update-component-node",
        variantId: "var_button_pressed",
      },
      {
        node: {
          children: [],
          height: 40,
          id: "node_domain_instance",
          instance: {
            component: { assetId: "cmp_button", packageId: "pkg_roundtrip" },
            variant: { axis_state: "idle" },
          },
          name: "Domain Instance",
          type: "INSTANCE",
          width: 120,
          x: 320,
          y: 96,
        },
        parentId: "node_canvas",
        presentationId: "pres_desktop",
        screenId: "scr_roundtrip",
        type: "add-presentation-node",
      },
      {
        nodeId: "node_domain_instance",
        screenId: "scr_roundtrip",
        selection: { axis_state: "pressed" },
        type: "select-instance-variant",
      },
      {
        action: "retarget-reference",
        referencePath:
          "screens/roundtrip.json.presentations[0].nodes.node_rectangle.tokenBindings.fill",
        replacement: {
          assetId: "tok_accent",
          packageId: "pkg_roundtrip",
        },
        type: "repair-reference",
      },
    ],
  });
  assert.equal(
    changed.snapshot.domain.tokens.get("tok_brand").resolvedValue,
    "#123456",
  );
  assert.equal(changed.snapshot.domain.tokens.get("tok_brand").deprecated, true);
  assert.equal(changed.snapshot.domain.tokens.has("tok_accent"), true);
  assert.equal(
    changed.snapshot.domain.componentSets.get("cmp_button").variants.length,
    2,
  );
  assert.deepEqual(
    changed.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_domain_instance.instance.variant,
    { axis_state: "pressed" },
  );
  assert.equal(
    changed.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_rectangle.tokenBindings.fill.assetId,
    "tok_accent",
  );
  const undone = await prepareOperationBatch(
    changed.snapshot,
    changed.result.inverseBatch,
  );
  assert.equal(undone.result.revision, created.snapshot.revision);
});

test("invalid domain batches leave the source Snapshot and filesystem unchanged", async () => {
  const before = await loadPackageFromValues(
    "memory://domain-operations.smallpen",
    await fixtureValues(),
  );
  const created = await prepareOperationBatch(before, domainBatch(before.revision));
  const beforeEntries = structuredClone(created.snapshot.entries);
  await assert.rejects(
    prepareOperationBatch(created.snapshot, {
      baseRevision: created.snapshot.revision,
      batchId: "batch_remove_referenced_token",
      operations: [{ tokenId: "tok_brand", type: "remove-token" }],
    }),
    (error) => error?.code === "missing_local_asset",
  );
  assert.deepEqual(created.snapshot.entries, beforeEntries);

  const parent = await mkdtemp(join(tmpdir(), "smallpen-domain-atomic-"));
  const packagePath = join(parent, "domain.smallpen");
  await cp(fixture, packagePath, { recursive: true });
  const opened = await openPackage(packagePath);
  await assert.rejects(
    applyOperationBatch(packagePath, {
      baseRevision: opened.revision,
      batchId: "batch_invalid_disk_domain",
      operations: [
        {
          scenario: { ...scenario(), id: "invalid" },
          type: "put-scenario",
        },
      ],
    }),
    (error) => error?.code === "invalid_scenario_id",
  );
  assert.equal((await openPackage(packagePath)).revision, opened.revision);
});

test("the filesystem adapter commits a multi-entry domain batch atomically and undoes it", async () => {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-domain-write-"));
  const packagePath = join(parent, "domain.smallpen");
  await cp(fixture, packagePath, { recursive: true });
  const before = await openPackage(packagePath);
  const applied = await applyOperationBatch(
    packagePath,
    domainBatch(before.revision),
  );
  const changed = await openPackage(packagePath);
  assert.equal(changed.domain.tokens.has("tok_brand"), true);
  assert.equal(changed.domain.componentSets.has("cmp_button"), true);
  assert.equal(changed.domain.requirements.has("req_activate"), true);
  assert.equal(changed.revision, applied.revision);
  const undone = await applyOperationBatch(packagePath, applied.inverseBatch);
  assert.equal(undone.revision, before.revision);
  const restored = await openPackage(packagePath);
  assert.deepEqual(restored.manifest, before.manifest);
  assert.deepEqual(restored.entries, before.entries);
});

test("Screen lifecycle and default selection use typed reversible Operations", async () => {
  const before = await loadPackageFromValues(
    "memory://domain-screens.smallpen",
    await fixtureValues(),
  );
  const secondScreen = {
    basePresentationId: "pres_second",
    counterparts: [],
    id: "scr_second",
    name: "Second",
    presentations: [
      {
        id: "pres_second",
        interactions: [],
        name: "Second",
        nodes: {
          node_second_root: {
            children: [],
            height: 200,
            id: "node_second_root",
            name: "Second",
            type: "FRAME",
            width: 320,
            x: 0,
            y: 0,
          },
        },
        rootId: "node_second_root",
        viewport: { height: 200, width: 320 },
      },
    ],
  };
  const changed = await prepareOperationBatch(before, {
    baseRevision: before.revision,
    batchId: "batch_screen_lifecycle",
    operations: [
      { screen: secondScreen, type: "put-screen" },
      { screenId: "scr_second", type: "set-default-screen" },
    ],
  });
  assert.equal(changed.snapshot.manifest.defaultScreenId, "scr_second");
  assert.equal(changed.snapshot.manifest.entries.screens.length, 2);
  const undone = await prepareOperationBatch(
    changed.snapshot,
    changed.result.inverseBatch,
  );
  assert.equal(undone.result.revision, before.revision);

  const replaced = await prepareOperationBatch(before, {
    baseRevision: before.revision,
    batchId: "batch_replace_only_screen",
    operations: [
      { screenId: "scr_roundtrip", type: "delete-screen" },
      { screen: secondScreen, type: "put-screen" },
    ],
  });
  assert.equal(replaced.snapshot.manifest.defaultScreenId, "scr_second");
  assert.deepEqual(replaced.snapshot.manifest.entries.screens, [
    "screens/second.json",
  ]);
  const restored = await prepareOperationBatch(
    replaced.snapshot,
    replaced.result.inverseBatch,
  );
  assert.equal(restored.result.revision, before.revision);
  assert.deepEqual(restored.snapshot.manifest, before.manifest);
  assert.deepEqual(restored.snapshot.entries, before.entries);
});

test("put-token rejects an Operation identity that differs from its definition", async () => {
  const before = await loadPackageFromValues(
    "memory://domain-token-id.smallpen",
    await fixtureValues(),
  );
  await assert.rejects(
    prepareOperationBatch(before, {
      baseRevision: before.revision,
      batchId: "batch_mismatched_token_id",
      operations: [
        {
          definition: tokenDefinition("tok_actual"),
          filePath: "tokens/design.json",
          path: "color.brand",
          tokenId: "tok_claimed",
          type: "put-token",
        },
      ],
    }),
    (error) => error?.code === "token_id_mismatch",
  );
});

test("domain deletes protect live references and reverse the complete lifecycle", async () => {
  const base = await loadPackageFromValues(
    "memory://domain-deletes.smallpen",
    await fixtureValues(),
  );
  const created = await prepareOperationBatch(base, domainBatch(base.revision));

  for (const [batchId, operation, code] of [
    [
      "batch_delete_used_component",
      { componentSetId: "cmp_button", type: "delete-component-set" },
      "missing_component",
    ],
    [
      "batch_delete_used_context",
      { entry: "contexts/design.json", type: "delete-context-file" },
      "invalid_scenario_context",
    ],
  ]) {
    await assert.rejects(
      prepareOperationBatch(created.snapshot, {
        baseRevision: created.snapshot.revision,
        batchId,
        operations: [operation],
      }),
      (error) => error?.code === code,
    );
  }

  const deleted = await prepareOperationBatch(created.snapshot, {
    baseRevision: created.snapshot.revision,
    batchId: "batch_delete_domain",
    operations: [
      { scenarioId: "scn_button_idle", type: "delete-scenario" },
      { entry: "requirements/requirements.json", type: "delete-requirement-file" },
      {
        interactionId: "int_activate",
        presentationId: "pres_desktop",
        screenId: "scr_roundtrip",
        type: "delete-interaction",
      },
      {
        field: "fill",
        nodeId: "node_rectangle",
        screenId: "scr_roundtrip",
        type: "clear-token-binding",
      },
      {
        changes: {},
        componentSetId: "cmp_button",
        nodeId: "node_button_source",
        type: "update-component-node",
        unset: ["tokenBindings"],
        variantId: "var_button_idle",
      },
      { componentSetId: "cmp_button", type: "delete-component-set" },
      { entry: "contexts/design.json", type: "delete-context-file" },
      { tokenId: "tok_brand", type: "remove-token" },
    ],
  });
  assert.equal(deleted.snapshot.domain.scenarios.size, 0);
  assert.equal(deleted.snapshot.domain.requirements.size, 0);
  assert.equal(deleted.snapshot.domain.componentSets.size, 0);
  assert.equal(deleted.snapshot.domain.contextAxes.size, 0);
  assert.equal(deleted.snapshot.domain.tokens.size, 0);
  assert.deepEqual(deleted.result.deletedFiles, [
    "contexts/design.json",
    "requirements/requirements.json",
  ]);
  assert.deepEqual(deleted.result.affectedIds, [
    "axis_state",
    "axis_theme",
    "cmp_button",
    "ctx_light",
    "flow_activate",
    "int_activate",
    "node_button_source",
    "node_rectangle",
    "req_activate",
    "scn_button_idle",
    "tok_brand",
    "var_button_idle",
  ]);

  const restored = await prepareOperationBatch(
    deleted.snapshot,
    deleted.result.inverseBatch,
  );
  assert.equal(restored.result.revision, created.snapshot.revision);
  assert.deepEqual(restored.snapshot.manifest, created.snapshot.manifest);
  assert.deepEqual(restored.snapshot.entries, created.snapshot.entries);
});

test("remove-dependent-usage Repair can clear a binding before Token deletion", async () => {
  const base = await loadPackageFromValues(
    "memory://domain-repair-remove.smallpen",
    await fixtureValues(),
  );
  const created = await prepareOperationBatch(base, {
    baseRevision: base.revision,
    batchId: "batch_repair_token_setup",
    operations: [
      {
        definition: tokenDefinition(),
        filePath: "tokens/design.json",
        path: "color.brand",
        tokenId: "tok_brand",
        type: "put-token",
      },
      {
        binding: { assetId: "tok_brand", packageId: "pkg_roundtrip" },
        field: "fill",
        nodeId: "node_rectangle",
        screenId: "scr_roundtrip",
        type: "set-token-binding",
      },
    ],
  });
  const repaired = await prepareOperationBatch(created.snapshot, {
    baseRevision: created.snapshot.revision,
    batchId: "batch_repair_remove_usage",
    operations: [
      {
        action: "remove-dependent-usage",
        referencePath:
          "screens/roundtrip.json.presentations[0].nodes.node_rectangle.tokenBindings.fill",
        type: "repair-reference",
      },
      { tokenId: "tok_brand", type: "remove-token" },
    ],
  });
  assert.equal(repaired.snapshot.domain.tokens.has("tok_brand"), false);
  assert.deepEqual(
    repaired.snapshot.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_rectangle.tokenBindings,
    {},
  );
  const restored = await prepareOperationBatch(
    repaired.snapshot,
    repaired.result.inverseBatch,
  );
  assert.equal(restored.result.revision, created.snapshot.revision);
});

test("Foundation dependency selection is a typed reversible Product Operation", async () => {
  const values = await fixtureValues();
  const manifest = values.get("manifest.json");
  manifest.role = "product";
  manifest.dependencies = [
    { packageId: "pkg_foundation_old", path: "old-foundation.smallpen" },
  ];
  const product = await loadPackageFromValues(
    "memory://dependency-operation.smallpen",
    values,
  );
  const changed = await prepareOperationBatch(product, {
    baseRevision: product.revision,
    batchId: "batch_choose_foundation",
    operations: [
      {
        dependency: {
          packageId: "pkg_foundation_new",
          path: "new-foundation.smallpen",
        },
        type: "set-foundation-dependency",
      },
    ],
  });
  assert.deepEqual(changed.snapshot.manifest.dependencies, [
    { packageId: "pkg_foundation_new", path: "new-foundation.smallpen" },
  ]);
  const restored = await prepareOperationBatch(
    changed.snapshot,
    changed.result.inverseBatch,
  );
  assert.equal(restored.result.revision, product.revision);
  assert.deepEqual(restored.snapshot.manifest, product.manifest);
});
