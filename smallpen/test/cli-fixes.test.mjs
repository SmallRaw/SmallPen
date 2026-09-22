import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "apps", "cli", "bin", "smallpen-check.cjs");
const fixture = join(here, "fixtures", "roundtrip.smallpen");

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr, stdout }));
  });
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function workspaceFixture() {
  const root = await mkdtemp(join(tmpdir(), "smallpen-cli-fixes-"));
  const productPath = join(root, "app.smallpen");
  const foundationPath = join(root, "foundation.smallpen");
  await cp(fixture, productPath, { recursive: true });
  await cp(fixture, foundationPath, { recursive: true });
  const foundationManifest = JSON.parse(
    await readFile(join(foundationPath, "manifest.json"), "utf8"),
  );
  foundationManifest.name = "Foundation";
  foundationManifest.packageId = "pkg_foundation";
  await writeJson(join(foundationPath, "manifest.json"), foundationManifest);
  const productManifest = JSON.parse(
    await readFile(join(productPath, "manifest.json"), "utf8"),
  );
  productManifest.dependencies = [
    { packageId: "pkg_foundation", path: "foundation.smallpen" },
  ];
  productManifest.name = "Product";
  productManifest.packageId = "pkg_product";
  productManifest.role = "product";
  await writeJson(join(productPath, "manifest.json"), productManifest);
  return { foundationPath, productPath, root };
}

async function clonePackage(path, name) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-cli-clone-"));
  const target = join(root, name);
  await cp(path, target, { recursive: true });
  return target;
}

test("stale writes return executable public recovery commands (SP-037)", async () => {
  const packagePath = await clonePackage(fixture, `stale-${Date.now()}.smallpen`);
  const read = await runCli(["read", packagePath, "--json"]);
  const { revision } = JSON.parse(read.stdout);
  const batch = {
    baseRevision: "0".repeat(64),
    batchId: "batch_stale_cli",
    operations: [{
      changes: { name: "Renamed by stale intent" },
      nodeId: "node_rectangle",
      screenId: "scr_roundtrip",
      type: "update-node",
    }],
  };
  const batchPath = `${packagePath}.stale-batch.json`;
  await writeJson(batchPath, batch);
  const result = await runCli([
    "apply",
    packagePath,
    "--batch",
    batchPath,
    "--json",
  ]);
  assert.equal(result.code, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error.code, "stale_revision");
  assert.ok(Array.isArray(payload.error.details.commands));
  const [readStep, replayStep] = payload.error.details.commands;
  assert.equal(readStep.argv[0], "read");
  assert.equal(readStep.argv[1], packagePath);
  assert.equal(replayStep.argv[0], "apply");
  assert.equal(replayStep.argv[2], "--batch");
  assert.ok(!replayStep.argv.includes("--batch-id"), "apply has no --batch-id option");
  assert.match(replayStep.explanation, /baseRevision/);
  assert.match(replayStep.explanation, /batchId/);
  assert.ok(
    Array.isArray(payload.error.details.remainingIntent),
    "remaining intent is echoed for the rebuild",
  );
  assert.match(payload.error.details.recovery, /atomically/);
});

test("live token removal errors carry executable recovery steps (SP-002)", async () => {
  const packagePath = await clonePackage(fixture, `token-live-${Date.now()}.smallpen`);
  // Bind a token, then attempt to remove it while the binding is live.
  const tokenBatchPath = `${packagePath}.token.json`;
  await writeJson(tokenBatchPath, {
    baseRevision: JSON.parse((await runCli(["read", packagePath, "--json"])).stdout).revision,
    batchId: "batch_token_create",
    operations: [{
      definition: {
        $extensions: {
          smallpen: { id: "tok_spacing_local", visibility: "public" },
        },
        $type: "number",
        $value: 16,
      },
      filePath: "tokens/local.json",
      path: "space.tight",
      tokenId: "tok_spacing_local",
      type: "put-token",
    }],
  });
  const created = await runCli([
    "apply",
    packagePath,
    "--batch",
    tokenBatchPath,
    "--json",
  ]);
  assert.equal(created.code, 0, created.stdout);
  const bindBatchPath = `${packagePath}.bind.json`;
  await writeJson(bindBatchPath, {
    baseRevision: JSON.parse((await runCli(["read", packagePath, "--json"])).stdout).revision,
    batchId: "batch_token_bind",
    operations: [{
      binding: { assetId: "tok_spacing_local", packageId: "pkg_roundtrip" },
      field: "itemSpacing",
      nodeId: "node_rectangle",
      screenId: "scr_roundtrip",
      type: "set-token-binding",
    }],
  });
  const bound = await runCli(["apply", packagePath, "--batch", bindBatchPath, "--json"]);
  assert.equal(bound.code, 0, bound.stdout);
  const removeBatchPath = `${packagePath}.remove.json`;
  await writeJson(removeBatchPath, {
    baseRevision: JSON.parse((await runCli(["read", packagePath, "--json"])).stdout).revision,
    batchId: "batch_token_remove",
    operations: [{ tokenId: "tok_spacing_local", type: "remove-token" }],
  });
  const removed = await runCli([
    "apply",
    packagePath,
    "--batch",
    removeBatchPath,
    "--json",
  ]);
  assert.equal(removed.code, 1);
  const payload = JSON.parse(removed.stdout);
  assert.equal(payload.error.code, "missing_local_asset");
  assert.ok(Array.isArray(payload.error.details.commands));
  const impactStep = payload.error.details.commands[0];
  assert.equal(impactStep.argv[0], "impact");
  assert.equal(impactStep.argv[3], "tok_spacing_local");
  assert.match(payload.error.details.recovery, /clear-token-binding|referenced/);
  assert.ok(Array.isArray(payload.error.details.nextOperations));
});

test("unmatched raw values expose a documented confirmation flag (SP-003)", async () => {
  const packagePath = await clonePackage(fixture, `confirm-${Date.now()}.smallpen`);
  const read = JSON.parse((await runCli(["read", packagePath, "--json"])).stdout);
  const tokenBatchPath = `${packagePath}.tokens.json`;
  await writeJson(tokenBatchPath, {
    baseRevision: read.revision,
    batchId: "batch_seed_tokens",
    operations: [{
      definition: {
        $extensions: {
          smallpen: { id: "tok_seed_brand", visibility: "public" },
        },
        $type: "color",
        $value: "#6750a4",
      },
      filePath: "tokens/design.json",
      path: "color.brand",
      tokenId: "tok_seed_brand",
      type: "put-token",
    }],
  });
  const seeded = await runCli(["apply", packagePath, "--batch", tokenBatchPath, "--json"]);
  assert.equal(seeded.code, 0, seeded.stdout);
  const rebased = JSON.parse((await runCli(["read", packagePath, "--json"])).stdout);
  const batchPath = `${packagePath}.raw.json`;
  await writeJson(batchPath, {
    baseRevision: rebased.revision,
    batchId: "batch_raw_color",
    operations: [{
      changes: {
        fills: [{ color: "#0f766e", type: "solid" }],
      },
      nodeId: "node_rectangle",
      screenId: "scr_roundtrip",
      type: "update-node",
    }],
  });
  const plain = await runCli(["apply", packagePath, "--batch", batchPath, "--json"]);
  assert.equal(plain.code, 0, plain.stdout);
  const plainPayload = JSON.parse(plain.stdout);
  const unmatched = (plainPayload.warnings ?? []).filter(
    (warning) => warning.code === "design_token_value_unmatched",
  );
  assert.ok(unmatched.length > 0, "raw write surfaces the unmatched warning");
  assert.ok(unmatched.every((warning) => warning.confirmed === undefined));

  const help = await runCli(["apply", "--help"]);
  assert.match(help.stdout, /--confirm-unmatched/);
  assert.match(help.stdout, /design_token_value_unmatched/);
});

test("catalog attributes contributing revisions and workspace warnings (SP-021/SP-022)", async () => {
  const { productPath } = await workspaceFixture();
  const catalog = JSON.parse(
    (await runCli(["catalog", productPath, "--json"])).stdout,
  );
  assert.equal(catalog.productRevision, catalog.revision);
  assert.ok(catalog.foundationRevision, "catalog carries the Foundation revision");
  assert.ok(Array.isArray(catalog.warnings));

  // A Foundation outside the workspace root is valid but warned about.
  const outsideRoot = await mkdtemp(join(tmpdir(), "smallpen-cli-outside-"));
  const outsidePath = join(outsideRoot, "outside.smallpen");
  await cp(fixture, outsidePath, { recursive: true });
  const outsideManifestPath = join(outsidePath, "manifest.json");
  const outsideManifest = JSON.parse(await readFile(outsideManifestPath, "utf8"));
  outsideManifest.name = "Foundation";
  outsideManifest.packageId = "pkg_foundation";
  await writeJson(outsideManifestPath, outsideManifest);
  const linkPath = join(dirname(productPath), "linked.smallpen");
  await symlink(outsidePath, linkPath);
  const productManifestPath = join(productPath, "manifest.json");
  const productManifest = JSON.parse(await readFile(productManifestPath, "utf8"));
  productManifest.dependencies[0].path = "linked.smallpen";
  await writeJson(productManifestPath, productManifest);
  const validated = JSON.parse(
    (await runCli(["validate", productPath, "--json"])).stdout,
  );
  assert.equal(validated.status, "valid");
  assert.ok(
    validated.warnings.some((warning) => warning.code === "external_foundation_path"),
    "external Foundation path is surfaced as a warning",
  );
});

test("repair conflict listings carry executable choice commands (SP-038)", async () => {
  const { foundationPath, productPath } = await workspaceFixture();
  const foundationManifestPath = join(foundationPath, "manifest.json");
  const foundationManifest = JSON.parse(
    await readFile(foundationManifestPath, "utf8"),
  );
  foundationManifest.entries.tokens = ["tokens/design.json"];
  await writeJson(foundationManifestPath, foundationManifest);
  await mkdir(join(foundationPath, "tokens"), { recursive: true });
  const tokenLibrary = {
    activeSetIds: ["tset_foundation"],
    activeThemeIds: [],
    id: "tlib_foundation",
    sets: [{
      description: "Foundation",
      id: "tset_foundation",
      name: "Foundation",
      tokens: [{
        description: "Brand",
        id: "tok_foundation_brand",
        name: "color.brand",
        type: "color",
        value: "#6750a4",
      }],
    }],
    themes: [],
  };
  await writeJson(join(foundationPath, "tokens/design.json"), tokenLibrary);
  const screenPath = join(productPath, "screens/roundtrip.json");
  const screen = JSON.parse(await readFile(screenPath, "utf8"));
  screen.presentations[0].nodes.node_rectangle.tokenBindings = {
    fill: { assetId: "tok_foundation_brand", packageId: "pkg_foundation" },
  };
  await writeJson(screenPath, screen);
  tokenLibrary.sets[0].tokens = [];
  await writeJson(join(foundationPath, "tokens/design.json"), tokenLibrary);

  const listed = JSON.parse(
    (await runCli(["repair", productPath, "--json"])).stdout,
  );
  assert.equal(listed.status, "repair");
  assert.ok(listed.conflicts.length > 0);
  for (const [conflictIndex, conflict] of listed.conflicts.entries()) {
    for (const choice of conflict.choices ?? []) {
      assert.ok(Array.isArray(choice.command?.argv), "each choice has argv");
      assert.equal(choice.command.argv[0], "repair");
      assert.equal(choice.command.argv[3], String(conflictIndex));
      assert.ok(choice.command.argv.includes("--action"));
      assert.ok(choice.command.argv.includes("--json"));
      if (choice.action === "recreate-product-asset") {
        assert.equal(choice.command.argv[choice.command.argv.indexOf("--asset-kind") + 1], "token");
      }
    }
  }
});

test("the public launcher gates Node version before ESM instantiation (SP-050)", async () => {
  const gate = await readFile(
    join(here, "..", "apps", "cli", "bin", "smallpen-check.cjs"),
    "utf8",
  );
  assert.match(gate, /unsupported_node_runtime/);
  assert.match(gate, /major < 24/);
  // The public launcher passes through to the CLI on the current runtime.
  const result = await runCli(["version"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), "0.1.0");
});

async function componentWorkspace() {
  const { foundationPath, productPath, root } = await workspaceFixture();
  const foundationManifest = JSON.parse(
    await readFile(join(foundationPath, "manifest.json"), "utf8"),
  );
  foundationManifest.entries.components = ["components/shared.json"];
  await writeJson(join(foundationPath, "manifest.json"), foundationManifest);
  await mkdir(join(foundationPath, "components"), { recursive: true });
  await writeJson(join(foundationPath, "components/shared.json"), {
    componentSets: [{
      axes: [{
        domain: ["idle"],
        id: "axis_state",
        name: "State",
        role: "state",
      }],
      id: "cmp_shared_button",
      name: "Shared Button",
      variants: [{
        id: "var_shared_idle",
        nodes: {
          node_shared_root: {
            children: [],
            fills: [{ color: "#2563eb", type: "solid" }],
            height: 40,
            id: "node_shared_root",
            name: "Shared Button",
            type: "COMPONENT",
            width: 120,
            x: 0,
            y: 0,
          },
        },
        rootId: "node_shared_root",
        selection: { axis_state: "idle" },
      }],
      visibility: "public",
    }],
  });
  const screenPath = join(productPath, "screens/roundtrip.json");
  const screen = JSON.parse(await readFile(screenPath, "utf8"));
  screen.presentations[0].nodes.node_shared_instance = {
    children: [],
    height: 40,
    id: "node_shared_instance",
    instance: {
      component: { assetId: "cmp_shared_button", packageId: "pkg_foundation" },
      variant: { axis_state: "idle" },
    },
    name: "Shared instance",
    type: "INSTANCE",
    width: 120,
    x: 400,
    y: 300,
  };
  screen.presentations[0].nodes.node_canvas.children.push("node_shared_instance");
  await writeJson(screenPath, screen);
  return { foundationPath, productPath, root };
}

test("search-components ships executable insertion advice (SP-017)", async () => {
  const { productPath } = await componentWorkspace();
  const search = JSON.parse(
    (
      await runCli([
        "search-components",
        productPath,
        "--query",
        "Shared Button",
        "--json",
      ])
    ).stdout,
  );
  const match = search.items.find((item) => item.id === "cmp_shared_button");
  assert.ok(match, "shared component is discoverable from the Product");
  const insertion = match.recommendedInsertion;
  assert.ok(insertion, "candidates carry recommendedInsertion");
  assert.equal(insertion.intent.screenId, "scr_roundtrip");
  assert.equal(insertion.intent.nodes[0].type, "INSTANCE");
  assert.equal(
    insertion.intent.nodes[0].instance.component.assetId,
    "cmp_shared_button",
  );
  assert.equal(insertion.intent.nodes[0].width, 120);

  // The advice is executable: run the flow intent it recommends.
  const intentPath = `${productPath}.insertion-intent.json`;
  await writeJson(intentPath, insertion.intent);
  const applied = JSON.parse(
    (
      await runCli(["flow", productPath, "--intent", intentPath, "--json"])
    ).stdout,
  );
  assert.ok(applied.revision);
  const verify = JSON.parse(
    (await runCli(["read-view", productPath, "--json"])).stdout,
  );
  const nodes = verify.result?.nodes ?? {};
  assert.ok(
    Object.values(nodes).some(
      (node) =>
        node.type === "INSTANCE" &&
        (node.instance?.component?.assetId === "cmp_shared_button" ||
          node.componentRef?.assetId === "cmp_shared_button"),
    ),
    "the inserted instance exists after executing the advice",
  );
});

test("shared component deletion is refused while a consumer exists (SP-018)", async () => {
  const { foundationPath } = await componentWorkspace();
  const batchPath = `${foundationPath}.delete.json`;
  await writeJson(batchPath, {
    baseRevision: JSON.parse((await runCli(["read", foundationPath, "--json"])).stdout).revision,
    batchId: "batch_delete_shared",
    operations: [{ componentSetId: "cmp_shared_button", type: "delete-component-set" }],
  });
  const refused = await runCli([
    "apply",
    foundationPath,
    "--batch",
    batchPath,
    "--json",
  ]);
  assert.equal(refused.code, 1);
  const payload = JSON.parse(refused.stdout);
  assert.equal(payload.error.code, "component_in_use_external");
  assert.equal(payload.error.details.consumerPackageId, "pkg_product");
  assert.ok(Array.isArray(payload.error.details.nextOperations));

  // After the consumer is removed, the deletion succeeds.
  const screenPath = join(foundationPath, "..", "app.smallpen", "screens/roundtrip.json");
  const screen = JSON.parse(await readFile(screenPath, "utf8"));
  delete screen.presentations[0].nodes.node_shared_instance;
  screen.presentations[0].nodes.node_canvas.children =
    screen.presentations[0].nodes.node_canvas.children.filter(
      (id) => id !== "node_shared_instance",
    );
  await writeJson(screenPath, screen);
  const rebased = JSON.parse((await runCli(["read", foundationPath, "--json"])).stdout);
  await writeJson(batchPath, {
    baseRevision: rebased.revision,
    batchId: "batch_delete_shared_rebased",
    operations: [{ componentSetId: "cmp_shared_button", type: "delete-component-set" }],
  });
  const accepted = await runCli([
    "apply",
    foundationPath,
    "--batch",
    batchPath,
    "--json",
  ]);
  assert.equal(accepted.code, 0, accepted.stdout);
});

test("batch identity replays idempotently across CLI processes (SP-039)", async () => {
  const packagePath = await clonePackage(fixture, `idempotent-${Date.now()}.smallpen`);
  const read = JSON.parse((await runCli(["read", packagePath, "--json"])).stdout);
  const batchPath = `${packagePath}.batch.json`;
  const batch = {
    baseRevision: read.revision,
    batchId: "batch_idempotent_cli",
    operations: [{
      changes: { name: "Renamed once" },
      nodeId: "node_rectangle",
      screenId: "scr_roundtrip",
      type: "update-node",
    }],
  };
  await writeJson(batchPath, batch);
  const first = JSON.parse(
    (await runCli(["apply", packagePath, "--batch", batchPath, "--json"])).stdout,
  );
  assert.equal(first.batchId, "batch_idempotent_cli");
  // Replaying the identical file returns the recorded confirmation.
  const replay = JSON.parse(
    (await runCli(["apply", packagePath, "--batch", batchPath, "--json"])).stdout,
  );
  assert.equal(replay.alreadyApplied, true);
  assert.equal(replay.revision, first.revision);
  assert.equal(replay.batchId, "batch_idempotent_cli");
});

test("reusing a batch identity for different operations is rejected (SP-040)", async () => {
  const packagePath = await clonePackage(fixture, `conflict-${Date.now()}.smallpen`);
  const read = JSON.parse((await runCli(["read", packagePath, "--json"])).stdout);
  const batchPath = `${packagePath}.batch.json`;
  await writeJson(batchPath, {
    baseRevision: read.revision,
    batchId: "batch_conflict_cli",
    operations: [{
      changes: { name: "First intent" },
      nodeId: "node_rectangle",
      screenId: "scr_roundtrip",
      type: "update-node",
    }],
  });
  const first = JSON.parse(
    (await runCli(["apply", packagePath, "--batch", batchPath, "--json"])).stdout,
  );
  await writeJson(batchPath, {
    baseRevision: first.revision,
    batchId: "batch_conflict_cli",
    operations: [{
      changes: { name: "Different intent" },
      nodeId: "node_rectangle",
      screenId: "scr_roundtrip",
      type: "update-node",
    }],
  });
  const conflict = await runCli([
    "apply",
    packagePath,
    "--batch",
    batchPath,
    "--json",
  ]);
  assert.equal(conflict.code, 1);
  const payload = JSON.parse(conflict.stdout);
  assert.equal(payload.error.code, "batch_id_conflict");
  assert.match(payload.error.details.correction, /new unique batchId/);
});

test("watch without --max-events survives edits and emits both revisions (SP-041-A)", async () => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-watch-live-"));
  const packagePath = join(root, "p.smallpen");
  await cp(fixture, packagePath, { recursive: true });
  const child = spawn(process.execPath, [cli, "watch", packagePath, "--json"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await wait(700);
  assert.equal(child.exitCode, null, "watch must keep observing by default");
  const read = JSON.parse((await runCli(["read", packagePath, "--json"])).stdout);
  const editPath = join(root, "edit.json");
  await writeJson(editPath, {
    baseRevision: read.revision,
    batchId: "batch_watch_edit",
    operations: [{
      changes: { name: "Watched" },
      nodeId: "node_rectangle",
      screenId: "scr_roundtrip",
      type: "update-node",
    }],
  });
  const applied = await runCli(["apply", packagePath, "--batch", editPath, "--json"]);
  assert.equal(applied.code, 0, applied.stdout);
  await wait(1100);
  child.kill("SIGINT");
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), 3000);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  assert.equal(exitCode, 0);
  const events = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(events.length >= 2, `expected initial + edited events: ${stdout}`);
  assert.equal(events[0].event, "revision");
  assert.notEqual(events.at(-1).revision, events[0].revision);
});

test("watch emits revision events and terminates under --max-events (SP-041)", async () => {
  const packagePath = await clonePackage(fixture, `watch-${Date.now()}.smallpen`);
  const watched = await runCli([
    "watch",
    packagePath,
    "--max-events",
    "1",
    "--json",
  ]);
  assert.equal(watched.code, 0);
  const event = JSON.parse(watched.stdout.trim().split("\n").at(-1));
  assert.equal(event.event, "revision");
  assert.equal(event.packageId, "pkg_roundtrip");
  assert.equal(event.revision, event.revision);
});

test("every write supports explain and diff previews without writing (SP-042/SP-043)", async () => {
  const packagePath = await clonePackage(fixture, `explain-${Date.now()}.smallpen`);
  const read = JSON.parse((await runCli(["read", packagePath, "--json"])).stdout);
  const batchPath = `${packagePath}.batch.json`;
  await writeJson(batchPath, {
    baseRevision: read.revision,
    batchId: "batch_explain",
    operations: [{
      changes: {
        fills: [{ color: "#0f766e", type: "solid" }],
        name: "Renamed rectangle",
      },
      nodeId: "node_rectangle",
      screenId: "scr_roundtrip",
      type: "update-node",
    }],
  });
  const explained = JSON.parse(
    (
      await runCli([
        "apply",
        packagePath,
        "--batch",
        batchPath,
        "--explain",
        "--json",
      ])
    ).stdout,
  );
  assert.equal(explained.dryRun, true);
  assert.deepEqual(explained.explain[0].target.nodeId, "node_rectangle");
  const diffEntry = explained.diff.find(
    (entry) => entry.entry === "screens/roundtrip.json",
  );
  assert.ok(diffEntry?.changes?.presentations, "changed canonical fields appear");
  assert.notDeepEqual(
    diffEntry.changes.presentations.before,
    diffEntry.changes.presentations.after,
  );

  // The explain run wrote nothing: the plain apply still applies cleanly.
  const after = JSON.parse(
    (await runCli(["apply", packagePath, "--batch", batchPath, "--json"])).stdout,
  );
  assert.equal(after.batchId, "batch_explain");
});

// RV-003-A/B: --explain/--diff/--confirm-unmatched are order-independent flags.
test("boolean flags work in any position relative to value options (RV-003-A/B)", async () => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-rv003-"));
  const packagePath = join(root, "p.smallpen");
  await cp(fixture, packagePath, { recursive: true });
  const read = JSON.parse((await runCli(["read", packagePath, "--json"])).stdout);
  const batchPath = join(root, "batch.json");
  await writeJson(batchPath, {
    baseRevision: read.revision,
    batchId: "batch_rv003_order",
    operations: [{
      changes: { name: "Order probe" },
      nodeId: "node_rectangle",
      screenId: "scr_roundtrip",
      type: "update-node",
    }],
  });
  for (const [index, argv] of [
    ["apply", packagePath, "--explain", "--batch", batchPath, "--json"],
    ["apply", packagePath, "--batch", batchPath, "--explain", "--json"],
    ["apply", packagePath, "--diff", "--batch", batchPath, "--json"],
    ["apply", packagePath, "--batch", batchPath, "--diff", "--json"],
    ["apply", packagePath, "--confirm-unmatched", "--batch", batchPath, "--json"],
    ["apply", packagePath, "--batch", batchPath, "--confirm-unmatched", "--json"],
  ].entries()) {
    const probePath = join(root, `p-${index}.smallpen`);
    await cp(fixture, probePath, { recursive: true });
    const argvWithProbe = argv.map((part) => (part === packagePath ? probePath : part));
    const result = await runCli(argvWithProbe);
    assert.equal(result.code, 0, `permutation ${index} failed: ${result.stdout}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.batchId, "batch_rv003_order");
  }
});

test("flow/page/token flag permutations do not change outcomes (RV-003-B)", async () => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-rv003b-"));
  const packagePath = join(root, "p.smallpen");
  await cp(fixture, packagePath, { recursive: true });
  const read = JSON.parse((await runCli(["read", packagePath, "--json"])).stdout);

  const flowIntentPath = join(root, "flow-intent.json");
  await writeJson(flowIntentPath, {
    nodes: [{
      children: [],
      fills: [{ color: "#2563eb", type: "solid" }],
      height: 60,
      id: "node_rv003_flow",
      name: "Flow node",
      type: "RECTANGLE",
      width: 80,
      x: 20,
      y: 20,
    }],
    parentId: "node_canvas",
    presentationId: "pres_desktop",
    screenId: "scr_roundtrip",
  });
  const tokenIntentPath = join(root, "token-intent.json");
  await writeJson(tokenIntentPath, {
    operations: [{
      definition: {
        $extensions: {
          smallpen: { id: "tok_rv003", visibility: "public" },
        },
        $type: "color",
        $value: "#123456",
      },
      filePath: "tokens/rv003.json",
      path: "color.rv003",
      tokenId: "tok_rv003",
      type: "put-token",
    }],
  });

  // Each entry probes two flag orders; every run gets a fresh package copy so
  // no-op safety keeps results comparable.
  const cases = [
    ["flow", flowIntentPath],
    ["page", flowIntentPath],
    ["token", tokenIntentPath],
  ];
  for (const [command, intentPath] of cases) {
    for (const [flagName, flagPosition] of [
      ["--explain", "before"],
      ["--explain", "after"],
      ["--confirm-unmatched", "before"],
      ["--diff", "after"],
    ]) {
      const probePath = join(root, `${command}-${flagName}-${flagPosition}.smallpen`);
      await cp(fixture, probePath, { recursive: true });
      const intentForProbe = join(root, `${command}-${flagName}-${flagPosition}-intent.json`);
      await cp(intentPath, intentForProbe);
      const argv = [
        command,
        probePath,
        ...(flagPosition === "before" ? [flagName] : []),
        "--intent",
        intentForProbe,
        ...(flagPosition === "after" ? [flagName] : []),
        "--json",
      ];
      const result = await runCli(argv);
      assert.equal(result.code, 0, `${command} ${flagName}/${flagPosition}: ${result.stdout}`);
      const payload = JSON.parse(result.stdout);
      assert.ok(payload.revision, `${command} ${flagName} returns a revision`);
    }
  }
});

// RV-003-C: explain/diff are read-only previews in every combination.
test("explain and diff previews never write, in any combination (RV-003-C)", async () => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-rv003c-"));
  for (const flags of [["--explain"], ["--diff"], ["--explain", "--diff"], ["--diff", "--dry-run"]]) {
    const packagePath = join(root, `${flags.join("")}.smallpen`.replaceAll("--", ""));
    await cp(fixture, packagePath, { recursive: true });
    const read = JSON.parse((await runCli(["read", packagePath, "--json"])).stdout);
    const batchPath = join(root, `${flags.join("")}.batch.json`.replaceAll("--", ""));
    await writeJson(batchPath, {
      baseRevision: read.revision,
      batchId: "batch_rv003c",
      operations: [{
        changes: { name: "Should never apply" },
        nodeId: "node_rectangle",
        screenId: "scr_roundtrip",
        type: "update-node",
      }],
    });
    const result = await runCli([
      "apply",
      packagePath,
      ...flags,
      "--batch",
      batchPath,
      "--json",
    ]);
    assert.equal(result.code, 0, `${flags.join(" ")}: ${result.stdout}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.dryRun, true, `${flags.join(" ")} must not write`);
    assert.ok(payload.diff, `${flags.join(" ")} returns a diff`);
    const after = JSON.parse((await runCli(["read", packagePath, "--json"])).stdout);
    assert.equal(after.revision, read.revision, `${flags.join(" ")} leaves the package unchanged`);
    assert.equal(
      after.entries["screens/roundtrip.json"].presentations[0].nodes.node_rectangle.name,
      "Editable Rectangle",
    );
    const diffEntry = payload.diff.find(
      (entry) => entry.entry === "screens/roundtrip.json",
    );
    assert.equal(
      diffEntry.changes.presentations.before !== diffEntry.changes.presentations.after,
      true,
    );
  }

  // --confirm-unmatched marks unmatched groups confirmed regardless of order.
  for (const [order, index] of [["before", 0], ["after", 1]]) {
    const packagePath = join(root, `confirm-${index}.smallpen`);
    await cp(fixture, packagePath, { recursive: true });
    const seededBatchPath = join(root, `confirm-${index}-seed.json`);
    const read = JSON.parse((await runCli(["read", packagePath, "--json"])).stdout);
    await writeJson(seededBatchPath, {
      baseRevision: read.revision,
      batchId: "batch_rv003c_seed",
      operations: [{
        definition: {
          $extensions: { smallpen: { id: "tok_rv003c", visibility: "public" } },
        },
        $type: "color",
        $value: "#6750a4",
        filePath: "tokens/rv003c.json",
        path: "color.rv003c",
        tokenId: "tok_rv003c",
        type: "put-token",
      }],
    });
    // Seed the token, then write an unmatched raw color with the flag in both positions.
    const seeded = await runCli(["apply", packagePath, "--batch", seededBatchPath, "--json"]);
    assert.equal(seeded.code, 0, seeded.stdout);
    const rebased = JSON.parse((await runCli(["read", packagePath, "--json"])).stdout);
    const rawPath = join(root, `confirm-${index}-raw.json`);
    await writeJson(rawPath, {
      baseRevision: rebased.revision,
      batchId: "batch_rv003c_raw",
      operations: [{
        changes: { fills: [{ color: "#0f766e", type: "solid" }] },
        nodeId: "node_rectangle",
        screenId: "scr_roundtrip",
        type: "update-node",
      }],
    });
    const argv = [
      "apply",
      packagePath,
      ...(order === "before" ? ["--confirm-unmatched"] : []),
      "--batch",
      rawPath,
      ...(order === "after" ? ["--confirm-unmatched"] : []),
      "--json",
    ];
    const confirmed = JSON.parse((await runCli(argv)).stdout);
    const unmatched = (confirmed.warnings ?? []).filter(
      (warning) => warning.code === "design_token_value_unmatched",
    );
    assert.ok(unmatched.length > 0);
    assert.ok(
      unmatched.length > 0 && unmatched.every((warning) => warning.confirmed === true),
      `confirmed flag (${order}) marks unmatched warnings`,
    );
    assert.equal(
      confirmed.warningSummary.unmatchedConfirmed,
      unmatched.length,
    );
  }
});

// RV-003-D: unknown options and value-less options are rejected cleanly in any
// position around the new flags.
test("unknown and value-less options are rejected around new flags (RV-003-D)", async () => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-rv003d-"));
  const packagePath = join(root, "p.smallpen");
  await cp(fixture, packagePath, { recursive: true });
  const read = JSON.parse((await runCli(["read", packagePath, "--json"])).stdout);
  const batchPath = join(root, "batch.json");
  await writeJson(batchPath, {
    baseRevision: read.revision,
    batchId: "batch_rv003d",
    operations: [{
      changes: { name: "X" },
      nodeId: "node_rectangle",
      screenId: "scr_roundtrip",
      type: "update-node",
    }],
  });

  for (const argv of [
    ["apply", packagePath, "--not-a-real-option", "--explain", "--batch", batchPath, "--json"],
    ["apply", packagePath, "--explain", "--not-a-real-option", "--batch", batchPath, "--json"],
    ["apply", packagePath, "--explain", "--batch", batchPath, "--not-a-real-option", "--json"],
    ["apply", packagePath, "--confirm-unmatched", "--not-a-real-option", "--batch", batchPath, "--json"],
    // Value-less options must not swallow flags or JSON as their value.
    ["apply", packagePath, "--explain", "--batch", "--json"],
    ["apply", packagePath, "--diff", "--batch", "--explain"],
    ["flow", packagePath, "--intent", "--json"],
  ]) {
    const result = await runCli(argv);
    assert.equal(result.code, 1, `expected rejection: ${argv.join(" ")}`);
    const payload = JSON.parse(result.stdout);
    assert.ok(
      ["unknown_option", "missing_option_value"].includes(payload.error.code),
      `${argv.join(" ")} → ${payload.error.code}`,
    );
    // Nothing applied.
    const after = JSON.parse((await runCli(["read", packagePath, "--json"])).stdout);
    assert.equal(after.revision, read.revision);
  }
});

// RV-004-C: the stale error's own commands must be executable as-is (with only
// the placeholder batch path substituted) and must preserve concurrent edits.
test("stale recovery commands execute and preserve concurrent edits (RV-004-C)", async () => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-rv004c-"));
  const packagePath = join(root, "p.smallpen");
  await cp(fixture, packagePath, { recursive: true });
  const base = JSON.parse((await runCli(["read", packagePath, "--json"])).stdout);

  // Concurrent writer changes fills on revision A -> B.
  const concurrentPath = join(root, "concurrent.json");
  await writeJson(concurrentPath, {
    baseRevision: base.revision,
    batchId: "batch_rv004c_concurrent",
    operations: [{
      changes: { fills: [{ color: "#16a34a", type: "solid" }] },
      nodeId: "node_rectangle",
      screenId: "scr_roundtrip",
      type: "update-node",
    }],
  });
  const concurrent = JSON.parse(
    (await runCli(["apply", packagePath, "--batch", concurrentPath, "--json"])).stdout,
  );

  // The stale writer only renames, based on revision A.
  const staleIntentPath = join(root, "stale-intent.json");
  await writeJson(staleIntentPath, {
    baseRevision: base.revision,
    batchId: "batch_rv004c_stale",
    operations: [{
      changes: { name: "Recovered name" },
      nodeId: "node_rectangle",
      screenId: "scr_roundtrip",
      type: "update-node",
    }],
  });
  const stale = JSON.parse(
    (await runCli(["apply", packagePath, "--batch", staleIntentPath, "--json"])).stdout,
  );
  assert.equal(stale.error.code, "stale_revision");
  assert.equal(stale.error.details.baseRevision, base.revision);
  assert.equal(stale.error.details.actualRevision, concurrent.revision);

  // Execute the error's read command verbatim.
  const readArgv = stale.error.details.commands[0].argv;
  const current = JSON.parse((await runCli(readArgv)).stdout);
  assert.equal(current.revision, concurrent.revision);

  // Rebuild the intent file: baseRevision=B, NEW batchId, same operations.
  const rebuiltPath = join(root, "rebuilt-intent.json");
  await writeJson(rebuiltPath, {
    baseRevision: concurrent.revision,
    batchId: "batch_rv004c_rebuilt",
    operations: stale.error.details.remainingIntent,
  });
  // Only substitute the placeholder batch path in the returned apply argv.
  const replayArgv = stale.error.details.commands[1].argv.map(
    (part) => (part.startsWith("<") && part.endsWith(">") ? rebuiltPath : part),
  );
  assert.equal(replayArgv[0], "apply");
  const recovered = JSON.parse((await runCli(replayArgv)).stdout);
  assert.equal(recovered.batchId, "batch_rv004c_rebuilt");

  // Both the concurrent fill and the recovered rename survive.
  const final = JSON.parse((await runCli(["read", packagePath, "--json"])).stdout);
  const node =
    final.entries["screens/roundtrip.json"].presentations[0].nodes.node_rectangle;
  assert.equal(node.name, "Recovered name");
  assert.equal(node.fills[0].color, "#16a34a");
});

// RV-004-D: execute the token-removal recovery chain end to end using only the
// commands the error response returns.
test("token removal recovery chain executes returned argv (RV-004-D)", async () => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-rv004d-"));
  const packagePath = join(root, "p.smallpen");
  await cp(fixture, packagePath, { recursive: true });
  const base = JSON.parse((await runCli(["read", packagePath, "--json"])).stdout);

  const seedPath = join(root, "seed.json");
  await writeJson(seedPath, {
    baseRevision: base.revision,
    batchId: "batch_rv004d_seed",
    operations: [{
      definition: {
        $extensions: { smallpen: { id: "tok_rv004d", visibility: "public" } },
        $type: "number",
        $value: 16,
      },
      filePath: "tokens/rv004d.json",
      path: "space.tight",
      tokenId: "tok_rv004d",
      type: "put-token",
    }],
  });
  const seeded = JSON.parse(
    (await runCli(["apply", packagePath, "--batch", seedPath, "--json"])).stdout,
  );

  const bindPath = join(root, "bind.json");
  await writeJson(bindPath, {
    baseRevision: seeded.revision,
    batchId: "batch_rv004d_bind",
    operations: [{
      binding: { assetId: "tok_rv004d", packageId: "pkg_roundtrip" },
      field: "itemSpacing",
      nodeId: "node_rectangle",
      screenId: "scr_roundtrip",
      type: "set-token-binding",
    }],
  });
  const bound = JSON.parse(
    (await runCli(["apply", packagePath, "--batch", bindPath, "--json"])).stdout,
  );

  // Live removal is refused atomically.
  const removePath = join(root, "remove.json");
  await writeJson(removePath, {
    baseRevision: bound.revision,
    batchId: "batch_rv004d_remove",
    operations: [{ tokenId: "tok_rv004d", type: "remove-token" }],
  });
  const refused = JSON.parse(
    (await runCli(["apply", packagePath, "--batch", removePath, "--json"])).stdout,
  );
  assert.equal(refused.error.code, "missing_local_asset");
  const refusedCheck = JSON.parse((await runCli(["read", packagePath, "--json"])).stdout);
  assert.equal(refusedCheck.revision, bound.revision, "rejection writes nothing");

  // Execute the error's impact argv verbatim.
  const impactArgv = refused.error.details.commands[0].argv;
  const impact = JSON.parse((await runCli(impactArgv)).stdout);
  assert.ok(
    (impact.locations ?? []).some(
      (item) => item.nodeId === "node_rectangle" && item.field === "itemSpacing",
    ),
    `impact locates the live binding: ${JSON.stringify(impact.locations ?? impact)}`,
  );

  // Build the clear-token-binding batch the error describes.
  const clearPath = join(root, "clear.json");
  await writeJson(clearPath, {
    baseRevision: bound.revision,
    batchId: "batch_rv004d_clear",
    operations: [{
      field: "itemSpacing",
      nodeId: "node_rectangle",
      screenId: "scr_roundtrip",
      type: "clear-token-binding",
    }],
  });
  const clearArgv = refused.error.details.commands[1].argv.map(
    (part) => (part.startsWith("<") && part.endsWith(">") ? clearPath : part),
  );
  const cleared = JSON.parse((await runCli(clearArgv)).stdout);
  assert.ok(cleared.revision);

  // Retry the removal with a fresh batch id and the current revision.
  const final = JSON.parse((await runCli(["read", packagePath, "--json"])).stdout);
  const retryPath = join(root, "retry.json");
  await writeJson(retryPath, {
    baseRevision: final.revision,
    batchId: "batch_rv004d_retry",
    operations: [{ tokenId: "tok_rv004d", type: "remove-token" }],
  });
  const retried = JSON.parse(
    (await runCli(["apply", packagePath, "--batch", retryPath, "--json"])).stdout,
  );
  assert.ok(retried.revision);
  const done = JSON.parse((await runCli(["read", packagePath, "--json"])).stdout);
  const tokenEntry = done.entries["tokens/rv004d.json"];
  const tokenGone =
    tokenEntry === undefined ||
    tokenEntry.space?.tight === undefined ||
    (Array.isArray(tokenEntry.sets) &&
      tokenEntry.sets.every((set) => !set.tokens.some(({ id }) => id === "tok_rv004d")));
  assert.ok(tokenGone, "token removed after the recovery chain");
  assert.equal(
    done.entries["screens/roundtrip.json"].presentations[0].nodes.node_rectangle
      .tokenBindings?.itemSpacing,
    undefined,
    "binding was cleared before the retry",
  );
});
