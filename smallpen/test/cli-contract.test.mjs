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
import { seedLegacyIds } from "./helpers/named.mjs";

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
  await seedLegacyIds(packagePath, "roundtrip");
  return { packagePath, root };
}

const canDropWriteAccess =
  process.platform !== "win32" && process.getuid?.() !== 0;

test(
  "reads and check succeed on a read-only location",
  {
    skip: !canDropWriteAccess,
  },
  async (context) => {
    const { packagePath, root } = await packageCopy(context);
    await json(["check", packagePath, "--render", "--json"]);
    // No lock directory exists yet and none can be created.
    await rm(join(root, ".app.smallpen.write-lock"), {
      force: true,
      recursive: true,
    });
    await chmod(root, 0o555);

    for (const [command, ...rest] of [
      ["check"],
      ["check", "--render"],
      ["view"],
      ["token list"],
    ]) {
      const result = await runCli([...command.split(" "), packagePath, ...rest, "--json"]);
      assert.equal(result.code, 0, `${command}: ${result.stdout}`);
    }
    assert.deepEqual(await readdir(root), ["app.smallpen"]);
  },
);

test("reading a mistyped package path creates nothing", async (context) => {
  const { root } = await packageCopy(context);
  await failure(
    ["check", join(root, "typo", "nested", "app.smallpen"), "--json"],
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
  await writeFile(
    join(packagePath, "tokens.css"),
    `:root {\n${["b", "ab", "aa"].map((name) => `  --spacing-${name}: 16px;`).join("\n")}\n}\n`,
  );
  const outputs = [];
  for (const locale of ["en_US.UTF-8", "da_DK.UTF-8", "tr_TR.UTF-8"]) {
    const env = { LANG: locale, LC_ALL: locale };
    const result = await runCli(
      ["token", "list", packagePath, "--json"],
      env,
    );
    assert.equal(result.code, 0, result.stdout);
    outputs.push(result.stdout);
  }
  // List order is the stable code-unit order of identities, never a
  // locale collation.
  const paths = JSON.parse(outputs[0]).items.map(({ token }) => token.path);
  assert.deepEqual(paths, ["spacing-aa", "spacing-ab", "spacing-b"]);
  assert.equal(outputs[1], outputs[0]);
  assert.equal(outputs[2], outputs[0]);
});


test("a single-value option given twice is rejected, repeatable ones are not", async (context) => {
  const { packagePath } = await packageCopy(context);
  const error = await failure(
    ["view", packagePath, "--as", "text", "--as", "png", "--json"],
    "duplicate_option",
  );
  assert.equal(error.details.option, "--as");
  const result = await runCli([
    "token", "list",
    packagePath,
    "--theme",
    "Theme/Default",
    "--theme",
    "Theme/Default",
    "--json",
  ]);
  assert.doesNotMatch(result.stdout, /duplicate_option/);
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

  // No public route writes: the package changes by editing its files.
  const writes = routes.filter(({ contract }) =>
    Object.values(commandContract(contract).parameters).some(
      ({ option }) => option === "--confirm-unmatched" || option === "--intent" || option === "--batch",
    ),
  );
  assert.deepEqual(writes.map(({ argv }) => argv.join(" ")), []);
});
