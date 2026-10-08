import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { openPackage } from "@smallpen/local-package";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../apps/cli/bin/smallpen.mjs");
const components = join(here, "fixtures/variant-button.smallpen");

async function run(argv, expectedCode = 0, env) {
  // Schema and full-value checks opt into stdout; fixed-file transport is tested separately.
  if (
    (argv[0] === "schema" || argv.includes("--full")) &&
    !argv.includes("--stdout")
  )
    argv = [...argv, "--stdout"];
  const child = spawn(process.execPath, [cli, ...argv], {
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, expectedCode, stdout || stderr);
  return {
    stdout,
    bytes: Buffer.byteLength(stdout),
    value: JSON.parse(stdout),
  };
}

async function fixture(count = 2, nameLength = 0) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-blind-recovery-"));
  const packagePath = join(root, "app.smallpen");
  await cp(join(here, "fixtures/roundtrip.smallpen"), packagePath, {
    recursive: true,
  });
  const entry = join(packagePath, "screens/roundtrip.json");
  const screen = JSON.parse(await readFile(entry, "utf8"));
  const presentation = screen.presentations[0];
  const rectangle = presentation.nodes.node_rectangle;
  presentation.nodes = { node_canvas: presentation.nodes.node_canvas };
  presentation.nodes.node_canvas.children = [];
  for (let index = 1; index < count; index += 1) {
    const id = `node_item_${index}`;
    presentation.nodes[id] = {
      ...rectangle,
      id,
      name: `Item ${index} ${"x".repeat(nameLength)}`,
    };
    presentation.nodes.node_canvas.children.push(id);
  }
  await writeFile(entry, JSON.stringify(screen));
  return { root, packagePath, screen };
}

test("full view reads honor explicit pagination", async () => {
  const { packagePath } = await fixture(90);
  const argv = ["view", packagePath, "--page", "Round Trip", "--json"];
  const brief = await run(argv);
  const full = await run([...argv, "--full"]);
  assert.equal(full.stdout, `${JSON.stringify(full.value)}\n`);
  // 80 lines, then one line that says what is left and how to read it.
  const briefLines = brief.value.text.split("\n");
  assert.equal(briefLines.length, 81);
  assert.equal(briefLines.at(-1), "… 10 more lines: add --offset 80");
  assert.equal(brief.value.page.hasMore, true);
  assert.equal(brief.value.page.total, 90);
  const lines = full.value.text.split("\n");
  assert.equal(lines.length, 90);
  assert.equal(full.value.page.limit, 90);
  assert.equal(full.value.page.hasMore, false);
  assert.match(lines[0], /^Canvas · FRAME/);
  assert.ok(lines.slice(1).every((line) => line.startsWith("  Item ")));
  const page = await run([...argv, "--full", "--limit", "3", "--offset", "2"]);
  const paged = page.value.text.split("\n");
  assert.equal(paged.length, 4);
  assert.match(paged[3], /^… 85 more lines: add --offset 5$/);
  assert.match(paged[0], /Item 2 /);
  assert.equal(page.value.page.offset, 2);
  assert.equal(page.value.page.hasMore, true);
});

test("over-budget view saves complete selected data without another large CLI query", async () => {
  const { packagePath } = await fixture(50, 600);
  const argv = [
    "view",
    packagePath,
    "--page",
    "Round Trip",
    "--limit",
    "100",
    "--offset",
    "2",
    "--json",
  ];
  const reply = await run(argv);
  assert.ok(reply.value.outputDetail.omitted);
  assert.ok(reply.bytes <= 16384);
  const complete = JSON.parse(
    await readFile(reply.value.resultFile.path, "utf8"),
  );
  assert.equal(complete.text.split("\n").length, 48);
  assert.deepEqual(complete.target, {
    page: "Round Trip",
    platform: "desktop",
  });
  assert.equal(complete.selection.presentationId, undefined);
  assert.equal(complete.page.offset, 2);
});

test("structural component edit errors lead to the replacement schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-blind-structure-"));
  const packagePath = join(root, "components.smallpen");
  await cp(components, packagePath, { recursive: true });
  const before = await openPackage(packagePath);
  const batchPath = join(root, "batch.json");
  await writeFile(
    batchPath,
    JSON.stringify({
      baseRevision: before.revision,
      batchId: "blind-children",
      operations: [
        {
          type: "update-component-node",
          componentId: "cmp_button",
          variantId: "var_button_primary_sm",
          nodeId: "node_button_root",
          changes: { children: [] },
        },
      ],
    }),
  );
  const rejected = await run(
    ["advanced", "apply", packagePath, "--batch", batchPath, "--dry-run", "--json"],
    1,
  );
  assert.equal(rejected.value.error.code, "unsupported_node_change");
  const details = rejected.value.error.details;
  assert.equal(details.recoveryOperation, "put-variant");
  assert.equal(details.componentId, "cmp_button");
  assert.equal(details.variantId, "var_button_primary_sm");
  assert.ok(
    !details.nextOperations.some((op) => op.operation === "smallpen.read"),
  );
  const schema = await run(
    details.nextOperations.find((op) => op.operation === "smallpen.schema")
      .argv,
  );
  assert.equal(schema.value.type, "put-variant");
  const variant = structuredClone(
    before.entries["components/foundation.json"].componentSets
      .find((set) => set.id === details.componentId)
      .variants.find((item) => item.id === details.variantId),
  );
  assert.ok(variant.nodes.node_button_label);
  assert.equal((await openPackage(packagePath)).revision, before.revision);
  variant.nodes.node_marker = {
    ...variant.nodes.node_button_label,
    id: "node_marker",
    text: "Marker",
  };
  variant.nodes.node_button_root.children.push("node_marker");
  await writeFile(
    batchPath,
    JSON.stringify({
      baseRevision: before.revision,
      batchId: "blind-recovered-children",
      operations: [
        {
          type: "put-variant",
          componentId: "cmp_button",
          variant,
        },
      ],
    }),
  );
  await run([
    "advanced",
    "apply",
    packagePath,
    "--batch",
    batchPath,
    "--dry-run",
    "--json",
  ]);
  assert.equal((await openPackage(packagePath)).revision, before.revision);
});

test("structural presentation errors point to the parent and reorder operation", async () => {
  const { root, packagePath } = await fixture(3);
  const before = await openPackage(packagePath);
  const batchPath = join(root, "order.json");
  await writeFile(
    batchPath,
    JSON.stringify({
      baseRevision: before.revision,
      batchId: "blind-order-invalid",
      operations: [
        {
          type: "update-node",
          screenId: "scr_roundtrip",
          nodeId: "node_canvas",
          changes: { children: [] },
        },
      ],
    }),
  );
  const rejected = await run(
    ["advanced", "apply", packagePath, "--batch", batchPath, "--dry-run", "--json"],
    1,
  );
  const details = rejected.value.error.details;
  assert.equal(details.recoveryOperation, "reorder-presentation-children");
  assert.equal(details.nodeId, "node_canvas");
  assert.equal(details.screenId, "scr_roundtrip");
  assert.equal(details.presentationId, "pres_desktop");
  assert.equal(
    (
      await run(
        details.nextOperations.find((op) => op.operation === "smallpen.schema")
          .argv,
      )
    ).value.type,
    "reorder-presentation-children",
  );
  const parentChildren = (pkg) =>
    pkg.entries["screens/roundtrip.json"].presentations.find(
      (item) => item.id === details.presentationId,
    ).nodes[details.nodeId].children;
  const children = parentChildren(before);
  assert.deepEqual(children, ["node_item_1", "node_item_2"]);
  await writeFile(
    batchPath,
    JSON.stringify({
      baseRevision: before.revision,
      batchId: "blind-order-recovered",
      operations: [
        {
          type: details.recoveryOperation,
          screenId: details.screenId,
          presentationId: details.presentationId,
          parentId: details.nodeId,
          childIds: [...children].reverse(),
        },
      ],
    }),
  );
  await run(["advanced", "apply", packagePath, "--batch", batchPath, "--json"]);
  assert.deepEqual(
    parentChildren(await openPackage(packagePath)),
    [...children].reverse(),
  );
  const view = await run(["view", packagePath, "--page", "Round Trip", "--json"]);
  const lines = view.value.text.split("\n");
  assert.ok(
    lines.findIndex((line) => line.includes("Item 2")) <
      lines.findIndex((line) => line.includes("Item 1")),
  );
});

test("layout schema example produces its stated order and fill sizes", async () => {
  const schema = (await run(["schema", "node", "--json"])).value;
  assert.deepEqual(schema.layout.values["layout-item-h-sizing"], [
    "fill",
    "fix",
    "auto",
  ]);
  assert.match(schema.layout.childOrder, /last child/);
  assert.match(schema.changes, /children/);
  const { root, packagePath, screen } = await fixture();
  screen.presentations[0].nodes = schema.layout.example.nodes;
  screen.presentations[0].rootId = schema.layout.example.rootId;
  const batchPath = join(root, "layout.json");
  const before = await openPackage(packagePath);
  await writeFile(
    batchPath,
    JSON.stringify({
      baseRevision: before.revision,
      batchId: "blind-layout",
      operations: [{ type: "put-screen", screen }],
    }),
  );
  await run(["advanced", "apply", packagePath, "--batch", batchPath, "--json"]);
  const view = (
    await run(["view", packagePath, "--page", "Round Trip", "--json"])
  ).value;
  // The last child comes first in the row; the fill child takes the rest:
  // 320 - 16 padding - 80 fixed - 12 gap - 16 padding = 196.
  const lines = view.text.split("\n");
  assert.match(lines[0], /^Row · FRAME 320×80 · row layout/);
  assert.match(lines[1], /First, fixed · RECTANGLE 80×48/);
  assert.match(lines[2], /Second, fill · RECTANGLE 196×48/);
  const fill = (
    await run([
      "view",
      packagePath,
      "--page",
      "Round Trip",
      "--element",
      "Second, fill",
      "--json",
    ])
  ).value;
  assert.equal(fill.target.element, "Second, fill");
  assert.equal(fill.selection.nodeId, undefined);
  assert.match(fill.text, /196×48/);
  // The named element is the stored node from the schema example.
  const stored = (await openPackage(packagePath)).entries[
    "screens/roundtrip.json"
  ].presentations[0].nodes;
  assert.equal(stored.node_fill.name, "Second, fill");
  assert.equal(stored.node_fill["layout-item-h-sizing"], "fill");
});
