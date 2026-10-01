// Regressions found by mutating valid packages (loader fuzzing) and by the
// batch-ledger replay review. Every malformed package must fail with a typed
// SmallPenError; every package that loads must read and render.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  listEffectiveTokens,
  listPackageEntries,
  loadPackageFromValues,
  prepareOperationBatch,
  projectScreen,
  readDesignView,
} from "@smallpen/core";
import { compilePenpotChanges } from "@smallpen/penpot-adapter";
import {
  applyOperationBatch,
  createEvidence,
  openPackage,
  renderProjection,
} from "@smallpen/local-package";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "apps", "cli", "bin", "smallpen.mjs");

async function fixtureValues(name) {
  const root = join(here, "fixtures", name);
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of listPackageEntries(manifest).entries) {
    values.set(entry, JSON.parse(await readFile(join(root, entry), "utf8")));
  }
  return values;
}

async function copyFixture(context, name = "roundtrip.smallpen") {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-fuzz-"));
  context.after(() => rm(parent, { force: true, recursive: true }));
  const target = join(parent, name);
  await cp(join(here, "fixtures", name), target, { recursive: true });
  return (await openPackage(target)).locator;
}

function typed(code) {
  return (error) => {
    assert.equal(error?.name, "SmallPenError", error?.stack);
    assert.equal(error.code, code);
    return true;
  };
}

function nested(depth) {
  return JSON.parse(`${"[".repeat(depth)}${"]".repeat(depth)}`);
}

test("deeply nested package values fail typed instead of overflowing the stack", async (context) => {
  const values = await fixtureValues("roundtrip.smallpen");
  const deepManifest = new Map(values);
  deepManifest.set("manifest.json", {
    ...values.get("manifest.json"),
    name: nested(20000),
  });
  await assert.rejects(
    loadPackageFromValues("memory://deep.smallpen", deepManifest),
    typed("package_value_too_deep"),
  );
  const deepEntry = new Map(values);
  deepEntry.set("screens/roundtrip.json", {
    ...values.get("screens/roundtrip.json"),
    counterparts: nested(20000),
  });
  await assert.rejects(
    loadPackageFromValues("memory://deep.smallpen", deepEntry),
    typed("package_value_too_deep"),
  );
  // JSON.parse accepts the nesting, so the disk path must stop it too.
  const packagePath = await copyFixture(context);
  const manifestPath = join(packagePath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(
    manifestPath,
    JSON.stringify(manifest).replace(
      /}$/,
      `,"extra":${"[".repeat(20000)}${"]".repeat(20000)}}`,
    ),
  );
  await assert.rejects(openPackage(packagePath), typed("package_value_too_deep"));
});

test("deeply nested Operation Batch values fail typed before cloning", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://roundtrip.smallpen",
    await fixtureValues("roundtrip.smallpen"),
  );
  for (const baseRevision of [snapshot.revision, "stale"]) {
    await assert.rejects(
      prepareOperationBatch(snapshot, {
        baseRevision,
        batchId: "batch_deep",
        operations: [
          {
            entry: "screens/deep.json",
            screen: { id: "scr_deep", nested: nested(20000) },
            type: "put-screen",
          },
        ],
      }),
      typed("package_value_too_deep"),
    );
  }
});

test("Component Variant nodes validate paint and text attributes like Screen nodes", async () => {
  const values = await fixtureValues("design-system.smallpen");
  const components = structuredClone(values.get("components/components.json"));
  const nodes = components.componentSets[0].variants[0].nodes;
  const [nodeId] = Object.keys(nodes).filter((id) => nodes[id].fills);
  // A fill without a supported type reached the renderer and crashed it
  // with "paint.stops is not iterable".
  nodes[nodeId].fills = [{ assetId: "tok_x", packageId: "pkg_x" }];
  values.set("components/components.json", components);
  await assert.rejects(
    loadPackageFromValues("memory://variant.smallpen", values),
    typed("unsupported_fill_type"),
  );
  nodes[nodeId].fills = [];
  const [textId] = Object.keys(nodes).filter((id) => nodes[id].type === "TEXT");
  nodes[textId].textStyle = 42;
  await assert.rejects(
    loadPackageFromValues("memory://variant.smallpen", values),
    typed("invalid_text_style"),
  );
});

test("update-component-node clears a field set to null instead of storing null", async () => {
  const values = await fixtureValues("design-system.smallpen");
  const snapshot = await loadPackageFromValues("memory://variant.smallpen", values);
  const [componentSet] = snapshot.domain.componentSets.values();
  const [variant] = componentSet.variants;
  const [nodeId] = Object.keys(variant.nodes).filter(
    (id) => variant.nodes[id].fills,
  );
  const { snapshot: after } = await prepareOperationBatch(snapshot, {
    baseRevision: snapshot.revision,
    batchId: "batch_clear_fills",
    operations: [
      {
        changes: { fills: null },
        componentSetId: componentSet.id,
        nodeId,
        type: "update-component-node",
        variantId: variant.id,
      },
    ],
  });
  const node = after.domain.componentSets.get(componentSet.id).variants
    .find(({ id }) => id === variant.id).nodes[nodeId];
  assert.equal(Object.hasOwn(node, "fills"), false);
});

test("a requirement link kind named after an Object.prototype member is rejected typed", async () => {
  const values = new Map([
    [
      "manifest.json",
      {
        entries: {
          assets: [],
          components: [],
          contexts: [],
          requirements: ["requirements/product.json"],
          scenarios: [],
          screens: [],
          tokens: [],
        },
        formatVersion: 1,
        name: "Product",
        packageId: "pkg_product",
        role: "foundation",
      },
    ],
    [
      "requirements/product.json",
      {
        annotations: [],
        flows: [],
        requirements: [
          {
            id: "req_one",
            links: [{ flowId: "flow_one", kind: "toString" }],
            markdown: "Text",
            title: "One",
          },
        ],
      },
    ],
  ]);
  await assert.rejects(
    loadPackageFromValues("memory://requirements.smallpen", values),
    typed("invalid_design_target"),
  );
});

test("nodes without a children field load, read, project, and render", async () => {
  const values = await fixtureValues("design-system.smallpen");
  const screen = structuredClone(values.get("screens/screen.json"));
  let removed = 0;
  for (const presentation of screen.presentations) {
    for (const node of Object.values(presentation.nodes)) {
      if (Array.isArray(node.children) && node.children.length === 0) {
        delete node.children;
        removed += 1;
      }
    }
  }
  assert.ok(removed > 0);
  values.set("screens/screen.json", screen);
  const snapshot = await loadPackageFromValues("memory://leaves.smallpen", values);
  for (const viewFormat of ["structure", "semantic", "wireframe"]) {
    readDesignView(snapshot, { selector: { viewFormat } });
  }
  const projection = projectScreen(snapshot, screen.id);
  const render = await renderProjection(snapshot, projection, { scale: 0.25 });
  assert.equal(render.mimeType, "image/png");
  await createEvidence(snapshot, {});
});

test("an entry that matches its file only case-insensitively is rejected on every file system", async (context) => {
  const packagePath = await copyFixture(context);
  const manifestPath = join(packagePath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.entries.screens = ["Screens/RoundTrip.json"];
  await writeFile(manifestPath, JSON.stringify(manifest));
  // macOS and Windows resolve the mismatched name; Linux reports it missing.
  await assert.rejects(openPackage(packagePath), typed("invalid_entry_path"));
});

test("listing Tokens rejects an unknown Context Axis even with no Tokens", async () => {
  const values = await fixtureValues("roundtrip.smallpen");
  values.set("manifest.json", {
    ...values.get("manifest.json"),
    entries: { ...values.get("manifest.json").entries, tokens: [] },
  });
  const snapshot = await loadPackageFromValues("memory://no-tokens.smallpen", values);
  assert.deepEqual(listEffectiveTokens(snapshot), []);
  assert.throws(
    () => listEffectiveTokens(snapshot, { context: { foo: "bar" } }),
    typed("invalid_context_selection"),
  );
});

function opacityBatch(revision, opacity, batchId) {
  return {
    baseRevision: revision,
    batchId,
    operations: [
      {
        changes: { opacity },
        nodeId: "node_rectangle",
        presentationId: "pres_desktop",
        screenId: "scr_roundtrip",
        type: "update-presentation-node",
      },
    ],
  };
}

function rectangleOpacity(snapshot) {
  return snapshot.entries["screens/roundtrip.json"].presentations[0].nodes
    .node_rectangle.opacity;
}

test("a batch replayed after its effect was undone applies again (ABA)", async (context) => {
  const packagePath = await copyFixture(context);
  const base = (await openPackage(packagePath)).revision;
  const batch = opacityBatch(base, 0.4, "batch_aba");
  const first = await applyOperationBatch(packagePath, batch);
  const undone = await applyOperationBatch(packagePath, first.inverseBatch);
  assert.equal(undone.revision, base);

  const again = await applyOperationBatch(packagePath, batch);
  assert.equal(again.alreadyApplied, undefined);
  const current = await openPackage(packagePath);
  assert.equal(current.revision, again.revision);
  assert.equal(current.revision, first.revision);
  assert.equal(rectangleOpacity(current), 0.4);

  // Built on the reported revision, the next write is not stale.
  const next = await applyOperationBatch(
    packagePath,
    opacityBatch(again.revision, 0.5, "batch_aba_next"),
  );
  assert.equal(rectangleOpacity(await openPackage(packagePath)), 0.5);
  assert.equal(next.alreadyApplied, undefined);
});

test("a batch replayed after later writes never reports a stale revision as success", async (context) => {
  const packagePath = await copyFixture(context);
  const base = (await openPackage(packagePath)).revision;
  const batch = opacityBatch(base, 0.4, "batch_superseded");
  const first = await applyOperationBatch(packagePath, batch);
  const later = await applyOperationBatch(
    packagePath,
    opacityBatch(first.revision, 0.7, "batch_later"),
  );
  await assert.rejects(applyOperationBatch(packagePath, batch), (error) => {
    typed("batch_superseded")(error);
    assert.equal(error.details.committedRevision, first.revision);
    assert.equal(error.details.currentRevision, later.revision);
    return true;
  });
  const current = await openPackage(packagePath);
  assert.equal(current.revision, later.revision);
  assert.equal(rectangleOpacity(current), 0.7);
});

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout }));
  });
}

test("high-level commands rerun with the same --batch-id replay instead of conflicting", async (context) => {
  const packagePath = await copyFixture(context);
  const intentPath = `${packagePath}.flow.json`;
  await writeFile(
    intentPath,
    JSON.stringify({
      nodes: [
        {
          children: [],
          height: 10,
          id: "node_flow_retry",
          name: "Retry",
          type: "RECTANGLE",
          width: 10,
          x: 1,
          y: 1,
        },
      ],
      screenId: "scr_roundtrip",
    }),
  );
  const args = ["flow", packagePath, "--intent", intentPath, "--batch-id", "flow_retry", "--json"];
  const first = await runCli(args);
  assert.equal(first.code, 0, first.stdout);
  const firstResult = JSON.parse(first.stdout);
  const retry = await runCli(args);
  assert.equal(retry.code, 0, retry.stdout);
  const retryResult = JSON.parse(retry.stdout);
  assert.equal(retryResult.alreadyApplied, true);
  assert.equal(retryResult.revision, firstResult.revision);
  assert.equal((await openPackage(packagePath)).revision, firstResult.revision);

  // A different intent under the same id still conflicts, with retry guidance.
  const intent = JSON.parse(await readFile(intentPath, "utf8"));
  intent.nodes[0].id = "node_flow_other";
  await writeFile(intentPath, JSON.stringify(intent));
  const conflict = await runCli(args);
  assert.equal(conflict.code, 1);
  const payload = JSON.parse(conflict.stdout);
  assert.equal(payload.error.code, "batch_id_conflict");
  assert.match(payload.error.details.correction, /same high-level command input/);
});

test("tokens --context rejects an unknown Axis on a Package without Tokens", async (context) => {
  const packagePath = await copyFixture(context);
  const manifestPath = join(packagePath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.entries.tokens = [];
  await writeFile(manifestPath, JSON.stringify(manifest));
  await rename(join(packagePath, "tokens"), join(packagePath, "..", "unused-tokens"));
  const result = await runCli(["tokens", packagePath, "--context", "foo=bar", "--json"]);
  assert.equal(result.code, 1, result.stdout);
  assert.equal(JSON.parse(result.stdout).error.code, "invalid_context_selection");
});

test("an empty Penpot mov-objects is a no-op, alone or beside a real edit", async () => {
  const snapshot = await loadPackageFromValues(
    "memory://roundtrip.smallpen",
    await fixtureValues("roundtrip.smallpen"),
  );
  const pageId = snapshot.runtime.pages.scr_roundtrip.pres_desktop;
  const runtime = snapshot.runtime.nodes.scr_roundtrip.pres_desktop;
  // Penpot sends this when a drag ends inside the same parent.
  const emptyMove = {
    index: 0,
    "page-id": pageId,
    "parent-id": runtime.node_canvas,
    shapes: [],
    type: "mov-objects",
  };
  const alone = compilePenpotChanges(snapshot, {
    changes: [emptyMove],
    commitId: "empty-move",
  });
  assert.deepEqual(alone.operations, []);
  const prepared = await prepareOperationBatch(snapshot, alone);
  assert.equal(prepared.snapshot.revision, snapshot.revision);

  const withEdit = compilePenpotChanges(snapshot, {
    changes: [
      emptyMove,
      {
        id: runtime.node_rectangle,
        operations: [{ attr: "name", type: "set", val: "Dragged" }],
        "page-id": pageId,
        type: "mod-obj",
      },
    ],
    commitId: "empty-move-with-edit",
  });
  assert.deepEqual(
    withEdit.operations.map(({ type }) => type),
    ["update-presentation-node"],
  );
  await prepareOperationBatch(snapshot, withEdit);

  // The generated Design System page rejects structural changes, but an
  // empty move changes nothing there either.
  const designSystem = await loadPackageFromValues(
    "memory://design-system.smallpen",
    await fixtureValues("design-system.smallpen"),
  );
  const designSystemPage = designSystem.runtime.designSystemPage;
  assert.ok(designSystemPage);
  const onDesignSystemPage = compilePenpotChanges(designSystem, {
    changes: [{ ...emptyMove, "page-id": designSystemPage, "parent-id": designSystemPage }],
    commitId: "empty-move-design-system",
  });
  assert.deepEqual(onDesignSystemPage.operations, []);
});
