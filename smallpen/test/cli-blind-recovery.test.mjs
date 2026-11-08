import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { openPackage } from "@smallpen/local-package";
import { componentEntry, onlyScreen, pageHtml, seedLegacyIds } from "./helpers/named.mjs";

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

// A Round Trip page holding count - 1 rectangles, written as its file.
async function fixture(count = 2, nameLength = 0) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-blind-recovery-"));
  const packagePath = join(root, "app.smallpen");
  await cp(join(here, "fixtures/roundtrip.smallpen"), packagePath, {
    recursive: true,
  });
  const items = [];
  for (let index = 1; index < count; index += 1) {
    items.push(`  <div data-shape="rectangle" data-name="Item ${index} ${"x".repeat(nameLength)}" class="left-[80px] top-[96px] w-[240px] h-[120px] bg-[#7c3aed]"></div>`);
  }
  await writeFile(
    join(packagePath, "pages", "Round Trip.html"),
    pageHtml(`<body data-name="Canvas" class="w-[800px] h-[600px] bg-[#f4f4f5]">\n${items.join("\n")}\n</body>`, { title: "Round Trip" }),
  );
  return { root, packagePath };
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

