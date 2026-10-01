import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, cp, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { COMMAND_NAMES } from "../apps/cli/bin/help.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "apps", "cli", "bin", "smallpen-check.cjs");
const fixture = join(here, "fixtures", "roundtrip.smallpen");
const jpegPath = join(here, "fixtures", "quadrant.jpg");

function runCli(args, env = {}, cwd = undefined) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: { ...process.env, ...env },
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

async function json(args, env) {
  const result = await runCli(args, env);
  assert.equal(result.code, 0, result.stdout);
  return JSON.parse(result.stdout);
}

async function failure(args, code) {
  const result = await runCli(args);
  assert.equal(result.code, 1, result.stdout);
  const { error } = JSON.parse(result.stdout);
  assert.equal(error.code, code, result.stdout);
  return error;
}

async function packageCopy(context, name = "app.smallpen") {
  const root = await mkdtemp(join(tmpdir(), "smallpen-cli-contract-"));
  context.after(async () => {
    await chmod(root, 0o755).catch(() => {});
    await rm(root, { force: true, recursive: true });
  });
  const packagePath = join(root, name);
  await cp(fixture, packagePath, { recursive: true });
  return { packagePath, root };
}

const canDropWriteAccess =
  process.platform !== "win32" && process.getuid?.() !== 0;

test("reads succeed on a read-only location and writes fail typed", {
  skip: !canDropWriteAccess,
}, async (context) => {
  const { packagePath, root } = await packageCopy(context);
  const { revision } = await json(["validate", packagePath, "--json"]);
  // No lock directory exists yet and none can be created.
  await rm(join(root, ".app.smallpen.write-lock"), { force: true, recursive: true });
  await chmod(root, 0o555);

  for (const command of ["validate", "inspect", "read", "render"]) {
    const result = await runCli([command, packagePath, "--json"]);
    assert.equal(result.code, 0, `${command}: ${result.stdout}`);
  }
  const batchPath = join(tmpdir(), `smallpen-ro-${process.pid}-${Date.now()}.json`);
  context.after(() => rm(batchPath, { force: true }));
  await writeFile(batchPath, JSON.stringify({
    baseRevision: revision,
    batchId: "batch_read_only",
    operations: [{
      node: {
        children: [], height: 20, id: "node_read_only", name: "Read only",
        type: "RECTANGLE", width: 20, x: 10, y: 10,
      },
      parentId: "node_canvas",
      presentationId: "pres_desktop",
      screenId: "scr_roundtrip",
      type: "add-presentation-node",
    }],
  }));
  const preview = await json(["apply", packagePath, "--batch", batchPath, "--dry-run", "--json"]);
  assert.equal(preview.dryRun, true);
  const error = await failure(
    ["apply", packagePath, "--batch", batchPath, "--json"],
    "package_not_writable",
  );
  assert.equal(error.details.packagePath, await realpath(packagePath));
  assert.deepEqual(await readdir(root), ["app.smallpen"]);
});

test("reading a mistyped package path creates nothing", async (context) => {
  const { root } = await packageCopy(context);
  await failure(
    ["inspect", join(root, "typo", "nested", "app.smallpen"), "--json"],
    "invalid_package_path",
  );
  await failure(["read", join(root, "missing.smallpen"), "--json"], "invalid_package_path");
  assert.deepEqual(await readdir(root), ["app.smallpen"]);
});

test("list order and pages do not depend on the host locale", async (context) => {
  const { packagePath, root } = await packageCopy(context);
  const intentPath = join(root, "tokens.json");
  await writeFile(intentPath, JSON.stringify({
    operations: ["tok_aa", "tok_ab", "tok_b"].map((tokenId) => ({
      definition: {
        $extensions: { smallpen: { id: tokenId, visibility: "public" } },
        $type: "number",
        $value: 16,
      },
      filePath: "tokens/local.json",
      path: `space.${tokenId}`,
      tokenId,
      type: "put-token",
    })),
  }));
  await json(["token", packagePath, "--intent", intentPath, "--json"]);
  const outputs = [];
  for (const locale of ["en_US.UTF-8", "da_DK.UTF-8", "tr_TR.UTF-8"]) {
    const env = { LANG: locale, LC_ALL: locale };
    const result = await runCli(["list", packagePath, "--kind", "tokens", "--json"], env);
    assert.equal(result.code, 0, result.stdout);
    outputs.push(result.stdout);
  }
  assert.deepEqual(
    JSON.parse(outputs[0]).items.map(({ item }) => item.id),
    ["tok_aa", "tok_ab", "tok_b"],
  );
  assert.equal(outputs[1], outputs[0]);
  assert.equal(outputs[2], outputs[0]);
});

test("missing, unreadable, and non-object inputs fail typed", async (context) => {
  const { packagePath, root } = await packageCopy(context);
  await failure(["import-media", packagePath, "--json"], "missing_media_file");
  await failure(
    ["import-font", packagePath, "--family", "Work", "--json"],
    "missing_font_file",
  );
  for (const [command, option] of [
    ["apply", "--batch"],
    ["flow", "--intent"],
    ["token", "--intent"],
    ["import-tokens", "--input"],
    ["render-matrix", "--contexts"],
    ["import-media", "--file"],
  ]) {
    const error = await failure(
      [command, packagePath, option, join(root, "absent.json"), "--json"],
      "unreadable_input_file",
    );
    assert.equal(error.details.option, option);
    assert.equal(error.details.reason, "ENOENT");
  }
  const nullBatch = join(root, "null.json");
  await writeFile(nullBatch, "null");
  await failure(["apply", packagePath, "--batch", nullBatch, "--json"], "invalid_batch");
  await failure(
    ["init", join(root, "workspace"), "--answers", nullBatch, "--json"],
    "invalid_initialization_answers_json",
  );
});

test("media writes return an inverse batch that apply can execute", async (context) => {
  const { packagePath, root } = await packageCopy(context);
  const imported = await json([
    "import-media", packagePath, "--file", jpegPath, "--media-id", "media_q", "--json",
  ]);
  assert.equal(imported.inverseBatch.baseRevision, imported.revision);
  const duplicate = await failure(
    ["import-media", packagePath, "--file", jpegPath, "--media-id", "media_q", "--json"],
    "duplicate_media_id",
  );
  assert.deepEqual(duplicate.details.descriptor, imported.descriptor);

  const removed = await json(["remove-media", packagePath, "--media-id", "media_q", "--json"]);
  assert.equal(removed.inverseBatch.baseRevision, removed.revision);
  const undoPath = join(root, "undo.json");
  await writeFile(undoPath, JSON.stringify(removed.inverseBatch));
  const restored = await json(["apply", packagePath, "--batch", undoPath, "--json"]);
  assert.equal(restored.revision, imported.revision);
});

test("search-components insertion advice is deterministic", async () => {
  const product = join(here, "fixtures", "design-system.smallpen");
  const args = ["search-components", product, "--query", "a", "--json"];
  const first = await runCli(args);
  assert.equal(first.code, 0, first.stdout);
  assert.match(first.stdout, /node_instance_[0-9a-f]{8}/);
  assert.equal((await runCli(args)).stdout, first.stdout);
});

test("a single-value option given twice is rejected, repeatable ones are not", async (context) => {
  const { packagePath } = await packageCopy(context);
  const error = await failure(
    ["list", packagePath, "--kind", "tokens", "--kind", "screens", "--json"],
    "duplicate_option",
  );
  assert.equal(error.details.option, "--kind");
  const result = await runCli([
    "compare", packagePath, "--selector", "{}", "--selector", "{}", "--json",
  ]);
  assert.doesNotMatch(result.stdout, /duplicate_option/);
});

test("watch rejects --max-events 0 instead of emitting an event", async (context) => {
  const { packagePath } = await packageCopy(context);
  await failure(["watch", packagePath, "--max-events", "0", "--json"], "invalid_integer_option");
});

test("every option in a command's usage is accepted and help matches replay", async (context) => {
  // Output options take the value "v" as a relative path, so probe from a
  // scratch directory instead of writing into the repository.
  const cwd = await mkdtemp(join(tmpdir(), "smallpen-cli-options-"));
  context.after(() => rm(cwd, { force: true, recursive: true }));
  const unaccepted = await Promise.all(COMMAND_NAMES.map(async (command) => {
    const help = (await runCli([command, "--help"])).stdout;
    const usage = help.split("Usage:")[1].split(/\n\s*\n/)[0];
    const rejected = [];
    for (const [optionName] of usage.matchAll(/--[a-z][a-z0-9-]*/g)) {
      if (optionName === "--version" || optionName === "--help") continue;
      const result = await runCli([command, "/nonexistent/x.smallpen", optionName, "v"], {}, cwd);
      if (/"unknown_option"/.test(result.stdout)) rejected.push(`${command} ${optionName}`);
    }
    return rejected;
  }));
  assert.deepEqual(unaccepted.flat(), []);

  for (const command of ["apply", "flow", "page", "token"]) {
    const usage = (await runCli([command, "--help"])).stdout.split("Purpose:")[0];
    assert.match(usage, /--explain/, command);
    assert.match(usage, /--diff/, command);
  }
  const apply = (await runCli(["apply", "--help"])).stdout;
  assert.doesNotMatch(apply, /do not provide cross-process deduplication/);
  assert.match(apply, /alreadyApplied/);
  for (const [command, optionName] of [
    ["import-font", "--media-path"],
    ["library-refresh", "--interval"],
    ["library-refresh", "--max-events"],
  ]) {
    await failure([command, "/nonexistent/x.smallpen", optionName, "v"], "unknown_option");
  }
});
