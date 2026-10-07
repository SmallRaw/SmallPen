import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { applyOperationBatch, openPackage } from "@smallpen/local-package";
import { INIT_ANSWERS_EXAMPLE } from "../apps/cli/bin/schema.mjs";
import { discoverySummary } from "../apps/cli/bin/read-output.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "apps", "cli", "bin", "smallpen.mjs");
const roundtrip = join(here, "fixtures", "roundtrip.smallpen");
const components = join(here, "fixtures", "variant-button.smallpen");

async function run(args, expectedCode = 0) {
  // These semantic checks request complete values; file transport has its own integration tests.
  if (args.includes("--full") && !args.includes("--stdout"))
    args = [...args, "--stdout"];
  const child = spawn(process.execPath, [cli, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
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
    bytes: Buffer.byteLength(stdout),
    stdout,
    value: JSON.parse(stdout),
  };
}

async function copyFixture() {
  const root = await mkdtemp(join(tmpdir(), "smallpen-small-reply-"));
  const packagePath = join(root, "app.smallpen");
  await cp(roundtrip, packagePath, { recursive: true });
  return { packagePath, root };
}

async function revisionOf(path) {
  return (await openPackage(path)).revision;
}

test("a named element view returns exactly one element with its page and revision", async () => {
  const args = [
    "view",
    roundtrip,
    "--page",
    "Round Trip",
    "--element",
    "Editable Rectangle",
    "--json",
  ];
  const first = await run(args);
  const repeat = await run(args);
  assert.deepEqual(first.value, repeat.value);
  assert.equal(first.value.text, "Editable Rectangle · RECTANGLE 240×120 · literal fill");
  assert.equal(first.value.page.total, 1);
  assert.deepEqual(first.value.target, {
    page: "Round Trip",
    platform: "desktop",
    element: "Editable Rectangle",
  });
  assert.equal(first.value.selection.nodeId, undefined);
  assert.equal(first.value.selection.presentationId, undefined);
  assert.equal(first.value.revision, await revisionOf(roundtrip));
  assert.equal(first.value.runtime, undefined);
  assert.ok(first.bytes < 2048, `${first.bytes} bytes`);
});

test("component discovery omits node trees; a variant element can be viewed by name", async () => {
  const list = await run([
    "project",
    "list",
    components,
    "--kind",
    "components",
    "--limit",
    "1",
    "--json",
  ]);
  assert.equal(list.value.items[0].item.variantCount, 8);
  assert.equal(list.value.items[0].item.variants, undefined);
  const node = await run([
    "view",
    components,
    "--component",
    "Button",
    "--variant",
    "Style=primary, Size=sm",
    "--element",
    "Label",
    "--json",
  ]);
  assert.deepEqual(node.value.target, {
    component: "Button",
    variant: "Style=primary, Size=sm",
    element: "Label",
  });
  assert.equal(node.value.selection.nodeId, undefined);
  assert.equal(node.value.selection.variantId, undefined);
  assert.match(node.value.text, /Element in Style=primary, Size=sm:\nLabel · TEXT/);
  assert.equal(node.value.component.variants, undefined);
  assert.ok(node.bytes < 4096, `${node.bytes} bytes`);
});

test("directory replies are compact JSON with only public discovery fields", async () => {
  const brief = await run([
    "project",
    "list",
    components,
    "--kind",
    "components",
    "--json",
  ]);
  assert.equal(brief.stdout, `${JSON.stringify(brief.value)}\n`);
  assert.deepEqual(brief.value.items[0].item, {
    name: "Button",
    category: "Actions",
    variantCount: 8,
  });
  for (const argv of [
    ["component", "list", components],
    ["component", "search", components, "--query", "Button"],
    ["view", components, "--component", "Button"],
  ]) {
    const reply = await run([...argv, "--json"]);
    const item =
      reply.value.components?.[0] ??
      reply.value.items?.[0] ??
      reply.value.component;
    assert.equal(item.name, "Button");
    assert.equal(item.visibility, undefined);
    assert.equal(item.deprecated, undefined);
    assert.equal(reply.stdout, `${JSON.stringify(reply.value)}\n`);
  }
  const full = await run([
    "project",
    "list",
    components,
    "--kind",
    "components",
    "--full",
    "--json",
  ]);
  assert.equal(full.value.items[0].item.visibility, "public");
  assert.equal(full.value.items[0].item.deprecated, false);
  assert.ok(full.value.items[0].item.variants[0].nodes);
  assert.equal(full.stdout, `${JSON.stringify(full.value)}\n`);
});

test("the directory retains restrictions only when they affect reuse", async () => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-reuse-status-"));
  const path = join(root, "foundation.smallpen");
  await cp(components, path, { recursive: true });
  const stored = JSON.parse(
    await readFile(join(path, "components", "foundation.json"), "utf8"),
  ).componentSets[0];
  const restrict = async (changes) =>
    applyOperationBatch(path, {
      baseRevision: await revisionOf(path),
      batchId: `reuse-status-${Object.keys(changes).join("-")}`,
      operations: [
        { type: "put-component-set", componentSet: { ...stored, ...changes } },
      ],
    });
  await restrict({ visibility: "private" });
  const catalog = await run(["component", "list", path, "--json"]);
  assert.equal(catalog.value.components[0].visibility, "private");
  const search = await run([
    "component",
    "search",
    path,
    "--query",
    "Button",
    "--json",
  ]);
  assert.equal(search.value.items[0].visibility, "private");
  await restrict({ visibility: "private", deprecated: true });
  const list = await run(["project", "list", path, "--kind", "components", "--json"]);
  assert.equal(list.value.items[0].item.deprecated, true);
  assert.equal(list.value.items[0].item.visibility, "private");
});

test("internal object changes cannot add fields to the public directory", async () => {
  const item = {
    id: "cmp_future",
    name: "Future",
    visibility: "public",
    deprecated: false,
    description: "Read this description explicitly",
    rootId: "node_editor_root",
    viewport: { width: 640, height: 480, editorZoom: 2 },
    variants: [{ id: "var_future", nodes: { node_internal: {} } }],
    editorState: { open: true },
    internalCacheKey: "do-not-publish",
  };
  assert.deepEqual(discoverySummary(item), {
    id: "cmp_future",
    name: "Future",
    viewport: { width: 640, height: 480 },
    variantCount: 1,
  });
  const restricted = discoverySummary({
    ...item,
    deprecated: true,
    replacement: {
      packageId: "pkg_library",
      assetId: "cmp_new",
      editorKey: "private",
    },
  });
  assert.equal(restricted.deprecated, true);
  assert.deepEqual(restricted.replacement, {
    packageId: "pkg_library",
    assetId: "cmp_new",
  });
  const schema = await run(["schema", "command", "list", "--json"]);
  assert.equal(schema.value.output.encoding, "compact-json");
  assert.ok(schema.value.output.itemFields.includes("variantCount"));
  assert.ok(!schema.value.output.itemFields.includes("rootId"));
  assert.match(
    schema.value.output.conditionalItemFields.deprecated,
    /Only true/,
  );
});

test("tokens paginate by default and catalog does not repeat inventory and values", async () => {
  const tokens = await run([
    "token",
    "list",
    components,
    "--limit",
    "2",
    "--offset",
    "1",
    "--json",
  ]);
  assert.equal(tokens.value.items.length, 2);
  assert.equal(tokens.value.page.offset, 1);
  assert.ok(tokens.value.page.total > 2);
  assert.equal(tokens.value.page.hasMore, true);
  assert.equal(tokens.value.items[0].token.contextValues, undefined);
  const catalog = await run(["component", "list", components, "--json"]);
  assert.equal(catalog.value.tokenInventory, undefined);
  assert.equal(catalog.value.effectiveTokens, undefined);
  // Variants are named by their labels, never repeated as node trees.
  assert.deepEqual(catalog.value.components[0].variants.slice(0, 2), [
    "Style=primary, Size=sm",
    "Style=primary, Size=md",
  ]);
  assert.ok(
    catalog.value.components[0].variants.every(
      (label) => typeof label === "string",
    ),
  );
  assert.ok(catalog.bytes < 4096);
});

test("page views paginate one outline instead of repeating the projection", async () => {
  const view = await run([
    "view",
    roundtrip,
    "--page",
    "Round Trip",
    "--limit",
    "1",
    "--json",
  ]);
  assert.equal(view.value.text, "Canvas · FRAME 800×600 · 1 item · literal fill");
  assert.equal(view.value.page.total, 2);
  assert.equal(view.value.page.hasMore, true);
  for (const key of ["nodes", "presentation", "screen", "components", "tokens"])
    assert.equal(view.value[key], undefined);
  const rest = await run([
    "view",
    roundtrip,
    "--page",
    "Round Trip",
    "--offset",
    "1",
    "--json",
  ]);
  assert.equal(rest.value.text.trim(), "Editable Rectangle · RECTANGLE 240×120 · literal fill");
  assert.equal(rest.value.page.hasMore, false);
});

test("default write confirmations save exact undo and remain idempotent across processes", async () => {
  const { packagePath, root } = await copyFixture();
  const batchPath = join(root, "batch.json");
  await writeFile(
    batchPath,
    JSON.stringify({
      baseRevision: await revisionOf(packagePath),
      batchId: "small-reply-retry",
      operations: [
        {
          type: "update-node",
          screenId: "scr_roundtrip",
          nodeId: "node_rectangle",
          changes: { name: "Renamed" },
        },
      ],
    }),
  );
  const first = await run([
    "advanced",
    "apply",
    packagePath,
    "--batch",
    batchPath,
    "--json",
  ]);
  assert.ok(first.bytes < 4096);
  assert.equal(first.value.changed, true);
  assert.equal(first.value.inverseBatch, undefined);
  const inverse = JSON.parse(
    await readFile(first.value.inverseBatchPath, "utf8"),
  );
  assert.equal(inverse.baseRevision, first.value.revision);
  assert.equal(inverse.operations[0].changes.name, "Editable Rectangle");
  const repeat = await run([
    "advanced",
    "apply",
    packagePath,
    "--batch",
    batchPath,
    "--json",
  ]);
  assert.equal(repeat.value.batchId, first.value.batchId);
  assert.equal(repeat.value.revision, first.value.revision);
  assert.equal(repeat.value.alreadyApplied, true);
  assert.equal(repeat.value.changed, false);
  assert.notEqual(repeat.value.inverseBatchPath, first.value.inverseBatchPath);
  assert.deepEqual(
    await readFile(repeat.value.inverseBatchPath),
    await readFile(first.value.inverseBatchPath),
  );
});

test("high-level retries, no-op and dry-run keep their confirmation fields", async () => {
  const { packagePath, root } = await copyFixture();
  const intentPath = join(root, "intent.json");
  await writeFile(
    intentPath,
    JSON.stringify({
      tokens: [{ name: "color.new", type: "color", value: "#abcdef" }],
    }),
  );
  const args = [
    "token",
    "set",
    packagePath,
    "--intent",
    intentPath,
    "--batch-id",
    "small-token-retry",
    "--json",
  ];
  const first = await run(args);
  assert.equal(first.value.changed, true);
  assert.equal(first.value.alreadyApplied, false);
  const repeat = await run(args);
  assert.equal(repeat.value.alreadyApplied, true);
  assert.equal(repeat.value.changed, false);
  assert.equal(repeat.value.batchId, first.value.batchId);
  assert.equal(repeat.value.revision, first.value.revision);
  assert.equal(await revisionOf(packagePath), first.value.revision);
  const batchPath = join(root, "no-op.json");
  await writeFile(
    batchPath,
    JSON.stringify({
      baseRevision: first.value.revision,
      batchId: "small-no-op",
      operations: [
        {
          type: "update-node",
          screenId: "scr_roundtrip",
          nodeId: "node_rectangle",
          changes: { width: 240 },
        },
      ],
    }),
  );
  const preview = await run([
    "advanced",
    "apply",
    packagePath,
    "--batch",
    batchPath,
    "--dry-run",
    "--json",
  ]);
  assert.equal(preview.value.dryRun, true);
  assert.equal(preview.value.changed, false);
  assert.equal(preview.value.noChange.code, "no_change");
  assert.equal(preview.value.inverseBatchPath, undefined);
  const noop = await run([
    "advanced",
    "apply",
    packagePath,
    "--batch",
    batchPath,
    "--json",
  ]);
  assert.equal(noop.value.changed, false);
  assert.equal(noop.value.noChange.code, "no_change");
});

test("images are artifacts by default; inline bytes are an explicit request", async () => {
  const png = ["export", roundtrip, "--page", "Round Trip", "--format", "png"];
  const image = await run([...png, "--json"]);
  assert.equal(image.value.imageBase64, undefined);
  assert.ok(image.bytes < 4096);
  const bytes = await readFile(image.value.output);
  assert.equal(bytes.subarray(1, 4).toString(), "PNG");
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    image.value.renderHash,
  );
  const inline = await run([...png, "--base64", "--json"]);
  assert.equal(
    Buffer.from(inline.value.imageBase64, "base64").subarray(1, 4).toString(),
    "PNG",
  );
  assert.equal(inline.value.renderHash, image.value.renderHash);
  const viewed = await run([
    "view",
    roundtrip,
    "--page",
    "Round Trip",
    "--as",
    "png",
    "--json",
  ]);
  assert.equal(viewed.value.imageBase64, undefined);
  assert.equal(viewed.value.renderHash, image.value.renderHash);
});

test("explicit complete legacy brief import retains package identities without question state", async () => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-init-receipt-"));
  const answersPath = join(root, "answers.json");
  const workspace = join(root, "workspace");
  const answers = { ...INIT_ANSWERS_EXAMPLE, purpose: "x".repeat(20_000) };
  await writeFile(answersPath, JSON.stringify(answers));
  const initialized = await run([
    "project",
    "init",
    workspace,
    "--answers",
    answersPath,
    "--json",
  ]);
  assert.equal(initialized.value.statePath, undefined);
  assert.equal(initialized.value.nextQuestion, undefined);
  assert.ok(initialized.bytes <= 16_384);
  assert.equal(initialized.value.status, "initialized");
  assert.equal(typeof initialized.value.packages?.package?.path, "string");
  assert.equal(typeof initialized.value.packages.package.revision, "string");
  // The default reply names the package by path; IDs stay in the package.
  assert.equal(initialized.value.packages.package.packageId, undefined);
  assert.equal(initialized.value.start.screenId, undefined);
  const stored = await openPackage(initialized.value.packages.package.path);
  assert.match(stored.manifest.packageId, /^pkg_/);
  assert.equal(stored.revision, initialized.value.packages.package.revision);
  const fullWorkspace = join(root, "full-workspace");
  const full = await run([
    "project",
    "init",
    fullWorkspace,
    "--answers",
    answersPath,
    "--full",
    "--json",
  ]);
  const fullStored = await openPackage(full.value.packages.package.path);
  assert.equal(
    full.value.packages.package.packageId,
    fullStored.manifest.packageId,
  );
  const storedScreenIds = Object.entries(fullStored.entries)
    .filter(([file]) => file.startsWith("screens/"))
    .map(([, screen]) => screen.id);
  assert.ok(storedScreenIds.includes(full.value.start.screenId));
});

test("evidence uses unique files and retains earlier dependency revisions for 30 minutes", async () => {
  const { packagePath, root } = await copyFixture();
  const libraryPath = join(root, "library.smallpen");
  await cp(roundtrip, libraryPath, { recursive: true });
  const libraryManifestPath = join(libraryPath, "manifest.json");
  const libraryManifest = JSON.parse(
    await readFile(libraryManifestPath, "utf8"),
  );
  libraryManifest.packageId = "pkg_receipt_library";
  await writeFile(libraryManifestPath, JSON.stringify(libraryManifest));
  const manifestPath = join(packagePath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.libraries = [
    {
      packageId: libraryManifest.packageId,
      source: { type: "local", path: "library.smallpen" },
    },
  ];
  await writeFile(manifestPath, JSON.stringify(manifest));

  const evidence = [
    "export",
    packagePath,
    "--page",
    "Round Trip",
    "--format",
    "png",
    "--evidence",
    "--json",
  ];
  const first = await run(evidence);
  const firstBytes = await readFile(first.value.evidencePath);
  assert.match(
    basename(first.value.evidencePath),
    /^smallpen-\d{13}-[a-f0-9-]{36}-evidence\.json$/,
  );
  libraryManifest.name = "Library with new metadata";
  await writeFile(libraryManifestPath, JSON.stringify(libraryManifest));
  const second = await run(evidence);
  assert.equal(second.value.renderHash, first.value.renderHash);
  assert.notEqual(
    second.value.libraryRevisions.pkg_receipt_library,
    first.value.libraryRevisions.pkg_receipt_library,
  );
  assert.notEqual(second.value.evidencePath, first.value.evidencePath);
  assert.notDeepEqual(await readFile(second.value.evidencePath), firstBytes);
  assert.deepEqual(await readFile(first.value.evidencePath), firstBytes);
});

test("schema exposes one stable contract revision without repeating it in package summaries", async () => {
  const index = await run(["schema", "--json"]);
  const detail = await run(["schema", "operation", "update-node", "--json"]);
  assert.match(index.value.contractRevision, /^[a-f0-9]{64}$/);
  assert.equal(index.value.contractRevision, detail.value.contractRevision);
  const view = await run(["view", roundtrip, "--page", "Round Trip", "--json"]);
  assert.equal(view.value.formatCapabilities, undefined);
  assert.equal(view.value.contractRevision, undefined);
  assert.equal(view.value.revision, await revisionOf(roundtrip));
});

test("a large individual target cannot exceed the default output budget", async () => {
  const { packagePath } = await copyFixture();
  const screenPath = join(packagePath, "screens", "roundtrip.json");
  const screen = JSON.parse(await readFile(screenPath, "utf8"));
  screen.presentations[0].nodes.node_rectangle.name = "Large name ".repeat(
    10_000,
  );
  await writeFile(screenPath, JSON.stringify(screen));
  const name = screen.presentations[0].nodes.node_rectangle.name;
  for (const as of ["text", "wireframe"]) {
    const brief = await run([
      "view",
      packagePath,
      "--page",
      "Round Trip",
      "--as",
      as,
      "--json",
    ]);
    assert.ok(brief.bytes <= 16_384, `${as}: ${brief.bytes} bytes`);
    assert.equal(brief.value.outputDetail.omitted, true);
    assert.equal(brief.value.target.page, "Round Trip");
    assert.equal(brief.value.target.platform, "desktop");
    assert.equal(brief.value.selection.screenId, undefined);
    const detail = JSON.parse(
      await readFile(brief.value.resultFile.path, "utf8"),
    );
    assert.ok(detail[as].includes(name), `${as} keeps the complete name`);
  }
  const element = await run([
    "view",
    packagePath,
    "--page",
    "Round Trip",
    "--element",
    name,
    "--json",
  ]);
  assert.ok(element.bytes <= 16_384);
  assert.equal(element.value.outputDetail.omitted, true);
  const detail = JSON.parse(
    await readFile(element.value.resultFile.path, "utf8"),
  );
  // The saved result names the element like the reply does.
  assert.equal(detail.target.element, name);
  assert.equal(detail.target.page, "Round Trip");
  assert.equal(detail.selection.nodeId, undefined);
  assert.ok(detail.text.includes(name));
});

test("default diff lists changed fields; exact before/after values require --full", async () => {
  const { packagePath, root } = await copyFixture();
  const before = { revision: await revisionOf(packagePath) };
  const path = join(root, "preview.json");
  await writeFile(
    path,
    JSON.stringify({
      baseRevision: before.revision,
      batchId: "small-diff",
      operations: [
        {
          type: "update-node",
          screenId: "scr_roundtrip",
          nodeId: "node_rectangle",
          changes: { width: 280 },
        },
      ],
    }),
  );
  const args = ["advanced", "apply", packagePath, "--batch", path, "--explain", "--json"];
  const brief = await run(args);
  assert.equal(brief.value.dryRun, true);
  assert.ok(brief.value.diff[0].fields.includes("presentations"));
  assert.equal(brief.value.diff[0].changes, undefined);
  const full = await run([...args, "--full"]);
  assert.ok(full.value.diff[0].changes.presentations.before);
  assert.equal(await revisionOf(packagePath), before.revision);
});

test("an undo export failure keeps the committed identity and provides a safe retry", async () => {
  const { packagePath, root } = await copyFixture();
  const batchPath = join(root, "write.json");
  await writeFile(
    batchPath,
    JSON.stringify({
      baseRevision: await revisionOf(packagePath),
      batchId: "undo-export-failure",
      operations: [
        {
          type: "update-node",
          screenId: "scr_roundtrip",
          nodeId: "node_rectangle",
          changes: { width: 280 },
        },
      ],
    }),
  );
  const blocked = join(root, "not-a-directory");
  await writeFile(blocked, "file");
  const confirmed = await run([
    "advanced",
    "apply",
    packagePath,
    "--batch",
    batchPath,
    "--inverse-out",
    join(blocked, "undo.json"),
    "--json",
  ]);
  assert.equal(confirmed.value.changed, true);
  assert.equal(confirmed.value.undoError.code, "inverse_output_failed");
  const retry = await run(confirmed.value.undoError.nextOperations[0].argv);
  assert.equal(retry.value.alreadyApplied, true);
  assert.equal(retry.value.changed, false);
  assert.equal(retry.value.revision, confirmed.value.revision);
  assert.ok(retry.value.inverseBatch);
});

test("component views page their outline and select one variant by name", async () => {
  const page = await run([
    "view",
    components,
    "--component",
    "Button",
    "--limit",
    "1",
    "--json",
  ]);
  assert.equal(page.value.text.split("\n").length, 1);
  assert.equal(page.value.page.total, 6);
  assert.equal(page.value.page.hasMore, true);
  assert.equal(page.value.component.variantCount, 8);
  assert.equal(page.value.component.variants, undefined);
  const variant = await run([
    "view",
    components,
    "--component",
    "Button",
    "--variant",
    "Style=secondary, Size=md",
    "--json",
  ]);
  assert.equal(variant.value.target.variant, "Style=secondary, Size=md");
  assert.equal(variant.value.selection.variantId, undefined);
  assert.match(
    variant.value.text,
    /Structure of Style=secondary, Size=md:\nButton · COMPONENT 112×40/,
  );
  const paths = (reply) => reply.value.tokenSources.map(({ path }) => path);
  assert.ok(paths(variant).includes("color.bg.surface"));
  assert.ok(!paths(variant).includes("color.brand.base"));
  assert.ok(paths(page).includes("color.brand.base"));
});

test("Token import reviews report bounded differences rather than the entire replacement library", async () => {
  const { packagePath, root } = await copyFixture();
  const input = join(root, "tokens.json");
  await writeFile(
    input,
    JSON.stringify(
      Object.fromEntries(
        Array.from({ length: 80 }, (_, index) => [
          `color_${index}`,
          { $type: "color", $value: "#abcdef" },
        ]),
      ),
    ),
  );
  const preview = await run([
    "token",
    "import",
    packagePath,
    "--input",
    input,
    "--json",
  ]);
  assert.ok(preview.bytes < 8192);
  assert.equal(preview.value.dryRun, true);
  assert.equal(preview.value.library.tokenCount, 80);
  assert.equal(preview.value.diff.tokens.added.total, 80);
  assert.equal(preview.value.diff.tokens.added.items.length, 20);
  assert.equal(preview.value.library.sets, undefined);
});

test("named views reject inherited object keys as missing targets", async () => {
  for (const [argv, code] of [
    [["view", roundtrip, "--page", "__proto__"], "unknown_page"],
    [
      ["view", roundtrip, "--page", "Round Trip", "--element", "__proto__"],
      "unknown_element",
    ],
    [["view", components, "--component", "__proto__"], "unknown_component"],
    [
      ["view", components, "--component", "Button", "--variant", "__proto__"],
      "unknown_variant",
    ],
  ]) {
    const result = await run([...argv, "--json"], 1);
    assert.equal(result.value.error.code, code, argv.join(" "));
    assert.equal(result.value.error.writeState, "not-applied");
  }
});

test("import retries keep the same confirmed batch identity", async () => {
  const { packagePath, root } = await copyFixture();
  const input = join(root, "tokens.json");
  await writeFile(
    input,
    JSON.stringify({ color: { brand: { $type: "color", $value: "#abcdef" } } }),
  );
  const args = [
    "token",
    "import",
    packagePath,
    "--input",
    input,
    "--apply",
    "--batch-id",
    "small-import-retry",
    "--json",
  ];
  const first = await run(args);
  const repeat = await run(args);
  assert.equal(repeat.value.alreadyApplied, true);
  assert.equal(repeat.value.changed, false);
  assert.equal(repeat.value.revision, first.value.revision);
  assert.equal(repeat.value.batchId, first.value.batchId);
});
