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
import { renameInPage, seedLegacyIds } from "./helpers/named.mjs";

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
  await seedLegacyIds(packagePath, "roundtrip");
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

test("tokens paginate by default", async () => {
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
  assert.equal(view.value.text, "Canvas · FRAME 800×600 · 1 item · literal fill\n… 1 more line: add --offset 1");
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

test("evidence uses unique files and keeps earlier evidence for 30 minutes", async () => {
  const { packagePath } = await copyFixture();
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
  // A rename changes the revision but not the pixels.
  await renameInPage(packagePath, "Round Trip.html", "Editable Rectangle", "Renamed Rectangle");
  const second = await run(evidence);
  assert.equal(second.value.renderHash, first.value.renderHash);
  assert.notEqual(second.value.evidencePath, first.value.evidencePath);
  assert.notDeepEqual(await readFile(second.value.evidencePath), firstBytes);
  assert.deepEqual(await readFile(first.value.evidencePath), firstBytes);
});

test("schema exposes one stable contract revision without repeating it in package summaries", async () => {
  const index = await run(["schema", "--json"]);
  const detail = await run(["schema", "command", "view", "--json"]);
  assert.match(index.value.contractRevision, /^[a-f0-9]{64}$/);
  assert.equal(index.value.contractRevision, detail.value.contractRevision);
  const view = await run(["view", roundtrip, "--page", "Round Trip", "--json"]);
  assert.equal(view.value.formatCapabilities, undefined);
  assert.equal(view.value.contractRevision, undefined);
  assert.equal(view.value.revision, await revisionOf(roundtrip));
});

test("a large individual target cannot exceed the default output budget", async () => {
  const { packagePath } = await copyFixture();
  const name = "Large name ".repeat(10_000).trim();
  await renameInPage(packagePath, "Round Trip.html", "Editable Rectangle", name);
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
    assert.ok(detail.text.includes(name), `${as} keeps the complete name`);
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
  assert.equal(page.value.text.split("\n").length, 2);
  assert.match(page.value.text, /\n… 5 more lines: add --offset 1$/);
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
    "Style: secondary; Size: md",
    "--json",
  ]);
  assert.equal(variant.value.target.variant, "Style: secondary; Size: md");
  assert.equal(variant.value.selection.variantId, undefined);
  assert.match(
    variant.value.text,
    /Structure of Style: secondary; Size: md:\nButton · COMPONENT 112×40/,
  );
  const paths = (reply) => reply.value.tokenSources.map(({ path }) => path);
  assert.ok(paths(variant).includes("color-bg-surface"));
  assert.ok(!paths(variant).includes("color-brand-base"));
  assert.ok(paths(page).includes("color-brand-base"));
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

