import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  cp,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { commandContract } from "../apps/cli/bin/command-contract.mjs";
import {
  COMMAND_GROUPS,
  PUBLIC_COMMANDS,
  publicArgv,
} from "../apps/cli/bin/command-tree.mjs";
import { COMMAND_NAMES, commandGuidance } from "../apps/cli/bin/help.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "apps", "cli", "bin", "smallpen-check.cjs");
const fixture = join(here, "fixtures", "roundtrip.smallpen");
const jpegPath = join(here, "fixtures", "quadrant.jpg");

function runCli(args, env = {}, cwd = undefined) {
  // Schema and full-value checks opt into stdout; fixed-file transport is tested separately.
  if (
    (args[0] === "schema" || args.includes("--full")) &&
    !args.includes("--stdout")
  )
    args = [...args, "--stdout"];
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

test(
  "reads succeed on a read-only location and writes fail typed",
  {
    skip: !canDropWriteAccess,
  },
  async (context) => {
    const { packagePath, root } = await packageCopy(context);
    const { revision } = await json(["validate", packagePath, "--json"]);
    // No lock directory exists yet and none can be created.
    await rm(join(root, ".app.smallpen.write-lock"), {
      force: true,
      recursive: true,
    });
    await chmod(root, 0o555);

    for (const command of [
      ["validate"],
      ["project", "show"],
      ["view"],
      ["project", "list"],
    ]) {
      const result = await runCli([...command, packagePath, "--json"]);
      assert.equal(result.code, 0, `${command.join(" ")}: ${result.stdout}`);
    }
    const batchPath = join(
      tmpdir(),
      `smallpen-ro-${process.pid}-${Date.now()}.json`,
    );
    context.after(() => rm(batchPath, { force: true }));
    await writeFile(
      batchPath,
      JSON.stringify({
        baseRevision: revision,
        batchId: "batch_read_only",
        operations: [
          {
            node: {
              children: [],
              height: 20,
              id: "node_read_only",
              name: "Read only",
              type: "RECTANGLE",
              width: 20,
              x: 10,
              y: 10,
            },
            parentId: "node_canvas",
            presentationId: "pres_desktop",
            screenId: "scr_roundtrip",
            type: "add-presentation-node",
          },
        ],
      }),
    );
    const preview = await json([
      "advanced",
      "apply",
      packagePath,
      "--batch",
      batchPath,
      "--dry-run",
      "--json",
    ]);
    assert.equal(preview.dryRun, true);
    const error = await failure(
      ["advanced", "apply", packagePath, "--batch", batchPath, "--json"],
      "package_not_writable",
    );
    assert.equal(error.details.packagePath, await realpath(packagePath));
    assert.deepEqual(await readdir(root), ["app.smallpen"]);
  },
);

test("reading a mistyped package path creates nothing", async (context) => {
  const { root } = await packageCopy(context);
  await failure(
    ["project", "show", join(root, "typo", "nested", "app.smallpen"), "--json"],
    "invalid_package_path",
  );
  await failure(
    ["view", join(root, "missing.smallpen"), "--json"],
    "invalid_package_path",
  );
  assert.deepEqual(await readdir(root), ["app.smallpen"]);
});

test("list order and pages do not depend on the host locale", async (context) => {
  const { packagePath, root } = await packageCopy(context);
  const intentPath = join(root, "tokens.json");
  await writeFile(
    intentPath,
    JSON.stringify({
      tokens: ["b", "ab", "aa"].map((name) => ({
        name: `space.${name}`,
        type: "number",
        value: 16,
      })),
    }),
  );
  await json(["token", "set", packagePath, "--intent", intentPath, "--json"]);
  const outputs = [];
  for (const locale of ["en_US.UTF-8", "da_DK.UTF-8", "tr_TR.UTF-8"]) {
    const env = { LANG: locale, LC_ALL: locale };
    const result = await runCli(
      ["project", "list", packagePath, "--kind", "tokens", "--json"],
      env,
    );
    assert.equal(result.code, 0, result.stdout);
    outputs.push(result.stdout);
  }
  // List order is the stable code-unit order of identities, never a
  // locale collation.
  const items = JSON.parse(outputs[0]).items.map(({ item }) => item);
  assert.deepEqual(items.map(({ path }) => path).sort(), [
    "space.aa",
    "space.ab",
    "space.b",
  ]);
  const ids = items.map(({ id }) => id);
  assert.deepEqual(ids, [...ids].sort());
  assert.equal(outputs[1], outputs[0]);
  assert.equal(outputs[2], outputs[0]);
});

test("missing, unreadable, and non-object inputs fail typed", async (context) => {
  const { packagePath, root } = await packageCopy(context);
  await failure(["media", "import", packagePath, "--json"], "missing_media_file");
  await failure(
    ["font", "import", packagePath, "--family", "Work", "--json"],
    "missing_font_file",
  );
  for (const [command, option] of [
    [["advanced", "apply"], "--batch"],
    [["page", "draw"], "--intent"],
    [["token", "set"], "--intent"],
    [["component", "define"], "--intent"],
    [["token", "import"], "--input"],
    [["media", "import"], "--file"],
  ]) {
    const error = await failure(
      [...command, packagePath, option, join(root, "absent.json"), "--json"],
      "unreadable_input_file",
    );
    assert.equal(error.details.option, option);
    assert.equal(error.details.reason, "ENOENT");
  }
  const nullBatch = join(root, "null.json");
  await writeFile(nullBatch, "null");
  await failure(
    ["advanced", "apply", packagePath, "--batch", nullBatch, "--json"],
    "invalid_batch",
  );
  await failure(
    ["project", "init", join(root, "workspace"), "--answers", nullBatch, "--json"],
    "invalid_initialization_answers_json",
  );
});

test("media writes return an inverse batch that apply can execute", async (context) => {
  const { packagePath, root } = await packageCopy(context);
  const imported = await json([
    "media",
    "import",
    packagePath,
    "--file",
    jpegPath,
    "--name",
    "Logos/Quadrant",
    "--json",
  ]);
  const importedInverse = JSON.parse(
    await readFile(imported.inverseBatchPath, "utf8"),
  );
  assert.equal(importedInverse.baseRevision, imported.revision);

  const removed = await json([
    "media",
    "delete",
    packagePath,
    "--media",
    "Logos/Quadrant",
    "--json",
  ]);
  const removedInverse = JSON.parse(
    await readFile(removed.inverseBatchPath, "utf8"),
  );
  assert.equal(removedInverse.baseRevision, removed.revision);
  const undoPath = join(root, "undo.json");
  await writeFile(undoPath, JSON.stringify(removedInverse));
  const restored = await json([
    "advanced",
    "apply",
    packagePath,
    "--batch",
    undoPath,
    "--json",
  ]);
  assert.equal(restored.revision, imported.revision);
});

test("search-components insertion advice is deterministic", async () => {
  const product = join(here, "fixtures", "design-system.smallpen");
  const args = [
    "component",
    "search",
    product,
    "--query",
    "a",
    "--full",
    "--json",
  ];
  const first = await runCli(args);
  assert.equal(first.code, 0, first.stdout);
  assert.match(first.stdout, /"recommendedInsertion":\{"element":\{"use":"Card"/);
  assert.equal((await runCli(args)).stdout, first.stdout);
});

test("a single-value option given twice is rejected, repeatable ones are not", async (context) => {
  const { packagePath } = await packageCopy(context);
  const error = await failure(
    ["project", "list", packagePath, "--kind", "tokens", "--kind", "screens", "--json"],
    "duplicate_option",
  );
  assert.equal(error.details.option, "--kind");
  const result = await runCli([
    "theme",
    "list",
    packagePath,
    "--theme",
    "Theme/Default",
    "--theme",
    "Theme/Default",
    "--json",
  ]);
  assert.doesNotMatch(result.stdout, /duplicate_option/);
});

test("watch rejects --max-events 0 instead of emitting an event", async (context) => {
  const { packagePath } = await packageCopy(context);
  await failure(
    ["project", "watch", packagePath, "--max-events", "0", "--json"],
    "invalid_integer_option",
  );
});

test("every option in a command's usage is accepted and help matches replay", async (context) => {
  // Output options take the value "v" as a relative path, so probe from a
  // scratch directory instead of writing into the repository.
  const cwd = await mkdtemp(join(tmpdir(), "smallpen-cli-options-"));
  context.after(() => rm(cwd, { force: true, recursive: true }));
  // Probe every public route (group actions run their own contract) and
  // every shared command that is still callable without a group.
  const routes = Object.values(COMMAND_GROUPS).flatMap(({ actions }) =>
    Object.values(actions).map((route) => ({
      argv: route.name.split(" "),
      contract: route.name,
    })),
  );
  const shared = PUBLIC_COMMANDS.map(({ command }) => command).filter(
    (command) => !Object.hasOwn(COMMAND_GROUPS, command),
  );
  const flat = shared.map((command) => ({
    argv: [command],
    contract: command,
  }));
  // Every other engine name fails and names its grouped path.
  for (const command of COMMAND_NAMES.filter(
    (name) => !shared.includes(name) && name !== "resource-write",
  )) {
    const result = await runCli([command, "/nonexistent/x.smallpen", "--json"]);
    assert.equal(result.code, 1, `${command}: ${result.stdout}`);
    const { error } = JSON.parse(result.stdout);
    assert.equal(error.code, "unknown_command", command);
    const suggestion = publicArgv([command]);
    if (suggestion[0] !== command)
      assert.equal(error.details.suggestion, suggestion.join(" "), command);
  }
  const unaccepted = await Promise.all(
    [...routes, ...flat].map(async ({ argv, contract }) => {
      const usage = Object.values(commandContract(contract).parameters)
        .map(({ option }) => option)
        .join(" ");
      const rejected = [];
      for (const [optionName] of usage.matchAll(/--[a-z][a-z0-9-]*/g)) {
        if (optionName === "--version" || optionName === "--help") continue;
        const result = await runCli(
          [...argv, "/nonexistent/x.smallpen", optionName, "v"],
          {},
          cwd,
        );
        if (/"unknown_(option|command|action)"/.test(result.stdout))
          rejected.push(`${argv.join(" ")} ${optionName}`);
      }
      return rejected;
    }),
  );
  assert.deepEqual(unaccepted.flat(), []);

  // Every previewable write documents --explain and --diff in its usage.
  assert.match(commandGuidance("apply").split("Purpose:")[0], /--explain/);
  assert.match(commandGuidance("apply").split("Purpose:")[0], /--diff/);
  const writes = routes.filter(({ contract }) =>
    Object.values(commandContract(contract).parameters).some(
      ({ option }) => option === "--confirm-unmatched",
    ),
  );
  assert.ok(writes.length > 10, "write routes found");
  for (const { argv } of writes) {
    const usage = (await runCli(["help", ...argv])).stdout;
    assert.match(usage, /--explain/, argv.join(" "));
    assert.match(usage, /--diff/, argv.join(" "));
  }
  const apply = (await runCli(["advanced", "apply", "--help", "--full"])).stdout;
  assert.doesNotMatch(apply, /do not provide cross-process deduplication/);
  assert.match(apply, /alreadyApplied/);
  for (const [group, action, optionName] of [
    ["font", "import", "--media-path"],
    ["advanced", "library-refresh", "--interval"],
    ["advanced", "library-refresh", "--max-events"],
  ]) {
    await failure(
      [group, action, "/nonexistent/x.smallpen", optionName, "v"],
      "unknown_option",
    );
  }
});
